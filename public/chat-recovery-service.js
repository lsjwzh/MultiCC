(function initChatRecoveryService(global) {
  'use strict';

  // The recovery ladder for a chat session, cheapest rung first. Each rung fixes
  // a strictly larger blast radius than the one before it, and the reason they
  // live together is that the user cannot tell from the outside which one they
  // need — a session whose CLI process died mid-turn looks exactly like a
  // session whose WebSocket dropped.
  //
  //   1. reconnect      — rebuild this tab's WebSocket. Fixes transport only.
  //   2. reload         — rebuild the whole page. Fixes wedged client state.
  //   3. restartSpawn   — kill and rebuild the CLI process and its server-side
  //                       runtime. The only rung that can fix the server, and
  //                       the only one the first two silently fail to substitute
  //                       for: refreshing a list re-reads the same stale state.
  //
  // Rung 3 keeps the conversation — the vendor session id lives on the persisted
  // record and the next message respawns with --resume — so only the interrupted
  // turn is lost. That is what makes it safe to offer as a button.
  function create(options = {}) {
    const document = options.document;
    const translate = (key, vars) => (options.translate ? options.translate(key, vars) : key);
    const fetchImpl = options.fetch || ((url, init) => global.fetch(url, init));
    const longPressMs = options.longPressMs || 600;

    function reconnect(reason) {
      options.forceReconnect(reason);
    }

    async function restartSpawn() {
      const name = options.getSessionName();
      if (!name) {
        options.addSystemMsg(translate('sessionIdMissing'));
        return { ok: false, reason: 'no-session' };
      }
      const confirmed = await options.confirm(translate('restartSpawnConfirm'), {
        title: translate('restartSpawn'),
        okText: translate('restartSpawn'),
        cancelText: translate('cancel'),
      });
      if (!confirmed) return { ok: false, reason: 'cancelled' };
      options.closeMoreMenu?.();
      try {
        const url = options.withToken(`/api/sessions/${encodeURIComponent(name)}/restart-spawn`);
        const res = await fetchImpl(url, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          options.addSystemMsg(translate('restartSpawnFailed', { error: data.error || res.status }));
          return { ok: false, reason: 'http', status: res.status };
        }
        options.addSystemMsg(translate('restartSpawnDone', { pid: (data.before && data.before.pid) || '-' }));
        // The process this tab was talking to no longer exists; resync so the
        // header and status pill stop describing a runtime that is gone.
        reconnect('restart-spawn');
        return { ok: true, before: data.before || null };
      } catch (error) {
        options.addSystemMsg(translate('restartSpawnFailed', { error: error.message }));
        return { ok: false, reason: 'network' };
      }
    }

    const reconnectBtn = document.getElementById('reconnect-btn');
    if (reconnectBtn) {
      // Tap → force reconnect; long-press → hard page reload as a last resort.
      let lpTimer = null;
      let longFired = false;
      const startLP = () => {
        longFired = false;
        lpTimer = setTimeout(() => { longFired = true; options.reload(); }, longPressMs);
      };
      const cancelLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
      reconnectBtn.addEventListener('click', () => { if (!longFired) reconnect('manual button'); });
      reconnectBtn.addEventListener('mousedown', startLP);
      reconnectBtn.addEventListener('touchstart', startLP, { passive: true });
      ['mouseup', 'mouseleave', 'touchend', 'touchcancel']
        .forEach(type => reconnectBtn.addEventListener(type, cancelLP));
    }

    // The status pill is always a reconnect affordance too (not only after a drop).
    if (options.statusEl) options.statusEl.onclick = () => reconnect('status click');

    const restartBtn = document.getElementById('restart-spawn-btn');
    if (restartBtn) {
      restartBtn.addEventListener('click', async () => {
        restartBtn.disabled = true;
        try { await restartSpawn(); } finally { restartBtn.disabled = false; }
      });
    }

    return Object.freeze({ reconnect, restartSpawn });
  }

  const api = Object.freeze({ create });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatRecoveryService = api;
}(typeof window !== 'undefined' ? window : globalThis));
