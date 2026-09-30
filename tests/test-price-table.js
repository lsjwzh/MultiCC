'use strict';

// The price table is the Auto router's cost oracle, so these tests pin the two
// things that make it usable from a routing decision:
//
//   1. WHICH price answers a lookup. An id can be carried by a dozen providers
//      (`gpt-5` sells on openai, azure and every aggregator), and picking the
//      wrong one silently changes the routing decision. The rules are pinned
//      here: an explicit caller hint wins, then the first-party list, then the
//      median among the rest — and an unpriced entry never counts as a match.
//   2. THE REFRESH CONTRACT under a hostile network. A garbage payload must not
//      replace a working table, a dead connection must not reject the promise,
//      and three concurrent callers must produce one download.
//
// Fully offline: every refresh gets an injected fetch, every table gets a temp
// cacheDir, and the fixture catalogs are written to temp files. Nothing here
// touches the real ~/.multicc, ~/.cache/opencode or models.dev.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createPriceTable,
  blendedPrice,
  normalizeModelId,
  FIRST_PARTY_PROVIDERS,
  DEFAULT_REMOTE_URL,
} = require('../src/pricing/price-table');
const { mountPricingRoutes, MAX_LOOKUP_MODELS } = require('../src/routes/pricing');

const REPO_ROOT = path.resolve(__dirname, '..');
const SEED_FILE = path.join(REPO_ROOT, 'src', 'pricing', 'seed-prices.json');

// ── fixture: a miniature models.dev ────────────────────────────────────────
//
// Deliberately includes the awkward cases: one id on a first-party AND an
// aggregator (`gpt-5`), one id on three aggregators only (`shared-model`, for
// the median rule), a dotted reseller id, an id that only normalizes onto a
// first-party model (`claude-3-5-haiku-20241022` vs `claude-haiku-4-5`), an
// unpriced model, and a cost with only a cache price.
function model(id, cost, limit) {
  const entry = { id, name: id };
  if (cost) entry.cost = cost;
  if (limit) entry.limit = limit;
  return entry;
}

const FIXTURE = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-sonnet-4-5': model('claude-sonnet-4-5', { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }, { context: 200000, output: 64000 }),
      'claude-haiku-4-5': model('claude-haiku-4-5', { input: 1, output: 5 }, { context: 200000, output: 64000 }),
      'claude-opus-4-5': model('claude-opus-4-5', { input: 5, output: 25 }, { context: 200000, output: 32000 }),
      // Known, but the catalog carries no price for it.
      'claude-3-5-haiku-20241022': model('claude-3-5-haiku-20241022', null, { context: 200000 }),
    },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: {
      'gpt-5': model('gpt-5', { input: 1.25, output: 10, cache_read: 0.125 }, { context: 400000, output: 128000 }),
      'gpt-5-mini': model('gpt-5-mini', { input: 0.25, output: 2 }, { context: 400000, output: 128000 }),
    },
  },
  azure: {
    id: 'azure',
    name: 'Azure',
    models: {
      'gpt-5': model('gpt-5', { input: 0.9, output: 9 }, { context: 272000, output: 128000 }),
    },
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    models: {
      'anthropic/claude-sonnet-4.5': model('anthropic/claude-sonnet-4.5', { input: 3, output: 15 }, { context: 1000000, output: 64000 }),
    },
  },
  'alpha-reseller': { id: 'alpha-reseller', name: 'Alpha', models: { 'shared-model': model('shared-model', { input: 1, output: 1 }) } },
  'beta-reseller': { id: 'beta-reseller', name: 'Beta', models: { 'shared-model': model('shared-model', { input: 5, output: 5 }) } },
  'gamma-reseller': { id: 'gamma-reseller', name: 'Gamma', models: { 'shared-model': model('shared-model', { input: 9, output: 9 }) } },
  moonshotai: {
    id: 'moonshotai',
    name: 'Moonshot',
    models: {
      // Output-only price: the blend must fall back to the known side.
      'kimi-k2-0905': model('kimi-k2-0905', { output: 2.5 }, { context: 256000 }),
      'cache-only-model': model('cache-only-model', { cache_read: 0.1 }, { context: 256000 }),
    },
  },
};

function fixtureCounts(catalog) {
  let models = 0;
  let priced = 0;
  for (const provider of Object.values(catalog)) {
    for (const entry of Object.values(provider.models)) {
      models += 1;
      if (Number.isFinite(entry.cost?.input || entry.cost?.output)) priced += 1;
    }
  }
  return { models, priced };
}

