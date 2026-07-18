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
const {
  MAX_WORKSPACE_DIFFS,
  compareWorkspaceSnapshots,
  createWorkspaceService,
  workspaceEntry,
} = require('../src/session/workspace-service');

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
      pendingNotes: 2,
      summary: 'token=summary-secret at /Users/private/project/server.js',
      goal: 'Bearer goal-secret from C:\\private\\project\\secret.txt',
      phase: 'implementation',
      currentFile: '/secret/file', stack: 'trace', token: 'x', invalid: { stack: 'trace' },
    }) },
  });
  const snapshot = service.snapshot('d1');
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.sessions[0].status, 'running');
  assert.equal(snapshot.sessions[0].pendingNotes, 2);
  assert.deepEqual(snapshot.directory, { id: 'd1', label: 'Workspace' });
  assertNoSensitiveKeys(snapshot);
  const wire = JSON.stringify(snapshot);
  for (const forbidden of ['summary-secret', 'goal-secret', '/Users/', 'C:\\\\private']) {
    assert.equal(wire.includes(forbidden), false, `workspace text redacts ${forbidden}`);
  }
  assert.equal(snapshot.sessions[0].summary.includes('[redacted]'), true);
  assert.equal(snapshot.sessions[0].goal.includes('[path]'), true);
  assert.equal(service.fleet().count, 1);
});

test('workspace shadow comparison normalizes legacy epochs against bounded timestamps', () => {
  const session = {
    id: 's1', dirId: 'd1', type: 'session', cli: 'claude', kind: 'chat', label: 'Safe',
    model: null, effectiveModel: null, effort: null, effectiveEffort: null, agent: null,
    provider: null, subagent: null, autoCommit: false, autoDispatch: false,
    createdAt: null, lastActivity: '2026-07-18T01:00:00.000Z', clients: 2, active: true,
    mergeState: { ahead: 2, behind: 1, dirty: true, mergeReady: false, rebaseInProgress: true },
  };
  const bounded = workspaceEntry(session, {
    status: 'running', lastActivity: 1784336461000, runStartedAt: 1784336400000,
    runEndedAt: null, pendingNotes: 3, summary: 'bounded summary', summaryAt: 1784336460000,
    classifyState: 'P', goal: 'ship safely', phase: 'testing',
  });
  const legacy = [{
    id: 's1', status: 'running', clients: 2, pendingNotes: 3,
    summary: 'bounded summary', summaryTs: 1784336460000,
    classifyState: 'P', goal: 'ship safely', phase: 'testing',
    lastActivity: 1784336461000, runStartedAt: 1784336400000, runEndedAt: null,
    currentFile: '/private/repository/server.js', branch: 'private-branch',
    mergeState: {
      ahead: 2, behind: 1, dirty: true, mergeReady: false, rebaseInProgress: true,
      baseBranch: 'main', conflictFiles: ['/private/repository/secret.js'],
    },
  }];

  assert.deepEqual(compareWorkspaceSnapshots(legacy, { sessions: [bounded] }), {
    equal: true,
    diffs: [],
  });
});

