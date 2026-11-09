'use strict';

// Durable side of the native directory registry and its cross-file journal:
// byte layout, backup rotation, legacy/corrupt/partial fixtures, crash at every
// transaction step, replay order and resumption, damaged journals, restart
// reload, reentrancy and object identity. Everything runs in an isolated temp
// root.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore, CorruptedStateError } = require('../src/state/store');
const { createSessionRecords } = require('../src/session/records');
const { createStateOwner } = require('../src/state/owner');
const { createDirectoryTable } = require('../src/directory/records');
const legacyTx = require('./helpers/legacy-state-tx');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-dir-durable-'));
  t.after(() => {
    try { fs.chmodSync(root, 0o700); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function pathsOf(root) {
  return {
    directories: path.join(root, 'directories.json'),
    sessions: path.join(root, 'sessions.json'),
    journal: path.join(root, 'journal'),
  };
}

function makeOwner(root, options = {}) {
  const files = pathsOf(root);
  const owner = createStateOwner().configure({
    stringify: JSON.stringify,
    root,
    directoriesFile: files.directories,
    sessionsFile: files.sessions,
    journalDir: files.journal,
    now: Date.now,
    ...options,
  });
  const dirs = createDirectoryTable(owner);
  return { owner, dirs, files };
}

function normalizeTimestamps(text) {
  return text.replace(/"writtenAt": "[^"]*"/g, '"writtenAt": "<ts>"');
}

function recordDigest(entries) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(entries.map(([key, value]) => [key, value])))
    .digest('hex');
}

function journalFiles(files) {
  if (!fs.existsSync(files.journal)) return [];
  return fs.readdirSync(files.journal).filter(name => /^tx-.+\.json$/.test(name)).sort();
}

// Seed both live tables, then write them through one native transaction.
function seed(world, directories, sessions) {
  for (const record of directories) world.dirs.set(record.id, record);
  const records = createSessionRecords(new Map(sessions.map(record => [record.id, record])), world.owner);
  world.owner.commitCrossFileWrite({ kind: 'seed', reason: 'test' });
  return records;
}

test('directories.json save is byte-identical to JSON.stringify(envelope, null, 2)', t => {
  const root = tempRoot(t);
  const world = makeOwner(root);
  const records = [
    { id: 'd1', name: '中文 "quoted" \\ backslash \n tab\t', path: '/tmp/one', createdAt: 1 },
    { id: 'd2', name: 'Numbers', path: '/tmp/two', numbers: [1, -0, 1e21, null, true, ''], nested: { a: {} } },
    { id: 'd3', name: 'Surrogate', path: '/tmp/three', odd: '\ud800' },
  ];
  for (const record of records) world.dirs.set(record.id, record);
  world.owner.saveDirectories();

  const legacyFile = path.join(root, 'legacy.json');
  createStore({ file: legacyFile, kind: 'directories', schemaVersion: 1, legacyIsArray: true })
    .save(JSON.parse(JSON.stringify(records)));

  const nativeText = fs.readFileSync(world.files.directories, 'utf8');
  const legacyText = fs.readFileSync(legacyFile, 'utf8');
  assert.equal(normalizeTimestamps(nativeText), normalizeTimestamps(legacyText));
  assert.equal(nativeText.endsWith('\n'), false, 'no trailing newline, as before');
  assert.equal(fs.statSync(world.files.directories).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(nativeText).data.map(record => record.id), ['d1', 'd2', 'd3']);
});

test('three rolling backups rotate exactly like the StateStore', t => {
  const root = tempRoot(t);
  const world = makeOwner(root);
  const versions = [];
  for (let index = 1; index <= 4; index += 1) {
    const record = { id: `d${index}`, name: `v${index}`, path: `/tmp/${index}` };
    world.dirs.set(record.id, record);
    versions.push(JSON.parse(JSON.stringify([...world.dirs.values()])));
    world.owner.saveDirectories();
  }
  for (let index = 1; index <= 3; index += 1) {
    const backup = fs.readFileSync(`${world.files.directories}.bak${index}`, 'utf8');
    const expected = createStore({ file: path.join(root, 'expected.json'), kind: 'directories', schemaVersion: 1 });
    // The StateStore writes backups as plain `data` arrays inside the envelope.
    expected.save(versions[versions.length - 1 - index]);
    assert.equal(normalizeTimestamps(backup), normalizeTimestamps(fs.readFileSync(path.join(root, 'expected.json'), 'utf8')),
      `bak${index} must hold the version ${index} saves back`);
  }
  assert.equal(fs.existsSync(`${world.files.directories}.bak4`), false);

  // Legacy bare-array file is accepted (and is not reported as a recovery).
  fs.writeFileSync(world.files.directories, JSON.stringify(versions[0]));
  const reopened = makeOwner(root);
  const loaded = reopened.owner.loadDirectories();
  assert.equal(loaded.present, true);
  assert.equal(loaded.recovered, false);
  assert.equal(loaded.size, versions[0].length);
  assert.deepEqual([...reopened.dirs.entries()].map(([id, value]) => [id, value.name]),
    versions[0].map(record => [record.id, record.name]));
});

test('corrupt or missing-envelope primary recovers from a backup, otherwise fails closed', t => {
  const root = tempRoot(t);
  const world = makeOwner(root);
  world.dirs.set('d1', { id: 'd1', name: 'first' });
  world.owner.saveDirectories();
  const first = fs.readFileSync(world.files.directories, 'utf8');
  world.dirs.set('d2', { id: 'd2', name: 'second' });
  world.owner.saveDirectories();

  // Truncated JSON: recover the previous version from bak1.
  const truncated = fs.readFileSync(world.files.directories, 'utf8').slice(0, 40);
  fs.writeFileSync(world.files.directories, truncated);
  let reopened = makeOwner(root);
  const recovered = reopened.owner.loadDirectories();
  assert.equal(recovered.present, true);
  assert.equal(recovered.recovered, true);
  assert.match(recovered.recoveredFrom, /directories\.json\.bak1$/);
  assert.equal(recovered.size, 1);
  assert.equal(reopened.dirs.get('d1').name, 'first');

  // Envelope dropped: treated as corruption, not as an empty registry.
  fs.writeFileSync(world.files.directories, '{"hello":"world"}');
  for (let index = 1; index <= 3; index += 1) fs.rmSync(`${world.files.directories}.bak${index}`, { force: true });
  reopened = makeOwner(root);
  assert.throws(() => reopened.owner.loadDirectories(),
    error => error instanceof CorruptedStateError && /state envelope missing in/.test(error.message));

  // Corrupt JSON with no usable backup: same fail-closed error as the StateStore.
  fs.writeFileSync(world.files.directories, '{"__multiccSchema":');
  reopened = makeOwner(root);
  assert.throws(() => reopened.owner.loadDirectories(),
    error => error instanceof CorruptedStateError && /corrupt JSON in/.test(error.message));

  // Unreadable path (a directory, not a file).
  fs.rmSync(world.files.directories, { force: true });
  fs.mkdirSync(world.files.directories);
  reopened = makeOwner(root);
  assert.throws(() => reopened.owner.loadDirectories(),
    error => error instanceof CorruptedStateError && /unreadable state file/.test(error.message));

  // The recovered bytes are a real state document, not the corrupt text.
  assert.ok(first.length > 40);
});

test('crash between every journal step is recovered identically on boot', t => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  t.after(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  for (const step of ['journal', 'directories', 'sessions']) {
    const root = tempRoot(t);
    const world = makeOwner(root);
    seed(world,
      [{ id: 'd1', name: 'One' }, { id: 'd2', name: 'Two' }],
      [{ id: 's1', dirId: 'd1' }, { id: 's2', dirId: 'd2' }]);

    world.dirs.delete('d1');
    world.owner.native.delete('s1');

    const marker = path.join(root, 'crash.marker');
    fs.writeFileSync(marker, '1');
    const saved = {
      CRASH_FILE: process.env.MULTICC_TEST_STATE_TX_CRASH_FILE,
      CRASH_AT: process.env.MULTICC_TEST_STATE_TX_CRASH_AT,
    };
    process.env.MULTICC_TEST_STATE_TX_CRASH_FILE = marker;
    process.env.MULTICC_TEST_STATE_TX_CRASH_AT = step;
    try {
      assert.throws(() => world.owner.commitCrossFileWrite({ kind: 'delete-directory' }),
        /STATE_TX_CRASH: injected crash at/);
    } finally {
      if (saved.CRASH_FILE === undefined) delete process.env.MULTICC_TEST_STATE_TX_CRASH_FILE;
      else process.env.MULTICC_TEST_STATE_TX_CRASH_FILE = saved.CRASH_FILE;
      if (saved.CRASH_AT === undefined) delete process.env.MULTICC_TEST_STATE_TX_CRASH_AT;
      else process.env.MULTICC_TEST_STATE_TX_CRASH_AT = saved.CRASH_AT;
    }

    assert.equal(journalFiles(world.files).length, 1, `${step}: journal must survive the crash`);
    const dirsAfterCrash = JSON.parse(fs.readFileSync(world.files.directories, 'utf8')).data;
    const sessionsAfterCrash = JSON.parse(fs.readFileSync(world.files.sessions, 'utf8')).data;
    if (step === 'journal') {
      assert.deepEqual(dirsAfterCrash.map(record => record.id), ['d1', 'd2']);
      assert.deepEqual(sessionsAfterCrash.map(record => record.id), ['s1', 's2']);
    }
    if (step === 'directories') {
      assert.deepEqual(dirsAfterCrash.map(record => record.id), ['d2']);
      assert.deepEqual(sessionsAfterCrash.map(record => record.id), ['s1', 's2']);
    }
    if (step === 'sessions') {
      assert.deepEqual(dirsAfterCrash.map(record => record.id), ['d2']);
      assert.deepEqual(sessionsAfterCrash.map(record => record.id), ['s2']);
    }

    const restarted = makeOwner(root);
    const stats = restarted.owner.replayJournals();
    assert.equal(stats.replayed, 1);
    assert.equal(stats.skipped, 0);
    assert.equal(stats.crashed, false);
    const dirs = JSON.parse(fs.readFileSync(world.files.directories, 'utf8')).data;
    const sessions = JSON.parse(fs.readFileSync(world.files.sessions, 'utf8')).data;
    assert.deepEqual(dirs.map(record => record.id), ['d2'], `${step}: replay finishes directories`);
    assert.deepEqual(sessions.map(record => record.id), ['s2'], `${step}: replay finishes sessions`);
    assert.deepEqual(journalFiles(world.files), []);
    assert.equal(restarted.owner.replayJournals().replayed, 0, 'replay is idempotent');
  }
});

test('replay applies files in journal order and resumes after a crash', t => {
  const root = tempRoot(t);
  process.env.NODE_ENV = 'test';
  const world = makeOwner(root);
  seed(world,
    [{ id: 'd1', name: 'One' }, { id: 'd2', name: 'Two' }],
    [{ id: 's1', dirId: 'd1' }, { id: 's2', dirId: 'd2' }]);
  world.dirs.delete('d1');
  world.owner.native.delete('s1');

  const marker = path.join(root, 'crash.marker');
  fs.writeFileSync(marker, '1');
  process.env.MULTICC_TEST_STATE_TX_CRASH_FILE = marker;
  process.env.MULTICC_TEST_STATE_TX_CRASH_AT = 'journal';
  assert.throws(() => world.owner.commitCrossFileWrite({ kind: 'delete-directory' }), /STATE_TX_CRASH/);
  delete process.env.MULTICC_TEST_STATE_TX_CRASH_AT;
  assert.equal(journalFiles(world.files).length, 1);

  const restarted = makeOwner(root);
  process.env.MULTICC_TEST_STATE_REPLAY_CRASH_FILE = marker;
  process.env.MULTICC_TEST_STATE_REPLAY_CRASH_AFTER = '1';
  const first = restarted.owner.replayJournals();
  assert.equal(first.crashed, true);
  assert.equal(first.replayed, 0);
  // The first journal file is directories.json: it landed, sessions.json did not.
  assert.deepEqual(JSON.parse(fs.readFileSync(world.files.directories, 'utf8')).data.map(record => record.id), ['d2']);
  assert.deepEqual(JSON.parse(fs.readFileSync(world.files.sessions, 'utf8')).data.map(record => record.id), ['s1', 's2']);
  assert.equal(journalFiles(world.files).length, 1, 'crashed replay keeps the journal');

  delete process.env.MULTICC_TEST_STATE_REPLAY_CRASH_FILE;
  delete process.env.MULTICC_TEST_STATE_REPLAY_CRASH_AFTER;
  const second = restarted.owner.replayJournals();
  assert.equal(second.replayed, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(world.files.sessions, 'utf8')).data.map(record => record.id), ['s2']);
  assert.deepEqual(journalFiles(world.files), []);
});

