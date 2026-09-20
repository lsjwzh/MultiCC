(function () {
  'use strict';

  const $ = id => document.getElementById(id);
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
  const POLL_HIDDEN_MS = 15000;
  const POLL_MAX_MS = 30000;
  let quickCreateAttempt = null;
  let directoryTasksExpanded = false;
  const directoryTaskFilter = { query: '', status: 'open' };

  const stateNames = {
    active: '进行中', succeeded: '成功', unknown: '结果待核验', failed: '失败', error: '失败', cancelled: '已取消',
    workspace_execution_capacity: '等待执行名额', workspace_resident_capacity: '等待目录容量',
    workspace_restore_capacity: '等待目录准备名额', planned: '执行时准备目录', resident: '目录已准备',
    retained: '目录已保留', hibernated: '目录已休眠', reserved: '准备执行', materializing: '正在准备目录',
    starting: '正在启动', running: '执行中', uncertain: '等待核实执行状态', idle: '空闲', queued: '排队中',
    waiting: '等待回答', archived: '已归档', stale: '建议已过期',
    // 工作流阶段（src/task-board/planning.js WORKFLOW_STAGES）五个都要有词：任务行
    // 会把阶段当补充信息写在徽标后面，漏一个就有一行蹦出英文。
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
    separation_application_required: '独立任务尚未创建并记录生效凭证。',
    fork_source_dirty: '源工作目录仍有未交付修改，暂不能分离。',
    fork_source_busy: '源任务仍在执行，等本轮结束后再分离。',
    workspace_busy: '源工作目录仍有写入者，暂不能建立停写屏障。',
    separation_barrier_unavailable: '当前运行时不支持分离停写屏障。',
    delivery_evidence_unavailable: '当前运行时无法读取交付事实。',
    separation_application_unavailable: '当前运行时无法写入分离生效凭证。',
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
    try {
      const config = await api('/api/aux/config');
      auxConfigured = !!config.providerId;
    } catch (_) { return; }   // 查不到就维持现状，不把卡藏起来也不弹错误
    renderSetupCard();
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
    if (conditional) {
      const etag = response.headers.get('etag');
      if (etag) resourceEtag.set(path, etag);
      else resourceEtag.delete(path);
    }
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
  function directoryName(id) { return data?.directories.find(directory => directory.id === id)?.name || '未知目录'; }

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
        node('small', `${taskCount} 个任务${activeCount ? ` · ${activeCount} 个执行中` : ''}`));
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
    const filtered = window.MultiCCAirAdmin?.filterTasks?.(tasks, directoryTaskFilter, () => '')
      || [...tasks].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    const rows = directoryTasksExpanded
      ? filtered
      : [...tasks].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).slice(0, recentRowLimit());
    $('directory-task-heading').textContent = directoryTasksExpanded ? '全部任务' : '最近任务';
    $('directory-overview-count').textContent = directoryTasksExpanded
      ? `${filtered.length} / ${tasks.length} 个任务`
      : `${tasks.length} 个任务`;
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
      copy.append(node('strong', task.title || '未命名任务'), meta);
      button.append(node('span', task.recordType === 'planned' ? '◇' : '›', 'directory-task-mark'), copy,
        node('time', task.updatedAt ? new Date(task.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''));
      button.onclick = () => navigate(directoryId, task.id);
      const remove = node('button', '删除', 'task-delete danger');
      remove.type = 'button';
      remove.dataset.action = 'delete';
      remove.setAttribute('aria-label', `删除任务 ${task.title || '未命名任务'}`);
      remove.onclick = event => { event.stopPropagation(); void deleteTaskById(task); };
      row.append(button, remove);
      return row;
    }));
    if (!rows.length) $('directory-task-list').append(node('p', '这里还没有任务。可以直接在下方描述第一个目标。', 'directory-task-empty'));
    // 截掉的那些得有个去处，否则「最近任务」看着就是全部。数字用的是这个目录
    // 的全部任务数，不是剩下的条数 —— 说的是「还有多少」，不是「还差几行」。
    const more = $('directory-task-more');
    more.hidden = !directoryTasksExpanded && tasks.length <= rows.length;
    more.textContent = directoryTasksExpanded ? '收起，返回最近任务' : `查看全部 ${tasks.length} 个任务 ›`;
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
    if (!status.upstream) { notice('这个仓库没有上游分支，先设好 remote/上游再推。'); return; }
    if (!status.ahead) { notice('没有待推送的提交。'); return; }
    const ahead = status.ahead;
    const branch = status.branch || '当前分支';
    const dialog = node('dialog', null, 'push-repo-dialog');
    const form = node('form');
    form.append(node('span', 'GIT PUSH', 'eyebrow'), node('h2', '推送到远端？'));
    form.append(node('p', `把 ${branch} 上的 ${ahead} 个提交推送到 ${status.upstream}。只推已经提交的内容，工作区里的文件不动。`));
    const error = node('p', '', 'push-repo-error');
    error.setAttribute('role', 'alert');
    const footer = node('div', null, 'push-repo-footer');
    const cancel = node('button', '取消');
    cancel.type = 'button';
    cancel.onclick = () => dialog.close();
    const confirm = node('button', `推送 ${ahead} 个提交`);
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
          ? `已推送 ${result.before?.ahead ?? ahead} 个提交到 ${status.upstream}。`
          : '没有待推送的提交。');
        // 推完这一颗就该变成「已与上游同步」：作废时间戳，让下一笔重新读。
        directoryGitView.fetchedAt = 0;
        await loadDirectoryGit();
      } catch (cause) {
        error.textContent = `Push 失败：${cause.message}`;
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
      brief.replaceChildren(node('p', `读取 Git 状态失败：${directoryGitView.error}`, 'directory-git-empty error'));
      if (note) note.textContent = '读取失败';
      if (list) list.hidden = true;
      return;
    }
    const status = directoryGitView.status;
    if (!status) {
      brief.replaceChildren(node('p', '正在读取 Git 状态…', 'directory-git-empty'));
      if (note) note.textContent = '读取中…';
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
        ? (status.ahead ? `↑ ${status.ahead} 个提交未推送` : '已与上游同步')
        : (status.ahead ? `↑ ${status.ahead} 个提交未合入 ${status.baseBranch}` : `与基分支 ${status.baseBranch} 一致`);
      if (pushable) {
        const push = node('button', null, 'directory-git-chip warn is-action');
        push.type = 'button';
        push.title = `把这 ${status.ahead} 个提交推送到 ${status.upstream}`;
        push.setAttribute('aria-label', push.title);
        push.append(node('span', aheadText), node('span', '推送', 'directory-git-chip-hint'));
        push.onclick = () => void openPushRepoDialog();
        chips.append(push);
      } else {
        chips.append(chip(aheadText, status.ahead ? 'warn' : 'ok'));
      }
      if (status.upstream && status.behind) chips.append(chip(`↓ 落后上游 ${status.behind} 个提交`, 'warn'));
    }
    chips.append(chip(status.dirtyFiles?.length
      ? `● ${status.dirtyFiles.length} 个未提交文件（主检出）`
      : '主检出工作区干净', status.dirtyFiles?.length ? 'warn' : 'ok'));
    const actions = node('div', null, 'directory-git-actions');
    const logButton = node('button', directoryGitView.logOpen ? '收起 Git 记录' : '查看 Git 记录', 'subtle');
    logButton.type = 'button';
    logButton.onclick = () => void toggleDirectoryGitLog();
    actions.append(logButton);
    brief.replaceChildren(chips, actions);
    if (status.dirtyFiles?.length) {
      const files = node('details', null, 'directory-git-files');
      files.append(node('summary',
        `未提交文件 ${status.dirtyFiles.length} 个 — 在主检出里直接改的，不属于任何任务 worktree`));
      const fileList = node('ul');
      const shown = status.dirtyFiles.slice(0, 50);
      for (const file of shown) fileList.append(node('li', `${file.status || 'M'}  ${file.path}`));
      if (status.dirtyFiles.length > shown.length) fileList.append(node('li', `…还有 ${status.dirtyFiles.length - shown.length} 个`));
      files.append(fileList);
      brief.append(files);
    }
    if (note) note.textContent = status.upstream ? `上游 ${status.upstream}` : '无上游分支，按基分支统计';
    if (list) {
      list.hidden = !directoryGitView.logOpen;
      if (directoryGitView.logOpen) paintDirectoryGitLog(list);
    }
  }

  async function toggleDirectoryGitLog() {
    directoryGitView.logOpen = !directoryGitView.logOpen;
    if (directoryGitView.logOpen && !directoryGitView.commits && !directoryGitView.logError) {
      const list = $('directory-git-list');
      list.replaceChildren(node('p', '正在读取提交记录…', 'directory-git-empty'));
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
      list.replaceChildren(node('p', `读取提交记录失败：${directoryGitView.logError}`, 'directory-git-empty error'));
      return;
    }
    const commits = directoryGitView.commits;
    if (!commits) return;
    if (!commits.length) {
      list.replaceChildren(node('p', '暂无提交记录。', 'directory-git-empty'));
      return;
    }
    list.replaceChildren(...commits.map(commit => {
      const item = node('div', null, 'directory-git-commit');
      const head = node('button', null, 'directory-git-commit-head');
      head.type = 'button';
      head.setAttribute('aria-expanded', String(directoryGitView.openHash === commit.hash));
      const copy = node('span', null, 'directory-git-commit-copy');
      copy.append(node('code', commit.short || String(commit.hash || '').slice(0, 7)),
        node('strong', commit.subject || '(无标题)'));
      head.append(copy,
        node('time', commit.date ? commit.date.replace('T', ' ').slice(0, 16) : ''),
        node('small', `${commit.author || '—'}${commit.refs ? ` · ${commit.refs}` : ''}`));
      head.onclick = () => void toggleCommitDetail(commit);
      item.append(head);
      if (directoryGitView.openHash === commit.hash) {
        const detail = node('div', null, 'directory-git-commit-detail');
        if (commit.__stat) detail.append(node('div', commit.__stat, 'directory-git-stat'));
        detail.append(node('pre', commit.__diff || '正在读取 diff…', 'directory-git-diff'));
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
        commit.__diff = result.error ? `读取 diff 失败：${result.error}`
          : result.diff || '（该提交无可显示的 diff，可能是空合并提交）';
        if (result.truncated) commit.__diff += '\n⚠ diff 过长已截断';
      } catch (error) {
        commit.__stat = '';
        commit.__diff = `读取 diff 失败：${error.message}`;
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
      : quickRuntime.providerName || quickRuntime.provider || '默认线路';
    setPillText(ai, [quickCli(), route, quickRuntime.model || '默认模型'].join(' · '));
    ai.title = '新任务的 AI 配置：CLI、线路与模型（创建后即生效）';
    role.textContent = quickRoles.length ? `${quickRoles.length} 个角色` : '＋ 角色';
    role.title = '新任务的角色上下文（写入第一条消息）';
    for (const pill of [ai, role]) pill.disabled = !directoryId;
  }

  function openQuickConfiguration() {
    if (!directoryId) return;
    window.MultiCCAirSettings.configuration(
      { task: { title: '新任务' }, configuration: { ...quickRuntime, cli: quickCli() } }, data?.clis,
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
    const targetDirectoryId = quickTargetDirectoryId();
    if (!data || !targetDirectoryId) return;
    const typed = $('quick-task-input').value.trim();
    if (!typed) return;
    const paths = [...$('quick-task-files').querySelectorAll('[data-path]')].map(chip => chip.dataset.path);
    const text = typed + (paths.length ? `\n\n附件：${paths.join(' ')}` : '');
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
    quickStatus('正在创建固定任务…');
    try {
      const title = typed.split(/\n/).find(Boolean).trim().slice(0, 120);
      created = await api('/api/air/tasks', { dirId: targetDirectoryId, title, clientMsgId: attempt.createId, ...runtime });
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
        notice(`任务已创建，但第一条消息未确认送达：${error.message}。草稿已保留。`);
      } else quickStatus(error.message);
    } finally {
      $('quick-task-submit').disabled = false;
      $('quick-task-dialog-directory').disabled = false;
    }
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
      // A rule whose fixed task was archived stops executing until a new fixed
      // task is bound; that repair is explicit, never automatic.
      const rebind = task.taskBindingError
        ? scheduleAction('⛑ 重新绑定固定任务', () => rebindSchedule(task.id), 'primary subtle')
        : null;
      const toggle = scheduleAction(task.enabled ? '暂停' : '启用', () => toggleSchedule(task.id, !task.enabled));
      const edit = scheduleAction('编辑规则', () => openScheduleDialog(task.id));
      const remove = scheduleAction('删除规则', () => deleteSchedule(task.id), 'danger');
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

  async function rebindSchedule(id) {
    if (!window.confirm('为这条规则绑定一个新的固定 Air 任务？旧的固定任务和历史都不会被删除。')) return;
    try {
      const result = await api(`/api/cron/${encodeURIComponent(id)}/rebind`, {});
      await Promise.all([refreshSchedules(), refresh()]);
      notice(`已重新绑定固定任务：${result.taskId}`);
    } catch (error) {
      notice(error.code === 'binding_healthy' ? '固定任务当前可写，无需重新绑定。' : `重新绑定失败：${error.message}`);
    }
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
    $('task-list-title').textContent = '最近任务';
    $('task-count').textContent = tasks.length;
    list.replaceChildren(...tasks.map(task => {
      const elsewhere = task.dirId !== directoryId;
      const button = node('button', null, [task.id === taskId ? 'selected' : '', elsewhere ? 'elsewhere' : ''].filter(Boolean).join(' '));
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
      const stage = task.recordType === 'planned' ? `计划 · ${label(task.workflowStage || task.status)}` : '';
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
    if (!tasks.length) list.append(node('small', '还没有打开过任务。这个目录里的任务会出现在这里。', 'empty-list'));
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
      notice(`最多只能 Pin ${PIN_LIMIT} 个任务，先取消一个再钉。`);
      return;
    }
    try {
      const result = await api('/api/air/pins/toggle', { taskId });
      taskPins = Array.isArray(result.taskIds) ? result.taskIds.slice() : [];
      pinSignature = '';
      renderPins();
      renderSidebarTasks();
      paintPinButton();
      notice(isPinned(taskId) ? `已 Pin 住「${known?.title || taskId}」` : '已取消 Pin');
    } catch (error) {
      notice(`Pin 失败：${error.message}`);
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
      open.title = `${task.title || '未命名任务'} · ${directoryName(task.dirId)}${stage ? ` · ${stage}` : ''}`;
      open.setAttribute('aria-label', `展开 ${task.title || '未命名任务'} 的详情`);
      // 缩略态只有「状态图标 + 标题」；完整标题、目录、阶段、状态中文全在下面
      // 那张卡片里。胶囊自己的宽度不动 —— 横向伸长会把旁边几个 pin 推着一起
      // 挪（用户说的「晃眼」就是这个），卡片绝对定位，别人一步都不动。
      const panel = node('div', null, 'pin-panel');
      panel.id = `pin-panel-${task.id}`;
      const panelMeta = node('div', null, 'pin-panel-meta');
      panelMeta.append(statusBadge(task), node('em', directoryName(task.dirId), 'task-dir'));
      if (stage) panelMeta.append(node('span', stage));
      const go = node('button', '打开任务', 'pin-panel-open');
      go.type = 'button';
      go.onclick = () => navigate(task.dirId, task.id);
      panel.append(node('strong', task.title || '未命名任务', 'pin-panel-title'), panelMeta, go);
      open.setAttribute('aria-expanded', 'false');
      open.setAttribute('aria-controls', panel.id);
      const status = node('span', null, 'pin-status');
      status.append(statusBadge(task));
      const copy = node('span', null, 'pin-copy');
      copy.append(node('strong', task.title || '未命名任务', 'pin-title'));
      open.append(status, copy);
      open.onclick = () => setPinPanelOpen(tab, !tab.classList.contains('is-open'));
      const remove = node('button', '×', 'pin-x');
      remove.type = 'button';
      remove.title = '取消 Pin';
      remove.setAttribute('aria-label', `取消 Pin ${task.title || '未命名任务'}`);
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
    button.title = on ? '取消 Pin' : 'Pin 到页顶';
    button.setAttribute('aria-label', on ? '取消 Pin' : 'Pin 到页顶');
    const name = button.querySelector('.air-tool-name');
    // 手机浮层里图标旁边是要跟名字的，这个名字得跟着状态走（桌面上它不显示）。
    if (name) name.textContent = on ? '取消 Pin' : 'Pin 到页顶';
  }

  function applyTaskTitleEditing(task = null) {
    const titleEditable = !!(taskId && task);
    $('task-title').classList.toggle('editable', titleEditable);
    if (titleEditable) {
      $('task-title').title = '双击更改任务标题';
      $('task-title').tabIndex = 0;
      $('task-title').setAttribute('aria-keyshortcuts', 'Enter F2');
      $('task-title').setAttribute('aria-label', `任务标题：${task.title}。双击或按回车更改`);
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
      attention: ['MultiCC Air › 控制台', '谁在等我', '跨所有工作目录：等我回答、出错要处理或卡在资源的任务。'],
      docs: ['MultiCC Air › 系统工具', '服务与文档', 'Agent 产物、本地页面和服务登记。'],
      memory: ['MultiCC Air › 系统工具', '记忆图谱', '项目记忆、会话记忆与文件编辑。'],
      taskgraph: ['MultiCC Air › 系统工具', '任务图谱', '任务关联网络：父子 / 分组 / 合并 / 壳链接。'],
      settings: ['MultiCC Air › 系统设置', '设置中心', 'AI、连接、通知和资源配置。'],
      voice: ['MultiCC Air › 设置中心', '语音设置', '识别、转写与实时语音能力。'],
      goal: ['MultiCC Air › 设置中心', 'Goal 预检', '任务目标与自动分类规则。'],
      provider: ['MultiCC Air › 设置中心', 'CLI 与 Provider', '全局供应商、账号与线路管理。'],
      aux: ['MultiCC Air › 设置中心', 'AI Assistant', '意图分类与摘要服务的模型设置与运行记录。'],
      global: ['MultiCC Air › 设置中心', '全局配置', '语言、执行与通用偏好。'],
      push: ['MultiCC Air › 设置中心', '推送通知', 'Web Push 与备用提醒通道。'],
      tunnel: ['MultiCC Air › 设置中心', '外网穿透', '国内 SakuraFrp / 海外 Tailscale 分流接入与状态。'],
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
      $('task-state').textContent = '按名称或路径切换项目。';
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
      frame.title = '任务对话';
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
      const action = expanded ? '收起浮层' : '展开浮层';
      button.title = action;
      button.setAttribute('aria-label', action);
      const text = button.querySelector('.chat-bar-label');
      if (text) text.textContent = expanded ? '收起' : '展开';
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
    $('directory-name').textContent = dir?.name || '先添加工作目录';
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
      $('console-here').textContent = dir ? `· 当前 ${dir.name}` : '';
      $('console-close').textContent = taskId ? '返回任务' : '关闭控制台';
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
    const execution = unstartedPlan ? '计划待执行'
      : label(value.execution?.pending ? 'waiting' : value.execution?.status || (value.execution?.busy ? 'running' : 'idle'));
    const lifecycle = label(value.task?.status || value.status);
    return [execution && `本轮 ${execution}`, lifecycle && `任务 ${lifecycle}`].filter(Boolean);
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

  // ── 任务生命周期操作：归档 / 恢复 / 移动 / 删除 ─────────────────────────
  // 后端能力都在 task-board 路由上（status / relocate / DELETE），这里只是把
  // 它们接到任务详情面板。
  const TASK_ACTION_ERRORS = {
    task_busy: '任务正在执行或排队中，等它空闲下来再操作。',
    task_archived: '任务已归档。',
    task_deleting: '任务正在删除中，请稍等。',
    title_required: '任务标题不能为空。',
    title_too_long: '任务标题最多 40 个字符。',
    task_workspace_dirty: '工作区还有未提交改动，需要再次确认后才能删除。',
    task_workspace_unmerged: '工作区还有未合并到基分支的提交，需要再次确认后才能删除。',
    task_session_shared: '会话还被其他任务共享，无法删除。',
    shell_workspace_referenced: '工作区被其他会话引用，无法删除。',
    task_shell_shared: '任务的会话壳还挂着别的任务，不能整体移动。',
    carry_apply_failed: '未提交改动套用到目标仓库失败（两个目录的代码上下文不兼容），任务仍留在原处。',
    active: '会话仍活跃，请稍后再试。',
    unmerged: '还有未合并到基分支的提交：请先在任务详情里合并，再移动。',
  };
  function taskActionError(error) {
    return TASK_ACTION_ERRORS[error?.code || ''] || TASK_ACTION_ERRORS[error?.message || '']
      || TASK_ACTION_ERRORS[(error?.reasons || [])[0] || ''] || error?.message || '操作失败';
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
      ...(risks.dirty ? ['• 有未提交的代码改动或未跟踪文件'] : []),
      ...(risks.unmerged ? ['• 有尚未合入基分支（如 main）的提交'] : []),
    ];
    return window.confirm(`任务「${title}」的工作区检测到风险：\n\n${findings.join('\n')}\n\n仍然删除会直接移除 worktree 和分支。MultiCC 会在仓库的 .git/multicc-backups 中备份 Git 能识别的提交、改动和未跟踪文件；Git 忽略的文件不会被备份。\n\n仍然删除？`);
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
      notice(archive ? '任务已归档；归档的任务不再执行，随时可以恢复。' : '任务已恢复。');
    });
  }

  async function deleteTaskById(task) {
    const selectedId = task?.id || taskId;
    if (!selectedId) return;
    const title = task?.title || (selectedId === taskId ? entry?.task?.title : '') || selectedId;
    if (!window.confirm(`删除任务「${title}」？\n\n它的专属会话与 worktree 会被直接删除。此操作不可撤销。`)) return;
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
      notice('任务已删除。');
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
    if (!targets.length) { notice('还没有其他工作目录可以移动。'); return; }
    const dialog = node('dialog', null, 'move-task-dialog');
    const form = node('form');
    form.method = 'dialog';
    form.append(node('span', 'MOVE TASK', 'eyebrow'), node('h2', `移动「${entry.task?.title || taskId}」`));
    form.append(node('p', '选择目标工作目录。工作区会迁到目标仓库，未提交的改动和新文件一起带走；正在执行的任务不能移动。'));
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
    const cancel = node('button', '取消');
    cancel.type = 'submit';
    const confirm = node('button', '移动');
    confirm.type = 'button'; confirm.disabled = true; confirm.classList.add('primary');
    confirm.onclick = async () => {
      if (!chosen) return;
      confirm.disabled = true;
      try {
        const result = await api(`/api/task-board/tasks/${encodeURIComponent(taskId)}/relocate`, { dirId: chosen });
        dialog.close();
        const directory = data.directories.find(item => item.id === chosen);
        const carried = result.carried
          ? `；已带走未提交改动${result.carried.files ? `和 ${result.carried.files} 个新文件` : ''}` : '';
        await refresh();
        navigate(chosen, taskId);
        notice(`任务已移动到 ${directory?.name || '目标目录'}${carried}。`);
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
    form.append(node('span', 'TASK TITLE', 'eyebrow'), node('h2', '更改任务标题'));
    form.append(node('p', '标题会同步到任务列表与任务会话；手动标题不会再被自动归类覆盖。'));
    const label = node('label', '任务标题');
    const input = node('input');
    input.name = 'title'; input.type = 'text'; input.required = true; input.maxLength = 40;
    input.autocomplete = 'off'; input.value = currentTitle;
    label.append(input);
    const error = node('p', '', 'rename-task-error');
    error.setAttribute('role', 'alert');
    const footer = node('div', null, 'rename-task-footer');
    const cancel = node('button', '取消');
    cancel.type = 'button'; cancel.onclick = () => dialog.close();
    const save = node('button', '保存');
    save.type = 'submit'; save.classList.add('primary');
    footer.append(cancel, save);
    form.append(label, error, footer);
    form.onsubmit = async event => {
      event.preventDefault();
      const title = input.value.trim();
      if (!title) { error.textContent = '任务标题不能为空。'; input.focus(); return; }
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
        notice('任务标题已更新。');
      } catch (cause) {
        error.textContent = taskActionError(cause) || '任务标题更新失败。';
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
    const targetTitle = separation?.targetTitle || candidate?.title || candidate?.taskName || '建议任务';
    const card = $('delivery-card');
    card.hidden = false;

    let eyebrow = 'MULTICC · 本轮状态';
    let title = '本轮状态已记录';
    let text = '任务保持当前归属，可以继续输入下一步。';
    const legacyStage = integration?.baselineCurrent ? 3 : integration ? 2
      : run?.outcome === 'succeeded' && !run.pendingInput ? 1 : 0;
    const deliverySteps = Array.isArray(attribution.steps) && attribution.steps.length
      ? attribution.steps.slice(0, 4).map((step, index) => ({
        key: step.key || String(index), label: step.label || ['本轮成功', '代码交付', '源现场稳定', '任务归属'][index],
        status: ['done', 'pending', 'blocked', 'skipped'].includes(step.status) ? step.status : 'pending',
      }))
      : ['本轮成功', '代码交付', '源现场稳定', '任务归属'].map((label, index) => ({
        key: String(index), label, status: index < legacyStage ? 'done' : 'pending',
      }));

    if (capacity) {
      eyebrow = 'MULTICC · 执行资源';
      title = `${label(capacity)} · 现有工作现场正在保留`;
      text = '消息已绑定当前任务；资源可用后继续，不会停止其他服务或删除未交付修改。';
    } else if (pending) {
      eyebrow = 'MULTICC · 等待回答';
      title = '本轮需要你的回答';
      text = '回答仍提交给原任务与原请求，不会因为归属建议改变目标。';
    } else if (candidate?.state === 'stale' && !separation) {
      eyebrow = 'MULTICC · 归属建议未应用';
      title = '本次归属建议已过期';
      text = '你已继续输入或切换视图，迟到的分类与合并事件不会改投已经接受的消息。';
    } else if (separation?.state === 'separated') {
      eyebrow = 'MULTICC · 分离已生效';
      title = `已创建独立任务「${targetTitle}」`;
      text = '本轮已按停写屏障锁定的版本应用到新任务；源任务原始对话保持不变。';
    } else if (separation?.state === 'kept') {
      eyebrow = 'MULTICC · 分离建议已处理';
      title = '本轮保留在当前任务';
      text = '你已选择不创建独立任务；第 4 步以「已跳过」记录，不会伪装成分离生效。';
    } else if (separation) {
      eyebrow = separation.phase === 'blocked' ? 'MULTICC · 分离暂未生效' : 'MULTICC · 建议独立任务';
      title = separation.phase === 'blocked' ? `「${targetTitle}」尚未建立` : `是否将本轮分离为「${targetTitle}」`;
      const firstBlocker = attribution.blockers?.find(reason => reason !== 'separation_application_required');
      text = separation.phase === 'blocked'
        ? (blockerNames[firstBlocker] || separation.lastError?.message || '完整交付与停写核验通过后可安全重试。')
        : '确认后会创建一个独立任务壳与工作目录，不改写当前任务的原始对话。';
    } else if (candidate && running) {
      eyebrow = 'MULTICC · 本轮执行中';
      title = '归属将在本轮交付后确认';
      text = `可能关联「${targetTitle}」，当前仍在「${currentTitle}」中执行。`;
    } else if (candidate && (run?.outcome !== 'succeeded' || run?.pendingInput)) {
      eyebrow = 'MULTICC · 尚未满足归属条件';
      title = '本轮未成功或仍需回答';
      text = `建议目标仍是「${targetTitle}」，原问题继续绑定当前任务。`;
    } else if (candidate && !integration) {
      eyebrow = 'MULTICC · 本轮成功，等待交付';
      title = `建议归入「${targetTitle}」`;
      text = '执行成功不等于任务完成或归属生效；相关代码按项目流程交付后再核验。';
    } else if (candidate && !integration?.baselineCurrent) {
      eyebrow = 'MULTICC · 交付记录待核验';
      title = `建议归入「${targetTitle}」`;
      text = '已有合并记录，但基分支状态发生变化；重新核验前保持当前任务。';
    } else if (candidate) {
      eyebrow = 'MULTICC · 交付已核验';
      title = `建议归入「${targetTitle}」· 等待源现场稳定`;
      text = '代码交付已核验；持续停写屏障与原子归属尚未完成，不提前转移工作区或消息。';
    } else if (running) {
      eyebrow = 'MULTICC · 本轮执行中';
      title = '任务正在当前工作目录执行';
      text = '本轮结果、代码交付与任务完成会分别记录；执行期间下一条消息仍发送到当前任务。';
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
    const separationPending = separation && !['kept', 'separated'].includes(separation.state);
    const attention = !!(capacity || pending || candidate || separationPending || failed);
    summary.classList.toggle('attention', attention);
    // 第三段是附注，两种附注在手机上待遇不同（air.css 的 760px 块）：卡在资源上
    // 的那条（等待执行名额）说的是「为什么现在没动」，留着；「归属待核验」说的是
    // 「这条以后归到哪个任务」，占地方，手机上让位。所以类得分开，不能共用一个。
    const thirdClass = capacity ? 'ts-cap' : candidate || separationPending ? 'ts-attr' : null;
    renderStateSummary(summary, [...taskStateSegments(value),
      capacity ? label(capacity) : separationPending ? '分离待生效' : candidate ? '归属待核验' : ''], [...STATE_CLASSES, thirdClass]);
    summary.title = `${title}。${text} 点击查看详情。`;
    $('delivery-destination').textContent = separation?.state === 'separated' && separation.targetTaskId === value.task.id
      ? `当前已是分离后的独立任务「${currentTitle}」`
      : `下一条消息仍发送到「${currentTitle}」`;
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
    if (integration) actions.unshift(actionButton('重新核验交付', reconcileDelivery, 'reconcile'));
    if (separation?.state === 'separated' && separation.targetTaskId && separation.targetTaskId !== value.task.id) {
      actions.push(actionButton('打开独立任务', () => navigate(value.task.dirId || directoryId, separation.targetTaskId), 'open-separated'));
    }
    // 分离建议的持久入口：聊天帧里的弹窗/挂起卡依赖 WS 推送与页面时机，容易
    // 错过；这里的按钮只要建议还挂起就一直在，瞬时拒绝（如源任务在跑）后也能
    // 直接重试。只在查看源任务时显示 —— 决定落在源会话上。
    if (separation && !['kept', 'separated'].includes(separation.state)
        && separation.sourceTaskId === value.task.id && value.sessionId) {
      actions.push(actionButton(separation.phase === 'blocked' ? '重试分离' : '接受分离',
        () => decideSeparation(value, separation, 'separate'), 'separation-accept'));
      actions.push(actionButton('稍后处理',
        () => decideSeparation(value, separation, 'defer'), 'separation-defer'));
      actions.push(actionButton('保留在当前任务',
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
        // 分离错误码与交付卡 blocker 共用一套中文文案，比裸英文 message 可读。
        throw Object.assign(error, { message: blockerNames[error?.code] || taskActionError(error) });
      }
      if (decision === 'separate' && result?.taskId) {
        navigate(value.task.dirId || directoryId, result.taskId);
        notice(`已创建独立任务「${separation.targetTitle || ''}」。`);
        return;
      }
      await refreshEntry();
      notice(decision === 'defer' ? '分离建议已挂起，可稍后在聊天页或这里继续处理。' : '本轮保留在当前任务。');
    });
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
        ['源现场', attribution.barrier ? '写入者已停止，最终版本已锁定' : '尚无可验证的停写屏障'],
        ['任务归属', attribution.application ? `分离已生效 · ${attribution.separation?.targetTaskId || ''}`
          : attribution.separation?.state === 'kept' ? '已选择保留在当前任务'
            : attribution.separation ? '独立任务尚未生效' : attribution.steps?.[3]?.status === 'done' ? '准入时已锁定当前任务' : '尚未核验'],
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
    const lifecycleStatus = value.task.status || value.status;
    actions.append(lifecycleStatus === 'archived'
      ? actionButton('恢复任务', () => archiveTask(false), 'restore')
      : actionButton('归档任务', () => archiveTask(true), 'archive'));
    if (!value.readOnly) actions.append(actionButton('移动到其他目录…', openMoveDialog, 'move'));
    const removeAction = actionButton('删除任务…', deleteTask, 'delete');
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
      : (pending?.providerName || shown?.providerName || shown?.provider) || '默认线路';
    ai.hidden = !entry?.sessionId;
    ai.disabled = !entry || entry.readOnly;
    ai.title = '任务 AI 配置：CLI、路由与模型（下一轮生效）';
    const roleCount = entry?.roleBindings?.bindings?.length || 0;
    role.hidden = !entry?.roleBindings;
    role.disabled = !entry || entry.readOnly;
    role.textContent = roleCount ? `${roleCount} 个角色` : '＋ 角色';
    role.title = '任务角色上下文';
    // 先把这条带子显出来再量宽度：隐藏时量到的 clientWidth 是 0，那样跑马灯得
    // 等到下一次轮询才启动，看上去就是「卡了一下」。
    setComposerBand(doc, row, !ai.hidden || !role.hidden);
    setPillText(ai, shown
      ? [shown.cli, routeName,
        (pending ? shown.model : shown.effectiveModel || shown.model) || '默认模型',
        pending ? '下轮生效' : ''].filter(Boolean).join(' · ')
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
        ? `补充或开始执行「${entry.task.title}」…`
        : `继续描述「${entry.task.title}」的下一步…`;
    }
  }

  async function refreshEntry() {
    const selected = taskId;
    if (!selected) return false;
    try {
      const result = await apiConditional(`/api/air/tasks/${encodeURIComponent(selected)}`);
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
        notice(data.migration?.errors?.length ? `有 ${data.migration.errors.length} 份历史任务等待核验；原记录与工作区均已保留。` : '');
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
    lidSleepRow.title = enabled
      ? '关盖时保持运行，不进入睡眠；电池降到 5% 以下会自动睡眠保护，插电或回充到 8% 后恢复（点击恢复关盖睡眠）'
      : '关盖时保持运行（点击开启，需要在 Mac 上完成管理员授权；开启后附带 5% 掉电自动睡眠保护）';
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
      notice(result.enabled ? '已开启关盖保持运行' : '已恢复关盖睡眠');
    } catch (error) {
      // 失败退回原状态：开关不能替服务点头。
      paintLidSleep(!wanted);
      notice(`关盖运行设置失败：${error.message}`);
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
    catch (error) { notice(`刷新会话失败：${error.message}`); }
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
