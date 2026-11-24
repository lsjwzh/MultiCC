'use strict';

// Learns the local hotword list from what the user already did, so nobody has
// to type one into the voice settings:
//
//   * every voice correction (raw transcript → the text the user sent) is
//     diffed; a replaced span becomes a candidate `term=alias` pair, and a
//     case/spacing-only fix ("s t t" → "STT") becomes a plain term;
//   * the user's own chat messages are scanned for distinctive identifiers
//     (MultiCC, CC-Switch, GapaSea) that a recogniser tends to lower-case or
//     split.
//
// A one-off edit proves little — users also rewrite sentences — so a pair only
// becomes active once the same fix was seen twice. A pair is vetoed outright
// when its "wrong" spelling shows up in text the user wrote and kept: that word
// is real to them, and rewriting it would be the exact silent damage a hotword
// list must never do.
//
// Pure: no fs, no timers. hotword-learner.js owns persistence and scheduling.

const { nearSyllable, toSyllables } = require('./hotword-corrector');

const ACTIVATE_AT = 2;
const MAX_DIFF_CHARS = 600;
const MAX_SIDE = 16;
const MIN_SIMILARITY = 0.6;
const CJK = /[一-鿿]/;
const ASCII_WORD = /[A-Za-z0-9][A-Za-z0-9_.+-]*/y;

// ── Tokens ──
// ASCII words stay whole, every CJK character and every other symbol is a
// token of its own, whitespace is dropped (but remembered on the token so the
// original span can be rebuilt).
function tokenize(text) {
  const tokens = [];
  let i = 0;
  let gap = false;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { gap = true; i++; continue; }
    ASCII_WORD.lastIndex = i;
    const m = /[A-Za-z0-9]/.test(ch) && ASCII_WORD.exec(text);
    const value = m ? m[0] : ch;
    tokens.push({ value, start: i, end: i + value.length, gap });
    gap = false;
    i += value.length;
  }
  return tokens;
}

// Classic LCS table on tokens; inputs are capped so this stays small.
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i].value === b[j].value ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i].value === b[j].value) { ops.push(['=', i++, j++]); continue; }
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) ops.push(['+', -1, j++]);
    else ops.push(['-', i++, -1]);
  }
  return { ops, common: dp[0][0] };
}

const isPunct = t => !CJK.test(t.value) && !/[A-Za-z0-9]/.test(t.value);
const spanText = (text, tokens) => (tokens.length ? text.slice(tokens[0].start, tokens[tokens.length - 1].end).trim() : '');
const squash = s => s.replace(/\s+/g, '').toLowerCase();

// A lone CJK character carries no meaning on its own ("热水" → "热词" diffs as
// 水 → 词): borrow the unchanged neighbours until the term reads as a word.
function widen(hunk, rawTok, finTok) {
  let { r0, r1, f0, f1 } = hunk;
  const cjkLen = () => finTok.slice(f0, f1).filter(t => CJK.test(t.value)).length;
  for (let step = 0; step < 2 && f1 - f0 > 0 && cjkLen() > 0 && cjkLen() < 2; step++) {
    if (r0 > 0 && f0 > 0 && CJK.test(rawTok[r0 - 1].value) && rawTok[r0 - 1].value === finTok[f0 - 1].value) { r0--; f0--; continue; }
    if (r1 < rawTok.length && f1 < finTok.length && CJK.test(rawTok[r1].value) && rawTok[r1].value === finTok[f1].value) { r1++; f1++; continue; }
    break;
  }
  return { r0, r1, f0, f1 };
}

