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
const candidate = { createSessionRecordFactory: deps => require('../src/native/runtime').getNative().sessionCreateRecordFactory(deps, path) };

function world(implementation, scenario) {
  const events = [];
  const records = scenario.records || new Map(scenario.preexisting ? [['s1', { id: 's1', marker: 'existing' }]] : []);
  const note = name => (...args) => { events.push([name, ...args]); };
  const deps = {
    isResidentSession: () => true,
    sharedWorkspace: () => { events.push(['shared']); if (scenario.sharedError) throw new Error('shared failed'); return { worktreePath: '/shared', branch: 'shared' }; },
    SUPPORTED_CHAT_CLIS: ['claude', 'codex', 'codex-exp'],
    validateExperimentalSession: () => ({ ok: true }), tuiChatMirrorEnabled: () => false,
    normalizeEffort: value => scenario.invalidEffort ? undefined : value, validEffortForCli: () => !scenario.invalidReasoning,
    codexDefaultReasoningLevel: () => 'medium', normalizeCliAgent: () => null,
    validateProviderSelection: () => scenario.selectionError ? { ok: false, error: 'bad selection' } : ({ ok: true, value: scenario.selection || null }),
    providers: { normalizeOfficialProviderId: (_cli, id) => id },
    primaryProviderCandidate: () => scenario.primary || null, providerDefaults: scenario.providerDefaults || {},
    validProviderId: (_cli, id) => ({ ok: !scenario.invalidProvider, value: id }),
    allocateSessionId: () => 's1', persistedSessions: records,
    ensureDirGitReady: async () => { events.push(['ready']); return scenario.ready || { ok: true }; },
    friendlyDirReason: reason => `reason:${reason}`, WORKTREE_SUBDIR: '.multicc-worktrees',
    gitWorktreeAdd: async () => { events.push(['add']); if (scenario.addError) throw scenario.addErrorValue === undefined ? new Error('add failed') : scenario.addErrorValue; return { worktreePath: '/wt/s1', branch: 'multicc/s1' }; },
    gitWorktreeRollbackCreate: async (...args) => { events.push(['rollback', ...args]); if (scenario.rollbackError) throw new Error('rollback failed'); },
    sanitizeLoginEnv: () => ({ ok: true }), ensureCliStates: note('states'),
    sessionPersistence: { mutate: (_source, mutate) => { events.push(['mutate']); if (scenario.persistError) throw scenario.persistErrorValue || new Error('persist failed'); mutate(records); } },
    savePersistedSessionsBestEffort: note('save'), appendEvent: note('event'),
    cliForLoginFlow: () => null, loginWorkspacePath: () => '/login/s1',
  };
  if (scenario.productionPorts) {
    delete deps.allocateSessionId;
    delete deps.sharedWorkspace;
    delete deps.cliForLoginFlow;
    deps.existsSync = fs.existsSync;
  }
  return { run: implementation.createSessionRecordFactory(deps), events, records };
}
function normalize(value) {
  return JSON.parse(JSON.stringify(value, (key, v) => key === 'createdAt' || key === 'lastWorkAt' ? '<time>' : v));
}
const dir = { id: 'd1', path: '/repo', baseBranch: 'main' };
test('正式创建入口从原生记录表分配 ID，保留旧序号并处理跨目录重名', async () => {
  const { createSessionRecords } = require('../src/session/records');
  const { createStateOwner } = require('../src/state/owner');
  const records = createSessionRecords(null, createStateOwner());
  const item = world(candidate, { productionPorts: true, records });
  const create = (directory, cli = 'claude', kind = 'chat', extra = {}) =>
    item.run({ dir: directory, cli, kind, ...extra });
  const stem = 're-po-codex-term';
  const directory = { ...dir, name: '  Ｒé pō  ' };
  for (const [suffix, dirId] of [['0003', dir.id], ['04', 'other'], ['99x', dir.id], ['100', 'other']]) {
    const id = stem + '-' + suffix;
    records.set(id, { id, dirId });
  }
  assert.equal((await create(directory, 'codex', 'terminal')).id, stem + '-05');
  assert.equal((await create(directory, 'codex', 'terminal')).id, stem + '-06');
  assert.equal((await create({ ...dir, path: path.join('parent', 'abc') + path.sep })).id, 'abc-claude-chat-01');
  assert.equal((await create({ ...dir, name: '中文' })).id, 'dir-claude-chat-01');
  assert.equal((await create({ ...dir, name: 'a'.repeat(31) + ' XYZ' })).id, 'a'.repeat(31) + '-claude-chat-01');
  const huge = 'overflow-claude-chat-' + '9'.repeat(50);
  records.set(huge, { id: huge, dirId: dir.id });
  assert.match((await create({ ...dir, name: 'overflow' })).id, /^overflow-claude-chat-[a-z0-9]{8}$/);
  for (let n = 1; n < 1000; n++) {
    const id = 'full-claude-chat-' + String(n).padStart(2, '0');
    records.set(id, { id, dirId: 'other' });
  }
  assert.match((await create({ ...dir, name: 'full' })).id, /^full-claude-chat-[a-z0-9]{8}$/);
  assert.equal((await create(dir, 'codex', 'terminal', { id: stem + '-05' })).reused, true);
});

