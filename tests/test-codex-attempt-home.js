'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  cleanupCodexAttemptHomes,
  createCodexAttemptHome,
} = require('../src/codex-attempt-home');
const {
  assertCodexProxyConfigApplied,
  codexProxyConfigRequired,
} = require('../src/codex-proxy-policy');
const { createProviderRouterRuntime } = require('../src/provider-router-runtime');
const { createCodexSessionHomeRuntime } = require('../src/codex-session-home');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-codex-attempt-home-'));
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

const providers = require('../src/providers');

function restoreEnvironment() {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
}

function treeText(directory) {
  const output = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(file);
      else output.push(fs.readFileSync(file, 'utf8'));
    }
  }
  visit(directory);
  return output.join('\n');
}

test.after(restoreEnvironment);

test('Codex proxy requirement matrix requires every managed provider, including Official OAuth', () => {
  const customRequired = codexProxyConfigRequired({
    providerId: 'custom-main', officialOAuth: false,
  });
  assert.equal(customRequired, true);
  assert.throws(
    () => assertCodexProxyConfigApplied({ required: customRequired, applied: false }),
    error => error && error.code === 'CODEX_PROXY_CONFIG_REQUIRED',
  );

  const officialDirectRequired = codexProxyConfigRequired({
    providerId: 'official-main', officialOAuth: true,
  });
  assert.equal(officialDirectRequired, true);
  assert.throws(
    () => assertCodexProxyConfigApplied({ required: officialDirectRequired, applied: false }),
    error => error && error.code === 'CODEX_PROXY_CONFIG_REQUIRED',
  );

  const officialSubagentRequired = codexProxyConfigRequired({
    providerId: 'official-main',
    officialOAuth: true,
    subagentProviderId: 'custom-sub',
  });
  assert.equal(officialSubagentRequired, true);
  assert.throws(
    () => assertCodexProxyConfigApplied({ required: officialSubagentRequired, applied: false }),
    error => error && error.code === 'CODEX_PROXY_CONFIG_REQUIRED',
  );

  assert.equal(codexProxyConfigRequired({ providerId: 'deleted-main' }), true,
    'a stale non-default route must not fall through to native CODEX_HOME');
  assert.equal(codexProxyConfigRequired({ providerId: null }), false,
    'the provider-less native route remains backward compatible');
});

test('provider metadata classifies custom, stale, and OAuth Codex routes conservatively', () => {
  const official = providers.createProvider({
    appType: 'codex',
    name: 'Official OAuth fixture',
    settingsConfig: {
      auth: {
        auth_mode: 'chatgpt',
        tokens: { access_token: 'oauth-fixture-not-a-provider-key' },
      },
      config: '',
    },
  });
  const custom = providers.createProvider({
    appType: 'codex',
    name: 'Custom route fixture',
    baseUrl: 'https://custom-route.example/v1',
    authToken: 'custom-route-key',
    model: 'gpt-custom',
  });
  assert.equal(providers.codexProxyConfigRequired({ providerId: custom.id }), true);
  assert.equal(providers.codexProxyConfigRequired({ providerId: 'deleted-provider-id' }), true);
  const ambiguous = providers.createProvider({
    appType: 'codex',
    name: 'Unconfirmed provider fixture',
    settingsConfig: { auth: {}, config: '' },
  });
  assert.equal(providers.codexProxyConfigRequired({ providerId: ambiguous.id }), true,
    'a base-less record without explicit ChatGPT auth mode is not confirmed OAuth');
  assert.equal(providers.codexProxyConfigRequired({ providerId: official.id }), true);
  assert.equal(providers.codexProxyConfigRequired({
    providerId: official.id,
    subagent: { providerId: custom.id },
  }), true);
});