// What a single correction teaches: [{ term, alias? }]. `alias` is absent for
// a case/spacing-only fix.
function minePairs(raw, final) {
  raw = typeof raw === 'string' ? raw.trim() : '';
  final = typeof final === 'string' ? final.trim() : '';
  if (!raw || !final || raw === final || raw.length > MAX_DIFF_CHARS || final.length > MAX_DIFF_CHARS) return [];
  const rawTok = tokenize(raw);
  const finTok = tokenize(final);
  const { ops, common } = lcsOps(rawTok, finTok);
  // In a heavy rewrite (an AI cleanup pass, or the user restating the request)
  // most changed spans are content, not mishearing; only a fix that lands on an
  // ASCII term is still trusted there ("…类似OpenCloud的…" → "…OpenClaw…").
  const rewrite = common / Math.max(rawTok.length, finTok.length) < MIN_SIMILARITY;

  // Runs of non-equal ops between two equal ones; r/f = next raw/final index.
  const hunks = [];
  let cur = null;
  let r = 0;
  let f = 0;
  for (const [op] of ops) {
    if (op === '=') { if (cur) hunks.push(cur); cur = null; r++; f++; continue; }
    if (!cur) cur = { r0: r, r1: r, f0: f, f1: f };
    if (op === '-') cur.r1 = ++r;
    else cur.f1 = ++f;
  }
  if (cur) hunks.push(cur);

  const out = [];
  for (const h0 of hunks) {
    // Edits that only touch punctuation are not about words.
    const rCore = rawTok.slice(h0.r0, h0.r1).filter(t => !isPunct(t));
    const fCore = finTok.slice(h0.f0, h0.f1).filter(t => !isPunct(t));
    if (!rCore.length || !fCore.length) continue;
    const h = widen(h0, rawTok, finTok);
    const alias = spanText(raw, rawTok.slice(h.r0, h.r1).filter(t => !isPunct(t)));
    const term = spanText(final, finTok.slice(h.f0, h.f1).filter(t => !isPunct(t)));
    if (!termLike(term) || !alias || alias.length > MAX_SIDE) continue;
    if (rewrite && !/[A-Za-z]/.test(term)) continue;
    if (squash(alias) === squash(term)) {
      if (/[A-Za-z]/.test(term)) out.push({ term });
      continue;
    }
    if (alias.length > term.length * 3 + 4) continue;
    if (CJK_ONLY.test(term) && CJK_ONLY.test(alias) && !soundAlike(term, alias)) continue;
    out.push({ term, alias });
  }
  return out;
}

// A recogniser swaps a word for one that sounds like it, same length: "热水"
// for "热词" (re shui / re ci) qualifies, "是相关的事例" for "类似项目" is an
// edit of the content. Half the syllables must match or be near.
const CJK_ONLY = /^[一-鿿]+$/;
function soundAlike(a, b) {
  if (a.length !== b.length) return false;
  const sa = toSyllables(a);
  const sb = toSyllables(b);
  if (!sa || !sb) return true; // no pinyin dictionary: the count gate still applies
  const close = sa.filter((s, i) => s === sb[i] || nearSyllable(s, sb[i])).length;
  return close * 2 >= a.length;
}

function termLike(term) {
  if (!term || term.length > MAX_SIDE || /[\n\r,，;；、=/|]/.test(term)) return false;
  if (/^[一-鿿]+$/.test(term)) return term.length >= 2 && term.length <= 8;
  return /[A-Za-z]/.test(term) && term.replace(/[^A-Za-z0-9]/g, '').length >= 3 && !/[一-鿿]/.test(term);
}

// ── Typed vocabulary ──
// Spellings that mark a word as a name: inner capitals (MultiCC, GapaSea),
// short all-caps acronyms (STT, CPR), letter+digit (pm2), hyphenated names
// (CC-Switch). A long all-caps word (CLAUDE, ERROR) is shouting, not a name,
// and plain lower-case words are left alone — re-casing ordinary English is
// noise, not a correction.
const COMMON_CAPS = new Set(['THE', 'AND', 'FOR', 'YOU', 'NOT', 'BUT', 'API', 'URL', 'GET', 'POST', 'PUT', 'DELETE', 'HTTP', 'HTTPS', 'JSON', 'HTML', 'CSS', 'TODO', 'NOTE', 'OK', 'YES', 'PDF', 'PNG', 'JPG', 'GIF', 'SVG', 'CPU', 'GPU', 'RAM', 'USB']);
function distinctive(word) {
  if (word.length < 3 || word.length > 24 || /_/.test(word) || /^\d/.test(word)) return false;
  // Hashes and generated ids (r722lph51psgw7) are not words anyone says.
  if ((word.match(/\d/g) || []).length >= 3) return false;
  if (/^[A-Z0-9]+$/.test(word)) return word.length <= 4 && /[A-Z]{2}/.test(word) && !COMMON_CAPS.has(word);
  return /[a-z][A-Z]/.test(word) || /[A-Za-z]-[A-Za-z]/.test(word) || /[A-Za-z]\d|\d[A-Za-z]/.test(word);
}

