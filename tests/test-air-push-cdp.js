'use strict';
// 推送通知这一格这次从「嵌旧 manage 页的 iframe」改成了 Air 原生页（air-push.js）。
// 它同时读三个地方的状态（本机浏览器的订阅、服务端的投递健康度、备用通道配置），
// 所以每一条都要在真浏览器里断到：
//   ① 渲染是原生的 —— #admin-content 里没有 .air-legacy-frame，也没有任何 /manage.html
//      请求（iframe 的 src 会真的发出去，所以这条能证明它没被悄悄嵌回来）；
//   ② 打开面板只读一次 —— 就 GET /api/push/health 与 GET /api/settings/notify 各一条；
//   ③ 健康度逐项对上 —— 有/无 last error、Never、无数据三种口径都要画对，成功率那三档
//      颜色（≥90 绿 / ≥70 黄 / 其余红 / 无数据灰）也要真的落到元素上；
//   ④ Bark 的掩码只进 placeholder 不进 value —— 这是这一格最容易写错的一条：写进
//      value 它就会被当成「用户填的值」在下次保存时提交回去；
//   ⑤ 保存打的是真接口 —— POST body 逐字段断言，且 Bark/Webhook 的空值语义不同
//      （Bark 空着不带这个字段，Webhook 空串是「清空」）；
//   ⑥ Test Bark / Test Webhook 的成功与失败两条路径都要看得见（服务端「配了却投递
//      失败」是 200 + {error}，只看状态码会把它报成成功）；
//   ⑦ Test Push 显示订阅者数，并顺手重读一次健康度。
// 文案一律用 t('airPushXxx') 从页面里取回来比，不写死中文字面量 —— 这样 i18n 合并
// 前后（key 只在 /tmp 清单里、还没进 i18n-catalog 时 t() 会回退成 key 本身）都稳。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('the Air push panel is native: masked Bark placeholder, exact POST bodies, visible failures', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-air-push-qa');
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
  // 时间是「多久以前」的相对量，所以夹具存的是相对现在多久，而不是一个死的时间戳。
  const HEALTH_CASES = {
    healthy: {
      global: { lastPushTime: () => Date.now() - 150_000, lastPushType: 'waiting', totalSuccess: 9, totalFail: 1, totalSent: 12 },
      subscriptionCount: 2,
      subscriptions: [{ lastFailTime: () => Date.now() - 3 * 3_600_000, lastFailReason: 'timeout' }],
    },
    stale: { global: { lastPushTime: 0, lastPushType: '', totalSuccess: 7, totalFail: 3, totalSent: 10 }, subscriptionCount: 1, subscriptions: [] },
    noData: { global: { lastPushTime: 0, lastPushType: '', totalSuccess: 0, totalFail: 0, totalSent: 0 }, subscriptionCount: 0, subscriptions: [] },
    bad: {
      global: { lastPushTime: () => Date.now() - 150_000, lastPushType: 'other', totalSuccess: 1, totalFail: 9, totalSent: 10 },
      subscriptionCount: 1,
      subscriptions: [{ lastFailTime: () => Date.now() - 3 * 3_600_000, lastFailReason: 'timeout' }],
    },
  };
  let healthCase = 'healthy';
  let healthGets = 0;
  // 掩码的形状跟真服务端（host-read.js 的 summarizeSecretUrl）一致：只留 origin。
  let notify = { hasBark: true, barkUrl: 'https://api.day.app/••••', webhookUrl: 'https://hooks.example.test/••••', hasWebhook: true };
  let notifyGets = 0, testPushResult = { ok: true, subscribers: 3 }, barkResult = { ok: true }, webhookResult = { ok: true };
  const resolveHealth = () => {
    const source = HEALTH_CASES[healthCase];
    return {
      global: {
        ...source.global,
        lastPushTime: typeof source.global.lastPushTime === 'function' ? source.global.lastPushTime() : source.global.lastPushTime,
      },
      subscriptionCount: source.subscriptionCount,
      subscriptions: source.subscriptions.map(entry => ({
        ...entry,
        lastFailTime: typeof entry.lastFailTime === 'function' ? entry.lastFailTime() : entry.lastFailTime,
      })),
    };
  };
  routes['GET /api/push/health'] = () => { healthGets++; return json(resolveHealth()); };
  routes['GET /api/settings/notify'] = () => { notifyGets++; return json(notify); };
  routes['POST /api/settings/notify'] = req => {
    const body = JSON.parse(req.body);
    if (body.barkUrl) notify = { ...notify, hasBark: true, barkUrl: 'https://api.day.app/••••' };
    if (body.webhookUrl !== undefined) {
      notify = { ...notify, hasWebhook: !!body.webhookUrl, webhookUrl: body.webhookUrl ? 'https://hooks.example.test/••••' : '' };
    }
    return json(notify);
  };
  routes['POST /api/push/test'] = () => json(testPushResult);
  // Bark 投递失败是 200 + {error}（src/push/runtime.js 里只有「没配」才 4xx），
  // Webhook 这边走 4xx + {error} —— 两条失败形状 api() 都要接住。
  routes['POST /api/push/test-bark'] = () => json(barkResult);
  routes['POST /api/push/test-webhook'] = () => (webhookResult.error ? json({ error: webhookResult.error }, 400) : json(webhookResult));
  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' }], clis: ['codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    const tr = key => page.evaluate(`t(${JSON.stringify(key)})`);
    const trf = (key, params) => tr(key).then(tpl => tpl.replace(/\{(\w+)\}/g, (_, name) => String(params[name])));
    const text = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
    const value = id => page.evaluate(`document.getElementById(${JSON.stringify(id)})?.value ?? null`);
    const className = id => page.evaluate(`document.getElementById(${JSON.stringify(id)})?.className ?? null`);
    // 颜色口径断的就是这几个类名（is-ok / is-warn / is-bad / is-idle），别写内联样式。
    const states = id => page.evaluate(`[...document.getElementById(${JSON.stringify(id)}).classList].filter(c => c.startsWith('is-'))`);
    const colorOf = id => page.evaluate(`getComputedStyle(document.getElementById(${JSON.stringify(id)})).color`);
    // 请求计数活在 Node 这一侧（路由处理器里），等它就只能在 Node 里轮询。
    const until = async predicate => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return false;
    };
    const calls = () => page.requests.filter(r => r.path.startsWith('/api/push/') || r.path === '/api/settings/notify')
      .map(r => `${r.method} ${r.path}`);
    const posts = () => page.requests.filter(r => r.method === 'POST' && r.path === '/api/settings/notify').map(r => JSON.parse(r.body));
    // 「多久以前」不是一个固定字符串，测试按同一个 Intl 口径复算一遍（两边都不是写死的
    // 中文/英文）；夹具取的都是桶中间的值（2 分钟、3 小时），不会卡在分钟边界上翻档。
    const relative = ms => page.evaluate(`(() => {
      const seconds = Math.max(0, Math.floor((Date.now() - ${ms}) / 1000));
      const fmt = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' });
      if (seconds < 60) return fmt.format(-seconds, 'second');
      if (seconds < 3600) return fmt.format(-Math.floor(seconds / 60), 'minute');
      return fmt.format(-Math.floor(seconds / 3600), 'hour');
    })()`);
    const refresh = async () => {
      await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].find(b => b.textContent.includes(${JSON.stringify(await tr('airAdminRefresh'))})).click()`);
    };

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ── ① 从设置中心的卡片进去：原生面板，不嵌旧 manage 页 ────────────────
    await page.navigate('/air?dir=d1&view=settings');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent === ${JSON.stringify(await tr('airSettingsCenter'))}`), '先落在设置中心');
    assert.equal(await page.evaluate(`[...document.querySelectorAll('.air-setting-card strong')].some(n => n.textContent === ${JSON.stringify(await tr('airAdminPanelPush'))})`), true,
      '推送通知是设置中心里的一张卡');
    await page.evaluate(`[...document.querySelectorAll('.air-setting-card')].find(card => card.querySelector('strong').textContent === ${JSON.stringify(await tr('airAdminPanelPush'))}).click()`);
    assert.ok(await page.waitFor(`document.querySelector('#admin-content .air-push-page') !== null`), '点进去落在推送面板上');
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent`), await tr('airAdminPush'),
      '页头标题走的是 air.js adminHeadings 里那个 key，不是 mode 名');
    assert.equal(await page.evaluate(`document.getElementById('task-breadcrumb').textContent`), await tr('airCrumbSettings'),
      '面包屑说的是设置中心这一类');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0, '原生面板里没有旧 manage 的 iframe');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content iframe').length`), 0, '面板正文里一个 iframe 都不该有');
    assert.equal(page.requests.some(r => r.path === '/manage.html'), false, 'iframe 的 src 会真的发出去 —— 没这条请求才算真没嵌');
    // 样式是这个模块自己带的（air.css 不认识 air-push-* 这些类），且真的生效了。
    assert.equal(await page.evaluate(`document.querySelector('#admin-content style')?.textContent.includes('.air-push-page')`), true,
      '面板把自己的样式节点插在根节点下');
    assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('air-push-last-push')).fontWeight`), '600',
      '模块自己的读数样式落到了元素上');
    await page.screenshot('00-push-native-desktop');

    // ── ② 打开面板只读一次：健康度与备用通道各一条 ─────────────────────────
    assert.ok(await page.waitFor(`document.getElementById('air-push-total').textContent === '12'`), '服务端那份健康度画进来了');
    assert.deepEqual(calls(), ['GET /api/push/health', 'GET /api/settings/notify'], '打开面板只打这两条读取请求');
    assert.deepEqual([healthGets, notifyGets], [1, 1]);

    // ── ③ 健康度逐项对上（有 last error 的那一种）────────────────────────
    assert.equal(await text('#air-push-last-push'), `${await relative(Date.now() - 150_000)} (waiting)`, '最近推送 = 相对时间 + 类型');
    assert.equal(await text('#air-push-rate'), '90% (9/10)', '成功率 = 成功/(成功+失败) + 分数');
    assert.deepEqual(await states('air-push-rate'), ['is-ok'], '≥90% 绿');
    assert.equal(await text('#air-push-total'), '12', '累计发送');
    assert.equal(await text('#air-push-subcount'), '2', '订阅数');
    assert.equal(await text('#air-push-last-error'), `timeout (${await relative(Date.now() - 3 * 3_600_000)})`, '最近错误 = 原因 + 时间');
    assert.deepEqual(await states('air-push-last-error'), ['is-bad'], '有错误就是红的');
    // 客户端信息块（订阅状态）也渲染出来了：这一块的取值依赖 pwa.js 的内部状态 +
    // 浏览器 Notification，下面第 ⑦ 段用受控的 getPushInfo 替身单独断行为。
    for (const key of ['airPushPermission', 'airPushSubscription', 'airPushEndpoint', 'airPushPlatform']) {
      assert.equal(await page.evaluate(`[...document.querySelectorAll('#admin-content .air-push-row > span')].some(n => n.textContent === ${JSON.stringify(await tr(key))})`), true,
        `客户端信息块里有「${key}」这一行`);
    }

    // ── ③b 另外三种口径：无 last error / Never / 无数据 ────────────────────
    healthCase = 'stale';
    await refresh();
    assert.ok(await page.waitFor(`document.getElementById('air-push-total').textContent === '10'`), '刷新读回第二份健康度');
    assert.equal(await text('#air-push-last-push'), await tr('airPushNever'), '没推过就说 Never，不画一个 1970 年');
    assert.equal(await text('#air-push-last-error'), await tr('airPushNone'), '没有失败记录就是「无」');
    assert.deepEqual(await states('air-push-last-error'), ['is-ok'], '没有错误是绿的');
    assert.equal(await text('#air-push-rate'), '70% (7/10)');
    assert.deepEqual(await states('air-push-rate'), ['is-warn'], '≥70% 黄');
    const warnColor = await colorOf('air-push-rate');

    healthCase = 'bad';
    await refresh();
    assert.ok(await page.waitFor(`document.getElementById('air-push-rate').textContent === '10% (1/10)'`), '刷新读回第三份健康度');
    assert.deepEqual(await states('air-push-rate'), ['is-bad'], '跌到 70% 以下就是红的');
    assert.equal(await text('#air-push-last-push'), `${await relative(Date.now() - 150_000)} (other)`, '类型照服务端给的那个词画');
    const badColor = await colorOf('air-push-rate');

    healthCase = 'noData';
    await refresh();
    assert.ok(await page.waitFor(`document.getElementById('air-push-rate').textContent === ${JSON.stringify(await tr('airPushNoData'))}`), '一次都没发过时显示「无数据」');
    assert.deepEqual(await states('air-push-rate'), ['is-idle'], '无数据是灰的');
    assert.equal(await text('#air-push-total'), '0', '累计发送归零（不是占位符 —— 服务端真的给了 0）');
    assert.equal(await text('#air-push-subcount'), '0');
    const idleColor = await colorOf('air-push-rate');
    assert.equal(new Set([warnColor, badColor, idleColor]).size, 3, '黄 / 红 / 灰 三档颜色互不相同');
    healthCase = 'healthy';
    await refresh();
    assert.ok(await page.waitFor(`document.getElementById('air-push-rate').textContent === '90% (9/10)'`));
    assert.equal(new Set([warnColor, badColor, idleColor, await colorOf('air-push-rate')]).size, 4, '绿也跟另外三档不同 —— CSS 真的生效了');
    await page.screenshot('01-push-health');

    // ── ④ Bark 的掩码只进 placeholder，不进 value ─────────────────────────
    assert.equal(await value('air-push-bark'), '', 'Bark 输入框的 value 是空的：掩码没被当成用户填的值');
    assert.equal(await page.evaluate(`document.getElementById('air-push-bark').placeholder`), notify.barkUrl, '掩码只出现在 placeholder 里');
    assert.equal(await value('air-push-webhook'), notify.webhookUrl, 'Webhook 按旧页口径写进 value（保存时服务端认得这个掩码，是空操作）');

    // ── ⑤ 保存：POST body 逐字段断言 ──────────────────────────────────────
    await page.evaluate(`(() => {
      document.getElementById('air-push-bark').value = 'https://api.day.app/FIXTUREKEY';
      document.getElementById('air-push-webhook').value = 'https://hooks.example.test/real';
      document.getElementById('air-push-save').click();
    })()`);
    assert.ok(await page.waitFor(`document.getElementById('air-push-notify-status').textContent === ${JSON.stringify(await tr('airPushSaved'))}`), '面板内的状态行显示了已保存');
    assert.deepEqual(posts(), [{ barkUrl: 'https://api.day.app/FIXTUREKEY', webhookUrl: 'https://hooks.example.test/real' }],
      '两个都填了时 body 就是这两项');
    assert.equal(await text('#notice'), await tr('airPushNotifySaved'), '右下角也回执一句');
    assert.equal(await value('air-push-bark'), '', '保存成功后 Bark 输入框清空：明文不留在 DOM 里');
    assert.equal(await page.evaluate(`document.getElementById('air-push-bark').placeholder`), notify.barkUrl, '新掩码跟着回显进 placeholder');
    // Bark 空着 = 这次不动它（所以不带这个字段）；Webhook 空串 = 清空（所以每次都带）。
    await page.evaluate(`(() => {
      document.getElementById('air-push-bark').value = '';
      document.getElementById('air-push-webhook').value = '';
      document.getElementById('air-push-save').click();
    })()`);
    assert.ok(await until(() => posts().length === 2), '第二次保存也打出了 POST');
    assert.deepEqual(posts().slice(1), [{ webhookUrl: '' }], 'Bark 空着不带这个字段，Webhook 空串照带（清空）');
    await page.screenshot('02-push-after-save');

    // ── ⑥ Test Bark / Test Webhook：成功与失败两条路径 ────────────────────
    await page.evaluate(`document.getElementById('air-push-test-bark').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-push-notify-status').textContent === ${JSON.stringify(await tr('airPushBarkSent'))}`), 'Bark 测试成功有回执');
    assert.equal((await className('air-push-notify-status')).includes('ok'), true);
    // 服务端「配了却投递失败」是 200 + {error}：只看状态码会把这种失败报成成功。
    barkResult = { error: 'Bark refused (fixture)' };
    await page.evaluate(`document.getElementById('air-push-test-bark').click()`);
    const barkFailure = await trf('airPushBarkFailed', { error: 'Bark refused (fixture)' });
    assert.ok(await page.waitFor(`document.getElementById('air-push-notify-status').textContent === ${JSON.stringify(barkFailure)}`), 'Bark 失败时状态行写的是那句错');
    assert.equal((await className('air-push-notify-status')).includes('error'), true, '失败态是错误色');
    barkResult = { ok: true };

    await page.evaluate(`document.getElementById('air-push-test-webhook').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-push-notify-status').textContent === ${JSON.stringify(await tr('airPushWebhookSent'))}`), 'Webhook 测试成功有回执');
    // 「没配」是 4xx + {error}，api() 会抛 —— 抛出来的 message 就是服务端那句 error。
    webhookResult = { error: 'Webhook URL not configured' };
    await page.evaluate(`document.getElementById('air-push-test-webhook').click()`);
    const webhookFailure = await trf('airPushWebhookFailed', { error: 'Webhook URL not configured' });
    assert.ok(await page.waitFor(`document.getElementById('air-push-notify-status').textContent === ${JSON.stringify(webhookFailure)}`), 'Webhook 失败时状态行写的是那句错');
    webhookResult = { ok: true };

    // ── ⑦ Test Push：显示订阅者数，并顺手重读一次健康度 ───────────────────
    const beforeTestPush = healthGets;
    await page.evaluate(`document.getElementById('air-push-test').click()`);
    const sentTo = await trf('airPushSentTo', { n: 3 });
    assert.ok(await page.waitFor(`document.getElementById('air-push-test-status').textContent === ${JSON.stringify(sentTo)}`), 'Test Push 回执说发了几个订阅者');
    assert.equal((await className('air-push-test-status')).includes('ok'), true);
    assert.ok(await until(() => healthGets === beforeTestPush + 1), '发完顺手重读一次健康度（面板不停在发之前那一份）');
    assert.equal(posts().length, 2, 'Test Push 走的是另一条接口，没有再写通知设置');

    // ── ⑧ 客户端信息块：用受控的 getPushInfo 替身断渲染与开关 ──────────────
    // 真实取值依赖 pwa.js 的内部变量与浏览器 Notification / PushManager 状态，CDP 里
    // 造不出来，所以这一块断的是「本模块拿到那份数据之后怎么画、怎么切」。
    const LONG_ENDPOINT = `https://fcm.googleapis.com/fcm/send/${'fixture-key-'.repeat(12)}tail-end-of-endpoint`;
    await page.evaluate(`(() => {
      window.__pushInfo = { permission: 'granted', subscribed: true, endpoint: ${JSON.stringify(LONG_ENDPOINT)}, platform: 'Desktop Chrome' };
      window.getPushInfo = () => window.__pushInfo;
      window.togglePush = async () => { window.__pushInfo = { ...window.__pushInfo, subscribed: false, endpoint: null }; return false; };
    })()`);
    await refresh();
    assert.ok(await page.waitFor(`document.getElementById('air-push-platform').textContent === 'Desktop Chrome'`), '刷新后画的是替身给的那份');
    assert.equal(await text('#air-push-permission'), 'granted');
    assert.equal((await className('air-push-permission')).includes('is-ok'), true, '权限给了是绿的');
    assert.equal(await text('#air-push-subscription'), await tr('airPushSubscribed'), '订着就说已订阅');
    assert.equal(await text('#air-push-toggle'), await tr('airPushEnabled'), '开关按钮跟着变成已开启');
    // 超长端点旧页只留头尾：整条塞进 DOM 会把这一行撑成横向滚动条。
    assert.equal(await text('#air-push-endpoint'), `${LONG_ENDPOINT.slice(0, 40)}...${LONG_ENDPOINT.slice(-15)}`,
      '端点截成「头 40 + 尾 15」');
    assert.equal(await page.evaluate(`document.getElementById('admin-content').textContent.includes(${JSON.stringify(LONG_ENDPOINT)})`), false,
      '整条端点不许出现在面板里（只在截断后的那段里出现）');
    await page.evaluate(`document.getElementById('air-push-toggle').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-push-subscription').textContent === ${JSON.stringify(await tr('airPushUnsubscribed'))}`),
      '切完重新读一次 getPushInfo 并重画这一块');
    assert.equal(await text('#air-push-toggle'), await tr('airPushEnable'));
    assert.equal(await text('#air-push-endpoint'), '—', '退订后端点没了');
    assert.equal(await text('#air-push-test-status'), '', '成功的切换不留错误回执');
    await page.screenshot('03-push-client-block');

    // 不支持 / 抛错：原因要看得见，不能静默什么都不发生。
    await page.evaluate(`window.togglePush = async () => { throw new Error('PushManager unavailable (fixture)'); }`);
    await page.evaluate(`document.getElementById('air-push-toggle').click()`);
    const toggleFailure = await trf('airPushToggleFailed', { error: 'PushManager unavailable (fixture)' });
    assert.ok(await page.waitFor(`document.getElementById('air-push-test-status').textContent === ${JSON.stringify(toggleFailure)}`), '抛出来的原因写进状态行');
    assert.equal((await className('air-push-test-status')).includes('error'), true);
    // 返回 false 但状态没变 = 没订上（权限被拒 / 环境不支持），不能当成「刚关掉」。
    await page.evaluate(`window.togglePush = async () => false`);
    await page.evaluate(`document.getElementById('air-push-toggle').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-push-test-status').textContent === ${JSON.stringify(await tr('airPushToggleDenied'))}`),
      '没能订上时要说清楚，不能静默');

    // ── ⑨ 窄屏：读数行与按钮不该溢出内容区 ────────────────────────────────
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.navigate('/air?dir=d1&view=push');
    assert.ok(await page.waitFor(`document.querySelectorAll('#admin-content .air-push-row').length === 9`), '窄屏上三张卡的读数行照样渲染');
    const narrow = await page.evaluate(`(() => {
      const host = document.getElementById('admin-content').getBoundingClientRect();
      const rows = [...document.querySelectorAll('#admin-content .air-push-row')];
      const actions = [...document.querySelectorAll('#admin-content .air-push-actions')];
      return {
        rowOverflow: Math.round(Math.max(...rows.map(r => r.getBoundingClientRect().right)) - host.right),
        actionOverflow: Math.round(Math.max(...actions.map(a => a.getBoundingClientRect().right)) - host.right),
      };
    })()`);
    assert.ok(narrow.rowOverflow <= 1, `读数行不许溢出内容区（${narrow.rowOverflow}）`);
    assert.ok(narrow.actionOverflow <= 1, `按钮行不许溢出内容区（${narrow.actionOverflow}）`);
    await page.screenshot('04-push-native-mobile');
  });
});
