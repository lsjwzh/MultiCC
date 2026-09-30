'use strict';
// 目录首页那排统计卡与状态那格：成功那一档量的是**这一轮的结局**（runState 折出来的
// succeeded），不是生命周期那个 done。
//
// 这是一份数据口径，不是措辞。任务板里真正跑成功的记录全挂在 runState succeeded 上，
// 而 lifecycle done 只剩计划看板时代留下的零星几条（新任务不会再变成它）—— 卡片和下拉
// 若仍按 done 筛，点开看到的永远是一屏旧数据，几百条「执行成功」反而一条都筛不出来。
// fixture 里因此两种都放：两条 succeeded（该出现在卡里）、一条 lifecycle done（旧记录，
// 只该在「全部记录」里见到），再加运行中/等待/异常各一条把其余三张卡钉住。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('the workspace overview counts this run\'s success, not the retired lifecycle done', async t => {
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
  const tasks = [
    task('tsk-run', '正在跑的活', 'active', 'running', 1000),
    task('tsk-wait', '等人回答的活', 'active', 'waiting', 990),
    task('tsk-err', '炸了的活', 'active', 'error', 980),
    task('tsk-ok-1', '登录页空状态文案', 'active', 'succeeded', 970),
    task('tsk-ok-2', '结算页金额四舍五入', 'active', 'succeeded', 960),
    // 生命周期 done：这一条是这次回归的关键 —— 它以前是「完成」那张卡唯一认得的东西。
    task('tsk-legacy-done', '旧看板时代的收尾记录', 'done', 'succeeded', 10),
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

    // ── 五张卡：成功那一档数的是 succeeded ────────────────────────────────
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-stats .directory-stat').length===5`));
    const cards = () => page.evaluate(`[...document.querySelectorAll('#directory-stats .directory-stat')]
      .map(el => [el.querySelector('span').textContent, el.querySelector('strong').textContent])`);
    assert.deepEqual(await cards(), [
      ['运行中', '1'], ['等待回复', '1'], ['异常', '1'],
      // 2 条 succeeded；那条 lifecycle done 不算 —— 它的徽标说的是「已完成」，
      // 不是这张卡说的「执行成功」。
      ['执行成功', '2'], ['全部记录', '6'],
    ]);

    // ── 状态那格：没有那个旧档 ────────────────────────────────────────────
    const options = await page.evaluate(`[...document.getElementById('directory-task-status').options]
      .map(o => [o.value, o.textContent])`);
    assert.deepEqual(options, [
      ['open', '进行中与待处理'], ['running', '运行中'], ['waiting', '等待回复'],
      ['error', '异常'], ['succeeded', '执行成功'], ['all', '全部记录'], ['archived', '已归档'],
    ]);
    assert.deepEqual(options.filter(([value, text]) => value === 'done' || text === '已完成'), [],
      '生命周期 done 不再是用户可选的一档');

    // ── 点卡片 = 按该档筛：列表里只有两条真跑成功的 ──────────────────────
    const titles = () => page.evaluate(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')]
      .map(el => el.textContent).sort()`);
    await page.evaluate(`document.querySelectorAll('#directory-stats .directory-stat')[3].click()`);
    assert.ok(await page.waitFor(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')].length===2`),
      '成功卡点开应该是两条执行成功的任务');
    assert.deepEqual(await titles(), ['登录页空状态文案', '结算页金额四舍五入']);
    assert.equal(await page.evaluate(`document.getElementById('directory-task-status').value`), 'succeeded',
      '卡片与状态那格是同一份筛选，点完要同步');
    await page.screenshot('directory-succeeded-filter.png');

    // 换成「全部记录」：那条旧记录还在，没被删也没被藏起来 —— 只是不再冒充成功。
    await page.evaluate(`(() => { const s=document.getElementById('directory-task-status'); s.value='all'; s.dispatchEvent(new Event('change')); })()`);
    assert.ok(await page.waitFor(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')].length===6`));
    assert.ok((await titles()).includes('旧看板时代的收尾记录'), '旧记录只在「全部记录」里见得到');

    // 直接选「执行成功」这一档：与点卡片同一份口径。
    await page.evaluate(`(() => { const s=document.getElementById('directory-task-status'); s.value='succeeded'; s.dispatchEvent(new Event('change')); })()`);
    assert.ok(await page.waitFor(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')].length===2`));
    assert.deepEqual(await titles(), ['登录页空状态文案', '结算页金额四舍五入']);

    assert.deepEqual(await page.evaluate('window.__errors'), []);
  });
});
