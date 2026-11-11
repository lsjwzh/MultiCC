'use strict';
// Differential run that retired the sub-task default routes from Node:
// GET|HEAD /api/subagent-defaults and POST /api/subagent-defaults/sync
// (src/routes/subagent-defaults.js), now answered by
// native/gateway/src/app/subagent_defaults.rs.
//
//   node docs/rust-migration/differential/subagent-defaults.js \
//     <repo> <multicc-gateway> <multicc_core.node>
//
// The Node side mounts the frozen route (tests/helpers/legacy-subagent-defaults-route.js)
// against an in-memory harness. The front door asks its host port
// (/api/__host/subagent-defaults) for the same facts; the stub Node child here
// answers from one script that is built from the very same session objects, so
// both sides plan over identical input.
//
// Corpus shape: reads, dry runs, validation failures and Express's automatic
// OPTIONS. One real apply case runs last, because it is the only case whose two
// sides mutate state (the oracle its memory, the stub its script) and nothing
// may read that state afterwards.
const path = require('path');
const { main } = require('./lib');

const CLAUDE_ROUTE = { providerId: 'sub-claude', model: 'claude-haiku-4-5' };
const CODEX_ROUTE = { providerId: 'sub-codex', model: 'gpt-5-codex' };
const OFFICIAL_ROUTE = { providerId: 'official-codex', model: 'gpt-5-codex' };
const SENSITIVE = '/Users/alice/private token=abc';

const SESSIONS = [
  { id: 'apply-me', label: 'apply-me', cli: 'claude', kind: 'chat', provider: 'main' },
  { id: 'same', label: 'same', cli: 'claude', kind: 'chat', provider: 'main',
    subagent: { ...CLAUDE_ROUTE, inherited: true } },
  { id: 'own', label: 'own', cli: 'claude', kind: 'chat', provider: 'main',
    subagent: { providerId: 'main', model: 'own-model' } },
  { id: 'staged', label: 'staged', cli: 'codex', kind: 'chat', provider: 'main',
    pendingConfiguration: { cli: 'claude', profile: { subagent: null } } },
  { id: 'rejected', label: 'rejected', cli: 'claude', kind: 'chat', provider: 'main' },
  { id: 'codex-main', label: 'codex-main', cli: 'codex', kind: 'chat', provider: 'main' },
  { id: 'codex-nomain', label: 'codex-nomain', cli: 'codex', kind: 'chat', provider: null },
  { id: 'aux', label: 'aux', cli: 'claude', kind: 'chat', type: 'aux' },
  { id: 'gateway', label: 'gateway', cli: 'claude', kind: 'chat', type: 'gateway' },
  { id: 'terminal', label: 'terminal', cli: 'claude', kind: 'terminal' },
  { id: 'helper', label: 'helper', cli: 'claude', kind: 'chat', ephemeral: true },
  { id: 'login', label: 'login', cli: 'claude', kind: 'chat', loginFlow: 'claude-auth-login' },
  // A display name a terminal label can carry: control characters and width.
  { id: 'messy', label: '  messy\n\tname  ', cli: 'claude', kind: 'chat', provider: 'main' },
];

const DEFAULT_STORED = { claude: CLAUDE_ROUTE, codex: null };

const FACTS = {
  'sub-claude': { valid: true, proxyable: false, official: false },
  'sub-codex': { valid: true, proxyable: true, official: false },
  'official-codex': { valid: true, proxyable: true, official: true },
};

const PATCHES = {
  rejected: { status: 400, detail: 'session patch rejected' },
};

let upstreamText = '';

function sessionMap() {
  const map = new Map();
  for (const session of SESSIONS) map.set(session.id, JSON.parse(JSON.stringify(session)));
  return map;
}

function providers() {
  return {
    getProvider: (appType, id) => (appType === 'codex' ? { id, appType } : null),
    codexProviderProxyable: id => FACTS[id]?.proxyable === true,
    isOfficialCodexOAuthProvider: provider => FACTS[provider?.id]?.official === true,
  };
}

