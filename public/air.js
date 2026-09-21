(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  // 内置官方供应商的名字（'Codex 官方'）是服务端写进 provider 记录的**数据**，
  // 前端按身份在渲染时翻译，历史记录里的中文才不会再漏出来；见
  // public/provider-catalog.js。catalog 没加载时原样返回，不至于把药丸打空。
  const providerDisplayName = name => {
    const api = window.MultiCCProviderCatalog;
    return api && api.providerDisplayName ? api.providerDisplayName(name) : name;
  };
  function readRouteParams() {
    const params = new URLSearchParams(location.search);
    // Retired planner bookmarks open the current console, including on an
    // already-running server that still has the old /manage redirect loaded.
    if (params.get('view') === 'planner') {
      params.set('view', 'overview');
      history.replaceState(history.state, '', `${location.pathname}?${params}${location.hash}`);
    }
    return params;
  }
  const initialParams = readRouteParams();
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
  // Pin 住的任务（服务端 air-pins.json 那份清单，顺序就是页头那排收藏栏从左到右的
  // 顺序）。页头那条横排和手机上侧栏的置顶读的都是它，写只有一条路：togglePin。
  let taskPins = [];
  let pinSignature = '';
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
  // 轮询是本页面唯一的数据来源（Air 没有 WebSocket），所以只能靠「有没有变」
  // 决定要不要重画。服务端给两个读接口算 ETag；内容没变时回 304，这里就完全
  // 跳过解析与 DOM 重建。刷新失败时指数退避，别在服务端打嗝时继续每 4 秒敲。
  const resourceEtag = new Map();
  let pollFailures = 0;
  const POLL_MS = 4000;
  // 任务完成/出错未读提醒：统一事件源，三处消费（侧边栏未读高亮、语音、浮动条）。
  // 唯一全局实例；openTask 走 navigate（同一路径也负责把未读标记清掉）。
  // statusOf 把 status+runState 折算成与徽标同一份的状态，出错的任务因此也能
  // 进入未读（红色调），而不是只有「已完成」才提醒。
  const taskNotify = window.MultiCCTaskNotify?.create({
    getCurrentTaskId: () => taskId,
    openTask: task => navigate(task?.dirId, task?.id),
    statusOf: task => taskStatus(task),
  });
  const POLL_HIDDEN_MS = 15000;
  const POLL_MAX_MS = 30000;
  let quickCreateAttempt = null;
  let directoryTasksExpanded = false;
  const directoryTaskFilter = { query: '', status: 'open' };

  // 状态/阶段/阻断原因的文案一律现取 t()：这些表在 render 的每一行上被读，
  // 而 t() 查不到 key 只会回显 key 本身，所以漏翻是看得见的（不会静默变成中文）。
  const stateNames = {
    active: t('airStateActive'), succeeded: t('airStateSucceeded'), unknown: t('airStateUnknown'), failed: t('airStateFailed'), error: t('airStateFailed'), cancelled: t('airStateCancelled'),
    workspace_execution_capacity: t('airStateExecCapacity'), workspace_resident_capacity: t('airStateResidentCapacity'),
    workspace_restore_capacity: t('airStateRestoreCapacity'), planned: t('airStatePlanned'), resident: t('airStateResident'),
    retained: t('airStateRetained'), hibernated: t('airStateHibernated'), reserved: t('airStateReserved'), materializing: t('airStateMaterializing'),
    starting: t('airStateStarting'), running: t('airStateRunning'), uncertain: t('airStateUncertain'), idle: t('airStateIdle'), queued: t('airStateQueued'),
    waiting: t('airStateWaiting'), archived: t('airStateArchived'), stale: t('airStateStale'),
    // 工作流阶段（src/task-board/planning.js WORKFLOW_STAGES）五个都要有词：任务行
    // 会把阶段当补充信息写在徽标后面，漏一个就有一行蹦出英文。
    inbox: t('airStageInbox'), ready: t('airStageReady'), doing: t('airStateActive'), review: t('airStageReview'), done: t('airStageDone'),
  };
  const blockerNames = {
    view_changed: t('airBlockViewChanged'),
    final_run_result_required: t('airBlockFinalRunResult'),
    run_not_succeeded: t('airBlockRunNotSucceeded'),
    code_observation_required: t('airBlockCodeObservation'),
    integration_receipt_required: t('airBlockIntegrationReceipt'),
    baseline_revalidation_required: t('airBlockBaselineRevalidation'),
    source_writer_barrier_required: t('airBlockSourceWriterBarrier'),
    separation_application_required: t('airBlockSeparationApplication'),
    fork_source_dirty: t('airBlockForkSourceDirty'),
    fork_source_busy: t('airBlockForkSourceBusy'),
    workspace_busy: t('airBlockWorkspaceBusy'),
    separation_barrier_unavailable: t('airBlockBarrierUnavailable'),
    delivery_evidence_unavailable: t('airBlockDeliveryEvidenceUnavailable'),
    separation_application_unavailable: t('airBlockApplicationUnavailable'),
  };
  // 交付进度四步的兜底文案（服务端没给 step.label 时用）。顺序必须和服务端
  // attribution.steps 的语义顺序一致 —— legacyStage 那个下标是按这个顺序算的。
  const DELIVERY_STEP_FALLBACKS = [
    t('airStepTurnSucceeded'), t('airStepCodeDelivered'), t('airStepSourceStable'), t('airStepAttribution'),
  ];

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
  // 「最近」= 我打开过的任务（跨目录，最新在前）。浏览记录不是权限也不是归属，
  // 只是把常用的几个任务放在手边。
  let recentTaskIds = stored('air:recent-tasks', []);
  if (!Array.isArray(recentTaskIds)) recentTaskIds = [];

  // ── 首启配置卡：AI Assistant 配没配，由服务端那份配置说话 ──
  // null = 还没查到（页面刚起或查询失败），false = 未配置（亮卡），true = 已配置。
  // 离开 aux 设置页时重查一次：在那儿保存过之后，这张卡应该当场消失，而不是
  // 等下次刷新。跳过只记在本机 —— 跳过的是「这张卡」，不是「这个配置」。
  let auxConfigured = null;
  let setupDismissed = stored('air:setup-dismissed', false);
  async function refreshAuxConfigured() {
    let config = null;
    try {
      config = await api('/api/aux/config');
      auxConfigured = !!config.providerId;
    } catch (_) { return; }   // 查不到就维持现状，不把卡藏起来也不弹错误
    renderSetupCard();
    void refreshCliMissing(config.cliAvailability);
  }
  // 一个 CLI 都没装时，模型下拉与 AI Assistant 都注定配不成——引导卡直接说清
  // 「至少装一个」并给出官方安装命令，而不是让用户在空下拉里猜。
  async function refreshCliMissing(cliAvailability) {
    const box = $('setup-cli-missing');
    if (!box) return;
    const missing = !!cliAvailability && cliAvailability.claude === false && cliAvailability.codex === false;
    box.hidden = !missing;
    if (!missing) return;
    const code = $('setup-cli-missing-cmds');
    if (!code || code.textContent) return;
    try {
      const info = await api('/api/cli/install-specs');
      const specs = (info && info.specs) || {};
      const cmds = [
        specs.claude && (specs.claude.display || specs.claude.command),
        specs.codex && (specs.codex.display || specs.codex.command),
      ].filter(Boolean);
      code.textContent = cmds.join('   |   ');
    } catch (_) { /* 取不到命令就留空，不打断引导 */ }
  }
  function renderSetupCard() {
    const card = $('setup-card');
    if (card) card.hidden = !(data && auxConfigured === false && !setupDismissed);
  }
  function rememberTask(id) {
    if (!id) return;
    recentTaskIds = [id, ...recentTaskIds.filter(value => value !== id)].slice(0, 12);
    try { localStorage.setItem('air:recent-tasks', JSON.stringify(recentTaskIds)); } catch (_) {}
  }
  // 侧栏的任务区只装「手上的任务」：打开过的排在前面，然后是当前目录里最新的几个。
  // 后一半是必要的 —— 第一次进来没有浏览记录，只有前一半的话列出来是空的，而一条
  // 空列表并不比一条能点的任务更有用。完整的那份列表在控制台（全部目录 + 搜索）。
  //
  // 这个数不再是「一屏能放下几条」，而是「最多往回翻几条」：任务带现在自己吃掉
  // 侧栏剩下的高度并在内部滚动（air.css 的 #tasks），列八条会在下面留一大片空白
  // —— 那个高度本来就是给任务准备的。封顶留着只为挡住真·长尾（一个目录几百条
  // 任务时不去建几百个按钮），所以给得比任何一屏都宽。
  const RECENT_LIMIT = 30;
  // 目录首页的「最近任务」是抬头下面那一块，扫一眼就该看完 —— 它不是清单，全
  // 部记录在控制台（这条出路现在由 `#directory-task-more` 明写出来）。手机上
  // 一列，六行正好一屏多一点；桌面两列，十行五排。再往下加只是把输入框顶得更
  // 远，而多出来的那些本来也排不进「最近」。
  const RECENT_ROWS = 10;
  function recentRowLimit() { return matchMedia('(max-width: 760px)').matches ? 6 : RECENT_ROWS; }
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
  const applyRing = (element, on, seed) => window.MultiCCAirAdmin?.applyRing?.(element, on, seed);
  /** 状态徽标（图标 + 中文标签）。没有注册表时给一句可读的兜底文案。 */
  function statusBadge(task, options) {
    return window.MultiCCAirAdmin?.statusBadge?.(task, options)
      || node('span', label(taskStatus(task)), 'mc-status');
  }

  // `conditional` 只给每 4 秒被问一次的那两个轮询接口用，它们的调用方知道
  // 「没变」是正常结果。通用 api() 绝不能这么干：别的 GET 调用方要的是数据本身，
  // 收到「没变」会当成空数据用。条件请求由客户端显式发起，不依赖浏览器/代理的
  // 缓存行为（这个页面所有 GET 都是 no-store）。
  async function request(path, { method, body, conditional }) {
    const hasBody = body !== undefined;
    const knownEtag = conditional ? resourceEtag.get(path) : null;
    const response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(knownEtag ? { 'If-None-Match': knownEtag } : {}) },
      cache: method === 'GET' ? 'no-store' : 'default',
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
    if (conditional && response.status === 304) return { ok: true, unchanged: true };
    const raw = await response.text();
    let result;
    try { result = raw ? JSON.parse(raw) : {}; }
    catch (_) {
      const message = /<!doctype|<html/i.test(raw)
        ? t('airErrApiNotLoaded')
        : t('airErrBadResponse', { status: response.status });
      throw Object.assign(new Error(message), { code: 'air_invalid_response', status: response.status });
    }
    if (!response.ok || result.ok === false) {
      throw Object.assign(new Error(result.message || result.error || result.code || `HTTP ${response.status}`), result);
    }
    // 校验符记在「这份正文已经被收下」之后：失败响应（Express 也会给错误体配一个
    // ETag）要是被记下来，下一轮就会拿它换回 304 —— 一次失败被固化成永远读不到。
    if (conditional) {
      const etag = response.headers.get('etag');
      if (etag) resourceEtag.set(path, etag);
      else resourceEtag.delete(path);
    }
    return result;
  }

  function api(path, body, requestedMethod = null) {
    return request(path, { method: requestedMethod || (body === undefined ? 'GET' : 'POST'), body, conditional: false });
  }
  const apiConditional = path => request(path, { method: 'GET', body: undefined, conditional: true });

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
        title: directory.name, detail: directory.path || t('airDirectoryFallback'),
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
        title: task.title || t('airUntitledTask'),
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
        node('span', item.kind === 'task' ? t('airKindTask') : t('airKindDirectory'), 'palette-kind'));
      button.onclick = () => choosePalette(index);
      return button;
    }));
    if (!paletteItems.length) $('palette-results').append(node('p', t('airPaletteNoMatch'), 'empty-list'));
    const directories = paletteItems.filter(item => item.kind === 'directory').length;
    $('palette-note').textContent = paletteItems.length
      ? t('airPaletteCounts', { dirs: directories, tasks: paletteItems.length - directories })
      : t('airPaletteSearchHint');
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
    const doc = $('conversation')?.contentDocument;
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
  // `remember:false` 是给侧栏点开那条路留的：那条路要让 MRU 晚一拍再上台（见
  // openSidebarTask），所以先别在这里改顺序 —— 顺序的真相仍然只有 recentTaskIds
  // 一份，晚的是「什么时候写」。
  function navigate(dir, task = null, options = {}) {
    saveDraft();
    // 换台不另写一条历史。从「已经开着对话」再去看另一个任务，只是浮层里换了个人；
    // 要是每换一次都 push，来回对照三个任务之后后退键得按三下才回到目录 —— 而
    // 那三下每一次都只是同一件事。所以只有「从没有对话 → 打开一个任务」才是新
    // 的一步（后退于是正好等于「把浮层关掉」）。airChat 记的是「这一条是我们为了
    // 打开对话推出来的」，dismissChat 靠它决定退回去还是就地改写。
    const wasTask = !!taskId;
    const state = { airChat: !!task };
    if (dir !== directoryId) {
      directoryTasksExpanded = false;
      directoryTaskFilter.query = '';
      directoryTaskFilter.status = 'open';
    }
    directoryId = dir;
    taskId = task;
    mode = 'tasks';
    entry = null;
    // 打开任务即消费触发源：清除侧边栏未读高亮、停语音、收浮动完成条。
    if (task) taskNotify?.markOpened(typeof task === 'object' ? task?.id : task);
    closeDetails();
    if (task && options.remember !== false) rememberTask(task);
    closeOverlays();
    if (options.replace || wasTask) history.replaceState(state, '', routeUrl());
    else history.pushState(state, '', routeUrl());
    closeNav();
    render();
    void refreshEntry();
  }
  function setMode(next) {
    // 控制台不再是一种页面模式：任何还写着 setMode('overview') 的入口都换成
    // 展开这层面板，页面留在原处。
    if (next === 'overview') { setConsole(true); return; }
    saveDraft();
    // 从 AI Assistant 设置页离开时重查配置：刚在那儿保存过的话，首启配置卡
    // 会在这次渲染里自己消失。
    if (mode === 'aux' && next !== 'aux') void refreshAuxConfigured();
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
  // 日期/时间要跟着语言走（zh-CN 的短日期带「月/日」，英文界面里就是残留）。
  // 实现统一放在 i18n.js 的 getLocale()，这里只留个别名，避免两处各写一份。
  const locale = getLocale;
  function directoryName(id) { return data?.directories.find(directory => directory.id === id)?.name || t('airUnknownDirectory'); }

  function renderDirectories() {
    if (!data) return;
    const query = $('directory-search').value.trim().toLowerCase();
    const directories = data.directories.filter(directory => `${directory.name} ${directory.path}`.toLowerCase().includes(query));
    const busy = runningDirectories();
    $('directory-grid').replaceChildren(...directories.map(directory => {
      const button = node('button');
      applyRing(button, busy.has(directory.id), directory.id);
      const taskCount = data.tasks.filter(task => task.dirId === directory.id).length;
      const activeCount = data.tasks.filter(task => task.dirId === directory.id && isRunningTask(task)).length;
      button.append(node('strong', '▣ ' + directory.name), node('small', directory.path),
        node('small', activeCount
          ? t('airDirTaskCountActive', { total: taskCount, active: activeCount })
          : t('airDirTaskCount', { total: taskCount })));
      button.onclick = () => navigate(directory.id);
      return button;
    }));
    if (!directories.length) $('directory-grid').append(node('p', query ? t('airDirNoMatch') : t('airDirNoneYet'), 'empty-list'));
  }

  function renderDirectoryOverview() {
    const dir = data?.directories.find(directory => directory.id === directoryId);
    const tasks = (data?.tasks || []).filter(task => task.dirId === directoryId);
    const current = tasks.filter(task => !['done', 'archived'].includes(task.status));
    const running = current.filter(isRunningTask);
    const planned = current.filter(task => task.recordType === 'planned' && !running.includes(task));
    const stat = (name, value, detail, tone = '') => {
      const card = node('article', null, `directory-stat ${tone}`);
      card.append(node('span', name), node('strong', String(value)), node('small', detail));
      return card;
    };
    $('directory-stats').replaceChildren(
      stat(t('airStateActive'), current.length, t('airDirRunningNow', { n: running.length }), 'blue'),
      stat(t('airDirStatPlanned'), planned.length, t('airDirStatPlannedHint')),
      stat(t('airStageDone'), tasks.filter(task => task.status === 'done').length, t('airDirStatDoneHint'), 'green'),
      stat(t('airStatusAllRecords'), tasks.length, t('airDirArchivedCount', { n: tasks.filter(task => task.status === 'archived').length })),
    );
    const filtered = window.MultiCCAirAdmin?.filterTasks?.(tasks, directoryTaskFilter, () => '')
      || [...tasks].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    const rows = directoryTasksExpanded
      ? filtered
      : [...tasks].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).slice(0, recentRowLimit());
    $('directory-task-heading').textContent = directoryTasksExpanded ? t('airDirAllTasks') : t('airRecentTasks');
    $('directory-overview-count').textContent = directoryTasksExpanded
      ? t('airDirCountOfTotal', { shown: filtered.length, total: tasks.length })
      : t('airDirTaskCount', { total: tasks.length });
    $('directory-task-controls').hidden = !directoryTasksExpanded;
    if ($('directory-task-search').value !== directoryTaskFilter.query) $('directory-task-search').value = directoryTaskFilter.query;
    $('directory-task-status').value = directoryTaskFilter.status;
    document.querySelector('.directory-task-panel')?.classList.toggle('expanded', directoryTasksExpanded);
    $('directory-task-list').replaceChildren(...rows.map(task => {
      const row = node('div', null, 'directory-task-row');
      applyRing(row, isRunningTask(task), task.id);
      const button = node('button', null, 'task-row-open');
      button.type = 'button';
      const copy = node('span');
      const meta = node('small', null, 'task-meta');
      meta.append(statusBadge(task));
      // 阶段只有计划记录才有（`workflowStage` 是计划看板那一列，记录类型由行首那个
      // ◇ 标着）：观察型记录这个字段恒为 null，拿 `status` 兜底写出来的「进行中」是
      // 生命周期词，跟徽标说的不是一回事 —— 徽标「空闲」「执行成功」，旁边一行「进行
      // 中」。同侧栏 `renderSidebarTasks`。
      const stage = task.recordType === 'planned' ? label(task.workflowStage || task.status) : '';
      const detail = holdText(task.resource);
      const extra = [stage, detail].filter(part => part && !label(taskStatus(task)).includes(part)).join(' · ');
      if (extra) meta.append(node('em', extra, 'task-note'));
      copy.append(node('strong', task.title || t('airUntitledTask')), meta);
      button.append(node('span', task.recordType === 'planned' ? '◇' : '›', 'directory-task-mark'), copy,
        node('time', task.updatedAt ? new Date(task.updatedAt).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''));
      button.onclick = () => navigate(directoryId, task.id);
      const remove = node('button', t('delete'), 'task-delete danger');
      remove.type = 'button';
      remove.dataset.action = 'delete';
      remove.setAttribute('aria-label', t('airDeleteTaskAria', { title: task.title || t('airUntitledTask') }));
      remove.onclick = event => { event.stopPropagation(); void deleteTaskById(task); };
      row.append(button, remove);
      return row;
    }));
    if (!rows.length) $('directory-task-list').append(node('p', t('airDirNoTasks'), 'directory-task-empty'));
    // 截掉的那些得有个去处，否则「最近任务」看着就是全部。数字用的是这个目录
    // 的全部任务数，不是剩下的条数 —— 说的是「还有多少」，不是「还差几行」。
    const more = $('directory-task-more');
    more.hidden = !directoryTasksExpanded && tasks.length <= rows.length;
    more.textContent = directoryTasksExpanded ? t('airDirCollapseToRecent') : t('airDirViewAllTasks', { n: tasks.length });
    renderQuickPills();
    for (const element of [$('quick-task-input'), $('quick-task-submit'),
      $('quick-task-attach'), $('quick-task-mic')]) element.disabled = !dir;
    renderDirectoryGit();
  }

  // ── 目录 Git 状态：主检出的「未推送提交」与「不在 worktree 的脏文件」 ──
  // 每个会话 worktree 的 ahead/dirty 由它自己的 merge-status 管（任务页头那颗
  // 合并按钮）；目录首页要看的是主检出本身 —— 多少提交还没 push、有没有漂在
  // 任务体系之外直接改的文件。提交列表与 diff 走 /api/git/log 和
  // /api/git/commit-diff，同旧控制台（manage.html 的 git 树）那两条接口，
  // 展开才取，首屏只有一份轻量状态。
  // 「↑ N 个提交未推送」那颗还能按：点开确认一次，然后走目录的 push 接口
  // （POST /api/directories/:id/push —— 和旧控制台 ⋯ 菜单里那个 Push 同一条）。
  const directoryGitView = {
    dirId: null, status: null, error: '', fetchedAt: 0,
    logOpen: false, commits: null, logError: '', openHash: null,
  };
  const GIT_REFRESH_MS = 60000;

  function renderDirectoryGit() {
    const panel = $('directory-git');
    if (!panel) return;
    const show = !taskId && !!directoryId;
    panel.hidden = !show;
    if (!show) return;
    if (directoryGitView.dirId !== directoryId) {
      Object.assign(directoryGitView, { status: null, error: '', logOpen: false, commits: null, logError: '', openHash: null });
    }
    if (directoryGitView.dirId !== directoryId || Date.now() - directoryGitView.fetchedAt > GIT_REFRESH_MS) {
      void loadDirectoryGit();
    }
    paintDirectoryGit();
  }

  async function loadDirectoryGit() {
    try {
      const status = await api(`/api/git/directory-status?dirId=${encodeURIComponent(directoryId)}`);
      Object.assign(directoryGitView, { status, error: '' });
    } catch (error) {
      Object.assign(directoryGitView, { status: null, error: error.message });
    }
    Object.assign(directoryGitView, { dirId: directoryId, fetchedAt: Date.now() });
    paintDirectoryGit();
  }

  /** 「↑ N 个提交未推送」那颗胶囊点开的确认框：确认后把主检出推到上游。
   *  只推已经提交的内容（push 不改工作区），所以这里是「确认一次」而不是
   *  「选一堆选项」；失败留在框里说原因，成功了收框 + 立刻重读一次状态。 */
  async function openPushRepoDialog() {
    const status = directoryGitView.status;
    const dirId = directoryId;
    if (!status || !dirId || document.querySelector('.push-repo-dialog')) return;
    if (!status.upstream) { notice(t('airGitNoUpstream')); return; }
    if (!status.ahead) { notice(t('airGitNoPendingPush')); return; }
    const ahead = status.ahead;
    const branch = status.branch || t('airGitCurrentBranch');
    const dialog = node('dialog', null, 'push-repo-dialog');
    const form = node('form');
    form.append(node('span', 'GIT PUSH', 'eyebrow'), node('h2', t('airGitPushTitle')));
    form.append(node('p', t('airGitPushBody', { branch, ahead, upstream: status.upstream })));
    const error = node('p', '', 'push-repo-error');
    error.setAttribute('role', 'alert');
    const footer = node('div', null, 'push-repo-footer');
    const cancel = node('button', t('cancel'));
    cancel.type = 'button';
    cancel.onclick = () => dialog.close();
    const confirm = node('button', t('airGitPushConfirm', { n: ahead }));
    confirm.type = 'submit';
    confirm.classList.add('primary');
    footer.append(cancel, confirm);
    form.append(error, footer);
    form.onsubmit = async event => {
      event.preventDefault();
      cancel.disabled = true;
      confirm.disabled = true;
      error.textContent = '';
      try {
        const result = await api(`/api/directories/${encodeURIComponent(dirId)}/push`, {});
        dialog.close();
        notice(result.pushed
          ? t('airGitPushed', { n: result.before?.ahead ?? ahead, upstream: status.upstream })
          : t('airGitNoPendingPush'));
        // 推完这一颗就该变成「已与上游同步」：作废时间戳，让下一笔重新读。
        directoryGitView.fetchedAt = 0;
        await loadDirectoryGit();
      } catch (cause) {
        error.textContent = t('airGitPushFailed', { msg: cause.message });
        cancel.disabled = false;
        confirm.disabled = false;
      }
    };
    dialog.onclose = () => dialog.remove();
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    confirm.focus();
  }

  function paintDirectoryGit() {
    const brief = $('directory-git-brief');
    if (!brief) return;
    const note = $('directory-git-note');
    const list = $('directory-git-list');
    if (directoryGitView.error) {
      brief.replaceChildren(node('p', t('airGitStatusFailed', { msg: directoryGitView.error }), 'directory-git-empty error'));
      if (note) note.textContent = t('airGitReadFailed');
      if (list) list.hidden = true;
      return;
    }
    const status = directoryGitView.status;
    if (!status) {
      brief.replaceChildren(node('p', t('airGitReading'), 'directory-git-empty'));
      if (note) note.textContent = t('airGitReadingShort');
      if (list) list.hidden = true;
      return;
    }
    const chips = node('div', null, 'directory-git-chips');
    const chip = (text, tone = '') => node('span', text, `directory-git-chip ${tone}`.trim());
    chips.append(chip(`⎇ ${status.branch || '—'}`));
    // 有上游就说「没 push」，没有上游的仓库退到基分支：说的还是「这些提交
    // 只存在于本地」，只是对齐的对象从远端换成了基分支。
    const target = status.upstream || status.baseBranch;
    // 有上游、而且真的领先时这一颗能按：点开确认 → POST /api/directories/:id/push
    // （和旧控制台 ⋯ 菜单里那个 Push 是同一条接口）。没有上游（那句退化成「未合入
    // 基分支」）或本来就没落后时它是颗死标签 —— 那时没有「推送」这件事可做。
    const pushable = !!status.upstream && status.ahead > 0;
    if (target) {
      const aheadText = status.upstream
        ? (status.ahead ? t('airGitAheadUnpushed', { n: status.ahead }) : t('airGitInSyncUpstream'))
        : (status.ahead ? t('airGitAheadUnmerged', { n: status.ahead, base: status.baseBranch }) : t('airGitInSyncBase', { base: status.baseBranch }));
      if (pushable) {
        const push = node('button', null, 'directory-git-chip warn is-action');
        push.type = 'button';
        push.title = t('airGitPushTip', { n: status.ahead, upstream: status.upstream });
        push.setAttribute('aria-label', push.title);
        push.append(node('span', aheadText), node('span', t('airGitPushHint'), 'directory-git-chip-hint'));
        push.onclick = () => void openPushRepoDialog();
        chips.append(push);
      } else {
        chips.append(chip(aheadText, status.ahead ? 'warn' : 'ok'));
      }
      if (status.upstream && status.behind) chips.append(chip(t('airGitBehindUpstream', { n: status.behind }), 'warn'));
    }
    chips.append(chip(status.dirtyFiles?.length
      ? t('airGitDirtyFiles', { n: status.dirtyFiles.length })
      : t('airGitMainClean'), status.dirtyFiles?.length ? 'warn' : 'ok'));
    const actions = node('div', null, 'directory-git-actions');
    const logButton = node('button', directoryGitView.logOpen ? t('airGitLogCollapse') : t('airGitLogView'), 'subtle');
    logButton.type = 'button';
    logButton.onclick = () => void toggleDirectoryGitLog();
    actions.append(logButton);
    brief.replaceChildren(chips, actions);
    if (status.dirtyFiles?.length) {
      const files = node('details', null, 'directory-git-files');
      files.append(node('summary',
        t('airGitDirtySummary', { n: status.dirtyFiles.length })));
      const fileList = node('ul');
      const shown = status.dirtyFiles.slice(0, 50);
      for (const file of shown) fileList.append(node('li', `${file.status || 'M'}  ${file.path}`));
      if (status.dirtyFiles.length > shown.length) fileList.append(node('li', t('airGitMoreFiles', { n: status.dirtyFiles.length - shown.length })));
      files.append(fileList);
      brief.append(files);
    }
    if (note) note.textContent = status.upstream ? t('airGitUpstreamNote', { upstream: status.upstream }) : t('airGitNoUpstreamNote');
    if (list) {
      list.hidden = !directoryGitView.logOpen;
      if (directoryGitView.logOpen) paintDirectoryGitLog(list);
    }
  }

  async function toggleDirectoryGitLog() {
    directoryGitView.logOpen = !directoryGitView.logOpen;
    if (directoryGitView.logOpen && !directoryGitView.commits && !directoryGitView.logError) {
      const list = $('directory-git-list');
      list.replaceChildren(node('p', t('airGitReadingLog'), 'directory-git-empty'));
      try {
        const result = await api(`/api/git/log?dirId=${encodeURIComponent(directoryId)}&limit=30`);
        directoryGitView.commits = result.commits || [];
      } catch (error) {
        directoryGitView.logError = error.message;
      }
    }
    paintDirectoryGit();
  }

  function paintDirectoryGitLog(list) {
    if (directoryGitView.logError) {
      list.replaceChildren(node('p', t('airGitLogFailed', { msg: directoryGitView.logError }), 'directory-git-empty error'));
      return;
    }
    const commits = directoryGitView.commits;
    if (!commits) return;
    if (!commits.length) {
      list.replaceChildren(node('p', t('airGitNoCommits'), 'directory-git-empty'));
      return;
    }
    list.replaceChildren(...commits.map(commit => {
      const item = node('div', null, 'directory-git-commit');
      const head = node('button', null, 'directory-git-commit-head');
      head.type = 'button';
      head.setAttribute('aria-expanded', String(directoryGitView.openHash === commit.hash));
      const copy = node('span', null, 'directory-git-commit-copy');
      copy.append(node('code', commit.short || String(commit.hash || '').slice(0, 7)),
        node('strong', commit.subject || t('airGitNoSubject')));
      head.append(copy,
        node('time', commit.date ? commit.date.replace('T', ' ').slice(0, 16) : ''),
        node('small', `${commit.author || '—'}${commit.refs ? ` · ${commit.refs}` : ''}`));
      head.onclick = () => void toggleCommitDetail(commit);
      item.append(head);
      if (directoryGitView.openHash === commit.hash) {
        const detail = node('div', null, 'directory-git-commit-detail');
        if (commit.__stat) detail.append(node('div', commit.__stat, 'directory-git-stat'));
        detail.append(node('pre', commit.__diff || t('airGitDiffReading'), 'directory-git-diff'));
        item.append(detail);
      }
      return item;
    }));
  }

  async function toggleCommitDetail(commit) {
    if (directoryGitView.openHash === commit.hash) {
      directoryGitView.openHash = null;
      paintDirectoryGit();
      return;
    }
    directoryGitView.openHash = commit.hash;
    if (commit.__diff === undefined) {
      paintDirectoryGit();
      try {
        const result = await api(`/api/git/commit-diff?dirId=${encodeURIComponent(directoryId)}&hash=${encodeURIComponent(commit.hash)}`);
        commit.__stat = result.stat || '';
        commit.__diff = result.error ? t('airGitDiffFailed', { msg: result.error })
          : result.diff || t('airGitNoDiff');
        if (result.truncated) commit.__diff += t('airGitDiffTruncated');
      } catch (error) {
        commit.__stat = '';
        commit.__diff = t('airGitDiffFailed', { msg: error.message });
      }
    }
    paintDirectoryGit();
  }

  function quickTaskId() {
    return crypto.randomUUID ? crypto.randomUUID() : `air-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function uploadQuickTaskFiles(files) {
    $('quick-task-attach').disabled = true;
    for (const file of Array.from(files || [])) {
      const chip = node('span', t('airQuickUploading', { name: file.name }), 'quick-task-file');
      $('quick-task-files').append(chip);
      try {
        const form = new FormData(); form.append('file', file, file.name);
        const response = await fetch('/api/upload', { method: 'POST', body: form });
        const result = await response.json();
        if (!response.ok || !result.path) throw new Error(result.error || `HTTP ${response.status}`);
        chip.textContent = file.name;
        chip.dataset.path = result.path;
        const remove = node('button', '×'); remove.type = 'button'; remove.setAttribute('aria-label', t('airQuickRemoveFile', { name: file.name }));
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

  // 侧栏那颗「＋ 新任务」：把上面这**一个**输入框模块搬进弹窗，而不是再长出一张
  // 自己的表单。搬的是节点，所以两处的胶囊、草稿、附件、Goal 上限和绑定的处理器
  // 都是同一份 —— 关掉再搬回目录首页原位（#empty 的最后一个孩子就是它）。
  //
  // 目录首页开着的时候，弹窗后面那一页会暂时缺了输入框（被搬走了）。那一片被
  // ::backdrop 压暗着，读起来就是「它弹出来了」，关掉即回原位。
  let quickDialogDirectoryId = null;

  function quickTargetDirectoryId() {
    if (!$('quick-task-dialog').open) return directoryId;
    return data?.directories?.some(entry => entry.id === quickDialogDirectoryId)
      ? quickDialogDirectoryId : directoryId;
  }

  function openNewTaskComposer() {
    const dialog = $('quick-task-dialog');
    if (!data || !directoryId || dialog.open) return;
    const select = $('quick-task-dialog-directory');
    select.replaceChildren(...data.directories.map(entry => {
      const option = node('option', [entry.name, entry.path].filter(Boolean).join(' · '));
      option.value = entry.id;
      return option;
    }));
    quickDialogDirectoryId = data.directories.some(entry => entry.id === directoryId)
      ? directoryId : data.directories[0]?.id || null;
    select.value = quickDialogDirectoryId || '';
    select.disabled = false;
    $('quick-task-slot').append($('quick-task-form'));
    dialog.showModal();
    // 手机上这个模块平时折成一条细杠（air-quick-fold.js）；弹窗里要的是整张。
    window.__airQuickFold?.unfold?.();
    $('quick-task-input').focus();
  }

  function closeNewTaskComposer() {
    const dialog = $('quick-task-dialog');
    if (dialog.open) dialog.close();
  }

  // 关（点 ×、点关闭、Esc、创建成功后）都从这里回原位：#empty 的最后一个孩子
  // 本来就是它，append 回去正好是原来那个位置。
  $('quick-task-dialog').addEventListener('close', () => {
    $('empty').append($('quick-task-form'));
    quickDialogDirectoryId = null;
    $('quick-task-dialog-directory').disabled = false;
    // 手机上它平时折成一条细杠，弹窗里为了写字摊开成整张 —— 回到目录首页就按原来
    // 的规矩收回去，别让一次「算了」把半屏的卡片留在那儿。盒子里还有草稿时
    // fold() 自己什么都不做：那半句话不该被藏进一条细杠。
    window.__airQuickFold?.fold?.();
  });
  $('quick-task-dialog-close').onclick = closeNewTaskComposer;
  $('quick-task-dialog-directory').onchange = event => {
    quickDialogDirectoryId = event.target.value;
  };

  // 新任务不再每次从「默认线路 · 默认模型」起步：/api/air 快照带着 lastRuntime
  // —— 最近一次实际用过的那套 CLI · 线路 · 模型。refresh() 会把它灌进胶囊；
  // 用户自己在胶囊里改过（quickRuntimeDirty）就不再覆盖，免得一次后台刷新把
  // 面前这份手挑的配置悄悄冲掉。任务创建成功后脏标记清零：那一刻起「最近
  // 使用」就是刚刚这套，下一次同步等于原地不动。角色（quickRoles）不参与
  // 记忆 —— 一个任务的角色上下文不该漏进下一个任务。
  let quickRuntime = {};
  let quickRuntimeDirty = false;
  let quickRoles = [];

  // One source of truth for the CLI the panel is about to use: the pill names it
  // and the AI 配置 dialog opens on it, so the two can never disagree about what
  // a task created from here will run.
  function quickCli() { return quickRuntime.cli || data?.clis?.[0] || 'claude'; }

  // 线路胶囊上那一串（CLI · 线路 · 模型 · 状态）会随着 provider 名字变长，而它
  // 左边还压着「＋ 角色」——所以给它一个上限宽度，超出来的部分改成跑马灯一直走，
  // 而不是被切掉（切掉的名字等于没有名字）。两个 composer 用同一份实现：胶囊的
  // 皮是 composer.css 的，结构也由这里一处建出来，会话里的那颗和新任务那颗不会
  // 长成两种东西。
  const PILL_TEXT_CLASS = 'mc-composer__pill-text';
  function pillTextHost(pill) {
    let host = null;
    for (const child of pill.children) if (child.classList.contains(PILL_TEXT_CLASS)) host = child;
    if (!host) {
      host = pill.ownerDocument.createElement('span');
      host.className = PILL_TEXT_CLASS;
      pill.replaceChildren(host);
    }
    if (!host.firstElementChild) {
      const run = pill.ownerDocument.createElement('span');
      run.className = PILL_TEXT_CLASS + '-run';
      host.append(run);
    }
    return [host, host.firstElementChild];
  }

  function measurePillText(host) {
    // 量的是文字自己的宽度，不是容器的：Range 量的是内容盒，和内联/块级写法都无关。
    try {
      const range = host.ownerDocument.createRange();
      range.selectNodeContents(host);
      return range.getBoundingClientRect().width;
    } catch (_) { return 0; }
  }

  // 只在状态真的变了的时候动 class/变量：这条带子每 4 秒会随快照重画一次，而
  // 「移除再添加」这个类（中间还读了一次 clientWidth，强制过一次样式重算）等于
  // 每次都把动画从头来过 —— 屏幕上就是跑马灯走一下、弹回起点、再走一下。
  function setPillText(pill, text) {
    if (!pill) return;
    const [host, run] = pillTextHost(pill);
    if (run.textContent !== text) run.textContent = text;
    // 折叠的/隐藏的胶囊量出来是 0 宽，那不算溢出 —— 等它露面时再量。
    const width = host.clientWidth;
    const reduceMotion = pill.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const overflow = width && !pill.hidden ? Math.ceil(measurePillText(host)) - width : 0;
    // 走得不快不慢：长一点的名字就多走一会儿，最短也要两秒才扫完一遍。
    const shift = overflow >= 2 && !reduceMotion ? `-${overflow}px` : '';
    const duration = shift ? `${Math.min(20, Math.max(2.4, overflow / 18 + 1.2)).toFixed(1)}s` : '';
    for (const [name, value] of [['--mc-pill-marquee-shift', shift], ['--mc-pill-marquee-duration', duration]]) {
      if ((pill.style.getPropertyValue(name) || '') === value) continue;
      if (value) pill.style.setProperty(name, value); else pill.style.removeProperty(name);
    }
    const marquee = !!shift;
    if (marquee !== pill.classList.contains('is-marquee')) pill.classList.toggle('is-marquee', marquee);
  }

  function renderQuickPills() {
    const ai = $('quick-ai-pill'), role = $('quick-role-pill');
    if (!ai || !role) return;
    const route = quickRuntime.providerSelection?.mode === 'auto'
      ? `Auto ${quickRuntime.providerSelection.protocol}`
      : providerDisplayName(quickRuntime.providerName || quickRuntime.provider || '') || t('airQuickDefaultRoute');
    setPillText(ai, [quickCli(), route, quickRuntime.model || t('airQuickDefaultModel')].join(' · '));
    ai.title = t('airQuickAiTitle');
    role.textContent = quickRoles.length ? t('airQuickRoleCount', { n: quickRoles.length }) : t('airQuickAddRole');
    role.title = t('airQuickRoleTitle');
    for (const pill of [ai, role]) pill.disabled = !directoryId;
  }

  function openQuickConfiguration() {
    if (!directoryId) return;
    window.MultiCCAirSettings.configuration(
      { task: { title: t('airNewTask') }, configuration: { ...quickRuntime, cli: quickCli() } }, data?.clis,
      runtime => { quickRuntime = runtime; quickRuntimeDirty = true; renderQuickPills(); },
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
    catch (_) { quickStatus(t('airQuickMicDenied')); return; }
    quickRecorderChunks = [];
    const mime = window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : undefined;
    try { quickRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    catch (_) {
      stream.getTracks().forEach(track => track.stop());
      quickStatus(t('airQuickRecordUnsupported'));
      return;
    }
    quickRecorder.ondataavailable = event => { if (event.data?.size) quickRecorderChunks.push(event.data); };
    quickRecorder.onstop = async () => {
      stream.getTracks().forEach(track => track.stop());
      button.classList.remove('rec');
      const blob = new Blob(quickRecorderChunks, { type: 'audio/webm' });
      if (!blob.size) { quickStatus(''); return; }
      quickStatus(t('airQuickTranscribing'));
      try {
        const form = new FormData(); form.append('file', blob, 'recording.webm');
        const response = await fetch('/api/voice/stt', { method: 'POST', body: form });
        const result = await response.json();
        if (!response.ok || !result.text) throw new Error(result.error || t('airQuickNoSpeech'));
        const input = $('quick-task-input');
        input.value = input.value ? `${input.value} ${result.text.trim()}` : result.text.trim();
        input.focus();
        quickStatus('');
      } catch (error) { quickStatus(t('airQuickTranscribeFailed', { msg: error.message })); }
    };
    quickRecorder.start();
    button.classList.add('rec');
    quickStatus(t('airQuickRecording'));
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
    const targetDirectoryId = quickTargetDirectoryId();
    if (!data || !targetDirectoryId) return;
    const typed = $('quick-task-input').value.trim();
    if (!typed) return;
    const paths = [...$('quick-task-files').querySelectorAll('[data-path]')].map(chip => chip.dataset.path);
    const text = typed + (paths.length ? t('airQuickAttachments', { paths: paths.join(' ') }) : '');
    // The pill's runtime is pinned onto the task at creation; the route it names
    // takes effect immediately, exactly as it does on the chat's own composer.
    const runtime = { cli: quickRuntime.cli || data.clis[0] || 'claude' };
    for (const key of ['provider', 'providerSelection', 'model', 'effort', 'subagent']) {
      if (quickRuntime[key]) runtime[key] = quickRuntime[key];
    }
    const goal = $('quick-task-goal').checked;
    const goalLimits = goal ? goalLimitsFromForm() : null;
    const fingerprint = JSON.stringify([targetDirectoryId, text, runtime, quickRoles, goalLimits]);
    if (!quickCreateAttempt || quickCreateAttempt.fingerprint !== fingerprint) {
      quickCreateAttempt = { fingerprint, createId: quickTaskId(), sendId: quickTaskId() };
    }
    const attempt = quickCreateAttempt;
    let created = null;
    $('quick-task-submit').disabled = true;
    if ($('quick-task-dialog').open) $('quick-task-dialog-directory').disabled = true;
    quickStatus(t('airQuickCreating'));
    try {
      const title = typed.split(/\n/).find(Boolean).trim().slice(0, 120);
      created = await api('/api/air/tasks', { dirId: targetDirectoryId, title, clientMsgId: attempt.createId, ...runtime });
      quickStatus(t('airQuickWritingFirstMessage'));
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
      // 刚刚创建的会话此刻就是「最近使用」，脏标记清零让下一次 refresh 的
      // lastRuntime 同步接管 —— 它带回来的正是刚刚钉进任务的这套。
      quickRuntimeDirty = false;
      renderQuickPills();
      renderQuickGoalLimits();
      $('quick-task-files').replaceChildren();
      // 折叠模块（air-quick-fold.js）盯着这个：盒子已经清空了，就没有什么还
      // 需要替它撑着的了，回到那条细杠。
      $('quick-task-form').dispatchEvent(new CustomEvent('air:quick-task-created'));
      // 这一份是整条链路都成了：从侧栏弹进来的话，弹窗跟着收掉（它会把输入框
      // 搬回目录首页）。失败时留着 —— 草稿还在里面，重试就是原样再点一次。
      closeNewTaskComposer();
      await refresh();
      navigate(targetDirectoryId, created.taskId);
    } catch (error) {
      if (created?.taskId) {
        sessionStorage.setItem(`air:draft:${created.taskId}`, text);
        quickCreateAttempt = null;
        closeNewTaskComposer();
        await refresh();
        navigate(targetDirectoryId, created.taskId);
        notice(t('airQuickFirstMessageUnconfirmed', { msg: error.message }));
      } else quickStatus(error.message);
    } finally {
      $('quick-task-submit').disabled = false;
      $('quick-task-dialog-directory').disabled = false;
    }
  }

  function scheduleTime(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat(locale(), {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(value));
  }

  function scheduleRuntime(task) {
    return [task.cli, task.provider, task.model, task.effort].filter(Boolean).join(' · ') || t('airScheduleFollowTask');
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
      node('span', t('airScheduleRuleCount', { n: scheduleTasks.length })),
      node('span', t('airScheduleEnabledCount', { n: enabled })),
      node('span', errors ? t('airScheduleErrorCount', { n: errors }) : t('airScheduleAllHealthy'), errors ? 'warning' : 'healthy'),
    );
    list.replaceChildren();
    if (!scheduleTasks.length) {
      const empty = node('div', null, 'schedule-empty');
      empty.append(node('strong', t('airScheduleNoneYet')), node('p', t('airScheduleNoneHint')));
      list.append(empty);
      return;
    }
    for (const task of scheduleTasks) {
      const card = node('article', null, 'schedule-card');
      const head = node('header', null, 'schedule-card-head');
      const title = node('div');
      title.append(node('span', 'SCHEDULE', 'eyebrow'), node('h3', task.name));
      head.append(title, node('span', task.enabled ? t('airScheduleEnabled') : t('airScheduleDisabled'), `schedule-badge ${task.enabled ? 'enabled' : ''}`));

      const timing = node('div', null, 'schedule-timing');
      const expression = node('code', task.cron);
      const next = node('div');
      next.append(node('small', t('airScheduleNextRun')), node('strong', task.enabled ? scheduleTime(task.nextRunAt) : t('airSchedulePaused')));
      const previous = node('div');
      previous.append(node('small', t('airScheduleLastFired')), node('strong', task.lastRunAt ? scheduleTime(task.lastRunAt) : t('airScheduleNeverRan')));
      timing.append(expression, next, previous);

      const fixed = node('button', null, `schedule-fixed-task ${task.taskBindingError || !task.taskId ? 'broken' : ''}`);
      fixed.type = 'button';
      fixed.disabled = !task.taskId;
      const fixedCopy = node('span');
      fixedCopy.append(node('small', t('airScheduleFixedTask')), node('strong', task.taskTitle || task.name),
        node('small', task.taskBindingError || (task.taskId ? `${task.taskId} · ${scheduleRuntime(task)}` : t('airScheduleBinding'))));
      fixed.append(node('span', task.taskBindingError ? '!' : '↗', 'schedule-task-mark'), fixedCopy);
      if (task.taskId) fixed.onclick = () => navigate(task.dirId, task.taskId);

      const state = node('div', null, `schedule-state ${task.lastStatus === 'error' ? 'error' : ''}`);
      const stateLabel = task.lastStatus === 'queued' ? t('airScheduleQueued')
        : task.lastStatus === 'ok' ? t('airScheduleLastAccepted')
          : task.lastStatus === 'error' ? (task.lastError || t('airScheduleLastFailed')) : t('airScheduleAwaitingFirstRun');
      state.append(node('span', stateLabel), node('small', t('airScheduleFiredCount', { dir: task.dirName, n: task.runCount || 0 })));

      const prompt = node('p', task.prompt, 'schedule-prompt');
      const actions = node('footer', null, 'schedule-actions');
      const run = scheduleAction(t('airScheduleRunNow'), () => runSchedule(task.id), 'primary subtle');
      // A rule whose fixed task was archived stops executing until a new fixed
      // task is bound; that repair is explicit, never automatic.
      const rebind = task.taskBindingError
        ? scheduleAction(t('airScheduleRebind'), () => rebindSchedule(task.id), 'primary subtle')
        : null;
      const toggle = scheduleAction(task.enabled ? t('airSchedulePause') : t('airScheduleEnable'), () => toggleSchedule(task.id, !task.enabled));
      const edit = scheduleAction(t('airScheduleEdit'), () => openScheduleDialog(task.id));
      const remove = scheduleAction(t('airScheduleDelete'), () => deleteSchedule(task.id), 'danger');
      actions.append(run, ...(rebind ? [rebind] : []), toggle, edit, node('span'), remove);
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
      if (mode === 'schedules') notice(t('airScheduleLoadFailed', { msg: error.message }));
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
    $('schedule-dialog-title').textContent = current ? t('airScheduleEditTitle') : t('airNewScheduledTask');
    $('schedule-save').textContent = current ? t('airScheduleSaveRule') : t('airScheduleCreateAndBind');
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
      notice(id ? t('airScheduleRuleUpdated') : t('airScheduleCreated'));
    } catch (error) { $('schedule-error').textContent = error.message; }
    finally { $('schedule-save').disabled = false; }
  }

  async function runSchedule(id) {
    try {
      const result = await api(`/api/cron/${encodeURIComponent(id)}/run`, {});
      await Promise.all([refreshSchedules(), refresh()]);
      notice(result.decision === 'queued' ? t('airScheduleBusyQueued') : t('airScheduleSentToTask'));
    } catch (error) { notice(t('airScheduleRunFailed', { msg: error.message })); }
  }

  async function rebindSchedule(id) {
    if (!window.confirm(t('airScheduleRebindConfirm'))) return;
    try {
      const result = await api(`/api/cron/${encodeURIComponent(id)}/rebind`, {});
      await Promise.all([refreshSchedules(), refresh()]);
      notice(t('airScheduleRebound', { id: result.taskId }));
    } catch (error) {
      notice(error.code === 'binding_healthy' ? t('airScheduleBindingHealthy') : t('airScheduleRebindFailed', { msg: error.message }));
    }
  }

  async function toggleSchedule(id, enabled) {
    try {
      await api(`/api/cron/${encodeURIComponent(id)}`, { enabled }, 'PATCH');
      await refreshSchedules();
    } catch (error) { notice(t('airScheduleUpdateFailed', { msg: error.message })); }
  }

  async function deleteSchedule(id) {
    if (!window.confirm(t('airScheduleDeleteConfirm'))) return;
    try {
      await api(`/api/cron/${encodeURIComponent(id)}`, undefined, 'DELETE');
      await refreshSchedules();
      notice(t('airScheduleDeleted'));
    } catch (error) { notice(t('airScheduleDeleteFailed', { msg: error.message })); }
  }

  /** 侧栏「最近任务」那一条带子。单独抽出来是因为它有两个调用点：整页 render，
   *  以及 pin 变了的时候 —— 后者只动了侧栏和页头那排 tab，没必要把整页（含对话
   *  帧）重画一遍。 */
  function renderSidebarTasks() {
    const tasks = sidebarTasks();
    const list = $('tasks');
    // 重画不该顺手把人挪走：这一列自己会滚（任务带吃掉侧栏剩下的高度），滚到中下部
    // 再点一条任务、或者轮询/开控制台顺手重画一遍，都不该被顶回顶部。清空再填的写法
    // 在列表变短、或中间真落了一次重排时会把 scrollTop 夹小 —— 与其赌浏览器什么时候
    // 夹，不如画完自己回填一次（真短了，浏览器随后照旧夹到新的上限）。
    const scrollTop = list.scrollTop;
    $('task-list-title').textContent = t('airRecentTasks');
    $('task-count').textContent = tasks.length;
    list.replaceChildren(...tasks.map(task => {
      const elsewhere = task.dirId !== directoryId;
      const unseenKind = taskNotify?.unseenKind?.(task.id) || null;
      const button = node('button', null, [task.id === taskId ? 'selected' : '', elsewhere ? 'elsewhere' : '', unseenKind === 'error' ? 'unseen unseen-error' : unseenKind ? 'unseen' : ''].filter(Boolean).join(' '));
      button.dataset.task = task.id;
      applyRing(button, isRunningTask(task), task.id);
      // 一行三件事实：状态徽标（图标 + 中文，来自注册表）、标题、然后是这条记录
      // 的类型/阶段/资源去向。目录作为标签跟在同一行里 —— 「最近」这条带子本来就
      // 是跨目录的（我打开过的任务 + 当前目录的几个），所以每一行都自报家门，
      // 而不是只给「不在当前目录」的那几行加标记：一份一半带标签一半不带的列表，
      // 读的人得先知道哪一半是什么规则。
      const meta = node('small', null, 'task-meta');
      meta.append(statusBadge(task));
      meta.append(node('em', directoryName(task.dirId), 'task-dir'));
      // 手机上 pin 住的那几条就排在这份列表的最上面，标记说明它们为什么在那儿。
      if (isPinned(task.id)) meta.append(node('span', '📌', 'task-pin'));
      const stage = task.recordType === 'planned' ? t('airSidebarPlanned', { stage: label(task.workflowStage || task.status) }) : '';
      // 徽标已经说过的词不在这里再说一遍（「执行中 · 执行中」不是更多信息）。
      const badgeText = label(taskStatus(task));
      const extra = [stage, holdText(task.resource)].filter(part => part && !badgeText.includes(part)).join(' · ');
      button.append(node('strong', task.title), meta);
      if (extra) button.append(node('small', extra, 'task-note'));
      button.onclick = () => openSidebarTask(task);
      return button;
    }));
    list.scrollTop = scrollTop;
    // 抬起动画要跨过一次重画（点开 → 渲染 → 延迟换位）不能断：这条带子重建之后
    // 把抬起的类补回去，否则第一拍里那张卡会先落下去再飞。
    if (pendingReorderId) taskMotion()?.lift(list, pendingReorderId);
    if (!tasks.length) list.append(node('small', t('airSidebarNoTasks'), 'empty-list'));
  }

  // ── 侧栏点开一条任务 ────────────────────────────────────────────────────
  // MRU（打开过的排最前）这条规则没变，变的是它什么时候落到眼睛上：点下去立刻
  // 换位，卡片是「闪」到顶上的，太快、也没交代它去了哪儿。现在分两拍 —— 先把它
  // 抬起来（is-lifting），REORDER_LIFT_MS 之后重排这一条带子，再用 FLIP 把它从
  // 原位送上去。列表已经滚到中下部时不让它飞：顶端槽位在屏幕外，飞过去等于凭空
  // 消失，就地抽掉更诚实；两种情况下的滚动位置都不动。
  const REORDER_LIFT_MS = 170;
  let pendingReorderId = null;
  let pendingReorderTimer = null;
  const taskMotion = () => window.MultiCCTaskMotion;

  function openSidebarTask(task) {
    const motion = taskMotion();
    const list = $('tasks');
    const row = motion?.rowById?.(list, task.id) || null;
    if (pendingReorderTimer !== null) {
      clearTimeout(pendingReorderTimer);
      motion?.clear?.(list, pendingReorderId);
      pendingReorderTimer = null;
      pendingReorderId = null;
    }
    // 已经在顶上（或者那条根本不在这一列里）就没有换位可言，照旧立刻走。
    if (!row || list.children[0] === row) { navigate(task.dirId, task.id); return; }
    pendingReorderId = task.id;
    motion.lift(list, task.id);
    // 对话先切：换位只是这条带子自己的家务事，没理由让对话等它。
    navigate(task.dirId, task.id, { remember: false });
    pendingReorderTimer = setTimeout(() => {
      pendingReorderTimer = null;
      const id = pendingReorderId;
      pendingReorderId = null;
      if (!id) return;
      const before = motion.capture(list);
      const scrollTop = list.scrollTop;
      const flight = motion.topSlotVisible(list);
      rememberTask(id);
      renderSidebarTasks();
      list.scrollTop = scrollTop;
      motion.play(list, before, { liftId: id, flight });
    }, REORDER_LIFT_MS);
  }

  // ── Pin 住的任务 ────────────────────────────────────────────────────────
  // 「这件活我要一直看着」—— 和「最近打开过」不是一回事：最近会掉出列表，pin 不会。
  // 上限 5 个由服务端把着（第 6 个回 pin_limit_reached），界面只负责把它说清楚。
  const PIN_LIMIT = 5;
  const phoneLayout = () => matchMedia('(max-width: 760px)').matches;
  /** 按 pin 的顺序取出任务本身；已经被删掉的那种自然就不在列表里了。 */
  const pinnedTasks = () => taskPins
    .map(id => (data?.tasks || []).find(task => task.id === id))
    .filter(Boolean);
  const isPinned = id => !!id && taskPins.includes(id);

  /** 侧栏那份列表：手机上 pin 住的排在最前面，剩下的照旧（最近 + 当前目录）。 */
  function sidebarTasks() {
    const pool = recentPool();
    const pinned = pinnedTasks();
    // 桌面上 pin 的任务已经在页头顶上了，侧栏再排一遍就是同一件事说两遍。
    if (!phoneLayout() || !pinned.length) return pool;
    const taken = new Set(pinned.map(task => task.id));
    return [...pinned, ...pool.filter(task => !taken.has(task.id)).slice(0, Math.max(RECENT_LIMIT - pinned.length, 0))];
  }

  async function togglePin(taskId) {
    if (!taskId) return;
    const known = (data?.tasks || []).find(task => task.id === taskId);
    if (!isPinned(taskId) && taskPins.length >= PIN_LIMIT) {
      notice(t('airPinLimit', { n: PIN_LIMIT }));
      return;
    }
    try {
      const result = await api('/api/air/pins/toggle', { taskId });
      taskPins = Array.isArray(result.taskIds) ? result.taskIds.slice() : [];
      pinSignature = '';
      renderPins();
      renderSidebarTasks();
      paintPinButton();
      notice(isPinned(taskId) ? t('airPinned', { title: known?.title || taskId }) : t('airUnpinned'));
    } catch (error) {
      notice(t('airPinFailed', { msg: error.message }));
    }
  }

  /** 点一下把详情卡片钉住（再点收起来），一次只开一张。悬停那半截由 CSS 管
   *  （:hover / :focus-within），这里只管「点开」这半截：鼠标移开、卡片还在，
   *  直到点别处、按 Esc、或者去悬停别的 pin。 */
  function closePinPanels(except = null) {
    for (const tab of document.querySelectorAll('#task-pins .pin-tab.is-open')) {
      if (tab === except) continue;
      tab.classList.remove('is-open');
      tab.querySelector('.pin-open')?.setAttribute('aria-expanded', 'false');
    }
  }
  function setPinPanelOpen(tab, on) {
    closePinPanels(tab);
    tab.classList.toggle('is-open', on);
    tab.querySelector('.pin-open')?.setAttribute('aria-expanded', String(on));
  }

  /** 页头最上面那排收藏栏：缩略是一条只有状态图标 + 标题的短胶囊；鼠标停上去、
   *  聚焦、或点一下，完整标题 / 目录 / 阶段挂在这条胶囊的【下面】。 */
  function renderPins() {
    const container = $('task-pins');
    if (!container) return;
    // 手机上这一排整个不出现（air.css 的 760px 块也是这么说的）：那边 pin 的任务
    // 置顶在侧栏。两处都判一次是因为这里还决定要不要建 DOM。
    if (phoneLayout() || !taskPins.length) { container.replaceChildren(); container.hidden = true; pinSignature = ''; return; }
    // 4 秒一次的轮询不许把悬停中的那张卡拆掉：内容没变就不重建（悬停本身不改内容）。
    const tasks = pinnedTasks();
    const signature = tasks.map(task => [task.id, task.title, taskStatus(task), isRunningTask(task), directoryName(task.dirId), task.workflowStage || ''].join('\u0001')).join('\u0002');
    container.hidden = false;
    if (signature === pinSignature) return;
    pinSignature = signature;
    container.replaceChildren(...tasks.map(task => {
      const tab = node('div', null, 'pin-tab');
      tab.dataset.task = task.id;
      applyRing(tab, isRunningTask(task), task.id);
      const open = node('button', null, 'pin-open');
      open.type = 'button';
      const stage = label(task.workflowStage || task.status);
      open.title = `${task.title || t('airUntitledTask')} · ${directoryName(task.dirId)}${stage ? ` · ${stage}` : ''}`;
      open.setAttribute('aria-label', t('airPinExpandAria', { title: task.title || t('airUntitledTask') }));
      // 缩略态只有「状态图标 + 标题」；完整标题、目录、阶段、状态中文全在下面
      // 那张卡片里。胶囊自己的宽度不动 —— 横向伸长会把旁边几个 pin 推着一起
      // 挪（用户说的「晃眼」就是这个），卡片绝对定位，别人一步都不动。
      const panel = node('div', null, 'pin-panel');
      panel.id = `pin-panel-${task.id}`;
      const panelMeta = node('div', null, 'pin-panel-meta');
      panelMeta.append(statusBadge(task), node('em', directoryName(task.dirId), 'task-dir'));
      if (stage) panelMeta.append(node('span', stage));
      const go = node('button', t('airOpenTask'), 'pin-panel-open');
      go.type = 'button';
      go.onclick = () => navigate(task.dirId, task.id);
      panel.append(node('strong', task.title || t('airUntitledTask'), 'pin-panel-title'), panelMeta, go);
      open.setAttribute('aria-expanded', 'false');
      open.setAttribute('aria-controls', panel.id);
      const status = node('span', null, 'pin-status');
      status.append(statusBadge(task));
      const copy = node('span', null, 'pin-copy');
      copy.append(node('strong', task.title || t('airUntitledTask'), 'pin-title'));
      open.append(status, copy);
      open.onclick = () => setPinPanelOpen(tab, !tab.classList.contains('is-open'));
      const remove = node('button', '×', 'pin-x');
      remove.type = 'button';
      remove.title = t('airUnpin');
      remove.setAttribute('aria-label', t('airUnpinAria', { title: task.title || t('airUntitledTask') }));
      remove.onclick = event => { event.stopPropagation(); void togglePin(task.id); };
      // 悬停到别的 pin 上时，把点开着的那张收掉：两张卡片同时挂着很吵。
      tab.onmouseenter = () => closePinPanels(tab);
      tab.append(open, remove, panel);
      return tab;
    }));
  }

  /** 工具条上那颗 📌：说的就是当前打开的这个任务在不在 pin 里。 */
  function paintPinButton() {
    const button = $('pin-task');
    if (!button) return;
    const on = isPinned(taskId);
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? t('airUnpin') : t('airPinToTop');
    button.setAttribute('aria-label', on ? t('airUnpin') : t('airPinToTop'));
    const name = button.querySelector('.air-tool-name');
    // 手机浮层里图标旁边是要跟名字的，这个名字得跟着状态走（桌面上它不显示）。
    if (name) name.textContent = on ? t('airUnpin') : t('airPinToTop');
  }

  function applyTaskTitleEditing(task = null) {
    const titleEditable = !!(taskId && task);
    $('task-title').classList.toggle('editable', titleEditable);
    if (titleEditable) {
      $('task-title').title = t('airTitleEditHint');
      $('task-title').tabIndex = 0;
      $('task-title').setAttribute('aria-keyshortcuts', 'Enter F2');
      $('task-title').setAttribute('aria-label', t('airTitleEditAria', { title: task.title }));
    } else {
      $('task-title').removeAttribute('title');
      $('task-title').removeAttribute('tabindex');
      $('task-title').removeAttribute('aria-keyshortcuts');
      $('task-title').removeAttribute('aria-label');
    }
  }

  function renderHeader(dir) {
    const selectedEntry = entry?.task?.id === taskId ? entry : null;
    const adminHeadings = {
      // 「谁在等我」的整页。控制台那一格只放最近更新的几条，这里是完整清单。
      attention: [t('airCrumbConsole'), t('airAdminAttention'), t('airAdminAttentionHint')],
      docs: [t('airCrumbTools'), t('airDocs'), t('airAdminDocsHint')],
      memory: [t('airCrumbTools'), t('airMemoryGraph'), t('airAdminMemoryHint')],
      taskgraph: [t('airCrumbTools'), t('airTaskGraph'), t('airAdminTaskGraphHint')],
      settings: [t('airCrumbSystemSettings'), t('airSettingsCenter'), t('airAdminSettingsHint')],
      voice: [t('airCrumbSettings'), t('airAdminVoice'), t('airAdminVoiceHint')],
      goal: [t('airCrumbSettings'), t('airAdminGoal'), t('airAdminGoalHint')],
      provider: [t('airCrumbSettings'), t('airAdminProvider'), t('airAdminProviderHint')],
      aux: [t('airCrumbSettings'), t('airAdminAux'), t('airAdminAuxHint')],
      global: [t('airCrumbSettings'), t('airAdminGlobal'), t('airAdminGlobalHint')],
      push: [t('airCrumbSettings'), t('airAdminPush'), t('airAdminPushHint')],
      tunnel: [t('airCrumbSettings'), t('airTunnel'), t('airAdminTunnelHint')],
      bridges: [t('airCrumbSettings'), t('airBridges'), t('airAdminBridgesHint')],
      resources: [t('airCrumbSettings'), t('airAdminResources'), t('airAdminResourcesHint')],
      skillsync: [t('airCrumbSettings'), t('airAdminSkillSync'), t('airAdminSkillSyncHint')],
      storage: [t('airCrumbSettings'), t('airAdminStorage'), t('airAdminStorageHint')],
    };
    // The card stands for the current directory, so it stays lit while that
    // directory's own page is open; the directory library itself is ⌘K / the
    // 控制台 shortcut.
    $('library').classList.toggle('active', mode === 'tasks' && !taskId);
    $('overview').classList.toggle('active', consoleOpen);
    $('schedules').classList.toggle('active', mode === 'schedules');
    document.querySelectorAll('[data-air-view]').forEach(button => button.classList.toggle('active', button.dataset.airView === mode));
    if (adminModes.has(mode)) {
      const heading = adminHeadings[mode] || [t('airCrumbTools'), mode, ''];
      $('task-breadcrumb').textContent = heading[0];
      $('task-title').textContent = heading[1];
      $('task-state').textContent = heading[2];
    } else if (mode === 'library') {
      $('task-breadcrumb').textContent = t('airCrumbRoot');
      $('task-title').textContent = t('airWorkspace');
      $('task-state').textContent = t('airHeaderLibraryHint');
    } else if (mode === 'schedules') {
      $('task-breadcrumb').textContent = t('airCrumbAutoRun');
      $('task-title').textContent = t('airScheduledTasks');
      $('task-state').textContent = t('airHeaderSchedulesHint');
    } else if (taskId) {
      $('task-breadcrumb').textContent = t('airCrumbDirTask', { dir: dir?.name || t('airWorkspace') });
      $('task-title').textContent = selectedEntry?.task.title || t('airHeaderLoadingTask');
      if (selectedEntry) renderStateSummary($('task-state'), taskStateSegments(selectedEntry));
      else $('task-state').textContent = t('airHeaderLoadingState');
    } else {
      $('task-breadcrumb').textContent = t('airCrumbDirLibrary');
      $('task-title').textContent = dir?.name || t('airHeaderNoDirectory');
      $('task-state').textContent = dir?.path || t('airHeaderNoDirectoryHint');
    }
    applyTaskTitleEditing(selectedEntry?.task || null);
    for (const id of ['quick-merge', 'quick-auto-commit', 'quick-share', 'pin-task',
      'details-toggle', 'chat-more']) $(id).hidden = !taskId;
    paintPinButton();
    $('task-state').disabled = !taskId;
    if (!taskId) { $('task-state').classList.remove('attention'); $('task-state').removeAttribute('title'); }
    // 「正在跑」这件事，页头也是需要说清的地方之一：当前这条任务在跑的时候，
    // 标题下面那行状态和侧栏、控制台用的是同一个圈。
    const openTask = taskId ? (data?.tasks || []).find(task => task.id === taskId) : null;
    applyRing($('task-state'), isRunningTask(openTask), openTask?.id);
    renderComposerControls();
  }

  /* ── 对话帧池：最近开过的任务留一个热帧 ──
     管理台那个会话弹窗一直是这么干的（public/manage.js 的 _sessionIframePool）：关掉只
     藏不卸，再打开就是热的。Air 这边原来只有一个 #conversation，切任务就是换 src，
     等于把整个聊天页冷启一遍 —— 一百多 KB 的 HTML、五十多个脚本、重连一次 socket、
     重拉一遍历史再把消息重放出来。来回对照两三个任务时，这份代价每切一次付一次。

     所以这里按同样的办法排队：切走的帧留在 DOM 里（hidden），切回来直接显示。
     「当前这个」永远是 #conversation —— 切走时把 id 摘下来交给下一个，页面里那一堆
     $('conversation') 因此不用改。容量给 2（连当前的一共 3 个），每个帧是一整个聊天页
     加一条 WS，手机再多就不划算了。

     后台帧不是「没在跑」：它照旧收消息、照旧渲染，只是不再做 liveness 轮询、不再响 ——
     那两件事由 chat.js 的 __multiccChatSetActive 开关，不然看 A 的时候 B 完成一轮会
     在耳边叫。 */
  const MAX_POOLED_FRAMES = 2;
  const _framePool = new Map();   // taskId → { frame, lastUsed }
  let _frameHoldsTask = null;     // 现在这个 #conversation 里装的是哪个任务

  function setFrameActive(frame, active) {
    try { frame?.contentWindow?.__multiccChatSetActive?.(active); } catch (_) { /* 还没起来就算了，load 之后会补 */ }
  }

  // 帧自己的两处接线：加载完同步一次工具条，并在帧内补一手「点一下就收浮层」。
  // 池子里的每个帧都要接，不只是最初那一个。
  function wireConversationFrame(frame) {
    frame.addEventListener('load', () => { dismissOnFrame(frame); setFrameActive(frame, frame.id === 'conversation'); reconcileFrameTask(frame); });
    frame.onload = syncFrame;
  }

  // 帧加载完后按任务对一次账。iOS 后台会把 iframe 的 document 收掉，回来时按帧的
  // 「当前地址」重载 —— 而这个地址在 chat-task-boot 解析任务时已被 location.replace
  // 钉成 ?session=<当时的绑定>，task 参数在那一步丢掉了。任务后来改路由
  // （task_shell_routed / 重新派发）时活着的帧靠 WS 跟着走、地址不变，重载回来的
  // 就是旧会话的对话：页头（顶层按任务渲染）和消息列表（帧按会话渲染）从此对不上。
  // 这里重新解析任务的当前绑定，不一致才把帧导航过去；一致就不动，所以不会循环。
  async function reconcileFrameTask(frame) {
    const task = frame.dataset.task;
    if (!task || !window.MultiCCChatShellEntry) return;
    let frameLocation;
    try { frameLocation = frame.contentWindow?.location; } catch (_) { return; }
    if (!frameLocation || new URLSearchParams(frameLocation.search).get('task')) return; // 任务入口页：bootChatEntry 自己正在解析
    try {
      const target = await window.MultiCCChatShellEntry.resolve({
        sessionId: '', taskId: task, fetch: window.fetch.bind(window), air: true,
      });
      if (!target) return;
      const next = new URL(target, frameLocation.href);
      if (next.search !== frameLocation.search) frameLocation.replace(next.href);
    } catch (_) { /* 解析失败先保持现状，下次加载再对 */ }
  }

  function parkFrame(frame) {
    if (!frame) return;
    frame.removeAttribute('id');
    frame.hidden = true;
    setFrameActive(frame, false);
  }

  /* 帧永远住在 #chat-layer 里（#chat-bar 下面那一格），而 #chat-layer 又只在
     #task-content 之内活动 —— 所以帧的几何仍然由内容区决定：浮层盖住目录详情、
     展开时盖住页头，帧跟着一起长，不需要谁再去量一次。
     这里原来在「#conversation 已经被交回池子（id 摘掉了）、池子里又没有这个任务的
     帧」时落到 document.body.append(frame)。body 是横向 flex，而 iframe 的固有宽度
     300px 作为 flex 项的 min-width:auto 压不下去 —— 那一行于是被分成 main 93px +
     帧 300px：页头（flex-wrap + 面包屑也 wrap）竖着摞成一条窄列、标题只剩一个字，
     对话跑到右边整屏高。手机上「新打开一个任务就错位」就是这条路：
     先看过某任务 → 点工作目录卡/目录库回到无任务（帧进池子）→ 再开一个没开过的任务。
     after 传「紧跟哪一个」：当前帧还在这一层里就排在它后面，否则排到最后。 */
  function mountFrame(frame, after) {
    const host = $('chat-layer');
    if (!host) { document.body.append(frame); return; }
    // 已经在家里就别再碰它：在 DOM 里挪一个 iframe（哪怕只是换个相邻位置）浏览器会把它
    // 整个重载一遍 —— 帧池攒的那点热乎气全没了。只有挂错地方（body 上）才搬。
    if (frame.parentNode === host) return;
    const anchor = after && after.parentNode === host ? after.nextSibling : null;
    host.insertBefore(frame, anchor || null);
  }

  function evictFrames() {
    while (_framePool.size > MAX_POOLED_FRAMES) {
      let oldestId = null, oldest = Infinity;
      for (const [id, entry] of _framePool) if (entry.lastUsed < oldest) { oldest = entry.lastUsed; oldestId = id; }
      if (!oldestId) break;
      _framePool.get(oldestId).frame.remove();
      _framePool.delete(oldestId);
    }
  }

  // 把当前这个交给池子，并让 task 那一个上台（在池子里就热启，否则新建一个冷启）。
  function openConversation(task) {
    if (_frameHoldsTask === task) { $('conversation')?.removeAttribute('hidden'); return; }
    const current = $('conversation');
    if (current && _frameHoldsTask) _framePool.set(_frameHoldsTask, { frame: current, lastUsed: Date.now() });
    const pooled = _framePool.get(task);
    if (pooled && pooled.frame.isConnected) {
      _framePool.delete(task);
      parkFrame(current);
      // 池子里的帧理论上一直待在 #task-content 里；但如果它是从之前那次「挂到 body」
      // 的错位里留下的，这里顺手把它搬回来，不用刷新页面也能自愈。
      mountFrame(pooled.frame, null);
      pooled.frame.id = 'conversation';
      pooled.frame.hidden = false;
      setFrameActive(pooled.frame, true);
      // 帧没重新加载，load 不会响，所以这里补一次：工具条那几个图标、输入框里
      // 的草稿都是照着「当前这个帧」读的，上台之后得重新对一遍。
      syncFrame();
    } else {
      if (pooled) _framePool.delete(task);   // 帧已经被 LRU 收走了，只留下这条记录
      const frame = document.createElement('iframe');
      frame.id = 'conversation';
      frame.title = t('airTaskConversation');
      // 帧属于哪个任务要跟着元素走：地址会被帧内的 location.replace 换成会话页，
      // 重载对账（reconcileFrameTask）认的是这份标记。
      frame.dataset.task = task;
      frame.src = `/chat.html?task=${encodeURIComponent(task)}&air=1`;
      wireConversationFrame(frame);
      if (current) {
        // 初始那个空帧（还没有 src）没有保留价值，直接换掉；装过任务的帧则留下来进池子。
        if (_frameHoldsTask) { parkFrame(current); mountFrame(frame, current); }
        else current.replaceWith(frame);
      } else mountFrame(frame, null);
    }
    _frameHoldsTask = task;
    evictFrames();
  }

  /* ── 对话浮层：打开任务 = 把这一层升上来，不是换掉底页 ──
     底页（#empty 的目录详情）一直在，所以「关掉对话」是把这一层滑落回去，
     「换一个任务」只是把这一层里的帧换人 —— 两条路都不必重建底页，切换于是
     只有一步的距离：侧栏点一下就是换台。桌面展开只覆盖侧栏右边的主界面；手机
     因为侧栏已经收进抽屉，展开才是真满屏。展开态不落盘、不写地址：刷新回来
     还是浮层，跟 App 的 sheet 不记忆展开一样。

     下面这两个开关必须成对出现在每一次 render 里（render 是唯一的落点）：
     谁都不该自己去 add('is-open')。 */
  const CHAT_SLIDE_MS = 260;      // 与 air.css 里 #chat-layer 的过渡时长一致
  let _chatParkTimer = null;

  function cancelChatPark() { clearTimeout(_chatParkTimer); _chatParkTimer = null; }

  function openChatLayer() {
    const layer = $('chat-layer');
    if (!layer) return;
    cancelChatPark();                     // 滑落途中又打开：不 park 了，帧还是热的
    // 手指正按着的时候别动位移：拖到一半时轮询回来的那次 render 会把层弹回原位。
    if (!layer.classList.contains('is-dragging')) layer.style.transform = '';
    layer.classList.add('is-open');
  }

  /* 关层但先别 park 帧：hidden 一打，滑下去的就是个空壳。等滑完再把帧交回池子，
     那之前重新打开同一个任务（快路径 + cancelChatPark）它就是热的、不重载。 */
  function closeChatLayer() {
    const layer = $('chat-layer');
    setChatExpanded(false);
    if (!layer) return;
    cancelChatPark();
    layer.style.transform = '';
    layer.classList.remove('is-open');
    const parkedTask = _frameHoldsTask;
    const frame = $('conversation');
    if (!parkedTask || !frame) return;
    _chatParkTimer = setTimeout(() => {
      _chatParkTimer = null;
      // 这 260ms 里可能又开了别的任务、又回到了任务态、或者帧已经被换掉 ——
      // 任何一种都不是「这个帧可以收起来了」。
      if (_frameHoldsTask !== parkedTask || taskId) return;
      if ($('conversation') !== frame) return;
      _framePool.set(parkedTask, { frame, lastUsed: Date.now() });
      parkFrame(frame);
      _frameHoldsTask = null;
      evictFrames();
    }, CHAT_SLIDE_MS);
  }

  function setChatExpanded(expanded) {
    const layer = $('chat-layer');
    if (!layer) return;
    layer.classList.toggle('is-expanded', expanded);
    const button = $('chat-expand');
    if (button) {
      button.setAttribute('aria-pressed', expanded ? 'true' : 'false');
      const action = expanded ? t('airCollapseLayer') : t('airExpandLayer');
      button.title = action;
      button.setAttribute('aria-label', action);
      const text = button.querySelector('.chat-bar-label');
      if (text) text.textContent = expanded ? t('airCollapse') : t('airExpand');
    }
    // 展开是要连页头一起盖掉的，详情抽屉（z-index 15）就更是底下的东西了：
    // 先收掉，免得它从浮层边上露出一条。
    if (expanded) closeDetails();
  }

  function isChatExpanded() { return $('chat-layer')?.classList.contains('is-expanded') ?? false; }

  function toggleChatExpanded() { setChatExpanded(!isChatExpanded()); }

  /* 关掉对话回到目录详情。从目录详情点进来的那些（airChat 标记）直接退回去 ——
     后退键和「关闭」于是是同一条路：回到刚才那一页，而不是在历史里多留一条
     一模一样的目录详情（点十次任务就得多按十次后退，那正是「换台不是换页」
     要避免的东西）。直接落在 ?task=… 上的（书签、通知链接）没有来路可退，
     就把当前这条改写成目录详情。 */
  function dismissChat() {
    saveDraft();
    if (!history.state?.airChat) { navigate(directoryId, null, { replace: true }); return; }
    // 先自己把状态落回「没有对话」再退历史：popstate 要等到下一个 tick，这中间
    // 任何一次 render（比如轮询回来的 entry）都会看见还没清掉的 taskId，把刚滑
    // 下去的浮层重新升起来。render 顺手把浮层滑走、把帧排进池子。
    taskId = null;
    entry = null;
    render();
    history.back();
  }

  /* 手机上这一层是 App 那个底部 sheet 的等价物：往下拖 = 关掉对话。拖到一半
     放开就弹回去，超过四分之一才认。桌面按钮组也能当拖动起点，但按钮自身仍只点。 */
  function wireChatBar() {
    const bar = $('chat-bar');
    const layer = $('chat-layer');
    if (!bar || !layer) return;
    let dragging = false, fromY = 0, offset = 0;
    bar.addEventListener('pointerdown', event => {
      // 按钮上按下的是「点」，不是「拖」。
      if (event.target.closest('button')) return;
      dragging = true;
      fromY = event.clientY;
      offset = 0;
      layer.classList.add('is-dragging');
      // 捕获之后指针移出这条也能收到事件；捕获失败不影响拖拽（只是拖出条身会断）。
      try { bar.setPointerCapture(event.pointerId); } catch (_) { /* 指针已经没了 */ }
    });
    bar.addEventListener('pointermove', event => {
      if (!dragging) return;
      offset = Math.max(0, event.clientY - fromY);       // 只往下拖
      layer.style.transform = `translateY(${offset}px)`;
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      layer.classList.remove('is-dragging');
      if (offset > layer.offsetHeight / 4) {
        // 交给正常的关层：它会在同一帧里摘掉 is-open 并清掉行内位移，于是这一层
        // 从手指停下的地方接着滑出去，而不是先弹回原位再滑一遍。
        dismissChat();
      } else {
        layer.style.transform = '';       // 没到线，弹回去
      }
      offset = 0;
    };
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);
  }

  /* 任务页头和浮层不是两套组件。打开任务时把原来的页头原样搬进浮层；离开任务时
     再放回 notice 前面。节点本身不重建，所以标题编辑、Pin、详情、更多、刷新以及
     各自已经绑定的处理器全部还是同一份。移动 iframe 会触发重载，移动普通 header
     不会；帧池仍只由 mountFrame 管。 */
  function setTaskHeaderInChat(inChat) {
    const header = $('task-header');
    const layer = $('chat-layer');
    const noticeBand = $('notice');
    if (!header || !layer || !noticeBand) return;
    const mounted = header.parentElement === layer;
    if (mounted !== inChat) {
      closeOptions();
      if (inChat) layer.insertBefore(header, layer.firstChild);
      else noticeBand.before(header);
    }
    header.classList.toggle('is-chat-header', inChat);
  }

  function render() {
    if (!data) return;
    const hasTask = !!taskId;
    setTaskHeaderInChat(hasTask);
    renderSetupCard();
    if (!directoryId && taskId) directoryId = data.tasks.find(task => task.id === taskId)?.dirId;
    if (!directoryId || !data.directories.some(directory => directory.id === directoryId)) directoryId = data.directories[0]?.id || null;
    const dir = data.directories.find(directory => directory.id === directoryId);
    $('directory-name').textContent = dir?.name || t('airHeaderNoDirectory');
    $('directory-path').textContent = dir?.path || '';
    $('create').disabled = !dir;
    // 有活在跑的目录也带圈：不必切过去才知道那个目录正忙。
    const busy = runningDirectories();
    applyRing(document.querySelector('.space-card'), busy.has(directoryId), directoryId);
    renderHeader(dir);
    renderDirectories();
    renderDirectoryOverview();
    const adminMode = adminModes.has(mode);
    $('task-sidebar').hidden = adminMode;
    $('directory-library').hidden = mode !== 'library';
    $('admin-center').hidden = !adminMode;
    $('schedule-center').hidden = mode !== 'schedules';
    $('task-layout').hidden = mode === 'library' || mode === 'schedules' || adminMode;
    // Page actions ride in the header (see air.html): one heading band per view.
    $('add-directory').hidden = mode !== 'library';
    $('schedule-create').hidden = mode !== 'schedules';
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

    renderSidebarTasks();
    renderPins();

    // 面板打开时才渲染它的内容：控制台不是页面，所以它不是「当前视图」。
    if (consoleOpen) {
      $('console-here').textContent = dir ? t('airConsoleHere', { name: dir.name }) : '';
      $('console-close').textContent = taskId ? t('airBackToTask') : t('airCloseConsole');
      window.MultiCCAirAdmin?.render('overview', adminContext());
    }

    // #empty 就是「目录详情」这一页，它不再给谁让位：有对话时它是被浮层盖住的那一层，
    // 没对话时它就是页面上唯一的那一层。所以这里只管浮层开不开，不动 #empty —— 它
    // 连 hidden 都不打（滚动位置、筛选、展开状态都靠这一点活着）。
    if (!hasTask) {
      // 关层 = 把这个帧交回池子：滑落完之后藏起来、让它在后台安静下来，但不卸掉 ——
      // 刚看过又点回来的时候它就是热的。此后 #conversation 暂时不在页面上，读它的
      // 地方都写了 ?.。
      closeChatLayer();
      $('delivery-card').hidden = true;
      closeDetails();
    } else {
      // Task identity is resolved by chat-task-boot, but rendering stays on the
      // original full Chat page. Air only supplies a compact light theme.
      openConversation(taskId);
      openChatLayer();
    }
  }

  // 页头那行状态在手机上是跟标题挤同一行的：「任务 进行中」这一段让位，留下
  // 「本轮 …」和「归属待核验」。所以分段返回，由 CSS 决定窄屏藏哪一段；
  // taskStateText 留给需要一整句的地方。
  function taskStateSegments(value) {
    const unstartedPlan = value.task?.recordType === 'planned' && !value.messages?.length
      && !value.execution?.busy && !value.execution?.pending;
    const execution = unstartedPlan ? t('airStatePlanNotStarted')
      : label(value.execution?.pending ? 'waiting' : value.execution?.status || (value.execution?.busy ? 'running' : 'idle'));
    const lifecycle = label(value.task?.status || value.status);
    return [execution && t('airSegExecution', { state: execution }), lifecycle && t('airSegLifecycle', { state: lifecycle })].filter(Boolean);
  }

  function taskStateText(value) {
    return taskStateSegments(value).join(' · ');
  }

  // 分隔符跟着段一起走（「 · 任务 进行中」），藏掉一段时不会留下一个孤零零的「·」，
  // 而且整条的 textContent 仍然和 join(' · ') 一字不差。段和类必须一起过滤：空段
  // 被丢掉时它的类也得跟着走，否则后面的段会捡到前面那个类 —— 生命周期为空时
  // 「归属待核验」会拿到 ts-life，在手机上被当成任务生命周期一起藏掉。
  const STATE_CLASSES = ['ts-run', 'ts-life'];
  function renderStateSummary(button, segments, classes = STATE_CLASSES) {
    const parts = segments.map((text, index) => [text, classes[index]]).filter(part => part[0]);
    button.replaceChildren(...parts.map(([text, cls], index) =>
      node('span', index ? ` · ${text}` : text, cls || null)));
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
      notice(t('airReconcileDone'));
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

  // ── 任务生命周期操作：归档 / 恢复 / 移动 / 删除 ─────────────────────────
  // 后端能力都在 task-board 路由上（status / relocate / DELETE），这里只是把
  // 它们接到任务详情面板。
  const TASK_ACTION_ERRORS = {
    task_busy: t('airErrTaskBusy'),
    task_archived: t('airErrTaskArchived'),
    task_deleting: t('airErrTaskDeleting'),
    title_required: t('airErrTitleRequired'),
    title_too_long: t('airErrTitleTooLong'),
    task_workspace_dirty: t('airErrWorkspaceDirty'),
    task_workspace_unmerged: t('airErrWorkspaceUnmerged'),
    task_session_shared: t('airErrSessionShared'),
    shell_workspace_referenced: t('airErrShellWorkspaceReferenced'),
    task_shell_shared: t('airErrShellShared'),
    carry_apply_failed: t('airErrCarryApplyFailed'),
    active: t('airErrSessionActive'),
    unmerged: t('airErrUnmergedMove'),
  };
  function taskActionError(error) {
    return TASK_ACTION_ERRORS[error?.code || ''] || TASK_ACTION_ERRORS[error?.message || '']
      || TASK_ACTION_ERRORS[(error?.reasons || [])[0] || ''] || error?.message || t('airErrActionFailed');
  }

  function taskDeleteRisks(error) {
    const reasons = new Set([error?.code, error?.message, ...(error?.reasons || [])]);
    return {
      dirty: reasons.has('task_workspace_dirty'),
      unmerged: reasons.has('task_workspace_unmerged'),
    };
  }

  function confirmRiskyTaskDelete(title, error) {
    const risks = taskDeleteRisks(error);
    if (!risks.dirty && !risks.unmerged) return false;
    const findings = [
      ...(risks.dirty ? [t('airDeleteRiskDirty')] : []),
      ...(risks.unmerged ? [t('airDeleteRiskUnmerged')] : []),
    ];
    return window.confirm(t('airDeleteRiskConfirm', { title, findings: findings.join('\n') }));
  }

  // 按钮点击即禁用、回来再放开；错误码统一翻成中文。
  async function taskAction(name, run) {
    const buttons = [...document.querySelectorAll(`[data-action="${name}"]`)];
    buttons.forEach(button => { button.disabled = true; });
    try { await run(); }
    catch (error) { notice(taskActionError(error)); }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  }

  // refresh() 会把 notice 清空（它自己也要报迁移告警），所以成功文案一律在
  // 刷新之后写，否则用户点完什么也看不到。
  async function archiveTask(archive) {
    if (!taskId) return;
    await taskAction(archive ? 'archive' : 'restore', async () => {
      await api(`/api/task-board/tasks/${encodeURIComponent(taskId)}/status`, { status: archive ? 'archived' : 'active' });
      await refresh();
      notice(archive ? t('airTaskArchived') : t('airTaskRestored'));
    });
  }

  async function deleteTaskById(task) {
    const selectedId = task?.id || taskId;
    if (!selectedId) return;
    const title = task?.title || (selectedId === taskId ? entry?.task?.title : '') || selectedId;
    if (!window.confirm(t('airDeleteTaskConfirm', { title }))) return;
    await taskAction('delete', async () => {
      const path = `/api/task-board/tasks/${encodeURIComponent(selectedId)}`;
      try {
        await api(path, undefined, 'DELETE');
      } catch (error) {
        const risks = taskDeleteRisks(error);
        if (!risks.dirty && !risks.unmerged) throw error;
        if (!confirmRiskyTaskDelete(title, error)) return;
        await api(path, { force: true }, 'DELETE');
      }
      // 删除当前打开的任务时先退回目录；从列表删别的任务则留在原地，让筛选和滚动容器继续可用。
      if (selectedId === taskId) navigate(task?.dirId || directoryId);
      await refresh();
      notice(t('airTaskDeleted'));
    });
  }

  async function deleteTask() {
    if (!taskId || !entry) return;
    await deleteTaskById({ id: taskId, dirId: directoryId, title: entry.task?.title });
  }

  // 移动 = 换工作目录。会话工作区在目标仓库重建，未提交改动（含未跟踪的新
  // 文件）以补丁 + 文件复制的方式带走；套用失败时整体回滚、任务留在原处。
  function openMoveDialog() {
    if (!taskId || !data || !entry) return;
    const targets = data.directories.filter(directory => directory.id !== directoryId);
    if (!targets.length) { notice(t('airMoveNoTargets')); return; }
    const dialog = node('dialog', null, 'move-task-dialog');
    const form = node('form');
    form.method = 'dialog';
    form.append(node('span', 'MOVE TASK', 'eyebrow'), node('h2', t('airMoveTitle', { title: entry.task?.title || taskId })));
    form.append(node('p', t('airMoveHint')));
    const list = node('div', null, 'move-task-targets');
    let chosen = null;
    for (const directory of targets) {
      const option = node('label', null, 'move-task-target');
      const radio = node('input');
      radio.type = 'radio'; radio.name = 'move-task-target'; radio.value = directory.id;
      radio.onchange = () => { chosen = directory.id; confirm.disabled = false; };
      const copy = node('span');
      copy.append(node('strong', directory.name), node('small', directory.path));
      option.append(radio, copy);
      list.append(option);
    }
    form.append(list);
    const footer = node('div', null, 'move-task-footer');
    const cancel = node('button', t('cancel'));
    cancel.type = 'submit';
    const confirm = node('button', t('airMoveConfirm'));
    confirm.type = 'button'; confirm.disabled = true; confirm.classList.add('primary');
    confirm.onclick = async () => {
      if (!chosen) return;
      confirm.disabled = true;
      try {
        const result = await api(`/api/task-board/tasks/${encodeURIComponent(taskId)}/relocate`, { dirId: chosen });
        dialog.close();
        const directory = data.directories.find(item => item.id === chosen);
        const carried = result.carried
          ? (result.carried.files ? t('airMoveCarriedWithFiles', { n: result.carried.files }) : t('airMoveCarried'))
          : '';
        await refresh();
        navigate(chosen, taskId);
        notice(t('airMoveDone', { dir: directory?.name || t('airMoveTargetFallback'), carried }));
      } catch (error) {
        notice(taskActionError(error));
        confirm.disabled = false;
      }
    };
    footer.append(cancel, confirm);
    form.append(footer);
    dialog.onclose = () => dialog.remove();
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
  }

  function openTaskTitleDialog() {
    if (!taskId || !entry?.task || document.querySelector('.rename-task-dialog')) return;
    const selectedTaskId = taskId;
    const currentTitle = String(entry.task.title || '').trim();
    const dialog = node('dialog', null, 'rename-task-dialog');
    const form = node('form');
    form.append(node('span', 'TASK TITLE', 'eyebrow'), node('h2', t('airTitleDialogTitle')));
    form.append(node('p', t('airTitleDialogHint')));
    const label = node('label', t('airTitleField'));
    const input = node('input');
    input.name = 'title'; input.type = 'text'; input.required = true; input.maxLength = 40;
    input.autocomplete = 'off'; input.value = currentTitle;
    label.append(input);
    const error = node('p', '', 'rename-task-error');
    error.setAttribute('role', 'alert');
    const footer = node('div', null, 'rename-task-footer');
    const cancel = node('button', t('cancel'));
    cancel.type = 'button'; cancel.onclick = () => dialog.close();
    const save = node('button', t('save'));
    save.type = 'submit'; save.classList.add('primary');
    footer.append(cancel, save);
    form.append(label, error, footer);
    form.onsubmit = async event => {
      event.preventDefault();
      const title = input.value.trim();
      if (!title) { error.textContent = t('airErrTitleRequired'); input.focus(); return; }
      if (title === currentTitle) { dialog.close(); return; }
      input.disabled = true; save.disabled = true; error.textContent = '';
      try {
        const result = await api(`/api/task-board/tasks/${encodeURIComponent(selectedTaskId)}/title`, { title });
        const updated = result.task || { id: selectedTaskId, title };
        if (data?.tasks) {
          const listed = data.tasks.find(task => task.id === selectedTaskId);
          if (listed) Object.assign(listed, updated);
        }
        if (entry?.task?.id === selectedTaskId) Object.assign(entry.task, updated);
        dialog.close();
        render();
        syncFrame();
        notice(t('airTitleUpdated'));
      } catch (cause) {
        error.textContent = taskActionError(cause) || t('airTitleUpdateFailed');
        input.disabled = false; save.disabled = false; input.focus();
      }
    };
    dialog.onclose = () => { $('task-title')?.focus(); dialog.remove(); };
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    input.focus(); input.select();
  }

  function renderDelivery(value) {
    const attribution = value.attribution || {};
    const candidate = attribution.candidate;
    const separation = attribution.separation;
    const run = attribution.run;
    const integration = attribution.integration;
    const capacity = value.resource?.capacityReason;
    const pending = value.execution?.pending;
    const executionStatus = value.execution?.status || (value.execution?.busy ? 'running' : 'idle');
    const running = value.execution?.busy || ['starting', 'running', 'queued'].includes(executionStatus);
    const failed = ['error', 'failed', 'cancelled'].includes(executionStatus);
    const unstartedPlan = value.task?.recordType === 'planned' && !value.messages?.length && !run;
    const currentTitle = value.task.title;
    const targetTitle = separation?.targetTitle || candidate?.title || candidate?.taskName || t('airAttrSuggestedTask');
    const card = $('delivery-card');
    card.hidden = false;

    let eyebrow = t('airAttrEyebrowTurnState');
    let title = t('airAttrTurnRecorded');
    let text = t('airAttrTurnRecordedText');
    const legacyStage = integration?.baselineCurrent ? 3 : integration ? 2
      : run?.outcome === 'succeeded' && !run.pendingInput ? 1 : 0;
    const deliverySteps = Array.isArray(attribution.steps) && attribution.steps.length
      ? attribution.steps.slice(0, 4).map((step, index) => ({
        key: step.key || String(index), label: step.label || DELIVERY_STEP_FALLBACKS[index],
        status: ['done', 'pending', 'blocked', 'skipped'].includes(step.status) ? step.status : 'pending',
      }))
      : DELIVERY_STEP_FALLBACKS.map((label, index) => ({
        key: String(index), label, status: index < legacyStage ? 'done' : 'pending',
      }));

    if (capacity) {
      eyebrow = t('airAttrEyebrowResources');
      title = t('airAttrCapacityTitle', { state: label(capacity) });
      text = t('airAttrCapacityText');
    } else if (pending) {
      eyebrow = t('airAttrEyebrowPending');
      title = t('airAttrPendingTitle');
      text = t('airAttrPendingText');
    } else if (candidate?.state === 'stale' && !separation) {
      eyebrow = t('airAttrEyebrowStale');
      title = t('airAttrStaleTitle');
      text = t('airAttrStaleText');
    } else if (separation?.state === 'separated') {
      eyebrow = t('airAttrEyebrowSeparated');
      title = t('airAttrSeparatedTitle', { title: targetTitle });
      text = t('airAttrSeparatedText');
    } else if (separation?.state === 'kept') {
      eyebrow = t('airAttrEyebrowKept');
      title = t('airAttrKeptTitle');
      text = t('airAttrKeptText');
    } else if (separation) {
      eyebrow = separation.phase === 'blocked' ? t('airAttrEyebrowSepBlocked') : t('airAttrEyebrowSepSuggest');
      title = separation.phase === 'blocked' ? t('airAttrSepBlockedTitle', { title: targetTitle }) : t('airAttrSepSuggestTitle', { title: targetTitle });
      const firstBlocker = attribution.blockers?.find(reason => reason !== 'separation_application_required');
      text = separation.phase === 'blocked'
        ? (blockerNames[firstBlocker] || separation.lastError?.message || t('airAttrSepBlockedFallback'))
        : t('airAttrSepSuggestText');
    } else if (candidate && running) {
      eyebrow = t('airAttrEyebrowRunning');
      title = t('airAttrRunningTitle');
      text = t('airAttrRunningText', { target: targetTitle, current: currentTitle });
    } else if (candidate && (run?.outcome !== 'succeeded' || run?.pendingInput)) {
      eyebrow = t('airAttrEyebrowNotEligible');
      title = t('airAttrNotEligibleTitle');
      text = t('airAttrNotEligibleText', { target: targetTitle });
    } else if (candidate && !integration) {
      eyebrow = t('airAttrEyebrowAwaitDelivery');
      title = t('airAttrSuggestTitle', { title: targetTitle });
      text = t('airAttrAwaitDeliveryText');
    } else if (candidate && !integration?.baselineCurrent) {
      eyebrow = t('airAttrEyebrowDeliveryRecheck');
      title = t('airAttrSuggestTitle', { title: targetTitle });
      text = t('airAttrDeliveryRecheckText');
    } else if (candidate) {
      eyebrow = t('airAttrEyebrowDeliveryVerified');
      title = t('airAttrVerifiedWaitingTitle', { title: targetTitle });
      text = t('airAttrDeliveryVerifiedText');
    } else if (running) {
      eyebrow = t('airAttrEyebrowRunning');
      title = t('airAttrExecutingTitle');
      text = t('airAttrExecutingText');
    } else if (failed || (run && run.outcome !== 'succeeded')) {
      eyebrow = t('airAttrEyebrowTurnFailed');
      title = t('airAttrTurnFailedTitle');
      text = t('airAttrTurnFailedText');
    } else if (run) {
      eyebrow = t('airAttrEyebrowTurnResult');
      title = integration ? t('airAttrRunOkIntegrated') : t('airAttrRunOkKept');
      text = integration ? t('airAttrRunOkIntegratedText') : t('airAttrRunOkKeptText');
    } else {
      eyebrow = unstartedPlan ? t('airAttrEyebrowPlanned') : t('airAttrEyebrowNextStep');
      title = unstartedPlan ? t('airAttrPlanNotRun') : t('airAttrTaskReady');
      text = unstartedPlan
        ? t('airAttrPlanNotRunText')
        : t('airAttrTaskReadyText');
    }

    $('delivery-eyebrow').textContent = eyebrow;
    $('delivery-title').textContent = title;
    $('delivery-text').textContent = text;
    const summary = $('task-state');
    const separationPending = separation && !['kept', 'separated'].includes(separation.state);
    const attention = !!(capacity || pending || candidate || separationPending || failed);
    summary.classList.toggle('attention', attention);
    // 第三段是附注，两种附注在手机上待遇不同（air.css 的 760px 块）：卡在资源上
    // 的那条（等待执行名额）说的是「为什么现在没动」，留着；「归属待核验」说的是
    // 「这条以后归到哪个任务」，占地方，手机上让位。所以类得分开，不能共用一个。
    const thirdClass = capacity ? 'ts-cap' : candidate || separationPending ? 'ts-attr' : null;
    renderStateSummary(summary, [...taskStateSegments(value),
      capacity ? label(capacity) : separationPending ? t('airAttrSepPending') : candidate ? t('airAttrPendingVerify') : ''], [...STATE_CLASSES, thirdClass]);
    summary.title = t('airAttrSummaryTitle', { title, text });
    $('delivery-destination').textContent = separation?.state === 'separated' && separation.targetTaskId === value.task.id
      ? t('airAttrDestinationSeparated', { title: currentTitle })
      : t('airAttrDestinationNext', { title: currentTitle });
    const steps = [...$('delivery-steps').children];
    steps.forEach((step, index) => {
      const item = deliverySteps[index] || { label: step.textContent, status: 'pending' };
      step.textContent = item.label;
      step.dataset.step = item.key;
      for (const name of ['done', 'current', 'blocked', 'skipped']) step.classList.remove(name);
      if (item.status === 'done') step.classList.add('done');
      else if (item.status === 'blocked') step.classList.add('blocked');
      else if (item.status === 'skipped') step.classList.add('skipped');
      else if (deliverySteps.slice(0, index).every(previous => ['done', 'skipped'].includes(previous.status))) step.classList.add('current');
    });
    const actions = [];
    if (integration) actions.unshift(actionButton(t('airReconcileDelivery'), reconcileDelivery, 'reconcile'));
    if (['kept', 'separated'].includes(separation?.state) && separation.targetTaskId && separation.targetTaskId !== value.task.id) {
      actions.push(actionButton(separation.state === 'separated' ? t('airOpenSeparatedTask') : t('airOpenRelatedTask'),
        () => navigate(value.task.dirId || directoryId, separation.targetTaskId), 'open-separated'));
    }
    // “留在当前会话”只决定壳，不撤销已经拆出的任务 ID。关联任务自己的
    // 详情页因此始终保留签出入口，之后任何时候都能迁到独立会话。
    if (separation?.state === 'kept' && separation.targetTaskId === value.task.id && value.sessionId) {
      actions.push(actionButton(t('airCheckoutSeparateSession'),
        () => decideSeparation(value, separation, 'separate'), 'separation-accept'));
    }
    // 分离建议的持久入口：聊天帧里的弹窗/挂起卡依赖 WS 推送与页面时机，容易
    // 错过；这里的按钮只要建议还挂起就一直在，瞬时拒绝（如源任务在跑）后也能
    // 直接重试。只在查看源任务时显示 —— 决定落在源会话上。
    if (separation && !['kept', 'separated'].includes(separation.state)
        && separation.sourceTaskId === value.task.id && value.sessionId) {
      actions.push(actionButton(separation.phase === 'blocked' ? t('airRetryCheckout') : t('airCheckoutSeparateSession'),
        () => decideSeparation(value, separation, 'separate'), 'separation-accept'));
      actions.push(actionButton(t('airSepDefer'),
        () => decideSeparation(value, separation, 'defer'), 'separation-defer'));
      actions.push(actionButton(t('airSepKeep'),
        () => decideSeparation(value, separation, 'keep'), 'separation-keep'));
    }
    $('delivery-actions').replaceChildren(...actions);
  }

  async function decideSeparation(value, separation, decision) {
    await taskAction(`separation-${decision}`, async () => {
      let result;
      try {
        result = await api(`/api/sessions/${encodeURIComponent(value.sessionId)}/task-separation/${encodeURIComponent(separation.id)}`, { decision });
      } catch (error) {
        // 分离错误码与交付卡 blocker 共用一套文案，比裸英文 message 可读。
        throw Object.assign(error, { message: blockerNames[error?.code] || taskActionError(error) });
      }
      if (decision === 'separate' && result?.taskId) {
        navigate(value.task.dirId || directoryId, result.taskId);
        notice(t('airSeparatedCreated', { title: separation.targetTitle || '' }));
        return;
      }
      await refreshEntry();
      notice(decision === 'defer' ? t('airSepDeferred') : t('airSepKept'));
    });
  }

  function renderDetails(value) {
    const attribution = value.attribution || {};
    const roleText = value.roleBindings
      ? (value.roleBindings.bindings.map(binding => binding.name).join(t('airRoleSeparator')) || t('airNoAttachedRoles')) + t('airRoleVersion', { n: value.roleBindings.version })
      : value.configuration.rolePresetId || t('airTaskConfig');
    const groups = [
      detailGroup(t('airDetailPlanLifecycle'), [
        [t('airDetailTaskId'), value.task.id],
        [t('airDetailTaskType'), value.task.recordType === 'planned' ? t('airDirStatPlanned') : t('airDetailTaskTypeExec')],
        [t('airDetailStage'), value.task.recordType === 'planned' ? label(value.task.workflowStage) || t('airStageInbox') : '—'],
        [t('airDetailStatus'), label(value.task.status || value.status)],
        [t('airDetailAccess'), value.readOnly ? t('airDetailReadOnly') : t('airDetailWritable')],
      ]),
      detailGroup(t('airDetailCodeDelivery'), [
        [t('airDetailTurnResult'), attribution.run ? `${label(attribution.run.outcome)}${attribution.run.pendingInput ? t('airDetailWaitingAnswer') : ''}` : t('airDetailNoTurnResult')],
        [t('airDetailCodeRevision'), attribution.run?.codeObserved ? t('airDetailCodeObserved') : t('airDetailUnverified')],
        [t('airDetailDeliveryState'), attribution.integration ? (attribution.integration.baselineCurrent ? t('airDetailMergedValid') : t('airDetailMergeRecheck')) : t('airDetailNoMergeProof')],
        [t('airDetailSourceSite'), attribution.barrier ? t('airDetailWriterStopped') : t('airDetailNoBarrier')],
        [t('airDetailAttribution'), attribution.application ? t('airDetailCheckedOut', { id: attribution.separation?.targetTaskId || '' })
          : attribution.separation?.state === 'kept' ? t('airDetailSplitKept')
            : attribution.separation ? t('airDetailSplitPending') : attribution.steps?.[3]?.status === 'done' ? t('airDetailLockedAtAdmission') : t('airDetailUnverified')],
      ]),
      detailGroup(t('airDetailRolesContext'), [
        [t('airDetailRoleAttachments'), roleText],
        [t('airDetailEffectScope'), t('airDetailNextMessageOnly')],
        [t('airDetailNativeContext'), t('airDetailRoleKeepsHistory')],
      ]),
      detailGroup(t('airDetailResources'), [
        [t('airDetailDirectory'), value.resource.path || t('airDetailPreparedOnFirstRun')],
        [t('airDetailBranch'), value.resource.branch || t('airDetailNotCreated')],
        [t('airDetailResourceState'), resourceText(value.resource)],
        [t('airDetailRunSource'), value.sessionId],
      ]),
    ];
    if (value.task.description || value.task.acceptanceCriteria) {
      const plan = node('div', null, 'detail-plan-copy');
      if (value.task.description) plan.append(node('strong', t('airDetailTaskDescription')), node('p', value.task.description));
      if (value.task.acceptanceCriteria) plan.append(node('strong', t('airDetailAcceptance')), node('p', value.task.acceptanceCriteria));
      groups[0].append(plan);
    }
    const blockers = candidateBlockers(value);
    if (blockers.length) {
      const list = node('ul');
      blockers.forEach(reason => list.append(node('li', blockerNames[reason] || reason)));
      groups[1].append(list);
    }
    const actions = node('div', null, 'detail-actions');
    if (attribution.integration) actions.append(actionButton(t('airReconcileMergeRecord'), reconcileDelivery, 'reconcile'));
    if (value.roleBindings && !value.readOnly) {
      actions.append(actionButton(t('airEditRoleContext'), () => window.MultiCCAirRoles.open({ taskId, roleBindings: value.roleBindings, api, onSaved: refreshEntry })));
    }
    const lifecycleStatus = value.task.status || value.status;
    actions.append(lifecycleStatus === 'archived'
      ? actionButton(t('airRestoreTask'), () => archiveTask(false), 'restore')
      : actionButton(t('airArchiveTask'), () => archiveTask(true), 'archive'));
    if (!value.readOnly) actions.append(actionButton(t('airMoveToOtherDir'), openMoveDialog, 'move'));
    const removeAction = actionButton(t('airDeleteTask'), deleteTask, 'delete');
    removeAction.classList.add('danger');
    actions.append(removeAction);
    if (actions.childElementCount) groups[groups.length - 1].append(actions);
    $('task-detail-groups').replaceChildren(...groups);
  }

  function candidateBlockers(value) {
    const blockers = value.attribution?.blockers;
    if (Array.isArray(blockers)) return blockers;
    return value.attribution?.candidate?.blockers || [];
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
    // The pills wear the composer module's skin, same as the new-task form's
    // (air.html). Without `mc-composer__pill` they fall back to the browser's
    // default button — square, unspaced, and missing the ◆ that marks the AI
    // route — which is what made the band look misaligned whenever it appeared.
    for (const [id, variant] of [['air-ai-pill', 'mc-composer__pill--ai'], ['air-role-pill', 'mc-composer__pill--role']]) {
      const pill = doc.createElement('button');
      pill.id = id;
      pill.className = `mc-composer__pill ${variant}`;
      pill.type = 'button';
      pill.hidden = true;
      row.append(pill);
    }
    input.before(row);
    return row;
  }

  function composerControls() {
    const doc = $('conversation')?.contentDocument;
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
    // 待生效那份配置里的 provider 是 id；服务端随 pending 下发了解析好的
    // providerName（见 src/workspace/air-routes.js），名字就在这儿用，没有名字
    // 才退回 id —— 不然下一轮生效的那条线路在药丸上是一串 UUID。
    const routeName = shown?.providerSelection?.mode === 'auto'
      ? `Auto ${shown.providerSelection.protocol}`
      : providerDisplayName((pending?.providerName || shown?.providerName || shown?.provider) || '') || t('airQuickDefaultRoute');
    ai.hidden = !entry?.sessionId;
    ai.disabled = !entry || entry.readOnly;
    ai.title = t('airTaskAiTitle');
    const roleCount = entry?.roleBindings?.bindings?.length || 0;
    role.hidden = !entry?.roleBindings;
    role.disabled = !entry || entry.readOnly;
    role.textContent = roleCount ? t('airQuickRoleCount', { n: roleCount }) : t('airQuickAddRole');
    role.title = t('airTaskRoleTitle');
    // 先把这条带子显出来再量宽度：隐藏时量到的 clientWidth 是 0，那样跑马灯得
    // 等到下一次轮询才启动，看上去就是「卡了一下」。
    setComposerBand(doc, row, !ai.hidden || !role.hidden);
    setPillText(ai, shown
      ? [shown.cli, routeName,
        (pending ? shown.model : shown.effectiveModel || shown.model) || t('airQuickDefaultModel'),
        pending ? t('airTaskAiPending') : ''].filter(Boolean).join(' · ')
      : '');
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
    // `?.` 不是多余的：帧交回池子之后（关层滑完那一下）ID 就被摘了，而这一手还
    // 可能被一次迟到的 load 事件叫起来。
    const doc = $('conversation')?.contentDocument;
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
        ? t('airComposerPlaceholderPlan', { title: entry.task.title })
        : t('airComposerPlaceholderNext', { title: entry.task.title });
    }
  }

  async function refreshEntry() {
    const selected = taskId;
    if (!selected) return false;
    const path = `/api/air/tasks/${encodeURIComponent(selected)}`;
    // 条件请求的前提是「上一份正文还在手上」。entry 会被 navigate / popstate /
    // dismissChat 清掉，ETag 却还留在表里：那时照旧带上 If-None-Match，服务端回
    // 304，客户端既没有正文可画、又不肯再要一次，页头就永远停在「正在读取任务…」
    // —— 状态行和 composer 上的 AI/角色胶囊一起空着，直到这条任务下次真的变了。
    // 手里没有它的 entry，就先忘掉那个校验符，换一次真身回来。
    if (entry?.task?.id !== selected) resourceEtag.delete(path);
    try {
      const result = await apiConditional(path);
      // 详情里 3.2MB 是消息正文；没变就别解析、别重建会话区（返回 false =
      // 「没变」，null = 「这次读失败」，调用方据此决定要不要重画和退避）。
      if (result.unchanged) return false;
      if (taskId !== selected) return;
      entry = result;
      // 直接打开一个任务（书签、通知链接、刷新）和从列表里点进去一样，都是「打开过」。
      // 不在这儿记一笔，「最近」在刚进页面时就是空的。只有排序真的变了才重画。
      //
      // 例外：从侧栏点开的那条，换位已经排进它自己那两拍里了（openSidebarTask 让
      // navigate 先别记，REORDER_LIFT_MS 之后再记）。详情回来得比那一拍快是常态，
      // 这里再插一手，等于把它打回「瞬间跳到顶上」——那一拍得让路，谁在等这条
      // 记录，谁就把它记完。
      if (recentTaskIds[0] !== selected && pendingReorderId !== selected) { rememberTask(selected); render(); }
      $('task-title').textContent = entry.task.title;
      applyTaskTitleEditing(entry.task);
      $('task-state').textContent = taskStateText(entry);
      renderDelivery(entry);
      renderDetails(entry);
      syncFrame();
      return true;
    } catch (error) {
      if (taskId === selected) notice(error.message);
      return null;
    }
  }

  async function refresh() {
    if (loading) return;
    loading = true;
    let failed = false;
    try {
      const snapshot = await apiConditional('/api/air');
      if (!snapshot.unchanged) {
        data = snapshot;
        // Pin 的清单随快照一起来（不用为它多打一次接口）。顺序就是页头从左到右的顺序。
        taskPins = Array.isArray(data.taskPins) ? data.taskPins.slice() : [];
        pinSignature = '';
        // 「随时更新成最近使用」的落点：每次快照都把 lastRuntime 灌进新任务胶囊，
        // 除非用户面前正摆着一份手挑的配置（quickRuntimeDirty）。刷新可能来自任何
        // 地方的任何动作，不能因为它把人刚选好的线路冲回几小时前那套。
        if (data.lastRuntime && !quickRuntimeDirty) {
          quickRuntime = { ...data.lastRuntime };
          renderQuickPills();
        }
        notice(data.migration?.errors?.length ? t('airMigrationPending', { n: data.migration.errors.length }) : '');
        // 统一事件源：这轮快照里刚翻终态且未打开的任务，会驱动侧边栏高亮、语音、
        // 浮动完成条三处消费。置于 render() 之前，未读标记才能随本轮绘制即时生效。
        taskNotify?.onSnapshot(data.tasks, taskId);
        render();
      }
      // 快照没变不等于对话没变：任务详情有自己的 ETag，照旧问一次（多半也是 304）。
      const entryChanged = await refreshEntry();
      if (entryChanged === null) failed = true;
      // 定时任务与控制台概览只在真的有新数据时重画，否则每 4 秒白建一遍 DOM。
      if (snapshot.unchanged && !entryChanged) return;
      if (mode === 'schedules' || consoleOpen) await refreshSchedules();
      if (consoleOpen) window.MultiCCAirAdmin?.render('overview', adminContext());
    } catch (error) { failed = true; notice(error.message); }
    finally { if (failed) pollFailures++; else pollFailures = 0; loading = false; }
  }

  function adminContext() {
    return {
      data, scheduleTasks, api, setMode, navigate, notice, directoryName,
      deleteTask: task => deleteTaskById(task),
      // 中文词表只有一份（stateNames）：面板要说的状态词跟侧栏是同一批，
      // 传下去比在 air-admin.js 里再抄一份可靠。
      label,
      openConsole: () => setConsole(true),
      closeConsole: () => setConsole(false),
      // 「谁在等我」整页读的是外壳这份 /api/air 快照，刷新也只能由外壳去做 ——
      // 让它自己再打一个接口就等于给控制台造了第二份口径。
      refresh: () => refresh(),
    };
  }

  window.MultiCCAirAdmin?.bindServiceDialog(adminContext());
  // The sidebar card is the current directory, so it opens that directory's own
  // task page — the full directory library stays on ⌘K and 控制台 › 浏览工作目录.
  $('library').onclick = () => (directoryId ? navigate(directoryId) : setMode('library'));
  $('overview').onclick = () => setConsole(!consoleOpen);
  $('directory-task-more').onclick = () => {
    directoryTasksExpanded = !directoryTasksExpanded;
    renderDirectoryOverview();
    if (directoryTasksExpanded) requestAnimationFrame(() => $('directory-task-search').focus());
  };
  $('directory-task-search').oninput = event => {
    directoryTaskFilter.query = event.target.value;
    renderDirectoryOverview();
    $('directory-task-search').focus();
  };
  $('directory-task-status').onchange = event => {
    directoryTaskFilter.status = event.target.value;
    renderDirectoryOverview();
  };
  $('console-close').onclick = () => setConsole(false);
  $('console-scrim').onclick = () => setConsole(false);
  $('palette-scrim').onclick = () => closePalette();
  $('palette-input').oninput = () => { paletteIndex = 0; renderPalette(); };
  $('schedules').onclick = () => setMode('schedules');
  document.querySelectorAll('[data-air-view]').forEach(button => { button.onclick = () => setMode(button.dataset.airView); });

  // ── 常用设置里的「关盖运行」 ───────────────────────────────────────────
  // 设置中心 › 全局配置里那个开关的快捷版：点一下直接切，不用先跳页。这一行只在
  // macOS 且读得到状态时才出现 —— 非 macOS 的 /api/settings/power 答 available:false，
  // 接口打不通（旧服务、未登录）也一律当不支持：宁可少一行，也不要摆一个点了没
  // 反应的按钮。状态读取是 best-effort，失败不弹错误（侧栏不是报错的地方）。
  const lidSleepRow = $('air-lid-sleep');
  let lidSleepBusy = false;
  function paintLidSleep(enabled) {
    lidSleepRow.classList.toggle('on', !!enabled);
    lidSleepRow.setAttribute('aria-pressed', String(!!enabled));
    lidSleepRow.title = enabled ? t('airLidSleepOnTitle') : t('airLidSleepOffTitle');
  }
  async function loadLidSleepRow() {
    if (!lidSleepRow) return;
    try {
      const status = await api('/api/settings/power');
      if (!status.available) { lidSleepRow.hidden = true; return; }
      paintLidSleep(status.enabled);
      lidSleepRow.hidden = false;
    } catch (_) { lidSleepRow.hidden = true; }
  }
  async function toggleLidSleep() {
    if (lidSleepBusy) return;
    lidSleepBusy = true;
    const wanted = !lidSleepRow.classList.contains('on');
    // 先动开关：授权框弹在 Mac 上的时候，它不该还停在旧状态上装没反应。
    paintLidSleep(wanted);
    try {
      const result = await api('/api/settings/power', { enabled: wanted }, 'POST');
      paintLidSleep(result.enabled);
      notice(t(result.enabled ? 'airLidSleepOn' : 'airLidSleepOff'));
    } catch (error) {
      // 失败退回原状态：开关不能替服务点头。
      paintLidSleep(!wanted);
      notice(t('airLidSleepFailed', { msg: error.message }));
    } finally { lidSleepBusy = false; }
  }
  if (lidSleepRow) lidSleepRow.onclick = () => { void toggleLidSleep(); };
  // 展开「更多与系统」时对一次状态：这个开关在别处（设置中心、manage 页）也能改。
  const sideMore = $('side-more');
  if (sideMore) sideMore.addEventListener('toggle', () => { if (sideMore.open) void loadLidSleepRow(); });
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
    catch (error) { notice(t('airReloadConversationFailed', { msg: error.message })); }
  }
  $('refresh').onclick = async () => {
    await refresh();
    if (adminModes.has(mode)) await window.MultiCCAirAdmin?.refresh(adminContext());
    reloadConversation();
  };
  $('mobile-nav').onclick = toggleNav;
  $('nav-scrim').onclick = closeNav;
  $('task-options').onclick = toggleOptions;
  $('task-title').ondblclick = event => {
    event.preventDefault();
    openTaskTitleDialog();
  };
  $('task-title').onkeydown = event => {
    if (!['Enter', 'F2'].includes(event.key)) return;
    event.preventDefault();
    openTaskTitleDialog();
  };
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
  function dismissOnFrame(frame = $('conversation')) {
    try {
      frame?.contentDocument?.addEventListener('pointerdown', closeOptions, true);
      frame?.contentDocument?.addEventListener('click', closeOptions, true);
    } catch { /* 跨源时读不到，浮层就只认外面这一份 document */ }
  }
  // 帧的 load 接线都在 wireConversationFrame 里：池子里的每个帧都要接，不只是最初这一个。
  wireConversationFrame($('conversation'));
  dismissOnFrame();
  // 浮层自己的两颗按钮与拖柄。按钮走 click 而不是 pointerup：拖柄认的是位移，
  // 按钮认的是「点」，混在一起会让「按住展开键稍微划一下」变成拖拽。
  $('chat-expand').onclick = toggleChatExpanded;
  $('chat-close').onclick = dismissChat;
  wireChatBar();
  // 回到桌面宽度，工具又摆回那一行（浮层的样式只在 760px 以下生效）。留着这个类
  // 会让下一次变窄时菜单凭空弹出来。
  matchMedia('(min-width: 761px)').addEventListener('change', event => {
    if (event.matches) closeOptions();
    // 「最近任务」列几条跟着屏宽走（recentRowLimit），跨过这条线得重新渲染一次，
    // 否则横竖屏一切回来列表长度还是旧的那个。但只有目录首页用得上这个数 ——
    // 任务开着的时候那一页没渲染，而这一趟 render 会拿列表里的任务重画页头，
    // 把只在详情里才有的东西（本轮归属那一段）抹掉。
    // 760px 这条线还管着两件事：页头那排 pin tab 在手机宽度整个藏掉、pin 的任务
    // 改在侧栏置顶。这两个都不用重画页头那一段（也就不会碰 title），单独刷。
    if (!taskId) render();
    else { renderPins(); renderSidebarTasks(); }
  });
  $('add-directory').onclick = () => window.MultiCCAirSettings.directory(async directory => { await refresh(); navigate(directory.id); });
  // 首启配置卡的两个入口各自直达对应设置页；跳过只藏卡，配置状态仍以下一次
  // 查询为准（换浏览器/换设备时该出现的还会出现）。
  $('setup-provider').onclick = () => setMode('provider');
  $('setup-aux').onclick = () => setMode('aux');
  $('setup-dismiss').onclick = () => {
    setupDismissed = true;
    try { localStorage.setItem('air:setup-dismissed', 'true'); } catch (_) {}
    renderSetupCard();
  };
  void refreshAuxConfigured();
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
    return $('conversation')?.contentDocument?.getElementById(id) || null;
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
  $('pin-task').onclick = () => { void togglePin(taskId); };
  $('details-toggle').onclick = () => toggleDetails();
  // The conversation frame's chat page owns the More menu (items, handlers,
  // popover layer). The task-header trigger just reaches into that same-origin
  // frame to open/close it; the menu anchors itself to the frame's top-right,
  // visually dropping from this header.
  function frameMoreController() {
    return $('conversation')?.contentWindow?.__multiccAirHeaderMore || null;
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
    // 点开的 pin 详情卡片：点别处就收（点自己那一条不算，那由 .pin-open 自己收）。
    if (!event.target.closest('#task-pins .pin-tab')) closePinPanels();
    if (event.target.closest('#chat-more')) return;
    const controller = frameMoreController();
    if (controller?.close) controller.close();
    $('chat-more').setAttribute('aria-expanded', 'false');
  });
  $('task-state').onclick = () => toggleDetails();
  $('details-close').onclick = closeDetails;
  window.__multiccAirDeleteCurrentTask = () => deleteTask();
  $('schedule-create').onclick = () => openScheduleDialog();
  $('schedule-close').onclick = () => $('schedule-dialog').close();
  $('schedule-cancel').onclick = () => $('schedule-dialog').close();
  $('schedule-form').onsubmit = saveSchedule;
  $('schedule-presets').onclick = event => {
    const preset = event.target.closest('[data-cron]');
    if (preset) $('schedule-form').elements.cron.value = preset.dataset.cron;
  };
  // 侧栏那颗「＋ 新任务」开的不是一张表单，是把目录首页那个统一输入框模块搬进
  // 弹窗（见 openNewTaskComposer）—— 任务名取正文第一行，创建完直接执行。
  $('create').onclick = openNewTaskComposer;
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
      if (document.querySelector('#task-pins .pin-tab.is-open')) { closePinPanels(); return; }
      // 对话浮层也在这条链上，而且是最后让位的那一层：展开态先收回默认（页头回来），
      // 再 Esc 才关掉整个对话 —— 跟「一层一层地退」一个意思，只是这一层自己有两档。
      if (isChatExpanded()) { setChatExpanded(false); return; }
      // 任务详情是挂在页头右边、压在对话浮层上面的一格（z-index 15 > 浮层 14），
      // 也是刚刚才点开的那一层：最后打开的最先退，所以它排在对话前面。反过来先关
      // 掉背后的对话，这一格还留在原地 —— 看上去就像 Esc 什么都没关。
      if (!$('task-details').hidden) { closeDetails(); return; }
      if (taskId) { dismissChat(); return; }
      closeNav(); closeDetails(); frameMoreController()?.close(); $('chat-more').setAttribute('aria-expanded', 'false');
    }
  });
  window.addEventListener('popstate', () => {
    saveDraft();
    const params = readRouteParams();
    taskId = params.get('task');
    directoryId = params.get('dir');
    mode = modeFrom(params);
    entry = null;
    closeDetails();
    closePalette();
    // 后退/前进要如实反映地址：?view=overview 就是「控制台开着」。
    applyConsole(['overview', 'activity'].includes(params.get('view')));
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
    if (stopped || currentEpoch !== epoch) return;
    // 后台标签页不用盯着 4 秒；连续失败则退避，避免服务端打嗝时继续被敲。
    const base = document.hidden && data ? POLL_HIDDEN_MS : POLL_MS;
    const delay = pollFailures ? Math.min(base * 2 ** pollFailures, POLL_MAX_MS) : base;
    timer = setTimeout(() => poll(currentEpoch), delay);
  }
  void loadLidSleepRow();
  void poll();
})();
