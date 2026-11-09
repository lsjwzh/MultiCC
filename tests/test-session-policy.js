'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createSessionPolicy,
  createReportedModelRuntime,
  CODEX_STREAM_DISCONNECT_CONTINUE_MAX,
} = require('../src/cli/session-policy');
const { CLAUDE_MODELS_FALLBACK, _resetCacheForTest } = require('../src/routes/claude-models');

// Default-model tests must see the static picker list, not a live CLI scan.
_resetCacheForTest();
const CLAUDE_FIRST = CLAUDE_MODELS_FALLBACK[0].model;

function tempHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-session-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function createHarness(home, overrides = {}) {
  const summaries = new Map([
    ['claude:claude-official', {
      id: 'claude-official', appType: 'claude', name: 'Claude Official',
      isOfficial: true, model: null, modelOptions: [],
    }],
    ['codex:codex-official', {
      id: 'codex-official', appType: 'codex', name: 'Codex Official',
      isOfficial: true, model: null, modelOptions: [],
    }],
    ['claude:alias-provider', {
      id: 'alias-provider', name: 'Aliases', aliasOnly: true,
      aliasMap: { fast: { model: 'claude-real-fast' } },
      modelOptions: ['fast'],
    }],
    ['claude:relay', {
      id: 'relay', name: 'Relay', baseUrl: 'https://relay.invalid',
      model: null, modelOptions: ['relay-first'],
    }],
    ['claude:dual', {
      id: 'dual', name: 'Dual', model: null, modelOptions: ['dual-a', 'dual-b'],
    }],
    ['claude:primary', {
      id: 'primary', name: 'Primary', model: 'claude-primary',
      modelOptions: ['claude-primary', 'claude-secondary'],
    }],
    ['codex:codex-primary', {
      id: 'codex-primary', name: 'Codex Primary', model: 'gpt-primary',
      modelOptions: ['gpt-primary'],
    }],
    ['codex:codex-56', {
      id: 'codex-56', name: 'Codex 5.6', model: 'gpt-5.6-sol',
      modelOptions: ['gpt-5.6-sol', 'gpt-5.6-terra'],
    }],
    ['claude:zcode-primary', {
      id: 'zcode-primary', appType: 'claude', name: 'ZCode Primary', model: 'glm-zcode',
      modelOptions: ['glm-zcode'],
    }],
  ]);
  const router = overrides.providerRouter || {
    getProviderSummary(appType, providerId) {
      if (providerId === 'throws') throw new Error('provider unavailable');
      if (appType == null) {
        return summaries.get(`claude:${providerId}`)
          || summaries.get(`codex:${providerId}`)
          || null;
      }
      return summaries.get(`${appType}:${providerId}`) || null;
    },
  };
  const providers = {
    WIRE_DEFAULT_MODEL: 'wire-default',
    appTypeForCli: cli => cli === 'codex' || cli === 'codex-exp'
      ? 'codex'
      : (cli === 'claude' || cli === 'claude-exp' || cli === 'opencode' ? 'claude' : null),
    isOfficialProviderId: (appType, providerId) => typeof providerId === 'string'
      && (providerId === `${appType}-official` || providerId.startsWith(`${appType}-official-`)),
    readCodexOfficialModels: () => ['gpt-5.6-sol', 'gpt-5.6-terra'],
    ...(overrides.providers || {}),
  };
  return createSessionPolicy({
    homeDir: () => home,
    env: overrides.env || {},
    fs: overrides.fs || fs,
    providerRouter: router,
    providers,
    records: overrides.records || (() => []),
    // Deterministic: no history/result caching between assertions.
    historyTtlMs: 0,
  });
}

test('session policy fails closed when provider ports are missing', () => {
  assert.throws(() => createSessionPolicy(), /options are required/);
  assert.throws(() => createSessionPolicy({ providerRouter: {}, providers: {} }), /getProviderSummary/);
  assert.throws(() => createSessionPolicy({
    providerRouter: { getProviderSummary() {} }, providers: {},
  }), /appTypeForCli/);
});

