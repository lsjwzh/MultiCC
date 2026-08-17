'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const {
  createTaskRunStore,
  extractArtifactReferences,
  open,
} = require('../src/task-run-store');

function tempDatabase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-task-run-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'task-execution.sqlite') };
}

function runInput(overrides = {}) {
  return {
    runId: 'run-1',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    slotId: 'slot-1',
    ...overrides,
  };
}

function usageEvent(overrides = {}) {
  return {
    eventId: 'usage-event-1',
    sourceEventId: 'provider-request-1',
    occurredAt: 1_750_000_000_000,
    providerId: 'provider-a',
    providerName: 'Provider A',
    cli: 'codex',
    protocol: 'openai-responses',
    model: 'model-a',
    roleKind: 'main',
    routeName: 'main',
    source: 'exact',
    coverage: 'observed',
    status: 'success',
    tokens: {
      input: 10,
      cacheRead: 20,
      cacheWrite: 3,
      output: 4,
      reasoning: 2,
    },
    ...overrides,
  };
}

function seal(store, runId, executionStatus = 'succeeded') {
  return store.sealUsage({
    runId,
    executionStatus,
    outcomeDurable: true,
    producersDrained: true,
    nativeTranscriptChecked: true,
  });
}

test('opens a private WAL/FULL SQLite store and persists runs and ordered messages', t => {
  const files = tempDatabase(t);
  let clock = 100;
  const store = open({ file: files.file, now: () => ++clock, Database });
  t.after(() => store.close());

  assert.equal(fs.statSync(files.file).mode & 0o777, 0o600);
  assert.deepEqual(store.settings, { journalMode: 'wal', synchronous: 2, foreignKeys: 1 });
  const probe = new Database(files.file, { readonly: true });
  assert.equal(probe.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(probe.pragma('quick_check', { simple: true }), 'ok');
  probe.close();

  assert.deepEqual(store.beginRun(runInput({ metadata: { contextHash: 'sha256:a' } })), {
    runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', slotId: 'slot-1',
    leaseEpoch: 1,
    executionStatus: 'running', usageStatus: 'collecting', usageRevision: 0,
    sealedRevision: null, cleanupState: 'blocked', startedAt: 101,
    terminalAt: null, sealedAt: null, cleanedAt: null,
    metadata: { contextHash: 'sha256:a' },
  });
  assert.equal(store.beginRun(runInput()).runId, 'run-1', 'same run admission is idempotent');
  assert.throws(
    () => store.beginRun(runInput({ taskId: 'other-task' })),
    error => error.code === 'TASK_RUN_CONFLICT',
  );

  store.appendMessage({
    runId: 'run-1', messageId: 'm-user', role: 'user', content: 'do work', createdAt: 110,
  });
  store.appendMessage({
    runId: 'run-1', messageId: 'm-assistant', role: 'assistant',
    content: { text: 'done', artifactIds: ['artifact-1'] }, createdAt: 120,
    metadata: { partial: false },
  });
  assert.equal(store.appendMessage({
    runId: 'run-1', messageId: 'm-user', role: 'user', content: 'do work', createdAt: 110,
  }).duplicate, true);
  assert.throws(
    () => store.appendMessage({
      runId: 'run-1', messageId: 'm-user', role: 'user', content: 'changed', createdAt: 110,
    }),
    error => error.code === 'TASK_RUN_MESSAGE_CONFLICT',
  );
  assert.deepEqual(store.getRunMessages('run-1').map(message => message.content), [
    'do work', { text: 'done', artifactIds: ['artifact-1'] },
  ]);
  assert.equal(store.listTaskRuns('task-1').length, 1);
});

test('run admission atomically imports initial history and is restart-idempotent', t => {
  const files = tempDatabase(t);
  let store = createTaskRunStore({ file: files.file, Database });
  const admission = {
    run: runInput({ slotId: null }),
    messages: [
      {
        messageId: 'legacy:user:1', role: 'user', kind: 'legacy_import',
        content: '旧任务原文 /artifacts/imported-1/legacy.txt',
        metadata: { sourceSessionId: 'legacy-session' }, createdAt: 10,
      },
      {
        messageId: 'admission:run-1', role: 'user', kind: 'admission',
        content: '继续处理', metadata: { contextHash: 'hash-1' }, createdAt: 20,
        atRunStart: true,
      },
    ],
  };
  assert.equal(store.admitRun(admission).created, true);
  assert.deepEqual(store.getRunMessages('run-1').map(message => message.content), [
    '旧任务原文 /artifacts/imported-1/legacy.txt', '继续处理',
  ]);
  assert.deepEqual(store.listPinnedArtifactIds(), ['imported-1']);
  store.close();

  store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());
  const replay = store.admitRun({
    run: { ...admission.run, startedAt: 999 },
    messages: admission.messages.map(message => message.atRunStart
      ? { ...message, createdAt: 999 }
      : message),
  });
  assert.equal(replay.created, false);
  assert.equal(replay.messages.every(message => message.duplicate), true);
  assert.equal(store.getRunMessages('run-1').length, 2);
  assert.deepEqual(store.listPinnedArtifactIds(), ['imported-1']);

  assert.throws(() => store.admitRun({
    run: runInput({ runId: 'run-rollback', taskId: 'task-rollback' }),
    messages: [
      { messageId: 'same', role: 'user', content: 'one', createdAt: 30 },
      { messageId: 'same', role: 'user', content: 'two', createdAt: 30 },
    ],
  }), error => error.code === 'TASK_RUN_MESSAGE_CONFLICT');
  assert.throws(() => store.getRun('run-rollback'), error => error.code === 'TASK_RUN_NOT_FOUND',
    'a failed initial import rolls back the run row too');
});

