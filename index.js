// ============================================================
//  APEX-MD API  ·  Main Entry Point
//  Render-deployed stateless REST API.
//
//  This repo has NO Baileys socket, NO QR code, NO WhatsApp
//  session.  It talks to the bot (apex-md-bot on panel/VPS)
//  exclusively through a shared MongoDB job queue.
//
//  Architecture:
//    apex-md-api  (this)  ──writes jobs──▶  MongoDB
//    apex-md-bot  (VPS)   ──reads  jobs──▶  MongoDB
//                         ──writes result─▶  MongoDB
//    apex-md-api  (this)  ──long-polls──▶  responds to HTTP caller
// ============================================================

'use strict';

const config  = require('./config');
const logger  = require('./lib/logger');
const db      = require('./lib/database');

// Render injects PORT automatically
const PORT = process.env.PORT || config.API_PORT || 3000;

// ── Splash ────────────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════════╗
║       ⚡  APEX-MD  REST API  ⚡           ║
║         v${config.BOT_VERSION}  |  2026 Edition          ║
║   Stateless Render API — job-queue mode  ║
╚══════════════════════════════════════════╝
`);

async function startServer() {
  // Connect to MongoDB (job queue lives here)
  await db.connect();

  const express = require('express');
  const app     = express();

  // ── Middleware ───────────────────────────────────────────
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true }));

  if (process.env.NODE_ENV !== 'test') {
    app.use((req, _res, next) => {
      logger.info(`[API] ${req.method} ${req.path}`);
      next();
    });
  }

  // ── Health ping (no auth — used by bot keep-alive pinger) ─
  app.get('/ping', (_req, res) => res.json({
    ok:      true,
    service: 'apex-md-api',
    version: config.BOT_VERSION,
    ts:      Date.now(),
  }));

  // ── Pairing page (no auth needed) ────────────────────────
  app.use('/pair', require('./api/pair-route'));

  // ── REST API routes (/api/*) ──────────────────────────────
  const { mountApi } = require('./api');
  mountApi(app);

  // ── 404 catch-all ─────────────────────────────────────────
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

  // ── Start HTTP server ─────────────────────────────────────
  app.listen(PORT, () => {
    logger.info(`[API] APEX-MD API listening on port ${PORT}`);
    logger.info(`[API] Health check: GET /ping`);
    logger.info(`[API] All routes:   /api/* (X-API-Key: <API_SECRET>)`);
  });
}

startServer().catch(err => {
  console.error('[Fatal] Failed to start APEX-MD API:', err);
  process.exit(1);
});
