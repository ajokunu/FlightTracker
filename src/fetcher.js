import { SERPAPI_KEY, AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET, RAPIDAPI_KEY,
         FLIGHT_LEGS, RETRY, getNextNycAirport } from './config.js';
import { insertSnapshot } from './db.js';
import { logger } from './logger.js';

import * as serpapi from './adapters/serpapi.js';
import * as amadeus from './adapters/amadeus.js';
import * as skyscanner from './adapters/skyscanner.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getAdapterChain() {
  const chain = [];
  if (SERPAPI_KEY) chain.push(serpapi);
  if (AMADEUS_CLIENT_ID && AMADEUS_CLIENT_SECRET) chain.push(amadeus);
  if (RAPIDAPI_KEY) chain.push(skyscanner);
  return chain;
}

let consecutiveFailures = 0;

async function fetchLeg(leg, originOverride) {
  const origin = originOverride || leg.origins[0];
  const adapters = getAdapterChain();

  if (!adapters.length) {
    logger.error('No flight API keys configured');
    return { leg, origin, snapshots: [], insights: {}, cheapest: null, cheapestBudget: null, error: 'No API keys configured' };
  }

  const options = {
    passengers: leg.passengers || 1,
    nonstopOnly: leg.nonstopOnly || false,
  };

  let lastError = null;

  for (const adapter of adapters) {
    try {
      const { flights, insights } = await adapter.fetchFlights(origin, leg.destination, leg.date, options);

      consecutiveFailures = 0;

      const now = Math.floor(Date.now() / 1000);
      const snapshots = [];

      for (const parsed of flights) {
        // Tag budget airlines
        let isBudget = false;
        if (leg.budgetAirlines?.length && parsed.airline) {
          isBudget = leg.budgetAirlines.some(ba =>
            parsed.airline.toLowerCase().includes(ba.toLowerCase())
          );
        }

        // Filter by preferred departure time
        if (leg.preferDepartureTime && parsed.departure_time) {
          const timeMatch = parsed.departure_time.match(/(\d{1,2}):(\d{2})/);
          if (timeMatch) {
            const hour = parseInt(timeMatch[1], 10);
            if (leg.preferDepartureTime === 'morning' && hour >= 12) continue;
            if (leg.preferDepartureTime === 'evening' && hour < 15) continue;
          }
        }

        const snapshot = {
          leg_id: leg.id,
          origin,
          destination: leg.destination,
          timestamp: now,
          ...parsed,
          lowest_price: insights.lowest_price ? Math.round(insights.lowest_price * 100) : null,
          typical_price_low: insights.typical_price_range?.[0] ? Math.round(insights.typical_price_range[0] * 100) : null,
          typical_price_high: insights.typical_price_range?.[1] ? Math.round(insights.typical_price_range[1] * 100) : null,
          price_level: insights.price_level || null,
          data_source: adapter.SOURCE_NAME,
        };

        insertSnapshot(snapshot);
        snapshots.push({ ...snapshot, isBudget });
      }

      const classySnapshots = snapshots.filter(s => !s.isBudget);
      const budgetSnapshots = snapshots.filter(s => s.isBudget);

      logger.info(`${origin}→${leg.destination}: ${snapshots.length} flights via ${adapter.SOURCE_NAME} (${classySnapshots.length} classy, ${budgetSnapshots.length} budget), cheapest $${classySnapshots.length ? (Math.min(...classySnapshots.map(s => s.price)) / 100).toFixed(2) : 'N/A'}`);

      return {
        leg,
        origin,
        snapshots,
        insights,
        cheapest: classySnapshots.length ? classySnapshots.reduce((a, b) => a.price < b.price ? a : b) : null,
        cheapestBudget: budgetSnapshots.length ? budgetSnapshots.reduce((a, b) => a.price < b.price ? a : b) : null,
      };
    } catch (err) {
      lastError = err;
      logger.warn(`[${adapter.SOURCE_NAME}] Failed for ${origin}→${leg.destination}: ${err.message}`);
      if (adapter !== adapters[adapters.length - 1]) {
        logger.info('Falling back to next adapter...');
      }
    }
  }

  // All adapters failed
  consecutiveFailures++;
  logger.error(`All adapters failed for ${origin}→${leg.destination}: ${lastError?.message}`);

  if (consecutiveFailures >= RETRY.maxConsecutiveFailures) {
    logger.error(`${consecutiveFailures} consecutive failures — pausing ${RETRY.consecutiveFailurePauseMs / 1000}s`);
    await sleep(RETRY.consecutiveFailurePauseMs);
    consecutiveFailures = 0;
  }

  return { leg, origin, snapshots: [], insights: {}, cheapest: null, cheapestBudget: null, error: lastError?.message || 'All adapters failed' };
}

export async function fetchAllLegs() {
  const results = [];

  for (const leg of FLIGHT_LEGS) {
    try {
      let origin;
      if (leg.id === 'nyc-akl') {
        origin = getNextNycAirport();
      }
      const result = await fetchLeg(leg, origin);
      results.push(result);
    } catch (err) {
      logger.error(`Unexpected error fetching leg ${leg.id}: ${err.message}`);
      results.push({ leg, origin: null, snapshots: [], insights: {}, cheapest: null, cheapestBudget: null, error: err.message });
    }

    // Stagger between legs
    if (leg !== FLIGHT_LEGS[FLIGHT_LEGS.length - 1]) {
      await sleep(RETRY.staggerDelayMs);
    }
  }

  return results;
}
