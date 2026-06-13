const express = require('express');
const path    = require('path');
const { db }  = require('./database');
const { syncResources }                    = require('./sync');
const { applyResourceUpdate, removeResource } = require('./resourceManager');
const config  = require('./config');

function startWebPanel(client) {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ─── Auth middleware ────────────────────────────────────────────────────────
  function auth(req, res, next) {
    if (!config.panel.secret) {
      // No secret configured — panel is disabled
      return res.status(503).json({ error: 'Admin panel is not configured (PANEL_SECRET missing).' });
    }
    if (req.headers['x-panel-secret'] !== config.panel.secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }

  // ─── GET /api/status ────────────────────────────────────────────────────────
  app.get('/api/status', auth, (req, res) => {
    const guildId = config.guildId || client.guilds.cache.first()?.id || null;
    res.json({
      online:  client.isReady(),
      tag:     client.user?.tag   ?? null,
      ping:    client.ws.ping,
      guildId,
    });
  });

  // ─── GET /api/resources ─────────────────────────────────────────────────────
  app.get('/api/resources', auth, async (req, res) => {
    try {
      res.json(await db.getAllResources());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── PUT /api/resources/:id ─────────────────────────────────────────────────
  app.put('/api/resources/:id', auth, async (req, res) => {
    try {
      const resource = await applyResourceUpdate(client, req.params.id, req.body);
      res.json(resource);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // ─── DELETE /api/resources/:id ──────────────────────────────────────────────
  app.delete('/api/resources/:id', auth, async (req, res) => {
    try {
      await removeResource(client, req.params.id);
      res.json({ success: true });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // ─── POST /api/sync ─────────────────────────────────────────────────────────
  app.post('/api/sync', auth, async (req, res) => {
    try {
      const stats = await syncResources(client);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Start ──────────────────────────────────────────────────────────────────
  app.listen(config.panel.port, () => {
    console.log(`[panel] Admin panel → http://localhost:${config.panel.port}`);
  });
}

module.exports = { startWebPanel };
