// ============================================================
//  APEX-MD · Pairing Code Session Generator
//
//  Simpler than QR — no need to scan anything.
//
//  HOW TO USE:
//    node pair.js
//
//  1. Enter your WhatsApp number when prompted
//  2. WhatsApp sends you an 8-digit pairing code
//  3. On your phone: WhatsApp → Linked Devices → Link a Device
//     → "Link with phone number instead" → enter the code
//  4. Script prints your SESSION_ID
//  5. Paste SESSION_ID into Render env vars → redeploy
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

const pino     = require('pino');
const fs       = require('fs');
const readline = require('readline');
const { encodeSession } = require('./lib/session');

const SESSION_DIR = './session-pair';

// ── Prompt helper ─────────────────────────────────────────────
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

console.log(`
╔══════════════════════════════════════════╗
║   ⚡  APEX-MD  Pairing Code Generator ⚡  ║
║  No QR scan needed — just a code        ║
╚══════════════════════════════════════════╝
`);

async function pair() {
  // Clean previous attempt
  if (fs.existsSync(SESSION_DIR)) fs.rmSync(SESSION_DIR, { recursive: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  const number = await ask('📱 Enter your WhatsApp number (with country code, no +)\n   Example: 2348012345678\n   Your number: ');

  if (!number || number.length < 10) {
    console.log('❌ Invalid number. Try again.');
    process.exit(1);
  }

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
    // Required for pairing code flow
    mobile: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Request pairing code after socket is ready
  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    // As soon as socket is open to WA servers, request pairing code
    if (qr || connection === 'connecting') {
      if (!sock.authState.creds.registered) {
        await new Promise(r => setTimeout(r, 3000)); // let socket stabilise
        try {
          const code = await sock.requestPairingCode(number);
          const formatted = code.match(/.{1,4}/g)?.join('-') || code;
          console.log('\n' + '═'.repeat(50));
          console.log(`🔑 YOUR PAIRING CODE:   ${formatted}`);
          console.log('═'.repeat(50));
          console.log('\n📱 Steps on your phone:');
          console.log('   WhatsApp → ⋮ Menu → Linked Devices');
          console.log('   → Link a Device');
          console.log('   → "Link with phone number instead"');
          console.log(`   → Enter code: ${formatted}`);
          console.log('\nWaiting for you to enter the code...\n');
        } catch (err) {
          console.error('❌ Failed to get pairing code:', err.message);
          console.log('Make sure your number is correct and try again.');
          process.exit(1);
        }
      }
    }

    if (connection === 'open') {
      console.log('\n✅ Paired successfully!\n');
      console.log('Generating SESSION_ID...');

      await new Promise(r => setTimeout(r, 3000));

      const sessionId = encodeSession(SESSION_DIR);
      if (!sessionId) {
        console.error('❌ Failed to encode session.');
        process.exit(1);
      }

      console.log('\n' + '═'.repeat(60));
      console.log('YOUR SESSION_ID — copy everything on the next line:');
      console.log('═'.repeat(60));
      console.log(sessionId);
      console.log('═'.repeat(60));
      console.log('\n📋 Next steps:');
      console.log('  1. Copy the SESSION_ID string above (the long one)');
      console.log('  2. Go to Render → apex-md-api → Environment');
      console.log('  3. Set  SESSION_ID = <paste>');
      console.log('  4. Save → service will redeploy automatically');
      console.log('  5. Visit https://your-app.onrender.com/ping to confirm\n');

      // Cleanup temp session folder
      setTimeout(() => {
        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        process.exit(0);
      }, 5000);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('\n❌ Rejected or timed out. Run node pair.js again.');
        process.exit(1);
      }
    }
  });
}

pair().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
