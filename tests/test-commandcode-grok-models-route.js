'use strict';

// /api/commandcode/models and /api/grok/models — live catalogs for the two
// CLIs whose picker used to be a hardcoded table (grok-code-fast-1 / grok-4 had
// already disappeared from `grok models`). Pins: Command Code's vendor grouping
// is carried through (parsed from a real `--list-models` capture), the non-model
// text around it is ignored, the headless-only section is dropped, an
// unauthenticated Grok list is served but never cached, and fallbacks are never
// cached.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cc = require('../src/routes/model-catalogs-host').getVendorCatalog('commandcode');
const grok = require('../src/routes/model-catalogs-host').getVendorCatalog('grok');

const CC_REAL = fs.readFileSync(path.join(__dirname, 'fixtures', 'commandcode-list-models.txt'), 'utf8');
const GROK_AUTHED = 'Default model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n  - grok-5-preview\n';
const GROK_ANON = `You are not authenticated.\n\n${GROK_AUTHED}`;

const ENV = { CC: process.env.COMMAND_CODE_CMD, GROK: process.env.GROK_CMD };

function fakeCli(name, stdout) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-models-`)), name);
  fs.writeFileSync(file, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

const listCc = (opts) => new Promise((resolve, reject) => cc.listCommandcodeModels((e, models, source) => (e ? reject(e) : resolve({ models, source })), opts));
const listGrok = (opts) => new Promise((resolve, reject) => grok.listGrokModels((e, models, source) => (e ? reject(e) : resolve({ models, source })), opts));

test.afterEach(() => {
  cc._resetCacheForTest();
  grok._resetCacheForTest();
  for (const [key, val] of [['COMMAND_CODE_CMD', ENV.CC], ['GROK_CMD', ENV.GROK]]) {
    if (val === undefined) delete process.env[key]; else process.env[key] = val;
  }
});

test('commandcode: parses the real capture into the vendor groups', () => {
  const models = cc.parseCommandcodeList(CC_REAL);
  assert.equal(models.length, 94);
  const groups = [...new Set(models.map(m => m.group))];
  assert.deepEqual(groups, ['Open Source', 'Stealth', 'Anthropic', 'OpenAI', 'Google', 'Sakana', 'Meta', 'xAI', 'DeepSeek Flash (byok)']);
  const flash = models.find(m => m.model === 'deepseek/deepseek-flash');
  assert.equal(flash.group, 'DeepSeek Flash (byok)');
  assert.ok(models.some(m => m.model === 'deepseek/deepseek-v4.1-flash' && m.group === 'Open Source'));
});

test('commandcode: banner, footer, docs link and headless-only section are not models', () => {
  const models = cc.parseCommandcodeList(CC_REAL).map(m => m.model);
  assert.ok(!models.includes('typesafe/jev'), 'headless-only decision models must be dropped');
  assert.ok(!models.some(id => /^(Docs|Available|Pass|cmd)\b/.test(id) || id.endsWith(':')));
  assert.equal(new Set(models).size, models.length);
});

test('commandcode: colour codes, an update banner and garbage rows are tolerated', () => {
  const text = 'Updated 1.82.5 → 1.84.0\n\x1b[1mAvailable models  ·  2 models\x1b[0m\n\nOpen Source\n\n\x1b[32mfoo/bar-1\x1b[0m   first\nnot a row\nfoo/bar-2   second\n';
  assert.deepEqual(cc.parseCommandcodeList(text).map(m => [m.model, m.group]), [['foo/bar-1', 'Open Source'], ['foo/bar-2', 'Open Source']]);
  assert.deepEqual(cc.parseCommandcodeList('Usage: cmd [options]\n'), []);
  assert.deepEqual(cc.parseCommandcodeList(''), []);
});

test('commandcode: CLI result is cached; unreadable CLI falls back without caching', async () => {
  process.env.COMMAND_CODE_CMD = '/nonexistent/commandcode';
  const down = await listCc();
  assert.equal(down.source, 'fallback');
  assert.ok(down.models.length > 0 && down.models.every(m => m.group));

  process.env.COMMAND_CODE_CMD = fakeCli('commandcode', CC_REAL);
  const up = await listCc();
  assert.equal(up.source, 'cli');
  assert.equal(up.models.length, 94);

  process.env.COMMAND_CODE_CMD = '/nonexistent/commandcode';
  assert.equal((await listCc()).source, 'cache');
});

test('grok: parses ids and the default marker', () => {
  const { models, authenticated } = grok.parseGrokModels(GROK_AUTHED);
  assert.equal(authenticated, true);
  assert.deepEqual(models.map(m => m.model), ['grok-4.6', 'grok-4.5', 'grok-5-preview']);
  assert.deepEqual(models.map(m => m.isDefault), [true, false, false]);
  assert.deepEqual(grok.parseGrokModels('Default model: x\n').models, []);
  assert.deepEqual(grok.parseGrokModels('').models, []);
});

test('grok: an unauthenticated list is served but never cached', async () => {
  process.env.GROK_CMD = fakeCli('grok', GROK_ANON);
  const anon = await listGrok();
  assert.equal(anon.source, 'cli-unauthenticated');
  assert.deepEqual(anon.models.map(m => m.model), ['grok-4.6', 'grok-4.5', 'grok-5-preview']);

  // After login the very next call must see the account's catalog.
  process.env.GROK_CMD = fakeCli('grok', GROK_AUTHED + '  - grok-5\n');
  const authed = await listGrok();
  assert.equal(authed.source, 'cli');
  assert.ok(authed.models.some(m => m.model === 'grok-5'));
  process.env.GROK_CMD = '/nonexistent/grok';
  assert.equal((await listGrok()).source, 'cache');
});

test('grok: unreadable CLI falls back to the snapshot', async () => {
  process.env.GROK_CMD = '/nonexistent/grok';
  const out = await listGrok();
  assert.equal(out.source, 'fallback');
  assert.deepEqual(out.models.map(m => m.model), [...grok.GROK_MODEL_FALLBACK]);
});

test('commandcode: refresh skips the one-hour cache', async () => {
  process.env.COMMAND_CODE_CMD = fakeCli('commandcode', CC_REAL);
  const cached = await listCc();
  assert.equal(cached.source, 'cli');
  const updated = 'Open Source\n\nnew/model-a   first\nnew/model-b   second\n';
  process.env.COMMAND_CODE_CMD = fakeCli('commandcode', updated);
  assert.equal((await listCc()).source, 'cache');
  const fresh = await listCc({ refresh: true });
  assert.equal(fresh.source, 'cli');
  assert.deepEqual(fresh.models.map(m => m.model), ['new/model-a', 'new/model-b']);
});

test('grok: refresh skips the one-hour cache', async () => {
  process.env.GROK_CMD = fakeCli('grok', GROK_AUTHED);
  assert.equal((await listGrok()).source, 'cli');
  process.env.GROK_CMD = fakeCli('grok', 'Default model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-5-preview\n');
  assert.equal((await listGrok()).source, 'cache');
  const fresh = await listGrok({ refresh: true });
  assert.equal(fresh.source, 'cli');
  assert.deepEqual(fresh.models.map(m => m.model), ['grok-4.7', 'grok-5-preview']);
});

test('四份 CLI 模型目录与冻结版逐项核对顺序、截断、缓存和回调', async () => {
  const cases = [
    [cc, require('./helpers/frozen-file-batch7/commandcode-models'), 'parseCommandcodeList', 'peekCommandcodeModels', 'listCommandcodeModels', 3600000],
    [grok, require('./helpers/frozen-file-batch7/grok-models'), 'parseGrokModels', 'peekGrokModels', 'listGrokModels', 3600000],
    [require('../src/routes/model-catalogs-host').getVendorCatalog('qoder'), require('./helpers/frozen-file-batch7/qoder-models'), 'parseQoderStdout', 'peekQoderModels', 'listQoderModels', 86400000],
    [require('../src/routes/model-catalogs-host').getVendorCatalog('codebuddy'), require('./helpers/frozen-file-batch7/codebuddy-models'), 'parseCodebuddyHelp', 'peekCodebuddyModels', 'listCodebuddyModels', 3600000],
  ];
  const ids = Array.from({ length: 450 }, (_, i) => 'model-' + i);
  const captures = [null, 0, {}, Symbol('catalog'), CC_REAL, GROK_ANON, GROK_AUTHED,
    'Available models:\r\n* x\n- x (default)\n- y (DEFAULT)\n',
    'MODEL\n\ufeffa\nhi\tignored\nalpha\u0085beta\n\ud800\n' + '😀'.repeat(61),
    '标题\udfff\n\nfoo/bar   描述\ud800\nwrong:\t\t忽略\nfoo/bar  又见\n',
    'CURRENTLY SUPPORTED:\t(a,a,b,foo/bar,[31mc[0m,\u001b[32md\u001b[0m)',
    'MODEL\n' + ids.join('\n'), 'Currently supported: (' + ids.join(',') + ')',
    'available models:\n' + ids.map(id => ' - ' + id).join('\n'),
    'group\n\n' + ids.map(id => id + '  描述').join('\n')];
  const savedNow = Date.now;
  let now = 100;
  try {
    Date.now = () => now;
    for (const [current, old, parse, peek, list, ttl] of cases) {
      for (const input of captures) assert.deepEqual(current[parse](input), old[parse](input));
      for (const api of [old, current]) {
        const failure = new Error('input'); assert.throws(() => api[parse]({ toString() { throw failure; } }), e => e === failure);
        api._resetCacheForTest(); const fallback = api[peek]();
        assert.deepEqual(fallback, old[peek]()); assert.notEqual(fallback, api[peek]());
        now = 100; const first = [], replacement = [{ model: 'new' }];
        api._setCacheForTest(now, first);
        now += ttl - 1; assert.equal(api[peek](), first);
        const result = new Promise(resolve => api[list]((err, models, source) => resolve([err, models, source])));
        api._setCacheForTest(100, replacement);
        const [err, models, source] = await result;
        assert.equal(err, null); assert.equal(models, replacement); assert.equal(source, 'cache');
        now++; assert.deepEqual(api[peek](), fallback);
        api._resetCacheForTest();
      }
    }
  } finally { Date.now = savedNow; for (const [a,b] of cases) { a._resetCacheForTest(); b._resetCacheForTest(); } }
});

test('同一 CLI 并发刷新按子进程完成顺序发布，解析失败后仍可刷新', async t => {
  const callbacks = [];
  t.mock.method(require('node:child_process'), 'execFile', (_bin, _args, _opts, done) => callbacks.push(done));
  const hostPath = require.resolve('../src/routes/model-catalogs-host');
  const cachedHost = require.cache[hostPath];
  delete require.cache[hostPath];
  let catalog;
  try { catalog = require(hostPath).getVendorCatalog('grok'); }
  finally { require.cache[hostPath] = cachedHost; }

  const gate = Promise.withResolvers();
  const prototype = require('../src/native/binding').getNative().RustVendorModelCatalog.prototype;
  const parse = prototype.readListing;
  const failure = new Error('worker failed');
  t.mock.method(prototype, 'readListing', async function (text) {
    if (text === 'failed') throw failure;
    if (text === 'first') await gate.promise;
    return parse.call(this, 'Available models:\n- ' + text);
  });
  const published = [];
  const refresh = () => new Promise((resolve, reject) => catalog.listGrokModels((err, models) => {
    if (err) return reject(err);
    published.push(models[0].model);
    resolve(models);
  }, { refresh: true }));
  const first = refresh(), second = refresh();
  callbacks.shift()(null, 'first');
  callbacks.shift()(null, 'second');
  await new Promise(setImmediate);
  assert.deepEqual(published, []);
  gate.resolve();
  await first;
  assert.equal(await second, catalog.peekGrokModels());
  const rejected = refresh(), recovery = refresh();
  callbacks.shift()(null, 'failed');
  callbacks.shift()(null, 'third');
  await assert.rejects(rejected, e => e === failure);
  assert.equal(await recovery, catalog.peekGrokModels());
  assert.deepEqual(published, ['first', 'second', 'third']);
});
