import 'dotenv/config';

export const SERPAPI_KEY = process.env.SERPAPI_KEY;
export const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
export const POLL_INTERVAL_MINUTES = parseInt(process.env.POLL_INTERVAL_MINUTES || '30', 10);
export const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3001', 10);
export const PRICE_DROP_ALERT_PCT = parseFloat(process.env.PRICE_DROP_ALERT_PCT || '5');
export const PRICE_SPIKE_ALERT_PCT = parseFloat(process.env.PRICE_SPIKE_ALERT_PCT || '10');
export const ALERT_COOLDOWN_HOURS = parseFloat(process.env.ALERT_COOLDOWN_HOURS || '2');

export const TRIPS = {
  nz: {
    id: 'nz',
    label: 'New Zealand & Australia',
    subtitle: 'NYC → Auckland → Wellington → Sydney → Melbourne → Boston | May 2026',
    passengers: 1,
    departureDate: '2026-05-01',
  },
};

export const FLIGHT_LEGS = [
  // === New Zealand trip ===
  {
    id: 'nyc-akl',
    label: 'New York → Auckland',
    emoji: '🗽✈️🇳🇿',
    origins: ['JFK', 'EWR', 'LGA'],
    destination: 'AKL',
    date: '2026-05-01',
    nonstopOnly: true,
    trip: 'nz',
    passengers: 1,
  },
  {
    id: 'wlg-syd',
    label: 'Wellington → Sydney',
    emoji: '🇳🇿✈️🇦🇺',
    origins: ['WLG'],
    destination: 'SYD',
    date: '2026-05-08',
    nonstopOnly: true,
    trip: 'nz',
    passengers: 1,
  },
  {
    id: 'syd-mel',
    label: 'Sydney → Melbourne',
    emoji: '🇦🇺✈️🇦🇺',
    origins: ['SYD'],
    destination: 'MEL',
    date: '2026-05-13',
    nonstopOnly: true,
    trip: 'nz',
    passengers: 1,
  },
  {
    id: 'mel-bos',
    label: 'Melbourne → Boston',
    emoji: '🇦🇺✈️🗽',
    origins: ['MEL'],
    destination: 'BOS',
    date: '2026-05-16',
    nonstopOnly: false,
    trip: 'nz',
    passengers: 1,
  },
];

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
  const origins = FLIGHT_LEGS[0].origins;
  const airport = origins[nycAirportIndex % origins.length];
  nycAirportIndex++;
  return airport;
}
