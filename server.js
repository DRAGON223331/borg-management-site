'use strict';

require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const multer = require('multer');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { Server } = require('socket.io');
const { buildSubmissionNotifications, mergeSubmissionDecisionEmbed } = require('./lib/submission-notifications.js');
const {
  Client,
  GatewayIntentBits,
  Events,
  AttachmentBuilder,
  EmbedBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Partials,
} = require('discord.js');

const PORT = Number(process.env.PORT || 3000);
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `${SITE_URL}/auth/callback`;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const MAIN_GUILD_ID = process.env.MAIN_GUILD_ID || '883871561474539630';
const STAFF_GUILD_ID = process.env.STAFF_GUILD_ID || '1556647204255568063';
const MANAGEMENT_MAIN_ROLE_ID = process.env.MANAGEMENT_MAIN_ROLE_ID || '1538623033806168135';
const MANAGEMENT_STAFF_ROLE_ID = process.env.MANAGEMENT_STAFF_ROLE_ID || '1559628523809804288';
const TASKS_CHANNEL_ID = process.env.TASKS_CHANNEL_ID || '1556647204960346215';
// الروم الوحيد الذي تُحسب منه رسائل الاستاف.
const TASK_PING_ROLE_ID = (process.env.TASK_PING_ROLE_ID || '1556647362062188544').trim(); // رتبة بتتمنشن مع كل مهمات جديدة
const MESSAGE_COUNT_CHANNEL_ID = (process.env.MESSAGE_COUNT_CHANNEL_ID || '1552049641913065552').trim();
const TASK_SUBMISSIONS_CHANNEL_ID = process.env.TASK_SUBMISSIONS_CHANNEL_ID || '1556651404154642504';
const TASK_APPROVED_CHANNEL_ID = (process.env.TASK_APPROVED_CHANNEL_ID || TASK_SUBMISSIONS_CHANNEL_ID || '1556651404154642504').trim();
const SUBMISSION_REVIEW_CHANNEL_ID = '1556945732957765722';
const POINTS_LOG_CHANNEL_ID = process.env.POINTS_LOG_CHANNEL_ID || '1559598706871767172';
const LEAVE_REQUEST_CHANNEL_ID = '1556945732957765722'; // ثابت: روم طلبات الإجازة ومراجعتها
const STAFF_REQUEST_CHANNEL_ID = '1560142058826768425'; // ثابت: روم كل الطلبات الإدارية غير الإجازات، وسجلات قبولها ورفضها
const MANAGER_IDS = new Set((process.env.MANAGER_IDS || '1286035404323164172,1525203473262706821,848304089057460254,1475483362536980552')
  .split(',').map((x) => x.trim()).filter(Boolean));
const ATTACHMENT_LIMIT_MB = Math.max(1, Number(process.env.DISCORD_ATTACHMENT_LIMIT_MB || 8));
const MAX_UPLOAD_MB = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 100));
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'));

for (const dir of [DATA_DIR, UPLOAD_DIR]) fs.mkdirSync(dir, { recursive: true });

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.warn('[config] SESSION_SECRET is missing or shorter than 32 characters. Set a strong random secret in .env before deploying.');
}
if (!DISCORD_CLIENT_SECRET || !BOT_TOKEN) {
  console.warn('[config] Discord OAuth secret or bot token is missing. Copy .env.example to .env and fill the required values.');
}

