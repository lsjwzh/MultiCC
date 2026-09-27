'use strict';

// Is someone actually looking at MultiCC right now? The ONE answer both
// reminder controllers read (air-task-notify.js for tasks that aren't open,
// chat-notifications.js for the open one), so they can never disagree about
// whether to narrate.
//
//   present = page visible AND some MultiCC page saw input in the last 5 min
//   away    = page hidden (tab switched / window minimised / screen locked)
//             OR visible but nobody touched it for 5 min (probably walked off)
//
// Reminder policy built on top of it (keep this table and the two controllers
// in sync — it is the contract the user sees):
//
//   | presence | ding | narration | in-page mark/panel/toast | system notif |
//   |----------|------|-----------|--------------------------|--------------|
//   | present  | yes  | no        | yes                      | no           |
//   | away     | yes  | yes       | yes (toast stays)        | hidden only  |
//
// Activity is shared through localStorage so the Air shell and its chat
// iframe (and a second MultiCC tab) count as one person: typing in the chat
// frame keeps the Air page "present", and vice versa. Writes are throttled —
// the idle threshold is minutes, a few seconds of lag is irrelevant.
(function installUserPresence(root) {
  const IDLE_MS = 5 * 60 * 1000;
  const WRITE_EVERY_MS = 5000;
  const MOVE_EVERY_MS = 1000;
  const LS_ACTIVITY = 'multicc:presence-activity';
  const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll', 'focus'];

  function create(options) {
    const opts = options || {};
    const win = opts.window || root;
    const doc = opts.document || win.document;
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const idleMs = Number(opts.idleMs) > 0 ? Number(opts.idleMs) : IDLE_MS;
    const storage = (() => {
      if (opts.storage !== undefined) return opts.storage;
      try { return win.localStorage || null; } catch (_) { return null; }
    })();

    // Opening/reloading the page is itself an interaction.
    let localAt = now();
    let writtenAt = 0;
    let lastMoveAt = 0;
    const returnListeners = new Set();

    function storedAt() {
      if (!storage) return 0;
      try { return Number(storage.getItem(LS_ACTIVITY)) || 0; } catch (_) { return 0; }
    }
    function lastActivityAt() { return Math.max(localAt, storedAt()); }
    function hidden() { return !!doc && doc.visibilityState === 'hidden'; }
    function idle(at) { return (at == null ? now() : at) - lastActivityAt() >= idleMs; }
    function state() { return hidden() ? 'hidden' : idle() ? 'idle' : 'present'; }

    function emitReturn(reason) {
      for (const listener of [...returnListeners]) {
        try { listener(reason); } catch (_) {}
      }
    }

    function recordActivity(event) {
      const at = now();
      // pointermove / scroll fire in bursts; one sample a second is plenty.
      if (event && (event.type === 'pointermove' || event.type === 'scroll')) {
        if (at - lastMoveAt < MOVE_EVERY_MS) return;
        lastMoveAt = at;
      }
      const wasIdle = !hidden() && idle(at);
      localAt = at;
      if (storage && at - writtenAt >= WRITE_EVERY_MS) {
        writtenAt = at;
        try { storage.setItem(LS_ACTIVITY, String(at)); } catch (_) {}
      }
      if (wasIdle) emitReturn('active');
    }

    // Visible again after being hidden → back. Tracked here rather than read
    // from the event, because a restore can arrive while also idle.
    let wasHidden = hidden();
    function onVisibility() {
      const nowHidden = hidden();
      if (wasHidden && !nowHidden) {
        localAt = now();
        emitReturn('visible');
      }
      wasHidden = nowHidden;
    }
    // Activity in the other frame/tab lands here as a storage event; if this
    // page thought the person was gone, that is a return too.
    let storageSeenAt = storedAt();
    function onStorage(event) {
      if (event && event.key && event.key !== LS_ACTIVITY) return;
      const at = storedAt();
      const wasIdle = !hidden() && now() - Math.max(localAt, storageSeenAt) >= idleMs;
      storageSeenAt = at;
      if (wasIdle && !idle()) emitReturn('active');
    }

    const listenOpts = { capture: true, passive: true };
    for (const type of EVENTS) win.addEventListener?.(type, recordActivity, listenOpts);
    doc?.addEventListener?.('visibilitychange', onVisibility);
    win.addEventListener?.('storage', onStorage);

    return Object.freeze({
      IDLE_MS: idleMs,
      state,
      isAway: () => state() !== 'present',
      lastActivityAt,
      recordActivity,
      onReturn(listener) {
        if (typeof listener !== 'function') return () => {};
        returnListeners.add(listener);
        return () => returnListeners.delete(listener);
      },
      destroy() {
        for (const type of EVENTS) win.removeEventListener?.(type, recordActivity, listenOpts);
        doc?.removeEventListener?.('visibilitychange', onVisibility);
        win.removeEventListener?.('storage', onStorage);
        returnListeners.clear();
      },
    });
  }

  // One tracker per page; both controllers on the same page share it.
  let sharedTracker = null;
  function shared() {
    if (!sharedTracker) sharedTracker = create({ window: root });
    return sharedTracker;
  }

  const api = Object.freeze({ IDLE_MS, LS_ACTIVITY, create, shared });
  root.MultiCCUserPresence = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
