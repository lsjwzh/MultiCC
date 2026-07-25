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
const { CLASSIFY_DISPLAY } = require('../src/classify/vocab.js');
const { FREEZE_REASON_RUN_STATE } = require('../src/session-work-scheduler.js');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/** TASK_RUN_STATES is module-private in src/task-board.js; read the literal. */
function serverTaskRunStates() {
  const src = read('src/task-board.js');
  const m = /const TASK_RUN_STATES = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, 'TASK_RUN_STATES literal not found in src/task-board.js');
  return m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
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

test('classify letters mirror src/classify/vocab.js, with E as the only divergence', () => {
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
  // Documented, deliberate: the server's cardStatus for E is `waiting` while its
  // barTint is `error`. A fault has to read as a fault on the card too.
  assert.deepEqual(divergent, ['E']);
  assert.equal(SP.classifyStatus('E'), 'error');
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

// ── 7. i18n completeness ────────────────────────────────────────────────────

test('every label and aria key exists in both zh and en', () => {
  const catalog = read('public/i18n-catalog.js');
  const keys = new Set();
  for (const spec of Object.values(SP.STATUS_PRESENTATION)) {
    keys.add(spec.labelKey);
    keys.add(spec.ariaKey);
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
    for (const key of [spec.labelKey, spec.ariaKey]) {
      assert.ok(zh[key], `zh.json missing ${key}`);
      assert.ok(en[key], `en.json missing ${key}`);
      // Long copy breaks cards; the visible labels stay short in both languages.
      if (key === spec.labelKey) {
        assert.ok(zh[key].length <= 8, `zh label ${key} too long for a card: ${zh[key]}`);
        assert.ok(en[key].length <= 16, `en label ${key} too long for a card: ${en[key]}`);
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
  return {
    specs,
    aliases: mapOf('statusAliases'),
    freeze: mapOf('freezeReasonStatus'),
    classify: mapOf('classifyLetterStatus'),
    sessionStatuses: setOf('sessionStatuses'),
    taskStatuses: setOf('taskStatuses'),
  };
}

test('Flutter mirrors the web registry exactly', () => {
  const dart = parseDart();

  assert.deepEqual(dart.sessionStatuses, [...SP.SESSION_STATUSES], 'session vocabulary drifted');
  assert.deepEqual(dart.taskStatuses, [...SP.TASK_STATUSES], 'task vocabulary drifted');
  assert.deepEqual(Object.keys(dart.specs).sort(), Object.keys(SP.STATUS_PRESENTATION).sort());

  for (const [name, web] of Object.entries(SP.STATUS_PRESENTATION)) {
    assert.deepEqual(dart.specs[name], {
      icon: web.icon,
      tone: web.tone,
      spinner: web.spinner,
      terminal: web.terminal,
      priority: web.priority,
      labelKey: web.labelKey,
      ariaKey: web.ariaKey,
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

// ── 9. Wiring: pages that draw badges must load the registry and its CSS ────

test('badge-rendering pages load status-presentation.js and status-badge.css', () => {
  for (const page of ['public/manage.html', 'public/chat.html']) {
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
