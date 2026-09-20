/* Auth-failure notice with a one-click remedy. For vendor-auth CLIs
 * (WorkBuddy/Qoder) the only fix is logging in inside the vendor TUI, so the
 * server attaches authAction={kind:'vendor_login_terminal'} to the warning
 * broadcast and this renders a button that opens a whitelisted login terminal
 * session in a new tab. All external text goes through textContent. */
(function () {
  'use strict';

  function createAuthActionRenderer(options) {
    const opts = options || {};
    const doc = opts.document;
    const chatApi = opts.chatApi;
    const withToken = opts.withToken;
    const getSessionName = opts.getSessionName || (() => '');
    const addSystemMsg = opts.addSystemMsg || (() => {});
    const getMessagesEl = opts.getMessagesEl;
    const scroll = opts.maybeScrollToBottom || (() => {});

    function render(text, action) {
      if (!action || action.kind !== 'vendor_login_terminal') return false;
      const messagesEl = getMessagesEl && getMessagesEl();
      if (!messagesEl) return false;
      const div = doc.createElement('div');
      div.className = 'msg system-msg';
      const span = doc.createElement('span');
      span.textContent = text;
      div.appendChild(span);
      const label = String(action.label || '').trim();
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.textContent = `打开 ${label} 登录终端`;
      btn.style.cssText = 'display:inline-block;margin-top:6px;padding:3px 12px;font-size:12px;' +
        'border-radius:6px;border:1px solid var(--chat-accent,#58a6ff);background:transparent;' +
        'color:var(--chat-accent,#58a6ff);cursor:pointer;';
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = '正在打开…';
        try {
          const data = await chatApi.json(
            withToken(`/api/sessions/${encodeURIComponent(getSessionName())}/vendor-login-terminal`),
            { method: 'POST' },
          );
          btn.textContent = '✓ 已打开登录终端';
          window.open(data.url, '_blank');
          addSystemMsg(`已在新标签页打开 ${label} 登录终端：在终端里输入 ${action.loginCommand || '/login'} 完成登录，然后回到这里重新发送消息即可。`);
        } catch (e) {
          btn.disabled = false;
          btn.textContent = `打开 ${label} 登录终端`;
          addSystemMsg('打开登录终端失败：' + chatApi.errorText(e));
        }
      };
      div.appendChild(btn);
      messagesEl.appendChild(div);
      scroll();
      return true;
    }

    return Object.freeze({ render });
  }

  window.MultiCCChatAuthAction = Object.freeze({ create: createAuthActionRenderer });
})();