test('message and admission imports pin only strict local artifact references idempotently', t => {
  const files = tempDatabase(t);
  let store = createTaskRunStore({ file: files.file, Database });
  store.beginRun(runInput());
  const content = {
    text: [
      '[report](/artifacts/report_123/index.html?download=1)',
      '<img src="/artifacts/chart-456/plots/chart.png#preview">',
      'https://evil.example/artifacts/remote-999/file.txt',
      'https://evil.example/view?next=/artifacts/query-999/file.txt',
      '/artifacts/traversal-999/safe/../secret.txt',
      '/artifacts/encoded-999/%2e%2e/secret.txt',
      '/not-artifacts/similar-999/file.txt',
      '/artifacts-ish/prefix-999/file.txt',
    ].join(' '),
    attachment: { artifactId: 'bundle_789', relativePath: 'exports/result.json' },
    artifactIds: ['root_pin-1', '../escape', 'bad/id'],
  };
  assert.deepEqual(extractArtifactReferences(content), [
    { artifactId: 'bundle_789', relativePath: 'exports/result.json' },
    { artifactId: 'chart-456', relativePath: 'plots/chart.png' },
    { artifactId: 'report_123', relativePath: 'index.html' },
    { artifactId: 'root_pin-1', relativePath: '' },
  ]);

  const input = {
    runId: 'run-1', messageId: 'artifact-message', role: 'assistant',
    content, createdAt: 120,
  };
  assert.equal(store.appendMessage(input).duplicate, false);
  assert.equal(store.appendMessage(input).duplicate, true);
  assert.deepEqual(store.listTaskArtifacts('task-1').map(item => ({
    runId: item.runId,
    messageId: item.messageId,
    artifactId: item.artifactId,
    relativePath: item.relativePath,
  })), [
    { runId: 'run-1', messageId: 'artifact-message', artifactId: 'bundle_789', relativePath: 'exports/result.json' },
    { runId: 'run-1', messageId: 'artifact-message', artifactId: 'chart-456', relativePath: 'plots/chart.png' },
    { runId: 'run-1', messageId: 'artifact-message', artifactId: 'report_123', relativePath: 'index.html' },
    { runId: 'run-1', messageId: 'artifact-message', artifactId: 'root_pin-1', relativePath: '' },
  ]);
  assert.deepEqual(store.listPinnedArtifactIds(), [
    'bundle_789', 'chart-456', 'report_123', 'root_pin-1',
  ]);
  assert.equal(JSON.stringify(store.listTaskArtifacts('task-1')).includes(files.dir), false,
    'public artifact projections must never contain native absolute paths');

  store.close();
  store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());
  assert.deepEqual(store.listPinnedArtifactIds(), [
    'bundle_789', 'chart-456', 'report_123', 'root_pin-1',
  ], 'pins survive restart');
});

