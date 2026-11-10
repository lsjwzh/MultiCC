'use strict';
// Behaviour tests for the background completion coalescer.
//
// The former pure module src/bg-completion-coalescer.js is gone: the window,
// the `buildNudge` wording and the suppress-vs-inject classifier now live in
// Rust (RustBackgroundTasks). These tests drive the same behaviour through the
// frozen JS facade and a fake clock, so the observable contract (one nudge per
// window, legacy wording, precedence) is still locked.
//   node tests/test-bg-completion-coalescer.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createBackgroundTaskRuntime } = require('../src/chat/background-task-runtime');

// Kept in sync with native/core/src/background/coalescer.rs (MERGED_SNIPPET_CAP).
const MERGED_SNIPPET_CAP = 800;
const MONITOR_PREFIX = '【后台事件】以下是后台工具的输出，不是用户回复。根据事件继续原任务，不要把监听仍在运行当作任务完成：';

// ── tiny deterministic fake clock (injected as setTimer/clearTimer) ──
function makeClock(start = 1_000_000) {
  let now = start, seq = 1;
  const timers = [];
  const clock = {
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { id: seq++, at: now + ms, fn, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { if (timer) timer.cleared = true; },
    advance(ms) {
      now += ms;
      for (const timer of timers.filter(t => !t.cleared && t.at <= now).sort((a, b) => a.at - b.at)) {
        if (timer.cleared) continue;
        timer.cleared = true;
        timer.fn();
      }
    },
  };
  return clock;
}

function harness({ windowMs = 1000 } = {}) {
  const clock = makeClock();
  const injected = [], observed = [], messages = [], warnings = [];
  let failNextDeliver = false;
  const runtime = createBackgroundTaskRuntime({
    broadcast: (name, event) => messages.push({ name, event }),
    observeTask: observation => observed.push(observation),
    noteBgResultInjected() {},
    deliverSystem: (session, text, origin) => {
      if (failNextDeliver) { failNextDeliver = false; throw new Error('boom'); }
      injected.push({ session, text, origin });
    },
    readFile: () => { throw new Error('ENOENT'); },
    realpath: value => value,
    tmpdir: () => '/tmp',
    getuid: () => 501,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    completionWindowMs: windowMs,
    logger: { info() {}, warn: message => warnings.push(message) },
  });
  return {
    clock, injected, observed, messages, warnings, runtime,
    failNextDeliver() { failNextDeliver = true; },
    complete(session, taskId, fields = {}) {
      return runtime.handleEvent(session, {}, { subtype: 'task_notification', task_id: taskId, ...fields });
    },
    start(session, taskId, chat, fields = {}) {
      return runtime.handleEvent(session, chat, { subtype: 'task_started', task_id: taskId, ...fields });
    },
  };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ✓', name); }

// ── single completion: exact legacy wording, flushed once after the window ──
test('single completion with output == legacy string, flushed once at the window', () => {
  const h = harness({ windowMs: 1500 });
  const result = h.complete('s', 'task-1', { description: '任务A', status: 'completed', result: 'hello world' });
  assert.deepStrictEqual(result, { handled: true, decision: 'inject' });
  assert.strictEqual(h.injected.length, 0, 'not flushed before the window');
  h.clock.advance(1499);
  assert.strictEqual(h.injected.length, 0, 'still buffered at 1499ms');
  h.clock.advance(1);
  assert.strictEqual(h.injected.length, 1, 'flushed exactly at the window');
  assert.strictEqual(h.injected[0].session, 's');
  assert.strictEqual(
    h.injected[0].text,
    '【后台任务完成】你之前启动的后台任务（任务A）已结束（状态：completed）。\n'
      + '以下是它的输出，请据此继续推进任务，不要重复已完成的步骤：\n'
      + 'hello world [ref:task-1]',
  );
});

test('single completion without output == legacy 无输出 string', () => {
  const h = harness();
  h.complete('s', 'task-b', { description: '任务B', status: 'completed' });
  h.clock.advance(1000);
  assert.strictEqual(
    h.injected[0].text,
    '【后台任务完成】你之前启动的后台任务（任务B）已结束（状态：completed）。\n（无输出）请据此继续推进任务。 [ref:task-b]',
  );
});

test('nothing buffered means no nudge is ever delivered', () => {
  const h = harness();
  h.clock.advance(5000);
  assert.strictEqual(h.injected.length, 0);
});

// ── several completions merge into ONE nudge, all listed ──
test('3 completions within the window merge into ONE nudge with ×3 header', () => {
  const h = harness({ windowMs: 1500 });
  h.complete('s', 't1', { description: 'Y1', status: 'completed', result: 'aaa' });
  h.clock.advance(500);
  h.complete('s', 't2', { description: 'Y2', status: 'failed' });
  h.clock.advance(500);
  h.complete('s', 't3', { description: 'Y3', status: 'completed', result: 'ccc' });
  assert.strictEqual(h.injected.length, 0, 'nothing flushed mid-window');
  h.clock.advance(500); // 1500ms from the FIRST completion closes the window
  assert.strictEqual(h.injected.length, 1, 'exactly one nudge');
  const text = h.injected[0].text;
  assert.ok(text.includes('【后台任务完成 ×3】'), 'has ×3 header');
  assert.ok(text.includes('Y1') && text.includes('Y2') && text.includes('Y3'), 'all three descs present');
  assert.ok(text.includes('Y2）状态：failed——'), 'failed status carried through, not filtered');
  assert.ok(text.includes('[refs:t1,t2,t3]'), 'merged refs preserved');
});

test('merged nudge caps a huge snippet, keeping the TAIL', () => {
  const h = harness();
  const big = 'x'.repeat(MERGED_SNIPPET_CAP + 500) + 'TAILMARKER';
  h.complete('s', 'A', { description: 'A', status: 'completed', result: big });
  h.complete('s', 'B', { description: 'B', status: 'completed' });
  h.clock.advance(1000);
  const text = h.injected[0].text;
  assert.ok(text.includes('TAILMARKER'), 'tail preserved');
  assert.ok(text.includes(big.slice(-MERGED_SNIPPET_CAP)), 'exactly the last CAP chars are kept');
  assert.ok(!text.includes(big), 'the oversized head was truncated, not kept');
});

// ── the window is fixed from the first item, not debounced ──
test('window is fixed from the first item; a late add cannot defer it', () => {
  const h = harness();
  h.complete('s', 'a', { description: 'a' });
  h.clock.advance(900);
  h.complete('s', 'b', { description: 'b' }); // must NOT reset the window
  h.clock.advance(99);
  assert.strictEqual(h.injected.length, 0, 'not yet due relative to the first item');
  h.clock.advance(1); // 1000ms from the first item
  assert.strictEqual(h.injected.length, 1);
  assert.ok(h.injected[0].text.includes('【后台任务完成 ×2】'));
});

test('separate windows flush separately', () => {
  const h = harness();
  h.complete('s', 'a', { description: 'a' });
  h.clock.advance(1000);
  h.complete('s', 'b', { description: 'b' });
  h.clock.advance(1000);
  assert.strictEqual(h.injected.length, 2);
  assert.ok(!h.injected[0].text.includes('b'));
  assert.ok(h.injected[1].text.includes('（b）'));
});

test('two sessions coalesce independently', () => {
  const h = harness();
  h.complete('A', 'a1', { description: 'a1' });
  h.complete('A', 'a2', { description: 'a2' });
  h.complete('B', 'b1', { description: 'b1' });
  h.clock.advance(1000);
  assert.strictEqual(h.injected.length, 2);
  const bySession = Object.fromEntries(h.injected.map(entry => [entry.session, entry.text]));
  assert.ok(bySession.A.includes('【后台任务完成 ×2】'));
  assert.ok(!bySession.B.includes('×2'));
});

// ── cancel drops buffered items without flushing ──
test('stopForInsert cancels buffered completions without flushing', () => {
  const h = harness();
  h.complete('C', 'z', { description: 'z' });
  h.runtime.stopForInsert('C');
  h.clock.advance(1000);
  assert.strictEqual(h.injected.length, 0, 'cancelled window did not flush');
  assert.strictEqual(h.runtime.takeStoppedNote('C'), '', 'no live task means no stop note');
});

// ── a throwing delivery must not wedge the session ──
test('a throwing deliverSystem does not wedge the next window', () => {
  const h = harness();
  h.failNextDeliver();
  h.complete('s', 'a', { description: 'a' });
  h.clock.advance(1000); // throws inside the port; the facade logs and continues
  assert.strictEqual(h.injected.length, 0);
  assert.ok(h.warnings.some(message => message.includes('background task completion injection failed')
    || message.includes('background task timer failed')));
  h.complete('s', 'b', { description: 'b' });
  h.clock.advance(1000);
  assert.strictEqual(h.injected.length, 1, 'the next window still flushes');
  assert.ok(h.injected[0].text.includes('（b）'));
});

// ── classifier precedence, exercised through the real event entry point ──
// Precedence: TaskOutput pull → sync Bash → sidechain/subagent → Monitor → inject.
function bashChat(id) {
  return { currentToolCalls: [{ id, name: 'Bash', input: { command: 'ls' } }], isStreaming: false };
}
function monitorChat(id) {
  return { currentToolCalls: [{ id, name: 'Monitor', input: { command: 'tail -f /tmp/x' } }], isStreaming: false };
}

test('classify: pulled via TaskOutput → suppress (taskoutput), flag consumed', () => {
  const h = harness();
  assert.strictEqual(h.runtime.markTaskOutputAwaiting('s', { block: true, task_id: 'pulled' }), true);
  const suppressed = h.complete('s', 'pulled', { description: 'p' });
  assert.deepStrictEqual(suppressed, { handled: true, decision: 'taskoutput' });
  h.clock.advance(2000);
  assert.strictEqual(h.injected.length, 0, 'a pulled result must not become a nudge');
  const after = h.complete('s', 'pulled', { description: 'p' });
  assert.deepStrictEqual(after, { handled: true, decision: 'inject' }, 'the awaiting flag is one-shot');
});

test('classify: sync/foreground Bash → suppress (sync-bash)', () => {
  const h = harness();
  h.start('s', 'sb', bashChat('tu'), { tool_use_id: 'tu', description: 'bash' });
  const decision = h.complete('s', 'sb', { tool_use_id: 'tu', description: 'bash', result: 'out' });
  assert.deepStrictEqual(decision, { handled: true, decision: 'sync-bash' });
  h.clock.advance(2000);
  assert.strictEqual(h.injected.length, 0);
});

test('classify: subagent task → suppress (sidechain)', () => {
  const h = harness();
  h.start('s', 'sub', [], { tool_use_id: 'sub-tu', description: 'agent' });
  const decision = h.complete('s', 'sub', { tool_use_id: 'sub-tu', description: 'agent', result: 'r' });
  assert.deepStrictEqual(decision, { handled: true, decision: 'sidechain' });
  h.clock.advance(2000);
  assert.strictEqual(h.injected.length, 0);
});

test('classify: precedence — TaskOutput wins over sync Bash', () => {
  const h = harness();
  h.start('s', 'both', bashChat('tu'), { tool_use_id: 'tu', description: 'bash' });
  h.runtime.markTaskOutputAwaiting('s', { block: true, task_id: 'both' });
  const decision = h.complete('s', 'both', { tool_use_id: 'tu', description: 'bash' });
  assert.deepStrictEqual(decision, { handled: true, decision: 'taskoutput' });
});

test('classify: unknown consumption state injects so a completion is never silently lost', () => {
  const h = harness();
  const decision = h.complete('s', 'later', { description: 'later', status: 'completed', result: 'done' });
  assert.deepStrictEqual(decision, { handled: true, decision: 'inject' });
  h.clock.advance(1000);
  assert.strictEqual(h.injected.length, 1);
});

// ── Monitor completions keep the dedicated 后台事件 wording ──
test('Monitor completion suppresses the generic nudge and emits the 后台事件 nudge', () => {
  const h = harness();
  h.start('s', 'mon', monitorChat('mu'), { tool_use_id: 'mu', description: '监听事件' });
  const decision = h.complete('s', 'mon', {
    tool_use_id: 'mu', summary: '有新事件', status: 'completed', result: 'line 1\nline 2',
  });
  assert.deepStrictEqual(decision, { handled: true, decision: 'monitor' });
  h.clock.advance(1000);
  assert.strictEqual(h.injected.length, 1);
  const text = h.injected[0].text;
  assert.ok(text.startsWith(MONITOR_PREFIX), 'monitor-specific preamble');
  assert.ok(text.includes('- 有新事件（completed） [ref:mon]'), 'monitor line with status and ref');
  assert.ok(text.includes('line 1'), 'monitor output snippet carried through');
});

// ── wiring guard (structural) ────────────────────────────────────────────────
// The pure module was deleted; the facade must stay stateless and delegate to
// the Rust owner, and server.js must not re-import the removed module.
const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const RUNTIME = fs.readFileSync(path.join(ROOT, 'src/chat/background-task-runtime.js'), 'utf8');

test('wiring: facade delegates to RustBackgroundTasks and keeps no coalescer state', () => {
  assert.ok(RUNTIME.includes('RustBackgroundTasks'), 'facade must construct the Rust owner');
  assert.ok(RUNTIME.includes('owner.tick(ports)'), 'the single timer must call the owner tick');
  assert.ok(!/classifyCompletion|coalescer\s*=|pendingCount/.test(RUNTIME), 'no coalescer bookkeeping may return to Node');
});

test('wiring: server.js no longer requires the deleted coalescer module', () => {
  assert.ok(!SERVER.includes('bg-completion-coalescer'), 'deleted module must not be imported');
  assert.ok(!fs.existsSync(path.join(ROOT, 'src/bg-completion-coalescer.js')), 'deleted file must stay deleted');
});

console.log(`\nbg-completion-coalescer: ${passed} tests passed`);
