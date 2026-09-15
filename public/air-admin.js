'use strict';

(function initAirAdmin(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const el = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  const legacyPanels = {
    planner: ['任务看板', '按模块查看、筛选与规划全部任务', 'PLANNER'],
    memory: ['记忆图谱', '项目记忆、会话记忆与文件编辑', 'MEMORY'],
    taskgraph: ['任务图谱', '任务关联网络：父子 / 分组 / 合并 / 壳链接', 'TASKGRAPH'],
    voice: ['语音设置', '识别、转写与实时语音能力', 'VOICE'],
    goal: ['Goal 预检', '任务目标与自动分类规则', 'GOAL'],
    provider: ['Provider 配置', '全局供应商、账号与线路管理', 'PROVIDERS'],
    global: ['全局配置', '语言、执行与通用偏好', 'SETTINGS'],
    push: ['推送通知', 'Web Push 与备用提醒通道', 'NOTIFICATIONS'],
    tunnel: ['外网穿透', 'Tailscale 与隧道服务状态', 'NETWORK'],
    bridges: ['消息桥接', '微信、飞书及其他消息入口', 'BRIDGES'],
    resources: ['Agent 资源', 'Skills 与历史资源管理', 'RESOURCES'],
    skillsync: ['技能同步', '跨 CLI 的 Skills 同步状态', 'SKILLS'],
    storage: ['临时上传', '上传缓存、空间占用与清理', 'STORAGE'],
  };
  const settingGroups = [
    ['AI 与执行', ['provider', 'goal', 'voice', 'global']],
    ['连接与通知', ['push', 'tunnel', 'bridges']],
    ['资源与存储', ['resources', 'skillsync', 'storage']],
  ];
  let activeMode = null;
  let currentContext = null;
  // 控制台里那份「全部任务」的筛选，存在模块上而不是 DOM 上：面板每次重开都会
  // 重建 DOM，筛选跟着输入框一起丢掉的话，翻回去看同一条列表要重挑一次。
  const consoleFilter = { query: '', status: 'open', dir: 'all' };
  // 面板是给人看的，不是导出用的：超过这个数就只显示最近的一批，并把总数说清楚。
  const TASK_LIST_LIMIT = 60;
  // 「谁在等我」是面板的第一格，也是打开控制台第一眼要看的东西，所以它只留最急的
  // 几条：一屏扫完，剩下的交给它自己的整页（这一格的「查看全部」）。不封顶的话，
  // 跑起来的任务一多，这一格就把下面的「全部任务」和工具格整片推出视野 ——
  // 控制台变成一份清单的滚动条。
  const ATTENTION_LIMIT = 5;

  // 手机上页头的工具都收进「⋯」浮层，浮层里每一行都摆成「图标 + 名字」两列
  // （air.css 的 760px 块）。图标得是自己一个节点，名字才站得到第二列上 ——
  // 所以图标不拼进文字里，而是按钮的第一个 span。两种按钮各有一个来源：
  //
  // keepsGlyph ── 桌面页头上本来就带这个符号的（「＋ 新建任务」「↻ 刷新」）：符号
  //   原来拼在文字里，现在拆出来，桌面上看着一模一样，浮层里它就是那一列的图标。
  // panelIcon ── 桌面只有文字的动作（「详情」「返回设置中心」）：图标是这次给浮层
  //   补的，桌面不显示 —— 桌面页头本来就满，最窄的那几档已经在换行了。
  const keepsGlyph = glyph => ({ desktop: glyph });
  const panelIcon = glyph => ({ panel: glyph });

  function action(text, handler, className = '', mark = null) {
    const button = make('button', null, className);
    button.type = 'button';
    if (mark?.desktop) button.append(make('span', mark.desktop, 'air-tool-icon'));
    else if (mark?.panel) button.append(make('span', mark.panel, 'air-tool-icon-panel'));
    button.append(document.createTextNode(mark?.desktop ? ` ${text}` : text));
    button.onclick = handler;
    return button;
  }

  // The Air shell header owns the page title (air.js renderHeader); a view only
  // contributes its actions. Page views put them in the header toolbar; the
  // console panel is an overlay, so its actions stay inside the panel instead of
  // rewriting the header of the page it is covering.
  function setActions(actions = [], hostId = 'admin-actions') {
    el(hostId).replaceChildren(...actions);
  }

  // ── 状态：一份判定，侧栏和控制台共用 ────────────────────────────────────
  // 「这条任务在不在跑、该画哪个徽标」由 public/status-presentation.js 说了算 ——
  // 它是服务端词表的镜像：runState 来自 src/task-board/normalize.js 的
  // TASK_RUN_STATES，classify 字母来自 src/classify/vocab.js。这里不写
  // `runState === 'running'`：注册表只给 running 设了 spinner，于是「出错的任务
  // 绝不动画」是一条规则，而不是每个用到状态的地方各判一遍。
  const RUNNING_LEASES = ['reserved', 'materializing', 'starting', 'running', 'uncertain'];
  // Air 不带 i18n 词典（air.html 里没有 t()），注册表的 labelKey 在这儿查不到文案，
  // 所以显式给一份中文。词表跟 air.js 的 stateNames 是同源的，只是这里只需要状态名。
  const STATUS_COPY = Object.freeze({
    idle: '空闲', queued: '排队中', running: '执行中', waiting: '等待回答', blocked: '等待配置',
    error: '执行异常', succeeded: '执行成功', done: '已完成', cancelled: '已取消',
    archived: '已归档', offline: '已离线', unknown: '状态未知',
  });
  const registry = () => root.MultiCCStatusPresentation;

  /** 权威状态：生命周期（archived/done）优先，其次是这一轮的 runState。 */
  function taskStatus(task) {
    const api = registry();
    return api ? api.taskStatus({ status: task?.status, runState: task?.runState }) : 'unknown';
  }
  function taskSpec(task) {
    const api = registry();
    const status = taskStatus(task);
    return api ? api.presentation('task', status)
      : { status, icon: '❔', tone: 'neutral', spinner: false, terminal: false };
  }
  /** 只有注册表说 spinner 的状态才配拿彩虹圈 —— 「在跑」全局只有这一个定义。 */
  function isRunning(task) { return taskSpec(task).spinner === true; }
  function runningDirectories(data) {
    const dirs = new Set();
    for (const task of data?.tasks || []) if (isRunning(task)) dirs.add(task.dirId);
    return dirs;
  }
  function applyRing(element, on) { if (element) element.classList.toggle('ring-running', !!on); }

  /** 状态徽标：图标 + 中文标签，可访问名称与可见文案是同一句话。 */
  function statusBadge(task, opts = {}) {
    const spec = taskSpec(task);
    const label = STATUS_COPY[spec.status] || spec.status;
    const badge = make('span');
    const api = registry();
    if (api) {
      // translate 恒等于可见文案：Air 没有词典，ariaKey/labelKey 都该落到同一个词上。
      api.applyStatusBadge(badge, 'task', spec.status, { label, translate: () => label, ...opts });
    } else {
      badge.className = `mc-status st-tone-${spec.tone}`;
      badge.textContent = `${spec.icon} ${label}`;
    }
    return badge;
  }

  /** 行的第二层信息：徽标已经说了「在不在跑」，这里补记录类型、阶段和资源去向。 */
  function taskDetail(task, context) {
    const bits = [];
    if (task.recordType === 'planned') bits.push('计划');
    const stage = context.label(task.workflowStage || task.status);
    if (stage) bits.push(stage);
    const resource = task.resource || {};
    const held = resource.capacityReason ? context.label(resource.capacityReason)
      : resource.lease && resource.lease !== 'idle' ? context.label(resource.lease)
        : context.label(resource.residency);
    if (held && held !== stage) bits.push(held);
    return bits.join(' · ');
  }

  /** 一条任务行：徽标 + 标题 + 目录/阶段 + 时间。侧栏和控制台共用同一个形状。 */
  function taskRow(task, context, options = {}) {
    const row = action('', () => context.navigate(task.dirId, task.id), 'admin-recent-row');
    applyRing(row, isRunning(task));
    const copy = make('span');
    const where = options.dir === false ? '' : `${context.directoryName(task.dirId)} · `;
    copy.append(make('strong', task.title || '未命名任务'), make('small', where + taskDetail(task, context)));
    row.append(statusBadge(task, options.badge || {}), copy,
      make('time', task.updatedAt ? new Date(task.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''));
    if (options.onOpen) row.onclick = () => { options.onOpen(); context.navigate(task.dirId, task.id); };
    return row;
  }

  // 「谁在等我」：跨所有目录、正在跑或等着我的任务。这条信号原来由侧栏的
  // 「跨目录活动」承担，现在它是控制台面板的第一个分区，也是入口徽标的数字 ——
  // 一处定义，两处显示，不会再各说各话。
  function taskUrgency(task) {
    const status = taskStatus(task);
    // 等我回答 → 出错要我去处理 → 卡在资源 → 正在跑。故障排在任何乐观信号前面。
    if (status === 'waiting') return 0;
    if (status === 'error') return 1;
    if (task.resource?.capacityReason) return 2;
    if (status === 'running' || RUNNING_LEASES.includes(task.resource?.lease)) return 3;
    if (status === 'done' || status === 'archived') return 5;
    return 4;
  }
  function urgentTasks(data) {
    return (data?.tasks || [])
      .filter(task => taskUrgency(task) < 4)
      .sort((a, b) => taskUrgency(a) - taskUrgency(b) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  function statCard(label, value, detail, tone, onClick) {
    const card = make(onClick ? 'button' : 'article', null, `admin-stat ${tone || ''}`);
    if (onClick) { card.type = 'button'; card.onclick = onClick; }
    card.append(make('span', label), make('strong', String(value)), make('small', detail));
    return card;
  }

  function renderOverview(context) {
    const { data, scheduleTasks, setMode, navigate } = context;
    const tasks = data?.tasks || [];
    const directories = data?.directories || [];
    const active = tasks.filter(task => task.status !== 'done' && task.status !== 'archived');
    const executing = active.filter(isRunning);
    const waiting = active.filter(task => taskUrgency(task) < 3);
    const enabledSchedules = (scheduleTasks || []).filter(task => task.enabled);
    const running = runningDirectories(data);
    // The overview lives in the console panel; `#admin-content` is the fallback
    // for any host that renders it as a page.
    const panel = el('console-content');
    setActions([
      action('浏览工作目录', () => setMode('library'), '', panelIcon('▦')),
      action('新建任务', () => { setMode('tasks'); setTimeout(() => el('create')?.click(), 0); }, 'primary', keepsGlyph('＋')),
    ], panel ? 'console-actions' : 'admin-actions');

    const content = panel || el('admin-content');
    const stats = make('div', null, 'admin-stats');
    stats.append(
      statCard('工作目录', directories.length, running.size ? `${running.size} 个目录正在跑` : '统一目录库', 'blue', () => setMode('library')),
      statCard('进行中任务', active.length, `${executing.length} 个正在执行`, 'green', () => setMode('tasks')),
      statCard('等待处理', waiting.length, waiting.length ? '等待回答、资源或重试' : '当前没有要处理的事', waiting.length ? 'amber' : ''),
      statCard('定时任务', enabledSchedules.length, `共 ${(scheduleTasks || []).length} 条规则`, 'purple', () => setMode('schedules')),
    );

    const attention = make('section', null, 'admin-panel console-attention');
    const attentionHead = make('div', null, 'admin-panel-head');
    attentionHead.append(make('div'));
    attentionHead.firstChild.append(make('span', 'ACROSS ALL WORKSPACES', 'eyebrow'), make('h3', '谁在等我'));
    // 清单本来就按紧急度排过，所以「只显示前几条」砍掉的是最不急着处理的那些，
    // 留下的仍是眼下最该看的人。总数照报，别让封顶看起来像「就这么几条」。
    const urgent = urgentTasks(data);
    const overflowed = urgent.length > ATTENTION_LIMIT;
    const attentionMeta = make('div', null, 'admin-panel-meta');
    attentionMeta.append(make('span', overflowed
      ? `${urgent.length} 条 · 显示最急的 ${ATTENTION_LIMIT} 条`
      : '按紧急度排序，点击直达', 'admin-panel-note'));
    // 没超过就没有第二页可去，出口不出现 —— 按钮跟着「有地方可去」出现，而不是
    // 常驻一个点了没反应的「全部」。
    if (overflowed) attentionMeta.append(action(`查看全部 ${urgent.length} 条 ›`, () => setMode('attention')));
    attentionHead.append(attentionMeta);
    const attentionList = make('div', null, 'admin-recent-list');
    // 从面板里点走一条任务时，面板自己让开（onOpen），否则它盖住的正是刚落上去的那一页。
    for (const task of urgent.slice(0, ATTENTION_LIMIT)) attentionList.append(taskRow(task, context, { onOpen: () => context.closeConsole?.() }));
    if (!attentionList.children.length) attentionList.append(make('p', '没有正在等待或正在执行的任务。', 'admin-empty'));
    attention.append(attentionHead, attentionList);

    const split = make('div', null, 'admin-overview-grid');
    // 全部任务：控制台是跨目录的，这里不按当前目录收窄 —— 目录是执行上下文，
    // 不是「能不能看见这条任务」的前提。
    const allPanel = make('section', null, 'admin-panel');
    const allHead = make('div', null, 'admin-panel-head');
    allHead.append(make('div', null));
    allHead.firstChild.append(make('span', 'ALL TASKS · 全部目录', 'eyebrow'), make('h3', '全部任务'));
    const allNote = make('span', '', 'admin-panel-note');
    allNote.id = 'console-task-note';
    allHead.append(allNote);
    const controls = make('div', null, 'admin-task-controls');
    const search = make('input');
    search.type = 'search';
    search.id = 'console-task-search';
    search.placeholder = '搜索标题或目录';
    search.setAttribute('aria-label', '搜索任务');
    search.value = consoleFilter.query;
    const statusPick = make('select');
    statusPick.id = 'console-task-status';
    statusPick.setAttribute('aria-label', '按状态筛选');
    for (const [value, text] of [['open', '进行中与待处理'], ['all', '全部记录'], ['archived', '已归档']]) {
      const option = make('option', text);
      option.value = value;
      statusPick.append(option);
    }
    statusPick.value = consoleFilter.status;
    const dirPick = make('select');
    dirPick.id = 'console-task-dir';
    dirPick.setAttribute('aria-label', '按目录筛选');
    const allDirs = make('option', '全部目录');
    allDirs.value = 'all';
    dirPick.append(allDirs);
    for (const directory of directories) {
      const option = make('option', directory.name || directory.id);
      option.value = directory.id;
      dirPick.append(option);
    }
    dirPick.value = directories.some(d => d.id === consoleFilter.dir) ? consoleFilter.dir : 'all';
    consoleFilter.dir = dirPick.value;
    const allList = make('div', null, 'admin-recent-list');
    allList.id = 'console-task-list';
    // 只重画列表，不重画面板：每敲一个字就 replaceChildren 的话，输入框会在第一次
    // 按键后失去焦点。筛选状态存在模块里，所以重开面板还是同一份筛选。
    function paintTaskList() {
      const needle = consoleFilter.query.trim().toLowerCase();
      const rows = tasks
        .filter(task => consoleFilter.status === 'all' ? true
          : consoleFilter.status === 'archived' ? task.status === 'archived'
            : !['done', 'archived'].includes(task.status))
        .filter(task => consoleFilter.dir === 'all' || task.dirId === consoleFilter.dir)
        .filter(task => !needle || `${task.title || ''} ${context.directoryName(task.dirId)}`.toLowerCase().includes(needle))
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
      const shown = rows.slice(0, TASK_LIST_LIMIT);
      allList.replaceChildren(...shown.map(task => taskRow(task, context, { onOpen: () => context.closeConsole?.() })));
      if (!rows.length) allList.append(make('p', '没有符合条件的任务。换个关键词或放宽筛选。', 'admin-empty'));
      allNote.textContent = rows.length > shown.length
        ? `${rows.length} 条 · 显示最近 ${shown.length} 条`
        : `${rows.length} 条`;
    }
    search.oninput = () => { consoleFilter.query = search.value; paintTaskList(); };
    statusPick.onchange = () => { consoleFilter.status = statusPick.value; paintTaskList(); };
    dirPick.onchange = () => { consoleFilter.dir = dirPick.value; paintTaskList(); };
    controls.append(search, statusPick, dirPick);
    allPanel.append(allHead, controls, allList);
    paintTaskList();

    const workspacePanel = make('section', null, 'admin-panel admin-directory-panel');
    const workspaceHead = make('div', null, 'admin-panel-head');
    workspaceHead.append(make('div'));
    workspaceHead.firstChild.append(make('span', 'WORK DIRECTORIES', 'eyebrow'), make('h3', '工作目录'));
    workspaceHead.append(action('目录库与搜索', () => setMode('library')));
    const workspaceList = make('div', null, 'admin-directory-list');
    for (const directory of directories) {
      const directoryTasks = tasks.filter(task => task.dirId === directory.id);
      const unfinished = directoryTasks.filter(task => !['done', 'archived'].includes(task.status));
      const executingCount = unfinished.filter(isRunning).length;
      const row = action('', () => navigate(directory.id), 'admin-directory-row');
      // 任务对应的目录也要带圈：一个「有活在跑」的目录不该等到点进去才发现。
      applyRing(row, running.has(directory.id));
      const copy = make('span');
      copy.append(make('strong', directory.name || directory.id), make('small', directory.path || ''));
      const counts = make('span', null, 'admin-directory-counts');
      counts.append(make('b', `${unfinished.length} 进行中`), make('small', executingCount ? `${executingCount} 执行中` : `${directoryTasks.length} 个任务`));
      row.append(make('span', '▣', 'admin-directory-mark'), copy, counts, make('span', '›', 'admin-directory-arrow'));
      workspaceList.append(row);
    }
    if (!directories.length) workspaceList.append(make('p', '还没有工作目录。', 'admin-empty'));
    workspacePanel.append(workspaceHead, workspaceList);

    const tools = make('section', null, 'admin-panel');
    const toolHead = make('div', null, 'admin-panel-head');
    toolHead.append(make('div'));
    toolHead.firstChild.append(make('span', 'SYSTEM TOOLS', 'eyebrow'), make('h3', '服务与设置'));
    const toolGrid = make('div', null, 'admin-tool-grid');
    const shortcuts = [
      ['docs', '▤', '服务与文档', '本地服务、网页和文件'],
      ['memory', '◇', '记忆图谱', '项目与会话记忆'],
      ['taskgraph', '⛓', '任务图谱', '父子 / 分组 / 合并关联'],
      ['settings', '⚙', '设置中心', 'Provider、通知与连接'],
      ['schedules', '◴', '自动运行', '固定任务定时规则'],
    ];
    for (const [mode, icon, title, detail] of shortcuts) {
      const button = action('', () => setMode(mode), 'admin-tool-card');
      button.append(make('span', icon, 'admin-tool-icon'), make('strong', title), make('small', detail));
      toolGrid.append(button);
    }
    tools.append(toolHead, toolGrid);
    split.append(allPanel, tools);
    content.replaceChildren(stats, attention, split, workspacePanel);
  }

  // 「谁在等我」的整页：控制台那一格只放最急的几条，完整清单在这里。它和控制台
  // 那一格用的是同一个 urgentTasks(data) —— 排序规则只有一份，所以两边不会把
  // 「谁更急」排成两个样子。
  function renderAttention(context) {
    setActions([
      action('返回控制台', () => context.setMode('overview'), '', panelIcon('←')),
      // 数据在外壳那份 /api/air 快照里，所以这一页没有自己的接口可打，刷新只能
      // 请外壳去取。取完外壳会自己重画当前模式，但走的是「模式没变就跳过」那条
      // 早退路径 —— 这里再强制重画一次，否则按钮按下去什么都不动。
      action('刷新', async () => { await context.refresh?.(); render('attention', context, true); }, '', keepsGlyph('↻')),
    ]);
    const urgent = urgentTasks(context.data);
    const panel = make('section', null, 'admin-panel console-attention-page');
    const head = make('div', null, 'admin-panel-head');
    head.append(make('div'));
    head.firstChild.append(make('span', 'ACROSS ALL WORKSPACES', 'eyebrow'), make('h3', '谁在等我'));
    head.append(make('span', urgent.length ? `${urgent.length} 条 · 按紧急度排序，点击直达` : '当前没有要处理的事', 'admin-panel-note'));
    const list = make('div', null, 'admin-recent-list');
    // 这一页本身就是完整清单，点走一条不用收掉任何浮层 —— 直接把 navigate 交给
    // taskRow 的默认行为，不套控制台那层 onOpen。
    for (const task of urgent) list.append(taskRow(task, context));
    if (!urgent.length) list.append(make('p', '没有正在等待或正在执行的任务。', 'admin-empty'));
    panel.append(head, list);
    el('admin-content').replaceChildren(panel);
  }

  function isLoopback(hostname) {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(hostname || '').toLowerCase());
  }

  function serviceUrl(raw) {
    const value = String(raw || '');
    if (isLoopback(location.hostname)) return value;
    try {
      const url = new URL(value, location.href);
      if (isLoopback(url.hostname)) url.hostname = location.hostname;
      return url.toString();
    } catch (_) { return value; }
  }

  async function serviceAction(entry, actionName) {
    try {
      await currentContext.api(`/api/docs-registry/${encodeURIComponent(entry.id)}/${actionName}`, {}, 'POST');
      currentContext.notice(actionName === 'start' ? '服务启动指令已发送。' : '服务停止指令已发送。');
      await loadDocs();
    } catch (error) { currentContext.notice(error.message); }
  }

  async function togglePin(entry) {
    try {
      await currentContext.api(`/api/docs-registry/${encodeURIComponent(entry.id)}`, { pinned: !entry.pinned }, 'PATCH');
      await loadDocs();
    } catch (error) { currentContext.notice(error.message); }
  }

  async function removeEntry(entry) {
    if (!confirm(`删除“${entry.title}”的登记记录？`)) return;
    try {
      await currentContext.api(`/api/docs-registry/${encodeURIComponent(entry.id)}`, undefined, 'DELETE');
      currentContext.notice('登记记录已删除。');
      await loadDocs();
    } catch (error) { currentContext.notice(error.message); }
  }

  function renderDocEntry(entry) {
    const card = make('article', null, `air-doc-card ${entry.expired ? 'expired' : ''}`);
    const icon = make('span', entry.kind === 'service' ? '◎' : entry.kind === 'file' ? '⌑' : '▤', 'air-doc-icon');
    const copy = make('div', null, 'air-doc-copy');
    const titleRow = make('div', null, 'air-doc-title');
    const link = make('a', entry.title || entry.url || '未命名');
    link.href = serviceUrl(entry.url);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    titleRow.append(link);
    if (entry.pinned) titleRow.append(make('span', '置顶', 'air-doc-tag pin'));
    if (entry.expired) titleRow.append(make('span', '已过期', 'air-doc-tag expired'));
    const status = entry.kind === 'service' ? `${entry.status === 'up' ? '运行中' : entry.status === 'starting' ? '启动中' : entry.status === 'down' ? '已停止' : '状态未知'} · ` : '';
    copy.append(titleRow, make('small', `${status}${entry.url || ''}`), make('small', [entry.source, entry.sessionId, entry.createdAt ? new Date(entry.createdAt).toLocaleString('zh-CN') : ''].filter(Boolean).join(' · ')));
    const actions = make('div', null, 'air-doc-actions');
    if (entry.kind === 'service') {
      const log = make('a', '日志');
      log.href = `/api/docs-registry/${encodeURIComponent(entry.id)}/log`;
      log.target = '_blank'; log.rel = 'noopener noreferrer';
      actions.append(log);
      if (entry.status === 'up' || entry.status === 'starting') actions.append(action('停止', () => serviceAction(entry, 'stop'), 'danger'));
      else {
        const start = action(entry.startCmd ? '启动' : '无启动命令', () => serviceAction(entry, 'start'), 'subtle');
        start.disabled = !entry.startCmd;
        actions.append(start);
      }
    }
    actions.append(action(entry.pinned ? '取消置顶' : '置顶', () => togglePin(entry), 'subtle'), action('删除', () => removeEntry(entry), 'danger'));
    card.append(icon, copy, actions);
    return card;
  }

  async function loadDocs() {
    const list = el('air-doc-list');
    if (!list) return;
    list.replaceChildren(make('p', '正在读取服务与文档…', 'admin-empty'));
    try {
      const entries = await currentContext.api('/api/docs-registry');
      const summary = el('air-doc-summary');
      if (summary) {
        const services = entries.filter(entry => entry.kind === 'service');
        summary.textContent = `${entries.length} 条登记 · ${services.filter(entry => entry.status === 'up').length}/${services.length} 个服务运行中`;
      }
      list.replaceChildren(...entries.map(renderDocEntry));
      if (!entries.length) list.append(make('p', '还没有登记服务或文档。', 'admin-empty'));
    } catch (error) {
      list.replaceChildren(make('p', `读取失败：${error.message}`, 'admin-empty error'));
    }
  }

  function renderDocs(context) {
    setActions([
      action('刷新', () => loadDocs(), '', keepsGlyph('↻')),
      action('登记服务', () => el('service-dialog').showModal(), 'primary', keepsGlyph('＋')),
    ]);
    const wrap = make('div', null, 'air-docs');
    const top = make('div', null, 'air-docs-meta');
    top.append(make('span', '服务状态按登记信息实时读取；临时产物到期后会明确标记。'), make('strong', '正在读取…'));
    top.lastChild.id = 'air-doc-summary';
    const list = make('div', null, 'air-doc-list');
    list.id = 'air-doc-list';
    wrap.append(top, list);
    el('admin-content').replaceChildren(wrap);
    void loadDocs();
  }

  function renderSettings(context) {
    setActions();
    const content = el('admin-content');
    const groups = make('div', null, 'air-settings-groups');
    for (const [title, modes] of settingGroups) {
      const section = make('section', null, 'admin-panel air-settings-group');
      section.append(make('h3', title));
      const grid = make('div', null, 'air-settings-grid');
      for (const mode of modes) {
        const [name, description, eyebrow] = legacyPanels[mode];
        const card = action('', () => context.setMode(mode), 'air-setting-card');
        card.append(make('span', eyebrow, 'eyebrow'), make('strong', name), make('small', description), make('em', '进入设置  ›'));
        grid.append(card);
      }
      section.append(grid);
      groups.append(section);
    }
    content.replaceChildren(groups);
  }

  function renderLegacy(mode, context) {
    const [title] = legacyPanels[mode] || [mode];
    const legacyView = mode === 'planner' ? 'tasks' : mode;
    const homeMode = ['planner', 'memory', 'taskgraph'].includes(mode) ? 'overview' : 'settings';
    setActions([
      action(homeMode === 'overview' ? '返回控制台' : '返回设置中心', () => context.setMode(homeMode), '', panelIcon('←')),
      action('在独立页打开', () => window.open(`/manage.html?view=${encodeURIComponent(legacyView)}`, '_blank', 'noopener'), '', panelIcon('↗')),
    ]);
    const note = make('div', null, 'air-migration-note');
    note.append(make('strong', 'Air 迁移中'), make('span', '当前功能已经纳入 Air 外壳；内部表单暂用兼容实现，数据与操作能力保持不变。'));
    const frame = make('iframe', null, 'air-legacy-frame');
    frame.title = title;
    frame.src = `/manage.html?view=${encodeURIComponent(legacyView)}&embed=air`;
    frame.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads');
    el('admin-content').replaceChildren(note, frame);
  }

  function renderProvider(context) {
    const provider = root.MultiCCAirProvider;
    if (!provider) return renderLegacy('provider', context);
    setActions([
      action('返回设置中心', () => context.setMode('settings'), '', panelIcon('←')),
      action('高级账号与借道', () => provider.toggleAdvanced(), '', panelIcon('⇄')),
      action('刷新', () => provider.refresh(), '', keepsGlyph('↻')),
      action('新增 Provider', () => provider.openEditor(), 'primary', keepsGlyph('＋')),
    ]);
    provider.render(context);
  }

  function render(mode, context, force = false) {
    currentContext = context;
    if (mode === 'overview') {
      activeMode = mode;
      renderOverview(context);
      return;
    }
    if (!force && activeMode === mode) return;
    activeMode = mode;
    if (mode === 'attention') return renderAttention(context);
    if (mode === 'docs') return renderDocs(context);
    if (mode === 'settings') return renderSettings(context);
    if (mode === 'provider') return renderProvider(context);
    renderLegacy(mode, context);
  }

  function bindServiceDialog(context) {
    const form = el('service-form');
    if (!form || form.__airBound) return;
    form.__airBound = true;
    el('service-close').onclick = () => el('service-dialog').close();
    el('service-cancel').onclick = () => el('service-dialog').close();
    form.onsubmit = async event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const body = { kind: 'service', title: values.title.trim(), url: values.url.trim(), source: 'user' };
      if (values.startCmd.trim()) body.startCmd = values.startCmd.trim();
      if (values.cwd.trim()) body.cwd = values.cwd.trim();
      el('service-save').disabled = true;
      el('service-error').textContent = '';
      try {
        await context.api('/api/docs-registry', body, 'POST');
        form.reset();
        el('service-dialog').close();
        context.notice('服务已登记。');
        await loadDocs();
      } catch (error) { el('service-error').textContent = error.message; }
      finally { el('service-save').disabled = false; }
    };
  }

  root.MultiCCAirAdmin = Object.freeze({
    modes: new Set(['overview', 'attention', 'docs', 'memory', 'settings', ...Object.keys(legacyPanels)]),
    render,
    // The shell's console badge shows the same set the panel's first section does.
    urgentTasks,
    refresh: context => render(activeMode || 'overview', context, true),
    bindServiceDialog,
    // 状态与「在不在跑」的唯一判定，侧栏（air.js）和控制台共用这一份，所以一条
    // 任务在两个地方不可能显示成两种状态。
    taskStatus,
    isRunning,
    runningDirectories,
    statusBadge,
    applyRing,
  });
})(typeof window !== 'undefined' ? window : null);
