'use strict';

// إرسال رسالة خاصة (DM) للعضو عند قبول/رفض التسليم أو الإجازة أو الطلب الإداري.
// لو الخاص مقفول عند العضو، ديسكورد بيرفض الطلب — ده مش خطأ في النظام، فبنرجّع { ok:false } من غير ما نكسر المراجعة.
const DISCORD_API = 'https://discord.com/api/v10';
const dmChannelCache = new Map(); // userId -> channelId (بتوفر طلب API في كل مرة)

function clip(value, max) { return String(value ?? '').slice(0, max); }
function fmt(n) { return (Math.round(Number(n || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }); }

async function discordFetch(token, route, body) {
  const response = await fetch(`${DISCORD_API}${route}`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const error = new Error(clip(payload?.message || `Discord API HTTP ${response.status}`, 160));
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

async function dmUser({ token, userId, embed }) {
  const id = String(userId || '');
  if (!token) return { ok: false, reason: 'no-token' };
  if (!/^\d{15,22}$/.test(id)) return { ok: false, reason: 'bad-user-id' };
  try {
    let channelId = dmChannelCache.get(id);
    if (!channelId) {
      const channel = await discordFetch(token, '/users/@me/channels', { recipient_id: id });
      channelId = channel.id;
      dmChannelCache.set(id, channelId);
      if (dmChannelCache.size > 500) dmChannelCache.delete(dmChannelCache.keys().next().value);
    }
    await discordFetch(token, `/channels/${channelId}/messages`, { embeds: [embed], allowed_mentions: { parse: [] } });
    return { ok: true };
  } catch (error) {
    // 50007 = العضو مقفل الرسائل الخاصة من السيرفر/البوت
    const reason = error.code === 50007 ? 'dm-closed' : clip(error.message, 120);
    console.error('[dm user]', id, reason);
    return { ok: false, reason };
  }
}

const KIND_LABELS = {
  submission: { noun: 'تسليم المهمة', footer: 'إدارة البرج • مراجعة التسليمات' },
  leave: { noun: 'طلب الإجازة', footer: 'إدارة البرج • طلبات الإجازة' },
  request: { noun: 'الطلب الإداري', footer: 'إدارة البرج • الطلبات الإدارية' },
};

// kind: submission | leave | request — status: approved | rejected
function buildReviewEmbed({ kind, status, id, reviewerId = '', note = '', fields = [] }) {
  const label = KIND_LABELS[kind] || KIND_LABELS.request;
  const approved = status === 'approved';
  const list = [...fields];
  if (reviewerId) list.push({ name: '🛡️ المراجع', value: `<@${reviewerId}>`, inline: true });
  if (note) list.push({ name: approved ? '🗒️ ملاحظة الإدارة' : '📝 سبب الرفض', value: clip(note, 1000), inline: false });
  else if (!approved) list.push({ name: '📝 سبب الرفض', value: 'لم يحدد المسؤول سببًا. تقدر تسأل الإدارة لو محتاج توضيح.', inline: false });
  return {
    title: approved ? `✅ تم قبول ${label.noun} #${id}` : `❌ تم رفض ${label.noun} #${id}`,
    description: approved ? `تمت الموافقة على ${label.noun} الخاص بك.` : `للأسف تم رفض ${label.noun} الخاص بك.`,
    color: approved ? 0x22c55e : 0xef4444,
    fields: list.slice(0, 10),
    timestamp: new Date().toISOString(),
    footer: { text: label.footer },
  };
}

async function notifyReview({ token, userId, ...embedArgs }) {
  return dmUser({ token, userId, embed: buildReviewEmbed(embedArgs) });
}

module.exports = { dmUser, buildReviewEmbed, notifyReview, fmt };
