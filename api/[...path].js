'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const DISCORD_API = 'https://discord.com/api/v10';
const COOKIE_NAME = 'borg.sid';
const OAUTH_COOKIE = 'borg.oauth';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
const MANAGER_IDS = new Set((process.env.MANAGER_IDS || '1286035404323164172,1525203473262706821,848304089057460254,1475483362536980552').split(',').map((x) => x.trim()).filter(Boolean));
const MAIN_GUILD_ID = process.env.MAIN_GUILD_ID || '883871561474539630';
const STAFF_GUILD_ID = process.env.STAFF_GUILD_ID || '1556647204255568063';
const TASKS_CHANNEL_ID = process.env.TASKS_CHANNEL_ID || '1556647204960346215';
const TASK_SUBMISSIONS_CHANNEL_ID = process.env.TASK_SUBMISSIONS_CHANNEL_ID || '1556651404154642504';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1559176035432402976';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const COOKIE_SECRET = process.env.SESSION_SECRET || '';
const MAX_UPLOAD_MB = Math.max(1, Number(process.env.MAX_UPLOAD_MB || 100));

let sqlClient;
let schemaPromise;
let blobSdkPromise;
let blobClientSdkPromise;
let neonSdkPromise;
let lastTaskSyncAt = 0;
let taskSyncPromise;

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
function canReadRoom(user, room) { return Boolean(user && (room === 'staff' || user.isManager)); }
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
    await sql`CREATE TABLE IF NOT EXISTS tasks (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
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
  })();
  return schemaPromise;
}
async function discordApi(route, options = {}) {
  if (!BOT_TOKEN) throw new Error('توكن البوت غير مضبوط في Environment Variables على Vercel.');
  const response = await fetch(`${DISCORD_API}${route}`, {
    ...options,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
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
    if (taskMatch) {
      const tag = (taskMatch[1] || '').toLowerCase();
      title = taskMatch[2].trim();
      required = ['إجباري', 'اجباري', 'required', 'mandatory'].includes(tag);
    } else if (explicitMatch) {
      title = explicitMatch[1].trim();
      required = /^\[(?:إجباري|اجباري|required|mandatory)\]/i.test(title);
      title = title.replace(/^\[(?:إجباري|اجباري|required|mandatory|اختياري|optional)\]\s*/i, '');
    } else continue;
    title = cleanText(title.replace(/^#\d+\s*[—–-]\s*/, '').replace(/^#\d+\s+/, ''), 240);
    if (title && !/^(?:مهمات جديدة|المهمات|المهام|إدارة البرج)$/i.test(title)) tasks.push({ title, required });
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
        await sql`INSERT INTO tasks (title, required, active, created_by, created_by_name, created_at, source_message_id, source_line_index)
          VALUES (${task.title}, ${task.required}, TRUE, ${message.author?.id || 'discord-system'}, ${message.author?.global_name || message.author?.username || 'Discord'}, NOW(), ${message.id}, ${index})
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
async function postDiscordMessage(channelId, content) {
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
      method: 'POST', body: JSON.stringify({ content: part.slice(0, 1990), allowed_mentions: { parse: [] } }),
    });
  }
  return last;
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
      const isAdmin = hasAdmin(staffGuild) || hasAdmin(mainGuild);
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

