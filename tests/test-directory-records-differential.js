'use strict';

// Differential oracle: the native directory registry (colocated with the
// session-record owner and its cross-file journal) must reproduce the Node
// repository and src/state/tx.js step for step. The legacy implementations are
// frozen under tests/helpers/legacy-*.js.
//
// Randomized but seeded: create/update/delete/clear/reorder directories, session
// membership, cascading delete + journalled cross-file commit, directory saves,
// and restart reloads. Every persisted artifact (directories.json, sessions.json
// and their rolling backups) is compared after each write.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore } = require('../src/state/store');
const { createSessionRecords } = require('../src/session/records');
const { createStateOwner } = require('../src/state/owner');
const { createDirectoryTable } = require('../src/directory/records');
const { createFsDirectoryRepository: createLegacyDirectoryRepository } = require('./helpers/legacy-directory-repository');
const legacyTx = require('./helpers/legacy-state-tx');

// Deterministic PRNG (mulberry32) so a failure reproduces from the seed alone.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-dir-diff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function normalizeTimestamps(text) {
  return text.replace(/"writtenAt": "[^"]*"/g, '"writtenAt": "<ts>"');
}

function normalizeJournal(text) {
  return normalizeTimestamps(text)
    .replace(/"id": "[0-9a-f]{16}"/g, '"id": "<tx>"')
    .replace(/"ts": \d+/g, '"ts": <ts>');
}

