'use strict';

// The native chat session table behind src/ws/ws-host.js: replay buffer,
// ordered membership, OPEN-filtered fan-out, the reconnect burst and the
// lifecycle paths. Everything runs against the real RustWsHost; fake sockets
// only record what the native send path actually delivered.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createChatSessions } = require('../src/chat/sessions');
const { createChatReplayHub, createChatReplayRuntime } = require('../src/ws/ws-host');
const { createStateOwner } = require('../src/state/owner');
const { createTestChatHub } = require('./helpers/native-chat-hub');

const CLOSED = 3;
const frame = n => ({ type: 'stream_event', n });

test('push stores the enveloped frame and the 500 cap evicts the oldest first', () => {
  const { hub, host } = createTestChatHub();
  for (let i = 0; i < 620; i += 1) assert.equal(hub.push('s', frame(i)), true);
  assert.equal(hub.size('s'), 500);
  const frames = host.replayFrames('s');
  assert.equal(frames[0], '{"type":"stream_event","n":120,"apiVersion":"v1"}');
  assert.equal(frames.at(-1), '{"type":"stream_event","n":619,"apiVersion":"v1"}');
  assert.deepEqual(hub.events('s').map(event => event.n), Array.from({ length: 500 }, (_, i) => i + 120));
});

test('an event the envelope rejects is not buffered and push never throws', () => {
  const { hub } = createTestChatHub();
  assert.equal(hub.push('s', { no: 'type' }), false);
  assert.equal(hub.push('s', null), false);
  const cyclic = { type: 'stream_event' };
  cyclic.self = cyclic;
  assert.equal(hub.push('s', cyclic), false);
  assert.equal(hub.size('s'), 0);
});

test('原生写入和广播保留宿主的帧字节与序列化语义', () => {
  const { hub, host, attach } = createTestChatHub();
  const { createWsEnvelope } = require('../src/api-contract');
  const client = attach();
  hub.join('s', client.id);
  const event = {
    type: 'stream_event',
    apiVersion: 'obsolete',
    delta: '你好',
    value: { toJSON() { return '\ud800'; } },
  };
  const expected = JSON.stringify(createWsEnvelope(event));
  assert.equal(hub.push('s', event), true);
  assert.deepEqual(host.replayFrames('s'), [expected]);
  assert.deepEqual(hub.events('s'), [JSON.parse(expected)]);
  assert.equal(hub.broadcast('s', event), 1);
  assert.deepEqual(client.socket.sent, [expected]);
});

test('clear empties one session only and an unknown session is a no-op', () => {
  const { hub } = createTestChatHub();
  hub.push('a', frame(1));
  hub.push('b', frame(2));
  hub.clear('a');
  hub.clear('never-seen');
  assert.equal(hub.size('a'), 0);
  assert.equal(hub.size('b'), 1);
  assert.equal(hub.size('never-seen'), 0);
});

test('membership keeps insertion order, join is idempotent and leave/clear remove', () => {
  const { hub, host, attach } = createTestChatHub();
  const [a, b, c] = [attach(), attach(), attach()];
  hub.join('s', a.id); hub.join('s', b.id); hub.join('s', c.id);
  hub.join('s', a.id); // already a member: keeps its first position
  assert.deepEqual(host.clientIds('s'), [a.id, b.id, c.id]);
  hub.leave('s', b.id);
  hub.join('s', b.id); // re-join goes to the end, like Set delete + add
  assert.deepEqual(host.clientIds('s'), [a.id, c.id, b.id]);
  assert.equal(hub.clientCount('s'), 3);
  hub.clearClients('s');
  assert.equal(hub.clientCount('s'), 0);
});

test('clientsOf is a live read-only size view', () => {
  const { hub, attach } = createTestChatHub();
  const view = hub.clientsOf('s');
  assert.equal(view.size, 0);
  const a = attach();
  hub.join('s', a.id);
  assert.equal(view.size, 1);
  assert.equal(typeof view.add, 'undefined');
  assert.equal(typeof view.delete, 'undefined');
  assert.equal(Object.isFrozen(view), true);
});

test('fan-out encodes once, goes to OPEN members in order and survives a throwing send', () => {
  const { hub, attach, deliveries } = createTestChatHub();
  const first = attach();
  const closed = attach({ readyState: CLOSED });
  const broken = attach({ throwOnSend: true });
  const last = attach();
  for (const member of [first, closed, broken, last]) hub.join('s', member.id);
  const attempted = hub.broadcast('s', { type: 'stream_event', delta: '你好' });
  assert.equal(attempted, 3, 'the closed socket is skipped, the broken one is still attempted');
  const expected = '{"type":"stream_event","delta":"你好","apiVersion":"v1"}';
  assert.deepEqual(first.socket.sent, [expected]);
  assert.deepEqual(last.socket.sent, [expected]);
  assert.deepEqual(closed.socket.sent, []);
  assert.deepEqual(broken.socket.sent, []);
  assert.deepEqual(deliveries.map(entry => entry.id), [first.id, last.id], 'delivery follows membership order');
  assert.equal(hub.broadcast('nobody-home', { type: 'x' }), 0);
});

