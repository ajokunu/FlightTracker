import axios from 'axios';
import { AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET, RETRY } from '../config.js';
import { logger } from '../logger.js';

const AUTH_URL = 'https://test.api.amadeus.com/v1/security/oauth2/token';
const FLIGHTS_URL = 'https://test.api.amadeus.com/v2/shopping/flight-offers';

let tokenCache = { token: null, expiresAt: 0 };

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 60000) {
    return tokenCache.token;
  }

  logger.info('[Amadeus] Refreshing OAuth token');
  const { data } = await axios.post(AUTH_URL,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: AMADEUS_CLIENT_ID,
      client_secret: AMADEUS_CLIENT_SECRET,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 },
  );

  tokenCache = {
    token: data.access_token,
    expiresAt: now + (data.expires_in * 1000),
  };
  return tokenCache.token;
}

const AIRLINE_NAMES = {
  AA: 'American Airlines', UA: 'United', DL: 'Delta',
  NZ: 'Air New Zealand', QF: 'Qantas', VA: 'Virgin Australia',
  JQ: 'Jetstar', SQ: 'Singapore Airlines', CX: 'Cathay Pacific',
  EK: 'Emirates', QR: 'Qatar Airways', LH: 'Lufthansa',
  BA: 'British Airways', AC: 'Air Canada', HA: 'Hawaiian Airlines',
  AS: 'Alaska Airlines', B6: 'JetBlue', WN: 'Southwest',
  NK: 'Spirit', F9: 'Frontier', LA: 'LATAM', FJ: 'Fiji Airways',
  TN: 'Air Tahiti Nui', PR: 'Philippine Airlines', MH: 'Malaysia Airlines',
};

// Map common Amadeus aircraft codes to readable names
const AIRCRAFT_NAMES = {
  '787': 'Boeing 787', '789': 'Boeing 787-9', '788': 'Boeing 787-8',
  '77W': 'Boeing 777-300ER', '777': 'Boeing 777', '773': 'Boeing 777-300',
  '772': 'Boeing 777-200', '738': 'Boeing 737-800', '7M8': 'Boeing 737 MAX 8',
  '7M9': 'Boeing 737 MAX 9', '73H': 'Boeing 737-800', '739': 'Boeing 737-900',
  '320': 'Airbus A320', '32N': 'Airbus A320neo', '321': 'Airbus A321',
  '32Q': 'Airbus A321neo', '332': 'Airbus A330-200', '333': 'Airbus A330-300',
  '339': 'Airbus A330-900neo', '359': 'Airbus A350-900', '388': 'Airbus A380',
  'E90': 'Embraer E190', 'E95': 'Embraer E195', 'CR9': 'CRJ-900',
  'AT7': 'ATR 72', 'DH4': 'Dash 8-400',
};

function parseIsoDuration(iso) {
  if (!iso) return null;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return null;
  return (parseInt(match[1] || 0, 10) * 60) + parseInt(match[2] || 0, 10);
}

function formatTime(isoTimestamp) {
  if (!isoTimestamp) return null;
  // Return the date+time portion to match SerpAPI format: "2026-05-01 19:20"
  return isoTimestamp.replace('T', ' ').slice(0, 16);
}

function parseOffer(offer) {
  const itinerary = offer.itineraries?.[0];
  if (!itinerary) return null;

  const segments = itinerary.segments || [];
  if (!segments.length) return null;

  const firstSeg = segments[0];
  const lastSeg = segments[segments.length - 1];

  const carrierCodes = [...new Set(segments.map(s => s.carrierCode).filter(Boolean))];
  const airlines = carrierCodes.map(code => AIRLINE_NAMES[code] || code);
  const flightNumbers = segments.map(s => `${s.carrierCode} ${s.number}`).filter(Boolean);
  const aircraftCodes = segments.map(s => s.aircraft?.code).filter(Boolean);
  const aircraftTypes = aircraftCodes.map(code => AIRCRAFT_NAMES[code] || code);

  const totalDuration = parseIsoDuration(itinerary.duration);
  const priceTotal = parseFloat(offer.price?.total || '0');

  return {
    price: Math.round(priceTotal * 100),
    airline: airlines.join(', ') || null,
    stops: Math.max(0, segments.length - 1),
    duration_minutes: totalDuration,
    departure_time: formatTime(firstSeg.departure?.at),
    arrival_time: formatTime(lastSeg.arrival?.at),
    flight_numbers: flightNumbers.join(', ') || null,
    booking_token: null,
    aircraft_type: aircraftTypes.join(', ') || null,
    departure_airport_name: firstSeg.departure?.iataCode || null,
    arrival_airport_name: lastSeg.arrival?.iataCode || null,
    raw_json: JSON.stringify(offer),
  };
}

export async function fetchFlights(origin, destination, date, options = {}) {
  if (!AMADEUS_CLIENT_ID || !AMADEUS_CLIENT_SECRET) {
    throw new Error('Amadeus credentials not configured');
  }

  let token = await getAccessToken();

  const params = {
    originLocationCode: origin,
    destinationLocationCode: destination,
    departureDate: date,
    adults: options.passengers || 1,
    currencyCode: 'USD',
    max: 50,
    ...(options.nonstopOnly ? { nonStop: true } : {}),
  };

  for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
    try {
      logger.info(`[Amadeus] Fetching ${origin}→${destination} (${date}) attempt ${attempt}`);
      const { data } = await axios.get(FLIGHTS_URL, {
        params,
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000,
      });

      const offers = data.data || [];
      const flights = [];
      for (const offer of offers) {
        const parsed = parseOffer(offer);
        if (!parsed || parsed.price === 0) continue;
        if (options.nonstopOnly && parsed.stops !== 0) continue;
        flights.push(parsed);
      }

      return { flights, insights: {} };
    } catch (err) {
      const status = err.response?.status;

      if (status === 401 && attempt <= 2) {
        logger.warn('[Amadeus] Token expired, refreshing...');
        tokenCache = { token: null, expiresAt: 0 };
        token = await getAccessToken();
        continue;
      }

      if (attempt < RETRY.maxAttempts) {
        const delay = RETRY.baseDelayMs * Math.pow(2, attempt - 1);
        logger.warn(`[Amadeus] Fetch failed (attempt ${attempt}): ${err.message}. Retrying in ${delay / 1000}s`);
        await sleep(delay);
      } else {
        throw new Error(`Amadeus failed after ${RETRY.maxAttempts} attempts: ${err.message}`);
      }
    }
  }

  throw new Error('Amadeus: all attempts exhausted');
}

export const SOURCE_NAME = 'amadeus';
