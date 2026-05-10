// ============================================================
//  APEX-MD · Session Generator
//
//  Run this ONCE on your local machine (or any machine):
//    node generate-session.js
//
//  1. It starts a minimal WhatsApp connection
//  2. Shows a QR code in the terminal
//  3. You scan it with WhatsApp → Linked Devices → Link Device
//  4. It prints your SESSION_ID string
//  5. Paste that string into Render as the SESSION_ID env var
//  6. Stop this script (Ctrl+C) — the real bot runs on Render
//
//  Requirements: node 18+, npm install already done
// ============================================================

'use strict';

require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const pino   = require('pino');
const qrcode = require('qrcode-terminal');
const fs     = require('fs');
const { encodeSession } = require('./lib/session');

const SESSION_DIR = './session';

console.log(`
╔══════════════════════════════════════════╗
║     ⚡  APEX-MD  Session Generator  ⚡    ║
║  Scan the QR below to get your          ║
║  SESSION_ID for Render deployment.      ║
╚══════════════════════════════════════════╝
`);

async function generate() {
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

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

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      console.log('\n📱 Scan this QR with WhatsApp → Linked Devices → Link Device:\n');
      qrcode.generate(qr, { small: true });
      console.log('\nWaiting for scan...\n');
    }

    if (connection === 'open') {
      console.log('\n✅ WhatsApp connected!\n');
      console.log('Generating SESSION_ID...\n');

      // Wait a moment for creds to fully write
      await new Promise(r => setTimeout(r, 2000));

      const sessionId = encodeSession(SESSION_DIR);
      if (!sessionId) {
        console.error('❌ Failed to encode session. Try again.');
        process.exit(1);
      }

      console.log('═'.repeat(60));
      console.log('YOUR SESSION_ID (copy everything between the lines):');
      console.log('═'.repeat(60));
      console.log(sessionId);
      console.log('═'.repeat(60));
      console.log('\n📋 Steps:');
      console.log('  1. Copy the SESSION_ID string above');
      console.log('  2. Go to Render → your apex-md-api service → Environment');
      console.log('  3. Add env var:  SESSION_ID = <paste here>');
      console.log('  4. Save → Redeploy');
      console.log('  5. You can now stop this script (Ctrl+C)\n');

      // Keep alive for 10s so user can copy
      setTimeout(() => process.exit(0), 10000);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('\n❌ Logged out. Delete ./session folder and run again.');
        process.exit(1);
      }
      console.log('\nReconnecting...');
      generate();
    }
  });
}

generate().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
