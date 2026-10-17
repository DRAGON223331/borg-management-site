'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { notifyReview } = require('./_lib/notify.js');
const { buildSubmissionNotifications, mergeSubmissionDecisionEmbed } = require('../lib/submission-notifications.js');

const DISCORD_API = 'https://discord.com/api/v10';
const COOKIE_NAME = 'borg.sid';
const OAUTH_COOKIE = 'borg.oauth';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
const MANAGER_IDS = new Set((process.env.MANAGER_IDS || '').split(',').map((x) => x.trim()).filter(Boolean)); // optional staff-chat DM recipients only; never authorizes site access
const SITE_OWNER_IDS = new Set(['848304089057460254', '1286035404323164172']);
const MAIN_GUILD_ID = process.env.MAIN_GUILD_ID || '883871561474539630';
const STAFF_GUILD_ID = process.env.STAFF_GUILD_ID || '1556647204255568063';
const MANAGEMENT_STAFF_ROLE_ID = process.env.MANAGEMENT_STAFF_ROLE_ID || '1559628523809804288';
const TASKS_CHANNEL_ID = process.env.TASKS_CHANNEL_ID || '1556647204960346215';
const TASK_PING_ROLE_ID = (process.env.TASK_PING_ROLE_ID || '1556647362062188544').trim(); // رتبة بتتمنشن مع كل مهمات جديدة
const TASK_SUBMISSIONS_CHANNEL_ID = process.env.TASK_SUBMISSIONS_CHANNEL_ID || '1556651404154642504';
const TASK_APPROVED_CHANNEL_ID = (process.env.TASK_APPROVED_CHANNEL_ID || process.env.TASK_SUBMISSIONS_CHANNEL_ID || '1556651404154642504').trim(); // روم رسالة "المهمة اتقبلت" العادية
const POINTS_LOG_CHANNEL_ID = process.env.POINTS_LOG_CHANNEL_ID || '1559598706871767172';
const SUBMISSION_REVIEW_CHANNEL_ID = '1556945732957765722';
const LEAVE_REQUEST_CHANNEL_ID = '1556945732957765722'; // ثابت: روم طلبات الإجازة ومراجعتها
const STAFF_REQUEST_CHANNEL_ID = '1560142058826768425'; // ثابت: روم كل الطلبات الإدارية غير الإجازات، وسجلات قبولها ورفضها
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1559176035432402976';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const COOKIE_SECRET = process.env.SESSION_SECRET || '';
const MAX_UPLOAD_MB = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 100));
// الروم الوحيد الذي تُحسب منه رسائل الاستاف (رسائل ديسكورد الحقيقية، وليس شات الموقع).
const MESSAGE_COUNT_CHANNEL_ID = (process.env.MESSAGE_COUNT_CHANNEL_ID || '1552049641913065552').trim();
const MESSAGE_FULL_SCAN_MINUTES = Math.max(1, Number(process.env.MESSAGE_FULL_SCAN_MINUTES || 10));

let sqlClient;
let schemaPromise;
let blobSdkPromise;
let blobClientSdkPromise;
let neonSdkPromise;
let lastTaskSyncAt = 0;
let taskSyncPromise;
let lastMessageSyncAt = 0;
let messageSyncPromise;

// ───────── تخفيف الضغط: كاش في الذاكرة + حد للطلبات ─────────
const SCHEMA_VERSION = 11; // v11 يضيف منع الوصول للموقع وسجل حذف رسائل الشات
const PRESENCE_WINDOW_SECONDS = 150; // مدة اعتبار العضو "متصل" بعد آخر نبضة (النبضة كل 60 ثانية)
const MESSAGE_SYNC_MIN_MS = Math.max(15, Number(process.env.MESSAGE_SYNC_MIN_SECONDS || 45)) * 1000;
const memCache = new Map();
// بيشارك نفس الطلب الجاري بين كل المستخدمين، وبيرجّع آخر نسخة قديمة لو Discord/DB فشلوا مؤقتًا.
function cached(key, ttlMs, loader) {
  const now = Date.now();
  const entry = memCache.get(key);
  if (entry && 'value' in entry && entry.expires > now) return Promise.resolve(entry.value);
  if (entry?.inflight) return entry.inflight;
  const inflight = Promise.resolve().then(loader).then(
    (value) => { memCache.set(key, { value, expires: Date.now() + ttlMs }); return value; },
    (error) => {
      if (entry && 'value' in entry) { memCache.set(key, { value: entry.value, expires: Date.now() + 5000 }); return entry.value; }
      memCache.delete(key);
      throw error;
    },
  );
  memCache.set(key, { ...(entry || {}), inflight });
  return inflight;
}
const rateBuckets = new Map();
function rateLimited(req, res, user, bucket, max, windowMs = 60_000) {
  const who = user?.id || String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'anon').split(',')[0].trim();
  const key = `${bucket}:${who}`;
  const now = Date.now();
  let entry = rateBuckets.get(key);
  if (!entry || entry.reset <= now) { entry = { count: 0, reset: now + windowMs }; rateBuckets.set(key, entry); }
  entry.count += 1;
  if (rateBuckets.size > 4000) for (const [k, v] of rateBuckets) if (v.reset <= now) rateBuckets.delete(k);
  if (entry.count <= max) return false;
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.reset - now) / 1000))));
  sendError(res, 429, 'طلبات كتير في وقت قصير. استنى شوية وجرّب تاني.');
  return true;
}
function queryParam(req, name) {
  const direct = req.query?.[name];
  if (direct !== undefined && direct !== null) return Array.isArray(direct) ? String(direct[0]) : String(direct);
  try { return new URL(req.url || '/', 'http://localhost').searchParams.get(name); } catch { return null; }
}

