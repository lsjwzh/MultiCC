'use strict';

// Transcript governor tests.
//
// The regressions being locked down here all shipped silently, because every one
// of them failed in a direction that looks like success:
//
//   • the module was required by a path that could never resolve, inside an empty
//     catch, so the gate had simply never run;
//   • the project directory was derived by replacing '/' only, so the lookup
//     missed every multicc worktree session (they all live under `.multicc-worktrees`
//     and Claude Code maps every non-alphanumeric character to '-');
//   • "keep the last N turns" counted tool_result entries as user turns, which
//     both cut far more than N turns and cut mid-turn, orphaning tool_results —
//     an orphan makes the next `--resume` fail as a 400 from the API;
//   • dropping an entry from the middle of the file breaks the parentUuid chain,
//     which silently truncates the replayed conversation at the hole.
//
// So the assertions are mostly structural: after any prune, the file must still be
// a transcript claude can resume — chain walkable, tool pairs intact.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const prune = require('../src/chat/transcript-prune');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-prune-'));
const realHome = process.env.HOME;
// os.homedir() reads $HOME on POSIX, so this redirects ~/.claude/projects/...
process.env.HOME = tmp;

let uuidSeq = 0;
function uuid() {
  uuidSeq += 1;
  return `00000000-0000-4000-8000-${String(uuidSeq).padStart(12, '0')}`;
}

// ── fixture builder ──────────────────────────────────────────────────────────
// Emits entries in the same shape Claude Code writes, chained by parentUuid.
function makeTranscript(cwd, sessionId) {
  const dir = path.join(tmp, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines = [];
  let parent = null;
  const push = (obj) => {
    const entry = { parentUuid: parent, uuid: uuid(), timestamp: '2026-07-30T00:00:00.000Z', ...obj };
    parent = entry.uuid;
    lines.push(JSON.stringify(entry));
    return entry;
  };
  return {
    file,
    lines,
    userTurn(text) {
      return push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    },
    assistantText(text) {
      return push({ type: 'assistant', message: { role: 'assistant', id: `msg_${uuidSeq}`, content: [{ type: 'text', text }] } });
    },
    toolPair(bytes, { sidechain = false } = {}) {
      const id = `toolu_${uuidSeq + 1}`;
      push({
        type: 'assistant', isSidechain: sidechain,
        message: { role: 'assistant', id: `msg_${uuidSeq}`, content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/x' } }] },
      });
      return push({
        type: 'user', isSidechain: sidechain,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(bytes) }] },
        toolUseResult: { stdout: 'y'.repeat(bytes) },
      });
    },
    thinking(text, signature) {
      return push({ type: 'assistant', message: { role: 'assistant', id: `msg_${uuidSeq}`, content: [{ type: 'thinking', thinking: text, signature }] } });
    },
    // A compaction: preserved messages, then the boundary, then the summary.
    compact(preserved) {
      const boundary = push({
        type: 'system', subtype: 'compact_boundary', isMeta: true, content: '',
        compactMetadata: {
          trigger: 'auto', preTokens: 170000,
          preservedSegment: { headUuid: preserved[0].uuid, tailUuid: preserved[preserved.length - 1].uuid },
          preservedMessages: { uuids: preserved.map((e) => e.uuid), allUuids: preserved.map((e) => e.uuid) },
        },
      });
      // Claude writes the boundary as a root; the summary chains off it.
      lines[lines.length - 1] = JSON.stringify({ ...JSON.parse(lines[lines.length - 1]), parentUuid: null });
      const summary = push({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Session summary so far.' } });
      return { boundary, summary };
    },
    write() {
      fs.writeFileSync(file, lines.join('\n') + '\n');
      return file;
    },
  };
}

// ── structural validator: would `claude --resume` accept this file? ───────────
function validate(file, label) {
  const raw = fs.readFileSync(file, 'utf8');
  const entries = raw.split('\n').filter(Boolean).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { assert.fail(`${label}: line ${i} is not JSON: ${e.message}`); }
  });
  const byUuid = new Map();
  for (const e of entries) if (e.uuid) byUuid.set(e.uuid, e);

  // 1. every tool_result's tool_use appears before it
  const seenUses = new Set();
  entries.forEach((e, i) => {
    const content = e.message && e.message.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b && b.type === 'tool_result' && b.tool_use_id) {
        assert.ok(seenUses.has(String(b.tool_use_id)),
          `${label}: orphan tool_result at line ${i} (tool_use ${b.tool_use_id} was cut)`);
      }
    }
    for (const b of content) if (b && b.type === 'tool_use' && b.id) seenUses.add(String(b.id));
  });

  // 2. the chain from the last entry walks to a root with no dangling parent
  let node = entries[entries.length - 1];
  const visited = new Set();
  let hops = 0;
  while (node && node.parentUuid) {
    assert.ok(byUuid.has(node.parentUuid),
      `${label}: dangling parentUuid ${node.parentUuid} — the replay walk stops here, silently truncating context`);
    assert.ok(!visited.has(node.uuid), `${label}: parentUuid cycle at ${node.uuid}`);
    visited.add(node.uuid);
    node = byUuid.get(node.parentUuid);
    assert.ok(++hops <= entries.length + 1, `${label}: chain longer than the file`);
  }

  // 3. no non-empty tool_result content array was emptied out
  for (const e of entries) {
    const content = e.message && e.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === 'tool_result' && Array.isArray(b.content)) {
        assert.ok(b.content.length > 0, `${label}: tool_result content array left empty`);
      }
    }
  }
  return entries;
}

