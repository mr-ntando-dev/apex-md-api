// ============================================================
//  APEX-MD · Database Patch  (lib/database.patch.js)
//
//  Adds the missing helpers the API layer needs:
//    - Auto-reply CRUD
//    - Schedule list / add / delete
//    - setUser export wrapper
//
//  HOW TO APPLY:
//  At the bottom of lib/database.js, replace the module.exports
//  line with the one shown at the end of this file, and copy
//  the function bodies in between.
//
//  OR — just require this patch file after database.js:
//    const db = require('./database');
//    require('./database.patch')(db);
//  (The patch mutates the db object in-place.)
// ============================================================

'use strict';

const NodeCache  = require('node-cache');
const mongoose   = require('mongoose');
const config     = require('../config');

// ── Auto-Reply Schema ─────────────────────────────────────────
let AutoReply;
try {
  AutoReply = mongoose.model('AutoReply');
} catch (_) {
  const arSchema = new mongoose.Schema({
    keyword: { type: String, required: true, unique: true },
    reply:   { type: String, required: true },
    exact:   { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  });
  AutoReply = mongoose.model('AutoReply', arSchema);
}

// ── In-memory fallback store ─────────────────────────────────
const arCache  = new NodeCache({ stdTTL: 0 });
const schCache = new NodeCache({ stdTTL: 0 });

// ── Auto-Reply helpers ────────────────────────────────────────
async function getAllAutoReplies() {
  if (!config.DB_ENABLED) return [...(arCache.get('all') || [])];
  return AutoReply.find().lean();
}

async function setAutoReply(keyword, { reply, exact = false }) {
  if (!config.DB_ENABLED) {
    const list = arCache.get('all') || [];
    const idx  = list.findIndex(r => r.keyword === keyword);
    const rule = { keyword, reply, exact };
    if (idx >= 0) list[idx] = rule; else list.push(rule);
    arCache.set('all', list);
    return rule;
  }
  return AutoReply.findOneAndUpdate(
    { keyword },
    { keyword, reply, exact },
    { upsert: true, new: true }
  ).lean();
}

async function deleteAutoReply(keyword) {
  if (!config.DB_ENABLED) {
    const list = (arCache.get('all') || []).filter(r => r.keyword !== keyword);
    arCache.set('all', list);
    return;
  }
  await AutoReply.deleteOne({ keyword });
}

// ── Schedule helpers ──────────────────────────────────────────
async function getSchedules() {
  // Use the existing Schedule model from the parent database.js
  let Schedule;
  try { Schedule = mongoose.model('Schedule'); } catch (_) { return schCache.get('all') || []; }
  if (!config.DB_ENABLED) return schCache.get('all') || [];
  return Schedule.find({ active: true }).lean();
}

async function addSchedule({ chatId, message, cronExpr, ownerId = 'api' }) {
  let Schedule;
  try { Schedule = mongoose.model('Schedule'); } catch (_) { Schedule = null; }
  const doc = { chatId, message, cronExpr, ownerId, active: true, createdAt: new Date() };
  if (!config.DB_ENABLED || !Schedule) {
    const list = schCache.get('all') || [];
    doc._id = Date.now().toString();
    list.push(doc);
    schCache.set('all', list);
    return doc;
  }
  const created = await Schedule.create(doc);
  return created.toObject();
}

async function deleteSchedule(id) {
  let Schedule;
  try { Schedule = mongoose.model('Schedule'); } catch (_) { Schedule = null; }
  if (!config.DB_ENABLED || !Schedule) {
    const list = (schCache.get('all') || []).filter(s => String(s._id) !== String(id));
    schCache.set('all', list);
    return;
  }
  await Schedule.findByIdAndDelete(id);
}

// ── Patch function — call as: require('./database.patch')(db) ─
function applyPatch(db) {
  db.getAllAutoReplies = getAllAutoReplies;
  db.setAutoReply     = setAutoReply;
  db.deleteAutoReply  = deleteAutoReply;
  db.getSchedules     = getSchedules;
  db.addSchedule      = addSchedule;
  db.deleteSchedule   = deleteSchedule;
}

module.exports = applyPatch;

// ── Standalone exports (if used directly) ───────────────────
module.exports.getAllAutoReplies = getAllAutoReplies;
module.exports.setAutoReply     = setAutoReply;
module.exports.deleteAutoReply  = deleteAutoReply;
module.exports.getSchedules     = getSchedules;
module.exports.addSchedule      = addSchedule;
module.exports.deleteSchedule   = deleteSchedule;
