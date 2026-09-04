'use strict';

// Desktop shell test suite (see desktop/):
//   unit        port-chooser, health-probe, desktop-env, release-artifacts
//   integration backend-supervisor against tests/fixtures/desktop-fixture-server.js
//               (readiness gate, respawn, crash-loop, port-in-use, tree cleanup),
//               orphan-reclaim against a live fixture
//   gates       MULTICC_DESKTOP behavior of /api/restart, /api/desktop-shutdown,
//               /api/update, and the MULTICC_ENV_FILE relocation knob
//   static      electron security posture, lib purity, packaging config,
//               release workflow shape, icon dimensions
//
// Everything OS-specific is injected, so the suite runs on any dev box; the
// real server is never started and port 3000 is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'desktop-fixture-server.js');

const { findFreePort, probePort } = require(path.join(DESKTOP, 'lib', 'port-chooser.js'));
const { waitForReadiness } = require(path.join(DESKTOP, 'lib', 'health-probe.js'));
const desktopEnv = require(path.join(DESKTOP, 'lib', 'desktop-env.js'));
const { createBackendSupervisor } = require(path.join(DESKTOP, 'lib', 'backend-supervisor.js'));
const { reclaimOrphan, pidAlive } = require(path.join(DESKTOP, 'lib', 'orphan-reclaim.js'));
const releaseArtifacts = require(path.join(DESKTOP, 'lib', 'release-artifacts.js'));

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitFor(fn, { timeoutMs = 8000, intervalMs = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function makeSupervisor(overrides) {
  const phases = [];
  const sup = createBackendSupervisor({
    spawn,
    execPath: process.execPath,
    serverEntry: FIXTURE,
    buildEnv: ({ port }) => ({ ...process.env, ...overrides.env, PORT: String(port) }),
    logsDir: overrides.logsDir,
    runtimeInfoFile: overrides.runtimeInfoFile,
    onPhase: (phase, info) => phases.push({ phase, info }),
    ...overrides.opts,
  });
  return { sup, phases };
}

// ── unit: port-chooser ──────────────────────────────────────────────────────

test('port-chooser skips a bound port and finds the next free one', async () => {
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const busy = blocker.address().port;
  assert.equal(await probePort(busy, '127.0.0.1'), false);
  const free = await findFreePort(busy);
  assert.notEqual(free, busy);
  assert.equal(await probePort(free, '127.0.0.1'), true);
  await new Promise(resolve => blocker.close(resolve));
});

// ── unit: health-probe ──────────────────────────────────────────────────────

function fakeRes(status) {
  return { status, arrayBuffer: async () => new ArrayBuffer(0) };
}

test('health-probe resolves on 200 and retries through refusals', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    return fakeRes(calls < 6 ? 503 : 200); // refused, refused, 503s, then ready
  };
  const result = await waitForReadiness({
    origin: 'http://127.0.0.1:1', fetchImpl, intervalMs: 5, timeoutMs: 2000,
  });
  assert.equal(result.status, 200);
  assert.ok(calls >= 6);

  await assert.rejects(
    waitForReadiness({
      origin: 'http://127.0.0.1:1',
      fetchImpl: async () => { throw Object.assign(new Error('nope'), { code: 'ECONNREFUSED' }); },
      intervalMs: 5, timeoutMs: 30,
    }),
    error => error.code === 'READY_TIMEOUT',
  );
});

// ── unit: desktop-env ───────────────────────────────────────────────────────

