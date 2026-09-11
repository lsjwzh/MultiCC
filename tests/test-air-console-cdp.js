'use strict';
// 这组断言盯的是真实 Air 交互模型的四处改动，都在真浏览器里跑：
//   ① 控制台是浮层，不是页面 —— 打开它不改地址、不卸载当前任务；
//   ② 侧栏的任务带只装「最近」，完整列表（跨全部目录 + 搜索 + 筛选）搬进控制台；
//   ③ 运行中的任务和它所在的目录，在侧栏 / 控制台 / 目录页 / 页头都带同一圈彩虹；
//   ④ ⌘K 一次搜目录和任务两类对象。
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

test('Air console is a cross-directory overlay, the task band shows recents, and running work wears the ring everywhere', async t => {
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
  //
  // status/runState 用的是服务端那套词表（src/task-board/normalize.js 的
  // TASK_RUN_STATES），不是这里编的词：status 只有 active/done/archived 三个人为
  // 的生命周期取值，「执行中」根本不在里面 —— 它在 runState 上。fixture 用
  // 'doing'/'waiting' 当 status 的时候，界面看着对，其实测的是一个不存在的形状。
  const configuration = { cli: 'codex', provider: 'codex-lab', providerName: 'Lab Responses', providerSelection: null,
    model: 'gpt-5.5', effectiveModel: 'gpt-5.5', effort: 'medium' };
  const task = (id, dirId, title, status, runState, updatedAt) => ({ id, dirId, title, recordType: 'planned', workflowStage: 'doing',
    status, runState, updatedAt, resource: { residency: 'planned', lease: 'idle' }, configuration });
  const airTasks = [
    task('tsk_here', 'd1', '收口 Air 的控制台', 'active', 'idle', 5000),
    task('tsk_wait', 'd2', '结算页金额四舍五入错误', 'active', 'waiting', 9000),
    { ...task('tsk_other', 'd3', '登录页空状态文案', 'active', 'running', 7000), resource: { residency: 'materialized', lease: 'running' } },
    task('tsk_done', 'd3', '导出失败重试', 'done', 'succeeded', 1000),
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
  // 在跑的那条也要有任务页接口：从控制台点进去的时候，页头标题是从这里来的。
  routes['/api/air/tasks/tsk_other'] = routes['/api/task-shell-tasks/tsk_other'] = () => json({ ok: true,
    task: airTasks[2], sessionId: 'task-other', ownerShellId: 'shell-c', readOnly: false,
    execution: { busy: true, status: 'running' }, resource: airTasks[2].resource, attribution: {}, roleBindings: { version: 0, bindings: [] }, messages: [] });
  routes['POST /api/task-board/tasks/tsk_here/chat-session'] = () => json({ ok: true, sessionId: 'task-here' });
  routes['POST /api/task-board/tasks/tsk_wait/chat-session'] = () => json({ ok: true, sessionId: 'task-wait' });
  routes['POST /api/task-board/tasks/tsk_other/chat-session'] = () => json({ ok: true, sessionId: 'task-other' });
  for (const dir of ['d1', 'd2', 'd3']) routes['POST /api/task-shells'] = () => json({ id: 'shell-a' });

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1&task=tsk_here');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='收口 Air 的控制台'`));

    // ── 侧栏：任务区只装「最近」，其余操作按频次收敛 ─────────────────────
    assert.equal(await page.evaluate(`document.getElementById('activity')===null`), true, '跨目录活动入口已移除');
    assert.equal(await page.evaluate(`[...document.querySelectorAll('#sidebar .nav-row')].map(el=>el.textContent.replace(/\\s+/g,'').replace(/\\d+$/,'')).join('|')`), '◫控制台|◴定时任务');
    assert.ok(await page.waitFor(`document.getElementById('console-badge').hidden===false`), '控制台行带常驻徽标');
    assert.equal(await page.evaluate(`document.getElementById('console-badge').textContent`), '2', '徽标数 = 别处在等 + 正在跑');

    // 作用域开关、搜索框、状态筛选都从侧栏撤了：它们是给「完整列表」用的，
    // 而完整列表现在住在控制台的「全部任务」里。
    for (const gone of ['scope-switch', 'task-search', 'status-filter']) {
      assert.equal(await page.evaluate(`document.getElementById('${gone}')===null`), true, `#${gone} 已从侧栏移除`);
    }
    assert.equal(await page.evaluate(`document.getElementById('task-list-title').textContent`), '最近任务');
    assert.ok(await page.waitFor(`document.querySelectorAll('#tasks button').length===1`), '最近里只有打开过的这一条');
    // 一行要能自己说清：状态徽标（注册表给的词）、所属目录、阶段与资源去向。
    assert.equal(await page.evaluate(`document.querySelector('#tasks button .mc-status-label').textContent`), '空闲', '任务行带状态徽标');
    assert.equal(await page.evaluate(`document.querySelector('#tasks button .task-dir').textContent`), 'MultiCC 主仓', '任务行带所属目录');
    assert.ok(await page.evaluate(`document.querySelector('#tasks button .task-note').textContent.includes('计划')`), '阶段跟在后面');
    assert.equal(await page.evaluate(`document.querySelectorAll('#tasks button.ring-running').length`), 0, '没在跑的任务不带圈');
    // 频次收敛：每天点的留在外面，偶尔点的折进「更多与系统」；运维回执不能被折进去。
    const more = await page.evaluate(`(() => { const d=document.getElementById('side-more');
      return { tag: d.tagName, open: d.open, links: [...d.querySelectorAll('.global-links button')].map(b=>b.textContent),
        holdsReceipt: d.contains(document.getElementById('air-ops-status')) }; })()`);
    assert.equal(more.tag, 'DETAILS');
    assert.equal(more.open, false, '「更多与系统」默认收起');
    assert.deepEqual(more.links, ['服务与文档', '记忆图谱', '设置中心']);
    assert.equal(more.holdsReceipt, false, '运维回执留在折叠区外，折起来会连回执一起藏掉');

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
    assert.ok(await page.evaluate(`document.querySelector('.console-attention .admin-recent-row').innerText.includes('结算页')`), '等待回答的排在最前');
    assert.ok(await page.evaluate(`document.querySelector('.console-attention .admin-recent-row .mc-status-label').textContent==='等待回答'`), '待办行自报状态');
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

    // ── 控制台：「全部任务」跨所有目录，筛选和搜索在这里 ─────────────────
    await page.evaluate(`document.getElementById('overview').click()`);
    assert.ok(await page.waitFor(`document.body.classList.contains('console-open')`));
    await settle(page);
    const allTitles = `[...document.querySelectorAll('#console-task-list .admin-recent-row strong')].map(el=>el.textContent)`;
    // 默认只看「进行中与待处理」：done 的那条不在里面，但另外三个目录的三条都在
    // —— 控制台不按当前目录收窄，这是它跟侧栏那条带子的分工。
    assert.deepEqual((await page.evaluate(allTitles)).sort(), ['收口 Air 的控制台', '登录页空状态文案', '结算页金额四舍五入错误']);
    assert.equal(await page.evaluate(`document.getElementById('console-task-note').textContent`), '3 条');
    await page.evaluate(`(() => { const s=document.getElementById('console-task-status'); s.value='all'; s.dispatchEvent(new Event('change')); })()`);
    assert.deepEqual((await page.evaluate(allTitles)).sort(), ['导出失败重试', '收口 Air 的控制台', '登录页空状态文案', '结算页金额四舍五入错误'], '全部记录把已完成也算上');
    await page.evaluate(`(() => { const s=document.getElementById('console-task-dir'); s.value='d3'; s.dispatchEvent(new Event('change')); })()`);
    assert.deepEqual((await page.evaluate(allTitles)).sort(), ['导出失败重试', '登录页空状态文案'], '按目录收窄');
    // 先聚焦再打字：这样后面那条断言才是在问「打字会不会把焦点打掉」，而不是
    // 「一个从没被聚焦过的输入框有没有焦点」。
    await page.evaluate(`(() => { const i=document.getElementById('console-task-search'); i.focus(); i.value='空状态'; i.dispatchEvent(new Event('input')); })()`);
    assert.deepEqual(await page.evaluate(allTitles), ['登录页空状态文案'], '按标题搜索');
    // 只重画列表才留得住焦点：整块 replaceChildren 的话，第一个字打进去输入框就没了。
    assert.equal(await page.evaluate(`document.activeElement===document.getElementById('console-task-search')`), true, '重画列表不夺走搜索框焦点');
    assert.equal(await page.evaluate(`document.querySelectorAll('#console-task-list .admin-recent-row').length`), 1);

    // ── 彩虹圈：运行中的任务，和任务对应的目录 ───────────────────────────
    // 圈只有一份定义（status-presentation.js 只给 running 设了 spinner），所以它
    // 在哪儿出现、在哪儿不出现，永远同步；等待中和出错的任务绝不闪。
    const ringed = await page.evaluate(`[...document.querySelectorAll('#console-task-list .admin-recent-row.ring-running')].map(el=>el.innerText.replace(/\\s+/g,''))`);
    assert.equal(ringed.length, 1, JSON.stringify(ringed));
    assert.ok(ringed[0].includes('登录页空状态文案'), '在跑的那条任务带圈');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.admin-directory-row.ring-running')].map(el=>el.querySelector('strong').textContent)`), ['Gapasea'], '任务对应的目录也带圈');
    assert.equal(await page.evaluate(`document.querySelector('.console-attention .admin-recent-row.ring-running')!==null`), true, '「谁在等我」里在跑的那条也带圈');
    await page.screenshot('02-console-all-tasks');

    // 从面板里点走一条在跑的任务：面板自己让开，落到那个目录，而且落到哪儿都得
    // 看得见「它在跑」—— 页头状态行、侧栏的任务行、当前目录卡片三处同时亮。
    await page.evaluate(`(() => { const s=document.getElementById('console-task-dir'); s.value='all'; s.dispatchEvent(new Event('change')); })()`);
    await page.evaluate(`(() => { const i=document.getElementById('console-task-search'); i.value=''; i.dispatchEvent(new Event('input')); })()`);
    await page.evaluate(`[...document.querySelectorAll('#console-task-list .admin-recent-row')].find(r=>r.innerText.includes('登录页空状态文案')).click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='登录页空状态文案'`));
    assert.equal(await page.evaluate(`document.body.classList.contains('console-open')`), false, '跳转后面板收起');
    assert.equal(await page.evaluate(`document.getElementById('directory-name').textContent`), 'Gapasea', '落到了任务所属的目录');
    assert.ok(await page.waitFor(`document.getElementById('task-state').classList.contains('ring-running')`), '页头状态行带圈');
    assert.equal(await page.evaluate(`document.querySelector('#tasks button.ring-running .task-dir').textContent`), 'Gapasea', '侧栏里在跑的那条也带圈');
    assert.equal(await page.evaluate(`document.querySelector('.space-card').classList.contains('ring-running')`), true, '当前目录卡片带圈');
    assert.equal(await page.evaluate(`document.querySelector('#tasks button.ring-running .mc-status-label').textContent`), '执行中');
    // 目录库那一页（控制台 › 浏览工作目录）也认同一个圈。
    await page.evaluate(`document.getElementById('overview').click()`);
    assert.ok(await page.waitFor(`document.body.classList.contains('console-open')`));
    await settle(page);
    await page.evaluate(`document.getElementById('console-actions').querySelector('button').click()`);
    assert.ok(await page.waitFor(`document.getElementById('directory-library').hidden===false`));
    assert.equal(await page.evaluate(`document.querySelectorAll('#directory-grid button.ring-running').length`), 1, '只有跑着活的目录带圈');
    assert.equal(await page.evaluate(`document.querySelector('#directory-grid button.ring-running strong').textContent`), '▣ Gapasea', '带圈的是那个目录');
    await page.navigate('/air?dir=d1&task=tsk_here');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='收口 Air 的控制台'`));

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
