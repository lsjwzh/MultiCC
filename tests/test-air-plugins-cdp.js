'use strict';
// Air「插件」面板接上插件列表之后，用户看到的就是这一页对本机的判断，所以在真浏览器里断：
//   ① 按状态分组：本机插件（可更新 → 已装但不兼容 → 内置）、可安装、收起的「不支持本机」；
//   ② 每张卡的状态标签、要求说明、第一条不满足的原因，都由服务端的原因码拼出当前语言的文案；
//   ③ 分类筛选只留该类；刷新只发一次 POST，失败时状态行变成警示且保留旧列表；
//   ④ 已装插件仍能打开自带面板（iframe 指向 /plugins/<id>/<ui>）；
//   ⑤ 放在程序目录里的私有插件：显示「已安装」+「本地插件」，不当成内置，也不催着挪目录；
//   ⑥ 新网页配还没重启的旧服务（没有 /api/plugins/catalog）：退回旧清单照常列出，不报加载失败；
//   ⑦ 一键安装 / 更新 / 退回 / 卸载：按钮只出现在该出现的卡上，点了发对应的 POST 并按返回的清单重画；
//      失败按错误码显示原因、原版本不动；不是这台电脑打开的页面，按钮置灰并写明原因。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const publicDir = path.resolve(__dirname, '../public');
const js = file => ({ headers: { 'content-type': 'text/javascript' }, body: fs.readFileSync(path.join(publicDir, file)) });
const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const local = (id, version, ui = 'ui/index.html') => ({
  id, version, source: id === 'chrome-proxy-launcher' ? 'builtin' : 'user', name: id, description: '', ui,
  engine: { type: 'command', available: true, reason: null },
});
const row = over => ({
  icon: '🧩', category: null, provides: [], distribution: 'optional', summary: '', summaryEn: null, homepage: null,
  listed: true, local: null, reason: null, installedVersion: null, candidate: null, latest: null, requires: null, nameEn: null, ...over,
});

function payload({ error = null } = {}) {
  return {
    pluginApi: 1,
    host: { os: 'darwin', arch: 'arm64', osVersion: '15.3', multicc: '2.13.0', agentBuild: 2 },
    catalog: { available: true, configured: true, updatedAt: '2026-10-28T08:00:00Z', fetchedAt: new Date(Date.now() - 180000).toISOString(), source: 'https://raw.githubusercontent.com/lsjwzh/multicc-plugins/main/index.json', error },
    conflicts: [],
    plugins: [
      row({ id: 'wechat-desktop-notify', name: '微信桌面提醒', category: 'channel', state: 'update', installedVersion: '0.1.0', candidate: '0.2.0', latest: '0.2.0', local: local('wechat-desktop-notify', '0.1.0'), homepage: 'https://github.com/lsjwzh/multicc-wechat-notify' }),
      row({ id: 'feishu-notify', name: 'Feishu', category: 'channel', state: 'incompatible', installedVersion: '1.0.0', local: local('feishu-notify', '1.0.0', null),
        reason: { code: 'appMissing', app: 'com.electron.lark', name: '飞书', nameEn: 'Lark', required: '7.0.0' } }),
      row({ id: 'chrome-proxy-launcher', name: 'Chrome 隔离出口启动器', category: 'browser', distribution: 'builtin', state: 'builtin', installedVersion: '1.6.3', local: local('chrome-proxy-launcher', '1.6.3') }),
      row({ id: 'gapaw-creator-workbench', name: 'Gapaw 达人工作台', distribution: null, state: 'installed', listed: false, installedVersion: '0.10.0',
        local: { ...local('gapaw-creator-workbench', '0.10.0'), source: 'builtin' } }),
      row({ id: 'tab-saver', name: 'Tab Saver', category: 'browser', state: 'installable', candidate: '0.3.0', latest: '0.3.0',
        requires: { multicc: '>=2.12.0', platforms: [{ os: 'darwin', minOS: '13.0' }], permissions: ['accessibility'] } }),
      row({ id: 'linux-tray', name: 'Linux Tray', category: 'ui', state: 'unsupported', latest: '0.1.0', reason: { code: 'os', current: 'darwin', supported: ['linux'] } }),
    ],
  };
}

