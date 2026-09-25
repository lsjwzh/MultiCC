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

async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Monitor notification did not complete');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const lane of ['sdk', 'legacy']) test(`real ${lane} Monitor reports only its end through host admission, with no idle inference`, { timeout: 30000 }, async t => {
  const attempts = createProviderAttemptRuntime({ runtimeEpoch: `monitor-${lane}` });
  let attempt, admitted = false, turns = 0, queued = Promise.resolve();
  const requests = [], rejected = [], injections = [], results = [], errors = [], decisions = [];
  const f = await sdkFixture(t, ({ index }) => index === 1 ? {
    type: 'tool_use', id: 'monitor-tool', name: 'Monitor', input: {
      description: 'isolated Monitor admission', persistent: true,
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
    cfg = { cwd: f.cwd, sessionId, idleMs: 30, monitorAdmission: true,
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
  await send('Start the isolated Monitor');
  assert.equal(background.hasLiveBackgroundTasks('monitor'), false, 'no old turn lease is pinned');
  assert.equal(background.hasProcessBackgroundTasks('monitor'), true);
  const pid = stream.status('monitor').pid;
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(stream.status('monitor').pid, pid, 'active Monitor survives repeated idle windows');
  await assert.rejects(stream.claimWorkspace('sibling', workspace), { code: 'workspace_busy' });
  fs.writeFileSync(path.join(f.cwd, 'monitor-event'), 'event');
  // A progress event stays inside the resident process: the native self-wake
  // is blocked and no host turn is queued for it.
  await until(() => decisions.includes('progress'));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(injections, [], 'progress never becomes a queued 🔇 turn');
  assert.deepEqual(rejected, [], 'no native Monitor inference ran outside admission');
  assert.equal(stream.status('monitor').pid, pid);
  fs.writeFileSync(path.join(f.cwd, 'monitor-stop'), 'stop');
  await until(() => errors.length || (results.length >= 2 && !background.hasProcessBackgroundTasks('monitor')));
  await queued;
  assert.deepEqual(errors, []);
  assert.deepEqual(rejected, []);
  assert.equal(stream.status('monitor').pid, pid, 'the terminal report reuses the original native process');
  assert.equal(injections.length, 1, 'the terminal bookend is the one report');
  assert.ok(injections.some(text => /MONITOR_LINE_B/.test(text)));
  assert.deepEqual(requests, ['monitor-turn-1', 'monitor-turn-1', 'monitor-turn-2']);
});

for (const lane of ['sdk', 'legacy']) test(`real ${lane} Monitor progress during a live turn reaches that turn natively`, { timeout: 30000 }, async t => {
  const seen = [], injections = [], hooks = [], shown = [];
  const f = await sdkFixture(t, ({ index, input }) => {
    // The command text also contains the marker; only a delivered event counts.
    seen[index] = JSON.stringify(input.messages).split("printf 'MONITOR_LINE_A").join('').includes('<event>MONITOR_LINE_A</event>');
    if (index === 1) return { type: 'tool_use', id: 'monitor-tool', name: 'Monitor', input: {
      description: 'in-turn Monitor', persistent: true,
      command: "while [ ! -f monitor-event ]; do sleep 0.02; done; printf 'MONITOR_LINE_A\\n'; while [ ! -f monitor-stop ]; do sleep 0.02; done" } };
    if (index === 2) return { type: 'tool_use', id: 'bash-tool', name: 'Bash', input: {
      command: 'touch monitor-event; sleep 3; echo slept', description: 'let the Monitor report' } };
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
  assert.deepEqual(seen.slice(1), [false, false, true], 'the running turn sees the Monitor event');
  assert.deepEqual(injections, [], 'no queued 🔇 duplicate');
  assert.ok(hooks.every(verdict => verdict.handled === false));
  assert.deepEqual(shown, ['in-turn Monitor · MONITOR_LINE_A'], 'the page shows the event line once');
});
