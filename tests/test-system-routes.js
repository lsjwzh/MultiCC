'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  APP_CONNECTION_PROTOCOL,
  compareSemver,
  ipv4Priority,
  reachableLanAddresses,
  selectLanAddresses,
  selectLanAddress,
  latestTagFromRemote,
  resolveVersionInfo,
  createServerInfoHandler,
  createApkInfoHandler,
  mountSystemRoutes,
} = require('../src/routes/system');
const { createApkDistribution } = require('../src/apk-distribution');

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

function apkRoot(version = '3.2.1+321', packageVersion = '2.4.6') {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-apk-route-'));
  fs.mkdirSync(path.join(rootDir, 'public'));
  fs.mkdirSync(path.join(rootDir, 'app'));
  fs.mkdirSync(path.join(rootDir, 'app', 'android'));
  fs.writeFileSync(path.join(rootDir, 'app', 'pubspec.yaml'), `name: multicc_app\nversion: ${version}\n`);
  fs.writeFileSync(path.join(rootDir, 'app', 'android', 'release-cert.sha256'), `${'b'.repeat(64)}\n`);
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: packageVersion }));
  return rootDir;
}

function scriptedHttps(initialSteps) {
  const steps = initialSteps.slice();
  const calls = [];
  return {
    calls,
    get(url, options, callback) {
      const request = new EventEmitter();
      request.destroy = (error) => { if (error) queueMicrotask(() => request.emit('error', error)); };
      calls.push({ url: String(url), options });
      const step = steps.shift();
      queueMicrotask(() => {
        if (!step) {
          request.emit('error', new Error(`unscripted HTTPS request: ${url}`));
          return;
        }
        if (step.error) {
          request.emit('error', step.error);
          return;
        }
        const response = new EventEmitter();
        response.statusCode = step.status || 200;
        response.headers = step.headers || {};
        response.setEncoding = () => {};
        response.destroy = () => {};
        callback(response);
        if (step.body != null) response.emit('data', typeof step.body === 'string' ? step.body : JSON.stringify(step.body));
        response.emit('end');
      });
      return request;
    },
  };
}

function releaseFixture(version = '2.4.6', overrides = {}) {
  const tag = `v${version}`;
  const base = `https://github.com/lsjwzh/MultiCC/releases/download/${tag}`;
  const apk = {
    name: 'multicc.apk', state: 'uploaded', size: 1234,
    updated_at: '2026-08-20T12:00:00Z', browser_download_url: `${base}/multicc.apk`,
  };
  const manifestAsset = {
    name: 'multicc.apk.json', state: 'uploaded', size: 400,
    browser_download_url: `${base}/multicc.apk.json`,
  };
  const manifest = {
    schemaVersion: 1,
    releaseTag: tag,
    releaseVersion: version,
    versionName: '3.2.0',
    versionCode: 320,
    size: apk.size,
    sha256: 'a'.repeat(64),
    signerSha256: 'b'.repeat(64),
    gitCommit: 'c'.repeat(40),
    builtAt: '2026-08-20T11:59:00Z',
    ...overrides,
  };
  return [
    { body: { tag_name: tag, draft: false, prerelease: false, assets: [apk, manifestAsset] } },
    { body: manifest },
  ];
}

