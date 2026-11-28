'use strict';

// 宿主端口：编排与无人值守 30 条公开路由（原本分散在四个文件里）已由 Rust
// 前门独占。
//
//   GET    /api/aux/status, /api/aux/health, /api/aux/history      (aux-goal.js)
//   POST   /api/aux/enqueue, /api/aux/cancel
//   GET|POST /api/aux/config, /api/settings/goal
//   POST   /api/goal/precheck
//   GET    /api/sessions/:id/aux-runs, …/aux-runs/:runId           (aux-runs.js)
//   GET|POST /api/sessions/:id/unattended                          (unattended/routes.js)
//   POST|GET /api/sessions/:id/scheduled-messages                  (orchestration.js)
//   DELETE /api/sessions/:id/scheduled-messages/:messageId
//   GET    /api/sessions/:id/tasks, …/dispatches, …/queue
//   POST   /api/sessions/:id/user-input/dismiss, …/queue/action
//   GET    /api/v1/sessions/:id/waits
//   POST   /api/sessions/:id/wait, /api/wait/:wid/resolve
//   GET    /api/sessions/:id/waits        DELETE /api/wait/:wid
//   POST   /api/sessions/:id/run-detached
//   GET    /api/sessions/:id/detached, /api/detached/:taskId
//
// 路径匹配、参数解码、查询子集、Express 自动 OPTIONS 并集、会话准入守卫（含 v1
// 信封）、主机不可达/未知 op 的错误形状都在 native/gateway/src/app/
// orchestration_routes.rs 与 native/core/src/orchestration_routes.rs。
//
// 这里只剩 Node 独有的运行时事实与副作用：会话记录表、无人值守监督器、Aux
// 队列与其 Provider/模型配置、持久化编排运行时（定时消息、operations、FIFO
// 调度器）、Aux 运行日志与会话轮次引擎。处理器仍按退休时的样子写
// `res.status/json`；捕获器把它们变成 `{ status, body, headers }`，前门原样回放
// —— 两边不会各自长出第二套状态码、头或键序规则。
//
// 第二批（wait 注入器 / detached 集）把原先留在真实 app 上的 7 条也搬了进来，
// 所以 src/routes/orchestration.js 再没有公开挂载。这 7 条是本簇唯一会读
// `Idempotency-Key` 之外请求头的：wait 注册用 `req.get('host')` 拼 callbackUrl，
// resolve 回调从 `x-wait-token` 取令牌 —— 两个头由前门转发；`protocol` 仍恒为
// http（内网明文端口上的 Express 没有 `trust proxy`）。
//
// 不存在“仅本机”路由；前门仍把按真实客户端地址算出的 `local` 事实放进 req.local，
// 宿主端口自己看到的永远是回环，不能用来判定。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求。

const { createCaptureApp, runHandler, thrownEnvelope } = require('./host-ops-host');

const HOST_PATH = '/api/__host/orchestration';

/** Marker meaning "this op has no handler to run it" -> unknown operation. */
const UNKNOWN = Symbol('unknown');

