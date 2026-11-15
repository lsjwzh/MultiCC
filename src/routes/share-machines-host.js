'use strict';

// 宿主端口：分享 / 多电脑 / 工作区 21 条公开路由（原本分散在三个文件里）已由
// Rust 前门独占。
//
//   GET|HEAD            /api/machines                     (machines.js)
//   GET|HEAD            /api/machines/self
//   GET|HEAD            /api/machines/grants
//   POST                /api/machines/pair
//   DELETE              /api/machines/connection
//   DELETE              /api/machines/grants/:grantId
//   POST                /api/machines
//   PATCH|DELETE        /api/machines/:machineId
//   POST                /api/machines/:machineId/ws-ticket
//   POST                /api/sessions/:id/share            (routes/share.js)
//   GET|HEAD            /api/sessions/:id/shares
//   DELETE              /api/sessions/:id/share/:token
//   POST                /api/sessions/:id/share-messages
//   GET|HEAD            /share/:token
//   POST                /api/share/:token/auth
//   GET|HEAD            /api/share/:token/entry
//   GET|HEAD            /api/share/:token/history
//   GET|HEAD            /api/share/:token/session
//   GET|HEAD            /api/workspaces/overview           (routes/workspaces.js)
//   POST                /api/workspaces/sweep
//
// 路径匹配、参数解码、查询/请求体读取、Express 自动 OPTIONS、内部执行槽判定、
// 跨站闸门、主机不可达/未知 op 的错误形状都在
// native/gateway/src/app/share_machine_routes.rs 与
// native/core/src/share_machine_routes.rs。
//
// 这里只剩 Node 独有的运行时事实与副作用：机器注册表与授权表（已经是
// native/core/machines，经 addon 复用）、机器远端 HTTP 与 WS 票据表、分享记录与
// 密码 cookie、工作区扫描/清扫、缓存击穿版 HTML 写入器。
//
// 处理器仍按退休时的样子写 `res.set/status/json/send`；这里的捕获器把它们变成
// `{ status, body, headers }`，前门原样回放 —— 两边不会各自长出第二套状态码、
// 头或键序规则。
//
// 两处刻意留在 Node 的公开路由：`GET /api/machines/:machineId/proxy` 与它的 SSE
// 变体（二进制流，装不进 JSON 宿主端口）。它们由 `machines.mountProxy` 直接挂在
// 真实 app 上，前门原样转发，连跨站闸门一起保留。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求。

const HOST_PATH = '/api/__host/share-machines';

/** Marker meaning "this op has no handler to run it" -> unknown operation. */
const UNKNOWN = Symbol('unknown');

// 每个 op 指向退休模块注册的那一对 (method, 路径模板)。参数由前门解好后直接塞进
// `req.params` —— 路径匹配与解码是 Rust 的活，这里不再匹配第二遍。
const OPS = {
  'machines-list': { method: 'GET', path: '/api/machines', params: [] },
  'machines-self': { method: 'GET', path: '/api/machines/self', params: [] },
  'machines-grants': { method: 'GET', path: '/api/machines/grants', params: [] },
  'machines-pair': { method: 'POST', path: '/api/machines/pair', params: [] },
  'machines-connection-delete': { method: 'DELETE', path: '/api/machines/connection', params: [] },
  'machines-grant-revoke': { method: 'DELETE', path: '/api/machines/grants/:grantId', params: ['grantId'] },
  'machines-add': { method: 'POST', path: '/api/machines', params: [] },
  'machines-rename': { method: 'PATCH', path: '/api/machines/:machineId', params: ['machineId'] },
  'machines-remove': { method: 'DELETE', path: '/api/machines/:machineId', params: ['machineId'] },
  'machines-ws-ticket': { method: 'POST', path: '/api/machines/:machineId/ws-ticket', params: ['machineId'] },
  'session-share-create': { method: 'POST', path: '/api/sessions/:id/share', params: ['id'] },
  'session-shares-list': { method: 'GET', path: '/api/sessions/:id/shares', params: ['id'] },
  'session-share-revoke': { method: 'DELETE', path: '/api/sessions/:id/share/:token', params: ['id', 'token'] },
  'session-share-messages': { method: 'POST', path: '/api/sessions/:id/share-messages', params: ['id'] },
  'share-page': { method: 'GET', path: '/share/:token', params: ['token'] },
  'share-auth': { method: 'POST', path: '/api/share/:token/auth', params: ['token'] },
  'share-entry': { method: 'GET', path: '/api/share/:token/entry', params: ['token'] },
  'share-history': { method: 'GET', path: '/api/share/:token/history', params: ['token'] },
  'share-session': { method: 'GET', path: '/api/share/:token/session', params: ['token'] },
  'workspaces-overview': { method: 'GET', path: '/api/workspaces/overview', params: [] },
  'workspaces-sweep': { method: 'POST', path: '/api/workspaces/sweep', params: [] },
};

/** 一个只记录路由的 Express 替身：三个模块在它上面注册，按 (method, 模板) 取用。 */
function createCaptureApp(handlers) {
  const record = method => (path, ...args) => {
    // `machines.mount` 用 `(path, json, handler)`：真正要调用的是最后一个。
    handlers.set(`${method} ${path}`, args[args.length - 1]);
  };
  return {
    get: record('GET'),
    put: record('PUT'),
    post: record('POST'),
    patch: record('PATCH'),
    delete: record('DELETE'),
    // 跨站闸门与 raw/SSE proxy 只挂在真实 app 上（`machines.mountProxy`）。
    use() {},
  };
}

