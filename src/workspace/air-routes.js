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
    // 与任务板同一条自愈规则（见 task-board/view.js 的 deadDispatchClaim）：派发时
    // 写下的乐观 runState，如果名下会话从来没有过 taskState，就证明这一轮从没被受理
    // 过 —— 不把这类卡片继续报成「执行中」（否则它会挂在控制台上直到天荒地老）。
    const hasTurnState = sessionId => {
      const record = deps.records.get(sessionId);
      return !!(record && record.taskState);
    };
    const projectNow = Date.now();
    const admission = deps.admission.snapshot();
    const tasks = boardTasks().map(t => {
      const sessionId = t.chatSessionId || t.sessionId || null;
      const access = deps.shell.taskAccess(t);
      return { id: t.id, dirId: core.taskDirId(board, t) || deps.records.get(sessionId)?.dirId, title: t.title, status: t.status,
        recordType: t.recordType || null, workflowStage: t.workflowStage || null, updatedAt: t.updatedAt || t.createdAt,
        sessionId, ...access,
        // 这一轮到底在不在跑，是队列事件折出来的事实（src/task-board/normalize.js
        // TASK_RUN_STATES），不是客户端能从 status 猜出来的：status 只有
        // active/done/archived 三个人为的生命周期取值，「执行中」根本不在里面。
        // 客户端只读它，不推断它。
        // 自愈：证明这一轮从没被受理过的卡片按空闲投影，而不是永久「执行中」。
        runState: core.deadDispatchClaim(t, core.taskRunSessionIds(t).some(hasTurnState), projectNow)
          ? 'idle' : (t.runState || null),
        resource: resource(sessionId, admission) };
    });
    return { ok: true, directories: [...deps.directories.values()].map(d => ({ id: d.id, name: d.name, path: d.path })),
      tasks, taskPins: pins().read(), budgets: admission.budgets, clis: deps.clis, migration, lastRuntime,
      sessions: [...deps.records.values()].filter(s => s.kind === 'terminal' && !['aux', 'gateway'].includes(s.type))
        .map(s => ({ id: s.id, dirId: s.dirId, label: s.label || s.id, kind: s.kind, cli: s.cli })) };
  }
  app.get('/api/air', route(async (req, res) => conditionalBody(req, res, await airSnapshot())));
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
      effectiveModel: deps.effectiveModel?.(record) || record?.model || null,
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
  app.post('/api/air/tasks/:id/delivery/reconcile', route(async req => {
    const entry = await deps.shell.taskEntry(req.params.id);
    return { ok: true, publications: await deps.admission.recoverEvidence(entry.sessionId) };
  }));
  app.post('/api/air/tasks/:id/roles', route(req => ({ ok: true, roleBindings: deps.shell.updateRoleBindings(req.params.id, req.body) })));
  pins().mountRoutes(app);
}
module.exports = { mountAirRoutes };
