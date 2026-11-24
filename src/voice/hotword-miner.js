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

const { getNative } = require('../native/runtime');
const { nearSyllable, toSyllables } = require('./hotword-corrector');

const ACTIVATE_AT = 2;
const MAX_DIFF_CHARS = 600;
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

const squash = s => s.replace(/\s+/g, '').toLowerCase();
const sameSpelling = (alias, term) => squash(alias) === squash(term);

function minePairs(raw, final) {
  raw = typeof raw === 'string' ? raw.trim() : '';
  final = typeof final === 'string' ? final.trim() : '';
  if (!raw || !final || raw === final || raw.length > MAX_DIFF_CHARS || final.length > MAX_DIFF_CHARS) return [];
  return getNative().voiceMineHotwordPairs(raw, final, sameSpelling, soundAlike);
}

// A recogniser swaps a word for one that sounds like it, same length: "热水"
// for "热词" (re shui / re ci) qualifies, "是相关的事例" for "类似项目" is an
// edit of the content. Half the syllables must match or be near.
function soundAlike(a, b) {
  if (a.length !== b.length) return false;
  const sa = toSyllables(a);
  const sb = toSyllables(b);
  if (!sa || !sb) return true; // no pinyin dictionary: the count gate still applies
  const close = sa.filter((s, i) => s === sb[i] || nearSyllable(s, sb[i])).length;
  return close * 2 >= a.length;
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
  const tally = new (getNative().VoiceTypedVocabulary)();
  const sessionIds = new Map();
  for (const { session, text } of messages) {
    const prose = proseOf(text);
    if (!sessionIds.has(session)) sessionIds.set(session, sessionIds.size);
    tally.observe(sessionIds.get(session), prose);
  }
  const sessions = [...sessionIds.keys()];
  const terms = new Map();
  for (const row of tally.terms(tally.spellings().map(distinctive))) {
    terms.set(row.key, { term: row.term, count: row.count,
      sessions: new Set(row.sessionIds.map(id => sessions[id])), forms: new Map(row.forms) });
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
    const at = s.indexOf(a);
    if (at >= 0 && getNative().voiceHotwordMatch(at, ascii,
      i => [s[i - 1] || ' ', s[i + a.length] || ' '],
      next => s.indexOf(a, next))) return true;
  }
  return false;
}

// These operations use V8's case folding, coercion and live iterables.
function* typedHotwords(state) {
  for (const term of state.typed || []) yield term;
}

const listPorts = {
  alias: pair => pair.alias,
  term: entry => entry.term,
  lower: term => term.toLowerCase(),
  typedKey: term => pairKey(term, ''),
  activates: count => count >= ACTIVATE_AT,
  vetoedBy,
};

function buildHotwords(state, keptTexts = []) {
  const rejected = new Set(state.rejected || []);
  const pairs = Object.entries(state.pairs || {});
  const { active, pending, vetoed } = getNative().voiceHotwordList(
    pairs, () => typedHotwords(state), rejected, keptTexts, listPorts);
  const list = active.map(e => (e.aliases.length ? `${e.term}=${e.aliases.join('/')}` : e.term)).join(', ');
  return { list, active, pending, vetoed };
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
