import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const SERPAPI_KEY = process.env.SERPAPI_KEY || '';
export const AMADEUS_CLIENT_ID = process.env.AMADEUS_CLIENT_ID || '';
export const AMADEUS_CLIENT_SECRET = process.env.AMADEUS_CLIENT_SECRET || '';
export const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
export const RAPIDAPI_MONTHLY_LIMIT = parseInt(process.env.RAPIDAPI_MONTHLY_LIMIT || '100', 10);
export const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
export const GMAIL_USER = process.env.GMAIL_USER || '';
export const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
export const EMAIL_TO = process.env.EMAIL_TO || '';
export const POLL_INTERVAL_MINUTES = parseInt(process.env.POLL_INTERVAL_MINUTES || '30', 10);
export const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3001', 10);
export const PRICE_DROP_ALERT_PCT = parseFloat(process.env.PRICE_DROP_ALERT_PCT || '5');
export const PRICE_SPIKE_ALERT_PCT = parseFloat(process.env.PRICE_SPIKE_ALERT_PCT || '10');
export const ALERT_COOLDOWN_HOURS = parseFloat(process.env.ALERT_COOLDOWN_HOURS || '2');
export const DATA_RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS || '90', 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_FILE = path.resolve(__dirname, '../data/user-config.json');

/* ── Default trips & legs (fallback if no user-config.json) ── */

const DEFAULT_TRIPS = {
  nz: {
    id: 'nz',
    label: 'New Zealand & Australia',
    subtitle: 'NYC → Auckland → Wellington → Sydney → Melbourne → Boston | May 2026',
    passengers: 1,
    departureDate: '2026-05-01',
    color: '#3498DB',
    icon: '✈️',
  },
};

const DEFAULT_FLIGHT_LEGS = [
  {
    id: 'nyc-akl',
    label: 'New York → Auckland',
    emoji: '\u{1F5FD}\u2708\uFE0F\u{1F1F3}\u{1F1FF}',
    origins: ['JFK', 'EWR', 'LGA'],
    destination: 'AKL',
    date: '2026-05-01',
    nonstopOnly: true,
    trip: 'nz',
    passengers: 1,
    chartColor: '#268bd2',
  },
  {
    id: 'wlg-syd',
    label: 'Wellington → Sydney',
    emoji: '\u{1F1F3}\u{1F1FF}\u2708\uFE0F\u{1F1E6}\u{1F1FA}',
    origins: ['WLG'],
    destination: 'SYD',
    date: '2026-05-08',
    nonstopOnly: true,
    trip: 'nz',
    passengers: 1,
    chartColor: '#2aa198',
  },
  {
    id: 'syd-mel',
    label: 'Sydney → Melbourne',
    emoji: '\u{1F1E6}\u{1F1FA}\u2708\uFE0F\u{1F1E6}\u{1F1FA}',
    origins: ['SYD'],
    destination: 'MEL',
    date: '2026-05-13',
    nonstopOnly: true,
    trip: 'nz',
    passengers: 1,
    chartColor: '#6c71c4',
  },
  {
    id: 'mel-bos',
    label: 'Melbourne → Boston',
    emoji: '\u{1F1E6}\u{1F1FA}\u2708\uFE0F\u{1F5FD}',
    origins: ['MEL'],
    destination: 'BOS',
    date: '2026-05-16',
    nonstopOnly: false,
    trip: 'nz',
    passengers: 1,
    chartColor: '#cb4b16',
  },
];

/* ── Mutable config (updated by admin panel) ── */

export const TRIPS = { ...DEFAULT_TRIPS };
export const FLIGHT_LEGS = [...DEFAULT_FLIGHT_LEGS];

/** Load user config from JSON file (called on startup) */
export function loadUserConfig() {
  try {
    if (fs.existsSync(USER_CONFIG_FILE)) {
      const raw = fs.readFileSync(USER_CONFIG_FILE, 'utf8');
      const cfg = JSON.parse(raw);
      if (cfg.trips) {
        Object.keys(TRIPS).forEach(k => delete TRIPS[k]);
        Object.assign(TRIPS, cfg.trips);
      }
      if (cfg.legs) {
        FLIGHT_LEGS.length = 0;
        FLIGHT_LEGS.push(...cfg.legs);
      }
      return true;
    }
  } catch {
    // Fall through to defaults
  }
  return false;
}

/** Save current TRIPS + FLIGHT_LEGS to JSON file */
export function saveUserConfig() {
  const dir = path.dirname(USER_CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify({ trips: TRIPS, legs: FLIGHT_LEGS }, null, 2));
}

/** Update trips in-memory + persist */
export function updateTrips(trips) {
  Object.keys(TRIPS).forEach(k => delete TRIPS[k]);
  Object.assign(TRIPS, trips);
  saveUserConfig();
}

/** Update a single trip */
export function upsertTrip(tripId, tripData) {
  TRIPS[tripId] = { id: tripId, ...tripData };
  saveUserConfig();
}

/** Delete a trip and its legs */
export function deleteTrip(tripId) {
  delete TRIPS[tripId];
  // Remove legs belonging to this trip
  const remaining = FLIGHT_LEGS.filter(l => l.trip !== tripId);
  FLIGHT_LEGS.length = 0;
  FLIGHT_LEGS.push(...remaining);
  saveUserConfig();
}

/** Add or update a flight leg */
export function upsertLeg(legData) {
  const idx = FLIGHT_LEGS.findIndex(l => l.id === legData.id);
  if (idx >= 0) {
    FLIGHT_LEGS[idx] = legData;
  } else {
    FLIGHT_LEGS.push(legData);
  }
  saveUserConfig();
}

/** Delete a flight leg */
export function deleteLeg(legId) {
  const idx = FLIGHT_LEGS.findIndex(l => l.id === legId);
  if (idx >= 0) FLIGHT_LEGS.splice(idx, 1);
  saveUserConfig();
}

// Load user config on import
loadUserConfig();

export const RETRY = {
  maxAttempts: 3,
  baseDelayMs: 2000,
  rateLimitWaitMs: 60000,
  consecutiveFailurePauseMs: 300000,
  maxConsecutiveFailures: 5,
  staggerDelayMs: 2000,
};

// Round-robin state for NYC airports
let nycAirportIndex = 0;
export function getNextNycAirport() {
  const origins = FLIGHT_LEGS[0]?.origins || ['JFK'];
  const airport = origins[nycAirportIndex % origins.length];
  nycAirportIndex++;
  return airport;
}
