'use strict';

// Golden unit tests for the pure classify vocabulary/parser module
// (src/classify/vocab.js), extracted from server.js. These pin the exact
// parsing, phase normalization, garbage filtering, display map, and system
// prompt behaviour so a future refactor cannot silently drift the classifier's
// D/C/W/B/E/P semantics.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseClassifyResult,
  buildClassifySystemPrompt,
  classifyDisplay,
  phaseLabel,
  applyUserInputEvidence,
  CLASSIFY_DISPLAY,
  PHASE_LABELS,
} = require('../src/classify/vocab');

test('state letter maps to the correct runtime state, background, and error flags', () => {
  const cases = [
    ['P', { state: 'running', background: false, error: false }],
    // C is RETIRED — it now collapses to plain waiting (W), never 'continue'.
    ['C', { state: 'waiting', background: false, error: false }],
    ['W', { state: 'waiting', background: false, error: false }],
    ['B', { state: 'waiting', background: true, error: false }],
    ['E', { state: 'waiting', background: false, error: true }],
    ['D', { state: 'completed', background: false, error: false }],
  ];
  for (const [letter, expect] of cases) {
    const r = parseClassifyResult(`修复登录样式\n实现中\n${letter}`);
    assert.equal(r.state, expect.state, letter);
    assert.equal(r.background, expect.background, `${letter} background`);
    assert.equal(r.error, expect.error, `${letter} error`);
  }
});

test('unknown/unparseable state defaults to waiting, NEVER completed', () => {
  assert.equal(parseClassifyResult('目标\n实现中\nZ').state, 'waiting');
  assert.equal(parseClassifyResult('').state, 'waiting');
  assert.equal(parseClassifyResult('garbage only').state, 'waiting');
  // A single blank/space state line must not fall through to completed.
  assert.equal(parseClassifyResult('目标\n实现中\n ').state, 'waiting');
});

test('unresolved request_user_input evidence authoritatively yields plain waiting', () => {
  const classified = parseClassifyResult('部署修复\n已完成\nD');
  const resolved = applyUserInputEvidence(classified, {
    requestId: 'usrq-1',
    question: '是否立即发布？',
    resolved: false,
  });
  assert.equal(resolved.state, 'waiting');
  assert.equal(resolved.background, false);
  assert.equal(resolved.error, false);
  assert.equal(resolved.evidence, 'request_user_input');
  assert.equal(applyUserInputEvidence(classified, null), classified);
  assert.equal(applyUserInputEvidence(classified, { resolved: true }), classified);
});

test('goal is extracted, label-stripped, and capped at 60 chars', () => {
  assert.equal(parseClassifyResult('目标：给卡片加 git 状态行\n实现中\nC').goal, '给卡片加 git 状态行');
  assert.equal(parseClassifyResult('goal: Fix login page styling\n实现中\nC').goal, 'Fix login page styling');
  const long = 'x'.repeat(80);
  assert.equal(parseClassifyResult(`${long}\n实现中\nC`).goal.length, 60);
});

test('phase normalizes Chinese and English to the canonical English key', () => {
  assert.equal(parseClassifyResult('目标\n实现中\nC').phase, 'implementing');
  assert.equal(parseClassifyResult('目标\n规划中\nC').phase, 'planning');
  assert.equal(parseClassifyResult('目标\nverifying\nC').phase, 'verifying');
  // Quirk pinned intentionally: an UPPERCASE English phase misses the exact-key
  // and Chinese-value lookups and lands on the case-insensitive fallback, which
  // returns the LABEL ('验证中'), not the key. Preserved verbatim from server.js.
  assert.equal(parseClassifyResult('目标\nVERIFYING\nC').phase, '验证中');
  assert.equal(parseClassifyResult('目标\n收尾中\nC').phase, 'wrapping');
  assert.equal(parseClassifyResult('目标\nnonsense-phase\nC').phase, null);
});

test('garbage goals (errors, status codes, template phrases) are dropped to empty', () => {
  assert.equal(parseClassifyResult('API Error: insufficient balance\n实现中\nW').goal, '');
  assert.equal(parseClassifyResult('status 500\n实现中\nW').goal, '');
  assert.equal(parseClassifyResult('第1行 当前任务目标\n实现中\nW').goal, '');
  assert.equal(parseClassifyResult('任务状态分析\n实现中\nW').goal, '');
  // A legitimate short goal survives.
  assert.equal(parseClassifyResult('改配色\n实现中\nC').goal, '改配色');
});