const pageRoutes = () => ({
  '/': { headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><meta charset="utf-8"><body style="background:#f3f6f9;padding:24px"><div id="admin-content"></div>'
    + '<script src="/i18n-catalog.js"></script><script src="/i18n.js"></script><script src="/shared/format.js"></script><script src="/air-plugins.js"></script>' },
  '/i18n-catalog.js': js('i18n-catalog.js'),
  '/i18n.js': js('i18n.js'),
  '/shared/format.js': js('shared/format.js'),
  '/air-plugins.js': js('air-plugins.js'),
});
const RENDER = `MultiCCAirPlugins.render(document.getElementById('admin-content'), {
  api: async (url, body, method) => {
    const response = await fetch(url, { method: method || 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    // 和 air.js 的 api() 一样：失败时把服务端返回的字段（code 等）并进错误对象。
    const result = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error((result && result.error) || 'HTTP ' + response.status), result || {});
    return result;
  },
  notice: message => { window.__notice = message; },
})`;

test('the Air plugins panel groups the plugin list by what this machine can do', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const shots = path.join(os.tmpdir(), 'multicc-air-plugins-qa');
  let refreshes = 0;
  const routes = {
    ...pageRoutes(),
    'GET /api/plugins/catalog': () => json(payload()),
    'POST /api/plugins/catalog/refresh': () => { refreshes += 1; return json(payload({ error: { message: 'fixture: all sources down', at: new Date().toISOString() } })); },
    '/plugins/chrome-proxy-launcher/ui/index.html': { headers: { 'content-type': 'text/html' }, body: '<p>launcher ui</p>' },
  };
  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/');
    assert.ok(await page.waitFor(`typeof window.MultiCCAirPlugins === 'object' && typeof window.t === 'function'`));
    await page.evaluate(RENDER);
    const tr = (key, params) => page.evaluate(`t(${JSON.stringify(key)}, ${JSON.stringify(params || null)})`);
    const ids = selector => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(card => card.dataset.pluginId)`);
    const cardText = (id, part) => page.evaluate(`document.querySelector('[data-plugin-id="${id}"] .air-plugins-${part}')?.textContent ?? null`);

    // ① 分组与顺序
    assert.ok(await page.waitFor(`document.querySelectorAll('.air-plugins-card').length === 6`), '六张卡都画出来了');
    assert.deepEqual(await ids('#air-plugins-local .air-plugins-card'), ['wechat-desktop-notify', 'feishu-notify', 'chrome-proxy-launcher', 'gapaw-creator-workbench']);
    assert.deepEqual(await ids('#air-plugins-installable .air-plugins-card'), ['tab-saver']);
    assert.deepEqual(await ids('#air-plugins-unsupported .air-plugins-card'), ['linux-tray']);
    assert.equal(await page.evaluate(`document.getElementById('air-plugins-unsupported').open`), false, '不支持本机的默认收起');
    assert.equal(await page.evaluate(`document.querySelector('#air-plugins-unsupported summary').textContent`), await tr('airPluginsGroupUnsupported', { count: 1 }));

    // ② 标签、要求、原因
    assert.equal(await cardText('wechat-desktop-notify', 'tag'), await tr('airPluginsStateUpdate', { version: '0.2.0' }));
    assert.equal(await cardText('chrome-proxy-launcher', 'tag'), await tr('airPluginsStateBuiltin'));
    // ⑤ 私有插件：状态是「已安装」+「本地插件」，卡片上没有别的提示行。
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('[data-plugin-id="gapaw-creator-workbench"] .air-plugins-tag')].map(n => n.textContent)`),
      [await tr('airPluginsStateInstalled'), await tr('airPluginsUnlisted')]);
    assert.equal(await page.evaluate(`document.querySelectorAll('[data-plugin-id="gapaw-creator-workbench"] .air-plugins-meta').length`), 0);
    assert.equal(await cardText('feishu-notify', 'why'), await tr('airPluginsWhyAppMissingMin', { name: await page.evaluate(`getLang() === 'en' ? 'Lark' : '飞书'`), required: '7.0.0' }));
    assert.equal(await cardText('linux-tray', 'why'), await tr('airPluginsWhyOs', { supported: 'Linux' }));
    const needs = await cardText('tab-saver', 'meta');
    for (const piece of [await tr('airPluginsNeedsMin', { name: 'macOS', version: '13.0' }), 'MultiCC >=2.12.0', await tr('airPluginsPermAccessibility')]) {
      assert.ok(needs.includes(piece), `${needs} 里应有 ${piece}`);
    }
    assert.equal(await page.evaluate(`document.querySelector('[data-plugin-id="tab-saver"] .air-plugins-open')`), null, '没装的插件没有「打开」');
    assert.equal(await page.evaluate(`document.querySelector('[data-plugin-id="feishu-notify"] .air-plugins-open').disabled`), true, '没有自带界面的打不开');
    assert.equal(await page.evaluate(`document.querySelector('[data-plugin-id="wechat-desktop-notify"] .air-plugins-link').href`), 'https://github.com/lsjwzh/multicc-wechat-notify');
    assert.equal(await page.evaluate(`document.getElementById('air-plugins-catalog-status').classList.contains('is-warn')`), false);
    await page.evaluate(`document.getElementById('air-plugins-unsupported').open = true`);
    await page.screenshot('01-plugins-grouped');

    // ③ 分类筛选、刷新失败
    await page.evaluate(`document.querySelector('.air-plugins-chip[data-category="browser"]').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('.air-plugins-card').length === 2`));
    assert.deepEqual(await ids('.air-plugins-card'), ['chrome-proxy-launcher', 'tab-saver']);
    await page.evaluate(`document.querySelector('.air-plugins-chip[data-category=""]').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('.air-plugins-card').length === 6`));
    await page.evaluate(`document.getElementById('air-plugins-refresh').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-plugins-catalog-status')?.classList.contains('is-warn') === true`), '刷新失败要现形');
    assert.equal(refreshes, 1);
    assert.equal(await page.evaluate(`document.getElementById('air-plugins-catalog-status').title`), 'fixture: all sources down');
    assert.equal(await page.evaluate(`document.querySelectorAll('.air-plugins-card').length`), 6, '旧列表照常展示');

    // ④ 打开内置插件的面板
    await page.evaluate(`document.querySelector('[data-plugin-id="chrome-proxy-launcher"] .air-plugins-open').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.air-plugins-frame')?.getAttribute('src') === '/plugins/chrome-proxy-launcher/ui/index.html'`));
  });
});

