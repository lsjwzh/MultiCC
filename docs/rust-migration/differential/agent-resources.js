'use strict';
// Differential run that retired the agent resource routes from Node:
//
//   GET|HEAD|OPTIONS /api/agent-resources/skills
//   GET|HEAD|OPTIONS /api/agent-presets
//   GET|HEAD|OPTIONS /api/agent-presets/:id
//   GET|HEAD|OPTIONS /api/agent-resources/claude-sessions
//   DELETE|OPTIONS   /api/agent-resources/claude-sessions/:project/:id
//   DELETE|OPTIONS   /api/agent-resources/claude-sessions?olderThanDays=N
//
// (src/routes/agent-resources.js), now answered by
// native/gateway/src/app/agent_resources.rs.
//
//   node docs/rust-migration/differential/agent-resources.js \
//     <repo> <multicc-gateway> <multicc_core.node>
//
// The Node side mounts the frozen retired handlers
// (tests/helpers/legacy-agent-resource-routes.js) with injected fakes: the
// preset file contents, the provider store used for enrichment, the installed
// skills, the Claude history rows and the per-row delete answers. One module
// level `oracleState` is replaced before every case, after which the handlers
// are mounted again — the retired code caches the preset file for the life of a
// mount, so a stale cache would turn the "unavailable" and "missing keys"
// cases into lies.
//
// The Rust front door asks its host port (/api/__host/agent-resources) for the
// same facts; the stub Node child here answers from one script
// (work/agent-resources-script.json). The preset answers in that script are
// derived with the frozen handler itself (agentPreset()), so both sides see
// byte-identical presets and provider enrichment.
//
// Corpus shape: skills counts (strict/claude/codex/other/case variants), the
// presets envelope and its absent keys, preset lookup (commander override,
// provider enrichment, decoding, 404), Claude history counts, both delete
// routes with their 409/404/500 mappings, the purge cutoff/filters, Express
// OPTIONS/HEAD behavior, two unrelated paths that must still reach Node, and
// last the documented 503 / internal_error differences.
//
// The oracle's clock is frozen at 2026-01-10T00:00:00Z so the purge cutoff is
// deterministic; the Rust side uses the real clock. Every scripted updatedAt
// is either 2020 or 2030, years away from any cutoff the two clocks can
// compute, so no assertion depends on wall-clock time.
const fs = require('fs');
const path = require('path');
const { main } = require('./lib');

const HOST_PATH = '/api/__host/agent-resources';
const ORACLE_NOW = 1768000000000; // 2026-01-10T00:00:00.000Z
const OLD_DATE = '2020-01-01T00:00:00.000Z';
const FRESH_DATE = '2030-01-01T00:00:00.000Z';
const COMMANDER_ID = 'specialized__agent-commander';

let scriptPath = '';
// What the oracle's injected fakes read. One scenario per corpus case.
let oracleState = null;
// Rebuilds the retired handlers around the current `oracleState`.
let rebuildOracle = () => {};
let legacy = null;
let upstreamText = '';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ── scenarios: one raw world, two consistent views ─────────────────────────

function basePresetsData() {
  return {
    source: 'builtin',
    version: 7,
    generatedAt: '2026-01-01T00:00:00.000Z',
    categories: [
      { id: 'specialized', name: 'Specialized' },
      { id: 'coding', name: 'Coding' },
    ],
    featured: [COMMANDER_ID, 'relay__coder'],
    presets: [
      {
        id: COMMANDER_ID,
        name: 'Agent Commander',
        prompt: 'raw commander prompt',
        defaultCli: 'codex',
        defaultProviderKey: 'openai-codex',
        defaultModel: 'gpt-5.5',
        description: 'raw description',
        vibe: 'raw vibe',
        defaultEffort: 'low',
        defaultModelNote: 'raw note',
        category: 'specialized',
      },
      {
        id: 'relay__coder',
        name: 'Relay Coder',
        prompt: 'relay prompt',
        defaultCli: 'claude',
        defaultProviderKey: 'xf-maas-coding',
        defaultModel: 'astron-code-latest',
        category: 'coding',
      },
      {
        id: 'plain__one',
        name: 'Plain One',
        prompt: 'plain prompt',
        defaultCli: 'codex',
      },
      {
        id: 'my preset',
        name: 'Spaced Name',
        prompt: 'spaced prompt',
      },
    ],
  };
}

