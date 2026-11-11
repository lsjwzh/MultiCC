'use strict';

// Regenerates the four Auto Provider migration fixtures under
// native/core/tests/fixtures/:
//
//   auto-provider-pricing.json
//   auto-provider-selection-key.json
//   auto-provider-routing.json
//   auto-provider-runtime.json
//
//   node scripts/generate-auto-provider-fixtures.js                 # verify all
//   node scripts/generate-auto-provider-fixtures.js --write         # rewrite all
//   node scripts/generate-auto-provider-fixtures.js --section pricing --write
//
// Expectations come from the frozen Node oracles in tests/helpers/
// (legacy-auto-provider-*.js), which are byte-for-byte copies of the current
// src/chat/auto-provider-*.js modules with only their require paths adapted.
// The Rust port reads the same files and must reproduce every value. In
// --write mode the generator additionally asserts that each oracle's output is
// JSON-identical to the live src implementation before it writes anything, so
// a fixture can never freeze behaviour the production code has already lost.
//
// Everything is hermetic: the clock is injected (fixed RUNTIME_NOW / routing
// now), no price table is loaded unless a case supplies a stub, the Jev client
// is replaced by a recording fake, and `fetch` is replaced with a trap that
// records and rejects. Proxy variables are pinned to a closed loopback port.
// Nothing in the output depends on the host, the calendar or the filesystem.

const fs = require('node:fs');
const path = require('node:path');

// The retained normalization bridge (Rust-backed) is the input side of the
// selection-key oracle: the fixture records each pool's normalized selection
// next to its key so the Rust port can replay the key derivation alone.
const { normalizeStoredProviderSelection } = require('../src/providers/auto-provider-config');

const root = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(root, 'native', 'core', 'tests', 'fixtures');
const FROZEN_DATE = '2026-11-11';
const DEAD_PROXY = 'http://127.0.0.1:9';

const SECTIONS = ['pricing', 'selectionKey', 'routing', 'runtime'];

const TARGETS = {
  pricing: 'auto-provider-pricing.json',
  selectionKey: 'auto-provider-selection-key.json',
  routing: 'auto-provider-routing.json',
  runtime: 'auto-provider-runtime.json',
};

const MODULE_PATHS = {
  src: {
    pricing: '../src/chat/auto-provider-pricing',
    selectionKey: '../src/chat/auto-provider-selection-key',
    routing: '../src/chat/auto-provider-routing',
    runtime: '../src/chat/auto-provider-runtime',
  },
  oracle: {
    pricing: '../tests/helpers/legacy-auto-provider-pricing',
    selectionKey: '../tests/helpers/legacy-auto-provider-selection-key',
    routing: '../tests/helpers/legacy-auto-provider-routing',
    runtime: '../tests/helpers/legacy-auto-provider-runtime',
  },
};

function pinLoopbackProxy() {
  const keys = [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'GLOBAL_AGENT_HTTP_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy',
  ];
  for (const key of keys) process.env[key] = DEAD_PROXY;
  process.env.NO_PROXY = '';
  process.env.no_proxy = '';
}

// Any module that reached for the network would land here instead. The trap is
// also passed as the runtime's fetchImpl so the routing/client default can
// never dial out.
function installFetchTrap() {
  const state = { calls: [] };
  const previous = globalThis.fetch;
  globalThis.fetch = function trap(url) {
    state.calls.push(String(url));
    return Promise.reject(new Error('network is disabled by the auto-provider fixture generator'));
  };
  return {
    state,
    fetch: globalThis.fetch,
    restore() { globalThis.fetch = previous; },
  };
}

function loadModules() {
  const load = paths => ({
    pricing: require(path.join(__dirname, paths.pricing)),
    selectionKey: require(path.join(__dirname, paths.selectionKey)).selectionKey,
    routing: require(path.join(__dirname, paths.routing)),
    runtime: require(path.join(__dirname, paths.runtime)),
  });
  return { src: load(MODULE_PATHS.src), oracle: load(MODULE_PATHS.oracle) };
}

// JSON-safe projection: JSON.stringify drops undefined array holes and turns
// them into null, which would erase a real (buggy) output. Every non-JSON
// value is tagged instead, and property order is preserved so key-order
// assertions survive into the fixture.
function project(value) {
  if (value === undefined) return { $undefined: true };
  if (typeof value === 'number' && !Number.isFinite(value)) return { $num: String(value) };
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(project);
  const out = {};
  for (const key of Object.keys(value)) out[key] = project(value[key]);
  return out;
}

function errorView(error) {
  return {
    error: {
      name: error && error.name || 'Error',
      code: error && error.code || null,
      message: error && error.message || String(error),
    },
  };
}

function candidateView(list) {
  return list.map(entry => {
    if (entry === undefined) return { $undefined: true };
    return {
      providerId: entry.providerId,
      model: entry.model,
      index: entry.index === undefined ? null : entry.index,
      price: entry.price ? { ...entry.price } : null,
    };
  });
}

function ladderView(ladder, candidates) {
  return {
    tiers: ladder.tiers,
    tierOf: candidates.map(candidate => ladder.tierOf(candidate)),
  };
}

// ── pricing ─────────────────────────────────────────────────────────────────

function priceTable(prices) {
  return {
    lookup(model) {
      if (!Object.hasOwn(prices, model)) return null;
      const blended = prices[model];
      if (typeof blended !== 'number') return { blended };
      return { blended, input: blended / 2, output: blended * 2, model, source: 'stub' };
    },
  };
}

function modelProvider(id, models, extra = {}) {
  return { id, model: models[0] || null, modelOptions: models, ...extra };
}

function autoCandidate(id, models, extra = {}) {
  return { providerId: id, autoModel: true, provider: modelProvider(id, models), ...extra };
}

