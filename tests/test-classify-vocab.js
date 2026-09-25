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
  runStateForClassify,
  phaseLabel,
  applyUserInputEvidence,
  isProcessingLetter,
  isWaitForUserLetter,
  isBackgroundLetter,
  isTerminalLetter,
  isAbnormalLetter,
  isSettledLetter,
  isParkedLetter,
  isOutcomeLetter,
  CLASSIFY_DISPLAY,
  CLASSIFY_STATES,
  PHASE_LABELS,
} = require('../src/classify/vocab');

test('state letter is the single source of truth (D/W/B/E/P); C retires to W', () => {
  const cases = [
    ['P', 'P'],
    // C is RETIRED — collapses to W.
    ['C', 'W'],
    ['W', 'W'],
    ['B', 'B'],
    ['E', 'E'],
    ['D', 'D'],
  ];
  for (const [letter, expect] of cases) {
    const r = parseClassifyResult(`修复登录样式\n实现中\n${letter}`);
    assert.equal(r.state, expect, letter);
    // No word+flags intermediate: the letter IS the state.
    assert.equal(r.background, undefined, `${letter} no background flag`);
    assert.equal(r.error, undefined, `${letter} no error flag`);
  }
});

test('unknown/unparseable state defaults to waiting, NEVER completed', () => {
  assert.equal(parseClassifyResult('目标\n实现中\nZ').state, 'W');
  assert.equal(parseClassifyResult('').state, 'W');
  assert.equal(parseClassifyResult('garbage only').state, 'W');
  // A single blank/space state line must not fall through to completed.
  assert.equal(parseClassifyResult('目标\n实现中\n ').state, 'W');
});

test('unresolved request_user_input evidence authoritatively yields plain waiting', () => {
  const classified = parseClassifyResult('部署修复\n已完成\nD');
  const resolved = applyUserInputEvidence(classified, {
    requestId: 'usrq-1',
    question: '是否立即发布？',
    resolved: false,
  });
  assert.equal(resolved.state, 'W');
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
  assert.equal(r2.state, 'W'); // C retired → collapses to W
  // <think></think> tags themselves are stripped (their content is NOT removed —
  // the classifier relies on the unicode marker above for that), so empty tags
  // just leave the goal line intact.
  const r = parseClassifyResult('<think></think>真目标\n实现中\nD');
  assert.equal(r.goal, '真目标');
  assert.equal(r.state, 'D');
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
  assert.equal(CLASSIFY_DISPLAY.D.cardStatus, 'succeeded');
  assert.equal(CLASSIFY_DISPLAY.D.label, '执行成功');
  assert.equal(CLASSIFY_DISPLAY.W.cardStatus, 'waiting');
  // B borrowed W's `waiting` until it got its own run state: 「等待回答」 about a
  // job the user cannot answer was the lie the split removed.
  assert.equal(CLASSIFY_DISPLAY.B.cardStatus, 'background');
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
  // parseClassifyResult is the single retirement point: C → plain W.
  assert.equal(parseClassifyResult('目标\n实现中\nC').state, 'W');
  assert.equal(parseClassifyResult('目标\n实现中\nC').background, undefined);
  assert.equal(parseClassifyResult('目标\n实现中\nC').error, undefined);
});

// ── Letter semantics: the predicates, not inline letter comparisons ──────────

