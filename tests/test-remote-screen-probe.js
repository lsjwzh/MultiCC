'use strict';

// scripts/remote-screen-probe.js against a fake Agent (real unix sockets) and a
// fake server whose WS hop goes through the REAL Node forwarding layer
// (src/remote-screen.js → a fake multicast-remote process that pipes to h264.sock).
// Each scenario breaks one hop and the probe must name exactly that hop — the
// point of the tool is telling "input lost" from "picture frozen" without a
// human in the loop.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const { WebSocketServer } = require('ws');
const rs = require('../src/remote-screen-rust');
const { installFakeRemote } = require('./helpers/remote-screen-node-harness');
const { runProbe, format } = require('../scripts/remote-screen-probe');

process.env.MULTICC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsp-data-'));

// 转发层连的是假上游进程：它把每条 WS 消息写进 Agent 的 h264.sock，反向字节按
// 二进制帧发回。这样 probe 仍然走 "真 server 的 WS → 真转发层 → Agent" 这条链。
function useForwarder(t, agentDir) {
  const fake = installFakeRemote({ FAKE_REMOTE_PIPE_SOCK: path.join(agentDir, 'h264.sock') });
  t.after(async () => { await rs._resetForTests(); fake.cleanup(); });
}

const W = 1470, H = 956;
const TIMING = { firstFrameMs: 1500, quietMs: 120, quietMaxMs: 1500, stepMs: 5, settleMs: 200, requestMs: 1500 };

function frame(type, payload) {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}
const sample = type => frame(type, Buffer.concat([Buffer.alloc(8), Buffer.from([0, 0, 0, 1, type === 2 ? 0x65 : 0x41, 1])]));

// moves: hover moves the cursor. reacts: input produces a frame. streams: key frames at all.
async function fakeAgent(t, { moves = true, reacts = true, streams = true, cursor = true, agent = true } = {}) {
  const dir = fs.mkdtempSync('/tmp/rsp-');
  const servers = [];
  t.after(() => { for (const s of servers) s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const state = { cursor: [300, 200], hovers: 0 };
  const listen = (name, onConn) => new Promise(resolve => {
    const server = net.createServer(onConn);
    servers.push(server);
    server.listen(`${dir}/${name}`, resolve);
  });
  if (agent) {
    await listen('agent.sock', sock => {
      let buf = '';
      sock.on('data', chunk => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const req = JSON.parse(buf.slice(0, nl));
        const reply = req.op === 'status'
          ? { ok: true, version: '3', accessibility: true, screenRecording: true, postEvents: true, screenLocked: false,
            control: { halted: false }, ...(cursor ? { cursor: state.cursor } : {}) }
          : { ok: true };
        sock.end(JSON.stringify(reply) + '\n');
      });
    });
  }
  await listen('h264.sock', sock => {
    sock.on('error', () => {});
    sock.write(frame(1, Buffer.from(JSON.stringify({ codec: 'avc1.640028', width: W, height: H }))));
    if (streams) sock.write(sample(2));
    let buf = Buffer.alloc(0);
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length) {
        const need = buf[0] === 5 ? 6 : buf[0] === 4 ? 8 : 1;
        if (buf.length < need) break;
        const msg = buf.subarray(0, need);
        buf = buf.subarray(need);
        if (msg[0] === 0x4b && streams) sock.write(sample(2));
        if (msg[0] !== 5) continue;
        state.hovers += 1;
        if (moves) state.cursor = [msg.readUInt16BE(2), msg.readUInt16BE(4)];
        if (reacts && streams) sock.write(sample(3));
      }
    });
  });
  return { dir, state };
}

async function fakeServer(t, { pointerOp = true } = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/remote-screen/capabilities') return res.end(JSON.stringify({ streams: { h264: true } }));
      if (req.url === '/api/auth/ws-ticket') return res.end(JSON.stringify({ ticket: 'tkt', path: '/ws/remote-screen' }));
      if (req.url === '/api/remote-screen/input') {
        const op = JSON.parse(body).op;
        const error = op === 'pointer' && !pointerOp ? 'op not allowed: pointer' : 'viewer is required';
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('ticket') !== 'tkt') return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => rs.attachH264(ws, req));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const c of wss.clients) c.terminate(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

const byId = report => Object.fromEntries(report.segments.map(s => [s.id, s]));

test('healthy pipeline: every hop passes and the cursor is put back', async t => {
  const { dir, state } = await fakeAgent(t);
  useForwarder(t, dir);
  const report = await runProbe({ agentDir: dir, baseUrl: await fakeServer(t), timing: TIMING });
  const s = byId(report);
  assert.equal(report.ok, true, format(report));
  for (const id of ['agent', 'capture', 'input', 'server', 'relay', 'relay-input', 'http-input']) assert.equal(s[id].status, 'ok', `${id}: ${s[id].detail}`);
  // 收尾那次「把光标放回去」是探针发完就返回的，要经 multicc-remote 才落到假 Agent；
  // 多一跳后不能同步断言，给它最多 2s。
  const deadline = Date.now() + 2000;
  while (state.cursor[0] !== 300 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(state.cursor, [300, 200], 'the probe restores the cursor');
  assert.ok(state.hovers >= 10, 'both direct and relayed input were exercised');
});

test('input lost at the Agent: the first failing hop is input, not the picture', async t => {
  const { dir } = await fakeAgent(t, { moves: false, reacts: false });
  useForwarder(t, dir);
  const report = await runProbe({ agentDir: dir, baseUrl: await fakeServer(t), timing: TIMING });
  assert.equal(report.firstFailure, 'input', format(report));
  assert.match(byId(report).input.hint, /no event was posted/);
  assert.equal(byId(report).capture.status, 'ok');
});

test('capture stalled: input lands but no frames — reported as a frozen picture', async t => {
  const { dir } = await fakeAgent(t, { reacts: false });
  useForwarder(t, dir);
  const report = await runProbe({ agentDir: dir, baseUrl: await fakeServer(t), timing: TIMING });
  assert.equal(report.firstFailure, 'input', format(report));
  assert.match(byId(report).input.hint, /picture does not update/);
});

test('older Agent without a cursor report: the picture reaction still proves input', async t => {
  const { dir, state } = await fakeAgent(t, { cursor: false });
  useForwarder(t, dir);
  const report = await runProbe({ agentDir: dir, baseUrl: await fakeServer(t), timing: TIMING });
  assert.equal(report.ok, true, format(report));
  assert.match(byId(report).input.detail, /does not report the cursor/);
  assert.ok(Math.abs(state.cursor[0] - W / 2) < 60, 'hovers around the screen centre');
});

test('running server predates the pointer op: a warning, not a failure', async t => {
  const { dir } = await fakeAgent(t);
  useForwarder(t, dir);
  const report = await runProbe({ agentDir: dir, baseUrl: await fakeServer(t, { pointerOp: false }), timing: TIMING });
  assert.equal(report.ok, true, format(report));
  assert.equal(byId(report)['http-input'].status, 'warn');
  assert.match(byId(report)['http-input'].hint, /restart the server/);
});

test('Agent down: agent fails first and the hops that depend on it are skipped', async t => {
  const { dir } = await fakeAgent(t, { agent: false });
  useForwarder(t, dir);
  const report = await runProbe({ agentDir: dir, baseUrl: await fakeServer(t), timing: TIMING, move: true });
  const s = byId(report);
  assert.equal(report.firstFailure, 'agent', format(report));
  assert.equal(s.capture.status, 'skip');
  assert.equal(s.input.status, 'skip');
  assert.equal(s['relay-input'].status, 'skip');
});
