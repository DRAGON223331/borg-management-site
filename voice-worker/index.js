'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client, GatewayIntentBits, Events } = require('discord.js');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const API_KEY = process.env.VOICE_API_KEY;
const GUILD_ID = String(process.env.VOICE_GUILD_ID || process.env.STAFF_GUILD_ID || '1556647204255568063');
const PORT = Math.max(1, Number(process.env.PORT || 3000));
// A public URL must be assigned/routed by the hosting platform; the process
// cannot turn its private listening port into an internet-facing hostname.
function detectPublicBaseUrl() {
  const candidates = [
    process.env.VOICE_WORKER_PUBLIC_URL,
    process.env.PELLA_PUBLIC_URL,
    process.env.SERVICE_URL,
    process.env.PUBLIC_URL,
    process.env.APP_URL,
    process.env.RENDER_EXTERNAL_URL,
    process.env.RAILWAY_PUBLIC_DOMAIN
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const parsed = new URL(withScheme);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return parsed.origin.replace(/\/$/, '');
      }
    } catch { /* Ignore malformed platform variables. */ }
  }
  return null;
}
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'voice-stats.json');
const HEARTBEAT_MS = 30_000;
const CAIRO_OFFSET_MS = 2 * 60 * 60 * 1000;

if (!TOKEN) throw new Error('Missing DISCORD_BOT_TOKEN environment variable.');
if (!API_KEY || API_KEY.length < 24) throw new Error('Set VOICE_API_KEY to a random secret of at least 24 characters.');

let store = { version: 1, guildId: GUILD_ID, updatedAt: null, lastHeartbeatAt: null, sessions: [] };
let saveQueue = Promise.resolve();
let ready = false;

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function cleanName(value, fallback) { return String(value || fallback).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100); }
function isVoiceChannel(channel) { return Boolean(channel && (channel.isVoiceBased?.() || channel.type === 13)); }
function activeSession(userId) { return store.sessions.find(s => s.userId === String(userId) && !s.endedAt); }

async function persist() {
  store.updatedAt = new Date().toISOString();
  const snapshot = JSON.stringify(store, null, 2);
  saveQueue = saveQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, DATA_FILE);
  });
  return saveQueue;
}
async function loadStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    if (parsed && parsed.version === 1 && Array.isArray(parsed.sessions)) {
      store = { version: 1, guildId: GUILD_ID, updatedAt: parsed.updatedAt || null, lastHeartbeatAt: parsed.lastHeartbeatAt || null, sessions: parsed.sessions.filter(s => s && s.userId && s.joinedAt) };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
      await fs.rename(DATA_FILE, backup).catch(() => {});
      console.error(`[storage] Invalid JSON moved aside to ${backup}:`, error.message);
    }
  }
}
function openSession(member, channelId, at = new Date().toISOString()) {
  const userId = String(member.id);
  const existing = activeSession(userId);
  if (existing) {
    if (existing.channelId === String(channelId)) return false;
    existing.endedAt = at;
  }
  store.sessions.push({ userId, username: cleanName(member.user?.globalName || member.user?.username, userId), channelId: String(channelId), joinedAt: at, endedAt: null });
  return true;
}
function closeSession(userId, at = new Date().toISOString()) {
  const existing = activeSession(userId);
  if (!existing) return false;
  const end = new Date(at).getTime();
  const start = new Date(existing.joinedAt).getTime();
  existing.endedAt = new Date(Math.max(start, end)).toISOString();
  return true;
}
function cairoDayStart(nowMs) {
  const shifted = new Date(nowMs + CAIRO_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return shifted.getTime() - CAIRO_OFFSET_MS;
}
function calculateMember(userId, nowMs) {
  const sessions = store.sessions.filter(s => s.userId === String(userId));
  const windows = {};
  for (const hours of [24, 42, 72]) {
    const from = nowMs - hours * 60 * 60 * 1000;
    let durationMs = 0;
    for (const s of sessions) {
      const start = new Date(s.joinedAt).getTime();
      const end = s.endedAt ? new Date(s.endedAt).getTime() : nowMs;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      durationMs += Math.max(0, Math.min(end, nowMs) - Math.max(start, from));
    }
    windows[`${hours}h`] = durationMs;
  }
  const dayStart = cairoDayStart(nowMs);
  let todayMs = 0;
  for (const s of sessions) {
    const start = new Date(s.joinedAt).getTime();
    const end = s.endedAt ? new Date(s.endedAt).getTime() : nowMs;
    if (Number.isFinite(start) && Number.isFinite(end)) todayMs += Math.max(0, Math.min(end, nowMs) - Math.max(start, dayStart));
  }
  const current = activeSession(userId);
  const latest = sessions[sessions.length - 1];
  return {
    userId: String(userId), username: latest?.username || String(userId),
    durationMs: todayMs, inVoice: Boolean(current), channelId: current?.channelId || null,
    windows, voice24hMs: windows['24h'], voice42hMs: windows['42h'], voice72hMs: windows['72h']
  };
}
function buildSnapshot() {
  const now = Date.now();
  const ids = new Set(store.sessions.map(s => String(s.userId)));
  const members = [...ids].map(id => calculateMember(id, now)).sort((a, b) => b.voice72hMs - a.voice72hMs);
  const heartbeat = store.lastHeartbeatAt ? new Date(store.lastHeartbeatAt).getTime() : 0;
  const ageSeconds = heartbeat ? Math.max(0, Math.floor((now - heartbeat) / 1000)) : null;
  return {
    available: ready && heartbeat > 0 && ageSeconds <= 120,
    reason: !ready ? 'worker-not-ready' : (!heartbeat ? 'no-heartbeat' : (ageSeconds > 120 ? 'stale-heartbeat' : null)),
    lastSeenAt: heartbeat ? new Date(heartbeat).toISOString() : null,
    ageSeconds, dailyDate: new Date(cairoDayStart(now) + CAIRO_OFFSET_MS).toISOString().slice(0, 10),
    generatedAt: new Date(now).toISOString(), guildId: GUILD_ID,
    members, storage: 'json'
  };
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates] });
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const guildId = String(newState.guild?.id || oldState.guild?.id || '');
    if (guildId !== GUILD_ID) return;
    const member = newState.member || oldState.member;
    if (!member || member.user?.bot) return;
    const oldChannel = oldState.channelId ? String(oldState.channelId) : null;
    const newChannel = newState.channelId && isVoiceChannel(newState.channel) ? String(newState.channelId) : null;
    if (oldChannel === newChannel) return;
    const now = new Date().toISOString();
    if (oldChannel) closeSession(member.id, now);
    if (newChannel) openSession(member, newChannel, now);
    await persist();
    console.log(`[voice] ${member.user.username} ${newChannel ? `joined ${newChannel}` : 'left voice'}`);
  } catch (error) { console.error('[voice-state]', error); }
});