function snapshot(table) {
  return [...table.entries()].map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeNativeWorld(root) {
  const files = {
    directories: path.join(root, 'directories.json'),
    sessions: path.join(root, 'sessions.json'),
    journal: path.join(root, 'journal'),
  };
  const owner = createStateOwner().configure({
    stringify: JSON.stringify,
    root,
    directoriesFile: files.directories,
    sessionsFile: files.sessions,
    journalDir: files.journal,
    now: Date.now,
  });
  const dirs = createDirectoryTable(owner);
  const sessions = createSessionRecords(new Map(), owner);
  return {
    kind: 'native', root, files, owner, dirs, sessions,
    dirty: false,
    sessionsDirty: false,
    save() { owner.saveDirectories(); this.dirty = false; },
    commit() {
      owner.commitCrossFileWrite({ kind: 'delete-directory', reason: 'differential' });
      this.dirty = false;
      this.sessionsDirty = false;
    },
    dispose() {},
  };
}

function makeLegacyWorld(root) {
  const files = {
    directories: path.join(root, 'directories.json'),
    sessions: path.join(root, 'sessions.json'),
    journal: path.join(root, 'journal'),
  };
  const store = createStore({
    file: files.directories, kind: 'directories', schemaVersion: 1, legacyIsArray: true,
  });
  const dirs = new Map();
  const sessions = new Map();
  const repo = createLegacyDirectoryRepository({
    file: files.directories, map: dirs, realPathOf: value => value, store,
  });
  return {
    kind: 'legacy', root, files, store, repo, dirs, sessions,
    dirty: false,
    sessionsDirty: false,
    save() { repo.save(); this.dirty = false; },
    commit() {
      legacyTx.commitCrossFileWrite({
        journalDir: files.journal,
        kind: 'delete-directory',
        reason: 'differential',
        files: [
          { path: files.directories, payload: [...dirs.values()], kind: 'directories' },
          { path: files.sessions, payload: [...sessions.values()], kind: 'sessions' },
        ],
      });
      this.dirty = false;
      this.sessionsDirty = false;
    },
    dispose() {},
  };
}

function diskSnapshot(world) {
  const out = {};
  for (const role of ['directories', 'sessions']) {
    const file = world.files[role];
    if (fs.existsSync(file)) out[role] = normalizeTimestamps(fs.readFileSync(file, 'utf8'));
    for (let index = 1; index <= 3; index += 1) {
      const backup = `${file}.bak${index}`;
      if (fs.existsSync(backup)) {
        out[`${role}.bak${index}`] = normalizeTimestamps(fs.readFileSync(backup, 'utf8'));
      }
    }
  }
  const left = fs.existsSync(world.files.journal)
    ? fs.readdirSync(world.files.journal).filter(name => /^tx-.+\.json$/.test(name))
    : [];
  out.journals = left.sort();
  return out;
}

function reloadNative(world) {
  const next = makeNativeWorld(world.root);
  const loaded = next.owner.loadDirectories();
  const sessionStore = createStore({
    file: world.files.sessions, kind: 'sessions', schemaVersion: 1, legacyIsArray: true,
  });
  const sessionResult = sessionStore.loadOrRecover();
  const records = sessionResult.present ? sessionResult.data : [];
  next.sessions = createSessionRecords(new Map(records.map(record => [record.id, record])), next.owner);
  return { world: next, loaded };
}

function reloadLegacy(world) {
  const loaded = createStore({
    file: world.files.directories, kind: 'directories', schemaVersion: 1, legacyIsArray: true,
  }).loadOrRecover();
  const records = loaded.present ? loaded.data : [];
  const next = makeLegacyWorld(world.root);
  next.dirs.clear();
  for (const record of records) next.dirs.set(record.id, record);
  const sessionResult = createStore({
    file: world.files.sessions, kind: 'sessions', schemaVersion: 1, legacyIsArray: true,
  }).loadOrRecover();
  const sessionRecords = sessionResult.present ? sessionResult.data : [];
  for (const record of sessionRecords) next.sessions.set(record.id, record);
  return { world: next, loaded };
}

test('randomized differential: native directory owner matches the frozen Node repository and journal', t => {
  const roots = [tempRoot(t), tempRoot(t)];
  let native = makeNativeWorld(roots[0]);
  let legacy = makeLegacyWorld(roots[1]);
  t.after(() => { native.dispose(); legacy.dispose(); });

  const random = prng(0x5eed1234);
  const pick = list => list[Math.floor(random() * list.length)];
  let sequence = 0;
  let sessionSequence = 0;
  let steps = 0;

  const worlds = () => [native, legacy];

  function ids(world) { return [...world.dirs.keys()]; }
  function sessionIds(world) { return [...world.sessions.keys()]; }

  function compare(step) {
    const left = snapshot(native.dirs);
    const right = snapshot(legacy.dirs);
    assert.deepEqual(left, right, `directories diverged at step ${step}`);
    assert.deepEqual(snapshot(native.sessions), snapshot(legacy.sessions),
      `sessions diverged at step ${step}`);
    assert.deepEqual(diskSnapshot(native), diskSnapshot(legacy),
      `disk diverged at step ${step}`);
  }

  for (let index = 0; index < 1200; index += 1) {
    const roll = random();
    const current = ids(native);

    if (roll < 0.24 || current.length === 0) {
      // create a directory (same content, distinct objects per world)
      const id = `d${++sequence}`;
      const record = {
        id,
        name: `dir-${sequence}`,
        path: `/tmp/space/${sequence}`,
        createdAt: 1700000000000 + sequence,
      };
      for (const target of worlds()) target.dirs.set(id, clone(record));
      native.dirty = true;
      legacy.dirty = true;
    } else if (roll < 0.46) {
      // update fields in place in both worlds
      const id = pick(current);
      const name = `renamed-${++sequence}`;
      const field = random() < 0.5 ? { name } : { path: `/tmp/moved/${sequence}`, note: `n${sequence}` };
      for (const target of worlds()) Object.assign(target.dirs.get(id), clone(field));
      native.dirty = true;
      legacy.dirty = true;
    } else if (roll < 0.62) {
      // delete one directory; its sessions cascade
      const id = pick(current);
      for (const target of worlds()) {
        target.dirs.delete(id);
        for (const sessionId of [...target.sessions.keys()]) {
          if (target.sessions.get(sessionId).dirId === id) target.sessions.delete(sessionId);
        }
      }
      native.dirty = true;
      legacy.dirty = true;
      native.sessionsDirty = true;
      legacy.sessionsDirty = true;
    } else if (roll < 0.72) {
      // reorder by clearing and re-inserting a permutation (Map order is the
      // only reorder primitive; both worlds must keep the same iteration order)
      const order = ids(native);
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (const target of worlds()) {
        const records = target.dirs;
        const copy = order.map(id => [id, records.get(id)]);
        records.clear();
        for (const [id, record] of copy) records.set(id, record);
      }
      native.dirty = true;
      legacy.dirty = true;
    } else if (roll < 0.80) {
      // add a session, sometimes assigned to an existing directory
      const id = `s${++sessionSequence}`;
      const dirId = current.length && random() < 0.8 ? pick(current) : 'missing';
      for (const target of worlds()) {
        target.sessions.set(id, { id, dirId, cli: 'claude', kind: 'chat', cliSessionId: null });
      }
      native.sessionsDirty = true;
      legacy.sessionsDirty = true;
    } else if (roll < 0.86) {
      // cascading delete through the journalled cross-file transaction
      if (current.length === 0) continue;
      const id = pick(current);
      for (const target of worlds()) {
        target.dirs.delete(id);
        for (const sessionId of [...target.sessions.keys()]) {
          if (target.sessions.get(sessionId).dirId === id) target.sessions.delete(sessionId);
        }
        target.commit();
      }
    } else if (roll < 0.94) {
      // plain directories.json save (rolling backups must track in lockstep)
      for (const target of worlds()) target.save();
    } else {
      // restart reload; only compare persisted state when nothing is dirty
      const left = reloadNative(native);
      const right = reloadLegacy(legacy);
      const dirsDirty = native.dirty || legacy.dirty;
      const sessionsDirty = native.sessionsDirty || legacy.sessionsDirty;
      assert.equal(left.loaded.present, right.loaded.present, `presence diverged at step ${index}`);
      if (!dirsDirty) {
        assert.deepEqual(snapshot(left.world.dirs), snapshot(native.dirs),
          `native reload lost directory order/content at step ${index}`);
        assert.deepEqual(snapshot(right.world.dirs), snapshot(left.world.dirs),
          `reload diverged at step ${index}`);
      }
      if (!sessionsDirty) {
        assert.deepEqual(snapshot(left.world.sessions), snapshot(right.world.sessions),
          `session reload diverged at step ${index}`);
      }
      native.dispose();
      legacy.dispose();
      native = left.world;
      legacy = right.world;
    }

    steps += 1;
    compare(index);
  }

  assert.ok(steps >= 1000, `expected at least 1000 differential steps, ran ${steps}`);
});