// 每个 op 指向退休模块注册的那一对 (method, 路径模板)。参数由前门解好后直接塞进
// `req.params`；路径匹配与解码是 Rust 的活，这里不再匹配第二遍。
const OPS = {
  'aux-status': { method: 'GET', path: '/api/aux/status', params: [] },
  'aux-health': { method: 'GET', path: '/api/aux/health', params: [] },
  'aux-history': { method: 'GET', path: '/api/aux/history', params: [] },
  'aux-enqueue': { method: 'POST', path: '/api/aux/enqueue', params: [] },
  'aux-cancel': { method: 'POST', path: '/api/aux/cancel', params: [] },
  'aux-config-get': { method: 'GET', path: '/api/aux/config', params: [] },
  'aux-config-post': { method: 'POST', path: '/api/aux/config', params: [] },
  'settings-goal-get': { method: 'GET', path: '/api/settings/goal', params: [] },
  'settings-goal-post': { method: 'POST', path: '/api/settings/goal', params: [] },
  'goal-precheck': { method: 'POST', path: '/api/goal/precheck', params: [] },
  'session-aux-runs': { method: 'GET', path: '/api/sessions/:id/aux-runs', params: ['id'] },
  'session-aux-run': { method: 'GET', path: '/api/sessions/:id/aux-runs/:runId', params: ['id', 'runId'] },
  'unattended-get': { method: 'GET', path: '/api/sessions/:id/unattended', params: ['id'] },
  'unattended-post': { method: 'POST', path: '/api/sessions/:id/unattended', params: ['id'] },
  'scheduled-message-post': { method: 'POST', path: '/api/sessions/:id/scheduled-messages', params: ['id'] },
  'scheduled-messages-get': { method: 'GET', path: '/api/sessions/:id/scheduled-messages', params: ['id'] },
  'scheduled-message-delete': { method: 'DELETE', path: '/api/sessions/:id/scheduled-messages/:messageId', params: ['id', 'messageId'] },
  'session-tasks': { method: 'GET', path: '/api/sessions/:id/tasks', params: ['id'] },
  'session-dispatches': { method: 'GET', path: '/api/sessions/:id/dispatches', params: ['id'] },
  'user-input-dismiss': { method: 'POST', path: '/api/sessions/:id/user-input/dismiss', params: ['id'] },
  'session-queue': { method: 'GET', path: '/api/sessions/:id/queue', params: ['id'] },
  'session-queue-action': { method: 'POST', path: '/api/sessions/:id/queue/action', params: ['id'] },
  'v1-session-waits': { method: 'GET', path: '/api/v1/sessions/:id/waits', params: ['id'] },
  'session-wait-post': { method: 'POST', path: '/api/sessions/:id/wait', params: ['id'] },
  'wait-resolve': { method: 'POST', path: '/api/wait/:wid/resolve', params: ['wid'] },
  'session-waits': { method: 'GET', path: '/api/sessions/:id/waits', params: ['id'] },
  'wait-cancel': { method: 'DELETE', path: '/api/wait/:wid', params: ['wid'] },
  'run-detached': { method: 'POST', path: '/api/sessions/:id/run-detached', params: ['id'] },
  'session-detached': { method: 'GET', path: '/api/sessions/:id/detached', params: ['id'] },
  'detached-task': { method: 'GET', path: '/api/detached/:taskId', params: ['taskId'] },
  'cross-machine-targets': { method: 'GET', path: '/api/cross-machine/targets', params: [] },
  'cross-machine-admit': { method: 'POST', path: '/api/cross-machine/dispatches', params: [] },
  'cross-machine-status': { method: 'GET', path: '/api/cross-machine/dispatches/:opId', params: ['operationId'] },
  'cross-machine-cancel': { method: 'POST', path: '/api/cross-machine/dispatches/:opId/cancel', params: ['operationId'] },
  'cross-machine-ack': { method: 'POST', path: '/api/cross-machine/receipts/ack', params: [] },
  'cross-machine-pending-receipts': { method: 'GET', path: '/api/cross-machine/receipts/pending', params: [] },
};

