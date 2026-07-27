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
  createServerInfoHandler,
  createApkInfoHandler,
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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-apk-route-'));
  fs.mkdirSync(path.join(rootDir, 'public'));
  const apkPath = path.join(rootDir, 'public', 'multicc.apk');
  fs.writeFileSync(apkPath, 'apk');
  fs.writeFileSync(`${apkPath}.json`, JSON.stringify({ versionName: '3.2.1', versionCode: 321, ignored: 'secret' }));
  const body = capture(createApkInfoHandler({ fs, path, rootDir }));
  assert.equal(body.exists, true);
  assert.equal(body.size, 3);
  assert.equal(body.versionName, '3.2.1');
  assert.equal(body.versionCode, 321);
  assert.equal(Object.hasOwn(body, 'ignored'), false);
});

test('system route mount owns exactly the three legacy GET paths', () => {
  const paths = [];
  mountSystemRoutes({ get(route, handler) { paths.push([route, typeof handler]); } }, {
    fs,
    path,
    https: fakeHttps({}),
    rootDir: process.cwd(),
    networkInterfaces: () => ({}),
    getPort: () => 3000,
    authRequired: () => false,
    gitRun: async () => '',
  });
  assert.deepEqual(paths, [
    ['/api/server-info', 'function'],
    ['/api/version-check', 'function'],
    ['/api/apk-info', 'function'],
  ]);
});
