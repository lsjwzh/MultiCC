'use strict';

// The settings page reuses the original power and host controls. Parking them
// before replacing page content preserves listeners and in-flight operations.
(function (root) {
  // Input controls render before the power/host groups (the send-key row applies
  // on every platform, unlike the power rows).
  const ids = ['settings-input-controls', 'settings-power-controls', 'settings-host-controls'];
  const sendKeyButton = document.getElementById('air-send-key');

  function paintSendKey() {
    if (!sendKeyButton || !root.MultiCCSendKey) return;
    const api = root.MultiCCSendKey;
    const mod = api.modLabel();
    const on = api.get() === 'mod-enter';
    sendKeyButton.classList.toggle('on', on);
    sendKeyButton.setAttribute('aria-pressed', on ? 'true' : 'false');
    const t = root.t || (key => key);
    const strong = sendKeyButton.querySelector('strong');
    const small = sendKeyButton.querySelector('small');
    if (strong) strong.textContent = t('airSendKeyTitle', { mod });
    if (small) small.textContent = t(on ? 'airSendKeyDescOn' : 'airSendKeyDescOff', { mod });
  }

  // The quick-task box's placeholder states which key sends; it has to follow
  // the mode even when Settings is closed (air-quick-fold watches the attribute).
  function refreshSendKey() {
    paintSendKey();
    if (root.MultiCCSendKey) root.MultiCCSendKey.syncPlaceholder(document.getElementById('quick-task-input'));
  }

  if (sendKeyButton) {
    sendKeyButton.addEventListener('click', () => {
      if (!root.MultiCCSendKey) return;
      root.MultiCCSendKey.set(root.MultiCCSendKey.get() === 'mod-enter' ? 'enter' : 'mod-enter');
      refreshSendKey();
    });
  }
  root.addEventListener('multicc-send-key-change', refreshSendKey);
  // storage only fires in other documents (the chat iframe, other tabs).
  root.addEventListener('storage', event => {
    if (!event.key || event.key === (root.MultiCCSendKey && root.MultiCCSendKey.STORE_KEY)) refreshSendKey();
  });
  // i18n.js registers its DOMContentLoaded listener in <head>; this one is later,
  // so the placeholder rewrite happens after applyI18n() has painted it.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refreshSendKey);
  else refreshSendKey();

  function park() {
    const pool = document.getElementById('settings-control-pool');
    for (const id of ids) { const node = document.getElementById(id); if (node) pool.append(node); }
  }
  function mount(host) {
    for (const id of ['air-lid-sleep', 'air-auto-unlock']) {
      const button = document.getElementById(id);
      if (button.parentElement.classList.contains('power-setting-wrap')) continue;
      const wrap = document.createElement('div'); wrap.className = 'power-setting-wrap';
      button.before(wrap); wrap.append(button);
      const details = document.createElement('details'), summary = document.createElement('summary');
      summary.textContent = 'ⓘ'; summary.setAttribute('aria-label', button.querySelector('strong').textContent);
      const text = button.querySelector('small');
      details.append(summary, text); wrap.append(details);
    }
    for (const id of ids) host.append(document.getElementById(id));
    paintSendKey();
    root.dispatchEvent(new Event('multicc-more-opened'));
  }
  root.MultiCCAirMore = { park, mount,
    open: () => root.dispatchEvent(new Event('multicc-open-settings')), close() {} };
})(window);
