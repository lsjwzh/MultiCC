'use strict';
// air-directory-nav.js 的两件事，在真浏览器里跑：
//   ① 鼠标停在侧栏左上角的目录卡上，旁边滑出全部目录，点一行就切过去；
//   ② 控制台「工作目录」那一栏可以拖着换顺序，松手后按新顺序 PUT
//      /api/directories/order（顺序存服务端），界面不回弹，下次快照也照这个顺序。
//   ③ 目录卡片自己那一层（air-directory-card.js）：备忘住在卡片框里，旁边一颗
//      快速删除，走 air-directory-delete.js 那两步确认。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('project switcher opens on click, switches projects and persists drag order', async t => {
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
    await page.evaluate(`document.getElementById('library').click()`);
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
    await page.evaluate(`document.getElementById('library').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('.directory-flyout-list [data-dir-id]').length===3`), '控制台列出三个目录');
    assert.equal(await page.evaluate(`document.querySelector('.directory-flyout-list [data-dir-id]').draggable`), true, '目录行可拖');
    // 把第三行（Gapasea）拖到第一行上半截 → 顺序 d3,d1,d2。
    await page.evaluate(`(() => {
      const list = document.querySelector('.directory-flyout-list');
      const rows = [...list.querySelectorAll('[data-dir-id]')];
      const dt = new DataTransfer();
      rows[2].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const box = rows[0].getBoundingClientRect();
      rows[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: box.left + 10, clientY: box.top + 2 }));
      rows[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      rows[2].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    })()`);
    assert.ok(await page.waitFor(`true`));
    assert.ok(await page.waitFor(`document.querySelectorAll('.directory-flyout-list [data-dir-id]')[0]?.dataset.dirId==='d3'`), '松手后界面是新顺序');
    await page.evaluate(`new Promise(done => setTimeout(done, 300))`);
    assert.deepEqual(orderPuts, [['d3', 'd1', 'd2']], '按新顺序 PUT /api/directories/order 一次');
    assert.equal(await page.evaluate(`[...document.querySelectorAll('.directory-flyout-list [data-dir-id]')].map(r=>r.dataset.dirId).join()`), 'd3,d1,d2', '重拉快照后顺序不回弹');
    await page.screenshot('console-reordered');
    // 重载页面：顺序来自服务端，侧拉也照这个顺序。
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.getElementById('directory-name').textContent==='MultiCC 主仓'`));
    await page.evaluate(`document.getElementById('library').click()`);
    assert.ok(await page.waitFor(`document.getElementById('directory-flyout') && !document.getElementById('directory-flyout').hidden`));
    assert.equal(await page.evaluate(`[...document.querySelectorAll('#directory-flyout .directory-flyout-row')].map(r=>r.dataset.dirId).join()`), 'd3,d1,d2', '重载后侧拉顺序来自服务端');
  });
});

// 目录卡片本身（air-directory-card.js）：备忘与快速删除都住在卡片框里
// （article.directory-card 才是那张卡），备忘不再孤悬在卡片外面单独一行；
// 删除复用 air-directory-delete.js 导出的两步确认，删掉的是登记，不是磁盘。
test('directory card keeps the memo inside and offers a guarded quick delete', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // 这一格刻意不给 air-sync.js：没有实时推送时，重画只能靠 refresh() 自己取一次
  // /api/air 快照，「删完之后谁把卡片画回来」因此是确定性的，不会被迟到的推送盖掉。
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f) && f !== 'air-sync.js')) {
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': type } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };

  const directories = [
    { id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' },
    { id: 'd2', name: 'North · 商城', path: '/projects/storefront' },
    { id: 'd3', name: 'Gapasea', path: '/projects/gapasea' },
  ];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = routes['/api/docs-registry'] = () => json([]);
  const deletes = [];
  // 删完之后重画读的还是这条 /api/air（directories 是同一个数组），少一条就少一张卡。
  const removeDirectory = id => { deletes.push(id); directories.splice(directories.findIndex(item => item.id === id), 1); return json({ ok: true }); };
  routes['DELETE /api/directories/d2'] = () => removeDirectory('d2');
  routes['DELETE /api/directories/d3'] = () => removeDirectory('d3');

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-directory-card-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ── 控制台「按目录」那一格的卡片：删完不能原地复活 ──────────────────
    // 这一格的重画由外壳负责（air.js render → admin.render(mode, adminContext())）；
    // 卡片自己那份 context 攥着删除前的旧快照，拿它再画一遍就会把刚删掉的目录画回来。
    await page.navigate('/air?view=overview');
    assert.ok(await page.waitFor(`document.getElementById('console-home')!==null`));
    await page.evaluate(`document.getElementById('console-view-dirs').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#console-directory-grid .directory-card').length===3`), '目录看法列出三个目录');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#console-directory-grid .directory-card')].map(card=>[...card.children].map(child=>child.className))`),
      [['', 'directory-card-foot'], ['', 'directory-card-foot'], ['', 'directory-card-foot']], '控制台的卡片同样 = 主按钮 + 底栏');
    await page.evaluate(`window.__asked=[];window.confirm=text=>{window.__asked.push(text);return true}`);
    await page.evaluate(`document.querySelector('#console-directory-grid [data-dir-id="d3"] .directory-card-delete').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#console-directory-grid .directory-card').length===2`), '删掉的目录卡从控制台消失');
    assert.match(await page.evaluate(`window.__asked.join('|')`), /Gapasea/, '确认文案里写出目录名');
    assert.deepEqual(deletes, ['d3'], '控制台那颗打的也是目录删除接口，只打一次');
    // 停一会儿再看：旧快照重画（或迟到的实时推送）都不该把它带回来。
    await page.evaluate(`new Promise(done=>setTimeout(done,700))`);
    assert.equal(await page.evaluate(`[...document.querySelectorAll('#console-directory-grid .directory-card')].map(card=>card.dataset.dirId).join()`), 'd1,d2',
      '删掉的目录卡不会原地复活');
    await page.screenshot('console-directory-card-quick-delete');

    // ── 目录库那一页的卡片：备忘住进卡片里 + 快速删除 ────────────────────
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-grid .directory-card').length===2`));

    // 卡片 = 主按钮 + 底栏；备忘与快速删除都在底栏里，也就是都在卡片框里面。
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#directory-grid .directory-card')].map(card=>[...card.children].map(child=>child.className))`),
      [['', 'directory-card-foot'], ['', 'directory-card-foot']], '卡片 = 主按钮 + 底栏');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#directory-grid .directory-card')].map(card=>!!card.querySelector('.directory-card-foot .directory-memo')&&!!card.querySelector('.directory-card-foot .directory-card-delete'))`),
      [true, true], '备忘与快速删除都装在卡片里面');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#directory-grid .directory-card .directory-memo')].map(a=>a.getAttribute('href'))`),
      ['/memo.html?dirId=d1', '/memo.html?dirId=d2'], '卡片里的备忘各指自己的目录');
    assert.equal(await page.evaluate(`[...document.querySelectorAll('#directory-grid .directory-memo')].filter(link=>!link.closest('.directory-card')).length`), 0,
      '卡片外面不再单独挂一行备忘');
    // 外观（内边距、描边、圆角、阴影）搬到了 article 上，卡里那颗按钮抹平成全透明。
    // 圆角的具体像素随视口有两档（air.css 里 16px / 20px），这里只认「卡片有框、按钮没框」。
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#directory-grid .directory-card')).borderTopWidth`), '1px', '卡片框画在 article 上');
    assert.notEqual(await page.evaluate(`getComputedStyle(document.querySelector('#directory-grid .directory-card')).padding`), '0px', '内边距在卡片上，底栏因此画在框里');
    assert.notEqual(await page.evaluate(`getComputedStyle(document.querySelector('#directory-grid .directory-card')).borderRadius`), '0px', '卡片自己是圆角的');
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#directory-grid .directory-card > button')).backgroundColor`), 'rgba(0, 0, 0, 0)', '卡里的按钮不再自己画一个框');
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#directory-grid .directory-card > button')).borderTopWidth`), '0px', '卡里的按钮没有描边');
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#directory-grid .directory-card > button')).padding`), '0px', '内边距只在卡片上');
    await page.screenshot('directory-card-memo-and-quick-delete');

    // 目录库这一页看得见整张卡：备忘与删除都在框里，不再是框外一行。
    await page.evaluate(`document.getElementById('library').click(); document.querySelectorAll('.directory-flyout-action')[1].click()`);
    assert.ok(await page.waitFor(`document.getElementById('directory-library').hidden===false`), '目录库这一页能打开');
    await page.screenshot('directory-library-cards');

    // 快速删除：确认文案写出目录名，确认一次就删（服务端没报还有会话）。
    await page.evaluate(`window.__asked=[];window.confirm=text=>{window.__asked.push(text);return true}`);
    await page.evaluate(`document.querySelectorAll('#directory-grid .directory-card')[1].querySelector('.directory-card-delete').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-grid .directory-card').length===1`), '删掉的目录卡消失');
    assert.deepEqual(deletes, ['d3', 'd2'], '打的是那条目录删除接口，只打一次');
    assert.ok(page.requests.every(request => !(request.method === 'DELETE' && request.path === '/api/directories/d2' && request.url.includes('force'))),
      '没有会话要连带删时不自动带 force');
    assert.match(await page.evaluate(`window.__asked.join('|')`), /North · 商城/, '确认文案里写出目录名');
    assert.equal(await page.evaluate(`document.querySelector('#directory-grid .directory-memo').getAttribute('href')`), '/memo.html?dirId=d1',
      '留下的那张卡还是它自己');

    // 取消就不删：接口一次都不打，卡片原地不动。
    await page.evaluate(`window.__asked=[];window.confirm=()=>false`);
    await page.evaluate(`document.querySelector('#directory-grid .directory-card .directory-card-delete').click()`);
    await page.evaluate(`new Promise(done=>setTimeout(done,300))`);
    assert.deepEqual(deletes, ['d3', 'd2'], '取消之后不再打删除接口');
    assert.equal(await page.evaluate(`document.querySelectorAll('#directory-grid .directory-card').length`), 1, '取消之后卡片还在');
    await page.screenshot('directory-card-quick-delete-cancelled');
  });
});
