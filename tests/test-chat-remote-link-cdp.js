'use strict';

// 聊天消息里的远控链接（`#rs=control`）在真浏览器里点一下会怎样。
//
// 这是「页面带走」那个 bug 的现场复现：chat.html 带 `<base href="/">`，于是消息里
// `[点这里](#rs=control)` 解析出来的绝对地址是 `http://<host>/#rs=control` —— 点一下
// 整页跑到目录首页，屏幕浮层永远打不开。修正（渲染后把 rs 从 hash 挪进 query）与拦截
// （捕获阶段 preventDefault + 原地开浮层）都是浏览器行为：
//
//   · 命中测试与默认动作要真的走一遍浏览器（合成一次受信任的点击），
//     `element.click()` 与 DOM shim 都量不出「有没有跳走」；
//   · 「右键 / ⌘ 点击照旧开新标签页」是用户要的逃生口，拦多了同样是 bug。
//
// 页面是与 chat.html 同形的夹具：同一个 `<base href="/">`、同两个真模块、同样形态的
// markdown 输出（纯 <a href>）。判定表与静态接线在 tests/test-chat-remote-links.js。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const publicDir = path.resolve(__dirname, '../public');
const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// 夹具页：<base href="/"> 是复现的前提，缺了它这个测试就什么都证不了。
const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><base href="/" />
<link rel="stylesheet" href="/chat-remote-screen.css" /></head><body>
<button id="notify-btn" type="button">通知</button>
<div id="messages"></div>
<script>
  // chat-history-view 渲染出来的 markdown 就是这个形状：纯 <a href>，没有 target。
  document.getElementById('messages').innerHTML =
    '<p>需要你上手：<a href="#rs=control">🖥 点这里直接操作屏幕</a></p>'
    + '<p><a id="cross" href="http://127.0.0.1:3000/chat.html?air=1&task=tsk_a&rs=1">🖥 屏幕</a></p>';
