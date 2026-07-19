'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  SUPPORTED_CHAT_CLIS,
  ensureCliStates,
  rememberActiveCliState,
  activateCliState,
  stateSummary,
  buildHandoffCheckpoint,
} = require('../src/cli-switch');
const { cliHandoffSummary, createCliSwitchRuntime } = require('../src/cli/switch-runtime');

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function createHarness(overrides = {}) {
  const session = overrides.session || {
    id: 's1', dirId: 'd1', kind: 'chat', cli: 'claude', label: 'Demo',
    branch: 'multicc/s1', cliSessionId: 'claude-native', model: 'claude-model',
    effort: 'high', provider: 'claude-provider', subagent: null, agent: 'reviewer',
  };
  ensureCliStates(session, 100);
  const records = overrides.records || new Map([['s1', session]]);
  const chat = overrides.chat === false ? null : {
    cli: 'claude', chatTurnCount: 4, isStreaming: false, claudeProc: null,
    lineBuf: 'partial', currentAssistantText: 'partial', currentToolCalls: [{ id: 1 }],
    currentCost: 1, streamReplay: ['event'], _adapterError: 'old',
    _activeRunner: { id: 'runner' }, _activeTurn: { id: 'turn' },
    _continuationLineage: { id: 'lineage' }, _resultSaved: true, _sawApiError: true,
  };
  const chatSessions = new Map(chat ? [['s1', chat]] : []);
  const effects = [];
  const streamState = overrides.streamState || null;
  const stream = {
    status: id => { effects.push(`stream-status:${id}`); return streamState; },
    close: id => effects.push(`stream-close:${id}`),
  };
  const runtime = createCliSwitchRuntime({
    records,
    chatSessions,
    sessionPersistence: overrides.sessionPersistence || {
      mutate(source, fn) { effects.push(`mutate:${source}`); return fn(records); },
    },
    supportedClis: SUPPORTED_CHAT_CLIS,
    getProviderDefaults: () => ({ codex: 'codex-default', claude: 'claude-default' }),
    codexDefaultReasoningLevel: () => 'xhigh',
    getHistory: id => [{ role: 'user', content: `history:${id}`, ts: 90 }],
    buildHandoffCheckpoint,
    activateCliState,
    rememberActiveCliState,
    ensureCliStates,
    cliStateSummary: stateSummary,
    gitWorktreeSnapshot: overrides.gitWorktreeSnapshot || (async () => ({
      branch: 'multicc/s1', head: 'abc123', changes: ['M file.js'],
    })),
    cwdForSession: () => '/tmp/worktree',
    getChatStream: () => stream,
    cancelClassify: () => effects.push('cancel-classify'),
    assignKillReason: (_runner, reason) => effects.push(`kill-reason:${reason}`),
    appendMessage: (_id, message) => effects.push(`message:${message.cliSwitch.handoffId}`),
    appendEvent: (_dirId, type) => effects.push(`event:${type}`),
    chatBroadcast: (_id, event) => effects.push(`chat:${event.type}`),
    workspaceBroadcast: (_dirId, event) => effects.push(`workspace:${event.type}`),
    saveBestEffort: source => effects.push(`save:${source}`),
    cliAvailabilitySummary: () => overrides.availability || {
      claude: { available: true }, codex: { available: true },
      opencode: { available: true }, zcode: { available: true },
    },
    sessionProviderName: value => value.provider ? `name:${value.provider}` : null,
    effectiveSessionModel: value => value.model || 'effective-default',
    effectiveSessionEffort: value => value.effort || 'effective-default',
    serializeSubagent: value => value,
    clock: () => 1000,
    handoffIdFactory: () => 'handoff_fixed',
  });
  const app = {
    route: null,
    post(route, handler) { this.route = { route, handler }; },
  };
  runtime.mountRoutes(app, handler => handler);
  async function invoke({ id = 's1', body = {} } = {}) {
    const res = createResponse();
    await app.route.handler({ params: { id }, body }, res);
    return res;
  }
  return { runtime, session, records, chat, effects, app, invoke };
}

test('dependency boundary fails closed before registering a route', () => {
  assert.throws(() => createCliSwitchRuntime({}), /records map/);
  const records = new Map();
  assert.throws(() => createCliSwitchRuntime({ records }), /sessionPersistence/);
  assert.deepEqual(cliHandoffSummary(null), null);
});

test('handoff summary exposes bounded status without checkpoint transcript', () => {
  const summary = cliHandoffSummary({ pendingCliHandoff: {
    id: 'h1', fromCli: 'claude', toCli: 'codex', status: 'pending',
    reason: '', createdAt: 'now', reusedTarget: 1, checkpoint: { transcript: ['secret'] },
  } });
  assert.deepEqual(summary, {
    id: 'h1', fromCli: 'claude', toCli: 'codex', status: 'pending',
    reason: null, createdAt: 'now', reusedTarget: true,
  });
  assert.equal(JSON.stringify(summary).includes('transcript'), false);
});