function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercelHost) return `https://${vercelHost.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  const proto = req.headers['x-forwarded-proto'] || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
  return `${proto}://${host}`.replace(/\/$/, '');
}

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}
function sendError(res, status, message) { sendJson(res, status, { error: message }); }
function sendText(res, status, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(String(message || ''));
}
function cleanText(value, max = 300) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}
function containsChatLink(value) {
  const text = String(value ?? '').normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\[\s*(?:dot|\.)\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}/gi, '.')
    .replace(/\s+dot\s+/gi, '.');
  const patterns = [
    /(?:\b(?:https?|ftp|hxxps?)\s*:\s*\/\s*\/|\bwww\d?\s*\.)[^\s<>{}"'`]+/i,
    /\b(?:discord\.gg|discord(?:app)?\.com\/invite|t\.me|telegram\.me|bit\.ly|tinyurl\.com|youtu\.be|forms\.gle)(?:\/\S*)?/i,
    /(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{2,5})?(?:[/?#][^\s<>{}"'`]*)?/i,
    /(?<![\w@])(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?(?:\/[^\s]*)?/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}
function parseJson(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
function cookieMap(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').map((item) => item.trim()).filter(Boolean).map((item) => {
    const index = item.indexOf('=');
    return index < 0 ? [item, ''] : [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
  }));
}
function sign(value) {
  if (!COOKIE_SECRET || COOKIE_SECRET.length < 32) throw new Error('إعداد SESSION_SECRET ناقص أو قصير.');
  return crypto.createHmac('sha256', COOKIE_SECRET).update(value).digest('base64url');
}
function makeCookie(name, value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function clearCookie(name) {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
function createSessionCookie(user) {
  const payload = Buffer.from(JSON.stringify({ user, exp: Date.now() + COOKIE_MAX_AGE * 1000 })).toString('base64url');
  return makeCookie(COOKIE_NAME, `${payload}.${sign(payload)}`, COOKIE_MAX_AGE);
}
function getSessionUser(req) {
  try {
    const value = cookieMap(req)[COOKIE_NAME];
    if (!value || !COOKIE_SECRET || COOKIE_SECRET.length < 32) return null;
    const index = value.lastIndexOf('.');
    if (index < 1) return null;
    const payload = value.slice(0, index);
    const signature = value.slice(index + 1);
    const expected = sign(payload);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.user || !data.exp || data.exp < Date.now()) return null;
    return data.user;
  } catch { return null; }
}
function requireAuth(req, res) {
  const user = getSessionUser(req);
  if (!user) { sendError(res, 401, 'سجل دخولك بديسكورد أولًا.'); return null; }
  return user;
}
function canManage(user) { return Boolean(user && (isSiteOwner(user) || user.canManage || user.isManager || user.isAdmin)); }
function canReadRoom(user, room) { return Boolean(user && (room === 'staff' || canManage(user))); }
function originIsAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsedOrigin = new URL(origin).origin;
    if (parsedOrigin === new URL(siteUrl(req)).origin) return true;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    return Boolean(host && parsedOrigin === `${proto}://${host}`);
  } catch { return false; }
}
function ensureSameOrigin(req, res) {
  if (originIsAllowed(req)) return true;
  sendError(res, 403, 'تم رفض الطلب لأسباب أمنية.');
  return false;
}
function avatarUrl(user) {
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  let index = 0;
  try { index = Number((BigInt(user.id) >> 22n) % 6n); } catch { index = 0; }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

async function getSql() {
  if (sqlClient) return sqlClient;
  if (!neonSdkPromise) neonSdkPromise = import('@neondatabase/serverless');
  const { neon } = await neonSdkPromise;
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_PRISMA_URL;
  if (!connectionString) throw new Error('اربط قاعدة PostgreSQL بالمشروع من Vercel Storage/Marketplace وأضف DATABASE_URL.');
  sqlClient = neon(connectionString);
  return sqlClient;
}
let voiceTimeApiSchemaPromise;
async function ensureVoiceTimeApiSchema(sql) {
  if (!voiceTimeApiSchemaPromise) {
    voiceTimeApiSchemaPromise = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS discord_voice_sessions (
        id BIGSERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        channel_id TEXT NOT NULL,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        CHECK (ended_at IS NULL OR ended_at >= joined_at)
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_discord_voice_sessions_day ON discord_voice_sessions(guild_id, joined_at DESC, user_id)`;
      await sql`CREATE TABLE IF NOT EXISTS discord_voice_time_meta (
        guild_id TEXT PRIMARY KEY,
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    })().catch((error) => { voiceTimeApiSchemaPromise = null; throw error; });
  }
  return voiceTimeApiSchemaPromise;
}

async function ensureSchema() {
  if (!schemaPromise) schemaPromise = (async () => {
    const sql = await getSql();
    // استعلام واحد بدل ~40 استعلام DDL في كل cold start.
    try { const meta = await sql`SELECT value FROM app_meta WHERE key = 'schema_version'`; if (Number(meta[0]?.value) >= SCHEMA_VERSION) return; } catch { /* الجدول لسه مش موجود → نكمّل التهيئة */ }
    await sql`CREATE TABLE IF NOT EXISTS tasks (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      points NUMERIC(10,2) NOT NULL DEFAULT 1,
      required BOOLEAN NOT NULL DEFAULT FALSE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source_message_id TEXT,
      source_line_index INTEGER,
      UNIQUE(source_message_id, source_line_index)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(active, required DESC, id DESC)`;
    await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS points NUMERIC(10,2) NOT NULL DEFAULT 1`;
    await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ`;
    await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline_reminded_at TIMESTAMPTZ`;
    await sql`CREATE TABLE IF NOT EXISTS submissions (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      avatar_url TEXT,
      note TEXT NOT NULL DEFAULT '',
      evidence_links JSONB NOT NULL DEFAULT '[]'::jsonb,
      files_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'submitted'
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id, submitted_at DESC)`;
    await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS reviewed_by TEXT`;
    await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`;
    await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS discord_message_id TEXT`;
    await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS discord_channel_id TEXT`;
    await sql`CREATE TABLE IF NOT EXISTS staff_points (id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, amount NUMERIC(10,2) NOT NULL, reason TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', submission_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await sql`CREATE INDEX IF NOT EXISTS idx_staff_points_user ON staff_points(user_id, created_at DESC)`;
    await sql`CREATE TABLE IF NOT EXISTS submission_tasks (
      submission_id BIGINT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (submission_id, task_id)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_submission_tasks_task ON submission_tasks(task_id)`;
    await sql`ALTER TABLE submission_tasks ADD COLUMN IF NOT EXISTS points_awarded NUMERIC(10,2)`;
    await sql`CREATE TABLE IF NOT EXISTS task_rework_requests (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      task_id BIGINT NOT NULL,
      task_title TEXT NOT NULL,
      original_submission_id BIGINT NOT NULL,
      requested_by TEXT NOT NULL,
      requested_by_name TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      points_deducted NUMERIC(10,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','submitted','completed','cancelled')),
      current_submission_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_task_rework_user_task ON task_rework_requests(user_id, task_id, created_at DESC)`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_rework_active_unique ON task_rework_requests(user_id, task_id) WHERE status IN ('requested','submitted')`;
    await sql`CREATE TABLE IF NOT EXISTS submission_review_audit (
      id BIGSERIAL PRIMARY KEY, submission_id BIGINT NOT NULL, member_id TEXT NOT NULL, member_name TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','reopened')), reviewer_id TEXT NOT NULL, reviewer_name TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_submission_review_audit_created ON submission_review_audit(created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_submission_review_audit_submission ON submission_review_audit(submission_id, created_at DESC)`;
    await sql`CREATE TABLE IF NOT EXISTS submission_file_hashes (
      submission_id BIGINT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE, file_sha256 TEXT NOT NULL, user_id TEXT NOT NULL,
      username TEXT NOT NULL, original_name TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (submission_id, file_sha256)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_submission_file_hashes_sha256 ON submission_file_hashes(file_sha256)`;
    await sql`CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      room TEXT NOT NULL CHECK (room IN ('staff', 'management')),
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      avatar_url TEXT,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_chat_room_id ON chat_messages(room, id DESC)`;
    await sql`CREATE TABLE IF NOT EXISTS chat_message_deletions (
      id BIGSERIAL PRIMARY KEY,
      room TEXT NOT NULL CHECK (room IN ('staff', 'management')),
      message_id BIGINT NOT NULL,
      deleted_by TEXT NOT NULL,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_chat_message_deletions_room_id ON chat_message_deletions(room, id)`;
    await sql`CREATE TABLE IF NOT EXISTS site_user_blocks (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      blocked_by TEXT NOT NULL,
      blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_site_user_blocks_blocked_at ON site_user_blocks(blocked_at DESC)`;
    await sql`CREATE TABLE IF NOT EXISTS discord_message_log (
      message_id BIGINT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_dml_channel_user ON discord_message_log(channel_id, user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_dml_channel_created ON discord_message_log(channel_id, created_at)`;
    await sql`CREATE TABLE IF NOT EXISTS discord_message_sync (
      channel_id TEXT PRIMARY KEY,
      head_id BIGINT,
      scan_active BOOLEAN NOT NULL DEFAULT FALSE,
      scan_before BIGINT,
      scan_prev_min BIGINT,
      last_full_at TIMESTAMPTZ,
      last_sync_at TIMESTAMPTZ,
      locked_until TIMESTAMPTZ
    )`;
    await sql`CREATE TABLE IF NOT EXISTS site_presence (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, avatar_url TEXT, last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await sql`CREATE INDEX IF NOT EXISTS idx_site_presence_last_seen ON site_presence(last_seen DESC)`;
    await sql`CREATE TABLE IF NOT EXISTS discord_presence (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','idle','dnd','offline')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (guild_id, user_id)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_discord_presence_guild_status ON discord_presence(guild_id, status)`;
    await sql`CREATE TABLE IF NOT EXISTS discord_presence_activity (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
      activity_type TEXT NOT NULL DEFAULT 'message' CHECK (activity_type IN ('message','voice')),
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (guild_id, user_id)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_discord_presence_activity_recent ON discord_presence_activity(guild_id, last_activity_at DESC)`;
    await sql`CREATE TABLE IF NOT EXISTS discord_presence_meta (
      guild_id TEXT PRIMARY KEY, last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_sync_at TIMESTAMPTZ,
      last_error TEXT, member_count INTEGER NOT NULL DEFAULT 0, known_count INTEGER NOT NULL DEFAULT 0
    )`;
    await sql`ALTER TABLE discord_presence_meta ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ`;
    await sql`ALTER TABLE discord_presence_meta ADD COLUMN IF NOT EXISTS last_error TEXT`;
    await sql`ALTER TABLE discord_presence_meta ADD COLUMN IF NOT EXISTS member_count INTEGER NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE discord_presence_meta ADD COLUMN IF NOT EXISTS known_count INTEGER NOT NULL DEFAULT 0`;
    await sql`CREATE TABLE IF NOT EXISTS notification_state (notification_key TEXT PRIMARY KEY, last_sent_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z')`;
    await sql`CREATE TABLE IF NOT EXISTS leave_requests (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      avatar_url TEXT,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      review_note TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_leave_requests_user ON leave_requests(user_id, created_at DESC)`;
    await sql`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS discord_message_id TEXT`;
    await sql`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS discord_channel_id TEXT`;
    await sql`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS roles_granted TEXT`;
    await sql`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS roles_synced BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS roles_removed_at TIMESTAMPTZ`;
    await sql`CREATE TABLE IF NOT EXISTS staff_requests (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      avatar_url TEXT,
      request_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      review_note TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_staff_requests_user ON staff_requests(user_id, created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, id DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status, id DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_submissions_files ON submissions USING GIN (files_json jsonb_path_ops)`; // فتح الأدلة بالـtoken
    await sql`CREATE TABLE IF NOT EXISTS admin_notifications (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      ref_id BIGINT,
      actor_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS admin_notification_reads (user_id TEXT PRIMARY KEY, last_read_id BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await sql`CREATE TABLE IF NOT EXISTS site_manager_access (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL CHECK (action IN ('grant','deny')),
      updated_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_site_manager_access_action ON site_manager_access(action, updated_at DESC)`;
    await sql`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    await sql`INSERT INTO app_meta(key, value) VALUES ('schema_version', ${String(SCHEMA_VERSION)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  })().catch((error) => { schemaPromise = null; throw error; });
  return schemaPromise;
}

// ───────── عدّ رسائل روم ديسكورد (REST فقط، بدون Gateway) ─────────
// الفكرة: جدول discord_message_log يحتفظ بكل رسالة موجودة حاليًا في الروم. كل مزامنة:
//  1) تجلب أحدث الرسائل (200 على الأقل) وتضيف الجديد وتحذف أي رسالة اتمسحت من هذا النطاق.
//  2) كل MESSAGE_FULL_SCAN_MINUTES دقائق تمسح الروم كله صفحة صفحة (على مراحل) لحذف أي رسالة قديمة اتمسحت.
// لذلك عند حذف رسالة من ديسكورد ينقص عدّاد صاحبها تلقائيًا.
const COUNTED_MESSAGE_TYPES = new Set([0, 19]); // رسالة عادية + رد
function messageLogRows(page) {
  return (page || [])
    .filter((m) => m?.id && m.author?.id && !m.author.bot && !m.webhook_id && COUNTED_MESSAGE_TYPES.has(Number(m.type) || 0))
    .map((m) => ({ id: String(m.id), user_id: String(m.author.id), username: cleanText(m.author.global_name || m.author.username || m.author.id, 80), created_at: m.timestamp }));
}
async function applyMessagePage(sql, channelId, page, upper, isLast) {
  const rows = messageLogRows(page);
  if (rows.length) {
    await sql`INSERT INTO discord_message_log(message_id, channel_id, user_id, username, created_at)
      SELECT r.id::bigint, ${channelId}, r.user_id, r.username, r.created_at::timestamptz
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(id text, user_id text, username text, created_at text)
      ON CONFLICT (message_id) DO UPDATE SET username = EXCLUDED.username`;
  }
  let lower = '0';
  if (!isLast && page.length) lower = page.map((m) => BigInt(m.id)).reduce((a, b) => (b < a ? b : a)).toString();
  const ids = JSON.stringify(rows.map((r) => r.id));
  // أي رسالة مسجلة داخل نطاق الصفحة وليست موجودة فعليًا في ديسكورد = اتمسحت.
  await sql`DELETE FROM discord_message_log
    WHERE channel_id = ${channelId}
      AND message_id >= ${lower}::bigint
      AND (${upper}::bigint IS NULL OR message_id < ${upper}::bigint)
      AND message_id NOT IN (SELECT value::bigint FROM jsonb_array_elements_text(${ids}::jsonb))`;
  return lower;
}
async function syncChannelMessageCounts(sql, { force = false, budgetMs = 9000 } = {}) {
  if (!BOT_TOKEN || !MESSAGE_COUNT_CHANNEL_ID) return;
  if (messageSyncPromise) return messageSyncPromise;
  if (!force && Date.now() - lastMessageSyncAt < MESSAGE_SYNC_MIN_MS) return;
  messageSyncPromise = (async () => {
    const channelId = MESSAGE_COUNT_CHANNEL_ID;
    const deadline = Date.now() + budgetMs;
    let locked = false;
    const st = { head: null, scanActive: false, scanBefore: null, scanPrevMin: null, fullDone: false };
    try {
      await sql`INSERT INTO discord_message_sync(channel_id) VALUES (${channelId}) ON CONFLICT (channel_id) DO NOTHING`;
      const got = await sql`UPDATE discord_message_sync SET locked_until = NOW() + INTERVAL '55 seconds'
        WHERE channel_id = ${channelId} AND (locked_until IS NULL OR locked_until < NOW())
        RETURNING head_id::text AS head_id, scan_before::text AS scan_before, scan_prev_min::text AS scan_prev_min, scan_active,
          (last_full_at IS NULL OR last_full_at < NOW() - make_interval(mins => ${MESSAGE_FULL_SCAN_MINUTES}::int)) AS full_due`;
      if (!got.length) return; // مزامنة تانية شغالة دلوقتي
      locked = true;
      const state = got[0];
      const oldHead = state.head_id ? BigInt(state.head_id) : null;
      st.head = state.head_id;
      st.scanActive = Boolean(state.scan_active);
      st.scanBefore = state.scan_before;
      st.scanPrevMin = state.scan_prev_min;
      const fetchPage = (before) => discordApi(`/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`);

      // (1) مزامنة الرأس: أحدث الرسائل + اكتشاف المحذوف منها
      let before = null; let upper = null; let pages = 0; let reachedStart = false; let reachedOldHead = false;
      while (pages < 30 && Date.now() < deadline) {
        const page = await fetchPage(before);
        pages += 1;
        if (pages === 1 && page.length) st.head = page.map((m) => BigInt(m.id)).reduce((a, b) => (b > a ? b : a)).toString();
        const isLast = page.length < 100;
        const lower = await applyMessagePage(sql, channelId, page, upper, isLast);
        if (isLast) { reachedStart = true; break; }
        if (pages >= 2 && oldHead !== null && BigInt(lower) <= oldHead) { reachedOldHead = true; break; }
        before = lower; upper = lower;
      }
      if (reachedStart) { st.fullDone = true; st.scanActive = false; st.scanBefore = null; st.scanPrevMin = null; }
      else if (!reachedOldHead && oldHead !== null) { st.scanActive = true; st.scanBefore = null; st.scanPrevMin = null; } // فجوة كبيرة → امسح كل الروم
      else if (oldHead === null) { st.scanActive = true; st.scanBefore = null; st.scanPrevMin = null; } // أول مرة → backfill كامل
      else if (!st.scanActive && state.full_due) { st.scanActive = true; st.scanBefore = null; st.scanPrevMin = null; }

      // (2) المسح الكامل على مراحل
      let scanPages = 0;
      while (st.scanActive && scanPages < 60 && Date.now() < deadline) {
        const page = await fetchPage(st.scanBefore);
        scanPages += 1;
        const isLast = page.length < 100;
        const lower = await applyMessagePage(sql, channelId, page, st.scanPrevMin, isLast);
        if (isLast) { st.scanActive = false; st.scanBefore = null; st.scanPrevMin = null; st.fullDone = true; break; }
        st.scanBefore = lower; st.scanPrevMin = lower;
        await sql`UPDATE discord_message_sync SET scan_before = ${st.scanBefore}::bigint, scan_prev_min = ${st.scanPrevMin}::bigint WHERE channel_id = ${channelId}`;
      }
    } catch (error) {
      console.error('[message count sync]', cleanText(error?.message || error, 240));
    } finally {
      if (locked) {
        try {
          await sql`UPDATE discord_message_sync SET head_id = ${st.head}::bigint, scan_active = ${st.scanActive}, scan_before = ${st.scanBefore}::bigint,
            scan_prev_min = ${st.scanPrevMin}::bigint, last_full_at = CASE WHEN ${st.fullDone} THEN NOW() ELSE last_full_at END,
            last_sync_at = NOW(), locked_until = NULL WHERE channel_id = ${channelId}`;
        } catch (error) { console.error('[message count sync save]', cleanText(error?.message || error, 200)); }
      }
      lastMessageSyncAt = Date.now();
      messageSyncPromise = null;
    }
  })();
  return messageSyncPromise;
}

// ───────── تسجيل أمر السلاش (mypoints فقط) ─────────
const SLASH_COMMANDS = [
  { name: 'mypoints', type: 1, description: 'Show how many points you have', description_localizations: { ar: 'اعرف عندك كام نقطة' } },
  { name: 'task-report', type: 1, dm_permission: false, description: 'Post staff members who have incomplete required tasks', description_localizations: { ar: 'إرسال قائمة الاستاف الذين لم يكملوا المهمات الإجبارية' }, name_localizations: { ar: 'تقرير-المهمات' } },
  {
    name: 'clear-site-notifications', type: 1, dm_permission: false,
    description: 'Delete website notification messages from users’ DMs only',
    description_localizations: { ar: 'حذف تنبيهات الموقع من الخاص فقط دون بقية رسائل البوت' },
    name_localizations: { ar: 'مسح-تنبيهات-الموقع' },
    options: [{
      type: 5, name: 'confirm', required: true,
      description: 'Confirm deleting website notifications only',
      description_localizations: { ar: 'أكّد حذف تنبيهات الموقع فقط' },
      name_localizations: { ar: 'تأكيد' },
    }],
  },
  {
    name: 'clear-staff-chat-notifications', type: 1, dm_permission: false,
    description: 'Delete staff chat notification messages from users’ DMs only',
    description_localizations: { ar: 'حذف تنبيهات شات الاستاف فقط من الخاص دون بقية تنبيهات الموقع' },
    name_localizations: { ar: 'مسح-تنبيهات-شات-الاستاف' },
    options: [{
      type: 5, name: 'confirm', required: true,
      description: 'Confirm deleting staff chat notifications only',
      description_localizations: { ar: 'أكّد حذف تنبيهات شات الاستاف فقط' },
      name_localizations: { ar: 'تأكيد' },
    }],
  },
  {
    name: 'csv', type: 1, dm_permission: false,
    description: 'Export staff data as a CSV file (managers only)',
    description_localizations: { ar: 'تصدير بيانات الاستاف كملف CSV (للمسؤولين فقط)' },
    options: [{
      type: 3, name: 'type', required: false,
      description: 'What to export (default: staff summary)',
      description_localizations: { ar: 'نوع البيانات المطلوب تصديرها (الافتراضي: ملخص الاستاف)' },
      choices: [
        { name: 'Staff summary', name_localizations: { ar: 'ملخص الاستاف' }, value: 'stats' },
        { name: 'Submissions', name_localizations: { ar: 'التسليمات' }, value: 'submissions' },
        { name: 'Leave requests', name_localizations: { ar: 'طلبات الإجازة' }, value: 'leaves' },
        { name: 'Points ledger', name_localizations: { ar: 'سجل النقاط' }, value: 'points' },
        { name: 'Admin requests', name_localizations: { ar: 'الطلبات الإدارية' }, value: 'requests' },
        { name: 'Submission review audit', name_localizations: { ar: 'سجل قرارات مراجعة التسليمات' }, value: 'review-audit' },
      ],
    }],
  },
];
let commandsRegisteredAt = 0;
async function registerSlashCommands() {
  const registered = await discordApi(`/applications/${DISCORD_CLIENT_ID}/commands`, { method: 'PUT', body: JSON.stringify(SLASH_COMMANDS) });
  commandsRegisteredAt = Date.now();
  return (registered || []).map((c) => c.name);
}

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

async function loadDailyStaffMessageStats(sql) {
  const [rows, todayRows] = await Promise.all([
    sql`SELECT user_id AS "userId", MAX(username) AS username, COUNT(*)::integer AS count
      FROM discord_message_log
      WHERE channel_id = ${MESSAGE_COUNT_CHANNEL_ID}
        AND created_at >= ((NOW() AT TIME ZONE 'Africa/Cairo')::date::timestamp AT TIME ZONE 'Africa/Cairo')
        AND created_at < (((NOW() AT TIME ZONE 'Africa/Cairo')::date + 1)::timestamp AT TIME ZONE 'Africa/Cairo')
      GROUP BY user_id
      ORDER BY COUNT(*) DESC, MAX(username) ASC`,
    sql`SELECT TO_CHAR(NOW() AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD') AS "dailyDate"`,
  ]);
  const dailyStats = rows.map((row) => ({ userId: row.userId, username: row.username, count: Number(row.count) || 0 }));
  return {
    dailyStats,
    dailyTotal: dailyStats.reduce((total, row) => total + row.count, 0),
    dailyDate: todayRows[0]?.dailyDate || null,
  };
}


const getDailyStaffMessageStats = (sql) => cached('daily-message-stats', 20_000, () => loadDailyStaffMessageStats(sql));

async function loadAllStaffStats(sql) {
  const [messages, submissions, points, leaves, staffRequests, online, daily] = await Promise.all([
    sql`SELECT user_id AS "userId", MAX(username) AS username, COUNT(*)::integer AS "totalMessages" FROM discord_message_log WHERE channel_id = ${MESSAGE_COUNT_CHANNEL_ID} GROUP BY user_id`,
    sql`SELECT user_id AS "userId", COUNT(*)::integer AS "totalSubmissions", COUNT(*) FILTER (WHERE status = 'approved')::integer AS "approvedSubmissions", COUNT(*) FILTER (WHERE status IN ('submitted','pending'))::integer AS "pendingSubmissions", COUNT(*) FILTER (WHERE status = 'rejected')::integer AS "rejectedSubmissions" FROM submissions GROUP BY user_id`,
    sql`SELECT user_id AS "userId", COALESCE(SUM(amount),0)::numeric AS "totalPoints" FROM staff_points GROUP BY user_id`,
    sql`SELECT user_id AS "userId", COUNT(*)::integer AS "leaveRequests" FROM leave_requests GROUP BY user_id`,
    sql`SELECT user_id AS "userId", COUNT(*)::integer AS "adminRequests" FROM staff_requests GROUP BY user_id`,
    sql`SELECT user_id AS "userId", last_seen AS "lastSeen" FROM site_presence WHERE last_seen > NOW() - make_interval(secs => ${PRESENCE_WINDOW_SECONDS}::int)`,
    loadDailyStaffMessageStats(sql),
  ]);
  const byId = new Map();
  const ensure = (id, username = '') => {
    const key = String(id);
    if (!byId.has(key)) byId.set(key, { userId: key, username, dailyMessages: 0, totalMessages: 0, totalSubmissions: 0, approvedSubmissions: 0, pendingSubmissions: 0, rejectedSubmissions: 0, totalPoints: 0, leaveRequests: 0, adminRequests: 0, online: false, lastSeen: null });
    const row = byId.get(key);
    if (username) row.username = username;
    return row;
  };
  for (const row of messages) Object.assign(ensure(row.userId, row.username), { totalMessages: Number(row.totalMessages) || 0 });
  for (const row of submissions) Object.assign(ensure(row.userId), { totalSubmissions: Number(row.totalSubmissions) || 0, approvedSubmissions: Number(row.approvedSubmissions) || 0, pendingSubmissions: Number(row.pendingSubmissions) || 0, rejectedSubmissions: Number(row.rejectedSubmissions) || 0 });
  for (const row of points) ensure(row.userId).totalPoints = Number(row.totalPoints) || 0;
  for (const row of leaves) ensure(row.userId).leaveRequests = Number(row.leaveRequests) || 0;
  for (const row of staffRequests) ensure(row.userId).adminRequests = Number(row.adminRequests) || 0;
  for (const row of online) Object.assign(ensure(row.userId), { online: true, lastSeen: row.lastSeen });
  for (const row of daily.dailyStats || []) ensure(row.userId, row.username).dailyMessages = Number(row.count) || 0;
  return { stats: [...byId.values()], dailyDate: daily.dailyDate || null };
}
const getAllStaffStats = (sql) => cached('all-staff-stats', 15_000, () => loadAllStaffStats(sql));

// ───────── خصوصية بيانات الأعضاء ─────────
// أي عضو عادي يشوف فقط الحقول العامة اللازمة للّيدر بورد. باقي الأرقام (تسليمات مرفوضة/معلقة، إجازات، طلبات إدارية، آخر ظهور) للمسؤولين وصاحب الحساب فقط.
const PUBLIC_STAT_FIELDS = ['userId', 'username', 'dailyMessages', 'totalMessages', 'totalPoints', 'approvedSubmissions', 'online'];
function publicStats(row) {
  const out = {};
  for (const key of PUBLIC_STAT_FIELDS) out[key] = row[key];
  return out;
}
function rosterForViewer(data, viewer) {
  if (canManage(viewer)) return data;
  // تواريخ دخول السيرفرات بيانات إدارية؛ مش بنبعتها لغير المسؤولين.
  return { ...data, groups: data.groups.map((group) => ({ ...group, members: group.members.map(({ joinedAt, mainJoinedAt, ...rest }) => rest) })) };
}
async function discordApi(route, options = {}) {
  if (!BOT_TOKEN) throw new Error('توكن البوت غير مضبوط في Environment Variables على Vercel.');
  const response = await fetch(`${DISCORD_API}${route}`, {
    ...options,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  let payload = null;
  if (response.status !== 204) {
    try { payload = await response.json(); } catch { payload = null; }
  }
  if (!response.ok) {
    const message = payload?.message || `Discord API returned HTTP ${response.status}`;
    const error = new Error(cleanText(message, 240));
    error.status = response.status;
    error.discordCode = Number(payload?.code || 0);
    throw error;
  }
  return payload;
}

// Owners are fixed in code; all other access is live-checked against Discord or an owner-managed DB override.
function isSiteOwner(userOrId) {
  const id = typeof userOrId === 'string' ? userOrId : String(userOrId?.id || '');
  return SITE_OWNER_IDS.has(id);
}

// العضوية مستقلة عن صلاحيات الأدمن أو صلاحية الدخول الممنوحة يدويًا.
// ختم التحقق الموقّع يخفّف طلبات Discord أثناء تحميل الصفحة، ثم يعاد التحقق كل 10 ثوانٍ.
// لا نمسح الجلسة عند أخطاء الشبكة/Rate Limit؛ المسح يكون فقط عند تأكيد أن العضو غير موجود.
const STAFF_MEMBERSHIP_RECHECK_MS = 10_000;
const staffGuildMembershipCache = new Map();
async function isCurrentStaffGuildMember(userId) {
  const id = String(userId || '');
  if (!/^\d{15,22}$/.test(id)) return false;
  const now = Date.now();
  const existing = staffGuildMembershipCache.get(id);
  if (existing && typeof existing.value === 'boolean' && existing.expiresAt > now) return existing.value;
  if (existing?.inflight) return existing.inflight;

  const entry = { inflight: null };
  entry.inflight = discordApi(`/guilds/${STAFF_GUILD_ID}/members/${id}`)
    .then(() => true)
    .catch((error) => {
      // Discord code 10007 = Unknown Member. Do not treat Unknown Guild or other 404s as a kick.
      if (Number(error?.discordCode) === 10007 || /unknown member/i.test(String(error?.message || ''))) return false;
      throw error;
    });
  staffGuildMembershipCache.set(id, entry);
  try {
    const isMember = await entry.inflight;
    staffGuildMembershipCache.set(id, { value: isMember, expiresAt: Date.now() + (isMember ? 5000 : 2000) });
    if (staffGuildMembershipCache.size > 4000) {
      const currentTime = Date.now();
      for (const [key, value] of staffGuildMembershipCache) {
        if (value.expiresAt && value.expiresAt <= currentTime) staffGuildMembershipCache.delete(key);
      }
    }
    return isMember;
  } catch (error) {
    if (staffGuildMembershipCache.get(id) === entry) staffGuildMembershipCache.delete(id);
    throw error;
  }
}

async function requireStaffGuildMemberAccess(user, res) {
  if (!user) return true;
  const lastVerifiedAt = Number(user.staffGuildVerifiedAt || 0);
  if (lastVerifiedAt > 0 && Date.now() - lastVerifiedAt < STAFF_MEMBERSHIP_RECHECK_MS) return true;

  let isMember = false;
  try {
    isMember = await isCurrentStaffGuildMember(user.id);
  } catch (error) {
    console.warn('[staff guild membership check]', cleanText(error?.message || error, 160));
    // Keep the signed-in session intact for temporary Discord failures; deny this API request, not the account.
    sendError(res, 503, 'تعذر التحقق من عضوية سيرفر الإدارة مؤقتًا بسبب Discord أو ضغط الطلبات. لم يتم تسجيل خروجك؛ جرّب تحديث الصفحة بعد لحظات.');
    return false;
  }
  if (!isMember) {
    res.setHeader('Set-Cookie', clearCookie(COOKIE_NAME));
    sendError(res, 401, 'حسابك مش موجود حاليًا في سيرفر الإدارة، وبالتالي تم سحب صلاحية دخول الموقع. لازم تكون عضوًا في السيرفر لتسجيل الدخول.');
    return false;
  }

  user.staffGuildVerifiedAt = Date.now();
  res.setHeader('Set-Cookie', createSessionCookie(user));
  return true;
}
async function getSiteManagerAction(userId) {
  const id = String(userId || '');
  if (!/^\d{15,22}$/.test(id)) return null;
  await ensureSchema();
  const sql = await getSql();
  const rows = await sql`SELECT action FROM site_manager_access WHERE user_id = ${id}`;
  return rows[0]?.action || null;
}
async function getSiteUserBlock(userId) {
  const id = String(userId || '');
  if (!/^\d{15,22}$/.test(id)) return null;
  return cached(`site-user-block:${id}`, 5000, async () => {
    await ensureSchema();
    const sql = await getSql();
    const rows = await sql`SELECT user_id AS "userId", username, reason, blocked_by AS "blockedBy", blocked_at AS "blockedAt" FROM site_user_blocks WHERE user_id = ${id} LIMIT 1`;
    return rows[0] || null;
  });
}
async function getPrimaryGuildAdministratorStatus(userId) {
  const id = String(userId || '');
  return cached(`main-guild-member-authz:${id}`, 20_000, async () => {
    const [roles, member, guild] = await Promise.all([
      cached(`main-guild-roles:${MAIN_GUILD_ID}`, 120_000, async () => {
        const items = await discordApi(`/guilds/${MAIN_GUILD_ID}/roles`);
        return (items || []).map((role) => ({ id: String(role.id), permissions: String(role.permissions || '0') }));
      }),
      discordApi(`/guilds/${MAIN_GUILD_ID}/members/${id}`),
      cached(`main-guild-info:${MAIN_GUILD_ID}`, 120_000, async () => discordApi(`/guilds/${MAIN_GUILD_ID}`)),
    ]);
    const assigned = new Set((member?.roles || []).map(String));
    const hasAdministratorRole = roles.some((role) => {
      if (!assigned.has(role.id)) return false;
      try { return (BigInt(role.permissions || '0') & 8n) === 8n; } catch { return false; }
    });
    const isAdministrator = String(guild?.owner_id || '') === id || hasAdministratorRole;
    return { isAdministrator, isPrimaryServerMember: true };
  });
}
async function refreshSessionPrivileges(user) {
  if (!user) return null;
  const userId = String(user.id || '');
  if (isSiteOwner(userId)) {
    return { ...user, isOwner: true, isManager: false, isAdmin: true, canManage: true, permissionCheckError: false, siteAccessOverride: 'owner' };
  }
  let action;
  try { action = await getSiteManagerAction(userId); }
  catch (error) {
    console.warn('[site access override]', cleanText(error?.message || error, 160));
    return { ...user, isOwner: false, isManager: false, isAdmin: false, canManage: false, permissionCheckError: true };
  }
  if (action === 'deny') {
    return { ...user, isOwner: false, isManager: false, isAdmin: false, canManage: false, permissionCheckError: false, siteAccessOverride: 'deny' };
  }
  if (action === 'grant') {
    return { ...user, isOwner: false, isManager: true, isAdmin: false, canManage: true, permissionCheckError: false, siteAccessOverride: 'grant' };
  }
  try {
    const effective = await getPrimaryGuildAdministratorStatus(userId);
    return { ...user, isOwner: false, isManager: false, isAdmin: Boolean(effective.isAdministrator), canManage: Boolean(effective.isAdministrator), isPrimaryServerMember: true, permissionCheckError: false, siteAccessOverride: null };
  } catch (error) {
    // Never keep admin permissions from a stale session if Discord cannot verify the current role state.
    console.warn('[manager permission refresh]', cleanText(error?.message || error, 160));
    return { ...user, isOwner: false, isManager: false, isAdmin: false, canManage: false, isPrimaryServerMember: false, permissionCheckError: true };
  }
}

const AUDIT_ACTIONS = {
  1: ['تعديل إعدادات السيرفر', 'edit'],
  10: ['إنشاء روم', 'create'], 11: ['تعديل روم', 'edit'], 12: ['حذف روم', 'danger'],
  13: ['إضافة صلاحية روم', 'create'], 14: ['تعديل صلاحية روم', 'edit'], 15: ['حذف صلاحية روم', 'danger'],
  20: ['طرد عضو', 'danger'], 21: ['تنظيف أعضاء (Prune)', 'danger'], 22: ['حظر عضو', 'danger'], 23: ['فك حظر', 'create'],
  24: ['تعديل عضو', 'edit'], 25: ['تعديل رتب عضو', 'edit'], 26: ['نقل عضو صوتيًا', 'edit'], 27: ['فصل عضو من الصوت', 'edit'], 28: ['إضافة بوت', 'create'],
  30: ['إنشاء رتبة', 'create'], 31: ['تعديل رتبة', 'edit'], 32: ['حذف رتبة', 'danger'],
  40: ['إنشاء دعوة', 'create'], 41: ['تعديل دعوة', 'edit'], 42: ['حذف دعوة', 'danger'],
  50: ['إنشاء Webhook', 'create'], 51: ['تعديل Webhook', 'edit'], 52: ['حذف Webhook', 'danger'],
  60: ['إضافة إيموجي', 'create'], 61: ['تعديل إيموجي', 'edit'], 62: ['حذف إيموجي', 'danger'],
  72: ['حذف رسالة', 'danger'], 73: ['حذف رسائل جماعي', 'danger'], 74: ['تثبيت رسالة', 'edit'], 75: ['إلغاء تثبيت رسالة', 'edit'],
  80: ['إضافة تكامل', 'create'], 81: ['تعديل تكامل', 'edit'], 82: ['حذف تكامل', 'danger'],
  83: ['إنشاء Stage', 'create'], 84: ['تعديل Stage', 'edit'], 85: ['حذف Stage', 'danger'],
  90: ['إضافة ستيكر', 'create'], 91: ['تعديل ستيكر', 'edit'], 92: ['حذف ستيكر', 'danger'],
  100: ['إنشاء حدث', 'create'], 101: ['تعديل حدث', 'edit'], 102: ['حذف حدث', 'danger'],
  110: ['إنشاء ثريد', 'create'], 111: ['تعديل ثريد', 'edit'], 112: ['حذف ثريد', 'danger'],
  121: ['تعديل صلاحيات أمر', 'edit'],
  140: ['إنشاء قاعدة AutoMod', 'create'], 141: ['تعديل قاعدة AutoMod', 'edit'], 142: ['حذف قاعدة AutoMod', 'danger'],
  143: ['AutoMod حجب رسالة', 'edit'], 144: ['AutoMod أبلغ عن رسالة', 'edit'], 145: ['AutoMod تايم أوت', 'danger'],
};
function auditValue(value) {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) {
    const names = value.map((item) => (item && typeof item === 'object' ? (item.name || item.id) : item)).filter(Boolean);
    return cleanText(names.join('، ') || '—', 160);
  }
  if (typeof value === 'object') return cleanText(JSON.stringify(value), 160);
  return cleanText(String(value), 160);
}
function discordAvatarUrl(user) {
  if (!user) return '';
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`;
}
async function getMainAuditLog(query = {}) {
  const LIMIT = 50;
  const params = new URLSearchParams({ limit: String(LIMIT) });
  const before = String(query.before || '');
  if (/^\d{15,22}$/.test(before)) params.set('before', before);
  const actionType = Number(query.actionType);
  if (Number.isInteger(actionType) && actionType > 0 && actionType <= 200) params.set('action_type', String(actionType));
  const userId = String(query.userId || '');
  if (/^\d{15,22}$/.test(userId)) params.set('user_id', userId);
  const data = await discordApi(`/guilds/${MAIN_GUILD_ID}/audit-logs?${params.toString()}`);
  const users = new Map((data?.users || []).map((item) => [item.id, item]));
  const rawEntries = data?.audit_log_entries || [];
  const entries = rawEntries.map((entry) => {
    const actor = users.get(entry.user_id);
    const target = entry.target_id ? users.get(entry.target_id) : null;
    const [label, tone] = AUDIT_ACTIONS[entry.action_type] || [`حدث #${entry.action_type}`, 'edit'];
    const nameChange = (entry.changes || []).find((change) => change.key === 'name');
    let targetName = '';
    if (target) targetName = target.global_name || target.username || '';
    else if (nameChange) targetName = auditValue(nameChange.new_value ?? nameChange.old_value);
    return {
      id: String(entry.id),
      createdAt: new Date(Number((BigInt(entry.id) >> 22n) + 1420070400000n)).toISOString(),
      actionType: Number(entry.action_type),
      label,
      tone,
      actor: actor ? { id: actor.id, username: actor.global_name || actor.username, avatarUrl: discordAvatarUrl(actor) } : { id: String(entry.user_id || ''), username: entry.user_id ? String(entry.user_id) : 'غير معروف', avatarUrl: '' },
      targetId: entry.target_id ? String(entry.target_id) : '',
      targetName: cleanText(targetName, 120),
      targetAvatarUrl: target ? discordAvatarUrl(target) : '',
      reason: cleanText(entry.reason || '', 300),
      changes: (entry.changes || []).slice(0, 8).map((change) => ({ key: cleanText(change.key, 40), oldValue: auditValue(change.old_value), newValue: auditValue(change.new_value) })),
      count: entry.options?.count ? Number(entry.options.count) : 0,
      channelId: entry.options?.channel_id ? String(entry.options.channel_id) : '',
    };
  });
  return { entries, hasMore: rawEntries.length >= LIMIT, nextBefore: entries.length ? entries[entries.length - 1].id : null };
}
function parseTaskLines(content) {
  const tasks = [];
  for (const original of String(content || '').split(/\r?\n/)) {
    let line = original.replace(/<@!?\d+>/g, '').replace(/<#\d+>/g, '').trim();
    if (!line) continue;
    line = line.replace(/^\*\*(.*?)\*\*$/, '$1').replace(/[`*_~]/g, '').trim();
    const taskMatch = line.match(/^(?:(?:[-•▪▫*])|(?:\d{1,3}[.)-]))\s*(?:\[(إجباري|اجباري|required|mandatory|اختياري|optional)\]\s*)?(.+)$/i);
    const explicitMatch = line.match(/^(?:مهمة|task)\s*[:：-]\s*(.+)$/i);
    let title = '';
    let required = false;
    let points = 1;
    if (taskMatch) {
      const tag = (taskMatch[1] || '').toLowerCase();
      title = taskMatch[2].trim();
      required = ['إجباري', 'اجباري', 'required', 'mandatory'].includes(tag);
    } else if (explicitMatch) {
      title = explicitMatch[1].trim();
      required = /^\[(?:إجباري|اجباري|required|mandatory)\]/i.test(title);
      title = title.replace(/^\[(?:إجباري|اجباري|required|mandatory|اختياري|optional)\]\s*/i, '');
    } else continue;
    const pointsMatch = title.match(/\s+\[(\d+(?:[.,]\d{1,2})?)\s*(?:نقطة|نقاط|points?)\]\s*$/i);
    if (pointsMatch) {
      points = Number(pointsMatch[1].replace(',', '.'));
      title = title.slice(0, pointsMatch.index).trim();
    }
    title = cleanText(title.replace(/^#\d+\s*[—–-]\s*/, '').replace(/^#\d+\s+/, ''), 240);
    if (title && !/^(?:مهمات جديدة|المهمات|المهام|إدارة البرج)$/i.test(title)) tasks.push({ title, required, points });
  }
  return tasks;
}
async function syncDiscordTasks(sql) {
  if (!BOT_TOKEN || !TASKS_CHANNEL_ID) return;
  if (Date.now() - lastTaskSyncAt < 30_000) return taskSyncPromise;
  if (taskSyncPromise) return taskSyncPromise;
  taskSyncPromise = (async () => { try {
    const messages = await discordApi(`/channels/${TASKS_CHANNEL_ID}/messages?limit=50`);
    const ordered = (messages || []).slice().reverse();
    for (const message of ordered) {
      if (!message?.content) continue;
      const parsed = parseTaskLines(message.content);
      for (let index = 0; index < parsed.length; index += 1) {
        const task = parsed[index];
        await sql`INSERT INTO tasks (title, points, required, active, created_by, created_by_name, created_at, source_message_id, source_line_index)
          VALUES (${task.title}, ${task.points ?? 1}, ${task.required}, TRUE, ${message.author?.id || 'discord-system'}, ${message.author?.global_name || message.author?.username || 'Discord'}, NOW(), ${message.id}, ${index})
          ON CONFLICT (source_message_id, source_line_index) DO NOTHING`;
      }
    }
  } catch (error) {
    // Keep already-saved tasks accessible even if Discord cannot be reached.
    console.error('[task sync]', cleanText(error.message, 200));
  } finally {
    lastTaskSyncAt = Date.now();
    taskSyncPromise = null;
  } })();
  return taskSyncPromise;
}
async function postDiscordMessage(channelId, content, allowedMentions = { parse: [] }) {
  const parts = [];
  let current = '';
  for (const line of String(content || '').split('\n')) {
    if (current.length + line.length + 1 > 1850 && current) { parts.push(current); current = ''; }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) parts.push(current);
  let last = null;
  for (const part of parts.length ? parts : ['']) {
    last = await discordApi(`/channels/${channelId}/messages`, {
      method: 'POST', body: JSON.stringify({ content: part.slice(0, 1990), allowed_mentions: allowedMentions }),
    });
  }
  return last;
}
function formatPoints(value) {
  return (Math.round(Number(value || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
async function postDiscordEmbed(channelId, embed) {
  return discordApi(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
  });
}
// رسالة موحدة بعد القبول أو الرفض: نفس النص سواء القرار من الموقع أو من ديسكورد.
async function postSubmissionDecisionMessage({ req, submissionId, sub, reviewerId, status, reason = '', taskRows, amount = 0, totalAfter = 0 }) {
  const notification = buildSubmissionNotifications({ submissionId, sub, reviewerId, status, reason, taskRows, amount, totalAfter });
  const files = parseJson(sub.files_json, []);
  const { attachments, linkOnly } = await loadEvidenceAttachments(req, files);
  let content = notification.announcementContent;
  if (linkOnly.length) content += `\n\n📎 **مرفقات كبيرة:**\n${linkOnly.join('\n')}`;
  content = content.slice(0, 1990);
  return postDiscordWithFiles(TASK_APPROVED_CHANNEL_ID, { content, allowed_mentions: { parse: [] } }, attachments);
}

// ===== فحص الملفات المرفوعة فعليًا (مش بس الامتداد/النوع اللي المتصفح بيقوله) =====
const MEDIA_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
function detectMediaType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'video/webm';
  return null;
}
async function sniffBlobMime(pathname) {
  if (!blobSdkPromise) blobSdkPromise = import('@vercel/blob');
  const { get } = await blobSdkPromise;
  const result = await get(pathname, { access: 'private', token: blobToken() || undefined });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  const reader = result.stream.getReader();
  let buf = Buffer.alloc(0);
  try {
    while (buf.length < 16) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = Buffer.concat([buf, Buffer.from(value)]);
    }
  } finally { try { await reader.cancel(); } catch { /* ignore */ } }
  return detectMediaType(buf);
}
async function sha256Blob(pathname) {
  if (!blobSdkPromise) blobSdkPromise = import('@vercel/blob');
  const { get } = await blobSdkPromise;
  const result = await get(pathname, { access: 'private', token: blobToken() || undefined });
  if (!result || result.statusCode !== 200 || !result.stream) throw new Error('تعذر قراءة الصورة لحساب بصمتها.');
  const hash = crypto.createHash('sha256');
  const reader = result.stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      hash.update(Buffer.from(value));
    }
  } finally { try { reader.releaseLock(); } catch { /* no-op */ } }
  return hash.digest('hex');
}
async function deleteBlobQuietly(pathname) {
  try { if (!blobSdkPromise) blobSdkPromise = import('@vercel/blob'); const { del } = await blobSdkPromise; await del(pathname, { token: blobToken() || undefined }); } catch { /* ignore */ }
}
// يحمّل الأدلة من التخزين الخاص عشان تتبعت كمرفقات حقيقية في ديسكورد (بأسماء آمنة بدل اسم الملف الأصلي).
async function loadEvidenceAttachments(req, files) {
  const MAX_TOTAL = 9 * 1024 * 1024;
  const attachments = [];
  const linkOnly = [];
  let total = 0;
  if (!files.length) return { attachments, linkOnly };
  if (!blobSdkPromise) blobSdkPromise = import('@vercel/blob');
  const { get } = await blobSdkPromise;
  for (const file of files) {
    const link = `${siteUrl(req)}/api/evidence?token=${encodeURIComponent(file.token)}`;
    const label = `• ${cleanText(file.originalName, 100)}: ${link}`;
    if (attachments.length >= 10 || total + Number(file.size || 0) > MAX_TOTAL) { linkOnly.push(label); continue; }
    try {
      const result = await get(file.pathname, { access: 'private', token: blobToken() || undefined });
      if (!result || result.statusCode !== 200 || !result.stream) throw new Error('missing blob');
      const data = Buffer.from(await new Response(result.stream).arrayBuffer());
      const type = detectMediaType(data);
      if (!type) { linkOnly.push(`• ${cleanText(file.originalName, 100)}: ⚠️ ملف مش صورة/فيديو حقيقي، متفتحوش`); continue; }
      if (total + data.length > MAX_TOTAL) { linkOnly.push(label); continue; }
      total += data.length;
      attachments.push({ name: `evidence-${attachments.length + 1}.${MEDIA_EXT[type] || 'bin'}`, type, data });
    } catch (error) {
      console.error('[evidence attachment]', cleanText(error.message, 160));
      linkOnly.push(label);
    }
  }
  return { attachments, linkOnly };
}
async function postDiscordWithFiles(channelId, payload, attachments) {
  if (!attachments.length) return discordApi(`/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify(payload) });
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ ...payload, attachments: attachments.map((file, index) => ({ id: index, filename: file.name })) }));
  attachments.forEach((file, index) => form.append(`files[${index}]`, new Blob([file.data], { type: file.type }), file.name));
  return discordApi(`/channels/${channelId}/messages`, { method: 'POST', body: form });
}

function buildLeaveEmbed(item, status = 'pending', reviewerId = '', note = '') {
  const id = Number(item.id);
  const userId = String(item.user_id ?? item.userId ?? '');
  const username = String(item.username || 'عضو الاستاف');
  const startDate = String(item.start_date ?? item.startDate ?? '').slice(0, 10);
  const endDate = String(item.end_date ?? item.endDate ?? '').slice(0, 10);
  const reason = String(item.reason || 'بدون سبب').slice(0, 1024);
  const isApproved = status === 'approved';
  const isRejected = status === 'rejected';
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
  const embed = {
    title: status === 'pending' ? `🗓️ طلب إجازة جديد #${id}` : isApproved ? `✅ تمت الموافقة على طلب الإجازة #${id}` : `❌ تم رفض طلب الإجازة #${id}`,
    description: status === 'pending' ? 'طلب إجازة جديد بانتظار مراجعة مسؤولي الإدارة.' : isApproved ? 'تمت الموافقة على طلب الإجازة.' : 'تم رفض طلب الإجازة.',
    color: status === 'pending' ? 0x8b5cf6 : isApproved ? 0x22c55e : 0xef4444,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: 'إدارة البرج • طلبات الإجازة' },
  };
  const avatarUrl = item.avatar_url ?? item.avatarUrl;
  if (avatarUrl) embed.thumbnail = { url: avatarUrl };
  return embed;
}
function leaveReviewComponents(id) {
  return [{ type: 1, components: [
    { type: 2, style: 3, label: 'قبول الإجازة', custom_id: `leave:approve:${id}` },
    { type: 2, style: 4, label: 'رفض الإجازة', custom_id: `leave:reject:${id}` },
  ] }];
}

// إشعار داخل الموقع لكل المسؤولين (جدول واحد + علامة "آخر ما اتقرا" لكل مسؤول).
async function pushAdminNotification(sql, { type, title, body = '', refId = null, actorId = null }) {
  try {
    await sql`INSERT INTO admin_notifications(type, title, body, ref_id, actor_id) VALUES (${type}, ${cleanText(title, 160)}, ${cleanText(body, 400)}, ${refId}, ${actorId})`;
    if (Math.random() < 0.03) await sql`DELETE FROM admin_notifications WHERE created_at < NOW() - INTERVAL '30 days'`;
  } catch (error) { console.error('[admin notification]', cleanText(error?.message || error, 180)); }
}
function dmNote(dm) {
  if (!dm || dm.ok) return '';
  return dm.reason === 'dm-closed' ? ' (تعذر إرسال إشعار خاص للعضو لأن الرسائل الخاصة مقفولة عنده)' : ' (تعذر إرسال إشعار خاص للعضو)';
}

function parseRequestUrl(req) {
  const host = req.headers?.host || 'localhost';
  const proto = req.headers?.['x-forwarded-proto'] || 'https';

  return new URL(req.url || '/', `${proto}://${host}`);
}

function parseRoute(req) {
  const parts = req.query?.path;
  let segments;

  if (Array.isArray(parts) && parts.length > 0) {
    segments = parts;
  } else if (
    parts !== undefined &&
    parts !== null &&
    String(parts).length > 0
  ) {
    segments = String(parts).split('/');
  } else {
    const url = parseRequestUrl(req);
    let pathname = url.pathname || '/';

    if (pathname === '/api') {
      pathname = '/';
    } else if (pathname.startsWith('/api/')) {
      pathname = pathname.slice('/api/'.length);
    }

    segments = pathname.split('/');
  }

  return segments
    .map((part) => decodeURIComponent(String(part)))
    .filter(Boolean);
}


async function handleAuth(parts, req, res) {
  const action = parts[1] || '';
  const url = parseRequestUrl(req);
  if (action === 'discord' && req.method === 'GET') {
    if (!process.env.DISCORD_CLIENT_SECRET || !DISCORD_CLIENT_ID) return sendText(res, 503, 'أكمل إعدادات Discord OAuth في Environment Variables أولًا.');
    const state = crypto.randomBytes(24).toString('hex');
    const redirectUri = process.env.DISCORD_REDIRECT_URI || `${siteUrl(req)}/auth/callback`;
    const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: 'identify guilds', state, prompt: 'consent' });
    res.setHeader('Set-Cookie', makeCookie(OAUTH_COOKIE, state, 600));
    res.statusCode = 302;
    res.setHeader('Location', `https://discord.com/oauth2/authorize?${params.toString()}`);
    return res.end();
  }
  if (action === 'callback' && req.method === 'GET') {
    const state = cleanText(url.searchParams.get('state'), 200);
    const code = cleanText(url.searchParams.get('code'), 2048);
    const cookies = cookieMap(req);
    if (!state || !code || !cookies[OAUTH_COOKIE] || state !== cookies[OAUTH_COOKIE]) return sendText(res, 400, 'رابط تسجيل الدخول غير صالح أو انتهت صلاحيته. ارجع للموقع وجرّب مرة أخرى.');
    try {
      const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET || '', grant_type: 'authorization_code', code, redirect_uri: process.env.DISCORD_REDIRECT_URI || `${siteUrl(req)}/auth/callback` }),
      });
      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok || !tokenData.access_token) throw new Error('فشل Discord في إتمام تسجيل الدخول. راجع Client Secret وRedirect URI.');
      const headers = { Authorization: `Bearer ${tokenData.access_token}` };
      const [userResponse, guildResponse] = await Promise.all([fetch(`${DISCORD_API}/users/@me`, { headers }), fetch(`${DISCORD_API}/users/@me/guilds`, { headers })]);
      if (!userResponse.ok || !guildResponse.ok) throw new Error('تعذر التحقق من حساب Discord.');
      const discordUser = await userResponse.json();
      const guilds = await guildResponse.json();
      const staffGuild = guilds.find((guild) => guild.id === STAFF_GUILD_ID);
      const mainGuild = guilds.find((guild) => guild.id === MAIN_GUILD_ID);
      const isOwner = isSiteOwner(discordUser.id);
      const memberLookups = await Promise.allSettled([discordApi(`/guilds/${MAIN_GUILD_ID}/members/${discordUser.id}`), discordApi(`/guilds/${STAFF_GUILD_ID}/members/${discordUser.id}`)]);
      const mainMemberData = memberLookups[0].status === 'fulfilled' ? memberLookups[0].value : null;
      const staffMemberData = memberLookups[1].status === 'fulfilled' ? memberLookups[1].value : null;
      let accessAction = null;
      try { accessAction = await getSiteManagerAction(discordUser.id); }
      catch (error) { console.warn('[oauth manager override]', cleanText(error?.message || error, 160)); }
      const hasOAuthAdministrator = (guild) => { try { return (BigInt(guild?.permissions || 0) & 8n) === 8n; } catch { return false; } };
      let hasDiscordAdministrator = hasOAuthAdministrator(mainGuild);
      if (!hasDiscordAdministrator && mainMemberData) {
        try {
          const roles = await cached(`main-guild-roles:${MAIN_GUILD_ID}`, 120_000, async () => {
            const items = await discordApi(`/guilds/${MAIN_GUILD_ID}/roles`);
            return (items || []).map((role) => ({ id: String(role.id), permissions: String(role.permissions || '0') }));
          });
          const assigned = new Set((mainMemberData.roles || []).map(String));
          hasDiscordAdministrator = roles.some((role) => {
            if (!assigned.has(role.id)) return false;
            try { return (BigInt(role.permissions || '0') & 8n) === 8n; } catch { return false; }
          });
        } catch { /* fail closed below; ordinary staff login remains available */ }
      }
      const siteBlock = await getSiteUserBlock(discordUser.id);
      if (siteBlock && !isOwner) {
        res.setHeader('Set-Cookie', clearCookie(OAUTH_COOKIE));
        return sendText(res, 403, 'تم منع هذا الحساب من استخدام الموقع بواسطة الإدارة. لو تعتقد أن ده بالخطأ، تواصل مع مالك الموقع.');
      }
      const deniedByOwner = !isOwner && accessAction === 'deny';
      const isManager = !isOwner && !deniedByOwner && accessAction === 'grant';
      const isAdmin = !deniedByOwner && (isOwner || Boolean(mainGuild?.owner) || hasDiscordAdministrator);
      // Discord OAuth guild list is the user's own live membership proof at sign-in;
      // the bot lookup is an additional confirmation when available.
      const isStaffGuildMember = Boolean(staffGuild || staffMemberData);
      if (!isStaffGuildMember) {
        res.setHeader('Set-Cookie', clearCookie(OAUTH_COOKIE));
        return sendText(res, 403, `تسجيل الدخول للموقع متاح لأعضاء سيرفر الإدارة فقط. حسابك مش موجود في سيرفر الإدارة (${STAFF_GUILD_ID})؛ ادخل السيرفر ثم جرّب تاني.`);
      }
      const user = {
        id: discordUser.id,
        username: discordUser.global_name || discordUser.username,
        handle: discordUser.username,
        avatar: discordUser.avatar || null,
        avatarUrl: avatarUrl(discordUser),
        isOwner,
        isAdmin,
        isManager,
        canManage: Boolean(isOwner || isManager || isAdmin),
        isStaffGuildMember,
        staffGuildVerifiedAt: Date.now(),
      };
      res.setHeader('Set-Cookie', [createSessionCookie(user), clearCookie(OAUTH_COOKIE)]);
      res.statusCode = 302;
      res.setHeader('Location', '/');
      return res.end();
    } catch (error) {
      console.error('[oauth]', cleanText(error.message, 200));
      res.setHeader('Set-Cookie', clearCookie(OAUTH_COOKIE));
      return sendText(res, 502, `تعذر تسجيل الدخول: ${cleanText(error.message, 240)}`);
    }
  }
  if (action === 'logout' && req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    if (!ensureSameOrigin(req, res)) return;
    res.setHeader('Set-Cookie', clearCookie(COOKIE_NAME));
    return sendJson(res, 200, { ok: true });
  }
  sendError(res, 404, 'المسار غير موجود.');
}