test('desktop-env resolves packaged and dev layouts', () => {
  const packaged = desktopEnv.resolveDesktopEnv({
    isPackaged: true,
    resourcesPath: '/Applications/Resources',
    userData: '/Users/u/Library/Application Support/MultiCC',
  });
  assert.equal(packaged.serverEntry, '/Applications/Resources/app-server/server.js');
  assert.equal(packaged.dataRoot, '/Users/u/Library/Application Support/MultiCC/data');
  assert.equal(packaged.memoryRoot, path.join(packaged.dataRoot, 'memories'));
  assert.equal(packaged.envFile, '/Users/u/Library/Application Support/MultiCC/multicc.env');
  assert.equal(packaged.logsDir, '/Users/u/Library/Application Support/MultiCC/logs');

  const dev = desktopEnv.resolveDesktopEnv({ isPackaged: false, userData: '/ignored', repoRoot: '/repo' });
  assert.equal(dev.serverEntry, '/repo/server.js');
  assert.equal(dev.dataRoot, '/repo/.desktop-dev-data');
  assert.equal(dev.envFile, '/repo/.desktop-dev-data/multicc.env');
});

test('buildChildEnv: dotenv fills gaps, desktop knobs always win, child runs as Node', () => {
  const layout = desktopEnv.resolveDesktopEnv({ isPackaged: true, resourcesPath: '/r', userData: '/u' });
  const env = desktopEnv.buildChildEnv({
    port: 3457,
    desktopEnv: layout,
    baseEnv: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', HOST: '0.0.0.0', SOME_KEY: 'from-env' },
    dotenv: { SOME_KEY: 'from-dotenv', EMPTY_KEY: 'filled', ACCESS_TOKEN: 'abc' },
  });
  assert.equal(env.PORT, '3457');
  // Loopback bind is pinned — a copied-in .env cannot widen the surface.
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.MULTICC_DATA_DIR, layout.dataRoot);
  assert.equal(env.MULTICC_MEMORY_ROOT, layout.memoryRoot);
  assert.equal(env.MULTICC_ENV_FILE, layout.envFile);
  assert.equal(env.MULTICC_DESKTOP, '1');
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  // existing env wins over .env; empty slots get filled
  assert.equal(env.SOME_KEY, 'from-env');
  assert.equal(env.EMPTY_KEY, 'filled');
  assert.equal(env.ACCESS_TOKEN, 'abc');

  assert.deepEqual(desktopEnv.parseEnvFile('# c\nA=1\n\n  B = spaced \n'), { A: '1', B: 'spaced' });
});

// ── integration: backend-supervisor + fixture ───────────────────────────────

test('supervisor: ready gate, graceful stop, whole tree cleaned up', async () => {
  const dir = tmpdir('desktop-sup-');
  const runtimeInfoFile = path.join(dir, 'desktop-runtime.json');
  const pidfile = path.join(dir, 'child.pid');
  const port = await reservePort();
  const { sup, phases } = makeSupervisor({
    env: { READY_DELAY_MS: '200', SPAWN_CHILD_PIDFILE: pidfile },
    logsDir: dir,
    runtimeInfoFile,
    opts: { healthTimeoutMs: 10_000 },
  });
  await sup.start({ port });
  await waitFor(() => phases.some(p => p.phase === 'ready'), { what: 'ready phase' });
  assert.equal(sup.getState().state, 'ready');
  assert.equal(sup.getState().origin, `http://127.0.0.1:${port}`);
  const live = JSON.parse(fs.readFileSync(runtimeInfoFile, 'utf8'));
  assert.ok(live.pid > 0);
  assert.equal(live.port, port);
  assert.equal((await httpGet(`${sup.getState().origin}/readyz`)).status, 200);

  const grandchildPid = Number(fs.readFileSync(pidfile, 'utf8'));
  assert.ok(pidAlive(grandchildPid), 'fixture grandchild should be alive');

  await sup.stop();
  assert.equal(sup.getState().state, 'stopped');
  await waitFor(() => !pidAlive(grandchildPid), { what: 'grandchild reaped' });
  assert.equal(fs.existsSync(runtimeInfoFile), false, 'runtime info cleared on clean stop');
  // logs landed on disk
  const logs = fs.readdirSync(dir).filter(f => f.startsWith('server-') && f.endsWith('.log'));
  assert.ok(logs.length >= 1, 'supervisor wrote a run log');
});

