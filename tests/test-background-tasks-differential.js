'use strict';
// Differential test: the frozen pre-Rust runtime
// (tests/helpers/legacy-background-task-runtime.js) versus the Rust owner behind
// src/chat/background-task-runtime.js.
//
// Both runtimes are driven with the same fake clock, the same events and the same
// host ports. After every step the observable effects (broadcast frames, ledger
// observations, injected nudges, notes, warnings) and the query surface are
// compared. Writer shadows are fed step-isomorphically: the legacy `tail` child
// receives the bytes appended since the previous 500ms boundary, while the Rust
// owner sees the same bytes through readFile polling on the same boundary.
//
// `now()` call counts are deliberately excluded: the two implementations read the
// clock a different number of times, which is not observable by the host. Later
// control-channel enrichment (fetchTaskOutput) is exercised in the focused suite.
//
//   node tests/test-background-tasks-differential.js

const assert = require('assert');
const { EventEmitter } = require('events');
const legacy = require('./helpers/legacy-background-task-runtime');
const legacyCoalescer = require('./helpers/legacy-bg-completion-coalescer');
const { createBackgroundTaskRuntime } = require('../src/chat/background-task-runtime');

const SHADOW_POLL_MS = 500;
const WINDOW_MS = 1500;
const SESSIONS = ['s1', 's2'];

