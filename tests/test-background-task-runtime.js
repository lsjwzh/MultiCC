'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { createBackgroundTaskRuntime } = require('../src/chat/background-task-runtime');
const bgCompletion = require('../src/bg-completion-coalescer');

function makeClock() {
  let time = 0;
  let sequence = 0;
  const timers = [];
  let unrefCount = 0;
  function setTimer(fn, delay) {
    const timer = {
      id: ++sequence,
      at: time + delay,
      fn,
      cleared: false,
      unref() { unrefCount += 1; },
    };
    timers.push(timer);
    return timer;
  }
  function clearTimer(timer) {
    if (timer) timer.cleared = true;
  }
  function advance(ms) {
    time += ms;
    for (;;) {
      const timer = timers
        .filter(item => !item.cleared && item.at <= time)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!timer) break;
      timer.cleared = true;
      timer.fn();
    }
  }
  return { now: () => time, setTimer, clearTimer, advance, get unrefCount() { return unrefCount; } };
}

function makeHarness(overrides = {}) {
  const clock = makeClock();
  const broadcasts = [];
  const observations = [];
  const notes = [];
  const injections = [];
  const processes = [];
  const files = new Map();
  const logs = [];
  function spawn(command, args, options) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.command = command;
    child.args = args;
    child.options = options;
    child.killed = false;
    child.kill = () => { child.killed = true; };
    processes.push(child);
    return child;
  }
  const dependencies = {
    broadcast: (sessionName, event) => broadcasts.push({ sessionName, event }),
    observeTask: observation => { observations.push(observation); },
    noteBgResultInjected: sessionName => notes.push(sessionName),
    deliverSystem: (sessionName, text, origin) => {
      injections.push({ sessionName, text, origin });
    },
    createCoalescer: bgCompletion.createCoalescer,
    buildNudge: bgCompletion.buildNudge,
    classifyCompletion: bgCompletion.classifyBgCompletion,
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
      warn: message => logs.push({ level: 'warn', message }),
      info: message => logs.push({ level: 'info', message }),
    },
    completionWindowMs: 100,
    ...overrides,
  };
  const runtime = createBackgroundTaskRuntime(dependencies);
  return { runtime, clock, broadcasts, observations, notes, injections, processes, files, logs, dependencies };
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓', name);
  } catch (error) {
    console.error('  ✗', name);
    throw error;
  }
}

