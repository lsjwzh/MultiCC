'use strict';
// Differential run that retired three provider routes from Node:
//
//   POST            /api/providers/:appType/:id/speedtest  (providers.rs)
//   GET|HEAD        /api/v1/providers                       (providers.rs)
//   POST /OPTIONS   /api/auto-provider/routing/test         (auto_provider_routing.rs)
//
//   node docs/rust-migration/differential/provider-misc.js \
//     <repo> native/target/release/multicc-gateway <multicc_core.node>
//
// Node side: the frozen handlers (tests/helpers/legacy-provider-misc-routes.js)
// on the real pipeline (request ids, /api gzip, auth, express.json,
// safeErrorHandler). Their subsystems are scenario fakes: a recording
// http.request, a vault, and a fetchImpl.
//
// Rust side: the release front door plus a stub Node child that mounts the real
// host ports (src/routes/providers-host.js, src/routes/secrets-vault-host.js)
// over the same scenario file, and answers the two loopback proxy paths from
// that file. The routing test's Jev call goes to a scripted listener in this
// process (MULTICC_ROUTING_TEST_URL).
//
// Also compared, grouped by case: the outbound speedtest request (path, method,
// selected headers, parsed JSON body), the vault reveal (name + source), the
// v1 list filter, and the Jev request body. Time fields (`ms`, `latencyMs`) are
// per-side randomness and are normalized before the byte comparison, so ETag
// and Content-Length (both derived from those bytes) are first verified per
// side against that side's own raw body and then neutralized. Everything else
// is compared byte for byte.
//
// Documented differences:
//   a) A host-port answer that is not 2xx becomes 503 rust_backend_unavailable;
//      the corpus never constructs one (the host ops answer ok:false instead).
//   b) The speed test is one hop in Rust (front door -> internal Node listener)
//      and two hops in Node (route -> public front door -> internal). No proxy
//      route reads socket.localPort, so the observed request is identical.
//   c) None for the vault: a reveal that throws is swallowed by the key
//      resolver on both sides, so the case answers jev_key_missing byte for
//      byte. The differential still exercises it.
const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { main } = require('./lib');

let scenarioFile = '';
let rustTraceFile = '';
let jevPort = 0;
let scriptFile = '';
let upstreamText = '';
const nodeSpeed = [];
const nodeVault = [];
const nodeV1 = [];
const nodeJev = [];
const rustJev = [];

function weakEtag(body) {
  if (!body.length) return 'W/"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"';
  const digest = crypto.createHash('sha1').update(body).digest('base64');
  return `W/"${body.length.toString(16)}-${digest.slice(0, 27)}"`;
}

/** ETag/Content-Length must describe the side's own bytes, then are blanked. */
function capture(raw, side) {
  const body = raw.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw.body) : raw.body;
  side.state.etagOk = raw.headers.etag === weakEtag(body);
  side.state.lengthOk = raw.headers['content-length'] === undefined
    || raw.headers['content-length'] === String(raw.body.length);
}

function readScenario() {
  try { return JSON.parse(fs.readFileSync(scenarioFile, 'utf8')); } catch (_) { return {}; }
}

function appendRust(record) {
  fs.appendFileSync(rustTraceFile, `${JSON.stringify(record)}\n`);
}

function readRustTrace() {
  if (!fs.existsSync(rustTraceFile)) return [];
  return fs.readFileSync(rustTraceFile, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch (_) { return null; }
  }).filter(Boolean);
}

function fakeHttp() {
  return {
    request(options, onResponse) {
      const request = new EventEmitter();
      let body = '';
      request.write = chunk => { body += chunk; };
      request.setTimeout = (delay, callback) => { request.timeoutCallback = callback; };
      request.destroy = () => request.emit('error', new Error('socket destroyed'));
      request.end = () => {
        const scenario = readScenario();
        nodeSpeed.push({
          case: scenario.case,
          path: options.path,
          method: options.method,
          headers: options.headers || {},
          body,
        });
        const answer = scenario.speedtest || {};
        if (answer.timeout) {
          setTimeout(() => request.timeoutCallback && request.timeoutCallback(), 1);
          return;
        }
        setTimeout(() => {
          const response = new EventEmitter();
          response.statusCode = answer.status || 200;
          onResponse(response);
          const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body || {});
          response.emit('data', Buffer.from(text));
          response.emit('end');
        }, answer.delayMs || 0);
      };
      return request;
    },
  };
}

