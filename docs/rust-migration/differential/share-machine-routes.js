'use strict';

// Differential run for the 21 sharing / machines / workspaces routes retired
// from `src/machines.js`, `src/routes/share.js` and `src/routes/workspaces.js`:
//
//   GET|HEAD|POST /api/machines
//   GET|HEAD      /api/machines/self, /api/machines/grants
//   POST          /api/machines/pair, /api/machines/:machineId/ws-ticket
//   DELETE        /api/machines/connection, /api/machines/grants/:grantId
//   PATCH|DELETE  /api/machines/:machineId
//   POST          /api/sessions/:id/share, /api/sessions/:id/share-messages
//   GET|HEAD      /api/sessions/:id/shares
//   DELETE        /api/sessions/:id/share/:token
//   GET|HEAD      /share/:token
//   POST          /api/share/:token/auth
//   GET|HEAD      /api/share/:token/{entry,history,session}
//   GET|HEAD      /api/workspaces/overview, POST /api/workspaces/sweep
//
// now answered by native/gateway/src/app/share_machine_routes.rs (rules in
// native/core/src/share_machine_routes.rs).
//
//   node docs/rust-migration/differential/share-machine-routes.js <repo> <multicc-gateway> <addon>
//
// The Node side mounts the frozen retired layers
// (tests/helpers/legacy-share-machine-routes/{machines,share,workspaces}.js)
// over a scripted world (…/world.js). The Rust front door calls its host port
// (/api/__host/share-machines); the stub Node child mounts the live
// src/routes/share-machines-host.js over the same world, so both sides read one
// set of facts and the comparison covers the split itself: path matching,
// `:param` decoding, the query subset, the relayed request headers, the body
// each `express.json` mount produced, the automatic OPTIONS union, the public
// share-surface exemption, the cross-site machine guard and the response
// envelope — while the machine registry, the grant store, the share store and
// its password cookies, the workspace scan/sweep and the versioned-HTML writer
// stay in Node.
//
// Two areas are compared deliberately, not incidentally:
//
//  * Scoped authorization. `POST /api/machines/pair` mints a grant; the next
//    `DELETE /api/machines/connection` carries that credential. The front door
//    resolves it from `gw-data/machines.json` (the file its own Node child
//    wrote) before the request reaches the host port, and Node re-resolves the
//    same credential — so the case fails if either side lost the scoped check.
//  * The desensitization canaries below reject any body that leaks a durable
//    pairing credential (`mcg_…`), a share password hash/salt/secret, or a
//    transcript on the public page — on both sides, before normalization.
//
// A remote machine is a loopback stub (`SHARE_STUB_PORT`): `/api/machines/self`,
// `/api/machines/pair`, `/api/auth/ws-ticket` and `DELETE /api/machines/connection`
// answer with fixed identities, so add/ws-ticket/remove run end to end without
// touching any real computer.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { main, send, waitForFixture } = require('./lib');

const L = { Host: 'localhost', 'X-Request-Id': 'diff-share-1' };
// Both sides stamp share records from the event loop clock; the two processes
// are the only clock either side has, so the run freezes it.
const FROZEN_NOW = 1794687600000;

// The stub remote machine's fixed identities (valid `machine_` + 48 hex).
const PEER_ID = `machine_${'b'.repeat(48)}`;
const PEER_GRANT = `mcg_${'c'.repeat(48)}`;
const PEER_GRANT_ID = `grant_${'d'.repeat(48)}`;

let worldPath = '';
let pagePath = '';
let buildWorld = null;
let frozen = null;
let setOracle = null;
let stubPort = 0;
let upstreamText = '';
const rawChecks = [];
const problems = [];

const SESSIONS = [
  { id: 's1', label: 'Demo session', cli: 'claude', type: 'chat' },
  { id: 's2', label: 'Second session', cli: 'codex', type: 'chat' },
  { id: 'slot', label: 'System slot', cli: 'claude', type: 'aux' },
];
const HISTORY = [
  { id: 'm0', role: 'user', content: 'first question', ts: 1 },
  { id: 'm1', role: 'assistant', content: 'first answer', ts: 2 },
  { id: 'm2', role: 'user', content: 'second question', ts: 3 },
];

function baseScenario() {
  return {
    sessions: SESSIONS,
    history: HISTORY.map(message => ({ ...message })),
    page: {
      messages: [{ id: 'm2', role: 'user', content: 'second question' }],
      hasMore: true, found: true, hasNewer: false,
    },
    chatPageFile: pagePath,
  };
}

