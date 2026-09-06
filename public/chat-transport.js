'use strict';

(function installChatTransport(root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MultiCCChatTransport = api;
})(typeof window !== 'undefined' ? window : null, function createChatTransportApi(root) {
  const OPEN = 1;
  const CLOSING = 2;
  const CLOSED = 3;
  const CREDENTIAL_QUERY_KEYS = new Set([
    'token', 'access_token', 'auth_token', 'api_key', 'apikey', 'authorization', 'x-access-token',
  ]);
  const errorModel = (root && root.MultiCCErrorEnvelope)
    || (typeof module === 'object' && module.exports ? require('./error-envelope') : null);

  function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function normalizeTransportError(error, context = {}) {
    if (errorModel) return errorModel.normalize(error || {}, {
      source: 'websocket', scope: 'session', ...context,
    });
    return error && error.envelope || {
      version: 'v1', code: error && error.code || context.defaultCode || 'WS_ERROR',
      category: context.category || 'network', family: context.category || 'network',
      message: error && error.message || context.fallbackMessage || 'WebSocket error',
      retryable: true, action: 'retry', scope: 'session', httpStatus: error && error.status || 0,
    };
  }

  function credentialFreeUrl(rawUrl, baseUrl) {
    const url = new URL(rawUrl, baseUrl);
    url.username = '';
    url.password = '';
    for (const key of Array.from(url.searchParams.keys())) {
      if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    return url.toString();
  }

  function safeDebugUrl(rawUrl, baseUrl) {
    const url = new URL(credentialFreeUrl(rawUrl, baseUrl), baseUrl);
    for (const key of Array.from(url.searchParams.keys())) {
      if (key.toLowerCase() === 'ticket') url.searchParams.set(key, '***');
    }
    return url.toString();
  }

  function verifiedTicketUrl(rawUrl, baseUrl) {
    const url = new URL(credentialFreeUrl(rawUrl, baseUrl), baseUrl);
    const base = new URL(baseUrl);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.host !== base.host) {
      throw codedError('WS_ENDPOINT_ORIGIN_INVALID', 'WebSocket endpoint must be same-origin');
    }
    if (base.protocol === 'https:' && url.protocol !== 'wss:') {
      throw codedError('WS_ENDPOINT_DOWNGRADE_REJECTED', 'WebSocket endpoint must preserve secure transport');
    }
    if (!url.searchParams.get('ticket')) throw codedError('WS_TICKET_MISSING', 'WebSocket ticket is required');
    return url.toString();
  }

  function createTransport(options = {}) {
    const hostWindow = options.window || (typeof window !== 'undefined' ? window : null);
    const hostDocument = options.document || (hostWindow && hostWindow.document) || null;
    const WebSocketCtor = options.WebSocket || (hostWindow && hostWindow.WebSocket);
    const setTimer = options.setTimeout || (hostWindow && hostWindow.setTimeout
      ? hostWindow.setTimeout.bind(hostWindow) : setTimeout);
    const clearTimer = options.clearTimeout || (hostWindow && hostWindow.clearTimeout
      ? hostWindow.clearTimeout.bind(hostWindow) : clearTimeout);
    const setIntervalFn = options.setInterval || (hostWindow && hostWindow.setInterval
      ? hostWindow.setInterval.bind(hostWindow) : setInterval);
    const clearIntervalFn = options.clearInterval || (hostWindow && hostWindow.clearInterval
      ? hostWindow.clearInterval.bind(hostWindow) : clearInterval);
    const baseUrl = options.baseUrl || (hostWindow && hostWindow.location && hostWindow.location.href);
    const ticketUrl = options.ticketUrl || (hostWindow && hostWindow.multiccWsUrl);
    const now = options.now || Date.now;

    if (!baseUrl) throw new Error('Chat transport requires a baseUrl');
    if (typeof options.buildUrl !== 'function') throw new Error('Chat transport requires buildUrl');
    if (typeof ticketUrl !== 'function') throw new Error('Chat transport requires ticketUrl');
    if (typeof WebSocketCtor !== 'function') throw new Error('Chat transport requires WebSocket');

    let socket = null;
    let reconnectAttempt = 0;
    let reconnectTimer = null;
    let connectGeneration = 0;
    let hiddenAt = 0;
    let heartbeatTimer = null;
    let lifecycleStarted = false;
    let destroyed = false;
    const removers = [];

    function publishSocket(next) {
      socket = next;
      if (typeof options.onSocket === 'function') options.onSocket(next);
    }

    function clearReconnectTimer() {
      if (reconnectTimer === null) return;
      clearTimer(reconnectTimer);
      reconnectTimer = null;
    }

    function schedule(delay) {
      if (destroyed) return;
      clearReconnectTimer();
      reconnectTimer = setTimer(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function retryNow() {
      reconnectAttempt = 0;
      return connect();
    }

    async function connect() {
      if (destroyed) return null;
      clearReconnectTimer();
      const generation = ++connectGeneration;
      let rawUrl;
      try {
        rawUrl = credentialFreeUrl(options.buildUrl(), baseUrl);
        const resolved = await ticketUrl(rawUrl);
        if (destroyed || generation !== connectGeneration) return null;
        const url = verifiedTicketUrl(resolved, baseUrl);
        const next = new WebSocketCtor(url);
        publishSocket(next);
        if (typeof options.onConnecting === 'function') {
          options.onConnecting({ socket: next, url, debugUrl: safeDebugUrl(url, baseUrl) });
        }

        next.onopen = (event) => {
          if (destroyed || socket !== next) return;
          const accepted = typeof options.onOpen === 'function'
            ? options.onOpen({ socket: next, event }) !== false
            : true;
          if (!accepted) {
            try { next.close(); } catch (_) {}
            return;
          }
          reconnectAttempt = 0;
        };
        next.onmessage = (event) => {
          if (!destroyed && socket === next && typeof options.onMessage === 'function') {
            options.onMessage(event);
          }
        };
        next.onclose = (event) => {
          if (destroyed || socket !== next) return;
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 15000);
          reconnectAttempt += 1;
          const envelope = errorModel
            ? errorModel.fromWsClose(event, { scope: 'session' })
            : normalizeTransportError({
              code: `WS_CLOSE_${Number(event && event.code) || 1006}`,
              message: event && event.reason || 'WebSocket connection closed',
            });
          const shouldReconnect = typeof options.onClose === 'function'
            ? options.onClose({
              socket: next,
              event,
              envelope,
              delay,
              seconds: Math.round(delay / 1000),
              attempt: reconnectAttempt,
            }) !== false
            : true;
          if (shouldReconnect) schedule(delay);
        };
        next.onerror = (event) => {
          if (!destroyed && socket === next && typeof options.onError === 'function') {
            options.onError({
              socket: next,
              event,
              envelope: normalizeTransportError({
                code: 'WS_SOCKET_ERROR', message: 'WebSocket transport error', retryable: true,
              }, { category: 'network' }),
            });
          }
        };
        return next;
      } catch (error) {
        if (destroyed || generation !== connectGeneration) return null;
        const envelope = normalizeTransportError(error, {
          category: error && error.category,
          source: error && error.family === 'remote' ? 'external_fleet_ws_ticket' : 'ws_ticket',
          defaultCode: 'WS_TICKET_FAILED',
          fallbackMessage: 'WebSocket ticket exchange failed',
        });
        if (typeof options.onTicketError === 'function') {
          options.onTicketError(error, { envelope, attempt: reconnectAttempt + 1 });
        }
        schedule(1000);
        return null;
      }
    }

    function ensureAlive(notify = true) {
      const state = socket && socket.readyState;
      const reconnecting = !socket || state === CLOSED || state === CLOSING;
      if (reconnecting) retryNow();
      if (notify && typeof options.onEnsureAlive === 'function') {
        options.onEnsureAlive({ reconnecting });
      }
      return reconnecting;
    }

    function forceReconnect(reason) {
      if (destroyed) return;
      if (typeof options.onForceReconnect === 'function') options.onForceReconnect(reason);
      clearReconnectTimer();
      reconnectAttempt = 0;
      connectGeneration += 1;
      const old = socket;
      if (old && old.readyState !== CLOSED) {
        old.onclose = null;
        old.onerror = null;
        old.onmessage = null;
        old.onopen = null;
        try { old.close(1000, 'client reconnect'); } catch (_) {}
      }
      publishSocket(null);
      connect();
    }

    function send(payload) {
      if (!socket || socket.readyState !== OPEN) return false;
      socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      return true;
    }

    function addListener(target, name, listener, listenerOptions) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(name, listener, listenerOptions);
      removers.push(() => target.removeEventListener(name, listener, listenerOptions));
    }

    function startLifecycle() {
      if (lifecycleStarted || destroyed) return;
      lifecycleStarted = true;
      addListener(hostDocument, 'visibilitychange', () => {
        if (hostDocument.visibilityState === 'hidden') {
          hiddenAt = now();
          return;
        }
        if (hostDocument.visibilityState === 'visible') {
          const hiddenMs = hiddenAt ? now() - hiddenAt : 0;
          hiddenAt = 0;
          if (hiddenMs > 10000) forceReconnect(`visible after ${Math.round(hiddenMs / 1000)}s hidden`);
          else ensureAlive();
        }
      });
      addListener(hostWindow, 'pageshow', event => {
        if (event.persisted) forceReconnect('pageshow from bfcache');
        else ensureAlive();
      });
      addListener(hostWindow, 'focus', ensureAlive);
      addListener(hostWindow, 'online', () => forceReconnect('network online'));
      heartbeatTimer = setIntervalFn(() => {
        if (!hostDocument || hostDocument.visibilityState === 'visible') ensureAlive(false);
      }, options.heartbeatMs || 5000);
    }

    function stopLifecycle() {
      while (removers.length) removers.pop()();
      if (heartbeatTimer !== null) clearIntervalFn(heartbeatTimer);
      heartbeatTimer = null;
      lifecycleStarted = false;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      connectGeneration += 1;
      clearReconnectTimer();
      stopLifecycle();
      const old = socket;
      if (old) {
        old.onclose = null;
        old.onerror = null;
        old.onmessage = null;
        old.onopen = null;
        try { old.close(1000, 'client shutdown'); } catch (_) {}
      }
      publishSocket(null);
    }

    return Object.freeze({
      connect,
      retryNow,
      ensureAlive,
      forceReconnect,
      send,
      startLifecycle,
      stopLifecycle,
      destroy,
      getSocket: () => socket,
      isOpen: () => !!socket && socket.readyState === OPEN,
      getReconnectAttempt: () => reconnectAttempt,
    });
  }

  return Object.freeze({
    createTransport,
    credentialFreeUrl,
    normalizeTransportError,
    safeDebugUrl,
    verifiedTicketUrl,
  });
});