test('schema v3 migration backfills artifact pins from durable messages once', t => {
  const files = tempDatabase(t);
  let store = createTaskRunStore({ file: files.file, Database });
  store.beginRun(runInput());
  store.appendMessage({
    runId: 'run-1', messageId: 'legacy-artifact', role: 'assistant',
    content: '历史产物：/artifacts/legacy_pin-1/reports/final.html', createdAt: 120,
  });
  store.close();

  const legacy = new Database(files.file);
  legacy.exec(`
    DROP TABLE task_run_artifacts;
    UPDATE task_run_meta SET value_text='3' WHERE key='schema_version';
  `);
  legacy.close();

  store = createTaskRunStore({ file: files.file, Database });
  assert.deepEqual(store.listPinnedArtifactIds(), ['legacy_pin-1']);
  assert.deepEqual(store.listTaskArtifacts('task-1').map(item => item.relativePath), [
    'reports/final.html',
  ]);
  store.close();

  store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());
  assert.equal(store.listTaskArtifacts('task-1').length, 1,
    'restarting after migration cannot duplicate a pin');
});

test('schema v4 migration installs durable answer receipts without retaining answer text', t => {
  const files = tempDatabase(t);
  let store = createTaskRunStore({ file: files.file, Database });
  store.beginRun(runInput({ slotId: null }));
  store.close();

  const legacy = new Database(files.file);
  legacy.exec(`
    DROP TABLE task_run_answer_receipts;
    UPDATE task_run_meta SET value_text='4' WHERE key='schema_version';
  `);
  legacy.close();

  store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());
  const answerHash = 'a'.repeat(64);
  const reserved = store.reserveAnswerReceipt({
    runId: 'run-1', requestId: 'request-1', clientMsgId: 'client-1', answerHash,
  });
  assert.equal(reserved.state, 'reserved');
  assert.equal(reserved.duplicate, false);

  const probe = new Database(files.file, { readonly: true });
  assert.equal(Number(probe.prepare(
    "SELECT value_text FROM task_run_meta WHERE key='schema_version'",
  ).get().value_text), 5);
  assert.deepEqual(probe.prepare(`
    SELECT run_id, request_id, client_msg_id, answer_hash, state
    FROM task_run_answer_receipts
  `).get(), {
    run_id: 'run-1', request_id: 'request-1', client_msg_id: 'client-1',
    answer_hash: answerHash, state: 'reserved',
  });
  assert.equal(JSON.stringify(probe.prepare(
    'SELECT * FROM task_run_answer_receipts',
  ).get()).includes('plaintext answer'), false);
  probe.close();
});

test('answer receipts reserve and accept idempotently while conflicting payloads fail across restart', t => {
  const files = tempDatabase(t);
  let clock = 200;
  let store = createTaskRunStore({ file: files.file, now: () => ++clock, Database });
  store.beginRun(runInput({ slotId: null }));
  const identity = {
    runId: 'run-1', requestId: 'request-1', clientMsgId: 'client-1',
    answerHash: 'b'.repeat(64),
  };

  assert.deepEqual(store.reserveAnswerReceipt(identity), {
    ...identity, state: 'reserved', reservedAt: 202, acceptedAt: null,
    updatedAt: 202, duplicate: false,
  });
  assert.deepEqual(store.reserveAnswerReceipt(identity), {
    ...identity, state: 'reserved', reservedAt: 202, acceptedAt: null,
    updatedAt: 202, duplicate: true,
  }, 'a crash after reserve may retry the same payload');
  assert.throws(() => store.reserveAnswerReceipt({
    ...identity, answerHash: 'c'.repeat(64),
  }), error => error.code === 'TASK_RUN_ANSWER_CONFLICT');
  assert.throws(() => store.reserveAnswerReceipt({
    ...identity, clientMsgId: 'client-2',
  }), error => error.code === 'TASK_RUN_ANSWER_CONFLICT');

  assert.deepEqual(store.markAnswerAccepted(identity), {
    ...identity, state: 'accepted', reservedAt: 202, acceptedAt: 203,
    updatedAt: 203, duplicate: false,
  });
  assert.equal(store.markAnswerAccepted(identity).duplicate, true);
  store.close();

  store = createTaskRunStore({ file: files.file, now: () => ++clock, Database });
  t.after(() => store.close());
  assert.deepEqual(store.getAnswerReceipt({
    runId: identity.runId, requestId: identity.requestId,
  }), {
    ...identity, state: 'accepted', reservedAt: 202, acceptedAt: 203, updatedAt: 203,
  });
  assert.equal(store.reserveAnswerReceipt(identity).duplicate, true);
  assert.throws(() => store.reserveAnswerReceipt({
    ...identity, answerHash: 'd'.repeat(64),
  }), error => error.code === 'TASK_RUN_ANSWER_CONFLICT');
});

