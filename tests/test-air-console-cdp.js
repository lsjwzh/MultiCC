'use strict';
// 这组断言盯的是真实 Air 交互模型的五处改动，都在真浏览器里跑：
//   ① 控制台是主区域里的一页，跟目录首页、定时任务同级 —— 点侧栏那行就在右边打开，
//      地址写 view=overview（可刷新、可分享、可后退），当前任务只是被藏起来、不卸载；
//   ② 侧栏的任务带只装「最近」，完整列表（跨全部目录 + 搜索 + 筛选）搬进控制台；
//   ③ 运行中的任务和它所在的目录，在侧栏 / 控制台 / 目录页 / 页头都带同一圈彩虹；
//   ④ ⌘K 一次搜目录和任务两类对象；
//   ⑤ 控制台的统计压成一条窄读数带，「谁在等我」只留最近更新的 5 条，整份清单在它
//      自己的页上（?view=attention）。
// 这些行为靠 DOM/地址状态判断。唯一量位置的地方是各页共用的正文：一页只站一块。
// 例外是③里的「圈真的画出来了吗」—— 那一处必须读像素，理由见 ringEdges。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');
const { captureRegion, saturation } = require('./helpers/png-pixels');

// 抽屉（#more-panel）是个 showModal 的 dialog，宽度带过渡。这个测试页是后台 target、
// 不渲染也就不产生帧：光等时间，过渡时钟根本不会起步。读一次几何强制样式重算，
// 过渡从这一刻开始计时，再等过一个完整过渡，下一次重算就是终值。
//
// 控制台不在这一条上了：它是一页正文（#console-center 上的 hidden 开关），没有过渡，
// 也没有「屏外停着等下一条指令」那一步 —— 从前它得等滑完才能量位置。
const settle = async page => {
  await page.screenshot('settle');
  await page.evaluate(`new Promise(done => setTimeout(done, 400))`);
  await page.screenshot('settle');
};
// 「控制台那一页在不在」只有一个判据：正文那一块没被 hidden。它自己的标题、动作、
// 退回任务，读的都是这个 —— 不再有浮层，也就没有「盒子在屏外但还量得到」这种状态。
const consoleShown = page => page.evaluate(`document.getElementById('console-center').hidden===false`);
const consoleHidden = page => page.evaluate(`document.getElementById('console-center').hidden===true`);

