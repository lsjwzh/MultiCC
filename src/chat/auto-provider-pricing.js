'use strict';

// ── Auto Provider price shaping ─────────────────────────────────────────────
//
// A price-tiered pool (routing.tiering === 'price') does not carry a
// hand-tagged ladder. Each turn the runtime:
//
//   1. prices every candidate through the shared price table
//      (src/pricing/price-table.js — models.dev, refreshed in the background);
//   2. expands `autoModel` candidates into one line per model the provider
//      serves, so Jev's verdict can pick the model and not only the provider;
//   3. ranks the distinct prices into at most four tiers, cheapest first, and
//      hands that ladder to Jev exactly like a manual one.
//
// Every decision above — which models are worth pricing, the spread, the
// variant caps, the price order, the tier names, `tierOf` — lives in
// `native/core/src/auto_provider_pricing.rs` and is frozen by
// `native/core/tests/fixtures/auto-provider-pricing.json`. This file owns only
// what cannot move: the table itself is a live in-memory index owned by
// JavaScript, and only JavaScript can call it. Node is frozen — no shaping
// decision may return here.
//
// The one gap the bridge cannot carry is a non-finite number: JSON has no
// `NaN` or `Infinity`, so `wire` spells them out and the kernel's `Number()`
// reads the same value back. A broken table therefore still prices as unknown
// instead of silently becoming free.

const { getNative } = require('../native/runtime');

const DEFAULTS = JSON.parse(getNative().autoProviderPricingDefaults());
const MAX_PRICE_TIERS = DEFAULTS.maxPriceTiers;
const MAX_VARIANTS = DEFAULTS.maxVariants;
const MAX_VARIANTS_PER_PROVIDER = DEFAULTS.maxVariantsPerProvider;

// JSON-safe spelling of a table entry: non-finite numbers become "NaN" /
// "Infinity" / "-Infinity", which `Number(...)` maps back exactly.
function wire(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(wire);
  const out = {};
  for (const key of Object.keys(value)) out[key] = wire(value[key]);
  return out;
}

// A broken table is a question with no answer, not a lost turn.
function lookup(priceTable, model) {
  try { return priceTable.lookup(String(model)); } catch (_) { return null; }
}

function priceOf(priceTable, model) {
  if (!priceTable || typeof priceTable.lookup !== 'function' || !model) return null;
  const answer = JSON.parse(getNative().autoProviderPriceOf(wire(lookup(priceTable, model)) ?? null));
  return answer == null ? null : Object.freeze(answer);
}

// Every model the provider says it serves: its default, its visible list and
// the models behind its tier aliases. Order is the provider's own.
function modelChoices(provider) {
  return JSON.parse(getNative().autoProviderModelChoices(provider ?? null));
}

// Candidates in, priced (and, for autoModel lines, expanded) candidates out.
// Variants keep the candidate's providerId and index: attempts are still
// counted per route, so a quota failure retires every model of that route.
//
// `requirePrice` is the difference between the two ladders. A price-tiered pool
// can only route over models it can price, so an unpriceable variant is dropped
// (and a route with none keeps its own default model). A manual pool already has
// its ladder — the hand-tagged tiers — and only wants the variants so the
// cheapest one inside a tier goes first; there every model the provider serves
// stays, with an unknown price ranking last.
function expandCandidates(candidates, { priceTable = null, requirePrice = true } = {}) {
  // The pool is an array by contract; anything else is a programming error.
  if (!Array.isArray(candidates)) throw new TypeError('candidates is not iterable');
  const native = getNative();
  // The kernel says which models it is about to price; this side does the
  // lookups. One list, so the two halves can never disagree.
  const models = JSON.parse(native.autoProviderPricingModels(candidates));
  const entries = {};
  if (priceTable && typeof priceTable.lookup === 'function') {
    for (const model of models) {
      const entry = lookup(priceTable, model);
      if (entry) entries[model] = wire(entry);
    }
  }
  const expanded = JSON.parse(native.autoProviderExpandCandidates({ candidates, entries, requirePrice }));
  // A `room == 1` spread leaves an `undefined` slot; the JSON bridge spells it
  // `null`, and the caller has always seen `undefined` there.
  return expanded.map(item => (item === null ? undefined : Object.freeze(item)));
}

// The ladder of one turn. Unknown prices rank as the most expensive: a line we
// cannot price is not assumed to be cheap enough for trivial work.
function priceLadder(candidates) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates is not iterable');
  const ladder = new (getNative().RustPriceLadder)(candidates);
  const tiers = Object.freeze(ladder.tiers);
  return Object.freeze({ tiers, tierOf: candidate => ladder.tierOf(candidate ?? null) });
}

module.exports = {
  MAX_PRICE_TIERS,
  MAX_VARIANTS,
  MAX_VARIANTS_PER_PROVIDER,
  expandCandidates,
  modelChoices,
  priceLadder,
  priceOf,
};
