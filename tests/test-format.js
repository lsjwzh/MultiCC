'use strict';

// The Node half of the golden contract for public/shared/format.js.
//
// tests/fixtures/format-cases.json is hand-written and reviewed: every `expected`
// column was typed out by a human (see the note inside the file), so this test is
// not a dump of whatever the implementation happens to do — it is the contract.
// app/test/format_test.dart runs the SAME entries through app/lib/utils/format.dart,
// so a change made on one side only fails on both ends.
//
// The tables themselves (units, tiers, thresholds) are pinned against the Dart
// mirror in tests/test-format-parity.js; this file is about values.

const test = require('node:test');
const assert = require('node:assert/strict');

const FMT = require('../public/shared/format.js');
const fixture = require('./fixtures/format-cases.json');

const CALL = {
  formatBytes: (args, opts) => FMT.formatBytes(args[0], opts),
  formatRelativeTime: (args, opts) => FMT.formatRelativeTime(args[0], opts),
  formatDuration: (args) => FMT.formatDuration(args[0]),
  formatPercent: (args, opts) => FMT.formatPercent(args[0], opts),
  formatTokenCount: (args, opts) => FMT.formatTokenCount(args[0], opts),
  formatCompactTokens: (args) => FMT.formatCompactTokens(args[0]),
  usageTone: (args) => FMT.usageTone(args[0], args[1]),
};

function name(c) {
  const args = c.args.map(a => JSON.stringify(a)).join(', ');
  const opts = Object.keys(c.opts || {}).length ? ', ' + JSON.stringify(c.opts) : '';
  return `${c.fn}(${args}${opts})`;
}

test('the fixture is broad enough to be worth trusting', () => {
  assert.ok(fixture.cases.length >= 100, `expected a broad case list, got ${fixture.cases.length}`);
  for (const fn of Object.keys(CALL)) {
    assert.ok(fixture.cases.some(c => c.fn === fn), `no case exercises ${fn}`);
  }
  assert.ok(Number.isFinite(fixture.now), 'relative-time cases need a fixed clock');
  // Every entry has to be a distinct input, or a passing run proves less than it looks.
  const keys = fixture.cases.map(name);
  assert.equal(new Set(keys).size, keys.length, 'no two cases assert the same call');
  // The fixture is shared with app/test/format_test.dart, so it may only contain
  // inputs both languages can express: Dart is statically typed, so a size or a
  // count that arrives as a string (JS-only leniency, pinned below) has no place
  // here. `usageTone`'s second argument is a kind name and is meant to be a string.
  for (const c of fixture.cases) {
    const values = c.fn === 'usageTone' ? c.args.slice(0, 1) : c.args;
    for (const arg of values) {
      assert.notEqual(typeof arg, 'string', `${name(c)}: a string argument is not part of the shared contract`);
    }
  }
});

for (const c of fixture.cases) {
  test(`format case: ${name(c)}`, () => {
    const call = CALL[c.fn];
    assert.ok(call, `unknown formatter in the fixture: ${c.fn}`);
    assert.equal(call(c.args, c.opts), c.expected);
  });
}

// ── The published surface ───────────────────────────────────────────────────
// A page calls these as bare globals (the module publishes both the namespace and
// the individual functions); the terminal page loads no catalog, so every one of
// them has to work with `t` absent. That is the case here: this file is required
// from Node, where there is no window at all.
test('every formatter is published both ways and is pure', () => {
  assert.ok(Object.isFrozen(FMT), 'the namespace is frozen');
  const names = ['formatBytes', 'formatRelativeTime', 'formatDuration', 'formatPercent',
    'formatTokenCount', 'formatCompactTokens', 'usageTone', 'usageColor'];
  for (const key of names) {
    assert.equal(typeof FMT[key], 'function', `${key} is a function`);
  }
  // require()-ing it twice must be the same object (a classic script, not a factory).
  assert.equal(require('../public/shared/format.js'), FMT);
});

