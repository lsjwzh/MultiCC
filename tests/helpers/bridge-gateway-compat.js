'use strict';
// Independent oracle: exact baseline bytes, never wired into production.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fixture = path.join(__dirname, 'legacy-bridge-gateway-783f25a.js');
const baselineHash = '850af51a581062c90e77fdd931d604ed8db91d1bd33b84638d7ef7046dcc8fc4';
const tick = () => new Promise(resolve => setImmediate(resolve));

function textCorpus(core, legacy) {
  const texts = [undefined, null, false, 0, NaN, '', ' \u0085\u00a0\ufeff ', '😀😀😀😀😀😀',
    '\ud800x\udfff', 'a\r\n\r\n\r\nb', 'a\n\n\n\nb',
    'a<<dispatch target="x">hidden</dispatch>>b',
    'a<<dispatch\ufefftarget="x"\t>\ud800</dispatch>>\nb',
    '<<dispatch target="">kept</dispatch>>', '<<dispatch target=\'x\'>kept</dispatch>>',
    '<<dispatch target="x">outer<<dispatch target="y">inner</dispatch>>tail</dispatch>>'];
  for (let i = 0; i < 80; i++) texts.push(('x'.repeat(i) + '\n😀\ud800\ufeff\u0085').repeat(i % 7));
  for (const value of texts) {
    assert.equal(core.stripDispatchMarkers(value), legacy.stripDispatchMarkers(value));
    assert.equal(core.hashText(value), legacy.hashText(value));
    for (const max of [1, 2, 7, 30, 200, 1.5, Infinity, '8']) {
      const opts = { max, continuationPrefix: i => `part${i}:` };
      assert.deepEqual(core.chunkOutbound(value, opts), legacy.chunkOutbound(value, opts));
    }
  }
  assert.equal(core.DISPATCH_MARKER_RE.source, legacy.DISPATCH_MARKER_RE.source);
  assert.equal(core.DISPATCH_MARKER_RE.flags, legacy.DISPATCH_MARKER_RE.flags);
  for (const max of [undefined, 0, -1, NaN]) {
    assert.throws(() => core.chunkOutbound('x', { max }), { name: 'TypeError', message: 'chunkOutbound: max chunk length required' });
  }
  let now = 100;
  const stores = [core, legacy].map(api => api.createEchoStore({ ttlMs: 10, now: () => now }));
  for (const s of stores) { s.add('😀😀😀😀😀😀'); s.add(' x  y '); }
  for (const clock of [100, 110, 111]) {
    now = clock;
    for (const value of ['😀😀😀😀😀😀 extra', 'x y', '', '确认']) {
      assert.equal(stores[0].isEcho(value), stores[1].isEcho(value));
    }
    assert.equal(stores[0]._size(), stores[1]._size());
  }
  const a = core.createEchoStore(), b = core.createEchoStore();
  a.add('separate platform stores'); assert.equal(b.isEcho('separate platform stores'), false);
  for (const clock of [() => '100', () => 100]) {
    const echoes = [core, legacy].map(api => api.createEchoStore({ ttlMs: '10', now: clock }));
    echoes.forEach(s => s.add('string clock compatibility'));
    assert.equal(echoes[0].isEcho('string clock compatibility'), echoes[1].isEcho('string clock compatibility'));
    assert.equal(echoes[0]._sweep('110'), echoes[1]._sweep('110'));
  }
}

function logCorpus(core, legacy) {
  function exercise(api, max) {
    const log = api.createLogStore({ max });
    const writes = [];
    let failedWrites = 0;
    const healthy = { write(s) { const value = JSON.parse(s.slice(6)); delete value.ts; writes.push(value); return false; } };
    log.addClient({ write() { failedWrites++; throw Error('closed'); } });
    log.addClient(healthy); log.addClient(healthy);
    for (let i = 0; i < 5; i++) log.push('in', `text${i}`);
    const copy = log.snapshot();
    if (copy.length) { copy[0].text = 'mutated'; copy[0].ts = '2000-01-01T00:00:00.000Z'; }
    copy.pop();
    const normalized = list => list.map(({ type, text }) => ({ type, text }));
    const snapshot = normalized(log.snapshot());
    const filtered = normalized(log.filterSince(Date.parse('2001-01-01T00:00:00Z')));
    const all = normalized(log.filterSince(NaN));
    log.removeClient(healthy); log.push('out', 'after remove');
    return { writes, failedWrites, snapshot, filtered, all, size: log._size() };
  }
  for (const max of [3, 0, -1, 1.5, Infinity, NaN]) assert.deepEqual(exercise(core, max), exercise(legacy, max));
}

