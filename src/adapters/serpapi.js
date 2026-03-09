import axios from 'axios';
import { SERPAPI_KEY, RETRY } from '../config.js';
import { logger } from '../logger.js';

const SERPAPI_URL = 'https://serpapi.com/search';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseFlight(flight) {
  if (!flight) return null;
  const legs = flight.flights || [];
  const airlines = [...new Set(legs.map(l => l.airline).filter(Boolean))];
  const flightNumbers = legs.map(l => `${l.airline} ${l.flight_number}`).filter(Boolean);
  const aircraftTypes = legs.map(l => l.airplane).filter(Boolean);
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
    aircraft_type: aircraftTypes.join(', ') || null,
    departure_airport_name: firstLeg.departure_airport?.name || null,
    arrival_airport_name: lastLeg.arrival_airport?.name || null,
  };
}

export async function fetchFlights(origin, destination, date, options = {}) {
  if (!SERPAPI_KEY) throw new Error('SERPAPI_KEY not configured');

  const params = {
    engine: 'google_flights',
    api_key: SERPAPI_KEY,
    departure_id: origin,
    arrival_id: destination,
    outbound_date: date,
    type: 2,
    currency: 'USD',
    adults: options.passengers || 1,
    sort_by: 2,
    hl: 'en',
    ...(options.nonstopOnly ? { stops: 0 } : {}),
  };

  for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
    try {
      logger.info(`[SerpAPI] Fetching ${origin}→${destination} (${date}) attempt ${attempt}`);
      const { data } = await axios.get(SERPAPI_URL, { params, timeout: 30000 });

      const bestFlights = data.best_flights || [];
      const otherFlights = data.other_flights || [];
      const allFlights = [...bestFlights, ...otherFlights];
      const insights = data.price_insights || {};

      const flights = [];
      for (const flight of allFlights) {
        const parsed = parseFlight(flight);
        if (!parsed || parsed.price === 0) continue;
        if (options.nonstopOnly && parsed.stops !== 0) continue;
        flights.push({ ...parsed, raw_json: JSON.stringify(flight) });
      }

      return { flights, insights };
    } catch (err) {
      const status = err.response?.status;

      if (status === 429) {
        logger.warn(`[SerpAPI] Rate limited on ${origin}→${destination}, waiting ${RETRY.rateLimitWaitMs / 1000}s`);
        await sleep(RETRY.rateLimitWaitMs);
        continue;
      }

      if (attempt < RETRY.maxAttempts) {
        const delay = RETRY.baseDelayMs * Math.pow(2, attempt - 1);
        logger.warn(`[SerpAPI] Fetch failed (attempt ${attempt}): ${err.message}. Retrying in ${delay / 1000}s`);
        await sleep(delay);
      } else {
        throw new Error(`SerpAPI failed after ${RETRY.maxAttempts} attempts: ${err.message}`);
      }
    }
  }

  throw new Error('SerpAPI: all attempts exhausted (rate limited)');
}

export const SOURCE_NAME = 'serpapi';
