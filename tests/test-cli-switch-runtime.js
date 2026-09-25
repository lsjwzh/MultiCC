'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
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
    _activeRunner: null, _activeTurn: { id: 'turn' },
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
    getHistory: overrides.getHistory || (id => [{ role: 'user', content: `history:${id}`, ts: 90 }]),
    synchronizeCodexSessionRoute: route => effects.push(`sync:${route.nativeSessionId}`),
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
    hasLiveBackgroundTasks: () => overrides.backgroundActive === true,
    cancelClassify: () => effects.push('cancel-classify'),
    assignKillReason: (_runner, reason) => effects.push(`kill-reason:${reason}`),
    finishProviderAttempt: (attempt, facts) => {
      effects.push(`attempt-finish:${attempt.routeAttemptId}:${facts.reasonCode}`);
      return { ok: true };
    },
    appendMessage: (_id, message) => effects.push(`message:${message.cliSwitch.handoffId}`),
    appendEvent: (_dirId, type) => effects.push(`event:${type}`),
    chatBroadcast: (_id, event) => effects.push(`chat:${event.type}`),
    workspaceBroadcast: (_dirId, event) => effects.push(`workspace:${event.type}`),
    saveBestEffort: source => effects.push(`save:${source}`),
    cliAvailabilitySummary: overrides.cliAvailabilitySummary || (() => overrides.availability || {
      claude: { available: true }, codex: { available: true },
      opencode: { available: true }, zcode: { available: true }, qoder: { available: true },
    }),
    sessionProviderName: value => value.provider ? `name:${value.provider}` : null,
    sessionProviderBaseUrl: value => value.provider ? `https://${value.provider}.example.com` : null,
    effectiveSessionModel: value => value.model || 'effective-default',
    effectiveSessionEffort: value => value.effort || 'effective-default',
    serializeSubagent: value => value,
    clock: overrides.clock || (() => 1000),
    handoffIdFactory: () => 'handoff_fixed',
    installSpecs: overrides.installSpecs,
    spawnProcess: overrides.spawnProcess,
    cliCommands: overrides.cliCommands,
    // 默认桩: 不读本机真实安装布局(这台机器上的 codex 可能就是 brew 装的)。
    homebrewOwnerOf: overrides.homebrewOwnerOf || (() => null),
    execFileVersion: overrides.execFileVersion,
    // 默认桩: 不打真实 npm registry。想断言「有新版」的用例自己注入一个。
    fetchLatestVersion: overrides.fetchLatestVersion || (async () => null),
    fetchLatestVersionWithSource: overrides.fetchLatestVersionWithSource,
    registryBase: overrides.registryBase,
  });
  const app = {
    routes: {},
    post(route, handler) { this.routes[`POST ${route}`] = handler; },
    get(route, handler) { this.routes[`GET ${route}`] = handler; },
  };
  runtime.mountRoutes(app, handler => handler);
  async function invoke({ id = 's1', body = {} } = {}) {
    const res = createResponse();
    await app.routes['POST /api/sessions/:id/switch-cli']({ params: { id }, body }, res);
    return res;
  }
  async function invokeSpecs() {
    const res = createResponse();
    await app.routes['GET /api/cli/install-specs']({ params: {}, body: {} }, res);
    return res;
  }
  async function invokeInstall(cli) {
    const res = createResponse();
    await app.routes['POST /api/cli/:cli/install']({ params: { cli }, body: {} }, res);
    return res;
  }
  async function invokeStatus(jobId) {
    const res = createResponse();
    await app.routes['GET /api/cli/install-status/:jobId']({ params: { jobId }, body: {} }, res);
    return res;
  }
  async function invokeVersions(force) {
    const res = createResponse();
    const query = force ? { refresh: '1' } : {};
    await app.routes['GET /api/cli/versions']({ params: {}, query, body: {} }, res);
    return res;
  }
  async function invokeUpgrade(cli) {
    const res = createResponse();
    await app.routes['POST /api/cli/:cli/upgrade']({ params: { cli }, body: {} }, res);
    return res;
  }
  return { runtime, session, records, chat, effects, app, invoke, invokeSpecs, invokeInstall, invokeStatus, invokeVersions, invokeUpgrade };
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

