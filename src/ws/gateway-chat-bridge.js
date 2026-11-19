'use strict';

// Node's end of the chat bridge: the front door owns every /ws/chat client
// socket, and the chat engine in this process talks to each client through a
// virtual socket carried by one private loopback stream. The frame grammar is
// native/core/src/chat_bridge.rs; tests/test-gateway-chat-bridge.js checks this
// codec against the byte corpus that module generates.
//
// A virtual socket implements exactly the part of the `ws` WebSocket surface
// the connection router, the native send queue and the chat engine use, with
// the same semantics: `send` completes when the front door has written the
// frame to the client's socket (so `bufferedAmount` is the bytes not yet
// written), `close` starts the close handshake, `terminate` drops the socket,
// and `close` is emitted once with the status the handshake ended with.
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const net = require('node:net');

const MAX_BODY = 100 * 1024 * 1024 + 1024;
const HANDSHAKE_MAX_FRAME = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 3000;

const KIND = Object.freeze({
  open: 0x01, message: 0x02, pong: 0x03, closed: 0x04, sent: 0x05,
  send: 0x11, close: 0x12, terminate: 0x13, ping: 0x14,
});

// `ws`'s readyState values.
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const READY_NAMES = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];

class FrameError extends Error {}

function header(kind, conn, extra = 0) {
  const out = Buffer.allocUnsafe(5 + extra);
  out[0] = kind;
  out.writeUInt32BE(conn >>> 0, 1);
  return out;
}

// Node -> front door.
function encodeSend(conn, seq, binary, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const out = header(KIND.send, conn, 5);
  out.writeUInt32BE(seq >>> 0, 5);
  out[9] = binary ? 1 : 0;
  return Buffer.concat([out, payload]);
}
function encodeClose(conn, code, reason) {
  const text = Buffer.from(reason || '', 'utf8');
  const out = header(KIND.close, conn, 2);
  out.writeUInt16BE(code == null ? 0 : code, 5);
  return Buffer.concat([out, text]);
}
const encodeTerminate = conn => header(KIND.terminate, conn);
const encodePing = conn => header(KIND.ping, conn);

// Front door -> Node. Strict: anything off-grammar throws FrameError, and the
// caller treats that as the loss of the whole bridge.
const utf8 = new TextDecoder('utf-8', { fatal: true });
function text(buffer) {
  try { return utf8.decode(buffer); } catch (_) { throw new FrameError('invalid UTF-8'); }
}
function need(body, length) {
  if (body.length < length) throw new FrameError('truncated frame');
}
function exact(body, length) {
  need(body, length);
  if (body.length !== length) throw new FrameError('trailing bytes');
}
function flag(byte) {
  if (byte !== 0 && byte !== 1) throw new FrameError('bad flag');
  return byte === 1;
}
function decodeToNode(body) {
  if (body.length === 0) throw new FrameError('empty frame');
  const kind = body[0];
  switch (kind) {
    case KIND.open: {
      need(body, 5);
      let info;
      try { info = JSON.parse(text(body.subarray(5))); } catch (error) {
        throw error instanceof FrameError ? error : new FrameError('bad JSON');
      }
      return { kind, conn: body.readUInt32BE(1), info };
    }
    case KIND.message:
      need(body, 6);
      return { kind, conn: body.readUInt32BE(1), binary: flag(body[5]), data: body.subarray(6) };
    case KIND.pong:
      exact(body, 5);
      return { kind, conn: body.readUInt32BE(1) };
    case KIND.closed: {
      need(body, 8);
      if (body[7] > 3) throw new FrameError('bad flag');
      return {
        kind, conn: body.readUInt32BE(1), code: body.readUInt16BE(5),
        received: (body[7] & 1) !== 0, sent: (body[7] & 2) !== 0, reason: text(body.subarray(8)),
      };
    }
    case KIND.sent: {
      need(body, 10);
      const failed = flag(body[9]);
      const message = text(body.subarray(10));
      return { kind, conn: body.readUInt32BE(1), seq: body.readUInt32BE(5), error: failed ? message : null };
    }
    default:
      throw new FrameError(`unknown kind ${kind}`);
  }
}

// ws validates close codes the same way (RFC 6455 section 7.4).
function validCloseCode(code) {
  return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006)
    || (code >= 3000 && code <= 4999);
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data), 'utf8');
}

class BridgeSocket extends EventEmitter {
  constructor(bridge, conn, protocolInfo) {
    super();
    this._bridge = bridge;
    this._conn = conn;
    this.readyState = OPEN;
    this.protocol = '';
    this.extensions = '';
    this.url = '';
    this._pending = new Map();
    this._nextSeq = 0;
    this._buffered = 0;
    this._closeFrameReceived = false;
    this._closeFrameSent = false;
    this._closeCode = 1006;
    this._closeReason = Buffer.alloc(0);
    Object.defineProperty(this, '_peer', { value: protocolInfo, enumerable: false });
  }

