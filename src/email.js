import nodemailer from 'nodemailer';
import { GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_TO, FLIGHT_LEGS, TRIPS } from './config.js';
import { logger } from './logger.js';

let transporter = null;

function getTransporter() {
  if (!transporter && GMAIL_USER && GMAIL_APP_PASSWORD) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

export function isEmailConfigured() {
  return !!(GMAIL_USER && GMAIL_APP_PASSWORD && EMAIL_TO);
}

function formatPrice(cents) {
  if (!cents && cents !== 0) return 'N/A';
  return '$' + (cents / 100).toFixed(2);
}

function formatDuration(minutes) {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

const EVENT_EMOJI = {
  alltime_low: '⭐',
  price_drop: '📉',
  price_spike: '📈',
  below_typical: '💎',
};

const EVENT_LABELS = {
  alltime_low: 'ALL-TIME LOW',
  price_drop: 'Price Drop',
  price_spike: 'Price Increase',
  below_typical: 'Below Typical',
};

/**
 * Send a price alert email.
 * @param {Object} opts
 * @param {string} opts.subject - Email subject line
 * @param {string} opts.topEvent - Event type (alltime_low, price_drop, etc.)
 * @param {Array} opts.legResults - Array of { leg, cheapest, cheapestBudget } results
 * @param {Array} opts.legEvents - Array of { leg_id, event, price, previousPrice }
 * @param {number} opts.total - Trip total in cents
 * @param {string} opts.tripId - Trip ID
 */
export async function sendAlertEmail({ subject, topEvent, legResults, legEvents, total, tripId }) {
  const t = getTransporter();
  if (!t || !EMAIL_TO) return;

  const trip = TRIPS[tripId];
  const eventsByLeg = {};
  for (const e of legEvents) eventsByLeg[e.leg_id] = e;

  let html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;background:#fdf6e3;padding:20px;border-radius:12px;">
      <h1 style="color:#073642;font-size:1.4rem;text-align:center;margin-bottom:4px;">
        ${EVENT_EMOJI[topEvent] || '✈️'} ${subject}
      </h1>
      <p style="text-align:center;color:#268bd2;font-size:1.6rem;font-weight:800;margin:12px 0;">
        ${formatPrice(total)}
      </p>
      <p style="text-align:center;color:#586e75;font-size:0.85rem;margin-bottom:20px;">
        ${trip?.subtitle || ''}
      </p>
      <hr style="border:none;border-top:1px solid #d6ceb5;margin:16px 0;">
  `;

  for (const result of legResults) {
    if (!result.cheapest) continue;
    const { leg, cheapest } = result;
    const legConfig = FLIGHT_LEGS.find(l => l.id === leg.id) || {};
    const ev = eventsByLeg[leg.id];

    let indicator = '';
    if (ev) {
      if (ev.event === 'alltime_low') indicator = ' ⭐ ALL-TIME LOW';
      else if (ev.event === 'price_drop') {
        const pct = ev.previousPrice ? Math.abs((ev.price - ev.previousPrice) / ev.previousPrice * 100).toFixed(1) : '';
        indicator = ` ↓${pct}%`;
      } else if (ev.event === 'price_spike') {
        const pct = ev.previousPrice ? ((ev.price - ev.previousPrice) / ev.previousPrice * 100).toFixed(1) : '';
        indicator = ` ↑${pct}%`;
      }
    }

    html += `
      <div style="background:#fff;border:1px solid #d6ceb5;border-radius:8px;padding:16px;margin-bottom:12px;">
        <div style="font-weight:700;color:#073642;margin-bottom:4px;">
          ${legConfig.emoji || ''} ${legConfig.label || leg.id}
          <span style="color:${ev?.event === 'price_drop' || ev?.event === 'alltime_low' ? '#859900' : ev?.event === 'price_spike' ? '#dc322f' : '#268bd2'};font-size:0.85rem;">${indicator}</span>
        </div>
        <div style="font-size:1.3rem;font-weight:800;color:#268bd2;margin-bottom:8px;">${formatPrice(cheapest.price)}</div>
        <div style="font-size:0.85rem;color:#586e75;">
          ${cheapest.airline || 'Unknown'} · ${cheapest.stops === 0 ? 'Nonstop' : cheapest.stops + ' stop(s)'}${cheapest.duration_minutes ? ' · ' + formatDuration(cheapest.duration_minutes) : ''}
        </div>
        ${cheapest.departure_time ? '<div style="font-size:0.8rem;color:#657b83;margin-top:4px;">' + cheapest.departure_time + ' → ' + (cheapest.arrival_time || '') + '</div>' : ''}
        ${cheapest.aircraft_type ? '<div style="font-size:0.8rem;color:#657b83;margin-top:2px;">✈️ ' + cheapest.aircraft_type + '</div>' : ''}
      </div>
    `;
  }

  html += `
      <p style="text-align:center;margin-top:16px;">
        <a href="https://www.google.com/flights" style="color:#268bd2;font-weight:600;text-decoration:none;">View on Google Flights →</a>
      </p>
      <p style="text-align:center;color:#93a1a1;font-size:0.7rem;margin-top:12px;">Flight Price Tracker</p>
    </div>
  `;

  try {
    await t.sendMail({
      from: GMAIL_USER,
      to: EMAIL_TO,
      subject,
      html,
    });
    logger.info(`Email alert sent to ${EMAIL_TO}`);
  } catch (err) {
    logger.error('Failed to send email alert:', err.message);
  }
}

/**
 * Send daily summary email.
 */
export async function sendDailySummaryEmail(embeds) {
  const t = getTransporter();
  if (!t || !EMAIL_TO) return;

  let html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;background:#fdf6e3;padding:20px;border-radius:12px;">
      <h1 style="color:#073642;font-size:1.4rem;text-align:center;">📊 Daily Flight Summary</h1>
      <p style="text-align:center;color:#586e75;font-size:0.85rem;">${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
      <hr style="border:none;border-top:1px solid #d6ceb5;margin:16px 0;">
  `;

  for (const embed of embeds) {
    html += `<h2 style="color:#073642;font-size:1.1rem;">${embed.title}</h2>`;
    for (const field of embed.fields || []) {
      if (field.value.includes('**')) {
        html += `<div style="background:#fff;border:1px solid #d6ceb5;border-radius:8px;padding:12px;margin-bottom:8px;">`;
        html += `<div style="font-weight:700;color:#073642;margin-bottom:4px;">${field.name}</div>`;
        html += `<div style="font-size:0.85rem;color:#586e75;white-space:pre-line;">${field.value.replace(/\*\*/g, '')}</div>`;
        html += `</div>`;
      }
    }
    if (embed.footer?.text) {
      html += `<p style="color:#93a1a1;font-size:0.78rem;margin-top:8px;">${embed.footer.text}</p>`;
    }
  }

  html += `
      <p style="text-align:center;color:#93a1a1;font-size:0.7rem;margin-top:16px;">Flight Price Tracker</p>
    </div>
  `;

  try {
    await t.sendMail({
      from: GMAIL_USER,
      to: EMAIL_TO,
      subject: `✈️ Daily Flight Summary — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      html,
    });
    logger.info(`Daily summary email sent to ${EMAIL_TO}`);
  } catch (err) {
    logger.error('Failed to send daily summary email:', err.message);
  }
}
