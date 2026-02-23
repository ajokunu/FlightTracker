import { SERPAPI_KEY, DISCORD_WEBHOOK_URL, FLIGHT_LEGS, DASHBOARD_PORT } from './config.js';
import { initDb } from './db.js';
import { startScheduler } from './scheduler.js';
import { startDashboard } from './dashboard.js';
import { logger } from './logger.js';

function validateEnv() {
  if (!SERPAPI_KEY) {
    logger.error('SERPAPI_KEY is required — set it in .env');
    process.exit(1);
  }
  if (!DISCORD_WEBHOOK_URL) {
    logger.warn('DISCORD_WEBHOOK_URL not set — Discord alerts will be skipped');
  }
}

function main() {
  logger.info('=== Flight Price Tracker starting ===');

  validateEnv();
  initDb();

  logger.info('Tracking flight legs:');
  for (const leg of FLIGHT_LEGS) {
    logger.info(`  ${leg.emoji} ${leg.label} (${leg.origins.join('/')}→${leg.destination}) on ${leg.date}`);
  }

  startDashboard(DASHBOARD_PORT);
  startScheduler();

  // Graceful shutdown
  const shutdown = (signal) => {
    logger.info(`Received ${signal} — shutting down`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
