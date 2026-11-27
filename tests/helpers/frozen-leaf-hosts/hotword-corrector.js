'use strict';

// Hotword post-correction for ASR engines with no decode-time biasing.
//
// sherpa-onnx's contextual biasing only exists for transducer models, and the
// SenseVoice we ship is a CTC-style model, so the user's terms cannot be fed to
// the decoder. This module fixes the text afterwards instead:
//
//   * Chinese terms are matched by pinyin (tones ignored), so homophones and a
//     few near-sounds ("权线" → "权限", "支持" ← "指示") are swapped for the term.
//   * `正确词=别名1/别名2` lists spellings the recogniser is known to produce for
//     a term, e.g. `Claude=克劳德/克拉德`; they are matched like any other
//     Chinese term and replaced with the canonical word.
//   * ASCII terms match case-insensitively with optional spaces between letters
//     ("multi cc" → "MultiCC").
//
// Pure and synchronous: no config, no fs. The pinyin dictionary is loaded
// lazily and optionally — if `pinyin-pro` cannot be resolved the Chinese half is
// skipped and the ASCII half keeps working, because a missing dependency must
// never take voice input down.

const MAX_ENTRIES = 200;
const MAX_TERM_LEN = 40;
const CJK_ONLY = /^[一-鿿]+$/;
const CJK_RUN = /[一-鿿]+/g;
const ENTRY_SPLIT = /[\n\r,，;；、]+/;
const ALIAS_SPLIT = /[/|]/;

let _pinyin;
function pinyinFn() {
  if (_pinyin !== undefined) return _pinyin;
  try { _pinyin = require('pinyin-pro').pinyin; } catch (_) { _pinyin = null; }
  return _pinyin;
}

// ── Entry parsing ──
// "React, Claude=克劳德/克拉德\n哈勃" → [{term, aliases}]
function parseHotwords(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const byKey = new Map();
  for (const item of raw.split(ENTRY_SPLIT)) {
    const eq = item.indexOf('=');
    const term = (eq < 0 ? item : item.slice(0, eq)).trim();
    if (!term || term.length > MAX_TERM_LEN) continue;
    const entry = byKey.get(term.toLowerCase()) || { term, aliases: [] };
    if (eq >= 0) {
      for (const a of item.slice(eq + 1).split(ALIAS_SPLIT)) {
        const alias = a.trim();
        if (alias && alias.length <= MAX_TERM_LEN && alias !== term && !entry.aliases.includes(alias)) {
          entry.aliases.push(alias);
        }
      }
    }
    byKey.set(term.toLowerCase(), entry);
    if (byKey.size >= MAX_ENTRIES) break;
  }
  return [...byKey.values()];
}

// The same list as it should be shown to a cloud recogniser: aliases are our
// own bookkeeping and would only confuse a prompt.
function stripAliases(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/=[^\n\r,，;；、]*/g, '');
}

// ── Pinyin similarity ──
const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's'];
// Initials a regional accent commonly merges: flat/retroflex, n/l, f/h, l/r.
const INITIAL_CLASSES = [['z', 'zh'], ['c', 'ch'], ['s', 'sh'], ['n', 'l'], ['f', 'h'], ['l', 'r']];

function splitSyllable(s) {
  for (const i of INITIALS) if (s.startsWith(i) && s.length > i.length) return [i, s.slice(i.length)];
  return ['', s];
}
function sameInitial(a, b) {
  if (a === b) return true;
  return INITIAL_CLASSES.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}
// an/ang, en/eng, in/ing (and everything ending in them: ian/iang, uan/uang…).
function nasalPair(a, b) {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return l === `${s}g` && /(an|en|in)$/.test(s);
}
function nearSyllable(a, b) {
  const [ia, fa] = splitSyllable(a);
  const [ib, fb] = splitSyllable(b);
  if (!sameInitial(ia, ib)) return false;
  return fa === fb || nasalPair(fa, fb);
}

// How many near-but-not-equal syllables a pattern of `len` characters may
// absorb. Two-character terms are too common in ordinary speech to be loose.
function fuzzBudget(len) {
  if (len >= 6) return 2;
  if (len >= 3) return 1;
  return 0;
}

