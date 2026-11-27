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

const { isLocalRequest } = require('../native/binding').requestLocality;
const { readPowerSettings } = require('./host-power');

const { getNative, createHostBatteryReader } = require('../native/binding');
const AGENT_RESOURCES_PATH = '/api/__host/agent-resources';
const SCAN_HISTORY_PATH = '/api/__host/scan-history';
const TOKEN_USAGE_PATH = '/api/__host/token-usage';
const TURN_LEDGER_PATH = '/api/__host/turn-ledger';
const EMPTY_ROLE_SNAPSHOT = Object.freeze({ main: null, sub: null, subByProvider: Object.freeze([]) });

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
  const readBattery = typeof deps.readBattery === 'function' ? deps.readBattery : createHostBatteryReader();

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

function assertPost(app, name) {
  if (!app || typeof app.post !== 'function') throw new TypeError(`[${name}-host] Express-compatible app is required`);
}

function postLocal(app, path, isLocal, respond) {
  app.post(path, (req, res) => {
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    return respond(req, res);
  });
}

function objectBody(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

function createAgentResourcesHost(runtime) {
  if (!runtime || typeof runtime !== 'object') throw new TypeError('[agent-resources-host] runtime is required');
  return body => getNative().agentResourceOperation(runtime, body);
}

function mountAgentResourcesHostRoute(app, options = {}) {
  assertPost(app, 'agent-resources');
  if (!options.runtime) throw new TypeError('[agent-resources-host] runtime is required');
  const isLocal = options.isLocal || isLocalRequest;
  const handle = createAgentResourcesHost(options.runtime);
  postLocal(app, AGENT_RESOURCES_PATH, isLocal, (req, res) => {
    const body = objectBody(req);
    try { res.json(handle(body)); }
    catch { res.status(500).json({ error: 'host operation failed' }); }
  });
}

function createTokenUsageHost(options) {
  if (!options || !options.tracker) throw new TypeError('[token-usage-host] tracker is required');
  const tracker = options.tracker;
  const log = typeof options.logFailure === 'function' ? options.logFailure : null;
  return body => getNative().tokenUsageOperation(tracker, body, EMPTY_ROLE_SNAPSHOT, log);
}

function mountTokenUsageHostRoute(app, options = {}) {
  assertPost(app, 'token-usage');
  if (!options.tracker) throw new TypeError('[token-usage-host] tracker is required');
  const isLocal = options.isLocal || isLocalRequest;
  const handle = createTokenUsageHost(options);
  postLocal(app, TOKEN_USAGE_PATH, isLocal, (req, res) => { res.json(handle(req.body)); });
}

function mountScanHistoryHostRoute(app, options = {}) {
  assertPost(app, 'scan-history');
  const history = options.scanHistory;
  if (!history || !Array.isArray(history.passes)) throw new TypeError('[scan-history-host] scanHistory.passes is required');
  const max = options.maxPasses;
  if (!Number.isInteger(max) || max <= 0) throw new TypeError('[scan-history-host] maxPasses must be a positive integer');
  postLocal(app, SCAN_HISTORY_PATH, options.isLocal || isLocalRequest,
    (req, res) => getNative().scanHistoryResponse(history, max, objectBody(req), res));
}

function createTurnLedgerHost(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('[turn-ledger-host] dependencies are required');
  for (const key of ['launch', 'record', 'trust']) {
    if (typeof deps[key] !== 'function') throw new TypeError(`[turn-ledger-host] dependency missing: ${key}`);
  }
  const trust = async body => {
    try { return { ok: true, value: await getNative().turnLedgerTrust(deps, body) }; }
    catch (error) { return { ok: false, message: String((error && error.message) || error) }; }
  };
  return async body => getNative().turnLedgerOperation(deps, body, trust);
}

function mountTurnLedgerHostRoute(app, options = {}) {
  assertPost(app, 'turn-ledger');
  const isLocal = typeof options.isLocal === 'function' ? options.isLocal : isLocalRequest;
  const handle = createTurnLedgerHost(options);
  postLocal(app, TURN_LEDGER_PATH, isLocal, (req, res) => {
    Promise.resolve(handle(req.body)).then(answer => res.json(answer),
      error => res.status(500).json({ error: 'turn ledger failed', detail: String((error && error.message) || error) }));
  });
}

const SYSTEM_PATH = '/api/__host/system';
const PROVIDER_RELAY_PATH = '/api/__host/provider-relay';
const LS_REMOTE_ARGS = ['ls-remote', '--tags', 'https://github.com/lsjwzh/MultiCC.git', 'refs/tags/v*'];
const LS_REMOTE_TIMEOUT_MS = 15000;

function mountSystemHostRoute(app, options = {}) {
  assertPost(app, 'system');
  const { fs, path, rootDir, networkInterfaces, getPort, getBindHost, authRequired, gitRun } = options;
  if (!fs || !path || !rootDir) {
    throw new TypeError('[system-host] fs, path and rootDir are required');
  }
  for (const [name, value] of Object.entries({ networkInterfaces, getPort, authRequired, gitRun })) {
    if (typeof value !== 'function') throw new TypeError(`[system-host] ${name} must be a function`);
  }
  // 测试注入；生产解析与其余路由同一个实现，每次请求现取。
  const isLocal = options.isLocal || isLocalRequest;
  const uptimeSeconds = typeof options.uptimeSeconds === 'function' ? options.uptimeSeconds : () => process.uptime();
  const now = typeof options.now === 'function' ? options.now : Date.now;

  // 与退役的 createServerInfoHandler 一致：版本在处理器创建时读一次，
  // 读取失败不是健康依赖——省略 version 键，其余字段照常。
  let serverVersion = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    serverVersion = pkg.version || '0.0.0';
  } catch (_) {
    serverVersion = null;
  }

  const facts = () => getNative().systemHostFacts({ networkInterfaces, getPort, getBindHost, authRequired, now, uptimeSeconds }, serverVersion);
  const lsRemote = async res => {
    try {
      const output = await gitRun(rootDir, LS_REMOTE_ARGS, { timeout: LS_REMOTE_TIMEOUT_MS, kind: 'version-check' });
      return res.json({ ok: true, output: String(output || '') });
    } catch { return res.json({ ok: false }); }
  };
  const trace = limit => require('../native/binding').codexProxyTrace.codexProxyTrace().snapshot(limit);
  app.post(SYSTEM_PATH, async (req, res) => {
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    return getNative().systemHostOperation(objectBody(req), res, facts, lsRemote, trace);
  });
}

function mountProviderRelayHostRoute(app, { authRuntime, modelCatalogRuntime, isLocal = isLocalRequest }) {
  app.post(PROVIDER_RELAY_PATH, async (req, res) => {
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = req.body || {};
    try {
      return await getNative().relayHostOperation(app, body, authRuntime, modelCatalogRuntime,
        async (json, value) => Reflect.apply(json, res, [await value]), res);
    } catch { return res.status(500).json({ error: 'host operation failed' }); }
  });
}

module.exports = {
  SYSTEM_PATH, mountSystemHostRoute, PROVIDER_RELAY_PATH, mountProviderRelayHostRoute,
  HOST_PATH, mountHostReadHostRoute, createHostReadHost,
  AGENT_RESOURCES_PATH, mountAgentResourcesHostRoute, createAgentResourcesHost,
  SCAN_HISTORY_PATH, mountScanHistoryHostRoute,
  TOKEN_USAGE_PATH, EMPTY_ROLE_SNAPSHOT, mountTokenUsageHostRoute, createTokenUsageHost,
  TURN_LEDGER_PATH, mountTurnLedgerHostRoute, createTurnLedgerHost,
};