// 「圈在不在」和「圈画出来了没有」是两件事，前者骗过人一次。
//
// 元素自己的 inset box-shadow 按绘制顺序落在「自己的背景之上、自己的后代之下」，
// 所以一个贴在 padding 边的不透明后代就能把圈整条边盖掉 —— 而 class 还在、几何没
// 变、getComputedStyle 照样报着动画在跑，DOM 里看不出任何异常。要断这件事只能读
// 像素：从边框里侧向内扫 7 个像素取最饱和的一点（圈带 2px，落在窗口里必被读到），
// 四条边中点各扫一条。淡底色（白、#eff6ff）的饱和度只有十几，纯色相的圈是 255。
const ringEdges = async (page, selector) => {
  const box = await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  })()`);
  assert.ok(box, `${selector} 不在页面上`);
  // 盒子位置是小数、圈带只有 2px，取整取错 1px 就采到圈外面去了：整块截图往左上
  // 各让 4px，取样坐标统一减这个原点，误差就只落在窗口宽度里，被「取最大」吃掉。
  const clipX = Math.floor(box.l) - 4, clipY = Math.floor(box.t) - 4;
  const shot = await captureRegion(page, { x: clipX, y: clipY, width: Math.ceil(box.r - box.l) + 8, height: Math.ceil(box.b - box.t) + 8 });
  const px = (fx, fy) => saturation(shot.at(Math.round(fx - clipX), Math.round(fy - clipY)));
  const inwards = (fx, fy, dx, dy) => {
    let best = 0;
    for (let i = 1; i <= 7; i++) best = Math.max(best, px(fx + dx * i, fy + dy * i));
    return best;
  };
  const cx = (box.l + box.r) / 2, cy = (box.t + box.b) / 2;
  return { top: inwards(cx, box.t, 0, 1), bottom: inwards(cx, box.b, 0, -1), left: inwards(box.l, cy, 1, 0), right: inwards(box.r, cy, -1, 0) };
};
// 圈是「在跑」的唯一视觉信号，缺一条边就等于把状态说轻了 —— 四条边一条都不能少。
//
// 「读不到圈」和「没画圈」在这里得分开：这个测试页是后台 target，不渲染也就不产生帧，
// 而带 clip 的截图是分块从合成层上取的 —— 刚重画过（比如从控制台那一页切回任务页，
// 全程只有 JS，没有导航）的时候，那一块会由新旧两帧拼起来，四条边里只扫得到一两条
// （实测出现过 left/right 79 而 top/bottom 0）。整屏截一张能把这一帧催齐，所以读
// 不到就先催、催完再读；真画不出来时，催几次也还是那几条边缺着，照样失败。
const RING_MIN_SATURATION = 60;
const flushFrame = page => page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const assertRingDrawn = async (page, selector, why) => {
  let edges;
  for (let attempt = 0; attempt < 5; attempt++) {
    edges = await ringEdges(page, selector);
    if (Object.values(edges).every(value => value >= RING_MIN_SATURATION)) return;
    await flushFrame(page);
    await page.evaluate(`new Promise(done => setTimeout(done, 120))`);
  }
  const missing = Object.entries(edges).filter(([, value]) => value < RING_MIN_SATURATION).map(([edge]) => edge);
  assert.deepEqual(missing, [], `${why}：圈缺了这几条边（各边最饱和像素 ${JSON.stringify(edges)}）`);
};

test('Air console is a cross-directory overlay, the task band shows recents, and running work wears the ring everywhere', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-air-console-qa');
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

  const directories = [
    { id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' },
    { id: 'd2', name: 'North · 商城', path: '/projects/storefront' },
    { id: 'd3', name: 'Gapasea', path: '/projects/gapasea' },
  ];
  // 任务条目带上配置与角色绑定：没有它们，任务页的编辑器就无从渲染（那是真实
  // 接口一定会给的字段，fixture 少了就等于在测一个不存在的形状）。
  //
  // status/runState 用的是服务端那套词表（src/task-board/normalize.js 的
  // TASK_RUN_STATES），不是这里编的词：status 只有 active/done/archived 三个人为
  // 的生命周期取值，「执行中」根本不在里面 —— 它在 runState 上。fixture 用
  // 'doing'/'waiting' 当 status 的时候，界面看着对，其实测的是一个不存在的形状。
  const configuration = { cli: 'codex', provider: 'codex-lab', providerName: 'Lab Responses', providerSelection: null,
    model: 'gpt-5.5', effectiveModel: 'gpt-5.5', effort: 'medium' };
  const task = (id, dirId, title, status, runState, updatedAt) => ({ id, dirId, title, recordType: 'planned', workflowStage: 'doing',
    status, runState, updatedAt, resource: { residency: 'planned', lease: 'idle' }, configuration });
  const airTasks = [
    task('tsk_here', 'd1', '收口 Air 的控制台', 'active', 'idle', 5000),
    task('tsk_wait', 'd2', '结算页金额四舍五入错误', 'active', 'waiting', 9000),
    { ...task('tsk_other', 'd3', '登录页空状态文案', 'active', 'running', 7000), resource: { residency: 'materialized', lease: 'running' } },
    task('tsk_done', 'd3', '导出失败重试', 'done', 'succeeded', 1000),
  ];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex', 'claude'], migration: { errors: [] },
    tasks: airTasks, sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/air/tasks/tsk_here'] = routes['/api/task-shell-tasks/tsk_here'] = () => json({ ok: true,
    task: airTasks[0], sessionId: 'task-here', ownerShellId: 'shell-a', readOnly: false,
    execution: { busy: false, status: 'idle' }, resource: airTasks[0].resource, attribution: {}, roleBindings: { version: 0, bindings: [] }, messages: [] });
  routes['/api/air/tasks/tsk_wait'] = routes['/api/task-shell-tasks/tsk_wait'] = () => json({ ok: true,
    task: airTasks[1], sessionId: 'task-wait', ownerShellId: 'shell-b', readOnly: false,
    execution: { busy: true, status: 'running' }, resource: { residency: 'materialized', lease: 'running' }, attribution: {}, roleBindings: { version: 0, bindings: [] }, messages: [] });
  // 在跑的那条也要有任务页接口：从控制台点进去的时候，页头标题是从这里来的。
  routes['/api/air/tasks/tsk_other'] = routes['/api/task-shell-tasks/tsk_other'] = () => json({ ok: true,
    task: airTasks[2], sessionId: 'task-other', ownerShellId: 'shell-c', readOnly: false,
    execution: { busy: true, status: 'running' }, resource: airTasks[2].resource, attribution: {}, roleBindings: { version: 0, bindings: [] }, messages: [] });
  routes['POST /api/task-board/tasks/tsk_here/chat-session'] = () => json({ ok: true, sessionId: 'task-here' });
  routes['POST /api/task-board/tasks/tsk_wait/chat-session'] = () => json({ ok: true, sessionId: 'task-wait' });
  routes['POST /api/task-board/tasks/tsk_other/chat-session'] = () => json({ ok: true, sessionId: 'task-other' });
  for (const dir of ['d1', 'd2', 'd3']) routes['POST /api/task-shells'] = () => json({ id: 'shell-a' });
  // 常用设置里的「关盖运行」开关打的就是这两条：GET 决定这一行出不出现、开关在
  // 哪一边，POST 是点一下之后的落点（把这个 body 断言出来，才算断到真的在写）。
  const powerPosts = [];
  let powerEnabled = false;
  routes['/api/settings/power'] = () => json({ available: true, enabled: powerEnabled, unlockPassword: { available: true, set: true, enabled: powerEnabled } });
  routes['POST /api/settings/power'] = req => {
    powerEnabled = JSON.parse(req.body).enabled;
    powerPosts.push(req.body);
    return json({ ok: true, available: true, enabled: powerEnabled });
  };

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1&task=tsk_here');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='收口 Air 的控制台'`));
    // 存储里刻意留一条收藏再重载：界面撤掉之后就不该再有任何东西读它 —— 这样下面
    // 「侧栏没有收藏目录那一组」才是在断界面，而不是因为存储本来就是空的才恰好没有。
    await page.evaluate(`localStorage.setItem('air:favorites', JSON.stringify(['d1']))`);
    await page.navigate('/air?dir=d1&task=tsk_here');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='收口 Air 的控制台'`));

    // ── 侧栏：任务区只装「最近」，其余操作按频次收敛 ─────────────────────
    assert.equal(await page.evaluate(`document.getElementById('activity')===null`), true, '跨目录活动入口已移除');
    assert.equal(await page.evaluate(`[...document.querySelectorAll('#sidebar .nav-row')].map(el=>el.textContent.replace(/\\s+/g,'').replace(/\\d+$/,'')).join('|')`), '◫控制台|◴定时任务|⚙更多与系统›');
    assert.ok(await page.waitFor(`document.getElementById('console-badge').hidden===false`), '控制台行带常驻徽标');
    // 徽标数 = 要我动手的任务（现场里只有一条等回答的）。在跑的那条不算 ——
    // 它不需要我操作，不该在侧栏催我。
    assert.equal(await page.evaluate(`document.getElementById('console-badge').textContent`), '1', '徽标数 = 等我处理的任务');

    // 作用域开关、搜索框、状态筛选都从侧栏撤了：它们是给「完整列表」用的，
    // 而完整列表现在住在控制台的「全部任务」里。
    for (const gone of ['scope-switch', 'task-search', 'status-filter']) {
      assert.equal(await page.evaluate(`document.getElementById('${gone}')===null`), true, `#${gone} 已从侧栏移除`);
    }
    // 「收藏目录」那一组（连同目录卡上的 ☆ 和目录库里的「已收藏」）也撤了：工作目录
    // 本来就不会很多，一组随时可能空的快捷方式净是白占位置；App 侧栏先撤的，Web 对齐。
    // 这条盯的是界面 —— 存储和 App 的 AirLocalStore 收藏接口都还在，别拿它们当依据又加回来。
    for (const gone of ['favorite', 'favorites']) {
      assert.equal(await page.evaluate(`document.getElementById('${gone}')===null`), true, `#${gone} 已从侧栏移除`);
    }
    assert.equal(await page.evaluate(`[...document.querySelectorAll('#sidebar *')].some(el=>el.textContent==='收藏目录')`), false, '侧栏不再有「收藏目录」标题');
    assert.equal(await page.evaluate(`document.querySelector('.space-shortcuts').textContent.replace(/\\s+/g,'')`), '工作目录⌘K切换', '目录卡快捷行只剩标题和 ⌘K 提示');
    assert.equal(await page.evaluate(`document.getElementById('task-list-title').textContent`), '最近任务');
    assert.ok(await page.waitFor(`document.querySelectorAll('#tasks button').length===1`), '最近里只有打开过的这一条');
    // 一行要能自己说清：状态徽标（注册表给的词）、所属目录、阶段与资源去向。
    assert.equal(await page.evaluate(`document.querySelector('#tasks button .mc-status-label').textContent`), '空闲', '任务行带状态徽标');
    assert.equal(await page.evaluate(`document.querySelector('#tasks button .task-dir').textContent`), 'MultiCC 主仓', '任务行带所属目录');
    assert.ok(await page.evaluate(`document.querySelector('#tasks button .task-note').textContent.includes('计划')`), '阶段跟在后面');
    assert.equal(await page.evaluate(`document.querySelectorAll('#tasks button.ring-running').length`), 0, '没在跑的任务不带圈');
    // More uses an independent drawer; opening it preserves task and URL.
    const moreBefore = await page.evaluate(`({url: location.href, task: document.getElementById('task-title').textContent})`);
    await page.evaluate(`document.getElementById('side-more').click()`);
    await settle(page);
    assert.ok(await page.evaluate(`document.getElementById('more-panel').open`));
    assert.deepEqual(await page.evaluate(`({url: location.href, task: document.getElementById('task-title').textContent})`), moreBefore);
    assert.equal(await page.evaluate(`document.getElementById('more-panel').parentElement.tagName`), 'BODY', 'not clipped by the sidebar');
    // 一级是四个分组 + 一行整页入口；二级只显示选中的那一组。
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#settings-tree .more-parent strong')].map(b=>b.textContent)`),
      ['重要功能', 'AI 与执行', '连接与通知', '资源与存储']);
    assert.deepEqual(await page.evaluate(`(() => {
      const flyout = document.getElementById('more-flyout');
      return {
        twoColumn: document.getElementById('more-panel').getBoundingClientRect().width > 700 && flyout.checkVisibility(),
        shown: [...flyout.querySelectorAll('.more-leaf-group:not([hidden]) .more-leaf strong')].map(b=>b.textContent),
        folded: flyout.querySelectorAll('.more-leaf-group[hidden]').length,
      };
    })()`), { twoColumn: true, shown: ['敏感信息', '服务与文档', '记忆图谱', '任务图谱', '工作区'], folded: 3 },
      '抽屉开成两列，二级默认选中第一组、另外三组收着');
    // 悬停换组就是「联动」：右边那一列跟着换，一级那一行同时点亮。
    await page.evaluate(`document.querySelector('#settings-tree .more-parent[data-more-group="connect"]')
      .dispatchEvent(new PointerEvent('pointerenter'))`);
    await settle(page);
    assert.deepEqual(await page.evaluate(`(() => {
      const flyout = document.getElementById('more-flyout');
      return {
        shown: [...flyout.querySelectorAll('.more-leaf-group:not([hidden]) .more-leaf strong')].map(b=>b.textContent),
        title: document.getElementById('more-flyout-title').textContent,
        note: document.getElementById('more-flyout-note').textContent,
        on: [...document.querySelectorAll('#settings-tree .more-parent.on strong')].map(b=>b.textContent),
      };
    })()`), { shown: ['推送通知', '外网穿透', '消息桥接'], title: '连接与通知', note: '3 项', on: ['连接与通知'] },
      '悬停一级那一行，二级那一列换成它的一组');
    await page.evaluate(`document.querySelector('#settings-tree .more-parent[data-more-group="featured"]')
      .dispatchEvent(new PointerEvent('pointerenter'))`);
    assert.ok(await page.evaluate(`(() => {
      const rail = document.querySelector('#more-panel .more-rail').getBoundingClientRect();
      return ['air-lid-sleep','air-auto-unlock'].every(id => {
        const row = document.getElementById(id), box = row.getBoundingClientRect();
        return row.checkVisibility() && box.width > 240 && box.right <= rail.right + 1 && box.height >= 48 &&
          getComputedStyle(row.querySelector('strong')).fontSize === '14px' &&
          getComputedStyle(row.querySelector('small')).whiteSpace === 'normal';
      });
    })()`), 'both power switches are readable full-width rows');
    assert.equal(await page.evaluate(`Math.round(document.getElementById('more-panel').getBoundingClientRect().left)`), 0);
    t.diagnostic('more desktop: ' + await page.screenshot('more-desktop'));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true });
    await settle(page);
    assert.ok(await page.evaluate(`(() => {
      const panel = document.getElementById('more-panel'), scroll = panel.querySelector('.more-scroll');
      return panel.getBoundingClientRect().right <= innerWidth && scroll.scrollWidth <= scroll.clientWidth + 1 &&
        ['air-lid-sleep', 'air-auto-unlock'].every(id => document.getElementById(id).getBoundingClientRect().height >= 48);
    })()`), 'phone drawer scrolls vertically without horizontal clipping');
    // 窄屏没有右边那一列：二级那几组被搬回各自父行下面就地折着，点父行展开/收起。
    // 关键是「搬」而不是另画一份 —— 所以断言的是同一个 #more-group-* 换了父节点。
    assert.deepEqual(await page.evaluate(`(() => {
      const parents = [...document.querySelectorAll('#settings-tree .more-parent')];
      return {
        flyout: document.getElementById('more-flyout').checkVisibility(),
        hosts: parents.map(row => document.getElementById('more-group-' + row.dataset.moreGroup).previousElementSibling === row),
        open: parents.filter(row => row.getAttribute('aria-expanded') === 'true').map(row => row.dataset.moreGroup),
        leaves: document.querySelectorAll('#more-panel .more-leaf-group .more-leaf').length,
      };
    })()`), { flyout: false, hosts: [true, true, true, true], open: ['featured'], leaves: 16 },
      '窄屏把二级整组搬进抽屉就地折叠，十六行面板一个不少');
    await page.evaluate(`document.querySelector('#settings-tree .more-parent[data-more-group="featured"]').click()`);
    await settle(page);
    assert.ok(await page.evaluate(`(() => {
      const group = document.getElementById('more-group-featured');
      return !group.checkVisibility() &&
        document.querySelector('#settings-tree .more-parent[data-more-group="featured"]').getAttribute('aria-expanded') === 'false';
    })()`), '再点一次收起这一组');
    await page.evaluate(`document.querySelector('#settings-tree .more-parent[data-more-group="ai"]').click()`);
    await settle(page);
    assert.ok(await page.evaluate(`document.getElementById('more-group-ai').checkVisibility()`), '折叠模式下换一组只开它自己');
    t.diagnostic('more mobile: ' + await page.screenshot('more-mobile'));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`document.getElementById('air-lid-sleep').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-lid-sleep').classList.contains('on')`));
    assert.deepEqual(powerPosts.map(raw => JSON.parse(raw)), [{ enabled: true }]);
    assert.ok(await page.waitFor(`document.getElementById('more-status').textContent === '已开启关盖保持运行'`), 'feedback is visible inside the drawer');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.ok(await page.waitFor(`!document.getElementById('more-panel').open`), 'Escape closes the drawer');
    assert.equal(await page.evaluate(`document.getElementById('side-more').getAttribute('aria-expanded')`), 'false');
    assert.deepEqual(await page.evaluate(`({url: location.href, task: document.getElementById('task-title').textContent})`), moreBefore);
    await page.evaluate(`document.getElementById('side-more').click()`);
    await settle(page);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1200, y: 200, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1200, y: 200, button: 'left', clickCount: 1 });
    assert.ok(await page.waitFor(`!document.getElementById('more-panel').open`), 'backdrop closes the drawer');
    // More 抽屉是 top layer 上的模态框，控制台则是主区域里的一页正文。侧栏那行点下去，
    // 抽屉自己让开（air-more.js 在 [data-air-view] / #overview 上挂了「点它就关」），
    // 两者不会叠在一起 —— 从前要显式踢走控制台，现在没有这回事了。
    const before = await page.evaluate(`(() => {
      const clock = document.createElement('span');
      clock.id = 'keep-alive-marker';
      document.getElementById('task-header').append(clock);
      return { url: location.href, title: document.getElementById('task-title').textContent };
    })()`);
    await page.evaluate(`document.getElementById('side-more').click(); document.getElementById('overview').click()`);
    assert.equal(await page.evaluate(`document.getElementById('more-panel').open`), false, 'More 不会和控制台叠着');
    assert.ok(await consoleShown(page), '侧栏那行把控制台开在主区域里');

    // ── 控制台：主区域里的一页，地址写 view=overview ─────────────────────
    // 一页就是「地址说得清、刷新回得来、后退回得去」：点它不是叠一层浮层，而是换地址。
    // 当前任务只是被藏起来（#task-layout 打 hidden），DOM 一点没动 —— 回到任务页还是
    // 同一个任务、同一段草稿。
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('view')`), 'overview', '进控制台改的是地址，不是叠一层');
    assert.equal(await page.evaluate(`document.getElementById('keep-alive-marker')!==null`), true, '当前任务的 DOM 没有重建');
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent`), '控制台', '页头换成这一页自己的标题');
    assert.equal(await page.evaluate(`document.getElementById('task-breadcrumb').textContent`), 'MultiCC Air › 控制台');
    assert.equal(await page.evaluate(`document.getElementById('overview').classList.contains('active')`), true, '侧栏那行自己亮着');
    // 一页只站一块正文：控制台那一块在，别的正文都不在。
    assert.deepEqual(await page.evaluate(`['console-center','admin-center','directory-library','schedule-center','task-layout']
      .map(id => id + ':' + document.getElementById(id).hidden)`),
      ['console-center:false', 'admin-center:true', 'directory-library:true', 'schedule-center:true', 'task-layout:true'],
      '控制台站着的时候，别的正文都让开');
    // 侧栏那份「手上的任务」照旧留着 —— 目录首页有它，这一页也该有。
    assert.equal(await page.evaluate(`document.getElementById('task-sidebar').hidden`), false, '控制台这一页留住侧栏的任务带');
    // 从前那个浮层不许回来：没有面板、没有遮罩、地址里也没有它的开关。
    assert.equal(await page.evaluate(`document.getElementById('console-panel')===null && document.getElementById('console-scrim')===null`), true,
      '控制台不再是从左边滑出来的那一层');
    assert.equal(await page.evaluate(`document.body.classList.contains('console-open')`), false);
    // 顶上四格是过滤项；默认一张清单都不展开。
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.console-filter-tabs .admin-stat > span')].map(el=>el.textContent)`),
      ['进行中', '等我回复', '异常', '今日完成', '全部']);
    assert.equal(await page.evaluate(`document.getElementById('console-filter-panel').hidden`), true, '默认不展开任何清单');
    assert.ok(await page.evaluate(`document.querySelector('.console-overview-meta').textContent.includes('3 个工作目录')`), '目录数降成小字');
    // 点「等我回复」：清单在过滤项和工作目录之间长出来。
    await page.evaluate(`document.querySelector('.console-filter-tabs .admin-stat[data-view="waiting"]').click()`);
    assert.equal(await page.evaluate(`document.getElementById('console-filter-panel').hidden`), false);
    assert.ok(await page.evaluate(`document.querySelector('#console-filter-panel .admin-recent-row').innerText.includes('结算页')`), '等待回答的排在最前');
    assert.ok(await page.evaluate(`document.querySelector('#console-filter-panel .admin-recent-row .mc-status-label').textContent==='等待回答'`), '待办行自报状态');
    assert.equal(await page.evaluate(`document.getElementById('console-task-search').closest('.admin-task-controls').hidden`), true, '只有「全部」才带搜索筛选');
    assert.deepEqual(await page.evaluate(`[...document.getElementById('console-content').children].map(node =>
      node.classList.contains('admin-stats') ? 'stats'
        : node.classList.contains('console-overview-meta') ? 'meta'
        : node.id==='console-filter-panel' ? 'filter-list'
          : node.classList.contains('admin-directory-panel') ? 'directories'
            : node.id==='console-ai-assistant' ? 'ai-assistant' : 'tools')`),
      ['stats', 'meta', 'filter-list', 'directories', 'ai-assistant', 'tools'], '控制台分区顺序：过滤项 → 小字计数 → 展开的清单 → 工作目录 → AI Assistant → 工具');
    // 再点同一格收起。
    await page.evaluate(`document.querySelector('.console-filter-tabs .admin-stat[data-view="waiting"]').click()`);
    assert.equal(await page.evaluate(`document.getElementById('console-filter-panel').hidden`), true, '再点同一格收起');
    assert.equal(await page.evaluate(`document.getElementById('console-ai-assistant').innerText.includes('分类、摘要与意图判断')`), true,
      'AI Assistant 配置不再藏在底部工具格');
    await page.screenshot('01-console-open');

    // Escape 关不掉一页：它本来就没有「关掉」这回事，页面的退路是地址（后退 / 侧栏
    // 另一行 / 从清单里点走一条任务）。快捷键链路里也没有它的那一档了。
    await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
    assert.equal(await consoleShown(page), true, 'Escape 关不掉控制台（它是一页，不是一层浮层）');
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('view')`), 'overview', 'Escape 也不动地址');
    // 后退是这一页的正经退路：回到刚才那个任务，地址、标题、DOM 都原样。
    await page.evaluate(`history.back()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='收口 Air 的控制台'`), '后退离开控制台');
    assert.equal(await page.evaluate(`location.href`), before.url, '后退回到原处，地址一模一样');
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent`), before.title);
    assert.ok(await consoleHidden(page));
    assert.equal(await page.evaluate(`document.getElementById('keep-alive-marker')!==null`), true);

    // Retired planner bookmarks also work before the server is restarted:
    // these fixture routes serve the HTML directly, without HTTP redirects.
    await page.navigate('/air?view=planner&dir=d2');
    assert.ok(await consoleShown(page));
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('view')`), 'overview');
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('dir')`), 'd2');
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent`), '控制台');
    assert.equal(await page.evaluate(`document.querySelectorAll('.air-legacy-frame, #directory-open-planner, a[href*="view=planner"]').length`), 0);
    assert.equal(await page.evaluate(`window.MultiCCAirAdmin.modes.has('planner')`), false);
    // 离开这一页 = 走另一页：控制台页头那颗「浏览工作目录」把地址换成目录库的
    // （view=directories），当前目录不丢。从前是「关掉浮层把 view=overview 撤掉」
    // —— 现在换页本来就有地址。
    await page.evaluate(`document.getElementById('admin-actions').querySelector('button').click()`);
    assert.ok(await page.waitFor(`document.getElementById('directory-library').hidden===false`));
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('view')`), 'directories');
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('dir')`), 'd2', '换页不丢当前目录');
    assert.ok(await consoleHidden(page));
    // Old entries in the browser history receive the same migration.
    await page.evaluate(`history.pushState({}, '', '/air?view=planner&dir=d1'); dispatchEvent(new PopStateEvent('popstate'))`);
    assert.ok(await consoleShown(page));
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('view')`), 'overview');
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent`), '控制台');

    // /manage 那条老入口照旧可用：落在控制台那一页上，地址就是它自己的地址
    await page.navigate('/air?view=overview');
    assert.ok(await consoleShown(page));
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('view')`), 'overview', 'view=overview 是这一页的正式地址');
    assert.equal(await page.evaluate(`location.search.includes('task=')`), false, '这一页不是某个任务的任务页');
    await page.navigate('/air?dir=d1&task=tsk_here');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='收口 Air 的控制台'`));

    // ── 控制台：「全部任务」跨所有目录，筛选和搜索在这里 ─────────────────
    await page.evaluate(`document.getElementById('overview').click()`);
    assert.ok(await page.waitFor(`document.getElementById('console-center').hidden===false`));
    await page.evaluate(`document.querySelector('.console-filter-tabs .admin-stat[data-view="all"]').click()`);
    const allTitles = `[...document.querySelectorAll('#console-task-list .admin-recent-row strong')].map(el=>el.textContent)`;
    // 默认只看「进行中与待处理」：done 的那条不在里面，但另外三个目录的三条都在
    // —— 控制台不按当前目录收窄，这是它跟侧栏那条带子的分工。
    assert.deepEqual((await page.evaluate(allTitles)).sort(), ['收口 Air 的控制台', '登录页空状态文案', '结算页金额四舍五入错误']);
    assert.equal(await page.evaluate(`document.getElementById('console-task-note').textContent`), '3 条');
    await page.evaluate(`(() => { const s=document.getElementById('console-task-status'); s.value='all'; s.dispatchEvent(new Event('change')); })()`);
    assert.deepEqual((await page.evaluate(allTitles)).sort(), ['导出失败重试', '收口 Air 的控制台', '登录页空状态文案', '结算页金额四舍五入错误'], '全部记录把已完成也算上');
    await page.evaluate(`(() => { const s=document.getElementById('console-task-dir'); s.value='d3'; s.dispatchEvent(new Event('change')); })()`);
    assert.deepEqual((await page.evaluate(allTitles)).sort(), ['导出失败重试', '登录页空状态文案'], '按目录收窄');
    // 先聚焦再打字：这样后面那条断言才是在问「打字会不会把焦点打掉」，而不是
    // 「一个从没被聚焦过的输入框有没有焦点」。
    await page.evaluate(`(() => { const i=document.getElementById('console-task-search'); i.focus(); i.value='空状态'; i.dispatchEvent(new Event('input')); })()`);
    assert.deepEqual(await page.evaluate(allTitles), ['登录页空状态文案'], '按标题搜索');
    // 只重画列表才留得住焦点：整块 replaceChildren 的话，第一个字打进去输入框就没了。
    assert.equal(await page.evaluate(`document.activeElement===document.getElementById('console-task-search')`), true, '重画列表不夺走搜索框焦点');
    assert.equal(await page.evaluate(`document.querySelectorAll('#console-task-list .admin-recent-row').length`), 1);
    assert.deepEqual(await page.evaluate(`(() => { const s=getComputedStyle(document.getElementById('console-task-list')); return [s.overflowY,s.maxHeight]; })()`),
      ['auto', '350px'], '全部任务列表有固定上限并在内部滚动');

    // ── 彩虹圈：运行中的任务，和任务对应的目录 ───────────────────────────
    // 圈只有一份定义（status-presentation.js 只给 running 设了 spinner），所以它
    // 在哪儿出现、在哪儿不出现，永远同步；等待中和出错的任务绝不闪。
    const ringed = await page.evaluate(`[...document.querySelectorAll('#console-task-list .admin-recent-row.ring-running')].map(el=>el.innerText.replace(/\\s+/g,''))`);
    assert.equal(ringed.length, 1, JSON.stringify(ringed));
    assert.ok(ringed[0].includes('登录页空状态文案'), '在跑的那条任务带圈');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.admin-directory-row.ring-running')].map(el=>el.querySelector('strong').textContent)`), ['Gapasea'], '任务对应的目录也带圈');
    await page.screenshot('02-console-all-tasks');
    await page.evaluate(`document.querySelector('.console-filter-tabs .admin-stat[data-view="waiting"]').click()`);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#console-task-list .admin-recent-row strong')].map(el=>el.textContent)`),
      ['结算页金额四舍五入错误'], '「等我回复」只留要我动手的那条，在跑的不进来');
    assert.equal(await page.evaluate(`document.querySelector('#console-task-list .admin-recent-row.ring-running')!==null`), false,
      '「等我回复」里不该出现正在执行的任务');
    await page.evaluate(`document.querySelector('.console-filter-tabs .admin-stat[data-view="running"]').click()`);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#console-task-list .admin-recent-row strong')].map(el=>el.textContent)`),
      ['登录页空状态文案'], '「进行中」只列在跑的');
    await page.evaluate(`document.querySelector('.console-filter-tabs .admin-stat[data-view="all"]').click()`);

    // 从清单里点走一条在跑的任务：这一页让开、落到那个任务所属的目录，而且落到哪儿
    // 都得看得见「它在跑」—— 页头状态行、侧栏的任务行、当前目录卡片三处同时亮。
    await page.evaluate(`(() => { const s=document.getElementById('console-task-dir'); s.value='all'; s.dispatchEvent(new Event('change')); })()`);
    await page.evaluate(`(() => { const i=document.getElementById('console-task-search'); i.value=''; i.dispatchEvent(new Event('input')); })()`);
    await page.evaluate(`[...document.querySelectorAll('#console-task-list .admin-recent-row')].find(r=>r.innerText.includes('登录页空状态文案')).click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='登录页空状态文案'`));
    assert.ok(await consoleHidden(page), '点走一条就离开控制台那一页');
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('view')`), null, '落回任务页，地址里不再有 view');
    assert.equal(await page.evaluate(`document.getElementById('directory-name').textContent`), 'Gapasea', '落到了任务所属的目录');
    assert.ok(await page.waitFor(`document.getElementById('task-state').classList.contains('ring-running')`), '页头状态行带圈');
    assert.equal(await page.evaluate(`document.querySelector('#tasks button.ring-running .task-dir').textContent`), 'Gapasea', '侧栏里在跑的那条也带圈');
    assert.equal(await page.evaluate(`document.querySelector('.space-card').classList.contains('ring-running')`), true, '当前目录卡片带圈');
    assert.equal(await page.evaluate(`document.querySelector('#tasks button.ring-running .mc-status-label').textContent`), '执行中');
    // 页头那行状态是个 22px 高的小胶囊，圈画在上面本来就容易撞：它自己还有一枚
    // ::after 的「 ›」（「这里能点」的提示）。圈因此走 ::before —— 箭头得原地不动。
    assert.ok((await page.evaluate(`getComputedStyle(document.getElementById('task-state'),'::after').content`)).includes('›'),
      '状态行的「 ›」还在（圈改到 ::before 之后没把它顶掉）');
    await page.screenshot('06-ring-task-state');
    await assertRingDrawn(page, '#task-state', '页头状态行');
    await assertRingDrawn(page, '.space-card', '当前目录卡片（任务视图）');
    await assertRingDrawn(page, '#tasks button.ring-running', '侧栏里在跑的那条任务行');
    // 目录库那一页也认同一个圈。这一页的动作骑在页头工具栏上（一页只有一个标题带），
    // 所以「浏览工作目录」是 #admin-actions 里的第一颗 —— 从前它是面板正文里那排。
    await page.evaluate(`document.getElementById('overview').click()`);
    assert.ok(await page.waitFor(`document.getElementById('console-center').hidden===false`));
    assert.equal(await page.evaluate(`document.getElementById('console-secrets').hidden`), false, '敏感信息跟着这一页的工具栏走');
    await page.evaluate(`document.getElementById('admin-actions').querySelector('button').click()`);
    assert.ok(await page.waitFor(`document.getElementById('directory-library').hidden===false`));
    assert.equal(await page.evaluate(`document.querySelectorAll('#directory-grid button.ring-running').length`), 1, '只有跑着活的目录带圈');
    assert.equal(await page.evaluate(`document.querySelector('#directory-grid button.ring-running strong').textContent`), '▣ Gapasea', '带圈的是那个目录');
    // 目录库里也不再有「已收藏」那截尾巴（存储里那条 d1 收藏在上面刻意留着）。
    assert.equal(await page.evaluate(`[...document.querySelectorAll('#directory-grid button small')].some(el=>el.textContent.includes('已收藏'))`), false,
      '目录库不再给收藏过的目录打「已收藏」');

    // ── 「只有半边」的那个圈：目录视图 ───────────────────────────────────
    // 地址里不带 &task= 时 air.js 会给 #library（就是 .space-main）挂 .active，
    // 底色是不透明的 #eff6ff，正好贴在卡片 padding 边上。圈当年画在 card 自己身上，
    // 于是上/左/右三条边被它整条盖掉，只剩下面一条 —— 用户看到的「有时候是好的，
    // 有时候只有半边」：同一个页面，点进任务就正常，回到目录视图（或鼠标停在卡片
    // 上，.space-main:hover 是同一套底色）就缺三条边。圈现在画在 ::before 覆盖层上，
    // 是卡片自己的子元素，永远在所有后代之上。这条断言就是那次修复的守卫。
    await page.navigate('/air?dir=d3');
    assert.ok(await page.waitFor(`document.querySelector('.space-card.ring-running')!==null`));
    await page.screenshot('07-ring-directory');
    const cover = await page.evaluate(`(() => { const lib = document.getElementById('library');
      return { active: lib.classList.contains('active'), bg: getComputedStyle(lib).backgroundColor }; })()`);
    // 前提：当年盖住圈的那个不透明后代还在。它哪天不在了，这组断言就复现不出当时的
    // 场景 —— 那时该另找一个能盖住圈的后代来守着，而不是把这条删掉。
    assert.equal(cover.active, true, '目录视图里 #library 带 .active（当年盖住圈的就是它）');
    assert.equal(cover.bg, 'rgb(239, 246, 255)', '它还是不透明的');
    await assertRingDrawn(page, '.space-card', '当前目录卡片（目录视图）');
    // 圈的颜色是「按 id 挑」而不是「每次随机」：整页重来一遍，同一张卡片还得是同一
    // 个色。列表本来每 15 秒就随快照重画一次，随机会让同一行一直在换颜色。
    const tintOf = () => page.evaluate(`getComputedStyle(document.querySelector('.space-card')).getPropertyValue('--ring-tint').trim()`);
    const firstTint = await tintOf();
    assert.match(firstTint, /^#[0-9a-f]{6}$/i, `圈的 --ring-tint 该是调色板里的颜色，实际是 ${JSON.stringify(firstTint)}`);
    await page.navigate('/air?dir=d3');
    assert.ok(await page.waitFor(`document.querySelector('.space-card.ring-running')!==null`));
    assert.equal(await tintOf(), firstTint, '同一个目录重画之后应该还是同一个颜色');
    // 圈对任何人都已经不动了（air.css 那段有原因：软件光栅下「一直有东西在动」就是
    // 合成器永远不 idle）。所以这里不再有「静音版」这一说 —— 换到 reduced-motion
    // 偏好，看到的还是同一个圈、同一个颜色，四条边照样要画出来：晕动症用户不该
    // 因此丢掉「这条在跑」。顺带把「圈上不许挂动画」钉在这里，动画回到圈上不该
    // 只靠肉眼在用户机器上发现。
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.space-card'),'::before').animationName`), 'none',
      '圈是静态描边：prefers-reduced-motion 下当然还是不动');
    await page.screenshot('08-ring-directory-reduced-motion');
    await assertRingDrawn(page, '.space-card', '当前目录卡片（目录视图 · 关掉动画）');
    await page.send('Emulation.setEmulatedMedia', { features: [] });

    await page.navigate('/air?dir=d1&task=tsk_here');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='收口 Air 的控制台'`));

    // ── ⌘K：目录和任务一起搜 ─────────────────────────────────────────────
    await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true}))`);
    assert.ok(await page.waitFor(`document.getElementById('palette').hidden===false`));
    await page.evaluate(`(() => { const i=document.getElementById('palette-input'); i.value='结算'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    const hits = await page.evaluate(`[...document.querySelectorAll('#palette-results button')].map(el=>el.innerText.replace(/\\n/g,' · '))`);
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.ok(hits[0].includes('结算页金额四舍五入错误') && hits[0].includes('North · 商城'), '命中任务时一并说清它在哪个目录');
    assert.ok(await page.evaluate(`document.getElementById('palette-note').textContent.includes('0 个目录 · 1 个任务')`));
    await page.screenshot('03-palette-task');
    await page.evaluate(`(() => { const i=document.getElementById('palette-input'); i.value='storefront'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    const dirHits = await page.evaluate(`[...document.querySelectorAll('#palette-results button')].map(el=>el.innerText.replace(/\\n/g,' · '))`);
    assert.ok(dirHits[0].includes('North · 商城') && dirHits[0].includes('/projects/storefront'), '同一个入口也能按路径搜目录');
    // 清空输入回到「目录在前、任务在后」的完整列表：↑↓ 换的是选择，Enter 进的是选中的那一个。
    await page.evaluate(`(() => { const i=document.getElementById('palette-input'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    assert.equal(await page.evaluate(`document.querySelectorAll('#palette-results button').length`), 7, '3 个目录 + 4 个任务，一个列表');
    assert.equal(await page.evaluate(`document.querySelectorAll('#palette-results button')[0].classList.contains('active')`), true);
    await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown'}))`);
    assert.equal(await page.evaluate(`document.querySelectorAll('#palette-results button')[1].classList.contains('active')`), true, '↑↓ 换选择');
    await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp'}))`);
    await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown'}))`);
    await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))`);
    assert.ok(await page.waitFor(`document.getElementById('palette').hidden===true`));
    assert.ok(await page.waitFor(`document.getElementById('directory-name').textContent==='North · 商城'`), 'Enter 进的是高亮的那一项');
    assert.equal(await page.evaluate(`location.search.includes('dir=d2')`), true, '选目录不写 view，只写它自己');

    // ⌘K 是压在所有页面上的一层检索浮层，不是「控制台的开关」：从控制台那一页叫出来
    // 的时候，底下的页面不许被换掉 —— 地址里仍写着 view=overview，Esc 收掉浮层就
    // 还在原来那一页上。从前它会顺手把控制台顶掉，因为那一层和它叠在一起。
    await page.navigate('/air?view=overview');
    assert.ok(await page.waitFor(`document.getElementById('console-center').hidden===false`));
    await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true}))`);
    assert.ok(await page.waitFor(`document.getElementById('palette').hidden===false`));
    assert.equal(await page.evaluate(`document.getElementById('console-center').hidden`), false, '⌘K 不换掉底下的页面');
    assert.equal(await page.evaluate(`location.search.includes('view=overview')`), true, '底下的页面还在，地址就还得是它的');
    await page.evaluate(`dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
    assert.ok(await page.waitFor(`document.getElementById('palette').hidden===true`));
    assert.equal(await page.evaluate(`location.search.includes('view=overview')`), true, '收掉浮层，控制台那一页原样还在');

    // ── 窄屏 ─────────────────────────────────────────────────────────────
    // 控制台是一页正文，窄屏上它和其他页走同一档内边距，横向不许溢出。
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.evaluate(`document.getElementById('overview').click()`);
    assert.ok(await page.waitFor(`document.getElementById('console-center').hidden===false`));
    const mobile = await page.evaluate(`(() => { const box=document.getElementById('console-center');
      return { right: Math.round(box.getBoundingClientRect().right), width: Math.round(box.getBoundingClientRect().width), innerWidth }; })()`);
    assert.ok(mobile.right <= mobile.innerWidth + 1, JSON.stringify(mobile));
    assert.equal(await page.evaluate(`document.getElementById('console-center').scrollWidth<=document.getElementById('console-center').clientWidth+1`), true, '正文不横向溢出');
    assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
    await page.screenshot('04-mobile-console');
    // 换一页（窄屏下侧栏是抽屉，走地址最稳）之后仍然不横向溢出。
    await page.navigate('/air?dir=d1&task=tsk_here');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='收口 Air 的控制台'`));
    assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
    await page.screenshot('05-mobile-sidebar');
  });

  console.log('截图目录: ' + shots);
});

