'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  taskShortCode,
  labelWithCode,
  CODE_LEN,
  CODE_ALPHABET,
} = require('../src/classify/task-short-code');

test('code is 4 base36 chars from the fixed alphabet', () => {
  const code = taskShortCode('tsk_2226a094149332560b9a5aa9');
  assert.equal(code.length, CODE_LEN);
  for (const ch of code) assert.ok(CODE_ALPHABET.includes(ch), `unexpected char ${ch}`);
});

test('deterministic: same taskId always yields the same code', () => {
  const a = taskShortCode('tsk_router_abc123');
  const b = taskShortCode('tsk_router_abc123');
  assert.equal(a, b);
});

test('a different taskId yields a different code (for these fixtures)', () => {
  // Not a guarantee in general (cosmetic collisions are allowed), but these
  // fixed fixtures must not collide — guards an accidental constant output.
  const codes = new Set([
    taskShortCode('tsk_aaaaaaaa'),
    taskShortCode('tsk_bbbbbbbb'),
    taskShortCode('tsk_cccccccc'),
    taskShortCode('tsk_dddddddd'),
  ]);
  assert.equal(codes.size, 4);
});

test('blank / null taskId produces no code', () => {
  assert.equal(taskShortCode(''), '');
  assert.equal(taskShortCode(null), '');
  assert.equal(taskShortCode(undefined), '');
  assert.equal(taskShortCode('   '), '');
});

test('taskId is trimmed before hashing so padding does not fork the code', () => {
  assert.equal(taskShortCode('  tsk_x  '), taskShortCode('tsk_x'));
});

test('labelWithCode renders "#CODE · text"', () => {
  const id = 'tsk_limitbar';
  const code = taskShortCode(id);
  assert.equal(labelWithCode(id, 'Limit Bar 服务端统一收口'), `#${code} · Limit Bar 服务端统一收口`);
});

test('labelWithCode returns bare text when no code resolves', () => {
  assert.equal(labelWithCode('', '只有标题'), '只有标题');
  assert.equal(labelWithCode(null, '只有标题'), '只有标题');
});

test('labelWithCode returns "#CODE" when there is a code but no text', () => {
  const id = 'tsk_only';
  assert.equal(labelWithCode(id, ''), `#${taskShortCode(id)}`);
  assert.equal(labelWithCode(id, null), `#${taskShortCode(id)}`);
});

test('code stays stable across a title change (reuse-on-same contract)', () => {
  // The runtime keeps taskId fixed while a task title evolves; the code must
  // not move with the title.
  const id = 'tsk_stable_identity';
  const first = labelWithCode(id, '规划中：修复 OpenCode 错误');
  const later = labelWithCode(id, 'Limit Bar 服务端统一收口');
  const codeOf = s => s.slice(0, s.indexOf(' '));
  assert.equal(codeOf(first), codeOf(later));
});

test('distribution: 5000 distinct taskIds spread across the code space', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) seen.add(taskShortCode(`tsk_${i}_${i * 7 + 3}`));
  // With 36^4 slots and 5000 draws the birthday-expected collisions are only a
  // handful; require the codes to be overwhelmingly distinct (no constant/bias
  // bug that would collapse the space).
  assert.ok(seen.size > 4900, `only ${seen.size} distinct codes for 5000 ids`);
});
