'use strict';
// 「工作区」是最后一格还嵌着 /manage.html 的设置面板，这次搬成 Air 原生页
// （air-workspaces.js），旧管理台整页也随之删掉。它看的是 worktree 休眠回收 ——
// 会真的删掉被 .gitignore 忽略的未知文件 —— 所以这组断言盯的不是好不好看：
//   ① 渲染是原生的：#admin-content 里没有 .air-legacy-frame，也没有任何 /manage.html
//      请求（iframe 的 src 会真的发出去，所以这条能证明它没被悄悄嵌回来）；
//   ② 打开面板只读一次 overview —— 四张卡是同一份回包的四个切片，拆成四次请求会让
//      它们互相对不上；
//   ③ 四张卡都按回包画：超预算标记只在真超预算时出现、可选计数（待建/迁移中）缺省
//      时不占位、孤儿的「已删除／保留」跟 removed 走、审计里的目录条目带文件数与截断；
//   ④ 清扫期间两个按钮一起按住（有副作用的动作不许重入），结果原样写在按钮旁边；
//   ⑤ 清扫成功之后必须复读一次 overview —— 刚休眠掉的会话就在这四块里，不复读等于
//      让人看着过期的数字；而那句结果要在重画之后补回来，不能被「概览」冲掉；
//   ⑥ 清扫失败时不复读（四块还是清扫前那份），那句失败必须留在屏幕上并且染红。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('the Air workspaces panel is native: one overview read, guarded sweep, honest result line', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-air-workspaces-qa');
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

  // 概览放在 fixture 里由路由现读：清扫之后界面到底有没有跟着服务端变，才有东西可断。
  let overview = {
    status: { awakeLimit: 2, idleMs: 5_400_000, scheduled: true, stopped: false, sweeping: false },
    totals: { awake: 3, hibernated: 4 },
    directories: [
      { id: 'd1', path: '/projects/multicc', awake: 3, hibernated: 4, planned: 1, transitioning: 1, total: 9 },
      { id: 'd2', path: '/projects/quiet', awake: 1, hibernated: 0, planned: 0, transitioning: 0, total: 1 },
    ],
    removedIgnoredAudit: [{ sessionId: 's1', title: 'Fix login redirect', at: '2026-09-20T04:05:00.000Z',
      entries: [{ path: '.env.local', bytes: 2048 }, { path: 'node_modules', files: 120, truncated: true }] }],
    orphans: { at: '2026-09-20T03:00:00.000Z', total: 2, removed: 1, deleteOrphans: true, orphans: [
      { path: '/projects/multicc/.wt/a', branch: 'multicc/task-a', ahead: 0, dirty: false, removed: true },
      { path: '/projects/multicc/.wt/b', branch: null, ahead: 3, dirty: true, removed: false }] },
  };
  // 清扫要能演「跑得慢（按住按钮的那一段）」和「真失败」两条路。
  let sweepDelay = 0, sweepError = '';
  const sweepCalls = [];
  routes['/api/workspaces/overview'] = () => json(overview);
  routes['POST /api/workspaces/sweep'] = async ({ url }) => {
    sweepCalls.push(url.pathname + url.search); // 记全 query：orphans=1 带没带上是一条断言
    if (sweepDelay) await new Promise(resolve => setTimeout(resolve, sweepDelay));
    if (sweepError) return { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: sweepError }) };
    // 清扫真的改变了世界：复读那一次必须看到新数字，否则「复读」这条断言是空的。
    overview = { ...overview, totals: { awake: 1, hibernated: 6 } };
    return json({ ok: true, sweep: { considered: 5, hibernated: 2, budget: { hibernated: 1 } } });
  };

  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: 'MultiCC main repo', path: '/projects/multicc' }], clis: ['codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/settings/power'] = () => json({ available: false });

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    const overviewReads = () => page.requests.filter(r => r.method === 'GET' && r.path === '/api/workspaces/overview').length;
    const text = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
    const t = key => page.evaluate(`t(${JSON.stringify(key)})`);
    const tParams = (key, params) => page.evaluate(`t(${JSON.stringify(key)}, ${JSON.stringify(params)})`);
    const settle = async (list, n) => {
      const deadline = Date.now() + 20000;
      while (list.length < n && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(list.length, n, `expected ${n} sweep request(s), saw ${list.length}`);
    };

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ── ① 从设置中心进：原生面板，不嵌旧 manage 页 ────────────────────────
    await page.navigate('/air?dir=d1&view=settings');
    const settingsLabel = await t('airSettingsCenter');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent === ${JSON.stringify(settingsLabel)}`), '先落在设置中心');
    const before = overviewReads();
    const label = await t('airAdminPanelWorkspaces');
    await page.evaluate(`document.querySelector('[data-air-card="workspaces"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent === ${JSON.stringify(label)}`), '点进去落在工作区页');
    assert.equal(await page.evaluate(`document.getElementById('task-breadcrumb').textContent`), await t('airCrumbSettings'), '面包屑说的是设置中心这一类');
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-ws-dirs .air-ws-item').length === 2`), '四张卡都画出来了');
    assert.equal(overviewReads() - before, 1, '打开面板只读一次 overview —— 四张卡是同一份回包的四个切片');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0, '原生面板里没有旧 manage 的 iframe');
    assert.equal(page.requests.some(r => r.path === '/manage.html'), false, 'iframe 的 src 会真的发出去 —— 没这条请求才算真没嵌');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].map(b => b.textContent.replace(/\\s+/g,''))`),
      ['←' + await t('airAdminBackToSettings'), '↻' + await t('airAdminRefresh')], '工具条是面板自己的（返回设置中心 / 刷新）');

    // ── ② 概览：三行状态照回包读，阈值跨过一小时就换成小时 ────────────────
    const summary = await text('#air-ws-summary');
    assert.ok(summary.includes(await t('airWorkspacesTotalsAwake')) && summary.includes('3'), '活跃数来自 totals.awake');
    assert.ok(summary.includes(await tParams('airWorkspacesHours', { n: '1.5' })), '5400000ms 说成 1.5 小时，不是 90 分钟');
    assert.ok(summary.includes(await t('airWorkspacesSweeperOn')), 'scheduled 且没停 → 运行中');
    await page.screenshot('01-workspaces-native-desktop');

    // ── ③ 目录行：超预算只标真超的那一个，可选计数缺省时不占位 ────────────
    const dirs = await page.evaluate(`[...document.querySelectorAll('#air-ws-dirs .air-ws-item')].map(x => x.textContent)`);
    assert.ok(dirs[0].includes('/projects/multicc') && dirs[0].includes(await t('airWorkspacesOverBudget')), 'awake 3 > 预算 2 → 标超预算');
    assert.ok(!dirs[1].includes(await t('airWorkspacesOverBudget')), 'awake 1 <= 预算 2 → 不标');
    assert.ok(dirs[0].includes(await tParams('airWorkspacesDirPlanned', { n: '1' })), '待建有值就写出来');
    assert.ok(!dirs[1].includes(await tParams('airWorkspacesDirPlanned', { n: '0' })), '待建为 0 时整段不出现，不写「待建 0」');
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#air-ws-dirs .air-ws-path')).overflowWrap`), 'anywhere',
      '路径是要逐字比对的东西，长了必须断行而不是把卡片撑出去');

    // ── ④ 孤儿对账：删了的和留着的说法不一样，没有分支名时退到 (detached) ──
    const orphans = await page.evaluate(`[...document.querySelectorAll('#air-ws-orphans .air-ws-item')].map(x => x.textContent)`);
    assert.ok(orphans[0].includes(await t('airWorkspacesOrphanRemoved')), 'removed:true → 已删除');
    assert.ok(orphans[1].includes(await t('airWorkspacesOrphanKept')), 'removed:false → 保留（不是「已删除」）');
    assert.ok(orphans[1].includes(await t('airWorkspacesDetached')), '没有分支名时退到 (detached)，不是空白');
    assert.ok(orphans[1].includes(await t('airWorkspacesDirty')), 'dirty 必须说出来 —— 它决定敢不敢删');
    // 表头那行既说「什么时候对的账」也说「这次是报告还是真删」——后者决定上面两行
    // 的「已删除」是既成事实还是演习，所以必须同时在场。
    const orphanHead = await text('#air-ws-orphans .air-ws-sub');
    assert.ok(orphanHead.includes(await tParams('airWorkspacesOrphansHead', { at: '2026-09-20 11:00', n: '2' })), '表头说清上次对账时间与孤儿数');
    assert.ok(orphanHead.includes(await tParams('airWorkspacesOrphansDeleted', { n: '1' })), 'deleteOrphans:true → 表头写明这是删除模式');

    // ── ⑤ 审计：目录条目带文件数和截断标记，字节数人类可读 ────────────────
    const audit = await text('#air-ws-audit');
    assert.ok(audit.includes('Fix login redirect'), '按会话标题分组');
    assert.ok(audit.includes('2.0 KB'), '字节数换成人类单位');
    assert.ok(audit.includes(await tParams('airWorkspacesAuditDirCut', { n: '120' })), '被截断的目录要说「已截断」，否则会被读成只删了这些');

    // ── ⑥ 清扫：期间两个按钮一起按住，结果原样写在旁边，之后复读一次 ───────
    sweepDelay = 300;
    await page.evaluate(`document.getElementById('air-ws-sweep').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-ws-sweep').disabled === true
      && document.getElementById('air-ws-sweep-orphans').disabled === true`), '清扫期间两个按钮一起按住：有副作用的动作不许重入');
    assert.equal(await text('#air-ws-sweep-status'), await t('airWorkspacesSweeping'), '按住期间说清楚在等什么');
    const readsBeforeSweep = overviewReads();
    await settle(sweepCalls, 1);
    assert.ok(await page.waitFor(`document.getElementById('air-ws-sweep')?.disabled === false`), '跑完把按钮放开');
    const done = await tParams('airWorkspacesSweepDone', { considered: '5', hibernated: '2', budget: '1' });
    assert.ok(await page.waitFor(`document.getElementById('air-ws-sweep-status')?.textContent === ${JSON.stringify(done)}`),
      '结果逐字段原样写在按钮旁边 —— 面板重绘之后 toast 早没了，而人恰恰是回来看这个的');
    assert.ok(await page.evaluate(`document.getElementById('air-ws-sweep-status').className.includes('ok')`), '成功不染红');
    assert.equal(overviewReads() - readsBeforeSweep, 1, '成功之后复读一次：刚休眠掉的会话就在这四块里');
    assert.ok((await text('#air-ws-summary')).includes('6'), '复读画的是新数字（休眠 4 → 6），不是清扫前那份');
    assert.equal(sweepCalls[0], '/api/workspaces/sweep', '不带 orphans 的清扫就不要带那个参数');
    await page.screenshot('02-workspaces-after-sweep');

    // 「清扫＋孤儿对账」是另一条路：同一支接口，多一个 orphans=1。
    sweepDelay = 0;
    await page.evaluate(`document.getElementById('air-ws-sweep-orphans').click()`);
    await settle(sweepCalls, 2);
    assert.ok(sweepCalls[1].includes('orphans=1'), '「清扫＋孤儿对账」要把 orphans=1 带上，否则跟上一颗没区别');

    // ── ⑦ 清扫失败：那句话必须留着并染红，而且不复读 ──────────────────────
    sweepError = 'hibernation runtime not ready';
    const readsBeforeFail = overviewReads();
    await page.evaluate(`document.getElementById('air-ws-sweep').click()`);
    await settle(sweepCalls, 3);
    assert.ok(await page.waitFor(`document.getElementById('air-ws-sweep-status')?.className.includes('err')`), '失败要染红');
    assert.ok((await text('#air-ws-sweep-status')).includes(sweepError), '服务端那句原因要原样带出来，不是一句「失败了」');
    assert.equal(await page.evaluate(`document.getElementById('air-ws-sweep').disabled`), false, '失败也要把按钮放开，否则这一格就废了');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(overviewReads(), readsBeforeFail, '失败时不复读 —— 重画一遍只会把这句话冲掉，而四块本来就还是清扫前那份');
    await page.screenshot('03-workspaces-sweep-failed');
  });
});
