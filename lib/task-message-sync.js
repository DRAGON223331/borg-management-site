'use strict';

const DISCORD_API = 'https://discord.com/api/v10';

async function ensureTaskSyncSchema(sql) {
  await sql`CREATE TABLE IF NOT EXISTS tasks (
    id BIGSERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    points NUMERIC(10,2) NOT NULL DEFAULT 1,
    required BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_message_id TEXT,
    source_line_index INTEGER,
    source_message_deleted_at TIMESTAMPTZ,
    UNIQUE(source_message_id, source_line_index)
  )`;
  await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_message_id TEXT`;
  await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`;
  await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_message_deleted_at TIMESTAMPTZ`;
}

/**
 * Deactivate website tasks whose source message has been confirmed deleted from Discord.
 * Keeps submissions/points history intact: tasks are soft-deleted by setting active=false.
 */
async function reconcileDeletedTaskMessages({ sql, token = process.env.DISCORD_BOT_TOKEN, channelId = process.env.TASKS_CHANNEL_ID || '1556647204960346215' }) {
  if (!sql) throw new Error('قاعدة البيانات غير متاحة.');
  if (!token) throw new Error('DISCORD_BOT_TOKEN غير مضبوط.');
  if (!/^\d{15,22}$/.test(String(channelId || ''))) throw new Error('TASKS_CHANNEL_ID غير مضبوط.');

  await ensureTaskSyncSchema(sql);

  const sourceRows = await sql`SELECT DISTINCT source_message_id FROM tasks WHERE active = TRUE AND source_message_id IS NOT NULL AND source_message_id <> ''`;
  const sourceIds = sourceRows.map((row) => String(row.source_message_id || '')).filter((id) => /^\d{15,22}$/.test(id));
  const result = { checkedMessages: 0, deletedMessages: 0, deactivatedTasks: 0, errors: [] };
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, sourceIds.length) }, async () => {
    while (cursor < sourceIds.length) {
      const messageId = sourceIds[cursor++];
      result.checkedMessages += 1;
      try {
        const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
          headers: { Authorization: `Bot ${token}` },
        });
        if (response.ok) continue;
        let payload = {};
        try { payload = await response.json(); } catch { /* body may be empty */ }
        // Only Discord's Unknown Message (10008) is proof of deletion. Unknown channel,
        // permission errors, rate limits, and transient errors must never remove website tasks.
        if (response.status === 404 && Number(payload?.code) === 10008) {
          const rows = await sql`UPDATE tasks SET active = FALSE, source_message_deleted_at = NOW() WHERE source_message_id = ${messageId} AND active = TRUE RETURNING id`;
          result.deletedMessages += 1;
          result.deactivatedTasks += rows.length;
        } else if (!response.ok) {
          result.errors.push({ messageId, status: response.status, code: payload?.code || null });
        }
      } catch (error) {
        result.errors.push({ messageId, error: String(error?.message || error).slice(0, 160) });
      }
    }
  });
  await Promise.all(workers);
  return result;
}

async function deactivateTasksForDeletedMessage({ sql, channelId, messageId }) {
  if (!sql || !/^\d{15,22}$/.test(String(messageId || ''))) return { deactivatedTasks: 0 };
  await ensureTaskSyncSchema(sql);
  const rows = await sql`UPDATE tasks SET active = FALSE, source_message_deleted_at = NOW() WHERE source_message_id = ${String(messageId)} AND active = TRUE RETURNING id`;
  return { deactivatedTasks: rows.length };
}

module.exports = { reconcileDeletedTaskMessages, deactivateTasksForDeletedMessage, ensureTaskSyncSchema };
