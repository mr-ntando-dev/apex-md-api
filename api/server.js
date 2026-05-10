// ============================================================
//  APEX-MD · API HTTP Server Bootstrap
//  Starts the Express server that hosts all /api/* endpoints.
//
//  Usage (called from index.js):
//    const { startApiServer } = require('./api/server');
//    const { mountApi }       = require('./api');
//    const httpServer = await startApiServer();
//    mountApi(httpServer.app, sock);   // pass sock after connect
// ============================================================

'use strict';

const express    = require('express');
const config     = require('../config');
const logger     = require('../lib/logger');

// Render injects PORT automatically — we honour it first,
// then fall back to API_PORT config, then 3000.
const PORT = process.env.PORT || process.env.API_PORT || config.API_PORT || 3000;

async function startApiServer() {
  const app = express();

  // ── Middleware ──────────────────────────────────────────────
  app.use(express.json({ limit: '50mb' }));   // support base64 media uploads
  app.use(express.urlencoded({ extended: true }));

  // Request logger (skip in test env)
  if (process.env.NODE_ENV !== 'test') {
    app.use((req, _res, next) => {
      logger.info(`[API] ${req.method} ${req.path}`);
      next();
    });
  }

  // Health ping (no auth needed)
  app.get('/ping', (_req, res) => res.json({ ok: true, bot: config.BOT_NAME }));

  // ── Start listening ────────────────────────────────────────
  await new Promise((resolve, reject) => {
    const server = app.listen(PORT, () => {
      logger.info(`[API] HTTP server listening on port ${PORT}`);
      resolve(server);
    });
    server.on('error', reject);
  });

  return { app };
}

module.exports = { startApiServer };
