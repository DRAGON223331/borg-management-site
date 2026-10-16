'use strict';
// يرد على رسالة «نقاطي» (أو mypoints) بدون بريفكس. لازم يشتغل 24/7 على استضافة Node عادية
// (Railway / Render / VPS ...) لأن Vercel Functions مش بتحافظ على اتصال Gateway.
// المتغيرات المطلوبة: DISCORD_BOT_TOKEN و DATABASE_URL (نفس قاعدة بيانات الموقع).
const { Client, GatewayIntentBits, Partials, Events, EmbedBuilder, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { neon } = require('@neondatabase/serverless');
const { buildSubmissionNotifications, mergeSubmissionDecisionEmbed } = require('../lib/submission-notifications.js');
const { loadSubmissionEvidence, appendEvidenceLinks } = require('../lib/submission-evidence.js');
const { sendMissingTasksReport } = require('../lib/missing-tasks-report.js');
const { reconcileDeletedTaskMessages, deactivateTasksForDeletedMessage } = require('../lib/task-message-sync.js');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_PRISMA_URL;
if (!TOKEN) throw new Error('DISCORD_BOT_TOKEN غير مضبوط.');
if (!DB_URL) throw new Error('DATABASE_URL غير مضبوط.');
const sql = neon(DB_URL);

const TRIGGER = /^(?:نقاطي|نقاطى|mypoints|my points)$/i;
const REVIEW_CHANNEL_ID = process.env.SUBMISSION_REVIEW_CHANNEL_ID || '1556945732957765722';
const TASKS_CHANNEL_ID = process.env.TASKS_CHANNEL_ID || '1556647204960346215';
const POINTS_LOG_CHANNEL_ID = process.env.POINTS_LOG_CHANNEL_ID || '1559598706871767172';
const TASK_APPROVED_CHANNEL_ID = (process.env.TASK_APPROVED_CHANNEL_ID || process.env.TASK_SUBMISSIONS_CHANNEL_ID || '1556651404154642504').trim();
const MAIN_GUILD_ID = process.env.MAIN_GUILD_ID || '883871561474539630';
const STAFF_GUILD_ID = process.env.STAFF_GUILD_ID || '1556647204255568063';
const MANAGEMENT_MAIN_ROLE_ID = process.env.MANAGEMENT_MAIN_ROLE_ID || '1538623033806168135';
const MANAGEMENT_STAFF_ROLE_ID = process.env.MANAGEMENT_STAFF_ROLE_ID || '1559628523809804288';
const MANAGER_IDS = new Set((process.env.MANAGER_IDS || '1286035404323164172,1525203473262706821,848304089057460254,1475483362536980552').split(',').map((x) => x.trim()).filter(Boolean));
const cooldown = new Map();
const normalize = (text) => String(text || '').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[!؟?.،,\s]+$/g, '').replace(/\s+/g, ' ').trim();
const fmt = (n) => (Math.round(Number(n || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Message, Partials.Channel],
});