// Regression (2026-09-03 user report): switching to WorkBuddy (codebuddy) or
// DeepSeek Harness (dsh) failed with "cli must be one of: claude, codex,
// opencode, zcode, qoder, kimi" because the running server predated the
// whitelist extension. Pins the route-level behaviour: both canonical keys are
// accepted through SUPPORTED_CHAT_CLIS, and the marketing name "workbuddy" is
// NOT a valid wire key. gemini / grok are the same shape of vendor-auth CLI and
// are pinned here too, so a new CLI cannot be added to the roster alone.
test('switching to vendor-auth CLIs (codebuddy / dsh / gemini / grok) passes the supported whitelist', async () => {
  const { invoke, session } = createHarness({
    availability: {
      claude: { available: true },
      codebuddy: { available: true },
      dsh: { available: true },
      gemini: { available: true },
      grok: { available: true },
    },
  });
  const res1 = await invoke({ body: { cli: 'codebuddy' } });
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.body.changed, true);
  assert.equal(res1.body.cli, 'codebuddy');
  assert.equal(res1.body.fromCli, 'claude');
  assert.equal(session.cli, 'codebuddy');
  const res2 = await invoke({ body: { cli: 'dsh' } });
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.changed, true);
  assert.equal(res2.body.cli, 'dsh');
  assert.equal(session.cli, 'dsh');
  const resGemini = await invoke({ body: { cli: 'gemini' } });
  assert.equal(resGemini.statusCode, 200);
  assert.equal(resGemini.body.cli, 'gemini');
  assert.equal(session.cli, 'gemini');
  const resGrok = await invoke({ body: { cli: 'grok' } });
  assert.equal(resGrok.statusCode, 200);
  assert.equal(resGrok.body.cli, 'grok');
  assert.equal(session.cli, 'grok');
  const res3 = await invoke({ body: { cli: 'workbuddy' } });
  assert.equal(res3.statusCode, 400);
  assert.equal(res3.body.error, `cli must be one of: ${SUPPORTED_CHAT_CLIS.join(', ')}`);
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
  assert.match(res.body.error, /claude, claude-exp, codex, codex-exp, opencode, zcode, qoder/);
});

test('same CLI is a no-op; unavailable targets reject and busy targets defer', async () => {
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
  harness.chat._activeRunner = { providerAttempt: { routeAttemptId: 'attempt-1' } };
  harness.chat.claudeProc = {
    kill: signal => harness.effects.push(`process-kill:${signal}`),
  };
  res = await harness.invoke({ body: { cli: 'codex' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deferred, true);
  assert.equal(harness.session.cli, 'claude');
  assert.equal(harness.session.pendingConfiguration.cli, 'codex');
  assert.ok(harness.chat.claudeProc);
  assert.equal(harness.effects.some(e => /kill|close|stream_end|attempt-finish/.test(e)), false);
});

test('background work saves a switch without closing its owner', async () => {
  const harness = createHarness({ backgroundActive: true });
  const res = await harness.invoke({ body: { cli: 'codex', force: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deferred, true);
  assert.equal(harness.session.cli, 'claude');
  assert.equal(harness.runtime.applyPendingConfiguration('s1'), false);
  assert.equal(harness.effects.includes('stream-close:s1'), false);
  assert.equal(harness.effects.some(effect => effect.startsWith('message:')), false);
});

test('saved switch survives serialization, preserves retries and uses final history on the next turn', async () => {
  const history = [{ role: 'user', content: 'start', ts: 90 }];
  const harness = createHarness({ getHistory: () => history });
  harness.chat.isStreaming = true;
  await harness.invoke({ body: { cli: 'codex' } });
  const restored = JSON.parse(JSON.stringify(harness.session));
  assert.equal(restored.pendingConfiguration.cli, 'codex');
  harness.chat.isStreaming = false;
  assert.equal(harness.runtime.applyPendingConfiguration('s1', { originContinue: true }), true);
  assert.equal(harness.session.cli, 'claude');
  history.push({ role: 'assistant', content: 'final old-CLI result', ts: 99 });
  assert.equal(harness.runtime.applyPendingConfiguration('s1'), true);
  assert.equal(harness.session.cli, 'codex');
  assert.equal(harness.session.pendingConfiguration, undefined);
  assert.match(JSON.stringify(harness.session.pendingCliHandoff), /final old-CLI result/);
  const count = harness.effects.filter(e => e.startsWith('message:')).length;
  assert.equal(harness.runtime.applyPendingConfiguration('s1'), true);
  assert.equal(harness.effects.filter(e => e.startsWith('message:')).length, count);
});

test('latest CLI choice replaces pending choice, including switching back to the running CLI', async () => {
  const h = createHarness(); h.chat.isStreaming = true;
  await h.invoke({ body: { cli: 'codex' } });
  await h.invoke({ body: { cli: 'opencode' } });
  assert.equal(h.session.pendingConfiguration.cli, 'opencode');
  await h.invoke({ body: { cli: 'claude' } });
  assert.equal(h.session.pendingConfiguration.cli, 'claude');
  h.chat.isStreaming = false;
  h.runtime.applyPendingConfiguration('s1');
  assert.equal(h.session.cliSessionId, 'claude-native');
  assert.equal(h.effects.some(e => e.startsWith('message:')), false);
});

test('a turn beginning during the Git snapshot converts an idle switch to a deferred switch', async () => {
  let release;
  const h = createHarness({ gitWorktreeSnapshot: () => new Promise(resolve => { release = resolve; }) });
  const response = h.invoke({ body: { cli: 'codex' } });
  h.chat.isStreaming = true;
  release({ branch: 'b', head: 'h', changes: [] });
  assert.equal((await response).body.deferred, true);
  assert.equal(h.session.cli, 'claude');
  assert.equal(h.effects.includes('stream-close:s1'), false);
});

test('successful switch preserves side-effect order, checkpoint and target state', async () => {
  const { session, chat, effects, invoke } = createHarness();
  const res = await invoke({ body: { cli: 'codex' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.changed, true);
  assert.equal(res.body.cli, 'codex');
  assert.equal(res.body.fromCli, 'claude');
  assert.equal(res.body.handoffId, 'handoff_fixed');
  assert.equal(res.body.forced, false);
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

test('web and app explain next-turn CLI changes without force intent', () => {
  const webHost = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.js'), 'utf8');
  const webPicker = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat-live-ui.js'), 'utf8');
  const appService = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'lib', 'services', 'session_service.dart'), 'utf8');
  const appPicker = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'lib', 'widgets', 'cli_switch_sheet.dart'), 'utf8');
  assert.match(webHost, /JSON\.stringify\(picked\)/);
  assert.doesNotMatch(appService.slice(appService.indexOf('Future<SessionCliConfig> switchSessionCli'), appService.indexOf('// ── CLI install')), /'force': true/);
  for (const source of [webPicker, appPicker]) {
    assert.match(source, /下轮/);
    assert.doesNotMatch(source, /直接终止该回复并清空排队消息/);
    assert.doesNotMatch(source, /运行中切换会被服务端拒绝|请在当前回复结束后切换/);
  }
});

test('install-specs returns the static official command table', async () => {
  const { invokeSpecs } = createHarness();
  const res = await invokeSpecs();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.specs, {
    claude: { auto: true, command: 'npm install -g @anthropic-ai/claude-code', display: 'npm install -g @anthropic-ai/claude-code' },
    'claude-exp': { auto: false, manual: 'Claude Agent SDK 由 MultiCC 内置；请升级 MultiCC 来更新 SDK' },
    codex: { auto: true, command: 'npm install -g @openai/codex', display: 'npm install -g @openai/codex' },
    'codex-exp': { auto: true, command: 'npm install -g @openai/codex', display: 'npm install -g @openai/codex' },
    opencode: { auto: true, command: 'npm install -g opencode-ai', display: 'npm install -g opencode-ai' },
    qoder: { auto: true, command: 'curl -fsSL https://qoder.cn/install | bash', display: 'curl -fsSL https://qoder.cn/install | bash' },
    zcode: { auto: false, manual: 'ZCode 暂无官方 CLI 安装脚本, 请从官网 https://zcode.z.ai 下载安装 ZCode 桌面版(其内置 CLI)' },
    kimi: { auto: true, command: 'npm install -g @moonshot-ai/kimi-code', display: 'npm install -g @moonshot-ai/kimi-code' },
    codebuddy: { auto: true, command: 'npm install -g @tencent-ai/codebuddy-code', display: 'npm install -g @tencent-ai/codebuddy-code' },
    dsh: { auto: true, command: 'npm install -g @deepseek-ai/dsh', display: 'npm install -g @deepseek-ai/dsh' },
    gemini: { auto: true, command: 'npm install -g @google/gemini-cli', display: 'npm install -g @google/gemini-cli' },
    grok: { auto: true, command: 'npm install -g @xai-official/grok', display: 'npm install -g @xai-official/grok' },
  });
  assert.equal(res.body.availability.codex.available, true);
});

test('install rejects an unsupported cli with 400', async () => {
  const { invokeInstall } = createHarness();
  const res = await invokeInstall('nope');
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: 'unsupported cli' });
});

test('install short-circuits to alreadyInstalled when the cli is available', async () => {
  const { invokeInstall } = createHarness();
  const res = await invokeInstall('codex');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.alreadyInstalled, true);
  assert.equal(res.body.availability.codex.available, true);
});

