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
const {
  Client,
  GatewayIntentBits,
  Events,
  AttachmentBuilder,
  EmbedBuilder,
  PermissionsBitField,
} = require('discord.js');

const PORT = Number(process.env.PORT || 3000);
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `${SITE_URL}/auth/callback`;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const MAIN_GUILD_ID = process.env.MAIN_GUILD_ID || '883871561474539630';
const STAFF_GUILD_ID = process.env.STAFF_GUILD_ID || '1556647204255568063';
const TASKS_CHANNEL_ID = process.env.TASKS_CHANNEL_ID || '1556647204960346215';
const TASK_SUBMISSIONS_CHANNEL_ID = process.env.TASK_SUBMISSIONS_CHANNEL_ID || '1556651404154642504';
const SUBMISSION_REVIEW_CHANNEL_ID = '1556945732957765722';
const LEAVE_REQUEST_CHANNEL_ID = '1558102515885678734';
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
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
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
    FROM chat_messages
    WHERE room = ? AND created_at >= ? AND created_at < ?
    GROUP BY user_id
    ORDER BY COUNT(*) DESC, MAX(username) ASC`).all('staff', range.start, range.end);
  const dailyStats = rows.map((row) => ({ userId: row.userId, username: row.username, count: Number(row.count) || 0 }));
  return { dailyStats, dailyTotal: dailyStats.reduce((total, row) => total + row.count, 0), dailyDate: range.date };
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
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'سجل دخولك بديسكورد أولًا.' });
  next();
}
function requireManager(req, res, next) {
  if (!canManage(req.session.user)) return res.status(403).json({ error: 'الصلاحية دي للمسؤولين فقط.' });
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
client.on('error', (error) => { botLastError = error.message; console.error('[discord] Client error:', error); });

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
      roleColor: highest ? highest.hexColor : '#64748b',
      roles: assignedRoles.map((role) => ({ id: role.id, name: role.name, position: role.position, color: role.hexColor })),
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
    const isAdmin = hasAdministratorPermission(staffGuild) || hasAdministratorPermission(mainGuild);
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

app.get('/api/health', (req, res) => res.json({ ok: true, botReady, botLastError: botReady ? '' : botLastError }));
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: { ...req.session.user, avatarUrl: profileAvatar(req.session.user), canManage: canManage(req.session.user) } });
});

app.get('/api/roster', requireAuth, async (req, res) => {
  try { res.json(await getStaffRoster()); }
  catch (error) {
    console.error('[roster]', error.message);
    res.status(503).json({ error: `تعذر تحميل قائمة الاستاف: ${cleanText(error.message, 220)}` });
  }
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
    for (const batchRows of batches) {
      const message = await channel.send({
        content: `📋 **مهمات جديدة | إدارة البرج**\n${batchRows.map((row) => row.line).join('\n')}`,
        allowedMentions: { parse: [] },
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
      const foundTasks = db.prepare(`SELECT id, title, required FROM tasks WHERE active = 1 AND id IN (${taskIds.map(() => '?').join(',')})`).all(...taskIds);
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
          .setDescription('وصل دليل جديد من عضو الاستاف، والتسليم بانتظار مراجعة المسؤولين.\n\n**تتم الموافقة أو الرفض من لوحة الموقع.**')
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
        const attachable = files.filter((file) => file.size <= ATTACHMENT_LIMIT_MB * 1024 * 1024).map((file) => new AttachmentBuilder(file.path, { name: path.basename(file.originalname) }));
        await channel.send({ embeds: [embed], files: attachable, allowedMentions: { parse: [] } });
        discordPosted = true;
      } catch (error) {
        warning = error.message;
        console.error('[submission post]', error.message);
      }
      res.status(201).json({ ok: true, submissionId, discordPosted, warning, message: discordPosted ? 'اتسجل تسليم المهمة واترسل لروم التسليم.' : 'اتسجل التسليم في الموقع، لكن البوت لم يستطع إرساله لروم التسليم.' });
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
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (!validDate(startDate) || !validDate(endDate) || endDate < startDate) return res.status(400).json({ error: 'اختار تاريخ بداية ونهاية صحيحين، وتأكد إن النهاية ليست قبل البداية.' });
  if (!reason) return res.status(400).json({ error: 'اكتب سبب طلب الإجازة.' });
  const user = req.session.user;
  const result = db.prepare(`INSERT INTO leave_requests(user_id, username, avatar_url, start_date, end_date, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(user.id, user.username, profileAvatar(user), startDate, endDate, reason, nowIso());
  const id = Number(result.lastInsertRowid);
  let discordPosted = false;
  try {
    const channel = await fetchTextChannel(LEAVE_REQUEST_CHANNEL_ID);
    const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle(`🗓️ طلب إجازة جديد #${id}`).setDescription('طلب إجازة جديد بانتظار مراجعة مسؤولي الإدارة من لوحة الموقع.').addFields(
      { name: '👤 العضو', value: `<@${user.id}>\n\`${user.id}\``, inline: true },
      { name: '📅 من', value: startDate, inline: true }, { name: '📅 إلى', value: endDate, inline: true },
      { name: '📝 السبب', value: reason.slice(0, 1024), inline: false },
      { name: '🔎 المراجعة', value: `رقم الطلب: #${id}\nالموافقة أو الرفض من لوحة إدارة البرج.`, inline: false },
    ).setTimestamp(new Date()).setFooter({ text: 'إدارة البرج • طلبات الإجازة' });
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }); discordPosted = true;
  } catch (error) { console.error('[leave request post]', error.message); }
  res.status(201).json({ ok: true, id, discordPosted, message: discordPosted ? 'تم إرسال طلب الإجازة لروم الإدارة.' : 'تم حفظ الطلب، لكن البوت لم يستطع إرساله إلى روم ديسكورد.' });
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
  const update = db.prepare("UPDATE leave_requests SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'").run(status, note, user.id, nowIso(), id);
  if (!update.changes) return res.status(404).json({ error: 'الطلب غير موجود أو تمت مراجعته بالفعل.' });
  try { const channel = await fetchTextChannel(LEAVE_REQUEST_CHANNEL_ID); await channel.send({ embeds: [new EmbedBuilder().setColor(status === 'approved' ? 0x22c55e : 0xef4444).setTitle(status === 'approved' ? `✅ تمت الموافقة على طلب الإجازة #${id}` : `❌ تم رفض طلب الإجازة #${id}`).setDescription(`المراجع: <@${user.id}>${note ? `\nملاحظة: ${note}` : ''}`).setTimestamp(new Date())], allowedMentions: { parse: [] } }); } catch (error) { console.error('[leave review log]', error.message); }
  res.json({ ok: true, message: status === 'approved' ? 'تمت الموافقة على طلب الإجازة.' : 'تم رفض طلب الإجازة.' });
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
