'use strict';

// Differential oracle for the transcript governor.
//
// The frozen Node implementation (`tests/helpers/legacy-transcript-prune.js`)
// and the Rust kernel (through `src/chat/transcript-prune.js`) are run on
// byte-identical copies of generated transcripts in a private temp HOME. Every
// observable — report fields, file bytes, sidecar bytes, file mode, mtime,
// return of findTranscriptFile, and the pure predicates — must agree.
//
// Nothing here touches the real ~/.claude, ~/.codex or ~/.multicc.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-transcript-prune-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
const previousHome = process.env.HOME;
process.env.HOME = home;

const legacy = require('./helpers/legacy-transcript-prune');
const current = require('../src/chat/transcript-prune');

test.after(() => {
  process.env.HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

let counter = 0;
function sandbox() {
  const dir = path.join(root, 'case-' + (counter++));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── deterministic randomness ────────────────────────────────────────────────

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}

function int(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

const WORDS = ['alpha', 'beta', '继续', 'ok', 'api', '中文提问', 'emoji 😀', 'π', '\u0085', 'x'.repeat(2000)];
const FILLER = ['继续', 'ok', 'api', '1', '嗯', '   ', ''];

function text(random) {
  if (random() < 0.15) return pick(random, FILLER);
  const count = int(random, 1, 4);
  return Array.from({ length: count }, () => pick(random, WORDS)).join(' ');
}

function loneSurrogateText(random) {
  const variants = ['a\ud800b', '\udfff', 'x\ud83d', '中文𐀀end', '😀'];
  return random() < 0.5 ? pick(random, variants) : text(random);
}

function contentBlock(random, index) {
  const kind = pick(random, ['text', 'text', 'tool_use', 'tool_result', 'image', 'thinking', 'redacted_thinking', 'junk']);
  switch (kind) {
    case 'text':
      return { type: 'text', text: loneSurrogateText(random) };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: random() < 0.1 ? undefined : 'tu-' + index,
        name: 'Read',
        input: {
          file_path: '/tmp/' + text(random),
          nested: { body: 'y'.repeat(int(random, 0, 5000)), list: [text(random), text(random)] },
        },
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: random() < 0.1 ? undefined : 'tu-' + index,
        content: random() < 0.5
          ? 'z'.repeat(int(random, 0, 3000))
          : [{ type: 'text', text: 'r'.repeat(int(random, 0, 3000)) }],
      };
    case 'image':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'A'.repeat(random() < 0.4 ? int(random, 0, 50) : int(random, 3000, 9000)),
        },
      };
    case 'thinking':
      return { type: 'thinking', thinking: 't'.repeat(int(random, 0, 9000)), signature: 'sig'.repeat(int(random, 0, 300)) };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: 'data'.repeat(int(random, 0, 200)) };
    default:
      return pick(random, [null, 0, '', 'stray', [], { weird: true }]);
  }
}

function entry(random, index, previousUuid) {
  const uuid = random() < 0.9 ? 'u' + index : '';
  const base = { type: 'user', uuid, parentUuid: random() < 0.1 ? null : previousUuid, sessionId: 's', timestamp: '2026-01-01T00:00:00.000Z' };
  const kind = random();
  if (kind < 0.3) {
    return { ...base, type: 'user', message: { role: 'user', content: text(random) } };
  }
  if (kind < 0.55) {
    const blocks = Array.from({ length: int(random, 0, 3) }, (_, at) => contentBlock(random, index * 10 + at));
    return { ...base, type: random() < 0.5 ? 'user' : 'assistant', message: { role: 'user', content: blocks } };
  }
  if (kind < 0.7) {
    return { ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: text(random) }] }, toolUseResult: { stdout: 'o'.repeat(int(random, 0, 4000)) } };
  }
  if (kind < 0.78) {
    const flags = pick(random, [{}, { isMeta: true }, { isSidechain: true }, { isCompactSummary: true }]);
    return { ...base, ...flags, message: { role: 'user', content: text(random) } };
  }
  if (kind < 0.88) {
    return { type: 'system', uuid, subtype: 'compact_boundary', parentUuid: null, compactMetadata: { trigger: 'auto', preservedSegment: { headUuid: 'u' + Math.max(0, index - int(random, 1, 4)) } } };
  }
  return pick(random, [
    { type: 'summary', uuid, summary: text(random) },
    { type: 'file-history-snapshot', uuid, snapshot: { files: [] } },
    null,
  ]);
}