const db = new Database(path.join(DATA_DIR, 'borg.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    required INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    source_message_id TEXT,
    source_line_index INTEGER,
    source_message_deleted_at TEXT,
    points REAL NOT NULL DEFAULT 1,
    UNIQUE(source_message_id, source_line_index)
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(active, required DESC, id DESC);

  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    avatar_url TEXT,
    note TEXT NOT NULL DEFAULT '',
    evidence_links TEXT NOT NULL DEFAULT '[]',
    files_json TEXT NOT NULL DEFAULT '[]',
    submitted_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted'
  );
  CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id, submitted_at DESC);

  CREATE TABLE IF NOT EXISTS submission_tasks (
    submission_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    points_awarded REAL,
    PRIMARY KEY (submission_id, task_id),
    FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_submission_tasks_task ON submission_tasks(task_id);

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL CHECK(room IN ('staff', 'management')),
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    avatar_url TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_room_id ON chat_messages(room, id DESC);
  CREATE TABLE IF NOT EXISTS staff_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    actor_id TEXT NOT NULL DEFAULT '',
    actor_name TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    submission_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_staff_points_user ON staff_points(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS discord_message_log (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dml_channel_user ON discord_message_log(channel_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_dml_channel_created ON discord_message_log(channel_id, created_at);
  CREATE TABLE IF NOT EXISTS site_presence (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    avatar_url TEXT,
    last_seen TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_site_presence_last_seen ON site_presence(last_seen DESC);

  CREATE TABLE IF NOT EXISTS leave_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    avatar_url TEXT,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    review_note TEXT NOT NULL DEFAULT '',
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_leave_requests_user ON leave_requests(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS staff_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    avatar_url TEXT,
    request_type TEXT NOT NULL,
    subject TEXT NOT NULL,
    details TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    review_note TEXT NOT NULL DEFAULT '',
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_staff_requests_user ON staff_requests(user_id, created_at DESC);
`);

// Add request-message linkage for installations upgrading an existing SQLite database.
for (const statement of [
  'ALTER TABLE leave_requests ADD COLUMN discord_message_id TEXT',
  'ALTER TABLE leave_requests ADD COLUMN discord_channel_id TEXT',
  'ALTER TABLE submissions ADD COLUMN discord_message_id TEXT',
  'ALTER TABLE submissions ADD COLUMN discord_channel_id TEXT',
  'ALTER TABLE submissions ADD COLUMN reviewed_by TEXT',
  'ALTER TABLE submissions ADD COLUMN reviewed_at TEXT',
  'ALTER TABLE submission_tasks ADD COLUMN points_awarded REAL',
  'ALTER TABLE tasks ADD COLUMN points REAL NOT NULL DEFAULT 1',
  'ALTER TABLE tasks ADD COLUMN source_message_deleted_at TEXT',
]) {
  try { db.exec(statement); } catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
}
db.exec(`
  CREATE TABLE IF NOT EXISTS submission_review_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL,
    member_id TEXT NOT NULL,
    member_name TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','reopened')),
    reviewer_id TEXT NOT NULL,
    reviewer_name TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_submission_review_audit_created ON submission_review_audit(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_submission_review_audit_submission ON submission_review_audit(submission_id, created_at DESC);
`);

class SqliteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (row.expires <= Date.now()) {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.sess));
    } catch (error) { return callback(error); }
  }
  set(sid, sess, callback = () => {}) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 7 * 86400000;
      db.prepare('INSERT INTO sessions(sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires')
        .run(sid, JSON.stringify(sess), exp);
      callback(null);
    } catch (error) { callback(error); }
  }
  destroy(sid, callback = () => {}) {
    try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); callback(null); }
    catch (error) { callback(error); }
  }
  touch(sid, sess, callback = () => {}) { this.set(sid, sess, callback); }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '150kb' }));
app.use(express.urlencoded({ extended: false, limit: '150kb' }));

const sessionMiddleware = session({
  name: 'borg.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex'),
  store: new SqliteSessionStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});
app.use(sessionMiddleware);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false });
app.use('/api', apiLimiter);

const server = require('node:http').createServer(app);
const io = new Server(server, { serveClient: true, maxHttpBufferSize: 1e6 });
io.engine.use(sessionMiddleware);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});
let botReady = false;
let botLastError = '';

function nowIso() { return new Date().toISOString(); }
function cairoDateParts(date) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second };
}
function cairoMidnightUtcIso(year, month, day) {
  const targetWallClock = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = targetWallClock;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = cairoDateParts(new Date(guess));
    const representedAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    guess += targetWallClock - representedAsUtc;
  }
  return new Date(guess).toISOString();
}
function cairoDayRange(now = new Date()) {
  const current = cairoDateParts(now);
  const next = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  const date = `${current.year}-${String(current.month).padStart(2, '0')}-${String(current.day).padStart(2, '0')}`;
  return {
    start: cairoMidnightUtcIso(current.year, current.month, current.day),
    end: cairoMidnightUtcIso(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
    date,
  };
}
function getDailyStaffMessageStats() {
  const range = cairoDayRange();
  const rows = db.prepare(`SELECT user_id AS userId, MAX(username) AS username, COUNT(*) AS count
    FROM discord_message_log
    WHERE channel_id = ? AND created_at >= ? AND created_at < ?
    GROUP BY user_id
    ORDER BY COUNT(*) DESC, MAX(username) ASC`).all(MESSAGE_COUNT_CHANNEL_ID, range.start, range.end);
  const dailyStats = rows.map((row) => ({ userId: row.userId, username: row.username, count: Number(row.count) || 0 }));
  return { dailyStats, dailyTotal: dailyStats.reduce((total, row) => total + row.count, 0), dailyDate: range.date };
}

function getAllStaffStats() {
  const byId = new Map();
  const ensure = (id, username = '') => {
    const key = String(id);
    if (!byId.has(key)) byId.set(key, { userId: key, username, dailyMessages: 0, totalMessages: 0, totalSubmissions: 0, approvedSubmissions: 0, pendingSubmissions: 0, rejectedSubmissions: 0, totalPoints: 0, leaveRequests: 0, adminRequests: 0, online: false, lastSeen: null });
    const row = byId.get(key); if (username) row.username = username; return row;
  };
  const daily = getDailyStaffMessageStats();
  for (const row of db.prepare("SELECT user_id AS userId, MAX(username) AS username, COUNT(*) AS totalMessages FROM discord_message_log WHERE channel_id = ? GROUP BY user_id").all(MESSAGE_COUNT_CHANNEL_ID)) Object.assign(ensure(row.userId, row.username), { totalMessages: Number(row.totalMessages) || 0 });
  for (const row of db.prepare("SELECT user_id AS userId, COUNT(*) AS totalSubmissions, SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approvedSubmissions, SUM(CASE WHEN status IN ('submitted','pending') THEN 1 ELSE 0 END) AS pendingSubmissions, SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejectedSubmissions FROM submissions GROUP BY user_id").all()) Object.assign(ensure(row.userId), { totalSubmissions: Number(row.totalSubmissions) || 0, approvedSubmissions: Number(row.approvedSubmissions) || 0, pendingSubmissions: Number(row.pendingSubmissions) || 0, rejectedSubmissions: Number(row.rejectedSubmissions) || 0 });
  for (const row of db.prepare('SELECT user_id AS userId, COALESCE(SUM(amount),0) AS totalPoints FROM staff_points GROUP BY user_id').all()) ensure(row.userId).totalPoints = Number(row.totalPoints) || 0;
  for (const row of db.prepare('SELECT user_id AS userId, COUNT(*) AS leaveRequests FROM leave_requests GROUP BY user_id').all()) ensure(row.userId).leaveRequests = Number(row.leaveRequests) || 0;
  for (const row of db.prepare('SELECT user_id AS userId, COUNT(*) AS adminRequests FROM staff_requests GROUP BY user_id').all()) ensure(row.userId).adminRequests = Number(row.adminRequests) || 0;
  const cutoff = new Date(Date.now() - 90 * 1000).toISOString();
  for (const row of db.prepare('SELECT user_id AS userId, last_seen AS lastSeen FROM site_presence WHERE last_seen > ?').all(cutoff)) Object.assign(ensure(row.userId), { online: true, lastSeen: row.lastSeen });
  for (const row of daily.dailyStats || []) ensure(row.userId, row.username).dailyMessages = Number(row.count) || 0;
  return [...byId.values()];
}
function avatarUrl(user) {
  if (!user) return null;
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  const discriminator = Number(user.discriminator || 0);
  return `https://cdn.discordapp.com/embed/avatars/${discriminator % 6}.png`;
}
function profileAvatar(sessionUser) {
  if (!sessionUser) return null;
  return sessionUser.avatarUrl || avatarUrl(sessionUser);
}
function canManage(user) { return Boolean(user && (user.isManager || user.isAdmin)); }
function canReadRoom(user, room) { return Boolean(user && (room === 'staff' || canManage(user))); }
function hasAdministratorPermission(guildObject) {
  if (!guildObject || !guildObject.permissions) return false;
  try { return (BigInt(guildObject.permissions) & PermissionsBitField.Flags.Administrator) === PermissionsBitField.Flags.Administrator; }
  catch { return false; }
}
const liveMainGuildAccessCache = new Map();
async function refreshSessionManagerAccess(sessionUser) {
  if (!sessionUser) return null;
  const userId = String(sessionUser.id || '');
  if (MANAGER_IDS.has(userId)) return { ...sessionUser, isManager: true, isAdmin: false };
  if (!(sessionUser.isAdmin || sessionUser.isManager)) return sessionUser;
  const cached = liveMainGuildAccessCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return { ...sessionUser, ...cached.value };
  try {
    const mainGuild = await client.guilds.fetch(MAIN_GUILD_ID);
    const member = await mainGuild.members.fetch(userId);
    const isAdmin = Boolean(member.roles.cache.has(MANAGEMENT_MAIN_ROLE_ID) || member.permissions.has(PermissionsBitField.Flags.Administrator));
    const value = { isAdmin, isManager: false, isPrimaryServerMember: true, permissionCheckError: false };
    liveMainGuildAccessCache.set(userId, { value, expiresAt: Date.now() + 25_000 });
    return { ...sessionUser, ...value };
  } catch (error) {
    console.warn('[manager permission refresh]', error.message);
    const value = { isAdmin: false, isManager: false, isPrimaryServerMember: false, permissionCheckError: true };
    liveMainGuildAccessCache.set(userId, { value, expiresAt: Date.now() + 8000 });
    return { ...sessionUser, ...value };
  }
}
async function refreshRequestSessionUser(req) {
  const current = req.session?.user;
  if (!current || !(current.isAdmin || current.isManager)) return current || null;
  req.session.user = await refreshSessionManagerAccess(current);
  return req.session.user;
}
async function isMainServerManager(userId) {
  const id = String(userId || '');
  if (MANAGER_IDS.has(id)) return true;
  if (!id) return false;
  try {
    const guild = await client.guilds.fetch(MAIN_GUILD_ID);
    const member = await guild.members.fetch(id);
    return Boolean(member.roles.cache.has(MANAGEMENT_MAIN_ROLE_ID) || member.permissions.has(PermissionsBitField.Flags.Administrator));
  } catch (error) {
    console.warn('[review permission check]', error.message);
    return false;
  }
}
async function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'سجل دخولك بديسكورد أولًا.' });
  await refreshRequestSessionUser(req);
  next();
}
function requireManager(req, res, next) {
  if (!canManage(req.session.user)) return res.status(403).json({ error: 'الصلاحية دي لمسؤولي السيرفر الأساسي فقط.' });
  next();
}
function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    try {
      const requestOrigin = `${req.protocol}://${req.get('host')}`;
      const allowedOrigin = new URL(SITE_URL).origin;
      if (new URL(origin).origin !== allowedOrigin && new URL(origin).origin !== requestOrigin) {
        return res.status(403).json({ error: 'تم رفض الطلب لأسباب أمنية.' });
      }
    } catch { return res.status(403).json({ error: 'مصدر الطلب غير صالح.' }); }
  }
  next();
}
app.use('/api', sameOrigin);

function cleanText(value, max = 300) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}
function splitDiscordContent(value, maxLength = 1800) {
  const chunks = [];
  let current = '';
  for (const originalLine of String(value || '').split('\n')) {
    let line = originalLine;
    while (line.length > maxLength) {
      const room = Math.max(1, maxLength - current.length - (current ? 1 : 0));
      if (current) { chunks.push(current); current = ''; continue; }
      chunks.push(line.slice(0, maxLength));
      line = line.slice(maxLength);
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLength) {
      if (current) chunks.push(current);
      current = line;
    } else current = candidate;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [''];
}
function parseTaskLines(content) {
  const tasks = [];
  const lines = String(content || '').split(/\r?\n/);
  for (const original of lines) {
    let line = original.replace(/<@!?\d+>/g, '').replace(/<#[0-9]+>/g, '').trim();
    if (!line) continue;
    line = line.replace(/^\*\*(.*?)\*\*$/, '$1').replace(/[`*_~]/g, '').trim();
    const taskMatch = line.match(/^(?:(?:[-•▪▫*])|(?:\d{1,3}[.)-]))\s*(?:\[(إجباري|اجباري|required|mandatory|اختياري|optional)\]\s*)?(.+)$/i);
    const explicitMatch = line.match(/^(?:مهمة|task)\s*[:：-]\s*(.+)$/i);
    let title = '';
    let required = false;
    if (taskMatch) {
      const tag = (taskMatch[1] || '').toLowerCase();
      title = taskMatch[2].trim();
      required = ['إجباري', 'اجباري', 'required', 'mandatory'].includes(tag);
    } else if (explicitMatch) {
      title = explicitMatch[1].trim();
      required = /^\[(?:إجباري|اجباري|required|mandatory)\]/i.test(title);
      title = title.replace(/^\[(?:إجباري|اجباري|required|mandatory|اختياري|optional)\]\s*/i, '');
    } else {
      continue;
    }
    title = title.replace(/^#\d+\s*[—–-]\s*/, '').replace(/^#\d+\s+/, '').trim();
    title = cleanText(title, 240);
    if (title && !/^(?:مهمات جديدة|المهمات|المهام|إدارة البرج)$/i.test(title)) tasks.push({ title, required });
  }
  return tasks;
}

const insertImportedTask = db.prepare(`
  INSERT OR IGNORE INTO tasks (title, required, active, created_by, created_by_name, created_at, source_message_id, source_line_index)
  VALUES (?, ?, 1, ?, ?, ?, ?, ?)
`);
async function importDiscordTaskMessage(message) {
  if (!message || message.channelId !== TASKS_CHANNEL_ID || !message.content) return;
  if (client.user && message.author && message.author.id === client.user.id) return;
  const parsed = parseTaskLines(message.content);
  if (!parsed.length) return;
  const authorId = message.author?.id || 'discord-system';
  const authorName = message.author?.username || 'Discord';
  parsed.forEach((task, index) => {
    insertImportedTask.run(task.title, task.required ? 1 : 0, authorId, authorName, nowIso(), message.id, index);
  });
}

client.once(Events.ClientReady, async () => {
  botReady = true;
  botLastError = '';
  console.log(`[discord] Bot connected as ${client.user.tag}`);
  try {
    const channel = await client.channels.fetch(TASKS_CHANNEL_ID);
    if (channel && channel.isTextBased() && typeof channel.messages?.fetch === 'function') {
      const recent = await channel.messages.fetch({ limit: 100 });
      const messages = [...recent.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const message of messages) await importDiscordTaskMessage(message);
      console.log(`[discord] Scanned ${messages.length} recent task-channel messages.`);
    }
  } catch (error) {
    console.warn('[discord] Could not scan existing tasks:', error.message);
  }
});
client.on(Events.MessageCreate, async (message) => {
  try { await importDiscordTaskMessage(message); }
  catch (error) { console.error('[discord] Task import failed:', error.message); }
});

let taskDeleteReconcileRunning = false;
async function reconcileDeletedTaskMessagesLocal() {
  if (taskDeleteReconcileRunning || !BOT_TOKEN) return;
  taskDeleteReconcileRunning = true;
  try {
    const known = db.prepare('SELECT DISTINCT source_message_id FROM tasks WHERE active = 1 AND source_message_id IS NOT NULL').all();
    if (!known.length) return;
    const channel = await client.channels.fetch(TASKS_CHANNEL_ID);
    if (!channel || typeof channel.messages?.fetch !== 'function') return;
    for (const row of known) {
      const messageId = String(row.source_message_id || '');
      if (!/^\d{15,22}$/.test(messageId)) continue;
      try { await channel.messages.fetch(messageId); }
      catch (error) {
        // Only Unknown Message proves deletion; permissions/rate-limit/channel errors are not deletion.
        if (Number(error?.code) === 10008) {
          const result = db.prepare('UPDATE tasks SET active = 0, source_message_deleted_at = ? WHERE source_message_id = ? AND active = 1').run(nowIso(), messageId);
          if (result.changes) console.log(`[discord] Deleted task message ${messageId}; deactivated ${result.changes} task(s).`);
        } else if (error?.status !== 404) {
          console.warn('[discord] Task-message reconciliation error:', error.message);
        }
      }
    }
  } catch (error) { console.warn('[discord] Could not reconcile deleted task messages:', error.message); }
  finally { taskDeleteReconcileRunning = false; }
}
client.on(Events.MessageDelete, async (message) => {
  try {
    if (String(message.channelId || message.channel?.id || '') !== TASKS_CHANNEL_ID) return;
    const result = db.prepare('UPDATE tasks SET active = 0, source_message_deleted_at = ? WHERE source_message_id = ? AND active = 1').run(nowIso(), String(message.id));
    if (result.changes) console.log(`[discord] Deleted task message ${message.id}; deactivated ${result.changes} task(s).`);
  } catch (error) { console.error('[task message delete]', error.message); }
});
client.on(Events.MessageDeleteBulk, async (messages) => {
  for (const message of messages.values()) {
    if (String(message.channelId || message.channel?.id || '') !== TASKS_CHANNEL_ID) continue;
    try { db.prepare('UPDATE tasks SET active = 0, source_message_deleted_at = ? WHERE source_message_id = ? AND active = 1').run(nowIso(), String(message.id)); }
    catch (error) { console.error('[task bulk message delete]', error.message); }
  }
});

// ───────── عدّ رسائل الروم (يزيد مع كل رسالة جديدة وينقص عند الحذف) ─────────
const COUNTED_MESSAGE_TYPES = new Set([0, 19]); // رسالة عادية + رد
const upsertMessageLog = db.prepare(`INSERT INTO discord_message_log(message_id, channel_id, user_id, username, created_at)
  VALUES (?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET username = excluded.username`);
const deleteMessageLog = db.prepare('DELETE FROM discord_message_log WHERE channel_id = ? AND message_id = ?');
function isCountableMessage(message) {
  return Boolean(message && message.channelId === MESSAGE_COUNT_CHANNEL_ID && message.author && !message.author.bot && !message.webhookId
    && COUNTED_MESSAGE_TYPES.has(Number(message.type) || 0));
}
function logCountedMessage(message) {
  if (!isCountableMessage(message)) return false;
  upsertMessageLog.run(String(message.id), MESSAGE_COUNT_CHANNEL_ID, String(message.author.id),
    cleanText(message.author.globalName || message.author.username || message.author.id, 80),
    (message.createdAt || new Date()).toISOString());
  return true;
}
client.on(Events.MessageCreate, (message) => {
  try { logCountedMessage(message); } catch (error) { console.error('[message count create]', error.message); }
});
client.on(Events.MessageUpdate, (_old, message) => {
  try { if (message?.channelId === MESSAGE_COUNT_CHANNEL_ID && message.author) logCountedMessage(message); } catch { /* ignore */ }
});
// الأحداث الخام تشتغل حتى لو الرسالة مش في الكاش (رسائل قديمة أو قبل ما البوت يشتغل).
client.on(Events.Raw, (packet) => {
  try {
    if (!packet || !packet.t || !packet.d || packet.d.channel_id !== MESSAGE_COUNT_CHANNEL_ID) return;
    if (packet.t === 'MESSAGE_DELETE') deleteMessageLog.run(MESSAGE_COUNT_CHANNEL_ID, String(packet.d.id));
    else if (packet.t === 'MESSAGE_DELETE_BULK') {
      const tx = db.transaction((ids) => { for (const id of ids) deleteMessageLog.run(MESSAGE_COUNT_CHANNEL_ID, String(id)); });
      tx(packet.d.ids || []);
    }
  } catch (error) { console.error('[message count delete]', error.message); }
});
let messageScanRunning = false;
async function reconcileCountedMessages() {
  if (messageScanRunning || !MESSAGE_COUNT_CHANNEL_ID) return;
  messageScanRunning = true;
  const startedAt = new Date().toISOString();
  try {
    const channel = await client.channels.fetch(MESSAGE_COUNT_CHANNEL_ID);
    if (!channel || typeof channel.messages?.fetch !== 'function') return;
    const present = new Set();
    let before;
    for (;;) {
      const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!page.size) break;
      for (const message of page.values()) if (logCountedMessage(message)) present.add(String(message.id));
      before = page.last().id;
      if (page.size < 100) break;
    }
    // احذف أي رسالة مسجلة لم تعد موجودة في الروم (ما عدا اللي وصلت بعد بداية المسح).
    const known = db.prepare('SELECT message_id FROM discord_message_log WHERE channel_id = ? AND created_at < ?').all(MESSAGE_COUNT_CHANNEL_ID, startedAt);
    const tx = db.transaction((rows) => { for (const row of rows) if (!present.has(row.message_id)) deleteMessageLog.run(MESSAGE_COUNT_CHANNEL_ID, row.message_id); });
    tx(known);
    console.log(`[discord] Message count synced for channel ${MESSAGE_COUNT_CHANNEL_ID}: ${present.size} messages.`);
  } catch (error) {
    console.warn('[discord] Could not sync message counts:', error.message);
  } finally { messageScanRunning = false; }
}
client.once(Events.ClientReady, () => {
  reconcileCountedMessages();
  setInterval(reconcileCountedMessages, 10 * 60 * 1000).unref?.();
  reconcileDeletedTaskMessagesLocal();
  setInterval(reconcileDeletedTaskMessagesLocal, 5 * 60 * 1000).unref?.();
});

// ───────── أمر "نقاطي" كرسالة عادية بدون بريفكس ─────────
const POINTS_TRIGGER = /^(?:نقاطي|نقاطى|mypoints|my points)$/i;
const pointsCooldown = new Map();
function normalizeTrigger(text) {
  return String(text || '').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[!؟?.،,\s]+$/g, '').replace(/\s+/g, ' ').trim();
}
const fmtPointsMsg = (n) => (Math.round(Number(n || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || !message.author || message.author.bot || message.webhookId) return;
    if (!POINTS_TRIGGER.test(normalizeTrigger(message.content))) return;
    const last = pointsCooldown.get(message.author.id) || 0;
    if (Date.now() - last < 5000) return;
    pointsCooldown.set(message.author.id, Date.now());
    const total = db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM staff_points WHERE user_id = ?').get(message.author.id);
    const recent = db.prepare('SELECT amount, reason FROM staff_points WHERE user_id = ? ORDER BY id DESC LIMIT 5').all(message.author.id);
    const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle('⭐ نقاطك').setDescription(`عندك **${fmtPointsMsg(total?.total)}** نقطة`).setFooter({ text: 'إدارة البرج' });
    if (recent.length) embed.addFields({ name: 'آخر الحركات', value: recent.map((r) => `${Number(r.amount) >= 0 ? '➕' : '➖'} ${fmtPointsMsg(Math.abs(Number(r.amount)))} — ${cleanText(r.reason, 80) || 'بدون سبب'}`).join('\n').slice(0, 1024) });
    await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
  } catch (error) { console.error('[points message command]', error.message); }
});
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  const customId = String(interaction.customId || '');
  const submissionMatch = customId.match(/^submission:(approve|reject):(\d+)$/);
  if (submissionMatch) {
    await handleSubmissionButton(interaction, Number(submissionMatch[2]), submissionMatch[1] === 'approve' ? 'approved' : 'rejected');
    return;
  }
  const match = customId.match(/^leave:(approve|reject):(\d+)$/);
  if (!match) return;
  if (String(interaction.channelId) !== LEAVE_REQUEST_CHANNEL_ID) {
    try { await interaction.reply({ content: 'الأزرار دي شغالة في روم طلبات الإجازات فقط.', ephemeral: true }); } catch {}
    return;
  }
  const reviewerId = interaction.user.id;
  const authorized = await isMainServerManager(reviewerId);
  if (!authorized) {
    try { await interaction.reply({ content: 'مراجعة طلبات الإجازة للمسؤولين فقط.', ephemeral: true }); } catch {}
    return;
  }
  const id = Number(match[2]);
  const targetStatus = match[1] === 'approve' ? 'approved' : 'rejected';
  try {
    await interaction.deferUpdate();
    const row = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
    if (!row || row.discord_message_id !== interaction.message.id || (row.discord_channel_id && row.discord_channel_id !== interaction.channelId)) {
      await interaction.followUp({ content: 'رسالة الإجازة لا تطابق الطلب المسجل.', ephemeral: true });
      return;
    }
    let status = row.status;
    let reviewer = row.reviewed_by || reviewerId;
    let note = row.review_note || '';
    if (row.status === 'pending') {
      const update = db.prepare("UPDATE leave_requests SET status = ?, review_note = '', reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'").run(targetStatus, reviewerId, nowIso(), id);
      const latest = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id);
      if (update.changes && latest) { status = latest.status; reviewer = latest.reviewed_by || reviewerId; note = latest.review_note || ''; }
      else if (latest) { status = latest.status; reviewer = latest.reviewed_by || reviewerId; note = latest.review_note || ''; }
    }
    await interaction.message.edit({ embeds: [buildLeaveEmbed(row, status, reviewer, note)], components: [] });
  } catch (error) {
    console.error('[leave button interaction]', error.message);
    try { await interaction.followUp({ content: 'حصل خطأ أثناء مراجعة الطلب. حدّث الموقع وتحقق من حالة الطلب.', ephemeral: true }); } catch {}
  }
});

async function handleSubmissionButton(interaction, submissionId, targetStatus) {
  if (String(interaction.channelId) !== SUBMISSION_REVIEW_CHANNEL_ID) {
    try { await interaction.reply({ content: 'أزرار التسليمات دي شغالة في روم مراجعة المهمات فقط.', ephemeral: true }); } catch {}
    return;
  }
  const reviewerId = interaction.user.id;
  const authorized = await isMainServerManager(reviewerId);
  if (!authorized) {
    try { await interaction.reply({ content: 'مراجعة تسليمات المهمات للمسؤولين فقط.', ephemeral: true }); } catch {}
    return;
  }

  try {
    await interaction.deferUpdate();
    const submission = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
    if (!submission || String(submission.discord_message_id || '') !== String(interaction.message.id) || String(submission.discord_channel_id || '') !== String(interaction.channelId)) {
      await interaction.followUp({ content: 'رسالة ديسكورد لا تطابق التسليم المسجل. قد تكون الرسالة قديمة أو أُنشئت من قاعدة بيانات أخرى.', ephemeral: true });
      return;
    }

    const reviewerName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username || reviewerId;
    const finalize = db.transaction(() => {
      const current = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
      if (!current) throw new Error('التسليم غير موجود في قاعدة البيانات.');
      let status = current.status;
      let amount = 0;
      let changed = false;
      if (['submitted', 'pending'].includes(String(status))) {
        if (targetStatus === 'approved') {
          db.prepare('UPDATE submission_tasks SET points_awarded = (SELECT points FROM tasks WHERE tasks.id = submission_tasks.task_id) WHERE submission_id = ? AND points_awarded IS NULL').run(submissionId);
          const pointsRow = db.prepare('SELECT COALESCE(SUM(COALESCE(st.points_awarded, t.points)), 0) AS amount FROM submission_tasks st JOIN tasks t ON t.id = st.task_id WHERE st.submission_id = ?').get(submissionId);
          amount = Math.round(Number(pointsRow?.amount || 0) * 100) / 100;
        }
        const update = db.prepare("UPDATE submissions SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status IN ('submitted','pending')").run(targetStatus, reviewerId, nowIso(), submissionId);
        if (update.changes) {
          status = targetStatus;
          changed = true;
          db.prepare('INSERT INTO submission_review_audit(submission_id, member_id, member_name, decision, reviewer_id, reviewer_name, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(submissionId, current.user_id, current.username, targetStatus, reviewerId, reviewerName, '', nowIso());
          if (targetStatus === 'approved' && amount > 0) {
            db.prepare("INSERT INTO staff_points(user_id, username, amount, reason, actor_id, actor_name, source, submission_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 'task', ?, ?)")
              .run(current.user_id, current.username, amount, `اعتماد تسليم #${submissionId}`, reviewerId, reviewerName, submissionId, nowIso());
          }
        }
      }
      if (!['approved', 'rejected'].includes(String(status))) throw new Error(`حالة التسليم غير متوقعة: ${status}`);
      const totalAfter = Number(db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM staff_points WHERE user_id = ?').get(current.user_id)?.total || 0);
      const awarded = Number(db.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM staff_points WHERE submission_id = ? AND source = 'task'").get(submissionId)?.amount || 0);
      return { current, status, changed, amount: status === 'approved' ? (changed ? amount : awarded) : 0, totalAfter, reviewer: current.reviewed_by || (changed ? reviewerId : reviewerId) };
    });

    const result = finalize();
    const original = interaction.message.embeds?.[0];
    const taskRows = db.prepare('SELECT t.id, t.title, COALESCE(st.points_awarded, t.points) AS points FROM submission_tasks st JOIN tasks t ON t.id = st.task_id WHERE st.submission_id = ? ORDER BY t.id').all(submissionId);
    const notification = buildSubmissionNotifications({ submissionId, sub: result.current, reviewerId: result.reviewer || reviewerId, status: result.status, taskRows, amount: result.amount, totalAfter: result.totalAfter });
    const decisionEmbed = mergeSubmissionDecisionEmbed(notification.logEmbed, original);
    await interaction.message.edit({ embeds: [EmbedBuilder.from(decisionEmbed)], components: [], allowedMentions: { parse: [] } });

    if (result.changed) {
      const decisionChannel = await client.channels.fetch(TASK_APPROVED_CHANNEL_ID).catch(() => null);
      if (decisionChannel?.isTextBased() && typeof decisionChannel.send === 'function') {
        await decisionChannel.send({ content: notification.announcementContent, allowedMentions: { parse: [] } }).catch((error) => console.warn('[submission decision announcement]', error.message));
      }
      const logChannel = await client.channels.fetch(POINTS_LOG_CHANNEL_ID).catch(() => null);
      if (logChannel?.isTextBased() && typeof logChannel.send === 'function') {
        await logChannel.send({ embeds: [EmbedBuilder.from(notification.logEmbed)], allowedMentions: { parse: [] } }).catch((error) => console.warn('[submission points log]', error.message));
      }
      const memberUser = await client.users.fetch(result.current.user_id).catch(() => null);
      if (memberUser) {
        const dmEmbed = new EmbedBuilder().setTitle(approved ? '✅ تم قبول تسليم المهمة' : '❌ تم رفض تسليم المهمة').setDescription(approved ? `تم قبول التسليم #${submissionId} وإضافة **+${fmtPointsMsg(result.amount)} نقطة**. رصيدك الحالي: **${fmtPointsMsg(result.totalAfter)}** نقطة.` : `تم رفض التسليم #${submissionId}.`).setColor(approved ? 0x22c55e : 0xef4444);
        await memberUser.send({ embeds: [dmEmbed] }).catch((error) => console.warn('[submission review DM]', error.message));
      }
    }
  } catch (error) {
    console.error('[submission button interaction]', error.stack || error.message || error);
    try { await interaction.followUp({ content: `تعذر تنفيذ مراجعة التسليم: ${cleanText(error.message || 'خطأ غير معروف', 240)}`, ephemeral: true }); } catch {}
  }
}

client.on('error', (error) => { botLastError = error.message; console.error('[discord] Client error:', error); });

function buildLeaveEmbed(item, status = 'pending', reviewerId = '', note = '') {
  const id = Number(item.id);
  const userId = String(item.user_id ?? item.userId ?? '');
  const startDate = String(item.start_date ?? item.startDate ?? '').slice(0, 10);
  const endDate = String(item.end_date ?? item.endDate ?? '').slice(0, 10);
  const reason = String(item.reason || 'بدون سبب').slice(0, 1024);
  const approved = status === 'approved';
  const rejected = status === 'rejected';
  const fields = [
    { name: '👤 العضو', value: `<@${userId}>\n\`${userId}\``, inline: true },
    { name: '📅 من', value: startDate || '—', inline: true },
    { name: '📅 إلى', value: endDate || '—', inline: true },
    { name: '📝 السبب', value: reason, inline: false },
  ];
  if (status === 'pending') fields.push({ name: '🔎 المراجعة', value: `رقم الطلب: #${id}\nاستخدم زري القبول أو الرفض هنا، أو راجع الطلب من الموقع.`, inline: false });
  else {
    fields.push({ name: '🛡️ المراجع', value: reviewerId ? `<@${reviewerId}>` : 'الإدارة', inline: true });
    if (note) fields.push({ name: '🗒️ ملاحظة الإدارة', value: String(note).slice(0, 1024), inline: false });
  }
  const embed = new EmbedBuilder()
    .setColor(status === 'pending' ? 0x8b5cf6 : approved ? 0x22c55e : 0xef4444)
    .setTitle(status === 'pending' ? `🗓️ طلب إجازة جديد #${id}` : approved ? `✅ تمت الموافقة على طلب الإجازة #${id}` : `❌ تم رفض طلب الإجازة #${id}`)
    .setDescription(status === 'pending' ? 'طلب إجازة جديد بانتظار مراجعة مسؤولي الإدارة.' : approved ? 'تمت الموافقة على طلب الإجازة.' : 'تم رفض طلب الإجازة.')
    .addFields(fields)
    .setTimestamp(new Date())
    .setFooter({ text: 'إدارة البرج • طلبات الإجازة' });
  const avatar = item.avatar_url ?? item.avatarUrl;
  if (avatar) embed.setThumbnail(avatar);
  return embed;
}
function leaveReviewActionRow(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`leave:approve:${id}`).setLabel('قبول الإجازة').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`leave:reject:${id}`).setLabel('رفض الإجازة').setStyle(ButtonStyle.Danger),
  );
}

