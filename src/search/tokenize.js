'use strict';

// The one tokenizer both search paths share.
//
// The task board ranks in memory with BM25 (src/task-board/search.js); the message
// index stores postings in SQLite (src/search/index-store.js). A query must mean
// the same thing whichever corpus answers it, so the split lives here once and
// both import it — two copies would drift the first time either is tuned.
//
// The scheme is bigram + latin-run:
//   - A latin/digit run stays whole (`air.js`, `provider-router`, `3.53.2`), which
//     is why the FTS5 side declares the matching `tokenchars '_-.$+'`.
//   - A CJK run contributes every overlapping bigram, so the 2-character words
//     that dominate Chinese queries are exact terms. Measured against the real
//     corpus: a trigram tokenizer cannot see them at all — it needs three
//     characters before it emits a token, so "检索"/"缓存"/"任务" matched zero of
//     the rows that LIKE found. See the fts5 tokenizer benchmark notes.
//   - Each CJK character also contributes a half-weight unigram, which lets one
//     character still move an in-memory score. The FTS5 index deliberately does
//     not store unigrams: they inflate the index for terms a one-character query
//     can reach with a LIKE scan instead (measured at ~19ms over 21k chunks).
//
// `tokenize` is the ranking view: term → accumulated weight, capped per field.
// `indexTokens` is the index view: strong terms only, in first-seen order.

// CJK Unified Ideographs (+ Ext A, compat), kana, hangul syllables. Ranges written
// as escapes so the source stays plain ASCII.
const CJK_RUN_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+/g;
const CJK_CHAR_RE = /^[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]$/;
// A run must start with a letter/digit and be at least 2 characters, so a lone
// "a" is not a term while "air.js" is one — punctuation stays inside the run.
const LATIN_RE = /[a-z0-9][a-z0-9+._-]+/g;

const MAX_TERMS_PER_FIELD = 8000;
const MAX_TF = 32;
const UNIGRAM_WEIGHT = 0.5;
// Bound on the tokens a MATCH expression may carry: every one is a quoted phrase
// ANDed with the rest, and FTS5 rejects expressions past its depth limit.
const MAX_MATCH_TERMS = 24;

function normalizeText(value) {
  return String(value == null ? '' : value).normalize('NFKC').toLowerCase();
}

// Yields (term, weight) per occurrence, in tokenize's insertion order: latin runs
// first, then each CJK run's bigrams, then its unigrams. Both views below are
// built from this one walk so they cannot disagree about what a term is.
function forEachTerm(text, visit) {
  const normalized = normalizeText(text);
  for (const match of normalized.match(LATIN_RE) || []) visit(match, 1);
  for (const run of normalized.match(CJK_RUN_RE) || []) {
    for (let index = 0; index + 1 < run.length; index += 1) visit(run.slice(index, index + 2), 1);
    for (const char of run) visit(char, UNIGRAM_WEIGHT);
  }
}

// term → occurrences in `text`, weighted and capped.
function tokenize(text) {
  const counts = new Map();
  const add = (term, weight = 1) => {
    if (counts.size >= MAX_TERMS_PER_FIELD && !counts.has(term)) return;
    counts.set(term, Math.min(MAX_TF, (Number(counts.get(term)) || 0) + weight));
  };
  forEachTerm(text, add);
  return counts;
}

// The terms worth storing in an inverted index: full-weight terms only, deduped,
// in first-seen order. A unigram is excluded by *kind*, not by its accumulated
// weight — character "的" seen twice scores 1.0 and still must not become a term.
function indexTokens(text) {
  const seen = new Set();
  const terms = [];
  forEachTerm(text, (term, weight) => {
    if (weight < 1 || seen.has(term)) return;
    seen.add(term);
    terms.push(term);
  });
  return terms;
}

function quoteToken(term) {
  return `"${String(term).replace(/"/g, '""')}"`;
}

// FTS5 MATCH expression for `text`, or null when the text carries no indexable
// term (all single characters, all punctuation) — the caller falls back to LIKE.
//
// Tokens are ORed, not ANDed, to match how the board has always ranked: it accepts
// a document that holds only some of the query's words and orders by how much of
// the query it covers. AND here would zero out exactly the queries people actually
// paste — a full sentence carries a dozen bigrams and no chunk contains them all.
// bm25 already rewards the chunks that cover more terms, and its IDF keeps a match
// on one common bigram from outranking a match on the rare ones.
//
// Every token is quoted, and that is not cosmetic: bare, FTS5 reads `air.js` as a
// syntax error and `provider-router` as `provider NOT router`, i.e. the opposite
// of the query. Verified both ways on this SQLite build.
function matchExpression(text) {
  const terms = indexTokens(String(text == null ? '' : text).slice(0, 400));
  if (!terms.length) return null;
  return terms.slice(0, MAX_MATCH_TERMS).map(quoteToken).join(' OR ');
}

module.exports = {
  CJK_CHAR_RE,
  CJK_RUN_RE,
  LATIN_RE,
  MAX_MATCH_TERMS,
  MAX_TERMS_PER_FIELD,
  MAX_TF,
  UNIGRAM_WEIGHT,
  forEachTerm,
  indexTokens,
  matchExpression,
  normalizeText,
  quoteToken,
  tokenize,
};
