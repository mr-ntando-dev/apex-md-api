// ============================================================
//  APEX-MD · Job Worker  (lib/jobWorker.js)
//
//  Runs INSIDE THE BOT (panel / VPS).
//  Polls MongoDB every second for pending jobs written by the
//  Render API, executes them using the live Baileys socket,
//  then writes the result back so the API can respond.
//
//  Start it from index.js once the socket is open:
//    const { startJobWorker } = require('./lib/jobWorker');
//    startJobWorker(sock);
// ============================================================

'use strict';

const db     = require('./database');
const logger = require('./logger');

// ── Helpers ───────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function toJid(num, group = false) {
  const n = String(num).replace(/[^0-9]/g, '');
  return group ? `${n}@g.us` : `${n}@s.whatsapp.net`;
}

function resolveJid(payload) {
  if (payload.jid)    return payload.jid;
  if (payload.number) return toJid(payload.number);
  return null;
}

// ════════════════════════════════════════════════════════════
//  JOB EXECUTOR
//  Maps every job type to the matching Baileys call.
//  Add new types here as you add new API endpoints.
// ════════════════════════════════════════════════════════════

async function executeJob(sock, job) {
  const { type, payload } = job;

  switch (type) {

    // ── Messaging ──────────────────────────────────────────

    case 'send': {
      const target = resolveJid(payload);
      if (!target) throw new Error('jid or number required');
      const { text, image, video, audio, document, sticker, caption, mimetype, filename } = payload;
      let content;
      if (text)      content = { text };
      else if (image)     content = { image:    Buffer.from(image,    'base64'), caption: caption || '' };
      else if (video)     content = { video:    Buffer.from(video,    'base64'), caption: caption || '' };
      else if (audio)     content = { audio:    Buffer.from(audio,    'base64'), mimetype: 'audio/mp4' };
      else if (sticker)   content = { sticker:  Buffer.from(sticker,  'base64') };
      else if (document)  content = { document: Buffer.from(document, 'base64'), mimetype: mimetype || 'application/octet-stream', fileName: filename || 'file' };
      else throw new Error('Provide text, image, video, audio, sticker, or document');
      const r = await sock.sendMessage(target, content);
      return { messageId: r?.key?.id };
    }

    case 'broadcast': {
      const { message } = payload;
      if (!message) throw new Error('message required');
      const chats = await sock.groupFetchAllParticipating().catch(() => ({}));
      let sent = 0;
      for (const id of Object.keys(chats)) {
        await sock.sendMessage(id, { text: message }).catch(() => {});
        sent++;
        await sleep(400); // throttle to avoid ban
      }
      return { sent };
    }

    case 'auto-typing': {
      const target   = resolveJid(payload);
      const duration = Number(payload.duration) || 3000;
      if (!target) throw new Error('jid or number required');
      await sock.sendPresenceUpdate('composing', target);
      setTimeout(() => sock.sendPresenceUpdate('paused', target).catch(() => {}), duration);
      return { target, composing: true, durationMs: duration };
    }

    case 'auto-recording': {
      const target   = resolveJid(payload);
      const duration = Number(payload.duration) || 4000;
      if (!target) throw new Error('jid or number required');
      await sock.sendPresenceUpdate('recording', target);
      setTimeout(() => sock.sendPresenceUpdate('paused', target).catch(() => {}), duration);
      return { target, recording: true, durationMs: duration };
    }

    case 'auto-read': {
      const { keys, jid, number } = payload;
      if (keys && Array.isArray(keys)) {
        await sock.readMessages(keys);
        return { read: keys.length };
      }
      const target = jid || (number ? toJid(number) : null);
      if (!target) throw new Error('keys[] or jid/number required');
      return { read: 0, target };
    }

    case 'auto-seen-status': {
      const statuses = await sock.fetchStatusUpdates?.().catch(() => []) || [];
      for (const s of statuses) {
        await sock.readMessages([s.key]).catch(() => {});
      }
      return { viewed: statuses.length };
    }

    case 'react': {
      const { jid, number, emoji, messageId, fromMe = false } = payload;
      const target = jid || (number ? toJid(number) : null);
      if (!target || !emoji || !messageId) throw new Error('jid/number, emoji, messageId required');
      await sock.sendMessage(target, {
        react: { text: emoji, key: { remoteJid: target, id: messageId, fromMe } },
      });
      return { target, emoji, messageId };
    }

    case 'delete-message': {
      const { jid, number, messageId, fromMe = true } = payload;
      const target = jid || (number ? toJid(number) : null);
      if (!target || !messageId) throw new Error('jid/number and messageId required');
      await sock.sendMessage(target, {
        delete: { remoteJid: target, id: messageId, fromMe },
      });
      return { deleted: messageId };
    }

    case 'pin-message': {
      const { jid, number, messageId, pin = true, duration = 604800 } = payload;
      const target = jid || (number ? toJid(number) : null);
      if (!target || !messageId) throw new Error('jid/number and messageId required');
      await sock.sendMessage(target, {
        pin: { type: pin ? 1 : 2, time: Number(duration), key: { remoteJid: target, id: messageId } },
      });
      return { target, messageId, pinned: pin };
    }

    case 'forward': {
      const { fromJid, toJid: dest, messageId, fromMe = false } = payload;
      if (!fromJid || !dest || !messageId) throw new Error('fromJid, toJid, messageId required');
      const msgs = await sock.loadMessages(fromJid, 50).catch(() => []);
      const target = msgs.find(m => m.key.id === messageId);
      if (!target) throw new Error('Message not found in recent history');
      await sock.forwardMessage(dest, target, { forceForward: true });
      return { forwarded: messageId, to: dest };
    }

    // ── Group Actions ───────────────────────────────────────

    case 'group/action': {
      const { groupJid, participants, action: act } = payload;
      const valid = ['add', 'remove', 'promote', 'demote'];
      if (!groupJid || !Array.isArray(participants) || !valid.includes(act))
        throw new Error('groupJid, participants[], action (add/remove/promote/demote) required');
      const jids = participants.map(p => toJid(p));
      await sock.groupParticipantsUpdate(groupJid, jids, act);
      return { groupJid, action: act, affected: jids.length };
    }

    case 'group/create': {
      const { name, participants } = payload;
      if (!name || !Array.isArray(participants) || !participants.length)
        throw new Error('name and participants[] required');
      const result = await sock.groupCreate(name, participants.map(p => toJid(p)));
      return { groupId: result?.gid || result?.id, name };
    }

    case 'group/invite-link': {
      const { groupJid } = payload;
      if (!groupJid) throw new Error('groupJid required');
      const link = await sock.groupInviteCode(groupJid);
      return { inviteLink: `https://chat.whatsapp.com/${link}` };
    }

    case 'mute-group': {
      const { groupJid, mute } = payload;
      if (!groupJid) throw new Error('groupJid required');
      await sock.groupSettingUpdate(groupJid, mute ? 'announcement' : 'not_announcement');
      await db.setGroup(groupJid, { muted: !!mute });
      return { groupJid, muted: !!mute };
    }

    case 'auto-welcome': {
      const { groupJid, enabled, welcomeMsg = '' } = payload;
      if (!groupJid) throw new Error('groupJid required');
      await db.setGroup(groupJid, { welcome: !!enabled, welcomeMsg });
      return { groupJid, welcome: !!enabled };
    }

    // ── Profile ─────────────────────────────────────────────

    case 'update-profile': {
      const { name, status, avatar } = payload;
      if (name)   await sock.updateProfileName(name).catch(() => {});
      if (status) await sock.updateProfileStatus(status).catch(() => {});
      if (avatar) {
        const buf = Buffer.from(avatar, 'base64');
        await sock.updateProfilePicture(sock.user.id, buf).catch(() => {});
      }
      return { updated: true };
    }

    case 'block-unblock': {
      const { number, action: act } = payload;
      if (!number) throw new Error('number required');
      const jid = toJid(number);
      await sock.updateBlockStatus(jid, act === 'block' ? 'block' : 'unblock');
      return { jid, action: act };
    }

    // ── Bot Config ──────────────────────────────────────────

    case 'bot/theme': {
      const { themeId } = payload;
      const themes = require('../themes');
      const theme  = themes[themeId];
      if (!theme) throw new Error(`Unknown theme: ${themeId}`);
      const config = require('../config');
      config.THEME_EMOJI = theme.emoji   || '⚡';
      config.DIVIDER     = theme.divider || '━━━━━━━━━━━━━━━━━━━━━━━━';
      config.BOT_NAME    = theme.name    || config.BOT_NAME;
      return { applied: themeId };
    }

    case 'auto-presence': {
      const { jid, number, presence } = payload;
      const target = jid || (number ? toJid(number) : null);
      if (!target || !presence) throw new Error('jid/number and presence required');
      await sock.sendPresenceUpdate(presence, target);
      return { target, presence };
    }

    // ── Liveness ping ───────────────────────────────────────
    case 'ping':
      return { pong: true, botTime: new Date().toISOString() };

    default:
      throw new Error(`Unknown job type: "${type}"`);
  }
}

// ════════════════════════════════════════════════════════════
//  WORKER LOOP
// ════════════════════════════════════════════════════════════

let _running = false;

async function startJobWorker(sock) {
  if (_running) return;
  _running = true;
  logger.info('[JobWorker] Started — polling for API jobs every 1s');

  while (_running) {
    try {
      const job = await db.claimNextJob();
      if (job) {
        logger.info(`[JobWorker] Executing job: ${job.type} (id=${job._id})`);
        try {
          const result = await executeJob(sock, job);
          await db.resolveJob(job._id, result);
          logger.info(`[JobWorker] Done: ${job.type} (id=${job._id})`);
        } catch (execErr) {
          logger.warn(`[JobWorker] Failed: ${job.type} — ${execErr.message}`);
          await db.failJob(job._id, execErr.message);
        }
      }
    } catch (pollErr) {
      logger.error('[JobWorker] Poll error:', pollErr.message);
    }
    await sleep(1000);
  }
}

function stopJobWorker() {
  _running = false;
  logger.info('[JobWorker] Stopped');
}

module.exports = { startJobWorker, stopJobWorker };
