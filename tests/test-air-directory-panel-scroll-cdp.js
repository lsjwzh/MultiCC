'use strict';
// 目录首页那张任务卡在真浏览器里的滚动形状 —— 手机与桌面两档。
//
// 用户要的（原文）：「滑动到任务列表，如果列表内容很少，就没有分页，当作简单的动态
// 高度列表。如果内容超过了一页，则高度应该撑满页面。当滑动到列表，就卡住表头，然后
// 滚动列表，等列表到底部再继续往下。往上也一样。」PC：「设置一个大概的固定高度，
// 让用户自行滑动内部。」
//
// 实现是**一个滚动容器 + 一个 sticky 表头**：抬头和筛选包在
// `#directory-task-panel-head` 里，面板分页时（`.is-paged`）它 `position: sticky;
// top: 0` 钉在 `#empty` 这个唯一滚动口上；行继续滚，面板走完表头自己撒手。
// 没有第二个滚动容器，也就没有「现在该谁滚」这份要被接力维护的状态 —— 这一组断言
// 钉的正是「接力不存在」这件事：钉住期间行与页面严格同位移（同一层滚动），
// 而不是「表头不动、行自己动」。
//
// 桌面相反：面板固定高 min(560px, 65vh)，清单自己内滚，页面纹丝不动。
// 断点复用 air.css 里唯一那条手机档（≤760px），这里不另立一个数。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const SHOT_DIR = path.join(os.tmpdir(), 'multicc-air-panel-shots');

function buildRoutes(state) {
  const publicDir = path.resolve(__dirname, '../public');
  const routes = {};
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const types = { js: 'text/javascript', css: 'text/css', html: 'text/html', svg: 'image/svg+xml' };
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html|svg)$/.test(f))) {
    routes['/' + file] = {
      body: fs.readFileSync(path.join(publicDir, file)),
      headers: { 'content-type': `${types[file.slice(file.lastIndexOf('.') + 1)]}; charset=utf-8` },
    };
  }
  const sharedDir = path.join(publicDir, 'shared');
  if (fs.existsSync(sharedDir)) {
    for (const file of fs.readdirSync(sharedDir).filter(f => f.endsWith('.js'))) {
      routes['/shared/' + file] = {
        body: fs.readFileSync(path.join(sharedDir, file)),
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      };
    }
  }
  routes['/air'] = routes['/air.html'];
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: 'window.multiccWsUrl=async url=>url' };
  routes['/chat.html'] = { body: '<!doctype html><meta charset="utf-8"><title>frame</title>', headers: { 'content-type': 'text/html; charset=utf-8' } };
  routes['/api/air'] = () => {
    // 稀疏那一档（3 条，一页装得下）由测试直接翻这个开关 —— 页面自己的 URL 查询串
    // 不会带到 /api/air 上，所以「?few=1」得走这里。
    const count = state.sparse ? 3 : 45;
    const tasks = Array.from({ length: count }, (_, i) => {
      const n = i + 1;
      return {
        id: `tsk-${String(n).padStart(2, '0')}`, dirId: 'd1',
        title: `目录任务 ${String(n).padStart(2, '0')}`,
        status: 'active', runState: 'idle',
        updatedAt: 1000 + n, lastMessageAt: 2000 - n,
        resource: { residency: 'planned', lease: 'idle' },
      };
    });
    return json({
      ok: true,
      directories: [{ id: 'd1', name: 'MultiCC', path: '/projects/multicc', worktreeCount: 0 }],
      clis: ['codex'], migration: { errors: [] },
      tasks, sessions: [],
    });
  };
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/git/directory-status'] = () => json({ branch: 'main', upstream: 'origin/main', baseBranch: 'main', ahead: 0, behind: 0, dirtyFiles: [] });
  routes['/api/git/log'] = () => json({ commits: [] });
  routes['/api/task-board/search'] = () => json({ ok: true, hits: [] });
  routes['/api/search/messages'] = () => json({ ok: true, messageHits: [] });
  return routes;
}

