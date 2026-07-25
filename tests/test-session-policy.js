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
    ['claude:alias-provider', {
      id: 'alias-provider', name: 'Aliases', aliasOnly: true,
      aliasMap: { fast: { model: 'claude-real-fast' } },
      modelOptions: ['fast'],
    }],
    ['claude:relay', {
      id: 'relay', name: 'Relay', baseUrl: 'https://relay.invalid',
      model: null, modelOptions: ['relay-first'],
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
  const providers = overrides.providers || {
    WIRE_DEFAULT_MODEL: 'wire-default',
    appTypeForCli: cli => cli === 'codex'
      ? 'codex'
      : (cli === 'claude' || cli === 'opencode' ? 'claude' : null),
  };
  return createSessionPolicy({
    homeDir: () => home,
    env: overrides.env || {},
    fs: overrides.fs || fs,
    providerRouter: router,
    providers,
  });
}

test('session policy fails closed when provider ports are missing', () => {
  assert.throws(() => createSessionPolicy(), /options are required/);
  assert.throws(() => createSessionPolicy({ providerRouter: {}, providers: {} }), /getProviderSummary/);
  assert.throws(() => createSessionPolicy({
    providerRouter: { getProviderSummary() {} }, providers: {},
  }), /appTypeForCli/);
});

test('user configuration defaults are read on demand for Claude and Codex', t => {
  const home = tempHome(t);
  writeJson(path.join(home, '.claude', 'settings.json'), { model: 'claude-user', effort: 'high' });
  writeJson(path.join(home, '.claude', 'settings.local.json'), { thinkingEffort: 'low' });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'),
    'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"\n');
  const policy = createHarness(home);

  assert.equal(policy.claudeDefaultModel(), 'claude-user');
  assert.equal(policy.codexDefaultModel(), 'gpt-5.6-sol');
  assert.equal(policy.claudeDefaultEffort(), 'low', 'settings.local wins');
  assert.equal(policy.codexDefaultReasoningLevel(), 'medium');
  assert.equal(policy.effectiveSessionModel({ cli: 'codex' }), 'gpt-5.6-sol');
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
  }), 'relay-runtime');
  assert.equal(policy.effectiveSessionModel({ cli: 'claude', provider: 'relay' }), null,
    'a relay-controlled model must not borrow the local Claude default');
  assert.equal(policy.effectiveSessionModel({ cli: 'claude', reportedModel: 'runtime' }), 'claude-user');
  assert.equal(policy.effectiveSessionModel({ cli: 'codex', reportedModel: 'gpt-runtime' }), 'gpt-runtime');
  assert.equal(policy.effectiveSessionModel({ cli: 'opencode' }), null,
    'OpenCode without an explicit provider must use its own native default');
  assert.equal(policy.effectiveSessionModel({ cli: 'opencode', reportedModel: 'opencode-runtime' }),
    'opencode-runtime', 'OpenCode may report its native runtime model without borrowing Claude config');
  assert.equal(policy.effectiveSessionModel({ cli: 'qoder', reportedModel: 'performance' }), 'performance');
  assert.equal(policy.effectiveSessionModel({ cli: 'zcode', model: 'bigmodel/glm-5.2' }), 'bigmodel/glm-5.2');
  assert.equal(policy.effectiveSessionModel({ cli: 'zcode', reportedModel: 'vendor/default' }), 'vendor/default');
  assert.equal(policy.effectiveSessionModel({ cli: 'zcode', provider: 'zcode-primary' }), 'glm-zcode');
  assert.equal(policy.effectiveSessionModel({ cli: 'claude', provider: 'throws', model: 'explicit' }), 'explicit');
  assert.equal(policy.effectiveSessionModel({ cli: 'claude', provider: 'throws' }), 'claude-user');
  assert.equal(policy.effectiveSessionModel(null), null);

  assert.deepEqual(policy.serializeSubagent({ providerId: 'alias-provider', model: 'fast' }), {
    providerId: 'alias-provider', model: 'fast', effectiveModel: 'claude-real-fast',
  });
  assert.equal(policy.serializeSubagent({ providerId: 'alias-provider' }), null);
  assert.equal(policy.providerDefaultModel('claude', 'alias-provider'), 'wire-default');
  assert.equal(policy.providerDefaultModel('claude', 'relay'), 'relay-first');
  assert.equal(policy.providerDefaultModel('codex', 'codex-primary'), 'gpt-primary');
  assert.equal(policy.providerDefaultModel('claude', null), 'claude-user');
  assert.equal(policy.sessionProviderName({ cli: 'claude', provider: 'primary' }), 'Primary');
  assert.equal(policy.sessionProviderName({ cli: 'claude', provider: 'throws' }), 'throws');
  assert.equal(policy.sessionProviderName({ cli: 'zcode', provider: 'zcode-primary' }), 'ZCode Primary');
  assert.equal(policy.sessionProviderName({ cli: 'zcode', provider: 'stale-provider' }), 'stale-provider');
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
