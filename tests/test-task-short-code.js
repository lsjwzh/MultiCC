'use strict';

// Unit tests for the outward task short-code registry
// (src/classify/task-short-code.js). The registry persists taskId→code so the
// 4-char display handle is unique fleet-wide; mint candidates are sha256-based
// with salt-0 reproducing the pre-registry deterministic code.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  taskShortCode,
  taskIdForShortCode,
  labelWithCode,
  createTaskShortCodeRegistry,
  initTaskShortCodeRegistry,
  CODE_LEN,
} = require('../src/classify/task-short-code');

// The pre-registry deterministic derivation, reproduced here so the upgrade
// continuity test pins salt-0 to the exact codes users already saw.
function legacyDeterministicCode(taskId) {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digest = crypto.createHash('sha256').update(taskId).digest();
  let n = digest.readUInt32BE(0);
  let code = '';
  for (let i = 0; i < CODE_LEN; i += 1) {
    code = alphabet[n % 36] + code;
    n = Math.floor(n / 36);
  }
  return code;
}

function tmpRegistryFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-short-code-'));
  return path.join(dir, 'task-short-codes.json');
}

beforeEach(() => {
  // Every test starts from a fresh in-memory singleton registry.
  initTaskShortCodeRegistry();
});

test('code is exactly 4 base36 chars', () => {
  const code = taskShortCode('tsk_abc123');
  assert.equal(code.length, 4);
  assert.match(code, /^[0-9A-Z]{4}$/);
});

test('same taskId resolves the same code across calls', () => {
  assert.equal(taskShortCode('tsk_stable'), taskShortCode('tsk_stable'));
});

test('only an already-minted code resolves back to its canonical taskId', () => {
  const taskId = 'tsk_explicit_reference';
  const code = taskShortCode(taskId);
  assert.equal(taskIdForShortCode(code.toLowerCase()), taskId);
  assert.equal(taskIdForShortCode('NOPE'), null);
  assert.equal(taskIdForShortCode('TOO-LONG'), null);
});

test('registry guarantees distinct codes for distinct taskIds', () => {
  const a = taskShortCode('tsk_alpha');
  const b = taskShortCode('tsk_beta');
  assert.notEqual(a, b);
});

test('blank or missing taskId yields empty code', () => {
  assert.equal(taskShortCode(''), '');
  assert.equal(taskShortCode(null), '');
  assert.equal(taskShortCode(undefined), '');
  assert.equal(taskShortCode('   '), '');
});

test('taskId is trimmed before resolving', () => {
  assert.equal(taskShortCode('  tsk_trim  '), taskShortCode('tsk_trim'));
});

test('labelWithCode renders #CODE · text', () => {
  const code = taskShortCode('tsk_label');
  assert.equal(labelWithCode('tsk_label', '修复配额显示'), `#${code} · 修复配额显示`);
});

test('labelWithCode degrades gracefully at the edges', () => {
  assert.equal(labelWithCode('', '裸文本'), '裸文本');
  const code = taskShortCode('tsk_only');
  assert.equal(labelWithCode('tsk_only', ''), `#${code}`);
});

test('code is stable when the task title evolves (relation:same keeps taskId)', () => {
  const before = taskShortCode('tsk_evolve');
  const early = labelWithCode('tsk_evolve', 'OpenCode 错误与 Ark 配额修复');
  const later = labelWithCode('tsk_evolve', 'Limit Bar 服务端统一收口');
  const after = taskShortCode('tsk_evolve');
  assert.equal(before, after);
  assert.ok(early.startsWith(`#${before} · `));
  assert.ok(later.startsWith(`#${before} · `));
});

test('mint regenerates on collision until the code is free', () => {
  // Injected candidate: every taskId first asks for TAKN, then falls back to
  // its salt-1 code. The second task must not steal the first task's code.
  const candidate = (taskId, salt) => (salt === 0 ? 'TAKN' : `B${salt}CD`);
  const reg = createTaskShortCodeRegistry({ candidate });
  assert.equal(reg.codeFor('tsk_first'), 'TAKN');
  assert.equal(reg.codeFor('tsk_second'), 'B1CD');
  assert.equal(reg.codeFor('tsk_third'), 'B2CD');
  assert.equal(reg.ownerOf('TAKN'), 'tsk_first');
  // Re-reads never remint.
  assert.equal(reg.codeFor('tsk_first'), 'TAKN');
  assert.equal(reg.codeFor('tsk_second'), 'B1CD');
});

