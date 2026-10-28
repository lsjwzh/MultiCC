'use strict';

// The plugin catalog (src/plugins/catalog.js) decides what a machine is told
// it can install, so it is judged on the things that would mislead a user:
//   • a list that does not verify against a pinned key is never used — not
//     from the network, not from a tampered cache, not from a stale mirror;
//   • every requirement maps to the state and the first reason shown;
//   • one bad entry drops only itself, an unknown requirement means
//     "a newer MultiCC can judge this", not "fine".

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CATALOG_KEYS, CATALOG_SOURCES, compareVersions, satisfies, parseCatalog, verifySignature,
  unmetRequirement, appsReferenced, computeStates, createHostFacts, createPluginCatalog,
} = require('../src/plugins/catalog');
const { createPluginsRoutes } = require('../src/routes/plugins');

const pair = crypto.generateKeyPairSync('ed25519');
const KEYS = { 'test-key': pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
const other = crypto.generateKeyPairSync('ed25519');

function sign(body, keyId = 'test-key', privateKey = pair.privateKey) {
  return JSON.stringify({ schema: 1, keyId, signature: crypto.sign(null, Buffer.from(body), privateKey).toString('base64') });
}

const SHA = 'a'.repeat(64);
const asset = name => ({ url: `https://github.com/lsjwzh/demo/releases/download/${name}`, sha256: SHA, size: 10 });
const WECHAT = { id: 'com.tencent.xinWeChat', name: '微信', nameEn: 'WeChat', minVersion: '4.0.0', macosPaths: ['/Applications/WeChat.app'] };

function sampleCatalog(over = {}) {
  return {
    schema: 1,
    updatedAt: '2026-10-28T08:00:00Z',
    plugins: [
      { id: 'chrome-proxy-launcher', name: 'Chrome 隔离出口启动器', distribution: 'builtin', builtinSince: '2.9.0', category: 'browser' },
      {
        id: 'wechat-desktop-notify', name: '微信桌面提醒', distribution: 'optional', category: 'channel', provides: ['channel'], latest: '0.2.0',
        releases: [
          { version: '0.1.0', requires: { multicc: '>=2.11.0', platforms: [{ os: 'darwin', arch: ['arm64', 'x64'], minOS: '13.0' }], apps: [WECHAT] },
            assets: { 'darwin-arm64': asset('a-0.1.0.zip'), 'darwin-x64': asset('x-0.1.0.zip') } },
          { version: '0.2.0', requires: { multicc: '>=2.13.0', agentBuild: '>=2', platforms: [{ os: 'darwin', minOS: '13.0' }], apps: [WECHAT] },
            assets: { 'darwin-arm64': asset('a-0.2.0.zip') } },
        ],
      },
    ],
    ...over,
  };
}

const HOST = {
  os: 'darwin', arch: 'arm64', osVersion: '15.3', multicc: '2.11.3', pluginApi: 1, agentBuild: 1,
  apps: { 'com.tencent.xinWeChat': { path: '/Applications/WeChat.app', version: '4.1.15' } },
};

test('versions: comparison and the three range forms the list uses', () => {
  assert.ok(compareVersions('2.11.3', '2.9.0') > 0);
  assert.ok(compareVersions('2.11.0-beta.1', '2.11.0') < 0);
  assert.equal(compareVersions('13', '13.0.0'), 0);
  assert.ok(Number.isNaN(compareVersions('abc', '1.0.0')));
  assert.equal(satisfies('2.13.0', '>=2.13.0'), true);
  assert.equal(satisfies('2.12.9', '>=2.13.0'), false);
  assert.equal(satisfies('2.99.0', '^2.13.0'), true);
  assert.equal(satisfies('3.0.0', '^2.13.0'), false);
  assert.equal(satisfies('0.3.0', '^0.2.1'), false, '^0.y pins the minor');
  assert.equal(satisfies('2.5.0', '>=2.0 <3'), true);
  assert.equal(satisfies('3.0.0', '>=2.0 <3'), false);
  assert.equal(satisfies('1.2.0', '1.2.0'), true);
  assert.equal(satisfies('1.2.1', '=1.2.0'), false);
  assert.equal(satisfies('9.9.9', '*'), true);
  assert.equal(satisfies('2', '>=2'), true, 'Agent build numbers are plain integers');
  assert.equal(satisfies('2.0.0', '>=two'), false, 'an unparsable range is never met');
});

test('signature: only the exact bytes signed by a pinned key verify', () => {
  const body = JSON.stringify(sampleCatalog());
  assert.equal(verifySignature(body, sign(body), KEYS), 'test-key');
  assert.throws(() => verifySignature(body + ' ', sign(body), KEYS), /does not match/);
  assert.throws(() => verifySignature(body, sign(body, 'test-key', other.privateKey), KEYS), /does not match/);
  assert.throws(() => verifySignature(body, sign(body, 'unknown-key'), KEYS), /not trusted/);
  assert.throws(() => verifySignature(body, 'not json', KEYS), /not JSON/);
  // The shipped key is a real ed25519 public key.
  const shipped = crypto.createPublicKey({ key: Buffer.from(Object.values(CATALOG_KEYS)[0], 'base64'), format: 'der', type: 'spki' });
  assert.equal(shipped.asymmetricKeyType, 'ed25519');
  assert.ok(CATALOG_SOURCES.every(url => url.startsWith('https://') && url.endsWith('/index.json')));
});

test('format: a bad entry drops only itself; a different schema is refused', () => {
  const data = sampleCatalog();
  data.plugins.push(
    { id: 'Bad Id', distribution: 'optional', releases: [] },
    { id: 'evil-url', distribution: 'optional', releases: [{ version: '1.0.0', assets: { 'darwin-arm64': { ...asset('x'), url: 'https://evil.example/x.zip' } } }] },
    { id: 'no-release', distribution: 'optional', releases: [] },
    { id: 'wrong-latest', distribution: 'optional', latest: '9.0.0', releases: [{ version: '1.0.0' }] },
    { id: 'bad-range', distribution: 'optional', releases: [{ version: '1.0.0', requires: { multicc: 'soon' } }] },
    { id: 'future-kind', distribution: 'bundle' },
    { id: 'chrome-proxy-launcher', distribution: 'builtin' },
  );
  const parsed = parseCatalog(JSON.stringify(data));
  assert.deepEqual(parsed.plugins.map(p => p.id), ['chrome-proxy-launcher', 'wechat-desktop-notify']);
  assert.equal(parsed.warnings.length, 7);
  assert.match(parsed.warnings.join('\n'), /evil-url: assets\.darwin-arm64\.url must be on github\.com/);
  assert.match(parsed.warnings.join('\n'), /chrome-proxy-launcher: duplicate id/);
  assert.deepEqual(parsed.plugins[1].releases.map(r => r.version), ['0.2.0', '0.1.0'], 'newest release first');
  assert.throws(() => parseCatalog(JSON.stringify({ ...data, schema: 2 })), error => error.code === 'CATALOG_SCHEMA');
  assert.throws(() => parseCatalog(JSON.stringify({ ...data, updatedAt: 'yesterday' })), /updatedAt/);
});

test('requirements: the first unmet one, cheapest-to-never-fix first', () => {
  const req = sampleCatalog().plugins[1].releases[1].requires;
  assert.deepEqual(unmetRequirement(req, { ...HOST, os: 'linux' }), { code: 'os', current: 'linux', supported: ['darwin'] });
  assert.deepEqual(unmetRequirement({ platforms: [{ os: 'darwin', arch: 'arm64' }] }, { ...HOST, arch: 'x64' }),
    { code: 'arch', current: 'x64', supported: ['arm64'] });
  assert.deepEqual(unmetRequirement(req, { ...HOST, osVersion: '12.7.6' }), { code: 'minOS', os: 'darwin', required: '13.0', current: '12.7.6' });
  assert.deepEqual(unmetRequirement(req, HOST), { code: 'multicc', required: '>=2.13.0', current: '2.11.3' });
  assert.deepEqual(unmetRequirement(req, { ...HOST, multicc: '2.13.0' }), { code: 'agentBuild', required: '>=2', current: 1 });
  assert.deepEqual(unmetRequirement(req, { ...HOST, multicc: '2.13.0', agentBuild: null }), { code: 'agentMissing', required: '>=2' });
  const ready = { ...HOST, multicc: '2.13.0', agentBuild: 2 };
  assert.equal(unmetRequirement(req, ready), null);
  assert.deepEqual(unmetRequirement(req, { ...ready, apps: {} }),
    { code: 'appMissing', app: WECHAT.id, name: '微信', nameEn: 'WeChat', required: '4.0.0' });
  assert.deepEqual(unmetRequirement(req, { ...ready, apps: { [WECHAT.id]: { version: '3.8.10' } } }),
    { code: 'appVersion', app: WECHAT.id, name: '微信', nameEn: 'WeChat', required: '4.0.0', current: '3.8.10' });
  assert.deepEqual(unmetRequirement({ pluginApi: 2 }, HOST), { code: 'pluginApi', required: 2, current: 1 });
  assert.deepEqual(unmetRequirement({ gpu: 'metal' }, HOST), { code: 'unknownRequirement', requirement: 'gpu' });
  assert.equal(unmetRequirement({ permissions: ['accessibility'] }, HOST), null, 'permissions are shown, not judged');
  assert.deepEqual(appsReferenced(parseCatalog(JSON.stringify(sampleCatalog())), []).map(app => app.id), [WECHAT.id]);
});

test('states: builtin, installed, update, installable, unsupported, incompatible, unlisted', () => {
  const catalog = parseCatalog(JSON.stringify(sampleCatalog()));
  const local = (id, version, source = 'user', extra = {}) => ({ id, version, source, name: id, description: '', requires: null, ...extra });
  const byId = rows => Object.fromEntries(rows.map(row => [row.id, row]));

  // 2.11.3 can run 0.1.0 but not 0.2.0: installable at 0.1.0, latest still 0.2.0.
  let rows = byId(computeStates({ catalog, installed: [local('chrome-proxy-launcher', '1.6.3', 'builtin')], host: HOST }));
  assert.equal(rows['chrome-proxy-launcher'].state, 'builtin');
  assert.deepEqual([rows['wechat-desktop-notify'].state, rows['wechat-desktop-notify'].candidate, rows['wechat-desktop-notify'].latest],
    ['installable', '0.1.0', '0.2.0']);
  assert.equal(rows['wechat-desktop-notify'].requires.multicc, '>=2.11.0', 'the requirements shown are those of the version offered');

  const ready = { ...HOST, multicc: '2.13.0', agentBuild: 2 };
  rows = byId(computeStates({ catalog, installed: [local('wechat-desktop-notify', '0.1.0')], host: ready }));
  assert.deepEqual([rows['wechat-desktop-notify'].state, rows['wechat-desktop-notify'].candidate], ['update', '0.2.0']);
  rows = byId(computeStates({ catalog, installed: [local('wechat-desktop-notify', '0.2.0')], host: ready }));
  assert.equal(rows['wechat-desktop-notify'].state, 'installed');
  // x64 has no 0.2.0 asset: 0.1.0 stays current there.
  rows = byId(computeStates({ catalog, installed: [local('wechat-desktop-notify', '0.1.0')], host: { ...ready, arch: 'x64' } }));
  assert.equal(rows['wechat-desktop-notify'].state, 'installed');

  // Installed version no longer fits (here: WeChat was removed).
  rows = byId(computeStates({ catalog, installed: [local('wechat-desktop-notify', '0.2.0')], host: { ...ready, apps: {} } }));
  assert.deepEqual([rows['wechat-desktop-notify'].state, rows['wechat-desktop-notify'].reason.code], ['incompatible', 'appMissing']);
  // plugin.json requirements win over the list's for an installed copy.
  rows = byId(computeStates({ catalog, installed: [local('wechat-desktop-notify', '0.2.0', 'user', { requires: { pluginApi: 3 } })], host: ready }));
  assert.equal(rows['wechat-desktop-notify'].reason.code, 'pluginApi');

  // Nothing fits: the reason of the newest release.
  rows = byId(computeStates({ catalog, installed: [], host: { ...HOST, os: 'linux', arch: 'x64', osVersion: '6.8.0' } }));
  assert.deepEqual([rows['wechat-desktop-notify'].state, rows['wechat-desktop-notify'].reason.code], ['unsupported', 'os']);
  // A builtin this copy predates, or lacks.
  rows = byId(computeStates({ catalog, installed: [], host: { ...HOST, multicc: '2.8.0' } }));
  assert.deepEqual(rows['chrome-proxy-launcher'].reason, { code: 'builtinInNewer', required: '2.9.0', current: '2.8.0' });
  rows = byId(computeStates({ catalog, installed: [], host: HOST }));
  assert.equal(rows['chrome-proxy-launcher'].reason.code, 'builtinMissing');

  // Not on the list: shown from plugin.json, with the list offline too.
  // Without the list nobody can say what is built in: everything on disk is installed, listed unknown.
  const unlisted = computeStates({ catalog: null, installed: [local('my-tool', '0.0.1'), local('chrome-proxy-launcher', '1.6.3', 'builtin')], host: HOST });
  assert.deepEqual(unlisted.map(row => [row.id, row.state, row.listed]), [['chrome-proxy-launcher', 'installed', null], ['my-tool', 'installed', null]]);
  // With the list: a folder copied into the package plugins/ (a private plugin)
  // is not a built-in just because of where it sits — it reads "installed", not
  // on the list; the listed built-in there is still built in.
  const copied = byId(computeStates({ catalog, host: HOST, installed: [
    local('chrome-proxy-launcher', '1.6.3', 'builtin'), local('gapaw-creator-workbench', '0.10.0', 'builtin'), local('my-tool', '0.0.1'),
  ] }));
  assert.deepEqual([copied['gapaw-creator-workbench'].state, copied['gapaw-creator-workbench'].listed], ['installed', false]);
  assert.deepEqual([copied['chrome-proxy-launcher'].state, copied['chrome-proxy-launcher'].listed], ['builtin', true]);
  assert.deepEqual([copied['my-tool'].state, copied['my-tool'].listed], ['installed', false]);
  // Panel order: what needs attention first.
  const order = computeStates({ catalog, installed: [local('wechat-desktop-notify', '0.1.0'), local('chrome-proxy-launcher', '1.6.3', 'builtin')], host: ready });
  assert.deepEqual(order.map(row => row.state), ['update', 'builtin']);
});

test('host facts: real lookups are cached and only for the apps the list names', async () => {
  const asked = [];
  let clock = 0;
  const facts = createHostFacts({
    platform: 'darwin', arch: 'arm64', multiccVersion: '2.11.3', now: () => clock,
    osVersion: async () => '15.3', agentBuild: async () => 1,
    appVersion: async app => { asked.push(app.id); return app.id === WECHAT.id ? { path: '/Applications/WeChat.app', version: '4.1.15' } : null; },
  });
  const first = await facts([WECHAT, { id: 'com.example.none' }]);
  assert.deepEqual(first, { os: 'darwin', arch: 'arm64', osVersion: '15.3', multicc: '2.11.3', pluginApi: 1, agentBuild: 1, apps: { [WECHAT.id]: { path: '/Applications/WeChat.app', version: '4.1.15' } } });
  await facts([WECHAT, { id: 'com.example.none' }]);
  assert.equal(asked.length, 2, 'second call within a minute is cached');
  clock = 61_000;
  await facts([WECHAT, { id: 'com.example.none' }]);
  assert.equal(asked.length, 4);
});

function fakeFetch(files, log = []) {
  return async url => {
    log.push(url);
    const body = files[url];
    if (body instanceof Error) throw body;
    if (body == null) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const buffer = Buffer.from(body);
    return { ok: true, status: 200, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length) };
  };
}

