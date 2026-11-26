'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  isNewSchema,
  hasMigratableOldSessions,
  migrateOldSchema,
  bootstrapState,
} = require('../src/native/binding').stateBootstrap;

function createHarness(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-state-bootstrap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = {
    sessionsFile: path.join(root, 'sessions.json'),
    directoriesFile: path.join(root, 'directories.json'),
    journalDir: path.join(root, 'journal'),
  };
  fs.writeFileSync(paths.sessionsFile, 'legacy-source');
  const calls = [];
  const logs = [];
  const stateOwner = {
    replayJournals() {
      calls.push({ type: 'replay' });
      return {
        replayed: 0, skipped: 0, messages: [],
        ...(overrides.replay || {}),
      };
    },
    loadSessions() {
      calls.push({ type: 'loadSessions', file: paths.sessionsFile });
      if (overrides.loadSessions) return overrides.loadSessions();
      return { present: true, data: [] };
    },
    loadDirectories() {
      calls.push({ type: 'loadDirectories', file: paths.directoriesFile });
      if (overrides.loadDirectories) return overrides.loadDirectories();
      return { present: true, recovered: false, recoveredFrom: null, size: 0, errorKind: null };
    },
    initDirectories(entries) {
      calls.push({ type: 'initDirectories', entries: [...entries] });
    },
  };
  const chatHistoryRepository = {
    renameSession(from, to) {
      calls.push({ type: 'rename', from, to });
      if (overrides.renameError) throw new Error('rename failed /secret/path');
    },
  };
  const logger = {
    log: message => logs.push(`log:${message}`),
    warn: message => logs.push(`warn:${message}`),
    error: message => logs.push(`error:${message}`),
  };
  return {
    root, paths, calls, logs, stateOwner, chatHistoryRepository, logger,
    run(extra = {}) {
      return bootstrapState({
        fs,
        paths,
        stateOwner,
        chatHistoryRepository,
        logger,
        randomUUID: () => 'dir-fixed',
        ...extra,
      });
    },
  };
}

test('schema detection distinguishes new records from migratable legacy pairs', () => {
  assert.equal(isNewSchema([]), false);
  assert.equal(isNewSchema([{ id: 'new', dirId: 'd1' }]), true);
  assert.equal(isNewSchema([{ id: 'new', kind: 'chat' }]), true);
  assert.equal(hasMigratableOldSessions([{ id: '__aux__', type: 'aux' }]), false);
  assert.equal(hasMigratableOldSessions([{ id: 'old', cwd: '/tmp/project' }]), true);
  assert.equal(hasMigratableOldSessions([{ id: 'new', dirId: 'd1', kind: 'chat' }]), false);
});

test('legacy migration preserves Aux and splits terminal plus optional chat', () => {
  let sequence = 0;
  const result = migrateOldSchema([
    { id: '__aux__', type: 'aux' },
    {
      id: 'project', cwd: '/tmp/project', createdAt: 'then',
      claudeSessionId: 'terminal-native', chatClaudeSessionId: 'chat-native',
    },
    { id: 'terminal-only', cwd: '/tmp/other', createdAt: 'later' },
  ], { randomUUID: () => `dir-${++sequence}` });

  assert.equal(result.directories.size, 2);
  assert.deepEqual(result.directories.get('dir-1'), {
    id: 'dir-1', name: 'project', path: '/tmp/project', createdAt: 'then',
  });
  assert.deepEqual(result.sessions.get('project'), {
    id: 'project', dirId: 'dir-1', cli: 'claude', kind: 'terminal',
    cliSessionId: 'terminal-native', createdAt: 'then',
  });
  assert.equal(result.sessions.get('project-chat').cliSessionId, 'chat-native');
  assert.equal(result.sessions.get('terminal-only').cliSessionId, null);
  assert.equal(result.sessions.get('__aux__').type, 'aux');
  assert.deepEqual(result.chatHistoryRenames, [{ from: 'project', to: 'project-chat' }]);
});