test('workspace shadow comparison reports only bounded allowlisted differences', () => {
  const legacy = [{
    id: 's1', status: 'running', clients: 1, pendingNotes: 1,
    summary: 'token sk-super-secret at /Users/private/project', summaryTs: 1000,
    classifyState: 'P', goal: 'read /Users/private/project', phase: 'coding',
    lastActivity: 2000, runStartedAt: 1500, runEndedAt: null,
    mergeState: { ahead: 1, behind: 2, dirty: true, mergeReady: false, rebaseInProgress: true },
  }, { id: 'legacy-only' }];
  const bounded = { sessions: [{
    id: 's1', status: 'waiting', clients: 2, pendingNotes: 3,
    summary: 'different password secret', summaryAt: '1970-01-01T00:00:02.000Z',
    classifyState: 'W', goal: 'different', phase: 'review',
    statusUpdatedAt: '1970-01-01T00:00:03.000Z',
    runStartedAt: '1970-01-01T00:00:02.500Z', runEndedAt: '1970-01-01T00:00:04.000Z',
    mergeState: { ahead: 4, behind: 5, dirty: false, mergeReady: true, rebaseInProgress: false },
  }, { id: 'bounded-only' }] };

  const result = compareWorkspaceSnapshots(legacy, bounded);
  assert.equal(result.equal, false);
  const fields = new Set(result.diffs.map(item => item.field));
  for (const field of [
    'status', 'clients', 'pendingNotes', 'summary', 'classifyState', 'goal', 'phase',
    'statusUpdatedAt', 'runStartedAt', 'runEndedAt', 'summaryAt',
    'mergeState.ahead', 'mergeState.behind', 'mergeState.dirty',
    'mergeState.mergeReady', 'mergeState.rebaseInProgress', 'session',
  ]) assert.equal(fields.has(field), true, field);
  const serialized = JSON.stringify(result);
  for (const forbidden of ['sk-super-secret', 'password secret', '/Users/', 'private/project']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('workspace shadow comparison caps its diagnostic result', () => {
  const legacy = [];
  const bounded = { sessions: [] };
  for (let index = 0; index < MAX_WORKSPACE_DIFFS + 25; index++) {
    legacy.push({ id: `s-${String(index).padStart(3, '0')}`, status: 'idle' });
    bounded.sessions.push({ id: `s-${String(index).padStart(3, '0')}`, status: 'running' });
  }
  const result = compareWorkspaceSnapshots(legacy, bounded);
  assert.equal(result.equal, false);
  assert.equal(result.diffs.length, MAX_WORKSPACE_DIFFS);
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
      deleteSession: id => store.delete(id),
      hasPersistedDelivery: (id, deliveryId) => (store.get(id) || []).some(message =>
        message.deliveryId === deliveryId || message.clientMsgId === deliveryId),
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

test('chat history upserts one interim message and preserves its id', () => {
  const store = new Map();
  let sequence = 0;
  const service = createChatHistoryService({
    history: {
      read: id => store.get(id) || [],
      write: (id, messages) => store.set(id, messages),
      deleteSession: id => store.delete(id),
      hasPersistedDelivery: () => false,
    },
    idFactory: () => `m${++sequence}`,
    clock: () => 1000 + sequence,
  });
  const first = service.upsertInterim('s1', { content: 'partial' });
  const second = service.upsertInterim('s1', { content: 'longer partial', id: 'must-not-replace-visible-id' });
  assert.equal(first.replaced, false);
  assert.equal(second.replaced, true);
  assert.equal(second.messages.length, 1);
  assert.equal(second.message.id, first.message.id);
  assert.equal(second.message.content, 'longer partial');
  assert.equal(second.message._interim, true);
  const final = service.append('s1', { role: 'assistant', content: 'final' });
  assert.equal(final.messages.length, 1);
  assert.equal(final.messages[0].content, 'final');
  assert.equal(final.messages[0]._interim, undefined);
});

test('chat history pagination fails closed for an unknown before cursor', () => {
  const messages = [
    { id: 'm1', role: 'user', content: 'one' },
    { id: 'm2', role: 'assistant', content: 'two' },
  ];
  const service = createChatHistoryService({
    history: {
      read: () => messages,
      write: () => {},
      deleteSession: () => false,
      hasPersistedDelivery: () => false,
    },
    idFactory: () => 'unused',
  });
  assert.deepEqual(service.paginate('s1', { before: 'missing', limit: 30 }), {
    messages: [], hasMore: false, before: null,
  });
});

test('chat history retention policy applies per session and reports dropped messages', () => {
  const store = new Map();
  let sequence = 0;
  const service = createChatHistoryService({
    history: {
      read: id => store.get(id) || [],
      write: (id, messages) => store.set(id, messages),
      deleteSession: id => store.delete(id),
      hasPersistedDelivery: () => false,
    },
    idFactory: () => `m${++sequence}`,
    retentionPolicy: sessionId => sessionId === '__aux__' ? 2 : { maxMessages: 4 },
  });
  service.append('__aux__', { role: 'user', content: 'one' });
  service.append('__aux__', { role: 'assistant', content: 'two' });
  const aux = service.append('__aux__', { role: 'user', content: 'three' });
  assert.deepEqual(aux.dropped.map(message => message.content), ['one']);
  assert.deepEqual(aux.messages.map(message => message.content), ['two', 'three']);

  const normal = service.replace('s1', [1, 2, 3, 4, 5].map(number => ({
    role: number % 2 ? 'user' : 'assistant', content: String(number), id: `n${number}`,
  })));
  assert.deepEqual(normal.dropped.map(message => message.content), ['1']);
  assert.deepEqual(normal.messages.map(message => message.content), ['2', '3', '4', '5']);
});

test('chat history write failure leaves the committed cache unchanged', () => {
  const store = new Map([['s1', [{ id: 'm1', role: 'user', content: 'committed' }]]]);
  let failWrites = false;
  const service = createChatHistoryService({
    history: {
      read: id => store.get(id) || [],
      write: (id, messages) => {
        if (failWrites) throw new Error('disk full');
        store.set(id, messages);
      },
      deleteSession: id => store.delete(id),
      hasPersistedDelivery: () => false,
    },
    idFactory: () => 'm2',
  });
  assert.equal(service.read('s1')[0].content, 'committed');
  failWrites = true;
  assert.throws(() => service.append('s1', { role: 'assistant', content: 'not committed' }), /disk full/);
  assert.deepEqual(service.read('s1').map(message => message.content), ['committed']);
});

test('chat history deletes the repository before invalidating its cache', () => {
  let stored = [{ id: 'm1', role: 'user', content: 'first' }];
  let failDelete = true;
  const service = createChatHistoryService({
    history: {
      read: () => stored,
      write: (_id, messages) => { stored = messages; },
      deleteSession: () => {
        if (failDelete) throw new Error('delete denied');
        stored = [];
        return true;
      },
      hasPersistedDelivery: () => false,
    },
    idFactory: () => 'm2',
  });
  service.read('s1');
  stored = [{ id: 'external', role: 'user', content: 'external replacement' }];
  assert.throws(() => service.deleteSession('s1'), /delete denied/);
  assert.deepEqual(service.read('s1').map(message => message.content), ['first']);
  failDelete = false;
  assert.equal(service.deleteSession('s1'), true);
  assert.deepEqual(service.read('s1'), []);
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

test('chat history file adapter strictly proves persisted deliveries and deletes sessions', (t) => {
  const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-history-delivery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createChatHistoryFileRepository({ dataDir: root });
  assert.equal(repository.hasPersistedDelivery('s1', 'delivery-1'), false);
  repository.write('s1', [{ role: 'user', content: 'safe', deliveryId: 'delivery-1' }]);
  assert.equal(repository.hasPersistedDelivery('s1', 'delivery-1'), true);
  assert.equal(repository.hasPersistedDelivery('s1', 'missing'), false);

  fs.writeFileSync(repository.fileFor('s1'), '{corrupt json', { mode: 0o600 });
  assert.throws(() => repository.hasPersistedDelivery('s1', 'delivery-1'));
  assert.equal(repository.read('s1').length, 0);

  repository.write('s1', [{ role: 'user', content: 'restored', clientMsgId: 'client-1' }]);
  assert.equal(repository.hasPersistedDelivery('s1', 'client-1'), true);
  assert.equal(repository.deleteSession('s1'), true);
  assert.equal(repository.deleteSession('s1'), false);
});

test('chat history delivery proof propagates permission errors and bypasses service cache', () => {
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const repository = createChatHistoryFileRepository({
    dataDir: path.join(os.tmpdir(), 'multicc-history-denied'),
    fsImpl: {
      readFileSync: () => { throw denied; },
      unlinkSync: () => { throw denied; },
      mkdirSync: () => {},
    },
    writeJson: () => {},
  });
  assert.throws(() => repository.hasPersistedDelivery('s1', 'delivery-1'), /permission denied/);

  let persisted = [];
  const service = createChatHistoryService({
    history: {
      read: () => [{ role: 'user', content: 'cached', deliveryId: 'cached-only' }],
      write: () => {},
      deleteSession: () => false,
      hasPersistedDelivery: (_sessionId, deliveryId) => persisted.some(message => message.deliveryId === deliveryId),
    },
    idFactory: () => 'm1',
  });
  service.read('s1');
  assert.equal(service.hasPersistedDelivery('s1', 'cached-only'), false);
  persisted = [{ deliveryId: 'disk-only' }];
  assert.equal(service.hasPersistedDelivery('s1', 'disk-only'), true);
});