test('refresh: falls back across sources, refuses unsigned and older lists, keeps a verified cache', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-catalog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const silent = { warn() {} };
  const A = 'https://raw.example/index.json';
  const B = 'https://mirror.example/index.json';
  const v1 = JSON.stringify(sampleCatalog());
  const files = { [A]: new Error('ECONNRESET'), [B]: v1, [`${B}.sig`]: sign(v1) };
  const log = [];
  const make = (extra = {}) => createPluginCatalog({ cacheDir: dir, sources: [A, B], keys: KEYS, fetch: fakeFetch(files, log), logger: silent, env: {}, now: () => Date.parse('2026-10-28T09:00:00Z'), ...extra });

  const catalog = make();
  assert.equal(catalog.snapshot().catalog, null, 'nothing cached yet');
  let snap = await catalog.refresh();
  assert.equal(snap.source, B, 'the mirror answered after the first source failed');
  assert.equal(snap.updatedAt, '2026-10-28T08:00:00Z');
  assert.equal(snap.error, null);
  assert.ok(fs.existsSync(path.join(dir, 'index.json.sig')));

  // Unsigned / wrongly signed lists are never used and leave the good one in place.
  const v2 = JSON.stringify(sampleCatalog({ updatedAt: '2026-10-29T08:00:00Z', plugins: [] }));
  Object.assign(files, { [A]: v2, [`${A}.sig`]: sign(v2, 'test-key', other.privateKey), [B]: v2, [`${B}.sig`]: null });
  snap = await catalog.refresh();
  assert.equal(snap.updatedAt, '2026-10-28T08:00:00Z');
  assert.match(snap.error.message, /does not match.*HTTP 404/s);

  // An older (stale mirror) list is refused.
  const v0 = JSON.stringify(sampleCatalog({ updatedAt: '2026-10-01T00:00:00Z' }));
  Object.assign(files, { [A]: v0, [`${A}.sig`]: sign(v0), [B]: new Error('down') });
  snap = await catalog.refresh();
  assert.match(snap.error.message, /older than the cached list/);
  assert.equal(snap.updatedAt, '2026-10-28T08:00:00Z');

  // A fresh process loads the verified cache; a tampered cache is dropped.
  assert.equal(make().snapshot().updatedAt, '2026-10-28T08:00:00Z');
  fs.writeFileSync(path.join(dir, 'index.json'), v2);
  const warnings = [];
  assert.equal(make({ logger: { warn: (...args) => warnings.push(args) } }).snapshot().catalog, null);
  assert.equal(warnings[0][0], 'plugin_catalog_cache_rejected');

  // Concurrent refreshes share one round of requests.
  Object.assign(files, { [A]: v2, [`${A}.sig`]: sign(v2) });
  log.length = 0;
  const fresh = make();
  const [one, two] = await Promise.all([fresh.refresh(), fresh.refresh()]);
  assert.equal(one, two);
  assert.deepEqual(log, [A, `${A}.sig`]);

  // A custom source goes first; plain http is only allowed on loopback.
  assert.deepEqual(make({ env: { MULTICC_PLUGIN_CATALOG_URL: 'https://self.example/index.json' } }).sources, ['https://self.example/index.json', A, B]);
  assert.deepEqual(make({ env: { MULTICC_PLUGIN_CATALOG_URL: 'http://evil.example/index.json' } }).sources, [A, B]);
  assert.deepEqual(make({ env: { MULTICC_PLUGIN_CATALOG_URL: 'http://127.0.0.1:9/index.json' } }).sources[0], 'http://127.0.0.1:9/index.json');
});

