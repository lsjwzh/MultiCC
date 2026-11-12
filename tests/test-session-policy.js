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
const { CLAUDE_MODELS_FALLBACK, _resetCacheForTest } = require('../src/claude-models');

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

// 原生默认模型缓存：这些用例使用真实 TTL，补充上面禁用缓存的选择规则用例。
function defaultResolver(options = {}) {
  return require('../src/cli/model-default').createModelDefaultResolver({
    history: () => [], now: () => 0, historyTtlMs: 30, ...options,
  });
}
const defaultFacts = extra => ({
  kind: 'effective', cli: 'claude', appType: 'claude', models: ['a', 'b'], ...extra,
});
const modelHistory = model => [{ cli: 'claude-exp', model, provider: null }];

test('原生默认模型缓存：零时钟首次读取、严格 TTL 边界与历史更新', () => {
  let now = 0, reads = 0, selected = 'b';
  const resolve = defaultResolver({ now: () => now, history: () => { reads++; return modelHistory(selected); } });
  assert.equal(resolve(defaultFacts()), 'b');
  assert.equal(reads, 1);
  selected = 'a'; now = 29;
  assert.equal(resolve(defaultFacts()), 'b');
  assert.equal(reads, 1);
  now = 30;
  assert.equal(resolve(defaultFacts()), 'a');
  assert.equal(reads, 2);
  now = -1; selected = 'b';
  assert.equal(resolve(defaultFacts()), 'b', '时钟回退触发刷新');
  assert.equal(reads, 3);
  now = NaN; resolve(defaultFacts()); resolve(defaultFacts());
  assert.equal(reads, 5, '非有限时钟不能无限延长缓存');
});

test('原生默认模型缓存：线路 aliasOnly、official、wireDefault 改变立即生效', () => {
  const resolve = defaultResolver();
  const request = defaultFacts({ kind: 'providerDefault', providerId: 'relay',
    provider: { modelOptions: ['relay-a'], aliasOnly: false }, wireDefaultModel: 'wire-a' });
  assert.equal(resolve(request), 'relay-a');
  request.provider.aliasOnly = true;
  assert.equal(resolve(request), 'wire-a');
  request.wireDefaultModel = 'wire-b';
  assert.equal(resolve(request), 'wire-b');
  request.provider = { modelOptions: [], official: false };
  assert.equal(resolve(request), null);
  request.provider.official = true;
  assert.equal(resolve(request), 'a');
  request.kind = 'effective'; request.reportedModel = 'reported';
  assert.equal(resolve(request), 'a');
  request.provider.official = false;
  // A route that declares no default runs on its own configuration: the
  // session's reportedModel is not route-scoped (after a manual switch it names
  // the previous route's model), so it must never become this route's default.
  assert.equal(resolve(request), null);
});

test('原生默认模型缓存：全局线路标志与分隔符不能碰撞', () => {
  const resolve = defaultResolver();
  const request = defaultFacts({ reportedModel: 'reported' });
  assert.equal(resolve(request), 'a');
  request.globalProviderCli = true;
  assert.equal(resolve(request), 'reported');
  assert.equal(resolve(defaultFacts({ models: ['a\u0001b', 'c'] })), 'a\u0001b');
  assert.equal(resolve(defaultFacts({ models: ['a', 'b\u0001c'] })), 'a');
  assert.equal(resolve(defaultFacts({ models: ['a\u0002b', 'c'] })), 'a\u0002b');
  assert.equal(resolve(defaultFacts({ models: ['a', 'b\u0002c'] })), 'a');
});

test('原生默认模型缓存：缺省历史线路与明确官方线路分别计数', () => {
  const resolve = defaultResolver({ history: () => [{ cli: 'claude', provider: 'relay', model: 'b' }] });
  const request = defaultFacts({ providerId: 'relay', provider: { modelOptions: ['a', 'b'] } });
  assert.equal(resolve(request), 'b');
  request.historyProviderId = null;
  assert.equal(resolve(request), 'a');
  request.historyProviderId = undefined;
  assert.equal(resolve(request), 'b');
});

test('原生默认模型缓存：各实例隔离，禁用 TTL 每次重新读取', () => {
  let reads = 0, selected = 'a';
  const resolve = defaultResolver({ historyTtlMs: 0, history: () => { reads++; return modelHistory(selected); } });
  const other = defaultResolver({ history: () => modelHistory('a') });
  assert.equal(resolve(defaultFacts()), 'a');
  selected = 'b';
  assert.equal(resolve(defaultFacts()), 'b');
  assert.equal(other(defaultFacts()), 'a');
  assert.equal(reads, 2);
});

