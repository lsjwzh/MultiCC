'use strict';

function exercise(api, input) {
  const calls = [];
  const prices = [null, 0, 2, NaN, Infinity, -1];
  const table = {
    lookup(model) {
      calls.push(model);
      if (input.mode === 5) throw new Error('lookup refused');
      return { blended: prices[input.mode], input: input.mode, output: Infinity, model, source: 'fixture' };
    },
  };
  const candidates = [{ providerId: 'first', model: 'a', enabled: true, autoModel: input.auto,
    provider: { model: 'a', modelOptions: ['a', 'b', 'c'] }, price: { blended: 1 } },
  { providerId: 'second', model: 'b', price: { blended: input.mode } }];
  let result;
  if (input.method === 'price') result = api.priceOf(table, input.auto ? 'a' : null);
  else if (input.method === 'expand') result = api.expandCandidates(candidates, { priceTable: table, requirePrice: input.requirePrice });
  else if (input.method === 'choices') result = api.modelChoices(candidates[0].provider);
  else {
    const ladder = api.priceLadder(candidates);
    return { tiers: ladder.tiers, mapped: candidates.map(ladder.tierOf), frozen: Object.isFrozen(ladder),
      tiersFrozen: Object.isFrozen(ladder.tiers), callback: [ladder.tierOf.name, ladder.tierOf.length], calls };
  }
  return { result, calls, frozen: result === null ? null : Object.isFrozen(result),
    itemsFrozen: Array.isArray(result) ? result.map(Object.isFrozen) : null };
}

function boundary(api, id) {
  const trace = [];
  let result;
  try {
    const table = { get lookup() { trace.push('lookup'); return function (model) {
      trace.push(['call', this === table, model]);
      const entry = { get blended() { trace.push('blended'); return id % 2 ? Infinity : 3; },
        nested: [NaN, , -Infinity], input: 1, output: 2 };
      if (id === 3) Object.defineProperty(entry, 'failure', { enumerable: true, get() { throw new Error('wire refused'); } });
      if (id === 4) throw new Error('lookup refused');
      return entry;
    }; } };
    if (id < 6) result = api.priceOf(table, { toString() { trace.push('string'); if (id === 5) throw new Error('model refused'); return 'a'; } });
    else if (id < 10) result = api.expandCandidates(id === 6 ? null : [], id === 7 ? null : id === 8 ? 3 : {});
    else if (id < 14) result = api.priceLadder(id === 10 ? null : id === 11 ? {} : []);
    else if (id === 14) result = api.expandCandidates([{ model: 'a' }], { get priceTable() { trace.push('table'); return table; }, get requirePrice() { trace.push('required'); return false; } });
    else result = api.priceOf({ lookup: () => Object.defineProperty({ blended: 1 }, '__proto__', { value: { input: 4 }, enumerable: true }) }, 'a');
    if (result && typeof result.tierOf === 'function') result = { tiers: result.tiers, value: result.tierOf(undefined) };
    return { result, trace };
  } catch (error) { return { error: { name: error.name, message: error.message }, trace }; }
}
module.exports = { exercise, boundary };
