'use strict';
// air-directory-nav.js 的两件事，在真浏览器里跑：
//   ① 鼠标停在侧栏左上角的目录卡上，旁边滑出全部目录，点一行就切过去；
//   ② 控制台「工作目录」那一栏可以拖着换顺序，松手后按新顺序 PUT
//      /api/directories/order（顺序存服务端），界面不回弹，下次快照也照这个顺序。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('directory card hover flyout switches directories; console directory rows drag-sort and persist server-side', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': type } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };

  let directories = [
    { id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' },
    { id: 'd2', name: 'North · 商城', path: '/projects/storefront' },
    { id: 'd3', name: 'Gapasea', path: '/projects/gapasea' },
  ];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex', 'claude'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  const orderPuts = [];
  routes['PUT /api/directories/order'] = req => {
    const ids = JSON.parse(req.body).ids;
    orderPuts.push(ids);
    directories = ids.map(id => directories.find(d => d.id === id));
    return json({ ok: true, ids });
  };

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-directory-nav-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.getElementById('directory-name').textContent==='MultiCC 主仓'`));

    // ── ① hover 侧拉 ──
    const card = await page.evaluate(`(() => { const r=document.querySelector('#sidebar .space-card').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, right: r.right }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: card.x, y: card.y });
    assert.ok(await page.waitFor(`document.getElementById('directory-flyout') && !document.getElementById('directory-flyout').hidden`), 'hover 目录卡滑出侧拉');
    const flyout = await page.evaluate(`(() => { const f=document.getElementById('directory-flyout'); const r=f.getBoundingClientRect();
      return { left: r.left, rows: [...f.querySelectorAll('.directory-flyout-row strong')].map(el=>el.textContent),
        current: f.querySelector('.is-current strong')?.textContent }; })()`);
    assert.deepEqual(flyout.rows, ['MultiCC 主仓', 'North · 商城', 'Gapasea'], '侧拉列出全部目录，按服务端顺序');
    assert.equal(flyout.current, 'MultiCC 主仓', '当前目录高亮');
    assert.ok(flyout.left >= card.right, '侧拉贴在卡片右侧，不压住卡片');
    await page.screenshot('flyout-open');
    // 鼠标移到侧拉上它不收起；点一行就切目录并收起。
    const target = await page.evaluate(`(() => { const r=document.querySelectorAll('#directory-flyout .directory-flyout-row')[2].getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height/2 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
    await page.evaluate(`new Promise(done => setTimeout(done, 300))`);
    assert.equal(await page.evaluate(`document.getElementById('directory-flyout').hidden`), false, '移到侧拉上不收起');
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    assert.ok(await page.waitFor(`document.getElementById('directory-name').textContent==='Gapasea'`), '点侧拉里的目录即切换');
    assert.ok(await page.waitFor(`new URLSearchParams(location.search).get('dir')==='d3'`), '地址跟着切到 d3');
    assert.equal(await page.evaluate(`document.getElementById('directory-flyout').hidden`), true, '切完收起');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 600 });

    // ── ② 控制台目录拖拽排序 ──
    await page.evaluate(`document.getElementById('overview').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('.admin-directory-list [data-dir-id]').length===3`), '控制台列出三个目录');
    assert.equal(await page.evaluate(`document.querySelector('.admin-directory-list [data-dir-id]').draggable`), true, '目录行可拖');
    // 把第三行（Gapasea）拖到第一行上半截 → 顺序 d3,d1,d2。
    await page.evaluate(`(() => {
      const list = document.querySelector('.admin-directory-list');
      const rows = [...list.querySelectorAll('[data-dir-id]')];
      const dt = new DataTransfer();
      rows[2].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const box = rows[0].getBoundingClientRect();
      rows[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: box.left + 10, clientY: box.top + 2 }));
      rows[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      rows[2].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    })()`);
    assert.ok(await page.waitFor(`true`));
    assert.ok(await page.waitFor(`document.querySelectorAll('.admin-directory-list [data-dir-id]')[0]?.dataset.dirId==='d3'`), '松手后界面是新顺序');
    await page.evaluate(`new Promise(done => setTimeout(done, 300))`);
    assert.deepEqual(orderPuts, [['d3', 'd1', 'd2']], '按新顺序 PUT /api/directories/order 一次');
    assert.equal(await page.evaluate(`[...document.querySelectorAll('.admin-directory-list [data-dir-id]')].map(r=>r.dataset.dirId).join()`), 'd3,d1,d2', '重拉快照后顺序不回弹');
    await page.screenshot('console-reordered');
    // 重载页面：顺序来自服务端，侧拉也照这个顺序。
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.getElementById('directory-name').textContent==='MultiCC 主仓'`));
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: card.x, y: card.y });
    assert.ok(await page.waitFor(`document.getElementById('directory-flyout') && !document.getElementById('directory-flyout').hidden`));
    assert.equal(await page.evaluate(`[...document.querySelectorAll('#directory-flyout .directory-flyout-row')].map(r=>r.dataset.dirId).join()`), 'd3,d1,d2', '重载后侧拉顺序来自服务端');
  });
});
