#!/usr/bin/env node
'use strict';

// Regenerate src/pricing/seed-prices.json — the OFFLINE price table.
//
//   node scripts/generate-price-seed.js [input.json] [output.json]
//
// Input defaults to OpenCode's local copy of models.dev (~/.cache/opencode/
// models.json), which is byte-identical to https://models.dev/api.json; output
// defaults to the seed inside the package. Pass '-' as the input to read the
// catalog from stdin (handy for `curl https://models.dev/api.json | ...`).
//
// WHY a seed at all: price-table.js falls back to it when the machine has no
// network and no opencode install, and that is exactly the fresh-install case
// where an Auto route still has to choose between Anthropic/OpenAI/Google/…
// So the seed keeps only the FIRST-PARTY providers an Auto route can actually
// pick (aggregators resell the same models, they are not a lane of their own),
// only models that carry a price, and only the price/limit fields the router
// reads — which is what keeps a 5 MB catalog under ~100 KB in git.
//
// The output keeps the models.dev top-level shape (`{provider: {id, name,
// models}}`) so one loader handles both, plus a `_meta` header describing where
// it came from (price-table.js skips every '_'-prefixed top-level key).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FIRST_PARTY_PROVIDERS } = require('../src/pricing/price-table');

const DEFAULT_INPUT = path.join(os.homedir(), '.cache', 'opencode', 'models.json');
const DEFAULT_OUTPUT = path.join(__dirname, '..', 'src', 'pricing', 'seed-prices.json');

// Wire spellings ('cache_read') are kept as-is: the seed is a models.dev file
// as far as every reader is concerned, and renaming fields here would make the
// two sources differ in exactly the place nobody looks.
const COST_FIELDS = ['input', 'output', 'cache_read', 'cache_write'];
const LIMIT_FIELDS = ['context', 'output'];

function readCatalog(inputPath) {
  if (inputPath === '-') return JSON.parse(fs.readFileSync(0, 'utf8'));
  return JSON.parse(fs.readFileSync(inputPath, 'utf8'));
}

// Copy only the fields that are present and finite, so an absent cache_read
// stays absent (a 0 would claim the provider charges nothing to cache).
function pickNumbers(source, fields) {
  const out = {};
  for (const field of fields) {
    const value = source ? Number(source[field]) : NaN;
    if (Number.isFinite(value) && value >= 0) out[field] = value;
  }
  return out;
}

function buildSeed(catalog, generatedAt) {
  const seed = { _meta: { generatedAt, source: 'models.dev' } };
  for (const providerKey of FIRST_PARTY_PROVIDERS) {
    const provider = catalog && catalog[providerKey];
    if (!provider || typeof provider !== 'object') continue;
    const models = provider.models && typeof provider.models === 'object' ? provider.models : {};
    const kept = {};
    for (const [modelId, model] of Object.entries(models)) {
      if (!model || typeof model !== 'object') continue;
      const cost = pickNumbers(model.cost, COST_FIELDS);
      if (!('input' in cost) && !('output' in cost)) continue; // unpriced: nothing to compare
      kept[modelId] = {
        id: typeof model.id === 'string' && model.id ? model.id : modelId,
        name: typeof model.name === 'string' && model.name ? model.name : modelId,
        cost,
        limit: pickNumbers(model.limit, LIMIT_FIELDS),
      };
    }
    if (!Object.keys(kept).length) continue;
    seed[providerKey] = {
      id: typeof provider.id === 'string' && provider.id ? provider.id : providerKey,
      name: typeof provider.name === 'string' && provider.name ? provider.name : providerKey,
      models: kept,
    };
  }
  return seed;
}

function main() {
  const inputPath = process.argv[2] || DEFAULT_INPUT;
  const outputPath = process.argv[3] || DEFAULT_OUTPUT;
  const catalog = readCatalog(inputPath);
  const seed = buildSeed(catalog, new Date().toISOString());
  const providerCount = Object.keys(seed).length - 1; // minus _meta
  const modelCount = providerCount
    ? Object.values(seed).reduce((total, provider) => (
      provider && provider.models ? total + Object.keys(provider.models).length : total), 0)
    : 0;
  if (!modelCount) throw new Error(`no priced first-party models found in ${inputPath}`);

  // One line per model keeps a regenerated seed reviewable as a diff; the
  // numbers are identical to JSON.stringify(seed, null, 2).
  const json = JSON.stringify(seed, null, 1);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${json}\n`);
  const bytes = Buffer.byteLength(json);
  process.stdout.write(`price seed: ${providerCount} provider(s), ${modelCount} priced model(s), `
    + `${bytes} bytes -> ${outputPath}\n`);
}

if (require.main === module) main();

module.exports = { buildSeed, DEFAULT_INPUT, DEFAULT_OUTPUT };
