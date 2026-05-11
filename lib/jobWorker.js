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

    // ── Download proxy ──────────────────────────────────────
    // The Render API routes download requests HERE so the bot's
    // IP (panel/VPS) does the download — not Render's IP, which
    // gets blocked by TikTok/IG/YouTube much faster.
    case 'download': {
      const { cobaltDownload } = require('./cobalt');
      const ytdl               = require('@distube/ytdl-core');
      const ytSearch           = require('yt-search');
      const { url, type }      = payload;
      if (!url) throw new Error('url required');

      let buffer, mimetype, filename;

      const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');

      if (isYouTube) {
        // YouTube: use ytdl
        let target = ytdl.validateURL(url) ? url : (await ytSearch(url)).videos[0]?.url;
        if (!target) throw new Error('YouTube video not found');
        const info     = await ytdl.getInfo(target);
        const title    = info.videoDetails.title.replace(/[^a-z0-9 ]/gi, '').trim();
        const duration = parseInt(info.videoDetails.lengthSeconds);
        if (type === 'audio') {
          if (duration > 600) throw new Error('Track too long (max 10 min)');
          const chunks = [];
          await new Promise((res, rej) => {
            const s = ytdl(target, { filter: 'audioonly', quality: 'highestaudio' });
            s.on('data', c => chunks.push(c));
            s.on('end', res);
            s.on('error', rej);
          });
          buffer   = Buffer.concat(chunks);
          mimetype = 'audio/mpeg';
          filename = `${title}.mp3`;
        } else {
          if (duration > 300) throw new Error('Video too long (max 5 min)');
          const chunks = [];
          await new Promise((res, rej) => {
            const s = ytdl(target, { filter: 'videoandaudio', quality: 'lowest' });
            s.on('data', c => chunks.push(c));
            s.on('end', res);
            s.on('error', rej);
          });
          buffer   = Buffer.concat(chunks);
          mimetype = 'video/mp4';
          filename = `${title}.mp4`;
        }
      } else {
        // Everything else: cobalt v11 (TikTok, IG, FB, Twitter, etc.)
        const opts = type === 'audio' ? { downloadMode: 'audio' } : {};
        buffer   = await cobaltDownload(url, opts);
        mimetype = type === 'audio' ? 'audio/mpeg' : 'video/mp4';
        filename = type === 'audio' ? 'audio.mp3' : 'video.mp4';
      }

      return {
        buffer:   buffer.toString('base64'),
        mimetype,
        filename,
        size:     buffer.length,
      };
    }

    // ── Admin ────────────────────────────────────────────────

    case 'admin/warn': {
      const { groupJid, number, reason = 'No reason given' } = payload;
      if (!groupJid || !number) throw new Error('groupJid and number required');
      const jid       = toJid(number);
      const groupData = await db.getGroup(groupJid);
      const warnMap   = groupData.warnCount || {};
      const count     = (warnMap[jid] || 0) + 1;
      warnMap[jid]    = count;
      await db.setGroup(groupJid, { warnCount: warnMap });
      if (count >= 3) {
        await sock.groupParticipantsUpdate(groupJid, [jid], 'remove').catch(() => {});
        return { jid, warnings: count, action: 'kicked', reason };
      }
      await sock.sendMessage(groupJid, { text: `⚠️ @${number} has been warned (${count}/3).\nReason: ${reason}`, mentions: [jid] });
      return { jid, warnings: count, action: 'warned', reason };
    }

    case 'admin/resetwarn': {
      const { groupJid, number } = payload;
      if (!groupJid || !number) throw new Error('groupJid and number required');
      const jid       = toJid(number);
      const groupData = await db.getGroup(groupJid);
      const warnMap   = groupData.warnCount || {};
      delete warnMap[jid];
      await db.setGroup(groupJid, { warnCount: warnMap });
      return { jid, warnings: 0, reset: true };
    }

    case 'admin/warnings': {
      const { groupJid, number } = payload;
      if (!groupJid || !number) throw new Error('groupJid and number required');
      const jid       = toJid(number);
      const groupData = await db.getGroup(groupJid);
      const warnMap   = groupData.warnCount || {};
      return { jid, warnings: warnMap[jid] || 0 };
    }

    case 'admin/tagall': {
      const { groupJid, message = '' } = payload;
      if (!groupJid) throw new Error('groupJid required');
      const meta     = await sock.groupMetadata(groupJid);
      const mentions = meta.participants.map(p => p.id);
      const text     = message || mentions.map(j => `@${j.split('@')[0]}`).join(' ');
      await sock.sendMessage(groupJid, { text, mentions });
      return { groupJid, tagged: mentions.length };
    }

    case 'admin/hidetag': {
      const { groupJid, message = '\u200e' } = payload;
      if (!groupJid) throw new Error('groupJid required');
      const meta     = await sock.groupMetadata(groupJid);
      const mentions = meta.participants.map(p => p.id);
      await sock.sendMessage(groupJid, { text: message, mentions });
      return { groupJid, notified: mentions.length };
    }

    case 'admin/setdesc': {
      const { groupJid, description } = payload;
      if (!groupJid || !description) throw new Error('groupJid and description required');
      await sock.groupUpdateDescription(groupJid, description);
      return { groupJid, description };
    }

    case 'admin/setname': {
      const { groupJid, name } = payload;
      if (!groupJid || !name) throw new Error('groupJid and name required');
      await sock.groupUpdateSubject(groupJid, name);
      return { groupJid, name };
    }

    case 'admin/poll': {
      const { groupJid, question, options } = payload;
      if (!groupJid || !question || !Array.isArray(options) || options.length < 2)
        throw new Error('groupJid, question, and options[] (min 2) required');
      await sock.sendMessage(groupJid, {
        poll: { name: question, values: options, selectableCount: 1 },
      });
      return { groupJid, question, options };
    }

    case 'admin/filter': {
      const { action, groupJid, keyword, reply } = payload;
      if (action === 'set') {
        if (!groupJid || !keyword || !reply) throw new Error('groupJid, keyword, reply required');
        await db.setAutoReply(`${groupJid}:${keyword}`, { reply, exact: false });
        return { set: true, groupJid, keyword };
      }
      if (action === 'del') {
        if (!groupJid || !keyword) throw new Error('groupJid and keyword required');
        await db.deleteAutoReply(`${groupJid}:${keyword}`);
        return { deleted: true, groupJid, keyword };
      }
      const all   = await db.getAllAutoReplies();
      const group = all.filter(r => r.keyword.startsWith(`${groupJid}:`));
      return { filters: group.map(r => ({ keyword: r.keyword.split(':')[1], reply: r.reply })) };
    }

    case 'admin/groupinfo': {
      const { groupJid } = payload;
      if (!groupJid) throw new Error('groupJid required');
      const meta   = await sock.groupMetadata(groupJid);
      const admins = meta.participants.filter(p => p.admin).map(p => p.id);
      return {
        id:          meta.id,
        subject:     meta.subject,
        description: meta.desc,
        members:     meta.participants.length,
        admins:      admins.length,
        adminList:   admins,
        owner:       meta.owner,
        creation:    meta.creation,
      };
    }

    // ── Owner ────────────────────────────────────────────────

    case 'owner/mode': {
      const { mode } = payload;
      if (!['public', 'private'].includes(mode)) throw new Error('mode must be "public" or "private"');
      const config = require('../config');
      config.PUBLIC_MODE = mode === 'public';
      return { mode, publicMode: config.PUBLIC_MODE };
    }

    case 'owner/setprefix': {
      const { prefix } = payload;
      if (!prefix || prefix.length > 3) throw new Error('prefix required (max 3 chars)');
      const config = require('../config');
      config.BOT_PREFIX = prefix;
      return { prefix };
    }

    case 'owner/restart': {
      setTimeout(() => process.exit(0), 1000);
      return { restarting: true };
    }

    // ── Games / Economy ──────────────────────────────────────

    case 'games/balance': {
      const eco  = require('./economy');
      const { number } = payload;
      if (!number) throw new Error('number required');
      const id = toJid(number);
      const u  = eco.getUser(id);
      return { id, coins: u.coins, bank: u.bank, level: u.level, xp: u.xp };
    }

    case 'games/daily': {
      const eco  = require('./economy');
      const { number } = payload;
      if (!number) throw new Error('number required');
      const id   = toJid(number);
      const u    = eco.getUser(id);
      const now  = Date.now();
      const cd   = 86_400_000;
      if (now - u.lastDaily < cd) {
        const wait = Math.ceil((cd - (now - u.lastDaily)) / 3_600_000);
        throw new Error(`Daily already claimed. Wait ${wait}h.`);
      }
      const reward = 500 + Math.floor(Math.random() * 500);
      u.coins     += reward;
      u.lastDaily  = now;
      eco.saveUser(id, u);
      return { id, reward, coins: u.coins };
    }

    case 'games/work': {
      const eco  = require('./economy');
      const { number } = payload;
      if (!number) throw new Error('number required');
      const id   = toJid(number);
      const u    = eco.getUser(id);
      const now  = Date.now();
      const cd   = 3_600_000;
      if (now - u.lastWork < cd) {
        const wait = Math.ceil((cd - (now - u.lastWork)) / 60_000);
        throw new Error(`Work cooldown active. Wait ${wait} min.`);
      }
      const earn  = 50 + Math.floor(Math.random() * 150);
      u.coins    += earn;
      u.lastWork  = now;
      eco.saveUser(id, u);
      return { id, earned: earn, coins: u.coins };
    }

    case 'games/slots': {
      const eco  = require('./economy');
      const { number, bet = 50 } = payload;
      if (!number) throw new Error('number required');
      const id    = toJid(number);
      const u     = eco.getUser(id);
      const wager = Math.min(Number(bet), u.coins);
      if (wager <= 0) throw new Error('Not enough coins');
      const REELS = ['🍒','🍋','🍊','🍇','⭐','💎'];
      const spin  = () => REELS[Math.floor(Math.random() * REELS.length)];
      const s     = [spin(), spin(), spin()];
      let won = 0;
      if (s[0] === s[1] && s[1] === s[2]) won = s[0] === '💎' ? wager * 10 : wager * 3;
      else if (s[0] === s[1] || s[1] === s[2]) won = Math.floor(wager * 1.5);
      u.coins += won - wager;
      eco.saveUser(id, u);
      return { spin: s.join(''), bet: wager, won, coins: u.coins };
    }

    case 'games/flip': {
      const eco  = require('./economy');
      const { number, bet = 50, choice } = payload;
      if (!number || !choice) throw new Error('number and choice (heads/tails) required');
      const id    = toJid(number);
      const u     = eco.getUser(id);
      const wager = Math.min(Number(bet), u.coins);
      if (wager <= 0) throw new Error('Not enough coins');
      const result = Math.random() < 0.5 ? 'heads' : 'tails';
      const won    = result === choice.toLowerCase();
      u.coins     += won ? wager : -wager;
      eco.saveUser(id, u);
      return { result, choice: choice.toLowerCase(), won, bet: wager, coins: u.coins };
    }

    case 'games/pay': {
      const eco  = require('./economy');
      const { from: fromNum, to: toNum, amount } = payload;
      if (!fromNum || !toNum || !amount) throw new Error('from, to, and amount required');
      const fromId = toJid(fromNum);
      const toId   = toJid(toNum);
      const amt    = Number(amount);
      const sender = eco.getUser(fromId);
      if (sender.coins < amt) throw new Error('Insufficient coins');
      sender.coins -= amt;
      const receiver = eco.getUser(toId);
      receiver.coins += amt;
      eco.saveUser(fromId, sender);
      eco.saveUser(toId, receiver);
      return { from: fromId, to: toId, amount: amt };
    }

    case 'games/rob': {
      const eco  = require('./economy');
      const { number: robberNum, target: targetNum } = payload;
      if (!robberNum || !targetNum) throw new Error('number and target required');
      const robberId = toJid(robberNum);
      const targetId = toJid(targetNum);
      const robber   = eco.getUser(robberId);
      const target   = eco.getUser(targetId);
      const now      = Date.now();
      if (now - robber.lastRob < 3_600_000) throw new Error('Rob cooldown active (1h)');
      if (target.coins < 100) throw new Error('Target is too poor to rob');
      const success  = Math.random() > 0.4;
      robber.lastRob = now;
      if (success) {
        const stolen   = Math.floor(target.coins * 0.2);
        robber.coins  += stolen;
        target.coins  -= stolen;
        eco.saveUser(robberId, robber);
        eco.saveUser(targetId, target);
        return { success: true, stolen, robberCoins: robber.coins };
      }
      const fine     = Math.floor(robber.coins * 0.1);
      robber.coins  -= fine;
      eco.saveUser(robberId, robber);
      return { success: false, fine, robberCoins: robber.coins };
    }

    case 'games/leaderboard': {
      const eco = require('./economy');
      return { leaderboard: eco.getLeaderboard(10) };
    }

    case 'games/profile': {
      const eco  = require('./economy');
      const { number } = payload;
      if (!number) throw new Error('number required');
      const id = toJid(number);
      const u  = eco.getUser(id);
      return { id, ...u };
    }

    // ── Fun ──────────────────────────────────────────────────

    case 'fun/joke': {
      const fetch = require('node-fetch');
      const res   = await fetch('https://v2.jokeapi.dev/joke/Any?blacklistFlags=nsfw,racist,sexist');
      const data  = await res.json();
      const text  = data.type === 'twopart' ? `${data.setup}\n\n${data.delivery}` : data.joke;
      return { joke: text };
    }

    case 'fun/meme': {
      const fetch = require('node-fetch');
      const subs  = ['memes','dankmemes','me_irl'];
      const sub   = subs[Math.floor(Math.random() * subs.length)];
      const res   = await fetch(`https://www.reddit.com/r/${sub}/random.json`, { headers: { 'User-Agent': 'APEX-MD/2.1' } });
      const data  = await res.json();
      const post  = data?.[0]?.data?.children?.[0]?.data;
      if (!post?.url) throw new Error('Could not fetch meme');
      return { title: post.title, url: post.url, subreddit: post.subreddit };
    }

    case 'fun/fact': {
      const fetch = require('node-fetch');
      const res   = await fetch('https://uselessfacts.jsph.pl/random.json?language=en');
      const data  = await res.json();
      return { fact: data.text };
    }

    case 'fun/quote': {
      const fetch = require('node-fetch');
      const res   = await fetch('https://zenquotes.io/api/random');
      const data  = await res.json();
      return { quote: data[0]?.q, author: data[0]?.a };
    }

    case 'fun/8ball': {
      const ANSWERS = ['✅ It is certain.','✅ Without a doubt.','✅ Yes definitely.','🤔 Reply hazy, try again.','🤔 Ask again later.','❌ Don\'t count on it.','❌ My reply is no.','❌ Very doubtful.'];
      const { question } = payload;
      if (!question) throw new Error('question required');
      return { question, answer: ANSWERS[Math.floor(Math.random() * ANSWERS.length)] };
    }

    case 'fun/ship': {
      const { person1, person2 } = payload;
      if (!person1 || !person2) throw new Error('person1 and person2 required');
      const score = Math.floor(Math.random() * 101);
      const bar   = '💗'.repeat(Math.floor(score / 10)) + '🖤'.repeat(10 - Math.floor(score / 10));
      return { person1, person2, score, bar };
    }

    case 'fun/choose': {
      const { options } = payload;
      if (!Array.isArray(options) || options.length < 2) throw new Error('options[] with at least 2 items required');
      return { choice: options[Math.floor(Math.random() * options.length)] };
    }

    case 'fun/truth': {
      const TRUTHS = ['What is the most embarrassing thing you\'ve done?','Who do you have a secret crush on?','What\'s the biggest lie you\'ve told recently?','Have you ever ghosted someone?','What\'s something you\'ve never told your parents?'];
      return { truth: TRUTHS[Math.floor(Math.random() * TRUTHS.length)] };
    }

    case 'fun/horoscope': {
      const { aiReply } = require('./ai');
      const { sign } = payload;
      if (!sign) throw new Error('sign required (e.g. aries, taurus)');
      const reply = await aiReply('horoscope', `Give a fun, witty daily horoscope for ${sign} in 2-3 sentences.`);
      return { sign, horoscope: reply };
    }

    case 'fun/roll': {
      const { dice = 'd6' } = payload;
      const sides = parseInt(String(dice).replace(/[dD]/, '')) || 6;
      const roll  = Math.floor(Math.random() * sides) + 1;
      return { dice: `d${sides}`, roll };
    }

    // ── Utility ──────────────────────────────────────────────

    case 'utility/translate': {
      const fetch  = require('node-fetch');
      const { text, to = 'en' } = payload;
      if (!text) throw new Error('text required');
      const res  = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=auto|${to}`);
      const data = await res.json();
      return { original: text, translated: data.responseData?.translatedText, to };
    }

    case 'utility/weather': {
      const fetch  = require('node-fetch');
      const config = require('../config');
      const { city } = payload;
      if (!city) throw new Error('city required');
      const key = config.WEATHER_API_KEY;
      if (!key) throw new Error('WEATHER_API_KEY not set');
      const res  = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${key}&units=metric`);
      const data = await res.json();
      if (data.cod !== 200) throw new Error(data.message || 'City not found');
      return { city: data.name, temp: data.main.temp, feels: data.main.feels_like, condition: data.weather[0].description, humidity: data.main.humidity, wind: data.wind.speed };
    }

    case 'utility/wikipedia': {
      const fetch = require('node-fetch');
      const { query } = payload;
      if (!query) throw new Error('query required');
      const res  = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
      const data = await res.json();
      if (data.type === 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found') throw new Error('Not found');
      return { title: data.title, summary: data.extract, url: data.content_urls?.desktop?.page };
    }

    case 'utility/qr': {
      const QRCode = require('qrcode');
      const { text } = payload;
      if (!text) throw new Error('text required');
      const buffer = await QRCode.toBuffer(text, { type: 'png', width: 512 });
      return { buffer: buffer.toString('base64'), mimetype: 'image/png' };
    }

    case 'utility/ascii': {
      const fetch = require('node-fetch');
      const { text, font = 'standard' } = payload;
      if (!text) throw new Error('text required');
      const res  = await fetch(`https://artii.herokuapp.com/make?text=${encodeURIComponent(text)}&font=${font}`);
      const art  = await res.text();
      return { art };
    }

    case 'utility/base64': {
      const { text, action = 'encode' } = payload;
      if (!text) throw new Error('text required');
      const result = action === 'decode'
        ? Buffer.from(text, 'base64').toString('utf-8')
        : Buffer.from(text).toString('base64');
      return { result, action };
    }

    case 'utility/calc': {
      const { expression } = payload;
      if (!expression) throw new Error('expression required');
      // Safe eval — only allow math chars
      if (!/^[\d\s+\-*/().%^]+$/.test(expression)) throw new Error('Invalid expression');
      // eslint-disable-next-line no-eval
      const result = eval(expression);
      return { expression, result };
    }

    case 'utility/tts': {
      const fetch  = require('node-fetch');
      const { text, lang = 'en' } = payload;
      if (!text) throw new Error('text required');
      const url  = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
      const res  = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error('TTS service unavailable');
      const buf  = Buffer.from(await res.arrayBuffer());
      return { buffer: buf.toString('base64'), mimetype: 'audio/mpeg' };
    }

    case 'utility/virus': {
      const fetch  = require('node-fetch');
      const config = require('../config');
      const { url: scanUrl } = payload;
      if (!scanUrl) throw new Error('url required');
      const key = config.URLSCAN_API_KEY;
      if (!key) throw new Error('URLSCAN_API_KEY not set');
      const res  = await fetch('https://urlscan.io/api/v1/scan/', {
        method:  'POST',
        headers: { 'API-Key': key, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: scanUrl, visibility: 'unlisted' }),
      });
      const data = await res.json();
      return { submitted: true, uuid: data.uuid, result: data.result };
    }

    case 'utility/shazam': {
      const fetch  = require('node-fetch');
      const config = require('../config');
      const { audioBase64 } = payload;
      if (!audioBase64) throw new Error('audioBase64 required');
      const key = config.AUDD_API_KEY;
      if (!key) throw new Error('AUDD_API_KEY not set');
      const body = new (require('form-data'))();
      body.append('api_token', key);
      body.append('audio', Buffer.from(audioBase64, 'base64'), { filename: 'audio.mp3' });
      const res  = await fetch('https://api.audd.io/', { method: 'POST', body });
      const data = await res.json();
      if (!data.result) throw new Error('Song not recognized');
      return { title: data.result.title, artist: data.result.artist, album: data.result.album };
    }

    // ── Media ────────────────────────────────────────────────

    case 'media/sticker': {
      const sharp = require('sharp');
      const { imageBase64, pack = 'APEX-MD', author = 'Bot' } = payload;
      if (!imageBase64) throw new Error('imageBase64 required');
      const buf    = Buffer.from(imageBase64, 'base64');
      const webp   = await sharp(buf).resize(512, 512, { fit: 'contain', background: { r:0,g:0,b:0,alpha:0 } }).webp().toBuffer();
      return { buffer: webp.toString('base64'), mimetype: 'image/webp', pack, author };
    }

    case 'media/toaudio': {
      const ffmpeg = require('fluent-ffmpeg');
      const path   = require('path');
      const os     = require('os');
      const fs     = require('fs');
      const { videoBase64 } = payload;
      if (!videoBase64) throw new Error('videoBase64 required');
      const tmp   = path.join(os.tmpdir(), `apex_${Date.now()}`);
      const inF   = `${tmp}_in.mp4`;
      const outF  = `${tmp}_out.mp3`;
      fs.writeFileSync(inF, Buffer.from(videoBase64, 'base64'));
      await new Promise((res, rej) => ffmpeg(inF).noVideo().audioCodec('libmp3lame').save(outF).on('end', res).on('error', rej));
      const buf = fs.readFileSync(outF);
      fs.unlinkSync(inF); fs.unlinkSync(outF);
      return { buffer: buf.toString('base64'), mimetype: 'audio/mpeg' };
    }

    case 'media/toimg': {
      const ffmpeg = require('fluent-ffmpeg');
      const path   = require('path');
      const os     = require('os');
      const fs     = require('fs');
      const { videoBase64 } = payload;
      if (!videoBase64) throw new Error('videoBase64 required');
      const tmp  = path.join(os.tmpdir(), `apex_${Date.now()}`);
      const inF  = `${tmp}_in.mp4`;
      const outF = `${tmp}_out.jpg`;
      fs.writeFileSync(inF, Buffer.from(videoBase64, 'base64'));
      await new Promise((res, rej) => ffmpeg(inF).frames(1).save(outF).on('end', res).on('error', rej));
      const buf = fs.readFileSync(outF);
      fs.unlinkSync(inF); fs.unlinkSync(outF);
      return { buffer: buf.toString('base64'), mimetype: 'image/jpeg' };
    }

    case 'media/logo': {
      const sharp   = require('sharp');
      const { text, color = '#ffffff', bg = '#000000' } = payload;
      if (!text) throw new Error('text required');
      const svg = `<svg width="800" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect width="800" height="200" fill="${bg}"/>
        <text x="50%" y="55%" font-size="80" font-family="Arial" font-weight="bold" fill="${color}" text-anchor="middle" dominant-baseline="middle">${text}</text>
      </svg>`;
      const buf = await sharp(Buffer.from(svg)).png().toBuffer();
      return { buffer: buf.toString('base64'), mimetype: 'image/png' };
    }

    // ── Anime ────────────────────────────────────────────────

    case 'anime/react': {
      const fetch = require('node-fetch');
      const { reaction = 'hug' } = payload;
      const res  = await fetch(`https://nekos.life/api/v2/img/${reaction}`);
      const data = await res.json();
      if (!data.url) throw new Error('Reaction not found');
      const img  = await fetch(data.url);
      const buf  = Buffer.from(await img.arrayBuffer());
      return { reaction, buffer: buf.toString('base64'), mimetype: 'image/gif', url: data.url };
    }

    // ── Liveness ping ───────────────────────────────────────
    case 'ping':
      return { pong: true, botTime: new Date().toISOString() };

    // ── AI proxy (API has no AI engine — routes here) ───────
    case 'ai': {
      const { aiReply } = require('./ai');
      const { message, userId = 'api-user' } = payload;
      if (!message) throw new Error('message required');
      const reply = await aiReply(userId, message);
      return { reply };
    }

    // ── Plugin management (plugin state lives in bot) ────────
    case 'plugins-list': {
      const { listPlugins } = require('./pluginLoader');
      return { plugins: listPlugins() };
    }

    case 'plugins-unload': {
      const { unloadPlugin } = require('./pluginLoader');
      const { name } = payload;
      if (!name) throw new Error('name required');
      unloadPlugin(name);
      return { unloaded: name };
    }

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
