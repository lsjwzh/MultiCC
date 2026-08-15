'use strict';

// Task notification controller for the standalone chat page.
// Kept as a classic script because chat.html/chat.js still expose a small set
// of global functions to inline handlers and older clients.
(function installChatNotifications(root) {
  const NOTIFY_COOLDOWN = 8000;

  function normalizeNotificationType(type) {
    return type === 'waiting' || type === 'error' ? type : 'succeeded';
  }

  function dingFrequencies(type) {
    if (type === 'succeeded' || type === 'completed') return [1046.5, 1567.98];
    if (type === 'error') return [783.99, 622.25];
    return [659.25];
  }

  function localNotificationPayload(sessionId, text, type, url) {
    const sid = sessionId || 'chat';
    const normalizedType = normalizeNotificationType(type);
    const titleSuffix = normalizedType === 'waiting'
      ? '等待操作'
      : normalizedType === 'error' ? '任务异常' : '执行成功';
    return {
      sessionId: sid,
      type: normalizedType,
      title: `MultiCC #${sid}: ${titleSuffix}`,
      body: text,
      url,
    };
  }

  // Notification URLs are persisted outside the page (service worker / OS
  // notification metadata). Keep only navigation parameters that the chat page
  // actually needs; never copy arbitrary query strings or fragments.
  function safeNotificationUrl(location, URLCtor) {
    const source = location || {};
    const path = String(source.pathname || '/chat.html');
    const Ctor = URLCtor || (root && root.URL);
    if (typeof Ctor !== 'function') return path.startsWith('/') ? path : '/chat.html';
    try {
      const parsed = new Ctor(path + String(source.search || ''), 'http://multicc.invalid');
      const safe = new Ctor(parsed.pathname, 'http://multicc.invalid');
      for (const key of ['session', 'cwd']) {
        const value = parsed.searchParams.get(key);
        if (value != null && value !== '') safe.searchParams.set(key, value);
      }
      return safe.pathname + safe.search;
    } catch (_) {
      return '/chat.html';
    }
  }

  function createNotificationController(options) {
    const opts = options || {};
    const win = opts.window || root;
    const doc = opts.document || win.document;
    const notifyBtn = opts.notifyBtn || null;
    const notifyToast = opts.notifyToast || null;
    const getSessionId = typeof opts.getSessionId === 'function' ? opts.getSessionId : () => '';
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const schedule = typeof opts.setTimeout === 'function' ? opts.setTimeout : win.setTimeout.bind(win);
    const cancelSchedule = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : win.clearTimeout.bind(win);

    let enabled = typeof opts.getTaskNotifyEnabled === 'function'
      ? opts.getTaskNotifyEnabled(getSessionId())
      : true;
    const lastNotificationAt = { succeeded: 0, waiting: 0, error: 0 };
    let toastTimer = null;
    let togglePromise = null;

    function updateButton() {
      if (!notifyBtn) return;
      const pushInfo = typeof opts.getPushInfo === 'function' ? opts.getPushInfo() : null;
      const pushOn = !!(pushInfo && pushInfo.subscribed);
      if (enabled) {
        notifyBtn.style.background = '#1f6feb';
        notifyBtn.style.borderColor = '#58a6ff';
        notifyBtn.style.color = '#fff';
        notifyBtn.title = pushOn ? '任务提醒 (系统通知已开启)' : '任务提醒 (点击开启系统通知)';
      } else {
        notifyBtn.style.background = '#21262d';
        notifyBtn.style.borderColor = '#30363d';
        notifyBtn.style.color = '#c9d1d9';
        notifyBtn.title = '任务提醒 (已关闭)';
      }
    }

    function persistPreference(value) {
      if (typeof opts.setTaskNotifyEnabled === 'function') {
        opts.setTaskNotifyEnabled(getSessionId(), value);
      }
    }

    function toggle() {
      if (togglePromise) return togglePromise;
      if (notifyBtn) notifyBtn.disabled = true;
      togglePromise = (async () => {
        const pushOn = typeof opts.isPushSubscribed === 'function' && opts.isPushSubscribed();
        if (enabled && pushOn) {
          enabled = false;
          persistPreference(false);
          updateButton();
          if (typeof opts.unsubscribePush === 'function') await opts.unsubscribePush();
          return enabled;
        }

        enabled = true;
        persistPreference(true);
        updateButton();
        if (typeof opts.ensurePushSubscribed === 'function') {
          const ok = await opts.ensurePushSubscribed();
          if (!ok) {
            enabled = false;
            persistPreference(false);
          }
        }
        return enabled;
      })().finally(() => {
        togglePromise = null;
        if (notifyBtn) notifyBtn.disabled = false;
        updateButton();
      });
      return togglePromise;
    }

    function refreshPreference() {
      if (typeof opts.getTaskNotifyEnabled === 'function') {
        enabled = opts.getTaskNotifyEnabled(getSessionId());
        updateButton();
      }
      return enabled;
    }

    function dismissToast() {
      if (notifyToast) notifyToast.style.display = 'none';
      if (toastTimer) {
        cancelSchedule(toastTimer);
        toastTimer = null;
      }
    }

    function showToast(text, type) {
      if (!notifyToast) return;
      const closeBtn = notifyToast.querySelector('.toast-close');
      notifyToast.textContent = '';
      notifyToast.appendChild(doc.createTextNode(text + ' '));
      if (closeBtn) notifyToast.appendChild(closeBtn);
      notifyToast.className = type;
      notifyToast.style.display = 'block';
      if (toastTimer) cancelSchedule(toastTimer);
      toastTimer = schedule(dismissToast, type === 'running' ? 8000 : 15000);
    }

    function playDing(type) {
      try {
        const AudioContext = win.AudioContext || win.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();
        const frequencies = dingFrequencies(type);
        const startedAt = ctx.currentTime;
        frequencies.forEach((frequency, index) => {
          const oscillator = ctx.createOscillator();
          const gain = ctx.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, startedAt + index * 0.12);
          gain.gain.exponentialRampToValueAtTime(0.25, startedAt + index * 0.12 + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, startedAt + index * 0.12 + 0.28);
          oscillator.connect(gain).connect(ctx.destination);
          oscillator.start(startedAt + index * 0.12);
          oscillator.stop(startedAt + index * 0.12 + 0.3);
        });
        schedule(() => { try { ctx.close(); } catch (_) {} }, frequencies.length * 120 + 400);
      } catch (_) {}
    }

    function speak(text, type) {
      if (!enabled) return false;

      const normalizedType = normalizeNotificationType(type);
      const timestamp = now();
      if (timestamp - lastNotificationAt[normalizedType] < NOTIFY_COOLDOWN) return false;
      lastNotificationAt[normalizedType] = timestamp;

      if (doc.visibilityState === 'visible') {
        playDing(normalizedType);
        return true;
      }

      showToast(text, normalizedType);

      if (typeof opts.showLocalTaskNotification === 'function') {
        const location = opts.location || win.location || { pathname: '', search: '' };
        opts.showLocalTaskNotification(localNotificationPayload(
          getSessionId(),
          text,
          normalizedType,
          safeNotificationUrl(location, win.URL),
        ));
      }

      if (win.speechSynthesis && typeof win.SpeechSynthesisUtterance === 'function') {
        const utterance = new win.SpeechSynthesisUtterance(text);
        utterance.lang = 'zh-CN';
        utterance.rate = 1.1;
        utterance.volume = 0.8;
        win.speechSynthesis.speak(utterance);
      }
      return true;
    }

    async function onNotifyClick() {
      try { await toggle(); } catch (_) { updateButton(); }
    }

    function onVisibilityChange() {
      if (doc.visibilityState !== 'visible') return;
      dismissToast();
      if (win.speechSynthesis) win.speechSynthesis.cancel();
    }

    if (notifyBtn) notifyBtn.addEventListener('click', onNotifyClick);
    if (notifyToast) notifyToast.addEventListener('click', dismissToast);
    win.addEventListener('multicc-push-state', updateButton);
    doc.addEventListener('visibilitychange', onVisibilityChange);
    updateButton();

    function destroy() {
      dismissToast();
      if (notifyBtn) notifyBtn.removeEventListener('click', onNotifyClick);
      if (notifyToast) notifyToast.removeEventListener('click', dismissToast);
      win.removeEventListener('multicc-push-state', updateButton);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
    }

    return Object.freeze({
      destroy,
      dismissToast,
      isEnabled: () => enabled,
      playDing,
      refreshPreference,
      showToast,
      speak,
      toggle,
      updateButton,
    });
  }

  root.MultiCCChatNotifications = Object.freeze({
    NOTIFY_COOLDOWN,
    createNotificationController,
    dingFrequencies,
    localNotificationPayload,
    normalizeNotificationType,
    safeNotificationUrl,
  });
})(typeof window !== 'undefined' ? window : globalThis);
