import axios from 'axios';
import { DISCORD_WEBHOOK_URL, FLIGHT_LEGS, TRIPS, PRICE_DROP_ALERT_PCT, PRICE_SPIKE_ALERT_PCT, ALERT_COOLDOWN_HOURS } from './config.js';
import { getAlltimeMinPrice, getPreviousBestPrice, getLastAlertTime, insertAlert, getBestPrices, getAlltimeBest } from './db.js';
import { logger } from './logger.js';

const COLORS = {
  alltime_low: 0xF39C12,
  price_drop: 0x2ECC71,
  price_spike: 0xE74C3C,
  below_typical: 0x9B59B6,
  daily_summary: 0x3498DB,
};

const TRIP_COLORS = { nz: 0x3498DB, disney: 0xE74C3C };
const TRIP_ICONS = { nz: '✈️', disney: '🏰' };

function formatPrice(cents) {
  if (!cents && cents !== 0) return 'N/A';
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDuration(minutes) {
  if (!minutes) return 'N/A';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

function multiCityUrl(tripId) {
  const legs = FLIGHT_LEGS.filter(l => l.trip === tripId);
  const segments = legs.map(l => `${l.origins[0]}.${l.destination}.${l.date}`).join('*');
  return `https://www.google.com/flights#flt=${segments};c:USD;e:1;t:m`;
}

function cooldownActive(legId, alertType) {
  const lastSent = getLastAlertTime(legId, alertType);
  const cooldownMs = ALERT_COOLDOWN_HOURS * 3600 * 1000;
  return (Date.now() - lastSent * 1000) < cooldownMs;
}

async function sendWebhook(payload) {
  if (!DISCORD_WEBHOOK_URL) {
    logger.warn('No DISCORD_WEBHOOK_URL configured — skipping alert');
    return;
  }
  try {
    await axios.post(DISCORD_WEBHOOK_URL, payload, { timeout: 10000 });
    logger.info('Discord alert sent');
  } catch (err) {
    logger.error('Failed to send Discord alert:', err.message);
  }
}

function evaluateTripAlerts(tripId, tripResults) {
  const trip = TRIPS[tripId];
  if (!trip) return null;

  // Check if any price changed
  let anyChanged = false;
  for (const result of tripResults) {
    if (!result.cheapest) continue;
    const prev = getPreviousBestPrice(result.leg.id);
    if (!prev?.price || prev.price !== result.cheapest.price) {
      anyChanged = true;
      break;
    }
  }
  if (!anyChanged) return null;

  const legFields = [];
  const legEvents = [];
  let hasChanges = false;

  for (const result of tripResults) {
    if (!result.cheapest) continue;
    const { leg, cheapest } = result;
    const legConfig = FLIGHT_LEGS.find(l => l.id === leg.id) || {};
    const currentPrice = cheapest.price;
    const prev = getPreviousBestPrice(leg.id);
    const previousPrice = prev?.price || null;
    const alltimeRow = getAlltimeMinPrice(leg.id);
    const alltimeMin = alltimeRow?.price || currentPrice;

    let indicator = '';
    let event = null;
    if (previousPrice && currentPrice < alltimeMin) {
      indicator = ' ⭐ ATL';
      event = 'alltime_low';
      hasChanges = true;
    } else if (previousPrice && currentPrice < previousPrice) {
      const pct = ((currentPrice - previousPrice) / previousPrice) * 100;
      if (Math.abs(pct) >= PRICE_DROP_ALERT_PCT) {
        indicator = ` ↓${Math.abs(pct).toFixed(1)}%`;
        event = 'price_drop';
        hasChanges = true;
      }
    } else if (previousPrice && currentPrice > previousPrice) {
      const pct = ((currentPrice - previousPrice) / previousPrice) * 100;
      if (pct >= PRICE_SPIKE_ALERT_PCT) {
        indicator = ` ↑${pct.toFixed(1)}%`;
        event = 'price_spike';
        hasChanges = true;
      }
    }
    if (!event && cheapest.typical_price_low && currentPrice < cheapest.typical_price_low && previousPrice) {
      indicator = ' 💎 Below typical';
      event = 'below_typical';
      hasChanges = true;
    }

    legFields.push({
      name: `${legConfig.emoji || ''} ${legConfig.label}${indicator}`,
      value: [
        `**${formatPrice(currentPrice)}** — ${cheapest.airline || 'Unknown'}`,
        `${cheapest.stops === 0 ? 'Nonstop' : cheapest.stops + ' stop(s)'}${cheapest.duration_minutes ? ' · ' + formatDuration(cheapest.duration_minutes) : ''}`,
      ].join('\n'),
      inline: false,
    });

    if (event) {
      legEvents.push({ leg_id: leg.id, event, price: currentPrice, previousPrice });
    }
  }

  if (!hasChanges || !legFields.length) return null;

  const priority = ['alltime_low', 'price_drop', 'below_typical', 'price_spike'];
  let topEvent = 'price_drop';
  for (const p of priority) {
    if (legEvents.some(e => e.event === p)) { topEvent = p; break; }
  }

  const cooldownKey = `trip-${tripId}`;
  if (cooldownActive(cooldownKey, topEvent)) return null;

  const total = tripResults.filter(r => r.cheapest).reduce((s, r) => s + r.cheapest.price, 0);
  const passengers = trip.passengers || 1;

  const titles = {
    alltime_low: `${TRIP_ICONS[tripId] || '✈️'} All-Time Low — ${trip.label}!`,
    price_drop: `${TRIP_ICONS[tripId] || '✈️'} Price Drop — ${trip.label}`,
    price_spike: `${TRIP_ICONS[tripId] || '✈️'} Price Increase — ${trip.label}`,
    below_typical: `${TRIP_ICONS[tripId] || '✈️'} Below Typical — ${trip.label}`,
  };

  const perPerson = Math.round(total / passengers);
  const priceDesc = passengers > 1
    ? `**${formatPrice(total)} total** (${passengers} passengers · ${formatPrice(perPerson)}/person round trip)`
    : `**Total: ${formatPrice(total)}**`;

  return {
    embed: {
      title: titles[topEvent] || `${trip.label} Update`,
      color: TRIP_COLORS[tripId] || COLORS[topEvent],
      description: `${priceDesc}\n\n[📋 Book on Google Flights](${multiCityUrl(tripId)})`,
      fields: legFields,
      footer: { text: trip.subtitle },
      timestamp: new Date().toISOString(),
    },
    legEvents,
    topEvent,
    total,
    cooldownKey,
  };
}

export async function evaluateAlerts(results) {
  // Group results by trip
  const byTrip = {};
  for (const result of results) {
    const tripId = result.leg.trip || 'nz';
    if (!byTrip[tripId]) byTrip[tripId] = [];
    byTrip[tripId].push(result);
  }

  const embeds = [];
  const allEvents = [];

  for (const [tripId, tripResults] of Object.entries(byTrip)) {
    const evaluation = evaluateTripAlerts(tripId, tripResults);
    if (!evaluation) continue;
    embeds.push(evaluation.embed);
    allEvents.push(evaluation);
  }

  if (!embeds.length) {
    logger.info('No price changes detected — skipping Discord alert');
    return;
  }

  await sendWebhook({ embeds });

  // Record alerts
  const now = Math.floor(Date.now() / 1000);
  for (const ev of allEvents) {
    for (const le of ev.legEvents) {
      const changePct = le.previousPrice ? ((le.price - le.previousPrice) / le.previousPrice * 100) : null;
      insertAlert({
        leg_id: le.leg_id, alert_type: le.event, price: le.price,
        previous_price: le.previousPrice, change_pct: changePct,
        message: `${le.event}: ${formatPrice(le.price)}`, sent_at: now,
      });
    }
    insertAlert({
      leg_id: ev.cooldownKey, alert_type: ev.topEvent, price: ev.total,
      previous_price: null, change_pct: null,
      message: `Trip total: ${formatPrice(ev.total)}`, sent_at: now,
    });
  }
}

export async function sendDailySummary() {
  const best = getBestPrices();
  const alltime = getAlltimeBest();
  if (!best.length) {
    logger.info('No price data yet — skipping daily summary');
    return;
  }

  const embeds = [];

  for (const [tripId, trip] of Object.entries(TRIPS)) {
    const tripLegIds = FLIGHT_LEGS.filter(l => l.trip === tripId).map(l => l.id);
    const tripBest = best.filter(b => tripLegIds.includes(b.leg_id));
    if (!tripBest.length) continue;

    const daysUntil = Math.ceil((new Date(trip.departureDate) - Date.now()) / (1000 * 60 * 60 * 24));
    const passengers = trip.passengers || 1;

    const fields = [];
    for (const bp of tripBest) {
      const legConfig = FLIGHT_LEGS.find(l => l.id === bp.leg_id);
      const at = alltime.find(a => a.leg_id === bp.leg_id);
      fields.push({
        name: `${legConfig?.emoji || ''} ${legConfig?.label || bp.leg_id}`,
        value: [
          `**${formatPrice(bp.price)}** (${bp.airline || 'Unknown'})`,
          bp.stops !== null ? `${bp.stops === 0 ? 'Nonstop' : bp.stops + ' stop(s)'}` : '',
          bp.duration_minutes ? formatDuration(bp.duration_minutes) : '',
          at ? `All-time low: ${formatPrice(at.min_price)}` : '',
        ].filter(Boolean).join('\n'),
        inline: false,
      });
    }

    const total = tripBest.reduce((s, b) => s + b.price, 0);
    const priceText = passengers > 1
      ? `${formatPrice(total)} total (${passengers} pax · ${formatPrice(Math.round(total / passengers))}/person)`
      : formatPrice(total);

    embeds.push({
      title: `${TRIP_ICONS[tripId] || '✈️'} ${trip.label} — ${daysUntil} days out`,
      color: TRIP_COLORS[tripId] || COLORS.daily_summary,
      description: `[📋 Book on Google Flights](${multiCityUrl(tripId)})`,
      fields,
      footer: { text: `${trip.subtitle} | Trip total: ${priceText}` },
      timestamp: new Date().toISOString(),
    });
  }

  if (embeds.length) {
    await sendWebhook({ embeds });
    logger.info('Daily summary sent');
  }
}