test('Official OAuth is host-only and each local Codex attempt receives a private CPR route', () => {
  const official = providers.createProvider({
    appType: 'codex',
    name: 'Official relay fixture',
    settingsConfig: {
      auth: {
        auth_mode: 'chatgpt',
        tokens: { access_token: 'stored-provider-oauth-must-not-reach-child' },
      },
      config: 'model = "gpt-5.6-sol"\n',
    },
  });
  const globalCodexHome = path.join(process.env.HOME, '.codex');
  fs.mkdirSync(globalCodexHome, { recursive: true });
  fs.writeFileSync(path.join(globalCodexHome, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'global-host-oauth-must-not-reach-child',
      account_id: 'host-account',
    },
  }));

  const built = providers.buildChildEnv({
    OPENAI_API_KEY: 'inherited-openai-key-must-not-reach-child',
    OPENAI_BASE_URL: 'https://wrong-inherited.example/v1',
  }, {
    id: 'official-relay-session', cli: 'codex', provider: official.id, model: 'gpt-5.6-sol',
  }, {
    OPENAI_ORG_ID: 'caller-openai-context-must-not-reach-child',
  });
  assert.equal(built.env.OPENAI_API_KEY, undefined);
  assert.equal(built.env.OPENAI_BASE_URL, undefined);
  assert.equal(built.env.OPENAI_ORG_ID, undefined);
  const providerHome = built.env.CODEX_HOME;
  assert.equal(fs.existsSync(path.join(providerHome, 'auth.json')), false);
  assert.equal(treeText(providerHome).includes('global-host-oauth-must-not-reach-child'), false);
  assert.equal(treeText(providerHome).includes('stored-provider-oauth-must-not-reach-child'), false);

  const capability = 'pr1.b2ZmaWNpYWwtc2Vzc2lvbg.b2ZmaWNpYWwtYXR0ZW1wdA';
  assert.equal(providers.applyCodexProxyConfig(built.env, {
    providerId: official.id,
    sessionId: capability,
    port: 3000,
  }), true);
  const attemptHome = built.env.CODEX_HOME;
  assert.notEqual(attemptHome, providerHome);
  assert.equal(fs.existsSync(path.join(attemptHome, 'auth.json')), false);
  const attemptConfig = fs.readFileSync(path.join(attemptHome, 'config.toml'), 'utf8');
  assert.match(attemptConfig, new RegExp(
    `/codex-proxy/${official.id}/${capability.replace(/\./g, '\\.')}\/main`,
  ));
  assert.match(attemptConfig, /requires_openai_auth\s*=\s*false/);
  assert.equal(treeText(attemptHome).includes('global-host-oauth-must-not-reach-child'), false);
  assert.equal(treeText(attemptHome).includes('stored-provider-oauth-must-not-reach-child'), false);
  assert.equal(providers.releaseCodexProxyConfig(built.env), true);
  assert.equal(built.env.CODEX_HOME, providerHome);
  assert.equal(fs.existsSync(attemptHome), false);
});

test('CPR resolves and builds Official homes credential-free before any attempt is applied', () => {
  const official = providers.createProvider({
    appType: 'codex',
    name: 'Official early materialization fixture',
    settingsConfig: {
      auth: {
        auth_mode: 'chatgpt',
        tokens: { access_token: 'official-early-token-must-never-land' },
      },
      config: 'model = "gpt-5.6-sol"\n',
    },
  });
  const runtime = createProviderRouterRuntime({
    mode: 'cpr', providers,
    dataRoot: process.env.MULTICC_DATA_DIR,
    codexHomesDir: providers.CODEX_HOMES_DIR,
  });
  const session = {
    id: 'official-early-session', cli: 'codex', provider: official.id, model: 'gpt-5.6-sol',
  };

  const resolution = runtime.resolveSpawnEnv(session);
  assert.equal(fs.existsSync(path.join(resolution.env.CODEX_HOME, 'auth.json')), false);
  assert.equal(treeText(resolution.env.CODEX_HOME).includes('official-early-token-must-never-land'), false);
  assert.match(
    fs.readFileSync(path.join(resolution.env.CODEX_HOME, 'config.toml'), 'utf8'),
    /\/codex-proxy\/[^/]+\/inactive\/main/,
  );

  const built = runtime.buildChildEnv({ OPENAI_API_KEY: 'inherited-must-not-land' }, session);
  assert.equal(fs.existsSync(path.join(built.env.CODEX_HOME, 'auth.json')), false);
  assert.equal(treeText(built.env.CODEX_HOME).includes('official-early-token-must-never-land'), false);
  assert.equal(treeText(built.env.CODEX_HOME).includes('inherited-must-not-land'), false);
});