const FIXTURE_COUNTS = fixtureCounts(FIXTURE);

// A catalog big enough to pass refresh()'s "is this really a price catalog"
// validation (>= 50 priced models).
function remoteCatalog(count = 60) {
  const models = {};
  for (let index = 0; index < count; index += 1) {
    models[`remote-model-${index}`] = model(`remote-model-${index}`, { input: index + 1, output: (index + 1) * 2 }, { context: 1000 * (index + 1), output: 100 });
  }
  return { 'test-provider': { id: 'test-provider', name: 'Test Provider', models } };
}

// ── helpers ────────────────────────────────────────────────────────────────

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-price-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

// A table whose only readable source is the fixture written to `file`: the
// network is a hard failure so any test that silently starts refreshing fails
// loudly instead of hitting models.dev.
function fixtureTable(t, options = {}) {
  const dir = tempDir(t);
  const opencodeCachePath = options.catalog === null
    ? path.join(dir, 'absent.json')
    : writeJson(options.file || path.join(dir, 'opencode-models.json'), options.catalog || FIXTURE);
  const table = createPriceTable({
    cacheDir: path.join(dir, 'cache'),
    opencodeCachePath,
    seedPath: path.join(dir, 'absent-seed.json'),
    fetchImpl: async () => { throw new Error('network disabled in this test'); },
    ...options.table,
  });
  return { table, dir, opencodeCachePath };
}

