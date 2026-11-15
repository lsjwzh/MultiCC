'use strict';

// 宿主端口：任务面 16 条公开路由已由 Rust 前门独占。
//
//   POST   /api/task-board/tasks
//   POST   /api/task-board/tasks/:taskId/update
//   POST   /api/task-board/tasks/:taskId/planning   （update 的兼容别名）
//   POST   /api/task-board/tasks/:taskId/title
//   POST   /api/task-board/tasks/:taskId/move
//   GET    /api/task-board/directories/:dirId/retention
//   POST   /api/task-board/directories/:dirId/retention
//   POST   /api/task-board/tasks/:taskId/status
//   DELETE /api/task-board/tasks/:taskId
//   POST   /api/task-board/tasks/:taskId/relocate
//   POST   /api/task-board/tasks/:taskId/chat-session
//   GET    /api/task-board/search
//   GET    /api/search/messages
//   POST   /api/air/tasks/mark-achieved
//   GET    /api/task-graph
//   GET    /api/settings/task-attribution
//
// 路径匹配、参数解码、查询/请求体读取、Express 自动 OPTIONS、planning 的
// 错误→状态码阶梯与 `{ok,task,revision}` 信封、保留策略排序与信封、
// mark-achieved 的 eligibility 阶梯、task-graph 的 `meta.durationMs` 插入
// 位置都在 native/gateway/src/app/task_routes.rs 与
// native/core/src/task_routes.rs。
//
// 这里只剩 Node 独有的运行时事实与副作用：任务板文件与任务库写入、按任务与
// 按目录的串行锁、聊天会话绑定、保留策略预检（Git/引用安全检查）、消息索引、
// 任务图谱聚合、attribution 当前档位。
//
// 处理器仍按退休时的样子写 `res.status(...).json(...)`；这里的捕获器把它变成
// `{ status, body }`，Rust 决定最终信封 —— 两边不会各自长出第二套状态码规则。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求。

const { responseStatus } = require('./task-planning');

const HOST_PATH = '/api/__host/task-routes';

/** Marker meaning "this op has no dependency to run it" -> unknown operation. */
const UNKNOWN = Symbol('unknown');

function assertDependencies(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('[task-routes-host] dependencies are required');
  }
  if (!deps.ports || typeof deps.ports !== 'object') {
    throw new TypeError('[task-routes-host] dependency missing: ports');
  }
  if (!deps.search || typeof deps.search.searchBoard !== 'function') {
    throw new TypeError('[task-routes-host] dependency missing: search');
  }
  if (!deps.taskGoal || typeof deps.taskGoal.facts !== 'function') {
    throw new TypeError('[task-routes-host] dependency missing: taskGoal');
  }
  if (!deps.taskGraph || typeof deps.taskGraph.buildHostGraph !== 'function') {
    throw new TypeError('[task-routes-host] dependency missing: taskGraph');
  }
  if (typeof deps.attributionMode !== 'function') {
    throw new TypeError('[task-routes-host] dependency missing: attributionMode');
  }
  return deps;
}

/** `res` as the retired handlers used it: they render, we take the value. */
function captureReply() {
  const reply = { status: 200, body: null };
  const res = {
    headersSent: false,
    status(code) { reply.status = code; return res; },
    json(body) { reply.body = body === undefined ? null : body; return res; },
    send(body) { reply.body = body === undefined ? null : body; return res; },
    set() { return res; },
    setHeader() { return res; },
    end(body) { if (body !== undefined) reply.body = body; return res; },
  };
  return { reply, res };
}

function requirePort(deps, name) {
  const port = deps.ports[name];
  if (typeof port !== 'function') {
    throw new TypeError(`[task-routes-host] dependency missing: ports.${name}`);
  }
  return port;
}

async function runPort(deps, name, context) {
  const { reply, res } = captureReply();
  await requirePort(deps, name)(context, res);
  return reply;
}

function isOkEnvelope(reply) {
  return reply.status === 200 && !!reply.body && typeof reply.body === 'object'
    && reply.body.ok === true;
}

// planning 的成功体是 `{ ok, task, revision }`，拒绝体是 `{ error, ... }`。
// 大多数拒绝走 `fail()`，其状态码由 `responseStatus()` 决定 —— 那一段阶梯在
// Rust 侧，所以这里只回结构化 outcome；不是这条阶梯的拒绝（例如
// `directory_not_found` 自己的 409、`beforeStageChange` 的 `task_busy`）以渲染
// 好的 reply 原样交出，避免 Rust 用阶梯覆盖掉处理器真正发的状态码。
function planningValue(reply) {
  const value = reply.body;
  if (isOkEnvelope(reply)) return { task: value.task, revision: value.revision };
  if (value && typeof value === 'object' && typeof value.error === 'string'
      && reply.status === responseStatus(value.error)) {
    return { outcome: value };
  }
  return { reply };
}

async function planningReply(deps, name, context) {
  return planningValue(await runPort(deps, name, context));
}

