'use strict';

// 「🖥 屏幕」浮层画面旁的滚轮条（触屏用）在真浏览器里的行为。
//
// 手机上单指当鼠标、双指管缩放平移，滚动只能靠这根竖条，所以要真的量：
//   · 位置：竖屏落在画面下方空白的右下角、横屏落进右侧黑边，都不许压画面；
//   · 输入：拖滚花区按格发 HTTP scroll（手指往下 = 滚轮上），点 ▲ / ▼ 一格，按住连发、
//     松手即停；落点是最后点过的位置；竖条上的按下不许漏成画面上的点击；
//   · 只看模式、桌面鼠标（本来就有滚轮）都不显示。
// 夹具走兼容（JPEG）模式：noVNC / 高清模块不挂，页面里桩掉 fetch 并记下 input。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const publicDir = path.resolve(__dirname, '../public');

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/chat-remote-screen.css" /></head><body style="margin:0">
<script>
  window.__inputs = [];
  const W = 1470, H = 956;
  let jpeg = null;
  async function frame() {
    if (jpeg) return jpeg;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#246'; g.fillRect(0, 0, W, H);
    jpeg = await new Promise(resolve => c.toBlob(resolve, 'image/jpeg', 0.6));
    return jpeg;
  }
  const realFetch = window.fetch;
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (u.includes('/api/remote-screen/capabilities')) return json({ supported: true, modifier: 'cmd' });
    // 授权齐全：不出引导条（引导条会把舞台压矮，竖屏下方空白不够放竖条）。
    if (u.includes('/api/system/agent-permissions')) return json({ ok: true, applicable: true, accessibility: true, screenRecording: true });
    if (u.includes('/api/remote-screen/wake')) return json({ ok: true, canWake: false });
    if (u.includes('/api/remote-screen/input')) { window.__inputs.push(JSON.parse(opts.body || '{}')); return json({ ok: true }); }
    if (u.includes('/api/remote-screen/frame')) {
      const blob = await frame();
      return new Response(opts.method === 'HEAD' ? null : blob, {
        headers: { 'X-Screen-Width': String(W), 'X-Screen-Height': String(H), 'content-type': 'image/jpeg' },
      });
    }
    return realFetch(url, opts);
  };
