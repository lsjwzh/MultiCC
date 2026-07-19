'use strict';

// Mobile-safe scroll ownership for the classic Web chat. DOM producers call
// maybeFollow() after content changes; this controller alone decides whether
// to follow the tail or preserve a user's history position.
(function attachChatScrollController(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCChatScrollController = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  function createScrollController(options = {}) {
    const win = options.window || globalThis;
    const doc = options.document || win.document;
    const messagesEl = options.messagesEl;
    if (!doc || !messagesEl) throw new TypeError('document and messagesEl are required');

    const translate = options.translate || (key => key);
    const threshold = Number.isFinite(options.threshold) ? options.threshold : 48;
    const now = options.now || Date.now;
    const setTimer = options.setTimeout || win.setTimeout.bind(win);
    const clearTimer = options.clearTimeout || win.clearTimeout.bind(win);
    const requestFrame = options.requestAnimationFrame
      || (typeof win.requestAnimationFrame === 'function'
        ? win.requestAnimationFrame.bind(win)
        : callback => setTimer(callback, 0));
    const cancelFrame = options.cancelAnimationFrame
      || (typeof win.cancelAnimationFrame === 'function'
        ? win.cancelAnimationFrame.bind(win)
        : clearTimer);

    let userPinnedAway = false;
    let unreadCount = 0;
    let unreadArmed = true;
    let userIntentUntil = 0;
    let settlingUntil = 0;
    let pill = null;
    let pillText = null;
    let followFrame = null;
    let retryTimers = [];

    function distanceFromBottom() {
      return Math.max(0, messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight);
    }

    function isAtBottom() {
      return distanceFromBottom() <= threshold;
    }

    function writeBottom() {
      messagesEl.scrollTop = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
    }

    function scheduleFrameFollow() {
      if (followFrame !== null) return;
      followFrame = requestFrame(() => {
        followFrame = null;
        if (!userPinnedAway) writeBottom();
      });
    }

    // Write synchronously first. Mobile WebViews can delay animation frames
    // during navigation/visibility transitions, so rAF is only a layout retry.
    function scrollToBottom() {
      if (userPinnedAway) return;
      writeBottom();
      scheduleFrameFollow();
    }

    function positionPill() {
      if (!pill || typeof messagesEl.getBoundingClientRect !== 'function') return;
      const rect = messagesEl.getBoundingClientRect();
      if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.bottom)) return;
      const height = pill.offsetHeight || 34;
      pill.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
      pill.style.top = `${Math.round(Math.max(rect.top + 8, rect.bottom - height - 12))}px`;
    }

    function updatePillText() {
      if (!pillText) return;
      pillText.textContent = unreadCount > 0
        ? translate('newMessagesCount', { n: String(unreadCount) })
        : translate('backToBottom');
    }

    function ensurePill() {
      if (pill) return pill;
      pill = doc.createElement('button');
      pill.type = 'button';
      pill.id = 'new-msg-pill';
      pill.className = 'new-msg-pill';
      pill.setAttribute?.('aria-live', 'polite');
      const icon = doc.createElement('span');
      icon.className = 'new-msg-pill-icon';
      icon.textContent = '↓';
      pillText = doc.createElement('span');
      pillText.className = 'new-msg-pill-text';
      pill.appendChild(icon);
      pill.appendChild(pillText);
      pill.addEventListener?.('click', forceToBottom);
      if (!pill.addEventListener) pill.onclick = forceToBottom;
      (doc.body || messagesEl).appendChild(pill);
      return pill;
    }

    function showPill() {
      ensurePill();
      updatePillText();
      pill.classList.add('show');
      positionPill();
    }

    function hidePill() {
      pill?.classList.remove('show');
    }

    function clearRetries() {
      for (const timer of retryTimers) clearTimer(timer);
      retryTimers = [];
    }

    function forceToBottom() {
      userPinnedAway = false;
      unreadCount = 0;
      unreadArmed = true;
      hidePill();
      clearRetries();
      settlingUntil = now() + 420;
      scrollToBottom();
      // Re-run after layout, font and mobile viewport settling. Every retry
      // checks pinned state so an intentional touch/wheel immediately wins.
      retryTimers = [0, 80, 320].map((delay, index, delays) => setTimer(() => {
        if (userPinnedAway) return;
        scrollToBottom();
        if (index === delays.length - 1 && !isAtBottom()) {
          userPinnedAway = true;
          showPill();
        }
      }, delay));
    }

    function bumpUnread() {
      if (!userPinnedAway || !unreadArmed) return;
      unreadArmed = false;
      unreadCount += 1;
      showPill();
    }

    // This is called after a DOM mutation. _userPinnedAway is the source of
    // truth; checking geometry here would mistake newly-added height for a
    // user scroll, which is the mobile bug this module prevents.
    function maybeFollow() {
      if (!userPinnedAway) scrollToBottom();
      else bumpUnread();
    }

    function handleLayoutChange() {
      if (!userPinnedAway) scrollToBottom();
      else showPill();
    }

    function rearmUnread() {
      unreadArmed = true;
    }

    function markUserIntent() {
      userIntentUntil = now() + 1500;
    }

    function handleScroll({ userInitiated = false } = {}) {
      if (isAtBottom()) {
        userPinnedAway = false;
        unreadCount = 0;
        unreadArmed = true;
        hidePill();
        return;
      }
      const intentional = userInitiated || now() <= userIntentUntil;
      if (!intentional && now() < settlingUntil) return;
      userPinnedAway = true;
      showPill();
    }

    const onScroll = () => handleScroll();
    const onUserIntent = () => markUserIntent();
    const onViewportChange = () => {
      positionPill();
      handleLayoutChange();
    };
    messagesEl.addEventListener?.('scroll', onScroll, { passive: true });
    messagesEl.addEventListener?.('wheel', onUserIntent, { passive: true });
    messagesEl.addEventListener?.('touchstart', onUserIntent, { passive: true });
    messagesEl.addEventListener?.('pointerdown', onUserIntent, { passive: true });
    win.addEventListener?.('resize', onViewportChange, { passive: true });
    win.visualViewport?.addEventListener?.('resize', onViewportChange, { passive: true });

    function snapshot() {
      return Object.freeze({
        atBottom: isAtBottom(),
        distanceFromBottom: distanceFromBottom(),
        userPinnedAway,
        unreadCount,
        pillVisible: !!pill?.classList.contains('show'),
      });
    }

    function destroy() {
      clearRetries();
      if (followFrame !== null) cancelFrame(followFrame);
      messagesEl.removeEventListener?.('scroll', onScroll);
      messagesEl.removeEventListener?.('wheel', onUserIntent);
      messagesEl.removeEventListener?.('touchstart', onUserIntent);
      messagesEl.removeEventListener?.('pointerdown', onUserIntent);
      win.removeEventListener?.('resize', onViewportChange);
      win.visualViewport?.removeEventListener?.('resize', onViewportChange);
      pill?.remove?.();
    }

    return Object.freeze({
      bumpUnread,
      destroy,
      forceToBottom,
      handleLayoutChange,
      handleScroll,
      isAtBottom,
      markUserIntent,
      maybeFollow,
      positionPill,
      rearmUnread,
      scrollToBottom,
      snapshot,
    });
  }

  return Object.freeze({ createScrollController });
});
