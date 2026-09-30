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

// How many bigrams a CJK run may hold and still be required as a phrase. A run of
// up to 4 characters is a word or a short term — the shape most queries have — and
// requiring all of its bigrams means "the chunk contains this term", which is what
// the person typing it means. Past that a run is a clause or a whole sentence, and
// requiring every bigram would demand the sentence appear verbatim: measured on the
// real corpus, 任务关联与搜索支持全文检索 and 怎么让新任务的关联加上全文搜索 both drop to
// 0 hits under a full AND, while 全文检索 254→13 and 任务关联 6013→43 keep only the
// chunks that genuinely contain the term. Set to Infinity to AND every run.
const MAX_PHRASE_BIGRAMS = 3;

// The query as groups of terms that must co-occur: each group is ORed with the
// others, and inside a group every term must be present. One group per latin word
// (a word is already one token) and one per CJK run, whose bigrams are required
// together when the run is short enough to be a term and ORed as a bag of words
// when it is longer (see MAX_PHRASE_BIGRAMS).
function matchGroups(text) {
  const normalized = normalizeText(String(text == null ? '' : text).slice(0, 400));
  const groups = [];
  for (const match of normalized.match(LATIN_RE) || []) groups.push([match]);
  for (const run of normalized.match(CJK_RUN_RE) || []) {
    const bigrams = [];
    for (let index = 0; index + 1 < run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (!bigrams.includes(bigram)) bigrams.push(bigram);
    }
    if (!bigrams.length) continue;
    if (bigrams.length <= MAX_PHRASE_BIGRAMS) groups.push(bigrams);
    else for (const bigram of bigrams) groups.push([bigram]);
  }
  return groups;
}

// FTS5 MATCH expression for `text`, or null when the text carries no indexable
// term (all single characters, all punctuation) — the caller falls back to LIKE.
//
// The shape is `(a AND b) OR (c)`: a term-shaped CJK run is required whole, and
// separate words are alternatives. Pure OR is what the board has always done, and
// it answers a sentence well (bm25 rewards the chunks covering more of it) but
// answers a two-character term with everything that shares one of its bigrams —
// measured 254 chunks for 全文检索 where only 13 contain it.
//
// Every token is quoted, and that is not cosmetic: bare, FTS5 reads `air.js` as a
// syntax error and `provider-router` as `provider NOT router`, i.e. the opposite
// of the query. Verified both ways on this SQLite build.
function matchExpression(text) {
  const groups = matchGroups(text);
  if (!groups.length) return null;
  const terms = [];
  const parts = [];
  for (const group of groups) {
    if (terms.length >= MAX_MATCH_TERMS) break;
    const kept = group.slice(0, MAX_MATCH_TERMS - terms.length);
    terms.push(...kept);
    parts.push(kept.length === 1 ? quoteToken(kept[0]) : `(${kept.map(quoteToken).join(' AND ')})`);
  }
  return parts.length ? parts.join(' OR ') : null;
}

module.exports = {
  CJK_CHAR_RE,
  CJK_RUN_RE,
  LATIN_RE,
  MAX_MATCH_TERMS,
  MAX_PHRASE_BIGRAMS,
  MAX_TERMS_PER_FIELD,
  MAX_TF,
  UNIGRAM_WEIGHT,
  forEachTerm,
  indexTokens,
  matchExpression,
  matchGroups,
  normalizeText,
  quoteToken,
  tokenize,
};
