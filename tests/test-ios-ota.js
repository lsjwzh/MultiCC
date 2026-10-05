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

// 使用真实 HTTP 和 CMS 签名回传覆盖设备采集协议，不依赖真机或苹果账号。
const express = require('express');
const { execFileSync } = require('node:child_process');
const { createIosUdid, parseDevicePlist, TTL_MS } = require('../src/ios-udid');
const DEVICE_ID = '00008110-0012345678901234';
function deviceXml(challenge, udid = DEVICE_ID) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>UDID</key><string>${udid}</string><key>CHALLENGE</key><string>${challenge}</string><key>PRODUCT</key><string>iPhone14,7</string><key>VERSION</key><string>18.0</string></dict></plist>`;
}
async function udidHarness(t, options) {
  const app = express();
  // 与宿主相同：通用 JSON parser 在功能路由前，iOS 回传使用专用 MIME。
  app.use(express.json());
  createIosUdid(options).mountRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    async profile(secure = true, host = 'phone.example') {
      const res = await fetch(base + '/ios-ota/udid.mobileconfig', { headers: secure ? { 'x-forwarded-proto': 'https', 'x-forwarded-host': host } : {} });
      const xml = await res.text();
      return { res, xml, token: /callback\/([a-f0-9]{64})/.exec(xml)?.[1], challenge: /<key>Challenge<\/key><string>([a-f0-9]{64})/.exec(xml)?.[1] };
    },
    post(token, body, headers = {}) { return fetch(`${base}/ios-ota/udid/callback/${token}`, { method: 'POST', headers: { 'content-type': 'application/pkcs7-signature', ...headers }, body, redirect: 'manual' }); },
    get(url) { return fetch(base + new URL(url, base).pathname, { redirect: 'manual' }); },
  };
}

test('UDID：HTTPS 下载、真实 CMS 回传、单次使用和设备信息不进入查询参数', async t => {
  const root = makeRoot(t, { withIpa: false });
  const key = path.join(root, 'test.key'), cert = path.join(root, 'test.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=UDID-Test'], { stdio: 'ignore', timeout: 10000 });
  const h = await udidHarness(t);
  assert.equal((await h.profile(false)).res.status, 400);
  const p = await h.profile();
  assert.equal(p.res.status, 200);
  assert.match(p.res.headers.get('content-type'), /application\/x-apple-aspen-config/);
  assert.equal(p.res.headers.get('cache-control'), 'no-store');
  assert.ok(p.xml.includes('https://phone.example/ios-ota/udid/callback/'));
  assert.ok(!/SERIAL|IMEI|com.apple.mdm|com.apple.security/.test(p.xml));
  const signed = execFileSync('openssl', ['cms', '-sign', '-signer', cert, '-inkey', key, '-outform', 'DER', '-nodetach', '-binary'], { input: deviceXml(p.challenge), timeout: 5000 });
  const response = await h.post(p.token, signed);
  assert.equal(response.status, 301);
  const location = new URL(response.headers.get('location'), 'https://phone.example');
  assert.equal(location.origin, 'https://phone.example');
  assert.match(location.pathname, /^\/ios-ota\/udid\/result\/[a-f0-9]{64}$/);
  assert.equal(location.search, '');
  assert.equal(location.hash, '');
  assert.ok(!location.href.includes(DEVICE_ID));
  assert.ok(!location.href.includes(p.token), '结果与回传不共用令牌');
  const result = await h.get(location.href);
  assert.equal(result.status, 200);
  assert.match(result.headers.get('content-type'), /text\/html/);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.ok((await result.text()).includes(DEVICE_ID));
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await h.post(p.token, signed)).status, 410);
  const invalid = await h.profile();
  assert.equal((await h.post(invalid.token, Buffer.from('invalid CMS'))).status, 400);
});

test('UDID：未知/过期令牌、错误挑战、超限载荷均拒绝且不泄漏信息', async t => {
  let time = 1000, decoded = '';
  const h = await udidHarness(t, { now: () => time, decode: async () => decoded });
  assert.equal((await h.post('a'.repeat(64), 'body')).status, 410);
  const p = await h.profile();
  decoded = deviceXml('b'.repeat(64));
  assert.equal((await h.post(p.token, 'body')).status, 400);
  assert.equal((await h.post(p.token, Buffer.alloc(65537))).status, 413);
  decoded = deviceXml(p.challenge);
  const response = await h.post(p.token, 'body');
  assert.equal(response.status, 301, '无效提交不消耗正确令牌');
  assert.equal((await h.get('/ios-ota/udid/result/' + 'a'.repeat(64))).status, 410);
  assert.equal((await h.get('/ios-ota/udid/result/' + p.token)).status, 410);
  const expired = await h.profile();
  time += TTL_MS;
  assert.equal((await h.post(expired.token, 'body')).status, 410);
  const result = await h.get(response.headers.get('location'));
  assert.equal(result.status, 410);
  assert.ok(!(await result.text()).includes(DEVICE_ID));
});

test('UDID：严格解析合法格式，拒绝重复键、实体和伪装的嵌套内容', () => {
  const xml = deviceXml('a'.repeat(64));
  assert.equal(parseDevicePlist(xml).udid, DEVICE_ID);
  assert.equal(parseDevicePlist(deviceXml('a'.repeat(64), 'b'.repeat(40))).udid, 'b'.repeat(40));
  assert.throws(() => parseDevicePlist(deviceXml('a'.repeat(64), 'not-a-udid')));
  assert.throws(() => parseDevicePlist(xml.replace('</dict>', '<key>UDID</key><string>x</string></dict>')));
  assert.throws(() => parseDevicePlist(xml.replace('iPhone14,7', '&entity;')));
  assert.throws(() => parseDevicePlist(xml.replace('<dict>', '<dict><array>')));
  assert.throws(() => parseDevicePlist(xml.replace('<plist', '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><plist')));
});

test('UDID：浏览器读取并移除地址中的设备信息，HTTP 禁止下载且复制失败可手动复制', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../public/ios-udid.js'), 'utf8');
  function page(protocol, hash) {
    const elements = new Map();
    const removed = [];
    const sandbox = { URLSearchParams, location: { protocol, hash, pathname: '/ios-ota', search: '' },
      navigator: { userAgent: 'iPhone', clipboard: { writeText: async () => { throw new Error('denied'); } } },
      history: { replaceState: (...args) => removed.push(args) }, t: key => key,
      document: { getElementById(id) {
        if (!elements.has(id)) elements.set(id, { hidden: true, attrs: {}, handlers: {},
          removeAttribute(key) { delete this.attrs[key]; }, setAttribute(key, value) { this.attrs[key] = value; },
          getAttribute(key) { return this.attrs[key]; }, addEventListener(key, fn) { this.handlers[key] = fn; },
          focus() {}, select() { this.selected = true; }, setSelectionRange() {},
        });
        return elements.get(id);
      } },
    };
    vm.runInNewContext(source, sandbox);
    return { elements, removed };
  }
  const p = page('https:', '#udid=' + DEVICE_ID + '&product=iPhone14%2C7');
  assert.equal(p.elements.get('udid-result').hidden, false);
  assert.equal(p.elements.get('udid-value').value, DEVICE_ID);
  assert.equal(p.removed[0][2], '/ios-ota');
  await p.elements.get('udid-copy').handlers.click();
  assert.equal(p.elements.get('udid-value').selected, true);
  const insecure = page('http:', '');
  assert.equal(insecure.elements.get('udid-start').attrs['aria-disabled'], 'true');
});

test('UDID：不同用户的外网和内网入口分别生成地址，回传请求不能改写结果域名', async t => {
  const h = await udidHarness(t, { decode: async body => body.toString() });
  for (const host of ['one.example:4443', 'two.example', '192.168.50.20:8443']) {
    const p = await h.profile(true, host);
    assert.ok(p.xml.includes(`https://${host}/ios-ota/udid/callback/`));
    const response = await h.post(p.token, deviceXml(p.challenge), { 'x-forwarded-host': 'unrelated.example', 'x-forwarded-proto': 'http' });
    assert.equal(response.status, 301);
    assert.equal(new URL(response.headers.get('location')).origin, `https://${host}`);
    assert.equal((await h.get(response.headers.get('location'))).status, 200);
  }
});

test('UDID：结果页面对设备内容进行 HTML 转义', () => {
  const { resultPage } = require('../src/ios-udid');
  const html = resultPage({ udid: DEVICE_ID, product: '<img src=x onerror=alert(1)>', version: '"&' });
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(!resultPage().includes(DEVICE_ID));
});