// 页面里那份几何读数。一个滚动口（#empty）+ 面板 + 表头 + 清单 + 分页条。
const GEOM = `(() => {
  const e = document.getElementById('empty');
  const p = document.getElementById('directory-task-panel');
  const h = document.getElementById('directory-task-panel-head');
  const l = document.getElementById('directory-task-list');
  const pg = document.getElementById('directory-task-pager');
  const form = document.getElementById('quick-task-form');
  const box = el => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height, left: b.left, width: b.width }; };
  const eb = box(e), pb = box(p), hb = box(h), lb = box(l), gb = box(pg), fb = box(form);
  return {
    scrollTop: e.scrollTop, maxScroll: e.scrollHeight - e.clientHeight,
    emptyTop: eb.top, emptyBottom: eb.bottom, clientH: e.clientHeight,
    panelTop: pb.top, panelBottom: pb.bottom, panelH: pb.h,
    panelOverflow: getComputedStyle(p).overflow, panelMinH: p.style.minHeight,
    paged: p.classList.contains('is-paged'),
    headTop: hb.top, headH: hb.h, headPos: getComputedStyle(h).position,
    listTop: lb.top, listH: lb.h, listScrollTop: l.scrollTop,
    listLeft: lb.left, listWidth: lb.width,
    listClientH: l.clientHeight, listScrollH: l.scrollHeight,
    listOverflowY: getComputedStyle(l).overflowY,
    pagerTop: gb.top, pagerBottom: gb.bottom, pagerHidden: pg.hidden,
    formTop: fb.top, formBottom: fb.bottom,
    rows: l.querySelectorAll('.directory-task-row').length,
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
  };
})()`;

// 真触摸：Input.synthesizeScrollGesture 在这台机器的 headless 里是空操作，
// 所以自己按 touchStart/Move…/End 造手势。scroll 为负 = 手指上滑 = 内容往下走。
async function touchDrag(page, { x, y, scroll, steps = 14, stepMs = 16, holdMs = 120, settleMs = 260 }) {
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (scroll * i) / steps }] });
    await new Promise(r => setTimeout(r, stepMs));
  }
  // 停一下再抬手 = 不带惯性，位置可预期。
  await new Promise(r => setTimeout(r, holdMs));
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise(r => setTimeout(r, settleMs));
}

// sticky 的**通用不变量**：表头永远待在它的包含块（面板）里，能钉就钉在滚动口顶。
//   headTop = min( max(emptyTop, panelTop), panelBottom - headH )
// 三个区间各自对上：
//   面板还没到       → panelTop（跟着页面走）
//   面板罩住滚动口顶 → emptyTop（钉住）
//   面板快走完       → panelBottom - headH（被面板底边顶着往上）
// 这条不变量与「下面还有多少内容」无关，所以正是用户那句「等列表到底部再继续往下」
// 在所有页面高度下的准确说法。
function assertStickyInvariant(g, where) {
  const expected = Math.min(Math.max(g.emptyTop, g.panelTop), g.panelBottom - g.headH);
  assert.ok(Math.abs(g.headTop - expected) <= 1.5,
    `${where}：表头没有越出面板也没脱轨 —— headTop=${g.headTop} 期望=${expected}` +
    `（panelTop=${g.panelTop} panelBottom=${g.panelBottom} headH=${g.headH} emptyTop=${g.emptyTop}）`);
}

// 手势起点落在某个元素的可视区里（元素可能被滚动口裁掉一部分，取交集中心）。
async function dragFrom(page, elementId, scroll, opts = {}) {
  const point = await page.evaluate(`(() => {
    const e = document.getElementById(${JSON.stringify(elementId)});
    const sc = document.getElementById('empty');
    const b = e.getBoundingClientRect(), s = sc.getBoundingClientRect();
    const top = Math.max(b.top, s.top) + 8, bottom = Math.min(b.bottom, s.bottom, window.innerHeight) - 8;
    return { x: Math.round(b.left + b.width / 2), y: Math.round((top + bottom) / 2) };
  })()`);
  assert.ok(point && point.y > 0, `手势起点落在 ${elementId} 里：${JSON.stringify(point)}`);
  await touchDrag(page, { x: point.x, y: point.y, scroll, ...opts });
  return point;
}

