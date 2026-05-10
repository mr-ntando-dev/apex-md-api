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
//  39. POST /api/download
// ════════════════════════════════════════════════════════════
router.post('/download', async (req, res) => {
  const { url, type } = req.body;
  if (!url) return fail(res, 'url required');
  try {
    const result = await dispatch('download', { url, type: type || 'video' }, 90_000);
    ok(res, result);
  } catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  ADMIN — Group management
// ════════════════════════════════════════════════════════════

// 40. POST /api/admin/warn  — warn a user (3-strike auto-kick)
router.post('/admin/warn', async (req, res) => {
  try { ok(res, await dispatch('admin/warn', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 41. POST /api/admin/resetwarn
router.post('/admin/resetwarn', async (req, res) => {
  try { ok(res, await dispatch('admin/resetwarn', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 42. GET /api/admin/warnings/:groupJid/:number
router.get('/admin/warnings/:groupJid/:number', async (req, res) => {
  try { ok(res, await dispatch('admin/warnings', { groupJid: req.params.groupJid, number: req.params.number })); }
  catch (e) { fail(res, e.message, 503); }
});

// 43. POST /api/admin/antidelete
router.post('/admin/antidelete', async (req, res) => {
  const { groupJid, enabled } = req.body;
  if (!groupJid) return fail(res, 'groupJid required');
  try {
    await db.setGroup(groupJid, { antiDelete: !!enabled });
    ok(res, { groupJid, antiDelete: !!enabled });
  } catch (e) { fail(res, e.message, 500); }
});

// 44. POST /api/admin/antilink
router.post('/admin/antilink', async (req, res) => {
  const { groupJid, enabled, action } = req.body;
  if (!groupJid) return fail(res, 'groupJid required');
  try {
    const update = {};
    if (typeof enabled !== 'undefined') update.antiLink = !!enabled;
    if (action) update.antiLinkAction = action;
    await db.setGroup(groupJid, update);
    ok(res, { groupJid, ...update });
  } catch (e) { fail(res, e.message, 500); }
});

// 45. POST /api/admin/antispam
router.post('/admin/antispam', async (req, res) => {
  const { groupJid, enabled } = req.body;
  if (!groupJid) return fail(res, 'groupJid required');
  try {
    await db.setGroup(groupJid, { antiSpam: !!enabled });
    ok(res, { groupJid, antiSpam: !!enabled });
  } catch (e) { fail(res, e.message, 500); }
});

// 46. POST /api/admin/tagall  — mention all group members
router.post('/admin/tagall', async (req, res) => {
  try { ok(res, await dispatch('admin/tagall', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 47. POST /api/admin/hidetag  — silent mention all
router.post('/admin/hidetag', async (req, res) => {
  try { ok(res, await dispatch('admin/hidetag', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 48. POST /api/admin/setdesc
router.post('/admin/setdesc', async (req, res) => {
  try { ok(res, await dispatch('admin/setdesc', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 49. POST /api/admin/setname
router.post('/admin/setname', async (req, res) => {
  try { ok(res, await dispatch('admin/setname', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 50. POST /api/admin/poll
router.post('/admin/poll', async (req, res) => {
  try { ok(res, await dispatch('admin/poll', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 51. POST /api/admin/filter  — group keyword auto-reply
router.post('/admin/filter', async (req, res) => {
  try { ok(res, await dispatch('admin/filter', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 52. GET /api/admin/groupinfo/:groupJid
router.get('/admin/groupinfo/:groupJid', async (req, res) => {
  try { ok(res, await dispatch('admin/groupinfo', { groupJid: req.params.groupJid })); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  PROTECTION
// ════════════════════════════════════════════════════════════

// 53. POST /api/protection/anticall
router.post('/protection/anticall', async (req, res) => {
  const { enabled } = req.body;
  try {
    await db.setGroup('global', { antiCall: !!enabled });
    ok(res, { antiCall: !!enabled });
  } catch (e) { fail(res, e.message, 500); }
});

// 54. POST /api/protection/antidemote
router.post('/protection/antidemote', async (req, res) => {
  const { groupJid, enabled } = req.body;
  if (!groupJid) return fail(res, 'groupJid required');
  try {
    await db.setGroup(groupJid, { antiDemote: !!enabled });
    ok(res, { groupJid, antiDemote: !!enabled });
  } catch (e) { fail(res, e.message, 500); }
});

// 55. POST /api/protection/antifake
router.post('/protection/antifake', async (req, res) => {
  const { groupJid, enabled, allowedCodes } = req.body;
  if (!groupJid) return fail(res, 'groupJid required');
  try {
    const update = { antiFake: !!enabled };
    if (allowedCodes) update.antiFakeAllowed = allowedCodes;
    await db.setGroup(groupJid, update);
    ok(res, { groupJid, ...update });
  } catch (e) { fail(res, e.message, 500); }
});

// 56. POST /api/protection/antigm
router.post('/protection/antigm', async (req, res) => {
  const { groupJid, enabled } = req.body;
  if (!groupJid) return fail(res, 'groupJid required');
  try {
    await db.setGroup(groupJid, { antiGm: !!enabled });
    ok(res, { groupJid, antiGm: !!enabled });
  } catch (e) { fail(res, e.message, 500); }
});

// 57. POST /api/protection/antivv
router.post('/protection/antivv', async (req, res) => {
  const { groupJid, enabled } = req.body;
  if (!groupJid) return fail(res, 'groupJid required');
  try {
    await db.setGroup(groupJid, { antiVV: !!enabled });
    ok(res, { groupJid, antiVV: !!enabled });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  OWNER
// ════════════════════════════════════════════════════════════

// 58. POST /api/owner/ban
router.post('/owner/ban', async (req, res) => {
  const { number } = req.body;
  if (!number) return fail(res, 'number required');
  try {
    const id = number + '@s.whatsapp.net';
    await db.setUser(id, { banned: true });
    ok(res, { banned: true, id });
  } catch (e) { fail(res, e.message, 500); }
});

// 59. POST /api/owner/unban
router.post('/owner/unban', async (req, res) => {
  const { number } = req.body;
  if (!number) return fail(res, 'number required');
  try {
    const id = number + '@s.whatsapp.net';
    await db.setUser(id, { banned: false });
    ok(res, { banned: false, id });
  } catch (e) { fail(res, e.message, 500); }
});

// 60. POST /api/owner/mode  — public/private
router.post('/owner/mode', async (req, res) => {
  try { ok(res, await dispatch('owner/mode', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 61. POST /api/owner/setprefix
router.post('/owner/setprefix', async (req, res) => {
  try { ok(res, await dispatch('owner/setprefix', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 62. POST /api/owner/restart
router.post('/owner/restart', async (req, res) => {
  try { ok(res, await dispatch('owner/restart', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  GAMES & ECONOMY  (read from DB directly — no socket needed)
// ════════════════════════════════════════════════════════════

// 63. GET /api/games/balance/:number
router.get('/games/balance/:number', async (req, res) => {
  try { ok(res, await dispatch('games/balance', { number: req.params.number })); }
  catch (e) { fail(res, e.message, 503); }
});

// 64. POST /api/games/daily  — claim daily coins
router.post('/games/daily', async (req, res) => {
  try { ok(res, await dispatch('games/daily', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 65. POST /api/games/work
router.post('/games/work', async (req, res) => {
  try { ok(res, await dispatch('games/work', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 66. POST /api/games/slots
router.post('/games/slots', async (req, res) => {
  try { ok(res, await dispatch('games/slots', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 67. POST /api/games/flip
router.post('/games/flip', async (req, res) => {
  try { ok(res, await dispatch('games/flip', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 68. POST /api/games/pay
router.post('/games/pay', async (req, res) => {
  try { ok(res, await dispatch('games/pay', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 69. POST /api/games/rob
router.post('/games/rob', async (req, res) => {
  try { ok(res, await dispatch('games/rob', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 70. GET /api/games/leaderboard
router.get('/games/leaderboard', async (_req, res) => {
  try { ok(res, await dispatch('games/leaderboard', {})); }
  catch (e) { fail(res, e.message, 503); }
});

// 71. GET /api/games/profile/:number
router.get('/games/profile/:number', async (req, res) => {
  try { ok(res, await dispatch('games/profile', { number: req.params.number })); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  FUN
// ════════════════════════════════════════════════════════════

// 72. GET /api/fun/joke
router.get('/fun/joke', async (_req, res) => {
  try { ok(res, await dispatch('fun/joke', {})); }
  catch (e) { fail(res, e.message, 503); }
});

// 73. GET /api/fun/meme
router.get('/fun/meme', async (_req, res) => {
  try { ok(res, await dispatch('fun/meme', {})); }
  catch (e) { fail(res, e.message, 503); }
});

// 74. GET /api/fun/fact
router.get('/fun/fact', async (_req, res) => {
  try { ok(res, await dispatch('fun/fact', {})); }
  catch (e) { fail(res, e.message, 503); }
});

// 75. GET /api/fun/quote
router.get('/fun/quote', async (_req, res) => {
  try { ok(res, await dispatch('fun/quote', {})); }
  catch (e) { fail(res, e.message, 503); }
});

// 76. POST /api/fun/8ball
router.post('/fun/8ball', async (req, res) => {
  try { ok(res, await dispatch('fun/8ball', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 77. POST /api/fun/ship
router.post('/fun/ship', async (req, res) => {
  try { ok(res, await dispatch('fun/ship', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 78. POST /api/fun/choose
router.post('/fun/choose', async (req, res) => {
  try { ok(res, await dispatch('fun/choose', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 79. GET /api/fun/truth
router.get('/fun/truth', async (_req, res) => {
  try { ok(res, await dispatch('fun/truth', {})); }
  catch (e) { fail(res, e.message, 503); }
});

// 80. POST /api/fun/horoscope
router.post('/fun/horoscope', async (req, res) => {
  try { ok(res, await dispatch('fun/horoscope', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 81. POST /api/fun/roll
router.post('/fun/roll', async (req, res) => {
  try { ok(res, await dispatch('fun/roll', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  UTILITY
// ════════════════════════════════════════════════════════════

// 82. POST /api/utility/translate
router.post('/utility/translate', async (req, res) => {
  try { ok(res, await dispatch('utility/translate', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 83. POST /api/utility/weather
router.post('/utility/weather', async (req, res) => {
  try { ok(res, await dispatch('utility/weather', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 84. POST /api/utility/wikipedia
router.post('/utility/wikipedia', async (req, res) => {
  try { ok(res, await dispatch('utility/wikipedia', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 85. POST /api/utility/qr  — generate QR code image (base64)
router.post('/utility/qr', async (req, res) => {
  try { ok(res, await dispatch('utility/qr', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 86. POST /api/utility/shazam
router.post('/utility/shazam', async (req, res) => {
  try { ok(res, await dispatch('utility/shazam', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 87. POST /api/utility/tts  — text to speech (returns audio buffer base64)
router.post('/utility/tts', async (req, res) => {
  try { ok(res, await dispatch('utility/tts', req.body), 30_000); }
  catch (e) { fail(res, e.message, 503); }
});

// 88. POST /api/utility/ascii
router.post('/utility/ascii', async (req, res) => {
  try { ok(res, await dispatch('utility/ascii', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 89. POST /api/utility/base64
router.post('/utility/base64', async (req, res) => {
  try { ok(res, await dispatch('utility/base64', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 90. POST /api/utility/calc
router.post('/utility/calc', async (req, res) => {
  try { ok(res, await dispatch('utility/calc', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// 91. POST /api/utility/virus  — URL virus scan
router.post('/utility/virus', async (req, res) => {
  try { ok(res, await dispatch('utility/virus', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  MEDIA
// ════════════════════════════════════════════════════════════

// 92. POST /api/media/sticker  — image/video → sticker (base64 in, base64 out)
router.post('/media/sticker', async (req, res) => {
  try { ok(res, await dispatch('media/sticker', req.body), 30_000); }
  catch (e) { fail(res, e.message, 503); }
});

// 93. POST /api/media/tts
router.post('/media/tts', async (req, res) => {
  try { ok(res, await dispatch('utility/tts', req.body), 30_000); }
  catch (e) { fail(res, e.message, 503); }
});

// 94. POST /api/media/toaudio  — video → audio strip
router.post('/media/toaudio', async (req, res) => {
  try { ok(res, await dispatch('media/toaudio', req.body), 60_000); }
  catch (e) { fail(res, e.message, 503); }
});

// 95. POST /api/media/toimg  — video → image thumbnail
router.post('/media/toimg', async (req, res) => {
  try { ok(res, await dispatch('media/toimg', req.body), 30_000); }
  catch (e) { fail(res, e.message, 503); }
});

// 96. POST /api/media/logo  — generate text logo image
router.post('/media/logo', async (req, res) => {
  try { ok(res, await dispatch('media/logo', req.body), 30_000); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  BUSINESS
// ════════════════════════════════════════════════════════════

// 97. POST /api/business/autorespond  — set/get auto-respond rules
router.post('/business/autorespond', async (req, res) => {
  const { keyword, reply, exact } = req.body;
  if (!keyword || !reply) return fail(res, 'keyword and reply required');
  try {
    const rule = await db.setAutoReply(keyword, { reply, exact });
    ok(res, rule);
  } catch (e) { fail(res, e.message, 500); }
});

// 98. GET /api/business/autorespond
router.get('/business/autorespond', async (_req, res) => {
  try { ok(res, await db.getAllAutoReplies()); }
  catch (e) { fail(res, e.message, 500); }
});

// 99. DELETE /api/business/autorespond/:keyword
router.delete('/business/autorespond/:keyword', async (req, res) => {
  try {
    await db.deleteAutoReply(req.params.keyword);
    ok(res, { deleted: req.params.keyword });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  ANIME
// ════════════════════════════════════════════════════════════

// 100. POST /api/anime/react  — send anime reaction GIF
router.post('/anime/react', async (req, res) => {
  try { ok(res, await dispatch('anime/react', req.body)); }
  catch (e) { fail(res, e.message, 503); }
});

// ════════════════════════════════════════════════════════════
//  CATCH-ALL
// ════════════════════════════════════════════════════════════
router.use((req, res) => {
  res.status(404).json({ ok: false, error: `No route: ${req.method} ${req.path}` });
});

module.exports = { mountApi };
