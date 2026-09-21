'use strict';

// /api/codebuddy/models — the WorkBuddy (codebuddy) catalog feed.
//
// WorkBuddy auto-updates frequently and has no --list-models, but its --help
// prints the supported ids inline on the --model flag. These tests pin the
// parsing rules and the two caching decisions: a parsed catalog is cached for
// 1 hour, while the offline fallback snapshot is never cached (otherwise an
// unreadable CLI would hide the real models until the cache expired).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../src/routes/codebuddy-models');
const { parseCodebuddyHelp, listCodebuddyModels, CODEBUDDY_MODEL_FALLBACK } = mod;

const ORIGINAL_CODEBUDDY_CMD = process.env.CODEBUDDY_CMD;

function fakeCli(stdout, { exitCode = 0 } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-models-')), 'codebuddy');
  fs.writeFileSync(file, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\nexit ${exitCode}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function list() {
  return new Promise((resolve, reject) => {
    listCodebuddyModels((err, models, source) => (err ? reject(err) : resolve({ models, source })));
  });
}

const HELP_WITH_MODELS = `Usage: codebuddy|cbc [options] [command] [prompt]

Options:
  -p, --print                                      Print response and exit
  --model <model>                                  Model for the current session. Please provide the model ID. Currently supported: (hy4-preview-f, glm-5.3, kimi-k3-1)
  --effort <level>                                 Reasoning effort level
`;

test.afterEach(() => {
  mod._resetCacheForTest();
  if (ORIGINAL_CODEBUDDY_CMD === undefined) delete process.env.CODEBUDDY_CMD;
  else process.env.CODEBUDDY_CMD = ORIGINAL_CODEBUDDY_CMD;
});

test('parses the --model help line: extracts the parenthesised id list', () => {
  const parsed = parseCodebuddyHelp(HELP_WITH_MODELS);
  assert.deepEqual(parsed.map(entry => entry.model), ['hy4-preview-f', 'glm-5.3', 'kimi-k3-1']);
  assert.equal(parsed[0].label, 'hy4-preview-f');
});

test('parses defensively: strips SGR colour codes, blanks and duplicates', () => {
  const parsed = parseCodebuddyHelp(
    '--model <model>  Currently supported: (\x1b[32mglm-5.3\x1b[0m, , glm-5.3, hy3)\n',
  );
  assert.deepEqual(parsed.map(entry => entry.model), ['glm-5.3', 'hy3']);
});

test('rejects malformed ids instead of leaking help prose into the picker', () => {
  const parsed = parseCodebuddyHelp(
    '--model <model>  Currently supported: (glm-5.3, not a model, -leading-dash, ok-id)\n',
  );
  assert.deepEqual(parsed.map(entry => entry.model), ['glm-5.3', 'ok-id']);
});

test('help without a supported list yields nothing (caller falls back)', () => {
  assert.deepEqual(parseCodebuddyHelp('Usage: codebuddy [options]\n  --model <model>  Model id\n'), []);
  assert.deepEqual(parseCodebuddyHelp(''), []);
});

test('a parsed catalog is served from the CLI, then from cache', async () => {
  process.env.CODEBUDDY_CMD = fakeCli(HELP_WITH_MODELS);
  const first = await list();
  assert.equal(first.source, 'cli');
  assert.deepEqual(first.models.map(entry => entry.model), ['hy4-preview-f', 'glm-5.3', 'kimi-k3-1']);

  // Point at a binary that cannot run: a cached catalog must still be served.
  process.env.CODEBUDDY_CMD = '/nonexistent/codebuddy';
  const second = await list();
  assert.equal(second.source, 'cache');
  assert.deepEqual(second.models, first.models);
});

test('an unreadable CLI falls back to the snapshot without caching it', async () => {
  process.env.CODEBUDDY_CMD = '/nonexistent/codebuddy';
  const first = await list();
  assert.equal(first.source, 'fallback');
  assert.deepEqual(first.models.map(entry => entry.model), [...CODEBUDDY_MODEL_FALLBACK]);

  // Not cached: the very next call must retry the CLI, so a fresh auto-update
  // surfaces the new catalog immediately instead of an hour later.
  process.env.CODEBUDDY_CMD = fakeCli(HELP_WITH_MODELS);
  const second = await list();
  assert.equal(second.source, 'cli');
  assert.deepEqual(second.models.map(entry => entry.model), ['hy4-preview-f', 'glm-5.3', 'kimi-k3-1']);
});

test('help that lacks the list falls back rather than serving nothing', async () => {
  process.env.CODEBUDDY_CMD = fakeCli('Usage: codebuddy [options]\n');
  const first = await list();
  assert.equal(first.source, 'fallback');
  assert.ok(first.models.length > 0);
});

test('mountCodebuddyModelRoutes serves GET /api/codebuddy/models', async () => {
  process.env.CODEBUDDY_CMD = fakeCli(HELP_WITH_MODELS);
  const routes = [];
  const app = { get: (path, handler) => routes.push({ path, handler }) };
  mod.mountCodebuddyModelRoutes(app);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/codebuddy/models');
  const response = await new Promise((resolve) => {
    routes[0].handler({}, {
      json: payload => resolve({ status: 200, payload }),
      status(code) { return { json: payload => resolve({ status: code, payload }) }; },
    });
  });
  assert.equal(response.status, 200);
  assert.equal(response.payload.source, 'cli');
  assert.equal(response.payload.cached, false);
  assert.deepEqual(response.payload.models.map(entry => entry.model), ['hy4-preview-f', 'glm-5.3', 'kimi-k3-1']);
});
