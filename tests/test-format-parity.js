'use strict';

// Pins public/shared/format.js to app/lib/utils/format.dart.
//
// The two ends are separate implementations in separate languages, and the whole
// point of the exercise is that they cannot drift: a threshold moved on one side
// and not the other is a promise the product breaks ("this bar turns red at 90%"
// has to be true of the browser and the app). So this test reads the tables out of
// the Dart source and compares them to the live JS exports. It is deliberately a
// text parse rather than a codegen step: the Dart file stays the readable thing a
// reader edits, and the literals it must keep flat are marked as such.
//
// Precedents: tests/test-status-presentation.js and tests/test-cli-display-parity.js
// do the same for status words and CLI names.
//
// Values are NOT compared here — tests/fixtures/format-cases.json is run through
// both implementations (tests/test-format.js, app/test/format_test.dart).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FMT = require('../public/shared/format.js');
const DART = fs.readFileSync(path.join(ROOT, 'app/lib/utils/format.dart'), 'utf8');
const JAIL = fs.readFileSync(path.join(ROOT, 'src/quota/quota-bar-view.js'), 'utf8');
const ZHS = require('../app/assets/i18n/zh.json');
const ENS = require('../app/assets/i18n/en.json');

// ── a very small Dart collection-literal reader ─────────────────────────────
// Enough for the tables in format.dart: lists, maps, quoted strings, numbers and
// `double.infinity`. Written by hand rather than with a regex per table so a
// nested table (`kUsageThresholds`) needs no special case.

function parseLiteral(text, start) {
  let i = start;
  const skip = () => { while (i < text.length && /\s/.test(text[i])) i += 1; };
  skip();
  const ch = text[i];
  if (ch === '[' || ch === '{') {
    const closing = ch === '[' ? ']' : '}';
    i += 1;
    const items = [];
    const map = ch === '{';
    for (;;) {
      skip();
      if (text[i] === closing) { i += 1; break; }
      if (text[i] === ',') { i += 1; continue; }
      const key = parseLiteral(text, i);
      i = key.end;
      skip();
      if (map) {
        if (text[i] !== ':') throw new Error(`expected ':' at ${i} in ${text.slice(i, i + 20)}`);
        const value = parseLiteral(text, i + 1);
        i = value.end;
        items.push([key.value, value.value]);
      } else {
        items.push(key.value);
      }
    }
    const value = map ? Object.fromEntries(items) : items;
    return { value, end: i };
  }
  if (ch === "'" || ch === '"') {
    let out = '';
    i += 1;
    while (text[i] !== ch) {
      if (text[i] === '\\') { out += text[i + 1]; i += 2; continue; }
      out += text[i];
      i += 1;
    }
    return { value: out, end: i + 1 };
  }
  const rest = text.slice(i);
  const infinite = /^(double\.infinity|-?double\.infinity)/.exec(rest);
  if (infinite) {
    const negative = infinite[1].startsWith('-');
    return { value: negative ? -Infinity : Infinity, end: i + infinite[1].length };
  }
  const number = /^-?\d+(\.\d+)?/.exec(rest);
  if (number) {
    return { value: Number(number[0]), end: i + number[0].length };
  }
  if (rest.startsWith('true')) return { value: true, end: i + 4 };
  if (rest.startsWith('false')) return { value: false, end: i + 5 };
  throw new Error(`cannot parse Dart literal at offset ${i}: ${rest.slice(0, 30)}`);
}

/** The literal a top-level `const ... <name> = ...;` in format.dart is bound to. */
function dartConst(name) {
  const marker = new RegExp(`(?:^|\\n)const\\s+[^=\\n]*\\b${name}\\s*=`);
  const found = marker.exec(DART);
  assert.ok(found, `${name} is declared as a flat const in format.dart`);
  const value = parseLiteral(DART, found.index + found[0].length);
  // A flat top-level const ends at a `;` — anything else means a nested structure
  // swallowed the rest of the file, which is a parse bug worth failing loudly on.
  const trailing = DART.slice(value.end, value.end + 40);
  assert.match(trailing, /^\s*;/, `${name} must be a single flat literal (found ${JSON.stringify(trailing.slice(0, 20))})`);
  return value.value;
}