// يدور على توكن Blob حتى لو الـ Store اتربط باسم متغير مختلف (مثلاً بـ Prefix مخصص).
function blobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN.trim();
  for (const [name, value] of Object.entries(process.env)) {
    if (/BLOB_READ_WRITE_TOKEN$/.test(name) && String(value || '').startsWith('vercel_blob_rw_')) return String(value).trim();
  }
  return '';
}
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' && req.body) { try { return JSON.parse(req.body); } catch { return {}; } }
  if (Buffer.isBuffer(req.body) && req.body.length) { try { return JSON.parse(req.body.toString('utf8')); } catch { return {}; } }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

async function handleUploadToken(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'الطريقة غير مدعومة.');
  if (!blobClientSdkPromise) blobClientSdkPromise = import('@vercel/blob/client');
  const { handleUpload } = await blobClientSdkPromise;
  const token = blobToken();
  if (!token) return sendError(res, 503, 'تخزين الملفات (Vercel Blob) مش مربوط بالمشروع: أنشئ Blob Store واربطه بالمشروع ثم أعد النشر (Redeploy).');
  const body = await readJsonBody(req);
  try {
    const result = await handleUpload({
      token,
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        // Authentication is required when creating an upload token. Vercel's
        // server-to-server completion callback is validated by handleUpload itself
        // and does not carry the user's browser cookie.
        const user = getSessionUser(req);
        if (!user) throw new Error('سجل دخولك بديسكورد أولًا.');
        if (!originIsAllowed(req)) throw new Error('تم رفض الطلب لأسباب أمنية.');
        const safePath = String(pathname || '');
        if (!safePath.startsWith(`evidence/${user.id}/`)) throw new Error('مسار الملف غير صالح.');
        return {
          access: 'private',
          addRandomSuffix: true,
          allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'],
          maximumSizeInBytes: MAX_UPLOAD_MB * 1024 * 1024,
          tokenPayload: JSON.stringify({ userId: user.id }),
        };
      },
    });
    return sendJson(res, 200, result);
  } catch (error) {
    console.error('[blob upload]', cleanText(error.message, 200));
    return sendError(res, 400, cleanText(error.message || 'تعذر بدء رفع الملف.', 220));
  }
}