test('defaults are CLI-specific and provider defaults are resolved lazily', () => {
  const { runtime } = createHarness();
  assert.deepEqual(runtime.cliSwitchDefaults('codex'), {
    provider: 'codex-default', model: null, effort: 'xhigh', subagent: null, agent: null,
  });
  assert.deepEqual(runtime.cliSwitchDefaults('opencode'), {
    provider: null, model: null, effort: null, subagent: null, agent: null,
  });
});

test('Git snapshot is bounded and failure falls back to the persisted branch', async () => {
  let harness = createHarness();
  assert.deepEqual(await harness.runtime.cliSwitchGitSnapshot(harness.session), {
    branch: 'multicc/s1', head: 'abc123', changes: ['M file.js'],
  });
  harness = createHarness({ gitWorktreeSnapshot: async () => { throw new Error('/secret/path'); } });
  assert.deepEqual(await harness.runtime.cliSwitchGitSnapshot(harness.session), {
    branch: 'multicc/s1', head: null, changes: [],
  });
});

test('route validation preserves missing, system, terminal and unsupported responses', async () => {
  let harness = createHarness();
  let res = await harness.invoke({ id: 'missing', body: { cli: 'codex' } });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'session not found' });

  harness = createHarness({ session: { id: 's1', type: 'aux', kind: 'chat', cli: 'claude' } });
  res = await harness.invoke({ body: { cli: 'codex' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /system session/);

  harness = createHarness({ session: { id: 's1', kind: 'terminal', cli: 'claude' } });
  res = await harness.invoke({ body: { cli: 'codex' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /only chat/);

  harness = createHarness();
  res = await harness.invoke({ body: { cli: 'unknown' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /claude, codex, opencode, zcode/);
});

test('same CLI is a transactional no-op while unavailable and busy targets fail before switching', async () => {
  let harness = createHarness();
  let res = await harness.invoke({ body: { cli: 'claude' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.changed, false);
  assert.equal(harness.effects.includes('mutate:http.switch-cli-noop'), true);
  assert.equal(harness.effects.some(effect => effect === 'stream-close:s1'), false);

  harness = createHarness({ availability: {
    claude: { available: true }, codex: { available: false },
  } });
  res = await harness.invoke({ body: { cli: 'codex' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /not installed/);

  harness = createHarness({ streamState: { busy: true, queued: 0 } });
  res = await harness.invoke({ body: { cli: 'codex' } });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body.stream, { busy: true, queued: 0 });
  assert.equal(harness.session.cli, 'claude');
});

test('successful switch preserves side-effect order, checkpoint and target state', async () => {
  const { session, chat, effects, invoke } = createHarness();
  const res = await invoke({ body: { cli: 'codex' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.changed, true);
  assert.equal(res.body.cli, 'codex');
  assert.equal(res.body.fromCli, 'claude');
  assert.equal(res.body.handoffId, 'handoff_fixed');
  assert.equal(session.pendingCliHandoff.checkpoint.git.head, 'abc123');
  assert.equal(session.pendingCliHandoff.checkpoint.transcript[0].text, 'history:s1');
  assert.equal(session.provider, 'codex-default');
  assert.equal(session.effort, 'xhigh');
  assert.equal(chat.cli, 'codex');
  assert.equal(chat.currentAssistantText, '');
  assert.equal(chat._activeRunner, null);
  assert.deepEqual(effects.filter(effect => /^(mutate|stream-close|message|event|chat|workspace)/.test(effect)), [
    'mutate:http.switch-cli',
    'stream-close:s1',
    'message:handoff_fixed',
    'event:session_cli_changed',
    'chat:cli_switched',
    'workspace:session_cli_changed',
  ]);
});

test('pending handoff is consumed exactly once and emits the legacy acknowledgement', () => {
  const { runtime, session, effects } = createHarness();
  runtime.performCliSwitch(session, 'codex', {
    gitSnapshot: { branch: 'b', head: 'h', changes: [] },
  });
  effects.length = 0;
  assert.equal(runtime.consumePendingCliHandoff('s1'), true);
  assert.equal(session.pendingCliHandoff, undefined);
  assert.equal(session.lastCliHandoff.id, 'handoff_fixed');
  assert.deepEqual(effects, [
    'save:runtime.consume-cli-handoff',
    'chat:system',
  ]);
  assert.equal(runtime.consumePendingCliHandoff('s1'), false);
  assert.equal(effects.length, 2);
});

test('production composition mounts one runtime route and keeps only bounded exports', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /createCliSwitchRuntime\s*\(\s*\{/);
  assert.match(source, /cliSwitchRuntime\.mountRoutes\(app, asyncHandler\)/);
  assert.match(source, /const cliSwitchGitSnapshot = cliSwitchRuntime\.cliSwitchGitSnapshot/);
  assert.match(source, /const consumePendingCliHandoff = cliSwitchRuntime\.consumePendingCliHandoff/);
  assert.doesNotMatch(source, /function\s+performCliSwitch\s*\(/);
  assert.doesNotMatch(source, /app\.post\(['"]\/api\/sessions\/:id\/switch-cli/);
});