// ── byte sizes ──────────────────────────────────────────────────────────────
test('byte unit tables match', () => {
  assert.equal(dartConst('kByteBase'), FMT.BYTE_BASE);
  assert.deepEqual(dartConst('kByteUnits'), [...FMT.BYTE_UNITS]);
  assert.equal(dartConst('kByteDefaultDecimals'), FMT.BYTE_DEFAULT_DECIMALS);
  assert.equal(dartConst('kByteDefaultMaxUnit'), FMT.BYTE_DEFAULT_MAX_UNIT);
  // The default must be reachable, or formatBytes would stop promoting early.
  assert.ok(FMT.BYTE_UNITS.includes(FMT.BYTE_DEFAULT_MAX_UNIT));
});

// ── relative time ───────────────────────────────────────────────────────────
test('relative time tiers match, boundary for boundary', () => {
  const dart = dartConst('kRelativeTiers').map(([maxSeconds, divisor, tier]) => ({ maxSeconds, divisor, tier }));
  const js = FMT.RELATIVE_TIERS.map(({ maxSeconds, divisor, tier }) => ({ maxSeconds, divisor, tier }));
  assert.deepEqual(dart, js);
  // Ascending, so "walk top to bottom and take the first" is well defined, and the
  // last tier is the unbounded one.
  for (let i = 1; i < js.length; i += 1) assert.ok(js[i].maxSeconds > js[i - 1].maxSeconds);
  assert.equal(js[js.length - 1].maxSeconds, Infinity);
});

test('relative time i18n keys match, and the compact set differs only where it should', () => {
  assert.deepEqual(dartConst('kRelativeTierKeys'), { ...FMT.RELATIVE_KEYS });
  assert.deepEqual(dartConst('kRelativeTierKeysCompact'), { ...FMT.RELATIVE_KEYS_COMPACT });
  const different = Object.keys(FMT.RELATIVE_KEYS)
    .filter(k => FMT.RELATIVE_KEYS[k] !== FMT.RELATIVE_KEYS_COMPACT[k]);
  assert.deepEqual(different, ['seconds'], 'compact changes the seconds tier and nothing else');
  // Every tier has a key, and every key exists in both catalogs — a tier wired to
  // a missing key would render a bare identifier on one locale.
  for (const tier of FMT.RELATIVE_TIERS) {
    assert.ok(FMT.RELATIVE_KEYS[tier.tier], `tier ${tier.tier} has a key`);
    assert.ok(FMT.RELATIVE_KEYS_COMPACT[tier.tier], `tier ${tier.tier} has a compact key`);
  }
  for (const key of new Set([...Object.values(FMT.RELATIVE_KEYS), ...Object.values(FMT.RELATIVE_KEYS_COMPACT)])) {
    assert.ok(ZHS[key], `zh catalog has ${key}`);
    assert.ok(ENS[key], `en catalog has ${key}`);
  }
});

test('the literal zh fallback inside format.js is the zh catalog', () => {
  // This is what makes the Node-generated quota-bar fixture and the browser agree,
  // and what keeps the terminal page (no catalog) from printing a raw key.
  const published = new Set([
    ...Object.values(FMT.RELATIVE_KEYS),
    ...Object.values(FMT.RELATIVE_KEYS_COMPACT),
  ]);
  assert.deepEqual(Object.keys(FMT.RELATIVE_FALLBACK).sort(), [...published].sort());
  for (const [key, text] of Object.entries(FMT.RELATIVE_FALLBACK)) {
    assert.equal(text, ZHS[key], `fallback for ${key} is the zh catalog string`);
  }
});

// ── elapsed spans ───────────────────────────────────────────────────────────
test('span limits match', () => {
  assert.equal(dartConst('kSpanMsLimit'), FMT.SPAN_MS_LIMIT);
  assert.equal(dartConst('kSpanSecondsLimit'), FMT.SPAN_SECONDS_LIMIT);
  assert.equal(dartConst('kSpanDecimalLimit'), FMT.SPAN_DECIMAL_LIMIT);
  // The one decimal only ever applies under the decimal limit, and that limit is
  // inside the seconds branch, or the branch would be unreachable.
  assert.ok(FMT.SPAN_DECIMAL_LIMIT > 0 && FMT.SPAN_DECIMAL_LIMIT <= FMT.SPAN_SECONDS_LIMIT);
  assert.ok(FMT.SPAN_MS_LIMIT < FMT.SPAN_SECONDS_LIMIT * 1000);
});

