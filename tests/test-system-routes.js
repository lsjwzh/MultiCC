'use strict';

// 系统面测试。三层分工：
//   1. Node 侧剩下的系统路由：APK/iOS OTA 发布资产与四组宿主修复面板
//      （src/routes/system.js）。
//   2. 宿主端口（src/routes/system-host.js）：/api/server-info、
//      /api/version-check、/api/debug/codex-proxy-trace 已由 Rust 前门独占
//      （native/gateway/src/app/system.rs；网卡排序、semver、tag 选择、DTO
//      形状的逐字节对比在 docs/rust-migration/differential/system-scan.js），
//      Node 只剩进程事实、git ls-remote 回退与 proxy-trace 环形缓冲。
//   3. 挂载清单逐条列出：新增一条有权限/开面板含义的路由不应悄悄混进来。

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createApkInfoHandler,
  createIosOtaInfoHandler,
  mountSystemRoutes,
} = require('../src/routes/system');
const { mountSystemHostRoute, HOST_PATH } = require('../src/routes/system-host');
const { createApkDistribution } = require('../src/apk-distribution');

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

// ── 宿主端口（system-host.js）─────────────────────────────────────────────

function createHostApp() {
  const routes = new Map();
  return {
    routes,
    post(routePath, handler) { routes.set(`POST ${routePath}`, handler); },
    get(routePath, handler) { routes.set(`GET ${routePath}`, handler); },
  };
}

function mountHost(overrides = {}) {
  const app = createHostApp();
  const gitCalls = [];
  const options = {
    fs,
    path,
    rootDir: process.cwd(),
    networkInterfaces: () => ({}),
    getPort: () => 45123,
    getBindHost: () => '0.0.0.0',
    authRequired: () => null,
    gitRun: async (...args) => { gitCalls.push(args); return ''; },
    isLocal: req => req.isLocal === true,
    ...overrides,
  };
  mountSystemHostRoute(app, options);
  const handler = app.routes.get(`POST ${HOST_PATH}`);
  assert.equal(typeof handler, 'function');
  return { handler, gitCalls, app };
}

async function hostCall(handler, body, local = true) {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await handler({ body, isLocal: local }, res);
  return res;
}

