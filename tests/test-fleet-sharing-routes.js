'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { FleetSharingError } = require('../src/fleet-sharing');
const {
  MAX_PASSWORD_FAILURES,
  createFleetSharingRoutes,
} = require('../src/routes/fleet-sharing');

function appHarness() {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'delete', 'all']) {
    app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  }
  return { app, routes };
}

function response() {
  return {
    statusCode: 200, body: undefined, headers: {}, file: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    sendFile(file) { this.file = file; return this; },
  };
}

async function invoke(handler, options = {}) {
  const req = {
    params: options.params || {}, body: options.body || {}, protocol: options.protocol || 'https',
    ip: options.ip || '203.0.113.8', socket: {}, headers: options.headers || {},
    method: options.method || 'GET', originalUrl: options.originalUrl || '',
    get(name) {
      if (name === 'host') return options.host || 'multicc.example.test';
      if (name === 'x-forwarded-proto') return options.forwardedProto;
      if (name === 'content-type') return options.contentType;
      if (name === 'accept') return options.accept;
      return undefined;
    },
  };
  const res = response();
  await handler(req, res);
  return res;
}

function fakeSharing() {
  const calls = [];
  return {
    calls,
    createShare(id, body) {
      calls.push(['create', id, body]);
      return { token: `fleet_share_${'a'.repeat(32)}`, fleetId: id, remainingAccesses: 3 };
    },
    listShares(id) {
      calls.push(['list', id]);
      return [{ token: `fleet_share_${'b'.repeat(32)}`, fleetId: id, remainingAccesses: 2 }];
    },
    revokeShare(id, token) { calls.push(['revoke', id, token]); return token !== 'missing'; },
    accessSharedFleet(token, password) {
      calls.push(['access', token, password]);
      if (password !== 'password') throw new FleetSharingError('WRONG_PASSWORD', '密码错误', 403);
      return { schemaVersion: 1, instanceId: 'i', fleet: { id: 'f', name: 'Fleet', sessions: [] } };
    },
    readSharedFleet(token, grant) {
      calls.push(['state', token, grant]);
      return { schemaVersion: 1, instanceId: 'i', fleet: { id: 'f', name: 'Fleet', sessions: [] } };
    },
    authorizeWebSocket() { return true; },
    async importExternal(body) { calls.push(['import', body]); return { id: 'external-1', name: 'Remote' }; },
    listExternal() { calls.push(['external-list']); return [{ id: 'external-1', name: 'Remote' }]; },
    removeExternal(id) { calls.push(['external-remove', id]); return true; },
    async refreshExternal(id) { calls.push(['external-refresh', id]); return { id, name: 'Remote' }; },
    externalAuthority(id) { return { id, sourceFleetId: 'f', name: 'Remote', sourceOrigin: 'https://remote', sessions: [] }; },
    async proxyExternal() { return { status: 200, body: Buffer.from('{}'), contentType: 'application/json' }; },
    async issueExternalWsTicket() { return { ticket: 'remote-ticket', wsOrigin: 'wss://remote' }; },
  };
}

test('Fleet sharing routes mount the complete admin, public, and external surface', () => {
  const { app, routes } = appHarness();
  createFleetSharingRoutes({ sharing: fakeSharing(), pageFile: '/public/fleet-share.html' }).mount(app);
  assert.deepEqual([...routes.keys()], [
    'POST /api/fleets/:id/share',
    'GET /api/fleets/:id/shares',
    'DELETE /api/fleets/:id/share/:token',
    'GET /fleet-share/:token',
    'POST /api/fleet-shares/:token/import',
    'GET /api/fleet-shares/:token/state',
    'POST /api/fleet-shares/:token/ws-ticket',
    'POST /api/external-fleets/import',
    'GET /api/external-fleets',
    'DELETE /api/external-fleets/:id',
    'POST /api/external-fleets/:id/refresh',
    'POST /api/external-fleets/:id/ws-ticket',
    'ALL /api/external-fleets/:id/remote/*',
  ]);
});