const results = [];
function test(name, fn) {
  fn();
  results.push(name);
}

// ── 1. project-dir mapping ───────────────────────────────────────────────────
test('project dir maps every non-alphanumeric char to a dash', () => {
  const dir = prune.claudeProjectDir('/Users/me/proj/.multicc-worktrees/x-chat-01');
  assert.strictEqual(path.basename(dir),
    '-Users-me-proj--multicc-worktrees-x-chat-01',
    'the dot in .multicc-worktrees must contribute its own dash, or no worktree session is ever found');
  assert.strictEqual(path.basename(prune.claudeProjectDir('/a/b.c_d/e')), '-a-b-c-d-e');
});

// ── 2. real-user-turn predicate ──────────────────────────────────────────────
test('a user-role tool_result is not a user turn', () => {
  const t = prune.isRealUserTurn;
  assert.strictEqual(t({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }), true);
  assert.strictEqual(t({ type: 'user', message: { role: 'user', content: 'plain string' } }), true);
  assert.strictEqual(t({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'out' }] } }), false,
    'tool results outnumber real turns ~7:1 — counting them collapses keepTurns');
  assert.strictEqual(t({ type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'text', text: 'sub' }] } }), false);
  assert.strictEqual(t({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'meta' }] } }), false);
  assert.strictEqual(t({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary' } }), false);
  assert.strictEqual(t({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }), false);
  assert.strictEqual(t({ type: 'user', message: { role: 'user', content: [] } }), false);
  assert.strictEqual(t(null), false);
});

// ── 3. below the high-water mark: one stat(), no rewrite ─────────────────────
test('a small transcript is left alone', () => {
  const cwd = '/tmp/prune-small';
  const t = makeTranscript(cwd, 'sess-small');
  t.userTurn('hello');
  t.assistantText('hi');
  const file = t.write();
  const before = fs.readFileSync(file, 'utf8');
  assert.strictEqual(prune.maybePrune(cwd, 'sess-small'), null);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'no rewrite below the threshold');
});