// The provider store the retired handler's enrichment reads. `codex-official`
// is found by name for `openai-codex`, `xf-maas` by its model for
// `xf-maas-coding`; `plain__one` has no key and stays unresolved.
function baseProviders() {
  return {
    codex: [
      { id: 'codex-official', name: 'OpenAI Codex Official', modelOptions: ['gpt-5.5', 'gpt-5'] },
      { id: 'codex-backup', name: 'Backup Line', modelOptions: ['glm-6'] },
    ],
    claude: [
      { id: 'xf-maas', name: '讯飞 MaaS', modelOptions: ['astron-code-latest'] },
      { id: 'claude-relay', name: 'Relay Line', modelOptions: [] },
    ],
  };
}

function baseSkills() {
  return [
    { id: 'a', name: 'A', provider: 'claude' },
    { id: 'b', name: 'B', provider: 'codex' },
    { id: 'c', name: 'C', provider: 'claude' },
    { id: 'd', name: 'D', provider: 'other' },
    { id: 'e', name: 'E' },
    { id: 'f', name: 'F', provider: 'Claude' },
    { id: 'g', name: 'G', provider: 'codex' },
  ];
}

function baseSessions() {
  return [
    { id: 's1', project: 'proj-a', size: 100, linked: true, updatedAt: OLD_DATE },
    { id: 's2', project: 'proj-a', size: 50, updatedAt: OLD_DATE },
    { id: 's3', project: 'proj-b', size: 25, linked: false, updatedAt: OLD_DATE },
    { id: 's4', project: 'proj-b', size: 7, updatedAt: OLD_DATE },
  ];
}

function baseRemove() {
  return {
    'My Project/one': { ok: true, freed: 1234 },
    'proj-a/nofreed': { ok: true },
    'My Project/prot': { ok: false, error: 'session is protected' },
    'My Project/miss': { ok: false, error: 'not found' },
    'My Project/threw': { ok: false, threw: true },
    'My Project/nonstring': { ok: false, error: 7 },
    'proj/a/b': { ok: true, freed: 9 },
    'proj-x/id': { ok: true, freed: 3 },
  };
}

function baseOptions() {
  return {
    presetsData: basePresetsData(),
    providers: baseProviders(),
    skills: baseSkills(),
    sessions: baseSessions(),
    remove: baseRemove(),
  };
}

// A purge world: one linked, one unparsable, one with no updatedAt, one far in
// the future, two far in the past (one succeeds, one fails) — the filters and
// the accumulation of `freed` without ever touching a clock boundary.
function purgeOptions() {
  return {
    presetsData: basePresetsData(),
    providers: baseProviders(),
    skills: baseSkills(),
    sessions: [
      { id: 'linked', project: 'p', size: 1, linked: true, updatedAt: OLD_DATE },
      { id: 'garbage', project: 'p', size: 2, updatedAt: 'garbage' },
      { id: 'missing', project: 'p', size: 3 },
      { id: 'fresh', project: 'p', size: 4, updatedAt: FRESH_DATE },
      { id: 'old-one', project: 'p', size: 5, updatedAt: OLD_DATE },
      { id: 'old-two', project: 'q', size: 6, updatedAt: OLD_DATE },
      { id: 'old-fail', project: 'q', size: 7, updatedAt: OLD_DATE },
    ],
    remove: {
      'p/old-one': { ok: true, freed: 10 },
      'q/old-two': { ok: true, freed: 5 },
      'q/old-fail': { ok: false, error: 'not found' },
    },
  };
}

// ── oracle side: injected dependencies ──────────────────────────────────────