// Strip what is not prose: code blocks, inline code, URLs, paths, flags.
function proseOf(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\s"'`()（）]*[/\\][^\s"'`()（）]*/g, ' ')
    .replace(/(?:^|\s)--?[A-Za-z][\w-]*/g, ' ')
    .replace(/\$[A-Z_][A-Z0-9_]*/g, ' ');
}

// messages: [{ session, text }]. Returns Map(lower → { term, count, sessions }).
// A word qualifies once the user wrote it in a name-like spelling twice; the
// term is then their usual spelling, so a habitual "multicc" stays lower-case
// even though "MultiCC" is what proved it a name.
function mineTypedTerms(messages) {
  const words = new Map();
  for (const { session, text } of messages) {
    const seen = new Set();
    for (const word of proseOf(text).match(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g) || []) {
      const key = word.toLowerCase();
      const e = words.get(key) || { term: word, count: 0, sessions: new Set(), forms: new Map() };
      e.forms.set(word, (e.forms.get(word) || 0) + 1);
      if (!seen.has(key)) { seen.add(key); e.count++; e.sessions.add(session); }
      words.set(key, e);
    }
  }
  const terms = new Map();
  for (const [key, e] of words) {
    let evidence = 0;
    let shapes = 0;
    for (const [form, n] of e.forms) {
      if (!distinctive(form)) continue;
      evidence += n;
      if (!/^[A-Z0-9]+$/.test(form)) shapes += n;
    }
    if (evidence < 2) continue;
    e.term = [...e.forms].sort((a, b) => b[1] - a[1])[0][0];
    // Caps alone ("TASK", "CLI") prove an acronym only when the user usually
    // writes it that way; otherwise it is an ordinary word typed loudly.
    if (!shapes && !distinctive(e.term)) continue;
    terms.set(key, e);
  }
  return terms;
}

// ── Final list ──
const pairKey = (term, alias) => `${term.toLowerCase()}\u0000${squash(alias)}`;

// Text the user wrote and kept contains the alias as a word of its own.
function vetoedBy(alias, keptTexts) {
  const a = alias.toLowerCase();
  const ascii = /^[\x20-\x7e]+$/.test(alias);
  for (const t of keptTexts) {
    const s = String(t || '').toLowerCase();
    let at = s.indexOf(a);
    while (at >= 0) {
      const before = s[at - 1] || ' ';
      const after = s[at + a.length] || ' ';
      if (!ascii || (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after))) return true;
      at = s.indexOf(a, at + 1);
    }
  }
  return false;
}

// state: { pairs: {key: {term, alias?, count}}, typed: [{term, count, sessions}],
//          rejected: [key] }, keptTexts: user-authored text to veto against.
function buildHotwords(state, keptTexts = []) {
  const rejected = new Set(state.rejected || []);
  const active = new Map();
  const pending = [];
  const vetoed = [];
  const add = (term, alias) => {
    const k = term.toLowerCase();
    const e = active.get(k) || { term, aliases: [] };
    if (alias && !e.aliases.includes(alias)) e.aliases.push(alias);
    active.set(k, e);
  };
  for (const [key, p] of Object.entries(state.pairs || {})) {
    if (rejected.has(key)) continue;
    if (!p.alias) { add(p.term); continue; }
    if (vetoedBy(p.alias, keptTexts)) { vetoed.push(p); continue; }
    if (p.count >= ACTIVATE_AT) add(p.term, p.alias);
    else pending.push(p);
  }
  for (const t of state.typed || []) {
    if (!rejected.has(pairKey(t.term, ''))) add(t.term);
  }
  const entries = [...active.values()];
  const list = entries.map(e => (e.aliases.length ? `${e.term}=${e.aliases.join('/')}` : e.term)).join(', ');
  return { list, active: entries, pending, vetoed };
}

module.exports = {
  ACTIVATE_AT,
  tokenize,
  minePairs,
  mineTypedTerms,
  distinctive,
  pairKey,
  vetoedBy,
  buildHotwords,
};