async function sendPrivateEvidence(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'الطريقة غير مدعومة.');
  const url = parseRequestUrl(req);
  const token = cleanText(url.searchParams.get('token'), 150);
  if (!token) return sendError(res, 404, 'الملف غير موجود.');
  await ensureSchema();
  const sql = await getSql();
  const rows = await sql`SELECT files_json FROM submissions WHERE files_json @> ${JSON.stringify([{ token }])}::jsonb LIMIT 1`;
  if (!rows.length) return sendError(res, 404, 'الملف غير موجود أو انتهت صلاحية رابطه.');
  const files = parseJson(rows[0].files_json, []);
  const file = files.find((item) => item.token === token);
  if (!file?.pathname) return sendError(res, 404, 'الملف غير موجود.');
  if (!blobSdkPromise) blobSdkPromise = import('@vercel/blob');
  const { get } = await blobSdkPromise;
  const result = await get(file.pathname, { access: 'private', token: blobToken() || undefined });
  if (!result || result.statusCode !== 200 || !result.stream) return sendError(res, 404, 'الملف غير موجود في التخزين.');
  res.statusCode = 200;
  res.setHeader('Content-Type', file.mimeType || result.blob.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${String(file.mimeType || '').startsWith('image/') || String(file.mimeType || '').startsWith('video/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.originalName || 'evidence-file')}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, no-store');
  Readable.fromWeb(result.stream).pipe(res);
}

async function fetchGuildMembers(guildId) {
  const firstPage = await discordApi(`/guilds/${guildId}/members?limit=1000`);
  const members = Array.isArray(firstPage) ? [...firstPage] : [];
  let lastPageCount = members.length;
  let after = members.length ? members[members.length - 1].user?.id : null;
  for (let guard = 0; lastPageCount === 1000 && after && guard < 20; guard += 1) {
    const next = await discordApi(`/guilds/${guildId}/members?limit=1000&after=${after}`);
    if (!Array.isArray(next) || !next.length) break;
    members.push(...next);
    lastPageCount = next.length;
    after = next[next.length - 1].user?.id;
  }
  return members;
}

async function getRoster() {
  // The directory still lists staff-server members, but their displayed roles
  // come from the main server so the hierarchy reflects the real admin ranks.
  const [mainGuild, mainRoles, staffMembers, mainMembers, staffRoles] = await Promise.all([
    discordApi(`/guilds/${MAIN_GUILD_ID}`),
    discordApi(`/guilds/${MAIN_GUILD_ID}/roles`),
    fetchGuildMembers(STAFF_GUILD_ID),
    fetchGuildMembers(MAIN_GUILD_ID),
    discordApi(`/guilds/${STAFF_GUILD_ID}/roles`),
  ]);
  const staffRoleById = new Map((staffRoles || []).map((role) => [role.id, role]));
  const sortedRoles = (mainRoles || []).filter((role) => role.id !== MAIN_GUILD_ID)
    .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name, 'ar'));
  const roleById = new Map(sortedRoles.map((role) => [role.id, role]));
  const mainMemberById = new Map((mainMembers || []).filter((member) => member?.user).map((member) => [member.user.id, member]));
  const groupMembers = new Map();
  const noRole = [];
  const missingMainGuild = [];
  let overrideById = new Map();
  try {
    await ensureSchema();
    const sql = await getSql();
    const overrides = await sql`SELECT user_id, action FROM site_manager_access`;
    overrideById = new Map(overrides.map((row) => [String(row.user_id), String(row.action)]));
  } catch (error) { console.warn('[roster site access]', cleanText(error?.message || error, 160)); }
  const toHex = (value) => `#${Math.max(0, Number(value) || 0).toString(16).padStart(6, '0').slice(-6)}`;
  const rows = (staffMembers || []).filter((member) => member.user && !member.user.bot).map((member) => {
    const mainMember = mainMemberById.get(member.user.id) || null;
    const assigned = mainMember
      ? (mainMember.roles || []).map((id) => roleById.get(id)).filter(Boolean).sort((a, b) => b.position - a.position)
      : [];
    const highest = assigned[0] || null;
    let avatar = member.user.avatar
      ? `https://cdn.discordapp.com/avatars/${member.user.id}/${member.user.avatar}.png?size=64`
      : null;
    if (!avatar) {
      let index = 0;
      try { index = Number((BigInt(member.user.id) >> 22n) % 6n); } catch { index = 0; }
      avatar = `https://cdn.discordapp.com/embed/avatars/${index}.png`;
    }
    const row = {
      id: member.user.id,
      username: mainMember?.nick || member.nick || member.user.global_name || member.user.username,
      handle: member.user.username,
      joinedAt: member.joined_at || null,
      mainJoinedAt: mainMember?.joined_at || null,
      avatarUrl: avatar,
      roleName: highest?.name || (mainMember ? 'بدون رتبة في السيرفر الأساسي' : 'مش موجود في السيرفر الأساسي'),
      roleId: highest?.id || (mainMember ? 'none' : 'not-in-main'),
      rolePosition: highest?.position ?? (mainMember ? -1 : -2),
      roleColor: highest ? toHex(highest.color) : '#64748b',
      roles: assigned.map((role) => ({ id: role.id, name: role.name, position: role.position, color: toHex(role.color) })),
      isOwner: isSiteOwner(member.user.id),
      isDiscordAdministrator: String(mainGuild?.owner_id || '') === String(member.user.id) || Boolean(assigned.some((role) => { try { return (BigInt(role.permissions || 0) & 8n) === 8n; } catch { return false; } })),
      // Effective site access: owners, owner-granted managers, or Discord Administrator unless explicitly denied.
      isAdmin: isSiteOwner(member.user.id) || overrideById.get(String(member.user.id)) === 'grant' || (overrideById.get(String(member.user.id)) !== 'deny' && (String(mainGuild?.owner_id || '') === String(member.user.id) || assigned.some((role) => { try { return (BigInt(role.permissions || 0) & 8n) === 8n; } catch { return false; } }))),
    };
    if (!mainMember) {
      missingMainGuild.push(row);
    } else if (highest && roleById.has(highest.id)) {
      if (!groupMembers.has(highest.id)) groupMembers.set(highest.id, []);
      groupMembers.get(highest.id).push(row);
    } else {
      noRole.push(row);
    }
    return row;
  });
  for (const group of groupMembers.values()) group.sort((a, b) => a.username.localeCompare(b.username, 'ar'));
  noRole.sort((a, b) => a.username.localeCompare(b.username, 'ar'));
  missingMainGuild.sort((a, b) => a.username.localeCompare(b.username, 'ar'));
  const groups = sortedRoles.map((role) => ({ id: role.id, name: role.name, position: role.position, color: toHex(role.color), members: groupMembers.get(role.id) || [] })).filter((group) => group.members.length);
  if (noRole.length) groups.push({ id: 'none', name: 'بدون رتبة في السيرفر الأساسي', position: -1, color: '#64748b', members: noRole });
  if (missingMainGuild.length) groups.push({ id: 'not-in-main', name: 'مش موجودين في السيرفر الأساسي', position: -2, color: '#64748b', members: missingMainGuild });
  return { guildName: mainGuild.name, memberCount: rows.length, groups };
}

async function updateDiscordSubmissionReview(sub, status, reviewer, reason = '', amount = 0, totalAfter = 0) {
  if (!BOT_TOKEN || !sub?.discord_message_id || !sub?.discord_channel_id) return false;
  try {
    const prior = await discordApi(`/channels/${sub.discord_channel_id}/messages/${sub.discord_message_id}`);
    const source = (prior.embeds || [])[0] || {};
    if (status === 'reopened') {
      const reopened = {
        title: '🔓 إعادة فتح تسليم مهمة',
        description: `تمت إعادة فتح التسليم #${Number(sub.id)} ويمكن للعضو تسليمه مرة أخرى.`,
        color: 0xf59e0b,
        fields: [
          { name: '👤 العضو', value: `<@${sub.user_id}>`, inline: true },
          { name: '🛡️ المسؤول', value: `<@${reviewer}>`, inline: true },
          ...(reason ? [{ name: '📝 ملاحظة', value: cleanText(reason, 400), inline: false }] : []),
        ],
        footer: { text: 'Borg Management • Task Review' },
        timestamp: new Date().toISOString(),
      };
      if (source.thumbnail?.url) reopened.thumbnail = { url: source.thumbnail.url };
      if (source.image?.url) reopened.image = { url: source.image.url };
      await discordApi(`/channels/${sub.discord_channel_id}/messages/${sub.discord_message_id}`, { method: 'PATCH', body: JSON.stringify({ embeds: [reopened], components: [], allowed_mentions: { parse: [] } }) });
      return true;
    }
    const taskRows = await sql`SELECT t.id, t.title, COALESCE(st.points_awarded, t.points) AS points FROM submission_tasks st JOIN tasks t ON t.id = st.task_id WHERE st.submission_id = ${Number(sub.id)} ORDER BY t.id`;
    const notification = buildSubmissionNotifications({ submissionId: sub.id, sub, reviewerId: reviewer, status, taskRows, amount, totalAfter, reason });
    // Match the exact acceptance/rejection embed used by the website and Discord buttons.
    const updated = mergeSubmissionDecisionEmbed(notification.logEmbed, source);
    await discordApi(`/channels/${sub.discord_channel_id}/messages/${sub.discord_message_id}`, { method: 'PATCH', body: JSON.stringify({ embeds: [updated], components: [], allowed_mentions: { parse: [] } }) });
    return true;
  } catch (error) { console.error('[submission discord message update]', cleanText(error.message, 180)); return false; }
}

