'use strict';
// Isolated transport fixture using the real Rust authentication owner. No user
// settings, providers, sessions, or external network requests are loaded.
const gateway = require('../../src/gateway-child');
const http = require('node:http');
const express = require('express');
const WebSocket = require('ws');
const auth = require('../../src/auth-security');
const { createAuthRuntime } = require('../../src/routes/auth');
const { isLocalRequest } = require('../../src/request-locality');
const { createErrorDto } = require('../../src/api-contract');
const { requestIdMiddleware, safeErrorHandler } = require('../../src/http-errors');
const security = auth.createAuthSecurity({ secret: 'fixture-token' });
gateway.connectAuthControl(security);
const app = express();
let sourceSharing;
let sourceSessions;
let sourceDirectories;
let failDirectoryRead = false;
let failMemberRead = false;
const hits = [];
app.use(requestIdMiddleware, require('../../src/http/json-compression').jsonCompression);
app.use((req, _res, next) => { hits.push(req.path); next(); });
// Explicit test-only control surface, never mounted by the product.
app.get('/fixture/state', (_req, res) => res.json({ pid: process.pid, hits, count: security.ticketCount(),
  capabilityLeaked: 'MULTICC_GATEWAY_AUTH_CAPABILITY' in process.env || 'MULTICC_GATEWAY_SOURCE_CAPABILITY' in process.env,
  sessions: sourceSessions ? [...sourceSessions.values()] : undefined }));