function submissionReviewActionRow(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`submission:approve:${id}`).setLabel('✅ موافقة وإضافة النقاط').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`submission:reject:${id}`).setLabel('❌ رفض التسليم').setStyle(ButtonStyle.Danger),
  );
}

async function fetchTextChannel(channelId) {
  if (!botReady) throw new Error('البوت غير متصل بديسكورد حاليًا.');
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
    throw new Error(`البوت لا يستطيع الوصول إلى الروم ${channelId}. تأكد من الروم والصلاحيات.`);
  }
  return channel;
}

async function getStaffRoster() {
  if (!botReady) throw new Error('البوت غير متصل بديسكورد.');
  const [staffGuild, mainGuild] = await Promise.all([
    client.guilds.fetch(STAFF_GUILD_ID),
    client.guilds.fetch(MAIN_GUILD_ID),
  ]);
  const [staffMembers, mainRoles, mainMembers] = await Promise.all([
    staffGuild.members.fetch(),
    mainGuild.roles.fetch(),
    mainGuild.members.fetch(),
  ]);
  const orderedRoles = [...mainRoles.values()].filter((role) => role.id !== mainGuild.id).sort((a, b) => b.position - a.position || a.name.localeCompare(b.name, 'ar'));
  const roleById = new Map(orderedRoles.map((role) => [role.id, role]));
  const mainMemberById = new Map(mainMembers.map((member) => [member.id, member]));
  const roleGroups = new Map();
  const plainMembers = [];
  const missingMainGuild = [];

  for (const member of staffMembers.values()) {
    if (member.user.bot) continue;
    const mainMember = mainMemberById.get(member.id) || null;
    const assignedRoles = mainMember
      ? [...mainMember.roles.cache.values()].filter((role) => role.id !== mainGuild.id).sort((a, b) => b.position - a.position)
      : [];
    const highest = assignedRoles[0] || null;
    const row = {
      id: member.id,
      username: mainMember?.displayName || member.user.globalName || member.displayName || member.user.username,
      handle: member.user.username,
      avatarUrl: member.displayAvatarURL({ extension: 'png', size: 64 }),
      roleName: highest ? highest.name : (mainMember ? 'بدون رتبة في السيرفر الأساسي' : 'مش موجود في السيرفر الأساسي'),
      roleId: highest ? highest.id : (mainMember ? 'none' : 'not-in-main'),
      rolePosition: highest ? highest.position : (mainMember ? -1 : -2),
      joinedAt: member.joinedAt ? new Date(member.joinedAt).toISOString() : null,
      roleColor: highest ? highest.hexColor : '#64748b',
      roles: assignedRoles.map((role) => ({ id: role.id, name: role.name, position: role.position, color: role.hexColor })),
      isAdmin: MANAGER_IDS.has(member.id) || Boolean(mainMember?.roles.cache.has(MANAGEMENT_MAIN_ROLE_ID)) || Boolean(mainMember?.permissions.has(PermissionsBitField.Flags.Administrator)),
    };
    if (!mainMember) {
      missingMainGuild.push(row);
    } else if (highest && roleById.has(highest.id)) {
      if (!roleGroups.has(highest.id)) roleGroups.set(highest.id, []);
      roleGroups.get(highest.id).push(row);
    } else {
      plainMembers.push(row);
    }
  }
  for (const list of roleGroups.values()) list.sort((a, b) => a.username.localeCompare(b.username, 'ar'));
  plainMembers.sort((a, b) => a.username.localeCompare(b.username, 'ar'));
  missingMainGuild.sort((a, b) => a.username.localeCompare(b.username, 'ar'));
  const groups = orderedRoles.map((role) => ({
    id: role.id, name: role.name, position: role.position, color: role.hexColor,
    members: roleGroups.get(role.id) || [],
  })).filter((group) => group.members.length > 0);
  if (plainMembers.length) groups.push({ id: 'none', name: 'بدون رتبة في السيرفر الأساسي', position: -1, color: '#64748b', members: plainMembers });
  if (missingMainGuild.length) groups.push({ id: 'not-in-main', name: 'مش موجودين في السيرفر الأساسي', position: -2, color: '#64748b', members: missingMainGuild });
  return { guildName: mainGuild.name, memberCount: groups.reduce((sum, group) => sum + group.members.length, 0), groups };
}