function writePlugin(root, id, manifest = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', id), '#!/bin/sh\necho \'{"ok":true,"data":{}}\'\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    schema: 1, id, name: id, version: '0.1.0', engine: { type: 'command', binary: `bin/${id}` }, commands: ['ping'], ...manifest,
  }));
}

test('routes: built-in and installed plugins are listed together, built-in wins a clash, the catalog is merged in', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-plugin-dirs-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const builtin = path.join(tmp, 'builtin');
  const user = path.join(tmp, 'user');
  writePlugin(builtin, 'chrome-proxy-launcher', { version: '1.6.3' });
  writePlugin(user, 'chrome-proxy-launcher', { version: '9.9.9' });
  writePlugin(user, 'wechat-desktop-notify', { version: '0.1.0', provides: ['channel'], category: 'channel' });
  fs.mkdirSync(path.join(user, '.staging', 'half-done'), { recursive: true });
  const body = JSON.stringify(sampleCatalog());
  const catalog = createPluginCatalog({ cacheDir: path.join(tmp, 'cache'), sources: ['https://x.example/index.json'], keys: KEYS,
    fetch: fakeFetch({ 'https://x.example/index.json': body, 'https://x.example/index.json.sig': sign(body) }), logger: { warn() {} }, env: {} });
  await catalog.refresh();
  const hostFacts = async () => ({ ...HOST, multicc: '2.13.0', agentBuild: 2 });
  const routes = createPluginsRoutes({ pluginsDir: builtin, userPluginsDir: user, catalog, hostFacts, platform: process.platform, arch: process.arch, logger: { warn() {} } });

  const { plugins, conflicts } = routes.scan();
  assert.deepEqual(plugins.map(p => [p.id, p.source, p.version]), [['chrome-proxy-launcher', 'builtin', '1.6.3'], ['wechat-desktop-notify', 'user', '0.1.0']]);
  assert.deepEqual(conflicts, ['chrome-proxy-launcher']);
  assert.deepEqual(plugins[1].provides, ['channel']);

  const payload = await routes.catalogPayload();
  assert.equal(payload.pluginApi, 1);
  assert.equal(payload.catalog.available, true);
  assert.deepEqual(payload.plugins.map(row => [row.id, row.state, row.candidate]), [['wechat-desktop-notify', 'update', '0.2.0'], ['chrome-proxy-launcher', 'builtin', null]]);
  assert.equal(payload.plugins[0].local.source, 'user');

  // Commands and UI files resolve in the installed directory too.
  if (process.platform !== 'win32') {
    const ran = await routes.runPluginCommand('wechat-desktop-notify', 'ping', {});
    assert.equal(ran.status, 200);
  }

  // Mounted routes: list, catalog, refresh.
  const handlers = {};
  routes.mount({ get: (p, h) => { handlers[`GET ${p}`] = h; }, post: (p, h) => { handlers[`POST ${p}`] = h; } });
  const res = () => ({ code: 200, body: null, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(v) { this.body = v; return this; } });
  const list = res();
  handlers['GET /api/plugins']({}, list);
  assert.deepEqual(list.body.conflicts, ['chrome-proxy-launcher']);
  const refreshed = res();
  await handlers['POST /api/plugins/catalog/refresh']({}, refreshed);
  assert.equal(refreshed.code, 200);
  assert.equal(refreshed.body.plugins.length, 2);

  // Without a catalog the panel still lists what is installed; which of it is
  // built in is the list's call, so nothing is labelled built-in.
  const offline = createPluginsRoutes({ pluginsDir: builtin, userPluginsDir: user, hostFacts, platform: process.platform, arch: process.arch, logger: { warn() {} } });
  const quiet = await offline.catalogPayload();
  assert.equal(quiet.catalog.configured, false);
  assert.deepEqual(quiet.plugins.map(row => [row.id, row.state, row.listed]),
    [['chrome-proxy-launcher', 'installed', null], ['wechat-desktop-notify', 'installed', null]]);
  const missing = res();
  await new Promise(resolve => { offline.mount({ get() {}, post: (p, h) => { if (p.endsWith('/refresh')) resolve(h({}, missing)); } }); });
  assert.equal(missing.code, 404);
});
