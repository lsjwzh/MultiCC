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
const coalescing = require('../src/bg-completion-coalescer');
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

test('background hold releases after quiet, waits out a busy self-wake at the cap, and keeps failures out of the answer', async () => {
  const { createBackgroundHold } = require('../src/chat/background-hold');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const main = { type: 'result', subtype: 'success', is_error: false, result: 'first', usage: { input_tokens: 1 } };
  const wake = (result, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result,
    origin: { kind: 'task-notification' }, usage: { input_tokens: 9 }, ...extra });
  let active = true;
  const released = [];
  const hold = createBackgroundHold({ hasBackground: () => active, release: r => released.push(r), quietMs: 40, tickMs: 10, maxMs: 10000 });
  assert.equal(hold.start({ ...main, is_error: true }), false, 'only a successful answer is held');
  assert.equal(hold.start(main), true);
  assert.equal(hold.observe({ type: 'assistant' }), false, 'self-wake output streams into the turn');
  assert.equal(hold.observe(wake('second')), true, 'self-wake results stay internal');
  assert.equal(hold.observe(wake('boom', { subtype: 'error_during_execution', is_error: true })), true);
  await wait(80);
  assert.deepEqual(released, [], 'held while background work runs');
  active = false;
  await wait(100);
  assert.equal(released.length, 1);
  assert.equal(released[0].result, 'second', 'the last successful self-wake answer wins');
  assert.equal(released[0].origin, undefined, 'the main result identity is kept');
  assert.deepEqual(released[0].usage, { input_tokens: 9 });

  const capped = [];
  const busy = createBackgroundHold({ hasBackground: () => true, release: r => capped.push(r), quietMs: 10, tickMs: 10, maxMs: 30 });
  assert.equal(busy.start(main), true);
  busy.observe({ type: 'system', subtype: 'init' });
  await wait(80);
  assert.deepEqual(capped, [], 'the cap does not cut a running self-wake query');
  busy.observe(wake('late'));
  await wait(20);
  assert.equal(capped[0]?.result, 'late');

  const idle = createBackgroundHold({ hasBackground: () => false, release() { throw new Error('not held'); } });
  assert.equal(idle.start(main), false, 'nothing to hold without background work');
});

