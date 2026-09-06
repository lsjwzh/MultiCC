'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chatUrl, createTransportAdapter, resolve } = require('../public/chat-shell-entry');
const response = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });

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