function jsonResponse(body, { status = 200, etag = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => (String(name).toLowerCase() === 'etag' ? etag : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function fetchRecorder(handler) {
  const calls = [];
  const impl = (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

// A promise-returning stub of one route handler, in the style the other route
// suites use (there is no express app in unit tests).
function fakeApp() {
  const routes = {};
  return {
    routes,
    app: {
      get: (routePath, handler) => { routes[`GET ${routePath}`] = handler; },
      post: (routePath, handler) => { routes[`POST ${routePath}`] = handler; },
    },
  };
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.set = () => res;
  return res;
}

// ── blendedPrice / normalizeModelId ───────────────────────────────────────

test('blendedPrice weights input at 0.75 and ignores anything that is not a real price', () => {
  assert.equal(blendedPrice({ input: 3, output: 15 }), 6);
  assert.equal(blendedPrice({ input: 1.25, output: 10 }), 3.4375);
  // One side known: the known side stands in (a missing field is not a 0).
  assert.equal(blendedPrice({ output: 10 }), 10);
  assert.equal(blendedPrice({ input: 2 }), 2);
  assert.equal(blendedPrice({ input: 0, output: 0 }), 0);
  // Nothing priceable.
  assert.equal(blendedPrice({}), null);
  assert.equal(blendedPrice(null), null);
  assert.equal(blendedPrice(undefined), null);
  assert.equal(blendedPrice({ cache_read: 0.1 }), null);
  assert.equal(blendedPrice({ input: -1, output: -1 }), null);
  assert.equal(blendedPrice({ input: 'free', output: null }), null);
});

test('normalizeModelId collapses the spellings a session can hand us onto one key', () => {
  assert.equal(normalizeModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(normalizeModelId('Claude-Haiku-4-5-2025-10-01'), 'claude-haiku-4-5');
  assert.equal(normalizeModelId('claude-sonnet-4-5[1m]'), 'claude-sonnet-4-5');
  assert.equal(normalizeModelId('  GPT-5  '), 'gpt-5');
  // Vendor prefixes, however deeply nested.
  assert.equal(normalizeModelId('anthropic/claude-sonnet-4-5'), 'claude-sonnet-4-5');
  assert.equal(normalizeModelId('openrouter/anthropic/claude-sonnet-4-5'), 'claude-sonnet-4-5');
  // Reseller suffixes survive the slash split and are stripped after it.
  assert.equal(normalizeModelId('deepseek/deepseek-chat:free'), 'deepseek-chat');
  // A dated snapshot behind a prefix is still one model.
  assert.equal(normalizeModelId('openai/gpt-4o-2024-11-20'), 'gpt-4o');
  assert.equal(normalizeModelId(''), '');
  assert.equal(normalizeModelId(null), '');
});

// ── lookup ────────────────────────────────────────────────────────────────

test('lookup prefers the first-party provider when several carry the same id', () => {
  const { table } = fixtureTable(test);
  // gpt-5 exists on openai and azure; both are priced.
  const entry = table.lookup('gpt-5');
  assert.equal(entry.providerKey, 'openai');
  assert.equal(entry.model, 'gpt-5');
  assert.equal(entry.query, 'gpt-5');
  assert.equal(entry.matchedBy, 'exact');
  assert.equal(entry.source, 'opencode-cache');
  assert.equal(entry.input, 1.25);
  assert.equal(entry.output, 10);
  assert.equal(entry.cacheRead, 0.125);
  assert.equal(entry.cacheWrite, null);
  assert.equal(entry.blended, 3.4375);
  assert.equal(entry.context, 400000);
  assert.equal(typeof entry.fetchedAt, 'string');
  assert.equal(Object.isFrozen(entry), true, 'entries are frozen so a router cannot mutate the table');
  // The id is matched case-insensitively.
  assert.equal(table.lookup('GPT-5').providerKey, 'openai');
});

test('a vendor-prefixed id resolves to that vendor even when a reseller carries the literal id', (t) => {
  const catalog = JSON.parse(JSON.stringify(FIXTURE));
  catalog.openrouter.models['anthropic/claude-sonnet-4-5'] = model('anthropic/claude-sonnet-4-5', { input: 3.6, output: 18 });
  const { table } = fixtureTable(t, { catalog });
  const entry = table.lookup('anthropic/claude-sonnet-4-5');
  assert.equal(entry.providerKey, 'anthropic');
  assert.equal(entry.input, 3);
  assert.equal(entry.matchedBy, 'normalized');
  // An explicit hint still decides.
  assert.equal(table.lookup('anthropic/claude-sonnet-4-5', { providerHint: 'openrouter' }).input, 3.6);
});

test('lookup prefers an explicit providerHint over the first-party default', () => {
  const { table } = fixtureTable(test);
  assert.equal(table.lookup('gpt-5', { providerHint: 'azure' }).providerKey, 'azure');
  assert.equal(table.lookup('gpt-5', { providerHint: 'azure' }).blended, 2.925);
  // A hint nobody carries must not turn the lookup into a miss.
  assert.equal(table.lookup('gpt-5', { providerHint: 'nope' }).providerKey, 'openai');
  // …and a hint is also honoured on the normalized path.
  assert.equal(table.lookup('azure/gpt-5', { providerHint: 'azure' }).providerKey, 'azure');
});

test('lookup falls back to the median price when only aggregators carry the id', () => {
  const { table } = fixtureTable(test);
  const entry = table.lookup('shared-model');
  assert.equal(entry.providerKey, 'beta-reseller');
  assert.equal(entry.blended, 5);
});

test('lookup normalizes vendor prefixes, snapshot dates and context suffixes', () => {
  const { table } = fixtureTable(test);
  const cases = [
    'claude-haiku-4-5-20251001',
    'Claude-Haiku-4-5-2025-10-01',
    'claude-haiku-4-5[1m]',
    'anthropic/claude-haiku-4-5',
    'openrouter/anthropic/claude-haiku-4-5',
  ];
  for (const query of cases) {
    const entry = table.lookup(query);
    assert.ok(entry, `${query} should resolve`);
    assert.equal(entry.model, 'claude-haiku-4-5');
    assert.equal(entry.providerKey, 'anthropic');
    assert.equal(entry.matchedBy, 'normalized');
    assert.equal(entry.query, query, 'the caller always gets its own string back');
  }
  // A reseller's dotted id is NOT normalized onto the first-party one — the
  // exact id wins for whoever actually named it.
  const dotted = table.lookup('anthropic/claude-sonnet-4.5');
  assert.equal(dotted.providerKey, 'openrouter');
  assert.equal(dotted.matchedBy, 'exact');
  // …while the undotted first-party spelling resolves through normalization.
  const undotted = table.lookup('anthropic/claude-sonnet-4-5');
  assert.equal(undotted.providerKey, 'anthropic');
  assert.equal(undotted.matchedBy, 'normalized');
  assert.equal(undotted.model, 'claude-sonnet-4-5');
});

test('lookup answers null for unpriced, unknown and empty queries instead of throwing', () => {
  const { table } = fixtureTable(test);
  assert.equal(table.lookup('claude-3-5-haiku-20241022'), null, 'known id without a price');
  assert.equal(table.lookup('cache-only-model'), null, 'cache price is not a token price');
  assert.equal(table.lookup('no-such-model-anywhere'), null);
  assert.equal(table.lookup(''), null);
  assert.equal(table.lookup('   '), null);
  assert.equal(table.lookup(null), null);
  assert.equal(table.lookup(undefined), null);
  assert.equal(table.lookup({}), null);
});

test('lookupMany keys every answer by the caller\'s own string', () => {
  const { table } = fixtureTable(test);
  const prices = table.lookupMany(['gpt-5', 'claude-haiku-4-5', 'nope']);
  assert.deepEqual(Object.keys(prices), ['gpt-5', 'claude-haiku-4-5', 'nope']);
  assert.equal(prices['gpt-5'].providerKey, 'openai');
  assert.equal(prices['claude-haiku-4-5'].providerKey, 'anthropic');
  assert.equal(prices.nope, null);
});

test('status reports the loaded local source and its size', () => {
  const { table } = fixtureTable(test);
  const status = table.status();
  assert.equal(status.source, 'opencode-cache');
  assert.equal(status.modelCount, FIXTURE_COUNTS.models);
  assert.equal(status.pricedCount, FIXTURE_COUNTS.priced);
  assert.equal(status.providerCount, Object.keys(FIXTURE).length);
  assert.equal(status.lastError, null);
  assert.equal(status.refreshing, false);
  assert.equal(status.remoteUrl, DEFAULT_REMOTE_URL);
  assert.equal(status.stale, false, 'a file we just wrote is not stale');
  assert.equal(Object.isFrozen(status), true);
});

test('status with no readable local source is empty rather than broken', () => {
  const dir = tempDir(test);
  const table = createPriceTable({
    cacheDir: path.join(dir, 'cache'),
    opencodeCachePath: path.join(dir, 'absent.json'),
    seedPath: path.join(dir, 'absent-seed.json'),
    fetchImpl: async () => { throw new Error('network disabled in this test'); },
    now: () => Date.now(),
  });
  const status = table.status();
  assert.equal(status.source, null);
  assert.equal(status.fetchedAt, null);
  assert.equal(status.modelCount, 0);
  assert.equal(status.pricedCount, 0);
  assert.equal(status.stale, true);
  assert.equal(table.lookup('gpt-5'), null);
  assert.deepEqual(table.search('gpt'), []);
});

// ── local source priority ─────────────────────────────────────────────────

test('local sources are tried in priority order: own cache, opencode cache, seed', () => {
  const dir = tempDir(test);
  const cacheDir = path.join(dir, 'cache');
  const opencodeCachePath = path.join(dir, 'opencode-models.json');
  const marker = (id) => ({ 'marker-provider': { id: 'marker-provider', name: 'Marker', models: { [id]: model(id, { input: 1, output: 1 }) } } });
  const fetchImpl = async () => { throw new Error('offline'); };

  // Only the seed is readable: the fallback a fresh install with no network
  // and no opencode install relies on.
  const seedPath = writeJson(path.join(dir, 'seed-prices.json'), { _meta: { generatedAt: 'x', source: 'models.dev' }, ...marker('from-seed') });
  const seedOnly = createPriceTable({ cacheDir, opencodeCachePath, seedPath, fetchImpl });
  assert.equal(seedOnly.status().source, 'seed');
  assert.equal(seedOnly.lookup('from-seed').providerKey, 'marker-provider');
  // The seed's `_meta` header is provenance, not a provider.
  assert.equal(seedOnly.status().providerCount, 1);

  // OpenCode's copy of the same catalog beats the seed once it exists.
  writeJson(opencodeCachePath, marker('from-opencode'));
  const opencodeOnly = createPriceTable({ cacheDir, opencodeCachePath, seedPath, fetchImpl });
  assert.equal(opencodeOnly.status().source, 'opencode-cache');
  assert.equal(opencodeOnly.lookup('from-opencode').providerKey, 'marker-provider');
  assert.equal(opencodeOnly.lookup('from-seed'), null);

  // Our own downloaded cache wins over both, and meta.json supplies the
  // freshness clock instead of the file's mtime.
  const fetchedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeJson(path.join(cacheDir, 'models-dev.json'), marker('from-cache'));
  writeJson(path.join(cacheDir, 'meta.json'), { etag: 'W/"1"', fetchedAt, url: DEFAULT_REMOTE_URL });
  const cacheFirst = createPriceTable({ cacheDir, opencodeCachePath, seedPath, fetchImpl });
  assert.equal(cacheFirst.status().source, 'models.dev');
  assert.equal(cacheFirst.status().fetchedAt, fetchedAt);
  assert.equal(cacheFirst.lookup('from-cache').providerKey, 'marker-provider');
  assert.equal(cacheFirst.lookup('from-opencode'), null);
  assert.equal(cacheFirst.lookup('from-seed'), null);
});

test('a newer file on disk is picked up without a restart', () => {
  const dir = tempDir(test);
  const opencodeCachePath = path.join(dir, 'opencode-models.json');
  writeJson(opencodeCachePath, FIXTURE);
  let clock = Date.now();
  const table = createPriceTable({
    cacheDir: path.join(dir, 'cache'),
    opencodeCachePath,
    seedPath: path.join(dir, 'absent-seed.json'),
    fetchImpl: async () => { throw new Error('offline'); },
    now: () => clock,
  });
  assert.equal(table.status().source, 'opencode-cache');
  assert.equal(table.lookup('later-model'), null);

  writeJson(opencodeCachePath, {
    later: { id: 'later', name: 'Later', models: { 'later-model': model('later-model', { input: 2, output: 4 }) } },
  });
  const future = new Date(clock + 60000);
  fs.utimesSync(opencodeCachePath, future, future);

  // Within the stat throttle nothing is re-read…
  clock += 1000;
  assert.equal(table.lookup('later-model'), null);
  // …and after it the new file is.
  clock += 61000;
  assert.equal(table.lookup('later-model').providerKey, 'later');
  assert.equal(table.status().modelCount, 1);
});

// ── search ────────────────────────────────────────────────────────────────

test('search matches id or name, priced first, then cheapest', () => {
  const { table } = fixtureTable(test);
  const hits = table.search('gpt-5');
  assert.deepEqual(hits.map(hit => `${hit.providerKey}/${hit.model}`), [
    'openai/gpt-5-mini', 'azure/gpt-5', 'openai/gpt-5',
  ]);
  assert.equal(hits[0].blended, 0.6875);
  assert.equal(hits[0].priced, true);

  // The one unpriced claude entry sorts behind every priced one.
  const claude = table.search('claude');
  assert.equal(claude.length, 5);
  assert.equal(claude.at(-1).priced, false);
  assert.equal(claude.at(-1).model, 'claude-3-5-haiku-20241022');

  assert.deepEqual(table.search('CLAUDE').map(hit => hit.model), claude.map(hit => hit.model));
  assert.equal(table.search('gpt-5', { limit: 1 }).length, 1);
  assert.deepEqual(table.search(''), []);
  assert.deepEqual(table.search('nothing-matches-this'), []);
  assert.equal(Object.isFrozen(hits[0]), true);
});

// ── refresh ───────────────────────────────────────────────────────────────

test('refresh downloads, validates, writes the cache atomically and serves the new table', async () => {
  const dir = tempDir(test);
  const cacheDir = path.join(dir, 'cache');
  const catalog = remoteCatalog(60);
  const fetchImpl = fetchRecorder(() => jsonResponse(catalog, { etag: 'W/"v1"' }));
  const table = createPriceTable({
    cacheDir,
    opencodeCachePath: path.join(dir, 'absent.json'),
    seedPath: path.join(dir, 'absent-seed.json'),
    fetchImpl,
  });

  const status = await table.refresh();
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, DEFAULT_REMOTE_URL);
  assert.equal(fetchImpl.calls[0].init.headers['if-none-match'], undefined, 'nothing stored yet, so no conditional request');
  assert.ok(fetchImpl.calls[0].init.signal, 'the fetch is abortable (timeout)');

  assert.equal(status.source, 'models.dev');
  assert.equal(status.modelCount, 60);
  assert.equal(status.pricedCount, 60);
  assert.equal(status.providerCount, 1);
  assert.equal(status.lastError, null);
  assert.equal(status.refreshing, false);
  assert.equal(status.stale, false);
  assert.ok(Number.isFinite(Date.parse(status.fetchedAt)));

  // The cache file is the payload byte for byte, and the meta records the etag.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cacheDir, 'models-dev.json'), 'utf8')), catalog);
  const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, 'meta.json'), 'utf8'));
  assert.equal(meta.etag, 'W/"v1"');
  assert.equal(meta.url, DEFAULT_REMOTE_URL);
  assert.equal(meta.fetchedAt, status.fetchedAt);
  // Atomic write: the temp file was renamed away, never left behind.
  assert.deepEqual(fs.readdirSync(cacheDir).filter(name => name.includes('.tmp-')), []);

  assert.equal(table.lookup('remote-model-3').providerKey, 'test-provider');
  assert.equal(table.lookup('remote-model-3').input, 4);
  // A second lookup must not re-read or re-download anything.
  assert.equal(fetchImpl.calls.length, 1);
});

test('a 304 moves only the freshness clock, and force skips the conditional request', async () => {
  const dir = tempDir(test);
  const cacheDir = path.join(dir, 'cache');
  const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  writeJson(path.join(cacheDir, 'models-dev.json'), remoteCatalog(60));
  writeJson(path.join(cacheDir, 'meta.json'), { etag: 'W/"v1"', fetchedAt: stale, url: DEFAULT_REMOTE_URL });
  const cacheMtime = fs.statSync(path.join(cacheDir, 'models-dev.json')).mtimeMs;

  const fetchImpl = fetchRecorder((url, init) => (
    init.headers['if-none-match']
      ? jsonResponse('', { status: 304 })
      : jsonResponse(remoteCatalog(61), { etag: 'W/"v2"' })
  ));
  const table = createPriceTable({
    cacheDir,
    opencodeCachePath: path.join(dir, 'absent.json'),
    seedPath: path.join(dir, 'absent-seed.json'),
    fetchImpl,
  });

  assert.equal(table.status().stale, true, 'three days is past two refresh intervals');
  const status = await table.refresh();
  assert.equal(fetchImpl.calls[0].init.headers['if-none-match'], 'W/"v1"');
  assert.notEqual(status.fetchedAt, stale, 'the clock moved');
  assert.equal(status.modelCount, 60, 'the table is untouched');
  assert.equal(status.source, 'models.dev');
  assert.equal(status.lastError, null);
  assert.equal(status.stale, false);
  assert.equal(fs.statSync(path.join(cacheDir, 'models-dev.json')).mtimeMs, cacheMtime, 'no rewrite on 304');
  assert.equal(JSON.parse(fs.readFileSync(path.join(cacheDir, 'meta.json'), 'utf8')).etag, 'W/"v1"', 'the etag survives');

  // force: a manual refresh proves the upstream body still parses.
  const forced = await table.refresh({ force: true });
  assert.equal(fetchImpl.calls[1].init.headers['if-none-match'], undefined);
  assert.equal(forced.modelCount, 61);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cacheDir, 'meta.json'), 'utf8')).etag, 'W/"v2"');
});

