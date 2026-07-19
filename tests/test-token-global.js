'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { _compute, _isDerivedCodexRollout } = require('../src/token-global');

const DAY = '2026-07-19';

function row(type, payload, timestamp = `${DAY}T04:00:00.000Z`) {
  return JSON.stringify({ timestamp, type, payload });
}

function usage(input, cached, output) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    total_tokens: input + output,
  };
}

function tokenRow(timestamp, total, last) {
  return row('event_msg', {
    type: 'token_count',
    info: {
      total_token_usage: total,
      ...(last ? { last_token_usage: last } : {}),
    },
  }, timestamp);
}

function rollout(meta, rows, model = 'gpt-test') {
  return [
    row('session_meta', meta, `${DAY}T03:59:00.000Z`),
    row('turn_context', { model }, `${DAY}T03:59:01.000Z`),
    ...rows,
    '',
  ].join('\n');
}

function write(root, relative, text) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

async function withFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-token-global-'));
  const projectsDir = path.join(root, 'claude');
  const codexDir = path.join(root, 'codex');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  try {
    return await run({ root, projectsDir, codexDir });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function bucket(result, model = 'gpt-test') {
  return result.windows.all[model];
}

test('recognizes only explicit Codex derived-rollout metadata', () => {
  assert.equal(_isDerivedCodexRollout({ source: 'exec', thread_source: 'user' }), false);
  assert.equal(_isDerivedCodexRollout({ forked_from_id: 'parent' }), true);
  assert.equal(_isDerivedCodexRollout({ parent_thread_id: 'parent' }), true);
  assert.equal(_isDerivedCodexRollout({ thread_source: 'subagent' }), true);
  assert.equal(_isDerivedCodexRollout({ source: 'subagent' }), true);
  assert.equal(_isDerivedCodexRollout({ source: ['subagent'] }), true);
  assert.equal(_isDerivedCodexRollout({ source: { subagent: { depth: 1 } } }), true);
});

test('counts a main first snapshot but only last usage from each derived first snapshot', async () => {
  await withFixture(async ({ projectsDir, codexDir }) => {
    write(codexDir, 'main.jsonl', rollout(
      { source: 'exec', thread_source: 'user' },
      [
        tokenRow(`${DAY}T04:00:00.000Z`, usage(100, 40, 10), usage(100, 40, 10)),
        tokenRow(`${DAY}T04:01:00.000Z`, usage(130, 50, 16), usage(30, 10, 6)),
      ],
    ));
    write(codexDir, 'fork-a.jsonl', rollout(
      { forked_from_id: 'main', thread_source: 'subagent' },
      [
        tokenRow(`${DAY}T04:02:00.000Z`, usage(1_000, 700, 300), usage(20, 5, 4)),
        tokenRow(`${DAY}T04:03:00.000Z`, usage(1_030, 710, 306), usage(30, 10, 6)),
      ],
    ));
    write(codexDir, 'fork-b.jsonl', rollout(
      { source: { subagent: { depth: 1 } }, parent_thread_id: 'main' },
      [tokenRow(`${DAY}T04:04:00.000Z`, usage(2_000, 1_500, 500), usage(12, 2, 3))],
    ));

    const result = await _compute({
      projectsDir, codexDir, now: new Date(`${DAY}T12:00:00.000Z`),
    });
    assert.deepEqual(bucket(result), {
      // main: (60 + 20) fresh; fork-a: (15 + 20); fork-b: 10
      inputTokens: 125,
      outputTokens: 29,
      cacheWrite: 0,
      cacheRead: 67,
      msgs: 5,
    });
    assert.equal(result.responses, 5);
    assert.equal(result.scannedFiles, 3);
  });
});

test('derived first snapshot without complete trustworthy last usage becomes baseline only', async () => {
  await withFixture(async ({ projectsDir, codexDir }) => {
    const incomplete = { input_tokens: 10, output_tokens: 2 };
    write(codexDir, 'fork.jsonl', rollout(
      { forked_from_id: 'parent' },
      [
        tokenRow(`${DAY}T04:00:00.000Z`, usage(5_000, 4_000, 1_000), incomplete),
        tokenRow(`${DAY}T04:01:00.000Z`, usage(5_020, 4_005, 1_004), usage(20, 5, 4)),
      ],
    ));
    const result = await _compute({ projectsDir, codexDir, now: new Date(`${DAY}T12:00:00Z`) });
    assert.deepEqual(bucket(result), {
      inputTokens: 15,
      outputTokens: 4,
      cacheWrite: 0,
      cacheRead: 5,
      msgs: 1,
    });
  });
});

test('incomplete main cumulative snapshot is ignored and cannot move the baseline', async () => {
  await withFixture(async ({ projectsDir, codexDir }) => {
    write(codexDir, 'main.jsonl', rollout(
      { source: 'exec', thread_source: 'user' },
      [
        tokenRow(`${DAY}T04:00:00.000Z`, {
          input_tokens: 10_000,
          // Deliberately missing cached_input_tokens.
          output_tokens: 2_000,
          total_tokens: 12_000,
        }, usage(10, 2, 1)),
        tokenRow(`${DAY}T04:01:00.000Z`, usage(100, 40, 10), usage(100, 40, 10)),
        tokenRow(`${DAY}T04:02:00.000Z`, usage(120, 45, 14), usage(20, 5, 4)),
      ],
    ));
    const result = await _compute({ projectsDir, codexDir, now: new Date(`${DAY}T12:00:00Z`) });
    assert.deepEqual(bucket(result), {
      inputTokens: 75,
      outputTokens: 14,
      cacheWrite: 0,
      cacheRead: 45,
      msgs: 2,
    });
    assert.equal(result.responses, 2);
  });
});

test('fresh-to-cache reclassification cannot double-count the same cumulative input', async () => {
  await withFixture(async ({ projectsDir, codexDir }) => {
    write(codexDir, 'rollout.jsonl', rollout(
      { source: 'exec', thread_source: 'user' },
      [
        tokenRow(`${DAY}T04:00:00.000Z`, usage(100, 0, 10), usage(100, 0, 10)),
        // The same 100 input tokens were reclassified as cached. The whole
        // vector is non-monotonic and must not add another 100 tokens.
        tokenRow(`${DAY}T04:01:00.000Z`, usage(100, 100, 10), usage(0, 100, 0)),
        // Once all exclusive buckets exceed the accepted baseline, the safe
        // delta is 10 fresh + 100 cached + 10 output.
        tokenRow(`${DAY}T04:02:00.000Z`, usage(210, 100, 20), usage(110, 0, 10)),
      ],
    ));
    const result = await _compute({ projectsDir, codexDir, now: new Date(`${DAY}T12:00:00Z`) });
    assert.deepEqual(bucket(result), {
      inputTokens: 110,
      outputTokens: 20,
      cacheWrite: 0,
      cacheRead: 100,
      msgs: 2,
    });
    assert.equal(result.responses, 2);
  });
});

test('a higher cumulative snapshot is counted even when its timestamp moves backward', async () => {
  await withFixture(async ({ projectsDir, codexDir }) => {
    write(codexDir, 'rollout.jsonl', rollout(
      { source: 'exec', thread_source: 'user' },
      [
        tokenRow(`${DAY}T04:10:00.000Z`, usage(100, 20, 10), usage(100, 20, 10)),
        tokenRow('2026-07-18T04:05:00.000Z', usage(120, 25, 12), usage(20, 5, 2)),
      ],
    ));
    const result = await _compute({ projectsDir, codexDir, now: new Date(`${DAY}T12:00:00Z`) });
    assert.deepEqual(bucket(result), {
      inputTokens: 95,
      outputTokens: 12,
      cacheWrite: 0,
      cacheRead: 25,
      msgs: 2,
    });
    assert.equal(result.byDay['2026-07-18']['gpt-test'], 22,
      'timestamp controls the delta day, not whether a higher cumulative value is accepted');
  });
});

test('duplicates, lower snapshots and cumulative resets fail closed at vector high-water marks', async () => {
  await withFixture(async ({ projectsDir, codexDir }) => {
    write(codexDir, 'rollout.jsonl', rollout(
      { source: 'exec', thread_source: 'user' },
      [
        tokenRow(`${DAY}T04:00:00.000Z`, usage(100, 40, 10), usage(100, 40, 10)),
        tokenRow(`${DAY}T04:01:00.000Z`, usage(120, 45, 14), usage(20, 5, 4)),
        tokenRow(`${DAY}T04:01:00.000Z`, usage(120, 45, 14), usage(20, 5, 4)),
        // A lower snapshot is ignored without moving the baseline, regardless
        // of its timestamp.
        tokenRow(`${DAY}T04:00:30.000Z`, usage(110, 42, 12), usage(10, 2, 2)),
        // A real or corrupt reset must not be counted from zero.
        tokenRow(`${DAY}T04:02:00.000Z`, usage(10, 3, 1), usage(10, 3, 1)),
        tokenRow(`${DAY}T04:03:00.000Z`, usage(20, 5, 2), usage(10, 2, 1)),
        // Only values beyond the old high-water mark become attributable.
        tokenRow(`${DAY}T04:04:00.000Z`, usage(125, 47, 16), usage(105, 42, 14)),
      ],
    ));
    const result = await _compute({ projectsDir, codexDir, now: new Date(`${DAY}T12:00:00Z`) });
    assert.deepEqual(bucket(result), {
      inputTokens: 78, // 60 initial + 15 normal delta + 3 above high-water
      outputTokens: 16,
      cacheWrite: 0,
      cacheRead: 47,
      msgs: 3,
    });
    assert.equal(result.responses, 3);
  });
});

test('resume files for one native Codex thread share a single cumulative high-water', async () => {
  await withFixture(async ({ projectsDir, codexDir }) => {
    write(codexDir, '01-first.jsonl', rollout(
      { id: 'native-thread-1', source: 'exec', thread_source: 'user' },
      [
        tokenRow(`${DAY}T04:00:00.000Z`, usage(100, 40, 10), usage(100, 40, 10)),
        tokenRow(`${DAY}T04:01:00.000Z`, usage(150, 60, 18), usage(50, 20, 8)),
      ],
    ));
    write(codexDir, '02-resume.jsonl', rollout(
      { id: 'native-thread-1', source: 'exec', thread_source: 'user' },
      [
        // Resume starts by replaying the previously accepted cumulative total.
        tokenRow(`${DAY}T05:00:00.000Z`, usage(150, 60, 18), usage(50, 20, 8)),
        tokenRow(`${DAY}T05:01:00.000Z`, usage(180, 75, 24), usage(30, 15, 6)),
      ],
    ));
    write(codexDir, '03-second-resume.jsonl', rollout(
      { id: 'native-thread-1', source: 'exec', thread_source: 'user' },
      [tokenRow(`${DAY}T06:00:00.000Z`, usage(200, 80, 27), usage(20, 5, 3))],
    ));

    const result = await _compute({ projectsDir, codexDir, now: new Date(`${DAY}T12:00:00Z`) });
    assert.deepEqual(bucket(result), {
      inputTokens: 120,
      outputTokens: 27,
      cacheWrite: 0,
      cacheRead: 80,
      msgs: 4,
    });
    assert.equal(result.responses, 4);
    assert.equal(result.scannedFiles, 3);
  });
});

test('week can cross the month boundary and future records stay out of current windows', async () => {
  await withFixture(async ({ projectsDir, codexDir }) => {
    const claudeRow = (timestamp, id, input) => JSON.stringify({
      timestamp,
      requestId: `request-${id}`,
      message: {
        id: `message-${id}`,
        model: 'claude-test',
        usage: {
          input_tokens: input,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    write(projectsDir, 'claude.jsonl', [
      claudeRow('2026-07-31T12:00:00', 'week-before-month', 10),
      claudeRow('2026-08-01T12:00:00', 'today', 20),
      claudeRow('2026-08-02T12:00:00', 'future', 40),
      '',
    ].join('\n'));
    const result = await _compute({
      projectsDir, codexDir, now: new Date('2026-08-01T18:00:00'),
    });
    assert.equal(result.windows.all['claude-test'].inputTokens, 70);
    assert.equal(result.windows.week['claude-test'].inputTokens, 30,
      'Friday July 31 remains in the Monday-start week containing August 1');
    assert.equal(result.windows.month['claude-test'].inputTokens, 20);
    assert.equal(result.windows.today['claude-test'].inputTokens, 20);
  });
});

test('re-scanning the same files is deterministic and does not accumulate again', async () => {
  await withFixture(async ({ projectsDir, codexDir }) => {
    write(codexDir, 'fork.jsonl', rollout(
      { thread_source: 'subagent', parent_thread_id: 'parent' },
      [
        tokenRow(`${DAY}T04:00:00.000Z`, usage(900, 600, 200), usage(9, 4, 2)),
        tokenRow(`${DAY}T04:01:00.000Z`, usage(915, 606, 205), usage(15, 6, 5)),
      ],
    ));
    const options = { projectsDir, codexDir, now: new Date(`${DAY}T12:00:00Z`) };
    const first = await _compute(options);
    const second = await _compute(options);
    assert.deepEqual(second.windows, first.windows);
    assert.deepEqual(second.byDay, first.byDay);
    assert.equal(second.responses, first.responses);
    assert.equal(second.scannedFiles, first.scannedFiles);
  });
});

test('Claude zero-usage duplicate does not reserve the response identity', async () => {
  await withFixture(async ({ projectsDir, codexDir }) => {
    const base = {
      timestamp: `${DAY}T05:00:00.000Z`,
      requestId: 'request-1',
      message: { id: 'message-1', model: 'claude-test' },
    };
    write(projectsDir, 'claude.jsonl', [
      JSON.stringify({ ...base, message: { ...base.message, usage: {
        input_tokens: 0, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      } } }),
      JSON.stringify({ ...base, message: { ...base.message, usage: {
        input_tokens: 7, output_tokens: 3,
        cache_creation_input_tokens: 2, cache_read_input_tokens: 5,
      } } }),
      '',
    ].join('\n'));
    const result = await _compute({ projectsDir, codexDir, now: new Date(`${DAY}T12:00:00Z`) });
    assert.deepEqual(bucket(result, 'claude-test'), {
      inputTokens: 7,
      outputTokens: 3,
      cacheWrite: 2,
      cacheRead: 5,
      msgs: 1,
    });
    assert.equal(result.responses, 1);
  });
});