// ── token counts ────────────────────────────────────────────────────────────
test('token unit tables match', () => {
  const dart = dartConst('kTokenUnits').map(([min, divisor, suffix, decimals]) => ({ min, divisor, suffix, decimals }));
  const js = FMT.TOKEN_UNITS.map(({ min, divisor, suffix, decimals }) => ({ min, divisor, suffix, decimals }));
  assert.deepEqual(dart, js);
  for (let i = 1; i < js.length; i += 1) assert.ok(js[i].min < js[i - 1].min, 'largest unit first');
});

// ── usage thresholds ────────────────────────────────────────────────────────
test('usage threshold tables match — this is the one table both ends colour with', () => {
  const dart = dartConst('kUsageThresholds');
  const js = Object.fromEntries(Object.entries(FMT.USAGE_THRESHOLDS)
    .map(([kind, rows]) => [kind, rows.map(({ min, tone }) => [min, tone])]));
  assert.deepEqual(dart, js);
  assert.deepEqual(dartConst('kUsageKinds'), [...FMT.USAGE_KINDS]);
  assert.deepEqual([...FMT.USAGE_KINDS].sort(), Object.keys(js).sort());
  assert.deepEqual(dartConst('kUsageColors'), { ...FMT.USAGE_COLORS });
  for (const rows of Object.values(js)) {
    for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i][0] < rows[i - 1][0], 'harshest first');
    assert.equal(rows[rows.length - 1][0], 0, 'the last entry catches everything');
    for (const [, tone] of rows) assert.ok(FMT.USAGE_COLORS[tone], `${tone} has a colour`);
  }
});

test('the server quota renderer is the same cut, stated from the other end', () => {
  // src/quota/quota-bar-view.js renders the bar in the browser payload; the web
  // and app readouts colour the same window. It predates this module and states
  // the rule in terms of REMAINING percent, so its cut must be the complement of
  // the canonical USED cut — 100 - 90 = 10, 100 - 70 = 30 — with the same hexes.
  const used = FMT.USAGE_THRESHOLDS.quota.map(entry => entry.min);
  const redHex = FMT.USAGE_COLORS.danger;
  const amberHex = FMT.USAGE_COLORS.warning;

  const hex = Object.fromEntries([...JAIL.matchAll(/^\s*(\w+):\s*'(#[0-9a-f]{6})'/gm)].map(m => [m[1], m[2]]));
  assert.equal(hex.red, redHex, 'the server red is the canonical danger hex');
  assert.equal(hex.yellow, amberHex, 'the server amber is the canonical warning hex');
  assert.equal(hex.blue, FMT.USAGE_COLORS.calm, 'and the calm hex matches too');

  const remaining = /function unifiedColorFromRemaining\(rem\)\s*\{([\s\S]*?)\n\}/.exec(JAIL);
  assert.ok(remaining, 'unifiedColorFromRemaining is still where the remaining cut lives');
  const cuts = [...remaining[1].matchAll(/rem\s*<=\s*(\d+)/g)].map(m => Number(m[1]));
  assert.equal(cuts.length, 2, 'a red band and an amber band');
  assert.deepEqual(cuts, [100 - used[0], 100 - used[1]],
    `remaining cut ${cuts} must be the complement of used cut ${used}`);

  // And the same rule states USED percent directly for the max-percentage path.
  const usedCuts = [...JAIL.matchAll(/maxPct\s*>=\s*(\d+)/g)].map(m => Number(m[1]));
  assert.deepEqual(usedCuts, [used[0], used[1]], 'the used-percent path agrees with the shared table');
});

test('the files this test pins are the ones the product loads', () => {
  // A cheap sanity clause: the Dart file parsed above is the one the app imports,
  // and the JS module is the one a page <script> tag points at.
  const dartUsers = fs.readFileSync(path.join(ROOT, 'app/lib/models/quota_bar_view.dart'), 'utf8');
  assert.match(dartUsers, /utils\/format\.dart/, 'the app reaches the canonical module');
  assert.match(DART, /const int kByteBase = 1024;/);
  const pages = fs.readdirSync(path.join(ROOT, 'public'))
    .filter(f => f.endsWith('.html'))
    .map(f => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'));
  const tag = /<script[^>]+src=["'][^"']*shared\/format\.js/;
  assert.ok(pages.some(p => tag.test(p)), 'at least one page loads shared/format.js');
  assert.ok(fs.existsSync(path.join(ROOT, 'tests/fixtures/format-cases.json')));
});
