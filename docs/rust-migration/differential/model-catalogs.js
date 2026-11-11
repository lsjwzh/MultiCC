'use strict';
// Differential run that retired the model catalog routes from Node:
//
//   GET|HEAD /api/{opencode,qoder,grok,commandcode,codebuddy}/models
//   GET|HEAD /api/providers/:id/models
//   GET|HEAD /api/codex/models
//   POST     /api/codex/models/sync
//
// (src/routes/{opencode,qoder,grok,commandcode,codebuddy,provider,codex}-models.js),
// now answered by native/gateway/src/app/model_catalogs.rs.
//
//   node docs/rust-migration/differential/model-catalogs.js \
//     <repo> <multicc-gateway> <multicc_core.node>
//
// The Node side mounts the frozen routes (tests/helpers/legacy-model-catalog-routes.js)
// against an in-memory harness with injected CLI listers, provider runtime and
// Codex account runtime. The front door asks its host port
// (/api/__host/model-catalogs) for the same facts; the stub Node child here
// answers from one script (work/model-catalogs-script.json) that is built from
// the very same scenario objects, so both sides see identical input. No real
// CLI is spawned and no network is touched.
//
// Corpus shape: normal answers, the refresh conventions of every route, the
// Express path behaviors, the 503 shapes, the provider live catalog and the
// four Codex branches (official peek/kick, legacy wait, relay reshape, 404/400).
// Host-port-down cases come last: they are the one documented difference (Node
// had no such failure mode) and they leave the two sides' refresh flags unable
// to agree, so nothing may read state afterwards.
const fs = require('fs');
const path = require('path');
const { main } = require('./lib');

const HOST_PATH = '/api/__host/model-catalogs';
const UNAVAILABLE_BODY = {
  error: '模型目录接口尚未就绪，请更新原生模块',
  code: 'rust_backend_unavailable',
};

let scriptPath = '';
// What the oracle's injected fakes read. One scenario per corpus case.
let oracleState = null;
let upstreamText = '';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function catalogRow(provider, model, extra = {}) {
  return { provider, model, label: `${provider}/${model}`, ...extra };
}

function cliEntry(plainModels, refreshedModels, source) {
  return {
    plain: { ok: true, models: plainModels, source },
    refreshed: { ok: true, models: refreshedModels, source: 'cli' },
  };
}

function providerEntry(plainBody, refreshedBody) {
  return {
    plain: { status: 200, body: plainBody },
    refreshed: { status: 200, body: refreshedBody },
  };
}

