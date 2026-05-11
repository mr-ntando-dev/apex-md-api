// ============================================================
//  APEX-MD · Database  (lib/database.js)
//  MongoDB + in-memory fallback.
//  Includes the Job queue schema for bot ↔ API communication.
// ============================================================

'use strict';

const mongoose  = require('mongoose');
const NodeCache = require('node-cache');
const config    = require('../config');
const logger    = require('./logger');

// ── In-memory cache (fallback when MongoDB not set) ──────────
const cache = new NodeCache({ stdTTL: 0 });

// ════════════════════════════════════════════════════════════
//  SCHEMAS
// ════════════════════════════════════════════════════════════

// ── Group Settings ─────────────────────────────────────────
const groupSchema = new mongoose.Schema({
  id:             { type: String,  required: true, unique: true },
  antiLink:       { type: Boolean, default: false },
  antiLinkAction: { type: String,  default: 'delete' },
  antiBadWord:    { type: Boolean, default: false },
  antiSpam:       { type: Boolean, default: false },
  antiDelete:     { type: Boolean, default: false },
  welcome:        { type: Boolean, default: false },
  welcomeMsg:     { type: String,  default: '' },
  goodbye:        { type: Boolean, default: false },
  muted:          { type: Boolean, default: false },
  warnCount:      { type: Map, of: Number, default: {} },
  language:       { type: String,  default: 'en' },
  updatedAt:      { type: Date,    default: Date.now },
});

// ── User Stats ─────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  id:           { type: String,  required: true, unique: true },
  banned:       { type: Boolean, default: false },
  premium:      { type: Boolean, default: false },
  xp:           { type: Number,  default: 0 },
  level:        { type: Number,  default: 1 },
  warnings:     { type: Number,  default: 0 },
  commandCount: { type: Number,  default: 0 },
  coins:        { type: Number,  default: 0 },
  lastSeen:     { type: Date,    default: Date.now },
});

// ── Scheduled Messages ─────────────────────────────────────
const scheduleSchema = new mongoose.Schema({
  chatId:   { type: String,  required: true },
  message:  { type: String,  required: true },
  cronExpr: { type: String,  required: true },
  ownerId:  { type: String,  required: true },
  active:   { type: Boolean, default: true },
  createdAt:{ type: Date,    default: Date.now },
});

// ── Auto-Reply ─────────────────────────────────────────────
const autoReplySchema = new mongoose.Schema({
  keyword:  { type: String,  required: true, unique: true },
  reply:    { type: String,  required: true },
  exact:    { type: Boolean, default: false },
  createdAt:{ type: Date,    default: Date.now },
});

// ── Job Queue  (bot ↔ API bridge) ──────────────────────────
//
//  API writes a job → bot polls, executes, writes result back.
//  TTL index auto-deletes finished/old jobs after 5 minutes.
//
const jobSchema = new mongoose.Schema({
  type:    { type: String, required: true },   // e.g. 'send', 'kick', 'broadcast'
  payload: { type: mongoose.Schema.Types.Mixed },
  status:  { type: String, default: 'pending' }, // pending | processing | done | failed
  result:  { type: mongoose.Schema.Types.Mixed },
  error:   { type: String },
  createdAt:{ type: Date, default: Date.now, expires: 300 }, // auto-purge after 5 min
});

const Group     = mongoose.model('Group',     groupSchema);
const User      = mongoose.model('User',      userSchema);
const Schedule  = mongoose.model('Schedule',  scheduleSchema);
const AutoReply = mongoose.model('AutoReply', autoReplySchema);
const Job       = mongoose.model('Job',       jobSchema);

// ════════════════════════════════════════════════════════════
//  CONNECTION
// ════════════════════════════════════════════════════════════

async function connect() {
  if (!config.DB_ENABLED) {
    logger.warn('[DB] MongoDB URI not set — using in-memory store (data lost on restart)');
    return false;
  }
  try {
    await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    logger.info('[DB] Connected to MongoDB ✓');
    return true;
  } catch (err) {
    logger.error('[DB] MongoDB connection failed:', err.message);
    logger.warn('[DB] Falling back to in-memory store');
    return false;
  }
}

// ════════════════════════════════════════════════════════════
//  GROUP HELPERS
// ════════════════════════════════════════════════════════════

async function getGroup(id) {
  if (!config.DB_ENABLED) return cache.get('group:' + id) || {};
  let g = await Group.findOne({ id });
  if (!g) g = await Group.create({ id });
  return g.toObject();
}

async function setGroup(id, data) {
  if (!config.DB_ENABLED) {
    cache.set('group:' + id, { ...(cache.get('group:' + id) || {}), ...data });
    return;
  }
  await Group.findOneAndUpdate({ id }, { ...data, updatedAt: new Date() }, { upsert: true });
}

// ════════════════════════════════════════════════════════════
//  USER HELPERS
// ════════════════════════════════════════════════════════════

async function getUser(id) {
  if (!config.DB_ENABLED) return cache.get('user:' + id) || {};
  let u = await User.findOne({ id });
  if (!u) u = await User.create({ id });
  return u.toObject();
}

