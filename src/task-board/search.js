'use strict';

// Full-text search over the task board.
//
// Pure module, same contract as normalize/classification/routing/view: given a
// board object it computes everything deterministically, does no I/O and never
// mutates task records. The board is the whole durable body we keep for a task,
// so it is also its whole searchable corpus:
//
//   title · module name · areas · planning text (description / acceptance
//   criteria) · every turn excerpt (refs[].excerpt, one per tagged turn)
//
// Message bodies live in chat_history (1.2 GB across every session) and are
// deliberately NOT read here: attribution runs on admission of every turn, so a
// search must stay cheap enough to run synchronously in that path, and remembering
// *what a task was about* is exactly what the excerpts already record.
//
// Chinese has no spaces, so tokenization is mixed: latin/digit runs become one
// token, CJK runs become overlapping bigrams *and* their single characters. The
// bigrams carry the meaning ("搜索" ≠ "搜" + "索"); the single characters exist
// only so a one-character query can still be answered, and a query made of real
// words refuses to be satisfied by them alone (see analyzeQuery's strong/weak
// split). Scoring is BM25 per field, weighted title > body > areas > module, with
// a bonus when the query appears as one contiguous phrase.

// Field weights are a relevance decision, not a display one: the title is the
// task's own name, areas its durable scope, an excerpt one turn of work.
const FIELD_WEIGHTS = { title: 6, module: 2, areas: 3, body: 4 };
const BM25_K1 = 1.4;
const BM25_B = 0.6;
const MAX_QUERY_TERMS = 12;
// A repeated word stops being evidence after a while, and a pathological excerpt
// must not be able to dominate its own length normalisation.
const MAX_TF = 32;
const MAX_TERMS_PER_FIELD = 8000;
const SNIPPET_RADIUS = 40;
const SNIPPET_MAX = 160;
// A single CJK character is a legal query but weak evidence: it appears inside
// far too many words to rank on its own.
const WEAK_QUERY_WEIGHT = 0.34;

const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+/g;
const LATIN_RE = /[a-z0-9][a-z0-9+._-]+/g;
const CJK_CHAR_RE = /^[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]$/;

function normalizeText(value) {
  return String(value == null ? '' : value).normalize('NFKC').toLowerCase();
}

// term → occurrences in `text`. Latin runs are whole tokens; a CJK run yields
// every bigram plus every single character, so both query shapes hit.
function tokenize(text) {
  const normalized = normalizeText(text);
  const counts = new Map();
  const add = (term, weight = 1) => {
    if (counts.size >= MAX_TERMS_PER_FIELD && !counts.has(term)) return;
    counts.set(term, Math.min(MAX_TF, (Number(counts.get(term)) || 0) + weight));
  };
  for (const match of normalized.match(LATIN_RE) || []) add(match);
  for (const run of normalized.match(CJK_RE) || []) {
    for (let index = 0; index + 1 < run.length; index += 1) add(run.slice(index, index + 2));
    for (const char of run) add(char, 0.5);
  }
  return counts;
}

function taskModuleName(board, task) {
  const module = task?.moduleId ? board?.modules?.[task.moduleId] : null;
  return module?.name ? String(module.name) : '';
}

function taskPlanningText(task) {
  return [task?.description, task?.acceptanceCriteria]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join('\n');
}

// The per-task corpus. `title`/`module`/`areas` stay apart from `body` so their
// matches rank higher without inflating the length normalisation of the much
// longer body.
function taskSearchFields(board, task) {
  return {
    title: String(task?.title || '').trim(),
    module: taskModuleName(board, task),
    areas: (Array.isArray(task?.areas) ? task.areas : [])
      .map(value => String(value || '').trim()).filter(Boolean).join(' '),
    body: [
      taskPlanningText(task),
      (Array.isArray(task?.refs) ? task.refs : [])
        .map(ref => String(ref?.excerpt || '').trim()).filter(Boolean).join('\n'),
    ].filter(Boolean).join('\n'),
  };
}

