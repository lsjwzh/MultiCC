'use strict';

// 聊天消息里的「远控链接」（multicc-human-assist 的 `#rs=control` / `#rs=1`）要在
// **本页**展开「🖥 屏幕」浮层，而不是把整页带走。两件事各有一条理由：
//
//  1. chat.html 带 `<base href="/">`（分享页靠它把相对路径解析回站点根），于是消息里
//     `[点这里](#rs=control)` 这种纯 fragment 的 href 会被解析成
//     `http://<host>/#rs=control` —— 点一下整页跳到目录首页，浮层永远打不开。
//     渲染后把这类锚点补成本页的绝对地址（hash 里的 rs 挪进 query），右键
//     「在新标签页打开」于是也落到对的那一页。
//  2. 跨设备形态的完整链接（agent 按 MULTICC_BASE_URL 写，本机常是
//     `http://127.0.0.1:3000/chat.html?air=1&task=…&rs=control`）点开是一次整页导航，
//     而用户要的只是「本地开窗」。同一个服务器的 /chat.html、/air 上的 rs 链接
//     （同源，或环回地址 —— agent 就在那台机器上跑，手机上的回环是手机自己）一律
//     在本页展开浮层。
//
// 不拦：右击 / 长按（浏览器自己的「在新标签页打开 / 分享」菜单，用户明确要的就是它）、
// 带修饰键的点击、以及分享页（接收方没有 /api/remote-screen 的鉴权，浮层只会是空的）。
(function attachMulticcChatRemoteLinks(root) {
  if (!root || typeof document === 'undefined') return;

  const MODES = new Set(['1', 'control']);
  const CHAT_PATHS = new Set(['/chat.html', '/air', '/air.html']);

  const shareActive = () => !!(root.MultiCCShareMode && root.MultiCCShareMode.active
    && root.MultiCCShareMode.active());

  function modeIn(params) {
    const value = params.get('rs');
    return MODES.has(value) ? value : null;
  }

  function trimPath(value) {
    return String(value || '').replace(/\/+$/, '') || '/';
  }

  // '1' | 'control' | null —— 与 App 端 message_bubble.dart 的 remoteScreenLinkMode
  // 是同一套判定，改一处要改两处（两侧都有各自的用例钉着这张表）。
  function linkMode(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    // 纯 fragment 按本页看：`<base>` 的解析结果不是链接作者的意思。
    if (text.startsWith('#')) return modeIn(new URLSearchParams(text.slice(1)));
    let url;
    try { url = new URL(text, root.location.href); } catch (_) { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // 别的服务器的 rs 链接照旧是普通链接：本页的浮层只能看本机的屏幕。
    const host = url.hostname.toLowerCase();
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
      || host.endsWith('.localhost');
    if (url.origin !== root.location.origin && !loopback) return null;
    const path = trimPath(url.pathname);
    if (!CHAT_PATHS.has(path) && path !== trimPath(root.location.pathname)) return null;
    return modeIn(url.searchParams)
      || (url.hash ? modeIn(new URLSearchParams(url.hash.slice(1))) : null);
  }

  // 纯 fragment 的 rs 锚点补成本页绝对地址：把 rs 从 hash 挪进 query，随本页任务一起
  // 带走。别的形态 href 本来就能用，不动。
  function fixupRemoteScreenLinks(container) {
    if (!container || shareActive()) return;
    container.querySelectorAll('a[href]').forEach(link => {
      if (link.dataset.rsFixed) return;
      const raw = link.getAttribute('href') || '';
      if (!raw.startsWith('#')) return;
      const mode = linkMode(raw);
      if (!mode) return;
      link.dataset.rsFixed = '1';
      const url = new URL(root.location.href);
      url.hash = '';
      url.searchParams.set('rs', mode);
      link.href = url.href;
    });
  }

  function onClick(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (shareActive()) return;
    const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    const mode = linkMode(anchor.getAttribute('href') || '');
    if (!mode) return;
    const overlay = root.MultiCCRemoteScreen;
    // 页面上没有浮层（比如别的地方复用了这套 markdown）就别拦，照旧交给浏览器。
    if (!overlay || typeof overlay.openMode !== 'function') return;
    event.preventDefault();
    overlay.openMode(mode);
  }
  document.addEventListener('click', onClick, true);

  root.MultiCCChatRemoteLinks = Object.freeze({ linkMode, fixupRemoteScreenLinks });
})(typeof window !== 'undefined' ? window : globalThis);