test('install returns manual instructions for zcode when it is not available', async () => {
  const { invokeInstall } = createHarness({ availability: { zcode: { available: false } } });
  const res = await invokeInstall('zcode');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.manual, true);
  assert.match(res.body.error, /ZCode/);
});

test('install transitions running -> done via a fake spawn that exits 0 and re-checks availability', async () => {
  let available = false;
  let proc = null;
  const fakeSpawn = () => {
    proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    return proc;
  };
  const harness = createHarness({
    spawnProcess: fakeSpawn,
    cliAvailabilitySummary: () => ({
      claude: { available: true }, codex: { available: available },
      opencode: { available: false }, zcode: { available: false }, qoder: { available: false },
    }),
  });
  let res = await harness.invokeInstall('codex');
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.cli, 'codex');
  assert.equal(res.body.command, 'npm install -g @openai/codex');
  const jobId = res.body.jobId;
  // running before exit, stdout 已被环形缓冲收录
  res = await harness.invokeStatus(jobId);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.job.status, 'running');
  assert.equal(res.body.job.cli, 'codex');
  proc.stdout.emit('data', 'installing codex\n');
  // 翻转可用性后 exit 0 -> done
  available = true;
  proc.emit('exit', 0, null);
  res = await harness.invokeStatus(jobId);
  assert.equal(res.body.job.status, 'done');
  assert.equal(res.body.job.exitCode, 0);
  assert.equal(res.body.job.error, null);
  assert.equal(res.body.availability.codex.available, true);
  assert.equal(res.body.job.logTail.includes('installing codex'), true);
});

test('install exit non-zero marks the job as error', async () => {
  let proc = null;
  const fakeSpawn = () => {
    proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    return proc;
  };
  const harness = createHarness({
    spawnProcess: fakeSpawn,
    availability: { codex: { available: false } },
  });
  let res = await harness.invokeInstall('codex');
  assert.equal(res.statusCode, 202);
  const jobId = res.body.jobId;
  proc.emit('exit', 1, null);
  res = await harness.invokeStatus(jobId);
  assert.equal(res.body.job.status, 'error');
  assert.equal(res.body.job.exitCode, 1);
  assert.match(res.body.job.error, /退出码|失败/);
});