test('terminal configuration never supplies the model; only effort is read', t => {
  const home = tempHome(t);
  // A ccswitch-style rewrite of the terminal's own config: model + routing env.
  writeJson(path.join(home, '.claude', 'settings.json'), {
    model: 'deepseek-flash',
    effort: 'high',
    env: { ANTHROPIC_BASE_URL: 'https://ccswitch.invalid', ANTHROPIC_AUTH_TOKEN: 'switched' },
  });
  writeJson(path.join(home, '.claude', 'settings.local.json'), { thinkingEffort: 'low' });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'),
    'model = "deepseek-flash"\nmodel_reasoning_effort = "medium"\n');
  const policy = createHarness(home);

  // The terminal-default readers are gone: neither lane can pick up the model
  // written by the user's terminal.
  assert.equal(policy.claudeDefaultModel, undefined);
  assert.equal(policy.codexDefaultModel, undefined);
  assert.equal(policy.effectiveSessionModel({ cli: 'claude' }), CLAUDE_FIRST);
  assert.notEqual(policy.effectiveSessionModel({ cli: 'claude' }), 'deepseek-flash');
  assert.equal(policy.effectiveSessionModel({ cli: 'codex' }), 'gpt-5.6-sol');
  assert.notEqual(policy.effectiveSessionModel({ cli: 'codex' }), 'deepseek-flash');
  // Effort is a separate local preference and still follows the terminal.
  assert.equal(policy.claudeDefaultEffort(), 'low', 'settings.local wins');
  assert.equal(policy.codexDefaultReasoningLevel(), 'medium');
  assert.equal(policy.codexReasoningConfigArg({
    cli: 'codex', effort: 'ultra',
  }), 'model_reasoning_effort="ultra"');
  assert.equal(policy.effectiveSessionEffort({ cli: 'claude' }), 'low');
  assert.equal(policy.effectiveSessionEffort({ cli: 'codex' }), 'medium');

  writeJson(path.join(home, '.claude', 'settings.local.json'), { effort: 'max' });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model_reasoning_effort = "high"\n');
  assert.equal(policy.claudeDefaultEffort(), 'max', 'defaults are not cached');
  assert.equal(policy.codexDefaultReasoningLevel(), 'high', 'Codex config is not cached');
});

test('model resolution preserves provider aliases, relays and reported fallbacks', t => {
  const home = tempHome(t);
  writeJson(path.join(home, '.claude', 'settings.json'), { model: 'claude-user' });
  const policy = createHarness(home);

  assert.equal(policy.effectiveSessionModel({
    cli: 'claude', provider: 'alias-provider', model: 'fast',
  }), 'claude-real-fast');
  assert.equal(policy.effectiveSessionModel({
    cli: 'claude', provider: 'alias-provider', model: 'unmapped',
  }), 'unmapped');
  assert.equal(policy.effectiveSessionModel({ cli: 'claude', provider: 'primary' }), 'claude-primary');
  assert.equal(policy.effectiveSessionModel({
    cli: 'claude', provider: 'relay', reportedModel: 'relay-runtime',
  }), 'relay-first', 'a relay picks from its own option list');
  assert.equal(policy.effectiveSessionModel({ cli: 'claude', provider: 'relay' }), 'relay-first',
    'a relay-controlled model must not borrow the local Claude default');
  assert.notEqual(policy.effectiveSessionModel({ cli: 'claude', provider: 'relay' }), 'claude-user');
  assert.equal(policy.effectiveSessionModel({ cli: 'claude', reportedModel: 'runtime' }), CLAUDE_FIRST,
    'the picker list is authoritative when the lane has no explicit selection');
  assert.notEqual(policy.effectiveSessionModel({ cli: 'claude', reportedModel: 'runtime' }), 'claude-user');
  assert.equal(policy.effectiveSessionModel({ cli: 'codex', reportedModel: 'gpt-runtime' }), 'gpt-5.6-sol');
  assert.equal(policy.effectiveSessionModel({ cli: 'codex', reportedModel: 'gpt-runtime', provider: 'codex-official' }),
    'gpt-5.6-sol');
  assert.equal(policy.effectiveSessionModel({ cli: 'opencode' }), null,
    'OpenCode without an explicit provider must use its own native default');
  assert.equal(policy.effectiveSessionModel({ cli: 'opencode', reportedModel: 'opencode-runtime' }),
    'opencode-runtime', 'OpenCode may report its native runtime model without borrowing Claude config');
  assert.equal(policy.effectiveSessionModel({ cli: 'qoder', reportedModel: 'performance' }), 'performance');
  assert.equal(policy.effectiveSessionModel({ cli: 'zcode', model: 'bigmodel/glm-5.2' }), 'bigmodel/glm-5.2');
  assert.equal(policy.effectiveSessionModel({ cli: 'zcode', reportedModel: 'vendor/default' }), 'vendor/default');
  assert.equal(policy.effectiveSessionModel({ cli: 'zcode', provider: 'zcode-primary' }), 'glm-zcode');
  assert.equal(policy.effectiveSessionModel({ cli: 'claude', provider: 'throws', model: 'explicit' }), 'explicit');
  assert.equal(policy.effectiveSessionModel({ cli: 'claude', provider: 'throws' }), null,
    'a stale/unavailable provider never reuses the terminal settings model');
  assert.equal(policy.effectiveSessionModel(null), null);

  assert.deepEqual(policy.serializeSubagent({ providerId: 'alias-provider', model: 'fast' }), {
    providerId: 'alias-provider', model: 'fast', effectiveModel: 'claude-real-fast',
  });
  assert.equal(policy.serializeSubagent({ providerId: 'alias-provider' }), null);
  assert.equal(policy.providerDefaultModel('claude', 'alias-provider'), 'wire-default');
  assert.equal(policy.providerDefaultModel('claude', 'relay'), 'relay-first');
  assert.equal(policy.providerDefaultModel('codex', 'codex-primary'), 'gpt-primary');
  assert.equal(policy.providerDefaultModel('claude', 'throws'), null);
  assert.equal(policy.providerDefaultModel('codex', null), null,
    'Codex profiles keep the historical no-default answer');
  assert.equal(policy.providerDefaultModel('claude', null), CLAUDE_FIRST);
  assert.equal(policy.sessionProviderName({ cli: 'claude', provider: 'primary' }), 'Primary');
  assert.equal(policy.sessionProviderName({ cli: 'claude', provider: 'throws' }), 'throws');
  assert.equal(policy.sessionProviderName({ cli: 'zcode', provider: 'zcode-primary' }), 'ZCode Primary');
  assert.equal(policy.sessionProviderName({ cli: 'zcode', provider: 'stale-provider' }), 'stale-provider');
  assert.equal(policy.sessionProviderBaseUrl({ cli: 'claude', provider: 'relay' }), 'https://relay.invalid');
  assert.equal(policy.sessionProviderBaseUrl({ cli: 'claude', provider: 'primary' }), null);
  assert.equal(policy.sessionProviderBaseUrl({ cli: 'claude', provider: 'throws' }), null);
  assert.equal(policy.sessionProviderBaseUrl({ cli: 'claude' }), null);
});

