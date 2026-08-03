'use strict';

// /api/qoder/models — the Qoder CN catalog feed.
//
// Qoder renames models in place and scopes the catalog to the signed-in
// account, so the picker must read `qoderclicn --list-models` instead of a
// hardcoded table. These tests pin the parsing rules and, more importantly,
// the two caching decisions: a real catalog is cached for a day, while the
// offline routing-tier fallback is never cached (otherwise a logged-out CLI
// would hide the real models until the next day).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../src/routes/qoder-models');
const { parseQoderStdout, listQoderModels, QODER_TIER_FALLBACK } = mod;

const ORIGINAL_QODER_CMD = process.env.QODER_CMD;

function fakeCli(stdout, { exitCode = 0 } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-models-')), 'qoderclicn');
  fs.writeFileSync(file, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\nexit ${exitCode}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function list() {
  return new Promise((resolve, reject) => {
    listQoderModels((err, models, source) => (err ? reject(err) : resolve({ models, source })));
  });
}

test.afterEach(() => {
  mod._resetCacheForTest();
  if (ORIGINAL_QODER_CMD === undefined) delete process.env.QODER_CMD;
  else process.env.QODER_CMD = ORIGINAL_QODER_CMD;
});

test('parses the CLI table: drops the MODEL header, blanks and duplicates', () => {
  const parsed = parseQoderStdout('MODEL\nAuto\n\nQwen3.8-Max\nGLM-5.2\nGLM-5.2\n');
  assert.deepEqual(parsed.map(entry => entry.model), ['Auto', 'Qwen3.8-Max', 'GLM-5.2']);
  assert.equal(parsed[0].label, 'Auto');
});

test('parses defensively: strips SGR colour codes and extra columns', () => {
  const parsed = parseQoderStdout('\x1b[1mMODEL\x1b[0m\n\x1b[32mQwen3.8-Max\x1b[0m\nGLM-5.2   available\n');
  assert.deepEqual(parsed.map(entry => entry.model), ['Qwen3.8-Max', 'GLM-5.2']);
});

test('a real catalog is served from the CLI, then from cache', async () => {
  process.env.QODER_CMD = fakeCli('MODEL\nAuto\nQwen3.8-Max\nGLM-5.2');
  const first = await list();
  assert.equal(first.source, 'cli');
  assert.deepEqual(first.models.map(entry => entry.model), ['Auto', 'Qwen3.8-Max', 'GLM-5.2']);

  // Point at a binary that cannot run: a cached catalog must still be served.
  process.env.QODER_CMD = '/nonexistent/qoderclicn';
  const second = await list();
  assert.equal(second.source, 'cache');
  assert.deepEqual(second.models, first.models);
});

test('an unreachable CLI falls back to the routing tiers without caching them', async () => {
  process.env.QODER_CMD = '/nonexistent/qoderclicn';
  const first = await list();
  assert.equal(first.source, 'fallback');
  assert.deepEqual(first.models.map(entry => entry.model), [...QODER_TIER_FALLBACK]);

  // Not cached: the very next call must retry the CLI, so a recovered login
  // surfaces the real catalog immediately instead of a day later.
  process.env.QODER_CMD = fakeCli('MODEL\nQwen3.8-Max');
  const second = await list();
  assert.equal(second.source, 'cli');
  assert.deepEqual(second.models.map(entry => entry.model), ['Qwen3.8-Max']);
});

test('a CLI that prints only the header falls back rather than serving nothing', async () => {
  process.env.QODER_CMD = fakeCli('MODEL');
  const { models, source } = await list();
  assert.equal(source, 'fallback');
  assert.ok(models.length > 0);
});

test('the route reports source and cached, and never 500s on a dead CLI', async () => {
  process.env.QODER_CMD = '/nonexistent/qoderclicn';
  const routes = new Map();
  mod.mountQoderModelRoutes({ get: (route, handler) => routes.set(route, handler) });
  const handler = routes.get('/api/qoder/models');
  assert.equal(typeof handler, 'function');

  const body = await new Promise((resolve) => {
    handler({}, { json: resolve, status() { throw new Error('must not fail the request'); } });
  });
  assert.equal(body.source, 'fallback');
  assert.equal(body.cached, false);
  assert.ok(Array.isArray(body.models) && body.models.length > 0);
});
