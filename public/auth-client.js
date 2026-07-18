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

  window.fetch = function authenticatedFetch(input, init) {
    const options = { ...(init || {}) };
    if (bootstrapToken && isSameOrigin(input)) {
      const source = input instanceof Request ? input.headers : undefined;
      const headers = new Headers(source || options.headers || {});
      if (!headers.has('X-Access-Token')) headers.set('X-Access-Token', bootstrapToken);
      options.headers = headers;
    }
    return nativeFetch(input, options);
  };

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
    const res = await window.fetch('/api/auth/ws-ticket', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: url.pathname }),
    });
    if (!res.ok) throw new Error(`WebSocket ticket failed: HTTP ${res.status}`);
    const data = await res.json();
    url.searchParams.set('ticket', data.ticket);
    return url.toString();
  };
})();
