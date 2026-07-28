'use strict';

// The recovery ladder. What these tests protect is that the three rungs stay
// distinct: reconnect must not reload, long-press must not also reconnect, and
// restartSpawn must not fire without a confirmation. Collapsing any two of them
// turns a cheap recovery into a destructive one behind the same tap.

const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../public/chat-recovery-service');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function element() {
  const listeners = new Map();
  return {
    disabled: false,
    listeners,
    addEventListener(type, handler) { listeners.set(type, handler); },
    fire(type, event = {}) { return listeners.get(type)?.(event); },
  };
}

function fixture({ confirmed = true, response, throws = false, sessionName = 's1' } = {}) {
  const reconnectBtn = element();
  const restartBtn = element();
  const statusEl = {};
  const document = {
    getElementById: id => ({ 'reconnect-btn': reconnectBtn, 'restart-spawn-btn': restartBtn }[id]),
  };
  const calls = { reconnect: [], reload: 0, messages: [], fetched: [], confirms: 0 };
  const api = create({
    document,
    window: {},
    translate: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    forceReconnect: reason => calls.reconnect.push(reason),
    reload: () => { calls.reload += 1; },
    statusEl,
    getSessionName: () => sessionName,
    addSystemMsg: text => calls.messages.push(text),
    withToken: url => `${url}?token=t`,
    confirm: async () => { calls.confirms += 1; return confirmed; },
    closeMoreMenu: () => {},
    longPressMs: 20,
    fetch: async (url, init) => {
      calls.fetched.push({ url, method: init.method });
      if (throws) throw new Error('offline');
      return response;
    },
  });
  return { api, calls, reconnectBtn, restartBtn, statusEl };
}

const okResponse = body => ({ ok: true, status: 200, json: async () => body });

test('tapping reconnect rebuilds the transport and nothing else', async () => {
  const { calls, reconnectBtn } = fixture();
  reconnectBtn.fire('click');
  assert.deepEqual(calls.reconnect, ['manual button']);
  assert.equal(calls.reload, 0, 'a tap must never escalate to a page reload');
  assert.deepEqual(calls.fetched, [], 'a tap must never touch the server');
});

test('long-press escalates to reload, and the trailing click does not also reconnect', async () => {
  const { calls, reconnectBtn } = fixture();
  reconnectBtn.fire('mousedown');
  await sleep(45);
  assert.equal(calls.reload, 1);
  reconnectBtn.fire('click'); // the click browsers emit after the long press
  assert.deepEqual(calls.reconnect, [], 'the long press already acted; the click must be swallowed');
});

test('releasing before the threshold cancels the reload', async () => {
  const { calls, reconnectBtn } = fixture();
  reconnectBtn.fire('touchstart');
  reconnectBtn.fire('touchend');
  await sleep(45);
  assert.equal(calls.reload, 0);
});

test('the status pill is a reconnect affordance', () => {
  const { calls, statusEl } = fixture();
  statusEl.onclick();
  assert.deepEqual(calls.reconnect, ['status click']);
});

test('restart spawn does nothing without confirmation', async () => {
  const { api, calls } = fixture({ confirmed: false });
  const result = await api.restartSpawn();
  assert.equal(result.ok, false);
  assert.equal(calls.confirms, 1);
  assert.deepEqual(calls.fetched, [], 'declining the dialog must not kill the process');
});

test('restart spawn posts to the session route and resyncs the tab', async () => {
  const { api, calls } = fixture({ response: okResponse({ ok: true, before: { pid: 4242 } }) });
  const result = await api.restartSpawn();
  assert.equal(result.ok, true);
  assert.deepEqual(calls.fetched, [{ url: '/api/sessions/s1/restart-spawn?token=t', method: 'POST' }]);
  assert.match(calls.messages[0], /^restartSpawnDone:/);
  assert.match(calls.messages[0], /4242/, 'the report names the process that was killed');
  assert.deepEqual(calls.reconnect, ['restart-spawn'],
    'the old process is gone, so the tab must stop describing it');
});

test('restart spawn escapes the session name', async () => {
  const { api, calls } = fixture({
    sessionName: 'a/b c', response: okResponse({ ok: true, before: { pid: 1 } }),
  });
  await api.restartSpawn();
  assert.equal(calls.fetched[0].url, '/api/sessions/a%2Fb%20c/restart-spawn?token=t');
});

test('a rejected restart is reported and does not fake a resync', async () => {
  const { api, calls } = fixture({
    response: { ok: false, status: 400, json: async () => ({ error: 'terminal sessions use /restart' }) },
  });
  const result = await api.restartSpawn();
  assert.equal(result.ok, false);
  assert.match(calls.messages[0], /restartSpawnFailed/);
  assert.match(calls.messages[0], /terminal sessions use/);
  assert.deepEqual(calls.reconnect, []);
});

test('a network failure is reported rather than swallowed', async () => {
  const { api, calls } = fixture({ throws: true, response: okResponse({}) });
  const result = await api.restartSpawn();
  assert.equal(result.ok, false);
  assert.match(calls.messages[0], /restartSpawnFailed/);
  assert.match(calls.messages[0], /offline/);
  assert.deepEqual(calls.reconnect, []);
});

test('restart spawn refuses to fire without a session name', async () => {
  const { api, calls } = fixture({ sessionName: '' });
  const result = await api.restartSpawn();
  assert.equal(result.ok, false);
  assert.deepEqual(calls.messages, ['sessionIdMissing']);
  assert.equal(calls.confirms, 0, 'no point asking about a session we cannot name');
  assert.deepEqual(calls.fetched, []);
});

test('the restart button re-enables itself even when the request fails', async () => {
  const { calls, restartBtn } = fixture({ throws: true, response: okResponse({}) });
  await restartBtn.fire('click');
  assert.equal(restartBtn.disabled, false, 'a failed attempt must not leave the button dead');
  assert.match(calls.messages[0], /restartSpawnFailed/);
});
