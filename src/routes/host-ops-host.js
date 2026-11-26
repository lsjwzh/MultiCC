'use strict';

// 宿主端口：宿主与系统操作 40 条公开路由（原本分散在十个文件里）已由 Rust
// 前门独占。
//
//   POST                 /api/restart, /api/desktop-shutdown   (server-restart-route.js)
//   GET|HEAD             /api/update/status                     (update-route.js)
//   POST                 /api/update
//   GET|HEAD             /api/system/developer-tools            (developer-tools.js)
//   POST                 /api/system/developer-tools/install
//   GET|HEAD             /api/system/developer-tools/install-git
//   POST                 /api/system/developer-tools/install-git
//   GET|HEAD             /api/system/disk-access                (macos-privacy.js)
//   POST                 /api/system/disk-access/open
//   GET|HEAD             /api/system/agent-permissions
//   POST                 /api/system/agent-permissions/open
//   POST                 /api/system/agent-permissions/restart
//   GET|HEAD             /api/system/agent-install
//   POST                 /api/system/agent-install/replace
//   GET|HEAD             /api/system/ops-env                    (ops-terminal.js)
//   GET|HEAD|POST        /api/system/ops-run
//   POST                 /api/system/ops-run/stop
//   POST                 /api/settings/notify                   (host-write.js)
//   POST                 /api/settings/tunnel
//   POST                 /api/tunnel/restart/:provider
//   POST                 /api/tunnel/sakurafrp/public-url
//   POST                 /api/tunnel/funnel
//   POST                 /api/settings/access-token
//   POST                 /api/settings/power                    (host-power.js)
//   POST                 /api/settings/power/auto-unlock
//   POST|DELETE          /api/settings/power/unlock-password
//   POST                 /api/settings/power/unlock-password/authorize
//   POST                 /api/settings/task-attribution
//   GET|HEAD             /api/skill-sync/status                 (skill-sync.js)
//   POST                 /api/skill-sync/run
//   POST                 /api/system/env-doctor                 (env-doctor.js)
//   GET|HEAD             /api/system/env-doctor/:runId
//   POST                 /api/system/env-doctor/:runId/cancel
//   POST                 /api/sessions/:id/doctor               (doctor.js)
//   GET|HEAD             /api/sessions/:id/doctor
//   GET|HEAD             /api/doctor/runs/:runId
//   POST                 /api/doctor/runs/:runId/cancel
//
// 路径匹配、参数解码、查询/请求体读取、Express 自动 OPTIONS、会话准入守卫、
// 主机不可达/未知 op 的错误形状都在 native/gateway/src/app/host_ops_routes.rs
// 与 native/core/src/host_ops_routes.rs。
//
// 这里只剩 Node 独有的运行时事实与副作用：分离式重启/自更新启动器
// （src/server-restart.js、src/update-runner.js）、Xcode/Git 工具链探测、macOS
// TCC 与电源服务、Agent 安装器、shell 环境探测与修复终端、.env 写入器与
// tunnel/push 运行时、skill sync 运行时、doctor 与环境 doctor 服务。
//
// 诊断服务只接收一个参数并返回执行结果。其余处理器按退休时的样子写 `res.set/status/json/send`；这里的捕获器把它们变成
// `{ status, body, headers }`，前门原样回放 —— 两边不会各自长出第二套状态码、
// 头或键序规则。
//
// 本机判定（`isLocal(req)`）由前门按真实客户端地址决定并作为 `local` 事实传进来：
// 宿主端口自己看到的是前门的内网回环连接，不能用来判定。macos-privacy 的内部
// 检查读 `req.socket.remoteAddress`，所以这里按事实构造 socket；host-write /
// host-power 走注入的 `isLocalRequest`。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求。

const HOST_PATH = '/api/__host/host-ops';

/** Marker meaning "this op has no handler to run it" -> unknown operation. */
const UNKNOWN = Symbol('unknown');

