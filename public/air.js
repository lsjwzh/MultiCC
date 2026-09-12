(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const initialParams = new URLSearchParams(location.search);
  const adminModes = window.MultiCCAirAdmin?.modes || new Set();
  const modeFrom = params => {
    const requested = params.get('view');
    if (requested === 'directories') return 'library';
    if (requested === 'schedules') return 'schedules';
    // 控制台是盖在原页面上的一层，不是一种页面模式。/manage 的入口会跳到
    // ?view=overview，那个地址现在表示「打开控制台」，而不是「切到控制台页」。
    if (requested === 'overview') return 'tasks';
    // 「跨目录活动」併进控制台之后，旧链接落在控制台上，而不是变成一个打不开的地址。
    if (requested === 'activity') return 'tasks';
    if (adminModes.has(requested)) return requested;
    return 'tasks';
  };
  // 两个老入口都是「打开控制台」：控制台是盖在原页面上的一层，不是一种页面模式。
  // 跨目录看任务这件事现在只有这一个入口，所以 view=activity 和 view=overview 同义。
  let consoleOpen = ['overview', 'activity'].includes(initialParams.get('view'));
  let paletteOpen = false;
  let paletteItems = [];
  let paletteIndex = 0;
  let data = null;
  let directoryId = initialParams.get('dir');
  let taskId = initialParams.get('task');
  let entry = null;
  let mode = modeFrom(initialParams);
  let scheduleTasks = [];
  let scheduleLoading = false;
  let timer;
  let epoch = 0;
  let stopped = false;
  let loading = false;
  let createAttempt = null;
  let quickCreateAttempt = null;

  const stateNames = {
    active: '进行中', succeeded: '成功', unknown: '结果待核验', failed: '失败', error: '失败', cancelled: '已取消',
    workspace_execution_capacity: '等待执行名额', workspace_resident_capacity: '等待目录容量',
    workspace_restore_capacity: '等待目录准备名额', planned: '执行时准备目录', resident: '目录已准备',
    retained: '目录已保留', hibernated: '目录已休眠', reserved: '准备执行', materializing: '正在准备目录',
    starting: '正在启动', running: '执行中', uncertain: '等待核实执行状态', idle: '空闲', queued: '排队中',
    waiting: '等待回答', archived: '已归档', stale: '建议已过期',
    // 工作流阶段（src/task-board/planning.js WORKFLOW_STAGES）五个都要有词：任务行
    // 会把阶段当补充信息写在徽标后面，漏一个就有一行蹦出英文。用词跟老看板
    // （manage-task-planner.js plannerStage*）对齐 —— 同一件事不在这套界面里叫两个名字。
    inbox: '待处理', ready: '待执行', doing: '进行中', review: '待验收', done: '已完成',
  };
  const blockerNames = {
    view_changed: '已有新输入或视图变化，旧建议不能迟到改投。',
    final_run_result_required: '等待本轮最终执行结果。',
    run_not_succeeded: '本轮失败、取消或仍在等待回答。',
    code_observation_required: '本轮最终代码版本尚未核实。',
    integration_receipt_required: '等待本轮代码按项目流程合入基分支。',
    baseline_revalidation_required: '基分支已变化，需要重新核验交付记录。',
    source_writer_barrier_required: '尚不能确认源工作目录持续停写。',
  };

  const label = value => stateNames[value] || value || '';
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const stored = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value == null ? fallback : value;
    } catch (_) { return fallback; }
  };
  let favorites = stored('air:favorites', []);
  if (!Array.isArray(favorites)) favorites = [];
  // 「最近」= 我打开过的任务（跨目录，最新在前）。浏览记录不是权限也不是归属，
  // 只是把常用的几个任务放在手边。
  let recentTaskIds = stored('air:recent-tasks', []);
  if (!Array.isArray(recentTaskIds)) recentTaskIds = [];
  function rememberTask(id) {
    if (!id) return;
    recentTaskIds = [id, ...recentTaskIds.filter(value => value !== id)].slice(0, 12);
    try { localStorage.setItem('air:recent-tasks', JSON.stringify(recentTaskIds)); } catch (_) {}
  }
  // 侧栏的任务区只装「手上的任务」：打开过的排在前面，然后是当前目录里最新的几个。
  // 后一半是必要的 —— 第一次进来没有浏览记录，只有前一半的话列出来是空的，而一条
  // 空列表并不比一条能点的任务更有用。完整的那份列表在控制台（全部目录 + 搜索）。
  const RECENT_LIMIT = 8;
  function recentPool() {
    if (!data) return [];
    const byId = new Map(data.tasks.map(task => [task.id, task]));
    const pool = [];
    const seen = new Set();
    for (const id of recentTaskIds) {
      const task = byId.get(id);
      if (!task || seen.has(task.id)) continue;
      seen.add(task.id);
      pool.push(task);
    }
    const settled = task => (['done', 'archived'].includes(task.status) ? 1 : 0);
    for (const task of data.tasks.filter(t => t.dirId === directoryId)
      .sort((a, b) => settled(a) - settled(b) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0))) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      pool.push(task);
    }
    return pool.slice(0, RECENT_LIMIT);
  }
  const urgentTasks = () => window.MultiCCAirAdmin?.urgentTasks?.(data) || [];

  // ── 状态与「在跑」 ──────────────────────────────────────────────────────
  // 判定只有一处：air-admin.js 把 public/status-presentation.js 包了一层给侧栏用。
  // 所以一条任务在侧栏和控制台不可能显示成两种状态，彩虹圈也不可能只出现在一边
  // —— 注册表把 spinner 只给了 running，「出错的任务绝不动画」因此不由这里决定。
  const taskStatus = task => window.MultiCCAirAdmin?.taskStatus?.(task) || 'unknown';
  const isRunningTask = task => window.MultiCCAirAdmin?.isRunning?.(task) === true;
  const runningDirectories = () => window.MultiCCAirAdmin?.runningDirectories?.(data) || new Set();
  const applyRing = (element, on) => window.MultiCCAirAdmin?.applyRing?.(element, on);
  /** 状态徽标（图标 + 中文标签）。没有注册表时给一句可读的兜底文案。 */
  function statusBadge(task, options) {
    return window.MultiCCAirAdmin?.statusBadge?.(task, options)
      || node('span', label(taskStatus(task)), 'mc-status');
  }

  async function api(path, body, requestedMethod = null) {
    const method = requestedMethod || (body === undefined ? 'GET' : 'POST');
    const hasBody = body !== undefined;
    const response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      cache: method === 'GET' ? 'no-store' : 'default',
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await response.text();
    let result;
    try { result = raw ? JSON.parse(raw) : {}; }
    catch (_) {
      const message = /<!doctype|<html/i.test(raw)
        ? 'Air 服务接口尚未加载。请重启 MultiCC 服务后刷新页面。'
        : `Air 服务返回了无法识别的数据（HTTP ${response.status}）。`;
      throw Object.assign(new Error(message), { code: 'air_invalid_response', status: response.status });
    }
    if (!response.ok || result.ok === false) {
      throw Object.assign(new Error(result.message || result.error || result.code || `HTTP ${response.status}`), result);
    }
    return result;
  }

  function notice(text = '') { $('notice').textContent = text; }
  function closeNav() {
    document.body.classList.remove('nav-open');
    $('mobile-nav').setAttribute('aria-expanded', 'false');
  }
  function toggleNav() {
    const open = !document.body.classList.contains('nav-open');
    document.body.classList.toggle('nav-open', open);
    $('mobile-nav').setAttribute('aria-expanded', String(open));
    // 两层浮层叠在一起没有意义：抽屉的遮罩压在工具浮层上面，点不着的浮层等于没开。
    if (open) closeOptions();
  }
  // 手机上页头的工具都住在这层浮层里（air.css 的 760px 块）。它挂在页头下面，
  // 不占位，所以开着的时候页头还是那一行高。
  function closeOptions() {
    $('task-header').classList.remove('options-open');
    $('task-options').setAttribute('aria-expanded', 'false');
  }
  function toggleOptions() {
    const open = !$('task-header').classList.contains('options-open');
    $('task-header').classList.toggle('options-open', open);
    $('task-options').setAttribute('aria-expanded', String(open));
    if (open) closeNav();
  }
  function closeDetails() {
    $('task-details').hidden = true;
    $('details-toggle').setAttribute('aria-expanded', 'false');
    $('task-state').setAttribute('aria-expanded', 'false');
  }
  function toggleDetails(value = $('task-details').hidden) {
    if (!taskId) return;
    $('task-details').hidden = !value;
    $('details-toggle').setAttribute('aria-expanded', String(value));
    $('task-state').setAttribute('aria-expanded', String(value));
  }

  // ── 控制台：从左侧展开的一层 ────────────────────────────────────────────
  // 打开它不改地址、不卸载当前任务、不重建任何东西 —— 所以关掉能回到离开
  // 时的原处。地址里唯一的痕迹是 /manage 的旧入口 ?view=overview，关掉的
  // 时候顺手抹平，免得刷新又弹出来。
  function applyConsole(open) {
    consoleOpen = !!open;
    document.body.classList.toggle('console-open', consoleOpen);
    $('overview').setAttribute('aria-expanded', String(consoleOpen));
    $('console-panel').setAttribute('aria-hidden', String(!consoleOpen));
    $('console-scrim').hidden = !consoleOpen;
  }
  function setConsole(open) {
    if (consoleOpen === !!open) return;
    const focusConsole = !!open;
    applyConsole(open);
    if (focusConsole) {
      render();
      $('console-close').focus();
      return;
    }
    if (new URLSearchParams(location.search).get('view') === 'overview') history.replaceState({}, '', routeUrl());
    $('overview').focus();
  }

  // ── ⌘K：目录和任务一起搜 ────────────────────────────────────────────────
  // 找任务不该先要求你想起来它在哪个目录。两类对象同一次搜索、同一个列表。
  function paletteCandidates(query) {
    const needle = query.trim().toLowerCase();
    const matches = text => !needle || text.toLowerCase().includes(needle);
    const directories = data.directories
      .filter(directory => matches(`${directory.name} ${directory.path || ''}`))
      .slice(0, needle ? 6 : 5)
      .map(directory => ({
        kind: 'directory', dirId: directory.id,
        title: directory.name, detail: directory.path || '工作目录',
      }));
    // 顺序即相关度：手上的任务在前，然后是当前目录，最后是其余任务。
    const pool = [...recentPool(), ...data.tasks];
    const seen = new Set();
    const tasks = [];
    for (const task of pool) {
      if (seen.has(task.id) || !matches(task.title || '')) continue;
      seen.add(task.id);
      tasks.push({
        kind: 'task', dirId: task.dirId, id: task.id,
        title: task.title || '未命名任务',
        detail: `${directoryName(task.dirId)} · ${label(taskStatus(task))}`,
      });
      if (tasks.length >= (needle ? 8 : 6)) break;
    }
    return [...directories, ...tasks];
  }
  function renderPalette() {
    paletteItems = paletteCandidates($('palette-input').value);
    if (paletteIndex >= paletteItems.length) paletteIndex = 0;
    $('palette-results').replaceChildren(...paletteItems.map((item, index) => {
      const button = node('button', null, index === paletteIndex ? 'active' : '');
      button.type = 'button';
      const copy = node('span', null, 'palette-copy');
      copy.append(node('strong', item.title), node('small', item.detail));
      button.append(node('span', item.kind === 'task' ? '◆' : '▣', 'palette-mark'), copy,
        node('span', item.kind === 'task' ? '任务' : '目录', 'palette-kind'));
      button.onclick = () => choosePalette(index);
      return button;
    }));
    if (!paletteItems.length) $('palette-results').append(node('p', '没有匹配的工作目录或任务。', 'empty-list'));
    const directories = paletteItems.filter(item => item.kind === 'directory').length;
    $('palette-note').textContent = paletteItems.length
      ? `${directories} 个目录 · ${paletteItems.length - directories} 个任务`
      : '目录与任务一起搜';
  }
  function choosePalette(index = paletteIndex) {
    const item = paletteItems[index];
    if (!item) return;
    closePalette();
    navigate(item.dirId, item.kind === 'task' ? item.id : null);
  }
  function openPalette() {
    if (!data || paletteOpen) return;
    // 用 setConsole 而不是 applyConsole：它顺手把地址里的 view=overview 撤掉，
    // 否则面板被 ⌘K 顶掉之后，刷新页面又会自己弹回来。
    if (consoleOpen) setConsole(false);
    paletteOpen = true;
    paletteIndex = 0;
    $('palette-input').value = '';
    $('palette').hidden = false;
    $('palette-scrim').hidden = false;
    renderPalette();
    $('palette-input').focus();
  }
  function closePalette() {
    paletteOpen = false;
    $('palette').hidden = true;
    $('palette-scrim').hidden = true;
  }
  function saveDraft() {
    const doc = $('conversation').contentDocument;
    const input = doc?.getElementById('input') || doc?.getElementById('message');
    if (taskId && input) sessionStorage.setItem(`air:draft:${taskId}`, input.value);
  }
  function routeUrl(nextMode = mode) {
    const params = new URLSearchParams();
    if (nextMode === 'library') params.set('view', 'directories');
    if (nextMode === 'schedules') params.set('view', 'schedules');
    if (adminModes.has(nextMode)) params.set('view', nextMode);
    const external = initialParams.get('external');
    if (external) params.set('external', external);
    if (directoryId) params.set('dir', directoryId);
    if (taskId && nextMode === 'tasks') params.set('task', taskId);
    return '/air' + (params.size ? '?' + params : '');
  }
  // 从控制台或命令面板里选走一个目标，就意味着那一层要让开；地址由这次
  // 导航决定，浮层不往地址栏里写东西。
  function closeOverlays() {
    if (paletteOpen) closePalette();
    if (consoleOpen) applyConsole(false);
    closeOptions();
  }
  function navigate(dir, task = null) {
    saveDraft();
    directoryId = dir;
    taskId = task;
    mode = 'tasks';
    entry = null;
    closeDetails();
    if (task) rememberTask(task);
    closeOverlays();
    history.pushState({}, '', routeUrl());
    closeNav();
    render();
    void refreshEntry();
  }
  function setMode(next) {
    // 控制台不再是一种页面模式：任何还写着 setMode('overview') 的入口都换成
    // 展开这层面板，页面留在原处。
    if (next === 'overview') { setConsole(true); return; }
    saveDraft();
    mode = next;
    taskId = null;
    entry = null;
    closeDetails();
    closeOverlays();
    history.pushState({}, '', routeUrl(next));
    closeNav();
    render();
    if (next === 'library') requestAnimationFrame(() => $('directory-search').focus());
    if (next === 'schedules') void refreshSchedules();
  }
  function resourceText(resource) {
    if (resource?.capacityReason) return label(resource.capacityReason);
    if (resource?.lease && resource.lease !== 'idle') return label(resource.lease);
    return label(resource?.residency);
  }
  // 列表行里只说「卡在哪」的那部分资源状态：工作目录是计划态还是已经常驻，是任务
  // 详情面板要回答的问题（那儿就有整整一行「资源状态」），摆在每一行上只会把
  // 阶段、目录这些真正一眼要看的东西挤掉。
  function holdText(resource) {
    if (resource?.capacityReason) return label(resource.capacityReason);
    if (resource?.lease && resource.lease !== 'idle') return label(resource.lease);
    return '';
  }
  function directoryName(id) { return data?.directories.find(directory => directory.id === id)?.name || '未知目录'; }

  function renderDirectories() {
    if (!data) return;
    const query = $('directory-search').value.trim().toLowerCase();
    const directories = data.directories.filter(directory => `${directory.name} ${directory.path}`.toLowerCase().includes(query));
    const busy = runningDirectories();
    $('directory-grid').replaceChildren(...directories.map(directory => {
      const button = node('button');
      applyRing(button, busy.has(directory.id));
      const taskCount = data.tasks.filter(task => task.dirId === directory.id).length;
      const activeCount = data.tasks.filter(task => task.dirId === directory.id && isRunningTask(task)).length;
      button.append(node('strong', '▣ ' + directory.name), node('small', directory.path),
        node('small', `${taskCount} 个任务${activeCount ? ` · ${activeCount} 个执行中` : ''}${favorites.includes(directory.id) ? ' · 已收藏' : ''}`));
      button.onclick = () => navigate(directory.id);
      return button;
    }));
    if (!directories.length) $('directory-grid').append(node('p', query ? '没有匹配的工作目录。' : '还没有工作目录。', 'empty-list'));
  }

  function renderDirectoryOverview() {
    const dir = data?.directories.find(directory => directory.id === directoryId);
    const tasks = (data?.tasks || []).filter(task => task.dirId === directoryId);
    const current = tasks.filter(task => !['done', 'archived'].includes(task.status));
    const running = current.filter(isRunningTask);
    const planned = current.filter(task => task.recordType === 'planned' && !running.includes(task));
    $('directory-open-planner').disabled = !dir;
    const stat = (name, value, detail, tone = '') => {
      const card = node('article', null, `directory-stat ${tone}`);
      card.append(node('span', name), node('strong', String(value)), node('small', detail));
      return card;
    };
    $('directory-stats').replaceChildren(
      stat('进行中', current.length, `${running.length} 个正在执行`, 'blue'),
      stat('计划任务', planned.length, '待开始或继续规划'),
      stat('已完成', tasks.filter(task => task.status === 'done').length, '仍保留在本目录', 'green'),
      stat('全部记录', tasks.length, `${tasks.filter(task => task.status === 'archived').length} 个已归档`),
    );
    $('directory-overview-count').textContent = `${tasks.length} 个任务`;
    const rows = [...tasks].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).slice(0, 10);
    $('directory-task-list').replaceChildren(...rows.map(task => {
      const button = node('button', null, 'directory-task-row');
      applyRing(button, isRunningTask(task));
      const copy = node('span');
      const meta = node('small', null, 'task-meta');
      meta.append(statusBadge(task));
      const stage = label(task.workflowStage || task.status);
      const detail = holdText(task.resource);
      const extra = [stage, detail].filter(part => part && !label(taskStatus(task)).includes(part)).join(' · ');
      if (extra) meta.append(node('em', extra, 'task-note'));
      copy.append(node('strong', task.title || '未命名任务'), meta);
      button.append(node('span', task.recordType === 'planned' ? '◇' : '›', 'directory-task-mark'), copy,
        node('time', task.updatedAt ? new Date(task.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''));
      button.onclick = () => navigate(directoryId, task.id);
      return button;
    }));
    if (!rows.length) $('directory-task-list').append(node('p', '这里还没有任务。可以直接在下方描述第一个目标。', 'directory-task-empty'));
    renderQuickPills();
    for (const element of [$('quick-task-input'), $('quick-task-submit'),
      $('quick-task-attach'), $('quick-task-mic')]) element.disabled = !dir;
  }

  function quickTaskId() {
    return crypto.randomUUID ? crypto.randomUUID() : `air-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function uploadQuickTaskFiles(files) {
    $('quick-task-attach').disabled = true;
    for (const file of Array.from(files || [])) {
      const chip = node('span', `上传中 · ${file.name}`, 'quick-task-file');
      $('quick-task-files').append(chip);
      try {
        const form = new FormData(); form.append('file', file, file.name);
        const response = await fetch('/api/upload', { method: 'POST', body: form });
        const result = await response.json();
        if (!response.ok || !result.path) throw new Error(result.error || `HTTP ${response.status}`);
        chip.textContent = file.name;
        chip.dataset.path = result.path;
        const remove = node('button', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `移除 ${file.name}`);
        remove.onclick = () => chip.remove(); chip.append(remove);
      } catch (error) {
        chip.classList.add('error'); chip.textContent = `${file.name} · ${error.message}`;
      }
    }
    $('quick-task-file-input').value = '';
    $('quick-task-attach').disabled = !directoryId;
  }

  // ── New-task composer, at chat parity ─────────────────────────────────────
  // The box is the same composer module the task chat uses (composer.css), so it
  // offers the same capabilities through the same endpoints the chat composer
  // uses: attach by button, paste or drop; dictation through the local ASR; Goal
  // mode with its limits; and — through the two pills the chat also renders on
  // its composer — the same AI 配置 (CLI · provider · model · effort) and 角色
  // dialogs. Nothing about configuring a task is written twice: a pill opens the
  // one dialog and holds the answer until the task is created.
  function quickStatus(text) { $('quick-task-status').textContent = text || ''; }

  // Empty until a pill is used: an unconfigured new task then follows the same
  // default routing it would have had anyway.
  let quickRuntime = {};
  let quickRoles = [];

  // One source of truth for the CLI the panel is about to use: the pill names it
  // and the AI 配置 dialog opens on it, so the two can never disagree about what
  // a task created from here will run.
  function quickCli() { return quickRuntime.cli || data?.clis?.[0] || 'claude'; }

  function renderQuickPills() {
    const ai = $('quick-ai-pill'), role = $('quick-role-pill');
    if (!ai || !role) return;
    const route = quickRuntime.providerSelection?.mode === 'auto'
      ? `Auto ${quickRuntime.providerSelection.protocol}`
      : quickRuntime.providerName || quickRuntime.provider || '默认线路';
    ai.textContent = [quickCli(), route, quickRuntime.model || '默认模型'].join(' · ');
    ai.title = '新任务的 AI 配置：CLI、线路与模型（创建后即生效）';
    role.textContent = quickRoles.length ? `${quickRoles.length} 个角色` : '＋ 角色';
    role.title = '新任务的角色上下文（写入第一条消息）';
    for (const pill of [ai, role]) pill.disabled = !directoryId;
  }

  function openQuickConfiguration() {
    if (!directoryId) return;
    window.MultiCCAirSettings.configuration(
      { task: { title: '新任务' }, configuration: { ...quickRuntime, cli: quickCli() } }, data?.clis,
      runtime => { quickRuntime = runtime; renderQuickPills(); },
    );
  }

  function openQuickRoles() {
    if (!directoryId) return;
    window.MultiCCAirRoles.open({
      roleBindings: { version: 0, bindings: quickRoles }, api,
      save: async bindings => { quickRoles = bindings; renderQuickPills(); },
    });
  }

  // Dictation: press to record, press again to stop, one-shot transcription.
  let quickRecorder = null;
  let quickRecorderChunks = [];
  async function toggleQuickDictation() {
    const button = $('quick-task-mic');
    if (quickRecorder && quickRecorder.state === 'recording') { quickRecorder.stop(); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (_) { quickStatus('无法访问麦克风，请检查浏览器权限。'); return; }
    quickRecorderChunks = [];
    const mime = window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : undefined;
    try { quickRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    catch (_) {
      stream.getTracks().forEach(track => track.stop());
      quickStatus('浏览器不支持录音。');
      return;
    }
    quickRecorder.ondataavailable = event => { if (event.data?.size) quickRecorderChunks.push(event.data); };
    quickRecorder.onstop = async () => {
      stream.getTracks().forEach(track => track.stop());
      button.classList.remove('rec');
      const blob = new Blob(quickRecorderChunks, { type: 'audio/webm' });
      if (!blob.size) { quickStatus(''); return; }
      quickStatus('转写中…');
      try {
        const form = new FormData(); form.append('file', blob, 'recording.webm');
        const response = await fetch('/api/voice/stt', { method: 'POST', body: form });
        const result = await response.json();
        if (!response.ok || !result.text) throw new Error(result.error || '没有识别到内容');
        const input = $('quick-task-input');
        input.value = input.value ? `${input.value} ${result.text.trim()}` : result.text.trim();
        input.focus();
        quickStatus('');
      } catch (error) { quickStatus(`转写失败：${error.message}`); }
    };
    quickRecorder.start();
    button.classList.add('rec');
    quickStatus('录音中，点 🎙 结束。');
  }

  function renderQuickGoalLimits() {
    $('quick-task-goal-limits').hidden = !$('quick-task-goal').checked;
  }

  // Enter creates, unless the text is meant to be multiline; the draft is only
  // cleared once the message is acknowledged, so a failure keeps the work.
  function goalLimitsFromForm() {
    const limits = {};
    const rounds = $('quick-task-goal-rounds').value.trim();
    const budget = $('quick-task-goal-budget').value.trim();
    if (rounds && Number(rounds) > 0) limits.maxRounds = Number(rounds);
    if (budget && Number(budget) > 0) limits.maxBudget = Number(budget);
    return limits;
  }

  async function submitQuickTask(event) {
    event.preventDefault();
    if (!data || !directoryId) return;
    const typed = $('quick-task-input').value.trim();
    if (!typed) return;
    const paths = [...$('quick-task-files').querySelectorAll('[data-path]')].map(chip => chip.dataset.path);
    const text = typed + (paths.length ? `\n\n附件：${paths.join(' ')}` : '');
    // The pill's runtime is pinned onto the task at creation; the route it names
    // takes effect immediately, exactly as it does on the chat's own composer.
    const runtime = { cli: quickRuntime.cli || data.clis[0] || 'claude' };
    for (const key of ['provider', 'providerSelection', 'model', 'effort']) {
      if (quickRuntime[key]) runtime[key] = quickRuntime[key];
    }
    const goal = $('quick-task-goal').checked;
    const goalLimits = goal ? goalLimitsFromForm() : null;
    const fingerprint = JSON.stringify([directoryId, text, runtime, quickRoles, goalLimits]);
    if (!quickCreateAttempt || quickCreateAttempt.fingerprint !== fingerprint) {
      quickCreateAttempt = { fingerprint, createId: quickTaskId(), sendId: quickTaskId() };
    }
    const attempt = quickCreateAttempt;
    let created = null;
    $('quick-task-submit').disabled = true;
    quickStatus('正在创建固定任务…');
    try {
      const title = typed.split(/\n/).find(Boolean).trim().slice(0, 120);
      created = await api('/api/air/tasks', { dirId: directoryId, title, clientMsgId: attempt.createId, ...runtime });
      quickStatus('任务已创建，正在写入角色与第一条消息…');
      // Roles are bound before the first message: the binding speaks for the
      // next message, and the next message is exactly the one below.
      if (quickRoles.length) {
        await api(`/api/air/tasks/${encodeURIComponent(created.taskId)}/roles`, {
          bindings: quickRoles, expectedVersion: 0, clientMsgId: `${attempt.createId}-roles`,
        });
      }
      await api(`/api/task-shell-tasks/${encodeURIComponent(created.taskId)}/messages`, {
        text, clientMsgId: attempt.sendId, intent: 'work', ...(goal ? { goal: true, goalLimits: goalLimits || {} } : {}),
      });
      quickCreateAttempt = null;
      $('quick-task-input').value = '';
      $('quick-task-goal').checked = false;
      // The route stays (it is how this person runs things); the roles do not —
      // one task's role context must never leak into the next one unseen.
      quickRoles = [];
      renderQuickPills();
      renderQuickGoalLimits();
      $('quick-task-files').replaceChildren();
      await refresh();
      navigate(directoryId, created.taskId);
    } catch (error) {
      if (created?.taskId) {
        sessionStorage.setItem(`air:draft:${created.taskId}`, text);
        quickCreateAttempt = null;
        await refresh();
        navigate(directoryId, created.taskId);
        notice(`任务已创建，但第一条消息未确认送达：${error.message}。草稿已保留。`);
      } else quickStatus(error.message);
    } finally { $('quick-task-submit').disabled = false; }
  }

  function scheduleTime(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(value));
  }

  function scheduleRuntime(task) {
    return [task.cli, task.provider, task.model, task.effort].filter(Boolean).join(' · ') || '跟随任务配置';
  }

  function scheduleAction(text, action, className = '') {
    const button = node('button', text, className);
    button.type = 'button';
    button.onclick = action;
    return button;
  }

  function renderSchedules() {
    const list = $('schedule-list');
    if (!list) return;
    const enabled = scheduleTasks.filter(task => task.enabled).length;
    const errors = scheduleTasks.filter(task => task.lastStatus === 'error' || task.taskBindingError).length;
    $('schedule-summary').replaceChildren(
      node('span', `${scheduleTasks.length} 条规则`),
      node('span', `${enabled} 条启用`),
      node('span', errors ? `${errors} 条需处理` : '固定任务均正常', errors ? 'warning' : 'healthy'),
    );
    list.replaceChildren();
    if (!scheduleTasks.length) {
      const empty = node('div', null, 'schedule-empty');
      empty.append(node('strong', '还没有定时任务'), node('p', '新建规则时会同时创建一个固定 Air 任务，后续运行都在该任务中继续。'));
      list.append(empty);
      return;
    }
    for (const task of scheduleTasks) {
      const card = node('article', null, 'schedule-card');
      const head = node('header', null, 'schedule-card-head');
      const title = node('div');
      title.append(node('span', 'SCHEDULE', 'eyebrow'), node('h3', task.name));
      head.append(title, node('span', task.enabled ? '已启用' : '已停用', `schedule-badge ${task.enabled ? 'enabled' : ''}`));

      const timing = node('div', null, 'schedule-timing');
      const expression = node('code', task.cron);
      const next = node('div');
      next.append(node('small', '下次运行'), node('strong', task.enabled ? scheduleTime(task.nextRunAt) : '已暂停'));
      const previous = node('div');
      previous.append(node('small', '最近触发'), node('strong', task.lastRunAt ? scheduleTime(task.lastRunAt) : '尚未运行'));
      timing.append(expression, next, previous);

      const fixed = node('button', null, `schedule-fixed-task ${task.taskBindingError || !task.taskId ? 'broken' : ''}`);
      fixed.type = 'button';
      fixed.disabled = !task.taskId;
      const fixedCopy = node('span');
      fixedCopy.append(node('small', '固定 Air 任务'), node('strong', task.taskTitle || task.name),
        node('small', task.taskBindingError || (task.taskId ? `${task.taskId} · ${scheduleRuntime(task)}` : '正在建立任务绑定')));
      fixed.append(node('span', task.taskBindingError ? '!' : '↗', 'schedule-task-mark'), fixedCopy);
      if (task.taskId) fixed.onclick = () => navigate(task.dirId, task.taskId);

      const state = node('div', null, `schedule-state ${task.lastStatus === 'error' ? 'error' : ''}`);
      const stateLabel = task.lastStatus === 'queued' ? '已进入固定任务队列'
        : task.lastStatus === 'ok' ? '最近一次已接收'
          : task.lastStatus === 'error' ? (task.lastError || '最近一次运行失败') : '等待首次运行';
      state.append(node('span', stateLabel), node('small', `${task.dirName} · 已触发 ${task.runCount || 0} 次`));

      const prompt = node('p', task.prompt, 'schedule-prompt');
      const actions = node('footer', null, 'schedule-actions');
      const run = scheduleAction('▶ 立即运行', () => runSchedule(task.id), 'primary subtle');
      const toggle = scheduleAction(task.enabled ? '暂停' : '启用', () => toggleSchedule(task.id, !task.enabled));
      const edit = scheduleAction('编辑规则', () => openScheduleDialog(task.id));
      const remove = scheduleAction('删除规则', () => deleteSchedule(task.id), 'danger');
      actions.append(run, toggle, edit, node('span'), remove);
      card.append(head, timing, fixed, state, prompt, actions);
      list.append(card);
    }
  }

  async function refreshSchedules() {
    if (scheduleLoading) return;
    scheduleLoading = true;
    try {
      scheduleTasks = await api('/api/cron');
      renderSchedules();
    } catch (error) {
      if (mode === 'schedules') notice(`定时任务读取失败：${error.message}`);
    } finally { scheduleLoading = false; }
  }

  function openScheduleDialog(id = null) {
    if (!data) return;
    const current = id ? scheduleTasks.find(task => task.id === id) : null;
    const form = $('schedule-form');
    form.reset();
    form.elements.id.value = current?.id || '';
    form.elements.name.value = current?.name || '';
    form.elements.cron.value = current?.cron || '0 9 * * *';
    form.elements.prompt.value = current?.prompt || '';
    form.elements.enabled.checked = current ? current.enabled : true;
    form.elements.dirId.replaceChildren(...data.directories.map(directory => {
      const option = node('option', directory.name);
      option.value = directory.id;
      option.selected = directory.id === (current?.dirId || directoryId || data.directories[0]?.id);
      return option;
    }));
    form.elements.cli.replaceChildren(...data.clis.map(cli => {
      const option = node('option', cli);
      option.value = cli;
      option.selected = cli === (current?.cli || 'claude');
      return option;
    }));
    form.elements.dirId.disabled = !!current?.taskId;
    form.elements.cli.disabled = !!current?.taskId;
    $('schedule-fixed-note').hidden = !current?.taskId;
    $('schedule-dialog-title').textContent = current ? '编辑定时规则' : '新建定时任务';
    $('schedule-save').textContent = current ? '保存规则' : '创建并绑定任务';
    $('schedule-error').textContent = '';
    $('schedule-dialog').showModal();
  }

  async function saveSchedule(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.elements.id.value;
    const body = {
      name: form.elements.name.value.trim(),
      cron: form.elements.cron.value.trim(),
      prompt: form.elements.prompt.value.trim(),
      enabled: form.elements.enabled.checked,
    };
    if (!id) Object.assign(body, { dirId: form.elements.dirId.value, cli: form.elements.cli.value });
    $('schedule-save').disabled = true;
    $('schedule-error').textContent = '';
    try {
      await api('/api/cron' + (id ? `/${encodeURIComponent(id)}` : ''), body, id ? 'PATCH' : 'POST');
      $('schedule-dialog').close();
      await Promise.all([refreshSchedules(), refresh()]);
      notice(id ? '定时规则已更新；固定任务和历史保持不变。' : '定时任务已创建，并绑定到唯一的 Air 任务。');
    } catch (error) { $('schedule-error').textContent = error.message; }
    finally { $('schedule-save').disabled = false; }
  }

  async function runSchedule(id) {
    try {
      const result = await api(`/api/cron/${encodeURIComponent(id)}/run`, {});
      await Promise.all([refreshSchedules(), refresh()]);
      notice(result.decision === 'queued' ? '固定任务正在忙碌，本次执行已经排队。' : '执行指令已经送入固定 Air 任务。');
    } catch (error) { notice(`运行失败：${error.message}`); }
  }

  async function toggleSchedule(id, enabled) {
    try {
      await api(`/api/cron/${encodeURIComponent(id)}`, { enabled }, 'PATCH');
      await refreshSchedules();
    } catch (error) { notice(`更新失败：${error.message}`); }
  }

  async function deleteSchedule(id) {
    if (!window.confirm('删除这条定时规则？固定 Air 任务及其历史会继续保留。')) return;
    try {
      await api(`/api/cron/${encodeURIComponent(id)}`, undefined, 'DELETE');
      await refreshSchedules();
      notice('定时规则已删除；固定 Air 任务和历史没有删除。');
    } catch (error) { notice(`删除失败：${error.message}`); }
  }

  function visibleTasks() {
    return recentPool();
  }

  function renderHeader(dir) {
    const selectedEntry = entry?.task?.id === taskId ? entry : null;
    const adminHeadings = {
      planner: ['MultiCC Air › 工作管理', '任务看板', '按模块查看、筛选与规划全部任务。'],
      docs: ['MultiCC Air › 系统工具', '服务与文档', 'Agent 产物、本地页面和服务登记。'],
      memory: ['MultiCC Air › 系统工具', '记忆图谱', '项目记忆、会话记忆与文件编辑。'],
      settings: ['MultiCC Air › 系统设置', '设置中心', 'AI、连接、通知和资源配置。'],
      voice: ['MultiCC Air › 设置中心', '语音设置', '识别、转写与实时语音能力。'],
      goal: ['MultiCC Air › 设置中心', 'Goal 预检', '任务目标与自动分类规则。'],
      provider: ['MultiCC Air › 设置中心', 'CLI 与 Provider', '全局供应商、账号与线路管理。'],
      global: ['MultiCC Air › 设置中心', '全局配置', '语言、执行与通用偏好。'],
      push: ['MultiCC Air › 设置中心', '推送通知', 'Web Push 与备用提醒通道。'],
      tunnel: ['MultiCC Air › 设置中心', '外网穿透', 'Tailscale 与隧道服务状态。'],
      bridges: ['MultiCC Air › 设置中心', '消息桥接', '微信、飞书及其他消息入口。'],
      resources: ['MultiCC Air › 设置中心', 'Agent 资源', 'Skills 与历史资源管理。'],
      skillsync: ['MultiCC Air › 设置中心', '技能同步', '跨 CLI 的 Skills 同步状态。'],
      storage: ['MultiCC Air › 设置中心', '临时上传', '上传缓存、空间占用与清理。'],
    };
    // The card stands for the current directory, so it stays lit while that
    // directory's own page is open; the directory library itself is ⌘K / the
    // 控制台 shortcut.
    $('library').classList.toggle('active', mode === 'tasks' && !taskId);
    $('overview').classList.toggle('active', consoleOpen);
    $('schedules').classList.toggle('active', mode === 'schedules');
    document.querySelectorAll('[data-air-view]').forEach(button => button.classList.toggle('active', button.dataset.airView === mode));
    if (adminModes.has(mode)) {
      const heading = adminHeadings[mode] || ['MultiCC Air › 系统工具', mode, ''];
      $('task-breadcrumb').textContent = heading[0];
      $('task-title').textContent = heading[1];
      $('task-state').textContent = heading[2];
    } else if (mode === 'library') {
      $('task-breadcrumb').textContent = 'MultiCC Air';
      $('task-title').textContent = '工作目录';
      $('task-state').textContent = '按名称或路径切换项目；最多收藏五个。';
    } else if (mode === 'schedules') {
      $('task-breadcrumb').textContent = 'MultiCC Air › 自动运行';
      $('task-title').textContent = '定时任务';
      $('task-state').textContent = '时间规则与固定任务分离；所有运行继续写入同一任务。';
    } else if (taskId) {
      $('task-breadcrumb').textContent = `目录库 › ${dir?.name || '工作目录'} › 任务`;
      $('task-title').textContent = selectedEntry?.task.title || '正在读取任务…';
      if (selectedEntry) renderStateSummary($('task-state'), taskStateSegments(selectedEntry));
      else $('task-state').textContent = '正在读取本轮、任务与资源状态…';
    } else {
      $('task-breadcrumb').textContent = 'MultiCC Air › 工作目录';
      $('task-title').textContent = dir?.name || '先添加工作目录';
      $('task-state').textContent = dir?.path || '添加目录后即可创建任务。';
    }
    for (const id of ['quick-merge', 'quick-auto-commit', 'quick-share',
      'details-toggle', 'chat-more']) $(id).hidden = !taskId;
    $('task-state').disabled = !taskId;
    if (!taskId) { $('task-state').classList.remove('attention'); $('task-state').removeAttribute('title'); }
    // 「正在跑」这件事，页头也是需要说清的地方之一：当前这条任务在跑的时候，
    // 标题下面那行状态和侧栏、控制台用的是同一个圈。
    const openTask = taskId ? (data?.tasks || []).find(task => task.id === taskId) : null;
    applyRing($('task-state'), isRunningTask(openTask));
    renderComposerControls();
  }

  function render() {
    if (!data) return;
    if (!directoryId && taskId) directoryId = data.tasks.find(task => task.id === taskId)?.dirId;
    if (!directoryId || !data.directories.some(directory => directory.id === directoryId)) directoryId = data.directories[0]?.id || null;
    const dir = data.directories.find(directory => directory.id === directoryId);
    $('directory-name').textContent = dir?.name || '先添加工作目录';
    $('directory-path').textContent = dir?.path || '';
    $('create').disabled = !dir;
    $('favorite').disabled = !dir;
    $('favorite').textContent = favorites.includes(directoryId) ? '★' : '☆';
    // 有活在跑的目录也带圈：不必切过去才知道那个目录正忙。
    const busy = runningDirectories();
    applyRing(document.querySelector('.space-card'), busy.has(directoryId));
    $('favorites').replaceChildren(...data.directories.filter(directory => favorites.includes(directory.id)).slice(0, 5).map(directory => {
      const button = node('button', '▣ ' + directory.name, directory.id === directoryId && mode === 'tasks' ? 'selected' : '');
      applyRing(button, busy.has(directory.id));
      button.onclick = () => navigate(directory.id);
      return button;
    }));
    renderHeader(dir);
    renderDirectories();
    renderDirectoryOverview();
    const adminMode = adminModes.has(mode);
    $('task-sidebar').hidden = adminMode;
    document.querySelector('.favorite-caption').hidden = adminMode;
    $('favorites').hidden = adminMode;
    $('directory-library').hidden = mode !== 'library';
    $('admin-center').hidden = !adminMode;
    $('schedule-center').hidden = mode !== 'schedules';
    $('task-layout').hidden = mode === 'library' || mode === 'schedules' || adminMode;
    // Page actions ride in the header (see air.html): one heading band per view.
    $('add-directory').hidden = mode !== 'library';
    $('schedule-create').hidden = mode !== 'schedules';
    $('directory-open-planner').hidden = $('task-layout').hidden || !!taskId;
    $('admin-actions').hidden = !adminMode;
    if (adminMode) window.MultiCCAirAdmin?.render(mode, adminContext());

    // 面板状态由 render 统一落到 DOM 上：直接打开 /air?view=overview（/manage
    // 就落在这儿）时，状态是从地址里读出来的，没有谁调过 setConsole。
    applyConsole(consoleOpen);

    // 原来挂在「跨目录活动」上的那条常驻信号，现在挂在控制台入口上：不展开
    // 面板也知道别的目录有事在等我。
    const urgent = urgentTasks();
    $('console-badge').hidden = !urgent.length;
    $('console-badge').textContent = urgent.length ? String(urgent.length) : '';

    const tasks = visibleTasks();
    $('task-list-title').textContent = '最近任务';
    $('task-count').textContent = tasks.length;
    $('tasks').replaceChildren(...tasks.map(task => {
      const elsewhere = task.dirId !== directoryId;
      const button = node('button', null, [task.id === taskId ? 'selected' : '', elsewhere ? 'elsewhere' : ''].filter(Boolean).join(' '));
      applyRing(button, isRunningTask(task));
      // 一行三件事实：状态徽标（图标 + 中文，来自注册表）、标题、然后是这条记录
      // 的类型/阶段/资源去向。目录作为标签跟在同一行里 —— 「最近」这条带子本来就
      // 是跨目录的（我打开过的任务 + 当前目录的几个），所以每一行都自报家门，
      // 而不是只给「不在当前目录」的那几行加标记：一份一半带标签一半不带的列表，
      // 读的人得先知道哪一半是什么规则。
      const meta = node('small', null, 'task-meta');
      meta.append(statusBadge(task));
      meta.append(node('em', directoryName(task.dirId), 'task-dir'));
      const stage = task.recordType === 'planned' ? `计划 · ${label(task.workflowStage || task.status)}` : '';
      // 徽标已经说过的词不在这里再说一遍（「执行中 · 执行中」不是更多信息）。
      const badgeText = label(taskStatus(task));
      const extra = [stage, holdText(task.resource)].filter(part => part && !badgeText.includes(part)).join(' · ');
      button.append(node('strong', task.title), meta);
      if (extra) button.append(node('small', extra, 'task-note'));
      button.onclick = () => navigate(task.dirId, task.id);
      return button;
    }));
    if (!tasks.length) $('tasks').append(node('small', '还没有打开过任务。这个目录里的任务会出现在这里。', 'empty-list'));

    // 面板打开时才渲染它的内容：控制台不是页面，所以它不是「当前视图」。
    if (consoleOpen) {
      $('console-here').textContent = dir ? `· 当前 ${dir.name}` : '';
      $('console-close').textContent = taskId ? '返回任务' : '关闭控制台';
      window.MultiCCAirAdmin?.render('overview', adminContext());
    }
    $('legacy-sessions').replaceChildren(...data.sessions.filter(session => session.kind === 'terminal' && session.dirId === directoryId).map(session => {
      const link = node('a', `›_ ${session.label}`);
      link.href = `/?id=${encodeURIComponent(session.id)}`;
      return link;
    }));

    const hasTask = !!taskId;
    $('empty').hidden = hasTask;
    $('conversation').hidden = !hasTask;
    if (!hasTask) {
      $('conversation').removeAttribute('src');
      $('delivery-card').hidden = true;
      closeDetails();
    } else {
      // Task identity is resolved by chat-task-boot, but rendering stays on the
      // original full Chat page. Air only supplies a compact light theme.
      const target = `/chat.html?task=${encodeURIComponent(taskId)}&air=1`;
      if ($('conversation').getAttribute('src') !== target) $('conversation').src = target;
    }
  }

  // 页头那行状态在手机上是跟标题挤同一行的：「任务 进行中」这一段让位，留下
  // 「本轮 …」和「归属待核验」。所以分段返回，由 CSS 决定窄屏藏哪一段；
  // taskStateText 留给需要一整句的地方。
  function taskStateSegments(value) {
    const unstartedPlan = value.task?.recordType === 'planned' && !value.messages?.length
      && !value.execution?.busy && !value.execution?.pending;
    const execution = unstartedPlan ? '计划待执行'
      : label(value.execution?.pending ? 'waiting' : value.execution?.status || (value.execution?.busy ? 'running' : 'idle'));
    const lifecycle = label(value.task?.status || value.status);
    return [execution && `本轮 ${execution}`, lifecycle && `任务 ${lifecycle}`].filter(Boolean);
  }

  function taskStateText(value) {
    return taskStateSegments(value).join(' · ');
  }

  // 分隔符跟着段一起走（「 · 任务 进行中」），藏掉一段时不会留下一个孤零零的「·」，
  // 而且整条的 textContent 仍然和 join(' · ') 一字不差。
  const STATE_CLASSES = ['ts-run', 'ts-life'];
  function renderStateSummary(button, segments, classes = STATE_CLASSES) {
    button.replaceChildren(...segments.filter(Boolean).map((text, index) =>
      node('span', index ? ` · ${text}` : text, classes[index] || null)));
  }

  function detailGroup(title, rows) {
    const section = node('section', null, 'detail-group');
    const heading = node('h3', title);
    const list = node('dl');
    for (const [key, value] of rows) list.append(node('dt', key), node('dd', value || '—'));
    section.append(heading, list);
    return section;
  }

  async function reconcileDelivery() {
    if (!taskId) return;
    const buttons = [...document.querySelectorAll('[data-action="reconcile"]')];
    buttons.forEach(button => { button.disabled = true; });
    try {
      await api(`/api/air/tasks/${encodeURIComponent(taskId)}/delivery/reconcile`, {});
      await refreshEntry();
      notice('合并记录已重新核验；任务归属仍以完整交付条件为准。');
    } catch (error) { notice(error.message); }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  }

  function actionButton(text, action, name) {
    const button = node('button', text);
    button.type = 'button';
    if (name) button.dataset.action = name;
    button.onclick = action;
    return button;
  }

  function renderDelivery(value) {
    const attribution = value.attribution || {};
    const candidate = attribution.candidate;
    const run = attribution.run;
    const integration = attribution.integration;
    const capacity = value.resource?.capacityReason;
    const pending = value.execution?.pending;
    const executionStatus = value.execution?.status || (value.execution?.busy ? 'running' : 'idle');
    const running = value.execution?.busy || ['starting', 'running', 'queued'].includes(executionStatus);
    const failed = ['error', 'failed', 'cancelled'].includes(executionStatus);
    const unstartedPlan = value.task?.recordType === 'planned' && !value.messages?.length && !run;
    const currentTitle = value.task.title;
    const targetTitle = candidate?.title || candidate?.taskName || '建议任务';
    const card = $('delivery-card');
    card.hidden = false;

    let eyebrow = 'MULTICC · 本轮状态';
    let title = '本轮状态已记录';
    let text = '任务保持当前归属，可以继续输入下一步。';
    let stage = 0;
    let currentStep = false;
    if (run?.outcome === 'succeeded' && !run.pendingInput) stage = 1;
    if (integration) stage = 2;
    if (integration?.baselineCurrent) stage = 3;

    if (capacity) {
      eyebrow = 'MULTICC · 执行资源';
      title = `${label(capacity)} · 现有工作现场正在保留`;
      text = '消息已绑定当前任务；资源可用后继续，不会停止其他服务或删除未交付修改。';
    } else if (pending) {
      eyebrow = 'MULTICC · 等待回答';
      title = '本轮需要你的回答';
      text = '回答仍提交给原任务与原请求，不会因为归属建议改变目标。';
    } else if (candidate?.state === 'stale') {
      eyebrow = 'MULTICC · 归属建议未应用';
      title = '本次归属建议已过期';
      text = '你已继续输入或切换视图，迟到的分类与合并事件不会改投已经接受的消息。';
    } else if (candidate && running) {
      eyebrow = 'MULTICC · 本轮执行中';
      title = '归属将在本轮交付后确认';
      text = `可能关联「${targetTitle}」，当前仍在「${currentTitle}」中执行。`;
      currentStep = true;
    } else if (candidate && (run?.outcome !== 'succeeded' || run?.pendingInput)) {
      eyebrow = 'MULTICC · 尚未满足归属条件';
      title = '本轮未成功或仍需回答';
      text = `建议目标仍是「${targetTitle}」，原问题继续绑定当前任务。`;
      currentStep = true;
    } else if (candidate && !integration) {
      eyebrow = 'MULTICC · 本轮成功，等待交付';
      title = `建议归入「${targetTitle}」`;
      text = '执行成功不等于任务完成或归属生效；相关代码按项目流程交付后再核验。';
      currentStep = true;
    } else if (candidate && !integration?.baselineCurrent) {
      eyebrow = 'MULTICC · 交付记录待核验';
      title = `建议归入「${targetTitle}」`;
      text = '已有合并记录，但基分支状态发生变化；重新核验前保持当前任务。';
      currentStep = true;
    } else if (candidate) {
      eyebrow = 'MULTICC · 交付已核验';
      title = `建议归入「${targetTitle}」· 等待源现场稳定`;
      text = '代码交付已核验；持续停写屏障与原子归属尚未完成，不提前转移工作区或消息。';
      currentStep = true;
    } else if (running) {
      eyebrow = 'MULTICC · 本轮执行中';
      title = '任务正在当前工作目录执行';
      text = '本轮结果、代码交付与任务完成会分别记录；执行期间下一条消息仍发送到当前任务。';
      currentStep = true;
    } else if (failed || (run && run.outcome !== 'succeeded')) {
      eyebrow = 'MULTICC · 本轮未成功';
      title = '任务保持进行中';
      text = '失败、取消或等待回答都不会被误写成任务完成，后续可以在当前任务重试或继续。';
    } else if (run) {
      eyebrow = 'MULTICC · 本轮结果';
      title = integration ? '本轮成功，交付记录已保存' : '本轮成功，任务仍保持当前归属';
      text = integration ? '代码交付与任务生命周期分别记录；完成一轮不会自动勾掉任务。' : '如果包含代码修改，仍需按项目流程完成交付。';
    } else {
      eyebrow = unstartedPlan ? 'MULTICC · 计划任务' : 'MULTICC · 等待下一步';
      title = unstartedPlan ? '计划尚未执行' : '任务已就绪';
      text = unstartedPlan
        ? '任务说明与验收标准已保存在计划卡中；发送第一条消息后才开始执行。'
        : '新消息将继续发送到当前任务；首次执行时才会准备所需工作目录。';
    }

    $('delivery-eyebrow').textContent = eyebrow;
    $('delivery-title').textContent = title;
    $('delivery-text').textContent = text;
    const summary = $('task-state');
    const attention = !!(capacity || pending || candidate || failed);
    summary.classList.toggle('attention', attention);
    renderStateSummary(summary, [...taskStateSegments(value),
      capacity ? label(capacity) : candidate ? '归属待核验' : ''], [...STATE_CLASSES, 'ts-attn']);
    summary.title = `${title}。${text} 点击查看详情。`;
    $('delivery-destination').textContent = `下一条消息仍发送到「${currentTitle}」`;
    const steps = [...$('delivery-steps').children];
    steps.forEach((step, index) => {
      step.classList.toggle('done', index < stage);
      step.classList.toggle('current', currentStep && index === stage);
    });
    const actions = [];
    if (integration) actions.unshift(actionButton('重新核验交付', reconcileDelivery, 'reconcile'));
    $('delivery-actions').replaceChildren(...actions);
  }

  function renderDetails(value) {
    const attribution = value.attribution || {};
    const roleText = value.roleBindings
      ? (value.roleBindings.bindings.map(binding => binding.name).join('、') || '无附加角色') + ` · 版本 ${value.roleBindings.version}`
      : value.configuration.rolePresetId || '本任务配置';
    const groups = [
      detailGroup('计划与任务生命周期', [
        ['任务 ID', value.task.id],
        ['任务类型', value.task.recordType === 'planned' ? '计划任务' : '执行任务'],
        ['工作阶段', value.task.recordType === 'planned' ? label(value.task.workflowStage) || '待处理' : '—'],
        ['任务状态', label(value.task.status || value.status)],
        ['访问方式', value.readOnly ? '只读；可显式 fork' : '可继续执行'],
      ]),
      detailGroup('代码与交付', [
        ['本轮结果', attribution.run ? `${label(attribution.run.outcome)}${attribution.run.pendingInput ? ' · 等待回答' : ''}` : '尚无已核验的本轮结果'],
        ['代码版本', attribution.run?.codeObserved ? '已观测最终版本' : '尚未核实'],
        ['交付状态', attribution.integration ? (attribution.integration.baselineCurrent ? '已合入基分支，版本有效' : '有合并记录，等待重新核验') : '尚无覆盖本轮代码的合并凭证'],
      ]),
      detailGroup('角色与上下文', [
        ['角色附件', roleText],
        ['生效边界', '修改只影响下一条新消息'],
        ['原生上下文', '角色变化时续接任务历史，不更换工作区'],
      ]),
      detailGroup('执行资源', [
        ['目录', value.resource.path || '首次执行时准备'],
        ['分支', value.resource.branch || '尚未创建'],
        ['资源状态', resourceText(value.resource)],
        ['运行来源', value.sessionId],
      ]),
    ];
    if (value.task.description || value.task.acceptanceCriteria) {
      const plan = node('div', null, 'detail-plan-copy');
      if (value.task.description) plan.append(node('strong', '任务说明'), node('p', value.task.description));
      if (value.task.acceptanceCriteria) plan.append(node('strong', '验收标准'), node('p', value.task.acceptanceCriteria));
      groups[0].append(plan);
    }
    const blockers = candidateBlockers(value);
    if (blockers.length) {
      const list = node('ul');
      blockers.forEach(reason => list.append(node('li', blockerNames[reason] || reason)));
      groups[1].append(list);
    }
    const actions = node('div', null, 'detail-actions');
    if (attribution.integration) actions.append(actionButton('重新核验合并记录', reconcileDelivery, 'reconcile'));
    if (value.roleBindings && !value.readOnly) {
      actions.append(actionButton('编辑角色上下文', () => window.MultiCCAirRoles.open({ taskId, roleBindings: value.roleBindings, api, onSaved: refreshEntry })));
    }
    if (actions.childElementCount) groups[groups.length - 1].append(actions);
    $('task-detail-groups').replaceChildren(...groups);
  }

  function candidateBlockers(value) {
    return value.attribution?.candidate ? value.attribution.candidate.blockers || value.attribution.blockers || [] : [];
  }

  // AI 配置 and 角色 render on the composer card inside the frame (see
  // chat-air.css). Their state, dialogs and handlers stay here in the host —
  // the frame only supplies the surface, so nothing about configuring a task
  // is duplicated in two pages. Frames reload per task, so the handler is
  // bound once per document and the labels are re-rendered on every sync.
  let frameComposerBound = null;
  // The strip is built here rather than in chat.html: it only exists while Air
  // hosts the page, and chat.html sits exactly on its migration line ceiling.
  function ensureComposerRow(doc) {
    const existing = doc.getElementById('air-composer-meta');
    if (existing) return existing;
    const input = doc.getElementById('input-bar');
    if (!input) return null;
    const row = doc.createElement('div');
    row.id = 'air-composer-meta';
    row.className = 'mc-composer__aux';
    row.hidden = true;
    for (const id of ['air-ai-pill', 'air-role-pill']) {
      const pill = doc.createElement('button');
      pill.id = id;
      pill.type = 'button';
      pill.hidden = true;
      row.append(pill);
    }
    input.before(row);
    return row;
  }

  function composerControls() {
    const doc = $('conversation').contentDocument;
    if (!doc) return null;
    const row = ensureComposerRow(doc);
    const ai = doc.getElementById('air-ai-pill');
    const role = doc.getElementById('air-role-pill');
    if (!row || !ai || !role) return null;
    return { doc, row, ai, role };
  }

  // The band above the composer card only exists while it has something to say:
  // an empty one would paint its tint over the card's rounded top. The card is
  // told through a modifier class, so the two still read as one box.
  function setComposerBand(doc, row, shown) {
    row.hidden = !shown;
    doc.getElementById('input-bar')?.classList.toggle('mc-composer--with-aux', shown);
  }

  function renderComposerControls() {
    const controls = composerControls();
    if (!controls) return;
    const { doc, row, ai, role } = controls;
    if (!taskId) {
      ai.hidden = true;
      role.hidden = true;
      setComposerBand(doc, row, false);
      return;
    }
    const pending = entry?.configuration?.pendingConfiguration;
    const shown = pending
      ? { ...entry.configuration, ...(pending.profile || {}), cli: pending.cli || entry.configuration.cli }
      : entry?.configuration;
    // `shown` is undefined for a task that carries no configuration at all — a
    // missing field must not take the whole render down with it, so every read
    // goes through `?.`.
    const routeName = shown?.providerSelection?.mode === 'auto'
      ? `Auto ${shown.providerSelection.protocol}`
      : (pending ? shown?.provider : shown?.providerName || shown?.provider) || '默认线路';
    ai.hidden = !entry?.sessionId;
    ai.disabled = !entry || entry.readOnly;
    ai.textContent = shown
      ? [shown.cli, routeName,
        (pending ? shown.model : shown.effectiveModel || shown.model) || '默认模型',
        pending ? '下轮生效' : ''].filter(Boolean).join(' · ')
      : '';
    ai.title = '任务 AI 配置：CLI、路由与模型（下一轮生效）';
    const roleCount = entry?.roleBindings?.bindings?.length || 0;
    role.hidden = !entry?.roleBindings;
    role.disabled = !entry || entry.readOnly;
    role.textContent = roleCount ? `${roleCount} 个角色` : '＋ 角色';
    role.title = '任务角色上下文';
    setComposerBand(doc, row, !ai.hidden || !role.hidden);
  }

  function bindComposerControls() {
    const controls = composerControls();
    if (!controls || frameComposerBound === controls.doc) return;
    frameComposerBound = controls.doc;
    controls.ai.onclick = () => {
      if (entry?.sessionId && !entry.readOnly) window.MultiCCAirSettings.configuration(entry, data.clis, refreshEntry);
    };
    controls.role.onclick = () => {
      if (entry?.roleBindings && !entry.readOnly) {
        window.MultiCCAirRoles.open({ taskId, roleBindings: entry.roleBindings, api, onSaved: refreshEntry });
      }
    };
  }

  // Draft restore + listener binding happen once per input element. syncFrame
  // also runs from the 4s poll loop; re-running it there restored a stale
  // draft into the freshly cleared input right after a send (the composer's
  // programmatic clear fires no input event, so the stored draft survived).
  let frameInputSynced = null;
  let frameInputSyncedTask = null;
  let frameInputHandler = null;
  function syncFrame() {
    const doc = $('conversation').contentDocument;
    bindComposerControls();
    renderComposerControls();
    syncQuickActions();
    const input = doc?.getElementById('input') || doc?.getElementById('message');
    if (!taskId || !input) return;
    // Rebind on element change (frame reload) AND on task change: right after
    // a task switch the old document can still be live for a poll tick, and
    // binding the new task's draft listener to that stale input would write
    // keystrokes to the wrong task's draft key. The handler reads `taskId`
    // live, so re-binding first detaches the previous one to avoid stacking.
    if (frameInputSynced !== input || frameInputSyncedTask !== taskId) {
      if (frameInputSynced && frameInputHandler) frameInputSynced.removeEventListener('input', frameInputHandler);
      frameInputSynced = input;
      frameInputSyncedTask = taskId;
      const draft = sessionStorage.getItem(`air:draft:${taskId}`);
      if (draft != null && !input.value) input.value = draft;
      frameInputHandler = () => sessionStorage.setItem(`air:draft:${taskId}`, input.value);
      input.addEventListener('input', frameInputHandler, { passive: true });
    }
    if (entry?.task?.title) {
      const unstartedPlan = entry.task.recordType === 'planned' && !entry.messages?.length;
      input.placeholder = unstartedPlan
        ? `补充或开始执行「${entry.task.title}」…`
        : `继续描述「${entry.task.title}」的下一步…`;
    }
  }

  async function refreshEntry() {
    const selected = taskId;
    if (!selected) return;
    try {
      const result = await api(`/api/air/tasks/${encodeURIComponent(selected)}`);
      if (taskId !== selected) return;
      entry = result;
      // 直接打开一个任务（书签、通知链接、刷新）和从列表里点进去一样，都是「打开过」。
      // 不在这儿记一笔，「最近」在刚进页面时就是空的。只有排序真的变了才重画。
      if (recentTaskIds[0] !== selected) { rememberTask(selected); render(); }
      $('task-title').textContent = entry.task.title;
      $('task-state').textContent = taskStateText(entry);
      renderDelivery(entry);
      renderDetails(entry);
      syncFrame();
    } catch (error) {
      if (taskId === selected) notice(error.message);
    }
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    try {
      data = await api('/api/air');
      notice(data.migration?.errors?.length ? `有 ${data.migration.errors.length} 份历史任务等待核验；原记录与工作区均已保留。` : '');
      render();
      await refreshEntry();
      // 控制台概览里有「定时任务」那张卡，面板打开时就把规则取全，不显示陈旧数字。
      if (mode === 'schedules' || consoleOpen) await refreshSchedules();
      if (consoleOpen) window.MultiCCAirAdmin?.render('overview', adminContext());
    } catch (error) { notice(error.message); }
    finally { loading = false; }
  }

  function adminContext() {
    return {
      data, scheduleTasks, api, setMode, navigate, notice, directoryName,
      // 中文词表只有一份（stateNames）：面板要说的状态词跟侧栏是同一批，
      // 传下去比在 air-admin.js 里再抄一份可靠。
      label,
      openConsole: () => setConsole(true),
      closeConsole: () => setConsole(false),
    };
  }

  window.MultiCCAirAdmin?.bindServiceDialog(adminContext());
  // The sidebar card is the current directory, so it opens that directory's own
  // task page — the full directory library stays on ⌘K and 控制台 › 浏览工作目录.
  $('library').onclick = () => (directoryId ? navigate(directoryId) : setMode('library'));
  $('overview').onclick = () => setConsole(!consoleOpen);
  $('console-close').onclick = () => setConsole(false);
  $('console-scrim').onclick = () => setConsole(false);
  $('palette-scrim').onclick = () => closePalette();
  $('palette-input').oninput = () => { paletteIndex = 0; renderPalette(); };
  $('schedules').onclick = () => setMode('schedules');
  document.querySelectorAll('[data-air-view]').forEach(button => { button.onclick = () => setMode(button.dataset.airView); });
  $('directory-search').oninput = renderDirectories;
  // Refreshing means reloading what the page is showing. The conversation lives
  // in a frame of its own, so reloading it is a partial reload of this page: the
  // frame boots again, re-fetches its messages and re-establishes its socket,
  // while the host's own state and navigation stay where they are. Reconnecting
  // the socket alone would only replay deltas onto a DOM that may have drifted —
  // which is why the frame's own ↻ is hidden here (chat-air.css).
  function reloadConversation() {
    const frame = $('conversation');
    if (!taskId || !frame || frame.hidden) return;
    try { frame.contentWindow?.location.reload(); }
    catch (error) { notice(`刷新会话失败：${error.message}`); }
  }
  $('refresh').onclick = async () => {
    await refresh();
    if (adminModes.has(mode)) await window.MultiCCAirAdmin?.refresh(adminContext());
    reloadConversation();
  };
  $('favorite').onclick = () => {
    if (!directoryId) return;
    if (favorites.includes(directoryId)) favorites = favorites.filter(id => id !== directoryId);
    else if (favorites.length < 5) favorites.push(directoryId);
    else return notice('侧栏最多收藏 5 个目录，其余目录仍可从目录库搜索。');
    localStorage.setItem('air:favorites', JSON.stringify(favorites));
    render();
  };
  $('mobile-nav').onclick = toggleNav;
  $('nav-scrim').onclick = closeNav;
  $('task-options').onclick = toggleOptions;
  // 点里面的哪一件工具都算用过了：浮层再晾在那儿，只会挡住它刚刚改的那一屏 ——
  // 「更多」还会在对话帧里开自己的菜单，两层叠着更乱。用捕获阶段收：那件工具自己
  // 的处理器会 stopPropagation（#chat-more 就是），冒泡到这里就晚了。
  $('task-tools').addEventListener('click', closeOptions, true);
  document.addEventListener('click', event => {
    if (event.target.closest?.('#task-header')) return;
    closeOptions();
  });
  // 对话是一整个 iframe：在它里面点的、划的都不会冒泡到这一份 document。不补这一
  // 手，浮层会一直挂着，挡住手指真正在动的那一屏。
  function dismissOnFrame() {
    const frame = $('conversation');
    try {
      frame.contentDocument?.addEventListener('pointerdown', closeOptions, true);
      frame.contentDocument?.addEventListener('click', closeOptions, true);
    } catch { /* 跨源时读不到，浮层就只认外面这一份 document */ }
  }
  $('conversation').addEventListener('load', dismissOnFrame);
  dismissOnFrame();
  // 回到桌面宽度，工具又摆回那一行（浮层的样式只在 760px 以下生效）。留着这个类
  // 会让下一次变窄时菜单凭空弹出来。
  matchMedia('(min-width: 761px)').addEventListener('change', event => { if (event.matches) closeOptions(); });
  $('add-directory').onclick = () => window.MultiCCAirSettings.directory(async directory => { await refresh(); navigate(directory.id); });
  $('directory-open-planner').onclick = () => setMode('planner');
  $('quick-task-form').onsubmit = submitQuickTask;
  $('quick-task-attach').onclick = () => $('quick-task-file-input').click();
  $('quick-task-file-input').onchange = event => void uploadQuickTaskFiles(event.target.files);
  $('quick-task-mic').onclick = () => void toggleQuickDictation();
  $('quick-task-goal').onchange = renderQuickGoalLimits;
  $('quick-ai-pill').onclick = openQuickConfiguration;
  $('quick-role-pill').onclick = openQuickRoles;
  $('quick-task-input').onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('quick-task-form').requestSubmit();
    }
  };
  // Attachments arrive the same three ways the chat composer accepts them:
  // the button, a paste, or a drop anywhere on the card.
  $('quick-task-input').addEventListener('paste', event => {
    const files = event.clipboardData?.files;
    if (files?.length) { event.preventDefault(); void uploadQuickTaskFiles(files); }
  });
  {
    const form = $('quick-task-form');
    form.addEventListener('dragover', event => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault();
      form.classList.add('is-dropping');
    });
    form.addEventListener('dragleave', event => {
      if (!form.contains(event.relatedTarget)) form.classList.remove('is-dropping');
    });
    form.addEventListener('drop', event => {
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      event.preventDefault();
      form.classList.remove('is-dropping');
      void uploadQuickTaskFiles(files);
    });
  }
  // The task header keeps the two or three actions that get used every round.
  // Each one clicks the chat page's own button, so its handler, its permission
  // check and its dialog stay in the frame; only the state readout (auto-commit
  // on/off, merge ready) is mirrored back onto the header icon.
  let quickSyncTimer = null;
  function frameButton(id) {
    return $('conversation').contentDocument?.getElementById(id) || null;
  }
  function syncQuickActions() {
    const source = frameButton('auto-commit-btn');
    const auto = $('quick-auto-commit');
    const on = source?.dataset.state === 'on';
    auto.classList.toggle('is-on', on);
    auto.setAttribute('aria-pressed', String(on));
    const merge = frameButton('merge-btn');
    const ready = merge?.classList.contains('merge-ready') === true;
    const mergeAction = $('quick-merge');
    mergeAction.classList.toggle('is-ready', ready);
    if (merge?.title) mergeAction.title = merge.title;
  }
  function clickFrameAction(sourceId) {
    frameButton(sourceId)?.click();
    // The toggle PATCHes and the merge check re-reads status asynchronously;
    // re-mirror shortly after so the icon does not lag the state by a poll.
    clearTimeout(quickSyncTimer);
    quickSyncTimer = setTimeout(syncQuickActions, 600);
  }
  $('quick-merge').onclick = () => clickFrameAction('merge-btn');
  $('quick-auto-commit').onclick = () => clickFrameAction('auto-commit-btn');
  $('quick-share').onclick = () => clickFrameAction('share-btn');
  $('details-toggle').onclick = () => toggleDetails();
  // The conversation frame's chat page owns the More menu (items, handlers,
  // popover layer). The task-header trigger just reaches into that same-origin
  // frame to open/close it; the menu anchors itself to the frame's top-right,
  // visually dropping from this header.
  function frameMoreController() {
    return $('conversation').contentWindow?.__multiccAirHeaderMore || null;
  }
  $('chat-more').onclick = event => {
    event.stopPropagation();
    const controller = frameMoreController();
    if (!controller) return;
    const wasOpen = controller.isOpen?.() === true;
    if (wasOpen) controller.close();
    else controller.open();
    $('chat-more').setAttribute('aria-expanded', String(!wasOpen));
  };
  document.addEventListener('click', event => {
    if (event.target.closest('#chat-more')) return;
    const controller = frameMoreController();
    if (controller?.close) controller.close();
    $('chat-more').setAttribute('aria-expanded', 'false');
  });
  $('task-state').onclick = () => toggleDetails();
  $('details-close').onclick = closeDetails;
  $('schedule-create').onclick = () => openScheduleDialog();
  $('schedule-close').onclick = () => $('schedule-dialog').close();
  $('schedule-cancel').onclick = () => $('schedule-dialog').close();
  $('schedule-form').onsubmit = saveSchedule;
  $('schedule-presets').onclick = event => {
    const preset = event.target.closest('[data-cron]');
    if (preset) $('schedule-form').elements.cron.value = preset.dataset.cron;
  };
  $('create').onclick = () => {
    if (!data || !directoryId) return;
    $('create-directory').textContent = data.directories.find(directory => directory.id === directoryId)?.path || '';
    $('cli').replaceChildren(...data.clis.map(cli => {
      const option = node('option', cli);
      option.value = cli;
      return option;
    }));
    $('new-task-dialog').showModal();
  };
  $('close-dialog').onclick = () => $('new-task-dialog').close();
  $('new-task-form').onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    if (!values.model) delete values.model;
    if (!values.rolePrompt) delete values.rolePrompt;
    const fingerprint = JSON.stringify([directoryId, values]);
    if (!createAttempt || createAttempt.fingerprint !== fingerprint) createAttempt = { fingerprint, clientMsgId: crypto.randomUUID() };
    $('create-submit').disabled = true;
    $('create-error').textContent = '';
    try {
      const result = await api('/api/air/tasks', { dirId: directoryId, ...values, clientMsgId: createAttempt.clientMsgId });
      createAttempt = null;
      $('new-task-dialog').close();
      event.target.reset();
      await refresh();
      navigate(directoryId, result.taskId);
    } catch (error) { $('create-error').textContent = error.message; }
    finally { $('create-submit').disabled = false; }
  };
  $('conversation').onload = syncFrame;
  window.addEventListener('keydown', event => {
    // ⌘K 是「去某个地方」的入口：目录和任务一起搜，不用先想起来在哪个目录。
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (paletteOpen) closePalette(); else openPalette();
      return;
    }
    if (paletteOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        paletteIndex = Math.min(Math.max(paletteIndex + step, 0), Math.max(paletteItems.length - 1, 0));
        renderPalette();
        return;
      }
      if (event.key === 'Enter') { event.preventDefault(); choosePalette(); return; }
    }
    if (event.key === 'Escape') {
      // 一层一层地退：先收浮层，再收导航与详情。
      if (paletteOpen) { closePalette(); return; }
      if (consoleOpen) { setConsole(false); return; }
      if ($('task-header').classList.contains('options-open')) { closeOptions(); return; }
      closeNav(); closeDetails(); frameMoreController()?.close(); $('chat-more').setAttribute('aria-expanded', 'false');
    }
  });
  window.addEventListener('popstate', () => {
    saveDraft();
    const params = new URLSearchParams(location.search);
    taskId = params.get('task');
    directoryId = params.get('dir');
    mode = modeFrom(params);
    entry = null;
    closeDetails();
    closePalette();
    // 后退/前进要如实反映地址：?view=overview 就是「控制台开着」。
    applyConsole(params.get('view') === 'overview');
    render();
    void refreshEntry();
    if (mode === 'schedules' || consoleOpen) void refreshSchedules().then(render);
  });
  window.addEventListener('pagehide', () => { saveDraft(); stopped = true; epoch++; clearTimeout(timer); });
  window.addEventListener('pageshow', event => {
    if (event.persisted) { stopped = false; epoch++; void poll(); }
  });

  async function poll(currentEpoch = epoch) {
    if (stopped || currentEpoch !== epoch) return;
    if (!document.hidden || !data) await refresh();
    if (!stopped && currentEpoch === epoch) timer = setTimeout(() => poll(currentEpoch), 4000);
  }
  void poll();
})();
