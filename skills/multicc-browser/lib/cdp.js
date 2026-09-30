'use strict';

// A Chrome DevTools Protocol client over the global WebSocket (Node >= 22), so
// the skill needs no npm dependency. One connection carries the browser-level
// session plus every flattened page session (`sessionId` on each message).

const { MbError } = require('./paths');

const DEFAULT_TIMEOUT = 30000;

function isSessionGone(message) {
  return /Session with given id not found|No target with given id|Target closed|Cannot find context/i
    .test(String(message || ''));
}

class CDP {
  constructor(url, { timeout = DEFAULT_TIMEOUT, label = 'cdp' } = {}) {
    this.url = url;
    this.label = label;
    this.defaultTimeout = timeout;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.closeReason = null;
    this.onClose = null;
  }

  static connect(url, options = {}) {
    const client = new CDP(url, options);
    return client.open().then(() => client);
  }

  open() {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(this.url);
      } catch (error) {
        reject(new MbError('cdp_connect', `cannot open ${this.url}: ${error.message}`));
        return;
      }
      this.ws = socket;
      const timer = setTimeout(() => {
        this.fail(new MbError('cdp_connect', `timed out connecting to ${this.url}`));
        try { socket.close(); } catch (_) { /* already gone */ }
        reject(new MbError('cdp_connect', `timed out connecting to ${this.url}`));
      }, this.defaultTimeout);
      timer.unref?.();
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(this);
      });
      socket.addEventListener('message', event => this.onMessage(event.data));
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        const error = new MbError('cdp_connect', `WebSocket error on ${this.url}`);
        reject(error);
        this.fail(error);
      });
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        this.finish(this.closeReason || new MbError('cdp_closed', `connection closed: ${this.url}`));
      });
    });
  }

  onMessage(data) {
    let text = data;
    if (typeof text !== 'string') {
      try { text = Buffer.from(text).toString('utf8'); } catch (_) { return; }
    }
    let message;
    try { message = JSON.parse(text); } catch (_) { return; }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new MbError('cdp_error', message.error.message || 'CDP error', {
          method: entry.method,
          data: message.error.data,
          sessionId: entry.sessionId,
        }));
      } else {
        entry.resolve(message.result || {});
      }
      return;
    }
    if (!message.method) return;
    const handlers = this.listeners.get(message.method);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try { handler(message.params || {}, message.sessionId || null); } catch (_) { /* listener bugs must not kill the socket */ }
    }
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => {
      const set = this.listeners.get(method);
      if (set) set.delete(handler);
    };
  }

  send(method, params = {}, sessionId = undefined, options = {}) {
    const timeout = options.timeout || this.defaultTimeout;
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new MbError('cdp_closed', `not connected: ${this.closeReason ? this.closeReason.message : this.url}`));
        return;
      }
      const id = this.nextId++;
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MbError('timeout', `${method} did not answer within ${timeout}ms`, { method, sessionId }));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, method, sessionId, timer });
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new MbError('cdp_send', `${method}: ${error.message}`));
      }
    });
  }

  // Resolves with the first matching event; used for load/idle waits.
  waitFor(method, { sessionId = null, timeout = DEFAULT_TIMEOUT, predicate = () => true } = {}) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params, eventSession) => {
        if (eventSession !== sessionId) return;
        if (!predicate(params, eventSession)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      const timer = setTimeout(() => {
        off();
        reject(new MbError('timeout', `no ${method} event within ${timeout}ms`, { method, sessionId }));
      }, timeout);
      timer.unref?.();
      if (this.closed) {
        clearTimeout(timer);
        off();
        reject(new MbError('cdp_closed', `not connected: ${this.url}`));
      }
    });
  }

  fail(error) {
    this.closeReason = this.closeReason || error;
  }

  finish(error) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = this.closeReason || error;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(entry.method
        ? new MbError('cdp_closed', `${entry.method} abandoned: ${this.closeReason.message}`)
        : this.closeReason);
    }
    this.pending.clear();
    if (this.onClose) {
      try { this.onClose(this.closeReason); } catch (_) { /* ignore */ }
    }
  }

  close(reason) {
    this.fail(reason || new MbError('cdp_closed', 'client closed'));
    try {
      if (this.ws && this.ws.readyState <= 1) this.ws.close();
    } catch (_) { /* ignore */ }
    this.finish(this.closeReason);
  }
}

// `http://127.0.0.1:PORT/json/version` — used for readiness and attach.
async function fetchVersion(port, { host = '127.0.0.1', timeout = 2000 } = {}) {
  const response = await fetch(`http://${host}:${port}/json/version`, {
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new MbError('cdp_http', `GET /json/version -> HTTP ${response.status}`);
  const data = await response.json();
  if (!data || typeof data.webSocketDebuggerUrl !== 'string') {
    throw new MbError('cdp_http', 'GET /json/version returned no webSocketDebuggerUrl');
  }
  return data;
}

module.exports = { CDP, fetchVersion, isSessionGone, DEFAULT_TIMEOUT, MbError };
