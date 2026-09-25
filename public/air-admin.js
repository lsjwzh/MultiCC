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
    // 保险箱在 Air 里排在最前：它不是「某一组功能里的一个开关」，而是控制中心里唯一
    // 会改变子进程 spawn 环境的一份配置（条目按同名环境变量注入），所以它既在设置
    // 中心的第一组、也在控制台工具格的第一格 —— 手机上一眼就能找到。（App 侧的设置
    // 页同一条规矩。）
    // 同 aux：这条只给设置中心的卡片和 modes 集合提供元数据，渲染走下面的
    // renderSecrets（Air 原生面板，不嵌旧 manage 页）。
    // 表里绝大多数条目现在都只有元数据的作用了（渲染走 nativePanels 表），
    // 留着是因为设置中心的卡片文案和 modes 集合都从这儿读。
    // 新加一栏 legacy 面板要同时去 air.js 的 adminHeadings 补同名页头，否则页头会把
    // mode 原样显示出来（显示成 secrets，而不是「敏感信息」）。
    secrets: [t('airAdminPanelSecrets'), t('secretsVaultShortHint'), 'SECRETS'],
    docs: [t('airAdminPanelDocs'), t('airAdminPanelDocsDesc'), 'DOCS'],
    memory: [t('airAdminPanelMemory'), t('airAdminPanelMemoryDesc'), 'MEMORY'],
    taskgraph: [t('airAdminPanelTaskgraph'), t('airAdminPanelTaskgraphDesc'), 'TASKGRAPH'],
    workspaces: [t('airAdminPanelWorkspaces'), t('airAdminPanelWorkspacesDesc'), 'WORKSPACES'],
    // aux 不是 legacy iframe 页(manage 那边配置在弹窗里,没有 view 可嵌)——
    // 这条只为设置中心的卡片和 modes 集合提供元数据,渲染走下面的 renderAux。
    aux: ['AI Assistant', t('airAdminPanelAuxDesc'), 'AUX'],
    voice: [t('airAdminPanelVoice'), t('airAdminPanelVoiceDesc'), 'VOICE'],
    goal: [t('airAdminPanelGoal'), t('airAdminPanelGoalDesc'), 'GOAL'],
    provider: [t('airAdminPanelProvider'), t('airAdminPanelProviderDesc'), 'PROVIDERS'],
    global: [t('airAdminPanelGlobal'), t('airAdminPanelGlobalDesc'), 'SETTINGS'],
    push: [t('airAdminPanelPush'), t('airAdminPanelPushDesc'), 'NOTIFICATIONS'],
    tunnel: [t('airAdminPanelTunnel'), t('airAdminPanelTunnelDesc'), 'NETWORK'],
    bridges: [t('airAdminPanelBridges'), t('airAdminPanelBridgesDesc'), 'BRIDGES'],
    resources: [t('airAdminPanelResources'), t('airAdminPanelResourcesDesc'), 'RESOURCES'],
    skillsync: [t('airAdminPanelSkillsync'), t('airAdminPanelSkillsyncDesc'), 'SKILLS'],
    storage: [t('airAdminPanelStorage'), t('airAdminPanelStorageDesc'), 'STORAGE'],
  };
  // 分组标题原来既当显示文案、又当 renderSettings 里拼 className 的比较值（'重要功能'）。
  // 现在这里存 i18n key：显示文案由 t() 查，className 判定也改比这个 key。
  const settingGroups = [
    ['airAdminGroupFeatured', ['secrets', 'docs', 'memory', 'taskgraph', 'workspaces']],
    ['airAdminGroupAi', ['provider', 'aux', 'goal', 'voice', 'global']],
    ['airAdminGroupConnect', ['push', 'tunnel', 'bridges']],
    ['airAdminGroupStorage', ['resources', 'skillsync', 'storage']],
  ];
  // 原生面板注册表：mode → 模块名 + 返回目标。这批原来都是嵌旧 manage 页的 iframe，
  // 一格一个文件搬成原生 DOM（同 provider / tunnel / secrets）。
  // 表格而不是十个各自成篇的 renderX：它们的差别只有「回哪去」，工具条形状一样
  // （返回 + 刷新），内容全在各自的模块里 —— 十份复制粘贴只会让下一格漏改一处。
  // 模块没挂上（旧页面、缓存半套静态资源）时的兜底见 renderModuleMissing：不再退回
  // 那个 iframe，理由写在那儿。
  const nativePanels = {
    memory: { module: 'MultiCCAirMemory', back: 'overview' },
    taskgraph: { module: 'MultiCCAirTaskgraph', back: 'overview' },
    voice: { module: 'MultiCCAirVoice', back: 'settings' },
    goal: { module: 'MultiCCAirGoal', back: 'settings' },
    global: { module: 'MultiCCAirGlobal', back: 'settings' },
    push: { module: 'MultiCCAirPush', back: 'settings' },
    bridges: { module: 'MultiCCAirBridges', back: 'settings' },
    resources: { module: 'MultiCCAirResources', back: 'settings' },
    skillsync: { module: 'MultiCCAirSkillsync', back: 'settings' },
    storage: { module: 'MultiCCAirStorage', back: 'settings' },
    workspaces: { module: 'MultiCCAirWorkspaces', back: 'settings' },
  };
  let activeMode = null;
  let currentContext = null;
  // 控制台里那份「全部任务」的筛选，存在模块上而不是 DOM 上：面板每次重开都会
  // 重建 DOM，筛选跟着输入框一起丢掉的话，翻回去看同一条列表要重挑一次。
  //
  // fullText 默认开：搜索的默认目标是「全部记录（含对话）」，因为只出现在对话正文里
  // 的词走不到任务板语料。注意它换的不是上面那条状态口径 —— 列表默认仍是「进行中与
  // 待处理」，搜索另有一份 searchFilter()（见下）。
  const consoleFilter = { query: '', status: 'open', dir: 'all', fullText: true };
  // 面板是给人看的，不是导出用的：超过这个数就只显示最近的一批，并把总数说清楚。
  const TASK_LIST_LIMIT = 60;
  // 「谁在等我」是面板的第一格，也是打开控制台第一眼要看的东西，所以它只留最近更新的
  // 几条：一屏扫完，剩下的交给它自己的整页（这一格的「查看全部」）。不封顶的话，
  // 等我的任务一多，这一格就把下面的「全部任务」和工具格整片推出视野 ——
  // 控制台变成一份清单的滚动条。
  //
  // 「最近更新」是纯时间倒序，不按紧急度分层：刚动过的那几条才是我脑子里还挂着的事，
  // 而一条三小时前出错、此后没人碰过的任务，即使更「急」也排不到刚接手的前面。
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
  const registry = () => root.MultiCCStatusPresentation;
  // 状态词只有一份，在注册表的 airLabelKey 列上（Air 面自带的词表，跟阶段、资源
  // 去向那些词同源），由 airStatusLabels() 取给这一页和侧栏（air.js 的 stateNames）。
  // 这张表从前是手抄的，于是同一个状态在侧栏和控制台能读出两个词 —— 比如「等待回答」
  // 出现在一条只是在等后台任务、根本不需要用户动手的卡上。
  // t() 是 air.html 的全局（i18n.js 载入），Air 是带词典的。
  const STATUS_COPY = Object.freeze(registry()?.airStatusLabels?.(t) || {});

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
  /** 圈的颜色：同一件东西每次挑到同一档（按 id 哈希），彼此之间看起来是随机的。
   *
   *  调色板和哈希都住在 status-presentation.js —— 老看板那张卡片的描边用的是同
   *  一份（.card-border-rainbow 和 .ring-running 是同一条规则的两个壳），同一件
   *  东西在两页上不该是两个颜色，所以这里不再自己留一份调色板。
   *  status-presentation.js 必须在本脚本之前加载（air.html 里就是这么排的）；
   *  万一没有，圈退回主题强调色 —— 少一个变量不该让圈整个消失。 */
  function ringTint(seed) {
    const shared = registry();
    return shared ? shared.ringTint(seed) : '#7fb0ff';
  }
  /**
   * 圈是「这条在跑」的唯一视觉信号，但它不再逐帧动画：一个静态的加粗描边，颜色按
   * seed（任务/目录 id）从 RING_TINTS 里挑。用 id 而不是随机数，是因为列表每 4 秒
   * 随快照重画一次 —— 随机会让同一行的颜色每刷一次就换一次，看着像在闪。
   * 没给 seed（临时节点、老调用点）就一个字都不写，css 里那条 `var(--ring-tint,
   * var(--accent))` 会退回主题强调色：圈不会因为少一个参数就整个消失。
   */
  function applyRing(element, on, seed) {
    if (!element) return;
    const ring = !!on;
    element.classList.toggle('ring-running', ring);
    // 摘圈的时候顺手把色也清掉：行是复用出来的，留着就是上一条任务的旧颜色。
    if (!ring || seed == null) element.style.removeProperty('--ring-tint');
    else element.style.setProperty('--ring-tint', ringTint(seed));
  }

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

  /**
   * 外层任务卡只标「还有改动没交付」：dirty 是未提交文件，ahead 是已经提交但尚未
   * 合回基分支。behind 代表需要同步基分支，不属于这枚图标的语义，客户端不推断它。
   */
  function worktreeChangeLabel(task) {
    const changes = task?.worktreeChanges;
    if (!changes || typeof changes !== 'object') return '';
    const dirty = changes.dirty === true;
    const ahead = Math.max(0, Number.parseInt(changes.ahead, 10) || 0);
    if (dirty && ahead) return t('airWorktreePendingBoth', { n: ahead });
    if (dirty) return t('airWorktreePendingDirty');
    if (ahead) return t('airWorktreePendingAhead', { n: ahead });
    return '';
  }

  /** 静态的 worktree 待交付图标；tooltip 与无障碍名说清是哪一种改动。 */
  function worktreeChangeBadge(task) {
    const label = worktreeChangeLabel(task);
    if (!label) return null;
    const badge = make('span', '⎇', 'worktree-change-badge');
    badge.title = label;
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', label);
    return badge;
  }

  /** 行的第二层信息：徽标已经说了「在不在跑」，这里补记录类型、阶段和资源去向。 */
  //
  // 阶段只有计划记录才有：`workflowStage` 是计划看板的那一列，观察型记录（从对话
  // 里长出来的任务）这个字段恒为 null。所以不要拿 `status` 兜底 —— 它是生命周期
  // （active/done/archived），label 出来就是「进行中」，而同一行上的徽标正说着
  // 「空闲」/「执行成功」，一行话自相矛盾。侧栏（`air.js` 的 renderSidebarTasks）
  // 早就是这个规矩，这里向它对齐。
  function taskDetail(task, context) {
    const bits = [];
    const stage = task.recordType === 'planned' ? context.label(task.workflowStage || task.status) : '';
    if (stage) bits.push(t('airAdminPlannedStage', { stage }));
    const resource = task.resource || {};
    const held = resource.capacityReason ? context.label(resource.capacityReason)
      : resource.lease && resource.lease !== 'idle' ? context.label(resource.lease)
        : context.label(resource.residency);
    // 徽标已经说过的词不在这里再说一遍（「执行中 · 执行中」不是更多信息）。
    const badgeText = context.label(taskStatus(task));
    if (held && held !== stage && !badgeText.includes(held)) bits.push(held);
    return bits.join(' · ');
  }

  /**
   * 控制台与目录面板共用的任务筛选语义。directoryName 只在跨目录搜索时传入；
   * 目录首页已经把 rows 收窄到一个目录，所以搜索标题即可。
   *
   * `keepOrder` 给全文检索用：那批任务进来时已经是相关度顺序，时间排序会把服务端
   * 算出来的名次抹掉。除了不排序，其余筛选一字不差 —— 状态与目录的口径只有这一份。
   */
  function filterTasks(tasks, filter = {}, directoryName = () => '', { keepOrder = false } = {}) {
    const status = filter.status || 'open';
    const dir = filter.dir || 'all';
    const needle = String(filter.query || '').trim().toLowerCase();
    const rows = (tasks || [])
      .filter(task => status === 'all' ? true
        : status === 'archived' ? task.status === 'archived'
          : !['done', 'archived'].includes(task.status))
      .filter(task => dir === 'all' || task.dirId === dir);
    if (keepOrder) return rows;
    // 本地过滤按标题（和目录名）匹配：它仍是即时反馈，也是全文检索不可用时的退路。
    const matched = !needle ? rows
      : rows.filter(task => `${task.title || ''} ${directoryName(task.dirId)}`.toLowerCase().includes(needle));
    return matched.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  /**
   * 搜索用的筛选口径：搜索永远搜「全部记录」，不套状态那格 —— 默认只看在办会把已
   * 归档任务的命中静默滤掉（服务端有结果、列表显示 0 条），而那正是「明明搜得到却
   * 搜不到」的来源。状态选择器管的是不搜索时的列表；目录那格照旧参与（它本来就是
   * 搜索范围的一部分）。
   */
  function searchFilter(filter = {}) {
    return { ...filter, status: 'all' };
  }

  /**
   * 全文检索结果 → 相关度顺序的任务数组（服务端顺序，逐条仍是同一份筛选口径）。
   * rankedHits 会把两条语料合成一份：任务板命中在前，会话正文命中接在后面（同一条
   * 任务只留最强的那次）。
   */
  function rankedRows(tasks, filter, directoryName, results) {
    const ranked = window.MultiCCTaskSearch?.rankedHits?.(results, tasks);
    if (!ranked?.length) return null;
    const snippets = new Map(ranked.map(({ task, hit }) => [task.id, hit.snippet]));
    const rows = filterTasks(ranked.map(({ task }) => task), filter, directoryName, { keepOrder: true });
    // 本地状态/目录筛选可能把命中的前几名滤掉，滤掉的那几条不该继续占位置。
    return rows.map(task => ({ task, snippet: snippets.get(task.id) || null }));
  }

  /** 一条任务行：徽标 + 标题 + 目录/阶段 + 时间；删除是独立按钮，避免按钮嵌套。 */
  function taskRow(task, context, options = {}) {
    const row = make('div', null, 'admin-recent-row');
    const openTask = () => {
      options.onOpen?.();
      context.navigate(task.dirId, task.id);
    };
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.onclick = event => { if (!event.target.closest('.task-delete')) openTask(); };
    row.onkeydown = event => {
      if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('.task-delete')) {
        event.preventDefault();
        openTask();
      }
    };
    applyRing(row, isRunning(task), task.id);
    const body = make('span', null, 'task-row-open');
    const copy = make('span');
    // 两排：标题在上，徽标 + 目录/阶段在下。徽标原来占着最左边一列（这一行是三列
    // flex），窄屏上和行尾的删除一起把标题挤到只剩九十几像素 —— 而标题是这一行里
    // 唯一必须读全的字段。目录首页的 `directory-task-row` 一直是这个形状，这里向它
    // 对齐（App 的任务行同一天也照这个改了）。
    const meta = make('small', null, 'task-meta');
    meta.append(statusBadge(task, options.badge || {}));
    const worktreeBadge = worktreeChangeBadge(task);
    if (worktreeBadge) meta.append(worktreeBadge);
    const where = options.dir === false ? '' : context.directoryName(task.dirId);
    const note = [where, taskDetail(task, context)].filter(Boolean).join(' · ');
    if (note) meta.append(make('em', note, 'task-note'));
    copy.append(make('strong', task.title || t('airAdminUntitledTask')), meta);
    // 全文检索命中时把命中的那段原文摆出来：标题里没有查询词、却在正文/历史轮次里
    // 命中时，这一行就是「为什么它被搜出来」的唯一解释。
    const snippet = window.MultiCCTaskSearch?.snippetNode?.(options.snippet);
    if (snippet) copy.append(snippet);
    body.append(copy, make('time', task.updatedAt ? new Date(task.updatedAt).toLocaleString(getLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''));
    row.append(body);
    if (options.deletable && context.deleteTask) {
      const remove = action(t('airAdminDelete'), async event => {
        event.stopPropagation();
        await context.deleteTask(task);
      }, 'task-delete danger');
      remove.dataset.action = 'delete';
      remove.setAttribute('aria-label', t('airAdminDeleteTaskLabel', { name: task.title || t('airAdminUntitledTask') }));
      row.append(remove);
    }
    return row;
  }

  // 「谁在等我」：跨所有目录、**需要我动手**的任务。正在跑的不算 —— 它在跑，
  // 不需要我做任何事，混进清单只会把真正等我的那几条挤下去（这一格只留 5 条）。
  // 这条信号原来由侧栏的「跨目录活动」承担，现在它是控制台面板的第一个分区，
  // 也是入口徽标的数字 —— 一处定义，两处显示，不会再各说各话。
  //
  // 分级只用来判断「算不算在等我」这件事（见 needsAttention），不再决定谁排在前
  // 面 —— 排序是纯时间。
  function taskUrgency(task) {
    const status = taskStatus(task);
    if (status === 'waiting') return 0;
    if (status === 'error') return 1;
    if (task.resource?.capacityReason) return 2;
    if (status === 'running' || status === 'background' || RUNNING_LEASES.includes(task.resource?.lease)) return 3;
    if (status === 'done' || status === 'archived') return 5;
    return 4;
  }
  // 「在等我」的分界线：0 等我回答 · 1 出错要我去处理 · 2 卡在资源 —— 这三类都得
  // 我动手。3（正在跑 / 后台等待）不列进来：跑着的东西不是待办，它不需要我操作。上面那张
  // 「等待处理」统计卡走的是同一条线，两处口径必须一致。
  function needsAttention(task) { return taskUrgency(task) < 3; }
  // 谁在等我由上面那条线筛出来，排在最前面的是最近动过的那条 —— 刚有动静的
  // 任务才是眼下要接手的那条。
  function urgentTasks(data) {
    return (data?.tasks || [])
      .filter(needsAttention)
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
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
    const waiting = active.filter(needsAttention);
    const enabledSchedules = (scheduleTasks || []).filter(task => task.enabled);
    const running = runningDirectories(data);
    // The overview lives in the console panel; `#admin-content` is the fallback
    // for any host that renders it as a page.
    const panel = el('console-content');
    setActions([
      action(t('airAdminBrowseDirectories'), () => setMode('library'), '', panelIcon('▦')),
      action(t('airAdminNewTask'), () => { setMode('tasks'); setTimeout(() => el('create')?.click(), 0); }, 'primary', keepsGlyph('＋')),
    ], panel ? 'console-actions' : 'admin-actions');

    const content = panel || el('admin-content');
    const stats = make('div', null, 'admin-stats');
    stats.append(
      statCard(t('airAdminWorkDirectories'), directories.length, running.size ? t('airAdminDirectoriesRunning', { n: running.size }) : t('airAdminUnifiedLibrary'), 'blue', () => setMode('library')),
      statCard(t('airAdminActiveTasks'), active.length, t('airAdminTasksExecuting', { n: executing.length }), 'green', () => setMode('tasks')),
      statCard(t('airAdminNeedsAttention'), waiting.length, waiting.length ? t('airAdminWaitingDetail') : t('airAdminNothingPending'), waiting.length ? 'amber' : ''),
      statCard(t('airAdminScheduledTasks'), enabledSchedules.length, t('airAdminScheduleRules', { n: (scheduleTasks || []).length }), 'purple', () => setMode('schedules')),
    );

    const assistant = action('', () => setMode('aux'), 'admin-assistant-card');
    assistant.id = 'console-ai-assistant';
    assistant.append(
      make('span', '✦', 'admin-assistant-mark'),
      make('span', null, 'admin-assistant-copy'),
      make('span', t('airAdminOpenConfig'), 'admin-assistant-action'),
    );
    assistant.querySelector('.admin-assistant-copy').append(
      make('span', 'AI ASSISTANT', 'eyebrow'),
      make('strong', t('airAdminAssistantTagline')),
      make('small', t('airAdminAssistantDesc')),
    );

    const attention = make('section', null, 'admin-panel console-attention');
    const attentionHead = make('div', null, 'admin-panel-head');
    attentionHead.append(make('div'));
    attentionHead.firstChild.append(make('span', 'ACROSS ALL WORKSPACES', 'eyebrow'), make('h3', t('airAdminWhoNeedsMe')));
    // 清单本来就按最近更新排过，所以「只显示前几条」砍掉的是最久没动过的那些，
    // 留下的仍是眼下最近有动静的人。总数照报，别让封顶看起来像「就这么几条」。
    const urgent = urgentTasks(data);
    const overflowed = urgent.length > ATTENTION_LIMIT;
    const attentionMeta = make('div', null, 'admin-panel-meta');
    attentionMeta.append(make('span', overflowed
      ? t('airAdminAttentionOverflow', { total: urgent.length, limit: ATTENTION_LIMIT })
      : t('airAdminSortedByRecent'), 'admin-panel-note'));
    // 没超过就没有第二页可去，出口不出现 —— 按钮跟着「有地方可去」出现，而不是
    // 常驻一个点了没反应的「全部」。
    if (overflowed) attentionMeta.append(action(t('airAdminViewAllCount', { n: urgent.length }), () => setMode('attention')));
    attentionHead.append(attentionMeta);
    const attentionList = make('div', null, 'admin-recent-list');
    // 从面板里点走一条任务时，面板自己让开（onOpen），否则它盖住的正是刚落上去的那一页。
    for (const task of urgent.slice(0, ATTENTION_LIMIT)) attentionList.append(taskRow(task, context, { onOpen: () => context.closeConsole?.() }));
    if (!attentionList.children.length) attentionList.append(make('p', t('airAdminNoAttentionTasks'), 'admin-empty'));
    attention.append(attentionHead, attentionList);

    const split = make('div', null, 'admin-overview-grid');
    // 全部任务：控制台是跨目录的，这里不按当前目录收窄 —— 目录是执行上下文，
    // 不是「能不能看见这条任务」的前提。
    const allPanel = make('section', null, 'admin-panel');
    const allHead = make('div', null, 'admin-panel-head');
    allHead.append(make('div', null));
    allHead.firstChild.append(make('span', t('airAdminAllTasksEyebrow'), 'eyebrow'), make('h3', t('airAdminAllTasks')));
    const allNote = make('span', '', 'admin-panel-note');
    allNote.id = 'console-task-note';
    allHead.append(allNote);
    const controls = make('div', null, 'admin-task-controls');
    const search = make('input');
    search.type = 'search';
    search.id = 'console-task-search';
    search.placeholder = t('airAdminSearchPlaceholder');
    search.setAttribute('aria-label', t('airAdminSearchTasksLabel'));
    search.value = consoleFilter.query;
    const statusPick = make('select');
    statusPick.id = 'console-task-status';
    statusPick.setAttribute('aria-label', t('airAdminFilterByStatus'));
    for (const [value, text] of [['open', t('airAdminFilterOpen')], ['all', t('airAdminFilterAll')], ['archived', t('airAdminStatusArchived')]]) {
      const option = make('option', text);
      option.value = value;
      statusPick.append(option);
    }
    statusPick.value = consoleFilter.status;
    const scopePick = make('select');
    scopePick.id = 'console-task-scope';
    scopePick.setAttribute('aria-label', t('airSearchScopeLabel'));
    for (const [value, text] of [['full', t('airSearchScopeFull')], ['board', t('airSearchScopeBoard')]]) {
      const option = make('option', text);
      option.value = value;
      scopePick.append(option);
    }
    scopePick.value = consoleFilter.fullText ? 'full' : 'board';
    const dirPick = make('select');
    dirPick.id = 'console-task-dir';
    dirPick.setAttribute('aria-label', t('airAdminFilterByDirectory'));
    const allDirs = make('option', t('airAdminAllDirectories'));
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
    // 全文检索控制器。构造时就会跑一次 onChange，所以先声明成 null：那一刻
    // paintTaskList 只能走本地筛选，等控制器拿到结果再覆盖（见下面的赋值）。
    let fullText = null;
    function paintTaskList() {
      // 有全文结果就按相关度排（标题没命中、正文命中的任务因此能被找到）；没有
      // （还没回来 / 报错 / 查询为空）就退回原来的本地标题筛选，面板从不空着。
      // 有查询时口径换成 searchFilter()：服务端那次和「还没回来/报错」的本地退路
      // 必须同一份口径，否则同一句话在结果回来前后能搜出两种条数。
      const querying = !!consoleFilter.query.trim();
      const active = querying ? searchFilter(consoleFilter) : consoleFilter;
      const rows = (querying
        ? rankedRows(tasks, active, context.directoryName, fullText?.results())
        : null) || filterTasks(tasks, active, context.directoryName).map(task => ({ task }));
      const shown = rows.slice(0, TASK_LIST_LIMIT);
      allList.replaceChildren(...shown.map(({ task, snippet }) => taskRow(task, context, {
        onOpen: () => context.closeConsole?.(), deletable: true, snippet,
      })));
      if (!rows.length) allList.append(make('p', t('airAdminNoMatchingTasks'), 'admin-empty'));
      allNote.textContent = rows.length > shown.length
        ? t('airAdminTaskCountLimited', { total: rows.length, shown: shown.length })
        : t('airAdminNItems', { n: rows.length });
    }
    search.oninput = () => { consoleFilter.query = search.value; paintTaskList(); };
    // 搜索框同时挂两条路：本地筛选立刻重画（上面那条），全文结果到了再按相关度覆盖
    // 一次。过滤条件不发给服务端 —— 「进行中」这类口径只此一份，命中结果回到这里
    // 再按同一份 filterTasks 收窄，服务端只负责「哪些任务的正文里出现过这些词」。
    fullText = window.MultiCCTaskSearch?.attach(search, {
      request: path => context.api(path),
      limit: TASK_LIST_LIMIT,
      fullText: () => consoleFilter.fullText,
      onChange: () => paintTaskList(),
    });
    statusPick.onchange = () => { consoleFilter.status = statusPick.value; paintTaskList(); };
    // 搜索范围换了要重新问一次服务端（两条语料的召回不同），不能只重画：
    // 缓存按「查询词 + 范围」分开，所以换回来是立刻的。
    scopePick.onchange = () => {
      consoleFilter.fullText = scopePick.value === 'full';
      fullText?.refresh();
      paintTaskList();
    };
    dirPick.onchange = () => { consoleFilter.dir = dirPick.value; paintTaskList(); };
    controls.append(search, statusPick, scopePick, dirPick);
    allPanel.append(allHead, controls, allList);
    paintTaskList();

    const workspacePanel = make('section', null, 'admin-panel admin-directory-panel');
    const workspaceHead = make('div', null, 'admin-panel-head');
    workspaceHead.append(make('div'));
    workspaceHead.firstChild.append(make('span', 'WORK DIRECTORIES', 'eyebrow'), make('h3', t('airAdminWorkDirectories')));
    workspaceHead.append(action(t('airAdminDirectoryLibrary'), () => setMode('library')));
    const workspaceList = make('div', null, 'admin-directory-list');
    for (const directory of directories) {
      const directoryTasks = tasks.filter(task => task.dirId === directory.id);
      const unfinished = directoryTasks.filter(task => !['done', 'archived'].includes(task.status));
      const executingCount = unfinished.filter(isRunning).length;
      const row = action('', () => navigate(directory.id), 'admin-directory-row');
      row.dataset.dirId = directory.id;
      // 任务对应的目录也要带圈：一个「有活在跑」的目录不该等到点进去才发现。
      applyRing(row, running.has(directory.id), directory.id);
      const copy = make('span');
      copy.append(make('strong', directory.name || directory.id), make('small', directory.path || ''));
      const counts = make('span', null, 'admin-directory-counts');
      counts.append(make('b', t('airAdminNInProgress', { n: unfinished.length })), make('small', executingCount ? t('airAdminNExecuting', { n: executingCount }) : t('airAdminNTaskCount', { n: directoryTasks.length })));
      row.append(make('span', '▣', 'admin-directory-mark'), copy, counts, make('span', '›', 'admin-directory-arrow'));
      workspaceList.append(row);
    }
    if (!directories.length) workspaceList.append(make('p', t('airAdminNoDirectories'), 'admin-empty'));
    // 拖着换顺序，顺序存服务端（air-directory-nav.js）。
    window.MultiCCAirDirectoryNav?.sortable(workspaceList, context);
    workspacePanel.append(workspaceHead, workspaceList);

    const tools = make('section', null, 'admin-panel');
    const toolHead = make('div', null, 'admin-panel-head');
    toolHead.append(make('div'));
    toolHead.firstChild.append(make('span', 'SYSTEM TOOLS', 'eyebrow'), make('h3', t('airAdminServicesAndSettings')));
    const toolGrid = make('div', null, 'admin-tool-grid');
    // 保险箱不在这张格子里：它在控制台的顶栏上（air.html 的 #console-secrets），
    // 跟「返回任务」并列常驻，不用滚到工具格才找得到。
    const shortcuts = [
      ['docs', '▤', t('airAdminPanelDocs'), t('airAdminPanelDocsDesc')],
      ['memory', '◇', t('airAdminPanelMemory'), t('airAdminMemoryShortDesc')],
      ['taskgraph', '⛓', t('airAdminPanelTaskgraph'), t('airAdminTaskgraphShortDesc')],
      ['settings', '⚙', t('airAdminSettingsCenter'), t('airAdminSettingsShortDesc')],
      ['schedules', '◴', t('airAdminAutoRun'), t('airAdminAutoRunDesc')],
    ];
    for (const [mode, icon, title, detail] of shortcuts) {
      const button = action('', () => setMode(mode), 'admin-tool-card');
      button.append(make('span', icon, 'admin-tool-icon'), make('strong', title), make('small', detail));
      toolGrid.append(button);
    }
    tools.append(toolHead, toolGrid);
    split.append(allPanel, tools);
    // 控制台要回答的是两件「一眼扫完」的事：谁在等我，以及我有哪些目录。所以「工作目录」
    // 紧跟在「谁在等我」后面 —— 它是这一页的第二眼，不该压在「全部任务」和工具格底下
    // 等用户滚到底才看见。
    content.replaceChildren(stats, assistant, attention, workspacePanel, split);
  }

  // 「谁在等我」的整页：控制台那一格只放最近更新的几条，完整清单在这里。它和控制台
  // 那一格用的是同一个 urgentTasks(data) —— 排序规则只有一份，所以两边不会把
  // 「谁在前面」排成两个样子。
  function renderAttention(context) {
    setActions([
      action(t('airAdminBackToConsole'), () => context.setMode('overview'), '', panelIcon('←')),
      // 数据在外壳那份 /api/air 快照里，所以这一页没有自己的接口可打，刷新只能
      // 请外壳去取。取完外壳会自己重画当前模式，但走的是「模式没变就跳过」那条
      // 早退路径 —— 这里再强制重画一次，否则按钮按下去什么都不动。
      action(t('airAdminRefresh'), async () => { await context.refresh?.(); render('attention', context, true); }, '', keepsGlyph('↻')),
    ]);
    const urgent = urgentTasks(context.data);
    const panel = make('section', null, 'admin-panel console-attention-page');
    const head = make('div', null, 'admin-panel-head');
    head.append(make('div'));
    head.firstChild.append(make('span', 'ACROSS ALL WORKSPACES', 'eyebrow'), make('h3', t('airAdminWhoNeedsMe')));
    head.append(make('span', urgent.length ? t('airAdminAttentionPageNote', { n: urgent.length }) : t('airAdminNothingPending'), 'admin-panel-note'));
    const list = make('div', null, 'admin-recent-list');
    // 这一页本身就是完整清单，点走一条不用收掉任何浮层 —— 直接把 navigate 交给
    // taskRow 的默认行为，不套控制台那层 onOpen。
    for (const task of urgent) list.append(taskRow(task, context));
    if (!urgent.length) list.append(make('p', t('airAdminNoAttentionTasks'), 'admin-empty'));
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
      currentContext.notice(actionName === 'start' ? t('airAdminServiceStartSent') : t('airAdminServiceStopSent'));
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
    if (!confirm(t('airAdminConfirmDeleteEntry', { name: entry.title }))) return;
    try {
      await currentContext.api(`/api/docs-registry/${encodeURIComponent(entry.id)}`, undefined, 'DELETE');
      currentContext.notice(t('airAdminEntryDeleted'));
      await loadDocs();
    } catch (error) { currentContext.notice(error.message); }
  }

  function renderDocEntry(entry) {
    const card = make('article', null, `air-doc-card ${entry.expired ? 'expired' : ''}`);
    const icon = make('span', entry.kind === 'service' ? '◎' : entry.kind === 'file' ? '⌑' : '▤', 'air-doc-icon');
    const copy = make('div', null, 'air-doc-copy');
    const titleRow = make('div', null, 'air-doc-title');
    const link = make('a', entry.title || entry.url || t('airAdminUntitled'));
    link.href = serviceUrl(entry.url);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    titleRow.append(link);
    if (entry.pinned) titleRow.append(make('span', t('airAdminPinned'), 'air-doc-tag pin'));
    if (entry.expired) titleRow.append(make('span', t('airAdminExpired'), 'air-doc-tag expired'));
    const status = entry.kind === 'service' ? `${entry.status === 'up' ? t('airAdminStatusUp') : entry.status === 'starting' ? t('airAdminStatusStarting') : entry.status === 'down' ? t('airAdminStatusDown') : t('airAdminStatusUnknown')} · ` : '';
    copy.append(titleRow, make('small', `${status}${entry.url || ''}`), make('small', [entry.source, entry.sessionId, entry.createdAt ? new Date(entry.createdAt).toLocaleString(getLocale()) : ''].filter(Boolean).join(' · ')));
    const actions = make('div', null, 'air-doc-actions');
    if (entry.kind === 'service') {
      const log = make('a', t('airAdminLog'));
      log.href = `/api/docs-registry/${encodeURIComponent(entry.id)}/log`;
      log.target = '_blank'; log.rel = 'noopener noreferrer';
      actions.append(log);
      if (entry.status === 'up' || entry.status === 'starting') actions.append(action(t('airAdminStop'), () => serviceAction(entry, 'stop'), 'danger'));
      else {
        const start = action(entry.startCmd ? t('airAdminStart') : t('airAdminNoStartCommand'), () => serviceAction(entry, 'start'), 'subtle');
        start.disabled = !entry.startCmd;
        actions.append(start);
      }
    }
    actions.append(action(entry.pinned ? t('airAdminUnpin') : t('airAdminPinned'), () => togglePin(entry), 'subtle'), action(t('airAdminDelete'), () => removeEntry(entry), 'danger'));
    card.append(icon, copy, actions);
    return card;
  }

  async function loadDocs() {
    const list = el('air-doc-list');
    if (!list) return;
    list.replaceChildren(make('p', t('airAdminLoadingDocs'), 'admin-empty'));
    try {
      const entries = await currentContext.api('/api/docs-registry');
      const summary = el('air-doc-summary');
      if (summary) {
        const services = entries.filter(entry => entry.kind === 'service');
        summary.textContent = t('airAdminDocsSummary', { total: entries.length, up: services.filter(entry => entry.status === 'up').length, services: services.length });
      }
      list.replaceChildren(...entries.map(renderDocEntry));
      if (!entries.length) list.append(make('p', t('airAdminNoDocs'), 'admin-empty'));
    } catch (error) {
      list.replaceChildren(make('p', t('airAdminLoadFailed', { message: error.message }), 'admin-empty error'));
    }
  }

  function renderDocs(context) {
    setActions([
      action(t('airAdminRefresh'), () => loadDocs(), '', keepsGlyph('↻')),
      action(t('airAdminRegisterService'), () => el('service-dialog').showModal(), 'primary', keepsGlyph('＋')),
    ]);
    const wrap = make('div', null, 'air-docs');
    const top = make('div', null, 'air-docs-meta');
    top.append(make('span', t('airAdminDocsNote')), make('strong', t('airAdminLoading')));
    top.lastChild.id = 'air-doc-summary';
    const list = make('div', null, 'air-doc-list');
    list.id = 'air-doc-list';
    wrap.append(top, list);
    el('admin-content').replaceChildren(wrap);
    void loadDocs();
  }

  // ── AI Assistant(aux):设置与运行记录 ─────────────────────────────────
  // manage 页那套 aux 界面(config 弹窗 + history 弹窗)不是一个 view,控制台嵌不了,
  // 所以这里是原生实现:运行状态、模型设置、运行记录三段,数据全走 /api/aux/*。
  // 面板每次重开都重建 DOM,拉到的数据留在模块上,绘制函数各自对「元素还在不在」负责。
  const auxView = { config: null, status: null, history: [] };

  function auxField(labelText, control) {
    const label = make('label', null, 'air-aux-field');
    label.append(make('span', labelText), control);
    return label;
  }

  function renderAux(context) {
    setActions([
      action(t('airAdminBackToSettings'), () => context.setMode('settings'), '', panelIcon('←')),
      action(t('airAdminRefresh'), () => loadAuxView(true), '', keepsGlyph('↻')),
    ]);
    const statusPanel = make('section', null, 'admin-panel');
    const statusHead = make('div', null, 'admin-panel-head');
    statusHead.append(make('div'));
    statusHead.firstChild.append(make('span', 'AUX QUEUE', 'eyebrow'), make('h3', t('airAdminRunStatus')));
    const statusBody = make('div', null, 'air-aux-status');
    statusBody.id = 'air-aux-status';
    statusPanel.append(statusHead, statusBody);

    const formPanel = make('section', null, 'admin-panel');
    const formHead = make('div', null, 'admin-panel-head');
    formHead.append(make('div'));
    formHead.firstChild.append(make('span', 'MODEL', 'eyebrow'), make('h3', t('airAdminModelSettings')));
    formHead.append(make('span', t('airAdminModelNote'), 'admin-panel-note'));
    const form = make('div', null, 'air-aux-form');
    form.id = 'air-aux-form';
    formPanel.append(formHead, form);

    const recPanel = make('section', null, 'admin-panel');
    const recHead = make('div', null, 'admin-panel-head');
    recHead.append(make('div'));
    recHead.firstChild.append(make('span', 'HISTORY', 'eyebrow'), make('h3', t('airAdminRunHistory')));
    const recNote = make('span', '', 'admin-panel-note');
    recNote.id = 'air-aux-records-note';
    recHead.append(recNote);
    const recList = make('div', null, 'air-aux-records');
    recList.id = 'air-aux-records';
    recPanel.append(recHead, recList);

    el('admin-content').replaceChildren(statusPanel, formPanel, recPanel);
    void loadAuxView();
  }

  async function loadAuxView(announce = false) {
    try {
      const [status, config, history, installSpecs] = await Promise.all([
        currentContext.api('/api/aux/status'),
        currentContext.api('/api/aux/config'),
        currentContext.api('/api/aux/history?limit=100'),
        currentContext.api('/api/cli/install-specs').catch(() => null),
      ]);
      auxView.status = status;
      auxView.config = config;
      auxView.history = Array.isArray(history) ? history : [];
      auxView.installSpecs = installSpecs && installSpecs.ok ? installSpecs : null;
      paintAuxStatus();
      paintAuxForm();
      paintAuxRecords();
      if (announce) currentContext.notice(t('airAdminAssistantRefreshed'));
    } catch (error) {
      currentContext.notice(t('airAdminAssistantLoadFailed', { message: error.message }));
    }
  }

  function paintAuxStatus() {
    const body = el('air-aux-status');
    if (!body) return;
    const s = auxView.status || {};
    const health = s.health || {};
    const serial = (s.lanes && s.lanes.serial) || {};
    // 并发池读数：active/total 是「几个槽在跑」，queueDepth 仍是「几个在排队」。
    // 老服务端只肯给 processing/queueDepth 时退化成 1/1，不编造槽位数。
    const capacity = Number(s.capacity) > 0
      ? Number(s.capacity)
      : (Number(s.concurrency) > 0 ? Number(s.concurrency) + 1 : 1);
    const active = Number.isFinite(Number(s.active)) ? Number(s.active) : (s.processing ? 1 : 0);
    const state = s.processing ? t('airAdminProcessing') : (s.queueDepth > 0 ? t('airAdminQueuedCount', { n: s.queueDepth }) : t('airAdminStatusIdle'));
    const rows = [
      [t('airAdminLabelStatus'), s.currentTask ? t('airAdminStatusExecuting', { state, type: s.currentTask.type || '' }) : state],
      [t('airAdminPool'), t('airAdminPoolValue', { active, total: capacity, queued: Number(s.queueDepth) || 0 })],
      [t('airAdminSerialLane'), t('airAdminSerialLaneValue', { active: Number(serial.active) || 0, queued: Number(serial.queueDepth) || 0 })],
      [t('airAdminTotalProcessed'), t('airAdminNItems', { n: s.totalProcessed || 0 })],
      [t('airAdminLastRun'), s.lastTaskTime ? new Date(s.lastTaskTime).toLocaleString(getLocale()) : '—'],
    ];
    body.replaceChildren(...rows.map(([name, value]) => {
      const row = make('div', null, 'air-aux-row');
      row.append(make('span', name), make('strong', value));
      return row;
    }));
    if (health.unhealthy) {
      // 服务端给出的 lastFailMsg 已过 safeAuxErrorMessage;这里仍走 textContent,不进 HTML。
      body.append(make('div',
        t('airAdminAuxUnhealthy', { fails: health.consecutiveFails || 0, message: health.lastFailMsg || t('airAdminUnknownError') }),
        'air-aux-warn'));
    }
  }

  function paintAuxForm() {
    const form = el('air-aux-form');
    if (!form) return;
    const config = auxView.config;
    if (!config) {
      form.replaceChildren(make('p', t('airAdminConfigLoadFailed'), 'admin-empty error'));
      return;
    }
    const pick = (options, value) => {
      const select = make('select');
      for (const [text, v] of options) {
        const option = make('option', text);
        option.value = v;
        select.append(option);
      }
      select.value = value;
      return select;
    };
    const protocol = pick((config.protocols || []).map(p => [p.name, p.id]),
      config.protocol === 'openai' ? 'openai' : 'anthropic');
    const provider = make('select');
    const model = make('select');
    const cli = config.cliAvailability || null;
    const noCliAtAll = !!cli && cli.claude === false && cli.codex === false;
    const installCmd = (cliId) => {
      const spec = auxView.installSpecs?.specs?.[cliId];
      return (spec && (spec.display || spec.command))
        || (cliId === 'codex' ? 'npm install -g @openai/codex' : 'npm install -g @anthropic-ai/claude-code');
    };
    const cliBanner = make('div', '', 'air-aux-warn');
    cliBanner.hidden = !noCliAtAll;
    if (noCliAtAll) {
      cliBanner.append(make('div', t('airAdminAuxCliMissingNone')));
      cliBanner.append(make('code', `${installCmd('claude')}  |  ${installCmd('codex')}`));
    }
    const modelHint = make('div', '', 'air-aux-warn');
    const syncBtn = action(t('airAdminAuxSyncModels'), async () => {
      syncBtn.disabled = true;
      try {
        const result = protocol.value === 'openai'
          ? await currentContext.api('/api/codex/models?refresh=1')
          : await currentContext.api('/api/claude/models');
        const count = Array.isArray(result && result.models) ? result.models.length : 0;
        if (count) currentContext.notice(t('airAdminAuxSyncedCount', { n: count }));
        else if (result && result.diagnostic && result.diagnostic.message) currentContext.notice(result.diagnostic.message);
        await loadAuxView();
      } catch (error) {
        currentContext.notice(t('airAdminAuxSyncFailed', { message: error.message }));
      } finally {
        syncBtn.disabled = false;
      }
    });
    function paintModelHint() {
      modelHint.replaceChildren();
      const list = config.providersByProtocol?.[protocol.value] || [];
      const prov = list.find(p => p.id === provider.value);
      const models = prov && Array.isArray(prov.modelOptions) ? prov.modelOptions : [];
      if (!prov || models.length || noCliAtAll) { modelHint.hidden = true; return; }
      modelHint.hidden = false;
      if (protocol.value === 'openai' && cli && cli.codex === false) {
        modelHint.append(make('div', t('airAdminAuxCliMissingCodex')));
        modelHint.append(make('code', installCmd('codex')));
      } else {
        modelHint.append(make('div', t('airAdminAuxCatalogEmpty')));
      }
      modelHint.append(syncBtn);
    }
    function fillProviders() {
      const list = config.providersByProtocol?.[protocol.value] || [];
      provider.replaceChildren(...list.map(p => {
        const option = make('option', `${p.name}${p.wireApi ? ` · ${p.wireApi}` : ''}`);
        option.value = p.id;
        return option;
      }));
      const saved = config.protocol === protocol.value ? (config.providerId || '') : '';
      provider.value = list.some(p => p.id === saved) ? saved : (list[0]?.id || '');
      fillModels();
    }
    function fillModels() {
      const list = config.providersByProtocol?.[protocol.value] || [];
      const prov = list.find(p => p.id === provider.value);
      const models = prov && Array.isArray(prov.modelOptions) ? prov.modelOptions : [];
      model.replaceChildren(...models.map(m => {
        const option = make('option', m);
        option.value = m;
        return option;
      }));
      const saved = config.providerId === provider.value ? (config.model || '') : '';
      model.value = models.includes(saved) ? saved : (models[0] || '');
      paintModelHint();
    }
    protocol.onchange = fillProviders;
    provider.onchange = fillModels;
    const saveStatus = make('span');
    const save = action(t('airAdminSave'), async () => {
      save.disabled = true;
      saveStatus.textContent = t('airAdminSaving');
      try {
        const result = await currentContext.api('/api/aux/config', {
          protocol: protocol.value, providerId: provider.value, model: model.value,
        });
        if (!result.ok) { saveStatus.textContent = result.error || t('airAdminSaveFailed'); return; }
        currentContext.notice(t('airAdminAssistantModelUpdated', { model: result.model || model.value }));
        await loadAuxView();
      } catch (error) {
        saveStatus.textContent = t('airAdminSaveFailedWithMessage', { message: error.message });
      } finally {
        save.disabled = false;
      }
    }, 'primary');
    const saveRow = make('div', null, 'air-aux-save');
    saveRow.append(save, saveStatus);
    form.replaceChildren(cliBanner, auxField(t('airAdminProtocol'), protocol), auxField('Provider', provider), auxField(t('airAdminModel'), model), modelHint, saveRow);
    fillProviders();
  }

  // 历史是一条 user 提问 + 一条 assistant 结果成对出现;落单的用户消息就是还在跑的任务。
  function auxRecordPairs() {
    const pairs = [];
    const history = auxView.history;
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (msg.role === 'user' && i + 1 < history.length && history[i + 1].role === 'assistant') {
        pairs.push({ input: msg, output: history[i + 1] });
        i++;
      } else if (msg.role === 'user') {
        pairs.push({ input: msg, output: null });
      }
    }
    return pairs.reverse();
  }

  function auxRecordBadge(pair) {
    const status = !pair.output ? 'running'
      : pair.output.error ? 'error'
        : pair.output.cancelled ? 'cancelled' : 'done';
    const badge = make('span');
    const api = registry();
    const label = STATUS_COPY[status] || status;
    if (api) api.applyStatusBadge(badge, 'task', status, { label, translate: () => label });
    else { badge.className = 'mc-status'; badge.textContent = label; }
    return badge;
  }

  function paintAuxRecords() {
    const list = el('air-aux-records');
    if (!list) return;
    const pairs = auxRecordPairs();
    const note = el('air-aux-records-note');
    if (note) note.textContent = pairs.length ? t('airAdminRecordsNote', { n: pairs.length }) : '';
    if (!pairs.length) {
      list.replaceChildren(make('p', t('airAdminNoRecords'), 'admin-empty'));
      return;
    }
    const clock = ms => {
      const d = new Date(ms);
      const p = n => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    list.replaceChildren(...pairs.map(pair => {
      const item = make('div', null, 'air-aux-item');
      const row = make('button', null, 'air-aux-rec');
      row.type = 'button';
      row.append(make('time', clock(pair.input.ts)), make('strong', pair.input.taskType || 'classify'));
      const sessionName = pair.input.meta?.sessionName;
      if (sessionName) row.append(make('span', sessionName, 'air-aux-sess'));
      const preview = (pair.input.content || '').split('\n').pop().slice(0, 80);
      row.append(make('span', preview, 'air-aux-preview'), auxRecordBadge(pair));
      if (pair.output?.durationMs) row.append(make('span', `${(pair.output.durationMs / 1000).toFixed(1)}s`, 'air-aux-dur'));

      const detail = make('div', null, 'air-aux-rec-detail');
      detail.hidden = true;
      const o = pair.output || {};
      const sec = ms => (ms == null) ? '-' : (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
      const timeline = make('div', null, 'air-aux-timeline');
      timeline.append(make('span',
        t('airAdminTimeline', {
          enqueued: o.enqueuedAt || pair.input.ts ? clock(o.enqueuedAt || pair.input.ts) : '-',
          started: o.startedAt ? clock(o.startedAt) : '-',
          finished: o.ts ? clock(o.ts) : '-',
          queued: sec(o.queueMs),
          duration: sec(o.durationMs),
        })));
      const inputTitle = make('h4', t('airAdminInput'));
      const inputBody = make('div', pair.input.content || '', 'air-aux-io');
      detail.append(timeline, inputTitle, inputBody);
      if (pair.output) {
        detail.append(make('h4', t('airAdminOutput')), make('div', pair.output.content || t('airAdminNoOutput'), 'air-aux-io'));
      }
      row.onclick = () => { detail.hidden = !detail.hidden; };
      item.append(row, detail);
      return item;
    }));
  }

  function renderSettings(context) {
    setActions();
    const content = el('admin-content');
    const groups = make('div', null, 'air-settings-groups');
    for (const [title, modes] of settingGroups) {
      const section = make('section', null, `admin-panel air-settings-group${title === 'airAdminGroupFeatured' ? ' air-settings-feature-group' : ''}`);
      section.append(make('h3', t(title)));
      const grid = make('div', null, 'air-settings-grid');
      for (const mode of modes) {
        const [name, description, eyebrow] = legacyPanels[mode];
        const card = action('', () => context.setMode(mode), 'air-setting-card');
        // 卡片是设置中心里唯一说得清「这张卡进哪一格」的东西：文案会随语言变、eyebrow
        // 又会重复，只有 mode 是稳定的。给一个 data-air-card 让测试（和任何想在页面上
        // 认一认的代码）能按格名点到它，不必去猜卡片上的字。
        card.dataset.airCard = mode;
        card.append(make('span', eyebrow, 'eyebrow'), make('strong', name), make('small', description), make('em', t('airAdminEnterSettings')));
        grid.append(card);
      }
      section.append(grid);
      groups.append(section);
    }
    content.replaceChildren(groups);
  }

  // 面板模块没挂上时的兜底（旧页面、缓存了半套静态资源）：说一句「刷新页面重试」，
  // 不再把旧管理台的 iframe 塞回来。旧页已经不再维护，英文模式下它还会露出一屏中文，
  // 而且塞回来的是另一份文档 —— 用户看到的是「一个长得不一样的旧界面」，比一句
  // 「刷新重试」更难判断出了什么事。保险箱 / 隧道那两格本来就是这条规矩，这里对齐。
  function renderModuleMissing() {
    const panel = make('section', null, 'admin-panel');
    panel.append(make('p', t('airAdminRefreshPageRetry'), 'admin-empty error'));
    el('admin-content').replaceChildren(panel);
  }

  // 从 nativePanels 表里取模块渲染（见上面的表）。工具条只有「返回 + 刷新」：
  // 面板自己的按钮（保存 / 删除 / 逐条操作）都画在正文里，跟保险箱那页同一条规矩，
  // 工具条只放「离开这一页」和「重读一次」。
  function renderNative(mode, context) {
    const spec = nativePanels[mode];
    const panel = root[spec.module];
    if (!panel) return renderModuleMissing();
    setActions([
      action(spec.back === 'overview' ? t('airAdminBackToConsole') : t('airAdminBackToSettings'),
        () => context.setMode(spec.back), '', panelIcon('←')),
      action(t('airAdminRefresh'), () => panel.refresh?.(), '', keepsGlyph('↻')),
    ]);
    panel.render(el('admin-content'), context);
  }

  function renderProvider(context) {
    const provider = root.MultiCCAirProvider;
    setActions([
      action(t('airAdminBackToSettings'), () => context.setMode('settings'), '', panelIcon('←')),
      action(t('airAdminAdvancedAccounts'), () => provider?.toggleAdvanced(), '', panelIcon('⇄')),
      action(t('airAdminRefresh'), () => provider?.refresh(), '', keepsGlyph('↻')),
      action(t('airAdminAddProvider'), () => provider?.openEditor(), 'primary', keepsGlyph('＋')),
    ]);
    if (!provider) return renderModuleMissing();
    provider.render(context);
  }

  // ── 敏感信息(secrets)：Air 原生面板 ─────────────────────────────────
  // 保险箱不是「某一组功能里的开关」：条目按同名环境变量注入子进程，所以它跟
  // Provider / Tunnel 一样是原生页，不嵌旧 manage 页。面板本体在 air-secrets.js。
  function renderSecrets(context) {
    setActions([
      action(t('airAdminBackToSettings'), () => context.setMode('settings'), '', panelIcon('←')),
      action(t('airAdminRefresh'), () => root.MultiCCAirSecrets?.refresh(), '', keepsGlyph('↻')),
    ]);
    const panel = root.MultiCCAirSecrets;
    if (panel) return panel.render(el('admin-content'), context);
    // 只有「air-secrets.js 没加载上」会走到这里（旧页面、缓存半套静态资源）。
    renderModuleMissing();
  }

  function renderTunnel(context) {
    setActions([
      action(t('airAdminBackToSettings'), () => context.setMode('settings'), '', panelIcon('←')),
      action(t('airAdminRefreshStatus'), () => root.MultiCCAirTunnel?.refresh(), '', keepsGlyph('↻')),
    ]);
    const tunnel = root.MultiCCAirTunnel;
    if (tunnel) return tunnel.render(el('admin-content'), context);
    const panel = make('section', null, 'admin-panel');
    panel.append(make('h3', t('airAdminTunnelNotLoaded')), make('p', t('airAdminRefreshPageRetry')));
    el('admin-content').replaceChildren(panel);
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
    if (mode === 'tunnel') return renderTunnel(context);
    if (mode === 'aux') return renderAux(context);
    if (mode === 'secrets') return renderSecrets(context);
    if (nativePanels[mode]) return renderNative(mode, context);
    // 认不出的 mode：旧 manage 页已经删了，没有「先嵌回去」这条退路。工具条先回到
    // 设置中心（否则留着上一格的按钮，点下去动的是另一格），正文说一句刷新重试。
    setActions([action(t('airAdminBackToSettings'), () => context.setMode('settings'), '', panelIcon('←'))]);
    renderModuleMissing();
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
        context.notice(t('airAdminServiceRegistered'));
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
    worktreeChangeLabel,
    worktreeChangeBadge,
    applyRing,
    filterTasks,
    searchFilter,
    rankedRows,
  });
})(typeof window !== 'undefined' ? window : null);
