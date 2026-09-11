'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chatUrl, createTransportAdapter, resolve } = require('../public/chat-shell-entry');
const response = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });

test('real task boot preserves resolved read-only and chat URLs with external mode', async () => {
  const vm = require('node:vm');
  const boot = fs.readFileSync(path.join(__dirname, '../public/chat-task-boot.js'), 'utf8');
  for (const readOnly of [true, false]) {
    for (const external of ['', '1']) {
      const replaced = [], errors = [], calls = [];
      const fetch = async route => {
        calls.push(route);
        if (route.endsWith('/chat-session')) return response(readOnly
          ? { ok: true, readOnly: true, sessionId: null, url: '/task-shell.html?task=task-one&board=1' } : { ok: true, sessionId: 'bound' });
        if (route.endsWith('/tasks/resolve')) return response({ sessionId: 'execution' });
        return response({ id: 'sh_main' });
      };
      const context = { URL, _taskId: 'task-one', _sessionName: '',
        _params: new URLSearchParams({ task: 'task-one', air: '1', ...(external ? { external } : {}) }),
        window: { fetch, MultiCCChatShellEntry: { resolve, chatUrl } },
        location: { href: 'http://localhost:3000/chat.html?task=task-one', replace: target => replaced.push(target) },
        connect: () => assert.fail('task must resolve before connecting'),
        addSystemMsg: message => errors.push(message), statusEl: {},
      };
      await vm.runInNewContext(boot + '\nbootChatEntry();', context);
      assert.deepEqual(errors, []);
      assert.deepEqual(replaced, ['http://localhost:3000' + (readOnly
        ? '/chat.html?task=task-one&readOnly=1&air=1' : '/chat.html?session=execution&air=1') + (external ? '&external=1' : '')]);
      if (readOnly) assert.equal(calls.length, 1, 'read-only history must not create or select an execution');
    }
  }
});

test('ordinary chat remains in the full chat UI and task links resolve to the bound chat UI', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/chat-session')) return response({ ok: true, sessionId: 'bound' });
    if (url.endsWith('/tasks/resolve')) return response({ id: 'task-one', title: 'Task one', sessionId: 'execution' });
    return response({ id: 'sh_main' });
  };
  assert.equal(await resolve({ sessionId: 'ordinary', fetch }), null);
  assert.equal(calls.length, 0, 'ordinary chat must connect without shell-page discovery');
  assert.equal(await resolve({ taskId: 'task-one', fetch }), '/chat.html?session=execution');
  assert.equal(calls.at(-1).url, '/api/task-shells/sh_main/tasks/resolve');
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { taskId: 'task-one' });
  assert.equal(chatUrl('execution', { external: '1' }), '/chat.html?session=execution&external=1');
  assert.equal(chatUrl('execution', { air: true }), '/chat.html?session=execution&air=1');
});

test('read-only task boot hydrates the original chat renderers without opening a socket', async () => {
  const vm = require('node:vm');
  const boot = fs.readFileSync(path.join(__dirname, '../public/chat-task-boot.js'), 'utf8');
  const hidden = new Map(), calls = [], rendered = {};
  const snapshot = { task: { title: 'Archived task' }, messages: [{ id: 'm1', role: 'assistant', content: 'done', tools: [{ name: 'Read' }] }], hasMore: true,
    execution: { queue: { state: 'frozen', queued: [{ entryId: 'q1', text: 'later' }] }, classify: { state: 'D', goal: 'ship', phase: 'done' } } };
  const context = { URL, URLSearchParams, _taskId: 'task-old', _params: new URLSearchParams({ task: 'task-old', readOnly: '1', air: '1' }),
    window: { fetch: async (url, init) => { calls.push({ url, init }); return response(snapshot); },
      MultiCCChatSessionQueue: { render: (...args) => { rendered.queue = args; } },
      MultiCCTaskArtifacts: { setScope: value => { rendered.artifacts = value; } } },
    document: { body: { classList: { add: value => { rendered.bodyClass = value; } } },
      getElementById: id => { if (!hidden.has(id)) hidden.set(id, { style: {} }); return hidden.get(id); } },
    updateTabIdentity: (...args) => { rendered.identity = args; }, resetHistoryPagination: () => { rendered.reset = true; },
    chatHistoryView: { clearMessages: () => { rendered.cleared = true; } },
    chatHistoryStore: { acceptHistory: value => ({ value }) }, applyHistoryPlan: value => { rendered.plan = value; },
    renderAuxClassify: (...args) => { rendered.classify = args; }, connect: () => assert.fail('read-only history must not open a socket'),
    addSystemMsg: message => assert.fail(message), statusEl: {}, encodeURIComponent,
  };
  await vm.runInNewContext(boot + '\nbootChatEntry();', context);
  assert.equal(calls[0].url, '/api/task-shell-tasks/task-old/history?limit=50&historyScope=archive');
  assert.equal(rendered.bodyClass, 'chat-read-only');
  assert.deepEqual(rendered.identity, ['Archived task', 'task-old']);
  assert.equal(rendered.plan.value.messages[0].tools[0].name, 'Read');
  assert.equal(rendered.queue[0][0].entryId, 'q1');
  assert.deepEqual(rendered.classify, ['ship', 'done', 'D']);
  assert.equal(rendered.artifacts.taskId, 'task-old');
  assert.equal(context.statusEl.textContent, '只读历史');
});