test('a durably admitted run binds exactly one execution slot before delivery', t => {
  const files = tempDatabase(t);
  const store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());
  store.beginRun(runInput({ slotId: null }));
  assert.equal(store.bindRunSlot({ runId: 'run-1', slotId: 'slot-7' }).slotId, 'slot-7');
  assert.equal(store.bindRunSlot({ runId: 'run-1', slotId: 'slot-7' }).slotId, 'slot-7');
  assert.throws(
    () => store.bindRunSlot({ runId: 'run-1', slotId: 'slot-8' }),
    error => error.code === 'TASK_RUN_SLOT_CONFLICT',
  );
});

test('run replay treats an omitted or null slot as dont-care after durable binding', t => {
  const files = tempDatabase(t);
  const store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());
  const admitted = store.beginRun(runInput({ slotId: null }));
  store.acquireSlotLease({
    runId: admitted.runId, slotId: 'slot-7', leaseEpoch: admitted.leaseEpoch,
  });

  assert.equal(store.beginRun({
    runId: admitted.runId, taskId: admitted.taskId, attemptId: admitted.attemptId,
  }).slotId, 'slot-7');
  assert.equal(store.beginRun(runInput({ slotId: null })).slotId, 'slot-7');
  assert.throws(
    () => store.beginRun(runInput({ slotId: 'slot-8' })),
    error => error.code === 'TASK_RUN_CONFLICT',
  );
});

test('SQLite slot leases are unique, epoch-fenced, monotonic and restart durable', t => {
  const files = tempDatabase(t);
  let store = createTaskRunStore({ file: files.file, Database });
  const first = store.beginRun(runInput({ slotId: null }));
  const second = store.beginRun(runInput({
    runId: 'run-2', taskId: 'task-2', attemptId: 'attempt-2', slotId: null,
  }));
  assert.ok(second.leaseEpoch > first.leaseEpoch);
  assert.deepEqual(store.acquireSlotLease({
    runId: first.runId, slotId: 'slot-1', leaseEpoch: first.leaseEpoch,
  }), {
    slotId: 'slot-1', runId: 'run-1', leaseEpoch: first.leaseEpoch,
    state: 'active', phase: 'acquired', quarantineCode: null,
  });
  assert.equal(store.markSlotLeaseReady({
    runId: first.runId, slotId: 'slot-1', leaseEpoch: first.leaseEpoch,
  }).phase, 'ready');
  assert.throws(
    () => store.acquireSlotLease({
      runId: second.runId, slotId: 'slot-1', leaseEpoch: second.leaseEpoch,
    }),
    error => error.code === 'TASK_RUN_SLOT_LEASE_CONFLICT',
  );
  assert.throws(
    () => store.releaseSlotLease({
      runId: first.runId, slotId: 'slot-1', leaseEpoch: first.leaseEpoch + 1,
    }),
    error => error.code === 'TASK_RUN_SLOT_LEASE_STALE',
  );
  store.close();

  store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());
  assert.equal(store.getSlotLease('slot-1').runId, first.runId);
  store.releaseSlotLease({
    runId: first.runId, slotId: 'slot-1', leaseEpoch: first.leaseEpoch,
  });
  assert.equal(store.getSlotLease('slot-1').state, 'released');
  const acquired = store.acquireSlotLease({
    runId: second.runId, slotId: 'slot-1', leaseEpoch: second.leaseEpoch,
  });
  assert.equal(acquired.runId, second.runId);
  assert.equal(acquired.phase, 'acquired');
  assert.ok(acquired.leaseEpoch > first.leaseEpoch);
  assert.throws(
    () => store.releaseSlotLease({
      runId: first.runId, slotId: 'slot-1', leaseEpoch: first.leaseEpoch,
    }),
    error => error.code === 'TASK_RUN_SLOT_LEASE_STALE',
  );
});