test('bootstrap replays journals, constructs stores and loads the current schema', t => {
  const harness = createHarness(t, {
    replay: { replayed: 1, skipped: 2, messages: ['journal detail'] },
    loadSessions: () => ({ present: true, data: [
      { id: 's1', dirId: 'd1', kind: 'chat' },
    ] }),
    loadDirectories: () => ({ present: true, recovered: false, recoveredFrom: null, size: 1 }),
  });
  const result = harness.run();

  assert.equal(result.state.persistedSessions.get('s1').kind, 'chat');
  assert.equal(result.state.needsSave, false);
  assert.equal(result.state.needsDefaultDirectory, false);
  assert.deepEqual(harness.calls, [
    { type: 'replay' },
    { type: 'loadSessions', file: harness.paths.sessionsFile },
    { type: 'loadDirectories', file: harness.paths.directoriesFile },
  ], 'journals replay before the native owner loads either file');
  assert.equal(harness.logs.includes('log:journal detail'), true);
  assert.equal(harness.logs.some(line => /1 replayed, 2 skipped/.test(line)), true);
  assert.equal(harness.logs.some(line => /Loaded 1 directories, 1 session/.test(line)), true);
});

test('only a never-configured installation requests the default directory', t => {
  let harness = createHarness(t, {
    loadSessions: () => ({ present: false, data: [] }),
    loadDirectories: () => ({ present: false, recovered: false, recoveredFrom: null, size: 0 }),
  });
  assert.equal(harness.run().state.needsDefaultDirectory, true);

  harness = createHarness(t, {
    loadSessions: () => ({ present: true, data: [] }),
    loadDirectories: () => ({ present: true, recovered: false, recoveredFrom: null, size: 0 }),
  });
  assert.equal(harness.run().state.needsDefaultDirectory, false,
    'an explicitly empty registry means the user removed every directory');

  harness = createHarness(t, {
    loadSessions: () => ({ present: true, data: [{ id: '__aux__', type: 'aux' }] }),
    loadDirectories: () => ({ present: false, recovered: false, recoveredFrom: null, size: 0 }),
  });
  assert.equal(harness.run().state.needsDefaultDirectory, true,
    'an interrupted first launch retries even if the aux record was persisted');
});

test('bootstrap migrates old state, renames history and writes a rollback copy', t => {
  const harness = createHarness(t, {
    loadSessions: () => ({ present: true, data: [
      { id: '__aux__', type: 'aux' },
      {
        id: 'old', cwd: '/tmp/old', createdAt: 'then',
        claudeSessionId: 'native-terminal', chatClaudeSessionId: 'native-chat',
      },
    ] }),
    loadDirectories: () => ({ present: true, recovered: false, recoveredFrom: null, size: 1 }),
  });
  const result = harness.run();

  assert.equal(result.state.needsSave, true);
  const installed = harness.calls.find(call => call.type === 'initDirectories');
  assert.ok(installed, 'legacy migration installs directories into the native owner');
  assert.deepEqual(installed.entries.map(([id, record]) => [id, record.path]),
    [['dir-fixed', '/tmp/old']],
    'legacy migration replaces the stale native directory table');
  assert.equal(result.state.persistedSessions.get('old-chat').cliSessionId, 'native-chat');
  assert.deepEqual(harness.calls.find(call => call.type === 'rename'), {
    type: 'rename', from: 'old', to: 'old-chat',
  });
  assert.equal(fs.readFileSync(`${harness.paths.sessionsFile}.pre-directory.bak`, 'utf8'), 'legacy-source');
});

test('history rename failure remains best-effort while recovery is observable', t => {
  const harness = createHarness(t, {
    renameError: true,
    loadSessions: () => ({
      present: true,
      recovered: true,
      recoveredFrom: 'sessions.json.bak1',
      data: [{ id: 'old', cwd: '/tmp/old', chatClaudeSessionId: 'chat' }],
    }),
    loadDirectories: () => ({
      present: true,
      recovered: true,
      recoveredFrom: 'directories.json.bak2',
      size: 0,
    }),
  });
  const result = harness.run();
  assert.equal(result.state.needsSave, true);
  assert.equal(harness.logs.some(line => /sessions\.json recovered/.test(line)), true);
  assert.equal(harness.logs.some(line => /directories\.json recovered/.test(line)), true);
  assert.equal(harness.logs.some(line => /chat_history rename failed/.test(line)), true);
});

