'use strict';

// Test Node child for native/gateway/tests/ws_chat.rs. It loads the real bridge
// client (src/ws/gateway-chat-bridge.js, from MULTICC_REPO_ROOT) and runs a tiny
// scripted "chat engine" on every virtual socket, so the test drives the real
// front door and the real Node codec against each other.
//
// Text commands from the client (anything else is echoed back unchanged, text
// as text and binary as binary):
//   info             reply with JSON describing the request and the socket
//   burst:N          send N numbered text frames, then `burst-done:<acks>:<peak>`
//   big:N            send one binary frame of N bytes (byte i = i % 251)
//   close:CODE:WHY   ws.close(CODE, WHY)
//   close-bare       ws.close() with no arguments
//   terminate        ws.terminate()
//   ping             ws.ping(); each pong comes back as the text `pong`
//   crash            SIGKILL this process
//   after-close:N    send N frames right after ws.close(1000), counting errors
//
// FIXTURE_STATE_DIR receives `ready` (after each bridge handshake), `runs`,
// and one JSON line per finished socket in closed.log.

const fs = require('node:fs');
const path = require('node:path');

process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

const stateDir = process.env.FIXTURE_STATE_DIR || process.cwd();
const mode = process.env.FIXTURE_MODE || 'bridge';
fs.mkdirSync(stateDir, { recursive: true });
const runsFile = path.join(stateDir, 'runs');
let run = 1;
try { run = Number(fs.readFileSync(runsFile, 'utf8')) + 1; } catch (_) { /* first run */ }
fs.writeFileSync(runsFile, String(run));

const { connectChatBridge } = require(path.join(process.env.MULTICC_REPO_ROOT, 'src/ws/gateway-chat-bridge.js'));
const port = Number(process.env.MULTICC_GATEWAY_CHAT_PORT);
const capability = process.env.MULTICC_GATEWAY_CHAT_CAPABILITY;

if (mode === 'no-bridge') {
  // Alive and healthy, but never dials the chat bridge.
  fs.writeFileSync(path.join(stateDir, 'ready'), String(run));
  setInterval(() => {}, 1 << 30);
  return;
}

let nextId = 0;

function engine(ws, req) {
  const id = nextId++;
  const finish = (event, extra = {}) => fs.appendFileSync(
    path.join(stateDir, 'closed.log'), `${JSON.stringify({ id, event, ...extra })}\n`,
  );
  ws.on('close', (code, reason) => finish('close', { code, reason: reason.toString() }));
  ws.on('pong', () => ws.send('pong'));
  ws.on('message', (data, isBinary) => {
    if (isBinary) { ws.send(data, { binary: true }); return; }
    const text = data.toString();
    if (text === 'info') {
      ws.send(JSON.stringify({
        url: req.url,
        method: req.method,
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        remoteAddress: req.socket.remoteAddress,
        remotePort: req.socket.remotePort,
        remoteFamily: req.socket.remoteFamily,
        localAddress: req.socket.localAddress,
        localPort: req.socket.localPort,
        readyState: ws.readyState,
        bufferedAmount: ws.bufferedAmount,
        protocol: ws.protocol,
      }));
    } else if (text.startsWith('burst:')) {
      const count = Number(text.slice(6));
      let acks = 0;
      let peak = 0;
      for (let i = 0; i < count; i++) {
        ws.send(`b${i}`, error => { if (!error) acks++; });
        peak = Math.max(peak, ws.bufferedAmount);
      }
      ws.send(JSON.stringify({ done: 'burst', count, peak: peak > 0 }), error => {
        if (error) return;
        // Every earlier send finished before this one, and in order.
        setTimeout(() => finish('burst', { acks, count }), 0);
      });
    } else if (text.startsWith('big:')) {
      const size = Number(text.slice(4));
      const body = Buffer.alloc(size);
      for (let i = 0; i < size; i++) body[i] = i % 251;
      ws.send(body, { binary: true }, error => finish('big-sent', { error: error ? error.message : null }));
    } else if (text.startsWith('close:')) {
      const [, code, ...why] = text.split(':');
      ws.close(Number(code), why.join(':'));
    } else if (text === 'close-bare') {
      ws.close();
    } else if (text === 'terminate') {
      ws.terminate();
    } else if (text === 'ping') {
      ws.ping();
    } else if (text === 'crash') {
      process.kill(process.pid, 'SIGKILL');
    } else if (text.startsWith('after-close:')) {
      const count = Number(text.slice(12));
      ws.close(1000, 'bye');
      let failures = 0;
      for (let i = 0; i < count; i++) ws.send(`late${i}`, error => { if (error) failures++; });
      setTimeout(() => finish('after-close', { failures, count }), 200);
    } else {
      ws.send(text);
    }
  });
}

const wss = { clients: new Set() };
connectChatBridge({
  port, capability, wss, onConnection: engine, logger: { error: () => {} }, onLost: () => process.exit(75),
}).then(() => {
  fs.writeFileSync(path.join(stateDir, 'ready'), String(run));
}, () => process.exit(1));