function fakeVault() {
  return {
    reveal(name, options) {
      const scenario = readScenario();
      nodeVault.push({ case: scenario.case, name, source: options && options.source });
      const reveal = scenario.secret && scenario.secret.reveal;
      if (reveal && reveal.ok) return { entry: { name, value: reveal.value } };
      return { error: 'entry not found' };
    },
  };
}

function fakeFetch() {
  return async (url, init) => {
    const scenario = readScenario();
    nodeJev.push({ case: scenario.case, url, headers: init.headers || {}, body: init.body });
    const answer = scenario.jev || {};
    const status = answer.status || 200;
    const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body || {});
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
}

function upstreamSource(repo) {
  return `'use strict';
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const REPO = ${JSON.stringify(repo)};
const express = require(require.resolve('express', { paths: [REPO] }));
// The front door's auth gate asks this child for its token snapshot, exactly
// like the real Node child (src/gateway-child.js).
const { createAuthSecurity } = require(path.join(REPO, 'src/auth-security'));
const { connectAuthControl } = require(path.join(REPO, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
const scenarioFile = process.env.PROVIDER_MISC_SCENARIO;
const traceFile = process.env.PROVIDER_MISC_RUST_TRACE;
const readScenario = () => { try { return JSON.parse(fs.readFileSync(scenarioFile, 'utf8')); } catch (_) { return {}; } };
const append = record => fs.appendFileSync(traceFile, JSON.stringify(record) + '\\n');

function stubProviders() {
  const current = () => readScenario();
  return {
    findProviderReferences: () => current().references || [],
    getAuxConfig: () => current().aux || {},
    getPort: () => 4321,
    saveProviderDefaults() {},
    validProviderId: (_cli, value) => ({ ok: true, value }),
    providerDefaults: {},
    claudeCmd: '/usr/local/bin/claude',
    providerRelayShares: {
      create() {}, list() { return []; }, getCredential() { return null; },
      revoke() {}, revokeProvider() {},
    },
    providerRouterRuntime: {
      getProviderSummary: () => current().summary || {},
    },
    providers: {
      get WIRE_DEFAULT_MODEL() { return current().wireDefaultModel || 'claude-sonnet-4-5'; },
      getProvider(appType, id) {
        const scenario = current();
        append({ case: scenario.case, kind: 'getProvider', appType, id });
        if (scenario.providerError) throw new Error(scenario.providerError.message);
        const provider = scenario.provider;
        return provider && provider.appType === appType && provider.id === id ? provider : null;
      },
      isOfficialCodexOAuthProvider: p => require(path.join(REPO, 'src/codex/official-relay')).isOfficialCodexOAuthProvider(p),
      resolveCodexDirectHttp() {
        return current().codexTarget || { canDirect: false };
      },
      listProviders(filter) {
        const scenario = current();
        append({ case: scenario.case, kind: 'v1', appType: filter || null });
        if (scenario.v1Error) throw new Error(scenario.v1Error.message);
        const list = scenario.v1Providers || [];
        return filter ? list.filter(item => item.appType === filter) : list;
      },
      getCcSwitchStatus: () => ({}),
      providerSupportsCli: () => true,
      getProviderUsageStats: () => ({}),
      importFromCcSwitch: () => ({}),
      createProvider: () => ({}),
      updateProvider: () => ({}),
      deleteProvider: () => ({}),
      probeRelayModels: () => ({}),
      claudeProbeRouteEnv: () => ({}),
    },
  };
}

const app = express();
app.use(express.json({ limit: '2mb' }));
const { mountProvidersHostRoute } = require(path.join(REPO, 'src/routes/providers-host'));
mountProvidersHostRoute(app, stubProviders());
const { mountSecretsVaultHostRoute } = require(path.join(REPO, 'src/routes/secrets-vault-host'));
mountSecretsVaultHostRoute(app, {
  vault: {
    reveal(name, options) {
      const scenario = readScenario();
      append({ case: scenario.case, kind: 'vault', name, source: options && options.source });
      if (scenario.secret && scenario.secret.throws) throw new Error('vault read failed');
      const reveal = scenario.secret && scenario.secret.reveal;
      if (reveal && reveal.ok) return { entry: { name, value: reveal.value } };
      return { error: 'entry not found' };
    },
  },
});
app.use((req, res) => {
  if (/^\\/(?:claude|codex)-proxy\\//.test(req.path) && req.method === 'POST') {
    const scenario = readScenario();
    append({
      case: scenario.case, kind: 'speed', path: req.url, method: req.method,
      headers: req.headers, body: JSON.stringify(req.body === undefined ? {} : req.body),
    });
    const answer = scenario.speedtest || {};
    // A timeout case never answers: the front door's 15s deadline decides.
    if (answer.timeout) return;
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body || {});
    const send = () => {
      res.status(answer.status || 200).type(answer.contentType || 'application/json').send(text);
    };
    if (answer.delayMs) setTimeout(send, answer.delayMs); else send();
    return;
  }
  res.status(599).type('text/plain').send('gateway-forwarded:' + req.method + ' ' + req.url);
});
const server = http.createServer(app);
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

function baseScenario() {
  return {
    provider: {
      id: 'claude-1', appType: 'claude', name: 'Claude One', source: 'local',
      settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_API_KEY: 'sk-test' } },
    },
    summary: { model: 'claude-sonnet-5', modelOptions: ['claude-sonnet-5', 'claude-haiku-4-5'] },
    speedtest: { status: 200, body: '{"id":"msg_1"}' },
    v1Providers: [
      { id: 'claude-1', appType: 'claude', name: 'Claude One', model: 'claude-sonnet-5',
        modelOptions: ['claude-sonnet-5', 'claude-haiku-4-5'], compatibleClis: ['claude'], hasToken: true },
      { id: 'codex-1', appType: 'codex', name: 'Codex One', model: 'gpt-5-codex',
        modelOptions: ['gpt-5-codex'], compatibleClis: ['codex'], hasToken: true, wireApi: 'responses' },
    ],
    secret: { reveal: { ok: true, value: 'vck_route_test' } },
    jev: { status: 200, body: JSON.stringify({
      answers: {
        tier: { type: 'choice', choice: 't1', probabilities: { t1: 0.9, t2: 0.1 } },
        complexity: { type: 'score', score: 0, probabilities: [0.9, 0.1] },
      },
      providerMetadata: { typesafe: { confidence: { tier: 0.9, complexity: 0.9 } } },
    }) },
  };
}

function sc(overrides) {
  const base = baseScenario();
  const merged = Object.assign({}, base, overrides || {});
  if (overrides && overrides.provider === undefined && base.provider) merged.provider = base.provider;
  return merged;
}

function officialCodexProvider() {
  return {
    id: 'codex-official', appType: 'codex', name: 'Codex Official', source: 'ccswitch',
    settingsConfig: { auth: {}, config: '' },
  };
}

function codexProvider() {
  return {
    id: 'codex-1', appType: 'codex', name: 'Codex One', source: 'local',
    settingsConfig: { auth: { OPENAI_API_KEY: 'sk-codex' }, config: 'base_url = "https://vendor.example/v1"' },
  };
}

function normalizeHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase();
    if (['content-type', 'accept', 'authorization', 'anthropic-version', 'x-api-key', 'x-app'].includes(key)) {
      out[key] = String(value);
    }
  }
  return out;
}

function parsed(body) {
  if (typeof body !== 'string') return body;
  try { return JSON.parse(body); } catch (_) { return body; }
}

function group(list, project) {
  const map = new Map();
  for (const entry of list) {
    const key = entry.case;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(project(entry));
  }
  return map;
}

function compareGroups(label, a, b, details) {
  const left = group(a, entry => entry);
  const right = group(b, entry => entry);
  let ok = true;
  const names = new Set([...left.keys(), ...right.keys()]);
  for (const name of names) {
    const one = JSON.stringify(left.get(name) || []);
    const two = JSON.stringify(right.get(name) || []);
    if (one !== two) {
      ok = false;
      details.push({ label, case: name, node: left.get(name) || [], rust: right.get(name) || [] });
    }
  }
  return ok;
}

main({
  name: 'provider-misc',
  mount(app, { repo, work }) {
    scriptFile = path.join(work, 'scenario.json');
    scenarioFile = scriptFile;
    rustTraceFile = path.join(work, 'rust-trace.ndjson');
    fs.writeFileSync(scenarioFile, JSON.stringify({ case: 'mount' }));
    fs.writeFileSync(rustTraceFile, '');
    const scenario = () => readScenario();
    const httpFake = fakeHttp();
    const vault = fakeVault();
    const { mountLegacyProviderMiscRoutes } = require(path.join(repo, 'tests/helpers/legacy-provider-misc-routes'));
    mountLegacyProviderMiscRoutes(app, {
      http: httpFake,
      getPort: () => 4321,
      now: () => 1700000000000,
      providers: {
        WIRE_DEFAULT_MODEL: 'claude-sonnet-4-5',
        getProvider(appType, id) {
          const current = scenario();
          if (current.providerError) throw new Error(current.providerError.message);
          const provider = current.provider;
          return provider && provider.appType === appType && provider.id === id ? provider : null;
        },
        resolveCodexDirectHttp() {
          return scenario().codexTarget || { canDirect: false };
        },
        listProviders(filter) {
          nodeV1.push({ case: scenario().case, appType: filter || null });
          if (scenario().v1Error) throw new Error(scenario().v1Error.message);
          const list = scenario().v1Providers || [];
          return filter ? list.filter(item => item.appType === filter) : list;
        },
      },
      providerRouterRuntime: {
        getProviderSummary() { return scenario().summary || {}; },
      },
      routingTest: { vault, fetchImpl: fakeFetch() },
    });
    upstreamText = upstreamSource(repo);
  },
  get upstream() { return upstreamText; },
  gatewayEnv: (work) => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    PROVIDER_MISC_SCENARIO: path.join(work, 'scenario.json'),
    PROVIDER_MISC_RUST_TRACE: path.join(work, 'rust-trace.ndjson'),
    MULTICC_ROUTING_TEST_URL: `http://127.0.0.1:${jevPort}/jev`,
  }),
  corpus() {
    const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
    const J = Object.assign({}, L, { 'Content-Type': 'application/json' });
    const get = url => ({ method: 'GET', url, headers: L });
    const head = url => ({ method: 'HEAD', url, headers: L });
    const options = url => ({ method: 'OPTIONS', url, headers: L });
    const post = (url, body) => ({
      method: 'POST', url, headers: J,
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });

    const cases = [];
    function add(name, scenarioBody, request, extra) {
      const isHead = request && typeof request === 'object' && request.method === 'HEAD';
      const hooks = {
        before() {
          const value = Object.assign({}, scenarioBody, { case: name });
          fs.writeFileSync(scenarioFile, JSON.stringify(value));
        },
        capture,
        normalize(view, side) {
          if (!isHead) {
            if (view.headers.etag !== undefined) {
              view.headers.etag = side.state.etagOk ? '<etag:body>' : '<etag:MISMATCH>';
            }
            if (view.headers['content-length'] !== undefined) {
              view.headers['content-length'] = side.state.lengthOk ? '<length:body>' : '<length:MISMATCH>';
            }
          }
          return extra && extra.normalize ? extra.normalize(view, side) : view;
        },
      };
      if (extra && extra.expectedDifference) hooks.expectedDifference = extra.expectedDifference;
      cases.push([name, request, hooks]);
    }

    // ── speed test ─────────────────────────────────────────────────────────
    const S = (overrides) => sc(overrides);
    add('speed 404 provider missing', S({ provider: null }), post('/api/providers/claude/nope/speedtest', {}));
    add('speed host provider throws', S({ providerError: { message: 'store exploded at /Users/alice/private' } }),
      post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed official codex no model', S({
      provider: officialCodexProvider(), summary: {},
    }), post('/api/providers/codex/codex-official/speedtest', {}));
    add('speed official codex ok', S({
      provider: officialCodexProvider(), summary: { model: 'gpt-5.1-codex' },
    }), post('/api/providers/codex/codex-official/speedtest', {}));
    add('speed official codex 400', S({
      provider: officialCodexProvider(), summary: { model: 'gpt-5.1-codex' },
      speedtest: { status: 400, body: '{"error":{"message":"bad request"}}' },
    }), post('/api/providers/codex/codex-official/speedtest', {}));
    add('speed official codex envelope error', S({
      provider: officialCodexProvider(), summary: { model: 'gpt-5.1-codex' },
      speedtest: { status: 200, body: 'event: response.failed\ndata: {"error":{"message":"quota exhausted"}}\n' },
    }), post('/api/providers/codex/codex-official/speedtest', {}));
    add('speed official codex 502 json error', S({
      provider: officialCodexProvider(), summary: { model: 'gpt-5.1-codex' },
      speedtest: { status: 502, body: '{"error":{"message":"upstream down"}}' },
    }), post('/api/providers/codex/codex-official/speedtest', {}));
    add('speed official codex too large', S({
      provider: officialCodexProvider(), summary: { model: 'gpt-5.1-codex' },
      speedtest: { status: 502, body: 'x'.repeat(70 * 1024) },
    }), post('/api/providers/codex/codex-official/speedtest', {}));
    add('speed official codex timeout', S({
      provider: officialCodexProvider(), summary: { model: 'gpt-5.1-codex' },
      speedtest: { timeout: true },
    }), post('/api/providers/codex/codex-official/speedtest', {}));
    add('speed codex cannot direct with reason', S({
      provider: codexProvider(), codexTarget: { canDirect: false, reason: 'OAuth subscription has no HTTP key' },
    }), post('/api/providers/codex/codex-1/speedtest', {}));
    add('speed codex cannot direct fallback reason', S({
      provider: codexProvider(), codexTarget: { canDirect: false },
    }), post('/api/providers/codex/codex-1/speedtest', {}));
    add('speed codex model from options', S({
      provider: codexProvider(),
      codexTarget: { canDirect: true, modelOptions: ['gpt-5-codex', 'gpt-4o-mini'], model: 'gpt-4o-mini' },
    }), post('/api/providers/codex/codex-1/speedtest', {}));
    add('speed codex model from target', S({
      provider: codexProvider(), codexTarget: { canDirect: true, modelOptions: [], model: 'gpt-4.1' },
    }), post('/api/providers/codex/codex-1/speedtest', {}));
    add('speed codex model default', S({
      provider: codexProvider(), codexTarget: { canDirect: true },
    }), post('/api/providers/codex/codex-1/speedtest', {}));
    add('speed claude no key no base', S({
      provider: { id: 'claude-1', appType: 'claude', name: 'Bare', settingsConfig: { env: {} } },
      summary: { model: 'claude-haiku-4-5' },
    }), post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed claude base without key', S({
      provider: { id: 'claude-1', appType: 'claude', name: 'Base', settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://relay.example' } } },
      summary: { model: 'claude-haiku-4-5' },
    }), post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed claude key without base', S({
      provider: { id: 'claude-1', appType: 'claude', name: 'Key', settingsConfig: { env: { ANTHROPIC_API_KEY: 'sk-test' } } },
      summary: { model: 'claude-haiku-4-5' },
    }), post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed claude explicit model', S({
      provider: { id: 'claude-1', appType: 'claude', name: 'Explicit', settingsConfig: { env: {
        ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_API_KEY: 'sk-test',
        ANTHROPIC_MODEL: 'claude-opus-5',
      } } },
      summary: { model: 'claude-sonnet-5' },
    }), post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed claude haiku env', S({
      provider: { id: 'claude-1', appType: 'claude', name: 'Haiku', settingsConfig: { env: {
        ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_API_KEY: 'sk-test',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
      } } },
      summary: { model: 'claude-sonnet-5' },
    }), post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed claude summary model', S({
      summary: { model: 'claude-sonnet-5', modelOptions: ['claude-opus-5'] },
    }), post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed claude haiku option', S({
      summary: { model: '', modelOptions: ['claude-opus-5', 'claude-haiku-4-5'] },
    }), post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed claude strips context suffix', S({
      summary: { model: '', modelOptions: ['claude-opus-5[1m]', 'claude-sonnet-5'] },
    }), post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed claude relay fallback models', S({
      provider: { id: 'claude-1', appType: 'claude', name: 'Borrowed', settingsConfig: { env: {
        ANTHROPIC_BASE_URL: 'https://lender.example:3000/claude-proxy/claude-official-abc/remote',
        ANTHROPIC_AUTH_TOKEN: 'mcr1.abcdefghijklmnop.secret',
      } } },
      summary: { model: '', modelOptions: [] },
    }), post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed claude wire default', S({
      provider: { id: 'claude-1', appType: 'claude', name: 'Default', settingsConfig: { env: {
        ANTHROPIC_BASE_URL: 'https://plain.example', ANTHROPIC_API_KEY: 'sk-test',
      } } },
      summary: { model: '', modelOptions: [] },
    }), post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed claude official oauth no key', S({
      provider: { id: 'claude-official', appType: 'claude', name: 'Official', source: 'ccswitch',
        settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } },
      summary: { model: 'claude-sonnet-5' },
    }), post('/api/providers/claude/claude-official/speedtest', {}));
    add('speed claude account marker is official', S({
      provider: { id: 'claude-acct', appType: 'claude', name: 'Account', settingsConfig: {
        officialAccount: { id: 'acct-1' },
        env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
      } },
      summary: { model: 'claude-sonnet-5' },
    }), post('/api/providers/claude/claude-acct/speedtest', {}));
    add('speed upstream 201', S({ speedtest: { status: 201, body: '{}' } }),
      post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed upstream 204', S({ speedtest: { status: 204, body: '' } }),
      post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed upstream 401 json', S({ speedtest: { status: 401, body: '{"error":{"message":"invalid api key"}}' } }),
      post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed upstream 500 text', S({ speedtest: { status: 500, body: 'plain overflow' } }),
      post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed envelope status failed', S({ speedtest: { status: 200, body: '{"status":"failed"}' } }),
      post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed envelope error object', S({ speedtest: { status: 200, body: '{"error":{"message":"bad auth"}}' } }),
      post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed envelope message regex', S({ speedtest: { status: 200, body: 'event: failed\nmessage: "rate limited"\n' } }),
      post('/api/providers/claude/claude-1/speedtest', {}));
    add('speed trailing slash', S(), post('/api/providers/claude/claude-1/speedtest/', {}));
    add('speed unicode id', S({ provider: { id: 'claude✓', appType: 'claude', name: 'Unicode',
      settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_API_KEY: 'sk-test' } } } }),
    post('/api/providers/claude/claude%E2%9C%93/speedtest', {}));
    add('speed id with space', S({ provider: { id: 'claude one', appType: 'claude', name: 'Space',
      settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_API_KEY: 'sk-test' } } } }),
    post('/api/providers/claude/claude%20one/speedtest', {}));
    add('speed query ignored', S(), post('/api/providers/claude/claude-1/speedtest?beta=true', {}));
    add('speed OPTIONS', S(), options('/api/providers/claude/claude-1/speedtest'));
    add('speed HEAD forwarded', S(), head('/api/providers/claude/claude-1/speedtest'), {
      expectedDifference: {
        node: view => view.status === 404,
        // Express sends no body for HEAD, so the stub's marker is not visible.
        rust: view => view.status === 599 && view.body === ''
          && view.headers['content-type'] === 'text/plain; charset=utf-8',
      },
    });
    add('speed GET forwarded', S(), get('/api/providers/claude/claude-1/speedtest'), {
      expectedDifference: {
        node: view => view.status === 404,
        rust: view => view.status === 599 && view.body === 'gateway-forwarded:GET /api/providers/claude/claude-1/speedtest',
      },
    });

    // ── GET /api/v1/providers ──────────────────────────────────────────────
    const V = (overrides) => sc(overrides);
    add('v1 base', V(), get('/api/v1/providers'));
    add('v1 filter claude', V(), get('/api/v1/providers?appType=claude'));
    add('v1 filter codex', V(), get('/api/v1/providers?appType=codex'));
    add('v1 filter trimmed', V(), get('/api/v1/providers?appType=%20claude%20'));
    add('v1 filter empty', V(), get('/api/v1/providers?appType='));
    add('v1 filter unknown', V(), get('/api/v1/providers?appType=opencode'));
    add('v1 filter repeated', V(), get('/api/v1/providers?appType=claude&appType=codex'));
    add('v1 filter nested', V(), get('/api/v1/providers?appType[x]=1'));
    add('v1 empty list', V({ v1Providers: [] }), get('/api/v1/providers'));
    add('v1 duplicate model options', V({ v1Providers: [{
      id: 'p1', appType: 'claude', name: 'Dup', model: 'm', modelOptions: ['a', 'a', 'b'],
    }] }), get('/api/v1/providers'));
    add('v1 non-string model options', V({ v1Providers: [{
      id: 'p1', appType: 'claude', name: 'Odd', model: 42, modelOptions: ['a', 7, null, 'b'],
    }] }), get('/api/v1/providers'));
    add('v1 incompatible clis filtered', V({ v1Providers: [{
      id: 'p1', appType: 'claude', name: 'Clis', compatibleClis: ['claude', 'codex', 'bogus'],
    }] }), get('/api/v1/providers'));
    add('v1 ccswitch source', V({ v1Providers: [{
      id: 'p1', appType: 'claude', name: 'Imported', source: 'ccswitch', hasToken: true,
    }] }), get('/api/v1/providers'));
    add('v1 no credentials', V({ v1Providers: [{
      id: 'p1', appType: 'codex', name: 'Public', hasToken: false, wireApi: 'messages',
    }] }), get('/api/v1/providers'));
    add('v1 unknown appType becomes claude', V({ v1Providers: [{
      id: 'p1', appType: 'opencode', name: 'Other',
    }] }), get('/api/v1/providers'));
    add('v1 long name and model sliced', V({ v1Providers: [{
      id: 'p1', appType: 'claude', name: 'n'.repeat(200), model: 'm'.repeat(200),
    }] }), get('/api/v1/providers'));
    add('v1 missing id is internal error', V({ v1Providers: [{ appType: 'claude', name: 'No id' }] }),
      get('/api/v1/providers'));
    add('v1 missing name is internal error', V({ v1Providers: [{ id: 'p1', appType: 'claude' }] }),
      get('/api/v1/providers'));
    add('v1 list throws', V({ v1Error: { message: 'cannot read /Users/alice/private.json' } }),
      get('/api/v1/providers'));
    add('v1 HEAD', V(), head('/api/v1/providers'));
    add('v1 OPTIONS', V(), options('/api/v1/providers'));
    add('v1 trailing slash', V(), get('/api/v1/providers/'));
    add('v1 mixed case', V(), get('/api/V1/Providers'));
    add('v1 supplied correlation id', V(), {
      method: 'GET', url: '/api/v1/providers',
      headers: { Host: 'localhost', 'X-Request-Id': 'req-abc', 'X-Correlation-Id': 'corr-xyz' },
    });

    // ── POST /api/auto-provider/routing/test ───────────────────────────────
    const R = (overrides) => sc(overrides);
    add('routing success t1', R(), post('/api/auto-provider/routing/test', {}));
    add('routing custom gateway', R(), post('/api/auto-provider/routing/test', {
      gateway: 'custom', endpoint: 'https://jev.example/v1/evaluate', apiKeyName: 'JEV_CUSTOM_API_KEY',
    }));
    add('routing openrouter gateway', R(), post('/api/auto-provider/routing/test', { gateway: 'openrouter' }));
    add('routing explicit text', R(), post('/api/auto-provider/routing/test', { text: 'rename a variable' }));
    add('routing long text', R(), post('/api/auto-provider/routing/test', { text: 'x'.repeat(2500) }));
    add('routing invalid key name', R(), post('/api/auto-provider/routing/test', { apiKeyName: '../etc/passwd' }));
    add('routing invalid gateway', R(), post('/api/auto-provider/routing/test', { gateway: 'anthropic' }));
    add('routing custom http endpoint', R(), post('/api/auto-provider/routing/test', {
      gateway: 'custom', endpoint: 'http://jev.example/v1',
    }));
    add('routing custom bad key', R(), post('/api/auto-provider/routing/test', {
      gateway: 'custom', endpoint: 'https://jev.example/v1', apiKeyName: 'github_token',
    }));
    add('routing missing vault entry', R({ secret: { reveal: { ok: false } } }),
      post('/api/auto-provider/routing/test', {}));
    add('routing jev 401', R({
      jev: { status: 401, body: '{"error":{"message":"Invalid API key provided"}}' },
    }), post('/api/auto-provider/routing/test', {}));
    add('routing jev 500 text', R({ jev: { status: 500, body: 'overloaded' } }),
      post('/api/auto-provider/routing/test', {}));
    add('routing jev empty body', R({ jev: { status: 200, body: '' } }),
      post('/api/auto-provider/routing/test', {}));
    add('routing jev no answers', R({ jev: { status: 200, body: '{"providerMetadata":{}}' } }),
      post('/api/auto-provider/routing/test', {}));
    add('routing jev empty answers', R({ jev: { status: 200, body: '{"answers":{}}' } }),
      post('/api/auto-provider/routing/test', {}));
    add('routing low confidence escalates', R({ jev: { status: 200, body: JSON.stringify({
      answers: {
        tier: { type: 'choice', choice: 't1', probabilities: { t1: 0.9, t2: 0.1 } },
        complexity: { type: 'score', score: 0, probabilities: [0.9, 0.1] },
      },
      providerMetadata: { typesafe: { confidence: { tier: 0.2, complexity: 0.9 } } },
    }) } }), post('/api/auto-provider/routing/test', {}));
    add('routing missing confidence escalates', R({ jev: { status: 200, body: JSON.stringify({
      answers: {
        tier: { type: 'choice', choice: 't1', probabilities: { t1: 0.9, t2: 0.1 } },
        complexity: { type: 'score', score: 0, probabilities: [0.9, 0.1] },
      },
    }) } }), post('/api/auto-provider/routing/test', {}));
    add('routing complexity escalates', R({ jev: { status: 200, body: JSON.stringify({
      answers: {
        tier: { type: 'choice', choice: 't1', probabilities: { t1: 0.9, t2: 0.1 } },
        complexity: { type: 'score', score: 3, probabilities: [0.1, 0.9] },
      },
      providerMetadata: { typesafe: { confidence: { tier: 0.9, complexity: 0.9 } } },
    }) } }), post('/api/auto-provider/routing/test', {}));
    add('routing low tier probability', R({ jev: { status: 200, body: JSON.stringify({
      answers: {
        tier: { type: 'choice', choice: 't1', probabilities: { t1: 0.2, t2: 0.8 } },
        complexity: { type: 'score', score: 0, probabilities: [0.2, 0.8] },
      },
      providerMetadata: { typesafe: { confidence: { tier: 0.9, complexity: 0.9 } } },
    }) } }), post('/api/auto-provider/routing/test', {}));
    add('routing t2 answer', R({ jev: { status: 200, body: JSON.stringify({
      answers: {
        tier: { type: 'choice', choice: 't2', probabilities: { t1: 0.1, t2: 0.9 } },
        complexity: { type: 'score', score: 3, probabilities: [0.1, 0.9] },
      },
      providerMetadata: { typesafe: { confidence: { tier: 0.9, complexity: 0.9 } } },
    }) } }), post('/api/auto-provider/routing/test', {}));
    add('routing OPTIONS', R(), options('/api/auto-provider/routing/test'));
    add('routing GET forwarded', R(), get('/api/auto-provider/routing/test'), {
      expectedDifference: {
        node: view => view.status === 404,
        rust: view => view.status === 599 && view.body === 'gateway-forwarded:GET /api/auto-provider/routing/test',
      },
    });
    add('routing vault throws', R({ secret: { throws: true } }), post('/api/auto-provider/routing/test', {}));

    return cases;
  },
  normalize: text => text
    .replace(/"ms":\d+/g, '"ms":0')
    .replace(/"latencyMs":\d+/g, '"latencyMs":0'),
  finalize({ views }) {
    // One scripted Jev listener serves the Rust side; the Node side records
    // its fetchImpl calls. Both are keyed by the active scenario's case.
    const rust = readRustTrace();
    const rustSpeed = rust.filter(entry => entry.kind === 'speed').map(entry => ({
      case: entry.case,
      path: entry.path,
      method: entry.method,
      headers: normalizeHeaders(entry.headers),
      body: parsed(entry.body),
    }));
    const rustVault = rust.filter(entry => entry.kind === 'vault').map(entry => ({
      case: entry.case, name: entry.name, source: entry.source,
    }));
    const rustV1 = rust.filter(entry => entry.kind === 'v1').map(entry => ({
      case: entry.case, appType: entry.appType || null,
    }));
    const nodeSpeedView = nodeSpeed.map(entry => ({
      case: entry.case,
      path: entry.path,
      method: entry.method,
      headers: normalizeHeaders(entry.headers),
      body: parsed(entry.body),
    }));
    const nodeJevView = nodeJev.map(entry => ({
      case: entry.case,
      body: parsed(entry.body),
    }));
    const rustJevView = rustJev.map(entry => ({
      case: entry.case,
      body: parsed(entry.body),
    }));
    const details = [];
    let ok = true;
    const speedOk = compareGroups('speedtest request', nodeSpeedView, rustSpeed, details);
    const vaultOk = compareGroups('vault reveal', nodeVault, rustVault, details);
    const v1Ok = compareGroups('v1 list filter', nodeV1, rustV1, details);
    const jevOk = compareGroups('jev request', nodeJevView, rustJevView, details);
    ok = speedOk && vaultOk && v1Ok && jevOk;
    if (!ok) console.log(JSON.stringify(details));
    return { ok, details };
  },
});

// Start the scripted Jev listener before main() runs (gatewayEnv needs its
// port). It reads the same scenario file as every other fake and records each
// request so finalize() can compare the question bodies. unref() keeps it from
// holding the process open after the run.
(function startJev() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let scenario = {};
      try { scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8')); } catch (_) {}
      const answer = scenario.jev || {};
      rustJev.push({
        case: scenario.case,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const status = answer.status || 200;
      const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body || {});
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    });
  });
  server.listen(0, '127.0.0.1', () => {
    jevPort = server.address().port;
    server.unref();
  });
}());
