'use strict';

const crypto = require('node:crypto');
const core = require('../task-board/core');
const { taskDomain, taskDomainAsync } = require('../native/task-domain');
const { isAbnormalLetter, isGoalState } = require('../classify/vocab');
const { createAirPinRuntime } = require('./pins');
const { createAirTodoRuntime } = require('./todos');
const { createAirTodoIgnoreRuntime } = require('./todo-ignores');
const { pendingAttention } = require('../task-board/attention');
const { createAirCardCache } = require('./air-card-cache');

// 旧 App 的完整快照与按需详情继续支持 ETag/304。生产快照正文按摘要版本复用；
// Web 首页走分页索引与游标增量，不再每 15 秒请求完整快照。
function conditionalBody(req, res, payload, timing, encoded) {
  const body = encoded ? encoded.body : JSON.stringify(payload);
  timing?.lap('jsonMs');
  const etag = encoded ? encoded.etag : `W/"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
  timing?.lap('etagMs');
  // 字符数（不是字节数）：只用来判断「这一轮到底搬了多少东西」，不参与任何逻辑。
  timing?.set('bodyChars', body.length);
  res.set('ETag', etag);
  const sent = req?.headers?.['if-none-match'];
  if (sent && String(sent).split(',').some(value => value.trim() === etag || value.trim() === '*')) {
    res.status(304).end();
    timing?.set('status', 304);
    return undefined;
  }
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.send(body);
  timing?.set('status', 200);
  return undefined;
}

// 一轮快照在线上要 ~390ms，而同一份数据、同一批语句在离线进程里只要 40~75ms。
// 差额既不在 SQL 条数也不在数据量上，只能把一轮拆成段落来定位 —— 于是有了下面这套
// 分相位计时。两条硬规矩：
//   1. 计时只做 hrtime 读数，**绝不进 payload**：快照里多一个数字，每一轮正文都会
//      "变"，客户端就拿不到 304，为了诊断反而把代价乘十。
//   2. 默认几乎全静默：只在明显偏慢的轮次（AIR_PHASE_LOG_MS，默认 200ms）打一行，
//      且两行之间至少隔 AIR_PHASE_LOG_GAP_MS（默认 30s）。刚重启的头两分钟例外，
//      每 5s 必打一行 —— 那正是「重启一次就把这几百毫秒拆开」需要的连续样本。
function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
const PHASE_DEFAULTS = Object.freeze({
  logMs: envNumber('AIR_PHASE_LOG_MS', 200),
  gapMs: envNumber('AIR_PHASE_LOG_GAP_MS', 30_000),
  bootWindowS: envNumber('AIR_PHASE_BOOT_WINDOW_S', 120),
  bootGapMs: envNumber('AIR_PHASE_BOOT_GAP_MS', 5_000),
});
const round1 = ms => Math.round(ms * 10) / 10;
// 分段名：报告里要拿它们的和与总时长对账（对不上的那部分不在任何一段里，见
// unaccountedMs —— 那才是「时间其实花在别处」的信号）。
const PHASE_MARKS = ['migrateMs', 'recordsMs', 'boardMs', 'admissionMs', 'admissionIndexMs',
  'cardListMs', 'cardSignatureMs', 'cardLoopMs', 'tailMs', 'jsonMs', 'etagMs'];

function createPhaseTimer() {
  const start = process.hrtime.bigint();
  const sample = {};
  let last = start;
  return {
    lap(name) { const at = process.hrtime.bigint(); sample[name] = round1(Number(at - last) / 1e6); last = at; },
    sum(name, ms) { sample[name] = round1((sample[name] || 0) + ms); },
    set(key, value) { sample[key] = value; },
    sample: () => ({ ...sample, totalMs: round1(Number(process.hrtime.bigint() - start) / 1e6) }),
  };
}

// 同一件事在别的进程里快 5~10×，有两种完全不同的解释：这条路径真的更贵，或者
// 「这个进程当下的 CPU 就是慢」（降频、被别的线程抢核、JIT 退化）。同一行日志里附一个
// 与业务无关的固定工作量耗时，就能把两者分开：calibMs 明显高于离线基线时，倍率跟
// Air 无关。只在已经决定要打日志的那一轮跑，正常轮次一分钱不花。
let calibrationSink = 0;
function calibrationMs() {
  const start = process.hrtime.bigint();
  for (let i = 0; i < 200_000; i++) calibrationSink += Math.sqrt(i % 977);
  return Number(process.hrtime.bigint() - start) / 1e6;
}

// 每挂载一次各自限流（测试里可以并存好几份不同配置的挂载）。
function createPhaseReporter(config, state) {
  const settings = { ...PHASE_DEFAULTS, ...(config || {}) };
  return (timing, logger) => {
    if (!timing) return;
    const sample = timing.sample();
    const uptimeSec = process.uptime();
    const booting = uptimeSec < settings.bootWindowS;
    // 启动窗口只在宿主接了 logger 时生效：测试与工具进程里 mount 一次不该被这几行淹没。
    if (booting && !logger) return;
    if (!booting && sample.totalMs < settings.logMs) return;
    const nowMs = Date.now();
    if (nowMs - state.lastLogAt < (booting ? settings.bootGapMs : settings.gapMs)) return;
    state.lastLogAt = nowMs;
    try {
      const accounted = PHASE_MARKS.reduce((total, name) => total + (Number(sample[name]) || 0), 0);
      const memory = process.memoryUsage();
      (logger || console).warn('air_snapshot_slow', { ...sample,
        unaccountedMs: round1(sample.totalMs - accounted), calibMs: round1(calibrationMs()),
        rssMB: Math.round(memory.rss / 1048576), heapUsedMB: Math.round(memory.heapUsed / 1048576),
        uptimeSec: Math.round(uptimeSec) });
    } catch (_) { /* 诊断永远不许影响接口本身 */ }
  };
}

// 迁移结果里那份 `tasks` 是宿主用来省掉第二遍全表扫描的内部载荷（见
// task-shell/host.js：迁移已经把 task 全表读过一遍并带回来了）。它不是这份快照
// 要回答的东西 —— 客户端只用 `errors`（见 public/air.js 的 airMigrationPending）
// —— 而 445 条完整任务体一旦随快照发出去，每轮正文会从 0.74MB 撑到 5.5MB，
// 每 15 秒让浏览器解析一次。这里按白名单式地剔掉它，其余字段原样透传。
function publicMigration(migration) {
  if (!migration || typeof migration !== 'object') return migration;
  const { tasks: _internalTasks, ...published } = migration;
  return published;
}

// Air reads canonical task records through the task-shell/board authority.
// The client cannot mint a workspace permit, writer proof or attribution fact.
function mountAirRoutes(app, deps) {
  // 三份清单在同一个同步段复用 Rust 已判定的可见集合，不重复序列化任务板。
  let taskSnapshot = null;
  function snapshotLists(tasks) {
    const previous = taskSnapshot;
    taskSnapshot = tasks;
    try { return { taskPins: pins().read(), taskTodos: todos().read(), taskTodoIgnored: todoIgnores().read() }; }
    finally { taskSnapshot = previous; }
  }
  // 处理器可以直接写完响应（条件请求就是如此），也可以照旧返回一个对象。
  const route = fn => async (req, res) => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent && result !== undefined) res.json(result);
      // 这些写操作（创建任务、绑定角色、补投递……）只影响快照元数据或不进入快照，
      // 任务卡变化由各自领域事件（task_board_update/task_state）带过来；这里按元数据
      // 档失效，别把每次创建/点选都升级成 1284 张卡的全量重建。reclaim 例外：它在
      // 自己的处理器里显式要求全量。
      if (req.method && req.method !== 'GET') liveSync?.invalidate([]);
    } catch (error) {
      if (res.headersSent || res.writableEnded) return;
      res.status(error.status || 500).json({ ok: false, code: error.code || 'air_request_failed', message: error.status ? error.message : 'Request failed' });
    }
  };
  // Pin 住的任务（页头顶上那排「齐刘海」/ 手机侧栏的置顶）。落盘位置默认跟
  // sessions.json 同一个数据目录，宿主也可以自己指一个（测试就是这样给的）。
  // 懒建：没碰过 pin 的实例不该为它做任何磁盘动作。
  let pinRuntime = null;
  const pins = () => {
    if (!pinRuntime) {
      pinRuntime = createAirPinRuntime({
        file: deps.pinsFile, listTaskIds: () => boardTasks().map(task => task.id),
        logger: deps.logger || console,
      });
    }
    return pinRuntime;
  };
  // 手动待办（./todos.js）：和 pin 同一种清单、同一个可见集合，同样懒建。
  let todoRuntime = null;
  const todos = () => {
    if (!todoRuntime) {
      todoRuntime = createAirTodoRuntime({
        // 宿主只指了 pins 文件（测试就是这样）时放在它旁边，别落到真实数据目录。
        file: deps.todosFile || (deps.pinsFile ? require('node:path').join(require('node:path').dirname(deps.pinsFile), 'air-todos.json') : undefined),
        listTaskIds: () => boardTasks().map(task => task.id),
        logger: deps.logger || console,
      });
    }
    return todoRuntime;
  };
  // 手动忽略（./todo-ignores.js）：只对「出错 / 等待回复」这两类待办来源有意义。
  // 类别和「这一次问题何时发生」都由下面 projectRunStateOf / todoProblemOf 折出，
  // 与快照里 tasks[].runState 是同一份口径（客户端只读不推）。
  let todoIgnoreRuntime = null;
  const todoIgnores = () => {
    if (!todoIgnoreRuntime) {
      const nodePath = require('node:path');
      const sibling = file => file ? nodePath.join(nodePath.dirname(file), 'air-todo-ignores.json') : undefined;
      todoIgnoreRuntime = createAirTodoIgnoreRuntime({
        file: deps.todoIgnoresFile || sibling(deps.todosFile) || sibling(deps.pinsFile),
        listTasks: () => boardTasks(),
        problemOf: task => todoProblemOf(task, Date.now()),
        readTodos: () => todos().read(),
        logger: deps.logger || console,
      });
    }
    return todoIgnoreRuntime;
  };
  // 与 /api/air 快照 tasks[].runState 完全相同的折叠：排队事件写下的乐观值先按
  // 会话受理物证自愈，再把陈旧的 worker 声明投影回会话真实状态。这一份口径同时
  // 给快照和「手动忽略」用，杜绝两处各自猜一个状态。
  function projectRunStateOf(task, now) {
    return taskDomain({ op: 'runState', task, facts: runFacts(task), now });
  }

  // 待办来源类别 + 「这一次问题什么时候开始」。出错/等待的落判都会写
  // taskState.endedAt（state-machine 的 dispatchStateAction），等待还有
  // pendingUserInput.createdAt 兜底。这些字段只随状态变更动；改名、移动、已读、
  // 生命周期调整只会推大 task.updatedAt，不能拿来判「新的一次」。
  function todoProblemOf(task, now) {
    const runState = projectRunStateOf(task, now);
    const kind = runState === 'error' ? 'error' : runState === 'waiting' ? 'waiting' : null;
    if (!kind) return { kind: null, occurredAt: 0 };
    const sessionId = task.chatSessionId || task.sessionId || null;
    const taskState = (sessionId && deps.records.get(sessionId)?.taskState) || {};
    const pending = taskState.pendingUserInput || null;
    const occurredAt = Number(taskState.endedAt)
      || Number(pending && pending.createdAt)
      || Number(taskState.lastTurnEndedAt)
      || 0;
    return { kind, occurredAt: occurredAt > 0 ? occurredAt : 0 };
  }

  /** 独立任务列表与 pin 共用同一可见集合；会话内尚未隔离的任务只保留消息归属。 */
  function boardTasks() {
    if (taskSnapshot) return taskSnapshot;
    const board = deps.getBoard?.() || {};
    // The board index predates separation metadata. Read the canonical shell
    // records so existing cards are hidden too, including after migration.
    // A confirmed split can still be waiting for execution creation: it is not
    // independent until ready. Ordinary planned tasks need no such check.
    return taskDomain({ op: 'airVisible', board, shellTasks: deps.shell.listTasks?.() || [] }).map(id => board.tasks[id]);
  }
  // 一次请求只读一次 admission 快照：这是整表读（workspace:record + lease），
  // 按卡片各读一次时 1069 张卡片要多花约 0.4s 的 CPU 与等量 JSON 解析。
  // workspace 记录按目录折成「worktree 生命周期」计数：光有总数看不出增长方式，
  // 而用户要判断的正是「在本地占着地的是哪些、休眠了哪些、还有多少没落地」。
  // 口径直接来自 registry 的 residency（resident/retained 都在磁盘上、hibernated
  // 只剩分支引用、planned 还没落地），再叠一层「此刻是否被占用」。

  // 卡片查自己的 workspace/lease 原本是两次 find()：1069 张卡片 × 1228 条记录，
  // 平方级的扫描。一次请求里 admission 快照是同一份对象，折成两张 Map 就够，
  // 命中规则与 find() 一致（同一个 key 取最先出现的那条）。
  function admissionIndex(snapshot) {
    const workspaceByOwner = new Map(), leaseByWorkspace = new Map();
    for (const workspace of snapshot.workspaces || []) {
      if (workspace.ownerId && !workspaceByOwner.has(workspace.ownerId)) workspaceByOwner.set(workspace.ownerId, workspace);
    }
    for (const lease of snapshot.leases || []) {
      if (lease.workspaceId && !leaseByWorkspace.has(lease.workspaceId)) leaseByWorkspace.set(lease.workspaceId, lease);
    }
    return { workspaceByOwner, leaseByWorkspace };
  }
  function resource(sessionId, snapshot = deps.admission.snapshot(), index = admissionIndex(snapshot),
    capacity = workspace => deps.admission.capacityReason(workspace.id)) {
    const record = deps.records.get(sessionId);
    const workspace = index.workspaceByOwner.get(record?.workspaceOwnerSessionId || sessionId);
    const lease = workspace ? index.leaseByWorkspace.get(workspace.id) : null;
    return { id: workspace?.id || null, residency: workspace?.residency || (record?.workspaceState === 'planned' ? 'planned' : record ? 'retained' : 'planned'),
      lease: lease?.state || 'idle', capacityReason: workspace && !lease ? capacity(workspace) : null, reason: lease?.reason || null, pins: workspace?.pins || [],
      path: workspace?.path || record?.worktreePath || null, branch: workspace?.branch || record?.branch || null };
  }
  // 容量判定（registry.available）每问一次都要把 workspace 记录整表过滤一遍，逐卡
  // 问就是平方级：线上 580 张有 worktree 的卡 × 886 条记录，一轮 50~115ms。在同一份
  // admission 快照里（同一个同步段内）它的答案只取决于「是不是 resident」和所在
  // 目录 —— 执行/恢复并发是全局数，resident 预算按目录算，busy 已被「没有活跃租约」
  // 排除。所以一轮里按这两个键各问一次就够，答案与逐卡问逐字节相同。
  function capacityMemo() {
    const memo = new Map();
    return workspace => {
      const key = workspace.residency === 'resident' ? 'resident' : `other\u0000${workspace.dirId}`;
      if (!memo.has(key)) memo.set(key, deps.admission.capacityReason(workspace.id));
      return memo.get(key);
    };
  }
  // 一张卡片的底稿：内容只由输入决定（任务板这张卡、任务库里的权属、会话记录、
  // 这张卡自己的 workspace/lease）。runState / worktreeChanges / capacityReason 留空位
  // 占住字段顺序，由 cardOverlay 每轮现填 —— 两条路径吐出的 JSON 逐字节相同，缓存
  // 命中与否客户端看不出来。
  // 宿主只读取权威接口，Rust 组装卡片并决定状态覆盖。
  function cardFacts(t, taskDirs, records, admissionIdx, timedAdd, accessOf) {
    const sessionId = t.chatSessionId || t.sessionId || null;
    const record = records[sessionId];
    const workspace = admissionIdx.workspaceByOwner.get(record?.workspaceOwnerSessionId || sessionId) || null;
    const lease = workspace ? admissionIdx.leaseByWorkspace.get(workspace.id) || null : null;
    return { task: t, record: record || null, workspace, lease,
      dirId: taskDirs[t.id],
      access: accessOf(t),
      providerName: record?.provider ? record.providerName : null };
  }
  function runFacts(task) {
    const facts = {};
    for (const id of new Set([...core.taskRunSessionIds(task), task.routing?.workerSessionId, task.chatSessionId].filter(Boolean))) {
      let runState = null;
      try { runState = deps.getSessionRunState?.(id) || null; } catch (_) {}
      facts[id] = { taskState: deps.records.get(id)?.taskState || null, runState };
    }
    return facts;
  }

  // 签名用输入内容而不是版本号：任务板卡片与会话记录都有原地改写，版本号漏记一次
  // 就是一张永远不刷新的卡。
  //   全局签名：任务板的模块/分组。
  //   逐卡签名：这张卡在任务板上的全文 + 它引用到的会话记录投影 + 它自己的
  //            workspace/lease + 它的权限判断结果（任务库对卡片的唯一输入，整页
  //            一次批量算出）。会话投影每轮每条只算一次。任务库任何一行变了，只有
  //            结果真变了的那几张卡重建。
  // 只采集权威会话字段，签名算法与目录统计在 Rust 异步执行。
  function cardRecordFacts() {
    const providerNames = new Map();
    return Object.fromEntries([...deps.records].map(([id, record]) => {
      const r = Object.fromEntries(['id', 'dirId', 'kind', 'type', 'cli', 'provider', 'worktreePath', 'branch',
        'workspaceOwnerSessionId', 'workspaceState', 'taskBoundTaskId', 'taskExecutionSlot', 'experimentalMode']
        .filter(key => record[key] !== undefined).map(key => [key, record[key]]));
      const key = `${record.cli}\u0000${record.provider}`;
      if (record.provider && !providerNames.has(key)) providerNames.set(key, deps.providerName?.(record) || null);
      r.providerName = providerNames.get(key) || null;
      r.taskState = { goalState: record.taskState?.goalState };
      return [id, r];
    }));
  }
  const cardCache = deps.cardCache || createAirCardCache({
    mode: process.env.AIR_CARD_CACHE || (deps.registerSync ? 'on' : 'shadow'),
    verifyMs: envNumber('AIR_CARD_CACHE_VERIFY_MS', 60_000),
    logger: deps.logger || null,
  });
  async function airSnapshot(timing, options = {}) {
    // 计时永远只是读数：timing 缺省（测试直接调这个函数）时，下面两个局部函数退化成原调用。
    const lap = name => timing?.lap(name);
    const timedAdd = (name, fn) => {
      if (!timing) return fn();
      const at = process.hrtime.bigint();
      const out = fn();
      timing.sum(name, Number(process.hrtime.bigint() - at) / 1e6);
      return out;
    };
    const migration = publicMigration(await deps.shell.migrateTaskSessions?.());
    lap('migrateMs');
    // 新任务输入框要「随时更新成最近用过的那套配置」，而不是每次都退回
    // 「默认线路 · 默认模型」。这里从会话记录里取 lastWorkAt 最新的 chat 会话
    // 的运行时，随快照一起下发。只读、不另落盘：「最近使用」本身就是会话
    // 记录已经知道的事，再存一份只会多出一个会悄悄过期的副本。terminal 镜像
    // 会话不在其列 —— 它们的 cli 说着的是进程归属，不是用户挑过的路由。
    // 定时任务会话每轮自动跑、lastWorkAt 总是最新，不代表用户的选择；上一轮异常收尾的线路也不算。
    const cronSessionIds = new Set(deps.cronSessionIds?.() || []);
    let lastUsed = null;
    for (const record of deps.records.values()) {
      if (record.kind !== 'chat' || !record.cli) continue;
      if (cronSessionIds.has(record.id)) continue;
      if (isAbnormalLetter(record.taskState?.classifyState)) continue;
      const at = record.lastWorkAt || record.createdAt || '';
      if (!lastUsed || String(at) > String(lastUsed.at)) lastUsed = { at, record };
    }
    const lastRuntime = lastUsed && {
      cli: lastUsed.record.cli,
      provider: lastUsed.record.provider || null,
      providerName: deps.providerName?.(lastUsed.record) || lastUsed.record.provider || null,
      providerSelection: lastUsed.record.providerSelection || null,
      model: lastUsed.record.model || null,
      effort: lastUsed.record.effort || null,
      subagent: deps.serializeSubagent?.(lastUsed.record.subagent) || null,
    };
    lap('recordsMs');
    const board = deps.getBoard();
    // One directory can retain several task/session worktrees. Count unique
    // paths from both authorities: session records cover ordinary chats;
    // task metadata covers detached/task-bound worktrees whose session record
    // may already be gone. This is inventory only — no cleanup is attempted.
    lap('boardMs');
    // 与任务板同一条自愈规则（见 task-board/view.js 的 deadDispatchClaim /
    // sessionHasTurn）：派发时写下的乐观 runState，如果名下会话拿不出受理物证，
    // 就证明这一轮从没被受理过 —— 不把这类卡片继续报成「执行中」（否则它会挂在
    // 控制台上直到天荒地老）。折叠本身在 projectRunStateOf，与「手动忽略」共用。
    const projectNow = Date.now();
    const admission = deps.admission.snapshot();
    lap('admissionMs');
    const admissionIdx = admissionIndex(admission);
    const recordFacts = cardRecordFacts();
    const prepare = cardCache.prepareAsync || taskDomainAsync;
    const prepared = await prepare({ op: 'airInputs', board, records: recordFacts, admission,
      // 可见性只看这四个字段；整行任务不随每次刷新序列化。
      shellTasks: (deps.shell.listTasks?.() || []).map(t => ({ id: t.id, embedded: t.embedded,
        separatedFromTaskId: t.separatedFromTaskId, ready: t.ready })),
      cacheable: cardCache.mode !== 'off' });
    const hibernationPolicy = (() => {
      try { return deps.hibernation?.()?.policy?.() || null; } catch (_) { return null; }
    })();
    lap('admissionIndexMs');
    const selected = options.ids && new Set(options.ids);
    const cards = prepared.tasks.filter(task => !selected || selected.has(task.id));
    timing?.set('cardCount', cards.length);
    lap('cardListMs');
    // 底稿（内容只由输入决定的部分）逐卡走 air-card-cache.js；runState /
    // worktreeChanges / capacityReason 随时间与全局运行时变，每轮现算叠上去
    // （见 cardOverlay）。
    const globalSignature = prepared.globalSignature;
    const accessById = timedAdd('accessMs', () => deps.shell.taskAccessBatch
      ? deps.shell.taskAccessBatch(cards) : new Map(cards.map(t => [t.id, deps.shell.taskAccess(t)])));
    const accessOf = t => accessById.get(t.id);
    const signatureOf = task => {
      const signature = prepared.signatures[task.id];
      return signature == null ? signature : `${signature}:${JSON.stringify(accessOf(task) ?? null)}`;
    };
    lap('cardSignatureMs');
    const resolve = cardCache.resolveAsync || cardCache.resolve;
    const nativeBaseOf = t => cardFacts(t, prepared.taskDirs, recordFacts, admissionIdx, timedAdd, accessOf);
    const resolved = await resolve(globalSignature, cards, {
      keyOf: t => t.id, signatureOf: t => (signatureOf ? signatureOf(t) : null),
      prune: !selected, nativeBaseOf,
      build: t => ({ t, ...taskDomain({ op: 'cardBase', ...nativeBaseOf(t) }) }) });
    const { entries, hits, builds } = resolved;
    timing?.set('cardHits', hits);
    timing?.set('cardBuilds', builds);
    const capacity = capacityMemo();
    const facts = {}, merges = {}, capacityReasons = {};
    for (let i = 0; i < entries.length; i++) {
      const { t, card, capacityOf } = entries[i];
      for (const id of new Set([...(t.refs || []).map(ref => ref.sessionId), t.routing?.workerSessionId, t.chatSessionId].filter(Boolean))) {
        if (Object.hasOwn(facts, id)) continue;
        let runState = null;
        try { runState = deps.getSessionRunState?.(id) || null; } catch (_) {}
        const state = deps.records.get(id)?.taskState;
        facts[id] = { taskState: state ? Object.fromEntries(['queueState', 'classifyState', 'classifyHistory',
          'classifyUpdatedAt', 'lastTurnEndedAt', 'startedAt', 'endedAt'].map(key => [key, state[key]])) : null, runState };
      }
      const record = deps.records.get(card.sessionId);
      merges[card.id] = record && ['resident', 'retained'].includes(card.resource.residency)
        && typeof deps.mergeStateCached === 'function'
        ? timedAdd('mergeStateMs', () => deps.mergeStateCached(deps.directories.get(record.dirId), record)) : null;
      capacityReasons[card.id] = capacityOf ? timedAdd('capacityMs', () => capacity(capacityOf)) : null;
      if (options.cooperative && i % 24 === 23) await new Promise(done => setImmediate(done));
    }
    const overlayFacts = { now: projectNow, facts, merges, capacityReasons };
    const tasks = cardCache.overlayAsync ? await cardCache.overlayAsync(resolved, overlayFacts)
      : await taskDomainAsync({ op: 'cardOverlayBatch', entries, ...overlayFacts });
    // 无人值守模式（docs/unattended-mode.md）：任务行只带状态条需要的字段，
    // 完整状态仍走 GET /api/sessions/:id/unattended。这里必须复制而不是
    // 原地改：`held.cards` 是卡片缓存的原对象，写回去会让状态粘在缓存里。
    const compactUnattended = task => {
      const sessionId = task.chatSessionId || task.sessionId;
      const state = sessionId ? deps.records.get(sessionId)?.unattended : null;
      if (!state || typeof state !== 'object') return task;
      const deadlineAt = Number(state.deadlineAt);
      return { ...task, unattended: {
        status: state.status ?? null,
        rounds: Math.max(0, Math.floor(Number(state.rounds) || 0)),
        deadlineAt: Number.isFinite(deadlineAt) && deadlineAt > 0 ? deadlineAt : null,
        evaluating: state.evaluating === true,
      } };
    };
    const tasksWithUnattended = tasks.map(compactUnattended);
    // 最近消息、updatedAt、原顺序的稳定排序由 Rust 完成。
    lap('cardLoopMs');
    const payload = { ok: true, directories: [...deps.directories.values()].map(d => ({
      id: d.id, name: d.name, path: d.path,
      worktreeCount: prepared.worktreeCounts[d.id] || 0,
      // 生命周期拆解（见 lifecycleByDirectory）：本地/休眠/计划各几个、此刻几个在用。
      worktreeLifecycle: prepared.lifecycle[d.id] || { resident: 0, retained: 0, hibernated: 0, planned: 0, leased: 0, onDisk: 0, total: 0 },
    })),
      tasks: tasksWithUnattended, ...snapshotLists(prepared.tasks), budgets: admission.budgets, clis: deps.clis, migration, lastRuntime,
      // 自动回收的策略（闲置阈值/间隔）由运行时给出，面板据此把「多久没用会被收走」
      // 说准，而不是在客户端再猜一个默认值。
      worktreePolicy: hibernationPolicy,
      // 终端行要回答的「这一条现在还能用吗」，和 tasks 那条 runState 一样是服务端
      // 折出来的事实，客户端只读不推断。三个取值：
      //   route_dead — 绑了托管 provider 却没有能力令牌：那个进程里烤死的 base URL
      //                带着明文 id，每个请求都 409 proxy_route_capability_mismatch
      //                （判据与 src/providers/terminal-route.js 的 lookup() 同一条）。
      //                修法是重启，所以它排在最前 —— 进程在不在都改变不了这个结论。
      //   running    — 内存里还有运行时会话（tmux 活着；进程退出后 3s 内被 sweep 掉）。
      //   stopped    — 没有运行时会话：进程已退出，或服务重启后没被恢复。
      // 不用 classifyState：终端不在 chatSessions 里，chat liveness 对它一律返回
      // unknown/no_chat_runtime，持久化下来的字母会永远停在 P
      // （docs/classify-state-machine-audit.md §4.3）—— 拿它当状态点就是撒谎。
      // 也不逐行 tmuxHasSession()：这是 4s 一轮的接口，一行 spawn 一个 tmux 子进程
      // 换不来比内存那张表更新的信息（那张表本身就是靠 has-session 维护的）。
      sessions: [...deps.records.values()].filter(s => s.kind === 'terminal' && !['aux', 'gateway'].includes(s.type))
        .map(s => {
          const runtime = deps.sessions?.get(s.id);
          return { id: s.id, dirId: s.dirId, label: s.label || s.id, kind: s.kind, cli: s.cli,
            state: (runtime && runtime.spawnedProvider !== undefined ? runtime.spawnedProvider : s.provider) && !s.proxyRouteToken ? 'route_dead' : runtime ? 'running' : 'stopped',
            // 「多久没动」= 最后一次有输出的时刻。停了的终端没有运行时，也就没有这个
            // 时刻：给 null，客户端才不至于把一条死进程报成「刚刚」。
            lastActivityAt: runtime ? runtime.lastActivity.getTime() : null,
            createdAt: Date.parse(s.createdAt) || null };
        }) };
    lap('tailMs');
    return payload;
  }
  // 分相位计时记录后台生产者的成本，数字不进入摘要正文。
  const reportPhases = createPhaseReporter(deps.phaseDiagnostics, { lastLogAt: 0 });
  const liveSync = deps.registerSync ? require('./air-sync-runtime').createAirSyncRuntime({
    build: async ids => {
      const timing = createPhaseTimer();
      const snapshot = await airSnapshot(timing, { ids, cooperative: true });
      reportPhases(timing, deps.logger); return snapshot;
    }, index: deps.airReadIndex, subscribe: deps.subscribe, logger: deps.logger, send: deps.send,
    // 会话记录在广播 session_created 之前就写好了 taskBoundTaskId（create-record），
    // 先走它：新任务的首轮事件不会再因为板册尚未回填 linkage 而解析成空集合。
    taskIdsForSession: id => {
      const bound = deps.records.get(id)?.taskBoundTaskId;
      if (bound) return [bound];
      return Object.values(deps.getBoard().tasks || {}).filter(task =>
        task.sessionId === id || task.chatSessionId === id || core.taskRunSessionIds(task).includes(id)).map(task => task.id);
    },
  }) : null;
  if (liveSync) { liveSync.mount(app, route); deps.registerSync(liveSync); }
  let airBuildsInFlight = 0;
  app.get('/api/air', route(async (req, res) => {
    const timing = createPhaseTimer();
    airBuildsInFlight += 1;
    try {
      if (liveSync) await liveSync.ensureReady();
      return conditionalBody(req, res, liveSync ? null : await airSnapshot(timing), timing, liveSync ? await liveSync.serialized() : undefined);
    } finally {
      airBuildsInFlight -= 1;
      timing.set('inFlight', airBuildsInFlight);
      reportPhases(timing, deps.logger);
    }
  }));

  // 主动回收：把空闲的 worktree 收起来（本地 checkout 删掉，分支与提交全部保留，
  // 下次打开这条任务时按需重建）。无人值守那条路是 session hibernation 的定时
  // sweep（默认闲置 24 小时），这里是「用户现在就想腾地方」的即时版本：
  // dirId 限定目录，force 表示连「最近用过」的也一起收。
  app.post('/api/air/worktrees/reclaim', route(async req => {
    const hibernation = deps.hibernation?.();
    if (!hibernation || typeof hibernation.reclaim !== 'function') {
      return { ok: false, code: 'hibernation_unavailable', considered: 0, hibernated: 0 };
    }
    const body = req.body || {};
    const dirId = body.dirId ? String(body.dirId) : null;
    if (dirId && !deps.directories.get(dirId)) {
      throw Object.assign(new Error('directory not found'), { status: 404, code: 'directory_not_found' });
    }
    const result = await hibernation.reclaim({ dirId, force: body.force === true });
    // 回收直接改写任务卡上的 worktree 状态且没有领域事件可跟，保持显式全量。
    liveSync?.invalidate();
    return { ok: result.ok !== false, dirId, ...result };
  }));
  app.get('/api/air/resolve', route(async req => {
    await deps.shell.migrateTaskSessions();
    let taskId = req.query.task;
    if (!taskId && req.query.session) taskId = deps.shell.stateTarget(req.query.session).taskId || deps.shell.artifactTaskId(req.query.session);
    if (!taskId && req.query.shell) taskId = deps.shell.chatScope(req.query.shell).taskId;
    if (!taskId) return { ok: true, url: '/air' };
    const entry = await deps.shell.taskEntry(taskId);
    const dirId = deps.records.get(entry.sessionId)?.dirId;
    return { ok: true, taskId, url: '/air?' + new URLSearchParams({ task: taskId, ...(dirId ? { dir: dirId } : {}) }) };
  }));
  app.post('/api/air/tasks', route(async req => { const result = await deps.shell.createTask(req.body); deps.admission.identify(result.sessionId); return result; }));
  // In Auto mode the session's own model is only the first candidate's; the
  // pill must name the line that actually answered (see chat/auto-route-notes).
  const autoLine = record => (record?.providerSelection?.mode === 'auto' ? record.autoProviderLastRoute || null : null);
  async function taskDetail(taskId) {
    const entry = await deps.shell.taskEntry(taskId);
    const record = deps.records.get(entry.sessionId);
    const candidate = deps.shell.attributionCandidate(taskId);
    const separation = deps.shell.taskSeparation?.(taskId) || null;
    const attribution = await require('../task-routing/delivery-view').deliveryView({ sessionId: entry.sessionId,
      taskId, candidate, separation, admission: deps.admission, cwd: deps.directories.get(record?.dirId)?.path });
    let roleBindings = null;
    try { roleBindings = deps.shell.roleBindings(taskId); } catch (_) {}
    // 下一轮才生效的那份配置里存的是 provider id，药丸要给人看名字。名字只有在
    // 这里解析得出来（provider store 在服务端），所以随 pending 一起下发一个只读
    // 的展示名；profile 本身保持原样，应用配置时不会被这个派生字段写回会话。
    const pending = record?.pendingConfiguration || null;
    const pendingProviderName = pending
      ? deps.providerName?.({ cli: pending.cli || record?.cli, provider: pending.profile?.provider || null }) || null
      : null;
    return { ...entry, resource: resource(entry.sessionId), configuration: {
      pendingConfiguration: pending ? { ...pending, providerName: pendingProviderName } : null,
      cli: record?.cli,
      model: record?.model,
      effectiveModel: autoLine(record)?.model || deps.effectiveModel?.(record) || record?.model || null,
      effort: record?.effort,
      effectiveEffort: deps.effectiveEffort?.(record) || record?.effort || null,
      provider: record?.provider || null,
      providerName: deps.providerName?.(record) || record?.provider || null,
      providerSelection: record?.providerSelection || null,
      // 子任务线路（provider + model）。和 chat 的 AI 配置同一个字段：任务 AI 配置
      // 面板要能显示「这个任务现在把子任务派给谁」，并允许改。
      subagent: deps.serializeSubagent?.(record?.subagent) || null,
      rolePresetId: record?.rolePresetId,
    }, roleBindings,
      // Auto attribution needs real integration and writer-barrier receipts.
      // Do not expose a switch that would turn client assertions into proofs.
      attribution };
  }
  app.get('/api/air/tasks/:id', route(async (req, res) => conditionalBody(req, res, await taskDetail(req.params.id))));
  // Navigation needs identity and access, not the complete transcript or Git
  // delivery inspection. History remains paged by the chat transport.
  app.get('/api/air/tasks/:id/open', route(async req => {
    const entry = await deps.shell.taskEntry(req.params.id, { includeMessages: false });
    // Web 与 App 把任务放上屏幕时都走这里：这就是「看过了」，未读提醒在所有端一起消掉。
    try { deps.markTaskSeen?.(req.params.id); } catch (_) {}
    const targetId = entry.readOnly ? entry.sourceSessionId : entry.sessionId;
    const record = deps.records.get(targetId);
    const allowed = record?.kind === 'chat' && !record.taskExecutionSlot
      && !['aux', 'gateway'].includes(record.type);
    const pending = record?.pendingConfiguration || null;
    let roleBindings = null;
    try { roleBindings = deps.shell.roleBindings(req.params.id); } catch (_) {}
    return { ok: true, taskId: req.params.id, readOnly: entry.readOnly,
      sessionId: entry.sessionId, sourceSessionId: entry.sourceSessionId,
      configuration: allowed ? {
        cli: record.cli, model: record.model, effectiveModel: autoLine(record)?.model || deps.effectiveModel?.(record) || record.model || null,
        effort: record.effort, provider: record.provider || null,
        providerName: deps.providerName?.(record) || record.provider || null,
        providerSelection: record.providerSelection || null, subagent: deps.serializeSubagent?.(record.subagent) || null,
        pendingConfiguration: pending ? { ...pending, providerName: deps.providerName?.({ cli: pending.cli || record.cli, provider: pending.profile?.provider || null }) || null } : null,
      } : null,
      roleBindings,
      session: allowed ? {
        id: record.id, kind: 'chat', dirId: record.dirId, label: record.label,
        cli: record.cli, cwd: record.worktreePath || deps.directories.get(record.dirId)?.path || '',
        createdAt: record.createdAt, taskBoundTaskId: record.taskBoundTaskId || null,
        autoCommit: record.autoCommit !== false,
      } : null };
  }));
  app.post('/api/air/tasks/:id/delivery/reconcile', route(async req => {
    const entry = await deps.shell.taskEntry(req.params.id);
    return { ok: true, publications: await deps.admission.recoverEvidence(entry.sessionId) };
  }));
  app.post('/api/air/tasks/:id/roles', route(req => ({ ok: true, roleBindings: deps.shell.updateRoleBindings(req.params.id, req.body) })));
  const writes = liveSync ? { get: (...args) => app.get(...args), post: (path, handler) => app.post(path, async (req, res) => {
    // pin/todo/ignore 全是快照元数据字段，元数据档重建就会重排分页与计数。
    try { await handler(req, res); } finally { liveSync.invalidate([]); }
  }) } : app;
  pins().mountRoutes(writes);
  todos().mountRoutes(writes);
  todoIgnores().mountRoutes(writes);
  return liveSync;
}
module.exports = { mountAirRoutes };