// 每个 op 指向退休模块注册的那一对 (method, 路径模板)。参数由前门解好后直接塞进
// `req.params` —— 路径匹配与解码是 Rust 的活，这里不再匹配第二遍。
const OPS = {
  'restart': { method: 'POST', path: '/api/restart', params: [] },
  'desktop-shutdown': { method: 'POST', path: '/api/desktop-shutdown', params: [] },
  'update-status': { method: 'GET', path: '/api/update/status', params: [] },
  'update': { method: 'POST', path: '/api/update', params: [] },
  'developer-tools-status': { method: 'GET', path: '/api/system/developer-tools', params: [] },
  'developer-tools-install': { method: 'POST', path: '/api/system/developer-tools/install', params: [] },
  'developer-tools-install-git-status': { method: 'GET', path: '/api/system/developer-tools/install-git', params: [] },
  'developer-tools-install-git': { method: 'POST', path: '/api/system/developer-tools/install-git', params: [] },
  'disk-access': { method: 'GET', path: '/api/system/disk-access', params: [] },
  'disk-access-open': { method: 'POST', path: '/api/system/disk-access/open', params: [] },
  'agent-permissions': { method: 'GET', path: '/api/system/agent-permissions', params: [] },
  'agent-permissions-open': { method: 'POST', path: '/api/system/agent-permissions/open', params: [] },
  'agent-permissions-restart': { method: 'POST', path: '/api/system/agent-permissions/restart', params: [] },
  'agent-install': { method: 'GET', path: '/api/system/agent-install', params: [] },
  'agent-install-replace': { method: 'POST', path: '/api/system/agent-install/replace', params: [] },
  'ops-env': { method: 'GET', path: '/api/system/ops-env', params: [] },
  'ops-run-status': { method: 'GET', path: '/api/system/ops-run', params: [] },
  'ops-run-start': { method: 'POST', path: '/api/system/ops-run', params: [] },
  'ops-run-stop': { method: 'POST', path: '/api/system/ops-run/stop', params: [] },
  'settings-notify': { method: 'POST', path: '/api/settings/notify', params: [] },
  'settings-tunnel': { method: 'POST', path: '/api/settings/tunnel', params: [] },
  'tunnel-restart': { method: 'POST', path: '/api/tunnel/restart/:provider', params: ['provider'] },
  'tunnel-sakurafrp-public-url': { method: 'POST', path: '/api/tunnel/sakurafrp/public-url', params: [] },
  'tunnel-funnel': { method: 'POST', path: '/api/tunnel/funnel', params: [] },
  'settings-access-token': { method: 'POST', path: '/api/settings/access-token', params: [] },
  'settings-power': { method: 'POST', path: '/api/settings/power', params: [] },
  'settings-power-auto-unlock': { method: 'POST', path: '/api/settings/power/auto-unlock', params: [] },
  'settings-power-unlock-password-set': { method: 'POST', path: '/api/settings/power/unlock-password', params: [] },
  'settings-power-unlock-password-clear': { method: 'DELETE', path: '/api/settings/power/unlock-password', params: [] },
  'settings-power-unlock-password-authorize': { method: 'POST', path: '/api/settings/power/unlock-password/authorize', params: [] },
  'settings-task-attribution': { method: 'POST', path: '/api/settings/task-attribution', params: [] },
  'skill-sync-status': { method: 'GET', path: '/api/skill-sync/status', params: [] },
  'skill-sync-run': { method: 'POST', path: '/api/skill-sync/run', params: [] },
};

/** 一个只记录路由的 Express 替身：十个模块在它上面注册，按 (method, 模板) 取用。 */
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

/** `res.type(value)` 的 Content-Type（-types 查表 + charset）。当前无人使用。 */
function contentTypeOf(value) {
  const text = String(value || '');
  if (text === 'html' || text === 'text/html') return 'text/html; charset=utf-8';
  if (text.startsWith('text/') && !text.includes('charset=')) return `${text}; charset=utf-8`;
  return text;
}

/** `res` 当作退休处理器使用：它们渲染，我们取走状态码、正文与响应头。 */
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
        if (Buffer.isBuffer(body)) throw new Error('host-ops host does not relay binary bodies');
        reply.body = body === undefined ? null : body;
        finish();
        return res;
      },
      end(body) {
        if (body === undefined) reply.bare = true;
        else reply.body = body;
        finish();
        return res;
      },
    };
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

async function invoke(handlers, doctorOperations, body) {
  // The gateway supplies the single argument used by the live service.
  if (doctorOperations.has(body.op)) {
    try {
      return { result: await doctorOperations.get(body.op)(body.input) };
    } catch (error) {
      console.error(`[host-ops-host] ${body.op} threw: ${error?.stack || error}`);
      return thrownEnvelope(error);
    }
  }
  if (!Object.hasOwn(OPS, body.op)) return UNKNOWN;
  const spec = OPS[body.op];
  const handler = handlers.get(`${spec.method} ${spec.path}`);
  if (typeof handler !== 'function') return UNKNOWN;
  const params = {};
  for (const name of spec.params) params[name] = body[name];
  const headers = body.headers && typeof body.headers === 'object' ? body.headers : {};
  const local = body.local === true;
  const req = {
    method: spec.method,
    path: spec.path,
    originalUrl: typeof body.originalUrl === 'string' ? body.originalUrl : spec.path,
    params,
    query: body.query && typeof body.query === 'object' ? body.query : {},
    body: body.body === undefined ? null : body.body,
    headers,
    protocol: 'http',
    // 前门按真实客户端地址判定；宿主端口看到的永远是回环。
    local,
    socket: { remoteAddress: local ? '127.0.0.1' : '203.0.113.9' },
    id: typeof body.requestId === 'string' ? body.requestId : undefined,
    get(name) { return headers[String(name).toLowerCase()]; },
  };
  try {
    const reply = await runHandler(handler, req);
    if (body.op === 'update-status') {
      // The UTF-16 log window can end inside a surrogate pair. Carry the
      // serialized JSON through the host port so the gateway preserves it.
      return { ...reply, body: JSON.stringify(reply.body), contentType: 'application/json; charset=utf-8' };
    }
    return reply;
  } catch (error) {
    console.error(`[host-ops-host] ${body.op} threw: ${error?.stack || error}`);
    return thrownEnvelope(error);
  }
}