// ── corpus plumbing ─────────────────────────────────────────────────────────

const pending = [];
let counter = 0;

function secretsOf(text) {
  const found = [];
  for (const match of text.matchAll(/"(?:token|grant|grantId|id)":"([A-Za-z0-9_-]{20,})"/g)) {
    found.push(match[1]);
  }
  for (const match of text.matchAll(/multicc_share_([A-Za-z0-9_-]{20,})=([0-9a-f]{64})/g)) {
    found.push(match[1], match[2]);
  }
  for (const match of text.matchAll(/"ticket":"([A-Za-z0-9_-]{16,})"/g)) {
    found.push(match[1]);
  }
  return found;
}

/** The one value a case hands out and later cases reuse (a token, an id). */
function pick(text, pattern) {
  const found = new RegExp(pattern).exec(text);
  return found ? found[1] : undefined;
}

function add(name, buildRequest, scenario, extra = {}) {
  counter += 1;
  const body = typeof scenario === 'function' ? scenario(counter) : (scenario || baseScenario());
  const hooks = {
    before(side) {
      if (side.name === 'node') setOracle(body);
      else fs.writeFileSync(worldPath, JSON.stringify(body));
    },
    capture(response, side) {
      if (!Array.isArray(side.state.secrets)) side.state.secrets = [];
      const text = response.body.toString('utf8');
      const cookies = String(response.headers['set-cookie'] || '');
      for (const secret of [...secretsOf(text), ...secretsOf(cookies)]) {
        if (!side.state.secrets.includes(secret)) side.state.secrets.push(secret);
      }
      if (extra.assign) Object.assign(side.state, extra.assign(text, response) || {});
      if (extra.rawCheck) extra.rawCheck(text);
    },
    normalize(view, side) {
      if (!Array.isArray(side.state.secrets)) side.state.secrets = [];
      const original = view.body;
      let body = original;
      for (const secret of side.state.secrets) body = body.split(secret).join('<secret>');
      view.body = body;
      for (const [header, value] of Object.entries(view.headers)) {
        let next = value;
        for (const secret of side.state.secrets) next = next.split(secret).join('<secret>');
        view.headers[header] = next;
      }
      // A body that carried a per-side secret also has a per-side ETag/length.
      if (body !== original) {
        if (view.headers.etag) view.headers.etag = '<etag>';
        if (view.headers['content-length']) view.headers['content-length'] = '<len>';
      }
      if (extra.normalize) return extra.normalize(view, side) || view;
      return view;
    },
  };
  if (extra.send) hooks.send = extra.send;
  pending.push([name, buildRequest, hooks]);
}

