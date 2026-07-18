'use strict';
// Deterministic contract tests for plugins/bridges/gateway-core.js.
// Uses in-memory Maps and a fake WebSocket implementation so nothing touches
// real Slack/Feishu/Discord/Telegram/WeChat servers.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const core = require('../plugins/bridges/gateway-core');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name); }
}

// ── fake WebSocket ────────────────────────────────────────────────────
class FakeWS extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;                // CONNECTING
    this.sent = [];
  }
  send(s) { this.sent.push(s); }
  close() { this.readyState = 3; process.nextTick(() => this.emit('close')); }
  markOpen() { this.readyState = 1; process.nextTick(() => this.emit('open')); }
}
// Node's `ws` module puts state constants on the class as read-only; we can't
// patch them for FakeWS. Instead FakeWS uses the numeric values that match
// (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED) — that's what gateway-core's
// `readyState === WebSocket.OPEN` check tests against, so our fakes work
// without touching the real class.

(async () => {

  // ── stripDispatchMarkers ───────────────────────────────────────────
  {
    ok(core.stripDispatchMarkers('hello') === 'hello', 'strip: passthrough text');
    ok(core.stripDispatchMarkers('before<<dispatch target="x">payload</dispatch>>after') === 'beforeafter',
      'strip: removes single marker');
    ok(core.stripDispatchMarkers('a\n\n\n\nb') === 'a\n\nb', 'strip: collapses 3+ newlines');
    ok(core.stripDispatchMarkers('') === '', 'strip: empty stays empty');
    ok(core.stripDispatchMarkers(null) === '', 'strip: nullish stays empty');
  }

  // ── hashText + echo store ──────────────────────────────────────────
  {
    ok(core.hashText('a   b\n c') === 'a b c', 'hashText: whitespace collapse');
    ok(core.hashText('x'.repeat(500)).length === 200, 'hashText: truncated to 200');
    let now = 1000;
    const echo = core.createEchoStore({ ttlMs: 100, now: () => now });
    echo.add('hello world greetings friends');
    ok(echo.isEcho('hello world greetings friends'), 'echo: exact hit');
    ok(echo.isEcho('hello world greetings friends and more!'), 'echo: substring overlap ≥12 chars');
    ok(!echo.isEcho('nope'), 'echo: unrelated text not echo');
    ok(!echo.isEcho('确认'), 'echo: 2-char reply not swallowed (overlap floor 12)');
    now = 2000;
    ok(!echo.isEcho('hello world greetings friends'), 'echo: expired entry sweeps');
    ok(echo._size() === 0, 'echo: sweep on lookup empties store');
    ok(echo.isEcho(''), 'echo: empty text always considered echo (guards blank inbound)');
  }

  // ── log store ─────────────────────────────────────────────────────
  {
    const log = core.createLogStore({ max: 3 });
    const chunks = [];
    const client = { write: (s) => chunks.push(s) };
    log.addClient(client);
    log.push('in', 'a');
    log.push('out', 'b');
    log.push('system', 'c');
    log.push('error', 'd');
    ok(log.snapshot().length === 3 && log.snapshot()[0].text === 'b', 'log: ring bounded to max, oldest dropped');
    ok(chunks.length === 4 && chunks.every(c => c.startsWith('data: ')), 'log: SSE clients receive each push');
    const parsed = JSON.parse(chunks[0].slice(6));
    ok(parsed.type === 'in' && parsed.text === 'a' && typeof parsed.ts === 'string',
      'log: SSE entry carries {type, text, ts}');
    // Broken client: writes throw → auto-removed
    log.addClient({ write: () => { throw new Error('closed'); } });
    log.push('system', 'boom');
    // Filter since
    const sinceIso = new Date(Date.now() - 60_000).toISOString();
    const filtered = log.filterSince(new Date(sinceIso).getTime());
    ok(Array.isArray(filtered), 'log: filterSince returns array');
  }

  // ── gateway lifecycle: create → switch → destroy → reset ───────────
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwcore-'));
    const persistedSessions = new Map();
    const chatSessions = new Map();
    let saveCalls = 0;
    const bridgeHistoryFile = (id) => path.join(dir, `${id}.history.json`);
    let disconnects = 0, reconnects = 0;
    const chatWsCtl = {
      disconnect: () => { disconnects++; },
      reconnectIfRunning: () => { reconnects++; },
    };
    const logs = [];
    const gw = core.createGatewayLifecycle({
      sessionId: '__test_gateway__',
      cwd: path.join(dir, 'gateway-cwd'),
      label: 'Test Gateway',
      platformLabel: 'Test',
      persistedSessions,
      chatSessions,
      savePersistedSessions: () => { saveCalls++; },
      bridgeHistoryFile,
      chatWsCtl,
      log: (type, text) => logs.push({ type, text }),
    });

    ok(gw.get() === null, 'lifecycle: get() null before create');

    let threw = false;
    try { gw.create('bogus'); } catch (_) { threw = true; }
    ok(threw, 'lifecycle: create rejects unknown cli');

    const rec = gw.create('claude');
    ok(rec.id === '__test_gateway__' && rec.cli === 'claude' && rec.type === 'gateway',
      'lifecycle: create returns record with expected shape');
    ok(gw.get() === rec && persistedSessions.get('__test_gateway__') === rec,
      'lifecycle: record present in persistedSessions Map');
    ok(saveCalls === 1, 'lifecycle: create saves once');
    ok(fs.existsSync(path.join(dir, 'gateway-cwd')), 'lifecycle: create ensures cwd exists');

    threw = false;
    try { gw.create('codex'); } catch (_) { threw = true; }
    ok(threw, 'lifecycle: second create throws');

    // Switch cli
    const cs = { claudeProc: { killed: false, kill: function() { this.killed = true; } }, chatTurnCount: 5 };
    chatSessions.set('__test_gateway__', cs);
    const rec2 = gw.switchCli('codex');
    ok(rec2.cli === 'codex' && rec2.cliSessionId === null, 'lifecycle: switchCli mutates record');
    ok(cs.claudeProc === null && cs.cli === 'codex' && cs.chatTurnCount === 0,
      'lifecycle: switchCli kills claudeProc + resets chat session');
    ok(disconnects === 1 && reconnects === 1, 'lifecycle: switchCli bounces chat WS');
    // Same-cli switch is a no-op
    const before = saveCalls;
    gw.switchCli('codex');
    ok(saveCalls === before, 'lifecycle: switchCli(same) does not re-save');

    // Reset history
    fs.writeFileSync(bridgeHistoryFile('__test_gateway__'), '{}');
    chatSessions.set('__test_gateway__', { claudeProc: { kill: () => {} }, chatTurnCount: 9 });
    gw.resetHistory();
    ok(!fs.existsSync(bridgeHistoryFile('__test_gateway__')), 'lifecycle: resetHistory removes history file');
    ok(chatSessions.get('__test_gateway__').chatTurnCount === 0, 'lifecycle: resetHistory resets chatTurnCount');
    // codex cli → cliSessionId stays null on reset (only claude gets a fresh UUID)
    ok(gw.get().cliSessionId === null, 'lifecycle: resetHistory keeps null for codex');

    // Destroy
    gw.destroy();
    ok(gw.get() === null && !persistedSessions.has('__test_gateway__'),
      'lifecycle: destroy removes record');
    ok(!chatSessions.has('__test_gateway__'), 'lifecycle: destroy removes chat session');

    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── chat WS client: connect → user message → assistant + result flush ──
  {
    let running = true;
    let getGw = () => ({ id: 's1' });
    const created = [];
    let wsInstance = null;
    const wsFactory = (url) => { const w = new FakeWS(url); wsInstance = w; created.push(w); return w; };

    const flushed = [];
    const client = core.createChatWsClient({
      port: 4000,
      sessionId: 's1',
      getGateway: () => getGw(),
      isRunning: () => running,
      log: () => {},
      onTurn: async (t) => { flushed.push(t); },
      wsFactory,
      reconnectDelayMs: 10,
      hostLabel: 'Test',
    });

    client.connect();
    ok(created.length === 1 && created[0].url === 'ws://127.0.0.1:4000/ws/chat?session=s1',
      'chatWs: connect uses expected url shape');

    // Cannot send while CONNECTING
    ok(client.sendUserMessage('hi') === false, 'chatWs: sendUserMessage refuses while not OPEN');

    // Open
    wsInstance.markOpen();
    await new Promise(r => setImmediate(r));
    ok(client.isOpen() === true, 'chatWs: isOpen true after handshake');
    ok(client.sendUserMessage('hi there') === true, 'chatWs: sendUserMessage succeeds when OPEN');
    ok(wsInstance.sent.length === 1 && JSON.parse(wsInstance.sent[0]).type === 'user_message',
      'chatWs: emits user_message frame');
    ok(client._peekTurnInProgress() === true, 'chatWs: turnInProgress after send');

    // Feed events: two assistant blocks + result → onTurn called with dispatch-stripped text
    client._feed({ type: 'system', subtype: 'init' });   // ignored
    client._feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world.' }] } });
    client._feed({ type: 'assistant', message: { content: [{ type: 'text', text: ' <<dispatch target="foo">hidden</dispatch>> end.' }] } });
    client._feed({ type: 'result' });
    await new Promise(r => setImmediate(r));
    ok(flushed.length === 1 && flushed[0] === 'Hello world.  end.'.replace(/  /g, ' ').trim() || flushed[0] === 'Hello world.  end.',
      'chatWs: assistant text flushed on result, dispatch stripped');
    ok(client._peekAssistantText() === '' && client._peekTurnInProgress() === false,
      'chatWs: buffers cleared after flush');

    // Error event turns turnInProgress off without flushing
    client.sendUserMessage('again');
    client._feed({ type: 'error', error: 'boom' });
    ok(client._peekTurnInProgress() === false, 'chatWs: error event clears turnInProgress');

    // Reconnect after close while running
    const before = created.length;
    wsInstance.emit('close');
    await new Promise(r => setTimeout(r, 30));
    ok(created.length === before + 1, 'chatWs: reconnects on close when running');

    // No reconnect when running=false
    running = false;
    const after = created.length;
    created[created.length - 1].emit('close');
    await new Promise(r => setTimeout(r, 30));
    ok(created.length === after, 'chatWs: skips reconnect when not running');

    // No reconnect when gateway missing
    running = true;
    getGw = () => null;
    const now = created.length;
    client.connect();
    ok(created.length === now, 'chatWs: connect no-ops when gateway missing');

    client.disconnect();
  }

  // ── chunkOutbound ──────────────────────────────────────────────────
  {
    ok(core.chunkOutbound('short', { max: 100 }).join('|') === 'short', 'chunk: text under max is one chunk');
    const long = 'a'.repeat(50) + '\n' + 'b'.repeat(50);
    const c = core.chunkOutbound(long, { max: 60 });
    ok(c.length === 2 && c[0].endsWith('a'.repeat(50)) && c[1].startsWith('(续2) '),
      'chunk: breaks on newline, continuation prefix on subsequent chunks');
    const hard = 'x'.repeat(200);
    const c2 = core.chunkOutbound(hard, { max: 50 });
    ok(c2.length === 4 && c2[0].length === 50 && c2[1].startsWith('(续2) '),
      'chunk: falls back to hard cut when no newline in reach');
    let threw = false;
    try { core.chunkOutbound('x', {}); } catch (_) { threw = true; }
    ok(threw, 'chunk: throws without max');
  }

  console.log(`\n== gateway-core unit: ${pass} passed, ${fail} failed ==`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