test('relative time without a catalog still renders the zh words', () => {
  // The terminal page and this test have no window.t; the literal fallback inside
  // the module is what keeps those surfaces from printing a bare key. The parity
  // test pins those literals against app/assets/i18n/zh.json.
  const now = fixture.now;
  assert.equal(FMT.formatRelativeTime(now - 90_000, { now }), '1 分钟前');
  assert.equal(FMT.formatRelativeTime(now - 90_000, { now, compact: true }), '1 分钟前');
  assert.equal(FMT.formatRelativeTime(now - 40_000, { now, compact: true }), '40s 前');
});

test('a catalog, when there is one, wins over the fallback', () => {
  // Same call, but with window.t present: this is what the browser does.
  const previous = global.window;
  global.window = { t: (key, params) => (key === 'minutesAgo' ? `~${params.n}m~` : '') };
  try {
    assert.equal(FMT.formatRelativeTime(90_000, { now: 180_000 }), '~1m~');
    // A key the catalog does not know falls back rather than printing the key.
    global.window = { t: () => '' };
    assert.equal(FMT.formatRelativeTime(90_000, { now: 180_000 }), '1 分钟前');
  } finally {
    if (previous === undefined) delete global.window; else global.window = previous;
  }
});

test('byte sizes never grow a decimal on the bytes row, and never shrink a unit', () => {
  assert.equal(FMT.formatBytes(1023), '1023 B');
  assert.equal(FMT.formatBytes(1024), '1.0 KB');
  // maxUnit stops promotion instead of printing 2048.0 MB for a 2GB artifact.
  assert.equal(FMT.formatBytes(2 * 1024 ** 3, { maxUnit: 'MB' }), '2048.0 MB');
  assert.equal(FMT.formatBytes(2 * 1024 ** 3), '2.0 GB');
  assert.equal(FMT.formatBytes(1), '1 B');
});

test('an unmeasurable span is empty, never a fabricated zero', () => {
  // A turn whose duration never arrived must not claim 0ms.
  assert.equal(FMT.formatDuration(null), '');
  assert.equal(FMT.formatDuration(undefined), '');
  assert.equal(FMT.formatDuration(-1), '');
  assert.equal(FMT.formatDuration(NaN), '');
  assert.equal(FMT.formatDuration(0), '0ms');
});

test('a size that arrives as a string is still a size (JS-only leniency)', () => {
  // The browser hands sizes over from JSON and DOM attributes, so the web half
  // coerces. That intake rule is deliberately OUTSIDE the shared fixture: Dart is
  // statically typed, its callers already hold a num, and a case the Dart half
  // cannot even express would make the fixture a lie. Pinned here instead.
  assert.equal(FMT.formatBytes('1536'), '1.5 KB');
  assert.equal(FMT.formatBytes(''), '');
  assert.equal(FMT.formatBytes('not a number'), '');
  assert.equal(FMT.formatRelativeTime(String(fixture.now - 90_000), { now: fixture.now }), '1 分钟前');
  assert.equal(FMT.USAGE_KINDS.length, 2);
});

test('the thresholds are one table per kind, and the tone is what colors consume', () => {
  assert.deepEqual(FMT.USAGE_KINDS, ['quota', 'context']);
  // The quota kind is a subscription window: red at 90 used, amber at 70.
  assert.equal(FMT.usageTone(90, 'quota'), 'danger');
  assert.equal(FMT.usageTone(89.99, 'quota'), 'warning');
  assert.equal(FMT.usageTone(69.99, 'quota'), 'calm');
  // The context kind warns earlier: a compaction is not a lockout.
  assert.equal(FMT.usageTone(80, 'context'), 'danger');
  assert.equal(FMT.usageTone(50, 'context'), 'warning');
  assert.equal(FMT.usageTone(49.99, 'context'), 'success');
  // An unknown kind must not throw; it is a quota by default.
  assert.equal(FMT.usageTone(95, 'nope'), 'danger');
  assert.equal(FMT.usageColor(95, 'quota'), FMT.USAGE_COLORS.danger);
});