test('a lane default follows the most frequent explicit selection on that line', t => {
  const records = new Map([
    ['s1', { id: 's1', cli: 'claude', provider: null, model: 'claude-sonnet-5' }],
    // claude-exp is the same lane; official provider ids share the provider-less
    // list, so their explicit picks count toward the same default.
    ['s2', { id: 's2', cli: 'claude-exp', provider: 'claude-official', model: 'claude-sonnet-5' }],
    ['s3', { id: 's3', cli: 'claude', provider: 'claude-official-0123456789abcdef', model: 'claude-sonnet-5' }],
    ['s4', { id: 's4', cli: 'claude', provider: null, model: 'claude-opus-5' }],
    // Provider-scoped picks never show up on another route.
    ['s5', { id: 's5', cli: 'claude', provider: 'dual', model: 'dual-b' }],
    ['s6', { id: 's6', cli: 'claude', provider: 'dual', model: 'dual-b' }],
    ['s7', { id: 's7', cli: 'claude', provider: 'dual', model: 'dual-a' }],
  ]);
  const policy = createHarness(tempHome(t), { records: () => records });

  assert.equal(policy.effectiveSessionModel({ cli: 'claude' }), 'claude-sonnet-5',
    'three sonnet picks beat one opus pick on the official line');
  assert.equal(policy.effectiveSessionModel({ cli: 'claude', provider: 'claude-official' }), 'claude-sonnet-5',
    'an official provider session reads the same official-line history');
  assert.equal(policy.effectiveSessionModel({ cli: 'claude', provider: 'dual' }), 'dual-b',
    'provider lanes count only their own explicit picks');
});

