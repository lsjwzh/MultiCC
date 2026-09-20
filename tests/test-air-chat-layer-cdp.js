'use strict';

// Air 的对话浮层，在真浏览器里跑。改之前：打开任务 = 把主区换成聊天（#empty 打上
// hidden 让位，切任务 = 换一遍整屏），关掉再打开一个新的 = 先换回目录、再换一遍整屏。
// 改之后：对话是浮在目录详情之上的一层，底页从不卸载 —— 关掉是滑落回去，换任务只是
// 这一层里换了个人，所以「侧栏点一下就换台」还是一步。
//
// 这里量的是四件靠读代码看不出来的事：① 默认态是一整张有边距的浮卡，底页能从边缘
// 看见，② 桌面展开只盖侧栏右侧的主界面，手机展开才铺满视口，③ 关掉之后 #empty
// 还活着（没有 hidden、没有卸载），④ 换任务不往历史里写条目、后退等价于关层。
//
// DOM shim 量不了这些：getBoundingClientRect、层叠顺序（elementFromPoint）、
// 过渡后的 visibility 都是浏览器行为。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const publicDir = path.resolve(__dirname, '../public');
const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const TASKS = [
  { id: 'tsk_a', session: 'task-a', shell: 'shell-a', title: '任务 A' },
  { id: 'tsk_b', session: 'task-b', shell: 'shell-b', title: '任务 B' },
];
const DIRECTORY = { id: 'd1', name: 'MultiCC', path: '/projects/multicc' };

// 一屏的几何：这一层、内容区、页头各自在哪，以及几个「谁在上面」的命中测试。
// 命中测试用 elementFromPoint：z-index 预算写错时，量出来的 rect 照样是对的，
// 只有真去点一下才知道谁在上面。
const geometry = `(() => {
  const rect = el => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const layer = document.getElementById('chat-layer');
  const content = document.getElementById('task-content');
  const header = document.getElementById('task-header');
  const sidebar = document.getElementById('sidebar');
  const empty = document.getElementById('empty');
  const bar = document.getElementById('chat-bar');
  const title = document.getElementById('chat-bar-title');
  const handle = document.getElementById('chat-bar-handle');
  const r = { layer: rect(layer), content: rect(content), header: rect(header) };
  const hit = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return { tag: el ? (el.id || el.className || el.tagName) : null, inLayer: !!(el && el.closest('#chat-layer')), inHeader: !!(el && el.closest('#task-header')), inSidebar: !!(el && el.closest('#sidebar')) };
  };
  return {
    ...r,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    open: layer.classList.contains('is-open'),
    expanded: layer.classList.contains('is-expanded'),
    gone: getComputedStyle(layer).visibility === 'hidden',
    emptyHidden: !!empty.hidden,
    emptyRect: rect(empty),
    headerHit: hit(r.header.x + Math.round(r.header.w / 2), r.header.y + Math.round(r.header.h / 2)),
    sidebarHit: hit(Math.round(sidebar.getBoundingClientRect().x + 60), Math.round(window.innerHeight / 2)),
    contentHit: hit(r.content.x + Math.round(r.content.w / 2), r.content.y + Math.round(r.content.h / 2)),
    barH: Math.round(bar.getBoundingClientRect().height),
    bar: rect(bar),
    handleH: Math.round(handle.getBoundingClientRect().height),
    titleShown: getComputedStyle(title).display !== 'none',
    titleText: title.textContent,
    pressed: document.getElementById('chat-expand').getAttribute('aria-pressed'),
    label: document.querySelector('#chat-expand .chat-bar-label').textContent,
    url: location.search,
    historyLength: history.length,
  };
})()`;

const frameHeaderClearance = `(() => {
  const layer = document.getElementById('chat-layer').getBoundingClientRect();
  const bar = document.getElementById('chat-bar').getBoundingClientRect();
  const frame = document.getElementById('conversation');
  const context = frame.contentDocument.getElementById('chat-context-bar').getBoundingClientRect();
  const style = getComputedStyle(frame.contentDocument.getElementById('chat-context-bar'));
  return {
    barLeft: Math.round(bar.left - layer.left),
    contextRight: Math.round(context.right),
    paddingRight: Math.round(parseFloat(style.paddingRight)),
  };
})()`;

