'use strict';

// 聊天消息里的远控链接（multicc-human-assist 的 `#rs=control` / `#rs=1`）要在**本页**
// 展开「🖥 屏幕」浮层，而不是把整页带走。这个测试钉三件事：
//
//   1. linkMode 的判定表 —— 与 App 端 message_bubble.dart 的 remoteScreenLinkMode
//      是同一张表（环回地址、无 scheme 配置、hash/query 两种 rs 位置、外站不认）。
//   2. 点击拦截的放行条件 —— 只要有一条不满足就交给浏览器：右键与中键、带修饰键的
//      点击、分享页、页面上没有浮层、外站链接。用户明确要的逃生口（右键「在新标签页
//      打开」）就是靠这些分支活着。
//   3. href 修正与静态接线 —— `<base href="/">` 把纯 fragment 解析到站点根，渲染后
//      必须把 rs 挪进 query；chat.html 的加载顺序与 chat.js / chat-history-view.js
//      的挂点是这条链路唯一的两处接线，掉了就静默失效。
//
// 真浏览器里的导航语义（点了到底有没有跳走、浮层有没有真的出现）由
// tests/test-chat-remote-link-cdp.js 证 —— 这里只跑判定与接线。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'chat-remote-links.js'), 'utf8');
const CHAT_HTML = fs.readFileSync(path.join(ROOT, 'public', 'chat.html'), 'utf8');
const CHAT_JS = fs.readFileSync(path.join(ROOT, 'public', 'chat.js'), 'utf8');
const HISTORY_VIEW = fs.readFileSync(path.join(ROOT, 'public', 'chat-history-view.js'), 'utf8');
const REMOTE_SCREEN = fs.readFileSync(path.join(ROOT, 'public', 'chat-remote-screen.js'), 'utf8');
const MESSAGE_BUBBLE = fs.readFileSync(path.join(ROOT, 'app', 'lib', 'widgets', 'message_bubble.dart'), 'utf8');

// 极简 DOM：模块只用到 addEventListener 与 querySelectorAll('a[href]')，锚点也只用
// getAttribute / href / dataset / closest。桩太小会漏掉真 bug，所以这里把「点击」
// 做成真发一遍捕获阶段的事件（模块注册在 document 上，第三个参数是 capture）。
function createAnchor(raw) {
  const anchor = {
    dataset: {},
    textContent: raw,
    _href: raw,
    getAttribute: name => (name === 'href' ? raw : null),
    get href() { return anchor._href; },
    set href(value) { anchor._href = value; },
    closest: selector => (selector === 'a[href]' ? anchor : null),
  };
  return anchor;
}

function createHarness({ href = 'http://127.0.0.1:3000/chat.html?air=1&task=tsk_a', overlay = null, share = null } = {}) {
  const listeners = [];
  const location = new URL(href);
  const document = {
    addEventListener(name, listener, capture) { listeners.push({ name, listener, capture }); },
  };
  const window = { document, location };
  if (overlay) window.MultiCCRemoteScreen = overlay;
  if (share) window.MultiCCShareMode = share;
  vm.runInNewContext(SOURCE, { window, document, location, URL, URLSearchParams, console });

  // 发一次点击。target 传 null 表示点在别的地方（不在 <a> 里）。
  function click(raw, options = {}) {
    const anchor = createAnchor(raw);
    const event = {
      button: options.button ?? 0,
      metaKey: !!options.metaKey,
      ctrlKey: !!options.ctrlKey,
      shiftKey: !!options.shiftKey,
      altKey: !!options.altKey,
      defaultPrevented: !!options.defaultPrevented,
      target: options.target === null ? { closest: () => null } : anchor,
      // 分开记：别人先拦过的（defaultPrevented）与模块自己拦的要能分辨，否则
      // 「已经处理过」那条用例会因为事件本来就是 true 而假绿/假红。
      preventDefault() { event.defaultPrevented = true; event.handled = true; },
    };
    for (const listener of listeners) listener.listener(event);
    return { prevented: !!event.handled, defaultPrevented: event.defaultPrevented, anchor };
  }

  return { links: window.MultiCCChatRemoteLinks, window, listeners, click };
}

// 记下 openMode 收到了什么，并（可选）把结果留给断言。
function overlaySpy() {
  const opened = [];
  return { opened, overlay: { openMode: mode => { opened.push(mode); return true; } } };
}

const shareMode = { active: () => true };