function randomTranscript(random) {
  const lineCount = int(random, 0, 28);
  const lines = [];
  let previous = null;
  for (let index = 0; index < lineCount; index++) {
    if (random() < 0.08) {
      lines.push(pick(random, ['{not json', '', '[]', '0', 'true', '{"type":"user"}']));
      continue;
    }
    const item = entry(random, index, previous);
    if (item === null) {
      lines.push('null');
      continue;
    }
    if (item.uuid) previous = item.uuid;
    let line = JSON.stringify(item);
    if (random() < 0.08) line += '\r';
    lines.push(line);
  }
  if (random() < 0.12) lines.push('{\n"broken": true}');
  if (random() < 0.1) lines.push('');
  return lines;
}

function writeTranscript(dir, name, lines, { trailing = true, binary = null } = {}) {
  const file = path.join(dir, name);
  const body = lines.join('\n') + (trailing && lines.length ? '\n' : '');
  fs.writeFileSync(file, binary ? Buffer.concat([Buffer.from(body), binary]) : body);
  return file;
}

function optionsFor(random) {
  const ladder = pick(random, [[20, 10, 5, 3, 2], [3, 2], [2], [1], []]);
  return {
    maxBytes: pick(random, [0, 1024, 2 * 1024 * 1024]),
    targetTokens: pick(random, [50, 200, 2000, 120000]),
    hardMaxTokens: pick(random, [80, 400, 5000, 160000]),
    keepTurnsLadder: ladder,
    maxEntryBytes: pick(random, [256, 1024, 200 * 1024]),
    hardEntryBytes: pick(random, [1024, 4096, 400 * 1024]),
    scanMinBytes: pick(random, [0, 1024, 384 * 1024]),
    minGainBytes: pick(random, [0, 64]),
    force: pick(random, [true, false, 1, 0]),
    dryRun: pick(random, [true, false, 1, 0]),
  };
}

function cloneOptions(options) {
  const clone = { ...options };
  if (Array.isArray(options.keepTurnsLadder)) clone.keepTurnsLadder = options.keepTurnsLadder.slice();
  return clone;
}

function normalizeReport(report) {
  if (!report) return report;
  const clone = { ...report };
  clone.file = 'file';
  return clone;
}

function copyForOracle(source, dir, name) {
  const target = path.join(dir, name);
  fs.copyFileSync(source, target);
  return target;
}

function sidecarOf(file) {
  return file.replace(/\.jsonl$/, '.pruned.jsonl');
}

function comparePrune(fixture, options) {
  const dir = sandbox();
  const seeded = path.join(dir, 'seed.jsonl');
  const bytes = fixture.body;
  fs.writeFileSync(seeded, bytes);
  const oracle = copyForOracle(seeded, dir, 'oracle.jsonl');
  const subject = copyForOracle(seeded, dir, 'subject.jsonl');
  fs.chmodSync(oracle, 0o640);
  fs.chmodSync(subject, 0o640);
  const subjectInode = fs.statSync(subject).ino;
  const legacyReport = legacy.pruneFile(oracle, cloneOptions(options));
  let subjectReport;
  let subjectError = null;
  try {
    subjectReport = current.pruneFile(subject, cloneOptions(options));
  } catch (error) {
    subjectError = error;
  }
  const legacyBytes = fs.readFileSync(oracle);
  let subjectBytes = null;
  let subjectErrorRead = null;
  try { subjectBytes = fs.readFileSync(subject); } catch (error) { subjectErrorRead = error; }
  if (legacyReport === null) {
    assert.equal(subjectError, null, JSON.stringify({ fixture: fixture.name, options }));
    assert.equal(subjectReport, null, JSON.stringify({ fixture: fixture.name, options }));
  } else {
    assert.equal(subjectError, null, String(subjectError));
    assert.deepEqual(normalizeReport(subjectReport), normalizeReport(legacyReport), JSON.stringify({ fixture: fixture.name, options }));
  }
  if (subjectError) return;
  assert.deepEqual(subjectBytes, legacyBytes, JSON.stringify({ fixture: fixture.name, options }));
  const oracleSide = sidecarOf(oracle);
  const subjectSide = sidecarOf(subject);
  assert.equal(fs.existsSync(subjectSide), fs.existsSync(oracleSide), fixture.name);
  if (fs.existsSync(oracleSide)) {
    assert.deepEqual(fs.readFileSync(subjectSide), fs.readFileSync(oracleSide), fixture.name);
  }
  assert.equal(fs.statSync(subject).mode & 0o777, fs.statSync(oracle).mode & 0o777, fixture.name);
  assert.equal(fs.statSync(subject).ino, subjectInode, 'write truncates in place');
}

