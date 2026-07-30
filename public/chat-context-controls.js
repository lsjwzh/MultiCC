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

    // "Prompt is too long" arrives with no warning because nothing ever showed how
    // full the native CLI context was. This reads the water level of the transcript
    // that `--resume` reloads: bytes replayed, an estimated token load, and — when a
    // trim would cost turns — what it would cost, before anyone triggers one.
    async function showContextLevel() {
      closeMenu();
      const sessionId = options.getSessionId ? options.getSessionId() : '';
      if (!sessionId) {
        options.showNotifyToast(translate('contextLevelFail'), 'fail');
        return;
      }
      const doFetch = options.fetch || window.fetch;
      let data = null;
      try {
        const res = await doFetch(`/api/sessions/${encodeURIComponent(sessionId)}/context-level?plan=1`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
      } catch (_) {
        options.showNotifyToast(translate('contextLevelFail'), 'fail');
        return;
      }
      const t = data && data.transcript;
      if (!data || data.supported === false || !t || t.found === false) {
        options.addSystemMsg(translate('contextLevelUnavailable'));
        return;
      }
      const mb = (n) => `${(Number(n || 0) / 1048576).toFixed(2)} MB`;
      const parts = [translate('contextLevelSummary', {
        live: mb(t.liveBytes),
        file: mb(t.fileBytes),
        turns: t.liveTurns,
        tokens: t.estimatedTokens == null ? '?' : Number(t.estimatedTokens).toLocaleString(),
      })];
      if (t.compactBoundary && t.compactBoundary.present) parts.push(translate('contextLevelCompacted'));
      if (t.wouldPrune) parts.push(translate('contextLevelOverWatermark'));
      const plan = data.plan;
      if (plan) {
        parts.push(plan.lostTurns > 0
          ? translate('contextLevelPlanLossy', { after: mb(plan.afterBytes), turns: plan.lostTurns })
          : translate('contextLevelPlanSafe', { after: mb(plan.afterBytes) }));
      }
      options.addSystemMsg(parts.join(' '));
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
    const levelBtn = menu.querySelector('[data-action="context-level"]');
    if (levelBtn) levelBtn.addEventListener('click', () => { showContextLevel(); });

    return Object.freeze({ closeMenu, openMenu, rotateNativeContext, showContextLevel });
  }

  const api = Object.freeze({ create });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatContextControls = api;
}(typeof window !== 'undefined' ? window : globalThis));
