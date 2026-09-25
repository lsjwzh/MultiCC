'use strict';

// Keeps "how big / how long ago / how many" from growing a second implementation.
//
// public/shared/format.js exists because the same five questions had drifted into
// eight byte-size helpers, four relative-time tables and two spellings of the same
// duration, all inside public/. Reviewing each new copy by hand does not scale, so
// this test refuses the *shape* of a new copy:
//
//   ① no file under public/ may DEFINE a byte-size / relative-time / span / token
//     helper that does its own work — the allowlist is empty. A one-line delegate
//     (`function fmtDuration(ms) { return FMT.formatDuration(ms); }`) is fine and
//     common: it keeps a public/test-facing name without a second implementation;
//   ② no file under public/ may scale a number by 1024 (or 1048576) outside the
//     canonical module — that division IS the second implementation, however the
//     thing is named and even when it is inlined;
//   ③ every page that pulls in a module using the format API must load
//     shared/format.js itself, before the module (a classic script publishing
//     globals has to arrive first);
//   ④ the canonical module must still be the thing that defines all of this (a
//     guard that passes because the module was emptied is not a guard).
//
// The precedent is tests/test-dom-helpers-escape.js: same idea, one escape helper,
// a registry of files that delegate instead of re-implementing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const CANONICAL = 'shared/format.js';

// Vendored code is not ours: a minified or third-party bundle may legitimately
// contain its own byte formatter and we cannot review it.
const VENDOR = [/\.min\.js$/, /^vendor\//, /^qrcode\.min\.js$/];

function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'vendor') continue;
      out.push(...walk(path.join(dir, entry.name), rel));
    } else if (/\.(?:js|html)$/.test(entry.name) && !VENDOR.some(re => re.test(rel))) {
      out.push(rel);
    }
  }
  return out.sort();
}

const FILES = walk(PUBLIC);
const SOURCES = new Map(FILES.map(rel => [rel, fs.readFileSync(path.join(PUBLIC, rel), 'utf8')]));

// ── ① a helper by name ──────────────────────────────────────────────────────
// Names, not spellings: the point is that "format a byte size" has one home, so a
// new name for it (or a revived old one) fails here even if it looks nothing like
// the ones this consolidation removed. Bare `duration` / `elapsed` / `ago` / `rel`
// are NOT in the list — those are ordinary variables, and a guard that cries wolf
// on `const duration = now - start` gets deleted.
const HELPER_NAMES = [
  { kind: 'byte size', re: /^_?(?:(?:fmt|format|human|humanize|pretty)(?:File)?(?:Size|Bytes)|prettyBytes|humanSize|formatMemorySize|opsPackageSize)$/i },
  { kind: 'relative time', re: /^_?(?:fmt|format|humanize)_?(?:Relative|TimeAgo|Ago)|^_?(?:relTime|relAgo|relativeAgo|relativeTime|timeAgo|agoText|friendlyTime|humanizeTime)$/i },
  { kind: 'elapsed span', re: /^_?(?:(?:fmt|format|humanize|human)_?(?:Duration|Elapsed)(?:Text|Label)?|duration(?:Text|Label)|elapsed(?:Text|Label))$/i },
  { kind: 'token count', re: /^_?(?:fmt|format)(?:Compact)?Tokens?(?:Count)?$/i },
];
// `fmtTime` is deliberately NOT in the list: an absolute wall-clock stamp
// (`toLocaleString`) is a locale concern, not a unit, and format.js does not own it.