// The stub Node child the front door talks to: the real auth-control bridge
// (the front door refuses every native route without it), then the host port,
// then a marker for anything that should have been answered in Rust.
function upstreamSource(repo, projection) {
  const script = JSON.stringify({
    subagent: DEFAULT_STORED,
    sessions: projection,
    facts: FACTS,
    patches: PATCHES,
  });
  return `'use strict';
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const REPO = ${JSON.stringify(repo)};
const { createAuthSecurity } = require(path.join(REPO, 'src/auth-security'));
const { connectAuthControl } = require(path.join(REPO, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
const script = JSON.parse(${JSON.stringify(script)});
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/__host/subagent-defaults') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      let out;
      if (input.op === 'state') out = { subagent: script.subagent, sessions: script.sessions };
      else if (input.op === 'facts') out = script.facts[input.providerId] || { valid: false, proxyable: false, official: false };
      else if (input.op === 'persist') out = { ok: true };
      else if (input.op === 'patch') {
        out = script.patches[input.sessionId] || { status: 200, deferred: false };
        // The oracle's applySessionPatch mutates its session map; the stub has
        // to move in lockstep or later plans would drift apart.
        if (input.dryRun !== true && !(typeof out.status === 'number' && out.status !== 200)) {
          // A staged (pending) session reports its *pending* profile, whose
          // subagent stays null here, no matter what was just patched.
          const row = script.sessions.find(item => item.id === input.sessionId);
          if (row && !row.pending) row.subagent = input.subagent && typeof input.subagent === 'object' ? { ...input.subagent, inherited: true } : null;
        }
      }
      else out = { ok: false };
      const text = JSON.stringify(out);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    });
    return;
  }
  res.statusCode = 599;
  res.setHeader('content-type', 'text/plain');
  res.end('gateway-forwarded:' + req.method + ' ' + req.url);
});
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

function corpus({ cookie, token }) {
  const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
  const J = { ...L, 'Content-Type': 'application/json' };
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const post = (body, headers = J) => ({ method: 'POST', url: '/api/subagent-defaults/sync', headers, body: JSON.stringify(body) });
  const dry = (body, extra = {}) => post({ ...body, dryRun: true, ...extra });
  return [
    ['GET defaults', get('/api/subagent-defaults')],
    ['GET trailing slash', get('/api/subagent-defaults/')],
    ['GET mixed case', get('/api/Subagent-Defaults')],
    ['HEAD defaults', { method: 'HEAD', url: '/api/subagent-defaults', headers: L }],
    ['OPTIONS defaults', { method: 'OPTIONS', url: '/api/subagent-defaults', headers: L }],
    ['OPTIONS sync', { method: 'OPTIONS', url: '/api/subagent-defaults/sync', headers: L }],
    ['dry run claude', dry({ cli: 'claude', subagent: CLAUDE_ROUTE })],
    ['dry run claude-exp', dry({ cli: 'claude-exp', subagent: CLAUDE_ROUTE })],
    ['dry run clears with null', dry({ cli: 'claude', subagent: null })],
    ['dry run clears with empty string', dry({ cli: 'claude', subagent: '' })],
    ['dry run clears with empty object', dry({ cli: 'claude', subagent: {} })],
    ['dry run cli whitespace', dry({ cli: '  claude  ', subagent: CLAUDE_ROUTE })],
    ['dry run codex proxyable', dry({ cli: 'codex', subagent: CODEX_ROUTE })],
    ['dry run codex official', dry({ cli: 'codex', subagent: OFFICIAL_ROUTE })],
    ['dry run codex invalid provider', dry({ cli: 'codex', subagent: { providerId: 'ghost', model: 'm' } })],
    ['dry run claude invalid provider', dry({ cli: 'claude', subagent: { providerId: 'ghost', model: 'm' } })],
    ['dry run bad model', dry({ cli: 'claude', subagent: { providerId: 'sub-claude', model: 'bad model' } })],
    ['dry run missing model', dry({ cli: 'claude', subagent: { providerId: 'sub-claude' } })],
    ['dry run missing providerId', dry({ cli: 'claude', subagent: { model: 'm' } })],
    ['dry run string target', dry({ cli: 'claude', subagent: 'nope' })],
    ['dry run unsupported cli', dry({ cli: 'opencode', subagent: CLAUDE_ROUTE })],
    ['dry run no cli', dry({ subagent: CLAUDE_ROUTE })],
    ['dry run dryRun string', post({ cli: 'claude', subagent: CLAUDE_ROUTE, dryRun: 'true' })],
    ['dry run dryRun number', post({ cli: 'claude', subagent: CLAUDE_ROUTE, dryRun: 1 })],
    ['sync without body', { method: 'POST', url: '/api/subagent-defaults/sync', headers: L }],
    ['sync array body', post([1, 2])],
    ['sync malformed json', { method: 'POST', url: '/api/subagent-defaults/sync', headers: J, body: '{"cli":' }],
    // The one apply case: nothing after it may read mutated state.
    ['apply claude', post({ cli: 'claude', subagent: CLAUDE_ROUTE })],
  ];
}

main({
  name: 'subagent-defaults',
  mount(app, { repo }) {
    const { mountSubagentDefaultsRoutes } = require(path.join(repo, 'tests/helpers/legacy-subagent-defaults-route'));
    const { planSessions } = require(path.join(repo, 'src/routes/subagent-defaults-host'));
    const sessions = sessionMap();
    // Exposed for upstreamSource(): the front door must see the identical
    // projection the retired route computes from the same session objects.
    mountSubagentDefaultsRoutes(app, {
      providerDefaults: { subagent: JSON.parse(JSON.stringify(DEFAULT_STORED)) },
      sessions,
      validProviderId: (_cli, id) => (FACTS[id] ? { ok: true, value: id } : { ok: false }),
      providers: providers(),
      applySessionPatch(sessionId, body) {
        const session = sessions.get(sessionId);
        if (!session) return { status: 404, body: { error: 'session not found' } };
        if (sessionId === 'rejected') return { status: 400, body: { error: SENSITIVE } };
        if (body.subagent) session.subagent = { ...body.subagent, inherited: true };
        else delete session.subagent;
        return { status: 200, body: {} };
      },
      previewSessionPatch(sessionId) {
        if (!sessions.has(sessionId)) return { status: 404, body: { error: 'session not found' } };
        if (sessionId === 'rejected') return { status: 400, body: { error: SENSITIVE } };
        return { status: 200, body: {} };
      },
      persistDefaults() {},
    });
    upstreamText = upstreamSource(repo, planSessions(sessions));
  },
  get upstream() {
    return upstreamText;
  },
  // The stub child loads the real auth-control bridge, which loads the native
  // addon (src/native/runtime) — the same module the front door calls.
  gatewayEnv: () => ({ MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON }),
  corpus,
});
