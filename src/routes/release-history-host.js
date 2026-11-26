'use strict';

// 宿主端口：发布资产、iOS OTA 与聊天历史的 11 条公开路由已由 Rust 前门独占。
//
//   GET|HEAD  /api/apk-info                          (routes/system.js)
//   GET|HEAD  /api/ios-ota-info
//   GET|HEAD  /ios-ota/manifest.plist
//   GET|HEAD  /ios-ota/udid.mobileconfig             (ios-udid.js)
//   GET|HEAD  /ios-ota/udid/result/:token
//   POST      /ios-ota/udid/callback/:token
//   DELETE    /api/sessions/:id/messages/:msgId      (routes/chat-history.js)
//   GET|HEAD  /api/sessions/:id/history
//   GET|HEAD  /api/sessions/:id/context-level
//   GET|HEAD  /                                      (routes/static-assets.js)
//   GET|HEAD  /multicc.apk                           (routes/system.js)
//
// 路径匹配、参数解码、查询子集、Express 自动 OPTIONS、会话准入守卫（内部执行
// 槽）、鉴权豁免、设备回传的 express.raw 分帧与限额都在
// native/gateway/src/app/release_history_routes.rs 与
// native/core/src/release_history_routes.rs。`GET /` 整条在前门答完（一次重定向
// 决策，不需要任何宿主事实），所以它没有 op。
//
// 这里只剩 Node 独有的事实与副作用：APK/IPA 随包文件读取、GitHub 发布查询、manifest 与
// .mobileconfig 渲染、一次性 UDID 令牌表与 `openssl cms` 校验、会话记录表、
// 聊天记录存储与原生历史运行时。
//
// `GET /multicc.apk` 的三种出口里只有两种自己写响应：可用的本地
// `public/multicc.apk` 走 `next()` 落到 express.static 的流式 sendFile，已核验的
// 发布走 302，其余状态是带 `Cache-Control: no-store` 的空 404。那个 static 挂载
// 现在是前门的 `static_web_root`，所以这条路由也迁了过来：`next()` 被捕获成
// `fellThrough`，前门用同一套引擎把本地文件发出去。
//
// 处理器仍按退休时的样子写 `res.set/status/type/json/send/end/sendStatus`；这里
// 的捕获器把它们变成 `{ status, body, contentType, bare, headers }`，前门原样
// 回放 —— 两边不会各自长出第二套状态码、头或键序规则。
//
// 本机判定由前门按真实客户端地址决定并作为 `local` 事实传进来：宿主端口自己看到
// 的是前门的回环连接，真实的 isLocalRequest 在这里永远误判。本簇目前没有
// local-only 路由，但事实照样传，省得以后有人在这里重新发明判定。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求。

const { STATUS_CODES } = require('node:http');
const { getNative } = require('../native/binding');

function createApkInfoHandler(deps) {
  return async function apkInfoHandler(req, res, next) {
    try { res.json(await getNative().releaseAssetApkInfo(deps)); }
    catch (error) { next(error); }
  };
}
function createIosOtaInfoHandler(deps) { return getNative().releaseAssetIosHandler(deps); }
const assetPorts = { createApkInfoHandler, createIosOtaInfoHandler,
  createIosUdid: () => require('../ios-udid').createIosUdid() };
function mountSystemHostRoutes(app, deps) { getNative().releaseAssetMount(app, deps, assetPorts, false); }
function mountApkDownload(app, deps) { getNative().releaseAssetMount(app, deps, assetPorts, true); }

const HOST_PATH = '/api/__host/release-history';

/** Marker meaning "this op has no handler to run it" -> unknown operation. */
const UNKNOWN = Symbol('unknown');

// 每个 op 指向退休模块注册的那一对 (method, 路径模板)。参数由前门解好后直接塞进
// `req.params` —— 路径匹配与解码是 Rust 的活，这里不再匹配第二遍。
const OPS = {
  'apk-info': { method: 'GET', path: '/api/apk-info', params: [] },
  'ios-ota-info': { method: 'GET', path: '/api/ios-ota-info', params: [] },
  'ios-ota-manifest': { method: 'GET', path: '/ios-ota/manifest.plist', params: [] },
  'udid-profile': { method: 'GET', path: '/ios-ota/udid.mobileconfig', params: [] },
  'udid-result': { method: 'GET', path: '/ios-ota/udid/result/:token', params: ['token'] },
  'udid-callback': { method: 'POST', path: '/ios-ota/udid/callback/:token', params: ['token'] },
  'message-delete': { method: 'DELETE', path: '/api/sessions/:id/messages/:msgId', params: ['id', 'msgId'] },
  'history': { method: 'GET', path: '/api/sessions/:id/history', params: ['id'] },
  'context-level': { method: 'GET', path: '/api/sessions/:id/context-level', params: ['id'] },
  'apk-download': { method: 'GET', path: '/multicc.apk', params: [] },
};

