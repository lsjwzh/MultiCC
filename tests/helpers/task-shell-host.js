'use strict';

// Test harness for the task-shell host port.
//
// The 42 task-shell public routes are now owned by the Rust front door
// (native/gateway/src/app/task_shell.rs, rules in native/core/src/task_shell.rs):
// path matching, parameter decoding, Express auto-OPTIONS, pagination and the
// error envelope no longer run in Node. Node tests therefore drive one
// /api/__host/task-shell operation at a time and read back the envelope the
// retired `route()` catch arm used to build:
//
//   success  -> HTTP 200 { ok: true, value }
//   refusal  -> HTTP 200 { ok: false, error: { code, message, status?, … } }
//
// The front-door status/DTO contract is covered by
// native/gateway/tests/task_shell.rs and docs/rust-migration/differential/task-shell.js.
const assert = require('node:assert/strict');
const { mountTaskShellHostRoute, HOST_PATH } = require('../../src/task-shell/host');
const { createArtifactsMemo } = require('../../src/task-shell/artifacts');

function fakeApp() {
  const routes = new Map();
  const register = method => (routePath, handler) => {
    const key = `${method} ${routePath}`;
    assert.equal(routes.has(key), false, `route registered only once: ${key}`);
    routes.set(key, handler);
  };
  return { routes, get: register('GET'), post: register('POST'), delete: register('DELETE') };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

/**
 * Mount the host port on `app` exactly as production does (the same artifact
 * memo) but with the loopback gate stubbed on, since unit tests have no socket.
 */
function mountHost(app, deps = {}) {
  mountTaskShellHostRoute(app, {
    ...deps,
    artifacts: deps.artifacts
      ? createArtifactsMemo(deps.artifacts, { memoMs: deps.artifactsMemoMs })
      : undefined,
    isLocal: deps.isLocal || (() => true),
  });
  async function host(body, request = {}) {
    const handler = app.routes.get(`POST ${HOST_PATH}`);
    assert.equal(typeof handler, 'function', 'host route must be mounted');
    const res = fakeRes();
    await handler({ body, query: {}, params: {}, ...request }, res);
    return { status: res.statusCode, body: res.body };
  }
  async function ok(body, request) {
    const res = await host(body, request);
    assert.equal(res.body && res.body.ok, true, `op ${body.op} failed: ${JSON.stringify(res.body)}`);
    return res.body.value;
  }
  async function fail(body, request) {
    const res = await host(body, request);
    assert.equal(res.body && res.body.ok, false, `op ${body.op} unexpectedly succeeded`);
    return res.body.error;
  }
  return { host, ok, fail };
}

module.exports = { fakeApp, fakeRes, mountHost, HOST_PATH };
