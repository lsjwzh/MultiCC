'use strict';

// 宿主端口（host port）：只读主机路由已经由 Rust 前门（multicc-gateway，
// native/gateway/src/app/host_read.rs）独占，原 src/routes/host-read.js 的 10 条
// GET 已删除：
//
//   GET /api/push/vapid-key          GET /api/settings/tunnel
//   GET /api/push/health             GET /api/tunnel/funnel
//   GET /api/settings/notify         GET /api/tunnel/ipv6
//   GET /api/settings/access-token   GET /api/tunnel/sakurafrp
//   GET /api/settings/power          GET /api/host/battery
//
// 路由匹配、推送健康 DTO（失败分类、端点指纹）、通知地址掩码、access-token
// 掩码、canEdit 的本地性判定与错误映射都在 Rust。这里只剩 Rust 看不到的 Node
// 运行时事实：push 的进程内 Map 与配置、tunnel 客户端（会 shell / 探网络）、
// macOS 电源服务和电量探针缓存。
//
// 读侧只回原料，不回最终响应：push 回 endpoints/health/size/globalStats 等，
// notify 回原始 URL，Rust 负责掩码与字段顺序。任何抛错都回 { ok:false,
// status, code, safeMessage, detail }，前门据此复刻 safeErrorHandler。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求（docs/gateway.md 的内网端口模型）。

const { isLocalRequest } = require('../request-locality');
const { readPowerSettings } = require('../host-power-services');
const { createBatteryReader } = require('../host-battery');

const HOST_PATH = '/api/__host/host-read';

function describeError(error) {
  const status = Number.isInteger(error && error.status) && error.status >= 400 && error.status < 600
    ? error.status
    : 500;
  return {
    ok: false,
    status,
    code: error && typeof error.code === 'string' ? error.code : null,
    safeMessage: error && error.safe && typeof error.message === 'string' ? error.message : null,
    detail: (error && (error.message || String(error))) || 'host read operation failed',
  };
}

function createHostReadHost(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('[host-read-host] dependencies are required');
  }
  const deps = options;
  for (const name of ['getVapidPublicKey', 'getAccessToken']) {
    if (typeof deps[name] !== 'function') {
      throw new TypeError(`[host-read-host] dependency missing: ${name}`);
    }
  }
  if (!deps.push || !deps.tunnel || !deps.macosPower) {
    throw new TypeError('[host-read-host] service dependencies are required');
  }
  const readBattery = typeof deps.readBattery === 'function' ? deps.readBattery : createBatteryReader();

  return async function handle(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
    const op = typeof body.op === 'string' ? body.op : '';
    const push = deps.push;
    try {
      switch (op) {
        case 'vapid-key':
          return { ok: true, payload: deps.getVapidPublicKey() };
        case 'push-health': {
          const endpoints = [];
          const health = [];
          for (const [endpoint] of push.subscriptions) {
            endpoints.push(endpoint);
            health.push(push.healthStats.get(endpoint) || null);
          }
          return {
            ok: true,
            payload: {
              endpoints,
              health,
              size: push.subscriptions.size,
              globalStats: push.globalStats,
              barkConfigured: push.hasBarkDevices ? push.hasBarkDevices() : !!push.cfg.BARK_URL,
              barkHealth: push.barkHealth,
              webhookConfigured: !!push.cfg.WEBHOOK_URL,
              webhookHealth: push.webhookHealth,
            },
          };
        }
        case 'notify': {
          const barkUrl = push.cfg.BARK_URL;
          return {
            ok: true,
            payload: {
              barkUrl,
              webhookUrl: push.cfg.WEBHOOK_URL,
              hasBark: push.hasBarkDevices
                ? push.hasBarkDevices()
                : (typeof barkUrl === 'string' && barkUrl.length > 0),
              ...(push.barkDevices ? { barkDevices: push.barkDevices.list() } : {}),
            },
          };
        }
        case 'tunnel':
          return { ok: true, payload: deps.tunnel.getStatus() };
        case 'funnel':
          return { ok: true, payload: await deps.tunnel.funnelStatus() };
        case 'ipv6':
          return { ok: true, payload: await deps.tunnel.ipv6Status() };
        case 'sakurafrp':
          return { ok: true, payload: await deps.tunnel.sakuraAccess() };
        case 'access-token':
          return { ok: true, payload: { token: deps.getAccessToken() || '' } };
        case 'power':
          // canEdit 由前门依据真实客户端地址判定；宿主端口自己永远是回环。
          return {
            ok: true,
            payload: await readPowerSettings(
              { ...deps, isLocalRequest: () => body.canEdit === true },
              {},
            ),
          };
        case 'battery':
          return { ok: true, payload: await readBattery() };
        default:
          return { ok: false };
      }
    } catch (error) {
      return describeError(error);
    }
  };
}

function mountHostReadHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[host-read-host] Express-compatible app is required');
  }
  const isLocal = typeof options.isLocal === 'function' ? options.isLocal : isLocalRequest;
  const handle = createHostReadHost(options);
  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    Promise.resolve(handle(req.body)).then(
      answer => res.json(answer),
      error => res.status(500).json({ error: 'host read failed', detail: String(error && error.message || error) }),
    );
  });
}

module.exports = { mountHostReadHostRoute, createHostReadHost, HOST_PATH };
