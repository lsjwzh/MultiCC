'use strict';

// 宿主端口：账号与登录簇 32 条公开路由（原本分散在八个文件里）已由 Rust 前门独占。
//
//   GET|HEAD|POST  /api/claude/accounts                      (claude-accounts.js)
//   POST           /api/claude/accounts/:id/activate
//   GET|HEAD       /api/claude/accounts/:id/login-status
//   POST           /api/claude/accounts/:id/login-callback
//   POST           /api/claude/accounts/:id/relogin
//   DELETE         /api/claude/accounts/:id
//   GET|HEAD       /api/claude/accounts/:id/quota
//   GET|HEAD|POST  /api/codex/accounts                       (codex-accounts.js)
//   POST           /api/codex/accounts/:id/activate
//   GET|HEAD       /api/codex/accounts/:id/login-status
//   POST           /api/codex/accounts/:id/login-callback
//   POST           /api/codex/accounts/:id/relogin
//   DELETE         /api/codex/accounts/:id
//   GET|HEAD|PUT   /api/zcode/auth                           (zcode-auth.js)
//   POST           /api/zcode/auth/sync
//   GET|HEAD       /api/zcode/auth/check
//   GET|HEAD|POST  /api/cli-accounts/:cli                    (cli-key-accounts.js)
//   PATCH|DELETE   /api/cli-accounts/:cli/:id
//   GET|HEAD|PUT   /api/kimi/auth                            (kimi-auth.js)
//   GET|HEAD       /api/kimi/auth/check
//   GET|HEAD       /api/claude/oauth/status                  (claude-oauth.js)
//   POST           /api/claude/oauth/login
//   GET|HEAD       /api/codex/oauth/status                   (codex-oauth.js)
//   POST           /api/codex/oauth/login
//   GET|HEAD       /api/commandcode/auth/status              (commandcode-auth.js)
//   POST           /api/commandcode/auth/login
//
// 路径匹配、参数解码、Express 自动 OPTIONS、主机不可达/未知 op 的错误形状在
// native/gateway/src/app/account_routes.rs 与 native/core/src/account_routes.rs。
//
// 这里只剩 Node 独有的运行时事实：钥匙串与 ~/.codex/auth.json / ~/.claude 凭据、
// PKCE 登录状态机与回调监听器、交互式登录终端、桌面端 API key 同步、CLI 配置
// 落盘、以及把账号仓库投影成「绝不含 token / refresh_token / api key / cookie /
// password」的公开 DTO。前门原样回放 `{ status, body }`，所以脱敏只有这一份实现，
// 也不会因为迁移而放宽或改变任何一个字节。
//
// 两条阻塞式路由不在本端口：`POST /api/zcode/auth/login` 与
// `POST /api/kimi/auth/login` 最长阻塞 5 分钟等子进程退出，超出宿主端口 60 秒上限。
// 它们连同各自的 login-only 公开挂载留在 Node，前门整条转发（含自动 OPTIONS）。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求。

const HOST_PATH = '/api/__host/account-routes';

/** Marker meaning "this op has no handler to run it" -> unknown operation. */
const UNKNOWN = Symbol('unknown');

