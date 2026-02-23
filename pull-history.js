import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SERPAPI_KEY, FLIGHT_LEGS } from './src/config.js';
import { logger } from './src/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERPAPI_URL = 'https://serpapi.com/search';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const allHistory = {};

for (const leg of FLIGHT_LEGS) {
  const origin = leg.origins[0];
  const params = {
    engine: 'google_flights',
    api_key: SERPAPI_KEY,
    departure_id: origin,
    arrival_id: leg.destination,
    outbound_date: leg.date,
    type: 2,
    currency: 'USD',
    adults: 1,
    stops: 0,
    hl: 'en',
  };

  try {
    logger.info(`Fetching price history for ${origin}→${leg.destination}`);
    const { data } = await axios.get(SERPAPI_URL, { params, timeout: 30000 });
    const insights = data.price_insights || {};

    console.log(`\n=== ${leg.label} (${origin}→${leg.destination}) ===`);
    console.log(`  Lowest price: $${insights.lowest_price || 'N/A'}`);
    console.log(`  Price level: ${insights.price_level || 'N/A'}`);
    console.log(`  Typical range: $${insights.typical_price_range?.[0] || '?'} – $${insights.typical_price_range?.[1] || '?'}`);

    const history = insights.price_history || [];
    console.log(`  History data points: ${history.length}`);

    if (history.length > 0) {
      const firstDate = new Date(history[0][0] * 1000).toISOString().split('T')[0];
      const lastDate = new Date(history[history.length - 1][0] * 1000).toISOString().split('T')[0];
      console.log(`  Date range: ${firstDate} → ${lastDate}`);

      // Filter out zero/null prices
      const valid = history.filter(h => h[1] > 0);
      if (valid.length > 0) {
        const prices = valid.map(h => h[1]);
        console.log(`  Valid points: ${valid.length}, Min: $${Math.min(...prices)}, Max: $${Math.max(...prices)}`);
      }
    }

    allHistory[leg.id] = {
      label: leg.label,
      origin,
      destination: leg.destination,
      date: leg.date,
      lowest_price: insights.lowest_price,
      typical_range: insights.typical_price_range,
      price_level: insights.price_level,
      history: insights.price_history || [],
    };
  } catch (err) {
    console.error(`Failed for ${leg.label}: ${err.message}`);
    allHistory[leg.id] = { label: leg.label, history: [], error: err.message };
  }

  await sleep(2000);
}

// Save raw data
const outPath = path.join(__dirname, 'data', 'price-history-raw.json');
fs.writeFileSync(outPath, JSON.stringify(allHistory, null, 2));
console.log(`\nRaw history saved to ${outPath}`);

// Generate HTML chart
const datasets = [];
const colors = ['#38bdf8', '#34d399', '#a78bfa', '#fb923c'];
let i = 0;
for (const [legId, info] of Object.entries(allHistory)) {
  const valid = (info.history || []).filter(h => h[1] > 0);
  if (!valid.length) { i++; continue; }
  datasets.push({
    label: info.label,
    data: valid.map(h => ({ x: h[0] * 1000, y: h[1] })),
    borderColor: colors[i],
    backgroundColor: colors[i] + '20',
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.3,
  });
  i++;
}

const chartHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Flight Price History — Google Flights ~60 Day Trend</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3"></script>
  <style>
    body { background: #0f172a; color: #e2e8f0; font-family: system-ui, sans-serif; padding: 20px; }
    h1 { text-align: center; margin-bottom: 4px; }
    .sub { text-align: center; color: #94a3b8; margin-bottom: 20px; }
    .chart-wrap { background: #1e293b; border-radius: 12px; padding: 20px; max-width: 1000px; margin: 0 auto; }
    canvas { max-height: 500px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; max-width: 1000px; margin: 20px auto; }
    .stat { background: #1e293b; border-radius: 8px; padding: 16px; }
    .stat h3 { font-size: 0.9rem; color: #94a3b8; margin-bottom: 8px; }
    .stat .price { font-size: 1.4rem; font-weight: 700; color: #34d399; }
    .stat .detail { color: #64748b; font-size: 0.8rem; margin-top: 4px; }
  </style>
</head>
<body>
  <h1>Flight Price History</h1>
  <p class="sub">Google Flights ~60 Day Price Trend — Nonstop Flights | May 2026 Departures</p>
  <div class="stats" id="stats"></div>
  <div class="chart-wrap"><canvas id="chart"></canvas></div>
  <script>
    const datasets = ${JSON.stringify(datasets)};
    const historyData = ${JSON.stringify(
      Object.entries(allHistory).map(([id, info]) => ({
        id, label: info.label, lowest: info.lowest_price,
        range: info.typical_range, level: info.price_level,
        points: (info.history || []).filter(h => h[1] > 0).length,
      }))
    )};

    // Stats cards
    const statsEl = document.getElementById('stats');
    statsEl.innerHTML = historyData.map(h =>
      '<div class="stat">' +
        '<h3>' + h.label + '</h3>' +
        '<div class="price">' + (h.lowest ? '$' + h.lowest : 'N/A') + '</div>' +
        '<div class="detail">' +
          (h.range ? 'Typical: $' + h.range[0] + ' – $' + h.range[1] : '') +
          (h.level ? ' (' + h.level + ')' : '') +
          '<br>' + h.points + ' data points' +
        '</div>' +
      '</div>'
    ).join('');

    // Chart
    if (datasets.length) {
      new Chart(document.getElementById('chart'), {
        type: 'line',
        data: { datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: {
              type: 'time',
              time: { unit: 'week', tooltipFormat: 'MMM d, yyyy' },
              grid: { color: '#334155' },
              ticks: { color: '#94a3b8' },
            },
            y: {
              title: { display: true, text: 'Price (USD)', color: '#94a3b8' },
              grid: { color: '#334155' },
              ticks: { color: '#94a3b8', callback: v => '$' + v },
            },
          },
          plugins: {
            legend: { labels: { color: '#e2e8f0' } },
            tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': $' + ctx.parsed.y } },
          },
        },
      });
    }
  </script>
</body>
</html>`;

const chartPath = path.join(__dirname, 'public', 'history.html');
fs.writeFileSync(chartPath, chartHtml);
console.log(`Chart saved to ${chartPath}`);
console.log(`View at: http://localhost:3737/history.html`);
