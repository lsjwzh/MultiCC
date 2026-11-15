'use strict';

// 宿主端口：task-shell 的 42 条公开路由已由 Rust 前门独占。
// 路径匹配、参数解码、查询/请求体读取、Express 自动 OPTIONS、分页与 DTO
// 字段顺序、错误码映射、状态码决策树见 native/gateway/src/app/task_shell.rs
// 与 native/core/src/task_shell.rs。
//
// 这里只剩 Node 独有的运行时事实与副作用：
//
//   task-shell runtime  进程内任务壳/任务板/记录的运行时（SQLite 任务库、
//                       执行状态、聊天历史、WebSocket 广播都在它背后）
//   taskOperations      事务性重新归属的持久操作
//   attributionDecisions 归属判定日志
//   independent         独立继续的等待队列
//   relations           关系边
//   artifact 采集       整份转录解析 + 8s 合并复用
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求。

const { cleanError } = require('../task-shell/runtime');

const HOST_PATH = '/api/__host/task-shell';

/** Marker meaning "this op has no dependency to run it" -> unknown operation. */
const UNKNOWN = Symbol('unknown');

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('[task-shell-host] dependencies are required');
  }
  if (typeof deps.getRuntime !== 'function') {
    throw new TypeError('[task-shell-host] dependency missing: getRuntime');
  }
  return deps;
}

/** The facts the retired `route()` catch arm projected onto the error body. */
function refusal(error) {
  const clean = cleanError(error);
  const out = { code: clean.code, message: clean.message };
  if (error && error.status !== undefined) out.status = error.status;
  if (error && Array.isArray(error.conflicts)) out.conflicts = error.conflicts;
  if (error && error.detail && typeof error.detail === 'object') out.detail = error.detail;
  if (error && error.receiptId) {
    out.receiptId = error.receiptId;
    out.taskId = error.taskId;
    out.notDelivered = error.notDelivered === true;
  }
  return out;
}

function requireDep(deps, name) {
  if (typeof deps[name] !== 'function') {
    throw new TypeError(`[task-shell-host] dependency missing: ${name}`);
  }
  return deps[name];
}

function mountTaskShellHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[task-shell-host] Express-compatible app is required');
  }
  const deps = assertDependencies(options);
  const isLocal = options.isLocal || require('../request-locality').isLocalRequest;

  function runtime() {
    return deps.getRuntime();
  }

  // Mirrors the retired handlers one-for-one. Each returns the value the route
  // used to hand to `res.json` (or throw); Rust owns the envelopes on top.
  function invoke(body) {
    switch (body.op) {
      case 'task-entry': {
        const entry = deps.taskEntry || runtime().taskEntry;
        return entry(body.taskId);
      }
      case 'artifacts':
        return requireDep(deps, 'artifacts')(body.taskId);
      case 'shell-artifacts-scope': {
        const scope = runtime().chatScope(body.shellId);
        return { taskId: scope && scope.taskId !== undefined ? scope.taskId : null };
      }
      case 'fork':
        return runtime().forkTask(body.taskId, body.body);
      case 'task-message': {
        // `if (taskEntry) await taskEntry(id)` — the host may omit the port.
        const preflight = deps.taskEntry || null;
        const run = async () => {
          if (preflight) await preflight(body.taskId);
          runtime().assertBoardWritable(body.taskId);
          const entry = await runtime().taskEntry(body.taskId);
          return runtime().sendExplicit(entry.ownerShellId, body.body, { taskId: body.taskId, taskStart: true });
        };
        return run();
      }
      case 'context':
        return runtime().contextTrace(body.sessionId, body.traceId, { includeMessages: body.includeMessages === true });
      case 'separation-latest':
        return runtime().separation.latest(body.sessionId);
      case 'separation-decide':
        return runtime().separation.decide(body.sessionId, body.suggestionId, body.decision);
      case 'open':
        return requireDep(deps, 'open')(body.sessionId);
      case 'view':
        return runtime().view(body.shellId);
      case 'chat':
        return runtime().chatScope(body.shellId);
      case 'shell-history': {
        const history = requireDep(deps, 'history');
        return history(body.shellId, {
          before: body.before, around: body.around, limit: body.limit,
          includeHidden: body.includeHidden === true,
        });
      }
      case 'task-index':
        return requireDep(deps, 'taskIndex')(body.shellId, { includeEmpty: body.includeEmpty === true });
      case 'task-operations-list':
        return requireDep(deps, 'taskOperations')().list(body.shellId);
      case 'task-operations-preview':
        return requireDep(deps, 'taskOperations')().preview({
          scope: runtime().chatScope(body.shellId), turns: body.turns, range: body.range, target: body.target,
        });
      case 'task-operations-apply':
        return requireDep(deps, 'taskOperations')().apply({
          scope: runtime().chatScope(body.shellId), clientMsgId: body.clientMsgId,
          previewToken: body.previewToken, expectedRevision: body.expectedRevision,
          turns: body.turns, range: body.range, target: body.target, queue: body.queue === true,
        });
      case 'task-operations-get':
        return requireDep(deps, 'taskOperations')().get(body.operationId);
      case 'task-operations-cancel':
        return requireDep(deps, 'taskOperations')().cancel({ operationId: body.operationId, clientMsgId: body.clientMsgId });
      case 'task-operations-undo':
        return requireDep(deps, 'taskOperations')().undo({ operationId: body.operationId, clientMsgId: body.clientMsgId });
      case 'attribution-list':
        return requireDep(deps, 'attributionDecisions')().list(body.shellId, { includeHidden: body.includeHidden === true });
      case 'attribution-accept':
        return requireDep(deps, 'attributionDecisions')().accept(body.shellId, body.decisionId, { clientMsgId: body.clientMsgId });
      case 'attribution-dismiss':
        return requireDep(deps, 'attributionDecisions')().dismiss(body.shellId, body.decisionId);
      case 'attribution-defer':
        return requireDep(deps, 'attributionDecisions')().defer(body.shellId, body.decisionId);
      case 'attribution-undo':
        return requireDep(deps, 'attributionDecisions')().undo(body.shellId, body.decisionId);
      case 'independent-request':
        return requireDep(deps, 'independent')().request(body.shellId, body.taskId, { clientMsgId: body.clientMsgId });
      case 'independent-list': {
        const independent = requireDep(deps, 'independent')();
        return independent.list({ shellId: body.shellId }).map(item => independent.publicOp(item));
      }
      case 'independent-get': {
        const independent = requireDep(deps, 'independent')();
        return independent.publicOp(independent.get(body.continuationId));
      }
      case 'independent-apply':
        return requireDep(deps, 'independent')().apply(body.continuationId);
      case 'independent-cancel':
        return requireDep(deps, 'independent')().cancel(body.continuationId);
      case 'independent-retry':
        return requireDep(deps, 'independent')().retry(body.continuationId);
      case 'relations-list':
        return requireDep(deps, 'relations')().list(body.shellId);
      case 'relations-create':
        return requireDep(deps, 'relations')().create(body.shellId, {
          kind: body.kind, fromTaskId: body.fromTaskId, toTaskId: body.toTaskId, clientMsgId: body.clientMsgId,
        });
      case 'relations-remove':
        return requireDep(deps, 'relations')().remove(body.shellId, { relationId: body.relationId, clientMsgId: body.clientMsgId });
      case 'remove-shell':
        return runtime().remove(body.shellId);
      case 'links':
        return runtime().link(body.shellId, body.taskId);
      case 'select-target':
        return runtime().selectTarget(body.shellId, {
          taskId: body.taskId, expectedCursorVersion: body.expectedCursorVersion,
        });
      case 'tasks-resolve':
        return runtime().resolveTask(body.shellId, {
          taskId: body.taskId, taskText: body.taskText, title: body.title,
        });
      case 'detail':
        return runtime().detail(body.shellId, body.taskId);
      case 'shell-message':
        return runtime().send(body.shellId, body.body);
      case 'receipt-retry':
        return runtime().retry(body.shellId, body.receiptId);
      default:
        return UNKNOWN;
    }
  }

  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    return Promise.resolve()
      .then(() => invoke(body))
      .then(
        (value) => {
          if (value === UNKNOWN) return res.status(400).json({ error: 'unknown host operation' });
          return res.json({ ok: true, value: value === undefined ? null : value });
        },
        (error) => res.json({ ok: false, error: refusal(error) }),
      );
  });
}

module.exports = { HOST_PATH, mountTaskShellHostRoute };
