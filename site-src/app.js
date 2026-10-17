import { upload as uploadToBlob } from '@vercel/blob/client';

'use strict';

const state = {
  user: null,
  tasks: [],
  roster: { groups: [], memberCount: 0 },
  queue: [],
  queueNextId: 1,
  filter: 'all',
  selectedTaskIds: new Set(),
  chatMessages: { staff: [], management: [] },
  chatMessageIds: { staff: new Set(), management: new Set() },
  chatLoaded: { staff: false, management: false },
  chatDeletionCursor: { staff: 0, management: 0 },
  onlineUserIds: new Set(),
  discordStatuses: {},
  discordPresenceAvailable: false,
  discordPresenceMeta: { lastSeenAt: null, ageSeconds: null },
  dailyMessageStats: { dailyStats: [], dailyTotal: 0, dailyDate: null },
  staffStats: [],
  notif: { items: [], unread: 0, maxId: null, open: false },
  lbMetric: 'points',
  ratings: { items: [], loaded: false, scope: 'admins', sort: 'avg-desc', search: '', targetId: null, selected: 0, justAddedId: null, detail: {} },
  audit: { entries: [], nextBefore: null, hasMore: false, loading: false },
  activeStaffProfileId: null,
  profileVoiceTime: {},
  cyberTrendPeriod: '24h',
  monitor: { health: null, summary: null, roster: null, staffStats: [], presence: null, voiceTime: null, voiceTimeFetchedAt: null, taskStats: null, audit: [], reviewAudit: [], leaveRequests: [], staffRequests: [], loadErrors: [], updatedAt: null, memberLimit: 100 },
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function formatDate(value, options = {}) {
  try { return new Intl.DateTimeFormat('ar-EG', options).format(new Date(value)); }
  catch { return String(value || ''); }
}
function formatTime(value) {
  return formatDate(value, { hour: '2-digit', minute: '2-digit' });
}
function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function avatarFallback(name) {
  return `https://cdn.discordapp.com/embed/avatars/${String(name || '0').length % 6}.png`;
}
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $('#toast-region').appendChild(toast);
  setTimeout(() => toast.remove(), 4300);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options
  });

  const contentType = response.headers.get('content-type') || '';
  let data;

  if (contentType.includes('application/json')) {
    data = await response.json();
  } else {
    const text = await response.text();
    data = { error: text };
  }

  // عدم وجود جلسة عند فتح الموقع لأول مرة أمر طبيعي.
  if (
    url.split('?')[0] === '/api/me' &&
    response.status === 401
  ) {
    return { authenticated: false };
  }

  if (!response.ok) {
    if (response.status === 401 && state.user) {
      state.user = null;
      showLogin();
    }

    throw new Error(data.error || 'حصل خطأ في الطلب.');
  }

  return data;
}

function setButtonLoading(button, loading, text = 'جاري التنفيذ...') {
  if (!button) return;
  if (loading) {
    button.dataset.oldText = button.innerHTML;
    button.disabled = true;
    button.textContent = text;
  } else {
    button.disabled = false;
    if (button.dataset.oldText) button.innerHTML = button.dataset.oldText;
    delete button.dataset.oldText;
  }
}
const APPEARANCE_KEY = 'borg-cyber-appearance-v1';
const ACCENT_PRESETS = ['red', 'crimson', 'ember', 'blue', 'cyan', 'violet', 'emerald', 'gold', 'pink'];
const DEFAULT_CUSTOM_COLOR = '#dd2f2e';
const DEFAULT_APPEARANCE = { accent: 'red', custom: DEFAULT_CUSTOM_COLOR, motion: 'strong', scanlines: true };
const CUSTOM_THEME_KEYS = ['--neon-a', '--neon-a-rgb', '--neon-b', '--neon-b-rgb', '--neon-c', '--neon-c-rgb', '--neon-lime', '--purple', '--purple-bright', '--blue', '--bg-deep', '--bg-deep-2', '--tint-rgb', '--bg', '--surface', '--surface-2', '--surface-3', '--text', '--muted', '--muted-2', '--accent-text', '--accent-pale', '--accent-btn-1', '--accent-btn-2'];
function isHexColor(value) { return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value); }
function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s, l };
}
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}
function hslColor(h, s, l) {
  const rgb = hslToRgb(h, Math.min(1, Math.max(0, s)), Math.min(1, Math.max(0, l)));
  return { rgb: rgb.join(','), hex: `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}` };
}
function buildCustomThemeVars(hex) {
  const base = hexToHsl(hex);
  const gray = base.s < 0.08;
  const h = base.h;
  const s = gray ? base.s : Math.max(base.s, 0.55);
  const l = Math.min(Math.max(base.l, 0.42), 0.62);
  const bgSat = gray ? 0.04 : 0.32;
  const a = hslColor(h, s, l), b = hslColor(h, s, Math.min(0.8, l + 0.16)), c = hslColor(h, s, 0.27);
  const text = hslColor(h, s, 0.76), pale = hslColor(h, gray ? s : 0.9, 0.87);
  const btn1 = hslColor(h, s, Math.max(0.36, l - 0.05)), btn2 = hslColor(h, s, Math.max(0.24, l - 0.2));
  const bgDeep = hslColor(h, bgSat, 0.032), bgDeep2 = hslColor(h, bgSat, 0.05), tint = hslColor(h, bgSat + 0.06, 0.06);
  const surface = hslColor(h, bgSat - 0.04, 0.07), surface2 = hslColor(h, bgSat - 0.06, 0.095), surface3 = hslColor(h, bgSat - 0.08, 0.135);
  return {
    '--neon-a': a.hex, '--neon-a-rgb': a.rgb, '--neon-b': b.hex, '--neon-b-rgb': b.rgb, '--neon-c': c.hex, '--neon-c-rgb': c.rgb, '--neon-lime': text.hex,
    '--purple': a.hex, '--purple-bright': b.hex, '--blue': b.hex,
    '--bg-deep': bgDeep.hex, '--bg-deep-2': bgDeep2.hex, '--tint-rgb': tint.rgb, '--bg': bgDeep.hex,
    '--surface': surface.hex, '--surface-2': surface2.hex, '--surface-3': surface3.hex,
    '--text': hslColor(h, gray ? 0 : 0.4, 0.96).hex, '--muted': hslColor(h, gray ? 0 : 0.12, 0.7).hex, '--muted-2': hslColor(h, gray ? 0 : 0.1, 0.55).hex,
    '--accent-text': text.hex, '--accent-pale': pale.hex, '--accent-btn-1': btn1.hex, '--accent-btn-2': btn2.hex,
  };
}
function readAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}');
    const custom = isHexColor(saved.custom) ? saved.custom.toLowerCase() : DEFAULT_APPEARANCE.custom;
    return {
      accent: ACCENT_PRESETS.includes(saved.accent) || saved.accent === 'custom' ? saved.accent : DEFAULT_APPEARANCE.accent,
      custom,
      motion: ['strong', 'balanced', 'calm'].includes(saved.motion) ? saved.motion : DEFAULT_APPEARANCE.motion,
      scanlines: typeof saved.scanlines === 'boolean' ? saved.scanlines : DEFAULT_APPEARANCE.scanlines,
    };
  } catch { return { ...DEFAULT_APPEARANCE }; }
}
function applyAppearance(appearance = readAppearance()) {
  const root = document.documentElement;
  root.dataset.accent = appearance.accent;
  root.dataset.motion = appearance.motion;
  root.dataset.scanlines = String(appearance.scanlines);
  if (appearance.accent === 'custom') {
    const vars = buildCustomThemeVars(appearance.custom);
    CUSTOM_THEME_KEYS.forEach((key) => root.style.setProperty(key, vars[key]));
  } else {
    CUSTOM_THEME_KEYS.forEach((key) => root.style.removeProperty(key));
  }
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) { const color = getComputedStyle(root).getPropertyValue('--accent-btn-2').trim(); if (color) themeMeta.setAttribute('content', color); }
  const customInput = $('#appearance-custom-color'); if (customInput) customInput.value = appearance.custom;
  $$('[data-accent-choice]').forEach((button) => { const active = button.dataset.accentChoice === appearance.accent; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); });
  $$('[data-motion-choice]').forEach((button) => { const active = button.dataset.motionChoice === appearance.motion; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); });
  const scanlines = $('#appearance-scanlines'); if (scanlines) scanlines.checked = appearance.scanlines;
}
function saveAppearance(patch) {
  const next = { ...readAppearance(), ...patch };
  const toStore = { ...next };
  if (next.accent === 'custom') toStore.customVars = buildCustomThemeVars(next.custom); // lets index.html paint the saved theme before app.js loads
  try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(toStore)); } catch { /* Privacy mode may disable persistent storage; keep the current session styling. */ }
  applyAppearance(next);
}
function wireAppearanceControls() {
  const modal = $('#appearance-modal');
  const opener = $('#appearance-open');
  const closeButton = $('#appearance-close');
  if (!modal || modal.dataset.wired === '1') return;
  modal.dataset.wired = '1';
  const close = () => { modal.classList.add('hidden'); document.body.classList.remove('appearance-modal-open'); opener?.focus(); };
  opener?.addEventListener('click', () => { modal.classList.remove('hidden'); document.body.classList.add('appearance-modal-open'); applyAppearance(); closeButton?.focus(); });
  closeButton?.addEventListener('click', close);
  modal.querySelectorAll('[data-appearance-close]').forEach((button) => button.addEventListener('click', close));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !modal.classList.contains('hidden')) close(); });
  $$('[data-accent-choice]').forEach((button) => {
    button.addEventListener('click', () => saveAppearance({ accent: button.dataset.accentChoice }));
    button.addEventListener('keydown', (event) => { if (button.tagName !== 'BUTTON' && (event.key === 'Enter' || event.key === ' ') && event.target === button) { event.preventDefault(); saveAppearance({ accent: button.dataset.accentChoice }); } });
  });
  const customColor = $('#appearance-custom-color');
  if (customColor) {
    customColor.addEventListener('input', () => { if (isHexColor(customColor.value)) saveAppearance({ accent: 'custom', custom: customColor.value.toLowerCase() }); });
    customColor.addEventListener('keydown', (event) => event.stopPropagation());
  }
  $$('[data-motion-choice]').forEach((button) => button.addEventListener('click', () => saveAppearance({ motion: button.dataset.motionChoice })));
  $('#appearance-scanlines')?.addEventListener('change', (event) => saveAppearance({ scanlines: event.currentTarget.checked }));
  $('#appearance-reset')?.addEventListener('click', () => { try { localStorage.removeItem(APPEARANCE_KEY); } catch {} applyAppearance({ ...DEFAULT_APPEARANCE }); showToast('تمت إعادة ضبط إعدادات المظهر.', 'success'); });
  applyAppearance();
}
function wireRosterCollapse() {
  const panel = $('.staff-panel');
  const button = $('#roster-collapse');
  if (!panel || !button || button.dataset.wired === '1') return;
  button.dataset.wired = '1';
  button.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('roster-collapsed');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.textContent = collapsed ? 'عرض القائمة +' : 'طي القائمة −';
  });
}
// ───────── أرقام متحركة (Odometer): لفوق لو زادت، ولتحت لو نقصت ─────────
const rollPrev = new Map();
function rollMotionOff() { return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'calm'); }
function rollFormat(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '—');
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
const rollDigits = (value) => (Number.isInteger(Number(value)) ? 0 : 2);
function rollNumeric(text) { const n = parseFloat(String(text).replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; }
function rollBuild(node, from, to) {
  if (!node) return;
  if (rollMotionOff() || from === to) { node.textContent = to; return; }
  const up = rollNumeric(to) >= rollNumeric(from);
  const len = Math.max(from.length, to.length);
  const A = [...from]; while (A.length < len) A.unshift('');
  const B = [...to]; while (B.length < len) B.unshift('');
  let html = '';
  for (let i = 0; i < len; i += 1) {
    if (A[i] === B[i]) { html += `<span class="roll-ch">${escapeHtml(B[i])}</span>`; continue; }
    const delay = (len - 1 - i) * 40; // الآحاد تتحرك الأول
    html += `<span class="roll-col ${up ? 'up' : 'down'}" style="--d:${delay}ms"><span class="roll-track"><span>${escapeHtml(up ? A[i] : B[i])}</span><span>${escapeHtml(up ? B[i] : A[i])}</span></span></span>`;
  }
  node.classList.add('roll');
  node.classList.remove('is-up', 'is-down');
  void node.offsetWidth;
  node.classList.add(up ? 'is-up' : 'is-down');
  node.innerHTML = html;
  node.setAttribute('aria-label', to);
  clearTimeout(node._rollTimer);
  node._rollTimer = setTimeout(() => node.classList.remove('is-up', 'is-down'), 1700);
}
// للعناصر الثابتة في الصفحة (بتفتكر آخر قيمة لوحدها)
function rollSet(node, value, digits = 0) {
  if (!node) return;
  const to = rollFormat(value, digits);
  if (to === '—' || !Number.isFinite(Number(value))) { node.textContent = to; return; }
  const from = node.dataset.rollText;
  node.dataset.rollText = to;
  if (from === to) return;
  rollBuild(node, from === undefined ? rollFormat(0, digits) : from, to);
}
// للقوائم اللي بتتعمل لها innerHTML من جديد: بنفتكر آخر قيمة بمفتاح ثابت
function rollMarkup(key, value, digits = rollDigits(value)) {
  const to = rollFormat(value, digits);
  const prev = rollPrev.get(key);
  rollPrev.set(key, to);
  const from = prev === undefined ? rollFormat(0, digits) : prev;
  return `<span class="roll" data-roll-from="${escapeHtml(from)}" data-roll-to="${escapeHtml(to)}">${escapeHtml(to)}</span>`;
}
function rollPlay(root = document) {
  $$('.roll[data-roll-to]', root).forEach((node) => {
    const from = node.dataset.rollFrom;
    const to = node.dataset.rollTo;
    delete node.dataset.rollFrom;
    delete node.dataset.rollTo;
    if (from !== to) rollBuild(node, from, to);
  });
}
function rollReset(prefix) { for (const key of [...rollPrev.keys()]) if (key.startsWith(prefix)) rollPrev.delete(key); }
// FLIP: الصفوف اللي ترتيبها بيتغير بتتحرك لفوق/لتحت بدل ما تقفز
function flipCapture(container, attr) {
  const positions = new Map();
  if (container) $$(`[${attr}]`, container).forEach((el) => positions.set(el.getAttribute(attr), el.getBoundingClientRect().top));
  return positions;
}
function flipPlay(container, attr, before) {
  if (!container || !before?.size || rollMotionOff() || typeof Element.prototype.animate !== 'function') return;
  $$(`[${attr}]`, container).forEach((el) => {
    const old = before.get(el.getAttribute(attr));
    if (old === undefined) return;
    const dy = old - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 2) return;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 650, easing: 'cubic-bezier(.22,1,.36,1)' });
  });
}
function animateCounter(node, target) {
  if (!node) return;
  if (!Number.isFinite(Number(target))) { node.textContent = String(target ?? '—'); return; }
  rollSet(node, target, 0);
}

function showLogin() {
  $('#app-shell').classList.add('hidden');
  $('#fatal-screen').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
}
function showFatal(message) {
  $('#app-shell').classList.add('hidden');
  $('#login-screen').classList.add('hidden');
  $('#fatal-message').textContent = message;
  $('#fatal-screen').classList.remove('hidden');
}
function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#fatal-screen').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
}

async function initialize() {
  $('#footer-year').textContent = new Date().getFullYear();
  $('#today-date').textContent = formatDate(new Date(), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  $('#retry-btn')?.addEventListener('click', () => location.reload());
  try {
    const me = await api('/api/me');
    if (!me.authenticated) {
      showLogin();
      return;
    }
    state.user = me.user;
    showApp();
    renderProfile();
    wireNavigation();
    wireAppearanceControls();
    wireRosterCollapse();
    wireTasks();
    wireChats();
    wireRoster();
    wireLeaveRequests();
    wireStaffRequests();
    if (state.user.isOwner) {
      $$('.owner-only').forEach((element) => element.classList.remove('hidden'));
      wireSiteManagerAccess();
    }
    if (state.user.canManage) {
      $('#task-manager').classList.remove('hidden');
      $$('.manager-only').forEach((element) => element.classList.remove('hidden'));
      wireTaskInsights();
      $('#submissions-heading').textContent = 'آخر تسليمات الاستاف';
      $('#manager-leave-section').classList.remove('hidden');
      $('#manager-staff-request-section')?.classList.remove('hidden');
      wireNotifications();
      wireRatings();
    }
    await Promise.allSettled([loadTasks(), loadRoster(), checkBotStatus(), loadSubmissions(), loadMyPoints(), loadLeaveRequests(), loadStaffRequests(), loadStaffStats(), loadNotifications(), ...(state.user.canManage ? [loadTaskInsights(), loadSubmissionAudit(), loadAdminMonitoring({ silent: true })] : [])]);
    startChatPolling();
    startPresenceHeartbeat();
    // تخفيف الضغط على السيرفر: التحديثات الدورية بتقف لما التبويب يتخبى وبتتأخر شوية.
    setInterval(() => { if (!document.hidden) checkBotStatus(); }, 120000);
    setInterval(() => { if (state.user && !document.hidden) loadStaffStats(); }, 90000);
    setInterval(() => {
      if (!document.hidden && $('.page.active-page')?.id === 'page-tasks') loadTasks();
    }, 60000);
    setInterval(() => { if (!document.hidden) loadNotifications(); }, 60000);
    // Refresh the full monitoring board only while it's visible; avoid background API churn.
    setInterval(() => {
      const activePage = $('.page.active-page')?.id;
      if (!document.hidden && state.user?.canManage && ['page-admin-monitor', 'page-overview'].includes(activePage)) loadAdminMonitoring({ silent: true });
    }, 120000);
    setInterval(() => {
      const activePage = $('.page.active-page')?.id;
      if (!document.hidden && state.user?.canManage && ['page-admin-monitor', 'page-overview'].includes(activePage)) void refreshVoiceTime({ silent: true });
    }, 15000);
    setInterval(updateVoiceDurationCounters, 1000);
    setInterval(() => {
      if (document.hidden || !state.user) return;
      const activePage = $('.page.active-page')?.id;
      if (activePage === 'page-staff-profile' && state.activeStaffProfileId) void fetchProfileVoiceTime(state.activeStaffProfileId);
      else if (activePage === 'page-personal') void fetchProfileVoiceTime(state.user.id);
    }, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadNotifications(); });
  } catch (error) {
    showFatal(error.message || 'حصل خطأ أثناء تحميل الموقع.');
  }
}

function renderProfile() {
  const user = state.user;
  $('#top-username').textContent = user.username || user.handle || 'مستخدم ديسكورد';
  $('#top-role').textContent = user.isOwner ? 'مالك الموقع' : user.isManager ? 'مسؤول إدارة' : user.isAdmin ? 'Administrator' : 'عضو الاستاف';
  $('#welcome-name').textContent = user.username || 'يا بطل';
  $('#top-avatar').src = user.avatarUrl || avatarFallback(user.id);
  $('#top-avatar').alt = `صورة ${user.username || 'المستخدم'}`;
}

function wireNavigation() {
  $('#staff-profile-back')?.addEventListener('click', () => { state.activeStaffProfileId = null; openPage('overview'); });
  const chip = $('.profile-chip');
  if (chip) { chip.style.cursor = 'pointer'; chip.title = 'افتح ملفي الكامل'; chip.addEventListener('click', () => state.user?.id && openStaffProfile(state.user.id)); }
  $$('.nav-tab[data-page]').forEach((button) => button.addEventListener('click', () => openPage(button.dataset.page)));
  $$('.nav-menu-item[data-page]').forEach((button) => button.addEventListener('click', () => openPage(button.dataset.page)));
  const menuToggle = $('#management-menu-toggle');
  const menuWrap = $('#management-navigation');
  const menu = $('#management-nav-menu');
  const setMenuOpen = (open) => {
    menu?.classList.toggle('hidden', !open);
    menuWrap?.classList.toggle('is-open', open);
    menuToggle?.setAttribute('aria-expanded', String(open));
  };
  menuToggle?.addEventListener('click', (event) => {
    event.stopPropagation();
    setMenuOpen(menu?.classList.contains('hidden'));
  });
  document.addEventListener('click', (event) => {
    if (menuWrap && !menuWrap.contains(event.target)) setMenuOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu && !menu.classList.contains('hidden')) {
      setMenuOpen(false);
      menuToggle?.focus();
    }
  });
  $('#personal-refresh-btn')?.addEventListener('click', () => loadPersonal(true));
  $$('#lb-tabs [data-lb]').forEach((button) => button.addEventListener('click', () => {
    state.lbMetric = button.dataset.lb;
    $$('#lb-tabs [data-lb]').forEach((item) => item.classList.toggle('active', item === button));
    renderLeaderboard();
  }));
  $('#audit-apply')?.addEventListener('click', () => loadAudit(true));
  $('#audit-refresh')?.addEventListener('click', () => loadAudit(true));
  $('#audit-more')?.addEventListener('click', () => loadAudit(false));
  $('#audit-action')?.addEventListener('change', () => loadAudit(true));
  $('#audit-user')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); loadAudit(true); } });
  $('#audit-search')?.addEventListener('input', () => renderAudit());
  $('#monitor-refresh')?.addEventListener('click', () => loadAdminMonitoring());
  $('#cyber-deck-refresh')?.addEventListener('click', () => loadAdminMonitoring());
  $$('[data-cyber-period]').forEach((button) => button.addEventListener('click', () => {
    state.cyberTrendPeriod = button.dataset.cyberPeriod === '7d' ? '7d' : '24h';
    $$('[data-cyber-period]').forEach((item) => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); });
    renderCyberTrendChart();
  }));
  $('#cyber-open-audit')?.addEventListener('click', () => openPage('audit-log'));
  $('#monitor-audit-refresh')?.addEventListener('click', () => loadAdminMonitoring({ auditOnly: true }));
  $('#monitor-open-audit')?.addEventListener('click', () => openPage('audit-log'));
  $('#monitor-open-tasks')?.addEventListener('click', () => openPage('tasks'));
  $('#monitor-member-search')?.addEventListener('input', () => renderMonitorMembers(true));
  $('#monitor-member-filter')?.addEventListener('change', () => renderMonitorMembers(true));
  $('#monitor-role-filter')?.addEventListener('change', () => renderMonitorMembers(true));
  $('#monitor-member-search-clear')?.addEventListener('click', () => { if ($('#monitor-member-search')) $('#monitor-member-search').value = ''; if ($('#monitor-member-filter')) $('#monitor-member-filter').value = 'all'; if ($('#monitor-role-filter')) $('#monitor-role-filter').value = ''; renderMonitorMembers(true); });
  $('#monitor-members-more')?.addEventListener('click', () => { state.monitor.memberLimit += 100; renderMonitorMembers(false); });
  $('#monitor-export')?.addEventListener('click', exportAdminMonitoringCsv);
  $$('[data-go]').forEach((button) => button.addEventListener('click', () => openPage(button.dataset.go)));
  $('#logout-btn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); }
    catch { /* cookie can expire by itself; still refresh */ }
    location.href = '/';
  });
}
function wireSiteManagerAccess() {
  const form = $('#site-manager-add-form');
  const list = $('#site-manager-list');
  const refresh = $('#site-manager-refresh');
  const blockForm = $('#site-user-block-form');
  const blockedList = $('#site-blocked-user-list');
  if (!form || form.dataset.wired === '1') return;
  form.dataset.wired = '1';
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.user?.isOwner) return;
    const input = $('#site-manager-user-id');
    const userId = String(input?.value || '').trim();
    if (!/^\d{15,22}$/.test(userId)) return showToast('اكتب Discord ID صحيح من 15 إلى 22 رقمًا.', 'error');
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      await api('/api/site-managers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'grant', userId }) });
      if (input) input.value = '';
      showToast('تمت إضافة المسؤول وحفظ الصلاحية.', 'success');
      await loadSiteManagers();
      await loadRoster();
    } catch (error) { showToast(error.message || 'تعذرت إضافة المسؤول.', 'error'); }
    finally { if (submit) submit.disabled = false; }
  });
  refresh?.addEventListener('click', () => loadSiteManagers(true));
  blockForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.user?.isOwner) return;
    const idInput = $('#site-user-block-id');
    const reasonInput = $('#site-user-block-reason');
    const userId = String(idInput?.value || '').trim();
    const reason = String(reasonInput?.value || '').trim();
    if (!/^\d{15,22}$/.test(userId)) return showToast('اكتب Discord ID صحيح من 15 إلى 22 رقمًا.', 'error');
    if (!window.confirm('هل تريد منع هذا الحساب من تسجيل الدخول واستخدام الموقع؟ لن يتم طرده من Discord.')) return;
    const submit = blockForm.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      await api('/api/site-managers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'block', userId, reason }) });
      if (idInput) idInput.value = '';
      if (reasonInput) reasonInput.value = '';
      showToast('تم منع الحساب من استخدام الموقع.', 'success');
      await loadSiteManagers(true);
    } catch (error) { showToast(error.message || 'تعذر منع الحساب من الموقع.', 'error'); }
    finally { if (submit) submit.disabled = false; }
  });
  blockedList?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-site-block-action="unblock"]');
    if (!button || !state.user?.isOwner) return;
    const userId = button.dataset.userId;
    if (!/^\d{15,22}$/.test(String(userId || ''))) return;
    if (!window.confirm('هل تريد السماح لهذا الحساب باستخدام الموقع مرة أخرى؟')) return;
    button.disabled = true;
    try {
      await api('/api/site-managers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'unblock', userId }) });
      showToast('تم رفع المنع عن الحساب.', 'success');
      await loadSiteManagers(true);
    } catch (error) { showToast(error.message || 'تعذر رفع المنع.', 'error'); }
    finally { button.disabled = false; }
  });
  list?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-site-access-action]');
    if (!button || !state.user?.isOwner) return;
    const userId = button.dataset.userId;
    const action = button.dataset.siteAccessAction;
    if (!/^\d{15,22}$/.test(String(userId || '')) || !['deny', 'auto', 'grant'].includes(action)) return;
    const prompt = action === 'deny' ? 'هل تريد سحب صلاحية إدارة الموقع من هذا الحساب؟ سيظل ممنوعًا من الإدارة حتى لو كان معه Administrator في Discord.' : action === 'auto' ? 'هل تريد إزالة الاستثناء وإرجاع الحساب لقواعد Discord التلقائية؟' : 'هل تريد منح هذا الحساب صلاحية إدارة الموقع؟';
    if (!window.confirm(prompt)) return;
    button.disabled = true;
    try {
      await api('/api/site-managers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, userId }) });
      showToast(action === 'deny' ? 'تم سحب صلاحية الموقع.' : action === 'auto' ? 'تمت إعادة الصلاحيات للوضع التلقائي.' : 'تمت إضافة المسؤول.', 'success');
      await loadSiteManagers(true);
      await loadRoster();
    } catch (error) { showToast(error.message || 'تعذر تحديث الصلاحيات.', 'error'); }
    finally { button.disabled = false; }
  });
}

