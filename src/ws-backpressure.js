'use strict';

const DEFAULTS = Object.freeze({
  highWaterBytes: 1024 * 1024,
  maxQueueBytes: 2 * 1024 * 1024,
  // Streaming chat turns emit many small delta frames; a single burst
  // (e.g. a reconnect replay of an in-progress turn, or a fast model's
  // token stream) can legitimately queue hundreds of messages in a tick.
  // The 256 default this replaced was below what the normal streaming path
  // produces, so it fired queue_overflow on healthy clients. The real
  // slow-client guards are the byte cap (maxQueueBytes) and the congestion
  // timer (maxCongestionMs) — message count is only a coarse safety net, so
  // keep it high enough not to trip on normal streaming volume.
  maxQueueMessages: 4096,
  maxCongestionMs: 15_000,
  retryMs: 25,
});

const COALESCE_TYPES = new Set([
  'snapshot', 'meta_snapshot', 'task_state', 'provider_token_stats',
  'role_token_stats', 'aux_init', 'aux_history', 'session_status',
]);

function byteLength(data) {
  if (Buffer.isBuffer(data)) return data.length;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return Buffer.byteLength(String(data));
}

function coalesceKey(data) {
  if (typeof data !== 'string' && !Buffer.isBuffer(data)) return null;
  try {
    const parsed = JSON.parse(data.toString());
    if (!parsed || !COALESCE_TYPES.has(parsed.type)) return null;
    return `${parsed.type}:${parsed.dirId || parsed.sessionId || parsed.role || ''}`;
  } catch (_) {
    return null;
  }
}

function installWsBackpressure(ws, {
  limits = {},
  onMetric = () => {},
  onLog = () => {},
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancelSchedule = clearTimeout,
} = {}) {
  if (ws._multiccBackpressure) return ws._multiccBackpressure;
  const cfg = { ...DEFAULTS, ...limits };
  const originalSend = ws.send.bind(ws);
  const queue = [];
  let queueBytes = 0;
  let sending = false;
  let timer = null;
  let congestedAt = 0;
  let closed = false;

  function metric(name, amount = 1) { try { onMetric(name, amount); } catch (_) {} }

  function scheduleFlush() {
    if (timer || closed) return;
    timer = schedule(() => { timer = null; flush(); }, cfg.retryMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function disconnect(reason) {
    if (closed) return;
    closed = true;
    if (timer) { cancelSchedule(timer); timer = null; }
    metric('multicc_ws_backpressure_disconnects_total');
    onLog('ws_backpressure_disconnect', { reason, queueBytes, queueMessages: queue.length, bufferedAmount: ws.bufferedAmount || 0 });
    try { ws.close(1013, 'slow client; reconnect to resync'); }
    catch (_) { try { ws.terminate(); } catch (_) {} }
  }

  function flush() {
    if (closed || sending || queue.length === 0) return;
    if ((ws.bufferedAmount || 0) >= cfg.highWaterBytes) {
      if (!congestedAt) congestedAt = now();
      metric('multicc_ws_high_water_events_total');
      if (now() - congestedAt >= cfg.maxCongestionMs) return disconnect('high_water_timeout');
      scheduleFlush();
      return;
    }
    congestedAt = 0;
    const item = queue.shift();
    queueBytes -= item.bytes;
    sending = true;
    try {
      originalSend(item.data, item.options, err => {
        sending = false;
        if (typeof item.callback === 'function') item.callback(err);
        if (err) return disconnect('send_error');
        flush();
      });
    } catch (err) {
      sending = false;
      if (typeof item.callback === 'function') item.callback(err);
      disconnect('send_throw');
    }
  }

  // `bounded` distinguishes the two producers:
  //   • normal live sends (bounded=true): subject to the message-count tripwire,
  //     so a genuinely stuck client that keeps accumulating unsent frames is
  //     eventually disconnected.
  //   • replay bursts (bounded=false, via sendImmediate): a one-shot, already-
  //     bounded batch (the caller's own streamReplay cap limits it) enqueued
  //     synchronously on connect. This path skips the message-COUNT guard — that
  //     count is a coarse proxy for "slow client" and a replay burst is neither
  //     slow nor unbounded — but STILL respects the byte cap (real memory guard)
  //     and the congestion timer in flush(). Skipping the count stops the
  //     reconnect→replay→overflow→1013→reconnect death-loop that hit long
  //     streaming turns.
  function enqueue(data, options, callback, bounded = true) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (closed) {
      if (typeof callback === 'function') callback(new Error('WebSocket backpressure transport closed'));
      return;
    }
    const bytes = byteLength(data);
    const key = coalesceKey(data);
    if (key) {
      const index = queue.findIndex(item => item.key === key);
      if (index !== -1) {
        const old = queue[index];
        queueBytes -= old.bytes;
        queue[index] = { data, options, callback, bytes, key };
        queueBytes += bytes;
        metric('multicc_ws_messages_coalesced_total');
        flush();
        return;
      }
    }
    // Byte cap always applies (memory guard). Message-count cap applies only to
    // the bounded live-send path.
    const overByteCap = bytes > cfg.maxQueueBytes || queueBytes + bytes > cfg.maxQueueBytes;
    const overMsgCap = bounded && queue.length >= cfg.maxQueueMessages;
    if (overByteCap || overMsgCap) {
      metric('multicc_ws_queue_overflows_total');
      disconnect('queue_overflow');
      if (typeof callback === 'function') callback(new Error('WebSocket send queue overflow'));
      return;
    }
    queue.push({ data, options, callback, bytes, key });
    queueBytes += bytes;
    const nextDepth = queue.length;
    onMetric('multicc_ws_queue_depth', nextDepth, 'set');
    flush();
  }

  // Public replay path: enqueue without the message-count tripwire. Used by the
  // server's reconnect stream-replay loop.
  function sendImmediate(data, options, callback) {
    return enqueue(data, options, callback, false);
  }

  ws.send = (data, options, callback) => enqueue(data, options, callback, true);
  ws.once?.('close', () => {
    closed = true;
    if (timer) cancelSchedule(timer);
    timer = null;
    queue.length = 0;
    queueBytes = 0;
  });
  const api = {
    flush,
    disconnect,
    sendImmediate,
    stats: () => ({ queueBytes, queueMessages: queue.length, sending, congestedAt, closed }),
    limits: cfg,
  };
  ws._multiccBackpressure = api;
  return api;
}

module.exports = { DEFAULTS, COALESCE_TYPES, byteLength, coalesceKey, installWsBackpressure };
