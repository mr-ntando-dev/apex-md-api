// ============================================================
//  APEX-MD · Session Manager
//  Handles two session strategies:
//
//  1. SESSION_ID env var  — base64-encoded zip of the session
//     folder. Bot restores it on boot, saves updates back.
//     Use this on Render free plan (no persistent disk).
//
//  2. Local folder  — standard Baileys ./session folder.
//     Use this on Render paid plan with a disk, or locally.
//
//  HOW TO GET YOUR SESSION_ID:
//    node generate-session.js
//  That script starts the bot locally, you scan the QR, then
//  it prints the SESSION_ID string to paste into Render.
// ============================================================

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const SESSION_DIR = process.env.SESSION_DIR || './session';

/**
 * On boot: if SESSION_ID env var is set, decode + write files
 * into the session directory before Baileys reads them.
 */
function restoreSession() {
  const encoded = process.env.SESSION_ID;
  if (!encoded) return false;

  try {
    logger.info('[Session] Restoring session from SESSION_ID env var...');

    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    // SESSION_ID is a base64-encoded JSON map: { "filename": "base64content", ... }
    const raw  = Buffer.from(encoded, 'base64').toString('utf-8');
    const files = JSON.parse(raw);

    for (const [filename, content] of Object.entries(files)) {
      const dest = path.join(SESSION_DIR, filename);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(content, 'base64'));
    }

    logger.info(`[Session] ✅ Restored ${Object.keys(files).length} session files.`);
    return true;
  } catch (err) {
    logger.error('[Session] Failed to restore session:', err.message);
    return false;
  }
}

/**
 * After Baileys saves credentials, re-encode the session folder
 * and log the new SESSION_ID (useful if you need to update the env var).
 * In production this is informational only — Render keeps the env var
 * you set; you only need to re-paste it if the session rotates.
 */
function encodeSession(dir = SESSION_DIR) {
  try {
    if (!fs.existsSync(dir)) return null;
    const files = {};
    const walk  = (d) => {
      for (const entry of fs.readdirSync(d)) {
        const full = path.join(d, entry);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        const rel  = path.relative(dir, full);
        files[rel] = fs.readFileSync(full).toString('base64');
      }
    };
    walk(dir);
    return Buffer.from(JSON.stringify(files)).toString('base64');
  } catch (_) {
    return null;
  }
}

module.exports = { restoreSession, encodeSession, SESSION_DIR };