function oracleDepsFor(state) {
  const world = state || {};
  return {
    fs: {
      // Only readFileSync is used by the retired handlers.
      readFileSync() {
        if (world.presetsDown) throw new Error('agent presets file unavailable');
        return JSON.stringify(world.presetsData);
      },
    },
    presetsFile: '/virtual/agent-presets.json',
    providers: {
      listProviders(cli) {
        return clone((world.providers || {})[cli] || []);
      },
    },
    providerRouter: {
      getProviderSummary(cli, id) {
        const list = (world.providers || {})[cli] || [];
        const found = list.find(item => item.id === id);
        return found ? { id: found.id, name: found.name } : null;
      },
    },
    listInstalledSkills() {
      if (world.skillsDown) throw new Error('installed skill scan failed');
      return clone(world.skills || []);
    },
    listClaudeHistory() {
      if (world.sessionsDown) throw new Error('Claude history scan failed');
      return clone(world.sessions || []);
    },
    removeClaudeHistorySession(project, id) {
      const key = `${project}/${id}`;
      const remove = world.remove || {};
      if (!Object.prototype.hasOwnProperty.call(remove, key)) return { ok: false, error: 'not found' };
      return clone(remove[key]);
    },
    reportError() {},
    now: () => ORACLE_NOW,
  };
}

// Derives the host-port answers with the frozen handler itself, so the Rust
// side receives exactly the presets the oracle would have built.
function derivePresets(presetsData, providers) {
  const routes = legacy.createAgentResourcesRoutes(
    oracleDepsFor({ presetsData, providers }));
  const data = presetsData || {};
  const presets = (data.presets || []).map((raw) => {
    const preset = routes.agentPreset(raw.id);
    const { prompt, ...metadata } = preset;
    return metadata;
  });
  const envelope = {
    ok: true,
    source: data.source,
    version: data.version,
    generatedAt: data.generatedAt,
    categories: data.categories || [],
    featured: data.featured || [],
    presets,
  };
  const lookup = {};
  for (const raw of data.presets || []) {
    const preset = routes.agentPreset(raw.id);
    if (preset) lookup[raw.id] = preset;
  }
  return { data: envelope, presets: lookup };
}

// One object per case: `oracle` feeds the injected fakes, `agent` is the host
// port script the stub child serves, `hostDown` cuts that port.
function makeScenario(options = {}) {
  const presetsData = options.presetsData !== undefined ? options.presetsData : basePresetsData();
  const providers = options.providers !== undefined ? options.providers : baseProviders();
  const agent = {
    skills: options.skills !== undefined ? options.skills : baseSkills(),
    sessions: options.sessions !== undefined ? options.sessions : baseSessions(),
    remove: options.remove !== undefined ? options.remove : baseRemove(),
    skillsDown: options.skillsDown === true,
    sessionsDown: options.sessionsDown === true,
    presetsDown: options.presetsDown === true,
  };
  if (!agent.presetsDown) {
    const derived = derivePresets(presetsData, providers);
    agent.data = derived.data;
    agent.presets = derived.presets;
  }
  return {
    oracle: {
      presetsData,
      providers,
      skills: agent.skills,
      sessions: agent.sessions,
      remove: agent.remove,
      skillsDown: agent.skillsDown,
      sessionsDown: agent.sessionsDown,
      presetsDown: agent.presetsDown,
    },
    agent,
    hostDown: options.hostDown === true,
  };
}

function baseScenario() {
  return makeScenario(baseOptions());
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
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

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
      const agent = script.agent || {};
      if (input.op === 'skills') {
        if (agent.skillsDown === true) return send({ ok: false });
        return send({ ok: true, skills: agent.skills || [] });
      }
      if (input.op === 'presets') {
        if (agent.presetsDown === true) return send({ ok: false });
        return send(agent.data || {});
      }
      if (input.op === 'preset') {
        if (agent.presetsDown === true) return send({ ok: false });
        const presets = agent.presets || {};
        if (hasOwn(presets, input.id)) {
          return send({ ok: true, found: true, preset: presets[input.id] });
        }
        return send({ ok: true, found: false });
      }
      if (input.op === 'claude-sessions') {
        if (agent.sessionsDown === true) return send({ ok: false });
        return send({ ok: true, sessions: agent.sessions || [] });
      }
      if (input.op === 'claude-session-delete') {
        const remove = agent.remove || {};
        const key = input.project + '/' + input.id;
        return send(hasOwn(remove, key) ? remove[key] : { ok: false, error: 'not found' });
      }
      send({ ok: false });
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
      if (side.name === 'node') {
        // A fresh mount: the retired handlers cache the preset file, and the
        // corpus changes it (missing keys, unavailable, empty).
        rebuildOracle();
      } else {
        // The stub child is a separate process; it reads the same scenario
        // from this file at host-call time. Written only for the Rust side,
        // which is the one that talks to it.
        fs.writeFileSync(scriptPath, JSON.stringify(scenario));
      }
    },
    ...extra,
  };
}

