'use strict';

// 假的上游进程：实现 docs/remote-screen-process.md 里 multicc-remote 的那一层。
//
// src/remote-screen.js 现在只负责「启动看护 + 鉴权后转发」，所以它的测试不再需要
// 真的截图 / 编码 / Agent socket；这个脚本按进程协议起一个 HTTP + WS 服务，
// 用 MULTICC_REMOTE_BIN 指过去即可。测试通过 FAKE_REMOTE_EVENTS_FILE 读回它
// 实际收到的请求与消息，事件逐行追加 JSON（进程崩溃也不丢）。
//
// 环境开关（都只给测试用）：
//   FAKE_REMOTE_EVENTS_FILE    事件记录文件
//   FAKE_REMOTE_PID_FILE       启动后写入自己的 pid（验证 stdin EOF 收尾）
//   FAKE_REMOTE_NO_READY=1     不打印就绪行（测就绪超时）
//   FAKE_REMOTE_READY_DELAY_MS 推迟打印就绪行
//   FAKE_REMOTE_EXIT_AFTER_MS  就绪后若干毫秒退出（模拟崩溃 / 退避重启）
//   FAKE_REMOTE_WS_DELAY_MS    推迟 WS 握手完成（测上游未就绪时的排队）
//   FAKE_REMOTE_PIPE_SOCK      收到 WS 消息就写进这个 unix socket，反向数据按二进制
//                              帧发回（给 probe / CDP 测试当 Agent 字节管道）

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');

const { WebSocketServer } = require('ws');

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.from(Array.from({ length: 256 }, (_, i) => i & 0xff)),
  Buffer.from([0xff, 0xd9]),
]);

const CAPABILITIES = {
  ok: true, platform: 'darwin', label: 'macOS', supported: true, transport: 'unix',
  modifier: 'cmd', reason: null, installHint: null,
  features: { view: true, control: true, snapshot: true, annotate: true,
    stream: true, wake: true, unlock: true, elementTree: true },
  streams: { h264: true, rfb: true },
};

function event(record) {
  const file = process.env.FAKE_REMOTE_EVENTS_FILE;
  if (!file) return;
  try { fs.appendFileSync(file, JSON.stringify(record) + '\n'); } catch {}
}

