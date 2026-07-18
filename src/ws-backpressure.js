'use strict';

const DEFAULTS = Object.freeze({
  highWaterBytes: 1024 * 1024,
  maxQueueBytes: 2 * 1024 * 1024,
  maxQueueMessages: 256,
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

  function enqueue(data, options, callback) {
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
    if (bytes > cfg.maxQueueBytes || queue.length >= cfg.maxQueueMessages || queueBytes + bytes > cfg.maxQueueBytes) {
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

  ws.send = enqueue;
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
    stats: () => ({ queueBytes, queueMessages: queue.length, sending, congestedAt, closed }),
    limits: cfg,
  };
  ws._multiccBackpressure = api;
  return api;
}

module.exports = { DEFAULTS, COALESCE_TYPES, byteLength, coalesceKey, installWsBackpressure };
