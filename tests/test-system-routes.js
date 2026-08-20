'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  compareSemver,
  selectLanAddress,
  latestTagFromRemote,
  resolveVersionInfo,
  readApkInfo,
  resolveApkBuildStatus,
  createApkBuildRuntime,
  createServerInfoHandler,
  createApkInfoHandler,
  createApkBuildStartHandler,
  createApkBuildStatusHandler,
  mountSystemRoutes,
} = require('../src/routes/system');

function fakeHttps(payload, failure = null) {
  return {
    get(url, options, callback) {
      const request = new EventEmitter();
      request.destroy = () => {};
      queueMicrotask(() => {
        if (failure) {
          request.emit('error', failure);
          return;
        }
        const response = new EventEmitter();
        callback(response);
        response.emit('data', JSON.stringify(payload));
        response.emit('end');
      });
      return request;
    },
  };
}

function capture(handler, req = {}) {
  let body;
  handler(req, { json(value) { body = value; } });
  return body;
}

function captureResponse(handler, req = {}) {
  let status = 200;
  let body;
  const res = {
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  };
  handler(req, res, (error) => { throw error; });
  return { status, body };
}

function apkRoot(version = '3.2.1+321') {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-apk-route-'));
  fs.mkdirSync(path.join(rootDir, 'public'));
  fs.mkdirSync(path.join(rootDir, 'app'));
  fs.writeFileSync(path.join(rootDir, 'app', 'pubspec.yaml'), `name: multicc_app\nversion: ${version}\n`);
  return rootDir;
}

function fakeDetachedRuntime() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-apk-detached-'));
  const jobs = [];
  const launches = [];
  const runtime = {
    BASE_DIR: baseDir,
    jobs,
    launches,
    pendingNext: false,
    list() { throw new Error('APK status must not scan detached history'); },
    status(id) { return jobs.find(job => job.id === id) || null; },
    launch(input) {
      launches.push(input);
      const job = {
        id: input.id,
        label: input.label,
        command: input.command,
        cwd: input.cwd,
        startedAt: Date.parse('2026-08-20T12:00:00.000Z'),
        started: !runtime.pendingNext,
        running: !runtime.pendingNext,
        done: false,
        exitCode: null,
        logTail: '\u001b[32mBuilding release APK…\u001b[0m',
      };
      jobs.unshift(job);
      runtime.pendingNext = false;
      return job;
    },
  };
  return runtime;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function apkRuntimeDeps(rootDir, detached, overrides = {}) {
  return {
    fs,
    path,
    rootDir,
    detached,
    atomicWriteJson: writeJsonAtomic,
    now: () => Date.parse('2026-08-20T12:00:01.000Z'),
    ...overrides,
  };
}

test('semver and remote tag selection preserve legacy stable-tag semantics', () => {
  assert.equal(compareSemver('1.9.0', '1.10.0') < 0, true);
  assert.equal(compareSemver('2.0', '2.0.0'), 0);
  assert.equal(compareSemver('2.0.1', '2.0.0') > 0, true);
  assert.equal(latestTagFromRemote([
    'aaa refs/tags/v1.9.0',
    'bbb refs/tags/v2.0.0',
    'ccc refs/tags/v1.10.0',
    'ddd refs/tags/not-semver',
  ].join('\n')), 'v2.0.0');
});

test('server info selects the first external IPv4 and reads the live port', () => {
  let port = 3000;
  const handler = createServerInfoHandler({
    networkInterfaces: () => ({
      lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      en0: [{ family: 'IPv6', internal: false, address: '::1' }, { family: 'IPv4', internal: false, address: '192.168.1.8' }],
    }),
    getPort: () => port,
    authRequired: () => true,
    now: () => Date.parse('2026-07-27T05:32:00.000Z'),
    uptimeSeconds: () => 8100,
  });
  assert.deepEqual(capture(handler), {
    ip: '192.168.1.8', port: 3000, proto: 'http', url: 'http://192.168.1.8:3000', authRequired: true,
    startedAt: '2026-07-27T03:17:00.000Z', uptimeMs: 8100000,
  });
  port = 3012;
  assert.equal(capture(handler).port, 3012);
  assert.equal(selectLanAddress({ lo0: null }), '127.0.0.1');
});

test('server info reports the running process start, not a value captured at require time', () => {
  // The sidebar read-out is only trustworthy if a restart moves it. Deriving
  // startedAt from live uptime is what guarantees that: a module-level
  // `bootTime` would keep answering with the previous run until someone
  // remembered to reassign it.
  let clock = Date.parse('2026-07-27T05:32:00.000Z');
  let uptime = 8100;
  const deps = {
    networkInterfaces: () => ({}),
    getPort: () => 3000,
    authRequired: () => false,
    now: () => clock,
    uptimeSeconds: () => uptime,
  };
  const handler = createServerInfoHandler(deps);
  const before = capture(handler);

  // Time passes with the same process running: the start instant holds still.
  clock += 600000;
  uptime += 600;
  assert.equal(capture(handler).startedAt, before.startedAt);
  assert.equal(capture(handler).uptimeMs, 8700000);

  // A restart: same wall clock, a process that has only just begun.
  uptime = 3;
  const after = capture(handler);
  assert.equal(after.startedAt, '2026-07-27T05:41:57.000Z');
  assert.ok(Date.parse(after.startedAt) > Date.parse(before.startedAt), 'a restart must move the read-out forward');

  // Uptime is read per request, not frozen when the handler was built.
  assert.equal(capture(handler).uptimeMs, 3000);
});

