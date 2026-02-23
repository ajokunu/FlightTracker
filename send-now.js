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
  const excludeFilter = cfg.excludeAirlines?.length
    ? cfg.excludeAirlines.map(a => `AND airline NOT LIKE '%${a}%'`).join(' ')
    : '';
  return db.prepare(`
    SELECT leg_id, origin, destination, price, airline, stops, duration_minutes, departure_time, arrival_time
    FROM price_snapshots
    WHERE leg_id = ? ${stopsFilter} ${excludeFilter}
    ORDER BY timestamp DESC, price ASC
    LIMIT 1
  `).get(legId);
}

// Fresh poll
logger.info('Running fresh poll...');
await fetchAllLegs();

// Build embeds per trip
const embeds = [];

for (const [tripId, trip] of Object.entries(TRIPS)) {
  const tripLegs = FLIGHT_LEGS.filter(l => l.trip === tripId);
  const results = [];

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
  }

  const fields = [];
  for (const r of results) {
    if (!r) continue;
    const h = Math.floor((r.duration_minutes || 0) / 60);
    const m = (r.duration_minutes || 0) % 60;
    const stopLabel = r.stops === 0 ? 'Nonstop' : `${r.stops} stop`;
    const timeInfo = r.departure_time && r.arrival_time ? ` · ${r.departure_time} → ${r.arrival_time}` : '';
    fields.push({
      name: `${r.cfg.emoji} ${r.cfg.label} — ${r.cfg.date}`,
      value: [
        `**$${(r.price / 100).toFixed(2)}** — ${r.airline || 'Unknown'}`,
        `${stopLabel}` +
          (r.duration_minutes ? ` · ${h}h ${m}m` : '') +
          timeInfo,
      ].join('\n'),
      inline: false,
    });
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
