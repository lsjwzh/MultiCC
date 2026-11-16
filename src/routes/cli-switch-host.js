'use strict';

// 宿主端口（host port）：`POST /api/sessions/:id/switch-cli` 已经由 Rust 前门
// （multicc-gateway，native/gateway/src/app/cli_switch.rs）独占。入口闸门的
// 四条拒绝分支（会话不存在 / 系统会话 / 非 chat / 不支持的 cli）由
// `multicc_core::cli_switch_runtime::plan("manualGate", …)` 在前门内直接判掉，
// 完全不进 Node。这里只剩跨 await 必须留在同一进程里的副作用：
//
//   facts  会话表查找 + `sessionFacts` 投影 + `taskExecutionSlot` 标记（前门
//          用它复现 publicSessionAccessGuard，且必须早于 body 解析与 OPTIONS）
//   noop   同 CLI 重选：ensureCliStates 持久化事务 + 清 auto provider 记录
//   switch 可用性/忙碌两段式 → 排队 → git 快照 → 签名比对 → 预检 → 提交
//
// `preparations` Map、session 对象身份、signature 比较、子进程、持久化事务与
// 广播全部留在 Node；`switch` 是一整段原样搬过来的代码，不拆成多次往返
// （signature 与 preparations 是跨 await 的 TOCTOU 保护，拆了就破）。
//
// 这不是一条公开 API：前门只在内部端口上以回环身份调用它。`isLocalRequest`
// 拒绝任何转发自真实远端客户端的请求，所以前门的公网端口也拿不到额外能力
// （docs/gateway.md 的内网端口模型）。

const { isLocalRequest } = require('../request-locality');

const HOST_PATH = '/api/__host/cli-switch';

// The answer a host-side throw becomes. The front door then replays
// `safeErrorHandler` from these fields (the same convention as
// `src/routes/host-read-host.js`): the status the error carried (if it was a
// 4xx/5xx), its `code`, the opt-in safe message, and the log detail. The raw
// message never reaches the client.
function hostFailure(error) {
  return {
    ok: false,
    status: Number.isInteger(error && error.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 500,
    code: error && typeof error.code === 'string' ? error.code : null,
    safeMessage: error && error.safe && typeof error.message === 'string' ? error.message : null,
    detail: (error && (error.message || String(error))) || 'cli switch failed',
  };
}

/**
 * deps:
 *   facts(sessionId) -> { ok, exists, internalSlot, session, supported }
 *   noop(sessionId) -> { ok, body } | { ok:false, error }
 *   switch(sessionId, targetCli, fresh) -> Promise<{ ok, status, body } | { ok:false, error }>
 *   isLocal(req) -> bool (测试注入；生产与其余路由同一个实现)
 *
 * `facts`/`noop` are synchronous so the caller can keep the original Node
 * event-loop ordering (the retired handler's synchronous prologue).
 */
function mountCliSwitchHostRoute(app, options = {}) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('[cli-switch-host] Express-compatible app is required');
  }
  const facts = options.facts;
  const noop = options.noop;
  const perform = options.switch;
  if (typeof facts !== 'function' || typeof noop !== 'function' || typeof perform !== 'function') {
    throw new TypeError('[cli-switch-host] facts, noop and switch are required');
  }
  // 测试注入；生产解析与其余路由同一个实现，每次请求现取。
  const isLocal = options.isLocal || isLocalRequest;

  app.post(HOST_PATH, (req, res) => {
    // 只认回环。前门转发到内网端口时写的是真实对端地址，远端客户端在这里就被挡住。
    if (!isLocal(req)) return res.status(404).json({ error: 'not found' });
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    if (body.op === 'facts') {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      try {
        return res.json(facts(sessionId));
      } catch (error) {
        return res.json(hostFailure(error));
      }
    }
    if (body.op === 'noop') {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      try {
        return res.json(noop(sessionId));
      } catch (error) {
        return res.json(hostFailure(error));
      }
    }
    if (body.op === 'switch') {
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const targetCli = typeof body.targetCli === 'string' ? body.targetCli : '';
      if (!sessionId || !targetCli) {
        return res.json(hostFailure(new Error('sessionId and targetCli are required')));
      }
      let pending;
      try {
        pending = perform(sessionId, targetCli, body.fresh === true);
      } catch (error) {
        return res.json(hostFailure(error));
      }
      // The switch runs synchronously up to its first await (the Git snapshot),
      // so the retired route's observed ordering is preserved.
      return Promise.resolve(pending).then(
        answer => res.json(answer),
        error => res.json(hostFailure(error)),
      );
    }
    return res.status(400).json({ error: 'unknown host operation' });
  });
}

module.exports = { mountCliSwitchHostRoute, hostFailure, HOST_PATH };