async function loadSiteManagers(force = false) {
  const list = $('#site-manager-list');
  const blockedList = $('#site-blocked-user-list');
  if (!list || !state.user?.isOwner) return;
  list.innerHTML = '<div class="loading-state">جاري التحقق من Administrator والاستثناءات المحفوظة...</div>';
  if (blockedList) blockedList.innerHTML = '<div class="loading-state">جاري تحميل قائمة الممنوعين...</div>';
  try {
    const result = await api('/api/site-managers' + (force ? '?refresh=1' : ''));
    const managers = Array.isArray(result.managers) ? result.managers : [];
    const blockedUsers = Array.isArray(result.blockedUsers) ? result.blockedUsers : [];
    if (!managers.length) {
      list.innerHTML = '<div class="task-empty">لا توجد صلاحيات إدارة مسجلة غير المالكين الثابتين.</div>';
    } else {
      list.innerHTML = managers.map((item) => {
        const isOwner = Boolean(item.isOwner);
        const denied = item.action === 'deny';
        const autoAdmin = Boolean(item.hasAdministrator);
        const status = isOwner ? '<span class="site-manager-tag active">مالك ثابت</span>' : denied ? '<span class="site-manager-tag denied">ممنوع من الإدارة</span>' : item.action === 'grant' ? '<span class="site-manager-tag active">مضاف من المالك</span>' : '<span class="site-manager-tag active">Administrator في Discord</span>';
        const source = !isOwner && autoAdmin ? '<span class="site-manager-tag">Administrator فعلي</span>' : '';
        let actionButton = '';
        if (!isOwner && denied) actionButton = '<button type="button" class="secondary-button compact" data-site-access-action="auto" data-user-id="' + escapeHtml(item.id) + '">إرجاع تلقائي</button>';
        else if (!isOwner) actionButton = '<button type="button" class="danger-button" data-site-access-action="deny" data-user-id="' + escapeHtml(item.id) + '">سحب الصلاحية</button>';
        return '<article class="site-manager-card"><img src="' + escapeHtml(item.avatarUrl || avatarFallback(item.id)) + '" alt=""><div class="site-manager-card-main"><b>' + escapeHtml(item.username || item.id) + '</b><small>' + escapeHtml(item.id) + '</small><div class="site-manager-card-tags">' + status + source + '</div></div>' + actionButton + '</article>';
      }).join('');
    }
    if (blockedList) {
      blockedList.innerHTML = blockedUsers.length ? blockedUsers.map((item) => '<article class="site-manager-card site-blocked-user-card"><img src="' + escapeHtml(item.avatarUrl || avatarFallback(item.id)) + '" alt=""><div class="site-manager-card-main"><b>' + escapeHtml(item.username || item.id) + '</b><small>' + escapeHtml(item.id) + '</small><div class="site-manager-card-tags"><span class="site-manager-tag denied">ممنوع من الموقع</span></div>' + (item.reason ? '<small class="site-blocked-reason">السبب: ' + escapeHtml(item.reason) + '</small>' : '') + '</div><button type="button" class="secondary-button compact" data-site-block-action="unblock" data-user-id="' + escapeHtml(item.id) + '">رفع المنع</button></article>').join('') : '<div class="task-empty">لا يوجد أي حساب ممنوع من الموقع حاليًا.</div>';
    }
  } catch (error) {
    list.innerHTML = '<div class="task-empty">' + escapeHtml(error.message || 'تعذر تحميل قائمة المسؤولين.') + '</div>';
    if (blockedList) blockedList.innerHTML = '<div class="task-empty">' + escapeHtml(error.message || 'تعذر تحميل قائمة الممنوعين.') + '</div>';
  }
}

function openPage(page) {
  if (page === 'management-chat' && !state.user?.canManage) return;
  if (page === 'audit-log' && !state.user?.canManage) return;
  if (page === 'admin-monitor' && !state.user?.canManage) return;
  if (page === 'staff-ratings' && !state.user?.canManage) return;
  if (page === 'site-managers' && !state.user?.isOwner) return;
  if (page === 'staff-profile' && !state.activeStaffProfileId) return;
  $$('.page').forEach((element) => element.classList.remove('active-page'));
  $(`#page-${page}`)?.classList.add('active-page');
  $$('.nav-tab[data-page]').forEach((element) => element.classList.toggle('active', element.dataset.page === page));
  $$('.nav-menu-item[data-page]').forEach((element) => element.classList.toggle('active', element.dataset.page === page));
  const menuHasActivePage = Boolean($(`#management-nav-menu [data-page="${page}"]`));
  $('#management-menu-toggle')?.classList.toggle('active', menuHasActivePage);
  $('#management-nav-menu')?.classList.add('hidden');
  $('#management-navigation')?.classList.remove('is-open');
  $('#management-menu-toggle')?.setAttribute('aria-expanded', 'false');
  if (page === 'staff-chat') { rollReset('daily:'); const totalNode = $('#daily-message-total'); if (totalNode) delete totalNode.dataset.rollText; renderDailyMessageStats(); loadChat('staff'); }
  if (page === 'management-chat') loadChat('management');
  if (page === 'staff-profile') loadStaffProfile(state.activeStaffProfileId);
  if (page === 'personal') loadPersonal();
  if (page === 'leaderboard') { rollReset('lb:'); renderLeaderboard(); loadStaffStats(); }
  if (page === 'staff-ratings') { rollReset('rt:'); const chartBox = $('#rt-charts'); if (chartBox) delete chartBox.dataset.sig; renderRatings(); loadRatings(); loadStaffStats(); }
  if (page === 'audit-log') loadAudit(true);
  if (page === 'admin-monitor') loadAdminMonitoring({ silent: true });
  if (page === 'site-managers' && state.user?.isOwner) loadSiteManagers();
  if (page === 'tasks') {
    loadTasks();
    loadSubmissions();
  }
}

async function checkBotStatus() {
  try {
    const health = await api('/api/health');
    const pill = $('#bot-status');
    const dot = $('.status-dot', pill);
    const ready = Boolean(health.botReady && health.databaseReady && health.storageReady);
    pill.querySelector('span:last-child').textContent = ready ? 'الخدمات جاهزة' : 'الإعدادات ناقصة';
    dot.classList.toggle('offline', !ready);
    pill.title = ready ? 'Discord API وقاعدة البيانات والتخزين جاهزين' : (!health.botReady ? (health.botLastError || 'راجع توكن البوت وصلاحياته') : !health.databaseReady ? 'اربط PostgreSQL بالمشروع من Vercel' : 'أنشئ Blob Store خاصًا واربطه بالمشروع');
  } catch { /* don't disrupt the interface for the status indicator */ }
}

async function loadTasks() {
  try {
    const result = await api('/api/tasks');
    state.tasks = result.tasks || [];
    const existingIds = new Set(state.tasks.map((task) => task.id));
    const lockedIds = new Set(state.tasks.filter((task) => task.completedByMe || task.pendingByMe || task.rejectedByMe).map((task) => task.id));
    state.selectedTaskIds = new Set([...state.selectedTaskIds].filter((id) => existingIds.has(id) && !lockedIds.has(id)));
    animateCounter($('#stat-active'), result.stats.active);
    animateCounter($('#stat-required'), result.stats.required);
    animateCounter($('#stat-done-required'), result.stats.completedRequired);
    animateCounter($('#stat-done'), result.stats.completedByMe);
    $('#filter-all-count').textContent = state.tasks.length;
    $('#filter-required-count').textContent = state.tasks.filter((task) => task.required).length;
    $('#filter-optional-count').textContent = state.tasks.filter((task) => !task.required).length;
    renderTaskList();
    renderOverviewTasks();
    renderSelectedTasks();
  } catch (error) {
    $('#task-list').innerHTML = `<div class="task-empty">${escapeHtml(error.message)}</div>`;
    $('#overview-task-list').innerHTML = `<div class="task-empty">${escapeHtml(error.message)}</div>`;
  }
}

function getFilteredTasks() {
  return state.tasks.filter((task) => {
    if (state.filter === 'required' && !task.required) return false;
    if (state.filter === 'optional' && task.required) return false;
    if (state.filter === 'todo' && task.completedByMe) return false;
    return true;
  });
}
function renderTaskList() {
  const tasks = getFilteredTasks();
  if (!tasks.length) {
    $('#task-list').innerHTML = '<div class="task-empty">مفيش مهمات في التصنيف ده حاليًا.<br>لما الإدارة تنشر مهمات جديدة هتظهر هنا.</div>';
    return;
  }
  $('#task-list').innerHTML = tasks.map((task) => `
    <article class="task-row ${task.completedByMe ? 'task-complete' : ''}" data-task-card="${task.id}">
      <input class="task-select" type="checkbox" data-select-task="${task.id}" aria-label="اختيار المهمة ${escapeHtml(task.title)}" ${state.selectedTaskIds.has(task.id) ? 'checked' : ''} ${task.completedByMe || task.pendingByMe || task.rejectedByMe ? 'disabled' : ''}>
      <div class="task-row-body">
        <div class="task-row-title">${escapeHtml(task.title)}</div>
        <div class="task-row-desc">أُضيفت بواسطة ${escapeHtml(task.created_by_name || 'الإدارة')} · ${formatDate(task.created_at, { day: 'numeric', month: 'short' })}</div>
        <div class="task-row-meta">
          <span class="task-tag ${task.required ? 'required' : 'optional'}">${task.required ? '● مهمة إجبارية' : '○ مهمة اختيارية'}</span>
          <span class="task-id">#${task.id} · ⭐ ${Number(task.points || 0)} نقطة</span>
          ${task.deadline_at ? `<span class="task-tag task-deadline-tag">⏰ تنتهي ${escapeHtml(formatDate(task.deadline_at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' }))}</span>` : ''}
          ${task.redoRequiredByMe ? '<span class="task-tag required">🔁 الإدارة طلبت إعادة المهمة · تم خصم النقاط</span>' : task.completedByMe ? '<span class="task-tag completed">✓ انتهت</span>' : task.pendingByMe ? '<span class="task-tag optional">⏳ بانتظار المراجعة</span>' : task.rejectedByMe ? '<span class="task-tag required">✕ مرفوضة · اتقفلت</span>' : ''}
        </div>
      </div>
      <div class="task-row-actions">
        ${task.redoRequiredByMe ? '<span class="task-complete-label">مطلوب إعادة تسليم المهمة</span>' : task.completedByMe ? '<span class="task-complete-label">انتهت · مينفعش تتسلم تاني</span>' : task.pendingByMe ? '<span class="task-complete-label">متسلمة بانتظار المراجعة</span>' : task.rejectedByMe ? '<span class="task-complete-label">اترفضت · مينفعش تتسلم تاني</span>' : ''}
      ${state.user.canManage ? `<label class="task-points-editor" title="تعديل نقاط المهمة">⭐ <input type="number" min="0" max="100000" step="0.01" value="${Number(task.points || 0)}" data-task-points="${task.id}" aria-label="نقاط المهمة ${task.id}"> <span>نقطة</span></label>` : ''}
      ${state.user.canManage ? `<label class="task-manager-toggle"><input type="checkbox" data-required-toggle="${task.id}" ${task.required ? 'checked' : ''}> إجبارية</label>` : ''}
${state.user.canManage ? `<button type="button" class="task-delete-button" data-delete-task="${task.id}" aria-label="حذف المهمة ${task.id}">🗑️ حذف</button>` : ''}
      </div>
    </article>
  `).join('');

  $$('[data-select-task]').forEach((checkbox) => checkbox.addEventListener('change', () => {
    const id = Number(checkbox.dataset.selectTask);
    if (checkbox.checked) state.selectedTaskIds.add(id); else state.selectedTaskIds.delete(id);
    renderSelectedTasks();
  }));
  $$('[data-task-points]').forEach((input) => input.addEventListener('change', async () => {
    const id = Number(input.dataset.taskPoints);
    const raw = input.value.trim();
    const points = Number(raw);
    const original = state.tasks.find((item) => item.id === id);
    if (!raw || !Number.isFinite(points) || points < 0 || points > 100000 || Math.round(points * 100) / 100 !== points) {
      input.value = String(Number(original?.points || 0));
      return showToast('اكتب نقاطًا من 0 إلى 100000 وبحد أقصى منزلتين عشريتين، مثل 0.1 أو 0.25.', 'error');
    }
    input.disabled = true;
    try {
      await api(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points: Math.round(points * 100) / 100 }) });
      showToast(`تم تحديث نقاط المهمة إلى ${points} نقطة.`, 'success');
      await loadTasks();
    } catch (error) {
      input.value = String(Number(original?.points || 0));
      showToast(error.message || 'تعذر تحديث نقاط المهمة.', 'error');
    } finally { input.disabled = false; }
  }));
  $$('[data-required-toggle]').forEach((checkbox) => checkbox.addEventListener('change', async () => {
    const id = Number(checkbox.dataset.requiredToggle);
    checkbox.disabled = true;
    try {
      await api(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ required: checkbox.checked }) });
      showToast('تم تحديث نوع المهمة.', 'success');
      await loadTasks();
    } catch (error) {
      checkbox.checked = !checkbox.checked;
      showToast(error.message, 'error');
    } finally { checkbox.disabled = false; }
  }));
  $$('[data-delete-task]').forEach((button) => button.addEventListener('click', async () => {
    const id = Number(button.dataset.deleteTask);
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    if (!window.confirm(`متأكد إنك عايز تحذف المهمة دي؟\n\n${task.title}\n\nهتتشال من قائمة المهمات، وسجل التسليمات القديم هيفضل محفوظ.`)) return;
    button.disabled = true;
    button.textContent = 'جاري الحذف...';
    try {
      const result = await api(`/api/tasks/${id}`, { method: 'DELETE' });
      state.selectedTaskIds.delete(id);
      showToast(result.message || 'تم حذف المهمة من القائمة.', 'success');
      await loadTasks();
    } catch (error) {
      showToast(error.message || 'تعذر حذف المهمة.', 'error');
      button.disabled = false;
      button.textContent = '🗑️ حذف';
    }
  }));
}

function renderOverviewTasks() {
  const tasks = state.tasks.slice(0, 6);
  if (!tasks.length) {
    $('#overview-task-list').innerHTML = '<div class="task-empty">لسه مفيش مهمات منشورة. هتظهر المهمات الجديدة هنا تلقائيًا.</div>';
    return;
  }
  $('#overview-task-list').innerHTML = tasks.map((task) => `
    <article class="task-mini-card ${task.completedByMe ? 'done' : ''}">
      <div class="task-mini-check">${task.completedByMe ? '✓' : '·'}</div>
      <div class="task-mini-body"><div class="task-mini-title">${escapeHtml(task.title)}</div><div class="task-mini-meta"><span class="task-tag ${task.required ? 'required' : 'optional'}">${task.required ? 'إجبارية' : 'اختيارية'}</span>${task.completedByMe ? '<span class="task-tag completed">تم التسليم</span>' : ''}<span class="task-id">#${task.id}</span></div></div>
    </article>
  `).join('');
}

function renderSelectedTasks() {
  const chosen = state.tasks.filter((task) => state.selectedTaskIds.has(task.id));
  const summary = $('#selected-task-summary');
  if (!chosen.length) summary.textContent = 'مفيش مهمات متحددة لسه. علّم على المهمة أو المهمات اللي خلصتها من القائمة فوق.';
  else summary.textContent = `تم تحديد ${chosen.length} مهمة: ${chosen.map((task) => `#${task.id} ${task.title}`).join('، ')}`;
}

function wireTasks() {
  $$('.filter-tab').forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    $$('.filter-tab').forEach((tab) => tab.classList.toggle('active', tab === button));
    renderTaskList();
  }));
  $('#select-visible-btn').addEventListener('click', () => {
    const visibleIds = getFilteredTasks().filter((task) => !task.completedByMe && !task.pendingByMe && !task.rejectedByMe).map((task) => task.id);
    const allSelected = visibleIds.length && visibleIds.every((id) => state.selectedTaskIds.has(id));
    visibleIds.forEach((id) => allSelected ? state.selectedTaskIds.delete(id) : state.selectedTaskIds.add(id));
    renderTaskList();
    renderSelectedTasks();
  });
  $('#queue-task-btn').addEventListener('click', queueCurrentTask);
  $('#new-task-title').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); queueCurrentTask(); }
  });
  $('#publish-tasks-btn').addEventListener('click', publishQueuedTasks);
  $('#manual-points-btn')?.addEventListener('click', sendManualPoints);
  $('#evidence-files').addEventListener('change', renderFileList);
  $('#submission-form').addEventListener('submit', submitTasks);
  $('#refresh-submissions-btn').addEventListener('click', loadSubmissions);
}

function queueCurrentTask() {
  const input = $('#new-task-title');
  const title = input.value.trim();
  if (!title) return showToast('اكتب اسم المهمة الأول.', 'error');
  if (state.queue.length >= 40) return showToast('أقصى عدد للمهمات في الدفعة الواحدة 40 مهمة.', 'error');
  const pointsRaw = $('#new-task-points').value.trim();
  const points = Number(pointsRaw);
  if (!pointsRaw || !Number.isFinite(points) || points < 0 || points > 100000 || Math.round(points * 100) / 100 !== points) return showToast('اكتب نقاطًا من 0 إلى 100000 وبحد أقصى منزلتين عشريتين، مثل 0.1 أو 0.25.', 'error');
  const deadlineRaw = $('#new-task-deadline')?.value || '';
  const deadlineDate = deadlineRaw ? new Date(deadlineRaw) : null;
  if (deadlineRaw && (!deadlineDate || !Number.isFinite(deadlineDate.getTime()) || deadlineDate.getTime() <= Date.now())) return showToast('موعد انتهاء المهمة لازم يكون في المستقبل.', 'error');
  state.queue.push({ key: state.queueNextId++, title, required: $('#new-task-required').value === '1', points: Math.round(points * 100) / 100, deadlineAt: deadlineDate ? deadlineDate.toISOString() : null });
  input.value = '';
  $('#new-task-points').value = '1';
  input.focus();
  renderTaskQueue();
}
function renderTaskQueue() {
  const queue = $('#task-queue');
  $('#queue-count').textContent = `${state.queue.length} ${state.queue.length === 1 ? 'مهمة جاهزة' : 'مهمات جاهزة'} للنشر`;
  $('#publish-tasks-btn').disabled = state.queue.length === 0;
  if (!state.queue.length) {
    queue.innerHTML = '<div class="empty-inline">لسه مفيش مهمات في قائمة النشر.</div>';
    return;
  }
  queue.innerHTML = state.queue.map((item) => `
    <div class="queued-task" data-queue-key="${item.key}">
      <span class="task-id">${String(state.queue.indexOf(item) + 1).padStart(2, '0')}</span>
      <div class="queued-task-title">${escapeHtml(item.title)}${item.deadlineAt ? `<small class="queued-deadline">⏰ ${escapeHtml(formatDate(item.deadlineAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' }))}</small>` : ''}</div>
      <label class="queued-task-points" title="عدد نقاط هذه المهمة">⭐ <input type="number" min="0" max="100000" step="0.01" value="${Number(item.points)}" data-queue-points="${item.key}" aria-label="نقاط ${escapeHtml(item.title)}"> <span>نقطة</span></label>
      <select data-queue-required="${item.key}" aria-label="نوع المهمة"><option value="1" ${item.required ? 'selected' : ''}>إجبارية</option><option value="0" ${!item.required ? 'selected' : ''}>اختيارية</option></select>
      <button class="remove-queue-item" data-remove-queue="${item.key}" aria-label="حذف المهمة">×</button>
    </div>
  `).join('');
  $$('[data-queue-required]').forEach((select) => select.addEventListener('change', () => {
    const item = state.queue.find((row) => row.key === Number(select.dataset.queueRequired));
    if (item) item.required = select.value === '1';
  }));
  $$('[data-queue-points]').forEach((input) => input.addEventListener('change', () => {
    const item = state.queue.find((row) => row.key === Number(input.dataset.queuePoints));
    const raw = input.value.trim();
    const points = Number(raw);
    if (!item) return;
    if (!raw || !Number.isFinite(points) || points < 0 || points > 100000 || Math.round(points * 100) / 100 !== points) {
      input.value = String(item.points);
      return showToast('اكتب نقاطًا من 0 إلى 100000 وبحد أقصى منزلتين عشريتين، مثل 0.1 أو 0.25.', 'error');
    }
    item.points = Math.round(points * 100) / 100;
    renderTaskQueue();
  }));
  $$('[data-remove-queue]').forEach((button) => button.addEventListener('click', () => {
    state.queue = state.queue.filter((row) => row.key !== Number(button.dataset.removeQueue));
    renderTaskQueue();
  }));
}
async function publishQueuedTasks() {
  if (!state.queue.length) return;
  const button = $('#publish-tasks-btn');
  setButtonLoading(button, true, 'جاري النشر...');
  try {
    const result = await api('/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: state.queue.map(({ title, required, points, deadlineAt }) => ({ title, required, points, deadlineAt })) }),
    });
    state.queue = [];
    renderTaskQueue();
    showToast(result.message || 'تم حفظ المهمات.', result.discordPosted ? 'success' : 'error');
    if (result.warning && !result.discordPosted) showToast(result.warning, 'error');
    await loadTasks();
  } catch (error) { showToast(error.message, 'error'); }
  finally { setButtonLoading(button, false); }
}

function renderFileList() {
  const files = [...$('#evidence-files').files];
  if (!files.length) { $('#file-list').textContent = 'مفيش ملفات مضافة.'; return; }
  $('#file-list').textContent = files.map((file) => `${file.name} (${formatFileSize(file.size)})`).join(' • ');
}
async function submitTasks(event) {
  event.preventDefault();
  const taskIds = [...state.selectedTaskIds].filter((id) => { const task = state.tasks.find((item) => item.id === id); return task && !task.completedByMe && !task.pendingByMe && !task.rejectedByMe; });
  if (!taskIds.length) return showToast('حدد مهمة واحدة على الأقل قبل التسليم (المهمات المنتهية أو المرفوضة مينفعش تتسلم تاني).', 'error');
  const links = $('#evidence-links').value.trim();
  const files = [...$('#evidence-files').files];
  if (!links && !files.length) return showToast('ضيف رابط دليل أو ارفع صورة/فيديو.', 'error');
  const maximumBytes = 100 * 1024 * 1024;
  for (const file of files) {
    if (!(file.type.startsWith('image/') || file.type.startsWith('video/'))) return showToast(`الملف ${file.name} مش صورة أو فيديو مدعوم.`, 'error');
    if (file.size > maximumBytes) return showToast(`حجم ${file.name} أكبر من الحد المسموح (100MB).`, 'error');
  }
  const button = $('#submit-tasks-btn');
  setButtonLoading(button, true, 'جاري تجهيز التسليم...');
  try {
    const uploadedFiles = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'evidence-file';
      const pathname = `evidence/${state.user.id}/${Date.now()}-${index}-${safeName}`;
      button.textContent = `جاري رفع الملف ${index + 1} من ${files.length}...`;
      let blob;
      try {
      blob = await uploadToBlob(pathname, file, {
        access: 'private',
        handleUploadUrl: '/api/uploads/token',
        multipart: file.size > 5 * 1024 * 1024,
        contentType: file.type,
        onUploadProgress: (event) => {
          const percentage = Math.round(event.percentage || 0);
          button.textContent = `رفع الملف ${index + 1}/${files.length} · ${percentage}%`;
        },
      });
      } catch (uploadError) { throw new Error(await explainUploadError(uploadError, pathname)); }
      uploadedFiles.push({ pathname: blob.pathname, originalName: file.name, mimeType: file.type, size: file.size });
    }
    button.textContent = 'جاري تسجيل التسليم...';
    const result = await api('/api/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskIds,
        evidenceLinks: links,
        note: $('#submission-note').value.trim(),
        files: uploadedFiles,
      }),
    });
    state.selectedTaskIds.clear();
    $('#submission-form').reset();
    renderFileList();
    showToast(result.message || 'تم حفظ التسليم.', result.discordPosted ? 'success' : 'error');
    if (result.warning && !result.discordPosted) showToast(result.warning, 'error');
    await Promise.all([loadTasks(), loadSubmissions()]);
  } catch (error) { showToast(error.message, 'error'); }
  finally { setButtonLoading(button, false); }
}
async function explainUploadError(error, pathname) {
  const message = String(error?.message || '');
  if (!/client token|upload/i.test(message)) return message || 'فشل رفع الملف.';
  try {
    const response = await fetch('/api/uploads/token', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'blob.generate-client-token', payload: { pathname, clientPayload: null, multipart: false } }),
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not json */ }
    if (data?.error) return `فشل رفع الملف: ${data.error}`;
    if (!response.ok) return `فشل رفع الملف: السيرفر رد بحالة ${response.status}. راجع Vercel → Logs.`;
    if (!data?.clientToken) return 'فشل رفع الملف: رد السيرفر مش JSON صالح (غالبًا مسار /api/uploads/token مش واصل للـ API). أعد النشر وتأكد إن فولدر api/ مرفوع.';
    return 'فشل رفع الملف مؤقتًا، جرّب تاني.';
  } catch (probeError) {
    return `فشل رفع الملف: تعذر الاتصال بالسيرفر (${probeError.message}).`;
  }
}
async function loadSubmissions() {
  try {
    const result = await api('/api/submissions');
    const submissions = result.submissions || [];
    if (!submissions.length) {
      $('#submissions-list').innerHTML = '<div class="task-empty">لسه مفيش تسليمات مسجلة.</div>';
      return;
    }
    $('#submissions-list').innerHTML = submissions.map((submission) => {
      const files = (submission.files || []).map((file) => `<a href="${escapeHtml(file.url)}" target="_blank" rel="noopener noreferrer">📎 ${escapeHtml(file.originalName || 'ملف مرفوع')}</a>`).join('');
      const links = (submission.evidenceLinks || []).map((link) => `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">↗ فتح رابط دليل</a>`).join('');
      const tasks = (submission.tasks || []).map((task) => {
        const redoStatus = String(task.redoStatus || '');
        const redoBadge = redoStatus === 'requested'
          ? '<span class="task-tag required">🔁 مطلوب إعادة المهمة</span>'
          : redoStatus === 'submitted'
            ? '<span class="task-tag optional">🔁 تم إعادة التسليم</span>'
            : '';
        const redoButton = state.user.canManage && submission.status === 'approved' && task.canRequestRedo && !redoStatus
          ? `<button type="button" class="task-redo-action" data-redo-task="${submission.id}" data-task-id="${task.id}" data-task-title="${escapeHtml(task.title)}">🔁 طلب إعادة المهمة</button>`
          : '';
        return `<span class="task-tag ${task.required ? 'required' : 'optional'}">${task.required ? 'إجباري' : 'اختياري'} · ${escapeHtml(task.title)}</span>${redoBadge}${redoButton}`;
      }).join('');
      const duplicateWarning = state.user.canManage && (submission.duplicateImages || []).length ? `<div class="duplicate-image-warning"><b>⚠️ تنبيه: تم اكتشاف صورة مكررة</b>${submission.duplicateImages.map((duplicate) => `<div>${escapeHtml(duplicate.fileName)} — موجودة في ${duplicate.matches.slice(0, 5).map((match) => `التسليم #${match.submissionId} بواسطة ${escapeHtml(match.username)}`).join('، ')}</div>`).join('')}</div>` : '';
      return `<article class="submission-card"><div class="submission-top"><div class="submission-user"><img src="${escapeHtml(submission.avatarUrl || avatarFallback(submission.userId))}" alt=""><span>${escapeHtml(submission.username)}</span><span class="task-id">#${submission.id}</span><span class="task-tag ${submission.status === 'approved' ? 'completed' : submission.status === 'rejected' ? 'required' : 'optional'}">${submission.status === 'approved' ? 'تمت الموافقة' : submission.status === 'rejected' ? 'مرفوض' : submission.status === 'reopened' ? 'أُعيد فتحه' : 'بانتظار الموافقة'}</span></div><time class="submission-date">${formatDate(submission.submittedAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></div><div class="submission-task-list">${tasks}</div>${submission.note ? `<div class="submission-note">${escapeHtml(submission.note)}</div>` : ''}${duplicateWarning}${files || links ? `<div class="submission-evidence">${files}${links}</div>` : ''}${state.user.canManage && submission.status === 'pending' ? `<div class="manager-actions"><button class="primary-button" data-review-submission="approve" data-id="${submission.id}">موافقة وإضافة النقاط</button><button class="secondary-button" data-review-submission="reject" data-id="${submission.id}">رفض التسليم</button></div>` : ''}${state.user.canManage && submission.status === 'rejected' ? `<div class="manager-actions"><button class="secondary-button" data-review-submission="reopen" data-id="${submission.id}">🔓 إعادة فتح المهمة للعضو</button></div>` : ''}</article>`;
    }).join('');
    $$('[data-review-submission]').forEach(button => button.addEventListener('click', async () => { const action = button.dataset.reviewSubmission; const id = button.dataset.id; let reason = ''; if (action === 'reject') { reason = window.prompt('سبب رفض التسليم (اختياري):') || ''; } if (action === 'reopen') { if (!window.confirm('هتفتح التسليم ده تاني، والعضو هيقدر يسلّم نفس المهام من جديد. متأكد؟')) return; reason = window.prompt('ملاحظة للعضو (اختياري):') || ''; } button.disabled = true; try { const result = await api(`/api/submissions/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason, note: reason }) }); showToast(result.message || (action === 'approve' ? `تمت الموافقة وإضافة ${result.awarded} نقطة.` : 'تم رفض التسليم.'), result.dmSent === false ? 'info' : 'success'); await Promise.all([loadSubmissions(), loadMyPoints(), loadTasks()]); } catch (error) { showToast(error.message, 'error'); button.disabled = false; } }));
    $$('[data-redo-task]').forEach(button => button.addEventListener('click', async () => {
      const submissionId = Number(button.dataset.redoTask);
      const taskId = Number(button.dataset.taskId);
      const title = button.dataset.taskTitle || `المهمة #${taskId}`;
      if (!window.confirm(`طلب إعادة المهمة دي؟\n\n${title}\n\nهيتم خصم نقاط المهمة من رصيد العضو، وهيقدر يسلّمها مرة تانية.`)) return;
      const reason = window.prompt('سبب طلب الإعادة (اختياري):') || '';
      button.disabled = true;
      try {
        const result = await api(`/api/submissions/${submissionId}/redo-task`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId, reason }) });
        showToast(result.message || `تم طلب إعادة المهمة وخصم ${result.pointsDeducted} نقطة.`, result.dmSent === false ? 'info' : 'success');
        await Promise.all([loadSubmissions(), loadMyPoints(), loadTasks()]);
      } catch (error) { showToast(error.message || 'تعذر طلب إعادة المهمة.', 'error'); button.disabled = false; }
    }));
  } catch (error) {
    $('#submissions-list').innerHTML = `<div class="task-empty">${escapeHtml(error.message)}</div>`;
  }
}

