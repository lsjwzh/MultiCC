'use strict';

// 宿主端口（host port）：`/api/scan/history` 已经由 Rust 前门
// （multicc-gateway，native/gateway/src/app/scan.rs）独占，`limit` 的
// `parseInt(req.query.limit, 10) || 20` 语义在 multicc_core::system_info。
// 这里只剩 Node 内存里的环形缓冲本身（src/classify/state-machine.js 的
// scanHistory），以及必须逐字留在 JS 一侧的两步：`Math.min(limit, maxPasses)`
// 封顶和 `slice(0, limit)`——slice 的负数参数语义（去掉末尾 N 条）是这条
// 路由的既有契约，不能在 Rust 一侧重新实现出偏差。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求（docs/gateway.md 的内网端口模型）。

const { isLocalRequest } = require('../request-locality');

const HOST_PATH = '/api/__host/scan-history';

function mountScanHistoryHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[scan-history-host] Express-compatible app is required');
  }
  const scanHistory = options.scanHistory;
  if (!scanHistory || !Array.isArray(scanHistory.passes)) {
    throw new TypeError('[scan-history-host] scanHistory.passes is required');
  }
  const maxPasses = options.maxPasses;
  if (!Number.isInteger(maxPasses) || maxPasses <= 0) {
    throw new TypeError('[scan-history-host] maxPasses must be a positive integer');
  }
  // 测试注入；生产解析与其余路由同一个实现，每次请求现取。
  const isLocal = options.isLocal || isLocalRequest;

  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    if (body.op === 'snapshot') {
      // Rust 发来的是 parseInt||20 之后的数值（±Infinity 已钳成
      // ±Number.MAX_VALUE），封顶与切片都在 JS 做，负数 slice 语义逐字保留。
      const requested = typeof body.limit === 'number' && Number.isFinite(body.limit) ? body.limit : 20;
      const limit = Math.min(requested, maxPasses);
      return res.json({
        seq: scanHistory.seq,
        kept: scanHistory.passes.length,
        passes: scanHistory.passes.slice(0, limit),
      });
    }
    return res.status(400).json({ error: 'unknown host operation' });
  });
}

module.exports = { mountScanHistoryHostRoute, HOST_PATH };