test('目录任务卡：手机表头钉住（没有接力），桌面固定高度内滚', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const shots = [];
  const state = { sparse: false };
  await withCdpHarness({ routes: buildRoutes(state), screenshotDir: SHOT_DIR }, async page => {
    const shot = async name => { shots.push(await page.screenshot(name)); };

    await page.send('Emulation.setDeviceMetricsOverride', MOBILE);
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===20`),
      '一页 20 条');
    assert.ok(await page.waitFor(`document.getElementById('directory-task-panel').classList.contains('is-paged')`),
      '45 条 → 分页，面板带上 .is-paged');

    const g0 = await page.evaluate(GEOM);
    assert.equal(g0.paged, true);
    assert.equal(g0.pagerHidden, false, '分页条露面');
    assert.equal(g0.headPos, 'sticky', '手机档表头是 sticky（桌面档不是）');
    assert.equal(g0.panelOverflow, 'visible', '面板不能再是 overflow:hidden —— 那会把它变成表头的滚动祖先，钉住范围变 0');
    assert.ok(Math.abs(parseFloat(g0.panelMinH) - g0.clientH) <= 1,
      `分页时面板被撑到一个滚动口高：panelMinH=${g0.panelMinH} clientH=${g0.clientH}`);
    assert.ok(g0.headTop > g0.emptyTop + 5, `起点：表头还在滚动口下面（未钉住）：headTop-emptyTop=${g0.headTop - g0.emptyTop}`);
    assert.equal(g0.overflowX, false, '这一页不该横向溢出');

    // (a) 还没滚到面板：页面滚多少，表头跟着走多少。
    const before = g0;
    await dragFrom(page, 'directory-stats', -140);
    let g = await page.evaluate(GEOM);
    assert.ok(g.scrollTop > before.scrollTop + 80, `页面确实滚了：${before.scrollTop}→${g.scrollTop}`);
    assert.ok(Math.abs((before.headTop - g.headTop) - (g.scrollTop - before.scrollTop)) < 2,
      `未到面板时表头跟着页面走：表头位移=${before.headTop - g.headTop} 滚动=${g.scrollTop - before.scrollTop}`);
    assertStickyInvariant(g, '还没滚到面板时');

    // (b) 一直滚到表头贴住滚动口顶 = 钉住。
    for (let guard = 0; guard < 40; guard++) {
      g = await page.evaluate(GEOM);
      if (g.headTop - g.emptyTop <= 1.5) break;
      await touchDrag(page, { x: 195, y: 700, scroll: -Math.max(50, Math.min(180, g.headTop - g.emptyTop + 20)) });
    }
    g = await page.evaluate(GEOM);
    assert.ok(Math.abs(g.headTop - g.emptyTop) <= 1.5,
      `表头钉在滚动口顶：headTop-emptyTop=${g.headTop - g.emptyTop}（表头是 #empty 的直接内容，钉住位置就是内容盒顶）`);
    assert.ok(g.panelBottom >= g.emptyBottom - 1,
      `钉住那一刻面板盖满可视区：panelBottom=${g.panelBottom} emptyBottom=${g.emptyBottom}`);
    assert.equal(g.headPos, 'sticky');
    await shot('mobile-01-pinned');

    // (c) 表头钉住之后继续滚：表头纹丝不动，**行随页面同位移** —— 只有一个滚动容器，
    //     所以不存在「接力」。这一条就是「没有接力」的证明。
    const pinned = g;
    await touchDrag(page, { x: 195, y: 700, scroll: -150 });
    g = await page.evaluate(GEOM);
    assert.ok(Math.abs(g.headTop - g.emptyTop) <= 1.5, `钉住期间表头纹丝不动：${g.headTop - g.emptyTop}`);
    assert.ok(Math.abs((pinned.listTop - g.listTop) - (g.scrollTop - pinned.scrollTop)) < 2,
      `行与页面严格同位移（同一层滚动，没有第二个滚动口）：行位移=${pinned.listTop - g.listTop} 滚动=${g.scrollTop - pinned.scrollTop}`);
    // 手机上清单**不是内滚容器**（overflow: hidden 只为自己收圆角）。它必须没有
    // 可滚的溢出，否则这份 hidden 就会把行裁掉。
    assert.notEqual(g.listOverflowY, 'auto', '手机上清单不是内滚容器');
    assert.notEqual(g.listOverflowY, 'scroll', '手机上清单不是内滚容器');
    assert.equal(g.listScrollTop, 0, '清单自己没有滚动位置');
    assert.ok(g.listScrollH <= g.listClientH + 1,
      `清单没有可滚的溢出（否则 hidden 会裁行）：scrollH=${g.listScrollH} clientH=${g.listClientH}`);
    await shot('mobile-02-row-scrolls');

    // (d) 钉住这一段里，通用不变量一路成立（表头没有越出面板、也没有脱轨）。
    for (let i = 0; i < 6; i++) {
      await touchDrag(page, { x: 195, y: 700, scroll: -160 });
      g = await page.evaluate(GEOM);
      assertStickyInvariant(g, `钉住段第 ${i + 1} 次拖动后`);
    }
    assert.ok(Math.abs(g.headTop - g.emptyTop) <= 1.5, '这一段里表头始终钉着');
    await shot('mobile-03-pinned-scrolling');

    // (e) 面板走完 → 表头撒手。手机这一页面板**已经是最后一个高块**（下面只剩输入
    //     框），所以「面板底边顶开表头」在真实页面里根本走不到 —— 这正是接受的那条
    //     （内容不够就不撒手，不塞占位）。要看撒手，就在面板后面临时垫一段尾巴，
    //     把「下面还有内容」这个条件造出来 —— 探针只测 CSS 机制，不是产品页面。
    await page.evaluate(`(() => {
      const d = document.createElement('div');
      d.id = '__probe_tail';
      d.style.height = '1200px';
      d.style.flex = '0 0 auto';
      document.getElementById('empty').appendChild(d);
    })()`);
    await page.evaluate(`document.getElementById('empty').scrollTop = 1e9`);
    assert.ok(await page.waitFor(`(() => { const e=document.getElementById('empty'); return Math.abs(e.scrollTop-(e.scrollHeight-e.clientHeight))<=1; })()`));
    const tailG = await page.evaluate(GEOM);
    assert.ok(tailG.headTop - tailG.emptyTop < -1.5,
      `面板走完表头就撒手（不再钉住）：headTop-emptyTop=${tailG.headTop - tailG.emptyTop}`);
    assertStickyInvariant(tailG, '垫了尾巴滚到底时');
    assert.ok(Math.abs((tailG.panelBottom - tailG.headH) - tailG.headTop) <= 1.5,
      '撒手时表头正好被面板底边顶着（sticky 的收尾位置）');
    await shot('mobile-04-released');
    await page.evaluate(`document.getElementById('__probe_tail')?.remove()`);

    // (f) 往回滚：表头重新钉住，再一路回到页首时回到自然位置（对称）。
    for (let guard = 0; guard < 40; guard++) {
      g = await page.evaluate(GEOM);
      if (Math.abs(g.headTop - g.emptyTop) <= 1.5) break;
      await touchDrag(page, { x: 195, y: 300, scroll: 260 });
    }
    g = await page.evaluate(GEOM);
    assert.ok(Math.abs(g.headTop - g.emptyTop) <= 1.5,
      `反向滚回来表头重新钉住：headTop-emptyTop=${g.headTop - g.emptyTop}`);
    for (let guard = 0; guard < 60 && g.scrollTop > 0; guard++) {
      await touchDrag(page, { x: 195, y: 300, scroll: 320 });
      g = await page.evaluate(GEOM);
    }
    assert.equal(g.scrollTop, 0, '从任务行反向上滑能一路回到页首（没有内层滚动锁住手势）');
    assert.ok(g.headTop > g.emptyTop + 5, `回到页首后表头回到自然位置（撒手）：${g.headTop - g.emptyTop}`);
    assertStickyInvariant(g, '回到页首时');

    // (g) 高强度 fling + 中途反向：不卡死、不跳变、不产生非法状态。
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 700 }] });
    for (let i = 1; i <= 12; i++) {
      await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: 700 - i * 40 }] });
      await new Promise(r => setTimeout(r, 8));
    }
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise(r => setTimeout(r, 300));
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 300 }] });
    for (let i = 1; i <= 10; i++) {
      await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: 300 + i * 40 }] });
      await new Promise(r => setTimeout(r, 8));
    }
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise(r => setTimeout(r, 700));
    const flung = await page.evaluate(GEOM);
    assert.ok(flung.scrollTop >= 0 && flung.scrollTop <= flung.maxScroll,
      `fling + 反向之后停在合法位置：${flung.scrollTop}/${flung.maxScroll}`);
    assert.ok(flung.headTop - flung.emptyTop >= -2,
      `表头不可能跑到滚动口上面去（撒手后也只是随内容上移）：${flung.headTop - flung.emptyTop}`);
    assertStickyInvariant(flung, 'fling 之后');

    // (h) 滚到底：分页条整条露在 sticky 输入框之上（输入框浮在滚动口下沿）。
    await page.evaluate(`document.getElementById('empty').scrollTop = document.getElementById('empty').scrollHeight`);
    assert.ok(await page.waitFor(`(() => { const e=document.getElementById('empty'); return Math.abs(e.scrollTop-(e.scrollHeight-e.clientHeight))<=1; })()`));
    const tail = await page.evaluate(GEOM);
    assert.ok(tail.pagerBottom <= tail.formTop + 1,
      `滚到底时分页条整条在输入框之上：pagerBottom=${tail.pagerBottom} formTop=${tail.formTop}`);
    await shot('mobile-05-bottom-above-composer');

    // (i) 稀疏那一档：不分页 → 动态高度，表头不 sticky，也没有被 JS 撑高。
    state.sparse = true;
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===3`));
    const sparse = await page.evaluate(GEOM);
    assert.equal(sparse.paged, false, '3 条不分页');
    assert.equal(sparse.pagerHidden, true, '一页装得下就没有分页条');
    assert.notEqual(sparse.headPos, 'sticky', '不分页时表头是普通流内元素');
    assert.equal(sparse.panelMinH, '', '不分页时没有 JS 撑高');
    assert.ok(sparse.panelH < sparse.clientH - 100, `面板按内容自然高度：panelH=${sparse.panelH} clientH=${sparse.clientH}`);
    await shot('mobile-06-sparse');

    // (j) 桌面 1440x900：面板固定高 = min(560, 65vh)，清单自己内滚，页面不动。
    state.sparse = false;
    await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===20`));
    assert.ok(await page.waitFor(`document.getElementById('directory-task-panel').classList.contains('is-paged')`));
    let d = await page.evaluate(GEOM);
    assert.equal(d.paged, true);
    assert.notEqual(d.headPos, 'sticky', '桌面档表头不需要 sticky：它本来就在清单上面');
    assert.ok(Math.abs(d.panelH - Math.min(560, 0.65 * 900)) <= 1,
      `面板固定高 = min(560px, 65vh)：panelH=${d.panelH}`);
    assert.equal(d.panelMinH, '', '桌面档不吃手机那档的 min-height');
    assert.equal(d.listOverflowY, 'auto', '清单自己有内滚');
    assert.ok(d.listScrollH > d.listClientH + 40, `清单内容比它自己高：${d.listScrollH} > ${d.listClientH}`);
    const pageTop = await page.evaluate(`document.getElementById('empty').scrollTop`);
    // 在清单内部拖：只有清单动，页面纹丝不动。
    await dragFrom(page, 'directory-task-list', -160);
    d = await page.evaluate(GEOM);
    assert.ok(d.listScrollTop > 40, `清单内滚生效：${d.listScrollTop}`);
    assert.equal(await page.evaluate(`document.getElementById('empty').scrollTop`), pageTop, '内滚时页面不动');
    await shot('desktop-01-fixed-height');
    // 内滚到底之后继续滑，页面仍然不动（overscroll 被吃掉）。
    for (let i = 0; i < 6; i++) await dragFrom(page, 'directory-task-list', -200);
    const stuck = await page.evaluate(GEOM);
    assert.equal(stuck.listScrollTop, stuck.listScrollH - stuck.listClientH, '清单已经滚到底');
    assert.equal(await page.evaluate(`document.getElementById('empty').scrollTop`), pageTop,
      '内滚到底后继续滑，页面仍不动（overscroll-behavior: contain）');
    await shot('desktop-02-inner-scroll-end');

    // (k) 桌面稀疏档：不分页 → 自然高度，也不内滚。
    state.sparse = true;
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===3`));
    const dSparse = await page.evaluate(GEOM);
    assert.equal(dSparse.paged, false);
    assert.equal(dSparse.listOverflowY, 'visible', '桌面不分页时清单不内滚');
    assert.ok(dSparse.panelH < 560, `桌面上稀疏档按内容自然高度：panelH=${dSparse.panelH}`);
    await shot('desktop-03-sparse');

    assert.deepEqual(await page.evaluate('window.__errors || []'), []);
  });
  fs.writeFileSync(path.join(SHOT_DIR, 'manifest.json'), JSON.stringify(shots, null, 2));
  console.log('screenshots:\n' + shots.join('\n'));
});