test('the directory task list keeps its filters, fills the remaining height and paginates, and deletes in place', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: {
      'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html',
    } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url` };
  const directories = [{ id: 'd1', name: 'MultiCC', path: '/projects/multicc' }];
  let tasks = [
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `t${i + 1}`, dirId: 'd1', title: `目录任务 ${i + 1}`, status: 'active', runState: 'idle',
      updatedAt: 1000 + i, lastMessageAt: 3000 - i, resource: { residency: 'planned', lease: 'idle' },
    })),
    { id: 'archived', dirId: 'd1', title: '已经归档', status: 'archived', runState: null,
      updatedAt: 500, resource: { residency: 'retained', lease: 'idle' } },
  ];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex'], migration: { errors: [] }, tasks, sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  const deletes = [];
  routes['DELETE /api/task-board/tasks/t12'] = () => {
    deletes.push('t12'); tasks = tasks.filter(task => task.id !== 't12');
    return json({ ok: true, deleted: true });
  };

  await withCdpHarness({ routes }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1');
    // 默认那一档（进行中与待处理）下，12 条全在清单里 —— 不再只画「最近 10 条」，
    // 也不等谁点开一个「查看全部」。
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===12`));
    await page.evaluate(`localStorage.setItem('air:task-visited-at', JSON.stringify({t8:9000,t3:8000}))`);
    await page.navigate('/air?dir=d1');
    assert.equal(await page.evaluate(`document.querySelector('#directory-task-list strong').textContent`), '目录任务 1', '默认按最后消息，而不是 updatedAt');
    assert.equal(await page.evaluate(`document.querySelector('#directory-task-sort [data-sort="message"]').getAttribute('aria-pressed')`), 'true');
    await page.evaluate(`document.querySelector('#directory-task-sort [data-sort="visit"]').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#directory-task-list strong').textContent`), '目录任务 8', '可切到本机最后访问时间');
    assert.equal(await page.evaluate(`document.querySelector('#directory-task-sort [data-sort="visit"]').getAttribute('aria-pressed')`), 'true');
    // 清单不再有「最近几条 ↔ 全部」两态：它就是全部任务，筛选一直摆着，翻页在
    // 列表下面（air-task-pager.js）。这一页仍然停在目录首页，不进控制台
    // （控制台从浮层变成了一页，进出都走 setMode，可见性落在 #console-center[hidden]）。
    assert.equal(await page.evaluate(`document.getElementById('console-center').hidden`), true, 'all tasks stays on the directory page');
    assert.equal(await page.evaluate(`document.getElementById('directory-task-heading').textContent`), '全部任务');
    assert.equal(await page.evaluate(`document.getElementById('directory-task-controls').hidden`), false);
    assert.deepEqual(await page.evaluate(`(() => { const l=document.getElementById('directory-task-list'),s=getComputedStyle(l);
      return [document.querySelectorAll('#directory-task-list .directory-task-row').length,s.overflowY]; })()`),
      [12, 'auto'], 'default filter shows open rows in a scroller of its own');
    // 12 条还装得下一页（一页 20），分页条根本不该露面。
    assert.equal(await page.evaluate(`document.getElementById('directory-task-pager').hidden`), true, '一页装得下就不摆分页条');
    // 清单吃的是面板剩下的高度：它的下沿就贴着面板的内容底边，既不被行数撑长，
    // 也不在下面留一块空白。
    const band = await page.evaluate(`(() => {
      const panel = document.querySelector('.directory-task-panel'), list = document.getElementById('directory-task-list');
      const p = panel.getBoundingClientRect(), l = list.getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(panel).paddingBottom) || 0;
      return { h: Math.round(l.height), gap: Math.round(p.bottom - pad - l.bottom), panelH: Math.round(p.height) }; })()`);
    assert.ok(band.h > 0 && Math.abs(band.gap) <= 1, `清单铺满面板剩余高度：${JSON.stringify(band)}`);

    // 这 12 条都是观察型记录（没有 recordType，也没有阶段），徽标说「空闲」—— 行上
    // 那行小字不许再写一遍「进行中」：那是生命周期（active）的翻法，跟徽标说的不是
    // 一回事。以前这里每一行都挂着「进行中」，跟徽标正说着反话（侧栏那个「满屏
    // 进行中」的 bug 同源）。
    assert.deepEqual(
      await page.evaluate(`[...document.querySelectorAll('#directory-task-list .directory-task-row')].map(row => row.querySelector('.task-note')?.textContent || '')`),
      Array.from({ length: 12 }, () => ''),
      '空闲的观察型记录行上没有第二层信息可以说',
    );

    await page.evaluate(`(() => { const i=document.getElementById('directory-task-search');i.value='12';i.dispatchEvent(new Event('input')); })()`);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#directory-task-list strong')].map(e=>e.textContent)`), ['目录任务 12']);
    // 筛剩一条时清单**不缩**：面板那一段高度是固定的（抬头 / 筛选 / 分页三段钉住），
    // 剩下一行的空间就空在清单下面；行自己保持自己的高度，不被网格按行等分撑成一整片
    // 半屏高的空卡（align-content: start）。一页装得下时分页条还会收起，那 50 来像素
    // 也归清单 —— 只会变大，不会缩回内容高。
    const squeezed = await page.evaluate(`(() => {
      const list = document.getElementById('directory-task-list');
      const row = list.querySelector('.directory-task-row');
      const l = list.getBoundingClientRect(), r = row.getBoundingClientRect();
      return { listHeight: Math.round(l.height), rowHeight: Math.round(r.height),
               offset: Math.round(r.top - l.top), pagerHidden: document.getElementById('directory-task-pager').hidden }; })()`);
    assert.ok(squeezed.listHeight >= band.h, `筛剩一条时清单只会变更大：${JSON.stringify({ squeezed, band })}`);
    assert.ok(squeezed.rowHeight < 100, `行保持自己的高度，不被拉长：${JSON.stringify(squeezed)}`);
    assert.ok(squeezed.offset >= 0 && squeezed.offset < 2, `行贴着清单顶部排：${JSON.stringify(squeezed)}`);
    await page.evaluate(`window.confirm=()=>true;document.querySelector('#directory-task-list .task-delete').click()`);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.includes('任务已删除')`));
    assert.deepEqual(deletes, ['t12']);
    assert.equal(await page.evaluate(`document.getElementById('directory-task-heading').textContent`), '全部任务', 'delete keeps the panel expanded');

    await page.evaluate(`(() => { const i=document.getElementById('directory-task-search');i.value='';i.dispatchEvent(new Event('input'));
      const s=document.getElementById('directory-task-status');s.value='archived';s.dispatchEvent(new Event('change')); })()`);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#directory-task-list strong')].map(e=>e.textContent)`), ['已经归档']);
    // 状态过滤是这副清单的常态，抬头不会跟着变回「最近任务」—— 那个两态的开关
    // 已经被分页替掉了。
  });
});