test('install returns 409 while a job for the same cli is still running', async () => {
  const fakeSpawn = () => {
    const ee = new EventEmitter();
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.kill = () => {};
    return ee;
  };
  const harness = createHarness({
    spawnProcess: fakeSpawn,
    availability: { codex: { available: false } },
  });
  let res = await harness.invokeInstall('codex');
  assert.equal(res.statusCode, 202);
  const firstJobId = res.body.jobId;
  res = await harness.invokeInstall('codex');
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.running, true);
  assert.equal(res.body.jobId, firstJobId);
});

test('install-status returns 404 for an unknown job id', async () => {
  const { invokeStatus } = createHarness();
  const res = await invokeStatus('does-not-exist');
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { ok: false, error: 'job not found' });
});

// ── GET /api/cli/versions ─────────────────────────────────────────────────
// 只读版本探测: 报告 multicc 实际派生的二进制的 `--version`, 缓存 1 天, 不升级。
function fakeExecFile(versionByCmd, { failCmds = [] } = {}) {
  const calls = [];
  const fn = (cmd, args, _options, cb) => {
    calls.push({ cmd, args });
    if (failCmds.includes(cmd)) return cb(new Error(`spawn ${cmd} ENOENT`), '', '');
    const stub = versionByCmd[cmd];
    if (stub == null) return cb(new Error(`no stub for ${cmd}`), '', '');
    if (typeof stub === 'string') return cb(null, stub, '');
    return cb(null, stub.stdout || '', stub.stderr || '');
  };
  fn.calls = calls;
  return fn;
}

const VERSION_CMDS = {
  claude: '/bin/claude', 'claude-exp': process.execPath,
  codex: '/bin/codex', opencode: '/bin/opencode',
  zcode: '/bin/zcode', qoder: '/bin/qoderclicn', kimi: 'kimi',
};

test('cli/versions reports the spawned binary version and parses noisy output', async () => {
  const exec = fakeExecFile({
    '/bin/claude': 'claude v2.0.1 (cli)\n',
    '/bin/codex': 'codex-cli 0.20.0',
    '/bin/opencode': '0.1.48',
    '/bin/zcode': { stdout: '', stderr: 'zcode 1.2.3' }, // 版本落在 stderr 也能解析
    '/bin/qoderclicn': '1.1.4',
  });
  const harness = createHarness({
    cliCommands: VERSION_CMDS,
    execFileVersion: exec,
    availability: {
      claude: { available: true }, 'claude-exp': { available: true },
      codex: { available: true }, opencode: { available: true },
      zcode: { available: true }, qoder: { available: true }, kimi: { available: false },
    },
  });
  const res = await harness.invokeVersions();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.cached, false);
  assert.equal(res.body.versions.qoder.version, '1.1.4');
  assert.equal(res.body.versions.qoder.cmd, '/bin/qoderclicn');
  assert.equal(res.body.versions.qoder.available, true);
  assert.equal(res.body.versions.claude.version, '2.0.1');
  // claude-exp 的版本来自 package.json 里的 SDK 依赖(见 CLAUDE_AGENT_SDK_VERSION),
  // 跟着真实依赖走, 升级 SDK 不需要改这里。
  const sdkDep = require('../package.json').dependencies['@anthropic-ai/claude-agent-sdk'];
  assert.equal(res.body.versions['claude-exp'].version, String(sdkDep).replace(/^[~^]/, ''));
  assert.equal(res.body.versions.codex.version, '0.20.0');
  assert.equal(res.body.versions.zcode.version, '1.2.3'); // 从 stderr 解析
  // 探测确实用的是 --version, 且解析出的正是注入的那个二进制路径
  assert.deepEqual(exec.calls.find(c => c.cmd === '/bin/qoderclicn').args, ['--version']);
  assert.equal(exec.calls.some(c => c.cmd === process.execPath), false);
});

test('cli/versions skips unavailable clis without spawning them', async () => {
  const exec = fakeExecFile({ '/bin/claude': '2.0.1', '/bin/qoderclicn': '1.1.4' });
  const harness = createHarness({
    cliCommands: VERSION_CMDS,
    execFileVersion: exec,
    availability: {
      claude: { available: true }, codex: { available: false }, opencode: { available: false },
      zcode: { available: false }, qoder: { available: true }, kimi: { available: false },
    },
  });
  const res = await harness.invokeVersions();
  assert.equal(res.body.versions.kimi.available, false);
  assert.equal(res.body.versions.kimi.version, null);
  assert.equal(res.body.versions.codex.available, false);
  // 只为可用的 claude/qoder spawn, 其余不触发子进程(避免 ENOENT 噪声)
  const spawned = exec.calls.map(c => c.cmd).sort();
  assert.deepEqual(spawned, ['/bin/claude', '/bin/qoderclicn']);
});

