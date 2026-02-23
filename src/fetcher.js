import axios from 'axios';
import { SERPAPI_KEY, FLIGHT_LEGS, RETRY, getNextNycAirport } from './config.js';
import { insertSnapshot } from './db.js';
import { logger } from './logger.js';

const SERPAPI_URL = 'https://serpapi.com/search';

let consecutiveFailures = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseFlight(flight) {
  if (!flight) return null;
  const legs = flight.flights || [];
  const airlines = [...new Set(legs.map(l => l.airline).filter(Boolean))];
  const flightNumbers = legs.map(l => `${l.airline} ${l.flight_number}`).filter(Boolean);
  const firstLeg = legs[0] || {};
  const lastLeg = legs[legs.length - 1] || {};

  return {
    price: Math.round((flight.price || 0) * 100),
    airline: airlines.join(', ') || null,
    stops: Math.max(0, legs.length - 1),
    duration_minutes: flight.total_duration || null,
    departure_time: firstLeg.departure_airport?.time || null,
    arrival_time: lastLeg.arrival_airport?.time || null,
    flight_numbers: flightNumbers.join(', ') || null,
    booking_token: flight.booking_token || null,
  };
}

async function fetchLeg(leg, originOverride) {
  const origin = originOverride || leg.origins[0];

  const params = {
    engine: 'google_flights',
    api_key: SERPAPI_KEY,
    departure_id: origin,
    arrival_id: leg.destination,
    outbound_date: leg.date,
    type: 2, // one-way
    currency: 'USD',
    adults: leg.passengers || 1,
    sort_by: 2, // price
    hl: 'en',
    ...(leg.nonstopOnly ? { stops: 0 } : {}),
  };

  for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
    try {
      logger.info(`Fetching ${origin}→${leg.destination} (${leg.date}) attempt ${attempt}`);
      const { data } = await axios.get(SERPAPI_URL, { params, timeout: 30000 });

      consecutiveFailures = 0;

      const bestFlights = data.best_flights || [];
      const otherFlights = data.other_flights || [];
      const allFlights = [...bestFlights, ...otherFlights];
      const insights = data.price_insights || {};

      const now = Math.floor(Date.now() / 1000);
      const snapshots = [];

      for (const flight of allFlights) {
        const parsed = parseFlight(flight);
        if (!parsed || parsed.price === 0) continue;
        if (leg.nonstopOnly && parsed.stops !== 0) continue;

        // Tag budget airlines (stored but tracked separately)
        let isBudget = false;
        if (leg.budgetAirlines?.length && parsed.airline) {
          isBudget = leg.budgetAirlines.some(ba =>
            parsed.airline.toLowerCase().includes(ba.toLowerCase())
          );
        }

        // Filter by preferred departure time
        if (leg.preferDepartureTime && parsed.departure_time) {
          const timeMatch = parsed.departure_time.match(/(\d{2}):(\d{2})/);
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
          raw_json: JSON.stringify(flight),
        };

        insertSnapshot(snapshot);
        snapshots.push({ ...snapshot, isBudget });
      }

      const classySnapshots = snapshots.filter(s => !s.isBudget);
      const budgetSnapshots = snapshots.filter(s => s.isBudget);

      logger.info(`${origin}→${leg.destination}: ${snapshots.length} flights found (${classySnapshots.length} classy, ${budgetSnapshots.length} budget), cheapest $${classySnapshots.length ? (Math.min(...classySnapshots.map(s => s.price)) / 100).toFixed(2) : 'N/A'}`);

      return {
        leg,
        origin,
        snapshots,
        insights,
        cheapest: classySnapshots.length ? classySnapshots.reduce((a, b) => a.price < b.price ? a : b) : null,
        cheapestBudget: budgetSnapshots.length ? budgetSnapshots.reduce((a, b) => a.price < b.price ? a : b) : null,
      };
    } catch (err) {
      const status = err.response?.status;

      if (status === 429) {
        logger.warn(`Rate limited on ${origin}→${leg.destination}, waiting ${RETRY.rateLimitWaitMs / 1000}s`);
        await sleep(RETRY.rateLimitWaitMs);
        continue;
      }

      if (attempt < RETRY.maxAttempts) {
        const delay = RETRY.baseDelayMs * Math.pow(2, attempt - 1);
        logger.warn(`Fetch failed for ${origin}→${leg.destination} (attempt ${attempt}): ${err.message}. Retrying in ${delay / 1000}s`);
        await sleep(delay);
      } else {
        consecutiveFailures++;
        logger.error(`All ${RETRY.maxAttempts} attempts failed for ${origin}→${leg.destination}: ${err.message}`);

        if (consecutiveFailures >= RETRY.maxConsecutiveFailures) {
          logger.error(`${consecutiveFailures} consecutive failures — pausing ${RETRY.consecutiveFailurePauseMs / 1000}s`);
          await sleep(RETRY.consecutiveFailurePauseMs);
          consecutiveFailures = 0;
        }

        return { leg, origin, snapshots: [], insights: {}, cheapest: null, cheapestBudget: null, error: err.message };
      }
    }
  }
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
