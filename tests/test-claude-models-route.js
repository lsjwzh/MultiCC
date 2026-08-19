'use strict';

// /api/claude/models — the Claude CLI-bundle model feed.
//
// The installed claude CLI is the only authoritative local source of servable
// model ids for subscription logins (no --list-models, and /v1/models needs an
// API key), so the route extracts ids from the CLI bundle. These tests pin the
// extraction rules (dated/dot twins collapse into one dash id, [1m] rows only
// for ids whose [1m] variant the bundle carries, the per-family newest-2
// window, window-boundary overlap) and the two caching decisions: a CLI-derived
// list is cached for a day, while the static fallback is never cached.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../src/routes/claude-models');
const { extractModels, curateModels, listClaudeModels, CLAUDE_MODELS_FALLBACK } = mod;

function fixtureBundle(content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-models-')), 'bundle');
  fs.writeFileSync(file, content);
  return file;
}

function list(options) {
  return new Promise((resolve, reject) => {
    listClaudeModels(options, (err, models, source) => (err ? reject(err) : resolve({ models, source })));
  });
}

test.afterEach(() => mod._resetCacheForTest());

test('extraction canonicalizes dated and dot twins into one dash id', () => {
  const file = fixtureBundle([
    '"claude-opus-5"',
    '"claude-opus-4-1-20250805"',
    '"claude-opus-4-20250514"',
    '"claude-sonnet-4.6"',
    '"claude-sonnet-4-6-20251114"',
    '"claude-haiku-4-5-20251001"',
    '"claude-haiku-4-5"',
    'xclaude-opus-5-1', // lookbehind must reject the embedded substring
  ].join('\n'));
  const { ids, oneMIds } = extractModels(file);
  assert.deepEqual([...ids].sort(), [
    'claude-haiku-4-5',
    'claude-opus-4',
    'claude-opus-4-1',
    'claude-opus-5',
    'claude-sonnet-4-6',
  ]);
  assert.equal(oneMIds.size, 0);
});

test('a dated id whose [1m] variant exists keeps the 1m flag on the canonical id', () => {
  const file = fixtureBundle('"claude-sonnet-4-5-20250929[1m]"\n"claude-sonnet-4-5-20250929"\n');
  const { ids, oneMIds } = extractModels(file);
  assert.deepEqual([...ids], ['claude-sonnet-4-5']);
  assert.deepEqual([...oneMIds], ['claude-sonnet-4-5']);
});

test('curation emits [1m] rows only for ids with a real variant, newest-2 per family', () => {
  const file = fixtureBundle([
    '"claude-opus-5[1m]"', '"claude-opus-5"', '"claude-opus-4-8[1m]"', '"claude-opus-4-8"',
    '"claude-opus-4-7"', '"claude-opus-4-6"', // beyond the window
    '"claude-sonnet-5"', // no [1m] variant in the bundle
    '"claude-fable-5"', // no [1m] variant either
  ].join('\n'));
  const models = curateModels(extractModels(file));
  assert.deepEqual(models, [
    { model: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)' },
    { model: 'claude-opus-5', label: 'Opus 5' },
    { model: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M context)' },
    { model: 'claude-opus-4-8', label: 'Opus 4.8' },
    { model: 'claude-sonnet-5', label: 'Sonnet 5' },
    { model: 'claude-fable-5', label: 'Fable 5' },
  ]);
});

test('an id straddling a window boundary is still found (overlap works)', () => {
  // Window 1 with chunkSize 50 spans [0, 114) — the id starts at 110, so its
  // tail only appears complete in window 2 [50, 164). A no-overlap scan would
  // miss it entirely.
  const id = 'claude-opus-5';
  const file = fixtureBundle(`${'"'.padStart(110, '.')}"${id}" tail`);
  mod._setChunkSizeForTest(50);
  const { ids } = extractModels(file);
  assert.ok(ids.has(id), `expected ${id} in ${[...ids]}`);
});

test('a real bundle is served from the CLI, then from cache', async () => {
  const file = fixtureBundle('"claude-opus-5"\n"claude-sonnet-5"\n');
  const first = await list({ bundleFile: file, home: '/nonexistent' });
  assert.equal(first.source, 'cli');
  assert.deepEqual(first.models.map(m => m.model), ['claude-opus-5', 'claude-sonnet-5']);

  // Point at a bundle that does not exist: a cached list must still be served.
  const second = await list({ bundleFile: '/nonexistent/bundle', home: '/nonexistent' });
  assert.equal(second.source, 'cache');
  assert.deepEqual(second.models, first.models);
});

test('an unreadable bundle falls back to the static list without caching it', async () => {
  const first = await list({ bundleFile: '/nonexistent/bundle', home: '/nonexistent' });
  assert.equal(first.source, 'fallback');
  assert.deepEqual(first.models.map(m => m.model), CLAUDE_MODELS_FALLBACK.map(m => m.model));
  assert.ok(first.models.some(m => m.model === 'claude-opus-5'));

  // Not cached: the very next call must retry the bundle, so a newly installed
  // CLI surfaces immediately instead of a day later.
  const file = fixtureBundle('"claude-opus-5"\n');
  const second = await list({ bundleFile: file, home: '/nonexistent' });
  assert.equal(second.source, 'cli');
});

test('the route reports source and cached, and never 500s', async () => {
  // Seed the cache so the contract is asserted deterministically — a cold
  // route would extract this machine's real bundle (or fall back), which is
  // already covered by the list() tests above.
  mod._setCacheForTest(Date.now(), [{ model: 'claude-opus-5', label: 'Opus 5' }]);
  const routes = new Map();
  mod.mountClaudeModelRoutes({ get: (route, handler) => routes.set(route, handler) });
  const handler = routes.get('/api/claude/models');
  assert.equal(typeof handler, 'function');

  const body = await new Promise((resolve) => {
    handler({}, { json: resolve, status() { throw new Error('must not fail the request'); } });
  });
  assert.equal(body.source, 'cache');
  assert.equal(body.cached, true);
  assert.deepEqual(body.models, [{ model: 'claude-opus-5', label: 'Opus 5' }]);
});