test('slot lease recovery plan distinguishes projection, cleanup resume, stale done and quarantine', t => {
  const files = tempDatabase(t);
  const store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());

  const running = store.beginRun(runInput({ runId: 'run-running', taskId: 'task-running', slotId: null }));
  store.acquireSlotLease({ runId: running.runId, slotId: 'slot-running', leaseEpoch: running.leaseEpoch });
  store.markSlotLeaseReady({ runId: running.runId, slotId: 'slot-running', leaseEpoch: running.leaseEpoch });

  const resuming = store.beginRun(runInput({ runId: 'run-resume', taskId: 'task-resume', slotId: null }));
  store.acquireSlotLease({ runId: resuming.runId, slotId: 'slot-resume', leaseEpoch: resuming.leaseEpoch });
  store.markSlotLeaseReady({ runId: resuming.runId, slotId: 'slot-resume', leaseEpoch: resuming.leaseEpoch });
  store.observeUsage({ runId: resuming.runId, event: usageEvent({ eventId: 'usage-resume' }) });
  seal(store, resuming.runId);
  store.markCleanup({ runId: resuming.runId, permit: store.getCleanupPermit(resuming.runId), state: 'deleting' });

  const done = store.beginRun(runInput({ runId: 'run-done', taskId: 'task-done', slotId: null }));
  store.acquireSlotLease({ runId: done.runId, slotId: 'slot-done', leaseEpoch: done.leaseEpoch });
  store.markSlotLeaseReady({ runId: done.runId, slotId: 'slot-done', leaseEpoch: done.leaseEpoch });
  store.observeUsage({ runId: done.runId, event: usageEvent({ eventId: 'usage-done' }) });
  seal(store, done.runId);
  const donePermit = store.getCleanupPermit(done.runId);
  store.markCleanup({ runId: done.runId, permit: donePermit, state: 'deleting' });
  store.markCleanup({ runId: done.runId, permit: donePermit, state: 'done' });

  const ambiguous = store.beginRun(runInput({ runId: 'run-ambiguous', taskId: 'task-ambiguous', slotId: null }));
  store.acquireSlotLease({ runId: ambiguous.runId, slotId: 'slot-ambiguous', leaseEpoch: ambiguous.leaseEpoch });
  store.quarantineSlotLease({
    runId: ambiguous.runId, slotId: 'slot-ambiguous', leaseEpoch: ambiguous.leaseEpoch,
    code: 'RECOVERY_AMBIGUOUS',
  });

  assert.deepEqual(store.planSlotLeaseRecovery().map(item => ({
    slotId: item.slotId, action: item.action,
  })), [
    { slotId: 'slot-ambiguous', action: 'quarantine' },
    { slotId: 'slot-done', action: 'release_stale' },
    { slotId: 'slot-resume', action: 'resume_cleanup' },
    { slotId: 'slot-running', action: 'restore_projection' },
  ]);
});

test('a crash before reset-ready is planned for a safe reset and ready CAS rejects stale owners', t => {
  const files = tempDatabase(t);
  let store = createTaskRunStore({ file: files.file, Database });
  const run = store.beginRun(runInput({ slotId: null }));
  store.acquireSlotLease({ runId: run.runId, slotId: 'slot-crash', leaseEpoch: run.leaseEpoch });
  store.close();

  store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());
  assert.equal(store.planSlotLeaseRecovery()[0].action, 'reset_barrier');
  assert.throws(
    () => store.markSlotLeaseReady({
      runId: run.runId, slotId: 'slot-crash', leaseEpoch: run.leaseEpoch + 1,
    }),
    error => error.code === 'TASK_RUN_SLOT_LEASE_STALE',
  );
  assert.equal(store.markSlotLeaseReady({
    runId: run.runId, slotId: 'slot-crash', leaseEpoch: run.leaseEpoch,
  }).phase, 'ready');
  assert.equal(store.planSlotLeaseRecovery()[0].action, 'restore_projection');
});

test('schema v2 active leases migrate as acquired and cannot fabricate reset proof', t => {
  const files = tempDatabase(t);
  let store = createTaskRunStore({ file: files.file, Database });
  const run = store.beginRun(runInput({ slotId: null }));
  store.acquireSlotLease({ runId: run.runId, slotId: 'slot-v2', leaseEpoch: run.leaseEpoch });
  store.markSlotLeaseReady({ runId: run.runId, slotId: 'slot-v2', leaseEpoch: run.leaseEpoch });
  store.close();

  const legacy = new Database(files.file);
  legacy.pragma('foreign_keys = OFF');
  legacy.exec(`
    DROP INDEX IF EXISTS idx_task_run_slot_leases_state;
    ALTER TABLE task_run_slot_leases RENAME TO task_run_slot_leases_v3;
    CREATE TABLE task_run_slot_leases (
      slot_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES task_runs(run_id) ON DELETE RESTRICT,
      lease_epoch INTEGER NOT NULL CHECK(lease_epoch >= 1),
      state TEXT NOT NULL CHECK(state IN ('active', 'released', 'quarantined')),
      quarantine_code TEXT,
      acquired_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      released_at INTEGER
    ) WITHOUT ROWID;
    INSERT INTO task_run_slot_leases
      (slot_id, run_id, lease_epoch, state, quarantine_code, acquired_at, updated_at, released_at)
    SELECT slot_id, run_id, lease_epoch, state, quarantine_code, acquired_at, updated_at, released_at
    FROM task_run_slot_leases_v3;
    DROP TABLE task_run_slot_leases_v3;
    UPDATE task_run_meta SET value_text='2' WHERE key='schema_version';
  `);
  legacy.close();

  store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());
  assert.equal(store.getSlotLease('slot-v2').phase, 'acquired');
  assert.equal(store.planSlotLeaseRecovery()[0].action, 'reset_barrier');
});

