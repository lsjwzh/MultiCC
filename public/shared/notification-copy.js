'use strict';

// ONE source for the words a classify outcome is announced with on the web:
// notification title, spoken voice line, ding and the bar/badge label.
//
// Before this file every page re-typed its own table: client.js said
// '等待操作 / 本轮执行成功', pwa.js held an English fallback, chat-live-ui.js had a
// half hand-written letter table, chat-event-controller.js had another one plus
// a dead `classifyState === 'C'` branch, chat-notifications.js built its own
// title ('任务异常' for what the server calls '出现异常') and s2s-session.js
// spoke '正在等待你的下一步指示。'. They disagreed.
//
// The table is keyed by classify LETTER (D/C/W/B/E/P). A push payload carries
// the TYPE instead, so types are mapped back to their letter — B pushes
// `waiting` exactly like W, and the two must not say the same words.
//
// Same words as src/push/notification-copy.js (push titles) and as the vocab's
// CLASSIFY_DISPLAY.voiceText (voice lines). The FALLBACK column below is what a
// page without i18n.js (the terminal page) renders; tests/test-notification-copy.js
// pins all three against each other.
(function attachMultiCCNotificationCopy(root) {
  'use strict';

  // letter → descriptor. `titleKey` is the whole 'MultiCC #<session>: …' string
  // (as the i18n catalog defines it), `labelKey` is the short bar/badge word,
  // `voiceKey` the spoken line.
  const COPY = {
    D: {
      key: 'succeeded', type: 'succeeded', titleKey: 'notificationSucceededTitle',
      voiceKey: 'voiceExecutionSucceeded', labelKey: 'classifySucceeded',
      ding: 'succeeded', background: false,
    },
    C: {  // retired: parseClassifyResult collapses C→W. A C persisted by an old
          // server is announced exactly like W, but never spoken or dinged.
      key: 'waiting', type: 'waiting', titleKey: 'notificationWaitingTitle',
      voiceKey: null, labelKey: 'classifyContinuing',
      ding: null, background: false,
    },
    W: {
      key: 'waiting', type: 'waiting', titleKey: 'notificationWaitingTitle',
      voiceKey: 'voiceWaitingAction', labelKey: 'classifyWaitingUser',
      ding: 'waiting', background: false,
    },
    B: {  // waiting on a background job — nothing is waiting on the user
      key: 'waiting_background', type: 'waiting', titleKey: 'notificationWaitingBackgroundTitle',
      voiceKey: 'voiceWaitingBackground', labelKey: 'classifyWaitingBackground',
      ding: 'waiting', background: true,
    },
    E: {
      key: 'error', type: 'error', titleKey: 'notificationErrorStateTitle',
      voiceKey: 'voiceApiInterrupted', labelKey: 'classifyApiError',
      ding: 'error', background: false,
    },
    P: {  // mid-turn: status only, nothing to announce
      key: 'running', type: null, titleKey: null,
      voiceKey: null, labelKey: 'classifyProcessing',
      ding: null, background: false,
    },
  };

  // A push payload (and a legacy notify frame) carries the TYPE, not the letter.
  const LETTER_OF_TYPE = {
    succeeded: 'D', completed: 'D', waiting: 'W', waiting_background: 'B',
    error: 'E', running: 'P',
  };

  // Used when the page has no i18n dictionary loaded (the terminal page). The
  // words are the catalog's own values for the keys above — pinned by the test
  // against both i18n-catalog and the classify vocab's voiceText.
  const FALLBACK = {
    succeeded: { zh: '执行成功', en: 'Execution succeeded', voiceZh: '本轮执行成功', voiceEn: 'Execution succeeded' },
    waiting: { zh: '等待操作', en: 'Action Required', voiceZh: '等待你的操作', voiceEn: 'Waiting for your action' },
    waiting_background: { zh: '后台等待', en: 'Waiting in background', voiceZh: '等待后台任务', voiceEn: 'Waiting for a background task' },
    error: { zh: '出现异常', en: 'Error', voiceZh: 'API 异常中断，等待重试中', voiceEn: 'Interrupted by an API error; waiting to retry' },
    // P (mid-turn) is a status, not an alert: it has no title key, so this is
    // what `notificationTitle` uses when it is asked anyway.
    running: { zh: '处理中', en: 'Processing', voiceZh: '', voiceEn: '' },
  };

  /**
   * Resolve a classify letter OR a push type to its canonical letter.
   * Unknown/absent resolves to W — the vocab's own fallback, so an unknown
   * letter can never announce itself as a success.
   */
  function letterFor(spec) {
    const raw = String(spec == null ? '' : spec).trim();
    if (Object.prototype.hasOwnProperty.call(COPY, raw.toUpperCase())) return raw.toUpperCase();
    return LETTER_OF_TYPE[raw.toLowerCase()] || 'W';
  }

  /**
   * The copy descriptor for a classify letter or push type.
   * @returns {{letter: string, key: string, type: string|null, titleKey: string|null,
   *   voiceKey: string|null, labelKey: string, ding: string|null, background: boolean,
   *   matched: boolean}} `matched` is false when the caller passed something the
   *   table does not know (the entry is then W's).
   */
  function notificationCopy(spec) {
    const raw = String(spec == null ? '' : spec).trim();
    const matched = Object.prototype.hasOwnProperty.call(COPY, raw.toUpperCase())
      || !!LETTER_OF_TYPE[raw.toLowerCase()];
    return Object.assign({}, COPY[letterFor(raw)], { letter: letterFor(raw), matched });
  }

  function pageLocale() {
    return typeof root.getLang === 'function' && root.getLang() === 'en' ? 'en' : 'zh';
  }

  // A page-supplied translate (chat-live-ui's bound `translate`, i18n.js's t())
  // wins; when the page has none, the built-in column is the answer. A key the
  // dictionary does not know comes back as the key itself, which must never
  // reach a lock screen or a speaker — that is what `known` filters.
  function translate(pageTranslate, key, params) {
    if (!key) return null;
    const fn = typeof pageTranslate === 'function' ? pageTranslate
      : (typeof root.t === 'function' ? root.t : null);
    if (!fn) return null;
    const out = fn(key, params);
    return out && out !== key ? out : null;
  }

  /**
   * The full notification title ('MultiCC #<session>: …'), localized. Falls
   * back to the shared table on pages without an i18n dictionary.
   */
  function notificationTitle(spec, sessionId, pageTranslate) {
    const entry = notificationCopy(spec);
    const sid = sessionId == null || sessionId === '' ? 'session' : String(sessionId);
    return translate(pageTranslate, entry.titleKey, { session: sid })
      || `MultiCC #${sid}: ${FALLBACK[entry.key][pageLocale()]}`;
  }

  /** The spoken line for an outcome, or '' when it has nothing to announce. */
  function notificationVoice(spec, pageTranslate) {
    const entry = notificationCopy(spec);
    if (!entry.voiceKey) return '';
    const lang = pageLocale();
    return translate(pageTranslate, entry.voiceKey)
      || (lang === 'en' ? FALLBACK[entry.key].voiceEn : FALLBACK[entry.key].voiceZh);
  }

  /** The ding/local-notification bucket ('succeeded'|'waiting'|'error') or null. */
  function notificationDing(spec) {
    return notificationCopy(spec).ding;
  }

  const api = Object.freeze({
    COPY,
    FALLBACK,
    letterFor,
    notificationCopy,
    notificationDing,
    notificationTitle,
    notificationVoice,
  });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCNotificationCopy = api;
})(typeof window !== 'undefined' ? window : globalThis);
