'use strict';
// Compare the frozen Node voice-gateway routes (tests/helpers/legacy-voice-gateway-routes)
// with the real Rust gateway in front of the real host port (src/routes/voice-gateway-host).
// Usage: node docs/rust-migration/differential/voice-gateway.js <repo> <gateway> <addon>
//
// Both sides start from the same records/directories and walk the same request
// sequence, so state stays aligned without sharing memory. Timestamps come from
// the service's own clock and cannot be injected through the routes; they are
// blanked after asserting they are ISO strings. reconcile()/stop() side effects
// are recorded on each side and compared as ordinary responses.
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./lib');

const BASE_URL = 'http://127.0.0.1:3456';
const ACP_AGENT = '/opt/multicc/multicc-acp-agent.mjs';
const NODE_PATH = '/usr/bin/node';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// One definition of the starting state, serialised into the upstream script and
// evaluated in-process for the oracle, so the two cannot drift.
const SEED = `(function seed() {
  const commander = (id, dirId) => ({ id, dirId, type: 'commander', kind: 'chat', label: 'Commander ' + id });
  const gateway = (id, dirId, extra) => Object.assign({
    id, dirId, type: 'gateway', kind: 'voice', gatewayKind: 'qwen-audio',
    label: 'Qwen Audio Voice Gateway', enabled: true, commanderSessionId: 'cmd-b',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  }, extra || {});
  return {
    directories: [['dir-a', { id: 'dir-a' }], ['dir-b', { id: 'dir-b' }], ['dir-c', { id: 'dir-c' }],
      ['dir-amb', { id: 'dir-amb' }], ['dir-nocmd', { id: 'dir-nocmd' }], ['dir-冷', { id: 'dir-冷' }]],
    records: [
      ['cmd-a', commander('cmd-a', 'dir-a')],
      ['cmd-b', commander('cmd-b', 'dir-b')],
      ['cmd-c', commander('cmd-c', 'dir-c')],
      ['cmd-amb', commander('cmd-amb', 'dir-amb')],
      ['cmd-冷', commander('cmd-冷', 'dir-冷')],
      ['gw-b', gateway('gw-b', 'dir-b')],
      ['gw-amb-1', gateway('gw-amb-1', 'dir-amb', { commanderSessionId: 'cmd-amb' })],
      ['gw-amb-2', gateway('gw-amb-2', 'dir-amb', { commanderSessionId: 'cmd-amb' })],
      // The machine-wide singleton must stay invisible to the per-Fleet routes.
      ['__voice_gateway__', gateway('__voice_gateway__', 'dir-a')],
      // A gateway whose Commander binding went stale (cmd-gone does not exist).
      ['gw-c', gateway('gw-c', 'dir-c', { commanderSessionId: 'cmd-gone' })],
    ],
  };
})()`;

function upstream(repo) {
  return `'use strict';
const net = require('node:net'); const http = require('node:http'); const path = require('node:path');
const repo = ${JSON.stringify(repo)};
const express = require(require.resolve('express', { paths: [repo] }));
const { createAuthSecurity } = require(path.join(repo, 'src/auth-security'));
const { connectAuthControl } = require(path.join(repo, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0)); process.stdin.resume();
const { createVoiceGatewayHost } = require(path.join(repo, 'src/routes/voice-gateway-host'));
const seed = ${SEED};
const records = new Map(); const directories = new Map(); let calls = [];
function reset() {
  records.clear(); directories.clear(); calls = [];
  for (const [k, v] of JSON.parse(JSON.stringify(seed.directories))) directories.set(k, v);
  for (const [k, v] of JSON.parse(JSON.stringify(seed.records))) records.set(k, v);
}
reset();
const app = express(); app.use(express.json());
createVoiceGatewayHost({
  records, directories, acpAgentPath: ${JSON.stringify(ACP_AGENT)}, nodePath: ${JSON.stringify(NODE_PATH)},
  getBaseUrl: () => ${JSON.stringify(BASE_URL)},
  sessionPersistence: { mutate(_source, operation) { return operation(records); } },
  runtime: {
    reconcile(...a) { calls.push(['reconcile', ...a]); },
    stop(...a) { calls.push(['stop', ...a]); },
  },
}).mountRoutes(app);
// Test-only controls: the gateway does not claim these, so they reach this child.
app.post('/__reset', (_q, r) => { reset(); r.json({ ok: true }); });
app.get('/__calls', (_q, r) => r.json({ calls }));
app.use((req, res) => res.status(599).send('forwarded:' + req.method + ' ' + req.url));
const server = http.createServer(app);
const listener = net.createServer({ pauseOnConnect: true }, socket => {
 socket.on('error', () => {}); let buffered = Buffer.alloc(0);
 const onData = chunk => { buffered = Buffer.concat([buffered, chunk]);
  const end = buffered.indexOf('\\r\\n'); if (end < 0) return;
  socket.removeListener('data', onData); socket.pause();
  const rest = buffered.subarray(end + 2); if (rest.length) socket.unshift(rest);
  server.emit('connection', socket); socket.resume(); };
 socket.on('data', onData); socket.resume();
});
listener.listen(Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT), '127.0.0.1');`;
}