function buildPricing(mod) {
  const cases = [];
  const add = (name, op, request, compute, extra = {}) => {
    cases.push({ name, op, request, ...extra, expect: { value: project(compute()) } });
  };

  add('priceOf: no table', 'priceOf', { priceTable: 'null', model: 'm' }, () => mod.priceOf(null, 'm'));
  add('priceOf: table without lookup', 'priceOf', { priceTable: '{}', model: 'm' }, () => mod.priceOf({}, 'm'));
  add('priceOf: lookup miss', 'priceOf', { prices: { other: 1 }, model: 'm' }, () => mod.priceOf(priceTable({ other: 1 }), 'm'));
  add('priceOf: lookup throws', 'priceOf', { lookup: 'throws', model: 'm' }, () => mod.priceOf({ lookup() { throw new Error('boom'); } }, 'm'));
  add('priceOf: negative blended', 'priceOf', { prices: { m: -1 }, model: 'm' }, () => mod.priceOf(priceTable({ m: -1 }), 'm'));
  add('priceOf: NaN blended', 'priceOf', { prices: { m: 'free' }, model: 'm' }, () => mod.priceOf(priceTable({ m: 'free' }), 'm'));
  add('priceOf: Infinity blended', 'priceOf', { prices: { m: Infinity }, model: 'm' }, () => mod.priceOf(priceTable({ m: Infinity }), 'm'));
  add('priceOf: empty model', 'priceOf', { prices: { m: 1 }, model: '' }, () => mod.priceOf(priceTable({ m: 1 }), ''));
  add('priceOf: null model', 'priceOf', { prices: { m: 1 }, model: null }, () => mod.priceOf(priceTable({ m: 1 }), null));
  add('priceOf: full entry', 'priceOf', { prices: { 'a/b': 3 }, model: 'a/b' }, () => mod.priceOf(priceTable({ 'a/b': 3 }), 'a/b'));
  add('priceOf: partial entry drops halves', 'priceOf', { entry: { blended: 2, input: 'x' }, model: 'm' }, () => mod.priceOf({ lookup: () => ({ blended: 2, input: 'x' }) }, 'm'));
  add('priceOf: numeric string blended', 'priceOf', { entry: { blended: '3' }, model: 'm' }, () => mod.priceOf({ lookup: () => ({ blended: '3' }) }, 'm'));
  add('priceOf: zero is a price', 'priceOf', { prices: { m: 0 }, model: 'm' }, () => mod.priceOf(priceTable({ m: 0 }), 'm'));

  add('modelChoices: null provider', 'modelChoices', { provider: 'null' }, () => mod.modelChoices(null));
  add('modelChoices: empty provider', 'modelChoices', { provider: '{}' }, () => mod.modelChoices({}));
  add('modelChoices: order trim dedupe regex', 'modelChoices', {
    provider: {
      model: 'default-m',
      modelOptions: ['default-m', ' b-m ', '', 'has space', '~wrong-namespace', 'x'.repeat(101), 'c-m'],
      aliasMap: { a: { model: 'c-m' }, b: { model: 'alias-m' }, c: null },
    },
  }, () => mod.modelChoices({
    model: 'default-m',
    modelOptions: ['default-m', ' b-m ', '', 'has space', '~wrong-namespace', 'x'.repeat(101), 'c-m'],
    aliasMap: { a: { model: 'c-m' }, b: { model: 'alias-m' }, c: null },
  }));
  add('modelChoices: 100-char id kept, 101 dropped', 'modelChoices', {
    provider: { model: 'x'.repeat(100), modelOptions: ['x'.repeat(101)] },
  }, () => mod.modelChoices({ model: 'x'.repeat(100), modelOptions: ['x'.repeat(101)] }));
  add('modelChoices: string modelOptions iterates code units', 'modelChoices', {
    provider: { model: null, modelOptions: 'ab' },
  }, () => mod.modelChoices({ model: null, modelOptions: 'ab' }));

  add('expandCandidates: variant cap per provider', 'expandCandidates', {
    providerModels: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10'],
    prices: { m1: 1, m2: 2, m3: 3, m4: 4, m5: 5, m6: 6, m7: 7, m8: 8, m9: 9, m10: 10 },
    requirePrice: true,
  }, () => {
    const models = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10'];
    const prices = Object.fromEntries(models.map((model, at) => [model, at + 1]));
    return candidateView(mod.expandCandidates([autoCandidate('p', models)], {
      priceTable: priceTable(prices), requirePrice: true,
    }));
  });
  add('expandCandidates: evenly spaced spread keeps both ends', 'expandCandidates', {
    providerModels: Array.from({ length: 12 }, (_, at) => `m${at}`),
    requirePrice: true,
  }, () => {
    const models = Array.from({ length: 12 }, (_, at) => `m${at}`);
    const prices = Object.fromEntries(models.map((model, at) => [model, at + 1]));
    return candidateView(mod.expandCandidates([autoCandidate('p', models)], {
      priceTable: priceTable(prices), requirePrice: true,
    }));
  });
  add('expandCandidates: requirePrice drops unpriced variants then keeps the route default', 'expandCandidates', {
    autoModels: ['m1', 'm2', 'm3'], priced: { m2: 5 }, requirePrice: true,
  }, () => {
    const prices = { m2: 5 };
    return candidateView(mod.expandCandidates([
      autoCandidate('p', ['m1', 'm2', 'm3'], { model: 'm1' }),
    ], { priceTable: priceTable(prices), requirePrice: true }));
  });
  add('expandCandidates: requirePrice=false keeps unpriced models ranked last', 'expandCandidates', {
    autoModels: ['m1', 'm2', 'm3'], priced: { m1: 5, m3: 1 }, requirePrice: false,
  }, () => {
    const prices = { m1: 5, m3: 1 };
    return candidateView(mod.expandCandidates([
      autoCandidate('p', ['m1', 'm2', 'm3']),
    ], { priceTable: priceTable(prices), requirePrice: false }));
  });
  add('expandCandidates: plain candidates pass through priced', 'expandCandidates', {
    candidates: [{ providerId: 'p', model: 'm1' }], prices: { m1: 2 }, requirePrice: true,
  }, () => candidateView(mod.expandCandidates([
    { providerId: 'p', model: 'm1' },
  ], { priceTable: priceTable({ m1: 2 }), requirePrice: true })));
  add('expandCandidates: no provider/model is left alone', 'expandCandidates', {
    candidates: [{ providerId: 'p', autoModel: true }], requirePrice: true,
  }, () => candidateView(mod.expandCandidates([
    { providerId: 'p', autoModel: true },
  ], { priceTable: priceTable({}), requirePrice: true })));

  // KNOWN BEHAVIOUR, RECORDED AS-IS: once the 24-variant budget is spent,
  // `room` becomes 1 and spread() divides by (limit - 1) = 0. Math.round(0 / 0)
  // is NaN, list[NaN] is undefined, and the undefined is pushed as a variant.
  // The output is therefore 25 entries long. Do not fix this here; the fixture
  // exists to prove the port copies today's behaviour, bug included.
  add('expandCandidates: room=1 spread bug (existing behaviour)', 'expandCandidates', {
    providerCount: 5,
    modelsPerProvider: 6,
    requirePrice: true,
  }, () => {
    const prices = {};
    const candidates = [];
    for (let provider = 0; provider < 5; provider += 1) {
      const id = `p${provider}`;
      const models = Array.from({ length: 6 }, (_, at) => `${id}-m${at}`);
      for (const [at, model] of models.entries()) prices[model] = provider * 100 + at;
      candidates.push(autoCandidate(id, models));
    }
    const expanded = mod.expandCandidates(candidates, { priceTable: priceTable(prices), requirePrice: true });
    return { length: expanded.length, variants: candidateView(expanded) };
  }, {
    notes: [
      'Existing behaviour recorded verbatim: the fifth autoModel line gets room=1',
      '(the 24-variant budget is already spent), spread() computes Math.round(0/0)',
      'and pushes undefined. The result is 25 entries with the last one undefined.',
      'This is a known latent bug; the fixture must not be "fixed" by hand.',
    ],
  });

  add('priceLadder: fewer than two distinct prices', 'priceLadder', {
    candidates: [{ price: { blended: 1 } }],
  }, () => ladderView(mod.priceLadder([
    { price: { blended: 1 } }, { price: { blended: 1 } },
  ]), [{ price: { blended: 1 } }]));
  add('priceLadder: dedupe and tierOf', 'priceLadder', {
    candidates: [{ price: { blended: 1 } }, { price: { blended: 1 } }, { price: { blended: 2 } }],
  }, () => {
    const candidates = [{ price: { blended: 1 } }, { price: { blended: 1 } }, { price: { blended: 2 } }];
    return ladderView(mod.priceLadder(candidates), candidates);
  });
  add('priceLadder: at most four tiers', 'priceLadder', {
    candidates: [{ price: { blended: 1 } }, { price: { blended: 2 } }, { price: { blended: 3 } },
      { price: { blended: 4 } }, { price: { blended: 5 } }, { price: { blended: 6 } }],
  }, () => {
    const candidates = [1, 2, 3, 4, 5, 6].map(blended => ({ price: { blended } }));
    return ladderView(mod.priceLadder(candidates), candidates);
  });
  add('priceLadder: disabled candidates are ignored', 'priceLadder', {
    candidates: [{ price: { blended: 1 } }, { price: { blended: 2 }, enabled: false }, { price: { blended: 3 } }],
  }, () => {
    const candidates = [{ price: { blended: 1 } }, { price: { blended: 2 }, enabled: false }, { price: { blended: 3 } }];
    return ladderView(mod.priceLadder(candidates), candidates);
  });
  add('priceLadder: unknown price ranks most expensive', 'priceLadder', {
    candidates: [{ price: { blended: 5 } }, {}],
  }, () => {
    const candidates = [{ price: { blended: 5 } }, {}];
    return ladderView(mod.priceLadder(candidates), candidates);
  });
  add('priceLadder: priced plus unknown gives two tiers', 'priceLadder', {
    candidates: [{ price: { blended: 2 } }, { price: null }, { price: { blended: 2 } }],
  }, () => {
    const candidates = [{ price: { blended: 2 } }, { price: null }, { price: { blended: 2 } }];
    return ladderView(mod.priceLadder(candidates), candidates);
  });
  add('priceLadder: candidate with no price maps to the unknown tier', 'priceLadder', {
    candidates: [{ price: { blended: 1 } }, {}],
  }, () => {
    const ladder = mod.priceLadder([{ price: { blended: 1 } }, {}]);
    return { tiers: ladder.tiers, tierOfNull: ladder.tierOf(null), tierOfUndefined: ladder.tierOf(undefined) };
  });
  add('exports: constants', 'exports', {}, () => ({
    MAX_PRICE_TIERS: mod.MAX_PRICE_TIERS,
    MAX_VARIANTS: mod.MAX_VARIANTS,
    MAX_VARIANTS_PER_PROVIDER: mod.MAX_VARIANTS_PER_PROVIDER,
  }));

  return {
    comment: [
      `Frozen behaviour of src/chat/auto-provider-pricing.js (${FROZEN_DATE}).`,
      'Generated by scripts/generate-auto-provider-fixtures.js from',
      'tests/helpers/legacy-auto-provider-pricing.js; every case was asserted',
      'JSON-identical against the live src module in --write mode.',
      'Pure functions only, injected price table, no clock, no network.',
    ],
    cases,
  };
}

// ── selection key ───────────────────────────────────────────────────────────

function selectionPool(extra = {}) {
  return {
    mode: 'auto',
    candidates: [{ providerId: 'a', priority: 1 }, { providerId: 'b', priority: 2 }],
    ...extra,
  };
}

function buildSelectionKey(mod) {
  const cases = [];
  // `$undefined` stands for the hole JSON cannot express; a selection can never
  // be that string (it would normalize to null anyway).
  const UNDEFINED = '$undefined';
  // Every case is a list of tagged pools plus the pairs whose keys must match.
  // Each call also records its normalized selection, so the Rust kernel can
  // replay the key derivation without the cross-module facts the JS bridge
  // assembles at load.
  const add = (name, calls, same = []) => {
    const keys = {};
    const normalized = {};
    for (const { label, input } of calls) {
      const value = input === UNDEFINED ? undefined : input;
      keys[label] = mod(value);
      const selection = normalizeStoredProviderSelection(value);
      normalized[label] = selection == null ? null : project(selection);
    }
    const equal = {};
    for (const [left, right] of same) equal[`${left}=${right}`] = keys[left] === keys[right];
    cases.push({
      name,
      op: 'selectionKey',
      calls: calls.map(call => ({
        label: call.label,
        input: call.input,
        normalized: normalized[call.label],
      })),
      same,
      expect: { keys: project(keys), equal },
    });
  };

  add('omitted defaults normalize to the same key as explicit defaults', [
    { label: 'omitted', input: selectionPool() },
    {
      label: 'explicit',
      input: selectionPool({ version: 1, preferMaxQuota: true, sticky: true, maxAttempts: 2 }),
    },
  ], [['omitted', 'explicit']]);
  const stored = selectionPool({ version: 1, protocol: 'anthropic', maxAttempts: 2, sticky: true });
  add('cloned stored selection keeps the same key', [
    { label: 'original', input: stored },
    { label: 'clone', input: JSON.parse(JSON.stringify(stored)) },
  ], [['original', 'clone']]);
  add('presetId is a display label and is ignored', [
    { label: 'left', input: selectionPool({ presetId: 'preset-a' }) },
    { label: 'right', input: selectionPool({ presetId: 'preset-b' }) },
    { label: 'withoutPreset', input: selectionPool() },
  ], [['left', 'right'], ['left', 'withoutPreset']]);
  add('preferMaxQuota change makes a different key', [
    { label: 'left', input: selectionPool() },
    { label: 'right', input: selectionPool({ preferMaxQuota: false }) },
  ]);
  // The attempt budget is the enabled pool size, so a larger maxAttempts is
  // normalized away: the stored key stays the same.
  add('maxAttempts is derived from the pool and is not part of the key', [
    { label: 'left', input: selectionPool() },
    { label: 'right', input: selectionPool({ maxAttempts: 4 }) },
  ], [['left', 'right']]);
  add('candidate order and priority are part of the key', [
    { label: 'left', input: selectionPool() },
    {
      label: 'right',
      input: { mode: 'auto', candidates: [{ providerId: 'b', priority: 1 }, { providerId: 'a', priority: 2 }] },
    },
  ]);
  add('cross-CLI candidate cli is part of the key', [
    {
      label: 'left',
      input: { mode: 'auto', candidates: [{ providerId: 'a', priority: 1, cli: 'claude' }, { providerId: 'b', priority: 2, cli: 'codex' }] },
    },
    {
      label: 'right',
      input: { mode: 'auto', candidates: [{ providerId: 'a', priority: 1, cli: 'claude' }, { providerId: 'b', priority: 2, cli: 'claude' }] },
    },
  ]);
  add('null / undefined / manual / non-object return null', [
    { label: 'nullValue', input: null },
    { label: 'undefinedValue', input: UNDEFINED },
    { label: 'manual', input: { mode: 'manual' } },
    { label: 'string', input: 'auto' },
    { label: 'array', input: [] },
  ]);
  add('invalid pools return null', [
    { label: 'oneCandidate', input: { mode: 'auto', candidates: [{ providerId: 'a', priority: 1 }] } },
    { label: 'noCandidates', input: { mode: 'auto', candidates: [] } },
    {
      label: 'duplicateProvider',
      input: { mode: 'auto', candidates: [{ providerId: 'a', priority: 1 }, { providerId: 'a', priority: 2 }] },
    },
    {
      label: 'badVersion',
      input: { version: 2, mode: 'auto', candidates: [{ providerId: 'a', priority: 1 }, { providerId: 'b', priority: 2 }] },
    },
  ]);
  add('more than eight candidates return null', [
    {
      label: 'nineCandidates',
      input: { mode: 'auto', candidates: Array.from({ length: 9 }, (_, at) => ({ providerId: `p${at}`, priority: at })) },
    },
  ]);

  return {
    comment: [
      `Frozen behaviour of src/chat/auto-provider-selection-key.js (${FROZEN_DATE}).`,
      'Normalization runs in the retained auto-provider config bridge; this file',
      'only pins which policy changes do and do not reset a session route.',
      'Each call records its normalized selection so the Rust key derivation',
      'can be replayed without the cross-module facts the JS bridge assembles.',
    ],
    cases,
  };
}

