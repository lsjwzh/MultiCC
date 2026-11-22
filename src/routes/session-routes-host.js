'use strict';

// 宿主端口：会话管理 18 条公开路由（原本分散在六个文件里）已由 Rust 前门独占。
//
//   GET|HEAD|PUT|DELETE /api/sessions/:id/memory      (session-memory.js)
//   POST                 /api/sessions/:id/memory/action
//   GET|HEAD             /api/sessions/:id/bundle     (session-bundle.js)
//   POST                 /api/sessions/import
//   DELETE               /api/sessions/:id            (session-lifecycle.js)
//   POST                 /api/sessions/:id/relocate
//   POST                 /api/sessions/:id/restart
//   POST                 /api/sessions/:id/restart-spawn
//   POST                 /api/sessions/:id/vendor-login-terminal  (session-create.js)
//   POST                 /api/agy/accounts/:id/login-terminal     (agy-accounts.js)
//   PUT                  /api/directories/:id/role-workers/:presetId
//   POST                 /api/directories/:id/sessions
//   POST                 /api/sessions/:id/notes      (session-meta.js)
//   GET|HEAD             /api/sessions/:id/liveness
//   GET|HEAD             /api/sessions/:id/notes
//   PATCH                /api/sessions/:id            (session-profile.js)
//   POST                 /api/sessions/:id/fork
//
// 路径匹配、参数解码、查询/请求体读取、Express 自动 OPTIONS、内部执行槽判定、
// 主机不可达/未知 op 的错误形状都在 native/gateway/src/app/session_routes.rs 与
// native/core/src/session_routes.rs。
//
// 这里只剩 Node 独有的运行时事实与副作用：会话/目录 Map 读写、CLI 子进程起停、
// git bundle 与 crypto 加密、zip 打包解包、worktree 事务、待定配置暂存、
// transcript fork、WebSocket 广播与审计事件追加。
//
// 处理器仍按退休时的样子写 `res.status(...).json(...)`；这里的捕获器把它们变成
// `{ status, body }`，前门原样回放 —— 两边不会各自长出第二套状态码或键序规则。
//
// 两个二进制路由不在本端口：`GET /api/sessions/:id/bundle.zip`（内存里生成的
// zip，字节携带时间戳）与 `POST /api/sessions/import-zip`（160MB 原文请求体）
// 仍由 Node 的公开 Express 路由直接服务。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求。

const HOST_PATH = '/api/__host/session-routes';

/** Marker meaning "this op has no handler to run it" -> unknown operation. */
const UNKNOWN = Symbol('unknown');

// 每个 op 指向退休模块注册的那一对 (method, 路径模板)。参数直接由前门解好的
// `id` / `presetId` 组装 —— 路径匹配与解码是 Rust 的活，这里不再匹配第二遍。
const OPS = {
  'memory-get': { method: 'GET', path: '/api/sessions/:id/memory', params: ['id'] },
  'memory-put': { method: 'PUT', path: '/api/sessions/:id/memory', params: ['id'] },
  'memory-delete': { method: 'DELETE', path: '/api/sessions/:id/memory', params: ['id'] },
  'memory-action': { method: 'POST', path: '/api/sessions/:id/memory/action', params: ['id'] },
  'bundle-export': { method: 'GET', path: '/api/sessions/:id/bundle', params: ['id'] },
  'bundle-import': { method: 'POST', path: '/api/sessions/import', params: [] },
  'session-delete': { method: 'DELETE', path: '/api/sessions/:id', params: ['id'] },
  'session-relocate': { method: 'POST', path: '/api/sessions/:id/relocate', params: ['id'] },
  'session-restart': { method: 'POST', path: '/api/sessions/:id/restart', params: ['id'] },
  'session-restart-spawn': { method: 'POST', path: '/api/sessions/:id/restart-spawn', params: ['id'] },
  'vendor-login-terminal': { method: 'POST', path: '/api/sessions/:id/vendor-login-terminal', params: ['id'] },
  // agy 账号的登录终端：前门解析并校验账号目录，这里只负责起 PTY 会话。
  'agy-login-terminal': { method: 'POST', path: '/api/agy/accounts/:id/login-terminal', params: ['id'] },
  'role-workers-put': {
    method: 'PUT', path: '/api/directories/:id/role-workers/:presetId', params: ['id', 'presetId'],
  },
  'directory-create-session': { method: 'POST', path: '/api/directories/:id/sessions', params: ['id'] },
  'note-create': { method: 'POST', path: '/api/sessions/:id/notes', params: ['id'] },
  'liveness': { method: 'GET', path: '/api/sessions/:id/liveness', params: ['id'] },
  'notes-list': { method: 'GET', path: '/api/sessions/:id/notes', params: ['id'] },
  'session-patch': { method: 'PATCH', path: '/api/sessions/:id', params: ['id'] },
  'session-fork': { method: 'POST', path: '/api/sessions/:id/fork', params: ['id'] },
};

