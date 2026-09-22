'use strict';
// 任务图谱这一格从「嵌旧 manage 页的 iframe」改成了 Air 原生页（air-taskgraph.js）。
// 它不是一次外观调整：那一格的力导向画布还是 public/task-graph.js 那个按 id 认领元素
// 的自包含渲染器，所以「搬得对不对」= 骨架里每个 id 都在、都归同一个人读写。要断到：
//   ① 渲染是原生的 —— #admin-content 里没有 .air-legacy-frame，也没有任何 /manage.html
//      请求（iframe 的 src 会真的发出去，所以这条能证明它没被悄悄嵌回来）；
//   ② 打开面板只打一条 GET /api/task-graph —— 画布数据只有这一个来源；
//   ③ 画布真的画了 —— 节点数 == fixture 节点数、计数徽标/元信息/图例的文案对得上；
//   ④ 交互真的绑上了（这是 task-graph.js 那次改动 loadTaskGraph 补 bindCanvasOnce 的
//      回归点：Air 的面板是懒渲染的，只在 DOMContentLoaded 绑会一个都绑不上）——
//      真鼠标事件推着画布平移、tgGraphZoom 改的是 viewport 的 transform、reset 能复位；
//   ⑤ 点节点开弹窗（标题/详情来自 fixture）、「在 Air 中打开 ↗」跳的是 /air?dir=&task=、
//      点关闭能关掉；
//   ⑥ 空数据时 #tg-graph-empty 真的可见（不是只存在）、计数徽标清空、画布不留旧节点；
//   ⑦ 刷新是真重拉（不是重画缓存）—— 换一份 payload 再点刷新，元信息跟着变；
//   ⑧ 离开再回来（控制台 → 工具格）拿到一块新画布，指针事件照样绑得上 —— 上面那条
//      回归点的第二种触发方式；再进来读缓存，不再打接口；
//   ⑨ 刷新失败：画布空态说一句、右下角也补一句。
// task-graph.js 自己那几句硬编码中文（加载中 / 暂无任务节点 / 图例类型词 / 弹窗字段名）
// 在一次 i18n 改造里全部改走 t('airTaskGraphXxx') 了：这段中文现在属于词典，不再属于
// 渲染器。所以这里不再照抄中文 —— 把同一份词典（public/i18n-catalog.js + public/i18n.js
// 按页面里的顺序跑进一个 vm 沙箱）在测试进程里也加载一遍，断言拿它现算：词典还没合并
// 进这一批新 key 时，页面和测试一起退化成裸 key（两边一致，照样绿）；合并之后这里自动
// 变成改造前的原文 —— 下面那张 GOLDEN 表把原文钉死，谁把中文改动了就红。
// 本模块自己的文案照旧先 await page.evaluate("t('airTaskgraphXxx')") 取回来再比。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const vm = require('node:vm');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

