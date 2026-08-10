'use strict';

// Reverse-proxy the loopback-only Qwen voice child through this server.
//
// The child (qwen-audio-agent) binds 127.0.0.1:<port>, so the launch URL the
// control plane used to hand out only ever opened on this machine — a phone
// running the app saw 127.0.0.1 point at itself. The child's web client is
// fully subpath-safe (relative fetches like `api/health`, a WebSocket URL built
// from location.pathname, `./assets/...`), so mounting it under a path prefix
// on this server works as-is: the page, its /api/* calls, the SSE task stream
// and the /api/realtime WebSocket all flow through the same port the client
// already uses for chat (the app's configured base URL — LAN or Tailscale
// Funnel).
//
// Two header rules keep the child's own security model intact:
//   - Host is rewritten to the child's loopback authority, and
//   - Origin/Referer are stripped,
// so the child's enforceSameOrigin sees exactly what it sees for a local
// browser (a loopback Host, no Origin) and does not need an allowlist entry.

const http = require('http');

const PROXY_PREFIX = '/voice-gateway/web';

function createVoiceGatewayWebProxy({ runtime, log = console } = {}) {
  if (!runtime || typeof runtime.statusGlobal !== 'function') {
    throw new TypeError('voice web proxy requires the qwen audio supervisor');
  }

  function childTarget() {
    const status = runtime.statusGlobal();
    const raw = status && status.url;
    if (!raw) return null;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:') return null;
      return { hostname: url.hostname, port: Number(url.port) };
    } catch (_) {
      return null;
    }
  }

  // /voice-gateway/web[/...]?query → /[...]?query (express already strips the
  // mount prefix for HTTP handlers; the raw upgrade path needs it stripped).
  function stripPrefix(url) {
    const rest = String(url || '').slice(PROXY_PREFIX.length) || '/';
    return rest.startsWith('/') ? rest : `/${rest}`;
  }

  function childHeaders(req, target) {
    const headers = { ...req.headers };
    delete headers.origin;
    delete headers.referer;
    headers.host = `${target.hostname}:${target.port}`;
    return headers;
  }

  function mountRoutes(app) {
    app.use(PROXY_PREFIX, (req, res) => {
      const target = childTarget();
      if (!target) {
        res.status(503).json({ ok: false, error: 'voice_gateway_not_running' });
        return;
      }
      // Inside app.use(PREFIX) req.url is already prefix-stripped and keeps the
      // query string — forward it verbatim.
      const headers = childHeaders(req, target);
      // express.json runs before this mount and consumes JSON bodies, leaving a
      // drained stream whose Content-Length the child would still wait on.
      // Re-serialize a parsed body; pipe everything else verbatim.
      let parsedBody = null;
      if (req.body != null && typeof req.body === 'object') {
        parsedBody = JSON.stringify(req.body);
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(parsedBody);
      }
      const proxyReq = http.request({
        hostname: target.hostname,
        port: target.port,
        path: req.url,
        method: req.method,
        headers,
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (err) => {
        log.warn?.('[multicc/voice] web proxy error', { error: err?.message });
        if (!res.headersSent) {
          res.status(502).json({ ok: false, error: 'voice_proxy_unreachable' });
        } else {
          res.end();
        }
      });
      if (parsedBody != null) proxyReq.end(parsedBody);
      else req.pipe(proxyReq);
    });
  }

  // WS upgrade for `<PREFIX>/api/realtime` (and any future child socket). The
  // main chat wss is configured with shouldHandle() to skip this prefix, so
  // this handler is the only one that answers the upgrade.
  function handleUpgrade(req, socket, head) {
    const target = childTarget();
    if (!target) {
      socket.destroy();
      return;
    }
    const proxyReq = http.request({
      hostname: target.hostname,
      port: target.port,
      path: stripPrefix(req.url),
      method: 'GET',
      headers: childHeaders(req, target),
    });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      let responseHead = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
      for (const [name, value] of Object.entries(proxyRes.headers)) {
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) responseHead += `${name}: ${v}\r\n`;
      }
      responseHead += '\r\n';
      socket.write(responseHead);
      if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
      if (head && head.length) socket.unshift(head);
      proxySocket.on('error', () => socket.destroy());
      socket.on('error', () => proxySocket.destroy());
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxyReq.on('response', (proxyRes) => {
      // The child refused the upgrade (403/401/…): relay its plain response so
      // the browser shows the real reason instead of a dead socket.
      let responseHead = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
      for (const [name, value] of Object.entries(proxyRes.headers)) {
        if (name.toLowerCase() === 'transfer-encoding') continue;
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) responseHead += `${name}: ${v}\r\n`;
      }
      responseHead += 'connection: close\r\n\r\n';
      socket.write(responseHead);
      proxyRes.pipe(socket);
      proxyRes.on('end', () => socket.end());
    });
    proxyReq.on('error', () => socket.destroy());
    socket.on('error', () => proxyReq.destroy());
    proxyReq.end();
  }

  return Object.freeze({ PREFIX: PROXY_PREFIX, mountRoutes, handleUpgrade });
}

// Install the single HTTP 'upgrade' dispatcher. The chat wss is created in
// noServer mode, so nothing else listens for 'upgrade'; this routes the voice
// child's realtime socket to the proxy and every other upgrade to the chat wss
// (emitting 'connection' exactly as ws's auto-server mode did).
function wireUpgrade(server, wss, webProxy) {
  if (!server || typeof server.on !== 'function') return;
  server.on('upgrade', (req, socket, head) => {
    if (webProxy && (req.url || '').startsWith(webProxy.PREFIX)) {
      webProxy.handleUpgrade(req, socket, head);
      return;
    }
    if (wss && typeof wss.handleUpgrade === 'function') {
      wss.handleUpgrade(req, socket, head, (ws, req2) => wss.emit('connection', ws, req2));
    }
  });
}

module.exports = {
  PROXY_PREFIX,
  createVoiceGatewayWebProxy,
  wireUpgrade,
};
