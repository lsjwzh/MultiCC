'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

test('server composes the durable TaskRun boundary into every execution lifecycle stage', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(source, /createTaskRunStore\(\{ file: MULTICC_PATHS\.taskRunDbFile \}\)/);
  assert.match(source, /taskRuns: taskRunStore/);
  assert.match(source, /terminateTaskRun: input => taskRunHost\.terminateRun\(input\)/);
  assert.match(source, /orchestrationRuntime\.operations\.cancelUndeliveredDispatch\(operationId, \{ taskRunId: context\.runId/);
  assert.match(source, /if \(result\?\.ok\) cancelDispatchRun\(operationId\)/);
  assert.match(source, /createTaskRunRoutes\(\{ store: taskRunStore, logger \}\)\.mountRoutes\(app\)/);
  assert.match(source, /recordTaskRunMessage: \(sessionId, message\) => taskRunHost\?\.recordMessage/);
  assert.match(source, /persistTaskRunUsage: payload => taskRunHost\.recordMainUsage\(payload\)/);
  assert.match(source, /beforeDeliver: async descriptor =>/);
  assert.match(source, /sessionHibernationRuntime\.acquireDelivery\(descriptor\.sessionId\)/);
  assert.match(source, /await taskRunHost\.beforeDeliver\(descriptor\)/);
  assert.match(source, /guard\?\.complete\(\{ accepted: false, durable: false \}\)/);
  assert.match(source, /beforeFirstTick: \(\{ sessionScheduler \}\) => reconcileTaskRunSlotLeases\(\{ store: taskRunStore, records: persistedSessions,[\s\S]*?resumeCleanup: item => taskRunHost\.resumeCleanup\(item\), resetSlot: item => taskRunHost\.resetSlotForRecovery\(item\),[\s\S]*?getSchedulerStatus: slotId => sessionScheduler\.status\(slotId\), recoverTerminal: event => taskRunHost\.recoverTerminal\(event\)/);
  assert.match(source, /taskRunHost\.onSchedulerEvent\(event\)/);
  assert.match(source, /taskRunStore,/);
});

test('server creates hidden reusable slots and freezes proxy usage lineage at request start', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(source, /taskExecutionSlot = false/);
  assert.match(source, /session\.taskExecutionSlot = true/);
  assert.match(source, /createTaskRunProviderBridge\(\{ records: persistedSessions/);
  assert.match(source, /providerAttemptRuntime\.attributeProxyUsage\(event\)/);
  assert.match(source, /tagged\.routeAttribution === 'exact' \|\| tagged\.producerBound === true\) taskRunProviderBridge\.onUsageObserved\(tagged\)/);
  assert.match(source, /const bound = providerAttemptRuntime\.onProxyActivity\(event\); if \(bound\) taskRunProviderBridge\.onActivity\(\{ \.\.\.event, sessionId: bound\.sessionId \}\)/);
  assert.match(source, /authorizeProxyRequest: providerAttemptRuntime\.authorizeProxyRequest/);
  assert.match(source, /taskRunHost\?\.isSlotUnavailable\(sid, item \|\| \{\}\)/);
});

test('TaskRun SQLite and transcript artifacts cannot dirty an installation checkout', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const entry of ['task-runs.sqlite', 'task-runs.sqlite-wal', 'task-runs.sqlite-shm', 'task-run-transcripts/']) {
    assert.equal(ignore.split(/\r?\n/).includes(entry), true, `${entry} must be ignored`);
  }
});
