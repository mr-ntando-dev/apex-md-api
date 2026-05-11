// ============================================================
//  APEX-MD  ·  Cobalt v11 Helper
//  Old cobalt v7 API (/api/json) was shut down Nov 2024.
//  v11 uses POST / with JSON body and Accept: application/json
//  Public instance: https://cobalt.tools (via api.cobalt.tools)
// ============================================================
'use strict';

const fetch = require('node-fetch');

const INSTANCES = [
  'https://cobalt.tools',
  'https://co.wuk.sh',
];

/**
 * Download a URL via cobalt v11.
 * Returns a Buffer of the media, or throws with a user-friendly message.
 */
async function cobaltDownload(url, options = {}) {
  let lastError;
  for (const instance of INSTANCES) {
    try {
      const res = await fetch(`${instance}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; APEX-MD/2.1)',
        },
        body: JSON.stringify({ url, ...options }),
      });

      const data = await res.json();

      if (data.status === 'error') {
        throw new Error(data.error?.code || 'Cobalt error');
      }

      // v11 returns { status: 'tunnel'|'redirect'|'picker', url, ... }
      if (data.status === 'tunnel' || data.status === 'redirect') {
        const mediaRes = await fetch(data.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; APEX-MD/2.1)' },
        });
        if (!mediaRes.ok) throw new Error(`Media fetch failed: ${mediaRes.status}`);
        return Buffer.from(await mediaRes.arrayBuffer());
      }

      if (data.status === 'picker') {
        // picker = multiple items (e.g. IG carousel), return first
        const first = data.picker?.[0];
        if (!first?.url) throw new Error('No media in picker');
        const mediaRes = await fetch(first.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; APEX-MD/2.1)' },
        });
        return Buffer.from(await mediaRes.arrayBuffer());
      }

      throw new Error(`Unexpected cobalt status: ${data.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('All cobalt instances failed');
}

module.exports = { cobaltDownload };