test('host server-info facts carry process truth and the mount-time version', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-system-host-'));
  try {
    fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ version: '1.7.3' }));
    const interfaces = { en0: [{ family: 'IPv4', internal: false, address: '192.168.1.8' }] };
    const { handler } = mountHost({
      rootDir,
      networkInterfaces: () => interfaces,
      authRequired: () => 'token-secret',
      now: () => Date.parse('2026-07-27T05:32:00.000Z'),
      uptimeSeconds: () => 8100,
    });
    const res = await hostCall(handler, { op: 'server-info' });
    assert.deepEqual(res.body, {
      interfaces,
      bindHost: '0.0.0.0',
      port: 45123,
      authRequired: true,
      version: '1.7.3',
      startedAt: '2026-07-27T03:17:00.000Z',
      uptimeMs: 8100000,
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('host server-info omits the version when the install metadata is unreadable', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-system-host-'));
  try {
    // package.json deliberately absent: version is helpful metadata, not a
    // health dependency — the retired handler answered everything else.
    const { handler } = mountHost({ rootDir, now: () => 1000, uptimeSeconds: () => -5 });
    const res = await hostCall(handler, { op: 'server-info' });
    assert.equal(res.body.version, null);
    assert.equal(res.body.authRequired, false);
    // Negative uptime is clamped before startedAt is derived.
    assert.equal(res.body.uptimeMs, 0);
    assert.equal(res.body.startedAt, new Date(1000).toISOString());
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('host ls-remote keeps repo-actor semantics and fails soft', async () => {
  const calls = [];
  const { handler, gitCalls } = mountHost({
    rootDir: '/repo/root',
    gitRun: async (...args) => { calls.push(args); return 'aaa refs/tags/v1.0.0\nbbb refs/tags/v2.0.0\n'; },
  });
  const ok = await hostCall(handler, { op: 'ls-remote' });
  assert.deepEqual(ok.body, { ok: true, output: 'aaa refs/tags/v1.0.0\nbbb refs/tags/v2.0.0\n' });
  assert.equal(gitCalls.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/repo/root');
  assert.deepEqual(calls[0][1], ['ls-remote', '--tags', 'https://github.com/lsjwzh/MultiCC.git', 'refs/tags/v*']);
  assert.equal(calls[0][2].timeout, 15000);
  assert.equal(calls[0][2].kind, 'version-check');

  const failing = mountHost({ gitRun: async () => { throw new Error('offline'); } });
  const miss = await hostCall(failing.handler, { op: 'ls-remote' });
  assert.deepEqual(miss.body, { ok: false });
});

test('host trace snapshots the shared codex proxy trace ring', async () => {
  const proxyTrace = require('../src/codex/proxy-trace');
  const trace = proxyTrace.createCodexProxyTrace();
  proxyTrace.setSharedCodexProxyTrace(trace);
  try {
    const next = () => {};
    trace.middleware({ method: 'get', originalUrl: '/codex-proxy/p1/v1/messages' }, null, next);
    trace.middleware({ method: 'post', originalUrl: '/codex-proxy/p2/v1/messages?x=1' }, null, next);
    const { handler } = mountHost({});
    const res = await hostCall(handler, { op: 'trace', limit: 5 });
    assert.equal(res.body.entries.length, 2);
    // Newest first, and `startedAt` stays internal to the ring.
    assert.equal(res.body.entries[0].providerId, 'p2');
    assert.equal(res.body.entries[1].providerId, 'p1');
    assert.equal(Object.prototype.hasOwnProperty.call(res.body.entries[0], 'startedAt'), false);
  } finally {
    proxyTrace.setSharedCodexProxyTrace(proxyTrace.createCodexProxyTrace());
  }
});

test('host port refuses non-loopback callers and unknown operations', async () => {
  const { handler } = mountHost({});
  const remote = await hostCall(handler, { op: 'server-info' }, false);
  assert.equal(remote.statusCode, 404);
  assert.deepEqual(remote.body, { error: 'not found' });
  const unknown = await hostCall(handler, { op: 'nope' });
  assert.equal(unknown.statusCode, 400);
  assert.deepEqual(unknown.body, { error: 'unknown host operation' });
});

test('host mount validates the dependencies the front door relies on', () => {
  assert.throws(() => mountSystemHostRoute(createHostApp(), {}), /fs, path and rootDir/);
  assert.throws(
    () => mountSystemHostRoute(createHostApp(), { fs, path, rootDir: '/x', networkInterfaces: null }),
    /networkInterfaces/,
  );
  assert.throws(() => mountSystemHostRoute(null, {}), /Express/);
});

// ── APK / iOS OTA 发布资产（仍由 Node 拥有）───────────────────────────────

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

test('system route mount owns only the app-binary and host-repair routes left in Node', async () => {
  const paths = [];
  const apkDistribution = {
    async info() { return { exists: false, localExists: false, source: null }; },
    async downloadHandler() {},
  };
  const iosOta = {
    info() { return { exists: false, installable: false, installPage: '/ios-ota' }; },
    manifestHandler() {},
  };
  mountSystemRoutes({
    get(route, handler) { paths.push(['GET', route, typeof handler]); },
    post(route, handler) { paths.push(['POST', route, typeof handler]); },
  }, { apkDistribution, iosOta });
  assert.deepEqual(paths, [
    ['GET', '/api/apk-info', 'function'],
    ['GET', '/multicc.apk', 'function'],
    ['GET', '/api/ios-ota-info', 'function'],
    ['GET', '/ios-ota/manifest.plist', 'function'],
    ['GET', '/ios-ota/udid.mobileconfig', 'function'],
    ['GET', '/ios-ota/udid/result/:token', 'function'],
    ['POST', '/ios-ota/udid/callback/:token', 'function'],
    ['GET', '/api/system/developer-tools', 'function'],
    ['POST', '/api/system/developer-tools/install', 'function'],
    ['GET', '/api/system/developer-tools/install-git', 'function'],
    ['POST', '/api/system/developer-tools/install-git', 'function'],
    // Host-repair surfaces, all mounted here rather than from server.js because
    // they need no host state. Listing them exactly is the point: a new route
    // that grants privileges or opens a settings pane should not slip in
    // unnoticed. The sudoers password-free helper used to be one of these; the
    // powerd LaunchDaemon (installed by the one admin prompt that 「关盖运行」
    // already needs) replaced it, and it has no route of its own.
    ['GET', '/api/system/disk-access', 'function'],
    ['POST', '/api/system/disk-access/open', 'function'],
    // Agent desktop-permission guidance (lid mode): reads which macOS
    // permissions the Agent holds, and opens the matching System Settings
    // pane. Same reviewed family as disk-access/open above.
    ['GET', '/api/system/agent-permissions', 'function'],
    ['POST', '/api/system/agent-permissions/open', 'function'],
    ['POST', '/api/system/agent-permissions/restart', 'function'],
    // Shared-Agent install state (who installed it, which build) and the
    // user's explicit "use this copy's Agent" in a same-build conflict.
    ['GET', '/api/system/agent-install', 'function'],
    ['POST', '/api/system/agent-install/replace', 'function'],
    // Repair terminal (src/routes/ops-terminal.js): runs a shell command as
    // the service account for a host that cannot add its first directory.
    // The widest grant in this family, so it is listed one route at a time:
    // probe, job status, start, stop. It adds no privilege an authenticated
    // user lacks (the session terminal runs the same account).
    ['GET', '/api/system/ops-env', 'function'],
    ['GET', '/api/system/ops-run', 'function'],
    ['POST', '/api/system/ops-run', 'function'],
    ['POST', '/api/system/ops-run/stop', 'function'],
    // /api/server-info、/api/version-check、/api/debug/codex-proxy-trace 已由
    // Rust 前门独占（docs/gateway.md §9），不再出现在这张表里。
  ]);

  const response = { json(value) { this.body = value; } };
  await createApkInfoHandler({ apkDistribution })({}, response, error => { throw error; });
  assert.deepEqual(response.body, { exists: false, localExists: false, source: null });

  const iosResponse = { json(value) { this.body = value; } };
  createIosOtaInfoHandler({ iosOta })({}, iosResponse, error => { throw error; });
  assert.deepEqual(iosResponse.body, { exists: false, installable: false, installPage: '/ios-ota' });
});