test('damaged or unreadable journals move aside without blocking boot', t => {
  const root = tempRoot(t);
  const world = makeOwner(root);
  fs.mkdirSync(world.files.journal, { recursive: true });
  fs.writeFileSync(path.join(world.files.journal, 'tx-badjson.json'), '{not json');

  // Malformed data (an array instead of a journal object) inside a valid envelope.
  const malformed = path.join(world.files.journal, 'tx-malformed.json');
  const envelope = JSON.stringify({
    __multiccSchema: { kind: 'state-tx-journal', version: 1, writtenAt: new Date().toISOString() },
    data: [],
  });
  fs.writeFileSync(malformed, envelope);

  // A valid entry whose target cannot be written (parent is a regular file).
  const blocker = path.join(root, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  const entry = {
    id: 'deadbeefdeadbeef',
    kind: 'delete-directory',
    ts: 1,
    files: [{ path: path.join(blocker, 'child.json'), payload: [], kind: 'directories', schemaVersion: 1 }],
  };
  legacyTx._writeJournal(world.files.journal, entry);

  const stats = world.owner.replayJournals();
  assert.equal(stats.replayed, 0);
  assert.equal(stats.skipped, 3);
  assert.ok(stats.messages.some(message => /skipping unreadable journal tx-badjson\.json/.test(message)));
  assert.ok(stats.messages.some(message => /apply failed for tx-malformed\.json/.test(message)));
  assert.ok(stats.messages.some(message => /apply failed for tx-deadbeefdeadbeef\.json/.test(message)));
  assert.deepEqual(journalFiles(world.files), []);
  const broken = fs.readdirSync(path.join(world.files.journal, 'broken')).sort();
  assert.equal(broken.length, 3);
  assert.ok(broken.every(name => /^tx-.+\.json\.\d+$/.test(name)));
});

test('restart reload preserves counts, insertion order and content hashes', t => {
  const root = tempRoot(t);
  const world = makeOwner(root);
  const directories = [];
  for (let index = 0; index < 12; index += 1) {
    directories.push({ id: `d${(index * 7) % 12}`, name: `目录-${index}`, path: `/tmp/space/${index}`, createdAt: index });
  }
  const sessions = [];
  for (let index = 0; index < 7; index += 1) {
    sessions.push({ id: `s${index}`, dirId: index % 2 ? 'd1' : 'd0', cli: 'claude', kind: 'chat' });
  }
  seed(world, directories, sessions);
  const before = [...world.dirs.entries()].map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]);
  const digest = recordDigest(before);

  const restarted = makeOwner(root);
  const loaded = restarted.owner.loadDirectories();
  assert.equal(loaded.size, directories.length);
  const after = [...restarted.dirs.entries()].map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]);
  assert.deepEqual(after, before, 'order and content survive a restart');
  assert.equal(recordDigest(after), digest);

  const sessionsLoaded = createStore({
    file: world.files.sessions, kind: 'sessions', schemaVersion: 1, legacyIsArray: true,
  }).loadOrRecover();
  assert.deepEqual(sessionsLoaded.data.map(record => record.id), sessions.map(record => record.id));
  assert.deepEqual(sessionsLoaded.data, sessions);
});