test('supervisor: classifies EADDRINUSE as port-in-use', async () => {
  const dir = tmpdir('desktop-port-');
  const port = await reservePort();
  const { sup, phases } = makeSupervisor({
    env: { PRINT_ADDRINUSE: '1' },
    logsDir: dir,
    runtimeInfoFile: path.join(dir, 'desktop-runtime.json'),
    opts: { healthTimeoutMs: 5_000 },
  });
  await sup.start({ port });
  await waitFor(() => phases.some(p => p.phase === 'failed'), { what: 'port-in-use failure' });
  assert.equal(sup.getState().failure.reason, 'port-in-use');
  await sup.stop();
});

test('supervisor: crash-loop guard stops respawning', async () => {
  const dir = tmpdir('desktop-crash-');
  const port = await reservePort();
  const { sup, phases } = makeSupervisor({
    env: { EXIT_AFTER_READY_MS: '1', EXIT_CODE: '1' },
    logsDir: dir,
    runtimeInfoFile: path.join(dir, 'desktop-runtime.json'),
    opts: {
      healthTimeoutMs: 5_000,
      crashLoopThreshold: 3,
      crashLoopWindowMs: 60_000,
      restartBackoffMs: 60,
      maxRestartBackoffMs: 200,
    },
  });
  await sup.start({ port });
  await waitFor(() => phases.some(p => p.phase === 'failed'), { timeoutMs: 20_000, what: 'crash-loop failure' });
  assert.equal(sup.getState().failure.reason, 'crash-loop');
  const spawns = phases.filter(p => p.phase === 'starting').length;
  assert.equal(spawns, 3, 'exactly threshold-many attempts, no infinite loop');
  await sup.stop();
});

test('supervisor: respawns once after an abnormal exit and recovers', async () => {
  const dir = tmpdir('desktop-respawn-');
  const port = await reservePort();
  const { sup, phases } = makeSupervisor({
    env: { READY_DELAY_MS: '100', EXIT_AFTER_READY_MS: '400', EXIT_CODE: '1' },
    logsDir: dir,
    runtimeInfoFile: path.join(dir, 'desktop-runtime.json'),
    opts: {
      healthTimeoutMs: 10_000,
      crashLoopThreshold: 10,
      restartBackoffMs: 150,
      maxRestartBackoffMs: 300,
    },
  });
  await sup.start({ port });
  await waitFor(() => phases.filter(p => p.phase === 'ready').length >= 1, { what: 'first ready' });
  // first instance self-exits → supervisor respawns → ready again
  await waitFor(() => phases.filter(p => p.phase === 'ready').length >= 2, { timeoutMs: 20_000, what: 'ready after respawn' });
  assert.ok(phases.some(p => p.phase === 'respawning'));
  await sup.stop();
  assert.equal(sup.getState().state, 'stopped');
});

test('supervisor: never-ready child is killed, failure reported with tail', async () => {
  const dir = tmpdir('desktop-notready-');
  const runtimeInfoFile = path.join(dir, 'desktop-runtime.json');
  const port = await reservePort();
  const { sup, phases } = makeSupervisor({
    env: { READY_DELAY_MS: String(10 * 60_000) }, // stays 503 essentially forever
    logsDir: dir,
    runtimeInfoFile,
    opts: { healthTimeoutMs: 1_200 },
  });
  await sup.start({ port });
  await waitFor(() => phases.some(p => p.phase === 'failed'), { timeoutMs: 15_000, what: 'not-ready failure' });
  assert.equal(sup.getState().failure.reason, 'not-ready');
  const st = sup.getState();
  // No zombie: the stuck child was torn down with the whole tree.
  await waitFor(() => !pidAlive(st.childPid), { what: 'stuck child killed' });
  await sup.stop();
});

// ── integration: orphan reclaim ─────────────────────────────────────────────

