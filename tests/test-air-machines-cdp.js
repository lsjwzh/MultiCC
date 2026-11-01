'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');
const json = value => ({ headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(value) });
function assets() {
  const routes = {};
  const root = path.resolve(__dirname, '../public');
  for (const name of fs.readdirSync(root).filter(n => /\.(html|css|js|svg)$/.test(n))) {
    const ext = path.extname(name), type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[ext];
    routes[`/${name}`] = { headers: { 'content-type': `${type}; charset=utf-8` }, body: fs.readFileSync(path.join(root, name)) };
  }
  for (const name of fs.readdirSync(path.join(root, 'shared')).filter(n => n.endsWith('.js'))) routes[`/shared/${name}`] = {
    headers: { 'content-type': 'text/javascript' }, body: fs.readFileSync(path.join(root, 'shared', name)),
  };
  routes['/air'] = routes['/air.html'];
  return routes;
}
test('real console keeps the entry sidebar and remote frame scoped through refreshes', { timeout: 45000 }, async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = assets();
  const snapshot = name => ({ ok: true, directories: [{ id: 'same-dir', name, path: `/projects/${name}` }], tasks: [], sessions: [], clis: ['codex'], migration: { errors: [] } });
  routes['/api/air'] = json(snapshot('入口目录'));
  routes['/api/cron'] = json([]); routes['/api/ui-layout'] = json({});
  routes['/api/docs-registry'] = json([]); routes['/api/external-fleets'] = json({ fleets: [] });
  routes['/api/settings/power'] = json({ available: false });
  routes['/api/aux/config'] = json({ providerId: 'configured' });
  routes['/api/machines'] = json({ self: { id: 'machine_entry', name: '入口电脑', local: true }, machines: [{ id: 'machine_remote', name: '工作电脑', local: false, origin: 'https://remote.example' }] });
  routes['/api/machines/self'] = json({ id: 'machine_entry', name: '入口电脑', local: true });
  routes['/api/machines/machine_remote/proxy/api/machines/self'] = json({ id: 'machine_remote', name: '工作电脑', local: true });
  routes['/api/machines/machine_remote/proxy/api/air'] = json(snapshot('远程目录'));
  routes['/api/machines/machine_remote/proxy/api/external-fleets'] = json({ fleets: [] });
  routes['/api/machines/machine_remote/proxy/api/value'] = json({ target: 'remote' });
  routes['POST /api/auth/exchange'] = json({ ok: true });
  routes['/api/machines/machine_remote/proxy/api/download'] = { headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'remote file contents' };
  routes['POST /api/auth/ws-ticket'] = ({ body }) => json({ ticket: 'fixture', path: JSON.parse(body).path });
  routes['POST /api/machines/machine_remote/ws-ticket'] = ({ body }) => json({ ticket: 'scoped-fixture', path: JSON.parse(body).path.split('?')[0], proxyPath: '/ws/machines/machine_remote' });
  await withCdpHarness({ routes, locale: 'zh-CN', screenshotDir: path.join(os.tmpdir(), 'multicc-computers-qa') }, async page => {
    await page.navigate('/air');
    assert.ok(await page.waitFor('document.getElementById("console-view-machines")'));
    await page.evaluate('document.getElementById("console-view-machines").click()');
    assert.ok(await page.waitFor('document.querySelector(".machine-tabs")?.textContent.includes("工作电脑")'));
    await page.evaluate('document.querySelectorAll(".machine-tabs button")[1].click()');
    assert.ok(await page.waitFor('document.querySelector(".machine-panel")?.textContent.includes("远程目录")'));
    await page.evaluate('document.querySelector(".machine-directory").click()');
    assert.ok(await page.waitFor('document.querySelector(".machine-frame")?.contentWindow.MultiCCMachineScope?.id === "machine_remote"'));
    await page.evaluate(`const doc = document.querySelector('.machine-frame').contentDocument; const save = doc.createElement('button'); save.id = 'target-save-probe'; save.textContent = '保存'; doc.body.append(save);`);
    assert.ok(await page.waitFor('document.querySelector(".machine-frame").contentDocument.getElementById("target-save-probe")?.textContent === "保存到 工作电脑"'));
    assert.ok(await page.waitFor('document.querySelector(".machine-frame").contentDocument.querySelector("a[data-i18n=airLogout]")?.href.includes("machine=machine_remote")'));
    const terminalLink = await page.evaluate(`document.querySelector('.machine-frame').contentWindow.MultiCCMachineScope.navigation('/?id=remote-terminal')`);
    assert.equal(new URL(terminalLink).searchParams.get('machine'), 'machine_remote');
    assert.equal(await page.evaluate(`document.querySelector('.machine-frame').contentWindow.MultiCCMachineScope.navigation('/artifacts/example/report.html')`), 'https://remote.example/artifacts/example/report.html');
    const scoped = await page.evaluate(`(async () => {
      const frame = document.querySelector('.machine-frame'); const w = frame.contentWindow;
      localStorage.setItem('air:draft:same-id', 'entry draft'); w.localStorage.setItem('air:draft:same-id', 'remote draft');
      const response = await w.fetch('/api/value');
      const socket = await w.multiccWsUrl('ws://' + location.host + '/ws/chat?session=same-id');
      const sharedSocket = await w.multiccWsUrl('ws://' + location.host + '/ws/chat?session=same-id&share=fixture');
      window.keptMachineFrame = frame;
      return { value: await response.json(), local: localStorage.getItem('air:draft:same-id'), remote: w.localStorage.getItem('air:draft:same-id'), socket, sharedSocket };
    })()`);
    assert.deepEqual(scoped.value, { target: 'remote' });
    assert.equal(scoped.local, 'entry draft'); assert.equal(scoped.remote, 'remote draft');
    assert.equal(new URL(scoped.socket).pathname, '/ws/machines/machine_remote');
    assert.equal(new URL(scoped.sharedSocket).pathname, '/ws/machines/machine_remote');
    await page.evaluate(`window.MultiCCAirAdmin.render('overview', {data: {directories: [], tasks: []}})`);
    assert.equal(await page.evaluate('window.keptMachineFrame === document.querySelector(".machine-frame")'), true);
    assert.ok((await page.evaluate('document.getElementById("sidebar").textContent')).includes('入口目录'));
    assert.ok(page.requests.some(r => r.path === '/api/machines/machine_remote/proxy/api/value'));
    assert.ok(!page.requests.some(r => r.path === '/api/value'));
    await page.evaluate(`Array.from(document.querySelector('.machine-frame').parentElement.children).find(n => n.tagName === 'BUTTON').click()`);
    assert.ok(await page.waitFor('document.querySelector(".machine-directory")'));
    await page.evaluate('document.querySelectorAll(".machine-actions button")[1].click()');
    assert.ok(await page.waitFor('document.querySelector(".machine-frame")?.src.includes("view=settings")'));
    assert.ok((await page.evaluate('document.querySelector(".machine-frame").parentElement.textContent')).includes('保存目标：工作电脑'));
    await page.evaluate(`Array.from(document.querySelector('.machine-frame').parentElement.children).find(n => n.tagName === 'BUTTON').click()`);
    assert.ok(await page.waitFor('document.querySelector(".machine-directory")'));
    assert.equal(await page.evaluate('document.querySelector(".machine-frame")'), null);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.ok(await page.waitFor('innerWidth === 390'));
    assert.ok(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), '390px console must not overflow horizontally');
    assert.ok(await page.evaluate('document.getElementById("console-view-machines").getBoundingClientRect().width > 0'));
    assert.equal(await page.evaluate('getComputedStyle(document.getElementById("setup-card")).display'), 'none');
    assert.ok(await page.evaluate('document.querySelector(".machine-tabs").getBoundingClientRect().bottom < innerHeight'), 'computer tabs must be visible in the first mobile viewport');
    await page.screenshot('console-machines-mobile');
    await page.navigate('/air?machine=machine_remote&machineName=工作电脑&machineDownload=%2Ftmp%2Freport.txt&inline=1&token=fixture-token');
    assert.ok(await page.waitFor('document.body.textContent.includes("remote file contents")'));
    const download = await page.evaluate('location.href');
    assert.equal(new URL(download).pathname, '/api/machines/machine_remote/proxy/api/download');
    assert.equal(new URL(download).searchParams.has('token'), false);
    assert.ok(!page.requests.some(r => r.path === '/api/download'));
  });
});