test('each predicate answers exactly one question, and the letters partition by "who acts next"', () => {
  // [processing, waitForUser, background, terminal, abnormal] per letter.
  // C is RETIRED as an output (parseClassifyResult collapses it to W) but a
  // legacy persisted C is still an in-flight turn, so it reads as processing.
  const EXPECT = {
    P: [true, false, false, false, false],
    C: [true, false, false, false, false],
    W: [false, true, false, false, false],
    B: [false, false, true, false, false],
    D: [false, false, false, true, false],
    E: [false, false, false, false, true],
  };
  for (const letter of Object.keys(CLASSIFY_DISPLAY)) {
    assert.ok(EXPECT[letter], `${letter} has no pinned predicate expectation`);
  }
  for (const [letter, [processing, waiting, background, terminal, abnormal]] of Object.entries(EXPECT)) {
    assert.equal(isProcessingLetter(letter), processing, `${letter} isProcessingLetter`);
    assert.equal(isWaitForUserLetter(letter), waiting, `${letter} isWaitForUserLetter`);
    assert.equal(isBackgroundLetter(letter), background, `${letter} isBackgroundLetter`);
    assert.equal(isTerminalLetter(letter), terminal, `${letter} isTerminalLetter`);
    assert.equal(isAbnormalLetter(letter), abnormal, `${letter} isAbnormalLetter`);
    // "Who acts next" is a partition: P/C the turn, W the user, B a background
    // job — never two of them at once. D/E name nobody: the turn is over and
    // the next move is the user's (that is isSettled/isOutcome's business).
    assert.ok([processing, waiting, background].filter(Boolean).length <= 1,
      `${letter} must name at most one actor`);
    assert.equal([processing, waiting, background].filter(Boolean).length,
      (terminal || abnormal) ? 0 : 1, `${letter} names no actor only when the turn is over`);
  }

  // Derived predicates are defined, not re-decided: settled = D|W, parked = W|B,
  // outcome = D|E. A letter re-scoped here on its own would drift from the two
  // base decisions.
  for (const letter of Object.keys(CLASSIFY_DISPLAY)) {
    assert.equal(isSettledLetter(letter), isTerminalLetter(letter) || isWaitForUserLetter(letter),
      `${letter} isSettledLetter`);
    assert.equal(isParkedLetter(letter), isWaitForUserLetter(letter) || isBackgroundLetter(letter),
      `${letter} isParkedLetter`);
    assert.equal(isOutcomeLetter(letter), isTerminalLetter(letter) || isAbnormalLetter(letter),
      `${letter} isOutcomeLetter`);
  }

  // The two axes are independent: a turn can be parked (W/B) without having
  // reached an outcome, and have an outcome (D/E) without being parked.
  assert.equal(isParkedLetter('D'), false);
  assert.equal(isOutcomeLetter('W'), false);
  assert.equal(isSettledLetter('B'), false, 'B is parked, not settled — a callback still writes');
  assert.equal(isSettledLetter('E'), false, 'a fault still needs a retry/resume decision');
});

test('no predicate claims an unknown or un-normalized letter', () => {
  const PREDICATES = {
    isProcessingLetter, isWaitForUserLetter, isBackgroundLetter,
    isTerminalLetter, isAbnormalLetter, isSettledLetter, isParkedLetter, isOutcomeLetter,
  };
  // The safety property: garbage must never read as "nothing outstanding" —
  // an unrecognized letter is not settled, not parked, not an outcome.
  for (const junk of [undefined, null, '', '   ', 'X', 'd', 'w', 0]) {
    for (const [name, fn] of Object.entries(PREDICATES)) {
      assert.equal(fn(junk), false, `${name}(${JSON.stringify(junk)}) must be false`);
    }
  }
  // Letters are canonical uppercase; callers normalize before asking (see
  // recordAppearsAvailable in src/task-board/routing.js).
  assert.equal(isTerminalLetter('d'), false);
});

test('live-letter membership: CLASSIFY_STATES is the parser\'s own output range', () => {
  assert.deepEqual([...CLASSIFY_STATES].sort(), ['B', 'D', 'E', 'P', 'W']);
  // Everything the parser can still emit is a member — the set cannot drift
  // below the parser without this failing.
  for (const input of ['D', 'W', 'B', 'E', 'P']) {
    const state = parseClassifyResult(`目标\n实现中\n${input}`).state;
    assert.ok(CLASSIFY_STATES.has(state), `parser output ${state} is not a live letter`);
  }
  // C is not live (retirement is `parseClassifyResult`, not a second decision
  // here), yet the predicates still tolerate a legacy persisted C.
  assert.equal(CLASSIFY_STATES.has('C'), false);
  assert.equal(isProcessingLetter('C'), true);
  // The set and the display map cover the same alphabet, minus retired C.
  const display = Object.keys(CLASSIFY_DISPLAY).filter(l => l !== 'C').sort();
  assert.deepEqual([...CLASSIFY_STATES].sort(), display);
});

