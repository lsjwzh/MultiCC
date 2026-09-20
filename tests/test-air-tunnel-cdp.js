'use strict';

// The regional tunnel page is intentionally native Air UI. This real-browser
// check guards the regression that prompted it: ?view=tunnel must paint the
// China/overseas split itself, never an iframe or a link back to manage.html.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const json = value => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

test('Air renders and operates the regional tunnel page without the legacy manage frame', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {};
  const publicDir = path.resolve(__dirname, '../public');
  for (const file of fs.readdirSync(publicDir).filter(name => /\.(js|css|html|svg)$/.test(name))) {
    const extension = file.slice(file.lastIndexOf('.') + 1);
    const type = extension === 'js' ? 'text/javascript' : extension === 'css' ? 'text/css'
      : extension === 'svg' ? 'image/svg+xml' : 'text/html';
    routes[`/${file}`] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': type } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(name => name.endsWith('.js'))) {
    routes[`/shared/${file}`] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: 'window.multiccWsUrl=async url=>url' };

  const directory = { id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' };
  routes['/api/air'] = () => json({ ok: true, directories: [directory], clis: ['claude'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/settings/power'] = () => json({ available: false, enabled: false });
  routes['/api/aux/config'] = () => json({ providerId: 'fixture' });
  routes['/api/server-info'] = () => json({ version: '2.0.2', uptimeMs: 1000 });
  routes['/api/version-check'] = () => json({ current: '2.0.2', latest: '2.0.2', updateAvailable: false });

  const config = {
    intervalSec: 30, failThreshold: 2, restartCooldownSec: 120, maxRestartsPerHour: 5,
    phddns: { enabled: false, monitorOnly: false, url: '' },
    natapp: { enabled: false, monitorOnly: false, url: '', port: 3000, startCmd: 'natapp -authtoken={authtoken}' },
    cpolar: { enabled: false, monitorOnly: false, url: '', port: 3000, startCmd: 'cpolar http {port}' },
    sakurafrp: { enabled: true, monitorOnly: false, url: 'https://api.example.nyat.app', authtoken: 'must-not-render', port: 3000, startCmd: 'frpc -f {authtoken}' },
    tailscale: { enabled: false, monitorOnly: false, url: '', funnel: false, funnelPort: 3000 },
  };
  const providerState = () => ({
    config,
    availability: { phddns: false, natapp: false, cpolar: false, sakurafrp: true, tailscale: true },
    providers: {
      phddns: {}, natapp: {}, cpolar: {},
      sakurafrp: { healthy: true, lastHttpCode: 200, lastCheckAt: Date.now(), lastAction: 'frpc 正在运行' },
      tailscale: config.tailscale.funnel
        ? { healthy: true, lastHttpCode: 200, lastCheckAt: Date.now(), publicUrl: 'https://air.example.ts.net' }
        : {},
    },
  });
  routes['/api/settings/tunnel'] = () => json(providerState());
  routes['POST /api/settings/tunnel'] = ({ body }) => {
    const update = JSON.parse(body.toString('utf8'));
    for (const [key, value] of Object.entries(update)) {
      config[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...config[key], ...value } : value;
    }
    return json({ ok: true, config });
  };
  routes['/api/settings/access-token'] = () => json({ hasToken: true, masked: '****1234', canEdit: true });
  routes['POST /api/settings/access-token'] = () => json({ ok: true, hasToken: true });
  routes['/api/tunnel/sakurafrp'] = () => json({ ok: true,
    user: { name: 'Air User', realname: true, signed: true, trafficUsed: 1024, trafficTotal: 1024 * 1024 },
    access: { tunnelId: 42, name: 'multicc', online: true, nodeName: '上海 BGP', needsBoundDomain: true },
    tunnelCount: 1, configUrl: config.sakurafrp.url, needsBoundDomain: true });
  routes['POST /api/tunnel/sakurafrp/install'] = () => json({ ok: true, version: '0.51.0-sakura-14', path: '/fixture/frpc' });
  routes['POST /api/tunnel/sakurafrp/public-url'] = () => json({ ok: true, url: config.sakurafrp.url });
  routes['/api/tunnel/funnel'] = () => json({ status: config.tailscale.funnel ? 'https://air.example.ts.net (Funnel on)' : 'No serve config' });
  routes['POST /api/tunnel/funnel'] = ({ body }) => {
    const update = JSON.parse(body.toString('utf8'));
    config.tailscale.funnel = update.on;
    config.tailscale.funnelPort = update.port;
    return json({ ok: true, message: update.on ? 'Funnel 已开启' : 'Funnel 已关闭', status: '' });
  };
  routes['/api/tunnel/ipv6'] = () => json({ directReady: true, host: { hasGlobalV6: true, addresses: [] }, tailscale: { ipv6: true } });
  for (const provider of ['sakurafrp', 'tailscale', 'phddns', 'natapp', 'cpolar']) {
    routes[`POST /api/tunnel/restart/${provider}`] = () => json({ ok: true, message: `${provider} 已重启` });
  }

  const shots = process.env.MULTICC_AIR_TUNNEL_QA_DIR || path.join(os.tmpdir(), 'multicc-air-tunnel-qa');
  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?view=tunnel&dir=d1');
    await page.evaluate(`window.__errors=[]; addEventListener('error',e=>__errors.push(String(e.message))); addEventListener('unhandledrejection',e=>__errors.push(String(e.reason&&e.reason.message)))`);
    assert.ok(await page.waitFor(`document.getElementById('air-sf-account').textContent.includes('Air User')`));
    assert.equal(await page.evaluate(`document.querySelector('#admin-content iframe') === null`), true, 'native tunnel page must not embed manage.html');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.air-tunnel-route > header h3')].map(el=>el.textContent)`),
      ['SakuraFrp · 樱花内网穿透', 'Tailscale Funnel']);
    assert.equal(await page.evaluate(`document.body.textContent.includes('must-not-render')`), false, 'Sakura access key must never be rendered');
    assert.equal(await page.evaluate(`document.getElementById('air-access-status').textContent`), '已保护');
    assert.match(await page.evaluate(`document.getElementById('air-ts-ipv6').textContent`), /直连已就绪/);
    const desktop = await page.screenshot('air-tunnel-desktop');
    t.diagnostic('desktop: ' + desktop);

    await page.evaluate(`window.confirm=()=>true; document.getElementById('air-ts-toggle').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-ts-toggle').textContent === '关闭 Funnel'`), 'Funnel action must repaint its stateful label');
    assert.equal(page.requests.filter(item => item.method === 'POST' && item.path === '/api/tunnel/funnel').length, 1);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
    const fit = await page.evaluate(`(() => ({ document: document.documentElement.scrollWidth <= innerWidth + 1,
      page: document.querySelector('.air-tunnel-page').getBoundingClientRect().right <= innerWidth + 1,
      columns: getComputedStyle(document.querySelector('.air-tunnel-route-grid')).gridTemplateColumns.split(' ').length }))()`);
    assert.equal(fit.document, true, 'mobile page must not create horizontal document scroll');
    assert.equal(fit.page, true, 'regional page must fit the mobile viewport');
    assert.equal(fit.columns, 1, 'regional routes stack on mobile');
    const mobile = await page.screenshot('air-tunnel-mobile-390');
    t.diagnostic('mobile: ' + mobile);
    assert.deepEqual(await page.evaluate('__errors'), []);
  });
});