function corpus() {
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const del = (url, headers = L) => ({ method: 'DELETE', url, headers });
  const options = (url, headers = L) => ({ method: 'OPTIONS', url, headers });
  const json = { ...L, 'Content-Type': 'application/json' };
  const post = (url, body, headers = json) => ({ method: 'POST', url, headers, body: JSON.stringify(body) });
  const patch = (url, body, headers = json) => ({ method: 'PATCH', url, headers, body: JSON.stringify(body) });
  const selfId = side => (side.state.selfId || '<self>');
  const peerId = side => (side.state.peer || '<peer>');
  const grant = side => (side.state.grant || '<grant>');
  const token = (side, key) => (side.state[key] || '<token>');

  // ── machines ──────────────────────────────────────────────────────────────
  add('machines list', () => get('/api/machines'));
  add('machines self', () => get('/api/machines/self'), null, {
    assign: text => ({ selfId: pick(text, '"id":"(machine_[0-9a-f]{48})"') }),
  });
  add('machines self HEAD', () => head('/api/machines/self'), null, {
    // HEAD has no body to scrub, yet its ETag still hashes the per-side
    // registry document, so it is not an observable difference.
    normalize: view => ({
      ...view,
      headers: { ...view.headers, etag: '<etag>', 'content-length': '<len>' },
    }),
  });
  add('machines grants empty', () => get('/api/machines/grants'));
  add('pair with the access password', () => post('/api/machines/pair',
    { ownerId: 'machine_peer', name: 'Peer' }, { ...json, 'X-Access-Token': 'secret-token-1' }), null, {
    assign: text => ({
      grant: pick(text, '"grant":"(mcg_[0-9a-f]{48})"'),
      grantId: pick(text, '"grantId":"(grant_[0-9a-f]{48})"'),
    }),
  });
  add('pair with a wrong password', () => post('/api/machines/pair',
    { ownerId: 'machine_peer' }, { ...json, 'X-Access-Token': 'wrong' }));
  add('pair refuses the local identity', side => post('/api/machines/pair',
    { ownerId: selfId(side) }, { ...json, 'X-Access-Token': 'secret-token-1' }));
  add('grants list after pairing', () => get('/api/machines/grants'));
  add('rename the local machine', () => patch('/api/machines/self', { name: 'Renamed' }));
  add('rename an unknown machine', () => patch('/api/machines/machine_ghost', { name: 'X' }));
  add('remove an unknown machine', () => del('/api/machines/machine_ghost'));
  add('ws-ticket without a peer', () => post('/api/machines/machine_ghost/ws-ticket', { path: '/api/status' }));
  add('cross-site machine read', () => get('/api/machines', { ...L, 'Sec-Fetch-Site': 'cross-site' }));
  add('cross-site machine OPTIONS', () => options('/api/machines/connection', { ...L, 'Sec-Fetch-Site': 'cross-site' }));
  add('add a remote machine', () => post('/api/machines', {
    origin: `http://127.0.0.1:${stubPort}`, name: 'Peer', password: 'peer-pass',
  }), null, {
    assign: text => ({ peer: pick(text, '"id":"(machine_[0-9a-f]{48})"') }),
  });
  add('machines list with a peer', () => get('/api/machines'));
  add('rename the peer', side => patch(`/api/machines/${peerId(side)}`, { name: 'Peer 2' }));
  add('ws-ticket through the peer', side => post(`/api/machines/${peerId(side)}/ws-ticket`, { path: '/ws/chat' }));
  add('remove the peer', side => del(`/api/machines/${peerId(side)}`));
  add('machines list after removal', () => get('/api/machines'));
  add('connection delete with the scoped grant', side => del('/api/machines/connection', {
    ...L, 'X-Multicc-Machine-Grant': grant(side),
  }));
  add('connection delete without a grant', () => del('/api/machines/connection'));
  add('revoke an unknown grant', () => del('/api/machines/grants/grant_ghost'));

  // ── share ─────────────────────────────────────────────────────────────────
  add('create a public share', () => post('/api/sessions/s1/share', { label: 'Handoff' }), null, {
    assign: text => ({ public: pick(text, '"token":"([A-Za-z0-9_-]{24})"') }),
    rawCheck: text => {
      if (/pwHash|"salt"|"secret"/.test(text)) problems.push('share create leaked a secret field');
    },
  });
  add('create a password share', () => post('/api/sessions/s1/share',
    { password: 'share-pass', access: 'operate', label: 'Locked' }), null, {
    assign: text => ({ locked: pick(text, '"token":"([A-Za-z0-9_-]{24})"') }),
  });
  add('create a share with an explicit base url', () => post('/api/sessions/s1/share', {
    publicBaseUrl: 'https://share.example.com', label: 'Tunnelled',
  }));
  add('create a share with an invalid base url', () => post('/api/sessions/s1/share', {
    publicBaseUrl: 'ftp://share.example.com',
  }));
  add('create a share for an unknown session', () => post('/api/sessions/ghost/share', {}));
  add('create a share for a system session', () => post('/api/sessions/slot/share', {}));
  add('create a share for another session', () => post('/api/sessions/s2/share', { label: 'Other' }), null, {
    assign: text => ({ other: pick(text, '"token":"([A-Za-z0-9_-]{24})"') }),
  });
  add('create a message snapshot', () => post('/api/sessions/s1/share-messages',
    { indices: [0, 2], label: 'Snapshot' }), null, {
    assign: text => ({ message: pick(text, '"token":"([A-Za-z0-9_-]{24})"') }),
  });
  add('create a snapshot with no messages', () => post('/api/sessions/s1/share-messages', { indices: [99] }));
  add('list one session share', () => get('/api/sessions/s1/shares'));
  add('public entry of a public share', side => get(`/api/share/${token(side, 'public')}/entry`), null, {
    rawCheck: text => {
      if (/pwHash|"salt"|"secret"/.test(text)) problems.push('share entry leaked a secret field');
    },
  });
  add('entry without the password cookie', side => get(`/api/share/${token(side, 'locked')}/entry`));
  add('auth with a wrong password', side => post(`/api/share/${token(side, 'locked')}/auth`, { password: 'nope' }));
  add('auth with the right password', side => post(`/api/share/${token(side, 'locked')}/auth`,
    { password: 'share-pass' }), null, {
    assign: (text, response) => {
      const cookie = String(response.headers['set-cookie'] || '');
      const found = /multicc_share_([A-Za-z0-9_-]{20,})=([0-9a-f]{64})/.exec(cookie);
      return { cookie: found ? found[2] : undefined, cookieName: found ? found[1] : undefined };
    },
  });
  add('entry with the password cookie', side => get(`/api/share/${token(side, 'locked')}/entry`, {
    ...L, Cookie: `multicc_share_${token(side, 'locked')}=${side.state.cookie || '<sig>'}`,
  }));
  add('history of a shared session', side => get(
    `/api/share/${token(side, 'public')}/history?before=10&around=m2&limit=5`,
  ));
  add('history of a snapshot', side => get(`/api/share/${token(side, 'message')}/history`));
  add('entry of a snapshot', side => get(`/api/share/${token(side, 'message')}/entry`));
  add('full session read of a share', side => get(`/api/share/${token(side, 'public')}/session`));
  add('the public share page', side => get(`/share/${token(side, 'public')}`), null, {
    rawCheck: text => {
      if (text.includes('first question')) problems.push('the public page leaked the transcript');
    },
  });
  add('the public share page HEAD', side => head(`/share/${token(side, 'public')}`));
  add('revoke a share of another session', side => del(`/api/sessions/s1/share/${token(side, 'other')}`));
  add('revoke the public share', side => del(`/api/sessions/s1/share/${token(side, 'public')}`));
  add('entry of a revoked share', side => get(`/api/share/${token(side, 'public')}/entry`));
  add('revoke an unknown share', () => del('/api/sessions/s1/share/unknown-token'));

  // ── workspaces ────────────────────────────────────────────────────────────
  add('workspace overview, empty world', () => get('/api/workspaces/overview'));
  add('workspace overview, scripted world', () => get('/api/workspaces/overview'), () => ({
    ...baseScenario(),
    directories: {
      d1: { id: 'd1', path: '/tmp/work-a' },
      d2: { id: 'd2', path: '/tmp/work-b' },
    },
    records: {
      a: { id: 'a', dirId: 'd1', kind: 'chat', title: 'A', workspaceState: 'awake' },
      b: { id: 'b', dirId: 'd1', kind: 'chat', title: 'B', workspaceState: 'hibernated' },
      c: { id: 'c', dirId: 'd2', kind: 'chat', title: 'C', workspaceState: 'planned' },
      d: { id: 'd', dirId: 'd2', kind: 'chat', title: 'D', workspaceState: 'transitioning' },
      e: { id: 'e', dirId: 'd2', kind: 'task', title: 'not a chat' },
      f: {
        id: 'f', dirId: 'd1', kind: 'chat', title: 'F',
        hibernateRemovedIgnored: { at: '2026-11-01T00:00:00.000Z', entries: ['x', 'y'] },
      },
      g: {
        id: 'g', dirId: 'd1', kind: 'chat', title: 'G',
        hibernateRemovedIgnored: { at: '2026-11-02T00:00:00.000Z', entries: ['z'] },
      },
    },
    hibernation: { status: { running: true, budget: 3 }, sweep: { hibernated: 1 } },
    orphan: { report: { scannedAt: 'x', orphans: [] }, scan: { orphans: [{ path: '/tmp/orphan' }] } },
  }));
  add('workspace sweep without a runtime', () => post('/api/workspaces/sweep', {}));
  add('workspace sweep with orphans', () => post('/api/workspaces/sweep?orphans=1', {}), () => ({
    ...baseScenario(),
    hibernation: { status: { running: true }, sweep: { hibernated: 2 } },
    orphan: { scan: { orphans: [{ path: '/tmp/orphan-2' }] } },
  }));
  add('workspace sweep that throws', () => post('/api/workspaces/sweep', {}), () => ({
    ...baseScenario(),
    hibernation: { throw: true },
  }));
  add('workspace OPTIONS union', () => options('/api/workspaces/overview'));

  // ── automatic OPTIONS ─────────────────────────────────────────────────────
  // Express answers from every layer whose path matches, so a `:param` layer
  // widens the literal paths on that segment. These are the measured values.
  add('OPTIONS /api/machines', () => options('/api/machines'));
  add('OPTIONS /api/machines/self', () => options('/api/machines/self'));
  add('OPTIONS /api/machines/pair', () => options('/api/machines/pair'));
  add('OPTIONS /api/machines/connection', () => options('/api/machines/connection'));
  add('OPTIONS /api/machines/grants', () => options('/api/machines/grants'));
  add('OPTIONS /api/machines/grants/ws-ticket', () => options('/api/machines/grants/ws-ticket'));
  add('OPTIONS /api/sessions/s1/share', () => options('/api/sessions/s1/share'));
  add('OPTIONS /api/sessions/s1/shares', () => options('/api/sessions/s1/shares'));
  add('OPTIONS /api/share/t1/entry', () => options('/api/share/t1/entry'));
  add('OPTIONS /share/t1', () => options('/share/t1'));
  add('OPTIONS /api/workspaces/overview', () => options('/api/workspaces/overview'));
  add('OPTIONS /api/workspaces/sweep', () => options('/api/workspaces/sweep'));

  return pending;
}