test('a new panel on a server not restarted yet falls back to the old plugin list', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const shots = path.join(os.tmpdir(), 'multicc-air-plugins-qa');
  const routes = {
    ...pageRoutes(),
    // 旧服务：没有 catalog 接口，/api/plugins 是旧格式（没有 source/conflicts）。
    'GET /api/plugins/catalog': { status: 404, headers: { 'content-type': 'text/html' }, body: '<pre>Cannot GET /api/plugins/catalog</pre>' },
    'GET /api/plugins': () => json({ plugins: [
      { id: 'chrome-proxy-launcher', name: 'Chrome 隔离出口启动器', version: '1.6.3', description: 'launcher', icon: '🌐', ui: 'ui/index.html', engine: { type: 'command', available: true, reason: null } },
      { id: 'gapaw-creator-workbench', name: 'Gapaw 达人工作台', version: '0.10.0', description: 'workbench', icon: '🧩', ui: 'ui/index.html', engine: { type: 'command', available: true, reason: null } },
    ] }),
    '/plugins/gapaw-creator-workbench/ui/index.html': { headers: { 'content-type': 'text/html' }, body: '<p>workbench ui</p>' },
  };
  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/');
    assert.ok(await page.waitFor(`typeof window.MultiCCAirPlugins === 'object' && typeof window.t === 'function'`));
    await page.evaluate(RENDER);
    const tr = key => page.evaluate(`t(${JSON.stringify(key)})`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-plugins-local .air-plugins-card').length === 2`), '两个本机插件都列出来了');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.air-plugins-card')].map(n => [n.dataset.pluginId, n.querySelector('.air-plugins-tag').textContent, n.querySelectorAll('.air-plugins-tag').length])`),
      [['chrome-proxy-launcher', await tr('airPluginsStateInstalled'), 1], ['gapaw-creator-workbench', await tr('airPluginsStateInstalled'), 1]], '说不上内置与否、在不在列表里');
    assert.equal(await page.evaluate(`document.getElementById('air-plugins-catalog-status').textContent`), await tr('airPluginsCatalogUnavailable'));
    assert.equal(await page.evaluate(`document.getElementById('air-plugins-catalog-status').classList.contains('is-warn')`), true);
    assert.equal(await page.evaluate(`document.getElementById('air-plugins-refresh')`), null, '旧服务没有刷新接口，不给按钮');
    assert.equal(await page.evaluate(`window.__notice ?? null`), null, '不报加载失败');
    assert.equal(await page.evaluate(`document.querySelector('.air-plugins-empty')`), null, '不显示「还没有安装插件」');
    await page.screenshot('02-plugins-legacy-server');
    await page.evaluate(`document.querySelector('[data-plugin-id="gapaw-creator-workbench"] .air-plugins-open').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.air-plugins-frame')?.getAttribute('src') === '/plugins/gapaw-creator-workbench/ui/index.html'`), '照样能打开插件自带的界面');
  });
});

