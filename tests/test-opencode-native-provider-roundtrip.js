'use strict';

// Regression: a session whose line is one of OpenCode's own native providers
// (`opencode-native:<id>`, a legal Auto pool candidate) persists that id as
// session.provider. The new-task form replays the last runtime (provider +
// providerSelection) as an explicit `provider`, and creation validated it with
// validProviderId — which only knew vendor-native lanes and managed routes, so
// every new task answered 400 "invalid provider" until the user re-picked the
// line by hand (the run-config patch path always understood native lines).
// validProviderId must accept the native id structurally on the opencode lane,
// exactly like the Rust Auto-candidate validator: lane + id shape, no store
// lookup.

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-native-valid-'));
process.env.MULTICC_DATA_DIR = path.join(tmpRoot, 'data');
process.env.HOME = path.join(tmpRoot, 'home');
fs.mkdirSync(process.env.MULTICC_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });

const { createProviderRoutes } = require('../src/routes/providers.js');
const { createSessionRecordFactory } = require('../src/session/create-record');
const { isResidentSession } = require('../src/cli/cli-capability');

const NATIVE = 'opencode-native:opencode-go';

function providerRoutes() {
  return createProviderRoutes({
    fs: { readFileSync() { throw new Error('no provider-defaults file'); } },
    providerDefaultsFile: path.join(tmpRoot, 'provider-defaults.json'),
    atomicWriteJson: () => {},
    providers: {
      appTypeForCli: cli => (cli === 'codex' || cli === 'codex-exp' ? 'codex' : 'claude'),
      appTypesForCli: cli => (cli === 'opencode' || cli === 'zcode'
        ? ['claude', 'codex']
        : [cli === 'codex' || cli === 'codex-exp' ? 'codex' : 'claude']),
      providerSupportsCli: () => true,
      normalizeOfficialProviderId: (_cli, id) => (id === undefined ? null : id),
    },
    providerRouterRuntime: { getProviderSummary: () => null },
    findProviderReferences: () => ({ sessions: [], defaults: [], aux: [] }),
    persistedSessions: new Map(),
    providerRelayShares: { create() {}, list: () => [], getCredential: () => null, revoke: () => null, revokeProvider: () => 0 },
    getAuxConfig: () => ({ protocol: 'anthropic', providerId: null }),
    clearAuxProvider: () => {},
    applySessionPatch: () => ({ status: 200, body: {} }),
    previewSessionPatch: () => ({ status: 200, body: {} }),
    claudeCmd: '/usr/local/bin/claude',
    getPort: () => 4321,
    logger: { error() {} },
  });
}

function createHarness(validProviderId) {
  return createSessionRecordFactory({
    isResidentSession,
    sharedWorkspace: () => ({ worktreePath: '/wt/shared', branch: 'multicc/shared' }),
    SUPPORTED_CHAT_CLIS: ['claude', 'codex', 'opencode'],
    validateExperimentalSession: () => ({ ok: true }),
    tuiChatMirrorEnabled: () => false,
    normalizeEffort: value => (value == null ? null : String(value)),
    validEffortForCli: () => true,
    codexDefaultReasoningLevel: () => null,
    normalizeCliAgent: () => null,
    validateProviderSelection: () => ({ ok: true, value: null }),
    providers: { normalizeOfficialProviderId: (_cli, id) => (id === undefined ? null : id) },
    primaryProviderCandidate: () => null,
    providerDefaults: {},
    validProviderId,
    allocateSessionId: () => 'sess-1',
    persistedSessions: new Map(),
    ensureDirGitReady: async () => ({ ok: true }),
    friendlyDirReason: reason => String(reason),
    WORKTREE_SUBDIR: '.multicc-worktrees',
    gitWorktreeAdd: async () => { throw new Error('validateOnly must not touch git'); },
    gitWorktreeRollbackCreate: async () => {},
    sanitizeLoginEnv: () => ({ ok: true }),
    ensureCliStates: () => {},
    sessionPersistence: { mutate: () => {} },
    savePersistedSessionsBestEffort: () => {},
    appendEvent: () => {},
    cliForLoginFlow: () => null,
  });
}

test('validProviderId accepts a stored OpenCode native line on its own lane only', () => {
  const { validProviderId } = providerRoutes();
  assert.deepEqual(validProviderId('opencode', NATIVE), { ok: true, value: NATIVE });
  assert.equal(validProviderId('claude', NATIVE).ok, false, 'a native line never crosses lanes');
  assert.equal(validProviderId('opencode', 'opencode-native:-bad').ok, false, 'id shape still enforced');
  assert.equal(validProviderId('opencode', 'ghost-route').ok, false, 'unknown managed ids stay invalid');
});

test('new-task creation replays a stored native line without invalid provider', async () => {
  const { validProviderId } = providerRoutes();
  const create = createHarness(validProviderId);
  const dir = { id: 'd', path: '/repo', baseBranch: 'main' };

  const replayed = await create({ dir, cli: 'opencode', kind: 'chat', provider: NATIVE, validateOnly: true });
  assert.equal(replayed.ok, true, replayed.error);

  const wrongLane = await create({ dir, cli: 'claude', kind: 'chat', provider: NATIVE, validateOnly: true });
  assert.deepEqual({ ok: wrongLane.ok, error: wrongLane.error }, { ok: false, error: 'invalid provider' });
});
