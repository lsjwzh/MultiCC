'use strict';

/* 分享页 = 聊天页本身。
 *
 * /share/<token> 送的是同一个 chat.html，所以接收方看到的就是管理员用的那套界面，
 * 差别只有一个：这个链接是谁、能做什么。这份模块就是那道差别 —— 它问服务端要一次
 * 权限（/api/share/<token>/entry），其余全部交给页面自己。
 *
 * 两条规矩：
 *   1. 只有这一份「分享是什么」的判断。散落到 chat.js 各处就会出现两套分享语义。
 *   2. 拿到答复之前一律按最小权限对待（默认不可写、默认不显示输入区）。分享页在
 *      隧道那头，多等一下无所谓，先亮出写权限再收回才是问题。
 *
 * 它不认识 chat.js 里的任何变量：要用页面内部状态的地方留在 chat-task-boot.js。 */

(function installMulticcShareMode(root) {
  // 服务端也可以把 token 注进文档（预留给后续的免请求启动）；没有就自己从路径里认。
  const SHARE_PATH = /^\/share\/([^/]+)\/?$/;

  let _token = null;
  let _pending = null;
  let _info = null;

  function currentToken() {
    if (_token !== null) return _token;
    const injected = root.__multiccShare && root.__multiccShare.token;
    if (typeof injected === 'string' && injected) { _token = injected; return _token; }
    const match = SHARE_PATH.exec(root.location ? root.location.pathname : '');
    _token = match ? decodeURIComponent(match[1]) : '';
    return _token;
  }

  function active() { return !!currentToken(); }

  // 这个链接是谁、能做什么。缓存：一次页面生命周期只问一次，buildUrl 和启动流程
  // 都会 await 它，问两遍会让页面拿到两个不同的答复。
  function prepare() {
    if (_pending) return _pending;
    const token = currentToken();
    if (!token) { _info = { state: 'gone', token: '' }; return Promise.resolve(_info); }
    _pending = (async () => {
      let response = null;
      try {
        response = await root.fetch(`/api/share/${encodeURIComponent(token)}/entry`, {
          credentials: 'same-origin', cache: 'no-store',
        });
      } catch (_) {
        // 网络不通不是「链接失效」：链接还在，只是这次没问到。
        return (_info = { state: 'error', token, message: '无法连接到服务，请稍后重试。' });
      }
      if (response.status === 401) return (_info = { state: 'locked', token });
      if (response.status === 404) return (_info = { state: 'gone', token });
      if (!response.ok) {
        return (_info = { state: 'error', token, message: `服务返回 HTTP ${response.status}，请稍后重试。` });
      }
      const data = await response.json().catch(() => null);
      if (!data || typeof data !== 'object') {
        return (_info = { state: 'error', token, message: '服务返回了无法识别的数据，请稍后重试。' });
      }
      const access = data.access === 'operate' ? 'operate' : 'view';
      return (_info = {
        state: 'ok',
        token,
        access,
        // 消息快照没有活的会话：历史已经在答复里给全了，没有 WS，也没有下一页。
        type: data.type === 'messages' ? 'messages' : 'session',
        label: typeof data.label === 'string' ? data.label : '',
        sessionId: typeof data.sessionId === 'string' ? data.sessionId : '',
        messages: Array.isArray(data.messages) ? data.messages : [],
      });
    })();
    return _pending;
  }

  function info() { return _info; }
  function isReady() { return !!_info && _info.state === 'ok'; }
  function canOperate() { return isReady() && _info.access === 'operate'; }
  function isSnapshot() { return isReady() && _info.type === 'messages'; }

  // 分享连接的授权凭证是 token 本身，服务端不认 ws-ticket（见 src/ws/connection-router.js）。
  function decorateWsUrl(url) {
    if (!isReady() || _info.type !== 'session') return url;
    url.searchParams.set('share', _info.token);
    if (_info.sessionId) url.searchParams.set('session', _info.sessionId);
    return url;
  }

  // 顶上那排按钮、以及「换 CLI / 换模型 / 合并 worktree / 重启进程」这类写操作，
  // 全都是管理员的东西。分享出去的是这一轮对话，不是这台机器的控制台。
  //
  // 用 html 上的类名而不是逐个 element.id 关：新加的管理员按钮只要带上
  // session-only，分享页自动就不显示，不会漏掉一个。
  function applyChrome() {
    const html = root.document && root.document.documentElement;
    if (!html || !html.classList) return;
    html.classList.add('share-mode');
    html.classList.toggle('share-view-only', !canOperate());
  }

  function overlayElement() {
    const document = root.document;
    if (document.getElementById('share-gate')) return document.getElementById('share-gate');
    const ov = document.createElement('div');
    ov.id = 'share-gate';
    ov.style.cssText = 'position:fixed;inset:0;background:var(--chat-overlay, rgba(0,0,0,.88));'
      + 'z-index:999999;display:flex;align-items:center;justify-content:center;'
      + 'font-family:system-ui,-apple-system,sans-serif';
    document.body.appendChild(ov);
    return ov;
  }

  function card(title, body, fieldsHtml) {
    return `<div id="share-gate-card" style="background:var(--chat-surface, #1c1c1e);border-radius:14px;padding:26px;max-width:380px;width:90%;color:var(--chat-text, #eee);box-shadow:var(--chat-shadow, 0 8px 40px rgba(0,0,0,.6))">
      <div style="font-size:20px;font-weight:700;margin-bottom:14px"><span style="color:#f78166">Multi</span><span style="color:#79c0ff">CC</span></div>
      <h3 style="margin:0 0 8px;font-size:17px">${title}</h3>
      <p style="font-size:13px;color:var(--chat-muted, #999);margin:0 0 16px;line-height:1.6">${body}</p>
      ${fieldsHtml}
    </div>`;
  }

  // locked → 要密码；gone → 链接没了；error → 这次没问到，可以再试。
  // 三种状态在这里就是三种卡片，页面其余部分一概不参与。
  function mountOverlay(handlers = {}) {
    const state = _info && _info.state;
    if (!state || state === 'ok') return null;
    const ov = overlayElement();
    if (state === 'locked') {
      ov.innerHTML = card('需要访问密码', '分享方为此会话设置了密码，请输入后查看。',
        `<input id="share-pw" type="password" autocomplete="current-password" placeholder="访问密码"
            style="width:100%;box-sizing:border-box;padding:10px 12px;margin-bottom:8px;border-radius:8px;border:1px solid var(--chat-line, #333);background:var(--chat-soft, #2a2a2e);color:var(--chat-text, #eee);font-size:14px" />
         <div id="share-msg" style="font-size:12px;color:var(--chat-danger, #ff8a80);margin:4px 0 10px;min-height:16px"></div>
         <button id="share-go" style="width:100%;padding:11px;border:none;border-radius:8px;background:#0a84ff;color:#fff;font-size:14px;font-weight:600;cursor:pointer">进入</button>`);
      const input = ov.querySelector('#share-pw');
      const msg = ov.querySelector('#share-msg');
      const submit = async () => {
        const password = input.value;
        if (!password) { msg.textContent = '请输入密码'; return; }
        msg.textContent = '';
        ov.querySelector('#share-go').disabled = true;
        try {
          const response = await root.fetch(`/api/share/${encodeURIComponent(currentToken())}/auth`, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            msg.textContent = payload.error || '密码错误';
            ov.querySelector('#share-go').disabled = false;
            return;
          }
        } catch (_) {
          msg.textContent = '网络错误，请稍后重试';
          ov.querySelector('#share-go').disabled = false;
          return;
        }
        // 密码对了就不再猜权限：重载一次，让页面用新 cookie 重新问一遍。
        if (typeof handlers.onUnlocked === 'function') handlers.onUnlocked();
        else root.location.reload();
      };
      ov.querySelector('#share-go').addEventListener('click', submit);
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
      input.focus();
      return ov;
    }
    if (state === 'gone') {
      ov.innerHTML = card('链接无效', '该分享链接不存在或已过期。', '');
      return ov;
    }
    ov.innerHTML = card('暂时打不开', `${(_info && _info.message) || '请稍后重试。'}`,
      `<button id="share-retry" style="width:100%;padding:11px;border:none;border-radius:8px;background:#0a84ff;color:#fff;font-size:14px;font-weight:600;cursor:pointer">重试</button>`);
    ov.querySelector('#share-retry').addEventListener('click', () => root.location.reload());
    return ov;
  }

  // chat.js 拿它当 shell view 用：分享页没有 shell，历史分页走分享自己的端点。
  function createView(options = {}) {
    const onSession = typeof options.onSession === 'function' ? options.onSession : () => {};
    return {
      shellId: null,
      get activeSessionId() { return isReady() ? _info.sessionId : ''; },
      async prepare() {
        const resolved = await prepare();
        if (resolved.state === 'ok' && resolved.sessionId) onSession(resolved.sessionId);
        return resolved.state === 'ok' ? resolved.sessionId : '';
      },
      // 没有 shell 就没有来源重映射，事件原样过。
      event: (message) => message,
      historyUrl: () => `/api/share/${encodeURIComponent(currentToken())}/history`,
    };
  }

  root.MultiCCShareMode = Object.freeze({
    active,
    token: currentToken,
    prepare,
    info,
    isReady,
    canOperate,
    isSnapshot,
    decorateWsUrl,
    applyChrome,
    mountOverlay,
    createView,
  });
})(typeof window !== 'undefined' ? window : globalThis);