(async () => {
  await test('constructor fails closed when a required host dependency is missing', () => {
    assert.throws(() => createBackgroundTaskRuntime({}), /broadcast is required/);
    const harness = makeHarness();
    const missing = { ...harness.dependencies };
    delete missing.observeTask;
    assert.throws(() => createBackgroundTaskRuntime(missing), /observeTask is required/);
  });

  await test('public API is narrow and frozen', () => {
    const { runtime } = makeHarness();
    assert.deepStrictEqual(Object.keys(runtime).sort(), [
      'backgroundSilenceMs', 'handleEvent', 'hasLiveBackgroundTasks', 'hasProcessBackgroundTasks', 'listActiveBackgroundTasks',
      'markTaskOutputAwaiting', 'reapSessionShadows', 'recordMainToolUseId',
      'stopAll', 'stopForInsert', 'stopSession', 'takeStoppedNote',
    ]);
    assert.strictEqual(Object.isFrozen(runtime), true);
  });

  await test('production host delegates events, dedup marks, teardown and shutdown', () => {
    const root = path.join(__dirname, '..');
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const source = fs.readFileSync(path.join(root, 'src/chat/background-task-runtime.js'), 'utf8');
    const turnEngine = fs.readFileSync(path.join(root, 'src/chat/turn-engine.js'), 'utf8');
    // shutdown/lifecycle 已抽到 src/host-lifecycle.js（bea1d0d），stopAll 的调用点
    // 随之迁移——按合并文本校验，与其他跨模块治理守卫一致。
    const lifecycle = fs.existsSync(path.join(root, 'src/host-lifecycle.js'))
      ? fs.readFileSync(path.join(root, 'src/host-lifecycle.js'), 'utf8') : '';
    assert.match(server, /createBackgroundTaskRuntime\s*\(\s*\{/);
    assert.match(turnEngine, /getBackgroundTaskRuntime\(\)\.handleEvent\(/);
    assert.match(turnEngine, /getBackgroundTaskRuntime\(\)\.markTaskOutputAwaiting\(/);
    assert.match(server, /backgroundTaskRuntime\.stopSession\(/);
    assert.match(server + lifecycle, /backgroundTaskRuntime\.stopAll\(/);
    assert.doesNotMatch(server, /function\s+(?:handleBackgroundTaskEvent|startMonitorShadow|stopMonitorShadow)\b/);
    assert.doesNotMatch(source, /require\(['"](?:fs|child_process|(?:\.\.\/)+server)/);
  });

  await test('task_started classifies foreground Bash and sub-agent tasks and records ledger facts', () => {
    const h = makeHarness();
    const foreground = h.runtime.handleEvent('s1', {
      cwd: '/repo',
      _activeTurn: { turnId: 'turn-fg' },
      currentToolCalls: [{ id: 'tool-fg', name: 'Bash', input: { command: 'echo hi' } }],
    }, {
      subtype: 'task_started', task_id: 'task-fg', tool_use_id: 'tool-fg',
      session_id: 'native', description: 'foreground',
    });
    const sidechain = h.runtime.handleEvent('s1', { cwd: '/repo', currentToolCalls: [] }, {
      subtype: 'task_started', task_id: 'task-agent', tool_use_id: 'agent-tool',
      session_id: 'native', description: 'agent work',
    });
    assert.strictEqual(foreground.kind, 'sync-bash');
    assert.strictEqual(sidechain.kind, 'agent-task');
    assert.deepStrictEqual(h.observations.map(item => item.detail.kind), ['sync-bash', 'agent-task']);
    assert.strictEqual(h.observations[0].detail.originTurnId, 'turn-fg');
    assert.strictEqual(h.observations[1].detail.originTurnId, null);
    assert.strictEqual(h.broadcasts[0].event.background, false);
    assert.strictEqual(h.broadcasts[0].event.command, 'echo hi');
    assert.strictEqual(h.broadcasts[1].event.background, true);
    assert.deepStrictEqual(h.processes[0].args, [
      '-n', '+1', '-F', '/private/tmp/claude-501/-real-repo/native/tasks/task-fg.output',
    ]);
  });

  await test('live-task tracking distinguishes background work from foreground sync Bash', () => {
    const h = makeHarness();
    // Foreground sync Bash: tagged as sync-bash, must NOT count as live background.
    h.runtime.handleEvent('s1', {
      cwd: '/repo',
      currentToolCalls: [{ id: 'tool-fg', name: 'Bash', input: { command: 'echo hi' } }],
    }, { subtype: 'task_started', task_id: 'task-fg', tool_use_id: 'tool-fg', session_id: 'native', description: 'fg' });
    assert.strictEqual(h.runtime.hasLiveBackgroundTasks('s1'), false, 'sync bash is not background');
    assert.deepStrictEqual(h.runtime.listActiveBackgroundTasks('s1'), []);
    // A real background task (run_in_background) does count.
    h.runtime.handleEvent('s1', {
      cwd: '/repo',
      currentToolCalls: [{ id: 'tool-bg', name: 'Bash', input: { run_in_background: true } }],
    }, { subtype: 'task_started', task_id: 'task-bg', tool_use_id: 'tool-bg', session_id: 'native', description: 'long build' });
    assert.strictEqual(h.runtime.hasLiveBackgroundTasks('s1'), true);
    const snapshot = h.runtime.listActiveBackgroundTasks('s1');
    assert.deepStrictEqual(snapshot, [{ id: 'task-bg', task_id: 'task-bg', description: 'long build' }]);
    assert.strictEqual(h.runtime.hasLiveBackgroundTasks('other-session'), false);
  });

  await test('background silence tracks the quietest gap a tail reports, and never invents one', () => {
    const h = makeHarness();
    assert.strictEqual(h.runtime.backgroundSilenceMs('s1'), 0, 'no background work at all is not silence');
    h.runtime.handleEvent('s1', {
      cwd: '/repo',
      currentToolCalls: [{ id: 'tool-bg', name: 'Bash', input: { run_in_background: true } }],
    }, { subtype: 'task_started', task_id: 'task-bg', tool_use_id: 'tool-bg', session_id: 'native', description: 'long build' });
    // A task that has never printed a line is indistinguishable from one that
    // died mid-line, so it reports unbounded silence rather than a young age.
    assert.strictEqual(h.runtime.backgroundSilenceMs('s1'), Infinity);
    h.clock.advance(6000);
    h.processes[0].stdout.emit('data', 'still building\n');
    h.clock.advance(2000);
    assert.strictEqual(h.runtime.backgroundSilenceMs('s1'), 2000, 'the last progress line starts the gap');
    assert.strictEqual(h.runtime.backgroundSilenceMs('other-session'), 0);
    // A persistent Monitor runs without a tail shadow: it cannot report progress,
    // so it must not be read as silent background work either.
    h.runtime.recordMainToolUseId('s2', 'persistent-mon-tool');
    h.runtime.handleEvent('s2', {
      cwd: '/repo',
      currentToolCalls: [{ id: 'persistent-mon-tool', name: 'Monitor', input: { pattern: 'DONE', persistent: true } }],
    }, { subtype: 'task_started', task_id: 'mon-task', tool_use_id: 'persistent-mon-tool', session_id: 'native', description: 'persistent progress' });
    h.clock.advance(600000);
    assert.strictEqual(h.runtime.backgroundSilenceMs('s2'), 0, 'no shadow means no silence signal');
  });

  await test('reapSessionShadows settles orphaned tasks with interrupted ledger + monitor_done, and is idempotent', () => {
    const h = makeHarness();
    h.runtime.handleEvent('s1', {
      cwd: '/repo',
      currentToolCalls: [{ id: 'tool-bg', name: 'Bash', input: { run_in_background: true } }],
    }, { subtype: 'task_started', task_id: 'task-bg', tool_use_id: 'tool-bg', session_id: 'native', description: 'long build' });
    h.broadcasts.length = 0;
    h.observations.length = 0;
    const reaped = h.runtime.reapSessionShadows('s1', { reason: 'stream_exit' });
    assert.strictEqual(reaped, 1);
    assert.strictEqual(h.processes[0].killed, true, 'shadow tail is killed');
    const done = h.broadcasts.find(b => b.event.type === 'monitor_done');
    assert.ok(done, 'a synthetic monitor_done is broadcast');
    assert.strictEqual(done.event.status, 'interrupted');
    assert.strictEqual(done.event.task_id, 'task-bg');
    assert.strictEqual(done.event.background, true);
    const ledger = h.observations.find(o => o.taskId === 'task-bg');
    assert.strictEqual(ledger.status, 'interrupted');
    // No live tasks remain, and a second reap is a no-op.
    assert.strictEqual(h.runtime.hasLiveBackgroundTasks('s1'), false);
    assert.strictEqual(h.runtime.reapSessionShadows('s1', { reason: 'stream_exit' }), 0);
  });

  await test('tail activity emits only a safe throttled progress description, never the raw line', () => {
    const h = makeHarness();
    h.runtime.handleEvent('s1', {
      cwd: '/repo',
      currentToolCalls: [{ id: 'tool-bg', name: 'Bash', input: { run_in_background: true } }],
    }, {
      subtype: 'task_started', task_id: 'task-bg', tool_use_id: 'tool-bg',
      session_id: 'native', description: 'build\nstep',
    });
    h.broadcasts.length = 0;
    h.processes[0].stdout.emit('data', 'SECRET RAW OUTPUT\n');
    h.processes[0].stdout.emit('data', 'SECOND SECRET\n');
    h.clock.advance(4999);
    h.processes[0].stdout.emit('data', 'THIRD SECRET\n');
    h.clock.advance(1);
    h.processes[0].stdout.emit('data', 'FOURTH SECRET\n');
    assert.strictEqual(h.broadcasts.length, 2, 'first signal and one after throttle window');
    assert.deepStrictEqual(h.broadcasts.map(item => item.event.description), ['build step', 'build step']);
    assert.ok(!JSON.stringify(h.broadcasts).includes('SECRET'), 'raw tail bytes never leave the runtime');
    assert.ok(h.broadcasts.every(item => item.event.type === 'monitor_progress'));
  });

  await test('task progress normalizes ledger status and keeps raw output out of the UI DTO', () => {
    const h = makeHarness();
    const cases = [
      ['completed', 'completed'], ['error', 'failed'], ['cancelled', 'interrupted'], ['busy', 'running'],
    ];
    for (const [raw, expected] of cases) {
      const result = h.runtime.handleEvent('s1', {}, {
        subtype: 'task_progress', task_id: `t-${raw}`, status: raw,
        description: 'still running', output: `private-${raw}`,
      });
      assert.strictEqual(result.status, expected);
    }
    assert.deepStrictEqual(h.observations.map(item => item.status), cases.map(item => item[1]));
    assert.ok(h.observations[1].detail.lastOutput.includes('private-error'), 'ledger retains the observed fact');
    assert.ok(!JSON.stringify(h.broadcasts).includes('private-'), 'progress DTO contains no raw output');
    assert.ok(h.broadcasts.every(item => item.event.description === 'still running'));
  });

  await test('completion suppression preserves TaskOutput then sync Bash then sidechain behavior', () => {
    const h = makeHarness();
    h.runtime.markTaskOutputAwaiting('s1', { block: true, task_id: 'pulled' });
    let result = h.runtime.handleEvent('s1', {}, {
      subtype: 'task_notification', task_id: 'pulled', status: 'completed',
    });
    assert.strictEqual(result.decision, 'taskoutput');

    h.runtime.handleEvent('s1', {
      cwd: '/repo', currentToolCalls: [{ id: 'fg', name: 'Bash', input: {} }],
    }, { subtype: 'task_started', task_id: 'sync', tool_use_id: 'fg', session_id: 'native' });
    result = h.runtime.handleEvent('s1', {}, {
      subtype: 'task_notification', task_id: 'sync', tool_use_id: 'fg', status: 'completed',
    });
    assert.strictEqual(result.decision, 'sync-bash');

    h.runtime.handleEvent('s1', { cwd: '/repo', currentToolCalls: [] }, {
      subtype: 'task_started', task_id: 'agent', tool_use_id: 'agent-tool', session_id: 'native',
    });
    result = h.runtime.handleEvent('s1', {}, {
      subtype: 'task_notification', task_id: 'agent', tool_use_id: 'agent-tool', status: 'completed',
    });
    assert.strictEqual(result.decision, 'sidechain');
    h.clock.advance(100);
    assert.strictEqual(h.notes.length, 0);
    assert.strictEqual(h.injections.length, 0);
  });

  await test('Monitor notifications use hook admission and never pin a writer shadow', () => {
    const h = makeHarness();
    h.files.set('/out/monitor', 'DONE\n');
    h.runtime.recordMainToolUseId('s1', 'mon-tool');
    const started = h.runtime.handleEvent('s1', {
      cwd: '/repo',
      currentToolCalls: [{ id: 'mon-tool', name: 'Monitor', input: { pattern: 'DONE', persistent: false } }],
    }, {
      subtype: 'task_started', task_id: 'mon-task', tool_use_id: 'mon-tool',
      session_id: 'native', description: '1688 image extraction pass progress',
    });
    assert.strictEqual(started.kind, 'monitor');
    assert.strictEqual(h.processes.length, 0, 'Monitor lifetime is separate from writer shadows');
    assert.strictEqual(h.runtime.hasProcessBackgroundTasks('s1'), true);
    h.broadcasts.length = 0;
    h.observations.length = 0;
    const result = h.runtime.handleEvent('s1', {}, {
      subtype: 'task_notification', task_id: 'mon-task', tool_use_id: 'mon-tool',
      output_file: '/out/monitor', status: 'completed', summary: 'stream ended',
    });
    assert.strictEqual(result.decision, 'monitor');
    assert.strictEqual(h.runtime.listActiveBackgroundTasks('s1').length, 0, 'completion retires the watch');
    const done = h.broadcasts.find(item => item.event.type === 'monitor_done');
    assert.ok(done, 'Monitor completion still closes the UI spinner');
    assert.strictEqual(done.event.task_id, 'mon-task');
    assert.strictEqual(done.event.output, 'DONE\n');
    assert.strictEqual(h.observations[0].status, 'completed');
    h.clock.advance(100);
    assert.strictEqual(h.notes.length, 1);
    assert.strictEqual(h.injections.length, 1);
    assert.match(h.injections[0].text, /DONE/);
    h.clock.advance(5000);
    assert.strictEqual(h.runtime.hasProcessBackgroundTasks('s1'), false);
  });

  await test('persistent Monitor retains the process and its hook owns notification delivery', () => {
    const h = makeHarness();
    h.files.set('/out/persistent-monitor', 'DONE\n');
    h.runtime.recordMainToolUseId('s1', 'persistent-mon-tool');
    const started = h.runtime.handleEvent('s1', {
      cwd: '/repo',
      currentToolCalls: [{ id: 'persistent-mon-tool', name: 'Monitor', input: { pattern: 'DONE', persistent: true } }],
    }, {
      subtype: 'task_started', task_id: 'persistent-mon-task', tool_use_id: 'persistent-mon-tool',
      session_id: 'native', description: 'persistent progress',
    });
    assert.strictEqual(started.kind, 'monitor-persistent');
    assert.strictEqual(h.processes.length, 0, 'persistent Monitor does not need the tail shadow fallback');
    assert.strictEqual(h.runtime.hasLiveBackgroundTasks('s1'), false);
    h.broadcasts.length = 0;
    h.observations.length = 0;
    const result = h.runtime.handleEvent('s1', {}, {
      subtype: 'task_notification', task_id: 'persistent-mon-task', tool_use_id: 'persistent-mon-tool',
      output_file: '/out/persistent-monitor', status: 'completed', summary: 'stream ended',
    });
    assert.strictEqual(result.decision, 'monitor');
    const done = h.broadcasts.find(item => item.event.type === 'monitor_done');
    assert.ok(done, 'persistent Monitor still emits monitor_done for any visible row');
    assert.strictEqual(done.event.output, 'DONE\n');
    assert.strictEqual(h.observations[0].status, 'completed');
    h.clock.advance(100);
    assert.strictEqual(h.notes.length, 1);
    assert.strictEqual(h.injections.length, 1);
    assert.match(h.injections[0].text, /DONE/);
    h.clock.advance(5000);
    assert.strictEqual(h.runtime.hasProcessBackgroundTasks('s1'), false);
  });

  await test('Monitor hooks deduplicate deliveries, preserve distinct events and respect session ownership', () => {
    const h = makeHarness();
    const state = { cwd: '/repo', currentToolCalls: [{ id: 'tool', name: 'Monitor', input: { persistent: true } }] };
    h.runtime.recordMainToolUseId('s1', 'tool');
    h.runtime.handleEvent('s1', state, { subtype: 'task_started', task_id: 'watch', tool_use_id: 'tool', session_id: 'native' });
    h.clock.advance(25 * 60 * 60 * 1000);
    assert.strictEqual(h.runtime.hasProcessBackgroundTasks('s1'), true, 'even day-long silence cannot kill a live Monitor');
    const event = { subtype: 'monitor_prompt', task_id: 'watch', event_id: 'event-1', output: 'first' };
    assert.strictEqual(h.runtime.handleEvent('s2', {}, event).handled, false);
    assert.strictEqual(h.runtime.handleEvent('s1', {}, event).decision, 'inject');
    assert.strictEqual(h.runtime.handleEvent('s1', {}, event).decision, 'duplicate');
    h.runtime.handleEvent('s1', {}, { ...event, event_id: 'event-2', output: 'second' });
    h.clock.advance(100);
    assert.strictEqual(h.injections.length, 1);
    assert.match(h.injections[0].text, /first[\s\S]*second/);
    assert.strictEqual(h.injections[0].origin.supersedeKey, 'monitor:watch', 'one Monitor keeps one queued report');
    h.files.set('/out/terminal', 'final');
    const completion = { subtype: 'task_notification', task_id: 'watch', status: 'completed', output_file: '/out/terminal' };
    h.runtime.handleEvent('s1', {}, completion);
    h.runtime.handleEvent('s1', {}, completion);
    h.runtime.handleEvent('s1', {}, { ...event, event_id: 'terminal', status: 'completed' });
    h.clock.advance(100);
    assert.strictEqual(h.injections.length, 2, 'terminal bookend and native hook produce only one delivery');
    assert.match(h.injections[1].text, /final/);
    assert.strictEqual(h.runtime.hasProcessBackgroundTasks('s1'), false);
    h.runtime.stopSession('s1');
    assert.strictEqual(h.runtime.handleEvent('s1', {}, event).handled, false);
  });

  await test('a process exit retires and reports active Monitor watches without leaking tails', () => {
    const h = makeHarness();
    h.runtime.handleEvent('s1', { currentToolCalls: [{ id: 'tool', name: 'Monitor', input: { persistent: true } }] },
      { subtype: 'task_started', task_id: 'watch', tool_use_id: 'tool', session_id: 'native' });
    assert.strictEqual(h.runtime.reapSessionShadows('s1'), 1);
    assert.strictEqual(h.runtime.hasProcessBackgroundTasks('s1'), false);
    assert.strictEqual(h.runtime.reapSessionShadows('s1'), 0);
    assert.strictEqual(h.processes.length, 0);
    assert.strictEqual(h.observations.at(-1).status, 'interrupted');
  });

  await test('unconsumed completions coalesce once with output tails and full origin metadata', () => {
    const h = makeHarness({ outputCap: 8 });
    h.files.set('/out/a', 'prefix-OUTPUT-A');
    h.files.set('/out/b', 'prefix-OUTPUT-B');
    h.runtime.recordMainToolUseId('s1', 'tool-a');
    h.runtime.recordMainToolUseId('s1', 'tool-b');
    for (const [task, tool, file] of [['task-a', 'tool-a', '/out/a'], ['task-b', 'tool-b', '/out/b']]) {
      const result = h.runtime.handleEvent('s1', {}, {
        subtype: 'task_notification', task_id: task, tool_use_id: tool,
        output_file: file, description: task, status: 'completed',
      });
      assert.strictEqual(result.decision, 'inject');
    }
    assert.deepStrictEqual(h.notes, ['s1', 's1']);
    assert.strictEqual(h.injections.length, 0, 'fixed window has not flushed yet');
    assert.strictEqual(h.clock.unrefCount, 1, 'coalescer timer is unrefed');
    h.clock.advance(100);
    assert.strictEqual(h.injections.length, 1);
    assert.deepStrictEqual(h.injections[0].origin, {
      bgTaskIds: ['task-a', 'task-b'],
      bgToolUseIds: ['tool-a', 'tool-b'],
    });
    assert.ok(h.injections[0].text.includes('OUTPUT-A'));
    assert.ok(h.injections[0].text.includes('OUTPUT-B'));
  });

  await test('completion ledger and monitor_done preserve the bounded final result DTO', () => {
    const h = makeHarness({ outputCap: 5 });
    h.files.set('/out/fail', '0123456789');
    h.runtime.recordMainToolUseId('s1', 'main-tool');
    h.runtime.handleEvent('s1', {}, {
      subtype: 'task_notification', task_id: 'failed-task', tool_use_id: 'main-tool',
      output_file: '/out/fail', status: 'failed', summary: 'compile failed',
    });
    const ledger = h.observations[0];
    const done = h.broadcasts.find(item => item.event.type === 'monitor_done').event;
    assert.strictEqual(ledger.status, 'failed');
    assert.strictEqual(ledger.detail.lastOutput, '56789');
    assert.strictEqual(ledger.detail.error, 'compile failed');
    assert.strictEqual(done.output, '56789');
    assert.strictEqual(done.background, true);
  });

  await test('background progress, output files, ledger and wake-up nudges scrub route capabilities', () => {
    const h = makeHarness();
    const capability = 'pr1.c2Vzc2lvbi0x.cHJveHktcm91dGUtc2VjcmV0';
    h.runtime.handleEvent('s1', {}, {
      subtype: 'task_progress', task_id: 'secret-task', status: 'running',
      output: `env ${capability}`,
    });
    h.files.set('/out/secret', `result ${capability}`);
    h.runtime.recordMainToolUseId('s1', 'main-secret-tool');
    const result = h.runtime.handleEvent('s1', {}, {
      subtype: 'task_notification', task_id: 'secret-task',
      tool_use_id: 'main-secret-tool', output_file: '/out/secret', status: 'completed',
    });
    assert.strictEqual(result.decision, 'inject');
    h.clock.advance(100);
    const publicState = JSON.stringify({
      observations: h.observations, broadcasts: h.broadcasts, injections: h.injections,
    });
    assert.doesNotMatch(publicState, /pr1\./);
    assert.match(publicState, /REDACTED_PROVIDER_ROUTE/);
  });

  await test('background_tasks_changed preserves its established DTO', () => {
    const h = makeHarness();
    const tasks = [{ id: 'a', status: 'running' }];
    assert.deepStrictEqual(h.runtime.handleEvent('s1', {}, {
      subtype: 'background_tasks_changed', tasks,
    }), { handled: true });
    assert.deepStrictEqual(h.broadcasts[0], {
      sessionName: 's1', event: { type: 'background_tasks', tasks },
    });
    assert.deepStrictEqual(h.runtime.handleEvent('s1', {}, { subtype: 'unknown' }), { handled: false });
  });

  await test('stopSession and stopAll kill tails, cancel coalescing, and clear dedup ledgers', () => {
    const h = makeHarness();
    function start(sessionName, taskId, toolId) {
      h.runtime.handleEvent(sessionName, {
        cwd: '/repo', currentToolCalls: [{ id: toolId, name: 'Bash', input: { run_in_background: true } }],
      }, { subtype: 'task_started', task_id: taskId, tool_use_id: toolId, session_id: 'native' });
    }
    start('s1', 'tail-1', 'tool-1');
    start('s2', 'tail-2', 'tool-2');
    h.runtime.recordMainToolUseId('s1', 'done-tool');
    h.runtime.handleEvent('s1', {}, {
      subtype: 'task_notification', task_id: 'done', tool_use_id: 'done-tool', status: 'completed',
    });
    h.runtime.markTaskOutputAwaiting('s1', { block: true, task_id: 'old-await' });
    assert.strictEqual(h.runtime.stopSession('s1'), 1);
    assert.strictEqual(h.processes[0].killed, true);
    assert.strictEqual(h.runtime.stopAll(), 1);
    assert.strictEqual(h.processes[1].killed, true);
    h.clock.advance(100);
    assert.strictEqual(h.injections.length, 0, 'shutdown canceled the buffered completion');

    // If the awaiting ledger leaked across stopSession this would suppress.
    const result = h.runtime.handleEvent('s1', {}, {
      subtype: 'task_notification', task_id: 'old-await', status: 'completed',
    });
    assert.strictEqual(result.decision, 'inject');
    h.clock.advance(100);
    assert.strictEqual(h.injections.length, 1);
  });

  await test('long sync Bash keeps its sync classification past the dedup TTL', () => {
    const h = makeHarness();
    h.runtime.handleEvent('s1', {
      cwd: '/repo',
      currentToolCalls: [{ id: 'fg-long', name: 'Bash', input: { command: 'sleep 320', timeout: 600000 } }],
    }, { subtype: 'task_started', task_id: 'long-sync', tool_use_id: 'fg-long', session_id: 'native' });
    h.clock.advance(10 * 60 * 1000);
    const result = h.runtime.handleEvent('s1', { cwd: '/repo', currentToolCalls: [] }, {
      subtype: 'task_notification', task_id: 'long-sync', tool_use_id: 'fg-long', status: 'completed',
    });
    assert.strictEqual(result.decision, 'sync-bash');
    h.clock.advance(100);
    assert.strictEqual(h.notes.length, 0);
    assert.strictEqual(h.injections.length, 0, 'a ten-minute sync command must not inject a silent nudge');
  });

  await test('completion whose tool result the turn already consumed is suppressed as turn-result', () => {
    const h = makeHarness();
    h.runtime.recordMainToolUseId('s1', 'done-tool');
    const result = h.runtime.handleEvent('s1', {
      cwd: '/repo',
      currentToolCalls: [{ id: 'done-tool', name: 'Bash', input: { command: 'make build' }, result: 'ok', is_error: false }],
    }, { subtype: 'task_notification', task_id: 'late-notice', tool_use_id: 'done-tool', status: 'completed' });
    assert.strictEqual(result.decision, 'turn-result');
    h.clock.advance(100);
    assert.strictEqual(h.notes.length, 0);
    assert.strictEqual(h.injections.length, 0);
  });

  await test('run_in_background completion is suppressed when its origin turn already consumed the tool result', () => {
    const h = makeHarness();
    h.runtime.recordMainToolUseId('s1', 'bg-tool');
    const state = {
      cwd: '/repo',
      isStreaming: true,
      _activeTurn: { turnId: 'turn-bg' },
      currentToolCalls: [{
        id: 'bg-tool', name: 'Bash',
        input: { command: 'npm test', run_in_background: true },
        result: 'Command running in background with ID: bg-task.',
      }],
    };
    h.runtime.handleEvent('s1', state, {
      subtype: 'task_started', task_id: 'bg-task', tool_use_id: 'bg-tool', session_id: 'native',
    });
    const result = h.runtime.handleEvent('s1', state, {
      subtype: 'task_notification', task_id: 'bg-task', tool_use_id: 'bg-tool', status: 'completed',
    });
    assert.strictEqual(result.decision, 'turn-result');
    h.clock.advance(100);
    assert.strictEqual(h.injections.length, 0, 'same-turn completion must not create a redundant wake-up');
    assert.strictEqual(h.observations[0].detail.originTurnId, 'turn-bg');
    assert.strictEqual(h.observations[1].detail.originTurnId, 'turn-bg');
  });

  await test('run_in_background completion after its origin turn still injects a wake-up', () => {
    const h = makeHarness();
    h.runtime.recordMainToolUseId('s1', 'bg-tool');
    const originState = {
      cwd: '/repo', isStreaming: true, _activeTurn: { turnId: 'turn-bg' },
      currentToolCalls: [{
        id: 'bg-tool', name: 'Bash', input: { run_in_background: true },
        result: 'Command running in background with ID: bg-task.',
      }],
    };
    h.runtime.handleEvent('s1', originState, {
      subtype: 'task_started', task_id: 'bg-task', tool_use_id: 'bg-tool', session_id: 'native',
    });
    const result = h.runtime.handleEvent('s1', {
      ...originState, isStreaming: false,
    }, {
      subtype: 'task_notification', task_id: 'bg-task', tool_use_id: 'bg-tool', status: 'completed',
    });
    assert.strictEqual(result.decision, 'inject');
    h.clock.advance(100);
    assert.strictEqual(h.injections.length, 1, 'post-turn completion must still wake the session');
  });

  await test('run_in_background completion in a newer active turn does not borrow the old tool result', () => {
    const h = makeHarness();
    h.runtime.recordMainToolUseId('s1', 'bg-tool');
    const originState = {
      cwd: '/repo', isStreaming: true, _activeTurn: { turnId: 'turn-old' },
      currentToolCalls: [{
        id: 'bg-tool', name: 'Bash', input: { run_in_background: true },
        result: 'Command running in background with ID: bg-task.',
      }],
    };
    h.runtime.handleEvent('s1', originState, {
      subtype: 'task_started', task_id: 'bg-task', tool_use_id: 'bg-tool', session_id: 'native',
    });
    const result = h.runtime.handleEvent('s1', {
      ...originState, _activeTurn: { turnId: 'turn-new' },
    }, {
      subtype: 'task_notification', task_id: 'bg-task', tool_use_id: 'bg-tool', status: 'completed',
    });
    assert.strictEqual(result.decision, 'inject');
    h.clock.advance(100);
    assert.strictEqual(h.injections.length, 1);
  });

  await test('TaskOutput awaiting mark still expires on the short dedup TTL', () => {
    const h = makeHarness();
    h.runtime.markTaskOutputAwaiting('s1', { block: true, task_id: 'stale-pull' });
    h.clock.advance(5 * 60 * 1000 + 1);
    const result = h.runtime.handleEvent('s1', {}, {
      subtype: 'task_notification', task_id: 'stale-pull', status: 'completed',
    });
    assert.strictEqual(result.decision, 'inject');
  });

  await test('a native notification for a main-thread background task never doubles the host delivery', () => {
    const bgState = turnId => ({ cwd: '/repo', isStreaming: false, _activeTurn: turnId ? { turnId } : null,
      currentToolCalls: [{ id: 'bg-tool', name: 'Bash', input: { command: 'sleep 8', run_in_background: true } }] });
    const prompt = { subtype: 'monitor_prompt', task_id: 'bg', tool_use_id: 'bg-tool', status: 'completed',
      summary: 'Background command completed', output_file: '/out/bg' };
    const completion = { subtype: 'task_notification', task_id: 'bg', tool_use_id: 'bg-tool', status: 'completed', output_file: '/out/bg' };

    // Completion first (the order a resident CLI emits): host queues, hook swallows the native query.
    let h = makeHarness();
    h.files.set('/out/bg', 'BGDONE');
    h.runtime.recordMainToolUseId('s1', 'bg-tool');
    h.runtime.handleEvent('s1', bgState('turn-1'), { subtype: 'task_started', task_id: 'bg', tool_use_id: 'bg-tool', session_id: 'native' });
    assert.strictEqual(h.runtime.handleEvent('s1', bgState(), completion).decision, 'inject');
    assert.strictEqual(h.runtime.handleEvent('s1', bgState(), { ...prompt, probe: true }).monitorOwned, true);
    assert.strictEqual(h.runtime.handleEvent('s1', bgState(), prompt).decision, 'duplicate');
    h.clock.advance(100);
    assert.strictEqual(h.injections.length, 1);
    assert.match(h.injections[0].text, /BGDONE/);

    // Hook first: the host delivers from the hook and the later bookend does not repeat it.
    h = makeHarness();
    h.files.set('/out/bg', 'BGDONE');
    h.runtime.recordMainToolUseId('s1', 'bg-tool');
    h.runtime.handleEvent('s1', bgState('turn-1'), { subtype: 'task_started', task_id: 'bg', tool_use_id: 'bg-tool', session_id: 'native' });
    assert.strictEqual(h.runtime.handleEvent('s1', bgState(), prompt).decision, 'inject');
    assert.strictEqual(h.runtime.handleEvent('s1', bgState(), completion).decision, 'native-prompt');
    h.clock.advance(100);
    assert.strictEqual(h.injections.length, 1);
    assert.match(h.injections[0].text, /BGDONE/);

    // The originating turn is still streaming: the CLI hands the result over in-turn.
    h = makeHarness();
    h.runtime.recordMainToolUseId('s1', 'bg-tool');
    h.runtime.handleEvent('s1', bgState('turn-1'), { subtype: 'task_started', task_id: 'bg', tool_use_id: 'bg-tool', session_id: 'native' });
    const live = { ...bgState('turn-1'), isStreaming: true };
    assert.strictEqual(h.runtime.handleEvent('s1', live, { ...prompt, probe: true }).handled, false);

    // Tasks the host never saw started (sub-agent side chains, other sessions) pass through.
    assert.strictEqual(h.runtime.handleEvent('s1', bgState(), { ...prompt, task_id: 'unknown', probe: true }).handled, false);
    assert.strictEqual(h.runtime.handleEvent('s2', bgState(), { ...prompt, probe: true }).handled, false);
  });

  await test('insert-now drops pending completions and leaves a one-shot note for the next turn', () => {
    const h = makeHarness();
    const state = { cwd: '/repo', _activeTurn: { turnId: 'turn-1' },
      currentToolCalls: [
        { id: 'a-tool', name: 'Bash', input: { command: 'sleep 60', run_in_background: true } },
        { id: 'b-tool', name: 'Bash', input: { command: 'sleep 1', run_in_background: true } },
      ] };
    h.runtime.recordMainToolUseId('s1', 'a-tool');
    h.runtime.recordMainToolUseId('s1', 'b-tool');
    h.runtime.handleEvent('s1', state, { subtype: 'task_started', task_id: 'a', tool_use_id: 'a-tool', description: 'long build', session_id: 'native' });
    h.runtime.handleEvent('s1', state, { subtype: 'task_started', task_id: 'b', tool_use_id: 'b-tool', session_id: 'native' });
    h.runtime.handleEvent('s1', { ...state, _activeTurn: null }, { subtype: 'task_notification', task_id: 'b', tool_use_id: 'b-tool', status: 'completed' });
    assert.strictEqual(h.runtime.stopForInsert('s1'), 1);
    h.clock.advance(100);
    assert.strictEqual(h.injections.length, 0, 'a buffered completion must not wake the session behind the inserted turn');
    assert.strictEqual(h.runtime.handleEvent('s1', {}, { subtype: 'monitor_prompt', task_id: 'a', status: 'killed' }).decision, 'duplicate');
    const note = h.runtime.takeStoppedNote('s1');
    assert.match(note, /a: long build/);
    assert.strictEqual(h.runtime.takeStoppedNote('s1'), '');
    assert.strictEqual(h.runtime.stopForInsert('idle'), 0);
    assert.strictEqual(h.runtime.takeStoppedNote('idle'), '');
  });

  console.log(`\n${passed} background-task runtime tests passed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