// OAuth2 login through Discord.
app.get('/auth/discord', authLimiter, (req, res) => {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) return res.status(503).send('أكمل إعدادات Discord OAuth داخل ملف .env أولًا.');
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds',
    state,
    prompt: 'consent',
  });
  req.session.save((error) => {
    if (error) return res.status(500).send('تعذر بدء تسجيل الدخول.');
    res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
  });
});

app.get('/auth/callback', authLimiter, async (req, res) => {
  const code = cleanText(req.query.code, 2048);
  const state = cleanText(req.query.state, 200);
  if (!code || !state || !req.session.oauthState || state !== req.session.oauthState) {
    return res.status(400).send('رابط تسجيل الدخول غير صالح أو انتهت صلاحيته. ارجع للموقع وجرّب مرة أخرى.');
  }
  delete req.session.oauthState;
  try {
    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) throw new Error('فشل Discord في إتمام تسجيل الدخول. راجع Client Secret وRedirect URI.');

    const headers = { Authorization: `Bearer ${tokenData.access_token}` };
    const [userResponse, guildsResponse] = await Promise.all([
      fetch('https://discord.com/api/v10/users/@me', { headers }),
      fetch('https://discord.com/api/v10/users/@me/guilds', { headers }),
    ]);
    if (!userResponse.ok || !guildsResponse.ok) throw new Error('تعذر التحقق من حساب Discord.');
    const discordUser = await userResponse.json();
    const guilds = await guildsResponse.json();
    const staffGuild = guilds.find((guild) => guild.id === STAFF_GUILD_ID);
    const mainGuild = guilds.find((guild) => guild.id === MAIN_GUILD_ID);
    const isManager = MANAGER_IDS.has(discordUser.id);
    const [mainMemberForRoles, staffMemberForRoles] = await Promise.all([
      client.guilds.fetch(MAIN_GUILD_ID).then((guild) => guild.members.fetch(discordUser.id)).catch(() => null),
      client.guilds.fetch(STAFF_GUILD_ID).then((guild) => guild.members.fetch(discordUser.id)).catch(() => null),
    ]);
    const hasManagementRole = Boolean(mainMemberForRoles?.roles.cache.has(MANAGEMENT_MAIN_ROLE_ID));
    // الإدارة في الموقع تُحدد من السيرفر الأساسي فقط، وليس من رتب سيرفر الاستاف.
    const isAdmin = hasAdministratorPermission(mainGuild) || hasManagementRole;
    if (!staffGuild && !isAdmin && !isManager) {
      return res.status(403).send(`الحساب ده مش عضو في سيرفر الاستاف، ومش معاه صلاحية Administrator في السيرفر الأساسي. ادخل سيرفر الاستاف (${STAFF_GUILD_ID}) ثم جرّب تاني.`);
    }
    req.session.user = {
      id: discordUser.id,
      username: discordUser.global_name || discordUser.username,
      handle: discordUser.username,
      avatar: discordUser.avatar || null,
      avatarUrl: avatarUrl(discordUser),
      isAdmin,
      isManager,
      isStaffGuildMember: Boolean(staffGuild),
    };
    req.session.save((error) => {
      if (error) return res.status(500).send('تعذر حفظ جلسة تسجيل الدخول.');
      return res.redirect('/');
    });
  } catch (error) {
    console.error('[oauth]', error.message);
    res.status(502).send(`تعذر تسجيل الدخول: ${cleanText(error.message, 240)}`);
  }
});

