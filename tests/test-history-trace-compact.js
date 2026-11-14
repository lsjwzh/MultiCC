'use strict';
// Covers scripts/history-trace-compact.js. The tool rewrites real conversation
// history, so the tests pin the two properties that make it safe to run:
// everything outside the contextTrace span survives byte-for-byte, and a line
// whose guarded fields would change is skipped rather than rewritten.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  scanJsonValue, findTopLevelTrace, summarizeTrace, rewriteLine, guardedEqual, planFile, applyFile, parseArgs,
} = require('../scripts/history-trace-compact.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-trace-compact-'));
}

const fullTrace = {
  version: 1,
  traceId: 'receipt-1',
  currentTask: { taskId: 't1', taskName: 'Task One', mode: 'native' },
  sources: [
    { taskId: 'a', taskName: 'A', mode: 'imported', messageCount: 3, excerpt: 'x'.repeat(400) },
    { taskId: 'b', taskName: 'B', mode: 'graph:task', messageCount: 0, excerpt: 'y'.repeat(400) },
  ],
  retained: [{ id: 'r1', bytes: 10 }],
  omitted: [{ id: 'o1', reason: 'budget' }],
  diagnostics: ['d'.repeat(500)],
  budget: { limit: 8000, used: 1234 },
  contextStatus: 'ok',
};

test('scanJsonValue walks containers, strings and escapes without being fooled', () => {
  // A brace and a quote inside a string must not end the object early.
  const tricky = '{"a":"}\\"{","b":[1,{"c":"]"}],"d":null}';
  assert.equal(scanJsonValue(tricky, 0), tricky.length);
  assert.equal(scanJsonValue('"plain"', 0), 7);
  assert.equal(scanJsonValue('  "pad"', 0), 7);
  // A trailing backslash inside a string is an escape, not a terminator.
  const escaped = '"a\\\\"';
  assert.equal(scanJsonValue(escaped, 0), escaped.length);
  assert.equal(scanJsonValue('123,', 0), 3);
  assert.equal(scanJsonValue('true}', 0), 4);
  assert.throws(() => scanJsonValue('{"a":1', 0), /unterminated object/);
  assert.throws(() => scanJsonValue('"abc', 0), /unterminated string/);
});

test('summarizeTrace keeps the runtime summary shape and skips what it should', () => {
  const summary = summarizeTrace(fullTrace);
  assert.deepEqual(Object.keys(summary),
    ['version', 'traceId', 'currentTask', 'managedOnly', 'summary', 'count', 'budget', 'contextStatus']);
  assert.equal(summary.summary, true);
  assert.equal(summary.managedOnly, true);
  // count is the current task plus every source, matching runtime.js.
  assert.equal(summary.count, 3);
  assert.deepEqual(summary.currentTask, fullTrace.currentTask);
  assert.deepEqual(summary.budget, fullTrace.budget);
  // Already-summarized, malformed and non-object traces are left alone.
  assert.equal(summarizeTrace({ ...fullTrace, summary: true }), null);
  assert.equal(summarizeTrace({ traceId: 'x' }), null);
  assert.equal(summarizeTrace({ currentTask: {} }), null);
  assert.equal(summarizeTrace(null), null);
  assert.equal(summarizeTrace([1, 2]), null);
  // A trace with no sources still counts the current task itself.
  assert.equal(summarizeTrace({ traceId: 'r', currentTask: { taskId: 'c' } }).count, 1);
});

test('rewriteLine replaces only the contextTrace span and leaves other bytes identical', () => {
  const message = {
    role: 'assistant',
    content: 'hello }{" world',
    ts: 1763000000000,
    id: 'm1',
    tools: [{ name: 'Bash', input: { command: 'echo "}"' } }],
    contextTrace: fullTrace,
    usage: { input_tokens: 5 },
    taskId: 'task-1',
  };
  const line = JSON.stringify(message);
  const result = rewriteLine(line);
  assert.ok(result, 'the line should be rewritten');
  assert.ok(result.after < result.before);

  // Everything before and after the trace span is unchanged, byte for byte.
  const key = '"contextTrace":';
  assert.equal(result.line.slice(0, line.indexOf(key)), line.slice(0, line.indexOf(key)));
  const parsed = JSON.parse(result.line);
  assert.equal(parsed.content, message.content);
  assert.equal(parsed.ts, message.ts);
  assert.deepEqual(parsed.tools, message.tools);
  assert.deepEqual(parsed.usage, message.usage);
  assert.equal(parsed.taskId, message.taskId);
  assert.equal(parsed.contextTrace.summary, true);
  assert.equal(parsed.contextTrace.count, 3);
  // Key order of the message itself is preserved.
  assert.deepEqual(Object.keys(parsed), Object.keys(message));

  // Idempotent: a summarized line is not rewritten again.
  assert.equal(rewriteLine(result.line), null);
  // Lines without the key, and already-small traces, are untouched.
  assert.equal(rewriteLine(JSON.stringify({ role: 'user', content: 'hi' })), null);
  assert.equal(rewriteLine(JSON.stringify({ contextTrace: { traceId: 'r', currentTask: { taskId: 'c' }, summary: true } })), null);
});

