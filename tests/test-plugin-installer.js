'use strict';

// One-click install from the plugin list (src/plugins/installer.js and the
// install / uninstall / rollback routes in src/routes/plugins.js):
//   • a package goes in only when its size and sha256 match the signed list and
//     its plugin.json carries the listed id and version; anything else leaves the
//     installed version untouched and nothing half-unpacked behind;
//   • the version it replaces is kept for one roll back, and roll back toggles;
//   • uninstall removes the program only; data folders are not the installer's;
//   • the routes accept requests from this computer only, install exactly the
//     version the list picked for this machine, and never touch built-ins.
// Downloads are served by an injected fetch; nothing here touches the network.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createZip } = require('../src/session/handoff-zip');
const { createPluginInstaller } = require('../src/plugins/installer');
const { createPluginsRoutes, readManifest, resolveBinary } = require('../src/routes/plugins');
const { parseCatalog } = require('../src/plugins/catalog');

const PLATFORM_KEY = `${process.platform}-${process.arch}`;
const POSIX = process.platform !== 'win32';

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A plugin package the way the list publishes one: optionally wrapped in a
// top-level folder, the engine binary under bin/<platform>-<arch>/.
function pluginZip({ id = 'demo-notify', version = '0.1.0', wrap = true, extra = [], manifest = {}, binary = true } = {}) {
  const prefix = wrap ? `${id}-${version}/` : '';
  const entries = [{
    name: `${prefix}plugin.json`,
    data: JSON.stringify({
      schema: 1, id, name: 'Demo', version, commands: ['ping'],
      engine: { type: 'command', binary: 'bin/demo', binaryPlatformDir: 'bin' }, ui: 'ui/index.html', ...manifest,
    }),
    mode: 0o100644,
  }, { name: `${prefix}ui/index.html`, data: `<p>${version}</p>`, mode: 0o100644 }];
  if (binary) entries.push({ name: `${prefix}bin/${PLATFORM_KEY}/demo${process.platform === 'win32' ? '.exe' : ''}`, data: `#!/bin/sh\necho ${version}\n`, mode: 0o100755 });
  return createZip([...entries, ...extra]);
}

function asset(buffer, url = 'https://github.com/lsjwzh/multicc-plugins/releases/download/demo/demo.zip') {
  return { url, size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

// url → Buffer | (() => Response)
function fakeFetch(table) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const hit = table[url];
    if (!hit) return new Response('missing', { status: 404 });
    return typeof hit === 'function' ? hit() : new Response(hit);
  };
  fetch.calls = calls;
  return fetch;
}

const inspect = (parent, id) => {
  const found = readManifest(parent, id);
  return found ? { manifest: found.manifest, binary: resolveBinary(found, process.platform, process.arch) } : null;
};

function installerFor(root, table, options = {}) {
  return createPluginInstaller({ root, fetch: fakeFetch(table), inspect, logger: { info() {}, warn() {} }, ...options });
}

const versionAt = dir => JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')).version;
const leftovers = root => (fs.existsSync(path.join(root, '.staging')) ? fs.readdirSync(path.join(root, '.staging')) : []);