// ── routing ─────────────────────────────────────────────────────────────────

const ROUTING_NOW = 1_000_000;
const ROUTING_CATALOG = [
  { id: 'a', name: 'A', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'a-m' },
  { id: 'b', name: 'B', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'b-m' },
];

function routingProviders() {
  return {
    appTypeForCli: () => 'claude',
    appTypesForCli: () => ['claude'],
    listProviders: () => ROUTING_CATALOG,
    providerSupportsCli: (provider, cli) => provider.compatibleClis.includes(cli),
    modelValidForProvider: () => true,
  };
}

function routingSelection(extra = {}) {
  return {
    version: 1,
    mode: 'auto',
    protocol: 'anthropic',
    maxAttempts: 2,
    sticky: true,
    candidates: [
      { providerId: 'a', priority: 1, tier: 'weak' },
      { providerId: 'b', priority: 2, tier: 'strong' },
    ],
    routing: { provider: 'jev', tiers: ['weak', 'strong'] },
    ...extra,
  };
}

function routingRecorder() {
  const effects = [];
  const logger = {
    info(name, fields) { effects.push({ kind: 'info', name, fields: fields || {} }); },
    warn(name, fields) { effects.push({ kind: 'warn', name, fields: fields || {} }); },
  };
  return { effects, logger };
}