function makeClock() {
  let time = 0;
  let sequence = 0;
  const timers = [];
  return {
    now: () => time,
    setTimer(fn, ms) {
      const timer = { id: ++sequence, at: time + Math.max(0, ms), fn, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { if (timer) timer.cleared = true; },
    advance(ms) {
      time += ms;
      for (;;) {
        const next = timers
          .filter(timer => !timer.cleared && timer.at <= time)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        next.cleared = true;
        next.fn();
      }
    },
  };
}

// Structural value usable in deepStrictEqual: keeps undefined/Infinity/NaN and
// key order differences from hiding a divergence.
function stable(value) {
  if (value === undefined) return { __undefined: true };
  if (typeof value === 'number' && !Number.isFinite(value)) return { __number: String(value) };
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

function makeHarness(kind, options = {}) {
  const clock = makeClock();
  const files = new Map();
  const tails = new Map();
  const broadcasts = [], observations = [], notes = [], injections = [], warnings = [];

  function spawn(command, args) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.command = command;
    child.args = args;
    child.killed = false;
    child.kill = () => { child.killed = true; };
    tails.set(args[3], { child, emitted: 0, killed: false });
    return child;
  }

  const deps = {
    broadcast: (sessionName, event) => broadcasts.push({ sessionName, event }),
    observeTask: observation => { observations.push(observation); },
    noteBgResultInjected: sessionName => notes.push(sessionName),
    deliverSystem: (sessionName, text, origin) => injections.push({ sessionName, text, origin }),
    // Legacy-only implementation pieces. The Rust facade ignores them.
    createCoalescer: legacyCoalescer.createCoalescer,
    buildNudge: legacyCoalescer.buildNudge,
    classifyCompletion: legacyCoalescer.classifyBgCompletion,
    spawn,
    readFile: file => {
      if (!files.has(file)) throw new Error('ENOENT');
      return files.get(file);
    },
    realpath: value => value === '/tmp' ? '/private/tmp' : `/real${value}`,
    tmpdir: () => '/tmp',
    getuid: () => 501,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    logger: {
      warn: message => warnings.push(String(message)),
      info() {},
    },
    completionWindowMs: WINDOW_MS,
    ...options,
  };
  const runtime = kind === 'legacy'
    ? legacy.createBackgroundTaskRuntime(deps)
    : createBackgroundTaskRuntime(deps);

  function pumpTails() {
    for (const [file, entry] of tails) {
      if (entry.killed || entry.child.killed) continue;
      const content = files.get(file);
      if (typeof content !== 'string') continue;
      if (content.length <= entry.emitted) continue;
      const delta = content.slice(entry.emitted);
      entry.emitted = content.length;
      if (delta.trim()) entry.child.stdout.emit('data', delta);
    }
  }

  return {
    kind, runtime, clock, files, tails, broadcasts, observations, notes, injections, warnings,
    write(file, content) { files.set(file, content); },
    // Only whole 500ms ticks align the legacy tail bytes with the Rust poll.
    advance(ms) {
      if (ms % SHADOW_POLL_MS !== 0) throw new Error('differential advance must be a multiple of 500ms');
      for (let left = ms; left > 0; left -= SHADOW_POLL_MS) {
        clock.advance(SHADOW_POLL_MS);
        if (kind === 'legacy') pumpTails();
      }
    },
    snapshot() {
      return {
        broadcasts: stable(broadcasts),
        observations: stable(observations),
        notes: stable(notes),
        injections: stable(injections),
        warnings: stable(warnings),
        state: stable(SESSIONS.flatMap(session => [
          runtime.hasLiveBackgroundTasks(session),
          runtime.hasProcessBackgroundTasks(session),
          runtime.backgroundSilenceMs(session, clock.now()),
          runtime.listActiveBackgroundTasks(session),
        ])),
      };
    },
  };
}

const harnesses = [];
function pair(options = {}) {
  const legacyHarness = makeHarness('legacy', options);
  const rustHarness = makeHarness('rust', options);
  harnesses.push(legacyHarness, rustHarness);
  return [legacyHarness, rustHarness];
}

function stableEqual(actual, expected, label) {
  assert.deepStrictEqual(actual, expected, label);
}

function applyOp(h, op) {
  switch (op.type) {
    case 'event':
      return h.runtime.handleEvent(op.session, structuredClone(op.chat), structuredClone(op.event));
    case 'record':
      return h.runtime.recordMainToolUseId(op.session, op.id);
    case 'await':
      return h.runtime.markTaskOutputAwaiting(op.session, structuredClone(op.input));
    case 'reap':
      return h.runtime.reapSessionShadows(op.session, op.opts);
    case 'stopForInsert':
      return h.runtime.stopForInsert(op.session);
    case 'note':
      return h.runtime.takeStoppedNote(op.session);
    case 'stopSession':
      return h.runtime.stopSession(op.session);
    case 'stopAll':
      return h.runtime.stopAll();
    case 'advance':
      h.advance(op.ms);
      return undefined;
    case 'write':
      h.write(op.file, op.content);
      return undefined;
    case 'query':
      return undefined;
    default:
      throw new Error(`unknown differential op ${op.type}`);
  }
}

function runScenario(name, ops) {
  const [legacyHarness, rustHarness] = pair();
  ops.forEach((op, index) => {
    const safeApply = harness => {
      try { return { value: stable(applyOp(harness, op)) }; }
      catch (error) { return { threw: error && error.constructor ? error.constructor.name : String(error) }; }
    };
    const legacyResult = safeApply(legacyHarness);
    const rustResult = safeApply(rustHarness);
    stableEqual(rustResult, legacyResult, `${name} step ${index} (${op.type}) return value`);
    try {
      stableEqual(rustHarness.snapshot(), legacyHarness.snapshot(), `${name} step ${index} (${op.type}) effects`);
    } catch (error) {
      console.error('\nDIFF OPS', JSON.stringify(ops.slice(Math.max(0, index - 25), index + 1)));
      console.error('DIFF CLOCK', legacyHarness.clock.now(), rustHarness.clock.now());
      throw error;
    }
  });
  return { legacyHarness, rustHarness };
}

function shadowFile(taskId) {
  return `/private/tmp/claude-501/-real-repo/native/tasks/${taskId}.output`;
}

const bgChat = (toolId, command = 'sleep 30') => ({
  cwd: '/repo',
  currentToolCalls: [{ id: toolId, name: 'Bash', input: { command, run_in_background: true } }],
});
const fgChat = (toolId, command = 'make') => ({
  cwd: '/repo',
  currentToolCalls: [{ id: toolId, name: 'Bash', input: { command } }],
});
const monitorChat = (toolId, persistent = false) => ({
  cwd: '/repo',
  currentToolCalls: [{ id: toolId, name: 'Monitor', input: { pattern: 'DONE', persistent } }],
});
const agentChat = (toolId) => ({
  cwd: '/repo',
  currentToolCalls: [{ id: toolId, name: 'Agent', input: { run_in_background: true } }],
});

const event = (subtype, fields) => ({ subtype, ...fields });

// Last `monitor_progress` broadcast for a task id, used by the intentional
// numeric-run-id divergence below. Its `run_id` field echoes the metadata the
// runtime decided to keep for that task.
function lastMonitorProgress(harness, taskId) {
  for (let index = harness.broadcasts.length - 1; index >= 0; index -= 1) {
    const frame = harness.broadcasts[index];
    if (frame.event && frame.event.type === 'monitor_progress' && frame.event.task_id === taskId) {
      return frame.event;
    }
  }
  return undefined;
}

let passed = 0;
function scenario(name, ops) {
  runScenario(name, ops);
  passed += 1;
  console.log('  ✓', name);
}

// ── hand-built scenarios ──────────────────────────────────────────────────────
scenario('run_in_background lifecycle: shadow progress, completion, nudge, teardown', [
  { type: 'event', session: 's1', chat: bgChat('tool-bg'), event: event('task_started', {
    task_id: 'bg-1', tool_use_id: 'tool-bg', session_id: 'native', description: 'long build',
  }) },
  { type: 'write', file: shadowFile('bg-1'), content: 'compiling one\n' },
  { type: 'advance', ms: 500 },
  { type: 'write', file: shadowFile('bg-1'), content: 'compiling one\ncompiling two\n' },
  { type: 'advance', ms: 5000 },
  { type: 'event', session: 's1', chat: bgChat('tool-bg'), event: event('task_notification', {
    task_id: 'bg-1', tool_use_id: 'tool-bg', status: 'completed', result: 'BUILD OK',
  }) },
  { type: 'advance', ms: 1500 },
  { type: 'note', session: 's1' },
  { type: 'reap', session: 's1', opts: { reason: 'stream_exit' } },
  { type: 'stopSession', session: 's1' },
]);

scenario('foreground Bash and sub-agent tasks are suppressed', [
  { type: 'event', session: 's1', chat: fgChat('fg-tool'), event: event('task_started', {
    task_id: 'fg-1', tool_use_id: 'fg-tool', session_id: 'native', description: 'foreground',
  }) },
  { type: 'event', session: 's1', chat: { cwd: '/repo', currentToolCalls: [] }, event: event('task_started', {
    task_id: 'agent-1', tool_use_id: 'agent-tool', session_id: 'native', description: 'agent work',
  }) },
  { type: 'event', session: 's1', chat: { cwd: '/repo', currentToolCalls: [] }, event: event('task_notification', {
    task_id: 'fg-1', tool_use_id: 'fg-tool', status: 'completed', result: 'fg output',
  }) },
  { type: 'event', session: 's1', chat: { cwd: '/repo', currentToolCalls: [] }, event: event('task_notification', {
    task_id: 'agent-1', tool_use_id: 'agent-tool', status: 'completed', result: 'agent output',
  }) },
  { type: 'advance', ms: 1500 },
]);

scenario('TaskOutput awaiting suppresses once and expires on the dedup TTL', [
  { type: 'await', session: 's1', input: { block: true, task_id: 'pulled' } },
  { type: 'event', session: 's1', chat: {}, event: event('task_notification', {
    task_id: 'pulled', status: 'completed', result: 'pulled output',
  }) },
  { type: 'advance', ms: 1500 },
  { type: 'advance', ms: 5 * 60 * 1000 },
  { type: 'event', session: 's1', chat: {}, event: event('task_notification', {
    task_id: 'pulled-again', status: 'completed', result: 'fresh',
  }) },
  { type: 'advance', ms: 1500 },
]);

scenario('Monitor watch: progress, terminal bookend, dedup, retirement', [
  { type: 'record', session: 's1', id: 'mon-tool' },
  { type: 'event', session: 's1', chat: monitorChat('mon-tool'), event: event('task_started', {
    task_id: 'mon-1', tool_use_id: 'mon-tool', session_id: 'native', description: 'watch the build',
  }) },
  { type: 'event', session: 's1', chat: {}, event: event('monitor_prompt', {
    task_id: 'mon-1', event_id: 'e1', output: 'first line',
  }) },
  { type: 'event', session: 's1', chat: {}, event: event('monitor_prompt', {
    task_id: 'mon-1', event_id: 'e2', output: 'noise\nsecond line\n', probe: true,
  }) },
  { type: 'write', file: '/out/monitor', content: 'DONE\n' },
  { type: 'event', session: 's1', chat: {}, event: event('task_notification', {
    task_id: 'mon-1', tool_use_id: 'mon-tool', output_file: '/out/monitor', status: 'completed', summary: 'stream ended',
  }) },
  { type: 'event', session: 's1', chat: {}, event: event('task_notification', {
    task_id: 'mon-1', tool_use_id: 'mon-tool', output_file: '/out/monitor', status: 'completed', summary: 'stream ended',
  }) },
  { type: 'event', session: 's1', chat: {}, event: event('monitor_prompt', {
    task_id: 'mon-1', event_id: 'terminal', status: 'completed',
  }) },
  { type: 'advance', ms: 1500 },
  { type: 'advance', ms: 5000 },
]);

scenario('Monitor duplicate event_id survives a watch reset', [
  { type: 'record', session: 's1', id: 'dup-tool' },
  { type: 'event', session: 's1', chat: monitorChat('dup-tool'), event: event('task_started', {
    task_id: 'dup-1', tool_use_id: 'dup-tool', session_id: 'native', description: 'watch',
  }) },
  { type: 'event', session: 's1', chat: {}, event: event('monitor_prompt', {
    task_id: 'dup-1', event_id: 'dup', status: 'completed', output: 'first',
  }) },
  // A fresh task_started replaces the watch and clears terminalQueued, but the
  // session-scoped event_id dedup outlives it: the same id must not re-inject.
  { type: 'event', session: 's1', chat: monitorChat('dup-tool'), event: event('task_started', {
    task_id: 'dup-1', tool_use_id: 'dup-tool', session_id: 'native', description: 'watch',
  }) },
  { type: 'event', session: 's1', chat: {}, event: event('monitor_prompt', {
    task_id: 'dup-1', event_id: 'dup', status: 'completed', output: 'second',
  }) },
  { type: 'advance', ms: 1500 },
]);

scenario('reap consumes the task origin so a late notification cannot claim the launch turn', [
  { type: 'record', session: 's1', id: 'orig-tool' },
  { type: 'event', session: 's1', chat: { ...bgChat('orig-tool'), _activeTurn: { turnId: 'T1' } }, event: event('task_started', {
    task_id: 'orig-1', tool_use_id: 'orig-tool', session_id: 'native', description: 'long build',
  }) },
  { type: 'reap', session: 's1', opts: { reason: 'stream_exit' } },
  { type: 'event', session: 's1', chat: {
    currentToolCalls: [{ id: 'orig-tool', name: 'Bash',
      input: { command: 'sleep 30', run_in_background: true }, result: 'launch stub' }],
    isStreaming: true, _activeTurn: { turnId: 'T1' },
  }, event: event('task_notification', {
    task_id: 'orig-1', tool_use_id: 'orig-tool', status: 'completed', result: 'done',
  }) },
  { type: 'advance', ms: 1500 },
]);

scenario('persistent Monitor stays owned until a hook reports the terminal event', [
  { type: 'record', session: 's1', id: 'p-tool' },
  { type: 'event', session: 's1', chat: monitorChat('p-tool', true), event: event('task_started', {
    task_id: 'p-1', tool_use_id: 'p-tool', session_id: 'native', description: 'persistent watch',
  }) },
  { type: 'advance', ms: 25 * 60 * 60 * 1000 },
  { type: 'event', session: 's1', chat: {}, event: event('monitor_prompt', {
    task_id: 'p-1', event_id: 'end', status: 'completed', output: 'last',
  }) },
  { type: 'advance', ms: 1500 },
  { type: 'reap', session: 's1', opts: {} },
]);

scenario('metadata lifecycle: parent fields, snapshots and stale runs', [
  { type: 'event', session: 's1', chat: { cwd: '/repo', currentToolCalls: [] }, event: event('task_started', {
    task_id: 'parent', description: '检查接口', subagent_type: 'Plan', run_id: '001', task_type: 'local_agent',
  }) },
  { type: 'event', session: 's1', chat: { cwd: '/repo', currentToolCalls: [] }, event: event('task_started', {
    task_id: 'child', description: '查找接口定义', parent_task_id: 'parent', parent_description: '检查接口',
    subagent_type: 'Explore', run_id: '002', task_type: 'local_agent',
  }) },
  { type: 'event', session: 's1', chat: {}, event: event('task_progress', {
    task_id: 'child', run_id: '001', status: 'running', description: 'stale progress',
  }) },
  { type: 'event', session: 's1', chat: {}, event: event('task_progress', {
    task_id: 'child', run_id: '002', status: 'error', description: 'still running', output: 'private-error',
  }) },
  { type: 'event', session: 's1', chat: {}, event: event('task_notification', {
    task_id: 'child', run_id: '002', status: 'completed',
  }) },
  { type: 'event', session: 's1', chat: {}, event: event('background_tasks_changed', {
    tasks: [
      { task_id: 'snap-child', description: '检查实现', parent_task_id: 'snap-parent', subagent_type: 'Explore', run_id: '010' },
      { task_id: 'snap-parent', description: '检查接口', run_id: '009' },
    ],
  }) },
  { type: 'reap', session: 's1', opts: { reason: 'stream_exit' } },
]);

scenario('stopForInsert drops buffered nudges and leaves a one-shot note', [
  { type: 'record', session: 's1', id: 'a-tool' },
  { type: 'record', session: 's1', id: 'b-tool' },
  { type: 'event', session: 's1', chat: bgChat('a-tool'), event: event('task_started', {
    task_id: 'a', tool_use_id: 'a-tool', session_id: 'native', description: 'long build',
  }) },
  { type: 'event', session: 's1', chat: bgChat('b-tool'), event: event('task_started', {
    task_id: 'b', tool_use_id: 'b-tool', session_id: 'native', description: 'short build',
  }) },
  { type: 'event', session: 's1', chat: {}, event: event('task_notification', {
    task_id: 'b', tool_use_id: 'b-tool', status: 'completed',
  }) },
  { type: 'stopForInsert', session: 's1' },
  // The stop already told the CLI to kill these tasks: their late notifications
  // are the native prompt's job, not a second nudge.
  { type: 'event', session: 's1', chat: {}, event: event('task_notification', {
    task_id: 'a', tool_use_id: 'a-tool', status: 'completed', result: 'late',
  }) },
  { type: 'advance', ms: 1500 },
  { type: 'note', session: 's1' },
  { type: 'note', session: 's1' },
]);

scenario('stopSession and stopAll cancel coalescing and clear every ledger', [
  { type: 'event', session: 's1', chat: bgChat('tool-1'), event: event('task_started', {
    task_id: 'tail-1', tool_use_id: 'tool-1', session_id: 'native', description: 'one',
  }) },
  { type: 'event', session: 's2', chat: bgChat('tool-2'), event: event('task_started', {
    task_id: 'tail-2', tool_use_id: 'tool-2', session_id: 'native', description: 'two',
  }) },
  { type: 'await', session: 's1', input: { block: true, task_id: 'old-await' } },
  { type: 'event', session: 's1', chat: {}, event: event('task_notification', {
    task_id: 'done', tool_use_id: 'missing-tool', status: 'completed', result: 'done',
  }) },
  { type: 'stopSession', session: 's1' },
  { type: 'stopAll' },
  { type: 'advance', ms: 1500 },
  { type: 'event', session: 's1', chat: {}, event: event('task_notification', {
    task_id: 'old-await', status: 'completed', result: 'after stop',
  }) },
  { type: 'advance', ms: 1500 },
]);

scenario('codex subtasks participate in liveness, snapshots and reap', [
  { type: 'event', session: 's1', chat: { cwd: '/repo', currentToolCalls: [] }, event: event('codex_task_started', {
    task_id: 'codex-agent:a', description: '检查代码', kind: 'agent',
  }) },
  { type: 'event', session: 's1', chat: { cwd: '/repo', currentToolCalls: [] }, event: event('codex_task_progress', {
    task_id: 'codex-agent:a', description: '检查路由', heartbeat: true,
  }) },
  { type: 'advance', ms: 1000 },
  { type: 'event', session: 's1', chat: { cwd: '/repo', currentToolCalls: [] }, event: event('codex_task_done', {
    task_id: 'codex-agent:a', description: '检查代码', status: 'completed',
  }) },
  { type: 'event', session: 's1', chat: { cwd: '/repo', currentToolCalls: [] }, event: event('codex_task_started', {
    task_id: 'codex-agent:a', description: '检查代码', kind: 'agent',
  }) },
  { type: 'reap', session: 's1', opts: { reason: 'process_exit' } },
  { type: 'reap', session: 's1', opts: { reason: 'process_exit' } },
]);

scenario('turn-result suppression for consumed and background tool results', [
  { type: 'record', session: 's1', id: 'done-tool' },
  { type: 'event', session: 's1', chat: {
    cwd: '/repo',
    currentToolCalls: [{ id: 'done-tool', name: 'Bash', input: { command: 'make build' }, result: 'ok' }],
  }, event: event('task_notification', {
    task_id: 'late', tool_use_id: 'done-tool', status: 'completed',
  }) },
  { type: 'record', session: 's1', id: 'bg-tool' },
  { type: 'event', session: 's1', chat: {
    cwd: '/repo', isStreaming: true, _activeTurn: { turnId: 'turn-bg' },
    currentToolCalls: [{
      id: 'bg-tool', name: 'Bash', input: { command: 'npm test', run_in_background: true },
      result: 'Command running in background with ID: bg-task.',
    }],
  }, event: event('task_started', { task_id: 'bg-task', tool_use_id: 'bg-tool', session_id: 'native' }) },
  { type: 'event', session: 's1', chat: {
    cwd: '/repo', isStreaming: true, _activeTurn: { turnId: 'turn-bg' },
    currentToolCalls: [{
      id: 'bg-tool', name: 'Bash', input: { command: 'npm test', run_in_background: true },
      result: 'Command running in background with ID: bg-task.',
    }],
  }, event: event('task_notification', { task_id: 'bg-task', tool_use_id: 'bg-tool', status: 'completed' }) },
  { type: 'advance', ms: 1500 },
]);

scenario('output snippets: report extraction, truncation and redaction', [
  { type: 'event', session: 's1', chat: {}, event: event('task_notification', {
    task_id: 'plain', status: 'failed', summary: 'compile failed', result: 'x'.repeat(30000),
  }) },
  { type: 'write', file: '/out/transcript', content: [
    JSON.stringify({ isSidechain: true, type: 'user', message: { role: 'user', content: 'research it' } }),
    JSON.stringify({ isSidechain: true, type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }),
    JSON.stringify({ isSidechain: true, type: 'assistant', message: { content: [{ type: 'text', text: 'FINAL REPORT' }] } }),
  ].join('\n') },
  { type: 'event', session: 's1', chat: {}, event: event('task_notification', {
    task_id: 'report', status: 'completed', output_file: '/out/transcript',
  }) },
  { type: 'write', file: '/out/secret', content: 'token pr1.c2Vzc2lvbi0x.cHJveHktcm91dGUtc2VjcmV0' },
  { type: 'event', session: 's1', chat: {}, event: event('task_notification', {
    task_id: 'secret', status: 'completed', output_file: '/out/secret',
  }) },
  { type: 'advance', ms: 1500 },
]);

scenario('background_tasks_changed DTO and unknown events', [
  { type: 'event', session: 's1', chat: {}, event: event('background_tasks_changed', {
    tasks: [{ id: 'a', status: 'running' }],
  }) },
  { type: 'event', session: 's1', chat: {}, event: event('unknown', {}) },
  { type: 'event', session: 's1', chat: {}, event: { subtype: 'background_tasks_changed', tasks: 'not-an-array' } },
]);

scenario('background_tasks_changed with no tasks retires live Monitor watches', [
  { type: 'record', session: 's1', id: 'mon-tool' },
  { type: 'event', session: 's1', chat: monitorChat('mon-tool'), event: event('task_started', {
    task_id: 'mon-empty', tool_use_id: 'mon-tool', session_id: 'native', description: 'watch',
  }) },
  // An empty list means nothing is live any more; the watch must be retired even
  // though `ids` is empty (the legacy loop ran for every watch regardless).
  { type: 'event', session: 's1', chat: {}, event: event('background_tasks_changed', { tasks: [] }) },
  // An absent `tasks` field is treated the same as [].
  { type: 'event', session: 's1', chat: {}, event: event('background_tasks_changed', {}) },
]);

scenario('a sync-bash completion consumes the one-shot foreground marker', [
  { type: 'event', session: 's1', chat: fgChat('sync-tool'), event: event('task_started', {
    task_id: 'sync-1', tool_use_id: 'sync-tool', session_id: 'native', description: 'make build',
  }) },
  // The completion classifies as sync-bash and consumes the marker.
  { type: 'event', session: 's1', chat: {}, event: event('task_notification', {
    task_id: 'sync-1', tool_use_id: 'sync-tool', status: 'completed', summary: 'built',
  }) },
  // A late progress only broadcasts background:true when the marker was consumed;
  // if the marker lingers, `background` stays false and this diverges.
  { type: 'event', session: 's1', chat: {}, event: event('task_progress', {
    task_id: 'sync-1', status: 'running', description: 'late progress',
  }) },
]);

// ── intentional divergence from the frozen oracle ────────────────────────────
// The legacy oracle compared run ids as raw strings, so a run "10" looked OLDER
// than "9" and its late event was dropped. The Rust port compares canonical
// non-negative decimal ids numerically (keeping the string rule for anything
// else), so this named scenario asserts the NEW behaviour on each side and keeps
// the difference explicit rather than hidden behind a skewed random generator.
// The random generator below only emits zero-padded `00X` ids so it can never
// straddle a digit-count boundary and reintroduce this divergence.
{
  const ops = [
    { type: 'event', session: 's1', chat: {}, event: event('task_started', {
      task_id: 'num', run_id: '9', description: 'run9',
    }) },
    { type: 'event', session: 's1', chat: {}, event: event('task_progress', {
      task_id: 'num', run_id: '10', description: 'run10',
    }) },
    // A run-less progress echoes the run id the ledger decided to keep.
    { type: 'event', session: 's1', chat: {}, event: event('task_progress', {
      task_id: 'num', status: 'running',
    }) },
  ];
  const legacyHarness = makeHarness('legacy');
  ops.forEach(op => applyOp(legacyHarness, op));
  const rustHarness = makeHarness('rust');
  ops.forEach(op => applyOp(rustHarness, op));
  assert.strictEqual(
    lastMonitorProgress(legacyHarness, 'num').run_id, '9',
    'legacy drops the "10" run as a stale string',
  );
  assert.strictEqual(
    lastMonitorProgress(rustHarness, 'num').run_id, '10',
    'rust accepts the newer numeric "10" run',
  );
  passed += 1;
  console.log('  ✓ intentional divergence: run_id "10" after "9" is accepted (numeric compare)');
}

// ── seeded randomized interleavings ──────────────────────────────────────────
function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TASK_IDS = ['t1', 't2', 't3'];
const TOOL_KINDS = ['bg', 'fg', 'mon', 'mon-persistent', 'agent', 'unknown'];
const STATUSES = [undefined, 'completed', 'failed', 'error', 'cancelled', 'stopped', 'busy'];

function randomizedScenario(seed, steps) {
  const random = mulberry32(seed);
  const pick = list => list[Math.floor(random() * list.length)];
  const chance = probability => random() < probability;
  let eventId = 0;
  const ops = [];
  for (let index = 0; index < steps; index += 1) {
    const roll = random();
    const session = chance(0.8) ? 's1' : 's2';
    const task = pick(TASK_IDS);
    const toolKind = pick(TOOL_KINDS);
    const toolId = `${toolKind}-tool-${task}`;
    if (roll < 0.16) {
      const chat = ['bg', 'unknown'].includes(toolKind) ? { cwd: '/repo', currentToolCalls: [], isStreaming: chance(0.2), _activeTurn: chance(0.5) ? { turnId: 'turn-1' } : null }
        : toolKind === 'fg' ? fgChat(toolId)
          : toolKind === 'agent' ? agentChat(toolId)
            : monitorChat(toolId, toolKind === 'mon-persistent');
      if (toolKind === 'unknown') chat.currentToolCalls = [];
      ops.push({ type: 'event', session, chat, event: event(chance(0.8) ? 'task_started' : 'codex_task_started', {
        task_id: task, ...(toolKind === 'unknown' ? { tool_use_id: toolId } : { tool_use_id: toolId }),
        description: `任务 ${task}`, ...(chance(0.7) ? { session_id: 'native' } : {}),
        // Equal-width zero-padded ids keep string and numeric ordering identical,
        // so this generator never straddles the intentional run-id divergence.
        ...(chance(0.3) ? { run_id: `00${Math.floor(random() * 3)}` } : {}),
        ...(toolKind.startsWith('mon') ? {} : {}),
      }) });
    } else if (roll < 0.30) {
      ops.push({ type: 'event', session, chat: {}, event: event('task_progress', {
        task_id: task, status: pick(STATUSES), description: `进度 ${task}`, output: `raw-${task}`,
      }) });
    } else if (roll < 0.50) {
      ops.push({ type: 'event', session, chat: chance(0.4) ? { cwd: '/repo', isStreaming: true, _activeTurn: { turnId: 'turn-2' }, currentToolCalls: [] } : {},
        event: event('task_notification', {
          task_id: task,
          ...(chance(0.7) ? { tool_use_id: toolId } : {}),
          status: pick(STATUSES),
          ...(chance(0.5) ? { description: `结果 ${task}` } : {}),
          ...(chance(0.5) ? { summary: `摘要 ${task}` } : {}),
          ...(chance(0.4) ? { result: `RESULT-${task}` } : {}),
          ...(chance(0.3) ? { output_file: `/out/${task}` } : {}),
        }) });
    } else if (roll < 0.58) {
      ops.push({ type: 'event', session, chat: chance(0.3) ? { isStreaming: true } : {},
        event: event('monitor_prompt', {
          task_id: task, event_id: `e${++eventId}`, status: pick(STATUSES), output: pick(['line one', 'noise\nline two\n', '']),
          ...(chance(0.3) ? { probe: true } : {}),
        }) });
    } else if (roll < 0.64) {
      ops.push({ type: 'event', session, chat: {}, event: event('background_tasks_changed', {
        tasks: [{ task_id: task, description: `快照 ${task}`, ...(chance(0.5) ? { parent_task_id: pick(TASK_IDS) } : {}) }],
      }) });
    } else if (roll < 0.68) {
      ops.push({ type: 'event', session, chat: {}, event: event(chance(0.5) ? 'codex_task_progress' : 'codex_task_done', {
        task_id: `codex-${task}`, description: `子任务 ${task}`, status: pick(STATUSES), ...(chance(0.5) ? { heartbeat: true } : {}),
      }) });
    } else if (roll < 0.74) {
      ops.push({ type: 'record', session, id: toolId });
    } else if (roll < 0.79) {
      ops.push({ type: 'await', session, input: { block: true, task_id: task } });
    } else if (roll < 0.88) {
      ops.push({ type: 'advance', ms: SHADOW_POLL_MS * (1 + Math.floor(random() * 4)) });
    } else if (roll < 0.94) {
      const file = chance(0.5) ? shadowFile(task) : `/out/${task}`;
      ops.push({ type: 'write', file, content: `line 1 ${task}\nline 2 ${task}\n` });
    } else if (roll < 0.96) {
      ops.push({ type: 'reap', session, opts: { reason: pick(['process_exit', 'stream_exit']) } });
    } else if (roll < 0.98) {
      ops.push({ type: 'stopForInsert', session });
    } else if (roll < 0.99) {
      ops.push({ type: 'note', session });
    } else {
      ops.push({ type: chance(0.7) ? 'stopSession' : 'stopAll', session });
    }
  }
  return ops;
}

for (let seed = 1; seed <= 8; seed += 1) {
  scenario(`randomized interleaving seed ${seed}`, randomizedScenario(seed, 60));
}

console.log(`\nbackground-task differential: ${passed} scenarios passed`);