async function invoke(deps, body) {
  switch (body.op) {
    case 'planning-create':
      return planningReply(deps, 'planningCreate', { body: body.body });
    case 'planning-update':
    case 'planning-alias': // `/planning` 与 `/update` 是同一个处理器
      return planningReply(deps, 'planningUpdate', { taskId: body.taskId, body: body.body });
    case 'planning-rename':
      return planningReply(deps, 'planningRename', { taskId: body.taskId, body: body.body });
    case 'planning-move':
      return planningReply(deps, 'planningMove', { taskId: body.taskId, body: body.body });
    case 'retention-preview': {
      const reply = await runPort(deps, 'retentionPreview', { dirId: body.dirId });
      if (!isOkEnvelope(reply)) return { reply };
      const tasks = Array.isArray(reply.body.tasks) ? reply.body.tasks : [];
      return {
        limit: reply.body.limit,
        count: reply.body.count,
        maxBatch: reply.body.maxBatch,
        // 前门用同一套比较器重排（native/core/task_domain/retention.rs），
        // 并把 `at` 投影成 `lastInteractionAt`。`idOrder` 用到达顺序，保证
        // 同时间戳的并列保持宿主已经排好的次序。
        entries: tasks.map(task => ({ id: task.id, title: task.title, at: task.lastInteractionAt })),
        idOrder: tasks.map(task => task.id),
      };
    }
    case 'retention-delete': {
      const reply = await runPort(deps, 'retentionDelete', {
        dirId: body.dirId, body: { taskIds: body.taskIds },
      });
      if (!isOkEnvelope(reply)) return { reply };
      return {
        deleted: reply.body.deleted,
        skipped: reply.body.skipped,
        count: reply.body.count,
        limit: reply.body.limit,
      };
    }
    case 'task-status':
      return runPort(deps, 'status', { taskId: body.taskId, body: body.body }).then(reply => ({ reply }));
    case 'task-delete':
      return runPort(deps, 'delete', { taskId: body.taskId, body: body.body }).then(reply => ({ reply }));
    case 'task-relocate':
      return runPort(deps, 'relocate', { taskId: body.taskId, body: body.body }).then(reply => ({ reply }));
    case 'task-chat-session':
      return runPort(deps, 'chatSession', { taskId: body.taskId }).then(reply => ({ reply }));
    case 'search-board': {
      const result = await deps.search.searchBoard({
        query: body.query,
        limit: body.limit,
        dirId: body.dirId === undefined ? null : body.dirId,
        dirIds: body.dirIds === undefined ? null : body.dirIds,
        statuses: body.statuses === undefined ? null : body.statuses,
        // `JSON.stringify(Infinity)` 是 null；退役处理器拿到的是 Infinity。
        minScore: body.minScore === undefined || body.minScore === null ? Infinity : body.minScore,
      });
      if (result.status !== 200) return { reply: result };
      return { results: result.body.results };
    }
    case 'search-messages-scope':
      return deps.search.messageScope();
    case 'search-messages': {
      try {
        return {
          results: await deps.search.findMessages({
            text: body.query,
            limit: body.limit,
            kinds: body.kinds === undefined ? null : body.kinds,
            refIds: body.refIds === undefined ? null : body.refIds,
            dirId: body.dirId === undefined ? null : body.dirId,
            taskId: body.taskId === undefined ? null : body.taskId,
          }),
        };
      } catch (error) {
        return { reply: { status: 503, body: { error: 'message_search_unavailable' } } };
      }
    }
    case 'mark-achieved-facts':
      return deps.taskGoal.facts(body.taskId);
    case 'mark-achieved-write': {
      try {
        return deps.taskGoal.write(body.taskId, body.sessionId);
      } catch (error) {
        // 退休处理器的 catch：状态码取 error.status，没有 status 时正文不外泄。
        return {
          reply: {
            status: error.status || 500,
            body: {
              ok: false,
              code: error.code || 'mark_achieved_failed',
              message: error.status ? error.message : 'Request failed',
            },
          },
        };
      }
    }
    case 'task-graph':
      return deps.taskGraph.buildHostGraph(body.dirId);
    case 'attribution-mode':
      return { mode: deps.attributionMode() };
    default:
      return UNKNOWN;
  }
}

function mountTaskRoutesHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[task-routes-host] Express-compatible app is required');
  }
  const deps = assertDependencies(options);
  const isLocal = options.isLocal || require('../request-locality').isLocalRequest;

  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    return Promise.resolve()
      .then(() => invoke(deps, body))
      .then(
        (value) => {
          if (value === UNKNOWN) return res.status(400).json({ error: 'unknown host operation' });
          return res.json({ ok: true, value: value === undefined ? null : value });
        },
        (error) => {
          console.error(`[task-routes-host] ${body.op} failed: ${error?.message || error}`);
          return res.status(500).json({ error: 'internal_error' });
        },
      );
  });
}

module.exports = { HOST_PATH, mountTaskRoutesHostRoute };