async function setUser(id, data) {
  if (!config.DB_ENABLED) {
    cache.set('user:' + id, { ...(cache.get('user:' + id) || {}), ...data });
    return;
  }
  await User.findOneAndUpdate({ id }, data, { upsert: true });
}

async function incrementStat(id, field) {
  if (!config.DB_ENABLED) {
    const u = cache.get('user:' + id) || {};
    u[field] = (u[field] || 0) + 1;
    cache.set('user:' + id, u);
    return;
  }
  await User.findOneAndUpdate({ id }, { $inc: { [field]: 1 } }, { upsert: true });
}

// ════════════════════════════════════════════════════════════
//  SCHEDULE HELPERS
// ════════════════════════════════════════════════════════════

async function getSchedules() {
  if (!config.DB_ENABLED) return cache.get('schedules') || [];
  return Schedule.find({ active: true }).lean();
}

async function addSchedule({ chatId, message, cronExpr, ownerId = 'owner' }) {
  const doc = { chatId, message, cronExpr, ownerId, active: true };
  if (!config.DB_ENABLED) {
    const list = cache.get('schedules') || [];
    const item = { ...doc, _id: Date.now().toString(), createdAt: new Date() };
    list.push(item);
    cache.set('schedules', list);
    return item;
  }
  const created = await Schedule.create(doc);
  return created.toObject();
}

async function deleteSchedule(id) {
  if (!config.DB_ENABLED) {
    const list = (cache.get('schedules') || []).filter(s => s._id !== id);
    cache.set('schedules', list);
    return;
  }
  await Schedule.findByIdAndDelete(id);
}

// ════════════════════════════════════════════════════════════
//  AUTO-REPLY HELPERS
// ════════════════════════════════════════════════════════════

async function getAllAutoReplies() {
  if (!config.DB_ENABLED) return cache.get('autoreplies') || [];
  return AutoReply.find().lean();
}

async function setAutoReply(keyword, { reply, exact = false }) {
  if (!config.DB_ENABLED) {
    const list = cache.get('autoreplies') || [];
    const idx  = list.findIndex(r => r.keyword === keyword);
    const rule = { keyword, reply, exact };
    if (idx >= 0) list[idx] = rule; else list.push(rule);
    cache.set('autoreplies', list);
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
    const list = (cache.get('autoreplies') || []).filter(r => r.keyword !== keyword);
    cache.set('autoreplies', list);
    return;
  }
  await AutoReply.deleteOne({ keyword });
}

// ════════════════════════════════════════════════════════════
//  JOB QUEUE HELPERS  (used by API + bot worker)
// ════════════════════════════════════════════════════════════

// In-memory job store for when MongoDB is not available
const memJobs = new Map();
let _memJobId = 1;

/**
 * Create a new job. Called by the API.
 * Returns the job document (with _id).
 */
async function createJob(type, payload) {
  if (!config.DB_ENABLED) {
    const id  = String(_memJobId++);
    const job = { _id: id, type, payload, status: 'pending', result: null, error: null, createdAt: new Date() };
    memJobs.set(id, job);
    // auto-purge after 5 min
    setTimeout(() => memJobs.delete(id), 300_000);
    return job;
  }
  const doc = await Job.create({ type, payload });
  return doc.toObject();
}

/**
 * Claim the oldest pending job (atomic findOneAndUpdate).
 * Called by the bot worker every second.
 */
async function claimNextJob() {
  if (!config.DB_ENABLED) {
    for (const [, job] of memJobs) {
      if (job.status === 'pending') {
        job.status = 'processing';
        return job;
      }
    }
    return null;
  }
  return Job.findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'processing' } },
    { sort: { createdAt: 1 }, new: true }
  ).lean();
}

/**
 * Mark a job done with its result.
 */
async function resolveJob(id, result) {
  if (!config.DB_ENABLED) {
    const j = memJobs.get(id);
    if (j) { j.status = 'done'; j.result = result; }
    return;
  }
  await Job.findByIdAndUpdate(id, { status: 'done', result });
}

/**
 * Mark a job failed with an error string.
 */
async function failJob(id, error) {
  if (!config.DB_ENABLED) {
    const j = memJobs.get(id);
    if (j) { j.status = 'failed'; j.error = error; }
    return;
  }
  await Job.findByIdAndUpdate(id, { status: 'failed', error });
}

/**
 * Poll a job by ID for its current state.
 * Used by the API while waiting for the bot to finish.
 */
async function getJob(id) {
  if (!config.DB_ENABLED) return memJobs.get(id) || null;
  return Job.findById(id).lean();
}

// ════════════════════════════════════════════════════════════
//  EXPORTS
// ════════════════════════════════════════════════════════════

module.exports = {
  connect,
  // group
  getGroup, setGroup,
  // user
  getUser, setUser, incrementStat,
  // schedule
  getSchedules, addSchedule, deleteSchedule,
  // auto-reply
  getAllAutoReplies, setAutoReply, deleteAutoReply,
  // job queue
  createJob, claimNextJob, resolveJob, failJob, getJob,
  // raw models (for advanced queries)
  models: { Group, User, Schedule, AutoReply, Job },
};