test('predicates agree with the display projection they replaced (no re-lettering drift)', () => {
  // cardStatus is the render-side projection of the same letter. Tying the two
  // together is what makes a future re-lettering (B's split from `waiting` was
  // the last one) impossible to half-apply: a letter that is `processing` must
  // render `running`, a parked one must render `waiting`/`background`, and an
  // outcome must render `succeeded`/`error`.
  const EXPECT = {
    running: isProcessingLetter,
    waiting: isWaitForUserLetter,
    background: isBackgroundLetter,
    succeeded: isTerminalLetter,
    error: isAbnormalLetter,
  };
  for (const letter of Object.keys(CLASSIFY_DISPLAY)) {
    const status = runStateForClassify(letter);
    const match = Object.entries(EXPECT).find(([canvas]) => canvas === status);
    assert.ok(match, `${letter} renders as unknown run state ${status}`);
    assert.equal(match[1](letter), true,
      `${letter} renders as ${status} but its ${match[0]} predicate disagrees`);
  }
});

// ── The static guard: no fresh inline letter comparison outside vocab.js ────
//
// vocab.js says downstream code MUST use the predicates. That only holds if a
// new site cannot quietly reintroduce `classifyState === 'D'` — which is how
// every past drift started (a re-lettered B leaving one subsystem behind). This
// test is what makes the comment above enforceable.
test('src/ has no inline classify-letter comparison outside the vocabulary', () => {
  // Patterns are deliberately narrow: a *comparison* against a classify letter,
  // or a hand-written letter list serving as one. They are not a hunt for the
  // letter D anywhere in the tree — CLI capability tables, push types and
  // comments legitimately carry letters of their own.
  const PATTERNS = [
    /[=!]==?\s*['"][DPWEB]['"]/g,                  // classifyState === 'D'
    /['"][DPWEB]['"]\s*[=!]==?/g,                  // 'D' === classifyState
    /\[\s*(?:['"][A-Z]['"]\s*,\s*)+['"][A-Z]['"]\s*\]\s*\.includes\(/g, // ['W','B'].includes(x)
    /\.includes\(\s*['"][DPWEB]['"]\s*\)/g,        // [...].includes('D')
  ];
  // Prove the guard catches the shapes it claims — including the two historic
  // ones. A guard that quietly matches nothing is worse than no guard.
  const HISTORY = [
    "if (classifyState === 'D') return;",
    "const done = 'D' !== schedule.classifyState;",
    "if (['A','P'].includes(classifyState)) continue;",
    "if (['P','B','W'].includes(row.taskState?.classifyState)) return;",
    "if (letters.includes('D')) return;",
  ];
  for (const sample of HISTORY) {
    assert.ok(
      PATTERNS.some(re => { re.lastIndex = 0; return re.test(sample); }),
      `the guard no longer catches a known inline comparison: ${sample}`,
    );
  }
  // Files allowed to keep a comparison, with the reason it is not a classify
  // question. Empty today; an entry here is a claim that must still be true (the
  // test fails if it no longer violates), so the list cannot rot.
  const ALLOWED = {};

  // Comments are stripped before matching (a comment quoting the old check is
  // documentation). The `[^:'"]` guard keeps `https://…` and `'//'` intact.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');

  const root = path.join(__dirname, '..');
  const files = [path.join(root, 'server.js')];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(root, 'src'));

  const offenders = [];
  for (const file of files) {
    const rel = path.relative(root, file);
    if (rel === path.join('src', 'classify', 'vocab.js')) continue;   // the vocabulary itself
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const re of PATTERNS) {
      for (const m of src.matchAll(re)) {
        const line = src.slice(0, m.index).split('\n').length;
        const hit = `${rel}:${line}: ${m[0].trim()}`;
        offenders.push({ rel, hit });
      }
    }
  }

  const unexpected = offenders.filter(o => !Object.hasOwn(ALLOWED, o.rel));
  assert.deepEqual(unexpected.map(o => o.hit), [],
    'inline classify-letter comparisons must go through the vocab predicates');
  // No rotting allowlist: every exemption must still be needed.
  for (const [rel, reason] of Object.entries(ALLOWED)) {
    assert.ok(!offenders.some(o => o.rel === rel),
      `${rel} no longer needs its exemption (${reason}) — remove it`);
  }
});

test('optimistic completion cannot overwrite a pending structured question', () => {
  // emitTurnOutcome now lives in the extracted classify state machine; slice it
  // there (the '// Turn-boundary hook' anchor comment moved with it).
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'classify', 'state-machine.js'), 'utf8');
  const start = source.indexOf('function emitTurnOutcome');
  const end = source.indexOf('// Turn-boundary hook', start);
  assert.match(source.slice(start, end),
    /if \(getUserInputSignalHost\(\)\.pending\(sessionName\)\).*setTaskState.*return;/);
});
