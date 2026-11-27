'use strict';

// 宿主端口（host port）：`/healthz`、`/readyz`、`/metrics` 与
// `GET /api/repo-operations/:operationId` 已经由 Rust 前门
// （multicc-gateway，native/gateway/src/app/server_core.rs）独占。这里只剩
// 前门进程看不到、或必须逐字留在 JS 引擎里的宿主事实：
//
//   health  进程 uptime + 就绪判定（serviceReady / 关机标志 / commander 迁移快照）
//   metrics 合并后的指标表：observability 的 values + 事件循环滞后 + 活跃轮次
//           + WS 客户端数 + git 队列深度 + 活跃等待 + orchestration store 指标 + ready
//   repoOperation  仓储 actor 的操作进度（defaultRepoActor.status）
//
// `/metrics` 的排序与逐行序列化（`name value`、行尾换行）在 Rust；这里只给出
// 合并后的 `{ name: number }` 表。合并结果经退役实现 `metrics.render(extra)`
// 反解得到：`values` 只暴露 inc/set/get/render，没有枚举入口，所以把 render 的
// 文本按 "name value" 拆回数字表就是唯一不新增 observability API 的做法；有限
// 数字经 Number(String(x)) 往返是精确的。
//
// `multicc_active_turns` 必须来自 Rust 侧的会话存储（并行车道 A 提供
// `chatSessionsOwner(chatSessions).chatActiveTurns(streamBusy)`）：活跃轮次的
// 判定 `cs && (isChatStateBusy(cs) || chatStream.status(name)?.busy)` 里，
// `isChatStateBusy(cs)` 是会话状态机的事实，只有 Rust 持有。这里直调该方法，
// **不提供 Node 回退**；该接口尚未落地时会直接抛错，联调待主 agent 整合。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求（docs/gateway.md 的内网端口模型）。

const { isLocalRequest } = require('../native/binding').requestLocality;
const { chatSessionsOwner } = require('../chat/sessions');

const HOST_PATH = '/api/__host/server-core';

// 与 observability.js 的 metricName 同一口径；表里的名字来自 render，本就合法，
// 这里再校验一次是为了让非法名字在宿主端口这一侧立刻暴露（Rust 侧同样校验）。
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function assertFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`[server-core-host] ${label} must be a function`);
}

// 把 `metrics.render(extra)` 的文本拆回 `{ name: number }`：`render` 已经做了
// 合并、有限过滤与 metricName 校验，这里的数字天然有限；仍做一次防御性过滤，
// 非法名字直接抛错。
function tableFromRender(text) {
  const table = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const name = space === -1 ? line : line.slice(0, space);
    if (!METRIC_NAME.test(name)) {
      throw new TypeError(`[server-core-host] invalid metric name: ${name}`);
    }
    const value = Number(space === -1 ? NaN : line.slice(space + 1));
    if (!Number.isFinite(value)) continue;
    table[name] = value;
  }
  return table;
}

function mountServerCoreHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[server-core-host] Express-compatible app is required');
  }
  const metrics = options.metrics;
  if (!metrics || typeof metrics.render !== 'function') {
    throw new TypeError('[server-core-host] metrics.render is required');
  }
  const eventLoopMetrics = options.eventLoopMetrics;
  assertFunction(eventLoopMetrics, 'eventLoopMetrics');
  const chatSessions = options.chatSessions;
  if (!chatSessions || typeof chatSessions.get !== 'function') {
    throw new TypeError('[server-core-host] chatSessions table is required');
  }
  const isStreamBusy = options.isStreamBusy;
  assertFunction(isStreamBusy, 'isStreamBusy');
  const wss = options.wss;
  if (!wss || !wss.clients || typeof wss.clients.size !== 'number') {
    throw new TypeError('[server-core-host] wss.clients is required');
  }
  const gitQueueDepth = options.gitQueueDepth;
  assertFunction(gitQueueDepth, 'gitQueueDepth');
  const waitInjector = options.waitInjector;
  if (!waitInjector || typeof waitInjector.stats !== 'function') {
    throw new TypeError('[server-core-host] waitInjector.stats is required');
  }
  const getOrchestrationRuntime = options.getOrchestrationRuntime;
  assertFunction(getOrchestrationRuntime, 'getOrchestrationRuntime');
  const isReady = options.isReady;
  assertFunction(isReady, 'isReady');
  const readinessDetails = options.readinessDetails;
  assertFunction(readinessDetails, 'readinessDetails');
  const uptime = options.uptime || (() => process.uptime());
  assertFunction(uptime, 'uptime');
  const defaultRepoActor = options.defaultRepoActor;
  if (!defaultRepoActor || typeof defaultRepoActor.status !== 'function') {
    throw new TypeError('[server-core-host] defaultRepoActor.status is required');
  }
  // 测试注入；生产解析与其余路由同一个实现，每次请求现取。
  const isLocal = options.isLocal || isLocalRequest;

  function health() {
    let checks = null;
    try {
      const details = readinessDetails();
      if (details && typeof details === 'object') checks = details;
    } catch (_) {
      checks = null;
    }
    return {
      ok: true,
      uptimeSeconds: Math.floor(uptime()),
      ready: !!isReady(),
      checks,
    };
  }

  function metricsTable() {
    const runtime = getOrchestrationRuntime();
    const waitStats = waitInjector.stats();
    // 活跃轮次的会话状态判定在 Rust（并行车道 A）；直调，不设 Node 回退。
    const activeTurns = chatSessionsOwner(chatSessions).chatActiveTurns(isStreamBusy);
    const extra = {
      ...eventLoopMetrics(),
      multicc_active_turns: activeTurns,
      multicc_ws_clients: wss.clients.size,
      multicc_git_queue_depth: gitQueueDepth(),
      multicc_active_waits: waitStats.waits + (runtime ? runtime.pendingCount() : 0),
      ...(runtime?.store.metrics?.() || {}),
      multicc_ready: isReady() ? 1 : 0,
    };
    return tableFromRender(metrics.render(extra));
  }

  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    if (body.op === 'health') return res.json(health());
    if (body.op === 'metrics') return res.json({ ok: true, metrics: metricsTable() });
    if (body.op === 'repoOperation') {
      const operationId = typeof body.operationId === 'string' ? body.operationId : '';
      const operation = defaultRepoActor.status(operationId);
      return res.json({ ok: true, operation: operation || null });
    }
    return res.status(400).json({ error: 'unknown host operation' });
  });
}

module.exports = { mountServerCoreHostRoute, tableFromRender, HOST_PATH };
