'use strict';

// Test harness for the Air host port.
//
// The 17 public /api/air routes are owned by the Rust front door now
// (native/gateway/src/app/air_routes.rs, rules in native/core/src/air_routes.rs):
// path matching, parameter decoding, If-None-Match → 304, the `{ ok: … }`
// envelope, error statuses and OPTIONS/HEAD no longer run in Node. `mountAirRoutes`
// only wires the loopback host port (POST /api/__host/air); the liveSync summary
// routes (/api/air/sync, /api/air/page) answer through the same port as the
// `sync` / `page` ops.
//
// Node tests therefore drive one host operation at a time and read back the
// envelope the retired `route()` catch arm used to build:
//
//   success  -> HTTP 200 { ok: true, value }
//   refusal  -> HTTP 200 { ok: false, error: { code, status?, message } }
//
// The wire contract (status codes, ETag/304, key order) is covered by
// native/gateway/tests/air_routes.rs and docs/rust-migration/differential/air-routes.js
// (the sync/page pair: docs/rust-migration/differential/air-sync-routes.js).
const assert = require('node:assert/strict');
const { createAirRuntime, HOST_PATH } = require('../../src/native/binding').airRoutesHost;

function fakeApp() {
  const routes = new Map();
  const register = method => (routePath, handler) => {
    const key = `${method} ${routePath}`;
    assert.equal(routes.has(key), false, `route registered only once: ${key}`);
    routes.set(key, handler);
  };
  return { routes, get: register('GET'), post: register('POST'), put: register('PUT'),
    delete: register('DELETE'), patch: register('PATCH') };
}

function fakeRes() {
  return {
    statusCode: 200, body: undefined, headers: {}, headersSent: false,
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; this.headersSent = true; return this; },
    send(body) { this.body = body; this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; },
  };
}

/**
 * Mount the host port exactly as production does, with the loopback gate
 * stubbed on (unit tests have no socket).
 */
function mountAir(deps = {}) {
  const app = fakeApp();
  const runtime = createAirRuntime({ ...deps, isLocal: deps.isLocal || (() => true) });
  runtime.mount(app);

  async function host(body, request = {}) {
    const handler = app.routes.get(`POST ${HOST_PATH}`);
    assert.equal(typeof handler, 'function', 'host route must be mounted');
    const res = fakeRes();
    await handler({ method: 'POST', headers: {}, query: {}, params: {}, body, ...request }, res);
    return { status: res.statusCode, body: res.body };
  }
  async function ok(body) {
    const res = await host(body);
    assert.equal(res.body && res.body.ok, true, `op ${body.op} failed: ${JSON.stringify(res.body)}`);
    return res.body.value;
  }
  async function fail(body) {
    const res = await host(body);
    assert.equal(res.body && res.body.ok, false, `op ${body.op} unexpectedly succeeded`);
    return res.body.error;
  }
  // GET /api/air 的快照正文与 ETag 都在宿主定稿；前门只决定 200/304 并原样发出。
  async function snapshot(ifNoneMatch) {
    const value = await ok(ifNoneMatch === undefined ? { op: 'snapshot' } : { op: 'snapshot', ifNoneMatch });
    return { body: value.body, etag: value.etag, json: JSON.parse(value.body) };
  }
  return { app, runtime, liveSync: runtime.liveSync, host, ok, fail, snapshot, HOST_PATH };
}

module.exports = { fakeApp, fakeRes, mountAir, HOST_PATH };
