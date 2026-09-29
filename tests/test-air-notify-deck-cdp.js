'use strict';
// 右下角那块提醒牌堆（public/air-notify-deck.js 画、air-task-notify.js 喂）必须和
// 侧栏那行「未读」标记照同一面镜子：服务端还挂着 attention 的任务，行是红的、牌堆就
// 该有卡，跟这张卡「什么时候第一次出现」无关。
//
// 回归的那一条：喂牌堆的闸门以前直接复用了「已经响过」那个跨标签水位（本来只管②声音），
// 于是【响过一次、又一直没被打开】的标记 —— 刷新一次、换个标签页、iOS 把页面回收后重载
// —— 行还红着、右下角却是空的。fixture 因此故意把水位先写高（等于「这个浏览器已经轮询
// 过一轮」的常态），再断言牌堆照旧把这三条挂出来。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

// 2100 年：下面每条标记的 at 都小于它，等价于「都已经响过/见过」。
const SEEDED_HEARD = 4102444800000;

test('a still-pending mark keeps its card across a reload: the deck mirrors the row', async t => {
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
  // 三条待办标记：出错、等回答、完成 —— 优先级依次递减（牌堆折叠时最上面那张是最要紧的）。
  const marked = (id, title, runState, kind, at) => ({ id, dirId: 'd1', title, status: 'active', runState,
    updatedAt: 1000 + at, attention: { kind, at }, resource: { residency: 'planned', lease: 'idle' } });
  const tasks = [
    marked('tsk-err', '炸了的活', 'error', 'error', 9002),
    marked('tsk-wait', '等人回答的活', 'waiting', 'waiting', 9001),
    marked('tsk-ok', '跑完的活', 'succeeded', 'completed', 9000),
  ];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex'], migration: { errors: [] }, tasks, sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  // 卡的种类写在 k-<kind> 上（air-notify-deck.js 的 render），不认文案 —— 与语言无关。
  const kinds = page => page.evaluate(`[...document.querySelectorAll('.task-notify-card')]
    .map(el => el.className.split(' ').find(cls => cls.startsWith('k-')).slice(2))`);
  const rows = page => page.evaluate(`[...document.querySelectorAll('#tasks button')]
    .filter(el => el.classList.contains('unseen')).map(el => el.dataset.task)`);

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-notify-deck-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source:
      `try { localStorage.setItem('air:notify-heard', '${SEEDED_HEARD}'); } catch (_) {}` });
    await page.navigate('/air?dir=d1');
    await page.evaluate(String.raw`(() => {
      window.__errors = [];
      addEventListener('error', event => __errors.push(String(event.message)));
      addEventListener('unhandledrejection', event => __errors.push('unhandledrejection: ' + String(event.reason && event.reason.message)));
    })()`);

    // 前提先立住：页面读到的水位就是我们种下的那个高水位（否则下面证明不了什么）。
    assert.ok(await page.waitFor(`document.querySelectorAll('#tasks button.unseen').length === 3`,
      { timeoutMs: 15000, intervalMs: 200 }), 'the three marks show on the sidebar rows');
    assert.equal(await page.evaluate(`localStorage.getItem('air:notify-heard')`), String(SEEDED_HEARD),
      'the seeded watermark is what this page rang up to');
    assert.deepEqual((await rows(page)).sort(), ['tsk-err', 'tsk-ok', 'tsk-wait']);

    // 一进来就该有 —— 不是「等下一轮新标记」：标记早就挂在那里了。
    assert.ok(await page.waitFor(`document.querySelectorAll('.task-notify-card').length === 3`,
      { timeoutMs: 10000, intervalMs: 200 }), 'a pending mark has its card even though it was already rung');
    assert.deepEqual((await kinds(page)).sort(), ['completed', 'error', 'waiting']);
    assert.equal(await page.evaluate(`document.querySelector('.task-notify-card.is-top').className.split(' ')
      .find(cls => cls.startsWith('k-'))`), 'k-error', 'the most important card is on top');
    assert.equal(await page.evaluate(`document.querySelector('.task-notify-badge').textContent`), '3');

    // 点一下展开：三张卡沿弧线散开。
    await page.evaluate(`document.querySelector('.task-notify-card.is-top').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.task-notify-deck').classList.contains('is-open')`,
      { timeoutMs: 5000, intervalMs: 100 }), 'clicking the folded deck fans it out');
    const spread = await page.evaluate(`[...document.querySelectorAll('.task-notify-card')]
      .map(el => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; })`);
    assert.equal(new Set(spread.map(point => point.join(','))).size, 3, 'each card has its own place on the arc');
    await page.screenshot('fanned-out.png');

    // 重载：标记还在（没人打开过它），右下角就不该空着。
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('.task-notify-card').length === 3`,
      { timeoutMs: 15000, intervalMs: 200 }), 'a reload does not erase a reminder that is still pending');
    assert.equal(await page.evaluate(`(window.__errors || []).join(' | ')`), '', 'no page errors');
  });
});
