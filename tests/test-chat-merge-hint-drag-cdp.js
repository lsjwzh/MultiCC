'use strict';

// 「当前 worktree 有可合并内容」收起后那颗琥珀色药丸（#merge-hint-fab）要能拖。
// 之前它只有样式表给的一个固定角落（右边缘、让开输入区），挡住什么就只能整个展开；
// 现在与 diff dock 那颗一样：按住跟手、松手吸附最近的左右边缘、位置记在
// sessionStorage 里（边 + 归一化纵向分数，旋转/改窗口大小自己回到界内）。
//
// 两件容易做坏的事各有一条断言：拖动结束时浏览器补的那个 click 不能被当成「点开」，
// 以及没拖过的用户看到的仍是样式表原位（含移动端那一档、安全区），不该被挪走。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const publicDir = path.resolve(__dirname, '../public');

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
routes['/auth-client.js'] = {
  headers: { 'content-type': 'text/javascript' },
  body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'`,
};
routes['/api/sessions'] = () => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, sessions: [], directories: [] }) });

// 药丸只在「提示条已就绪 + 处于收起态」时出现：先写下收起态，再把 .show 加上去，
// 模块的 MutationObserver 就会走一遍 apply()，和 chat.js 真实调用同一个入口。
// 观察器是异步的，所以加完类之后要等，不能同步断言。
const COLLAPSE = `(() => {
  try { sessionStorage.setItem('multicc.mergeHintCollapsed', '1'); } catch (_) {}
  document.getElementById('merge-hint').classList.add('show');
  return true;
})()`;

async function showFab(page) {
  await page.evaluate(COLLAPSE);
  return page.waitFor(`document.getElementById('merge-hint-fab').hidden === false`);
}


const FAB = `(() => {
  const fab = document.getElementById('merge-hint-fab');
  const r = fab.getBoundingClientRect();
  let stored = null;
  try { stored = JSON.parse(sessionStorage.getItem('multicc.mergeHintFab') || 'null'); } catch (_) {}
  return { hidden: fab.hidden, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top),
    size: Math.round(r.width), cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
    stored, collapsed: document.getElementById('merge-hint').classList.contains('collapsed'),
    barVisible: getComputedStyle(document.getElementById('merge-hint')).display !== 'none' };
})()`;

async function drag(page, from, to, steps = 6) {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left', buttons: 1, clickCount: 0,
      x: Math.round(from.x + (to.x - from.x) * i / steps),
      y: Math.round(from.y + (to.y - from.y) * i / steps),
    });
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
}

test('the collapsed merge-hint pill can be dragged and remembers where it was left', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes, screenshotDir: process.env.MULTICC_MERGE_FAB_QA_DIR || path.join(os.tmpdir(), 'multicc-merge-fab-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/chat.html?session=merge-fab');
    assert.ok(await page.waitFor(`document.getElementById('merge-hint-fab')`));

    // 没拖过：位置仍归样式表管（右侧 12px），而不是被脚本挪到别处。
    assert.ok(await showFab(page), '收起态下药丸要出现');
    const rest = await page.evaluate(FAB);
    assert.equal(rest.hidden, false);
    assert.equal(rest.right, 1188, `默认贴右边缘 12px：${JSON.stringify(rest)}`);
    assert.equal(rest.stored, null, '没拖过不该写位置');
    await page.screenshot('merge-fab-rest.png');

    // 拖到左半边中部：松手后吸附到左边缘。
    await drag(page, { x: rest.cx, y: rest.cy }, { x: 90, y: 300 });
    const dropped = await page.evaluate(FAB);
    assert.equal(dropped.left, 12, `松手要吸附最近的那条边（这次是左）：${JSON.stringify(dropped)}`);
    assert.ok(dropped.top > 100 && dropped.top < 400, `纵向跟着走，不跳回原位：${JSON.stringify(dropped)}`);
    assert.equal(dropped.stored && dropped.stored.side, 'left', `位置要写进 sessionStorage：${JSON.stringify(dropped)}`);
    // 拖动结束时补的那个 click 不能把提示条展开。
    assert.equal(dropped.collapsed, true, '拖完还是收起态，不能被当成点开');
    assert.equal(dropped.barVisible, false, '提示条不该因为一次拖动就展开');
    await page.screenshot('merge-fab-dragged-left.png');

    // 换个窗口大小：归一化分数重算，仍贴在左边缘、不出界。
    await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 500, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`(() => { window.dispatchEvent(new Event('resize')); return true; })()`);
    const resized = await page.evaluate(FAB);
    assert.equal(resized.left, 12, `改窗口后还在左边缘：${JSON.stringify(resized)}`);
    assert.ok(resized.top >= 12 && resized.top + resized.size <= 488, `改窗口后不能出界：${JSON.stringify(resized)}`);

    // 重新加载（同一标签页，sessionStorage 仍在）：位置从存储里复原。
    await page.navigate('/chat.html?session=merge-fab');
    assert.ok(await page.waitFor(`document.getElementById('merge-hint-fab')`));
    assert.ok(await showFab(page));
    const restored = await page.evaluate(FAB);
    assert.equal(restored.left, 12, `重载后要回到拖到的位置：${JSON.stringify(restored)}`);

    // 点一下（没有位移）仍然展开提示条：拖动与点按是两件事。
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: restored.cx, y: restored.cy, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: restored.cx, y: restored.cy, button: 'left', buttons: 0, clickCount: 1 });
    assert.ok(await page.waitFor(`document.getElementById('merge-hint-fab').hidden === true`),
      JSON.stringify(await page.evaluate(FAB)));
    assert.equal(await page.evaluate(`document.getElementById('merge-hint').classList.contains('collapsed')`), false);
    await page.screenshot('merge-fab-tap-expands.png');
  });
});