test('one-click install, update, roll back and uninstall from the plugin cards', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const shots = path.join(os.tmpdir(), 'multicc-air-plugins-qa');
  let allowed = true;
  const posts = [];
  const withManage = body => ({ ...body, manage: { available: true, allowed } });
  const base = () => {
    const body = payload();
    const wechat = body.plugins.find(item => item.id === 'wechat-desktop-notify');
    Object.assign(wechat, { removable: true, rollbackVersion: '0.0.9' });
    return withManage(body);
  };
  const afterInstall = () => {
    const body = base();
    const tab = body.plugins.find(item => item.id === 'tab-saver');
    Object.assign(tab, { state: 'installed', installedVersion: '0.3.0', candidate: null, removable: true, local: local('tab-saver', '0.3.0') });
    return body;
  };
  const afterUninstall = () => {
    const body = afterInstall();
    const wechat = body.plugins.find(item => item.id === 'wechat-desktop-notify');
    Object.assign(wechat, { state: 'installable', installedVersion: null, candidate: '0.2.0', removable: false, rollbackVersion: null, local: null });
    return body;
  };
  const routes = {
    ...pageRoutes(),
    'GET /api/plugins/catalog': () => json(base()),
    'POST /api/plugins/tab-saver/install': () => { posts.push('tab-saver/install'); return json({ ok: true, ...afterInstall() }); },
    'POST /api/plugins/wechat-desktop-notify/install': () => { posts.push('wechat/install'); return { status: 502, ...json({ code: 'checksum', error: 'sha256 does not match the list' }) }; },
    'POST /api/plugins/wechat-desktop-notify/uninstall': () => { posts.push('wechat/uninstall'); return json({ ok: true, ...afterUninstall() }); },
  };
  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/');
    assert.ok(await page.waitFor(`typeof window.MultiCCAirPlugins === 'object' && typeof window.t === 'function'`));
    await page.evaluate(RENDER);
    const tr = (key, params) => page.evaluate(`t(${JSON.stringify(key)}, ${JSON.stringify(params || null)})`);
    const actions = id => page.evaluate(`[...document.querySelectorAll('[data-plugin-id="${id}"] .air-plugins-actions button')].map(b => [b.dataset.action, b.textContent, b.disabled])`);
    assert.ok(await page.waitFor(`document.querySelectorAll('.air-plugins-card').length === 6`));

    assert.deepEqual(await actions('tab-saver'), [['install', await tr('airPluginsInstall', { version: '0.3.0' }), false]]);
    assert.deepEqual(await actions('wechat-desktop-notify'), [
      ['install', await tr('airPluginsUpdate', { version: '0.2.0' }), false],
      ['rollback', await tr('airPluginsRollback', { version: '0.0.9' }), false],
      ['uninstall', await tr('airPluginsUninstall'), false],
    ]);
    for (const id of ['chrome-proxy-launcher', 'gapaw-creator-workbench', 'feishu-notify', 'linux-tray']) {
      assert.deepEqual(await actions(id), [], `${id} 没有装卸按钮（内置、放在程序目录里、不是从列表装的、不支持本机）`);
    }
    await page.screenshot('03-plugins-actions');

    // 安装：发一次 POST，按返回的清单重画，卡片挪到「本机插件」。
    await page.evaluate(`document.querySelector('[data-plugin-id="tab-saver"] [data-action="install"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#air-plugins-local [data-plugin-id="tab-saver"]') !== null`), '装好后进本机插件');
    assert.deepEqual(posts, ['tab-saver/install']);
    assert.deepEqual(await actions('tab-saver'), [['uninstall', await tr('airPluginsUninstall'), false]]);

    // 更新失败：按错误码写原因，版本不变。
    await page.evaluate(`document.querySelector('[data-plugin-id="wechat-desktop-notify"] [data-action="install"]').click()`);
    assert.ok(await page.waitFor(`!!document.querySelector('[data-plugin-id="wechat-desktop-notify"] .air-plugins-why')`));
    assert.equal(await page.evaluate(`document.querySelector('[data-plugin-id="wechat-desktop-notify"] .air-plugins-why').textContent`),
      await tr('airPluginsActionFailed', { error: await tr('airPluginsErrChecksum') }));
    assert.equal(await page.evaluate(`document.querySelector('[data-plugin-id="wechat-desktop-notify"] .air-plugins-version').textContent`), 'v0.1.0');

    // 卸载要先确认：取消就不发请求。
    await page.evaluate(`window.confirm = () => false; document.querySelector('[data-plugin-id="wechat-desktop-notify"] [data-action="uninstall"]').click()`);
    assert.deepEqual(posts, ['tab-saver/install', 'wechat/install']);
    await page.evaluate(`window.__asked = ''; window.confirm = text => { window.__asked = text; return true; }; document.querySelector('[data-plugin-id="wechat-desktop-notify"] [data-action="uninstall"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#air-plugins-installable [data-plugin-id="wechat-desktop-notify"]') !== null`));
    assert.equal(await page.evaluate('window.__asked'), await tr('airPluginsUninstallConfirm', { name: '微信桌面提醒' }));
    assert.deepEqual(posts, ['tab-saver/install', 'wechat/install', 'wechat/uninstall']);

    // 从手机或远程打开：按钮置灰、写明原因，点了也不发请求。
    allowed = false;
    await page.evaluate('MultiCCAirPlugins.refresh()');
    assert.ok(await page.waitFor(`[...document.querySelectorAll('.air-plugins-actions button')].length > 0 && [...document.querySelectorAll('.air-plugins-actions button')].every(b => b.disabled)`));
    assert.equal(await page.evaluate(`document.querySelector('[data-plugin-id="tab-saver"] [data-action="install"]').title`), await tr('airPluginsLocalOnly'));
    assert.ok((await page.evaluate(`document.querySelector('.air-plugins-bar').textContent`)).includes(await tr('airPluginsLocalOnly')));
    await page.screenshot('04-plugins-remote');
  });
});
