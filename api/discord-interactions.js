'use strict';

const crypto = require('node:crypto');
const DISCORD_API = 'https://discord.com/api/v10';
const LEAVE_REQUEST_CHANNEL_ID = '1556945732957765722';
const LEAVE_NOTICE_CHANNEL_ID = process.env.LEAVE_NOTICE_CHANNEL_ID || '1558102515885678734'; // accepted/rejected notices go here
const MANAGER_IDS = new Set((process.env.MANAGER_IDS || '1286035404323164172,1525203473262706821,848304089057460254,1475483362536980552').split(',').map((x) => x.trim()).filter(Boolean));
const MANAGEMENT_MAIN_ROLE_ID = process.env.MANAGEMENT_MAIN_ROLE_ID || '1538623033806168135';
const MANAGEMENT_STAFF_ROLE_ID = process.env.MANAGEMENT_STAFF_ROLE_ID || '1559628523809804288';
const MAIN_GUILD_ID = process.env.MAIN_GUILD_ID || '883871561474539630';
const STAFF_GUILD_ID = process.env.STAFF_GUILD_ID || '1556647204255568063';
const MESSAGE_COUNT_CHANNEL_ID = (process.env.MESSAGE_COUNT_CHANNEL_ID || '1552049641913065552').trim();
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
  // Read the raw stream FIRST: touching req.body on Vercel can parse (and consume) it, which made
  // the old code hang and Discord report "didn't respond in time".
  if (!req.readableEnded && !req.destroyed && req.readable !== false) {
    const chunks = [];
    const read = new Promise((resolve, reject) => {
      req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', resolve);
      req.on('error', reject);
      req.on('close', resolve);
    });
    await Promise.race([read, new Promise((resolve) => setTimeout(resolve, 1500))]);
    if (chunks.length) return Buffer.concat(chunks);
  }
  const body = req.body;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  if (body && typeof body === 'object') return Buffer.from(JSON.stringify(body));
  return Buffer.alloc(0);
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
function buildNoticeEmbed(item, status, reviewerId, note) {
  const approved = status === 'approved';
  const fields = [
    { name: '👤 العضو', value: `<@${item.user_id}>`, inline: true },
    { name: '🛡️ المراجع', value: reviewerId ? `<@${reviewerId}>` : 'الإدارة', inline: true },
    { name: '📅 الفترة', value: `${String(item.start_date).slice(0, 10)} ← ${String(item.end_date).slice(0, 10)}`, inline: false },
  ];
  if (note) fields.push({ name: '📝 السبب', value: String(note).slice(0, 1024), inline: false });
  return { title: approved ? `✅ تم قبول طلب الإجازة #${Number(item.id)}` : `❌ تم رفض طلب الإجازة #${Number(item.id)}`, color: approved ? 0x22c55e : 0xef4444, fields, timestamp: new Date().toISOString(), footer: { text: 'إدارة البرج • طلبات الإجازة' } };
}
function isAdministrator(permissionBits) {
  try { return (BigInt(permissionBits || '0') & 8n) === 8n; } catch { return false; }
}
// صلاحية /csv: مسؤول معرّف في MANAGER_IDS، أو Administrator / رتبة الإدارة — ومن داخل السيرفر الأساسي أو سيرفر الاستاف فقط.
async function isCsvAuthorized(interaction) {
  const userId = String(interaction.member?.user?.id || interaction.user?.id || '');
  if (!userId) return false;
  if (MANAGER_IDS.has(userId)) return true;
  const guildId = String(interaction.guild_id || '');
  if (guildId !== MAIN_GUILD_ID && guildId !== STAFF_GUILD_ID) return false;
  const roles = Array.isArray(interaction.member?.roles) ? interaction.member.roles.map(String) : [];
  if (isAdministrator(interaction.member?.permissions) || roles.includes(MANAGEMENT_MAIN_ROLE_ID) || roles.includes(MANAGEMENT_STAFF_ROLE_ID)) return true;
  if (!BOT_TOKEN) return false;
  const lookups = await Promise.allSettled([MAIN_GUILD_ID, STAFF_GUILD_ID].map((id) => discordApi(`/guilds/${id}/members/${userId}`)));
  return lookups.some((result) => result.status === 'fulfilled' && (result.value?.roles || []).some((roleId) => roleId === MANAGEMENT_MAIN_ROLE_ID || roleId === MANAGEMENT_STAFF_ROLE_ID));
}
async function handleCsvCommand(interaction, res) {
  if (!(await isCsvAuthorized(interaction))) return send(res, { type: 4, data: { content: 'أمر /csv متاح لمسؤولي الإدارة فقط.', flags: 64 } });
  const type = String(interaction.data?.options?.find((option) => option.name === 'type')?.value || 'stats');
  // رد فوري (مخفي) عشان نلحق نافذة الـ3 ثواني، وبعدها نعدّل الرد ونرفق الملف.
  send(res, { type: 5, data: { flags: 64 } });
  const followup = `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const work = (async () => {
    try {
      const sql = await getSql();
      const out = await require('./_lib/csv-export.js').buildCsv(sql, type, { messageChannelId: MESSAGE_COUNT_CHANNEL_ID });
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ content: `📊 **${out.label}** — ${out.rowCount.toLocaleString('en-US')} صف.\nالملف بصيغة UTF-8 ويفتح مباشرة في Excel.`, attachments: [{ id: 0, filename: out.filename }], allowed_mentions: { parse: [] } }));
      form.append('files[0]', new Blob([out.csv], { type: 'text/csv; charset=utf-8' }), out.filename);
      const response = await fetch(followup, { method: 'PATCH', body: form });
      if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
    } catch (error) {
      console.error('[csv command]', cleanText(error?.message || error, 200));
      try { await fetch(followup, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `تعذر تجهيز ملف CSV: ${cleanText(error?.message || error, 140)}` }) }); } catch { /* nothing else to do */ }
    }
  })();
  try { require('@vercel/functions').waitUntil(work); } catch { /* غير متاحة محليًا؛ بننتظر الشغل تحت */ }
  await work;
}
const fmtPoints = (n) => (Math.round(Number(n || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
async function handleCommand(interaction, res) {
  const name = String(interaction.data?.name || '');
  if (name === 'csv') return handleCsvCommand(interaction, res);
  if (name !== 'نقاطي' && name !== 'mypoints') return send(res, { type: 4, data: { content: 'الأمر ده مش مدعوم.', flags: 64 } });
  const userId = String(interaction.member?.user?.id || interaction.user?.id || '');
  let responded = false;
  const reply = (payload) => { if (!responded) { responded = true; send(res, payload); } };
  const timer = setTimeout(() => reply({ type: 5, data: { flags: 64 } }), 2300); // deferred, ephemeral
  let data;
  try {
    const sql = await getSql();
    const total = await sql`SELECT COALESCE(SUM(amount),0) AS total FROM staff_points WHERE user_id = ${userId}`;
    const recent = await sql`SELECT amount, reason FROM staff_points WHERE user_id = ${userId} ORDER BY id DESC LIMIT 5`;
    const embed = {
      title: '⭐ نقاطك',
      description: `عندك **${fmtPoints(total[0]?.total)}** نقطة`,
      color: 0x8b5cf6,
      footer: { text: 'إدارة البرج' },
    };
    if (recent.length) embed.fields = [{ name: 'آخر الحركات', value: recent.map((r) => `${Number(r.amount) >= 0 ? '➕' : '➖'} ${fmtPoints(Math.abs(Number(r.amount)))} — ${cleanText(r.reason, 80) || 'بدون سبب'}`).join('\n').slice(0, 1024) }];
    data = { embeds: [embed], flags: 64 };
  } catch (error) {
    console.error('[points command]', cleanText(error?.message || error, 200));
    data = { content: 'تعذر جلب نقاطك دلوقتي: ' + cleanText(error?.message || error, 120), flags: 64 };
  }
  clearTimeout(timer);
  if (!responded) return reply({ type: 4, data });
  // Already deferred: fill in the reply through the interaction webhook (no bot token needed).
  try {
    await fetch(`${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  } catch (error) { console.error('[points command followup]', cleanText(error?.message || error, 160)); }
}
async function handler(req, res) {
  if (req.method === 'GET') {
    // Open /api/discord-interactions in a browser to check the configuration (no secrets are shown).
    return send(res, { ok: true, endpoint: 'discord-interactions', publicKeySet: /^[a-f0-9]{64}$/i.test(PUBLIC_KEY), botTokenSet: Boolean(BOT_TOKEN), databaseSet: Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_PRISMA_URL) });
  }
  if (req.method !== 'POST') return send(res, { error: 'Method Not Allowed' }, 405);
  let rawBody;
  try { rawBody = await readRawBody(req); } catch { return send(res, { error: 'Invalid body' }, 400); }
  const timestamp = req.headers['x-signature-timestamp'];
  const signature = req.headers['x-signature-ed25519'];
  if (!verifySignature(rawBody, timestamp, signature)) { console.error('[interactions] signature check failed; public key set:', Boolean(PUBLIC_KEY), 'body bytes:', rawBody.length); return send(res, { error: 'Invalid Discord signature' }, 401); }
  let interaction;
  try { interaction = JSON.parse(rawBody.toString('utf8')); } catch { return send(res, { error: 'Invalid JSON' }, 400); }
  console.log('[interactions] received type', interaction.type, interaction.data?.custom_id || interaction.data?.name || '');
  if (interaction.type === 1) return send(res, { type: 1 }); // Discord PING verification
  if (interaction.type === 2) return handleCommand(interaction, res);
  if (interaction.type !== 3 && interaction.type !== 5) return send(res, { type: 4, data: { content: 'نوع التفاعل غير مدعوم.', flags: 64 } });

  const customId = String(interaction.data?.custom_id || '');
  const isModal = interaction.type === 5;
  const match = isModal ? customId.match(/^leave:(rejectmodal):(\d+)$/) : customId.match(/^leave:(approve|reject):(\d+)$/);
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

  // Reject button: open a small form so the reviewer can (optionally) write the reason.
  if (!isModal && match[1] === 'reject') {
    return send(res, { type: 9, data: { custom_id: `leave:rejectmodal:${requestId}`, title: `رفض طلب الإجازة #${requestId}`, components: [{ type: 1, components: [{ type: 4, custom_id: 'reason', label: 'سبب الرفض (اختياري)', style: 2, required: false, max_length: 400, placeholder: 'اكتب السبب هنا أو اتركه فارغًا' }] }] } });
  }

  const requestedStatus = match[1] === 'approve' ? 'approved' : 'rejected';
  const note = isModal ? cleanText((interaction.data?.components || []).flatMap((row) => row.components || []).find((c) => c.custom_id === 'reason')?.value, 400) : '';
  const messageId = String(interaction.message?.id || '');
  if (!messageId) return send(res, { type: 4, data: { content: 'تعذر تحديد رسالة الطلب.', flags: 64 } });

  // Do the work BEFORE answering (serverless may freeze after res.end) and answer with the updated
  // message (type 7). If it is too slow for Discord's 3s window, fall back to a plain ack (type 6).
  let responded = false;
  const reply = (payload) => {
    if (responded) return;
    responded = true;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload));
  };
  const timer = setTimeout(() => reply({ type: 6 }), 2300);
  try {
    const sql = await getSql();
    const found = await sql`SELECT * FROM leave_requests WHERE id = ${requestId} LIMIT 1`;
    if (!found.length) {
      reply({ type: 7, data: { content: 'تعذر العثور على طلب الإجازة في قاعدة البيانات.', components: [] } });
      return;
    }
    let item = found[0];
    if (String(item.discord_message_id || '') !== messageId) {
      console.warn('[leave interaction] Message does not match stored request', requestId, messageId);
      reply({ type: 4, data: { content: 'رسالة الطلب لا تطابق الطلب المسجل.', flags: 64 } });
      return;
    }
    let changed = false;
    if (item.status === 'pending') {
      const updated = await sql`UPDATE leave_requests SET status = ${requestedStatus}, review_note = ${note}, reviewed_by = ${reviewerId}, reviewed_at = NOW() WHERE id = ${requestId} AND status = 'pending' RETURNING *`;
      if (updated.length) { item = updated[0]; changed = true; }
      else {
        const current = await sql`SELECT * FROM leave_requests WHERE id = ${requestId} LIMIT 1`;
        if (current.length) item = current[0];
      }
    }
    const finalStatus = item.status === 'pending' ? requestedStatus : item.status;
    const finalReviewer = item.reviewed_by || reviewerId;
    const finalNote = item.review_note || '';
    // Side jobs (never allowed to eat the 3s window): notice in the review room + roles for approved leaves.
    const side = [];
    if (changed) side.push(discordApi(`/channels/${LEAVE_NOTICE_CHANNEL_ID}/messages`, { method: 'POST', body: JSON.stringify({ embeds: [buildNoticeEmbed(item, finalStatus, finalReviewer, finalNote)], allowed_mentions: { parse: [] } }) }));
    if (changed) side.push(require('./_lib/notify.js').notifyReview({ token: BOT_TOKEN, userId: item.user_id, kind: 'leave', status: finalStatus, id: requestId, reviewerId: finalReviewer, note: finalNote, fields: [{ name: '📅 الفترة', value: `${String(item.start_date).slice(0, 10)} ← ${String(item.end_date).slice(0, 10)}`, inline: false }] }));
    if (finalStatus === 'approved') side.push(require('./_lib/leave-roles.js').syncLeaveRoles({ sql, token: BOT_TOKEN }));
    if (side.length) {
      await Promise.race([Promise.allSettled(side).then((results) => results.forEach((r) => { if (r.status === 'rejected') console.error('[leave side job]', cleanText(r.reason?.message || r.reason, 200)); })), new Promise((resolve) => setTimeout(resolve, 1300))]);
    }
    const data = { embeds: [buildLeaveEmbed(item, finalStatus, finalReviewer, finalNote)], components: [], allowed_mentions: { parse: [] } };
    if (!responded) { reply({ type: 7, data }); return; }
    // Already acked with type 6 (slow path): edit the message through the bot instead.
    await discordApi(`/channels/${LEAVE_REQUEST_CHANNEL_ID}/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify(data) });
  } catch (error) {
    console.error('[Discord leave button]', cleanText(error?.message || error, 220));
    reply({ type: 4, data: { content: 'حصل خطأ أثناء مراجعة الطلب: ' + cleanText(error?.message || error, 120), flags: 64 } });
  } finally { clearTimeout(timer); }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