test('orphan-reclaim: drains a live orphan and removes stale files', async () => {
  const dir = tmpdir('desktop-orphan-');
  // stale entries (dead pid / no pid) are cleaned without side effects
  const stale = path.join(dir, 'stale.json');
  fs.writeFileSync(stale, JSON.stringify({ pid: 999_999_999, port: 1, origin: 'http://127.0.0.1:1' }));
  const staleResult = await reclaimOrphan({ infoFile: stale, spawn });
  assert.equal(staleResult.reclaimed, false);
  assert.equal(staleResult.reason, 'stale');
  assert.equal(fs.existsSync(stale), false);

  // live orphan: a fixture server from a "crashed" previous app
  const port = await reservePort();
  const orphan = spawn(process.execPath, [FIXTURE], {
    env: { ...process.env, PORT: String(port), READY_DELAY_MS: '1' },
    stdio: 'ignore', detached: true,
  });
  orphan.unref();
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(() => httpGet(`${origin}/readyz`).then(r => r.status === 200).catch(() => false),
    { what: 'orphan ready' });
  const infoFile = path.join(dir, 'runtime.json');
  fs.writeFileSync(infoFile, JSON.stringify({ pid: orphan.pid, port, origin }));

  const result = await reclaimOrphan({ infoFile, spawn });
  assert.equal(result.reclaimed, true);
  assert.equal(result.method, 'http-drain');
  await waitFor(() => !pidAlive(orphan.pid), { what: 'orphan exited' });
  assert.equal(fs.existsSync(infoFile), false);
});

// ── unit: release-artifacts ─────────────────────────────────────────────────

test('release-artifacts: name validation, digest-only sidecars, manifest', () => {
  const dir = tmpdir('desktop-rel-');
  const good = path.join(dir, 'multicc-desktop-1.6.8-macos-arm64.dmg');
  fs.writeFileSync(good, 'dmg-bytes');
  const deb = path.join(dir, 'multicc-desktop-1.6.8-linux-x64.deb');
  fs.writeFileSync(deb, 'deb-bytes');

  assert.equal(releaseArtifacts.validateArtifactName('multicc-desktop-1.6.8-macos-arm64.dmg', { platform: 'macos', version: '1.6.8' }).ok, true);
  assert.equal(releaseArtifacts.validateArtifactName('MultiCC-1.6.8.dmg').ok, false);
  assert.equal(releaseArtifacts.validateArtifactName('multicc-desktop-1.6.8-macos-arm64.exe').ok, false, 'wrong ext for platform');
  assert.equal(releaseArtifacts.validateArtifactName('multicc-desktop-1.6.9-linux-x64.deb', { version: '1.6.8' }).ok, false, 'version mismatch');

  const entries = releaseArtifacts.prepareReleaseAssets({ files: [good, deb], version: '1.6.8' });
  assert.equal(entries.length, 2);
  // digest-only sidecar — byte-identical convention to public/multicc.apk.sha256
  for (const e of entries) {
    const sidecar = fs.readFileSync(`${e.filePath}.sha256`, 'utf8');
    assert.equal(sidecar.trim(), e.digest);
    assert.match(sidecar, /^[0-9a-f]{64}\n$/);
  }
  const manifest = fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8');
  assert.match(manifest, /^[0-9a-f]{64}  multicc-desktop-1\.6\.8-(linux-x64\.deb|macos-arm64\.dmg)\n[0-9a-f]{64}  multicc-desktop-1\.6\.8-(linux-x64\.deb|macos-arm64\.dmg)\n$/);

  // invalid names abort the whole asset set
  const bad = path.join(dir, 'MultiCC-Setup.exe');
  fs.writeFileSync(bad, 'x');
  assert.throws(() => releaseArtifacts.prepareReleaseAssets({ files: [bad], version: '1.6.8' }));
});

// ── staging script ──────────────────────────────────────────────────────────

