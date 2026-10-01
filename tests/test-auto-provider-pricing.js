'use strict';

// Price shaping for an Auto Provider pool whose ladder is derived from the
// shared price table instead of hand-tagged tiers. Everything here is pure and
// synchronous, and the two properties that matter are that a broken or missing
// table degrades to "price unknown" rather than to a thrown turn, and that the
// ladder a turn routes over is built from the spread of a provider's models
// rather than from its cheapest ones.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_PRICE_TIERS,
  MAX_VARIANTS,
  MAX_VARIANTS_PER_PROVIDER,
  expandCandidates,
  modelChoices,
  priceLadder,
  priceOf,
} = require('../src/chat/auto-provider-pricing');

// The shared table is an in-memory index that answers null for an id it cannot
// price; a stub keeps the lookups explicit instead of loading the real table.
function table(prices) {
  return {
    lookup(model) {
      if (!Object.hasOwn(prices, model)) return null;
      const blended = prices[model];
      return { blended, input: blended / 2, output: blended * 2, model, source: 'models.dev' };
    },
  };
}

function provider(id, models, extra = {}) {
  return { id, model: models[0] || null, modelOptions: models, ...extra };
}

function autoRoute(id, models) {
  return { providerId: id, autoModel: true, provider: provider(id, models) };
}

const TWELVE = Array.from({ length: 12 }, (_, at) => `m${at}`);
const TWELVE_PRICES = Object.fromEntries(TWELVE.map((model, at) => [model, at + 1]));

// ── priceOf ──────────────────────────────────────────────────────────────────

test('priceOf answers null for a missing, unusable or negative price', () => {
  assert.equal(priceOf(null, 'm'), null);
  assert.equal(priceOf({}, 'm'), null);
  assert.equal(priceOf({ lookup: () => null }, 'm'), null);
  assert.equal(priceOf({ lookup: () => ({ blended: -1 }) }, 'm'), null);
  assert.equal(priceOf({ lookup: () => ({ blended: 'free' }) }, 'm'), null);
  // A broken table is a question with no answer, not a lost turn.
  assert.equal(priceOf({ lookup() { throw new Error('boom'); } }, 'm'), null);
  // No model is no question at all.
  assert.equal(priceOf(table({ m: 1 }), ''), null);
  assert.equal(priceOf(table({ m: 1 }), null), null);
});

test('priceOf reports the blended price with its provenance', () => {
  assert.deepEqual(priceOf(table({ 'a/b': 3 }), 'a/b'), {
    blended: 3, input: 1.5, output: 6, matched: 'a/b', source: 'models.dev',
  });
  // A half-known entry keeps the price and drops the halves the table did not
  // publish, so a reader never sees a fabricated input/output cost.
  assert.deepEqual(priceOf({ lookup: () => ({ blended: 2, input: 'x' }) }, 'm'), {
    blended: 2, input: null, output: null, matched: null, source: null,
  });
});

// ── modelChoices ─────────────────────────────────────────────────────────────

test('modelChoices lists the default, the visible list and the alias targets once each', () => {
  assert.deepEqual(modelChoices(null), []);
  assert.deepEqual(modelChoices({}), []);
  assert.deepEqual(modelChoices({
    model: 'default-m',
    modelOptions: ['default-m', ' b-m ', '', 'has space', '~wrong-namespace', 'x'.repeat(101), 'c-m'],
    aliasMap: { a: { model: 'c-m' }, b: { model: 'alias-m' }, c: null },
  }), ['default-m', 'b-m', 'c-m', 'alias-m']);
});

// ── expandCandidates ─────────────────────────────────────────────────────────

test('a line that does not pick its model is priced exactly as it stands', () => {
  const expanded = expandCandidates([
    { providerId: 'a', model: 'm-a', priority: 1 },
    { providerId: 'b', model: 'unknown-m', priority: 2 },
  ], { priceTable: table({ 'm-a': 2 }) });
  assert.equal(expanded.length, 2);
  assert.equal(expanded[0].model, 'm-a');
  assert.equal(expanded[0].price.blended, 2);
  assert.equal(expanded[1].providerId, 'b');
  assert.equal(expanded[1].price, null);
});

test('an auto-model line expands into the provider models it can price, cheapest first', () => {
  const expanded = expandCandidates([
    autoRoute('flex', ['m-c', 'm-a', 'm-b']),
  ], { priceTable: table({ 'm-a': 1, 'm-b': 2, 'm-c': 3 }) });
  assert.deepEqual(expanded.map(candidate => candidate.model), ['m-a', 'm-b', 'm-c']);
  assert.deepEqual(expanded.map(candidate => candidate.price.blended), [1, 2, 3]);
  // Variants stay on the route they came from: a quota failure has to retire
  // every model of that route, which is why attempts are counted per provider.
  assert.deepEqual([...new Set(expanded.map(candidate => candidate.providerId))], ['flex']);
  assert.equal(expanded.every(candidate => candidate.autoModel === true), true);
});

