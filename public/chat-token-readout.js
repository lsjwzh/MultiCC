'use strict';

// Turns one assistant turn's usage block into the numbers the context bar shows.
//
// Claude-family CLIs report usage for a single API request, so input + cache
// reads + cache writes is exactly what sat in the context window. Codex reports
// running counters instead: MultiCC diffs them per turn, but the diff still SUMS
// every API request the turn made, so its cache-read bucket counts the same
// resident prefix once per request. Adding those buckets up produced readouts
// like "本轮 14829.9k/1000k (100.0%)" for a turn whose real context was ~0.5M.
//
// No single request can exceed the model's context window, so a block whose
// total lands above the window is provably an aggregate. That is the signal this
// module keys off — it needs no CLI name, and it cannot fire for a well-formed
// single-request block, so every other CLI keeps its existing readout.
(function attachChatTokenReadout(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MultiCCChatTokenReadout = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  function count(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  const EMPTY = Object.freeze({
    input: 0,
    output: 0,
    total: 0,
    billed: 0,
    aggregated: false,
    withinWindow: true,
  });

  /**
   * @param {object|null} usage  one assistant turn's usage block
   * @param {number} contextWindow  the model's context window, 0/undefined if unknown
   * @returns {{input:number,output:number,total:number,billed:number,
   *            aggregated:boolean,withinWindow:boolean}}
   *   `total` drives the percentage. `aggregated` marks a turn whose counters
   *   sum several requests, so the caller can label the readout as an estimate
   *   instead of presenting it as measured context occupancy.
   */
  function turnContext(usage, contextWindow) {
    if (!usage || typeof usage !== 'object') return EMPTY;
    const fresh = count(usage.input_tokens);
    const output = count(usage.output_tokens);
    const resident = fresh
      + count(usage.cache_read_input_tokens)
      + count(usage.cache_creation_input_tokens);
    const billed = resident + output;
    const window = count(contextWindow);
    if (!window || billed <= window) {
      return Object.freeze({
        input: resident,
        output,
        total: billed,
        billed,
        aggregated: false,
        withinWindow: true,
      });
    }
    // Drop the cache buckets: they are the part that repeats across requests.
    // Fresh input and output are each counted once per request, so their sum is
    // an upper bound on the turn's context rather than a multiple of it.
    const total = fresh + output;
    return Object.freeze({
      input: fresh,
      output,
      total,
      billed,
      aggregated: true,
      withinWindow: total <= window,
    });
  }

  return Object.freeze({ turnContext });
});
