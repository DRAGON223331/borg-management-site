'use strict';
// يرد على رسالة «نقاطي» (أو mypoints) بدون بريفكس. لازم يشتغل 24/7 على استضافة Node عادية
// (Railway / Render / VPS ...) لأن Vercel Functions مش بتحافظ على اتصال Gateway.
// المتغيرات المطلوبة: DISCORD_BOT_TOKEN و DATABASE_URL (نفس قاعدة بيانات الموقع).
const { Client, GatewayIntentBits, Partials, Events, EmbedBuilder } = require('discord.js');
const { neon } = require('@neondatabase/serverless');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_PRISMA_URL;
if (!TOKEN) throw new Error('DISCORD_BOT_TOKEN غير مضبوط.');
if (!DB_URL) throw new Error('DATABASE_URL غير مضبوط.');
const sql = neon(DB_URL);

const TRIGGER = /^(?:نقاطي|نقاطى|mypoints|my points)$/i;
const cooldown = new Map();
const normalize = (text) => String(text || '').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[!؟?.،,\s]+$/g, '').replace(/\s+/g, ' ').trim();
const fmt = (n) => (Math.round(Number(n || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, () => console.log(`[points-worker] connected as ${client.user.tag}`));
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