// ── the oracle's inner app ──────────────────────────────────────────────────

function mountOracle(app, { repo, work, dataRoot }) {
  // The share store reads MULTICC_DATA_DIR when it loads; nothing earlier in
  // the pipeline requires it, so this is the side's own root.
  process.env.MULTICC_DATA_DIR = dataRoot;
  Date.now = () => FROZEN_NOW;
  const express = require(require.resolve('express', { paths: [repo] }));
  const { createAuthSecurity } = require(path.join(repo, 'src/auth-security'));
  const authSecurity = createAuthSecurity({ getSecret: () => 'secret-token-1' });
  const { getNative } = require(path.join(repo, 'src/native/binding'));
  const legacy = name => path.join(repo, 'tests/helpers/legacy-share-machine-routes', name);
  frozen = {
    machines: require(legacy('machines')),
    share: require(legacy('share')),
    workspaces: require(legacy('workspaces')),
  };
  buildWorld = require(legacy('world')).buildWorld;
  const publicDir = path.join(work, 'gw', 'public');
  fs.mkdirSync(publicDir);
  pagePath = path.join(publicDir, 'chat.html');
  fs.writeFileSync(path.join(publicDir, 'chat.css'), 'body{}');
  fs.writeFileSync(pagePath, '<html><head><link href="chat.css"></head><body>chat</body></html>');
  setOracle = (scenario) => {
    const inner = express();
    const world = buildWorld({
      dataRoot, scenario, express, authSecurity,
      machinesModule: frozen.machines, repo,
    });
    // server.js mounts the machines layer before the global parser, and its
    // auth gate sets `req.machineGrantId` from the same kernel the handler
    // reads. Both are reproduced here so the oracle matches the retired app.
    inner.use((req, _res, next) => {
      const credential = req.headers['x-multicc-machine-grant'];
      if (credential) {
        try { req.machineGrantId = getNative().authorizeMachineRequest(dataRoot, credential, req.method, req.originalUrl); }
        catch (_) { /* unauthorized */ }
      }
      next();
    });
    world.machines.mount(inner, express);
    inner.use(express.json({ limit: '50mb' }));
    frozen.share.mountShareRoutes(inner, world.share);
    frozen.workspaces.mountWorkspaceRoutes(inner, world.workspaces);
    current = inner;
  };
  let current = null;
  app.use((req, res, next) => (current ? current(req, res, next) : next()));
  setOracle(baseScenario());
  worldPath = path.join(work, 'share-world.json');
  fs.writeFileSync(worldPath, JSON.stringify(baseScenario()));
  upstreamText = upstreamSource(repo);
}

