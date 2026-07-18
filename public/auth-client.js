'use strict';

// Exchange legacy `?token=` bootstrap links for an HttpOnly cookie, then keep
// credentials out of REST and WebSocket URLs. All same-origin fetches carry the
// bootstrap token as a header only until the exchange succeeds.
(function installMulticcAuthClient() {
  const params = new URLSearchParams(location.search);
  let bootstrapToken = params.get('token') || '';
  const nativeFetch = window.fetch.bind(window);

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

  function removeTokenFromAddress() {
    const clean = new URL(location.href);
    clean.searchParams.delete('token');
    history.replaceState(history.state, '', clean.pathname + clean.search + clean.hash);
  }

  const ready = bootstrapToken
    ? window.fetch('/api/auth/exchange', { method: 'POST', credentials: 'same-origin' })
      .then(res => {
        if (!res.ok) throw new Error(`auth exchange failed: HTTP ${res.status}`);
        removeTokenFromAddress();
        bootstrapToken = '';
      })
      .catch(err => { console.warn('[multicc/auth] bootstrap exchange failed', err.message); })
    : Promise.resolve();

  window.multiccAuthReady = ready;
  window.multiccWsUrl = async function multiccWsUrl(rawUrl) {
    await ready;
    const url = new URL(rawUrl, location.href);
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