function baseScenario() {
  return {
    catalogs: {
      opencode: cliEntry(
        [catalogRow('opencode', 'big-pickle'), catalogRow('opencode', 'gpt-5-nano')],
        [catalogRow('opencode', 'big-pickle'), catalogRow('opencode', 'gpt-6')],
        'cache'),
      qoder: cliEntry(
        [{ model: 'Auto', label: 'Auto' }, { model: 'ultimate', label: 'ultimate' }],
        [{ model: 'GLM-5.2', label: 'GLM-5.2' }],
        'cache'),
      grok: cliEntry(
        [{ model: 'grok-4.6', label: 'grok-4.6', isDefault: true },
          { model: 'grok-4.5', label: 'grok-4.5', isDefault: false }],
        [{ model: 'grok-5', label: 'grok-5', isDefault: true }],
        'cli'),
      commandcode: cliEntry(
        [{ model: 'moonshotai/kimi-k3', label: 'moonshotai/kimi-k3', group: 'Open Source', description: 'Kimi K3' },
          { model: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5', group: 'Anthropic', description: 'Claude Sonnet' }],
        [{ model: 'moonshotai/kimi-k4', label: 'moonshotai/kimi-k4', group: 'Open Source', description: 'Kimi K4' }],
        'cli'),
      codebuddy: cliEntry(
        [{ model: 'glm-5.3', label: 'glm-5.3' }, { model: 'deepseek-v4-pro', label: 'deepseek-v4-pro' }],
        [{ model: 'glm-6', label: 'glm-6' }],
        'cli'),
    },
    providers: {
      Main: providerEntry(
        { models: [{ model: 'deepseek-v4.1', label: 'DeepSeek V4.1' }, { model: 'kimi-k3', label: 'kimi-k3' }], source: 'live', cached: true },
        { models: [{ model: 'deepseek-v4.2', label: 'DeepSeek V4.2' }], source: 'live', cached: false }),
      'My Relay': providerEntry(
        { models: [{ model: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' }], source: 'live', cached: true },
        { models: [{ model: 'anthropic/claude-opus-5', label: 'Claude Opus 5' }], source: 'live', cached: false }),
      relay: providerEntry(
        // One row without a label exercises the `label || model` fallback.
        { models: [{ model: 'deepseek-v4.1', label: 'DeepSeek V4.1' }, { model: 'glm-5.3' }], source: 'live', cached: true },
        { models: [{ model: 'deepseek-v4.2', label: 'DeepSeek V4.2' }], source: 'live', cached: false }),
    },
    codex: {
      states: {
        'codex-official': {
          found: true, id: 'codex-official', appType: 'codex', official: true,
          peek: {
            catalogFetchedAt: null,
            models: [{ model: 'gpt-5-codex', label: 'GPT-5 Codex', isDefault: true },
              { model: 'gpt-5', label: 'GPT-5', isDefault: false }],
            source: 'memory_cache', cached: true, stale: false, available: true,
            fetchedAt: 1700000000000, cliVersion: '0.50.0',
            diagnostic: { code: 'ok', message: 'ok' }, fallback: 'codex_default',
          },
          refreshing: false,
        },
        'codex-busy': {
          found: true, id: 'codex-busy', appType: 'codex', official: true,
          peek: {
            catalogFetchedAt: null, models: [], source: 'fallback', cached: false,
            stale: false, available: false, fetchedAt: null, cliVersion: null,
            diagnostic: { code: 'cli_error', message: 'Codex catalog unavailable' },
            fallback: 'codex_default',
          },
          refreshing: true,
        },
        'claude-line': { found: true, id: 'claude-line', appType: 'claude', official: false },
        relay: { found: true, id: 'relay', appType: 'codex', official: false },
      },
      peekAfterRefresh: {
        catalogFetchedAt: 1700000005000,
        models: [{ model: 'gpt-6-sol', label: 'GPT-6 Sol', isDefault: true }],
        source: 'cli', cached: false, stale: false, available: true,
        fetchedAt: 1700000005000, cliVersion: '0.51.0',
        diagnostic: { code: 'ok', message: 'ok' }, fallback: 'codex_default',
      },
    },
  };
}

// ── oracle side: injected dependencies ──────────────────────────────────────

function current() {
  return oracleState || baseScenario();
}

function catalogLister(op) {
  return (callback, opts = {}) => {
    const entry = (current().catalogs || {})[op];
    if (!entry || entry.fail) {
      return setImmediate(() => callback(new Error(`${op} models unavailable`), []));
    }
    const answer = opts.refresh === true ? entry.refreshed : entry.plain;
    setImmediate(() => callback(null, clone(answer.models), answer.source));
  };
}

const providerRuntime = {
  async listProviderModels(rawId, opts = {}) {
    const id = String(rawId == null ? '' : rawId).trim();
    const entry = (current().providers || {})[id];
    if (!entry) return { status: 404, body: { error: 'provider not found' } };
    const answer = opts.refresh === true ? entry.refreshed : entry.plain;
    return clone(answer);
  },
};

// The stub child keeps its own `refreshed` flag; this one moves in lockstep
// because every kick/wait on one side has an identical call on the other.
let refreshed = false;

const accountRuntime = {
  resolveProvider(providerId) {
    const state = ((current().codex || {}).states || {})[providerId];
    return state ? clone(state) : null;
  },
  refreshProvider() {
    refreshed = true;
    return Promise.resolve();
  },
  peekProvider(provider) {
    if (refreshed && (current().codex || {}).peekAfterRefresh) {
      return clone(current().codex.peekAfterRefresh);
    }
    return provider && provider.peek != null ? clone(provider.peek) : null;
  },
  isRefreshing(provider) {
    return !!(provider && provider.refreshing === true);
  },
};

function isOfficialCodexOAuthProvider(provider) {
  return !!(provider && provider.official === true);
}

// ── stub Node child: the host port, scripted ────────────────────────────────

function upstreamSource(repo) {
  return `'use strict';
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const REPO = ${JSON.stringify(repo)};
const { createAuthSecurity } = require(path.join(REPO, 'src/auth-security'));
const { connectAuthControl } = require(path.join(REPO, 'src/gateway-child'));
globalThis.__gatewayAuthSecurity = createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
connectAuthControl(globalThis.__gatewayAuthSecurity);
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();

const HOST_PATH = ${JSON.stringify(HOST_PATH)};
const scriptPath = process.env.STUB_SCRIPT;
let refreshed = false;

function scenario() {
  try { return JSON.parse(fs.readFileSync(scriptPath, 'utf8')); } catch (_) { return {}; }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.split('?')[0] === HOST_PATH) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const script = scenario();
      if (script.hostDown === true) { req.socket.destroy(); return; }
      let input = {};
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) {}
      const send = value => {
        const text = JSON.stringify(value);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };
      const catalogs = script.catalogs || {};
      if (Object.prototype.hasOwnProperty.call(catalogs, input.op)) {
        const entry = catalogs[input.op];
        if (!entry || entry.fail) return send({ ok: false, error: input.op + ' models unavailable' });
        const answer = input.refresh === true ? entry.refreshed : entry.plain;
        return send({ ok: true, models: (answer && answer.models) || [], source: (answer && answer.source) || '' });
      }
      if (input.op === 'provider') {
        const entry = (script.providers || {})[input.providerId];
        if (!entry) return send({ status: 404, body: { error: 'provider not found' } });
        return send(input.refresh === true ? entry.refreshed : entry.plain);
      }
      if (input.op === 'codex-state') {
        const codex = script.codex || {};
        const state = (codex.states || {})[input.providerId];
        if (!state) return send({ found: false });
        if (refreshed && codex.peekAfterRefresh) return send({ ...state, peek: codex.peekAfterRefresh });
        return send(state);
      }
      if (input.op === 'codex-refresh') {
        if ((script.codex || {}).refreshError === true) return send({ error: true });
        refreshed = true;
        return send({ ok: true });
      }
      send({ error: true });
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

// ── corpus ──────────────────────────────────────────────────────────────────

function useScenario(scenario, extra = {}) {
  return {
    before(side) {
      oracleState = scenario;
      // The stub child is a separate process; it reads the same scenario from
      // this file at host-call time. Written only for the Rust side, which is
      // the one that talks to it.
      if (side.name === 'rust') fs.writeFileSync(scriptPath, JSON.stringify(scenario));
    },
    ...extra,
  };
}

function rustUnavailable(view) {
  try {
    const body = JSON.parse(view.body);
    return view.status === 503 && body.code === UNAVAILABLE_BODY.code;
  } catch (_) {
    return false;
  }
}

function corpus() {
  const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
  const J = { ...L, 'Content-Type': 'application/json' };
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = url => ({ method: 'HEAD', url, headers: L });
  const options = url => ({ method: 'OPTIONS', url, headers: L });
  const post = (url, body) => ({ method: 'POST', url, headers: J, body: JSON.stringify(body) });
  const cases = [];
  const add = (name, request, scenario = baseScenario(), extra = {}) =>
    cases.push([name, request, useScenario(scenario, extra)]);

  // Normal answers: the retired shape for every CLI catalog.
  for (const op of ['opencode', 'qoder', 'grok', 'commandcode', 'codebuddy']) {
    add(`GET ${op}`, get(`/api/${op}/models`));
  }

  // Refresh conventions: opencode compares === '1'; the other four accept /^(?:1|true)$/i.
  add('GET opencode refresh=1', get('/api/opencode/models?refresh=1'));
  add('GET opencode refresh=true', get('/api/opencode/models?refresh=true'));
  add('GET opencode refresh=TRUE', get('/api/opencode/models?refresh=TRUE'));
  add('GET qoder refresh=true', get('/api/qoder/models?refresh=true'));
  add('GET qoder refresh=TRUE', get('/api/qoder/models?refresh=TRUE'));
  add('GET qoder refresh=1', get('/api/qoder/models?refresh=1'));
  add('GET grok refresh=1', get('/api/grok/models?refresh=1'));
  add('GET grok refresh=0', get('/api/grok/models?refresh=0'));
  add('GET commandcode refresh=true', get('/api/commandcode/models?refresh=true'));
  add('GET commandcode refresh=0', get('/api/commandcode/models?refresh=0'));
  add('GET codebuddy refresh', get('/api/codebuddy/models?refresh'));
  add('GET codebuddy refresh=FALSE', get('/api/codebuddy/models?refresh=FALSE'));

  // Express path behaviors: one trailing slash, case-insensitive literals.
  add('GET qoder trailing slash', get('/api/qoder/models/'));
  add('GET Qoder mixed case', get('/api/Qoder/Models/'));
  add('GET OpenCode mixed case', get('/api/OpenCode/Models'));
  add('GET CommandCode mixed case', get('/api/CommandCode/Models/'));
  add('HEAD opencode', head('/api/opencode/models'));
  add('HEAD grok refresh=1', head('/api/grok/models?refresh=1'));

  // Express's automatic OPTIONS: GET,HEAD for reads, POST for the sync.
  for (const route of ['opencode', 'qoder', 'grok', 'commandcode', 'codebuddy']) {
    add(`OPTIONS ${route}`, options(`/api/${route}/models`));
  }
  add('OPTIONS provider', options('/api/providers/Main/models'));
  add('OPTIONS codex', options('/api/codex/models'));
  add('OPTIONS codex sync', options('/api/codex/models/sync'));

  // Provider live catalog: the :id is decoded, case-preserved, and the route
  // always stamps Cache-Control: no-store (404s included).
  add('GET provider Main', get('/api/providers/Main/models'));
  add('GET provider Main refresh=1', get('/api/providers/Main/models?refresh=1'));
  add('GET provider Main refresh=TRUE', get('/api/providers/Main/models?refresh=TRUE'));
  add('GET provider My Relay encoded', get('/api/providers/My%20Relay/models'));
  add('GET provider My Relay mixed case', get('/api/Providers/My%20Relay/Models/'));
  add('HEAD provider Main', head('/api/providers/Main/models'));
  add('GET provider missing', get('/api/providers/ghost/models'));

  // Codex, in order: the two poll-only reads must happen before anything kicks
  // a refresh, because the post-refresh peek is the one that wins afterwards.
  add('GET codex busy poll=1', get('/api/codex/models?providerId=codex-busy&poll=1'));
  add('GET codex official poll=1', get('/api/codex/models?providerId=codex-official&poll=1'));
  add('GET codex official poll=TRUE', get('/api/codex/models?providerId=codex-official&poll=TRUE'));
  add('GET codex official kick', get('/api/codex/models?providerId=codex-official'));
  add('GET codex official poll after kick', get('/api/codex/models?providerId=codex-official&poll=1'));
  add('GET codex legacy wait', get('/api/codex/models'));
  add('GET codex legacy wait with poll', get('/api/codex/models?poll=1'));
  add('GET codex relay', get('/api/codex/models?providerId=relay'));
  add('GET codex relay refresh=1', get('/api/codex/models?providerId=relay&refresh=1'));
  add('GET codex missing provider', get('/api/codex/models?providerId=ghost'));
  add('GET codex wrong app type', get('/api/codex/models?providerId=claude-line'));
  add('GET codex mixed case', get('/api/Codex/Models?providerId=codex-official&poll=1'));
  add('HEAD codex poll', head('/api/codex/models?providerId=codex-official&poll=1'));
  add('POST codex sync provider in body', post('/api/codex/models/sync', { providerId: 'codex-official' }));
  add('POST codex sync missing provider', post('/api/codex/models/sync', { providerId: 'ghost' }));
  add('POST codex sync no body', { method: 'POST', url: '/api/codex/models/sync', headers: L });

  // 503 shapes both sides answer themselves: the CLI enumeration failed.
  for (const op of ['opencode', 'qoder', 'grok', 'commandcode', 'codebuddy']) {
    const scenario = baseScenario();
    scenario.catalogs[op] = { fail: true };
    add(`GET ${op} cli failure`, get(`/api/${op}/models`), scenario);
  }

  // Host-port-down: the Rust front door answers 503 rust_backend_unavailable;
  // Node had no such failure mode, so these are documented differences. They
  // come last because the oracle keeps running (and its refresh flag moves)
  // where the stub never answers.
  {
    const scenario = baseScenario();
    scenario.hostDown = true;
    add('GET provider host down', get('/api/providers/Main/models'), scenario, {
      expectedDifference: {
        node: view => view.status === 200,
        rust: rustUnavailable,
      },
    });
  }
  {
    const scenario = baseScenario();
    scenario.hostDown = true;
    add('GET codex host down', get('/api/codex/models?providerId=codex-official&poll=1'), scenario, {
      expectedDifference: {
        node: view => view.status === 200,
        rust: rustUnavailable,
      },
    });
  }

  return cases;
}

main({
  name: 'model-catalogs',
  mount(app, { repo, work }) {
    scriptPath = path.join(work, 'model-catalogs-script.json');
    oracleState = baseScenario();
    fs.writeFileSync(scriptPath, JSON.stringify(oracleState));
    const { mountLegacyModelCatalogRoutes } = require(path.join(repo, 'tests/helpers/legacy-model-catalog-routes'));
    mountLegacyModelCatalogRoutes(app, {
      cliListers: {
        opencode: catalogLister('opencode'),
        qoder: catalogLister('qoder'),
        grok: catalogLister('grok'),
        commandcode: catalogLister('commandcode'),
        codebuddy: catalogLister('codebuddy'),
      },
      providerRuntime,
      accountRuntime,
      providerModelsRuntime: providerRuntime,
      isOfficialCodexOAuthProvider,
    });
    upstreamText = upstreamSource(repo);
  },
  get upstream() {
    return upstreamText;
  },
  // The stub child loads the real auth-control bridge, which loads the native
  // addon (src/native/runtime) — the same module the front door calls.
  gatewayEnv: work => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    STUB_SCRIPT: path.join(work, 'model-catalogs-script.json'),
  }),
  corpus,
});