async function handleApi(parts, req, res) {
  const route = parts[0] || '';
  let user = getSessionUser(req);
  if (user && !(await requireStaffGuildMemberAccess(user, res))) return;
  if (user) user = await refreshSessionPrivileges(user);
  if (user && !isSiteOwner(user) && await getSiteUserBlock(user.id)) {
    res.setHeader('Set-Cookie', clearCookie(COOKIE_NAME));
    return sendError(res, 401, 'تم منع هذا الحساب من استخدام الموقع بواسطة الإدارة.');
  }
  if (req.method !== 'GET' && !ensureSameOrigin(req, res)) return;
  if (route === 'health' && req.method === 'GET') {
    // فحص البوت مرة كل دقيقة بس مهما كان عدد المستخدمين (كان بيعمل طلب Discord مع كل نبضة من كل مستخدم).
    const bot = await cached('bot-health', 60_000, async () => {
      if (!BOT_TOKEN) return { ready: false, error: 'توكن البوت غير مضبوط.' };
      try { await discordApi('/users/@me'); return { ready: true, error: '' }; }
      catch (error) { return { ready: false, error: cleanText(error.message, 200) }; }
    });
    let botReady = bot.ready;
    if (botReady && Date.now() - commandsRegisteredAt > 6 * 60 * 60 * 1000) {
      commandsRegisteredAt = Date.now() - 5 * 60 * 60 * 1000; // لو فشل التسجيل يعيد المحاولة بعد ساعة
      try { await registerSlashCommands(); } catch (error) { console.error('[register commands]', cleanText(error?.message || error, 200)); }
    }
    return sendJson(res, 200, { ok: true, botReady, ...(canManage(user) ? { botLastError: bot.error } : {}), storageReady: Boolean(blobToken()), databaseReady: Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_PRISMA_URL) });
  }
  if (route === 'me' && req.method === 'GET') {
    if (!user) return sendJson(res, 200, { authenticated: false });
    const { staffGuildVerifiedAt, ...publicUser } = user;
    return sendJson(res, 200, { authenticated: true, user: { ...publicUser, canManage: canManage(user) } });
  }
  if (route === 'cron' && parts[1] === 'leave-sync' && req.method === 'GET') {
    const secret = process.env.CRON_SECRET || '';
    const bearer = String(req.headers?.authorization || '');
    const authorizedCron = Boolean(secret) && bearer === `Bearer ${secret}`;
    if (!authorizedCron && !canManage(user)) return sendError(res, 401, 'غير مصرح. اضبط CRON_SECRET على Vercel.');
    await ensureSchema();
    const { syncLeaveRoles } = require('./_lib/leave-roles.js');
    const result = await syncLeaveRoles({ sql: await getSql(), token: BOT_TOKEN, report: true });
    try { await syncChannelMessageCounts(await getSql(), { force: true, budgetMs: 40000 }); } catch (error) { console.error('[cron message sync]', cleanText(error?.message || error, 200)); }
    return sendJson(res, 200, { ok: true, ...result });
  }
  if (route === 'cron' && parts[1] === 'task-deadlines' && req.method === 'GET') {
    const secret = process.env.CRON_SECRET || '';
    const authorizedCron = Boolean(secret) && String(req.headers?.authorization || '') === `Bearer ${secret}`;
    if (!authorizedCron && !canManage(user)) return sendError(res, 401, 'غير مصرح. اضبط CRON_SECRET على Vercel.');
    await ensureSchema();
    const sql = await getSql();
    const closed = await sql`UPDATE tasks SET active = FALSE WHERE active = TRUE AND deadline_at IS NOT NULL AND deadline_at <= NOW() RETURNING id`;
    const reminders = BOT_TOKEN ? await sql`UPDATE tasks SET deadline_reminded_at = NOW() WHERE active = TRUE AND deadline_at IS NOT NULL AND deadline_at > NOW() AND deadline_at <= NOW() + INTERVAL '24 hours' AND deadline_reminded_at IS NULL RETURNING id, title, deadline_at, required` : [];
    // تدريجيًا، احسب بصمات الصور المرفوعة في الإصدارات القديمة حتى تُكتشف التكرارات التاريخية أيضًا.
    let backfilledImages = 0;
    try {
      const legacyRows = await sql`SELECT id, user_id, username, files_json FROM submissions WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(files_json) f WHERE COALESCE(f->>'sha256', '') = '' AND COALESCE(f->>'mimeType', '') LIKE 'image/%' AND COALESCE(f->>'pathname', '') LIKE 'evidence/%') ORDER BY id ASC LIMIT 40`;
      for (const legacy of legacyRows) {
        const legacyFiles = parseJson(legacy.files_json, []);
        let changed = false;
        for (const file of legacyFiles) {
          if (backfilledImages >= 5) break;
          if (file?.sha256 || !String(file?.mimeType || '').toLowerCase().startsWith('image/') || !String(file?.pathname || '').startsWith('evidence/')) continue;
          try {
            const sha256 = await sha256Blob(file.pathname);
            file.sha256 = sha256;
            await sql`INSERT INTO submission_file_hashes(submission_id, file_sha256, user_id, username, original_name, created_at) VALUES (${legacy.id}, ${sha256}, ${legacy.user_id}, ${legacy.username}, ${cleanText(file.originalName || 'صورة قديمة', 180)}, NOW()) ON CONFLICT DO NOTHING`;
            backfilledImages += 1;
            changed = true;
          } catch (error) { console.error('[legacy image fingerprint]', cleanText(error?.message || error, 140)); }
        }
        if (changed) await sql`UPDATE submissions SET files_json = ${JSON.stringify(legacyFiles)}::jsonb WHERE id = ${legacy.id}`;
        if (backfilledImages >= 5) break;
      }
    } catch (error) { console.error('[legacy image backfill]', cleanText(error?.message || error, 180)); }
    let recipients = [];
    let dmSent = 0; let dmFailed = 0;
    if (reminders.length && BOT_TOKEN) {
      try {
        const roster = await cached('roster', 120_000, getRoster);
        recipients = (roster.groups || []).flatMap((group) => group.members || []).map((member) => ({ user_id: String(member.id), username: member.username || String(member.id) })).filter((member) => /^\d{15,22}$/.test(member.user_id)).slice(0, 500);
      } catch (error) {
        console.error('[deadline reminder roster]', cleanText(error?.message || error, 160));
        recipients = await sql`SELECT user_id, MAX(username) AS username FROM (SELECT user_id, username FROM site_presence WHERE last_seen > NOW() - INTERVAL '90 days' UNION ALL SELECT user_id, username FROM staff_points UNION ALL SELECT user_id, username FROM submissions UNION ALL SELECT user_id, username FROM discord_message_log WHERE channel_id = ${MESSAGE_COUNT_CHANNEL_ID} AND created_at > NOW() - INTERVAL '90 days') p GROUP BY user_id LIMIT 500`;
      }
      const reminderPages = [];
      for (let i = 0; i < reminders.length; i += 25) {
        const pageTasks = reminders.slice(i, i + 25);
        const reminderFields = pageTasks.map((task) => ({ name: `${task.required ? '🔴' : '⚪'} ${cleanText(task.title, 240)}`.slice(0, 256), value: `#${Number(task.id)} · ينتهي <t:${Math.floor(new Date(task.deadline_at).getTime() / 1000)}:R>`, inline: false }));
        reminderPages.push({ title: `⏰ تذكير بموعد انتهاء المهمات${reminders.length > 25 ? ` (${Math.floor(i / 25) + 1}/${Math.ceil(reminders.length / 25)})` : ''}`, description: 'في مهمات موعد تسليمها خلال الـ24 ساعة القادمة. سلّم الدليل قبل انتهاء المهلة.', color: 0xf59e0b, fields: reminderFields, timestamp: new Date().toISOString(), footer: { text: 'إدارة البرج • تذكير مواعيد التسليم' } });
      }
      const { dmUser } = require('./_lib/notify.js');
      let cursor = 0;
      const workers = Array.from({ length: Math.min(8, recipients.length) }, async () => { while (cursor < recipients.length) { const person = recipients[cursor++]; let allSent = true; for (const embed of reminderPages) { const sent = await dmUser({ token: BOT_TOKEN, userId: person.user_id, embed }); if (!sent.ok) allSent = false; } if (allSent) dmSent += 1; else dmFailed += 1; } });
      await Promise.all(workers);
    }
    return sendJson(res, 200, { ok: true, closed: closed.length, reminderTasks: reminders.length, recipients: recipients.length, dmSent, dmFailed, backfilledImages });
  }
  if (route === 'cron' && parts[1] === 'missing-tasks-report' && req.method === 'GET') {
    const secret = process.env.CRON_SECRET || '';
    const bearer = String(req.headers?.authorization || '');
    const authorizedCron = Boolean(secret) && bearer === `Bearer ${secret}`;
    if (!authorizedCron && !canManage(user)) return sendError(res, 401, 'غير مصرح. اضبط CRON_SECRET على Vercel.');
    const cairoParts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const cairoHour = Number(cairoParts.find((part) => part.type === 'hour')?.value || -1);
    // Two daily UTC schedules account for Egypt's summer/winter time. Send only in Cairo's 23:00 hour.
    if (cairoHour !== 23) return sendJson(res, 200, { ok: true, skipped: true, reason: 'outside-cairo-23-hour', cairoHour });
    await ensureSchema();
    const reportDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const reportSql = await getSql();
    const report = await require('../lib/missing-tasks-report.js').sendMissingTasksReport({
      sql: reportSql,
      token: BOT_TOKEN,
      staffGuildId: STAFF_GUILD_ID,
      channelId: process.env.TASK_INCOMPLETE_REPORT_CHANNEL_ID || '1556945732957765722',
      dailyDate: reportDate,
    });
    return sendJson(res, 200, { ok: true, ...report });
  }
  if (route === 'evidence') return sendPrivateEvidence(req, res);
  if (route === 'uploads' && parts[1] === 'token') return handleUploadToken(req, res);
  if (!user) return sendError(res, 401, 'سجل دخولك بديسكورد أولًا.');

  if (route === 'register-commands' && req.method === 'GET') {
    if (!canManage(user)) return sendError(res, 403, 'متاح لمسؤولي الإدارة فقط.');
    return sendJson(res, 200, { ok: true, commands: await registerSlashCommands() });
  }
  if (route === 'site-managers' && parts.length === 1) {
    if (!isSiteOwner(user)) return sendError(res, 403, 'إدارة صلاحيات الموقع متاحة لمالكي الموقع فقط.');
    await ensureSchema();
    const sql = await getSql();
    if (req.method === 'GET') {
      if (rateLimited(req, res, user, 'site-managers', 15)) return;
      const [members, roles, guild, overrides] = await Promise.all([
        fetchGuildMembers(MAIN_GUILD_ID),
        discordApi(`/guilds/${MAIN_GUILD_ID}/roles`),
        discordApi(`/guilds/${MAIN_GUILD_ID}`),
        sql`SELECT user_id, username, action, updated_by, updated_at FROM site_manager_access ORDER BY updated_at DESC`,
      ]);
      const roleById = new Map((roles || []).map((role) => [String(role.id), role]));
      const overrideById = new Map(overrides.map((row) => [String(row.user_id), row]));
      const memberById = new Map((members || []).filter((m) => m?.user && !m.user.bot).map((m) => [String(m.user.id), m]));
      const allIds = new Set([...memberById.keys(), ...overrideById.keys(), ...SITE_OWNER_IDS]);
      const entries = [...allIds].map((id) => {
        const member = memberById.get(id);
        const override = overrideById.get(id);
        const assigned = new Set((member?.roles || []).map(String));
        const hasAdministrator = String(guild?.owner_id || '') === id || [...assigned].some((roleId) => {
          try { return (BigInt(roleById.get(roleId)?.permissions || '0') & 8n) === 8n; } catch { return false; }
        });
        const isOwner = SITE_OWNER_IDS.has(id);
        const action = isOwner ? 'owner' : (override?.action || null);
        const isSiteManager = isOwner || action === 'grant' || (action !== 'deny' && hasAdministrator);
        if (!isSiteManager && action !== 'deny') return null;
        const user = member?.user || null;
        let avatar = null;
        if (user?.avatar) avatar = `https://cdn.discordapp.com/avatars/${id}/${user.avatar}.png?size=64`;
        else { let index = 0; try { index = Number((BigInt(id) >> 22n) % 6n); } catch { index = 0; } avatar = `https://cdn.discordapp.com/embed/avatars/${index}.png`; }
        return {
          id,
          username: member ? (member.nick || user?.global_name || user?.username || id) : (override?.username || (isOwner ? 'مالك الموقع' : id)),
          avatarUrl: avatar,
          isOwner,
          hasAdministrator,
          isSiteManager,
          action,
          updatedBy: override?.updated_by || null,
          updatedAt: override?.updated_at || null,
        };
      }).filter(Boolean).sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || Number(b.isSiteManager) - Number(a.isSiteManager) || a.username.localeCompare(b.username, 'ar'));
      const blockedRows = await sql`SELECT user_id AS "userId", username, reason, blocked_by AS "blockedBy", blocked_at AS "blockedAt" FROM site_user_blocks ORDER BY blocked_at DESC`;
      const blockedUsers = blockedRows.map((row) => {
        const id = String(row.userId);
        const member = memberById.get(id);
        const userRecord = member?.user || null;
        let avatarUrl = null;
        if (userRecord?.avatar) avatarUrl = `https://cdn.discordapp.com/avatars/${id}/${userRecord.avatar}.png?size=64`;
        else { let index = 0; try { index = Number((BigInt(id) >> 22n) % 6n); } catch { index = 0; } avatarUrl = `https://cdn.discordapp.com/embed/avatars/${index}.png`; }
        return { id, username: member ? (member.nick || userRecord?.global_name || userRecord?.username || id) : (row.username || id), avatarUrl, reason: row.reason || '', blockedBy: row.blockedBy, blockedAt: row.blockedAt };
      });
      return sendJson(res, 200, { owners: [...SITE_OWNER_IDS], managers: entries, blockedUsers });
    }
    if (req.method === 'POST') {
      if (rateLimited(req, res, user, 'site-managers-write', 20)) return;
      const body = await readJsonBody(req);
      const targetId = cleanText(body.userId, 24);
      const action = cleanText(body.action, 12);
      if (!/^\d{15,22}$/.test(targetId)) return sendError(res, 400, 'Discord ID غير صالح.');
      if (SITE_OWNER_IDS.has(targetId)) return sendError(res, 400, 'لا يمكن إزالة أو تعديل مالكي الموقع الأساسيين.');
      if (!['grant', 'deny', 'auto', 'block', 'unblock'].includes(action)) return sendError(res, 400, 'الإجراء غير صالح.');
      if (action === 'block') {
        if (SITE_OWNER_IDS.has(targetId)) return sendError(res, 400, 'لا يمكن منع مالك أساسي من الموقع.');
        let username = targetId;
        try {
          const targetMember = await discordApi(`/guilds/${MAIN_GUILD_ID}/members/${targetId}`);
          username = cleanText(targetMember?.nick || targetMember?.user?.global_name || targetMember?.user?.username || targetId, 100);
        } catch {
          try {
            const prior = await sql`SELECT username FROM site_presence WHERE user_id = ${targetId} UNION ALL SELECT username FROM chat_messages WHERE user_id = ${targetId} ORDER BY username LIMIT 1`;
            username = cleanText(prior[0]?.username || targetId, 100);
          } catch { username = targetId; }
        }
        const reason = cleanText(body.reason || '', 300);
        await sql`INSERT INTO site_user_blocks(user_id, username, reason, blocked_by, blocked_at) VALUES (${targetId}, ${username}, ${reason}, ${String(user.id)}, NOW())
          ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, reason = EXCLUDED.reason, blocked_by = EXCLUDED.blocked_by, blocked_at = NOW()`;
        memCache.delete(`site-user-block:${targetId}`);
        memCache.delete('site-manager-list');
        return sendJson(res, 200, { ok: true, userId: targetId, action });
      }
      if (action === 'unblock') {
        await sql`DELETE FROM site_user_blocks WHERE user_id = ${targetId}`;
        memCache.delete(`site-user-block:${targetId}`);
        memCache.delete('site-manager-list');
        return sendJson(res, 200, { ok: true, userId: targetId, action });
      }
      let username = targetId;
      if (action === 'grant') {
        try {
          const targetMember = await discordApi(`/guilds/${MAIN_GUILD_ID}/members/${targetId}`);
          username = cleanText(targetMember?.nick || targetMember?.user?.global_name || targetMember?.user?.username || targetId, 100);
        } catch { return sendError(res, 400, 'لازم الشخص يكون عضوًا في السيرفر الأساسي قبل إضافته كمسؤول.'); }
        await sql`INSERT INTO site_manager_access(user_id, username, action, updated_by, updated_at) VALUES (${targetId}, ${username}, 'grant', ${String(user.id)}, NOW()) ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, action = 'grant', updated_by = EXCLUDED.updated_by, updated_at = NOW()`;
      } else if (action === 'deny') {
        try {
          const targetMember = await discordApi(`/guilds/${MAIN_GUILD_ID}/members/${targetId}`);
          username = cleanText(targetMember?.nick || targetMember?.user?.global_name || targetMember?.user?.username || targetId, 100);
        } catch {
          const prior = await sql`SELECT username FROM site_manager_access WHERE user_id = ${targetId}`;
          username = cleanText(prior[0]?.username || targetId, 100);
        }
        await sql`INSERT INTO site_manager_access(user_id, username, action, updated_by, updated_at) VALUES (${targetId}, ${username}, 'deny', ${String(user.id)}, NOW()) ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, action = 'deny', updated_by = EXCLUDED.updated_by, updated_at = NOW()`;
      } else {
        await sql`DELETE FROM site_manager_access WHERE user_id = ${targetId}`;
      }
      memCache.delete(`site-manager-override:${targetId}`);
      memCache.delete(`main-guild-member-authz:${targetId}`);
      memCache.delete(`site-user-block:${targetId}`);
      memCache.delete('site-manager-list');
      memCache.delete('roster');
      return sendJson(res, 200, { ok: true, userId: targetId, action });
    }
    return sendError(res, 405, 'الطريقة غير مدعومة.');
  }

  if (route === 'roster' && req.method === 'GET') {
    if (rateLimited(req, res, user, 'roster', 20)) return;
    try { return sendJson(res, 200, rosterForViewer(await cached('roster', 120_000, getRoster), user)); }
    catch (error) { console.error('[roster]', cleanText(error.message, 200)); return sendError(res, 503, `تعذر تحميل قائمة الاستاف: ${cleanText(error.message, 200)}`); }
  }

  if (route === 'audit-log' && parts.length === 1 && req.method === 'GET') {
    if (!canManage(user)) return sendError(res, 403, 'سجل السيرفر متاح لمسؤولي الإدارة فقط.');
    const auditQuery = { ...(req.query || {}) };
    try { for (const [key, value] of new URL(req.url, 'http://localhost').searchParams) if (auditQuery[key] === undefined) auditQuery[key] = value; } catch { /* ignore */ }
    try { return sendJson(res, 200, await getMainAuditLog(auditQuery)); }
    catch (error) {
      console.error('[audit-log]', cleanText(error.message, 200));
      const hint = /permission|access/i.test(String(error.message)) ? ' تأكد إن البوت عنده صلاحية View Audit Log في السيرفر الأساسي.' : '';
      return sendError(res, 503, `تعذر تحميل سجل السيرفر: ${cleanText(error.message, 160)}.${hint}`);
    }
  }

  await ensureSchema();
  const sql = await getSql();

  if (route === 'submission-audit' && parts.length === 1 && req.method === 'GET') {
    if (!canManage(user)) return sendError(res, 403, 'سجل قرارات التسليم متاح لمسؤولي الإدارة فقط.');
    const rows = await sql`SELECT id, submission_id, member_id, member_name, decision, reviewer_id, reviewer_name, reason, created_at FROM submission_review_audit ORDER BY id DESC LIMIT 200`;
    return sendJson(res, 200, { entries: rows.map((row) => ({ id: Number(row.id), submissionId: Number(row.submission_id), memberId: row.member_id, memberName: row.member_name, decision: row.decision, reviewerId: row.reviewer_id, reviewerName: row.reviewer_name, reason: row.reason, createdAt: row.created_at })) });
  }
  if (route === 'submission-audit.csv' && parts.length === 1 && req.method === 'GET') {
    if (!canManage(user)) return sendError(res, 403, 'تصدير سجل القرارات متاح لمسؤولي الإدارة فقط.');
    const out = await require('./_lib/csv-export.js').buildCsv(sql, 'review-audit', { messageChannelId: MESSAGE_COUNT_CHANNEL_ID });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.end(out.csv);
  }
  if (route === 'task-stats' && parts.length === 1 && req.method === 'GET') {
    if (!canManage(user)) return sendError(res, 403, 'إحصائيات المهمات متاحة لمسؤولي الإدارة فقط.');
    const totals = await sql`SELECT COUNT(*) FILTER (WHERE status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected, COUNT(*) FILTER (WHERE status IN ('pending','submitted'))::int AS pending, COUNT(*)::int AS total FROM submissions`;
    const active = await sql`WITH people AS (SELECT user_id, MAX(username) AS username FROM (SELECT user_id, username FROM site_presence UNION ALL SELECT user_id, username FROM staff_points UNION ALL SELECT user_id, username FROM submissions UNION ALL SELECT user_id, username FROM discord_message_log WHERE channel_id = ${MESSAGE_COUNT_CHANNEL_ID} AND created_at > NOW() - INTERVAL '90 days') p GROUP BY user_id), stats AS (SELECT p.user_id, p.username, COUNT(s.id)::int AS submissions, COUNT(s.id) FILTER (WHERE s.status = 'approved')::int AS approved, COUNT(s.id) FILTER (WHERE s.status = 'rejected')::int AS rejected, MAX(s.submitted_at) AS last_submission FROM people p LEFT JOIN submissions s ON s.user_id = p.user_id GROUP BY p.user_id, p.username) SELECT * FROM stats`;
    // أضف كل أعضاء سيرفر الاستاف من الروستر حتى تظهر الحسابات التي لم تسلّم أي مهمة أصلًا.
    const peopleById = new Map(active.map((item) => [String(item.user_id), item]));
    try {
      const roster = await cached('roster', 120_000, getRoster);
      for (const group of (roster.groups || [])) for (const member of (group.members || [])) {
        const id = String(member.id || '');
        if (id && !peopleById.has(id)) peopleById.set(id, { user_id: id, username: member.username || id, submissions: 0, approved: 0, rejected: 0, last_submission: null });
      }
    } catch (error) { console.error('[task stats roster]', cleanText(error?.message || error, 160)); }
    const fullMemberStats = [...peopleById.values()];
    const mostActive = fullMemberStats.filter((item) => Number(item.submissions) > 0).sort((a, b) => Number(b.submissions) - Number(a.submissions)).slice(0, 10).map((x) => ({ userId: x.user_id, username: x.username, submissions: Number(x.submissions), approved: Number(x.approved), rejected: Number(x.rejected), lastSubmission: x.last_submission }));
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const inactive = fullMemberStats.filter((item) => !item.last_submission || new Date(item.last_submission).getTime() < cutoff).sort((a, b) => (a.last_submission ? new Date(a.last_submission).getTime() : 0) - (b.last_submission ? new Date(b.last_submission).getTime() : 0)).slice(0, 50).map((x) => ({ userId: x.user_id, username: x.username, submissions: Number(x.submissions), lastSubmission: x.last_submission }));
    return sendJson(res, 200, { totals: totals[0] || { total: 0, approved: 0, rejected: 0, pending: 0 }, mostActive, inactive, inactiveDays: 14 });
  }

  if (route === 'notifications' && parts.length === 1 && req.method === 'GET') {
    if (!canManage(user)) return sendError(res, 403, 'الإشعارات متاحة لمسؤولي الإدارة فقط.');
    if (rateLimited(req, res, user, 'notifications', 30)) return;
    const readRows = await sql`SELECT last_read_id::text AS last_read FROM admin_notification_reads WHERE user_id = ${user.id}`;
    let lastRead;
    if (readRows.length) lastRead = Number(readRows[0].last_read) || 0;
    else {
      // أول مرة يفتح فيها المسؤول الإشعارات: نبدأ من آخر إشعار موجود بدل ما نغرقه بتاريخ قديم.
      const top = await sql`INSERT INTO admin_notification_reads(user_id, last_read_id) VALUES (${user.id}, (SELECT COALESCE(MAX(id), 0) FROM admin_notifications)) ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING last_read_id::text AS last_read`;
      lastRead = Number(top[0]?.last_read) || 0;
    }
    const [items, unread] = await Promise.all([
      sql`SELECT id, type, title, body, ref_id AS "refId", created_at AS "createdAt" FROM admin_notifications WHERE actor_id IS DISTINCT FROM ${user.id} ORDER BY id DESC LIMIT 30`,
      sql`SELECT COUNT(*)::int AS count FROM admin_notifications WHERE id > ${lastRead} AND actor_id IS DISTINCT FROM ${user.id}`,
    ]);
    return sendJson(res, 200, { unread: unread[0]?.count || 0, lastRead, items: items.map((row) => ({ id: Number(row.id), type: row.type, title: row.title, body: row.body, refId: row.refId === null ? null : Number(row.refId), createdAt: row.createdAt, unread: Number(row.id) > lastRead })) });
  }
  if (route === 'notifications' && parts[1] === 'read' && parts.length === 2 && req.method === 'POST') {
    if (!canManage(user)) return sendError(res, 403, 'الإشعارات متاحة لمسؤولي الإدارة فقط.');
    if (rateLimited(req, res, user, 'notifications', 30)) return;
    await sql`INSERT INTO admin_notification_reads(user_id, last_read_id, updated_at) VALUES (${user.id}, (SELECT COALESCE(MAX(id), 0) FROM admin_notifications), NOW())
      ON CONFLICT (user_id) DO UPDATE SET last_read_id = GREATEST(admin_notification_reads.last_read_id, EXCLUDED.last_read_id), updated_at = NOW()`;
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'admin-monitoring' && parts.length === 1 && req.method === 'GET') {
    if (!canManage(user)) return sendError(res, 403, 'لوحة مراقبة الإدارة متاحة لمسؤولي السيرفر الأساسي فقط.');
    if (rateLimited(req, res, user, 'admin-monitoring', 20)) return;
    const [siteActivity, taskRows, submissionRows, staffRequestRows, leaveRequestRows, reviewRows] = await Promise.all([
      sql`SELECT user_id AS "userId", username, avatar_url AS "avatarUrl", last_seen AS "lastSeen" FROM site_presence ORDER BY last_seen DESC LIMIT 1000`,
      sql`SELECT COUNT(*) FILTER (WHERE active = TRUE AND (deadline_at IS NULL OR deadline_at > NOW()))::int AS "activeTasks", COUNT(*) FILTER (WHERE active = TRUE AND required = TRUE AND (deadline_at IS NULL OR deadline_at > NOW()))::int AS "requiredActiveTasks", COUNT(*) FILTER (WHERE active = TRUE AND deadline_at IS NOT NULL AND deadline_at > NOW() AND deadline_at <= NOW() + INTERVAL '24 hours')::int AS "dueWithin24Hours" FROM tasks`,
      sql`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status IN ('submitted','pending'))::int AS pending, COUNT(*) FILTER (WHERE status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected FROM submissions`,
      sql`SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending FROM staff_requests`,
      sql`SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending FROM leave_requests`,
      sql`SELECT COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS recent, COUNT(*)::int AS total FROM submission_review_audit`,
    ]);
    return sendJson(res, 200, {
      generatedAt: new Date().toISOString(),
      siteActivity: siteActivity.map((row) => ({ userId: String(row.userId), username: row.username, avatarUrl: row.avatarUrl, lastSeen: row.lastSeen })),
      metrics: {
        activeTasks: Number(taskRows[0]?.activeTasks || 0), requiredActiveTasks: Number(taskRows[0]?.requiredActiveTasks || 0), dueWithin24Hours: Number(taskRows[0]?.dueWithin24Hours || 0),
        totalSubmissions: Number(submissionRows[0]?.total || 0), pendingSubmissions: Number(submissionRows[0]?.pending || 0), approvedSubmissions: Number(submissionRows[0]?.approved || 0), rejectedSubmissions: Number(submissionRows[0]?.rejected || 0),
        pendingStaffRequests: Number(staffRequestRows[0]?.pending || 0), pendingLeaveRequests: Number(leaveRequestRows[0]?.pending || 0), reviewDecisions24h: Number(reviewRows[0]?.recent || 0), totalReviewDecisions: Number(reviewRows[0]?.total || 0),
      },
    });
  }

  if (route === 'staff-stats' && parts.length === 1 && req.method === 'GET') {
    if (rateLimited(req, res, user, 'staff-stats', 40)) return;
    await syncChannelMessageCounts(sql, { budgetMs: 4000 });
    const { stats, dailyDate } = await getAllStaffStats(sql);
    return sendJson(res, 200, { stats: canManage(user) ? stats : stats.map(publicStats), dailyDate, restricted: !canManage(user) });
  }
  if (route === 'staff-stats' && parts.length === 2 && req.method === 'GET') {
    const targetId = cleanText(parts[1], 24);
    if (!/^\d{15,22}$/.test(targetId)) return sendError(res, 400, 'Discord ID غير صالح.');
    if (rateLimited(req, res, user, 'staff-profile', 40)) return;
    // الملف الكامل (إجازات، طلبات إدارية، سجل نقاط، تسليمات) لصاحب الحساب والمسؤولين فقط.
    const fullAccess = canManage(user) || targetId === String(user.id);
    await syncChannelMessageCounts(sql, { budgetMs: 4000 });
    const { stats: allStats } = await getAllStaffStats(sql);
    const stats = allStats.find((row) => row.userId === targetId) || { userId: targetId, dailyMessages: 0, totalMessages: 0, totalSubmissions: 0, approvedSubmissions: 0, pendingSubmissions: 0, rejectedSubmissions: 0, totalPoints: 0, leaveRequests: 0, adminRequests: 0, online: false, lastSeen: null };
    const noRows = Promise.resolve([]);
    const [submissionRows, leaveRows, dayRows, hourRows, spanRows, pointRows, requestRows] = await Promise.all([
      fullAccess ? sql`SELECT id, submitted_at AS "submittedAt", status, note FROM submissions WHERE user_id = ${targetId} ORDER BY submitted_at DESC LIMIT 10` : noRows,
      fullAccess ? sql`SELECT id, start_date AS "startDate", end_date AS "endDate", reason, status, created_at AS "createdAt", review_note AS "reviewNote" FROM leave_requests WHERE user_id = ${targetId} ORDER BY created_at DESC LIMIT 10` : noRows,
      sql`SELECT to_char((created_at AT TIME ZONE 'Africa/Cairo')::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS count FROM discord_message_log WHERE channel_id = ${MESSAGE_COUNT_CHANNEL_ID} AND user_id = ${targetId} GROUP BY 1`,
      sql`SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Africa/Cairo')::int AS hour, COUNT(*)::int AS count FROM discord_message_log WHERE channel_id = ${MESSAGE_COUNT_CHANNEL_ID} AND user_id = ${targetId} GROUP BY 1`,
      sql`SELECT MIN(created_at) AS "firstAt", MAX(created_at) AS "lastAt" FROM discord_message_log WHERE channel_id = ${MESSAGE_COUNT_CHANNEL_ID} AND user_id = ${targetId}`,
      fullAccess ? sql`SELECT id, amount, reason, source, created_at AS "createdAt" FROM staff_points WHERE user_id = ${targetId} ORDER BY id DESC LIMIT 10` : noRows,
      fullAccess ? sql`SELECT id, request_type AS "requestType", subject, status, created_at AS "createdAt" FROM staff_requests WHERE user_id = ${targetId} ORDER BY created_at DESC LIMIT 5` : noRows,
    ]);
    const messageProfile = buildMessageProfile({ firstAt: spanRows[0]?.firstAt || null, lastAt: spanRows[0]?.lastAt || null, dayCounts: dayRows, hourCounts: hourRows });
    return sendJson(res, 200, {
      stats: fullAccess ? stats : publicStats(stats),
      restricted: !fullAccess,
      messageProfile,
      ranks: { messages: rankOf(allStats, targetId, 'totalMessages'), points: rankOf(allStats, targetId, 'totalPoints') },
      recentPoints: pointRows.map((row) => ({ ...row, id: Number(row.id), amount: Number(row.amount) || 0 })),
      recentRequests: requestRows.map((row) => ({ ...row, id: Number(row.id) })),
      recentSubmissions: submissionRows.map((row) => ({ ...row, id: Number(row.id) })),
      recentLeaves: leaveRows.map((row) => ({ ...row, id: Number(row.id), startDate: String(row.startDate).slice(0, 10), endDate: String(row.endDate).slice(0, 10) })),
    });
  }

  if (route === 'staff-requests' && parts.length === 1 && req.method === 'POST') {
    const requestType = cleanText(req.body?.requestType, 40);
    const subject = cleanText(req.body?.subject, 140);
    const details = cleanText(req.body?.details, 1200);
    const allowedTypes = new Set(['permission', 'technical', 'data-change', 'complaint', 'other']);
    if (!allowedTypes.has(requestType)) return sendError(res, 400, 'نوع الطلب غير صالح.');
    if (!subject) return sendError(res, 400, 'اكتب عنوان الطلب.');
    if (details.length < 5) return sendError(res, 400, 'اكتب تفاصيل أكثر عن الطلب.');
    const typeLabels = { permission: 'طلب إذن / غياب', technical: 'مشكلة تقنية', 'data-change': 'تعديل بيانات', complaint: 'شكوى أو ملاحظة', other: 'طلب إداري آخر' };
    const inserted = await sql`INSERT INTO staff_requests(user_id, username, avatar_url, request_type, subject, details, status, created_at)
      VALUES (${user.id}, ${user.username}, ${user.avatarUrl || null}, ${requestType}, ${subject}, ${details}, 'pending', NOW()) RETURNING id`;
    const id = Number(inserted[0].id);
    await pushAdminNotification(sql, { type: 'staff-request', title: `📨 طلب إداري جديد #${id}`, body: `${user.username} — ${subject}`, refId: id, actorId: user.id });
    let discordPosted = false;
    try {
      await postDiscordEmbed(STAFF_REQUEST_CHANNEL_ID, {
        title: `📨 طلب إداري جديد #${id}`,
        description: 'طلب جديد من الاستاف بانتظار مراجعة مسؤولي الإدارة من لوحة الموقع.',
        color: 0x8b5cf6,
        fields: [
          { name: '👤 العضو', value: `<@${user.id}>\n\`${user.id}\``, inline: true },
          { name: '📂 نوع الطلب', value: typeLabels[requestType], inline: true },
          { name: '📝 العنوان', value: subject.slice(0, 1024), inline: false },
          { name: '📄 التفاصيل', value: details.slice(0, 1024), inline: false },
          { name: '🔎 المراجعة', value: `رقم الطلب: #${id}\nالموافقة أو الرفض من لوحة إدارة البرج.`, inline: false },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: 'إدارة البرج • الطلبات الإدارية' },
        ...(user.avatarUrl ? { thumbnail: { url: user.avatarUrl } } : {}),
      });
      discordPosted = true;
    } catch (error) { console.error('[staff request post]', cleanText(error.message, 200)); }
    return sendJson(res, 201, { ok: true, id, discordPosted, message: discordPosted ? 'تم إرسال الطلب الإداري لروم المراجعة.' : 'تم حفظ الطلب، لكن تعذر إرساله إلى روم الطلبات الإدارية. تأكد من توكن البوت وصلاحياته.' });
  }
  if (route === 'staff-requests' && parts.length === 1 && req.method === 'GET') {
    const rows = canManage(user)
      ? await sql`SELECT * FROM staff_requests ORDER BY id DESC LIMIT 100`
      : await sql`SELECT * FROM staff_requests WHERE user_id = ${user.id} ORDER BY id DESC LIMIT 40`;
    return sendJson(res, 200, { requests: rows.map((row) => ({ id: Number(row.id), userId: row.user_id, username: row.username, avatarUrl: row.avatar_url, requestType: row.request_type, subject: row.subject, details: row.details, status: row.status, reviewNote: row.review_note, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, createdAt: row.created_at })) });
  }
  if (route === 'staff-requests' && parts.length === 3 && req.method === 'POST' && ['approve', 'reject'].includes(parts[2])) {
    if (!canManage(user)) return sendError(res, 403, 'مراجعة الطلبات الإدارية متاحة لمسؤولي الإدارة فقط.');
    const id = Number(parts[1]);
    if (!Number.isSafeInteger(id) || id < 1) return sendError(res, 400, 'رقم الطلب غير صالح.');
    const found = await sql`SELECT id, user_id, request_type, subject FROM staff_requests WHERE id = ${id} AND status = 'pending' LIMIT 1`;
    if (!found.length) return sendError(res, 404, 'الطلب غير موجود أو تمت مراجعته بالفعل.');
    const item = found[0];
    const status = parts[2] === 'approve' ? 'approved' : 'rejected';
    const note = cleanText(req.body?.note, 400);
    const updated = await sql`UPDATE staff_requests SET status = ${status}, review_note = ${note}, reviewed_by = ${user.id}, reviewed_at = NOW() WHERE id = ${id} AND status = 'pending' RETURNING id`;
    if (!updated.length) return sendError(res, 409, 'تمت مراجعة الطلب من مسؤول آخر بالفعل.');
    const dm = await notifyReview({ token: BOT_TOKEN, userId: item.user_id, kind: 'request', status, id, reviewerId: user.id, note, fields: [{ name: '📝 عنوان الطلب', value: cleanText(item.subject, 200) || '—', inline: false }] });
    try { await postDiscordEmbed(STAFF_REQUEST_CHANNEL_ID, { title: status === 'approved' ? `✅ تمت الموافقة على الطلب الإداري #${id}` : `❌ تم رفض الطلب الإداري #${id}`, description: `نوع الطلب: ${item.request_type}\nالعنوان: ${item.subject}\nمقدم الطلب: <@${item.user_id}>\nالمراجع: <@${user.id}>${note ? `\nملاحظة: ${note}` : ''}`, color: status === 'approved' ? 0x22c55e : 0xef4444, timestamp: new Date().toISOString() }); } catch (error) { console.error('[staff request review log]', cleanText(error.message, 180)); }
    return sendJson(res, 200, { ok: true, status, dmSent: dm.ok, message: `${status === 'approved' ? 'تمت الموافقة على الطلب الإداري.' : 'تم رفض الطلب الإداري.'}${dmNote(dm)}` });
  }

  if (route === 'tasks' && parts.length === 1 && req.method === 'GET') {
    await syncDiscordTasks(sql);
    await sql`UPDATE tasks SET active = FALSE WHERE active = TRUE AND deadline_at IS NOT NULL AND deadline_at <= NOW()`;
    const rows = await sql`SELECT t.id, t.title, t.points, t.required, t.active, t.created_by_name, t.created_at, t.deadline_at FROM tasks t WHERE (t.active = TRUE AND (t.deadline_at IS NULL OR t.deadline_at > NOW())) OR EXISTS (SELECT 1 FROM task_rework_requests tr WHERE tr.user_id = ${user.id} AND tr.task_id = t.id AND tr.status IN ('requested','submitted')) ORDER BY t.required DESC, t.id DESC`;
    const completedRows = await sql`SELECT DISTINCT st.task_id FROM submission_tasks st JOIN submissions s ON s.id = st.submission_id WHERE s.user_id = ${user.id} AND s.status = 'approved' AND NOT EXISTS (SELECT 1 FROM task_rework_requests tr WHERE tr.user_id = s.user_id AND tr.task_id = st.task_id AND tr.status IN ('requested','submitted'))`;
    const completed = new Set(completedRows.map((row) => String(row.task_id)));
    const pendingRows = await sql`SELECT DISTINCT st.task_id FROM submission_tasks st JOIN submissions s ON s.id = st.submission_id WHERE s.user_id = ${user.id} AND s.status = 'pending'`;
    const pending = new Set(pendingRows.map((row) => String(row.task_id)));
    const rejectedRows = await sql`SELECT DISTINCT st.task_id FROM submission_tasks st JOIN submissions s ON s.id = st.submission_id WHERE s.user_id = ${user.id} AND s.status = 'rejected'`;
    const rejected = new Set(rejectedRows.map((row) => String(row.task_id)));
    const reworkRows = await sql`SELECT task_id, status FROM task_rework_requests WHERE user_id = ${user.id} AND status IN ('requested','submitted')`;
    const rework = new Map(reworkRows.map((row) => [String(row.task_id), String(row.status)]));
    const tasks = rows.map((row) => {
      const taskId = String(row.id);
      const reworkStatus = rework.get(taskId) || '';
      const completedByMe = completed.has(taskId);
      const pendingByMe = !completedByMe && pending.has(taskId);
      return { id: Number(row.id), title: row.title, points: Number(row.points || 0), required: Boolean(row.required), active: Boolean(row.active), created_by_name: row.created_by_name, created_at: row.created_at, deadline_at: row.deadline_at, completedByMe, pendingByMe, rejectedByMe: !completedByMe && !pendingByMe && !reworkStatus && rejected.has(taskId), redoRequiredByMe: reworkStatus === 'requested', redoPendingByMe: reworkStatus === 'submitted' };
    });
    const required = tasks.filter((task) => task.required);
    return sendJson(res, 200, { tasks, stats: { active: tasks.length, required: required.length, completedRequired: required.filter((task) => task.completedByMe).length, completedByMe: tasks.filter((task) => task.completedByMe).length } });
  }
  if (route === 'tasks' && parts.length === 1 && req.method === 'POST') {
    if (!canManage(user)) return sendError(res, 403, 'الصلاحية دي للمسؤولين فقط.');
    const raw = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
    if (!raw.length || raw.length > 40) return sendError(res, 400, 'أضف من مهمة واحدة إلى 40 مهمة في المرة الواحدة.');
    const tasks = raw.map((item) => {
      const points = Number(typeof item === 'string' ? 1 : (item?.points ?? 1));
      const deadlineRaw = typeof item === 'string' ? '' : cleanText(item?.deadlineAt, 80);
      const deadlineMs = deadlineRaw ? Date.parse(deadlineRaw) : NaN;
      return { title: cleanText(typeof item === 'string' ? item : item?.title, 240), required: typeof item === 'string' ? false : Boolean(item?.required), points: Number.isFinite(points) && points >= 0 && points <= 100000 && Math.round(points * 100) / 100 === points ? Math.round(points * 100) / 100 : NaN, deadlineAt: deadlineRaw && Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null, deadlineInvalid: Boolean(deadlineRaw && !Number.isFinite(deadlineMs)) };
    }).filter((task) => task.title);
    if (tasks.some((task) => !Number.isFinite(task.points))) return sendError(res, 400, 'عدد النقاط لازم يكون رقمًا من 0 إلى 100000، ويسمح بالكسور مثل 0.1.');
    if (tasks.some((task) => task.deadlineInvalid || (task.deadlineAt && Date.parse(task.deadlineAt) <= Date.now()))) return sendError(res, 400, 'موعد انتهاء المهمة غير صالح أو في الماضي. اختار موعدًا مستقبليًا.');
    if (!tasks.length) return sendError(res, 400, 'اكتب اسم مهمة صحيح.');
    const created = [];
    for (const task of tasks) {
      const rows = await sql`INSERT INTO tasks(title, points, required, active, created_by, created_by_name, created_at, deadline_at) VALUES (${task.title}, ${task.points}, ${task.required}, TRUE, ${user.id}, ${user.username}, NOW(), ${task.deadlineAt}) RETURNING id`;
      created.push({ id: Number(rows[0].id), ...task });
    }
    let discordPosted = false;
    let warning = '';
    try {
      const lines = created.map((task) => `• [${task.required ? 'إجباري' : 'اختياري'}] #${task.id} — ${task.title} [${formatPoints(task.points)} نقطة]${task.deadlineAt ? ` · ⏰ حتى ${new Intl.DateTimeFormat('ar-EG', { timeZone: 'Africa/Cairo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(task.deadlineAt))}` : ''}`);
      let batch = [];
      let charCount = '📋 مهمات جديدة | إدارة البرج\n'.length;
      const batches = [];
      for (const line of lines) {
        if (batch.length && charCount + line.length + 1 > 1750) { batches.push(batch); batch = []; charCount = '📋 مهمات جديدة | إدارة البرج\n'.length; }
        batch.push(line); charCount += line.length + 1;
      }
      if (batch.length) batches.push(batch);
      for (const [batchIndex, items] of batches.entries()) {
        const pingRole = batchIndex === 0 && /^\d{15,22}$/.test(TASK_PING_ROLE_ID); // المنشن في أول رسالة بس عشان ما يتكررش
        const message = await postDiscordMessage(
          TASKS_CHANNEL_ID,
          `${pingRole ? `<@&${TASK_PING_ROLE_ID}> ` : ''}📋 **مهمات جديدة | إدارة البرج**\n${items.join('\n')}`,
          pingRole ? { parse: [], roles: [TASK_PING_ROLE_ID] } : { parse: [] },
        );
        const matchIds = items.map((line) => Number(line.match(/#(\d+)/)?.[1])).filter(Number.isInteger);
        for (let i = 0; i < matchIds.length; i += 1) await sql`UPDATE tasks SET source_message_id = ${message.id}, source_line_index = ${i} WHERE id = ${matchIds[i]}`;
      }
      discordPosted = true;
    } catch (error) { warning = cleanText(error.message, 220); console.error('[task post]', warning); }
    return sendJson(res, 201, { created, discordPosted, warning, message: discordPosted ? 'تم إنشاء المهمات ونشرها في روم المهمات.' : 'تم حفظ المهمات في الموقع، لكن البوت لم يستطع نشرها في ديسكورد.' });
  }
  
  if (route === 'tasks' && parts.length === 2 && req.method === 'DELETE') {
    if (!canManage(user)) {
      return sendError(res, 403, 'حذف المهمات متاح لمسؤولي الإدارة فقط.');
    }

    if (!ensureSameOrigin(req, res)) return;

    const id = Number(parts[1]);

    if (!Number.isSafeInteger(id) || id < 1) {
      return sendError(res, 400, 'رقم المهمة غير صالح.');
    }

    const deleted = await sql`
      UPDATE tasks
      SET active = FALSE
      WHERE id = ${id} AND active = TRUE
      RETURNING id
    `;

    if (!deleted.length) {
      return sendError(res, 404, 'المهمة مش موجودة أو تم حذفها بالفعل.');
    }

    return sendJson(res, 200, {
      ok: true,
      message: 'تم حذف المهمة من القائمة الحالية، وسجل التسليمات القديم محفوظ.'
    });
  }

  if (route === 'tasks' && parts.length === 2 && req.method === 'PATCH') {
    if (!canManage(user)) return sendError(res, 403, 'الصلاحية دي للمسؤولين فقط.');
    const id = Number(parts[1]);
    if (!Number.isSafeInteger(id) || id < 1) return sendError(res, 400, 'رقم المهمة غير صالح.');
    const found = await sql`SELECT id FROM tasks WHERE id = ${id} AND active = TRUE`;
    if (!found.length) return sendError(res, 404, 'المهمة مش موجودة أو اتقفلت.');
    const updates = [];
    if (typeof req.body?.required === 'boolean') updates.push({ field: 'required', value: req.body.required });
    if (req.body?.points !== undefined) { const points = Number(req.body.points); if (!Number.isFinite(points) || points < 0 || points > 100000 || Math.round(points * 100) / 100 !== points) return sendError(res, 400, 'عدد النقاط غير صالح؛ استخدم رقمًا من منزلتين عشريتين كحد أقصى مثل 0.1 أو 0.25.'); updates.push({ field: 'points', value: Math.round(points * 100) / 100 }); }
    if (typeof req.body?.active === 'boolean') updates.push({ field: 'active', value: req.body.active });
    if (!updates.length) return sendError(res, 400, 'مفيش تعديل صالح.');
    for (const item of updates) {
      if (item.field === 'required') await sql`UPDATE tasks SET required = ${item.value} WHERE id = ${id}`;
      if (item.field === 'points') await sql`UPDATE tasks SET points = ${item.value} WHERE id = ${id}`;
      if (item.field === 'active') await sql`UPDATE tasks SET active = ${item.value} WHERE id = ${id}`;
    }
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'leave-requests' && parts.length === 1 && req.method === 'POST') {
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
    if (!validDate(startDate) || !validDate(endDate) || endDate < startDate) return sendError(res, 400, 'اختار تاريخًا صحيحًا من اليوم وحتى 5 سنوات قادمة، وتأكد إن تاريخ النهاية ليس قبل البداية.');
    if (!reason) return sendError(res, 400, 'اكتب سبب طلب الإجازة.');
    const inserted = await sql`INSERT INTO leave_requests(user_id, username, avatar_url, start_date, end_date, reason, status, created_at)
      VALUES (${user.id}, ${user.username}, ${user.avatarUrl || null}, ${startDate}, ${endDate}, ${reason}, 'pending', NOW()) RETURNING id, created_at`;
    const id = Number(inserted[0].id);
    await pushAdminNotification(sql, { type: 'leave', title: `🗓️ طلب إجازة جديد #${id}`, body: `${user.username} — من ${startDate} إلى ${endDate}`, refId: id, actorId: user.id });
    let discordPosted = false;
    try {
      const posted = await discordApi(`/channels/${LEAVE_REQUEST_CHANNEL_ID}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          embeds: [buildLeaveEmbed({ id, user_id: user.id, username: user.username, avatar_url: user.avatarUrl, start_date: startDate, end_date: endDate, reason }, 'pending')],
          components: leaveReviewComponents(id),
          allowed_mentions: { parse: [] },
        }),
      });
      if (posted?.id) {
        await sql`UPDATE leave_requests SET discord_message_id = ${String(posted.id)}, discord_channel_id = ${LEAVE_REQUEST_CHANNEL_ID} WHERE id = ${id}`;
      }
      discordPosted = Boolean(posted?.id);
    } catch (error) { console.error('[leave request post]', cleanText(error.message, 200)); }
    return sendJson(res, 201, { ok: true, id, discordPosted, message: discordPosted ? 'تم إرسال طلب الإجازة لروم الإدارة.' : 'تم حفظ الطلب، لكن تعذر إرساله إلى روم الإجازات 1556945732957765722. تأكد من توكن البوت وصلاحياته.' });
  }
  if (route === 'leave-requests' && parts.length === 1 && req.method === 'GET') {
    if (Date.now() - (globalThis.__leaveSyncAt || 0) > 5 * 60 * 1000) { globalThis.__leaveSyncAt = Date.now(); try { await require('./_lib/leave-roles.js').syncLeaveRoles({ sql, token: BOT_TOKEN }); } catch (error) { console.error('[leave roles lazy sync]', cleanText(error.message, 200)); } }
    const rows = canManage(user)
      ? await sql`SELECT * FROM leave_requests ORDER BY id DESC LIMIT 100`
      : await sql`SELECT * FROM leave_requests WHERE user_id = ${user.id} ORDER BY id DESC LIMIT 40`;
    return sendJson(res, 200, { requests: rows.map(row => ({ id: Number(row.id), userId: row.user_id, username: row.username, avatarUrl: row.avatar_url, startDate: String(row.start_date).slice(0, 10), endDate: String(row.end_date).slice(0, 10), reason: row.reason, status: row.status, reviewNote: row.review_note, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, createdAt: row.created_at })) });
  }
  if (route === 'leave-requests' && parts.length === 3 && req.method === 'POST' && ['approve', 'reject'].includes(parts[2])) {
    if (!canManage(user)) return sendError(res, 403, 'مراجعة طلبات الإجازة متاحة لمسؤولي الإدارة فقط.');
    const id = Number(parts[1]);
    if (!Number.isSafeInteger(id) || id < 1) return sendError(res, 400, 'رقم طلب الإجازة غير صالح.');
    const note = cleanText(req.body?.note, 400);
    const status = parts[2] === 'approve' ? 'approved' : 'rejected';
    const rows = await sql`UPDATE leave_requests SET status = ${status}, review_note = ${note}, reviewed_by = ${user.id}, reviewed_at = NOW() WHERE id = ${id} AND status = 'pending' RETURNING id, user_id, username, avatar_url, start_date, end_date, reason, discord_message_id, discord_channel_id`;
    if (!rows.length) return sendError(res, 409, 'الطلب غير موجود أو تمت مراجعته بالفعل. حدّث القائمة للتأكد من حالته.');
    const item = rows[0];
    const dmPromise = notifyReview({ token: BOT_TOKEN, userId: item.user_id, kind: 'leave', status, id, reviewerId: user.id, note, fields: [{ name: '📅 الفترة', value: `${String(item.start_date).slice(0, 10)} ← ${String(item.end_date).slice(0, 10)}`, inline: false }] });
    if (status === 'approved') { try { await require('./_lib/leave-roles.js').syncLeaveRoles({ sql, token: BOT_TOKEN }); } catch (error) { console.error('[leave roles sync]', cleanText(error.message, 200)); } }
    const hasOriginalMessage = Boolean(item.discord_message_id);
    let originalMessageUpdated = !hasOriginalMessage;
    let reviewLogPosted = false;
    if (item.discord_message_id) {
      try {
        await discordApi(`/channels/${item.discord_channel_id || LEAVE_REQUEST_CHANNEL_ID}/messages/${item.discord_message_id}`, {
          method: 'PATCH',
          body: JSON.stringify({ embeds: [buildLeaveEmbed(item, status, user.id, note)], components: [], allowed_mentions: { parse: [] } }),
        });
        originalMessageUpdated = true;
      } catch (error) { console.error('[leave original message update]', cleanText(error.message, 180)); }
    }
    try {
      const approvedNow = status === 'approved';
      await postDiscordEmbed(process.env.LEAVE_NOTICE_CHANNEL_ID || '1558102515885678734', {
        title: approvedNow ? `✅ تم قبول طلب الإجازة #${id}` : `❌ تم رفض طلب الإجازة #${id}`,
        color: approvedNow ? 0x22c55e : 0xef4444,
        fields: [
          { name: '👤 العضو', value: `<@${item.user_id}>`, inline: true },
          { name: '🛡️ المراجع', value: `<@${user.id}>`, inline: true },
          { name: '📅 الفترة', value: `${String(item.start_date).slice(0, 10)} ← ${String(item.end_date).slice(0, 10)}`, inline: false },
          ...(note ? [{ name: '📝 السبب', value: String(note).slice(0, 1024), inline: false }] : []),
        ],
        timestamp: new Date().toISOString(),
        footer: { text: 'إدارة البرج • طلبات الإجازة' },
      });
      reviewLogPosted = true;
    } catch (error) { console.error('[leave review log]', cleanText(error.message, 180)); }
    const discordPosted = hasOriginalMessage ? originalMessageUpdated : reviewLogPosted;
    const dm = await dmPromise;
    const baseMessage = status === 'approved' ? 'تمت الموافقة على طلب الإجازة.' : 'تم رفض طلب الإجازة.';
    return sendJson(res, 200, { ok: true, discordPosted, dmSent: dm.ok, message: `${discordPosted ? baseMessage : `${baseMessage} لكن تعذر تحديث رسالة الطلب في ديسكورد. راجع صلاحيات البوت.`}${dmNote(dm)}` });
  }

  if (route === 'submissions' && parts.length === 1 && req.method === 'POST') {
    await sql`UPDATE tasks SET active = FALSE WHERE active = TRUE AND deadline_at IS NOT NULL AND deadline_at <= NOW()`;
    const taskIdsInput = Array.isArray(req.body?.taskIds) ? req.body.taskIds : [];
    const taskIds = [...new Set(taskIdsInput.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 40);
    if (!taskIds.length) return sendError(res, 400, 'اختار مهمة واحدة على الأقل.');
    const activeTasks = await sql`SELECT t.id, t.title, t.points, t.required FROM tasks t WHERE t.active = TRUE OR EXISTS (SELECT 1 FROM task_rework_requests tr WHERE tr.user_id = ${user.id} AND tr.task_id = t.id AND tr.status = 'requested')`;
    const byId = new Map(activeTasks.map((row) => [Number(row.id), row]));
    const foundTasks = taskIds.map((id) => byId.get(id)).filter(Boolean);
    if (foundTasks.length !== taskIds.length) return sendError(res, 400, 'في مهمة من اللي اخترتها مش موجودة أو اتقفلت. حدّث الصفحة وجرب تاني.');
    // المهمة اللي اتسلمت قبل كده (اتقبلت أو اترفضت أو لسه بتتراجع) لنفس العضو ميقدرش يسلمها تاني.
    const lockedRows = await sql`SELECT st.task_id, s.status FROM submission_tasks st JOIN submissions s ON s.id = st.submission_id LEFT JOIN task_rework_requests tr ON tr.user_id = s.user_id AND tr.task_id = st.task_id AND tr.status IN ('requested','submitted') WHERE s.user_id = ${user.id} AND s.status IN ('approved','pending','rejected') AND st.task_id = ANY(${taskIds}) AND NOT (s.status IN ('approved','rejected') AND tr.id IS NOT NULL)`;
    const doneTask = lockedRows.find((row) => row.status === 'approved');
    if (doneTask) return sendError(res, 409, `المهمة #${doneTask.task_id} انتهت بالفعل وانت خلصتها قبل كده، مينفعش تسلّمها تاني. شيلها من الاختيار.`);
    const rejectedTask = lockedRows.find((row) => row.status === 'rejected');
    if (rejectedTask) return sendError(res, 409, `المهمة #${rejectedTask.task_id} اتسلمت قبل كده واترفضت، ومينفعش تتسلم تاني. شيلها من الاختيار.`);
    const waitingTask = lockedRows.find((row) => row.status === 'pending');
    if (waitingTask) return sendError(res, 409, `المهمة #${waitingTask.task_id} متسلمة بالفعل وبانتظار مراجعة الإدارة. استنى القرار قبل ما تسلّمها تاني.`);
    const linksInput = cleanText(req.body?.evidenceLinks, 12000);
    const links = linksInput.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
    for (const link of links) {
      let parsed;
      try { parsed = new URL(link); } catch { return sendError(res, 400, `الرابط ده مش صحيح: ${link.slice(0, 90)}`); }
      if (!['http:', 'https:'].includes(parsed.protocol)) return sendError(res, 400, 'روابط الأدلة لازم تبدأ بـ http أو https.');
    }
    const rawFiles = Array.isArray(req.body?.files) ? req.body.files : [];
    if (rawFiles.length > 10) return sendError(res, 400, 'أقصى عدد للملفات في التسليم الواحد 10 ملفات.');
    const files = [];
    for (const raw of rawFiles) {
      const pathname = cleanText(raw?.pathname, 500);
      const originalName = cleanText(raw?.originalName, 180) || 'evidence-file';
      const mimeType = cleanText(raw?.mimeType, 100).toLowerCase();
      const size = Number(raw?.size || 0);
      if (!pathname.startsWith(`evidence/${user.id}/`) || pathname.includes('..')) return sendError(res, 400, 'مسار ملف الدليل غير صالح.');
      if (!(mimeType.startsWith('image/') || mimeType.startsWith('video/'))) return sendError(res, 400, 'ارفع صور أو فيديوهات فقط.');
      if (!Number.isFinite(size) || size < 1 || size > MAX_UPLOAD_MB * 1024 * 1024) return sendError(res, 400, `حجم الملف خارج الحد المسموح (${MAX_UPLOAD_MB}MB).`);
      const realType = await sniffBlobMime(pathname).catch(() => null);
      if (!realType) {
        await deleteBlobQuietly(pathname);
        return sendError(res, 400, `الملف "${originalName.slice(0, 60)}" مش صورة أو فيديو حقيقي (ممكن يكون ملف متنكر). ارفع صورة أو فيديو سليم.`);
      }
      let sha256 = null;
      if (realType.startsWith('image/')) {
        try { sha256 = await sha256Blob(pathname); }
        catch (error) { console.error('[image fingerprint]', cleanText(error.message, 180)); }
      }
      files.push({ pathname, token: crypto.randomBytes(24).toString('base64url'), originalName, mimeType: realType, size, ...(sha256 ? { sha256 } : {}) });
    }
    if (!links.length && !files.length) return sendError(res, 400, 'ضيف رابط دليل أو ارفع صورة/فيديو قبل الإرسال.');
    const note = cleanText(req.body?.note, 600);
    const submittedHashes = files.filter((file) => file.sha256).map((file) => file.sha256);
    let duplicateRows = [];
    if (submittedHashes.length) duplicateRows = await sql`SELECT file_sha256, submission_id, user_id, username, original_name, created_at FROM submission_file_hashes WHERE file_sha256 = ANY(${submittedHashes}) ORDER BY created_at ASC LIMIT 200`;
    const duplicatesByHash = new Map();
    for (const item of duplicateRows) {
      const key = item.file_sha256;
      if (!duplicatesByHash.has(key)) duplicatesByHash.set(key, []);
      duplicatesByHash.get(key).push({ submissionId: Number(item.submission_id), userId: item.user_id, username: item.username, originalName: item.original_name, submittedAt: item.created_at });
    }
    const duplicateImages = files.filter((file) => file.sha256 && duplicatesByHash.has(file.sha256)).map((file) => ({ fileName: file.originalName, matches: duplicatesByHash.get(file.sha256) }));
    const inserted = await sql`INSERT INTO submissions(user_id, username, avatar_url, note, evidence_links, files_json, submitted_at, status)
      VALUES (${user.id}, ${user.username}, ${user.avatarUrl || null}, ${note}, ${JSON.stringify(links)}::jsonb, ${JSON.stringify(files)}::jsonb, NOW(), 'pending') RETURNING id, submitted_at`;
    const submissionId = Number(inserted[0].id);
    for (const taskId of taskIds) await sql`INSERT INTO submission_tasks(submission_id, task_id) VALUES (${submissionId}, ${taskId}) ON CONFLICT DO NOTHING`;
    await sql`UPDATE task_rework_requests SET status = 'submitted', current_submission_id = ${submissionId} WHERE user_id = ${user.id} AND task_id = ANY(${taskIds}) AND status = 'requested'`;
    for (const file of files) if (file.sha256) await sql`INSERT INTO submission_file_hashes(submission_id, file_sha256, user_id, username, original_name, created_at) VALUES (${submissionId}, ${file.sha256}, ${user.id}, ${user.username}, ${file.originalName}, NOW()) ON CONFLICT DO NOTHING`;
    await pushAdminNotification(sql, { type: 'submission', title: `📨 تسليم جديد #${submissionId}`, body: `${user.username} — ${foundTasks.length} مهمة${files.length ? ` · ${files.length} ملف` : ''}`, refId: submissionId, actorId: user.id });
    const base = siteUrl(req);
    const taskText = foundTasks.map((task) => `• ${task.required ? '🔴 إجباري' : '⚪ اختياري'} — **${cleanText(task.title, 140)}** — ${formatPoints(task.points)} نقطة`).join('\n').slice(0, 1024) || 'لم يتم تحديد مهمة.';
    let evidence = { attachments: [], linkOnly: [] };
    try { evidence = await loadEvidenceAttachments(req, files); } catch (error) { console.error('[evidence load]', cleanText(error.message, 160)); }
    const fileLines = [
      ...(evidence.attachments.length ? [`📎 ${evidence.attachments.length} ملف مرفق مباشرة في الرسالة (بدون روابط)`] : []),
      ...evidence.linkOnly,
    ];
    const fileText = fileLines.join('\n').slice(0, 1024) || 'لا توجد ملفات مرفوعة.';
    const linkText = links.map((link) => `• <${link}>`).join('\n').slice(0, 1024) || 'لا توجد روابط خارجية.';
    let discordPosted = false;
    let warning = '';
    let reviewEmbed = null;
    try {
      const embed = {
        title: `📨 دليل مهمة جديد #${submissionId}`,
        description: 'وصل دليل جديد من عضو الاستاف، والتسليم بانتظار مراجعة المسؤولين.\n\n**استخدم زري الموافقة أو الرفض هنا مباشرة، أو راجعه من الموقع.**',
        color: 0x5865F2,
        fields: [
          { name: '👤 العضو', value: `<@${user.id}>\n\`${user.id}\``, inline: true },
          { name: '🧾 رقم التسليم', value: `#${submissionId}`, inline: true },
          { name: `🎯 المهمة المحددة (${foundTasks.length})`, value: taskText, inline: false },
          { name: '📎 ملفات الدليل', value: fileText, inline: false },
          { name: links.length ? '🔗 روابط إضافية ⚠️ (من العضو، متفتحهاش إلا لو موثوقة)' : '🔗 روابط إضافية', value: linkText, inline: false },
          ...(note ? [{ name: '📝 ملاحظة العضو', value: note.slice(0, 1024), inline: false }] : []),
          ...(duplicateImages.length ? [{ name: '⚠️ تحذير: صورة مكررة', value: duplicateImages.map((d) => `${cleanText(d.fileName, 80)} — ${d.matches.slice(0, 4).map((m) => `#${m.submissionId} من ${cleanText(m.username, 60)}`).join('، ')}`).join('\n').slice(0, 1024), inline: false }] : []),
        ],
        timestamp: new Date().toISOString(),
        footer: { text: 'إدارة البرج • مراجعة أدلة المهمات' },
        ...(user.avatarUrl ? { thumbnail: { url: user.avatarUrl } } : {}),
      };
      const firstImage = evidence.attachments.find((file) => file.type.startsWith('image/'));
      if (firstImage) embed.image = { url: `attachment://${firstImage.name}` };
      reviewEmbed = embed;
      const posted = await postDiscordWithFiles(SUBMISSION_REVIEW_CHANNEL_ID, {
        embeds: [embed],
        components: [{ type: 1, components: [
          { type: 2, style: 3, label: '✅ موافقة وإضافة النقاط', custom_id: `submission:approve:${submissionId}` },
          { type: 2, style: 4, label: '❌ رفض التسليم', custom_id: `submission:reject:${submissionId}` },
        ] }],
        allowed_mentions: { parse: [] },
      }, evidence.attachments);
      if (posted?.id) await sql`UPDATE submissions SET discord_message_id = ${String(posted.id)}, discord_channel_id = ${SUBMISSION_REVIEW_CHANNEL_ID} WHERE id = ${submissionId}`;
      discordPosted = true;
    } catch (error) { warning = cleanText(error.message, 220); console.error('[submission post]', warning); }
    return sendJson(res, 201, { ok: true, submissionId, discordPosted, warning, duplicateImages, message: `${discordPosted ? 'اتسجل تسليم المهمة واترسل لروم المراجعة فقط.' : 'اتسجل التسليم في الموقع، لكن البوت لم يستطع إرساله لروم المراجعة.'}${duplicateImages.length ? ' ⚠️ تم اكتشاف صورة مكررة وسيظهر التحذير للمراجعين.' : ''}` });
  }

  if (route === 'submissions' && parts.length === 1 && req.method === 'GET') {
    const rows = canManage(user)
      ? await sql`SELECT * FROM submissions ORDER BY id DESC LIMIT 80`
      : await sql`SELECT * FROM submissions WHERE user_id = ${user.id} ORDER BY id DESC LIMIT 40`;
    const ids = rows.map((row) => Number(row.id));
    let taskRows = [];
    if (ids.length) {
      const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ');
      taskRows = await sql.query(`SELECT st.submission_id, s.user_id, t.id, t.title, COALESCE(st.points_awarded, t.points) AS points, t.required FROM submission_tasks st JOIN submissions s ON s.id = st.submission_id JOIN tasks t ON t.id = st.task_id WHERE st.submission_id IN (${placeholders}) ORDER BY st.submission_id DESC, t.required DESC, t.id`, ids);
    }
    const tasksBySubmission = new Map();
    const submissionOwners = [...new Set(rows.map((row) => String(row.user_id)))];
    const relatedTaskIds = [...new Set(taskRows.map((row) => Number(row.id)))];
    const activeReworks = submissionOwners.length && relatedTaskIds.length
      ? await sql`SELECT user_id, task_id, status FROM task_rework_requests WHERE user_id = ANY(${submissionOwners}) AND task_id = ANY(${relatedTaskIds}) AND status IN ('requested','submitted')`
      : [];
    const activeReworkMap = new Map(activeReworks.map((row) => [`${row.user_id}:${row.task_id}`, String(row.status)]));
    const submissionStatusById = new Map(rows.map((row) => [Number(row.id), String(row.status)]));
    const latestApprovedSubmissionByUserTask = new Map();
    for (const row of taskRows) {
      if (submissionStatusById.get(Number(row.submission_id)) !== 'approved') continue;
      const key = `${row.user_id}:${row.id}`;
      if (!latestApprovedSubmissionByUserTask.has(key)) latestApprovedSubmissionByUserTask.set(key, Number(row.submission_id));
    }
    for (const row of taskRows) {
      const key = Number(row.submission_id);
      if (!tasksBySubmission.has(key)) tasksBySubmission.set(key, []);
      const userTaskKey = `${row.user_id}:${row.id}`;
      tasksBySubmission.get(key).push({ id: Number(row.id), title: row.title, points: Number(row.points || 0), required: Boolean(row.required), redoStatus: activeReworkMap.get(userTaskKey) || '', canRequestRedo: latestApprovedSubmissionByUserTask.get(userTaskKey) === key });
    }
    const duplicateMap = new Map();
    if (canManage(user) && ids.length) {
      const matches = await sql`SELECT own.submission_id AS submission_id, own.file_sha256 AS file_sha256, other.submission_id AS duplicate_submission_id, other.user_id AS duplicate_user_id, other.username AS duplicate_username, other.original_name AS duplicate_file_name, other.created_at AS duplicate_created_at FROM submission_file_hashes own JOIN submission_file_hashes other ON other.file_sha256 = own.file_sha256 AND other.submission_id <> own.submission_id WHERE own.submission_id = ANY(${ids}) ORDER BY own.submission_id, other.created_at ASC LIMIT 2000`;
      for (const match of matches) {
        const key = `${Number(match.submission_id)}:${match.file_sha256}`;
        if (!duplicateMap.has(key)) duplicateMap.set(key, []);
        duplicateMap.get(key).push({ submissionId: Number(match.duplicate_submission_id), userId: match.duplicate_user_id, username: match.duplicate_username, fileName: match.duplicate_file_name, submittedAt: match.duplicate_created_at });
      }
    }
    const submissions = rows.map((row) => {
      const rawFiles = parseJson(row.files_json, []);
      const files = rawFiles.map((file) => ({ ...file, url: `/api/evidence?token=${encodeURIComponent(file.token)}`, duplicateMatches: file.sha256 ? (duplicateMap.get(`${Number(row.id)}:${file.sha256}`) || []) : [] }));
      const duplicateImages = files.filter((file) => file.duplicateMatches.length).map((file) => ({ fileName: file.originalName, matches: file.duplicateMatches }));
      return { id: Number(row.id), userId: row.user_id, username: row.username, avatarUrl: row.avatar_url, note: row.note, evidenceLinks: parseJson(row.evidence_links, []), files, duplicateImages, submittedAt: row.submitted_at, status: row.status, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at, tasks: tasksBySubmission.get(Number(row.id)) || [] };
    });
    return sendJson(res, 200, { submissions });
  }

  if (route === 'points' && req.method === 'GET') {
    const targetId = cleanText(req.query?.userId || user.id, 32);
    if (targetId !== user.id && !canManage(user)) return sendError(res, 403, 'تقدر تشوف نقاطك فقط.');
    const rows = await sql`SELECT COALESCE(SUM(amount),0) AS total FROM staff_points WHERE user_id = ${targetId}`;
    const recent = await sql`SELECT amount, reason, source, created_at FROM staff_points WHERE user_id = ${targetId} ORDER BY id DESC LIMIT 30`;
    return sendJson(res, 200, { userId: targetId, points: Number(rows[0]?.total || 0), entries: recent.map(x => ({ amount: Number(x.amount), reason: x.reason, source: x.source, createdAt: x.created_at })) });
  }
  if (route === 'points' && req.method === 'POST') {
    if (!canManage(user)) return sendError(res, 403, 'إضافة النقاط اليدوية للمسؤولين فقط.');
    if (!ensureSameOrigin(req, res)) return;
    const targetId = cleanText(req.body?.userId, 32);
    const username = cleanText(req.body?.username || targetId, 100);
    const amount = Number(req.body?.amount);
    const reason = cleanText(req.body?.reason, 300);
    if (!/^\d{17,20}$/.test(targetId) || !Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000 || Math.round(amount * 100) / 100 !== amount) return sendError(res, 400, 'حدد Discord ID صحيحًا ومقدار نقاط غير صفري حتى منزلتين عشريتين مثل 0.1 أو 0.25.');
    const cleanAmount = Math.round(amount * 100) / 100;
    await sql`INSERT INTO staff_points(user_id, username, amount, reason, actor_id, actor_name, source, created_at) VALUES (${targetId}, ${username}, ${cleanAmount}, ${reason}, ${user.id}, ${user.username}, 'manual', NOW())`;
    const total = await sql`SELECT COALESCE(SUM(amount),0) AS total FROM staff_points WHERE user_id = ${targetId}`;
    const currentTotal = Number(total[0]?.total || 0);
    try {
      await postDiscordEmbed(POINTS_LOG_CHANNEL_ID, {
        title: cleanAmount > 0 ? '⭐ تعديل النقاط — إضافة رصيد' : '⭐ تعديل النقاط — خصم رصيد',
        description: 'تم تسجيل حركة نقاط يدوية من لوحة إدارة البرج.',
        color: cleanAmount > 0 ? 0x22C55E : 0xEF4444,
        fields: [
          { name: '👤 العضو', value: `<@${targetId}>\n\`${targetId}\``, inline: true },
          { name: '💠 مقدار التغيير', value: `**${cleanAmount > 0 ? '+' : ''}${formatPoints(cleanAmount)} نقطة**`, inline: true },
          { name: '📊 الرصيد الحالي', value: `**${formatPoints(currentTotal)} نقطة**`, inline: true },
          { name: '📝 السبب', value: (reason || 'لم يتم تحديد سبب').slice(0, 1024), inline: false },
          { name: '🛡️ بواسطة المسؤول', value: `<@${user.id}>\n\`${user.id}\``, inline: true },
          { name: '🕒 وقت التعديل', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
        ],
        footer: { text: 'Borg Management • Points Ledger' },
        timestamp: new Date().toISOString(),
      });
    } catch (e) { console.error('[points log]', cleanText(e.message, 180)); }
    return sendJson(res, 201, { ok: true, points: currentTotal });
  }
  // طلب إعادة مهمة واحدة حتى لو كان تسليمها مقبولًا؛ تُسحب نقاط المهمة فقط وتُحفظ كل الحركة في سجل النقاط.
  if (route === 'submissions' && parts.length === 3 && req.method === 'POST' && parts[2] === 'redo-task') {
    if (!canManage(user)) return sendError(res, 403, 'طلب إعادة المهمات متاح للمسؤولين فقط.');
    if (!ensureSameOrigin(req, res)) return;
    const submissionId = Number(parts[1]);
    const taskId = Number(req.body?.taskId);
    if (!Number.isSafeInteger(submissionId) || submissionId < 1 || !Number.isSafeInteger(taskId) || taskId < 1) return sendError(res, 400, 'رقم التسليم أو المهمة غير صالح.');
    const submissionRows = await sql`SELECT id, user_id, username, status FROM submissions WHERE id = ${submissionId} LIMIT 1`;
    if (!submissionRows.length) return sendError(res, 404, 'التسليم غير موجود.');
    const sub = submissionRows[0];
    if (String(sub.status) !== 'approved') return sendError(res, 409, 'طلب إعادة المهمة متاح للتسليمات المقبولة فقط.');
    // For legacy one-task submissions, the points ledger gives the exact historical award even if the task's value changed later.
    const taskCountRows = await sql`SELECT COUNT(*)::int AS total FROM submission_tasks WHERE submission_id = ${submissionId}`;
    if (Number(taskCountRows[0]?.total || 0) === 1) {
      const historicalAwardRows = await sql`SELECT COALESCE(SUM(amount),0) AS amount FROM staff_points WHERE submission_id = ${submissionId} AND source = 'task'`;
      await sql`UPDATE submission_tasks SET points_awarded = ${Number(historicalAwardRows[0]?.amount || 0)} WHERE submission_id = ${submissionId} AND task_id = ${taskId} AND points_awarded IS NULL`;
    }
    await sql`UPDATE submission_tasks st SET points_awarded = t.points FROM tasks t WHERE st.task_id = t.id AND st.submission_id = ${submissionId} AND st.points_awarded IS NULL`;
    const taskRows = await sql`SELECT t.id, t.title, COALESCE(st.points_awarded, t.points) AS points_awarded FROM submission_tasks st JOIN tasks t ON t.id = st.task_id WHERE st.submission_id = ${submissionId} AND t.id = ${taskId} LIMIT 1`;
    if (!taskRows.length) return sendError(res, 404, 'المهمة دي مش مرتبطة بالتسليم المحدد.');
    const task = taskRows[0];
    const pointsDeducted = Math.round(Number(task.points_awarded || 0) * 100) / 100;
    const reason = cleanText(req.body?.reason, 400);
    const created = await sql`
      WITH new_request AS (
        INSERT INTO task_rework_requests(user_id, username, task_id, task_title, original_submission_id, requested_by, requested_by_name, reason, points_deducted, status, created_at)
        SELECT ${sub.user_id}, ${sub.username}, ${taskId}, ${task.title}, ${submissionId}, ${user.id}, ${user.username}, ${reason}, ${pointsDeducted}, 'requested', NOW()
        WHERE NOT EXISTS (SELECT 1 FROM task_rework_requests WHERE user_id = ${sub.user_id} AND task_id = ${taskId} AND status IN ('requested','submitted'))
        RETURNING id, user_id, username, task_id, task_title, original_submission_id, points_deducted
      ), debit AS (
        INSERT INTO staff_points(user_id, username, amount, reason, actor_id, actor_name, source, submission_id, created_at)
        SELECT nr.user_id, nr.username, -nr.points_deducted, ${`خصم نقاط لطلب إعادة المهمة #${taskId}`}, ${user.id}, ${user.username}, 'task_rework', nr.original_submission_id, NOW()
        FROM new_request nr WHERE nr.points_deducted > 0
        RETURNING id
      )
      SELECT * FROM new_request
    `;
    if (!created.length) return sendError(res, 409, 'الإدارة طلبت إعادة المهمة دي بالفعل أو العضو بيعيد تسليمها حاليًا.');
    const reworkId = Number(created[0].id);
    const totalRows = await sql`SELECT COALESCE(SUM(amount),0) AS total FROM staff_points WHERE user_id = ${sub.user_id}`;
    const totalAfter = Number(totalRows[0]?.total || 0);
    const taskSummary = `**${cleanText(task.title, 180)}** (#${taskId})`;
    const fields = [
      { name: '📋 المهمة المطلوب إعادتها', value: taskSummary, inline: false },
      { name: '💎 النقاط المسحوبة', value: `-${formatPoints(pointsDeducted)} نقطة`, inline: true },
      { name: '📊 الرصيد الحالي', value: `${formatPoints(totalAfter)} نقطة`, inline: true },
      { name: '🛡️ المسؤول', value: `<@${user.id}>`, inline: true },
    ];
    const dmPromise = notifyReview({ token: BOT_TOKEN, userId: sub.user_id, kind: 'submission', status: 'redo_requested', id: reworkId, reviewerId: user.id, note: reason, fields });
    try {
      await postDiscordEmbed(POINTS_LOG_CHANNEL_ID, {
        title: '🔁 طلب إعادة مهمة وخصم نقاط',
        description: `تم طلب إعادة المهمة من <@${sub.user_id}> رغم اعتمادها سابقًا.`,
        color: 0xf59e0b,
        fields: [
          { name: '👤 العضو', value: `<@${sub.user_id}>`, inline: true },
          { name: '📋 المهمة', value: taskSummary, inline: false },
          { name: '💎 النقاط المسحوبة', value: `-${formatPoints(pointsDeducted)} نقطة`, inline: true },
          { name: '📊 الرصيد الحالي', value: `${formatPoints(totalAfter)} نقطة`, inline: true },
          { name: '🛡️ المسؤول', value: `<@${user.id}>`, inline: true },
          ...(reason ? [{ name: '📝 السبب', value: reason.slice(0, 1024), inline: false }] : []),
        ],
        footer: { text: 'Borg Management • Task Rework' },
        timestamp: new Date().toISOString(),
      });
    } catch (error) { console.error('[task redo log]', cleanText(error.message, 180)); }
    const dm = await dmPromise;
    return sendJson(res, 200, { ok: true, id: reworkId, taskId, pointsDeducted, totalAfter, dmSent: dm.ok, message: `تم طلب إعادة المهمة وخصم ${formatPoints(pointsDeducted)} نقطة من رصيد العضو.${dmNote(dm)}` });
  }

  // إعادة فتح تسليم مرفوض: لو الإدارة رفضت بالغلط، الأدمن يفك القفل والعضو يقدر يسلّم المهمة تاني.
  // التسليم القديم بيفضل في السجل بحالة 'reopened' (مش بيتمسح)، والقفل بيعتمد على حالات approved/pending/rejected بس.
  if (route === 'submissions' && parts.length === 3 && req.method === 'POST' && parts[2] === 'reopen') {
    if (!canManage(user)) return sendError(res, 403, 'إعادة فتح المهام للمسؤولين فقط.');
    if (!ensureSameOrigin(req, res)) return;
    const id = Number(parts[1]);
    if (!Number.isSafeInteger(id) || id < 1) return sendError(res, 400, 'رقم التسليم غير صالح.');
    const rows = await sql`SELECT * FROM submissions WHERE id = ${id} LIMIT 1`;
    if (!rows.length) return sendError(res, 404, 'التسليم غير موجود.');
    const sub = rows[0];
    if (sub.status !== 'rejected') return sendError(res, 409, 'إعادة الفتح متاحة للتسليمات المرفوضة فقط.');
    const reopenNote = cleanText(req.body?.note, 300);
    const reopened = await sql`UPDATE submissions SET status = 'reopened', reviewed_by = ${user.id}, reviewed_at = NOW() WHERE id = ${id} AND status = 'rejected' RETURNING id`;
    if (!reopened.length) return sendError(res, 409, 'تم تغيير حالة التسليم من مسؤول آخر بالفعل.');
    await sql`INSERT INTO submission_review_audit(submission_id, member_id, member_name, decision, reviewer_id, reviewer_name, reason, created_at) VALUES (${id}, ${sub.user_id}, ${sub.username}, 'reopened', ${user.id}, ${user.username}, ${reopenNote}, NOW())`;
    const taskRows = await sql`SELECT t.id, t.title, t.points FROM submission_tasks st JOIN tasks t ON t.id = st.task_id WHERE st.submission_id = ${id}`;
    const taskSummary = taskRows.map((t) => `• **${cleanText(t.title, 180)}**`).join('\n').slice(0, 1024) || 'لا توجد مهمات مرتبطة بالتسليم.';
    const dmPromise = notifyReview({ token: BOT_TOKEN, userId: sub.user_id, kind: 'submission', status: 'reopened', id, reviewerId: user.id, note: reopenNote, fields: [{ name: '📋 المهمات المعاد فتحها', value: taskSummary, inline: false }] });
    try {
      await postDiscordEmbed(POINTS_LOG_CHANNEL_ID, {
        title: '🔓 إعادة فتح تسليم مرفوض',
        description: `تمت إعادة فتح التسليم **#${id}**، والعضو يقدر يسلّم المهام دي تاني.`,
        color: 0xF59E0B,
        fields: [
          { name: '👤 العضو', value: `<@${sub.user_id}>`, inline: true },
          { name: '🛡️ المسؤول', value: `<@${user.id}>`, inline: true },
          { name: '📋 المهمات', value: taskSummary, inline: false },
          ...(reopenNote ? [{ name: '🗒️ ملاحظة', value: reopenNote.slice(0, 1024), inline: false }] : []),
        ],
        footer: { text: 'Borg Management • Task Review' },
        timestamp: new Date().toISOString(),
      });
    } catch (e) { console.error('[submission reopen log]', cleanText(e.message, 180)); }
    await updateDiscordSubmissionReview(sub, 'reopened', user.id, reopenNote);
    const dm = await dmPromise;
    return sendJson(res, 200, { ok: true, status: 'reopened', dmSent: dm.ok, message: `تمت إعادة فتح التسليم #${id}، والعضو يقدر يسلّم المهام تاني.${dmNote(dm)}` });
  }
  if (route === 'submissions' && parts.length === 3 && req.method === 'POST' && ['approve','reject'].includes(parts[2])) {
    if (!canManage(user)) return sendError(res, 403, 'مراجعة التسليمات للمسؤولين فقط.');
    if (!ensureSameOrigin(req, res)) return;
    const id = Number(parts[1]);
    const rows = await sql`SELECT * FROM submissions WHERE id = ${id} LIMIT 1`;
    if (!rows.length) return sendError(res, 404, 'التسليم غير موجود.');
    const sub = rows[0];
    if (!['pending', 'submitted'].includes(String(sub.status))) return sendError(res, 409, 'تمت مراجعة التسليم بالفعل.');
    if (parts[2] === 'reject') {
      const reason = cleanText(req.body?.reason, 300);
      const taskRows = await sql`SELECT t.id, t.title, COALESCE(st.points_awarded, t.points) AS points FROM submission_tasks st JOIN tasks t ON t.id = st.task_id WHERE st.submission_id = ${id} ORDER BY t.id`;
      const rejected = await sql`UPDATE submissions SET status = 'rejected', reviewed_by = ${user.id}, reviewed_at = NOW() WHERE id = ${id} AND status IN ('pending','submitted') RETURNING id`;
      if (!rejected.length) return sendError(res, 409, 'تمت مراجعة التسليم بالفعل.');
      await sql`UPDATE task_rework_requests SET status = 'requested', current_submission_id = NULL WHERE user_id = ${sub.user_id} AND status = 'submitted' AND current_submission_id = ${id}`;
      await sql`INSERT INTO submission_review_audit(submission_id, member_id, member_name, decision, reviewer_id, reviewer_name, reason, created_at) VALUES (${id}, ${sub.user_id}, ${sub.username}, 'rejected', ${user.id}, ${user.username}, ${reason}, NOW())`;
      const dmPromise = notifyReview({ token: BOT_TOKEN, userId: sub.user_id, kind: 'submission', status: 'rejected', id, reviewerId: user.id, note: reason });
      const totals = await sql`SELECT COALESCE(SUM(amount),0) AS total FROM staff_points WHERE user_id = ${sub.user_id}`;
      const totalAfter = Number(totals[0]?.total || 0);
      const notification = buildSubmissionNotifications({ submissionId: id, sub, reviewerId: user.id, status: 'rejected', taskRows, amount: 0, totalAfter, reason });
      try {
        await postDiscordEmbed(POINTS_LOG_CHANNEL_ID, notification.logEmbed);
      } catch (e) { console.error('[submission reject log]', cleanText(e.message, 180)); }
      try { await postSubmissionDecisionMessage({ req, submissionId: id, sub, reviewerId: user.id, status: 'rejected', reason, taskRows, amount: 0, totalAfter }); }
      catch (e) { console.error('[submission reject announcement]', cleanText(e.message, 200)); }
      await updateDiscordSubmissionReview(sub, 'rejected', user.id, reason, 0, totalAfter);
      const dm = await dmPromise;
      return sendJson(res, 200, { ok: true, status: 'rejected', dmSent: dm.ok, message: `تم رفض التسليم.${dmNote(dm)}` });
    }
    await sql`UPDATE submission_tasks st SET points_awarded = t.points FROM tasks t WHERE st.task_id = t.id AND st.submission_id = ${id} AND st.points_awarded IS NULL`;
    const taskRows = await sql`SELECT t.id, t.title, COALESCE(st.points_awarded, t.points) AS points FROM submission_tasks st JOIN tasks t ON t.id = st.task_id WHERE st.submission_id = ${id}`;
    const amount = Math.round(taskRows.reduce((sum, t) => sum + Number(t.points || 0), 0) * 100) / 100;
    const marked = await sql`UPDATE submissions SET status = 'approved', reviewed_by = ${user.id}, reviewed_at = NOW() WHERE id = ${id} AND status IN ('pending','submitted') RETURNING id`;
    if (!marked.length) return sendError(res, 409, 'تمت مراجعة التسليم بالفعل.');
    await sql`UPDATE task_rework_requests SET status = 'completed', completed_at = NOW() WHERE user_id = ${sub.user_id} AND status = 'submitted' AND current_submission_id = ${id}`;
    await sql`INSERT INTO submission_review_audit(submission_id, member_id, member_name, decision, reviewer_id, reviewer_name, reason, created_at) VALUES (${id}, ${sub.user_id}, ${sub.username}, 'approved', ${user.id}, ${user.username}, ${cleanText(req.body?.reason || req.body?.note, 300)}, NOW())`;
    if (amount > 0) await sql`INSERT INTO staff_points(user_id, username, amount, reason, actor_id, actor_name, source, submission_id, created_at) VALUES (${sub.user_id}, ${sub.username}, ${amount}, ${`اعتماد تسليم #${id}`}, ${user.id}, ${user.username}, 'task', ${id}, NOW())`;
    const totalAfterRows = await sql`SELECT COALESCE(SUM(amount),0) AS total FROM staff_points WHERE user_id = ${sub.user_id}`;
    const totalAfter = Number(totalAfterRows[0]?.total || 0);
    const taskSummary = taskRows.map(t => `• **${cleanText(t.title, 180)}** — ${formatPoints(t.points)} نقطة`).join('\n').slice(0, 1024) || 'لا توجد مهمات مرتبطة بالتسليم.';
    const reason = cleanText(req.body?.reason || req.body?.note, 300);
    await updateDiscordSubmissionReview(sub, 'approved', user.id, reason, amount, totalAfter);
    const notification = buildSubmissionNotifications({ submissionId: id, sub, reviewerId: user.id, status: 'approved', taskRows, amount, totalAfter, reason });
    try {
      await postDiscordEmbed(POINTS_LOG_CHANNEL_ID, notification.logEmbed);
    } catch (e) { console.error('[submission approve log]', cleanText(e.message, 180)); }
    try { await postSubmissionDecisionMessage({ req, submissionId: id, sub, reviewerId: user.id, status: 'approved', taskRows, amount, totalAfter, reason }); } catch (e) { console.error('[submission approved message]', cleanText(e.message, 200)); }
    const dm = await notifyReview({ token: BOT_TOKEN, userId: sub.user_id, kind: 'submission', status: 'approved', id, reviewerId: user.id, fields: [
      { name: '💎 النقاط المضافة', value: `**+${formatPoints(amount)} نقطة**`, inline: true },
      { name: '📊 رصيدك الحالي', value: `**${formatPoints(totalAfter)} نقطة**`, inline: true },
      { name: '📋 المهمات', value: taskSummary, inline: false },
    ] });
    return sendJson(res, 200, { ok: true, status: 'approved', awarded: amount, dmSent: dm.ok, message: `تم اعتماد التسليم وإضافة ${formatPoints(amount)} نقطة.${dmNote(dm)}` });
  }
  if (route === 'chat' && parts.length === 3 && req.method === 'DELETE') {
    const room = parts[1];
    const messageId = String(parts[2] || '');
    if (!['staff', 'management'].includes(room)) return sendError(res, 404, 'غرفة الشات مش موجودة.');
    if (!/^\d{1,18}$/.test(messageId)) return sendError(res, 400, 'رقم الرسالة غير صالح.');
    if (!canReadRoom(user, room)) return sendError(res, 403, 'الشات ده مخصص للمسؤولين.');
    if (rateLimited(req, res, user, 'chat-delete', 30)) return;
    const targetRows = await sql`SELECT id, user_id FROM chat_messages WHERE room = ${room} AND id = ${messageId} LIMIT 1`;
    const target = targetRows[0];
    if (!target) return sendError(res, 404, 'الرسالة غير موجودة أو تم حذفها بالفعل.');
    if (String(target.user_id) !== String(user.id) && !canManage(user)) return sendError(res, 403, 'تقدر تحذف رسائلك أنت فقط؛ حذف رسائل الآخرين للمسؤولين.');
    const removed = await sql`DELETE FROM chat_messages WHERE room = ${room} AND id = ${messageId} RETURNING id`;
    if (!removed.length) return sendError(res, 404, 'الرسالة غير موجودة أو تم حذفها بالفعل.');
    const deletion = await sql`INSERT INTO chat_message_deletions(room, message_id, deleted_by, deleted_at) VALUES (${room}, ${messageId}::bigint, ${String(user.id)}, NOW()) RETURNING id`;
    memCache.delete('daily-message-stats');
    return sendJson(res, 200, { ok: true, room, messageId: Number(messageId), deletionCursor: Number(deletion[0]?.id) || 0 });
  }
  if (route === 'chat' && parts.length === 2 && req.method === 'GET') {
    const room = parts[1];
    if (!['staff', 'management'].includes(room)) return sendError(res, 404, 'غرفة الشات مش موجودة.');
    if (!canReadRoom(user, room)) return sendError(res, 403, 'الشات ده مخصص للمسؤولين.');
    if (rateLimited(req, res, user, 'chat-get', 40)) return;
    // الاستعلام الدوري (after=<آخر id>) بيجيب الجديد فقط، من غير مزامنة Discord ولا إحصائيات — ده كان أكبر مصدر ضغط.
    const afterRaw = queryParam(req, 'after');
    const after = afterRaw !== null && /^\d{1,15}$/.test(afterRaw) ? Number(afterRaw) : null;
    const mapMessage = (row) => ({ id: Number(row.id), room: row.room, userId: row.user_id, username: row.username, avatarUrl: row.avatar_url, content: row.content, createdAt: row.created_at });
    const deletionAfterRaw = queryParam(req, 'deletionsAfter');
    const deletionAfter = deletionAfterRaw !== null && /^\d{1,18}$/.test(deletionAfterRaw) ? Number(deletionAfterRaw) : 0;
    if (after !== null) {
      const [fresh, deletions] = await Promise.all([
        sql`SELECT * FROM chat_messages WHERE room = ${room} AND id > ${after} ORDER BY id ASC LIMIT 100`,
        sql`SELECT id, message_id FROM chat_message_deletions WHERE room = ${room} AND id > ${deletionAfter} ORDER BY id ASC LIMIT 100`,
      ]);
      return sendJson(res, 200, { messages: fresh.map(mapMessage), deletedMessageIds: deletions.map((row) => Number(row.message_id)), deletionCursor: deletions.length ? Number(deletions[deletions.length - 1].id) : deletionAfter, incremental: true });
    }
    const [rows, cursorRows] = await Promise.all([
      sql`SELECT * FROM (SELECT * FROM chat_messages WHERE room = ${room} ORDER BY id DESC LIMIT 100) AS recent ORDER BY id ASC`,
      sql`SELECT COALESCE(MAX(id), 0)::text AS cursor FROM chat_message_deletions WHERE room = ${room}`,
    ]);
    if (room === 'staff') await syncChannelMessageCounts(sql, { budgetMs: 4000 });
    const dailyStats = room === 'staff' ? await getDailyStaffMessageStats(sql) : {};
    return sendJson(res, 200, { messages: rows.map(mapMessage), deletionCursor: Number(cursorRows[0]?.cursor) || 0, ...dailyStats });
  }
  if (route === 'voice-time' && parts.length === 2 && req.method === 'GET') {
    if (!user) return sendError(res, 401, 'سجّل الدخول الأول.');
    const targetUserId = String(parts[1] || '');
    if (!/^\d{15,22}$/.test(targetUserId)) return sendError(res, 400, 'Discord ID غير صالح.');
    if (!canManage(user) && String(user.id) !== targetUserId) {
      return sendError(res, 403, 'تقدر تشوف وقت الفويس الخاص بحسابك فقط.');
    }
    if (rateLimited(req, res, user, 'voice-time-member-get', 30)) return;
    await ensureSchema();
    const sql = await getSql();
    await ensureVoiceTimeApiSchema(sql);
    const [metaRows, rows, dayRows] = await Promise.all([
      sql`SELECT last_seen AS "lastSeen" FROM discord_voice_time_meta WHERE guild_id = ${STAFF_GUILD_ID} LIMIT 1`,
      sql`WITH bounds AS (
        SELECT
          date_trunc('day', NOW() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo' AS day_start,
          (date_trunc('day', NOW() AT TIME ZONE 'Africa/Cairo') + INTERVAL '1 day') AT TIME ZONE 'Africa/Cairo' AS day_end
      )
      SELECT s.user_id AS "userId",
        (ARRAY_AGG(s.username ORDER BY s.joined_at DESC))[1] AS username,
        SUM(GREATEST(0, EXTRACT(EPOCH FROM (
          LEAST(COALESCE(s.ended_at, NOW()), bounds.day_end, NOW()) - GREATEST(s.joined_at, bounds.day_start)
        )) * 1000))::bigint AS "durationMs",
        BOOL_OR(s.ended_at IS NULL) AS "inVoice",
        MAX(s.channel_id) FILTER (WHERE s.ended_at IS NULL) AS "channelId"
      FROM discord_voice_sessions s CROSS JOIN bounds
      WHERE s.guild_id = ${STAFF_GUILD_ID}
        AND s.user_id = ${targetUserId}
        AND s.joined_at < bounds.day_end
        AND COALESCE(s.ended_at, NOW()) > bounds.day_start
      GROUP BY s.user_id`,
      sql`SELECT to_char((NOW() AT TIME ZONE 'Africa/Cairo')::date, 'YYYY-MM-DD') AS day`,
    ]);
    const lastSeen = metaRows[0]?.lastSeen ? new Date(metaRows[0].lastSeen).getTime() : 0;
    const ageSeconds = lastSeen && Number.isFinite(lastSeen) ? Math.max(0, Math.floor((Date.now() - lastSeen) / 1000)) : null;
    const available = Boolean(lastSeen && Number.isFinite(lastSeen) && ageSeconds <= 180);
    const row = rows[0] || {};
    return sendJson(res, 200, {
      available,
      reason: available ? null : (lastSeen ? 'stale-heartbeat' : 'no-heartbeat'),
      lastSeenAt: lastSeen && Number.isFinite(lastSeen) ? new Date(lastSeen).toISOString() : null,
      ageSeconds,
      dailyDate: dayRows[0]?.day || null,
      generatedAt: new Date().toISOString(),
      member: {
        userId: targetUserId,
        username: String(row.username || targetUserId),
        durationMs: Math.max(0, Number(row.durationMs) || 0),
        inVoice: Boolean(row.inVoice),
        channelId: row.channelId ? String(row.channelId) : null,
      },
    });
  }
  if (route === 'voice-time' && parts.length === 1 && req.method === 'GET') {
    if (!user) return sendError(res, 401, 'سجّل الدخول الأول.');
    if (!canManage(user)) return sendError(res, 403, 'إحصائيات وقت الفويس متاحة لمسؤولي الإدارة فقط.');
    if (rateLimited(req, res, user, 'voice-time-get', 30)) return;
    await ensureSchema();
    const sql = await getSql();
    await ensureVoiceTimeApiSchema(sql);
    const [metaRows, rows, dayRows] = await Promise.all([
      sql`SELECT last_seen AS "lastSeen" FROM discord_voice_time_meta WHERE guild_id = ${STAFF_GUILD_ID} LIMIT 1`,
      sql`WITH bounds AS (
        SELECT
          date_trunc('day', NOW() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo' AS day_start,
          (date_trunc('day', NOW() AT TIME ZONE 'Africa/Cairo') + INTERVAL '1 day') AT TIME ZONE 'Africa/Cairo' AS day_end
      )
      SELECT s.user_id AS "userId",
        (ARRAY_AGG(s.username ORDER BY s.joined_at DESC))[1] AS username,
        SUM(GREATEST(0, EXTRACT(EPOCH FROM (
          LEAST(COALESCE(s.ended_at, NOW()), bounds.day_end, NOW()) - GREATEST(s.joined_at, bounds.day_start)
        )) * 1000))::bigint AS "durationMs",
        BOOL_OR(s.ended_at IS NULL) AS "inVoice",
        MAX(s.channel_id) FILTER (WHERE s.ended_at IS NULL) AS "channelId"
      FROM discord_voice_sessions s CROSS JOIN bounds
      WHERE s.guild_id = ${STAFF_GUILD_ID}
        AND s.joined_at < bounds.day_end
        AND COALESCE(s.ended_at, NOW()) > bounds.day_start
      GROUP BY s.user_id
      ORDER BY "durationMs" DESC, username ASC`,
      sql`SELECT to_char((NOW() AT TIME ZONE 'Africa/Cairo')::date, 'YYYY-MM-DD') AS day`,
    ]);
    const lastSeen = metaRows[0]?.lastSeen ? new Date(metaRows[0].lastSeen).getTime() : 0;
    const ageSeconds = lastSeen && Number.isFinite(lastSeen) ? Math.max(0, Math.floor((Date.now() - lastSeen) / 1000)) : null;
    const available = Boolean(lastSeen && Number.isFinite(lastSeen) && ageSeconds <= 180);
    return sendJson(res, 200, {
      available,
      reason: available ? null : (lastSeen ? 'stale-heartbeat' : 'no-heartbeat'),
      lastSeenAt: lastSeen && Number.isFinite(lastSeen) ? new Date(lastSeen).toISOString() : null,
      ageSeconds,
      dailyDate: dayRows[0]?.day || null,
      generatedAt: new Date().toISOString(),
      members: rows.map((row) => ({
        userId: String(row.userId),
        username: String(row.username || row.userId),
        durationMs: Math.max(0, Number(row.durationMs) || 0),
        inVoice: Boolean(row.inVoice),
        channelId: row.channelId ? String(row.channelId) : null,
      })),
    });
  }

  if (route === 'discord-presence' && parts.length === 1 && req.method === 'GET') {
    if (!user) return sendError(res, 401, 'سجّل الدخول الأول.');
    if (rateLimited(req, res, user, 'discord-presence-get', 30)) return;
    await ensureSchema();
    const result = await cached(`discord-presence:${STAFF_GUILD_ID}`, 10_000, async () => {
      const sql = await getSql();
      const metaRows = await sql`SELECT last_seen AS "lastSeen", last_sync_at AS "lastSyncAt", last_error AS "lastError", member_count AS "memberCount", known_count AS "knownCount" FROM discord_presence_meta WHERE guild_id = ${STAFF_GUILD_ID} LIMIT 1`;
      const meta = metaRows[0] || {};
      const lastSeen = meta.lastSeen ? new Date(meta.lastSeen).getTime() : 0;
      const lastSync = meta.lastSyncAt ? new Date(meta.lastSyncAt).getTime() : 0;
      // The worker heartbeat and a successful first sync are separate signals.
      const ageSeconds = lastSeen && Number.isFinite(lastSeen) ? Math.max(0, Math.floor((Date.now() - lastSeen) / 1000)) : null;
      const syncAgeSeconds = lastSync && Number.isFinite(lastSync) ? Math.max(0, Math.floor((Date.now() - lastSync) / 1000)) : null;
      const lastSeenAt = lastSeen && Number.isFinite(lastSeen) ? new Date(lastSeen).toISOString() : null;
      const lastSyncAt = lastSync && Number.isFinite(lastSync) ? new Date(lastSync).toISOString() : null;
      if (!lastSeen || !Number.isFinite(lastSeen) || ageSeconds > 180) {
        return { available: false, reason: lastSeen ? 'stale-heartbeat' : 'no-heartbeat', statuses: {}, lastSeenAt, ageSeconds, lastSyncAt, syncAgeSeconds, lastError: meta.lastError || null, memberCount: Number(meta.memberCount || 0), knownCount: Number(meta.knownCount || 0) };
      }
      if (!lastSync || !Number.isFinite(lastSync)) {
        return { available: false, reason: meta.lastError ? 'sync-failed' : 'sync-not-complete', statuses: {}, lastSeenAt, ageSeconds, lastSyncAt: null, syncAgeSeconds: null, lastError: meta.lastError || null, memberCount: Number(meta.memberCount || 0), knownCount: Number(meta.knownCount || 0) };
      }
      const rows = await sql`SELECT user_id AS "userId", status FROM discord_presence WHERE guild_id = ${STAFF_GUILD_ID}`;
      const validStatuses = new Set(['online', 'idle', 'dnd', 'offline']);
      const statuses = {};
      // Missing status rows intentionally remain absent; the client labels those as unknown.
      for (const row of rows) if (validStatuses.has(row.status)) statuses[String(row.userId)] = row.status;
      // Activity signal: users who posted or joined voice while the Gateway status was Offline.
      // Discord does not expose Invisible separately, so this is evidence of activity, not certainty.
      const recentActivityRows = await sql`SELECT user_id AS "userId", activity_type AS "activityType", last_activity_at AS "lastActivityAt"
        FROM discord_presence_activity WHERE guild_id = ${STAFF_GUILD_ID} AND last_activity_at > NOW() - INTERVAL '5 minutes'`;
      const offlineActivity = {};
      for (const row of recentActivityRows) {
        const id = String(row.userId);
        if (statuses[id] !== 'offline') continue;
        statuses[id] = 'offline_active';
        offlineActivity[id] = { type: row.activityType, at: row.lastActivityAt };
      }
      return { available: true, statuses, offlineActivity, storedCount: Object.keys(statuses).length, lastSeenAt, ageSeconds, lastSyncAt, syncAgeSeconds, lastError: meta.lastError || null, memberCount: Number(meta.memberCount || 0), knownCount: Number(meta.knownCount || 0) };
    });
    return sendJson(res, 200, result);
  }
  if (route === 'presence' && parts.length === 1 && req.method === 'POST') {
    if (rateLimited(req, res, user, 'presence-post', 20)) return;
    // نكتب في الداتابيز بس لو آخر نبضة أقدم من 40 ثانية (بدل كتابة مع كل طلب).
    await sql`INSERT INTO site_presence(user_id, username, avatar_url, last_seen) VALUES (${user.id}, ${user.username}, ${user.avatarUrl || null}, NOW())
      ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, avatar_url = EXCLUDED.avatar_url, last_seen = NOW()
      WHERE site_presence.last_seen < NOW() - INTERVAL '40 seconds' OR site_presence.username IS DISTINCT FROM EXCLUDED.username`;
    return sendJson(res, 200, { ok: true });
  }
  if (route === 'presence' && parts.length === 1 && req.method === 'GET') {
    if (rateLimited(req, res, user, 'presence-get', 20)) return;
    const online = await cached('presence', 10_000, async () => {
      const rows = await sql`SELECT user_id AS "userId", username, avatar_url AS "avatarUrl", last_seen AS "lastSeen" FROM site_presence WHERE last_seen > NOW() - make_interval(secs => ${PRESENCE_WINDOW_SECONDS}::int) ORDER BY username`;
      return rows.map((row) => ({ userId: row.userId, username: row.username, avatarUrl: row.avatarUrl, lastSeen: row.lastSeen }));
    });
    return sendJson(res, 200, { online });
  }
  if (route === 'chat' && parts.length === 2 && req.method === 'POST') {
    const room = parts[1];
    if (!['staff', 'management'].includes(room)) return sendError(res, 404, 'غرفة الشات مش موجودة.');
    if (!canReadRoom(user, room)) return sendError(res, 403, 'الشات ده مخصص للمسؤولين.');
    if (rateLimited(req, res, user, 'chat-post', 20)) return;
    const content = cleanText(req.body?.content, 1500);
    if (!content) return sendError(res, 400, 'اكتب رسالة قبل الإرسال.');
    if (room === 'staff' && containsChatLink(content)) return sendError(res, 400, 'ممنوع إرسال روابط في شات الاستاف. ابعت الرسالة من غير الرابط.');
    const rows = await sql`INSERT INTO chat_messages(room, user_id, username, avatar_url, content, created_at) VALUES (${room}, ${user.id}, ${user.username}, ${user.avatarUrl || null}, ${content}, NOW()) RETURNING id, created_at`;
    const dailyStats = room === 'staff' ? await getDailyStaffMessageStats(sql) : {};
    let notified = false;
    if (room === 'staff' && BOT_TOKEN && MANAGER_IDS.size) {
      try {
        const gate = await sql`INSERT INTO notification_state(notification_key, last_sent_at) VALUES ('staff_chat_dm', NOW()) ON CONFLICT (notification_key) DO UPDATE SET last_sent_at = NOW() WHERE notification_state.last_sent_at < NOW() - INTERVAL '5 minutes' RETURNING notification_key`;
        if (gate.length) {
          const preview = content.length > 220 ? `${content.slice(0, 217)}...` : content;
          const dmText = `💬 **رسالة جديدة في شات الاستاف بالموقع**\n**المرسل:** ${cleanText(user.username, 80)}\n**الرسالة:** ${preview}\n\nالتنبيهات متجمعة بحد أقصى رسالة واحدة كل 5 دقائق.`;
          await Promise.all([...MANAGER_IDS].map(async managerId => { try { const dm = await discordApi('/users/@me/channels', { method: 'POST', body: JSON.stringify({ recipient_id: managerId }) }); await discordApi(`/channels/${dm.id}/messages`, { method: 'POST', body: JSON.stringify({ content: dmText, allowed_mentions: { parse: [] } }) }); } catch (error) { console.error('[staff chat DM]', managerId, cleanText(error.message, 180)); } }));
          notified = true;
        }
      } catch (error) { console.error('[staff chat notification]', cleanText(error.message, 180)); }
    }
    return sendJson(res, 201, { message: { id: Number(rows[0].id), room, userId: user.id, username: user.username, avatarUrl: user.avatarUrl, content, createdAt: rows[0].created_at }, notificationSent: notified, ...dailyStats });
  }
  sendError(res, 404, 'المسار غير موجود.');
}

module.exports = async function handler(req, res) {
  try {
    const parts = parseRoute(req);
    if (parts[0] === 'auth') return await handleAuth(parts, req, res);
    if (parts[0] === 'api') return await handleApi(parts.slice(1), req, res);
    // Rewrites may route /api/... directly, so normally the first component is the endpoint.
    if (parts[0] === 'uploads' && parts[1] === 'token') {
      const uploadUser = getSessionUser(req);
      if (!uploadUser) return sendError(res, 401, 'سجل دخولك بديسكورد أولًا.');
      if (!(await requireStaffGuildMemberAccess(uploadUser, res))) return;
      return await handleUploadToken(req, res);
    }
    if (parts[0] === 'evidence') return await sendPrivateEvidence(req, res);
    return await handleApi(parts, req, res);
  } catch (error) {
    console.error('[vercel handler]', cleanText(error?.message || error, 240));
    if (res.headersSent) return res.end();
    return sendError(res, 500, cleanText(error?.message || 'حدث خطأ غير متوقع في الموقع.', 260));
  }
};