test('linkMode recognises the human-assist remote-screen links and nothing else', () => {
  const { links } = createHarness();
  // 聊天页里的两种 rs 值，query 与 hash 两种位置。
  assert.equal(links.linkMode('#rs=control'), 'control');
  assert.equal(links.linkMode('#rs=1'), '1');
  assert.equal(links.linkMode('/chat.html?air=1&task=t1&rs=control'), 'control');
  assert.equal(links.linkMode('/chat.html?air=1&task=t1#rs=1'), '1');
  assert.equal(links.linkMode('http://127.0.0.1:3000/chat.html?air=1&task=t1&rs=control'), 'control');
  // /air 与 /air.html 是同一个页面（Air 的对话帧地址）。
  assert.equal(links.linkMode('http://127.0.0.1:3000/air?rs=1'), '1');
  // 不是 rs / 不是这两个值 / 不是聊天页 / 不是 http(s) / 空:一律不认。
  assert.equal(links.linkMode('#rs=2'), null);
  assert.equal(links.linkMode('#section-2'), null);
  assert.equal(links.linkMode('#rs'), null);
  assert.equal(links.linkMode('http://127.0.0.1:3000/artifacts/abc/index.html?rs=control'), null);
  assert.equal(links.linkMode('javascript:alert(1)?rs=control'), null);
  assert.equal(links.linkMode(''), null);
  assert.equal(links.linkMode('   '), null);
  assert.equal(links.linkMode('http://'), null);
  // 外站的 rs 链接照旧是普通链接：本页浮层只能看本机屏幕。
  assert.equal(links.linkMode('http://example.com/chat.html?rs=control'), null);
  assert.equal(links.linkMode('https://evil.example/air?rs=1'), null);
});

test('linkMode accepts loopback hosts for the cross-device link the agent writes', () => {
  // agent 在服务器那台机器上跑，MULTICC_BASE_URL 常是 127.0.0.1 —— 页面开在局域网 IP
  // 或隧道域名上时，这条链接的 origin 与 location.origin 永远不同。环回地址一律认。
  const { links } = createHarness({ href: 'http://192.168.1.9:3000/chat.html?air=1&task=tsk_a' });
  for (const host of ['127.0.0.1:3000', 'localhost:3000', '[::1]:3000', 'box.localhost:3000']) {
    assert.equal(links.linkMode(`http://${host}/chat.html?air=1&task=t1&rs=control`), 'control', host);
  }
  // 环回但换了端口也一样（agent 那台机器的回环就是本机）。
  assert.equal(links.linkMode('http://127.0.0.1:3999/chat.html?rs=1'), '1');
  // 同 IP 段但不是环回 —— 依旧是外站。
  assert.equal(links.linkMode('http://192.168.1.20:3000/chat.html?rs=control'), null);
});

test('linkMode follows the page it is on for relative and hash links', () => {
  // Air 帧里的聊天页：pathname 是 /air.html，同源相对链接同样认。
  const { links } = createHarness({ href: 'http://127.0.0.1:3000/air.html?dir=d1' });
  assert.equal(links.linkMode('#rs=control'), 'control');
  assert.equal(links.linkMode('/air.html?rs=1'), '1');
  assert.equal(links.linkMode('/chat.html?rs=1'), '1');
  assert.equal(links.linkMode('/air?rs=control'), 'control');
});

test('a plain left click opens the overlay in place instead of navigating', () => {
  const spy = overlaySpy();
  const { click, listeners } = createHarness({ overlay: spy.overlay });
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].name, 'click');
  assert.equal(listeners[0].capture, true, '拦截必须在捕获阶段，晚于别的处理器就会被抢走');

  assert.deepEqual(click('#rs=control').prevented, true);
  assert.deepEqual(spy.opened, ['control']);
  assert.deepEqual(click('#rs=1').prevented, true);
  assert.deepEqual(click('http://127.0.0.1:3000/chat.html?air=1&task=t1&rs=control').prevented, true);
  assert.deepEqual(spy.opened, ['control', '1', 'control']);
});

test('right-click, modifier-clicks and everything else stay with the browser', () => {
  const spy = overlaySpy();
  const { click } = createHarness({ overlay: spy.overlay });
  const cases = {
    '右键（在新标签页打开 / 分享）': { button: 2 },
    '中键': { button: 1 },
    '⌘/Ctrl 点击': { ctrlKey: true },
    '⌘ 点击（macOS）': { metaKey: true },
    'Shift 点击（新窗口）': { shiftKey: true },
    'Alt 点击（下载）': { altKey: true },
    '别的处理器已经处理过': { defaultPrevented: true },
  };
  for (const [label, options] of Object.entries(cases)) {
    assert.equal(click('#rs=control', options).prevented, false, label);
  }
  // 点在别处、rs 不认识、不是链接 —— 都不该被拦。
  assert.equal(click('#rs=control', { target: null }).prevented, false);
  assert.equal(click('#rs=2').prevented, false);
  assert.equal(click('http://example.com/chat.html?rs=control').prevented, false);
  assert.equal(spy.opened.length, 0, '只有左键点中 rs 链接才开浮层');
});