</script>
<script src="/chat-remote-screen.js"></script>
</body></html>`;

function buildRoutes() {
  const routes = { '/': { body: PAGE, headers: { 'content-type': 'text/html; charset=utf-8' } } };
  for (const file of ['chat-remote-screen.js', 'chat-remote-screen.css']) {
    routes['/' + file] = {
      body: fs.readFileSync(path.join(publicDir, file)),
      headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/css' },
    };
  }
  return routes;
}

// 画面的实际绘制区（object-fit: contain）、竖条与它三段的中心点，都是视口坐标。
const GEOMETRY = `(() => {
  const st = document.querySelector('.rs-stage').getBoundingClientRect();
  const img = document.querySelector('.rs-img');
  const k = Math.min(st.width / img.naturalWidth, st.height / img.naturalHeight);
  const dw = img.naturalWidth * k, dh = img.naturalHeight * k;
  const rail = document.querySelector('.rs-wheel');
  const r = rail.getBoundingClientRect();
  return {
    stage: { left: st.left, top: st.top, width: st.width, height: st.height },
    pic: { left: st.left + (st.width - dw) / 2, top: st.top + (st.height - dh) / 2, width: dw, height: dh },
    rail: { left: r.left, top: r.top, width: r.width, height: r.height },
    parts: [...rail.children].map(c => {
      const b = c.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, top: b.top, bottom: b.bottom };
    }),
  };
})()`;
const overlaps = (a, b) => a.left < b.left + b.width && b.left < a.left + a.width
  && a.top < b.top + b.height && b.top < a.top + a.height;
const inside = (a, b) => a.left >= b.left - 0.5 && a.top >= b.top - 0.5
  && a.left + a.width <= b.left + b.width + 0.5 && a.top + a.height <= b.top + b.height + 0.5;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function phone(page, width, height) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
}
const mouse = (page, type, x, y) => page.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
});
const takeInputs = async page => JSON.parse(await page.evaluate(
  '(() => { const out = JSON.stringify(window.__inputs); window.__inputs.length = 0; return out; })()'));
const lines = inputs => inputs.reduce((sum, body) => sum + body.amount, 0);

test('touch: the wheel rail sits beside the picture and scrolls where the user last tapped', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes() }, async page => {
    await phone(page, 390, 844);
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.navigate('/?rs=control');
    assert.ok(await page.waitFor(`document.querySelector('.rs-img')?.naturalWidth > 0
      && document.querySelector('.rs-wheel') && !document.querySelector('.rs-wheel').hidden`, { timeoutMs: 15000 }),
    'the rail shows in control mode on a touch device');
    await sleep(200);

    let g = await page.evaluate(GEOMETRY);
    assert.ok(inside(g.rail, g.stage), 'portrait: rail inside the stage');
    assert.ok(!overlaps(g.rail, g.pic), 'portrait: rail does not cover the picture');
    assert.ok(g.rail.top >= g.pic.top + g.pic.height, 'portrait: rail sits in the letterbox below the picture');

    // 点画面 25% / 40% 处：远端光标落在那里，之后的滚动都应该落在同一点。
    const tx = g.pic.left + g.pic.width * 0.25, ty = g.pic.top + g.pic.height * 0.4;
    await mouse(page, 'mousePressed', tx, ty);
    await mouse(page, 'mouseReleased', tx, ty);
    await sleep(400);
    const tap = (await takeInputs(page)).pop();
    assert.equal(tap.op, 'click');

    const [up, grip, down] = g.parts;
    // 滚花区往下拖 64px（4px 一步）= 4 格滚轮上 = +12 行。从滚花区顶端起按，
    // 指针被它捕获，拖出区域也照收（竖条高度随黑边变，不能假设滚花区够 64px）。
    const y0 = grip.top + 3;
    await mouse(page, 'mousePressed', grip.x, y0);
    for (let i = 1; i <= 16; i++) { await mouse(page, 'mouseMoved', grip.x, y0 + i * 4); await sleep(10); }
    await mouse(page, 'mouseReleased', grip.x, y0 + 64);
    await sleep(500);
    let got = await takeInputs(page);
    assert.ok(got.length >= 1 && got.every(body => body.op === 'scroll'), 'a rail drag sends only scroll ops');
    assert.equal(lines(got), 12, 'drag down 64px = 4 notches up');
    assert.ok(got.every(body => body.x === tap.x && body.y === tap.y), 'scroll lands on the last tapped point');

    // 往上拖 32px = 2 格滚轮下。
    const y1 = grip.bottom - 3;
    await mouse(page, 'mousePressed', grip.x, y1);
    for (let i = 1; i <= 8; i++) { await mouse(page, 'mouseMoved', grip.x, y1 - i * 4); await sleep(10); }
    await mouse(page, 'mouseReleased', grip.x, y1 - 32);
    await sleep(500);
    assert.equal(lines(await takeInputs(page)), -6, 'drag up 32px = 2 notches down');

    await mouse(page, 'mousePressed', down.x, down.y);
    await mouse(page, 'mouseReleased', down.x, down.y);
    await sleep(400);
    assert.deepEqual((await takeInputs(page)).map(body => body.amount), [-3], 'tap ▼ = one notch down');

    // 按住 ▲：350ms 后每 90ms 连发，松手即停。
    await mouse(page, 'mousePressed', up.x, up.y);
    await sleep(1100);
    await mouse(page, 'mouseReleased', up.x, up.y);
    await sleep(300);
    got = await takeInputs(page);
    assert.ok(lines(got) >= 18 && got.every(body => body.amount > 0), `hold ▲ repeats upward (${lines(got)} lines)`);
    await sleep(400);
    assert.deepEqual(await takeInputs(page), [], 'the repeat stops on release');

    // 横屏：竖条挪进右侧黑边，仍不压画面。
    await phone(page, 844, 390);
    await sleep(400);
    g = await page.evaluate(GEOMETRY);
    assert.ok(inside(g.rail, g.stage) && !overlaps(g.rail, g.pic), 'landscape: rail in the pillarbox');
    assert.ok(g.rail.left >= g.pic.left + g.pic.width, 'landscape: rail right of the picture');

    // 只看模式收起。
    await page.evaluate(`[...document.querySelectorAll('.rs-head .rs-btn')]
      .find(b => b.classList.contains('on')).click()`);
    assert.equal(await page.evaluate(`document.querySelector('.rs-wheel').hidden`), true, 'view-only hides the rail');
  });
});

test('desktop mouse: no rail (the real wheel already scrolls)', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/?rs=control');
    assert.ok(await page.waitFor(`document.querySelector('.rs-img')?.naturalWidth > 0`, { timeoutMs: 15000 }));
    await sleep(200);
    assert.equal(await page.evaluate(`document.querySelector('.rs-overlay').classList.contains('rs-control')
      && document.querySelector('.rs-wheel').hidden`), true);
  });
});