test('正式共享工作区入口复用所有者并拒绝缺失或休眠的工作区', async () => {
  const root = { id: 'root', dirId: dir.id, branch: 'main', worktreePath: __dirname };
  const records = new Map([[root.id, root]]);
  const item = world(candidate, { productionPorts: true, records });
  const create = () => item.run({ dir, cli: 'claude', kind: 'chat', workspaceOwnerSessionId: root.id });
  assert.equal((await create()).session.worktreePath, root.worktreePath);
  for (const change of [{ dirId: 'other' }, { workspaceState: 'hibernated' }, { workspaceOwnerSessionId: 'ancestor' },
    { worktreePath: path.join(__dirname, 'absent-worktree') }, { branch: '' }]) {
    records.set(root.id, { ...root, ...change });
    assert.equal((await create()).error, 'worktree 创建失败: shell_workspace_unavailable');
  }
});

test('创建会话支持强度和两个独立布尔开关', async () => {
  for (const [input, expected] of [
    [{ effort: 'medium', claudeWorkflow: true, preferSubtasks: false }, ['medium', true, false]],
    [{ effort: 'ultracode' }, ['xhigh', true, undefined]],
    [{ model: 'claude-sonnet-4-6', effort: 'ultracode' }, ['high', true, undefined]],
    [{ cli: 'codex', effort: 'high', preferSubtasks: true }, ['high', undefined, true]],
  ]) {
    const result = await world(candidate, {}).run({ dir, kind: 'chat', cli: 'claude', ...input });
    assert.equal(result.ok, true);
    const { effort, claudeWorkflow, preferSubtasks } = result.session;
    assert.deepEqual([effort, claudeWorkflow, preferSubtasks], expected);
  }
});
const cases = [
  ['missing argument', undefined, {}],
  ['null argument', null, {}],
  ['missing directory', {}, {}],
  ['invalid cli', { dir, cli: 'invalid', kind: 'chat' }, {}],
  ['invalid kind', { dir, cli: 'claude', kind: 'other' }, {}],
  ['experimental terminal', { dir, cli: 'codex-exp', kind: 'terminal' }, {}],
  ['invalid model', { dir, cli: 'claude', kind: 'chat', model: 'bad model' }, {}],
  ['model symbol', { dir, cli: 'claude', kind: 'chat', model: Symbol('model') }, {}],
  ['model newline', { dir, cli: 'claude', kind: 'chat', model: 'model\n' }, {}],
  ['invalid effort', { dir, cli: 'claude', kind: 'chat' }, { invalidEffort: true }],
  ['invalid reasoning', { dir, cli: 'claude', kind: 'chat' }, { invalidReasoning: true }],
  ['invalid provider selection', { dir, cli: 'claude', kind: 'chat' }, { selectionError: true }],
  ['invalid provider', { dir, cli: 'claude', kind: 'chat', provider: 'bad' }, { invalidProvider: true }],
  ['selected provider allowed', { dir, cli: 'claude', kind: 'chat', provider: 'p1' }, { selection: { candidates: [{ providerId: 'p1', enabled: true }] } }],
  ['selected provider rejected', { dir, cli: 'claude', kind: 'chat', provider: 'p1' }, { selection: { candidates: [{ providerId: 'p1', enabled: false }] } }],
  ['sparse selected candidates', { dir, cli: 'claude', kind: 'chat', provider: 'p1' }, { selection: { candidates: [, { providerId: 'p1', enabled: true }] } }],
  ['native vendor default', { dir, cli: 'claude', kind: 'chat' }, { primary: { providerId: 'gemini-native:gemini' }, providerDefaults: { claude: 'fallback' } }],
  ['explicit subagent disabled', { dir, cli: 'claude', kind: 'chat', subagent: null }, {}],
  ['account picks', { dir, cli: 'claude', kind: 'chat', cliAccounts: { claude: 'acct', codex: '', bad: 2 } }, {}],
  ['worker flags', { dir, cli: 'claude', kind: 'chat', type: 'worker', taskExecutionSlot: true, ephemeral: true }, {}],
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
  ['worktree rejects null', { dir, cli: 'claude', kind: 'chat' }, { addError: true, addErrorValue: null }],
  ['worktree rejects symbol message', { dir, cli: 'claude', kind: 'chat' }, { addError: true, addErrorValue: { message: Symbol('failure') } }],
  ['worktree error primitive hint', { dir, cli: 'claude', kind: 'chat' }, { addError: true, addErrorValue: { message: { valueOf() { return 'value'; }, toString() { return 'text'; } } } }],
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
    if (outputs[0].value?.session) assert.deepEqual(Object.keys(outputs[1].value.session), Object.keys(outputs[0].value.session));
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

test('persistence rejection preserves the original error identity after rollback', async () => {
  for (const implementation of [frozen.exports, candidate]) {
    const original = new Error('identity');
    const item = world(implementation, { persistError: true, persistErrorValue: original });
    await assert.rejects(item.run({ dir, cli: 'claude', kind: 'chat', persistence: 'required' }), error => error === original);
    assert.equal(item.events.at(-1)[0], 'rollback');
  }
});

test('factory validates its injected resident port synchronously', () => {
  for (const implementation of [frozen.exports, candidate]) {
    assert.throws(() => implementation.createSessionRecordFactory({}), {
      name: 'TypeError', message: '[session/create-record] isResidentSession port is required',
    });
  }
});

test('native callbacks release factory and pending-operation reference cycles', () => {
  const { spawnSync } = require('node:child_process');
  const addon = require('../src/native/runtime').addonPath();
  const script = String.raw`
    const addon = require(process.argv[1]);
    const path = require('node:path');
    function factoryCycle() {
      let factory;
      const deps = { isResidentSession() { return factory; } };
      factory = addon.sessionCreateRecordFactory(deps, path);
      return new WeakRef(factory);
    }
    function pendingCycle() {
      const deps = {
        isResidentSession() {}, SUPPORTED_CHAT_CLIS: ['claude'], cliForLoginFlow() {},
        tuiChatMirrorEnabled() {}, validateExperimentalSession() { return { ok: true }; },
        normalizeEffort() { return null; }, validEffortForCli() { return true; },
        normalizeCliAgent() { return null; }, validateProviderSelection() { return { ok: true, value: null }; },
        providers: { normalizeOfficialProviderId(_cli, id) { return id; } },
        primaryProviderCandidate() {}, providerDefaults: {}, sanitizeLoginEnv() { return { ok: true }; },
        allocateSessionId() { return 's'; }, persistedSessions: new Map(),
        ensureDirGitReady() { return new Promise(() => {}); },
      };
      const input = { dir: { id: 'd', path: '/repo' }, cli: 'claude', kind: 'chat', ephemeral: true };
      const pending = addon.sessionCreateRecordFactory(deps, path)(input);
      input.pending = pending;
      return new WeakRef(pending);
    }
    (async () => {
      const refs = [factoryCycle(), pendingCycle()];
      for (let i = 0; i < 30; i++) { await new Promise(resolve => setImmediate(resolve)); global.gc(); }
      if (refs.some(ref => ref.deref() !== undefined)) throw new Error('native callback retained a cycle');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['--expose-gc', '-e', script, addon], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr || String(child.error));
});
