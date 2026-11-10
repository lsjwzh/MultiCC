'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createErrorPersister, isRecoverableReconnect } = require('../src/chat/error-persistence');

function setup(extra = {}) {
  const appended = [];
  const clock = { t: 1000 };
  const persister = createErrorPersister({
    appendChatMessage: (id, m) => { appended.push({ id, m }); return true; },
    now: () => clock.t,
    ...extra,
  });
  return { appended, clock, persister };
}

test('an error event is written to history as a system message and keyed for replay', () => {
  const { appended, persister } = setup();
  const out = persister.annotate('s1', { type: 'error', error: 'Codex 出错：404 model not found', code: 'upstream' });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].id, 's1');
  assert.equal(appended[0].m.role, 'system');
  assert.equal(appended[0].m.content, 'Error: Codex 出错：404 model not found');
  assert.equal(appended[0].m.errorEvent, true);
  assert.equal(appended[0].m.errorCode, 'upstream');
  assert.match(out.errorClientMsgId, /^err-[0-9a-f]{16}$/);
  assert.equal(appended[0].m.clientMsgId, out.errorClientMsgId);
});

test('non-error events, empty errors and transient reconnects are not persisted', () => {
  const { appended, persister } = setup();
  const result = { type: 'result' };
  assert.equal(persister.annotate('s1', result), result);
  persister.annotate('s1', { type: 'error', error: '   ' });
  persister.annotate('s1', { type: 'error', error: 'Codex 出错：Reconnecting... 1/5' });
  persister.annotate('s1', { type: 'error', error: 'Codex 出错：Reconnecting... 2/5 (stream disconnected before completion)' });
  assert.equal(appended.length, 0);
  assert.equal(isRecoverableReconnect('boom'), false);
});

test('the same error inside the window is stored once and reuses its key', () => {
  const { appended, clock, persister } = setup();
  const a = persister.annotate('s1', { type: 'error', error: 'x' });
  clock.t += 2000;
  const b = persister.annotate('s1', { type: 'error', error: 'x' });
  assert.equal(appended.length, 1);
  assert.equal(b.errorClientMsgId, a.errorClientMsgId);
  // a different session, or the same text after the window, is a new record
  persister.annotate('s2', { type: 'error', error: 'x' });
  clock.t += 20_000;
  persister.annotate('s1', { type: 'error', error: 'x' });
  assert.equal(appended.length, 3);
});

test('a failed append never breaks the broadcast and only warns', async () => {
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args) };
  const payload = { type: 'error', error: 'x' };
  // The durable write is asynchronous, so the live frame advertises the replay
  // key up front; a rejected write is reported afterwards and never throws into
  // the broadcast path.
  const refused = createErrorPersister({ appendChatMessage: () => false, logger }).annotate('s1', payload);
  assert.match(refused.errorClientMsgId, /^err-[0-9a-f]{16}$/);
  const rejected = createErrorPersister({ appendChatMessage: () => Promise.reject(new Error('disk full')), logger })
    .annotate('s1', payload);
  assert.match(rejected.errorClientMsgId, /^err-[0-9a-f]{16}$/);
  // A port that throws synchronously cannot produce a verdict at all, so the
  // original frame is broadcast untouched.
  const thrown = createErrorPersister({ appendChatMessage: () => { throw new Error('disk'); }, logger })
    .annotate('s1', payload);
  assert.equal(thrown, payload);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(warnings.filter(args => args[0] === 'chat_error_persist_failed').length, 3);
});

// The dedupe entry is only a claim while the write is in flight. A failed write
// must release it, otherwise the same error broadcast again would reuse an id
// whose row never landed and history would stay permanently empty.
test('a failed write releases the dedupe claim and the same error is retried', async () => {
  const appended = [];
  let attempt = 0;
  const persister = createErrorPersister({
    appendChatMessage: (id, message) => {
      appended.push(message);
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('disk full')) : true;
    },
    now: () => 1000,
    logger: { warn: () => {} },
  });
  const first = persister.annotate('s1', { type: 'error', error: 'same failure' });
  // A concurrent identical broadcast while the first write is in flight still
  // dedupes instead of enqueueing a second row.
  const concurrent = persister.annotate('s1', { type: 'error', error: 'same failure' });
  assert.equal(appended.length, 1);
  assert.equal(concurrent.errorClientMsgId, first.errorClientMsgId);
  await new Promise(resolve => setImmediate(resolve));
  const retried = persister.annotate('s1', { type: 'error', error: 'same failure' });
  assert.equal(appended.length, 2, 'the failed row can be written again');
  assert.equal(retried.errorClientMsgId, first.errorClientMsgId,
    'the replay key advertised with the first broadcast is kept');
});

// A synchronous throw happens before anything is enqueued. Its claim must be
// released as well, otherwise the next identical error would reuse an id whose
// row never existed and the line would stay absent from history.
test('a synchronously thrown write also releases the dedupe claim', () => {
  let attempt = 0;
  const persister = createErrorPersister({
    appendChatMessage: () => {
      attempt += 1;
      if (attempt === 1) throw new Error('serializer blew up');
      return true;
    },
    now: () => 1000,
    logger: { warn: () => {} },
  });
  const first = persister.annotate('s1', { type: 'error', error: 'sync failure' });
  assert.equal(first.errorClientMsgId, undefined, 'no id is advertised for an unwritten row');
  const retried = persister.annotate('s1', { type: 'error', error: 'sync failure' });
  assert.match(retried.errorClientMsgId, /^err-[0-9a-f]{16}$/);
  assert.equal(attempt, 2, 'the same error is written again instead of deduping onto a missing row');
});
