'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createSdkStream } = require('../src/chat/claude-sdk-stream');
const { createStreamRouter } = require('../src/chat/stream-router');
const { createBackgroundTaskRuntime } = require('../src/chat/background-task-runtime');
const { createProviderAttemptRuntime } = require('../src/chat/provider-attempt-runtime');
const { createSessionDelivery } = require('../src/session/delivery');
const sdkFixture = require('./helpers/claude-sdk-fixture');
const { createMonitorAdmission, isMonitorHandoffResult } = require('../src/chat/monitor-admission');

test('Monitor hook only captures known native notifications and never captures submitted user text', async () => {
  const seen = [];
  const prompt = '<task-notification>\n<task-id>watch</task-id><event>&lt;event&gt; &amp; data</event></task-notification>';
  const hook = createMonitorAdmission(event => { seen.push(event); return { monitorOwned: event.task_id === 'watch' }; },
    value => value === 'owned-prompt');
  const input = { hook_event_name: 'UserPromptSubmit', prompt, prompt_id: 'one' };
  assert.deepEqual(await hook({ ...input, source: 'sdk' }), {});
  assert.deepEqual(await hook({ ...input, source: 'user' }), {});
  assert.deepEqual(await hook({ ...input, prompt: 'owned-prompt' }), {});
  assert.deepEqual(await hook({ ...input, prompt: '<task-notification><task-id>unknown</task-id></task-notification>' }), {});
  const result = await hook(input);
  assert.equal(result.decision, 'block');
  assert.equal(seen.at(-1).output, '<event> & data');
  assert.equal(isMonitorHandoffResult({ type: 'result', num_turns: 0, origin: { kind: 'task-notification' }, result: result.reason }), true);
  assert.equal(isMonitorHandoffResult({ type: 'result', num_turns: 1, result: result.reason }), false);
  seen.length = 0;
  assert.equal((await hook({ ...input, prompt: `${prompt}\n${prompt}` })).decision, 'block');
  assert.equal(seen.filter(event => !event.probe).length, 2, 'a native batch preserves every event');
  assert.notEqual(seen.filter(event => !event.probe)[0].event_id, seen.filter(event => !event.probe)[1].event_id);
  seen.length = 0;
  assert.deepEqual(await hook({ ...input, prompt: `${prompt}\n${prompt.replace('watch', 'unknown')}` }), {});
  assert.equal(seen.filter(event => !event.probe).length, 0, 'a mixed batch must not partially duplicate delivery');
});