test('cleanup manifest is durable, exact-lease fenced and content-idempotent', t => {
  const files = tempDatabase(t);
  let store = createTaskRunStore({ file: files.file, Database });
  const run = store.beginRun(runInput({ slotId: null }));
  store.acquireSlotLease({ runId: run.runId, slotId: 'slot-1', leaseEpoch: run.leaseEpoch });
  store.markSlotLeaseReady({ runId: run.runId, slotId: 'slot-1', leaseEpoch: run.leaseEpoch });
  const manifest = {
    runId: run.runId,
    slotId: 'slot-1',
    leaseEpoch: run.leaseEpoch,
    capturedAt: 123,
    nativeRefs: {
      runId: run.runId,
      files: [{ runId: run.runId, path: '/safe/native-1.jsonl', kind: 'jsonl' }],
    },
  };
  const saved = store.saveCleanupManifest(manifest);
  assert.deepEqual(saved, { ...manifest, duplicate: false });
  assert.deepEqual(store.saveCleanupManifest({ ...manifest, capturedAt: 999 }), {
    ...manifest, duplicate: true,
  });
  assert.throws(
    () => store.saveCleanupManifest({
      ...manifest,
      nativeRefs: { runId: run.runId, files: [] },
    }),
    error => error.code === 'TASK_RUN_CLEANUP_MANIFEST_CONFLICT',
  );
  assert.throws(
    () => store.saveCleanupManifest({ ...manifest, leaseEpoch: run.leaseEpoch + 1 }),
    error => error.code === 'TASK_RUN_SLOT_LEASE_STALE',
  );
  store.close();

  store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());
  assert.deepEqual(store.getCleanupManifest(run.runId), manifest);
});

test('recovery fails closed when legacy state binds multiple open runs to one slot', t => {
  const files = tempDatabase(t);
  const store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());
  store.beginRun(runInput({ runId: 'run-a', taskId: 'task-a', slotId: 'slot-shared' }));
  store.beginRun(runInput({ runId: 'run-b', taskId: 'task-b', slotId: 'slot-shared' }));

  const plan = store.planSlotLeaseRecovery();
  assert.equal(plan.length, 2);
  assert.equal(plan.every(item => item.action === 'quarantine_unleased'), true);
  assert.equal(plan.every(item => item.quarantineCode === 'TASK_RUN_SLOT_RECOVERY_AMBIGUOUS'), true);
});

test('UsageObserved events remain idempotent across restart and preserve dimensions', t => {
  const files = tempDatabase(t);
  let store = createTaskRunStore({ file: files.file, Database });
  store.beginRun(runInput());
  assert.deepEqual(store.observeUsage({ runId: 'run-1', event: usageEvent() }), {
    inserted: true, corrected: false, duplicate: false, eventId: 'usage-event-1', revision: 1,
  });
  assert.equal(store.observeUsage({ runId: 'run-1', event: usageEvent() }).duplicate, true);
  store.close();

  store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());
  assert.equal(store.observeUsage({ runId: 'run-1', event: usageEvent() }).duplicate, true);
  const usage = store.getRunUsage('run-1');
  assert.deepEqual(usage.tokens, {
    freshInput: 10, cacheRead: 20, cacheWrite: 3, consumedInput: 33,
    output: 4, reasoning: 2, total: 37,
  });
  assert.equal(usage.observedEvents, 1);
  assert.equal(usage.coverage, 'observed');
  assert.equal(usage.dimensions.length, 1);
  assert.deepEqual(usage.dimensions[0], {
    providerId: 'provider-a', providerName: 'Provider A', model: 'model-a',
    roleKind: 'main', routeName: 'main', freshInput: 10, cacheRead: 20,
    cacheWrite: 3, output: 4, reasoning: 2, observedEvents: 1,
    unobservableEvents: 0,
  });
});