async function invoke(handlers, body) {
  const spec = OPS[body.op];
  if (!spec) return UNKNOWN;
  const handler = handlers.get(`${spec.method} ${spec.path}`);
  if (typeof handler !== 'function') return UNKNOWN;
  const params = {};
  for (const name of spec.params) params[name] = body[name];
  if (body.operationId != null && params.opId == null) params.opId = body.operationId;
  const headers = body.headers && typeof body.headers === 'object' ? body.headers : {};
  const local = body.local === true;
  const requestId = typeof body.requestId === 'string' ? body.requestId : undefined;
  const req = {
    method: spec.method,
    path: spec.path,
    originalUrl: typeof body.originalUrl === 'string' ? body.originalUrl : spec.path,
    params,
    query: body.query && typeof body.query === 'object' ? body.query : {},
    body: body.body === undefined ? null : body.body,
    grant: body.grant && typeof body.grant === 'object' ? body.grant : null,
    settle: body.settle,
    headers,
    protocol: 'http',
    local,
    socket: { remoteAddress: local ? '127.0.0.1' : '203.0.113.9' },
    // `requestContext(req, res)` (v1 envelopes) reads these when res.locals is empty.
    id: requestId,
    correlationId: typeof body.correlationId === 'string' ? body.correlationId : undefined,
    get(name) { return headers[String(name).toLowerCase()]; },
  };
  try {
    return await runHandler(handler, req);
  } catch (error) {
    console.error(`[orchestration-host] ${body.op} threw: ${error?.stack || error}`);
    return thrownEnvelope(error);
  }
}

/**
 * 建一个捕获应用；四个退休模块在它上面挂载，`mountRoute` 再把唯一的宿主端点挂到
 * 真实的 Express app 上。`app`（捕获应用）要在任何一个模块挂载之前创建；
 * 处理器按 (method, 模板) 在调用时才查，所以挂载顺序与 `mountRoute` 的先后无关。
 */
function createOrchestrationHost(deps = {}) {
  const { express } = deps;
  if (!express || typeof express.json !== 'function') {
    throw new TypeError('[orchestration-host] express is required');
  }
  const handlers = new Map();
  const app = createCaptureApp(handlers);

  function mountRoute(expressApp, options = {}) {
    if (!expressApp || typeof expressApp.post !== 'function') {
      throw new TypeError('[orchestration-host] Express app is required');
    }
    const isLocal = options.isLocal || require('../native/binding').requestLocality.isLocalRequest;
    expressApp.post(HOST_PATH, (req, res) => {
      // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
      if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
      const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
        ? req.body : {};
      return Promise.resolve()
        .then(() => invoke(handlers, body))
        .then(
          (value) => {
            if (value === UNKNOWN) return res.status(400).json({ error: 'unknown host operation' });
            return res.json({ ok: true, value: value === undefined ? null : value });
          },
          (error) => {
            console.error(`[orchestration-host] ${body.op} failed: ${error?.message || error}`);
            return res.status(500).json({ error: 'internal_error' });
          },
        );
    });
  }
  return { app, handlers, mountRoute };
}

function createAuxRunRoutes({ records, getLog } = {}) {
  if (!records || typeof records.get !== 'function') throw new TypeError('aux run records map required');
  if (typeof getLog !== 'function') throw new TypeError('aux run log getter required');
  const { getNative } = require('../native/binding');
  function mountRoutes(app) {
    if (!app || typeof app.get !== 'function') throw new TypeError('Express app.get required');
    const handle = detail => (req, res) => getNative().auxRunResponse(records, getLog, detail, req, res);
    app.get('/api/sessions/:id/aux-runs', handle(false));
    app.get('/api/sessions/:id/aux-runs/:runId', handle(true));
  }
  return Object.freeze({ mountRoutes });
}

function mountUnattendedRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('[unattended-routes] Express app is required');
  }
  const records = deps.records;
  if (!records || typeof records.get !== 'function') {
    throw new TypeError('[unattended-routes] records map is required');
  }
  const { getNative } = require('../native/binding');
  const { LIMITS } = require('../unattended/native-host').kernel;
  const settle = async (res, result) => getNative().unattendedRouteResult(res, await result, LIMITS);
  const ports = { records, deps, limits: LIMITS, settle };
  app.get('/api/sessions/:id/unattended', (req, res) =>
    getNative().unattendedRouteRequest(ports, false, req, res));
  app.post('/api/sessions/:id/unattended', async (req, res) =>
    getNative().unattendedRouteRequest(ports, true, req, res));
}

module.exports = { HOST_PATH, OPS, mountUnattendedRoutes, createOrchestrationHost, createAuxRunRoutes };
