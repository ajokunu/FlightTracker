import axios from 'axios';
import { initDb, getDb } from './src/db.js';
import { DISCORD_WEBHOOK_URL, FLIGHT_LEGS } from './src/config.js';
import { fetchAllLegs } from './src/fetcher.js';
import { logger } from './src/logger.js';

initDb();
const db = getDb();

function multiCityUrl(results) {
  const segments = results
    .filter(r => r)
    .map(r => `${r.origin}.${r.destination}.${r.cfg.date}`)
    .join('*');
  return `https://www.google.com/flights#flt=${segments};c:USD;e:1;t:m`;
}

// Fresh poll
logger.info('Running fresh poll...');
await fetchAllLegs();

// Pull best prices per leg in route order
const results = [];
for (const cfg of FLIGHT_LEGS) {
  const stopsFilter = cfg.nonstopOnly ? 'AND stops = 0' : '';
  const row = db.prepare(`
    SELECT leg_id, origin, destination, price, airline, stops, duration_minutes, departure_time, arrival_time
    FROM price_snapshots
    WHERE leg_id = ? ${stopsFilter}
    ORDER BY timestamp DESC, price ASC
    LIMIT 1
  `).get(cfg.id);

  if (row) {
    results.push({ ...row, cfg });
    const stopLabel = row.stops === 0 ? 'Nonstop' : `${row.stops} stop`;
    console.log(`${cfg.label}: ${stopLabel} ${row.airline} $${(row.price / 100).toFixed(2)}`);
  } else {
    console.log(`${cfg.label}: No flights found`);
    results.push(null);
  }
}

// Build fields in route order
const fields = [];
for (const r of results) {
  if (!r) continue;
  const h = Math.floor((r.duration_minutes || 0) / 60);
  const m = (r.duration_minutes || 0) % 60;
  const stopLabel = r.stops === 0 ? 'Nonstop' : `${r.stops} stop`;
  fields.push({
    name: `${r.cfg.emoji} ${r.cfg.label} — ${r.cfg.date}`,
    value: [
      `**$${(r.price / 100).toFixed(2)}** — ${r.airline || 'Unknown'}`,
      `${stopLabel}` +
        (r.duration_minutes ? ` · ${h}h ${m}m` : '') +
        (r.departure_time && r.arrival_time ? ` · ${r.departure_time} → ${r.arrival_time}` : ''),
    ].join('\n'),
    inline: false,
  });
}

const validPrices = results.filter(r => r);
const total = validPrices.reduce((s, r) => s + r.price, 0);
const bookAllUrl = multiCityUrl(results);

const payload = {
  embeds: [{
    title: '✈️ Trip Price Update',
    color: 0x3498DB,
    description: [
      `**Total: $${(total / 100).toFixed(2)}**`,
      '',
      `[📋 Book entire trip on Google Flights](${bookAllUrl})`,
    ].join('\n'),
    fields,
    footer: { text: 'NYC → Auckland → Wellington → Sydney → Melbourne → Boston | May 2026' },
    timestamp: new Date().toISOString(),
  }],
};

await axios.post(DISCORD_WEBHOOK_URL, payload, { timeout: 10000 });
console.log(`\nSent to Discord! Total: $${(total / 100).toFixed(2)}`);
process.exit(0);