function captureDownload() {
  return {
    statusCode: 200,
    headers: {},
    redirected: null,
    ended: false,
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    redirect(code, url) { this.statusCode = code; this.redirected = url; return this; },
    end() { this.ended = true; return this; },
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

test('server info prefers physical private LAN addresses and reads the live bind', () => {
  let port = 3000;
  const handler = createServerInfoHandler({
    networkInterfaces: () => ({
      lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      utun4: [{ family: 'IPv4', internal: false, address: '100.118.172.84' }],
      docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1' }],
      en0: [{ family: 'IPv6', internal: false, address: '::1' }, { family: 'IPv4', internal: false, address: '192.168.1.8' }],
      en1: [{ family: 4, internal: false, address: '10.0.0.4' }],
    }),
    getPort: () => port,
    getBindHost: () => '0.0.0.0',
    authRequired: () => true,
    now: () => Date.parse('2026-07-27T05:32:00.000Z'),
    uptimeSeconds: () => 8100,
  });
  assert.deepEqual(capture(handler), {
    product: 'multicc', appProtocolVersion: APP_CONNECTION_PROTOCOL,
    ip: '192.168.1.8', port: 3000, proto: 'http', url: 'http://192.168.1.8:3000', authRequired: true,
    bindHost: '0.0.0.0', lanAvailable: true,
    lanAddresses: ['192.168.1.8', '10.0.0.4'],
    lanUrls: ['http://192.168.1.8:3000', 'http://10.0.0.4:3000'],
    startedAt: '2026-07-27T03:17:00.000Z', uptimeMs: 8100000,
  });
  port = 3012;
  assert.equal(capture(handler).port, 3012);
  assert.equal(selectLanAddress({ lo0: null }), '127.0.0.1');
});

test('server info identifies MultiCC and publishes its local version without a remote lookup', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-server-info-'));
  try {
    fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: '1.7.3' }));
    const body = capture(createServerInfoHandler({
      fs,
      path,
      rootDir,
      networkInterfaces: () => ({}),
      getPort: () => 3000,
      authRequired: () => false,
      now: () => 1000,
      uptimeSeconds: () => 0,
    }));
    assert.equal(body.product, 'multicc');
    assert.equal(body.appProtocolVersion, APP_CONNECTION_PROTOCOL);
    assert.equal(body.version, '1.7.3');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('LAN address selection rejects virtual and unroutable adapters and honors loopback binds', () => {
  const interfaces = {
    docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1' }],
    tailscale0: [{ family: 'IPv4', internal: false, address: '100.100.10.5' }],
    en0: [{ family: 'IPv4', internal: false, address: '169.254.8.2' }],
    Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.22.220' }],
    en2: [{ family: 'IPv4', internal: false, address: '203.0.113.8' }],
  };
  assert.deepEqual(selectLanAddresses(interfaces), ['192.168.22.220']);
  assert.equal(selectLanAddress(interfaces), '192.168.22.220');
  assert.deepEqual(reachableLanAddresses(interfaces, '127.0.0.1'), []);
  assert.deepEqual(reachableLanAddresses(interfaces, '0.0.0.0'), ['192.168.22.220']);
  assert.deepEqual(reachableLanAddresses(interfaces, '192.168.22.220'), ['192.168.22.220']);
  assert.equal(ipv4Priority('10.2.3.4') > ipv4Priority('8.8.8.8'), true);
  assert.equal(ipv4Priority('169.254.1.2'), -1);
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

test('APK distribution prefers a non-empty local regular file without touching GitHub', async () => {
  const rootDir = apkRoot();
  const apkPath = path.join(rootDir, 'public', 'multicc.apk');
  fs.writeFileSync(apkPath, 'apk');
  fs.writeFileSync(`${apkPath}.json`, JSON.stringify({ versionName: '3.2.1', versionCode: 321, ignored: 'secret' }));
  const https = scriptedHttps([]);
  try {
    const runtime = createApkDistribution({ fs, path, https, rootDir });
    const body = await runtime.info();
    assert.equal(body.exists, true);
    assert.equal(body.localExists, true);
    assert.equal(body.source, 'local');
    assert.equal(body.downloadUrl, '/multicc.apk');
    assert.equal(body.size, 3);
    assert.equal(body.versionName, '3.2.1');
    assert.equal(body.versionCode, 321);
    assert.equal(body.targetVersionName, '3.2.1');
    assert.equal(body.targetVersionCode, 321);
    assert.equal(body.current, true);
    assert.equal(body.localCurrent, true);
    assert.equal(body.releaseTag, 'v2.4.6');
    assert.equal(https.calls.length, 0, 'local priority must not depend on GitHub');

    let nextCalls = 0;
    const res = captureDownload();
    await runtime.downloadHandler({}, res, () => { nextCalls += 1; });
    assert.equal(nextCalls, 1, 'the static mount owns the local file response');
    assert.equal(res.redirected, null);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('APK distribution verifies the exact current-version release and manifest with single-flight caching', async () => {
  const rootDir = apkRoot();
  const https = scriptedHttps(releaseFixture());
  try {
    const runtime = createApkDistribution({ fs, path, https, rootDir });
    const [first, duplicate] = await Promise.all([runtime.info(), runtime.info()]);
    assert.deepEqual(duplicate, first);
    assert.equal(first.exists, true);
    assert.equal(first.localExists, false);
    assert.equal(first.source, 'release');
    assert.equal(first.downloadUrl, 'https://github.com/lsjwzh/MultiCC/releases/download/v2.4.6/multicc.apk');
    assert.equal(first.releaseUrl, first.downloadUrl);
    assert.equal(first.remoteState, 'available');
    assert.equal(first.versionName, '3.2.0', 'release manifest, not checkout pubspec, owns remote version');
    assert.equal(first.versionCode, 320);
    assert.equal(first.targetVersionName, '3.2.1');
    assert.equal(first.targetVersionCode, 321);
    assert.equal(first.current, false);
    assert.equal(https.calls.length, 2, 'one release lookup plus one manifest fetch shared by both callers');
    assert.equal(https.calls[0].url, 'https://api.github.com/repos/lsjwzh/MultiCC/releases/tags/v2.4.6');
    assert.equal(https.calls[1].url, 'https://github.com/lsjwzh/MultiCC/releases/download/v2.4.6/multicc.apk.json');

    const res = captureDownload();
    await runtime.downloadHandler({}, res, () => assert.fail('remote source must not reach express.static'));
    assert.equal(res.statusCode, 302);
    assert.equal(res.redirected, first.downloadUrl);
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.match(res.headers['cache-control'], /no-store/);
    assert.equal(https.calls.length, 2, 'download reuses the positive cache');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('missing and invalid release assets are not advertised, while transient network failures use only the fixed candidate', async () => {
  const missingRoot = apkRoot();
  const missingHttps = scriptedHttps([{ status: 404, body: { message: 'Not Found' } }]);
  try {
    const missing = createApkDistribution({ fs, path, https: missingHttps, rootDir: missingRoot });
    const info = await missing.info();
    assert.equal(info.exists, false);
    assert.equal(info.localExists, false);
    assert.equal(info.source, null);
    assert.equal(info.downloadUrl, null);
    assert.equal(info.remoteState, 'missing');
    const res = captureDownload();
    await missing.downloadHandler({}, res, () => assert.fail('missing package must terminate'));
    assert.equal(res.statusCode, 404);
    assert.equal(res.ended, true);
  } finally {
    fs.rmSync(missingRoot, { recursive: true, force: true });
  }


  const unknownRoot = apkRoot();
  const unknownHttps = scriptedHttps([{ error: new Error('offline') }]);
  try {
    const unknown = createApkDistribution({ fs, path, https: unknownHttps, rootDir: unknownRoot });
    const info = await unknown.info();
    assert.equal(info.exists, false, 'an unverified URL is never claimed as available');
    assert.equal(info.remoteState, 'unknown');
    assert.equal(info.releaseUrl, 'https://github.com/lsjwzh/MultiCC/releases/download/v2.4.6/multicc.apk');
    const res = captureDownload();
    await unknown.downloadHandler({ query: { token: 'must-not-leak' } }, res, () => assert.fail('unknown package must redirect or terminate'));
    assert.equal(res.statusCode, 302, 'the browser may still try the fixed, non-user-controlled candidate');
    assert.equal(res.redirected, info.releaseUrl);
    assert.equal(res.redirected.includes('token'), false);
  } finally {
    fs.rmSync(unknownRoot, { recursive: true, force: true });
  }
});

test('zero-byte, directory, malformed manifest, and invalid package versions fail closed', async () => {
  const rootDir = apkRoot('3.2.1+321', '2.4.6');
  try {
    fs.writeFileSync(path.join(rootDir, 'public', 'multicc.apk'), '');
    const badManifest = scriptedHttps(releaseFixture('2.4.6', { releaseTag: 'v9.9.9' }));
    const runtime = createApkDistribution({ fs, path, https: badManifest, rootDir });
    const info = await runtime.info();
    assert.equal(info.localExists, false, 'zero bytes are never a local artifact');
    assert.equal(info.exists, false);
    assert.equal(info.remoteState, 'invalid');

    fs.rmSync(path.join(rootDir, 'public', 'multicc.apk'));
    fs.mkdirSync(path.join(rootDir, 'public', 'multicc.apk'));
    const directoryInfo = await createApkDistribution({
      fs, path, https: scriptedHttps([{ status: 404 }]), rootDir,
    }).info();
    assert.equal(directoryInfo.localExists, false, 'directories do not satisfy the local contract');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }

  const signerRoot = apkRoot();
  try {
    const wrongSigner = createApkDistribution({
      fs, path, https: scriptedHttps(releaseFixture('2.4.6', { signerSha256: 'd'.repeat(64) })), rootDir: signerRoot,
    });
    const signerInfo = await wrongSigner.info();
    assert.equal(signerInfo.exists, false, 'a self-asserted signer cannot bypass the repository certificate pin');
    assert.equal(signerInfo.remoteState, 'invalid');
    assert.equal(signerInfo.remoteReason, 'manifest_invalid');
  } finally {
    fs.rmSync(signerRoot, { recursive: true, force: true });
  }

  const invalidRoot = apkRoot('3.2.1+321', '../latest');
  const https = scriptedHttps([]);
  try {
    const runtime = createApkDistribution({ fs, path, https, rootDir: invalidRoot });
    const info = await runtime.info();
    assert.equal(info.remoteState, 'invalid_version');
    assert.equal(info.releaseTag, null);
    assert.equal(info.releaseUrl, null);
    assert.equal(https.calls.length, 0);
    const res = captureDownload();
    await runtime.downloadHandler({}, res, () => assert.fail('invalid version must terminate'));
    assert.equal(res.statusCode, 404);
  } finally {
    fs.rmSync(invalidRoot, { recursive: true, force: true });
  }
});

test('system route mount owns APK metadata and the canonical download route only', async () => {
  const paths = [];
  const apkDistribution = {
    async info() { return { exists: false, localExists: false, source: null }; },
    async downloadHandler() {},
  };
  mountSystemRoutes({
    get(route, handler) { paths.push(['GET', route, typeof handler]); },
  }, {
    fs,
    path,
    https: fakeHttps({}),
    rootDir: process.cwd(),
    networkInterfaces: () => ({}),
    getPort: () => 3000,
    authRequired: () => false,
    gitRun: async () => '',
    apkDistribution,
  });
  assert.deepEqual(paths, [
    ['GET', '/api/server-info', 'function'],
    ['GET', '/api/version-check', 'function'],
    ['GET', '/api/apk-info', 'function'],
    ['GET', '/multicc.apk', 'function'],
  ]);

  const response = { json(value) { this.body = value; } };
  await createApkInfoHandler({ apkDistribution })({}, response, error => { throw error; });
  assert.deepEqual(response.body, { exists: false, localExists: false, source: null });
});