const DEFINITION_SITES = [
  /(?:^|[\s;{(,])(?:async\s+)?function\s+(\w+)\s*\(/g,     // function fmtSize(
  /(?:^|[\s;{(,])(?:var|let|const)\s+(\w+)\s*=/g,           // const fmtSize =
  /(?:^|[\s;{,])([\w$.]+)\s*=\s*(?:function|\()/g,           // window.fmtSize = function /
  /(?:^|[\s;{,])(\w+)\s*:\s*(?:function|\()/g,               // { fmtSize: (…) }
  /(?:^|[\s;{,])(\w+)\s*\([^)]*\)\s*(?=\{)/g,                 // fmtSize(bytes) {
];

// Anything that means "this body asks the canonical module". Deliberately includes
// the module's own names, so a delegate may call either the namespace or the bare
// global the module publishes.
const DELEGATES = /MultiCCFormat|\bFMT\b|\bformatBytes\(|\bformatRelativeTime\(|\bformatDuration\(|\bfmtDuration\(|\bformatPercent\(|\bformatTokenCount\(|\bformatCompactTokens\(|\busageTone\(|\busageColor\(/;

function braceBody(text, at, start) {
  let depth = 0;
  for (let j = at; j < text.length; j += 1) {
    if (text[j] === '{') depth += 1;
    else if (text[j] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  return text.slice(start, start + 400);
}

/**
 * The definition's own body, never the next statement. A fixed-size window would
 * bleed into whatever follows and read the *neighbouring* delegate as if it were
 * this definition's — which is how a guard like this ends up green on a
 * re-implementation that happens to sit above a wrapper.
 */
function bodyOf(text, start) {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (text[i] === '{') return braceBody(text, i, start);
  // Walk past the parameter list (and any default value, which may itself be a
  // `{}` literal) to the body's opening brace; an expression-bodied arrow is
  // complete at its `;` instead.
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    const ch = text[j];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth <= 0) return text.slice(start, j + 1);
    else if (ch === '{' && depth <= 0) return braceBody(text, j, start);
    else if (ch === '\n' && depth <= 0 && j - i > 200) return text.slice(start, j + 1);
  }
  return text.slice(start, start + 400);
}

function helperDefinitions(rel) {
  const text = SOURCES.get(rel);
  const found = [];
  for (const pattern of DEFINITION_SITES) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const name = match[1].split('.').pop();
      const hit = HELPER_NAMES.find(entry => entry.re.test(name));
      if (!hit) continue;
      const head = match.index + match[0].length;
      found.push({
        name,
        kind: hit.kind,
        line: text.slice(0, match.index).split('\n').length,
        delegate: DELEGATES.test(bodyOf(text, head)),
      });
    }
  }
  return found;
}

const DEFINITIONS = new Map(FILES.map(rel => [rel, helperDefinitions(rel)]));

test('public/ re-implements byte/time/span/token helpers in no file', () => {
  const offenders = [];
  for (const rel of FILES) {
    if (rel === CANONICAL) continue;
    for (const hit of DEFINITIONS.get(rel)) {
      if (hit.delegate) continue;
      offenders.push(`${rel}:${hit.line} defines ${hit.name} (${hit.kind} helper) without calling the canonical module`);
    }
  }
  assert.deepEqual(offenders, [],
    'move the behaviour to public/shared/format.js and delegate to it (see tests/test-dom-helpers-escape.js)');
});

test('the delegating wrappers that exist are exactly that — wrappers', () => {
  // Proof the machinery above is live rather than vacuously green: public/ really
  // does define these names in several files, and every one of them only forwards.
  const delegates = [];
  for (const [rel, hits] of DEFINITIONS) {
    if (rel === CANONICAL) continue;
    for (const hit of hits) if (hit.delegate) delegates.push(`${rel}:${hit.line} ${hit.name}`);
  }
  assert.ok(delegates.length >= 5, `expected the known delegating wrappers, found ${delegates.length}`);
  // Meanwhile the canonical module's own definitions do the work: if they ever
  // started forwarding to something else, the delegating files would forward into
  // a wrapper, and the "one implementation" claim would be false.
  const canonical = DEFINITIONS.get(CANONICAL);
  for (const name of ['formatBytes', 'formatDuration', 'formatRelativeTime']) {
    assert.ok(canonical.some(hit => hit.name === name && !hit.delegate), `${CANONICAL} implements ${name}`);
  }
});

// ── ② the arithmetic that makes a helper redundant ──────────────────────────
// A local `const mb = n => (n / 1048576).toFixed(1) + ' MB'` is a second
// implementation even without a recognised name, and it is exactly what this
// consolidation removed. Scaling a size is allowed only in the canonical module.
const SCALING = [
  /\/\s*1024\b/,
  /\/\s*1048576\b/,
  /\/\s*\(?\s*1024\s*\*\s*1024\b/,
  /\b1024\s*\*\*\s*/,
  /Math\.pow\(\s*1024\b/,
];

test('public/ scales sizes by 1024 in the canonical module only', () => {
  const offenders = [];
  for (const rel of FILES) {
    if (rel === CANONICAL) continue;
    SOURCES.get(rel).split('\n').forEach((text, index) => {
      const code = text.replace(/\/\/.*$/, '').replace(/<!--[\s\S]*?-->/, '');
      if (SCALING.some(re => re.test(code))) offenders.push(`${rel}:${index + 1} ${text.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    'call formatBytes() from public/shared/format.js instead of dividing by 1024 here');
  // A `25 * 1024 * 1024` upload cap is a constant, not a rendering, and stays legal.
  assert.ok([...SOURCES.values()].some(text => /MAX_UPLOAD_SIZE\s*=\s*25 \* 1024 \* 1024/.test(text)),
    'the constant-shaped use of 1024 is still there — this guard is about divisions, not about the number');
});

// ── ③ the script tag has to be there ────────────────────────────────────────
const API_USE = /\bMultiCCFormat\b|\b(?:formatBytes|formatRelativeTime|formatDuration|formatPercent|formatTokenCount|formatCompactTokens|usageTone|usageColor)\s*\(/;

function scriptSrcs(rel) {
  return [...SOURCES.get(rel).matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)]
    .map(m => m[1].replace(/^\//, '').split('?')[0])
    .filter(src => SOURCES.has(src));
}

/** Direct <script src> plus any module a loaded module names as a `.js` literal. */
function reachable(rel) {
  const seen = new Set(scriptSrcs(rel));
  for (const module of [...seen]) {
    for (const match of (SOURCES.get(module) || '').matchAll(/["']([\w.-]+\.js)["']/g)) {
      if (SOURCES.has(match[1]) && match[1] !== CANONICAL) seen.add(match[1]);
    }
  }
  return seen;
}

const PAGES = FILES.filter(rel => rel.endsWith('.html'));
const usesApi = rel => API_USE.test(SOURCES.get(rel));

test('every page that uses the format API loads shared/format.js before it', () => {
  const failures = [];
  for (const page of PAGES) {
    const viaModule = [...reachable(page)].some(mod => mod !== CANONICAL && usesApi(mod));
    if (!usesApi(page) && !viaModule) continue;
    const scripts = scriptSrcs(page);
    const at = scripts.indexOf(CANONICAL);
    if (at < 0) {
      failures.push(`${page} uses the format API without loading ${CANONICAL}`);
      continue;
    }
    if (scripts.slice(0, at).some(usesApi)) {
      failures.push(`${page} loads a format-API user before ${CANONICAL}`);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(PAGES.filter(page => scriptSrcs(page).includes(CANONICAL)).length >= 8,
    'the pages that render numbers all carry the tag');
});

test('every module that uses the format API is reachable from a page that loads it', () => {
  const users = FILES.filter(rel => rel !== CANONICAL && !rel.endsWith('.html') && usesApi(rel));
  assert.ok(users.length >= 15, `expected the consolidated consumers, found ${users.length}`);
  const missing = users.filter(module => !PAGES.some(page => reachable(page).has(module)
    && scriptSrcs(page).includes(CANONICAL)));
  assert.deepEqual(missing, [],
    'a consumer whose page forgot the script tag is a ReferenceError waiting to happen');
});

// ── ④ the canonical module is still the implementation ──────────────────────
test('the canonical module really is the implementation', () => {
  const text = SOURCES.get(CANONICAL);
  for (const name of ['formatBytes', 'formatRelativeTime', 'formatDuration', 'formatPercent',
    'formatTokenCount', 'formatCompactTokens', 'usageTone', 'usageColor']) {
    assert.match(text, new RegExp(`function ${name}\\(`), `${CANONICAL} defines ${name}`);
    assert.match(text, new RegExp(`root\\.${name} =`), `${CANONICAL} publishes ${name} as a global`);
  }
  const node = require('../public/shared/format.js');
  assert.ok(Object.isFrozen(node), 'the module exports a frozen namespace');
  assert.equal(typeof node.formatBytes, 'function');
});
