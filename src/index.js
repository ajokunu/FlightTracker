import { SERPAPI_KEY, AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET, RAPIDAPI_KEY,
         DISCORD_WEBHOOK_URL, GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_TO,
         FLIGHT_LEGS, DASHBOARD_PORT } from './config.js';
import { initDb } from './db.js';
import { startScheduler } from './scheduler.js';
import { startDashboard } from './dashboard.js';
import { logger } from './logger.js';

function validateEnv() {
  const hasAnyApi = SERPAPI_KEY || (AMADEUS_CLIENT_ID && AMADEUS_CLIENT_SECRET) || RAPIDAPI_KEY;
  if (!hasAnyApi) {
    logger.error('No flight API keys configured — set at least one of: SERPAPI_KEY, AMADEUS_CLIENT_ID+SECRET, RAPIDAPI_KEY');
    process.exit(1);
  }
  if (!SERPAPI_KEY) logger.warn('SERPAPI_KEY not set — SerpAPI will be skipped');
  if (!AMADEUS_CLIENT_ID || !AMADEUS_CLIENT_SECRET) logger.warn('Amadeus credentials not set — Amadeus fallback unavailable');
  if (!RAPIDAPI_KEY) logger.warn('RAPIDAPI_KEY not set — Skyscanner fallback unavailable');
  if (!DISCORD_WEBHOOK_URL) logger.warn('DISCORD_WEBHOOK_URL not set — Discord alerts will be skipped');
  if (GMAIL_USER && GMAIL_APP_PASSWORD && EMAIL_TO) {
    logger.info(`Email alerts enabled → ${EMAIL_TO}`);
  } else {
    logger.warn('Email not configured — set GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_TO in .env');
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
