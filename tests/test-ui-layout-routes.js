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
// These tests also exercise the native layout store behind the host:
//   native/addon/src/directory_layout.rs   ui-layout.json load/save/known
//   src/routes/directory-host.js      the op envelope the front door calls:
//                                    layout-load / layout-save / layout-known

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDirectoryHost, createDirectoryModule, createUiLayoutStore } = require('../src/routes/directory-host');

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

const frozen = require('./helpers/frozen-file-batch11');
const frozenLayout = require('./helpers/frozen-file-batch11/ui-layout');
const frozenSample = require('./helpers/frozen-file-batch11/sample-workspace');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-directory-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('目录装配与冻结入口对照默认和指定布局路径，保留活表与会话读取顺序', async t => {
  async function run(create, customPath, withSessions) {
    const root = temporaryRoot(t);
    const file = path.join(root, 'directories.json');
    const uiLayoutFile = customPath ? path.join(root, 'other', 'layout.json') : undefined;
    const map = new Map([['d1', { id: 'd1' }]]);
    const reads = [];
    const sessions = withSessions ? { listByDir(id) {
      assert.equal(this, sessions);
      reads.push(id);
      return [{ id: id + '-session' }];
    } } : undefined;
    const { repo, host } = create({
      repository: { file, uiLayoutFile, map, owner: { saveDirectories() {} } },
      sessions, helpers: { realPathOf: s => s }, logger: { warn: assert.fail },
    });
    assert.equal(repo.map(), map);
    const before = await host.invoke({ op: 'layout-known' });
    repo.add({ id: 'd2' });
    const after = await host.invoke({ op: 'layout-known' });
    const doc = { dirOrder: ['d2', 'd1'] };
    await host.invoke({ op: 'layout-save', doc });
    assert.equal((await host.invoke({ op: 'layout-load' })).data, doc);
    const saved = JSON.parse(fs.readFileSync(uiLayoutFile || path.join(root, 'ui-layout.json')));
    return { before, after, reads, savedData: saved.data, schema: saved.__multiccSchema.kind };
  }
  for (const custom of [false, true]) for (const sessions of [false, true]) {
    assert.deepEqual(await run(createDirectoryModule, custom, sessions),
      await run(frozen.createDirectoryModule, custom, sessions));
  }
});

test('布局缓存与冻结入口对照损坏文件、脱离对象的方法和保存失败后的引用', t => {
  function run(create) {
    const root = temporaryRoot(t);
    const file = path.join(root, 'layout.json');
    fs.writeFileSync(file, '{broken');
    const warnings = [];
    const deps = {
      file, listDirIds() { assert.equal(this, deps); return new Set(['d2', 'd1']); },
      *listSessionIds(id) { assert.equal(this, deps); yield id; yield id; },
      logger: { warn: message => warnings.push(message.replaceAll(root, '<root>')) },
    };
    const { load, save, known } = create(deps);
    const before = load();
    assert.equal(load(), before);
    // A circular document cannot be persisted but the hint remains available to this process.
    const circular = {}; circular.self = circular;
    assert.equal(save(circular), undefined);
    assert.equal(load().data, circular);
    assert.equal(load(), load());
    assert.equal(warnings.length, 2);
    return { before, known: known(), warnings };
  }
  assert.deepEqual(run(createUiLayoutStore), run(frozenLayout.createUiLayoutStore));
});

test('示例工作区与冻结入口逐字节对照，重试保留已有文件和写入顺序', async () => {
  async function run(ensure, failAt) {
    const files = new Map(), calls = [];
    let failure = failAt;
    const port = {
      sampleRoot() { assert.equal(this, port); return path.join('data', 'samples'); },
      mkdirp(dir) { assert.equal(this, port); calls.push(['mkdir', dir]); },
      writeFileExclusive(file, body) {
        assert.equal(this, port);
        calls.push(['write', file, body]);
        if (path.basename(file) === failure) { failure = null; throw new Error('sample write failed'); }
        if (files.has(file)) return false;
        files.set(file, body);
        return true;
      },
    };
    const invoke = async () => {
      try { return await ensure(port); } catch (err) { return { error: err.message }; }
    };
    const first = await invoke();
    const readme = path.join('data', 'samples', 'getting-started', 'README.md');
    files.set(readme, 'user edits');
    const retry = await invoke();
    assert.equal(files.get(readme), 'user edits');
    return { first, retry, calls, files: [...files] };
  }
  const current = fsPort => createDirectoryHost({ fsPort }).invoke({ op: 'sample-ensure' });
  for (const failAt of [null, 'index.html', 'TASKS.md']) {
    assert.deepEqual(await run(current, failAt), await run(frozenSample.ensureSampleWorkspace, failAt));
  }
});
