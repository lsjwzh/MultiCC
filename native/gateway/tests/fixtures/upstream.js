'use strict';

// Test upstream for native/gateway. It parses the PROXY v1 line itself (the
// real Node child is another agent's work, so these tests must not depend on
// it) and then behaves according to FIXTURE_MODE:
//
//   echo                echo every byte after the PROXY line
//   report-header       write the parsed PROXY line, then close
//   report-header-echo  write the parsed PROXY line, then echo the rest
//   upgrade             wait for a full request, answer 101, then echo raw bytes
//   no-listen           write `ready` and stay alive without listening (503 test)
//   exit-1-once         exit 1 on the first run, echo afterwards
//   exit-75-once        exit 75 on the first run (after recording the port)
//   exit-0-on-connect   echo nothing; exit 0 as soon as a client connects
//
// FIXTURE_STATE_DIR receives runs/ports.log/ready; FIXTURE_SIGNAL_MARKER, when
// set, makes SIGINT write that file and exit 0 (proves signal forwarding).

const net = require('node:net');
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

const server = net.createServer(socket => {
  if (mode === 'exit-0-on-connect') process.exit(0);
  socket.setNoDelay(true);
  let pending = Buffer.alloc(0);
  let parsed = false;
  let body = Buffer.alloc(0);
  let upgraded = false;

  const flushBody = () => {
    if (!body.length) return;
    if (mode === 'upgrade' && !upgraded) {
      const end = body.indexOf('\r\n\r\n');
      if (end < 0) return;
      const extra = body.subarray(end + 4);
      upgraded = true;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n');
      body = Buffer.alloc(0);
      if (extra.length) socket.write(extra);
      return;
    }
    const chunk = body;
    body = Buffer.alloc(0);
    if (!socket.destroyed) socket.write(chunk);
  };

  socket.on('data', chunk => {
    if (parsed) {
      body = Buffer.concat([body, chunk]);
      flushBody();
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    const at = pending.indexOf('\r\n');
    if (at < 0) return;
    const line = pending.subarray(0, at).toString('latin1');
    const rest = pending.subarray(at + 2);
    parsed = true;
    pending = Buffer.alloc(0);
    if (mode === 'report-header') {
      socket.write(`${line}\n`);
      socket.end();
      return;
    }
    if (mode === 'report-header-echo') socket.write(`${line}\n`);
    body = Buffer.concat([body, rest]);
    flushBody();
  });
  socket.on('end', () => { if (!socket.destroyed) socket.end(); });
  socket.on('error', () => {});
});

server.listen(internalPort, '127.0.0.1', () => {
  fs.writeFileSync(path.join(stateDir, 'ready'), String(run));
});