app.post('/auth/logout', requireAuth, (req, res) => {
  req.session.destroy((error) => {
    if (error) return res.status(500).json({ error: 'تعذر تسجيل الخروج.' });
    res.clearCookie('borg.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    res.json({ ok: true });
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, botReady, botLastError: botReady ? '' : botLastError, databaseReady: Boolean(db), storageReady: fs.existsSync(UPLOAD_DIR) }));
app.get('/api/me', async (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false });
  await refreshRequestSessionUser(req);
  res.set('Cache-Control', 'no-store');
  res.json({ authenticated: true, user: { ...req.session.user, avatarUrl: profileAvatar(req.session.user), canManage: canManage(req.session.user) } });
});

app.get('/api/roster', requireAuth, async (req, res) => {
  try { res.json(await getStaffRoster()); }
  catch (error) {
    console.error('[roster]', error.message);
    res.status(503).json({ error: `تعذر تحميل قائمة الاستاف: ${cleanText(error.message, 220)}` });
  }
});


// ───────── بيانات صفحة بروفايل العضو ─────────
function cairoTodayString() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function shiftDayString(day, delta) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}
// dayCounts: [{day:'YYYY-MM-DD' (بتوقيت القاهرة), count}] — hourCounts: [{hour:0-23 (بتوقيت القاهرة), count}]
function buildMessageProfile({ firstAt = null, lastAt = null, dayCounts = [], hourCounts = [] } = {}) {
  const byDay = new Map(dayCounts.map((row) => [String(row.day).slice(0, 10), Number(row.count) || 0]));
  const today = cairoTodayString();
  const sumDays = (n) => { let sum = 0; for (let i = 0; i < n; i += 1) sum += byDay.get(shiftDayString(today, -i)) || 0; return sum; };
  const total = [...byDay.values()].reduce((a, b) => a + b, 0);
  const activity = Array.from({ length: 14 }, (_, i) => { const date = shiftDayString(today, -(13 - i)); return { date, count: byDay.get(date) || 0 }; });
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  for (const row of hourCounts) { const hour = Number(row.hour); if (Number.isInteger(hour) && hour >= 0 && hour < 24) hours[hour].count = Number(row.count) || 0; }
  const topHour = hours.reduce((best, cur) => (cur.count > best.count ? cur : best), { hour: null, count: 0 });
  let busiestDay = null;
  for (const [date, count] of byDay) if (!busiestDay || count > busiestDay.count) busiestDay = { date, count };
  let avgPerDay = 0;
  if (total && byDay.size) {
    const firstDay = [...byDay.keys()].sort()[0];
    const spanDays = Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / 86400000) + 1);
    avgPerDay = Math.round((total / spanDays) * 10) / 10;
  }
  return { total, today: byDay.get(today) || 0, week: sumDays(7), month: sumDays(30), avgPerDay, activeDays: byDay.size, firstAt, lastAt, busiestHour: topHour.count ? topHour.hour : null, busiestDay, activity, hours };
}
function rankOf(allStats, userId, field) {
  const rows = allStats.filter((row) => Number(row[field]) > 0).sort((a, b) => Number(b[field]) - Number(a[field]));
  const index = rows.findIndex((row) => String(row.userId) === String(userId));
  return { rank: index >= 0 ? index + 1 : null, of: rows.length };
}

app.get('/api/admin-monitoring', requireAuth, requireManager, (req, res) => {
  try {
    const siteActivity = db.prepare('SELECT user_id AS userId, username, avatar_url AS avatarUrl, last_seen AS lastSeen FROM site_presence ORDER BY last_seen DESC LIMIT 1000').all();
    const activeTasks = db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE active = 1').get()?.count || 0;
    const requiredActiveTasks = db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE active = 1 AND required = 1').get()?.count || 0;
    const submissions = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('submitted','pending') THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved, SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected FROM submissions").get() || {};
    const pendingStaffRequests = db.prepare("SELECT COUNT(*) AS count FROM staff_requests WHERE status = 'pending'").get()?.count || 0;
    const pendingLeaveRequests = db.prepare("SELECT COUNT(*) AS count FROM leave_requests WHERE status = 'pending'").get()?.count || 0;
    const reviewDecisions24h = db.prepare('SELECT COUNT(*) AS count FROM submission_review_audit WHERE created_at >= ?').get(new Date(Date.now() - 86400000).toISOString())?.count || 0;
    const totalReviewDecisions = db.prepare('SELECT COUNT(*) AS count FROM submission_review_audit').get()?.count || 0;
    res.set('Cache-Control', 'no-store');
    res.json({ generatedAt: nowIso(), siteActivity, metrics: { activeTasks: Number(activeTasks), requiredActiveTasks: Number(requiredActiveTasks), dueWithin24Hours: 0, totalSubmissions: Number(submissions.total || 0), pendingSubmissions: Number(submissions.pending || 0), approvedSubmissions: Number(submissions.approved || 0), rejectedSubmissions: Number(submissions.rejected || 0), pendingStaffRequests: Number(pendingStaffRequests), pendingLeaveRequests: Number(pendingLeaveRequests), reviewDecisions24h: Number(reviewDecisions24h), totalReviewDecisions: Number(totalReviewDecisions) } });
  } catch (error) {
    console.error('[admin monitoring]', error.message);
    res.status(500).json({ error: 'تعذر تحميل تفاصيل مراقبة الإدارة.' });
  }
});

app.get('/api/task-stats', requireAuth, requireManager, (req, res) => {
  try {
    const totals = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved, SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected, SUM(CASE WHEN status IN ('pending','submitted') THEN 1 ELSE 0 END) AS pending FROM submissions").get();
    const all = getAllStaffStats();
    const mostActive = [...all].filter((x) => Number(x.totalSubmissions || 0) > 0).sort((a,b) => Number(b.totalSubmissions || 0) - Number(a.totalSubmissions || 0)).slice(0,10).map((x) => ({ userId:x.userId, username:x.username, submissions:Number(x.totalSubmissions || 0), approved:Number(x.approvedSubmissions || 0), rejected:Number(x.rejectedSubmissions || 0) }));
    const inactive = [...all].filter((x) => !x.lastSeen).slice(0,50).map((x) => ({ userId:x.userId, username:x.username, submissions:Number(x.totalSubmissions || 0), lastSubmission:null }));
    res.set('Cache-Control', 'no-store'); res.json({ totals: Object.fromEntries(Object.entries(totals || {}).map(([key,value]) => [key, Number(value || 0)])), mostActive, inactive, inactiveDays:14 });
  } catch (error) { console.error('[task stats]', error.message); res.status(500).json({ error: 'تعذر تحميل إحصائيات التسليمات.' }); }
});

app.get('/api/submission-audit', requireAuth, requireManager, (req, res) => {
  try {
    const entries = db.prepare('SELECT id, submission_id AS submissionId, member_id AS memberId, member_name AS memberName, decision, reviewer_id AS reviewerId, reviewer_name AS reviewerName, reason, created_at AS createdAt FROM submission_review_audit ORDER BY id DESC LIMIT 100').all();
    res.set('Cache-Control', 'no-store'); res.json({ entries });
  } catch (error) { console.error('[submission audit]', error.message); res.status(500).json({ error: 'تعذر تحميل سجل قرارات التسليم.' }); }
});

app.get('/api/audit-log', requireAuth, requireManager, async (req, res) => {
  try {
    const guild = await client.guilds.fetch(MAIN_GUILD_ID);
    const actionRaw = req.query.actionType ? Number(req.query.actionType) : undefined;
    const userId = /^\d{15,22}$/.test(String(req.query.userId || '')) ? String(req.query.userId) : undefined;
    const before = /^\d{15,22}$/.test(String(req.query.before || '')) ? String(req.query.before) : undefined;
    const audit = await guild.fetchAuditLogs({ limit: 50, ...(Number.isInteger(actionRaw) && actionRaw > 0 ? { type: actionRaw } : {}), ...(userId ? { user: userId } : {}), ...(before ? { before } : {}) });
    const labelByAction = { 1:['تعديل إعدادات السيرفر','edit'], 10:['إنشاء روم','create'], 11:['تعديل روم','edit'], 12:['حذف روم','danger'], 20:['طرد عضو','danger'], 22:['حظر عضو','danger'], 23:['فك حظر','create'], 24:['تعديل عضو','edit'], 25:['تعديل رتب عضو','edit'], 28:['إضافة بوت','create'], 30:['إنشاء رتبة','create'], 31:['تعديل رتبة','edit'], 32:['حذف رتبة','danger'], 40:['إنشاء دعوة','create'], 72:['حذف رسالة','danger'], 73:['حذف رسائل جماعي','danger'] };
    const entries = [...audit.entries.values()].map((entry) => {
      const [label, tone] = labelByAction[Number(entry.action)] || [`حدث #${Number(entry.action)}`, 'edit'];
      const actor = entry.executor;
      const target = entry.target;
      return { id:String(entry.id), createdAt:entry.createdAt?.toISOString?.() || nowIso(), actionType:Number(entry.action), label, tone,
        actor: actor ? { id:String(actor.id), username:actor.globalName || actor.username, avatarUrl:actor.displayAvatarURL?.({extension:'png',size:64}) || '' } : { id:'', username:'غير معروف', avatarUrl:'' },
        targetId: target?.id ? String(target.id) : '', targetName: target?.displayName || target?.globalName || target?.username || '', targetAvatarUrl: target?.displayAvatarURL?.({extension:'png',size:64}) || '',
        reason: cleanText(entry.reason || '',300), changes: (entry.changes || []).slice(0,8).map((change) => ({ key:cleanText(change.key,40), oldValue:cleanText(JSON.stringify(change.old ?? ''),200), newValue:cleanText(JSON.stringify(change.new ?? ''),200) })),
        count:Number(entry.extra?.count || entry.extra?.count || 0), channelId:String(entry.extra?.channel?.id || '') };
    });
    res.set('Cache-Control','no-store'); res.json({ entries, hasMore: entries.length >= 50, nextBefore: entries.length ? entries[entries.length - 1].id : null });
  } catch (error) { console.error('[audit log]', error.message); res.status(503).json({ error: 'تعذر تحميل سجل Discord. تأكد من صلاحية View Audit Log للبوت في السيرفر الأساسي.' }); }
});