/** `res.type(value)` 的 Content-Type（-types 查表 + charset）。只有分享页用它。 */
function contentTypeOf(value) {
  const text = String(value || '');
  if (text === 'html' || text === 'text/html') return 'text/html; charset=utf-8';
  if (text.startsWith('text/') && !text.includes('charset=')) return `${text}; charset=utf-8`;
  return text;
}

/**
 * `res` 当作退休处理器使用：它们渲染，我们取走状态码、正文与响应头。
 * 正文只可能是 JSON 值或字符串 —— 二进制 proxy 不在本端口，出现即视为编程错误。
 */
function runHandler(handler, req) {
  return new Promise((resolve, reject) => {
    const reply = { status: 200, body: null, headers: [] };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(reply);
    };
    const res = {
      headersSent: false,
      status(code) { reply.status = code; return res; },
      set(name, value) { reply.headers.push([String(name), String(value)]); return res; },
      setHeader(name, value) { reply.headers.push([String(name), String(value)]); return res; },
      type(value) { reply.contentType = contentTypeOf(value); return res; },
      json(body) { reply.body = body === undefined ? null : body; finish(); return res; },
      send(body) {
        if (Buffer.isBuffer(body)) throw new Error('share-machines host does not relay binary bodies');
        reply.body = body === undefined ? null : body;
        finish();
        return res;
      },
      // `_serveVersionedHtml` 读文件失败时只 `status(500).end()`：没有正文、
      // 没有 Content-Type、也没有 ETag。
      end(body) {
        if (body === undefined) reply.bare = true;
        else reply.body = body;
        finish();
        return res;
      },
    };
    // 成功由 res 的终止调用收尾；asyncHandler 只在拒绝时调用 next。
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

async function invoke(handlers, machines, body) {
  const spec = OPS[body.op];
  if (!spec) return UNKNOWN;
  const handler = handlers.get(`${spec.method} ${spec.path}`);
  if (typeof handler !== 'function') return UNKNOWN;
  const params = {};
  for (const name of spec.params) params[name] = body[name];
  const headers = body.headers && typeof body.headers === 'object' ? body.headers : {};
  const req = {
    method: spec.method,
    path: spec.path,
    originalUrl: typeof body.originalUrl === 'string' ? body.originalUrl : spec.path,
    params,
    query: body.query && typeof body.query === 'object' ? body.query : {},
    body: body.body === undefined ? null : body.body,
    headers,
    // 内网明文端口上的 Express 没有 `trust proxy`，`req.protocol` 恒为 http。
    protocol: 'http',
    get(name) { return headers[String(name).toLowerCase()]; },
  };
  // `DELETE /api/machines/connection` 读的是授权闸门在请求上留下的
  // `req.machineGrantId`。前门已经用同一份 machines 内核判过准入；这里用同一个
  // `authorize` 把 id 取回来，绝不在 Rust 侧复制一份授权表。
  if (body.op === 'machines-connection-delete') machines.authorize(req);
  try {
    return await runHandler(handler, req);
  } catch (error) {
    return thrownEnvelope(error);
  }
}

/**
 * 建一个捕获应用；三个退休模块在它上面 `mount`。`mountRoute` 再把唯一的宿主
 * 端点挂到真实的 Express app 上。
 */
function createShareMachinesHost(deps = {}) {
  const { express, machines, share, workspaces } = deps;
  if (!express || typeof express.json !== 'function') {
    throw new TypeError('[share-machines-host] express is required');
  }
  if (!machines || typeof machines.mount !== 'function' || typeof machines.authorize !== 'function') {
    throw new TypeError('[share-machines-host] machines runtime is required');
  }
  if (!share || typeof share !== 'object') {
    throw new TypeError('[share-machines-host] share route dependencies are required');
  }
  if (!workspaces || typeof workspaces !== 'object') {
    throw new TypeError('[share-machines-host] workspace route dependencies are required');
  }
  const handlers = new Map();
  const app = createCaptureApp(handlers);
  // 原挂载顺序：machines.mount（10 条 + 内部 use），mountShareRoutes，最后
  // mountWorkspaceRoutes。顺序只影响 Express 的 Allow 并集，这里同样保留。
  machines.mount(app, express);
  require('./share').mountShareRoutes(app, share);
  require('./workspaces').mountWorkspaceRoutes(app, workspaces);

  function mountRoute(expressApp, options = {}) {
    if (!expressApp || typeof expressApp.post !== 'function') {
      throw new TypeError('[share-machines-host] Express app is required');
    }
    const isLocal = options.isLocal || require('../request-locality').isLocalRequest;
    expressApp.post(HOST_PATH, (req, res) => {
      // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
      if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
      const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
        ? req.body : {};
      return Promise.resolve()
        .then(() => invoke(handlers, machines, body))
        .then(
          (value) => {
            if (value === UNKNOWN) return res.status(400).json({ error: 'unknown host operation' });
            return res.json({ ok: true, value: value === undefined ? null : value });
          },
          (error) => {
            console.error(`[share-machines-host] ${body.op} failed: ${error?.message || error}`);
            return res.status(500).json({ error: 'internal_error' });
          },
        );
    });
  }
  return { app, mountRoute };
}

module.exports = { HOST_PATH, OPS, createShareMachinesHost };