function compareMeasure(fixture, options) {
  const dir = sandbox();
  const seeded = path.join(dir, 'seed.jsonl');
  fs.writeFileSync(seeded, fixture.body);
  const oracle = copyForOracle(seeded, dir, 'oracle.jsonl');
  const subject = copyForOracle(seeded, dir, 'subject.jsonl');
  const stamp = new Date('2026-02-03T04:05:06.789Z');
  fs.utimesSync(oracle, stamp, stamp);
  fs.utimesSync(subject, stamp, stamp);
  const legacyLevel = legacy.measureFile(oracle, cloneOptions(options));
  const subjectLevel = current.measureFile(subject, cloneOptions(options));
  assert.deepEqual(subjectLevel, legacyLevel, JSON.stringify({ fixture: fixture.name, options }));
  assert.equal(subjectLevel.modifiedAt, stamp.toISOString());
  assert.deepEqual(fs.readFileSync(subject), fs.readFileSync(oracle), 'measure is read-only');
}

// ── generated transcripts ───────────────────────────────────────────────────

test('randomized pruneFile agrees with the frozen Node implementation', () => {
  const random = rng(0x5eed1234);
  for (let iteration = 0; iteration < 700; iteration++) {
    const lines = randomTranscript(random);
    const body = lines.join('\n') + (random() < 0.85 && lines.length ? '\n' : '');
    const options = optionsFor(random);
    comparePrune({ name: 'prune-' + iteration, body }, options);
  }
});

test('randomized measureFile agrees with the frozen Node implementation', () => {
  const random = rng(0xfeed4321);
  for (let iteration = 0; iteration < 400; iteration++) {
    const lines = randomTranscript(random);
    const body = lines.join('\n') + (random() < 0.85 && lines.length ? '\n' : '');
    compareMeasure({ name: 'measure-' + iteration, body }, optionsFor(random));
  }
});

test('binary garbage, CRLF, empty and untrailed files agree', () => {
  const random = rng(0xabcdef01);
  const binaries = [
    Buffer.from([0xff, 0xfe, 0x00]),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from('\u{1f600}', 'utf8'),
    Buffer.from([0xc3]),
  ];
  for (let iteration = 0; iteration < 30; iteration++) {
    const lines = randomTranscript(random);
    const body = lines.join('\r\n') + (iteration % 3 === 0 ? '' : '\r\n');
    comparePrune({ name: 'binary-' + iteration, body }, optionsFor(random));
    compareMeasure({ name: 'binary-measure-' + iteration, body }, optionsFor(random));
  }
  for (const binary of binaries) {
    const chars = randomTranscript(random).join('\n') + '\n';
    const body = Buffer.concat([Buffer.from(chars), binary]);
    comparePrune({ name: 'tail-binary', body }, { force: true, dryRun: false, keepTurnsLadder: [2] });
    compareMeasure({ name: 'tail-binary-measure', body }, {});
  }
});

test('oversized entries exercise every elision level', () => {
  const random = rng(0x1234abcd);
  for (let iteration = 0; iteration < 80; iteration++) {
    const lines = [];
    for (let index = 0; index < int(random, 3, 14); index++) {
      lines.push(JSON.stringify(entry(random, index, index ? 'u' + (index - 1) : null)));
    }
    const body = lines.join('\n') + '\n';
    comparePrune(
      { name: 'elide-' + iteration, body },
      {
        force: true,
        dryRun: false,
        maxEntryBytes: int(random, 100, 4000),
        hardEntryBytes: int(random, 4000, 9000),
        keepTurnsLadder: pick(random, [[3, 2], [2]]),
        targetTokens: 50,
        hardMaxTokens: 60,
        minGainBytes: 0,
      },
    );
  }
});