test('canonical Codex sessions preserve one native thread across managed and Official routes', () => {
  const managed = providers.createProvider({
    appType: 'codex', name: 'Canonical managed fixture',
    baseUrl: 'https://canonical-managed.example/v1', authToken: 'canonical-managed-key',
    model: 'gpt-managed', apiFormat: 'openai_responses',
  });
  const official = providers.createProvider({
    appType: 'codex', name: 'Canonical Official fixture',
    settingsConfig: {
      auth: { auth_mode: 'chatgpt', tokens: { access_token: 'canonical-official-snapshot' } },
      config: 'model = "gpt-5.6-sol"\n',
    },
  });
  const logicalSessionId = 'canonical-auto-session';
  const nativeSessionId = '019c-canonical-native-thread';
  const managedEnv = providers.buildChildEnv({}, {
    id: logicalSessionId, cli: 'codex', provider: managed.id, model: 'gpt-managed',
  }).env;
  const legacyRollout = path.join(
    managedEnv.CODEX_HOME, 'sessions', '2026', '08', '28',
    `rollout-2026-08-28T00-00-00-${nativeSessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(legacyRollout), { recursive: true });
  fs.writeFileSync(legacyRollout, 'completed-turn-a\n');

  const officialEnv = providers.buildChildEnv({}, {
    id: logicalSessionId, cli: 'codex', provider: official.id, model: 'gpt-5.6-sol',
  }).env;
  assert.equal(providers.applyCodexProxyConfig(officialEnv, {
    providerId: official.id,
    sessionId: 'pr1.canonical.official-attempt',
    logicalSessionId,
    nativeSessionId,
    subagent: { providerId: managed.id, model: 'gpt-managed' },
    port: 3000,
  }), true);
  const canonicalSessions = path.join(providers.codexSessionHome(logicalSessionId), 'sessions');
  assert.equal(fs.realpathSync(path.join(officialEnv.CODEX_HOME, 'sessions')), fs.realpathSync(canonicalSessions));
  const canonicalRollout = path.join(canonicalSessions, path.relative(
    path.join(managedEnv.CODEX_HOME, 'sessions'), legacyRollout,
  ));
  assert.equal(fs.readFileSync(canonicalRollout, 'utf8'), 'completed-turn-a\n');
  fs.appendFileSync(canonicalRollout, 'completed-turn-b\n');
  providers.releaseCodexProxyConfig(officialEnv);

  const managedAgain = providers.buildChildEnv({}, {
    id: logicalSessionId, cli: 'codex', provider: managed.id, model: 'gpt-managed',
  }).env;
  assert.equal(providers.applyCodexProxyConfig(managedAgain, {
    providerId: managed.id,
    sessionId: 'pr1.canonical.managed-attempt',
    logicalSessionId,
    nativeSessionId,
    subagent: { providerId: official.id, model: 'gpt-5.6-sol' },
    port: 3000,
  }), true, 'managed main plus Official sub must use the host CPR materializer');
  assert.equal(fs.realpathSync(path.join(managedAgain.CODEX_HOME, 'sessions')), fs.realpathSync(canonicalSessions));
  assert.equal(fs.readFileSync(canonicalRollout, 'utf8'), 'completed-turn-a\ncompleted-turn-b\n');
  assert.equal(fs.existsSync(path.join(managedAgain.CODEX_HOME, 'auth.json')), false);
  const routedConfig = fs.readFileSync(path.join(managedAgain.CODEX_HOME, 'config.toml'), 'utf8');
  assert.match(routedConfig, new RegExp(`/codex-proxy/${official.id}/pr1\\.canonical\\.managed-attempt/sub`));
  providers.releaseCodexProxyConfig(managedAgain);
  assert.equal(fs.existsSync(legacyRollout), true, 'legacy source remains recoverable');
});

test('ambiguous legacy Codex rollouts fail closed without deleting either source', () => {
  const nativeSessionId = '019c-ambiguous-native-thread';
  const logicalSessionId = 'ambiguous-logical-session';
  const sources = ['legacy-a', 'legacy-b'].map((name) => {
    const file = path.join(
      providers.CODEX_HOMES_DIR, name, 'sessions', '2026', '08',
      `rollout-${name}-${nativeSessionId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${name}\n`);
    return file;
  });
  assert.throws(
    () => providers.prepareCodexSessionHome({ logicalSessionId, nativeSessionId }),
    error => error && error.code === 'CODEX_SESSION_ROLLOUT_AMBIGUOUS',
  );
  assert.deepEqual(sources.map(file => fs.readFileSync(file, 'utf8')), ['legacy-a\n', 'legacy-b\n']);
});

test('canonical Codex history survives a host runtime restart and is never overwritten by legacy state', () => {
  const caseRoot = path.join(root, 'canonical-restart');
  const sessionHomesDir = path.join(caseRoot, 'session-homes');
  const codexHomesDir = path.join(caseRoot, 'provider-homes');
  const globalCodexHome = path.join(caseRoot, 'global-home');
  const source = path.join(
    codexHomesDir, 'managed-a', 'sessions', '2026', '08',
    'rollout-restart-native-thread.jsonl',
  );
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'legacy-before-restart\n');
  const options = { sessionHomesDir, codexHomesDir, globalCodexHome };
  const beforeRestart = createCodexSessionHomeRuntime(options);
  const migrated = beforeRestart.prepareCodexSessionHome({
    logicalSessionId: 'restart-logical-session', nativeSessionId: 'restart-native-thread',
  });
  fs.appendFileSync(migrated.rollout, 'canonical-after-turn\n');
  fs.writeFileSync(source, 'stale-legacy-after-restart\n');

  const afterRestart = createCodexSessionHomeRuntime(options);
  const resumed = afterRestart.prepareCodexSessionHome({
    logicalSessionId: 'restart-logical-session', nativeSessionId: 'restart-native-thread',
  });
  assert.equal(resumed.rollout, migrated.rollout);
  assert.equal(fs.readFileSync(resumed.rollout, 'utf8'),
    'legacy-before-restart\ncanonical-after-turn\n');
  assert.equal(fs.readFileSync(source, 'utf8'), 'stale-legacy-after-restart\n',
    'legacy source remains untouched and cannot overwrite canonical history');
});

test('providerless Codex keeps real OAuth home and synchronizes its rollout at managed boundaries', () => {
  const logicalSessionId = 'providerless-canonical-session';
  const nativeSessionId = 'providerless-canonical-native';
  const globalHome = path.join(process.env.HOME, '.codex');
  const globalRollout = path.join(globalHome, 'sessions', '2026', '08',
    `rollout-default-${nativeSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(globalRollout), { recursive: true });
  fs.writeFileSync(globalRollout, 'default-turn-a\n');
  const authFile = path.join(globalHome, 'auth.json');
  const authFixture = JSON.stringify({
    auth_mode: 'chatgpt', tokens: { access_token: 'providerless-oauth-fixture' },
  });
  fs.writeFileSync(authFile, authFixture);

  const defaultEnv = providers.buildChildEnv({}, {
    id: logicalSessionId, cli: 'codex', provider: null,
  }).env;
  assert.equal(defaultEnv.CODEX_HOME, undefined);
  assert.equal(providers.applyCodexProxyConfig(defaultEnv, {
    providerId: null, sessionId: 'pr1.providerless.default-one',
    logicalSessionId, nativeSessionId, port: 3000,
  }), false, 'default Codex must keep using the real ~/.codex directly');
  assert.equal(fs.readFileSync(authFile, 'utf8'), authFixture,
    'refreshable OAuth state is never copied into a disposable attempt home');

  const managed = providers.createProvider({
    appType: 'codex', name: 'Providerless continuity managed fixture',
    baseUrl: 'https://providerless-managed.example/v1', authToken: 'managed-key',
    model: 'gpt-managed', apiFormat: 'openai_responses',
  });
  const intoManaged = providers.synchronizeCodexSessionRoute({
    logicalSessionId, nativeSessionId,
    fromProviderId: null, toProviderId: managed.id,
  });
  assert.equal(intoManaged.direction, 'providerless-to-managed');
  const canonicalSessions = path.join(providers.codexSessionHome(logicalSessionId), 'sessions');
  const canonicalRollout = path.join(canonicalSessions,
    path.relative(path.join(globalHome, 'sessions'), globalRollout));
  assert.equal(fs.readFileSync(canonicalRollout, 'utf8'), 'default-turn-a\n');
  const managedEnv = providers.buildChildEnv({}, {
    id: logicalSessionId, cli: 'codex', provider: managed.id, model: 'gpt-managed',
  }).env;
  assert.equal(providers.applyCodexProxyConfig(managedEnv, {
    providerId: managed.id, sessionId: 'pr1.providerless.managed',
    logicalSessionId, nativeSessionId, port: 3000,
  }), true);
  assert.equal(fs.realpathSync(path.join(managedEnv.CODEX_HOME, 'sessions')),
    fs.realpathSync(canonicalSessions));
  fs.appendFileSync(canonicalRollout, 'second-turn-b\n');
  providers.releaseCodexProxyConfig(managedEnv);

  const intoDefault = providers.synchronizeCodexSessionRoute({
    logicalSessionId, nativeSessionId,
    fromProviderId: managed.id, toProviderId: null,
  });
  assert.equal(intoDefault.direction, 'managed-to-providerless');
  assert.equal(fs.readFileSync(globalRollout, 'utf8'),
    'default-turn-a\nsecond-turn-b\n');
  fs.appendFileSync(globalRollout, 'default-turn-c\n');

  providers.synchronizeCodexSessionRoute({
    logicalSessionId, nativeSessionId,
    fromProviderId: null, toProviderId: managed.id,
  });
  assert.equal(fs.readFileSync(canonicalRollout, 'utf8'),
    'default-turn-a\nsecond-turn-b\ndefault-turn-c\n');
  assert.equal(fs.existsSync(globalRollout), true);
  assert.equal(fs.existsSync(canonicalRollout), true,
    'both authoritative-boundary copies remain recoverable');
  assert.equal(fs.readFileSync(authFile, 'utf8'), authFixture);
});

test('CPR-mode Official spawn homes are sanitized at the physical attempt boundary', () => {
  const router = require('cli-provider-router');
  const official = providers.createProvider({
    appType: 'codex',
    name: 'Official CPR fixture',
    settingsConfig: {
      auth: {
        auth_mode: 'chatgpt',
        tokens: { access_token: 'cpr-imported-oauth-must-not-reach-child' },
      },
      config: 'model = "gpt-5.6-sol"\n',
    },
  });
  const built = router.buildChildEnv({
    OPENAI_ORG_ID: 'cpr-inherited-openai-context-must-not-reach-child',
  }, {
    cli: 'codex',
    providerId: official.id,
    store: { getProvider: providers.getProvider },
    codexHomesDir: providers.CODEX_HOMES_DIR,
  });
  const sourceHome = built.env.CODEX_HOME;
  const capability = 'pr1.Y3ByLW9mZmljaWFsLXNlc3Npb24.Y3ByLW9mZmljaWFsLWF0dGVtcHQ';
  assert.equal(providers.applyCodexProxyConfig(built.env, {
    providerId: official.id,
    sessionId: capability,
    port: 3000,
  }), true);
  const attemptHome = built.env.CODEX_HOME;
  assert.notEqual(attemptHome, sourceHome);
  assert.equal(fs.existsSync(path.join(sourceHome, 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(attemptHome, 'auth.json')), false);
  assert.equal(built.env.OPENAI_ORG_ID, undefined);
  assert.equal(treeText(sourceHome).includes('cpr-imported-oauth-must-not-reach-child'), false);
  assert.equal(treeText(attemptHome).includes('cpr-imported-oauth-must-not-reach-child'), false);
  assert.match(
    fs.readFileSync(path.join(attemptHome, 'config.toml'), 'utf8'),
    new RegExp(`/codex-proxy/${official.id}/${capability.replace(/\./g, '\\.')}\/main`),
  );
  assert.equal(providers.releaseCodexProxyConfig(built.env), true);
  assert.equal(built.env.CODEX_HOME, sourceHome);
});

test('first attempt use removes legacy capability overlays without following symlinks', () => {
  const caseRoot = path.join(root, 'legacy-cleanup');
  const sourceHome = path.join(caseRoot, 'provider-home');
  const homesDir = path.join(caseRoot, 'codex-attempt-homes');
  const legacyHome = path.join(homesDir, 'provider-deadbeef-legacy');
  const external = path.join(caseRoot, 'external-do-not-delete');
  fs.mkdirSync(sourceHome, { recursive: true });
  fs.mkdirSync(path.join(sourceHome, 'sessions'), { recursive: true });
  fs.mkdirSync(legacyHome, { recursive: true });
  fs.mkdirSync(external, { recursive: true });
  fs.writeFileSync(path.join(sourceHome, 'config.toml'), 'model = "gpt-safe"\n');
  const legacyCapability = 'pr1.bGVnYWN5LXNlc3Npb24.cHJveHktcm91dGUtbGVnYWN5LXNlY3JldA';
  const legacyRawToken = 'proxy-route-legacy-secret';
  fs.writeFileSync(
    path.join(legacyHome, 'config.toml'),
    `base_url = "http://127.0.0.1/codex-proxy/p/${legacyCapability}/main"\n`,
  );
  fs.symlinkSync(path.join(sourceHome, 'sessions'), path.join(legacyHome, 'sessions'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const legacyRollout = path.join(sourceHome, 'sessions', 'rollout-legacy.jsonl');
  fs.writeFileSync(legacyRollout,
    `${JSON.stringify({ type: 'tool_result', text: `${legacyCapability} ${legacyRawToken}` })}\n`);
  fs.writeFileSync(path.join(external, 'marker'), 'keep');
  fs.symlinkSync(external, path.join(homesDir, 'legacy-external-link'),
    process.platform === 'win32' ? 'junction' : 'dir');

  const lease = createCodexAttemptHome(sourceHome, {
    providerId: 'provider-safe',
    sessionId: 'pr1.current.capability',
    homesDir,
  });
  try {
    assert.equal(fs.existsSync(legacyHome), false);
    assert.equal(fs.existsSync(path.join(homesDir, 'legacy-external-link')), false);
    assert.equal(fs.readFileSync(path.join(external, 'marker'), 'utf8'), 'keep');
    assert.equal(treeText(homesDir).includes(legacyCapability), false);
    const scrubbedRollout = fs.readFileSync(legacyRollout, 'utf8');
    assert.equal(scrubbedRollout.includes(legacyCapability), false);
    assert.equal(scrubbedRollout.includes(legacyRawToken), false);
    assert.match(scrubbedRollout, /REDACTED_PROVIDER_ROUTE/);
    assert.equal(fs.existsSync(lease.home), true);
  } finally {
    lease.release();
  }
});

test('attempt release atomically scrubs only rollout files changed by its capability lease', () => {
  const caseRoot = path.join(root, 'release-scrub');
  const sourceHome = path.join(caseRoot, 'provider-home');
  const homesDir = path.join(caseRoot, 'codex-attempt-homes');
  const sessionsDir = path.join(sourceHome, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sourceHome, 'config.toml'), 'model = "gpt-safe"\n');
  const oldRollout = path.join(sessionsDir, 'rollout-old.jsonl');
  const oldBytes = '{"type":"message","text":"pr1.old.wrapper proxy-route-old-token"}\n';
  fs.writeFileSync(oldRollout, oldBytes);
  const oldStat = fs.statSync(oldRollout);

  const capability = 'pr1.c2Vzc2lvbi1zY3J1Yg.cHJveHktcm91dGUtYXR0ZW1wdC1zZWNyZXQ';
  const rawToken = 'proxy-route-attempt-secret';
  const lease = createCodexAttemptHome(sourceHome, {
    providerId: 'provider-safe', sessionId: capability, homesDir,
  });
  const changedRollout = path.join(sessionsDir, 'rollout-current.jsonl');
  fs.writeFileSync(changedRollout, [
    JSON.stringify({ type: 'tool_result', text: `url=${capability}` }),
    JSON.stringify({ type: 'message', text: `token=${rawToken}` }),
    '',
  ].join('\n'));

  assert.equal(lease.release(), true);
  assert.equal(fs.existsSync(lease.home), false);
  const scrubbed = fs.readFileSync(changedRollout, 'utf8');
  assert.equal(scrubbed.includes(capability), false);
  assert.equal(scrubbed.includes(rawToken), false);
  assert.match(scrubbed, /REDACTED_PROVIDER_ROUTE/);
  assert.equal(fs.readFileSync(oldRollout, 'utf8'), oldBytes,
    'a pre-existing unchanged rollout must not be rewritten or broadly scrubbed');
  const oldStatAfter = fs.statSync(oldRollout);
  assert.equal(oldStatAfter.ino, oldStat.ino);
  assert.equal(oldStatAfter.mtimeMs, oldStat.mtimeMs);
});

test('attempt release scrubs capability material split across JSON leaves and object keys', () => {
  const caseRoot = path.join(root, 'release-fragmented-scrub');
  const sourceHome = path.join(caseRoot, 'provider-home');
  const homesDir = path.join(caseRoot, 'codex-attempt-homes');
  const sessionsDir = path.join(sourceHome, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sourceHome, 'config.toml'), 'model = "gpt-safe"\n');
  const capability = 'pr1.c2Vzc2lvbi1mcmFnbWVudGVk.cHJveHktcm91dGUtZnJhZ21lbnRlZC1zZWNyZXQ';
  const encodedToken = capability.split('.')[2];
  const rawToken = 'proxy-route-fragmented-secret';
  const split = (secret) => [
    secret.slice(0, Math.floor(secret.length / 3)),
    secret.slice(Math.floor(secret.length / 3), Math.floor(secret.length * 2 / 3)),
    secret.slice(Math.floor(secret.length * 2 / 3)),
  ];
  const asNestedKeys = ([first, second, third]) => ({
    [first]: { [second]: { [third]: true } },
  });
  const allStrings = (value, output = []) => {
    if (typeof value === 'string') output.push(value);
    else if (Array.isArray(value)) value.forEach(item => allStrings(item, output));
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        output.push(key);
        allStrings(item, output);
      }
    }
    return output;
  };

  const lease = createCodexAttemptHome(sourceHome, {
    providerId: 'provider-safe', sessionId: capability, homesDir,
  });
  const records = [
    split(capability),
    asNestedKeys(split(capability)),
    split(rawToken),
    asNestedKeys(split(rawToken)),
    { [split(encodedToken)[0]]: { [split(encodedToken)[1]]: split(encodedToken)[2] } },
  ];
  const changedRollout = path.join(sessionsDir, 'rollout-fragmented.jsonl');
  fs.writeFileSync(changedRollout, `${records.map(JSON.stringify).join('\n')}\n`);
  const before = records.flatMap(record => allStrings(record).join('')).join('\n');
  assert.equal(before.includes(capability), true, 'fixture must reconstruct the wrapper');
  assert.equal(before.includes(rawToken), true, 'fixture must reconstruct the decoded token');
  assert.equal(before.includes(encodedToken), true, 'fixture must reconstruct the encoded token');

  assert.equal(lease.release(), true);
  const scrubbedRecords = fs.readFileSync(changedRollout, 'utf8').trim().split('\n').map(JSON.parse);
  const scrubbedStrings = scrubbedRecords.flatMap(record => allStrings(record).join('')).join('\n');
  assert.equal(scrubbedStrings.includes(capability), false);
  assert.equal(scrubbedStrings.includes(rawToken), false);
  assert.equal(scrubbedStrings.includes(encodedToken), false,
    'the third base64url capability segment is independently sensitive');
  assert.match(scrubbedStrings, /REDACTED_PROVIDER_ROUTE/);
});

test('orphan cleanup never silently deletes a capability whose rollout root is unresolved', () => {
  const caseRoot = path.join(root, 'unresolved-orphan');
  const homesDir = path.join(caseRoot, 'codex-attempt-homes');
  const orphan = path.join(homesDir, 'provider-deadbeef-orphan');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'config.toml'), [
    'base_url = "http://127.0.0.1/codex-proxy/provider/',
    'pr1.dW5yZXNvbHZlZC1zZXNzaW9u.cHJveHktcm91dGUtdW5yZXNvbHZlZC1zZWNyZXQ/main"\n',
  ].join(''));
  assert.throws(
    () => cleanupCodexAttemptHomes(homesDir),
    error => error && error.code === 'CODEX_ATTEMPT_HOME_CLEANUP_FAILED',
  );
  assert.equal(fs.existsSync(orphan), true,
    'the overlay must remain recoverable for a later successful sweep');
});

