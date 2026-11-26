'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { createPaths } = require('../src/paths');
const { getNative } = require('../src/native/binding');
const { reportFailure } = require('../src/state/store');

// Compile the unchanged frozen source at its former path so relative imports
// resolve exactly as they did before retirement.
const source = fs.readFileSync(path.join(__dirname, 'helpers/legacy-chat-history-file-repository-adapter.js'), 'utf8');
const formerPath = path.resolve(__dirname, '../src/session/adapters/chat-history-file-repository.js');
const legacyModule = new Module(formerPath, module);
legacyModule.filename = formerPath;
legacyModule.paths = Module._nodeModulePaths(path.dirname(formerPath));
legacyModule._compile(source, formerPath);
const legacy = legacyModule.exports;

function describe(error) {
  if (!(error instanceof Error)) return error;
  return Object.fromEntries(['name', 'message', 'code', 'errno', 'syscall', 'path', 'dest']
    .filter(key => error[key] !== undefined).map(key => [key, error[key]]));
}

test('退休适配器与原生工厂保持接口、磁盘状态及同步和异步行为一致', async t => {
  const dirs = [0, 1].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-facade-diff-')));
  t.after(() => dirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
  const old = legacy.createChatHistoryFileRepository({ dataDir: dirs[0], appendEnabled: true });
  const modern = getNative().chatHistoryFileRepositoryCreate({ root: createPaths({ dataDir: dirs[1] }).chatHistoryDir, appendEnabled: true, reportFailure });
  assert.deepEqual(Object.keys(modern), Object.keys(old));
  assert.equal(Object.isFrozen(modern), true);
  for (const key of Object.keys(old).filter(key => typeof old[key] === 'function')) {
    assert.equal(modern[key].length, old[key].length, key);
  }
  const norm = (value, repo) => JSON.parse(JSON.stringify(value, (key, v) => typeof v === 'string' ? v.split(repo.root).join('<root>') : v) ?? 'null');
  async function compare(method, ...args) {
    const outcomes = [];
    for (const repo of [old, modern]) {
      try { outcomes.push({ value: norm(await repo[method](...args), repo) }); }
      catch (error) { outcomes.push({ error: norm(describe(error), repo) }); }
    }
    assert.deepEqual(outcomes[1], outcomes[0], `${method} ${JSON.stringify(args)}`);
    assert.deepEqual(snapshot(dirs[1]), snapshot(dirs[0]), `${method} disk state`);
  }
  await compare('fileFor', 'abc');
  await compare('read', 'abc');
  await compare('readStrict', 'abc');
  await compare('readStrict', 'abc', { allowEmpty: true });
  await compare('readStrict', 'abc', null);
  await compare('readOwned');
  await compare('writeAsync', 'abc', JSON.stringify([{ role: 'user', content: '你好' }]));
  await compare('readOwned', 'abc');
  await compare('readPhysicalRangeAsync', 'abc', 0, 10, 4096);
  await compare('appendAsync', 'abc', { tail: '{}', keepBytes: 0, expectedBytes: 999 });
  await compare('writeVisibilityAsync', 'abc', JSON.stringify({ hidden: true }));
  await compare('readVisibility', 'abc');
  await compare('hasPersistedDeliveryAsync', 'abc', '');
  await compare('hasPersistedDeliveryAsync', 'abc', 'missing');
  await compare('appendAsync', 'abc', null);
  await compare('appendAsync', 'abc');
  await compare('appendAsync', 'abc', { tail: '', keepBytes: 'bad', expectedBytes: 0 });
  await compare('hasPersistedDeliveryAsync');
  await compare('readPhysicalRangeAsync');
  await compare('readPhysicalRangeAsync', 'abc', 'bad', 10, 4096);
  await compare('listSessionIds');
  await compare('renameSession', 'abc', 'def');
  await compare('deleteSession', 'def');
  await compare('listSessionIds');
  const bad = { toString() { throw new TypeError('coercion failed'); } };
  for (const repo of [old, modern]) await assert.rejects(repo.writeAsync(bad, '[]'), { name: 'TypeError', message: 'coercion failed' });
  function snapshot(dir) {
    const root = createPaths({ dataDir: dir }).chatHistoryDir;
    if (!fs.existsSync(root)) return [];
    const rows = [];
    function walk(dir, prefix = '') {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = path.join(prefix, entry.name);
        if (entry.isDirectory()) { rows.push([relative, 'dir']); walk(path.join(dir, entry.name), relative); }
        else rows.push([relative, fs.readFileSync(path.join(dir, entry.name)).toString('hex')]);
      }
    }
    walk(root);
    return rows;
  }
  assert.deepEqual(snapshot(dirs[1]), snapshot(dirs[0]));
});
