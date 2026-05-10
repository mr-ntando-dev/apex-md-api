// ============================================================
//  APEX-MD · REST API Layer
//  Exposes bot features over HTTP so external dashboards,
//  n8n flows, web panels, or scripts can drive the bot
//  without using WhatsApp commands directly.
//
//  Mount point:  /api  (see index.js)
//  Auth header:  X-API-Key: <API_SECRET> (set in .env)
//
//  All endpoints return JSON:
//    { ok: true,  data: ... }        on success
//    { ok: false, error: "message" } on failure
// ============================================================

'use strict';

const express = require('express');
const router  = express.Router();
const config  = require('../config');
const db      = require('../lib/database');
const logger  = require('../lib/logger');

// ── Lazy-loaded references set by mountApi() ─────────────────
let _sock = null;  // Baileys socket (set after bot connects)

/**
 * Call this from index.js once the socket is live:
 *   const { mountApi } = require('./api');
 *   mountApi(app, sock);
 */
function mountApi(app, sock) {
  _sock = sock;
  app.use('/api', router);
  logger.info('[API] REST API mounted at /api');
}

// ── Auth middleware ───────────────────────────────────────────
router.use((req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (!config.API_SECRET || key !== config.API_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized — invalid or missing X-API-Key' });
  }
  next();
});

// ── Helpers ───────────────────────────────────────────────────
function ok(res, data)         { res.json({ ok: true,  data }); }
function fail(res, msg, code)  { res.status(code || 400).json({ ok: false, error: msg }); }
function needSock(res) {
  if (!_sock) { fail(res, 'Bot socket not ready yet', 503); return true; }
  return false;
}
/** Normalize a phone number to JID format */
function toJid(num, type = 'user') {
  const n = String(num).replace(/[^0-9]/g, '');
  return type === 'group' ? `${n}@g.us` : `${n}@s.whatsapp.net`;
}

// ════════════════════════════════════════════════════════════
//  1. GET /api/status  — Bot health & uptime
// ════════════════════════════════════════════════════════════
router.get('/status', (req, res) => {
  const mem = process.memoryUsage();
  ok(res, {
    bot:     config.BOT_NAME,
    version: config.BOT_VERSION,
    uptime:  Math.floor(process.uptime()),
    memory:  {
      heapUsed:  Math.round(mem.heapUsed  / 1024 / 1024) + ' MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + ' MB',
    },
    online:  _sock !== null,
    mode:    config.PUBLIC_MODE ? 'public' : 'private',
    prefix:  config.BOT_PREFIX,
  });
});

// ════════════════════════════════════════════════════════════
//  2. POST /api/send  — Send any message to any JID
//
//  Body: { jid, text }   OR   { number, text }
//        { jid, image: "base64..." }
//        { jid, video: "base64..." }
//        { jid, audio: "base64..." }
//        { jid, document: "base64...", mimetype, filename }
//        { jid, sticker: "base64..." }
// ════════════════════════════════════════════════════════════
router.post('/send', async (req, res) => {
  if (needSock(res)) return;
  const { jid, number, text, image, video, audio, document, sticker, mimetype, filename, caption } = req.body;
  const target = jid || (number ? toJid(number) : null);
  if (!target) return fail(res, 'Provide jid or number');

  try {
    let content;
    if (text)     content = { text };
    else if (image)    content = { image:    Buffer.from(image,    'base64'), caption: caption || '' };
    else if (video)    content = { video:    Buffer.from(video,    'base64'), caption: caption || '' };
    else if (audio)    content = { audio:    Buffer.from(audio,    'base64'), mimetype: 'audio/mp4' };
    else if (sticker)  content = { sticker:  Buffer.from(sticker,  'base64') };
    else if (document) content = { document: Buffer.from(document, 'base64'), mimetype: mimetype || 'application/octet-stream', fileName: filename || 'file' };
    else return fail(res, 'Provide text, image, video, audio, sticker, or document');

    const result = await _sock.sendMessage(target, content);
    ok(res, { messageId: result?.key?.id });
  } catch (e) {
    logger.error('[API /send]', e.message);
    fail(res, e.message, 500);
  }
});