test('the reconnect burst replays every buffered frame in order to that connection only', () => {
  const { hub, attach, deliveries } = createTestChatHub();
  const live = attach();
  const reconnecting = attach();
  hub.join('s', live.id);
  for (let i = 0; i < 500; i += 1) hub.push('s', frame(i));
  assert.equal(hub.burst(reconnecting.id, 's'), 500);
  assert.equal(reconnecting.socket.sent.length, 500);
  assert.equal(reconnecting.socket.sent[0], '{"type":"stream_event","n":0,"apiVersion":"v1"}');
  assert.equal(reconnecting.socket.sent[499], '{"type":"stream_event","n":499,"apiVersion":"v1"}');
  assert.deepEqual(live.socket.sent, []);
  assert.deepEqual(deliveries.map(entry => entry.id), new Array(500).fill(reconnecting.id));
  assert.equal(hub.burst(reconnecting.id, 'empty'), 0);
});

test('the burst bypasses the message-count tripwire a normal send would trip', () => {
  const { hub, host, attach } = createTestChatHub();
  const stall = connection => { connection.socket.ports.sendFrame = () => {}; };
  const prefill = connection => {
    for (let i = 0; i < 3800; i += 1) host.send(connection.id, `p${i}`, undefined, undefined, connection.socket.ports);
  };
  for (let i = 0; i < 500; i += 1) hub.push('s', frame(i));
  // Control: 3800 queued + 500 ordinary sends crosses maxQueueMessages (4096).
  const ordinary = attach(); stall(ordinary); prefill(ordinary);
  for (let i = 0; i < 500; i += 1) host.send(ordinary.id, `n${i}`, undefined, undefined, ordinary.socket.ports);
  assert.equal(ordinary.socket.closedWith?.code, 1013, 'the control must trip queue_overflow');
  // The same load as a reconnect burst must not.
  const reconnecting = attach(); stall(reconnecting); prefill(reconnecting);
  assert.equal(hub.burst(reconnecting.id, 's'), 500);
  assert.equal(reconnecting.socket.closedWith, null);
  assert.equal(host.stats(reconnecting.id).queueMessages, 4299);
});

test('detaching a connection removes it from every session', () => {
  const { hub, host, attach, ports } = createTestChatHub();
  const a = attach();
  const b = attach();
  hub.join('s1', a.id); hub.join('s1', b.id); hub.join('s2', a.id);
  host.detach(a.id, ports);
  assert.deepEqual(host.clientIds('s1'), [b.id]);
  assert.deepEqual(host.clientIds('s2'), []);
});

test('drop terminates every member in order and forgets the buffer', () => {
  const { hub, attach } = createTestChatHub();
  const a = attach();
  const stale = attach({ readyState: CLOSED });
  hub.join('s', a.id); hub.join('s', stale.id);
  hub.push('s', frame(1));
  assert.equal(hub.drop('s'), 2);
  assert.equal(a.socket.terminated, true);
  assert.equal(stale.socket.terminated, true, 'destroy terminates regardless of readyState, like the old loop');
  assert.equal(hub.size('s'), 0);
  assert.equal(hub.clientCount('s'), 0);
  assert.equal(hub.drop('s'), 0);
});

test('reset forgets a session without touching its sockets', () => {
  const { hub, attach } = createTestChatHub();
  const a = attach();
  hub.join('s', a.id);
  hub.push('s', frame(1));
  hub.reset('s');
  assert.equal(hub.size('s'), 0);
  assert.equal(hub.clientCount('s'), 0);
  assert.equal(a.socket.terminated, false);
});

test('sessions are isolated from each other', () => {
  const { hub, attach } = createTestChatHub();
  const a = attach();
  const b = attach();
  hub.join('one', a.id); hub.join('two', b.id);
  hub.push('one', frame(1));
  hub.broadcast('two', { type: 'stream_event', n: 2 });
  assert.equal(hub.size('two'), 0);
  assert.deepEqual(a.socket.sent, []);
  assert.equal(b.socket.sent.length, 1);
});

test('removing a chat session from the table forgets its replay state (delete and clear)', () => {
  const chatSessions = createChatSessions(createStateOwner());
  const { chatReplay, wsHost } = createChatReplayRuntime(chatSessions);
  chatSessions.set('gone', { id: 'gone' });
  chatSessions.set('kept', { id: 'kept' });
  chatReplay.push('gone', frame(1));
  chatReplay.push('kept', frame(2));
  assert.equal(chatSessions.delete('gone'), true);
  assert.equal(chatReplay.size('gone'), 0);
  assert.equal(chatReplay.size('kept'), 1);
  chatSessions.clear();
  assert.equal(chatReplay.size('kept'), 0);
  assert.equal(wsHost.replayLen('kept'), 0);
});

test('the hub rejects a host without chat session support', () => {
  assert.throws(() => createChatReplayHub({ host: {} }), TypeError);
});

test('real captured stream frames survive push byte for byte', () => {
  // Re-enveloping an already enveloped real frame must not change one byte:
  // that is what makes storing the encoded frame at push time equivalent to
  // the retired burst-time encode.
  const golden = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../docs/rust-migration/differential/chat-replay-buffer-golden.json'), 'utf8'));
  const { hub, host } = createTestChatHub();
  let checked = 0;
  for (const scenario of golden.scenarios) {
    hub.clear('s');
    const expected = [];
    for (const wire of scenario.frameBytes) {
      const text = Buffer.from(wire.base64, 'base64').toString('utf8');
      if (JSON.parse(text).type !== 'stream_event') continue;
      expected.push(text);
      assert.equal(hub.push('s', JSON.parse(text)), true);
    }
    assert.deepEqual(host.replayFrames('s'), expected, scenario.name);
    checked += expected.length;
  }
  assert.ok(checked > 500, 'the capture must exercise real frames, not an empty set');
});