function json(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(payload.length), ...extraHeaders });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function start() {
  let config = null;
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (config) return;
    stdin += chunk;
    const newline = stdin.indexOf('\n');
    if (newline < 0) return;
    try { config = JSON.parse(stdin.slice(0, newline)); } catch { config = {}; }
    event({ type: 'config', config });
  });
  // stdin 读到 EOF 即退出：Node 崩溃 / 退出后不能留下孤儿进程。
  const bye = () => { event({ type: 'stdin-eof' }); process.exit(0); };
  process.stdin.on('end', bye);
  process.stdin.on('close', bye);
  process.stdin.resume();

  if (process.env.FAKE_REMOTE_PID_FILE) {
    try { fs.writeFileSync(process.env.FAKE_REMOTE_PID_FILE, String(process.pid)); } catch {}
  }
  if (process.env.FAKE_REMOTE_FAIL_START === '1') {
    event({ type: 'start-failed' });
    process.exit(3);
  }

  const secret = crypto.randomBytes(32).toString('hex');
  const sockets = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readBody(req);
    const authorized = req.headers['x-multicc-remote-secret'] === secret;
    event({
      type: 'http', method: req.method, url: req.url, authorized,
      contentType: req.headers['content-type'] || null,
      powerConsent: req.headers['x-multicc-power-consent'] ?? null,
      body: body.toString('utf8'),
    });
    if (!authorized) { res.writeHead(403); res.end(); return; }

    if (url.pathname === '/api/remote-screen/capabilities') return json(res, 200, CAPABILITIES);
    if (url.pathname === '/api/remote-screen/frame') {
      const headers = {
        'content-type': 'image/jpeg',
        'cache-control': 'no-store',
        'x-screen-width': '1470',
        'x-screen-height': '956',
      };
      if (url.searchParams.has('x')) {
        Object.assign(headers, {
          'x-region-x': url.searchParams.get('x'), 'x-region-y': url.searchParams.get('y') || '0',
          'x-region-width': url.searchParams.get('width') || '0',
          'x-region-height': url.searchParams.get('height') || '0',
        });
      }
      res.writeHead(200, { ...headers, 'content-length': String(JPEG.length) });
      res.end(req.method === 'HEAD' ? undefined : JPEG);
      return;
    }
    if (url.pathname === '/api/remote-screen/input') {
      let parsed = null;
      try { parsed = JSON.parse(body.toString('utf8')); } catch {}
      return json(res, 202, { ok: true, received: parsed, secret: req.headers['x-multicc-remote-secret'] || null,
        method: req.method, url: req.url }, { 'x-screen-echo': '1' });
    }
    if (url.pathname === '/api/remote-screen/wake') {
      return json(res, 200, { ok: true, consent: req.headers['x-multicc-power-consent'] ?? null,
        method: req.method, url: req.url });
    }
    if (url.pathname === '/api/remote-screen/snapshot') {
      return json(res, 200, { ok: true, width: 1470, height: 956 });
    }
    if (url.pathname === '/internal/annotation') {
      let payload = {};
      try { payload = JSON.parse(body.toString('utf8')); } catch {}
      return json(res, 200, { ok: true, refresh: true, text: `已执行：${payload.kind || 'annotation'}`, received: payload });
    }
    return json(res, 404, { ok: false, error: 'not-found' });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const authorized = req.headers['x-multicc-remote-secret'] === secret;
    event({ type: 'ws-upgrade', url: req.url, authorized, delayed: !!process.env.FAKE_REMOTE_WS_DELAY_MS });
    if (!authorized) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = () => wss.handleUpgrade(req, socket, head, ws => onConnection(ws, req));
    const delay = Number(process.env.FAKE_REMOTE_WS_DELAY_MS) || 0;
    if (delay > 0) setTimeout(accept, delay).unref?.();
    else accept();
  });

  function onConnection(ws, req) {
    sockets.add(ws);
    event({ type: 'ws-open', url: req.url });
    ws.on('close', (code, reason) => {
      sockets.delete(ws);
      event({ type: 'ws-close', code, reason: String(reason || '') });
    });
    ws.on('error', () => {});
    ws.send(JSON.stringify({ t: 'hello', url: req.url }));

    const pipePath = process.env.FAKE_REMOTE_PIPE_SOCK;
    if (pipePath) {
      const sock = net.connect(pipePath);
      sockets.add(sock);
      sock.on('error', () => {});
      // Agent 走的是字节流，但浏览器播放端按「一条 WS 消息 = 一个 5 字节头 + 帧」解析；
      // 真的 multicc-remote 会分帧，这里照做，读半包时先攒着。
      let pending = Buffer.alloc(0);
      sock.on('data', data => {
        pending = pending.length ? Buffer.concat([pending, data]) : data;
        let off = 0;
        while (pending.length - off >= 5) {
          const len = pending.readUInt32BE(off + 1);
          if (len > 8 * 1024 * 1024) {
            pending = Buffer.alloc(0);
            event({ type: 'pipe-frame-too-big', len });
            try { ws.close(1011, 'frame-too-big'); } catch {}
            return;
          }
          if (pending.length - off < 5 + len) break;
          if (ws.readyState === 1) ws.send(pending.subarray(off, off + 5 + len), { binary: true });
          off += 5 + len;
        }
        pending = off ? pending.subarray(off) : pending;
      });
      sock.on('close', () => { sockets.delete(sock); try { ws.close(1011, 'agent-closed'); } catch {} });
      ws.on('message', (data, isBinary) => { sock.write(data); event({ type: 'ws-message', binary: isBinary, bytes: data.length }); });
      ws.on('close', () => { sockets.delete(sock); sock.destroy(); });
      return;
    }

    // 默认回显：文本还是文本、二进制还是二进制，逐条原样返回。
    ws.on('message', (data, isBinary) => {
      event({ type: 'ws-message', binary: isBinary, bytes: data.length,
        hex: isBinary ? Buffer.from(data).toString('hex').slice(0, 64) : String(data).slice(0, 64) });
      if (ws.readyState === 1) ws.send(data, { binary: isBinary });
    });
  }

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    const announce = () => {
      process.stdout.write(JSON.stringify({ ready: true, v: 1, port, secret }) + '\n');
      event({ type: 'ready', port });
      const exitAfter = Number(process.env.FAKE_REMOTE_EXIT_AFTER_MS) || 0;
      if (exitAfter > 0) setTimeout(() => { event({ type: 'exit-after' }); process.exit(0); }, exitAfter);
    };
    if (process.env.FAKE_REMOTE_NO_READY === '1') return;
    const delay = Number(process.env.FAKE_REMOTE_READY_DELAY_MS) || 0;
    if (delay > 0) setTimeout(announce, delay);
    else announce();
  });
}

module.exports = { JPEG, CAPABILITIES };

if (require.main === module) start();
