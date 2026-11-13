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

// Protocol-only fixture: production uses the Rust addon actor. No authority
// decisions here; native gateway tests can explicitly rotate this live value.
const crypto = require('node:crypto');
let fixtureToken = process.env.ACCESS_TOKEN || '';
if (!fixtureToken) {
  try { fixtureToken = /^ACCESS_TOKEN=(.*)$/m.exec(fs.readFileSync('.env', 'utf8'))?.[1] || ''; } catch {}
}
let revision = 0;
let fixtureShutdown = false;
// Set once the scripted Node child has been asked to refresh the Codex catalog;
// the next codex-state answer can then report the post-refresh snapshot.
let refreshed = false;
const controlPort = Number(process.env.MULTICC_GATEWAY_AUTH_PORT);
const capability = process.env.MULTICC_GATEWAY_AUTH_CAPABILITY;
delete process.env.MULTICC_GATEWAY_AUTH_PORT;
delete process.env.MULTICC_GATEWAY_AUTH_CAPABILITY;
const sign = text => crypto.createHmac('sha256', capability).update(text).digest('base64url');
function controlConnect() {
  const socket = net.connect(controlPort, '127.0.0.1');
  let phase = 0, nonce, buffered = Buffer.alloc(0);
  const send = value => {
    const body = Buffer.from(JSON.stringify(value));
    const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
    socket.write(Buffer.concat([size, body]));
  };
  socket.on('error', () => {});
  socket.on('close', () => setTimeout(controlConnect, 50).unref());
  socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const size = buffered.readUInt32BE();
      if (!size || size > 65536) return socket.destroy();
      if (buffered.length < size + 4) return;
      const value = JSON.parse(buffered.subarray(4, size + 4));
      buffered = buffered.subarray(size + 4);
      if (phase === 0) { nonce = value; send(sign(`child:${nonce}`)); phase = 1; }
      else if (phase === 1) { if (value !== sign(`parent:${nonce}`)) return socket.destroy(); phase = 2; }
      else if (value.op === 'snapshot') send({ kind: 'snapshot', secret: fixtureToken, shutting_down: fixtureShutdown, revision });
      else send({ kind: 'invalid' });
    }
  });
}
controlConnect();

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
  if (route === '/fixture/rotate') {
    const chunks = []; req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { fixtureToken = Buffer.concat(chunks).toString(); revision++; res.end('ok'); });
    return;
  }
  if (route === '/fixture/shutdown') { fixtureShutdown = true; res.end('ok'); return; }
  if (route === '/proxy') {
    const line = req.socket.__proxyLine || '';
    const body = JSON.stringify({ id, line });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  if (route === '/env') {
    // What the child inherited: a .env-only key must be absent here (Node
    // reads .env itself), PORT is the front door's public port.
    const body = JSON.stringify({
      FIXTURE_DOTENV_ONLY: process.env.FIXTURE_DOTENV_ONLY ?? null,
      PORT: process.env.PORT ?? null,
    });
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
  // Host port for the file browser: the test script maps `fileTransfer` keys
  // (`<op>:<session>`, then `<op>`) to the answer the shim would have built.
  if (route === '/api/__host/file-transfer' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      fs.appendFileSync(path.join(stateDir, 'file-transfer-calls.jsonl'), `${JSON.stringify(input)}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      if (script.hostDown === true) { req.socket.destroy(); return; }
      const answers = script.fileTransfer || {};
      const key = `${input.op}:${input.session || ''}`;
      const out = Object.prototype.hasOwnProperty.call(answers, key)
        ? answers[key]
        : (answers[input.op] || { ok: false });
      const text = JSON.stringify(out);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    });
    return;
  }
  // Host port for routes that need in-process Node state (docs/gateway.md §10).
  // FIXTURE_HOST_SCRIPT names a JSON file the test writes: subagent defaults,
  // the session projection, provider facts and per-session patch outcomes.
  if (route === '/api/__host/subagent-defaults' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      fs.appendFileSync(path.join(stateDir, 'host-calls.jsonl'), `${JSON.stringify(input)}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      if (script.hostDown === true) { req.socket.destroy(); return; }
      let out;
      if (input.op === 'state') {
        out = { subagent: script.subagent === undefined ? null : script.subagent, sessions: script.sessions || [] };
      } else if (input.op === 'facts') {
        out = (script.facts && script.facts[input.providerId]) || { valid: false, proxyable: false, official: false };
      } else if (input.op === 'persist') {
        if (script.persistFail === true) out = { ok: false };
        else {
          fs.writeFileSync(path.join(stateDir, 'persisted.json'), JSON.stringify(input.defaults));
          out = { ok: true };
        }
      } else if (input.op === 'patch') {
        const p = (script.patches && script.patches[input.sessionId]) || {};
        if (p.compat === true) out = { ok: true, compat: true };
        else if (p.threw === true) out = { ok: true, status: 500, detail: 'session patch rejected' };
        else if (typeof p.status === 'number' && p.status !== 200) out = { ok: true, status: p.status, detail: p.detail || 'session patch rejected' };
        else out = { ok: true, status: 200, deferred: p.deferred === true };
        fs.appendFileSync(path.join(stateDir, 'patches.jsonl'), `${JSON.stringify({ sessionId: input.sessionId, subagent: input.subagent, dryRun: input.dryRun })}\n`);
      } else {
        out = { ok: false };
      }
      const text = JSON.stringify(out);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    });
    return;
  }
  // Rust balance/relay routes: script the host facts, never a public Node route.
  if ((route === '/api/__host/provider-balance' || route === '/api/__host/provider-relay') && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const balance = route.endsWith('provider-balance');
      fs.appendFileSync(path.join(stateDir, balance ? 'balance-calls.jsonl' : 'relay-calls.jsonl'), `${JSON.stringify(input)}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      const config = (balance ? script.providerBalance : script.providerRelay) || {};
      if (script.hostDown || config.hostDown) { req.socket.destroy(); return; }
      const answers = config.answers || {};
      const key = `${input.op}:${input.id || ''}`;
      const value = Object.prototype.hasOwnProperty.call(answers, key) ? answers[key]
        : Object.prototype.hasOwnProperty.call(answers, input.op) ? answers[input.op]
          : input.op === 'admission' ? { allowed: true, headers: {} } : { ok: true };
      const text = JSON.stringify(value);
      const send = () => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (config.delayMs) setTimeout(send, config.delayMs); else send();
    });
    return;
  }
  // Host port for the model catalog routes (docs/gateway.md §32). The script
  // file describes each Node-side answer: CLI catalogs, the live provider
  // fetch and the official Codex catalog runtime.
  if (route === '/api/__host/model-catalogs' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      fs.appendFileSync(path.join(stateDir, 'model-calls.jsonl'), `${JSON.stringify(input)}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      if (script.hostDown === true) { req.socket.destroy(); return; }
      const catalogs = script.catalogs || {};
      const codex = script.codex || {};
      const send = value => {
        const text = JSON.stringify(value);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (Object.prototype.hasOwnProperty.call(catalogs, input.op)) {
        return send(catalogs[input.op]);
      }
      if (input.op === 'provider') {
        const entry = (script.providers && script.providers[input.providerId]) || script.provider;
        return send(entry || { status: 200, body: { models: [], source: 'fallback' } });
      }
      if (input.op === 'codex-state') {
        if (codex.stateError === true) return send({ error: true });
        const states = codex.states || {};
        const state = states[input.providerId];
        if (!state) return send({ found: false });
        if (refreshed && codex.peekAfterRefresh) return send({ ...state, peek: codex.peekAfterRefresh });
        return send(state);
      }
      if (input.op === 'codex-refresh') {
        if (codex.refreshError === true) return send({ error: true });
        const finish = () => {
          refreshed = true;
          fs.appendFileSync(path.join(stateDir, 'model-refresh.jsonl'), `${JSON.stringify(input)}\n`);
          send({ ok: true });
        };
        if (input.wait === true && codex.refreshDelayMs) return setTimeout(finish, codex.refreshDelayMs);
        return finish();
      }
      send({ error: true });
    });
    return;
  }
  // Host port for the agent resource routes (docs/gateway.md §33). The script
  // file carries the installed skills, the preset payloads and the Claude
  // history rows the Rust side turns into responses.
  if (route === '/api/__host/agent-resources' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      fs.appendFileSync(path.join(stateDir, 'agent-calls.jsonl'), `${JSON.stringify(input)}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      if (script.hostDown === true) { req.socket.destroy(); return; }
      const agent = script.agent || {};
      const send = value => {
        const text = JSON.stringify(value);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (input.op === 'skills') {
        if (agent.skillsDown === true) return send({ ok: false });
        return send({ ok: true, skills: agent.skills || [] });
      }
      if (input.op === 'presets') {
        if (agent.presetsDown === true) return send({ ok: false });
        // Verbatim: the script object carries `ok` itself, like `catalogs`.
        return send(agent.data || {});
      }
      if (input.op === 'preset') {
        if (agent.presetsDown === true) return send({ ok: false });
        const presets = agent.presets || {};
        if (Object.prototype.hasOwnProperty.call(presets, input.id)) {
          return send({ ok: true, found: true, preset: presets[input.id] });
        }
        return send({ ok: true, found: false });
      }
      if (input.op === 'claude-sessions') {
        if (agent.sessionsDown === true) return send({ ok: false });
        return send({ ok: true, sessions: agent.sessions || [] });
      }
      if (input.op === 'claude-session-delete') {
        const remove = agent.remove || {};
        const key = `${input.project}/${input.id}`;
        return send(Object.prototype.hasOwnProperty.call(remove, key)
          ? remove[key]
          : { ok: false, error: 'not found' });
      }
      send({ ok: false });
    });
    return;
  }
  // Host port for the secrets vault routes. The script file carries the
  // metadata rows the list route re-emits and the scripted outcome of each
  // write, so the Rust side can be driven through 201/200/404/409/503.
  if (route === '/api/__host/secrets-vault' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      fs.appendFileSync(path.join(stateDir, 'secret-calls.jsonl'), `${JSON.stringify(input)}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      if (script.hostDown === true) { req.socket.destroy(); return; }
      const secret = script.secret || {};
      const send = value => {
        const text = JSON.stringify(value);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (secret.down === true) return send({ ok: false });
      if (input.op === 'list') {
        return send({ ok: true, entries: secret.entries || [] });
      }
      if (input.op === 'upsert') {
        if (secret.upsert && typeof secret.upsert === 'object') return send(secret.upsert);
        return send({
          ok: true,
          entry: { name: input.name, description: '', source: 'user', createdAt: null, updatedAt: null },
          created: true,
        });
      }
      if (input.op === 'rename') {
        if (secret.rename && typeof secret.rename === 'object') return send(secret.rename);
        return send({
          ok: true,
          entry: { name: input.to, description: '', source: 'user', createdAt: null, updatedAt: null },
        });
      }
      if (input.op === 'remove') {
        return send(secret.remove || { ok: true });
      }
      if (input.op === 'reveal') {
        return send(secret.reveal || { ok: false, reason: 'missing' });
      }
      send({ ok: false });
    });
    return;
  }
  // Host port for the token-usage role snapshot and the persisted ledger
  // (src/routes/token-usage-host.js). The script file carries the per-session
  // snapshots and the ledger object; every call is appended so the tests can
  // assert the exact op and session the front door sent.
  if (route === '/api/__host/token-usage' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      fs.appendFileSync(path.join(stateDir, 'token-usage-calls.jsonl'), `${JSON.stringify(input)}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      if (script.hostDown === true) { req.socket.destroy(); return; }
      const usage = script.tokenUsage || {};
      const send = value => {
        const text = JSON.stringify(value);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (usage.down === true) return send({ ok: false });
      if (input.op === 'snapshot') {
        return send({ ok: true, payload: (usage.snapshots && usage.snapshots[input.session]) || { main: null, sub: null, subByProvider: [] } });
      }
      if (input.op === 'ledger') {
        return send({ ok: true, payload: usage.ledger || {} });
      }
      send({ ok: false });
    });
    return;
  }
  // Host port for the read-only host routes retired from
  // src/routes/host-read.js (native/gateway/src/app/host_read.rs). The script
  // file carries one answer per op under `hostRead.answers`, so the Rust side
  // can be driven through every response shape, including the failure answer
  // `{ ok: false, status, code, safeMessage, detail }`. Every call is appended
  // so the tests can assert the exact payload (and `canEdit`) the front door
  // sent.
  if (route === '/api/__host/host-read' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      fs.appendFileSync(path.join(stateDir, 'host-read-calls.jsonl'), `${JSON.stringify(input)}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      if (script.hostDown === true) { req.socket.destroy(); return; }
      const hostRead = script.hostRead || {};
      const answers = hostRead.answers || {};
      const send = value => {
        const text = JSON.stringify(value);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (Object.prototype.hasOwnProperty.call(answers, input.op)) {
        return send(answers[input.op]);
      }
      send({ ok: false });
    });
    return;
  }
  // Host port for the terminal turn-ledger diagnostics
  // (src/routes/turn-ledger-host.js, native/gateway/src/app/turn_ledger.rs).
  // The script carries the launch table, the raw ledger records and the two
  // trust answers; every call is appended so the tests can assert the exact
  // op and session the front door sent, and that a refusal never reached the
  // trust op.
  if (route === '/api/__host/turn-ledger' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      fs.appendFileSync(path.join(stateDir, 'turn-ledger-calls.jsonl'), `${JSON.stringify(input)}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      if (script.hostDown === true) { req.socket.destroy(); return; }
      const tl = script.turnLedger || {};
      const launches = tl.launches || {};
      const records = tl.records || {};
      const send = value => {
        const text = JSON.stringify(value);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (input.op === 'ledger') {
        return send({
          ok: true,
          launch: launches[input.sessionId] || null,
          record: Object.prototype.hasOwnProperty.call(records, input.sessionId) ? records[input.sessionId] : null,
        });
      }
      if (input.op === 'launch') {
        return send({ ok: true, launch: launches[input.sessionId] || null });
      }
      if (input.op === 'trust') {
        const answer = input.write === true ? (tl.grant || { ok: false }) : (tl.trust || { ok: false });
        return send(answer);
      }
      send({ ok: false });
    });
    return;
  }
  // Host port for the system routes retired from src/routes/system.js
  // (src/routes/system-host.js, native/gateway/src/app/system.rs). The script
  // carries the process facts under `system.serverInfo`, the ls-remote answer
  // under `system.lsRemote` and the raw trace ring (oldest first) under
  // `system.traceEntries`. The trace branch repeats the host route's own
  // defensive cap and the proxy-trace snapshot semantics (slice(-n), reverse,
  // startedAt stripped) so the front door sees exactly what the real host
  // would have sent.
  if (route === '/api/__host/system' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      fs.appendFileSync(path.join(stateDir, 'system-calls.jsonl'), `${JSON.stringify(input)}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      if (script.hostDown === true) { req.socket.destroy(); return; }
      const sys = script.system || {};
      const send = value => {
        const text = JSON.stringify(value);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (input.op === 'server-info') {
        return send(sys.serverInfo || {});
      }
      if (input.op === 'ls-remote') {
        return send(sys.lsRemote || { ok: false });
      }
      if (input.op === 'trace') {
        const limit = Number.isSafeInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 200) : 100;
        const ring = Array.isArray(sys.traceEntries) ? sys.traceEntries : [];
        return send({ entries: ring.slice(-limit).reverse().map(({ startedAt, ...rest }) => rest) });
      }
      const text = JSON.stringify({ error: 'unknown host operation' });
      res.writeHead(400, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    });
    return;
  }
  // Host port for the scan history route retired from src/routes/scan.js
  // (src/routes/scan-history-host.js, native/gateway/src/app/scan.rs). The
  // script carries `scan.seq`, `scan.passes` and `scan.maxPasses`; the
  // Math.min cap and the slice — including its negative-argument semantics —
  // stay in JS verbatim, exactly like the real host route.
  if (route === '/api/__host/scan-history' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      fs.appendFileSync(path.join(stateDir, 'scan-calls.jsonl'), `${JSON.stringify(input)}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      if (script.hostDown === true) { req.socket.destroy(); return; }
      const scan = script.scan || {};
      const passes = Array.isArray(scan.passes) ? scan.passes : [];
      const maxPasses = Number.isInteger(scan.maxPasses) && scan.maxPasses > 0 ? scan.maxPasses : 100;
      const requested = typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 20;
      const limit = Math.min(requested, maxPasses);
      const text = JSON.stringify({ seq: scan.seq || 0, kept: passes.length, passes: passes.slice(0, limit) });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    });
    return;
  }
  // Host port for the voice-gateway routes retired from
  // src/routes/voice-gateway.js (src/routes/voice-gateway-host.js,
  // native/gateway/src/app/voice_gateway.rs). `voiceGateway.answers` maps
  // `<op>` (or `<op>:<id>`) to the value the real host would have answered, so
  // a test can script every success, failure and thrown shape; the defaults
  // below are one healthy hop. `voiceGateway.launch`, `gateways`, `gateway`,
  // `created`, `id` and `directoryId` fill the unscripted answers.
  if (route === '/api/__host/voice-gateway' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      fs.appendFileSync(path.join(stateDir, 'voice-gateway-calls.jsonl'), `${JSON.stringify(input)}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      const vg = script.voiceGateway || {};
      if (script.hostDown === true || vg.hostDown === true) { req.socket.destroy(); return; }
      const send = value => {
        const text = JSON.stringify(value);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      const launch = vg.launch === undefined ? null : vg.launch;
      const answers = vg.answers || {};
      const key = `${input.op}:${input.id || ''}`;
      if (Object.prototype.hasOwnProperty.call(answers, key)) return send(answers[key]);
      if (Object.prototype.hasOwnProperty.call(answers, input.op)) return send(answers[input.op]);
      if (input.op === 'list') return send({ gateways: vg.gateways || [], launch });
      if (input.op === 'inspect') return send({ ok: true, gateway: vg.gateway || null, launch });
      if (input.op === 'ensure') {
        return send({ ok: true, created: vg.created !== false, gateway: vg.gateway || null, launch });
      }
      if (input.op === 'remove') {
        return send({
          ok: true,
          id: vg.id === undefined ? input.id : vg.id,
          directoryId: vg.directoryId === undefined ? input.id : vg.directoryId,
        });
      }
      send({ ok: false, code: 'unknown_op' });
    });
    return;
  }
  // Host port for the global voice runtime routes retired from
  // src/routes/voice-gateway-global.js and src/routes/qwen-audio-runtime.js
  // (src/routes/voice-runtime-host.js, native/gateway/src/app/voice_runtime.rs).
  // `voiceRuntime.answers` maps `<op>` (or `<op>:<id|launchId>`) to the value
  // the real host would have answered, so a test can script every success,
  // failure and thrown shape. The fields below fill the unscripted answers;
  // every call is appended so the tests can assert the exact host payload and
  // the launch call sequence.
  if (route === '/api/__host/voice-runtime' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      fs.appendFileSync(path.join(stateDir, 'voice-runtime-calls.jsonl'), `${JSON.stringify(input)}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      const vr = script.voiceRuntime || {};
      if (script.hostDown === true || vr.hostDown === true) { req.socket.destroy(); return; }
      const send = value => {
        const text = JSON.stringify(value);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      const answers = vr.answers || {};
      const key = `${input.op}:${input.id || input.launchId || ''}`;
      if (Object.prototype.hasOwnProperty.call(answers, key)) return send(answers[key]);
      if (Object.prototype.hasOwnProperty.call(answers, input.op)) return send(answers[input.op]);
      const status = vr.status === undefined
        ? { scope: 'global', state: 'stopped', desired: false, url: null }
        : vr.status;
      const gateway = vr.gateway === undefined
        ? { configured: true, enabled: true, provider: 'qwen-audio-agent' }
        : vr.gateway;
      const runtime = vr.runtime === undefined ? { installed: true, state: 'ready' } : vr.runtime;
      switch (input.op) {
        case 'globalGet':
          return send({
            gateway,
            legacy: vr.legacy === undefined ? [{ id: 'legacy-1' }] : vr.legacy,
            baseUrl: vr.baseUrl === undefined ? 'http://127.0.0.1:3000' : vr.baseUrl,
          });
        case 'globalPut':
          return send({ ok: true, created: vr.created !== false, gateway });
        case 'globalRemove':
          return send({ ok: true });
        case 'globalRuntime':
        case 'globalRestart':
          return send({ status });
        case 'launchBegin':
          return send(vr.launchBegin || {
            ok: true,
            launch: {
              id: 'launch-1',
              scope: 'global',
              expiresAt: '2026-01-01T00:01:00.000Z',
              display: { label: 'main' },
            },
            targetSessionId: 'sess-target',
            status,
          });
        case 'launchEnd':
          return send({ ok: true });
        case 'launchResolve':
          return send({ ok: true, context: vr.context === undefined ? { targetSessionId: 'sess-target' } : vr.context });
        case 'runtimeGet':
          return send({ runtime });
        case 'runtimeInstall':
          return send({ installed: vr.installed !== false, runtime });
        case 'fleetRuntime':
        case 'fleetRestart':
          return send({ projectsGlobal: vr.projectsGlobal === true, status });
        default:
          return send({ ok: false, code: 'unknown_op' });
      }
    });
    return;
  }
  // Host port for the voice REST routes retired from src/routes/voice.js
  // (src/routes/voice-host.js, native/gateway/src/app/voice_routes.rs).
  // `voice.answers` maps `<op>` (or `<op>:<aux type|target|term>`) to the value
  // the real host would have answered, so a test can script every success,
  // failure and thrown shape; the defaults below are one healthy hop. Every
  // call is appended so the tests can assert the exact host payload.
  if (route === '/api/__host/voice' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      fs.appendFileSync(path.join(stateDir, 'voice-calls.jsonl'), `${JSON.stringify(input)}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      const voice = script.voice || {};
      if (script.hostDown === true || voice.hostDown === true) { req.socket.destroy(); return; }
      const send = value => {
        const text = JSON.stringify(value);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      const answers = voice.answers || {};
      const key = `${input.op}:${input.type || input.target || input.term || ''}`;
      if (Object.prototype.hasOwnProperty.call(answers, key)) return send(answers[key]);
      if (Object.prototype.hasOwnProperty.call(answers, input.op)) return send(answers[input.op]);
      switch (input.op) {
        case 'examples':
          return send({ ok: true, examples: voice.examples || [] });
        case 'auxEnqueue':
          return send({ ok: true, text: voice.text === undefined ? '' : voice.text });
        case 'feedbackApply':
          return send({ ok: true });
        case 'vocabGet':
          return send({ ok: true, vocab: voice.vocab || [] });
        case 'vocabDelete':
          return send({ ok: true, remaining: voice.remaining === undefined ? 0 : voice.remaining });
        case 'hotwords':
          return send({
            ok: true,
            present: voice.present === true,
            enabled: voice.enabled === true,
            snapshot: voice.present === true
              ? (voice.snapshot === undefined ? {} : voice.snapshot)
              : null,
          });
        case 'hotwordsReject':
          return send({
            ok: true,
            present: voice.present !== false,
            accepted: voice.accepted !== false,
          });
        case 'readinessFacts':
          return send({
            ok: true,
            localAvailable: voice.localAvailable === true,
            download: voice.download === undefined ? null : voice.download,
            cloudKeys: voice.cloudKeys || { whisper: false, openrouter: false },
            streaming: voice.streaming === undefined ? null : voice.streaming,
          });
        case 'settingsFacts':
          return send({
            ok: true,
            env: voice.env || {},
            runtime: voice.runtime || {},
            asrStatus: voice.asrStatus === undefined ? { local: { available: false } } : voice.asrStatus,
            ttsStatus: voice.ttsStatus === undefined ? { provider: 'edge' } : voice.ttsStatus,
            qwenRuntime: voice.qwenRuntime === undefined ? null : voice.qwenRuntime,
          });
        case 'settingsApply':
          return send({ ok: true });
        case 'asrModelCancel':
          return send({
            ok: true,
            cancelled: voice.cancelled === true,
            status: voice.status === undefined ? { state: 'idle' } : voice.status,
          });
        case 'asrModelStart':
          return send({
            ok: true,
            status: voice.status === undefined ? { state: 'downloading' } : voice.status,
          });
        default:
          return send({ ok: false, error: { message: 'unknown host operation' } });
      }
    });
    return;
  }
  // Host port for the provider routes retired from src/routes/providers.js
  // (src/routes/providers-host.js, native/gateway/src/app/providers.rs). The
  // script's `providers.answers` maps `<op>` (or `<op>:<id>`) to the value the
  // real host would have answered; the fixture does not implement any of the
  // rules, only the wire.
  if (route === '/api/__host/providers' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      fs.appendFileSync(path.join(stateDir, 'provider-calls.jsonl'), `${JSON.stringify(input)}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      const providers = script.providers || {};
      if (script.hostDown === true || providers.hostDown === true) { req.socket.destroy(); return; }
      const send = (status, value) => {
        const text = JSON.stringify(value);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      const answers = providers.answers || {};
      const keys = [
        `${input.op}:${input.id || ''}`,
        `${input.op}:${input.cli || ''}`,
        `${input.op}:${input.targetProviderId || ''}`,
        input.op,
      ];
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(answers, key)) return send(200, answers[key]);
      }
      if (input.op === 'defaultsValidate') return send(200, { ok: true, valid: true, value: input.id });
      if (input.op === 'defaultsPersist') return send(200, { ok: true, defaults: input.next });
      return send(400, { error: 'unknown host operation' });
    });
    return;
  }
  // The retired speed test measured a loopback proxy hop. The front door now
  // writes the same request to this internal listener; the script's
  // `speedtest` object picks the answer and every call is logged.
  const speedRoute = /^\/(?:claude|codex)-proxy\/[^/]+\/(?:responses|speedtest\/v1\/messages)$/.test(route);
  if (speedRoute && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      fs.appendFileSync(path.join(stateDir, 'speedtest-calls.jsonl'), `${JSON.stringify({
        method: req.method, url: req.url, headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      const answer = script.speedtest || {};
      const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body || {});
      const send = () => {
        res.writeHead(answer.status || 200, {
          'Content-Type': answer.contentType || 'application/json',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
      };
      if (answer.delayMs) setTimeout(send, answer.delayMs);
      else send();
    });
    return;
  }

  // Fake Jev gateway for the routing test (MULTICC_ROUTING_TEST_URL). The
  // script's `jev` object is the whole answer.
  if (route === '/jev' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      fs.appendFileSync(path.join(stateDir, 'jev-calls.jsonl'), `${JSON.stringify({
        method: req.method, url: req.url, headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })}\n`);
      let script = {};
      try { script = JSON.parse(fs.readFileSync(process.env.FIXTURE_HOST_SCRIPT, 'utf8')); } catch (_) {}
      const answer = script.jev || {};
      const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body || {});
      res.writeHead(answer.status || 200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    });
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