app.get('/api/staff-stats', requireAuth, (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ stats: getAllStaffStats(), dailyDate: getDailyStaffMessageStats().dailyDate }); }
  catch (error) { res.status(500).json({ error: `تعذر تحميل الإحصائيات: ${cleanText(error.message, 180)}` }); }
});
app.get('/api/staff-stats/:userId', requireAuth, (req, res) => {
  const targetId = cleanText(req.params.userId, 24);
  if (!/^\d{15,22}$/.test(targetId)) return res.status(400).json({ error: 'Discord ID غير صالح.' });
  const stats = getAllStaffStats().find((row) => row.userId === targetId) || { userId: targetId, dailyMessages: 0, totalMessages: 0, totalSubmissions: 0, approvedSubmissions: 0, pendingSubmissions: 0, rejectedSubmissions: 0, totalPoints: 0, leaveRequests: 0, adminRequests: 0, online: false, lastSeen: null };
  const recentSubmissions = db.prepare('SELECT id, submitted_at AS submittedAt, status, note FROM submissions WHERE user_id = ? ORDER BY submitted_at DESC LIMIT 10').all(targetId);
  const recentLeaves = db.prepare('SELECT id, start_date AS startDate, end_date AS endDate, reason, status, created_at AS createdAt, review_note AS reviewNote FROM leave_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').all(targetId);
  const recentPoints = db.prepare('SELECT id, amount, reason, source, created_at AS createdAt FROM staff_points WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(targetId).map((row) => ({ ...row, amount: Number(row.amount) || 0 }));
  const recentRequests = db.prepare('SELECT id, request_type AS requestType, subject, status, created_at AS createdAt FROM staff_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 5').all(targetId);
  // تجميع رسائل العضو بتوقيت القاهرة (SQLite مفيهوش timezone)
  const logRows = db.prepare('SELECT created_at AS createdAt FROM discord_message_log WHERE channel_id = ? AND user_id = ?').all(MESSAGE_COUNT_CHANNEL_ID, targetId);
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });
  const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', hourCycle: 'h23' });
  const dayMap = new Map(); const hourMap = new Map(); let firstAt = null; let lastAt = null;
  for (const row of logRows) {
    const date = new Date(row.createdAt);
    if (Number.isNaN(date.getTime())) continue;
    const day = dayFmt.format(date); const hour = Number(hourFmt.format(date));
    dayMap.set(day, (dayMap.get(day) || 0) + 1); hourMap.set(hour, (hourMap.get(hour) || 0) + 1);
    if (!firstAt || row.createdAt < firstAt) firstAt = row.createdAt;
    if (!lastAt || row.createdAt > lastAt) lastAt = row.createdAt;
  }
  const messageProfile = buildMessageProfile({ firstAt, lastAt, dayCounts: [...dayMap].map(([day, count]) => ({ day, count })), hourCounts: [...hourMap].map(([hour, count]) => ({ hour, count })) });
  const allStats = getAllStaffStats();
  res.set('Cache-Control', 'no-store');
  res.json({ stats, messageProfile, ranks: { messages: rankOf(allStats, targetId, 'totalMessages'), points: rankOf(allStats, targetId, 'totalPoints') }, recentPoints, recentRequests, recentSubmissions, recentLeaves });
});

app.get('/api/tasks', requireAuth, (req, res) => {
  const tasks = db.prepare('SELECT id, title, required, active, created_by_name, created_at FROM tasks WHERE active = 1 ORDER BY required DESC, id DESC').all();
  const completed = new Set(db.prepare(`
    SELECT DISTINCT st.task_id FROM submission_tasks st
    JOIN submissions s ON s.id = st.submission_id
    WHERE s.user_id = ? AND s.status = 'submitted'
  `).all(req.session.user.id).map((row) => row.task_id));
  const data = tasks.map((task) => ({ ...task, required: Boolean(task.required), completedByMe: completed.has(task.id) }));
  const requiredTasks = data.filter((task) => task.required);
  res.json({
    tasks: data,
    stats: {
      active: data.length,
      required: requiredTasks.length,
      completedRequired: requiredTasks.filter((task) => task.completedByMe).length,
      completedByMe: data.filter((task) => task.completedByMe).length,
    },
  });
});

app.post('/api/tasks', requireAuth, requireManager, async (req, res) => {
  const raw = Array.isArray(req.body.tasks) ? req.body.tasks : [];
  if (!raw.length || raw.length > 40) return res.status(400).json({ error: 'أضف من مهمة واحدة إلى 40 مهمة في المرة الواحدة.' });
  const tasks = [];
  for (const item of raw) {
    const title = cleanText(typeof item === 'string' ? item : item.title, 240);
    if (!title) continue;
    tasks.push({ title, required: typeof item === 'string' ? false : Boolean(item.required) });
  }
  if (!tasks.length) return res.status(400).json({ error: 'اكتب اسم مهمة صحيح.' });

  const create = db.prepare('INSERT INTO tasks(title, required, active, created_by, created_by_name, created_at) VALUES (?, ?, 1, ?, ?, ?)');
  const created = [];
  const transaction = db.transaction(() => {
    for (const task of tasks) {
      const info = create.run(task.title, task.required ? 1 : 0, req.session.user.id, req.session.user.username, nowIso());
      created.push({ id: Number(info.lastInsertRowid), ...task });
    }
  });
  transaction();

  let discordPosted = false;
  let discordWarning = '';
  try {
    const channel = await fetchTextChannel(TASKS_CHANNEL_ID);
    const batches = [];
    let batch = [];
    let currentLength = '📋 مهمات جديدة | إدارة البرج\n'.length;
    for (const task of created) {
      const line = `• [${task.required ? 'إجباري' : 'اختياري'}] #${task.id} — ${task.title}`;
      if (batch.length && currentLength + line.length + 1 > 1750) {
        batches.push(batch);
        batch = [];
        currentLength = '📋 مهمات جديدة | إدارة البرج\n'.length;
      }
      batch.push({ ...task, line });
      currentLength += line.length + 1;
    }
    if (batch.length) batches.push(batch);
    for (const [batchIndex, batchRows] of batches.entries()) {
      const pingRole = batchIndex === 0 && /^\d{15,22}$/.test(TASK_PING_ROLE_ID); // المنشن في أول رسالة بس
      const message = await channel.send({
        content: `${pingRole ? `<@&${TASK_PING_ROLE_ID}> ` : ''}📋 **مهمات جديدة | إدارة البرج**\n${batchRows.map((row) => row.line).join('\n')}`,
        allowedMentions: pingRole ? { parse: [], roles: [TASK_PING_ROLE_ID] } : { parse: [] },
      });
      batchRows.forEach((row, index) => {
        db.prepare('UPDATE tasks SET source_message_id = ?, source_line_index = ? WHERE id = ?').run(message.id, index, row.id);
      });
    }
    discordPosted = true;
  } catch (error) {
    discordWarning = error.message;
    console.error('[tasks post]', error.message);
  }
  res.status(201).json({ created, discordPosted, warning: discordWarning, message: discordPosted ? 'تم إنشاء المهمات ونشرها في روم المهمات.' : 'تم حفظ المهمات في الموقع، لكن البوت لم يستطع نشرها في ديسكورد.' });
});

app.delete('/api/tasks/:id', requireAuth, requireManager, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'رقم المهمة غير صالح.' });
  const task = db.prepare('SELECT id FROM tasks WHERE id = ? AND active = 1').get(id);
  if (!task) return res.status(404).json({ error: 'المهمة مش موجودة أو تم حذفها بالفعل.' });
  db.prepare('UPDATE tasks SET active = 0 WHERE id = ?').run(id);
  return res.json({ ok: true, message: 'تم حذف المهمة من القائمة الحالية، وسجل التسليمات القديم محفوظ.' });
});

app.patch('/api/tasks/:id', requireAuth, requireManager, async (req, res) => {
  const id = Number(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND active = 1').get(id);
  if (!task) return res.status(404).json({ error: 'المهمة مش موجودة أو اتقفلت.' });
  const updates = {};
  if (typeof req.body.required === 'boolean') updates.required = req.body.required ? 1 : 0;
  if (typeof req.body.active === 'boolean') updates.active = req.body.active ? 1 : 0;
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'مفيش تعديل صالح.' });
  if (Object.hasOwn(updates, 'required')) db.prepare('UPDATE tasks SET required = ? WHERE id = ?').run(updates.required, id);
  if (Object.hasOwn(updates, 'active')) db.prepare('UPDATE tasks SET active = ? WHERE id = ?').run(updates.active, id);
  const current = db.prepare('SELECT id, title, required, active FROM tasks WHERE id = ?').get(id);
  if (Object.hasOwn(updates, 'required')) {
    try {
      const channel = await fetchTextChannel(TASKS_CHANNEL_ID);
      await channel.send({ content: `⚙️ تحديث إعداد المهمة #${id}: **${task.title}** أصبحت ${updates.required ? 'إجبارية' : 'اختيارية'}.`, allowedMentions: { parse: [] } });
    } catch (error) { console.warn('[task update note]', error.message); }
  }
  res.json({ task: { ...current, required: Boolean(current.required), active: Boolean(current.active) } });
});

const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.webm', '.m4v', '.mkv', '.avi']);
const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
  filename: (_req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
    callback(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 10, fields: 15, fieldSize: 25000 },
  fileFilter: (_req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ((file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) && allowedExtensions.has(ext)) return callback(null, true);
    callback(new Error('ارفع صور أو فيديو فقط وبامتداد مدعوم.'));
  },
});

