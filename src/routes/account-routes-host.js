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

const { getNative } = require('../native/runtime');
const { isKeyAccountCli, releaseCliAccountReferences } = require('../cli-key-accounts');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const CODEX_LOGIN_SESSION_ID = 'codex-login';
const AGY_LOGIN_FLOW = 'agy-login';

function readCommandcodeLogin({ home = os.homedir(), env = process.env } = {}) {
  return getNative().commandcodeLoginStatus(env, suffix =>
    fs.readFileSync(path.join(home, '.commandcode', suffix), 'utf8'));
}

function mountCommandcodeAuthRoutes(app, deps) {
  const { directories, createSessionRecord, disposeLoginTerminal = async () => 0, getStatus = readCommandcodeLogin } = deps;
  app.get('/api/commandcode/auth/status', (_req, res) => { res.json({ ok: true, ...getStatus() }); });
  app.post('/api/commandcode/auth/login', async (_req, res) => {
    try {
      const native = getNative(), dir = native.loginTerminalDirectory(directories, true);
      if (!dir) return res.status(409).json({ ok: false, error: '请先添加一个项目目录，再打开登录终端。' });
      await disposeLoginTerminal('commandcode-login');
      const result = await createSessionRecord(native.loginTerminalRecord('commandcode', dir, undefined));
      return native.loginTerminalResult('commandcode', result, res);
    } catch { res.status(500).json({ ok: false, error: '无法打开 Command Code 登录终端。' }); }
  });
}

function createLoginSessionOpener(deps) {
  const { directories, createSessionRecord, disposeLoginTerminal = async () => 0 } = deps;
  return async function openCodexLoginSession() {
    const native = getNative(), dir = native.loginTerminalDirectory(directories, false);
    if (!dir) return { ok: false, error: 'no directory available' };
    await disposeLoginTerminal(CODEX_LOGIN_SESSION_ID);
    const result = await createSessionRecord(native.loginTerminalRecord('codex', dir, undefined));
    return native.loginTerminalResult('codex', result, undefined);
  };
}

function mountCodexOAuthRoutes(app, deps) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new TypeError('[codex-oauth] Express-compatible app is required');
  if (!deps || typeof deps.getStatus !== 'function') throw new TypeError('[codex-oauth] getStatus is required');
  const open = typeof deps.openLoginSession === 'function' ? deps.openLoginSession : createLoginSessionOpener(deps);
  app.get('/api/codex/oauth/status', (_req, res) => { res.json(getNative().codexLoginStatus(deps.getStatus())); });
  app.post('/api/codex/oauth/login', async (_req, res) => {
    try {
      const result = await open();
      if (!result || !result.ok) return res.status(500).json({ ok: false, error: (result && result.error) || 'login session unavailable' });
      return res.json({ ok: true, sessionId: result.sessionId, reused: !!result.reused,
        hint: '在打开的终端里完成浏览器登录，登录后 multicc 会自动恢复' });
    } catch (error) { return res.status(500).json({ ok: false, error: error.message }); }
  });
}

function mountAgyAccountRoutes(app, rawDeps) {
  if (!app || typeof app.post !== 'function') throw new TypeError('[agy-accounts] Express-compatible app is required');
  const deps = rawDeps || {};
  const { directories, createSessionRecord } = deps;
  if (typeof createSessionRecord !== 'function') throw new TypeError('[agy-accounts] createSessionRecord is required');
  const wrap = typeof deps.asyncHandler === 'function' ? deps.asyncHandler : fn => fn;
  const dispose = typeof deps.disposeLoginTerminal === 'function' ? deps.disposeLoginTerminal : async () => 0;
  app.post('/api/agy/accounts/:id/login-terminal', wrap(async (req, res) => {
    const home = String((req.body && req.body.home) || '');
    if (!home) return res.status(400).json({ error: 'account home required' });
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const native = getNative(), dir = native.loginTerminalDirectory(directories, false);
    if (!dir) return res.status(500).json({ error: 'no directory available' });
    const loginEnv = native.agyLoginEnvironment(home, req);
    await dispose(AGY_LOGIN_FLOW);
    const result = await createSessionRecord(native.loginTerminalRecord('agy', dir, loginEnv));
    return native.loginTerminalResult('agy', result, res);
  }));
}

function mountCliKeyAccountRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function') throw new TypeError('[cli-key-accounts] Express-compatible app is required');
  const { store, sessionPersistence } = deps;
  if (!store || typeof store.list !== 'function') throw new TypeError('[cli-key-accounts] deps.store is required');
  if (!sessionPersistence || typeof sessionPersistence.mutate !== 'function') {
    throw new TypeError('[cli-key-accounts] deps.sessionPersistence (with mutate) is required');
  }
  const release = (cli, id) => sessionPersistence.mutate('http.cli-account-delete',
    records => releaseCliAccountReferences(records, cli, id));
  const handler = action => (req, res) => getNative().cliAccountResponse(action, store, isKeyAccountCli, release, req, res);
  app.get('/api/cli-accounts/:cli', handler('list'));
  app.post('/api/cli-accounts/:cli', handler('create'));
  app.patch('/api/cli-accounts/:cli/:id', handler('update'));
  app.delete('/api/cli-accounts/:cli/:id', handler('delete'));
}

module.exports = {
  HOST_PATH, OPS, createAccountRoutesHost, mountCliKeyAccountRoutes, readCommandcodeLogin, mountCommandcodeAuthRoutes,
  mountCodexOAuthRoutes, createLoginSessionOpener, CODEX_LOGIN_SESSION_ID,
  mountAgyAccountRoutes, AGY_LOGIN_FLOW, AGY_LOGIN_SESSION_ID: AGY_LOGIN_FLOW,
};
