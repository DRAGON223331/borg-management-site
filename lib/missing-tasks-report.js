'use strict';

const DISCORD_API = 'https://discord.com/api/v10';
const DEFAULT_REPORT_CHANNEL_ID = '1556945732957765722';
const DEFAULT_MAIN_GUILD_ID = '883871561474539630';
const DEFAULT_MANAGER_IDS = '';
const MANAGER_IDS = new Set(String(process.env.MANAGER_IDS || DEFAULT_MANAGER_IDS).split(',').map((id) => id.trim()).filter(Boolean));
const MANAGEMENT_MAIN_ROLE_ID = String(process.env.MANAGEMENT_MAIN_ROLE_ID || '1538623033806168135').trim();
const MANAGEMENT_STAFF_ROLE_ID = String(process.env.MANAGEMENT_STAFF_ROLE_ID || '1559628523809804288').trim();
const REPORT_EXCLUDED_USER_IDS = new Set(String(process.env.REPORT_EXCLUDED_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
const REPORT_EXCLUDED_ROLE_IDS = new Set(String(process.env.REPORT_EXCLUDED_ROLE_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
const STAFF_MEMBER_ROLE_ID = String(process.env.STAFF_MEMBER_ROLE_ID || '').trim();
const ADMINISTRATOR_PERMISSION = 1n << 3n;

function cleanText(value, max = 240) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}

async function discordApi(token, route, options = {}) {
  if (!token) throw new Error('توكن البوت غير مضبوط.');
  const response = await fetch(`${DISCORD_API}${route}`, {
    ...options,
    headers: { Authorization: `Bot ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  let payload = null;
  if (response.status !== 204) { try { payload = await response.json(); } catch { payload = null; } }
  if (!response.ok) throw new Error(cleanText(payload?.message || `Discord API HTTP ${response.status}`, 180));
  return payload;
}

async function fetchGuildMembers(token, guildId) {
  const members = [];
  let after = '';
  for (let page = 0; page < 100; page += 1) {
    const route = `/guilds/${guildId}/members?limit=1000${after ? `&after=${after}` : ''}`;
    const batch = await discordApi(token, route);
    if (!Array.isArray(batch)) throw new Error('تعذر قراءة أعضاء سيرفر الاستاف من Discord.');
    members.push(...batch.filter((member) => member?.user && !member.user.bot));
    if (batch.length < 1000) break;
    const nextAfter = String(batch[batch.length - 1]?.user?.id || '');
    if (!nextAfter || nextAfter === after) throw new Error('تعذر إكمال قراءة قائمة أعضاء Discord؛ لم يتم إرسال تقرير قد يستبعد مسؤولين بشكل غير صحيح.');
    if (page === 99) throw new Error('قائمة أعضاء Discord تجاوزت حد الفحص الآمن (100,000 عضو)؛ لم يتم إرسال التقرير.');
    after = nextAfter;
  }
  return members;
}

async function fetchGuildRoleInfo(token, guildId) {
  const [guild, roles] = await Promise.all([
    discordApi(token, `/guilds/${guildId}`),
    discordApi(token, `/guilds/${guildId}/roles`),
  ]);
  if (!guild?.id || !Array.isArray(roles)) throw new Error('تعذر التحقق من رتب وصلاحيات سيرفر الاستاف؛ لم يتم إرسال التقرير لتجنب إدراج مسؤولين بالخطأ.');
  const administratorRoleIds = new Set();
  for (const role of roles) {
    try {
      if ((BigInt(String(role.permissions || '0')) & ADMINISTRATOR_PERMISSION) !== 0n) administratorRoleIds.add(String(role.id));
    } catch { /* تجاهل قيمة صلاحيات تالفة، مع الاعتماد على بقية الرتب */ }
  }
  return { ownerId: String(guild.owner_id || ''), administratorRoleIds };
}

function hasAnyRole(member, roleIds) {
  const roles = new Set((Array.isArray(member?.roles) ? member.roles : []).map(String));
  for (const roleId of roleIds) if (roleId && roles.has(String(roleId))) return true;
  return false;
}

function isExcludedFromStaffReport(member, roleInfo, optionalStaffRoleId = STAFF_MEMBER_ROLE_ID) {
  const userId = String(member?.user?.id || '');
  if (!userId || member?.user?.bot) return true;
  if (REPORT_EXCLUDED_USER_IDS.has(userId) || MANAGER_IDS.has(userId) || userId === roleInfo.ownerId) return true;
  const excludedRoles = new Set([
    ...roleInfo.administratorRoleIds,
    MANAGEMENT_MAIN_ROLE_ID,
    MANAGEMENT_STAFF_ROLE_ID,
    ...REPORT_EXCLUDED_ROLE_IDS,
  ].filter(Boolean));
  if (hasAnyRole(member, excludedRoles)) return true;
  if (optionalStaffRoleId && !hasAnyRole(member, [optionalStaffRoleId])) return true;
  return false;
}

async function filterOrdinaryStaffMembers({ token, staffGuildId, members }) {
  const staffRoleInfo = await fetchGuildRoleInfo(token, staffGuildId);
  const candidates = members.filter((member) => !isExcludedFromStaffReport(member, staffRoleInfo));
  if (!candidates.length) return [];
  const mainGuildId = String(process.env.MAIN_GUILD_ID || DEFAULT_MAIN_GUILD_ID).trim();
  if (!mainGuildId || mainGuildId === String(staffGuildId)) return candidates;

  // Match the website's permission rules: managers/admins in the main guild are not ordinary staff.
  const mainRoleInfo = await fetchGuildRoleInfo(token, mainGuildId);
  const mainGuildMembers = await fetchGuildMembers(token, mainGuildId);
  const managementRoleIds = new Set([
    MANAGEMENT_MAIN_ROLE_ID,
    MANAGEMENT_STAFF_ROLE_ID,
    ...REPORT_EXCLUDED_ROLE_IDS,
    ...mainRoleInfo.administratorRoleIds,
  ].filter(Boolean));
  const mainGuildManagers = new Set(mainGuildMembers.filter((member) => {
    const userId = String(member?.user?.id || '');
    if (!userId) return false;
    if (userId === mainRoleInfo.ownerId || MANAGER_IDS.has(userId) || REPORT_EXCLUDED_USER_IDS.has(userId)) return true;
    return hasAnyRole(member, managementRoleIds);
  }).map((member) => String(member.user.id)));
  return candidates.filter((member) => !mainGuildManagers.has(String(member.user.id)));
}

function memberDisplayName(member) {
  return cleanText(member.nick || member.user?.global_name || member.user?.username || 'عضو الاستاف', 80);
}

function statusLabel(status) {
  if (status === 'pending' || status === 'submitted') return 'قيد المراجعة';
  if (status === 'rejected') return 'مرفوضة';
  return 'لم يسلّم';
}

function splitLines(lines, limit = 1750) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const addition = current ? `\n${line}` : line;
    if (current && current.length + addition.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current += addition;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendMissingTasksReport({ sql, token, staffGuildId, channelId = DEFAULT_REPORT_CHANNEL_ID, dailyDate = null }) {
  if (!sql) throw new Error('قاعدة البيانات غير مضبوطة.');
  if (!staffGuildId) throw new Error('معرّف سيرفر الاستاف غير مضبوط.');
  if (!channelId) throw new Error('معرّف روم التقرير غير مضبوط.');

  if (dailyDate) {
    await sql`CREATE TABLE IF NOT EXISTS task_report_runs (
      report_date DATE PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'sending',
      message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ
    )`;
    const claim = await sql`INSERT INTO task_report_runs(report_date, status) VALUES (${dailyDate}::date, 'sending') ON CONFLICT (report_date) DO UPDATE SET status = 'sending', created_at = NOW() WHERE task_report_runs.status = 'failed' OR (task_report_runs.status = 'sending' AND task_report_runs.created_at < NOW() - INTERVAL '30 minutes') RETURNING report_date`;
    if (!claim.length) return { skipped: true, reason: 'already-sent', reportDate: dailyDate };
  }

  const postedIds = [];
  try {
    const tasks = await sql`SELECT id::text AS id, title FROM tasks WHERE active = TRUE AND required = TRUE AND (deadline_at IS NULL OR deadline_at > NOW()) ORDER BY id ASC`;
    const fetchedMembers = await fetchGuildMembers(token, staffGuildId);
    const members = await filterOrdinaryStaffMembers({ token, staffGuildId, members: fetchedMembers });
    const reportDate = dailyDate || new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const titleLine = `📋 **تقرير المهمات الإجبارية غير المكتملة — ${reportDate}**\nالروم: <#${channelId}> • بتوقيت القاهرة\nالحالة تُحسب حسب التسليمات المقبولة؛ التسليم المعلّق لا يُعد إنجازًا نهائيًا.`;
    let bodyLines = [];
    if (!tasks.length) {
      bodyLines = ['✅ لا توجد حاليًا مهمات إجبارية نشطة ضمن النظام.'];
    } else {
      const activityRows = await sql`SELECT st.task_id::text AS "taskId", s.user_id AS "userId", s.status AS status, s.submitted_at AS "submittedAt" FROM submission_tasks st JOIN submissions s ON s.id = st.submission_id JOIN tasks t ON t.id = st.task_id WHERE t.active = TRUE AND t.required = TRUE AND (t.deadline_at IS NULL OR t.deadline_at > NOW()) ORDER BY s.submitted_at DESC, s.id DESC`;
      const approved = new Set();
      const latestAttempt = new Map();
      for (const row of activityRows) {
        const key = `${String(row.userId)}:${String(row.taskId)}`;
        if (row.status === 'approved') approved.add(key);
        if (!latestAttempt.has(key)) latestAttempt.set(key, String(row.status || ''));
      }
      let reworkRows = [];
      try {
        reworkRows = await sql`SELECT user_id AS "userId", task_id::text AS "taskId", status FROM task_rework_requests WHERE status IN ('requested', 'submitted')`;
      } catch (error) {
        if (!String(error?.message || '').toLowerCase().includes('does not exist')) throw error;
      }
      const rework = new Map(reworkRows.map((row) => [`${String(row.userId)}:${String(row.taskId)}`, String(row.status || 'requested')]));
      const taskById = new Map(tasks.map((task) => [String(task.id), { id: String(task.id), title: cleanText(task.title, 180) }]));
      const taskIds = tasks.map((task) => String(task.id));
      const missingByMember = [];
      for (const member of members) {
        const userId = String(member.user.id);
        const missing = [];
        for (const taskId of taskIds) {
          const key = `${userId}:${taskId}`;
          if (rework.has(key)) {
            missing.push({ title: taskById.get(taskId).title, status: rework.get(key) === 'submitted' ? 'تم تسليم الإعادة — قيد المراجعة' : 'مطلوب إعادة المهمة' });
            continue;
          }
          if (approved.has(key)) continue;
          const attemptStatus = latestAttempt.get(key);
          missing.push({ title: taskById.get(taskId).title, status: statusLabel(attemptStatus) });
        }
        if (missing.length) missingByMember.push({ id: userId, name: memberDisplayName(member), missing });
      }
      missingByMember.sort((a, b) => b.missing.length - a.missing.length || a.name.localeCompare(b.name, 'ar'));
      if (!missingByMember.length) {
        bodyLines = ['✅ كل أعضاء الاستاف أكملوا المهمات الإجبارية النشطة أو ليس لديهم مهمات مطلوبة حاليًا.'];
      } else {
        bodyLines = missingByMember.map((member) => {
          const shown = member.missing.slice(0, 7).map((task) => `**${task.title}** (${task.status})`);
          if (member.missing.length > 7) shown.push(`+ ${member.missing.length - 7} مهمات أخرى`);
          const taskText = shown.join('، ');
          return `• <@${member.id}> — ${member.name} — **${member.missing.length}** مهمة غير مكتملة: ${taskText}`.slice(0, 950);
        });
      }
    }

    const chunks = splitLines([titleLine, ...bodyLines], 1750);
    for (let index = 0; index < chunks.length; index += 1) {
      const content = chunks.length > 1 ? `${chunks[index]}\n\n— جزء ${index + 1}/${chunks.length}` : chunks[index];
      const message = await discordApi(token, `/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: content.slice(0, 1990), allowed_mentions: { parse: [] } }),
      });
      if (message?.id) postedIds.push(String(message.id));
    }

    if (dailyDate) await sql`UPDATE task_report_runs SET status = 'sent', message_ids = ${JSON.stringify(postedIds)}::jsonb, sent_at = NOW() WHERE report_date = ${dailyDate}::date`;
    return {
      skipped: false,
      reportDate,
      activeRequiredTasks: tasks.length,
      totalMembers: members.length,
      excludedManagersAndAdmins: Math.max(0, fetchedMembers.length - members.length),
      membersWithIncompleteTasks: tasks.length ? bodyLines.filter((line) => line.startsWith('• ')).length : 0,
      messagesSent: postedIds.length,
      messageIds: postedIds,
      channelId,
    };
  } catch (error) {
    if (dailyDate) {
      try { await sql`UPDATE task_report_runs SET status = 'failed' WHERE report_date = ${dailyDate}::date`; } catch { /* keep the original report error */ }
    }
    throw error;
  }
}

module.exports = { sendMissingTasksReport, DEFAULT_REPORT_CHANNEL_ID, isExcludedFromStaffReport, filterOrdinaryStaffMembers };