test('compact boundaries keep the summary prologue and splice survivors', () => {
  const random = rng(0x77778888);
  for (let iteration = 0; iteration < 120; iteration++) {
    const lines = [];
    let previous = null;
    for (let index = 0; index < 6; index++) {
      const uuid = 'p' + index;
      lines.push(JSON.stringify({ type: 'user', uuid, parentUuid: previous, message: { role: 'user', content: 'before ' + text(random) } }));
      previous = uuid;
    }
    const head = pick(random, ['p2', 'p4', 'p0']);
    lines.push(JSON.stringify({
      type: 'system', uuid: 'b', parentUuid: null, subtype: 'compact_boundary',
      compactMetadata: { trigger: 'auto', preservedSegment: { headUuid: head, anchorUuid: null, tailUuid: null } },
    }));
    lines.push(JSON.stringify({ type: 'user', uuid: 's', parentUuid: 'b', isCompactSummary: true, message: { role: 'user', content: 'summary text' } }));
    for (let index = 0; index < int(random, 0, 6); index++) {
      const uuid = 'a' + index;
      lines.push(JSON.stringify({ type: 'user', uuid, parentUuid: index ? 'a' + (index - 1) : 's', message: { role: 'user', content: text(random) } }));
    }
    const body = lines.join('\n') + '\n';
    comparePrune(
      { name: 'compact-' + iteration, body },
      {
        force: true,
        dryRun: random() < 0.5,
        keepTurnsLadder: pick(random, [[4], [2], []]),
        targetTokens: pick(random, [1, 50, 100000]),
        hardMaxTokens: pick(random, [1, 100, 100000]),
        maxEntryBytes: 200 * 1024,
        hardEntryBytes: 400 * 1024,
        minGainBytes: 0,
      },
    );
  }
});

test('orphans are neutralised and chain roots re-rooted identically', () => {
  const long = 'o'.repeat(3000);
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u0', parentUuid: null, message: { role: 'user', content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { body: long } }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'u1', parentUuid: 'u0', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: long }] } }),
    JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-cut', content: long }] } }),
    JSON.stringify({ type: 'user', uuid: 'u3', parentUuid: 'u2', message: { role: 'user', content: 'last real question that is long enough' } }),
  ];
  comparePrune(
    { name: 'orphans', body: lines.join('\n') + '\n' },
    { force: true, maxEntryBytes: 100, hardEntryBytes: 500, keepTurnsLadder: [2], targetTokens: 10, hardMaxTokens: 20, minGainBytes: 0 },
  );
});

test('fractional keep rungs reproduce the legacy destructive edge', () => {
  const lines = [];
  for (let index = 0; index < 8; index++) {
    lines.push(JSON.stringify({ type: 'user', uuid: 'u' + index, parentUuid: index ? 'u' + (index - 1) : null, message: { role: 'user', content: 'question ' + index + ' ' + 'x'.repeat(1200) } }));
  }
  comparePrune(
    { name: 'fractional-keep', body: lines.join('\n') + '\n' },
    { force: true, keepTurnsLadder: [2.5], targetTokens: 1, hardMaxTokens: 1, maxEntryBytes: 100, hardEntryBytes: 400, minGainBytes: 0 },
  );
});

