(function attachMultiCCVoiceReadiness(global) {
  'use strict';

  // The mic button's "voice is not set up yet" guide, shared by the Chat page
  // and the Air quick-task composer (both load voice-composer.js).
  //
  // Before a recording starts the composer asks GET /api/voice/readiness
  // (src/voice/readiness.js). When nothing can recognise speech it shows this
  // card instead of letting the user dictate into a request that is bound to
  // fail. The card fixes the problem where it stands:
  //   · local model missing / failed → "Download offline model" starts the
  //     download and the card follows it (progress, speed, time left) until it
  //     says "ready — tap the mic";
  //   · no way to run it locally → "Use cloud recognition" opens voice settings
  //     to enter a key.
  // Copy goes through window.t with the same keys the Air voice settings use,
  // so the progress line reads identically in both places.
  const POLL_MS = 1500;
  const READY_HIDE_MS = 6000;
  const SETTINGS_URL = '/air?view=voice';

  const STYLE = `
.mcc-voice-guide { position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%); z-index: 1200;
  width: min(420px, calc(100vw - 24px)); box-sizing: border-box; padding: 14px 16px; border-radius: 12px;
  border: 1px solid var(--border, #d9d9d9); background: var(--surface, #fff); color: var(--text, #222);
  box-shadow: 0 10px 30px rgba(0,0,0,.14); font-size: 13px; line-height: 1.55; }
.mcc-voice-guide[hidden] { display: none; }
.mcc-voice-guide-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.mcc-voice-guide-head strong { flex: 1; font-size: 13.5px; }
.mcc-voice-guide-close { border: 0; background: transparent; color: var(--muted, #888); font-size: 16px; cursor: pointer; padding: 0 2px; }
.mcc-voice-guide-desc { margin: 0; color: var(--muted, #666); }
.mcc-voice-guide-desc.ok { color: #2c7d5c; }
.mcc-voice-guide-desc.err { color: #b34b34; }
.mcc-voice-guide-bar { height: 6px; margin: 10px 0 4px; border-radius: 999px; background: var(--hairline, #eee); overflow: hidden; }
.mcc-voice-guide-bar[hidden] { display: none; }
.mcc-voice-guide-fill { height: 100%; width: 0; border-radius: 999px; background: var(--accent, #3a7bd5); transition: width .3s ease; }
.mcc-voice-guide-progress { color: var(--faint, #999); font-size: 11.5px; }
.mcc-voice-guide-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.mcc-voice-guide-actions button { width: auto; min-height: 32px; padding: 5px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--border, #d9d9d9); background: transparent; color: inherit; font-size: 12.5px; }
.mcc-voice-guide-actions button.primary { border-color: var(--accent, #3a7bd5); background: var(--accent, #3a7bd5); color: #fff; }
.mcc-voice-guide-actions button[hidden] { display: none; }
.mcc-voice-guide-actions button:disabled { opacity: .6; cursor: default; }`;

  function createVoiceReadiness(options) {
    const opts = options || {};
    const win = opts.window || global;
    const doc = opts.document || win.document;
    const fetchFn = opts.fetch || (win.fetch && win.fetch.bind(win));
    const withToken = opts.withToken || (url => url);
    const tr = (key, fallback, params) => {
      const fn = typeof opts.t === 'function' ? opts.t : win.t;
      const value = typeof fn === 'function' ? fn(key, params) : '';
      if (value && value !== key) return value;
      return String(fallback || key).replace(/\{(\w+)\}/g, (_, k) => (params && params[k] != null ? params[k] : ''));
    };
    // Sizes go through shared/format.js (loaded before this file on both pages);
    // public/ must not grow a second byte formatter.
    const bytes = n => (typeof win.formatBytes === 'function' ? win.formatBytes(n || 0) : String(n || 0));

    // null = never asked; the first answer is fetched at bind time so a click
    // can usually decide without waiting on the network.
    let known = null;
    let card = null;
    let poll = null;
    let hideTimer = null;
    let busy = false;

    async function check() {
      if (!fetchFn) return null;
      try {
        const response = await fetchFn(withToken('/api/voice/readiness'));
        if (!response.ok) return null;
        known = await response.json();
        return known;
      } catch (_) {
        // A readiness probe must never be the reason the mic stops working.
        return null;
      }
    }

    // Resolves true when recording may start. Only a confirmed "not ready"
    // blocks; an unknown answer lets the recogniser speak for itself.
    async function ensureReady() {
      if (known && known.ready) return true;
      const r = await check();
      if (!r || r.ready) return true;
      show(r);
      return false;
    }

    function mount() {
      if (card || !doc || !doc.body) return card;
      if (!doc.getElementById('mcc-voice-guide-style')) {
        const style = doc.createElement('style');
        style.id = 'mcc-voice-guide-style';
        style.textContent = STYLE;
        (doc.head || doc.body).appendChild(style);
      }
      card = doc.createElement('div');
      card.id = 'mcc-voice-guide';
      card.className = 'mcc-voice-guide';
      card.setAttribute('role', 'dialog');
      card.hidden = true;
      card.innerHTML = `
        <div class="mcc-voice-guide-head"><strong data-part="title"></strong>
          <button type="button" class="mcc-voice-guide-close" data-part="close">×</button></div>
        <p class="mcc-voice-guide-desc" data-part="desc"></p>
        <div class="mcc-voice-guide-bar" data-part="bar" hidden><div class="mcc-voice-guide-fill" data-part="fill"></div></div>
        <div class="mcc-voice-guide-progress" data-part="progress"></div>
        <div class="mcc-voice-guide-actions">
          <button type="button" class="primary" data-part="local"></button>
          <button type="button" data-part="cloud"></button>
        </div>`;
      doc.body.appendChild(card);
      part('close').setAttribute('aria-label', tr('voiceGuideClose', 'Close'));
      part('close').onclick = hide;
      part('local').onclick = () => localAction(part('local').dataset.action);
      part('cloud').onclick = openSettings;
      return card;
    }

    const part = name => card.querySelector(`[data-part="${name}"]`);

    function progressText(dl) {
      const parts = [tr('airVoiceLocalProgress', '{percent}% · {done} / {total}', {
        percent: dl.percent || 0, done: bytes(dl.doneBytes), total: bytes(dl.totalBytes),
      })];
      if (dl.bytesPerSec > 0) parts.push(tr('airVoiceLocalSpeed', '{value}/s', { value: bytes(dl.bytesPerSec) }));
      if (dl.etaSec > 0) {
        const m = Math.floor(dl.etaSec / 60);
        const s = dl.etaSec % 60;
        parts.push(m ? tr('airVoiceLocalEtaMin', '{m} min {s} s left', { m, s }) : tr('airVoiceLocalEtaSec', '{n} s left', { n: s }));
      }
      return parts.join(' · ');
    }

    function paint(r) {
      if (!mount()) return;
      const dl = r.download || {};
      const reason = r.ready ? 'ready' : r.reason;
      const desc = part('desc');
      const local = part('local');
      const cloud = part('cloud');
      const bar = part('bar');
      desc.className = 'mcc-voice-guide-desc';
      part('title').textContent = r.ready ? tr('voiceGuideReadyTitle', 'Voice input is ready') : tr('voiceGuideTitle', 'Voice input is not set up yet');
      bar.hidden = reason !== 'downloading';
      part('fill').style.width = `${Math.max(0, Math.min(100, dl.percent || 0))}%`;
      part('progress').textContent = reason === 'downloading' ? progressText(dl) : '';
      local.hidden = false;
      cloud.hidden = false;
      cloud.textContent = tr('voiceGuideUseCloud', 'Use cloud recognition (enter a key)');
      if (reason === 'ready') {
        desc.textContent = tr('voiceGuideReadyDesc', 'The offline model is installed. Tap the mic to start talking.');
        desc.classList.add('ok');
        local.hidden = true;
        cloud.hidden = true;
      } else if (reason === 'downloading') {
        desc.textContent = tr('voiceGuideDownloading', 'Downloading the offline speech model. You can keep working; this card tells you when it is ready.');
        local.textContent = tr('airVoiceLocalCancel', 'Cancel download');
        local.dataset.action = 'cancel';
        local.className = '';
      } else if (reason === 'failed') {
        desc.textContent = tr('voiceGuideFailed', 'The download failed: {error}. Retry, or use cloud recognition instead.', {
          error: dl.error || tr('airVoiceLocalUnknownError', 'unknown error'),
        });
        desc.classList.add('err');
        local.textContent = tr('airVoiceLocalRetry', 'Retry');
        local.dataset.action = 'download';
        local.className = 'primary';
      } else if (reason === 'unsupported' || reason === 'disabled') {
        desc.textContent = reason === 'unsupported'
          ? tr('voiceGuideUnsupported', 'This computer cannot run the offline speech model. Enter a cloud recognition key to use voice input.')
          : tr('voiceGuideDisabled', 'Offline recognition is turned off (ASR_LOCAL=off). Enter a cloud recognition key to use voice input.');
        local.hidden = true;
        cloud.className = 'primary';
      } else {
        desc.textContent = tr('voiceGuideMissing', 'Speech is recognised on this computer once the offline model ({size}) is downloaded — free and private. Or use a cloud service with your own key.', {
          size: dl.totalBytes ? bytes(dl.totalBytes) : '229 MB',
        });
        local.textContent = tr('voiceGuideDownload', 'Download offline model');
        local.dataset.action = 'download';
        local.className = 'primary';
      }
      if (reason !== 'unsupported' && reason !== 'disabled') cloud.className = '';
    }

    function show(r) {
      if (!r || !mount()) return;
      if (hideTimer) { win.clearTimeout(hideTimer); hideTimer = null; }
      card.hidden = false;
      paint(r);
      if (!r.ready && r.reason === 'downloading') startPoll();
      else stopPoll();
    }

    function hide() {
      stopPoll();
      if (hideTimer) { win.clearTimeout(hideTimer); hideTimer = null; }
      if (card) card.hidden = true;
    }

    function startPoll() {
      if (poll) return;
      poll = win.setInterval(async () => {
        if (!card || card.hidden) { stopPoll(); return; }
        const r = await check();
        if (!r) return;
        show(r);
        if (r.ready) hideTimer = win.setTimeout(hide, READY_HIDE_MS);
      }, POLL_MS);
    }

    function stopPoll() {
      if (!poll) return;
      win.clearInterval(poll);
      poll = null;
    }

    async function localAction(action) {
      if (busy || !fetchFn || !action) return;
      busy = true;
      part('local').disabled = true;
      try {
        const response = await fetchFn(withToken('/api/settings/voice/asr-model'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        const r = await check();
        if (r) show(r);
        else if (body.status) show({ ready: false, reason: body.status.state, download: body.status });
      } catch (error) {
        const desc = part('desc');
        desc.textContent = tr('airVoiceLocalActionFailed', 'Failed: {error}', { error: error.message || String(error) });
        desc.className = 'mcc-voice-guide-desc err';
      } finally {
        busy = false;
        if (card) part('local').disabled = false;
      }
    }

    function openSettings() {
      // In a computer scope the entry console is above us: navigate the
      // outermost scoped window instead of escaping to the entry's top page.
      const scope = win.MultiCCMachineScope;
      if (scope) {
        const target = typeof scope.rootWindow === 'function' ? scope.rootWindow() : win;
        target.location.assign(scope.navigation(SETTINGS_URL));
        return;
      }
      // The Chat page usually lives in an Air iframe; settings belong to the top window.
      let target = win;
      try { if (win.top && win.top.location && win.top.location.origin === win.location.origin) target = win.top; } catch (_) {}
      target.location.assign(SETTINGS_URL);
    }

    return Object.freeze({
      check, ensureReady, show, hide,
      get ready() { return !!(known && known.ready); },
      get element() { return card; },
    });
  }

  global.MultiCCVoiceReadiness = Object.freeze({ createVoiceReadiness, SETTINGS_URL });
})(typeof window !== 'undefined' ? window : globalThis);
