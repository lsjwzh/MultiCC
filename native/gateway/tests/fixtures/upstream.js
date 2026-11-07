'use strict';

// Test upstream for native/gateway. It parses the PROXY v1 line itself (the
// real Node child is src/gateway-child.js, and these tests must not depend on
// it) and then hands the socket to an ordinary http.Server, exactly like the
// real child does.
//
// Modes (FIXTURE_MODE), all served over HTTP:
//   echo               full HTTP fixture (routes below); the default
//   no-listen          write `ready` and stay alive without listening (503 test)
//   exit-1-once        exit 1 on the first run, serve afterwards
//   exit-75-once       exit 75 on the first run (the 75 relaunch test)
//   exit-0-on-connect  exit 0 as soon as an internal connection arrives
//
// Routes:
//   GET  /proxy       JSON { id, line } — the PROXY line this connection sent
//   GET  /one /two    plain text
//   POST /echo        echo the request body back byte for byte
//   GET  /bulk-down   8 MiB of a deterministic pattern (i * 31 + 7, mod 256)
//   GET  /sse         chunked text/event-stream: first chunk, pause, second
//   GET  /headers     JSON of method/url/version/rawHeaders + X-Response-Case
//   GET  /close       `Connection: close` response
//   GET  /hangup      answer normally, then close the internal connection
//   GET  /upgrade     upgrade event: 101, then echo raw bytes
//
// FIXTURE_STATE_DIR receives runs/pids.log/ports.log/ready, one JSON line per
// accepted internal connection in connections.log, one per HTTP request in
// requests.log, and closed connection ids in closed.log.
// FIXTURE_SIGNAL_MARKER, when set, makes SIGINT write that file and exit 0.

const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Same contract as the real Node child (docs/gateway.md §3): EOF on stdin means
// the front door is gone, so never outlive it as an orphan.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

const mode = process.env.FIXTURE_MODE || 'echo';
const stateDir = process.env.FIXTURE_STATE_DIR || process.cwd();
fs.mkdirSync(stateDir, { recursive: true });

const runsFile = path.join(stateDir, 'runs');
let run = 1;
try { run = Number(fs.readFileSync(runsFile, 'utf8')) + 1; } catch (_) { /* first run */ }
fs.writeFileSync(runsFile, String(run));

const internalPort = Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT);
fs.appendFileSync(path.join(stateDir, 'ports.log'), `${internalPort}\n`);
fs.appendFileSync(path.join(stateDir, 'pids.log'), `${process.pid}\n`);

const signalMarker = process.env.FIXTURE_SIGNAL_MARKER;
if (signalMarker) {
  process.on('SIGINT', () => {
    fs.writeFileSync(signalMarker, 'SIGINT');
    process.exit(0);
  });
}

if (mode === 'no-listen') {
  fs.writeFileSync(path.join(stateDir, 'ready'), String(run));
  setInterval(() => {}, 1 << 30);
  return;
}
if (mode === 'exit-1-once' && run === 1) process.exit(1);
if (mode === 'exit-75-once' && run === 1) process.exit(75);

const connectionsLog = path.join(stateDir, 'connections.log');
const requestsLog = path.join(stateDir, 'requests.log');
const closedLog = path.join(stateDir, 'closed.log');

function bulkBlock() {
  const block = Buffer.alloc(65536);
  for (let i = 0; i < block.length; i++) block[i] = (i * 31 + 7) & 0xff;
  return block;
}

const server = http.createServer((req, res) => {
  const id = req.socket.__gatewayConnectionId;
  fs.appendFileSync(requestsLog, `${JSON.stringify({
    id,
    method: req.method,
    url: req.url,
    version: req.httpVersion,
    rawHeaders: req.rawHeaders,
  })}\n`);

  const route = req.url.split('?')[0];
  if (route === '/proxy') {
    const line = req.socket.__proxyLine || '';
    const body = JSON.stringify({ id, line });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  if (route === '/headers') {
    const body = JSON.stringify({
      method: req.method,
      url: req.url,
      version: req.httpVersion,
      rawHeaders: req.rawHeaders,
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Response-Case': 'kept',
    });
    res.end(body);
    return;
  }
  if (route === '/echo' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
      });
      res.end(body);
    });
    return;
  }
  if (route === '/bulk-down') {
    const size = 8 * 1024 * 1024;
    const block = bulkBlock();
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
    });
    let sent = 0;
    const pump = () => {
      while (sent < size) {
        const n = Math.min(block.length, size - sent);
        sent += n;
        const chunk = n === block.length ? block : block.subarray(0, n);
        if (!res.write(chunk)) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
    return;
  }
  if (route === '/sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: first\n\n');
    setTimeout(() => {
      res.write('data: second\n\n');
      res.end();
    }, 500);
    return;
  }
  if (route === '/close') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '2', Connection: 'close' });
    res.end('ok');
    return;
  }
  if (route === '/hangup') {
    // Answer normally, then close the *internal* connection. To the front
    // door this is exactly a keep-alive timeout: the client connection is
    // still open, the upstream one is gone.
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '2' });
    res.end('ok');
    setTimeout(() => req.socket.destroy(), 20);
    return;
  }
  const body = route === '/two' ? 'two' : route === '/one' ? 'one' : 'ok';
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(Buffer.byteLength(body)) });
  res.end(body);
});

server.on('upgrade', (req, socket) => {
  if (req.url.split('?')[0] !== '/upgrade') {
    socket.destroy();
    return;
  }
  socket.setNoDelay(true);
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n');
  socket.on('data', chunk => socket.write(chunk));
  socket.on('error', () => {});
});

let connectionSeq = 0;

const proxyListener = net.createServer({ pauseOnConnect: true }, socket => {
  if (mode === 'exit-0-on-connect') process.exit(0);
  socket.setNoDelay(true);
  socket.on('error', () => {});
  const id = ++connectionSeq;
  socket.__gatewayConnectionId = id;
  let buffered = Buffer.alloc(0);
  let settled = false;

  const onData = chunk => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    const end = buffered.indexOf('\r\n');
    if (end < 0) {
      if (buffered.length > 4096) socket.destroy();
      return;
    }
    const line = buffered.subarray(0, end).toString('latin1');
    settled = true;
    socket.removeListener('data', onData);
    socket.pause();
    socket.__proxyLine = line;
    fs.appendFileSync(connectionsLog, `${JSON.stringify({ id, line })}\n`);
    const rest = buffered.subarray(end + 2);
    if (rest.length) socket.unshift(rest);
    server.emit('connection', socket);
    socket.resume();
  };

  socket.on('data', onData);
  socket.on('close', () => {
    if (settled) fs.appendFileSync(closedLog, `${id}\n`);
  });
  socket.resume();
});

proxyListener.on('error', err => {
  process.exit(err.code === 'EADDRINUSE' ? 75 : 1);
});

proxyListener.listen(internalPort, '127.0.0.1', () => {
  fs.writeFileSync(path.join(stateDir, 'ready'), String(run));
});
