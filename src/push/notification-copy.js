'use strict';

// ONE source for the words a classify outcome is announced with.
//
// Before this file the same three phrases were re-typed at every notify site —
// src/push/runtime.js kept its own zh+en table inside `payloadForLocale`, while
// src/classify/vocab.js CLASSIFY_DISPLAY already carried a `pushTitle` per
// letter that NOBODY read. The lock-screen title is now derived from one table
// here, and tests/test-notification-copy.js pins it against the vocab, so a new
// letter or a reworded state cannot leave the push copy behind.
//
// zh comes straight from CLASSIFY_DISPLAY (the canonical wording), whose B
// entry now carries its own background wording instead of the W wording it
// borrowed. Every letter therefore reads the same field, `pushTitle`.
//
// Callers hand over either a classify LETTER (D/W/B/E/P/C) or a push TYPE
// (succeeded/waiting/error): `notify()` is called with a type, the classify
// broadcast carries a letter. The TYPE on the wire is unchanged — B still
// pushes `waiting` (clients and the service worker switch on it); only the
// title differs, which is what the user actually reads.

const { classifyDisplay } = require('../classify/vocab');

const COPY = Object.freeze({
  succeeded: Object.freeze({ zh: classifyDisplay('D').pushTitle, en: 'Execution succeeded' }),
  waiting: Object.freeze({ zh: classifyDisplay('W').pushTitle, en: 'Action Required' }),
  // B — "nothing is waiting on you, a background job is". Its own words, never W's.
  waiting_background: Object.freeze({ zh: classifyDisplay('B').pushTitle, en: 'Waiting in background' }),
  error: Object.freeze({ zh: classifyDisplay('E').pushTitle, en: 'Error' }),
  // P (mid-turn) and C never reach the push path — their vocab `pushType` is
  // null. They still resolve to words rather than to `undefined` so no caller
  // can put "MultiCC #x: undefined" on a lock screen.
  running: Object.freeze({ zh: classifyDisplay('P').label, en: 'Processing' }),
});

// letter / type (lowercased) → copy key. C is retired (parseClassifyResult
// collapses it to W) but a legacy persisted C still renders as "wait on user".
const KEY_OF = Object.freeze({
  d: 'succeeded', succeeded: 'succeeded', completed: 'succeeded',
  w: 'waiting', waiting: 'waiting', c: 'waiting',
  b: 'waiting_background', waiting_background: 'waiting_background',
  e: 'error', error: 'error',
  p: 'running', running: 'running', processing: 'running',
});

/**
 * Copy key for a classify letter or a push type.
 * An unrecognized single LETTER follows the vocab's own fallback (W), so a new
 * letter never announces itself as a success. An unrecognized word keeps the
 * runtime's long-standing "anything that is not waiting/error succeeded"
 * default for ad-hoc callers (e.g. the `/api/push/notify` route).
 */
function copyKeyFor(spec) {
  const raw = String(spec == null ? '' : spec).trim();
  if (!raw) return 'succeeded';
  const key = KEY_OF[raw.toLowerCase()];
  if (key) return key;
  return raw.length === 1 ? 'waiting' : 'succeeded';
}

/**
 * The announcement copy for one classify outcome.
 * @param {string} spec classify letter (D/C/W/B/E/P) or push type (succeeded/waiting/error)
 * @param {string} [locale] 'zh' (default) or 'en'
 * @returns {{key: string, locale: string, title: string}} `title` is the phrase
 *   that follows the `MultiCC #<session>: ` prefix — never the whole title, so
 *   the payload shape stays the runtime's business.
 */
function notificationCopy(spec, locale) {
  const key = copyKeyFor(spec);
  const lang = locale === 'en' ? 'en' : 'zh';
  return { key, locale: lang, title: COPY[key][lang] };
}

module.exports = { COPY, KEY_OF, copyKeyFor, notificationCopy };