async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Monitor notification did not complete');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const lane of ['sdk', 'legacy']) test(`real ${lane} Monitor holds its turn open: events and end stream into that turn, never a 🔇`, { timeout: 30000 }, async t => {
  const attempts = createProviderAttemptRuntime({ runtimeEpoch: `monitor-${lane}` });
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
  const stream = lane === 'sdk' ? createStreamRouter({}, createSdkStream()) : require('../src/chat/chat-stream');
  const workspace = { id: `monitor-${lane}`, path: f.cwd };
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
    createCoalescer: coalescing.createCoalescer, buildNudge: coalescing.buildNudge,
    classifyCompletion: coalescing.classifyBgCompletion,
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
      cli: lane === 'sdk' ? 'claude-exp' : 'claude', providerId: 'test-provider',
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
      ...(lane === 'sdk' ? { sdkOptions: { model: 'claude-sonnet-4-6' } } : {
        cmd: path.join(path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), '..',
          `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude'),
        baseArgs: ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
          '--dangerously-skip-permissions', '--model', 'claude-sonnet-4-6'],
      }),
    };
    stream.ensure('monitor', cfg);
    try {
      const response = await stream.send('monitor', text, event => {
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

for (const lane of ['sdk', 'legacy']) test(`real ${lane} Monitor progress during a live turn reaches that turn natively`, { timeout: 30000 }, async t => {
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
  const stream = lane === 'sdk' ? createStreamRouter({}, createSdkStream()) : require('../src/chat/chat-stream');
  const state = { cwd: f.cwd, currentToolCalls: [], isStreaming: true, _activeTurn: { turnId: 'turn-1' } };
  const background = createBackgroundTaskRuntime({
    broadcast: (id, event) => { if (event.type === 'monitor_progress') shown.push(event.description); },
    observeTask() {}, noteBgResultInjected() {},
    deliverSystem: (id, text) => { injections.push(text); },
    createCoalescer: coalescing.createCoalescer, buildNudge: coalescing.buildNudge,
    classifyCompletion: coalescing.classifyBgCompletion,
    spawn() { throw new Error('Monitor must not create a writer shadow'); },
    readFile: fs.readFileSync, realpath: fs.realpathSync, tmpdir: () => f.root,
    getuid: () => process.getuid?.() || 0, now: Date.now,
    setTimer: setTimeout, clearTimer: clearTimeout, completionWindowMs: 30,
  });
  await stream.claimWorkspace('inturn', { id: `inturn-${lane}`, path: f.cwd });
  stream.ensure('inturn', { cwd: f.cwd, sessionId: randomUUID(), idleMs: 30000, monitorAdmission: true, env: { ...f.env },
    backgroundHold: { quietMs: 300 },
    onBackgroundEvent: event => {
      const verdict = background.handleEvent('inturn', state, event);
      if (event.subtype === 'monitor_prompt' && !event.probe) hooks.push(verdict);
      return verdict;
    },
    isBackgroundActive: () => background.hasProcessBackgroundTasks('inturn'),
    ...(lane === 'sdk' ? { sdkOptions: { model: 'claude-sonnet-4-6' } } : {
      cmd: path.join(path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), '..',
        `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude'),
      baseArgs: ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--dangerously-skip-permissions', '--model', 'claude-sonnet-4-6'] }) });
  f.teardown.tasks.push(async () => {
    fs.writeFileSync(path.join(f.cwd, 'monitor-stop'), 'stop');
    try { await stream.closeAndWait('inturn'); } finally { background.stopAll(); }
  });
  await stream.send('inturn', 'Start the in-turn Monitor', event => {
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
async function residentSession(t, lane, reply, backgroundHold = { quietMs: 300 }) {
  const injections = [], decisions = [], main = [];
  const f = await sdkFixture(t, args => {
    const first = JSON.stringify(args.input.messages[0]?.content || '');
    if (first.includes('SUBAGENT_JOB')) return reply.sub?.(args);
    main.push(JSON.stringify(args.input.messages));
    return reply.main(main.length, main.at(-1));
  });
  const stream = lane === 'sdk' ? createStreamRouter({}, createSdkStream()) : require('../src/chat/chat-stream');
  const name = `resident-${lane}-${randomUUID().slice(0, 8)}`;
  const state = { cwd: f.cwd, currentToolCalls: [], isStreaming: false };
  const background = createBackgroundTaskRuntime({
    broadcast() {}, observeTask() {}, noteBgResultInjected() {},
    deliverSystem: (id, text) => { injections.push(text); },
    createCoalescer: coalescing.createCoalescer, buildNudge: coalescing.buildNudge,
    classifyCompletion: coalescing.classifyBgCompletion,
    spawn: require('node:child_process').spawn,
    readFile: fs.readFileSync, realpath: fs.realpathSync, tmpdir: () => f.root,
    getuid: () => process.getuid?.() || 0, now: Date.now,
    setTimer: setTimeout, clearTimer: clearTimeout, completionWindowMs: 30,
  });
  await stream.claimWorkspace(name, { id: name, path: f.cwd });
  stream.ensure(name, { cwd: f.cwd, sessionId: randomUUID(), idleMs: 30000, monitorAdmission: true, env: { ...f.env },
    backgroundHold, onExit: () => background.reapSessionShadows(name),
    onBackgroundEvent: event => {
      const verdict = background.handleEvent(name, state, event);
      if (!event.probe && ['monitor_prompt', 'task_notification'].includes(event.subtype)) {
        decisions.push(`${event.subtype}:${verdict.decision || (verdict.handled ? 'handled' : 'native')}`);
      }
      return verdict;
    },
    isBackgroundActive: () => background.hasProcessBackgroundTasks(name),
    ...(lane === 'sdk' ? { sdkOptions: { model: 'claude-sonnet-4-6' } } : {
      cmd: path.join(path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), '..',
        `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude'),
      baseArgs: ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--dangerously-skip-permissions', '--model', 'claude-sonnet-4-6'] }) });
  f.teardown.tasks.push(async () => {
    for (const file of ['bg-go', 'agent-go']) fs.writeFileSync(path.join(f.cwd, file), 'go');
    try { await stream.closeAndWait(name); } finally { background.stopAll(); }
  });
  let turns = 0;
  async function turn(text) {
    state.isStreaming = true;
    state._activeTurn = { turnId: `turn-${++turns}` };
    try {
      return await stream.send(name, text, event => {
        if (event.type !== 'assistant' || event.parent_tool_use_id) return;
        for (const block of event.message?.content || []) if (block.type === 'tool_use') {
          state.currentToolCalls.push(block); background.recordMainToolUseId(name, block.id);
        }
      });
    } finally { state.isStreaming = false; }
  }
  return { f, stream, name, background, turn, injections, decisions, main, go: file => fs.writeFileSync(path.join(f.cwd, file), 'go') };
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

for (const lane of ['sdk', 'legacy']) test(`real ${lane} background Bash finishing after its answer continues that same turn`, { timeout: 40000 }, async t => {
  const s = await residentSession(t, lane, { main: n => n === 1 ? slowBash : null });
  const turn = s.turn('Start the background job');
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

for (const lane of ['sdk', 'legacy']) test(`real ${lane} background Agent finishing after its answer continues that same turn with its report`, { timeout: 40000 }, async t => {
  const s = await residentSession(t, lane, { main: n => n === 1 ? backgroundAgent : null, sub: subagentReply });
  const turn = s.turn('Research in the background');
  assert.equal(await settled(turn), false, 'the answer is held while the agent runs');
  assert.equal(s.main.length, 2);
  s.go('agent-go');
  await turn;
  assert.equal(s.main.length, 3, `one native self-wake, inside the turn (${s.decisions.join(', ')})`);
  assert.match(s.main[2], /AGENT_FINAL_REPORT[\s\S]*END_OF_REPORT/);
  assert.deepEqual(s.injections, [], 'no 🔇 for a report the turn received');
});

for (const lane of ['sdk', 'legacy']) test(`real ${lane} background work outliving the hold cap falls back to one 🔇 wake-up`, { timeout: 40000 }, async t => {
  const s = await residentSession(t, lane, { main: n => n === 1 ? slowBash : null }, { quietMs: 300, maxMs: 600 });
  await s.turn('Start the background job');
  assert.equal(s.main.length, 2);
  s.go('bg-go');
  const deadline = Date.now() + 15000;
  while (!s.injections.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(s.injections.length, 1, `one wake-up (${s.decisions.join(', ')})`);
  assert.match(s.injections[0], /slow background job/);
  assert.equal(s.main.length, 2, 'the native self-wake never ran outside admission');
});

for (const lane of ['sdk', 'legacy']) test(`real ${lane} cancelling a held turn keeps its answer and stops the background work`, { timeout: 40000 }, async t => {
  const s = await residentSession(t, lane, { main: n => n === 1 ? slowBash : null });
  const turn = s.turn('Start the background job');
  assert.equal(await settled(turn), false);
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

for (const lane of ['sdk', 'legacy']) test(`real ${lane} background Agent finishing inside its turn reaches that turn natively`, { timeout: 40000 }, async t => {
  const s = await residentSession(t, lane, { main: n => n === 1 ? backgroundAgent
    : n === 2 ? { type: 'tool_use', id: 'fg-tool', name: 'Bash', input: {
      command: 'touch agent-go; sleep 4; echo slept', description: 'wait for the agent' } }
      : null, sub: subagentReply });
  await s.turn('Research and wait');
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.ok(s.main.some(messages => messages.includes('AGENT_FINAL_REPORT')), `the turn receives the report (${s.decisions.join(', ')})`);
  assert.deepEqual(s.injections, [], 'no 🔇 for a report the turn received');
});