function buildRouting(mod) {
  const cases = [];
  const add = (name, op, request, compute) => {
    cases.push({ name, op, request, expect: { value: project(compute()) } });
  };

  const hashInputs = [
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['ascii', 'hello world'],
    ['chinese', '你好，世界'],
    ['emoji', '😀'],
    ['emoji twice', '😀😀'],
    ['astral music symbol', '𝄞'],
    ['mixed prose', 'hello 你好 😀 𝄞'],
    ['leading and trailing space', '  spaced  '],
  ];
  for (const [label, text] of hashInputs) {
    add(`textHash: ${label}`, 'textHash', { text: text === undefined ? 'undefined' : text }, () => ({
      hash: mod.textHash(text),
      utf16Length: String(text == null ? '' : text).length,
    }));
  }

  add('unknownTier: no routing object', 'unknownTier', { routing: null, verdict: null }, () => mod.unknownTier(null, null));
  add('unknownTier: no tiers keeps the verdict code', 'unknownTier', {
    routing: { tiers: [] }, verdict: { code: 'jev_http_500' },
  }, () => mod.unknownTier({ tiers: [] }, { code: 'jev_http_500' }));
  add('unknownTier: default strong', 'unknownTier', {
    routing: { tiers: ['weak', 'strong'] }, verdict: null,
  }, () => mod.unknownTier({ tiers: ['weak', 'strong'] }, null));
  add('unknownTier: weak', 'unknownTier', {
    routing: { tiers: ['weak', 'strong'], onUnknown: 'weak' }, verdict: null,
  }, () => mod.unknownTier({ tiers: ['weak', 'strong'], onUnknown: 'weak' }, null));
  add('unknownTier: explicit strong', 'unknownTier', {
    routing: { tiers: ['weak', 'strong'], onUnknown: 'strong' }, verdict: { code: 'jev_not_prepared' },
  }, () => mod.unknownTier({ tiers: ['weak', 'strong'], onUnknown: 'strong' }, { code: 'jev_not_prepared' }));
  add('unknownTier: priority says no tier', 'unknownTier', {
    routing: { tiers: ['weak', 'strong'], onUnknown: 'priority' }, verdict: { code: 'jev_timeout' },
  }, () => mod.unknownTier({ tiers: ['weak', 'strong'], onUnknown: 'priority' }, { code: 'jev_timeout' }));
  add('unknownTier: unknown mode falls back to strong', 'unknownTier', {
    routing: { tiers: ['weak', 'strong'], onUnknown: 'banana' }, verdict: null,
  }, () => mod.unknownTier({ tiers: ['weak', 'strong'], onUnknown: 'banana' }, null));
  add('unknownTier: one tier is both weak and strong', 'unknownTier', {
    routing: { tiers: ['only'], onUnknown: 'weak' }, verdict: null,
  }, () => mod.unknownTier({ tiers: ['only'], onUnknown: 'weak' }, null));

  const resolveRuntime = () => mod.createAutoProviderRouting({
    jev: { classify: async () => ({ ok: true, tier: 'weak' }) },
    now: () => ROUTING_NOW,
    ttlMs: 60_000,
    logger: routingRecorder().logger,
  });
  const routingStore = resolveRuntime();
  const tieredSelection = routingSelection();

  add('resolveTier: no stored routing', 'resolveTier', { selection: { candidates: [] } }, () => routingStore.resolveTier({
    selection: { candidates: [] },
  }));
  add('resolveTier: jev verdict found on the ladder', 'resolveTier', {
    selection: tieredSelection,
    verdict: { ok: true, tier: 'weak', reasonCode: 'jev_choice', escalated: false, confidence: 0.82, complexityScore: 0.2, chosenTier: 'weak', chosenProbability: 0.9, latencyMs: 7 },
  }, () => routingStore.resolveTier({
    selection: tieredSelection,
    verdict: { ok: true, tier: 'weak', reasonCode: 'jev_choice', escalated: false, confidence: 0.82, complexityScore: 0.2, chosenTier: 'weak', chosenProbability: 0.9, latencyMs: 7 },
  }));
  add('resolveTier: verdict tier outside the stored ladder still resolves by position', 'resolveTier', {
    selection: tieredSelection,
    verdict: { ok: true, tier: 'not-on-ladder', reasonCode: 'jev_choice' },
  }, () => routingStore.resolveTier({
    selection: tieredSelection,
    verdict: { ok: true, tier: 'not-on-ladder', reasonCode: 'jev_choice' },
  }));
  add('resolveTier: fallback strong with position and key order', 'resolveTier', {
    selection: tieredSelection, verdict: null,
  }, () => routingStore.resolveTier({ selection: tieredSelection, verdict: null }));
  add('resolveTier: fallback weak with position', 'resolveTier', {
    selection: routingSelection({ routing: { provider: 'jev', tiers: ['weak', 'strong'], onUnknown: 'weak' } }),
    verdict: null,
  }, () => routingStore.resolveTier({
    selection: routingSelection({ routing: { provider: 'jev', tiers: ['weak', 'strong'], onUnknown: 'weak' } }),
    verdict: null,
  }));
  add('resolveTier: fallback priority says no tier', 'resolveTier', {
    selection: routingSelection({ routing: { provider: 'jev', tiers: ['weak', 'strong'], onUnknown: 'priority' } }),
    verdict: null,
  }, () => routingStore.resolveTier({
    selection: routingSelection({ routing: { provider: 'jev', tiers: ['weak', 'strong'], onUnknown: 'priority' } }),
    verdict: null,
  }));
  add('resolveTier: failed verdict keeps its code and latency', 'resolveTier', {
    selection: tieredSelection, verdict: { ok: false, code: 'jev_http_500', latencyMs: 12 },
  }, () => routingStore.resolveTier({
    selection: tieredSelection, verdict: { ok: false, code: 'jev_http_500', latencyMs: 12 },
  }));
  add('resolveTier: zero-valued confidence and scores are kept', 'resolveTier', {
    selection: tieredSelection,
    verdict: { ok: true, tier: 'strong', confidence: 0, complexityScore: 0, chosenProbability: 0, chosenTier: '', latencyMs: 0 },
  }, () => routingStore.resolveTier({
    selection: tieredSelection,
    verdict: { ok: true, tier: 'strong', confidence: 0, complexityScore: 0, chosenProbability: 0, chosenTier: '', latencyMs: 0 },
  }));
  add('resolveTier: price pool with fewer than two tiers is unavailable', 'resolveTier', {
    selection: routingSelection({ routing: { provider: 'jev', tiering: 'price' } }),
    tiers: ['p1'],
    verdict: { ok: true, tier: 'p1', latencyMs: 3 },
  }, () => routingStore.resolveTier({
    selection: routingSelection({ routing: { provider: 'jev', tiering: 'price' } }),
    tiers: ['p1'],
    verdict: { ok: true, tier: 'p1', latencyMs: 3 },
  }));
  add('resolveTier: price pool verdict from a stale ladder is discarded', 'resolveTier', {
    selection: routingSelection({ routing: { provider: 'jev', tiering: 'price' } }),
    tiers: ['p1', 'p2'],
    verdict: { ok: true, tier: 'p3', latencyMs: 4 },
  }, () => routingStore.resolveTier({
    selection: routingSelection({ routing: { provider: 'jev', tiering: 'price' } }),
    tiers: ['p1', 'p2'],
    verdict: { ok: true, tier: 'p3', latencyMs: 4 },
  }));

  // Verdict store: one runtime per case group, fixed clock.
  const storeRuntime = options => mod.createAutoProviderRouting({
    now: () => storeRuntime.clock.value,
    ttlMs: 1_000,
    maxEntries: 8,
    logger: routingRecorder().logger,
    ...options,
  });
  storeRuntime.clock = { value: ROUTING_NOW };
  const storeCases = [];
  const addStore = (name, op, request, fn) => {
    storeCases.push({ name, op, request, expect: { value: project(fn()) } });
  };

  const storeA = storeRuntime({
    jev: { classify: async () => ({ ok: true, tier: 'weak', reasonCode: 'jev_choice' }) },
  });
  const selectionA = routingSelection();
  const providersA = routingProviders();

  // The async preparation cases are recorded through the same synchronous
  // helper after awaiting outside it, so the fixture stays plain JSON.
  const buildStore = async () => {
    storeRuntime.clock.value = ROUTING_NOW;
    const first = await storeA.prepareTurn({ session: { id: 's1', providerSelection: selectionA }, text: 'hello', providers: providersA });
    addStore('store: consume is idempotent for the same text', 'consume', { sessionId: 's1', text: 'hello' }, () => ({
      prepared: first,
      firstConsume: storeA.consume({ sessionId: 's1', text: 'hello' }),
      secondConsume: storeA.consume({ sessionId: 's1', text: 'hello' }),
      size: storeA.size(),
    }));
    addStore('store: a different text has no verdict', 'consume', { sessionId: 's1', text: 'other' }, () => ({
      other: storeA.consume({ sessionId: 's1', text: 'other' }),
      size: storeA.size(),
    }));
    addStore('store: a different session has no verdict', 'consume', { sessionId: 's2', text: 'hello' }, () => ({
      otherSession: storeA.consume({ sessionId: 's2', text: 'hello' }),
      size: storeA.size(),
    }));

    const dedupeRuntime = storeRuntime({
      jev: {
        classify: async () => {
          await Promise.resolve();
          return { ok: true, tier: 'strong', reasonCode: 'jev_choice' };
        },
      },
    });
    const dedupeSession = { id: 's-inflight', providerSelection: selectionA };
    const p1 = dedupeRuntime.prepareTurn({ session: dedupeSession, text: 'x', providers: providersA });
    const p2 = dedupeRuntime.prepareTurn({ session: dedupeSession, text: 'x', providers: providersA });
    addStore('store: an in-flight preparation is shared, not duplicated', 'prepareTurn', { sessionId: 's-inflight', text: 'x' }, () => ({
      samePromise: p1 === p2,
    }));
    await p1;
    addStore('store: the shared preparation leaves one verdict', 'consume', { sessionId: 's-inflight', text: 'x' }, () => ({
      verdict: dedupeRuntime.consume({ sessionId: 's-inflight', text: 'x' }),
      size: dedupeRuntime.size(),
    }));

    storeRuntime.clock.value = ROUTING_NOW + 1_001;
    addStore('store: TTL expiry drops the verdict', 'consume', { sessionId: 's1', text: 'hello', now: ROUTING_NOW + 1_001 }, () => ({
      expired: storeA.consume({ sessionId: 's1', text: 'hello' }),
      size: storeA.size(),
    }));

    // Oldest-first eviction: maxEntries is clamped to at least 8.
    storeRuntime.clock.value = ROUTING_NOW;
    const evictionRuntime = storeRuntime({
      jev: { classify: async () => ({ ok: true, tier: 'weak', reasonCode: 'jev_choice' }) },
    });
    for (const text of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
      await evictionRuntime.prepareTurn({ session: { id: 's-evict', providerSelection: selectionA }, text, providers: providersA });
    }
    addStore('store: maxEntries evicts the oldest verdict', 'consume', { sessionId: 's-evict', texts: ['a', 'i'] }, () => ({
      oldest: evictionRuntime.consume({ sessionId: 's-evict', text: 'a' }),
      newest: evictionRuntime.consume({ sessionId: 's-evict', text: 'i' }),
      size: evictionRuntime.size(),
    }));
    await evictionRuntime.prepareTurn({ session: { id: 's-evict', providerSelection: selectionA }, text: 'a', providers: providersA });
    await evictionRuntime.prepareTurn({ session: { id: 's-evict', providerSelection: selectionA }, text: 'j', providers: providersA });
    addStore('store: re-inserting keeps oldest-first and evicts the next oldest', 'consume', { sessionId: 's-evict', texts: ['a', 'b', 'c', 'j'] }, () => ({
      reinserted: evictionRuntime.consume({ sessionId: 's-evict', text: 'a' }),
      evicted: evictionRuntime.consume({ sessionId: 's-evict', text: 'b' }),
      alsoEvicted: evictionRuntime.consume({ sessionId: 's-evict', text: 'c' }),
      newest: evictionRuntime.consume({ sessionId: 's-evict', text: 'j' }),
      size: evictionRuntime.size(),
    }));

    const clearRuntime = storeRuntime({
      jev: { classify: async () => ({ ok: true, tier: 'weak', reasonCode: 'jev_choice' }) },
    });
    await clearRuntime.prepareTurn({ session: { id: 's-clear', providerSelection: selectionA }, text: 'bye', providers: providersA });
    addStore('store: clearSession drops that session only', 'clearSession', { sessionId: 's-clear', text: 'bye' }, () => {
      const before = { size: clearRuntime.size(), verdict: clearRuntime.consume({ sessionId: 's-clear', text: 'bye' }) };
      clearRuntime.clearSession('s-clear');
      return {
        before,
        afterSize: clearRuntime.size(),
        afterVerdict: clearRuntime.consume({ sessionId: 's-clear', text: 'bye' }),
      };
    });

    const nullRuntime = storeRuntime({
      jev: { classify: async () => ({ ok: true, tier: 'weak', reasonCode: 'jev_choice' }) },
    });
    const manual = await nullRuntime.prepareTurn({
      session: { id: 's-manual', providerSelection: { mode: 'manual' } }, text: 'x', providers: providersA,
    });
    const noRouting = await nullRuntime.prepareTurn({
      session: { id: 's-noroute', providerSelection: routingSelection({ routing: undefined }) },
      text: 'x', providers: providersA,
    });
    const emptyText = await nullRuntime.prepareTurn({
      session: { id: 's-empty', providerSelection: selectionA }, text: '   ', providers: providersA,
    });
    addStore('store: non-Auto, no routing and empty text are no-ops', 'prepareTurn', {
      cases: ['manual', 'no-routing', 'empty-text'],
    }, () => ({
      manual,
      noRouting,
      emptyText,
      size: nullRuntime.size(),
    }));

    const throwingRuntime = storeRuntime({
      jev: { classify: async () => { throw new Error('boom'); } },
    });
    const failed = await throwingRuntime.prepareTurn({
      session: { id: 's-throw', providerSelection: selectionA }, text: 'x', providers: providersA,
    });
    addStore('store: a throwing Jev client is remembered as jev_client_failed', 'consume', { sessionId: 's-throw', text: 'x' }, () => ({
      prepared: failed,
      consumed: throwingRuntime.consume({ sessionId: 's-throw', text: 'x' }),
    }));

    const recordingJev = { calls: [], classify: async args => { recordingJev.calls.push(args); return { ok: true, tier: 'weak', reasonCode: 'jev_choice', latencyMs: 5 }; } };
    const recordingRuntime = storeRuntime({ jev: recordingJev });
    await recordingRuntime.prepareTurn({
      session: { id: 's-args', providerSelection: selectionA }, text: 'hello', providers: providersA,
    });
    addStore('store: the Jev call carries the pool knobs', 'prepareTurn', { sessionId: 's-args', text: 'hello' }, () => ({
      calls: recordingJev.calls,
    }));

    const noLadderRuntime = storeRuntime({
      jev: recordingJev,
      resolveLadder: () => ['p1'],
    });
    const priceSelection = routingSelection({ routing: { provider: 'jev', tiering: 'price' } });
    const before = recordingJev.calls.length;
    const noLadder = await noLadderRuntime.prepareTurn({
      session: { id: 's-price1', providerSelection: priceSelection }, text: 'hello', providers: providersA,
    });
    addStore('store: a price pool with fewer than two tiers spends no Jev call', 'prepareTurn', {
      sessionId: 's-price1', text: 'hello', tiers: ['p1'],
    }, () => ({
      prepared: noLadder,
      newJevCalls: recordingJev.calls.length - before,
      size: noLadderRuntime.size(),
    }));
  };

  return {
    comment: [
      `Frozen behaviour of src/chat/auto-provider-routing.js (${FROZEN_DATE}).`,
      'textHash, unknownTier and resolveTier are pure; the verdict store uses an',
      'injected Jev fake, an injected clock and no network. Key order is part of',
      'the fixture because the wire consumers read these objects directly.',
    ],
    cases,
    async buildStore() {
      await buildStore();
      cases.push(...storeCases);
    },
  };
}

// ── runtime ─────────────────────────────────────────────────────────────────

const RUNTIME_NOW = 1_000_000;

const CLAUDE_CATALOG = [
  { id: 'a', name: 'A', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'a-m', modelOptions: ['a-m'] },
  { id: 'b', name: 'B', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'b-m', modelOptions: ['b-m'] },
  { id: 'c', name: 'C', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'c-m', modelOptions: ['c-m'] },
];

const LANE_CATALOG = {
  claude: [
    { id: 'claude-a', name: 'Claude A', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'claude-a-model', modelOptions: ['claude-a-model'] },
    { id: 'claude-b', name: 'Claude B', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'claude-b-model', modelOptions: ['claude-b-model'] },
  ],
  codex: [
    { id: 'codex-a', name: 'Codex A', appType: 'codex', apiFormat: 'openai_responses', compatibleClis: ['codex'], model: 'codex-a-model', modelOptions: ['codex-a-model'] },
    { id: 'codex-b', name: 'Codex B', appType: 'codex', apiFormat: 'openai_responses', compatibleClis: ['codex'], model: 'codex-b-model', modelOptions: ['codex-b-model'] },
  ],
};

function providerSet(lanes = { claude: CLAUDE_CATALOG }) {
  return {
    appTypeForCli: cli => (String(cli).startsWith('codex') ? 'codex' : 'claude'),
    appTypesForCli: cli => [String(cli).startsWith('codex') ? 'codex' : 'claude'],
    listProviders: appType => lanes[appType] || [],
    providerSupportsCli: (provider, cli) => provider.compatibleClis.includes(cli),
    modelValidForProvider: (appType, providerId, model) => (lanes[appType] || [])
      .some(provider => provider.id === providerId && (provider.model === model || provider.modelOptions.includes(model))),
  };
}