test('server info falls back to the real process clock and never reports a future start', () => {
  const handler = createServerInfoHandler({
    networkInterfaces: () => ({}),
    getPort: () => 3000,
    authRequired: () => false,
  });
  const body = capture(handler);
  assert.ok(body.uptimeMs >= 0 && body.uptimeMs < 24 * 3600 * 1000, 'defaults to this process uptime');
  assert.ok(Date.parse(body.startedAt) <= Date.now(), 'startedAt is in the past');

  const negative = capture(createServerInfoHandler({
    networkInterfaces: () => ({}),
    getPort: () => 3000,
    authRequired: () => false,
    now: () => 1000,
    uptimeSeconds: () => -5,
  }));
  assert.equal(negative.uptimeMs, 0);
  assert.equal(negative.startedAt, new Date(1000).toISOString());
});

test('version info prefers GitHub release metadata and keeps install channel', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-system-route-'));
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: '1.4.0' }));
  fs.writeFileSync(path.join(rootDir, '.multicc_channel'), '# channel: stable\n');
  let gitCalls = 0;
  const result = await resolveVersionInfo({
    fs,
    path,
    rootDir,
    https: fakeHttps({ tag_name: 'v1.5.0' }),
    gitRun: async () => { gitCalls += 1; return ''; },
    timeoutMs: 25,
  });
  assert.deepEqual(result, {
    current: '1.4.0', channel: 'stable', latest: 'v1.5.0', latestVersion: '1.5.0', updateAvailable: true, apiError: false,
  });
  assert.equal(gitCalls, 0);
});

test('version info falls back to git tags without hiding the API failure', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-system-route-'));
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: '2.0.0' }));
  const result = await resolveVersionInfo({
    fs,
    path,
    rootDir,
    https: fakeHttps(null, new Error('offline')),
    gitRun: async () => 'aaa refs/tags/v1.0.0\nbbb refs/tags/v2.0.0\n',
    timeoutMs: 25,
  });
  assert.equal(result.latest, 'v2.0.0');
  assert.equal(result.updateAvailable, false);
  assert.equal(result.apiError, true);
  assert.equal(result.channel, 'dev');
});

test('APK handler exposes only file metadata and optional version sidecar', () => {
  const rootDir = apkRoot();
  const apkPath = path.join(rootDir, 'public', 'multicc.apk');
  fs.writeFileSync(apkPath, 'apk');
  fs.writeFileSync(`${apkPath}.json`, JSON.stringify({ versionName: '3.2.1', versionCode: 321, ignored: 'secret' }));
  const body = capture(createApkInfoHandler({ fs, path, rootDir }));
  assert.equal(body.exists, true);
  assert.equal(body.size, 3);
  assert.equal(body.versionName, '3.2.1');
  assert.equal(body.versionCode, 321);
  assert.equal(body.targetVersionName, '3.2.1');
  assert.equal(body.targetVersionCode, 321);
  assert.equal(body.current, true);
  assert.equal(Object.hasOwn(body, 'ignored'), false);
});