// ── the gateway's stub child ────────────────────────────────────────────────

function upstreamSource(repo) {
  return `'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const REPO = ${JSON.stringify(repo)};
const { createAuthSecurity } = require(path.join(REPO, 'src/auth-security'));
const { connectAuthControl } = require(path.join(REPO, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

// The retired handlers stamp share records from Date.now().
Date.now = () => Number(process.env.FROZEN_NOW);

const express = require(require.resolve('express', { paths: [REPO] }));
const { createShareMachinesHost } = require(path.join(REPO, 'src/routes/share-machines-host'));
const { buildWorld } = require(path.join(REPO, 'tests/helpers/legacy-share-machine-routes/world'));

const worldFile = process.env.SHARE_WORLD;
const readWorld = () => {
  try { return JSON.parse(fs.readFileSync(worldFile, 'utf8')); } catch (_) { return {}; }
};

const server = http.createServer((req, res) => {
  if (req.url === '/__health') { res.writeHead(200); res.end('ok'); return; }
  // The internal execution-slot guard rides the session-admin port.
  if (req.url === '/api/__host/session-admin') {
    req.resume();
    req.on('end', () => {
      const text = JSON.stringify({ ok: true, value: { record: null, internal: false, taskStateWritable: true } });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    });
    return;
  }
  // A host rebuilt per request keeps the scripted world in step with the case
  // without restarting the process (the Node facts themselves — the share
  // store, the machine registry — live in modules and survive).
  const inner = express();
  // server.js parses the global 50mb JSON body before the host route runs.
  inner.use(express.json({ limit: '50mb' }));
  const world = buildWorld({
    dataRoot: process.env.MULTICC_DATA_DIR,
    scenario: readWorld(),
    express,
    authSecurity: globalThis.__gatewayAuthSecurity,
  });
  createShareMachinesHost({ express, ...world }).mountRoute(inner);
  inner(req, res, (error) => {
    if (error) { res.writeHead(500); res.end('host failure'); return; }
    res.writeHead(404); res.end('forwarded');
  });
});
const net = require('node:net');
const listener = net.createServer({ pauseOnConnect: true }, socket => {
  socket.setNoDelay(true);
  socket.on('error', () => {});
  let buffered = Buffer.alloc(0);
  const onData = chunk => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    const end = buffered.indexOf('\\r\\n');
    if (end < 0) return;
    socket.removeListener('data', onData);
    socket.pause();
    const rest = buffered.subarray(end + 2);
    if (rest.length) socket.unshift(rest);
    server.emit('connection', socket);
    socket.resume();
  };
  socket.on('data', onData);
  socket.resume();
});
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');
`;
}