app.post('/fixture/session', express.json(), (req, res) => {
  if (req.body.opaqueCycle) {
    req.body.privateReference = req.body;
    Object.defineProperty(req.body, 'privateGetter', { enumerable: true, get() { throw new Error('private field must not be read'); } });
  }
  if (req.body.id) sourceSessions.set(req.body.id, req.body);
  failMemberRead = req.body.fail === true;
  res.json({ ok: true });
});
app.post('/fixture/directory', express.json(), (req, res) => {
  if (req.body.remove) sourceDirectories.delete(req.body.id);
  else if (req.body.id) sourceDirectories.set(req.body.id, req.body);
  failDirectoryRead = req.body.fail === true;
  res.json({ ok: true });
});
app.post('/fixture/rotate', express.text(), (req, res) => { security.setAccessToken(req.body); res.end('ok'); });
app.post('/fixture/shutdown', (req, res) => { security.setShuttingDown(true); res.end('ok'); });
app.post('/fixture/crash', (req, res) => { res.end('ok'); setTimeout(() => process.exit(1), 20); });
app.post('/fixture/issue', (_req, res) => res.json(security.issueWsTicket('/ws/test', { source: 'host' })));
app.post('/fixture/consume', express.json(), (req, res) => res.json(security.consumeWsTicket(req.body.ticket, req.body.path)));
const serviceFixture = process.env.MULTICC_TEST_SERVICE_ROUTES === '1' && !gateway.isGatewayChild();
const legacyServices = serviceFixture ? require('./legacy-service-routes').createServiceRoutes({
  file: require('node:path').join(process.env.MULTICC_DATA_DIR, 'service-routes.json'),
  authenticate: req => runtime.isAuthenticated(req),
}) : null;
const factory = serviceFixture ? require('./legacy-http-entry').createAuthRuntime : createAuthRuntime;
const runtime = factory({ express, authSecurity: security, isLocalRequest,
  authorizeScopedRequest: req => sourceSharing?.authorizeRequest({
    token: req.headers['x-multicc-fleet-token'], grant: req.headers['x-multicc-fleet-grant'],
    method: req.method, pathname: req.originalUrl,
  }) === true,
  handleServiceRequest: legacyServices?.handleHttp,
  allowLegacyTokenQuery: process.env.MULTICC_ALLOW_LEGACY_TOKEN_QUERY === '1',
  parseCookies: header => Object.fromEntries(String(header || '').split(';').filter(Boolean).map(p => {
    const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  })), normalizeRedirect: auth.normalizeRedirect, escapeHtmlAttribute: auth.escapeHtmlAttribute,
  createErrorDto, metrics: { inc() {} }, logger: { warn() {} },
  getAccessToken: () => security.accessToken(), getShuttingDown: () => security.shuttingDown(),
});
runtime.mountRoutes(app);
app.use(express.json({ limit: '50mb' }));
legacyServices?.mountManagement(app);
if (process.env.MULTICC_TEST_SOURCE_ROUTES === '1') {
  const path = require('node:path');
  const context = JSON.parse(require('node:fs').readFileSync(path.join(process.env.MULTICC_DATA_DIR, 'source-context.json')));
  const directories = sourceDirectories = new Map(context.directories.map(d => [d.id, d]));
  const readDirectory = directories.get.bind(directories);
  directories.get = id => { if (failDirectoryRead) throw new Error('/private/source host getter failed'); return readDirectory(id); };
  sourceSessions = new Map(context.sessions.map(s => [s.id, s]));
  const readMembers = sourceSessions.values.bind(sourceSessions);
  sourceSessions.values = () => { if (failMemberRead) throw new Error('/private/member getter failed'); return readMembers(); };
  sourceSharing = gateway.isGatewayChild() ? require('../../src/fleet-sharing').createFleetSharing({
    sharesFile: path.join(process.env.MULTICC_DATA_DIR, 'fleet-shares.json'),
    getDirectory: id => directories.get(id),
    listSessions: id => [...sourceSessions.values()].filter(session => session.dirId === id && session.type !== 'aux'),
    authSecurity: security,
  }) : require('./legacy-workspace-routes').mountFleetSharingRoutes(app, {
    paths: require('../../src/paths').createPaths({ dataDir: process.env.MULTICC_DATA_DIR }),
    directories, sessions: sourceSessions, pageFile: path.join(process.env.MULTICC_TEST_PACKAGE_ROOT, 'public/fleet-share.html'),
    logger: { error() {} }, authSecurity: security, issueWsTicket: (p, m) => security.issueWsTicket(p, m),
  }).sharing;
  app.patch('/api/sessions/:id', (req, res) => {
    const current = sourceSessions.get(req.params.id);
    if (!current) return res.status(404).json({ error: 'Session not found' });
    const updated = { ...current, label: String(req.body.label || current.label) };
    sourceSessions.set(req.params.id, updated); res.json(updated);
  });
  app.post('/api/directories/:id/sessions', (req, res) => {
    const id = `remote-created-${sourceSessions.size + 1}`;
    const created = { id, dirId: req.params.id, label: String(req.body.label || id), cli: 'codex', kind: 'chat' };
    sourceSessions.set(id, created); res.json(created);
  });
  app.get('/api/git/log', (req, res) => res.json({ dirId: req.query.dirId, commits: [] }));
}
if (process.env.MULTICC_TEST_EXTERNAL_ROUTES === '1' && process.env.MULTICC_TEST_SOURCE_ROUTES !== '1' && !gateway.isGatewayChild()) {
  require('./legacy-workspace-routes').mountFleetSharingRoutes(app, {
    paths: require('../../src/paths').createPaths({ dataDir: process.env.MULTICC_DATA_DIR }),
    directories: new Map(), sessions: new Map(), pageFile: __filename, logger: { error() {} },
  });
}
app.use(safeErrorHandler({ error() {} }));
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (legacyServices?.handleUpgrade(req, socket, head)) return;
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const metadata = security.consumeWsTicket(url.searchParams.get('ws_ticket'), url.pathname);
  if (!metadata) return ws.close(4003, 'denied');
  ws.send(JSON.stringify(metadata)); ws.close(1000);
});
process.on('SIGINT', () => { wss.close(); server.close(); setTimeout(() => process.exit(0), 20); });
gateway.watchGatewayLifeline();
if (gateway.isGatewayChild()) gateway.listenBehindGateway(server, { port: gateway.internalPort() });
else server.listen(Number(process.env.PORT), '127.0.0.1');
