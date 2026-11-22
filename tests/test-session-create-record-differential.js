'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Load the frozen source with its original filename to preserve its relative imports.
const filename = path.resolve(__dirname, '../src/session/create-record.js');
const frozen = new Module(filename, module);
frozen.filename = filename;
frozen.paths = Module._nodeModulePaths(path.dirname(filename));
frozen._compile(fs.readFileSync(path.join(__dirname, 'helpers/legacy-session-create-record.js'), 'utf8'), filename);
const candidate = require('../src/session/create-record');

function world(implementation, scenario) {
  const events = [];
  const records = new Map(scenario.preexisting ? [['s1', { id: 's1', marker: 'existing' }]] : []);
  const note = name => (...args) => { events.push([name, ...args]); };
  const deps = {
    isResidentSession: () => true,
    sharedWorkspace: () => { events.push(['shared']); if (scenario.sharedError) throw new Error('shared failed'); return { worktreePath: '/shared', branch: 'shared' }; },
    SUPPORTED_CHAT_CLIS: ['claude', 'codex', 'codex-exp'],
    validateExperimentalSession: () => ({ ok: true }), tuiChatMirrorEnabled: () => false,
    normalizeEffort: value => scenario.invalidEffort ? undefined : value, validEffortForCli: () => !scenario.invalidReasoning,
    codexDefaultReasoningLevel: () => 'medium', normalizeCliAgent: () => null,
    validateProviderSelection: () => scenario.selectionError ? { ok: false, error: 'bad selection' } : ({ ok: true, value: null }),
    providers: { normalizeOfficialProviderId: (_cli, id) => id },
    primaryProviderCandidate: () => null, providerDefaults: {},
    validProviderId: (_cli, id) => ({ ok: !scenario.invalidProvider, value: id }),
    allocateSessionId: () => 's1', persistedSessions: records,
    ensureDirGitReady: async () => { events.push(['ready']); return scenario.ready || { ok: true }; },
    friendlyDirReason: reason => `reason:${reason}`, WORKTREE_SUBDIR: '.multicc-worktrees',
    gitWorktreeAdd: async () => { events.push(['add']); if (scenario.addError) throw new Error('add failed'); return { worktreePath: '/wt/s1', branch: 'multicc/s1' }; },
    gitWorktreeRollbackCreate: async (...args) => { events.push(['rollback', ...args]); if (scenario.rollbackError) throw new Error('rollback failed'); },
    sanitizeLoginEnv: () => ({ ok: true }), ensureCliStates: note('states'),
    sessionPersistence: { mutate: (_source, mutate) => { events.push(['mutate']); if (scenario.persistError) throw new Error('persist failed'); mutate(records); } },
    savePersistedSessionsBestEffort: note('save'), appendEvent: note('event'),
    cliForLoginFlow: () => null, loginWorkspacePath: () => '/login/s1',
  };
  return { run: implementation.createSessionRecordFactory(deps), events, records };
}
function normalize(value) {
  return JSON.parse(JSON.stringify(value, (key, v) => key === 'createdAt' || key === 'lastWorkAt' ? '<time>' : v));
}
const dir = { id: 'd1', path: '/repo', baseBranch: 'main' };
const cases = [
  ['missing directory', {}, {}],
  ['invalid cli', { dir, cli: 'invalid', kind: 'chat' }, {}],
  ['invalid kind', { dir, cli: 'claude', kind: 'other' }, {}],
  ['experimental terminal', { dir, cli: 'codex-exp', kind: 'terminal' }, {}],
  ['invalid model', { dir, cli: 'claude', kind: 'chat', model: 'bad model' }, {}],
  ['model newline', { dir, cli: 'claude', kind: 'chat', model: 'model\n' }, {}],
  ['invalid effort', { dir, cli: 'claude', kind: 'chat' }, { invalidEffort: true }],
  ['invalid reasoning', { dir, cli: 'claude', kind: 'chat' }, { invalidReasoning: true }],
  ['invalid provider selection', { dir, cli: 'claude', kind: 'chat' }, { selectionError: true }],
  ['invalid provider', { dir, cli: 'claude', kind: 'chat', provider: 'bad' }, { invalidProvider: true }],
  ['invalid login', { dir, cli: 'claude', kind: 'chat', loginFlow: 'codex-login' }, {}],
  ['role prompt too long', { dir, cli: 'claude', kind: 'chat', rolePrompt: 'x'.repeat(40001) }, {}],
  ['validate only', { dir, cli: 'claude', kind: 'chat', validateOnly: true }, {}],
  ['chat', { dir, cli: 'claude', kind: 'chat', rolePrompt: ' hi ', autoCommit: false }, {}],
  ['task bound', { dir, cli: 'codex', kind: 'chat', taskBoundTaskId: 'task' }, {}],
  ['reuse', { dir, cli: 'claude', kind: 'chat', id: 's1' }, { preexisting: true }],
  ['shared worktree', { dir, cli: 'claude', kind: 'chat', workspaceOwnerSessionId: 'owner' }, {}],
  ['shared failure', { dir, cli: 'claude', kind: 'chat', workspaceOwnerSessionId: 'owner' }, { sharedError: true }],
  ['required persistence', { dir, cli: 'claude', kind: 'chat', persistence: 'required' }, {}],
  ['rollback fails', { dir, cli: 'claude', kind: 'chat', persistence: 'required' }, { persistError: true, rollbackError: true }],
  ['login', { dir, cli: 'codex', kind: 'terminal', loginFlow: 'codex-login' }, {}],
  ['unready repository', { dir, cli: 'claude', kind: 'chat' }, { ready: { ok: false, reason: 'offline' } }],
  ['worktree rollback', { dir, cli: 'claude', kind: 'chat' }, { addError: true }],
  ['persistence rollback', { dir, cli: 'claude', kind: 'chat', persistence: 'required' }, { persistError: true }],
];
for (const [name, input, scenario] of cases) {
  test(`create-record frozen contract: ${name}`, async () => {
    const worlds = [world(frozen.exports, scenario), world(candidate, scenario)];
    const outputs = [];
    for (const item of worlds) {
      try { outputs.push({ value: await item.run(input) }); }
      catch (error) { outputs.push({ error: { name: error.name, message: error.message } }); }
    }
    assert.deepEqual(normalize(outputs[1]), normalize(outputs[0]));
    assert.deepEqual(normalize(worlds[1].events), normalize(worlds[0].events));
    assert.deepEqual(normalize([...worlds[1].records]), normalize([...worlds[0].records]));
    if (name === 'worktree rollback') {
      assert.deepEqual(outputs[0].value, { ok: false, error: 'worktree 创建失败: add failed' });
      assert.deepEqual(worlds[0].events.map(event => event[0]), ['ready', 'add', 'rollback']);
      assert.equal(worlds[0].records.size, 0);
    }
    if (name === 'persistence rollback') {
      assert.deepEqual(outputs[0].error, { name: 'Error', message: 'persist failed' });
      assert.deepEqual(worlds[0].events.map(event => event[0]), ['ready', 'add', 'states', 'mutate', 'rollback']);
      assert.equal(worlds[0].records.size, 0);
    }
    if (name === 'reuse') {
      assert.equal(outputs[0].value.reused, true);
      assert.deepEqual(worlds[0].events, []);
    }
    if (name === 'shared failure') {
      assert.equal(outputs[0].value.error, 'worktree 创建失败: shared failed');
      assert.deepEqual(worlds[0].events.map(event => event[0]), ['ready', 'shared']);
    }
    if (name === 'rollback fails') {
      assert.deepEqual(outputs[0].error, { name: 'Error', message: 'rollback failed' });
    }
    if (name === 'login') {
      assert.equal(outputs[0].value.session.worktreePath, null);
      assert.equal(outputs[0].value.session.branch, null);
      assert.equal(outputs[0].value.session.cwd, '/login/s1');
      assert.equal(worlds[0].events.some(event => event[0] === 'ready' || event[0] === 'add'), false);
    }
    if (name === 'task bound') {
      assert.equal(outputs[0].value.session.workspaceState, 'planned');
      assert.equal(worlds[0].events.some(event => event[0] === 'ready' || event[0] === 'add'), false);
    }
    if (name === 'validate only') {
      assert.deepEqual(outputs[0].value, { ok: true });
      assert.deepEqual(worlds[0].events, []);
      assert.equal(worlds[0].records.size, 0);
    }
  });
}
