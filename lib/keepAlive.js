// ============================================================
//  APEX-MD · Keep-Alive Pinger  (lib/keepAlive.js)
//
//  Runs INSIDE THE BOT.
//  Pings the Render API every 14 minutes so Render's free
//  tier never goes to sleep (Render sleeps after 15m idle).
//
//  Requires env var:
//    API_URL=https://your-apex-api.onrender.com
//
//  Start it from index.js:
//    require('./lib/keepAlive')();
// ============================================================

'use strict';

const https  = require('https');
const http   = require('http');
const logger = require('./logger');

const PING_INTERVAL_MS = 14 * 60 * 1000; // 14 minutes

function ping(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, (res) => {
      res.resume(); // drain response
      resolve(res.statusCode);
    });
    req.on('error', (err) => {
      logger.warn(`[KeepAlive] Ping failed: ${err.message}`);
      resolve(0);
    });
    req.setTimeout(10_000, () => {
      req.destroy();
      resolve(0);
    });
  });
}

function startKeepAlive() {
  const apiUrl = process.env.API_URL;

  if (!apiUrl) {
    logger.warn('[KeepAlive] API_URL not set — Render keep-alive disabled');
    return;
  }

  const pingUrl = apiUrl.replace(/\/$/, '') + '/ping';
  logger.info(`[KeepAlive] Will ping ${pingUrl} every 14 min`);

  // Ping immediately on startup so we know it works
  ping(pingUrl).then(code => {
    logger.info(`[KeepAlive] First ping → HTTP ${code}`);
  });

  setInterval(async () => {
    const code = await ping(pingUrl);
    logger.info(`[KeepAlive] Ping → HTTP ${code}`);
  }, PING_INTERVAL_MS);
}

module.exports = startKeepAlive;