function isReviewManager(interaction) {
  const member = interaction.member;
  const userId = String(interaction.user?.id || '');
  if (MANAGER_IDS.has(userId)) return true;
  if (member?.permissions?.has?.('Administrator')) return true;
  const roleIds = Array.isArray(member?.roles) ? member.roles.map((role) => typeof role === 'string' ? role : role.id) : [];
  return roleIds.includes(MANAGEMENT_MAIN_ROLE_ID) || roleIds.includes(MANAGEMENT_STAFF_ROLE_ID);
}
async function isReviewManagerAnywhere(interaction) {
  if (isReviewManager(interaction)) return true;
  const userId = String(interaction.user?.id || '');
  for (const guildId of [MAIN_GUILD_ID, STAFF_GUILD_ID]) {
    try {
      const guild = await client.guilds.fetch(guildId);
      const member = await guild.members.fetch(userId);
      if (member.permissions.has('Administrator') || member.roles.cache.has(MANAGEMENT_MAIN_ROLE_ID) || member.roles.cache.has(MANAGEMENT_STAFF_ROLE_ID)) return true;
    } catch { /* البوت قد لا يكون عضوًا في السيرفر أو لا يملك صلاحية جلب الأعضاء */ }
  }
  return false;
}
async function getSubmissionMessage(submission) {
  const channelId = String(submission.discord_channel_id || REVIEW_CHANNEL_ID);
  const messageId = String(submission.discord_message_id || '');
  if (!messageId) throw new Error('رسالة ديسكورد غير مرتبطة بالتسليم.');
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !channel.messages) throw new Error('تعذر الوصول إلى روم مراجعة التسليمات.');
  return channel.messages.fetch(messageId);
}
async function updateSubmissionMessage(message, submission, status, reviewerId, reason, amount, totalAfter, taskRows = []) {
  const prior = message.embeds?.[0];
  const notification = buildSubmissionNotifications({
    submissionId: submission.id,
    sub: submission,
    reviewerId,
    status,
    taskRows,
    amount,
    totalAfter,
    reason,
  });
  const embedData = mergeSubmissionDecisionEmbed(notification.logEmbed, prior);
  await message.edit({ embeds: [EmbedBuilder.from(embedData)], components: [], allowedMentions: { parse: [] } });
}