test('a lane default ties resolve to model-list order and ignores stale ids', t => {
  const tie = new Map([
    ['t1', { id: 't1', cli: 'claude', model: 'claude-sonnet-5' }],
    ['t2', { id: 't2', cli: 'claude', model: 'claude-opus-5' }],
  ]);
  const tiePolicy = createHarness(tempHome(t), { records: () => tie });
  assert.equal(tiePolicy.effectiveSessionModel({ cli: 'claude' }), 'claude-opus-5',
    'equal counts pick the earlier list entry (opus-5 precedes sonnet-5)');

  const stale = new Map([
    ['u1', { id: 'u1', cli: 'claude', model: 'deepseek-flash' }],
    ['u2', { id: 'u2', cli: 'claude', model: 'deepseek-flash' }],
  ]);
  const stalePolicy = createHarness(tempHome(t), { records: () => stale });
  assert.equal(stalePolicy.effectiveSessionModel({ cli: 'claude' }), CLAUDE_FIRST,
    'selections that are no longer in the current list never win');
});

test('effort, agent and disconnect policies preserve each CLI contract', t => {
  const policy = createHarness(tempHome(t));

  assert.equal(policy.normalizeEffort(' XHIGH '), 'xhigh');
  assert.equal(policy.normalizeEffort('minimal'), 'minimal');
  assert.equal(policy.normalizeEffort('invalid'), undefined);
  assert.equal(policy.normalizeEffort(''), null);
  assert.equal(policy.validEffortForCli('codex', 'none'), true);
  assert.equal(policy.validEffortForCli('codex', 'minimal'), true);
  assert.equal(policy.validEffortForCli('codex', 'ultra'), true);
  assert.equal(policy.validEffortForCli('codex', 'max'), true);
  assert.equal(policy.validEffortForCli('claude', 'ultra'), false);
  assert.equal(policy.validEffortForCli('opencode', 'minimal'), true);
  assert.equal(policy.validEffortForCli('opencode', 'xhigh'), false);
  assert.equal(policy.validEffortForCli('opencode', 'ultra'), false);
  assert.equal(policy.validEffortForCli('zcode', 'low'), false);
  assert.equal(policy.validEffortForCli('qoder', 'xhigh'), true);
  assert.equal(policy.validEffortForCli('qoder', 'ultracode'), false);
  assert.equal(policy.cliEffortLevel({ effort: 'ultracode' }), 'xhigh');
  assert.equal(policy.codexReasoningLevel({ effort: 'none' }), 'none');
  assert.equal(policy.codexReasoningLevel({ effort: 'minimal' }), 'minimal');
  assert.equal(policy.codexReasoningLevel({ effort: 'ultra' }), 'xhigh');
  assert.equal(policy.codexReasoningLevel({ effort: 'max' }), 'xhigh');
  assert.equal(policy.codexReasoningConfigArg({ effort: 'ultra' }), 'model_reasoning_effort="xhigh"');
  assert.equal(policy.codexReasoningConfigArg({ effort: 'max' }), 'model_reasoning_effort="xhigh"');
  assert.equal(policy.codexReasoningConfigArg({
    effort: 'max', model: 'gpt-5.6-sol',
  }), 'model_reasoning_effort="max"');
  assert.equal(policy.codexReasoningConfigArg({
    effort: 'ultra', effectiveModel: 'openai/gpt-5.6-terra',
  }), 'model_reasoning_effort="ultra"');
  assert.equal(policy.codexReasoningConfigArg({
    cli: 'codex', provider: 'codex-56', effort: 'ultra',
  }), 'model_reasoning_effort="ultra"');
  assert.equal(policy.codexReasoningConfigArg({
    effort: 'max', model: 'gpt-5.60-sol',
  }), 'model_reasoning_effort="xhigh"');
  assert.equal(policy.codexReasoningConfigArg({ effort: 'high' }), 'model_reasoning_effort="high"');
  assert.equal(policy.codexModelConfigArg({ model: ' gpt-5 ' }), 'model="gpt-5"');
  assert.equal(policy.effectiveSessionEffort({ cli: 'opencode', effort: 'minimal' }), 'minimal');
  assert.equal(policy.effectiveSessionEffort({ cli: 'opencode', effort: 'xhigh' }), null);
  assert.equal(policy.effectiveSessionEffort({ cli: 'zcode', effort: 'high' }), null);
  assert.equal(policy.effectiveSessionEffort({ cli: 'qoder', effort: 'high' }), 'high');
  assert.equal(policy.effectiveSessionEffort({ cli: 'qoder' }), null);
  assert.equal(policy.normalizeCliAgent('claude', ' reviewer-1 '), 'reviewer-1');
  assert.equal(policy.normalizeCliAgent('codex', 'reviewer'), undefined);
  assert.equal(policy.normalizeCliAgent('opencode', '../unsafe'), undefined);
  assert.equal(policy.normalizeCliAgent('qoder', 'reviewer'), 'reviewer');
  assert.equal(policy.normalizeCliAgent('claude', ''), null);
  assert.equal(policy.isGlm52Session({ model: 'XOPGLM52' }), true);
  assert.equal(policy.isCodexResponseCompletedDisconnect(
    'stream disconnected before completion: missing response.completed',
  ), true);
  assert.equal(policy.isCodexTransportDisconnect(
    'stream disconnected before completion: error sending request to /backend-api/codex/responses',
  ), true);
  assert.equal(policy.isCodexResponseCompletedDisconnect('response.completed without a disconnect'), false);
  assert.equal(policy.isCodexTransportDisconnect('stream disconnected before completion'), false);
  assert.match(policy.codexStreamDisconnectContinuePrompt(), /不要重复/);
  assert.equal(CODEX_STREAM_DISCONNECT_CONTINUE_MAX, 2);
});