test('background hold releases after quiet, keeps holding past the cap while background work is alive, and lets the last self-wake decide the outcome', async () => {
  const { createBackgroundHold } = require('../src/chat/background-hold');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const main = { type: 'result', subtype: 'success', is_error: false, result: 'first', usage: { input_tokens: 1 } };
  const wake = (result, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result,
    origin: { kind: 'task-notification' }, usage: { input_tokens: 9 }, ...extra });
  const failure = (result, extra = {}) => wake(result, { subtype: 'error_during_execution', is_error: true, ...extra });
  let active = true;
  const released = [];
  const hold = createBackgroundHold({ hasBackground: () => active, release: r => released.push(r), quietMs: 40, tickMs: 10, maxMs: 10000 });
  assert.equal(hold.start({ ...main, is_error: true }), false, 'only a successful answer is held');
  assert.equal(hold.start(main), true);
  assert.equal(hold.observe({ type: 'assistant' }), false, 'self-wake output streams into the turn');
  assert.equal(hold.observe(wake('second')), true, 'self-wake results stay internal');
  assert.equal(hold.observe(failure('boom', { terminal_reason: 'api_error', api_error_status: 429 })), true);
  await wait(80);
  assert.deepEqual(released, [], 'held while background work runs');
  active = false;
  await wait(100);
  assert.equal(released.length, 1);
  // "The last upstream request of the turn decides": the failure after the
  // success is what the user saw last, so the released turn must be a failure.
  assert.equal(released[0].result, 'boom', 'the last self-wake answer wins even when it failed');
  assert.equal(released[0].is_error, true);
  assert.equal(released[0].terminal_reason, 'api_error');
  assert.equal(released[0].api_error_status, 429);
  assert.equal(released[0].background_wake_failed, true);
  assert.equal(released[0].origin, undefined, 'the main result identity is kept');
  assert.equal(released[0].parent_tool_use_id, undefined, 'the main result identity is kept');
  assert.deepEqual(released[0].usage, { input_tokens: 9 });

  // Reverse order: a success after the failure supersedes it.
  const recovered = [];
  const reverse = createBackgroundHold({ hasBackground: () => true, release: r => recovered.push(r), quietMs: 20, tickMs: 10, maxMs: 10000 });
  assert.equal(reverse.start(main), true);
  assert.equal(reverse.observe(failure('wake-429')), true);
  assert.equal(reverse.observe(wake('recovered')), true);
  active = true;
  reverse.flush();
  assert.equal(recovered[0].result, 'recovered');
  assert.notEqual(recovered[0].is_error, true);
  assert.equal(recovered[0].background_wake_failed, undefined);

  // A cancelled self-wake carries no upstream verdict and changes nothing.
  const ignored = [];
  const cancelling = createBackgroundHold({ hasBackground: () => true, release: r => ignored.push(r), quietMs: 20, tickMs: 10, maxMs: 10000 });
  assert.equal(cancelling.start(main), true);
  assert.equal(cancelling.observe(wake('kept')), true);
  assert.equal(cancelling.observe(failure('interrupted', { terminal_reason: 'interrupted' })), true);
  cancelling.flush();
  assert.equal(ignored[0].result, 'kept', 'cancel/abort/interrupt does not replace the tracked outcome');
  assert.notEqual(ignored[0].is_error, true);

  const capped = [], capNotices = [];
  let busyActive = true;
  const busy = createBackgroundHold({ hasBackground: () => busyActive, release: r => capped.push(r),
    quietMs: 10, tickMs: 10, maxMs: 30, onCapReached: ms => capNotices.push(ms) });
  assert.equal(busy.start(main), true);
  busy.observe({ type: 'system', subtype: 'init' });
  await wait(80);
  assert.deepEqual(capped, [], 'the cap does not cut a running self-wake query');
  busy.observe(wake('late'));
  await wait(80);
  assert.deepEqual(capped, [], 'the cap does not release while the background work is alive');
  assert.deepEqual(capNotices, [30], 'the cap says so out loud exactly once');
  // Background work is part of the turn: it ends when that work ends.
  busyActive = false;
  await wait(80);
  assert.equal(capped[0]?.result, 'late');

  const idle = createBackgroundHold({ hasBackground: () => false, release() { throw new Error('not held'); } });
  assert.equal(idle.start(main), false, 'nothing to hold without background work');
});

