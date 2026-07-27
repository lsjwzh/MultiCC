'use strict';
// Unit tests for src/bg-completion-coalescer.js — pure logic, fake clock, no server.
//   node tests/test-bg-completion-coalescer.js
const assert = require('assert');
const { createCoalescer, buildNudge, classifyBgCompletion, MERGED_SNIPPET_CAP } = require('../src/bg-completion-coalescer');

// ── tiny deterministic fake clock (injected as setTimer/clearTimer) ──
function makeClock() {
  let now = 0, seq = 1;
  const timers = [];
  const setTimer = (fn, ms) => { const id = seq++; timers.push({ id, at: now + ms, fn, cleared: false }); return id; };
  const clearTimer = (id) => { const t = timers.find(t => t.id === id); if (t) t.cleared = true; };
  const advance = (ms) => {
    now += ms;
    for (const t of timers.filter(t => !t.cleared && t.at <= now).sort((a, b) => a.at - b.at)) {
      if (t.cleared) continue;
      t.cleared = true;
      t.fn();
    }
  };
  return { setTimer, clearTimer, advance };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ✓', name); }

const item = (desc, status = 'completed', snippet = '') => ({ desc, status, snippet });

// ── buildNudge: single completion must reproduce legacy wording verbatim ──
test('buildNudge single with output == legacy string', () => {
  const s = buildNudge([item('任务A', 'completed', 'hello world')]);
  assert.strictEqual(
    s,
    '【后台任务完成】你之前启动的后台任务（任务A）已结束（状态：completed）。\n以下是它的输出，请据此继续推进任务，不要重复已完成的步骤：\nhello world'
  );
});

test('buildNudge single no output == legacy 无输出 string', () => {
  const s = buildNudge([item('任务B', 'completed', '')]);
  assert.strictEqual(
    s,
    '【后台任务完成】你之前启动的后台任务（任务B）已结束（状态：completed）。\n（无输出）请据此继续推进任务。'
  );
});

// ── buildNudge: multiple merged, all listed, status preserved ──
test('buildNudge merged lists every task with header ×N', () => {
  const s = buildNudge([item('Y1', 'completed', 'aaa'), item('Y2', 'failed', ''), item('Y3', 'completed', 'ccc')]);
  assert.ok(s.includes('【后台任务完成 ×3】'), 'has ×3 header');
  assert.ok(s.includes('Y1') && s.includes('Y2') && s.includes('Y3'), 'all three descs present');
  assert.ok(s.includes('状态：failed'), 'failed status carried through (not filtered)');
});

test('buildNudge merged caps a huge snippet, keeping the TAIL (last CAP chars)', () => {
  const big = 'x'.repeat(MERGED_SNIPPET_CAP + 500) + 'TAILMARKER';
  const s = buildNudge([item('A', 'completed', big), item('B', 'completed', '')]);
  const kept = big.slice(-MERGED_SNIPPET_CAP); // tail-preserving semantics
  assert.ok(s.includes('TAILMARKER'), 'tail preserved');
  assert.ok(s.includes(kept), 'exactly the last CAP chars are kept');
  assert.ok(!s.includes(big), 'the oversized head was truncated, not kept');
});

test('buildNudge empty -> empty string', () => {
  assert.strictEqual(buildNudge([]), '');
});

// ── coalescer: single completion flushes once after the window ──
test('single completion → one flush with one item after window', () => {
  const flushes = [];
  const clk = makeClock();
  const c = createCoalescer({ windowMs: 1500, onFlush: (s, items) => flushes.push({ s, items }), setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  c.add('sess', item('X'));
  assert.strictEqual(flushes.length, 0, 'not flushed before window');
  clk.advance(1499);
  assert.strictEqual(flushes.length, 0, 'still buffered at 1499ms');
  clk.advance(1);
  assert.strictEqual(flushes.length, 1, 'flushed at window');
  assert.strictEqual(flushes[0].items.length, 1);
});

// ── coalescer: several within the window merge into ONE flush ──
test('3 completions within window → ONE flush with 3 items', () => {
  const flushes = [];
  const clk = makeClock();
  const c = createCoalescer({ windowMs: 1500, onFlush: (s, items) => flushes.push({ s, items }), setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  c.add('s', item('Y1'));
  clk.advance(500); c.add('s', item('Y2'));
  clk.advance(500); c.add('s', item('Y3'));
  assert.strictEqual(flushes.length, 0, 'nothing flushed mid-window');
  clk.advance(500); // 1500ms from FIRST item → window closes
  assert.strictEqual(flushes.length, 1, 'exactly one flush');
  assert.strictEqual(flushes[0].items.length, 3, 'all three coalesced');
});

// ── coalescer: window is fixed from first item (a trickle can't defer forever) ──
test('window is fixed from first item, not debounced', () => {
  const flushes = [];
  const clk = makeClock();
  const c = createCoalescer({ windowMs: 1000, onFlush: (s, items) => flushes.push(items), setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  c.add('s', item('a'));
  clk.advance(900); c.add('s', item('b')); // late add must NOT reset the window
  clk.advance(100);                          // 1000ms from first → flush now
  assert.strictEqual(flushes.length, 1);
  assert.strictEqual(flushes[0].length, 2);
});

// ── coalescer: completions in separate windows flush separately ──
test('separate windows → separate flushes', () => {
  const flushes = [];
  const clk = makeClock();
  const c = createCoalescer({ windowMs: 1000, onFlush: (s, items) => flushes.push(items), setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  c.add('s', item('a')); clk.advance(1000);
  c.add('s', item('b')); clk.advance(1000);
  assert.strictEqual(flushes.length, 2, 'two flushes');
  assert.strictEqual(flushes[0].length, 1);
  assert.strictEqual(flushes[1].length, 1);
});

// ── coalescer: sessions are independent ──
test('two sessions coalesce independently', () => {
  const flushes = [];
  const clk = makeClock();
  const c = createCoalescer({ windowMs: 1000, onFlush: (s, items) => flushes.push({ s, n: items.length }), setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  c.add('A', item('a1')); c.add('A', item('a2')); c.add('B', item('b1'));
  clk.advance(1000);
  assert.strictEqual(flushes.length, 2);
  const byS = Object.fromEntries(flushes.map(f => [f.s, f.n]));
  assert.strictEqual(byS.A, 2);
  assert.strictEqual(byS.B, 1);
});

// ── coalescer: cancel drops buffered completions without flushing ──
test('cancel drops buffered items without flushing', () => {
  const flushes = [];
  const clk = makeClock();
  const c = createCoalescer({ windowMs: 1000, onFlush: (s, items) => flushes.push(items), setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  c.add('C', item('z'));
  assert.strictEqual(c.pendingCount('C'), 1);
  assert.strictEqual(c.cancel('C'), true);
  assert.strictEqual(c.pendingCount('C'), 0);
  clk.advance(1000);
  assert.strictEqual(flushes.length, 0, 'cancelled window did not flush');
});

// ── coalescer: onFlush is required ──
test('createCoalescer without onFlush throws', () => {
  assert.throws(() => createCoalescer({}), /onFlush is required/);
});

// ── coalescer: a throwing onFlush must not wedge the session (delete-before-flush) ──
test('onFlush throwing leaves pending clean; the next window still works', () => {
  const clk = makeClock();
  let calls = 0;
  const c = createCoalescer({
    windowMs: 1000,
    onFlush: () => { calls++; if (calls === 1) throw new Error('boom'); },
    setTimer: clk.setTimer, clearTimer: clk.clearTimer,
  });
  c.add('s', item('a'));
  assert.throws(() => clk.advance(1000), /boom/, 'first flush surfaces the error');
  assert.strictEqual(c.pendingCount('s'), 0, 'pending cleaned despite the throw (not wedged)');
  c.add('s', item('b'));      // a fresh window must open normally
  clk.advance(1000);
  assert.strictEqual(calls, 2, 'second window flushed after the first threw');
});

// ── classifyBgCompletion: the suppress-vs-inject decision (extracted from
//    handleBackgroundTaskEvent so it is unit-testable) ─────────────────────────
// Precedence: TaskOutput pull → sync Bash → sidechain/subagent → inject.
test('classify: pulled via TaskOutput → suppress (taskoutput)', () => {
  assert.deepStrictEqual(classifyBgCompletion({ awaitingTaskOutput: true }), { action: 'suppress', reason: 'taskoutput' });
});
test('classify: sync/foreground Bash → suppress (sync-bash)', () => {
  assert.deepStrictEqual(classifyBgCompletion({ sync: true }), { action: 'suppress', reason: 'sync-bash' });
});
test('classify: subagent task → suppress (sidechain)', () => {
  assert.deepStrictEqual(classifyBgCompletion({ subagent: true }), { action: 'suppress', reason: 'sidechain' });
});
test('classify: sidechain-by-tool-use → suppress (sidechain)', () => {
  assert.deepStrictEqual(classifyBgCompletion({ sidechainByToolUse: true }), { action: 'suppress', reason: 'sidechain' });
});
test('classify: precedence — TaskOutput wins even if other flags set', () => {
  assert.strictEqual(classifyBgCompletion({ awaitingTaskOutput: true, sync: true, subagent: true }).reason, 'taskoutput');
});

// ── BUG REPRODUCTION (false-positive observed 2026-07-12, session chat-05) ───────
// A `run_in_background` daemon (`node server.js &`) that the model used only via a
// side channel (curl / CDP / reading its output file) and NEVER pulled with
// TaskOutput matches none of the suppressors → the completion is INJECTED as a
// wake-up nudge, long after the work was already done.
//
// This test PINS that known-bad behavior: all four predicates false → inject.
// It is a characterization/regression anchor — when the daemon-suppression fix
// lands, this assertion flips to { action:'suppress' } and the two below stop
// producing a nudge. See the module-doc on classifyBgCompletion.
test('REPRO: daemon consumed via side-channel (no TaskOutput) → currently INJECTS (the reported bug)', () => {
  const d = classifyBgCompletion({ awaitingTaskOutput: false, sync: false, subagent: false, sidechainByToolUse: false });
  assert.deepStrictEqual(d, { action: 'inject', reason: 'unconsumed' },
    'documents the false-positive: a side-channel-consumed daemon still fires a nudge');
});

test('REPRO end-to-end: the daemon completion flows to a nudge with the exact observed wording', () => {
  // Mirror the real event: only an "inject" decision reaches coalescer.add().
  const decision = classifyBgCompletion({ awaitingTaskOutput: false, sync: false, subagent: false, sidechainByToolUse: false });
  assert.strictEqual(decision.action, 'inject', 'precondition: the daemon case injects');

  const flushed = [];
  const clk = makeClock();
  const c = createCoalescer({
    windowMs: 1500,
    onFlush: (s, items) => flushed.push(buildNudge(items)),
    setTimer: clk.setTimer, clearTimer: clk.clearTimer,
  });
  // The literal completion that woke the session (desc + startup echo as output,
  // plus the real taskId so the [ref:…] suffix is reproduced too).
  c.add('multicc-claude-chat-05', {
    desc: 'Background command "Start test server on port 3999 with real memories" completed (exit code 0)',
    status: 'completed',
    snippet: 'real mem exists: yes\nstarted pid 46222',
    taskId: 'brwgfem7d',
  });
  clk.advance(1500);

  assert.strictEqual(flushed.length, 1, 'exactly one nudge injected');
  const msg = flushed[0];
  assert.ok(msg.startsWith('【后台任务完成】'), 'legacy header');
  assert.ok(msg.includes('已结束（状态：completed）'), 'status line');
  assert.ok(msg.includes('据此继续推进任务，不要重复已完成的步骤'), 'the continue-nudge wording the user saw');
  assert.ok(msg.includes('started pid 46222'), 'the daemon startup echo is carried in as if it were a result');
  assert.ok(msg.includes('[ref:brwgfem7d]'), 'buildNudge appends the [ref:<taskId>] suffix when the item carries an id');
  // The ONLY piece added downstream (not by buildNudge) is the 🔇 prefix, which
  // session-delivery prepends before handing the text to session admission.
});

// ── Wiring guard (structural) ────────────────────────────────────────────────
// The tests above prove the pure function. The extracted runtime tests behaviour;
// these source guards additionally lock its composition and predicate wiring.
const fs = require('fs');
const path = require('path');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const RUNTIME = fs.readFileSync(path.join(__dirname, '..', 'src/chat/background-task-runtime.js'), 'utf8');

test('wiring: runtime calls classifyCompletion with the four predicate keys', () => {
  assert.ok(SERVER.includes('classifyCompletion: bgCoalesce.classifyBgCompletion'));
  const call = /classifyCompletion\(\{([\s\S]{0,400}?)\}\)/.exec(RUNTIME);
  assert.ok(call, 'background runtime must call classifyCompletion({...})');
  for (const key of ['awaitingTaskOutput', 'sync', 'subagent', 'sidechainByToolUse']) {
    assert.ok(new RegExp('\\b' + key + '(?:\\s*:|\\s*[,}])').test(call[1]),
      `classifyBgCompletion call must pass the "${key}" predicate`);
  }
});

test('wiring: each reason dispatches to its matching consume* side effect', () => {
  const pairs = [
    ["reason === 'taskoutput'", 'consumeTimed(taskOutputAwaiting'],
    ["reason === 'sync-bash'", 'consumeTimed(syncBashTasks'],
    ["reason === 'sidechain'", 'consumeTimed(subagentTasks'],
  ];
  for (const [guard, consume] of pairs) {
    assert.ok(RUNTIME.includes(guard), `expected wiring token: ${guard}`);
    assert.ok(RUNTIME.includes(consume), `expected consume call: ${consume}`);
  }
  assert.ok(/coalescer\.add\(/.test(RUNTIME), 'inject path must call coalescer.add(...)');
});

console.log(`\nbg-completion-coalescer: ${passed} tests passed`);