// The oracle's state lives in this process; the Rust side's in the upstream child.
const oracle = { records: new Map(), directories: new Map(), calls: [] };
function resetOracle() {
  const seed = eval(SEED); // eslint-disable-line no-eval -- the same literal the upstream evaluates
  oracle.records.clear(); oracle.directories.clear(); oracle.calls = [];
  for (const [k, v] of seed.directories) oracle.directories.set(k, v);
  for (const [k, v] of seed.records) oracle.records.set(k, v);
}

// Timestamps differ per side; assert they are ISO strings then blank them.
function blankTimes(text) {
  let body;
  try { body = JSON.parse(text); } catch (_) { return text; }
  let bad = null;
  (function walk(value) {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      if (key === 'createdAt' || key === 'updatedAt') {
        if (value[key] !== null && !(typeof value[key] === 'string' && ISO.test(value[key]))) bad = `${key}=${value[key]}`;
        else if (value[key] !== null) value[key] = '<iso>';
      } else walk(value[key]);
    }
  })(body);
  if (bad) throw new Error(`timestamp is not an ISO string: ${bad}`);
  return JSON.stringify(body);
}

// A request the front door does not claim reaches the upstream child. In the
// real service that child is Node with these routes deleted, so the answer is
// Express's 404; the oracle still has the route, so the two sides differ by
// design. Each side is pinned to its own exact shape (lib.js requires both).
function forwardedPair(method, url, nodeCheck) {
  return {
    expectedDifference: {
      node: view => nodeCheck(view) === true,
      rust: view => view.status === 599 && view.body === `forwarded:${method} ${url}`,
    },
  };
}
const cannot = (method, url) => view => view.status === 404 && view.body.includes(`<pre>Cannot ${method} ${url}</pre>`);