test('explicit CODEX_HOME wins and invalid config falls through to the user home', t => {
  const home = tempHome(t);
  const explicit = path.join(home, 'codex-explicit');
  fs.mkdirSync(explicit, { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(explicit, 'config.toml'), 'model_reasoning_effort = "ultra"\n');
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model_reasoning_effort = "high"\n');
  const env = { CODEX_HOME: explicit };
  const policy = createHarness(home, { env });

  assert.equal(policy.codexDefaultReasoningLevel(), 'xhigh');
  fs.writeFileSync(path.join(explicit, 'config.toml'),
    'model = "gpt-5.6-terra"\nmodel_reasoning_effort = "ultra"\n');
  assert.equal(policy.codexDefaultReasoningLevel(), 'ultra');
  assert.equal(policy.effectiveSessionModel({ cli: 'codex' }), 'gpt-5.6-sol',
    'the lane model list wins over CODEX_HOME config.toml model');
  fs.writeFileSync(path.join(explicit, 'config.toml'), 'model_reasoning_effort = "not-valid"\n');
  assert.equal(policy.codexDefaultReasoningLevel(), 'high');
});

test('reported model note updates CLI state before best-effort persistence', () => {
  const records = new Map([['s1', { id: 's1', reportedModel: null }]]);
  const effects = [];
  const runtime = createReportedModelRuntime({
    records,
    effectiveSessionModel: () => null,
    rememberActiveCliState: record => effects.push(`remember:${record.reportedModel}`),
    saveBestEffort: source => effects.push(`save:${source}`),
  });

  assert.equal(runtime.note('missing', 'model-a'), false);
  assert.equal(runtime.note('s1', '<synthetic>'), false);
  assert.equal(runtime.note('s1', 'model-a'), true);
  assert.equal(records.get('s1').reportedModel, 'model-a');
  assert.deepEqual(effects, ['remember:model-a', 'save:runtime.reported-model']);
  assert.equal(runtime.note('s1', 'model-a'), false);
  assert.equal(effects.length, 2);
});

test('reported model backfill reads the newest valid Claude transcript model once', t => {
  const home = tempHome(t);
  const transcriptDir = path.join(home, '.claude', 'projects', 'project-a');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, 'native-1.jsonl'), [
    JSON.stringify({ type: 'assistant', message: { model: 'claude-old' } }),
    JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-new' } }),
    '',
  ].join('\n'));

  const records = new Map([
    ['eligible', { id: 'eligible', cli: 'claude', cliSessionId: 'native-1' }],
    ['static', { id: 'static', cli: 'claude', cliSessionId: 'native-1' }],
    ['codex', { id: 'codex', cli: 'codex', cliSessionId: 'native-1' }],
    ['known', { id: 'known', cli: 'claude', cliSessionId: 'native-1', reportedModel: 'known-model' }],
  ]);
  const effects = [];
  const runtime = createReportedModelRuntime({
    fs,
    homeDir: () => home,
    records,
    effectiveSessionModel: record => record.id === 'static' ? 'configured-model' : null,
    rememberActiveCliState: () => effects.push('unexpected-remember'),
    saveBestEffort: source => effects.push(`save:${source}`),
    log: message => effects.push(`log:${message}`),
  });

  assert.equal(runtime.backfill(), 1);
  assert.equal(records.get('eligible').reportedModel, 'claude-new');
  assert.equal(records.get('static').reportedModel, undefined);
  assert.equal(records.get('codex').reportedModel, undefined);
  assert.equal(records.get('known').reportedModel, 'known-model');
  assert.deepEqual(effects, [
    'save:startup.reported-model-backfill',
    'log:[multicc] Backfilled reportedModel for 1 session(s) from CLI transcripts',
  ]);
});