function parseBody(view) {
  try { return JSON.parse(view.body); } catch (_) { return null; }
}

function rustUnavailable(view) {
  const body = parseBody(view);
  return view.status === 503 && body !== null && body.code === 'rust_backend_unavailable';
}

// The retired route crashed (listInstalledSkills / listClaudeHistory threw);
// the front door maps the host's ok:false to the family 503 instead.
function nodeInternalError(view) {
  const body = parseBody(view);
  return view.status === 500 && body !== null
    && body.ok === false && body.code === 'internal_error';
}

// An unclaimed path: Express answers its own 404, the front door forwards to
// the Node child, which answers 599 text.
function unclaimed(view, side) {
  if (side.name === 'rust') {
    if (!(view.status === 599 && String(view.body || '').startsWith('gateway-forwarded:'))) {
      view.status = `<not-forwarded:${view.status}>`;
      view.body = `<not-forwarded:${String(view.body).slice(0, 120)}>`;
      view.headers = {};
      return view;
    }
    view.status = '<unclaimed>';
    view.body = '<unclaimed>';
    view.headers = {};
    return view;
  }
  view.status = view.status === 404 ? '<unclaimed>' : `<node-did-not-404:${view.status}>`;
  view.body = '<unclaimed>';
  view.headers = {};
  return view;
}

