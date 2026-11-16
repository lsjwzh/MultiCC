'use strict';

// 等一个 `node server.js` 宿主就绪（裸起，或经 Rust 前门转发的同一宿主端口）。
//
// 为什么不探 `/readyz`：server-core 簇（`/healthz`、`/readyz`、`/metrics`、
// `/api/repo-operations/:id`）已迁入 Rust 前门（native/gateway/src/app/server_core.rs），
// 裸起的 `node server.js` 不再注册那条公开路由，探它只会一直拿到非 200 直到超时。
// Node 仍保留回环宿主端口 `POST /api/__host/server-core`（src/routes/server-core-host.js），
// `op:'health'` 返回的 `ready` 正是原 `/readyz` 用的那个判定
// （serviceReady && !shuttingDown && commanderMigration.ready）。
//
// 只认 `status === 200 && body.ok === true && body.ready === true`。
// 传了 `child` 时每轮先看它有没有提前退出；退出即抛错并附上 `output()`。
// `token` 为空时不发 `X-Access-Token` 头（宿主端口本身只认回环，不校验令牌）。
async function waitServerReady(base, {
  attempts = 150,
  intervalMs = 100,
  timeoutMs = null,
  token = process.env.ACCESS_TOKEN,
  message = 'server did not become ready',
  child = null,
  output = null,
} = {}) {
  const deadline = timeoutMs == null ? Infinity : Date.now() + timeoutMs;
  const tail = () => (typeof output === 'function' ? `:\n${output()}` : '');

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (child && child.exitCode !== null) {
      throw new Error(`${message}: server.js exited early (${child.exitCode})${tail()}`);
    }
    if (Date.now() > deadline) break;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-Access-Token'] = token;
      const init = { method: 'POST', headers, body: JSON.stringify({ op: 'health' }) };
      const remaining = deadline - Date.now();
      if (Number.isFinite(remaining)) init.signal = AbortSignal.timeout(Math.max(1, remaining));
      const response = await fetch(`${base}/api/__host/server-core`, init);
      if (response.status === 200) {
        const body = await response.json().catch(() => null);
        if (body?.ok === true && body.ready === true) return;
      }
    } catch (_) { /* not up yet (or the body was not JSON) */ }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${message}${tail()}`);
}

module.exports = { waitServerReady };
