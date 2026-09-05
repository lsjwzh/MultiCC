'use strict';

// Contract tests for the iOS OTA distribution channel (src/ios-ota.js):
// local IPA + sidecar discovery, per-request manifest rendering (the asset URL
// must follow the caller's own scheme/host so one publish installs over
// loopback, LAN and Tailscale Funnel alike), and the auth/static wiring that
// lets the itms-services fetcher reach the manifest without a login cookie.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  IPA_NAME,
  absoluteBaseUrl,
  buildManifestXml,
  createIosOta,
  readLocalIpa,
} = require('../src/ios-ota');

const VALID_SIDECAR = {
  schemaVersion: 1,
  versionName: '2.29.12',
  versionCode: '125',
  bundleId: 'com.multicc.app',
  title: 'MultiCC',
  sha256: 'a'.repeat(64),
  size: 18,
  builtAt: '2026-09-05T12:00:00Z',
};

function makeRoot(t, { withIpa = true, sidecar = undefined, symlink = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-ios-ota-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  const ipaPath = path.join(root, 'public', IPA_NAME);
  if (symlink) {
    fs.writeFileSync(path.join(root, 'real.ipa'), 'PK fake ipa');
    fs.symlinkSync(path.join(root, 'real.ipa'), ipaPath);
  } else if (withIpa) {
    fs.writeFileSync(ipaPath, 'PK fake ipa bytes');
  }
  if (sidecar !== undefined) {
    fs.writeFileSync(`${ipaPath}.json`, typeof sidecar === 'string' ? sidecar : JSON.stringify(sidecar));
  }
  return root;
}

function depsFor(root) {
  return { fs, path, rootDir: root };
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

test('info reports a clean empty state when no IPA is published', t => {
  const root = makeRoot(t, { withIpa: false });
  const info = createIosOta(depsFor(root)).info();
  assert.equal(info.exists, false);
  assert.equal(info.installable, false);
  assert.equal(info.installPage, '/ios-ota');
});

test('info reads the sidecar metadata of a published IPA', t => {
  const root = makeRoot(t, { sidecar: VALID_SIDECAR });
  const info = createIosOta(depsFor(root)).info();
  assert.equal(info.exists, true);
  assert.equal(info.installable, true);
  assert.equal(info.versionName, '2.29.12');
  assert.equal(info.versionCode, '125');
  assert.equal(info.bundleId, 'com.multicc.app');
  assert.equal(info.sha256, 'a'.repeat(64));
  assert.equal(info.size, 17, 'lstat is authoritative, not the sidecar size field');
  assert.equal(info.builtAt, '2026-09-05T12:00:00.000Z');
});

test('a symlinked IPA is never served through the fixed public name', t => {
  const root = makeRoot(t, { symlink: true, sidecar: VALID_SIDECAR });
  assert.equal(readLocalIpa(depsFor(root)).exists, false);
  assert.equal(createIosOta(depsFor(root)).info().exists, false);
});

test('a broken sidecar leaves the IPA downloadable but not installable', t => {
  const root = makeRoot(t, { sidecar: '{not json' });
  const info = createIosOta(depsFor(root)).info();
  assert.equal(info.exists, true);
  assert.equal(info.installable, false);
  assert.equal(info.versionName, undefined);
});

test('absoluteBaseUrl prefers forwarded proto+host and sanitizes garbage', () => {
  assert.equal(
    absoluteBaseUrl({ headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mac.tail1234.ts.net', host: '127.0.0.1:3000' }, protocol: 'http' }),
    'https://mac.tail1234.ts.net');
  assert.equal(
    absoluteBaseUrl({ headers: { 'x-forwarded-proto': 'https, http', host: 'example.ts.net' }, protocol: 'http' }),
    'https://example.ts.net');
  assert.equal(
    absoluteBaseUrl({ headers: { host: '192.168.1.8:3000' }, protocol: 'http' }),
    'http://192.168.1.8:3000');
  // itms only installs over HTTPS, so an unknown scheme fails safe to https…
  assert.equal(
    absoluteBaseUrl({ headers: { 'x-forwarded-proto': 'gopher', host: 'h.example' }, protocol: 'http' }),
    'https://h.example');
  // …and a hostile Host value never reaches the plist.
  assert.equal(
    absoluteBaseUrl({ headers: { host: 'evil"><script>' }, protocol: 'https' }),
    'https://127.0.0.1');
});

test('buildManifestXml embeds the per-request asset URL and escapes metadata', () => {
  const xml = buildManifestXml(
    { bundleId: 'com.multicc.app', versionName: '2.29.12', versionCode: '125', title: 'A&B <App>' },
    'https://mac.tail1234.ts.net');
  assert.match(xml, /<!DOCTYPE plist PUBLIC/);
  assert.ok(xml.includes('<string>https://mac.tail1234.ts.net/multicc-ios.ipa</string>'));
  assert.ok(xml.includes('<key>bundle-identifier</key>\n\t\t\t\t<string>com.multicc.app</string>'));
  // bundle-version must be the CFBundleVersion build number, not the
  // marketing version — installd drops the install post-download otherwise.
  assert.ok(xml.includes('<key>bundle-version</key>\n\t\t\t\t<string>125</string>'));
  assert.ok(!xml.includes('<key>bundle-version</key>\n\t\t\t\t<string>2.29.12</string>'));
  assert.ok(xml.includes('<string>A&amp;B &lt;App&gt;</string>'));
  assert.ok(!xml.includes('A&B <App>'));
  // …and without a build number it falls back to the marketing version.
  const fallback = buildManifestXml(
    { bundleId: 'com.multicc.app', versionName: '2.29.12' }, 'https://h.ts.net');
  assert.ok(fallback.includes('<key>bundle-version</key>\n\t\t\t\t<string>2.29.12</string>'));
});

test('manifestHandler 404s without a complete publish and renders per request otherwise', t => {
  const missing = createIosOta(depsFor(makeRoot(t, { withIpa: false })));
  const res1 = fakeRes();
  missing.manifestHandler({ headers: { host: 'h.ts.net' }, protocol: 'http' }, res1);
  assert.equal(res1.statusCode, 404);
  assert.equal(res1.headers['cache-control'], 'no-store, no-cache, must-revalidate');

  const incomplete = createIosOta(depsFor(makeRoot(t, { sidecar: '{broken' })));
  const res2 = fakeRes();
  incomplete.manifestHandler({ headers: {} }, res2);
  assert.equal(res2.statusCode, 404);

  const ready = createIosOta(depsFor(makeRoot(t, { sidecar: VALID_SIDECAR })));
  const res3 = fakeRes();
  ready.manifestHandler(
    { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mac.tail1234.ts.net' }, protocol: 'http' },
    res3);
  assert.equal(res3.statusCode, 200);
  assert.equal(res3.headers['content-type'], 'text/xml; charset=utf-8');
  assert.ok(res3.body.includes('https://mac.tail1234.ts.net/multicc-ios.ipa'));
});

test('wiring: manifest + IPA bypass auth, strangers’ binaries stay hidden, routes are mounted', () => {
  const authSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
  assert.ok(authSource.includes("req.path === '/ios-ota/manifest.plist'"));
  assert.ok(authSource.includes('json|apk|ipa)$/i.test(req.path)'));

  const staticSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'static-assets.js'), 'utf8');
  assert.ok(staticSource.includes("requestedPath !== '/multicc-ios.ipa'"));
  assert.ok(staticSource.includes('/\\.(apk|ipa)$/i.test(requestedPath)'));

  const systemSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'system.js'), 'utf8');
  assert.ok(systemSource.includes("app.get('/api/ios-ota-info'"));
  assert.ok(systemSource.includes("app.get('/ios-ota/manifest.plist'"));

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSource.includes("require('./src/ios-ota').createIosOta"));
  assert.ok(serverSource.includes('apkDistribution, iosOta,'));
});