test('cli/versions caches within the TTL and re-probes on ?refresh=1', async () => {
  const exec = fakeExecFile({ '/bin/qoderclicn': '1.1.4' });
  const harness = createHarness({
    cliCommands: VERSION_CMDS,
    execFileVersion: exec,
    availability: { qoder: { available: true } },
  });
  const first = await harness.invokeVersions();
  assert.equal(first.body.cached, false);
  const callsAfterFirst = exec.calls.length;
  const second = await harness.invokeVersions();
  assert.equal(second.body.cached, true);
  assert.equal(exec.calls.length, callsAfterFirst); // 命中缓存, 未再 spawn
  const third = await harness.invokeVersions(true); // ?refresh=1
  assert.equal(third.body.cached, false);
  assert.ok(exec.calls.length > callsAfterFirst); // 强制重探
});

test('cli/versions re-probes once the TTL elapses', async () => {
  let now = 1000;
  const exec = fakeExecFile({ '/bin/qoderclicn': '1.1.4' });
  const harness = createHarness({
    clock: () => now,
    cliCommands: VERSION_CMDS,
    execFileVersion: exec,
    availability: { qoder: { available: true } },
  });
  await harness.invokeVersions();
  const afterFirst = exec.calls.length;
  now += 60 * 1000; // 1 分钟: 仍在 1 天 TTL 内
  const cached = await harness.invokeVersions();
  assert.equal(cached.body.cached, true);
  assert.equal(exec.calls.length, afterFirst);
  now += 24 * 60 * 60 * 1000; // 跨过 TTL
  const stale = await harness.invokeVersions();
  assert.equal(stale.body.cached, false);
  assert.ok(exec.calls.length > afterFirst);
});

test('cli/versions reports a per-cli error entry without failing the whole call', async () => {
  const exec = fakeExecFile(
    { '/bin/claude': 'no version here' }, // 无法解析
    { failCmds: ['/bin/qoderclicn'] },     // spawn 失败
  );
  const harness = createHarness({
    cliCommands: VERSION_CMDS,
    execFileVersion: exec,
    availability: { claude: { available: true }, qoder: { available: true } },
  });
  const res = await harness.invokeVersions();
  assert.equal(res.statusCode, 200); // 单点失败不影响整体 200
  assert.equal(res.body.ok, true);
  assert.equal(res.body.versions.claude.version, null);
  assert.match(res.body.versions.claude.error, /not parseable/);
  assert.equal(res.body.versions.qoder.version, null);
  assert.match(res.body.versions.qoder.error, /ENOENT/);
});


test('applying a pending switch publishes nothing when persistence fails and remains retryable', async () => {
  const { createSessionPersistence } = require('../src/session/persistence');
  const session = { id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat', cliSessionId: 'original' };
  const records = new Map([['s1', session]]); let fail = false;
  const persistence = createSessionPersistence({ records, store: { save() { if (fail) throw Error('disk-full'); } } });
  const h = createHarness({ session, records, sessionPersistence: persistence });
  h.chat.isStreaming = true; await h.invoke({ body: { cli: 'codex' } });
  h.chat.isStreaming = false; h.effects.length = 0; fail = true;
  assert.throws(() => h.runtime.applyPendingConfiguration('s1'), /could not be persisted/);
  assert.equal(records.get('s1').cli, 'claude'); assert.ok(records.get('s1').pendingConfiguration);
  assert.equal(h.effects.some(e => /close|message:|chat:|workspace:/.test(e)), false);
  fail = false; assert.equal(h.runtime.applyPendingConfiguration('s1'), true);
  assert.equal(records.get('s1').cli, 'codex'); persistence.stop();
});

test('a pending profile applies once at an idle boundary; live steering retains the original route', async () => {
  const { stageConfiguration } = require('../src/session/pending-configuration');
  const h = createHarness();
  stageConfiguration(h.session, { ...h.session, model: 'next-model', provider: 'next-provider' });
  h.chat.isStreaming = true;
  assert.equal(h.runtime.applyPendingConfiguration('s1', { originContinue: true, directUserInput: true }), true);
  assert.equal(h.session.model, 'claude-model'); assert.equal(h.effects.includes('stream-close:s1'), false);
  h.chat.isStreaming = false; h.runtime.applyPendingConfiguration('s1');
  assert.equal(h.session.provider, 'next-provider'); assert.equal(h.session.model, 'next-model');
  assert.equal(h.session.cliSessionId, 'claude-native'); assert.equal(h.session.pendingConfiguration, undefined);
  assert.equal(h.effects.filter(e => e === 'stream-close:s1').length, 1);
});

// ── 上游最新版比对 + 一键升级 ─────────────────────────────────────────────
// 「有没有新版」是两个独立事实的组合: 本地 `--version` 与上游发布的 latest。
// 这里钉的是两者的边界 —— 谁查不到、谁不该被查、谁只该被提示而不该被自动动。

test('cli/versions compares against the published version and counts the updates', async () => {
  const published = { '@anthropic-ai/claude-code': '2.0.2', '@openai/codex': '0.20.0' };
  const exec = fakeExecFile({ '/bin/claude': 'claude v2.0.1', '/bin/codex': 'codex-cli 0.20.0' });
  const harness = createHarness({
    cliCommands: VERSION_CMDS,
    execFileVersion: exec,
    fetchLatestVersion: async pkg => published[pkg] || null,
    availability: { claude: { available: true }, codex: { available: true } },
  });
  const res = await harness.invokeVersions();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.versions.claude.latest, '2.0.2');
  assert.equal(res.body.versions.claude.updateSource, 'npm');
  assert.equal(res.body.versions.claude.updateAvailable, true);
  // 同版本不算待更新 —— 否则每次打开页面都在催升级
  assert.equal(res.body.versions.codex.latest, '0.20.0');
  assert.equal(res.body.versions.codex.updateAvailable, false);
  assert.equal(res.body.updateCount, 1);
  assert.match(res.body.latestCheckedAt, /^\d{4}-/);
});