// -1 = no match, otherwise the number of near (non-identical) syllables.
function windowCost(patternSyl, textSyl, offset) {
  let fuzz = 0;
  const budget = fuzzBudget(patternSyl.length);
  for (let k = 0; k < patternSyl.length; k++) {
    const t = textSyl[offset + k];
    const p = patternSyl[k];
    if (t === p) continue;
    if (++fuzz > budget || !nearSyllable(t, p)) return -1;
  }
  return fuzz;
}

function toSyllables(zh) {
  const py = pinyinFn();
  if (!py) return null;
  try {
    const syl = py(zh, { toneType: 'none', type: 'array' });
    // One syllable per character, or the offsets below would drift.
    return Array.isArray(syl) && syl.length === zh.length ? syl.map(s => String(s).toLowerCase()) : null;
  } catch (_) { return null; }
}

// ── ASCII terms ──
// A recogniser may split a word ("multi cc") but a space the term itself has
// between words must stay one: "Claude Code" must not swallow the identifier
// `claudecode` in a path. For the same reason a match never starts or ends next
// to `_ / \ -` (MULTICC_BASE_URL, code/claudecode/x), a leading dot, or a
// trailing `=` (pid=123 is a key, not prose).
function asciiRegex(form) {
  const words = form.trim().split(/\s+/);
  if (words.join('').length < 3) return null;
  const esc = c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = words.map(w => w.split('').map(esc).join('[ ]?')).join('[ ]+');
  return new RegExp(`(?<![A-Za-z0-9_./\\\\-])${pattern}(?![A-Za-z0-9_/\\\\=-])`, 'gi');
}

// ── Matcher ──
function createMatcher(entries) {
  const zhPatterns = [];
  const asciiRules = [];
  for (const { term, aliases } of entries) {
    for (const form of [term, ...aliases]) {
      if (CJK_ONLY.test(form)) {
        if (form.length < 2) continue;
        const syl = toSyllables(form);
        if (syl) zhPatterns.push({ form, syl, canon: term, len: form.length });
      } else if (/^[\x20-\x7e]+$/.test(form)) {
        const re = asciiRegex(form);
        if (re) asciiRules.push({ re, canon: term });
      }
    }
  }
  // Longest first so "哈勃望远镜" claims its span before "哈勃" can.
  zhPatterns.sort((a, b) => b.len - a.len);

  function correctChinese(text) {
    if (!zhPatterns.length) return text;
    const spans = [];
    for (const m of text.matchAll(CJK_RUN)) {
      const run = m[0];
      const base = m.index;
      const syl = toSyllables(run);
      if (!syl) continue;
      const found = [];
      for (const p of zhPatterns) {
        for (let i = 0; i + p.len <= run.length; i++) {
          const cost = windowCost(p.syl, syl, i);
          if (cost >= 0) found.push({ start: base + i, end: base + i + p.len, p, cost, same: run.startsWith(p.form, i) });
        }
      }
      // Claim spans best-first: longer, then fewer near-syllables, then earlier.
      found.sort((a, b) => (b.p.len - a.p.len) || (a.cost - b.cost) || (a.start - b.start));
      for (const c of found) {
        if (!spans.some(s => c.start < s.end && s.start < c.end)) spans.push(c);
      }
    }
    if (!spans.length) return text;
    spans.sort((a, b) => a.start - b.start);
    let out = '';
    let at = 0;
    for (const s of spans) {
      out += text.slice(at, s.start) + (s.same && s.p.form === s.p.canon ? text.slice(s.start, s.end) : s.p.canon);
      at = s.end;
    }
    return out + text.slice(at);
  }

  function correct(text) {
    if (!text) return text;
    let out = correctChinese(text);
    for (const { re, canon } of asciiRules) out = out.replace(re, canon);
    return out;
  }

  return { correct, size: zhPatterns.length + asciiRules.length };
}

// Compiling re-derives pinyin for every term, so remember the last list.
let _memo = { raw: null, matcher: null };
function correctWithHotwords(text, raw) {
  if (!text || typeof raw !== 'string' || !raw.trim()) return text;
  if (_memo.raw !== raw) _memo = { raw, matcher: createMatcher(parseHotwords(raw)) };
  return _memo.matcher.correct(text);
}

module.exports = {
  parseHotwords,
  stripAliases,
  createMatcher,
  correctWithHotwords,
  nearSyllable,
  toSyllables,
};
