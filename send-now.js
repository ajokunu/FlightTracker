import axios from 'axios';
import { initDb, getDb } from './src/db.js';
import { DISCORD_WEBHOOK_URL, FLIGHT_LEGS, TRIPS } from './src/config.js';
import { fetchAllLegs } from './src/fetcher.js';
import { logger } from './src/logger.js';

initDb();
const db = getDb();

function multiCityUrl(legs) {
  const segments = legs.map(l => `${l.origin}.${l.dest}.${l.date}`).join('*');
  return `https://www.google.com/flights#flt=${segments};c:USD;e:1;t:m`;
}

function getBestForLeg(legId) {
  const cfg = FLIGHT_LEGS.find(f => f.id === legId);
  if (!cfg) return null;
  const stopsFilter = cfg.nonstopOnly ? 'AND stops = 0' : '';
  const excludeFilter = cfg.budgetAirlines?.length
    ? cfg.budgetAirlines.map(a => `AND airline NOT LIKE '%${a}%'`).join(' ')
    : '';
  return db.prepare(`
    SELECT leg_id, origin, destination, price, airline, stops, duration_minutes, departure_time, arrival_time
    FROM price_snapshots
    WHERE leg_id = ? ${stopsFilter} ${excludeFilter}
    ORDER BY timestamp DESC, price ASC
    LIMIT 1
  `).get(legId);
}

function getBestBudgetForLeg(legId) {
  const cfg = FLIGHT_LEGS.find(f => f.id === legId);
  if (!cfg || !cfg.budgetAirlines?.length) return null;
  const stopsFilter = cfg.nonstopOnly ? 'AND stops = 0' : '';
  const includeFilter = cfg.budgetAirlines.map(a => `airline LIKE '%${a}%'`).join(' OR ');
  return db.prepare(`
    SELECT leg_id, origin, destination, price, airline, stops, duration_minutes, departure_time, arrival_time
    FROM price_snapshots
    WHERE leg_id = ? ${stopsFilter} AND (${includeFilter})
    ORDER BY timestamp DESC, price ASC
    LIMIT 1
  `).get(legId);
}

function buildFlightField(row, cfg) {
  const h = Math.floor((row.duration_minutes || 0) / 60);
  const m = (row.duration_minutes || 0) % 60;
  const stopLabel = row.stops === 0 ? 'Nonstop' : `${row.stops} stop`;
  const timeInfo = row.departure_time && row.arrival_time ? ` · ${row.departure_time} → ${row.arrival_time}` : '';
  return {
    name: `${cfg.emoji} ${cfg.label} — ${cfg.date}`,
    value: [
      `**$${(row.price / 100).toFixed(2)}** — ${row.airline || 'Unknown'}`,
      `${stopLabel}` +
        (row.duration_minutes ? ` · ${h}h ${m}m` : '') +
        timeInfo,
    ].join('\n'),
    inline: false,
  };
}

// Fresh poll
logger.info('Running fresh poll...');
await fetchAllLegs();

// Build embeds per trip
const embeds = [];

for (const [tripId, trip] of Object.entries(TRIPS)) {
  const tripLegs = FLIGHT_LEGS.filter(l => l.trip === tripId);
  const hasBudgetSection = tripLegs.some(l => l.budgetAirlines?.length);
  const results = [];
  const budgetResults = [];

  for (const cfg of tripLegs) {
    const row = getBestForLeg(cfg.id);
    if (row) {
      results.push({ ...row, cfg });
      const stopLabel = row.stops === 0 ? 'Nonstop' : `${row.stops} stop`;
      console.log(`[${tripId}] ${cfg.label}: ${stopLabel} ${row.airline} $${(row.price / 100).toFixed(2)}`);
    } else {
      console.log(`[${tripId}] ${cfg.label}: No flights found`);
      results.push(null);
    }

    if (hasBudgetSection) {
      const budgetRow = getBestBudgetForLeg(cfg.id);
      if (budgetRow) {
        budgetResults.push({ ...budgetRow, cfg });
        console.log(`[${tripId}] ${cfg.label} (budget): ${budgetRow.airline} $${(budgetRow.price / 100).toFixed(2)}`);
      }
    }
  }

  const fields = [];

  if (hasBudgetSection) {
    fields.push({ name: '\u200b', value: '**✨ Classy Plane Options**', inline: false });
  }

  for (const r of results) {
    if (!r) continue;
    fields.push(buildFlightField(r, r.cfg));
  }

  if (hasBudgetSection && budgetResults.length) {
    fields.push({ name: '\u200b', value: '**💸 Peasant Plane Options**', inline: false });
    for (const r of budgetResults) {
      fields.push(buildFlightField(r, r.cfg));
    }
  }

  const validPrices = results.filter(r => r);
  // SerpAPI prices with adults=N already include all passengers
  const total = validPrices.reduce((s, r) => s + r.price, 0);
  const perPerson = Math.round(total / trip.passengers);

  // Build booking URL
  const bookingLegs = validPrices.map(r => ({ origin: r.origin, dest: r.destination, date: r.cfg.date }));
  const bookUrl = multiCityUrl(bookingLegs);

  const description = trip.passengers > 1
    ? [
        `**$${(total / 100).toFixed(2)} total** (${trip.passengers} passengers · $${(perPerson / 100).toFixed(2)}/person round trip)`,
        '',
        `[📋 Book on Google Flights](${bookUrl})`,
      ].join('\n')
    : [
        `**Total: $${(total / 100).toFixed(2)}**`,
        '',
        `[📋 Book entire trip on Google Flights](${bookUrl})`,
      ].join('\n');

  const colors = { nz: 0x3498DB, disney: 0xE74C3C };
  const titles = {
    nz: '✈️ New Zealand Trip Update',
    disney: '🏰 Disney World Trip Update',
  };

  embeds.push({
    title: titles[tripId] || `✈️ ${trip.label}`,
    color: colors[tripId] || 0x3498DB,
    description,
    fields,
    footer: { text: trip.subtitle },
    timestamp: new Date().toISOString(),
  });
}

const payload = { embeds };

await axios.post(DISCORD_WEBHOOK_URL, payload, { timeout: 10000 });
console.log('\nSent to Discord!');
process.exit(0);