test('missing paths, symlinks and unreadable files resolve identically', () => {
  const dir = sandbox();
  const seed = JSON.stringify({ type: 'user', uuid: 'u', message: { role: 'user', content: 'hello' } }) + '\n';
  const oracleFile = path.join(dir, 'oracle-real.jsonl');
  const subjectFile = path.join(dir, 'subject-real.jsonl');
  fs.writeFileSync(oracleFile, seed);
  fs.writeFileSync(subjectFile, seed);
  const oracleLink = path.join(dir, 'oracle-link.jsonl');
  const subjectLink = path.join(dir, 'subject-link.jsonl');
  fs.symlinkSync(oracleFile, oracleLink);
  fs.symlinkSync(subjectFile, subjectLink);
  const broken = path.join(dir, 'broken.jsonl');
  fs.symlinkSync(path.join(dir, 'absent.jsonl'), broken);

  const missing = path.join(dir, 'nope.jsonl');
  assert.equal(current.pruneFile(missing, { force: true, minGainBytes: 0 }), legacy.pruneFile(missing, { force: true, minGainBytes: 0 }));
  assert.deepEqual(current.measureFile(missing, {}), legacy.measureFile(missing, {}));
  assert.equal(current.pruneFile(broken, { force: true, minGainBytes: 0 }), legacy.pruneFile(broken, { force: true, minGainBytes: 0 }));
  assert.deepEqual(current.measureFile(broken, {}), legacy.measureFile(broken, {}));

  const legacyLink = legacy.pruneFile(oracleLink, { force: true, minGainBytes: 0 });
  const currentLink = current.pruneFile(subjectLink, { force: true, minGainBytes: 0 });
  assert.deepEqual(
    currentLink === null ? null : normalizeReport(currentLink),
    legacyLink === null ? null : normalizeReport(legacyLink),
  );
  assert.deepEqual(fs.readFileSync(subjectFile), fs.readFileSync(oracleFile), 'writes through the link');
  const stamp = new Date('2026-03-04T05:06:07.000Z');
  fs.utimesSync(subjectFile, stamp, stamp);
  fs.utimesSync(oracleFile, stamp, stamp);
  assert.deepEqual(current.measureFile(subjectLink, {}), legacy.measureFile(oracleLink, {}));

  const unreadable = path.join(dir, 'unreadable.jsonl');
  fs.writeFileSync(unreadable, '{}\n');
  fs.chmodSync(unreadable, 0o000);
  try {
    assert.equal(current.pruneFile(unreadable, { force: true, minGainBytes: 0 }), legacy.pruneFile(unreadable, { force: true, minGainBytes: 0 }));
    assert.deepEqual(current.measureFile(unreadable, {}), legacy.measureFile(unreadable, {}));
  } finally {
    fs.chmodSync(unreadable, 0o600);
  }
});

test('project directory lookup and file selection agree', () => {
  const cwd = path.join(root, 'project', 'nested.dir');
  const dir = current.claudeProjectDir(cwd);
  assert.equal(dir, legacy.claudeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(current.findTranscriptFile(cwd, null), legacy.findTranscriptFile(cwd, null));
  const sizes = [['a.jsonl', 10], ['b.jsonl', 40], ['c.jsonl', 40], ['side.pruned.jsonl', 900], ['notes.txt', 9000], ['d.jsonl', 5]];
  for (const [name, size] of sizes) fs.writeFileSync(path.join(dir, name), 'x'.repeat(size));
  fs.symlinkSync(path.join(dir, 'absent.jsonl'), path.join(dir, '0-broken.jsonl'));
  assert.equal(current.findTranscriptFile(cwd, null), legacy.findTranscriptFile(cwd, null));
  assert.equal(current.findTranscriptFile(cwd, 'a'), legacy.findTranscriptFile(cwd, 'a'));
  assert.equal(current.findTranscriptFile(cwd, 'missing'), legacy.findTranscriptFile(cwd, 'missing'));
  assert.equal(current.findTranscriptFile('/definitely/not/here', null), legacy.findTranscriptFile('/definitely/not/here', null));
  assert.equal(current.claudeProjectDir('/中文/路径'), legacy.claudeProjectDir('/中文/路径'));
  assert.equal(current.claudeProjectDir(''), legacy.claudeProjectDir(''));
  assert.equal(current.claudeProjectDir(null), legacy.claudeProjectDir(null));

  const file = path.join(dir, 'b.jsonl');
  const legacyMaybe = legacy.maybePrune(cwd, null, { force: true, minGainBytes: 0, dryRun: true });
  const currentMaybe = current.maybePrune(cwd, null, { force: true, minGainBytes: 0, dryRun: true });
  assert.deepEqual(normalizeReport(currentMaybe), normalizeReport(legacyMaybe));
  assert.deepEqual(current.measure(cwd, null), legacy.measure(cwd, null));
  assert.ok(fs.existsSync(file));
});

// ── pure functions ──────────────────────────────────────────────────────────

function randomValue(random, depth = 0) {
  const kind = random();
  if (depth > 3 || kind < 0.28) {
    return pick(random, [null, true, false, 0, 1, -1, 3.5, '', 'text', '继续', '中文', 'a\ud800b', '   ', '\u0085x', '😀', NaN, Infinity]);
  }
  if (kind < 0.5) return randomValue(random, depth + 1);
  if (kind < 0.68) return Array.from({ length: int(random, 0, 3) }, () => randomValue(random, depth + 1));
  const object = {};
  for (let index = 0; index < int(random, 0, 4); index++) {
    object[pick(random, ['type', 'role', 'content', 'message', 'isMeta', 'isSidechain', 'isCompactSummary', 'text', 'id', 'tool_use_id', '0', '1', 'weird'])] = randomValue(random, depth + 1);
  }
  return object;
}

test('predicates agree on randomized and hand-built values', () => {
  const random = rng(0x0badf00d);
  const values = [
    null, undefined, 0, '', 'hello', [], {}, { type: 'user' },
    { type: 'user', message: { role: 'user', content: '' } },
    { type: 'user', message: { role: 'user', content: '   ' } },
    { type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'user', message: { content: [{ type: 'text', text: 'hi there' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'hi' } },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'hi' } },
    { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'hi' } },
    { message: { role: 'user', content: '[gateway end]\nreal question' } },
    { message: { role: 'user', content: 'x\n[Dispatch]\nnoise' } },
    { message: { role: 'user', content: '<system-reminder>a</system-reminder>b' } },
    { message: { role: 'user', content: '[结束]\n' } },
  ];
  for (let iteration = 0; iteration < 1200; iteration++) values.push(randomValue(random));
  for (const value of values) {
    assert.equal(current.isRealUserTurn(value), legacy.isRealUserTurn(value), JSON.stringify(value));
    assert.equal(current.isSubstantiveTurn(value), legacy.isSubstantiveTurn(value), JSON.stringify(value));
    assert.equal(current.userVisibleText(value), legacy.userVisibleText(value), JSON.stringify(value));
  }
});

