'use strict';

// Status presentation: contract pins + status × surface coverage matrix.
//
// Three things this file defends:
//   1. the display registry stays a MIRROR of the server vocabularies — if
//      someone adds a freeze reason or a classify letter on the server and not
//      here, the status silently degrades to ❔ on every card. That must fail
//      loudly instead.
//   2. every canonical status renders an icon plus an accessible name on every
//      surface, and only `running` may animate — so an errored card always
//      shows ❌ and always stops spinning.
//   3. Web and Flutter say the same thing. The Dart file is parsed, not
//      imported, so this runs in the plain node lane.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SP = require('../public/status-presentation.js');
const { CLASSIFY_DISPLAY, TURN_RUN_STATES } = require('../src/classify/vocab.js');
const { FREEZE_REASON_RUN_STATE } = require('../src/session-work/scheduler.js');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/**
 * The server's run-state list is `TURN_RUN_STATES` in src/classify/vocab.js — ONE
 * list. src/task-board/normalize.js must build its Set from it rather than keep a
 * second hand copy (that copy is how `background` would go missing on the board
 * while every other surface learned about it).
 */
function serverTaskRunStates() {
  const src = read('src/task-board/normalize.js');
  assert.match(
    src,
    /const TASK_RUN_STATES = new Set\(TURN_RUN_STATES\)/,
    'src/task-board/normalize.js must build TASK_RUN_STATES from TURN_RUN_STATES',
  );
  return [...TURN_RUN_STATES];
}

// ── Minimal DOM ─────────────────────────────────────────────────────────────
// applyStatusBadge only needs classList / dataset / children / attributes, so a
// 40-line fake keeps this in the dependency-free unit lane (there is no jsdom in
// this repo). It is deliberately strict: appendChild twice really does produce
// two children, which is what makes the idempotency assertions meaningful.