test('原生默认模型缓存：读取异常或完成时钟异常不发布半成品', () => {
  const failure = new Error('历史读取失败');
  let now = 0, selected = 'a', failRead = false, failClockAt = 0, clocks = 0;
  const resolve = defaultResolver({
    now() { if (++clocks === failClockAt) throw failure; return now; },
    history() { if (failRead) throw failure; return modelHistory(selected); },
  });
  assert.equal(resolve(defaultFacts()), 'a');
  now = 30; selected = 'b'; failRead = true;
  assert.throws(() => resolve(defaultFacts()), error => error === failure);
  now = 0; failRead = false;
  assert.equal(resolve(defaultFacts()), 'a', '旧快照没有被失败读取替换');
  now = 30; failClockAt = clocks + 2;
  assert.throws(() => resolve(defaultFacts()), error => error === failure);
  now = 0;
  assert.equal(resolve(defaultFacts()), 'a', '完成时钟失败也不发布');
  now = 30;
  assert.equal(resolve(defaultFacts()), 'b');
});

test('原生默认模型缓存：回调重入不死锁，也不覆盖已发布的新快照', () => {
  let reads = 0, nested = false, resolve;
  resolve = defaultResolver({ history() {
    reads++;
    if (nested) return modelHistory('b');
    nested = true;
    assert.equal(resolve(defaultFacts()), 'b');
    return modelHistory('a');
  } });
  assert.equal(resolve(defaultFacts()), 'b');
  assert.equal(resolve(defaultFacts()), 'b');
  assert.equal(reads, 2);
});

test('原生默认模型缓存：字段 getter 可重入，输入对象不保存在缓存中', () => {
  const resolve = defaultResolver({ history: () => modelHistory('b') });
  const request = defaultFacts();
  Object.defineProperty(request, 'provider', { get() {
    assert.equal(resolve(defaultFacts()), 'b');
    return null;
  } });
  assert.equal(resolve(request), 'b');
  request.models[1] = 'c';
  assert.equal(resolve(request), 'a');
});

test('原生模型边界保留旧字符串规则，仅访问必要字段且无 JSON 中转', () => {
  const resolve = defaultResolver();
  const request = defaultFacts({ models: [null, 123, ' ', ' 模型😀 ', '模型😀'],
    toJSON() { throw Error('不得调用 JSON 钩子'); } });
  request.unrelated = request;
  Object.defineProperty(request, 'secret', { enumerable: true, get() { throw Error('不得读取无关字段'); } });
  assert.equal(resolve(request), '模型😀');
  assert.equal(resolve(defaultFacts({ models: ['a\ud800b'] })), 'a\ufffdb', '保留旧 lenient JSON 的替换规则');
  assert.equal(resolve(defaultFacts({ models: ['\u0085a\u0085'] })), 'a', '保留既有 Rust trim 规则');
  assert.throws(() => resolve(defaultFacts({ kind: 'unknown' })), /MODEL_DEFAULT_INVALID/);
  assert.throws(() => resolve(null), /MODEL_DEFAULT_INVALID/);
});

test('会话模型门面读取官方记录，线路属性变更不沿用错误默认值', () => {
  let reads = 0;
  const summary = { modelOptions: ['a', 'b'], aliasOnly: false };
  const providers = { WIRE_DEFAULT_MODEL: 'wire-a', appTypeForCli: () => 'claude',
    isOfficialProviderId: (_, id) => id === 'official-account' };
  const policy = createSessionPolicy({ providers, providerRouter: { getProviderSummary: () => summary },
    now: () => 0, records() { reads++; return new Map([
      ['r', { cli: 'claude-exp', provider: 'official-account', model: 'b' }],
    ]); } });
  summary.isOfficial = true;
  assert.equal(policy.effectiveSessionModel({ cli: 'claude', provider: 'relay' }), 'b');
  assert.equal(policy.providerDefaultModel('claude', 'relay'), 'b');
  summary.aliasOnly = true;
  assert.equal(policy.providerDefaultModel('claude', 'relay'), 'wire-a');
  providers.WIRE_DEFAULT_MODEL = 'wire-b';
  assert.equal(policy.providerDefaultModel('claude', 'relay'), 'wire-b');
  assert.equal(reads, 1);
});

test('原生模型所有者不保活已经结束的宿主读回调', () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    const assert = require('node:assert/strict');
    const {getNative} = require('./src/native/runtime');
    const owner = new (getNative().RustModelDefaults)(30000);
    let callback = () => [];
    const weak = new WeakRef(callback);
    assert.equal(owner.resolve({appType:'claude', models:['a']},callback,()=>0),'a');
    callback = null;
    (async()=>{
      for(let i=0;i<30;i++) { await new Promise(setImmediate); global.gc(); }
      assert.equal(weak.deref(), undefined);
      assert.equal(owner.resolve({appType:'claude',models:['b']},()=>{throw Error('缓存应仍有效');},()=>0),'b');
    })().catch(e=>{console.error(e);process.exitCode=1});
  `;
  const child = spawnSync(process.execPath, ['--expose-gc', '-e', script], {
    cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
});