test('desktop-bundle-server stages a runnable server tree without the APK', { timeout: 120_000 }, () => {
  const out = tmpdir('desktop-stage-');
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'desktop-bundle-server.js'),
    '--out', path.join(out, 'app-server'), '--no-install'], { encoding: 'utf8' });
  assert.equal(res.status, 0, `staging failed: ${res.stderr}`);
  const staged = path.join(out, 'app-server');
  for (const must of ['server.js', 'src/paths.js', 'public/manage.html', 'public/chat.html',
    'scripts/multicc-router-mcp.js', 'plugins/bridges/wechat-ilink.js', 'plugins/cron/cron-tasks.js',
    'package.json']) {
    assert.ok(fs.existsSync(path.join(staged, must)), `staged tree missing ${must}`);
  }
  // server.js requires every plugins/* module unconditionally at boot; a tree
  // without them dies before /readyz (caught for real by the local smoke run).
  const rootPlugins = require('child_process').execFileSync(
    'git', ['ls-files', 'plugins'], { cwd: ROOT }).toString().trim().split('\n').filter(Boolean);
  for (const rel of rootPlugins) {
    assert.ok(fs.existsSync(path.join(staged, rel)), `staged tree missing ${rel}`);
  }
  assert.equal(fs.existsSync(path.join(staged, 'public', 'multicc.apk')), false, '62MB APK must not ship inside desktop bundles');
  const pkg = JSON.parse(fs.readFileSync(path.join(staged, 'package.json'), 'utf8'));
  assert.ok(pkg.optionalDependencies['sherpa-onnx-node'], 'sherpa becomes optional (graceful ASR degrade)');
  assert.equal(pkg.dependencies['sherpa-onnx-node'], undefined);
  assert.equal(pkg.version, require(path.join(ROOT, 'package.json')).version);
});

// ── gates: MULTICC_DESKTOP server-side behavior ─────────────────────────────

function fakeApp() {
  const handlers = {};
  return {
    handlers,
    app: {
      post: (p, h) => { handlers[`POST ${p}`] = h; },
      get: (p, h) => { handlers[`GET ${p}`] = h; },
    },
  };
}

function fakeRouteRes() {
  const res = { statusCode: 200, body: null };
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  return res;
}

function withEnv(vars, fn) {
  const saved = {};
  return async () => {
    for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}

test('restart route: desktop mode exits for supervisor respawn instead of scheduling bash', withEnv({ MULTICC_DESKTOP: '1' }, async () => {
  const { createServerRestartRoute } = require(path.join(ROOT, 'src', 'routes', 'server-restart-route.js'));
  let exited = null;
  const spawns = [];
  const { app, handlers } = fakeApp();
  createServerRestartRoute({
    chatSessions: new Map(),
    spawn: (...a) => { spawns.push(a); return { on: () => {}, unref: () => {} }; },
    rootDir: ROOT,
    getShuttingDown: () => false,
    desktopExit: reason => { exited = reason; },
  }).mountRoutes(app);

  const res = fakeRouteRes();
  handlers['POST /api/restart']({ id: 'r1' }, res);
  await new Promise(r => setImmediate(r));
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.mode, 'desktop-supervised');
  assert.equal(exited, 'desktop-restart');
  assert.equal(spawns.length, 0, 'no detached /bin/bash re-launcher in desktop mode');

  // second call while the scheduled exit is pending → 409 debounce
  const res2 = fakeRouteRes();
  handlers['POST /api/restart']({ id: 'r2' }, res2);
  assert.equal(res2.statusCode, 409);

  const res3 = fakeRouteRes();
  handlers['POST /api/desktop-shutdown']({ id: 'r3' }, res3);
  assert.equal(res3.statusCode, 202);
}));

