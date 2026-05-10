// ============================================================
//  APEX-MD · Web Pairing Route
//  Mounted at /pair  (no auth needed — public page)
//
//  Flow:
//    1. GET  /pair          → shows the pairing HTML page
//    2. POST /pair/request  → generates pairing code for number
//    3. GET  /pair/status   → polling — returns session once paired
// ============================================================

'use strict';

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const pino     = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const { encodeSession } = require('../lib/session');

// ── State ─────────────────────────────────────────────────────
let pairState = {
  status:    'idle',      // idle | waiting | paired | error
  code:      null,
  sessionId: null,
  error:     null,
  sock:      null,
};

function resetState() {
  if (pairState.sock) {
    try { pairState.sock.end(); } catch (_) {}
  }
  pairState = { status: 'idle', code: null, sessionId: null, error: null, sock: null };
}

// ── GET /pair — HTML pairing page ────────────────────────────
router.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>APEX-MD · Pair Your Bot</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a0a0a;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: #141414;
      border: 1px solid #2a2a2a;
      border-radius: 16px;
      padding: 40px;
      width: 100%;
      max-width: 480px;
      text-align: center;
    }
    .logo { font-size: 2.5rem; margin-bottom: 8px; }
    h1 { font-size: 1.4rem; font-weight: 700; color: #fff; margin-bottom: 6px; }
    .sub { font-size: 0.9rem; color: #666; margin-bottom: 32px; }
    .step {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
      text-align: left;
    }
    .step-label { font-size: 0.75rem; color: #555; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
    input {
      width: 100%;
      background: #0f0f0f;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 12px 16px;
      color: #fff;
      font-size: 1rem;
      outline: none;
      transition: border 0.2s;
    }
    input:focus { border-color: #25D366; }
    input::placeholder { color: #444; }
    button {
      width: 100%;
      background: #25D366;
      color: #000;
      border: none;
      border-radius: 8px;
      padding: 14px;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      margin-top: 16px;
      transition: background 0.2s;
    }
    button:hover { background: #1db954; }
    button:disabled { background: #333; color: #666; cursor: not-allowed; }
    .code-box {
      display: none;
      background: #0f0f0f;
      border: 2px solid #25D366;
      border-radius: 12px;
      padding: 24px;
      margin-top: 20px;
    }
    .code-box .label { font-size: 0.8rem; color: #25D366; margin-bottom: 8px; }
    .code-box .code {
      font-size: 2.5rem;
      font-weight: 900;
      letter-spacing: 8px;
      color: #fff;
      font-family: monospace;
    }
    .code-box .hint { font-size: 0.8rem; color: #555; margin-top: 10px; }
    .session-box {
      display: none;
      background: #0a1a0f;
      border: 2px solid #25D366;
      border-radius: 12px;
      padding: 20px;
      margin-top: 20px;
      text-align: left;
    }
    .session-box .s-label { font-size: 0.8rem; color: #25D366; margin-bottom: 8px; font-weight: 700; }
    textarea {
      width: 100%;
      background: #0f0f0f;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 10px;
      color: #aaa;
      font-size: 0.7rem;
      font-family: monospace;
      resize: none;
      height: 80px;
      outline: none;
    }
    .copy-btn {
      background: #25D366;
      color: #000;
      border: none;
      border-radius: 6px;
      padding: 10px 20px;
      font-weight: 700;
      cursor: pointer;
      margin-top: 10px;
      width: 100%;
    }
    .status { font-size: 0.85rem; color: #666; margin-top: 16px; min-height: 20px; }
    .status.green { color: #25D366; }
    .status.red   { color: #ff4444; }
    .instructions { font-size: 0.82rem; color: #555; line-height: 1.7; margin-top: 20px; text-align: left; }
    .instructions b { color: #aaa; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">⚡</div>
    <h1>APEX-MD Pairing</h1>
    <p class="sub">Get your SESSION_ID in 30 seconds</p>

    <div class="step">
      <div class="step-label">Step 1 — Enter your WhatsApp number</div>
      <input id="number" type="tel" placeholder="2348012345678 (no + sign)" maxlength="20"/>
    </div>

    <button id="pairBtn" onclick="requestCode()">Get Pairing Code</button>

    <div class="code-box" id="codeBox">
      <div class="label">YOUR PAIRING CODE</div>
      <div class="code" id="codeText">----</div>
      <div class="hint">WhatsApp → Linked Devices → Link a Device → "Link with phone number instead"</div>
    </div>

    <div class="session-box" id="sessionBox">
      <div class="s-label">✅ PAIRED! Your SESSION_ID:</div>
      <textarea id="sessionText" readonly></textarea>
      <button class="copy-btn" onclick="copySession()">📋 Copy SESSION_ID</button>
      <div style="font-size:0.78rem;color:#555;margin-top:10px;">
        Paste this into Render → Environment → SESSION_ID → Save → Redeploy
      </div>
    </div>

    <div class="status" id="statusMsg"></div>

    <div class="instructions">
      <b>How to use SESSION_ID on Render:</b><br>
      1. Copy the SESSION_ID above<br>
      2. Render dashboard → apex-md-api → <b>Environment</b><br>
      3. Find <b>SESSION_ID</b> → paste → <b>Save Changes</b><br>
      4. Service auto-redeploys → bot goes live
    </div>
  </div>

  <script>
    let polling = null;

    function setStatus(msg, color) {
      const el = document.getElementById('statusMsg');
      el.textContent = msg;
      el.className = 'status ' + (color || '');
    }

    async function requestCode() {
      const number = document.getElementById('number').value.replace(/[^0-9]/g, '');
      if (!number || number.length < 10) {
        setStatus('Enter a valid number', 'red'); return;
      }
      document.getElementById('pairBtn').disabled = true;
      setStatus('Requesting pairing code...');
      try {
        const res  = await fetch('/pair/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ number }),
        });
        const data = await res.json();
        if (!data.ok) {
          setStatus(data.error || 'Failed', 'red');
          document.getElementById('pairBtn').disabled = false;
          return;
        }
        document.getElementById('codeText').textContent = data.code;
        document.getElementById('codeBox').style.display = 'block';
        setStatus('Waiting for you to enter the code on your phone...', 'green');
        startPolling();
      } catch (e) {
        setStatus('Network error: ' + e.message, 'red');
        document.getElementById('pairBtn').disabled = false;
      }
    }

    function startPolling() {
      polling = setInterval(async () => {
        try {
          const res  = await fetch('/pair/status');
          const data = await res.json();
          if (data.status === 'paired' && data.sessionId) {
            clearInterval(polling);
            document.getElementById('sessionText').value = data.sessionId;
            document.getElementById('sessionBox').style.display = 'block';
            document.getElementById('codeBox').style.display = 'none';
            setStatus('✅ Bot paired successfully!', 'green');
          } else if (data.status === 'error') {
            clearInterval(polling);
            setStatus('Error: ' + data.error, 'red');
            document.getElementById('pairBtn').disabled = false;
          }
        } catch (_) {}
      }, 2000);
    }

    function copySession() {
      const text = document.getElementById('sessionText').value;
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.querySelector('.copy-btn');
        btn.textContent = '✅ Copied!';
        setTimeout(() => btn.textContent = '📋 Copy SESSION_ID', 2000);
      });
    }
  </script>
</body>
</html>`);
});

// ── POST /pair/request — generate pairing code ───────────────
router.post('/request', async (req, res) => {
  const { number } = req.body;
  if (!number) return res.json({ ok: false, error: 'number required' });

  resetState();
  pairState.status = 'waiting';

  const SESSION_DIR = `/tmp/apex-pair-${Date.now()}`;
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['APEX-MD', 'Chrome', '120.0.0'],
    });

    pairState.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    // Wait for socket to be ready then request pairing code
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Socket timeout')), 15000);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if ((qr || connection) && !sock.authState.creds.registered) {
          clearTimeout(timeout);
          try {
            await new Promise(r => setTimeout(r, 2000));
            const clean = number.replace(/[^0-9]/g, '');
            const code  = await sock.requestPairingCode(clean);
            const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
            pairState.code = formatted;
            resolve(formatted);
          } catch (err) {
            reject(err);
          }
        }

        if (connection === 'open') {
          pairState.status = 'paired';
          await new Promise(r => setTimeout(r, 2000));
          pairState.sessionId = encodeSession(SESSION_DIR);
          // cleanup
          try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (_) {}
        }

        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (pairState.status !== 'paired') {
            pairState.status = 'error';
            pairState.error  = `Disconnected (${code})`;
          }
        }
      });
    });

    res.json({ ok: true, code: pairState.code });
  } catch (err) {
    pairState.status = 'error';
    pairState.error  = err.message;
    try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (_) {}
    res.json({ ok: false, error: err.message });
  }
});

// ── GET /pair/status — poll for session ──────────────────────
router.get('/status', (_req, res) => {
  res.json({
    status:    pairState.status,
    sessionId: pairState.sessionId,
    error:     pairState.error,
  });
});

module.exports = router;