// ── 4. elision of oversized entries, with the tail window protected ──────────
test('oversized entries are elided, the freshest are protected, thinking is untouched', () => {
  const cwd = '/tmp/prune-elide';
  const t = makeTranscript(cwd, 'sess-elide');
  t.userTurn('do a lot of work');
  const sig = 'sig-must-survive-byte-for-byte';
  t.thinking('reasoning text', sig);
  for (let i = 0; i < 8; i++) t.toolPair(300 * 1024);   // 8 blobs over the hard ceiling
  // Fresh output: over the ordinary threshold but under the hard ceiling, and
  // inside the tail window — this is the case protection exists for.
  const fresh = t.toolPair(120 * 1024);
  t.assistantText('done');
  const file = t.write();

  const report = prune.maybePrune(cwd, 'sess-elide');
  assert.ok(report, 'over the high-water mark, so it must act');
  assert.ok(report.elidedEntries > 0, 'blob entries must be elided');
  assert.ok(report.afterBytes < report.beforeBytes / 2, `expected a big win, got ${report.afterBytes} from ${report.beforeBytes}`);
  assert.strictEqual(report.lostTurns, 0, 'no compaction and few turns: nothing should be dropped');
  assert.strictEqual(report.contextAffected, true, 'elision changes what the model sees');

  const entries = validate(file, 'elide');
  assert.strictEqual(entries.length, t.lines.length, 'elision must not remove entries');
  const think = entries.find((e) => (e.message && Array.isArray(e.message.content) && e.message.content.some((b) => b.type === 'thinking')));
  assert.ok(think, 'the thinking entry survives');
  assert.strictEqual(think.message.content[0].signature, sig, 'a rewritten signature fails verification upstream');
  assert.strictEqual(think.message.content[0].thinking, 'reasoning text', 'thinking text is what the signature covers');
  // Fresh, oversized, but under the hard ceiling: protected verbatim.
  const keptFresh = entries.find((e) => e.uuid === fresh.uuid);
  assert.ok(keptFresh && JSON.stringify(keptFresh).length > 200 * 1024,
    'the freshest tool output is what the model is working from — keep it verbatim');
  // Above the hard ceiling, being fresh buys nothing: one such entry is ~100K
  // tokens by itself, which is the overflow we are here to prevent.
  const huge = entries.filter((e) => JSON.stringify(e).length > 400 * 1024);
  assert.strictEqual(huge.length, 0, 'no entry may survive above the hard per-entry ceiling');
});

// ── 5. compact-boundary cut: free bytes, zero context loss ───────────────────
test('the cut lands at the last compaction and keeps its preserved messages', () => {
  const cwd = '/tmp/prune-compact';
  const t = makeTranscript(cwd, 'sess-compact');
  t.userTurn('old turn one');
  for (let i = 0; i < 6; i++) t.toolPair(400 * 1024);    // ~5MB of pre-compaction weight
  t.userTurn('old turn two');
  const preservedA = t.assistantText('tail of the preserved segment');
  const preservedPair = t.toolPair(100);
  const { summary } = t.compact([preservedA, preservedPair]);
  t.userTurn('fresh turn after compaction');
  t.assistantText('working on it');
  const file = t.write();

  const report = prune.maybePrune(cwd, 'sess-compact');
  assert.ok(report, 'over the high-water mark');
  assert.ok(report.strategy.startsWith('compact-cut'), `expected a boundary cut, got ${report.strategy}`);
  assert.strictEqual(report.lostTurns, 0, 'pre-boundary turns are already replaced by claude\'s summary');
  assert.strictEqual(report.contextAffected, false,
    'a boundary cut removes only what claude already ignores — no reason to recycle a warm process');
  assert.strictEqual(report.keptSummary, true);

  const entries = validate(file, 'compact');
  const uuids = new Set(entries.map((e) => e.uuid));
  assert.ok(uuids.has(preservedA.uuid) && uuids.has(preservedPair.uuid),
    'preserved messages are re-attached by uuid from compactMetadata, so cutting them dangles the reference');
  assert.ok(uuids.has(summary.uuid), 'the summary carries the model\'s memory of everything before');
  assert.ok(entries.length < t.lines.length, 'pre-boundary weight is gone');

  // sidecar keeps the removed rows so global token accounting still sees their usage
  const sidecar = file.replace(/\.jsonl$/, '.pruned.jsonl');
  assert.ok(fs.existsSync(sidecar), 'removed rows must be preserved for token accounting');
  const kept = new Set(entries.map((e) => e.uuid));
  for (const line of fs.readFileSync(sidecar, 'utf8').split('\n').filter(Boolean)) {
    const o = JSON.parse(line);
    if (o.uuid) assert.ok(!kept.has(o.uuid), `row ${o.uuid} is in both the live file and the sidecar — usage would double-count`);
  }
});

