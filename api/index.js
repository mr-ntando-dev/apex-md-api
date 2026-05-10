// ============================================================
//  APEX-MD · REST API Layer  (api/index.js)
//
//  ALL socket-dependent endpoints now go through the job queue.
//  The Render API never imports Baileys — it writes jobs to
//  MongoDB, the bot (on panel/VPS) picks them up and executes.
//
//  Read-only endpoints (status, menu, users, group settings,
//  schedules, auto-replies, config, plugins) query MongoDB
//  directly — no bot needed.
//
//  Mount point:  /api
//  Auth header:  X-API-Key: <API_SECRET>
// ============================================================

'use strict';

const express = require('express');
const router  = express.Router();
const config  = require('../config');
const db      = require('../lib/database');
const logger  = require('../lib/logger');

// ── mountApi is kept for backwards compatibility with index.js
// In the split architecture the API never receives a socket.
// The function is a no-op but we export it so the original
// index.js doesn't crash if it still calls mountApi().
function mountApi(app) {
  app.use('/api', router);
  logger.info('[API] REST API mounted at /api (job-queue mode — no socket needed)');
}

// ── Helpers ───────────────────────────────────────────────────
function ok(res, data)        { res.json({ ok: true,  data }); }
function fail(res, msg, code) { res.status(code || 400).json({ ok: false, error: msg }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Write a job to MongoDB and long-poll until the bot executes
 * it or the timeout expires.
 *
 * @param {string} type     - Job type string (maps to jobWorker switch)
 * @param {object} payload  - Raw request body / params
 * @param {number} timeout  - Max wait in ms (default 10 s)
 */
async function dispatch(type, payload, timeout = config.JOB_TIMEOUT_MS || 10_000) {
  const job      = await db.createJob(type, payload);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    await sleep(500);
    const updated = await db.getJob(job._id);
    if (!updated) throw new Error('Job disappeared — possible DB issue');
    if (updated.status === 'done')   return updated.result;
    if (updated.status === 'failed') throw new Error(updated.error || 'Job failed');
  }

  throw new Error('Bot did not respond in time. Is it online?');
}

// ── Auth middleware ───────────────────────────────────────────
router.use((req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (!config.API_SECRET || key !== config.API_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized — invalid or missing X-API-Key' });
  }
  next();
});

// ════════════════════════════════════════════════════════════
//  1. GET /api/status  — API + bot health
//     Read-only — no job needed.
// ════════════════════════════════════════════════════════════
router.get('/status', (req, res) => {
  const mem = process.memoryUsage();
  ok(res, {
    api:     config.BOT_NAME + ' API',
    version: config.BOT_VERSION,
    uptime:  Math.floor(process.uptime()),
    memory:  {
      heapUsed:  Math.round(mem.heapUsed  / 1024 / 1024) + ' MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + ' MB',
    },
    note:   'Bot socket runs on panel/VPS. Use /api/bot/ping to check bot liveness.',
  });
});

// ════════════════════════════════════════════════════════════
//  2. GET /api/bot/ping  — Check if bot is alive
//     Dispatches a lightweight no-op job. If it resolves,
//     the bot is online and the worker is running.
// ════════════════════════════════════════════════════════════
router.get('/bot/ping', async (req, res) => {
  try {
    // We repurpose the 'status' job type — add it to jobWorker
    // as a trivial ping. Falls back to a 5 s timeout check.
    const start = Date.now();
    await dispatch('ping', {}, 5000);
    ok(res, { botOnline: true, latencyMs: Date.now() - start });
  } catch {
    ok(res, { botOnline: false, note: 'Bot did not respond within 5 s' });
  }
});

// ════════════════════════════════════════════════════════════
//  3. GET /api/menu  — Full command catalogue (JSON)
//     Read-only — built from the commands directory.
// ════════════════════════════════════════════════════════════
router.get('/menu', (req, res) => {
  try {
    const { commands } = require('../lib/handler');

    const catEmoji = {
      admin:      '🛡️',
      ai:         '🤖',
      anime:      '🎭',
      business:   '💼',
      downloader: '📥',
      fun:        '💥',
      games:      '🎮',
      media:      '🎬',
      owner:      '👑',
      protection: '🔒',
      utility:    '🔧',
    };

    // Build grouped catalogue
    const catalogue = {};
    for (const [, cmd] of commands.entries()) {
      const cat = cmd.category || 'utility';
      if (!catalogue[cat]) {
        catalogue[cat] = {
          emoji:    catEmoji[cat] || '📌',
          category: cat,
          commands: [],
        };
      }
      catalogue[cat].commands.push({
        name:      cmd.name,
        aliases:   cmd.aliases   || [],
        desc:      cmd.desc      || '',
        usage:     cmd.usage     || `.${cmd.name}`,
        public:    cmd.public    ?? true,
        adminOnly: cmd.adminOnly ?? false,
        ownerOnly: cmd.ownerOnly ?? false,
        groupOnly: cmd.groupOnly ?? false,
      });
    }

    const total = [...commands.values()].length;

    ok(res, {
      bot:        config.BOT_NAME,
      version:    config.BOT_VERSION,
      service:    'apex-md-api',
      totalCmds:  total,
      categories: Object.values(catalogue),
    });
  } catch (e) {
    fail(res, e.message, 500);
  }
});

// ════════════════════════════════════════════════════════════
//  4. POST /api/send  — Send a message to any JID
// ════════════════════════════════════════════════════════════
router.post('/send', async (req, res) => {
  try { ok(res, await dispatch('send', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  5. POST /api/broadcast  — Send to all groups
// ════════════════════════════════════════════════════════════
router.post('/broadcast', async (req, res) => {
  const { message } = req.body;
  if (!message) return fail(res, 'message required');
  try { ok(res, await dispatch('broadcast', req.body, 30_000)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  6. POST /api/auto-typing
// ════════════════════════════════════════════════════════════
router.post('/auto-typing', async (req, res) => {
  try { ok(res, await dispatch('auto-typing', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  7. POST /api/auto-recording
// ════════════════════════════════════════════════════════════
router.post('/auto-recording', async (req, res) => {
  try { ok(res, await dispatch('auto-recording', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  8. POST /api/auto-read
// ════════════════════════════════════════════════════════════
router.post('/auto-read', async (req, res) => {
  try { ok(res, await dispatch('auto-read', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  9. POST /api/auto-seen-status
// ════════════════════════════════════════════════════════════
router.post('/auto-seen-status', async (req, res) => {
  try { ok(res, await dispatch('auto-seen-status', {})); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  10. POST /api/react
// ════════════════════════════════════════════════════════════
router.post('/react', async (req, res) => {
  try { ok(res, await dispatch('react', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  11. POST /api/delete-message
// ════════════════════════════════════════════════════════════
router.post('/delete-message', async (req, res) => {
  try { ok(res, await dispatch('delete-message', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  12. POST /api/pin-message
// ════════════════════════════════════════════════════════════
router.post('/pin-message', async (req, res) => {
  try { ok(res, await dispatch('pin-message', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  13. POST /api/forward
// ════════════════════════════════════════════════════════════
router.post('/forward', async (req, res) => {
  try { ok(res, await dispatch('forward', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  14. POST /api/group/action  — add/remove/promote/demote
// ════════════════════════════════════════════════════════════
router.post('/group/action', async (req, res) => {
  try { ok(res, await dispatch('group/action', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  15. POST /api/group/create
// ════════════════════════════════════════════════════════════
router.post('/group/create', async (req, res) => {
  try { ok(res, await dispatch('group/create', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  16. POST /api/group/invite-link
// ════════════════════════════════════════════════════════════
router.post('/group/invite-link', async (req, res) => {
  try { ok(res, await dispatch('group/invite-link', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  17. POST /api/mute-group
// ════════════════════════════════════════════════════════════
router.post('/mute-group', async (req, res) => {
  try { ok(res, await dispatch('mute-group', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  18. POST /api/auto-welcome
// ════════════════════════════════════════════════════════════
router.post('/auto-welcome', async (req, res) => {
  try { ok(res, await dispatch('auto-welcome', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  19. POST /api/update-profile
// ════════════════════════════════════════════════════════════
router.post('/update-profile', async (req, res) => {
  try { ok(res, await dispatch('update-profile', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  20. POST /api/block-unblock
// ════════════════════════════════════════════════════════════
router.post('/block-unblock', async (req, res) => {
  try { ok(res, await dispatch('block-unblock', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  21. POST /api/auto-presence
// ════════════════════════════════════════════════════════════
router.post('/auto-presence', async (req, res) => {
  try { ok(res, await dispatch('auto-presence', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  22. POST /api/bot/theme  — Switch bot personality
// ════════════════════════════════════════════════════════════
router.post('/bot/theme', async (req, res) => {
  const { themeId } = req.body;
  if (!themeId) return fail(res, 'themeId required');
  try { ok(res, await dispatch('bot/theme', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  READ-ONLY ENDPOINTS  (query MongoDB directly — no bot needed)
// ════════════════════════════════════════════════════════════

// ── 23. GET /api/group/settings/:groupJid ────────────────────
router.get('/group/settings/:groupJid', async (req, res) => {
  try {
    const data = await db.getGroup(req.params.groupJid);
    ok(res, data);
  } catch (e) { fail(res, e.message, 500); }
});

// ── 24. POST /api/group/settings  (write via DB, no socket) ──
router.post('/group/settings', async (req, res) => {
  const { groupJid, ...settings } = req.body;
  if (!groupJid) return fail(res, 'groupJid required');
  try {
    await db.setGroup(groupJid, settings);
    ok(res, { groupJid, updated: settings });
  } catch (e) { fail(res, e.message, 500); }
});

// ── 25. GET  /api/users/:number ──────────────────────────────
router.get('/users/:number', async (req, res) => {
  try {
    const id  = req.params.number + '@s.whatsapp.net';
    const user = await db.getUser(id);
    ok(res, user);
  } catch (e) { fail(res, e.message, 500); }
});

// ── 26. PATCH /api/users/:number ─────────────────────────────
router.patch('/users/:number', async (req, res) => {
  try {
    const id = req.params.number + '@s.whatsapp.net';
    await db.setUser(id, req.body);
    ok(res, { id, updated: req.body });
  } catch (e) { fail(res, e.message, 500); }
});

// ── 27. GET  /api/auto-reply ──────────────────────────────────
router.get('/auto-reply', async (_req, res) => {
  try { ok(res, await db.getAllAutoReplies()); }
  catch (e) { fail(res, e.message, 500); }
});

// ── 28. POST /api/auto-reply ──────────────────────────────────
router.post('/auto-reply', async (req, res) => {
  const { keyword, reply, exact } = req.body;
  if (!keyword || !reply) return fail(res, 'keyword and reply required');
  try {
    const rule = await db.setAutoReply(keyword, { reply, exact });
    ok(res, rule);
  } catch (e) { fail(res, e.message, 500); }
});

// ── 29. DELETE /api/auto-reply/:keyword ───────────────────────
router.delete('/auto-reply/:keyword', async (req, res) => {
  try {
    await db.deleteAutoReply(req.params.keyword);
    ok(res, { deleted: req.params.keyword });
  } catch (e) { fail(res, e.message, 500); }
});

// ── 30. GET  /api/schedule ───────────────────────────────────
router.get('/schedule', async (_req, res) => {
  try { ok(res, await db.getSchedules()); }
  catch (e) { fail(res, e.message, 500); }
});

// ── 31. POST /api/schedule ───────────────────────────────────
router.post('/schedule', async (req, res) => {
  const { chatId, message, cronExpr } = req.body;
  if (!chatId || !message || !cronExpr) return fail(res, 'chatId, message, cronExpr required');
  try {
    const doc = await db.addSchedule({ chatId, message, cronExpr, ownerId: 'api' });
    ok(res, doc);
  } catch (e) { fail(res, e.message, 500); }
});

// ── 32. DELETE /api/schedule/:id ─────────────────────────────
router.delete('/schedule/:id', async (req, res) => {
  try {
    await db.deleteSchedule(req.params.id);
    ok(res, { deleted: req.params.id });
  } catch (e) { fail(res, e.message, 500); }
});

// ── 33. GET  /api/bot/config ──────────────────────────────────
router.get('/bot/config', (_req, res) => {
  ok(res, {
    botName:      config.BOT_NAME,
    version:      config.BOT_VERSION,
    jobTimeoutMs: config.JOB_TIMEOUT_MS,
    note: 'Runtime bot config is managed in apex-md-bot. This API is stateless.',
  });
});

// ── 34. PATCH /api/bot/config  (runtime config overrides) ────
router.patch('/bot/config', (req, res) => {
  // Bot runtime config lives in apex-md-bot.
  // The API only exposes its own server-level settings here.
  const allowed = ['BOT_NAME', 'JOB_TIMEOUT_MS'];
  const updated = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      config[key] = req.body[key];
      updated[key] = req.body[key];
    }
  }
  ok(res, { updated });
});

// ── 35. POST /api/ai  — Proxied through bot job queue ────────
// AI engine lives in the bot — we dispatch a job for it.
router.post('/ai', async (req, res) => {
  const { message, userId = 'api-user' } = req.body;
  if (!message) return fail(res, 'message required');
  try {
    const reply = await dispatch('ai', { message, userId });
    ok(res, { reply });
  } catch (e) { fail(res, e.message, 503); }
});

// ── 36. GET  /api/plugins ─────────────────────────────────────
// Plugin list is managed in the bot. We proxy via job queue.
router.get('/plugins', async (_req, res) => {
  try { ok(res, await dispatch('plugins-list', {})); }
  catch (e) { fail(res, e.message, 503); }
});

// ── 37. DELETE /api/plugins/:name ────────────────────────────
router.delete('/plugins/:name', async (req, res) => {
  try { ok(res, await dispatch('plugins-unload', { name: req.params.name })); }
  catch (e) { fail(res, e.message, 503); }
});

// ── 38. GET  /api/chats  — Read from DB (no socket needed) ───
router.get('/chats', async (_req, res) => {
  try {
    // Return groups from DB — real-time chat list needs the socket;
    // for now we return known groups stored in MongoDB.
    const groups = await db.models.Group.find().lean().catch(() => []);
    ok(res, { groups, note: 'Live chat list requires bot to be online' });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  CATCH-ALL
// ════════════════════════════════════════════════════════════
router.use((req, res) => {
  res.status(404).json({ ok: false, error: `No route: ${req.method} ${req.path}` });
});

module.exports = { mountApi };