function buildTaskSearchIndex(board, options = {}) {
  const taskMap = board && typeof board.tasks === 'object' ? board.tasks : {};
  const deleted = new Set(Array.isArray(board?.deletedTaskIds) ? board.deletedTaskIds : []);
  const statuses = Array.isArray(options.statuses) && options.statuses.length
    ? new Set(options.statuses.map(String)) : null;
  const docs = new Map();
  const docFreq = new Map();

  for (const task of Object.values(taskMap)) {
    if (!task || typeof task.id !== 'string' || !task.id) continue;
    // Aliases of an explicit user merge are tombstones, not identities; the
    // surviving task already carries the untouched history.
    if (deleted.has(task.id) || task.mergedInto || task.deleting) continue;
    if (statuses && !statuses.has(String(task.status || 'active'))) continue;
    const fields = taskSearchFields(board, task);
    const byTerm = new Map();
    const lengths = {};
    for (const [field, text] of Object.entries(fields)) {
      if (!FIELD_WEIGHTS[field] || !text) continue;
      let length = 0;
      for (const [term, count] of tokenize(text)) {
        const perTerm = byTerm.get(term) || {};
        perTerm[field] = (perTerm[field] || 0) + count;
        byTerm.set(term, perTerm);
        length += count;
      }
      lengths[field] = length;
    }
    if (!byTerm.size) continue;
    for (const term of byTerm.keys()) docFreq.set(term, (docFreq.get(term) || 0) + 1);
    docs.set(task.id, {
      taskId: task.id,
      title: fields.title,
      dirId: typeof task.dirId === 'string' && task.dirId.trim() ? task.dirId.trim()
        : (Array.isArray(task.refs) ? task.refs.find(ref => ref?.dirId)?.dirId || null : null),
      status: typeof task.status === 'string' ? task.status : 'active',
      updatedAt: Number(task.updatedAt) || Number(task.createdAt) || 0,
      fields,
      lengths,
      terms: byTerm,
    });
  }

  // Average field length per field name — BM25 normalises against the field the
  // match happened in, so a long excerpt is not punished for being long while
  // the title stays short.
  const avgLengths = {};
  for (const field of Object.keys(FIELD_WEIGHTS)) {
    let total = 0;
    let seen = 0;
    for (const doc of docs.values()) {
      if (!Number.isFinite(doc.lengths[field])) continue;
      total += doc.lengths[field];
      seen += 1;
    }
    avgLengths[field] = seen ? Math.max(1, total / seen) : 1;
  }
  const docCount = docs.size;
  const idf = term => Math.log(1 + (docCount - (docFreq.get(term) || 0) + 0.5) / ((docFreq.get(term) || 0) + 0.5));

  return {
    version: 1,
    revision: Number(board?.revision) || 0,
    docCount,
    idf,
    avgLengths,
    docs,
    // Exposed for tests/tools: the corpus one task contributes.
    fieldsFor: taskId => taskSearchFields(board, taskMap[taskId] || {}),
  };
}

// Parsed query: `terms` are [term, weight] pairs in rank order, `all` is every
// term for snippet highlighting, and `strong` are the ones a document must
// actually contain when the query has any.
function analyzeQuery(query) {
  const raw = String(query || '').trim();
  if (!raw) return { text: '', terms: [], strong: [], all: [], highlight: [], phrase: '' };
  // A lone CJK character is weak no matter how often the query repeats it: it is
  // the *kind* of term that decides, not its frequency.
  // Ties keep tokenize's insertion order (first occurrence in the query), which
  // is the closest thing to "what the sentence is about" once length has been
  // weighed: a term the user wrote first is a better subject than a later one.
  const collected = [...tokenize(raw).keys()]
    .map(term => [term, CJK_CHAR_RE.test(term) ? WEAK_QUERY_WEIGHT : 1])
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, MAX_QUERY_TERMS);
  const strong = collected.filter(([term, weight]) => weight >= 1).map(([term]) => term);
  const all = collected.map(([term]) => term);
  return {
    text: raw,
    terms: collected,
    strong,
    all,
    // Highlighting a lone character that merely sits inside an already-matched
    // word only scatters the marks; highlighting falls back to every term when
    // the query itself is nothing but lone characters.
    highlight: strong.length ? strong : all,
    // The contiguous phrase the user actually typed, used only as a bonus: it
    // must never be required, because "回放 air 面板" is the same intent with
    // different word order.
    phrase: normalizeText(raw).replace(/\s+/g, ' ').trim(),
  };
}

function fieldScore(index, term, perTerm, field, fieldLength) {
  const tf = perTerm?.[field];
  if (!tf) return 0;
  const average = index.avgLengths[field] || 1;
  const length = Number.isFinite(fieldLength) ? fieldLength : average;
  return (FIELD_WEIGHTS[field] || 1) * index.idf(term)
    * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (length / average))));
}

function phraseBonus(doc, phrase) {
  if (!phrase || phrase.length < 2) return 0;
  let best = 0;
  for (const [field, text] of Object.entries(doc.fields)) {
    if (!FIELD_WEIGHTS[field] || !text) continue;
    if (normalizeText(text).includes(phrase)) best = Math.max(best, FIELD_WEIGHTS[field]);
  }
  return best;
}

