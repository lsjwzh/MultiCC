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

test('legacy and v1 presenters reuse one canonical session context', () => {
  const source = [{ id: 's1', dirId: 'd1', cli: 'codex', kind: 'chat', createdAt: 10 }];
  let runtimeReads = 0;
  const service = createSessionQueryService({
    records: { list: () => source, get: id => source.find(item => item.id === id) },
    runtime: { read: () => {
      runtimeReads += 1;
      return { active: true, clients: 3, lastActivity: new Date(20), effectiveModel: 'gpt-test' };
    } },
  });
  const contexts = service.listContexts({ dirId: 'd1' });
  const v1 = service.presentContext(contexts[0]);
  const legacy = service.presentContext(contexts[0], ({ record, runtime }) => ({
    id: record.id, cli: record.cli, active: runtime.active,
    clients: runtime.clients, lastActivity: runtime.lastActivity,
    legacyOnly: 'preserved',
  }));
  assert.equal(runtimeReads, 1, 'both presenters consume the same runtime snapshot');
  assert.deepEqual(
    JSON.parse(JSON.stringify({
      id: legacy.id, cli: legacy.cli, active: legacy.active,
      clients: legacy.clients, lastActivity: legacy.lastActivity,
    })),
    { id: v1.id, cli: v1.cli, active: v1.active, clients: v1.clients, lastActivity: v1.lastActivity },
  );
  assert.equal(legacy.legacyOnly, 'preserved');
  assert.equal(v1.legacyOnly, undefined);
});