  get bufferedAmount() { return this._buffered; }

  send(data, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const opts = options && typeof options === 'object' ? options : {};
    if (this.readyState !== OPEN) {
      const error = new Error(`WebSocket is not open: readyState ${this.readyState} (${READY_NAMES[this.readyState]})`);
      if (typeof callback === 'function') process.nextTick(callback, error);
      return;
    }
    const payload = toBuffer(data);
    const binary = opts.binary !== undefined ? Boolean(opts.binary) : typeof data !== 'string';
    const seq = this._nextSeq;
    this._nextSeq = (this._nextSeq + 1) >>> 0;
    this._pending.set(seq, { callback, bytes: payload.length });
    this._buffered += payload.length;
    this._bridge._write(encodeSend(this._conn, seq, binary, payload));
  }

  ping() {
    if (this.readyState !== OPEN) return;
    this._bridge._write(encodePing(this._conn));
  }

  close(code, reason) {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    if (code !== undefined && !validCloseCode(code)) {
      throw new TypeError(`First argument must be a valid error code number`);
    }
    const bytes = Buffer.from(reason === undefined ? '' : String(reason), 'utf8');
    if (bytes.length > 123) throw new RangeError('The message must not be greater than 123 bytes');
    this.readyState = CLOSING;
    this._closeFrameSent = true;
    this._bridge._write(encodeClose(this._conn, code, bytes.toString('utf8')));
  }

  terminate() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    this._bridge._write(encodeTerminate(this._conn));
  }

  // Front door -> socket.
  _complete(seq, error) {
    const entry = this._pending.get(seq);
    if (!entry) return;
    this._pending.delete(seq);
    this._buffered -= entry.bytes;
    if (typeof entry.callback === 'function') {
      try { entry.callback(error ? new Error(error) : undefined); } catch (_) {}
    }
  }

  _finish(code, received, sent, reason) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this._closeFrameReceived = received;
    this._closeFrameSent = sent || this._closeFrameSent;
    // Sends still waiting for the front door will never be completed.
    for (const [seq] of this._pending) this._complete(seq, 'WebSocket is not open: readyState 3 (CLOSED)');
    this._bridge._forget(this._conn, this);
    this.emit('close', code, Buffer.from(reason || '', 'utf8'));
  }
}

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// A small pull reader over a socket: the handshake needs `read exactly n`.
function createReader(socket) {
  let buffered = Buffer.alloc(0);
  let waiting = null;
  let ended = null;
  const wake = () => { if (waiting) { const fn = waiting; waiting = null; fn(); } };
  socket.on('data', chunk => { buffered = Buffer.concat([buffered, chunk]); wake(); });
  socket.on('end', () => { ended = ended || new Error('stream ended'); wake(); });
  socket.on('close', () => { ended = ended || new Error('stream closed'); wake(); });
  socket.on('error', error => { ended = error; wake(); });
  return {
    async exact(length) {
      while (buffered.length < length) {
        if (ended) throw ended;
        await new Promise(resolve => { waiting = resolve; });
      }
      const out = buffered.subarray(0, length);
      buffered = buffered.subarray(length);
      return out;
    },
    // Whatever was read past the handshake belongs to the frame loop.
    take() { const rest = buffered; buffered = Buffer.alloc(0); return rest; },
    release() { socket.removeAllListeners('data'); },
  };
}

async function readJsonFrame(reader) {
  const size = (await reader.exact(4)).readUInt32BE(0);
  if (size === 0 || size > HANDSHAKE_MAX_FRAME) throw new Error('bad handshake frame');
  return JSON.parse((await reader.exact(size)).toString('utf8'));
}
function writeJsonFrame(socket, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(body.length, 0);
  socket.write(Buffer.concat([prefix, body]));
}

// The mutual capability proof of native/core/src/auth_control.rs `connect`.
async function handshake(socket, reader, capability) {
  const nonce = await readJsonFrame(reader);
  if (typeof nonce !== 'string' || nonce.length !== 32) throw new Error('bad nonce');
  writeJsonFrame(socket, sign(capability, `child:${nonce}`));
  const proof = await readJsonFrame(reader);
  if (!timingSafeEqual(proof, sign(capability, `parent:${nonce}`))) throw new Error('front door failed the capability proof');
}