test('unreadable sessions or directories fail closed instead of returning empty state', t => {
  let harness = createHarness(t, {
    loadSessions: () => { throw new Error('sessions corrupt'); },
  });
  assert.throws(() => harness.run(), /sessions corrupt/);
  assert.equal(harness.logs.some(line => /sessions\.json unreadable/.test(line)), true);

  harness = createHarness(t, {
    loadSessions: () => ({ present: true, data: [] }),
    loadDirectories: () => { throw new Error('directories corrupt'); },
  });
  assert.throws(() => harness.run(), /directories corrupt/);
  assert.equal(harness.logs.some(line => /directories\.json unreadable/.test(line)), true);
});

test('production composition delegates state loading and removes legacy host helpers', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /bootstrapState\s*\(\s*\{/);
  assert.match(source, /const _state = stateBootstrap\.state/);
  assert.doesNotMatch(source, /function\s+loadDirectories\s*\(/);
  assert.doesNotMatch(source, /function\s+migrateOldSchema\s*\(/);
  assert.doesNotMatch(source, /function\s+loadPersistedState\s*\(/);
  assert.doesNotMatch(source, /function\s+ensureUltracodeWorkers\s*\(/);
  assert.match(source, /const ensureFirstRunDirectory\s*=\s*async/);
  assert.match(source, /getNative\(\)\.ensureFirstRunDirectory\(_state, directories, directoryModule, MULTICC_PATHS, logger\)/);
  const directoryHost = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'directory-host.js'), 'utf8');
  assert.match(directoryHost, /async function registerDefaultDirectory\(\{\s*name,\s*path:\s*rawPath\s*\}\)/);
  assert.match(directoryHost, /if \(!fsPort\.exists\(resolved\)\) fsPort\.mkdirp\(resolved\)/,
    'the default workspace must still be created when it does not exist');
  assert.match(source, /then\(ensureFirstRunDirectory\)\.then\(initWorktrees\)/,
    'readiness must create the default directory before worktrees are initialized');
});

// The complete pre-migration implementation remains an independent oracle.
const legacyBootstrap = require('./helpers/legacy-bootstrap-state');
const nativeBootstrap = { isNewSchema, hasMigratableOldSessions, migrateOldSchema, bootstrapState };
const frozenBootstrap = fs.readFileSync(path.join(__dirname, 'helpers/legacy-bootstrap-state.js'));
const OPAQUE_UUID = Object.freeze({ uuid: 'opaque', fn() {} });

test('bootstrap oracle is byte-frozen and the production file is retired', () => {
  assert.equal(require('node:crypto').createHash('sha256').update(frozenBootstrap).digest('hex'),
    'dd4d45eedc4fe5ca92e61f7e763ac697251466166542c2a107f6d4c862d14c99');
  assert.equal(fs.existsSync(path.join(__dirname, '../src/bootstrap/state.js')), false);
});

function differentialBootstrap(api, config = {}, failAt) {
  const trace = [];
  const marker = { message: 'port error \ud800', marker: true };
  const wrap = (name, value) => new Proxy(value, {
    get(target, key, receiver) {
      trace.push(['get', name, String(key)]);
      if (failAt === `${name}.${String(key)}`) throw marker;
      return Reflect.get(target, key, receiver);
    },
    ownKeys() { throw new Error('startup input must not be cloned'); },
  });
  const raw = config.records || [{ id: 'old\ud800', cwd: '/fake/project', createdAt: 'then',
    claudeSessionId: 'terminal', chatClaudeSessionId: 'chat' }, { id: '__aux__', type: 'aux' }];
  const records = raw.map((r, i) => wrap(`record${i}`, r));
  const source = wrap('records', records);
  const sessions = wrap('sessions', { present: config.sessionsPresent !== false,
    recovered: !!config.recovered, recoveredFrom: 'sessions.bak', data: source });
  const directories = wrap('directories', { present: config.directoriesPresent !== false,
    recovered: !!config.recovered, recoveredFrom: 'directories.bak', size: 2 });
  const replay = wrap('replay', { replayed: 1, skipped: 2, messages: ['replayed-detail'] });
  const paths = wrap('paths', { sessionsFile: '/fake/sessions.json', directoriesFile: '/fake/directories.json', journalDir: '/fake/journal' });
  let owner;
  owner = wrap('owner', {
    replayJournals() { trace.push(['replay', this === owner]); return replay; },
    loadSessions() { trace.push(['loadSessions', this === owner]); if (config.loadSessionsError) throw marker; return sessions; },
    loadDirectories() { trace.push(['loadDirectories', this === owner]); if (config.loadDirectoriesError) throw marker; return directories; },
    initDirectories(entries) { trace.push(['initialize', this === owner, [...entries]]); },
  });
  let history;
  history = wrap('history', {
    renameSession(from, to) { trace.push(['rename', this === history, from, to]); if (config.renameError) throw marker; },
  });
  let filesystem;
  filesystem = wrap('fs', {
    copyFileSync(...args) { trace.push(['copy', this === filesystem, ...args]); if (config.copyError) throw marker; },
  });
  let logger;
  logger = wrap('logger', {
    log(value) { trace.push(['log', this === logger, value]); },
    warn(value) { trace.push(['warn', this === logger, value]); if (config.warningError) throw marker; },
    error(value) { trace.push(['error', this === logger, value]); },
  });
  let sequence = 0;
  const uuid = function () {
    trace.push(['uuid', this === undefined]);
    if (config.uuidError) throw marker;
    return config.opaqueUuid ? OPAQUE_UUID : `dir-${++sequence}`;
  };
  const options = wrap('options', { stateOwner: owner, paths, chatHistoryRepository: history,
    fs: filesystem, randomUUID: uuid, logger });
  try {
    const result = api.bootstrapState(options);
    assert.equal(Object.isFrozen(result), true);
    const entries = [...result.state.persistedSessions.entries()].map(([id, value]) => {
      if (records.includes(value)) return [id, { originalIdentity: records.indexOf(value) }];
      return [id, value];
    });
    return { entries, needsSave: result.state.needsSave, needsDefaultDirectory: result.state.needsDefaultDirectory, trace };
  } catch (error) {
    assert.equal(error, marker, 'host failure identity is preserved');
    return { thrown: true, trace };
  }
}

test('startup differential preserves live getter/callback order, identity and recovery logs', () => {
  for (const records of [[], [{ id: '__aux__', type: 'aux' }],
    [{ id: 'new', dirId: 'd', kind: 'chat' }],
    [{ id: 'old\ud800', cwd: '/fake/project', chatClaudeSessionId: 'chat' }, { id: '__aux__', type: 'aux' }],
    [{ id: 'one' }, { id: 'two', chatClaudeSessionId: 'chat2' }]]) {
    for (const recovered of [false, true]) for (const directoriesPresent of [false, true]) {
      const config = { records, recovered, directoriesPresent };
      assert.deepEqual(differentialBootstrap(nativeBootstrap, config), differentialBootstrap(legacyBootstrap, config));
    }
  }
});

test('rename and backup failures keep their original best-effort boundaries', () => {
  for (const config of [{ renameError: true }, { copyError: true }, { renameError: true, copyError: true },
    { opaqueUuid: true }, { sessionsPresent: false }, { warningError: true, recovered: true }]) {
    assert.deepEqual(differentialBootstrap(nativeBootstrap, config), differentialBootstrap(legacyBootstrap, config));
  }
});

test('startup failures retain exception identity and stop at the same effect', () => {
  for (const config of [{ loadSessionsError: true }, { loadDirectoriesError: true }, { uuidError: true }]) {
    assert.deepEqual(differentialBootstrap(nativeBootstrap, config), differentialBootstrap(legacyBootstrap, config));
  }
  for (const failAt of ['options.stateOwner', 'owner.replayJournals', 'owner.loadSessions',
    'owner.loadDirectories', 'owner.initDirectories', 'paths.sessionsFile', 'options.fs',
    'options.randomUUID', 'options.logger', 'history.renameSession', 'logger.log', 'fs.copyFileSync',
    'record0.cwd', 'record0.chatClaudeSessionId']) {
    assert.deepEqual(differentialBootstrap(nativeBootstrap, {}, failAt), differentialBootstrap(legacyBootstrap, {}, failAt), failAt);
  }
});

test('schema predicates retain Array.some short circuiting, holes and live reads', () => {
  for (const name of ['isNewSchema', 'hasMigratableOldSessions']) {
    const run = api => {
      const trace = [];
      const record = new Proxy({ id: '__aux__', type: 'aux', dirId: undefined, kind: undefined }, {
        get(target, key) { trace.push(key); return target[key]; },
      });
      const records = [record, , { dirId: null }];
      return { value: api[name](records), trace };
    };
    assert.deepEqual(run(nativeBootstrap), run(legacyBootstrap));
    assert.throws(() => nativeBootstrap[name]([null]), TypeError);
  }
});

test('legacy migration preserves duplicate Map keys and closes an iterable on UUID failure', () => {
  const run = api => {
    const trace = [];
    const records = [{ id: 'same', chatClaudeSessionId: 'c1' }, { id: 'same', chatClaudeSessionId: 'c2' }];
    let n = 0;
    const result = api.migrateOldSchema(records, { randomUUID: () => `d-${++n}` });
    const marker = {};
    const iterable = { *[Symbol.iterator]() { try { yield { id: 'a' }; yield { id: 'b' }; } finally { trace.push('closed'); } } };
    assert.throws(() => api.migrateOldSchema(iterable, { randomUUID() { trace.push('uuid'); throw marker; } }), e => e === marker);
    return { result, trace };
  };
  assert.deepEqual(run(nativeBootstrap), run(legacyBootstrap));
});

test('boot validation errors are unchanged and do not touch storage', () => {
  for (const options of [undefined, null, false, 1, () => {}, {}, { stateOwner: {} },
    { stateOwner: { replayJournals() {}, loadSessions() {}, loadDirectories() {}, initDirectories() {} } }]) {
    const outcome = api => {
      try { api.bootstrapState(options); return null; }
      catch (error) { return [error.name, error.message]; }
    };
    assert.deepEqual(outcome(nativeBootstrap), outcome(legacyBootstrap));
  }
});

test('first-run workspace registration preserves rejection and reason identity across startup', async () => {
  const { ensureFirstRunDirectory } = require('../src/native/binding').getNative();
  const state = { needsDefaultDirectory: true }, directories = new Map();
  const paths = { defaultWorkspacePath: '/data/工作区' };
  const info = [], warnings = [];
  const logger = { info: (...args) => info.push(args), warn: (...args) => warnings.push(args) };
  let register;
  const module = { host: { registerDefaultDirectory(options) {
    assert.deepEqual(options, { name: '我的工作区', path: paths.defaultWorkspacePath });
    return register();
  } } };
  const boot = async () => ensureFirstRunDirectory(state, directories, module, paths, logger);
  const pending = Promise.withResolvers();
  register = () => pending.promise;
  const job = boot();
  assert.deepEqual(info, []);
  pending.resolve({ ok: true, data: { id: 'first', path: paths.defaultWorkspacePath } });
  assert.equal(await job, undefined);
  assert.deepEqual(info, [['default_directory_created', { id: 'first', path: paths.defaultWorkspacePath }]]);
  const cause = {};
  register = () => ({ ok: false, message: cause });
  assert.equal(await boot(), undefined);
  assert.equal(warnings[0][0], 'default_directory_create_failed');
  assert.equal(warnings[0][1].reason, cause);
  register = () => Promise.reject(cause);
  await assert.rejects(boot(), err => err === cause);
  register = () => { throw cause; };
  await assert.rejects(boot(), err => err === cause);
  directories.set('existing', {});
  assert.equal(await boot(), undefined);
});
