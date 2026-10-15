'use strict';

function cleanText(value, max = 300) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

function formatPoints(value) {
  return (Math.round(Number(value || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Canonical messages for task acceptance/rejection.
 * Keep the website route, Discord buttons, Gateway worker and points log on
 * the same wording and field order so a decision looks identical everywhere.
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

  // This is the detailed website-style decision embed. It is also used to edit
  // the original Discord review card after either button is pressed.
  const logEmbed = {
    title: approved ? '✅ اعتماد تسليم مهمة وإضافة النقاط' : '❌ تم رفض تسليم مهمة',
    description: `تمت مراجعة التسليم **#${id}** ${approved ? 'واعتماده بواسطة الإدارة.' : 'ورفضه بواسطة الإدارة.'}`,
    color: approved ? 0x22c55e : 0xef4444,
    fields: [
      { name: '👤 العضو', value: `<@${userId}>`, inline: true },
      { name: approved ? '💎 النقاط المضافة' : '💎 النقاط', value: approved ? `**+${formatPoints(points)} نقطة**` : '**0 نقطة — لم تتم إضافة نقاط**', inline: true },
      { name: approved ? '📊 الرصيد بعد الاعتماد' : '📊 الرصيد الحالي', value: `**${formatPoints(total)} نقطة**`, inline: true },
      { name: '🛡️ المسؤول', value: `<@${reviewer}>`, inline: true },
      { name: '📋 تفاصيل المهمات والنقاط', value: taskDetails, inline: false },
      ...(!approved && cleanReason ? [{ name: '📝 سبب الرفض', value: cleanReason, inline: false }] : []),
    ].slice(0, 25),
    footer: { text: 'Borg Management • Task Review' },
    timestamp: new Date().toISOString(),
  };

  return { announcementContent: announcementLines.join('\n').slice(0, 1990), logEmbed };
}

function mergeSubmissionDecisionEmbed(decisionEmbed, sourceEmbed = null) {
  const source = sourceEmbed && typeof sourceEmbed === 'object' ? sourceEmbed : {};
  const replacedNames = new Set([
    '👤 العضو', '🧾 رقم التسليم', '📋 تفاصيل المهمات والنقاط', '💎 النقاط المضافة', '💎 النقاط',
    '📊 الرصيد بعد الاعتماد', '📊 الرصيد الحالي', '🛡️ المسؤول', '🛡️ المراجع', '🛡️ قرار المراجعة', '📝 سبب الرفض',
  ]);
  // Keep evidence-related fields (files, external links, member note, duplicate warnings)
  // on the original review card when replacing its acceptance/rejection state.
  const preserved = (Array.isArray(source.fields) ? source.fields : []).filter((field) => {
    const name = String(field?.name || '').trim();
    return name && !replacedNames.has(name) && !name.startsWith('🎯 المهمة') && !name.startsWith('تسليم');
  }).map((field) => ({
    name: cleanText(field.name, 256),
    value: String(field.value || '').slice(0, 1024),
    inline: Boolean(field.inline),
  }));
  const result = { ...decisionEmbed, fields: [...(decisionEmbed.fields || []), ...preserved].slice(0, 25) };
  if (source.thumbnail?.url) result.thumbnail = { url: source.thumbnail.url };
  if (source.image?.url) result.image = { url: source.image.url };
  if (source.author?.name) result.author = {
    name: cleanText(source.author.name, 256),
    ...(source.author.url ? { url: source.author.url } : {}),
    ...(source.author.icon_url || source.author.iconURL ? { icon_url: source.author.icon_url || source.author.iconURL } : {}),
  };
  return result;
}

module.exports = { buildSubmissionNotifications, mergeSubmissionDecisionEmbed, formatPoints };
