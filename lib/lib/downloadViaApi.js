// ============================================================
//  APEX-MD · Download via API proxy
//
//  Routes all downloads through apex-md-api on Render so the
//  bot's panel IP is the one making requests to TikTok/IG/YT.
//  The Render IP (shared, rotated) stays hidden from media hosts.
//
//  Falls back to direct download if API_URL is not set or the
//  job fails — so the bot still works standalone.
// ============================================================
'use strict';

const fetch  = require('node-fetch');
const config = require('../config');
const logger = require('./logger');

/**
 * Download media via the API job queue.
 * Returns a Buffer, or throws if both API and fallback fail.
 *
 * @param {string} url    - Media URL
 * @param {string} type   - 'video' | 'audio'
 */
async function downloadViaApi(url, type = 'video') {
  if (!config.API_URL) {
    throw new Error('API_URL not set — cannot proxy download');
  }
  if (!config.API_SECRET) {
    throw new Error('API_SECRET not set — cannot authenticate with API');
  }

  const res = await fetch(`${config.API_URL}/api/download`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key':    config.API_SECRET,
    },
    body: JSON.stringify({ url, type }),
    timeout: 95_000,
  });

  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'API download failed');

  return {
    buffer:   Buffer.from(data.data.buffer, 'base64'),
    mimetype: data.data.mimetype,
    filename: data.data.filename,
  };
}

module.exports = { downloadViaApi };
