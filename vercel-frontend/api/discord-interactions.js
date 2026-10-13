'use strict';

const crypto = require('node:crypto');
const DISCORD_API = 'https://discord.com/api/v10';
const LEAVE_REQUEST_CHANNEL_ID = '1556945732957765722';
const MANAGER_IDS = new Set((process.env.MANAGER_IDS || '1286035404323164172,1525203473262706821,848304089057460254,1475483362536980552').split(',').map((x) => x.trim()).filter(Boolean));
const MANAGEMENT_MAIN_ROLE_ID = process.env.MANAGEMENT_MAIN_ROLE_ID || '1538623033806168135';
const MANAGEMENT_STAFF_ROLE_ID = process.env.MANAGEMENT_STAFF_ROLE_ID || '1559628523809804288';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY || '';

function send(res, payload, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}
function cleanText(value, max = 240) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}
async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function verifySignature(rawBody, timestamp, signature) {
  if (!PUBLIC_KEY || !/^[a-f0-9]{64}$/i.test(PUBLIC_KEY) || !/^[a-f0-9]{128}$/i.test(signature || '') || !timestamp) return false;
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) return false;
  try {
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(PUBLIC_KEY, 'hex')]);
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), key, Buffer.from(signature, 'hex'));
  } catch { return false; }
}
async function getSql() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_PRISMA_URL;
  if (!connectionString) throw new Error('قاعدة البيانات غير مضبوطة.');
  const { neon } = await import('@neondatabase/serverless');
  return neon(connectionString);
}
async function discordApi(route, options = {}) {
  if (!BOT_TOKEN) throw new Error('توكن البوت غير مضبوط.');
  const response = await fetch(`${DISCORD_API}${route}`, {
    ...options,
    headers: { Authorization: `Bot ${BOT_TOKEN}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  let payload = null;
  if (response.status !== 204) { try { payload = await response.json(); } catch { payload = null; } }
  if (!response.ok) throw new Error(cleanText(payload?.message || `Discord API HTTP ${response.status}`));
  return payload;
}
async function ensureLeaveSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS leave_requests (
    id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, avatar_url TEXT,
    start_date DATE NOT NULL, end_date DATE NOT NULL, reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', review_note TEXT NOT NULL DEFAULT '', reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    discord_message_id TEXT, discord_channel_id TEXT
  )`;
  await sql`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS discord_message_id TEXT`;
  await sql`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS discord_channel_id TEXT`;
}
function buildLeaveEmbed(item, status, reviewerId, note) {
  const id = Number(item.id);
  const userId = String(item.user_id || '');
  const startDate = String(item.start_date || '').slice(0, 10);
  const endDate = String(item.end_date || '').slice(0, 10);
  const reason = String(item.reason || 'بدون سبب').slice(0, 1024);
  const approved = status === 'approved';
  const fields = [
    { name: '👤 العضو', value: `<@${userId}>\n\`${userId}\``, inline: true },
    { name: '📅 من', value: startDate || '—', inline: true },
    { name: '📅 إلى', value: endDate || '—', inline: true },
    { name: '📝 السبب', value: reason, inline: false },
    { name: '🛡️ المراجع', value: reviewerId ? `<@${reviewerId}>` : 'الإدارة', inline: true },
  ];
  if (note) fields.push({ name: '🗒️ ملاحظة الإدارة', value: String(note).slice(0, 1024), inline: false });
  const embed = {
    title: approved ? `✅ تمت الموافقة على طلب الإجازة #${id}` : `❌ تم رفض طلب الإجازة #${id}`,
    description: approved ? 'تمت الموافقة على طلب الإجازة.' : 'تم رفض طلب الإجازة.',
    color: approved ? 0x22c55e : 0xef4444,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: 'إدارة البرج • طلبات الإجازة' },
  };
  if (item.avatar_url) embed.thumbnail = { url: item.avatar_url };
  return embed;
}
function isAdministrator(permissionBits) {
  try { return (BigInt(permissionBits || '0') & 8n) === 8n; } catch { return false; }
}
async function handler(req, res) {
  if (req.method !== 'POST') return send(res, { error: 'Method Not Allowed' }, 405);
  let rawBody;
  try { rawBody = await readRawBody(req); } catch { return send(res, { error: 'Invalid body' }, 400); }
  const timestamp = req.headers['x-signature-timestamp'];
  const signature = req.headers['x-signature-ed25519'];
  if (!verifySignature(rawBody, timestamp, signature)) return send(res, { error: 'Invalid Discord signature' }, 401);
  let interaction;
  try { interaction = JSON.parse(rawBody.toString('utf8')); } catch { return send(res, { error: 'Invalid JSON' }, 400); }
  if (interaction.type === 1) return send(res, { type: 1 }); // Discord PING verification
  if (interaction.type !== 3) return send(res, { type: 4, data: { content: 'نوع التفاعل غير مدعوم.', flags: 64 } });

  const customId = String(interaction.data?.custom_id || '');
  const match = customId.match(/^leave:(approve|reject):(\d+)$/);
  if (!match) return send(res, { type: 4, data: { content: 'الزر ده مش مدعوم.', flags: 64 } });
  if (String(interaction.channel_id || '') !== LEAVE_REQUEST_CHANNEL_ID) return send(res, { type: 4, data: { content: 'الأزرار دي شغالة في روم طلبات الإجازات فقط.', flags: 64 } });
  const reviewerId = String(interaction.member?.user?.id || interaction.user?.id || '');
  const roles = Array.isArray(interaction.member?.roles) ? interaction.member.roles.map(String) : [];
  let authorized = MANAGER_IDS.has(reviewerId) || isAdministrator(interaction.member?.permissions) || roles.includes(MANAGEMENT_MAIN_ROLE_ID) || roles.includes(MANAGEMENT_STAFF_ROLE_ID);
  if (!authorized && BOT_TOKEN) {
    const guildIds = [process.env.MAIN_GUILD_ID || '883871561474539630', process.env.STAFF_GUILD_ID || '1556647204255568063'];
    const roleIds = [MANAGEMENT_MAIN_ROLE_ID, MANAGEMENT_STAFF_ROLE_ID];
    const lookups = await Promise.allSettled(guildIds.map((guildId) => discordApi(`/guilds/${guildId}/members/${reviewerId}`)));
    authorized = lookups.some((result) => result.status === 'fulfilled' && (result.value?.roles || []).some((roleId) => roleIds.includes(roleId)));
  }
  if (!authorized) return send(res, { type: 4, data: { content: 'مراجعة طلبات الإجازة للمسؤولين فقط.', flags: 64 } });
  const requestId = Number(match[2]);
  const requestedStatus = match[1] === 'approve' ? 'approved' : 'rejected';
  const messageId = String(interaction.message?.id || '');
  if (!messageId) return send(res, { type: 4, data: { content: 'تعذر تحديد رسالة الطلب.', flags: 64 } });

  // Acknowledge the button quickly; keep this invocation alive while the shared DB and message are updated.
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ type: 6 }));
  try {
    const sql = await getSql();
    await ensureLeaveSchema(sql);
    const found = await sql`SELECT * FROM leave_requests WHERE id = ${requestId} LIMIT 1`;
    if (!found.length) {
      await discordApi(`/channels/${LEAVE_REQUEST_CHANNEL_ID}/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify({ components: [], content: 'تعذر العثور على طلب الإجازة في قاعدة البيانات.' }) });
      return;
    }
    let item = found[0];
    if (String(item.discord_message_id || '') !== messageId || String(item.discord_channel_id || LEAVE_REQUEST_CHANNEL_ID) !== LEAVE_REQUEST_CHANNEL_ID) {
      console.warn('[leave interaction] Message does not match stored request', requestId, messageId);
      return;
    }
    if (item.status === 'pending') {
      const updated = await sql`UPDATE leave_requests SET status = ${requestedStatus}, review_note = '', reviewed_by = ${reviewerId}, reviewed_at = NOW() WHERE id = ${requestId} AND status = 'pending' RETURNING *`;
      if (updated.length) item = updated[0];
      else {
        const current = await sql`SELECT * FROM leave_requests WHERE id = ${requestId} LIMIT 1`;
        if (current.length) item = current[0];
      }
    }
    const finalStatus = item.status === 'pending' ? requestedStatus : item.status;
    const finalReviewer = item.reviewed_by || reviewerId;
    await discordApi(`/channels/${LEAVE_REQUEST_CHANNEL_ID}/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ embeds: [buildLeaveEmbed(item, finalStatus, finalReviewer, item.review_note || '')], components: [], allowed_mentions: { parse: [] } }),
    });
  } catch (error) {
    console.error('[Discord leave button]', cleanText(error?.message || error, 220));
    try {
      await discordApi(`/channels/${LEAVE_REQUEST_CHANNEL_ID}/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify({ components: [] }) });
    } catch (patchError) { console.error('[Discord leave button cleanup]', cleanText(patchError?.message || patchError, 180)); }
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