// 控制台的第一格是「谁在等我」，它一长就把下面整片推走。这里用一个 6 条待办的
// 现场确认三件事：面板里只画最近更新的 5 条、总数照报、完整清单在它自己的页上（而那一页
// 是个能直接打开、能返回、地址里留得住的真页面）。顺带把「统计读数带压扁了」钉住 ——
// 它是这次「留更多空间给任务」的兑现方式，光看截图不算数。
test('the console shows only the 5 most recently updated waits and hands the rest to their own page', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-air-attention-qa');
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

  const directories = [
    { id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' },
    { id: 'd2', name: 'North · 商城', path: '/projects/storefront' },
  ];
  const configuration = { cli: 'codex', provider: 'codex-lab', providerName: 'Lab Responses', providerSelection: null,
    model: 'gpt-5.5', effectiveModel: 'gpt-5.5', effort: 'medium' };
    const task = (id, dirId, title, status, runState, updatedAt, resource) => ({ id, dirId, title, recordType: 'planned', workflowStage: 'doing',
    status, runState, updatedAt, resource: resource || { residency: 'planned', lease: 'idle' }, configuration });
  const live = { residency: 'materialized', lease: 'running' };
  // 今天刚跑完的一条（时间取「此刻」才落在今天），和上面那条很久以前完成的 done1 对照。
  const justNow = Date.now();
  // 现场里「要我动手的」6 条（e1 w1 e2 w2 e3 w3），另外三条不是：最新的一条是在跑
  // 的任务（r1），还有一条也在跑（r2）、一条已完成（done1）。时间顺序和紧急度顺序
  // **故意不一致**：最新的是 r1（不该进清单），而最久没动的 w3 是一条等回答的任务。
  // 按时间留下的 5 条是 e1 w1 e2 w2 e3，落选 w3；「按紧急度先分层」这条旧规则一旦
  // 回来，前 5 条会变成 w1 w2 w3 e1 e2，而 r1 还会挤进第一行 —— 断言当场失败。
  // 这就是这份夹具存在的意义。
  const airTasks = [
    task('r1', 'd1', '在跑：登录页空状态', 'active', 'running', 990, live),
    task('e1', 'd1', '出错：导出失败重试', 'active', 'error', 850, null),
    task('w1', 'd1', '等回答：发布口径', 'active', 'waiting', 800, null),
    task('e2', 'd2', '出错：兼容矩阵', 'active', 'error', 750, null),
    task('w2', 'd2', '等回答：结算页文案', 'active', 'waiting', 700, null),
    task('e3', 'd1', '出错：图谱回填', 'active', 'error', 650, null),
    task('w3', 'd2', '等回答：目录巡检', 'active', 'waiting', 100, null),
    task('r2', 'd2', '在跑：投放日报', 'active', 'running', 90, live),
    task('done1', 'd1', '已完成：收口控制台', 'done', 'succeeded', 50, null),
    task('ok1', 'd2', '今天跑完：图标换新', 'active', 'succeeded', justNow, null),
  ];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex'], migration: { errors: [] }, tasks: airTasks, sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  for (const entry of airTasks) {
    routes[`/api/air/tasks/${entry.id}`] = routes[`/api/task-shell-tasks/${entry.id}`] = () => json({ ok: true,
      task: entry, sessionId: `task-${entry.id}`, ownerShellId: 'shell-a', readOnly: false,
      execution: { busy: false, status: 'idle' }, resource: entry.resource, attribution: {},
      roleBindings: { version: 0, bindings: [] }, messages: [] });
    routes[`POST /api/task-board/tasks/${entry.id}/chat-session`] = () => json({ ok: true, sessionId: `task-${entry.id}` });
  }
  routes['POST /api/task-shells'] = () => json({ id: 'shell-a' });

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1&task=w1');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='等回答：发布口径'`));

    // ── ① 四格过滤项：数字放大，但整条带仍是读数带的高度 ────────────────
    await page.evaluate(`document.getElementById('overview').click()`);
    assert.ok(await page.waitFor(`document.getElementById('console-center').hidden===false`));
    assert.ok(await page.waitFor(`document.querySelectorAll('.admin-stats .admin-stat').length===5`));
    const stats = await page.evaluate(`(() => {
      const card = document.querySelector('.admin-stat');
      return { height: Math.round(card.getBoundingClientRect().height),
        fontSize: parseFloat(getComputedStyle(card.querySelector('strong')).fontSize),
        values: [...document.querySelectorAll('.admin-stats .admin-stat strong')].map(el=>el.textContent) };
    })()`);
    assert.ok(stats.height <= 84, `统计卡仍压在 84px 以内（实测 ${stats.height}）`);
    assert.ok(stats.fontSize >= 22, `过滤项的数字要大字（实测 ${stats.fontSize}）`);
    assert.deepEqual(stats.values, ['2', '3', '3', '1', '9'], '进行中 2 · 等我回复 3 · 异常 3 · 今日完成 1 · 全部（未归档）9');
    assert.equal(await page.evaluate(`document.getElementById('console-filter-panel').hidden`), true, '默认不展开清单');

    // ── ② 每格展开自己的清单，口径与数字同源，按最近更新排 ─────────────────
    const listed = `[...document.querySelectorAll('#console-task-list .admin-recent-row strong')].map(el=>el.textContent)`;
    await page.evaluate(`document.querySelector('.console-filter-tabs .admin-stat[data-view="waiting"]').click()`);
    assert.deepEqual(await page.evaluate(listed), ['等回答：发布口径', '等回答：结算页文案', '等回答：目录巡检'],
      '「等我回复」只列等回答的，最近更新在前；出错的和在跑的都不进来');
    assert.equal(await page.evaluate(`document.getElementById('console-task-note').textContent`), '3 条');
    assert.deepEqual(await page.evaluate(`(() => { const s=getComputedStyle(document.getElementById('console-task-list')); return [s.overflowY,s.maxHeight]; })()`),
      ['auto', '350px'], '清单有最大高度，内部滚动');
    // 侧栏徽标数的是「要我动手的」全部：等我回复 + 异常。
    assert.equal(await page.evaluate(`document.getElementById('console-badge').textContent`), '6', '徽标 = 等我回复 + 异常');
    await page.screenshot('06-console-waiting');
    await page.evaluate(`document.querySelector('.console-filter-tabs .admin-stat[data-view="error"]').click()`);
    assert.deepEqual(await page.evaluate(listed), ['出错：导出失败重试', '出错：兼容矩阵', '出错：图谱回填'], '「异常」单独一格，只列出错的');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#console-task-list .mc-status-label')].map(el=>el.textContent)`),
      ['执行异常', '执行异常', '执行异常']);
    await page.screenshot('06a-console-error');
    await page.evaluate(`document.querySelector('.console-filter-tabs .admin-stat[data-view="running"]').click()`);
    assert.deepEqual(await page.evaluate(listed), ['在跑：登录页空状态', '在跑：投放日报']);
    await page.evaluate(`document.querySelector('.console-filter-tabs .admin-stat[data-view="today"]').click()`);
    assert.deepEqual(await page.evaluate(listed), ['今天跑完：图标换新'], '很久以前完成的不算今日完成');
    await page.screenshot('06b-console-today');
    await page.evaluate(`document.querySelector('.console-filter-tabs .admin-stat[data-view="today"]').click()`);
    assert.equal(await page.evaluate(`document.getElementById('console-filter-panel').hidden`), true, '再点同一格收起');

    // ── ③ 「谁在等我」是自己的一页：换页而不是换层，地址留住，清单给全 ────
    await page.navigate('/air?view=attention');
    assert.ok(await page.waitFor(`document.getElementById('console-center').hidden===true`), '进那一页时控制台这一页让开');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='谁在等我'`), '页头换成那一页自己的标题');
    assert.equal(await page.evaluate(`document.getElementById('task-breadcrumb').textContent`), 'MultiCC Air › 控制台');
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('view')`), 'attention', '整页有自己的地址');
    assert.equal(await page.evaluate(`location.search.includes('task=')`), false, '整页不是某个任务的任务页');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#admin-content .admin-recent-row strong')].map(el=>el.textContent)`),
      ['出错：导出失败重试', '等回答：发布口径', '出错：兼容矩阵', '等回答：结算页文案', '出错：图谱回填', '等回答：目录巡检'],
      '整页给全 6 条，顺序与面板那一格一致');
    assert.equal(await page.evaluate(`document.getElementById('admin-content').innerText.includes('已完成：收口控制台')`), false, '已完成的不进这份清单');
    assert.equal(await page.evaluate(`document.getElementById('admin-content').innerText.includes('在跑：')`), false, '执行中的也不进这份清单');
    assert.equal(await page.evaluate(`document.querySelector('#admin-content .admin-panel-note').textContent`), '6 条 · 按最近更新排序，点击直达');
    await page.screenshot('07-attention-page');

    // 地址可直达：刷新/分享这条链接都落到同一页，它才是控制台那一片的入口。
    await page.navigate('/air?view=attention');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='谁在等我'`));
    assert.equal(await page.evaluate(`document.getElementById('console-center').hidden`), true, '直接打开这一页不会顺手打开控制台');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .admin-recent-row').length`), 6);

    // 整页里点一条任务：落到任务页，不是回到控制台。
    await page.evaluate(`document.querySelectorAll('#admin-content .admin-recent-row')[3].click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='等回答：结算页文案'`), '整页里点一条直达该任务');
    assert.equal(await page.evaluate(`location.search.includes('task=w2')`), true);
    assert.equal(await page.evaluate(`document.getElementById('console-center').hidden`), true);

    // ── ④ 返回控制台：回到的是控制台那一页，不是任务页 ─────────────────────
    await page.navigate('/air?view=attention');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='谁在等我'`));
    await page.evaluate(`[...document.getElementById('admin-actions').querySelectorAll('button')].find(b => b.textContent.includes('返回控制台')).click()`);
    assert.ok(await page.waitFor(`document.getElementById('console-center').hidden===false`), '「返回控制台」回到控制台那一页');
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('view')`), 'overview', '回去的这一页地址就是它自己的地址');
    assert.ok(await page.evaluate(`document.getElementById('console-content').innerText.includes('等我回复')`), '回到的是控制台那一页，不是任务页');

    // ── ⑤ 数据变了，数字和清单跟着变 ─────────────────────────────────────
    routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex'], migration: { errors: [] },
      tasks: airTasks.filter(entry => ['w1', 'e1', 'r1'].includes(entry.id)), sessions: [] });
    await page.navigate('/air?view=overview');
    assert.ok(await page.waitFor(`document.getElementById('console-center').hidden===false`));
    assert.ok(await page.waitFor(`document.querySelector('.admin-stat[data-view="waiting"] strong')?.textContent==='1'`));
    assert.equal(await page.evaluate(`document.querySelector('.admin-stat[data-view="error"] strong').textContent`), '1');
    await page.evaluate(`document.querySelector('.console-filter-tabs .admin-stat[data-view="waiting"]').click()`);
    assert.deepEqual(await page.evaluate(listed), ['等回答：发布口径'], '在跑的、出错的都不算等我回复');
    assert.equal(await page.evaluate(`document.getElementById('console-badge').textContent`), '2');
    await page.screenshot('08-console-waiting-short');

    // ── 窄屏：压扁后的读数带和整页都不能横向溢出 ───────────────────────────
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.navigate('/air?view=attention');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='谁在等我'`));
    assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true, '整页在窄屏不横向溢出');
    await page.screenshot('09-attention-mobile');
    await page.evaluate(`document.getElementById('overview').click()`);
    assert.ok(await page.waitFor(`document.getElementById('console-center').hidden===false`));
    const mobile = await page.evaluate(`(() => { const card = document.querySelector('.admin-stat');
      return { height: Math.round(card.getBoundingClientRect().height),
        overflow: document.documentElement.scrollWidth <= innerWidth }; })()`);
    assert.equal(mobile.overflow, true, '窄屏下控制台也不横向溢出');
    assert.ok(mobile.height <= 80, `窄屏下统计卡同样矮（实测 ${mobile.height}）`);
    // 小字放不下时不溢出到隔壁卡，而是在卡内走跑马灯；放得下的保持静止。
    await page.evaluate(`document.querySelector('.admin-stat .admin-stat-detail-text').textContent = '一段特别长特别长的说明文字，窄屏上一行绝对放不下，必须滚动才能看全'`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 2, mobile: true });
    assert.ok(await page.waitFor(`document.querySelector('.admin-stat .admin-stat-detail').classList.contains('marquee')`), '放不下的小字切成跑马灯');
    const marquee = await page.evaluate(`(() => {
      const box = document.querySelector('.admin-stat .admin-stat-detail'), card = box.closest('.admin-stat');
      const text = box.firstElementChild;
      return { contained: box.getBoundingClientRect().right <= card.getBoundingClientRect().right + 0.5,
        animation: getComputedStyle(text).animationName,
        shift: parseFloat(box.style.getPropertyValue('--marquee-shift')),
        needed: text.scrollWidth - box.clientWidth,
        others: [...document.querySelectorAll('.admin-stat-detail')].slice(1).map(el => el.classList.contains('marquee')
          || el.firstElementChild.scrollWidth <= el.clientWidth + 1) };
    })()`);
    assert.equal(marquee.contained, true, '小字盒子不超出卡片');
    assert.equal(marquee.animation, 'admin-stat-marquee');
    assert.ok(Math.abs(-marquee.shift - marquee.needed) <= 2, `滚动终点正好露出最后一个字（shift ${marquee.shift} vs 溢出 ${marquee.needed}）`);
    assert.ok(marquee.others.every(Boolean), '其余卡片要么放得下，要么也在滚');
    await page.screenshot('10b-mobile-stat-marquee');
    await page.screenshot('10-mobile-console-stats');
  });

  console.log('截图目录: ' + shots);
});

// B（等后台任务）在真页面上只报「等待后台任务」。这一条断的是 DOM：词表那一层
// 由 tests/test-status-presentation.js 钉（两个语言、每个状态一个词），这里要证的是
// 那张表真的喂到了界面上 —— 侧栏的徽标、控制台的待办清单、统计卡三处读的是同一份
// 判定，等后台任务不在任何一处被说成「等待回答」。
test('a task waiting on background work never renders as waiting for you', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-air-background-qa');
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

  const directories = [{ id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' }];
  const configuration = { cli: 'codex', provider: 'codex-lab', providerName: 'Lab Responses', providerSelection: null,
    model: 'gpt-5.5', effectiveModel: 'gpt-5.5', effort: 'medium' };
  const task = (id, title, status, runState, updatedAt, resource) => ({ id, dirId: 'd1', title, recordType: 'planned',
    workflowStage: 'doing', status, runState, updatedAt, resource: resource || { residency: 'planned', lease: 'idle' }, configuration });
  // 三条活着的任务各说各的：等后台任务、等回答、正在跑。等后台任务那条既不该算进
  // 「谁在等我」，也不该拿「在跑」的圈 —— 外面有东西在跑，但本机这一轮没在跑。
  const airTasks = [
    task('tsk_bg', '等回调：索引重建', 'active', 'background', 900),
    task('tsk_wait', '等回答：发布口径', 'active', 'waiting', 800),
    task('tsk_run', '在跑：投放日报', 'active', 'running', 700, { residency: 'materialized', lease: 'running' }),
  ];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex'], migration: { errors: [] }, tasks: airTasks, sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  for (const entry of airTasks) {
    routes[`/api/air/tasks/${entry.id}`] = routes[`/api/task-shell-tasks/${entry.id}`] = () => json({ ok: true,
      task: entry, sessionId: `task-${entry.id}`, ownerShellId: 'shell-a', readOnly: false,
      execution: { busy: false, status: 'idle' }, resource: entry.resource, attribution: {},
      roleBindings: { version: 0, bindings: [] }, messages: [] });
    routes[`POST /api/task-board/tasks/${entry.id}/chat-session`] = () => json({ ok: true, sessionId: `task-${entry.id}` });
  }
  routes['POST /api/task-shells'] = () => json({ id: 'shell-a' });

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1&task=tsk_bg');
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent==='等回调：索引重建'`));

    const badge = await page.evaluate(`document.querySelector('#tasks button .mc-status-label').textContent`);
    assert.equal(badge, '等待后台任务', '侧栏徽标说的是「等后台任务」');
    assert.notEqual(badge, '等待回答', '同一行绝不能自报「等待回答」');
    assert.equal(await page.evaluate(`document.querySelectorAll('#tasks button.ring-running').length`), 0, '等后台任务不算本机在跑，不拿圈');
    await page.screenshot('bg-wait-sidebar');

    // 控制台徽标数的是「要我动手的」：只有那条等回答的，等后台任务的不算。
    assert.ok(await page.waitFor(`document.getElementById('console-badge').hidden===false`));
    assert.equal(await page.evaluate(`document.getElementById('console-badge').textContent`), '1', '等后台任务不该在侧栏催我');
    await page.evaluate(`document.getElementById('overview').click()`);
    assert.ok(await page.waitFor(`document.getElementById('console-center').hidden===false`));
    assert.ok(await page.waitFor(`document.querySelectorAll('.admin-stats .admin-stat').length===5`));
    const stats = await page.evaluate(`[...document.querySelectorAll('.admin-stats .admin-stat strong')].map(el=>el.textContent)`);
    assert.equal(stats[0], '1', '进行中只数在跑的那条');
    assert.equal(stats[1], '1', '「等我回复」只数那条等回答的');
    assert.equal(stats[2], '0', '没有出错的');
    assert.equal(stats[4], '3', '三条任务都还没结束');
    await page.evaluate(`document.querySelector('.console-filter-tabs .admin-stat[data-view="waiting"]').click()`);
    // 浮层是后挂上去的容器，innerText 对这种没进布局的节点会回空串 —— 读 textContent。
    const attention = await page.evaluate(`document.getElementById('console-filter-panel').textContent.replace(/\\s+/g,' ')`);
    assert.ok(attention.includes('等回答：发布口径'), '等回答的进清单');
    assert.equal(attention.includes('等回调：索引重建'), false, '等后台任务的不进「谁在等我」');
    assert.equal(attention.includes('等待后台任务'), false, '这份清单里没有一条该说「等后台任务」');
    await page.screenshot('bg-wait-console');
  });

  console.log('截图目录: ' + shots);
});
