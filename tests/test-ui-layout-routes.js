'use strict';

// The user's drag-and-drop arrangement is durable and shared across devices.
//
// The three public routes (`GET /api/ui-layout`, `PUT /api/ui-layout/dir-order`,
// `PUT /api/ui-layout/session-order/:dirId`) and every normalization/pruning
// rule now belong to the Rust front door
// (native/gateway/src/app/directory_routes.rs, rules in
// native/core/src/directory_routes.rs — their live suite is
// native/gateway/tests/directory_routes.rs and the byte comparison is
// docs/rust-migration/differential/directory-routes.js).
//
// What stayed in Node is the durable half these tests pin:
//   src/directory/ui-layout.js        the ui-layout.json store (load/save/known)
//   src/routes/directory-host.js      the op envelope the front door calls:
//                                    layout-load / layout-save / layout-known

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createUiLayoutStore } = require('../src/directory/ui-layout');
const { createDirectoryHost } = require('../src/routes/directory-host');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-ui-layout-'));
  return { dir, file: path.join(dir, 'ui-layout.json') };
}

function makeKnown() {
  const directories = new Map([['d1', {}], ['d2', {}]]);
  const persistedSessions = new Map([
    ['s1', { id: 's1', dirId: 'd1' }],
    ['s2', { id: 's2', dirId: 'd1' }],
    ['s3', { id: 's3', dirId: 'd2' }],
  ]);
  return {
    directories,
    persistedSessions,
    listDirIds: () => directories.keys(),
    listSessionIds: dirId => [...persistedSessions.values()]
      .filter(s => s.dirId === dirId).map(s => s.id),
  };
}

function store(file, known, warnings = []) {
  return createUiLayoutStore({
    file,
    listDirIds: known.listDirIds,
    listSessionIds: known.listSessionIds,
    logger: { warn: m => warnings.push(m) },
  });
}

/** The host port, with every non-layout dependency stubbed out. */
function hostFor(uiLayout) {
  return createDirectoryHost({
    repo: {},
    git: {},
    sessions: {},
    events: {},
    fsPort: {},
    helpers: {},
    tx: {},
    uiLayout,
    logger: { warn() {}, error() {} },
  });
}

test('an install with no layout file reports an absent document', async () => {
  const { file } = tempFile();
  const known = makeKnown();
  const loaded = store(file, known).load();
  assert.equal(loaded.present, false);
  assert.equal(loaded.data, null);
  const answer = await hostFor(store(file, known)).invoke({ op: 'layout-load' });
  assert.deepEqual(answer, { present: false, corrupt: false, data: null });
});

test('a directory order survives a fresh store — this is the whole point', async () => {
  const { file } = tempFile();
  const known = makeKnown();
  const host = hostFor(store(file, known));
  await host.invoke({ op: 'layout-save', doc: {
    dirOrder: ['d2', 'd1'], sessionOrder: { d1: ['s2', 's1'] },
    updatedAt: '2026-08-08T00:00:00.000Z',
  } });

  // A second browser, or the same one after a restart: new store, same file.
  const reopened = store(file, known);
  assert.deepEqual(reopened.load().data.dirOrder, ['d2', 'd1']);
  // It is stored through the shared state-store envelope, not as a bare object.
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(envelope.__multiccSchema.kind, 'ui-layout');
  assert.equal(envelope.__multiccSchema.version, 1);
  assert.deepEqual(envelope.data.dirOrder, ['d2', 'd1']);
});

test('the known-id snapshot is what the front door prunes against', async () => {
  const { file } = tempFile();
  const known = makeKnown();
  const answer = await hostFor(store(file, known)).invoke({ op: 'layout-known' });
  assert.deepEqual(answer, {
    dirIds: ['d1', 'd2'],
    sessionIds: { d1: ['s1', 's2'], d2: ['s3'] },
  });
  // A deleted fleet disappears from the snapshot: the Rust normalizer then
  // drops its stored slot instead of accumulating it forever.
  known.directories.delete('d2');
  const after = await hostFor(store(file, known)).invoke({ op: 'layout-known' });
  assert.deepEqual(after.dirIds, ['d1']);
  assert.equal('d2' in after.sessionIds, false);
});

test('a corrupt layout file costs the arrangement and nothing else', async () => {
  const { file } = tempFile();
  const known = makeKnown();
  fs.writeFileSync(file, '{ not json');
  const warnings = [];
  const loaded = store(file, known, warnings).load();
  // Unlike sessions.json, this store does NOT fail closed: refusing to boot
  // over a lost card arrangement would be the wrong blast radius.
  assert.equal(loaded.present, false);
  assert.equal(loaded.corrupt, true);
  assert.equal(loaded.data, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ui-layout/);
});

test('a failed save is a warn, never a failed request', async () => {
  const { file } = tempFile();
  const known = makeKnown();
  const warnings = [];
  const layout = store(file, known, warnings);
  // Put a regular file where a parent directory would have to be, so no temp
  // file can land; the arrangement is a hint, so the save must not throw and
  // the in-memory document must still be readable.
  const blocker = path.join(path.dirname(file), 'blocker');
  fs.writeFileSync(blocker, 'x');
  const unwritable = path.join(blocker, 'ui-layout.json');
  const broken = createUiLayoutStore({
    file: unwritable,
    listDirIds: known.listDirIds,
    listSessionIds: known.listSessionIds,
    logger: { warn: m => warnings.push(m) },
  });
  assert.doesNotThrow(() => broken.save({ dirOrder: ['d1'], sessionOrder: {}, updatedAt: null }));
  assert.equal(warnings.length, 1);
  // The in-memory document still reflects the write.
  assert.deepEqual(broken.load().data.dirOrder, ['d1']);
  // And a healthy store keeps working with the same payload.
  layout.save({ dirOrder: ['d2', 'd1'], sessionOrder: {}, updatedAt: null });
  assert.deepEqual(layout.load().data.dirOrder, ['d2', 'd1']);
});

test('the store requires its ports instead of inventing empty ones', () => {
  assert.throws(() => createUiLayoutStore({}), /file path is required/);
  assert.throws(() => createUiLayoutStore({ file: '/tmp/x.json' }), /listDirIds/);
  assert.throws(
    () => createUiLayoutStore({ file: '/tmp/x.json', listDirIds: () => [] }),
    /listSessionIds/,
  );
});
