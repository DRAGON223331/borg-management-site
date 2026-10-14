'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { notifyReview } = require('./_lib/notify.js');

const DISCORD_API = 'https://discord.com/api/v10';
const COOKIE_NAME = 'borg.sid';
const OAUTH_COOKIE = 'borg.oauth';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
const MANAGER_IDS = new Set((process.env.MANAGER_IDS || '1286035404323164172,1525203473262706821,848304089057460254,1475483362536980552').split(',').map((x) => x.trim()).filter(Boolean));
const MAIN_GUILD_ID = process.env.MAIN_GUILD_ID || '883871561474539630';
const STAFF_GUILD_ID = process.env.STAFF_GUILD_ID || '1556647204255568063';
const MANAGEMENT_MAIN_ROLE_ID = process.env.MANAGEMENT_MAIN_ROLE_ID || '1538623033806168135';
const MANAGEMENT_STAFF_ROLE_ID = process.env.MANAGEMENT_STAFF_ROLE_ID || '1559628523809804288';
const TASKS_CHANNEL_ID = process.env.TASKS_CHANNEL_ID || '1556647204960346215';
const TASK_PING_ROLE_ID = (process.env.TASK_PING_ROLE_ID || '1556647362062188544').trim(); // رتبة بتتمنشن مع كل مهمات جديدة
const TASK_SUBMISSIONS_CHANNEL_ID = process.env.TASK_SUBMISSIONS_CHANNEL_ID || '1556651404154642504';
const TASK_APPROVED_CHANNEL_ID = (process.env.TASK_APPROVED_CHANNEL_ID || process.env.TASK_SUBMISSIONS_CHANNEL_ID || '1556651404154642504').trim(); // روم رسالة "المهمة اتقبلت" العادية
const POINTS_LOG_CHANNEL_ID = process.env.POINTS_LOG_CHANNEL_ID || '1559598706871767172';
const SUBMISSION_REVIEW_CHANNEL_ID = '1556945732957765722';
const LEAVE_REQUEST_CHANNEL_ID = '1556945732957765722'; // ثابت: روم طلبات الإجازة ومراجعتها
const STAFF_REQUEST_CHANNEL_ID = process.env.STAFF_REQUEST_CHANNEL_ID || '1558102515885678734'; // روم الطلبات الإدارية الأخرى
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
const SCHEMA_VERSION = 3; // ارفعه كل ما تضيف جدول/عمود جديد في ensureSchema
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
function canManage(user) { return Boolean(user && (user.isManager || user.isAdmin)); }
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
    await sql`CREATE TABLE IF NOT EXISTS staff_points (id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, amount NUMERIC(10,2) NOT NULL, reason TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', submission_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await sql`CREATE INDEX IF NOT EXISTS idx_staff_points_user ON staff_points(user_id, created_at DESC)`;
    await sql`CREATE TABLE IF NOT EXISTS submission_tasks (
      submission_id BIGINT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (submission_id, task_id)
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_submission_tasks_task ON submission_tasks(task_id)`;
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
    throw new Error(cleanText(message, 240));
  }
  return payload;
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
// رسالة عادية (مش Embed) بعد قبول التسليم: مين عمل المهمة + مين قبلها + الصور/الفيديوهات المرفقة.
async function postApprovedSubmissionMessage({ req, submissionId, sub, reviewer, taskRows }) {
  const files = parseJson(sub.files_json, []);
  const { attachments, linkOnly } = await loadEvidenceAttachments(req, files);
  const tasksLine = taskRows.map((t) => `**${cleanText(t.title, 120)}**`).join('، ').slice(0, 600) || 'مهمة';
  let content = `✅ **تم قبول مهمة**\n📋 **المهمة:** ${tasksLine}\n👤 **اللي عملها:** <@${sub.user_id}>\n🛡️ **اللي قبلها:** <@${reviewer.id}>`;
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
      const isManager = MANAGER_IDS.has(discordUser.id);
      const hasAdmin = (guild) => { try { return (BigInt(guild?.permissions || 0) & 8n) === 8n; } catch { return false; } };
      const memberLookups = await Promise.allSettled([discordApi(`/guilds/${MAIN_GUILD_ID}/members/${discordUser.id}`), discordApi(`/guilds/${STAFF_GUILD_ID}/members/${discordUser.id}`)]);
      const mainMemberData = memberLookups[0].status === 'fulfilled' ? memberLookups[0].value : null;
      const staffMemberData = memberLookups[1].status === 'fulfilled' ? memberLookups[1].value : null;
      // The configured management roles also grant management access, matching the standalone server.
      const hasManagementRole = Boolean(
        (mainMemberData?.roles || []).includes(MANAGEMENT_MAIN_ROLE_ID) ||
        (staffMemberData?.roles || []).includes(MANAGEMENT_STAFF_ROLE_ID)
      );
      const isAdmin = hasAdmin(staffGuild) || hasAdmin(mainGuild) || hasManagementRole;
      if (!staffGuild && !isAdmin && !isManager) {
        res.setHeader('Set-Cookie', clearCookie(OAUTH_COOKIE));
        return sendText(res, 403, `الحساب ده مش عضو في سيرفر الاستاف، ومش معاه صلاحية Administrator في السيرفر الأساسي. ادخل سيرفر الاستاف (${STAFF_GUILD_ID}) ثم جرّب تاني.`);
      }
      const user = {
        id: discordUser.id,
        username: discordUser.global_name || discordUser.username,
        handle: discordUser.username,
        avatar: discordUser.avatar || null,
        avatarUrl: avatarUrl(discordUser),
        isAdmin,
        isManager,
        isStaffGuildMember: Boolean(staffGuild),
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
      // Keep the roster and admin analytics aligned: explicit manager IDs or actual Administrator permission only.
      isAdmin: MANAGER_IDS.has(member.user.id) || (member.roles || []).some((roleId) => { const role = staffRoleById.get(roleId); try { return (BigInt(role?.permissions || 0) & 8n) === 8n; } catch { return false; } }) || assigned.some((role) => { try { return (BigInt(role.permissions || 0) & 8n) === 8n; } catch { return false; } }),
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

async function handleApi(parts, req, res) {
  const route = parts[0] || '';
  const user = getSessionUser(req);
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
    return sendJson(res, 200, { authenticated: true, user: { ...user, canManage: canManage(user) } });
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
  if (route === 'evidence') return sendPrivateEvidence(req, res);
  if (route === 'uploads' && parts[1] === 'token') return handleUploadToken(req, res);
  if (!user) return sendError(res, 401, 'سجل دخولك بديسكورد أولًا.');

  if (route === 'register-commands' && req.method === 'GET') {
    if (!canManage(user)) return sendError(res, 403, 'متاح لمسؤولي الإدارة فقط.');
    return sendJson(res, 200, { ok: true, commands: await registerSlashCommands() });
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
    const rows = await sql`SELECT id, title, points, required, active, created_by_name, created_at FROM tasks WHERE active = TRUE ORDER BY required DESC, id DESC`;
    const completedRows = await sql`SELECT DISTINCT st.task_id FROM submission_tasks st JOIN submissions s ON s.id = st.submission_id WHERE s.user_id = ${user.id} AND s.status = 'approved'`;
    const completed = new Set(completedRows.map((row) => String(row.task_id)));
    const pendingRows = await sql`SELECT DISTINCT st.task_id FROM submission_tasks st JOIN submissions s ON s.id = st.submission_id WHERE s.user_id = ${user.id} AND s.status = 'pending'`;
    const pending = new Set(pendingRows.map((row) => String(row.task_id)));
    const rejectedRows = await sql`SELECT DISTINCT st.task_id FROM submission_tasks st JOIN submissions s ON s.id = st.submission_id WHERE s.user_id = ${user.id} AND s.status = 'rejected'`;
    const rejected = new Set(rejectedRows.map((row) => String(row.task_id)));
    const tasks = rows.map((row) => ({ id: Number(row.id), title: row.title, points: Number(row.points || 0), required: Boolean(row.required), active: Boolean(row.active), created_by_name: row.created_by_name, created_at: row.created_at, completedByMe: completed.has(String(row.id)), pendingByMe: !completed.has(String(row.id)) && pending.has(String(row.id)), rejectedByMe: !completed.has(String(row.id)) && !pending.has(String(row.id)) && rejected.has(String(row.id)) }));
    const required = tasks.filter((task) => task.required);
    return sendJson(res, 200, { tasks, stats: { active: tasks.length, required: required.length, completedRequired: required.filter((task) => task.completedByMe).length, completedByMe: tasks.filter((task) => task.completedByMe).length } });
  }
  if (route === 'tasks' && parts.length === 1 && req.method === 'POST') {
    if (!canManage(user)) return sendError(res, 403, 'الصلاحية دي للمسؤولين فقط.');
    const raw = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
    if (!raw.length || raw.length > 40) return sendError(res, 400, 'أضف من مهمة واحدة إلى 40 مهمة في المرة الواحدة.');
    const tasks = raw.map((item) => { const points = Number(typeof item === 'string' ? 1 : (item?.points ?? 1)); return { title: cleanText(typeof item === 'string' ? item : item?.title, 240), required: typeof item === 'string' ? false : Boolean(item?.required), points: Number.isFinite(points) && points >= 0 && points <= 100000 && Math.round(points * 100) / 100 === points ? Math.round(points * 100) / 100 : NaN }; }).filter((task) => task.title);
    if (tasks.some((task) => !Number.isFinite(task.points))) return sendError(res, 400, 'عدد النقاط لازم يكون رقمًا من 0 إلى 100000، ويسمح بالكسور مثل 0.1.');
    if (!tasks.length) return sendError(res, 400, 'اكتب اسم مهمة صحيح.');
    const created = [];
    for (const task of tasks) {
      const rows = await sql`INSERT INTO tasks(title, points, required, active, created_by, created_by_name, created_at) VALUES (${task.title}, ${task.points}, ${task.required}, TRUE, ${user.id}, ${user.username}, NOW()) RETURNING id`;
      created.push({ id: Number(rows[0].id), ...task });
    }
    let discordPosted = false;
    let warning = '';
    try {
      const lines = created.map((task) => `• [${task.required ? 'إجباري' : 'اختياري'}] #${task.id} — ${task.title} [${formatPoints(task.points)} نقطة]`);
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
    const taskIdsInput = Array.isArray(req.body?.taskIds) ? req.body.taskIds : [];
    const taskIds = [...new Set(taskIdsInput.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 40);
    if (!taskIds.length) return sendError(res, 400, 'اختار مهمة واحدة على الأقل.');
    const activeTasks = await sql`SELECT id, title, points, required FROM tasks WHERE active = TRUE`;
    const byId = new Map(activeTasks.map((row) => [Number(row.id), row]));
    const foundTasks = taskIds.map((id) => byId.get(id)).filter(Boolean);
    if (foundTasks.length !== taskIds.length) return sendError(res, 400, 'في مهمة من اللي اخترتها مش موجودة أو اتقفلت. حدّث الصفحة وجرب تاني.');
    // المهمة اللي اتسلمت قبل كده (اتقبلت أو اترفضت أو لسه بتتراجع) لنفس العضو ميقدرش يسلمها تاني.
    const lockedRows = await sql`SELECT st.task_id, s.status FROM submission_tasks st JOIN submissions s ON s.id = st.submission_id WHERE s.user_id = ${user.id} AND s.status IN ('approved','pending','rejected') AND st.task_id = ANY(${taskIds})`;
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
      files.push({ pathname, token: crypto.randomBytes(24).toString('base64url'), originalName, mimeType: realType, size });
    }
    if (!links.length && !files.length) return sendError(res, 400, 'ضيف رابط دليل أو ارفع صورة/فيديو قبل الإرسال.');
    const note = cleanText(req.body?.note, 600);
    const inserted = await sql`INSERT INTO submissions(user_id, username, avatar_url, note, evidence_links, files_json, submitted_at, status)
      VALUES (${user.id}, ${user.username}, ${user.avatarUrl || null}, ${note}, ${JSON.stringify(links)}::jsonb, ${JSON.stringify(files)}::jsonb, NOW(), 'pending') RETURNING id, submitted_at`;
    const submissionId = Number(inserted[0].id);
    for (const taskId of taskIds) await sql`INSERT INTO submission_tasks(submission_id, task_id) VALUES (${submissionId}, ${taskId}) ON CONFLICT DO NOTHING`;
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
    try {
      const embed = {
        title: `📨 دليل مهمة جديد #${submissionId}`,
        description: 'وصل دليل جديد من عضو الاستاف، والتسليم بانتظار مراجعة المسؤولين.\n\n**بعد المراجعة، تتم الموافقة أو الرفض من لوحة الموقع.**',
        color: 0x5865F2,
        fields: [
          { name: '👤 العضو', value: `<@${user.id}>\n\`${user.id}\``, inline: true },
          { name: '🧾 رقم التسليم', value: `#${submissionId}`, inline: true },
          { name: `🎯 المهمة المحددة (${foundTasks.length})`, value: taskText, inline: false },
          { name: '📎 ملفات الدليل', value: fileText, inline: false },
          { name: links.length ? '🔗 روابط إضافية ⚠️ (من العضو، متفتحهاش إلا لو موثوقة)' : '🔗 روابط إضافية', value: linkText, inline: false },
          ...(note ? [{ name: '📝 ملاحظة العضو', value: note.slice(0, 1024), inline: false }] : []),
        ],
        timestamp: new Date().toISOString(),
        footer: { text: 'إدارة البرج • مراجعة أدلة المهمات' },
        ...(user.avatarUrl ? { thumbnail: { url: user.avatarUrl } } : {}),
      };
      const firstImage = evidence.attachments.find((file) => file.type.startsWith('image/'));
      if (firstImage) embed.image = { url: `attachment://${firstImage.name}` };
      await postDiscordWithFiles(SUBMISSION_REVIEW_CHANNEL_ID, { embeds: [embed], allowed_mentions: { parse: [] } }, evidence.attachments);
      discordPosted = true;
    } catch (error) { warning = cleanText(error.message, 220); console.error('[submission post]', warning); }
    try { await postDiscordMessage(TASK_SUBMISSIONS_CHANNEL_ID, `📨 تسليم جديد #${submissionId} من <@${user.id}> — بانتظار الموافقة. لا تُضاف النقاط إلا بعد اعتماد المسؤولين.`); } catch {}
    return sendJson(res, 201, { ok: true, submissionId, discordPosted, warning, message: discordPosted ? 'اتسجل تسليم المهمة واترسل لروم التسليم.' : 'اتسجل التسليم في الموقع، لكن البوت لم يستطع إرساله لروم التسليم.' });
  }

  if (route === 'submissions' && parts.length === 1 && req.method === 'GET') {
    const rows = canManage(user)
      ? await sql`SELECT * FROM submissions ORDER BY id DESC LIMIT 80`
      : await sql`SELECT * FROM submissions WHERE user_id = ${user.id} ORDER BY id DESC LIMIT 40`;
    const ids = rows.map((row) => Number(row.id));
    let taskRows = [];
    if (ids.length) {
      const placeholders = ids.map((_, index) => `$${index + 1}`).join(', ');
      taskRows = await sql.query(`SELECT st.submission_id, t.id, t.title, t.points, t.required FROM submission_tasks st JOIN tasks t ON t.id = st.task_id WHERE st.submission_id IN (${placeholders}) ORDER BY t.required DESC, t.id`, ids);
    }
    const tasksBySubmission = new Map();
    for (const row of taskRows) {
      const key = Number(row.submission_id);
      if (!tasksBySubmission.has(key)) tasksBySubmission.set(key, []);
      tasksBySubmission.get(key).push({ id: Number(row.id), title: row.title, points: Number(row.points || 0), required: Boolean(row.required) });
    }
    const submissions = rows.map((row) => {
      const files = parseJson(row.files_json, []).map((file) => ({ ...file, url: `/api/evidence?token=${encodeURIComponent(file.token)}` }));
      return { id: Number(row.id), userId: row.user_id, username: row.username, avatarUrl: row.avatar_url, note: row.note, evidenceLinks: parseJson(row.evidence_links, []), files, submittedAt: row.submitted_at, status: row.status, tasks: tasksBySubmission.get(Number(row.id)) || [] };
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
    if (sub.status !== 'pending') return sendError(res, 409, 'تمت مراجعة التسليم بالفعل.');
    if (parts[2] === 'reject') {
      const reason = cleanText(req.body?.reason, 300);
      const rejected = await sql`UPDATE submissions SET status = 'rejected', reviewed_by = ${user.id}, reviewed_at = NOW() WHERE id = ${id} AND status = 'pending' RETURNING id`;
      if (!rejected.length) return sendError(res, 409, 'تمت مراجعة التسليم بالفعل.');
      const dmPromise = notifyReview({ token: BOT_TOKEN, userId: sub.user_id, kind: 'submission', status: 'rejected', id, reviewerId: user.id, note: reason });
      try {
        await postDiscordEmbed(POINTS_LOG_CHANNEL_ID, {
          title: '❌ تم رفض تسليم مهمة',
          description: `تم رفض التسليم **#${id}**، ولم تتم إضافة أي نقاط إلى رصيد العضو.`,
          color: 0xEF4444,
          fields: [
            { name: '👤 العضو', value: `<@${sub.user_id}>`, inline: true },
            { name: '🛡️ المسؤول', value: `<@${user.id}>`, inline: true },
            { name: '📝 سبب الرفض', value: (reason || 'لم يتم تحديد سبب').slice(0, 1024), inline: false },
          ],
          footer: { text: 'Borg Management • Task Review' },
          timestamp: new Date().toISOString(),
        });
      } catch (e) { console.error('[submission reject log]', cleanText(e.message, 180)); }
      const dm = await dmPromise;
      return sendJson(res, 200, { ok: true, status: 'rejected', dmSent: dm.ok, message: `تم رفض التسليم.${dmNote(dm)}` });
    }
    const taskRows = await sql`SELECT t.id, t.title, t.points FROM submission_tasks st JOIN tasks t ON t.id = st.task_id WHERE st.submission_id = ${id}`;
    const amount = Math.round(taskRows.reduce((sum, t) => sum + Number(t.points || 0), 0) * 100) / 100;
    const marked = await sql`UPDATE submissions SET status = 'approved', reviewed_by = ${user.id}, reviewed_at = NOW() WHERE id = ${id} AND status = 'pending' RETURNING id`;
    if (!marked.length) return sendError(res, 409, 'تمت مراجعة التسليم بالفعل.');
    if (amount > 0) await sql`INSERT INTO staff_points(user_id, username, amount, reason, actor_id, actor_name, source, submission_id, created_at) VALUES (${sub.user_id}, ${sub.username}, ${amount}, ${`اعتماد تسليم #${id}`}, ${user.id}, ${user.username}, 'task', ${id}, NOW())`;
    const totalAfterRows = await sql`SELECT COALESCE(SUM(amount),0) AS total FROM staff_points WHERE user_id = ${sub.user_id}`;
    const totalAfter = Number(totalAfterRows[0]?.total || 0);
    const taskSummary = taskRows.map(t => `• **${cleanText(t.title, 180)}** — ${formatPoints(t.points)} نقطة`).join('\n').slice(0, 1024) || 'لا توجد مهمات مرتبطة بالتسليم.';
    try {
      await postDiscordEmbed(POINTS_LOG_CHANNEL_ID, {
        title: '✅ اعتماد تسليم مهمة وإضافة النقاط',
        description: `تمت مراجعة التسليم **#${id}** واعتماده بواسطة الإدارة.`,
        color: 0x22C55E,
        fields: [
          { name: '👤 العضو', value: `<@${sub.user_id}>`, inline: true },
          { name: '💎 النقاط المضافة', value: `**+${formatPoints(amount)} نقطة**`, inline: true },
          { name: '📊 الرصيد بعد الاعتماد', value: `**${formatPoints(totalAfter)} نقطة**`, inline: true },
          { name: '🛡️ المسؤول', value: `<@${user.id}>`, inline: true },
          { name: '📋 تفاصيل المهمات والنقاط', value: taskSummary, inline: false },
        ],
        footer: { text: 'Borg Management • Task Review' },
        timestamp: new Date().toISOString(),
      });
    } catch (e) { console.error('[submission approve log]', cleanText(e.message, 180)); }
    try { await postApprovedSubmissionMessage({ req, submissionId: id, sub, reviewer: user, taskRows }); } catch (e) { console.error('[submission approved message]', cleanText(e.message, 200)); }
    const dm = await notifyReview({ token: BOT_TOKEN, userId: sub.user_id, kind: 'submission', status: 'approved', id, reviewerId: user.id, fields: [
      { name: '💎 النقاط المضافة', value: `**+${formatPoints(amount)} نقطة**`, inline: true },
      { name: '📊 رصيدك الحالي', value: `**${formatPoints(totalAfter)} نقطة**`, inline: true },
      { name: '📋 المهمات', value: taskSummary, inline: false },
    ] });
    return sendJson(res, 200, { ok: true, status: 'approved', awarded: amount, dmSent: dm.ok, message: `تم اعتماد التسليم وإضافة ${formatPoints(amount)} نقطة.${dmNote(dm)}` });
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
    if (after !== null) {
      const fresh = await sql`SELECT * FROM chat_messages WHERE room = ${room} AND id > ${after} ORDER BY id ASC LIMIT 100`;
      return sendJson(res, 200, { messages: fresh.map(mapMessage), incremental: true });
    }
    const rows = await sql`SELECT * FROM (SELECT * FROM chat_messages WHERE room = ${room} ORDER BY id DESC LIMIT 100) AS recent ORDER BY id ASC`;
    if (room === 'staff') await syncChannelMessageCounts(sql, { budgetMs: 4000 });
    const dailyStats = room === 'staff' ? await getDailyStaffMessageStats(sql) : {};
    return sendJson(res, 200, { messages: rows.map(mapMessage), ...dailyStats });
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
    if (parts[0] === 'uploads' && parts[1] === 'token') return await handleUploadToken(req, res);
    if (parts[0] === 'evidence') return await sendPrivateEvidence(req, res);
    return await handleApi(parts, req, res);
  } catch (error) {
    console.error('[vercel handler]', cleanText(error?.message || error, 240));
    if (res.headersSent) return res.end();
    return sendError(res, 500, cleanText(error?.message || 'حدث خطأ غير متوقع في الموقع.', 260));
  }
};