test('a garbage payload is rejected and the previous table keeps serving', async () => {
  const dir = tempDir(test);
  const cacheDir = path.join(dir, 'cache');
  const payloads = [
    ['{"oops":true}', /only 0 priced model/],
    ['{"provider":{"id":"p","name":"P","models":{"m":{"id":"m","cost":{"input":"cheap"}}}}}', /only 0 priced model/],
    ['[{"id":"not-a-catalog"}]', /not a provider catalog/],
    ['<html>gateway timeout</html>', /not JSON/],
    ['', /not JSON/],
  ];
  let payload = payloads[0][0];
  const fetchImpl = fetchRecorder(() => jsonResponse(payload));
  const { table } = fixtureTable(test, { table: { cacheDir, fetchImpl } });
  const before = table.status();
  assert.equal(before.pricedCount, FIXTURE_COUNTS.priced);

  for (const [body, expected] of payloads) {
    payload = body;
    const status = await table.refresh();
    assert.match(status.lastError, expected, `payload ${JSON.stringify(body.slice(0, 24))}`);
    assert.equal(status.pricedCount, before.pricedCount, 'the working table is kept');
    assert.equal(status.source, 'opencode-cache');
    assert.equal(table.lookup('gpt-5').providerKey, 'openai', 'lookups still answer');
  }
  assert.equal(fs.existsSync(path.join(cacheDir, 'models-dev.json')), false, 'nothing was persisted');
});

