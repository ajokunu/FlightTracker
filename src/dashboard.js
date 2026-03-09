import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getBestPrices, getAlltimeBest, getPriceHistory, getDailyTrends, getRecentAlerts, getTripSummary, getAdapterCallCounts } from './db.js';
import { FLIGHT_LEGS, TRIPS, RAPIDAPI_MONTHLY_LIMIT, upsertTrip, deleteTrip, upsertLeg, deleteLeg } from './config.js';
import { getAdapterStats } from './fetcher.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startDashboard(port) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Helper: get active leg IDs dynamically (since FLIGHT_LEGS is mutable)
  function activeLegIds() {
    return FLIGHT_LEGS.map(l => l.id);
  }

  app.get('/api/prices', (req, res) => {
    try {
      const ids = activeLegIds();
      res.json(getBestPrices().filter(p => ids.includes(p.leg_id)));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/history/:legId', (req, res) => {
    try {
      const range = req.query.range || '7d';
      const rangeMap = { '24h': 86400, '3d': 259200, '7d': 604800, '30d': 2592000 };
      const seconds = rangeMap[range] || 604800;
      const since = Math.floor(Date.now() / 1000) - seconds;
      res.json(getPriceHistory(req.params.legId, since));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/summary', (req, res) => {
    try {
      res.json(getTripSummary(activeLegIds()));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/trends/:legId', (req, res) => {
    try {
      res.json(getDailyTrends(req.params.legId));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/alerts', (req, res) => {
    try {
      const limit = parseInt(req.query.limit || '20', 10);
      res.json(getRecentAlerts(limit));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // API usage stats
  app.get('/api/stats', (req, res) => {
    try {
      const sessionStats = getAdapterStats();
      const dbCounts = getAdapterCallCounts();
      const rapidapiMonthlyLimit = RAPIDAPI_MONTHLY_LIMIT;
      res.json({ session: sessionStats, database: dbCounts, rapidapiMonthlyLimit });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* ── Admin API ────────────────────────────────────── */

  // Get all trips
  app.get('/api/admin/trips', (req, res) => {
    res.json(TRIPS);
  });

  // Get all legs
  app.get('/api/admin/legs', (req, res) => {
    res.json(FLIGHT_LEGS);
  });

  // Create or update a trip
  app.put('/api/admin/trips/:tripId', (req, res) => {
    try {
      const { tripId } = req.params;
      const { label, subtitle, passengers, departureDate } = req.body;
      if (!label) return res.status(400).json({ error: 'label is required' });
      upsertTrip(tripId, { label, subtitle, passengers: passengers || 1, departureDate });
      logger.info(`[Admin] Trip "${tripId}" saved`);
      res.json({ ok: true, trip: TRIPS[tripId] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete a trip and its legs
  app.delete('/api/admin/trips/:tripId', (req, res) => {
    try {
      const { tripId } = req.params;
      if (!TRIPS[tripId]) return res.status(404).json({ error: 'Trip not found' });
      deleteTrip(tripId);
      logger.info(`[Admin] Trip "${tripId}" deleted`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create or update a leg
  app.put('/api/admin/legs/:legId', (req, res) => {
    try {
      const { legId } = req.params;
      const { label, emoji, origins, destination, date, nonstopOnly, trip, passengers } = req.body;
      if (!destination || !date || !trip) {
        return res.status(400).json({ error: 'destination, date, and trip are required' });
      }
      if (!TRIPS[trip]) {
        return res.status(400).json({ error: `Trip "${trip}" does not exist` });
      }
      const originsArr = Array.isArray(origins) ? origins : (origins || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!originsArr.length) {
        return res.status(400).json({ error: 'At least one origin airport is required' });
      }
      upsertLeg({
        id: legId,
        label: label || `${originsArr[0]} → ${destination}`,
        emoji: emoji || '',
        origins: originsArr,
        destination,
        date,
        nonstopOnly: nonstopOnly ?? false,
        trip,
        passengers: passengers || 1,
      });
      logger.info(`[Admin] Leg "${legId}" saved`);
      res.json({ ok: true, leg: FLIGHT_LEGS.find(l => l.id === legId) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete a leg
  app.delete('/api/admin/legs/:legId', (req, res) => {
    try {
      const { legId } = req.params;
      if (!FLIGHT_LEGS.find(l => l.id === legId)) {
        return res.status(404).json({ error: 'Leg not found' });
      }
      deleteLeg(legId);
      logger.info(`[Admin] Leg "${legId}" deleted`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const server = app.listen(port, () => {
    logger.info(`Dashboard running at http://localhost:${port}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${port} is in use — dashboard not started. Change DASHBOARD_PORT in .env`);
    } else {
      logger.error('Dashboard server error:', err.message);
    }
  });
}