test('admin create/list return canonical landing URLs and external endpoints preserve DTOs', async () => {
  const sharing = fakeSharing();
  const routes = createFleetSharingRoutes({ sharing, pageFile: '/public/fleet-share.html' }).handlers;
  let res = await invoke(routes.createShare, { params: { id: 'fleet-1' }, body: { password: 'password' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.url, `https://multicc.example.test/fleet-share/fleet_share_${'a'.repeat(32)}`);
  res = await invoke(routes.listShares, { params: { id: 'fleet-1' }, protocol: 'http', host: 'lan:3000' });
  assert.equal(res.body.shares[0].url, `http://lan:3000/fleet-share/fleet_share_${'b'.repeat(32)}`);
  res = await invoke(routes.listShares, { params: { id: 'fleet-1' }, protocol: 'http', host: 'funnel.test', forwardedProto: 'https' });
  assert.equal(res.body.shares[0].url, `https://funnel.test/fleet-share/fleet_share_${'b'.repeat(32)}`);

  res = await invoke(routes.importExternal, { body: { shareUrl: 'https://remote/fleet-share/x', password: 'password' } });
  assert.deepEqual(res.body, { ok: true, fleet: { id: 'external-1', name: 'Remote' } });
  res = await invoke(routes.listExternal);
  assert.deepEqual(res.body.fleets, [{ id: 'external-1', name: 'Remote' }]);
  res = await invoke(routes.removeExternal, { params: { id: 'external-1' } });
  assert.deepEqual(res.body, { ok: true });
  res = await invoke(routes.refreshExternal, { params: { id: 'external-1' } });
  assert.deepEqual(res.body, { ok: true, fleet: { id: 'external-1', name: 'Remote' } });
});

test('public Fleet capability requires its password, sets no-store, and rate-limits failures', async () => {
  const sharing = fakeSharing();
  const handlers = createFleetSharingRoutes({ sharing, pageFile: '/public/fleet-share.html' }).handlers;
  const token = `fleet_share_${'c'.repeat(32)}`;
  let res = await invoke(handlers.accessShare, { params: { token }, body: { password: 'password' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.fleet.name, 'Fleet');

  for (let i = 0; i < MAX_PASSWORD_FAILURES; i++) {
    res = await invoke(handlers.accessShare, { params: { token }, body: { password: 'wrong-password' } });
    assert.equal(res.statusCode, 403);
  }
  res = await invoke(handlers.accessShare, { params: { token }, body: { password: 'password' } });
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'SHARE_RATE_LIMITED');
});

test('Fleet state and WebSocket tickets keep the remote grant server-side and bind the session', async () => {
  const sharing = fakeSharing();
  const issued = [];
  const handlers = createFleetSharingRoutes({
    sharing,
    pageFile: '/public/fleet-share.html',
    issueWsTicket: (pathname, metadata) => {
      issued.push({ pathname, metadata });
      return { ticket: 'once-ticket', expiresAt: 123 };
    },
  }).handlers;
  const token = `fleet_share_${'d'.repeat(32)}`;
  let res = await invoke(handlers.readSharedFleet, {
    params: { token }, headers: { 'x-multicc-fleet-grant': 'random-grant' },
  });
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(sharing.calls.at(-1), ['state', token, 'random-grant']);

  res = await invoke(handlers.issueSharedWsTicket, {
    params: { token },
    headers: { 'x-multicc-fleet-grant': 'random-grant' },
    body: { pathname: '/ws/chat', sessionId: 'remote-session' },
    host: 'source.lan:3000', protocol: 'http',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.wsOrigin, 'ws://source.lan:3000');
  assert.deepEqual(issued, [{ pathname: '/ws/chat', metadata: { fleetSessionId: 'remote-session' } }]);
});

test('route errors expose stable public messages and hide unexpected exception details', async () => {
  const sharing = fakeSharing();
  const logged = [];
  sharing.createShare = () => { throw new Error('/private/path token=secret'); };
  const handlers = createFleetSharingRoutes({
    sharing, pageFile: '/public/fleet-share.html', logger: { error: (...args) => logged.push(args) },
  }).handlers;
  const res = await invoke(handlers.createShare, { params: { id: 'fleet-1' } });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { code: 'INTERNAL_ERROR', error: 'Fleet 分享操作失败' });
  assert.equal(JSON.stringify(res.body).includes('/private/path'), false);
  assert.equal(logged.length, 1);
});