/** 一个只记录路由的 Express 替身：退休模块在它上面注册，按 (method, 模板) 取用。 */
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

// `res.type(ext)` 的扩展名查表，只含本簇用到的几个。带 `/` 的值按原样走
// `set('Content-Type')`，与 Express 一致。
const TYPE_LOOKUP = {
  text: 'text/plain',
  html: 'text/html',
  json: 'application/json',
  xml: 'text/xml',
};

const CHARSET_PRESENT = /;\s*charset\s*=/i;

/**
 * `res.set('Content-Type', value)` 的 charset 补齐：Express 只在值里还没有
 * charset 时补，且只对 `mime.charsets.lookup` 认的类型补（text/* 与
 * application/javascript|json）。`application/x-apple-aspen-config` 不补。
 */
function withCharset(value) {
  const text = String(value || '');
  if (CHARSET_PRESENT.test(text)) return text;
  const base = text.split(';')[0].trim().toLowerCase();
  if (/^text\//.test(base) || base === 'application/javascript' || base === 'application/json') {
    return `${text}; charset=utf-8`;
  }
  return text;
}

/** `res.type(value)` 的 Content-Type。 */
function contentTypeOf(value) {
  const text = String(value || '');
  const resolved = text.includes('/') ? text : (TYPE_LOOKUP[text] || text);
  return withCharset(resolved);
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
    // `set`/`setHeader` 里的 Content-Type 要落成 contentType（前门据此决定用
    // `express::send` 还是 `express::json`），不能混进普通头里 —— 否则正文会被
    // 当成 JSON 再序列化一次。
    const setHeader = (name, value) => {
      if (String(name).toLowerCase() === 'content-type') {
        reply.contentType = withCharset(value);
        return;
      }
      reply.headers.push([String(name), String(value)]);
    };
    const res = {
      headersSent: false,
      status(code) { reply.status = code; return res; },
      set(name, value) { setHeader(name, value); return res; },
      setHeader(name, value) { setHeader(name, value); return res; },
      type(value) { reply.contentType = contentTypeOf(value); return res; },
      json(body) { reply.body = body === undefined ? null : body; finish(); return res; },
      send(body) {
        if (Buffer.isBuffer(body)) throw new Error('release-history host does not relay binary bodies');
        reply.body = body === undefined ? null : body;
        // `res.send(string)` 对**已设的任何** Content-Type 补 charset，不看它的基础类型
        // （express/lib/response.js 的 `setCharset(type, 'utf-8')`）。`res.type()` 自己
        // 只给 text-ish 补，所以这一步必须留在 send 时点，不能并进 withCharset。
        if (typeof body === 'string' && reply.contentType && !CHARSET_PRESENT.test(reply.contentType)) {
          reply.contentType = `${reply.contentType}; charset=utf-8`;
        }
        finish();
        return res;
      },
      // Express: 状态文案作为 text/plain 正文发出。
      sendStatus(code) {
        reply.status = code;
        reply.contentType = contentTypeOf('text');
        reply.body = STATUS_CODES[code] || String(code);
        finish();
        return res;
      },
      end(body) {
        if (body === undefined) reply.bare = true;
        else reply.body = body;
        finish();
        return res;
      },
      // `res.redirect([status], url)`. Express's own body depends on the
      // caller's `Accept` (`res.format`), so only the decision travels; the
      // front door renders it with `express::redirect_status`.
      redirect(first, second) {
        const hasStatus = typeof first === 'number';
        reply.status = hasStatus ? first : 302;
        reply.redirect = { status: reply.status, location: String(hasStatus ? second : first) };
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
      // 退休处理器调 `next()` 等于"我不写响应，交给后面的中间件"。前门必须能分辨
      // 它和一次真正的 200，否则 `/multicc.apk` 的本地文件分支会变成空 200。
      reply.fellThrough = true;
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

/**
 * 设备回传的请求体状态。前门已经按 `express.raw({ type: () => true,
 * inflate: false, limit })` 的规则读好：
 *
 *   buffer  读到了字节          -> `req.body` 是 Buffer
 *   error   解析器拒绝          -> `req.rawBodyError` 是 413 / 400
 *   none    没有请求体可读      -> `req.body` 不设（退休路由的 400）
 *   parsed  全局 express.json 先吃掉了 -> `req.body` 是已解析值（非 Buffer，同样 400）
 */
function applyRawBody(req, state) {
  if (!state || typeof state !== 'object') return;
  if (state.kind === 'buffer') {
    req.body = Buffer.from(String(state.base64 || ''), 'base64');
    return;
  }
  if (state.kind === 'error') {
    req.rawBodyError = Number(state.status) || 400;
    return;
  }
  if (state.kind === 'parsed') {
    req.body = req.body === undefined ? null : req.body;
    return;
  }
  delete req.body;
}

async function invoke(handlers, body) {
  const spec = OPS[body.op];
  if (!spec) return UNKNOWN;
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
    // 内网明文端口上的 Express 没有 `trust proxy`，`req.protocol` 恒为 http；
    // absoluteBaseUrl 因此只认转发头（见 src/ios-ota.js 的同一条注释）。
    protocol: 'http',
    // 前门按真实客户端地址判定；宿主端口看到的永远是回环。
    local,
    socket: { remoteAddress: local ? '127.0.0.1' : '203.0.113.9' },
    id: typeof body.requestId === 'string' ? body.requestId : undefined,
    get(name) { return headers[String(name).toLowerCase()]; },
  };
  if (body.op === 'udid-callback') applyRawBody(req, body.rawBody);
  try {
    return await runHandler(handler, req);
  } catch (error) {
    console.error(`[release-history-host] ${body.op} threw: ${error?.stack || error}`);
    return thrownEnvelope(error);
  }
}

/**
 * 建一个捕获应用；退休模块在它上面按退休时的顺序 `mount`。`mountRoute` 再把唯一
 * 的宿主端点挂到真实的 Express app 上。
 *
 * `deps.chatHistory` 是已构造好的聊天历史运行时（`mountRoutes` 注册那三条）。
 * `deps.apkDistribution` / `deps.iosOta` 是发布资产运行时。`deps.iosUdid` 可选
 * 注入（测试用），生产留空即由 system.js 构造单例 —— UDID 的一次性令牌表必须
 * 跨请求存活，所以只能构造一次。
 */
function createReleaseHistoryHost(deps = {}) {
  const { chatHistory, apkDistribution, iosOta } = deps;
  if (!chatHistory || typeof chatHistory.mountRoutes !== 'function') {
    throw new TypeError('[release-history-host] chat history runtime is required');
  }
  if (!apkDistribution || !iosOta) {
    throw new TypeError('[release-history-host] release asset runtimes are required');
  }
  const handlers = new Map();
  const app = createCaptureApp(handlers);
  // 原挂载顺序（server.js）：system（含它挂的 UDID 三条）在前，chat-history 在后。
  // 顺序只影响 Express 的 Allow 并集，这里同样保留。
  mountSystemHostRoutes(app, {
    apkDistribution,
    iosOta,
    iosUdid: deps.iosUdid,
  });
  // 退休时它挂在真实 app 上（server.js），在 express.static 之前；那个 static
  // 挂载迁入前门后，这条路由只剩"本地文件 / 302 / 404"的判定，捕获在这里。
  mountApkDownload(app, { apkDistribution, iosOta });
  chatHistory.mountRoutes(app);

  function mountRoute(expressApp, options = {}) {
    if (!expressApp || typeof expressApp.post !== 'function') {
      throw new TypeError('[release-history-host] Express app is required');
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
            console.error(`[release-history-host] ${body.op} failed: ${error?.message || error}`);
            return res.status(500).json({ error: 'internal_error' });
          },
        );
    });
  }
  return { app, handlers, mountRoute };
}

module.exports = {
  createApkInfoHandler, createIosOtaInfoHandler, mountSystemHostRoutes, mountApkDownload,
  HOST_PATH,
  OPS,
  createReleaseHistoryHost,
  createCaptureApp,
  runHandler,
  thrownEnvelope,
  contentTypeOf,
  withCharset,
  applyRawBody,
};
