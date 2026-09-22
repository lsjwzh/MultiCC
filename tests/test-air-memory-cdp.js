'use strict';
// 记忆图谱那一格这次从「嵌旧 manage 页的 iframe」改成了 Air 原生面板（air-memory.js）。
// 画布本身没有重写（力导向在 memory-graph.js、树与编辑器在 memory-controller.js），
// 所以这一页要在真浏览器里断到的不是「画得像不像」，而是「有没有接上」：
//   ① 渲染是原生的 —— #admin-content 里没有 .air-legacy-frame，也没有任何 /manage.html
//      请求（iframe 的 src 会真的发出去，所以这条能证明它没被悄悄嵌回来）；
//   ② 打开面板只打一条 GET /api/memory/graph —— 树状是懒加载，没切过去就不该打；
//   ③ 画布真的画了 —— #mem-graph-svg 里的节点数与 fixture 对得上，计数 pill 也跟上了；
//   ④ 交互真的绑上了（这是 memory-graph.js 里那次 bindCanvasOnce 补丁的回归点）——
//      canvas.__memBound 为 true，缩放进得去、memGraphResetView 还能把它复位；
//   ⑤ 面板工具条的「刷新」按当前 tab 重拉（图谱 tab 拉图谱、树状 tab 拉树）；
//   ⑥ 切到树状 tab 才打 GET /api/memory/tree，树里出现 fixture 的文件行，点行开编辑器；
//   ⑦ 编辑器保存打的是真接口（body 逐字段断言），删除先问一句：答「否」不发请求，
//      答「是」才发 DELETE；
//   ⑧ 窄屏（390px）上直接打开这一页同样是原生面板，画布不塌、不横向溢出。
//
// 文案一律用 t('key') 从页面上取回来再比（i18n 合并前后都稳）。模块内部硬编码、不走
// t() 的那几处（计数 pill 的「N 节点 / M 关联」、保存回执「✓ 已保存 · ~N tokens」、
// 删除问句、树行里的「离线/tok」等）在断言处就地说明，照它的原样比。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('the Air memory panel is native: graph from /api/memory/graph, lazy tree, real editor writes', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-air-memory-qa');
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

  // ── 夹具：图谱三个节点两条边（都挂在 d1 这一层）；树两层，四个文件行 ──────
  const ALPHA_REL = '_shared/alpha.md';
  const ALPHA_ORIG = '# Alpha\n\n第一条记忆。';
  const ALPHA_NEXT = '# Alpha\n\n改过的第一条记忆。\n';
  const node = (id, rel, title, scope, degree) => ({
    id, slug: rel.replace(/\.md$/, ''), file: rel.split('/').pop(), title,
    summary: title + ' 的摘要', type: 'project', scope, dirId: 'd1',
    size: 120, path: '/mem/' + rel, rel, tokens: 30, degree, missing: false,
  });
  const GRAPH = {
    nodes: [node('n1', ALPHA_REL, 'Alpha', 'shared', 2), node('n2', '_machine/machine.md', '机器全局', 'machine', 1), node('n3', '_cli/codex.md', 'CLI 记忆', 'cli', 1)],
    edges: [
      { source: 'n1', target: 'n2', type: 'reference', strength: 2 },
      { source: 'n1', target: 'n3', type: 'reference', strength: 1 },
    ],
    meta: {
      dirId: 'all', projects: [{ dirId: 'd1', name: 'MultiCC 主仓', count: 3 }],
      nodeCount: 3, edgeCount: 2, truncated: false, maxNodes: 600, durationMs: 7,
    },
  };
  const file = (name, rel, title, tokens) => ({ name, rel, path: '/mem/' + rel, size: 120, tokens, title, mtime: null });
  const TREE = {
    machine: { rel: '_machine', dir: '/mem/_machine', tokens: 25, files: [file('machine.md', '_machine/machine.md', '机器全局', 25)] },
    clis: [{ cli: 'codex', dir: '/mem/_cli/codex', rel: '_cli/codex', tokens: 15, files: [file('codex.md', '_cli/codex.md', 'CLI 记忆', 15)] }],
    projects: [{
      dirId: 'd1', name: 'MultiCC 主仓', dirPath: '/projects/multicc', tokens: 60, fileCount: 2,
      shared: { rel: '_shared', dir: '/mem/_shared', tokens: 30, files: [file('alpha.md', ALPHA_REL, 'Alpha', 30)] },
      skills: [], tasks: [],
      sessions: [{
        sessionId: 's1', label: '会话一', cli: 'codex', live: true, rel: 'sessions/s1', tokens: 30,
        files: [file('s1.md', 'sessions/s1/s1.md', '会话记忆', 30)],
      }],
    }],
    meta: { projectCount: 1, sessionCount: 1, fileCount: 4, tokenTotal: 100, truncated: false, maxFiles: 2000, durationMs: 4 },
  };

  const puts = [], deletes = [];
  routes['GET /api/memory/graph'] = () => json(GRAPH);
  routes['GET /api/memory/tree'] = () => json(TREE);
  routes['GET /api/memory/file'] = ({ url }) => {
    if (url.searchParams.get('rel') !== ALPHA_REL) {
      return { status: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'file not found' }) };
    }
    return json({ rel: ALPHA_REL, path: '/mem/' + ALPHA_REL, name: 'alpha.md', content: ALPHA_ORIG, size: ALPHA_ORIG.length, tokens: 30, mtime: null });
  };
  // 写入走的是 PUT（memory-model.js 的 saveFile / src/routes/memory-browser.js 的 app.put）。
  routes['PUT /api/memory/file'] = ({ body }) => {
    puts.push(JSON.parse(body));
    return json({ ok: true, rel: ALPHA_REL, path: '/mem/' + ALPHA_REL, size: 1, tokens: 123, mtime: null });
  };
  routes['DELETE /api/memory/file'] = ({ body }) => {
    deletes.push(JSON.parse(body || '{}'));
    return json({ ok: true });
  };
  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' }], clis: ['codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    const memoryCalls = () => page.requests.filter(r => r.path.startsWith('/api/memory')).map(r => `${r.method} ${r.path}`);
    // 等请求序列落到指定的尾巴上：重拉是异步的，等「节点还是 3 个」这种断言会假过
    // （旧的那批节点还在 DOM 里）。
    const waitForCalls = async (wanted, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (memoryCalls().slice(-wanted.length).join('|') === wanted.join('|')) return true;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return false;
    };
    const text = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
    const label = key => page.evaluate(`t(${JSON.stringify(key)})`);
    const transform = () => page.evaluate(`document.getElementById('mem-graph-viewport').getAttribute('transform')`);
    const scaleOf = value => Number((/scale\(([-\d.]+)\)/.exec(value) || [])[1]);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    // ── ① 从控制台的工具格进去：原生面板，不嵌旧 manage 页 ──────────────────
    await page.navigate('/air?dir=d1&view=overview');
    assert.ok(await page.waitFor(`document.body.classList.contains('console-open')`), '控制台打开');
    const T = {
      memory: await label('airAdminPanelMemory'),
      backToConsole: await label('airAdminBackToConsole'),
      refresh: await label('airAdminRefresh'),
      title: await label('memoryGraph'),
      tabGraph: await label('airMemoryTabGraph'),
      tabTree: await label('airMemoryTabTree'),
      hint: await label('airMemoryGraphHint'),
      resetView: await label('airMemoryResetView'),
      projectLabel: await label('airMemoryProjectLabel'),
      expandAll: await label('airMemoryExpandAll'),
      collapseAll: await label('airMemoryCollapseAll'),
      zoomIn: await label('airMemoryZoomIn'),
      zoomOut: await label('airMemoryZoomOut'),
      zoomReset: await label('airMemoryZoomReset'),
      nodePath: await label('airMemoryNodePath'),
      copyPath: await label('airMemoryCopyPath'),
      placeholder: await label('airMemoryFilePlaceholder'),
      save: await label('airMemorySave'),
      del: await label('delete'),
    };
    // 力导向的收敛动画靠 rAF 一帧帧走；换成固定初值（黄金螺旋 + 那几十次预热 tick）
    // 之后，缩放/复位才有确定的结果可比 —— 这不是绕开被测代码，loadMemoryGraph 的
    // 「预热出图」那条路本来就是同步的。
    await page.evaluate(`window.requestAnimationFrame = () => 0`);
    await page.evaluate(`[...document.querySelectorAll('.admin-tool-card')]
      .find(card => card.querySelector('strong')?.textContent === ${JSON.stringify(T.memory)}).click()`);
    assert.ok(await page.waitFor(`document.getElementById('task-title').textContent === ${JSON.stringify(T.title)}`), '点进去落在记忆图谱页');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0, '原生面板里没有旧 manage 的 iframe');
    assert.equal(page.requests.some(r => r.path === '/manage.html'), false, 'iframe 的 src 会真的发出去 —— 没这条请求才算真没嵌');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].map(b => b.textContent.replace(/\\s+/g,''))`),
      ['←' + T.backToConsole, '↻' + T.refresh], '工具条是面板自己的（返回控制台 / 刷新），不是旧页面的');
    assert.equal(await page.evaluate(`document.body.classList.contains('console-open')`), false, '进整页时控制台让开');
    assert.equal(await text('.air-memory-title span'), T.title, '标题沿用旧页那个 key');
    assert.equal(await text('#mem-tabs .mtab.active'), '🕸 ' + T.tabGraph, '默认落在图谱 tab');
    assert.equal(await text('#mem-tabs .mtab[data-memtab="tree"]'), '🌳 ' + T.tabTree);
    assert.equal(await text('#mem-graph-hint'), T.hint);
    // 搬过来的骨架里「自己写」的文案全走 airMemory* 新 key；下面每一条都拿 t() 比，
    // 这样 i18n 没合并（t() 退化成裸 key）时两边也一致，合并后两边一起变。
    assert.equal(await text('#mem-graph-toolbar label span'), T.projectLabel);
    assert.equal(await text('#mem-graph-toolbar button'), T.resetView);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#mem-tree-toolbar button')].map(b => b.textContent)`),
      [T.expandAll, T.collapseAll, T.refresh], '树状工具栏三颗按钮（旧页里是裸中文）');
    // data-i18n-title / -placeholder 这几组也真的翻到了（translate 用的是 title 属性）。
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.mem-zoom-btns button')].map(b => b.title)`),
      [T.zoomIn, T.zoomOut, T.zoomReset], '缩放按钮的 title');
    assert.equal(await page.evaluate(`document.getElementById('mem-node-path').title`), T.nodePath);
    assert.equal(await page.evaluate(`document.getElementById('mem-node-copy').title`), T.copyPath);
    assert.equal(await page.evaluate(`document.getElementById('mem-file-ta').placeholder`), T.placeholder);
    assert.equal(await text('#mem-file-del'), '🗑 ' + T.del, '删除按钮沿用旧页那个 key');
    assert.equal(await text('#mem-file-save'), T.save);

    // ── ② 打开面板只打图谱一条：树状是懒加载，没切过去就不该打 ──────────────
    assert.ok(await page.waitFor(`document.querySelectorAll('#mem-graph-svg .mem-node').length === 3`), '力导向画布画出了三个节点');
    assert.deepEqual(memoryCalls(), ['GET /api/memory/graph'], '打开面板只打一条图谱请求');
    assert.equal(await text('#mem-graph-count-pill'), '· 3 节点 / 2 关联',
      '计数 pill 的文案是 memory-graph.js 内部拼的（不走 t()），按原样比');
    assert.equal(await page.evaluate(`[...document.querySelectorAll('#mem-graph-project option')].map(o => o.textContent)`).then(v => v[1]),
      'MultiCC 主仓 (3)', '项目选择器列的是夹具里那一个项目');
    // 节点弹窗也画在面板根节点里（position:fixed，切走时跟面板一起被清掉）。
    assert.equal(await page.evaluate(`document.getElementById('admin-content').contains(document.getElementById('mem-node-modal'))`), true, '节点弹窗在面板里');
    assert.equal(await page.evaluate(`document.getElementById('admin-content').contains(document.getElementById('mem-file-modal'))`), true, '编辑器弹窗也在面板里');
    await page.screenshot('01-memory-native-graph');

    // ── ③ 交互真的绑上了：canvas.__memBound + 缩放进得去 / 复位回得来 ───────
    // 这是 memory-graph.js 里那次补绑（每次 loadMemoryGraph 补一次 bindCanvasOnce）
    // 的回归点：Air 的面板是懒渲染的，原来只在 DOMContentLoaded 绑一次会绑不到。
    assert.equal(await page.evaluate(`document.getElementById('mem-graph-canvas').__memBound`), true,
      '画布的指针/滚轮监听真的绑上了（不是只在 DOMContentLoaded 那次绑）');
    const before = await transform();
    await page.evaluate(`window.memGraphZoom(1.2)`);
    const zoomed = await transform();
    assert.notEqual(zoomed, before, '缩放改变了 viewport 的 transform');
    assert.ok(Math.abs(scaleOf(zoomed) - Math.min(4, scaleOf(before) * 1.2)) < 1e-6,
      `缩放的倍率就是 1.2（${scaleOf(before)} → ${scaleOf(zoomed)}）`);
    await page.evaluate(`window.memGraphResetView()`);
    assert.equal(await transform(), before, '「重置视图」把取景框放回原处');

    // ── ④ 面板工具条的「刷新」按当前 tab 重拉 ──────────────────────────────
    await page.evaluate(`document.querySelectorAll('#admin-actions button')[1].click()`);
    assert.ok(await waitForCalls(['GET /api/memory/graph']), '还在图谱 tab 时，刷新就是再拉一次图谱');
    assert.ok(await page.waitFor(`document.querySelectorAll('#mem-graph-svg .mem-node').length === 3`), '重拉之后画布又画好了');
    assert.deepEqual(memoryCalls(), ['GET /api/memory/graph', 'GET /api/memory/graph']);

    // ── ⑤ 切到树状 tab 才打树请求：树里有夹具的文件行 ──────────────────────
    await page.evaluate(`document.querySelector('#mem-tabs .mtab[data-memtab="tree"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#mem-tree .mt-proj-hdr') !== null`), '树画出来了');
    assert.ok(await waitForCalls(['GET /api/memory/graph', 'GET /api/memory/graph', 'GET /api/memory/tree']), '树状是切过去才拉的');
    assert.equal(await page.evaluate(`document.getElementById('mem-graph-pane').style.display`), 'none', '切到树状时图谱那栏收起来');
    assert.equal(await text('#mem-tabs .mtab.active'), '🌳 ' + T.tabTree);
    assert.equal(await text('#mem-tree .mt-grp-machine .mt-grp-label'), '🛡 机器全局记忆 (_machine)',
      '树的分组标题是 memory-controller.js 内部拼的（不走 t()），按原样比');
    // 切到树状之后再按刷新：这次重拉的该是树。
    await page.evaluate(`document.querySelectorAll('#admin-actions button')[1].click()`);
    assert.ok(await waitForCalls(['GET /api/memory/tree']), '树状 tab 上的刷新重拉树');
    assert.ok(await page.waitFor(`document.querySelectorAll('#mem-tree .mt-file').length === 4`), '重拉之后树又画好了');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#mem-tree .mt-body.open')].length`), 3,
      '重画之后回到默认展开态（机器全局 + CLI + 公共记忆 三组，项目与会话两层是收着的）');
    // 机器全局 / CLI 这两组默认展开，项目那一层和会话那一层要自己点开（跟旧页一样）；
    // 收着的行仍在 DOM 里（.mt-body 只是 display:none），所以这里断的是「看得见」。
    const visibleFiles = () => page.evaluate(`[...document.querySelectorAll('#mem-tree .mt-file .mt-fname')]
      .filter(n => n.checkVisibility()).map(n => n.textContent)`);
    assert.deepEqual(await visibleFiles(), ['machine.md', 'codex.md'], '默认展开的两组：机器全局记忆 + CLI 记忆');
    await page.evaluate(`document.querySelector('#mem-tree .mt-proj-hdr').click()`);
    assert.ok(await page.waitFor(`!!document.querySelector('#mem-tree .mt-file[data-rel="${ALPHA_REL}"]')?.checkVisibility()`), '项目展开后看得见文件行');
    assert.deepEqual(await visibleFiles(), ['machine.md', 'codex.md', 'alpha.md'], '展开「公共记忆」这一层，会话那一组还是收着的');
    await page.evaluate(`[...document.querySelectorAll('#mem-tree .mt-grp-session .mt-grp-hdr')].pop().click()`);
    assert.ok(await page.waitFor(`!!document.querySelector('#mem-tree .mt-file[data-rel="sessions/s1/s1.md"]')?.checkVisibility()`), '再点开会话那一组');
    assert.deepEqual(await visibleFiles(), ['machine.md', 'codex.md', 'alpha.md', 's1.md']);

    // ── ⑥ 点文件行开编辑器，保存打真接口（body 逐字段） ─────────────────────
    await page.evaluate(`document.querySelector('#mem-tree .mt-file[data-rel="${ALPHA_REL}"]').click()`);
    assert.ok(await page.waitFor(`document.getElementById('mem-file-modal').classList.contains('open')`), '编辑器弹窗开了');
    assert.ok(await page.waitFor(`document.getElementById('mem-file-ta').value === ${JSON.stringify(ALPHA_ORIG)}`), '正文是这条文件的内容');
    assert.equal(await text('#mem-file-title'), 'alpha.md');
    assert.equal(await text('#mem-file-path'), '/mem/' + ALPHA_REL, '路径来自服务端那条 payload');
    assert.deepEqual(memoryCalls().slice(-1), ['GET /api/memory/file'], '开编辑器是单独读一次这条文件');
    // 弹窗得真的铺满视口：它画在面板里，只要有没有 transform 的祖先，fixed 就还管用。
    const box = await page.evaluate(`(() => { const r = document.getElementById('mem-file-modal').getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) }; })()`);
    assert.deepEqual(box, { w: 1440, h: 900, top: 0, left: 0 }, '弹窗盖住整个视口（fixed 没有被哪个祖先的 transform 圈住）');
    await page.screenshot('02-memory-tree-editor');

    await page.evaluate(`(() => { document.getElementById('mem-file-ta').value = ${JSON.stringify(ALPHA_NEXT)};
      document.getElementById('mem-file-save').click(); })()`);
    assert.ok(await page.waitFor(`document.getElementById('mem-file-msg').textContent.length > 0`), '保存后有回执');
    assert.deepEqual(puts, [{ rel: ALPHA_REL, content: ALPHA_NEXT }], '写的是真接口，body 就这两项');
    assert.equal(await text('#mem-file-msg'), '✓ 已保存 · ~123 tokens',
      '回执是 memory-controller.js 内部拼的（不走 t()），按原样比');
    assert.equal(await page.evaluate(`document.getElementById('mem-file-ta').value === ${JSON.stringify(ALPHA_NEXT)}`), true);

    // ── ⑦ 删除：先问一句，答「否」不发请求，答「是」才发 ─────────────────────
    await page.evaluate(`window.__realConfirm = window.confirm;
      window.confirm = text => { window.__asked = (window.__asked || []).concat([text]); return false; }`);
    await page.evaluate(`document.getElementById('mem-file-del').click()`);
    await page.evaluate(`new Promise(resolve => setTimeout(resolve, 80))`); // 等一拍：答「否」也不该有请求在路上
    assert.equal(page.requests.some(r => r.method === 'DELETE'), false, '答「否」时不许发删除请求');
    assert.equal(deletes.length, 0);
    assert.equal(await page.evaluate(`document.getElementById('mem-file-modal').classList.contains('open')`), true, '答「否」时编辑器还开着');
    await page.evaluate(`window.confirm = text => { window.__asked = (window.__asked || []).concat([text]); return true; }`);
    await page.evaluate(`document.getElementById('mem-file-del').click()`);
    assert.ok(await page.waitFor(`document.getElementById('mem-file-modal').classList.contains('open') === false`), '答「是」之后编辑器收起');
    assert.deepEqual(deletes, [{ rel: ALPHA_REL }], '删的是这条文件');
    const asked = await page.evaluate(`window.__asked`);
    assert.equal(asked.length, 2, '两次都先问了（只差一个答案）');
    // 问句是 memory-controller.js 内部拼的中文（不走 t()），这里只断「问到了这一条」。
    assert.equal(asked.every(q => String(q).includes('alpha.md')), true, '问句里带着要删的那个文件名');
    await page.evaluate(`window.confirm = window.__realConfirm`);
    await page.screenshot('03-memory-after-delete');

    // ── ⑧ 窄屏：直接打开这一页照样是原生面板，画布不塌 ─────────────────────
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await page.navigate('/air?dir=d1&view=memory');
    assert.ok(await page.waitFor(`document.querySelectorAll('#mem-graph-svg .mem-node').length === 3`), '窄屏上直接打开这一页照样渲染');
    assert.equal(await page.evaluate(`document.querySelectorAll('#admin-content .air-legacy-frame').length`), 0);
    const narrow = await page.evaluate(`(() => {
      const canvas = document.getElementById('mem-graph-canvas');
      const box = canvas.getBoundingClientRect();
      return { h: Math.round(box.height), w: Math.round(box.width), right: Math.round(box.right), vw: window.innerWidth };
    })()`);
    assert.ok(narrow.h >= 420, `窄屏上画布不塌（高 ${narrow.h}，最低 420）`);
    assert.ok(narrow.right <= narrow.vw + 1, `画布不横向溢出（${narrow.right} vs ${narrow.vw}）`);
    await page.screenshot('04-memory-native-mobile');
    // 保存/删除这类请求在整个流程里只发生上面那一次，后面没有再补发。
    assert.equal(puts.length, 1);
  });
});