test('a rejected or timed-out fetch never rejects and keeps the table', async () => {
  const dir = tempDir(test);
  const failing = createPriceTable({
    cacheDir: path.join(dir, 'cache'),
    opencodeCachePath: writeJson(path.join(dir, 'opencode-models.json'), FIXTURE),
    seedPath: path.join(dir, 'absent-seed.json'),
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:443'); },
  });
  await assert.doesNotReject(() => failing.refresh());
  const refused = failing.status();
  assert.match(refused.lastError, /ECONNREFUSED/);
  assert.equal(refused.refreshing, false);
  assert.equal(refused.pricedCount, FIXTURE_COUNTS.priced);

  // The timeout path: the injected fetch only settles when the table aborts it.
  const aborting = createPriceTable({
    cacheDir: path.join(dir, 'cache-2'),
    opencodeCachePath: writeJson(path.join(dir, 'opencode-models-2.json'), FIXTURE),
    seedPath: path.join(dir, 'absent-seed.json'),
    timeoutMs: 25,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
    }),
  });
  await assert.doesNotReject(() => aborting.refresh());
  assert.match(aborting.status().lastError, /aborted/);
  assert.ok(aborting.lookup('gpt-5'), 'still serving the local fixture');
});

test('concurrent refreshes share one in-flight download', async () => {
  const dir = tempDir(test);
  const catalog = remoteCatalog(60);
  let release = null;
  const fetchImpl = fetchRecorder(() => new Promise(resolve => {
    release = () => resolve(jsonResponse(catalog, { etag: 'W/"v1"' }));
  }));
  const table = createPriceTable({
    cacheDir: path.join(dir, 'cache'),
    opencodeCachePath: path.join(dir, 'absent.json'),
    seedPath: path.join(dir, 'absent-seed.json'),
    fetchImpl,
  });

  const first = table.refresh();
  const second = table.refresh();
  assert.equal(first, second, 'callers share the promise, not just the result');
  assert.equal(table.status().refreshing, true);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(a.pricedCount, 60);
  assert.deepEqual(b, a);

  // Coalescing is per in-flight refresh, not a permanent cache.
  release = null;
  const third = table.refresh();
  assert.equal(table.status().refreshing, true);
  release();
  await third;
  assert.equal(fetchImpl.calls.length, 2);
});

