'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCleanup } = require('../src/native/binding').artifacts;

const DAY_MS = 24 * 60 * 60 * 1000;

function artifactDir(root, id, mtimeMs) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), id);
  const at = new Date(mtimeMs);
  fs.utimesSync(dir, at, at);
  return dir;
}

test('artifact cleanup keeps exact live pins and still removes unreferenced entries after seven days', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-artifact-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.UTC(2026, 7, 18);
  const old = now - 8 * DAY_MS;
  const fresh = now - 6 * DAY_MS;
  artifactDir(root, 'pinned_exact-1', old);
  artifactDir(root, 'pinned_exact-1-copy', old);
  artifactDir(root, 'stale_unreferenced-1', old);
  artifactDir(root, 'fresh_unreferenced-1', fresh);

  const cleanup = createCleanup({ artifactsDir: root, now: () => now, log() {} });
  assert.equal(cleanup(7 * DAY_MS, [
    'pinned_exact-1', '../stale_unreferenced-1', 'bad/id',
  ]), 2);
  assert.equal(fs.existsSync(path.join(root, 'pinned_exact-1')), true);
  assert.equal(fs.existsSync(path.join(root, 'pinned_exact-1-copy')), false,
    'similar prefixes are not pins');
  assert.equal(fs.existsSync(path.join(root, 'stale_unreferenced-1')), false);
  assert.equal(fs.existsSync(path.join(root, 'fresh_unreferenced-1')), true);
});

test('artifact cleanup refuses a symlinked root instead of deleting through it', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-artifact-root-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const outside = path.join(parent, 'outside');
  const linkedRoot = path.join(parent, 'artifacts-link');
  fs.mkdirSync(outside);
  const victim = artifactDir(outside, 'must_survive-1', 1);
  fs.symlinkSync(outside, linkedRoot, 'dir');

  const cleanup = createCleanup({ artifactsDir: linkedRoot, now: () => 10 * DAY_MS, log() {} });
  assert.equal(cleanup(DAY_MS), 0);
  assert.equal(fs.existsSync(victim), true);
});

test('server resolves pins from the docs registry for every artifact cleanup tick', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Contract: every cleanup tick passes the keep-list in, and a read failure
  // only warns + skips (never crashes the server). Match the source and the
  // failure sentinel rather than the full statement shape so formatting/
  // line-budget merges don't break this test again. The docs registry
  // contributes its `permanent` rows — 置顶 alone no longer keeps a file alive,
  // which is exactly the split test-docs-registry.js pins down.
  assert.match(source,
    /artifacts\.cleanupAsync\(undefined, docsRegistry\.listPermanentArtifactIds\(\)\)/);
  assert.match(source, /artifact_cleanup_pin_read_failed/);
  assert.match(source, /cleanupArtifacts\(\);/);
  assert.match(source,
    /setInterval\(\s*(?:cleanupArtifacts|\(\)\s*=>\s*cleanupArtifacts\(\))\s*,\s*6\s*\*\s*3600\s*\*\s*1000\s*\)/,
    'schedule cleanupArtifacts every six hours');
  // The `/artifacts` serving chain retired to the Rust front door's dual-root
  // static mount (docs/gateway.md §62): the server must not register the old
  // mount again. The cleanup timer above is all that still uses this module.
  assert.doesNotMatch(source, /artifacts\.mount\(/);
});

test('permanent artifacts keep transitive, relative and declared intermediates without retaining unrelated tasks', t => {
  const { permanentArtifactIds } = require('../src/artifact-retention');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-related-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now(), old = now - 8 * DAY_MS;
  for (const id of ['final', 'style', 'image', 'source', 'independent', 'unrelated']) artifactDir(root, id, old);
  fs.writeFileSync(path.join(root, 'final', 'index.html'), '<link href="/artifacts/style/main.css"><a href="https://other.test/artifacts/unrelated/index.html">external</a>');
  fs.writeFileSync(path.join(root, 'style', 'main.css'), 'body { background:url(../image/图片.png) } /* /artifacts/final/index.html */');
  const rows = [
    { url: '/artifacts/final/index.html', permanent: true, relatedArtifactIds: ['source', '../unrelated'] },
    { url: '/artifacts/independent/index.html', permanent: true },
    { url: '/artifacts/unrelated/index.html', taskId: 'same-task', pinned: true },
  ];
  const kept = permanentArtifactIds(rows, [root]);
  assert.deepEqual([...kept].sort(), ['final', 'image', 'independent', 'source', 'style']);
  // Adding CSS updated its directory mtime; age it again before real cleanup.
  for (const id of fs.readdirSync(root)) fs.utimesSync(path.join(root, id), new Date(old), new Date(old));
  assert.equal(createCleanup({ artifactsDir: root, now: () => now, log() {} })(7 * DAY_MS, kept), 1);
  for (const id of kept) assert.ok(fs.existsSync(path.join(root, id)), id);
  rows[0].permanent = false;
  assert.deepEqual([...permanentArtifactIds(rows, [root])], ['independent'], 'removing a parent promise leaves independent promises intact');
});