test('desktop-shutdown route: 404 outside desktop mode, 409 while already shutting down', withEnv({ MULTICC_DESKTOP: undefined }, async () => {
  const { createServerRestartRoute } = require(path.join(ROOT, 'src', 'routes', 'server-restart-route.js'));
  let shuttingDown = false;
  const { app, handlers } = fakeApp();
  createServerRestartRoute({
    chatSessions: new Map(), spawn: () => ({}), rootDir: ROOT,
    getShuttingDown: () => shuttingDown,
    desktopExit: () => { shuttingDown = true; },
  }).mountRoutes(app);
  const res = fakeRouteRes();
  handlers['POST /api/desktop-shutdown']({ id: 'r1' }, res);
  assert.equal(res.statusCode, 404, 'route must not exist for non-desktop installs');

  // same construction, desktop on: first call 202, second (already draining) 409
  const { app: app2, handlers: h2 } = fakeApp();
  let sd = false;
  createServerRestartRoute({
    chatSessions: new Map(), spawn: () => ({}), rootDir: ROOT,
    getShuttingDown: () => sd,
    desktopExit: () => { sd = true; },
    isDesktopMode: () => true,
  }).mountRoutes(app2);
  const ok = fakeRouteRes();
  h2['POST /api/desktop-shutdown']({ id: 'r2' }, ok);
  await new Promise(r => setImmediate(r));
  assert.equal(ok.statusCode, 202);
  const conflict = fakeRouteRes();
  h2['POST /api/desktop-shutdown']({ id: 'r3' }, conflict);
  assert.equal(conflict.statusCode, 409);
}));

test('update route: desktop installs refuse git-based self-update', withEnv({ MULTICC_DESKTOP: '1' }, async () => {
  const { createUpdateRoute } = require(path.join(ROOT, 'src', 'routes', 'update-route.js'));
  const { app, handlers } = fakeApp();
  createUpdateRoute({
    chatSessions: new Map(), spawn: () => ({}), rootDir: ROOT, getShuttingDown: () => false,
  }).mountRoutes(app);
  const res = fakeRouteRes();
  handlers['POST /api/update']({ id: 'u1', body: {} }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'DESKTOP_UPDATE_UNSUPPORTED');
}));

test('host-env honors MULTICC_ENV_FILE for read and write', withEnv({ MULTICC_ENV_FILE: undefined }, async () => {
  const dir = tmpdir('desktop-envfile-');
  const file = path.join(dir, 'multicc.env');
  process.env.MULTICC_ENV_FILE = file;
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'host-env.js'))];
  const hostEnv = require(path.join(ROOT, 'src', 'host-env.js'));
  assert.equal(hostEnv.envPath(), file);
  hostEnv.writeEnvFile({ VAPID_PUBLIC_KEY: 'pub-1' });
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'VAPID_PUBLIC_KEY=pub-1');
  assert.equal(hostEnv.readEnvFile().VAPID_PUBLIC_KEY, 'pub-1');
  hostEnv.writeEnvFile({ VAPID_PUBLIC_KEY: 'pub-2' });
  assert.equal(hostEnv.readEnvFile().VAPID_PUBLIC_KEY, 'pub-2');
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'host-env.js'))];
}));

// ── static: security posture, purity, packaging, workflow, icon ─────────────

