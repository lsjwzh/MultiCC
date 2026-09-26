'use strict';

const crypto = require('node:crypto');
const core = require('../task-board/core');
const { createAirPinRuntime } = require('./pins');

// Air 是轮询页面：每 4 秒要把「任务板快照」（线上约 580KB、1069 张卡）和
// 「当前任务详情」（实测 3.5MB，3.2MB 是消息正文）各拉一次，浏览器每轮都要
// 解析近 4MB JSON 并把整块 DOM 重建一遍。绝大多数轮次内容根本没变，所以两个
// 读接口支持条件请求：内容一样就回 304，客户端保留现有视图、不再解析。
// ETag 由响应正文本身算出，不额外维护版本号，永远不会与正文脱节。
function conditionalBody(req, res, payload) {
  const body = JSON.stringify(payload);
  const etag = `W/"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
  res.set('ETag', etag);
  const sent = req?.headers?.['if-none-match'];
  if (sent && String(sent).split(',').some(value => value.trim() === etag || value.trim() === '*')) {
    res.status(304).end();
    return undefined;
  }
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.send(body);
  return undefined;
}

// Air reads canonical task records through the task-shell/board authority.
// The client cannot mint a workspace permit, writer proof or attribution fact.
function mountAirRoutes(app, deps) {
  // 处理器可以直接写完响应（条件请求就是如此），也可以照旧返回一个对象。
  const route = fn => async (req, res) => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent && result !== undefined) res.json(result);
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
  /** 独立任务列表与 pin 共用同一可见集合；会话内尚未隔离的任务只保留消息归属。 */
  function boardTasks() {
    const board = deps.getBoard?.() || {};
    // The board index predates separation metadata. Read the canonical shell
    // records so existing cards are hidden too, including after migration.
    // A confirmed split can still be waiting for execution creation: it is not
    // independent until ready. Ordinary planned tasks need no such check.
    const unseparated = new Set((deps.shell.listTasks?.() || [])
      .filter(task => task.embedded === true || (task.separatedFromTaskId && !task.ready))
      .map(task => task.id));
    return Object.values(board.tasks || {}).filter(t => !t.mergedIntoTaskId
      && !board.deletedTaskIds?.includes(t.id) && !unseparated.has(t.id));
  }
  // 一次请求只读一次 admission 快照：这是整表读（workspace:record + lease），
  // 按卡片各读一次时 1069 张卡片要多花约 0.4s 的 CPU 与等量 JSON 解析。
  // workspace 记录按目录折成「worktree 生命周期」计数：光有总数看不出增长方式，
  // 而用户要判断的正是「在本地占着地的是哪些、休眠了哪些、还有多少没落地」。
  // 口径直接来自 registry 的 residency（resident/retained 都在磁盘上、hibernated
  // 只剩分支引用、planned 还没落地），再叠一层「此刻是否被占用」。
  function lifecycleByDirectory(snapshot) {
    const byDir = new Map();
    const byId = new Map();
    for (const workspace of snapshot.workspaces || []) {
      byId.set(workspace.id, workspace);
      if (!workspace.dirId) continue;
      const bucket = byDir.get(workspace.dirId)
        || { resident: 0, retained: 0, hibernated: 0, planned: 0, leased: 0 };
      const residency = ['resident', 'retained', 'hibernated'].includes(workspace.residency)
        ? workspace.residency : 'planned';
      bucket[residency] += 1;
      byDir.set(workspace.dirId, bucket);
    }
    for (const lease of snapshot.leases || []) {
      const workspace = byId.get(lease.workspaceId);
      const bucket = workspace && workspace.dirId && byDir.get(workspace.dirId);
      if (bucket) bucket.leased += 1;
    }
    for (const bucket of byDir.values()) {
      bucket.onDisk = bucket.resident + bucket.retained;
      bucket.total = bucket.onDisk + bucket.hibernated + bucket.planned;
    }
    return byDir;
  }

  function resource(sessionId, snapshot = deps.admission.snapshot()) {
    const record = deps.records.get(sessionId);
    const workspace = snapshot.workspaces.find(w => w.ownerId === (record?.workspaceOwnerSessionId || sessionId));
    const lease = workspace && snapshot.leases.find(l => l.workspaceId === workspace.id);
    return { id: workspace?.id || null, residency: workspace?.residency || (record?.workspaceState === 'planned' ? 'planned' : record ? 'retained' : 'planned'),
      lease: lease?.state || 'idle', capacityReason: workspace && !lease ? deps.admission.capacityReason(workspace.id) : null, reason: lease?.reason || null, pins: workspace?.pins || [],
      path: workspace?.path || record?.worktreePath || null, branch: workspace?.branch || record?.branch || null };
  }
  async function airSnapshot() {
    const migration = await deps.shell.migrateTaskSessions?.();
    // 新任务输入框要「随时更新成最近用过的那套配置」，而不是每次都退回
    // 「默认线路 · 默认模型」。这里从会话记录里取 lastWorkAt 最新的 chat 会话
    // 的运行时，随快照一起下发。只读、不另落盘：「最近使用」本身就是会话
    // 记录已经知道的事，再存一份只会多出一个会悄悄过期的副本。terminal 镜像
    // 会话不在其列 —— 它们的 cli 说着的是进程归属，不是用户挑过的路由。
    let lastUsed = null;
    for (const record of deps.records.values()) {
      if (record.kind !== 'chat' || !record.cli) continue;
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
    const board = deps.getBoard();
    // One directory can retain several task/session worktrees. Count unique
    // paths from both authorities: session records cover ordinary chats;
    // task metadata covers detached/task-bound worktrees whose session record
    // may already be gone. This is inventory only — no cleanup is attempted.
    const worktreesByDir = new Map();
    const noteWorktree = (dirId, worktreePath) => {
      if (!dirId || !worktreePath) return;
      if (!worktreesByDir.has(dirId)) worktreesByDir.set(dirId, new Set());
      worktreesByDir.get(dirId).add(worktreePath);
    };
    for (const record of deps.records.values()) noteWorktree(record.dirId, record.worktreePath);
    for (const task of Object.values(board.tasks || {})) {
      const sessionId = task.chatSessionId || task.sessionId || null;
      const dirId = core.taskDirId(board, task) || deps.records.get(sessionId)?.dirId;
      noteWorktree(dirId, task.worktreePath);
    }
    // 与任务板同一条自愈规则（见 task-board/view.js 的 deadDispatchClaim /
    // sessionHasTurn）：派发时写下的乐观 runState，如果名下会话拿不出受理物证，
    // 就证明这一轮从没被受理过 —— 不把这类卡片继续报成「执行中」（否则它会挂在
    // 控制台上直到天荒地老）。
    const hasTurnState = sessionId => core.sessionHasTurn(deps.records.get(sessionId));
    const projectNow = Date.now();
    const admission = deps.admission.snapshot();
    const lifecycle = lifecycleByDirectory(admission);
    const hibernationPolicy = (() => {
      try { return deps.hibernation?.()?.policy?.() || null; } catch (_) { return null; }
    })();
    const tasks = boardTasks().map(t => {
      const sessionId = t.chatSessionId || t.sessionId || null;
      const record = deps.records.get(sessionId);
      const access = deps.shell.taskAccess(t);
      const taskResource = resource(sessionId, admission);
      // 外层卡片只需要回答「这份 worktree 还有东西没交付吗」，不要把完整 merge
      // 状态（冲突文件、分支细节等）复制进 4 秒一轮的 Air 快照。状态来自和任务页头
      // 同一份缓存；首次读取触发后台刷新，下一轮快照自然带上结果。只触发磁盘上真实
      // 驻留的 worktree：hibernated / planned 没有 checkout，逐条跑 Git 既没意义，
      // 也会让上千张历史卡片排进状态队列。
      let worktreeChanges = null;
      if (record && ['resident', 'retained'].includes(taskResource.residency)
          && typeof deps.mergeStateCached === 'function') {
        const mergeState = deps.mergeStateCached(deps.directories.get(record.dirId), record);
        if (mergeState && mergeState.reason !== 'loading' && mergeState.worktreeMissing !== true) {
          const ahead = Math.max(0, Number.parseInt(mergeState.ahead, 10) || 0);
          worktreeChanges = { dirty: mergeState.dirty === true, ahead };
        }
      }
      // `updatedAt` is task-metadata time: renaming, changing lifecycle/status,
      // classification and new messages can all move it.  The Air task list
      // needs a separate conversation clock so a housekeeping edit cannot jump
      // an old task above a task that just received a message.
      const lastMessageAt = (Array.isArray(t.refs) ? t.refs : [])
        .reduce((latest, ref) => Math.max(latest, Number(ref?.ts) || 0), 0)
        || Number(t.createdAt) || Number(t.updatedAt) || 0;
      return { id: t.id, dirId: core.taskDirId(board, t) || deps.records.get(sessionId)?.dirId, title: t.title, status: t.status,
        recordType: t.recordType || null, workflowStage: t.workflowStage || null,
        updatedAt: t.updatedAt || t.createdAt, lastMessageAt,
        sessionId, ...access,
        // 这一轮到底在不在跑，是队列事件折出来的事实（src/task-board/normalize.js
        // TASK_RUN_STATES），不是客户端能从 status 猜出来的：status 只有
        // active/done/archived 三个人为的生命周期取值，「执行中」根本不在里面。
        // 客户端只读它，不推断它。
        // 自愈：证明这一轮从没被受理过的卡片按空闲投影，而不是永久「执行中」。
        runState: core.deadDispatchClaim(t, core.taskRunSessionIds(t).some(hasTurnState), projectNow)
          ? 'idle' : (core.staleWorkerClaim(t, deps.getSessionRunState, projectNow) || t.runState || null),
        resource: taskResource, worktreeChanges };
    });
    return { ok: true, directories: [...deps.directories.values()].map(d => ({
      id: d.id, name: d.name, path: d.path,
      worktreeCount: worktreesByDir.get(d.id)?.size || 0,
      // 生命周期拆解（见 lifecycleByDirectory）：本地/休眠/计划各几个、此刻几个在用。
      worktreeLifecycle: lifecycle.get(d.id) || { resident: 0, retained: 0, hibernated: 0, planned: 0, leased: 0, onDisk: 0, total: 0 },
    })),
      tasks, taskPins: pins().read(), budgets: admission.budgets, clis: deps.clis, migration, lastRuntime,
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
            state: s.provider && !s.proxyRouteToken ? 'route_dead' : runtime ? 'running' : 'stopped',
            // 「多久没动」= 最后一次有输出的时刻。停了的终端没有运行时，也就没有这个
            // 时刻：给 null，客户端才不至于把一条死进程报成「刚刚」。
            lastActivityAt: runtime ? runtime.lastActivity.getTime() : null,
            createdAt: Date.parse(s.createdAt) || null };
        }) };
  }
  app.get('/api/air', route(async (req, res) => conditionalBody(req, res, await airSnapshot())));

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
  pins().mountRoutes(app);
}
module.exports = { mountAirRoutes };