test('mint fails loudly when the candidate space is exhausted', () => {
  const reg = createTaskShortCodeRegistry({ candidate: () => 'FULL' });
  assert.equal(reg.codeFor('tsk_one'), 'FULL');
  assert.throws(() => reg.codeFor('tsk_two'), /exhausted 4096 mint attempts/);
});

test('mint rejects an invalid candidate code', () => {
  const reg = createTaskShortCodeRegistry({ candidate: () => 'nope' });
  assert.throws(() => reg.codeFor('tsk_x'), /invalid code/);
});

test('salt-0 continuity: fresh registry keeps pre-upgrade deterministic codes', () => {
  const reg = createTaskShortCodeRegistry();
  for (const id of ['tsk_router_2226a094149332560b9a5aa9', 'tsk_abc', 'tsk_999']) {
    assert.equal(reg.codeFor(id), legacyDeterministicCode(id));
  }
});

test('5000 taskIds all receive distinct codes', () => {
  const reg = createTaskShortCodeRegistry();
  const codes = new Set();
  for (let i = 0; i < 5000; i += 1) codes.add(reg.codeFor(`task-id-${i}`));
  assert.equal(codes.size, 5000);
});

test('minted codes persist to the file immediately', () => {
  const file = tmpRegistryFile();
  const reg = createTaskShortCodeRegistry({ file });
  const code = reg.codeFor('tsk_persist');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.data.byTaskId.tsk_persist, code);
});

test('registry state survives a restart (reload from same file)', () => {
  const file = tmpRegistryFile();
  const first = createTaskShortCodeRegistry({ file });
  const a = first.codeFor('tsk_restart_a');
  const b = first.codeFor('tsk_restart_b');

  const second = createTaskShortCodeRegistry({ file });
  assert.equal(second.codeFor('tsk_restart_a'), a);
  assert.equal(second.codeFor('tsk_restart_b'), b);
  // Reloaded registry still enforces uniqueness for new taskIds, including
  // against codes minted before the restart.
  assert.equal(second.ownerOf(a), 'tsk_restart_a');
  // A candidate fn that first asks for an already-owned code (even one minted
  // before the restart) must be turned away and land on its salted fallback.
  const colliding = createTaskShortCodeRegistry({ file, candidate: (id, salt) => (salt === 0 ? a : `F${salt}EE`) });
  assert.equal(colliding.codeFor('tsk_restart_c'), 'F1EE');
});

test('corrupt registry file fails closed (never silently drops state)', () => {
  const file = tmpRegistryFile();
  fs.writeFileSync(file, '{ not json', { mode: 0o600 });
  assert.throws(() => createTaskShortCodeRegistry({ file }), /registry state unusable/);
});

test('corrupt main file recovers from the .bak rotation chain', () => {
  const file = tmpRegistryFile();
  const first = createTaskShortCodeRegistry({ file });
  const codeA = first.codeFor('tsk_bak_a');
  first.codeFor('tsk_bak_b'); // second save rotates the first into .bak1
  fs.writeFileSync(file, 'garbage{{{', 'utf8');

  const recovered = createTaskShortCodeRegistry({ file });
  // .bak1 holds the state after the first mint: tsk_bak_a keeps its code.
  assert.equal(recovered.codeFor('tsk_bak_a'), codeA);
  // tsk_bak_b was only in the corrupted main file: it remints, and the remint
  // rewrites a clean main file.
  const reminted = recovered.codeFor('tsk_bak_b');
  assert.match(reminted, /^[0-9A-Z]{4}$/);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.data.byTaskId.tsk_bak_a, codeA);
  assert.equal(raw.data.byTaskId.tsk_bak_b, reminted);
});

test('malformed registry rows are skipped on load', () => {
  const file = tmpRegistryFile();
  fs.writeFileSync(file, JSON.stringify({
    __multiccSchema: { kind: 'task-short-codes', version: 1 },
    data: { byTaskId: { tsk_ok: 'GOOD', tsk_bad: 'xx', tsk_dup: 'GOOD', '': 'VOID' } },
  }), { mode: 0o600 });
  const reg = createTaskShortCodeRegistry({ file });
  assert.equal(reg.codeFor('tsk_ok'), 'GOOD');
  assert.equal(reg.has('tsk_bad'), false);
  assert.equal(reg.has('tsk_dup'), false); // lost the dup race → remints fresh
  assert.notEqual(reg.codeFor('tsk_dup'), 'GOOD');
});