async function handleUploadToken(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'الطريقة غير مدعومة.');
  if (!blobClientSdkPromise) blobClientSdkPromise = import('@vercel/blob/client');
  const { handleUpload } = await blobClientSdkPromise;
  const body = req.body || {};
  try {
    const result = await handleUpload({
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
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // Files are attached to a submission in /api/submissions; abandoned uploads can be removed from Blob storage later.
        if (!blob?.pathname || !tokenPayload) throw new Error('تعذر تأكيد رفع الملف.');
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
  const result = await get(file.pathname, { access: 'private' });
  if (!result || result.statusCode !== 200 || !result.stream) return sendError(res, 404, 'الملف غير موجود في التخزين.');
  res.statusCode = 200;
  res.setHeader('Content-Type', file.mimeType || result.blob.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${String(file.mimeType || '').startsWith('image/') || String(file.mimeType || '').startsWith('video/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.originalName || 'evidence-file')}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  Readable.fromWeb(result.stream).pipe(res);
}

async function getRoster() {
  const [guild, roles, firstPage] = await Promise.all([
    discordApi(`/guilds/${STAFF_GUILD_ID}`),
    discordApi(`/guilds/${STAFF_GUILD_ID}/roles`),
    discordApi(`/guilds/${STAFF_GUILD_ID}/members?limit=1000`),
  ]);
  const members = Array.isArray(firstPage) ? [...firstPage] : [];
  let after = members.length ? members[members.length - 1].user?.id : null;
  for (let guard = 0; members.length % 1000 === 0 && members.length > 0 && guard < 20; guard += 1) {
    const next = await discordApi(`/guilds/${STAFF_GUILD_ID}/members?limit=1000&after=${after}`);
    if (!Array.isArray(next) || !next.length) break;
    members.push(...next);
    after = next[next.length - 1].user?.id;
    if (next.length < 1000) break;
  }
  const sortedRoles = roles.filter((role) => role.id !== STAFF_GUILD_ID).sort((a, b) => b.position - a.position || a.name.localeCompare(b.name, 'ar'));
  const roleById = new Map(sortedRoles.map((role) => [role.id, role]));
  const groupMembers = new Map();
  const noRole = [];
  const toHex = (value) => `#${Math.max(0, Number(value) || 0).toString(16).padStart(6, '0').slice(-6)}`;
  const rows = members.filter((member) => member.user && !member.user.bot).map((member) => {
    const assigned = (member.roles || []).map((id) => roleById.get(id)).filter(Boolean).sort((a, b) => b.position - a.position);
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
      username: member.user.global_name || member.nick || member.user.username,
      handle: member.user.username,
      avatarUrl: avatar,
      roleName: highest?.name || 'بدون رتبة',
      roleId: highest?.id || 'none',
      rolePosition: highest?.position ?? -1,
      roleColor: highest ? toHex(highest.color) : '#64748b',
      roles: assigned.map((role) => ({ id: role.id, name: role.name, position: role.position, color: toHex(role.color) })),
    };
    if (highest && roleById.has(highest.id)) {
      if (!groupMembers.has(highest.id)) groupMembers.set(highest.id, []);
      groupMembers.get(highest.id).push(row);
    } else noRole.push(row);
    return row;
  });
  for (const group of groupMembers.values()) group.sort((a, b) => a.username.localeCompare(b.username, 'ar'));
  noRole.sort((a, b) => a.username.localeCompare(b.username, 'ar'));
  const groups = sortedRoles.map((role) => ({ id: role.id, name: role.name, position: role.position, color: toHex(role.color), members: groupMembers.get(role.id) || [] })).filter((group) => group.members.length);
  if (noRole.length) groups.push({ id: 'none', name: 'بدون رتبة', position: -1, color: '#64748b', members: noRole });
  return { guildName: guild.name, memberCount: rows.length, groups };
}

async function handleApi(parts, req, res) {
  const route = parts[0] || '';
  const user = getSessionUser(req);
  if (req.method !== 'GET' && !ensureSameOrigin(req, res)) return;
  if (route === 'health' && req.method === 'GET') {
    let botReady = Boolean(BOT_TOKEN);
    let botLastError = botReady ? '' : 'توكن البوت غير مضبوط.';
    if (botReady) {
      try { await discordApi('/users/@me'); }
      catch (error) { botReady = false; botLastError = cleanText(error.message, 200); }
    }
    return sendJson(res, 200, { ok: true, botReady, botLastError, storageReady: Boolean(process.env.BLOB_READ_WRITE_TOKEN), databaseReady: Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_PRISMA_URL) });
  }
  if (route === 'me' && req.method === 'GET') {
    if (!user) return sendJson(res, 200, { authenticated: false });
    return sendJson(res, 200, { authenticated: true, user: { ...user, canManage: canManage(user) } });
  }
  if (route === 'evidence') return sendPrivateEvidence(req, res);
  if (route === 'uploads' && parts[1] === 'token') return handleUploadToken(req, res);
  if (!user) return sendError(res, 401, 'سجل دخولك بديسكورد أولًا.');

  if (route === 'roster' && req.method === 'GET') {
    try { return sendJson(res, 200, await getRoster()); }
    catch (error) { console.error('[roster]', cleanText(error.message, 200)); return sendError(res, 503, `تعذر تحميل قائمة الاستاف: ${cleanText(error.message, 200)}`); }
  }

  await ensureSchema();
  const sql = await getSql();

  if (route === 'tasks' && parts.length === 1 && req.method === 'GET') {
    await syncDiscordTasks(sql);
    const rows = await sql`SELECT id, title, required, active, created_by_name, created_at FROM tasks WHERE active = TRUE ORDER BY required DESC, id DESC`;
    const completedRows = await sql`SELECT DISTINCT st.task_id FROM submission_tasks st JOIN submissions s ON s.id = st.submission_id WHERE s.user_id = ${user.id} AND s.status = 'submitted'`;
    const completed = new Set(completedRows.map((row) => String(row.task_id)));
    const tasks = rows.map((row) => ({ id: Number(row.id), title: row.title, required: Boolean(row.required), active: Boolean(row.active), created_by_name: row.created_by_name, created_at: row.created_at, completedByMe: completed.has(String(row.id)) }));
    const required = tasks.filter((task) => task.required);
    return sendJson(res, 200, { tasks, stats: { active: tasks.length, required: required.length, completedRequired: required.filter((task) => task.completedByMe).length, completedByMe: tasks.filter((task) => task.completedByMe).length } });
  }
  if (route === 'tasks' && parts.length === 1 && req.method === 'POST') {
    if (!canManage(user)) return sendError(res, 403, 'الصلاحية دي للمسؤولين فقط.');
    const raw = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
    if (!raw.length || raw.length > 40) return sendError(res, 400, 'أضف من مهمة واحدة إلى 40 مهمة في المرة الواحدة.');
    const tasks = raw.map((item) => ({ title: cleanText(typeof item === 'string' ? item : item?.title, 240), required: typeof item === 'string' ? false : Boolean(item?.required) })).filter((task) => task.title);
    if (!tasks.length) return sendError(res, 400, 'اكتب اسم مهمة صحيح.');
    const created = [];
    for (const task of tasks) {
      const rows = await sql`INSERT INTO tasks(title, required, active, created_by, created_by_name, created_at) VALUES (${task.title}, ${task.required}, TRUE, ${user.id}, ${user.username}, NOW()) RETURNING id`;
      created.push({ id: Number(rows[0].id), ...task });
    }
    let discordPosted = false;
    let warning = '';
    try {
      const lines = created.map((task) => `• [${task.required ? 'إجباري' : 'اختياري'}] #${task.id} — ${task.title}`);
      let batch = [];
      let charCount = '📋 مهمات جديدة | إدارة البرج\n'.length;
      const batches = [];
      for (const line of lines) {
        if (batch.length && charCount + line.length + 1 > 1750) { batches.push(batch); batch = []; charCount = '📋 مهمات جديدة | إدارة البرج\n'.length; }
        batch.push(line); charCount += line.length + 1;
      }
      if (batch.length) batches.push(batch);
      for (const items of batches) {
        const message = await postDiscordMessage(TASKS_CHANNEL_ID, `📋 **مهمات جديدة | إدارة البرج**\n${items.join('\n')}`);
        const matchIds = items.map((line) => Number(line.match(/#(\d+)/)?.[1])).filter(Number.isInteger);
        for (let i = 0; i < matchIds.length; i += 1) await sql`UPDATE tasks SET source_message_id = ${message.id}, source_line_index = ${i} WHERE id = ${matchIds[i]}`;
      }
      discordPosted = true;
    } catch (error) { warning = cleanText(error.message, 220); console.error('[task post]', warning); }
    return sendJson(res, 201, { created, discordPosted, warning, message: discordPosted ? 'تم إنشاء المهمات ونشرها في روم المهمات.' : 'تم حفظ المهمات في الموقع، لكن البوت لم يستطع نشرها في ديسكورد.' });
  }
  if (route === 'tasks' && parts.length === 2 && req.method === 'PATCH') {
    if (!canManage(user)) return sendError(res, 403, 'الصلاحية دي للمسؤولين فقط.');
    const id = Number(parts[1]);
    if (!Number.isSafeInteger(id) || id < 1) return sendError(res, 400, 'رقم المهمة غير صالح.');
    const found = await sql`SELECT id FROM tasks WHERE id = ${id} AND active = TRUE`;
    if (!found.length) return sendError(res, 404, 'المهمة مش موجودة أو اتقفلت.');
    const updates = [];
    if (typeof req.body?.required === 'boolean') updates.push({ field: 'required', value: req.body.required });
    if (typeof req.body?.active === 'boolean') updates.push({ field: 'active', value: req.body.active });
    if (!updates.length) return sendError(res, 400, 'مفيش تعديل صالح.');
    for (const item of updates) {
      if (item.field === 'required') await sql`UPDATE tasks SET required = ${item.value} WHERE id = ${id}`;
      if (item.field === 'active') await sql`UPDATE tasks SET active = ${item.value} WHERE id = ${id}`;
    }
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'submissions' && parts.length === 1 && req.method === 'POST') {
    const taskIdsInput = Array.isArray(req.body?.taskIds) ? req.body.taskIds : [];
    const taskIds = [...new Set(taskIdsInput.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 40);
    if (!taskIds.length) return sendError(res, 400, 'اختار مهمة واحدة على الأقل.');
    const activeTasks = await sql`SELECT id, title, required FROM tasks WHERE active = TRUE`;
    const byId = new Map(activeTasks.map((row) => [Number(row.id), row]));
    const foundTasks = taskIds.map((id) => byId.get(id)).filter(Boolean);
    if (foundTasks.length !== taskIds.length) return sendError(res, 400, 'في مهمة من اللي اخترتها مش موجودة أو اتقفلت. حدّث الصفحة وجرب تاني.');
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
      files.push({ pathname, token: crypto.randomBytes(24).toString('base64url'), originalName, mimeType, size });
    }
    if (!links.length && !files.length) return sendError(res, 400, 'ضيف رابط دليل أو ارفع صورة/فيديو قبل الإرسال.');
    const note = cleanText(req.body?.note, 600);
    const inserted = await sql`INSERT INTO submissions(user_id, username, avatar_url, note, evidence_links, files_json, submitted_at, status)
      VALUES (${user.id}, ${user.username}, ${user.avatarUrl || null}, ${note}, ${JSON.stringify(links)}::jsonb, ${JSON.stringify(files)}::jsonb, NOW(), 'submitted') RETURNING id, submitted_at`;
    const submissionId = Number(inserted[0].id);
    for (const taskId of taskIds) await sql`INSERT INTO submission_tasks(submission_id, task_id) VALUES (${submissionId}, ${taskId}) ON CONFLICT DO NOTHING`;
    const base = siteUrl(req);
    const taskText = foundTasks.map((task) => `• ${task.required ? '🔴 إجباري' : '⚪ اختياري'} — **${task.title}**`).join('\n');
    const fileText = files.map((file) => `• [${file.originalName}](${base}/api/evidence?token=${encodeURIComponent(file.token)})`).join('\n') || 'لا توجد ملفات مرفوعة.';
    const linkText = links.map((link) => `• ${link}`).join('\n') || 'لا توجد روابط خارجية.';
    let discordPosted = false;
    let warning = '';
    try {
      const content = [
        `📨 **تسليم مهمة جديد #${submissionId}**`,
        `**العضو:** <@${user.id}> (${user.username})`,
        `**المهمات المنجزة (${foundTasks.length}):**`, taskText,
        note ? `**ملاحظة:** ${note}` : '',
        '**روابط الأدلة:**', linkText,
        '**الملفات الخاصة:**', fileText,
        `**التاريخ:** <t:${Math.floor(Date.now() / 1000)}:F>`,
      ].filter(Boolean).join('\n');
      await postDiscordMessage(TASK_SUBMISSIONS_CHANNEL_ID, content);
      discordPosted = true;
    } catch (error) { warning = cleanText(error.message, 220); console.error('[submission post]', warning); }
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
      taskRows = await sql.query(`SELECT st.submission_id, t.id, t.title, t.required FROM submission_tasks st JOIN tasks t ON t.id = st.task_id WHERE st.submission_id IN (${placeholders}) ORDER BY t.required DESC, t.id`, ids);
    }
    const tasksBySubmission = new Map();
    for (const row of taskRows) {
      const key = Number(row.submission_id);
      if (!tasksBySubmission.has(key)) tasksBySubmission.set(key, []);
      tasksBySubmission.get(key).push({ id: Number(row.id), title: row.title, required: Boolean(row.required) });
    }
    const submissions = rows.map((row) => {
      const files = parseJson(row.files_json, []).map((file) => ({ ...file, url: `/api/evidence?token=${encodeURIComponent(file.token)}` }));
      return { id: Number(row.id), userId: row.user_id, username: row.username, avatarUrl: row.avatar_url, note: row.note, evidenceLinks: parseJson(row.evidence_links, []), files, submittedAt: row.submitted_at, status: row.status, tasks: tasksBySubmission.get(Number(row.id)) || [] };
    });
    return sendJson(res, 200, { submissions });
  }

  if (route === 'chat' && parts.length === 2 && req.method === 'GET') {
    const room = parts[1];
    if (!['staff', 'management'].includes(room)) return sendError(res, 404, 'غرفة الشات مش موجودة.');
    if (!canReadRoom(user, room)) return sendError(res, 403, 'الشات ده مخصص للمسؤولين.');
    const rows = await sql`SELECT * FROM (SELECT * FROM chat_messages WHERE room = ${room} ORDER BY id DESC LIMIT 100) AS recent ORDER BY id ASC`;
    return sendJson(res, 200, { messages: rows.map((row) => ({ id: Number(row.id), room: row.room, userId: row.user_id, username: row.username, avatarUrl: row.avatar_url, content: row.content, createdAt: row.created_at })) });
  }
  if (route === 'chat' && parts.length === 2 && req.method === 'POST') {
    const room = parts[1];
    if (!['staff', 'management'].includes(room)) return sendError(res, 404, 'غرفة الشات مش موجودة.');
    if (!canReadRoom(user, room)) return sendError(res, 403, 'الشات ده مخصص للمسؤولين.');
    const content = cleanText(req.body?.content, 1500);
    if (!content) return sendError(res, 400, 'اكتب رسالة قبل الإرسال.');
    const rows = await sql`INSERT INTO chat_messages(room, user_id, username, avatar_url, content, created_at)
      VALUES (${room}, ${user.id}, ${user.username}, ${user.avatarUrl || null}, ${content}, NOW()) RETURNING id, created_at`;
    return sendJson(res, 201, { message: { id: Number(rows[0].id), room, userId: user.id, username: user.username, avatarUrl: user.avatarUrl, content, createdAt: rows[0].created_at } });
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