test('a wide provider is spread over its price order, not truncated to its cheapest', () => {
  const expanded = expandCandidates([autoRoute('wide', TWELVE)], { priceTable: table(TWELVE_PRICES) });
  assert.equal(expanded.length, MAX_VARIANTS_PER_PROVIDER);
  // Evenly spaced picks always keep both ends: a ladder built from six
  // near-free models cannot answer a hard request.
  assert.deepEqual(expanded.map(candidate => candidate.model),
    ['m0', 'm2', 'm4', 'm7', 'm9', 'm11']);
});

test('a route keeps its own default model when none of the models it serves can be priced', () => {
  const expanded = expandCandidates([
    { providerId: 'opaque', model: 'opaque-default', autoModel: true, provider: provider('opaque', ['x-m', 'y-m']) },
  ], { priceTable: table({}) });
  // Dropping the line would silently retire a route the user put in the pool.
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0].model, 'opaque-default');
  assert.equal(expanded[0].price, null);
});

test('a manual ladder keeps every model the line serves, an unknown price ranked last', () => {
  const expanded = expandCandidates([
    autoRoute('flex', ['m-a', 'm-free', 'm-b']),
  ], { priceTable: table({ 'm-a': 3, 'm-b': 1 }), requirePrice: false });
  // requirePrice is price tiering's own rule (route only over what it can
  // price). A manual ladder already has its tiers and only wants the ordering,
  // so the unpriced model stays in the pool — ranked last, never dropped.
  assert.deepEqual(expanded.map(candidate => candidate.model), ['m-b', 'm-a', 'm-free']);
  assert.deepEqual(expanded.map(candidate => candidate.price && candidate.price.blended), [1, 3, null]);
});

test('the variant budget is shared by every route in the pool', () => {
  const budget = Array.from({ length: 4 }, (_, at) => autoRoute(`r${at}`, TWELVE));
  assert.equal(expandCandidates(budget, { priceTable: table(TWELVE_PRICES) }).length, MAX_VARIANTS);
  // Once the budget is spent the remaining routes keep a single best line
  // instead of the six a spread would pick — the cap trims the spread, it never
  // drops a route out of the pool.
  const over = Array.from({ length: 6 }, (_, at) => autoRoute(`r${at}`, TWELVE));
  assert.equal(expandCandidates(over, { priceTable: table(TWELVE_PRICES) }).length, MAX_VARIANTS + 2);
  // A missing table is not a special case: pricing is simply off, and the line
  // keeps the model the runtime already resolved for it.
  const line = { ...autoRoute('r0', TWELVE), model: 'm0' };
  assert.deepEqual(expandCandidates([line], {}), [{
    providerId: 'r0', autoModel: true, model: 'm0', price: null,
    provider: provider('r0', TWELVE),
  }]);
});

// ── priceLadder ──────────────────────────────────────────────────────────────

test('a ladder needs two distinct prices before it can route anything', () => {
  const flat = priceLadder([{ price: { blended: 1 } }, { price: { blended: 1 } }]);
  assert.deepEqual(flat.tiers, []);
  assert.equal(flat.tierOf({ price: { blended: 1 } }), null);
  assert.deepEqual(priceLadder([]).tiers, []);
  // Unpriced lines share the unknown price, which is one rung, not two.
  assert.deepEqual(priceLadder([{ price: null }, { price: null }]).tiers, []);
});

test('an unknown price ranks as the most expensive, never as the cheapest', () => {
  const ladder = priceLadder([{ price: { blended: 5 } }, { price: null }]);
  assert.deepEqual(ladder.tiers, ['p1', 'p2']);
  assert.equal(ladder.tierOf({ price: { blended: 5 } }), 'p1');
  assert.equal(ladder.tierOf({ price: null }), 'p2');
});

test('a small ladder keeps exactly one rung per distinct price', () => {
  const ladder = priceLadder([
    { price: { blended: 3 } }, { price: { blended: 1 } }, { price: { blended: 2 } },
  ]);
  assert.deepEqual(ladder.tiers, ['p1', 'p2', 'p3']);
  assert.equal(ladder.tierOf({ price: { blended: 1 } }), 'p1');
  assert.equal(ladder.tierOf({ price: { blended: 2 } }), 'p2');
  assert.equal(ladder.tierOf({ price: { blended: 3 } }), 'p3');
  // A line whose price is not on the ladder has no rung to stand on.
  assert.equal(ladder.tierOf({ price: { blended: 7 } }), null);
});

test('the ladder is capped at four rungs and every line lands on one of them', () => {
  const ladder = priceLadder(Array.from({ length: 6 }, (_, at) => ({ price: { blended: at + 1 } })));
  assert.equal(ladder.tiers.length, MAX_PRICE_TIERS);
  assert.deepEqual(ladder.tiers, ['p1', 'p2', 'p3', 'p4']);
  // Four rungs over six prices: the two cheapest share p1 and the two most
  // expensive share p4, so the scale stays a spread of the whole pool.
  const tierOf = blended => ladder.tierOf({ price: { blended } });
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(tierOf), ['p1', 'p1', 'p2', 'p3', 'p3', 'p4']);
});

test('a disabled line is not part of the ladder its pool routes over', () => {
  const ladder = priceLadder([
    { price: { blended: 1 } },
    { price: { blended: 9 }, enabled: false },
  ]);
  assert.deepEqual(ladder.tiers, []);
  assert.equal(ladder.tierOf({ price: { blended: 9 }, enabled: false }), null);
});
