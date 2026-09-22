'use strict';
// Goal 预检这一格这次从「嵌旧 manage 页的 iframe」改成了 Air 原生页（air-goal.js）。
// 它管的是一份会影响「发任务前先预检」行为的配置，所以每一条都要在真浏览器里断到：
//   ① 渲染是原生的 —— #admin-content 里没有 .air-legacy-frame，也没有任何 /manage.html
//      请求（iframe 的 src 会真的发出去，所以这条能证明它没被悄悄嵌回来）；
//   ② 打开面板只读一次 —— 就 GET /api/settings/goal 一条；
//   ③ 回显逐项对上 —— 四个维度的勾选和阈值输入框按服务端给的值画，别自己发明默认值；
//   ④ 保存打的是真接口 —— POST 的 body 逐字段断言，且保存后会重新读一次（服务端
//      clamp / 补默认，回显才是唯一真相）；
//   ⑤ 失败要看得见 —— 面板内的状态行必须出现那句错误，右下角提示也不许还挂着上一次
//      成功的回执。
// 文案一律用 t('airGoalXxx') 从页面里取回来比，不写死中文字面量 —— 这样 i18n 合并
// 前后（key 只在 /tmp 清单里、还没进 i18n-catalog 时 t() 会回退成 key 本身）都稳。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('the Air Goal panel is native: one read, per-dimension echo, exact POST body, visible failures', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-air-goal-qa');
  const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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

  // 服务端状态放在夹具里，路由读写它 —— 「画的是不是服务端那份」才有东西可断。
  const DIMS = { objective: false, criteria: true, scope: false, executable: true };
  let goal = { dimensions: { ...DIMS }, minScore: 75 };
  let getFails = false, postFails = false;
  const posts = [];
  const gets = [];
  // 跟真服务端（src/routes/aux-goal.js 的 normalizeGoalConfig）同一套钳制：维度只认
  // 布尔、阈值 clamp 到 0-100。有这一层，末段才能验「保存后重新读回来的确实是服务端
  // 那份、不是本地提交的那份」。
  const normalize = body => ({
    dimensions: Object.fromEntries(Object.entries(DIMS).map(([key]) => [key, typeof (body.dimensions || {})[key] === 'boolean' ? body.dimensions[key] : true])),
    minScore: Math.max(0, Math.min(100, Number.isFinite(parseInt(body.minScore, 10)) ? parseInt(body.minScore, 10) : 60)),
  });
  routes['GET /api/settings/goal'] = () => {
    gets.push('GET');
    return getFails ? json({ ok: false, message: 'goal 读取失败（fixture）' }, 500) : json(goal);
  };
  routes['POST /api/settings/goal'] = req => {
    if (postFails) return json({ ok: false, message: 'goal 写入失败（fixture）' }, 500);
    posts.push(JSON.parse(req.body));
    goal = normalize(posts[posts.length - 1]);
    return json({ ok: true, ...goal });
  };
  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' }], clis: ['codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    const text = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
    const tr = key => page.evaluate(`t(${JSON.stringify(key)})`);
    const boxState = key => page.evaluate(`document.getElementById('air-goal-dim-${key}').checked`);
    const savePosts = () => page.requests.filter(r => r.method === 'POST' && r.path === '/api/settings/goal');
    const goalCalls = () => page.requests.filter(r => r.path === '/api/settings/goal').map(r => `${r.method} ${r.path}`);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ── ① 直接开 /air?view=goal：原生面板，不嵌旧 manage 页 ────────────────
    await page.navigate('/air?dir=d1&view=goal');
    assert.ok(await page.waitFor(`document.querySelector('#admin-content .air-goal') !== null`), 'goal 面板渲染出来了');
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent`), await tr('airAdminGoal'),
      '页头标题走的是 air.js adminHeadings 里那个 key，不是 mode 名');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0, '原生面板里没有旧 manage 的 iframe');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content iframe').length`), 0, '面板正文里一个 iframe 都不该有');
    assert.equal(page.requests.some(r => r.path === '/manage.html'), false, 'iframe 的 src 会真的发出去 —— 没这条请求才算真没嵌');
    // 样式是这个模块自己带的（air.css 不认识 air-goal-* 这些类），且真的生效了。
    assert.equal(await page.evaluate(`document.querySelector('#admin-content style')?.textContent.includes('.air-goal-dim')`), true,
      '面板把自己的样式节点插在根节点下');
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.air-goal-dim')).borderRadius`), '12px',
      '样式真的落到了控件上（12px 是模块自己写的，air.css 的 .admin-panel 是 22px）');
    // air.css 顶上那条 `input, select, textarea { width: 100% }` 是给文本框写的：勾选框
    // 要是没把自己的宽度收回来，就会撑满整行、把右边的维度文案挤到卡片外面去
    // （截图里看得到，但 DOM 上「行没溢出」照样成立 —— 溢出的是一行里的内容）。
    const geom = await page.evaluate(`(() => {
      const row = document.querySelector('.air-goal-dim');
      const box = row.querySelector('input');
      const copy = row.querySelector('.air-goal-dim-copy');
      return { boxWidth: Math.round(box.getBoundingClientRect().width),
        copyRight: Math.round(copy.getBoundingClientRect().right), rowRight: Math.round(row.getBoundingClientRect().right) };
    })()`);
    assert.ok(geom.boxWidth <= 20, `勾选框不该撑满整行（实测 ${geom.boxWidth}px）`);
    assert.ok(geom.copyRight <= geom.rowRight + 1, `维度文案不许溢出卡片（${geom.copyRight} vs ${geom.rowRight}）`);
    await page.screenshot('00-goal-native-desktop');

    // ── ② 打开面板只读一次 ────────────────────────────────────────────────
    assert.ok(await page.waitFor(`document.getElementById('air-goal-min-score').value !== ''`), '服务端那份阈值画进来了');
    assert.deepEqual(goalCalls(), ['GET /api/settings/goal'], '打开面板只打一条读取请求');
    assert.deepEqual(gets, ['GET']);

    // ── ③ 回显逐项对上：四个维度 + 阈值 ───────────────────────────────────
    for (const [key, expected] of Object.entries(DIMS)) {
      assert.equal(await boxState(key), expected, `维度 ${key} 的勾选状态照服务端画`);
    }
    assert.equal(await page.evaluate(`document.getElementById('air-goal-min-score').value`), '75', '阈值照服务端画');
    // 标签文案来自 i18n key（合并前后都比 key 本身稳）。
    assert.equal(await text('.air-goal-dims > h4'), await tr('airGoalDimsTitle'));
    assert.equal(await text('.air-goal-dims .air-goal-dim b'), await tr('airGoalObjective'), '第一行是目标明确');
    assert.equal(await text('.air-goal-dims .air-goal-dim small'), await tr('airGoalObjectiveHint'), '每行后面跟着它自己的说明');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.air-goal-dims .air-goal-dim b')].map(n => n.textContent)`),
      await page.evaluate(`['airGoalObjective','airGoalCriteria','airGoalScope','airGoalExecutable'].map(k => t(k))`), '四个维度按旧页的序');
    assert.equal(await text('.air-goal-score-field > span'), await tr('airGoalMinScore'));

    // ③b 缺省的维度算启用：服务端只给了两个键（老配置文件、字段缺失）时，没提到的
    //     那两个必须是勾上的。这一条是「!== false」而不是「=== true」的唯一区别，
    //     上面那份四个布尔齐全的夹具分辨不出来。
    goal = { dimensions: { objective: false, criteria: false }, minScore: 30 };
    await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].find(b => b.textContent.includes(${JSON.stringify(await tr('airAdminRefresh'))})).click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-goal-min-score').value === '30'`), '刷新读回新的那份');
    assert.deepEqual(await page.evaluate(`['objective','criteria','scope','executable'].map(k => document.getElementById('air-goal-dim-'+k).checked)`),
      [false, false, true, true], '服务端没提到的维度算启用（缺省 = 开，只有显式 false 才算关）');

    // ── ④ 保存：改掉勾选与阈值，body 逐字段断言 ──────────────────────────
    await page.evaluate(`(() => {
      document.getElementById('air-goal-dim-objective').checked = true;
      document.getElementById('air-goal-dim-criteria').checked = false;
      document.getElementById('air-goal-dim-scope').checked = true;
      document.getElementById('air-goal-min-score').value = '40';
      document.getElementById('air-goal-save').click();
    })()`);
    // 成功回执出现 = POST 已经回来、紧随其后的那次重读也已经画完 —— 下面才好逐字段断。
    assert.ok(await page.waitFor(`document.getElementById('air-goal-status').textContent === ${JSON.stringify(await tr('airGoalStatusSaved'))}`),
      '面板内的状态行显示了成功回执');
    assert.equal(savePosts().length, 1, '保存打出了 POST');
    assert.deepEqual(savePosts()[0].body && JSON.parse(savePosts()[0].body), {
      dimensions: { objective: true, criteria: false, scope: true, executable: true },
      minScore: 40,
    }, 'POST body 就是 dimensions + minScore 两项，逐字段对得上');
    const saved = JSON.parse(savePosts()[0].body);
    for (const [key, expected] of Object.entries({ objective: true, criteria: false, scope: true, executable: true })) {
      assert.equal(saved.dimensions[key], expected, `body.dimensions.${key}`);
    }
    assert.equal(saved.minScore, 40, 'body.minScore');
    assert.deepEqual(Object.keys(saved).sort(), ['dimensions', 'minScore'], 'body 只有这两项');
    assert.equal(await text('#notice'), await tr('airGoalSaved'), '右下角也回执一句');
    assert.deepEqual(goalCalls(), ['GET /api/settings/goal', 'GET /api/settings/goal', 'POST /api/settings/goal', 'GET /api/settings/goal'],
      '工具条上那次刷新各算一条；保存后还要重新读一次（服务端 clamp / 补默认，回显才是唯一真相）');
    await page.screenshot('01-goal-after-save');

    // 服务端钳制过的那份才是真相：提交 150，读回来必须变成 100。
    await page.evaluate(`(() => { document.getElementById('air-goal-min-score').value = '150';
      document.getElementById('air-goal-save').click(); })()`);
    assert.ok(await page.waitFor(`document.getElementById('air-goal-min-score').value === '100'`),
      '输入框跟着服务端回显走（150 被钳成 100），不是本地提交了什么就显示什么');
    assert.equal(await boxState('scope'), true, '维度也照回显画');
    assert.equal(await boxState('criteria'), false);

    // ── ⑤ 失败要看得见：状态行必须出现那句错误，提示不许假装成功 ───────────
    postFails = true;
    await page.evaluate(`(() => { document.getElementById('air-goal-dim-scope').checked = false;
      document.getElementById('air-goal-save').click(); })()`);
    const failure = (await tr('saveFailed')).replace('{error}', 'goal 写入失败（fixture）');
    assert.ok(await page.waitFor(`document.getElementById('air-goal-status').textContent === ${JSON.stringify(failure)}`),
      '保存失败时面板内的状态行写着那句错误');
    assert.equal(await page.evaluate(`document.getElementById('air-goal-status').className.includes('error')`), true, '状态行是错误态');
    assert.equal(await page.evaluate(`document.getElementById('notice').textContent === ${JSON.stringify(await tr('airGoalSaved'))}`), false,
      '右下角提示不许还挂着上一次成功的回执');
    assert.equal(await page.evaluate(`document.getElementById('notice').textContent.includes('fixture')`), true, '提示里说的是这次失败的原因');
    assert.equal(await page.evaluate(`document.getElementById('air-goal-dim-scope').checked`), false, '失败时勾选框保持用户改过的样子，不回滚');
    await page.screenshot('02-goal-save-failed');

    // 读取失败也不许对着一份空表单点保存：横幅把话说清楚。
    postFails = false;
    getFails = true;
    await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].find(b => b.textContent.includes(${JSON.stringify(await tr('airAdminRefresh'))})).click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-goal-load-error').hidden === false`), '读取失败的横幅露出来了');
    assert.equal(await page.evaluate(`document.getElementById('air-goal-load-error').className.includes('admin-empty')`), true, '用的是各面板统一的空态样式');
    assert.equal(await page.evaluate(`document.getElementById('air-goal-load-error').textContent.includes('fixture')`), true, '横幅里是那句错误本身');
    assert.equal(await boxState('scope'), false, '读不到时不清空表单（别把默认值写回去）');

    // ── ⑥ 窄屏：四个维度与阈值不该被挤成一条缝 ─────────────────────────────
    getFails = false;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.navigate('/air?dir=d1&view=goal');
    assert.ok(await page.waitFor(`document.querySelectorAll('#admin-content .air-goal-dim').length === 4`), '窄屏上四个维度照样渲染');
    const narrow = await page.evaluate(`(() => {
      const row = document.querySelector('#admin-content .air-goal-dim');
      const host = document.getElementById('admin-content');
      const copy = row.querySelector('.air-goal-dim-copy');
      return { right: Math.round(row.getBoundingClientRect().right), limit: Math.round(host.getBoundingClientRect().right),
        copyRight: Math.round(copy.getBoundingClientRect().right) };
    })()`);
    assert.ok(narrow.right <= narrow.limit + 1, `维度卡片不许溢出内容区（${narrow.right} vs ${narrow.limit}）`);
    assert.ok(narrow.copyRight <= narrow.right + 1, `窄屏上维度文案也得待在卡片里（${narrow.copyRight} vs ${narrow.right}）`);
    assert.equal(await page.evaluate(`document.getElementById('admin-content').scrollWidth <= document.getElementById('admin-content').clientWidth + 1`),
      true, '内容区不该出现横向滚动条（勾选框被 air.css 的 input{width:100%} 撑开时就撑出来了）');
    await page.screenshot('03-goal-native-mobile');

    // ── ⑦ 入口：设置中心那一格点进去落的是同一个原生面板 ───────────────────
    // 上面几段走的是 /air?view=goal 这条直达路；人平常是从设置中心那张卡进来的，
    // 那条路也得自己渲染一遍（走的是 air-admin 的 nativePanels 表）。
    await page.navigate('/air?dir=d1&view=settings');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent === ${JSON.stringify(await tr('airSettingsCenter'))}`), '先落在设置中心');
    await page.evaluate(`[...document.querySelectorAll('#admin-content .air-setting-card')]
      .find(card => card.querySelector('strong')?.textContent === ${JSON.stringify(await tr('airAdminPanelGoal'))}).click()`);
    assert.ok(await page.waitFor(`document.querySelector('#admin-content .air-goal') !== null`), '设置中心那一格点进去是同一个面板');
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent`), await tr('airAdminGoal'));
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0, '这条入口也不许退回 iframe');
    assert.equal(page.requests.some(r => r.path === '/manage.html'), false, '整轮下来一条 /manage.html 请求都没有');
  });
});