function wireTaskInsights() {
  $('#task-insights-refresh')?.addEventListener('click', () => loadTaskInsights(true));
  $('#submission-audit-refresh')?.addEventListener('click', loadSubmissionAudit);
  $('#submission-audit-export')?.addEventListener('click', () => { window.location.href = '/api/submission-audit.csv'; });
}
function renderMiniMemberList(items, mode) {
  if (!items?.length) return '<div class="task-empty">لا توجد بيانات كافية حتى الآن.</div>';
  return items.map((item, index) => {
    const details = mode === 'active' ? `${Number(item.submissions || 0)} تسليم · ${Number(item.approved || 0)} مقبول · ${Number(item.rejected || 0)} مرفوض` : (item.lastSubmission ? `آخر تسليم: ${formatDate(item.lastSubmission, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'لم يسجّل أي تسليم');
    return `<div class="review-member-row"><span class="review-member-rank">${mode === 'active' ? `#${index + 1}` : '•'}</span><div><b>${escapeHtml(item.username || item.userId)}</b><small>${escapeHtml(details)}</small></div><code>${escapeHtml(item.userId)}</code></div>`;
  }).join('');
}
async function loadTaskInsights(force = false) {
  if (!state.user?.canManage) return;
  const overview = $('#task-stats-overview');
  if (force && overview) overview.innerHTML = '<div class="loading-state">جاري تحديث الإحصائيات...</div>';
  try {
    const result = await api('/api/task-stats');
    const totals = result.totals || {};
    if (overview) overview.innerHTML = [
      ['إجمالي التسليمات', totals.total || 0], ['المقبولة', totals.approved || 0], ['المرفوضة', totals.rejected || 0], ['قيد المراجعة', totals.pending || 0],
    ].map(([label, value]) => `<div class="task-stat-card"><small>${label}</small><b>${Number(value).toLocaleString('en-US')}</b></div>`).join('');
    $('#task-most-active').innerHTML = renderMiniMemberList(result.mostActive, 'active');
    $('#task-inactive-members').innerHTML = renderMiniMemberList(result.inactive, 'inactive');
  } catch (error) {
    if (overview) overview.innerHTML = `<div class="task-empty">${escapeHtml(error.message)}</div>`;
  }
}
async function loadSubmissionAudit() {
  if (!state.user?.canManage) return;
  const box = $('#submission-audit-list');
  if (!box) return;
  box.innerHTML = '<div class="loading-state">جاري تحميل سجل القرارات...</div>';
  try {
    const result = await api('/api/submission-audit');
    const entries = result.entries || [];
    if (!entries.length) { box.innerHTML = '<div class="task-empty">لسه مفيش قرارات محفوظة.</div>'; return; }
    const labels = { approved: '✅ موافقة', rejected: '❌ رفض', reopened: '🔓 إعادة فتح' };
    box.innerHTML = entries.map((entry) => `<article class="submission-audit-row"><div><b>${escapeHtml(labels[entry.decision] || entry.decision)} · التسليم #${entry.submissionId}</b><small>العضو: ${escapeHtml(entry.memberName)} (${escapeHtml(entry.memberId)}) · الأدمن: ${escapeHtml(entry.reviewerName)} (${escapeHtml(entry.reviewerId)})</small>${entry.reason ? `<p>${escapeHtml(entry.reason)}</p>` : ''}</div><time>${escapeHtml(formatDate(entry.createdAt, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' }))}</time></article>`).join('');
  } catch (error) { box.innerHTML = `<div class="task-empty">${escapeHtml(error.message)}</div>`; }
}

async function loadMyPoints() {
  try { const result = await api('/api/points'); const node = $('#my-points-total'); if (node) node.textContent = Number(result.points || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
  catch { const node = $('#my-points-total'); if (node) node.textContent = '—'; }
}
async function sendManualPoints() {
  const userId = $('#manual-points-user').value.trim();
  const amount = Number($('#manual-points-amount').value);
  const reason = $('#manual-points-reason').value.trim();
  if (!/^\d{17,20}$/.test(userId) || !Number.isFinite(amount) || amount === 0) return showToast('اكتب Discord ID صحيح ومقدار نقاط غير صفري.', 'error');
  const button = $('#manual-points-btn'); button.disabled = true;
  try { await api('/api/points', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, amount, reason, username: userId }) }); showToast('تم تعديل النقاط وتسجيل العملية.', 'success'); $('#manual-points-amount').value = ''; $('#manual-points-reason').value = ''; }
  catch (error) { showToast(error.message, 'error'); }
  finally { button.disabled = false; }
}

async function loadRoster() {
  try {
    state.roster = await api('/api/roster');
    $('#staff-count').textContent = state.roster.memberCount ?? '—';
    renderRoster();
    renderDailyMessageStats();
    renderAdminOverview();
    await refreshPresence();
  } catch (error) {
    $('#roster-content').innerHTML = `<div class="loading-state">${escapeHtml(error.message)}<br><small>راجع صلاحيات البوت وإعدادات Server Members Intent.</small></div>`;
  }
}
function wireRoster() {
  $('#roster-search').addEventListener('input', renderRoster);
  $('#roster-content').addEventListener('click', (event) => {
    const row = event.target.closest('.member-row[data-user-id]');
    if (row) openStaffProfile(row.dataset.userId);
  });
  $('#roster-content').addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key)) return;
    const row = event.target.closest('.member-row[data-user-id]');
    if (row) { event.preventDefault(); openStaffProfile(row.dataset.userId); }
  });
}
async function refreshPresence() {
  try {
    const result = await api('/api/presence');
    state.onlineUserIds = new Set((result.online || []).map(item => String(item.userId)));
  } catch { /* Website presence is optional. */ }
  try {
    const discord = await api('/api/discord-presence');
    state.discordStatuses = discord.statuses || {};
    state.discordPresenceAvailable = Boolean(discord.available);
    state.discordPresenceMeta = { lastSeenAt: discord.lastSeenAt || null, ageSeconds: Number.isFinite(Number(discord.ageSeconds)) ? Number(discord.ageSeconds) : null, reason: discord.reason || null };
  } catch { state.discordPresenceAvailable = false; state.discordPresenceMeta = { lastSeenAt: null, ageSeconds: null }; }
  renderRoster();
  renderAdminOverview();
  const footer = $('.roster-footer');
  if (footer) footer.innerHTML = `<span class="status-dot"></span> ${state.discordPresenceAvailable ? Object.values(state.discordStatuses).filter(status => ['online', 'idle', 'dnd'].includes(status)).length + ' متصلون على ديسكورد' : 'حالة ديسكورد غير متاحة — راجع إعدادات البوت'} · تحديث مباشر`;
}
function startPresenceHeartbeat() {
  const beat = async () => {
    if (!state.user) return;
    try { await api('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* Retry on the next heartbeat. */ }
    if (!document.hidden) await refreshPresence();
  };
  beat();
  setInterval(beat, 60000);
}
function renderRoster() {
  const query = $('#roster-search').value.trim().toLocaleLowerCase('ar');
  const groups = (state.roster.groups || []).map((group) => ({
    ...group,
    members: group.members.filter((member) => !query || `${member.username} ${member.handle} ${member.roleName} ${member.roles.map((role) => role.name).join(' ')}`.toLocaleLowerCase('ar').includes(query)),
  })).filter((group) => group.members.length);
  if (!groups.length) {
    $('#roster-content').innerHTML = '<div class="loading-state">مفيش أعضاء مطابقين للبحث.</div>';
    return;
  }
  $('#roster-content').innerHTML = groups.map((group) => `
    <section class="roster-group">
      <div class="roster-role-heading"><span class="role-pin" style="background:${/^#[0-9a-f]{6}$/i.test(group.color) ? group.color : '#64748b'}"></span><span>${escapeHtml(group.name)}</span><span class="role-line"></span></div>
      ${group.members.map((member) => `<div class="member-row" role="button" tabindex="0" data-user-id="${escapeHtml(member.id)}" title="${escapeHtml(member.username)} — اضغط لفتح الملف، وكلك يمين لنسخ ID"><div class="member-avatar-wrap"><img class="member-avatar" src="${escapeHtml(member.avatarUrl || avatarFallback(member.id))}" alt=""><span class="member-state ${['online','idle','dnd','offline_active'].includes(state.discordStatuses[String(member.id)]) ? 'is-online' : (state.discordPresenceAvailable && !state.discordStatuses[String(member.id)] ? 'is-unknown' : 'is-offline')}" title="${state.discordPresenceAvailable ? ({online:'متصل على ديسكورد',idle:'خامل على ديسكورد',dnd:'عدم الإزعاج على ديسكورد',offline:'أوفلاين / مخفي (Discord لا يفرّق بينهم)',offline_active:'أوفلاين لكن نشط مؤخرًا',unknown:'حالة Discord لم تصل من البوت'}[state.discordStatuses[String(member.id)] || 'unknown']) : 'حالة ديسكورد غير متاحة'}"></span></div><div style="min-width:0"><div class="member-row-name">${escapeHtml(member.username)}${member.isAdmin ? '<span class="member-admin-tag">إدارة</span>' : ''}</div><div class="member-row-handle">@${escapeHtml(member.handle)}</div></div><span class="member-rank-dot" style="background:${/^#[0-9a-f]{6}$/i.test(member.roleColor) ? member.roleColor : '#64748b'}"></span></div>`).join('')}
    </section>
  `).join('');
}

function wireLeaveRequests() {
  const formatDateInput = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const getLeaveDateBounds = () => {
    const today = new Date();
    const maxLeaveDate = new Date(today);
    maxLeaveDate.setFullYear(maxLeaveDate.getFullYear() + 5);
    return { today: formatDateInput(today), max: formatDateInput(maxLeaveDate) };
  };
  const startInput = $('#leave-start');
  const endInput = $('#leave-end');
  const initialBounds = getLeaveDateBounds();
  [startInput, endInput].filter(Boolean).forEach((input) => {
    input.min = initialBounds.today;
    input.max = initialBounds.max;
  });
  startInput?.addEventListener('change', () => {
    const bounds = getLeaveDateBounds();
    if (endInput) endInput.min = startInput.value || bounds.today;
  });
  $('#leave-request-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const startDate = $('#leave-start').value;
    const endDate = $('#leave-end').value;
    const reason = $('#leave-reason').value.trim();
    const bounds = getLeaveDateBounds();
    const dateFormatIsValid = (value) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00`); return !Number.isNaN(parsed.getTime()) && formatDateInput(parsed) === value; };
    if (!dateFormatIsValid(startDate) || !dateFormatIsValid(endDate) || startDate < bounds.today || startDate > bounds.max || endDate < startDate || endDate > bounds.max) return showToast('اختار تاريخًا حقيقيًا من اليوم وحتى 5 سنوات قادمة، وتأكد إن النهاية ليست قبل البداية.', 'error');
    const button = $('button[type="submit"]', event.currentTarget);
    setButtonLoading(button, true, 'جاري إرسال الطلب...');
    try {
      const result = await api('/api/leave-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ startDate, endDate, reason }) });
      showToast(result.message || 'تم إرسال طلب الإجازة للإدارة.', result.discordPosted ? 'success' : 'error');
      event.currentTarget.reset();
      await loadLeaveRequests();
    } catch (error) { showToast(error.message, 'error'); }
    finally { setButtonLoading(button, false); }
  });
  $('#refresh-leaves-btn')?.addEventListener('click', loadLeaveRequests);
  document.addEventListener('contextmenu', async (event) => {
    const row = event.target.closest('.member-row[data-user-id]');
    if (!row) return;
    event.preventDefault();
    const id = row.dataset.userId;
    try { await navigator.clipboard.writeText(id); showToast(`تم نسخ Discord ID: ${id}`, 'success'); }
    catch { window.prompt('انسخ Discord ID:', id); }
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-leave-review]');
    if (!button) return;
    const action = button.dataset.leaveReview;
    let note = '';
    if (action === 'reject') note = window.prompt('اكتب سبب الرفض (اختياري):') || '';
    button.disabled = true;
    try {
      const result = await api(`/api/leave-requests/${button.dataset.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) });
      showToast(result.message || 'تم تحديث طلب الإجازة.', result.discordPosted === false ? 'error' : 'success');
      await loadLeaveRequests();
    } catch (error) { showToast(error.message, 'error'); button.disabled = false; }
  });
}
async function loadLeaveRequests() {
  try {
    const result = await api('/api/leave-requests');
    const requests = result.requests || [];
    const statusText = { pending: 'بانتظار المراجعة', approved: 'تمت الموافقة', rejected: 'مرفوض' };
    const render = (item, manager = false) => `<article class="leave-card"><div class="leave-card-top"><b>${escapeHtml(item.username)}</b><span class="task-tag ${item.status === 'approved' ? 'completed' : item.status === 'rejected' ? 'required' : 'optional'}">${statusText[item.status] || item.status}</span></div><div class="leave-dates">${escapeHtml(item.startDate)} — ${escapeHtml(item.endDate)}</div><p>${escapeHtml(item.reason)}</p><small class="muted">Discord ID: <code>${escapeHtml(item.userId)}</code> · ${formatDate(item.createdAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>${item.reviewNote ? `<p class="muted">ملاحظة الإدارة: ${escapeHtml(item.reviewNote)}</p>` : ''}${(manager || state.user.canManage) && item.status === 'pending' ? `<div class="manager-actions"><button class="primary-button" data-leave-review="approve" data-id="${item.id}">موافقة</button><button class="secondary-button" data-leave-review="reject" data-id="${item.id}">رفض</button></div>` : ''}</article>`;
    $('#leave-requests-list').innerHTML = requests.length ? requests.filter(x => x.userId === state.user.id || state.user.canManage).map(x => render(x)).join('') || '<div class="task-empty">لسه مفيش طلبات إجازة.</div>' : '<div class="task-empty">لسه مفيش طلبات إجازة.</div>';
    if (state.user.canManage) $('#manager-leave-list').innerHTML = requests.length ? requests.map(x => render(x, true)).join('') : '<div class="task-empty">مفيش طلبات إجازة للمراجعة.</div>';
  } catch (error) {
    $('#leave-requests-list').innerHTML = `<div class="task-empty">${escapeHtml(error.message)}</div>`;
    if (state.user.canManage) $('#manager-leave-list').innerHTML = `<div class="task-empty">${escapeHtml(error.message)}</div>`;
  }
}


function flattenRoster() {
  return (state.roster.groups || []).flatMap((group) => group.members || []);
}
async function loadStaffStats() {
  try {
    const result = await api('/api/staff-stats');
    state.staffStats = Array.isArray(result.stats) ? result.stats : [];
    if (result.dailyDate) state.dailyMessageStats.dailyDate = result.dailyDate;
    state.dailyMessageStats.dailyStats = state.staffStats.map((row) => ({ userId: row.userId, username: row.username || row.userId, count: Number(row.dailyMessages) || 0 }));
    state.dailyMessageStats.dailyTotal = state.dailyMessageStats.dailyStats.reduce((sum, row) => sum + row.count, 0);
    renderDailyMessageStats();
    renderAdminOverview();
    renderLeaderboard();
    if ($('.page.active-page')?.id === 'page-staff-ratings') renderRatings();
  } catch (error) {
    const node = $('#admin-overview-cards');
    if (node && !state.staffStats.length) node.innerHTML = `<div class="loading-state">${escapeHtml(error.message)}</div>`;
  }
}
function findStaffProfileMember(userId) {
  return flattenRoster().find((item) => String(item.id) === String(userId)) || (() => {
    const stats = (state.staffStats || []).find((item) => String(item.userId) === String(userId));
    if (state.user && String(state.user.id) === String(userId)) return { id: String(userId), username: state.user.username || String(userId), handle: state.user.handle || String(userId), avatarUrl: state.user.avatarUrl || avatarFallback(userId), roleName: 'عضو الاستاف', roles: [], isAdmin: Boolean(state.user.isAdmin) };
    return stats ? { id: String(userId), username: stats.username || String(userId), handle: String(userId), avatarUrl: avatarFallback(userId), roleName: 'عضو غير موجود حاليًا في قائمة الاستاف', roles: [], isAdmin: false } : null;
  })();
}
function renderAdminOverview() {
  const container = $('#admin-overview-cards');
  if (!container) return;
  const statsById = new Map((state.staffStats || []).map((item) => [String(item.userId), item]));
  const admins = flattenRoster().filter((member) => member.isAdmin);
  if (!admins.length) {
    container.innerHTML = '<div class="task-empty">لا توجد حسابات إدارية محددة في قائمة الاستاف حتى الآن.</div>';
    return;
  }
  container.innerHTML = admins.map((member) => {
    const stats = statsById.get(String(member.id)) || {};
    const discordStatus = state.discordStatuses[String(member.id)] || 'unknown';
    const online = ['online', 'idle', 'dnd'].includes(discordStatus);
    const statusLabel = !state.discordPresenceAvailable ? 'غير متاح' : ({online:'أونلاين',idle:'خامل',dnd:'عدم الإزعاج',offline:'أوفلاين / مخفي',unknown:'الحالة غير مستلمة'}[discordStatus] || 'الحالة غير مستلمة');
    return `<button type="button" class="admin-overview-card" data-open-staff-profile="${escapeHtml(member.id)}"><div class="admin-overview-top"><img src="${escapeHtml(member.avatarUrl || avatarFallback(member.id))}" alt=""><div class="admin-overview-name"><b>${escapeHtml(member.username)}</b><small>${escapeHtml(member.roleName || 'مسؤول')}</small></div><span class="online-pill ${!state.discordPresenceAvailable || discordStatus === 'unknown' ? 'unknown' : (online ? 'online' : 'offline')}"><i></i>${statusLabel}</span></div><div class="admin-overview-metrics"><span><b>${rollMarkup(`ov:${member.id}:daily`, Number(stats.dailyMessages || 0))}</b><small>رسائل اليوم</small></span><span><b>${rollMarkup(`ov:${member.id}:subs`, Number(stats.totalSubmissions || 0))}</b><small>تسليمات</small></span><span><b>${rollMarkup(`ov:${member.id}:pts`, Number(stats.totalPoints || 0))}</b><small>نقاط</small></span><span><b>${rollMarkup(`ov:${member.id}:req`, Number(stats.adminRequests || 0))}</b><small>طلبات إدارية</small></span></div><span class="admin-overview-link">فتح الملف الكامل ←</span></button>`;
  }).join('');
  $$('[data-open-staff-profile]', container).forEach((button) => button.addEventListener('click', () => openStaffProfile(button.dataset.openStaffProfile)));
  rollPlay(container);
}
async function openStaffProfile(userId) {
  const member = findStaffProfileMember(userId);
  if (!member) return showToast('لا توجد بيانات إحصائية لهذا العضو بعد.', 'error');
  state.activeStaffProfileId = String(userId);
  $('#staff-profile-content').innerHTML = '<div class="loading-state">جاري تحميل ملف العضو والإحصائيات...</div>';
  openPage('staff-profile');
}
async function loadStaffProfile(userId, providedMember = null) {
  const member = providedMember || findStaffProfileMember(userId);
  if (!member) return;
  try {
    const [response] = await Promise.all([
      api(`/api/staff-stats/${encodeURIComponent(userId)}`),
      fetchProfileVoiceTime(userId),
    ]);
    if (String(state.activeStaffProfileId) !== String(userId)) return;
    renderStaffProfile(member, response);
  } catch (error) {
    $('#staff-profile-content').innerHTML = `<div class="task-empty">${escapeHtml(error.message)}</div>`;
  }
}

