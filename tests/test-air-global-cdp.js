'use strict';
// 「全局配置」这一格这次从「嵌旧 manage 页的 iframe」改成了 Air 原生页（air-global.js）。
// 它装的是两条会真的改主机行为的开关，不是外观偏好，所以每一条都要在真浏览器里断到：
//   ① 渲染是原生的 —— #admin-content 里没有 .air-legacy-frame，也没有任何 /manage.html
//      请求（iframe 的 src 会真的发出去，所以这条能证明它没被悄悄嵌回来）；
//   ② 打开面板只读那两条状态 —— GET /api/settings/official-oauth 与 GET /api/settings/power
//      各一次（外壳自己 boot 时也读过 power，所以比的是「点进去之后新增的」那一截）；
//   ③ OAuth：勾选态跟着服务端走；开启是有风险的那一侧，开启前必须先问一句 —— 答「否」时
//      一个写入请求都不许发、勾选退回原位；答「是」才发，body 逐字段断言，成功提示必须
//      带「下一轮 spawn 生效」那半句；
//   ④ 关盖运行：available:false 时整卡不出现（不是灰掉）、error 有值要在页面上现形、
//      勾选态以服务端回的 enabled 为准、写入失败时勾选必须回滚；
//   ⑤ 安装包（APK / iOS OTA）不在这页重复第二张卡 —— 侧栏「主机操作」那颗才是唯一入口。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('the Air global panel is native: install hint, guarded OAuth switch, macOS lid-sleep switch', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-air-global-qa');
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

  // 两个开关的状态都放在 fixture 里，路由读写它 —— 界面跟不跟着服务端走，才有东西可断。
  let oauth = { enabled: true };
  let power = { available: true, enabled: true };
  let oauthError = '';
  // 关盖运行那一步会在 Mac 上弹系统授权框：这几个旋钮让「正在等授权 / 服务端说了别的 /
  // 授权被取消」三条路都能在测试里确定性地走一遍。
  let powerDelay = 0, powerNegate = false, powerError = '';
  const oauthPosts = [], powerPosts = [];
  routes['GET /api/settings/official-oauth'] = () => json({ enabled: oauth.enabled });
  routes['POST /api/settings/official-oauth'] = req => {
    const body = JSON.parse(req.body);
    oauthPosts.push(body);
    if (oauthError) {
      return { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: oauthError }) };
    }
    oauth = { enabled: !!body.enabled };
    return json({ ok: true, enabled: oauth.enabled });
  };
  routes['GET /api/settings/power'] = () => json(power);
  routes['POST /api/settings/power'] = async req => {
    const body = JSON.parse(req.body);
    powerPosts.push(body);
    if (powerDelay) await new Promise(resolve => setTimeout(resolve, powerDelay));
    if (powerError) {
      return { status: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: powerError }) };
    }
    const enabled = powerNegate ? !body.enabled : !!body.enabled;
    power = { available: true, enabled };
    return json({ ok: true, available: true, enabled });
  };
  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' }], clis: ['codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    // 外壳自己也读这两条（侧栏「关盖运行」那颗），所以只盯这两条接口、并且拿
    // 「点进面板之前」当基准，才分得清哪一次是面板打的。
    const calls = () => page.requests
      .filter(r => /^\/api\/settings\/(official-oauth|power)$/.test(r.path))
      .map(r => `${r.method} ${r.path}`);
    const text = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
    const t = key => page.evaluate(`t(${JSON.stringify(key)})`);
    const tParams = (key, params) => page.evaluate(`t(${JSON.stringify(key)}, ${JSON.stringify(params)})`);
    // 「服务端那句话已经落地了」的判据是 Node 侧收到的请求数：面板发完就等回包，
    // 断言前先确保回包已经拿到（否则读到的是还在路上的中间态）。
    const settle = async (list, n) => {
      const deadline = Date.now() + 20000;
      while (list.length < n && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(list.length, n, `expected ${n} request(s), saw ${list.length}`);
    };

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ── ⓪ 安装包的入口在侧栏，是唯一那个（这一页不再有第二张下载卡） ───────
    await page.navigate('/air?dir=d1&view=overview');
    assert.ok(await page.waitFor(`document.body.classList.contains('console-open')`), '控制台打开');
    // 它住在侧栏「更多与系统」那一栏里（默认收着），展开就该点得到。
    await page.evaluate(`document.getElementById('side-more').open = true`);
    assert.ok(await page.waitFor(`document.getElementById('air-apk-btn')?.checkVisibility() === true`), '安装包那颗按钮展开「更多与系统」就在，一直点得到');
    await page.screenshot('00-apk-entry');

    // ── ① 从设置中心进：原生面板，不嵌旧 manage 页 ────────────────────────
    await page.navigate('/air?dir=d1&view=settings');
    const settingsLabel = await t('airSettingsCenter');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent === ${JSON.stringify(settingsLabel)}`), '先落在设置中心');
    // 等外壳那颗「关盖运行」读完状态：页面自己那一轮请求落地了，下面的基准才干净。
    assert.ok(await page.waitFor(`(() => { const row = document.getElementById('air-lid-sleep'); return !!row && !row.hidden; })()`), '侧栏那颗已读到状态');
    const base = calls().length;

    const globalLabel = await t('airAdminPanelGlobal');
    await page.evaluate(`[...document.querySelectorAll('.air-setting-card')].find(card => card.querySelector('strong')?.textContent === ${JSON.stringify(globalLabel)}).click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent === ${JSON.stringify(globalLabel)}`), '点进去落在全局配置页');
    assert.equal(await page.evaluate(`document.getElementById('task-breadcrumb').textContent`), await t('airCrumbSettings'), '面包屑说的是设置中心这一类');
    // 两条状态都回来了再数请求：面板打开时打的就是这两条，各一次。
    assert.ok(await page.waitFor(`(() => {
      const state = document.getElementById('air-global-oauth-state');
      const card = document.getElementById('air-global-power-card');
      const toggle = document.getElementById('air-global-power-toggle');
      return !!state && state.textContent.length > 0 && !!card && !card.hidden && !!toggle && !toggle.disabled;
    })()`), '两条状态都读回来了');
    assert.deepEqual(calls().slice(base).sort(),
      ['GET /api/settings/official-oauth', 'GET /api/settings/power'], '打开面板只读那两条状态：各一次');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0, '原生面板里没有旧 manage 的 iframe');
    assert.equal(page.requests.some(r => r.path === '/manage.html'), false, 'iframe 的 src 会真的发出去 —— 没这条请求才算真没嵌');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].map(b => b.textContent.replace(/\\s+/g,''))`),
      ['←' + await t('airAdminBackToSettings'), '↻' + await t('airAdminRefresh')], '工具条是面板自己的（返回设置中心 / 刷新）');

    // ── ② 安装包不在这页重复：只留一句指路，没有第二个下载入口 ────────────
    assert.equal(await text('#admin-content .air-global-hint'), await t('airGlobalInstallHint'), '顶上是安装包的指路');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content a[href*="multicc.apk"], #admin-content a[href*="ios-ota"]').length`), 0,
      '这页不许再画一张下载卡 —— 同一件事两个入口正是这次迁移要消掉的');
    // 风险告知是整段搬过来的，不是一句带过：它必须是一个能换行的段落（\n 分行靠
    // pre-line 显示），长度和关键词这两条等 i18n 合并进来之后才量得到 —— key 还没进
    // 字典时 t() 会把 key 原样退回，那时页面文本和 t() 是同一个字符串，比长度没意义。
    const risk = await text('#admin-content .air-global-risk');
    assert.equal(risk, await t('airGlobalOauthRisk'), '风险告知照旧页整段搬过来');
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#admin-content .air-global-risk')).whiteSpace`), 'pre-line',
      '这段是有分行的长文，不是一行小字');
    if (risk !== 'airGlobalOauthRisk') {
      assert.ok(risk.length > 120, `这段不是一句带过的提示（${risk.length} 字）`);
      for (const word of ['OAuth', 'Anthropic']) {
        assert.ok(risk.includes(word), `风险告知里得说清「重放订阅 ${word} token」这件事`);
      }
    }
    await page.screenshot('01-global-native-desktop');

    // ── ③ OAuth：勾选态跟服务端走，开启前必须先问一句 ─────────────────────
    assert.equal(await page.evaluate(`document.getElementById('air-global-oauth-enabled').checked`), true, '服务端说开着，勾选态就是开着');
    assert.equal(await text('#air-global-oauth-state'), await t('airGlobalOauthOn'), '卡片右上说已开启');
    // 换成「未开启」再刷新一次：勾选和状态都得跟着服务端翻过来（顺手验工具条那一下）。
    oauth = { enabled: false };
    await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].find(b => b.textContent.includes('↻')).click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-global-oauth-enabled').checked === false`), '刷新后勾选跟着服务端');
    assert.equal(await text('#air-global-oauth-state'), await t('airGlobalOauthOff'), '卡片右上说已关闭');

    // 开启前那一次问句：答「否」时一个写入请求都不许发，勾选退回原位。
    await page.evaluate(`window.__realConfirm = window.confirm; window.__asked = []; window.confirm = text => { window.__asked.push(text); return false; }`);
    await page.evaluate(`document.getElementById('air-global-oauth-enabled').click()`);
    // 「不该发的请求」没有回包可等，所以给它一点时间现形，免得比请求先到就判它没发。
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(oauthPosts.length, 0, '答「否」时不发写入请求');
    assert.equal(page.requests.some(r => r.method === 'POST' && r.path === '/api/settings/official-oauth'), false, '连一条 POST 都不该出现');
    assert.equal(await page.evaluate(`document.getElementById('air-global-oauth-enabled').checked`), false, '勾选退回原位（还是未勾）');
    assert.deepEqual(await page.evaluate(`window.__asked`), [await t('airGlobalOauthConfirm')],
      '问的就是旧页那一句：重放订阅 token、可能违反服务条款、有账号风险');

    // 答「是」：才发，body 逐字段断言，成功提示带「下一轮 spawn 生效」。
    await page.evaluate(`window.confirm = text => { window.__asked.push(text); return true; }`);
    await page.evaluate(`document.getElementById('air-global-oauth-enabled').click()`);
    const onNote = (await t('airGlobalOauthOn')) + (await t('airGlobalOauthSpawnNote'));
    assert.ok(await page.waitFor(`document.getElementById('air-global-oauth-msg').textContent === ${JSON.stringify(onNote)}`),
      '开启后的提示是「已开启（下一轮 spawn 生效）」这一句');
    await settle(oauthPosts, 1);
    assert.deepEqual(oauthPosts, [{ enabled: true }], '写入 body 就这一项');
    assert.equal(await page.evaluate(`document.getElementById('air-global-oauth-enabled').checked`), true);
    assert.equal(await text('#air-global-oauth-state'), await t('airGlobalOauthOn'));

    // 关掉是安全的那一侧：不再问，直接发 { enabled: false }。
    await page.evaluate(`document.getElementById('air-global-oauth-enabled').click()`);
    const offNote = (await t('airGlobalOauthOff')) + (await t('airGlobalOauthSpawnNote'));
    assert.ok(await page.waitFor(`document.getElementById('air-global-oauth-msg').textContent === ${JSON.stringify(offNote)}`),
      '关闭后的提示是「已关闭（下一轮 spawn 生效）」这一句');
    await settle(oauthPosts, 2);
    assert.deepEqual(oauthPosts, [{ enabled: true }, { enabled: false }], '关掉也要落库');
    assert.equal(await page.evaluate(`window.__asked.length`), 2, '只有开启那一次问了（关掉不问）');

    // 写入失败：勾选退回原值并说明原因（停在用户点过的那一态就是替服务端点头）。
    oauthError = '写入被拒绝（演示）';
    await page.evaluate(`window.confirm = () => true`); // 这条路要真的走到 POST，问句先放行
    await page.evaluate(`document.getElementById('air-global-oauth-enabled').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-global-oauth-msg').className.includes('err')`), '失败要现形');
    await settle(oauthPosts, 3);
    assert.deepEqual(oauthPosts.at(-1), { enabled: true }, '失败前那一次也真的发出去了');
    assert.equal(await page.evaluate(`document.getElementById('air-global-oauth-enabled').checked`), false, '失败后勾选退回原值（未勾）');
    assert.equal(await text('#air-global-oauth-msg'), await tParams('airGlobalOauthFailed', { message: oauthError }), '失败原因写给用户看');
    assert.equal(await page.evaluate(`document.getElementById('air-global-oauth-enabled').disabled`), false, '失败也要能再试一次');
    oauthError = '';
    await page.evaluate(`window.confirm = window.__realConfirm`);

    // ── ④ 关盖运行：可见性、错误、以及勾选态到底谁说了算 ───────────────────
    assert.equal(await page.evaluate(`document.getElementById('air-global-power-card').checkVisibility()`), true, 'available:true 时整卡可见');
    assert.equal(await page.evaluate(`document.getElementById('air-global-power-toggle').checked`), true);
    assert.equal(await text('#air-global-power-status'), await t('airGlobalPowerOn'));

    // 非 macOS：整卡消失，不是灰掉。
    power = { available: false, enabled: false };
    await page.evaluate(`document.getElementById('air-global-power-refresh').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-global-power-card').hidden === true`), '不支持的平台整卡收起来');
    assert.equal(await page.evaluate(`document.getElementById('air-global-power-card').checkVisibility()`), false, '不是灰掉，是真的不占视线');

    // 平台支持、但状态读不出来：卡留着，把原因按错误显示。
    const readError = 'pmset 读取失败（演示）';
    power = { available: true, enabled: false, error: readError };
    await page.evaluate(`document.getElementById('air-global-power-refresh').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-global-power-card').hidden === false`), '读得出可用性就还得把卡放回来');
    assert.equal(await text('#air-global-power-status'), await tParams('airGlobalPowerReadFailed', { message: readError }), '错误按错误显示');
    assert.equal(await page.evaluate(`document.getElementById('air-global-power-status').className.includes('err')`), true, '状态行是错误态');

    // 切到「关」：等授权的那段时间开关要按住、状态行要说清在等什么。
    power = { available: true, enabled: true };
    powerDelay = 400;
    await page.evaluate(`document.getElementById('air-global-power-refresh').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-global-power-toggle').checked === true`), '回到已开启');
    await page.evaluate(`document.getElementById('air-global-power-toggle').click()`);
    assert.equal(await page.evaluate(`document.getElementById('air-global-power-toggle').disabled`), true, '等授权时开关先按住，免得再点一次');
    assert.equal(await text('#air-global-power-status'), await t('airGlobalPowerWaiting'), '状态行说清在等管理员授权');
    assert.ok(await page.waitFor(`document.getElementById('air-global-power-status').textContent === ${JSON.stringify(await t('airGlobalPowerOff'))}`), '服务端回了才算数');
    await settle(powerPosts, 1);
    assert.deepEqual(powerPosts, [{ enabled: false }], 'POST 的 body 就是这一次点出来的值');
    assert.equal(await page.evaluate(`document.getElementById('air-global-power-toggle').checked`), false);
    assert.equal(await page.evaluate(`document.getElementById('air-global-power-toggle').disabled`), false, '结束后开关恢复可用');
    powerDelay = 0;

    // 勾选态由服务端的 enabled 说了算：用户点「关」、服务端答「还开着」时，勾必须弹回去。
    power = { available: true, enabled: true };
    await page.evaluate(`document.getElementById('air-global-power-refresh').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-global-power-toggle').checked === true`), '先回到已开启');
    powerNegate = true;
    powerDelay = 200; // 让「请求在路上」这一小段真的存在，中间态才断得到
    await page.evaluate(`document.getElementById('air-global-power-toggle').click()`);
    assert.equal(await page.evaluate(`document.getElementById('air-global-power-toggle').disabled`), true, '请求在路上的标志');
    await settle(powerPosts, 2);
    assert.ok(await page.waitFor(`document.getElementById('air-global-power-toggle').disabled === false`), '这一轮结束');
    assert.equal(await page.evaluate(`document.getElementById('air-global-power-toggle').checked`), true,
      '服务端说还开着，勾就得回到开着 —— 不是用户点成什么就是什么');
    assert.deepEqual(powerPosts.at(-1), { enabled: false });
    assert.equal(await text('#air-global-power-status'), await t('airGlobalPowerOn'));
    powerNegate = false;
    powerDelay = 0;

    // 写入失败：勾选必须回滚（停在用户点过的那一态就是替服务端点头）。
    powerError = 'Administrator authorization was canceled';
    await page.evaluate(`document.getElementById('air-global-power-toggle').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-global-power-status').className.includes('err')`), '失败要现形');
    await settle(powerPosts, 3);
    assert.deepEqual(powerPosts.at(-1), { enabled: false });
    assert.equal(await page.evaluate(`document.getElementById('air-global-power-toggle').checked`), true, '失败后勾选退回原值');
    assert.equal(await text('#air-global-power-status'), await tParams('airGlobalPowerFailed', { message: powerError }), '失败原因写在状态行上');
    assert.equal(await page.evaluate(`document.getElementById('air-global-power-toggle').disabled`), false, '失败也要把开关放开，不能把人锁在页面上');
    assert.equal(await page.evaluate(`document.getElementById('air-global-power-card').hidden`), false, '这张卡还在（支持这个平台）');
    powerError = '';
    await page.screenshot('02-global-power');
  });
});