app.post('/api/submissions', requireAuth, (req, res) => {
  upload.array('evidenceFiles', 10)(req, res, async (uploadError) => {
    if (uploadError) {
      return res.status(400).json({ error: uploadError.code === 'LIMIT_FILE_SIZE' ? `حجم الملف أكبر من الحد (${MAX_UPLOAD_MB}MB).` : cleanText(uploadError.message, 250) });
    }
    const files = req.files || [];
    try {
      const taskIdsRaw = cleanText(req.body.taskIds, 4000);
      let taskIds;
      try { taskIds = JSON.parse(taskIdsRaw); } catch { taskIds = []; }
      if (!Array.isArray(taskIds)) taskIds = [];
      taskIds = [...new Set(taskIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 40);
      if (!taskIds.length) throw new Error('اختار مهمة واحدة على الأقل.');
      const foundTasks = db.prepare(`SELECT id, title, required, points FROM tasks WHERE active = 1 AND id IN (${taskIds.map(() => '?').join(',')})`).all(...taskIds);
      if (!foundTasks.length || foundTasks.length !== taskIds.length) throw new Error('في مهمة من اللي اخترتها مش موجودة أو اتقفلت. حدّث الصفحة وجرب تاني.');

      const linksText = cleanText(req.body.evidenceLinks, 12000);
      const links = linksText.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
      for (const link of links) {
        let parsed;
        try { parsed = new URL(link); } catch { throw new Error(`الرابط ده مش صحيح: ${link.slice(0, 90)}`); }
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('روابط الأدلة لازم تبدأ بـ http أو https.');
      }
      if (!links.length && !files.length) throw new Error('ضيف رابط دليل أو ارفع صورة/فيديو قبل الإرسال.');
      const note = cleanText(req.body.note, 600);
      const storedFiles = files.map((file) => ({
        filename: file.filename,
        originalName: cleanText(file.originalname, 180),
        mimeType: file.mimetype,
        size: file.size,
        url: `${SITE_URL}/uploads/${encodeURIComponent(file.filename)}`,
        attachToDiscord: file.size <= ATTACHMENT_LIMIT_MB * 1024 * 1024,
      }));
      const insertSubmission = db.prepare(`INSERT INTO submissions(user_id, username, avatar_url, note, evidence_links, files_json, submitted_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted')`);
      const linkSubmission = db.prepare('INSERT INTO submission_tasks(submission_id, task_id) VALUES (?, ?)');
      const tx = db.transaction(() => {
        const info = insertSubmission.run(req.session.user.id, req.session.user.username, profileAvatar(req.session.user), note, JSON.stringify(links), JSON.stringify(storedFiles), nowIso());
        for (const taskId of taskIds) linkSubmission.run(Number(info.lastInsertRowid), taskId);
        return Number(info.lastInsertRowid);
      });
      const submissionId = tx();

      let discordPosted = false;
      let warning = '';
      try {
        const channel = await fetchTextChannel(SUBMISSION_REVIEW_CHANNEL_ID);
        const taskText = foundTasks.map((task) => `• ${task.required ? '🔴 إجباري' : '⚪ اختياري'} — **${cleanText(task.title, 140)}**`).join('\n').slice(0, 1024) || 'لم يتم تحديد مهمة.';
        const uploadedText = storedFiles.map((file) => `• [${cleanText(file.originalName, 120)}](${file.url})`).join('\n').slice(0, 1024) || 'لا توجد ملفات مرفوعة.';
        const linksTextForDiscord = links.map((link) => `• ${link}`).join('\n').slice(0, 1024) || 'لا توجد روابط خارجية.';
        const embed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle(`📨 دليل مهمة جديد #${submissionId}`)
          .setDescription('وصل دليل جديد من عضو الاستاف، والتسليم بانتظار مراجعة المسؤولين. استخدم زري الموافقة أو الرفض أدناه.')
          .addFields(
            { name: '👤 العضو', value: `<@${req.session.user.id}>\n\`${req.session.user.id}\``, inline: true },
            { name: '🧾 رقم التسليم', value: `#${submissionId}`, inline: true },
            { name: `🎯 المهمة المحددة (${foundTasks.length})`, value: taskText, inline: false },
            { name: '📎 ملفات الدليل', value: uploadedText, inline: false },
            { name: '🔗 روابط إضافية', value: linksTextForDiscord, inline: false },
            ...(note ? [{ name: '📝 ملاحظة العضو', value: note.slice(0, 1024), inline: false }] : []),
          )
          .setTimestamp(new Date())
          .setFooter({ text: 'إدارة البرج • مراجعة أدلة المهمات' });
        const firstImageFile = files.find((file) => /^image\//i.test(String(file.mimetype || '')) && file.size <= ATTACHMENT_LIMIT_MB * 1024 * 1024);
        if (firstImageFile) embed.setImage(`attachment://${path.basename(firstImageFile.originalname)}`);
        const attachable = files.filter((file) => file.size <= ATTACHMENT_LIMIT_MB * 1024 * 1024).map((file) => new AttachmentBuilder(file.path, { name: path.basename(file.originalname) }));
        const posted = await channel.send({ embeds: [embed], files: attachable, components: [submissionReviewActionRow(submissionId)], allowedMentions: { parse: [] } });
        db.prepare('UPDATE submissions SET discord_message_id = ?, discord_channel_id = ? WHERE id = ?').run(String(posted.id), String(channel.id), submissionId);
        discordPosted = true;
      } catch (error) {
        warning = error.message;
        console.error('[submission post]', error.message);
      }
      res.status(201).json({ ok: true, submissionId, discordPosted, warning, message: discordPosted ? 'اتسجل تسليم المهمة واترسل لروم المراجعة فقط.' : 'اتسجل التسليم في الموقع، لكن البوت لم يستطع إرساله لروم المراجعة.' });
    } catch (error) {
      for (const file of files) {
        try { fs.unlinkSync(file.path); } catch { /* ignore cleanup errors */ }
      }
      res.status(400).json({ error: cleanText(error.message || 'تعذر تسجيل التسليم.', 300) });
    }
  });
});

app.get('/api/submissions', requireAuth, (req, res) => {
  const isManager = canManage(req.session.user);
  const query = isManager
    ? `SELECT * FROM submissions ORDER BY id DESC LIMIT 80`
    : `SELECT * FROM submissions WHERE user_id = ? ORDER BY id DESC LIMIT 40`;
  const rows = isManager ? db.prepare(query).all() : db.prepare(query).all(req.session.user.id);
  const mapTasks = db.prepare(`SELECT t.id, t.title, t.required FROM submission_tasks st JOIN tasks t ON t.id = st.task_id WHERE st.submission_id = ? ORDER BY t.required DESC, t.id`);
  const data = rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    username: row.username,
    avatarUrl: row.avatar_url,
    note: row.note,
    evidenceLinks: JSON.parse(row.evidence_links || '[]'),
    files: JSON.parse(row.files_json || '[]'),
    submittedAt: row.submitted_at,
    status: row.status,
    tasks: mapTasks.all(row.id).map((task) => ({ ...task, required: Boolean(task.required) })),
  }));
  res.json({ submissions: data });
});

app.post('/api/leave-requests', requireAuth, async (req, res) => {
  const startDate = cleanText(req.body?.startDate, 10);
  const endDate = cleanText(req.body?.endDate, 10);
  const reason = cleanText(req.body?.reason, 600);
  const cairoTodayString = () => {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date());
      const dateParts = Object.fromEntries(parts.map(part => [part.type, part.value]));
      return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    };
    const validDate = (value) => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const parsed = new Date(`${value}T00:00:00.000Z`);
      // Reject non-existent dates (e.g. 2026-02-30) and unusual years by round-tripping.
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
      const today = cairoTodayString();
      const maxDateObject = new Date(`${today}T00:00:00.000Z`);
      maxDateObject.setUTCFullYear(maxDateObject.getUTCFullYear() + 5);
      const maxDate = maxDateObject.toISOString().slice(0, 10);
      // ISO calendar dates sort chronologically as strings, so past dates (including year 1111) fail.
      return value >= today && value <= maxDate;
    };
  if (!validDate(startDate) || !validDate(endDate) || endDate < startDate) return res.status(400).json({ error: 'اختار تاريخًا صحيحًا من اليوم وحتى 5 سنوات قادمة، وتأكد إن تاريخ النهاية ليس قبل البداية.' });
  if (!reason) return res.status(400).json({ error: 'اكتب سبب طلب الإجازة.' });
  const user = req.session.user;
  const result = db.prepare(`INSERT INTO leave_requests(user_id, username, avatar_url, start_date, end_date, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(user.id, user.username, profileAvatar(user), startDate, endDate, reason, nowIso());
  const id = Number(result.lastInsertRowid);
  let discordPosted = false;
  try {
    const channel = await fetchTextChannel(LEAVE_REQUEST_CHANNEL_ID);
    const posted = await channel.send({ embeds: [buildLeaveEmbed({ id, user_id: user.id, username: user.username, avatar_url: profileAvatar(user), start_date: startDate, end_date: endDate, reason }, 'pending')], components: [leaveReviewActionRow(id)], allowedMentions: { parse: [] } });
    db.prepare('UPDATE leave_requests SET discord_message_id = ?, discord_channel_id = ? WHERE id = ?').run(posted.id, channel.id, id);
    discordPosted = true;
  } catch (error) { console.error('[leave request post]', error.message); }
  res.status(201).json({ ok: true, id, discordPosted, message: discordPosted ? 'تم إرسال طلب الإجازة لروم الإدارة.' : 'تم حفظ الطلب، لكن تعذر إرساله إلى روم الإجازات 1556945732957765722. تأكد من توكن البوت وصلاحياته.' });
});
app.get('/api/leave-requests', requireAuth, (req, res) => {
  const user = req.session.user;
  const rows = canManage(user) ? db.prepare('SELECT * FROM leave_requests ORDER BY id DESC LIMIT 100').all() : db.prepare('SELECT * FROM leave_requests WHERE user_id = ? ORDER BY id DESC LIMIT 40').all(user.id);
  res.json({ requests: rows.map(row => ({ id: row.id, userId: row.user_id, username: row.username, avatarUrl: row.avatar_url, startDate: row.start_date, endDate: row.end_date, reason: row.reason, status: row.status, reviewNote: row.review_note, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, createdAt: row.created_at })) });
});
app.post('/api/leave-requests/:id/:action', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (!canManage(user)) return res.status(403).json({ error: 'مراجعة طلبات الإجازة متاحة لمسؤولي الإدارة فقط.' });
  const id = Number(req.params.id); const action = req.params.action;
  if (!Number.isSafeInteger(id) || id < 1 || !['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'طلب المراجعة غير صالح.' });
  const status = action === 'approve' ? 'approved' : 'rejected'; const note = cleanText(req.body?.note, 400);
  const item = db.prepare("SELECT * FROM leave_requests WHERE id = ? AND status = 'pending'").get(id);
  if (!item) return res.status(409).json({ error: 'الطلب غير موجود أو تمت مراجعته بالفعل. حدّث القائمة للتأكد من حالته.' });
  const update = db.prepare("UPDATE leave_requests SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'").run(status, note, user.id, nowIso(), id);
  if (!update.changes) return res.status(409).json({ error: 'تمت مراجعة الطلب من مسؤول آخر بالفعل.' });
  const hasOriginalMessage = Boolean(item.discord_message_id);
  let originalMessageUpdated = !hasOriginalMessage;
  let reviewLogPosted = false;
  if (item.discord_message_id) {
    try {
      const channel = await fetchTextChannel(item.discord_channel_id || LEAVE_REQUEST_CHANNEL_ID);
      const message = await channel.messages.fetch(item.discord_message_id);
      await message.edit({ embeds: [buildLeaveEmbed(item, status, user.id, note)], components: [] });
      originalMessageUpdated = true;
    } catch (error) { console.error('[leave original message update]', error.message); }
  }
  try { const channel = await fetchTextChannel(LEAVE_REQUEST_CHANNEL_ID); await channel.send({ embeds: [new EmbedBuilder().setColor(status === 'approved' ? 0x22c55e : 0xef4444).setTitle(status === 'approved' ? `✅ تمت الموافقة على طلب الإجازة #${id}` : `❌ تم رفض طلب الإجازة #${id}`).setDescription(`العضو: <@${item.user_id}>\nالمراجع: <@${user.id}>${note ? `\nملاحظة: ${note}` : ''}`).setTimestamp(new Date())], allowedMentions: { parse: [] } }); reviewLogPosted = true; } catch (error) { console.error('[leave review log]', error.message); }
  const discordPosted = hasOriginalMessage ? originalMessageUpdated : reviewLogPosted;
  const baseMessage = status === 'approved' ? 'تمت الموافقة على طلب الإجازة.' : 'تم رفض طلب الإجازة.';
  res.json({ ok: true, discordPosted, message: discordPosted ? baseMessage : `${baseMessage} لكن تعذر تحديث رسالة الطلب في ديسكورد. راجع صلاحيات البوت.` });
});