test('reported model backfill preserves legacy CLI records and stops at the first transcript file', t => {
  const home = tempHome(t);
  const first = path.join(home, '.claude', 'projects', 'project-a');
  const second = path.join(home, '.claude', 'projects', 'project-b');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(first, 'legacy.jsonl'), `${JSON.stringify({
    type: 'assistant', message: { model: 'legacy-model' },
  })}\n`);
  fs.writeFileSync(path.join(first, 'ambiguous.jsonl'), `${JSON.stringify({
    type: 'assistant', message: { model: '<synthetic>' },
  })}\n`);
  fs.writeFileSync(path.join(second, 'ambiguous.jsonl'), `${JSON.stringify({
    type: 'assistant', message: { model: 'must-not-win' },
  })}\n`);
  const records = new Map([
    ['legacy', { id: 'legacy', cliSessionId: 'legacy' }],
    ['ambiguous', { id: 'ambiguous', cli: 'claude', cliSessionId: 'ambiguous' }],
  ]);
  const saves = [];
  const runtime = createReportedModelRuntime({
    fs,
    homeDir: () => home,
    records,
    effectiveSessionModel: () => null,
    rememberActiveCliState: () => {},
    saveBestEffort: source => saves.push(source),
  });

  assert.equal(runtime.backfill(), 1);
  assert.equal(records.get('legacy').reportedModel, 'legacy-model');
  assert.equal(records.get('ambiguous').reportedModel, undefined);
  assert.deepEqual(saves, ['startup.reported-model-backfill']);
});

test('production composition delegates session policy and reported-model ownership', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /createSessionPolicy\s*\(\s*\{/);
  assert.match(source, /createReportedModelRuntime\s*\(\s*\{/);
  assert.match(source, /const noteReportedModel = reportedModelRuntime\.note/);
  assert.match(source, /const backfillReportedModels = reportedModelRuntime\.backfill/);
  assert.doesNotMatch(source, /function\s+effectiveSessionModel\s*\(/);
  assert.doesNotMatch(source, /function\s+noteReportedModel\s*\(/);
  assert.doesNotMatch(source, /function\s+backfillReportedModels\s*\(/);
});

test('managed Codex defaults never borrow the old DeepSeek local config or reported model', t => {
  const home = tempHome(t);
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "deepseek-flash"\n');
  const summary = { isOfficial: true, model: '', modelOptions: ['gpt-5.4'] };
  const policy = createHarness(home, {
    providerRouter: { getProviderSummary: () => summary },
    providers: { readCodexOfficialModels: () => [] },
  });
  const session = { cli: 'codex', provider: 'codex-official', model: null, reportedModel: 'deepseek-flash' };
  assert.equal(policy.effectiveSessionModel(session), 'gpt-5.4');
  summary.modelOptions = [];
  assert.equal(policy.effectiveSessionModel(session), null,
    'an empty official catalog never resurrects a model reported on another route');
  assert.equal(policy.effectiveSessionModel({ cli: 'codex' }), null,
    'the terminal config.toml model is never used');
  assert.notEqual(policy.effectiveSessionModel({ cli: 'codex' }), 'deepseek-flash');
});


test('Pi thinking levels remain native and never inherit Claude defaults', t => {
  const home = tempHome(t);
  writeJson(path.join(home, '.claude', 'settings.json'), { model: 'claude-only', effort: 'high' });
  const policy = createHarness(home);
  assert.equal(policy.effectiveSessionModel({ cli: 'pi' }), null);
  assert.equal(policy.effectiveSessionEffort({ cli: 'pi' }), null);
  for (const effort of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
    assert.equal(policy.normalizeEffort(effort), effort);
    assert.equal(policy.validEffortForCli('pi', effort), true);
    assert.equal(policy.effectiveSessionEffort({ cli: 'pi', effort }), effort);
  }
  for (const effort of ['none', 'max', 'ultra', 'ultracode']) {
    assert.equal(policy.validEffortForCli('pi', effort), false);
    assert.equal(policy.effectiveSessionEffort({ cli: 'pi', effort }), null);
  }
});