function runtimeRecorder() {
  const effects = [];
  const emit = (sessionId, event) => { effects.push({ kind: 'emit', sessionId, event }); };
  emit.lastGoodRoute = null;
  const logger = {
    info(name, fields) { effects.push({ kind: 'info', name, fields: fields || {} }); },
    warn(name, fields) { effects.push({ kind: 'warn', name, fields: fields || {} }); },
  };
  return { effects, emit, logger };
}

function exhaustFresh(limits, ids) {
  for (const id of ids) {
    limits.set(id, {
      status: 'ok', kind: 'balance', fetchedAt: RUNTIME_NOW - 1_000,
      summary: { kind: 'balance', available: false, total: 0 }, summaryText: 'out',
    });
  }
}

function turnView(turn) {
  return { enabled: turn.enabled, selection: turn.selection, routing: turn.routing };
}

function quotaDecision(category = 'billing_quota') {
  return {
    action: 'wait_reset', reason: 'quota_reset_required', delayMs: 60_000,
    error: { category, phase: 'before_first_token', partialOutput: false, sideEffects: false },
  };
}

function openAttempt(providerId) {
  return {
    providerId, replayFence: 'none', visibleOutputObserved: false,
    toolIntentObserved: false, sideEffectObserved: false,
  };
}

function unsafeAttempt(providerId, fence = 'side_effect') {
  return {
    providerId, replayFence: fence, visibleOutputObserved: false,
    toolIntentObserved: false, sideEffectObserved: fence === 'side_effect',
  };
}