test('an event id cannot cross runs, while a corrected event replaces old aggregation', t => {
  const files = tempDatabase(t);
  const store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());
  store.beginRun(runInput());
  store.beginRun(runInput({ runId: 'run-2', attemptId: 'attempt-2', slotId: 'slot-2' }));
  store.observeUsage({ runId: 'run-1', event: usageEvent() });

  assert.throws(
    () => store.observeUsage({ runId: 'run-2', event: usageEvent() }),
    error => error.code === 'USAGE_EVENT_RUN_CONFLICT',
  );

  const correction = usageEvent({
    providerId: 'provider-b', providerName: 'Provider B', model: 'model-b',
    roleKind: 'sub', agentRole: 'worker', routeName: 'worker',
    tokens: { input: 7, cacheRead: 1, cacheWrite: 0, output: 9, reasoning: 5 },
  });
  assert.deepEqual(store.observeUsage({ runId: 'run-1', event: correction }), {
    inserted: false, corrected: true, duplicate: false, eventId: 'usage-event-1', revision: 2,
  });
  const usage = store.getRunUsage('run-1');
  assert.deepEqual(usage.tokens, {
    freshInput: 7, cacheRead: 1, cacheWrite: 0, consumedInput: 8,
    output: 9, reasoning: 5, total: 17,
  });
  assert.equal(usage.dimensions.length, 1, 'empty old dimension is removed');
  assert.equal(usage.dimensions[0].providerId, 'provider-b');
  assert.equal(usage.dimensions[0].roleKind, 'sub');
  assert.equal(usage.dimensions[0].routeName, 'worker');
});

test('unobservable usage is persisted as unknown rather than a known zero', t => {
  const files = tempDatabase(t);
  const store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());
  store.beginRun(runInput());
  store.observeUsage({
    runId: 'run-1',
    event: usageEvent({
      eventId: 'usage-unobservable', coverage: 'unobservable', status: 'unobservable',
      tokens: null, errorCode: 'USAGE_HEADERS_ABSENT',
    }),
  });

  const before = store.getRunUsage('run-1');
  assert.equal(before.hasKnownUsage, false);
  assert.equal(before.coverage, 'unobservable');
  assert.equal(before.unobservableEvents, 1);
  const sealed = seal(store, 'run-1', 'failed');
  assert.equal(sealed.executionStatus, 'failed');
  assert.equal(sealed.usageStatus, 'unobservable');
  assert.equal(store.getRunUsage('run-1').usageStatus, 'unobservable');
});

test('usage sealing is fail-closed and cleanup permits are revision-fenced', t => {
  const files = tempDatabase(t);
  let clock = 1_000;
  const store = createTaskRunStore({ file: files.file, now: () => ++clock, Database });
  t.after(() => store.close());
  store.beginRun(runInput());
  store.observeUsage({ runId: 'run-1', event: usageEvent() });

  for (const [missing, values] of [
    ['outcome_durable', { outcomeDurable: false, producersDrained: true, nativeTranscriptChecked: true }],
    ['producers_drained', { outcomeDurable: true, producersDrained: false, nativeTranscriptChecked: true }],
    ['native_transcript_checked', { outcomeDurable: true, producersDrained: true, nativeTranscriptChecked: false }],
  ]) {
    assert.throws(
      () => store.sealUsage({ runId: 'run-1', executionStatus: 'succeeded', ...values }),
      error => error.code === 'TASK_RUN_USAGE_SEAL_BLOCKED' && error.reasons.includes(missing),
    );
    assert.equal(store.getCleanupPermit('run-1'), null);
  }

  const sealed = seal(store, 'run-1');
  assert.equal(sealed.usageStatus, 'sealed');
  assert.equal(sealed.usageRevision, 1);
  assert.equal(seal(store, 'run-1').sealedRevision, 1, 'seal is idempotent');
  const oldPermit = store.getCleanupPermit('run-1');
  assert.deepEqual(oldPermit, { runId: 'run-1', revision: 1, issuedAt: 1003 });

  store.observeUsage({
    runId: 'run-1',
    event: usageEvent({ eventId: 'usage-event-2', sourceEventId: 'provider-request-2' }),
  });
  assert.equal(store.getCleanupPermit('run-1'), null, 'late usage invalidates old seal');
  assert.throws(
    () => store.markCleanup({ runId: 'run-1', permit: oldPermit, state: 'done' }),
    error => error.code === 'TASK_RUN_CLEANUP_PERMIT_STALE',
  );

  const resealed = seal(store, 'run-1');
  assert.equal(resealed.usageRevision, 2);
  const permit = store.getCleanupPermit('run-1');
  assert.equal(store.markCleanup({ runId: 'run-1', permit, state: 'deleting' }).cleanupState, 'deleting');
  assert.equal(store.markCleanup({ runId: 'run-1', permit, state: 'done' }).cleanupState, 'done');
  assert.equal(store.getRun('run-1').cleanedAt, 1007);
});

