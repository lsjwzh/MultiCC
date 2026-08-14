'use strict';

// GLM 5.3 fable-tier alias coverage:
//   - src/providers.js: bounded Zhipu fable fill (create / update / summarize
//     projection / spawn env / routing-key strip).
//   - public/manage.js: claude-glm preset prefills the model-mapping editor
//     with fable=glm-5.3 (source-contract assertions — manage.js is a browser
//     script without a vm harness).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zhipu-fable-'));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.MULTICC_DATA_DIR = dataDir;

const providers = require('../src/providers');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const ZHIPU_BASE = 'https://open.bigmodel.cn/api/anthropic';
const USER_TIERS = {
  opus: { model: 'glm-5.2', name: '' },
  sonnet: { model: 'glm-5.1', name: '' },
  haiku: { model: 'glm-5.1', name: '' },
};

test('createProvider persists ANTHROPIC_DEFAULT_FABLE_MODEL=glm-5.3 for Zhipu, keeping existing tier mappings', () => {
  const { id } = providers.createProvider({
    appType: 'claude',
    name: 'Zhipu Test',
    baseUrl: ZHIPU_BASE,
    authToken: 'test-token',
    model: 'glm-5.2',
    models: 'glm-5.2\nglm-5.1',
    aliasMap: { ...USER_TIERS },
  });
  const summary = providers.getProviderSummary('claude', id);
  assert.equal(summary.aliasMap.fable.model, 'glm-5.3');
  assert.equal(summary.aliasMap.fable.name, 'GLM5.3');
  // 5.2/5.1 compat tiers survive untouched.
  assert.equal(summary.aliasMap.opus.model, 'glm-5.2');
  assert.equal(summary.aliasMap.sonnet.model, 'glm-5.1');
  assert.equal(summary.aliasMap.haiku.model, 'glm-5.1');
  assert.ok(summary.modelOptions.includes('glm-5.3'));
});

test('a non-empty custom fable mapping is never overwritten', () => {
  const { id } = providers.createProvider({
    appType: 'claude',
    name: 'Zhipu Custom Fable',
    baseUrl: ZHIPU_BASE,
    authToken: 'test-token',
    model: 'glm-5.2',
    aliasMap: { ...USER_TIERS, fable: { model: 'my-own-model', name: '' } },
  });
  const summary = providers.getProviderSummary('claude', id);
  assert.equal(summary.aliasMap.fable.model, 'my-own-model');
});

test('non-Zhipu providers get no fable fill', () => {
  const { id } = providers.createProvider({
    appType: 'claude',
    name: 'DeepSeek Test',
    baseUrl: 'https://api.deepseek.com/anthropic',
    authToken: 'test-token',
    model: 'deepseek-chat',
    aliasMap: { opus: { model: 'deepseek-chat', name: '' } },
  });
  const summary = providers.getProviderSummary('claude', id);
  assert.equal(summary.aliasMap.fable, undefined);
});

test('legacy Zhipu provider without a fable row sees the fill in summarize() without disk migration', () => {
  // Reproduces the real pre-5.3 config shape: opus→glm-5.2, sonnet/haiku→glm-5.1.
  const { id } = providers.createProvider({
    appType: 'claude',
    name: 'Legacy Zhipu',
    baseUrl: ZHIPU_BASE,
    authToken: 'test-token',
    model: 'glm-5.2',
    models: 'glm-5.2\nglm-5.1',
    aliasMap: { ...USER_TIERS },
  });
  const storeFile = path.join(dataDir, 'providers.json');
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  const entry = store.find(p => p.id === id);
  // Strip the persisted fable fill to emulate a legacy config written before
  // this feature existed.
  delete entry.settingsConfig.env.ANTHROPIC_DEFAULT_FABLE_MODEL;
  delete entry.settingsConfig.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME;
  fs.writeFileSync(storeFile, JSON.stringify(store, null, 2));

  const summary = providers.getProviderSummary('claude', id);
  assert.equal(summary.aliasMap.fable.model, 'glm-5.3');
  assert.equal(summary.aliasMap.opus.model, 'glm-5.2');
  assert.ok(summary.modelOptions.includes('glm-5.3'));
  // Projection must not mutate the stored config.
  const after = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
    .find(p => p.id === id);
  assert.equal(after.settingsConfig.env.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);

  // The spawn boundary routes fable sessions even before any re-save.
  const spawn = providers.resolveSpawnEnv({ cli: 'claude', provider: id });
  assert.equal(spawn.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'glm-5.3');

  // An edit-save persists the fill (fable empty in the submitted aliasMap).
  providers.updateProvider('claude', id, { aliasMap: { ...USER_TIERS } });
  const saved = providers.getProviderSummary('claude', id);
  assert.equal(saved.aliasMap.fable.model, 'glm-5.3');
});

test('edit-save respects a custom fable set from the form', () => {
  const { id } = providers.createProvider({
    appType: 'claude',
    name: 'Zhipu Edit Custom',
    baseUrl: ZHIPU_BASE,
    authToken: 'test-token',
    model: 'glm-5.2',
  });
  providers.updateProvider('claude', id, {
    aliasMap: { ...USER_TIERS, fable: { model: 'glm-5.2', name: '' } },
  });
  const summary = providers.getProviderSummary('claude', id);
  assert.equal(summary.aliasMap.fable.model, 'glm-5.2');
});

test('ANTHROPIC_DEFAULT_FABLE_MODEL is stripped from the inherited server env for claude children', () => {
  const base = { ANTHROPIC_DEFAULT_FABLE_MODEL: 'leaked-model' };
  const child = providers.buildChildEnv(base, { cli: 'claude', provider: null }, {});
  assert.equal(child.env.ANTHROPIC_DEFAULT_FABLE_MODEL, undefined);
  assert.ok(providers.CLAUDE_ROUTING_KEYS.includes('ANTHROPIC_DEFAULT_FABLE_MODEL'));
});

test('manage.js claude-glm preset prefills fable=glm-5.3 in the model-mapping editor', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'manage.js'), 'utf8');
  const presetLine = src.split('\n').find(l => /key: 'claude-glm'/.test(l));
  assert.ok(presetLine, 'claude-glm preset exists');
  assert.match(presetLine, /aliasMap:\s*\{\s*fable:\s*\{\s*model:\s*'glm-5\.3'/);
  assert.match(presetLine, /name:\s*'GLM5\.3'/);
  // applyProviderPreset must wire the preset aliasMap into the mapping rows
  // and clear them when the preset is deselected.
  assert.match(src, /fillAliasMapFields\('prov-new-alias',\s*document,\s*preset\.aliasMap \|\| null\)/);
  assert.match(src, /if \(!preset\) \{[\s\S]*?fillAliasMapFields\('prov-new-alias', document, null\)/);
});
