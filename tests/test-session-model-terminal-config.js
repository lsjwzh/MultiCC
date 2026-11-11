'use strict';

// Regression for the ccswitch bug: a terminal switched to deepseek rewrites
// ~/.claude/settings.json (model + env) and ~/.codex/config.toml (model). Those
// files belong to the terminal; a MultiCC session must pick its model from the
// lane's own model list, keep the official Claude account on its own settings
// override, and never forward the terminal's model.
//
// Everything runs against an isolated temp HOME: the real ~/.claude,
// ~/.codex and ~/.multicc are never touched.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-terminal-config-'));
const previousHome = process.env.HOME;
const previousDataDir = process.env.MULTICC_DATA_DIR;
process.env.HOME = HOME;
process.env.MULTICC_DATA_DIR = path.join(HOME, 'multicc-data');
process.on('exit', () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousDataDir === undefined) delete process.env.MULTICC_DATA_DIR;
  else process.env.MULTICC_DATA_DIR = previousDataDir;
  fs.rmSync(HOME, { recursive: true, force: true });
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

// The terminal's own config, rewritten by ccswitch.
writeJson(path.join(HOME, '.claude', 'settings.json'), {
  model: 'deepseek-flash',
  env: {
    ANTHROPIC_BASE_URL: 'https://ccswitch.invalid',
    ANTHROPIC_AUTH_TOKEN: 'ccswitch-token',
    ANTHROPIC_MODEL: 'deepseek-flash',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
  },
});
fs.mkdirSync(path.join(HOME, '.codex'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.codex', 'config.toml'),
  'model = "deepseek-flash"\nmodel_provider = "deepseek"\n');

// The host enables the unified official-provider catalog at boot; the official
// id shape is only recognized after that. Isolated temp HOME keeps this local.
require('../src/providers/core').enableUnifiedOfficialProviders();

const { createSessionPolicy } = require('../src/cli/session-policy');
const { createClaudeAdapter } = require('../src/cli-adapters/claude');
const { createCodexAdapter } = require('../src/cli-adapters/codex');
const { createCodexExpAdapter } = require('../src/cli-adapters/codex-exp');
const { settingsOverrideFor } = require('../src/providers/claude-settings-override');
const { claudeSettingsExtra } = require('../src/chat/turn-engine');
const { CLAUDE_MODELS_FALLBACK, _resetCacheForTest } = require('../src/claude-models');

_resetCacheForTest();
const CLAUDE_FIRST = CLAUDE_MODELS_FALLBACK[0].model;

function officialSummary(appType, providerId) {
  return {
    id: providerId,
    appType,
    name: `${appType} official`,
    isOfficial: true,
    model: null,
    modelOptions: [],
  };
}

const policy = createSessionPolicy({
  homeDir: () => HOME,
  env: {},
  providerRouter: {
    getProviderSummary(appType, providerId) {
      if (!providerId) return null;
      if (providerId === 'claude-official' || providerId.startsWith('claude-official-')) {
        return officialSummary('claude', providerId);
      }
      if (providerId === 'codex-official' || providerId.startsWith('codex-official-')) {
        return officialSummary('codex', providerId);
      }
      return null;
    },
  },
  providers: {
    WIRE_DEFAULT_MODEL: 'claude-sonnet-4-5',
    appTypeForCli: cli => (cli === 'codex' || cli === 'codex-exp' ? 'codex'
      : (cli === 'claude' || cli === 'claude-exp' ? 'claude' : null)),
    isOfficialProviderId: (appType, providerId) => typeof providerId === 'string'
      && (providerId === `${appType}-official` || providerId.startsWith(`${appType}-official-`)),
    readCodexOfficialModels: () => ['gpt-5.6-sol', 'gpt-5.6-terra'],
  },
  records: () => [],
  historyTtlMs: 0,
});

function envelope(spawnOpts) {
  return {
    spawnOpts: {
      mode: 'process',
      rawModel: null,
      rawEffort: null,
      rawAgent: null,
      providerModel: null,
      providerModels: [],
      skipDefaultModel: false,
      maxTurns: 0,
      ...spawnOpts,
    },
    contextLayers: [],
    userText: 'hello',
    suffix: '',
    rolePrompt: '',
    historyHandle: { isFirstTurn: true, cliSessionId: 'native-1' },
  };
}

const claude = createClaudeAdapter({
  cmd: 'claude',
  resolveSessionWireModel: (model, options) => (options && options.providerModel)
    || model || (options && options.defaultModel) || null,
  cliEffortLevel: () => null,
  normalizeEffort: () => null,
  chatDisallowedTools: [],
  multiccImgHint: '',
  debugLogClaudeInvoke: () => {},
});

// ── Claude official lane ──────────────────────────────────────────────────
const claudeSession = { cli: 'claude', provider: 'claude-official', model: null };
const claudeModel = policy.effectiveSessionModel(claudeSession);
assert.equal(claudeModel, CLAUDE_FIRST, 'official lane picks the first model-list entry');
assert.notEqual(claudeModel, 'deepseek-flash');

const claudeInvocation = claude.buildInvocation(envelope({ effectiveModel: claudeModel }));
const claudeModelIndex = claudeInvocation.args.indexOf('--model');
assert.ok(claudeModelIndex > -1, 'claude spawn passes an explicit --model');
assert.equal(claudeInvocation.args[claudeModelIndex + 1], CLAUDE_FIRST);
assert.ok(!claudeInvocation.args.some(arg => String(arg).includes('deepseek')),
  'the terminal-switched model never reaches the spawn args');

// ── official settings override (higher precedence than ~/.claude/settings.json)
const extra = claudeSettingsExtra({ settings: {} },
  { rawModel: null, effectiveModel: claudeModel }, { providerId: 'claude-official' }, 'claude');
assert.deepEqual(extra, { model: CLAUDE_FIRST },
  'official claude session carries its chosen model into the override');
assert.deepEqual(claudeSettingsExtra({ settings: {} },
  { rawModel: null, effectiveModel: CLAUDE_FIRST }, {}, 'claude'),
{ model: CLAUDE_FIRST }, 'provider-less claude sessions are the official lane too');
assert.deepEqual(claudeSettingsExtra({ settings: {} },
  { rawModel: null, effectiveModel: CLAUDE_FIRST }, { providerId: 'relay' }, 'claude'),
{}, 'provider lanes stay --model driven');
assert.deepEqual(claudeSettingsExtra({ settings: { ultracode: true } },
  { rawModel: null, effectiveModel: CLAUDE_FIRST }, {}, 'codex'),
{ ultracode: true }, 'codex sessions get no claude settings extras');

const overrideFile = settingsOverrideFor('terminal-config-session',
  { MULTICC_SESSION_ID: 'terminal-config-session' }, extra);
assert.ok(overrideFile, 'official lane always writes the per-session settings file');
const overrideDoc = JSON.parse(fs.readFileSync(overrideFile, 'utf8'));
assert.equal(overrideDoc.model, CLAUDE_FIRST, 'override file pins the chosen model');
for (const key of [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]) {
  assert.equal(overrideDoc.env[key], '', `${key} blanked so ccswitch env cannot survive`);
}
assert.ok(!JSON.stringify(overrideDoc).includes('deepseek'),
  'the terminal settings never leak into the override file');

// ── Codex official lane ──────────────────────────────────────────────────
const codexSession = { cli: 'codex', provider: 'codex-official', model: null };
const codexModel = policy.effectiveSessionModel(codexSession);
assert.equal(codexModel, 'gpt-5.6-sol', 'codex official lane picks its own first list entry');
assert.notEqual(codexModel, 'deepseek-flash');

const codex = createCodexAdapter({
  cmd: 'codex',
  args: [],
  codexReasoningConfigArg: () => null,
  codexModelConfigArg: policy.codexModelConfigArg,
  multiccImgHint: '',
  envConstraint: '',
  stayAlivePrompt: '',
});
const codexInvocation = codex.buildInvocation(envelope({ effectiveModel: codexModel }));
assert.ok(codexInvocation.args.includes('model="gpt-5.6-sol"'),
  'codex spawn passes an explicit model instead of falling back to config.toml');
assert.ok(!codexInvocation.args.join(' ').includes('deepseek'),
  'codex config.toml model never reaches the spawn args');

const codexExp = createCodexExpAdapter({ codexCmd: 'codex' });
const codexExpInvocation = codexExp.buildInvocation(envelope({ effectiveModel: codexModel }));
const codexExpModelIndex = codexExpInvocation.args.indexOf('--model');
assert.ok(codexExpModelIndex > -1, 'codex-exp spawn passes an explicit --model');
assert.equal(codexExpInvocation.args[codexExpModelIndex + 1], 'gpt-5.6-sol');
assert.equal(codexExpInvocation.turnOptions.model, 'gpt-5.6-sol',
  'codex-exp per-turn model is explicit too');

// ── a terminal model in the user list is not a picker entry ──────────────
const claudeExpModel = policy.effectiveSessionModel({ cli: 'claude-exp', provider: null, model: null });
assert.equal(claudeExpModel, CLAUDE_FIRST, 'claude-exp shares the claude lane list');

console.log('terminal config isolation: all assertions passed');
