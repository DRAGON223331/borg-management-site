'use strict';

// Grants the "on leave" roles (main + staff servers) to members whose approved leave is active,
// and removes them again once the leave has ended. Only roles that THIS code added are ever removed,
// so a real admin who already had the role keeps it.
const DISCORD_API = 'https://discord.com/api/v10';

const CONFIG = {
  mainGuildId: process.env.MAIN_GUILD_ID || '883871561474539630',
  staffGuildId: process.env.STAFF_GUILD_ID || '1556647204255568063',
  mainRoleId: process.env.LEAVE_ROLE_MAIN_ID || process.env.MANAGEMENT_MAIN_ROLE_ID || '1538623033806168135',
  staffRoleId: process.env.LEAVE_ROLE_STAFF_ID || process.env.MANAGEMENT_STAFF_ROLE_ID || '1559628523809804288',
  channelId: '1556945732957765722',
};

function cairoToday() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const d10 = (v) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

async function api(token, path, options = {}) {
  const res = await fetch(`${DISCORD_API}${path}`, { ...options, headers: { Authorization: `Bot ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (res.status === 204) return { status: 204 };
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, ok: res.ok, body };
}

async function ensureColumns(sql) {
  await sql`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS roles_granted TEXT`;
  await sql`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS roles_synced BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS roles_removed_at TIMESTAMPTZ`;
}

const parseList = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

async function syncLeaveRoles({ sql, token, report = false }) {
  const out = { today: cairoToday(), onLeave: [], granted: [], removed: [], errors: [] };
  if (!token) { out.errors.push('توكن البوت غير مضبوط.'); return out; }
  await ensureColumns(sql);
  const targets = [
    { key: `${CONFIG.mainGuildId}:${CONFIG.mainRoleId}`, guildId: CONFIG.mainGuildId, roleId: CONFIG.mainRoleId, label: 'السيرفر الأساسي' },
    { key: `${CONFIG.staffGuildId}:${CONFIG.staffRoleId}`, guildId: CONFIG.staffGuildId, roleId: CONFIG.staffRoleId, label: 'سيرفر الاستاف' },
  ];
  const today = out.today;

  // 1) Grant roles for approved leaves that are active today.
  const active = await sql`SELECT id, user_id, username, start_date, end_date, roles_granted, roles_synced FROM leave_requests WHERE status = 'approved' AND start_date <= ${today} AND end_date >= ${today} ORDER BY id`;
  for (const row of active) {
    out.onLeave.push({ id: Number(row.id), userId: row.user_id, username: row.username, endDate: d10(row.end_date) });
    if (row.roles_synced) continue;
    const granted = parseList(row.roles_granted);
    let failed = false;
    for (const t of targets) {
      if (granted.includes(t.key)) continue;
      const member = await api(token, `/guilds/${t.guildId}/members/${row.user_id}`);
      if (member.status === 404) continue; // not in that server
      if (!member.ok) { failed = true; out.errors.push(`${t.label}: تعذر قراءة العضو ${row.user_id} (${member.body?.message || member.status})`); continue; }
      if ((member.body?.roles || []).includes(t.roleId)) continue; // already had it: never ours to remove
      const put = await api(token, `/guilds/${t.guildId}/members/${row.user_id}/roles/${t.roleId}`, { method: 'PUT', headers: { 'X-Audit-Log-Reason': encodeURIComponent(`Leave #${row.id}`) } });
      if (put.status === 204 || put.ok) { granted.push(t.key); out.granted.push({ userId: row.user_id, username: row.username, where: t.label }); }
      else { failed = true; out.errors.push(`${t.label}: فشل إعطاء الرتبة لـ ${row.user_id} (${put.body?.message || put.status})`); }
    }
    await sql`UPDATE leave_requests SET roles_granted = ${JSON.stringify(granted)}, roles_synced = ${!failed} WHERE id = ${row.id}`;
  }

  // 2) Remove roles for leaves that ended.
  const ended = await sql`SELECT id, user_id, username, roles_granted FROM leave_requests WHERE status = 'approved' AND end_date < ${today} AND roles_removed_at IS NULL AND (roles_granted IS NOT NULL OR roles_synced = FALSE) ORDER BY id`;
  for (const row of ended) {
    const granted = parseList(row.roles_granted);
    const stillActive = active.find((a) => a.user_id === row.user_id);
    if (stillActive && granted.length) {
      // Another leave is still active: hand the roles over to it instead of removing them.
      const merged = Array.from(new Set([...parseList(stillActive.roles_granted), ...granted]));
      stillActive.roles_granted = JSON.stringify(merged);
      await sql`UPDATE leave_requests SET roles_granted = ${stillActive.roles_granted} WHERE id = ${stillActive.id}`;
      await sql`UPDATE leave_requests SET roles_removed_at = NOW() WHERE id = ${row.id}`;
      continue;
    }
    let failed = false;
    for (const key of granted) {
      const t = targets.find((x) => x.key === key);
      if (!t) continue;
      const del = await api(token, `/guilds/${t.guildId}/members/${row.user_id}/roles/${t.roleId}`, { method: 'DELETE', headers: { 'X-Audit-Log-Reason': encodeURIComponent(`Leave #${row.id} ended`) } });
      if (del.status === 204 || del.status === 404 || del.ok) out.removed.push({ userId: row.user_id, username: row.username, where: t.label });
      else { failed = true; out.errors.push(`${t.label}: فشل سحب الرتبة من ${row.user_id} (${del.body?.message || del.status})`); }
    }
    if (!failed) await sql`UPDATE leave_requests SET roles_removed_at = NOW() WHERE id = ${row.id}`;
  }

  // 3) Optional daily report to the leave channel.
  if (report) {
    const lines = out.onLeave.length ? out.onLeave.map((x) => `• <@${x.userId}> — حتى ${x.endDate}`).join('\n') : 'لا أحد في إجازة اليوم ✅';
    const fields = [{ name: `🏖️ في إجازة اليوم (${out.onLeave.length})`, value: lines.slice(0, 1024) }];
    const removedUsers = Array.from(new Set(out.removed.map((x) => x.userId)));
    if (removedUsers.length) fields.push({ name: '🔙 انتهت إجازتهم وتم سحب الرتبة', value: removedUsers.map((u) => `• <@${u}>`).join('\n').slice(0, 1024) });
    if (out.errors.length) fields.push({ name: '⚠️ أخطاء', value: out.errors.join('\n').slice(0, 1024) });
    await api(token, `/channels/${CONFIG.channelId}/messages`, { method: 'POST', body: JSON.stringify({ embeds: [{ title: `📋 تقرير الإجازات اليومي — ${today}`, color: out.errors.length ? 0xf59e0b : 0x8b5cf6, fields, timestamp: new Date().toISOString(), footer: { text: 'إدارة البرج • طلبات الإجازة' } }], allowed_mentions: { parse: [] } }) });
  }
  return out;
}

module.exports = { syncLeaveRoles };
