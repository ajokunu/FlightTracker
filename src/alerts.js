import axios from 'axios';
import { DISCORD_WEBHOOK_URL, FLIGHT_LEGS, PRICE_DROP_ALERT_PCT, PRICE_SPIKE_ALERT_PCT, ALERT_COOLDOWN_HOURS } from './config.js';
import { getAlltimeMinPrice, getPreviousBestPrice, getLastAlertTime, insertAlert, getTripSummary } from './db.js';
import { logger } from './logger.js';

const COLORS = {
  alltime_low: 0xF39C12,    // Gold
  price_drop: 0x2ECC71,     // Green
  price_spike: 0xE74C3C,    // Red
  below_typical: 0x9B59B6,  // Purple
  daily_summary: 0x3498DB,  // Blue
};

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

function multiCityUrl() {
  const segments = FLIGHT_LEGS
    .map(l => `${l.origins[0]}.${l.destination}.${l.date}`)
    .join('*');
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

function buildEmbed({ leg, alertType, price, previousPrice, changePct, snapshot, tripTotal }) {
  const legConfig = FLIGHT_LEGS.find(l => l.id === leg) || {};
  const fields = [];

  fields.push({ name: 'Price', value: formatPrice(price), inline: true });

  if (snapshot?.airline) {
    fields.push({ name: 'Airline', value: snapshot.airline, inline: true });
  }
  if (snapshot?.stops !== undefined && snapshot?.stops !== null) {
    fields.push({ name: 'Stops', value: snapshot.stops === 0 ? 'Nonstop' : `${snapshot.stops} stop${snapshot.stops > 1 ? 's' : ''}`, inline: true });
  }
  if (snapshot?.duration_minutes) {
    fields.push({ name: 'Duration', value: formatDuration(snapshot.duration_minutes), inline: true });
  }
  if (snapshot?.departure_time && snapshot?.arrival_time) {
    fields.push({ name: 'Times', value: `${snapshot.departure_time} → ${snapshot.arrival_time}`, inline: true });
  }
  if (previousPrice) {
    fields.push({ name: 'Previous', value: formatPrice(previousPrice), inline: true });
  }
  if (changePct !== null && changePct !== undefined) {
    const arrow = changePct < 0 ? '↓' : '↑';
    fields.push({ name: 'Change', value: `${arrow} ${Math.abs(changePct).toFixed(1)}%`, inline: true });
  }
  if (snapshot?.price_level) {
    fields.push({ name: 'Price Level', value: snapshot.price_level, inline: true });
  }
  if (snapshot?.typical_price_low && snapshot?.typical_price_high) {
    fields.push({
      name: 'Typical Range',
      value: `${formatPrice(snapshot.typical_price_low)} – ${formatPrice(snapshot.typical_price_high)}`,
      inline: true,
    });
  }

  const titles = {
    alltime_low: `${legConfig.emoji || ''} ALL-TIME LOW — ${legConfig.label}`,
    price_drop: `${legConfig.emoji || ''} Price Drop — ${legConfig.label}`,
    price_spike: `${legConfig.emoji || ''} Price Spike — ${legConfig.label}`,
    below_typical: `${legConfig.emoji || ''} Below Typical — ${legConfig.label}`,
  };

  return {
    embeds: [{
      title: titles[alertType] || `${legConfig.label} Alert`,
      color: COLORS[alertType],
      fields,
      footer: tripTotal ? { text: `Total trip estimate: ${formatPrice(tripTotal)}` } : undefined,
      timestamp: new Date().toISOString(),
    }],
  };
}

export async function evaluateAlerts(results) {
  const summary = getTripSummary();
  const currentTotal = summary.totalCurrent;
  const alltimeTotal = summary.totalAlltime;

  // Build per-leg breakdown fields
  const legFields = [];
  const legEvents = []; // track what changed for the DB
  let hasChanges = false;

  for (const result of results) {
    if (!result.cheapest) continue;

    const { leg, cheapest } = result;
    const legConfig = FLIGHT_LEGS.find(l => l.id === leg.id) || {};
    const currentPrice = cheapest.price;
    const prev = getPreviousBestPrice(leg.id);
    const previousPrice = prev?.price || null;
    const alltimeRow = getAlltimeMinPrice(leg.id);
    const alltimeMin = alltimeRow?.price || currentPrice;

    // Determine what happened on this leg
    let indicator = '';
    let event = null;
    if (currentPrice <= alltimeMin) {
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
    if (!event && cheapest.typical_price_low && currentPrice < cheapest.typical_price_low) {
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

  if (!hasChanges || !legFields.length) return;

  // Determine overall alert type (most significant event wins)
  const priority = ['alltime_low', 'price_drop', 'below_typical', 'price_spike'];
  let topEvent = 'price_drop';
  for (const p of priority) {
    if (legEvents.some(e => e.event === p)) { topEvent = p; break; }
  }

  // Cooldown on trip-level alerts
  if (cooldownActive('trip', topEvent)) return;

  const titles = {
    alltime_low: '⭐ New All-Time Low Trip Price!',
    price_drop: '📉 Trip Price Dropped',
    price_spike: '📈 Trip Price Increased',
    below_typical: '💎 Trip Price Below Typical',
  };

  const payload = {
    embeds: [{
      title: titles[topEvent] || 'Trip Price Update',
      color: COLORS[topEvent],
      description: `**Total: ${formatPrice(currentTotal)}**${alltimeTotal ? ` (all-time best: ${formatPrice(alltimeTotal)})` : ''}\n\n[📋 Book entire trip on Google Flights](${multiCityUrl()})`,
      fields: legFields,
      timestamp: new Date().toISOString(),
    }],
  };

  await sendWebhook(payload);

  // Record alerts for each leg event
  const now = Math.floor(Date.now() / 1000);
  for (const ev of legEvents) {
    const changePct = ev.previousPrice ? ((ev.price - ev.previousPrice) / ev.previousPrice * 100) : null;
    insertAlert({
      leg_id: ev.leg_id, alert_type: ev.event, price: ev.price,
      previous_price: ev.previousPrice, change_pct: changePct,
      message: `${ev.event}: ${formatPrice(ev.price)}`, sent_at: now,
    });
  }
  // Record trip-level cooldown
  insertAlert({
    leg_id: 'trip', alert_type: topEvent, price: currentTotal,
    previous_price: null, change_pct: null,
    message: `Trip total: ${formatPrice(currentTotal)}`, sent_at: now,
  });
}

export async function sendDailySummary() {
  const summary = getTripSummary();
  if (!summary.best.length) {
    logger.info('No price data yet — skipping daily summary');
    return;
  }

  const departureDate = new Date('2026-05-01');
  const daysUntil = Math.ceil((departureDate - Date.now()) / (1000 * 60 * 60 * 24));

  const fields = [];
  for (const bp of summary.best) {
    const legConfig = FLIGHT_LEGS.find(l => l.id === bp.leg_id);
    const alltime = summary.alltime.find(a => a.leg_id === bp.leg_id);
    fields.push({
      name: `${legConfig?.emoji || ''} ${legConfig?.label || bp.leg_id}`,
      value: [
        `**Current best**: ${formatPrice(bp.price)} (${bp.airline || 'Unknown'})`,
        bp.stops !== null ? `${bp.stops === 0 ? 'Nonstop' : bp.stops + ' stop(s)'}` : '',
        bp.duration_minutes ? formatDuration(bp.duration_minutes) : '',
        alltime ? `All-time low: ${formatPrice(alltime.min_price)} | Avg: ${formatPrice(alltime.avg_price)}` : '',
      ].filter(Boolean).join('\n'),
      inline: false,
    });
  }

  const payload = {
    embeds: [{
      title: `Daily Flight Summary — ${daysUntil} days until departure`,
      color: COLORS.daily_summary,
      description: `[📋 Book entire trip on Google Flights](${multiCityUrl()})`,
      fields,
      footer: {
        text: `Total trip: ${formatPrice(summary.totalCurrent)} | All-time best total: ${formatPrice(summary.totalAlltime)}`,
      },
      timestamp: new Date().toISOString(),
    }],
  };

  await sendWebhook(payload);
  logger.info('Daily summary sent');
}
