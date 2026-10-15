'use strict';

function cleanText(value, max = 300) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

function formatPoints(value) {
  return (Math.round(Number(value || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Builds the canonical task decision announcement and points-ledger embed.
 * Used by the website, Discord HTTP interactions, Gateway worker and local server
 * so the public acceptance/rejection message stays the same regardless of where
 * an administrator clicks the decision button.
 */
function buildSubmissionNotifications({ submissionId, sub, reviewerId, status, taskRows = [], amount = 0, totalAfter = 0, reason = '' }) {
  const approved = status === 'approved';
  const userId = String(sub?.user_id ?? sub?.userId ?? '');
  const reviewer = String(reviewerId || '');
  const id = Number(submissionId || sub?.id || 0);
  const tasks = (Array.isArray(taskRows) ? taskRows : []).map((task) => ({
    title: cleanText(task?.title || 'مهمة', 180),
    points: Math.round(Number(task?.points || 0) * 100) / 100,
  }));
  const taskNames = tasks.map((task) => `**${task.title}**`).join('، ').slice(0, 650) || `مهمة #${id}`;
  const taskDetails = tasks.map((task) => `• ${task.title} — ${formatPoints(task.points)} نقطة`).join('\n').slice(0, 1024) || 'لا توجد مهمات مرتبطة بالتسليم.';
  const points = Math.round(Number(amount || 0) * 100) / 100;
  const total = Math.round(Number(totalAfter || 0) * 100) / 100;
  const cleanReason = cleanText(reason, 400);

  const announcementLines = [
    approved ? '✅ **تم قبول مهمة**' : '❌ **تم رفض مهمة**',
    `📋 **المهمة:** ${taskNames}`,
    `👤 **اللي عملها:** <@${userId}>`,
    `🛡️ **اللي ${approved ? 'قبلها' : 'رفضها'}:** <@${reviewer}>`,
    approved ? `💎 **النقاط المضافة:** +${formatPoints(points)} نقطة` : '💎 **النقاط:** 0 نقطة — لم تتم إضافة نقاط',
    `📊 **الرصيد الحالي:** ${formatPoints(total)} نقطة`,
  ];
  if (!approved) announcementLines.push(`📝 **سبب الرفض:** ${cleanReason || 'لم يتم تحديد سبب'}`);
  announcementLines.push(`🧾 **رقم التسليم:** #${id}`);

  const logEmbed = {
    title: approved ? '✅ تم قبول مهمة وإضافة النقاط' : '❌ تم رفض مهمة',
    description: `📋 **المهمة:** ${taskNames}`,
    color: approved ? 0x22c55e : 0xef4444,
    fields: [
      { name: '👤 العضو', value: `<@${userId}>\n\`${userId}\``, inline: true },
      { name: `🛡️ ${approved ? 'اللي قبلها' : 'اللي رفضها'}`, value: `<@${reviewer}>\n\`${reviewer}\``, inline: true },
      { name: '🧾 رقم التسليم', value: `#${id}`, inline: true },
      { name: '💎 النقاط المضافة', value: approved ? `**+${formatPoints(points)} نقطة**` : '**0 نقطة — لم تتم إضافة نقاط**', inline: true },
      { name: '📊 الرصيد الحالي', value: `**${formatPoints(total)} نقطة**`, inline: true },
      { name: '📋 تفاصيل المهمات والنقاط', value: taskDetails, inline: false },
      ...(!approved || cleanReason ? [{ name: approved ? '📝 ملاحظة' : '📝 سبب الرفض', value: cleanReason || 'لم يتم تحديد سبب', inline: false }] : []),
    ].slice(0, 25),
    footer: { text: 'Borg Management • Task Review' },
    timestamp: new Date().toISOString(),
  };

  return {
    announcementContent: announcementLines.join('\n').slice(0, 1990),
    logEmbed,
  };
}

module.exports = { buildSubmissionNotifications, formatPoints };