// ── the stub remote machine ─────────────────────────────────────────────────

function stubMachine() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const send = (status, value) => {
        const text = JSON.stringify(value);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (req.url === '/api/machines/self') return send(200, { id: PEER_ID, name: 'Stub peer', local: true });
      if (req.url === '/api/machines/pair') {
        return send(200, { machine: { id: PEER_ID }, grant: PEER_GRANT, grantId: PEER_GRANT_ID });
      }
      if (req.url === '/api/auth/ws-ticket') {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) {}
        return send(200, { ticket: 'upstream-ticket', path: body.path || '/' });
      }
      if (req.url === '/api/machines/connection' && req.method === 'DELETE') return send(200, { ok: true });
      return send(200, {});
    });
  });
}

// ── run ─────────────────────────────────────────────────────────────────────

const server = stubMachine();
server.unref();
server.listen(0, '127.0.0.1', () => {
  stubPort = server.address().port;
  main({
    name: 'share-machine-routes',
    mount: mountOracle,
    ready: waitForFixture,
    get upstream() { return upstreamText; },
    gatewayEnv: work => ({
      HOST: '127.0.0.1',
      MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
      MULTICC_RUST_PREBUILT_DIR: process.env.MULTICC_RUST_PREBUILT_DIR,
      MULTICC_DATA_DIR: path.join(work, 'gw-data'),
      SHARE_WORLD: path.join(work, 'share-world.json'),
      FROZEN_NOW: String(FROZEN_NOW),
    }),
    // The machine registry stamps RFC3339 wall-clock times two processes cannot
    // agree on; everything else that is random is scrubbed per side in
    // `hooks.normalize` from the values that side actually handed out.
    normalize: text => text.replace(/"((?:createdAt|addedAt))":"[^"]*"/g, '"$1":"<ts>"'),
    corpus,
    finalize({ work, views }) {
      // Byte-identical is not enough on its own: if the scripted world failed
      // to resolve, both sides could 500 identically for every case. Pin the
      // answers that prove each route ran, including the canaries.
      const byName = new Map(views.map(view => [view.name, view]));
      const expect = (name, status, needle) => {
        const view = byName.get(name);
        if (!view) { problems.push(`${name}: missing from the corpus`); return; }
        for (const side of ['node', 'rust']) {
          if (view[side].status !== status) {
            problems.push(`${name}: ${side} answered ${view[side].status}, expected ${status}`);
          }
          if (needle && !view[side].body.includes(needle)) {
            problems.push(`${name}: ${side} body lacks ${needle} (${view[side].body})`);
          }
        }
      };
      for (const view of views) {
        for (const side of ['node', 'rust']) {
          if (view[side].status === 500 && view[side].body.includes('"error":"internal_error"')) {
            problems.push(`${view.name}: ${side} hit the generic 500 (${view[side].body})`);
          }
        }
      }
      // The retired desktop identity is the durable fact this cluster protects.
      const canary = (view) => {
        const text = view.body;
        if (/mcg_[0-9a-f]{48}/.test(text)) problems.push(`${view} leaked a pairing credential`);
        if (/pwHash|"salt"|"secret"/.test(text)) problems.push(`${view} leaked a share secret`);
      };
      for (const view of views) { canary(view.node); canary(view.rust); }

      expect('machines list', 200, '"local":true');
      expect('machines self', 200, '"local":true');
      expect('pair with the access password', 200, '"grant":"<secret>"');
      expect('pair with a wrong password', 403, '目标电脑访问密码不正确');
      expect('pair refuses the local identity', 400, 'machine_pair_invalid');
      expect('grants list after pairing', 200, '"ownerId":"machine_peer"');
      expect('rename the local machine', 200, '"ok":true');
      expect('rename an unknown machine', 404, 'machine_not_found');
      expect('remove an unknown machine', 404, 'machine_not_found');
      expect('ws-ticket without a peer', 404, 'machine_not_found');
      expect('cross-site machine read', 403, 'machine_cross_site_denied');
      expect('cross-site machine OPTIONS', 403, 'machine_cross_site_denied');
      expect('add a remote machine', 200, '"local":false');
      expect('machines list with a peer', 200, '"machines":[{"id"');
      expect('rename the peer', 200, '"ok":true');
      expect('ws-ticket through the peer', 200, '"proxyPath":"/ws/machines/');
      expect('remove the peer', 200, '"ok":true');
      expect('machines list after removal', 200, '"machines":[]');
      expect('connection delete with the scoped grant', 200, '"ok":true');
      expect('connection delete without a grant', 403, '缺少电脑授权');
      expect('create a public share', 200, '"url":"http://localhost/share/<secret>"');
      expect('create a password share', 200, '"hasPassword":true');
      expect('create a share with an explicit base url', 200, '"url":"https://share.example.com/share/<secret>"');
      expect('create a share with an invalid base url', 400, 'publicBaseUrl must be an http(s) URL');
      expect('create a share for an unknown session', 404, 'session not found');
      expect('create a share for a system session', 400, 'cannot share system session');
      expect('create a message snapshot', 200, '"messageCount":2');
      expect('create a snapshot with no messages', 400, 'no valid messages selected');
      expect('list one session share', 200, '"shares":[');
      expect('public entry of a public share', 200, '"access":"view"');
      expect('entry without the password cookie', 401, '"needPassword":true');
      expect('auth with a wrong password', 403, '密码错误');
      expect('auth with the right password', 200, '"access":"operate"');
      expect('entry with the password cookie', 200, '"access":"operate"');
      expect('history of a shared session', 200, '"found":true');
      expect('history of a snapshot', 200, '"hasMore":false');
      expect('entry of a snapshot', 200, '"type":"messages"');
      expect('full session read of a share', 200, '"messages":[');
      expect('the public share page', 200, '<html>');
      expect('revoke a share of another session', 400, 'token does not belong to this session');
      expect('revoke the public share', 200, '"ok":true');
      expect('entry of a revoked share', 404, 'share not found or expired');
      expect('workspace overview, empty world', 200, '"totals":{"awake":0,"hibernated":0}');
      expect('workspace overview, scripted world', 200, '"hibernated":1');
      expect('workspace sweep without a runtime', 503, 'hibernation runtime not ready');
      expect('workspace sweep with orphans', 200, '"orphans":{"orphans":[{');
      expect('workspace sweep that throws', 500, 'hibernation sweep exploded');

      // Every route in the cluster must have been exercised at least once.
      const exercised = [
        'machines list', 'machines self', 'machines grants empty', 'pair with the access password',
        'grants list after pairing', 'rename the local machine', 'remove an unknown machine',
        'ws-ticket without a peer', 'ws-ticket through the peer', 'add a remote machine',
        'remove the peer', 'connection delete with the scoped grant', 'revoke an unknown grant',
        'create a public share', 'list one session share', 'revoke the public share',
        'create a message snapshot', 'public entry of a public share', 'auth with the right password',
        'history of a shared session', 'history of a snapshot', 'full session read of a share',
        'the public share page', 'workspace overview, empty world', 'workspace sweep with orphans',
        'cross-site machine read',
      ];
      // A route may be exercised by its refusal: these three are the documented
      // 404/403 outcomes, already pinned below.
      const refusal = {
        'remove an unknown machine': 404,
        'ws-ticket without a peer': 404,
        'cross-site machine read': 403,
      };
      for (const name of exercised) {
        const view = byName.get(name);
        const wanted = refusal[name] || 200;
        if (!view || view.node.status !== wanted) {
          problems.push(`${name}: route was not exercised (node status ${view ? view.node.status : 'missing'}, expected ${wanted})`);
        }
      }

      // The OPTIONS union, measured against the retired Express stack.
      const allows = {
        'OPTIONS /api/machines': 'GET,HEAD,POST',
        'OPTIONS /api/machines/self': 'GET,HEAD,PATCH,DELETE',
        'OPTIONS /api/machines/pair': 'POST,PATCH,DELETE',
        'OPTIONS /api/machines/connection': 'DELETE,PATCH',
        'OPTIONS /api/machines/grants': 'GET,HEAD,PATCH,DELETE',
        'OPTIONS /api/machines/grants/ws-ticket': 'DELETE,POST',
        'OPTIONS /api/sessions/s1/share': 'POST',
        'OPTIONS /api/sessions/s1/shares': 'GET,HEAD',
        'OPTIONS /api/share/t1/entry': 'GET,HEAD',
        'OPTIONS /share/t1': 'GET,HEAD',
        'OPTIONS /api/workspaces/overview': 'GET,HEAD',
        'OPTIONS /api/workspaces/sweep': 'POST',
      };
      for (const [name, allow] of Object.entries(allows)) {
        expect(name, 200, allow);
      }

      // Both stores must hold the same logical records. Random ids, tokens,
      // digests and salts are normalised; the password hash is re-derived from
      // each side's own salt so a weaker hash cannot hide behind the scrub.
      const crypto = require('crypto');
      const readShares = root => {
        const file = path.join(root, 'shares.json');
        if (!fs.existsSync(file)) return { missing: true };
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Object.values(parsed).map(record => ({
          sessionId: record.sessionId,
          access: record.access,
          type: record.type || 'session',
          label: record.label,
          expiresAt: record.expiresAt || null,
          createdAt: record.createdAt === FROZEN_NOW ? '<now>' : record.createdAt,
          messageCount: (record.messages || []).length,
          hasPassword: !!record.pwHash,
          passwordRehashes: record.pwHash
            ? crypto.createHash('sha256').update(crypto.scryptSync('share-pass', record.salt, 32)).digest('hex') === crypto.createHash('sha256').update(Buffer.from(record.pwHash, 'hex')).digest('hex')
            : null,
        })).sort((a, b) => String(a.label).localeCompare(String(b.label)));
      };
      const nodeShares = readShares(path.join(work, 'node-data'));
      const gwShares = readShares(path.join(work, 'gw-data'));
      if (JSON.stringify(nodeShares) !== JSON.stringify(gwShares)) {
        problems.push(`share store differs: ${JSON.stringify({ node: nodeShares, rust: gwShares })}`);
      }
      const readMachines = root => {
        const file = path.join(root, 'machines.json');
        if (!fs.existsSync(file)) return { missing: true };
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const scrubId = value => String(value).replace(/^(machine|grant|mcg)_[0-9a-f]{48}$/, '$1_<id>');
        return {
          grants: (parsed.grants || []).map(grant => ({
            id: scrubId(grant.id), ownerId: scrubId(grant.ownerId), name: grant.name,
            createdAt: String(grant.createdAt).replace(/^\d{4}-/, '<ts>-'),
          })).sort((a, b) => String(a.ownerId).localeCompare(String(b.ownerId))),
          peers: (parsed.peers || []).map(peer => ({
            id: scrubId(peer.id), name: peer.name, origin: peer.origin,
            grantId: scrubId(peer.grantId),
            addedAt: String(peer.addedAt).replace(/^\d{4}-/, '<ts>-'),
            grant: peer.grant ? 'present' : null,
          })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
        };
      };
      const nodeMachines = readMachines(path.join(work, 'node-data'));
      const gwMachines = readMachines(path.join(work, 'gw-data'));
      if (JSON.stringify(nodeMachines) !== JSON.stringify(gwMachines)) {
        problems.push(`machine registry differs: ${JSON.stringify({ node: nodeMachines, rust: gwMachines })}`);
      }
      if (!problems.length) {
        console.log('[share-machine-routes] desensitization canaries hold; share store and machine registry identical');
      }
      for (const problem of problems) console.log(`[share-machine-routes] ${problem}`);
      if (problems.length) {
        const file = path.join(work, 'coverage-problems.json');
        fs.writeFileSync(file, JSON.stringify(problems, null, 2));
        return { ok: false, details: file };
      }
      return { ok: true, details: path.join(work, 'result.json') };
    },
  });
});
