'use strict';

function multiccTokenFreeRelativeUrl(rawHref, baseHref) {
  const clean = new URL(rawHref, baseHref);
  clean.searchParams.delete('token');
  return clean.pathname + clean.search + clean.hash;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { multiccTokenFreeRelativeUrl };
}

// Exchange legacy `?token=` bootstrap links for an HttpOnly cookie, then keep
// credentials out of REST and WebSocket URLs. All same-origin fetches carry the
// bootstrap token as a header only until the exchange succeeds.
(function installMulticcAuthClient() {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(location.search);
  let bootstrapToken = params.get('token') || '';
  const externalFleetId = params.get('external') || '';
  const nativeFetch = window.fetch.bind(window);

  // Capture the legacy bootstrap token in memory and scrub the address bar
  // synchronously, before any page script can copy it into a request, DOM node,
  // retry URL, log entry, or navigation target. Other query params and the hash
  // are preserved verbatim by URLSearchParams/URL serialization.
  if (params.has('token')) {
    history.replaceState(
      history.state,
      '',
      multiccTokenFreeRelativeUrl(location.href, location.href),
    );
  }

  function isSameOrigin(input) {
    try {
      const raw = input instanceof Request ? input.url : String(input);
      return new URL(raw, location.href).origin === location.origin;
    } catch (_) { return false; }
  }

  function externalProxyInput(input) {
    if (!externalFleetId || !isSameOrigin(input)) return input;
    let url;
    try {
      const raw = input instanceof Request ? input.url : String(input);
      url = new URL(raw, location.href);
    } catch (_) { return input; }
    if (!url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/external-fleets/')) return input;
    url.pathname = `/api/external-fleets/${encodeURIComponent(externalFleetId)}/remote${url.pathname}`;
    if (input instanceof Request) return new Request(url.href, input);
    return url.href;
  }

  window.fetch = function authenticatedFetch(input, init) {
    const options = { ...(init || {}) };
    if (bootstrapToken && isSameOrigin(input)) {
      const source = input instanceof Request ? input.headers : undefined;
      const headers = new Headers(source || options.headers || {});
      if (!headers.has('X-Access-Token')) headers.set('X-Access-Token', bootstrapToken);
      options.headers = headers;
    }
    return nativeFetch(externalProxyInput(input), options);
  };

  async function responseError(response, context) {
    const model = window.MultiCCErrorEnvelope;
    if (model && typeof model.fromHttpResponse === 'function') {
      return model.fromHttpResponse(response, context);
    }
    let body = null;
    try {
      if (response && typeof response.json === 'function') body = await response.json();
    } catch (_) { /* status remains useful when an older server returns text */ }
    const nested = body && body.error && typeof body.error === 'object' ? body.error : null;
    const message = body && (typeof body.error === 'string' ? body.error : body.message)
      || nested && nested.message
      || (context && context.fallbackMessage)
      || `HTTP ${response && response.status || 0}`;
    const error = new Error(String(message));
    error.name = 'MultiCCError';
    error.code = body && (body.code || nested && nested.code)
      || (context && context.defaultCode)
      || 'HTTP_ERROR';
    error.status = Number(response && response.status) || 0;
    error.requestId = body && body.requestId || null;
    error.correlationId = body && body.correlationId || error.requestId;
    error.details = body;
    return error;
  }

  const ready = bootstrapToken
    ? window.fetch('/api/auth/exchange', { method: 'POST', credentials: 'same-origin' })
      .then(res => {
        if (!res.ok) throw new Error(`auth exchange failed: HTTP ${res.status}`);
        bootstrapToken = '';
      })
      .catch(err => { console.warn('[multicc/auth] bootstrap exchange failed', err.message); })
    : Promise.resolve();

  window.multiccAuthReady = ready;
  window.multiccWsUrl = async function multiccWsUrl(rawUrl) {
    await ready;
    const url = new URL(rawUrl, location.href);
    url.searchParams.delete('token');
    if (externalFleetId) {
      const sessionId = url.searchParams.get('session') || url.searchParams.get('id') || '';
      const directoryId = url.searchParams.get('dirId') || '';
      const res = await window.fetch(`/api/external-fleets/${encodeURIComponent(externalFleetId)}/ws-ticket`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pathname: url.pathname, sessionId, directoryId }),
      });
      if (!res.ok) throw await responseError(res, {
        source: 'external_fleet_ws_ticket',
        scope: 'session',
        category: 'remote',
        defaultCode: 'EXTERNAL_FLEET_WS_TICKET_FAILED',
        fallbackMessage: `Shared workspace WebSocket ticket failed: HTTP ${res.status}`,
      });
      const data = await res.json();
      const remoteOrigin = new URL(data.wsOrigin);
      url.protocol = remoteOrigin.protocol;
      url.host = remoteOrigin.host;
      url.searchParams.set('ticket', data.ticket);
      return url.toString();
    }
    const res = await window.fetch('/api/auth/ws-ticket', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: url.pathname }),
    });
    if (!res.ok) throw await responseError(res, {
      source: 'ws_ticket',
      scope: 'session',
      defaultCode: 'WS_TICKET_FAILED',
      fallbackMessage: `WebSocket ticket failed: HTTP ${res.status}`,
    });
    const data = await res.json();
    url.searchParams.set('ticket', data.ticket);
    return url.toString();
  };
})();