test('APK handler reports the exact server-only state when no package was built', () => {
  const rootDir = apkRoot();
  try {
    assert.deepEqual(capture(createApkInfoHandler({ fs, path, rootDir })), {
      exists: false,
      targetVersionName: '3.2.1',
      targetVersionCode: 321,
      current: false,
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('APK build is a singleton detached job with restart-safe status', () => {
  const rootDir = apkRoot();
  const detached = fakeDetachedRuntime();
  detached.pendingNext = true;
  const runtimeDeps = apkRuntimeDeps(rootDir, detached);
  const apkBuildRuntime = createApkBuildRuntime(runtimeDeps);
  const deps = { ...runtimeDeps, apkBuildRuntime };
  try {
    const start = createApkBuildStartHandler(deps);
    const first = captureResponse(start);
    assert.equal(first.status, 202);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.reused, false);
    assert.equal(first.body.build.state, 'running');
    assert.deepEqual(detached.launches, [{
      id: first.body.build.id,
      command: 'exec ./scripts/publish-apk.sh',
      cwd: rootDir,
      label: 'apk-build',
    }]);

    const duplicate = captureResponse(start);
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.body.reused, true);
    assert.equal(detached.launches.length, 1, 'a second click must not launch another Gradle build');

    const running = captureResponse(createApkBuildStatusHandler(deps));
    assert.equal(running.body.state, 'running');
    assert.equal(running.body.logTail.includes('\u001b'), false, 'terminal escapes stay out of the API');

    detached.jobs[0].running = false;
    detached.jobs[0].done = true;
    detached.jobs[0].exitCode = 0;
    assert.equal(apkBuildRuntime.status().state, 'succeeded');

    const afterRestart = createApkBuildRuntime(runtimeDeps);
    assert.equal(afterRestart.status().state, 'succeeded', 'the durable pointer survives server recreation');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(detached.BASE_DIR, { recursive: true, force: true });
  }
});

test('explicit APK rebuild starts even when a current package exists', () => {
  const rootDir = apkRoot();
  const detached = fakeDetachedRuntime();
  try {
    const apkPath = path.join(rootDir, 'public', 'multicc.apk');
    fs.writeFileSync(apkPath, 'apk');
    fs.writeFileSync(`${apkPath}.json`, JSON.stringify({ versionName: '3.2.1', versionCode: 321 }));
    assert.equal(readApkInfo({ fs, path, rootDir }).current, true);
    const apkBuildRuntime = createApkBuildRuntime(apkRuntimeDeps(rootDir, detached));
    const response = captureResponse(createApkBuildStartHandler({ fs, path, rootDir, apkBuildRuntime }));
    assert.equal(response.status, 202);
    assert.equal(response.body.reused, false);
    assert.equal(detached.launches.length, 1);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(detached.BASE_DIR, { recursive: true, force: true });
  }
});

test('APK freshness rejects zero-byte files and spoofed detached labels', () => {
  const rootDir = apkRoot();
  const detached = fakeDetachedRuntime();
  try {
    const apkPath = path.join(rootDir, 'public', 'multicc.apk');
    fs.writeFileSync(apkPath, '');
    fs.writeFileSync(`${apkPath}.json`, JSON.stringify({ versionName: '3.2.1', versionCode: 321 }));
    assert.equal(readApkInfo({ fs, path, rootDir }).current, false);
    assert.equal(readApkInfo({ fs, path, rootDir }).exists, false);

    const spoofId = 'd_apk_0123456789abcdef';
    writeJsonAtomic(path.join(detached.BASE_DIR, 'apk-build-latest.json'), {
      schemaVersion: 1, id: spoofId, scheduledAt: Date.now(),
    });
    detached.jobs.push({
      id: spoofId, label: 'apk-build', command: 'sleep 999', cwd: rootDir,
      startedAt: Date.now(), started: true, running: true, done: false,
    });
    const spoofedRuntime = createApkBuildRuntime(apkRuntimeDeps(rootDir, detached));
    assert.equal(spoofedRuntime.status().state, 'unknown');
    const rejected = captureResponse(createApkBuildStartHandler({ apkBuildRuntime: spoofedRuntime }));
    assert.equal(rejected.status, 503, 'an untrusted pointer must fail closed instead of launching');
    assert.equal(rejected.body.code, 'APK_BUILD_STATUS_UNAVAILABLE');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(detached.BASE_DIR, { recursive: true, force: true });
  }
});

test('APK build refuses to race a checkout update or server shutdown', () => {
  const rootDir = apkRoot();
  const detached = fakeDetachedRuntime();
  const apkBuildRuntime = createApkBuildRuntime(apkRuntimeDeps(rootDir, detached));
  try {
    const updating = captureResponse(createApkBuildStartHandler({
      fs, path, rootDir, apkBuildRuntime, getUpdateStatus: () => ({ running: true }),
    }));
    assert.equal(updating.status, 409);
    assert.equal(updating.body.error, 'update_in_progress');
    const unknown = captureResponse(createApkBuildStartHandler({
      fs, path, rootDir, apkBuildRuntime, getUpdateStatus() { throw new Error('disk unavailable'); },
    }));
    assert.equal(unknown.status, 503);
    assert.equal(unknown.body.code, 'UPDATE_STATUS_UNAVAILABLE');
    const shuttingDown = captureResponse(createApkBuildStartHandler({
      fs, path, rootDir, apkBuildRuntime, getShuttingDown: () => true,
    }));
    assert.equal(shuttingDown.status, 409);
    assert.equal(shuttingDown.body.error, 'server_shutting_down');
    assert.equal(detached.launches.length, 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(detached.BASE_DIR, { recursive: true, force: true });
  }
});

test('system route mount owns metadata plus on-demand APK build paths', () => {
  const paths = [];
  mountSystemRoutes({
    get(route, handler) { paths.push(['GET', route, typeof handler]); },
    post(route, handler) { paths.push(['POST', route, typeof handler]); },
  }, {
    fs,
    path,
    https: fakeHttps({}),
    rootDir: process.cwd(),
    networkInterfaces: () => ({}),
    getPort: () => 3000,
    authRequired: () => false,
    gitRun: async () => '',
    apkBuildRuntime: createApkBuildRuntime({
      ...apkRuntimeDeps(process.cwd(), fakeDetachedRuntime()),
    }),
  });
  assert.deepEqual(paths, [
    ['GET', '/api/server-info', 'function'],
    ['GET', '/api/version-check', 'function'],
    ['GET', '/api/apk-info', 'function'],
    ['GET', '/api/apk-build', 'function'],
    ['POST', '/api/apk-build', 'function'],
  ]);
});