function monitorFormatNumber(value) { return Number(value || 0).toLocaleString('en-US'); }
function monitorAgo(value) {
  if (!value) return 'لا يوجد سجل سابق';
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return 'وقت غير معروف';
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `منذ ${seconds} ث`;
  if (seconds < 3600) return `منذ ${Math.floor(seconds / 60)} د`;
  if (seconds < 86400) return `منذ ${Math.floor(seconds / 3600)} س`;
  return `منذ ${Math.floor(seconds / 86400)} يوم`;
}
function monitorStatusLabel(status, available = true) {
  if (!available) return 'غير متاح';
  return ({ online: 'أونلاين', idle: 'خامل', dnd: 'عدم الإزعاج', offline: 'أوفلاين / مخفي', unknown: 'الحالة غير مستلمة' })[status] || 'الحالة غير مستلمة';
}
function monitorSetStatusCard(title, detail, stateName, icon) {
  const labels = { ok: 'سليم', warn: 'تحذير', bad: 'متعطل', unknown: 'غير معروف' };
  return `<article class="monitor-service-card state-${stateName}"><span class="monitor-service-icon">${icon}</span><div class="monitor-service-copy"><b>${escapeHtml(title)}</b><small>${escapeHtml(detail || 'لا توجد تفاصيل')}</small></div><span class="monitor-service-status">${labels[stateName] || 'غير معروف'}</span></article>`;
}
async function loadAdminMonitoring(options = {}) {
  if (!state.user?.canManage) return;
  const button = $('#monitor-refresh');
  if (button && !options.auditOnly) setButtonLoading(button, true, 'جاري التحديث...');
  const boxIds = ['monitor-kpis', 'monitor-services', 'monitor-presence-stats', 'monitor-members-body', 'monitor-task-stats', 'monitor-pending-requests', 'monitor-audit-events', 'monitor-review-events'];
  if (!options.auditOnly && !state.monitor.updatedAt) boxIds.forEach((id) => {
    const node = $(`#${id}`); if (!node) return;
    node.innerHTML = node.tagName === 'TBODY'
      ? '<tr><td colspan="11" class="loading-state">جاري تحميل بيانات المراقبة...</td></tr>'
      : '<div class="loading-state">جاري تحميل بيانات المراقبة...</div>';
  });
  const jobs = options.auditOnly
    ? { audit: () => api('/api/audit-log'), reviewAudit: () => api('/api/submission-audit') }
    : {
        health: () => api('/api/health'), summary: () => api('/api/admin-monitoring'), roster: () => api('/api/roster'),
        stats: () => api('/api/staff-stats'), presence: () => api('/api/discord-presence'), voiceTime: () => api('/api/voice-time'), taskStats: () => api('/api/task-stats'),
        audit: () => api('/api/audit-log'), reviewAudit: () => api('/api/submission-audit'),
        leaveRequests: () => api('/api/leave-requests'), staffRequests: () => api('/api/staff-requests'),
      };
  try {
    const keys = Object.keys(jobs);
    const results = await Promise.allSettled(keys.map((key) => jobs[key]()));
    const failures = [];
    results.forEach((result, index) => {
      const key = keys[index];
      if (result.status === 'rejected') {
        failures.push(`${key}: ${result.reason?.message || 'تعذر التحميل'}`);
        // Remove the failed source's previous snapshot so stale data isn't presented as freshly checked.
        if (key === 'stats') state.monitor.staffStats = [];
        else if (key === 'audit') state.monitor.audit = [];
        else if (key === 'reviewAudit') state.monitor.reviewAudit = [];
        else if (key === 'leaveRequests') state.monitor.leaveRequests = [];
        else if (key === 'staffRequests') state.monitor.staffRequests = [];
        else state.monitor[key] = null;
        return;
      }
      const data = result.value;
      if (key === 'voiceTime') state.monitor.voiceTimeFetchedAt = Date.now();
      if (key === 'stats') state.monitor.staffStats = Array.isArray(data.stats) ? data.stats : [];
      else if (key === 'audit') state.monitor.audit = Array.isArray(data.entries) ? data.entries : [];
      else if (key === 'reviewAudit') state.monitor.reviewAudit = Array.isArray(data.entries) ? data.entries : [];
      else if (key === 'leaveRequests') state.monitor.leaveRequests = Array.isArray(data.requests) ? data.requests : [];
      else if (key === 'staffRequests') state.monitor.staffRequests = Array.isArray(data.requests) ? data.requests : [];
      else state.monitor[key] = data;
    });
    state.monitor.loadErrors = options.auditOnly
      ? [...state.monitor.loadErrors.filter((item) => !item.startsWith('audit:') && !item.startsWith('reviewAudit:')), ...failures]
      : failures;
    if (options.auditOnly) state.monitor.auditUpdatedAt = new Date().toISOString();
    else state.monitor.updatedAt = new Date().toISOString();
    renderAdminMonitoring(state.monitor.loadErrors);
    renderCyberCommandDeck();
    if (failures.length && !options.silent) showToast(`تم التحديث جزئيًا؛ تعذر تحميل ${failures.length} من المصادر.`, 'info');
    else if (!failures.length && !options.auditOnly && !options.silent) showToast('تم تحديث لوحة مراقبة الإدارة.', 'success');
  } catch (error) {
    if (!options.silent) showToast(error.message || 'تعذر تحديث لوحة المراقبة.', 'error');
  } finally { if (button && !options.auditOnly) setButtonLoading(button, false); }
}
function cyberCount(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return '<strong class="cyber-metric-value is-unknown">—</strong>';
  return `<strong class="cyber-metric-value" data-count-target="${n}">0</strong>`;
}
function renderCyberTrendChart() {
  const chart = $('#cyber-trend-chart');
  const summaryNode = $('#cyber-trend-summary');
  if (!chart || !summaryNode) return;
  const monitor = state.monitor || {};
  const now = Date.now();
  const isWeek = state.cyberTrendPeriod === '7d';
  const periodMs = isWeek ? 7 * 86400000 : 86400000;
  const bucketCount = isWeek ? 7 : 12;
  const bucketMs = periodMs / bucketCount;
  const currentStart = now - periodMs;
  const previousStart = currentStart - periodMs;
  const entries = [
    ...(monitor.audit || []).map((entry) => ({ when: entry.createdAt, source: 'discord' })),
    ...(monitor.reviewAudit || []).map((entry) => ({ when: entry.createdAt, source: 'review' })),
  ].map((entry) => ({ ...entry, timestamp: new Date(entry.when || 0).getTime() })).filter((entry) => Number.isFinite(entry.timestamp) && entry.timestamp > 0);
  const currentEntries = entries.filter((entry) => entry.timestamp >= currentStart && entry.timestamp <= now);
  const previousEntries = entries.filter((entry) => entry.timestamp >= previousStart && entry.timestamp < currentStart);
  const previousCount = previousEntries.length;
  const currentCount = currentEntries.length;
  let compareLabel = 'لا توجد سجلات سابقة كافية للمقارنة';
  let compareTone = 'neutral';
  if (previousCount > 0) {
    const delta = Math.round(((currentCount - previousCount) / previousCount) * 100);
    compareLabel = `${delta > 0 ? '+' : ''}${delta}% مقارنة بالفترة السابقة`;
    compareTone = delta > 0 ? 'up' : delta < 0 ? 'down' : 'neutral';
  } else if (currentCount === 0) {
    compareLabel = 'لا توجد أحداث مسجلة في الفترتين';
  }
  summaryNode.innerHTML = `<div class="cyber-trend-total"><small>${isWeek ? 'أحداث آخر 7 أيام' : 'أحداث آخر 24 ساعة'}</small><b>${currentCount.toLocaleString('en-US')}</b><em>سجلًا مستلمًا</em></div><div class="cyber-trend-compare tone-${compareTone}"><small>مقارنة بالفترة السابقة</small><b>${escapeHtml(compareLabel)}</b><em>${previousCount.toLocaleString('en-US')} سجل في الفترة السابقة</em></div>`;
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({ start: currentStart + index * bucketMs, count: 0 }));
  currentEntries.forEach((entry) => {
    const index = Math.max(0, Math.min(bucketCount - 1, Math.floor((entry.timestamp - currentStart) / bucketMs)));
    buckets[index].count += 1;
  });
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  chart.innerHTML = `<div class="cyber-trend-bars">${buckets.map((bucket, index) => {
    const label = isWeek
      ? formatDate(new Date(bucket.start), { day: 'numeric', month: 'short', timeZone: 'Africa/Cairo' })
      : formatDate(new Date(bucket.start), { hour: '2-digit', timeZone: 'Africa/Cairo' });
    const height = bucket.count ? Math.max(5, bucket.count / max * 100) : 0;
    return `<div class="cyber-trend-column" style="--column-index:${index}"><div class="cyber-trend-stage"><small>${bucket.count.toLocaleString('en-US')}</small><span style="--trend-height:${height}%"></span></div><label>${escapeHtml(label)}</label></div>`;
  }).join('')}</div>`;
}
function renderCyberCommandDeck() {
  const root = $('#cyber-command-deck');
  if (!root || !state.user?.canManage) return;
  const monitor = state.monitor || {};
  const health = monitor.health;
  const presence = monitor.presence || {};
  const summary = monitor.summary || {};
  const metrics = summary.metrics || {};
  const totals = monitor.taskStats?.totals || {};
  const members = (monitor.roster?.groups || []).flatMap((group) => (group.members || []).map((member) => ({ ...member, sourceRoleName: member.roleName || group.name })));
  const statusCounts = members.length ? members.map((member) => (presence.statuses || {})[String(member.id)] || 'unknown') : Object.values(presence.statuses || {});
  const onlineCount = presence.available ? statusCounts.filter((status) => ['online', 'idle', 'dnd'].includes(status)).length : null;
  const openRequests = summary.generatedAt ? Number(metrics.pendingStaffRequests || 0) + Number(metrics.pendingLeaveRequests || 0) : null;
  const kpis = $('#cyber-deck-kpis');
  if (kpis) {
    const tiles = [
      { label: 'أعضاء الاستاف', value: monitor.roster ? (monitor.roster.memberCount ?? members.length) : null, foot: 'دليل الرتب الأساسي', icon: '◉', tone: 'cyan' },
      { label: 'نشطون على Discord', value: onlineCount, foot: presence.available ? 'حسب آخر Presence متاح' : 'حالة Discord غير متاحة', icon: '⌁', tone: 'violet' },
      { label: 'تسليمات تنتظر المراجعة', value: totals.pending ?? metrics.pendingSubmissions ?? null, foot: 'تحتاج قرار الإدارة', icon: '↯', tone: 'pink' },
      { label: 'طلبات إدارية معلّقة', value: openRequests, foot: summary.generatedAt ? 'طلبات وإجازات' : 'البيانات غير متاحة', icon: '▤', tone: 'lime' },
    ];
    kpis.innerHTML = tiles.map((tile, index) => `<article class="cyber-kpi-tile tone-${tile.tone}" style="--tile-index:${index}"><span class="cyber-kpi-icon">${tile.icon}</span><div class="cyber-kpi-copy"><small>${escapeHtml(tile.label)}</small>${cyberCount(tile.value)}<em>${escapeHtml(tile.foot)}</em></div><span class="cyber-kpi-rune">${String(index + 1).padStart(2, '0')}</span></article>`).join('');
    kpis.querySelectorAll('[data-count-target]').forEach((node) => animateCounter(node, node.dataset.countTarget, 1350));
  }
  const serviceGrid = $('#cyber-service-grid');
  if (serviceGrid) {
    const hasRoster = Boolean(monitor.roster && Array.isArray(monitor.roster.groups));
    const presenceState = !presence.available ? 'unknown' : (Number.isFinite(Number(presence.ageSeconds)) && Number(presence.ageSeconds) > 120 ? 'warn' : 'ok');
    const presenceDetail = presence.available ? `آخر نبضة منذ ${monitorAgo(presence.lastSeenAt)}` : (presence.reason === 'sync-failed' ? 'المزامنة فشلت؛ راجع سجلات worker' : presence.reason === 'stale-heartbeat' ? 'آخر نبضة قديمة؛ راجع تشغيل worker' : 'لا توجد حالة مؤكدة حاليًا؛ لا تعتبرها Offline');
    serviceGrid.innerHTML = [
      monitorSetStatusCard('واجهة الموقع و API', health ? (health.ok ? 'استجابة API ناجحة' : 'وصل رد غير سليم') : 'لم يصل فحص مؤكد', health ? (health.ok ? 'ok' : 'warn') : 'unknown', '⌂'),
      monitorSetStatusCard('Discord Bot', health ? (health.botReady ? 'البوت متصل' : 'البوت غير جاهز أو إعداداته ناقصة') : 'لم يتم التحقق بعد', health ? (health.botReady ? 'ok' : 'bad') : 'unknown', '◉'),
      monitorSetStatusCard('قاعدة البيانات', health ? (health.databaseReady ? 'اتصال قاعدة البيانات جاهز' : 'الاتصال غير جاهز') : 'لم يصل فحص مؤكد', health ? (health.databaseReady ? 'ok' : 'bad') : 'unknown', '▤'),
      monitorSetStatusCard('Discord Presence Worker', presenceDetail, presenceState, '◌'),
    ].join('');
  }
  const chart = $('#cyber-activity-chart');
  if (chart) {
    const statsById = new Map((monitor.staffStats || []).map((item) => [String(item.userId), item]));
    const sourceRows = members.length ? members.map((member) => ({ member, stats: statsById.get(String(member.id)) || {} })) : (monitor.staffStats || []).map((stats) => ({ member: { id: stats.userId, username: stats.username || String(stats.userId), avatarUrl: avatarFallback(stats.userId) }, stats }));
    const activeRows = sourceRows.map((row) => ({ ...row, count: Number(row.stats.dailyMessages || 0) })).filter((row) => row.count > 0).sort((a, b) => b.count - a.count).slice(0, 6);
    const max = Math.max(1, ...activeRows.map((row) => row.count));
    if (monitor.loadErrors.some((item) => item.startsWith('stats:'))) chart.innerHTML = '<div class="cyber-empty"><span>!</span><b>تعذر تحميل إحصائيات النشاط</b><small>راجع مصدر بيانات الرسائل من لوحة المراقبة.</small></div>';
    else if (!monitor.staffStats?.length) chart.innerHTML = '<div class="cyber-empty"><span>⌁</span><b>البيانات لم تصل بعد</b><small>اضغط مزامنة البيانات لإعادة المحاولة.</small></div>';
    else if (!activeRows.length) chart.innerHTML = '<div class="cyber-empty"><span>⌁</span><b>لا توجد رسائل مسجلة اليوم</b><small>سيظهر النشاط هنا عند توفر بيانات حقيقية.</small></div>';
    else chart.innerHTML = `<div class="cyber-chart-caption"><span>LIVE MESSAGE COUNTS</span><small>أعلى ${activeRows.length} أعضاء · اليوم</small></div>${activeRows.map((row, index) => `<div class="cyber-chart-row" style="--bar-index:${index}"><span class="cyber-chart-rank">${String(index + 1).padStart(2, '0')}</span><img src="${escapeHtml(row.member.avatarUrl || avatarFallback(row.member.id))}" alt=""><div class="cyber-chart-main"><div class="cyber-chart-label"><b>${escapeHtml(row.member.username || row.member.id)}</b><small>${row.count.toLocaleString('en-US')} رسالة</small></div><div class="cyber-bar-track"><span style="--bar-width:${Math.max(2, row.count / max * 100)}%"></span></div></div></div>`).join('')}`;
  }
  const feed = $('#cyber-activity-feed');
  if (feed) {
    const discordRows = (monitor.audit || []).map((entry) => ({ label: entry.label || 'إجراء إداري', actor: entry.actor?.username || entry.actor?.id || 'غير معروف', target: entry.targetName || entry.targetId || '', when: entry.createdAt, reason: entry.reason || '', tone: entry.tone === 'danger' ? 'bad' : entry.tone === 'create' ? 'good' : 'neutral', source: 'DISCORD AUDIT' }));
    const reviewRows = (monitor.reviewAudit || []).map((entry) => {
      const decision = entry.decision === 'approved' ? ['موافقة على التسليم', 'good'] : entry.decision === 'rejected' ? ['رفض التسليم', 'bad'] : ['إعادة فتح التسليم', 'warn'];
      return { label: `${decision[0]} #${entry.submissionId}`, actor: entry.reviewerName || entry.reviewerId || 'مسؤول', target: entry.memberName || entry.memberId || '', when: entry.createdAt, reason: entry.reason || '', tone: decision[1], source: 'TASK REVIEW' };
    });
    const events = [...discordRows, ...reviewRows].sort((a, b) => new Date(b.when || 0) - new Date(a.when || 0)).slice(0, 5);
    if (events.length) feed.innerHTML = events.map((entry, index) => `<article class="cyber-timeline-entry tone-${entry.tone}" style="--event-index:${index}"><span class="cyber-timeline-marker">${entry.tone === 'good' ? '✓' : entry.tone === 'bad' ? '!' : '⌁'}</span><div class="cyber-timeline-content"><div class="cyber-timeline-topline"><b>${escapeHtml(entry.label)}</b><span>${escapeHtml(entry.source)}</span></div><p>${escapeHtml(entry.actor)}${entry.target ? ` <i>←</i> ${escapeHtml(entry.target)}` : ''}</p>${entry.reason ? `<small>${escapeHtml(entry.reason)}</small>` : ''}</div><time>${escapeHtml(monitorAgo(entry.when))}</time></article>`).join('');
    else if (monitor.loadErrors.some((item) => item.startsWith('audit:') || item.startsWith('reviewAudit:'))) feed.innerHTML = '<div class="cyber-empty"><span>!</span><b>تعذر تحميل سجل النشاط</b><small>المصادر لم ترجع بيانات مؤكدة؛ افتح لوحة المراقبة للتفاصيل.</small></div>';
    else feed.innerHTML = '<div class="cyber-empty"><span>⌁</span><b>لا توجد أحداث متاحة حتى الآن</b><small>ستظهر الإجراءات الجديدة هنا بعد تسجيلها في مصادرها.</small></div>';
  }
  renderCyberTrendChart();
  const periodButtons = $$('[data-cyber-period]');
  periodButtons.forEach((button) => { const active = button.dataset.cyberPeriod === state.cyberTrendPeriod; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  const updated = $('#cyber-deck-updated');
  if (updated) updated.textContent = monitor.updatedAt ? `آخر مزامنة: ${formatDate(monitor.updatedAt, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Cairo' })} بتوقيت القاهرة` : 'لم تكتمل المزامنة الأولى بعد';
}

function renderAdminMonitoring(failures = []) {
  const monitor = state.monitor;
  const roster = monitor.roster || state.roster || { groups: [], memberCount: 0 };
  const members = (roster.groups || []).flatMap((group) => (group.members || []).map((member) => ({ ...member, sourceRoleName: member.roleName || group.name })));
  const statsById = new Map((monitor.staffStats || []).map((item) => [String(item.userId), item]));
  const siteRows = monitor.summary?.siteActivity || [];
  const siteById = new Map(siteRows.map((item) => [String(item.userId), item]));
  // لا نستعمل Presence قديمة من حالة الواجهة كأنها فحص جديد، ولا نحوّل فشل المصدر إلى Offline.
  const discord = monitor.presence || { available: false, statuses: {} };
  const statuses = discord.available ? (discord.statuses || {}) : {};
  const statCounts = { online: null, idle: null, dnd: null, offline: null, offline_active: null, unknown: null };
  if (discord.available) {
    Object.keys(statCounts).forEach((key) => { statCounts[key] = 0; });
    members.forEach((member) => { const status = statuses[String(member.id)] || 'unknown'; statCounts[statCounts.hasOwnProperty(status) ? status : 'unknown'] += 1; });
  }
  const hasSummary = Boolean(monitor.summary?.generatedAt);
  const webOnline = hasSummary ? siteRows.filter((item) => Number.isFinite(new Date(item.lastSeen).getTime()) && Date.now() - new Date(item.lastSeen).getTime() < 150000) : null;
  const admins = members.filter((member) => member.isAdmin);
  const metrics = monitor.summary?.metrics || {};
  const totalStats = (monitor.taskStats?.totals || {});
  const cards = [
    ['إجمالي أعضاء الاستاف', roster.memberCount ?? members.length, 'حسابًا في دليل الاستاف', '◉'],
    ['مسؤولو الإدارة', admins.length, 'محددون حسب صلاحيات السيرفر الأساسي', '♜'],
    ['Online على Discord', statCounts.online ?? '—', discord.available ? 'حالة حديثة من الـ Gateway' : 'Presence غير متاح؛ لا نفترض أنها Offline', '●'],
    ['نشطون على الموقع', webOnline === null ? '—' : webOnline.length, hasSummary ? 'نبضة خلال آخر 150 ثانية' : 'بيانات النشاط غير متاحة', '⌁'],
    ['المهمات النشطة', metrics.activeTasks ?? '—', monitor.summary ? `منها ${monitorFormatNumber(metrics.requiredActiveTasks)} إجبارية` : 'تفاصيل المهمات غير متاحة', '✓'],
    ['تسليمات بانتظار المراجعة', totalStats.pending ?? metrics.pendingSubmissions ?? '—', 'مطلوب إجراء من الإدارة', '⏳'],
    ['طلبات إدارية معلّقة', monitor.summary ? (Number(metrics.pendingStaffRequests || 0) + Number(metrics.pendingLeaveRequests || 0)) : '—', monitor.summary ? `${monitorFormatNumber(metrics.pendingStaffRequests)} طلب إداري · ${monitorFormatNumber(metrics.pendingLeaveRequests)} إجازة` : 'بيانات الطلبات غير متاحة', '✉'],
    ['قرارات آخر 24 ساعة', metrics.reviewDecisions24h ?? '—', 'قرارات محفوظة في سجل التسليمات', '≣'],
    ['إجمالي التسليمات', totalStats.total ?? metrics.totalSubmissions ?? '—', 'كل التسليمات المسجلة في قاعدة البيانات', '▤'],
    ['قرارات المراجعة إجمالًا', metrics.totalReviewDecisions ?? '—', 'سجل مراجعات التسليمات بالكامل', '☷'],
  ];
  const kpis = $('#monitor-kpis');
  if (kpis) kpis.innerHTML = cards.map(([label, value, note, icon], index) => `<article class="monitor-kpi"><div class="monitor-kpi-top"><span>${icon}</span><small>${escapeHtml(label)}</small></div><strong>${escapeHtml(value === '—' ? value : monitorFormatNumber(value))}</strong><p>${escapeHtml(note)}</p></article>`).join('');
  const health = monitor.health || null;
  const presenceFresh = Boolean(discord.available);
  const apiOk = Boolean(health?.ok);
  const lastPresenceAge = Number(monitor.presence?.ageSeconds);
  const presenceError = String(monitor.presence?.lastError || '').trim();
  const presenceFailureDetail = monitor.presence?.reason === 'stale-heartbeat'
    ? `آخر نبضة منذ ${monitorAgo(monitor.presence?.lastSeenAt)}؛ تأكد أن worker شغال باستمرار وبنفس قاعدة البيانات`
    : monitor.presence?.reason === 'sync-failed'
      ? `الـ worker شغال لكن فشل في جلب الحالات: ${presenceError || 'راجع سجل تشغيل worker'}`
      : monitor.presence?.reason === 'sync-not-complete'
        ? 'الـ worker اتصل لكن المزامنة الأولى لم تكتمل بعد؛ راجع سجل تشغيل worker'
        : 'لم تصل نبضة من bot-worker؛ شغّله على استضافة Node دائمة بنفس DATABASE_URL وDISCORD_BOT_TOKEN';
  const presenceDetail = presenceFresh ? `آخر نبضة منذ ${monitorAgo(monitor.presence?.lastSeenAt)} · ${monitorFormatNumber(monitor.presence?.storedCount || 0)} حالة مستلمة` : presenceFailureDetail;
  const services = $('#monitor-services');
  if (services) services.innerHTML = [
    monitorSetStatusCard('واجهة و API الموقع', health ? (apiOk ? 'وصل رد ناجح من API' : 'الخدمة ردّت بحالة غير سليمة') : 'تعذر الحصول على نتيجة الفحص', !health ? 'unknown' : apiOk ? 'ok' : 'warn', '⌂'),
    monitorSetStatusCard('Discord Bot', health ? (health.botReady ? 'التوكن متصل و Discord رد بنجاح' : 'البوت غير متصل أو إعداداته ناقصة') : 'لم يتم التحقق من حالة البوت', !health ? 'unknown' : health.botReady ? 'ok' : 'bad', '◉'),
    monitorSetStatusCard('قاعدة البيانات', health ? (health.databaseReady ? 'اتصال قاعدة البيانات مضبوط' : 'DATABASE_URL غير مضبوط أو الخدمة غير جاهزة') : 'لم يتم التحقق من قاعدة البيانات', !health ? 'unknown' : health.databaseReady ? 'ok' : 'bad', '▤'),
    monitorSetStatusCard('تخزين المرفقات', health ? (health.storageReady ? 'تكوين التخزين موجود' : 'إعدادات التخزين غير مكتملة') : 'لم يتم التحقق من التخزين', !health ? 'unknown' : health.storageReady ? 'ok' : 'warn', '↥'),
    monitorSetStatusCard('Discord Presence Worker', presenceDetail, presenceFresh ? (Number.isFinite(lastPresenceAge) && lastPresenceAge > 120 ? 'warn' : 'ok') : (monitor.presence?.reason === 'sync-failed' ? 'warn' : 'bad'), '◌'),
    monitorSetStatusCard('رتب السيرفر الأساسي', monitor.loadErrors.some((item) => item.startsWith('roster:')) ? 'تعذر تحديث دليل الرتب' : roster.groups?.length ? `${members.length} عضو تم تحميلهم من دليل الاستاف` : 'تعذر تحميل دليل الرتب', monitor.loadErrors.some((item) => item.startsWith('roster:')) || !roster.groups?.length ? 'warn' : 'ok', '♜'),
    monitorSetStatusCard('Discord Audit Log', monitor.loadErrors.some((item) => item.startsWith('audit:')) ? 'تعذر تحميل سجل الإجراءات' : 'تم تحميل سجل الإجراءات', monitor.loadErrors.some((item) => item.startsWith('audit:')) ? 'warn' : 'ok', '≣'),
  ].join('');
  const presNote = $('#monitor-presence-note');
  if (presNote) presNote.textContent = presenceFresh
    ? `آخر نبضة من البوت: ${formatDate(monitor.presence?.lastSeenAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}. آخر مزامنة ناجحة: ${monitor.presence?.lastSyncAt ? formatDate(monitor.presence.lastSyncAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'غير متاحة'}. إذا كتب العضو أو دخل فويس بينما Discord يظهره Offline، سيظهر كنشط مؤخرًا لمدة 5 دقائق. ده مؤشر نشاط وليس كشفًا مضمونًا لوضع Invisible؛ فـDiscord لا يفرّق بين Offline وInvisible.`
    : monitor.presence?.reason === 'stale-heartbeat'
      ? `آخر نبضة منذ ${monitorAgo(monitor.presence?.lastSeenAt)}؛ تأكد أن الخدمة تعمل باستمرار وتستخدم DATABASE_URL نفسه الموجود في Vercel.`
      : monitor.presence?.reason === 'sync-failed'
        ? `الـ worker يعمل لكن فشل في مزامنة الأعضاء. الخطأ الأخير: ${presenceError || 'غير مسجل'}. افتح Logs على استضافة worker وتأكد أن البوت موجود في سيرفر الاستاف وأن STAFF_GUILD_ID صحيح.`
        : monitor.presence?.reason === 'sync-not-complete'
          ? 'وصلت نبضة الـ worker لكن لم تنجح مزامنة الأعضاء بعد. افتح Logs على استضافة worker لمعرفة خطأ [presence startup/retry].'
          : 'لم تصل نبضة من bot-worker. شغّله على استضافة Node دائمة بنفس DISCORD_BOT_TOKEN وDATABASE_URL، وتأكد أن توكن البوت من نفس تطبيق Discord الذي فعّلت فيه Intents.';
  const presenceStats = $('#monitor-presence-stats');
  if (presenceStats) presenceStats.innerHTML = [
    ['Online', statCounts.online, 'online'], ['Idle', statCounts.idle, 'idle'], ['Do Not Disturb', statCounts.dnd, 'dnd'], ['Offline / Invisible بدون نشاط حديث', statCounts.offline, 'offline'], ['Offline لكن نشط خلال آخر 5 دقائق', statCounts.offline_active, 'offline'], ['حالة غير مستلمة', statCounts.unknown, 'unknown'],
  ].map(([label, count, status]) => `<article class="monitor-presence-card status-${status}${count === null ? ' status-unknown' : ''}"><span class="monitor-presence-dot"></span><b>${count === null ? '—' : monitorFormatNumber(count)}</b><small>${label}</small></article>`).join('');
  const activityBox = $('#monitor-top-active');
  const topActive = [...members].map((member) => ({ member, stats: statsById.get(String(member.id)) || {} })).sort((a, b) => Number(b.stats.dailyMessages || 0) - Number(a.stats.dailyMessages || 0)).filter((row) => Number(row.stats.dailyMessages || 0) > 0).slice(0, 8);
  const maxMessages = Math.max(1, ...topActive.map((row) => Number(row.stats.dailyMessages || 0)));
  if (activityBox) activityBox.innerHTML = `<div class="monitor-subheading"><b>أعلى نشاط رسائل اليوم</b><small>من روم الإحصاء المحدد في إعدادات البوت</small></div>${monitor.loadErrors.some((item) => item.startsWith('stats:')) ? '<div class="task-empty">بيانات الرسائل غير متاحة؛ تعذر تحميل إحصائيات الاستاف.</div>' : topActive.length ? topActive.map(({ member, stats }, index) => `<div class="monitor-activity-row"><span class="monitor-activity-rank">${index + 1}</span><img src="${escapeHtml(member.avatarUrl || avatarFallback(member.id))}" alt=""><div class="monitor-activity-main"><b>${escapeHtml(member.username)}</b><div class="monitor-activity-track"><span style="width:${Math.max(2, Number(stats.dailyMessages || 0) / maxMessages * 100)}%"></span></div></div><strong>${monitorFormatNumber(stats.dailyMessages)}</strong></div>`).join('') : '<div class="task-empty">لا توجد رسائل مسجلة لليوم حتى الآن.</div>'}`;
  const memberCount = $('#monitor-member-count'); if (memberCount) memberCount.textContent = monitorFormatNumber(members.length) + ' عضو';
  renderMonitorMembers(true);
  renderMonitorVoiceTimeList();
  const taskStats = $('#monitor-task-stats');
  if (taskStats) taskStats.innerHTML = [
    ['كل التسليمات', totalStats.total ?? metrics.totalSubmissions ?? '—'], ['مقبولة', totalStats.approved ?? metrics.approvedSubmissions ?? '—'], ['قيد المراجعة', totalStats.pending ?? metrics.pendingSubmissions ?? '—'], ['مرفوضة', totalStats.rejected ?? metrics.rejectedSubmissions ?? '—'], ['المهمات النشطة', metrics.activeTasks ?? '—'], ['الإجباري النشط', metrics.requiredActiveTasks ?? '—'], ['تنتهي خلال 24 ساعة', metrics.dueWithin24Hours ?? '—'], ['قرارات آخر 24 ساعة', metrics.reviewDecisions24h ?? '—'],
  ].map(([label, value]) => `<div class="monitor-mini-stat"><small>${escapeHtml(label)}</small><b>${escapeHtml(value === '—' ? value : monitorFormatNumber(value))}</b></div>`).join('');
  const bars = $('#monitor-task-bars');
  if (bars) {
    if (!monitor.taskStats && !monitor.summary) bars.innerHTML = '<div class="task-empty">بيانات توزيع التسليمات غير متاحة حاليًا.</div>';
    else {
      const total = Math.max(1, Number(totalStats.total ?? metrics.totalSubmissions ?? 0));
      const segments = [['مقبول', totalStats.approved ?? metrics.approvedSubmissions ?? 0, 'green'], ['بانتظار المراجعة', totalStats.pending ?? metrics.pendingSubmissions ?? 0, 'amber'], ['مرفوض', totalStats.rejected ?? metrics.rejectedSubmissions ?? 0, 'red']];
      bars.innerHTML = `<div class="monitor-progress-track">${segments.map(([, value, color]) => `<span class="fill-${color}" style="width:${Math.max(0, Number(value) / total * 100)}%"></span>`).join('')}</div><div class="monitor-legend">${segments.map(([label, value, color]) => `<span><i class="fill-${color}"></i>${escapeHtml(label)}: ${monitorFormatNumber(value)}</span>`).join('')}</div>`;
    }
  }
  const pendingRequests = $('#monitor-pending-requests');
  const reqs = [
    ...(monitor.staffRequests || []).filter((item) => item.status === 'pending').map((item) => ({ kind: 'طلب إداري', title: item.subject || item.requestType || 'طلب بدون عنوان', reason: item.details || '', by: item.username, when: item.createdAt, id: item.id, href: 'staff-request' })),
    ...(monitor.leaveRequests || []).filter((item) => item.status === 'pending').map((item) => ({ kind: 'طلب إجازة', title: `${item.startDate || '?'} — ${item.endDate || '?'}`, reason: item.reason || '', by: item.username, when: item.createdAt, id: item.id, href: 'leave' })),
  ].sort((a, b) => new Date(b.when || 0) - new Date(a.when || 0)).slice(0, 8);
  if (pendingRequests) {
    const requestsUnavailable = monitor.loadErrors.some((item) => item.startsWith('staffRequests:')) && monitor.loadErrors.some((item) => item.startsWith('leaveRequests:'));
    pendingRequests.innerHTML = reqs.length ? reqs.map((item) => `<article class="monitor-event"><span class="monitor-event-mark warn">!</span><div class="monitor-event-main"><b>${escapeHtml(item.kind)} #${escapeHtml(item.id)}: ${escapeHtml(item.title)}</b><small>${escapeHtml(item.by || 'عضو')} · ${escapeHtml(monitorAgo(item.when))}</small>${item.reason ? `<p>${escapeHtml(item.reason)}</p>` : ''}</div><span class="monitor-tag warn">معلّق</span></article>`).join('') : requestsUnavailable ? '<div class="task-empty">تعذر تحميل الطلبات من مصدريها؛ تحقق من تفاصيل الخطأ بالأعلى.</div>' : '<div class="task-empty">مفيش طلبات إدارية أو إجازات معلّقة.</div>';
  }
  const auditBox = $('#monitor-audit-events');
  if (auditBox) auditBox.innerHTML = (monitor.audit || []).length ? monitor.audit.slice(0, 8).map((entry) => `<article class="monitor-event"><span class="monitor-event-mark ${entry.tone === 'danger' ? 'bad' : entry.tone === 'create' ? 'ok' : 'neutral'}">${entry.tone === 'danger' ? '!' : entry.tone === 'create' ? '+' : '≣'}</span><div class="monitor-event-main"><b>${escapeHtml(entry.label || 'إجراء إداري')}</b><small>${escapeHtml(entry.actor?.username || entry.actor?.id || 'غير معروف')}${entry.targetName ? ` ← ${escapeHtml(entry.targetName)}` : ''} · ${escapeHtml(monitorAgo(entry.createdAt))}</small>${entry.reason ? `<p>${escapeHtml(entry.reason)}</p>` : ''}</div><span class="monitor-tag ${entry.tone === 'danger' ? 'bad' : 'neutral'}">${escapeHtml(entry.tone === 'danger' ? 'حساس' : 'Discord')}</span></article>`).join('') : '<div class="task-empty">لا توجد إجراءات متاحة أو تعذّر تحميل السجل.</div>';
  const reviewBox = $('#monitor-review-events');
  if (reviewBox) reviewBox.innerHTML = (monitor.reviewAudit || []).length ? monitor.reviewAudit.slice(0, 8).map((entry) => { const status = entry.decision === 'approved' ? ['موافقة', 'ok'] : entry.decision === 'rejected' ? ['رفض', 'bad'] : ['إعادة فتح', 'warn']; return `<article class="monitor-event"><span class="monitor-event-mark ${status[1]}">${status[1] === 'ok' ? '✓' : status[1] === 'bad' ? '!' : '↻'}</span><div class="monitor-event-main"><b>${escapeHtml(status[0])} · التسليم #${entry.submissionId}</b><small>${escapeHtml(entry.reviewerName || entry.reviewerId)} راجع ${escapeHtml(entry.memberName || entry.memberId)} · ${escapeHtml(monitorAgo(entry.createdAt))}</small>${entry.reason ? `<p>${escapeHtml(entry.reason)}</p>` : ''}</div><span class="monitor-tag ${status[1]}">${escapeHtml(status[0])}</span></article>`; }).join('') : monitor.loadErrors.some((item) => item.startsWith('reviewAudit:')) ? '<div class="task-empty">تعذر تحميل سجل قرارات الإدارة.</div>' : '<div class="task-empty">لا توجد قرارات مراجعة مسجلة حتى الآن.</div>';
  const alerts = $('#monitor-alerts');
  if (alerts) {
    const items = [];
    if (health && !health.botReady) items.push(['bad', 'البوت غير جاهز — راجع التوكن أو صلاحيات Discord.']);
    if (health && !health.databaseReady) items.push(['bad', 'اتصال قاعدة البيانات غير مؤكد.']);
    if (!health) items.push(['warn', 'تعذر فحص صحة الخدمات؛ لا يمكن تأكيد أن البوت أو قاعدة البيانات متعطلان.']);
    if (!presenceFresh) items.push(['warn', 'حالة Discord غير متاحة حاليًا؛ لا تعتبرها Offline.']);
    const missingMain = members.filter((member) => member.roleId === 'not-in-main').length;
    const noRole = members.filter((member) => member.roleId === 'none').length;
    if (missingMain) items.push(['warn', `${missingMain} عضوًا في دليل الاستاف غير موجودين في السيرفر الأساسي.`]);
    if (noRole) items.push(['warn', `${noRole} عضوًا ليس لديهم رتبة في السيرفر الأساسي.`]);
    if (failures.length) {
      items.push(['warn', `تعذّر تحميل ${failures.length} مصدر: ${failures.map((item) => item.split(':')[0]).join('، ')}.`]);
      failures.forEach((failure) => items.push(['warn', failure]));
    }
    alerts.innerHTML = items.map(([tone, message]) => `<div class="monitor-alert ${tone}"><b>${tone === 'bad' ? 'مشكلة' : 'ملاحظة'}</b><span>${escapeHtml(message)}</span></div>`).join('');
  }
  const updated = $('#monitor-last-updated');
  if (updated) updated.textContent = `آخر تحديث: ${formatDate(monitor.updatedAt || new Date(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Africa/Cairo' })} بتوقيت القاهرة`;
}
function formatVoiceDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor((Number(durationMs) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
function updateVoiceDurationCounters() {
  const now = Date.now();
  $$('.voice-time-clock[data-voice-base-ms]').forEach((node) => {
    const base = Math.max(0, Number(node.dataset.voiceBaseMs) || 0);
    const fetchedAt = Number(node.dataset.voiceFetchedAt) || now;
    const isLive = node.dataset.voiceLive === 'true';
    node.textContent = formatVoiceDuration(base + (isLive ? Math.max(0, now - fetchedAt) : 0));
  });
}
async function fetchProfileVoiceTime(userId) {
  const id = String(userId || '');
  if (!id || !state.user?.id) return null;
  if (!state.user.canManage && id !== String(state.user.id)) return null;
  state.profileVoiceTime = state.profileVoiceTime || {};
  const current = state.profileVoiceTime[id];
  if (current?.requestInFlight) return current;
  state.profileVoiceTime[id] = { ...(current || {}), requestInFlight: true };
  try {
    const data = await api(`/api/voice-time/${encodeURIComponent(id)}`);
    state.profileVoiceTime[id] = { ...data, fetchedAt: Date.now(), requestInFlight: false };
  } catch (error) {
    state.profileVoiceTime[id] = { available: false, member: null, error: error?.message || 'voice-time-unavailable', fetchedAt: Date.now(), requestInFlight: false };
  }
  updateProfileVoiceTimeDisplay(id);
  return state.profileVoiceTime[id];
}
function updateProfileVoiceTimeDisplay(userId) {
  const id = String(userId || '');
  const record = state.profileVoiceTime?.[id];
  if (!record) return;
  const sections = $$('[data-profile-voice-time-for]').filter((node) => String(node.dataset.profileVoiceTimeFor) === id);
  if (!sections.length) return;
  const available = Boolean(record.available && record.member);
  const member = record.member || {};
  const inVoice = available && Boolean(member.inVoice);
  sections.forEach((section) => {
    const clock = $('[data-profile-voice-clock]', section);
    const status = $('[data-profile-voice-status]', section);
    const currentState = $('[data-profile-voice-state]', section);
    if (clock) {
      if (available) {
        clock.dataset.voiceBaseMs = String(Math.max(0, Number(member.durationMs) || 0));
        clock.dataset.voiceFetchedAt = String(Number(record.fetchedAt) || Date.now());
        clock.dataset.voiceLive = inVoice ? 'true' : 'false';
        clock.textContent = formatVoiceDuration(member.durationMs);
      } else {
        delete clock.dataset.voiceBaseMs;
        delete clock.dataset.voiceFetchedAt;
        delete clock.dataset.voiceLive;
        clock.textContent = '—';
      }
    }
    if (status) status.textContent = !available ? 'بيانات الفويس غير متاحة مؤقتًا' : inVoice ? 'العضو في فويس دلوقتي' : 'العضو مش في فويس حاليًا';
    if (currentState) currentState.textContent = !available ? 'غير متاح' : inVoice ? 'في مكالمة' : 'مش في مكالمة';
  });
}
function renderMonitorVoiceTimeList() {
  const root = $('#monitor-voice-time-list');
  if (!root) return;
  const data = state.monitor.voiceTime;
  if (!data) {
    root.innerHTML = '<div class="task-empty">وقت الفويس لسه ما وصلش من البوت.</div>';
    return;
  }
  if (!data.available) {
    const reason = data.reason === 'stale-heartbeat'
      ? 'الـ bot-worker مش بيبعت نبضات حديثة. شغّل الخدمة وتأكد إنها بتستخدم نفس DATABASE_URL.'
      : 'مفيش نبضة مؤكدة من متتبع الفويس لحد دلوقتي. أعد تشغيل bot-worker بعد تحديثه.';
    root.innerHTML = `<div class="task-empty">${escapeHtml(reason)}</div>`;
    return;
  }
  const rows = (data.members || []).filter((item) => Number(item.durationMs) > 0 || item.inVoice).slice(0, 15);
  const day = data.dailyDate ? `بتوقيت القاهرة · ${escapeHtml(data.dailyDate)}` : 'بتوقيت القاهرة';
  const lastSeen = data.lastSeenAt ? `آخر نبضة منذ ${monitorAgo(data.lastSeenAt)}` : 'Live';
  const heading = `<div class="monitor-subheading"><b>أعلى وقت صوتي اليوم</b><small>${day} · ${escapeHtml(lastSeen)}</small></div>`;
  if (!rows.length) {
    root.innerHTML = `${heading}<div class="task-empty">لسه مفيش وقت فويس مسجل النهارده.</div>`;
    return;
  }
  const fetchedAt = Number(state.monitor.voiceTimeFetchedAt) || Date.now();
  root.innerHTML = heading + rows.map((item, index) => `<div class="monitor-activity-row voice-time-rank-row"><span class="monitor-activity-rank">${String(index + 1).padStart(2, '0')}</span><div class="monitor-activity-main"><b>${escapeHtml(item.username || item.userId)}</b><small>${item.inVoice ? '🟢 موجود في فويس الآن' : 'أنهى المكالمة'}</small></div><strong class="voice-time-clock" data-voice-base-ms="${Math.max(0, Number(item.durationMs) || 0)}" data-voice-fetched-at="${fetchedAt}" data-voice-live="${item.inVoice ? 'true' : 'false'}">${formatVoiceDuration(item.durationMs)}</strong></div>`).join('');
  updateVoiceDurationCounters();
}
let voiceTimeRefreshInFlight = false;
async function refreshVoiceTime(options = {}) {
  if (!state.user?.canManage || voiceTimeRefreshInFlight) return;
  voiceTimeRefreshInFlight = true;
  try {
    const data = await api('/api/voice-time');
    state.monitor.voiceTime = data;
    state.monitor.voiceTimeFetchedAt = Date.now();
    renderMonitorVoiceTimeList();
    renderMonitorMembers(false);
  } catch (error) {
    if (!options.silent) showToast(error.message || 'تعذر تحميل وقت الفويس.', 'error');
  } finally {
    voiceTimeRefreshInFlight = false;
  }
}

function renderMonitorMembers(resetLimit = false) {
  const body = $('#monitor-members-body');
  if (!body) return;
  if (resetLimit) state.monitor.memberLimit = 100;
  const monitor = state.monitor;
  const roster = monitor.roster || state.roster || { groups: [], memberCount: 0 };
  const members = (roster.groups || []).flatMap((group) => (group.members || []).map((member) => ({ ...member, sourceRoleName: member.roleName || group.name })));
  const statsById = new Map((monitor.staffStats || []).map((item) => [String(item.userId), item]));
  const siteById = new Map((monitor.summary?.siteActivity || []).map((item) => [String(item.userId), item]));
  const voiceById = new Map((monitor.voiceTime?.members || []).map((item) => [String(item.userId), item]));
  const voiceAvailable = Boolean(monitor.voiceTime?.available);
  const discordReady = Boolean(monitor.presence?.available);
  const statuses = discordReady ? (monitor.presence?.statuses || {}) : {};
  const query = ($('#monitor-member-search')?.value || '').trim().toLocaleLowerCase('ar');
  const filter = $('#monitor-member-filter')?.value || 'all';
  const roleFilter = $('#monitor-role-filter')?.value || '';
  const roleSelect = $('#monitor-role-filter');
  if (roleSelect) {
    const previousRole = roleSelect.value || roleFilter;
    const roles = [...new Map(members.filter((member) => member.roleId && !['none','not-in-main'].includes(String(member.roleId))).map((member) => [String(member.roleId), String(member.roleName || member.roleId)])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'ar'));
    const options = '<option value="">كل الرتب الأساسية</option>' + roles.map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join('');
    if (roleSelect.dataset.optionsKey !== JSON.stringify(roles)) { roleSelect.innerHTML = options; roleSelect.dataset.optionsKey = JSON.stringify(roles); }
    roleSelect.value = roles.some(([id]) => id === previousRole) ? previousRole : '';
  }
  const selectedRole = roleSelect?.value || '';
  const filtered = members.filter((member) => {
    const id = String(member.id); const stats = statsById.get(id) || {}; const site = siteById.get(id);
    const status = statuses[id] || 'unknown'; const siteOnline = Boolean(site && Date.now() - new Date(site.lastSeen).getTime() < 150000);
    const roles = (member.roles || []).map((role) => role.name).join(' ');
    const searchText = `${member.username} ${member.handle} ${id} ${member.roleName || ''} ${roles}`.toLocaleLowerCase('ar');
    if (query && !searchText.includes(query)) return false;
    if (selectedRole && String(member.roleId) !== selectedRole) return false;
    if (filter === 'admins' && !member.isAdmin) return false;
    if (filter === 'discord-online' && !(discordReady && ['online','idle','dnd'].includes(status))) return false;
    if (filter === 'discord-offline-active' && !(discordReady && status === 'offline_active')) return false;
    if (filter === 'site-online' && !siteOnline) return false;
    if (filter === 'not-main' && member.roleId !== 'not-in-main') return false;
    if (filter === 'no-role' && member.roleId !== 'none') return false;
    return true;
  });
  const shown = filtered.slice(0, state.monitor.memberLimit || 100);
  if (!shown.length) body.innerHTML = '<tr><td colspan="11" class="loading-state">مفيش أعضاء مطابقين للفلاتر.</td></tr>';
  else body.innerHTML = shown.map((member) => {
    const id = String(member.id); const stats = statsById.get(id) || {}; const site = siteById.get(id);
    const status = statuses[id] || 'unknown'; const siteOnline = Boolean(site && Date.now() - new Date(site.lastSeen).getTime() < 150000);
    const statusTone = !discordReady || status === 'unknown' ? 'unknown' : ['online','idle','dnd'].includes(status) ? status : 'offline';
    const roleNames = (member.roles || []).map((role) => role.name).join(' · ');
    const submissions = `${monitorFormatNumber(stats.totalSubmissions || 0)}<small> ${monitorFormatNumber(stats.approvedSubmissions || 0)} مقبول · ${monitorFormatNumber(stats.pendingSubmissions || 0)} معلّق</small>`;
    const requests = `${monitorFormatNumber(stats.adminRequests || 0)}<small> إداري · ${monitorFormatNumber(stats.leaveRequests || 0)} إجازة</small>`;
    const voice = voiceById.get(id) || { durationMs: 0, inVoice: false };
    const voiceCell = voiceAvailable
      ? `<span class="voice-time-clock" data-voice-base-ms="${Math.max(0, Number(voice.durationMs) || 0)}" data-voice-fetched-at="${Number(monitor.voiceTimeFetchedAt) || Date.now()}" data-voice-live="${voice.inVoice ? 'true' : 'false'}">${formatVoiceDuration(voice.durationMs)}</span>${voice.inVoice ? '<small class="voice-live-tag">في فويس دلوقتي</small>' : ''}`
      : '<span class="voice-time-unavailable" title="تأكد إن bot-worker شغال ومتصّل بالداتابيز">—</span>';
    return `<tr><td><div class="monitor-member-cell"><img src="${escapeHtml(member.avatarUrl || avatarFallback(id))}" alt=""><div><b>${escapeHtml(member.username || id)}${member.isAdmin ? '<span class="monitor-admin-chip">إدارة</span>' : ''}</b><small>${escapeHtml(id)}</small></div></div></td><td><b>${escapeHtml(member.roleName || '—')}</b><small class="monitor-role-list">${escapeHtml(roleNames || 'بدون رتب مرئية')}</small></td><td><span class="monitor-status-pill ${statusTone}"><i></i>${escapeHtml(monitorStatusLabel(status, discordReady))}</span></td><td><span class="monitor-status-pill ${siteOnline ? 'online' : 'offline'}"><i></i>${siteOnline ? 'نشط بالموقع' : 'غير نشط'}</span></td><td class="voice-time-cell">${voiceCell}</td><td>${monitorFormatNumber(stats.dailyMessages || 0)}</td><td>${monitorFormatNumber(stats.totalMessages || 0)}</td><td>${submissions}</td><td>${monitorFormatNumber(stats.totalPoints || 0)}</td><td>${requests}</td><td>${escapeHtml(monitorAgo(site?.lastSeen || stats.lastSeen))}</td></tr>`;
  }).join('');
  const shownLabel = $('#monitor-members-shown'); if (shownLabel) shownLabel.textContent = `عرض ${monitorFormatNumber(shown.length)} من ${monitorFormatNumber(filtered.length)} عضو مطابق`;
  const more = $('#monitor-members-more'); if (more) { more.classList.toggle('hidden', shown.length >= filtered.length); more.disabled = shown.length >= filtered.length; }
}
function exportAdminMonitoringCsv() {
  if (!state.user?.canManage) return;
  const roster = state.monitor.roster || state.roster || { groups: [] };
  const members = (roster.groups || []).flatMap((group) => group.members || []);
  const statsById = new Map((state.monitor.staffStats || []).map((item) => [String(item.userId), item]));
  const siteById = new Map((state.monitor.summary?.siteActivity || []).map((item) => [String(item.userId), item]));
  const statuses = state.monitor.presence?.available ? (state.monitor.presence.statuses || {}) : {};
  const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = [['Discord ID','Username','Main server highest role','Roles','Is admin','Discord status','Website last seen','Messages today','Total messages','Submissions','Approved','Pending','Rejected','Points','Leave requests','Admin requests']];
  members.forEach((member) => { const id=String(member.id); const stats=statsById.get(id)||{}; const site=siteById.get(id); rows.push([id, member.username, member.roleName, (member.roles||[]).map((role)=>role.name).join(' | '), member.isAdmin?'yes':'no', state.monitor.presence?.available ? monitorStatusLabel(statuses[id]||'unknown',true) : 'unavailable', site?.lastSeen || '', stats.dailyMessages||0, stats.totalMessages||0, stats.totalSubmissions||0, stats.approvedSubmissions||0, stats.pendingSubmissions||0, stats.rejectedSubmissions||0, stats.totalPoints||0, stats.leaveRequests||0, stats.adminRequests||0]); });
  const csv = '\uFEFF' + rows.map((row) => row.map(quote).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a'); link.href = url; link.download = `borg-management-monitor-${new Date().toISOString().slice(0,10)}.csv`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

const LB_METRICS = {
  points: { field: 'totalPoints', unit: 'نقطة' },
  messages: { field: 'totalMessages', unit: 'رسالة' },
  today: { field: 'dailyMessages', unit: 'رسالة اليوم' },
  approved: { field: 'approvedSubmissions', unit: 'تسليم مقبول' },
};
function renderLeaderboard() {
  const podium = $('#lb-podium');
  const list = $('#lb-list');
  if (!podium || !list) return;
  const metric = LB_METRICS[state.lbMetric] || LB_METRICS.points;
  const roster = new Map(flattenRoster().map((member) => [String(member.id), member]));
  const num = (value) => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const rows = (state.staffStats || [])
    .map((item) => ({ item, value: Number(item[metric.field]) || 0 }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((row, index) => {
      const member = roster.get(String(row.item.userId));
      return { rank: index + 1, id: String(row.item.userId), value: row.value, name: member?.username || row.item.username || String(row.item.userId), avatar: member?.avatarUrl || avatarFallback(row.item.userId), role: member?.roleName || '' };
    });
  if (!rows.length) {
    podium.innerHTML = '';
    list.innerHTML = '<div class="task-empty">لسه مفيش بيانات كفاية للترتيب ده.</div>';
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  const mineId = String(state.user?.id || '');
  const rollKey = (row) => `lb:${state.lbMetric}:${row.id}`;
  const beforeFlip = flipCapture(list, 'data-open-staff-profile');
  const card = (row) => `<button type="button" class="lb-podium-card rank-${row.rank}${row.id === mineId ? ' is-me' : ''}" data-open-staff-profile="${escapeHtml(row.id)}"><span class="lb-medal">${medals[row.rank - 1]}</span><img src="${escapeHtml(row.avatar)}" alt=""><b>${escapeHtml(row.name)}</b><small>${escapeHtml(row.role)}</small><strong>${rollMarkup(rollKey(row), row.value)}</strong><em>${metric.unit}</em></button>`;
  const top = rows.slice(0, 3);
  // ترتيب العرض: الثاني - الأول - الثالث عشان الأول يبقى في النص
  const display = top.length === 3 ? [top[1], top[0], top[2]] : top;
  podium.innerHTML = display.map(card).join('');
  const rest = rows.slice(3);
  list.innerHTML = rest.map((row) => `<button type="button" class="lb-row${row.id === mineId ? ' is-me' : ''}" data-open-staff-profile="${escapeHtml(row.id)}"><span class="lb-rank">#${row.rank}</span><img src="${escapeHtml(row.avatar)}" alt=""><div class="lb-name"><b>${escapeHtml(row.name)}${row.id === mineId ? ' <i>(أنت)</i>' : ''}</b><small>${escapeHtml(row.role)}</small></div><div class="lb-value"><strong>${rollMarkup(rollKey(row), row.value)}</strong><small>${metric.unit}</small></div></button>`).join('');
  [...$$('[data-open-staff-profile]', podium), ...$$('[data-open-staff-profile]', list)].forEach((button) => button.addEventListener('click', () => openStaffProfile(button.dataset.openStaffProfile)));
  rollPlay(podium);
  rollPlay(list);
  flipPlay(list, 'data-open-staff-profile', beforeFlip);
}

async function loadAudit(reset = true) {
  const box = $('#audit-list');
  const more = $('#audit-more');
  if (!box || !state.user?.canManage || state.audit.loading) return;
  if (reset) { state.audit = { entries: [], nextBefore: null, hasMore: false, loading: true }; box.innerHTML = '<div class="loading-state">جاري تحميل سجل السيرفر...</div>'; }
  else state.audit.loading = true;
  if (more) more.disabled = true;
  try {
    const params = new URLSearchParams();
    const actionType = $('#audit-action')?.value;
    const userId = ($('#audit-user')?.value || '').trim();
    if (actionType) params.set('actionType', actionType);
    if (/^\d{15,22}$/.test(userId)) params.set('userId', userId);
    if (!reset && state.audit.nextBefore) params.set('before', state.audit.nextBefore);
    const result = await api(`/api/audit-log${params.toString() ? `?${params}` : ''}`);
    state.audit.entries = state.audit.entries.concat(result.entries || []);
    state.audit.nextBefore = result.nextBefore || null;
    state.audit.hasMore = Boolean(result.hasMore);
    renderAudit();
  } catch (error) {
    if (!state.audit.entries.length) box.innerHTML = `<div class="task-empty">${escapeHtml(error.message)}</div>`;
    else showToast(error.message, 'error');
  } finally {
    state.audit.loading = false;
    if (more) { more.disabled = false; more.classList.toggle('hidden', !state.audit.hasMore); }
  }
}
function renderAudit() {
  const box = $('#audit-list');
  if (!box) return;
  const query = ($('#audit-search')?.value || '').trim().toLowerCase();
  const toneClass = { danger: 'required', create: 'completed', edit: 'optional' };
  const entries = state.audit.entries.filter((entry) => !query || [entry.label, entry.actor?.username, entry.targetName, entry.targetId, entry.reason, ...(entry.changes || []).map((change) => `${change.key} ${change.oldValue} ${change.newValue}`)].join(' ').toLowerCase().includes(query));
  if (!entries.length) {
    box.innerHTML = `<div class="task-empty">${state.audit.entries.length ? 'مفيش نتائج مطابقة للبحث.' : 'مفيش أحداث في السجل بالفلتر ده.'}</div>`;
    return;
  }
  box.innerHTML = entries.map((entry) => {
    const target = entry.targetName
      ? `<span class="audit-target">${entry.targetAvatarUrl ? `<img src="${escapeHtml(entry.targetAvatarUrl)}" alt="">` : ''}${escapeHtml(entry.targetName)}</span>`
      : entry.targetId ? `<span class="audit-target"><code>${escapeHtml(entry.targetId)}</code></span>` : '';
    const extra = [entry.count > 1 ? `× ${entry.count}` : '', entry.channelId ? `روم <code>${escapeHtml(entry.channelId)}</code>` : ''].filter(Boolean).join(' · ');
    const changes = (entry.changes || []).length
      ? `<details class="audit-changes"><summary>التفاصيل (${entry.changes.length})</summary>${entry.changes.map((change) => `<div><code>${escapeHtml(change.key)}</code>: <span class="old">${escapeHtml(change.oldValue)}</span> ← <span class="new">${escapeHtml(change.newValue)}</span></div>`).join('')}</details>`
      : '';
    return `<article class="audit-entry tone-${escapeHtml(entry.tone)}"><img class="audit-avatar" src="${escapeHtml(entry.actor?.avatarUrl || avatarFallback(entry.actor?.id))}" alt=""><div class="audit-main"><div class="audit-line"><b>${escapeHtml(entry.actor?.username || 'غير معروف')}</b><span class="task-tag ${toneClass[entry.tone] || 'optional'}">${escapeHtml(entry.label)}</span>${target}${extra ? `<small class="muted">${extra}</small>` : ''}</div>${entry.reason ? `<p class="audit-reason">السبب: ${escapeHtml(entry.reason)}</p>` : ''}${changes}<time class="audit-time">${escapeHtml(formatDate(entry.createdAt, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</time></div></article>`;
  }).join('');
}

async function loadPersonal(force = false) {
  const me = state.user;
  const box = $('#personal-content');
  if (!me?.id || !box) return;
  if (force || !box.querySelector('.pf-hero')) box.innerHTML = '<div class="loading-state">جاري تحميل إحصائياتك...</div>';
  try {
    const [response] = await Promise.all([
      api(`/api/staff-stats/${encodeURIComponent(me.id)}`),
      fetchProfileVoiceTime(me.id),
    ]);
    if (!$('#page-personal')?.classList.contains('active-page')) return;
    const member = findStaffProfileMember(me.id) || { id: String(me.id), username: me.username || String(me.id), handle: me.handle || String(me.id), avatarUrl: me.avatarUrl || avatarFallback(me.id), roleName: 'عضو الاستاف', roles: [], isAdmin: Boolean(me.isAdmin) };
    renderStaffProfile(member, response, '#personal-content');
  } catch (error) {
    box.innerHTML = `<div class="task-empty">${escapeHtml(error.message)}</div>`;
  }
}
function snowflakeDate(id) {
  try { return new Date(Number((BigInt(id) >> 22n) + 1420070400000n)); } catch { return null; }
}
function hourLabel(hour) {
  if (hour === null || hour === undefined) return '—';
  return hour === 0 ? '12 ص' : hour < 12 ? `${hour} ص` : hour === 12 ? '12 م' : `${hour - 12} م`;
}
function renderStaffProfile(member, response = {}, target = '#staff-profile-content') {
  const root = $(target);
  if (!root) return;
  const stats = response.stats || {};
  const mp = response.messageProfile || { total: 0, today: 0, week: 0, month: 0, avgPerDay: 0, activeDays: 0, activity: [], hours: [] };
  const ranks = response.ranks || {};
  const submissions = response.recentSubmissions || [];
  const leaves = response.recentLeaves || [];
  const points = response.recentPoints || [];
  const requests = response.recentRequests || [];
  const restricted = Boolean(response.restricted);
  const online = state.onlineUserIds.has(String(member.id));
  const num = (value) => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const dateOnly = (value) => (value ? escapeHtml(formatDate(value, { day: 'numeric', month: 'long', year: 'numeric' })) : '—');
  const dateTime = (value) => (value ? escapeHtml(formatDate(value, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })) : '—');
  const color = /^#[0-9a-f]{6}$/i.test(member.roleColor || '') ? member.roleColor : '#8972fb';
  const roles = (member.roles || []).map((role) => `<span class="profile-role-chip" style="${/^#[0-9a-f]{6}$/i.test(role.color) ? `border-color:${role.color}66;color:${role.color}` : ''}">${escapeHtml(role.name)}</span>`).join('') || '<span class="muted">لا توجد رتب إضافية</span>';
  const created = snowflakeDate(member.id);
  const statusText = { approved: 'تمت الموافقة', submitted: 'بانتظار المراجعة', pending: 'بانتظار المراجعة', rejected: 'مرفوض', reopened: 'أُعيد فتحه' };
  const statusClass = (status) => (status === 'approved' ? 'completed' : status === 'rejected' ? 'required' : 'optional');
  const typeText = { permission: 'طلب إذن / غياب', technical: 'مشكلة تقنية', 'data-change': 'تعديل بيانات', complaint: 'شكوى أو ملاحظة', other: 'طلب إداري آخر' };

  const rankBadge = (icon, label, info) => (info?.rank ? `<span class="pf-rank"><b>${icon} #${info.rank}</b><small>${label} · من ${info.of}</small></span>` : `<span class="pf-rank muted-rank"><b>${icon} —</b><small>${label}</small></span>`);
  const kpi = (label, value, note = '', accent = false) => `<article class="pf-kpi${accent ? ' accent' : ''}"><small>${label}</small><strong>${typeof value === 'string' ? escapeHtml(value) : num(value)}</strong>${note ? `<span>${note}</span>` : ''}</article>`;
  const profileVoiceRecord = state.profileVoiceTime[String(member.id)] || null;
  const profileVoiceAvailable = Boolean(profileVoiceRecord?.available && profileVoiceRecord?.member);
  const profileVoiceMember = profileVoiceRecord?.member || {};
  const profileVoiceDuration = profileVoiceAvailable ? Math.max(0, Number(profileVoiceMember.durationMs) || 0) : 0;
  const profileVoiceLive = profileVoiceAvailable && Boolean(profileVoiceMember.inVoice);
  const profileVoiceStatus = !profileVoiceAvailable ? 'بيانات الفويس غير متاحة مؤقتًا' : profileVoiceLive ? 'العضو في فويس دلوقتي' : 'العضو مش في فويس حاليًا';
  const profileVoiceSection = `<section class="staff-profile-section profile-voice-time-section" data-profile-voice-time-for="${escapeHtml(member.id)}"><div class="section-title-row"><div><span class="tiny-label">VOICE ACTIVITY / DAILY</span><h2>وقت الفويس اليوم</h2><p class="muted small-copy">إجمالي الوقت في جميع قنوات الصوت بسيرفر الإدارة · يتحدّث لايف</p></div><span class="page-heading-badge voice-time-live-badge"><span class="status-dot"></span> LIVE · HH:MM:SS</span></div><div class="pf-kpis profile-voice-time-grid"><article class="pf-kpi accent profile-voice-time-card"><small>إجمالي وقت الفويس اليوم</small><strong><span class="voice-time-clock" data-profile-voice-clock="1" ${profileVoiceAvailable ? `data-voice-base-ms="${profileVoiceDuration}" data-voice-fetched-at="${Number(profileVoiceRecord.fetchedAt) || Date.now()}" data-voice-live="${profileVoiceLive ? 'true' : 'false'}"` : ''}>${profileVoiceAvailable ? formatVoiceDuration(profileVoiceDuration) : '—'}</span></strong><span data-profile-voice-status>${profileVoiceStatus}</span></article><article class="pf-kpi profile-voice-state-card"><small>حالة الفويس الحالية</small><strong data-profile-voice-state>${!profileVoiceAvailable ? 'غير متاح' : profileVoiceLive ? 'في مكالمة' : 'مش في مكالمة'}</strong><span>${profileVoiceAvailable && profileVoiceRecord.dailyDate ? `التاريخ: ${escapeHtml(profileVoiceRecord.dailyDate)} بتوقيت القاهرة` : 'يتطلب اتصال البوت وقاعدة البيانات'}</span></article></div></section>`;

  const maxDay = Math.max(1, ...(mp.activity || []).map((item) => item.count));
  const activityBars = (mp.activity || []).map((item) => {
    const height = item.count ? Math.max(6, Math.round((item.count / maxDay) * 100)) : 2;
    const label = escapeHtml(formatDate(`${item.date}T12:00:00Z`, { day: 'numeric', month: 'numeric', timeZone: 'UTC' }));
    return `<div class="pf-bar" title="${escapeHtml(item.date)} — ${item.count} رسالة"><em>${item.count || ''}</em><i class="${item.count ? '' : 'empty'}" style="height:${height}%"></i><span>${label}</span></div>`;
  }).join('');
  const maxHour = Math.max(1, ...(mp.hours || []).map((item) => item.count));
  const hourBars = (mp.hours || []).map((item) => `<div class="pf-hour${item.hour === mp.busiestHour ? ' top' : ''}" title="${hourLabel(item.hour)} — ${item.count} رسالة"><i style="height:${item.count ? Math.max(8, Math.round((item.count / maxHour) * 100)) : 3}%"></i>${item.hour % 6 === 0 ? `<span>${hourLabel(item.hour)}</span>` : '<span></span>'}</div>`).join('');

  const totalSub = Number(stats.totalSubmissions) || 0;
  const approvedSub = Number(stats.approvedSubmissions) || 0;
  const approvalRate = totalSub ? Math.round((approvedSub / totalSub) * 100) : 0;
  const pointsHtml = points.length ? points.map((item) => `<article class="profile-history-row"><div><b>${escapeHtml(item.reason || 'بدون سبب')}</b><small>${dateTime(item.createdAt)}${item.source && item.source !== 'manual' ? ` · ${escapeHtml(item.source)}` : ''}</small></div><span class="pf-points ${item.amount >= 0 ? 'plus' : 'minus'}">${item.amount >= 0 ? '+' : '−'}${num(Math.abs(item.amount))}</span></article>`).join('') : '<div class="task-empty">لا توجد حركات نقاط لهذا العضو.</div>';
  const submissionsHtml = submissions.length ? submissions.map((item) => `<article class="profile-history-row"><div><b>تسليم #${Number(item.id)}</b><small>${dateTime(item.submittedAt)}</small>${item.note ? `<p>${escapeHtml(item.note)}</p>` : ''}</div><span class="task-tag ${statusClass(item.status)}">${statusText[item.status] || escapeHtml(item.status)}</span></article>`).join('') : '<div class="task-empty">لا توجد تسليمات مسجلة لهذا العضو.</div>';
  const leavesHtml = leaves.length ? leaves.map((item) => `<article class="profile-history-row"><div><b>طلب إجازة #${Number(item.id)}</b><small>${escapeHtml(item.startDate)} — ${escapeHtml(item.endDate)}</small><p>${escapeHtml(item.reason)}</p></div><span class="task-tag ${statusClass(item.status)}">${statusText[item.status] || 'بانتظار المراجعة'}</span></article>`).join('') : '<div class="task-empty">لا توجد طلبات إجازة.</div>';
  const requestsHtml = requests.length ? requests.map((item) => `<article class="profile-history-row"><div><b>${escapeHtml(item.subject)}</b><small>${escapeHtml(typeText[item.requestType] || item.requestType)} · ${dateTime(item.createdAt)}</small></div><span class="task-tag ${statusClass(item.status)}">${statusText[item.status] || 'بانتظار المراجعة'}</span></article>`).join('') : '<div class="task-empty">لا توجد طلبات إدارية.</div>';

  root.innerHTML = `
    <div class="pf-hero" style="--pf-accent:${color}">
      <div class="pf-cover"></div>
      <div class="pf-hero-body">
        <img class="pf-avatar" src="${escapeHtml(member.avatarUrl || avatarFallback(member.id))}" alt="">
        <div class="pf-identity">
          <span class="tiny-label">${member.isAdmin ? 'ADMINISTRATOR PROFILE' : 'STAFF MEMBER PROFILE'}</span>
          <h1>${escapeHtml(member.username)}</h1>
          <p>@${escapeHtml(member.handle || member.id)} · <code>${escapeHtml(member.id)}</code> <button type="button" class="pf-copy" data-copy-id="${escapeHtml(member.id)}">نسخ ID</button></p>
          <div class="staff-profile-status"><span class="online-pill ${online ? 'online' : 'offline'}"><i></i>${online ? 'متصل بالموقع الآن' : 'غير متصل بالموقع'}</span><span class="manager-badge">${escapeHtml(member.roleName || 'عضو الاستاف')}</span></div>
        </div>
        <div class="pf-ranks">${rankBadge('💬', 'ترتيب الرسائل', ranks.messages)}${rankBadge('⭐', 'ترتيب النقاط', ranks.points)}</div>
      </div>
      <div class="pf-facts">
        ${member.joinedAt ? `<div><small>دخل سيرفر الاستاف</small><b>${dateOnly(member.joinedAt)}</b></div>` : ''}
        ${member.mainJoinedAt ? `<div><small>دخل السيرفر الأساسي</small><b>${dateOnly(member.mainJoinedAt)}</b></div>` : ''}
        <div><small>تاريخ إنشاء الحساب</small><b>${dateOnly(created)}</b></div>
        <div><small>أعلى رتبة</small><b>${escapeHtml(member.roleName || 'عضو الاستاف')}</b></div>
      </div>
    </div>

    ${profileVoiceSection}

    <section class="staff-profile-section"><div class="section-title-row"><div><span class="tiny-label">MESSAGES</span><h2>الرسائل</h2></div><small class="muted">رسائل الروم المحسوبة فقط · التاريخ ${escapeHtml(state.dailyMessageStats.dailyDate || 'اليوم')}</small></div>
      <div class="pf-kpis">
        ${kpi('إجمالي الرسائل', mp.total, 'كل رسائله الموجودة في الروم', true)}
        ${kpi('رسائل اليوم', mp.today)}
        ${kpi('آخر 7 أيام', mp.week)}
        ${kpi('آخر 30 يوم', mp.month)}
        ${kpi('متوسط الرسائل يوميًا', mp.avgPerDay, `${num(mp.activeDays)} يوم نشاط`)}
        ${kpi('أنشط وقت', hourLabel(mp.busiestHour), mp.busiestDay ? `أنشط يوم: ${dateOnly(`${mp.busiestDay.date}T12:00:00Z`)} (${num(mp.busiestDay.count)})` : 'لا يوجد نشاط')}
      </div>
      <div class="pf-charts">
        <div class="pf-chart-card"><h3>نشاط آخر 14 يوم</h3><div class="pf-bars">${activityBars}</div></div>
        <div class="pf-chart-card"><h3>توزيع الرسائل على ساعات اليوم <small>(توقيت القاهرة)</small></h3><div class="pf-hours">${hourBars}</div></div>
      </div>
      <div class="pf-facts slim"><div><small>أول رسالة</small><b>${dateTime(mp.firstAt)}</b></div><div><small>آخر رسالة</small><b>${dateTime(mp.lastAt)}</b></div></div>
    </section>

    <section class="staff-profile-section"><div class="section-title-row"><div><span class="tiny-label">PERFORMANCE</span><h2>الأداء والمهمات</h2></div></div>
      <div class="pf-kpis">
        ${kpi('النقاط المسجلة', stats.totalPoints, '', true)}
        ${restricted ? '' : kpi('إجمالي التسليمات', totalSub)}
        ${kpi('التسليمات المقبولة', approvedSub)}
        ${restricted ? '' : kpi('بانتظار المراجعة', stats.pendingSubmissions)}
        ${restricted ? '' : kpi('المرفوضة', stats.rejectedSubmissions)}
        ${restricted ? '' : kpi('طلبات الإجازة', stats.leaveRequests, `${num(stats.adminRequests)} طلب إداري`)}
      </div>
      <div class="pf-rate${restricted ? ' hidden' : ''}"><div class="pf-rate-top"><b>نسبة قبول التسليمات</b><span>${totalSub ? `${approvalRate}%` : '—'}</span></div><div class="pf-rate-track"><i style="width:${approvalRate}%"></i></div></div>
    </section>

    <section class="staff-profile-section"><div class="section-title-row"><div><span class="tiny-label">PERMISSIONS</span><h2>الرتب والصلاحيات</h2></div></div><div class="staff-profile-roles">${roles}</div></section>
    ${restricted ? '<section class="staff-profile-section"><p class="muted small-copy">🔒 السجل التفصيلي (حركات النقاط، التسليمات، الإجازات، الطلبات الإدارية) متاح لصاحب الحساب والمسؤولين فقط.</p></section>' : `<section class="staff-profile-section"><div class="section-title-row"><div><span class="tiny-label">POINTS HISTORY</span><h2>آخر حركات النقاط</h2></div></div><div class="profile-history-list">${pointsHtml}</div></section>
    <section class="staff-profile-section"><div class="section-title-row"><div><span class="tiny-label">SUBMISSION HISTORY</span><h2>آخر التسليمات</h2></div></div><div class="profile-history-list">${submissionsHtml}</div></section>
    <section class="staff-profile-section"><div class="section-title-row"><div><span class="tiny-label">LEAVE HISTORY</span><h2>طلبات الإجازة</h2></div></div><div class="profile-history-list">${leavesHtml}</div></section>
    <section class="staff-profile-section"><div class="section-title-row"><div><span class="tiny-label">ADMIN REQUESTS</span><h2>الطلبات الإدارية</h2></div></div><div class="profile-history-list">${requestsHtml}</div></section>`}`;
  $('[data-copy-id]', root)?.addEventListener('click', async (event) => {
    const id = event.currentTarget.dataset.copyId;
    try { await navigator.clipboard.writeText(id); showToast(`تم نسخ Discord ID: ${id}`, 'success'); } catch { showToast(id, 'info'); }
  });
}

function wireStaffRequests() {
  $('#staff-request-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const requestType = $('#staff-request-type').value;
    const subject = $('#staff-request-subject').value.trim();
    const details = $('#staff-request-details').value.trim();
    if (!subject || !details) return showToast('اكتب عنوان الطلب وتفاصيله.', 'error');
    const button = $('button[type="submit"]', event.currentTarget);
    setButtonLoading(button, true, 'جاري إرسال الطلب...');
    try {
      const result = await api('/api/staff-requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType, subject, details }),
      });
      showToast(result.message || 'تم إرسال الطلب للمراجعة.', result.discordPosted === false ? 'error' : 'success');
      event.currentTarget.reset();
      await loadStaffRequests();
    } catch (error) { showToast(error.message, 'error'); }
    finally { setButtonLoading(button, false); }
  });
  $('#refresh-staff-requests-btn')?.addEventListener('click', loadStaffRequests);
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-staff-request-review]');
    if (!button) return;
    const action = button.dataset.staffRequestReview;
    const note = action === 'reject' ? (window.prompt('سبب رفض الطلب (اختياري):') || '') : '';
    button.disabled = true;
    try {
      const result = await api(`/api/staff-requests/${button.dataset.id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }),
      });
      showToast(result.message || 'تم تحديث حالة الطلب.', 'success');
      await loadStaffRequests();
    } catch (error) { showToast(error.message, 'error'); button.disabled = false; }
  });
}

async function loadStaffRequests() {
  try {
    const result = await api('/api/staff-requests');
    const requests = result.requests || [];
    const statusText = { pending: 'بانتظار المراجعة', approved: 'تمت الموافقة', rejected: 'مرفوض' };
    const typeText = { permission: 'طلب إذن / غياب', technical: 'مشكلة تقنية', 'data-change': 'تعديل بيانات', complaint: 'شكوى أو ملاحظة', other: 'طلب إداري آخر' };
    const render = (item, manager = false) => `<article class="leave-card staff-request-card"><div class="leave-card-top"><b>${escapeHtml(item.username)}</b><span class="task-tag ${item.status === 'approved' ? 'completed' : item.status === 'rejected' ? 'required' : 'optional'}">${statusText[item.status] || escapeHtml(item.status)}</span></div><div class="leave-dates">${escapeHtml(typeText[item.requestType] || item.requestType)} · ${escapeHtml(item.subject)}</div><p>${escapeHtml(item.details)}</p><small class="muted">Discord ID: <code>${escapeHtml(item.userId)}</code> · ${formatDate(item.createdAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>${item.reviewNote ? `<p class="muted">ملاحظة الإدارة: ${escapeHtml(item.reviewNote)}</p>` : ''}${manager && item.status === 'pending' ? `<div class="manager-actions"><button class="primary-button" data-staff-request-review="approve" data-id="${item.id}">موافقة</button><button class="secondary-button" data-staff-request-review="reject" data-id="${item.id}">رفض</button></div>` : ''}</article>`;
    const own = requests.filter((item) => item.userId === state.user.id);
    const ownNode = $('#staff-request-list');
    if (ownNode) ownNode.innerHTML = own.length ? own.map((item) => render(item)).join('') : '<div class="task-empty">لسه مفيش طلبات إدارية أرسلتها.</div>';
    const managerNode = $('#manager-staff-request-list');
    if (managerNode && state.user.canManage) managerNode.innerHTML = requests.length ? requests.map((item) => render(item, true)).join('') : '<div class="task-empty">مفيش طلبات إدارية للمراجعة حاليًا.</div>';
  } catch (error) {
    const ownNode = $('#staff-request-list');
    if (ownNode) ownNode.innerHTML = `<div class="task-empty">${escapeHtml(error.message)}</div>`;
    const managerNode = $('#manager-staff-request-list');
    if (managerNode && state.user.canManage) managerNode.innerHTML = `<div class="task-empty">${escapeHtml(error.message)}</div>`;
  }
}

function updateDailyMessageStats(data = {}) {
  state.dailyMessageStats = {
    dailyStats: Array.isArray(data.dailyStats) ? data.dailyStats : state.dailyMessageStats.dailyStats,
    dailyTotal: Number.isFinite(Number(data.dailyTotal)) ? Number(data.dailyTotal) : state.dailyMessageStats.dailyTotal,
    dailyDate: data.dailyDate || state.dailyMessageStats.dailyDate,
  };
  renderDailyMessageStats();
}
function renderDailyMessageStats() {
  const data = state.dailyMessageStats || { dailyStats: [], dailyTotal: 0, dailyDate: null };
  const counts = new Map((data.dailyStats || []).map((row) => [String(row.userId), { ...row, count: Number(row.count) || 0 }]));
  const membersById = new Map();
  for (const group of (state.roster.groups || [])) {
    for (const member of (group.members || [])) {
      if (!membersById.has(String(member.id))) membersById.set(String(member.id), { ...member, count: counts.get(String(member.id))?.count || 0 });
    }
  }
  for (const [id, row] of counts) {
    const existing = membersById.get(id);
    if (existing) {
      existing.count = row.count;
      if (row.username) existing.username = row.username;
    } else {
      membersById.set(id, { id, username: row.username || id, handle: id, avatarUrl: avatarFallback(id), count: row.count });
    }
  }
  const members = [...membersById.values()].sort((a, b) => b.count - a.count || String(a.username).localeCompare(String(b.username), 'ar'));
  const totalNode = $('#daily-message-total');
  const dateNode = $('#daily-message-date');
  const listNode = $('#daily-message-stats');
  if (!totalNode || !dateNode || !listNode) return;
  rollSet(totalNode, Number(data.dailyTotal) || 0);
  dateNode.textContent = data.dailyDate ? data.dailyDate.split('-').reverse().join('/') : '—';
  if (!members.length) {
    listNode.innerHTML = '<div class="task-empty">لم يتم تحميل أعضاء الاستاف بعد، أو لا توجد رسائل اليوم.</div>';
    return;
  }
  const beforeFlip = flipCapture(listNode, 'data-open-staff-profile');
  listNode.innerHTML = members.map((member, index) => `
    <button type="button" class="daily-message-row daily-message-row-clickable" data-open-staff-profile="${escapeHtml(member.id)}">
      <span class="daily-message-rank">${index + 1}</span>
      <img class="daily-message-avatar" src="${escapeHtml(member.avatarUrl || avatarFallback(member.id))}" alt="">
      <div class="daily-message-member"><b>${escapeHtml(member.username || member.handle || member.id)}</b><small>${escapeHtml(member.handle ? `@${member.handle}` : `ID: ${member.id}`)}</small></div>
      <span class="daily-message-count">${rollMarkup(`daily:${member.id}`, Number(member.count || 0))} <small>رسالة</small></span>
    </button>
  `).join('');
  $$('.daily-message-row-clickable').forEach((button) => button.addEventListener('click', () => openStaffProfile(button.dataset.openStaffProfile)));
  rollPlay(listNode);
  flipPlay(listNode, 'data-open-staff-profile', beforeFlip);
}

function startChatPolling() {
  // Vercel serves the UI statically while the API runs on a persistent backend.
  // Poll only the currently visible chat so the interface works without a WebSocket proxy.
  setInterval(async () => {
    if (document.hidden) return;
    const activePage = $('.page.active-page')?.id;
    const room = activePage === 'page-staff-chat' ? 'staff'
      : activePage === 'page-management-chat' && state.user?.canManage ? 'management'
      : null;
    if (!room || !state.chatLoaded[room]) return;
    try {
      // نطلب الرسائل الأحدث من آخر رسالة معروفة فقط (بدل آخر 100 رسالة كل مرة).
      const lastId = state.chatMessages[room].reduce((max, message) => Math.max(max, Number(message.id) || 0), 0);
      const deletionCursor = Number(state.chatDeletionCursor[room]) || 0;
      const result = await api(`/api/chat/${room}?after=${lastId}&deletionsAfter=${deletionCursor}`);
      if (room === 'staff' && !result.incremental) updateDailyMessageStats(result);
      let changed = false;
      if (Number(result.deletionCursor) > deletionCursor) state.chatDeletionCursor[room] = Number(result.deletionCursor);
      for (const deletedId of (result.deletedMessageIds || [])) {
        const id = Number(deletedId);
        if (state.chatMessageIds[room].has(id)) {
          state.chatMessageIds[room].delete(id);
          state.chatMessages[room] = state.chatMessages[room].filter((message) => Number(message.id) !== id);
          changed = true;
        }
      }
      for (const message of (result.messages || [])) {
        if (!state.chatMessageIds[room].has(message.id)) {
          addChatMessage(room, message, false);
          changed = true;
        }
      }
      if (changed) renderChat(room);
    } catch { /* Keep the current chat visible during brief network errors. */ }
  }, 6000);
}
function wireChats() {
  $('#staff-chat-form').addEventListener('submit', (event) => sendChat(event, 'staff'));
  $('#management-chat-form').addEventListener('submit', (event) => sendChat(event, 'management'));
  $('#staff-chat-feed').addEventListener('click', (event) => handleChatDeleteClick(event, 'staff'));
  $('#management-chat-feed').addEventListener('click', (event) => handleChatDeleteClick(event, 'management'));
  for (const [room, inputId] of [['staff', '#staff-chat-input'], ['management', '#management-chat-input']]) {
    $(inputId).addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $(inputId).form.requestSubmit(); }
    });
  }
}
async function loadChat(room) {
  if (room === 'management' && !state.user?.canManage) return;
  try {
    const result = await api(`/api/chat/${room}`);
    if (room === 'staff') updateDailyMessageStats(result);
    state.chatMessages[room] = [];
    state.chatMessageIds[room] = new Set();
    state.chatDeletionCursor[room] = Number(result.deletionCursor) || 0;
    (result.messages || []).forEach((message) => addChatMessage(room, message, false));
    state.chatLoaded[room] = true;
    renderChat(room);
  } catch (error) {
    const feed = room === 'staff' ? $('#staff-chat-feed') : $('#management-chat-feed');
    feed.innerHTML = `<div class="chat-system-empty">${escapeHtml(error.message)}</div>`;
  }
}
async function handleChatDeleteClick(event, room) {
  const button = event.target.closest('[data-delete-chat-message]');
  if (!button) return;
  const messageId = String(button.dataset.deleteChatMessage || '');
  if (!/^\d{1,18}$/.test(messageId)) return;
  const message = state.chatMessages[room].find((item) => String(item.id) === messageId);
  if (!message) return;
  if (!(state.user?.canManage || message.userId === state.user?.id)) return showToast('ما عندكش صلاحية حذف الرسالة دي.', 'error');
  if (!window.confirm('هل تريد حذف الرسالة من شات ' + (room === 'staff' ? 'الاستاف' : 'المسؤولين') + '؟')) return;
  button.disabled = true;
  try {
    await api(`/api/chat/${room}/${messageId}`, { method: 'DELETE' });
    state.chatMessageIds[room].delete(message.id);
    state.chatMessages[room] = state.chatMessages[room].filter((item) => String(item.id) !== messageId);
    renderChat(room);
    showToast('تم حذف الرسالة.', 'success');
  } catch (error) {
    showToast(error.message || 'تعذر حذف الرسالة.', 'error');
    button.disabled = false;
  }
}
function addChatMessage(room, message, render = true) {
  if (state.chatMessageIds[room].has(message.id)) return;
  state.chatMessageIds[room].add(message.id);
  state.chatMessages[room].push(message);
  state.chatMessages[room].sort((a, b) => a.id - b.id);
  if (state.chatMessages[room].length > 130) {
    const removed = state.chatMessages[room].splice(0, state.chatMessages[room].length - 130);
    removed.forEach((row) => state.chatMessageIds[room].delete(row.id));
  }
  if (render) renderChat(room);
}
function renderChat(room) {
  const feed = room === 'staff' ? $('#staff-chat-feed') : $('#management-chat-feed');
  const messages = state.chatMessages[room];
  if (!messages.length) {
    feed.innerHTML = '<div class="chat-system-empty">لسه مفيش رسائل هنا.<br>ابدأ المحادثة برسالة بسيطة للفريق.</div>';
    return;
  }
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  feed.innerHTML = messages.map((message) => `
    <article class="chat-message ${message.userId === state.user.id ? 'own-message' : ''}">
      <img class="chat-message-avatar" src="${escapeHtml(message.avatarUrl || avatarFallback(message.userId))}" alt="">
      <div class="chat-message-content"><div class="chat-message-meta"><b>${escapeHtml(message.username)}</b><time>${formatTime(message.createdAt)}</time>${(state.user?.canManage || message.userId === state.user?.id) ? `<button type="button" class="chat-delete-button" data-delete-chat-message="${escapeHtml(message.id)}" title="حذف الرسالة" aria-label="حذف الرسالة">×</button>` : ''}</div><div class="chat-message-bubble">${escapeHtml(message.content)}</div></div>
    </article>
  `).join('');
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}
function containsChatLink(value) {
  const text = String(value ?? '').normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\[\s*(?:dot|\.)\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}/gi, '.')
    .replace(/\s+dot\s+/gi, '.');
  const patterns = [
    /(?:\b(?:https?|ftp|hxxps?)\s*:\s*\/\s*\/|\bwww\d?\s*\.)[^\s<>{}"'`]+/i,
    /\b(?:discord\.gg|discord(?:app)?\.com\/invite|t\.me|telegram\.me|bit\.ly|tinyurl\.com|youtu\.be|forms\.gle)(?:\/\S*)?/i,
    /(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{2,5})?(?:[/?#][^\s<>{}"'`]*)?/i,
    /(?<![\w@])(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?(?:\/[^\s]*)?/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

async function sendChat(event, room) {
  event.preventDefault();
  if (room === 'management' && !state.user?.canManage) return showToast('الغرفة دي مخصصة للمسؤولين.', 'error');
  const input = room === 'staff' ? $('#staff-chat-input') : $('#management-chat-input');
  const content = input.value.trim();
  if (!content) return;
  if (room === 'staff' && containsChatLink(content)) return showToast('ممنوع إرسال روابط في شات الاستاف.', 'error');
  const button = $('button[type="submit"]', event.currentTarget);
  button.disabled = true;
  try {
    const result = await api(`/api/chat/${room}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
    addChatMessage(room, result.message);
    if (room === 'staff') updateDailyMessageStats(result);
    input.value = '';
    input.style.height = 'auto';
  } catch (error) { showToast(error.message, 'error'); }
  finally { button.disabled = false; input.focus(); }
}

// Auto-grow message boxes without pulling in a UI framework.
$$('.chat-composer textarea').forEach((textarea) => textarea.addEventListener('input', () => {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 130)}px`;
}));

// ───────── إشعارات داخل الموقع للمسؤولين ─────────
const NOTIF_TARGETS = {
  submission: { page: 'tasks', selector: '#submissions-list', reload: () => loadSubmissions() },
  leave: { page: 'overview', selector: '#manager-leave-section', reload: () => loadLeaveRequests() },
  'staff-request': { page: 'overview', selector: '#manager-staff-request-section', reload: () => loadStaffRequests() },
};
const BASE_TITLE = document.title;
// ───────── تقييم الإداريين ─────────
const RATING_META = {
  1: { label: 'سيئ', emoji: '😡', color: '#ef4444' },
  2: { label: 'ضعيف', emoji: '🙁', color: '#f97316' },
  3: { label: 'مقبول', emoji: '😐', color: '#eab308' },
  4: { label: 'جيد', emoji: '🙂', color: '#22c55e' },
  5: { label: 'ممتاز', emoji: '🤩', color: '#06b6d4' },
};
function ratingAggregates() {
  const map = new Map();
  for (const item of state.ratings.items) { // الأحدث الأول
    let agg = map.get(item.targetId);
    if (!agg) { agg = { count: 0, sum: 0, dist: [0, 0, 0, 0, 0], items: [], latest: null }; map.set(item.targetId, agg); }
    agg.count += 1;
    agg.sum += item.rating;
    agg.dist[item.rating - 1] += 1;
    agg.items.push(item);
    if (!agg.latest) agg.latest = item;
  }
  for (const agg of map.values()) {
    agg.avg = agg.sum / agg.count;
    agg.delta = agg.count > 1 ? agg.avg - ((agg.sum - agg.latest.rating) / (agg.count - 1)) : 0;
    agg.level = Math.min(5, Math.max(1, Math.round(agg.avg)));
  }
  return map;
}
function ratingMembers() {
  const seen = new Set();
  return flattenRoster().filter((member) => (seen.has(String(member.id)) ? false : seen.add(String(member.id))));
}
function findRatingMember(id) { return ratingMembers().find((member) => String(member.id) === String(id)) || null; }
function ratingStatsOf(id) { return (state.staffStats || []).find((row) => String(row.userId) === String(id)) || {}; }
async function loadRatings(silent = false) {
  if (!state.user?.canManage) return;
  try {
    const result = await api('/api/staff-ratings');
    state.ratings.items = Array.isArray(result.ratings) ? result.ratings : [];
    state.ratings.loaded = true;
    renderRatings();
    if (!$('#rating-modal')?.classList.contains('hidden')) renderRatingModalBody();
  } catch (error) {
    if (!silent) { const grid = $('#rt-grid'); if (grid) grid.innerHTML = `<div class="task-empty">${escapeHtml(error.message)}</div>`; }
  }
}
// ───────── رسوم بيانية (SVG بدون مكتبات) ─────────
function svgLine({ pts, avg = null, w = 640, h = 230, area = false }) {
  const L = 50, R = 16, T = 16, B = 30;
  const iw = w - L - R;
  const ih = h - T - B;
  const n = pts.length;
  const xAt = (i) => L + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
  const yAt = (v) => T + ((5 - Math.min(5, Math.max(1, v))) / 4) * ih;
  let grid = '';
  for (let v = 1; v <= 5; v += 1) grid += `<line x1="${L}" x2="${w - R}" y1="${yAt(v).toFixed(1)}" y2="${yAt(v).toFixed(1)}" class="rt-grid-line"/><text x="${L - 8}" y="${(yAt(v) + 3).toFixed(1)}" text-anchor="end" class="rt-axis">${RATING_META[v].label}</text>`;
  const valid = pts.map((p, i) => ({ ...p, i })).filter((p) => p.v != null);
  const toPath = (list) => list.map((p, k) => `${k ? 'L' : 'M'}${xAt(p.i).toFixed(1)} ${yAt(p.v).toFixed(1)}`).join(' ');
  const path = valid.length > 1 ? `<path d="${toPath(valid)}" pathLength="1" class="rt-line"/>` : '';
  const areaPath = area && valid.length > 1 ? `<path d="${toPath(valid)} L${xAt(valid[valid.length - 1].i).toFixed(1)} ${(T + ih).toFixed(1)} L${xAt(valid[0].i).toFixed(1)} ${(T + ih).toFixed(1)} Z" class="rt-area"/>` : '';
  const avgValid = avg ? avg.map((v, i) => ({ v, i })).filter((p) => p.v != null) : [];
  const avgPath = avgValid.length > 1 ? `<path d="${toPath(avgValid)}" class="rt-line-avg"/>` : '';
  const dots = valid.map((p, k) => `<circle cx="${xAt(p.i).toFixed(1)}" cy="${yAt(p.v).toFixed(1)}" r="5" fill="${p.color || '#ff655f'}" class="rt-dot" style="--k:${k}"><title>${escapeHtml(p.tip || '')}</title></circle>`).join('');
  const idx = [...new Set(n <= 4 ? pts.map((_, i) => i) : [0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1])];
  const xl = idx.map((i) => `<text x="${xAt(i).toFixed(1)}" y="${h - 8}" text-anchor="middle" class="rt-axis sm">${escapeHtml(pts[i].x || '')}</text>`).join('');
  return `<svg class="rt-svg" viewBox="0 0 ${w} ${h}" role="img">${grid}${areaPath}${avgPath}${path}${dots}${xl}</svg>`;
}
function svgBars({ values, labels, colors = [], w = 640, h = 180, labelEvery = 1, color = 'var(--neon-a)' }) {
  const L = 8, R = 8, T = 20, B = 24;
  const iw = w - L - R;
  const ih = h - T - B;
  const n = values.length;
  const max = Math.max(1, ...values);
  const slot = iw / n;
  const barW = Math.min(36, slot * 0.64);
  const bars = values.map((v, i) => {
    const bh = v > 0 ? Math.max(4, (v / max) * ih) : 2;
    const x = L + slot * i + (slot - barW) / 2;
    const y = T + ih - bh;
    const fill = colors[i] || color;
    const val = v > 0 ? `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" class="rt-bar-val">${escapeHtml(rollFormat(v, rollDigits(v)))}</text>` : '';
    const lab = i % labelEvery === 0 ? `<text x="${(x + barW / 2).toFixed(1)}" y="${h - 7}" text-anchor="middle" class="rt-axis sm">${escapeHtml(labels[i] ?? '')}</text>` : '';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="5" fill="${fill}" opacity="${v > 0 ? 0.95 : 0.25}" class="rt-bar" style="--k:${i}"><title>${escapeHtml(`${labels[i] ?? ''}: ${rollFormat(v, rollDigits(v))}`)}</title></rect>${val}${lab}`;
  }).join('');
  return `<svg class="rt-svg" viewBox="0 0 ${w} ${h}" role="img"><line x1="${L}" x2="${w - R}" y1="${T + ih}" y2="${T + ih}" class="rt-grid-line"/>${bars}</svg>`;
}
function hBars(rows) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return `<div class="rt-hb">${rows.map((row, k) => `<div class="rt-hb-row"><span class="rt-hb-label" title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span><i><span style="--c:${row.color || 'var(--neon-a)'};--k:${k};width:${Math.max(row.value > 0 ? 3 : 0, Math.round((row.value / max) * 100))}%"></span></i><b>${escapeHtml(row.text ?? rollFormat(row.value, rollDigits(row.value)))}</b></div>`).join('')}</div>`;
}
const cairoDayKey = (date) => new Date(date).toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
const shortDate = (date) => formatDate(date, { day: 'numeric', month: 'short' });

// تطور تقييم إداري واحد (نقاط التقييمات + خط المتوسط التراكمي)
function renderRatingTrend() {
  const box = $('#rt-trend-chart');
  if (!box) return;
  const agg = ratingAggregates().get(String(state.ratings.targetId));
  if (!agg) { box.innerHTML = '<div class="task-empty">مفيش تقييمات لسه عشان نرسم التطور. أول تقييم هيظهر هنا.</div>'; return; }
  const full = [...agg.items].reverse(); // من الأقدم للأحدث
  let sum = 0;
  const running = full.map((item, i) => { sum += item.rating; return sum / (i + 1); });
  const from = Math.max(0, full.length - 30);
  const slice = full.slice(from);
  const pts = slice.map((item) => ({ x: shortDate(item.createdAt), v: item.rating, color: RATING_META[item.rating].color, tip: `${RATING_META[item.rating].label} (${item.rating}/5) — ${item.raterName || 'مسؤول'} — ${shortDate(item.createdAt)}${item.note ? ` — ${item.note}` : ''}` }));
  const half = Math.max(1, Math.floor(full.length / 2));
  const early = full.slice(0, half).reduce((a, b) => a + b.rating, 0) / half;
  const late = full.slice(-half).reduce((a, b) => a + b.rating, 0) / half;
  const diff = full.length > 1 ? late - early : 0;
  const ratings = full.map((item) => item.rating);
  const chip = (label, value, cls = '') => `<div class="rt-chip"><small>${label}</small><b class="${cls}">${value}</b></div>`;
  box.innerHTML = `<section class="rt-chart-card" style="animation:none"><h3>تطور التقييم <small>آخر ${slice.length} ${slice.length === 1 ? 'تقييم' : 'تقييمات'}</small></h3>${svgLine({ pts, avg: running.slice(from), area: true })}<div class="rt-legend"><span><i></i>كل تقييم</span><span><i class="avg"></i>المتوسط التراكمي</span></div>${full.length < 2 ? '<p class="muted small-copy">محتاج تقييمين على الأقل عشان يظهر خط التطور.</p>' : ''}<div class="rt-chips">${chip('المتوسط الحالي', `${agg.avg.toFixed(2)} / 5`)}${chip('آخر تقييم', `${RATING_META[full[full.length - 1].rating].emoji} ${RATING_META[full[full.length - 1].rating].label}`)}${chip('أعلى تقييم', RATING_META[Math.max(...ratings)].label)}${chip('أقل تقييم', RATING_META[Math.min(...ratings)].label)}${chip('الاتجاه العام', full.length < 2 ? '—' : Math.abs(diff) < 0.05 ? 'ثابت' : `${diff > 0 ? '▲ تحسّن' : '▼ تراجع'} ${Math.abs(diff).toFixed(2)}`, full.length < 2 || Math.abs(diff) < 0.05 ? '' : diff > 0 ? 'up' : 'down')}</div></section>`;
}

// الإحصائيات المفصلة (من /api/staff-stats/:id)
async function loadRatingDetail(id) {
  const holder = $('#rt-detail');
  if (state.ratings.detail?.[id]) renderRatingDetail(); else if (holder) holder.innerHTML = '<div class="loading-state">جاري تحميل الإحصائيات...</div>';
  try {
    const response = await api(`/api/staff-stats/${encodeURIComponent(id)}`);
    state.ratings.detail = { ...(state.ratings.detail || {}), [id]: response };
    if (String(state.ratings.targetId) === String(id)) renderRatingDetail();
  } catch (error) {
    if (holder && !state.ratings.detail?.[id]) holder.innerHTML = `<div class="task-empty">${escapeHtml(error.message)}</div>`;
  }
}
function renderRatingDetail() {
  const id = String(state.ratings.targetId);
  const holder = $('#rt-detail');
  const response = state.ratings.detail?.[id];
  if (!holder || !response) return;
  const st = response.stats || {};
  const mp = response.messageProfile || { activity: [], hours: [] };
  const ranks = response.ranks || {};
  const k = (key, v, d) => rollMarkup(`rtd:${id}:${key}`, v, d);
  const kpi = (label, value, note = '') => `<div class="rt-dkpi"><small>${label}</small><strong>${value}</strong>${note ? `<em>${note}</em>` : ''}</div>`;
  const total = Number(st.totalSubmissions) || 0;
  const approved = Number(st.approvedSubmissions) || 0;
  const rejected = Number(st.rejectedSubmissions) || 0;
  const pending = Number(st.pendingSubmissions) || 0;
  const pct = (n) => (total ? (n / total) * 100 : 0);
  const rate = total ? Math.round((approved / total) * 100) : 0;
  const rank = (info) => (info?.rank ? `#${info.rank}` : '—');
  const rankNote = (info) => (info?.rank ? `من ${info.of}` : 'لسه مفيش ترتيب');
  const online = state.onlineUserIds.has(id);
  const busyDay = mp.busiestDay ? `${rollFormat(mp.busiestDay.count)} رسالة · ${shortDate(`${mp.busiestDay.date}T12:00:00Z`)}` : '—';
  const dayLabels = (mp.activity || []).map((item) => formatDate(`${item.date}T12:00:00Z`, { day: 'numeric', month: 'numeric', timeZone: 'UTC' }));
  const hourColors = (mp.hours || []).map((item) => (item.hour === mp.busiestHour ? 'var(--orange)' : 'var(--neon-a)'));
  const sig = JSON.stringify([st, mp.activity, mp.hours, ranks]);
  const html = `
    <div class="rt-dgroup"><h4>💬 النشاط في الرسائل</h4><div class="rt-dkpis">
      ${kpi('رسائل اليوم', k('today', mp.today || 0))}${kpi('آخر 7 أيام', k('week', mp.week || 0))}${kpi('آخر 30 يوم', k('month', mp.month || 0))}${kpi('إجمالي الرسائل', k('total', mp.total || 0))}${kpi('متوسط يومي', k('avg', mp.avgPerDay || 0, 1))}${kpi('أيام النشاط', k('days', mp.activeDays || 0))}${kpi('أنشط ساعة', mp.busiestHour == null ? '—' : escapeHtml(hourLabel(mp.busiestHour)))}${kpi('أنشط يوم', `<span style="font-size:12px">${escapeHtml(busyDay)}</span>`)}
    </div></div>
    <div class="rt-chart-card" style="animation:none;margin-bottom:12px"><h3>الرسائل في آخر 14 يوم <small>بتوقيت القاهرة</small></h3>${svgBars({ values: (mp.activity || []).map((i) => i.count), labels: dayLabels, labelEvery: 2 })}</div>
    <div class="rt-chart-card" style="animation:none;margin-bottom:16px"><h3>توزيع النشاط على ساعات اليوم <small>الساعة الأنشط بالبرتقالي</small></h3>${svgBars({ values: (mp.hours || []).map((i) => i.count), labels: (mp.hours || []).map((i) => String(i.hour)), colors: hourColors, labelEvery: 3, h: 160 })}</div>
    <div class="rt-dgroup"><h4>✅ التسليمات والنقاط</h4><div class="rt-dkpis">
      ${kpi('إجمالي التسليمات', k('sub', total))}${kpi('مقبولة', k('ok', approved))}${kpi('مرفوضة', k('rej', rejected))}${kpi('معلقة', k('pen', pending))}${kpi('نسبة القبول', `${k('rate', rate)}%`)}${kpi('النقاط', k('pts', Number(st.totalPoints) || 0))}${kpi('ترتيب الرسائل', rank(ranks.messages), rankNote(ranks.messages))}${kpi('ترتيب النقاط', rank(ranks.points), rankNote(ranks.points))}
    </div>
    ${total ? `<div class="rt-stack" style="margin-top:11px"><span style="width:${pct(approved)}%;background:var(--green)"></span><span style="width:${pct(pending)}%;background:var(--orange)"></span><span style="width:${pct(rejected)}%;background:var(--red)"></span></div><div class="rt-stack-legend"><span><i style="background:var(--green)"></i>مقبولة ${approved}</span><span><i style="background:var(--orange)"></i>معلقة ${pending}</span><span><i style="background:var(--red)"></i>مرفوضة ${rejected}</span></div>` : ''}
    </div>
    <div class="rt-dgroup"><h4>🗂️ الإدارة والحضور</h4><div class="rt-dkpis">
      ${kpi('طلبات الإجازة', k('leave', Number(st.leaveRequests) || 0))}${kpi('طلبات إدارية', k('req', Number(st.adminRequests) || 0))}${kpi('الحالة في الموقع', online ? '🟢 متصل' : '⚪ غير متصل')}${kpi('أول رسالة', mp.firstAt ? escapeHtml(shortDate(mp.firstAt)) : '—')}${kpi('آخر رسالة', mp.lastAt ? escapeHtml(shortDate(mp.lastAt)) : '—')}
    </div></div>`;
  if (holder.dataset.sig !== sig + id) { holder.dataset.sig = sig + id; holder.innerHTML = html; }
  rollPlay(holder);
}
function setRatingTab(name) {
  $$('#rt-tabs [data-rt-tab]').forEach((tab) => { const active = tab.dataset.rtTab === name; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', String(active)); });
  $$('#rating-modal [data-rt-pane]').forEach((pane) => pane.classList.toggle('hidden', pane.dataset.rtPane !== name));
  if (name === 'trend') renderRatingTrend();
  if (name === 'stats') { rollReset('rtd:'); const holder = $('#rt-detail'); if (holder) delete holder.dataset.sig; loadRatingDetail(String(state.ratings.targetId)); }
}

// لوحة رسوم عامة في صفحة التقييمات
function renderRatingCharts(scoped, aggs) {
  const box = $('#rt-charts');
  if (!box) return;
  const ids = new Set(scoped.map((member) => String(member.id)));
  const items = state.ratings.items.filter((item) => ids.has(item.targetId));
  const now = Date.now();
  const weeks = Array.from({ length: 8 }, (_, i) => ({ k: 7 - i, sum: 0, n: 0 }));
  for (const item of items) { const k = Math.floor((now - new Date(item.createdAt).getTime()) / (7 * 864e5)); const w = weeks.find((x) => x.k === k); if (w) { w.sum += item.rating; w.n += 1; } }
  const weekPts = weeks.map((w) => ({ x: shortDate(now - w.k * 7 * 864e5), v: w.n ? w.sum / w.n : null, color: w.n ? RATING_META[Math.round(w.sum / w.n)].color : '#888', tip: w.n ? `متوسط ${(w.sum / w.n).toFixed(2)} من ${w.n} تقييم` : 'مفيش تقييمات' }));
  const dist = [1, 2, 3, 4, 5].map((n) => items.filter((item) => item.rating === n).length);
  const distTotal = dist.reduce((a, b) => a + b, 0);
  const days = Array.from({ length: 14 }, (_, i) => cairoDayKey(now - (13 - i) * 864e5));
  const perDay = days.map((day) => items.filter((item) => cairoDayKey(item.createdAt) === day).length);
  const ranking = scoped.map((member) => ({ member, agg: aggs.get(String(member.id)) })).filter((row) => row.agg).sort((a, b) => b.agg.avg - a.agg.avg).slice(0, 10).map((row) => ({ label: row.member.username, value: row.agg.avg, color: RATING_META[row.agg.level].color, text: `${row.agg.avg.toFixed(2)} (${row.agg.count})` }));
  const activity = scoped.map((member) => ({ member, st: ratingStatsOf(member.id) })).filter((row) => Number(row.st.totalMessages) > 0).sort((a, b) => Number(b.st.totalMessages) - Number(a.st.totalMessages)).slice(0, 10).map((row) => ({ label: row.member.username, value: Number(row.st.totalMessages) || 0, text: `${rollFormat(row.st.totalMessages)} · اليوم ${rollFormat(row.st.dailyMessages || 0)}` }));
  const empty = '<div class="task-empty">مفيش بيانات كفاية لسه.</div>';
  const html = `
    <section class="rt-chart-card wide" style="--i:0"><h3>تطور المتوسط العام <small>متوسط أسبوعي — آخر 8 أسابيع</small></h3>${items.length ? svgLine({ pts: weekPts, area: true }) : empty}</section>
    <section class="rt-chart-card" style="--i:1"><h3>توزيع التقييمات <small>${rollFormat(distTotal)} تقييم</small></h3>${distTotal ? hBars([5, 4, 3, 2, 1].map((n) => ({ label: `${RATING_META[n].emoji} ${RATING_META[n].label}`, value: dist[n - 1], color: RATING_META[n].color, text: `${dist[n - 1]} · ${Math.round((dist[n - 1] / distTotal) * 100)}%` }))) : empty}</section>
    <section class="rt-chart-card" style="--i:2"><h3>التقييمات يوميًا <small>آخر 14 يوم</small></h3>${distTotal ? svgBars({ values: perDay, labels: days.map((day) => day.slice(8)), labelEvery: 2, h: 170 }) : empty}</section>
    <section class="rt-chart-card" style="--i:3"><h3>ترتيب الإداريين بالتقييم <small>أعلى 10</small></h3>${ranking.length ? hBars(ranking) : empty}</section>
    <section class="rt-chart-card" style="--i:4"><h3>الأكثر نشاطًا في الرسائل <small>إجمالي · أعلى 10</small></h3>${activity.length ? hBars(activity) : empty}</section>`;
  if (box.dataset.sig !== html) { box.dataset.sig = html; box.innerHTML = html; }
}

function renderRatings() {
  const grid = $('#rt-grid');
  const kpis = $('#rt-kpis');
  if (!grid || !kpis) return;
  if (!state.ratings.loaded && !state.ratings.items.length) { grid.innerHTML = '<div class="loading-state">جاري تحميل التقييمات...</div>'; kpis.innerHTML = ''; return; }
  const aggs = ratingAggregates();
  const scoped = ratingMembers().filter((member) => state.ratings.scope === 'all' || member.isAdmin);
  const rated = scoped.filter((member) => aggs.has(String(member.id)));
  const overall = rated.length ? rated.reduce((sum, member) => sum + aggs.get(String(member.id)).avg, 0) / rated.length : 0;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const lastWeek = state.ratings.items.filter((item) => new Date(item.createdAt).getTime() >= weekAgo).length;
  const kpi = (index, label, key, value, note, digits, accent) => `<article class="rt-kpi${accent ? ' accent' : ''}" style="--i:${index}"><small>${label}</small><strong>${rollMarkup(`rt:kpi:${key}`, value, digits)}</strong><em>${note}</em></article>`;
  kpis.innerHTML = [
    kpi(0, 'المتوسط العام', 'avg', overall, 'من 5 — متوسط متوسطات الإداريين', 2, true),
    kpi(1, 'تم تقييمهم', 'rated', rated.length, `من ${scoped.length} في القائمة`, 0),
    kpi(2, 'بدون تقييم', 'unrated', scoped.length - rated.length, 'لسه محتاجين تقييم', 0),
    kpi(3, 'تقييمات آخر 7 أيام', 'week', lastWeek, `إجمالي ${state.ratings.items.length.toLocaleString('en-US')} تقييم`, 0),
  ].join('');
  rollPlay(kpis);
  renderRatingCharts(scoped, aggs);

  const query = state.ratings.search.trim().toLowerCase();
  let list = scoped.filter((member) => !query || [member.username, member.handle, member.id, member.roleName].some((v) => String(v || '').toLowerCase().includes(query)));
  const avgOf = (m) => aggs.get(String(m.id))?.avg ?? -1;
  const lastOf = (m) => new Date(aggs.get(String(m.id))?.latest?.createdAt || 0).getTime();
  const byName = (a, b) => String(a.username).localeCompare(String(b.username), 'ar');
  const sorters = {
    'avg-desc': (a, b) => avgOf(b) - avgOf(a) || byName(a, b),
    'avg-asc': (a, b) => (avgOf(a) < 0 ? 1 : avgOf(b) < 0 ? -1 : avgOf(a) - avgOf(b)) || byName(a, b),
    recent: (a, b) => lastOf(b) - lastOf(a) || byName(a, b),
    unrated: (a, b) => (avgOf(a) < 0 ? 0 : 1) - (avgOf(b) < 0 ? 0 : 1) || byName(a, b),
    name: byName,
  };
  list = list.sort(sorters[state.ratings.sort] || sorters['avg-desc']);
  if (!list.length) { grid.innerHTML = '<div class="task-empty">مفيش أعضاء مطابقين. جرّب تغيّر الفلتر أو البحث.</div>'; return; }

  const mineId = String(state.user?.id || '');
  const beforeFlip = flipCapture(grid, 'data-rt-card');
  grid.innerHTML = list.map((member, index) => {
    const id = String(member.id);
    const agg = aggs.get(id);
    const stats = ratingStatsOf(id);
    const meta = agg ? RATING_META[agg.level] : null;
    const level = agg ? agg.level : 0;
    let trend = '<span class="rt-trend flat">أول تقييم</span>';
    if (!agg) trend = '<span class="rt-trend flat">غير مقيَّم</span>';
    else if (agg.count > 1) trend = Math.abs(agg.delta) < 0.005 ? '<span class="rt-trend flat">ثابت</span>' : `<span class="rt-trend ${agg.delta > 0 ? 'up' : 'down'}"><b>${agg.delta > 0 ? '▲' : '▼'}</b>${Math.abs(agg.delta).toFixed(2)}</span>`;
    const dist = agg ? [5, 4, 3, 2, 1].map((n) => `<div class="rt-dist-row"><span>${RATING_META[n].label}</span><i><span style="--c:${RATING_META[n].color};width:${Math.round((agg.dist[n - 1] / agg.count) * 100)}%"></span></i><b>${agg.dist[n - 1]}</b></div>`).join('') : '';
    const noted = agg?.items.find((item) => item.note && item.note.trim());
    const noteHtml = noted ? `<p class="rt-lastnote">“${escapeHtml(noted.note)}”<small>— ${escapeHtml(noted.raterName || 'مسؤول')} · ${escapeHtml(formatDate(noted.createdAt, { day: 'numeric', month: 'short' }))}</small></p>` : '<p class="rt-lastnote">مفيش ملاحظات لسه.</p>';
    const isMe = id === mineId;
    return `<article class="rt-card lvl-${level}" data-rt-card="${escapeHtml(id)}" style="--i:${Math.min(index, 12)}">
      <div class="rt-card-top"><img src="${escapeHtml(member.avatarUrl || avatarFallback(id))}" alt=""><div class="rt-who"><b>${escapeHtml(member.username)}${isMe ? ' <i>(أنت)</i>' : ''}</b><small>${escapeHtml(member.roleName || 'عضو الاستاف')}</small></div><span class="rt-badge">${meta ? `${meta.emoji} ${meta.label}` : '— بدون تقييم'}</span></div>
      <div class="rt-score"><div class="rt-score-num"><strong>${agg ? rollMarkup(`rt:${id}:avg`, agg.avg, 2) : '—'}</strong><span>/ 5</span></div><span class="rt-stars" aria-hidden="true"><i style="width:${agg ? Math.round((agg.avg / 5) * 100) : 0}%">★★★★★</i>★★★★★</span>${trend}</div>
      ${agg ? `<div class="rt-dist">${dist}</div>` : ''}
      <div class="rt-metrics"><span><b>${rollMarkup(`rt:${id}:d`, Number(stats.dailyMessages || 0))}</b><small>رسائل اليوم</small></span><span><b>${rollMarkup(`rt:${id}:t`, Number(stats.totalMessages || 0))}</b><small>إجمالي الرسائل</small></span><span><b>${rollMarkup(`rt:${id}:p`, Number(stats.totalPoints || 0))}</b><small>نقاط</small></span><span><b>${rollMarkup(`rt:${id}:a`, Number(stats.approvedSubmissions || 0))}</b><small>تسليمات مقبولة</small></span></div>
      ${noteHtml}
      <div class="rt-actions"><button type="button" class="primary-button" data-rt-rate="${escapeHtml(id)}"${isMe ? ' disabled title="مينفعش تقيّم نفسك"' : ''}>${isMe ? 'ده حسابك' : '✪ قيّم الآن'}</button><button type="button" class="secondary-button" data-rt-history="${escapeHtml(id)}">📈 التفاصيل (${agg ? agg.count : 0})</button></div>
    </article>`;
  }).join('');
  rollPlay(grid);
  flipPlay(grid, 'data-rt-card', beforeFlip);
}
function renderRatingModalBody() {
  const id = state.ratings.targetId;
  if (!id) return;
  const aggs = ratingAggregates();
  const agg = aggs.get(String(id));
  const stats = ratingStatsOf(id);
  const statsNode = $('#rt-modal-stats');
  if (statsNode) {
    statsNode.innerHTML = `<span><b>${agg ? rollMarkup(`rtm:${id}:avg`, agg.avg, 2) : '—'}</b><small>المتوسط / 5</small></span><span><b>${rollMarkup(`rtm:${id}:cnt`, agg ? agg.count : 0)}</b><small>عدد التقييمات</small></span><span><b>${rollMarkup(`rtm:${id}:d`, Number(stats.dailyMessages || 0))}</b><small>رسائل اليوم</small></span><span><b>${rollMarkup(`rtm:${id}:t`, Number(stats.totalMessages || 0))}</b><small>إجمالي الرسائل</small></span>`;
    rollPlay(statsNode);
  }
  const items = agg ? agg.items : [];
  $('#rt-history-count').textContent = String(items.length);
  const history = $('#rt-history');
  history.innerHTML = items.length ? items.slice(0, 40).map((item, index) => {
    const meta = RATING_META[item.rating];
    return `<article class="rt-hist-row${item.id === state.ratings.justAddedId ? ' new' : ''}" style="--i:${Math.min(index, 8)}"><span class="rt-emoji">${meta.emoji}</span><div><b style="color:${meta.color}">${meta.label} · ${item.rating}/5</b><small>بواسطة ${escapeHtml(item.raterName || 'مسؤول')} · ${escapeHtml(formatDate(item.createdAt, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</small>${item.note ? `<p>${escapeHtml(item.note)}</p>` : ''}</div><button type="button" class="rt-hist-del" data-rt-del="${item.id}" title="مسح التقييم ده" aria-label="مسح التقييم">🗑</button></article>`;
  }).join('') : '<div class="task-empty">مفيش تقييمات سابقة للعضو ده.</div>';
  $('#rt-clear-all')?.classList.toggle('hidden', !items.length);
  if (!$('[data-rt-pane="trend"]')?.classList.contains('hidden')) renderRatingTrend();
}
function updateRatingSubmitState() {
  const button = $('#rt-submit');
  if (!button || button.dataset.oldText) return;
  const isSelf = String(state.ratings.targetId) === String(state.user?.id);
  const selected = state.ratings.selected;
  $$('#rt-options .rt-opt').forEach((option) => {
    const active = Number(option.dataset.rtOpt) === selected;
    option.classList.toggle('active', active);
    option.setAttribute('aria-checked', String(active));
  });
  $('#rt-self-warning')?.classList.toggle('hidden', !isSelf);
  button.disabled = isSelf || !selected;
  button.textContent = isSelf ? 'مينفعش تقيّم نفسك' : selected ? `إرسال تقييم «${RATING_META[selected].label}» ✓` : 'اختار تقييم الأول';
}
function openRatingModal(id, { history = false } = {}) {
  const member = findRatingMember(id);
  if (!member) return showToast('العضو ده مش موجود في القائمة.', 'error');
  state.ratings.targetId = String(id);
  state.ratings.selected = 0;
  state.ratings.justAddedId = null;
  rollReset('rtm:');
  $('#rt-modal-avatar').src = member.avatarUrl || avatarFallback(id);
  $('#rt-modal-title').textContent = member.username;
  $('#rt-modal-role').textContent = member.roleName || 'عضو الاستاف';
  $('#rt-options').innerHTML = [1, 2, 3, 4, 5].map((n) => `<button type="button" class="rt-opt" role="radio" aria-checked="false" data-rt-opt="${n}"><span class="rt-emoji">${RATING_META[n].emoji}</span><b>${RATING_META[n].label}</b></button>`).join('');
  $('#rt-note').value = '';
  $('#rt-note-count').textContent = '0 / 600';
  renderRatingModalBody();
  updateRatingSubmitState();
  $('#rating-modal').classList.remove('hidden');
  document.body.classList.add('appearance-modal-open');
  const holder = $('#rt-detail'); if (holder) delete holder.dataset.sig;
  setRatingTab(history ? 'trend' : 'rate');
}
function closeRatingModal() {
  $('#rating-modal')?.classList.add('hidden');
  document.body.classList.remove('appearance-modal-open');
}
async function submitRating(event) {
  event.preventDefault();
  const id = state.ratings.targetId;
  const rating = state.ratings.selected;
  if (!id || !rating) return;
  const member = findRatingMember(id);
  const button = $('#rt-submit');
  setButtonLoading(button, true, 'جاري الإرسال...');
  try {
    const result = await api('/api/staff-ratings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId: id, targetName: member?.username || '', rating, note: $('#rt-note').value.trim() }),
    });
    state.ratings.items.unshift(result.rating);
    state.ratings.justAddedId = result.rating.id;
    state.ratings.selected = 0;
    $('#rt-note').value = '';
    $('#rt-note-count').textContent = '0 / 600';
    showToast(result.message || 'تم حفظ التقييم.', result.discordPosted ? 'success' : 'info');
    renderRatings();
    renderRatingModalBody();
  } catch (error) {
    showToast(error.message || 'تعذر حفظ التقييم.', 'error');
  } finally {
    setButtonLoading(button, false);
    updateRatingSubmitState();
  }
}
async function deleteRatings(url, confirmText, ids, row) {
  if (!window.confirm(confirmText)) return;
  try {
    if (row) { row.classList.add('removing'); await new Promise((resolve) => setTimeout(resolve, 300)); }
    await api(url, { method: 'DELETE' });
    const gone = new Set(ids);
    state.ratings.items = state.ratings.items.filter((item) => !gone.has(item.id));
    showToast('تم مسح التقييم.', 'success');
    renderRatings();
    renderRatingModalBody();
  } catch (error) {
    row?.classList.remove('removing');
    showToast(error.message || 'تعذر مسح التقييم.', 'error');
  }
}
function wireRatings() {
  const root = $('#page-staff-ratings');
  if (!root || root.dataset.wired === '1') return;
  root.dataset.wired = '1';
  $('#rt-refresh')?.addEventListener('click', () => loadRatings());
  $$('#rt-scope-tabs [data-rt-scope]').forEach((button) => button.addEventListener('click', () => {
    state.ratings.scope = button.dataset.rtScope;
    $$('#rt-scope-tabs [data-rt-scope]').forEach((item) => item.classList.toggle('active', item === button));
    renderRatings();
  }));
  $('#rt-search')?.addEventListener('input', (event) => { state.ratings.search = event.target.value; renderRatings(); });
  $('#rt-sort')?.addEventListener('change', (event) => { state.ratings.sort = event.target.value; renderRatings(); });
  $('#rt-grid')?.addEventListener('click', (event) => {
    const rate = event.target.closest('[data-rt-rate]');
    if (rate && !rate.disabled) return openRatingModal(rate.dataset.rtRate);
    const hist = event.target.closest('[data-rt-history]');
    if (hist) openRatingModal(hist.dataset.rtHistory, { history: true });
  });
  $$('[data-rating-close]').forEach((button) => button.addEventListener('click', closeRatingModal));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#rating-modal')?.classList.contains('hidden')) closeRatingModal(); });
  $('#rt-options')?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-rt-opt]');
    if (!option) return;
    state.ratings.selected = Number(option.dataset.rtOpt);
    updateRatingSubmitState();
  });
  $('#rt-note')?.addEventListener('input', (event) => { $('#rt-note-count').textContent = `${event.target.value.length} / 600`; });
  $('#rt-tabs')?.addEventListener('click', (event) => { const tab = event.target.closest('[data-rt-tab]'); if (tab) setRatingTab(tab.dataset.rtTab); });
  $('#rt-form')?.addEventListener('submit', submitRating);
  $('#rt-history')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-rt-del]');
    if (!button) return;
    const id = Number(button.dataset.rtDel);
    deleteRatings(`/api/staff-ratings/${id}`, 'متأكد إنك عايز تمسح التقييم ده؟', [id], button.closest('.rt-hist-row'));
  });
  $('#rt-clear-all')?.addEventListener('click', () => {
    const target = state.ratings.targetId;
    const ids = state.ratings.items.filter((item) => item.targetId === String(target)).map((item) => item.id);
    if (!ids.length) return;
    deleteRatings(`/api/staff-ratings/user/${encodeURIComponent(target)}`, `هتمسح كل التقييمات (${ids.length}) للعضو ده نهائيًا. متأكد؟`, ids, null);
  });
  // تحديث هادئ: لو مسؤول تاني قيّم، الأرقام هنا تتحرك لوحدها.
  setInterval(() => { if (!document.hidden && $('.page.active-page')?.id === 'page-staff-ratings') loadRatings(true); }, 45000);
}

function wireNotifications() {
  const button = $('#notif-btn');
  const panel = $('#notif-panel');
  if (!button || !panel) return;
  const close = () => { state.notif.open = false; panel.classList.add('hidden'); button.setAttribute('aria-expanded', 'false'); };
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (state.notif.open) return close();
    state.notif.open = true;
    panel.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    await loadNotifications();
    renderNotifications();
    markNotificationsRead();
  });
  $('#notif-mark-read')?.addEventListener('click', (event) => { event.stopPropagation(); markNotificationsRead(); });
  document.addEventListener('click', (event) => { if (state.notif.open && !event.target.closest('.notif-wrap')) close(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.notif.open) close(); });
  $('#notif-list')?.addEventListener('click', (event) => {
    const row = event.target.closest('[data-notif-type]');
    if (!row) return;
    const target = NOTIF_TARGETS[row.dataset.notifType];
    close();
    if (!target) return;
    openPage(target.page);
    target.reload();
    setTimeout(() => $(target.selector)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
  });
}
function renderNotificationBadge() {
  const badge = $('#notif-badge');
  const unread = state.notif.unread;
  if (badge) { badge.textContent = unread > 99 ? '99+' : String(unread); badge.classList.toggle('hidden', unread < 1); }
  document.title = unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${BASE_TITLE}` : BASE_TITLE;
}
function renderNotifications() {
  const list = $('#notif-list');
  if (!list) return;
  if (!state.notif.items.length) { list.innerHTML = '<div class="task-empty">لا توجد إشعارات حتى الآن.</div>'; return; }
  list.innerHTML = state.notif.items.map((item) => `<button type="button" class="notif-item${item.unread ? ' unread' : ''}" data-notif-type="${escapeHtml(item.type)}"><b>${escapeHtml(item.title)}</b>${item.body ? `<span>${escapeHtml(item.body)}</span>` : ''}<time>${escapeHtml(formatDate(item.createdAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</time></button>`).join('');
}
async function loadNotifications() {
  if (!state.user?.canManage) return;
  try {
    const result = await api('/api/notifications');
    const items = Array.isArray(result.items) ? result.items : [];
    const previousMax = state.notif.maxId;
    const fresh = previousMax === null ? [] : items.filter((item) => item.unread && item.id > previousMax);
    state.notif.items = items;
    state.notif.unread = Number(result.unread) || 0;
    state.notif.maxId = items.reduce((max, item) => Math.max(max, item.id), previousMax ?? 0);
    renderNotificationBadge();
    if (state.notif.open) renderNotifications();
    // إشعار جديد وصل أثناء فتح الموقع: نعرضه ونحدّث القائمة المرتبطة بيه تلقائيًا.
    for (const item of fresh.slice(0, 3).reverse()) showToast(`${item.title}${item.body ? ` — ${item.body}` : ''}`, 'info');
    for (const type of new Set(fresh.map((item) => item.type))) NOTIF_TARGETS[type]?.reload();
  } catch { /* الإشعارات مش حرجة؛ نحاول تاني في الدورة الجاية */ }
}
async function markNotificationsRead() {
  if (!state.notif.unread && !state.notif.items.some((item) => item.unread)) return;
  try {
    await api('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    state.notif.unread = 0;
    renderNotificationBadge();
    // نسيب علامة "جديد" ظاهرة جوه اللوحة لحد ما تتقفل، بعدها تختفي.
    if (!state.notif.open) { state.notif.items = state.notif.items.map((item) => ({ ...item, unread: false })); }
  } catch (error) { showToast(error.message, 'error'); }
}

async function runIntroThenInitialize() {
  const splash = $('#boot-splash');
  const card = $('.boot-splash-card', splash || document);
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  // The card contains shorter child animations whose animationend events bubble.
  // Use a duration longer than boot-card-reveal (3.8s) so those child events
  // cannot dismiss the splash before the main animation completes.
  if (!reducedMotion && splash && card) {
    await new Promise((resolve) => setTimeout(resolve, 4200));
    await new Promise((resolve) => setTimeout(resolve, 700));
  } else {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  splash?.classList.add('boot-splash-exit');
  await new Promise((resolve) => setTimeout(resolve, reducedMotion ? 0 : 420));
  splash?.remove();
  await initialize();
}

applyAppearance();
runIntroThenInitialize();