test('successful, failed and cancelled runs seal independently and aggregate by task', t => {
  const files = tempDatabase(t);
  const store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());

  for (const [index, executionStatus] of ['succeeded', 'failed', 'cancelled'].entries()) {
    const runId = `run-${index + 1}`;
    store.beginRun(runInput({ runId, attemptId: `attempt-${index + 1}`, slotId: `slot-${index + 1}` }));
    store.observeUsage({
      runId,
      event: usageEvent({
        eventId: `usage-${index + 1}`,
        sourceEventId: `request-${index + 1}`,
        providerId: index === 2 ? 'provider-b' : 'provider-a',
        providerName: index === 2 ? 'Provider B' : 'Provider A',
        tokens: { input: index + 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 },
      }),
    });
    seal(store, runId, executionStatus);
  }

  const aggregate = store.getTaskUsage('task-1');
  assert.equal(aggregate.runCount, 3);
  assert.deepEqual(aggregate.executionStatuses, { succeeded: 1, failed: 1, cancelled: 1 });
  assert.deepEqual(aggregate.tokens, {
    freshInput: 6, cacheRead: 0, cacheWrite: 0, consumedInput: 6,
    output: 3, reasoning: 0, total: 9,
  });
  assert.equal(aggregate.dimensions.length, 2);
  assert.deepEqual(store.listTaskRuns('task-1').map(run => run.runId), ['run-1', 'run-2', 'run-3']);
});

test('Claude aggregate main usage is authoritative while Codex main and sub usage remain additive', t => {
  const files = tempDatabase(t);
  const store = createTaskRunStore({ file: files.file, Database });
  t.after(() => store.close());

  store.beginRun(runInput({ runId: 'run-claude', attemptId: 'attempt-claude', slotId: 'slot-claude' }));
  store.observeUsage({
    runId: 'run-claude',
    event: usageEvent({
      eventId: 'claude-main', sourceEventId: 'claude-result', cli: 'claude',
      protocol: 'anthropic', source: 'reconciled', roleKind: 'main', routeName: 'main',
      tokens: { input: 100, cacheRead: 10, cacheWrite: 0, output: 20, reasoning: 0 },
    }),
  });
  store.observeUsage({
    runId: 'run-claude',
    event: usageEvent({
      eventId: 'claude-sub', sourceEventId: 'claude-sub-request', cli: 'claude',
      protocol: 'anthropic', source: 'exact', roleKind: 'sub', agentRole: 'worker', routeName: 'worker',
      tokens: { input: 30, cacheRead: 2, cacheWrite: 0, output: 5, reasoning: 0 },
    }),
  });

  store.beginRun(runInput({ runId: 'run-codex', attemptId: 'attempt-codex', slotId: 'slot-codex' }));
  store.observeUsage({
    runId: 'run-codex',
    event: usageEvent({
      eventId: 'codex-main', sourceEventId: 'codex-result', cli: 'codex',
      tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 2, reasoning: 1 },
    }),
  });
  store.observeUsage({
    runId: 'run-codex',
    event: usageEvent({
      eventId: 'codex-sub', sourceEventId: 'codex-sub-request', cli: 'codex',
      roleKind: 'sub', agentRole: 'worker', routeName: 'worker',
      tokens: { input: 5, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 },
    }),
  });

  const claude = store.getRunUsage('run-claude');
  assert.equal(claude.accountingMode, 'claude-main-aggregate');
  assert.equal(claude.breakdownMayOverlapTotal, true);
  assert.deepEqual(claude.tokens, {
    freshInput: 100, cacheRead: 10, cacheWrite: 0, consumedInput: 110,
    output: 20, reasoning: 0, total: 130,
  });
  assert.equal(claude.dimensions.length, 2, 'sub usage remains available as a provider breakdown');

  const codex = store.getRunUsage('run-codex');
  assert.equal(codex.accountingMode, 'additive');
  assert.equal(codex.breakdownMayOverlapTotal, false);
  assert.deepEqual(codex.tokens, {
    freshInput: 15, cacheRead: 0, cacheWrite: 0, consumedInput: 15,
    output: 3, reasoning: 1, total: 18,
  });

  const task = store.getTaskUsage('task-1');
  assert.equal(task.accountingMode, 'mixed');
  assert.equal(task.breakdownMayOverlapTotal, true);
  assert.deepEqual(task.tokens, {
    freshInput: 115, cacheRead: 10, cacheWrite: 0, consumedInput: 125,
    output: 23, reasoning: 1, total: 148,
  });
});
