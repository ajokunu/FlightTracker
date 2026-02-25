import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getBestPrices, getAlltimeBest, getPriceHistory, getDailyTrends, getRecentAlerts, getTripSummary } from './db.js';
import { FLIGHT_LEGS } from './config.js';
import { logger } from './logger.js';

const ACTIVE_LEG_IDS = FLIGHT_LEGS.map(l => l.id);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startDashboard(port) {
  const app = express();
  app.use(cors());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/prices', (req, res) => {
    try {
      res.json(getBestPrices().filter(p => ACTIVE_LEG_IDS.includes(p.leg_id)));
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
      res.json(getTripSummary(ACTIVE_LEG_IDS));
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
