'use strict';
// 「全局配置」这一格这次从「嵌旧 manage 页的 iframe」改成了 Air 原生页（air-global.js）。
// 它装的是会真的改主机行为的开关，不是外观偏好，所以每一条都要在真浏览器里断到：
//   ① 渲染是原生的 —— #admin-content 里没有 .air-legacy-frame，也没有任何 /manage.html
//      请求（iframe 的 src 会真的发出去，所以这条能证明它没被悄悄嵌回来）；
//   ② 打开面板只读电源那一条状态 —— GET /api/settings/power 一次（外壳自己 boot 时也
//      读过 power，所以比的是「点进去之后新增的」那一截）；
//   ③ 关盖运行：available:false 时整卡不出现（不是灰掉）、error 有值要在页面上现形、
//      勾选态以服务端回的 enabled 为准、写入失败时勾选必须回滚；
//   ④ 安装包（APK / iOS OTA）不在这页重复第二张卡 —— 侧栏「主机操作」那颗才是唯一入口。
//   ⑤ Shared first-time setup; switches retain credentials and restore independent consent.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('the Air global panel is native: install hint and the macOS lid-sleep switch', async t => {
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

  // 关盖运行的状态放在 fixture 里，路由读写它 —— 界面跟不跟着服务端走，才有东西可断。
  let power = { available: true, enabled: true };
  // 关盖运行那一步会在 Mac 上弹系统授权框：这几个旋钮让「正在等授权 / 服务端说了别的 /
  // 授权被取消」三条路都能在测试里确定性地走一遍。
  let powerDelay = 0, powerNegate = false, powerError = '';
  const powerPosts = [];
  let agentPermissions = { ok: true, applicable: true, local: true, accessibility: true, screenRecording: true };
  const permissionOpens = [];
  routes['GET /api/system/agent-permissions'] = () => json(agentPermissions);
  routes['POST /api/system/agent-permissions/open'] = req => {
    permissionOpens.push(JSON.parse(req.body).permission);
    return json({ ok: true, status: 'opened' });
  };
  let unlockPassword = { available: true, set: false, canEdit: true, requested: false };
  const powerReply = () => ({ ...power, unlockPassword: { ...unlockPassword,
    enabled: unlockPassword.set && (unlockPassword.requested || power.enabled), requiredByLid: power.enabled } });
  let unlockAuthorization = { state: 'authorized' };
  let unlockSaveError = '', unlockDeleteError = '', unlockSaveDelay = 0;
  const unlockPosts = []; // { method, body }：POST 存、DELETE 删、POST authorize 重问一次
  routes['GET /api/settings/power'] = () => json(powerReply());
  routes['POST /api/settings/power'] = async req => {
    const body = JSON.parse(req.body);
    powerPosts.push(body);
    if (powerDelay) await new Promise(resolve => setTimeout(resolve, powerDelay));
    if (powerError) {
      return { status: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: powerError }) };
    }
    const enabled = powerNegate ? !body.enabled : !!body.enabled;
    power = { available: true, enabled };
    return json({ ok: true, ...powerReply() });
  };
  const unlockToggles = [];
  routes['POST /api/settings/power/auto-unlock'] = req => {
    const body = JSON.parse(req.body);
    unlockToggles.push(body);
    unlockPassword.requested = body.enabled;
    return json({ ok: true, ...powerReply() });
  };
  routes['POST /api/settings/power/unlock-password'] = async req => {
    const body = JSON.parse(req.body);
    unlockPosts.push({ method: 'POST', body });
    if (unlockSaveDelay) await new Promise(resolve => setTimeout(resolve, unlockSaveDelay));
    if (unlockSaveError) {
      return { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: unlockSaveError }) };
    }
    unlockPassword = { ...unlockPassword, set: true };
    // 真服务端存完会当场问一次 Agent「你到底读不读得到」，回执就是这个 authorization。
    return json({ ok: true, set: true, authorization: unlockAuthorization });
  };
  routes['DELETE /api/settings/power/unlock-password'] = () => {
    unlockPosts.push({ method: 'DELETE' });
    if (unlockDeleteError) {
      return { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: unlockDeleteError }) };
    }
    unlockPassword = { available: true, set: false };
    return json({ ok: true, set: false });
  };
  routes['POST /api/settings/power/unlock-password/authorize'] = () => {
    unlockPosts.push({ method: 'POST', path: 'authorize' });
    return json({ ok: true, authorization: unlockAuthorization });
  };

  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' }], clis: ['codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    // 外壳自己也读这一条（侧栏「关盖运行」那颗），所以只盯这个接口、并且拿
    // 「点进面板之前」当基准，才分得清哪一次是面板打的。
    const calls = () => page.requests
      .filter(r => r.path === '/api/settings/power')
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
    assert.ok(await page.waitFor(`document.getElementById('console-center').hidden===false`), '控制台那一页打开');
    // 它住在侧栏「更多与系统」那一栏里（默认收着），展开就该点得到。
    await page.evaluate(`document.getElementById('side-more').click()`);
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
    // 状态回来了再数请求：面板打开时打的就是电源这一条，一次。
    assert.ok(await page.waitFor(`(() => {
      const state = document.getElementById('air-global-power-status');
      const card = document.getElementById('air-global-power-card');
      const toggle = document.getElementById('air-global-power-toggle');
      return !!state && state.textContent.length > 0 && !!card && !card.hidden && !!toggle && !toggle.disabled;
    })()`), '电源状态读回来了');
    assert.deepEqual(calls().slice(base).sort(),
      ['GET /api/settings/power'], '打开面板只读电源那一条状态：一次');
    assert.equal(await page.evaluate(`document.getElementById('air-global-oauth-enabled')`), null,
      'OAuth 重放那一块已经整块退场，页面上不该再有那颗勾');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0, '原生面板里没有旧 manage 的 iframe');
    assert.equal(page.requests.some(r => r.path === '/manage.html'), false, 'iframe 的 src 会真的发出去 —— 没这条请求才算真没嵌');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].map(b => b.textContent.replace(/\\s+/g,''))`),
      ['←' + await t('airAdminBackToSettings'), '↻' + await t('airAdminRefresh')], '工具条是面板自己的（返回设置中心 / 刷新）');

    // ── ② 安装包不在这页重复：只留一句指路，没有第二个下载入口 ────────────
    assert.equal(await text('#admin-content .air-global-hint'), await t('airGlobalInstallHint'), '顶上是安装包的指路');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content a[href*="multicc.apk"], #admin-content a[href*="ios-ota"]').length`), 0,
      '这页不许再画一张下载卡 —— 同一件事两个入口正是这次迁移要消掉的');
    await page.screenshot('01-global-native-desktop');

    // ── ③ 关盖运行：可见性、错误、以及勾选态到底谁说了算 ───────────────────
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


    const click = id => page.evaluate(`document.getElementById('air-global-${id}').click()`);
    const checked = id => page.evaluate(`document.getElementById('air-global-${id}').checked`);
    const ready = async () => assert.ok(await page.waitFor(`!document.getElementById('air-global-power-toggle').disabled`));
    // First-time lid setup: neither switch claims success before saving.
    power = { available: true, enabled: false };
    unlockPassword = { available: true, set: false, canEdit: true, requested: false };
    await page.evaluate(`MultiCCAirGlobal.refresh()`);
    await click('power-toggle');
    assert.equal(await checked('power-toggle'), false);
    assert.equal(await page.evaluate(`document.getElementById('air-global-unlock-block').hidden`), false);
    assert.equal(powerPosts.length, 3, 'no power mutation before password setup');
    await click('unlock-cancel');
    assert.equal(await checked('power-toggle'), false);
    assert.equal(await page.evaluate(`document.getElementById('air-global-unlock-block').hidden`), true);
    await click('power-toggle');
    await page.evaluate(`document.getElementById('air-global-unlock-password').value = 'fixture-only'`);
    unlockSaveDelay = 150;
    await click('unlock-save');
    assert.equal(await page.evaluate(`document.getElementById('air-global-unlock-password').value`), '', 'clear immediately, including on failure');
    assert.equal(await page.evaluate(`document.getElementById('air-global-unlock-cancel').disabled`), true);
    assert.ok(await page.waitFor(`document.getElementById('air-global-power-toggle').checked && !document.getElementById('air-global-power-toggle').disabled`));
    assert.equal(await checked('unlock-toggle'), true);
    assert.equal(await page.evaluate(`document.getElementById('air-global-unlock-toggle').disabled`), true, 'included unlock cannot be disabled independently');
    assert.equal(unlockPosts.filter(p => p.method === 'POST').length, 1);
    unlockSaveDelay = 0;
    await click('power-toggle');
    await ready();
    assert.equal(await checked('unlock-toggle'), false, 'restores earlier independent choice');

    // Re-enable both switches without entering or deleting a password.
    await click('unlock-toggle');
    await ready();
    assert.equal(await checked('unlock-toggle'), true);
    await click('unlock-toggle');
    await ready();
    assert.equal(await checked('unlock-toggle'), false);
    assert.equal(unlockPosts.filter(p => p.method === 'DELETE').length, 0);
    assert.equal(unlockPassword.set, true);
    assert.equal(await page.evaluate(`document.getElementById('air-global-unlock-block').hidden`), true);
    await click('power-toggle'); await ready();
    await click('power-toggle'); await ready();
    assert.equal(unlockPosts.filter(p => p.method === 'POST').length, 1, 'reuse saved credentials');

    // Failed setup: status and retry remain visible, no feature enabled.
    unlockPassword.set = false;
    await page.evaluate(`MultiCCAirGlobal.refresh()`);
    await click('unlock-toggle');
    unlockAuthorization = { state: 'waiting-for-user' };
    await page.evaluate(`document.getElementById('air-global-unlock-password').value = 'fixture-only'`);
    await click('unlock-save'); await ready();
    assert.equal(await checked('unlock-toggle'), false);
    assert.equal(await page.evaluate(`document.getElementById('air-global-unlock-status').checkVisibility()`), true);
    assert.equal(await page.evaluate(`document.getElementById('air-global-unlock-authorize').checkVisibility()`), true);
    unlockAuthorization = { state: 'authorized' };
    await click('unlock-authorize');
    assert.ok(await page.waitFor(`document.getElementById('air-global-unlock-toggle').checked && !document.getElementById('air-global-unlock-toggle').disabled`));
    assert.equal(await page.evaluate(`document.getElementById('air-global-unlock-password').value`), '');

    // Agent 自己坏了（装的时候丢了执行位 / 压根没装）：指引要指向「重启 MultiCC 自修」，
    // 并把那个怎么点都不会好的「检查授权」收起来 —— 现场就是在它上面一直打转。
    // 按钮的回包是异步的（element.click() 一返回就去断言会读到上一次的状态），所以按
    // 文案+按钮可见性一起等。
    const authorized = (key, buttonVisible) => page.waitFor(
      `document.getElementById('air-global-unlock-status').textContent === t(${JSON.stringify(key)})`
      + ` && document.getElementById('air-global-unlock-authorize').checkVisibility() === ${buttonVisible}`);
    unlockPassword = { available: true, set: true, canEdit: true, requested: false };
    await page.evaluate(`MultiCCAirGlobal.refresh()`);
    unlockAuthorization = { state: 'unavailable', detail: 'agent-not-executable' };
    await click('unlock-authorize');
    assert.ok(await authorized('airGlobalUnlockAgentBroken', false));
    assert.equal(await text('#air-global-unlock-status'), await t('airGlobalUnlockAgentBroken'));
    unlockAuthorization = { state: 'unavailable', detail: 'agent-not-installed' };
    await click('unlock-authorize');
    assert.ok(await authorized('airGlobalUnlockAgentMissing', false));
    // 没有 detail 的「没能确认」仍然保留原话与按钮（可能只是这次没等到）。
    unlockAuthorization = { state: 'unavailable' };
    await click('unlock-authorize');
    assert.ok(await authorized('airGlobalUnlockProbeUnknown', true));
    assert.equal(await text('#air-global-unlock-status'), await t('airGlobalUnlockProbeUnknown'));
    unlockAuthorization = { state: 'authorized' };

    // Remote first-time setup explains where to go, without an unusable form.
    unlockPassword = { available: true, set: false, canEdit: false, requested: false };
    await page.evaluate(`MultiCCAirGlobal.refresh()`);
    await click('unlock-toggle');
    assert.equal(await text('#air-global-unlock-status'), await t('airGlobalUnlockLocal'));
    assert.equal(await checked('unlock-toggle'), false);
    assert.equal(await page.evaluate(`document.getElementById('air-global-unlock-block').hidden`), true);

    // User report: system sleep disabled must not turn MultiCC's shortcut on.
    power = { available: true, enabled: false, systemSleepDisabled: true };
    unlockPassword = { available: true, set: true, canEdit: true, requested: false };
    await page.evaluate(`MultiCCAirGlobal.refresh()`);
    assert.equal(await page.evaluate(`document.getElementById('air-lid-sleep').classList.contains('on')`), false);
    assert.equal(await page.evaluate(`document.getElementById('air-auto-unlock').hidden`), false);
    assert.equal(await text('#air-global-power-status'), await t('airGlobalPowerExternal'));
    await page.evaluate(`document.getElementById('air-auto-unlock').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-auto-unlock').classList.contains('on') && !document.getElementById('air-auto-unlock').disabled`));
    assert.deepEqual(unlockToggles.at(-1), { enabled: true });
    // First-time shortcut opens the shared password form in one click.
    unlockPassword = { available: true, set: false, canEdit: true, requested: false };
    await page.evaluate(`MultiCCAirGlobal.refresh()`);
    await page.evaluate(`document.getElementById('air-auto-unlock').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-global-unlock-block')?.hidden === false`));
    assert.equal(await checked('unlock-toggle'), false);
    await click('unlock-cancel');
    await page.screenshot('03-global-unlock');

    // Grant guidance belongs to desktop automation. A newly enabled lid mode
    // opens the first missing macOS pane and leaves an explanation in a dialog.
    power = { available: true, enabled: false };
    unlockPassword = { available: true, set: true, canEdit: true, requested: false };
    agentPermissions = { ...agentPermissions, accessibility: false, screenRecording: false };
    await page.evaluate(`MultiCCAirGlobal.refresh()`);
    await click('power-toggle');
    assert.ok(await page.waitFor(`document.getElementById('air-global-permission-dialog').open`));
    assert.deepEqual(permissionOpens, ['accessibility']);
    assert.equal(await text('#air-global-permission-body'), await tParams('airGlobalPermissionsGuide', {
      name: await t('airGlobalPermissionsAccessibility'),
    }));
    agentPermissions = { ...agentPermissions, accessibility: true };
    await click('permission-check');
    assert.ok(await page.waitFor(`document.getElementById('air-global-permission-body').textContent === t('airGlobalPermissionsMissing', {name:t('airGlobalPermissionsRecording')})`));
    await click('permission-open');
    assert.ok(await page.waitFor(`document.getElementById('air-global-permission-open').disabled === false`));
    assert.deepEqual(permissionOpens, ['accessibility', 'screenRecording']);
    agentPermissions = { ...agentPermissions, screenRecording: true };
    await click('permission-check');
    assert.ok(await page.waitFor(`!document.getElementById('air-global-permission-dialog').open`));

    // The settings-center shortcut has its own POST path. It must reach the
    // same permission guide after enabling, without requiring password setup.
    await click('power-toggle'); await ready();
    agentPermissions = { ...agentPermissions, accessibility: false };
    await page.navigate('/air?dir=d1&view=settings');
    assert.ok(await page.waitFor(`document.getElementById('air-lid-sleep') && !document.getElementById('air-lid-sleep').classList.contains('on')`));
    await page.evaluate(`document.getElementById('air-lid-sleep').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-global-permission-dialog')?.open === true`));
    assert.deepEqual(permissionOpens, ['accessibility', 'screenRecording', 'accessibility']);
  });
});
