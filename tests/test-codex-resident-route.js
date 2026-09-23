'use strict';
// The resident lane's route holder.
//
// A warm codex child bakes its upstream route into CODEX_HOME/config.toml, which
// the per-turn design creates as a private attempt home and deletes when the
// child closes. This module is what makes the resident variant possible: one home
// per (logical session, capability), never outliving the capability written into
// it. These tests pin the four properties the lane's routing fingerprint (and so
// its respawn behaviour) depends on: the home is stable while the capability is,
// it moves when the capability does, it is released when nobody holds it, and a
// required-but-unavailable route fails loudly instead of silently going native.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createCodexResidentRoutes,
  releaseResidentRoute,
} = require('../src/codex/resident-route');

const ROOTS = [];
const SOURCE_HOME = '/tmp/multicc-test-provider-home';

test.after(() => {
  for (const root of ROOTS) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
});

// Stands in for src/providers/core: an overlay home the way createCodexAttemptHome
// makes one (a real directory, so the module's liveness check sees what a real
// home looks like) plus the claude route for the other protocol family.
function createPort(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-resident-route-'));
  ROOTS.push(root);
  const calls = { codex: [], claude: [], released: [] };
  const leases = new WeakMap();
  let minted = 0;
  const port = {
    calls,
    fail: options.fail === true,
    applyClaudeProxyEnv(env, applyOptions) {
      calls.claude.push(applyOptions);
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:1/claude-proxy/${applyOptions.sessionId}/main`;
      env.ANTHROPIC_AUTH_TOKEN = applyOptions.sessionId;
    },
    applyCodexProxyConfig(env, applyOptions) {
      if (port.fail) return false;
      calls.codex.push(applyOptions);
      const home = path.join(root, `attempt-${++minted}`);
      fs.mkdirSync(home, { recursive: true });
      leases.set(env, home);
      env.CODEX_HOME = home;
      return true;
    },
    releaseCodexProxyConfig(env) {
      const home = leases.get(env);
      if (!home) return false;
      leases.delete(env);
      calls.released.push(home);
      fs.rmSync(home, { recursive: true, force: true });
      env.CODEX_HOME = SOURCE_HOME;
      return true;
    },
  };
  return port;
}

function childEnv() {
  return { CODEX_HOME: SOURCE_HOME, TERM: 'dumb' };
}

function codexTurn(overrides = {}) {
  return {
    cli: 'codex-exp', providerId: 'provider-a', sessionId: 'pr1.session.token',
    logicalSessionId: 'session-1', port: 3000, ...overrides,
  };
}

test('a resident codex turn holds one home across turns and routes on it', () => {
  const providers = createPort();
  const routes = createCodexResidentRoutes({ providers });

  const first = childEnv();
  assert.equal(routes.prepare(first, codexTurn()), true);
  assert.notEqual(first.CODEX_HOME, SOURCE_HOME, 'the child gets the private overlay, not the provider home');
  assert.equal(providers.calls.codex.length, 1);
  assert.equal(providers.calls.codex[0].sessionId, 'pr1.session.token',
    'the route capability is what gets written into the home');

  const second = childEnv();
  assert.equal(routes.prepare(second, codexTurn({ nativeSessionId: 'thread-1' })), true);
  assert.equal(second.CODEX_HOME, first.CODEX_HOME,
    'a warm child keeps the home its route was written into');
  assert.equal(providers.calls.codex.length, 1, 'the home is materialized once, not once per turn');
  assert.deepEqual(routes.stats(), { live: 1, retired: 0 });
});

test('a moved capability retires the old home so the child cannot keep a dead route', () => {
  const timers = [];
  const providers = createPort();
  const routes = createCodexResidentRoutes({
    providers, retireMs: 30_000, setTimer: (fn) => { timers.push(fn); return { unref() {} }; },
  });

  const warm = childEnv();
  routes.prepare(warm, codexTurn());
  const moved = childEnv();
  routes.prepare(moved, codexTurn({ sessionId: 'pr1.session.rotated' }));

  assert.notEqual(moved.CODEX_HOME, warm.CODEX_HOME,
    'the capability is what config.toml points at, so a new one needs a new home');
  assert.deepEqual(providers.calls.released, [], 'the previous child is still alive until its turn boundary');
  assert.deepEqual(routes.stats(), { live: 1, retired: 1 });

  timers.forEach((fn) => fn());
  assert.deepEqual(providers.calls.released, [warm.CODEX_HOME],
    'the replaced home is released once the respawned child has had its boundary');
  assert.deepEqual(routes.stats(), { live: 1, retired: 0 });
});

test('a home that vanished under the lane is rematerialized instead of reused', () => {
  const providers = createPort();
  const routes = createCodexResidentRoutes({ providers, setTimer: () => ({ unref() {} }) });
  const first = childEnv();
  routes.prepare(first, codexTurn());

  // Someone else swept the directory (another host incarnation, a manual clean).
  // Handing the same path to the next spawn would start codex against a home that
  // no longer holds its route.
  fs.rmSync(first.CODEX_HOME, { recursive: true, force: true });
  const next = childEnv();
  routes.prepare(next, codexTurn());

  assert.notEqual(next.CODEX_HOME, first.CODEX_HOME);
  assert.equal(fs.existsSync(next.CODEX_HOME), true);
  assert.equal(providers.calls.codex.length, 2);
});

test('a resident claude turn routes through the proxy and holds no codex home', () => {
  const providers = createPort();
  const routes = createCodexResidentRoutes({ providers });

  const claude = { ANTHROPIC_BASE_URL: '', TERM: 'dumb' };
  assert.equal(routes.prepare(claude, {
    cli: 'claude', providerId: 'zhipu', sessionId: 'pr1.session.token',
    subagent: { providerId: 'kimi' }, port: 3000, officialOAuth: false,
  }), true);

  assert.equal(providers.calls.claude.length, 1);
  assert.equal(providers.calls.claude[0].sessionId, 'pr1.session.token');
  assert.match(claude.ANTHROPIC_BASE_URL, /pr1\.session\.token/);
  assert.deepEqual(providers.calls.codex, [], 'claude never materializes a Codex home');
  assert.deepEqual(routes.stats(), { live: 0, retired: 0 });
});

test('a codex turn that must be routed fails loudly when the route cannot be materialized', () => {
  const providers = createPort({ fail: true });
  const routes = createCodexResidentRoutes({ providers });

  const env = childEnv();
  assert.throws(
    () => routes.prepare(env, codexTurn()),
    (error) => error.code === 'CODEX_PROXY_CONFIG_REQUIRED',
    'a managed provider must never silently fall back to its native home',
  );
  assert.equal(env.CODEX_HOME, SOURCE_HOME);

  // A subagent-only route is the easy one to miss: the session itself has no
  // provider, so the requirement comes from the sub-provider alone.
  assert.throws(
    () => routes.prepare(childEnv(), codexTurn({ providerId: '_default_', subagent: { providerId: 'kimi' } })),
    (error) => error.code === 'CODEX_PROXY_CONFIG_REQUIRED',
  );

  // An unmanaged session is allowed to stay on its own home.
  const native = childEnv();
  assert.equal(routes.prepare(native, codexTurn({ providerId: '_default_' })), false);
  assert.equal(native.CODEX_HOME, SOURCE_HOME);
  assert.deepEqual(routes.stats(), { live: 0, retired: 0 });
});

test('releasing a session drops its home and lets the next turn materialize a fresh one', () => {
  const providers = createPort();
  const routes = createCodexResidentRoutes({ providers });
  const first = childEnv();
  routes.prepare(first, codexTurn());
  const home = first.CODEX_HOME;

  assert.equal(routes.release('session-1'), true);
  assert.equal(routes.release('session-1'), false, 'release is idempotent');
  assert.deepEqual(providers.calls.released, [home]);
  assert.equal(fs.existsSync(home), false, 'the directory goes with the lease');

  const next = childEnv();
  routes.prepare(next, codexTurn());
  assert.notEqual(next.CODEX_HOME, home);
  assert.equal(providers.calls.codex.length, 2);
});

test('an idle session gives its home back, and a session taking turns keeps it', () => {
  const providers = createPort();
  let clock = 1_000_000;
  const routes = createCodexResidentRoutes({
    providers, idleMs: 60_000, now: () => clock, setTimer: () => ({ unref() {} }),
  });

  routes.prepare(childEnv(), codexTurn({ logicalSessionId: 'session-idle' }));
  routes.prepare(childEnv(), codexTurn({ logicalSessionId: 'session-warm' }));

  clock += 30_000;
  routes.prepare(childEnv(), codexTurn({ logicalSessionId: 'session-warm' }));
  clock += 40_000; // idle is now 70s stale, warm 40s
  assert.equal(routes.sweepIdle(), 1);
  assert.equal(providers.calls.released.length, 1);
  assert.deepEqual(routes.stats(), { live: 1, retired: 0 });

  clock += 60_000;
  assert.equal(routes.sweepIdle(), 1, 'the warm session is reclaimed once it stops taking turns');
  assert.deepEqual(routes.stats(), { live: 0, retired: 0 });
});

test('a teardown path that never ran a resident codex turn is inert', () => {
  // The app-server lane releases by session name whenever it closes a child, for
  // every session of every CLI, so releasing must not build the provider port —
  // nor load src/providers/core — just because a claude session's child was
  // closed. Nothing above this test touched the shared singleton, which is
  // exactly the state a process that only ever served claude sessions is in.
  assert.equal(releaseResidentRoute('session-1'), false);
  assert.equal(require.cache[require.resolve('../src/providers/core')], undefined);
});