async function until(predicate, message = 'Monitor notification did not complete', timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// Every `real …` test drives a spawned CLI child. Its first request reaches the
// fake upstream well after `send` returns, and how long that takes is the
// machine's problem, not the contract's: on a loaded host the child needs more
// than the 500ms `settled` window just to boot, so probing the hold before the
// child has said anything reads an empty transcript and fails a turn that is
// in fact held correctly. Wait for the child's own output first, then ask
// whether the turn settled — the hold is then observed, not raced.
async function untilRequests(s, count) {
  // 启动真实 CLI 并跑完首个工具需要独立预算，不能复用通知传输的 10 秒窗口。
  try {
    await until(() => {
      if (s.turnError) throw s.turnError;
      return s.main.length >= count;
    }, `the CLI child never issued ${count} main requests`, 20000);
  } catch (error) {
    error.message += `; received=${s.main.length}, alive=${s.stream.isAlive(s.name)}, events=${JSON.stringify(s.recentEvents)}`;
    throw error;
  }
}

test(`real sdk Monitor holds its turn open: events and end stream into that turn, never a 🔇`, { timeout: 30000 }, async t => {
  const attempts = createProviderAttemptRuntime({ runtimeEpoch: 'monitor' });
  let attempt, admitted = false, turns = 0, queued = Promise.resolve();
  const requests = [], rejected = [], injections = [], results = [], errors = [], decisions = [];
  const f = await sdkFixture(t, ({ index }) => index === 1 ? {
    type: 'tool_use', id: 'monitor-tool', name: 'Monitor', input: {
      description: 'isolated Monitor admission', timeout_ms: 60000,
      command: "while [ ! -f monitor-event ]; do sleep 0.02; done; printf 'MONITOR_LINE_A\\n'; while [ ! -f monitor-stop ]; do sleep 0.02; done; printf 'MONITOR_LINE_B\\n'",
    },
  } : null, { authorize(req, res) {
    const capability = req.url.split('/')[3];
    const verdict = attempts.authorizeProxyRequest({ sessionId: capability, providerId: 'test-provider' });
    if (!admitted || !verdict.ok) {
      rejected.push(verdict); res.writeHead(409); res.end('{}'); return false;
    }
    if (/\/v1\/messages(?:\?|$)/.test(req.url)) requests.push(verdict.attempt.turnId);
    return true;
  } });
  // Enable the native tool only in this isolated test home. Production feature
  // flags and credentials are never changed or copied into the fixture.
  fs.writeFileSync(path.join(f.configDir, '.claude.json'), JSON.stringify({ cachedGrowthBookFeatures: {
    tengu_amber_sentinel: true, tengu_breezy_crescent: false,
  } }));
  f.env.CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF = '1';
  const stream = createStreamRouter({}, createSdkStream());
  const workspace = { id: 'monitor', path: f.cwd };
  const state = { cwd: f.cwd, currentToolCalls: [], isStreaming: false };
  const delivery = createSessionDelivery({ admit(id, text, metadata) {
    assert.equal(metadata.originContinue, true);
    injections.push(text);
    queued = queued.then(() => send(text)).catch(error => { errors.push(error); });
    return { ok: true };
  } });
  const background = createBackgroundTaskRuntime({
    broadcast() {}, observeTask() {}, noteBgResultInjected() {},
    deliverSystem: delivery.deliverSystem,
    spawn() { throw new Error('Monitor must not create a writer shadow'); },
    readFile: fs.readFileSync, realpath: fs.realpathSync, tmpdir: () => f.root,
    getuid: () => process.getuid?.() || 0, now: Date.now,
    setTimer: setTimeout, clearTimer: clearTimeout, completionWindowMs: 30,
  });
  const sessionId = randomUUID();
  const origin = f.env.ANTHROPIC_BASE_URL;
  let cfg;
  async function send(text) {
    await stream.claimWorkspace('monitor', workspace);
    admitted = true;
    state.isStreaming = true;
    state._activeTurn = { turnId: `monitor-turn-${++turns}` };
    attempt = attempts.beginAttempt({ sessionId: 'monitor', turnId: state._activeTurn.turnId,
      cli: 'claude', providerId: 'test-provider',
      providerRevision: 'test-revision', protocol: 'anthropic_messages', attemptNo: 1,
      model: 'claude-sonnet-4-6', spawnKey: 'stable-monitor-route' });
    cfg = { cwd: f.cwd, sessionId, idleMs: 30, monitorAdmission: true, backgroundHold: { quietMs: 300 },
      env: { ...f.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: 'isolated-route',
        ANTHROPIC_BASE_URL: `${origin}/claude-proxy/test-provider/${attempts.proxySessionId(attempt)}` },
      onBackgroundEvent: event => {
        const verdict = background.handleEvent('monitor', state, event);
        if (event.subtype === 'monitor_prompt' && !event.probe) decisions.push(verdict.decision);
        return verdict;
      },
      isBackgroundActive: () => background.hasProcessBackgroundTasks('monitor'),
      onExit: () => background.reapSessionShadows('monitor'),
      sdkOptions: { model: 'claude-sonnet-4-6' },
    };
    stream.ensure('monitor', cfg);
    try {
      const response = await stream.send('monitor', text, event => {
        event.acknowledge?.();
        if (event.type !== 'assistant' || event.parent_tool_use_id) return;
        for (const block of event.message?.content || []) if (block.type === 'tool_use') {
          state.currentToolCalls.push(block); background.recordMainToolUseId('monitor', block.id);
        }
      });
      const result = response.result?.type === 'result' ? response.result : response;
      assert.equal(result.is_error, false);
      assert.match(result.result, /^sdk-answer-/, 'a blocked native notification cannot complete the host turn');
      results.push(result.result);
    } finally {
      state.isStreaming = false; admitted = false;
      attempts.finishAttempt(attempt, { outcome: 'completed' });
      assert.equal(stream.parkWorkspace('monitor', workspace).parked, true);
    }
  }
  f.teardown.tasks.push(async () => {
    fs.writeFileSync(path.join(f.cwd, 'monitor-stop'), 'stop');
    try { await queued; await stream.closeAndWait('monitor'); } finally { background.stopAll(); }
  });
  const first = send('Start the isolated Monitor');
  await until(() => background.hasProcessBackgroundTasks('monitor'));
  const pid = stream.status('monitor').pid;
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(results, [], 'the main result is held while the Monitor runs');
  assert.equal(stream.status('monitor').busy, true);
  await assert.rejects(stream.claimWorkspace('sibling', workspace), { code: 'workspace_busy' });
  fs.writeFileSync(path.join(f.cwd, 'monitor-event'), 'event');
  // The progress event runs natively inside the held, admitted turn.
  await until(() => f.requests.some(input => JSON.stringify(input.messages).includes('<event>MONITOR_LINE_A</event>')));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(results, [], 'progress does not end the held turn');
  fs.writeFileSync(path.join(f.cwd, 'monitor-stop'), 'stop');
  await first;
  await queued;
  assert.deepEqual(errors, []);
  assert.deepEqual(rejected, [], 'no native Monitor inference ran outside admission');
  assert.deepEqual(injections, [], 'neither progress nor the end becomes a queued 🔇 turn');
  assert.deepEqual(decisions, []);
  assert.equal(results.length, 1, 'one host turn');
  assert.equal(results[0], `sdk-answer-${f.requests.length}`, 'the turn ends with the last self-wake answer');
  assert.ok(requests.length >= 3 && requests.every(id => id === 'monitor-turn-1'), requests.join(','));
  assert.equal(stream.status('monitor').pid, pid, 'the resident process is reused');
});

test(`real sdk Monitor progress during a live turn reaches that turn natively`, { timeout: 30000 }, async t => {
  const seen = [], injections = [], hooks = [], shown = [];
  const f = await sdkFixture(t, ({ index, input }) => {
    // The command text also contains the marker; only a delivered event counts.
    seen[index] = JSON.stringify(input.messages).split("printf 'MONITOR_LINE_A").join('').includes('<event>MONITOR_LINE_A</event>');
    if (index === 1) return { type: 'tool_use', id: 'monitor-tool', name: 'Monitor', input: {
      description: 'in-turn Monitor', timeout_ms: 60000,
      command: "while [ ! -f monitor-event ]; do sleep 0.02; done; printf 'MONITOR_LINE_A\\n'; while [ ! -f monitor-stop ]; do sleep 0.02; done" } };
    if (index === 2) return { type: 'tool_use', id: 'bash-tool', name: 'Bash', input: {
      command: 'touch monitor-event; sleep 3; touch monitor-stop; echo slept', description: 'let the Monitor report' } };
    return null;
  });
  fs.writeFileSync(path.join(f.configDir, '.claude.json'), JSON.stringify({ cachedGrowthBookFeatures: {
    tengu_amber_sentinel: true, tengu_breezy_crescent: false } }));
  f.env.CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF = '1';
  const stream = createStreamRouter({}, createSdkStream());
  const state = { cwd: f.cwd, currentToolCalls: [], isStreaming: true, _activeTurn: { turnId: 'turn-1' } };
  const background = createBackgroundTaskRuntime({
    broadcast: (id, event) => { if (event.type === 'monitor_progress') shown.push(event.description); },
    observeTask() {}, noteBgResultInjected() {},
    deliverSystem: (id, text) => { injections.push(text); },
    spawn() { throw new Error('Monitor must not create a writer shadow'); },
    readFile: fs.readFileSync, realpath: fs.realpathSync, tmpdir: () => f.root,
    getuid: () => process.getuid?.() || 0, now: Date.now,
    setTimer: setTimeout, clearTimer: clearTimeout, completionWindowMs: 30,
  });
  await stream.claimWorkspace('inturn', { id: 'inturn', path: f.cwd });
  stream.ensure('inturn', { cwd: f.cwd, sessionId: randomUUID(), idleMs: 30000, monitorAdmission: true, env: { ...f.env },
    backgroundHold: { quietMs: 300 },
    onBackgroundEvent: event => {
      const verdict = background.handleEvent('inturn', state, event);
      if (event.subtype === 'monitor_prompt' && !event.probe) hooks.push(verdict);
      return verdict;
    },
    isBackgroundActive: () => background.hasProcessBackgroundTasks('inturn'),
    sdkOptions: { model: 'claude-sonnet-4-6' } });
  f.teardown.tasks.push(async () => {
    fs.writeFileSync(path.join(f.cwd, 'monitor-stop'), 'stop');
    try { await stream.closeAndWait('inturn'); } finally { background.stopAll(); }
  });
  await stream.send('inturn', 'Start the in-turn Monitor', event => {
    event.acknowledge?.();
    if (event.type !== 'assistant' || event.parent_tool_use_id) return;
    for (const block of event.message?.content || []) if (block.type === 'tool_use') {
      state.currentToolCalls.push(block); background.recordMainToolUseId('inturn', block.id);
    }
  });
  state.isStreaming = false;
  assert.deepEqual(seen.slice(1, 4), [false, false, true], 'the running turn sees the Monitor event');
  assert.deepEqual(injections, [], 'no queued 🔇 duplicate');
  assert.ok(hooks.every(verdict => verdict.handled === false));
  assert.deepEqual(shown.filter(line => line.includes('MONITOR_LINE')), ['in-turn Monitor · MONITOR_LINE_A'],
    'the page shows the event line once');
});

// A resident session driven turn by turn against the fake upstream, with the
// production background runtime deciding every native notification.
async function residentSession(t, reply, backgroundHold = { quietMs: 300 }, managedRoute = false) {
  const injections = [], decisions = [], main = [], broadcasts = [];
  const recentEvents = [], assistantEvents = [];
  let turnError;
  const f = await sdkFixture(t, args => {
    const first = JSON.stringify(args.input.messages[0]?.content || '');
    if (first.includes('SUBAGENT_JOB')) return reply.sub?.(args);
    main.push(JSON.stringify(args.input.messages));
    return reply.main(main.length, main.at(-1));
  });
  const stream = createStreamRouter({}, createSdkStream());
  const name = `resident-${randomUUID().slice(0, 8)}`;
  const state = { cwd: f.cwd, currentToolCalls: [], isStreaming: false };
  const background = createBackgroundTaskRuntime({
    broadcast: (id, event) => broadcasts.push(event), observeTask() {}, noteBgResultInjected() {},
    deliverSystem: (id, text) => { injections.push(text); },
    spawn: require('node:child_process').spawn,
    readFile: fs.readFileSync, realpath: fs.realpathSync, tmpdir: () => f.root,
    getuid: () => process.getuid?.() || 0, now: Date.now,
    setTimer: setTimeout, clearTimer: clearTimeout, completionWindowMs: 30,
  });
  await stream.claimWorkspace(name, { id: name, path: f.cwd });
  // A managed route makes the SDK lane proxy every request through its relay.
  const env = managedRoute ? { ...f.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: 'isolated-route',
    ANTHROPIC_BASE_URL: `${f.env.ANTHROPIC_BASE_URL}/claude-proxy/test-provider/route` } : { ...f.env };
  stream.ensure(name, { cwd: f.cwd, sessionId: randomUUID(), idleMs: 30000, monitorAdmission: true, env,
    backgroundHold, onExit: () => background.reapSessionShadows(name),
    onBackgroundEvent: event => {
      const verdict = background.handleEvent(name, state, event);
      if (!event.probe && ['monitor_prompt', 'task_notification'].includes(event.subtype)) {
        decisions.push(`${event.subtype}:${verdict.decision || (verdict.handled ? 'handled' : 'native')}`);
      }
      return verdict;
    },
    isBackgroundActive: () => background.hasProcessBackgroundTasks(name),
    sdkOptions: { model: 'claude-sonnet-4-6' } });
  f.teardown.tasks.push(async () => {
    for (const file of ['bg-go', 'agent-go']) fs.writeFileSync(path.join(f.cwd, file), 'go');
    try { await stream.closeAndWait(name); } finally { background.stopAll(); }
  });
  let turns = 0;
  function turn(text) {
    turnError = undefined;
    state.isStreaming = true;
    state._activeTurn = { turnId: `turn-${++turns}` };
    const pending = (async () => {
      try {
        return await stream.send(name, text, event => {
          event.acknowledge?.();
          if (event.type === 'assistant') assistantEvents.push(event.message);
          recentEvents.push({ type: event.type, subtype: event.subtype,
            content: event.message?.content, error: event.error });
          if (recentEvents.length > 5) recentEvents.shift();
          if (event.type !== 'assistant' || event.parent_tool_use_id) return;
          for (const block of event.message?.content || []) if (block.type === 'tool_use') {
            state.currentToolCalls.push(block); background.recordMainToolUseId(name, block.id);
          }
        });
      } finally { state.isStreaming = false; }
    })();
    // 前置断言失败后 teardown 会取消尚未 await 的回合。先观察拒绝以免污染
    // 下一条用例；仍返回原始 Promise，调用方 await 时会收到原始失败。
    pending.catch(error => { turnError = error; });
    return pending;
  }
  return { f, stream, name, background, turn, injections, decisions, main, broadcasts, recentEvents, assistantEvents,
    get turnError() { return turnError; }, go: file => fs.writeFileSync(path.join(f.cwd, file), 'go') };
}

const backgroundAgent = { type: 'tool_use', id: 'agent-tool', name: 'Agent', input: {
  description: 'layout research', subagent_type: 'general-purpose', run_in_background: true,
  prompt: 'SUBAGENT_JOB: wait for agent-go, then report.' } };
const subagentReply = ({ input }) => JSON.stringify(input.messages).includes('AGENT_WORK')
  ? { type: 'text', text: `AGENT_FINAL_REPORT ${'detail '.repeat(600)}END_OF_REPORT` }
  : { type: 'tool_use', id: `sub-bash-${randomUUID().slice(0, 8)}`, name: 'Bash', input: {
    command: 'while [ ! -f agent-go ]; do sleep 0.02; done; echo AGENT_$((40+2))_WORK | sed s/_42_/_/', description: 'wait' } };

const slowBash = { type: 'tool_use', id: 'bg-tool', name: 'Bash', input: { run_in_background: true,
  command: 'while [ ! -f bg-go ]; do sleep 0.02; done; echo BG_$((40+2))', description: 'slow background job' } };
const settled = promise => Promise.race([promise.then(() => true, () => true),
  new Promise(resolve => setTimeout(resolve, 500, false))]);

test(`real sdk background Bash finishing after its answer continues that same turn`, { timeout: 40000 }, async t => {
  const s = await residentSession(t, { main: n => n === 1 ? slowBash : null });
  const turn = s.turn('Start the background job');
  await untilRequests(s, 2);
  assert.equal(await settled(turn), false, 'the answer is held while the job runs');
  assert.equal(s.main.length, 2);
  s.go('bg-go');
  const response = await turn;
  const result = response.type === 'result' ? response : response.result;
  assert.equal(s.main.length, 3, 'one native self-wake, inside the turn');
  assert.match(s.main[2], /<task-notification>[\s\S]*slow background job\\" completed/);
  assert.equal(result.result, 'sdk-answer-3', 'the turn ends with the self-wake answer');
  assert.deepEqual(s.injections, [], 'no 🔇 for a completion the turn received');
});

test(`real sdk background Agent finishing after its answer continues that same turn with its report`, { timeout: 40000 }, async t => {
  const s = await residentSession(t, { main: n => n === 1 ? backgroundAgent : null, sub: subagentReply });
  const turn = s.turn('Research in the background');
  await untilRequests(s, 2);
  const agent = s.broadcasts.find(event => event.type === 'monitor_started' && event.subagent_type === 'general-purpose');
  assert.ok(agent, '真实子助手开始事件带有类型');
  // `run_id` is an optional field a CLI may or may not emit; the real Claude
  // CLI / Agent SDK does not send it, so it stays undefined here (the runtime
  // passes it through only when present — see test-background-task-runtime.js
  // for the propagation contract). Assert the fields the CLI does provide.
  assert.equal(agent.task_type, 'local_agent');
  const snapshot = s.background.listActiveBackgroundTasks(s.name).find(task => task.task_id === agent.task_id);
  assert.equal(snapshot.run_id, agent.run_id, '重连快照与开始事件对 run_id 保持一致');
  assert.equal(snapshot.subagent_type, 'general-purpose');
  assert.equal(await settled(turn), false, 'the answer is held while the agent runs');
  assert.equal(s.main.length, 2);
  s.go('agent-go');
  await turn;
  const completed = s.broadcasts.find(event => event.type === 'monitor_done' && event.task_id === agent.task_id);
  assert.equal(completed.run_id, agent.run_id, '完成事件与开始事件对 run_id 保持一致');
  assert.equal(completed.subagent_type, 'general-purpose');
  assert.equal(s.main.length, 3, `one native self-wake, inside the turn (${s.decisions.join(', ')})`);
  assert.match(s.main[2], /AGENT_FINAL_REPORT[\s\S]*END_OF_REPORT/);
  assert.deepEqual(s.injections, [], 'no 🔇 for a report the turn received');
});

test(`real sdk a typed message is answered inside the turn a background Agent holds open`, { timeout: 40000 }, async t => {
  // The screenshot case: a background Agent (local_agent) owns the turn after
  // its answer, the human types, and the message must be answered INSIDE that
  // turn — never queued behind it with a "workspace occupied and no turn is
  // running" notice.
  const s = await residentSession(t, { main: n => (n === 1 ? backgroundAgent
    : n === 3 ? { type: 'text', text: 'ANSWER_TO_TYPED_AGENT' } : null), sub: subagentReply });
  const turn = s.turn('Research in the background');
  await untilRequests(s, 2);
  assert.equal(await settled(turn), false, 'the answer is held while the agent runs');
  const agent = s.broadcasts.find(event => event.type === 'monitor_started' && event.subagent_type === 'general-purpose');
  assert.ok(agent, 'a local_agent task is started and still alive');
  const injected = await s.stream.injectHeldTurn(s.name, 'TYPED_WHILE_AGENT', 'typed-while-agent');
  assert.equal(injected.delivered, true, 'the agent-held turn accepts the message');
  injected.acknowledgeHistory();
  await untilRequests(s, 3);
  assert.match(s.main[2], /TYPED_WHILE_AGENT/, 'the message reached the same resident process');
  await until(() => s.assistantEvents.some(event => Array.isArray(event.content)
    && event.content.some(block => block?.type === 'text' && block.text === 'ANSWER_TO_TYPED_AGENT')),
  'the injected answer did not stream into the agent-held turn');
  assert.equal(await settled(turn), false, 'the injected answer does not end the turn');
  s.go('agent-go');
  const response = await turn;
  const result = response.type === 'result' ? response : response.result;
  assert.equal(s.main.length, 4, 'the agent completion woke the same turn');
  assert.match(s.main[3], /AGENT_FINAL_REPORT/, 'the last request carries the agent report');
  assert.match(result.result, /^sdk-answer-\d+$/, 'the turn ends with the answer it received');
  assert.notEqual(result.result, 'ANSWER_TO_TYPED_AGENT', 'the injected answer is not the turn result');
  assert.deepEqual(s.injections, [], 'no queued 🔇 for anything this turn received');
});

test(`real sdk a message typed during the held phase runs inside that same turn`, { timeout: 40000 }, async t => {
  const s = await residentSession(t, { main: n => n === 1 ? slowBash : null });
  const turn = s.turn('Start the background job');
  await untilRequests(s, 2);
  assert.equal(await settled(turn), false, 'the answer is held while the job runs');
  // The human types while the turn is held: the same live process takes it.
  // The delivery identity is registered in Rust before the line is written, so
  // a retry can never run the same message twice.
  const injected = await s.stream.injectHeldTurn(s.name, 'TYPED_WHILE_HELD', 'typed-while-held');
  assert.equal(injected.delivered, true, 'the held turn accepts the message');
  injected.acknowledgeHistory();
  assert.equal(injected.identity, 'typed-while-held');
  await untilRequests(s, 3);
  assert.match(s.main[2], /TYPED_WHILE_HELD/, 'the message reached the same resident process');
  // Its answer streams into the turn (a normal assistant event), and neither
  // the answer nor the injected query ends the turn: the background job still
  // owns it.
  await until(() => s.assistantEvents.some(event => Array.isArray(event.content)
    && event.content.some(block => block?.type === 'text' && block.text === 'sdk-answer-3')),
  'the injected answer did not stream into the turn');
  assert.equal(await settled(turn), false, 'the injected answer does not end the turn');
  s.go('bg-go');
  const response = await turn;
  const result = response.type === 'result' ? response : response.result;
  assert.equal(s.main.length, 4, 'the background completion woke the same turn');
  assert.equal(result.result, 'sdk-answer-4', 'the turn ends with the last answer it received');
  assert.deepEqual(s.injections, [], 'no 🔇 for anything this turn received');
});

test(`real sdk background work outliving the hold cap keeps the turn open and the wake inside it`, { timeout: 40000 }, async t => {
  const s = await residentSession(t, { main: n => n === 1 ? slowBash : null }, { quietMs: 300, maxMs: 600 });
  const turn = s.turn('Start the background job');
  await untilRequests(s, 2);
  // The cap is a warning, not a release: past it the turn is still held and the
  // completion still runs natively inside it.
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(await settled(turn), false, `the cap does not end the turn (${s.decisions.join(', ')})`);
  assert.equal(s.main.length, 2);
  assert.deepEqual(s.injections, [], 'no queued 🔇 while the turn is held');
  s.go('bg-go');
  const response = await turn;
  const result = response.type === 'result' ? response : response.result;
  assert.equal(s.main.length, 3, 'the native self-wake runs inside the turn');
  assert.match(s.main[2], /slow background job/);
  assert.equal(result.result, 'sdk-answer-3', 'the turn ends with the self-wake answer');
  assert.deepEqual(s.injections, [], 'no 🔇 for a completion the turn received');
});

test('real sdk turn held past the cap with a background agent mid-request keeps its answer and the process', { timeout: 40000 }, async t => {
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const s = await residentSession(t, { main: n => n === 1 ? backgroundAgent : null,
    sub: async () => { await blocked; return { type: 'text', text: 'AGENT_FINAL_REPORT END_OF_REPORT' }; } },
  { quietMs: 300, maxMs: 600 }, true);
  t.after(() => unblock());
  const turn = s.turn('Research in the background');
  await untilRequests(s, 2);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(await settled(turn), false, 'the cap does not release a turn whose agent is still running');
  assert.equal(s.stream.isAlive(s.name), true, 'the process and its background agent survive');
  assert.equal(s.background.hasProcessBackgroundTasks(s.name), true);
  unblock();
  const response = await turn;
  const result = response.type === 'result' ? response : response.result;
  assert.equal(result.is_error, false, 'the relay still carrying the agent request does not fail the finished turn');
  assert.match(result.result, /^sdk-answer-/);
  assert.equal(s.main.length, 3, 'the agent report woke the same turn');
});

test(`real sdk cancelling a held turn keeps its answer and stops the background work`, { timeout: 40000 }, async t => {
  const s = await residentSession(t, { main: n => n === 1 ? slowBash : null });
  const turn = s.turn('Start the background job');
  await untilRequests(s, 2);
  assert.equal(await settled(turn), false, 'the answer is held while the job runs');
  s.stream.cancel(s.name);
  const response = await turn;
  assert.equal((response.type === 'result' ? response : response.result).result, 'sdk-answer-2', 'the held answer completes the turn');
  const deadline = Date.now() + 5000;
  while (s.stream.isAlive(s.name) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(s.stream.isAlive(s.name), false, 'the resident process and its background job are stopped');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(s.background.hasProcessBackgroundTasks(s.name), false);
  assert.deepEqual(s.injections, [], 'a cancelled job never wakes the session');
});

test(`real sdk background Agent finishing inside its turn reaches that turn natively`, { timeout: 40000 }, async t => {
  const s = await residentSession(t, { main: n => n === 1 ? backgroundAgent
    : n === 2 ? { type: 'tool_use', id: 'fg-tool', name: 'Bash', input: {
      command: 'touch agent-go; sleep 4; echo slept', description: 'wait for the agent' } }
      : null, sub: subagentReply });
  await s.turn('Research and wait');
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.ok(s.main.some(messages => messages.includes('AGENT_FINAL_REPORT')), `the turn receives the report (${s.decisions.join(', ')})`);
  assert.deepEqual(s.injections, [], 'no 🔇 for a report the turn received');
});
