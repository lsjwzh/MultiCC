'use strict';

// The Claude half of the "never let a spawn dial the provider directly"
// guarantee: every Claude process the host launches must reach its provider
// through the local claude-proxy whenever a local endpoint exists, and the
// spawn must fail rather than quietly connect to the vendor endpoint.
//
// The choke point under test is providers.applyClaudeProxyEnv (core.js), which
// all three spawn paths call — chat turns, the persistent streaming process and
// the interactive tmux terminal. They all ignored its boolean return before, so
// the enforcement now lives inside the function itself.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertClaudeProxyEnvApplied,
  claudeProxyEnvRequired,
} = require('../src/providers/claude-proxy-policy');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-claude-proxy-policy-'));
const original = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  MULTICC_DATA_DIR: process.env.MULTICC_DATA_DIR,
};
process.env.HOME = path.join(root, 'home');
process.env.USERPROFILE = process.env.HOME;
process.env.MULTICC_DATA_DIR = path.join(root, 'data');
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.MULTICC_DATA_DIR, { recursive: true });

const providers = require('../src/providers/core');

test.after(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('a bound provider route is required exactly when the host can serve it locally', () => {
  assert.equal(claudeProxyEnvRequired({ providerId: 'p', summary: { baseUrl: 'https://relay.example' } }), true);
  assert.equal(claudeProxyEnvRequired({ providerId: 'p', summary: { baseUrl: '', builtinOfficial: true } }), true,
    'the built-in official entry is forced onto the proxy by core.applyClaudeProxyEnv');
  // Nothing local to forward to: the CLI's own login reaches Anthropic either
  // way, and requiring the rewrite here is what 502'd such sessions before.
  assert.equal(claudeProxyEnvRequired({ providerId: 'p', summary: { baseUrl: '', isOfficial: true } }), false);
  // An unresolvable or stale binding fails closed, like resolveSpawnEnv does for
  // zcode/kimi, instead of degrading into a native request on the operator's own
  // account.
  assert.equal(claudeProxyEnvRequired({ providerId: 'deleted', summary: null }), true);
  // No provider at all keeps the default-login path.
  assert.equal(claudeProxyEnvRequired({ providerId: '', summary: null }), false);
  assert.equal(claudeProxyEnvRequired({ providerId: '_default_', summary: null }), false);
  assert.throws(
    () => assertClaudeProxyEnvApplied({ required: true, applied: false }),
    error => error && error.code === 'CLAUDE_PROXY_ENV_REQUIRED',
  );
});

test('a provider-backed claude spawn is rewritten onto the local proxy', () => {
  const provider = providers.createProvider({
    appType: 'claude',
    name: 'Relay fixture',
    baseUrl: 'https://relay.example',
    authToken: 'relay-fixture-key',
    model: 'claude-sonnet-4-5',
  });
  const env = { ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_API_KEY: 'relay-fixture-key' };
  providers.applyClaudeProxyEnv(env, {
    providerId: provider.id, sessionId: 'sess-fixture', port: 4321, enabled: true,
  });
  assert.equal(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:4321/claude-proxy/${provider.id}/sess-fixture`);
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'the real provider credential never reaches the child env');
  assert.match(env.ANTHROPIC_AUTH_TOKEN, /^cpr-sess-fixture$/, 'the child carries only the virtual route token');
});

test('a route that cannot be realized refuses to spawn instead of connecting directly', () => {
  const provider = providers.createProvider({
    appType: 'claude',
    name: 'Stale route fixture',
    baseUrl: 'https://stale-route.example',
    authToken: 'stale-route-key',
    model: 'claude-sonnet-4-5',
  });
  const env = { ANTHROPIC_BASE_URL: 'https://stale-route.example' };
  // No session id / no port: cli-provider-router declines to rewrite, so the
  // child would have kept the vendor URL it was handed.
  for (const options of [
    { providerId: provider.id, sessionId: '', port: 4321, enabled: true },
    { providerId: provider.id, sessionId: 'sess-fixture', port: 0, enabled: true },
    { providerId: 'deleted-provider-id', sessionId: 'sess-fixture', port: 4321, enabled: true },
  ]) {
    assert.throws(
      () => providers.applyClaudeProxyEnv({ ...env }, options),
      error => error && error.code === 'CLAUDE_PROXY_ENV_REQUIRED',
      JSON.stringify(options),
    );
  }
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://stale-route.example', 'no partial rewrite on refusal');
});

test('a base-less OAuth passthrough entry keeps its documented bypass', () => {
  const provider = providers.createProvider({
    appType: 'claude',
    name: 'OAuth passthrough fixture',
    settingsConfig: { env: {} },
  });
  const env = {};
  // Nothing to forward to, on any setting: never a refusal, never a rewrite.
  assert.equal(providers.applyClaudeProxyEnv(env, {
    providerId: provider.id, sessionId: 'sess-fixture', port: 4321, enabled: true,
  }), false);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(providers.applyClaudeProxyEnv(env, { providerId: '', enabled: true }), false);
});

test('the official login is routed through the local proxy too', () => {
  providers.enableUnifiedOfficialProviders();
  const summary = providers.getProviderSummary('claude', 'claude-official');
  assert.equal(summary.builtinOfficial, true, 'the built-in official entry is recognised');
  assert.equal(claudeProxyEnvRequired({ providerId: 'claude-official', summary }), true);
  const env = { CLAUDE_CODE_OAUTH_TOKEN: 'keychain-oauth-fixture' };
  providers.applyClaudeProxyEnv(env, {
    providerId: 'claude-official', sessionId: 'sess-official', port: 4321, enabled: true,
  });
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4321/claude-proxy/claude-official/sess-official');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, '', 'the OAuth token stays host-side');
});

// A rewritten ANTHROPIC_BASE_URL is only binding while no alternate transport is
// switched on: with Bedrock/Vertex/Foundry enabled the CLI ignores the base URL
// it was handed and dials the cloud endpoint from these keys instead, so an
// untouched CLAUDE_CODE_USE_* would smuggle a direct route out of a spawn that
// looks (and asserts) routed.
const ALT_TRANSPORT_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
];

test('a routed spawn turns the alternate transports off, in the env and in the settings file', () => {
  const provider = providers.createProvider({
    appType: 'claude',
    name: 'Alt transport fixture',
    baseUrl: 'https://relay.example',
    authToken: 'relay-fixture-key',
    model: 'claude-sonnet-4-5',
  });
  const env = {
    ANTHROPIC_BASE_URL: 'https://bedrock.example',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.example',
    AWS_BEARER_TOKEN_BEDROCK: 'aws-fixture',
    CLAUDE_CODE_USE_VERTEX: '1',
    ANTHROPIC_VERTEX_BASE_URL: 'https://vertex.example',
    ANTHROPIC_VERTEX_PROJECT_ID: 'project-fixture',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    ANTHROPIC_FOUNDRY_BASE_URL: 'https://foundry.example',
    ANTHROPIC_FOUNDRY_API_KEY: 'foundry-fixture-key',
  };
  providers.applyClaudeProxyEnv(env, {
    providerId: provider.id, sessionId: 'sess-alt', port: 4321, enabled: true,
  });
  assert.equal(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:4321/claude-proxy/${provider.id}/sess-alt`);
  for (const key of ALT_TRANSPORT_KEYS) assert.equal(env[key], '', key);
  // Ambient cloud credentials stay: the CLI reaches for Bedrock only via
  // CLAUDE_CODE_USE_BEDROCK (now blank), while the operator's own AWS tooling in
  // the session's Bash inherits this env and still needs its token.
  assert.equal(env.AWS_BEARER_TOKEN_BEDROCK, 'aws-fixture');
  // Settings files merge per key, so a ~/.claude/settings.json that enables
  // Bedrock would come back on top of the process env unless the blank is
  // mirrored into the session's own --settings file as well.
  const mirrored = JSON.parse(fs.readFileSync(providers.settingsOverrideFor('sess-alt', env), 'utf8')).env;
  for (const key of ALT_TRANSPORT_KEYS) assert.equal(mirrored[key], '', `settings ${key}`);
});

test('spawns that claim no local route keep their env untouched', () => {
  // Provider-less sessions and the CLAUDE_PROXY_ENABLED=0 escape hatch both mean
  // "do not route me" — blanking transport keys there would be a different
  // change with a different blast radius.
  const bare = { CLAUDE_CODE_USE_BEDROCK: '1' };
  assert.equal(providers.applyClaudeProxyEnv(bare, { providerId: '', enabled: true }), false);
  assert.equal(bare.CLAUDE_CODE_USE_BEDROCK, '1');
  const hatch = { CLAUDE_CODE_USE_BEDROCK: '1' };
  assert.equal(providers.applyClaudeProxyEnv(hatch, { providerId: 'deleted-provider-id', enabled: false }), false);
  assert.equal(hatch.CLAUDE_CODE_USE_BEDROCK, '1');
});