</script>
<script src="/chat-remote-links.js"></script>
<script src="/chat-remote-screen.js"></script>
</body></html>`;

function buildRoutes() {
  const routes = { '/': { body: PAGE, headers: { 'content-type': 'text/html; charset=utf-8' } } };
  for (const file of ['chat-remote-links.js', 'chat-remote-screen.js', 'chat-remote-screen.css']) {
    routes['/' + file] = {
      body: fs.readFileSync(path.join(publicDir, file)),
      headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/css' },
    };
  }
  // 权限门：applicable:false 走「查不到」这条路，不挡出帧（真机上授权与否不归这里管）。
  routes['/api/system/agent-permissions'] = () => json({ ok: true, applicable: false });
  return routes;
}

const screenshotDir = () => process.env.MULTICC_REMOTE_LINK_QA_DIR
  || path.join(os.tmpdir(), 'multicc-remote-link-qa');

// 请求记录在 Node 侧，页面的 waitFor 够不着：轮询同一份记录等它出现。
async function waitForRequest(page, pathname, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.requests.some(request => request.path === pathname)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

const overlayState = `(() => {
  const ov = document.querySelector('.rs-overlay');
  return {
    url: location.href,
    open: !!ov,
    control: !!ov && ov.classList.contains('rs-control'),
    head: ov ? (ov.querySelector('.rs-head')?.textContent || '') : '',
  };
})()`;

test('a message link opens the real screen overlay in place instead of leaving the page', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  await withCdpHarness({ routes: buildRoutes(), screenshotDir: screenshotDir() }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/');
    const pageUrl = new URL('/', page.baseUrl).href;

    // ① 先量 bug 的成因：`<base href="/">` 下这条纯 fragment 的链接指向站点根，
    //    没有修正的话点一下就是一次整页导航。
    const trap = await page.evaluate(`(() => {
      const a = document.querySelector('#messages a');
      return { raw: a.getAttribute('href'), resolved: a.href };
    })()`);
    assert.equal(trap.raw, '#rs=control');
    assert.equal(trap.resolved, `${pageUrl}#rs=control`, '带 <base> 的页面把纯 fragment 解析到站点根');

    // ② 渲染后的修正（chat-history-view 对每段 markdown 做的事）：rs 从 hash 挪进
    //    query，落在本页；右键「在新标签页打开」于是也去到对的那一页。
    const fixed = await page.evaluate(`(() => {
      window.MultiCCChatRemoteLinks.fixupRemoteScreenLinks(document.getElementById('messages'));
      const a = document.querySelector('#messages a');
      return { href: a.href, url: location.href };
    })()`);
    assert.equal(fixed.href, new URL('/?rs=control', page.baseUrl).href);
    assert.equal(fixed.url, pageUrl, '修正 href 本身不该动地址栏');

    // ③ 真点一下（受信任的点击：走浏览器自己的命中测试与默认动作）。
    assert.equal(page.requests.filter(r => r.path === '/api/remote-screen/frame').length, 0,
      '还没点，就不该有出帧请求');
    // 一个跨不过重载的标记：地址栏对不上会被 replaceState 掩掉（新页消费掉 rs 之后
    // 又变回本页地址），只有它还在才真的证明「没有重新加载过」。
    await page.evaluate(`window.__rsSameDocument = 'yes'`);
    const box = await page.evaluate(`(() => {
      const r = document.querySelector('#messages a').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    const mouse = type => page.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: 'left',
      buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
    await mouse('mousePressed');
    await mouse('mouseReleased');

    assert.ok(await page.waitFor(`!!document.querySelector('.rs-overlay')`), '屏幕浮层要在本页展开');
    const opened = await page.evaluate(overlayState);
    assert.equal(opened.url, pageUrl, '点远控链接不许把页面带走 —— 这正是修的那个 bug');
    assert.equal(await page.evaluate(`window.__rsSameDocument`), 'yes',
      '是原地开浮层，不是「跳一趟再自己开」：这一页一次都不许重新加载');
    assert.equal(opened.control, true, 'rs=control 进来就是可操作模式');
    assert.match(opened.head, /🖥/, '浮层是「🖥 屏幕」那一层');
    assert.ok(await waitForRequest(page, '/api/remote-screen/frame'), '浮层起来了要真的去取帧');

    // ④ 跨设备形态的完整链接（agent 按 127.0.0.1 写的）同样原地开，不跳走。
    await page.evaluate('window.MultiCCRemoteScreen.close()');
    const crossBox = await page.evaluate(`(() => {
      const r = document.getElementById('cross').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    const crossMouse = type => page.send('Input.dispatchMouseEvent', {
      type, x: crossBox.x, y: crossBox.y, button: 'left',
      buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
    await crossMouse('mousePressed');
    await crossMouse('mouseReleased');
    assert.ok(await page.waitFor(`!!document.querySelector('.rs-overlay')`), '环回地址的跨设备链接也开本页浮层');
    const cross = await page.evaluate(overlayState);
    assert.equal(cross.url, pageUrl, '这条链接指向 127.0.0.1，页面更不该被带走');
    assert.equal(cross.control, false, 'rs=1 是只看，不进可操作模式');

    // ⑤ 逃生口：⌘/Ctrl 点击、右键不在拦截之列，照旧交给浏览器（新标签页 / 菜单）。
    //    事件没被取消就是证据；拦错了这里会变成 false 并且浮层又冒出来。
    await page.evaluate('window.MultiCCRemoteScreen.close()');
    const escaped = await page.evaluate(`(() => {
      const a = document.querySelector('#messages a');
      const notCanceled = [0, 2].map(button => {
        const event = new MouseEvent('click', { bubbles: true, cancelable: true, button, ctrlKey: button === 0 });
        return a.dispatchEvent(event);
      });
      return { notCanceled, url: location.href, overlay: !!document.querySelector('.rs-overlay') };
    })()`);
    assert.deepEqual(escaped.notCanceled, [true, true], '⌘ 点击与右键必须留给浏览器');
    assert.equal(escaped.overlay, false, '修饰键点击不该在本页开浮层');
    assert.equal(escaped.url, pageUrl, '留给浏览器也不该把这一页点走（新标签页是浏览器自己的事）');
  });
});