app.post('/api/staff-requests', requireAuth, async (req, res) => {
  const user = req.session.user;
  const requestType = cleanText(req.body?.requestType, 40);
  const subject = cleanText(req.body?.subject, 140);
  const details = cleanText(req.body?.details, 1200);
  const typeLabels = { permission: 'طلب إذن / غياب', technical: 'مشكلة تقنية', 'data-change': 'تعديل بيانات', complaint: 'شكوى أو ملاحظة', other: 'طلب إداري آخر' };
  if (!Object.hasOwn(typeLabels, requestType)) return res.status(400).json({ error: 'نوع الطلب غير صالح.' });
  if (!subject) return res.status(400).json({ error: 'اكتب عنوان الطلب.' });
  if (details.length < 5) return res.status(400).json({ error: 'اكتب تفاصيل أكثر عن الطلب.' });
  const result = db.prepare(`INSERT INTO staff_requests(user_id, username, avatar_url, request_type, subject, details, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(user.id, user.username, profileAvatar(user), requestType, subject, details, nowIso());
  const id = Number(result.lastInsertRowid);
  let discordPosted = false;
  try {
    const channel = await fetchTextChannel(STAFF_REQUEST_CHANNEL_ID);
    const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle(`📨 طلب إداري جديد #${id}`).setDescription('طلب جديد من الاستاف بانتظار مراجعة مسؤولي الإدارة من لوحة الموقع.').addFields(
      { name: '👤 العضو', value: `<@${user.id}>\n\`${user.id}\``, inline: true },
      { name: '📂 نوع الطلب', value: typeLabels[requestType], inline: true },
      { name: '📝 العنوان', value: subject.slice(0, 1024), inline: false },
      { name: '📄 التفاصيل', value: details.slice(0, 1024), inline: false },
      { name: '🔎 المراجعة', value: `رقم الطلب: #${id}\nالموافقة أو الرفض من لوحة إدارة البرج.`, inline: false },
    ).setTimestamp(new Date()).setFooter({ text: 'إدارة البرج • الطلبات الإدارية' });
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }); discordPosted = true;
  } catch (error) { console.error('[staff request post]', error.message); }
  res.status(201).json({ ok: true, id, discordPosted, message: discordPosted ? 'تم إرسال الطلب الإداري لروم المراجعة.' : 'تم حفظ الطلب، لكن تعذر إرساله إلى ديسكورد. راجع صلاحيات البوت.' });
});
app.get('/api/staff-requests', requireAuth, (req, res) => {
  const user = req.session.user;
  const rows = canManage(user) ? db.prepare('SELECT * FROM staff_requests ORDER BY id DESC LIMIT 100').all() : db.prepare('SELECT * FROM staff_requests WHERE user_id = ? ORDER BY id DESC LIMIT 40').all(user.id);
  res.json({ requests: rows.map((row) => ({ id: row.id, userId: row.user_id, username: row.username, avatarUrl: row.avatar_url, requestType: row.request_type, subject: row.subject, details: row.details, status: row.status, reviewNote: row.review_note, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, createdAt: row.created_at })) });
});
app.post('/api/staff-requests/:id/:action', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (!canManage(user)) return res.status(403).json({ error: 'مراجعة الطلبات الإدارية متاحة لمسؤولي الإدارة فقط.' });
  const id = Number(req.params.id), action = req.params.action;
  if (!Number.isSafeInteger(id) || id < 1 || !['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'طلب المراجعة غير صالح.' });
  const item = db.prepare("SELECT id, user_id, request_type, subject FROM staff_requests WHERE id = ? AND status = 'pending'").get(id);
  if (!item) return res.status(404).json({ error: 'الطلب غير موجود أو تمت مراجعته بالفعل.' });
  const status = action === 'approve' ? 'approved' : 'rejected';
  const note = cleanText(req.body?.note, 400);
  const update = db.prepare("UPDATE staff_requests SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'").run(status, note, user.id, nowIso(), id);
  if (!update.changes) return res.status(409).json({ error: 'تمت مراجعة الطلب من مسؤول آخر بالفعل.' });
  try {
    const channel = await fetchTextChannel(STAFF_REQUEST_CHANNEL_ID);
    await channel.send({ embeds: [new EmbedBuilder().setColor(status === 'approved' ? 0x22c55e : 0xef4444).setTitle(status === 'approved' ? `✅ تمت الموافقة على الطلب الإداري #${id}` : `❌ تم رفض الطلب الإداري #${id}`).setDescription(`نوع الطلب: ${item.request_type}\nالعنوان: ${item.subject}\nمقدم الطلب: <@${item.user_id}>\nالمراجع: <@${user.id}>${note ? `\nملاحظة: ${note}` : ''}`).setTimestamp(new Date())], allowedMentions: { parse: [] } });
  } catch (error) { console.error('[staff request review log]', error.message); }
  res.json({ ok: true, status, message: status === 'approved' ? 'تمت الموافقة على الطلب الإداري.' : 'تم رفض الطلب الإداري.' });
});

app.get('/api/discord-presence', requireAuth, async (req, res) => {
  try {
    if (!botReady) return res.json({ available: false, statuses: {}, lastSeenAt: null, ageSeconds: null });
    const guild = await client.guilds.fetch(STAFF_GUILD_ID);
    const members = await guild.members.fetch({ withPresences: true });
    const statuses = {};
    for (const member of members.values()) {
      if (member.user.bot) continue;
      statuses[member.id] = member.presence?.status || 'offline';
    }
    res.set('Cache-Control', 'no-store');
    res.json({ available: true, statuses, lastSeenAt: nowIso(), ageSeconds: 0 });
  } catch (error) {
    console.error('[discord presence]', error.message);
    res.json({ available: false, statuses: {}, lastSeenAt: null, ageSeconds: null });
  }
});

app.post('/api/presence', requireAuth, (req, res) => {
  const user = req.session.user;
  const seenAt = nowIso();
  db.prepare(`INSERT INTO site_presence(user_id, username, avatar_url, last_seen)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, avatar_url = excluded.avatar_url, last_seen = excluded.last_seen`)
    .run(user.id, user.username, profileAvatar(user), seenAt);
  res.json({ ok: true });
});

app.get('/api/presence', requireAuth, (req, res) => {
  const cutoff = new Date(Date.now() - 90 * 1000).toISOString();
  const rows = db.prepare('SELECT user_id AS userId, username, avatar_url AS avatarUrl, last_seen AS lastSeen FROM site_presence WHERE last_seen > ? ORDER BY username').all(cutoff);
  res.set('Cache-Control', 'no-store');
  res.json({ online: rows });
});

app.get('/api/chat/:room', requireAuth, (req, res) => {
  const room = req.params.room;
  if (!['staff', 'management'].includes(room)) return res.status(404).json({ error: 'غرفة الشات مش موجودة.' });
  if (!canReadRoom(req.session.user, room)) return res.status(403).json({ error: 'الشات ده مخصص للمسؤولين.' });
  const rows = db.prepare('SELECT * FROM (SELECT * FROM chat_messages WHERE room = ? ORDER BY id DESC LIMIT 100) ORDER BY id ASC').all(room);
  const dailyStats = room === 'staff' ? getDailyStaffMessageStats() : {};
  res.json({ messages: rows.map((row) => ({ id: row.id, room: row.room, userId: row.user_id, username: row.username, avatarUrl: row.avatar_url, content: row.content, createdAt: row.created_at })), ...dailyStats });
});

app.post('/api/chat/:room', requireAuth, (req, res) => {
  const room = req.params.room;
  if (!['staff', 'management'].includes(room)) return res.status(404).json({ error: 'غرفة الشات مش موجودة.' });
  if (!canReadRoom(req.session.user, room)) return res.status(403).json({ error: 'الشات ده مخصص للمسؤولين.' });
  const content = cleanText(req.body.content, 1500);
  if (!content) return res.status(400).json({ error: 'اكتب رسالة قبل الإرسال.' });
  const info = db.prepare('INSERT INTO chat_messages(room, user_id, username, avatar_url, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(room, req.session.user.id, req.session.user.username, profileAvatar(req.session.user), content, nowIso());
  const message = { id: Number(info.lastInsertRowid), room, userId: req.session.user.id, username: req.session.user.username, avatarUrl: profileAvatar(req.session.user), content, createdAt: nowIso() };
  const dailyStats = room === 'staff' ? getDailyStaffMessageStats() : {};
  io.to(`chat:${room}`).emit('chat:new', message);
  res.status(201).json({ message, ...dailyStats });
});

// Evidence stays behind authentication because it may contain internal staff material.
app.get('/uploads/:filename', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const fullPath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(fullPath) || !fullPath.startsWith(`${UPLOAD_DIR}${path.sep}`)) return res.status(404).send('الملف غير موجود.');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(fullPath);
});

io.use((socket, next) => {
  const user = socket.request.session?.user;
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  next();
});
io.on('connection', (socket) => {
  socket.on('chat:join', (room) => {
    if (!['staff', 'management'].includes(room)) return;
    if (!canReadRoom(socket.data.user, room)) return;
    socket.join(`chat:${room}`);
  });
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path.startsWith('/uploads/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.use((error, _req, res, _next) => {
  console.error('[server error]', error);
  if (res.headersSent) return;
  res.status(500).json({ error: 'حدث خطأ غير متوقع في الموقع.' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[web] إدارة البرج is running at ${SITE_URL}`);
  if (BOT_TOKEN) {
    client.login(BOT_TOKEN).catch((error) => {
      botLastError = error.message;
      console.error('[discord] Login failed:', error.message);
    });
  }
});

process.on('SIGINT', async () => {
  try { await client.destroy(); } catch { /* ignore */ }
  db.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  try { await client.destroy(); } catch { /* ignore */ }
  db.close();
  process.exit(0);
});