test('task-link HTTP failures do not enter a second UI', async () => {
  for (const status of [401, 403, 404, 409, 500, 501, 502]) {
    await assert.rejects(resolve({ taskId: 'task-one', fetch: async () => response({ error: 'failed' }, status) }));
  }
  await assert.rejects(resolve({ taskId: 'task-one', fetch: async () => { throw new Error('offline'); } }));
});

test('a pre-restart server route table keeps the bound full chat page', async () => {
  const fetch = async url => {
    if (url.endsWith('/chat-session')) return response({ ok: true, sessionId: 'bound' });
    if (url.endsWith('/tasks/resolve')) return { ok: false, status: 404, json: async () => { throw new SyntaxError('HTML'); } };
    return response({ id: 'sh_main' });
  };
  assert.equal(await resolve({ taskId: 'task-one', fetch }), '/chat.html?session=bound');
});

test('transparent shell transport wraps work, answers and cancel with turn identity', () => {
  const sent = [];
  let sequence = 0;
  const adapter = createTransportAdapter({ send: value => (sent.push(value), true), makeClientMsgId: () => `cancel-${++sequence}` });
  adapter.ingest({ type: 'system', subtype: 'init', is_streaming: false, taskShell: true, turnId: 'turn-1' });
  assert.equal(adapter.send({ type: 'user_message', text: 'work', clientMsgId: 'c1' }), true);
  assert.deepEqual(sent.pop(), { type: 'user_message', text: 'work', clientMsgId: 'c1', taskShell: true });
  adapter.ingest({ type: 'task_shell_routed', clientMsgId: 'c1', receiptId: 'sr_1', sessionId: 'same' });
  assert.equal(adapter.send({ type: 'user_message', text: 'answer', clientMsgId: 'c2', userInputRequestId: 'q1' }), true);
  assert.deepEqual(sent.pop(), { type: 'user_message', text: 'answer', clientMsgId: 'c2', userInputRequestId: 'q1', taskShell: true, turnId: 'turn-1' });
  adapter.ingest({ type: 'task_shell_routed', clientMsgId: 'c2', receiptId: 'sr_2', sessionId: 'same' });
  assert.equal(adapter.send({ type: 'cancel' }), true);
  assert.deepEqual(sent.pop(), { type: 'cancel', taskShell: true, turnId: 'turn-1', clientMsgId: 'cancel-1' });
});

test('shell receipts buffer until acknowledgement, remap client identity and replay idempotently', () => {
  const sent = [];
  const adapter = createTransportAdapter({ send: value => (sent.push(value), true) });
  adapter.ingest({ type: 'system', subtype: 'init', is_streaming: false, taskShell: true });
  adapter.send({ type: 'user_message', text: 'hello', clientMsgId: 'client-1' });
  assert.deepEqual(adapter.ingest({ type: 'message_admission_progress', clientMsgId: 'sr_1', state: 'waiting' }).events, []);
  assert.equal(adapter.replayPending(), true);
  assert.equal(sent.length, 2);
  const routed = adapter.ingest({ type: 'task_shell_routed', clientMsgId: 'client-1', receiptId: 'sr_1', sessionId: 'execution' });
  assert.equal(routed.routeSessionId, 'execution');
  assert.equal(routed.events[0].clientMsgId, 'client-1');
  assert.equal(adapter.state().pending, null);
});

test('user-facing chat entry never navigates to the manual task shell', () => {
  const root = path.join(__dirname, '..');
  const entry = fs.readFileSync(path.join(root, 'public/chat-shell-entry.js'), 'utf8');
  const boot = fs.readFileSync(path.join(root, 'public/chat-task-boot.js'), 'utf8');
  assert.doesNotMatch(entry, /task-shell\.html/);
  assert.doesNotMatch(boot, /task-shell\.html/);
});