test('cli/versions never claims an update where there is no comparable source', async () => {
  const exec = fakeExecFile({ '/bin/qoderclicn': '1.1.4', '/bin/zcode': '0.16.5' });
  const asked = [];
  const harness = createHarness({
    cliCommands: VERSION_CMDS,
    execFileVersion: exec,
    fetchLatestVersion: async pkg => { asked.push(pkg); return '9.9.9'; },
    availability: { qoder: { available: true }, zcode: { available: true }, kimi: { available: false } },
  });
  const res = await harness.invokeVersions();
  // qoder(curl 脚本装)与 zcode(手动装桌面版)没有可查的发布源: latest 只能是 null,
  // 前端据此显示「无法检测」而不是「已是最新」。
  assert.equal(res.body.versions.qoder.latest, null);
  assert.equal(res.body.versions.qoder.updateSource, null);
  assert.equal(res.body.versions.qoder.updateAvailable, false);
  assert.equal(res.body.versions.zcode.updateAvailable, false);
  assert.equal(res.body.updateCount, 0);
  // 没有 npm 源的、以及压根没装的, 都不该去打网络
  assert.deepEqual(asked, []);
});

test('cli/versions reports inUseCount so the upgrade dialog can name the risk', async () => {
  const exec = fakeExecFile({ '/bin/claude': '2.0.1', '/bin/opencode': '1.18.18' });
  const options = {
    cliCommands: VERSION_CMDS,
    execFileVersion: exec,
    fetchLatestVersion: async () => '2.0.2',
    availability: { claude: { available: true }, opencode: { available: true } },
  };
  // 唯一的活动会话 s1 跑的是 claude -> 只有 claude 被计为「正在使用」
  const busy = await createHarness(options).invokeVersions();
  assert.equal(busy.body.versions.claude.inUseCount, 1);
  assert.equal(busy.body.versions.opencode.inUseCount, 0);
  // 没有任何活动会话时不谎报占用
  const quiet = await createHarness({ ...options, chat: false }).invokeVersions();
  assert.equal(quiet.body.versions.claude.inUseCount, 0);
});

test('upgrade runs the official command even though the cli is already installed', async () => {
  let proc = null;
  const fakeSpawn = () => {
    proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    return proc;
  };
  const harness = createHarness({
    spawnProcess: fakeSpawn,
    // claude 是可用的 -> /install 会短路, /upgrade 不能短路
    availability: { claude: { available: true } },
  });
  const install = await harness.invokeInstall('claude');
  assert.equal(install.statusCode, 200);
  assert.equal(install.body.alreadyInstalled, true);

  const res = await harness.invokeUpgrade('claude');
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.cli, 'claude');
  assert.equal(res.body.command, 'npm install -g @anthropic-ai/claude-code');
  assert.ok(proc, '升级必须真的起了安装进程');

  const status = await harness.invokeStatus(res.body.jobId);
  assert.equal(status.body.job.status, 'running');
});

test('upgrade refuses unsupported clis and manual-only installs', async () => {
  const harness = createHarness();
  const unknown = await harness.invokeUpgrade('nope');
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.body.ok, false);
  const manual = await harness.invokeUpgrade('zcode');
  assert.equal(manual.statusCode, 400);
  assert.equal(manual.body.manual, true);
  assert.match(manual.body.error, /ZCode/);
});

test('upgrade returns 409 while a job for the same cli is still running', async () => {
  const fakeSpawn = () => {
    const ee = new EventEmitter();
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.kill = () => {};
    return ee;
  };
  const harness = createHarness({ spawnProcess: fakeSpawn });
  const first = await harness.invokeUpgrade('claude');
  assert.equal(first.statusCode, 202);
  const second = await harness.invokeUpgrade('claude');
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.running, true);
  assert.equal(second.body.jobId, first.body.jobId);
});

test('a successful upgrade invalidates both caches so the badge clears on the next read', async () => {
  let proc = null;
  const fakeSpawn = () => {
    proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    return proc;
  };
  let installed = 'claude v2.0.1';
  const exec = (cmd, args, _options, cb) => cb(null, installed, '');
  const harness = createHarness({
    spawnProcess: fakeSpawn,
    cliCommands: { claude: '/bin/claude' },
    execFileVersion: exec,
    fetchLatestVersion: async () => '2.0.2',
    availability: { claude: { available: true } },
  });

  const before = await harness.invokeVersions();
  assert.equal(before.body.versions.claude.version, '2.0.1');
  assert.equal(before.body.updateCount, 1);

  const started = await harness.invokeUpgrade('claude');
  assert.equal(started.statusCode, 202);
  installed = 'claude v2.0.2'; // 升级把二进制真的换掉了
  proc.emit('exit', 0, null);

  const after = await harness.invokeVersions();
  assert.equal(after.body.cached, false, '升级成功后必须重探, 而不是回放旧缓存');
  assert.equal(after.body.versions.claude.version, '2.0.2');
  assert.equal(after.body.versions.claude.updateAvailable, false);
  assert.equal(after.body.updateCount, 0);
});

