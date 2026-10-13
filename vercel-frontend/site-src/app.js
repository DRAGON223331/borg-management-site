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
  onlineUserIds: new Set(),
  dailyMessageStats: { dailyStats: [], dailyTotal: 0, dailyDate: null },
  staffStats: [],
  activeStaffProfileId: null,
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
    wireTasks();
    wireChats();
    wireRoster();
    wireLeaveRequests();
    wireStaffRequests();
    if (state.user.canManage) {
      $('#task-manager').classList.remove('hidden');
      $$('.manager-only').forEach((element) => element.classList.remove('hidden'));
      $('#submissions-heading').textContent = 'آخر تسليمات الاستاف';
      $('#manager-leave-section').classList.remove('hidden');
      $('#manager-staff-request-section')?.classList.remove('hidden');
    }
    await Promise.allSettled([loadTasks(), loadRoster(), checkBotStatus(), loadSubmissions(), loadMyPoints(), loadLeaveRequests(), loadStaffRequests(), loadStaffStats()]);
    startChatPolling();
    startPresenceHeartbeat();
    setInterval(checkBotStatus, 30000);
    setInterval(() => { if (state.user) loadStaffStats(); }, 45000);
    setInterval(() => {
      if ($('.page.active-page')?.id === 'page-tasks') loadTasks();
    }, 60000);
  } catch (error) {
    showFatal(error.message || 'حصل خطأ أثناء تحميل الموقع.');
  }
}

function renderProfile() {
  const user = state.user;
  $('#top-username').textContent = user.username || user.handle || 'مستخدم ديسكورد';
  $('#top-role').textContent = user.isManager ? 'مسؤول إدارة' : user.isAdmin ? 'Administrator' : 'عضو الاستاف';
  $('#welcome-name').textContent = user.username || 'يا بطل';
  $('#top-avatar').src = user.avatarUrl || avatarFallback(user.id);
  $('#top-avatar').alt = `صورة ${user.username || 'المستخدم'}`;
}

