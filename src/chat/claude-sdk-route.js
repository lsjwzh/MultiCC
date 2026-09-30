'use strict';

const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');

// CPR capabilities rotate at every attempt. Keep the SDK's local endpoint
// stable, but retain CPR's exact authorization and accounting on every request.
// Direct/official non-proxy routes do not need this relay.
function managedRoute(env = {}) {
  try {
    const url = new URL(env.ANTHROPIC_BASE_URL);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
        || url.username || url.password || url.search || url.hash
        || !/^\/claude-proxy\/[^/]+\/[^/]+\/?$/.test(url.pathname)) return null;
    url.pathname = url.pathname.replace(/\/$/, '');
    return { url, token: env.ANTHROPIC_AUTH_TOKEN || '',
      identity: url.origin + url.pathname.slice(0, url.pathname.lastIndexOf('/')) };
  } catch (_) { return null; }
}

function headersWithoutHop(headers) {
  const copy = { ...headers };
  const named = String(copy.connection || '').split(',').map(s => s.trim().toLowerCase());
  for (const key of [...named, 'connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']) delete copy[key];
  return copy;
}

async function createRouteRelay() {
  const token = randomBytes(32).toString('hex');
  let target = null, closed = false;
  const active = new Set();
  const waiters = new Set();
  const server = http.createServer((req, res) => {
    const auth = Buffer.from(String(req.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.writeHead(401); res.end(); return;
    }
    if (req.method !== 'POST' || !/^\/v1\/messages(?:\/count_tokens)?(?:\?[^#]*)?$/.test(req.url)) {
      res.writeHead(404); res.end(); return;
    }
    // Snapshot before reading any body. bind() cannot move active producers.
    const route = target;
    if (closed || !route) { res.writeHead(503); res.end(); return; }
    const headers = headersWithoutHop(req.headers);
    delete headers['x-api-key'];
    headers.authorization = `Bearer ${route.token}`;
    const upstream = http.request(route.url.origin + route.url.pathname + req.url,
      { method: 'POST', headers }, response => {
        res.writeHead(response.statusCode, headersWithoutHop(response.headers));
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
    const entry = { upstream, res };
    active.add(entry);
    const finish = () => {
      upstream.destroy();
      active.delete(entry);
      if (!active.size) for (const done of [...waiters]) done();
    };
    res.once('close', finish);
    req.once('aborted', () => res.destroy());
    req.once('error', () => res.destroy());
    upstream.once('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  function drain(timeoutMs = 5000) {
    if (!active.size) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); waiters.delete(finish); resolve(); };
      const timer = setTimeout(() => {
        waiters.delete(finish);
        reject(Object.assign(new Error('SDK route still has active requests'), { code: 'SDK_ROUTE_BUSY' }));
      }, timeoutMs);
      waiters.add(finish);
    });
  }
  return {
    env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_API_KEY: '' },
    bind(env) {
      if (closed || active.size) throw Object.assign(new Error('SDK route is not idle'), { code: 'SDK_ROUTE_BUSY' });
      const next = managedRoute(env);
      if (!next || !next.token) throw new Error('Invalid managed SDK route');
      target = next;
    },
    drain,
    abort() { for (const { upstream, res } of active) { upstream.destroy(); res.destroy(); } },
    async close() {
      if (closed) return;
      closed = true; target = null;
      this.abort();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { managedRoute, createRouteRelay };