function buildRuntime(mods, fetchTrap) {
  const scenarios = [];
  const step = (steps, rec, name, op, request, fn) => {
    rec.effects.length = 0;
    let value;
    try { value = fn(); } catch (error) { value = errorView(error); }
    steps.push({ name, op, request: project(request), expect: { value: project(value), effects: project(rec.effects.slice()) } });
  };
  const scenario = (name, fn) => {
    const steps = [];
    fn(steps);
    scenarios.push({ name, steps });
  };

  const linear = ({ maxAttempts = 3, background = false, quotaGuard = null, lastGoodRoute = null, limits } = {}) => {
    const limitMap = limits || new Map();
    const rec = runtimeRecorder();
    if (lastGoodRoute) rec.emit.lastGoodRoute = () => lastGoodRoute;
    const runtime = mods.runtime.createAutoProviderRuntime({
      providers: providerSet(),
      providerLimitCache: { get: (_appType, id) => limitMap.get(id) || null },
      limitCacheStaleMs: 60_000,
      now: () => RUNTIME_NOW,
      emit: rec.emit,
      logger: rec.logger,
      hasLiveBackgroundTasks: () => background,
      priceTable: null,
      fetchImpl: fetchTrap.fetch,
      ...(quotaGuard ? { quotaGuard } : {}),
    });
    const session = {
      id: 's1', cli: 'claude',
      providerSelection: {
        version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts, sticky: true,
        candidates: [
          { providerId: 'a', priority: 1 },
          { providerId: 'b', priority: 2 },
          { providerId: 'c', priority: 3 },
        ],
      },
    };
    return { runtime, session, limits: limitMap, rec };
  };

  const cross = ({ exhausted = [], cliSwitch = 'failover', background = false, routing = false, lastGoodRoute = null, disabled = null } = {}) => {
    const limits = new Map();
    exhaustFresh(limits, exhausted);
    const rec = runtimeRecorder();
    if (lastGoodRoute) rec.emit.lastGoodRoute = () => lastGoodRoute;
    const state = { disabledCli: disabled };
    const options = {
      providers: providerSet(LANE_CATALOG),
      providerLimitCache: { get: (_appType, id) => limits.get(id) || null },
      limitCacheStaleMs: 60_000,
      now: () => RUNTIME_NOW,
      emit: rec.emit,
      logger: rec.logger,
      hasLiveBackgroundTasks: () => background,
      isCliAvailable: lane => lane !== state.disabledCli,
      priceTable: null,
      fetchImpl: fetchTrap.fetch,
    };
    if (routing) {
      options.routing = mods.routing.createAutoProviderRouting({
        jev: { classify: async () => ({ ok: true, tier: 'weak', reasonCode: 'jev_choice' }) },
        now: () => RUNTIME_NOW,
        ttlMs: 60_000,
        logger: rec.logger,
      });
    }
    const runtime = mods.runtime.createAutoProviderRuntime(options);
    const candidates = [
      { providerId: 'claude-a', priority: 2, cli: 'claude' },
      { providerId: 'claude-b', priority: 3, cli: 'claude' },
      { providerId: 'codex-a', priority: 5, cli: 'codex' },
      { providerId: 'codex-b', priority: 1, cli: 'codex' },
    ];
    if (routing) {
      candidates[0].tier = 'strong';
      candidates[1].tier = 'strong';
      candidates[2].tier = 'weak';
      candidates[3].tier = 'weak';
    }
    const session = {
      id: 's-lanes', cli: 'claude',
      providerSelection: {
        version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 2, sticky: true,
        cliSwitch, candidates,
        ...(routing ? { routing: { provider: 'jev', tiers: ['weak', 'strong'] } } : {}),
      },
    };
    return { runtime, session, limits, rec, state };
  };

  // 1. initial selection skips a fresh exhausted line.
  scenario('initial skips a fresh exhausted line', steps => {
    const { runtime, session, limits, rec } = linear();
    exhaustFresh(limits, ['a']);
    let turn;
    step(steps, rec, 'beginTurn', 'beginTurn', { sessionId: 's1', turnId: 't1' }, () => {
      turn = runtime.beginTurn({ session, turnId: 't1' });
      return turnView(turn);
    });
    step(steps, rec, 'initial picks the second line', 'initial', {}, () => turn.initial());
    step(steps, rec, 'snapshot is the selected event', 'snapshot', { sessionId: 's1' }, () => runtime.snapshot('s1'));
  });

  // 2. initial selection with the whole pool spent.
  scenario('initial reports AUTO_PROVIDER_POOL_EXHAUSTED', steps => {
    const { runtime, session, limits, rec } = linear();
    exhaustFresh(limits, ['a', 'b', 'c']);
    let turn;
    step(steps, rec, 'beginTurn', 'beginTurn', { sessionId: 's1', turnId: 't1' }, () => {
      turn = runtime.beginTurn({ session, turnId: 't1' });
      return turnView(turn);
    });
    step(steps, rec, 'initial throws', 'initial', {}, () => turn.initial());
    step(steps, rec, 'snapshot is the exhausted event', 'snapshot', { sessionId: 's1' }, () => runtime.snapshot('s1'));
  });

  // 3. linear failover and a successful turn.
  scenario('failover switches once and success marks the route', steps => {
    const { runtime, session, rec } = linear();
    let turn;
    step(steps, rec, 'beginTurn', 'beginTurn', { sessionId: 's1', turnId: 't1' }, () => {
      turn = runtime.beginTurn({ session, turnId: 't1' });
      return turnView(turn);
    });
    step(steps, rec, 'initial selects a', 'initial', {}, () => turn.initial());
    step(steps, rec, 'failover selects b', 'failover', { decision: quotaDecision(), attempt: openAttempt('a') }, () => turn.failover(quotaDecision(), openAttempt('a')));
    step(steps, rec, 'recordSuccess publishes succeeded', 'recordSuccess', { attempt: openAttempt('b') }, () => turn.recordSuccess(openAttempt('b')));
    step(steps, rec, 'snapshot is the succeeded event', 'snapshot', { sessionId: 's1' }, () => runtime.snapshot('s1'));
  });

  // 4. a three-line pool runs out after every line has been tried. The
  // effective budget is the enabled pool size, so the terminal is the pool
  // exhaustion reason rather than the legacy maxAttempts number.
  scenario('failover exhausts a three-line pool', steps => {
    const { runtime, session, rec } = linear({ maxAttempts: 2 });
    let turn;
    step(steps, rec, 'beginTurn', 'beginTurn', { sessionId: 's1', turnId: 't1', maxAttempts: 2 }, () => {
      turn = runtime.beginTurn({ session, turnId: 't1' });
      return turnView(turn);
    });
    step(steps, rec, 'initial selects a', 'initial', {}, () => turn.initial());
    step(steps, rec, 'failover selects b', 'failover', { decision: quotaDecision(), attempt: openAttempt('a') }, () => turn.failover(quotaDecision(), openAttempt('a')));
    step(steps, rec, 'failover selects c', 'failover', { decision: quotaDecision(), attempt: openAttempt('b') }, () => turn.failover(quotaDecision(), openAttempt('b')));
    step(steps, rec, 'fourth failover is terminal', 'failover', { decision: quotaDecision(), attempt: openAttempt('c') }, () => turn.failover(quotaDecision(), openAttempt('c')));
  });

  // 5. the candidate pool runs out before the budget.
  scenario('failover reports candidate pool exhaustion', steps => {
    const { runtime, session, rec } = linear({ maxAttempts: 4 });
    session.providerSelection.candidates = [
      { providerId: 'a', priority: 1 },
      { providerId: 'b', priority: 2 },
    ];
    let turn;
    step(steps, rec, 'beginTurn', 'beginTurn', { sessionId: 's1', turnId: 't1', candidates: ['a', 'b'] }, () => {
      turn = runtime.beginTurn({ session, turnId: 't1' });
      return turnView(turn);
    });
    step(steps, rec, 'initial selects a', 'initial', {}, () => turn.initial());
    step(steps, rec, 'failover selects b', 'failover', { decision: quotaDecision(), attempt: openAttempt('a') }, () => turn.failover(quotaDecision(), openAttempt('a')));
    step(steps, rec, 'third failover is terminal', 'failover', { decision: quotaDecision(), attempt: openAttempt('b') }, () => turn.failover(quotaDecision(), openAttempt('b')));
  });

  // 6. live background work blocks a failover.
  scenario('live background work blocks failover', steps => {
    const { runtime, session, rec } = linear({ background: true });
    let turn;
    step(steps, rec, 'beginTurn', 'beginTurn', { sessionId: 's1', turnId: 't1', background: true }, () => {
      turn = runtime.beginTurn({ session, turnId: 't1' });
      return turnView(turn);
    });
    step(steps, rec, 'initial selects a', 'initial', {}, () => turn.initial());
    step(steps, rec, 'failover is blocked', 'failover', { decision: quotaDecision(), attempt: openAttempt('a') }, () => turn.failover(quotaDecision(), openAttempt('a')));
  });

  // 7. unsafe replay becomes a one-shot handoff with a skipped line.
  scenario('unsafe replay reserves a handoff', steps => {
    const { runtime, session, limits, rec } = linear();
    exhaustFresh(limits, ['c']);
    session.providerSelection.sticky = false;
    let turn;
    step(steps, rec, 'beginTurn', 'beginTurn', { sessionId: 's1', turnId: 't1', exhausted: ['c'], sticky: false }, () => {
      turn = runtime.beginTurn({ session, turnId: 't1' });
      return turnView(turn);
    });
    step(steps, rec, 'initial selects a and skips c', 'initial', {}, () => turn.initial());
    step(steps, rec, 'unsafe failover is blocked', 'failover', {
      decision: quotaDecision(), attempt: unsafeAttempt('a'),
    }, () => turn.failover(quotaDecision(), unsafeAttempt('a')));
    step(steps, rec, 'prepareHandoff reserves b and skips c', 'prepareHandoff', {
      decision: quotaDecision(), attempt: unsafeAttempt('a'),
    }, () => turn.prepareHandoff(quotaDecision(), unsafeAttempt('a')));
    step(steps, rec, 'snapshot is the handoff event', 'snapshot', { sessionId: 's1' }, () => runtime.snapshot('s1'));
    let handoff;
    step(steps, rec, 'the handoff turn starts on b', 'beginTurn+initial', { sessionId: 's1', turnId: 't-handoff' }, () => {
      handoff = runtime.beginTurn({ session, turnId: 't-handoff' });
      return { turn: turnView(handoff), initial: handoff.initial() };
    });
    step(steps, rec, 'the reservation is one-shot', 'beginTurn+initial', { sessionId: 's1', turnId: 't-later' }, () => {
      const later = runtime.beginTurn({ session, turnId: 't-later' });
      return { turn: turnView(later), initial: later.initial() };
    });
    step(steps, rec, 'unsafe success publishes succeeded', 'recordSuccess', { attempt: openAttempt('b') }, () => handoff.recordSuccess(openAttempt('b')));
  });

  // 8. a safe failure never prepares a handoff on a single-lane pool.
  scenario('safe failure returns no handoff', steps => {
    const { runtime, session, rec } = linear();
    let turn;
    step(steps, rec, 'beginTurn', 'beginTurn', { sessionId: 's1', turnId: 't1' }, () => {
      turn = runtime.beginTurn({ session, turnId: 't1' });
      return turnView(turn);
    });
    step(steps, rec, 'initial selects a', 'initial', {}, () => turn.initial());
    step(steps, rec, 'prepareHandoff returns null', 'prepareHandoff', {
      decision: quotaDecision(), attempt: openAttempt('a'),
    }, () => turn.prepareHandoff(quotaDecision(), openAttempt('a')));
  });

  // 9. live background work also blocks a handoff.
  scenario('live background work blocks handoff', steps => {
    const { runtime, session, rec } = linear({ background: true });
    let turn;
    step(steps, rec, 'beginTurn', 'beginTurn', { sessionId: 's1', turnId: 't1', background: true }, () => {
      turn = runtime.beginTurn({ session, turnId: 't1' });
      return turnView(turn);
    });
    step(steps, rec, 'initial selects a', 'initial', {}, () => turn.initial());
    step(steps, rec, 'prepareHandoff is blocked', 'prepareHandoff', {
      decision: quotaDecision(), attempt: unsafeAttempt('a'),
    }, () => turn.prepareHandoff(quotaDecision(), unsafeAttempt('a')));
  });

  // 10. a safe handoff escapes a lane that ran dry onto another CLI.
  scenario('handoff escapes a spent lane', steps => {
    const { runtime, session, limits, rec } = cross();
    let turn;
    step(steps, rec, 'beginTurn', 'beginTurn', { sessionId: 's-lanes', turnId: 't1' }, () => {
      turn = runtime.beginTurn({ session, turnId: 't1' });
      return turnView(turn);
    });
    step(steps, rec, 'initial selects claude-a', 'initial', {}, () => turn.initial());
    exhaustFresh(limits, ['claude-a', 'claude-b']);
    step(steps, rec, 'prepareHandoff reserves codex-b', 'prepareHandoff', {
      decision: quotaDecision(), attempt: openAttempt('claude-a'), exhaustedLocal: ['claude-a', 'claude-b'],
    }, () => turn.prepareHandoff(quotaDecision(), openAttempt('claude-a')));
    step(steps, rec, 'snapshot carries the cli field', 'snapshot', { sessionId: 's-lanes' }, () => runtime.snapshot('s-lanes'));
    step(steps, rec, 'the switched turn selects codex-b', 'beginTurn+initial', { sessionId: 's-lanes', cli: 'codex', turnId: 't2' }, () => {
      session.cli = 'codex';
      const next = runtime.beginTurn({ session, turnId: 't2' });
      return { turn: turnView(next), initial: next.initial() };
    });
  });

  // 11. once the hop budget is spent, a handoff may not escape the lane.
  scenario('hop budget blocks a cross-lane handoff', steps => {
    const { runtime, session, limits, rec } = cross({ exhausted: ['claude-a', 'claude-b'] });
    for (let hop = 0; hop < 4; hop += 1) {
      step(steps, rec, `planTurn hop ${hop + 1}`, 'planTurn', { sessionId: 's-lanes', text: 'hello', hop: hop + 1 }, () => runtime.planTurn({ session, text: 'hello' }));
    }
    // The lane recovers, so the session can run there again; the stale
    // reservation for the other lane is dropped by beginTurn while the hop
    // count stays spent.
    limits.delete('claude-a');
    limits.delete('claude-b');
    let turn;
    step(steps, rec, 'beginTurn drops the stale reservation', 'beginTurn+initial', { sessionId: 's-lanes', cli: 'claude', turnId: 't1', note: 'pending lane differs, so it is dropped; local lines recovered' }, () => {
      turn = runtime.beginTurn({ session, turnId: 't1' });
      return { turn: turnView(turn), initial: turn.initial() };
    });
    exhaustFresh(limits, ['claude-a', 'claude-b']);
    step(steps, rec, 'prepareHandoff cannot leave the lane', 'prepareHandoff', {
      decision: quotaDecision(), attempt: openAttempt('claude-a'), hops: 4, maxAttempts: 4,
    }, () => turn.prepareHandoff(quotaDecision(), openAttempt('claude-a')));
  });

  // 10. the quota guard withdraws a line before any attempt.
  scenario('quota guard withdraws a line', steps => {
    const { runtime, session, rec } = linear({
      quotaGuard: {
        check: ({ providerId }) => (providerId === 'a' ? { blocked: true, kind: 'hard_stop' } : null),
      },
    });
    let turn;
    step(steps, rec, 'beginTurn', 'beginTurn', { sessionId: 's1', turnId: 't1', quotaGuard: 'a=hard_stop' }, () => {
      turn = runtime.beginTurn({ session, turnId: 't1' });
      return turnView(turn);
    });
    step(steps, rec, 'initial selects b and skips a', 'initial', {}, () => turn.initial());
    step(steps, rec, 'snapshot carries the skipped reason', 'snapshot', { sessionId: 's1' }, () => runtime.snapshot('s1'));
  });

  // 11. retryNotBefore truth table.
  scenario('retryNotBefore truth table', steps => {
    const { runtime, limits, rec } = linear();
    const selection = {
      id: 's-r', cli: 'claude',
      providerSelection: {
        version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 2, sticky: true,
        candidates: [{ providerId: 'a', priority: 1 }, { providerId: 'b', priority: 2 }],
      },
    };
    step(steps, rec, 'non-auto pool', 'retryNotBefore', { sessionId: 's-manual', mode: 'manual' }, () => runtime.retryNotBefore({
      id: 's-manual', cli: 'claude', providerSelection: { mode: 'manual' },
    }));
    limits.clear();
    limits.set('a', { status: 'ok', kind: 'window', fetchedAt: RUNTIME_NOW, summary: { kind: 'window', usedPercentage: 50, windows: [{ usedPercent: 50, resetMs: RUNTIME_NOW + 1_000 }] } });
    step(steps, rec, 'a local line is usable', 'retryNotBefore', { sessionId: 's-r', limits: 'a=50%' }, () => runtime.retryNotBefore(selection));
    limits.clear();
    limits.set('a', {
      status: 'ok', kind: 'window', fetchedAt: RUNTIME_NOW,
      summary: {
        kind: 'window', usedPercentage: 100, resetsAtMs: RUNTIME_NOW + 5_000,
        windows: [{ usedPercent: 100, resetMs: RUNTIME_NOW + 2_000 }, { usedPercent: 100, resetMs: RUNTIME_NOW - 1_000 }],
      },
    });
    limits.set('b', { status: 'ok', kind: 'availability', fetchedAt: RUNTIME_NOW, summary: { kind: 'availability', status: 'rejected', blockedUntilMs: RUNTIME_NOW + 3_000 } });
    step(steps, rec, 'earliest future reset wins', 'retryNotBefore', { sessionId: 's-r', limits: 'a=100% reset+2000/+5000; b=blocked+3000' }, () => runtime.retryNotBefore(selection));
    limits.clear();
    limits.set('a', {
      status: 'exhausted', kind: 'availability', fetchedAt: RUNTIME_NOW,
      summary: {
        kind: 'availability', status: 'rejected', revoked: true, blockedUntilMs: RUNTIME_NOW + 2_000,
        windows: [{ usedPercent: 100, resetMs: RUNTIME_NOW + 2_000 }],
      },
    });
    limits.set('b', { status: 'exhausted', fetchedAt: RUNTIME_NOW });
    step(steps, rec, 'revoked credentials contribute nothing', 'retryNotBefore', { sessionId: 's-r', limits: 'a=revoked; b=no-summary' }, () => runtime.retryNotBefore(selection));
    limits.clear();
    limits.set('a', {
      status: 'exhausted', kind: 'window', fetchedAt: RUNTIME_NOW,
      summary: { kind: 'window', usedPercentage: 100, resetsAtMs: RUNTIME_NOW - 50, windows: [{ usedPercent: 100, resetMs: RUNTIME_NOW - 100 }] },
    });
    limits.set('b', { status: 'exhausted', fetchedAt: RUNTIME_NOW });
    step(steps, rec, 'past reset times are ignored', 'retryNotBefore', { sessionId: 's-r', limits: 'a=reset in the past' }, () => runtime.retryNotBefore(selection));
    limits.clear();
    limits.set('a', { status: 'exhausted', fetchedAt: RUNTIME_NOW });
    limits.set('b', { status: 'exhausted', fetchedAt: RUNTIME_NOW });
    step(steps, rec, 'no reset known', 'retryNotBefore', { sessionId: 's-r', limits: 'both exhausted without summary' }, () => runtime.retryNotBefore(selection));
  });

  // 12. pool memory on the same lane.
  scenario('pool memory seeds a sticky line', steps => {
    const { runtime, session, rec } = linear({ lastGoodRoute: { cli: 'claude', providerId: 'c', model: 'c-m', succeededAt: RUNTIME_NOW - 1_000 } });
    let turn;
    step(steps, rec, 'beginTurn', 'beginTurn', { sessionId: 's1', turnId: 't1', lastGoodRoute: 'c' }, () => {
      turn = runtime.beginTurn({ session, turnId: 't1' });
      return turnView(turn);
    });
    step(steps, rec, 'initial selects the remembered line', 'initial', {}, () => turn.initial());
    step(steps, rec, 'recordSuccess keeps it sticky', 'recordSuccess', { attempt: openAttempt('c') }, () => turn.recordSuccess(openAttempt('c')));
    step(steps, rec, 'the next turn starts there again', 'beginTurn+initial', { sessionId: 's1', turnId: 't2' }, () => {
      const next = runtime.beginTurn({ session, turnId: 't2' });
      return { turn: turnView(next), initial: next.initial() };
    });
  });

  // 13. pool memory on another lane seeds a planned switch.
  scenario('pool memory seeds a cross-lane move', steps => {
    const { runtime, session, rec } = cross({ lastGoodRoute: { cli: 'codex', providerId: 'codex-a', succeededAt: RUNTIME_NOW - 1_000 } });
    step(steps, rec, 'planTurn moves to the remembered lane', 'planTurn', { sessionId: 's-lanes', text: 'hello', lastGoodRoute: 'codex-a' }, () => runtime.planTurn({ session, text: 'hello' }));
    step(steps, rec, 'the switched session starts there', 'beginTurn+initial', { sessionId: 's-lanes', cli: 'codex', turnId: 't1' }, () => {
      session.cli = 'codex';
      const turn = runtime.beginTurn({ session, turnId: 't1' });
      return { turn: turnView(turn), initial: turn.initial() };
    });
    step(steps, rec, 'snapshot carries the cli field', 'snapshot', { sessionId: 's-lanes' }, () => runtime.snapshot('s-lanes'));
  });

  // 14. routing owns the lane choice, so pool memory does not seed it.
  scenario('routing disables cross-lane pool memory seeding', steps => {
    const { runtime, session, rec } = cross({
      routing: true,
      lastGoodRoute: { cli: 'codex', providerId: 'codex-a', succeededAt: RUNTIME_NOW - 1_000 },
    });
    step(steps, rec, 'planTurn stays home', 'planTurn', { sessionId: 's-lanes', text: 'hello', routing: true, lastGoodRoute: 'codex-a' }, () => runtime.planTurn({ session, text: 'hello' }));
  });

  // 15. a continuation stays on its lane while a line is usable.
  scenario('continuation stays on a usable lane', steps => {
    const { runtime, session, rec } = cross();
    step(steps, rec, 'continuation stays home', 'planTurn', { sessionId: 's-lanes', text: 'continue', turnOptions: { originContinue: true } }, () => runtime.planTurn({ session, text: 'continue', turnOptions: { originContinue: true } }));
  });

  // 16. a continuation escapes a lane whose lines are all spent.
  scenario('continuation escapes a spent lane', steps => {
    const { runtime, session, rec } = cross({ exhausted: ['claude-a', 'claude-b'] });
    step(steps, rec, 'continuation plans the other lane', 'planTurn', { sessionId: 's-lanes', text: 'continue', turnOptions: { originContinue: true }, exhausted: ['claude-a', 'claude-b'] }, () => runtime.planTurn({ session, text: 'continue', turnOptions: { originContinue: true } }));
    step(steps, rec, 'a direct user message escapes regardless', 'planTurn', { sessionId: 's-direct', text: 'continue', turnOptions: { originContinue: true, directUserInput: true }, exhausted: ['claude-a', 'claude-b'] }, () => runtime.planTurn({ session: { ...session, id: 's-direct' }, text: 'continue', turnOptions: { originContinue: true, directUserInput: true } }));
    step(steps, rec, 'the switched turn selects on the new lane', 'beginTurn+initial', { sessionId: 's-lanes', cli: 'codex', turnId: 't1' }, () => {
      session.cli = 'codex';
      const turn = runtime.beginTurn({ session, turnId: 't1' });
      return { turn: turnView(turn), initial: turn.initial() };
    });
  });

  // 17. an existing reservation is idempotent.
  scenario('pending reservation is idempotent', steps => {
    const { runtime, session, rec } = cross({ exhausted: ['claude-a', 'claude-b'] });
    let first;
    step(steps, rec, 'first planTurn', 'planTurn', { sessionId: 's-lanes', text: 'hello' }, () => {
      first = runtime.planTurn({ session, text: 'hello' });
      return first;
    });
    step(steps, rec, 'second planTurn returns the same reservation', 'planTurn', { sessionId: 's-lanes', text: 'hello' }, () => {
      const second = runtime.planTurn({ session, text: 'hello' });
      return { plan: second, same: JSON.stringify(second) === JSON.stringify(first) };
    });
  });

  // 18. a reservation whose lane disappeared is dropped.
  scenario('pending reservation for a missing lane is dropped', steps => {
    const { runtime, session, rec, state } = cross({ exhausted: ['claude-a', 'claude-b'] });
    step(steps, rec, 'planTurn reserves codex', 'planTurn', { sessionId: 's-lanes', text: 'hello' }, () => runtime.planTurn({ session, text: 'hello' }));
    state.disabledCli = 'codex';
    step(steps, rec, 'the missing lane voids the reservation', 'planTurn', { sessionId: 's-lanes', text: 'hello', disabledCli: 'codex' }, () => runtime.planTurn({ session, text: 'hello' }));
  });

  // 19. an unreachable lane is never planned.
  scenario('unreachable lane is never planned', steps => {
    const { runtime, session, rec } = cross({ exhausted: ['claude-a', 'claude-b'], disabled: 'codex' });
    step(steps, rec, 'planTurn returns null', 'planTurn', { sessionId: 's-lanes', text: 'hello', disabledCli: 'codex' }, () => runtime.planTurn({ session, text: 'hello' }));
  });

  // 20. the hop budget caps lane switches.
  scenario('hop budget caps lane switches', steps => {
    const { runtime, session, rec } = cross({ exhausted: ['claude-a', 'claude-b'] });
    for (let hop = 0; hop < 5; hop += 1) {
      step(steps, rec, `planTurn hop ${hop + 1}`, 'planTurn', { sessionId: 's-lanes', text: 'hello', hop: hop + 1 }, () => runtime.planTurn({ session, text: 'hello' }));
    }
  });

  // 21. background notifications never move the lane.
  scenario('background notifications stay on the lane', steps => {
    const { runtime, session, rec } = cross({ exhausted: ['claude-a', 'claude-b'] });
    step(steps, rec, 'bgTaskIds keeps the lane', 'planTurn', { sessionId: 's-lanes', text: 'done', turnOptions: { bgTaskIds: ['bg-1'] } }, () => runtime.planTurn({ session, text: 'done', turnOptions: { bgTaskIds: ['bg-1'] } }));
    step(steps, rec, 'bgToolUseIds keeps the lane', 'planTurn', { sessionId: 's-lanes', text: 'done', turnOptions: { bgToolUseIds: ['tool-1'] } }, () => runtime.planTurn({ session, text: 'done', turnOptions: { bgToolUseIds: ['tool-1'] } }));
  });

  // 22. restart recovery with a matching policy signature.
  scenario('restart restores a signed route', steps => {
    const rec = runtimeRecorder();
    const runtime = mods.runtime.createAutoProviderRuntime({
      providers: providerSet(),
      providerLimitCache: { get: () => null },
      limitCacheStaleMs: 60_000,
      now: () => RUNTIME_NOW,
      emit: rec.emit,
      logger: rec.logger,
      hasLiveBackgroundTasks: () => false,
      priceTable: null,
      fetchImpl: fetchTrap.fetch,
    });
    const session = {
      id: 's1', cli: 'claude',
      providerSelection: {
        version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 3, sticky: true,
        candidates: [{ providerId: 'a', priority: 1 }, { providerId: 'b', priority: 2 }, { providerId: 'c', priority: 3 }],
      },
    };
    session.autoProviderLastRoute = {
      providerId: 'b', cli: 'claude', selectionKey: mods.selectionKey(session.providerSelection),
    };
    step(steps, rec, 'initial restores b', 'beginTurn+initial', { sessionId: 's1', turnId: 't-restored', lastRoute: 'b', signed: true }, () => {
      const turn = runtime.beginTurn({ session, turnId: 't-restored' });
      return { turn: turnView(turn), initial: turn.initial() };
    });
  });

  // 23. restart recovery of a legacy unsigned route matches by model.
  scenario('restart matches a legacy route by model', steps => {
    const rec = runtimeRecorder();
    const runtime = mods.runtime.createAutoProviderRuntime({
      providers: providerSet(),
      providerLimitCache: { get: () => null },
      limitCacheStaleMs: 60_000,
      now: () => RUNTIME_NOW,
      emit: rec.emit,
      logger: rec.logger,
      hasLiveBackgroundTasks: () => false,
      priceTable: null,
      fetchImpl: fetchTrap.fetch,
    });
    const selection = {
      version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 3, sticky: true,
      candidates: [{ providerId: 'a', priority: 1 }, { providerId: 'b', priority: 2 }, { providerId: 'c', priority: 3 }],
    };
    const makeSession = (id, model) => ({
      id, cli: 'claude', providerSelection: selection,
      autoProviderLastRoute: { providerId: 'b', model, cli: 'claude' },
    });
    step(steps, rec, 'matching model restores b', 'beginTurn+initial', { sessionId: 's-match', model: 'b-m' }, () => {
      const turn = runtime.beginTurn({ session: makeSession('s-match', 'b-m'), turnId: 't-match' });
      return { turn: turnView(turn), initial: turn.initial() };
    });
    step(steps, rec, 'mismatching model falls back to priority', 'beginTurn+initial', { sessionId: 's-mismatch', model: 'removed-model' }, () => {
      const turn = runtime.beginTurn({ session: makeSession('s-mismatch', 'removed-model'), turnId: 't-mismatch' });
      return { turn: turnView(turn), initial: turn.initial() };
    });
  });

  // 24. cloning the selection keeps stickiness; a policy change resets it.
  scenario('selection clone keeps sticky, policy change resets', steps => {
    const { runtime, session, rec } = linear();
    let turn;
    step(steps, rec, 'beginTurn', 'beginTurn', { sessionId: 's1', turnId: 't1' }, () => {
      turn = runtime.beginTurn({ session, turnId: 't1' });
      return turnView(turn);
    });
    step(steps, rec, 'initial selects a', 'initial', {}, () => turn.initial());
    step(steps, rec, 'failover selects b', 'failover', { decision: quotaDecision(), attempt: openAttempt('a') }, () => turn.failover(quotaDecision(), openAttempt('a')));
    step(steps, rec, 'success makes b sticky', 'recordSuccess', { attempt: openAttempt('b') }, () => turn.recordSuccess(openAttempt('b')));
    step(steps, rec, 'a cloned selection keeps b', 'beginTurn+initial', { sessionId: 's1', turnId: 't2', selection: 'clone' }, () => {
      session.providerSelection = JSON.parse(JSON.stringify(session.providerSelection));
      const next = runtime.beginTurn({ session, turnId: 't2' });
      return { turn: turnView(next), initial: next.initial() };
    });
    step(steps, rec, 'a policy change resets to priority', 'beginTurn+initial', { sessionId: 's1', turnId: 't3', selection: 'preferMaxQuota=false' }, () => {
      session.providerSelection = { ...session.providerSelection, preferMaxQuota: false };
      const next = runtime.beginTurn({ session, turnId: 't3' });
      return { turn: turnView(next), initial: next.initial() };
    });
  });

  // 25. snapshot and clearSession.
  scenario('snapshot and clearSession', steps => {
    const { runtime, session, rec } = linear();
    let turn;
    step(steps, rec, 'beginTurn', 'beginTurn', { sessionId: 's1', turnId: 't1' }, () => {
      turn = runtime.beginTurn({ session, turnId: 't1' });
      return turnView(turn);
    });
    step(steps, rec, 'initial selects a', 'initial', {}, () => turn.initial());
    step(steps, rec, 'snapshot is set', 'snapshot', { sessionId: 's1' }, () => runtime.snapshot('s1'));
    step(steps, rec, 'clearSession empties it', 'clearSession', { sessionId: 's1' }, () => {
      runtime.clearSession('s1');
      return runtime.snapshot('s1');
    });
  });

  // 26. a price-tiered pool publishes price and priceSource.
  scenario('price-tiered event publishes price fields', steps => {
    const prices = { 'cheap-m': 1, 'pricey-m': 10 };
    const catalog = [
      { id: 'cheap', name: 'cheap', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'cheap-m', modelOptions: ['cheap-m'] },
      { id: 'pricey', name: 'pricey', appType: 'claude', apiFormat: 'anthropic', compatibleClis: ['claude'], model: 'pricey-m', modelOptions: ['pricey-m'] },
    ];
    const rec = runtimeRecorder();
    const routing = mods.routing.createAutoProviderRouting({
      jev: { classify: async () => ({ ok: true, tier: 'p1' }) },
      now: () => RUNTIME_NOW,
      ttlMs: 60_000,
      resolveLadder: ({ selection }) => (selection.routing.tiering === 'price' ? ['p1', 'p2'] : selection.routing.tiers),
      logger: rec.logger,
    });
    const runtime = mods.runtime.createAutoProviderRuntime({
      providers: providerSet({ claude: catalog }),
      routing,
      priceTable: {
        lookup: model => (Object.hasOwn(prices, model)
          ? { blended: prices[model], input: 0, output: 0, model, source: 'stub' }
          : null),
      },
      providerLimitCache: { get: () => null },
      limitCacheStaleMs: 60_000,
      now: () => RUNTIME_NOW,
      emit: rec.emit,
      logger: rec.logger,
      hasLiveBackgroundTasks: () => false,
      fetchImpl: fetchTrap.fetch,
    });
    const session = {
      id: 's-price', cli: 'claude',
      providerSelection: {
        version: 1, mode: 'auto', protocol: 'anthropic', maxAttempts: 2, sticky: false,
        candidates: [{ providerId: 'cheap', priority: 1, enabled: true }, { providerId: 'pricey', priority: 2, enabled: true }],
        routing: { provider: 'jev', tiering: 'price' },
      },
    };
    let turn;
    step(steps, rec, 'beginTurn', 'beginTurn', { sessionId: 's-price', turnId: 't1', tiering: 'price' }, () => {
      turn = runtime.beginTurn({ session, turnId: 't1' });
      return turnView(turn);
    });
    step(steps, rec, 'initial selects the fallback strong tier', 'initial', {}, () => turn.initial());
    step(steps, rec, 'snapshot carries price and priceSource', 'snapshot', { sessionId: 's-price' }, () => runtime.snapshot('s-price'));
  });

  return {
    comment: [
      `Frozen behaviour of src/chat/auto-provider-runtime.js (${FROZEN_DATE}).`,
      'Every scenario builds a pure in-memory runtime: injected providers catalog,',
      'injected limit cache, injected clock, recording emit/logger, injected Jev',
      'store and a fetch trap. Price-table pools use a stub table; every other pool',
      'passes priceTable: null so the shared table is never loaded.',
      'effects are the ordered emit/logger calls caused by the step.',
    ],
    scenarios,
  };
}

