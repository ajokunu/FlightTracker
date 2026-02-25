import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'flights.db');

let db;

export function initDb() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leg_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      price INTEGER NOT NULL,
      airline TEXT,
      stops INTEGER,
      duration_minutes INTEGER,
      departure_time TEXT,
      arrival_time TEXT,
      flight_numbers TEXT,
      booking_token TEXT,
      lowest_price INTEGER,
      typical_price_low INTEGER,
      typical_price_high INTEGER,
      price_level TEXT,
      raw_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_leg_ts ON price_snapshots(leg_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_snapshots_leg_price ON price_snapshots(leg_id, price);

    CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leg_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      price INTEGER,
      previous_price INTEGER,
      change_pct REAL,
      message TEXT,
      sent_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_leg_type ON price_alerts(leg_id, alert_type, sent_at);

    DROP VIEW IF EXISTS v_best_prices;
    CREATE VIEW v_best_prices AS
    SELECT
      leg_id,
      origin,
      destination,
      price,
      airline,
      stops,
      duration_minutes,
      departure_time,
      arrival_time,
      flight_numbers,
      lowest_price,
      typical_price_low,
      typical_price_high,
      price_level,
      aircraft_type,
      departure_airport_name,
      arrival_airport_name,
      timestamp
    FROM price_snapshots ps
    WHERE ps.timestamp = (
      SELECT MAX(ps2.timestamp) FROM price_snapshots ps2 WHERE ps2.leg_id = ps.leg_id
    )
    AND ps.price = (
      SELECT MIN(ps3.price) FROM price_snapshots ps3
      WHERE ps3.leg_id = ps.leg_id
      AND ps3.timestamp = ps.timestamp
    )
    GROUP BY leg_id;

    CREATE VIEW IF NOT EXISTS v_alltime_best AS
    SELECT
      leg_id,
      MIN(price) AS min_price,
      MAX(price) AS max_price,
      CAST(AVG(price) AS INTEGER) AS avg_price,
      COUNT(*) AS snapshot_count
    FROM price_snapshots
    GROUP BY leg_id;

    CREATE VIEW IF NOT EXISTS v_daily_trends AS
    SELECT
      leg_id,
      DATE(timestamp, 'unixepoch') AS day,
      MIN(price) AS min_price,
      MAX(price) AS max_price,
      CAST(AVG(price) AS INTEGER) AS avg_price,
      COUNT(*) AS samples
    FROM price_snapshots
    GROUP BY leg_id, DATE(timestamp, 'unixepoch');
  `);

  // ── Migrations: add new columns (idempotent) ──
  const migrations = [
    'ALTER TABLE price_snapshots ADD COLUMN aircraft_type TEXT',
    'ALTER TABLE price_snapshots ADD COLUMN departure_airport_name TEXT',
    'ALTER TABLE price_snapshots ADD COLUMN arrival_airport_name TEXT',
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
      logger.info(`Migration applied: ${sql}`);
    } catch (err) {
      // Column already exists — ignore
      if (!err.message.includes('duplicate column')) {
        logger.warn(`Migration skipped: ${err.message}`);
      }
    }
  }

  logger.info('Database initialized at', DB_PATH);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized — call initDb() first');
  return db;
}

export function insertSnapshot(snapshot) {
  const stmt = getDb().prepare(`
    INSERT INTO price_snapshots
      (leg_id, origin, destination, timestamp, price, airline, stops, duration_minutes,
       departure_time, arrival_time, flight_numbers, booking_token,
       lowest_price, typical_price_low, typical_price_high, price_level, raw_json,
       aircraft_type, departure_airport_name, arrival_airport_name)
    VALUES
      (@leg_id, @origin, @destination, @timestamp, @price, @airline, @stops, @duration_minutes,
       @departure_time, @arrival_time, @flight_numbers, @booking_token,
       @lowest_price, @typical_price_low, @typical_price_high, @price_level, @raw_json,
       @aircraft_type, @departure_airport_name, @arrival_airport_name)
  `);
  return stmt.run(snapshot);
}

export function getBestPrices() {
  return getDb().prepare('SELECT * FROM v_best_prices').all();
}

export function getAlltimeBest() {
  return getDb().prepare('SELECT * FROM v_alltime_best').all();
}

export function getPriceHistory(legId, since) {
  return getDb().prepare(`
    SELECT leg_id, origin, price, airline, stops, duration_minutes, timestamp,
           departure_time, arrival_time, price_level,
           aircraft_type, departure_airport_name, arrival_airport_name
    FROM price_snapshots
    WHERE leg_id = ? AND timestamp >= ?
    ORDER BY timestamp ASC
  `).all(legId, since);
}

export function getPreviousBestPrice(legId) {
  return getDb().prepare(`
    SELECT MIN(price) as price FROM price_snapshots
    WHERE leg_id = ? AND timestamp < (SELECT MAX(timestamp) FROM price_snapshots WHERE leg_id = ?)
  `).get(legId, legId);
}

export function getAlltimeMinPrice(legId) {
  return getDb().prepare(`
    SELECT MIN(price) as price FROM price_snapshots WHERE leg_id = ?
  `).get(legId);
}

export function insertAlert(alert) {
  const stmt = getDb().prepare(`
    INSERT INTO price_alerts (leg_id, alert_type, price, previous_price, change_pct, message, sent_at)
    VALUES (@leg_id, @alert_type, @price, @previous_price, @change_pct, @message, @sent_at)
  `);
  return stmt.run(alert);
}

export function getLastAlertTime(legId, alertType) {
  const row = getDb().prepare(`
    SELECT MAX(sent_at) as last_sent FROM price_alerts
    WHERE leg_id = ? AND alert_type = ?
  `).get(legId, alertType);
  return row?.last_sent || 0;
}

export function getTripSummary(activeLegIds) {
  let best = getBestPrices();
  let alltime = getAlltimeBest();
  // Filter to active legs only (excludes stale data from removed trips)
  if (activeLegIds?.length) {
    best = best.filter(b => activeLegIds.includes(b.leg_id));
    alltime = alltime.filter(a => activeLegIds.includes(a.leg_id));
  }
  const totalCurrent = best.reduce((sum, b) => sum + b.price, 0);
  const totalAlltime = alltime.reduce((sum, a) => sum + a.min_price, 0);
  return { best, alltime, totalCurrent, totalAlltime };
}

export function getBestForLegFiltered(legId, excludeAirlines) {
  const excludeFilter = excludeAirlines?.length
    ? excludeAirlines.map(a => `AND airline NOT LIKE '%${a}%'`).join(' ')
    : '';
  return getDb().prepare(`
    SELECT leg_id, origin, destination, price, airline, stops, duration_minutes,
           departure_time, arrival_time, timestamp,
           aircraft_type, departure_airport_name, arrival_airport_name
    FROM price_snapshots
    WHERE leg_id = ? ${excludeFilter}
    ORDER BY timestamp DESC, price ASC
    LIMIT 1
  `).get(legId);
}

export function getBestBudgetForLeg(legId, budgetAirlines) {
  if (!budgetAirlines?.length) return null;
  const includeFilter = budgetAirlines.map(a => `airline LIKE '%${a}%'`).join(' OR ');
  return getDb().prepare(`
    SELECT leg_id, origin, destination, price, airline, stops, duration_minutes,
           departure_time, arrival_time, timestamp,
           aircraft_type, departure_airport_name, arrival_airport_name
    FROM price_snapshots
    WHERE leg_id = ? AND (${includeFilter})
    ORDER BY timestamp DESC, price ASC
    LIMIT 1
  `).get(legId);
}

export function getRecentAlerts(limit = 20) {
  return getDb().prepare(`
    SELECT * FROM price_alerts ORDER BY sent_at DESC LIMIT ?
  `).all(limit);
}

export function getDailyTrends(legId) {
  return getDb().prepare(`
    SELECT * FROM v_daily_trends WHERE leg_id = ? ORDER BY day ASC
  `).all(legId);
}
