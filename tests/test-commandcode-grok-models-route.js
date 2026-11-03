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

const cc = require('../src/routes/commandcode-models');
const grok = require('../src/routes/grok-models');

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

test('commandcode: refresh skips the one-hour cache; the route accepts refresh=1/true', async () => {
  process.env.COMMAND_CODE_CMD = fakeCli('commandcode', CC_REAL);
  const cached = await listCc();
  assert.equal(cached.source, 'cli');
  const updated = 'Open Source\n\nnew/model-a   first\nnew/model-b   second\n';
  process.env.COMMAND_CODE_CMD = fakeCli('commandcode', updated);
  assert.equal((await listCc()).source, 'cache');
  const fresh = await listCc({ refresh: true });
  assert.equal(fresh.source, 'cli');
  assert.deepEqual(fresh.models.map(m => m.model), ['new/model-a', 'new/model-b']);

  const routes = new Map();
  cc.mountCommandcodeModelRoutes({ get: (p, h) => routes.set(p, h) });
  const handler = routes.get('/api/commandcode/models');
  for (const value of ['1', 'true']) {
    cc._setCacheForTest(Date.now(), [{ model: 'cached-model', label: 'cached-model', group: 'Open Source' }]);
    const body = await new Promise(resolve => handler({ query: { refresh: value } }, { json: resolve }));
    assert.equal(body.source, 'cli', `refresh=${value} bypasses the cache`);
    assert.deepEqual(body.models.map(m => m.model), ['new/model-a', 'new/model-b']);
  }
});

test('grok: refresh skips the one-hour cache; the route accepts refresh=1/true', async () => {
  process.env.GROK_CMD = fakeCli('grok', GROK_AUTHED);
  assert.equal((await listGrok()).source, 'cli');
  process.env.GROK_CMD = fakeCli('grok', 'Default model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-5-preview\n');
  assert.equal((await listGrok()).source, 'cache');
  const fresh = await listGrok({ refresh: true });
  assert.equal(fresh.source, 'cli');
  assert.deepEqual(fresh.models.map(m => m.model), ['grok-4.7', 'grok-5-preview']);

  const routes = new Map();
  grok.mountGrokModelRoutes({ get: (p, h) => routes.set(p, h) });
  const handler = routes.get('/api/grok/models');
  for (const value of ['1', 'true']) {
    grok._setCacheForTest(Date.now(), [{ model: 'cached-model', label: 'cached-model' }]);
    const body = await new Promise(resolve => handler({ query: { refresh: value } }, { json: resolve }));
    assert.equal(body.source, 'cli', `refresh=${value} bypasses the cache`);
    assert.deepEqual(body.models.map(m => m.model), ['grok-4.7', 'grok-5-preview']);
  }
});

test('routes are mounted at the documented paths', async () => {
  const routes = [];
  const app = { get: (p, h) => routes.push({ p, h }) };
  cc.mountCommandcodeModelRoutes(app);
  grok.mountGrokModelRoutes(app);
  assert.deepEqual(routes.map(r => r.p), ['/api/commandcode/models', '/api/grok/models']);
  process.env.GROK_CMD = fakeCli('grok', GROK_AUTHED);
  const payload = await new Promise(resolve => routes[1].h({}, { json: resolve, status() { return { json: resolve }; } }));
  assert.equal(payload.source, 'cli');
  assert.equal(payload.models[0].model, 'grok-4.6');
});