async function processSubmissionReview(interaction, submissionId, status, reason = '') {
  await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS discord_message_id TEXT`;
  await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS discord_channel_id TEXT`;
  await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS reviewed_by TEXT`;
  await sql`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`;
  await sql`ALTER TABLE submission_tasks ADD COLUMN IF NOT EXISTS points_awarded NUMERIC(10,2)`;
  await sql`CREATE TABLE IF NOT EXISTS submission_review_audit (id BIGSERIAL PRIMARY KEY, submission_id BIGINT NOT NULL, member_id TEXT NOT NULL, member_name TEXT NOT NULL, decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','reopened')), reviewer_id TEXT NOT NULL, reviewer_name TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  const rows = await sql`SELECT * FROM submissions WHERE id = ${submissionId} LIMIT 1`;
  if (!rows.length) throw new Error('التسليم غير موجود في قاعدة البيانات.');
  const sub = rows[0];
  if (String(sub.discord_channel_id || REVIEW_CHANNEL_ID) !== REVIEW_CHANNEL_ID) throw new Error('التسليم مرتبط بروم مراجعة مختلفة.');
  if (!['pending', 'submitted'].includes(String(sub.status))) throw new Error(`تمت مراجعة التسليم مسبقًا؛ حالته الحالية: ${sub.status}.`);

  const message = await getSubmissionMessage(sub);
  if (status === 'approved') {
    // Match the website: freeze each task's point value at the moment it is approved.
    await sql`UPDATE submission_tasks st SET points_awarded = t.points FROM tasks t WHERE st.task_id = t.id AND st.submission_id = ${submissionId} AND st.points_awarded IS NULL`;
  }
  const taskRows = await sql`SELECT t.id, t.title, COALESCE(st.points_awarded, t.points) AS points FROM submission_tasks st JOIN tasks t ON t.id = st.task_id WHERE st.submission_id = ${submissionId} ORDER BY t.id`;
  let amount = 0;
  if (status === 'approved') {
    amount = Math.round(taskRows.reduce((sum, task) => sum + Number(task.points || 0), 0) * 100) / 100;
  }
  const reviewerId = String(interaction.user.id);
  const reviewerName = clean(interaction.user.globalName || interaction.user.username || reviewerId, 120);
  const updated = await sql`UPDATE submissions SET status = ${status}, reviewed_by = ${reviewerId}, reviewed_at = NOW() WHERE id = ${submissionId} AND status IN ('pending','submitted') RETURNING *`;
  if (!updated.length) throw new Error('تمت مراجعة التسليم من مسؤول آخر بالفعل.');
  await sql`INSERT INTO submission_review_audit(submission_id, member_id, member_name, decision, reviewer_id, reviewer_name, reason, created_at) VALUES (${submissionId}, ${sub.user_id}, ${sub.username}, ${status}, ${reviewerId}, ${reviewerName}, ${reason}, NOW())`;
  if (status === 'approved' && amount > 0) {
    await sql`INSERT INTO staff_points(user_id, username, amount, reason, actor_id, actor_name, source, submission_id, created_at) VALUES (${sub.user_id}, ${sub.username}, ${amount}, ${`اعتماد تسليم #${submissionId}`}, ${reviewerId}, ${reviewerName}, 'task', ${submissionId}, NOW())`;
  }
  const totals = await sql`SELECT COALESCE(SUM(amount),0) AS total FROM staff_points WHERE user_id = ${sub.user_id}`;
  const totalAfter = Number(totals[0]?.total || 0);
  await updateSubmissionMessage(message, sub, status, reviewerId, reason, amount, totalAfter, taskRows);

  const notification = buildSubmissionNotifications({ submissionId, sub, reviewerId, status, taskRows, amount, totalAfter, reason });
  try {
    const decisionChannel = await client.channels.fetch(TASK_APPROVED_CHANNEL_ID);
    if (decisionChannel?.isTextBased()) {
      const evidence = await loadSubmissionEvidence(sub);
      const content = appendEvidenceLinks(notification.announcementContent, evidence.linkOnly);
      await decisionChannel.send({
        content,
        ...(evidence.attachments.length ? { files: evidence.attachments.map((file) => new AttachmentBuilder(file.data, { name: file.name })) } : {}),
        allowedMentions: { parse: [] },
      });
    }
  } catch (error) { console.error('[review decision announcement]', error.message); }
  try {
    const logChannel = await client.channels.fetch(POINTS_LOG_CHANNEL_ID);
    if (logChannel?.isTextBased()) await logChannel.send({ embeds: [EmbedBuilder.from(notification.logEmbed)], allowedMentions: { parse: [] } });
  } catch (error) { console.error('[review points log]', error.message); }
  try {
    const user = await client.users.fetch(String(sub.user_id));
    const dm = new EmbedBuilder().setTitle(status === 'approved' ? '✅ تم قبول تسليم المهمة' : '❌ تم رفض تسليم المهمة')
      .setDescription(status === 'approved' ? `تم قبول التسليم #${submissionId} وإضافة **+${fmt(amount)} نقطة**. رصيدك الحالي: **${fmt(totalAfter)}** نقطة.` : `تم رفض التسليم #${submissionId}.${reason ? `\nالسبب: ${clean(reason, 400)}` : ''}`)
      .setColor(status === 'approved' ? 0x22c55e : 0xef4444);
    await user.send({ embeds: [dm] });
  } catch (error) { console.error('[review DM]', error.message); }
  return { status, amount, totalAfter, taskRows };
}
let taskMessageSyncRunning = false;
async function runTaskMessageSync({ reportToLog = true } = {}) {
  if (taskMessageSyncRunning) return { skipped: true, reason: 'already-running' };
  taskMessageSyncRunning = true;
  try {
    const result = await reconcileDeletedTaskMessages({ sql, token: TOKEN, channelId: TASKS_CHANNEL_ID });
    if (reportToLog && (result.deletedMessages || result.errors.length)) console.log('[task message sync]', JSON.stringify(result));
    return result;
  } catch (error) {
    console.error('[task message sync] failed:', error.message);
    return { checkedMessages: 0, deletedMessages: 0, deactivatedTasks: 0, errors: [{ error: clean(error.message, 160) }] };
  } finally { taskMessageSyncRunning = false; }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand?.() && ['sync-tasks', 'مزامنة-المهمات'].includes(String(interaction.commandName || ''))) {
    try {
      if (!(await isReviewManagerAnywhere(interaction))) return interaction.reply({ content: 'أمر مزامنة المهمات متاح لمسؤولي الإدارة فقط.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const result = await runTaskMessageSync();
      return interaction.editReply(`✅ انتهت مزامنة المهمات.\nالرسائل التي تم فحصها: **${result.checkedMessages || 0}**\nالرسائل المحذوفة: **${result.deletedMessages || 0}**\nالمهمات التي أُخفيت من الموقع: **${result.deactivatedTasks || 0}**${result.errors?.length ? `\n⚠️ تعذّر التحقق من ${result.errors.length} رسالة.` : ''}`);
    } catch (error) {
      console.error('[sync-tasks command]', error.stack || error.message || error);
      try { if (interaction.deferred || interaction.replied) return interaction.editReply(`تعذرت مزامنة المهمات: ${clean(error.message || 'خطأ غير معروف', 160)}`); } catch { /* ignore */ }
      return;
    }
  }
  if (interaction.isChatInputCommand?.() && ['task-report', 'تقرير-المهمات'].includes(String(interaction.commandName || ''))) {
    try {
      if (!(await isReviewManagerAnywhere(interaction))) {
        return interaction.reply({ content: 'أمر تقرير المهمات متاح لمسؤولي الإدارة فقط.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const report = await sendMissingTasksReport({
        sql,
        token: TOKEN,
        staffGuildId: STAFF_GUILD_ID,
        channelId: process.env.TASK_INCOMPLETE_REPORT_CHANNEL_ID || '1556945732957765722',
      });
      const content = report.skipped
        ? 'تم إرسال التقرير اليوم بالفعل تلقائيًا؛ لم يتم تكرار الرسالة.'
        : `✅ تم إرسال تقرير المهمات إلى <#${report.channelId}>.\nأعضاء الاستاف العادي الذين لديهم مهمات إجبارية غير مكتملة: **${report.membersWithIncompleteTasks}**.\nعدد المهمات الإجبارية النشطة: **${report.activeRequiredTasks}**.\nتم استبعاد المسؤولين وحسابات Administrator من القائمة.`;
      return interaction.editReply({ content });
    } catch (error) {
      console.error('[task report command]', error.stack || error.message || error);
      try {
        if (interaction.deferred || interaction.replied) return interaction.editReply({ content: `تعذر إرسال تقرير المهمات: ${clean(error.message || 'خطأ غير معروف', 160)}` });
        return interaction.reply({ content: `تعذر إرسال تقرير المهمات: ${clean(error.message || 'خطأ غير معروف', 160)}`, ephemeral: true });
      } catch { return; }
    }
  }
  const customId = String(interaction.customId || '');
  const buttonMatch = customId.match(/^submission:(approve|reject):(\d+)$/);
  const modalMatch = customId.match(/^submission:rejectmodal:(\d+)$/);
  if (!buttonMatch && !modalMatch) return;
  try {
    const fromModal = Boolean(modalMatch);
    const submissionId = Number((buttonMatch || modalMatch)[2]);
    if (interaction.channelId && interaction.channelId !== REVIEW_CHANNEL_ID) {
      const reply = { content: 'أزرار مراجعة التسليمات شغالة في روم مراجعة المهمات فقط.', ephemeral: true };
      if (interaction.replied || interaction.deferred) return interaction.followUp(reply);
      return interaction.reply(reply);
    }
    if (!(await isReviewManagerAnywhere(interaction))) {
      const reply = { content: 'مراجعة تسليمات المهمات للمسؤولين فقط.', ephemeral: true };
      if (interaction.replied || interaction.deferred) return interaction.followUp(reply);
      return interaction.reply(reply);
    }
    if (buttonMatch && buttonMatch[1] === 'reject') {
      const modal = new ModalBuilder().setCustomId(`submission:rejectmodal:${submissionId}`).setTitle(`رفض التسليم #${submissionId}`)
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('سبب الرفض (اختياري)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(400).setPlaceholder('اكتب سبب الرفض هنا')));
      return interaction.showModal(modal);
    }
    if (fromModal) await interaction.deferReply({ ephemeral: true });
    else await interaction.deferUpdate();
    const reason = fromModal ? clean(interaction.fields.getTextInputValue('reason') || '', 400) : '';
    const result = await processSubmissionReview(interaction, submissionId, fromModal ? 'rejected' : 'approved', reason);
    const success = result.status === 'approved'
      ? `تم قبول التسليم #${submissionId} وإضافة ${fmt(result.amount)} نقطة. الرصيد الحالي: ${fmt(result.totalAfter)}.`
      : `تم رفض التسليم #${submissionId}${reason ? `؛ السبب: ${reason}` : ''}.`;
    if (fromModal) await interaction.editReply({ content: success });
  } catch (error) {
    console.error('[submission review interactionCreate]', error.stack || error.message || error);
    const message = `تعذر تنفيذ المراجعة: ${clean(error.message || 'خطأ غير معروف', 300)}`;
    try {
      if (interaction.deferred && interaction.isModalSubmit()) await interaction.editReply({ content: message });
      else if (interaction.deferred || interaction.replied) await interaction.followUp({ content: message, ephemeral: true });
      else await interaction.reply({ content: message, ephemeral: true });
    } catch (replyError) { console.error('[submission review reply]', replyError.message); }
  }
});

client.once(Events.ClientReady, () => {
  console.log(`[points-worker] connected as ${client.user.tag}`);
  runTaskMessageSync().catch((error) => console.error('[task message sync startup]', error.message));
  setInterval(() => runTaskMessageSync(), 5 * 60 * 1000).unref();
});
client.on(Events.MessageDelete, async (message) => {
  try {
    if (String(message.channelId || message.channel?.id || '') !== TASKS_CHANNEL_ID) return;
    const result = await deactivateTasksForDeletedMessage({ sql, channelId: TASKS_CHANNEL_ID, messageId: message.id });
    if (result.deactivatedTasks) console.log(`[task message delete] message ${message.id}: deactivated ${result.deactivatedTasks} task(s)`);
  } catch (error) { console.error('[task message delete]', error.message); }
});
client.on(Events.MessageDeleteBulk, async (messages) => {
  for (const message of messages.values()) {
    if (String(message.channelId || message.channel?.id || '') !== TASKS_CHANNEL_ID) continue;
    try {
      const result = await deactivateTasksForDeletedMessage({ sql, channelId: TASKS_CHANNEL_ID, messageId: message.id });
      if (result.deactivatedTasks) console.log(`[task bulk delete] message ${message.id}: deactivated ${result.deactivatedTasks} task(s)`);
    } catch (error) { console.error('[task bulk delete]', error.message); }
  }
});
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || !message.author || message.author.bot || message.webhookId) return;
    if (!TRIGGER.test(normalize(message.content))) return;
    const last = cooldown.get(message.author.id) || 0;
    if (Date.now() - last < 5000) return;
    cooldown.set(message.author.id, Date.now());
    const userId = message.author.id;
    const [total, recent] = await Promise.all([
      sql`SELECT COALESCE(SUM(amount),0) AS total FROM staff_points WHERE user_id = ${userId}`,
      sql`SELECT amount, reason FROM staff_points WHERE user_id = ${userId} ORDER BY id DESC LIMIT 5`,
    ]);
    const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle('⭐ نقاطك').setDescription(`عندك **${fmt(total[0]?.total)}** نقطة`).setFooter({ text: 'إدارة البرج' });
    if (recent.length) embed.addFields({ name: 'آخر الحركات', value: recent.map((r) => `${Number(r.amount) >= 0 ? '➕' : '➖'} ${fmt(Math.abs(Number(r.amount)))} — ${clean(r.reason, 80) || 'بدون سبب'}`).join('\n').slice(0, 1024) });
    await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
  } catch (error) { console.error('[points-worker]', error.message); }
});
client.on('error', (error) => console.error('[points-worker] client error:', error.message));
client.login(TOKEN);