test('without the overlay module and on a share page the link is left alone', () => {
  // 别的页面复用了这套 markdown 时页面上没有浮层：拦下来只会变成点了没反应。
  const noOverlay = createHarness();
  assert.equal(noOverlay.click('#rs=control').prevented, false);
  // 分享页的接收方没有 /api/remote-screen 的鉴权，浮层只会是空的。
  const spy = overlaySpy();
  const shared = createHarness({ overlay: spy.overlay, share: shareMode });
  assert.equal(shared.click('#rs=control').prevented, false);
  assert.equal(spy.opened.length, 0);
});

test('hash links are rewritten to this page so the new-tab escape hatch still lands', () => {
  const { links } = createHarness({ href: 'http://127.0.0.1:3000/chat.html?air=1&task=tsk_a' });
  const rs = createAnchor('#rs=control');
  const other = createAnchor('#section-2');
  const foreign = createAnchor('http://example.com/chat.html?rs=control');
  const container = { querySelectorAll: () => [rs, other, foreign] };
  links.fixupRemoteScreenLinks(container);

  // `<base href="/">` 会把 #rs=control 解析到站点根：补成本页地址，rs 挪进 query，
  // 带着这个任务一起打开（右键「在新标签页打开」因此也落在对的那一页）。
  assert.equal(rs.href, 'http://127.0.0.1:3000/chat.html?air=1&task=tsk_a&rs=control');
  assert.equal(rs.dataset.rsFixed, '1');
  // 普通锚点与外站链接一个字节都不动。
  assert.equal(other.href, '#section-2');
  assert.equal(other.dataset.rsFixed, undefined);
  assert.equal(foreign.href, 'http://example.com/chat.html?rs=control');
  // 再跑一遍（重渲染的容器、重复挂载）不会把 rs 叠两次。
  links.fixupRemoteScreenLinks(container);
  assert.equal(rs.href, 'http://127.0.0.1:3000/chat.html?air=1&task=tsk_a&rs=control');
});

test('a share page never rewrites the link it received', () => {
  const { links } = createHarness({ share: shareMode });
  const rs = createAnchor('#rs=control');
  links.fixupRemoteScreenLinks({ querySelectorAll: () => [rs] });
  assert.equal(rs.href, '#rs=control');
});

test('the page wires the module in the one order that works', () => {
  // 加载顺序：chat-remote-links.js 要在 chat.js 之前（chat.js 顶层就把 fixup 取走）。
  const linksAt = CHAT_HTML.indexOf('<script src="chat-remote-links.js"></script>');
  const chatAt = CHAT_HTML.indexOf('<script src="chat.js"></script>');
  assert.ok(linksAt > 0, 'chat.html 必须加载 chat-remote-links.js');
  assert.ok(chatAt > linksAt, 'chat-remote-links.js 必须在 chat.js 之前');
  // 渲染出来的 markdown 容器要过一遍修正，否则纯 fragment 的 href 还是指向站点根。
  assert.match(HISTORY_VIEW, /fixupRemoteScreenLinks\(markdownRoot\);/);
  assert.match(CHAT_JS, /fixupRemoteScreenLinks: \(window\.MultiCCChatRemoteLinks/);
  // 两条路（rs 参数 / 消息里的链接）共用一个 openMode。
  assert.match(REMOTE_SCREEN, /global\.MultiCCRemoteScreen = Object\.freeze\(\{ open, close, openMode \}\);/);
});

// 判定表是两份实现（Web 的 linkMode / App 的 remoteScreenLinkMode），Dart 那边不便在
// Node 里跑，但常量必须对得上 —— 少一个环回地址就会有一端偷偷回退到浏览器
// （app/test/remote_screen_link_test.dart 钉行为，这里只防两张表悄悄漂开）。
test('the App keeps the same host and mode table', () => {
  for (const token of ["'127.0.0.1'", "'localhost'", "'::1'", "'.localhost'", "'1'", "'control'"]) {
    assert.ok(MESSAGE_BUBBLE.includes(token), `message_bubble.dart 少了 ${token}`);
  }
  assert.match(MESSAGE_BUBBLE, /schemeAgnostic: !serverHost\.startsWith\('http'\)/);
});