test('dependency graph observes later edits, legacy roots and cycles, and never reads through symlinks', t => {
  const { permanentArtifactIds } = require('../src/artifact-retention');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-artifact-graph-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const primary = path.join(root, 'primary'), legacy = path.join(root, 'legacy');
  artifactDir(primary, 'final', 1); artifactDir(legacy, 'old', 1);
  const source = path.join(primary, 'final', 'index.html');
  const rows = [{ url: '/artifacts/final/index.html', permanent: true }];
  assert.deepEqual([...permanentArtifactIds(rows, [primary, legacy])], ['final']);
  fs.writeFileSync(source, '<iframe src="/artifacts/old/index.html"></iframe>');
  fs.writeFileSync(path.join(legacy, 'old', 'index.html'), '<a href="/artifacts/final/index.html">cycle</a>');
  const outside = path.join(root, 'private.html');
  fs.writeFileSync(outside, '/artifacts/private/index.html');
  fs.symlinkSync(outside, path.join(primary, 'final', 'secret.html'));
  assert.deepEqual([...permanentArtifactIds(rows, [primary, legacy])].sort(), ['final', 'old']);
});

test('a graph that cannot be completely scanned fails closed instead of returning a partial keep-list', t => {
  const { permanentArtifactIds } = require('../src/artifact-retention');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-artifact-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  artifactDir(root, 'final', 1);
  const fd = fs.openSync(path.join(root, 'final', 'large.js'), 'w');
  fs.ftruncateSync(fd, 65 * 1024 * 1024); fs.closeSync(fd);
  assert.throws(() => permanentArtifactIds([{ url: '/artifacts/final/index.html', permanent: true }], [root]), /byte limit/);
});

test('artifact publisher records explicit binary-source associations without turning on permanence', async t => {
  const http = require('node:http');
  const execFile = require('node:util').promisify(require('node:child_process').execFile);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-artifact-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', data => { body += data; });
    req.on('end', () => { requests.push(JSON.parse(body)); res.writeHead(201); res.end('{}'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const input = path.join(root, 'final.mp4'); fs.writeFileSync(input, 'fixture');
  const command = path.join(__dirname, '../skills/multicc-artifact/bin/artifact');
  await execFile(process.execPath, [command, 'file', '--from', input, '--related', 'source,audio', '--quiet'], {
    cwd: root, env: { ...process.env, MULTICC_ARTIFACTS_DIR: path.join(root, 'artifacts'), MULTICC_BASE_URL: `http://127.0.0.1:${server.address().port}` },
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].relatedArtifactIds, ['source', 'audio']);
  assert.equal(requests[0].permanent, undefined);
  assert.match(requests[0].url, /^\/artifacts\/[^/]+\/final.mp4$/);
});

test('dot-prefixed nested references retain source artifacts through cleanup', t => {
  const { permanentArtifactIds } = require('../src/artifact-retention');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-dot-relative-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now(), old = now - 8 * DAY_MS;
  for (const id of ['final', 'input', 'unrelated']) artifactDir(root, id, old);
  fs.mkdirSync(path.join(root, 'final', 'assets'));
  fs.writeFileSync(path.join(root, 'final', 'assets', 'main.css'), 'body{background:url(./../../input/image.png)}');
  const kept = permanentArtifactIds([{ url: '/artifacts/final/index.html', permanent: true }], [root]);
  assert.deepEqual([...kept].sort(), ['final', 'input']);
  for (const id of fs.readdirSync(root)) fs.utimesSync(path.join(root, id), new Date(old), new Date(old));
  assert.equal(createCleanup({ artifactsDir: root, now: () => now, log() {} })(7 * DAY_MS, kept), 1);
  assert.equal(fs.existsSync(path.join(root, 'input')), true);
  assert.equal(fs.existsSync(path.join(root, 'unrelated')), false);
});

test('the asynchronous artifact sweep uses the primary root, exact pins and the same age boundary', t => {
  const { execFileSync } = require('node:child_process');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-worker-artifacts-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const root = path.join(data, 'artifacts');
  fs.mkdirSync(root);
  artifactDir(root, 'keep', 1);
  artifactDir(root, 'drop', 1);
  const modulePath = require.resolve('../src/native/binding');
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { artifacts } = require(${JSON.stringify(modulePath)});
    const result = artifacts.cleanupAsync(undefined, new Set(['keep']));
    assert.ok(result instanceof Promise);
    result.then(count => assert.equal(count, 1));
  `], { env: { ...process.env, MULTICC_DATA_DIR: data } });
  assert.deepEqual(fs.readdirSync(root), ['keep']);
});

test('the injected sweep preserves partial pins, root rechecks and log behavior', () => {
  const before = require('./helpers/frozen-state-leaves/artifacts').createCleanup;
  function trace(factory, replaceRoot) {
    const root = path.resolve('artifact-test-root');
    const calls = [];
    let rootReads = 0;
    const stats = directory => ({
      mtimeMs: 0, isSymbolicLink: () => !directory, isDirectory: () => directory,
    });
    const fsImpl = {
      lstatSync(file) {
        const key = path.relative(root, file) || '.';
        calls.push(['stat', key]);
        return stats(key !== '.' || ++rootReads !== replaceRoot);
      },
      readdirSync() { return ['keep', 'old', 'second']; },
      rmSync(file, options) { calls.push(['remove', path.basename(file), options]); },
    };
    function* pins() { yield 'keep'; throw Error('iterator failed after yielding a pin'); }
    const cleanup = factory({ artifactsDir: root, fsImpl, now: () => 100, log: line => calls.push(['log', line]) });
    return { count: cleanup(50, pins()), calls };
  }
  for (const rootRead of [0, 1, 2, 3]) {
    assert.deepEqual(trace(createCleanup, rootRead), trace(before, rootRead));
  }
});