// ── build / verify / write ──────────────────────────────────────────────────

async function buildAll(modules, fetchTrap) {
  const routing = buildRouting(modules.routing);
  await routing.buildStore();
  delete routing.buildStore;
  return {
    pricing: buildPricing(modules.pricing),
    selectionKey: buildSelectionKey(modules.selectionKey),
    routing,
    runtime: buildRuntime({
      runtime: modules.runtime,
      routing: modules.routing,
      selectionKey: modules.selectionKey,
    }, fetchTrap),
  };
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function firstDifference(expected, actual) {
  const length = Math.min(expected.length, actual.length);
  let at = 0;
  while (at < length && expected[at] === actual[at]) at += 1;
  if (at === length && expected.length === actual.length) return null;
  const line = expected.slice(0, at).split('\n').length;
  const lineStart = expected.lastIndexOf('\n', at - 1) + 1;
  return {
    at,
    line,
    column: at - lineStart + 1,
    expected: JSON.stringify(expected.slice(at, at + 80)),
    actual: JSON.stringify(actual.slice(at, at + 80)),
  };
}

function countCases(section, value) {
  if (section === 'runtime') {
    return value.scenarios.reduce((total, scenario) => total + scenario.steps.length, 0);
  }
  return Array.isArray(value.cases) ? value.cases.length : 0;
}

async function main() {
  pinLoopbackProxy();
  const trap = installFetchTrap();
  const write = process.argv.includes('--write');
  const sectionArg = process.argv.find((arg, index) => arg === '--section' ? process.argv[index + 1] : arg.startsWith('--section='));
  let requested = null;
  if (sectionArg) {
    requested = sectionArg.startsWith('--section=') ? sectionArg.slice('--section='.length) : sectionArg;
    if (sectionArg === '--section') requested = process.argv[process.argv.indexOf('--section') + 1];
    if (!SECTIONS.includes(requested)) {
      console.error(`unknown section ${JSON.stringify(requested)}; expected one of ${SECTIONS.join(', ')}`);
      process.exit(2);
    }
  }
  try {
    const modules = loadModules();
    const built = await buildAll(modules.src, trap);
    const oracle = await buildAll(modules.oracle, trap);

    const selected = requested ? [requested] : SECTIONS;
    for (const section of selected) {
      // Never freeze an oracle that disagrees with the live implementation.
      const oracleText = serialize(oracle[section]);
      const srcText = serialize(built[section]);
      if (oracleText !== srcText) {
        const diff = firstDifference(oracleText, srcText);
        console.error(`oracle and src disagree for ${section}; refusing to ${write ? 'write' : 'verify'}`);
        if (diff) console.error(`  first difference at byte ${diff.at} (line ${diff.line}, column ${diff.column})\n  oracle: ${diff.expected}\n  src:    ${diff.actual}`);
        process.exit(1);
      }
      const next = srcText;
      const target = path.join(FIXTURE_DIR, TARGETS[section]);
      const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      const cases = countCases(section, built[section]);
      if (write) {
        fs.mkdirSync(FIXTURE_DIR, { recursive: true });
        if (current !== next) fs.writeFileSync(target, next);
        console.log(`${TARGETS[section]}: wrote ${cases} cases (${Buffer.byteLength(next)} bytes)`);
      } else {
        if (current !== next) {
          const diff = firstDifference(current, next);
          console.error(`${TARGETS[section]} is stale; run node scripts/generate-auto-provider-fixtures.js --write`);
          if (diff) console.error(`  first difference at byte ${diff.at} (line ${diff.line}, column ${diff.column})\n  fixture: ${diff.expected}\n  fresh:   ${diff.actual}`);
          process.exit(1);
        }
        console.log(`${TARGETS[section]}: current ${cases} cases (${Buffer.byteLength(next)} bytes)`);
      }
    }
    if (trap.state.calls.length) {
      console.error(`network trap was invoked: ${trap.state.calls.join(', ')}`);
      process.exit(1);
    }
  } finally {
    trap.restore();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  FROZEN_DATE,
  SECTIONS,
  TARGETS,
  buildAll,
  countCases,
  firstDifference,
  pinLoopbackProxy,
  serialize,
};