test('orphan cleanup recovers the exact capability and timestamp from its owner lease', () => {
  const caseRoot = path.join(root, 'owner-orphan');
  const sourceHome = path.join(caseRoot, 'provider-home');
  const sessionsDir = path.join(sourceHome, 'sessions');
  const homesDir = path.join(caseRoot, 'codex-attempt-homes');
  const orphan = path.join(homesDir, `p${process.pid}-stale-instance-provider-orphan`);
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(orphan, { recursive: true });
  const capability = 'pr1.b3JwaGFuLXNlc3Npb24.cHJveHktcm91dGUtb3JwaGFuLXNlY3JldA';
  const rawToken = 'proxy-route-orphan-secret';
  const createdAtMs = Date.now() - 100;
  fs.writeFileSync(path.join(orphan, '.multicc-attempt-owner.json'), JSON.stringify({
    pid: process.pid,
    processInstanceId: 'stale-instance',
    sourceHome,
    encodedCapability: capability,
    createdAtMs,
  }));
  const rollout = path.join(sessionsDir, 'rollout-owner-orphan.jsonl');
  fs.writeFileSync(rollout, `${capability} ${rawToken}\n`);

  const result = cleanupCodexAttemptHomes(homesDir);
  assert.equal(result.removed, 1);
  assert.equal(result.scrubbed, 1);
  assert.equal(fs.existsSync(orphan), false);
  const scrubbed = fs.readFileSync(rollout, 'utf8');
  assert.equal(scrubbed.includes(capability), false);
  assert.equal(scrubbed.includes(rawToken), false);
});