function wireNavigation() {
  $('#staff-profile-back')?.addEventListener('click', () => { state.activeStaffProfileId = null; openPage('overview'); });
  $$('.nav-tab').forEach((button) => button.addEventListener('click', () => openPage(button.dataset.page)));
  $$('[data-go]').forEach((button) => button.addEventListener('click', () => openPage(button.dataset.go)));
  $('#logout-btn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); }
    catch { /* cookie can expire by itself; still refresh */ }
    location.href = '/';
  });
}
function openPage(page) {
  if (page === 'management-chat' && !state.user?.canManage) return;
  if (page === 'staff-profile' && !state.activeStaffProfileId) return;
  $$('.page').forEach((element) => element.classList.remove('active-page'));
  $(`#page-${page}`)?.classList.add('active-page');
  $$('.nav-tab').forEach((element) => element.classList.toggle('active', element.dataset.page === page));
  if (page === 'staff-chat') loadChat('staff');
  if (page === 'management-chat') loadChat('management');
  if (page === 'staff-profile') loadStaffProfile(state.activeStaffProfileId);
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
    state.selectedTaskIds = new Set([...state.selectedTaskIds].filter((id) => existingIds.has(id)));
    $('#stat-active').textContent = result.stats.active;
    $('#stat-required').textContent = result.stats.required;
    $('#stat-done-required').textContent = result.stats.completedRequired;
    $('#stat-done').textContent = result.stats.completedByMe;
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
      <input class="task-select" type="checkbox" data-select-task="${task.id}" aria-label="اختيار المهمة ${escapeHtml(task.title)}" ${state.selectedTaskIds.has(task.id) ? 'checked' : ''}>
      <div class="task-row-body">
        <div class="task-row-title">${escapeHtml(task.title)}</div>
        <div class="task-row-desc">أُضيفت بواسطة ${escapeHtml(task.created_by_name || 'الإدارة')} · ${formatDate(task.created_at, { day: 'numeric', month: 'short' })}</div>
        <div class="task-row-meta">
          <span class="task-tag ${task.required ? 'required' : 'optional'}">${task.required ? '● مهمة إجبارية' : '○ مهمة اختيارية'}</span>
          <span class="task-id">#${task.id} · ⭐ ${Number(task.points || 0)} نقطة</span>
          ${task.completedByMe ? '<span class="task-tag completed">✓ تم تسليمها</span>' : ''}
        </div>
      </div>
      <div class="task-row-actions">
        ${task.completedByMe ? '<span class="task-complete-label">منجزة</span>' : ''}
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
    const visibleIds = getFilteredTasks().map((task) => task.id);
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
  state.queue.push({ key: state.queueNextId++, title, required: $('#new-task-required').value === '1', points: Math.round(points * 100) / 100 });
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
      <div class="queued-task-title">${escapeHtml(item.title)}</div>
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
      body: JSON.stringify({ tasks: state.queue.map(({ title, required, points }) => ({ title, required, points })) }),
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
  const taskIds = [...state.selectedTaskIds];
  if (!taskIds.length) return showToast('حدد مهمة واحدة على الأقل قبل التسليم.', 'error');
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
      const blob = await uploadToBlob(pathname, file, {
        access: 'private',
        handleUploadUrl: '/api/uploads/token',
        multipart: file.size > 5 * 1024 * 1024,
        contentType: file.type,
        onUploadProgress: (event) => {
          const percentage = Math.round(event.percentage || 0);
          button.textContent = `رفع الملف ${index + 1}/${files.length} · ${percentage}%`;
        },
      });
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
      const tasks = (submission.tasks || []).map((task) => `<span class="task-tag ${task.required ? 'required' : 'optional'}">${task.required ? 'إجباري' : 'اختياري'} · ${escapeHtml(task.title)}</span>`).join('');
      return `<article class="submission-card"><div class="submission-top"><div class="submission-user"><img src="${escapeHtml(submission.avatarUrl || avatarFallback(submission.userId))}" alt=""><span>${escapeHtml(submission.username)}</span><span class="task-id">#${submission.id}</span><span class="task-tag ${submission.status === 'approved' ? 'completed' : submission.status === 'rejected' ? 'required' : 'optional'}">${submission.status === 'approved' ? 'تمت الموافقة' : submission.status === 'rejected' ? 'مرفوض' : 'بانتظار الموافقة'}</span></div><time class="submission-date">${formatDate(submission.submittedAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></div><div class="submission-task-list">${tasks}</div>${submission.note ? `<div class="submission-note">${escapeHtml(submission.note)}</div>` : ''}${files || links ? `<div class="submission-evidence">${files}${links}</div>` : ''}${state.user.canManage && submission.status === 'pending' ? `<div class="manager-actions"><button class="primary-button" data-review-submission="approve" data-id="${submission.id}">موافقة وإضافة النقاط</button><button class="secondary-button" data-review-submission="reject" data-id="${submission.id}">رفض التسليم</button></div>` : ''}</article>`;
    }).join('');
    $$('[data-review-submission]').forEach(button => button.addEventListener('click', async () => { const action = button.dataset.reviewSubmission; const id = button.dataset.id; let reason = ''; if (action === 'reject') { reason = window.prompt('سبب رفض التسليم (اختياري):') || ''; } button.disabled = true; try { const result = await api(`/api/submissions/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }); showToast(action === 'approve' ? `تمت الموافقة وإضافة ${result.awarded} نقطة.` : 'تم رفض التسليم.', 'success'); await Promise.all([loadSubmissions(), loadMyPoints()]); } catch (error) { showToast(error.message, 'error'); button.disabled = false; } }));
  } catch (error) {
    $('#submissions-list').innerHTML = `<div class="task-empty">${escapeHtml(error.message)}</div>`;
  }
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
    renderRoster();
    renderAdminOverview();
    const footer = $('.roster-footer');
    if (footer) footer.innerHTML = `<span class="status-dot"></span> ${state.onlineUserIds.size} متصل الآن · التحديث مباشر`;
  } catch { /* Presence is optional if the endpoint is temporarily unavailable. */ }
}
function startPresenceHeartbeat() {
  const beat = async () => {
    if (!state.user) return;
    try { await api('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* Retry on the next heartbeat. */ }
    await refreshPresence();
  };
  beat();
  setInterval(beat, 30000);
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
      ${group.members.map((member) => `<div class="member-row" role="button" tabindex="0" data-user-id="${escapeHtml(member.id)}" title="${escapeHtml(member.username)} — اضغط لفتح الملف، وكلك يمين لنسخ ID"><div class="member-avatar-wrap"><img class="member-avatar" src="${escapeHtml(member.avatarUrl || avatarFallback(member.id))}" alt=""><span class="member-state ${state.onlineUserIds.has(String(member.id)) ? 'is-online' : 'is-offline'}"></span></div><div style="min-width:0"><div class="member-row-name">${escapeHtml(member.username)}${member.isAdmin ? '<span class="member-admin-tag">إدارة</span>' : ''}</div><div class="member-row-handle">@${escapeHtml(member.handle)}</div></div><span class="member-rank-dot" style="background:${/^#[0-9a-f]{6}$/i.test(member.roleColor) ? member.roleColor : '#64748b'}"></span></div>`).join('')}
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
  } catch (error) {
    const node = $('#admin-overview-cards');
    if (node && !state.staffStats.length) node.innerHTML = `<div class="loading-state">${escapeHtml(error.message)}</div>`;
  }
}
function findStaffProfileMember(userId) {
  return flattenRoster().find((item) => String(item.id) === String(userId)) || (() => {
    const stats = (state.staffStats || []).find((item) => String(item.userId) === String(userId));
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
    const online = state.onlineUserIds.has(String(member.id));
    return `<button type="button" class="admin-overview-card" data-open-staff-profile="${escapeHtml(member.id)}"><div class="admin-overview-top"><img src="${escapeHtml(member.avatarUrl || avatarFallback(member.id))}" alt=""><div class="admin-overview-name"><b>${escapeHtml(member.username)}</b><small>${escapeHtml(member.roleName || 'مسؤول')}</small></div><span class="online-pill ${online ? 'online' : 'offline'}"><i></i>${online ? 'أونلاين' : 'أوفلاين'}</span></div><div class="admin-overview-metrics"><span><b>${Number(stats.dailyMessages || 0).toLocaleString('en-US')}</b><small>رسائل اليوم</small></span><span><b>${Number(stats.totalSubmissions || 0).toLocaleString('en-US')}</b><small>تسليمات</small></span><span><b>${Number(stats.totalPoints || 0).toLocaleString('en-US')}</b><small>نقاط</small></span><span><b>${Number(stats.adminRequests || 0).toLocaleString('en-US')}</b><small>طلبات إدارية</small></span></div><span class="admin-overview-link">فتح الملف الكامل ←</span></button>`;
  }).join('');
  $$('[data-open-staff-profile]', container).forEach((button) => button.addEventListener('click', () => openStaffProfile(button.dataset.openStaffProfile)));
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
    const response = await api(`/api/staff-stats/${encodeURIComponent(userId)}`);
    if (String(state.activeStaffProfileId) !== String(userId)) return;
    renderStaffProfile(member, response.stats || {}, response.recentSubmissions || [], response.recentLeaves || []);
  } catch (error) {
    $('#staff-profile-content').innerHTML = `<div class="task-empty">${escapeHtml(error.message)}</div>`;
  }
}
function renderStaffProfile(member, stats, submissions, leaves) {
  const roles = (member.roles || []).map((role) => `<span class="profile-role-chip">${escapeHtml(role.name)}</span>`).join('') || '<span class="muted">لا توجد رتب إضافية</span>';
  const online = state.onlineUserIds.has(String(member.id));
  const statCard = (label, value, note = '') => { const displayValue = typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value) ? escapeHtml(value) : Number(value || 0).toLocaleString('en-US'); return `<article class="staff-detail-stat"><small>${label}</small><strong>${displayValue}</strong>${note ? `<span>${note}</span>` : ''}</article>`; };
  const statusText = { approved: 'تمت الموافقة', submitted: 'بانتظار المراجعة', pending: 'بانتظار المراجعة', rejected: 'مرفوض' };
  const submissionsHtml = submissions.length ? submissions.map((item) => `<article class="profile-history-row"><div><b>تسليم #${Number(item.id)}</b><small>${escapeHtml(formatDate(item.submittedAt, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</small>${item.note ? `<p>${escapeHtml(item.note)}</p>` : ''}</div><span class="task-tag ${item.status === 'approved' ? 'completed' : item.status === 'rejected' ? 'required' : 'optional'}">${statusText[item.status] || escapeHtml(item.status)}</span></article>`).join('') : '<div class="task-empty">لا توجد تسليمات مسجلة لهذا العضو.</div>';
  const leavesHtml = leaves.length ? leaves.map((item) => `<article class="profile-history-row"><div><b>طلب إجازة #${Number(item.id)}</b><small>${escapeHtml(item.startDate)} — ${escapeHtml(item.endDate)}</small><p>${escapeHtml(item.reason)}</p></div><span class="task-tag ${item.status === 'approved' ? 'completed' : item.status === 'rejected' ? 'required' : 'optional'}">${statusText[item.status] || 'بانتظار المراجعة'}</span></article>`).join('') : '<div class="task-empty">لا توجد طلبات إجازة.</div>';
  $('#staff-profile-content').innerHTML = `<div class="staff-profile-hero"><img class="staff-profile-avatar" src="${escapeHtml(member.avatarUrl || avatarFallback(member.id))}" alt=""><div class="staff-profile-identity"><span class="tiny-label">${member.isAdmin ? 'ADMINISTRATOR PROFILE' : 'STAFF MEMBER PROFILE'}</span><h1>${escapeHtml(member.username)}</h1><p>@${escapeHtml(member.handle || member.id)} · <code>${escapeHtml(member.id)}</code></p><div class="staff-profile-status"><span class="online-pill ${online ? 'online' : 'offline'}"><i></i>${online ? 'متصل بالموقع الآن' : 'غير متصل بالموقع'}</span><span class="manager-badge">${escapeHtml(member.roleName || 'عضو الاستاف')}</span></div></div></div><section class="staff-profile-section"><div class="section-title-row"><div><span class="tiny-label">PERMISSIONS</span><h2>الرتب والصلاحيات</h2></div></div><div class="staff-profile-roles">${roles}</div></section><section class="staff-profile-section"><div class="section-title-row"><div><span class="tiny-label">ACTIVITY OVERVIEW</span><h2>إحصائيات العضو</h2></div><small class="muted">تاريخ الإحصائيات: ${escapeHtml(state.dailyMessageStats.dailyDate || 'اليوم')}</small></div><div class="staff-detail-grid">${statCard('رسائل اليوم', stats.dailyMessages, 'في شات الاستاف')}${statCard('إجمالي الرسائل', stats.totalMessages, 'كل الرسائل المسجلة')}${statCard('إجمالي التسليمات', stats.totalSubmissions)}${statCard('التسليمات المقبولة', stats.approvedSubmissions)}${statCard('التسليمات المعلقة', stats.pendingSubmissions)}${statCard('النقاط المسجلة', stats.totalPoints)}${statCard('طلبات الإجازة', stats.leaveRequests)}${statCard('الطلبات الإدارية', stats.adminRequests)}${statCard('حالة الاتصال', online ? 'متصل' : 'أوفلاين', 'حالة الاتصال الحالية')}</div></section><section class="staff-profile-section"><div class="section-title-row"><div><span class="tiny-label">SUBMISSION HISTORY</span><h2>آخر التسليمات</h2></div></div><div class="profile-history-list">${submissionsHtml}</div></section><section class="staff-profile-section"><div class="section-title-row"><div><span class="tiny-label">LEAVE HISTORY</span><h2>طلبات الإجازة</h2></div></div><div class="profile-history-list">${leavesHtml}</div></section>`;
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
  totalNode.textContent = (Number(data.dailyTotal) || 0).toLocaleString('en-US');
  dateNode.textContent = data.dailyDate ? data.dailyDate.split('-').reverse().join('/') : '—';
  if (!members.length) {
    listNode.innerHTML = '<div class="task-empty">لم يتم تحميل أعضاء الاستاف بعد، أو لا توجد رسائل اليوم.</div>';
    return;
  }
  listNode.innerHTML = members.map((member, index) => `
    <button type="button" class="daily-message-row daily-message-row-clickable" data-open-staff-profile="${escapeHtml(member.id)}">
      <span class="daily-message-rank">${index + 1}</span>
      <img class="daily-message-avatar" src="${escapeHtml(member.avatarUrl || avatarFallback(member.id))}" alt="">
      <div class="daily-message-member"><b>${escapeHtml(member.username || member.handle || member.id)}</b><small>${escapeHtml(member.handle ? `@${member.handle}` : `ID: ${member.id}`)}</small></div>
      <span class="daily-message-count">${Number(member.count || 0).toLocaleString('en-US')} <small>رسالة</small></span>
    </button>
  `).join('');
  $$('.daily-message-row-clickable').forEach((button) => button.addEventListener('click', () => openStaffProfile(button.dataset.openStaffProfile)));
}

function startChatPolling() {
  // Vercel serves the UI statically while the API runs on a persistent backend.
  // Poll only the currently visible chat so the interface works without a WebSocket proxy.
  setInterval(async () => {
    const activePage = $('.page.active-page')?.id;
    const room = activePage === 'page-staff-chat' ? 'staff'
      : activePage === 'page-management-chat' && state.user?.canManage ? 'management'
      : null;
    if (!room) return;
    try {
      const result = await api(`/api/chat/${room}`);
      if (room === 'staff') updateDailyMessageStats(result);
      let added = false;
      for (const message of (result.messages || [])) {
        if (!state.chatMessageIds[room].has(message.id)) {
          addChatMessage(room, message, false);
          added = true;
        }
      }
      if (added) renderChat(room);
    } catch { /* Keep the current chat visible during brief network errors. */ }
  }, 4000);
}
function wireChats() {
  $('#staff-chat-form').addEventListener('submit', (event) => sendChat(event, 'staff'));
  $('#management-chat-form').addEventListener('submit', (event) => sendChat(event, 'management'));
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
    (result.messages || []).forEach((message) => addChatMessage(room, message, false));
    state.chatLoaded[room] = true;
    renderChat(room);
  } catch (error) {
    const feed = room === 'staff' ? $('#staff-chat-feed') : $('#management-chat-feed');
    feed.innerHTML = `<div class="chat-system-empty">${escapeHtml(error.message)}</div>`;
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
      <div class="chat-message-content"><div class="chat-message-meta"><b>${escapeHtml(message.username)}</b><time>${formatTime(message.createdAt)}</time></div><div class="chat-message-bubble">${escapeHtml(message.content)}</div></div>
    </article>
  `).join('');
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}
async function sendChat(event, room) {
  event.preventDefault();
  if (room === 'management' && !state.user?.canManage) return showToast('الغرفة دي مخصصة للمسؤولين.', 'error');
  const input = room === 'staff' ? $('#staff-chat-input') : $('#management-chat-input');
  const content = input.value.trim();
  if (!content) return;
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

initialize();
