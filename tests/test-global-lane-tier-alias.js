'use strict';

// Global-pool lanes (OpenCode / ZCode) generate a provider config that carries
// literal wire model ids — they have no ANTHROPIC_DEFAULT_<TIER>_MODEL layer
// like the Claude CLI. A Claude tier alias (opus/sonnet/haiku/fable/default)
// left on the session must therefore be expanded through the provider's
// aliasMap at route-build time.
//
// Regression (2026-09-26, session task-437d64071fd3609006e5ef23fcc4e230): an
// opencode session saved model=opus onto a DeepSeek relay whose aliasMap maps
// opus -> deepseek-v4-flash. The generated config registered a model literally
// named "opus", the upstream got `model: "opus"` and the turn died with
//   400 invalid_request_error: The supported API model names are
//   deepseek-flash, deepseek-v4-pro, but you passed opus.
// The PATCH guard accepted the tier (the provider maps it), so nothing else
// stopped it — the fix belongs at the route boundary, tested here through the
// public resolveSpawnEnv entry point.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-global-lane-tier-'));
process.env.MULTICC_DATA_DIR = path.join(root, 'data');
process.env.HOME = path.join(root, 'home');
fs.mkdirSync(process.env.MULTICC_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });

// Data root and the ZCode/Kimi home roots resolve at require time, so both
// environment overrides must be in place before the module loads.
const providers = require('../src/providers/core.js');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const MAPPED = {
  opus: { model: 'deepseek-v4-flash', name: '' },
  sonnet: { model: 'deepseek-v4-flash', name: '' },
  haiku: { model: 'deepseek-v4-flash', name: '' },
};

function makeProvider(name, aliasMap) {
  const { id } = providers.createProvider({
    appType: 'claude',
    name,
    baseUrl: 'https://api.deepseek.com/anthropic',
    authToken: 'test-token',
    model: 'deepseek-flash',
    models: 'deepseek-flash\ndeepseek-v4-flash',
    aliasMap,
  });
  return id;
}

function opencodeConfig(route, providerId) {
  const cfg = JSON.parse(route.env.OPENCODE_CONFIG_CONTENT);
  return { cfg, block: cfg.provider[`multicc-${providerId}`] };
}

test('opencode: a mapped tier reaches the wire as the mapped model id', () => {
  const id = makeProvider('Tier Mapped', MAPPED);
  const route = providers.resolveSpawnEnv({ id: 's-open-1', cli: 'opencode', provider: id, model: 'opus' });

  assert.equal(route.qualifiedModel, `multicc-${id}/deepseek-v4-flash`);
  const { cfg, block } = opencodeConfig(route, id);
  assert.deepEqual(cfg.enabled_providers, [`multicc-${id}`]);
  // The tier word is never registered as a model — that is what leaked upstream.
  assert.deepEqual(Object.keys(block.models).sort(), ['deepseek-flash', 'deepseek-v4-flash']);
  assert.ok(route.providerModels.includes('deepseek-v4-flash'));
  assert.ok(!route.providerModels.includes('opus'));
});

test('opencode: an unmapped tier falls back to the provider primary model', () => {
  const id = makeProvider('Tier Unmapped', { opus: { model: '', name: '' } });
  const route = providers.resolveSpawnEnv({ id: 's-open-2', cli: 'opencode', provider: id, model: 'opus' });

  assert.equal(route.qualifiedModel, `multicc-${id}/deepseek-flash`);
  const { block } = opencodeConfig(route, id);
  assert.ok(!Object.keys(block.models).includes('opus'));
});

test('opencode: a concrete model id is passed through untouched', () => {
  const id = makeProvider('Concrete Model', MAPPED);
  const route = providers.resolveSpawnEnv({
    id: 's-open-3', cli: 'opencode', provider: id, model: 'deepseek-v4-flash',
  });
  assert.equal(route.qualifiedModel, `multicc-${id}/deepseek-v4-flash`);
});

test('zcode: the generated config.json carries the mapped model, not the tier', () => {
  const id = makeProvider('ZCode Tier Mapped', MAPPED);
  const route = providers.resolveSpawnEnv({ id: 's-zcode-1', cli: 'zcode', provider: id, model: 'opus' });

  assert.equal(route.qualifiedModel, `multicc-${id}/deepseek-v4-flash`);
  assert.equal(route.zcodeHome, route.env.HOME);
  const cfg = JSON.parse(fs.readFileSync(route.env.ZCODE_SETTINGS, 'utf8'));
  assert.equal(cfg.model, `multicc-${id}/deepseek-v4-flash`);
  assert.ok(!Object.keys(cfg.provider[`multicc-${id}`].models).includes('opus'));
});

test('zcode: an unmapped tier falls back to the provider primary model', () => {
  const id = makeProvider('ZCode Tier Unmapped', {});
  const route = providers.resolveSpawnEnv({ id: 's-zcode-2', cli: 'zcode', provider: id, model: 'sonnet' });

  assert.equal(route.qualifiedModel, `multicc-${id}/deepseek-flash`);
  const cfg = JSON.parse(fs.readFileSync(route.env.ZCODE_SETTINGS, 'utf8'));
  assert.equal(cfg.model, `multicc-${id}/deepseek-flash`);
  assert.ok(!Object.keys(cfg.provider[`multicc-${id}`].models).includes('sonnet'));
});