test('workspace aggregation selects safe facts and never exposes directory/session internals', () => {
  const session = {
    id: 's1', dirId: 'd1', type: 'session', cli: 'claude', kind: 'chat', label: null,
    model: null, effectiveModel: null, effort: null, effectiveEffort: null, agent: null,
    provider: null, subagent: null, autoCommit: false, autoDispatch: false,
    createdAt: null, lastActivity: null, clients: 0, active: false, mergeState: null,
  };
  const service = createWorkspaceService({
    sessionQuery: {
      listContexts: ({ dirId }) => dirId === 'd1'
        ? [{ record: { id: 's1', dirId: 'd1' }, runtime: {} }]
        : [],
      presentContext: () => session,
    },
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

test('legacy and v1 workspace views consume the same canonical session and facts', () => {
  const record = { id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat' };
  const runtime = { active: true, clients: 2 };
  const bounded = {
    id: 's1', dirId: 'd1', cli: 'claude', kind: 'chat', label: null,
    model: null, effectiveModel: null, effort: null, effectiveEffort: null,
    agent: null, provider: null, subagent: null, autoCommit: false,
    autoDispatch: false, createdAt: null, lastActivity: null, clients: 2,
    active: true, mergeState: null,
  };
  const query = {
    listContexts: () => [{ record, runtime }],
    presentContext: () => bounded,
  };
  const facts = { status: 'running', lastActivity: 99, pendingNotes: 4 };
  const service = createWorkspaceService({
    sessionQuery: query,
    directories: { get: () => ({ id: 'd1', label: 'D' }), list: () => [{ id: 'd1', label: 'D' }] },
    workspaceFacts: { read: () => facts },
  });
  const v1 = service.snapshot('d1').sessions[0];
  const legacy = service.snapshot('d1', { presenter: ({ session, facts: projectedFacts }) => ({
    id: session.record.id, active: session.runtime.active,
    clients: session.runtime.clients, status: projectedFacts.status,
    pendingNotes: projectedFacts.pendingNotes, legacyOnly: true,
  }) }).sessions[0];
  assert.deepEqual(
    { id: legacy.id, active: legacy.active, clients: legacy.clients, status: legacy.status, pendingNotes: legacy.pendingNotes },
    { id: v1.id, active: v1.active, clients: v1.clients, status: v1.status, pendingNotes: v1.pendingNotes },
  );
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

test('chat history dedups a 🔇-nudge-separated retry and keeps only the latest reply', () => {
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
    maxMessages: 100,
  });
  const LONG = '好，明确了：那个被撤销的任务不用管，现在继续 runState 同步（删 busy 短路）任务。';
  service.append('s1', { role: 'assistant', content: LONG, usage: { input: 100 } });
  service.append('s1', { role: 'user', content: '🔇【判定未知中断】请继续刚才未完成的任务' });
  service.append('s1', { role: 'assistant', content: LONG, usage: { input: 200 } });
  service.append('s1', { role: 'user', content: '🔇【判定未知中断】请继续刚才未完成的任务' });
  service.append('s1', { role: 'assistant', content: LONG, usage: { input: 300 } });
  const after = service.read('s1');
  // Only the latest assistant survives; the two older copies are folded.
  const assistants = after.filter(m => m.role === 'assistant');
  assert.equal(assistants.length, 1, 'three same replies separated by 🔇 nudge collapse to one');
  assert.equal(assistants[0].usage.input, 300, 'the kept copy is the latest');
});

test('chat history does NOT dedup two same replies separated by a real user message', () => {
  const store = new Map();
  let sequence = 0;
  const service = createChatHistoryService({
    history: { read: id => store.get(id) || [], write: (id, m) => store.set(id, m), deleteSession: id => store.delete(id), hasPersistedDelivery: () => false },
    idFactory: () => `m${++sequence}`,
    clock: () => 1000 + sequence,
    maxMessages: 100,
  });
  const LONG = '这是一个足够长的相同回复内容用于测试去重护栏逻辑abcdef';
  service.append('s1', { role: 'assistant', content: LONG });
  service.append('s1', { role: 'user', content: '再问一次相同的问题' }); // real user, NOT 🔇
  service.append('s1', { role: 'assistant', content: LONG });
  const after = service.read('s1');
  assert.equal(after.filter(m => m.role === 'assistant').length, 2, 'two independent answers to two real user turns stay');
});

test('chat history prefix-containment dedups a longer retry that starts with the older reply', () => {
  const store = new Map();
  let sequence = 0;
  const service = createChatHistoryService({
    history: { read: id => store.get(id) || [], write: (id, m) => store.set(id, m), deleteSession: id => store.delete(id), hasPersistedDelivery: () => false },
    idFactory: () => `m${++sequence}`,
    clock: () => 1000 + sequence,
    maxMessages: 100,
  });
  const SHORT_OK = '好的，明白了。'; // < 16 chars, below the length guard
  const PREV = '第一段足够长的回复内容用于前缀包含判定测试场景一二三四五六';
  service.append('s1', { role: 'assistant', content: PREV });
  service.append('s1', { role: 'user', content: '🔇请继续' });
  // latest starts with PREV and adds more — a longer retry version
  service.append('s1', { role: 'assistant', content: PREV + '，接着补充新内容。' });
  const after = service.read('s1');
  assert.equal(after.filter(m => m.role === 'assistant').length, 1, 'older reply folded into the longer latest');
  // Short content below 16-char guard must NOT match via startsWith:
  service.append('s1', { role: 'user', content: '🔇请继续' });
  service.append('s1', { role: 'assistant', content: SHORT_OK + '，更多' }); // prev SHORT_OK<16 -> no dedup
  assert.equal(after.filter(m => m.role === 'assistant').length, 1);
  const after2 = service.read('s1');
  assert.equal(after2.filter(m => m.role === 'assistant').length, 2, 'short-content startsWith below length guard does not dedup');
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
  const stale = service.upsertInterim('s1', { content: 'final' });
  assert.equal(stale.ignored, true);
  assert.equal(service.read('s1').length, 1);

  const continuation = service.upsertInterim('s1', { content: 'system continuation without a visible user message' });
  assert.equal(continuation.ignored, undefined);
  assert.equal(continuation.messages.length, 2);
  assert.equal(continuation.messages[1]._interim, true);
});

test('chat history read migrates final-then-stale-interim duplicates', () => {
  const store = new Map([['s1', [
    { id: 'final-1', role: 'assistant', content: 'same cumulative reply', ts: 10 },
    { id: 'interim-2', role: 'assistant', content: 'same cumulative reply', ts: 15, _interim: true },
  ]]]);
  const service = createChatHistoryService({
    history: {
      read: id => store.get(id) || [],
      write: (id, messages) => store.set(id, messages),
      deleteSession: id => store.delete(id),
      hasPersistedDelivery: () => false,
    },
    idFactory: () => 'unused',
  });

  assert.deepEqual(service.read('s1').map(message => message.id), ['final-1']);
});

test('chat history preserves a different interim after a final for system continuation', () => {
  const store = new Map([['s1', [
    { id: 'final-1', role: 'assistant', content: 'finished visible turn', ts: 10 },
    { id: 'interim-2', role: 'assistant', content: 'injected continuation', ts: 20, _interim: true },
  ]]]);
  const service = createChatHistoryService({
    history: {
      read: id => store.get(id) || [],
      write: (id, messages) => store.set(id, messages),
      deleteSession: id => store.delete(id),
      hasPersistedDelivery: () => false,
    },
    idFactory: () => 'unused',
  });

  assert.deepEqual(service.read('s1').map(message => message.id), ['final-1', 'interim-2']);
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

test('chat history post-persist ports run only after durable write and cannot roll back it', () => {
  const store = new Map();
  const order = [];
  const callbackErrors = [];
  let failWrites = false;
  const service = createChatHistoryService({
    history: {
      read: id => store.get(id) || [],
      write: (id, messages) => {
        order.push('write');
        if (failWrites) throw new Error('injected write failure');
        store.set(id, messages);
      },
      deleteSession: id => store.delete(id),
      hasPersistedDelivery: (id, deliveryId) => (store.get(id) || []).some(message =>
        message.deliveryId === deliveryId || message.clientMsgId === deliveryId),
    },
    idFactory: () => 'm1',
    postPersist: event => {
      order.push(`global:${event.type}`);
      assert.equal(Object.isFrozen(event), true);
    },
    onPostPersistError: error => callbackErrors.push(error.message),
  });
  service.append('s1', { role: 'user', content: 'committed', deliveryId: 'delivery-1' }, {
    afterCommit: () => { order.push('local'); throw new Error('broadcast failed'); },
  });
  assert.deepEqual(order, ['write', 'global:append', 'local']);
  assert.deepEqual(callbackErrors, ['broadcast failed']);
  assert.equal(service.containsDelivery('s1', 'delivery-1'), true);
  assert.equal(service.hasPersistedDelivery('s1', 'delivery-1'), true);

  failWrites = true;
  assert.throws(() => service.append('s1', { role: 'assistant', content: 'not committed' }, {
    afterCommit: () => order.push('must-not-run'),
  }), /injected write failure/);
  assert.equal(order.includes('must-not-run'), false);
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
  assert.deepEqual(repository.listSessionIds(), ['___unsafe']);
  assert.equal(repository.renameSession('../unsafe', 'renamed'), true);
  assert.equal(repository.renameSession('../unsafe', 'renamed-again'), false);
  assert.deepEqual(repository.listSessionIds(), ['renamed']);
  assert.equal(fs.statSync(repository.fileFor('renamed')).mode & 0o777, 0o600);
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
