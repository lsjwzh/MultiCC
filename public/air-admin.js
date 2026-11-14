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
    // plugins 不进设置中心分组（settingGroups 没有它），这条只为把 mode 登记进
    // modes 集合：air.js 的 render 分发（admin-center 显隐）、URL 解析（modeFrom）
    // 与地址栏写入（routeUrl）都以那张集合为准，缺了它「插件」页会被当成任务
    // 视图藏掉（2026-10-22 上线后用户实测踩中：侧栏点进去看到的是目录任务页）。
    plugins: [t('airPlugins'), t('airPluginsDesc'), 'PLUGINS'],
    workspaces: [t('airAdminPanelWorkspaces'), t('airAdminPanelWorkspacesDesc'), 'WORKSPACES'],
    // aux 不是 legacy iframe 页(manage 那边配置在弹窗里,没有 view 可嵌)——
    // 这条只为设置中心的卡片和 modes 集合提供元数据,渲染走下面的 renderAux。
    aux: [t('airAdminAux'), t('airAdminPanelAuxDesc'), 'AUX'],
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
  // Configuration has one home; documents and graphs live in sidebar resources.
  const settingGroups = [
    ['airSettingsModels', ['provider', 'aux', 'goal', 'voice']],
    ['airSettingsMobile', ['push', 'tunnel', 'bridges']],
    ['airSettingsComputer', ['global']],
    ['airSettingsData', ['secrets', 'storage']],
    ['airSettingsAdvanced', ['workspaces', 'resources', 'skillsync']],
  ];
  let settingsCategory = 'airSettingsModels';
  let settingsRoute = '';
  // Native page modules. Return navigation belongs to the Air shell history.
  const nativePanels = {
    memory: { module: 'MultiCCAirMemory' },
    taskgraph: { module: 'MultiCCAirTaskgraph' },
    voice: { module: 'MultiCCAirVoice' },
    goal: { module: 'MultiCCAirGoal' },
    global: { module: 'MultiCCAirGlobal' },
    push: { module: 'MultiCCAirPush' },
    bridges: { module: 'MultiCCAirBridges' },
    resources: { module: 'MultiCCAirResources' },
    // plugins：侧栏「资料与插件」区的一员（不在设置中心摆卡），面板在 air-plugins.js。
    plugins: { module: 'MultiCCAirPlugins' },
    skillsync: { module: 'MultiCCAirSkillsync' },
    storage: { module: 'MultiCCAirStorage' },
    workspaces: { module: 'MultiCCAirWorkspaces' },
  };
  let activeMode = null;
  let currentContext = null;
  // 控制台里那份「全部任务」的筛选，存在模块上而不是 DOM 上：面板每次重开都会
  // 重建 DOM，筛选跟着输入框一起丢掉的话，翻回去看同一条列表要重挑一次。
  //
  // fullText 默认开：搜索的默认目标是「全部记录（含对话）」，因为只出现在对话正文里
  // 的词走不到任务板语料。注意它换的不是上面那条状态口径 —— 列表默认仍是「进行中与
  // 待处理」，搜索另有一份 searchFilter()（见下）。
  // view 是顶上展开了哪一格过滤项（running/waiting/error/today/all），null = 都收着。
  const consoleFilter = { query: '', status: 'recent', dir: 'all', fullText: true, sort: 'message' };
  // 目录首页（控制台）自己的全局搜索词与「更多」展开态。和 consoleFilter 一样
  // 存在模块上：外壳每次快照都会整块重画这一页，输入框不能跟着丢字、丢焦点，
  // 底部「更多」也不该每次快照刷新都自己合上。
  let consoleHomeQuery = '';
  // 控制台清单的筛选格（同手机原来那排）：最近 = 未归档，其余口径同 filterTasks。
  const CONSOLE_FILTERS = [['recent', 'airRecentTasks'], ['needs', 'airNeedsMeFilter'], ['todo', 'airTodoFilter'],
    ['today', 'airAdminTileToday'], ['running', 'airAdminTileRunning'], ['error', 'airAdminTileError'], ['all', 'airAdminFilterAll']];
  // 控制台清单一页的条数（服务端 /api/air/page 的单页上限也是 50），以及已经接上
  // 的后续页：第 1 页跟着快照实时走，2..n 页攒在这里。整页每次快照都会重建，所以
  // 攒下的放在模块上；口径一变（signature 不同、serial 加一）就清零。
  const CONSOLE_PAGE_SIZE = 50;
  const consoleList = { signature: '', extra: [], loaded: 1, local: CONSOLE_PAGE_SIZE, loading: false, serial: 0 };
  let consoleListObserver = null;
  // 当前这一份清单的重画函数。分页结果是异步回来的，那时整页可能已经随快照重建过
  // （旧闭包里的列表已经不在文档上）：回调一律找「现在这一份」，不找发请求那一份。
  let repaintConsoleList = null;
  // 手机原来那一页「最近任务」（?view=recent）并进了控制台的清单。旧书签、旧通知链接
  // 落到这里时先改写成控制台 —— 本模块排在 air.js 前面，它读路由时看到的已经是新地址。
  {
    const params = new URLSearchParams(root.location.search);
    if (params.get('view') === 'recent') {
      params.set('view', 'overview');
      root.history.replaceState(root.history.state, '', `${root.location.pathname}?${params}${root.location.hash}`);
    }
  }
  // 控制台两种看法，顶上一道 tab 直接切：tasks = 以任务为主（待办流 + 目录 + 更多，
  // 原样）；dirs = 只铺目录卡，点一张就在当前窗口开那个目录（盖在控制台上的一层，
  // 关掉回到这里 —— 见 air-navigation.js 的 is-console-layer）。选择记在本机：
  // 从目录退回来、刷新、下次打开都还是同一种看法。
  const CONSOLE_VIEW_KEY = 'air:console-view';
  let consoleView = (() => {
    try { return ['dirs', 'machines'].includes(root.localStorage.getItem(CONSOLE_VIEW_KEY)) ? root.localStorage.getItem(CONSOLE_VIEW_KEY) : 'tasks'; } catch (_) { return 'tasks'; }
  })();
  // 输入法组合期（拼音还没选词）里整页重建，等于把搜索框从文档里摘走：浏览器会就此
  // 结束这次组合，一个字也提交不了 —— 中文打不出来，英文却没事（英文的每个字符本来
  // 就已经落在 value 里）。所以组合期间不重建，只记一笔「欠一次」，
  // compositionend 之后再补上。事件挂在两个宿主上，它们本身不会被替换。
  let consoleComposing = false;
  let consoleRenderPending = false;
  let compositionGuardBound = false;
  // 「最近使用」一段的条数上限：目录首页读的是「现在该看什么」，不是一份完整清单。
  const HOME_RECENT_LIMIT = 8;
  const TASK_PAGE_SIZE = 20;
  let attentionPage = 1;
  // 其余四个统计格仍是短清单；「全部任务」单独按每页 20 条翻页。
  const TASK_LIST_LIMIT = 60;

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
  // contributes its actions, and they ride in the header toolbar — one heading
  // band per view. The console used to be an overlay and kept its actions inside
  // the panel (it was covering another page's header); it is a page now, so it
  // follows the same rule as every other page.
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
    if (data?.taskStats) { for (const [id, count] of Object.entries(data.taskStats)) if (id !== 'all' && count.running) dirs.add(id); return dirs; }
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
   * seed（任务/目录 id）从 RING_TINTS 里挑。用 id 而不是随机数，是因为列表每 15 秒
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

  /** 状态徽标：图标 + 中文标签，可访问名称与可见文案是同一句话。
   *
   *  ✅ 那一格整张卡共用，但词可能更细一点：服务端判定 D 时会随判定一起落下
   *  「达成目标 / 需要交互」（`task.goalState`，没有目标就没有这个值），于是同一枚
   *  对勾下写着三个不同的说法。图标、色调、优先级都不动 —— 细分只发生在文案上，
   *  而词表只有一份（status-presentation.js 的 succeededSubLabel）。 */
  function statusBadge(task, opts = {}) {
    const spec = taskSpec(task);
    const api = registry();
    const label = api?.succeededSubLabel?.(spec.status, task?.goalState, t)
      || STATUS_COPY[spec.status] || spec.status;
    const badge = make('span');
    if (api) {
      // translate 恒等于可见文案：Air 没有词典，ariaKey/labelKey 都该落到同一个词上。
      // toneOverride 把 ✅ 的三个子状态拉开颜色：达成目标留绿，需要交互转黄，没判定
      // 出来转灰——调用方（opts）如果自己传了 toneOverride 优先用那个。
      const toneOverride = api.succeededGoalTone?.(spec.status, task?.goalState) || '';
      api.applyStatusBadge(badge, 'task', spec.status, { label, translate: () => label, toneOverride, ...opts });
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
    // 徽标已经说过的词不在这里再说一遍（「执行中 · 执行中」不是更多信息）。徽标在
    // ✅ 上换过词时（达成目标 / 需要交互）这里也得跟着换，否则同一行会同时印
    // 「达成目标」和「执行成功」两个词说同一件事。
    const badgeText = registry()?.succeededSubLabel?.(taskStatus(task), task?.goalState, t)
      || context.label(taskStatus(task));
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
    // 旧的「等待回复」档已并入「等我处理」（needsMe）：遗留的 waiting 值回落到 needs。
    const status = filter.status === 'waiting' ? 'needs' : filter.status || 'open';
    const dir = filter.dir || 'all';
    const needle = String(filter.query || '').trim().toLowerCase();
    // 状态口径与目录概览的统计卡同源：taskStatus 是权威判定（archived/done 生命周期
    // 优先），所以「运行中/待办/异常/今日完成」四张卡与这里的筛选永远不会分叉。
    // 成功那档问的是这一轮的结局（succeeded），不是生命周期 done —— 后者只剩旧看板
    // 时代的少量记录，拿它当「跑成功了吗」会筛出一个几乎空、且越用越旧的清单。
    const rows = (tasks || [])
      .filter(task => status === 'all' ? true
        : status === 'recent' ? task.status !== 'archived'
        : status === 'archived' ? task.status === 'archived'
          : status === 'today' ? doneToday(task)
            : status === 'succeeded' ? taskStatus(task) === 'succeeded'
              : status === 'achieved' ? taskStatus(task) === 'succeeded' && task.goalState === 'achieved'
                : status === 'interact' ? taskStatus(task) === 'succeeded' && task.goalState === 'interact'
                  : status === 'running' ? isRunning(task)
                    : status === 'waiting' ? taskStatus(task) === 'waiting'
                      : status === 'error' ? taskStatus(task) === 'error'
                        // 等我处理：等输入 / 出错 / 需要交互 / 手动标记，判定只在 air-task-todo.js 一处。
                        : status === 'needs' ? !!root.MultiCCAirTaskTodo?.needsMe(task)
                          // 待办：只列用户手动标记的（不含系统判出来的三类）。
                          : status === 'todo' ? !!root.MultiCCAirTaskTodo?.isManualTodo(task)
                          : !['done', 'archived'].includes(task.status))
      .filter(task => dir === 'all' || task.dirId === dir);
    if (keepOrder) return rows;
    // 本地过滤按标题（和目录名）匹配：它仍是即时反馈，也是全文检索不可用时的退路。
    const matched = !needle ? rows
      : rows.filter(task => `${task.title || ''} ${directoryName(task.dirId)}`.toLowerCase().includes(needle));
    // 等我处理 / 待办默认「最早的消息时间在前」：放得最久的那条先处理。
    return status === 'needs' || status === 'todo'
      ? matched.sort((a, b) => todoAt(a) - todoAt(b) || String(a.id || '').localeCompare(String(b.id || '')))
      : matched.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
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
    row.dataset.taskId = task.id;
    const openTask = () => {
      options.onOpen?.();
      context.navigate(context.directoryId, task.id);
    };
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.onclick = event => { if (!event.target.closest('.task-delete, .task-todo, .task-ignore')) openTask(); };
    row.onkeydown = event => {
      if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('.task-delete, .task-todo, .task-ignore')) {
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
    const todoMark = root.MultiCCAirTaskTodo?.mark(task);
    if (todoMark) meta.append(todoMark);
    const worktreeBadge = worktreeChangeBadge(task);
    if (worktreeBadge) meta.append(worktreeBadge);
    const where = options.dir === false ? '' : context.directoryName(task.dirId);
    const note = [where, task.providerName, taskDetail(task, context)].filter(Boolean).join(' · ');
    if (note) meta.append(make('em', note, 'task-note'));
    copy.append(make('strong', task.title || t('airAdminUntitledTask')), meta);
    // 全文检索命中时把命中的那段原文摆出来：标题里没有查询词、却在正文/历史轮次里
    // 命中时，这一行就是「为什么它被搜出来」的唯一解释。
    const snippet = window.MultiCCTaskSearch?.snippetNode?.(options.snippet);
    if (snippet) copy.append(snippet);
    body.append(copy, make('time', task.updatedAt ? new Date(task.updatedAt).toLocaleString(getLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''));
    row.append(body);
    // 行尾只有一颗动词按钮：忽略 / 取消忽略、标记 / 取消待办、标记达成随状态换。
    const todo = root.MultiCCAirTaskTodo?.rowButton(task);
    if (todo) row.append(todo);
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

  // 「等我处理」：跨所有目录、需要我接手的任务，判定只在 air-task-todo.js 一处 ——
  // 等回答 / 出错 / 跑完要交互 / 手动标记，归档与手动忽略的不算。正在跑的不算：
  // 它在跑，不需要我做任何事。排序按最后消息时间从早到晚：先处理放得最久的那条。
  // 这张清单同时喂首页卡片、侧栏「控制台」徽标与统计卡，三处不会各说各话。
  const todoAt = task => Number(task.lastMessageAt || task.updatedAt || 0);
  function todoTasks(data) {
    return (data?.tasks || [])
      .filter(task => root.MultiCCAirTaskTodo?.needsMe(task))
      .sort((a, b) => todoAt(a) - todoAt(b) || String(a.id || '').localeCompare(String(b.id || '')));
  }

  // 「今日完成」：这一轮跑成功（succeeded）或生命周期 done、且最后一次更新落在今天
  // 本地零点之后。任务没有单独的完成时间戳，updatedAt 就是它结束的那一刻。
  function doneToday(task, now = Date.now()) {
    const status = taskStatus(task);
    if (status !== 'succeeded' && task.status !== 'done') return false;
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return Number(task.updatedAt || 0) >= midnight.getTime();
  }

  function statCard(label, value, detail, tone, onClick) {
    const card = make(onClick ? 'button' : 'article', null, `admin-stat ${tone || ''}`);
    if (onClick) { card.type = 'button'; card.onclick = onClick; }
    card.title = detail;
    card.append(make('span', label), make('strong', String(value)));
    return card;
  }

  // 「需要你处理」卡片：列数由 CSS 的 auto-fill 按宽度定，张数按可用高度裁 ——
  // 视口占 40% 左右留给这一格，其余让给「进行中」和任务清单。手机端（≤760px）
  // 仍走 air-mobile.css 的固定两张，这里不插手。
  const PRIORITY_CARD_MAX = 24;
  const PRIORITY_HEIGHT_SHARE = 0.4;
  let priorityObserver = null;
  function fitPriorityCards(grid) {
    const cards = [...grid.querySelectorAll('.console-priority-card')];
    if (!cards.length || !grid.isConnected) return;
    for (const card of cards) card.classList.remove('fit-out');
    if (window.matchMedia('(max-width: 760px)').matches) return;
    const style = getComputedStyle(grid);
    const columns = Math.max(1, style.gridTemplateColumns.split(' ').filter(Boolean).length);
    const gap = parseFloat(style.rowGap) || 0;
    const cardHeight = cards[0].getBoundingClientRect().height || 64;
    const rows = Math.max(1, Math.min(6, Math.floor((window.innerHeight * PRIORITY_HEIGHT_SHARE + gap) / (cardHeight + gap))));
    cards.slice(columns * rows).forEach(card => card.classList.add('fit-out'));
  }
  let priorityGrid = null;
  function watchPriorityFit(grid) {
    priorityObserver?.disconnect();
    priorityObserver = null;
    priorityGrid = grid;
    if (typeof ResizeObserver !== 'function') { requestAnimationFrame(() => fitPriorityCards(grid)); return; }
    // 只在宽度变了才重算：裁卡会改网格自身高度，不能被自己的变化再触发。
    let width = -1;
    priorityObserver = new ResizeObserver(() => {
      if (!grid.isConnected) { priorityObserver?.disconnect(); return; }
      if (Math.round(grid.clientWidth) === width) return;
      width = Math.round(grid.clientWidth);
      fitPriorityCards(grid);
    });
    priorityObserver.observe(grid);
  }
  // 视口高度变了网格宽度不一定变，所以窗口缩放单独挂一条（全局只挂一次）。
  window.addEventListener('resize', () => { if (priorityGrid?.isConnected) fitPriorityCards(priorityGrid); });

  function renderOverview(context) {
    // Keep remote forms and sockets mounted while the entry computer refreshes.
    if (consoleView === 'machines' && el('console-home')?.dataset.view === 'machines') return;
    const { data, setMode, navigate } = context;
    const tasks = data?.tasks || [];
    const counts = data?.taskStats?.all;
    const directories = data?.directories || [];
    const active = tasks.filter(task => task.status !== 'done' && task.status !== 'archived');
    const executing = tasks.filter(isRunning).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    // 「等我处理」一格是 needsMe 全集；「异常」必须独立于忽略开关：从全部非归档任务里
    // 按 taskStatus 取，被手动忽略的出错任务仍留在异常计数与列表里（忽略只管等我处理）。
    const todos = todoTasks(data);
    const failed = tasks.filter(task => taskStatus(task) === 'error')
      .sort((a, b) => todoAt(a) - todoAt(b) || String(a.id || '').localeCompare(String(b.id || '')));
    const finished = tasks.filter(task => doneToday(task)).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    const running = runningDirectories(data);
    // The overview is 控制台's own page; `#admin-content` is the fallback for any
    // host that renders it without that page (it used to be the only host).
    const panel = el('console-content');
    setActions();

    const content = panel || el('admin-content');
    // 快照刷新时整页会重建：先把顶栏搜索框的焦点/光标记住，重建完再放回去。
    const homeSearchFocus = document.activeElement?.id === 'console-home-search';
    const homeSearchCaret = homeSearchFocus ? document.activeElement.selectionStart : null;
    const controlFocus = document.activeElement?.id, controlCaret = document.activeElement?.selectionStart;
    // ── 任务清单：控制台里唯一一份任务列表，不截条数 ───────────────────────
    // 原来的「正在运行 5 条 / 最近使用 8 条」、手机那张 3 条小卡、「更多」里的统计格与
    // 完整列表、以及手机单独那一页「最近任务」都是同一份数据的缩小版，现在合成这一份：
    // 筛选格带数，搜索走顶栏那个输入框，服务端一页 50 条、滚到底自动接下一页。
    // 只有上面「等我处理」那一段仍然限条（它要的是「现在先看哪几条」）。
    const listPanel = make('section', null, 'admin-panel console-task-panel');
    listPanel.id = 'console-task-panel';
    const chips = make('div', null, 'console-task-filters');
    chips.id = 'console-task-filters';
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', t('airAdminFilterByStatus'));
    const chipCounts = {
      needs: counts?.needs ?? todos.length,
      todo: counts?.todo ?? filterTasks(tasks, { status: 'todo' }).length,
      today: counts?.today ?? finished.length,
      running: counts?.running ?? executing.length,
      error: counts?.error ?? failed.length,
      all: counts?.total ?? tasks.length,
    };
    for (const [status, key] of CONSOLE_FILTERS) {
      const chip = action(t(key), () => {
        if (consoleFilter.status === status) return;
        consoleFilter.status = status;
        paintTaskList();
      });
      chip.dataset.filter = status;
      if (status in chipCounts) chip.append(make('b', String(chipCounts[status])));
      chips.append(chip);
    }
    const sortSwitch = make('div', null, 'task-sort-switch console-task-sort');
    sortSwitch.id = 'console-task-sort';
    sortSwitch.setAttribute('role', 'group');
    sortSwitch.setAttribute('aria-label', t('airTaskSortLabel'));
    for (const [sort, key] of [['message', 'airTaskSortMessage'], ['visit', 'airTaskSortVisit']]) {
      const button = action(t(key), () => {
        if (consoleFilter.sort === sort) return;
        consoleFilter.sort = sort;
        paintTaskList();
      });
      button.dataset.sort = sort;
      sortSwitch.append(button);
    }
    const listNote = make('span', '', 'admin-panel-note');
    listNote.id = 'console-task-note';

    const controls = make('div', null, 'admin-task-controls');
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
    controls.append(dirPick, scopePick, sortSwitch, listNote);
    const allList = make('div', null, 'admin-recent-list console-filter-list');
    allList.id = 'console-task-list';
    // 「加载更多」既是滚到底自动接页的哨兵（IntersectionObserver 盯它），也是看不见
    // 滚动事件时（键盘、读屏）的手动入口。
    const loadMoreButton = action(t('airLoadMore'), () => loadMore(), 'console-task-more');
    loadMoreButton.id = 'console-task-more';
    loadMoreButton.hidden = true;
    listPanel.append(chips, controls, allList, loadMoreButton);

    const openRow = (task, extra = {}) => taskRow(task, context, extra);
    // 全文检索控制器。构造时就会跑一次 onChange，所以先声明成 null：那一刻
    // paintTaskList 只能走本地筛选，等控制器拿到结果再覆盖（见下面的赋值）。
    let fullText = null;
    const readVisits = () => { try { return JSON.parse(root.localStorage.getItem('air:task-visited-at') || '{}') || {}; } catch (_) { return {}; } };
    function sortRows(rows) {
      const visits = readVisits();
      const messageAt = task => Number(task.lastMessageAt || task.updatedAt || 0);
      const sortAt = task => consoleFilter.sort === 'visit' ? Number(visits[task.id] || 0) : messageAt(task);
      // 等我处理 / 待办按「最早的消息时间在前」；其余清单仍是最近动过的在前。
      const direction = consoleFilter.status === 'needs' || consoleFilter.status === 'todo' ? -1 : 1;
      return rows.sort((a, b) => direction * (sortAt(b.task) - sortAt(a.task))
        || direction * (messageAt(b.task) - messageAt(a.task))
        || String(a.task.id).localeCompare(String(b.task.id)));
    }
    // 这一次清单的完整口径（也是「攒下来的后续页还算不算数」的签名）。有查询时口径换成
    // searchFilter()：服务端那次和「还没回来/报错」的本地退路必须同一份口径。
    function listQuery() {
      const querying = !!consoleFilter.query.trim();
      const filter = querying ? searchFilter(consoleFilter) : consoleFilter;
      const results = querying ? fullText?.results() : null;
      return { querying, filter, results, options: {
        dirId: consoleFilter.dir === 'all' ? '' : consoleFilter.dir, status: filter.status,
        query: results ? '' : filter.query, ids: root.MultiCCAirSync?.searchIds(results),
        sort: filter.status === 'error' ? 'oldest' : consoleFilter.sort, limit: CONSOLE_PAGE_SIZE, visits: readVisits(),
      } };
    }
    let hasMore = false;
    function paintTaskList() {
      const { querying, filter, results, options } = listQuery();
      const signature = JSON.stringify(options);
      if (consoleList.signature !== signature) {
        Object.assign(consoleList, { signature, extra: [], loaded: 1, local: CONSOLE_PAGE_SIZE, loading: false, serial: consoleList.serial + 1 });
      }
      // 第 1 页走实时同步（状态变了当场就变）；后续页是 loadMore 攒下的，逐条换成
      // 快照里最新的那份，按 id 去重（翻页期间有新任务插进来，页边界会错开一条）。
      // 读不到（离线 / 旧 server 没有分页接口）就退回快照里那份本地数据，清单从不空着。
      // 首次换口径时那一下还在路上：先用本地数据顶着，不让清单闪成空白。回来之后只
      // 重画清单（不惊动整页），所以给它一个自己的回调。
      const remote = root.MultiCCAirLive?.page('console', { ...options, page: 1 }, () => repaintConsoleList?.());
      const first = remote && !remote.errorAt && !(remote.loading && !remote.tasks.length) ? remote : null;
      let shown, total;
      if (first) {
        const fresh = new Map(tasks.map(task => [task.id, task]));
        const seen = new Set();
        shown = [...first.tasks, ...consoleList.extra.map(task => fresh.get(task.id) || task)]
          .filter(task => !seen.has(task.id) && seen.add(task.id)).map(task => ({ task }));
        total = first.total;
        hasMore = !first.loading && consoleList.loaded < first.pages;
        consoleList.remote = true;
      } else {
        consoleList.remote = false;
        // 没有实时同步（旧 server / 测试夹具）：本地筛完再按同样的步长往下放。
        const ranked = querying ? rankedRows(tasks, filter, context.directoryName, results) : null;
        const rows = ranked || filterTasks(tasks, filter, context.directoryName).map(task => ({ task }));
        if (!ranked) sortRows(rows);
        total = rows.length;
        shown = rows.slice(0, consoleList.local);
        hasMore = shown.length < rows.length;
      }
      allList.replaceChildren(...shown.map(({ task, snippet }) => openRow(task, { deletable: true, snippet })));
      if (!shown.length && !first?.loading) allList.append(make('p', t('airAdminNoMatchingTasks'), 'admin-empty'));
      listNote.textContent = t('airAdminNItems', { n: total });
      loadMoreButton.hidden = !hasMore;
      loadMoreButton.disabled = consoleList.loading;
      for (const chip of chips.children) chip.setAttribute('aria-pressed', String(chip.dataset.filter === consoleFilter.status));
      for (const button of sortSwitch.children) button.setAttribute('aria-pressed', String(button.dataset.sort === consoleFilter.sort));
    }
    // 接下一页。后续页不进实时同步的页缓存（它只有 16 格，攒十几页会把首页那几格
    // 挤掉、互相淘汰重拉），直接问 /api/air/page；筛选一换（serial 变了）迟到的结果作废。
    async function loadMore() {
      if (!hasMore || consoleList.loading) return;
      if (!consoleList.remote) { consoleList.local += CONSOLE_PAGE_SIZE; paintTaskList(); return; }
      const { options } = listQuery();
      const serial = consoleList.serial, next = consoleList.loaded + 1;
      const dayStart = new Date().setHours(0, 0, 0, 0);
      const params = new URLSearchParams(Object.entries({ ...options, ids: options.ids?.join(','), page: next, dayStart })
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)]));
      consoleList.loading = true;
      loadMoreButton.disabled = true;
      try {
        const result = await context.api('/api/air/page?' + params);
        if (consoleList.serial !== serial) return;
        consoleList.extra.push(...(result?.tasks || []));
        consoleList.loaded = next;
      } catch (error) {
        if (consoleList.serial === serial) context.notice?.(error.message);
      } finally {
        if (consoleList.serial === serial) consoleList.loading = false;
        repaintConsoleList?.();
      }
    }
    repaintConsoleList = () => { if (allList.isConnected) paintTaskList(); };
    consoleListObserver?.disconnect();
    consoleListObserver = typeof root.IntersectionObserver === 'function'
      ? new root.IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void loadMore(); }, { rootMargin: '240px' })
      : null;
    consoleListObserver?.observe(loadMoreButton);
    // 搜索框同时挂两条路：本地筛选立刻重画，全文结果到了再按相关度覆盖一次。过滤条件
    // 不发给服务端 —— 服务端只负责「哪些任务的正文里出现过这些词」。
    scopePick.onchange = () => {
      consoleFilter.fullText = scopePick.value === 'full';
      fullText?.refresh();
      paintTaskList();
    };
    dirPick.onchange = () => { consoleFilter.dir = dirPick.value; paintTaskList(); };

    // ── 目录首页：顶栏 / 待办流 / 目录网格 / 更多 ───────────────────────
    // 这一页现在是「所有目录的目录首页」：顶栏是全局搜索与新建，上面是跨目录的
    // 待办流（需要你处理 → 正在运行 → 最近使用），下面是全部目录卡片。原来的
    // 统计格与完整任务列表收进底部「更多」——功能一件不少，但不再占首屏。
    const top = make('div', null, 'console-home-top');
    const homeSearch = make('input');
    homeSearch.type = 'search';
    homeSearch.id = 'console-home-search';
    homeSearch.placeholder = t('airAdminSearchPlaceholder');
    homeSearch.setAttribute('aria-label', t('airAdminSearchTasksLabel'));
    homeSearch.value = consoleHomeQuery;
    const homeActions = make('div', null, 'console-home-actions');
    // 两个动作都复用现有入口：#create 打开新建任务弹窗，#add-directory 打开
    // 添加目录对话框（它在 overview 页是 hidden 的，但 click 照旧走同一条链路）。
    const newTask = action(t('airNewTask'), () => el('create').click(), 'primary console-home-create');
    newTask.id = 'console-home-new-task';
    const newDirectory = action(t('airAddDirectory'), () => el('add-directory').click(), 'console-home-add-directory');
    newDirectory.id = 'console-home-new-directory';
    homeActions.append(newTask, newDirectory);
    // 形状照抄目录页那道 Chat / Terminal 切换（.directory-mode）：同一种 tab，同一套样式。
    const viewSwitch = make('div', null, 'directory-mode console-view-switch');
    viewSwitch.id = 'console-view-switch';
    viewSwitch.setAttribute('role', 'tablist');
    viewSwitch.setAttribute('aria-label', t('airConsole'));
    for (const [view, key] of [['tasks', 'docsScopeTask'], ['dirs', 'docsScopeDir'], ...(!root.MultiCCMachineScope ? [['machines', 'airMachines']] : [])]) {
      const tab = make('button', t(key));
      tab.type = 'button';
      tab.id = `console-view-${view}`;
      tab.setAttribute('role', 'tab');
      tab.dataset.consoleView = view;
      tab.onclick = () => {
        if (consoleView === view) return;
        consoleView = view;
        try { root.localStorage.setItem(CONSOLE_VIEW_KEY, view); } catch (_) { /* 无痕模式：只在本页记住 */ }
        applyView();
        // 输入框换成了另一份词：全文结果按新词重取，清单与网格按新词重画。
        fullText?.refresh();
        paintFlow(); paintTaskList(); paintDirectories();
      };
      viewSwitch.append(tab);
    }
    top.append(viewSwitch, homeSearch, homeActions);

    const flow = make('section', null, 'console-flow');
    const attention = make('section', null, 'console-priority');
    const attentionHead = make('div', null, 'admin-panel-head');
    attentionHead.append(make('h2', t('airTodoSectionTitle')), action(t('airRecentAll'), () => setMode('attention')));
    const cards = make('div', null, 'console-priority-grid');
    attention.append(attentionHead, cards);
    flow.append(attention, listPanel);

    // 目录卡网格：二三十个目录直接平铺，不分页。卡片与 air.js 的目录库同一种
    // （.directory-card：按钮 + 备忘入口），排序用与 App 共享的 ui-layout 语义。
    // 它只在「按目录」看法里出现（任务看法不再在清单下面再铺一遍目录）。
    const directoryPanel = make('section', null, 'admin-panel console-directories');
    const directoryHead = make('div', null, 'admin-panel-head');
    const directoryTitle = make('h3', t('airWorkspace'));
    const directoryNote = make('span', '', 'admin-panel-note');
    directoryNote.id = 'console-directory-note';
    directoryHead.append(directoryTitle, directoryNote);
    const directoryGrid = make('div', null, 'directory-grid console-directory-grid');
    directoryGrid.id = 'console-directory-grid';
    directoryPanel.append(directoryHead, directoryGrid);

    // 手机上资料入口（文档 / 记忆 / 任务图）挂在这里（air-mobile.js 的 paintConsole）。
    const mobileSlot = make('div', null, 'console-mobile-slot');
    mobileSlot.id = 'console-mobile-slot';

    const home = make('section', null, 'console-home');
    home.id = 'console-home';
    home.append(top, flow, directoryPanel, mobileSlot);
    content.replaceChildren(home);
    // 目录看法只留顶栏与目录网格（其余几块由 air-navigation.css 按 data-view 让开，
    // 节点不拆：切回任务看法不用重画，手机那张卡也照旧挂着）；搜索框跟着改搜目录。
    function applyView() {
      home.dataset.view = consoleView;
      if (consoleView === 'machines') root.MultiCCAirMachines?.mount(home, context);
      for (const tab of viewSwitch.children) tab.setAttribute('aria-selected', String(tab.dataset.consoleView === consoleView));
      homeSearch.placeholder = t(consoleView === 'dirs' ? 'airSearchNameOrPath' : 'airAdminSearchPlaceholder');
      homeSearch.value = consoleView === 'dirs' ? consoleHomeQuery : consoleFilter.query;
    }
    applyView();

    const layout = root.MultiCCUiLayout;
    const needleNow = () => consoleHomeQuery.trim().toLowerCase();
    const matchesTask = (task, needle) => !needle
      || `${task.title || ''} ${context.directoryName(task.dirId)}`.toLowerCase().includes(needle);
    const matchesDirectory = (directory, needle) => !needle
      || `${directory.name || ''} ${directory.path || ''}`.toLowerCase().includes(needle);
    const empty = key => make('p', t(key), 'admin-empty');

    function directoryCard(directory) {
      const button = make('button');
      button.type = 'button';
      const dirTasks = tasks.filter(task => task.dirId === directory.id);
      const activeCount = context.data.taskStats?.[directory.id]?.running ?? dirTasks.filter(isRunning).length;
      const total = context.data.taskStats?.[directory.id]?.total ?? dirTasks.length;
      // 「等我处理」也挂到卡上：目录看法里没有待办流，哪个目录在等人得从卡上看出来。
      const needs = context.data.taskStats?.[directory.id]?.needs
        ?? todos.filter(task => task.dirId === directory.id).length;
      const needsBadge = needs ? [make('small', `${t('airNeedsMeFilter')} ${needs}`, 'directory-card-needs')] : [];
      button.append(make('strong', '▣ ' + (directory.name || directory.id)),
        make('small', directory.path || ''),
        make('small', activeCount
          ? t('airDirTaskCountActive', { total, active: activeCount })
          : t('airDirTaskCount', { total })),
        ...needsBadge,
        // 与目录库同一份 worktree 口径（air-worktrees.js 的 summary）。
        make('small', root.MultiCCAirWorktrees?.summary?.(directory)
          || t('airDirWorktreeCount', { n: directory.worktreeCount || 0 })));
      button.onclick = () => navigate(directory.id);
      const card = make('article', null, 'directory-card');
      card.dataset.dirId = directory.id;
      applyRing(card, running.has(directory.id), directory.id);
      // 底栏（备忘 + 快速删除）在 air-directory-card.js。删完只请外壳重取快照：
      // 外壳拿到新数据会自己重画这一页（render → admin.render(mode, adminContext())）。
      // 这里不能再拿手上这份 context 画一遍 —— 它攥着删除前的旧快照，画回去就是把
      // 刚删掉的目录卡原地复活，还会把 currentContext 也污染成旧数据。
      const foot = root.MultiCCAirDirectoryCard?.foot?.(directory, () => context.refresh?.());
      card.append(button, ...(foot ? [foot] : []));
      return card;
    }

    function orderedDirectories() {
      const order = layout?.dirOrder?.() || [];
      return layout?.applyOrder
        ? layout.applyOrder(directories, order, directory => directory.id)
        : directories;
    }

    // 「等我处理」那一段：限条（张数还要按可用高度裁），完整清单在 ?view=attention。
    // 顶栏搜索在任务看法里同时收窄这一段与下面的清单。
    function paintFlow() {
      const needle = consoleFilter.query.trim().toLowerCase();
      const live = root.MultiCCAirLive;
      const preview = (key, status, limit, fallback) => {
        const page = live?.page(key, { status, query: needle, limit });
        return page && !page.loading ? page.tasks : fallback.filter(task => matchesTask(task, needle));
      };
      const loud = preview('home-needs', 'needs', PRIORITY_CARD_MAX, todos);
      cards.replaceChildren(...loud.slice(0, PRIORITY_CARD_MAX).map(task => {
        const error = taskStatus(task) === 'error';
        const card = make('article', null, 'console-priority-card ' + (error ? 'error' : 'waiting'));
        // 相对时间让「等了多久」一眼可见；完整时刻留在 title 里。
        const age = root.MultiCCFormat?.formatRelativeTime?.(todoAt(task)) || '';
        const meta = make('small', [context.directoryName(task.dirId), age].filter(Boolean).join(' · '));
        meta.title = todoAt(task) ? new Date(todoAt(task)).toLocaleString(getLocale()) : '';
        const flags = root.MultiCCAirTaskTodo?.mark(task);
        if (flags) meta.append(flags);
        const actions = make('div', null, 'console-priority-actions');
        const todoAction = root.MultiCCAirTaskTodo?.rowButton?.(task, 'console-priority-ignore');
        actions.append(action(t(error ? 'airOpenFailure' : 'airOpenReply'), () => navigate(task.dirId, task.id)), ...(todoAction ? [todoAction] : []));
        card.append(statusBadge(task), make('h3', task.title || t('airAdminUntitledTask')),
          make('p', t(error ? 'airFailureHint' : 'airWaitingHint')), meta, actions);
        return card;
      }));
      if (!loud.length) cards.append(empty(needle ? 'airAdminNoMatchingTasks' : 'airNothingNeedsYou'));
      // 卡片张数仍按可用高度裁（fitPriorityCards）：卡片多了只显示前几行，
      // 不让「等我处理」把目录和「更多」顶出首屏。
      requestAnimationFrame(() => { if (cards.isConnected) fitPriorityCards(cards); });

    }

    // 目录顺序：服务端 ui-layout 的手动顺序在前，没排过的保持快照顺序缀在后面
    // （applyOrder 的语义与 App 的 manual_order.dart 一字不差）。拖完先乐观重画，
    // 失败再重读服务端排布回滚。
    function paintDirectories() {
      const needle = needleNow();
      const shown = orderedDirectories().filter(directory => matchesDirectory(directory, needle));
      directoryGrid.replaceChildren(...shown.map(directoryCard));
      if (!shown.length) directoryGrid.append(empty(needle ? 'airDirNoMatch' : 'airDirNoneYet'));
      directoryNote.textContent = t('airDirDragHint');
      bindDirectoryDrag();
    }

    function bindDirectoryDrag() {
      const sortable = root.MultiCCAirDirectoryNav?.sortable;
      if (!sortable) return;
      // 搜索时只显示一个子集：这时拖动会把没显示的目录挤到列表尾部，所以先禁拖。
      const filtering = !!needleNow();
      for (const card of directoryGrid.querySelectorAll('.directory-card')) {
        card.draggable = !filtering;
        if (filtering) card.removeAttribute('title');
      }
      if (filtering) return;
      sortable(directoryGrid, context, '.directory-card', {
        commit: async ids => {
          if (!layout?.saveDirOrder) return;
          const saved = await layout.saveDirOrder(ids);
          if (saved) { paintDirectories(); return; }
          // 失败回滚：重读服务端的排布，再按它重画，用户看到的是真实存下来的顺序。
          await layout.load();
          paintDirectories();
          // put() 只回布尔，失败原因由同一模块记着；空字符串就是真的没有详情，
          // 别让提示永远停在「保存目录顺序失败：」。
          context.notice?.(t('airDirReorderFailed', { error: layout.lastError?.() || '' }));
        },
      });
    }

    // 顶栏这一个搜索框按看法分工：任务看法搜任务（清单走全文检索，「等我处理」按
    // 标题收窄），目录看法搜目录名与路径。两份词各记各的，切看法时换回对应那份。
    // 只重画清单 / 网格，输入框原地不动 —— 每敲一个字都换掉整页，输入框会在第一个
    // 键之后失去焦点。
    homeSearch.oninput = () => {
      if (consoleView === 'dirs') { consoleHomeQuery = homeSearch.value; paintDirectories(); return; }
      consoleFilter.query = homeSearch.value;
      paintFlow();
      paintTaskList();
    };
    fullText = window.MultiCCTaskSearch?.attach(homeSearch, {
      request: path => context.api(path),
      limit: TASK_LIST_LIMIT,
      fullText: () => consoleView !== 'dirs' && consoleFilter.fullText,
      onChange: () => paintTaskList(),
    });
    paintFlow();
    paintTaskList();
    paintDirectories();
    watchPriorityFit(cards);
    // 目录排布在服务端 ui-layout.json 里；首帧先按默认顺序画出来，拿到排布再覆盖。
    if (layout?.ready) layout.ready().then(() => { if (directoryGrid.isConnected) paintDirectories(); });

    if (homeSearchFocus) {
      try { homeSearch.focus(); homeSearch.setSelectionRange?.(homeSearchCaret, homeSearchCaret); } catch (_) { /* noop */ }
    }
    if (['console-task-scope', 'console-task-dir'].includes(controlFocus)) {
      const control = el(controlFocus); control?.focus();
      if (typeof controlCaret === 'number') control?.setSelectionRange?.(controlCaret, controlCaret);
    }
    root.MultiCCAirMobile?.decorateConsole(context);

  }

  // 「待办」的整页：控制台那一格只放最早在等我的几条，完整清单在这里。它和控制台
  // 那一格用的是同一个 todoTasks(data) —— 口径与「最早在前」的排序都只有一份。
  function renderAttention(context) {
    setActions([
      // 数据在外壳那份 /api/air 快照里，所以这一页没有自己的接口可打，刷新只能
      // 请外壳去取。取完外壳会自己重画当前模式，但走的是「模式没变就跳过」那条
      // 早退路径 —— 这里再强制重画一次，否则按钮按下去什么都不动。
      action(t('airAdminRefresh'), async () => { await context.refresh?.(); render('attention', context, true); }, '', keepsGlyph('↻')),
    ]);
    const remote = root.MultiCCAirLive?.page('attention', { status: 'needs', page: attentionPage });
    const urgent = remote && !remote.loading ? remote.tasks : todoTasks(context.data).slice(0, TASK_PAGE_SIZE);
    const total = context.data.taskStats?.all?.needs ?? urgent.length;
    if (remote && !remote.loading) attentionPage = remote.page;
    const panel = make('section', null, 'admin-panel console-attention-page');
    const head = make('div', null, 'admin-panel-head');
    head.append(make('div'));
    head.firstChild.append(make('span', t('airAllProjects'), 'eyebrow'), make('h3', t('airAdminWhoNeedsMe')));
    head.append(make('span', total ? t('airAdminAttentionPageNote', { n: total }) : t('airAdminNothingPending'), 'admin-panel-note'));
    const list = make('div', null, 'admin-recent-list');
    // 这一页本身就是完整清单，点走一条不用收掉任何浮层 —— 直接把 navigate 交给
    // taskRow 的默认行为，不套控制台那层 onOpen。
    for (const task of urgent) list.append(taskRow(task, context));
    if (!urgent.length) list.append(make('p', t('airAdminNoAttentionTasks'), 'admin-empty'));
    panel.append(head, list);
    if (remote?.pages > 1) {
      const pager = make('div', null, 'admin-task-pager');
      const prev = action(t('airTaskPagePrev'), () => { attentionPage--; renderAttention(context); });
      const next = action(t('airTaskPageNext'), () => { attentionPage++; renderAttention(context); });
      prev.disabled = attentionPage <= 1; next.disabled = attentionPage >= remote.pages;
      pager.append(prev, make('span', t('airTaskPageOf', { page: attentionPage, total: remote.pages })), next); panel.append(pager);
    }
    el('admin-content').replaceChildren(panel);
  }

  // ── 服务与文档：排列方式（按时间 / 按目录）────────────────────────────
  // 两个视图吃的是同一份服务端列表：永久保留 → 置顶 → 最新。切换只重画 DOM，
  // 不重新拉数据 —— 顺序是服务端的事，这里只决定「平铺」还是「按目录分组」。
  // 选择存在本机，写法同 air.js 的 air:task-sort（读取失败一律退回按时间）。
  const DOCS_SCOPE_KEY = 'air:docs-scope';
  let docsScope = 'time';
  try { const saved = localStorage.getItem(DOCS_SCOPE_KEY); if (['dir', 'task'].includes(saved)) docsScope = saved; } catch (_) {}
  // 最近一次拉到的条目：两个视图都从这里画，切换视图时才有东西可画。
  let docsEntries = [], docsQuery = '';

  // 分组视图里，组头本身就是开关：点一下收起/展开这一组，长列表才看得过来。
  // 收起状态按「排列方式 + 分组 key」记（同一个任务按目录看与按任务看是两条
  // 不同的分组轴），存在本机，刷新后还是上次的样子；读写失败一律当展开。
  const DOCS_COLLAPSED_KEY = 'air:docs-collapsed';
  let docsCollapsed = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(DOCS_COLLAPSED_KEY) || '[]');
    if (Array.isArray(saved)) docsCollapsed = new Set(saved.filter(key => typeof key === 'string'));
  } catch (_) {}
  const docsGroupId = key => `${docsScope}:${key}`;
  function saveDocsCollapsed() {
    try { localStorage.setItem(DOCS_COLLAPSED_KEY, JSON.stringify([...docsCollapsed])); } catch (_) {}
  }
  function toggleDocsGroup(key) {
    const id = docsGroupId(key);
    if (docsCollapsed.has(id)) docsCollapsed.delete(id); else docsCollapsed.add(id);
    saveDocsCollapsed();
    paintDocs();
  }
  // 全部收起 / 全部展开：只作用于当前画出来的组（搜索过滤后的那一批），
  // 免得把没显示的组一起改掉。
  function toggleDocsGroups(groups) {
    const allCollapsed = groups.every(group => docsCollapsed.has(docsGroupId(group.key)));
    for (const group of groups) {
      const id = docsGroupId(group.key);
      if (allCollapsed) docsCollapsed.delete(id); else docsCollapsed.add(id);
    }
    saveDocsCollapsed();
    paintDocs();
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

  // 永久保留与置顶是两件互不相关的事：置顶只改排序，永久保留才是「永不被回收」
  // 那句承诺（7 天清理与登记表淘汰都只看它）。所以两颗按钮、两次独立 PATCH，
  // 谁都不顺带改另一个。
  async function togglePermanent(entry) {
    try {
      await currentContext.api(`/api/docs-registry/${encodeURIComponent(entry.id)}`, { permanent: !entry.permanent }, 'PATCH');
      currentContext.notice(t(entry.permanent ? 'docsregPermanentOff' : 'docsregPermanentOn'));
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
    if (entry.permanent) titleRow.append(make('span', `🔒 ${t('artifactKeepForever')}`, 'air-doc-tag permanent'));
    if (!entry.permanent && entry.retained) titleRow.append(make('span', t('artifactKeptRelated'), 'air-doc-tag permanent'));
    if (entry.pinned) titleRow.append(make('span', t('airAdminPinned'), 'air-doc-tag pin'));
    if (entry.expired) titleRow.append(make('span', t('airAdminExpired'), 'air-doc-tag expired'));
    const status = entry.kind === 'service' ? `${entry.status === 'up' ? t('airAdminStatusUp') : entry.status === 'starting' ? t('airAdminStatusStarting') : entry.status === 'down' ? t('airAdminStatusDown') : t('airAdminStatusUnknown')} · ` : '';
    copy.append(titleRow, make('small', `${status}${entry.url || ''}`), make('small', [entry.taskTitle || entry.taskId, entry.source, entry.sessionId, entry.createdAt ? new Date(entry.createdAt).toLocaleString(getLocale()) : ''].filter(Boolean).join(' · ')));
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
    actions.append(
      action(`${entry.permanent ? '🔒 ' : ''}${t(entry.permanent ? 'artifactKeepForeverOff' : 'artifactKeepForever')}`, () => togglePermanent(entry), 'subtle'),
      action(entry.pinned ? t('airAdminUnpin') : t('airAdminPinned'), () => togglePin(entry), 'subtle'),
      action(t('airAdminDelete'), () => removeEntry(entry), 'danger'),
    );
    card.append(icon, copy, actions);
    return card;
  }

  // 组头是一颗按钮（不是装饰性的标题行）：整行可点，aria-expanded 说明这一组
  // 现在是展开还是收起。收起时组内卡片整个不渲染，只留标题行和条数。
  function renderDocGroup(group) {
    const collapsed = docsCollapsed.has(docsGroupId(group.key));
    const section = make('section', null, 'air-doc-group');
    const head = make('button', null, 'air-doc-group-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(!collapsed));
    head.append(make('span', collapsed ? '▸' : '▾', 'air-doc-group-caret'), make('strong', `${group.name} (${group.entries.length})`));
    // 绝对路径是次要信息：目录名重名时（同名项目放在不同父目录下）靠它分辨。
    if (group.path) head.append(make('small', group.path));
    head.onclick = () => toggleDocsGroup(group.key);
    section.append(head);
    if (!collapsed) section.append(...group.entries.map(renderDocEntry));
    return section;
  }

  // 按目录分组：组顺序 = 条目在服务端响应里**第一次出现**的顺序，组内也保持服务端
  // 顺序。所以永久保留那条所在的组天然在最前面（置顶同理），而不是按目录名的字母序
  // ——字母序会把「置顶的那条所在的目录」排到一个跟它毫无关系的位置去。
  // dir 为 null 的条目（旧登记、没有工作目录归属）单独成一组，永远排最后。
  function docsGroups(rows) {
    const groups = new Map();
    for (const entry of rows) {
      const key = (docsScope === 'task' ? entry.taskId : entry.dir) || '';
      let group = groups.get(key);
      if (!group) {
        group = docsScope === 'task'
          ? { key, name: key ? (entry.taskTitle || key) : t('docsNoTask'), path: key, entries: [] }
          : { key, name: key ? (entry.dirName || key) : t('docsNoDir'), path: key, entries: [] };
        groups.set(key, group);
      }
      group.entries.push(entry);
    }
    const ordered = [...groups.values()].filter(group => group.key);
    const unassigned = groups.get('');
    if (unassigned) ordered.push(unassigned);
    return ordered;
  }

  // 只重画列表，不重新拉数据（排列方式不属于服务端那一层的选择）。
  function paintDocs() {
    const list = el('air-doc-list');
    if (!list) return;
    const terms = docsQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const rows = docsEntries.filter(entry => {
      const text = [entry.title, entry.url, entry.note, entry.taskTitle, entry.taskId, entry.dir, entry.dirName, entry.sessionId].filter(Boolean).join(' ').toLocaleLowerCase();
      return terms.every(term => text.includes(term));
    });
    const grouped = docsScope === 'time' ? null : docsGroups(rows);
    list.replaceChildren(...(grouped ? grouped.map(renderDocGroup) : rows.map(renderDocEntry)));
    if (!rows.length) list.append(make('p', t(terms.length ? 'docsNoMatch' : 'airAdminNoDocs'), 'admin-empty'));
    const count = el('air-doc-matches');
    if (count) { count.textContent = t('docsMatches', { shown: rows.length, total: docsEntries.length }); count.hidden = !terms.length; }
    // 分组视图才有「全部收起/展开」：平铺视图没有组可收，按钮直接不占位。
    const collapseAll = el('air-doc-collapse-all');
    if (collapseAll) {
      collapseAll.hidden = !grouped || !grouped.length;
      if (grouped && grouped.length) {
        const expanded = grouped.some(group => !docsCollapsed.has(docsGroupId(group.key)));
        const key = expanded ? 'docsCollapseAll' : 'docsExpandAll';
        collapseAll.textContent = t(key);
        collapseAll.setAttribute('data-i18n', key);
        collapseAll.onclick = () => toggleDocsGroups(grouped);
      }
    }
  }

  function setDocsScope(scope) {
    const next = ['dir', 'task'].includes(scope) ? scope : 'time';
    if (next === docsScope) return;
    docsScope = next;
    try { localStorage.setItem(DOCS_SCOPE_KEY, next); } catch (_) {}
    const switchEl = el('air-docs-scope');
    if (switchEl) {
      for (const button of switchEl.querySelectorAll('button[data-scope]')) {
        button.setAttribute('aria-selected', String(button.dataset.scope === docsScope));
      }
    }
    paintDocs();
  }

  // 形状抄目录首页那道 Chat / Terminal 切换（#directory-mode，air.html）：role=tablist
  // + button role=tab + aria-selected。不共用那个类，免得改一处动两页。
  function docsScopeSwitch() {
    const wrap = make('div', null, 'air-docs-scope');
    wrap.id = 'air-docs-scope';
    wrap.setAttribute('role', 'tablist');
    wrap.setAttribute('data-i18n-aria-label', 'docsScopeLabel');
    wrap.setAttribute('aria-label', t('docsScopeLabel'));
    // 文案与 key 同时写：data-i18n 让 applyI18n() 在切语言时能重取，t() 让这一屏
    // 一画出来就是对的（面板不经过整页重绘）。
    for (const [scope, key] of [['time', 'docsScopeTime'], ['dir', 'docsScopeDir'], ['task', 'docsScopeTask']]) {
      const button = make('button', t(key));
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(docsScope === scope));
      button.setAttribute('data-i18n', key);
      button.dataset.scope = scope;
      button.onclick = () => setDocsScope(scope);
      wrap.append(button);
    }
    return wrap;
  }

  async function loadDocs() {
    const list = el('air-doc-list');
    if (!list) return;
    list.replaceChildren(make('p', t('airAdminLoadingDocs'), 'admin-empty'));
    try {
      const entries = await currentContext.api('/api/docs-registry');
      docsEntries = Array.isArray(entries) ? entries : [];
      const summary = el('air-doc-summary');
      if (summary) {
        const services = docsEntries.filter(entry => entry.kind === 'service');
        summary.textContent = t('airAdminDocsSummary', { total: docsEntries.length, up: services.filter(entry => entry.status === 'up').length, services: services.length });
      }
      paintDocs();
    } catch (error) {
      list.replaceChildren(make('p', t('airAdminLoadFailed', { message: error.message }), 'admin-empty error'));
    }
  }

  function renderDocs(context) {
    setActions([
      action(t('airServiceRoutes'), () => { window.location.href = root.MultiCCMachineScope?.navigation('/service-routes.html') || '/service-routes.html'; }),
      action(t('airAdminRefresh'), () => loadDocs(), '', keepsGlyph('↻')),
      action(t('airAdminRegisterService'), () => el('service-dialog').showModal(), 'primary', keepsGlyph('＋')),
    ]);
    const wrap = make('div', null, 'air-docs');
    const top = make('div', null, 'air-docs-meta');
    top.append(make('span', t('airAdminDocsNote')), make('strong', t('airAdminLoading')));
    top.lastChild.id = 'air-doc-summary';
    const list = make('div', null, 'air-doc-list');
    list.id = 'air-doc-list';
    const filters = make('div', null, 'air-docs-filters');
    const search = make('input'); search.type = 'search'; search.id = 'air-doc-search'; search.value = docsQuery;
    search.placeholder = t('docsSearch'); search.setAttribute('aria-label', t('docsSearch')); search.setAttribute('data-i18n-placeholder', 'docsSearch');
    search.oninput = () => { docsQuery = search.value; paintDocs(); };
    const matches = make('small'); matches.id = 'air-doc-matches'; matches.setAttribute('role', 'status');
    // 分组视图才亮出来（paintDocs 按当前是否有组决定 hidden）。
    const collapseAll = make('button', null, 'air-doc-collapse-all');
    collapseAll.type = 'button'; collapseAll.id = 'air-doc-collapse-all';
    collapseAll.setAttribute('aria-controls', 'air-doc-list');
    collapseAll.hidden = true;
    filters.append(docsScopeSwitch(), search, matches, collapseAll);
    const networkHint = make('p', '', 'admin-panel-note');
    root.multiccMountExternalAccessHint?.(networkHint, root.location.origin);
    wrap.append(top, networkHint, filters, list);
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
      action(t('airAdminRefresh'), () => loadAuxView(true), '', keepsGlyph('↻')),
    ]);
    const statusPanel = make('section', null, 'admin-panel');
    const statusHead = make('div', null, 'admin-panel-head');
    statusHead.append(make('div'));
    statusHead.firstChild.append(make('span', t('airAdminRunStatus'), 'eyebrow'), make('h3', t('airAdminRunStatus')));
    const statusBody = make('div', null, 'air-aux-status');
    statusBody.id = 'air-aux-status';
    statusPanel.append(statusHead, statusBody);

    const formPanel = make('section', null, 'admin-panel');
    const formHead = make('div', null, 'admin-panel-head');
    formHead.append(make('div'));
    formHead.firstChild.append(make('span', t('airAdminModelSettings'), 'eyebrow'), make('h3', t('airAdminModelSettings')));
    formHead.append(make('span', t('airAdminModelNote'), 'admin-panel-note'));
    const form = make('div', null, 'air-aux-form');
    form.id = 'air-aux-form';
    formPanel.append(formHead, form);

    const recPanel = make('section', null, 'admin-panel');
    const recHead = make('div', null, 'admin-panel-head');
    recHead.append(make('div'));
    recHead.firstChild.append(make('span', t('airAdminRunHistory'), 'eyebrow'), make('h3', t('airAdminRunHistory')));
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
    // 单一事实源是服务端的 src/cli/switch-runtime.js(OFFICIAL_INSTALL_SPECS), 这里的
    // 兜底只在 installSpecs 读不到时才走。它必须跟上, 否则前端会教用户跑一条 multicc
    // 自己已经不再使用的命令 —— 这条 codex 分支就从 npm 换成了官方安装脚本。
    const installCmd = (cliId) => {
      const spec = auxView.installSpecs?.specs?.[cliId];
      return (spec && (spec.display || spec.command))
        || (cliId === 'codex' ? 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' : 'npm install -g @anthropic-ai/claude-code');
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
    settingsRoute = location.search;
    const narrow = matchMedia('(max-width: 760px)').matches;
    const categoryPage = new URLSearchParams(location.search).get('category');
    if (settingGroups.some(([key]) => key === history.state?.airSettingsCategory)) settingsCategory = history.state.airSettingsCategory;
    const layout = make('div', null, 'air-settings-layout');
    const categories = make('nav', null, 'air-settings-categories');
    categories.setAttribute('aria-label', t('airSettingsCenter'));
    const groups = make('div', null, 'air-settings-groups');
    const icons = { provider: '✦', aux: '◎', goal: '◇', voice: '♪', push: '◔', tunnel: '⌁', bridges: '⇄', global: '⚙', secrets: '♧', storage: '⇧', workspaces: '▣', resources: '⬢', skillsync: '⇅' };
    for (const [title, modes] of settingGroups) {
      const tab = action(t(title), () => {
        if (narrow) {
          const url = new URL(location.href); url.searchParams.set('category', title);
          root.MultiCCAirNavigation.write(url.pathname + url.search);
        }
        settingsCategory = title;
        history.replaceState({ ...history.state, airSettingsCategory: title }, '');
        root.MultiCCAirMore.park();
        renderSettings(context);
        if (narrow) root.MultiCCAirMobile.renderSettingsHeader();
        else el('admin-content').querySelector(`[data-category="${title}"]`).focus();
      });
      tab.dataset.category = title;
      tab.setAttribute('aria-current', title === settingsCategory ? 'page' : 'false');
      categories.append(tab);
      const section = make('section', null, 'admin-panel air-settings-group');
      section.hidden = narrow ? title !== categoryPage : title !== settingsCategory;
      section.append(make('h3', t(title)));
      const grid = make('div', null, 'air-settings-grid');
      for (const mode of modes) {
        const [name, description] = legacyPanels[mode];
        const card = action('', () => context.setMode(mode), 'air-setting-card');
        card.dataset.airCard = mode;
        const copy = make('span', null, 'air-setting-copy');
        copy.append(make('strong', name), make('small', description));
        card.append(make('span', icons[mode], 'air-setting-icon'), copy, make('span', '›'));
        grid.append(card);
      }
      section.append(grid);
      if (title === 'airSettingsComputer') root.MultiCCAirMore.mount(section);
      groups.append(section);
    }
    categories.hidden = narrow && !!categoryPage;
    layout.append(categories, groups);
    content.replaceChildren(layout);
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
      action(t('airAdminRefresh'), () => panel.refresh?.(), '', keepsGlyph('↻')),
    ]);
    panel.render(el('admin-content'), context);
  }

  function renderProvider(context) {
    const provider = root.MultiCCAirProvider;
    setActions([
      action(t('airAdminAdvancedAccounts'), () => provider?.toggleAdvanced(), '', panelIcon('⋯')),
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
      action(t('airAdminRefresh'), () => root.MultiCCAirSecrets?.refresh(), '', keepsGlyph('↻')),
    ]);
    const panel = root.MultiCCAirSecrets;
    if (panel) return panel.render(el('admin-content'), context);
    // 只有「air-secrets.js 没加载上」会走到这里（旧页面、缓存半套静态资源）。
    renderModuleMissing();
  }

  function renderTunnel(context) {
    setActions([
      action(t('airAdminRefreshStatus'), () => root.MultiCCAirTunnel?.refresh(), '', keepsGlyph('↻')),
    ]);
    const tunnel = root.MultiCCAirTunnel;
    if (tunnel) return tunnel.render(el('admin-content'), context);
    const panel = make('section', null, 'admin-panel');
    panel.append(make('h3', t('airAdminTunnelNotLoaded')), make('p', t('airAdminRefreshPageRetry')));
    el('admin-content').replaceChildren(panel);
  }

  // 宿主节点（#console-content / #admin-content）自己不参与重建，所以事件挂一次就够。
  function bindCompositionGuard() {
    if (compositionGuardBound) return;
    const hosts = ['console-content', 'admin-content'].map(el).filter(Boolean);
    if (!hosts.length) return;
    compositionGuardBound = true;
    for (const host of hosts) {
      host.addEventListener('compositionstart', () => { consoleComposing = true; }, true);
      host.addEventListener('compositionend', () => {
        consoleComposing = false;
        if (!consoleRenderPending) return;
        consoleRenderPending = false;
        // 这次组合的 input 已经落地（取值、本地过滤都在 oninput 里做完），这里补的
        // 只是被推迟的那次整页重建 —— 放到下一个任务，免得卡在组合收尾里。
        root.setTimeout(() => {
          if (!consoleComposing && currentContext) render(activeMode || 'overview', currentContext, true);
        }, 0);
      }, true);
    }
  }

  function render(mode, context, force = false) {
    bindCompositionGuard();
    currentContext = context;
    // 控制台那两页的正文就是搜索框所在的地方：组合期重建会把输入法打断，先欠着。
    if (consoleComposing && mode === 'overview') {
      consoleRenderPending = true;
      activeMode = mode;
      return;
    }
    if (mode === 'overview') {
      root.MultiCCAirMore?.park();
      activeMode = mode;
      renderOverview(context);
      return;
    }
    if (mode === 'attention') { activeMode = mode; return renderAttention(context); }
    if (!force && activeMode === mode && !(mode === 'settings' && settingsRoute !== location.search)) return;
    root.MultiCCAirMore?.park();
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
    setActions();
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
    todoTasks,
    showAllTasks: () => { consoleFilter.status = 'all'; consoleFilter.query = ''; consoleFilter.dir = 'all'; },
    // 手机底部导航的「控制台 / 项目」两项就是控制台的两种看法（页内那道 tab 在手机上
    // 藏着）：由 air-mobile.js 切，和桌面 tab 记在同一个键上。
    consoleView: () => consoleView,
    setConsoleView: view => {
      consoleView = ['dirs', 'machines'].includes(view) ? view : 'tasks';
      try { root.localStorage.setItem(CONSOLE_VIEW_KEY, consoleView); } catch (_) { /* 无痕模式 */ }
    },
    // 清单按某个项目在看时，新建任务默认落到那个项目（弹窗里仍可改）。
    consoleDirectory: () => (consoleFilter.dir === 'all' ? null : consoleFilter.dir),
    refresh: context => render(activeMode || 'overview', context, true),
    bindServiceDialog,
    // 状态与「在不在跑」的唯一判定，侧栏（air.js）和控制台共用这一份，所以一条
    // 任务在两个地方不可能显示成两种状态。
    taskStatus,
    isRunning,
    runningDirectories,
    doneToday,
    statusBadge,
    worktreeChangeLabel,
    worktreeChangeBadge,
    applyRing,
    filterTasks,
    searchFilter,
    rankedRows,
  });
})(typeof window !== 'undefined' ? window : null);