test('install unpacks a matching package into <root>/<id>, executable bits intact', async () => {
  const root = tmpdir('multicc-installer-');
  const zip = pluginZip();
  const installer = installerFor(root, { 'https://example.test/a.zip': zip });
  const result = await installer.install({ id: 'demo-notify', version: '0.1.0', asset: asset(zip, 'https://example.test/a.zip') });
  assert.deepEqual(result, { id: 'demo-notify', version: '0.1.0', replaced: null });
  const dir = path.join(root, 'demo-notify');
  assert.equal(versionAt(dir), '0.1.0');
  assert.equal(fs.readFileSync(path.join(dir, 'ui', 'index.html'), 'utf8'), '<p>0.1.0</p>', 'the wrapping folder is dropped');
  if (POSIX) assert.ok(fs.statSync(path.join(dir, 'bin', PLATFORM_KEY, 'demo')).mode & 0o100, 'the engine stays executable');
  assert.deepEqual(leftovers(root), [], 'nothing left in .staging');
  assert.equal(installer.previousVersion('demo-notify'), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('update keeps the replaced version for one roll back, and roll back toggles', async () => {
  const root = tmpdir('multicc-installer-update-');
  const v1 = pluginZip({ version: '0.1.0', wrap: false });
  const v2 = pluginZip({ version: '0.2.0' });
  const installer = installerFor(root, { 'https://example.test/1.zip': v1, 'https://example.test/2.zip': v2 });
  await installer.install({ id: 'demo-notify', version: '0.1.0', asset: asset(v1, 'https://example.test/1.zip') });
  const update = await installer.install({ id: 'demo-notify', version: '0.2.0', asset: asset(v2, 'https://example.test/2.zip') });
  assert.equal(update.replaced, '0.1.0');
  assert.equal(versionAt(path.join(root, 'demo-notify')), '0.2.0');
  assert.equal(installer.previousVersion('demo-notify'), '0.1.0');

  assert.deepEqual(await installer.rollback('demo-notify'), { id: 'demo-notify', version: '0.1.0', replaced: '0.2.0' });
  assert.equal(versionAt(path.join(root, 'demo-notify')), '0.1.0');
  assert.equal(installer.previousVersion('demo-notify'), '0.2.0', 'rolling back can be undone');
  await installer.rollback('demo-notify');
  assert.equal(versionAt(path.join(root, 'demo-notify')), '0.2.0');
  assert.deepEqual(leftovers(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a package that does not match the list never replaces what is installed', async () => {
  const root = tmpdir('multicc-installer-reject-');
  const good = pluginZip({ version: '0.1.0' });
  const url = 'https://example.test/p.zip';
  const installer = installerFor(root, { [url]: good });
  await installer.install({ id: 'demo-notify', version: '0.1.0', asset: asset(good, url) });

  const attempt = async (zip, listed = asset(zip, url), version = '0.2.0', id = 'demo-notify') => {
    const one = installerFor(root, { [url]: zip });
    return one.install({ id, version, asset: listed }).then(() => null, error => error.code);
  };
  const v2 = pluginZip({ version: '0.2.0' });
  assert.equal(await attempt(v2, { ...asset(v2, url), sha256: 'f'.repeat(64) }), 'checksum');
  assert.equal(await attempt(v2, { ...asset(v2, url), size: v2.length - 1 }), 'size', 'more bytes than listed');
  assert.equal(await attempt(v2, { ...asset(v2, url), size: v2.length + 1 }), 'size', 'fewer bytes than listed');
  assert.equal(await attempt(pluginZip({ version: '0.3.0' })), 'mismatch', 'the package must be the listed version');
  assert.equal(await attempt(pluginZip({ id: 'other-plugin', version: '0.2.0' })), 'package', 'and the listed id');
  assert.equal(await attempt(pluginZip({ version: '0.2.0', binary: false })), 'package', 'no engine for this platform');
  assert.equal(await attempt(pluginZip({ version: '0.2.0', extra: [{ name: 'demo-notify-0.2.0/bin/link', data: '/etc/passwd', mode: 0o120777 }] })),
    'package', 'links are refused');
  assert.equal(await attempt(Buffer.from('not a zip at all')), 'package');
  assert.equal(await attempt(v2, asset(v2, 'https://example.test/missing.zip')), 'download');

  assert.equal(versionAt(path.join(root, 'demo-notify')), '0.1.0', 'the installed version is untouched');
  assert.equal(installer.previousVersion('demo-notify'), null, 'and no rollback point was created');
  assert.deepEqual(leftovers(root), [], 'nothing half-unpacked is left behind');
  fs.rmSync(root, { recursive: true, force: true });
});

test('download: never plain http after a redirect, a timeout gives up, one change per plugin at a time', async () => {
  const root = tmpdir('multicc-installer-dl-');
  const zip = pluginZip();
  const url = 'https://example.test/r.zip';
  const redirected = () => Object.defineProperty(new Response(zip), 'url', { value: 'http://example.test/r.zip' });
  const off = installerFor(root, { [url]: redirected });
  await assert.rejects(off.install({ id: 'demo-notify', version: '0.1.0', asset: asset(zip, url) }), { code: 'download' });

  const hanging = createPluginInstaller({
    root, inspect, logger: { info() {} }, timeoutMs: 50,
    fetch: (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  });
  await assert.rejects(hanging.install({ id: 'demo-notify', version: '0.1.0', asset: asset(zip, url) }), { code: 'download', message: /timed out/ });

  let release;
  const slow = createPluginInstaller({ root, inspect, logger: { info() {} }, fetch: () => new Promise(resolve => { release = () => resolve(new Response(zip)); }) });
  const first = slow.install({ id: 'demo-notify', version: '0.1.0', asset: asset(zip, url) });
  assert.equal(slow.isBusy('demo-notify'), true);
  await assert.rejects(slow.install({ id: 'demo-notify', version: '0.1.0', asset: asset(zip, url) }), { code: 'busy' });
  await assert.rejects(slow.uninstall('demo-notify'), { code: 'busy' });
  release();
  await first;
  assert.equal(slow.isBusy('demo-notify'), false);
  await assert.rejects(slow.install({ id: '../etc', version: '0.1.0', asset: asset(zip, url) }), { code: 'invalidId' });
  fs.rmSync(root, { recursive: true, force: true });
});

test('uninstall removes the program and its rollback copy, nothing else; stale staging is swept', async () => {
  const root = tmpdir('multicc-installer-rm-');
  const v1 = pluginZip({ version: '0.1.0' });
  const v2 = pluginZip({ version: '0.2.0' });
  const installer = installerFor(root, { 'https://example.test/1.zip': v1, 'https://example.test/2.zip': v2 });
  await installer.install({ id: 'demo-notify', version: '0.1.0', asset: asset(v1, 'https://example.test/1.zip') });
  await installer.install({ id: 'demo-notify', version: '0.2.0', asset: asset(v2, 'https://example.test/2.zip') });
  fs.mkdirSync(path.join(root, 'someone-else'), { recursive: true });
  const stale = path.join(root, '.staging', 'demo-notify.install-1-dead');
  fs.mkdirSync(stale, { recursive: true });
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);

  assert.deepEqual(await installer.uninstall('demo-notify'), { id: 'demo-notify', version: '0.2.0' });
  assert.equal(fs.existsSync(path.join(root, 'demo-notify')), false);
  assert.equal(installer.previousVersion('demo-notify'), null);
  assert.equal(fs.existsSync(path.join(root, 'someone-else')), true, 'other plugins are not touched');
  assert.equal(fs.existsSync(stale), false, 'a day-old leftover is swept');
  await assert.rejects(installer.uninstall('demo-notify'), { code: 'notInstalled' });
  await assert.rejects(installer.rollback('demo-notify'), { code: 'noPrevious' });
  fs.rmSync(root, { recursive: true, force: true });
});

// ── routes ───────────────────────────────────────────────────────────────

function catalogWith(zips) {
  const entry = (id, releases) => ({
    id, name: id, distribution: 'optional', category: 'channel',
    releases: releases.map(([version, zip, url]) => ({ version, publishedAt: '2026-10-30T00:00:00Z', assets: { [PLATFORM_KEY]: asset(zip, url) } })),
  });
  return parseCatalog(JSON.stringify({
    schema: 1,
    updatedAt: '2026-10-30T00:00:00Z',
    plugins: [
      { id: 'chrome-proxy-launcher', name: 'Chrome', distribution: 'builtin', builtinSince: '2.9.0', category: 'browser' },
      entry('demo-notify', zips.map(([version, zip]) => [version, zip, `https://github.com/lsjwzh/multicc-plugins/releases/download/demo-notify-v${version}/demo.zip`])),
    ],
  }));
}

// zips: [[version, listed bytes]]; served: the bytes actually returned, if different.
function routesFixture({ local = true, zips, served = [] }) {
  const builtinDir = tmpdir('multicc-routes-builtin-');
  const userDir = tmpdir('multicc-routes-user-');
  const builtin = path.join(builtinDir, 'chrome-proxy-launcher');
  fs.mkdirSync(path.join(builtin, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(builtin, 'plugin.json'), JSON.stringify({ id: 'chrome-proxy-launcher', version: '1.7.0', commands: ['list'], engine: { type: 'command', binary: 'bin/tool' } }));
  fs.writeFileSync(path.join(builtin, 'bin', 'tool'), '');
  const catalog = catalogWith(zips);
  const table = Object.fromEntries(catalog.plugins[1].releases.map((release, i) => [release.assets[PLATFORM_KEY].url, served[i] || zips[i][1]]));
  const fetch = fakeFetch(table);
  const state = { local };
  const runtime = createPluginsRoutes({
    pluginsDir: builtinDir, userPluginsDir: userDir, platform: process.platform, arch: process.arch,
    logger: { warn() {}, info() {} }, fetch,
    catalog: { snapshot: () => ({ catalog, source: 'test', fetchedAt: '2026-10-30T00:00:00Z', updatedAt: catalog.updatedAt, error: null }), start() {}, refresh: async () => {} },
    hostFacts: async () => ({ os: process.platform, arch: process.arch, osVersion: '15.0', multicc: '2.13.0', pluginApi: 1, agentBuild: 3, apps: {} }),
    isLocalRequest: () => state.local,
  });
  const routes = new Map();
  runtime.mount({ get: (route, handler) => routes.set(`GET ${route}`, handler), post: (route, handler) => routes.set(`POST ${route}`, handler) });
  const call = async (key, params = {}, headers = {}) => {
    const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, set() { return this; } };
    await routes.get(key)({ params, body: {}, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3000', ...headers } }, res);
    return res;
  };
  return { call, state, userDir, builtinDir, fetch, cleanup: () => [builtinDir, userDir].forEach(dir => fs.rmSync(dir, { recursive: true, force: true })) };
}

const rowOf = (body, id) => body.plugins.find(row => row.id === id);

test('routes: install the version the list picked, then update, roll back and uninstall — from this computer only', async () => {
  const v1 = pluginZip({ version: '0.1.0' });
  const v2 = pluginZip({ version: '0.2.0' });
  // Newest first, as the list keeps them.
  const f = routesFixture({ zips: [['0.2.0', v2], ['0.1.0', v1]] });

  f.state.local = false;
  const remote = await f.call('GET /api/plugins/catalog');
  assert.deepEqual(remote.body.manage, { available: true, allowed: false });
  const refused = await f.call('POST /api/plugins/:id/install', { id: 'demo-notify' });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.body.code, 'localOnly');
  assert.equal(f.fetch.calls.length, 0, 'a refused request downloads nothing');

  f.state.local = true;
  // Another website in this browser posting a form to 127.0.0.1 is local, but not MultiCC's own page.
  for (const origin of ['https://evil.example', 'http://127.0.0.1:4000', 'null']) {
    const forged = await f.call('POST /api/plugins/:id/install', { id: 'demo-notify' }, { origin });
    assert.deepEqual([forged.statusCode, forged.body.code], [403, 'crossOrigin'], origin);
  }
  assert.equal(f.fetch.calls.length, 0, 'a cross-site request downloads nothing');
  const listed = await f.call('GET /api/plugins/catalog');
  assert.deepEqual(listed.body.manage, { available: true, allowed: true });
  assert.equal(rowOf(listed.body, 'demo-notify').state, 'installable');
  assert.equal(listed.body._snapshot, undefined, 'internal fields stay internal');

  const installed = await f.call('POST /api/plugins/:id/install', { id: 'demo-notify' }, { origin: 'http://127.0.0.1:3000' });
  assert.equal(installed.statusCode, 200, JSON.stringify(installed.body));
  assert.deepEqual(installed.body.result, { id: 'demo-notify', version: '0.2.0', replaced: null }, 'the newest usable version');
  const row = rowOf(installed.body, 'demo-notify');
  assert.deepEqual([row.state, row.installedVersion, row.removable, row.rollbackVersion], ['installed', '0.2.0', true, null]);
  assert.equal(rowOf(installed.body, 'chrome-proxy-launcher').removable, false, 'a built-in is never removable');

  const again = await f.call('POST /api/plugins/:id/install', { id: 'demo-notify' });
  assert.equal(again.statusCode, 409);
  assert.equal(again.body.code, 'notInstallable', 'already on the newest version');
  const builtin = await f.call('POST /api/plugins/:id/install', { id: 'chrome-proxy-launcher' });
  assert.equal(builtin.statusCode, 404);
  assert.equal(builtin.body.code, 'notListed');
  const notThere = await f.call('POST /api/plugins/:id/uninstall', { id: 'chrome-proxy-launcher' });
  assert.equal(notThere.statusCode, 404, 'uninstall never reaches the program folder');
  assert.equal(fs.existsSync(path.join(f.builtinDir, 'chrome-proxy-launcher', 'plugin.json')), true);

  // An older copy in the user folder: the list offers the update.
  fs.rmSync(path.join(f.userDir, 'demo-notify'), { recursive: true });
  const one = createPluginInstaller({ root: f.userDir, fetch: fakeFetch({ 'https://x.test/1.zip': v1 }), inspect, logger: {} });
  await one.install({ id: 'demo-notify', version: '0.1.0', asset: asset(v1, 'https://x.test/1.zip') });
  const offered = await f.call('GET /api/plugins/catalog');
  assert.deepEqual([rowOf(offered.body, 'demo-notify').state, rowOf(offered.body, 'demo-notify').candidate], ['update', '0.2.0']);
  const updated = await f.call('POST /api/plugins/:id/install', { id: 'demo-notify' });
  assert.deepEqual(updated.body.result, { id: 'demo-notify', version: '0.2.0', replaced: '0.1.0' });
  assert.equal(rowOf(updated.body, 'demo-notify').rollbackVersion, '0.1.0');

  const back = await f.call('POST /api/plugins/:id/rollback', { id: 'demo-notify' });
  assert.equal(back.statusCode, 200);
  assert.deepEqual([rowOf(back.body, 'demo-notify').installedVersion, rowOf(back.body, 'demo-notify').rollbackVersion], ['0.1.0', '0.2.0']);

  f.state.local = false;
  assert.equal((await f.call('POST /api/plugins/:id/uninstall', { id: 'demo-notify' })).statusCode, 403);
  assert.equal((await f.call('POST /api/plugins/:id/rollback', { id: 'demo-notify' })).statusCode, 403);
  f.state.local = true;
  const removed = await f.call('POST /api/plugins/:id/uninstall', { id: 'demo-notify' });
  assert.equal(removed.statusCode, 200);
  assert.equal(rowOf(removed.body, 'demo-notify').state, 'installable');
  const broken = await f.call('POST /api/plugins/:id/rollback', { id: 'demo-notify' });
  assert.deepEqual([broken.statusCode, broken.body.code], [409, 'noPrevious']);
  f.cleanup();
});

test('routes: bytes that do not match the signed list come back as a coded error and change nothing', async () => {
  const listed = pluginZip({ version: '0.1.0' });
  // Same length, one byte different: only the sha256 can tell.
  const served = Buffer.from(listed);
  served[40] ^= 0xff;
  const f = routesFixture({ zips: [['0.1.0', listed]], served: [served] });
  const res = await f.call('POST /api/plugins/:id/install', { id: 'demo-notify' });
  assert.deepEqual([res.statusCode, res.body.code], [502, 'checksum']);
  assert.equal(fs.existsSync(path.join(f.userDir, 'demo-notify')), false);
  assert.equal(rowOf((await f.call('GET /api/plugins/catalog')).body, 'demo-notify').state, 'installable');
  f.cleanup();
});