test('triggers and compactCutIndex agree', () => {
  const random = rng(0x31415926);
  for (let iteration = 0; iteration < 600; iteration++) {
    const metrics = { fileBytes: pick(random, [0, 1, 100, 2 * 1024 * 1024, 5 * 1024 * 1024]), largestEntryBytes: pick(random, [0, 100, 400 * 1024]) };
    const thresholds = { maxBytes: pick(random, [0, 100, 2 * 1024 * 1024]), hardEntryBytes: pick(random, [100, 400 * 1024]), scanMinBytes: pick(random, [0, 384 * 1024]) };
    assert.deepEqual(current.triggersFor(metrics, thresholds), legacy.triggersFor(metrics, thresholds));
    const lines = Array.from({ length: int(random, 0, 10) }, () => pick(random, [
      '',
      'not json',
      JSON.stringify({ uuid: 'u' + int(random, 0, 5), type: 'user' }),
      JSON.stringify({ uuid: 'u' + int(random, 0, 5), subtype: 'compact_boundary', compactMetadata: { preservedSegment: { headUuid: 'u' + int(random, 0, 5) } } }),
      JSON.stringify({ uuid: 's', isCompactSummary: random() < 0.5 }),
      '{"uuid":"x","parentUuid":"p"}',
    ]));
    assert.deepEqual(current.compactCutIndex(lines), legacy.compactCutIndex(lines));
  }
  assert.deepEqual(
    current.triggersFor({ fileBytes: 10, largestEntryBytes: 0 }, { maxBytes: 100, hardEntryBytes: 50, scanMinBytes: 20 }),
    legacy.triggersFor({ fileBytes: 10, largestEntryBytes: 0 }, { maxBytes: 100, hardEntryBytes: 50, scanMinBytes: 20 }),
  );
  assert.deepEqual(current.triggersFor({}, {}), legacy.triggersFor({}, {}));
});

test('exported defaults match the legacy constants', () => {
  for (const key of ['DEFAULT_MAX_BYTES', 'DEFAULT_TARGET_TOKENS', 'DEFAULT_HARD_MAX_TOKENS', 'DEFAULT_MAX_ENTRY_BYTES', 'DEFAULT_HARD_ENTRY_BYTES', 'DEFAULT_SCAN_MIN_BYTES', 'DEFAULT_TOKEN_WATERMARK']) {
    assert.equal(current[key], legacy[key], key);
  }
  assert.deepEqual(current.DEFAULT_KEEP_TURNS_LADDER, legacy.DEFAULT_KEEP_TURNS_LADDER);
});