class FakeElement {
  constructor(doc, tag = 'span') {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.textContent = '';
    this.parentNode = null;
    this._classes = new Set();
    const self = this;
    this.classList = {
      add(...names) { names.forEach(n => n && self._classes.add(n)); },
      remove(...names) { names.forEach(n => self._classes.delete(n)); },
      contains(name) { return self._classes.has(name); },
      toggle(name, force) {
        const on = force === undefined ? !self._classes.has(name) : !!force;
        if (on) self._classes.add(name); else self._classes.delete(name);
        return on;
      },
    };
  }
  get className() { return [...this._classes].join(' '); }
  set className(value) {
    this._classes = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  prepend(node) { node.parentNode = this; this.children.unshift(node); return node; }
  insertBefore(node, ref) {
    const at = ref ? this.children.indexOf(ref) : this.children.length;
    node.parentNode = this;
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
    return node;
  }
  remove() {
    if (!this.parentNode) return;
    const at = this.parentNode.children.indexOf(this);
    if (at >= 0) this.parentNode.children.splice(at, 1);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  childrenWithClass(name) {
    return this.children.filter(kid => String(kid.className || '').split(/\s+/).includes(name));
  }
}

const fakeDocument = { createElement(tag) { return new FakeElement(fakeDocument, tag); } };
function makeEl() { return new FakeElement(fakeDocument); }

// ── 1. Contract pins: the registry mirrors the server vocabularies ──────────

test('classify letters mirror src/classify/vocab.js with no divergence left', () => {
  assert.deepEqual(
    Object.keys(SP.CLASSIFY_LETTER_STATUS).sort(),
    Object.keys(CLASSIFY_DISPLAY).sort(),
    'classify letter table drifted from CLASSIFY_DISPLAY',
  );
  const divergent = [];
  for (const [letter, display] of Object.entries(CLASSIFY_DISPLAY)) {
    const shown = SP.classifyStatus(letter);
    const fromServer = SP.coerceStatus('session', display.cardStatus);
    if (shown !== fromServer) divergent.push(letter);
    assert.notEqual(shown, 'unknown', `classify ${letter} must resolve to a known status`);
  }
  // E used to be the one divergence: cardStatus `waiting` (⏸️ on the session
  // list) against barTint `error` (❌ in the chat bar) — one terminal fact with
  // two faces, which is what let a cancelled turn read as "still waiting"
  // outside while it was already an abnormal end inside. Both now say `error`,
  // so there is no divergence left to document.
  assert.deepEqual(divergent, []);
  assert.equal(SP.classifyStatus('E'), 'error');
  assert.equal(CLASSIFY_DISPLAY.E.cardStatus, 'error');
  assert.equal(CLASSIFY_DISPLAY.E.barTint, 'error');
});

test('freeze reasons mirror FREEZE_REASON_RUN_STATE, configuration_required aside', () => {
  assert.deepEqual(
    Object.keys(SP.FREEZE_REASON_STATUS).sort(),
    Object.keys(FREEZE_REASON_RUN_STATE).sort(),
    'freeze reason table drifted from the scheduler',
  );
  const divergent = Object.keys(FREEZE_REASON_RUN_STATE)
    .filter(key => SP.FREEZE_REASON_STATUS[key] !== FREEZE_REASON_RUN_STATE[key]);
  assert.deepEqual(divergent, ['configuration_required']);
  assert.equal(SP.FREEZE_REASON_STATUS.configuration_required, 'blocked');
  assert.equal(FREEZE_REASON_RUN_STATE.configuration_required, 'waiting');
});

test('every server run state is a first-class display status', () => {
  for (const state of serverTaskRunStates()) {
    assert.equal(SP.coerceStatus('task', state), state, `task runState ${state}`);
    assert.equal(SP.coerceStatus('session', state), state, `session runState ${state}`);
  }
});

test('a background wait is its own status, never the waiting word', () => {
  // classify B: the turn is idling on a callback or a dispatched worker. Nothing
  // is asked of the user, so it must not be folded into `waiting` — that fold is
  // what made Air answer 「等待回答」 about work nobody can answer.
  assert.equal(CLASSIFY_DISPLAY.B.cardStatus, 'background');
  assert.equal(CLASSIFY_DISPLAY.B.barTint, 'background');
  assert.equal(SP.classifyStatus('B'), 'background');
  assert.notEqual(SP.classifyStatus('B'), SP.classifyStatus('W'), 'B and W must stay two statuses');
  assert.ok(serverTaskRunStates().includes('background'), 'background must be one of the run states');
  assert.equal(SP.freezeReasonStatus('awaiting_callback'), 'background');
  assert.equal(SP.freezeReasonStatus('classify_background'), 'background');
  assert.equal(SP.coerceStatus('session', 'background'), 'background');
  assert.equal(SP.coerceStatus('task', 'background'), 'background');

  // Both languages, both ends of the vocabulary: the badge word and the Air word
  // for a background wait must differ from `waiting`'s, and neither may ask the
  // user anything.
  for (const [locale, file] of [['zh', 'app/assets/i18n/zh.json'], ['en', 'app/assets/i18n/en.json']]) {
    const catalog = JSON.parse(read(file));
    const t = key => catalog[key] ?? key;
    const word = SP.airStatusLabel('background', t);
    assert.ok(word && word !== 'airStateBackground', `${locale}: background has no Air word`);
    assert.equal(word, t('airStateBackground'), `${locale}: Air word must come from the registry column`);
    assert.notEqual(word, SP.airStatusLabel('waiting', t), `${locale}: Air says the same thing for waiting and background`);
    assert.notEqual(t('statusBackground'), t('statusWaiting'), `${locale}: the two labels collide`);
    assert.ok(!/回答|answer/i.test(t('statusAriaBackground')), `${locale}: background's accessible name must not ask the user`);
    assert.ok(!/回答|answer/i.test(word), `${locale}: a background wait must not read as a question`);
  }

  // Raw values Air's `label()` actually receives: the canonical name resolves to
  // the background word, not to the waiting one — and air.js's own fallback
  // (`airStatusWordFor`) agrees with `airStatusLabels()`, which is what lets the
  // sidebar drop its hand-kept status table.
  const zh = JSON.parse(read('app/assets/i18n/zh.json'));
  const t = key => zh[key] ?? key;
  assert.equal(SP.airStatusWordFor('background', t), SP.airStatusLabel('background', t));
  assert.notEqual(SP.airStatusWordFor('background', t), SP.airStatusWordFor('waiting', t));
  // Every canonical status has its own Air word: two states sharing one word is
  // how a fold becomes invisible again.
  const words = Object.keys(SP.STATUS_PRESENTATION).map(name => SP.airStatusLabel(name, t));
  assert.equal(new Set(words).size, words.length, `Air words collide: ${words.join(' / ')}`);
  const en = JSON.parse(read('app/assets/i18n/en.json'));
  const wordsEn = Object.keys(SP.STATUS_PRESENTATION).map(name => SP.airStatusLabel(name, key => en[key] ?? key));
  assert.equal(new Set(wordsEn).size, wordsEn.length, `Air words collide in en: ${wordsEn.join(' / ')}`);
});

// ── 2. Registry invariants ──────────────────────────────────────────────────

test('only running animates, and error is a loud non-terminal fault', () => {
  const spinning = Object.entries(SP.STATUS_PRESENTATION)
    .filter(([, spec]) => spec.spinner).map(([name]) => name);
  assert.deepEqual(spinning, ['running'], 'exactly one status may animate');

  const error = SP.presentation('session', 'error');
  assert.equal(error.icon, '❌');
  assert.equal(error.tone, 'danger');
  assert.equal(error.spinner, false);
  assert.equal(error.terminal, false, 'error is retryable, never a resting end state');
  const top = Math.max(...Object.values(SP.STATUS_PRESENTATION).map(s => s.priority));
  assert.equal(error.priority, top, 'a fault must outrank every other signal');
});

test('unknown and legacy values fall back neutrally, never to success or running', () => {
  SP.resetUnknownStatusDiagnostics();
  for (const raw of ['sparkling', 'DONE_MAYBE', 'zzz', 42]) {
    const spec = SP.presentation('session', raw);
    assert.equal(spec.status, 'unknown');
    assert.equal(spec.spinner, false);
    assert.notEqual(spec.tone, 'success');
  }
  assert.ok(SP.unknownStatusDiagnostics().length >= 3, 'unknown values are recorded for diagnostics');
  SP.resetUnknownStatusDiagnostics();
  assert.equal(SP.unknownStatusDiagnostics().length, 0);
});

test('every domain status has a spec and every spec has copy keys', () => {
  for (const name of [...SP.SESSION_STATUSES, ...SP.TASK_STATUSES]) {
    const spec = SP.STATUS_PRESENTATION[name];
    assert.ok(spec, `${name} has no presentation spec`);
    assert.ok(spec.icon && spec.tone && spec.labelKey && spec.ariaKey, `${name} spec incomplete`);
  }
  // The two domains must stay separate vocabularies, not one fused enum.
  assert.ok(SP.SESSION_STATUSES.includes('offline') && !SP.TASK_STATUSES.includes('offline'));
  assert.ok(SP.TASK_STATUSES.includes('archived') && !SP.SESSION_STATUSES.includes('archived'));
});

// ── 3. Fold rules: waiting vs blocked, cancelled, idle vs offline ───────────

test('a fault on any signal wins the card', () => {
  assert.equal(SP.sessionCardStatus({ runState: 'error', workspaceStatus: 'thinking' }), 'error');
  assert.equal(SP.sessionCardStatus({ runState: 'running', monitorStatus: 'failed' }), 'error');
  assert.equal(SP.sessionCardStatus({ workspaceStatus: 'completed', monitorStatus: 'error' }), 'error');
});

test('blocked is distinguished from waiting, and neither borrows the error icon', () => {
  assert.equal(SP.sessionStatus({ runState: 'waiting', freezeReason: 'awaiting_user_input' }), 'waiting');
  assert.equal(SP.sessionStatus({ runState: 'waiting', freezeReason: 'configuration_required' }), 'blocked');
  assert.equal(SP.sessionCardStatus({ runState: 'waiting', freezeReason: 'configuration_required' }), 'blocked');
  // A stale reason cannot override a live verdict.
  assert.equal(SP.sessionStatus({ runState: 'running', freezeReason: 'configuration_required' }), 'running');
  for (const name of ['waiting', 'blocked']) {
    assert.notEqual(SP.presentation('session', name).icon, SP.presentation('session', 'error').icon);
  }
  assert.equal(SP.freezeReasonStatus('brand_new_reason'), 'waiting', 'unknown freeze reason is a pause, not a fault');
  assert.equal(SP.freezeReasonStatus('classify_error'), 'error');
});

test('interrupted work never reads as completed', () => {
  for (const raw of ['cancelled', 'canceled', 'aborted', 'interrupted']) {
    const spec = SP.presentation('session', raw);
    assert.equal(spec.status, 'cancelled');
    assert.equal(spec.spinner, false);
    assert.notEqual(spec.icon, SP.presentation('session', 'done').icon);
    assert.notEqual(spec.tone, 'success');
  }
});

test('liveness alone decides idle vs offline, never running', () => {
  assert.equal(SP.sessionCardStatus({ active: true }), 'idle', 'a live but unoccupied session is idle');
  assert.equal(SP.sessionCardStatus({ active: false }), 'offline');
  assert.equal(SP.sessionStatus({ runState: '', active: false }), 'offline');
  assert.equal(SP.sessionStatus({ runState: null }), 'unknown');
});

test('task lifecycle outranks run state, error outranks progress', () => {
  assert.equal(SP.taskStatus({ status: 'archived', runState: 'running' }), 'archived');
  assert.equal(SP.taskStatus({ status: 'done', runState: 'running' }), 'done');
  assert.equal(SP.taskStatus({ status: 'active', runState: 'error' }), 'error');
  assert.equal(SP.taskStatus({ status: 'active' }), 'idle');
  assert.equal(SP.taskStatus({}), 'unknown');
  assert.equal(SP.highestPriority('task', ['running', 'error', 'done']), 'error');
  assert.equal(SP.highestPriority('task', ['bogus']), 'unknown');
});

// ── 4. Status × surface coverage matrix ─────────────────────────────────────
//
// Two renderers cover every user-visible surface: applyStatusBadge (DOM-mutating
// callers — session list rows, fleet cards, chat bars) and statusBadgeHtml
// (innerHTML callers — task board, queue dock, dispatch records).

const MATRIX = [
  ['session', SP.SESSION_STATUSES],
  ['task', SP.TASK_STATUSES],
];

test('every status on every surface renders an icon and an accessible name', () => {
  for (const [domain, statuses] of MATRIX) {
    for (const status of statuses) {
      const spec = SP.presentation(domain, status);

      const el = makeEl();
      SP.applyStatusBadge(el, domain, status);
      const icons = el.childrenWithClass('mc-status-ico');
      assert.equal(icons.length, 1, `${domain}/${status}: exactly one icon`);
      assert.equal(icons[0].textContent, spec.icon, `${domain}/${status}: icon glyph`);
      assert.equal(icons[0].getAttribute('aria-hidden'), 'true');
      assert.equal(el.getAttribute('role'), 'img');
      assert.ok(el.getAttribute('aria-label'), `${domain}/${status}: accessible name`);
      assert.ok(el.getAttribute('title'), `${domain}/${status}: tooltip`);
      assert.equal(el.dataset.status, status);
      assert.equal(el.dataset.statusDomain, domain);
      assert.equal(el.classList.contains(`st-tone-${spec.tone}`), true);
      assert.equal(el.classList.contains('st-spin'), spec.spinner);

      const html = SP.statusBadgeHtml(domain, status);
      assert.ok(html.includes('role="img"'), `${domain}/${status}: html role`);
      assert.ok(html.includes(`data-status="${status}"`));
      assert.ok(html.includes(spec.icon), `${domain}/${status}: html icon`);
      assert.ok(/aria-label="[^"]+"/.test(html), `${domain}/${status}: html accessible name`);
      assert.equal(html.includes('st-spin'), spec.spinner);
      // Status is never carried by colour alone: the tone class always travels
      // with a glyph and a name.
      assert.ok(html.includes(`st-tone-${spec.tone}`));
    }
  }
});

test('an errored card always shows the error icon and never a spinner', () => {
  for (const [domain] of MATRIX) {
    for (const raw of ['error', 'failed', 'errored', 'fail']) {
      const el = makeEl();
      SP.applyStatusBadge(el, domain, raw);
      assert.equal(el.childrenWithClass('mc-status-ico')[0].textContent, '❌', `${domain}/${raw}`);
      assert.equal(el.classList.contains('st-spin'), false, `${domain}/${raw}: no spinner in error`);
      assert.equal(el.classList.contains('st-tone-danger'), true);
      assert.ok(el.getAttribute('aria-label'));
      const html = SP.statusBadgeHtml(domain, raw);
      assert.ok(html.includes('❌') && !html.includes('st-spin'));
    }
  }
});

test('icon-only badges keep their accessible name', () => {
  const el = makeEl();
  SP.applyStatusBadge(el, 'session', 'error', { showLabel: false });
  assert.equal(el.childrenWithClass('mc-status-label').length, 0);
  assert.ok(el.getAttribute('aria-label'), 'icon-only badge still names the state');
  const html = SP.statusBadgeHtml('task', 'error', { showLabel: false });
  assert.ok(!html.includes('mc-status-label'));
  assert.ok(/aria-label="[^"]+"/.test(html));
});

// ── 5. Transitions and WebSocket replay ─────────────────────────────────────

test('repeated snapshots are idempotent — one icon, one label', () => {
  const el = makeEl();
  for (let i = 0; i < 5; i += 1) SP.applyStatusBadge(el, 'session', 'running');
  assert.equal(el.childrenWithClass('mc-status-ico').length, 1);
  assert.equal(el.childrenWithClass('mc-status-label').length, 1);
  assert.equal(el.children.length, 2);
});

test('running → error drops the spinner immediately; error → running restores cleanly', () => {
  const el = makeEl();
  SP.applyStatusBadge(el, 'session', 'running');
  assert.equal(el.classList.contains('st-spin'), true);

  SP.applyStatusBadge(el, 'session', 'error');
  assert.equal(el.classList.contains('st-spin'), false, 'spinner stops the moment it turns red');
  assert.equal(el.childrenWithClass('mc-status-ico').length, 1, 'no double icon');
  assert.equal(el.childrenWithClass('mc-status-ico')[0].textContent, '❌');
  assert.equal(el.classList.contains('st-tone-running'), false, 'stale tone is cleared');

  SP.applyStatusBadge(el, 'session', 'running');   // user hit retry
  assert.equal(el.classList.contains('st-spin'), true);
  assert.equal(el.classList.contains('st-tone-danger'), false);
  assert.equal(el.childrenWithClass('mc-status-ico').length, 1);
  assert.equal(el.childrenWithClass('mc-status-ico')[0].textContent, '🔄');
});

test('a full replayed lifecycle leaves no stale icon or tone', () => {
  const el = makeEl();
  const replay = ['queued', 'running', 'waiting', 'blocked', 'error', 'running', 'cancelled', 'done'];
  for (const status of replay) {
    SP.applyStatusBadge(el, 'session', status);
    const spec = SP.presentation('session', status);
    assert.equal(el.childrenWithClass('mc-status-ico').length, 1, `${status}: one icon`);
    assert.equal(el.childrenWithClass('mc-status-ico')[0].textContent, spec.icon);
    const tones = SP.TONE_CLASSES.filter(t => el.classList.contains(t));
    assert.deepEqual(tones, [`st-tone-${spec.tone}`], `${status}: exactly one tone class`);
    assert.equal(el.classList.contains('st-spin'), spec.spinner);
    assert.equal(el.classList.contains('st-terminal'), spec.terminal);
  }
});

test('toggling the visible label on and off does not strand a node', () => {
  const el = makeEl();
  SP.applyStatusBadge(el, 'session', 'running');
  SP.applyStatusBadge(el, 'session', 'running', { showLabel: false });
  assert.equal(el.childrenWithClass('mc-status-label').length, 0);
  SP.applyStatusBadge(el, 'session', 'running');
  assert.equal(el.childrenWithClass('mc-status-label').length, 1);
});

// ── 6. Reason safety ────────────────────────────────────────────────────────

test('reasons reaching a tooltip carry no token, path or URL', () => {
  const dirty = 'failed at /Users/someone/secret/project/app.js with key TESTKEY_FAKE_PLACEHOLDER_DO_NOT_USE_0123 see https://internal.example.com/logs/42';
  const safe = SP.sanitizeReason(dirty);
  assert.ok(!safe.includes('/Users/someone'), 'filesystem path leaked');
  assert.ok(!safe.includes('TESTKEY_FAKE_PLACEHOLDER_DO_NOT_USE_0123'), 'token leaked');
  assert.ok(!safe.includes('https://'), 'URL leaked');
  assert.ok(safe.length <= 120);
  assert.ok(safe.includes('failed at'), 'the human-readable part survives');

  assert.equal(SP.sanitizeReason('configuration_required'), 'configuration_required',
    'known enum keys pass through for the caller to localize');
  assert.equal(SP.sanitizeReason(''), '');
  assert.equal(SP.sanitizeReason(null), '');
});

test('a sanitized reason reaches tooltip and accessible name, not raw text', () => {
  const el = makeEl();
  SP.applyStatusBadge(el, 'session', 'error', { reason: 'boom at /Users/me/x.js' });
  assert.ok(!el.getAttribute('title').includes('/Users/me'));
  assert.ok(!el.getAttribute('aria-label').includes('/Users/me'));
  assert.ok(el.getAttribute('aria-label').includes('boom at'));

  const html = SP.statusBadgeHtml('task', 'error', { reason: 'boom at /Users/me/x.js' });
  assert.ok(!html.includes('/Users/me'));
});

test('badge copy is HTML-escaped', () => {
  const html = SP.statusBadgeHtml('task', 'error', { label: '<img src=x onerror=1>' });
  assert.ok(!html.includes('<img'), 'label must not inject markup');
  assert.ok(html.includes('&lt;img'));
});

// A judgement Aux has stopped revising keeps its own status (the verdict is
// still the best description we have) but says so in words and carries a
// non-colour class, so it cannot be read as a current judgement.
test('a stale verdict is stated in words and marked, without changing the status', () => {
  const translate = key => ({ auxVerdictPaused: '判定已暂停' }[key] ?? key);
  const el = makeEl();
  const spec = SP.applyStatusBadge(el, 'session', 'waiting', {
    translate, label: '等待用户', reason: '排查电量消耗增加原因', stale: true,
  });
  assert.equal(spec.status, 'waiting', 'staleness is not a status');
  assert.equal(el.classList.contains('st-stale'), true);
  assert.ok(el.getAttribute('title').startsWith('等待用户'));
  assert.ok(el.getAttribute('title').includes('判定已暂停'));
  assert.ok(el.getAttribute('aria-label').includes('判定已暂停'));
  assert.ok(el.getAttribute('aria-label').includes('排查电量消耗增加原因'));

  const html = SP.statusBadgeHtml('task', 'waiting', { translate, stale: true, showLabel: false });
  assert.ok(html.includes('st-stale'));
  assert.ok(html.includes('判定已暂停'));

  // ...and a fresh verdict never carries the marker.
  const fresh = makeEl();
  SP.applyStatusBadge(fresh, 'session', 'waiting', { translate, label: '等待用户' });
  assert.equal(fresh.classList.contains('st-stale'), false);
  assert.ok(!fresh.getAttribute('title').includes('判定已暂停'));
});

test('every surface that renders a judgement badge loads the stale stylesheet rule', () => {
  const css = read('public/status-badge.css');
  assert.ok(/\.mc-status\.st-stale\s*\{/.test(css), 'st-stale must have a rule, not just a class');
  assert.ok(/forced-colors/.test(css.split('.mc-status.st-stale')[1] || ''),
    'forced-colours mode must keep the marker visible');
});

// ── 7. i18n completeness ────────────────────────────────────────────────────

test('every label and aria key exists in both zh and en', () => {
  const catalog = read('public/i18n-catalog.js');
  const keys = new Set();
  for (const spec of Object.values(SP.STATUS_PRESENTATION)) {
    keys.add(spec.labelKey);
    keys.add(spec.ariaKey);
    keys.add(spec.airLabelKey);
  }
  for (const key of keys) {
    const occurrences = catalog.split(`"${key}"`).length - 1;
    assert.ok(occurrences >= 2, `${key} must be defined in both zh and en (found ${occurrences})`);
  }
});

test('zh and en both define the status keys in the source catalogs', () => {
  const zh = JSON.parse(read('app/assets/i18n/zh.json'));
  const en = JSON.parse(read('app/assets/i18n/en.json'));
  for (const spec of Object.values(SP.STATUS_PRESENTATION)) {
    for (const key of [spec.labelKey, spec.ariaKey, spec.airLabelKey]) {
      assert.ok(zh[key], `zh.json missing ${key}`);
      assert.ok(en[key], `en.json missing ${key}`);
      assert.notEqual(zh[key], key, `zh.json ${key} is still the raw key`);
      assert.notEqual(en[key], key, `en.json ${key} is still the raw key`);
      // Long copy breaks cards; the visible labels stay short in both languages.
      if (key === spec.labelKey) {
        assert.ok(zh[key].length <= 8, `zh label ${key} too long for a card: ${zh[key]}`);
        assert.ok(en[key].length <= 16, `en label ${key} too long for a card: ${en[key]}`);
      }
      // The Air column prints on the same badge, so it is bounded too.
      if (key === spec.airLabelKey) {
        assert.ok(zh[key].length <= 8, `zh Air word ${key} too long for a badge: ${zh[key]}`);
        assert.ok(en[key].length <= 24, `en Air word ${key} too long for a badge: ${en[key]}`);
      }
    }
  }
});

// ── 8. Web ↔ Flutter parity ─────────────────────────────────────────────────
//
// The Dart mirror is parsed rather than imported so this stays in the node lane.
// If the two drift, one platform starts drawing a different icon for the same
// server value — exactly the class of bug this whole registry exists to kill.

function parseDart() {
  const src = read('app/lib/utils/status_presentation.dart');
  const specs = {};
  const specRe = /CanonicalStatus\.(\w+): StatusSpec\(([\s\S]*?)\n {2}\),/g;
  for (let m = specRe.exec(src); m; m = specRe.exec(src)) {
    const body = m[2];
    const field = (name) => {
      const hit = new RegExp(`${name}: ('([^']*)'|true|false|\\d+)`).exec(body);
      return hit ? (hit[2] !== undefined ? hit[2] : hit[1]) : null;
    };
    specs[m[1]] = {
      icon: field('icon'),
      tone: field('tone'),
      spinner: field('spinner') === 'true',
      terminal: field('terminal') === 'true',
      priority: Number(field('priority')),
      labelKey: field('labelKey'),
      ariaKey: field('ariaKey'),
      airLabelKey: field('airLabelKey'),
    };
  }
  const mapOf = (name) => {
    const block = new RegExp(`const Map<String, CanonicalStatus> ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(src);
    assert.ok(block, `dart map ${name} not found`);
    const out = {};
    const entryRe = /'([^']+)': CanonicalStatus\.(\w+),/g;
    for (let m = entryRe.exec(block[1]); m; m = entryRe.exec(block[1])) out[m[1]] = m[2];
    return out;
  };
  const setOf = (name) => {
    const block = new RegExp(`const Set<CanonicalStatus> ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(src);
    assert.ok(block, `dart set ${name} not found`);
    return [...block[1].matchAll(/CanonicalStatus\.(\w+),/g)].map(m => m[1]);
  };
  // 运行标记的调色板：两端同一份，顺序也要一样 —— 颜色按 id 哈希取，同一个 id 在
  // 两端必须落到同一个色。
  const ringBlock = /const List<int> ringTints = \[([\s\S]*?)\n\];/.exec(src);
  assert.ok(ringBlock, 'dart ringTints not found');
  const ringTints = [...ringBlock[1].matchAll(/0xFF([0-9A-Fa-f]{6})/g)]
    .map(m => `#${m[1].toLowerCase()}`);
  return {
    specs,
    aliases: mapOf('statusAliases'),
    freeze: mapOf('freezeReasonStatus'),
    classify: mapOf('classifyLetterStatus'),
    sessionStatuses: setOf('sessionStatuses'),
    taskStatuses: setOf('taskStatuses'),
    openRunStates: setOf('openRunStates'),
    ringTints,
  };
}

test('Flutter mirrors the web registry exactly', () => {
  const dart = parseDart();

  assert.deepEqual(dart.sessionStatuses, [...SP.SESSION_STATUSES], 'session vocabulary drifted');
  assert.deepEqual(dart.taskStatuses, [...SP.TASK_STATUSES], 'task vocabulary drifted');
  assert.deepEqual(Object.keys(dart.specs).sort(), Object.keys(SP.STATUS_PRESENTATION).sort());
  assert.deepEqual(dart.ringTints, [...SP.RING_TINTS], '运行标记的调色板两端漂移了');

  for (const [name, web] of Object.entries(SP.STATUS_PRESENTATION)) {
    assert.deepEqual(dart.specs[name], {
      icon: web.icon,
      tone: web.tone,
      spinner: web.spinner,
      terminal: web.terminal,
      priority: web.priority,
      labelKey: web.labelKey,
      ariaKey: web.ariaKey,
      airLabelKey: web.airLabelKey,
    }, `spec for ${name} differs between web and app`);
  }

  assert.deepEqual(dart.aliases, SP.STATUS_ALIASES, 'alias table differs between web and app');
  assert.deepEqual(dart.freeze, SP.FREEZE_REASON_STATUS, 'freeze table differs between web and app');
  assert.deepEqual(dart.classify, {
    D: SP.CLASSIFY_LETTER_STATUS.D, C: SP.CLASSIFY_LETTER_STATUS.C,
    W: SP.CLASSIFY_LETTER_STATUS.W, B: SP.CLASSIFY_LETTER_STATUS.B,
    E: SP.CLASSIFY_LETTER_STATUS.E, P: SP.CLASSIFY_LETTER_STATUS.P,
  }, 'classify table differs between web and app');
});

// ── 8b. 「忙」与「还开着的 run」：两端各自只有一处判定 ────────────────────────
//
// 这两个问题以前在每个消费者那里各写一遍集合：Dart 三份
// {'running','thinking','editing'}、服务端两份 ['queued','running','waiting',
// 'background']、App 的 ⏹ 又是第三份 `runState == 'running' || 'waiting'`。手抄的
// 集合就是「排队中 / 等后台任务」的任务在 App 上停不掉、而在 Web 上却能被合并的原因。

test('isBusyStatus is the registry mirror of the server workspace-busy predicate', () => {
  const { RUNNING_STATUSES, SESSION_STATUSES, isRunningStatus } = require('../src/session/state-transition.js');
  for (const status of SESSION_STATUSES) {
    assert.equal(SP.isBusyStatus(status), isRunningStatus(status),
      `the busy answer for session status ${status} differs from isRunningStatus`);
  }
  // background 是「等别人派出去的活」，两端都不是忙：本进程没有在推进这一轮。
  // 注册表给它的词也不是「执行中」。
  assert.equal(SP.isBusyStatus('background'), false);
  assert.equal(isRunningStatus('background'), false);
  assert.ok(!RUNNING_STATUSES.has('background'));
  // 别名表刻意更宽：registry 认历史词，服务端的活状态表不认，这是两件事。
  for (const alias of ['working', 'processing', 'assessing', 'busy', 'claimed']) {
    assert.equal(SP.isBusyStatus(alias), true, `${alias} is a legacy alias of running`);
    assert.ok(!SESSION_STATUSES.has(alias), `${alias} must not be a live server status`);
  }
  assert.equal(SP.isBusyStatus('waiting'), false);
  assert.equal(SP.isBusyStatus('idle'), false);
  assert.equal(SP.isBusyStatus(null), false);
  assert.equal(SP.isBusyStatus('nonsense'), false);
});

test('canStopRunState is the one open-run list, server to both UIs', () => {
  const { OPEN_RUN_STATES, isOpenRunState } = require('../src/classify/vocab.js');
  assert.deepEqual([...SP.OPEN_RUN_STATES], [...OPEN_RUN_STATES], 'the web open-run list drifted');
  const dart = parseDart();
  assert.deepEqual(dart.openRunStates, [...OPEN_RUN_STATES],
    'the Dart open-run set drifted from src/classify/vocab.js');
  for (const state of ['queued', 'running', 'waiting', 'background']) {
    assert.equal(SP.canStopRunState(state), true, `${state} is an open run`);
    assert.equal(isOpenRunState(state), true);
  }
  for (const state of ['succeeded', 'error', 'idle', 'cancelled', 'blocked', 'done', 'archived', '']) {
    assert.equal(SP.canStopRunState(state), false, `${state} is not an open run`);
  }
  // Dart 端必须是同一个集合上的判断，不是另一份手抄。
  const dartSrc = read('app/lib/utils/status_presentation.dart');
  assert.match(
    dartSrc,
    /bool canStopRunState\(Object\? raw\) =>\n\s+openRunStates\.contains\(coerceStatus\(StatusDomain\.task, raw\)\);/,
    'the Dart stop predicate must read openRunStates',
  );
  assert.match(
    dartSrc,
    /bool isBusyStatus\(Object\? raw\) =>\n\s+coerceStatus\(StatusDomain\.session, raw\) == CanonicalStatus\.running;/,
    'the Dart busy predicate must go through coerceStatus, not a hand-kept set',
  );
});

test('no surface keeps a hand copy of either set', () => {
  // App：三处手抄的 {'running','thinking','editing'} 已全部改问 registry。
  for (const file of [
    'app/lib/providers/session_manager.dart',
    'app/lib/services/dashboard_workspace_store.dart',
    'app/lib/widgets/directory_card.dart',
  ]) {
    const src = read(file);
    assert.doesNotMatch(src, /'running',\s*'thinking',\s*'editing'/,
      `${file} still lists the busy statuses by hand`);
    assert.ok(src.includes('utils/status_presentation.dart'), `${file} must import the registry`);
    assert.match(src, /isBusyStatus\(/, `${file} must ask the registry`);
  }
  // App 的 ⏹：曾经是 runState == 'running' || 'waiting'，于是 queued / background
  // 的任务显示「执行中」却停不掉。
  const board = read('app/lib/widgets/task_board_view.dart');
  assert.match(board, /final canStop = canStopRunState\(task\.runState\);/);
  assert.doesNotMatch(board, /runState == 'waiting'/);
  // Web：任务板的合并资格问 registry，不再自带那四条。
  const web = read('public/task-board-ui.js');
  assert.match(web, /statusRegistry\(\)\?\.canStopRunState\?\.\(task\.runState\) === true/);
  assert.doesNotMatch(web, /'running',\s*'queued',\s*'waiting',\s*'background'/);
  // 服务端两个守卫读 vocab 的同一个函数。
  for (const file of ['src/task-board/merge-runtime.js', 'src/task-board/lifecycle-host.js']) {
    const src = read(file);
    assert.match(src, /require\('\.\.\/classify\/vocab'\)/);
    assert.match(src, /isOpenRunState\(/, `${file} must read the shared open-run list`);
    assert.doesNotMatch(src, /'queued', 'running', 'waiting', 'background'/);
  }
});

test('the Air word column is the one source for every Air surface', () => {
  // The words Air prints for a status live in the `airLabelKey` column of the
  // specs (parity asserted above). What this test defends is that nobody keeps a
  // SECOND copy of them: four hand-kept tables (air.js stateNames, air-admin.js
  // STATUS_COPY, the app's airServiceNames and airStatusCopy) had already drifted
  // apart, which is how one Air surface ended up calling a background wait
  // 「等待回答」.
  const dartSrc = read('app/lib/utils/status_presentation.dart');
  assert.match(
    dartSrc,
    /String airStatusWord\(CanonicalStatus status\) => statusPresentation\[status\]!\.airLabel;/,
    'the Dart Air word must read the registry column',
  );

  // Web: both Air scripts build their table from the registry.
  for (const file of ['public/air.js', 'public/air-admin.js']) {
    assert.ok(read(file).includes('airStatusLabels'), `${file} must build its status words from the registry`);
  }
  // The console's old hand-kept status table read these keys; its remaining
  // airAdminStatus* uses are the liveness pill (Up/Down/Starting/Unknown), the
  // queue's idle word and the archived filter chip — other axes, not statuses.
  assert.ok(
    !/airAdminStatus(Queued|Running|Waiting|Background|Blocked|Error|Succeeded|Done|Cancelled|Offline)/.test(read('public/air-admin.js')),
    'public/air-admin.js still reads the old hand-kept status words',
  );

  // App: the two tables that used to list the canonical statuses now derive them.
  for (const file of ['app/lib/widgets/air/air_task_status.dart', 'app/lib/services/air_service.dart']) {
    const src = read(file);
    assert.ok(/airStatusWord|airStatusWords/.test(src), `${file} must derive its Air words from the registry`);
    assert.ok(
      !/'(空闲|排队中|执行中|等待回答|等待配置|执行成功|执行异常|状态未知)'/.test(src),
      `${file} still keeps a hand copy of the status words`,
    );
  }
});

// ── 9. Wiring: pages that draw badges must load the registry and its CSS ────

test('badge-rendering pages load status-presentation.js and status-badge.css', () => {
  // Air joined the list when its task band and console started drawing status
  // through the registry: it used to invent its own words per surface, which is
  // exactly the drift this test exists to stop.
  for (const page of ['public/chat.html', 'public/air.html']) {
    const html = read(page);
    assert.ok(html.includes('<script src="status-presentation.js"></script>'), `${page}: registry script`);
    assert.ok(html.includes('status-badge.css'), `${page}: tone stylesheet`);
  }
});

test('every tone token used by the registry has a stylesheet rule', () => {
  const css = read('public/status-badge.css');
  for (const spec of Object.values(SP.STATUS_PRESENTATION)) {
    assert.ok(css.includes(`.st-tone-${spec.tone}`), `status-badge.css missing .st-tone-${spec.tone}`);
  }
  // The animation is scoped to .st-spin, which only `running` ever sets.
  assert.ok(css.includes('.mc-status.st-spin .mc-status-ico'), 'spinner rule must stay scoped to .st-spin');
  assert.ok(css.includes('prefers-reduced-motion'), 'reduced-motion opt-out must survive');
});