// 测试进程这边的词典（照 tests/test-i18n.js 的做法建沙箱，localStorage 打桩成 zh）。
const zhT = (() => {
  const store = new Map([['multicc_lang', 'zh']]);
  const context = {
    window: {},
    document: { addEventListener() {}, querySelectorAll() { return []; }, documentElement: {} },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    location: { reload() {} },
  };
  vm.createContext(context);
  const publicDir = path.resolve(__dirname, '../public');
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'i18n-catalog.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'i18n.js'), 'utf8'), context);
  const t = (key, params) => context.window.t(key, params);
  t.zh = context.window.I18N.zh;
  return t;
})();
// 带插值的模板 -> 正则：字面量转义，{slot} 换成给定的 pattern（如 \d+）。词典里还没有
// 这条 key 时模板就是裸 key（没有 {}），这时它退化成「整串等于 key」的形状。
const tplRe = (tpl, slots = {}) => new RegExp(tpl.split(/(\{\w+\})/).map(seg =>
  slots[seg] || seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(''));

// 改造前的原文：中文模式下 t() 必须逐字还原它们（这是回归，不是改写文案）。词典里还
// 没有这条 key 时跳过 —— 合并进来之后这些断言就必须成立。
const GOLDEN = {
  airTaskGraphLegendP: 'P 进行中',
  airTaskGraphLegendD: 'D 执行成功',
  airTaskGraphLegendNoClassify: '无 classify',
  airTaskGraphShellNode: '任务壳',
  airTaskGraphLegendProvisional: 'provisional(身份未锁)',
  airTaskGraphEdgeParent: '父任务',
  airTaskGraphEdgeGroup: '同组',
  airTaskGraphEdgeShellLink: '任务壳',
  airTaskGraphLegendManualRelation: '手动关系（虚线=相关，实线=同组）',
  airTaskGraphMetaCount: '· {nc} 节点 / {ec} 关联',
  airTaskGraphMetaServer: '{nc} 节点 · {ec} 边 · 服务端 {ms}ms',
  airTaskGraphMetaFetch: ' · 拉取 {ms}ms',
  airTaskGraphEmpty: '暂无任务节点。任务看板或任务壳里出现任务后，这里会画出父子 / 分组 / 合并 / 壳链接。',
  airTaskGraphLoadFailed: '加载失败：{msg}',
  airTaskGraphClassNameP: '进行中',
  airTaskGraphTagClassify: 'classify {code} · {name}',
  airTaskGraphTagStatus: '状态: {value}',
  airTaskGraphTagRunState: '运行: {value}',
  airTaskGraphTagOrigin: '来源: {value}',
  airTaskGraphTagDegree: '关联度: {n}',
  airTaskGraphDetailGoal: '目标：{value}',
  airTaskGraphDetailPhase: '阶段：{value}',
  airTaskGraphDetailSession: '绑定会话：{value}',
  airTaskGraphDetailSources: '记录来源：{value}',
  airTaskGraphManualSuffix: '（手动）',
};

test('the Air task graph panel is native: id skeleton, drawn canvas, live interactions', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  for (const [key, zh] of Object.entries(GOLDEN)) {
    if (Object.prototype.hasOwnProperty.call(zhT.zh, key)) {
      assert.equal(zhT.zh[key], zh, `${key} 的词典中文必须与改造前逐字相同`);
    }
  }
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-air-taskgraph-qa');
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

  // 载荷形状照 src/routes/task-graph.js 的 buildTaskGraph 造（节点/边/子项目统计），
  // 四个节点刚好覆盖四件要断的事：canonical 任务、provisional 任务（身份未锁）、
  // 任务壳（菱形）、以及一条用户手动建立的关系边（图例里那句「手动关系」的来源）。
  const dirId = 'd1';
  const nodes = [
    { id: 't-board', kind: 'task', title: '整理任务图谱', dirId, status: 'open', runState: 'idle', origin: 'user',
      chatSessionId: 's1', deleted: false, classifyPending: false, provisional: false, canonical: true,
      classifyState: 'P', goal: '把任务图谱搬进 Air', phase: 'implement', degree: 2, sources: ['board'] },
    { id: 't-shell', kind: 'task', title: '子任务：写测试', dirId, status: 'done', parentTaskId: 't-board',
      sessionId: 's2', provisional: false, canonical: true, classifyState: 'D', degree: 3, sources: ['shell'] },
    { id: 't-prov', kind: 'task', title: '待归类任务', dirId, classifyPending: true, provisional: true, canonical: false,
      classifyState: null, degree: 1, sources: ['board'] },
    { id: 'sh-1', kind: 'shell', title: '壳 A', dirId, sourceSessionId: 's9', currentTaskId: 't-shell',
      archived: false, degree: 2, sources: ['shell'] },
  ];
  const edges = [
    { source: 't-shell', target: 't-board', type: 'parent', provenance: 'derived' },
    { source: 't-prov', target: 't-board', type: 'group', provenance: 'user' },
    { source: 't-shell', target: 'sh-1', type: 'shell-link', provenance: 'derived' },
  ];
  const graphMeta = { dirId: 'all', projects: [{ dirId, name: 'MultiCC 主仓', count: 3 }],
    taskCount: 3, shellCount: 1, nodeCount: 4, edgeCount: 3, truncated: false, maxNodes: 800, durationMs: 7 };
  const emptyGraph = { nodes: [], edges: [], meta: { dirId: 'all', projects: [], taskCount: 0, shellCount: 0, nodeCount: 0, edgeCount: 0, truncated: false, maxNodes: 800, durationMs: 3 } };
  let graphPayload = { nodes, edges, meta: graphMeta };
  let graphStatus = 200; // 翻成 500 就能断刷新失败的路径
  const graphCalls = [];
  routes['GET /api/task-graph'] = () => {
    graphCalls.push(graphStatus);
    if (graphStatus !== 200) return { status: graphStatus, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'task graph build failed' }) };
    return json(graphPayload);
  };
  routes['/api/air'] = () => json({ ok: true, directories: [{ id: dirId, name: 'MultiCC 主仓', path: '/projects/multicc' }], clis: ['codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    const text = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
    const view = () => page.evaluate(`(() => {
      const m = /translate\\(([-\\d.]+),([-\\d.]+)\\) scale\\(([-\\d.]+)\\)/.exec(
        document.getElementById('tg-graph-viewport')?.getAttribute('transform') || '');
      return m ? { tx: +m[1], ty: +m[2], scale: +m[3] } : null;
    })()`);
    const mouse = (type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent',
      { type, x, y, button: 'left', buttons: type === 'mouseMoved' ? 1 : 0, clickCount: type === 'mousePressed' ? 1 : 0, ...extra });

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ── ① 直接打开这一页：原生面板，不嵌旧 manage 页 ─────────────────────
    await page.navigate('/air?dir=d1&view=taskgraph');
    const heading = await page.evaluate(`t('airTaskGraph')`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent === ${JSON.stringify(heading)}`), '落在任务图谱页');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0, '原生面板里没有旧 manage 的 iframe');
    assert.equal(page.requests.some(r => r.path === '/manage.html'), false, 'iframe 的 src 会真的发出去 —— 没这条请求才算真没嵌');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].map(b => b.textContent.replace(/\\s+/g,''))`),
      ['←' + await page.evaluate(`t('airAdminBackToConsole')`), '↻' + await page.evaluate(`t('airAdminRefresh')`)],
      '工具条是面板自己的（返回控制台 / 刷新），不是旧页面的');
    // 骨架自己的文案：先取 t() 再比，别把中文写进断言。
    assert.equal(await text('.air-taskgraph-desc'), await page.evaluate(`t('airTaskgraphDesc')`), '说明段走 t()');
    assert.equal(await text('#tg-graph-hint'), await page.evaluate(`t('airTaskgraphHint')`), '画布常驻提示走 t()');
    assert.equal(await text('.air-taskgraph-project > span'), await page.evaluate(`t('airTaskgraphProject')`), '项目下拉的标签走 t()');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.tg-zoom-btns button')].map(b => b.title)`),
      [await page.evaluate(`t('airTaskgraphZoomIn')`), await page.evaluate(`t('airTaskgraphZoomOut')`), await page.evaluate(`t('airTaskgraphResetView')`)],
      '缩放按钮的 title 走 t()');
    assert.equal(await text('#tg-node-open'), await page.evaluate(`t('airTaskgraphOpenInAir')`), '弹窗里那颗按钮的文字走 t()');

    // ── ② 画布数据只有一个来源：打开面板就打一条 GET /api/task-graph ──────
    assert.ok(await page.waitFor(`document.querySelectorAll('#tg-graph-svg .tg-node').length === ${nodes.length}`), '节点都画出来了');
    await page.waitFor(`document.getElementById('tg-graph-meta').textContent !== ''`);
    const graphRequests = page.requests.filter(r => r.path === '/api/task-graph');
    assert.deepEqual(graphRequests.map(r => `${r.method} ${r.path}`), ['GET /api/task-graph'], '打开面板只打这一条');
    assert.deepEqual(graphCalls, [200]);

    // ── ③ 画布真的画了：节点/计数徽标/元信息/图例 ────────────────────────
    assert.equal(await page.evaluate(`document.querySelectorAll('#tg-graph-svg .tg-node').length`), nodes.length);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#tg-graph-svg .tg-node')].map(g => g.__node.id).sort()`),
      ['sh-1', 't-board', 't-prov', 't-shell'], '每个 <g> 都挂着自己的节点');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#tg-graph-svg .tg-node')].map(g => g.__node.kind === 'shell' ? 'rect' : 'circle').sort()`),
      ['circle', 'circle', 'circle', 'rect'], '任务壳画成菱形（rect），任务画成圆');
    // 下面三句的模板是 task-graph.js 自己拼的（· N 节点 / M 关联 / N 节点 · M 边 ·
    // 服务端 Xms），拼法里的中文现在来自词典，所以期望值也从同一份词典现算。
    assert.equal(await text('#tg-graph-count-pill'), zhT('airTaskGraphMetaCount', { nc: nodes.length, ec: edges.length }));
    const meta = await text('#tg-graph-meta');
    const metaHead = zhT('airTaskGraphMetaServer', { nc: nodes.length, ec: edges.length, ms: 7 });
    assert.ok(meta.startsWith(metaHead), '元信息对得上（含服务端耗时）：' + meta);
    assert.match(meta.slice(metaHead.length), tplRe(zhT('airTaskGraphMetaFetch'), { '{ms}': '\\d+' }),
      '客户端那一趟耗时也报出来：' + meta);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#tg-graph-project option')].map(o => o.value)`),
      ['all', dirId], '项目下拉列出全部 + 一个子项目');
    assert.deepEqual(await page.evaluate(`document.getElementById('tg-graph-project').value`), dirId, '默认落在唯一的那个子项目上');
    // 图例的文案在 task-graph.js 里（L20-39 的 CLASSIFY/EDGE 表，labelKey 走词典）。
    const legend = await page.evaluate(`[...document.querySelectorAll('#tg-graph-legend .lg')].map(el => el.textContent)`);
    assert.deepEqual(legend, [zhT('airTaskGraphLegendP'), zhT('airTaskGraphLegendD'), zhT('airTaskGraphLegendNoClassify'),
      zhT('airTaskGraphShellNode'), zhT('airTaskGraphLegendProvisional'),
      '—' + zhT('airTaskGraphEdgeParent'), '—' + zhT('airTaskGraphEdgeGroup'), '—' + zhT('airTaskGraphEdgeShellLink'),
      zhT('airTaskGraphLegendManualRelation')],
      '图例把 fixture 里出现的 classify 状态、壳、provisional、边类型和手动关系都列出来了');
    await page.screenshot('01-taskgraph-native-desktop');

    // ── ④ 交互真的绑上了（task-graph.js 补 bindCanvasOnce 的回归点）───────
    assert.equal(await page.evaluate(`document.getElementById('tg-graph-canvas').__tgBound === true`), true,
      '懒渲染的面板也要绑上画布那套指针事件（这次 task-graph.js 改的就是这一行）');
    // 先把画布挪到视口中间：坐标算的是 getBoundingClientRect，滚出去就点不到了。
    await page.evaluate(`document.getElementById('tg-graph-canvas').scrollIntoView({ block: 'center' })`);
    const canvasBox = await page.evaluate(`(() => { const r = document.getElementById('tg-graph-canvas').getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
    assert.ok(canvasBox.width > 400 && canvasBox.height > 300, '画布有真实尺寸：' + JSON.stringify(canvasBox));

    // 平移：找一块只有画布的地方按下、拖 70×50、松开 —— viewport 的 translate 要跟着挪。
    // 命中判定不能比「就是那个 canvas」：svg 铺满整块画布，空白处的命中目标是它自己
    // （事件照样冒泡到 canvas，所以拖拽是通的）。要的只是「别落在节点或缩放按钮上」。
    const panPoint = await page.evaluate(`(() => {
      const canvas = document.getElementById('tg-graph-canvas');
      const r = canvas.getBoundingClientRect();
      for (const [fx, fy] of [[0.06, 0.06], [0.94, 0.06], [0.06, 0.94], [0.5, 0.05], [0.5, 0.95]]) {
        const x = Math.round(r.left + r.width * fx), y = Math.round(r.top + r.height * fy);
        const hit = document.elementFromPoint(x, y);
        if (hit && canvas.contains(hit) && !hit.closest('.tg-node') && !hit.closest('.tg-zoom-btns')) return { x, y };
      }
      return null;
    })()`);
    assert.ok(panPoint, '画布上找得到一块没有节点的空地');
    const beforePan = await view();
    await mouse('mousePressed', panPoint.x, panPoint.y);
    await mouse('mouseMoved', panPoint.x + 70, panPoint.y + 50);
    await mouse('mouseReleased', panPoint.x + 70, panPoint.y + 50);
    const afterPan = await view();
    assert.ok(Math.abs((afterPan.tx - beforePan.tx) - 70) < 1.5 && Math.abs((afterPan.ty - beforePan.ty) - 50) < 1.5,
      `拖 70×50 视口就挪 70×50（${JSON.stringify(beforePan)} → ${JSON.stringify(afterPan)}）`);
    assert.equal(afterPan.scale, beforePan.scale, '平移不动缩放');

    // 缩放：tgGraphZoom 按圆心缩放，scale 正好 ×1.2。
    assert.equal(await page.evaluate(`window.tgGraphZoom(1.2) === undefined`), true, '放大按钮走的就是这个函数');
    const afterZoom = await view();
    assert.ok(Math.abs(afterZoom.scale - afterPan.scale * 1.2) < 1e-6, `scale ×1.2（${afterPan.scale} → ${afterZoom.scale}）`);
    assert.notEqual(`${afterZoom.tx},${afterZoom.ty}`, `${afterPan.tx},${afterPan.ty}`, '缩放把视口也带偏了（按圆心缩）');
    // 复位：回到「装得下全部节点」的那个 scale（fitView 的上限是 2，放大后必然超出）。
    await page.evaluate(`window.tgGraphResetView()`);
    const afterReset = await view();
    assert.ok(afterReset.scale <= 2, '复位后 scale 回到 fitView 的上限内：' + afterReset.scale);
    assert.ok(Math.abs(afterReset.scale - afterZoom.scale) > 1e-3, `复位真的把缩放退回去了（${afterZoom.scale} → ${afterReset.scale}）`);
    assert.notEqual(`${afterReset.tx},${afterReset.ty}`, `${afterZoom.tx},${afterZoom.ty}`, '复位也把视口挪回居中');

    // ── ⑤ 点节点：真鼠标事件 → 弹窗；「在 Air 中打开」跳的是 /air?dir=&task= ──
    const nodePoint = await page.evaluate(`(() => {
      const g = [...document.querySelectorAll('#tg-graph-svg .tg-node')].find(el => el.__node && el.__node.id === 't-board');
      const r = g.querySelector('circle').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await mouse('mousePressed', nodePoint.x, nodePoint.y);
    await mouse('mouseReleased', nodePoint.x, nodePoint.y);
    assert.ok(await page.waitFor(`document.getElementById('tg-node-modal').classList.contains('open')`), '点节点开弹窗');
    assert.equal(await text('#tg-node-title'), '整理任务图谱');
    assert.equal(await text('#tg-node-id'), `t-board   ·   ${dirId}`);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#tg-node-tags .mn-tag')].map(el => el.textContent)`),
      ['canonical', zhT('airTaskGraphTagClassify', { code: 'P', name: zhT('airTaskGraphClassNameP') }),
        zhT('airTaskGraphTagStatus', { value: 'open' }), zhT('airTaskGraphTagRunState', { value: 'idle' }),
        zhT('airTaskGraphTagOrigin', { value: 'user' }), zhT('airTaskGraphTagDegree', { n: 2 })],
      '弹窗标签来自 fixture 的字段');
    assert.equal(await text('#tg-node-detail'), [
      zhT('airTaskGraphDetailGoal', { value: '把任务图谱搬进 Air' }),
      zhT('airTaskGraphDetailPhase', { value: 'implement' }),
      zhT('airTaskGraphDetailSession', { value: 's1' }),
      zhT('airTaskGraphDetailSources', { value: 'board' }),
    ].join('\n'));
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#tg-node-links .mn-link')].map(el => el.textContent)`),
      ['← [' + zhT('airTaskGraphEdgeParent') + '] 子任务：写测试',
        '← [' + zhT('airTaskGraphEdgeGroup') + zhT('airTaskGraphManualSuffix') + '] 待归类任务'],
      '邻居按出/入边分列，手动关系标出来');
    // 「在 Air 中打开 ↗」是 task-graph.js 自己 set 的 onclick，跳的是硬 URL（window.open
    // 新标签页），不是外壳的 navigate —— 这里把 window.open 换掉来验它到底跳去哪。
    await page.evaluate(`window.__opened = []; window.open = url => { window.__opened.push(url); return null; }`);
    await page.evaluate(`document.getElementById('tg-node-open').click()`);
    assert.deepEqual(await page.evaluate(`window.__opened`), [`/air?dir=${dirId}&task=t-board`]);
    await page.screenshot('02-taskgraph-node-modal');
    // 关：× 一颗就够（另一条路是点遮罩空白处）。
    await page.evaluate(`document.querySelector('#tg-node-card .mn-close').click()`);
    assert.equal(await page.evaluate(`document.getElementById('tg-node-modal').classList.contains('open')`), false, '关闭收起弹窗');

    // ── ⑥ 空数据：空态要真的看得见，不只是存在 ───────────────────────────
    graphPayload = emptyGraph;
    await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].find(b => b.textContent.includes('刷新')).click()`);
    assert.ok(await page.waitFor(`document.getElementById('tg-graph-empty').checkVisibility() === true`), '空数据时空态可见');
    assert.equal(await text('#tg-graph-empty'), zhT('airTaskGraphEmpty'));
    assert.equal(await text('#tg-graph-count-pill'), '', '没节点时计数徽标是空的');
    assert.equal(await page.evaluate(`document.querySelectorAll('#tg-graph-svg .tg-node').length`), 0, '画布上不留旧节点');
    assert.deepEqual(graphCalls, [200, 200], '刷新是真重拉，不是重画缓存');
    await page.screenshot('03-taskgraph-empty');

    // ── ⑦ 刷新（有数据）：invalidate 之后再强制重拉一次 ──────────────────
    graphPayload = { nodes, edges, meta: { ...graphMeta, durationMs: 11 } };
    await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].find(b => b.textContent.includes('刷新')).click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#tg-graph-svg .tg-node').length === ${nodes.length}`), '刷新后节点回来');
    assert.equal(await page.evaluate(`document.getElementById('tg-graph-empty').checkVisibility()`), false, '空态收起');
    assert.equal(await page.evaluate(`window.__taskGraphLoaded === true`), true);
    assert.match(await text('#tg-graph-meta'),
      tplRe(zhT('airTaskGraphMetaServer'), { '{nc}': '\\d+', '{ec}': '\\d+', '{ms}': '11' }),
      '重拉拿的是新的一份 payload（缓存清干净了）');

    // ── ⑧ 离开再回来：面板是懒渲染的，第二次进来是一块新的画布 ───────────
    // 这就是 task-graph.js 那次改动要修的场景：只在 DOMContentLoaded 绑指针事件的话，
    // 用户点开这一页时画布还不存在，后面再进来自然也没人绑。
    await page.evaluate(`window.__firstCanvas = document.getElementById('tg-graph-canvas')`);
    const graphCallsBeforeReentry = graphCalls.length;
    await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].find(b => b.textContent.includes('返回控制台')).click()`);
    assert.ok(await page.waitFor(`document.body.classList.contains('console-open')`), '返回控制台把控制台那层放下来');
    await page.evaluate(`[...document.querySelectorAll('.admin-tool-card')].find(c => c.textContent.includes(t('airAdminPanelTaskgraph'))).click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#tg-graph-svg .tg-node').length === ${nodes.length}`), '再进来画布照样画出来');
    assert.deepEqual(await page.evaluate(`(() => {
      const canvas = document.getElementById('tg-graph-canvas');
      return { consoleClosed: !document.body.classList.contains('console-open'), fresh: canvas !== window.__firstCanvas,
        bound: canvas.__tgBound === true, nodes: document.querySelectorAll('#tg-graph-svg .tg-node').length };
    })()`), { consoleClosed: true, fresh: true, bound: true, nodes: nodes.length },
      '新画布一样绑上了指针事件（懒渲染那条路）');
    assert.equal(graphCalls.length, graphCallsBeforeReentry, '再进来读的是缓存，不再打一趟接口');

    // ── ⑨ 刷新失败：画布说一句，右下角也说一句 ───────────────────────────
    graphStatus = 500;
    await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].find(b => b.textContent.includes('刷新')).click()`);
    assert.ok(await page.waitFor(`document.getElementById('tg-graph-empty').checkVisibility() === true`), '失败也落在画布上');
    assert.match(await text('#tg-graph-empty'), tplRe(zhT('airTaskGraphLoadFailed'), { '{msg}': 'HTTP 500' }),
      '空态里带着失败原因（这句是 task-graph.js 拼的）');
    assert.equal(await page.evaluate(`window.__taskGraphLoaded === false`), true);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent === ${JSON.stringify(await page.evaluate(`t('airTaskgraphLoadFailed')`))}`),
      '右下角补一句：画布那么高，失败信息容易落在屏幕外');
  });
});