client.once(Events.ClientReady, async () => {
  console.log(`[discord] Connected as ${client.user.tag}; guild=${GUILD_ID}`);
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.channels.fetch();
    await guild.members.fetch();
    // End any sessions left open by a previous process at its last heartbeat. Do not count downtime.
    const stopAt = store.lastHeartbeatAt || new Date().toISOString();
    for (const s of store.sessions) if (!s.endedAt) {
      const start = new Date(s.joinedAt).getTime();
      s.endedAt = new Date(Math.max(start, new Date(stopAt).getTime())).toISOString();
    }
    // Re-open sessions for members who are currently in voice after restart.
    for (const channel of guild.channels.cache.values()) {
      if (!isVoiceChannel(channel)) continue;
      for (const member of channel.members.values()) {
        if (member.user && !member.user.bot) openSession(member, channel.id);
      }
    }
    store.lastHeartbeatAt = new Date().toISOString();
    await persist();
    ready = true;
    console.log('[voice] Initial voice state reconciled and JSON saved.');
  } catch (error) {
    console.error('[voice] Initial reconciliation failed:', error);
  }
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200); return res.end(JSON.stringify({ ok: true, ready, bot: client.user?.tag || null }));
  }
  if (req.method === 'GET' && url.pathname === '/voice-time') {
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!safeEqual(auth, API_KEY)) { res.writeHead(401); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    const snapshot = buildSnapshot();
    res.writeHead(snapshot.available ? 200 : 503);
    return res.end(JSON.stringify(snapshot));
  }
  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

(async () => {
  await loadStore();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[http] Voice API listening on 0.0.0.0:${PORT}`);
    const publicBaseUrl = detectPublicBaseUrl();
    if (publicBaseUrl) {
      console.log(`[http] Public Voice API URL: ${publicBaseUrl}/voice-time`);
      console.log(`[http] Health check URL: ${publicBaseUrl}/health`);
      console.log('[http] Set Vercel VOICE_WORKER_URL to the base URL above (without /voice-time).');
    } else {
      console.log('[http] Public URL not detected. Pella must expose this service/port and assign a public domain.');
      console.log('[http] Once Pella assigns it, set VOICE_WORKER_PUBLIC_URL to that base URL to print it here.');
      console.log('[http] The local 0.0.0.0 address is not a public URL and must not be used in Vercel.');
    }
  });
  setInterval(async () => {
    if (!client.isReady()) return;
    store.lastHeartbeatAt = new Date().toISOString();
    try { await persist(); } catch (error) { console.error('[storage] heartbeat save failed:', error); }
  }, HEARTBEAT_MS).unref();
  await client.login(TOKEN);
})().catch(error => { console.error(error); process.exit(1); });

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  try { store.lastHeartbeatAt = new Date().toISOString(); await persist(); } catch (error) { console.error('[shutdown-save]', error); }
  server.close();
  client.destroy();
  process.exit(0);
});
