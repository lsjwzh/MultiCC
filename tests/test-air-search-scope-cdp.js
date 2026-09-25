'use strict';
// 搜索框的两条语料在真浏览器里合流：任务板（标题/摘要）和会话正文（FTS5）。
//
// 这里守的是整条链路上最容易「看起来对、其实没接上」的一环 —— 只在对话正文里出现过
// 的词。任务板那一条命中很容易伪造（本地按标题就能筛出来），所以 fixture 里专门放了两
// 条**标题里没有查询词**的任务：一条在办、一条已归档，只有 /api/search/messages 认得
// 它们。界面上出现这两行，只可能是服务端把会话命中带上任务 id 递回来了。
//
// 另一半是「搜索范围」那格：换成「仅任务标题与摘要」必须重新问服务端（两条语料召回
// 不同），会话命中整体消失、任务板命中照旧；换回来又都回来 —— 不是重画一次界面而已。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const QUERY = '空状态';

test('the task search box finds conversation-only hits, and the scope switch narrows it back', async t => {
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
  const task = (id, title, status, updatedAt) => ({ id, dirId: 'd1', title, status, runState: 'idle', updatedAt,
    resource: { residency: 'planned', lease: 'idle' } });
  // 前 12 条用来把「最近任务」撑过一屏（否则「全部任务」那个入口自己不出现），
  // 最后三条才是被断言的：标题命中 / 只在对话里 / 只在对话里且已归档。
  const tasks = [
    ...Array.from({ length: 12 }, (_, i) => task(`t${i + 1}`, `目录任务 ${i + 1}`, 'active', 1000 + i)),
    task('tsk-title', '登录页空状态文案', 'active', 900),
    task('tsk-msg', '结算页金额四舍五入错误', 'active', 800),
    task('tsk-arch', '老任务：导入导出重构', 'archived', 700),
  ];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex'], migration: { errors: [] }, tasks, sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  const asked = [];
  const window = (text, from, to) => ({ text, ranges: [[from, to]] });
  // 任务板语料只认标题里那一条（它也是本地筛选能筛出来的那条）。
  routes['/api/task-board/search'] = ({ url }) => {
    asked.push(['board', url]);
    return json({ ok: true, query: url.searchParams.get('q'), count: 1,
      results: [{ taskId: 'tsk-title', score: 3, snippet: window(`登录页${QUERY}文案`, 3, 3 + QUERY.length) }] });
  };
  routes['/api/search/messages'] = ({ url }) => {
    asked.push(['messages', url]);
    return json({ ok: true, query: url.searchParams.get('q'), count: 2, mode: 'message', warming: false, results: [
      { sessionId: 'sess-msg', messageId: 'm-1', kind: 'user', updatedAt: 20, score: 2,
        taskIds: ['tsk-msg'], snippet: window(`…确认一下${QUERY}时的兜底…`, 5, 5 + QUERY.length) },
      { sessionId: 'sess-arch', messageId: 'm-2', kind: 'assistant', updatedAt: 10, score: 1,
        taskIds: ['tsk-arch'], snippet: window(`…当年${QUERY}那次重构…`, 3, 3 + QUERY.length) },
    ] });
  };

  await withCdpHarness({ routes }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.getElementById('directory-task-more')!==null`));
    await page.evaluate(`document.getElementById('directory-task-more').click()`);
    assert.equal(await page.evaluate(`document.getElementById('directory-task-controls').hidden`), false);
    // 默认范围就是最宽的那档：搜索的默认目标是全部记录（含对话）。两档都得说人话
    // （漏翻时 t() 只会把 key 原样显示出来）。
    assert.equal(await page.evaluate(`document.getElementById('directory-task-scope').value`), 'full');
    assert.deepEqual(await page.evaluate(`[...document.getElementById('directory-task-scope').options].map(o=>o.textContent)`),
      ['全部记录（含对话）', '仅任务标题与摘要']);

    const titles = () => page.evaluate(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')].map(el=>el.textContent)`);
    await page.evaluate(`(() => { const i=document.getElementById('directory-task-search'); i.value=${JSON.stringify(QUERY)}; i.dispatchEvent(new Event('input')); })()`);
    assert.ok(await page.waitFor(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')].length===3`),
      '只在对话里出现过的两条也得被找回来');
    assert.deepEqual(await titles(), ['登录页空状态文案', '结算页金额四舍五入错误', '老任务：导入导出重构'],
      '任务板命中在前，会话命中按服务端相关度接在后面；已归档的会话命中不被状态口径滤掉');

    // 命中理由：标题里没有查询词的那两行，唯一能解释「为什么搜出它」的就是会话片段
    // （第一行是任务板那条自己的窗口，两条语料回来的片段形状是同一个）。
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#directory-task-list .task-snippet')].map(el=>el.textContent)`),
      ['登录页空状态文案', '…确认一下空状态时的兜底…', '…当年空状态那次重构…']);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#directory-task-list .task-snippet mark')].map(el=>el.textContent)`),
      [QUERY, QUERY, QUERY], '高亮区间由服务端算好，客户端只照着画');

    // 两条语料并行，各问一次（面板打开时那次空查询不打扰接口），目录照旧参与收窄。
    assert.deepEqual(asked.map(([which]) => which).sort(), ['board', 'messages']);
    assert.equal(new URL(asked.find(([which]) => which === 'board')[1], 'http://x').searchParams.get('dirId'), 'd1',
      '目录面板的全文检索仍限定在本目录');

    // 换成「仅任务标题与摘要」：会话命中整体消失，任务板命中照旧。
    const before = asked.length;
    await page.evaluate(`(() => { const s=document.getElementById('directory-task-scope'); s.value='board'; s.dispatchEvent(new Event('change')); })()`);
    // 列表立刻退回本地筛选（会话命中没了就是没了），服务端那次按防抖晚一拍到。
    assert.ok(await page.waitFor(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')].length===1`),
      '换范围：只剩任务板那一条');
    assert.deepEqual(await titles(), ['登录页空状态文案']);
    await page.evaluate(`new Promise(done => setTimeout(done, 400))`);
    assert.deepEqual(asked.slice(before).map(([which]) => which), ['board'],
      '换到窄范围要重新问一次任务板，且不再问会话索引');

    // 换回来：两档各有一份缓存（key 里带着范围），所以这一下是立刻的、不再打接口。
    await page.evaluate(`(() => { const s=document.getElementById('directory-task-scope'); s.value='full'; s.dispatchEvent(new Event('change')); })()`);
    assert.ok(await page.waitFor(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')].length===3`),
      '会话命中回来了');
    assert.deepEqual(asked.slice(before + 1), [], '这一档刚问过，退回来走缓存就够了');

    // 控制台那份搜索共用同一套口径：它没有摆开关的位置，就固定按最宽的那档来。
    await page.evaluate(`document.getElementById('overview').click()`);
    assert.ok(await page.waitFor(`document.body.classList.contains('console-open')`));
    assert.equal(await page.evaluate(`document.getElementById('console-task-scope')?.value`), 'full');
  });
});