// 侧栏里那一行任务；点它就是「换台」。
const clickTask = title => `(() => {
  const button = [...document.querySelectorAll('#tasks button')]
    .find(candidate => candidate.querySelector('strong')?.textContent === ${JSON.stringify(title)});
  if (!button) return false;
  button.click();
  return true;
})()`;

// 拖柄的位移。合成 PointerEvent 就够：处理器读的是 clientY，捕获失败也照样走。
const dragBar = (from, to) => `(() => {
  const bar = document.getElementById('chat-bar');
  const fire = (type, y) => bar.dispatchEvent(new PointerEvent(type, { clientY: y, bubbles: true, cancelable: true, pointerId: 1 }));
  const layer = document.getElementById('chat-layer');
  const before = layer.style.transform;
  fire('pointerdown', ${from});
  fire('pointermove', ${to});
  const during = layer.style.transform;
  fire('pointerup', ${to});
  return { before, during, after: layer.style.transform };
})()`;

// 帧真的起来了没有：chat.js 顶层会装 __multiccChatSetActive，它在了说明这一帧
// 加载的是真聊天页 —— 截图里因此是有内容的对话，不是一张空白壳。
const frameReady = session => `(() => {
  const frame = document.getElementById('conversation');
  if (!frame || !frame.contentWindow || !frame.contentDocument) return false;
  if (frame.contentDocument.readyState !== 'complete') return false;
  if (!String(frame.contentWindow.location.search).includes('session=${session}')) return false;
  return typeof frame.contentWindow.__multiccChatSetActive === 'function';
})()`;

function buildAirRoutes() {
  const routes = {};
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
    routes['/' + file] = {
      body: fs.readFileSync(path.join(publicDir, file)),
      headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' },
    };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/vendor/dompurify/purify.min.js'] = { headers: { 'content-type': 'text/javascript' }, body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')) };
  routes['/air'] = routes['/air.html'];
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };

  const entryFor = task => ({ ok: true,
    task: { id: task.id, title: task.title, recordType: 'planned', workflowStage: 'doing', description: `${task.title} 的描述`, acceptanceCriteria: '能看到这一项。' },
    sessionId: task.session, ownerShellId: task.shell, readOnly: false,
    execution: { busy: false, status: 'idle' }, resource: { residency: 'planned', lease: 'idle' },
    attribution: {}, configuration: { cli: 'codex', provider: null, providerName: null, model: 'gpt-5.5', effectiveModel: 'gpt-5.5', effort: 'medium' },
    roleBindings: { version: 0, bindings: [] }, messages: [] });

  routes['/api/air'] = () => json({ ok: true, directories: [DIRECTORY], clis: ['codex', 'claude'], migration: { errors: [] },
    sessions: [],
    tasks: TASKS.map((task, index) => ({ ...entryFor(task).task, dirId: 'd1', status: 'doing', updatedAt: 1_700_000_000_000 + index, resource: { residency: 'planned', lease: 'idle' } })) });
  for (const task of TASKS) {
    routes[`/api/air/tasks/${task.id}`] = () => json(entryFor(task));
    routes[`POST /api/task-board/tasks/${task.id}/chat-session`] = () => json({ ok: true, sessionId: task.session });
    routes[`POST /api/task-shells/${task.shell}/tasks/resolve`] = () => json({ sessionId: task.session });
    routes[`/api/task-shells/${task.shell}/chat`] = () => json({ activeSessionId: task.session, taskId: task.id });
    routes[`/api/task-shells/${task.shell}/history`] = () => json({ ok: true, messages: [] });
    routes[`/api/task-shell-tasks/${task.id}/artifacts`] = () => json({ taskId: task.id, title: task.title, items: [] });
    routes[`/api/task-shell-tasks/${task.id}/history`] = () => json({ ok: true, messages: [] });
    routes[`/api/sessions/${task.session}/merge-status`] = () => json({ branch: `multicc/${task.session}`, baseBranch: 'main', behind: 0 });
    routes[`/api/sessions/${task.session}/liveness`] = () => json({ state: 'idle' });
  }
  routes['POST /api/task-shells'] = ({ body }) => {
    const task = TASKS.find(candidate => candidate.session === JSON.parse(body).sessionId);
    return json({ id: task.shell });
  };
  routes['/api/settings/access-token'] = () => json({ hasToken: true, canEdit: false });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/providers'] = () => json({ ok: true, available: false, defaults: {}, providers: [] });
  routes['/api/agent-presets'] = () => json({ presets: [] });
  routes['/api/sessions'] = () => json({ ok: true, sessions: [], directories: [] });
  // 目录详情里的 Git 面板：底页永远在下面待着，它照旧会去读（关掉对话露出来的
  // 就是这一页，所以要让它读得动，不然截图里是一条报错）。
  routes['/api/git/directory-status'] = () => json({ ok: true, dirId: 'd1', branch: 'main', upstream: 'origin/main',
    ahead: 0, behind: 0, dirty: 0, files: [], repository: { name: 'multicc', root: '/projects/multicc' } });
  routes['/api/git/log'] = () => json({ ok: true, commits: [] });
  return routes;
}

