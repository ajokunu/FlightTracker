import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RAPIDAPI_KEY, RAPIDAPI_MONTHLY_LIMIT, RETRY } from '../config.js';
import { logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COUNTER_FILE = path.resolve(__dirname, '../../data/rapidapi-usage.json');

const SEARCH_URL = 'https://sky-scanner3.p.rapidapi.com/flights/search-one-way';

/* ── Monthly usage counter ─────────────────────────────────── */

function loadCounter() {
  try {
    const raw = fs.readFileSync(COUNTER_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { month: null, count: 0 };
  }
}

function saveCounter(counter) {
  fs.mkdirSync(path.dirname(COUNTER_FILE), { recursive: true });
  fs.writeFileSync(COUNTER_FILE, JSON.stringify(counter, null, 2));
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Increment and return the new count. Resets on new month. */
function incrementUsage() {
  const counter = loadCounter();
  const month = currentMonth();
  if (counter.month !== month) {
    counter.month = month;
    counter.count = 0;
  }
  counter.count += 1;
  saveCounter(counter);
  return counter.count;
}

function getUsage() {
  const counter = loadCounter();
  const month = currentMonth();
  if (counter.month !== month) return 0;
  return counter.count;
}

/* ── Response parser ───────────────────────────────────────── */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseItinerary(itin) {
  const leg = itin.legs?.[0] || itin;
  const segments = leg.segments || [];
  if (!segments.length && !leg.carriers) return null;

  const firstSeg = segments[0] || {};
  const lastSeg = segments[segments.length - 1] || {};

  // Airline names — try carriers array first, then segments
  let airlines;
  if (leg.carriers?.marketing?.length) {
    airlines = leg.carriers.marketing.map(c => c.name).filter(Boolean);
  } else {
    airlines = [...new Set(segments.map(s =>
      s.marketingCarrier?.name || s.operatingCarrier?.name
    ).filter(Boolean))];
  }

  const flightNumbers = segments.map(s => {
    const code = s.marketingCarrier?.alternateId || '';
    const num = s.flightNumber || '';
    return code && num ? `${code} ${num}` : null;
  }).filter(Boolean);

  const departure = leg.departure || firstSeg.departure;
  const arrival = leg.arrival || lastSeg.arrival;
  const durationMinutes = leg.durationInMinutes || null;
  const stopCount = leg.stopCount ?? Math.max(0, segments.length - 1);

  // Price — handle various response shapes
  const priceRaw = itin.price?.raw
    || itin.price?.amount
    || parseFloat(String(itin.price?.formatted || '0').replace(/[^0-9.]/g, ''));

  // Format timestamps to match SerpAPI format: "2026-05-01 19:20"
  function fmtTime(ts) {
    if (!ts) return null;
    return String(ts).replace('T', ' ').slice(0, 16);
  }

  return {
    price: Math.round((priceRaw || 0) * 100),
    airline: [...new Set(airlines)].join(', ') || null,
    stops: stopCount,
    duration_minutes: durationMinutes,
    departure_time: fmtTime(departure),
    arrival_time: fmtTime(arrival),
    flight_numbers: flightNumbers.join(', ') || null,
    booking_token: null,
    aircraft_type: null, // Skyscanner doesn't reliably provide this
    departure_airport_name: firstSeg.origin?.name || firstSeg.origin?.displayCode || null,
    arrival_airport_name: lastSeg.destination?.name || lastSeg.destination?.displayCode || null,
    raw_json: JSON.stringify(itin),
  };
}

/* ── Main fetch ────────────────────────────────────────────── */

export async function fetchFlights(origin, destination, date, options = {}) {
  if (!RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY not configured');

  // Hard monthly cap — refuse to call if at or over limit
  const used = getUsage();
  if (used >= RAPIDAPI_MONTHLY_LIMIT) {
    throw new Error(`RapidAPI monthly limit reached (${used}/${RAPIDAPI_MONTHLY_LIMIT}). Skipping to protect quota.`);
  }

  const params = {
    fromEntityId: origin,
    toEntityId: destination,
    departDate: date,
    adults: options.passengers || 1,
    currency: 'USD',
    market: 'US',
    locale: 'en-US',
  };

  const headers = {
    'X-RapidAPI-Key': RAPIDAPI_KEY,
    'X-RapidAPI-Host': 'sky-scanner3.p.rapidapi.com',
  };

  for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
    try {
      const callNum = incrementUsage();
      logger.info(`[RapidAPI] Fetching ${origin}→${destination} (${date}) attempt ${attempt} [${callNum}/${RAPIDAPI_MONTHLY_LIMIT} this month]`);
      const { data } = await axios.get(SEARCH_URL, { params, headers, timeout: 30000 });

      const itineraries = data.data?.itineraries || [];
      const flights = [];

      for (const itin of itineraries) {
        const parsed = parseItinerary(itin);
        if (!parsed || parsed.price === 0) continue;
        if (options.nonstopOnly && parsed.stops !== 0) continue;
        flights.push(parsed);
      }

      return { flights, insights: {} };
    } catch (err) {
      if (attempt < RETRY.maxAttempts) {
        const delay = RETRY.baseDelayMs * Math.pow(2, attempt - 1);
        logger.warn(`[RapidAPI] Fetch failed (attempt ${attempt}): ${err.message}. Retrying in ${delay / 1000}s`);
        await sleep(delay);
      } else {
        throw new Error(`RapidAPI failed after ${RETRY.maxAttempts} attempts: ${err.message}`);
      }
    }
  }

  throw new Error('RapidAPI: all attempts exhausted');
}

export const SOURCE_NAME = 'rapidapi';