test('an unwritable cache dir still serves the downloaded catalog', async () => {
  const dir = tempDir(test);
  // A file where the cache directory should be: mkdirSync can only fail.
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'not a directory');
  const warnings = [];
  const table = createPriceTable({
    cacheDir: blocked,
    opencodeCachePath: path.join(dir, 'absent.json'),
    seedPath: path.join(dir, 'absent-seed.json'),
    fetchImpl: async () => jsonResponse(remoteCatalog(60), { etag: 'W/"v1"' }),
    logger: { warn: message => warnings.push(message) },
  });
  const status = await table.refresh();
  assert.equal(status.pricedCount, 60, 'the download is not thrown away');
  assert.equal(status.lastError, null);
  assert.equal(status.source, 'models.dev');
  assert.ok(warnings.some(message => /cache write failed/.test(message)));
  // …and the reload check must not swap it back for an older local file.
  assert.equal(table.lookup('remote-model-3').providerKey, 'test-provider');
});

test('the shipped seed prices the first-party providers offline', () => {
  const dir = tempDir(test);
  const table = createPriceTable({
    cacheDir: path.join(dir, 'cache'),
    opencodeCachePath: path.join(dir, 'absent.json'),
    seedPath: SEED_FILE,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const status = table.status();
  assert.equal(status.source, 'seed');
  assert.equal(status.providerCount, FIRST_PARTY_PROVIDERS.length, 'one provider per first-party entry, and no _meta leak');
  assert.ok(status.pricedCount >= 50, `the seed must price enough models to be useful (${status.pricedCount})`);
  assert.equal(status.modelCount, status.pricedCount, 'the generator drops unpriced models');

  const sonnet = table.lookup('claude-sonnet-4-5');
  assert.equal(sonnet.providerKey, 'anthropic');
  assert.equal(sonnet.input, 3);
  assert.equal(sonnet.output, 15);
  assert.equal(table.lookup('gpt-5').providerKey, 'openai');
  assert.equal(table.lookup('anthropic/claude-sonnet-4-5').matchedBy, 'normalized');
});

// ── routes ────────────────────────────────────────────────────────────────

test('pricing routes expose status, bulk lookup, search and refresh', async () => {
  const { table } = fixtureTable(test);
  const { app, routes } = fakeApp();
  mountPricingRoutes(app, { priceTable: table });

  const status = fakeRes();
  routes['GET /api/pricing/status']({ query: {} }, status);
  assert.equal(status.body.ok, true);
  assert.equal(status.body.status.source, 'opencode-cache');
  assert.equal(status.body.status.pricedCount, FIXTURE_COUNTS.priced);

  const lookup = fakeRes();
  routes['GET /api/pricing/lookup']({ query: { models: 'gpt-5, claude-sonnet-4-5 ,,gpt-5,nope' } }, lookup);
  assert.equal(lookup.statusCode, 200);
  assert.deepEqual(Object.keys(lookup.body.prices), ['gpt-5', 'claude-sonnet-4-5', 'nope']);
  assert.equal(lookup.body.prices['gpt-5'].providerKey, 'openai');
  assert.equal(lookup.body.prices.nope, null);
  assert.equal(lookup.body.status.source, 'opencode-cache');

  const search = fakeRes();
  routes['GET /api/pricing/search']({ query: { q: 'gpt-5', limit: '2' } }, search);
  assert.equal(search.body.count, 2);
  assert.equal(search.body.results.length, 2);
  assert.equal(search.body.query, 'gpt-5');

  const capped = fakeRes();
  routes['GET /api/pricing/search']({ query: { q: 'claude', limit: '500' } }, capped);
  assert.equal(capped.statusCode, 200, 'an oversized limit is capped, not refused');
  assert.equal(capped.body.count, 5);

  const empty = fakeRes();
  routes['GET /api/pricing/search']({ query: {} }, empty);
  assert.equal(empty.body.count, 0);
});

test('pricing routes refuse oversized or empty bulk lookups', () => {
  const { table } = fixtureTable(test);
  const { app, routes } = fakeApp();
  mountPricingRoutes(app, { priceTable: table });

  const missing = fakeRes();
  routes['GET /api/pricing/lookup']({ query: {} }, missing);
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.error, 'models_required');

  const tooMany = fakeRes();
  const ids = Array.from({ length: MAX_LOOKUP_MODELS + 1 }, (unused, index) => `model-${index}`).join(',');
  routes['GET /api/pricing/lookup']({ query: { models: ids } }, tooMany);
  assert.equal(tooMany.statusCode, 400);
  assert.equal(tooMany.body.error, 'too_many_models');

  const tooLong = fakeRes();
  routes['GET /api/pricing/lookup']({ query: { models: `${'x'.repeat(101)}` } }, tooLong);
  assert.equal(tooLong.statusCode, 400);
  assert.equal(tooLong.body.error, 'model_too_long');
});

test('pricing refresh route awaits the table and reports it, failures included', async () => {
  // A stub, not the real frozen table: the route's job is to await whatever it
  // is handed and report the outcome, including a rejection.
  const stub = {
    calls: [],
    lookupMany: () => ({}),
    status: () => ({ source: 'stub' }),
    search: () => [],
    refresh: async ({ force } = {}) => {
      stub.calls.push(Boolean(force));
      return { forced: Boolean(force) };
    },
  };
  const { app, routes } = fakeApp();
  mountPricingRoutes(app, { priceTable: stub });

  const res = fakeRes();
  await routes['POST /api/pricing/refresh']({ query: {}, body: {} }, res);
  assert.deepEqual(res.body, { ok: true, status: { forced: false } });
  const forced = fakeRes();
  await routes['POST /api/pricing/refresh']({ query: { force: '1' }, body: {} }, forced);
  assert.deepEqual(forced.body, { ok: true, status: { forced: true } });
  const bodyForce = fakeRes();
  await routes['POST /api/pricing/refresh']({ body: { force: true } }, bodyForce);
  assert.equal(bodyForce.body.status.forced, true);
  assert.deepEqual(stub.calls, [false, true, true]);

  // A broken table is a 500 with the house error envelope, not an unhandled
  // rejection (server.js is not the only user of the fallback wrapper).
  const broken = fakeApp();
  mountPricingRoutes(broken.app, { priceTable: { ...stub, refresh: () => Promise.reject(new Error('boom')) } });
  const failure = fakeRes();
  await broken.routes['POST /api/pricing/refresh']({ query: {}, body: {} }, failure);
  assert.equal(failure.statusCode, 500);
  assert.deepEqual(failure.body, { ok: false, error: 'pricing request failed' });
});

test('mountPricingRoutes requires a table and uses the injected asyncHandler', () => {
  const { table } = fixtureTable(test);
  const { app } = fakeApp();
  assert.throws(() => mountPricingRoutes(app, {}), /priceTable/);
  // A host without express route registration is a no-op, not an error.
  assert.equal(mountPricingRoutes(null, { priceTable: table }), null);

  const wrapped = [];
  const { app: second } = fakeApp();
  mountPricingRoutes(second, {
    priceTable: table,
    asyncHandler: (handler) => { wrapped.push(handler); return handler; },
  });
  assert.equal(wrapped.length, 1, 'only the awaiting route needs the wrapper');
});
