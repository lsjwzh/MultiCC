'use strict';
// 「技能同步」这一格这次从「嵌旧 manage 页的 iframe」改成了 Air 原生页（air-skillsync.js）。
// 每条断言对着旧页那份语义，不是只看「画出来了没有」：
//   ① 渲染是原生的 —— #admin-content 里没有 .air-legacy-frame，也没有任何 /manage.html
//      请求（iframe 的 src 会真的发出去，所以这条能证明它没被悄悄嵌回来）；
//   ② 打开面板只打 GET /api/skill-sync/status 一条，状态卡每格逐字对上那份快照
//      （含相对时间、队列格、错误行的两种情形）；
//   ③ 三端按 claude / codex / hermes 排在前面，别的键跟在后面；providers 为空时是空态；
//   ④ 过滤是本地过滤：打字不打接口，列表真的变短，排队的技能名标着「AI 转换中」；
//   ⑤ POST /api/skill-sync/run 的返回是 { ok, result } —— 页面必须画 result，而且
//      ok:false 时必须说失败，绝不能画成「同步完成」。
//
// 文案一条都不写死中文字面量：期望值现场用 t('key') 取回来再和页面比，
// 哪天词条改了这条测试不会假红。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('the Air skill-sync panel is native: status snapshot, provider order, local filter, run result', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-air-skillsync-qa');
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

  // 快照放在 fixture 里，路由读它 —— 面板画的是不是这一份、刷新跟不跟着改，才有东西可断。
  // 时间取「五分钟出头以前」：相对时间那格因此有确定的期望值，又不会卡在分钟边界上
  // （差出的那 10 秒是给测试跑动留的余量）。
  const TS = Date.now() - (5 * 60_000 + 10_000);
  let status = {
    ts: TS,
    sharedSkillCount: 3,
    linkCount: 5,
    skipCount: 2,
    convCount: 1,
    reverseImportCount: 4,
    error: null,
    // 故意把不在三端里的键写在最前面：画的顺序该由面板定（claude / codex / hermes 优先），
    // 不是由对象字面量的键序定。
    providers: {
      mystery: { linked: 9, skipped: 9, converted: 9 },
      hermes: { linked: 1, skipped: 0, converted: 0 },
      codex: { linked: 1, skipped: 2, converted: 1 },
      claude: { linked: 3, skipped: 0, converted: 0 },
    },
    sharedSkillNames: ['alpha-skill', 'beta-skill', 'gamma-skill'],
    aiQueue: { queueLength: 1, timerActive: true, items: [{ skillName: 'beta-skill' }] },
  };
  // run 的返回形状跟服务端一样是 { ok, result }，result 才是状态对象。
  let runPayload = { ok: true, result: null };
  routes['GET /api/skill-sync/status'] = () => json(status);
  routes['POST /api/skill-sync/run'] = async () => {
    // 拖一下：按钮「同步中…」+ 禁用那一瞬才有机会被断言到（真实同步是同步跑的）。
    await sleep(400);
    return json(runPayload);
  };
  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' }], clis: ['codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    const calls = () => page.requests.filter(r => r.path.startsWith('/api/skill-sync')).map(r => `${r.method} ${r.path}`);
    const posts = () => page.requests.filter(r => r.method === 'POST' && r.path === '/api/skill-sync/run');
    const text = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
    const count = selector => page.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    const tz = (key, params) => page.evaluate(`t(${JSON.stringify(key)}${params ? ',' + JSON.stringify(params) : ''})`);
    // 绝对时间那半格由面板用 getLocale() 格式化。期望值在同一个浏览器里按同一句算，
    // 不是为了偷懒：换台机器换种 locale 都该照样对上，写死一串日期就会假红。
    const stamp = ts => page.evaluate(`new Date(${ts}).toLocaleString(getLocale())`);
    const runButton = () => page.evaluate(`(() => { const b = document.getElementById('air-skillsync-run-btn'); return { disabled: b.disabled, text: b.textContent }; })()`);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ── ① 直接落在技能同步页：原生面板，不嵌旧 manage 页 ─────────────────────
    await page.navigate('/air?dir=d1&view=skillsync');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent === ${JSON.stringify(await tz('airAdminSkillSync'))}`),
      '页头说的是技能同步（adminHeadings 里有这一格）');
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-skillsync-providers .air-skillsync-provider').length === 4`), '面板画出来了');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0, '原生面板里没有旧 manage 的 iframe');
    assert.equal(page.requests.some(r => r.path === '/manage.html'), false, 'iframe 的 src 会真的发出去 —— 没这条请求才算真没嵌');
    // 工具条是 air-admin 给原生面板统一装的（返回 + 刷新）。旧 manage 那条路画的是
    // 「在新页面打开」，所以这组按钮本身就是「走的原生那条路」的证据。
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].map(b => b.textContent.replace(/\\s+/g,''))`),
      ['←' + await tz('airAdminBackToSettings'), '↻' + await tz('airAdminRefresh')],
      '工具条是面板自己的（返回设置中心 / 刷新），不是旧页面的');
    await page.screenshot('00-skillsync-native-desktop');

    // ── ② 打开面板只打一条状态请求，状态卡每格逐字对上快照 ───────────────────
    assert.deepEqual(calls(), ['GET /api/skill-sync/status'], '打开面板只打一条状态请求');
    const minutesAgo = await tz('airSkillsyncMinutesAgo', { n: 5 });
    assert.equal(await text('#air-skillsync-last'), `${await stamp(TS)} · ${minutesAgo}`,
      '上次同步 = 绝对时间 + 相对时间（相对时间那格是旧页 _ssRelTime 的搬迁）');
    assert.equal(await text('#air-skillsync-summary'), await tz('airSkillsyncSummary', { count: 3, rel: minutesAgo }), '面板头的摘要是「N 共享 · 多久以前」');
    assert.equal(await text('#air-skillsync-shared'), await tz('airSkillsyncSharedCount', { n: 3 }));
    assert.equal(await text('#air-skillsync-run'), await tz('airSkillsyncRunSummary', { linked: 5, skipped: 2, converted: 1, reverse: 4 }),
      '本轮结果 = 软链 / 跳过 / 转换 / 反向导入 四个数');
    assert.equal(await text('#air-skillsync-queue'),
      (await tz('airSkillsyncQueuePending', { n: 1 })) + (await tz('airSkillsyncQueueBusy')),
      '队列格：N 个待转换 + timerActive 时的批处理中');
    // 没出错时错误行要真的收起来 —— 行本身是 flex，光靠 hidden 属性压不住。
    assert.deepEqual(await page.evaluate(`(() => { const row = document.getElementById('air-skillsync-error-row'); return { hidden: row.hidden, visible: row.checkVisibility() }; })()`),
      { hidden: true, visible: false }, 'error 为空时错误行不出现');
    // 字段名也是文案：值那格是行里的第二个 span，第一个才是名字。
    assert.deepEqual(await page.evaluate(`(() => {
      const name = id => document.getElementById(id).parentElement.querySelector('span').textContent;
      return { last: name('air-skillsync-last'), shared: name('air-skillsync-shared'), run: name('air-skillsync-run'), queue: name('air-skillsync-queue'), error: name('air-skillsync-error') };
    })()`), {
      last: await tz('airSkillsyncLastRun'),
      shared: await tz('airSkillsyncSharedSkills'),
      run: await tz('airSkillsyncRunResult'),
      queue: await tz('airSkillsyncQueue'),
      error: await tz('airSkillsyncErrorLabel'),
    }, '每个字段名都走 i18n');

    // ── ③ 三端分发：顺序 claude / codex / hermes 优先，其余键跟在后面 ─────────
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#air-skillsync-providers .air-skillsync-badge')].map(el => el.textContent)`),
      ['claude', 'codex', 'hermes', 'mystery'], '三端排在最前，对象里多出来的键排在它们后面');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#air-skillsync-providers .air-skillsync-provider-meta')].map(el => el.textContent)`), [
      await tz('airSkillsyncProviderMeta', { linked: 3, skipped: 0, converted: 0 }),
      await tz('airSkillsyncProviderMeta', { linked: 1, skipped: 2, converted: 1 }),
      await tz('airSkillsyncProviderMeta', { linked: 1, skipped: 0, converted: 0 }),
      await tz('airSkillsyncProviderMeta', { linked: 9, skipped: 9, converted: 9 }),
    ], '每端的数字逐端对上');

    // ── ④ 共享技能列表 + 本地过滤 ───────────────────────────────────────────
    assert.equal(await text('#air-skillsync-list-count'), await tz('airSkillsyncListCount', { n: 3 }), '列表上方是共享技能条数');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#air-skillsync-list .air-skillsync-skill-name')].map(el => el.textContent)`),
      ['alpha-skill', 'beta-skill', 'gamma-skill']);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#air-skillsync-list .air-skillsync-queue-tag')].map(el => el.textContent)`),
      [await tz('airSkillsyncAiConverting')], 'aiQueue.items 里的技能名标着「AI 转换中」');
    const before = calls().length;
    // 输入即过滤：设 value 再派发 input，等价于真敲字（面板靠 oninput 收）。
    const typeFilter = value => page.evaluate(`(() => { const input = document.getElementById('air-skillsync-filter');
      input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await typeFilter('beta');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#air-skillsync-list .air-skillsync-skill-name')].map(el => el.textContent)`),
      ['beta-skill'], '过滤后列表真的变短');
    assert.equal(calls().length, before, '过滤是本地过滤，不打接口');
    await typeFilter('skill');
    assert.equal(await count('#air-skillsync-list .air-skillsync-skill'), 3, '清掉之前那份条件后重新算');
    await typeFilter('zzz');
    assert.equal(await count('#air-skillsync-list .air-skillsync-skill'), 0);
    assert.equal(await text('#air-skillsync-list .admin-empty'), await tz('airSkillsyncNoMatch'), '「筛没了」和「一个都没共享」说的不是同一件事');
    await typeFilter('');
    assert.equal(await count('#air-skillsync-list .air-skillsync-skill'), 3, '条件清空后列表回来');

    // ── ⑤ 刷新：换一份快照，空态 / 尚未同步 / 错误行三种情形一起验 ───────────
    status = {
      ts: null,
      sharedSkillCount: 0,
      linkCount: 0,
      skipCount: 0,
      convCount: 0,
      reverseImportCount: 0,
      error: 'link /home/u/.agents/skills/foo -> /home/u/.claude/skills/foo: EACCES',
      providers: {},
      sharedSkillNames: [],
      aiQueue: { queueLength: 0, timerActive: false, items: [] },
    };
    const base = calls().length;
    await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].find(b => b.textContent.includes(${JSON.stringify(await tz('airAdminRefresh'))})).click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#air-skillsync-providers .admin-empty').length === 1`), '空 providers 是空态');
    assert.deepEqual(calls().slice(base), ['GET /api/skill-sync/status'], '刷新重读同一条状态接口');
    assert.equal(await text('#air-skillsync-providers .admin-empty'), await tz('airSkillsyncNoProviders'));
    assert.equal(await text('#air-skillsync-list .admin-empty'), await tz('airSkillsyncNoSkills'));
    assert.equal(await text('#air-skillsync-last'), await tz('airSkillsyncNeverSynced'), 'ts 为空说「尚未同步」');
    assert.equal(await text('#air-skillsync-summary'), await tz('airSkillsyncSummary', { count: 0, rel: await tz('airSkillsyncNever') }));
    assert.equal(await text('#air-skillsync-queue'), await tz('airSkillsyncQueueIdle'), '队列为 0 说空闲');
    assert.equal(await text('#air-skillsync-run'), await tz('airSkillsyncRunSummary', { linked: 0, skipped: 0, converted: 0, reverse: 0 }));
    assert.deepEqual(await page.evaluate(`(() => { const row = document.getElementById('air-skillsync-error-row'); return { hidden: row.hidden, visible: row.checkVisibility(), text: document.getElementById('air-skillsync-error').textContent }; })()`),
      { hidden: false, visible: true, text: status.error }, 'error 有值才显示错误行，且原文照登');
    await page.screenshot('01-skillsync-empty-and-error');

    // ── ⑥ 立即同步：画的是 result，不是外层那个 { ok, result } ────────────────
    const RUN_TS = Date.now();
    runPayload = {
      ok: true,
      result: {
        ts: RUN_TS,
        sharedSkillCount: 2,
        linkCount: 7,
        skipCount: 1,
        convCount: 3,
        reverseImportCount: 2,
        error: null,
        providers: { claude: { linked: 6, skipped: 0, converted: 0 }, codex: { linked: 1, skipped: 1, converted: 3 } },
        sharedSkillNames: ['alpha-skill', 'delta-skill'],
        aiQueue: { queueLength: 0, timerActive: false, items: [] },
      },
    };
    await page.evaluate(`document.getElementById('air-skillsync-run-btn').click()`);
    assert.deepEqual(await runButton(), { disabled: true, text: await tz('airSkillsyncSyncing') }, '同步中按钮禁用并改文案');
    assert.ok(await page.waitFor(`document.getElementById('air-skillsync-state').classList.contains('is-ok')`), '跑完给出成功状态');
    assert.deepEqual(posts().map(r => `${r.method} ${r.path} ${r.body}`), ['POST /api/skill-sync/run {}'], '打的是真接口，POST 一条');
    assert.equal(await text('#air-skillsync-state'), await tz('airSkillsyncSyncDone'));
    assert.equal(await text('#air-skillsync-run'), await tz('airSkillsyncRunSummary', { linked: 7, skipped: 1, converted: 3, reverse: 2 }),
      '同步后是本轮结果 —— 写的是 result 里的数字，不是外层那个 { ok, result }');
    assert.equal(await text('#air-skillsync-last'), `${await stamp(RUN_TS)} · ${await tz('airSkillsyncJustNow')}`, '时间戳跟着 result 走');
    assert.equal(await text('#air-skillsync-queue'), await tz('airSkillsyncQueueIdle'), '队列格也换成 result 的');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#air-skillsync-providers .air-skillsync-badge')].map(el => el.textContent)`), ['claude', 'codex']);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#air-skillsync-list .air-skillsync-skill-name')].map(el => el.textContent)`), ['alpha-skill', 'delta-skill'], '列表换成本轮那份');
    assert.deepEqual(await runButton(), { disabled: false, text: await tz('airSkillsyncSyncNow') }, '跑完按钮恢复');
    await page.screenshot('02-skillsync-after-run');

    // ── ⑦ 接口说失败时页面必须说失败 ────────────────────────────────────────
    runPayload = { ok: false, message: 'sync already running' };
    await page.evaluate(`document.getElementById('air-skillsync-run-btn').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-skillsync-state').classList.contains('is-err')`), '失败要给失败状态');
    assert.equal(await text('#air-skillsync-state'), await tz('airSkillsyncSyncFailed', { error: 'sync already running' }));
    assert.notEqual(await text('#air-skillsync-state'), await tz('airSkillsyncSyncDone'), '失败绝不能被画成成功');
    assert.equal(await text('#air-skillsync-run'), await tz('airSkillsyncRunSummary', { linked: 7, skipped: 1, converted: 3, reverse: 2 }),
      '失败时上一次的数字原样留着，不画一份假的「同步完成」');
    assert.deepEqual(await runButton(), { disabled: false, text: await tz('airSkillsyncSyncNow') }, '失败后按钮照样恢复（失败不是死锁）');
    await page.screenshot('03-skillsync-run-failed');

    // ── ⑧ 窄屏：行要换得开，长错误串不许把卡片撑破 ───────────────────────────
    status = { ...status, error: 'x'.repeat(200) };
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.navigate('/air?dir=d1&view=skillsync');
    assert.ok(await page.waitFor(`document.getElementById('air-skillsync-error-row').hidden === false`), '窄屏上错误行照样渲染');
    const narrow = await page.evaluate(`(() => {
      const panel = document.querySelector('.air-skillsync-stack .admin-panel');
      const row = document.getElementById('air-skillsync-error');
      const box = panel.getBoundingClientRect(), value = row.getBoundingClientRect();
      return { valueRight: Math.round(value.right), boxRight: Math.round(box.right), hidden: document.getElementById('air-skillsync-error-row').hidden };
    })()`);
    assert.ok(narrow.valueRight <= narrow.boxRight + 1, `长错误串不许溢出卡片（${narrow.valueRight} vs ${narrow.boxRight}）`);
    await page.screenshot('04-skillsync-native-mobile');
  });
});
