'use strict';
// Air「插件」面板接上插件列表之后，用户看到的就是这一页对本机的判断，所以在真浏览器里断：
//   ① 按状态分组：本机插件（可更新 → 已装但不兼容 → 内置）、可安装、收起的「不支持本机」；
//   ② 每张卡的状态标签、要求说明、第一条不满足的原因，都由服务端的原因码拼出当前语言的文案；
//   ③ 分类筛选只留该类；刷新只发一次 POST，失败时状态行变成警示且保留旧列表；
//   ④ 已装插件仍能打开自带面板（iframe 指向 /plugins/<id>/<ui>）。
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
      row({ id: 'tab-saver', name: 'Tab Saver', category: 'browser', state: 'installable', candidate: '0.3.0', latest: '0.3.0',
        requires: { multicc: '>=2.12.0', platforms: [{ os: 'darwin', minOS: '13.0' }], permissions: ['accessibility'] } }),
      row({ id: 'linux-tray', name: 'Linux Tray', category: 'ui', state: 'unsupported', latest: '0.1.0', reason: { code: 'os', current: 'darwin', supported: ['linux'] } }),
    ],
  };
}

test('the Air plugins panel groups the plugin list by what this machine can do', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const shots = path.join(os.tmpdir(), 'multicc-air-plugins-qa');
  let refreshes = 0;
  const routes = {
    '/': { headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><meta charset="utf-8"><body style="background:#f3f6f9;padding:24px"><div id="admin-content"></div>'
      + '<script src="/i18n-catalog.js"></script><script src="/i18n.js"></script><script src="/shared/format.js"></script><script src="/air-plugins.js"></script>' },
    '/i18n-catalog.js': js('i18n-catalog.js'),
    '/i18n.js': js('i18n.js'),
    '/shared/format.js': js('shared/format.js'),
    '/air-plugins.js': js('air-plugins.js'),
    'GET /api/plugins/catalog': () => json(payload()),
    'POST /api/plugins/catalog/refresh': () => { refreshes += 1; return json(payload({ error: { message: 'fixture: all sources down', at: new Date().toISOString() } })); },
    '/plugins/chrome-proxy-launcher/ui/index.html': { headers: { 'content-type': 'text/html' }, body: '<p>launcher ui</p>' },
  };
  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/');
    assert.ok(await page.waitFor(`typeof window.MultiCCAirPlugins === 'object' && typeof window.t === 'function'`));
    await page.evaluate(`MultiCCAirPlugins.render(document.getElementById('admin-content'), {
      api: async (url, body, method) => {
        const response = await fetch(url, { method: method || 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      },
      notice: message => { window.__notice = message; },
    })`);
    const tr = (key, params) => page.evaluate(`t(${JSON.stringify(key)}, ${JSON.stringify(params || null)})`);
    const ids = selector => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(card => card.dataset.pluginId)`);
    const cardText = (id, part) => page.evaluate(`document.querySelector('[data-plugin-id="${id}"] .air-plugins-${part}')?.textContent ?? null`);

    // ① 分组与顺序
    assert.ok(await page.waitFor(`document.querySelectorAll('.air-plugins-card').length === 5`), '五张卡都画出来了');
    assert.deepEqual(await ids('#air-plugins-local .air-plugins-card'), ['wechat-desktop-notify', 'feishu-notify', 'chrome-proxy-launcher']);
    assert.deepEqual(await ids('#air-plugins-installable .air-plugins-card'), ['tab-saver']);
    assert.deepEqual(await ids('#air-plugins-unsupported .air-plugins-card'), ['linux-tray']);
    assert.equal(await page.evaluate(`document.getElementById('air-plugins-unsupported').open`), false, '不支持本机的默认收起');
    assert.equal(await page.evaluate(`document.querySelector('#air-plugins-unsupported summary').textContent`), await tr('airPluginsGroupUnsupported', { count: 1 }));

    // ② 标签、要求、原因
    assert.equal(await cardText('wechat-desktop-notify', 'tag'), await tr('airPluginsStateUpdate', { version: '0.2.0' }));
    assert.equal(await cardText('chrome-proxy-launcher', 'tag'), await tr('airPluginsStateBuiltin'));
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
    assert.ok(await page.waitFor(`document.querySelectorAll('.air-plugins-card').length === 5`));
    await page.evaluate(`document.getElementById('air-plugins-refresh').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-plugins-catalog-status')?.classList.contains('is-warn') === true`), '刷新失败要现形');
    assert.equal(refreshes, 1);
    assert.equal(await page.evaluate(`document.getElementById('air-plugins-catalog-status').title`), 'fixture: all sources down');
    assert.equal(await page.evaluate(`document.querySelectorAll('.air-plugins-card').length`), 5, '旧列表照常展示');

    // ④ 打开内置插件的面板
    await page.evaluate(`document.querySelector('[data-plugin-id="chrome-proxy-launcher"] .air-plugins-open').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.air-plugins-frame')?.getAttribute('src') === '/plugins/chrome-proxy-launcher/ui/index.html'`));
  });
});