// 只要升级命令跑起来, 就必须和「看到最新版的那个源」用同一个源: 官方源不可达时
// 检测走的是兜底镜像, 安装却去打官方源, 就是「有新版可升级但升级永远失败」。
test('the install job installs from the registry that answered the version probe', async () => {
  const spawns = [];
  const fakeSpawn = (cmd, args, options) => {
    const ee = new EventEmitter();
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.kill = () => {};
    spawns.push({ cmd, args, env: options && options.env });
    return ee;
  };
  const harness = createHarness({
    spawnProcess: fakeSpawn,
    cliCommands: { claude: '/bin/claude' },
    execFileVersion: (cmd, args, _options, cb) => cb(null, 'claude v2.0.1', ''),
    fetchLatestVersionWithSource: async () => ({ version: '2.0.2', registry: 'https://registry.npmmirror.com/' }),
    availability: { claude: { available: true } },
  });
  const versions = await harness.invokeVersions();
  assert.equal(versions.body.versions.claude.latestRegistry, 'https://registry.npmmirror.com/');
  assert.equal(versions.body.latestRegistries.claude, 'https://registry.npmmirror.com/');

  const started = await harness.invokeUpgrade('claude');
  assert.equal(started.statusCode, 202);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].env.npm_config_registry, 'https://registry.npmmirror.com/');
  assert.match(spawns[0].args.join(' '), /npm install -g @anthropic-ai\/claude-code/);

  // 上游查不到最新版时不许瞎指定源, 让 npm 自己按用户配置决定
  const quiet = createHarness({
    spawnProcess: fakeSpawn,
    cliCommands: { claude: '/bin/claude' },
    execFileVersion: (cmd, args, _options, cb) => cb(null, 'claude v2.0.1', ''),
    fetchLatestVersion: async () => null,
    availability: { claude: { available: true } },
  });
  await quiet.invokeVersions();
  await quiet.invokeUpgrade('claude');
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].env.npm_config_registry, undefined);
});

// 「命令成功」≠「multicc 派生的那个二进制升级了」。同一台机器上 claude 既有原生安装
// (multicc 优先派生的那个)又有 npm 全局安装时, npm 装完新版本, 派生路径纹丝不动 ——
// 不查这一下, 用户看到的就是一个永远消不掉的「可升级」角标。
test('an upgrade that leaves the spawned binary untouched is reported as failed, with a way out', async () => {
  let proc = null;
  const fakeSpawn = () => {
    proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    return proc;
  };
  const harness = createHarness({
    spawnProcess: fakeSpawn,
    cliCommands: { claude: '/bin/claude' },
    // 无论命令跑多少次, 被派生的那个二进制始终是 2.0.1(新版装到了别的位置)
    execFileVersion: (cmd, args, _options, cb) => cb(null, 'claude v2.0.1', ''),
    fetchLatestVersion: async () => '2.0.2',
    availability: { claude: { available: true } },
  });
  const before = await harness.invokeVersions();
  assert.equal(before.body.versions.claude.updateAvailable, true);

  const started = await harness.invokeUpgrade('claude');
  assert.equal(started.statusCode, 202);
  proc.stdout.emit('data', 'changed 1 package in 2s\n');
  proc.emit('exit', 0, null);
  for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve));

  const status = await harness.invokeStatus(started.body.jobId);
  assert.equal(status.body.job.status, 'error', '派生二进制没变就不能报成功');
  assert.match(status.body.job.error, /2\.0\.1/);
  assert.match(status.body.job.hint, /CLAUDE_CMD/);
  assert.match(status.body.job.hint, /\/bin\/claude/);

  // 命令把派生二进制真的换掉时, 仍然是 done, 且不误报
  let installed = 'claude v2.0.1';
  let proc2 = null;
  const harness2 = createHarness({
    spawnProcess: () => {
      proc2 = new EventEmitter();
      proc2.stdout = new EventEmitter();
      proc2.stderr = new EventEmitter();
      proc2.kill = () => {};
      return proc2;
    },
    cliCommands: { claude: '/bin/claude' },
    execFileVersion: (cmd, args, _options, cb) => cb(null, installed, ''),
    fetchLatestVersion: async () => '2.0.2',
    availability: { claude: { available: true } },
  });
  await harness2.invokeVersions();
  const second = await harness2.invokeUpgrade('claude');
  installed = 'claude v2.0.2';
  proc2.emit('exit', 0, null);
  for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve));
  const secondStatus = await harness2.invokeStatus(second.body.jobId);
  assert.equal(secondStatus.body.job.status, 'done');
  assert.equal(secondStatus.body.job.hint, null);
});

