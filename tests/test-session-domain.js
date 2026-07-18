'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { assertTestDir } = require('../src/paths');
const { createChatHistoryService } = require('../src/session/chat-history-service');
const { createChatHistoryFileRepository } = require('../src/session/adapters/chat-history-file-repository');
const { createSessionQueryService } = require('../src/session/query-service');
const { createSessionStateService, transitionSessionState } = require('../src/session/state-transition');
const { createWorkspaceService } = require('../src/session/workspace-service');

function assertNoSensitiveKeys(value) {
  const forbidden = /(?:token|secret|password|stack|(?:^|_)path|cwd|nativeSessionId|cliSessionId|worktree)/i;
  if (Array.isArray(value)) return value.forEach(assertNoSensitiveKeys);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, forbidden);
    assertNoSensitiveKeys(child);
  }
}

test('session query projects only the bounded public DTO', () => {
  const source = [{
    id: 's1', dirId: 'd1', cli: 'codex', kind: 'chat', label: 'safe',
    provider: 'p1', autoCommit: true, createdAt: 1000,
    token: 'do-not-leak', nativeSessionId: 'native', cliSessionId: 'native-2',
    cwd: '/private/project', worktreePath: '/private/worktree', stack: 'trace',
  }, { id: '__aux__', type: 'aux', dirId: 'd1' }];
  const service = createSessionQueryService({
    records: { list: () => source, get: id => source.find(item => item.id === id) },
    runtime: { read: () => ({
      effectiveModel: 'gpt-safe', effectiveEffort: 'high', active: true, clients: 2,
      lastActivity: 2000, mergeState: { ahead: 1, dirty: true },
      token: 'runtime-secret', cwd: '/runtime/path',
    }) },
  });
  const list = service.list({ dirId: 'd1' });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 's1');
  assert.equal(list[0].effectiveModel, 'gpt-safe');
  assert.equal(list[0].clients, 2);
  assert.equal(service.get('__aux__'), null);
  assertNoSensitiveKeys(list);
});

test('workspace aggregation selects safe facts and never exposes directory/session internals', () => {
  const session = {
    id: 's1', dirId: 'd1', type: 'session', cli: 'claude', kind: 'chat', label: null,
    model: null, effectiveModel: null, effort: null, effectiveEffort: null, agent: null,
    provider: null, subagent: null, autoCommit: false, autoDispatch: false,
    createdAt: null, lastActivity: null, clients: 0, active: false, mergeState: null,
  };
  const service = createWorkspaceService({
    sessionQuery: { list: ({ dirId }) => dirId === 'd1' ? [session] : [] },
    directories: {
      get: id => id === 'd1' ? { id: 'd1', name: 'Workspace', path: '/secret/root', token: 'x' } : null,
      list: () => [{ id: 'd1', name: 'Workspace', path: '/secret/root' }],
    },
    workspaceFacts: { read: () => ({
      status: 'running', lastActivity: 3000, runStartedAt: 2000,
      pendingNotes: 2, summary: 'bounded', phase: 'implementation',
      currentFile: '/secret/file', stack: 'trace', token: 'x', invalid: { stack: 'trace' },
    }) },
  });
  const snapshot = service.snapshot('d1');
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.sessions[0].status, 'running');
  assert.equal(snapshot.sessions[0].pendingNotes, 2);
  assert.deepEqual(snapshot.directory, { id: 'd1', label: 'Workspace' });
  assertNoSensitiveKeys(snapshot);
  assert.equal(service.fleet().count, 1);
});

test('session state transitions preserve run segments and pending work forces waiting', () => {
  const started = transitionSessionState(null, { status: 'thinking' }, { now: 100 });
  assert.deepEqual(started.state, { status: 'thinking', lastActivity: 100, runStartedAt: 100, runEndedAt: null });
  const editing = transitionSessionState(started.state, { status: 'editing' }, { now: 120 });
  assert.equal(editing.state.runStartedAt, 100);
  const waiting = transitionSessionState(editing.state, { status: 'completed' }, { now: 150, pendingWork: true });
  assert.deepEqual(waiting.state, { status: 'waiting', lastActivity: 150, runStartedAt: 100, runEndedAt: 150 });
  const service = createSessionStateService({ clock: () => 200, hasPendingWork: id => id === 's1' });
  assert.equal(service.transition('s1', waiting.state, { status: 'idle' }).state.status, 'waiting');
  assert.throws(() => transitionSessionState(null, { status: 'unknown' }), /unsupported status/);
});

test('chat history normalizes, removes interim messages and deduplicates final assistant replies', () => {
  const store = new Map();
  let sequence = 0;
  const service = createChatHistoryService({
    history: {
      read: id => store.get(id) || [],
      write: (id, messages) => store.set(id, messages),
    },
    idFactory: () => `m${++sequence}`,
    clock: () => 1000 + sequence,
    maxMessages: 3,
  });
  service.append('s1', { role: 'user', content: 'hi' });
  service.append('s1', { role: 'assistant', content: 'partial', _interim: true });
  service.append('s1', { role: 'assistant', content: 'final', tools: [{ name: 'x' }] });
  const deduped = service.append('s1', {
    role: 'assistant', content: 'final', tools: [{ name: 'x' }], usage: { output: 3 }, durationMs: 20,
  });
  assert.equal(deduped.deduplicated, true);
  assert.equal(deduped.messages.length, 2);
  assert.deepEqual(deduped.message.usage, { output: 3 });
  service.append('s1', { role: 'user', content: [{ type: 'thinking', thinking: '   ' }, { type: 'text', text: 'ok' }] });
  service.append('s1', { role: 'assistant', content: 'next' });
  assert.equal(service.read('s1').length, 3);
  assert.equal(service.read('s1')[0].id, service.read('s1')[0].id);
  assert.equal(service.read('s1')[1].content.length, 1);
  assert.equal(service.paginate('s1', { limit: 2 }).messages.length, 2);
  assert.equal(service.remove('s1', service.read('s1')[0].id).removed, true);
  assert.equal(service.latestAssistantAt('s1').getTime() > 0, true);
});

test('chat history file adapter stays under the supplied data root and writes privately', (t) => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-history-port-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createChatHistoryFileRepository({ dataDir: root });
  repository.write('../unsafe', [{ role: 'user', content: 'safe' }]);
  assert.equal(repository.fileFor('../unsafe').startsWith(path.join(root, 'chat_history') + path.sep), true);
  assert.deepEqual(repository.read('../unsafe'), [{ role: 'user', content: 'safe' }]);
  assert.equal(fs.statSync(repository.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(repository.fileFor('../unsafe')).mode & 0o777, 0o600);
});
