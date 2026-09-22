'use strict';
// 消息桥接这一格原来嵌的是旧 manage 页的 iframe，现在改成 Air 原生面板
// （public/air-bridges.js）。它和保险箱那格的做法不同：五个平台（微信 / 飞书 /
// Telegram / Discord / Slack）的网关生命周期、SSE 日志流、微信扫码轮询、凭证读写
// 共 800 多行都在 public/manage-bridges.js 里，面板只负责 —— 画旧页那套 id 骨架、
// 把旧页的样式搬进来、再调它的 initialize()。所以这套断言盯的是「骨架 + 接线」，
// 不是重写出来的业务逻辑：
//   ① 原生 —— #admin-content 里没有 .air-legacy-frame，也没有任何 /manage.html 请求；
//   ② 五个平台的骨架真的都在 —— 每个平台的 id 逐个点名。manage-bridges.js 是按 id
//      取元素的，少一个 id 那个平台就静默哑掉（取值处多是 `if (!el) return`），
//      页面看着照样渲染，最难发现；
//   ③ 打开面板真打了那十条读取接口（每平台 config + status）；
//   ④ 读取结果真画进了对应元素（按钮 disabled / 状态药丸 / 运行徽标）；
//   ⑤ 写操作打真接口且 body 逐字段对得上（启动桥接、保存凭证）；
//   ⑥ 工具条的「刷新」= 再调一次 initialize()，不重建骨架（日志容器还是原来那个节点）；
//   ⑦ 离开再进来会关掉上一轮那几条 EventSource。
//
// 关于 ⑦（这次复用最容易漏的一步）：initialize() 只会「按当前状态连」，从不「拆」。
// 所以「上一轮开着、这一轮状态已经不是运行中」的那条连接必须由 render() 里的
// disconnect() 收掉；漏了的话它不只是白占一条连接 —— 它的 onmessage 按 id 找日志
// 容器，重建之后照样命中新画出来的那个，于是旧连接继续往新 DOM 里灌日志，每进出
// 一次多一条。
// 怎么断的：把 window.EventSource 换成记账版（created / live / closed 挂 window.__es），
// events 路由**故意不响应**（真 SSE 本来就是一条不结束的流）。这样连接既不会自己
// error、也不会触发 3 秒重连，计数才是确定的 —— 用一条会立刻结束的响应的话，
// 连接会自己 error 并 close，即使漏了 disconnect() 也看不出还挂着一条。
// 于是：第二轮进来前把 fixture 里两个平台都改成「没在跑」，再进面板一次 ——
// 有 disconnect() 时 live 归 0，漏了的话上一轮那条还开着（live 恒为 1）。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('the Air bridges panel is native, keeps the legacy id skeleton and closes the previous SSE round', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-air-bridges-qa');
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
  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' }], clis: ['codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  // 五个平台的状态放在 fixture 里，路由读写它 —— 「启动前 / 启动后」「还在跑 / 已经停了」
  // 才有东西可断。凭证都是编的字符串（形状像 token 即可）。
  const TOKEN = '999999:fixture-not-a-real-bot-token';
  const configWrites = [];
  let wechatRunning = true, telegramRunning = false;
  routes['GET /api/wechat/config'] = () => json({ outputIdle: 5000, loggedIn: true });
  routes['GET /api/wechat/status'] = () => json({ loggedIn: true, running: wechatRunning, gateway: null });
  routes['GET /api/wechat/log'] = () => json([]);
  routes['GET /api/feishu/config'] = () => json({ appId: 'cli_fixture', domain: 'feishu', configured: true });
  routes['GET /api/feishu/status'] = () => json({ configured: true, running: false, gateway: { cli: 'codex' } });
  routes['GET /api/feishu/log'] = () => json([]);
  routes['GET /api/telegram/config'] = () => json({ configured: true });
  routes['GET /api/telegram/status'] = () => json({ configured: true, running: telegramRunning, gateway: null });
  routes['POST /api/telegram/start'] = () => { telegramRunning = true; return json({ ok: true }); };
  routes['POST /api/telegram/config'] = req => { configWrites.push(JSON.parse(req.body)); return json({ ok: true }); };
  routes['GET /api/discord/config'] = () => json({ configured: false });
  routes['GET /api/discord/status'] = () => json({ configured: false, running: false, gateway: null });
  routes['GET /api/slack/config'] = () => json({ configured: false });
  routes['GET /api/slack/status'] = () => json({ configured: false, running: false, gateway: null });
  // SSE：故意不响应（见文件头 ⑥）。真 SSE 就是一条不结束的流 —— 这样连接不 error、
  // 不重连，window.__es 上的 live 计数才是确定的。请求本身照样进 page.requests。
  for (const platform of ['wechat', 'feishu', 'telegram', 'discord', 'slack']) {
    routes[`/api/${platform}/events`] = () => new Promise(() => {});
  }

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    const text = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
    // 文案一律用 t() 取字典里的值来比，不抄中文字面量 —— 面板自己那几句是 airBridges*
    // key；复用模块（manage-bridges.js）的状态药丸现在也走 t()（用我这边这两个
    // airBridgesState* key），所以同一个 key 两边一起改，测试跟着走。
    const T = key => page.evaluate(`t(${JSON.stringify(key)})`);
    // 比措辞更硬的证据是「结构性信号」：按钮 disabled、元素的 display 显隐、模块给已配置/
    // 已创建态写的内联色。这些只有「读回来的状态真被画上去了」才会出现 ——
    // 骨架刚建出来时它们分别是：启动可用 / gw-open 收起 / 药丸没有内联色。
    const inlineColor = id => page.evaluate(`document.getElementById(${JSON.stringify(id)}).style.color`);
    const until = async (fn, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 50)); }
      return false;
    };
    const apiCalls = () => page.requests.filter(r => r.path.startsWith('/api/')).map(r => `${r.method} ${r.path}`);
    const eventsRequests = () => page.requests.filter(r => /^\/api\/(wechat|feishu|telegram|discord|slack)\/events$/.test(r.path));
    const esState = () => page.evaluate('window.__es');

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ── ① 从设置中心第二组进去：原生面板，不嵌旧 manage 页 ────────────────
    await page.navigate('/air?dir=d1&view=settings');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='设置中心'`), '先落在设置中心');
    const groupTitle = await T('airAdminGroupConnect');
    assert.equal(await page.evaluate(`(() => {
      const card = [...document.querySelectorAll('.air-setting-card')]
        .find(c => c.querySelector('strong').textContent === ${JSON.stringify(await T('airBridges'))});
      return card ? card.closest('.air-settings-group').querySelector('h3').textContent : null;
    })()`), groupTitle, '消息桥接挂在设置中心的「连接与通知」那一组');

    // 记账版 EventSource：必须在进面板之前装上（进面板就会建连接）。
    await page.evaluate(`(() => {
      const Real = window.EventSource;
      const state = { created: 0, closed: 0, live: 0, urls: [] };
      window.__es = state;
      window.EventSource = function Tracked(url) {
        const source = new Real(url);
        state.created += 1; state.live += 1; state.urls.push(String(url));
        const close = source.close.bind(source);
        source.close = () => { if (!source.__trackedClosed) { source.__trackedClosed = true; state.live -= 1; state.closed += 1; } return close(); };
        return source;
      };
    })()`);

    await page.evaluate(`[...document.querySelectorAll('.air-setting-card')]
      .find(c => c.querySelector('strong').textContent === ${JSON.stringify(await T('airBridges'))}).click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent===${JSON.stringify(await T('airBridges'))}`), '点进去落在消息桥接页');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0, '原生面板里没有旧 manage 的 iframe');
    assert.equal(page.requests.some(r => r.path === '/manage.html'), false, 'iframe 的 src 会真的发出去 —— 没这条请求才算真没嵌');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].map(b => b.textContent.replace(/\\s+/g,''))`),
      ['←返回设置中心', '↻刷新'], '工具条是面板自己的（返回设置中心 / 刷新）');
    assert.equal(await text('#admin-content .air-bridges .admin-panel h3'), await T('airBridgesTitle'), '面板抬头走 t()');
    assert.equal(await text('#admin-content .air-bridges-intro'), await T('airBridgesIntro'), '面板说明走 t()');

    // ── ② 五个平台的骨架真的都在（id 逐个点名）────────────────────────────
    const IDS = {
      wechat: ['wx-qr-img', 'wx-login-status', 'wx-btn-qr', 'wx-btn-logout', 'wx-gw-state', 'wx-gw-create', 'wx-gw-open', 'wx-gw-reset', 'wx-gw-destroy', 'wx-gw-status', 'wx-idle', 'wx-btn-start', 'wx-btn-stop', 'wx-status', 'wx-running-badge', 'wx-log'],
      feishu: ['fs-cfg-state', 'fs-appid', 'fs-appsecret', 'fs-domain', 'fs-cfg-status', 'fs-gw-state', 'fs-gw-create', 'fs-gw-open', 'fs-gw-reset', 'fs-gw-destroy', 'fs-gw-status', 'fs-ws-badge', 'fs-btn-start', 'fs-btn-stop', 'fs-status', 'fs-running-badge', 'fs-log'],
      telegram: ['tg-cfg-state', 'tg-botToken', 'tg-cfg-status', 'tg-gw-state', 'tg-gw-create', 'tg-gw-open', 'tg-gw-reset', 'tg-gw-destroy', 'tg-gw-status', 'tg-ws-badge', 'tg-btn-start', 'tg-btn-stop', 'tg-status', 'tg-running-badge', 'tg-log'],
      discord: ['dc-cfg-state', 'dc-botToken', 'dc-cfg-status', 'dc-gw-state', 'dc-gw-create', 'dc-gw-open', 'dc-gw-reset', 'dc-gw-destroy', 'dc-gw-status', 'dc-ws-badge', 'dc-btn-start', 'dc-btn-stop', 'dc-status', 'dc-running-badge', 'dc-log'],
      slack: ['sk-cfg-state', 'sk-botToken', 'sk-appToken', 'sk-cfg-status', 'sk-gw-state', 'sk-gw-create', 'sk-gw-open', 'sk-gw-reset', 'sk-gw-destroy', 'sk-gw-status', 'sk-ws-badge', 'sk-btn-start', 'sk-btn-stop', 'sk-status', 'sk-running-badge', 'sk-log'],
    };
    const missing = await page.evaluate(`(() => {
      const ids = ${JSON.stringify(Object.values(IDS).flat())};
      return ids.filter(id => !document.getElementById(id));
    })()`);
    assert.deepEqual(missing, [], '五个平台的 id 骨架一个都不能少（manage-bridges.js 按 id 取元素）');
    // Agent 单选组也按名字找（manage-bridges.js 用 `input[name="<idp>-gw-cli"]:checked`）。
    assert.deepEqual(await page.evaluate(`['wx','fs','tg','dc','sk'].filter(p => !document.querySelector('input[name="'+p+'-gw-cli"]'))`), [],
      '五个平台的 Agent 单选组都在（name 前缀不能改）');
    // 折叠卡：只有微信默认展开，其余收起（旧页 open 在微信上）。
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.air-bridges .bridge-acc')].map(d => d.open)`),
      [true, false, false, false, false], '默认只展开微信那一张折叠卡');
    await page.screenshot('00-bridges-native-desktop');

    // ── ③ 打开面板真打了那十条读取接口 ────────────────────────────────────
    const expectedReads = ['/api/wechat/config', '/api/wechat/status', '/api/feishu/config', '/api/feishu/status',
      '/api/telegram/config', '/api/telegram/status', '/api/discord/config', '/api/discord/status', '/api/slack/config', '/api/slack/status'];
    assert.ok(await until(() => expectedReads.every(p => page.requests.some(r => r.method === 'GET' && r.path === p))),
      '每个平台的 config + status 都读了一遍');
    assert.ok(apiCalls().some(c => c === 'GET /api/telegram/config'), 'config 是按平台的接口读的');

    // ── ④ 读取结果真画进了对应元素 ───────────────────────────────────────
    // 飞书：configured → 药丸被切成「已配置」那一份；gateway.cli=codex → 药丸写 codex、
    // 创建按钮让位给打开/重置/销毁，单选也跟着切到 codex。
    // 「已配置」这个措辞由复用模块自己决定（现在也用 t()），所以不去抄字面量：
    // 断①不再是未配置那一份文案，②模块给已配置态写的内联色出现了（骨架里没有内联色）。
    assert.ok(await until(async () => (await inlineColor('fs-cfg-state')) !== ''), '飞书凭证已配置画进了状态药丸（已配置态的内联色上去了）');
    assert.notEqual(await text('#fs-cfg-state'), await T('airBridgesStateUnconfigured'), '飞书药丸不再是「未配置」那一份文案');
    assert.equal(await text('#fs-gw-state'), 'codex', '飞书 Gateway 会话写着当前 CLI（这是数据，不是文案）');
    // 「露出来」只看 display 是不是 none —— manage-bridges.js 切显隐用的就是
    // el.style.display = ''|'none'，具体是 inline-block 还是 block 由布局决定
    // （这三个按钮在 .sc-footer 里是 flex item，会被块化）。
    assert.deepEqual(await page.evaluate(`(() => {
      const shown = id => getComputedStyle(document.getElementById(id)).display !== 'none';
      return { create: shown('fs-gw-create'), open: shown('fs-gw-open'), reset: shown('fs-gw-reset'), destroy: shown('fs-gw-destroy') };
    })()`), { create: false, open: true, reset: true, destroy: true },
      '飞书已有 Gateway 时：创建按钮收起，打开/重置/销毁露出来');
    assert.equal(await page.evaluate(`document.querySelector('input[name="fs-gw-cli"][value="codex"]').checked`), true, '单选跟着 Gateway 当前的 CLI 走');
    // Telegram 这边 gateway=null → 药丸写「未创建」、创建按钮可用（两个平台画的是同一份骨架，
    // 但状态各自独立，不能串味）。
    assert.equal(await text('#tg-gw-state'), await T('airBridgesStateUncreated'), '没有 Gateway 的平台画的是「未创建」');
    assert.deepEqual(await page.evaluate(`(() => {
      const shown = id => getComputedStyle(document.getElementById(id)).display !== 'none';
      return { create: shown('tg-gw-create'), open: shown('tg-gw-open') };
    })()`), { create: true, open: false }, '没有 Gateway 时只有创建按钮可用');

    // 微信：running → 启动禁用、停止可用、Running 徽标亮；loggedIn → 退出登录露出来。
    assert.deepEqual(await page.evaluate(`(() => {
      const shown = id => getComputedStyle(document.getElementById(id)).display !== 'none';
      return { start: document.getElementById('wx-btn-start').disabled, stop: document.getElementById('wx-btn-stop').disabled,
        badge: shown('wx-running-badge'), logout: shown('wx-btn-logout') };
    })()`), { start: true, stop: false, badge: true, logout: true }, '微信「在跑 + 已登录」画进了按钮和徽标');

    // Discord / Slack：configured=false —— 画上去的仍然是「未配置」那一份文案，所以这里
    // 只能比文案（跟骨架首帧用的是同一个 key，比的是「模块有没有按读回来的值重画」这一层
    // 关系；configured=false 的硬证据其实在别处：飞书那两条、微信的按钮、Telegram 的启动）。
    assert.deepEqual(await page.evaluate(`['dc-cfg-state','sk-cfg-state'].map(id => document.getElementById(id).textContent)`),
      [await T('airBridgesStateUnconfigured'), await T('airBridgesStateUnconfigured')], '未配置的平台画的是「未配置」');

    // ── ⑤ 写操作打真接口，body 逐字段断言 ───────────────────────────────
    assert.deepEqual(await page.evaluate(`({ start: document.getElementById('tg-btn-start').disabled, stop: document.getElementById('tg-btn-stop').disabled })`),
      { start: false, stop: true }, 'Telegram 没在跑：启动可用、停止不可用');
    await page.evaluate(`document.getElementById('tg-btn-start').click()`);
    assert.ok(await until(() => page.requests.some(r => r.method === 'POST' && r.path === '/api/telegram/start')), '点启动打的是 POST /api/telegram/start');
    assert.ok(await until(async () => (await page.evaluate(`document.getElementById('tg-btn-stop').disabled`)) === false),
      '启动成功后 tg-btn-stop 不再是 disabled');
    assert.equal(await page.evaluate(`document.getElementById('tg-btn-start').disabled`), true, '启动成功后 tg-btn-start 变 disabled');
    assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('tg-running-badge')).display !== 'none'`), true, 'Running 徽标跟着亮');
    // showToast 这条链路：manage-bridges.js 调的是全局 showToast（旧页在 manage.js 里），
    // Air 由 air-bridges.js 补成 context.notice —— 提示区里出现一条新文案就说明这个补丁
    // 接上了（不断具体措辞：那句话现在是 t('manageBridgesBridgeStarted', {name}) 算的）。
    assert.ok(await until(async () => (await text('#notice')).trim().length > 0), 'showToast 补丁接到了 Air 的全局提示上');

    await page.evaluate(`document.getElementById('tg-botToken').value = ${JSON.stringify(TOKEN)}`);
    await page.evaluate(`document.getElementById('tg-btn-save').click()`);
    assert.ok(await until(() => configWrites.length === 1), '保存凭证打的是 POST /api/telegram/config');
    assert.deepEqual(configWrites, [{ botToken: TOKEN }], 'body 只有我们填的那个字段（空字段不上送）');
    assert.equal(await page.evaluate(`document.getElementById('tg-botToken').value`), '', '保存成功清空输入框');
    await page.screenshot('01-bridges-telegram-running');

    // ── ⑥ 工具条的「刷新」= 再调一次 initialize()，不重建骨架 ──────────────
    // 此时活着的连接：微信（进面板时就在跑）+ Telegram（刚点启动）＝ 2 条。
    assert.deepEqual(await esState(), { created: 2, closed: 0, live: 2, urls: ['/api/wechat/events', '/api/telegram/events'] },
      '进面板 + 启动 Telegram 一共建了两条 SSE（只有状态是 running 的平台会连）');
    assert.equal(eventsRequests().length, 2, 'events 路径两条请求，一条连接一条');
    // 给日志容器打个记号：刷新后它还在，就说明刷新没有把骨架换掉（契约里 refresh 只是让
    // 五个平台重读一遍 config + status，用户展开哪张卡、日志里已经有几行都不该被抹掉）。
    await page.evaluate(`document.getElementById('wx-log').dataset.keepMarker = 'yes'`);
    const readsOf = () => page.requests.filter(r => r.method === 'GET'
      && /^\/api\/(wechat|feishu|telegram|discord|slack)\/(config|status)$/.test(r.path)).length;
    const readsBeforeRefresh = readsOf();
    await page.evaluate(`[...document.querySelectorAll('#admin-actions button')]
      .find(b => b.textContent.includes(${JSON.stringify(await T('airAdminRefresh'))})).click()`);
    assert.ok(await until(() => readsOf() >= readsBeforeRefresh + 10), '刷新让五个平台各重读了一次 config + status（又一整轮 10 条）');
    assert.equal(await page.evaluate(`document.getElementById('wx-log').dataset.keepMarker`), 'yes', '刷新没重建骨架（日志容器还是原来那个节点）');
    // 刷新对 SSE 的影响：initialize() 对「在跑」的平台是「先关再连」（connectSSE 内部先
    // disconnectSSE），所以每刷新一次这两个平台各重连一次 —— 关键是 live 不涨。
    assert.deepEqual(await page.evaluate(`({ created: window.__es.created, closed: window.__es.closed, live: window.__es.live })`),
      { created: 4, closed: 2, live: 2 }, '刷新把两个在跑的平台各重连一次，活着的连接数不涨');

    // ── ⑦ 离开再进来：上一轮那几条 EventSource 必须被关掉 ────────────────
    // 切走（工具条的「返回设置中心」）—— 这一刻面板并没有义务关连接（契约是「重建骨架
    // 之前先 disconnect」），但计数不能自己长起来：没有重连、没有多余的 SSE 请求。
    await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].find(b => b.textContent.includes('返回设置中心')).click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='设置中心'`), '回到设置中心');
    const afterLeave = await esState();
    await new Promise(r => setTimeout(r, 700));
    assert.deepEqual(await esState(), afterLeave, '离开后连接数不再增长（没有漏出来的重连循环）');
    assert.equal(eventsRequests().length, 4, 'SSE 请求也没有多出来');

    // 关键一步：把两个平台都改成「已经不在跑」，再进一次面板。有 disconnect() 时上一轮
    // 那两条被关掉、这一轮谁也不连（live 归 0）；漏了 disconnect() 的话上一轮那条还挂着
    // （状态已经不是 running，checkStatus 不会走到 connectSSE，没有任何人会关它）。
    wechatRunning = false; telegramRunning = false;
    await page.evaluate(`[...document.querySelectorAll('.air-setting-card')]
      .find(c => c.querySelector('strong').textContent === ${JSON.stringify(await T('airBridges'))}).click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#admin-content .air-bridges .bridge-acc').length === 5`), '第二轮回来的骨架重画好了');
    assert.ok(await until(async () => (await esState()).live === 0), '重建骨架前 disconnect() 关掉了上一轮那两条 SSE');
    assert.deepEqual(await page.evaluate(`({ created: window.__es.created, closed: window.__es.closed, live: window.__es.live, urls: window.__es.urls.slice().sort() })`),
      { created: 4, closed: 4, live: 0, urls: ['/api/telegram/events', '/api/telegram/events', '/api/wechat/events', '/api/wechat/events'] },
      '这一轮没有平台在跑，所以一条新连接都不该建');
    assert.equal(eventsRequests().length, 4, 'SSE 请求数不随进出次数累加');
    // 骨架真的重建了：上一轮 Telegram 点过启动、微信是运行中，两个平台的按钮都翻过状态；
    // 这一轮 status 说都没在跑（manage-bridges.js 只在 running 为真时才去改按钮），所以
    // 还能看到「新建时的默认态」就说明 DOM 是换过的一副新骨架，不是上一轮留下来的。
    assert.deepEqual(await page.evaluate(`(() => {
      const shown = id => getComputedStyle(document.getElementById(id)).display !== 'none';
      return { tgStart: document.getElementById('tg-btn-start').disabled, tgStop: document.getElementById('tg-btn-stop').disabled,
        wxStart: document.getElementById('wx-btn-start').disabled, wxBadge: shown('wx-running-badge'), tgBadge: shown('tg-running-badge') };
    })()`), { tgStart: false, tgStop: true, wxStart: false, wxBadge: false, tgBadge: false }, '重建出来的是一副没被上一轮污染的新骨架');
    assert.ok(await until(async () => (await text('#wx-log')).includes(await T('airBridgesLogIdle'))), '新骨架的日志容器是干净的占位行');

    // ── ⑦ 窄屏：卡片和操作不溢出 ─────────────────────────────────────────
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.navigate('/air?dir=d1&view=bridges');
    assert.ok(await page.waitFor(`document.querySelectorAll('#admin-content .air-bridges .bridge-acc').length === 5`), '窄屏上骨架照样渲染');
    const narrow = await page.evaluate(`(() => {
      // 拿 Telegram 那张凭证卡（三条里最宽的一行：两个凭证字段里最长的那个），
      // 它默认是收起的，先展开才量得到真实布局。
      const input = document.getElementById('tg-botToken');
      const details = input.closest('details'); details.open = true;
      const row = input.closest('.setting-row');
      const card = input.closest('.settings-card');
      const box = card.getBoundingClientRect(), field = input.getBoundingClientRect(), label = row.querySelector('label').getBoundingClientRect();
      return { stacked: getComputedStyle(row).flexDirection, fieldRight: Math.round(field.right), cardRight: Math.round(box.right),
        labelLeft: Math.round(label.left), cardLeft: Math.round(box.left) };
    })()`);
    assert.equal(narrow.stacked, 'column', '窄屏上标签与输入框改成上下排');
    assert.ok(narrow.fieldRight <= narrow.cardRight + 1, `输入框不许溢出卡片（${narrow.fieldRight} vs ${narrow.cardRight}）`);
    assert.ok(narrow.labelLeft >= narrow.cardLeft - 1, `标签也不许溢出卡片（${narrow.labelLeft} vs ${narrow.cardLeft}）`);
    await page.screenshot('02-bridges-native-mobile');
  });
});