test('reentrancy: host ports may read the table while the owner writes it', t => {
  const root = tempRoot(t);
  const world = makeOwner(root, {
    stringify(value) {
      // Re-enter the same native owner from inside the stringify callback.
      assert.equal(world.dirs.size, value.length);
      assert.equal(world.dirs.get('d1').name, 'One');
      return JSON.stringify(value);
    },
  });
  world.dirs.set('d1', { id: 'd1', name: 'One' });
  world.dirs.set('d2', { id: 'd2', name: 'Two' });
  world.owner.saveDirectories();
  const text = fs.readFileSync(world.files.directories, 'utf8');
  assert.deepEqual(JSON.parse(text).data.map(record => record.id), ['d1', 'd2']);

  // Two facades over the same owner observe one table.
  const second = createDirectoryTable(world.owner);
  assert.equal(second.size, 2);
  second.set('d3', { id: 'd3', name: 'Three' });
  assert.equal(world.dirs.size, 3);

  // Deleting during forEach is safe (iteration snapshots the entries).
  const seen = [];
  world.dirs.forEach((value, key) => { seen.push(key); world.dirs.delete(key); });
  assert.deepEqual(seen, ['d1', 'd2', 'd3']);
  assert.equal(world.dirs.size, 0);
});

test('identity: live records are the table values and deleted ones are collectable', async t => {
  const world = makeOwner(tempRoot(t));
  const record = { id: 'd1', name: 'One' };
  world.dirs.set('d1', record);
  assert.equal(world.dirs.get('d1'), record);
  const [[key, value]] = [...world.dirs.entries()];
  assert.equal(key, 'd1');
  assert.equal(value, record);

  let facade = createDirectoryTable(world.owner);
  const facadeRef = new WeakRef(facade);
  assert.equal(facade.size, 1);
  facade = null;

  if (typeof global.gc !== 'function') return; // run with --expose-gc to check
  for (let attempt = 0; attempt < 10 && facadeRef.deref() !== undefined; attempt += 1) {
    global.gc();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(facadeRef.deref(), undefined, 'an abandoned facade does not pin the table');
  let gone = { id: 'gone', big: 'x'.repeat(1024) };
  const ref = new WeakRef(gone);
  world.dirs.set('gone', gone);
  world.dirs.delete('gone');
  gone = null;
  for (let attempt = 0; attempt < 10 && ref.deref() !== undefined; attempt += 1) {
    global.gc();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(ref.deref(), undefined, 'no strong reference survives delete()');
});

test('a failed write leaves the previous primary intact', t => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  const root = tempRoot(t);
  const world = makeOwner(root);
  world.dirs.set('d1', { id: 'd1', name: 'first' });
  world.owner.saveDirectories();
  const before = fs.readFileSync(world.files.directories, 'utf8');

  world.dirs.set('d2', { id: 'd2', name: 'second' });
  fs.chmodSync(root, 0o500);
  try {
    assert.throws(() => world.owner.saveDirectories(), /STATE_WRITE_FAILED/);
  } finally {
    fs.chmodSync(root, 0o700);
  }
  assert.equal(fs.readFileSync(world.files.directories, 'utf8'), before,
    'atomic write failure must not truncate the committed file');
  assert.deepEqual(JSON.parse(fs.readFileSync(world.files.directories, 'utf8')).data.map(record => record.id), ['d1']);
});