/**
 * 建一个捕获应用；十个退休模块在它上面按退休时的顺序 `mount`。`mountRoute` 再把
 * 唯一的宿主端点挂到真实的 Express app 上。
 *
 * `deps.developerTools` / `deps.macosPrivacy` / `deps.opsTerminal` 是可选注入
 * （测试用）；生产留空即走模块默认值。`deps.serverRestart` / `deps.update` 是
 * 已构造好的路由对象（分离式启动器在它们里面），`deps.hostWrite`、`deps.skillSync`、
 * `deps.envDoctor`、`deps.doctor` 是各自的运行时。
 */
function createHostOpsHost(deps = {}) {
  const { express, serverRestart, update, hostWrite, skillSync, envDoctor, doctor } = deps;
  if (!express || typeof express.json !== 'function') {
    throw new TypeError('[host-ops-host] express is required');
  }
  for (const [name, value] of Object.entries({ serverRestart, update })) {
    if (!value || typeof value.mountRoutes !== 'function') {
      throw new TypeError(`[host-ops-host] ${name} route runtime is required`);
    }
  }
  if (!hostWrite || typeof hostWrite !== 'object') {
    throw new TypeError('[host-ops-host] host write dependencies are required');
  }
  if (!skillSync || typeof skillSync !== 'object') {
    throw new TypeError('[host-ops-host] skill sync runtime is required');
  }
  if (!envDoctor || !doctor) {
    throw new TypeError('[host-ops-host] doctor services are required');
  }
  const handlers = new Map();
  const app = createCaptureApp(handlers);
  // 原挂载顺序（server.js）：restart、update、system（developer-tools →
  // macos-privacy → ops-terminal）、host-write（内含 host-power）、skill-sync。
  serverRestart.mountRoutes(app);
  update.mountRoutes(app);
  require('./developer-tools').createDeveloperToolsRoutes(deps.developerTools || {}).mountRoutes(app);
  require('./macos-privacy').createMacosPrivacyRoutes(deps.macosPrivacy || {}).mountRoutes(app);
  require('./ops-terminal').createOpsTerminalRoutes(deps.opsTerminal || {}).mountRoutes(app);
  // 前门按真实客户端地址判定本机，并作为 `req.local` 事实传进来；宿主端口自己
  // 看到的是前门的内网回环连接，真实的 isLocalRequest 在这里永远误判。
  require('./host-write').mountHostWriteRoutes(app, { ...hostWrite, isLocalRequest: req => req.local === true });
  mountSkillSyncRoutes(app, skillSync);
  const doctorOperations = new Map([
    ['env-doctor-start', input => envDoctor.start(input)],
    ['env-doctor-run', runId => envDoctor.get(runId)],
    ['env-doctor-cancel', runId => envDoctor.cancel(runId)],
    ['session-doctor-start', input => doctor.start(input)],
    ['session-doctor-list', id => doctor.list(id)],
    ['doctor-run', runId => doctor.get(runId)],
    ['doctor-cancel', runId => doctor.cancel(runId)],
  ]);

  function mountRoute(expressApp, options = {}) {
    if (!expressApp || typeof expressApp.post !== 'function') {
      throw new TypeError('[host-ops-host] Express app is required');
    }
    const isLocal = options.isLocal || require('../request-locality').isLocalRequest;
    expressApp.post(HOST_PATH, (req, res) => {
      // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
      if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
      const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
        ? req.body : {};
      return Promise.resolve()
        .then(() => invoke(handlers, doctorOperations, body))
        .then(
          (value) => {
            if (value === UNKNOWN) return res.status(400).json({ error: 'unknown host operation' });
            return res.json({ ok: true, value: value === undefined ? null : value });
          },
          (error) => {
            console.error(`[host-ops-host] ${body.op} failed: ${error?.message || error}`);
            return res.status(500).json({ error: 'internal_error' });
          },
        );
    });
  }
  return { app, handlers, mountRoute };
}

function mountSkillSyncRoutes(app, runtime) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new TypeError('skill sync routes require Express get/post');
  }
  for (const key of ['getStatus', 'runNow']) {
    if (!runtime || typeof runtime[key] !== 'function') throw new TypeError(`skill sync runtime missing: ${key}`);
  }
  const { getNative } = require('../native/runtime');
  const { sanitizePublicText } = require('../native/runtime').getPublicSafety();
  const handle = run => (_req, res) => getNative().skillSyncResponse(runtime, res, run, sanitizePublicText);
  app.get('/api/skill-sync/status', handle(false));
  app.post('/api/skill-sync/run', handle(true));
}

module.exports = { HOST_PATH, OPS, mountSkillSyncRoutes, createHostOpsHost, createCaptureApp, runHandler, thrownEnvelope };
