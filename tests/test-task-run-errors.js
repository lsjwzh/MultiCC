'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');
const { createTaskRunStore } = require('../src/task-run-store');
const {
  describeRunFailure,
  recordRunError,
  runErrorOf,
} = require('../src/task-run-errors');

function withStore(t, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-task-run-errors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createTaskRunStore({ file: path.join(dir, 'task-runs.sqlite'), Database });
  t.after(() => { try { store.close(); } catch (_) {} });
  return fn(store);
}

function admitRun(store, runId = 'tr_fail1') {
  store.admitRun({
    run: {
      runId, taskId: 'task-1', attemptId: runId, slotId: null,
      startedAt: 1, metadata: { source: 'task-board' },
    },
    messages: [{
      messageId: `admission:${runId}`, role: 'user', kind: 'admission',
      content: '继续', metadata: {}, createdAt: 1,
    }],
  });
  return runId;
}

test('describeRunFailure maps a structured api error to a human entry', () => {
  const failure = describeRunFailure({
    event: { turnOutcome: 'failed', classifyState: 'E' },
    apiError: {
      category: 'rate_limit', code: 'rate_limited', retryable: true,
      userAction: '等待服务端限流窗口结束',
      rootCause: 'API Error: 429 rate limit',
    },
  });
  assert.equal(failure.code, 'rate_limited');
  assert.equal(failure.category, 'rate_limit');
  assert.equal(failure.retryable, true);
  assert.match(failure.text, /限流/);
  assert.match(failure.text, /根因：API Error: 429 rate limit/);
  assert.match(failure.text, /等待服务端限流窗口结束/);
});

test('describeRunFailure falls back to a generic non-retryable failure without evidence', () => {
  const failure = describeRunFailure({ event: { turnOutcome: 'failed' }, apiError: null });
  assert.equal(failure.code, 'TURN_FAILED');
  assert.equal(failure.category, 'unknown');
  assert.equal(failure.retryable, false);
  assert.ok(failure.text.length > 0);
});

test('describeRunFailure never marks cancellations or credential problems retryable', () => {
  for (const category of ['cancel_shutdown', 'authentication_permission', 'billing_quota', 'context_token_limit']) {
    const failure = describeRunFailure({
      event: { turnOutcome: 'failed' },
      apiError: { category, code: null, retryable: false, userAction: '处理后再试' },
    });
    assert.equal(failure.retryable, false, category);
    assert.equal(failure.category, category);
  }
});

test('recordRunError writes one idempotent system error entry per run', t => {
  withStore(t, store => {
    const runId = admitRun(store);
    const first = recordRunError(store, {
      runId, code: 'rate_limited', category: 'rate_limit', retryable: true,
      message: '任务执行失败（触发服务端限流）：等待服务端限流窗口结束', createdAt: 2,
    });
    assert.equal(first.duplicate, false);
    // A finalizer replay must never throw or double-write, even with a
    // different clock reading.
    const second = recordRunError(store, {
      runId, code: 'rate_limited', category: 'rate_limit', retryable: true,
      message: '任务执行失败（触发服务端限流）：等待服务端限流窗口结束', createdAt: 999,
    });
    assert.equal(second.duplicate, true);
    const entries = store.getRunMessages(runId).filter(message => message.kind === 'error');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].role, 'system');
    assert.equal(entries[0].metadata.code, 'rate_limited');
    assert.equal(entries[0].metadata.category, 'rate_limit');
    assert.equal(entries[0].metadata.retryable, true);
  });
});

test('runErrorOf reads the failure summary back and tolerates missing entries', t => {
  withStore(t, store => {
    const runId = admitRun(store);
    assert.equal(runErrorOf(store, runId), null);
    recordRunError(store, {
      runId, code: 'network_down', category: 'network', retryable: true,
      message: '任务执行失败（网络异常）：可等待受控重试，或稍后手动继续', createdAt: 2,
    });
    assert.deepEqual(runErrorOf(store, runId), {
      code: 'network_down',
      category: 'network',
      retryable: true,
      message: '任务执行失败（网络异常）：可等待受控重试，或稍后手动继续',
    });
    assert.equal(runErrorOf(store, 'tr_missing'), null);
  });
});