// codex 与 codex-exp 派生同一个二进制、跑同一条 npm install: 并发跑会让 npm 自己踩
// 自己的全局目录, 所以串行键是「安装目标」而不是 CLI 名。不同目标仍然可以并行。
test('install jobs serialize by install target, and different targets run in parallel', async () => {
  const spawned = [];
  const fakeSpawn = (cmd, args) => {
    const ee = new EventEmitter();
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.kill = () => {};
    spawned.push(args.join(' '));
    return ee;
  };
  const harness = createHarness({
    spawnProcess: fakeSpawn,
    availability: { codex: { available: false }, opencode: { available: false }, dsh: { available: false } },
  });
  const first = await harness.invokeUpgrade('codex');
  assert.equal(first.statusCode, 202);
  // 同一条命令 -> 409, 并说清是另一个 CLI 占着
  const twin = await harness.invokeUpgrade('codex-exp');
  assert.equal(twin.statusCode, 409);
  assert.equal(twin.body.running, true);
  assert.equal(twin.body.jobId, first.body.jobId);
  assert.match(twin.body.error, /codex/);
  // 不同目标 -> 允许并行(用户抱怨的「升级按钮一次只能点一个」)
  const other = await harness.invokeUpgrade('opencode');
  assert.equal(other.statusCode, 202);
  const third = await harness.invokeUpgrade('dsh');
  assert.equal(third.statusCode, 202);
  assert.equal(spawned.length, 3);
  // 三个任务各自独立可查
  for (const jobId of [first.body.jobId, other.body.jobId, third.body.jobId]) {
    const status = await harness.invokeStatus(jobId);
    assert.equal(status.body.job.status, 'running');
  }
});

// Homebrew 装的 CLI 不去兼容: 同一条命令里先 brew uninstall, 再 npm 装, 此后 bin 归 npm。
test('upgrade of a Homebrew-owned binary uninstalls it before the npm install', async () => {
  const spawns = [];
  const fakeSpawn = (cmd, args) => {
    const ee = new EventEmitter();
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.kill = () => {};
    spawns.push(args.join(' '));
    return ee;
  };
  const seen = [];
  const harness = createHarness({
    spawnProcess: fakeSpawn,
    cliCommands: { claude: '/opt/homebrew/bin/claude', codex: '/opt/homebrew/bin/codex' },
    homebrewOwnerOf: (cmd) => {
      seen.push(cmd);
      return cmd === '/opt/homebrew/bin/claude' ? { kind: 'formula', name: 'claude-code', path: cmd } : null;
    },
    availability: { claude: { available: true }, codex: { available: true } },
  });
  const res = await harness.invokeUpgrade('claude');
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.command, 'brew uninstall --formula claude-code && npm install -g @anthropic-ai/claude-code');
  assert.equal(spawns[0], '-c brew uninstall --formula claude-code && npm install -g @anthropic-ai/claude-code');
  assert.deepEqual(seen, ['/opt/homebrew/bin/claude']);

  // 不归 brew 管的照旧只跑 npm
  const plain = await harness.invokeUpgrade('codex');
  assert.equal(plain.body.command, 'npm install -g @openai/codex');
});

test('homebrew owner detection follows the real path and refuses unsafe names', () => {
  const { homebrewOwnerOf, takeoverCommand } = require('../src/cli/homebrew-takeover');
  const links = {
    '/opt/homebrew/bin/gemini': '/opt/homebrew/Cellar/gemini-cli/0.29.5/bin/gemini',
    '/opt/homebrew/bin/codex': '/opt/homebrew/Caskroom/codex/0.40.0/codex-aarch64-apple-darwin',
    '/opt/homebrew/bin/npmcli': '/opt/homebrew/lib/node_modules/npmcli/bin/cli.js',
    '/opt/homebrew/bin/evil': '/opt/homebrew/Cellar/a;rm -rf ~/1/bin/evil',
    '/opt/homebrew/Cellar/node/26.8.1/bin/node': '/opt/homebrew/Cellar/node/26.8.1/bin/node',
    '/opt/homebrew/bin/node22': '/opt/homebrew/Cellar/node@22/22.1.0/bin/node',
  };
  const realpath = (p) => { if (!links[p]) throw new Error('ENOENT'); return links[p]; };
  assert.deepEqual(homebrewOwnerOf('/opt/homebrew/bin/gemini', { realpath }),
    { kind: 'formula', name: 'gemini-cli', path: '/opt/homebrew/bin/gemini' });
  assert.equal(homebrewOwnerOf('/opt/homebrew/bin/codex', { realpath }).kind, 'cask');
  assert.equal(homebrewOwnerOf('/opt/homebrew/bin/npmcli', { realpath }), null);
  assert.equal(homebrewOwnerOf('/opt/homebrew/bin/evil', { realpath }), null);
  assert.equal(homebrewOwnerOf('/opt/homebrew/bin/missing', { realpath }), null);
  // 运行时(node/npm)永远不卸
  assert.equal(homebrewOwnerOf('/opt/homebrew/Cellar/node/26.8.1/bin/node', { realpath }), null);
  assert.equal(homebrewOwnerOf('/opt/homebrew/bin/node22', { realpath }), null);
  assert.equal(homebrewOwnerOf(null, { realpath }), null);

  const owner = { kind: 'cask', name: 'codex' };
  assert.equal(takeoverCommand(owner, 'npm install -g @openai/codex'),
    'brew uninstall --cask codex && npm install -g @openai/codex');
  // 非 npm 渠道(curl 安装脚本)不接管
  assert.equal(takeoverCommand(owner, 'curl -fsSL https://qoder.cn/install | bash'),
    'curl -fsSL https://qoder.cn/install | bash');
});
