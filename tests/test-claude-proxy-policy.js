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

// Provider records reach the router either as an object or as a JSON string.
function configOf(provider) {
  const raw = provider.settingsConfig;
  return typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
}

test.after(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('every concrete provider route must go through the local hop', () => {
  assert.equal(claudeProxyEnvRequired({ providerId: 'p', summary: { baseUrl: 'https://relay.example' } }), true);
  assert.equal(claudeProxyEnvRequired({ providerId: 'p', summary: { baseUrl: '', builtinOfficial: true } }), true,
    'the built-in official entry is served by the proxy official branch');
  // Base-less OAuth passthrough used to be exempt here ("nothing local to
  // forward to"), which let the CLI dial Anthropic directly. The proxy's
  // official branch serves that shape, so no summary may authorise a bypass.
  assert.equal(claudeProxyEnvRequired({ providerId: 'p', summary: { baseUrl: '', isOfficial: true } }), true);
  assert.equal(claudeProxyEnvRequired({ providerId: 'p', summary: {} }), true);
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

test('a base-less OAuth passthrough entry is routed too, never dialed directly', () => {
  const provider = providers.createProvider({
    appType: 'claude',
    name: 'OAuth passthrough fixture',
    settingsConfig: { env: {} },
  });
  // A base-less entry is materialized as the proxy's official route — the same
  // route the built-in Claude Official entry uses — and its login stays
  // host-side. The caller's CLAUDE_OFFICIAL_VIA_PROXY copy does not gate that:
  // the built-in entry has always been forced onto the hop regardless, and the
  // passthrough shape is now treated identically, so no configuration reaches
  // api.anthropic.com around the hop.
  for (const officialOAuth of [true, false]) {
    const env = { CLAUDE_CODE_OAUTH_TOKEN: 'passthrough-login-fixture' };
    assert.equal(providers.applyClaudeProxyEnv(env, {
      providerId: provider.id, sessionId: 'sess-fixture', port: 4321, enabled: true,
      officialOAuth,
    }), true, `officialOAuth=${officialOAuth}`);
    assert.equal(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:4321/claude-proxy/${provider.id}/sess-fixture`);
    assert.match(env.ANTHROPIC_AUTH_TOKEN, /^cpr-sess-fixture$/);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, '', 'the login stays host-side');
  }
  // A session with no provider keeps the default-login path it always had.
  const bare = {};
  assert.equal(providers.applyClaudeProxyEnv(bare, { providerId: '', enabled: true }), false);
  assert.equal(bare.ANTHROPIC_BASE_URL, undefined);
});

test('a base-less entry carrying its own token is routed to its implied upstream', () => {
  // The OAuth-passthrough shape (`claude setup-token`, or a pasted bearer): the
  // record names no base URL because the upstream is Anthropic's own default. It
  // used to be dialed directly, on the grounds that a base-less record had
  // "nothing local to forward to"; the hop can serve it, so it is routed — with
  // the entry's OWN credential, never the host's subscription login.
  const provider = providers.createProvider({
    appType: 'claude',
    name: 'Token-only fixture',
    authToken: 'token-only-fixture-key',
  });
  const env = { ANTHROPIC_AUTH_TOKEN: 'token-only-fixture-key', CLAUDE_CODE_OAUTH_TOKEN: 'stale-inherited' };
  assert.equal(providers.applyClaudeProxyEnv(env, {
    providerId: provider.id, sessionId: 'sess-fixture', port: 4321, enabled: true,
  }), true);
  assert.equal(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:4321/claude-proxy/${provider.id}/sess-fixture`);
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'the real credential never reaches the child');
  assert.match(env.ANTHROPIC_AUTH_TOKEN, /^cpr-sess-fixture$/);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, '', 'the hop forwards the credential from the store, not the child');
  // The hop reads the record through this view: base URL implied, credential intact.
  const viewEnv = configOf(providers.routingProviderView('claude', provider.id)).env;
  assert.equal(viewEnv.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.equal(viewEnv.ANTHROPIC_AUTH_TOKEN, 'token-only-fixture-key');
  // The stored record itself is untouched — the upstream is a routing concern.
  assert.equal(JSON.stringify(configOf(providers.getProvider('claude', provider.id))).includes('api.anthropic.com'), false);
  // A base-less entry with NO credential is the official shape: the view leaves it
  // alone (string settingsConfig included) so the proxy's official branch replays
  // the host login instead of inventing an upstream for it.
  const loginOnly = providers.createProvider({
    appType: 'claude', name: 'login-only fixture', settingsConfig: '{"env":{}}',
  });
  const official = providers.routingProviderView('claude', loginOnly.id);
  assert.equal(configOf(official).env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(JSON.stringify(configOf(official)), JSON.stringify(configOf(providers.getProvider('claude', loginOnly.id))),
    'returned untouched, as stored');
});

test('a CLAUDE_CODE_OAUTH_TOKEN-only entry is routed as a bearer', () => {
  const provider = providers.createProvider({
    appType: 'claude', name: 'setup-token fixture',
    settingsConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: 'setup-token-fixture' } },
  });
  const viewEnv = configOf(providers.routingProviderView('claude', provider.id)).env;
  assert.equal(viewEnv.ANTHROPIC_BASE_URL, 'https://api.anthropic.com',
    'the record implies Anthropic’s own endpoint');
  assert.equal(viewEnv.ANTHROPIC_AUTH_TOKEN, 'setup-token-fixture',
    'the one key the hop forwards gets the token the CLI would have sent as Bearer');
  const env = {};
  providers.applyClaudeProxyEnv(env, { providerId: provider.id, sessionId: 'sess-token', port: 4321, enabled: true });
  assert.equal(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:4321/claude-proxy/${provider.id}/sess-token`);
});

test('the official login is routed through the local proxy too', () => {
  providers.enableUnifiedOfficialProviders();
  const summary = providers.getProviderSummary('claude', 'claude-official');
  assert.equal(summary.builtinOfficial, true, 'the built-in official entry is recognised');
  assert.equal(claudeProxyEnvRequired({ providerId: 'claude-official', summary }), true);
  const env = { CLAUDE_CODE_OAUTH_TOKEN: 'keychain-oauth-fixture' };
  providers.applyClaudeProxyEnv(env, {
    providerId: 'claude-official', sessionId: 'sess-official', port: 4321, enabled: true,
    // Even with the caller's toggle copy off (see the passthrough test): the
    // built-in official entry is put on the hop regardless.
    officialOAuth: false,
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

test('an inherited ANTHROPIC_CUSTOM_HEADERS cannot ride into a claude child', () => {
  // The CLI parses this value into literal upstream request headers and the
  // local proxy forwards the client's headers to the provider, so a value this
  // server inherited from its own shell would reach the vendor on every turn —
  // the base-URL rewrite does not touch it. Treated like ANTHROPIC_BASE_URL:
  // stripped from the inherited env, then re-applied only if the provider
  // declares its own (see the settings-override test for that half).
  assert.equal(providers.ANTHROPIC_ROUTING_KEYS.includes('ANTHROPIC_CUSTOM_HEADERS'), true);
  assert.equal(providers.CLAUDE_ROUTING_KEYS.includes('ANTHROPIC_CUSTOM_HEADERS'), true);
  const { env } = providers.buildChildEnv(
    { ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: inherited', KEEP: '1' },
    { cli: 'claude' },
    {},
  );
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined, 'inherited value is stripped');
  assert.equal(env.KEEP, '1', 'unrelated vars are untouched');
});

test('routing is unconditional: no option, env var or provider-less session can turn it off', () => {
  // CLAUDE_PROXY_ENABLED used to be a host-wide "run claude direct" switch
  // (.env + settings UI + app). It is gone from the server, the routes, the web
  // UI and the app; this pins the remaining contract — a bound provider is
  // always rewritten, and only a session with no local endpoint to forward to
  // (no provider at all) is allowed to keep its own env.
  const provider = providers.createProvider({
    appType: 'claude',
    name: 'Unconditional fixture',
    baseUrl: 'https://relay.example',
    authToken: 'relay-fixture-key',
    model: 'claude-sonnet-4-5',
  });
  for (const options of [
    { providerId: provider.id, sessionId: 'sess-on', port: 4321 },
    { providerId: provider.id, sessionId: 'sess-on', port: 4321, enabled: false },
    { providerId: provider.id, sessionId: 'sess-on', port: 4321, enabled: true },
  ]) {
    const env = { ANTHROPIC_BASE_URL: 'https://relay.example', CLAUDE_CODE_USE_BEDROCK: '1' };
    assert.equal(providers.applyClaudeProxyEnv(env, options), true, JSON.stringify(options));
    assert.equal(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:4321/claude-proxy/${provider.id}/sess-on`);
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '');
  }
  const bare = { CLAUDE_CODE_USE_BEDROCK: '1' };
  assert.equal(providers.applyClaudeProxyEnv(bare, { providerId: '', enabled: false }), false);
  assert.equal(bare.CLAUDE_CODE_USE_BEDROCK, '1');
});
