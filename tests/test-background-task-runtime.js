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
      'handleEvent', 'hasLiveBackgroundTasks', 'listActiveBackgroundTasks',
      'markTaskOutputAwaiting', 'reapSessionShadows', 'recordMainToolUseId',
      'stopAll', 'stopSession',
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

  await test('non-persistent Monitor keeps the shadow fallback without injecting a silent nudge', () => {
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
    assert.strictEqual(h.processes.length, 1, 'non-persistent Monitor still gets a tail shadow fallback');
    h.broadcasts.length = 0;
    h.observations.length = 0;
    const result = h.runtime.handleEvent('s1', {}, {
      subtype: 'task_notification', task_id: 'mon-task', tool_use_id: 'mon-tool',
      output_file: '/out/monitor', status: 'completed', summary: 'stream ended',
    });
    assert.strictEqual(result.decision, 'monitor');
    assert.strictEqual(h.processes[0].killed, true, 'completion stops the fallback shadow');
    const done = h.broadcasts.find(item => item.event.type === 'monitor_done');
    assert.ok(done, 'Monitor completion still closes the UI spinner');
    assert.strictEqual(done.event.task_id, 'mon-task');
    assert.strictEqual(done.event.output, 'DONE\n');
    assert.strictEqual(h.observations[0].status, 'completed');
    h.clock.advance(100);
    assert.strictEqual(h.notes.length, 0);
    assert.strictEqual(h.injections.length, 0);
  });

  await test('persistent Monitor behaves like an already-consumed wait and starts no shadow', () => {
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
    assert.strictEqual(h.notes.length, 0);
    assert.strictEqual(h.injections.length, 0);
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

  await test('run_in_background completion still injects despite the launch-ack result in the turn', () => {
    const h = makeHarness();
    h.runtime.recordMainToolUseId('s1', 'bg-tool');
    const result = h.runtime.handleEvent('s1', {
      cwd: '/repo',
      currentToolCalls: [{
        id: 'bg-tool', name: 'Bash',
        input: { command: 'npm test', run_in_background: true },
        result: 'started background task bg-task',
      }],
    }, { subtype: 'task_notification', task_id: 'bg-task', tool_use_id: 'bg-tool', status: 'completed' });
    assert.strictEqual(result.decision, 'inject');
    h.clock.advance(100);
    assert.strictEqual(h.injections.length, 1, 'genuine background results keep flowing');
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

  console.log(`\n${passed} background-task runtime tests passed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