// Highlight ranges are computed inside the returned window, so the client only
// needs offsets relative to the string it renders — no index arithmetic, no HTML.
function buildSnippet(doc, query) {
  const candidates = ['body', 'areas', 'title', 'module'];
  const marks = Array.isArray(query.highlight) && query.highlight.length ? query.highlight : query.all;
  let source = '';
  let best = -1;
  let bestLength = 0;
  for (const field of candidates) {
    const text = doc.fields[field];
    if (!text) continue;
    const lower = normalizeText(text);
    for (const term of marks) {
      const at = lower.indexOf(term);
      if (at >= 0 && term.length > bestLength) {
        best = at;
        bestLength = term.length;
        source = text;
      }
    }
    if (best >= 0) break;
  }
  let windowText;
  if (best < 0) {
    const fallback = candidates.map(field => doc.fields[field]).find(Boolean) || '';
    windowText = fallback.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX);
  } else {
    const start = Math.max(0, best - SNIPPET_RADIUS);
    const end = Math.min(source.length, best + bestLength + SNIPPET_RADIUS);
    windowText = source.slice(start, end).replace(/\s+/g, ' ').trim();
  }
  const windowLower = normalizeText(windowText);
  const hits = [];
  for (const term of marks) {
    let from = windowLower.indexOf(term);
    while (from >= 0) {
      hits.push([from, from + term.length]);
      from = windowLower.indexOf(term, from + term.length);
    }
  }
  return { text: windowText, ranges: mergeRanges(hits.sort((a, b) => a[0] - b[0] || a[1] - b[1])) };
}

function mergeRanges(ranges) {
  const merged = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function searchTaskIndex(index, query, options = {}) {
  const parsed = typeof query === 'string' || query == null ? analyzeQuery(query) : query;
  if (!index?.docs?.size || !parsed.terms.length) return [];
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 10));
  const minScore = Number(options.minScore) > 0 ? Number(options.minScore) : 0;
  const dirId = options.dirId ? String(options.dirId) : null;
  const dirIds = Array.isArray(options.dirIds) && options.dirIds.length
    ? new Set(options.dirIds.map(String)) : null;
  const statuses = Array.isArray(options.statuses) && options.statuses.length
    ? new Set(options.statuses.map(String)) : null;
  const allowed = options.taskIds ? new Set(options.taskIds.map(String)) : null;
  const exclude = options.excludeTaskIds ? new Set(options.excludeTaskIds.map(String)) : null;
  const results = [];

  for (const doc of index.docs.values()) {
    if (allowed && !allowed.has(doc.taskId)) continue;
    if (exclude?.has(doc.taskId)) continue;
    if (dirId && doc.dirId !== dirId) continue;
    if (dirIds && !dirIds.has(doc.dirId)) continue;
    if (statuses && !statuses.has(doc.status)) continue;
    let score = 0;
    let strongHits = 0;
    const matched = [];
    const fields = new Set();
    for (const [term, weight] of parsed.terms) {
      const perTerm = doc.terms.get(term);
      if (!perTerm) continue;
      let termScore = 0;
      for (const field of Object.keys(FIELD_WEIGHTS)) {
        const part = fieldScore(index, term, perTerm, field, doc.lengths[field]);
        if (part > 0) fields.add(field);
        termScore += part;
      }
      if (termScore <= 0) continue;
      score += termScore * weight;
      matched.push(term);
      if (weight >= 1) strongHits += 1;
    }
    // A query made of real words must be answered by real words. Otherwise a
    // single stray character ("的") would drag every task mentioning it above
    // the tasks actually about the question.
    if (parsed.strong.length && !strongHits) continue;
    if (score <= 0) continue;
    score += phraseBonus(doc, parsed.phrase);
    if (score < minScore) continue;
    results.push({
      taskId: doc.taskId,
      title: doc.title,
      dirId: doc.dirId,
      status: doc.status,
      updatedAt: doc.updatedAt,
      score: Math.round(score * 1000) / 1000,
      matchedTerms: matched,
      matchedFields: [...fields],
      snippet: buildSnippet(doc, parsed),
    });
  }

  return results
    .sort((a, b) => b.score - a.score || Number(b.updatedAt) - Number(a.updatedAt)
      || String(a.taskId).localeCompare(String(b.taskId)))
    .slice(0, limit);
}

// Convenience for callers that hold a board but no long-lived index (REST route,
// one-shot attribution retrieval): build and search in one call.
function searchBoard(board, query, options = {}) {
  return searchTaskIndex(buildTaskSearchIndex(board, options), query, options);
}

module.exports = {
  analyzeQuery,
  buildSnippet,
  buildTaskSearchIndex,
  searchBoard,
  searchTaskIndex,
  taskSearchFields,
  tokenize,
  normalizeText,
  FIELD_WEIGHTS,
};