test('the trace key is found as a top-level member, not by searching raw bytes', () => {
  // Real history hit this: a message that discusses this very field carries the
  // literal `"contextTrace":` inside its content, ahead of the actual member.
  // An indexOf-based lookup spliced into the text and the guard had to reject
  // the whole line, silently losing the reclaim.
  const quoted = 'the writer sets "contextTrace":{"sources":[1,2]} on every turn';
  const message = { role: 'assistant', content: quoted, ts: 7, contextTrace: fullTrace };
  const line = JSON.stringify(message);

  const at = findTopLevelTrace(line);
  assert.ok(at > line.indexOf(quoted.slice(0, 20)), 'must resolve past the quoting content');
  const result = rewriteLine(line);
  assert.ok(result, 'the real member should still be rewritten');
  const parsed = JSON.parse(result.line);
  assert.equal(parsed.content, quoted, 'content survives untouched');
  assert.equal(parsed.contextTrace.summary, true);
  assert.equal(guardedEqual(line, result.line), true);

  // Content that mentions the key while the message has no such member is a
  // no-op, not a corrupted line.
  const decoy = JSON.stringify({ role: 'user', content: '"contextTrace":{"a":1}', ts: 8 });
  assert.equal(findTopLevelTrace(decoy), -1);
  assert.equal(rewriteLine(decoy), null);

  // Nested occurrences (inside tools) must not be mistaken for the member.
  const nested = JSON.stringify({ role: 'assistant', tools: [{ out: '"contextTrace":{}' }], ts: 9 });
  assert.equal(findTopLevelTrace(nested), -1);
  assert.equal(rewriteLine(nested), null);

  // Not an object, or a truncated object: reported as "no member", never spliced.
  assert.equal(findTopLevelTrace('[1,2,3]'), -1);
  assert.equal(findTopLevelTrace('   {"role":"user"}'), -1);
});

test('rewriteLine reports malformed contextTrace instead of silently dropping it', () => {
  assert.throws(() => rewriteLine('{"contextTrace":{"traceId":}}'), /not valid JSON/);
});

test('guardedEqual rejects any change to conversation-bearing fields', () => {
  const original = JSON.stringify({ role: 'user', content: 'keep', ts: 1, contextTrace: fullTrace });
  const good = rewriteLine(original).line;
  assert.equal(guardedEqual(original, good), true);
  // A rewrite that altered content must be refused even if the trace shrank.
  const tampered = JSON.stringify({ role: 'user', content: 'changed', ts: 1, contextTrace: summarizeTrace(fullTrace) });
  assert.equal(guardedEqual(original, tampered), false);
  // A rewrite that failed to summarize is also refused.
  assert.equal(guardedEqual(original, original), false);
  assert.equal(guardedEqual('not json', good), false);
});

test('planFile measures reclaimable bytes and flags unparseable traces', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'session.json');
  const lines = [
    JSON.stringify({ role: 'user', content: 'q', ts: 1 }),
    JSON.stringify({ role: 'assistant', content: 'a', ts: 2, contextTrace: fullTrace }),
    JSON.stringify({ role: 'assistant', content: 'b', ts: 3, contextTrace: { ...fullTrace, summary: true } }),
    '{"role":"assistant","content":"c","contextTrace":{"traceId":}}',
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const plan = await planFile(file);
  assert.equal(plan.lines, 4);
  assert.equal(plan.changed, 1, 'only the one full trace is reclaimable');
  assert.ok(plan.before > plan.after);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /line 4/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyFile rewrites atomically, verifies, backs up and preserves every other line', async () => {
  const dir = tempDir();
  const backup = path.join(dir, 'backup');
  const file = path.join(dir, 'session.json');
  const untouched = JSON.stringify({ role: 'user', content: 'keep me', ts: 1, tools: [{ a: '}' }] });
  const heavy = JSON.stringify({ role: 'assistant', content: 'answer', ts: 2, contextTrace: fullTrace });
  fs.writeFileSync(file, `${untouched}\n${heavy}\n`, { mode: 0o600 });
  const sizeBefore = fs.statSync(file).size;

  const stats = await applyFile(file, backup);
  assert.equal(stats.lines, 2);
  assert.equal(stats.changed, 1);

  const after = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(after.length, 2);
  assert.equal(after[0], untouched, 'a line without a trace is byte-identical');
  assert.equal(JSON.parse(after[1]).content, 'answer');
  assert.equal(JSON.parse(after[1]).contextTrace.summary, true);
  assert.ok(fs.statSync(file).size < sizeBefore);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'permissions stay private');
  // The backup is the original file, not the rewritten one.
  assert.equal(fs.readFileSync(path.join(backup, 'session.json'), 'utf8'), `${untouched}\n${heavy}\n`);
  // No temp file is left behind.
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith('.')), []);

  // Running it again is a no-op.
  const again = await applyFile(file, null);
  assert.equal(again.changed, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseArgs defaults to a dry run and rejects unknown flags', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.apply, false);
  assert.equal(defaults.force, false);
  assert.equal(defaults.minBytes, 4096);
  const parsed = parseArgs(['--apply', '--backup-dir', '/tmp/b', '--limit', '3', '--min-bytes', '0']);
  assert.equal(parsed.apply, true);
  assert.equal(parsed.backupDir, '/tmp/b');
  assert.equal(parsed.limit, 3);
  assert.equal(parsed.minBytes, 0);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});