test('DeepSeek thinking guards: unicode marker strips preceding text, think-tags are removed', () => {
  // The <｜end▁of▁thinking｜> marker slices off everything up to and including it,
  // so the real goal that follows becomes line 1.
  const r2 = parseClassifyResult('junk reasoning<｜end▁of▁thinking｜>清理缓存\n实现中\nC');
  assert.equal(r2.goal, '清理缓存');
  assert.equal(r2.state, 'waiting'); // C retired → collapses to W
  // <think></think> tags themselves are stripped (their content is NOT removed —
  // the classifier relies on the unicode marker above for that), so empty tags
  // just leave the goal line intact.
  const r = parseClassifyResult('<think></think>真目标\n实现中\nD');
  assert.equal(r.goal, '真目标');
  assert.equal(r.state, 'completed');
});

test('buildClassifySystemPrompt embeds the prior goal and the full state vocabulary', () => {
  const p = buildClassifySystemPrompt('给目录卡片加 git 状态行');
  assert.match(p, /给目录卡片加 git 状态行/);
  // Live state letters must be documented in the prompt. C is RETIRED (collapses
  // to W) and B was retired earlier, so neither is offered to the model anymore.
  for (const kw of ['D = ', 'W = ', 'E = ', 'P = ']) assert.ok(p.includes(kw), kw);
  assert.ok(!p.includes('C = '), 'retired C must not be offered to the classifier');
  // E-detection keywords the classifier relies on.
  for (const kw of ['API Error', '503', 'Connection closed', 'Overloaded']) assert.ok(p.includes(kw), kw);
  // Empty prior goal renders the placeholder, not "undefined".
  const p0 = buildClassifySystemPrompt('');
  assert.match(p0, /无/);
  assert.doesNotMatch(p0, /undefined/);
});

test('CLASSIFY_DISPLAY is complete and self-consistent for every state', () => {
  for (const letter of ['D', 'C', 'W', 'B', 'E', 'P']) {
    const d = CLASSIFY_DISPLAY[letter];
    assert.ok(d, `${letter} present`);
    assert.equal(typeof d.label, 'string');
    assert.ok('pushType' in d && 'cardStatus' in d && 'barTint' in d, `${letter} fields`);
  }
  // Terminal/attention states carry a card status matching their intent.
  assert.equal(CLASSIFY_DISPLAY.D.cardStatus, 'completed');
  assert.equal(CLASSIFY_DISPLAY.W.cardStatus, 'waiting');
  assert.equal(CLASSIFY_DISPLAY.E.barTint, 'error');
});

test('classifyDisplay falls back to the wait state for unknown letters', () => {
  assert.equal(classifyDisplay('D'), CLASSIFY_DISPLAY.D);
  assert.equal(classifyDisplay('???'), CLASSIFY_DISPLAY.W);
  assert.equal(classifyDisplay(undefined), CLASSIFY_DISPLAY.W);
});

test('phaseLabel maps known phases to Chinese and unknown to empty string', () => {
  assert.equal(phaseLabel('planning'), PHASE_LABELS.planning);
  assert.equal(phaseLabel('implementing'), '实现中');
  assert.equal(phaseLabel('nope'), '');
  assert.equal(phaseLabel(undefined), '');
});

test('classify C is retired: no dispatch branch persists it, it falls through to W', () => {
  const root = path.join(__dirname, '..');
  const files = [path.join(root, 'server.js')];
  for (const entry of fs.readdirSync(path.join(root, 'src', 'classify'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.join(root, 'src', 'classify', entry.name));
  }
  // The old `if (state === 'continue')` branch that persisted classifyState 'C'
  // and parked the CLI idle must be gone entirely — from server.js AND from any
  // extracted classify module it may migrate into.
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(source.indexOf("if (state === 'continue')"), -1,
      `dead continue branch must be removed (${file})`);
    assert.equal(source.indexOf("classifyState: 'C'"), -1,
      `must never persist classifyState C (${file})`);
  }
  // parseClassifyResult is the single retirement point: C → plain waiting.
  assert.equal(parseClassifyResult('目标\n实现中\nC').state, 'waiting');
  assert.equal(parseClassifyResult('目标\n实现中\nC').background, false);
  assert.equal(parseClassifyResult('目标\n实现中\nC').error, false);
});

test('optimistic completion cannot overwrite a pending structured question', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('function emitTurnOutcome');
  const end = source.indexOf('// Turn-boundary hook', start);
  assert.match(source.slice(start, end),
    /if \(userInputSignalHost\.pending\(sessionName\)\).*setTaskState.*return;/);
});