// 每个 op 指向退休模块注册的那一对 (method, 路径模板)。参数直接由前门解好的
// `id` / `cli` 组装 —— 路径匹配与解码是 Rust 的活，这里不再匹配第二遍。
const OPS = {
  'claude-accounts-list': { method: 'GET', path: '/api/claude/accounts', params: [] },
  'claude-accounts-create': { method: 'POST', path: '/api/claude/accounts', params: [] },
  'claude-account-activate': { method: 'POST', path: '/api/claude/accounts/:id/activate', params: ['id'] },
  'claude-account-login-status': { method: 'GET', path: '/api/claude/accounts/:id/login-status', params: ['id'] },
  'claude-account-login-callback': { method: 'POST', path: '/api/claude/accounts/:id/login-callback', params: ['id'] },
  'claude-account-relogin': { method: 'POST', path: '/api/claude/accounts/:id/relogin', params: ['id'] },
  'claude-account-delete': { method: 'DELETE', path: '/api/claude/accounts/:id', params: ['id'] },
  'claude-account-quota': { method: 'GET', path: '/api/claude/accounts/:id/quota', params: ['id'] },
  'codex-accounts-list': { method: 'GET', path: '/api/codex/accounts', params: [] },
  'codex-accounts-create': { method: 'POST', path: '/api/codex/accounts', params: [] },
  'codex-account-activate': { method: 'POST', path: '/api/codex/accounts/:id/activate', params: ['id'] },
  'codex-account-login-status': { method: 'GET', path: '/api/codex/accounts/:id/login-status', params: ['id'] },
  'codex-account-login-callback': { method: 'POST', path: '/api/codex/accounts/:id/login-callback', params: ['id'] },
  'codex-account-relogin': { method: 'POST', path: '/api/codex/accounts/:id/relogin', params: ['id'] },
  'codex-account-delete': { method: 'DELETE', path: '/api/codex/accounts/:id', params: ['id'] },
  'zcode-auth-status': { method: 'GET', path: '/api/zcode/auth', params: [] },
  'zcode-auth-sync': { method: 'POST', path: '/api/zcode/auth/sync', params: [] },
  'zcode-auth-put': { method: 'PUT', path: '/api/zcode/auth', params: [] },
  'zcode-auth-check': { method: 'GET', path: '/api/zcode/auth/check', params: [] },
  'cli-accounts-list': { method: 'GET', path: '/api/cli-accounts/:cli', params: ['cli'] },
  'cli-accounts-create': { method: 'POST', path: '/api/cli-accounts/:cli', params: ['cli'] },
  'cli-account-patch': { method: 'PATCH', path: '/api/cli-accounts/:cli/:id', params: ['cli', 'id'] },
  'cli-account-delete': { method: 'DELETE', path: '/api/cli-accounts/:cli/:id', params: ['cli', 'id'] },
  'kimi-auth-status': { method: 'GET', path: '/api/kimi/auth', params: [] },
  'kimi-auth-check': { method: 'GET', path: '/api/kimi/auth/check', params: [] },
  'kimi-auth-put': { method: 'PUT', path: '/api/kimi/auth', params: [] },
  'claude-oauth-status': { method: 'GET', path: '/api/claude/oauth/status', params: [] },
  'claude-oauth-login': { method: 'POST', path: '/api/claude/oauth/login', params: [] },
  'codex-oauth-status': { method: 'GET', path: '/api/codex/oauth/status', params: [] },
  'codex-oauth-login': { method: 'POST', path: '/api/codex/oauth/login', params: [] },
  'commandcode-auth-status': { method: 'GET', path: '/api/commandcode/auth/status', params: [] },
  'commandcode-auth-login': { method: 'POST', path: '/api/commandcode/auth/login', params: [] },
};

/** 一个只记录路由的 Express 替身：八个模块在它上面注册，按 (method, 模板) 取用。 */
function createCaptureApp(handlers) {
  const record = method => (path, ...args) => {
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
      // 退休的 JSON 路由不设自定义响应头。
      set() { return res; },
      setHeader() { return res; },
      type() { return res; },
    };
    // 处理器里有 async 的（quota 探测、创建账号、OAuth login、状态轮询）：
    // 成功时由 res.json 收尾，拒绝时走 next(err) —— 与 asyncHandler 一致。
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
    query: {},
    // 退休处理器直接读 `req.body.providerId`（zcode/kimi PUT），所以这里必须
    // 原样给出 body-parser 会留下的值：无体时是 `{}`，JSON `null` 时是 `null`。
    body: body.body === undefined ? {} : body.body,
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
 * 建一个捕获应用；八个退休模块在它上面 `mountRoutes`。`mountRoute` 再把唯一的
 * 宿主端点挂到真实的 Express app 上。
 */
function createAccountRoutesHost() {
  const handlers = new Map();
  const app = createCaptureApp(handlers);
  function mountRoute(expressApp, options = {}) {
    if (!expressApp || typeof expressApp.post !== 'function') {
      throw new TypeError('[account-routes-host] Express app is required');
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
            console.error(`[account-routes-host] ${body.op} failed: ${error?.message || error}`);
            return res.status(500).json({ error: 'internal_error' });
          },
        );
    });
  }
  return { app, mountRoute };
}

module.exports = { HOST_PATH, OPS, createAccountRoutesHost };
