'use strict';

// Golden unit tests for the pure <<dispatch>> marker parser
// (src/dispatch/markers.js), extracted from server.js. These pin the marker
// grammar (fancy quotes, whitespace, greedy vs multiple), the confirm/cancel
// vocabulary, and the placeholder-target guard so a refactor cannot silently
// change which targets the dispatcher accepts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseDispatchMarker,
  parseAllDispatchMarkers,
  isDispatchPlaceholderTarget,
  DISPATCH_CONFIRM_RE,
  DISPATCH_CANCEL_RE,
} = require('../src/dispatch/markers');

test('parseDispatchMarker pulls one marker and returns cleaned text', () => {
  const r = parseDispatchMarker('before <<dispatch target="sess-1">do the thing</dispatch>> after');
  assert.deepEqual(r, { target: 'sess-1', message: 'do the thing', cleanText: 'before  after' });
});

test('parseDispatchMarker tolerates fancy quotes and no quotes on the target', () => {
  assert.equal(parseDispatchMarker('<<dispatch target=“sess-2”>m</dispatch>>').target, 'sess-2');
  assert.equal(parseDispatchMarker('<<dispatch target=sess-3>m</dispatch>>').target, 'sess-3');
  // Single closing > (not >>) is also accepted per the grammar.
  assert.equal(parseDispatchMarker('<<dispatch target="sess-4">m</dispatch>').target, 'sess-4');
});

test('parseDispatchMarker returns null when there is no marker or it is empty', () => {
  assert.equal(parseDispatchMarker(''), null);
  assert.equal(parseDispatchMarker('just some prose, no marker'), null);
  assert.equal(parseDispatchMarker(null), null);
  // Empty target or empty message => not a usable marker.
  assert.equal(parseDispatchMarker('<<dispatch target="">msg</dispatch>>'), null);
  assert.equal(parseDispatchMarker('<<dispatch target="s">   </dispatch>>'), null);
});

test('parseDispatchMarker captures multi-line messages (first marker only)', () => {
  const r = parseDispatchMarker('<<dispatch target="s">line one\nline two</dispatch>> tail');
  assert.equal(r.message, 'line one\nline two');
  assert.equal(r.cleanText, 'tail');
});

test('parseAllDispatchMarkers returns every marker in order', () => {
  const text = 'p <<dispatch target="a">m1</dispatch>> mid <<dispatch target="b">m2</dispatch>> end';
  assert.deepEqual(parseAllDispatchMarkers(text), [
    { target: 'a', message: 'm1' },
    { target: 'b', message: 'm2' },
  ]);
  assert.deepEqual(parseAllDispatchMarkers('none here'), []);
  assert.deepEqual(parseAllDispatchMarkers(''), []);
  // Incomplete markers are skipped (empty target/message).
  assert.deepEqual(parseAllDispatchMarkers('<<dispatch target="">x</dispatch>>'), []);
});

test('natural-language dispatch narration is inert without a structured marker', () => {
  assert.deepEqual(parseAllDispatchMarkers('我已经把任务派给了 xxx worker，现在等它完成。'), []);
  assert.deepEqual(parseAllDispatchMarkers('这是对 dispatch 和 worker 路由的历史复盘，不是执行指令。'), []);
});

test('chat host parses both dispatch and route markers from assistant prose', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(source, /ULTRA_DISPATCH_INTENT_RE|maybeNudgeUltracodeDispatch|lastUltraNudgeAt/);
  assert.match(source, /parseAllDispatchMarkers\(finalText\)/);
  assert.match(source, /parseAllRouteMarkers\(finalText\)/);
  assert.doesNotMatch(source, /if \(from\.type === 'commander'\) return;/,
    'Commander now runs the LLM and uses <<route>> markers like any other session');
  assert.match(source, /oneWay:\s*true/,
    'route markers use one-way dispatch with system-generated taskId');
  assert.match(source, /oneWay:\s*false/,
    'ordinary dispatch markers remain the explicit two-way path');
});

test('isDispatchPlaceholderTarget flags the ids the model must not use as targets', () => {
  for (const bad of [
    '', '   ', '...', '…', '<目标会话id>', 'SID', 'session_id', 'session id',
    'target', 'target_id', 'worker session id', '真实 session id', '目标会话id',
    '<真实id', '<真实id>', '<x', 'abc>', '<<route', 'id>',
  ]) {
    assert.equal(isDispatchPlaceholderTarget(bad), true, `${JSON.stringify(bad)} is a placeholder`);
  }
});

test('isDispatchPlaceholderTarget accepts real session ids', () => {
  for (const good of [
    'multicc-claude-chat-05', 'shop-codex-chat-01', 'mafit-claude-chat-21', 'a1b2c3',
  ]) {
    assert.equal(isDispatchPlaceholderTarget(good), false, `${good} is a real id`);
  }
});

test('confirm/cancel vocabularies match the expected replies (and nothing else)', () => {
  for (const yes of ['确认', '确定', 'yes', 'y', 'OK', 'ok']) assert.ok(DISPATCH_CONFIRM_RE.test(yes), yes);
  for (const no of ['取消', '算了', 'no', 'n', 'N']) assert.ok(DISPATCH_CANCEL_RE.test(no), no);
  // Must be a whole-string match, not a substring, so ordinary replies don't trip it.
  assert.equal(DISPATCH_CONFIRM_RE.test('yes please do it'), false);
  assert.equal(DISPATCH_CANCEL_RE.test('no thanks, later'), false);
});