test('main.js: hardened window, single instance, local-only navigation', () => {
  const src = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  assert.match(src, /requestSingleInstanceLock/);
  assert.match(src, /contextIsolation:\s*true/);
  assert.match(src, /nodeIntegration:\s*false/);
  assert.match(src, /sandbox:\s*true/);
  assert.doesNotMatch(src, /webSecurity:\s*false/);
  assert.match(src, /setWindowOpenHandler/);
  assert.match(src, /will-navigate/);
  assert.match(src, /setPermissionRequestHandler/);
  assert.match(src, /shell\.openExternal/);
  assert.match(src, /before-quit/, 'teardown hook exists');
  assert.doesNotMatch(src, /loadURL\(\s*['"]https?:\/\/(?!127\.0\.0\.1)/, 'no remote page loads');
});

test('preload.js: minimal bridge, no privileged requires', () => {
  const src = fs.readFileSync(path.join(DESKTOP, 'preload.js'), 'utf8');
  const requires = [...src.matchAll(/require\((['"])(.+?)\1\)/g)].map(m => m[2]);
  assert.deepEqual(requires, ['electron']);
  assert.match(src, /contextBridge\.exposeInMainWorld/);
  // Comments may name modules while explaining the rule; code may not.
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['fs', 'child_process', 'net', 'http', 'remote']) {
    assert.doesNotMatch(code, new RegExp(`\\b${forbidden}\\b`), `preload must not touch ${forbidden}`);
  }
});

test('desktop/lib stays electron-free (testable under plain Node)', () => {
  for (const name of fs.readdirSync(path.join(DESKTOP, 'lib'))) {
    if (!name.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(DESKTOP, 'lib', name), 'utf8');
    assert.doesNotMatch(src, /require\((['"])electron\1\)/, `${name} must not import electron`);
  }
});

test('desktop packaging config: pinned versions, stable names, user-scope installers', () => {
  const rootPkg = require(path.join(ROOT, 'package.json'));
  const pkg = require(path.join(DESKTOP, 'package.json'));
  assert.equal(pkg.version, rootPkg.version, 'desktop version tracks the root package');
  assert.equal(pkg.devDependencies.electron, '44.1.1', 'electron pinned exactly (ABI rebuild depends on it)');
  const b = pkg.build;
  assert.equal(b.asar, true);
  assert.equal(pkg.main, 'main.js');
  assert.deepEqual(b.files.sort(), ['assets/**/*', 'lib/**/*', 'main.js', 'package.json', 'preload.js'].sort());
  assert.equal(b.extraResources[0].to, 'app-server');
  assert.match(b.mac.artifactName, /multicc-desktop-\$\{version\}-macos-\$\{arch\}/);
  assert.match(b.win.artifactName, /multicc-desktop-\$\{version\}-windows-\$\{arch\}/);
  assert.match(b.linux.artifactName, /multicc-desktop-\$\{version\}-linux-\$\{arch\}/);
  assert.equal(b.mac.identity, null, 'unsigned by default; CI overrides with secrets');
  assert.equal(b.nsis.oneClick, true);
  assert.equal(b.nsis.perMachine, false, 'per-user install needs no admin rights');
  assert.ok(b.publish === null || b.publish === undefined, 'no auto-update publisher');
});

test('desktop-release workflow: three native runners, attaches (never creates) the release, secrets only as env', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'desktop-release.yml'), 'utf8');
  for (const os of ['macos-latest', 'windows-latest', 'ubuntu-latest']) {
    assert.ok(wf.includes(os), `matrix must include ${os}`);
  }
  assert.match(wf, /tags:\s*\['v\*\.\*\.\*'\]/);
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /--publish never/);
  assert.match(wf, /electron-rebuild/);
  assert.match(wf, /gh release upload/);
  // Comments explain the rule; the steps themselves must follow it.
  const wfCode = wf.replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(wfCode, /gh release create/, 'release.yml (APK) owns creation');
  // Secrets may only appear in env: mappings — never inside run: scripts, where
  // an echo would leak them into logs.
  for (const line of wf.split('\n')) {
    if (line.includes('${{ secrets.')) {
      assert.match(line, /^\s+[A-Z_]+:\s*\$\{\{ secrets\./, `secret outside env mapping: ${line.trim()}`);
    }
  }
  assert.match(wf, /desktop-release-assets\.js/);
  assert.match(wf, /SIGNING-STATUS/, 'unsigned state must be explicit');
});

test('desktop icon is a square PNG of at least 512px', () => {
  const icon = fs.readFileSync(path.join(DESKTOP, 'build', 'icon.png'));
  assert.equal(icon.readUInt32BE(0).toString(16), '89504e47', 'PNG magic');
  const width = icon.readUInt32BE(16);
  const height = icon.readUInt32BE(20);
  assert.ok(width >= 512 && height >= 512, `icon too small: ${width}x${height}`);
  assert.equal(width, height, 'electron-builder wants a square source icon');
});