const screenshotDir = () => process.env.MULTICC_AIR_CHAT_LAYER_QA_DIR || path.join(os.tmpdir(), 'multicc-air-chat-layer-qa');

test('Air opens a conversation as an overlay over the directory page, and expand covers the header too', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildAirRoutes(), screenshotDir: screenshotDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air.html?dir=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('#tasks button').length === ${TASKS.length}`), '侧栏列出任务');

    // ── 没有对话时：这一层收在下面，目录详情就是页面上唯一那一层 ──────────────
    const idle = await page.evaluate(geometry);
    assert.equal(idle.open, false, '没任务时浮层是收着的');
    assert.equal(idle.gone, true, '收着的层要真的看不见（不然它会吃掉点击）');
    assert.equal(idle.emptyHidden, false, '目录详情从不 hidden —— 关掉对话要能原样露出来');
    assert.ok(idle.emptyRect.h > 100, `目录详情要占着内容区：${JSON.stringify(idle.emptyRect)}`);

    // ── 打开任务：浮层升上来，正好盖住内容区 ────────────────────────────────
    assert.equal(await page.evaluate(clickTask('任务 A')), true, '侧栏里点得到任务 A');
    assert.ok(await page.waitFor(frameReady('task-a')), '对话帧要立起来');
    assert.ok(await page.waitFor(`document.getElementById('chat-layer').classList.contains('is-open')`), '浮层要升上来');

    const open = await page.evaluate(geometry);
    assert.ok(open.layer.x > open.content.x && open.layer.y > open.content.y,
      `默认态四周要留出底页面板：${JSON.stringify(open)}`);
    assert.ok(open.layer.x + open.layer.w < open.content.x + open.content.w,
      `浮卡右边也要能看到底页：${JSON.stringify(open)}`);
    assert.ok(open.layer.y + open.layer.h < open.content.y + open.content.h,
      `浮卡底边也要能看到底页：${JSON.stringify(open)}`);
    assert.ok(open.layer.y >= open.header.y + open.header.h - 1, `浮层不该伸到页头上去：${JSON.stringify(open)}`);
    assert.equal(open.headerHit.inHeader, true, `页头要留在外面当快捷入口（谁在上面：${open.headerHit.tag}）`);
    assert.equal(open.headerHit.inLayer, false, `默认态浮层不许盖到页头：${JSON.stringify(open.headerHit)}`);
    assert.equal(open.sidebarHit.inSidebar, true, `侧栏也要留在外面，换台才是一步：${JSON.stringify(open.sidebarHit)}`);
    assert.equal(open.contentHit.inLayer, true, `内容区里最上面的是浮层：${JSON.stringify(open.contentHit)}`);
    assert.equal(open.emptyHidden, false, '被盖住不等于被 hidden');
    assert.equal(open.titleShown, false, '浮层不再用单独一行重复任务名');
    assert.equal(open.pressed, 'false');
    assert.equal(open.label, '展开');
    assert.ok(open.bar.w <= 70 && open.bar.h <= 34, `右上只留两个紧凑图标：${JSON.stringify(open.bar)}`);
    const clearance = await page.evaluate(frameHeaderClearance);
    assert.ok(clearance.paddingRight >= 92, `iframe 现有状态行给角标让位，不得叠字：${JSON.stringify(clearance)}`);
    await page.screenshot('01-chat-layer-default');

    // ── 展开：连页头一起盖 ──────────────────────────────────────────────────
    await page.evaluate(`document.getElementById('chat-expand').click()`);
    assert.ok(await page.waitFor(`document.getElementById('chat-layer').classList.contains('is-expanded')`), '要进展开态');
    const expanded = await page.evaluate(geometry);
    assert.deepEqual({ x: expanded.layer.x, y: expanded.layer.y, w: expanded.layer.w, h: expanded.layer.h },
      { x: open.content.x, y: 0, w: expanded.viewport.w - open.content.x, h: expanded.viewport.h },
      `桌面展开只铺满侧栏右侧：${JSON.stringify(expanded)}`);
    assert.equal(expanded.headerHit.inLayer, true, `展开后页头归浮层管：${JSON.stringify(expanded.headerHit)}`);
    assert.equal(expanded.sidebarHit.inSidebar, true, `展开后侧栏仍可用：${JSON.stringify(expanded.sidebarHit)}`);
    assert.equal(expanded.sidebarHit.inLayer, false, `浮层不能越过侧栏：${JSON.stringify(expanded.sidebarHit)}`);
    assert.equal(expanded.pressed, 'true', '展开键要报出自己按下了');
    assert.equal(expanded.label, '收起');
    assert.equal(expanded.titleShown, false, '展开态也不新增一整条标题栏');
    assert.equal(expanded.titleText, '任务 A');
    await page.screenshot('02-chat-layer-expanded');

    // ── 收起：回到默认态 ────────────────────────────────────────────────────
    await page.evaluate(`document.getElementById('chat-expand').click()`);
    assert.ok(await page.waitFor(`!document.getElementById('chat-layer').classList.contains('is-expanded')`), '要退回默认态');
    const collapsed = await page.evaluate(geometry);
    assert.deepEqual(collapsed.layer, open.layer, `收起=回到同一张浮卡：${JSON.stringify(collapsed)}`);
    assert.equal(collapsed.headerHit.inHeader, true, '收起之后页头又是页头了');
    assert.equal(collapsed.pressed, 'false');

    // ── 关闭：滑落回去，底页原样还在（它从来没被卸载过） ────────────────────
    await page.evaluate(`document.getElementById('chat-close').click()`);
    assert.ok(await page.waitFor(`getComputedStyle(document.getElementById('chat-layer')).visibility === 'hidden'`), '关闭后这一层要真的看不见');
    const closed = await page.evaluate(geometry);
    assert.equal(closed.url.includes('task='), false, `关掉对话后地址里不该还挂着任务：${closed.url}`);
    assert.equal(closed.emptyHidden, false, '关掉对话 = 露出目录详情，它一直是活的');
    assert.ok(closed.emptyRect.h > 100, `目录详情要在原位：${JSON.stringify(closed.emptyRect)}`);
    assert.equal(closed.headerHit.inHeader, true, `页头还是页头：${JSON.stringify(closed.headerHit)}`);
    assert.equal(await page.evaluate(`document.getElementById('task-title').textContent`), 'MultiCC', '页头回到目录');
    // 帧不是被卸掉，是交回池子：260ms 的滑落之后 id 摘掉、藏起来。
    assert.ok(await page.waitFor(`!document.getElementById('conversation')`), '关掉之后当前帧要交回池子（只藏不卸）');
    await page.screenshot('03-chat-layer-closed');
  });
});

// 「换台不是换页」在历史里的那一半：来回看几个任务不该把后退键淹掉，以及后退本身
// 就该等于「关掉这一层」。这两条一起才让手机上那颗后退键与右上角那个 × 是同一件事。
test('Air switches conversations without piling up history, and back closes the layer', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildAirRoutes(), screenshotDir: screenshotDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air.html?dir=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('#tasks button').length === ${TASKS.length}`), '侧栏列出任务');
    const before = (await page.evaluate(geometry)).historyLength;

    // 打开 A：这是新的一步（后退应该正好关掉这一层）。
    assert.equal(await page.evaluate(clickTask('任务 A')), true);
    assert.ok(await page.waitFor(frameReady('task-a')), 'A 的对话帧要立起来');
    const opened = await page.evaluate(geometry);
    assert.equal(opened.historyLength, before + 1, '打开对话是历史里的新一步');
    assert.match(opened.url, /task=tsk_a/);

    // 换成 B：只是浮层里换了个人，历史里不该多出一步。
    assert.equal(await page.evaluate(clickTask('任务 B')), true);
    assert.ok(await page.waitFor(frameReady('task-b')), 'B 的对话帧要立起来');
    const switched = await page.evaluate(geometry);
    assert.equal(switched.historyLength, opened.historyLength, '换台不该往历史里写条目');
    assert.match(switched.url, /task=tsk_b/, '地址要跟到 B 上（刷新回来还是 B）');
    assert.equal(switched.open, true, '换个任务浮层不该收起来');

    // 后退：等价于关掉这一层，落在原来那一页上。
    await page.evaluate(`history.back()`);
    assert.ok(await page.waitFor(`getComputedStyle(document.getElementById('chat-layer')).visibility === 'hidden'`), '后退要把这一层收回去');
    const backed = await page.evaluate(geometry);
    assert.equal(backed.url.includes('task='), false, `后退后地址里不该还挂着任务：${backed.url}`);
    assert.equal(backed.emptyHidden, false, '后退露出来的是目录详情');
    assert.ok(await page.waitFor(`!document.getElementById('conversation')`), '后退之后当前帧同样交回池子');
    await page.screenshot('04-chat-layer-back');
  });
});

