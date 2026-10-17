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
const { isWebsiteNotificationMessage, isStaffChatNotificationMessage, formatClearNotificationsSummary } = require('../lib/website-dm-notifications.js');
const CLEAR_STAFF_CHAT_COMMANDS = ['clear-staff-chat-notifications', 'مسح-تنبيهات-شات-الاستاف'];
const CLEAR_ALL_NOTIFICATION_COMMANDS = ['clear-site-notifications', 'مسح-تنبيهات-الموقع', 'clear-bot-dms', 'مسح-رسائل-الخاص'];

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
const MANAGEMENT_STAFF_ROLE_ID = process.env.MANAGEMENT_STAFF_ROLE_ID || '1559628523809804288';
const SITE_OWNER_IDS = new Set(['848304089057460254', '1286035404323164172']);
const cooldown = new Map();
const normalize = (text) => String(text || '').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[!؟?.،,\s]+$/g, '').replace(/\s+/g, ' ').trim();
const fmt = (n) => (Math.round(Number(n || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

let presenceSchemaPromise;
let presenceSnapshotReady = false;
let presenceSnapshotRunning = false;
const validPresenceStatuses = new Set(['online', 'idle', 'dnd', 'offline']);
function normalizePresenceStatus(status) {
  // Missing data is not proof that a member is offline.
  return validPresenceStatuses.has(status) ? status : null;
}
function getMemberPresenceStatus(guild, member) {
  // The live cache wins: a PresenceUpdate may arrive while a bulk snapshot is loading.
  // A missing presence stays unknown instead of being guessed as Offline.
  const cachedStatus = guild?.presences?.cache?.get(String(member?.id))?.status;
  if (validPresenceStatuses.has(cachedStatus)) return cachedStatus;
  const memberStatus = member?.presence?.status;
  return normalizePresenceStatus(memberStatus);
}
async function ensureDiscordPresenceSchema() {
  if (!presenceSchemaPromise) {
    presenceSchemaPromise = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS discord_presence (
        guild_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','idle','dnd','offline')),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (guild_id, user_id)
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_discord_presence_guild_status ON discord_presence(guild_id, status)`;
      await sql`CREATE TABLE IF NOT EXISTS discord_presence_activity (
        guild_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT NOT NULL DEFAULT '',
        activity_type TEXT NOT NULL DEFAULT 'message' CHECK (activity_type IN ('message','voice')),
        last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (guild_id, user_id)
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_discord_presence_activity_recent ON discord_presence_activity(guild_id, last_activity_at DESC)`;
      await sql`CREATE TABLE IF NOT EXISTS discord_presence_meta (guild_id TEXT PRIMARY KEY, last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_sync_at TIMESTAMPTZ, last_error TEXT, member_count INTEGER NOT NULL DEFAULT 0, known_count INTEGER NOT NULL DEFAULT 0)`;
      await sql`ALTER TABLE discord_presence_meta ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ`;
      await sql`ALTER TABLE discord_presence_meta ADD COLUMN IF NOT EXISTS last_error TEXT`;
      await sql`ALTER TABLE discord_presence_meta ADD COLUMN IF NOT EXISTS member_count INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE discord_presence_meta ADD COLUMN IF NOT EXISTS known_count INTEGER NOT NULL DEFAULT 0`;
    })().catch((error) => { presenceSchemaPromise = null; throw error; });
  }
  return presenceSchemaPromise;
}
async function syncStaffPresenceSnapshot() {
  await ensureDiscordPresenceSchema();
  // Timestamp at snapshot start so an in-flight PresenceUpdate always wins over this snapshot.
  const snapshotAt = new Date().toISOString();
  const guild = await client.guilds.fetch(STAFF_GUILD_ID);
  const members = await guild.members.fetch({ withPresences: true });
  const snapshot = [...members.values()]
    .filter((member) => member.user && !member.user.bot)
    .map((member) => ({
      user_id: String(member.id),
      username: String(member.user.globalName || member.user.username || member.id).slice(0, 100),
      status: getMemberPresenceStatus(guild, member),
      updated_at: snapshotAt,
    }));
  const rows = snapshot.filter((row) => row.status);
  const missingIds = snapshot.filter((row) => !row.status).map((row) => ({ user_id: row.user_id }));
  // Upsert known statuses. Missing Gateway presence data must not be converted into
  // Offline; remove any older value for those members so the UI can show "unknown".
  if (rows.length) {
    await sql`INSERT INTO discord_presence(guild_id, user_id, username, status, updated_at)
      SELECT ${STAFF_GUILD_ID}, r.user_id, r.username, r.status, r.updated_at::timestamptz
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(user_id text, username text, status text, updated_at text)
      ON CONFLICT (guild_id, user_id) DO UPDATE SET username = EXCLUDED.username, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
      WHERE discord_presence.updated_at <= EXCLUDED.updated_at`;
  }
  if (missingIds.length) {
    await sql`DELETE FROM discord_presence AS p
      USING jsonb_to_recordset(${JSON.stringify(missingIds)}::jsonb) AS missing(user_id text)
      WHERE p.guild_id = ${STAFF_GUILD_ID} AND p.user_id = missing.user_id
        AND p.updated_at <= ${snapshotAt}::timestamptz`;
  }
  await sql`INSERT INTO discord_presence_meta(guild_id, last_seen, last_sync_at, last_error, member_count, known_count)
    VALUES (${STAFF_GUILD_ID}, NOW(), NOW(), NULL, ${snapshot.length}, ${rows.length})
    ON CONFLICT (guild_id) DO UPDATE SET last_seen = NOW(), last_sync_at = NOW(), last_error = NULL,
      member_count = EXCLUDED.member_count, known_count = EXCLUDED.known_count`;
  presenceSnapshotReady = true;
  const counts = rows.reduce((result, row) => { result[row.status] = (result[row.status] || 0) + 1; return result; }, {});
  console.log(`[presence] synced snapshot=${snapshot.length} known=${rows.length} unknown=${missingIds.length}: ${JSON.stringify(counts)}`);
}
async function recordPresenceHeartbeat() {
  if (!client.isReady()) return;
  try {
    await ensureDiscordPresenceSchema();
    await sql`INSERT INTO discord_presence_meta(guild_id, last_seen) VALUES (${STAFF_GUILD_ID}, NOW())
      ON CONFLICT (guild_id) DO UPDATE SET last_seen = NOW()`;
  } catch (error) {
    console.error('[presence heartbeat] failed:', error.stack || error.message || error);
  }
}
async function runPresenceSnapshot(label = 'sync') {
  if (presenceSnapshotRunning) return;
  presenceSnapshotRunning = true;
  try {
    await syncStaffPresenceSnapshot();
  } catch (error) {
    const message = String(error?.message || error || 'Unknown presence sync error').slice(0, 500);
    console.error(`[presence ${label}]`, error.stack || message);
    try {
      await ensureDiscordPresenceSchema();
      await sql`INSERT INTO discord_presence_meta(guild_id, last_seen, last_error) VALUES (${STAFF_GUILD_ID}, NOW(), ${message})
        ON CONFLICT (guild_id) DO UPDATE SET last_seen = NOW(), last_error = EXCLUDED.last_error`;
    } catch (metaError) {
      console.error('[presence diagnostic write] failed:', metaError.stack || metaError.message || metaError);
    }
    // If the first snapshot fails, retry soon and keep retrying rather than waiting five minutes.
    if (!presenceSnapshotReady && client.isReady()) {
      const retry = setTimeout(() => { void runPresenceSnapshot('retry'); }, 30_000);
      retry.unref?.();
    }
  } finally {
    presenceSnapshotRunning = false;
  }
}
const offlineActivityLastWrite = new Map();
const OFFLINE_ACTIVITY_COOLDOWN_MS = 15_000;
async function recordOfflinePresenceActivity({ guild, member, user, type }) {
  if (!guild || String(guild.id || '') !== STAFF_GUILD_ID || !user || user.bot) return;
  const userId = String(user.id);
  const liveStatus = getMemberPresenceStatus(guild, member || guild.members.cache.get(userId));
  // Discord reports Invisible as Offline. Only mark an activity signal when the current
  // Gateway/cache status or our latest persisted status is Offline; never infer from absence.
  if (liveStatus && liveStatus !== 'offline') return;
  const now = Date.now();
  const lastWrite = offlineActivityLastWrite.get(userId) || 0;
  if (now - lastWrite < OFFLINE_ACTIVITY_COOLDOWN_MS) return;
  try {
    await ensureDiscordPresenceSchema();
    let status = liveStatus;
    if (!status) {
      const saved = await sql`SELECT status FROM discord_presence WHERE guild_id = ${STAFF_GUILD_ID} AND user_id = ${userId} LIMIT 1`;
      status = normalizePresenceStatus(saved[0]?.status);
    }
    if (status !== 'offline') return;
    offlineActivityLastWrite.set(userId, now);
    await sql`INSERT INTO discord_presence_activity(guild_id, user_id, username, activity_type, last_activity_at)
      VALUES (${STAFF_GUILD_ID}, ${userId}, ${String(user.globalName || user.username || userId).slice(0, 100)}, ${type}, NOW())
      ON CONFLICT (guild_id, user_id) DO UPDATE SET username = EXCLUDED.username, activity_type = EXCLUDED.activity_type, last_activity_at = NOW()`;
  } catch (error) {
    console.error('[presence offline activity]', error.message);
  }
}
async function saveDiscordPresence(presence) {
  if (!presence || String(presence.guild?.id || '') !== STAFF_GUILD_ID) return;
  const member = presence.member;
  const user = presence.user || member?.user;
  if (!user || user.bot) return;
  try {
    await ensureDiscordPresenceSchema();
    const status = normalizePresenceStatus(presence.status);
    if (!status) {
      await sql`DELETE FROM discord_presence WHERE guild_id = ${STAFF_GUILD_ID} AND user_id = ${String(user.id)}`;
      await sql`DELETE FROM discord_presence_activity WHERE guild_id = ${STAFF_GUILD_ID} AND user_id = ${String(user.id)}`;
      offlineActivityLastWrite.delete(String(user.id));
      return;
    }
    await sql`INSERT INTO discord_presence(guild_id, user_id, username, status, updated_at)
      VALUES (${STAFF_GUILD_ID}, ${String(user.id)}, ${String(user.globalName || user.username || user.id).slice(0, 100)}, ${status}, NOW())
      ON CONFLICT (guild_id, user_id) DO UPDATE SET username = EXCLUDED.username, status = EXCLUDED.status, updated_at = NOW()`;
    if (status !== 'offline') {
      await sql`DELETE FROM discord_presence_activity WHERE guild_id = ${STAFF_GUILD_ID} AND user_id = ${String(user.id)}`;
      offlineActivityLastWrite.delete(String(user.id));
    }
  } catch (error) { console.error('[presence update]', error.message); }
}
client.on(Events.PresenceUpdate, (_oldPresence, newPresence) => { void saveDiscordPresence(newPresence); });
// A message or voice join while the bot sees a member as Offline is evidence of activity,
// not proof of Invisible. The dashboard labels this explicitly as a recent-activity signal.
client.on(Events.MessageCreate, (message) => {
  if (!message.guild || !message.author || message.author.bot || message.webhookId) return;
  void recordOfflinePresenceActivity({ guild: message.guild, member: message.member, user: message.author, type: 'message' });
});
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (!newState.channelId || newState.channelId === oldState.channelId) return;
  const member = newState.member;
  if (!member?.user) return;
  void recordOfflinePresenceActivity({ guild: newState.guild, member, user: member.user, type: 'voice' });
});
client.on(Events.GuildMemberRemove, async (member) => {
  if (String(member.guild?.id || '') !== STAFF_GUILD_ID) return;
  try {
    await ensureDiscordPresenceSchema();
    await sql`DELETE FROM discord_presence WHERE guild_id = ${STAFF_GUILD_ID} AND user_id = ${String(member.id)}`;
    await sql`DELETE FROM discord_presence_activity WHERE guild_id = ${STAFF_GUILD_ID} AND user_id = ${String(member.id)}`;
    offlineActivityLastWrite.delete(String(member.id));
  } catch (error) { console.error('[presence member leave]', error.message); }
});

async function isReviewManagerAnywhere(interaction) {
  const userId = String(interaction.user?.id || '');
  if (!userId) return false;
  // مالكا الموقع الأساسيان لا يمكن سحب صلاحياتهما من إعدادات الموقع.
  if (SITE_OWNER_IDS.has(userId)) return true;
  try {
    // نفس جدول صلاحيات الموقع المستخدم في الـ API؛ الرفض الصريح يسبق Administrator.
    await sql`CREATE TABLE IF NOT EXISTS site_manager_access (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL CHECK(action IN ('grant','deny')),
      updated_by TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    const overrides = await sql`SELECT action FROM site_manager_access WHERE user_id = ${userId}`;
    const action = overrides[0]?.action || null;
    if (action === 'deny') return false;
    if (action === 'grant') return true;
    const guild = await client.guilds.fetch(MAIN_GUILD_ID);
    const member = await guild.members.fetch(userId);
    return String(guild.ownerId || '') === userId || Boolean(member.permissions.has('Administrator'));
  } catch (error) {
    console.warn('[review permission check]', error?.message || error);
    // تعذر التحقق من الصلاحيات أو قاعدة البيانات: رفض مغلق.
    return false;
  }
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
      .setColor(status === 'approved' ? 0x22c55e : 0xef4444)
      .setFooter({ text: 'إدارة البرج • مراجعة التسليمات' });
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
  if (interaction.isChatInputCommand?.() && [...CLEAR_ALL_NOTIFICATION_COMMANDS, ...CLEAR_STAFF_CHAT_COMMANDS].includes(String(interaction.commandName || ''))) {
    const staffChatOnly = CLEAR_STAFF_CHAT_COMMANDS.includes(String(interaction.commandName || ''));
    const matchesNotification = staffChatOnly ? isStaffChatNotificationMessage : isWebsiteNotificationMessage;
    try {
      if (!(await isReviewManagerAnywhere(interaction))) {
        return interaction.reply({ content: staffChatOnly ? 'أمر مسح تنبيهات شات الاستاف متاح لمسؤولي الإدارة فقط.' : 'أمر مسح تنبيهات الموقع متاح لمسؤولي الإدارة فقط.', ephemeral: true });
      }
      const confirmOption = interaction.options?.data?.find((option) => ['confirm', 'تأكيد'].includes(option.name));
      if (confirmOption?.value !== true) {
        return interaction.reply({ content: staffChatOnly ? 'لم يتم حذف أي رسالة. شغّل الأمر مرة أخرى مع تأكيد حذف تنبيهات شات الاستاف فقط.' : 'لم يتم حذف أي رسالة. شغّل الأمر مرة أخرى مع تأكيد حذف تنبيهات الموقع فقط.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const stats = { recipients: 0, channelsScanned: 0, messagesDeleted: 0, messageErrors: 0, recipientErrors: 0, pagesScanned: 0 };
      try {
        const knownRecipients = staffChatOnly ? [] : await sql`
          SELECT DISTINCT user_id FROM (
            SELECT user_id FROM submissions WHERE user_id IS NOT NULL AND user_id <> ''
            UNION SELECT user_id FROM leave_requests WHERE user_id IS NOT NULL AND user_id <> ''
            UNION SELECT user_id FROM staff_requests WHERE user_id IS NOT NULL AND user_id <> ''
            UNION SELECT user_id FROM staff_points WHERE user_id IS NOT NULL AND user_id <> ''
            UNION SELECT user_id FROM site_presence WHERE last_seen > NOW() - INTERVAL '90 days'
          ) AS website_notification_recipients
        `;
        const recipientSet = new Set(knownRecipients.map((row) => String(row.user_id || '')).filter((id) => /^\d{15,22}$/.test(id)));
        for (const id of (process.env.MANAGER_IDS || '').split(',').map((value) => value.trim())) if (/^\d{15,22}$/.test(id)) recipientSet.add(id);
        for (const id of SITE_OWNER_IDS) recipientSet.add(String(id));
        const recipientIds = [...recipientSet];
        stats.recipients = recipientIds.length;
        const botId = String(client.user?.id || '');
        if (!botId) throw new Error('تعذر تحديد حساب البوت.');

        for (const userId of recipientIds) {
          try {
            const user = await client.users.fetch(userId);
            const dm = await user.createDM();
            stats.channelsScanned += 1;
            let before;
            while (true) {
              const page = await dm.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
              if (!page.size) break;
              stats.pagesScanned += 1;
              const pageItems = [...page.values()];
              for (const message of pageItems) {
                if (String(message.author?.id || '') !== botId || !matchesNotification(message)) continue;
                try {
                  await message.delete();
                  stats.messagesDeleted += 1;
                } catch (error) {
                  if (Number(error?.code) === 10008 || Number(error?.status) === 404) continue;
                  stats.messageErrors += 1;
                }
              }
              const oldestId = String(pageItems[pageItems.length - 1]?.id || '');
              if (!oldestId || oldestId === before || page.size < 100) break;
              before = oldestId;
            }
          } catch (error) {
            stats.recipientErrors += 1;
            console.warn(`[clear bot DMs] recipient ${userId}:`, clean(error?.message || error, 160));
          }
        }
        return interaction.editReply(formatClearNotificationsSummary(stats, staffChatOnly));
      } catch (error) {
        console.error('[clear bot DMs command]', error.stack || error.message || error);
        return interaction.editReply(`تعذر إكمال مسح رسائل الخاص: ${clean(error?.message || error, 160)}`);
      }
    } catch (error) {
      console.error('[clear bot DMs command interaction]', error.stack || error.message || error);
      try {
        if (interaction.deferred || interaction.replied) return interaction.followUp({ content: `تعذر تنفيذ الأمر: ${clean(error?.message || error, 160)}`, ephemeral: true });
        return interaction.reply({ content: `تعذر تنفيذ الأمر: ${clean(error?.message || error, 160)}`, ephemeral: true });
      } catch { return; }
    }
  }
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
  console.log(`[presence] target guild=${STAFF_GUILD_ID}; database configured=${Boolean(DB_URL)}`);
  // Record worker liveness separately from successful presence sync. This lets the monitor
  // distinguish a stopped process from a running worker whose first member fetch failed.
  void recordPresenceHeartbeat();
  void runPresenceSnapshot('startup');
  setInterval(() => {
    if (client.isReady()) void runPresenceSnapshot('periodic');
  }, 5 * 60 * 1000).unref();
  setInterval(() => { void recordPresenceHeartbeat(); }, 60 * 1000).unref();
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
client.login(TOKEN).catch((error) => {
  const message = String(error?.message || error || 'Unknown Discord login error');
  console.error('[points-worker] Discord Gateway login failed:', message);
  if (/disallowed.?intents|4014|privileged intent/i.test(message)) {
    console.error('[presence] افتح Discord Developer Portal → Bot → Privileged Gateway Intents وفعّل Server Members Intent وPresence Intent، ثم أعد تشغيل الـ worker.');
  }
  process.exitCode = 1;
});
