'use strict';
// 这组断言盯的是真实 Air 交互模型的三处改动，都在真浏览器里跑：
//   ① 控制台是浮层，不是页面 —— 打开它不改地址、不卸载当前任务；
//   ② 任务带就地换作用域（本目录 / 最近 / 全部目录），跨目录的行自报家门；
//   ③ ⌘K 一次搜目录和任务两类对象。
// 这些行为靠 DOM/地址状态判断，不靠像素，唯一量位置的地方（滑入）会先把动画跑完。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

// 面板滑动是 300ms 的 CSS 过渡。这个测试页是后台 target，不渲染也就不产生帧：
// 光等时间，过渡时钟根本不会起步，量到的永远是起点。读一次几何强制样式重算，
// 过渡从这一刻开始计时，再等过一个完整过渡，下一次重算就是终值。
const settle = async page => {
  await page.screenshot('settle');
  await page.evaluate(`new Promise(done => setTimeout(done, 400))`);
  await page.screenshot('settle');
};
const panelLeft = page => page.evaluate(`Math.round(document.getElementById('console-panel').getBoundingClientRect().left)`);

test('Air console slides in as an overlay, task scope switches in place, and ⌘K searches both objects', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-air-console-qa');
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

  const directories = [
    { id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' },
    { id: 'd2', name: 'North · 商城', path: '/projects/storefront' },
    { id: 'd3', name: 'Gapasea', path: '/projects/gapasea' },
  ];
  // 任务条目带上配置与角色绑定：没有它们，任务页的编辑器就无从渲染（那是真实
  // 接口一定会给的字段，fixture 少了就等于在测一个不存在的形状）。
  const configuration = { cli: 'codex', provider: 'codex-lab', providerName: 'Lab Responses', providerSelection: null,
    model: 'gpt-5.5', effectiveModel: 'gpt-5.5', effort: 'medium' };
  const task = (id, dirId, title, status, updatedAt) => ({ id, dirId, title, recordType: 'planned', workflowStage: 'doing',
    status, updatedAt, resource: { residency: 'planned', lease: 'idle' }, configuration });
  const airTasks = [
    task('tsk_here', 'd1', '收口 Air 的控制台', 'doing', 5000),
    task('tsk_wait', 'd2', '结算页金额四舍五入错误', 'waiting', 9000),
    { ...task('tsk_other', 'd3', '登录页空状态文案', 'doing', 7000), resource: { residency: 'materialized', lease: 'running' } },
    task('tsk_done', 'd3', '导出失败重试', 'done', 1000),
  ];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex', 'claude'], migration: { errors: [] },
    tasks: airTasks, sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/air/tasks/tsk_here'] = routes['/api/task-shell-tasks/tsk_here'] = () => json({ ok: true,
    task: airTasks[0], sessionId: 'task-here', ownerShellId: 'shell-a', readOnly: false,
    execution: { busy: false, status: 'idle' }, resource: airTasks[0].resource, attribution: {}, roleBindings: { version: 0, bindings: [] }, messages: [] });
  routes['/api/air/tasks/tsk_wait'] = routes['/api/task-shell-tasks/tsk_wait'] = () => json({ ok: true,
    task: airTasks[1], sessionId: 'task-wait', ownerShellId: 'shell-b', readOnly: false,
    execution: { busy: true, status: 'running' }, resource: { residency: 'materialized', lease: 'running' }, attribution: {}, roleBindings: { version: 0, bindings: [] }, messages: [] });
  routes['POST /api/task-board/tasks/tsk_here/chat-session'] = () => json({ ok: true, sessionId: 'task-here' });
  routes['POST /api/task-board/tasks/tsk_wait/chat-session'] = () => json({ ok: true, sessionId: 'task-wait' });
  for (const dir of ['d1', 'd2', 'd3']) routes['POST /api/task-shells'] = () => json({ id: 'shell-a' });

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1&task=tsk_here');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='收口 Air 的控制台'`));

    // ── 侧栏：跨目录活动没了，控制台接下了它的常驻信号 ───────────────────
    assert.equal(await page.evaluate(`document.getElementById('activity')===null`), true, '跨目录活动入口已移除');
    assert.equal(await page.evaluate(`[...document.querySelectorAll('#sidebar .nav-row')].map(el=>el.textContent.replace(/\\s+/g,'').replace(/\\d+$/,'')).join('|')`), '◫控制台|◴定时任务');
    assert.ok(await page.waitFor(`document.getElementById('console-badge').hidden===false`), '控制台行带常驻徽标');
    assert.equal(await page.evaluate(`document.getElementById('console-badge').textContent`), '2', '徽标数 = 别处在等 + 正在跑');

    // ── 控制台：从左侧滑入，地址不变，当前任务不卸载 ─────────────────────
    const before = await page.evaluate(`(() => {
      const clock = document.createElement('span');
      clock.id = 'keep-alive-marker';
      document.getElementById('task-header').append(clock);
      return { url: location.href, title: document.getElementById('task-title').textContent };
    })()`);
    const parked = await panelLeft(page);
    assert.ok(parked <= -1000, `面板收起时停在屏外（实测 left=${parked}）`);
    await page.evaluate(`document.getElementById('overview').click()`);
    assert.ok(await page.waitFor(`document.body.classList.contains('console-open')`));
    await settle(page);
    assert.equal(await panelLeft(page), 0, '面板滑到贴左边');
    assert.ok(await page.evaluate(`document.getElementById('console-panel').getBoundingClientRect().width>=1000`), '是大面板，不是窄抽屉');
    assert.equal(await page.evaluate(`location.href`), before.url, '打开控制台没有改地址');
    assert.equal(await page.evaluate(`document.getElementById('keep-alive-marker')!==null`), true, '当前任务的 DOM 没有重建');
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent`), before.title, '页头仍是当前任务');
    assert.equal(await page.evaluate(`document.getElementById('overview').getAttribute('aria-expanded')`), 'true');
    assert.ok(await page.evaluate(`document.getElementById('console-content').innerText.includes('谁在等我')`), '面板里有跨目录的待办清单');
    assert.equal(await page.evaluate(`document.querySelector('#console-content .admin-row-mark')?.className.includes('waiting')`), true, '等待回答的排在最前');
    await page.screenshot('01-console-open');

    // Esc 关掉，回到原处
    await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
    assert.ok(await page.waitFor(`!document.body.classList.contains('console-open')`));
    await settle(page);
    assert.ok((await panelLeft(page)) <= -1000, `关掉后滑回屏外（实测 left=${await panelLeft(page)}）`);
    assert.equal(await page.evaluate(`location.href`), before.url, '关掉控制台也没有改地址');
    assert.equal(await page.evaluate(`document.getElementById('keep-alive-marker')!==null`), true);
    assert.equal(await page.evaluate(`document.getElementById('console-panel').getBoundingClientRect().width>=1000`), true, '收起状态下仍然量得到盒子（可见性只影响绘制）');

    // /manage 那条老入口照旧可用：打开面板，顺带把地址收干净
    await page.navigate('/air?view=overview');
    assert.ok(await page.waitFor(`document.body.classList.contains('console-open')`));
    await settle(page);
    assert.equal(await panelLeft(page), 0);
    await page.evaluate(`document.getElementById('console-close').click()`);
    assert.ok(await page.waitFor(`!document.body.classList.contains('console-open')`));
    assert.equal(await page.evaluate(`location.search.includes('view=overview')`), false, '关掉后地址里的 view=overview 被撤掉');
    await page.navigate('/air?dir=d1&task=tsk_here');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='收口 Air 的控制台'`));

    // ── 作用域开关：同一条带子就地换范围 ─────────────────────────────────
    const rowDirs = `[...document.querySelectorAll('#tasks button .task-dir')].map(el=>el.textContent)`;
    assert.equal(await page.evaluate(`document.querySelector('#scope-switch button[aria-selected="true"]').dataset.scope`), 'dir');
    assert.equal(await page.evaluate(`document.querySelectorAll('#tasks button').length`), 1, '本目录只有自己的任务');
    assert.deepEqual(await page.evaluate(rowDirs), [], '本目录的行不带目录标记');
    await page.evaluate(`document.querySelector('#scope-switch button[data-scope="all"]').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#tasks .task-dir').length>0`));
    assert.equal(await page.evaluate(`document.querySelector('#task-list-title').textContent`), '全部目录');
    assert.deepEqual((await page.evaluate(rowDirs)).sort(), ['Gapasea', 'North · 商城'], '别的目录的行自报家门');
    assert.equal(await page.evaluate(`document.querySelectorAll('#tasks button.elsewhere').length`), 2, '跨目录的行用虚线边框分开');
    assert.equal(await page.evaluate(`document.querySelector('#tasks button.selected')!==null`), true, '当前任务仍在带子里');
    await page.screenshot('02-scope-all');

    // 最近：访问过的目录构成一条跨目录的工作集
    await page.evaluate(`document.querySelector('#scope-switch button[data-scope="recent"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-list-title').textContent==='最近打开'`));
    assert.equal(await page.evaluate(`document.querySelectorAll('#tasks button').length`), 1, '只访问过 d1 的任务');
    await page.evaluate(`document.querySelector('#scope-switch button[data-scope="dir"]').click()`);
    await page.evaluate(`document.getElementById('overview').click()`);
    assert.ok(await page.waitFor(`document.body.classList.contains('console-open')`));
    await settle(page);
    // 从面板里点走一个别目录的任务：面板自己让开，落到那个目录
    await page.evaluate(`[...document.querySelectorAll('#console-content .admin-recent-row')].find(r=>r.innerText.includes('结算页')).click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='结算页金额四舍五入错误'`));
    assert.equal(await page.evaluate(`document.body.classList.contains('console-open')`), false, '跳转后面板收起');
    assert.equal(await page.evaluate(`document.getElementById('directory-name').textContent`), 'North · 商城', '落到了任务所属的目录');
    await page.evaluate(`document.querySelector('#scope-switch button[data-scope="recent"]').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#tasks button').length===2`), '访问过的两个任务都在最近里');
    assert.deepEqual((await page.evaluate(rowDirs)).sort(), ['MultiCC 主仓'], '最近里也有跨目录的行');

    // ── ⌘K：目录和任务一起搜 ─────────────────────────────────────────────
    await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true}))`);
    assert.ok(await page.waitFor(`document.getElementById('palette').hidden===false`));
    await page.evaluate(`(() => { const i=document.getElementById('palette-input'); i.value='结算'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    const hits = await page.evaluate(`[...document.querySelectorAll('#palette-results button')].map(el=>el.innerText.replace(/\\n/g,' · '))`);
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.ok(hits[0].includes('结算页金额四舍五入错误') && hits[0].includes('North · 商城'), '命中任务时一并说清它在哪个目录');
    assert.ok(await page.evaluate(`document.getElementById('palette-note').textContent.includes('0 个目录 · 1 个任务')`));
    await page.screenshot('03-palette-task');
    await page.evaluate(`(() => { const i=document.getElementById('palette-input'); i.value='storefront'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    const dirHits = await page.evaluate(`[...document.querySelectorAll('#palette-results button')].map(el=>el.innerText.replace(/\\n/g,' · '))`);
    assert.ok(dirHits[0].includes('North · 商城') && dirHits[0].includes('/projects/storefront'), '同一个入口也能按路径搜目录');
    // 清空输入回到「目录在前、任务在后」的完整列表：↑↓ 换的是选择，Enter 进的是选中的那一个。
    await page.evaluate(`(() => { const i=document.getElementById('palette-input'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    assert.equal(await page.evaluate(`document.querySelectorAll('#palette-results button').length`), 7, '3 个目录 + 4 个任务，一个列表');
    assert.equal(await page.evaluate(`document.querySelectorAll('#palette-results button')[0].classList.contains('active')`), true);
    await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown'}))`);
    assert.equal(await page.evaluate(`document.querySelectorAll('#palette-results button')[1].classList.contains('active')`), true, '↑↓ 换选择');
    await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp'}))`);
    await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown'}))`);
    await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))`);
    assert.ok(await page.waitFor(`document.getElementById('palette').hidden===true`));
    assert.ok(await page.waitFor(`document.getElementById('directory-name').textContent==='North · 商城'`), 'Enter 进的是高亮的那一项');
    assert.equal(await page.evaluate(`location.search.includes('dir=d2')`), true, '选目录不写 view，只写它自己');

    // 面板在控制台上面：⌘K 顶掉控制台，并且把地址里的 view=overview 也撤掉
    await page.navigate('/air?view=overview');
    assert.ok(await page.waitFor(`document.body.classList.contains('console-open')`));
    await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true}))`);
    assert.ok(await page.waitFor(`document.getElementById('palette').hidden===false`));
    assert.equal(await page.evaluate(`document.body.classList.contains('console-open')`), false, '⌘K 时控制台让开');
    await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
    assert.ok(await page.waitFor(`document.getElementById('palette').hidden===true`));
    assert.equal(await page.evaluate(`location.search.includes('view=overview')`), false, '被顶掉的控制台不会留在地址里');

    // ── 窄屏 ─────────────────────────────────────────────────────────────
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.evaluate(`document.getElementById('overview').click()`);
    assert.ok(await page.waitFor(`document.body.classList.contains('console-open')`));
    await settle(page);
    const mobile = await page.evaluate(`(() => { const p=document.getElementById('console-panel').getBoundingClientRect();
      return { right: Math.round(p.right), width: Math.round(p.width), innerWidth }; })()`);
    assert.ok(mobile.right <= mobile.innerWidth + 1, JSON.stringify(mobile));
    assert.equal(await page.evaluate(`document.getElementById('console-panel').scrollWidth<=document.getElementById('console-panel').clientWidth+1`), true, '面板不横向溢出');
    assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
    await page.screenshot('04-mobile-console');
    await page.evaluate(`document.getElementById('console-close').click()`);
    assert.ok(await page.waitFor(`!document.body.classList.contains('console-open')`));
    assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
    await page.screenshot('05-mobile-sidebar');
  });

  console.log('截图目录: ' + shots);
});
