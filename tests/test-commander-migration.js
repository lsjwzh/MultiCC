'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { assertTestDir } = require('../src/paths');
const { createTaskBoardRuntime } = require('../src/routes/task-board');
const {
  COMMANDER_LABEL,
  chooseCommanderRuntime,
  createCommanderMigration,
  createCommanderMigrationState,
} = require('../src/commander-migration');

const LEGACY_PROMPT = [
  '# 🫡 Agent Commander',
  'You are the **Agent Commander** — old bundled wording.',
  '## 🗺️ How multicc works (your battlefield)',
  'historical content',
  '## 🚫 Anti-patterns',
].join('\n\n');

function makeTempFleet(t, id) {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-commander-unit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=test@multicc.local', '-c', 'user.name=MultiCC Test',
    'commit', '--allow-empty', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });
  return { root, dataRoot, directory: { id, name: id, path: repo, createdAt: id } };
}

function harness(t, { directories: inputDirectories, records: inputRecords, failCreateFor } = {}) {
  const previousDataRoot = process.env.MULTICC_DATA_DIR;
  const first = makeTempFleet(t, 'dir-a');
  process.env.MULTICC_DATA_DIR = first.dataRoot;
  t.after(() => {
    if (previousDataRoot === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previousDataRoot;
  });
  const directories = inputDirectories || new Map([[first.directory.id, first.directory]]);
  const records = inputRecords || new Map();
  const state = createCommanderMigrationState();
  const creates = [];
  const refreshes = [];
  const migration = createCommanderMigration({
    state,
    directories,
    records,
    commanderPrompt: () => LEGACY_PROMPT + '\n\ncomplete current role',
    commanderPreset: () => ({ defaultCli: 'codex' }),
    validateDirectory: directory => ({ valid: fs.existsSync(directory.path), code: 'directory_missing' }),
    selectRuntime: directory => chooseCommanderRuntime({
      directory,
      records,
      preset: { defaultCli: 'codex' },
      supportedClis: ['claude', 'codex'],
      availability: { claude: { available: true }, codex: { available: true } },
      providerDefaults: { codex: 'stale', claude: 'claude-good' },
      listProviders: cli => cli === 'codex'
        ? [{ id: 'codex-good' }]
        : [{ id: 'claude-good' }],
    }),
    refreshSession: (sessionId, directoryId, rolePrompt) => {
      const record = records.get(sessionId);
      assert.equal(record.dirId, directoryId);
      assert.equal(record.type, 'commander');
      record.rolePrompt = rolePrompt;
      refreshes.push(sessionId);
      return record;
    },
    createSession: async spec => {
      creates.push(spec);
      if (spec.dir.id === failCreateFor) return { ok: false, code: 'commander_create_injected' };
      const id = `commander-${spec.dir.id}`;
      const session = { id, dirId: spec.dir.id, ...spec };
      delete session.dir;
      records.set(id, session);
      return { ok: true, session };
    },
    logger: { info() {}, error() {} },
  });
  return { ...first, directories, records, state, migration, creates, refreshes };
}

test('empty Fleet creates one normal typed Commander and repeated migration is idempotent', async t => {
  const h = harness(t);
  const first = await h.migration.run();
  assert.equal(first.ready, true);
  assert.equal(h.creates.length, 1);
  assert.equal(h.creates[0].kind, 'chat');
  assert.equal(h.creates[0].type, 'commander');
  assert.equal(h.creates[0].label, COMMANDER_LABEL);
  assert.equal(h.creates[0].persistence, 'required');
  assert.ok(h.creates[0].rolePrompt.length > 100);
  assert.equal(h.creates[0].provider, 'codex-good', 'stale default provider is never persisted');
  assert.equal(h.creates[0].model, null, 'migration follows a live provider default instead of a release model');

  const second = await h.migration.run();
  assert.equal(second.ready, true);
  assert.equal(h.creates.length, 1, 'second upgrade must not duplicate the Commander');
  assert.equal(second.results[0].action, 'existing');
});

test('an existing typed Commander is retained and refreshed to the router-only role', async t => {
  const fleet = makeTempFleet(t, 'dir-typed');
  const records = new Map([['typed', {
    id: 'typed', dirId: fleet.directory.id, kind: 'chat', type: 'commander', label: 'custom label',
  }]]);
  const h = harness(t, { directories: new Map([[fleet.directory.id, fleet.directory]]), records });
  const result = await h.migration.run();
  assert.equal(result.results[0].action, 'refreshed');
  assert.equal(h.creates.length, 0);
  assert.deepEqual(h.refreshes, ['typed']);
  assert.match(records.get('typed').rolePrompt, /complete current role/);
});

test('all untyped historical and same-name sessions remain untouched while fresh Commanders are created', async t => {
  const historicalFleet = makeTempFleet(t, 'dir-historical');
  const sameNameFleet = makeTempFleet(t, 'dir-same-name');
  const records = new Map([
    ['legacy', {
      id: 'legacy', dirId: historicalFleet.directory.id, kind: 'chat', label: COMMANDER_LABEL,
      rolePrompt: LEGACY_PROMPT,
    }],
    ['ordinary', {
      id: 'ordinary', dirId: sameNameFleet.directory.id, kind: 'chat', label: COMMANDER_LABEL,
      rolePrompt: '你是普通工程师，不是指挥官。',
    }],
  ]);
  const directories = new Map([
    [historicalFleet.directory.id, historicalFleet.directory],
    [sameNameFleet.directory.id, sameNameFleet.directory],
  ]);
  const h = harness(t, { directories, records });
  const result = await h.migration.run();
  assert.equal(result.ready, true);
  assert.equal(records.get('legacy').type, undefined);
  assert.equal(records.get('ordinary').type, undefined);
  assert.deepEqual(h.creates.map(spec => spec.dir.id).sort(), ['dir-historical', 'dir-same-name']);
  assert.equal(records.get('commander-dir-historical').type, 'commander');
  assert.equal(records.get('commander-dir-same-name').type, 'commander');
});

test('multi-directory failure is isolated and reported with directoryId', async t => {
  const good = makeTempFleet(t, 'dir-good');
  const bad = makeTempFleet(t, 'dir-bad');
  const directories = new Map([[good.directory.id, good.directory], [bad.directory.id, bad.directory]]);
  const h = harness(t, { directories, records: new Map(), failCreateFor: 'dir-bad' });
  const result = await h.migration.run();
  assert.equal(result.ready, false);
  assert.deepEqual(result.failures, [{ directoryId: 'dir-bad', code: 'commander_create_injected' }]);
  assert.equal(h.state.statusFor('dir-good').ready, true);
  assert.equal(h.state.statusFor('dir-bad').ready, false);
  assert.equal(h.records.has('commander-dir-good'), true);
  assert.equal(h.records.has('commander-dir-bad'), false);
});

test('CLI compatibility order skips unavailable CLIs and never carries stale provider/model', () => {
  const result = chooseCommanderRuntime({
    directory: { id: 'd', defaultCli: 'codex' },
    records: new Map([['worker', { id: 'worker', dirId: 'd', kind: 'chat', cli: 'claude', provider: 'live' }]]),
    preset: { defaultCli: 'codex', defaultModel: 'removed-model' },
    supportedClis: ['claude', 'codex'],
    availability: { codex: false, claude: true },
    providerDefaults: { claude: 'removed-provider' },
    listProviders: cli => cli === 'claude' ? [{ id: 'live' }] : [],
  });
  assert.deepEqual(result, { ok: true, cli: 'claude', provider: 'live', model: null });

  const unavailable = chooseCommanderRuntime({
    directory: { id: 'd' }, records: new Map(), preset: { defaultCli: 'codex' },
    supportedClis: ['claude', 'codex'], availability: { claude: false, codex: false },
    providerDefaults: {}, listProviders: () => [],
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, 'commander_cli_unavailable');
});

test('migration state is fail-closed before completion and safe per Fleet afterwards', () => {
  const state = createCommanderMigrationState();
  assert.equal(state.statusFor('dir-a').code, 'commander_migration_pending');
  state.setPhase('running');
  assert.equal(state.statusFor('dir-a').ready, false);
  state.setDirectory('dir-a', { status: 'ready', sessionId: 'commander-a' });
  state.setDirectory('dir-b', { status: 'failed', code: 'commander_cli_unavailable' });
  state.setPhase('complete');
  assert.equal(state.statusFor('dir-a').ready, true);
  assert.equal(state.statusFor('dir-b').code, 'commander_cli_unavailable');
  assert.equal(state.snapshot().ready, false, 'global readiness reports a partial migration');
});

test('a newly migrated Commander is identified by the task board and binds the task session', async t => {
  const h = harness(t);
  await h.migration.run();
  const commander = h.records.get('commander-dir-a');
  const dispatches = [];
  const creates = [];
  const sends = [];
  const board = createTaskBoardRuntime({
    file: path.join(h.dataRoot, 'task_board.json'),
    auxQueue: { isUnhealthy: () => false, cancel() {}, enqueue: async () => ({ cancelled: true }) },
    records: h.records,
    directories: h.directories,
    loadHistory: () => [],
    dispatchToSession: async (target, message, options) => {
      dispatches.push({ target, message, options });
      return { ok: true, operationId: 'queued-op', status: 'admitted' };
    },
    createSessionRecord: async spec => {
      creates.push(spec);
      const id = `bound-${creates.length}`;
      const record = {
        id, kind: 'chat', dirId: spec.dir.id, cli: spec.cli,
        label: spec.label, taskBoundTaskId: spec.taskBoundTaskId,
      };
      h.records.set(id, record);
      return { ok: true, id, session: record };
    },
    sendSessionMessage: async (sessionId, text, options) => {
      sends.push({ sessionId, text, options });
      return { ok: true, handled: false, chatId: sessionId };
    },
    workspaceBroadcast() {},
    atomicWriteJson: (target, value) => fs.writeFileSync(target, JSON.stringify(value)),
    isSystemInjected: () => false,
    getSessionRunState: () => 'running',
    isSessionBusy: () => true,
    getCommanderMigrationStatus: directoryId => h.state.statusFor(directoryId),
    logger: { log() {} },
  });
  const routes = new Map();
  board.mountRoutes({ get: (route, handler) => routes.set(route, handler), post: (route, handler) => routes.set(route, handler) });
  const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  routes.get('/api/task-board/send')({ body: { dirId: 'dir-a', text: '请指挥官分派' } }, response);
  for (let attempt = 0; attempt < 50 && !response.body; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.equal(response.code, 200);
  assert.equal(response.body.routingMode, 'task-bound');
  assert.equal(response.body.target, 'bound-1');
  assert.equal(response.body.commanderSessionId, null, 'the Commander is no longer a dispatch hop');
  // #38 · the migrated Commander still identifies the directory's runtime — it
  // just lends it to the task-bound session instead of owning a pooled slot.
  assert.equal(creates.length, 1);
  assert.equal(creates[0].dir.id, 'dir-a');
  assert.equal(creates[0].cli, commander.cli);
  assert.equal(creates[0].taskBoundTaskId, response.body.taskId);
  assert.equal(dispatches.length, 0, 'a board send never dispatches through the Commander');
  assert.equal(sends.length, 1, 'the first turn opens directly on the bound session');
  assert.equal(sends[0].sessionId, 'bound-1');
  assert.match(sends[0].text, /请指挥官分派/);
  assert.equal(sends[0].options.taskStart, true);
});
