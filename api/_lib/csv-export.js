'use strict';

// تصدير بيانات الاستاف كملف CSV (يُستخدم من أمر /csv في ديسكورد).
// الملف بيبدأ بـ BOM عشان Excel يقرا العربي صح.
const TYPES = {
  stats: { label: 'ملخص الاستاف', file: 'staff-summary' },
  submissions: { label: 'التسليمات', file: 'submissions' },
  leaves: { label: 'طلبات الإجازة', file: 'leave-requests' },
  points: { label: 'سجل النقاط', file: 'points-ledger' },
  requests: { label: 'الطلبات الإدارية', file: 'admin-requests' },
};
const STATUS_AR = { approved: 'مقبول', rejected: 'مرفوض', pending: 'قيد المراجعة', submitted: 'قيد المراجعة' };
const ROW_LIMIT = 5000;

// حماية من حقن الصيغ (CSV injection): أي نص يبدأ بـ = + - @ يتحول لنص عادي في Excel.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
const status = (value) => STATUS_AR[value] || value || '';

async function buildCsv(sql, type, { messageChannelId = '' } = {}) {
  const key = TYPES[type] ? type : 'stats';
  let headers; let rows;
  if (key === 'stats') {
    const data = await sql`
      WITH people AS (
        SELECT user_id, MAX(username) AS username FROM (
          SELECT user_id, username FROM staff_points
          UNION ALL SELECT user_id, username FROM submissions
          UNION ALL SELECT user_id, username FROM leave_requests
          UNION ALL SELECT user_id, username FROM staff_requests
          UNION ALL SELECT user_id, MAX(username) FROM discord_message_log WHERE channel_id = ${messageChannelId} GROUP BY user_id
        ) x GROUP BY user_id
      )
      SELECT p.user_id, p.username,
        COALESCE((SELECT SUM(amount) FROM staff_points sp WHERE sp.user_id = p.user_id), 0)::float8 AS points,
        (SELECT COUNT(*) FROM discord_message_log m WHERE m.user_id = p.user_id AND m.channel_id = ${messageChannelId})::int AS messages,
        (SELECT COUNT(*) FROM submissions s WHERE s.user_id = p.user_id)::int AS subs,
        (SELECT COUNT(*) FROM submissions s WHERE s.user_id = p.user_id AND s.status = 'approved')::int AS subs_ok,
        (SELECT COUNT(*) FROM submissions s WHERE s.user_id = p.user_id AND s.status = 'rejected')::int AS subs_no,
        (SELECT COUNT(*) FROM submissions s WHERE s.user_id = p.user_id AND s.status IN ('pending','submitted'))::int AS subs_wait,
        (SELECT COUNT(*) FROM leave_requests l WHERE l.user_id = p.user_id)::int AS leaves,
        (SELECT COUNT(*) FROM staff_requests r WHERE r.user_id = p.user_id)::int AS requests
      FROM people p ORDER BY points DESC, p.username LIMIT ${ROW_LIMIT}`;
    headers = ['Discord ID', 'الاسم', 'النقاط', 'إجمالي الرسائل', 'إجمالي التسليمات', 'المقبولة', 'المرفوضة', 'قيد المراجعة', 'طلبات الإجازة', 'الطلبات الإدارية'];
    rows = data.map((r) => [r.user_id, r.username, r.points, r.messages, r.subs, r.subs_ok, r.subs_no, r.subs_wait, r.leaves, r.requests]);
  } else if (key === 'submissions') {
    const data = await sql`
      SELECT s.id, s.user_id, s.username, s.status, to_char(s.submitted_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD HH24:MI') AS submitted_at,
        to_char(s.reviewed_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD HH24:MI') AS reviewed_at, s.reviewed_by, s.note,
        COALESCE((SELECT SUM(t.points) FROM submission_tasks st JOIN tasks t ON t.id = st.task_id WHERE st.submission_id = s.id), 0)::float8 AS points,
        COALESCE((SELECT string_agg(t.title, ' | ' ORDER BY t.id) FROM submission_tasks st JOIN tasks t ON t.id = st.task_id WHERE st.submission_id = s.id), '') AS tasks,
        jsonb_array_length(s.files_json) AS files, jsonb_array_length(s.evidence_links) AS links
      FROM submissions s ORDER BY s.id DESC LIMIT ${ROW_LIMIT}`;
    headers = ['رقم التسليم', 'Discord ID', 'الاسم', 'الحالة', 'وقت التسليم (القاهرة)', 'وقت المراجعة (القاهرة)', 'المراجع', 'المهمات', 'نقاط المهمات', 'عدد الملفات', 'عدد الروابط', 'ملاحظة العضو'];
    rows = data.map((r) => [r.id, r.user_id, r.username, status(r.status), r.submitted_at, r.reviewed_at, r.reviewed_by, r.tasks, r.points, r.files, r.links, r.note]);
  } else if (key === 'leaves') {
    const data = await sql`
      SELECT id, user_id, username, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date,
        status, reason, review_note, reviewed_by, to_char(created_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD HH24:MI') AS created_at, to_char(reviewed_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD HH24:MI') AS reviewed_at
      FROM leave_requests ORDER BY id DESC LIMIT ${ROW_LIMIT}`;
    headers = ['رقم الطلب', 'Discord ID', 'الاسم', 'من', 'إلى', 'الحالة', 'السبب', 'ملاحظة الإدارة', 'المراجع', 'وقت الطلب (القاهرة)', 'وقت المراجعة (القاهرة)'];
    rows = data.map((r) => [r.id, r.user_id, r.username, r.start_date, r.end_date, status(r.status), r.reason, r.review_note, r.reviewed_by, r.created_at, r.reviewed_at]);
  } else if (key === 'points') {
    const data = await sql`
      SELECT id, user_id, username, amount::float8 AS amount, reason, source, actor_id, actor_name, submission_id, to_char(created_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD HH24:MI') AS created_at
      FROM staff_points ORDER BY id DESC LIMIT ${ROW_LIMIT}`;
    headers = ['رقم الحركة', 'Discord ID', 'الاسم', 'المقدار', 'السبب', 'المصدر', 'ID المسؤول', 'اسم المسؤول', 'رقم التسليم', 'الوقت (القاهرة)'];
    rows = data.map((r) => [r.id, r.user_id, r.username, r.amount, r.reason, r.source, r.actor_id, r.actor_name, r.submission_id, r.created_at]);
  } else {
    const data = await sql`
      SELECT id, user_id, username, request_type, subject, details, status, review_note, reviewed_by,
        to_char(created_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD HH24:MI') AS created_at, to_char(reviewed_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD HH24:MI') AS reviewed_at
      FROM staff_requests ORDER BY id DESC LIMIT ${ROW_LIMIT}`;
    headers = ['رقم الطلب', 'Discord ID', 'الاسم', 'النوع', 'العنوان', 'التفاصيل', 'الحالة', 'ملاحظة الإدارة', 'المراجع', 'وقت الطلب (القاهرة)', 'وقت المراجعة (القاهرة)'];
    rows = data.map((r) => [r.id, r.user_id, r.username, r.request_type, r.subject, r.details, status(r.status), r.review_note, r.reviewed_by, r.created_at, r.reviewed_at]);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return { csv: toCsv(headers, rows), rowCount: rows.length, filename: `${TYPES[key].file}-${stamp}.csv`, label: TYPES[key].label, type: key };
}

module.exports = { buildCsv, csvCell, toCsv, TYPES };
