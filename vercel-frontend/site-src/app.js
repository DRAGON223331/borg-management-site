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
    if (state.user.canManage) {
      $('#task-manager').classList.remove('hidden');
      $$('.manager-only').forEach((element) => element.classList.remove('hidden'));
      $('#submissions-heading').textContent = 'آخر تسليمات الاستاف';
    }
    await Promise.allSettled([loadTasks(), loadRoster(), checkBotStatus(), loadSubmissions(), loadMyPoints()]);
    startChatPolling();
    setInterval(checkBotStatus, 30000);
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
  $$('.page').forEach((element) => element.classList.remove('active-page'));
  $(`#page-${page}`)?.classList.add('active-page');
  $$('.nav-tab').forEach((element) => element.classList.toggle('active', element.dataset.page === page));
  if (page === 'staff-chat') loadChat('staff');
  if (page === 'management-chat') loadChat('management');
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
  } catch (error) {
    $('#roster-content').innerHTML = `<div class="loading-state">${escapeHtml(error.message)}<br><small>راجع صلاحيات البوت وإعدادات Server Members Intent.</small></div>`;
  }
}
function wireRoster() {
  $('#roster-search').addEventListener('input', renderRoster);
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
      ${group.members.map((member) => `<div class="member-row" title="${escapeHtml(member.username)}"><div class="member-avatar-wrap"><img class="member-avatar" src="${escapeHtml(member.avatarUrl || avatarFallback(member.id))}" alt=""><span class="member-state"></span></div><div style="min-width:0"><div class="member-row-name">${escapeHtml(member.username)}</div><div class="member-row-handle">@${escapeHtml(member.handle)}</div></div><span class="member-rank-dot" style="background:${/^#[0-9a-f]{6}$/i.test(member.roleColor) ? member.roleColor : '#64748b'}"></span></div>`).join('')}
    </section>
  `).join('');
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