function corpus() {
  const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = url => ({ method: 'HEAD', url, headers: L });
  const options = url => ({ method: 'OPTIONS', url, headers: L });
  const del = (url, headers = L) => ({ method: 'DELETE', url, headers });
  const cases = [];
  const add = (name, request, scenario = baseScenario(), extra = {}) =>
    cases.push([name, request, useScenario(scenario, extra)]);

  // ── skills ───────────────────────────────────────────────────────────────
  add('GET skills mixed providers', get('/api/agent-resources/skills'));
  add('GET skills empty', get('/api/agent-resources/skills'),
    makeScenario({ ...baseOptions(), skills: [] }));
  add('GET skills only case variants', get('/api/agent-resources/skills'),
    makeScenario({
      ...baseOptions(),
      skills: [
        { id: 'x', provider: 'Claude' },
        { id: 'y', provider: 'CODEX' },
        { id: 'z', provider: 'codex ' },
      ],
    }));
  add('HEAD skills', head('/api/agent-resources/skills'));
  add('GET skills mixed case trailing slash', get('/api/Agent-Resources/Skills/'));

  // ── presets envelope ─────────────────────────────────────────────────────
  add('GET presets full', get('/api/agent-presets'));
  add('HEAD presets', head('/api/agent-presets'));
  add('GET presets mixed case trailing slash', get('/api/Agent-Presets/'));

  {
    const opts = baseOptions();
    delete opts.presetsData.source;
    delete opts.presetsData.version;
    delete opts.presetsData.generatedAt;
    add('GET presets missing source/version/generatedAt', get('/api/agent-presets'),
      makeScenario(opts));
  }
  {
    const opts = baseOptions();
    delete opts.presetsData.source;
    add('GET presets missing source', get('/api/agent-presets'), makeScenario(opts));
  }
  {
    const opts = baseOptions();
    delete opts.presetsData.categories;
    delete opts.presetsData.featured;
    add('GET presets categories absent', get('/api/agent-presets'), makeScenario(opts));
  }
  {
    const opts = baseOptions();
    opts.presetsData.categories = null;
    opts.presetsData.featured = '';
    add('GET presets categories null and featured empty', get('/api/agent-presets'),
      makeScenario(opts));
  }
  {
    const opts = baseOptions();
    opts.presetsData.presets = [];
    opts.presetsData.featured = [];
    add('GET presets empty list', get('/api/agent-presets'), makeScenario(opts));
  }
  {
    const opts = baseOptions();
    delete opts.presetsData.presets;
    add('GET presets no presets key', get('/api/agent-presets'), makeScenario(opts));
  }
  // The retired 500 when the file cannot be read; the host's ok:false maps to
  // the same body, so this one is byte-identical.
  add('GET presets unavailable', get('/api/agent-presets'),
    makeScenario({ ...baseOptions(), presetsDown: true }));

  // ── one preset ───────────────────────────────────────────────────────────
  add('GET preset commander override', get(`/api/agent-presets/${COMMANDER_ID}`));
  add('GET preset relay enrichment', get('/api/agent-presets/relay__coder'));
  add('GET preset plain', get('/api/agent-presets/plain__one'));
  add('GET preset percent encoded id', get('/api/agent-presets/my%20preset'));
  add('GET preset mixed case path', get('/api/Agent-Presets/relay__coder'));
  add('GET preset trailing slash', get('/api/agent-presets/relay__coder/'));
  add('HEAD preset', head('/api/agent-presets/relay__coder'));
  add('GET preset unknown', get('/api/agent-presets/ghost'));
  add('GET preset unavailable', get('/api/agent-presets/relay__coder'),
    makeScenario({ ...baseOptions(), presetsDown: true }));

  // ── Claude sessions list ─────────────────────────────────────────────────
  add('GET claude sessions counts', get('/api/agent-resources/claude-sessions'));
  add('GET claude sessions empty', get('/api/agent-resources/claude-sessions'),
    makeScenario({ ...baseOptions(), sessions: [] }));
  add('HEAD claude sessions', head('/api/agent-resources/claude-sessions'));
  add('GET claude sessions mixed case trailing slash',
    get('/api/Agent-Resources/Claude-Sessions/'));

  // ── delete one session ───────────────────────────────────────────────────
  add('DELETE session ok', del('/api/agent-resources/claude-sessions/My%20Project/one'));
  add('DELETE session ok without freed',
    del('/api/agent-resources/claude-sessions/proj-a/nofreed'));
  add('DELETE session protected',
    del('/api/agent-resources/claude-sessions/My%20Project/prot'));
  add('DELETE session missing',
    del('/api/agent-resources/claude-sessions/My%20Project/miss'));
  add('DELETE session threw',
    del('/api/agent-resources/claude-sessions/My%20Project/threw'));
  add('DELETE session nonstring error',
    del('/api/agent-resources/claude-sessions/My%20Project/nonstring'));
  add('DELETE session encoded slash in id',
    del('/api/agent-resources/claude-sessions/proj/a%2Fb'));
  add('DELETE session mixed case path',
    del('/api/Agent-Resources/Claude-Sessions/proj-x/id'));
  add('DELETE session trailing slash',
    del('/api/agent-resources/claude-sessions/proj-x/id/'));

  // ── purge ────────────────────────────────────────────────────────────────
  add('DELETE purge missing olderThanDays', del('/api/agent-resources/claude-sessions'));
  add('DELETE purge olderThanDays=0',
    del('/api/agent-resources/claude-sessions?olderThanDays=0'));
  add('DELETE purge olderThanDays=-1',
    del('/api/agent-resources/claude-sessions?olderThanDays=-1'));
  add('DELETE purge olderThanDays=abc',
    del('/api/agent-resources/claude-sessions?olderThanDays=abc'));
  add('DELETE purge olderThanDays empty',
    del('/api/agent-resources/claude-sessions?olderThanDays='));
  add('DELETE purge olderThanDays=3',
    del('/api/agent-resources/claude-sessions?olderThanDays=3'),
    makeScenario(purgeOptions()));
  add('DELETE purge olderThanDays=2.5',
    del('/api/agent-resources/claude-sessions?olderThanDays=2.5'),
    makeScenario(purgeOptions()));
  add('DELETE purge olderThanDays=1',
    del('/api/agent-resources/claude-sessions?olderThanDays=1'),
    makeScenario(purgeOptions()));
  add('DELETE purge mixed case path',
    del('/api/Agent-Resources/Claude-Sessions?olderThanDays=3'),
    makeScenario(purgeOptions()));

  // ── Express OPTIONS / HEAD parity ────────────────────────────────────────
  add('OPTIONS skills', options('/api/agent-resources/skills'));
  add('OPTIONS presets', options('/api/agent-presets'));
  add('OPTIONS preset id', options('/api/agent-presets/relay__coder'));
  add('OPTIONS claude sessions collection', options('/api/agent-resources/claude-sessions'));
  add('OPTIONS delete session', options('/api/agent-resources/claude-sessions/proj-x/id'));

  // ── unclaimed paths still reach Node ─────────────────────────────────────
  add('GET unclaimed presets extra segment', get('/api/agent-presets/x/y'), baseScenario(), {
    normalize: (view, side) => unclaimed(view, side),
  });
  add('GET unclaimed unknown api path', get('/api/nope'), baseScenario(), {
    normalize: (view, side) => unclaimed(view, side),
  });

  // ── documented differences: the host port is down or refuses ─────────────
  // Node answered itself; the front door's host port is its only source, so it
  // answers 503 rust_backend_unavailable. These come last because the oracle
  // keeps answering where the stub never does.
  const hostDown = (options = baseOptions()) => makeScenario({ ...options, hostDown: true });
  add('GET skills host down', get('/api/agent-resources/skills'), hostDown(), {
    expectedDifference: { node: view => view.status === 200, rust: rustUnavailable },
  });
  add('GET presets host down', get('/api/agent-presets'), hostDown(), {
    expectedDifference: { node: view => view.status === 200, rust: rustUnavailable },
  });
  add('GET preset host down', get('/api/agent-presets/relay__coder'), hostDown(), {
    expectedDifference: { node: view => view.status === 200, rust: rustUnavailable },
  });
  add('GET claude sessions host down', get('/api/agent-resources/claude-sessions'), hostDown(), {
    expectedDifference: { node: view => view.status === 200, rust: rustUnavailable },
  });
  add('DELETE session host down',
    del('/api/agent-resources/claude-sessions/My%20Project/one'), hostDown(), {
      expectedDifference: { node: view => view.status === 200, rust: rustUnavailable },
    });
  add('DELETE purge host down',
    del('/api/agent-resources/claude-sessions?olderThanDays=3'),
    hostDown(purgeOptions()), {
      expectedDifference: { node: view => view.status === 200, rust: rustUnavailable },
    });

  // The host answered ok:false: the retired handler threw and Express's
  // safeErrorHandler produced a 500 internal_error DTO; the front door maps
  // the same fact to the family 503.
  add('GET skills host refused', get('/api/agent-resources/skills'),
    makeScenario({ ...baseOptions(), skillsDown: true }), {
      expectedDifference: { node: nodeInternalError, rust: rustUnavailable },
    });
  add('GET claude sessions host refused', get('/api/agent-resources/claude-sessions'),
    makeScenario({ ...baseOptions(), sessionsDown: true }), {
      expectedDifference: { node: nodeInternalError, rust: rustUnavailable },
    });
  add('DELETE purge host refused',
    del('/api/agent-resources/claude-sessions?olderThanDays=3'),
    makeScenario({ ...purgeOptions(), sessionsDown: true }), {
      expectedDifference: { node: nodeInternalError, rust: rustUnavailable },
    });

  return cases;
}

main({
  name: 'agent-resources',
  mount(app, { repo, work, express }) {
    scriptPath = path.join(work, 'agent-resources-script.json');
    legacy = require(path.join(repo, 'tests/helpers/legacy-agent-resource-routes'));
    oracleState = baseScenario();
    fs.writeFileSync(scriptPath, JSON.stringify(oracleState));
    let current = null;
    rebuildOracle = () => {
      const sub = express();
      legacy.createAgentResourcesRoutes(oracleDepsFor(oracleState.oracle)).mountRoutes(sub);
      current = sub;
    };
    rebuildOracle();
    // Delegate every request to the per-case mount so the preset-file cache
    // starts empty for each scenario, exactly like a fresh server process.
    app.use((req, res, next) => current(req, res, next));
    upstreamText = upstreamSource(repo);
  },
  get upstream() {
    return upstreamText;
  },
  // The stub child loads the real auth-control bridge, which loads the native
  // addon (src/native/runtime) — the same module the front door calls.
  gatewayEnv: work => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    STUB_SCRIPT: path.join(work, 'agent-resources-script.json'),
  }),
  corpus,
});