// 手机上这一层是 App 那个底部 sheet 的等价物：默认停在页头下面盖满内容区（页头留着，
// 那是「换下一台」最快的那一步），往下甩 = 关掉。桌面同一个几何，多的是那两颗按钮。
test('Air keeps the mobile overlay under the header and lets a downward fling close it', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildAirRoutes(), screenshotDir: screenshotDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await page.navigate('/air.html?dir=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('#tasks button').length === ${TASKS.length}`), '侧栏列出任务');

    assert.equal(await page.evaluate(clickTask('任务 A')), true);
    assert.ok(await page.waitFor(frameReady('task-a')), '对话帧要立起来');
    const open = await page.evaluate(geometry);
    assert.deepEqual({ x: open.layer.x, y: open.layer.y, w: open.layer.w, h: open.layer.h },
      { x: open.content.x, y: open.content.y, w: open.content.w, h: open.content.h },
      `手机上默认态同样是 100% 内容区：${JSON.stringify(open)}`);
    assert.equal(open.layer.h, open.viewport.h - open.header.h, `内容区 = 视口减去页头：${JSON.stringify(open)}`);
    assert.equal(open.headerHit.inHeader, true, `手机上的页头同样留在外面：${JSON.stringify(open.headerHit)}`);
    assert.ok(open.handleH >= 3, `手机上要有那条拖柄：${open.handleH}px`);
    assert.ok(open.barH <= 44, `控制条要压得够薄，别吃掉对话：${open.barH}px`);
    await page.screenshot('05-chat-layer-mobile');

    // 拖到一半放开：弹回去，对话还在。
    const nudge = await page.evaluate(dragBar(10, 60));
    assert.equal(nudge.during, 'translateY(50px)', `拖动时位移要贴着手指：${JSON.stringify(nudge)}`);
    assert.equal(nudge.after, '', `没到线要弹回去：${JSON.stringify(nudge)}`);
    assert.equal((await page.evaluate(geometry)).open, true, '没到线不该关掉对话');

    // 往下甩过去：关掉这一层，回到目录详情。
    const fling = await page.evaluate(dragBar(10, 620));
    assert.equal(fling.after, '', `甩出去之后行内位移要交还给样式表：${JSON.stringify(fling)}`);
    assert.ok(await page.waitFor(`getComputedStyle(document.getElementById('chat-layer')).visibility === 'hidden'`), '往下甩要关掉这一层');
    const closed = await page.evaluate(geometry);
    assert.equal(closed.url.includes('task='), false, `甩掉之后地址也要跟着回到目录：${closed.url}`);
    assert.equal(closed.emptyHidden, false, '底页照旧还在');

    // 展开态在手机上仍然连页头一起盖。
    assert.equal(await page.evaluate(clickTask('任务 B')), true);
    assert.ok(await page.waitFor(frameReady('task-b')), 'B 的对话帧要立起来');
    await page.evaluate(`document.getElementById('chat-expand').click()`);
    assert.ok(await page.waitFor(`document.getElementById('chat-layer').classList.contains('is-expanded')`), '要进展开态');
    const expanded = await page.evaluate(geometry);
    assert.deepEqual({ x: expanded.layer.x, y: expanded.layer.y, w: expanded.layer.w, h: expanded.layer.h },
      { x: 0, y: 0, w: expanded.viewport.w, h: expanded.viewport.h },
      `手机上展开同样是真满屏：${JSON.stringify(expanded)}`);
    assert.equal(expanded.headerHit.inLayer, true, `展开后页头归浮层管：${JSON.stringify(expanded.headerHit)}`);
    assert.equal(expanded.titleText, '任务 B');
    await page.screenshot('06-chat-layer-mobile-expanded');
  });
});