async function lifecycleCorpus(core, legacy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-gateway-compat-'));
  try {
    async function exercise(api) {
      const sessions = new Map(), chats = new Map(), effects = [];
      const fault = Error('save failed'); let fail = true;
      const gw = api.createGatewayLifecycle({ sessionId: 'test', cwd: dir, label: 'Test', platformLabel: 'Test',
        persistedSessions: sessions, chatSessions: chats,
        savePersistedSessions() { effects.push('save'); if (fail) throw fault; },
        bridgeHistoryFile: () => path.join(dir, 'missing-history'),
        clearBridgeHistory: () => undefined, // injected history owner, legacy ignores it
        chatWsCtl: { disconnect() { effects.push('disconnect'); }, reconnectIfRunning() { effects.push('reconnect'); } },
        log(type, text) { effects.push([type, text]); },
      });
      assert.throws(() => gw.create('claude'), e => e === fault);
      const rec = sessions.get('test'); assert.equal(gw.get(), rec);
      assert.equal(gw.switchCli('claude'), rec); // same-cli does not call failing save
      const proc = { kill(signal) { effects.push(['kill', signal]); throw Error('kill failed'); } };
      const cs = { claudeProc: proc, chatTurnCount: 8 }; chats.set('test', cs);
      assert.throws(() => gw.switchCli('codex'), e => e === fault);
      assert.equal(rec.cli, 'codex'); assert.equal(cs.claudeProc, proc); assert.equal(cs.chatTurnCount, 8);
      fail = false;
      assert.equal(gw.switchCli('claude'), rec);
      assert.equal(cs.claudeProc, null); assert.equal(cs.chatTurnCount, 0);
      await gw.resetHistory(); assert.match(rec.cliSessionId, /^[a-f0-9-]{36}$/);
      gw.destroy(); assert.equal(gw.get(), null); assert.equal(chats.size, 0);
      assert.equal(gw.destroy(), undefined); assert.equal(gw.resetHistory(), undefined);
      assert.throws(() => gw.switchCli('bogus'), { message: 'Test gateway does not exist' });
      return effects;
    }
    assert.deepEqual(await exercise(core), await exercise(legacy));
    assert.throws(() => core.createGatewayLifecycle({ persistedSessions: {} }), {
      name: 'TypeError', message: 'gateway-core lifecycle: persistedSessions Map required',
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function wsCorpus(core, legacy) {
  async function exercise(api) {
    const sockets = [], turns = [], logs = [];
    let running = true, throwSend = false;
    class Socket extends EventEmitter {
      constructor(url) { super(); this.url = url; this.readyState = 0; this.sent = []; }
      close() { this.readyState = 3; }
      send(value) { if (throwSend) throw Error('send failed'); this.sent.push(value); }
    }
    const client = api.createChatWsClient({ port: 54321, sessionId: '😀 space', getGateway: () => ({}),
      isRunning: () => running, log: (type, text) => logs.push([type, text]),
      onTurn: async text => { turns.push(text); throw Error('outbound rejected'); },
      wsFactory(url) { const s = new Socket(url); sockets.push(s); return s; }, reconnectDelayMs: 10000,
    });
    try {
      client.connect(); client.connect(); assert.equal(sockets.length, 1);
      assert.equal(sockets[0].url, 'ws://127.0.0.1:54321/ws/chat?session=%F0%9F%98%80%20space');
      const opened = client.ensureOpen(100);
      sockets[0].readyState = 1; sockets[0].emit('open'); await opened;
      client.sendUserMessage(undefined); assert.equal(sockets[0].sent[0], '{"type":"user_message"}');
      sockets[0].emit('message', Buffer.from('invalid JSON'));
      client._feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'kept\ud800' }] } });
      client._feed({ type: 'error', error: 'failure' });
      assert.equal(client._peekAssistantText(), 'kept\ud800'); assert.equal(client._peekTurnInProgress(), false);
      client._feed({ type: 'result' }); assert.equal(turns.length, 0);
      await tick(); assert.deepEqual(turns, ['kept\ud800']);
      throwSend = true; assert.throws(() => client.sendUserMessage('x'), /send failed/);
      assert.equal(client._peekTurnInProgress(), true); assert.equal(client._peekAssistantText(), '');
      client.disconnect(); client.connect();
      await client.ensureOpen(1);
      assert.equal(sockets[1].listenerCount('open'), 2); // timeout leaves the once listener
      sockets[1].readyState = 1; assert.equal(client.isOpen(), true);
      // Historical race remains explicit: old close clears the newly-created slot.
      sockets[0].emit('close'); assert.equal(client.isOpen(), false);
      running = false; client.disconnect();
      return { logs, turns, count: sockets.length };
    } finally { running = false; client.disconnect(); }
  }
  assert.deepEqual(await exercise(core), await exercise(legacy));
}

module.exports = async function bridgeGatewayCompatibility(core) {
  assert.equal(createHash('sha256').update(fs.readFileSync(fixture)).digest('hex'), baselineHash);
  const legacy = require(fixture);
  assert.deepEqual(Object.keys(core), Object.keys(legacy));
  textCorpus(core, legacy); logCorpus(core, legacy); await lifecycleCorpus(core, legacy);
  await wsCorpus(core, legacy);
};
