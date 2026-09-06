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
      if (!options.isConnected()) {
        options.showNotifyToast(translate('clearChatHistoryOffline'), 'fail');
        closeMenu();
        return;
      }
      if (keep === 0 && !window.confirm(translate('clearAllChatHistoryConfirm'))) return;
      // The server persists display state and acknowledges it. Leave
      // the view intact until that acknowledgement, including failed requests.
      try {
        if (options.send({ type: 'clear_history', keep }) === false) throw new Error('offline');
      } catch (_) {
        options.showNotifyToast(translate('clearChatHistoryOffline'), 'fail');
      }
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
      // Context pressure, not file size: `wouldPrune` only says the gate will look.
      if (t.overWatermark) parts.push(translate('contextLevelOverWatermark'));
      const plan = data.plan;
      if (plan) {
        parts.push(plan.lostTurns > 0
          ? translate('contextLevelPlanLossy', {
            after: mb(plan.afterBytes),
            turns: plan.lostTurns,
            // The turns that said something — the rest were "继续"-style filler.
            substantive: plan.lostSubstantiveTurns == null ? plan.lostTurns : plan.lostSubstantiveTurns,
          })
          : translate('contextLevelPlanSafe', { after: mb(plan.afterBytes) }));
      } else if (t.wouldPrune) {
        // The gate will run and find nothing worth rewriting. Saying nothing would
        // leave "over the watermark" as the last word and imply a trim is coming.
        parts.push(translate('contextLevelPlanNone'));
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
