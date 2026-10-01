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
// Everything here is pure and synchronous: the table lookup is an in-memory
// index, and a missing or broken table degrades to "price unknown", never to a
// thrown turn.

const MODEL_ID = /^[A-Za-z0-9._:/[\]-]{1,100}$/;
const MAX_VARIANTS_PER_PROVIDER = 6;
const MAX_VARIANTS = 24;
const MAX_PRICE_TIERS = 4;
const PRICE_TIER_PREFIX = 'p';

function priceOf(priceTable, model) {
  if (!priceTable || typeof priceTable.lookup !== 'function' || !model) return null;
  let entry = null;
  try { entry = priceTable.lookup(String(model)); } catch (_) { entry = null; }
  const blended = entry ? Number(entry.blended) : NaN;
  if (!Number.isFinite(blended) || blended < 0) return null;
  return Object.freeze({
    blended,
    input: Number.isFinite(Number(entry.input)) ? Number(entry.input) : null,
    output: Number.isFinite(Number(entry.output)) ? Number(entry.output) : null,
    matched: entry.model || null,
    source: entry.source || null,
  });
}

// Every model the provider says it serves: its default, its visible list and
// the models behind its tier aliases. Order is the provider's own.
function modelChoices(provider) {
  if (!provider) return [];
  const aliasModels = provider.aliasMap && typeof provider.aliasMap === 'object'
    ? Object.values(provider.aliasMap).map(entry => entry && entry.model) : [];
  const out = [];
  for (const raw of [provider.model, ...(provider.modelOptions || []), ...aliasModels]) {
    const model = raw == null ? '' : String(raw).trim();
    if (model && MODEL_ID.test(model) && !out.includes(model)) out.push(model);
  }
  return out;
}

// Keep the spread, not the cheapest: a tier ladder built from six near-free
// models cannot answer a hard request. Evenly spaced picks over the price order
// always keep both ends.
function spread(list, limit) {
  if (list.length <= limit) return list;
  const picked = [];
  for (let slot = 0; slot < limit; slot += 1) {
    const at = Math.round((slot * (list.length - 1)) / (limit - 1));
    if (!picked.includes(list[at])) picked.push(list[at]);
  }
  return picked;
}

function byPrice(left, right) {
  const a = left.price ? left.price.blended : Infinity;
  const b = right.price ? right.price.blended : Infinity;
  return a - b;
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
// stays, with an unknown price ranking last through the same byPrice order.
function expandCandidates(candidates, { priceTable = null, requirePrice = true } = {}) {
  const out = [];
  let variants = 0;
  for (const candidate of candidates) {
    if (!candidate.autoModel || !candidate.provider) {
      out.push({ ...candidate, price: priceOf(priceTable, candidate.model) });
      continue;
    }
    const choices = modelChoices(candidate.provider)
      .map(model => ({ ...candidate, model, price: priceOf(priceTable, model) }));
    const priced = requirePrice ? choices.filter(variant => variant.price) : choices;
    if (!priced.length) {
      // Nothing to choose from: keep the route itself on its default model
      // rather than dropping a line the user put in the pool.
      out.push({ ...candidate, price: priceOf(priceTable, candidate.model) });
      continue;
    }
    const room = Math.max(1, Math.min(MAX_VARIANTS_PER_PROVIDER, MAX_VARIANTS - variants));
    for (const variant of spread(priced.sort(byPrice), room)) {
      out.push(variant);
      variants += 1;
    }
  }
  return out;
}

// The ladder of one turn. Unknown prices rank as the most expensive: a line we
// cannot price is not assumed to be cheap enough for trivial work.
function priceLadder(candidates) {
  const prices = [...new Set(candidates
    .filter(candidate => candidate.enabled !== false)
    .map(candidate => (candidate.price ? candidate.price.blended : Infinity)))]
    .sort((left, right) => left - right);
  const count = Math.min(MAX_PRICE_TIERS, prices.length);
  if (count < 2) return Object.freeze({ tiers: Object.freeze([]), tierOf: () => null });
  const tiers = Object.freeze(Array.from({ length: count }, (_, at) => `${PRICE_TIER_PREFIX}${at + 1}`));
  const tierOf = (candidate) => {
    const at = prices.indexOf(candidate && candidate.price ? candidate.price.blended : Infinity);
    return at < 0 ? null : tiers[Math.floor((at * count) / prices.length)];
  };
  return Object.freeze({ tiers, tierOf });
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
