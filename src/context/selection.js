'use strict';

// Context selection — memory/chunk ranking and budget clipping. The logic
// lives in native/core/src/selection.rs (terms, whole-word relevance, CJK
// bigrams, estimateTokens, UTF-16 clipping, SHA-256 dedupe and the selection
// loop). This module keeps the exact export surface and forwards.
//
// Candidate ordering stays here on purpose: `String.prototype.localeCompare`
// is an ICU/locale decision, so the same comparator the old module used runs
// before the (already ordered) candidates cross once into Rust. Non-finite
// budgets/headers are encoded as their String() form so JSON can carry them.

const { getNative } = require('../native/runtime');

const native = getNative('selection');
const TYPE_PREFIX = 'context_selection_type_error: ';

function call(fn, input) {
  try {
    return JSON.parse(fn.call(native, JSON.stringify(input)));
  } catch (error) {
    if (typeof error?.message === 'string' && error.message.startsWith(TYPE_PREFIX)) {
      throw new TypeError(error.message.slice(TYPE_PREFIX.length));
    }
    throw error;
  }
}

// `String(value || '')` keeps ±Infinity but drops NaN (falsy), so only the
// infinities need a JSON-safe spelling for text operands.
function encodeInfinity(value) {
  return value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : value;
}

// Numbers consumed through `Number(value)` keep NaN as a NaN string so Rust
// can reproduce the comparisons instead of reading a JSON null as 0.
function encodeNonFinite(value) {
  return typeof value === 'number' && !Number.isFinite(value) ? String(value) : value;
}

// `Number(undefined)` is NaN, unlike `Number(null)` which is 0, and JSON
// cannot carry the difference in an object property.
function encodeBudget(budget) {
  return budget === undefined ? 'undefined' : encodeNonFinite(budget);
}

function terms(value) {
  return call(native.contextSelectionTerms, { value: encodeInfinity(value) });
}

// ASCII terms must match a whole word: as a bare substring "ok" hits every
// "token" and "hook", which made nearly every memory chunk look relevant.
function relevance(query, text) {
  return call(native.contextSelectionRelevance, {
    query: encodeInfinity(query), text: encodeInfinity(text),
  });
}

// One shared bigram (会话, 输出 …) is not evidence that a fact is about the
// query. Longer queries must overlap proportionally before a memory is pulled in.
function minRelevance(query) {
  return call(native.contextSelectionMinRelevance, { query: encodeInfinity(query) });
}

function clipTokens(text, budget) {
  const result = call(native.contextSelectionClipTokens, {
    text: encodeInfinity(text),
    budget: encodeBudget(budget),
    textUndefined: text === undefined,
  });
  // A value that fits the budget is returned untouched; JSON spells the
  // original `undefined` as null, so restore it here.
  return result === null && text === undefined ? undefined : result;
}

// Budget includes wrappers and source labels. Omitted content is never cited.
function selectContext(candidates, options = {}) {
  const { budget = 8000, header = '', footer = '' } = options;
  const ordered = [...candidates].sort((left, right) => (right.priority || 0) - (left.priority || 0)
    || String(left.id).localeCompare(String(right.id)));
  const result = call(native.contextSelectionSelect, {
    candidates: ordered,
    budget: encodeNonFinite(budget),
    header: encodeNonFinite(header),
    footer: encodeNonFinite(footer),
  });
  if (result.budgetInfinite) {
    result.budget.limit = Infinity;
    delete result.budgetInfinite;
  }
  return result;
}

module.exports = { terms, relevance, minRelevance, clipTokens, selectContext };