test('attempt-home cleanup failure propagates into the required-route fail-closed guard', () => {
  const created = providers.createProvider({
    appType: 'codex',
    name: 'Cleanup failure route',
    baseUrl: 'https://cleanup-failure.example/v1',
    authToken: 'cleanup-failure-key',
    model: 'gpt-cleanup',
  });
  const env = providers.buildChildEnv({}, {
    id: 'cleanup-failure-session', cli: 'codex', provider: created.id, model: 'gpt-cleanup',
  }).env;
  const staticHome = env.CODEX_HOME;
  const attemptsDir = providers.CODEX_ATTEMPT_HOMES_DIR;
  fs.mkdirSync(path.dirname(attemptsDir), { recursive: true });
  if (fs.existsSync(attemptsDir)) {
    assert.deepEqual(fs.readdirSync(attemptsDir), [], 'released attempts leave only an empty root');
    fs.rmSync(attemptsDir, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(attemptsDir), false);
  fs.writeFileSync(attemptsDir, 'not-a-directory');
  try {
    const applied = providers.applyCodexProxyConfig(env, {
      providerId: created.id,
      sessionId: 'pr1.cleanup.failure',
      port: 3000,
      logger: { warn() {} },
    });
    const required = providers.codexProxyConfigRequired({ providerId: created.id });
    assert.equal(applied, false);
    assert.equal(required, true);
    assert.throws(
      () => providers.assertCodexProxyConfigApplied({ required, applied }),
      error => error && error.code === 'CODEX_PROXY_CONFIG_REQUIRED',
    );
    assert.equal(env.CODEX_HOME, staticHome);
    assert.equal(treeText(staticHome).includes('pr1.cleanup.failure'), false);
  } finally {
    fs.unlinkSync(attemptsDir);
  }
});

test('concurrent Codex attempts isolate proxy capabilities from the provider home and each other', () => {
  const created = providers.createProvider({
    appType: 'codex',
    name: 'Concurrent Codex',
    baseUrl: 'https://codex-race.example/v1',
    authToken: 'codex-race-secret',
    model: 'gpt-race',
    apiFormat: 'openai_responses',
  });
  const session = {
    id: 'session-preference-only', cli: 'codex', provider: created.id, model: 'gpt-race',
  };
  // Build both child envs before either capability is applied. They initially
  // point at the same immutable provider materialization, reproducing the old
  // concurrent-spawn race exactly.
  const firstEnv = providers.buildChildEnv({}, session).env;
  const secondEnv = providers.buildChildEnv({}, session).env;
  const providerHome = firstEnv.CODEX_HOME;
  assert.equal(secondEnv.CODEX_HOME, providerHome);
  const staticAgents = path.join(providerHome, 'agents');
  fs.mkdirSync(staticAgents, { recursive: true });
  fs.writeFileSync(path.join(staticAgents, 'default.toml'), 'name = "static-baseline"\n');
  const staticConfigBefore = fs.readFileSync(path.join(providerHome, 'config.toml'), 'utf8');
  const staticAgentBefore = fs.readFileSync(path.join(staticAgents, 'default.toml'), 'utf8');

  const firstCapability = 'pr1.c2Vzc2lvbi1h.Y2FwYWJpbGl0eS1h';
  const secondCapability = 'pr1.c2Vzc2lvbi1i.Y2FwYWJpbGl0eS1i';
  const options = capability => ({
    providerId: created.id,
    sessionId: capability,
    subagent: { providerId: created.id, model: 'gpt-race' },
    port: 3000,
  });
  assert.equal(providers.applyCodexProxyConfig(firstEnv, options(firstCapability)), true);
  assert.equal(providers.applyCodexProxyConfig(secondEnv, options(secondCapability)), true);

  assert.notEqual(firstEnv.CODEX_HOME, providerHome);
  assert.notEqual(secondEnv.CODEX_HOME, providerHome);
  assert.notEqual(firstEnv.CODEX_HOME, secondEnv.CODEX_HOME);
  assert.equal(path.basename(firstEnv.CODEX_HOME).includes('pr1.'), false);
  assert.equal(fs.statSync(firstEnv.CODEX_HOME).mode & 0o777, 0o700);
  const firstConfig = fs.readFileSync(path.join(firstEnv.CODEX_HOME, 'config.toml'), 'utf8');
  const secondConfig = fs.readFileSync(path.join(secondEnv.CODEX_HOME, 'config.toml'), 'utf8');
  assert.equal(fs.statSync(path.join(firstEnv.CODEX_HOME, 'config.toml')).mode & 0o777, 0o600);
  assert.match(firstConfig, new RegExp(firstCapability.replace(/\./g, '\\.')));
  assert.doesNotMatch(firstConfig, new RegExp(secondCapability.replace(/\./g, '\\.')));
  assert.match(secondConfig, new RegExp(secondCapability.replace(/\./g, '\\.')));
  assert.doesNotMatch(secondConfig, new RegExp(firstCapability.replace(/\./g, '\\.')));
  for (const role of ['default', 'worker', 'explorer']) {
    assert.equal(fs.existsSync(path.join(firstEnv.CODEX_HOME, 'agents', `${role}.toml`)), true);
    assert.equal(fs.existsSync(path.join(secondEnv.CODEX_HOME, 'agents', `${role}.toml`)), true);
  }

  assert.equal(fs.readFileSync(path.join(providerHome, 'config.toml'), 'utf8'), staticConfigBefore);
  assert.equal(fs.readFileSync(path.join(staticAgents, 'default.toml'), 'utf8'), staticAgentBefore);
  assert.equal(treeText(providerHome).includes('pr1.'), false,
    'provider-shared config/auth/agents never persist an attempt capability');

  const firstHome = firstEnv.CODEX_HOME;
  const secondHome = secondEnv.CODEX_HOME;
  assert.equal(providers.releaseCodexProxyConfig(firstEnv), true);
  assert.equal(providers.releaseCodexProxyConfig(secondEnv), true);
  assert.equal(firstEnv.CODEX_HOME, providerHome);
  assert.equal(secondEnv.CODEX_HOME, providerHome);
  assert.equal(fs.existsSync(firstHome), false);
  assert.equal(fs.existsSync(secondHome), false);
  assert.equal(treeText(providerHome).includes('pr1.'), false);
});
