'use strict';

// 宿主端口（host port）：GET /api/token-usage/by-role 这条公开路由已经由 Rust 前门
// （multicc-gateway，native/gateway/src/app/token_usage_by_role.rs）独占。查询参数的
// 解析、空快照形状、错误码映射与响应序列化都在 Rust；这里只剩 Node 独有的角色用量
// 事实：进程内 RoleTokenTracker 的 snapshot 与持久 ledger 的读取。
//
// snapshot 对未知会话必须回固定空对象（main/sub 为 null，subByProvider 为空数组），
// ledger 直接透传 readLedger() 的结果。任何读取失败都只回 { ok: false }，既不打 500
// 也不把错误文本带出去（前门据此继续返回 PUBLIC_USAGE_ERROR）。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求（docs/gateway.md 的内网端口模型）。

const { isLocalRequest } = require('../request-locality');

const HOST_PATH = '/api/__host/token-usage';

const EMPTY_ROLE_SNAPSHOT = Object.freeze({
  main: null,
  sub: null,
  subByProvider: Object.freeze([]),
});

function createTokenUsageHost(options) {
  if (!options || !options.tracker) {
    throw new TypeError('[token-usage-host] tracker is required');
  }
  const tracker = options.tracker;
  const logFailure = typeof options.logFailure === 'function' ? options.logFailure : null;

  return function handle(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
    const op = typeof body.op === 'string' ? body.op : '';
    try {
      if (op === 'snapshot') {
        return { ok: true, payload: tracker.snapshot(body.session) || EMPTY_ROLE_SNAPSHOT };
      }
      if (op === 'ledger') {
        return { ok: true, payload: tracker.readLedger() };
      }
    } catch (error) {
      if (logFailure) logFailure('token_usage_role_read_failed', error);
      return { ok: false };
    }
    return { ok: false };
  };
}

function mountTokenUsageHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[token-usage-host] Express-compatible app is required');
  }
  if (!options.tracker) throw new TypeError('[token-usage-host] tracker is required');
  const isLocal = options.isLocal || isLocalRequest;
  const handle = createTokenUsageHost(options);
  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    res.json(handle(req.body));
  });
}

module.exports = { mountTokenUsageHostRoute, createTokenUsageHost, HOST_PATH, EMPTY_ROLE_SNAPSHOT };