/** 一个只记录路由的 Express 替身：六个模块在它上面注册，按 (method, 模板) 取用。 */
function createCaptureApp(handlers) {
  const record = method => (path, ...args) => {
    // import-zip 是 `(path, rawMiddleware, handler)`：真正要调用的是最后一个。
    handlers.set(`${method} ${path}`, args[args.length - 1]);
  };
  return {
    get: record('GET'),
    put: record('PUT'),
    post: record('POST'),
    patch: record('PATCH'),
    delete: record('DELETE'),
    use() {},
  };
}

/** `res` 当作退休处理器使用：它们渲染，我们取走状态码与正文。 */
function runHandler(handler, req) {
  return new Promise((resolve, reject) => {
    const reply = { status: 200, body: null };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(reply);
    };
    const res = {
      headersSent: false,
      status(code) { reply.status = code; return res; },
      json(body) { reply.body = body === undefined ? null : body; finish(); return res; },
      send(body) { reply.body = body === undefined ? null : body; finish(); return res; },
      end(body) { if (body !== undefined) reply.body = body; finish(); return res; },
      // 退休的 JSON 路由不设自定义响应头（只有留在 Node 的 zip 路由会设）。
      set() { return res; },
      setHeader() { return res; },
      type() { return res; },
    };
    // asyncHandler 只在拒绝时调用 next，成功时由 res.json/res.send 结束；
    // 因此这里靠 res 的终止调用与 next(err) 两路收尾。
    const next = (error) => {
      if (error) {
        if (done) return;
        done = true;
        reject(error);
        return;
      }
      finish();
    };
    try {
      const returned = handler(req, res, next);
      if (returned && typeof returned.then === 'function') returned.catch(next);
    } catch (error) {
      if (!done) {
        done = true;
        reject(error);
      }
    }
  });
}

/**
 * `safeErrorHandler` 对一次抛出的渲染：状态码只认 4xx/5xx，正文绝不外泄
 * message（除非 err.safe）。前门用这些字段拼出与 Node 完全一致的错误信封。
 */
function thrownEnvelope(error) {
  const status = Number.isInteger(error && error.status)
    && error.status >= 400 && error.status < 600 ? error.status : 500;
  const safeMessage = error && error.safe && typeof error.message === 'string'
    ? error.message : null;
  return {
    threw: true,
    status,
    code: (error && error.code) || (status >= 500 ? 'internal_error' : 'request_error'),
    message: status >= 500 ? 'internal_error' : (safeMessage || 'request_error'),
  };
}

async function invoke(handlers, body) {
  const spec = OPS[body.op];
  if (!spec) return UNKNOWN;
  const handler = handlers.get(`${spec.method} ${spec.path}`);
  if (typeof handler !== 'function') return UNKNOWN;
  const params = {};
  for (const name of spec.params) params[name] = body[name];
  const req = {
    method: spec.method,
    path: spec.path,
    params,
    query: body.query && typeof body.query === 'object' ? body.query : {},
    body: body.body === undefined ? null : body.body,
    headers: {},
    get() { return undefined; },
  };
  try {
    return await runHandler(handler, req);
  } catch (error) {
    return thrownEnvelope(error);
  }
}

/**
 * 建一个捕获应用；六个退休模块在它上面 `mountRoutes`。`mountRoute` 再把唯一的
 * 宿主端点挂到真实的 Express app 上。
 */
function createSessionRoutesHost() {
  const handlers = new Map();
  const app = createCaptureApp(handlers);
  function mountRoute(expressApp, options = {}) {
    if (!expressApp || typeof expressApp.post !== 'function') {
      throw new TypeError('[session-routes-host] Express app is required');
    }
    const isLocal = options.isLocal || require('../request-locality').isLocalRequest;
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
            console.error(`[session-routes-host] ${body.op} failed: ${error?.message || error}`);
            return res.status(500).json({ error: 'internal_error' });
          },
        );
    });
  }
  return { app, mountRoute };
}

module.exports = { HOST_PATH, OPS, createSessionRoutesHost };