function peerRequest(info) {
  const headers = Object.create(null);
  const rawHeaders = [];
  for (const [name, value] of info.headers) {
    headers[name] = value;
    rawHeaders.push(name, value);
  }
  const family = net.isIP(info.remoteAddress) === 6 ? 'IPv6' : 'IPv4';
  const socket = {
    remoteAddress: info.remoteAddress,
    remotePort: info.remotePort,
    remoteFamily: family,
    localAddress: info.localAddress,
    localPort: info.localPort,
    encrypted: false,
  };
  return {
    method: 'GET', url: info.url, httpVersion: '1.1', headers, rawHeaders, socket, connection: socket,
  };
}

// Connects to the front door and delivers every client socket as
// `onConnection(ws, req)`. Resolves once the stream is live; the returned
// handle lets a test end it. `wss` (optional) is the server whose `clients`
// set tracks open sockets, as `ws` itself does.
async function connectChatBridge({ port, capability, onConnection, wss, logger = console, onLost }) {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.setNoDelay(true);
  const reader = createReader(socket);
  const timer = setTimeout(() => socket.destroy(new Error('chat bridge handshake timed out')), HANDSHAKE_TIMEOUT_MS);
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    await handshake(socket, reader, capability);
  } catch (error) {
    clearTimeout(timer);
    socket.destroy();
    throw error;
  }
  clearTimeout(timer);

  const sockets = new Map();
  let lost = false;
  const bridge = {
    _write(body) {
      if (lost || socket.destroyed) return;
      const prefix = Buffer.allocUnsafe(4);
      prefix.writeUInt32BE(body.length, 0);
      socket.write(Buffer.concat([prefix, body]));
    },
    _forget(conn, ws) {
      if (sockets.get(conn) === ws) sockets.delete(conn);
      if (wss && wss.clients) wss.clients.delete(ws);
    },
  };

  function lose(error) {
    if (lost) return;
    lost = true;
    socket.destroy();
    // The front door ends the client sockets too; settle ours the same way a
    // dropped TCP connection settles a `ws` socket.
    for (const ws of [...sockets.values()]) ws._finish(1006, false, false, '');
    sockets.clear();
    if (typeof onLost === 'function') onLost(error);
  }

  // A listener that throws must cost its own socket, not the stream every
  // other client shares (`ws` surfaced such a throw to the process instead).
  function guarded(ws, work) {
    try { work(); } catch (error) {
      logger.error?.('chat_bridge_listener_failed', { message: String((error && error.message) || error) });
      try { ws.terminate(); } catch (_) {}
    }
  }

  function dispatch(frame) {
    if (frame.kind === KIND.open) {
      if (sockets.has(frame.conn)) throw new FrameError('duplicate connection id');
      const ws = new BridgeSocket(bridge, frame.conn, frame.info);
      sockets.set(frame.conn, ws);
      if (wss && wss.clients) wss.clients.add(ws);
      const req = peerRequest(frame.info);
      guarded(ws, () => onConnection(ws, req));
      return;
    }
    const ws = sockets.get(frame.conn);
    if (!ws) return; // A frame for a socket that already ended.
    switch (frame.kind) {
      case KIND.message: guarded(ws, () => ws.emit('message', Buffer.from(frame.data), frame.binary)); break;
      case KIND.pong: guarded(ws, () => ws.emit('pong', Buffer.alloc(0))); break;
      case KIND.sent: ws._complete(frame.seq, frame.error); break;
      case KIND.closed: guarded(ws, () => ws._finish(frame.code, frame.received, frame.sent, frame.reason)); break;
      default: throw new FrameError('unexpected kind');
    }
  }

  let pending = reader.take();
  reader.release();
  const feed = chunk => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    try {
      for (;;) {
        if (pending.length < 4) return;
        const size = pending.readUInt32BE(0);
        if (size === 0 || size > MAX_BODY) throw new FrameError('bad frame length');
        if (pending.length < 4 + size) return;
        const body = pending.subarray(4, 4 + size);
        pending = pending.subarray(4 + size);
        dispatch(decodeToNode(body));
      }
    } catch (error) {
      logger.error?.('chat_bridge_protocol_error', { message: error.message });
      lose(error);
    }
  };
  socket.on('data', feed);
  socket.on('close', () => lose(new Error('chat bridge closed')));
  socket.on('error', error => lose(error));
  if (pending.length) feed(Buffer.alloc(0));

  return {
    get lost() { return lost; },
    sockets: () => sockets.size,
    end() { lose(new Error('chat bridge ended')); },
  };
}

module.exports = {
  BridgeSocket, FrameError, KIND, connectChatBridge, decodeToNode, encodeClose, encodePing, encodeSend,
  encodeTerminate, sign, validCloseCode,
  READY: Object.freeze({ CONNECTING, OPEN, CLOSING, CLOSED }),
};