// ════════════════════════════════════════════════════════════
//  3. POST /api/auto-typing  — Toggle composing presence
//
//  Body: { jid, duration }   duration ms (default 3000)
// ════════════════════════════════════════════════════════════
router.post('/auto-typing', async (req, res) => {
  if (needSock(res)) return;
  const { jid, number, duration = 3000 } = req.body;
  const target = jid || (number ? toJid(number) : null);
  if (!target) return fail(res, 'Provide jid or number');
  try {
    await _sock.sendPresenceUpdate('composing', target);
    setTimeout(() => _sock.sendPresenceUpdate('paused', target).catch(() => {}), Number(duration));
    ok(res, { target, composing: true, durationMs: duration });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  4. POST /api/auto-recording  — Simulate audio recording
//
//  Body: { jid, duration }
// ════════════════════════════════════════════════════════════
router.post('/auto-recording', async (req, res) => {
  if (needSock(res)) return;
  const { jid, number, duration = 4000 } = req.body;
  const target = jid || (number ? toJid(number) : null);
  if (!target) return fail(res, 'Provide jid or number');
  try {
    await _sock.sendPresenceUpdate('recording', target);
    setTimeout(() => _sock.sendPresenceUpdate('paused', target).catch(() => {}), Number(duration));
    ok(res, { target, recording: true, durationMs: duration });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  5. POST /api/auto-read  — Mark messages as read
//
//  Body: { keys: [ { remoteJid, id, fromMe?, participant? } ] }
//   OR   { jid }  — reads all pending in that chat
// ════════════════════════════════════════════════════════════
router.post('/auto-read', async (req, res) => {
  if (needSock(res)) return;
  const { keys, jid, number } = req.body;
  try {
    if (keys && Array.isArray(keys)) {
      await _sock.readMessages(keys);
      ok(res, { read: keys.length });
    } else {
      const target = jid || (number ? toJid(number) : null);
      if (!target) return fail(res, 'Provide keys array or jid/number');
      // Mark last 10 messages as read (best-effort)
      const msgs = await _sock.fetchMessagesFromWA(target, 10).catch(() => []);
      if (msgs.length) await _sock.readMessages(msgs.map(m => m.key));
      ok(res, { read: msgs.length, target });
    }
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  6. POST /api/auto-seen-status  — View all status updates
// ════════════════════════════════════════════════════════════
router.post('/auto-seen-status', async (req, res) => {
  if (needSock(res)) return;
  try {
    const statuses = await _sock.fetchStatusUpdates?.() || [];
    for (const s of statuses) {
      await _sock.readMessages([s.key]).catch(() => {});
    }
    ok(res, { viewed: statuses.length });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  7. GET /api/menu  — Full bot command menu as JSON
// ════════════════════════════════════════════════════════════
router.get('/menu', (req, res) => {
  try {
    // handler.js exports the commands Map directly
    const { commands } = require('../lib/handler');
    const grouped  = {};
    for (const [name, cmd] of commands.entries()) {
      const cat = cmd.category || 'uncategorized';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push({
        name:    cmd.name,
        aliases: cmd.aliases || [],
        desc:    cmd.desc    || '',
        usage:   cmd.usage   || `.${cmd.name}`,
        public:  cmd.public  !== false,
      });
    }
    ok(res, { total: commands.size, categories: grouped });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  8. POST /api/broadcast  — Send message to multiple JIDs
//
//  Body: { targets: ["number"|"jid", ...], text, delay }
//        delay (ms) between sends to avoid rate-limit (default 1500)
// ════════════════════════════════════════════════════════════
router.post('/broadcast', async (req, res) => {
  if (needSock(res)) return;
  const { targets, text, image, delay = 1500 } = req.body;
  if (!targets || !Array.isArray(targets) || targets.length === 0)
    return fail(res, 'targets must be a non-empty array');
  if (!text && !image) return fail(res, 'Provide text or image');

  const results = [];
  for (const t of targets) {
    const jid     = t.includes('@') ? t : toJid(t);
    const content = image
      ? { image: Buffer.from(image, 'base64'), caption: text || '' }
      : { text };
    try {
      await _sock.sendMessage(jid, content);
      results.push({ jid, ok: true });
    } catch (e) {
      results.push({ jid, ok: false, error: e.message });
    }
    await new Promise(r => setTimeout(r, Number(delay)));
  }
  ok(res, { sent: results.filter(r => r.ok).length, total: targets.length, results });
});

// ════════════════════════════════════════════════════════════
//  9. POST /api/auto-reply  — Manage keyword auto-replies
//
//  GET    /api/auto-reply          — list all rules
//  POST   /api/auto-reply          — add rule { keyword, reply, exact? }
//  DELETE /api/auto-reply/:keyword — remove rule
// ════════════════════════════════════════════════════════════
router.get('/auto-reply', async (_req, res) => {
  const rules = await db.getAllAutoReplies?.() || [];
  ok(res, { count: rules.length, rules });
});

router.post('/auto-reply', async (req, res) => {
  const { keyword, reply, exact = false } = req.body;
  if (!keyword || !reply) return fail(res, 'Provide keyword and reply');
  await db.setAutoReply?.(keyword.toLowerCase(), { reply, exact });
  ok(res, { added: keyword });
});

router.delete('/auto-reply/:keyword', async (req, res) => {
  await db.deleteAutoReply?.(req.params.keyword.toLowerCase());
  ok(res, { removed: req.params.keyword });
});

// ════════════════════════════════════════════════════════════
//  10. POST /api/group/settings  — Update group settings
//
//  Body: { groupJid, antiLink?, antiBadWord?, antiSpam?,
//          welcome?, muted?, antiDelete? }
// ════════════════════════════════════════════════════════════
router.post('/group/settings', async (req, res) => {
  const { groupJid, ...settings } = req.body;
  if (!groupJid) return fail(res, 'Provide groupJid');
  await db.setGroup(groupJid, settings);
  ok(res, { groupJid, updated: settings });
});

router.get('/group/settings/:groupJid', async (req, res) => {
  const data = await db.getGroup(req.params.groupJid);
  ok(res, data);
});

// ════════════════════════════════════════════════════════════
//  11. POST /api/group/action  — Admin actions via API
//
//  Body: { groupJid, action: "kick"|"promote"|"demote", number }
// ════════════════════════════════════════════════════════════
router.post('/group/action', async (req, res) => {
  if (needSock(res)) return;
  const { groupJid, action, number } = req.body;
  if (!groupJid || !action || !number) return fail(res, 'groupJid, action, number required');
  const jid = toJid(number);
  try {
    if (action === 'kick')    await _sock.groupParticipantsUpdate(groupJid, [jid], 'remove');
    else if (action === 'promote') await _sock.groupParticipantsUpdate(groupJid, [jid], 'promote');
    else if (action === 'demote')  await _sock.groupParticipantsUpdate(groupJid, [jid], 'demote');
    else return fail(res, `Unknown action: ${action}. Use kick|promote|demote`);
    ok(res, { groupJid, action, target: jid });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  12. GET/POST/DELETE /api/users  — User management
// ════════════════════════════════════════════════════════════
router.get('/users/:number', async (req, res) => {
  const user = await db.getUser(toJid(req.params.number));
  ok(res, user);
});

router.patch('/users/:number', async (req, res) => {
  const jid  = toJid(req.params.number);
  const data = req.body; // banned, premium, xp, warnings, etc.
  await db.setUser(jid, data);
  ok(res, { jid, updated: data });
});

// ════════════════════════════════════════════════════════════
//  13. GET/POST/DELETE /api/schedule  — Cron scheduler
//
//  POST Body: { chatId, message, cronExpr }
//    e.g.  cronExpr: "0 9 * * *"  = every day at 09:00
// ════════════════════════════════════════════════════════════
router.get('/schedule', async (_req, res) => {
  const jobs = await db.getSchedules?.() || [];
  ok(res, { count: jobs.length, jobs });
});

router.post('/schedule', async (req, res) => {
  const { chatId, message, cronExpr } = req.body;
  if (!chatId || !message || !cronExpr) return fail(res, 'chatId, message, cronExpr required');
  const job = await db.addSchedule?.({ chatId, message, cronExpr, ownerId: 'api' });
  // Register live cron job if socket is available
  try {
    if (_sock) {
      const { scheduleMessage } = require('../lib/scheduler');
      scheduleMessage(_sock, job._id || job.id || Date.now().toString(), chatId, message, cronExpr);
    }
  } catch (_) { /* scheduler not available yet — job saved to DB, will load on next restart */ }
  ok(res, { created: job });
});

router.delete('/schedule/:id', async (req, res) => {
  await db.deleteSchedule?.(req.params.id);
  ok(res, { removed: req.params.id });
});

// ════════════════════════════════════════════════════════════
//  14. POST /api/bot/config  — Live config updates
//
//  Body: { key: "AUTO_TYPING"|"AUTO_READ"|"PUBLIC_MODE"|
//               "GUARDIAN_ENABLED"|"ANTI_LINK"|..., value }
//  Changes take effect immediately without restart.
// ════════════════════════════════════════════════════════════
const EDITABLE_KEYS = new Set([
  'AUTO_TYPING', 'AUTO_RECORDING', 'AUTO_READ', 'AUTO_STATUS',
  'PUBLIC_MODE', 'ANTI_LINK', 'ANTI_BAD_WORD', 'ANTI_SPAM',
  'GUARDIAN_ENABLED', 'GUARDIAN_SCAM_KICK', 'GUARDIAN_RAID_MUTE',
  'BURN_ENABLED', 'AI_ENABLED', 'AI_ROUTER', 'RATE_LIMIT',
  'DEFAULT_LANG', 'BOT_PREFIX', 'BOT_NAME',
]);

router.get('/bot/config', (_req, res) => {
  const snapshot = {};
  for (const k of EDITABLE_KEYS) snapshot[k] = config[k];
  ok(res, snapshot);
});

router.patch('/bot/config', (req, res) => {
  const updates = {};
  for (const [k, v] of Object.entries(req.body)) {
    if (!EDITABLE_KEYS.has(k)) continue;
    config[k] = v;
    updates[k] = v;
  }
  if (Object.keys(updates).length === 0)
    return fail(res, `No editable keys found. Editable: ${[...EDITABLE_KEYS].join(', ')}`);
  logger.info('[API] Config live-patched:', updates);
  ok(res, { patched: updates });
});

// ════════════════════════════════════════════════════════════
//  15. POST /api/bot/theme  — Change bot theme via API
//
//  Body: { theme: "naruto"|"gojo"|"apex"|... }
// ════════════════════════════════════════════════════════════
router.post('/bot/theme', (req, res) => {
  const { theme } = req.body;
  if (!theme) return fail(res, 'Provide theme name');
  try {
    const themes = require('../themes');
    if (!themes[theme]) return fail(res, `Unknown theme. Available: ${Object.keys(themes).join(', ')}`);
    config.CURRENT_THEME = theme;
    ok(res, { activeTheme: theme, data: themes[theme] });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  16. POST /api/auto-status-view  — Auto-view all statuses
//     (one-shot, not presence loop)
// ════════════════════════════════════════════════════════════
router.post('/auto-status-view', async (_req, res) => {
  if (needSock(res)) return;
  try {
    config.AUTO_STATUS = true;
    ok(res, { autoStatus: true, message: 'Bot will now auto-view all status updates' });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  17. POST /api/auto-presence  — Set bot's own online/offline
//
//  Body: { presence: "available"|"unavailable"|"composing"|"paused" }
// ════════════════════════════════════════════════════════════
router.post('/auto-presence', async (req, res) => {
  if (needSock(res)) return;
  const { presence = 'available' } = req.body;
  const allowed = ['available', 'unavailable', 'composing', 'paused', 'recording'];
  if (!allowed.includes(presence)) return fail(res, `presence must be one of: ${allowed.join(', ')}`);
  try {
    await _sock.sendPresenceUpdate(presence);
    ok(res, { presence });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  18. GET /api/chats  — List recent chats
// ════════════════════════════════════════════════════════════
router.get('/chats', async (_req, res) => {
  if (needSock(res)) return;
  try {
    const chats = await _sock.groupFetchAllParticipating?.() || {};
    const list  = Object.entries(chats).map(([id, c]) => ({
      id,
      subject: c.subject,
      participants: c.participants?.length || 0,
      creation:     c.creation,
    }));
    ok(res, { count: list.length, groups: list });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  19. POST /api/react  — Send a reaction to a message
//
//  Body: { jid, messageId, fromMe, emoji }
// ════════════════════════════════════════════════════════════
router.post('/react', async (req, res) => {
  if (needSock(res)) return;
  const { jid, number, messageId, fromMe = false, emoji } = req.body;
  const target = jid || (number ? toJid(number) : null);
  if (!target || !messageId || !emoji) return fail(res, 'jid/number, messageId, emoji required');
  try {
    await _sock.sendMessage(target, {
      react: { text: emoji, key: { remoteJid: target, id: messageId, fromMe } },
    });
    ok(res, { target, emoji, messageId });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  20. POST /api/delete-message  — Delete a sent message
//
//  Body: { jid, messageId, fromMe? }
// ════════════════════════════════════════════════════════════
router.post('/delete-message', async (req, res) => {
  if (needSock(res)) return;
  const { jid, number, messageId, fromMe = true } = req.body;
  const target = jid || (number ? toJid(number) : null);
  if (!target || !messageId) return fail(res, 'jid/number and messageId required');
  try {
    await _sock.sendMessage(target, {
      delete: { remoteJid: target, id: messageId, fromMe },
    });
    ok(res, { deleted: messageId });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  21. POST /api/pin-message  — Pin/unpin a message in chat
//
//  Body: { jid, messageId, pin: true|false, duration? }
//  duration: 86400 (1 day) | 604800 (7 days) | 2592000 (30 days)
// ════════════════════════════════════════════════════════════
router.post('/pin-message', async (req, res) => {
  if (needSock(res)) return;
  const { jid, number, messageId, pin = true, duration = 604800 } = req.body;
  const target = jid || (number ? toJid(number) : null);
  if (!target || !messageId) return fail(res, 'jid/number and messageId required');
  try {
    await _sock.sendMessage(target, {
      pin: { type: pin ? 1 : 2, time: Number(duration),
             key: { remoteJid: target, id: messageId } },
    });
    ok(res, { target, messageId, pinned: pin });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  22. POST /api/group/create  — Create a WhatsApp group
//
//  Body: { name, participants: ["number", ...] }
// ════════════════════════════════════════════════════════════
router.post('/group/create', async (req, res) => {
  if (needSock(res)) return;
  const { name, participants } = req.body;
  if (!name || !Array.isArray(participants) || participants.length === 0)
    return fail(res, 'name and participants[] required');
  try {
    const result = await _sock.groupCreate(name, participants.map(p => toJid(p)));
    ok(res, { groupId: result?.gid || result?.id, name });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  23. POST /api/group/invite-link  — Get group invite link
//
//  Body: { groupJid }
// ════════════════════════════════════════════════════════════
router.post('/group/invite-link', async (req, res) => {
  if (needSock(res)) return;
  const { groupJid } = req.body;
  if (!groupJid) return fail(res, 'groupJid required');
  try {
    const link = await _sock.groupInviteCode(groupJid);
    ok(res, { inviteLink: `https://chat.whatsapp.com/${link}` });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  24. POST /api/forward  — Forward a message to another chat
//
//  Body: { fromJid, toJid, messageId }
// ════════════════════════════════════════════════════════════
router.post('/forward', async (req, res) => {
  if (needSock(res)) return;
  const { fromJid, toJid, messageId, fromMe = false } = req.body;
  if (!fromJid || !toJid || !messageId) return fail(res, 'fromJid, toJid, messageId required');
  try {
    const msgs = await _sock.loadMessages(fromJid, 50).catch(() => []);
    const target = msgs.find(m => m.key.id === messageId);
    if (!target) return fail(res, 'Message not found in recent history');
    await _sock.forwardMessage(toJid, target, { forceForward: true });
    ok(res, { forwarded: messageId, to: toJid });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  25. POST /api/update-profile  — Update bot profile info
//
//  Body: { name?, status?, avatar: "base64..." }
// ════════════════════════════════════════════════════════════
router.post('/update-profile', async (req, res) => {
  if (needSock(res)) return;
  const { name, status, avatar } = req.body;
  const done = {};
  try {
    if (name)   { await _sock.updateProfileName(name);               done.name   = name;   }
    if (status) { await _sock.updateProfileStatus(status);           done.status = status; }
    if (avatar) { await _sock.updateProfilePicture(_sock.user.id,
                    Buffer.from(avatar, 'base64'));                   done.avatar = true;   }
    ok(res, { updated: done });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  26. POST /api/block-unblock  — Block / unblock a contact
//
//  Body: { number, action: "block"|"unblock" }
// ════════════════════════════════════════════════════════════
router.post('/block-unblock', async (req, res) => {
  if (needSock(res)) return;
  const { number, action } = req.body;
  if (!number || !action) return fail(res, 'number and action (block|unblock) required');
  const jid = toJid(number);
  try {
    await _sock.updateBlockStatus(jid, action === 'block' ? 'block' : 'unblock');
    ok(res, { jid, action });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  27. GET /api/plugins  — List installed plugins
//  DELETE /api/plugins/:name  — Remove a plugin
// ════════════════════════════════════════════════════════════
router.get('/plugins', (_req, res) => {
  try {
    const { getPluginList } = require('../lib/pluginLoader');
    ok(res, { plugins: getPluginList() });
  } catch (e) { fail(res, e.message, 500); }
});

router.delete('/plugins/:name', (req, res) => {
  try {
    const { uninstallPlugin } = require('../lib/pluginLoader');
    uninstallPlugin(req.params.name);
    ok(res, { removed: req.params.name });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  28. POST /api/ai  — Hit the triple AI engine via HTTP
//
//  Body: { prompt, userId?, engine?: "auto"|"openai"|"claude"|"gemini" }
// ════════════════════════════════════════════════════════════
router.post('/ai', async (req, res) => {
  const { prompt, userId = 'api_user', engine } = req.body;
  if (!prompt) return fail(res, 'prompt required');
  try {
    const { chat } = require('../lib/ai');
    const reply = await chat(prompt, userId, engine);
    ok(res, { reply });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  29. POST /api/auto-welcome  — Toggle welcome messages
//
//  Body: { groupJid, enabled, message? }
// ════════════════════════════════════════════════════════════
router.post('/auto-welcome', async (req, res) => {
  const { groupJid, enabled, message } = req.body;
  if (!groupJid) return fail(res, 'groupJid required');
  const patch = { welcome: Boolean(enabled) };
  if (message) patch.welcomeMsg = message;
  await db.setGroup(groupJid, patch);
  ok(res, { groupJid, welcome: patch.welcome, welcomeMsg: message || '(unchanged)' });
});

// ════════════════════════════════════════════════════════════
//  30. POST /api/mute-group  — Mute / unmute a group
//
//  Body: { groupJid, mute: true|false }
// ════════════════════════════════════════════════════════════
router.post('/mute-group', async (req, res) => {
  if (needSock(res)) return;
  const { groupJid, mute = true } = req.body;
  if (!groupJid) return fail(res, 'groupJid required');
  try {
    await _sock.groupSettingUpdate(groupJid, mute ? 'announcement' : 'not_announcement');
    await db.setGroup(groupJid, { muted: Boolean(mute) });
    ok(res, { groupJid, muted: mute });
  } catch (e) { fail(res, e.message, 500); }
});

// ════════════════════════════════════════════════════════════
//  Catch-all 404
// ════════════════════════════════════════════════════════════
router.use((req, res) => {
  res.status(404).json({ ok: false, error: `No route: ${req.method} ${req.path}` });
});

module.exports = { mountApi };
