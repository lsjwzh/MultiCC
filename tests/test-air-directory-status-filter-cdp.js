'use strict';
// 目录首页的快捷过滤器与控制台保持一致：第四格是「今日完成」。它同时接住本轮成功
// （runState succeeded）和旧生命周期 done，但只认本地今天更新的记录。
// fixture 把今天/更早、succeeded/done 两个维度都放齐，防止以后又退回「执行成功」或
// 把历史完成任务全算进来的旧口径。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('the workspace overview exposes the same done-today quick filter as the console', async t => {
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
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url` };

  const directories = [{ id: 'd1', name: 'Gapasea', path: '/projects/gapasea' }];
  const task = (id, title, status, runState, updatedAt) => ({ id, dirId: 'd1', title, status, runState, updatedAt,
    resource: { residency: 'planned', lease: 'idle' } });
  const now = Date.now();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime() + 1;
  const tasks = [
    task('tsk-run', '正在跑的活', 'active', 'running', now - 1000),
    task('tsk-wait', '等人回答的活', 'active', 'waiting', now - 2000),
    task('tsk-err', '炸了的活', 'active', 'error', now - 3000),
    task('tsk-ok-today', '今天完成：登录页空状态文案', 'active', 'succeeded', today + 1),
    task('tsk-done-today', '今天完成：旧看板收尾', 'done', 'succeeded', today),
    task('tsk-ok-old', '更早执行成功', 'active', 'succeeded', 10),
    task('tsk-done-old', '更早生命周期完成', 'done', 'succeeded', 9),
  ];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex'], migration: { errors: [] }, tasks, sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-dir-status-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1');
    await page.evaluate(String.raw`(() => {
      window.__errors = [];
      addEventListener('error', event => __errors.push(String(event.message)));
      addEventListener('unhandledrejection', event => __errors.push('unhandledrejection: ' + String(event.reason && event.reason.message)));
    })()`);

    // ── 五张卡：与控制台同为「运行中 / 等我回复 / 异常 / 今日完成 / 全部」 ──
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-stats .directory-stat').length===5`));
    const cards = () => page.evaluate(`[...document.querySelectorAll('#directory-stats .directory-stat')]
      .map(el => [el.querySelector('span').textContent, el.querySelector('strong').textContent])`);
    assert.deepEqual(await cards(), [
      ['进行中', '1'], ['等我回复', '1'], ['异常', '1'],
      ['今日完成', '2'], ['全部', '7'],
    ]);

    // ── 状态那格：没有那个旧档 ────────────────────────────────────────────
    const options = await page.evaluate(`[...document.getElementById('directory-task-status').options]
      .map(o => [o.value, o.textContent])`);
    assert.deepEqual(options, [
      ['open', '进行中与待处理'], ['running', '运行中'], ['waiting', '等待回复'],
      ['error', '异常'], ['today', '今日完成'], ['succeeded', '执行成功'],
      ['achieved', '完成目标'], ['interact', '需要交互'], ['all', '全部记录'], ['archived', '已归档'],
    ]);
    assert.deepEqual(options.filter(([value, text]) => value === 'done' || text === '已完成'), [],
      '生命周期 done 不再是用户可选的一档');

    // ── 点卡片 = 按同一档筛：只出现今天完成的两条 ────────────────────────
    const titles = () => page.evaluate(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')]
      .map(el => el.textContent).sort()`);
    await page.evaluate(`document.querySelectorAll('#directory-stats .directory-stat')[3].click()`);
    assert.ok(await page.waitFor(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')].length===2`),
      '今日完成卡点开应该只有今天完成的任务');
    assert.deepEqual(await titles(), ['今天完成：旧看板收尾', '今天完成：登录页空状态文案']);
    assert.equal(await page.evaluate(`document.getElementById('directory-task-status').value`), 'today',
      '卡片与状态那格是同一份筛选，点完要同步');
    await page.screenshot('directory-done-today-filter.png');

    // 换成「全部记录」：那条旧记录还在，没被删也没被藏起来 —— 只是不再冒充成功。
    await page.evaluate(`(() => { const s=document.getElementById('directory-task-status'); s.value='all'; s.dispatchEvent(new Event('change')); })()`);
    assert.ok(await page.waitFor(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')].length===7`));
    assert.ok((await titles()).includes('更早生命周期完成'), '旧记录只在「全部记录」里见得到');

    // 直接选「今日完成」：与点卡片同一份口径。
    await page.evaluate(`(() => { const s=document.getElementById('directory-task-status'); s.value='today'; s.dispatchEvent(new Event('change')); })()`);
    assert.ok(await page.waitFor(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')].length===2`));
    assert.deepEqual(await titles(), ['今天完成：旧看板收尾', '今天完成：登录页空状态文案']);

    assert.deepEqual(await page.evaluate('window.__errors'), []);
  });
});
