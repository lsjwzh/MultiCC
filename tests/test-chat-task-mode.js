'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('../public/chat-shell-entry');
const response = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });

test('ordinary chat enters the canonical shell and task links resolve their bound execution', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/chat-session')) return response({ ok: true, sessionId: 'bound' });
    if (url.endsWith('/tasks/resolve')) return response({ id: 'task-one', title: 'Task one' });
    return response({ id: 'sh_main' });
  };
  assert.equal(await resolve({ sessionId: 'ordinary', fetch }), '/task-shell.html?shell=sh_main');
  assert.equal(await resolve({ taskId: 'task-one', fetch }), '/task-shell.html?shell=sh_main&task=task-one');
  assert.equal(calls.at(-1).url, '/api/task-shells/sh_main/tasks/resolve');
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { taskId: 'task-one' });
});

test('HTTP failures never enter the deleted task projection or legacy send path', async () => {
  for (const status of [401, 403, 404, 409, 500, 501, 502]) {
    await assert.rejects(resolve({ taskId: 'task-one', fetch: async () => response({ error: 'failed' }, status) }));
    await assert.rejects(resolve({ sessionId: 'ordinary', fetch: async () => response({ code: 'failed' }, status) }));
  }
  await assert.rejects(resolve({ sessionId: 'ordinary', fetch: async () => { throw new Error('offline'); } }));
});

test('only an explicitly unsupported system session stays in the system chat', async () => {
  const fetch = async () => response({ code: 'unsupported_source' }, 400);
  assert.equal(await resolve({ sessionId: 'gateway', fetch }), null);
  await assert.rejects(resolve({ taskId: 'task', fetch }));
});

test('a pre-restart server route table keeps the old shell page instead of breaking task links', async () => {
  const fetch = async url => {
    if (url.endsWith('/chat-session')) return response({ ok: true, sessionId: 'bound' });
    if (url.endsWith('/tasks/resolve')) return { ok: false, status: 404, json: async () => { throw new SyntaxError('HTML'); } };
    return response({ id: 'sh_main' });
  };
  assert.equal(await resolve({ taskId: 'task-one', fetch }), '/task-shell.html?shell=sh_main');
});
