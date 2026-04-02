import cron from 'node-cron';
import { POLL_INTERVAL_MINUTES, FLIGHT_LEGS, DATA_RETENTION_DAYS } from './config.js';
import { fetchAllLegs } from './fetcher.js';
import { evaluateAlerts, sendDailySummary } from './alerts.js';
import { pruneOldSnapshots } from './db.js';
import { logger } from './logger.js';

async function pollCycle() {
  const start = Date.now();
  logger.info('--- Poll cycle starting ---');

  try {
    const results = await fetchAllLegs();

    const successCount = results.filter(r => r.cheapest).length;
    const failCount = results.filter(r => r.error).length;
    logger.info(`Poll complete: ${successCount}/${FLIGHT_LEGS.length} legs fetched, ${failCount} errors`);

    await evaluateAlerts(results);
  } catch (err) {
    logger.error('Poll cycle failed:', err.message);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info(`--- Poll cycle finished in ${elapsed}s ---`);
}

export function startScheduler() {
  // Poll every N minutes
  const cronExpr = `*/${POLL_INTERVAL_MINUTES} * * * *`;
  logger.info(`Scheduling price polls: ${cronExpr}`);
  cron.schedule(cronExpr, pollCycle);

  // Daily summary at 8 PM
  logger.info('Scheduling daily summary at 8:00 PM');
  cron.schedule('0 20 * * *', async () => {
    try {
      await sendDailySummary();
    } catch (err) {
      logger.error('Daily summary failed:', err.message);
    }
  });

  // Daily data prune at midnight
  logger.info(`Scheduling daily data prune (retain ${DATA_RETENTION_DAYS} days)`);
  cron.schedule('0 0 * * *', () => {
    try {
      const deleted = pruneOldSnapshots(DATA_RETENTION_DAYS);
      if (deleted > 0) logger.info(`Pruned ${deleted} snapshots older than ${DATA_RETENTION_DAYS} days`);
    } catch (err) {
      logger.error('Data prune failed:', err.message);
    }
  });

  // Immediate first poll
  logger.info('Running immediate first poll...');
  pollCycle();
}