// ── 6. lossy tier: cuts at real turn boundaries and keeps the summary ────────
test('when elision is not enough, whole turns go — at turn boundaries, summary retained', () => {
  const cwd = '/tmp/prune-turns';
  const t = makeTranscript(cwd, 'sess-turns');
  t.userTurn('ancient turn');
  const pA = t.assistantText('preserved');
  const { summary } = t.compact([pA]);
  // 30 post-compaction turns whose tool traffic is individually *below* even the
  // tightest elision threshold — death by a thousand cuts. Eliding cannot help, so
  // the only lever left is dropping turns.
  for (let i = 0; i < 30; i++) {
    t.userTurn(`turn ${i}`);
    for (let j = 0; j < 10; j++) t.toolPair(10 * 1024);
  }
  const file = t.write();

  const report = prune.maybePrune(cwd, 'sess-turns');
  assert.ok(report, 'over the high-water mark');
  assert.ok(/^keep-\d+-turns$/.test(report.strategy), `expected the lossy tier, got ${report.strategy}`);
  assert.ok(report.lostTurns > 0, 'the lossy tier does lose turns — that is what makes it lossy');
  assert.strictEqual(report.contextAffected, true);
  assert.strictEqual(report.keptSummary, true,
    'a turn cut must not also throw away claude\'s own summary of the session');

  const entries = validate(file, 'turns');
  assert.ok(entries.some((e) => e.uuid === summary.uuid), 'summary retained as a prologue');
  // the survivors must be grafted onto the summary, not orphaned into a second root
  const roots = entries.filter((e) => e.parentUuid === null || e.parentUuid === undefined);
  assert.ok(roots.length <= 2, `expected at most the boundary as a root, found ${roots.length}`);
  // and the first real turn kept must be a real turn, not a mid-turn tool_result
  const firstAfterSummary = entries[entries.findIndex((e) => e.uuid === summary.uuid) + 1];
  assert.ok(prune.isRealUserTurn(firstAfterSummary),
    'the cut must land on a real user turn, or the replay starts mid-tool-call');
});

// ── 7. dry run ───────────────────────────────────────────────────────────────
test('dryRun reports without touching the file', () => {
  const cwd = '/tmp/prune-dry';
  const t = makeTranscript(cwd, 'sess-dry');
  t.userTurn('hello');
  for (let i = 0; i < 6; i++) t.toolPair(400 * 1024);
  const file = t.write();
  const before = fs.readFileSync(file, 'utf8');
  const report = prune.maybePrune(cwd, 'sess-dry', { dryRun: true });
  assert.ok(report && report.dryRun === true);
  assert.ok(report.afterBytes < report.beforeBytes);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'dry run must not write');
  assert.ok(!fs.existsSync(file.replace(/\.jsonl$/, '.pruned.jsonl')), 'dry run must not write a sidecar');
});

// ── 8. the sidecar is never mistaken for the transcript ──────────────────────
test('a .pruned.jsonl sidecar is never selected as the file to resume', () => {
  const cwd = '/tmp/prune-sidecar';
  const t = makeTranscript(cwd, 'sess-sidecar');
  t.userTurn('hi');
  const file = t.write();
  const sidecar = file.replace(/\.jsonl$/, '.pruned.jsonl');
  fs.writeFileSync(sidecar, 'x'.repeat(5 * 1024 * 1024));  // bigger than the real one
  assert.strictEqual(prune.findTranscriptFile(cwd, 'sess-sidecar'), file);
  assert.strictEqual(prune.findTranscriptFile(cwd, null), file, 'the largest-file fallback must skip sidecars');
});

// ── 9. the call site actually resolves (this is how the gate died) ───────────
test('every require of the prune module in src/ resolves', () => {
  const roots = [path.join(__dirname, '..', 'src'), path.join(__dirname, '..', 'scripts')];
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name.endsWith('.js')) files.push(p);
    }
  };
  roots.forEach(walk);
  let found = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /require\(\s*['"]([^'"]*transcript-prune[^'"]*)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      found += 1;
      const spec = m[1];
      assert.doesNotThrow(
        () => require.resolve(spec.startsWith('.') ? path.resolve(path.dirname(f), spec) : spec),
        `${path.relative(path.join(__dirname, '..'), f)} requires '${spec}', which does not resolve — ` +
        'inside a catch this makes the whole context gate a no-op with no log line',
      );
    }
  }
  assert.ok(found > 0, 'expected at least one call site to guard');
});

process.env.HOME = realHome;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`transcript-prune tests passed (${results.length})`);