function main() {
  let upstreamText = '';
  return run({
    name: 'voice-gateway',
    mount(app, { repo }) {
      const legacy = require(path.join(repo, 'tests/helpers/legacy-voice-gateway-routes'));
      resetOracle();
      legacy.createVoiceGatewayRoutes({
        records: oracle.records, directories: oracle.directories,
        sessionPersistence: { mutate(_source, operation) { return operation(oracle.records); } },
        acpAgentPath: ACP_AGENT, nodePath: NODE_PATH, getBaseUrl: () => BASE_URL,
        runtime: {
          reconcile(...a) { oracle.calls.push(['reconcile', ...a]); },
          stop(...a) { oracle.calls.push(['stop', ...a]); },
        },
      }).mountRoutes(app);
      app.get('/__calls', (_q, r) => r.json({ calls: oracle.calls }));
      upstreamText = upstream(repo);
    },
    get upstream() { return upstreamText; },
    // The gateway hands its Node child a fixed environment; the child needs the
    // native addon for createAuthSecurity, exactly like system-scan's upstream.
    gatewayEnv: () => ({ MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON }),
    normalize: blankTimes,
    // The ETag hashes the raw bytes, timestamps included. Blank it only when the
    // body carried one, after checking it is a weak ETag, so a real ETag
    // difference on timestamp-free bodies still shows up.
    normalizeView(v) {
      // /__calls is this script's own control endpoint: the oracle serves it
      // through the request-id middleware, the Rust side through the upstream
      // stub. Only its body is the evidence; every real route keeps all headers.
      if (/^\{"calls":\[/.test(v.body)) {
        for (const name of ['x-multicc-api-version', 'x-multicc-request-id', 'x-correlation-id']) delete v.headers[name];
      }
      if (v.body.includes('"<iso>"') && v.headers.etag !== undefined) {
        if (!/^W\/"[0-9a-f]+-[A-Za-z0-9+\/]{27}"$/.test(v.headers.etag)) throw new Error(`unexpected ETag shape: ${v.headers.etag}`);
        v.headers.etag = '<etag>';
      }
      return v;
    },
    // Equal answers prove nothing if both sides only ever said "not found".
    // Fail the run unless the success paths were really walked.
    finalize({ views }) {
      const seen = { listNonEmpty: 0, getFound: 0, created201: 0, updated200: 0, deleted: 0, stopped: 0, reconciled: 0 };
      for (const { name, node, rust } of views) {
        for (const side of [node, rust]) {
          const b = side.body;
          if (/^list\/?(v1)? *$/.test(name.replace(/ .*/, '')) && b.includes('"gateways":[{')) seen.listNonEmpty++;
          if (name.startsWith('get') && side.status === 200 && b.includes('"gateway":{')) seen.getFound++;
          if (name.startsWith('put') && side.status === 201 && b.includes('"created":true')) seen.created201++;
          if (name.startsWith('put') && side.status === 200 && b.includes('"created":false')) seen.updated200++;
          if ((name.startsWith('delete') || name.startsWith('sequence')) && side.status === 200 && b.includes('"directoryId"')) seen.deleted++;
          if (b.includes('["stop",')) seen.stopped++;
          if (b.includes('["reconcile",')) seen.reconciled++;
        }
      }
      const missing = Object.entries(seen).filter(([, n]) => n === 0).map(([k]) => k);
      return { ok: missing.length === 0, details: { seen, missing } };
    },
    corpus(ctx) {
      const headers = { Host: 'localhost', 'X-Request-Id': 'diff-req-1', 'Content-Type': 'application/json' };
      const reset = async side => {
        if (side.name === 'node') resetOracle();
        else await fetchJson(side.port, 'POST', '/__reset', { Host: 'localhost', Cookie: `multicc_auth=${ctx.cookie}` });
      };
      const req = (method, url, body) => ({ method, url, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
      const cases = [];
      const add = (name, request, hooks) => cases.push([name, request, { before: reset, ...(hooks || {}) }]);
      const dirs = ['dir-a', 'dir-b', 'dir-c', 'dir-amb', 'dir-nocmd', 'dir-ghost', 'dir-%E5%86%B7', 'bad%ZZ'];

      for (const v of ['', '/v1']) {
        add(`list${v}`, req('GET', `/api${v}/voice-gateways`));
        add(`list${v} HEAD`, req('HEAD', `/api${v}/voice-gateways`));
        add(`list${v} trailing slash`, req('GET', `/api${v}/voice-gateways/`));
        add(`list${v} upper path`, req('GET', `/API${v}/Voice-Gateways`), forwardedPair('GET', `/API${v}/Voice-Gateways`,
          view => view.status === 200 && view.body.startsWith('{"ok":true,"gateways":[')));
        add(`list${v} OPTIONS`, req('OPTIONS', `/api${v}/voice-gateways`));
        for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
          add(`list${v} ${m}`, req(m, `/api${v}/voice-gateways`), forwardedPair(m, `/api${v}/voice-gateways`, cannot(m, `/api${v}/voice-gateways`)));
        }
        for (const dir of dirs) {
          const url = `/api${v}/directories/${dir}/voice-gateway`;
          add(`get${v} ${dir}`, req('GET', url));
          add(`get${v} ${dir} HEAD`, req('HEAD', url));
          add(`delete${v} ${dir}`, req('DELETE', url));
          add(`put${v} ${dir} empty`, req('PUT', url, {}));
        }
        const url = `/api${v}/directories/dir-a/voice-gateway`;
        add(`dir${v} OPTIONS`, req('OPTIONS', url));
        for (const m of ['POST', 'PATCH']) add(`dir${v} ${m}`, req(m, url), forwardedPair(m, url, cannot(m, url)));
        add(`dir${v} trailing slash`, req('GET', `${url}/`));
        add(`dir${v} upper path`, req('GET', `/API${v}/Directories/dir-a/Voice-Gateway`), forwardedPair('GET', `/API${v}/Directories/dir-a/Voice-Gateway`,
          view => view.status === 404 && view.body.includes('voice_gateway_not_found')));
        const ensure = (name, body, dir = 'dir-a') => add(`put${v} ${name}`, req('PUT', `/api${v}/directories/${dir}/voice-gateway`, body));
        ensure('create default', {});
        ensure('create enabled=false', { enabled: false });
        ensure('create enabled=true', { enabled: true });
        ensure('provider ok', { provider: 'qwen-audio-agent' });
        ensure('provider bad', { provider: 'other' });
        ensure('provider null', { provider: null });
        ensure('enabled string', { enabled: 'yes' });
        ensure('enabled null', { enabled: null });
        ensure('commander host-owned', { commanderSessionId: 'cmd-a' });
        ensure('commander null', { commanderSessionId: null });
        ensure('autoInstall true', { autoInstall: true });
        ensure('autoInstall false', { autoInstall: false });
        ensure('autoInstall string', { autoInstall: 'true' });
        ensure('autoInstall null', { autoInstall: null });
        ensure('autoInstall 1', { autoInstall: 1 });
        ensure('extra keys', { enabled: true, autoInstall: true, ignored: [1, 2] });
        ensure('array body', [1, 2, 3]);
        ensure('string body', '"text"');
        ensure('null body', 'null');
        ensure('update existing', { enabled: false }, 'dir-b');
        ensure('update existing keep', {}, 'dir-b');
        ensure('ambiguous', {}, 'dir-amb');
        ensure('no commander', {}, 'dir-nocmd');
        ensure('ghost dir', {}, 'dir-ghost');
        ensure('unicode dir', { enabled: true }, 'dir-%E5%86%B7');
        ensure('bad escape', {}, 'bad%ZZ');
        // Three steps on shared state: only the first resets.
        ['GET', 'DELETE', 'GET'].forEach((step, i) => {
          add(`sequence${v} ${step} #${i}`, req(step, `/api${v}/directories/dir-b/voice-gateway`), { before: i === 0 ? reset : async () => {} });
        });
      }
      // Malformed JSON and the error handler shape.
      add('put malformed json', req('PUT', '/api/directories/dir-a/voice-gateway', '{'));
      add('put v1 malformed json', req('PUT', '/api/v1/directories/dir-a/voice-gateway', '{'));
      // Side effects: reconcile()/stop() calls reach the same place with the same arguments.
      for (const [name, request] of [
        ['put autoInstall true', req('PUT', '/api/directories/dir-a/voice-gateway', { autoInstall: true })],
        ['put autoInstall false', req('PUT', '/api/directories/dir-b/voice-gateway', { autoInstall: false })],
        ['delete existing', req('DELETE', '/api/directories/dir-b/voice-gateway')],
        ['delete missing', req('DELETE', '/api/directories/dir-a/voice-gateway')],
      ]) {
        cases.push([`effects ${name}`, request, { before: reset }]);
        cases.push([`effects ${name} calls`, { method: 'GET', url: '/__calls', headers }, { before: async () => {} }]);
      }
      return cases;
    },
  });
}

function fetchJson(port, method, url, headers) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').request({ host: '127.0.0.1', port, method, path: url, headers }, res => {
      res.resume(); res.on('end', resolve);
    });
    req.on('error', reject); req.end(method === 'POST' ? '{}' : undefined);
  });
}

main().then(ok => { process.exitCode = ok ? 0 : 1; }, error => { console.error(error); process.exitCode = 1; });
