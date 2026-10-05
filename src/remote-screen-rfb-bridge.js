'use strict';

const net = require('node:net');

// Raw RFB is a byte stream: dropping an old chunk would corrupt all following
// rectangles. Apply backpressure instead; reconnect on a stall/queue overflow
// so clients can get a new full frame or use the existing JPEG fallback.
function attachRfbBridge(ws, { socketPath, connect = path => net.createConnection(path),
  timeoutMs = 12000, maxBufferedBytes = 8 * 1024 * 1024 } = {}) {
  const sock = connect(socketPath);
  const pending = [];
  let pendingBytes = 0, open = false, closed = false, timer;
  const die = (reason = 'rfb-unavailable', closeWs = true) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    pending.length = 0;
    sock.destroy();
    if (closeWs && ws.readyState === 1) {
      try { ws.close(1011, reason); } catch {}
    }
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => die('rfb-stalled'), timeoutMs);
    timer.unref?.();
  };
  const write = data => {
    if (sock.writableLength + data.length > maxBufferedBytes) return die('rfb-backpressure');
    if (!sock.write(data)) ws.pause?.();
  };
  arm();
  ws.on('message', data => {
    if (closed) return;
    if (open) { write(data); return; }
    pendingBytes += data.length;
    if (pendingBytes > 64 * 1024) return die('rfb-backpressure');
    pending.push(data);
  });
  sock.on('connect', () => {
    if (closed) return;
    open = true;
    for (const data of pending) { if (!closed) write(data); }
    pending.length = 0; pendingBytes = 0;
  });
  sock.on('drain', () => { if (!closed) ws.resume?.(); });
  sock.on('data', data => {
    if (closed) return;
    if (ws.readyState !== 1) return die();
    arm(); // only screen/keepalive data counts; mouse activity cannot hide a stalled stream
    if (ws.bufferedAmount + data.length > maxBufferedBytes) return die('rfb-backpressure');
    sock.pause();
    try {
      ws.send(data, { binary: true }, error => {
        if (error) { die(); return; }
        if (!closed) sock.resume();
      });
    } catch { die(); }
  });
  sock.on('error', () => die());
  sock.on('close', () => die());
  ws.on('close', () => die('rfb-unavailable', false));
  ws.on('error', () => die());
}

module.exports = { attachRfbBridge };
