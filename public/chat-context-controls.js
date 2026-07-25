(function initChatContextControls(global) {
  'use strict';

  function create(options = {}) {
    const document = options.document;
    const window = options.window || global;
    const wrap = document.getElementById('clear-ctx-wrap');
    const menu = document.getElementById('clear-ctx-menu');
    let open = false;

    function translate(key, vars) {
      return options.translate ? options.translate(key, vars) : key;
    }

    function openMenu() {
      open = true;
      menu.style.display = 'block';
    }

    function closeMenu() {
      open = false;
      menu.style.display = 'none';
    }

    function clear(keep) {
      if (options.getIsStreaming()) options.cancelStreaming();
      options.resetHistoryPagination();
      if (keep > 0) {
        const messages = [...options.messagesEl.querySelectorAll('.msg:not(.system-msg)')];
        const removed = messages.slice(0, Math.max(0, messages.length - keep));
        removed.forEach(element => element.remove());
        options.addSystemMsg(removed.length
          ? translate('contextKept', { removed: removed.length, kept: keep })
          : translate('contextResetKept'));
      } else {
        options.clearMessages();
        options.addSystemMsg(translate('contextCleared'));
      }
      if (options.isConnected()) options.send({ type: 'clear_history', keep });
      closeMenu();
    }

    function rotateNativeContext() {
      if (options.getIsStreaming()) {
        options.showNotifyToast(translate('rotateNativeContextBusy'), 'waiting');
        closeMenu();
        return;
      }
      if (!window.confirm(translate('rotateNativeContextConfirm'))) return;
      if (!options.isConnected()) {
        options.showNotifyToast(translate('rotateNativeContextOffline'), 'fail');
        closeMenu();
        return;
      }
      options.send({ type: 'clear_history', preserveHistory: true });
      closeMenu();
    }

    wrap.addEventListener('click', event => {
      event.stopPropagation();
      open ? closeMenu() : openMenu();
    });
    document.addEventListener('click', event => {
      if (open && !wrap.contains(event.target)) closeMenu();
    });
    menu.addEventListener('click', event => event.stopPropagation());
    menu.querySelector('[data-action="clear-all"]').addEventListener('click', () => clear(0));
    menu.querySelector('[data-action="clear-keep"]').addEventListener('click', () => {
      const count = parseInt(document.getElementById('clear-keep-n').value, 10);
      clear(Math.max(1, count || 5));
    });
    menu.querySelector('[data-action="rotate-native"]').addEventListener('click', rotateNativeContext);

    return Object.freeze({ closeMenu, openMenu, rotateNativeContext });
  }

  const api = Object.freeze({ create });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatContextControls = api;
}(typeof window !== 'undefined' ? window : globalThis));
