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
} = require('../src/bootstrap/state');

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
  const stores = {
    sessions: {
      loadOrRecover: overrides.loadSessions || (() => ({ present: true, data: [] })),
      save() {},
    },
    directories: {
      loadOrRecover: overrides.loadDirectories || (() => ({ present: true, data: [] })),
      save() {},
    },
  };
  const stateStore = {
    createStore(spec) {
      calls.push({ type: 'store', spec });
      return stores[spec.kind];
    },
  };
  const stateTx = {
    replayJournals(directory, options) {
      calls.push({ type: 'replay', directory });
      if (overrides.replayLog) options.log('journal detail');
      return overrides.replay || { replayed: 0, skipped: 0 };
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
    root, paths, calls, logs, stores, stateStore, stateTx, chatHistoryRepository, logger,
    run(extra = {}) {
      return bootstrapState({
        fs,
        paths,
        stateStore,
        stateTx,
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
    replay: { replayed: 1, skipped: 2 },
    replayLog: true,
    loadSessions: () => ({ present: true, data: [
      { id: 's1', dirId: 'd1', kind: 'chat' },
    ] }),
    loadDirectories: () => ({ present: true, data: [
      { id: 'd1', name: 'One' },
    ] }),
  });
  const result = harness.run();

  assert.equal(result.sessionsStore, harness.stores.sessions);
  assert.equal(result.directoriesStore, harness.stores.directories);
  assert.equal(result.state.persistedSessions.get('s1').kind, 'chat');
  assert.equal(result.state.directories.get('d1').name, 'One');
  assert.equal(result.state.needsSave, false);
  assert.deepEqual(harness.calls.slice(0, 3).map(call => call.type), ['store', 'store', 'replay']);
  assert.deepEqual(harness.calls[0].spec, {
    file: harness.paths.sessionsFile, kind: 'sessions', schemaVersion: 1, legacyIsArray: true,
  });
  assert.equal(harness.logs.includes('log:journal detail'), true);
  assert.equal(harness.logs.some(line => /1 replayed, 2 skipped/.test(line)), true);
  assert.equal(harness.logs.some(line => /Loaded 1 directories, 1 session/.test(line)), true);
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
    loadDirectories: () => ({ present: true, data: [{ id: 'stale' }] }),
  });
  const result = harness.run();

  assert.equal(result.state.needsSave, true);
  assert.equal(result.state.directories.has('stale'), false, 'legacy migration replaces the stale directory map');
  assert.equal(result.state.directories.get('dir-fixed').path, '/tmp/old');
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
      data: [],
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
});
