// ============================================================
//  APEX-MD API  ·  Configuration
//  Render-deployed stateless REST API.
//
//  This config is intentionally leaner than the bot config —
//  no Baileys settings, no session, no QR, no AI engine keys.
//  The API never touches WhatsApp directly.
// ============================================================

require('dotenv').config();

module.exports = {
  // ── Identity ──────────────────────────────────────────────
  BOT_NAME:    process.env.BOT_NAME    || 'APEX-MD',
  BOT_VERSION: '2.1.0',

  // ── API Server ────────────────────────────────────────────
  // All /api/* requests must include:  X-API-Key: <API_SECRET>
  API_SECRET:  process.env.API_SECRET  || '',
  API_PORT:    Number(process.env.API_PORT) || 3000,

  // ── Database (REQUIRED) ───────────────────────────────────
  // Must be the same MongoDB URI as the bot uses.
  // The job queue lives here — no shared URI = no communication.
  MONGODB_URI: process.env.MONGODB_URI || '',
  DB_ENABLED:  !!process.env.MONGODB_URI,

  // ── Job Queue ─────────────────────────────────────────────
  // How long (ms) the API waits for the bot to execute a job
  // before returning a 504 timeout to the HTTP caller.
  JOB_TIMEOUT_MS: Number(process.env.JOB_TIMEOUT_MS) || 10000,

  // ── Logging ───────────────────────────────────────────────
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};
