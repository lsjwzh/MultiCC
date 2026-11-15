'use strict';
// Differential run for the 34 account/login routes retired from eight files:
//
//   GET|HEAD|POST /api/claude/accounts                        (claude-accounts.js)
//   POST          /api/claude/accounts/:id/activate
//   GET|HEAD      /api/claude/accounts/:id/login-status
//   POST          /api/claude/accounts/:id/login-callback
//   POST          /api/claude/accounts/:id/relogin
//   DELETE        /api/claude/accounts/:id
//   GET|HEAD      /api/claude/accounts/:id/quota
//   GET|HEAD|POST /api/codex/accounts                         (codex-accounts.js)
//   POST          /api/codex/accounts/:id/activate
//   GET|HEAD      /api/codex/accounts/:id/login-status
//   POST          /api/codex/accounts/:id/login-callback
//   POST          /api/codex/accounts/:id/relogin
//   DELETE        /api/codex/accounts/:id
//   GET|HEAD|PUT  /api/zcode/auth                             (zcode-auth.js)
//   POST          /api/zcode/auth/sync
//   GET|HEAD      /api/zcode/auth/check
//   POST          /api/zcode/auth/login        (stays in Node — forwarded)
//   GET|HEAD|POST /api/cli-accounts/:cli                      (cli-key-accounts.js)
//   PATCH|DELETE  /api/cli-accounts/:cli/:id
//   GET|HEAD|PUT  /api/kimi/auth                              (kimi-auth.js)
//   GET|HEAD      /api/kimi/auth/check
//   POST          /api/kimi/auth/login         (stays in Node — forwarded)
//   GET|HEAD      /api/claude/oauth/status                    (claude-oauth.js)
//   POST          /api/claude/oauth/login
//   GET|HEAD      /api/codex/oauth/status                     (codex-oauth.js)
//   POST          /api/codex/oauth/login
//   GET|HEAD      /api/commandcode/auth/status                (commandcode-auth.js)
//   POST          /api/commandcode/auth/login
//
// now answered by native/gateway/src/app/account_routes.rs (rules in
// native/core/src/account_routes.rs). The two blocking login POSTs are *not*
// claimed by the front door and keep running in Node — this run proves they are
// forwarded untouched.
//
//   node docs/rust-migration/differential/account-routes.js <repo> <multicc-gateway>
//
// The Node side mounts the frozen retired handlers
// (tests/helpers/legacy-account-routes.js) over the scripted world in
// tests/helpers/account-routes-scripted-world.js. The Rust front door calls its
// host port (/api/__host/account-routes); the stub Node child mounts the real
// src/routes/account-routes-host.js composition over the same world, so both
// sides read one set of facts. One fresh composition per corpus case, exactly
// like one world per case: the PKCE login state machine therefore starts empty
// and multi-request flows are seeded with setup requests inside the case.
//
// Side effects are compared too: every account/provider/credential/login/store
// call the handlers make is recorded in-process by the oracle and in an NDJSON
// file by the stub, then compared per case in finalize(). A route that answers
// the same bytes but forgets the write (or writes twice) fails.
//
// Nothing here touches real credentials, OAuth, the keychain or the network:
// the world is in-memory and the fetch/listener/child-process ports are scripted.
//
// A coverage guard at the end fails the run unless the corpus reached the
// credential-free projections, the three-step OAuth state (create → status →
// pasted callback → complete), the write side effects (credential/provider/
// session journal), both forwarded login routes and the OPTIONS unions. The
// front-door 503 (host unreachable) cannot be produced with a live stub; it is
// pinned by native/gateway/tests/account_routes.rs and the guard reads that
// file to confirm the assertion is still there.
//
// The scripted world needs the Rust addon (the frozen modules load the core at
// require time). Export MULTICC_RUST_ADDON / MULTICC_RUST_PREBUILT_DIR before
// running, as with the other addon-backed differentials.
const fs = require('fs');
const path = require('path');
const { main, send } = require('./lib');

const L = { Host: 'localhost', 'X-Request-Id': 'diff-req-1' };
const T0 = 1700000000000;
const A1 = 'a1b2c3d4e5f60789';
const A2 = 'a2b3c4d5e6f70819';
const C1 = 'b1c2d3e4f5061728';
const KEY_CANARY = 'sk-cli-CANARY';

let worldPath = '';
let effectsPath = '';
let repoPath = '';
let currentScenario = { case: 'initial' };
let cachedKey = null;
let cachedSub = null;
let cachedBag = null;
const nodeEffects = new Map();

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// ── scenarios ───────────────────────────────────────────────────────────────

function base(tag) {
  return {
    case: tag,
    claudeAccounts: [],
    codexAccounts: [],
    providers: { claude: [], codex: [] },
    selection: { claude: 'global', codex: 'global' },
    credentials: {},
    accountTokens: {},
    cliAccounts: {},
    directories: [{ id: 'd1', path: '/repo', name: 'Repo' }],
    persistedSessions: [],
    answers: {},
  };
}

function claudeAccount(id, extra = {}) {
  return { id, label: `Label ${id}`, loggedIn: true, createdAt: T0, ...extra };
}

function codexAccount(id, extra = {}) {
  return { id, label: `Codex ${id}`, loggedIn: true, createdAt: T0, ...extra };
}

function officialProvider(type, accountId, name) {
  return {
    id: `${type}-official-${accountId}`,
    appType: type,
    name,
    settingsConfig: { officialAccount: { id: accountId } },
  };
}

function claudeWorld(tag, extra = {}) {
  const world = base(tag);
  world.claudeAccounts = [claudeAccount(A1)];
  world.providers.claude = [officialProvider('claude', A1, 'Claude 官方 · Work')];
  world.credentials = { [A1]: { valid: true, expiresAt: T0 + 3600_000 } };
  Object.assign(world, extra);
  return world;
}

function codexWorld(tag, extra = {}) {
  const world = base(tag);
  world.codexAccounts = [codexAccount(C1)];
  world.providers.codex = [officialProvider('codex', C1, 'Codex 官方 · Work')];
  Object.assign(world, extra);
  return world;
}

// ── corpus plumbing ─────────────────────────────────────────────────────────

let counter = 0;
const pending = [];
const tagsByName = new Map();

function useScenario(scenario) {
  return {
    async before(side) {
      if (side.name === 'node') {
        currentScenario = scenario;
        // The sub-app is rebuilt lazily for the new case tag, so `unified` and
        // the login state machine are recomputed from this scenario exactly as
        // the stub child rebuilds its composition.
      } else {
        fs.writeFileSync(worldPath, JSON.stringify(scenario));
      }
    },
    capture(response, side) {
      if (side.name !== 'node') return;
      if (scenario.compareEffects === false) return;
      // A request rejected before the dispatcher (malformed JSON) never builds
      // this case's world; recording the previous case's bag would invent
      // side effects the Rust side correctly never ran.
      const calls = cachedKey === scenario.case && cachedBag ? cachedBag.effects.calls : [];
      nodeEffects.set(scenario.case, clone(calls));
    },
  };
}

function add(name, buildRequest, buildScenario, extra = {}) {
  counter += 1;
  const tag = `c${counter}`;
  const scenario = (typeof buildScenario === 'function' ? buildScenario(tag) : buildScenario) || base(tag);
  scenario.case = tag;
  if (!scenario.answers) scenario.answers = {};
  const hooks = useScenario(scenario);
  for (const [hook, fn] of Object.entries(extra)) {
    if (hook === 'before') {
      const baseBefore = hooks.before;
      hooks.before = async side => { await baseBefore(side); await fn(side); };
    } else {
      hooks[hook] = fn;
    }
  }
  tagsByName.set(name, tag);
  pending.push([name, () => buildRequest(tag), hooks]);
}

// Setup requests inside one case: both sides get the same sequence, so the
// state the measured request sees is identical.
async function call(side, request) {
  return send(side.port, request);
}

// ── corpus ──────────────────────────────────────────────────────────────────

function corpus() {
  const get = (url, headers = L) => ({ method: 'GET', url, headers });
  const head = (url, headers = L) => ({ method: 'HEAD', url, headers });
  const options = url => ({ method: 'OPTIONS', url, headers: L });
  const post = (url, body = {}, headers = L) => ({
    method: 'POST', url, headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const postRaw = (url, raw, headers = L) => ({
    method: 'POST', url, headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) },
    body: raw,
  });
  const putRaw = (url, raw, headers = L) => ({
    method: 'PUT', url, headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) },
    body: raw,
  });
  const put = (url, body = {}, headers = L) => ({
    method: 'PUT', url, headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const patch = (url, body = {}, headers = L) => ({
    method: 'PATCH', url, headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const del = (url, headers = L) => ({ method: 'DELETE', url, headers: { ...headers } });
  // Login canaries ride on every mutation: no response may echo them.
  const secretHeaders = {
    ...L,
    Cookie: 'multicc_session=canary',
    Authorization: 'Bearer cpk_runtime_canary',
  };

  // ── OPTIONS: Allow of every cluster-owned path ──────────────────────────
  add('OPTIONS claude accounts unions GET and POST', () => options('/api/claude/accounts'));
  add('OPTIONS claude account shape is DELETE only', () => options(`/api/claude/accounts/${A1}`));
  add('OPTIONS claude activate is POST only', () => options(`/api/claude/accounts/${A1}/activate`));
  add('OPTIONS claude login status is a read', () => options(`/api/claude/accounts/${A1}/login-status`));
  add('OPTIONS claude quota is a read', () => options(`/api/claude/accounts/${A1}/quota`));
  add('OPTIONS codex accounts unions GET and POST', () => options('/api/codex/accounts'));
  add('OPTIONS codex account shape is DELETE only', () => options(`/api/codex/accounts/${C1}`));
  add('OPTIONS codex login status is a read', () => options(`/api/codex/accounts/${C1}/login-status`));
  add('OPTIONS zcode auth unions GET and PUT', () => options('/api/zcode/auth'));
  add('OPTIONS zcode sync is POST only', () => options('/api/zcode/auth/sync'));
  add('OPTIONS zcode check is a read', () => options('/api/zcode/auth/check'));
  add('OPTIONS cli accounts unions GET and POST', () => options('/api/cli-accounts/commandcode'));
  add('OPTIONS cli account shape unions PATCH and DELETE', () => options('/api/cli-accounts/commandcode/c1c2c3c4d5e6f708'));
  add('OPTIONS kimi auth unions GET and PUT', () => options('/api/kimi/auth'));
  add('OPTIONS kimi check is a read', () => options('/api/kimi/auth/check'));
  add('OPTIONS claude oauth status is a read', () => options('/api/claude/oauth/status'));
  add('OPTIONS claude oauth login is POST only', () => options('/api/claude/oauth/login'));
  add('OPTIONS codex oauth status is a read', () => options('/api/codex/oauth/status'));
  add('OPTIONS codex oauth login is POST only', () => options('/api/codex/oauth/login'));
  add('OPTIONS commandcode status is a read', () => options('/api/commandcode/auth/status'));
  add('OPTIONS commandcode login is POST only', () => options('/api/commandcode/auth/login'));
  add('OPTIONS forwarded zcode login is POST only', () => options('/api/zcode/auth/login'), null, { normalize: dropHopHeaders });
  add('OPTIONS forwarded kimi login is POST only', () => options('/api/kimi/auth/login'), null, { normalize: dropHopHeaders });

  // ── Claude official accounts ───────────────────────────────────────────
  add('claude list projects accounts in unified mode', () => get('/api/claude/accounts', secretHeaders), tag => claudeWorld(tag, {
    selection: { claude: 'global' },
    cliLogin: { claude: { loggedIn: true, email: 'cli@example.com' } },
  }));
  add('claude list projects legacy providers without secrets', () => get('/api/claude/accounts'), tag => claudeWorld(tag, {
    selection: { claude: null },
    accountTokens: { [A1]: { token: 'sk-ant-oat01-ACCESS-CANARY' } },
  }));
  add('HEAD claude list has no body', () => head('/api/claude/accounts'), tag => claudeWorld(tag));
  add('claude create starts the browser flow and binds egress', () => post('/api/claude/accounts', {
    label: ' Work  Laptop ',
    egressBinding: { pluginId: 'proxy', profileId: 'p1' },
  }, secretHeaders), tag => {
    const world = base(tag);
    world.claudeAccounts = [];
    world.selection = { claude: 'global' };
    world.loginListener = 'pending';
    return world;
  }, { normalize: blankEtag });
  add('claude create builds a provider when unified mode is off', () => post('/api/claude/accounts', { label: 'Work' }), tag => {
    const world = base(tag);
    world.selection = { claude: null };
    return world;
  }, { normalize: blankEtag });
  add('claude create rejects a malformed egress binding', () => post('/api/claude/accounts', {
    label: 'Work',
    egressBinding: { pluginId: '', profileId: '' },
  }), tag => base(tag));
  add('claude create rolls back when provider creation fails', () => post('/api/claude/accounts', { label: 'Work' }), tag => {
    const world = base(tag);
    world.selection = { claude: null };
    world.answers = { createProvider: { throw: 'provider store unavailable' } };
    return world;
  });
  add('claude login status reports pending with the authorize URL', () => get(`/api/claude/accounts/${A1}/login-status`), tag => claudeWorld(tag, {
    loginListener: 'pending',
  }), {
    normalize: blankEtag,
    before: side => call(side, post('/api/claude/accounts', { label: 'Work' })),
  });
  add('claude login status is idle by default', () => get(`/api/claude/accounts/${A1}/login-status`), tag => claudeWorld(tag));
  add('claude login status reports an unknown account', () => get('/api/claude/accounts/aaaaaaaaaaaaaaaa/login-status'), tag => claudeWorld(tag));
  add('claude relogin reuses the pending flow', () => post(`/api/claude/accounts/${A1}/relogin`), tag => claudeWorld(tag, {
    loginListener: 'pending',
  }), {
    normalize: blankEtag,
    before: side => call(side, post('/api/claude/accounts', { label: 'Work' })),
  });
  add('claude relogin supersedes a pending flow', () => post(`/api/claude/accounts/${A2}/relogin`), tag => {
    const world = claudeWorld(tag, { loginListener: 'pending' });
    world.claudeAccounts.push(claudeAccount(A2));
    return world;
  }, {
    normalize: blankEtag,
    before: side => call(side, post('/api/claude/accounts', { label: 'Work' })),
  });
  add('claude relogin reports an unknown account', () => post('/api/claude/accounts/aaaaaaaaaaaaaaaa/relogin'), tag => claudeWorld(tag));
  add('claude login callback rejects a missing code', () => post(`/api/claude/accounts/${A1}/login-callback`, {}), tag => claudeWorld(tag, {
    loginListener: 'pending',
  }), {
    before: side => call(side, post('/api/claude/accounts', { label: 'Work' })),
  });
  add('claude login callback needs a pending flow', () => post(`/api/claude/accounts/${A1}/login-callback`, { code: 'x' }), tag => claudeWorld(tag));
  add('claude login callback reports a listener without paste support', () => post(`/api/claude/accounts/${A1}/login-callback`, { code: 'x' }), tag => claudeWorld(tag, {
    loginListener: 'nosubmit',
  }), {
    before: side => call(side, post('/api/claude/accounts', { label: 'Work' })),
  });
  add('claude login callback completes the state machine', () => get(`/api/claude/accounts/${A1}/login-status`), tag => claudeWorld(tag, {
    loginListener: 'resolve',
  }), {
    before: async side => {
      await call(side, post('/api/claude/accounts', { label: 'Work' }));
      await call(side, post(`/api/claude/accounts/${A1}/login-callback`, {
        callback: 'http://127.0.0.1:54545/callback?code=scripted&state=scripted',
      }));
    },
  });
  add('claude login callback records an exchange rejection', () => get(`/api/claude/accounts/${A1}/login-status`), tag => claudeWorld(tag, {
    loginListener: 'reject',
  }), {
    before: async side => {
      await call(side, post('/api/claude/accounts', { label: 'Work' }));
      await call(side, post(`/api/claude/accounts/${A1}/login-callback`, { code: 'scripted' }));
    },
  });
  add('claude activate rejects when unified accounts are off', () => post(`/api/claude/accounts/${A1}/activate`), tag => claudeWorld(tag, {
    selection: { claude: null },
  }));
  add('claude activate reports an unknown account', () => post('/api/claude/accounts/aaaaaaaaaaaaaaaa/activate'), tag => claudeWorld(tag));
  add('claude activate needs the account to be logged in', () => post(`/api/claude/accounts/${A1}/activate`), tag => claudeWorld(tag, {
    claudeAccounts: [claudeAccount(A1, { loggedIn: false })],
  }));
  add('claude activate selects the account', () => post(`/api/claude/accounts/${A1}/activate`), tag => claudeWorld(tag));
  add('claude delete refuses the built-in global account', () => del('/api/claude/accounts/global'), tag => claudeWorld(tag));
  add('claude delete removes the bound provider and releases the pick', () => del(`/api/claude/accounts/${A1}`), tag => claudeWorld(tag, {
    selection: { claude: null },
  }));
  add('claude delete cancels a pending login', () => del(`/api/claude/accounts/${A1}`), tag => claudeWorld(tag, {
    loginListener: 'pending',
  }), {
    before: side => call(side, post('/api/claude/accounts', { label: 'Work' })),
  });
  add('claude quota reports an unknown account', () => get('/api/claude/accounts/aaaaaaaaaaaaaaaa/quota'), tag => claudeWorld(tag));
  add('claude quota maps an unreadable credential to 401', () => get(`/api/claude/accounts/${A1}/quota`), tag => claudeWorld(tag, {
    accountTokens: { [A1]: { reason: 'credential_unreadable' } },
  }));
  add('claude quota maps a missing token to 503', () => get(`/api/claude/accounts/${A1}/quota`), tag => claudeWorld(tag, {
    accountTokens: { [A1]: { reason: 'no_credentials' } },
  }));
  add('claude quota returns the usage payload', () => get(`/api/claude/accounts/${A1}/quota`, secretHeaders), tag => claudeWorld(tag, {
    accountTokens: { [A1]: { token: 'sk-ant-oat01-ACCESS-CANARY' } },
  }));
  add('claude quota maps a revoked token to 401', () => get(`/api/claude/accounts/${A1}/quota`), tag => claudeWorld(tag, {
    accountTokens: { [A1]: { token: 'sk-ant-oat01-ACCESS-CANARY' } },
    usage: { status: 401, body: '{"error":"revoked"}' },
  }));
  add('claude quota maps an upstream failure to 502', () => get(`/api/claude/accounts/${A1}/quota`), tag => claudeWorld(tag, {
    accountTokens: { [A1]: { token: 'sk-ant-oat01-ACCESS-CANARY' } },
    usage: { throw: 'network down' },
  }));

  // ── Codex official accounts ────────────────────────────────────────────
  add('codex list projects accounts and refresher state', () => get('/api/codex/accounts', secretHeaders), tag => codexWorld(tag, {
    refresherStatus: { [C1]: { state: 'ok', expiresAt: T0 + 3600_000 } },
  }));
  add('codex create starts the browser flow', () => post('/api/codex/accounts', { label: ' Work ' }, secretHeaders), tag => {
    const world = base(tag);
    world.loginListener = 'pending';
    return world;
  }, { normalize: blankEtag });
  add('codex create reports a listener failure without losing the account', () => post('/api/codex/accounts', { label: 'Work' }), tag => {
    const world = base(tag);
    world.loginListener = 'throw';
    return world;
  });
  add('codex activate rejects when unified accounts are off', () => post(`/api/codex/accounts/${C1}/activate`), tag => codexWorld(tag, {
    selection: { codex: null },
  }));
  add('codex activate selects the account', () => post(`/api/codex/accounts/${C1}/activate`), tag => codexWorld(tag));
  add('codex login status reports an unknown account', () => get('/api/codex/accounts/aaaaaaaaaaaaaaaa/login-status'), tag => codexWorld(tag));
  add('codex login callback needs a pending flow', () => post(`/api/codex/accounts/${C1}/login-callback`, { code: 'x' }), tag => codexWorld(tag));
  // The completion path fires `modelCatalogRuntime.refreshAccount` without
  // awaiting it, so the Node-side effect can land after the response (and thus
  // after this case's NDJSON capture). The public bytes are still compared;
  // only this one case's side-effect list is skipped.
  add('codex login callback completes the state machine', () => get(`/api/codex/accounts/${C1}/login-status`), tag => codexWorld(tag, {
    loginListener: 'resolve',
    compareEffects: false,
  }), {
    before: async side => {
      await call(side, post('/api/codex/accounts', { label: 'Work' }));
      await call(side, post(`/api/codex/accounts/${C1}/login-callback`, { code: 'scripted' }));
    },
  });
  add('codex relogin reports an unknown account', () => post('/api/codex/accounts/aaaaaaaaaaaaaaaa/relogin'), tag => codexWorld(tag));
  add('codex relogin starts a new flow', () => post(`/api/codex/accounts/${C1}/relogin`), tag => codexWorld(tag, {
    loginListener: 'pending',
  }), { normalize: blankEtag });
  add('codex delete refuses the built-in global account', () => del('/api/codex/accounts/global'), tag => codexWorld(tag));
  add('codex delete removes the bound provider', () => del(`/api/codex/accounts/${C1}`), tag => codexWorld(tag, {
    selection: { codex: null },
  }));

  // ── ZCode native auth ──────────────────────────────────────────────────
  add('zcode status projects desktop keys without the key', () => get('/api/zcode/auth', secretHeaders), tag => {
    const world = base(tag);
    world.zcode = {
      status: { configured: true, provider: 'z.ai', hasKey: true, source: 'cli_config', kind: 'anthropic', model: 'claude-sonnet-4-5', apiKey: KEY_CANARY },
      desktopKeys: { zai: { apiKey: KEY_CANARY } },
    };
    return world;
  });
  add('zcode status failure is a 500 envelope', () => get('/api/zcode/auth'), tag => {
    const world = base(tag);
    world.zcode = { statusThrow: true };
    return world;
  });
  add('zcode sync copies the desktop key', () => post('/api/zcode/auth/sync'), tag => {
    const world = base(tag);
    world.zcode = { sync: { synced: true, provider: 'z.ai' } };
    return world;
  });
  add('zcode sync refuses without a desktop key', () => post('/api/zcode/auth/sync'), tag => {
    const world = base(tag);
    world.zcode = { sync: { synced: false, reason: 'no_desktop_key' } };
    return world;
  });
  add('zcode manual key needs a provider and key', () => put('/api/zcode/auth', {}), tag => base(tag));
  add('zcode manual key stores the configuration without echoing it', () => put('/api/zcode/auth', {
    providerId: 'z.ai', apiKey: KEY_CANARY, baseURL: 'https://api.z.ai', secret: KEY_CANARY,
  }, secretHeaders), tag => {
    const world = base(tag);
    world.zcode = { set: { configured: true, provider: 'z.ai' } };
    return world;
  });
  add('zcode manual key rejects a null body', () => putRaw('/api/zcode/auth', 'null'), tag => base(tag));
  add('zcode manual key maps a store failure to 400', () => put('/api/zcode/auth', { providerId: 'z.ai', apiKey: KEY_CANARY }), tag => {
    const world = base(tag);
    world.zcode = { setThrow: true };
    return world;
  });
  add('zcode check passes configuration through', () => get('/api/zcode/auth/check', secretHeaders), tag => {
    const world = base(tag);
    world.zcode = { ensure: { ok: true, provider: 'z.ai', source: 'cli_config', apiKey: KEY_CANARY } };
    return world;
  });
  add('zcode check reports missing configuration', () => get('/api/zcode/auth/check'), tag => {
    const world = base(tag);
    world.zcode = { ensure: { ok: false } };
    return world;
  });
  add('zcode check failure is a 500 envelope', () => get('/api/zcode/auth/check'), tag => {
    const world = base(tag);
    world.zcode = { ensureThrow: true };
    return world;
  });
  add('forwarded zcode login needs the engine', () => post('/api/zcode/auth/login'), tag => {
    const world = base(tag);
    world.zcode = { loginAvailable: false };
    return world;
  }, { normalize: dropHopHeaders });
  add('forwarded zcode login completes in the browser child', () => post('/api/zcode/auth/login'), tag => {
    const world = base(tag);
    world.zcode = {
      login: { mode: 'close', code: 0 },
      status: { configured: true, provider: 'z.ai', hasKey: true, source: 'cli_config', kind: 'anthropic', model: 'claude-sonnet-4-5' },
    };
    return world;
  }, { normalize: dropHopHeaders });

  // ── CLI key accounts ───────────────────────────────────────────────────
  add('cli accounts list projects hints only', () => get('/api/cli-accounts/commandcode', secretHeaders), tag => {
    const world = base(tag);
    world.cliAccounts = { commandcode: [{ id: 'c1c2c3c4d5e6f708', label: 'Work', keyHint: '…1234' }] };
    return world;
  });
  add('cli accounts reject an unsupported lane', () => get('/api/cli-accounts/claude'), tag => base(tag));
  add('cli accounts create returns the stored account', () => post('/api/cli-accounts/commandcode', { label: 'Work', apiKey: KEY_CANARY }, secretHeaders), tag => base(tag));
  add('cli accounts create rejects an invalid key', () => post('/api/cli-accounts/commandcode', { label: 'Work', apiKey: 'short' }), tag => {
    const world = base(tag);
    world.answers = { cliStoreCreate: { throw: 'API Key 格式无效（8–512 个可见字符，不能含空格）', code: 'CLI_KEY_ACCOUNT_INVALID' } };
    return world;
  });
  add('cli accounts create maps an unexpected failure to 500', () => post('/api/cli-accounts/commandcode', { label: 'Work', apiKey: KEY_CANARY }), tag => {
    const world = base(tag);
    world.answers = { cliStoreCreate: { throw: 'disk full', code: 'ENOSPC' } };
    return world;
  });
  add('cli accounts patch renames the account', () => patch('/api/cli-accounts/commandcode/c1c2c3c4d5e6f708', { label: 'Renamed' }), tag => {
    const world = base(tag);
    world.cliAccounts = { commandcode: [{ id: 'c1c2c3c4d5e6f708', label: 'Work', keyHint: '…1234' }] };
    return world;
  });
  add('cli accounts patch reports a missing account', () => patch('/api/cli-accounts/commandcode/c1c2c3c4d5e6f708', { label: 'Renamed' }), tag => base(tag));
  add('cli accounts patch rejects an invalid key', () => patch('/api/cli-accounts/commandcode/c1c2c3c4d5e6f708', { apiKey: 'bad key' }), tag => {
    const world = base(tag);
    world.cliAccounts = { commandcode: [{ id: 'c1c2c3c4d5e6f708', label: 'Work' }] };
    world.answers = { cliStoreUpdate: { throw: 'API Key 格式无效（8–512 个可见字符，不能含空格）', code: 'CLI_KEY_ACCOUNT_INVALID' } };
    return world;
  });
  add('cli accounts delete reports a missing account', () => del('/api/cli-accounts/commandcode/c1c2c3c4d5e6f708'), tag => base(tag));
  add('cli accounts delete releases the sessions that picked it', () => del('/api/cli-accounts/commandcode/c1c2c3c4d5e6f708'), tag => {
    const world = base(tag);
    world.cliAccounts = { commandcode: [{ id: 'c1c2c3c4d5e6f708', label: 'Work' }] };
    world.sessionRecords = [{ id: 's1', cliAccounts: { commandcode: 'c1c2c3c4d5e6f708' } }];
    return world;
  });

  // ── Kimi native auth ───────────────────────────────────────────────────
  add('kimi status reports native auth availability', () => get('/api/kimi/auth', secretHeaders), tag => {
    const world = base(tag);
    world.kimi = { status: { configured: true, hasKey: true, source: 'credentials', apiKey: KEY_CANARY } };
    return world;
  });
  add('kimi status failure is a 500 envelope', () => get('/api/kimi/auth'), tag => {
    const world = base(tag);
    world.kimi = { statusThrow: true };
    return world;
  });
  add('kimi check passes configuration through', () => get('/api/kimi/auth/check'), tag => {
    const world = base(tag);
    world.kimi = { ensure: { ok: true, source: 'credentials' } };
    return world;
  });
  add('kimi check reports missing configuration', () => get('/api/kimi/auth/check'), tag => {
    const world = base(tag);
    world.kimi = { ensure: { ok: false, message: 'configuration required', loginAvailable: true } };
    return world;
  });
  add('kimi check failure is a 500 envelope', () => get('/api/kimi/auth/check'), tag => {
    const world = base(tag);
    world.kimi = { ensureThrow: true };
    return world;
  });
  add('kimi manual key needs a key', () => put('/api/kimi/auth', {}), tag => base(tag));
  add('kimi manual key stores the configuration without echoing it', () => put('/api/kimi/auth', { apiKey: KEY_CANARY, baseURL: 'https://api.moonshot.ai' }, secretHeaders), tag => {
    const world = base(tag);
    world.kimi = { set: { configured: true } };
    return world;
  });
  add('kimi manual key maps a store failure to 400', () => put('/api/kimi/auth', { apiKey: KEY_CANARY }), tag => {
    const world = base(tag);
    world.kimi = { setThrow: true };
    return world;
  });
  add('forwarded kimi login needs the CLI', () => post('/api/kimi/auth/login'), tag => {
    const world = base(tag);
    world.kimi = { loginAvailable: false };
    return world;
  }, { normalize: dropHopHeaders });
  add('forwarded kimi login reports a spawn failure', () => post('/api/kimi/auth/login'), tag => {
    const world = base(tag);
    world.kimi = { spawnThrow: true };
    return world;
  }, { normalize: dropHopHeaders });
  add('forwarded kimi login completes in the browser child', () => post('/api/kimi/auth/login'), tag => {
    const world = base(tag);
    world.kimi = { login: { mode: 'close', code: 0 }, status: { configured: true, hasKey: true, source: 'credentials' } };
    return world;
  }, { normalize: dropHopHeaders });

  // ── Claude OAuth health surface ────────────────────────────────────────
  add('claude oauth status reports a needs-login outcome', () => get('/api/claude/oauth/status', secretHeaders), tag => {
    const world = base(tag);
    world.claudeOAuthStatus = { enabled: true, lastOutcome: { outcome: 'failed' }, consecutiveFailures: 3 };
    world.persistedSessions = ['claude-auth-login'];
    return world;
  });
  add('claude oauth status is banner-free when healthy', () => get('/api/claude/oauth/status'), tag => {
    const world = base(tag);
    world.claudeOAuthStatus = { enabled: true, lastOutcome: { outcome: 'ok' }, consecutiveFailures: 0 };
    return world;
  });
  add('claude oauth status closes a landed login terminal', () => get('/api/claude/oauth/status'), tag => {
    const world = base(tag);
    world.claudeOAuthStatus = { enabled: true, lastOutcome: { outcome: 'ok' } };
    world.persistedSessions = [{ id: 'claude-auth-login', dirId: 'd1', label: 'Claude 登录' }];
    world.claudeCredentials = { ok: true, expiresAt: T0 + 7200_000 };
    return world;
  });
  add('claude oauth login opens a login terminal', () => post('/api/claude/oauth/login', {}, secretHeaders), tag => {
    const world = base(tag);
    world.claudeCredentials = { ok: true, expiresAt: T0 + 3600_000 };
    return world;
  });
  add('claude oauth login needs a directory', () => post('/api/claude/oauth/login'), tag => {
    const world = base(tag);
    world.directories = [];
    return world;
  });
  add('claude oauth login maps a session failure to 500', () => post('/api/claude/oauth/login'), tag => {
    const world = base(tag);
    world.sessionCreate = { ok: false, error: 'workspace busy' };
    return world;
  });

  // ── Codex OAuth health surface ─────────────────────────────────────────
  add('codex oauth status reports the needs-login window', () => get('/api/codex/oauth/status', secretHeaders), tag => {
    const world = base(tag);
    world.codexOAuthStatus = {
      enabled: true,
      needsLogin: { since: T0 },
      lastOutcome: { outcome: 'failed' },
      consecutiveFailures: 2,
      retryAfter: T0 + 60_000,
    };
    return world;
  });
  add('codex oauth status treats no-credentials as needs-login', () => get('/api/codex/oauth/status'), tag => {
    const world = base(tag);
    world.codexOAuthStatus = { enabled: false, lastOutcome: { outcome: 'no-credentials' } };
    return world;
  });
  add('codex oauth login opens a login terminal', () => post('/api/codex/oauth/login'), tag => base(tag));
  add('codex oauth login needs a directory', () => post('/api/codex/oauth/login'), tag => {
    const world = base(tag);
    world.directories = [];
    return world;
  });

  // ── Command Code auth surface ──────────────────────────────────────────
  add('commandcode status projects the local identity only', () => get('/api/commandcode/auth/status', secretHeaders), tag => {
    const world = base(tag);
    world.commandcode = { credentialSaved: true, userName: 'Work', environmentKey: false };
    return world;
  });
  add('commandcode login opens a login terminal', () => post('/api/commandcode/auth/login'), tag => base(tag));
  add('commandcode login needs a directory', () => post('/api/commandcode/auth/login'), tag => {
    const world = base(tag);
    world.directories = [];
    return world;
  });
  add('commandcode login maps a session failure to 500', () => post('/api/commandcode/auth/login'), tag => {
    const world = base(tag);
    world.sessionCreate = { ok: false, error: 'workspace busy' };
    return world;
  });

  return pending;
}

// ── the stub Node child: the real host-port composition over the world ─────

function upstreamSource(repo) {
  return `'use strict';
// Frozen clock: fetchedAt/expiry timestamps must agree byte for byte.
Date.now = () => ${T0};
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
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

const express = require(require.resolve('express', { paths: [REPO] }));
const world = require(path.join(REPO, 'tests/helpers/account-routes-scripted-world'));
const legacy = require(path.join(REPO, 'tests/helpers/legacy-account-routes'));

const worldPath = process.env.STUB_WORLD;
const effectsPath = process.env.STUB_EFFECTS;

function readWorld() {
  try { return JSON.parse(fs.readFileSync(worldPath, 'utf8')); } catch (_) { return { case: null, answers: {} }; }
}

// One world per case, like one server process: a request and its setup share
// the same account/provider/login maps.
const bags = new Map();
const reported = new Map();
function bagFor(scenario) {
  const key = String(scenario.case || '');
  let bag = bags.get(key);
  if (!bag) { bag = world.buildDeps(scenario); bags.set(key, bag); }
  return bag;
}

// The host port and the two public login-only mounts, over one case's world.
function buildComposition(bag) {
  const inner = express();
  legacy.mountLiveComposition(inner, bag, { isLocal: () => true });
  return inner;
}
const compositions = new Map();
function compositionFor(key, bag) {
  let inner = compositions.get(key);
  if (!inner) { inner = buildComposition(bag); compositions.set(key, inner); }
  return inner;
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
  const scenario = readWorld();
  const bag = bagFor(scenario);
  const key = String(scenario.case || '');
  res.on('finish', () => {
    const calls = bag.effects.calls;
    const from = reported.get(key) || 0;
    const fresh = calls.slice(from);
    reported.set(key, calls.length);
    if (!fresh.length) return;
    fs.appendFileSync(effectsPath, JSON.stringify({ case: key, calls: fresh }) + '\\n');
  });
  return compositionFor(key, bag)(req, res, next);
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

// ── response normalization ─────────────────────────────────────────────────

// Only the values that cannot agree by construction: the PKCE verifier hash and
// the state token are crypto-random on both sides. The clock is frozen, so
// timestamps agree byte for byte.
function normalize(text) {
  return text
    .replace(/state=[A-Za-z0-9_-]+/g, 'state=<state>')
    .replace(/code_challenge=[A-Za-z0-9_-]+/g, 'code_challenge=<challenge>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
}

// Forwarded (Node-served) replies relay status/body/ETag byte-identically, but
// the front door does not re-stamp its own per-hop instrumentation headers on a
// forwarded response. Those headers are hop metadata, not the route's contract.
function blankEtag(view) {
  // The authorize URL is crypto-random on each side; the body is normalized but
  // Express's ETag is a hash of the raw (unnormalized) body.
  view.headers.etag = '<random-body-hash>';
  return view;
}

function dropHopHeaders(view) {
  for (const name of ['vary', 'x-multicc-api-version', 'x-multicc-request-id', 'x-correlation-id']) {
    delete view.headers[name];
  }
  return view;
}

// Built lazily: one fresh legacy composition per corpus case.
function subFor(scenario) {
  const key = scenario.case;
  if (cachedKey === key && cachedSub) return cachedSub;
  const world = require(path.join(repoPath, 'tests/helpers/account-routes-scripted-world'));
  const legacy = require(path.join(repoPath, 'tests/helpers/legacy-account-routes'));
  const express = require(require.resolve('express', { paths: [repoPath] }));
  const sub = express();
  cachedBag = world.buildDeps(scenario);
  legacy.mountAccountRoutesLegacy(sub, cachedBag);
  cachedKey = key;
  cachedSub = sub;
  return sub;
}

// ── run ─────────────────────────────────────────────────────────────────────

let upstreamText = '';

main({
  name: 'account-routes',
  mount(app, { repo, work }) {
    // A missed dependency would otherwise fall back to the checkout's data root.
    process.env.MULTICC_DATA_DIR = work;
    process.env.NODE_PATH = path.join(repo, 'node_modules');
    require('module').Module._initPaths();
    Date.now = () => T0;
    repoPath = repo;
    worldPath = path.join(work, 'account-world.json');
    effectsPath = path.join(work, 'account-effects.ndjson');
    fs.writeFileSync(effectsPath, '');
    fs.writeFileSync(worldPath, JSON.stringify({ case: 'initial', answers: {} }));
    app.use((req, res, next) => subFor(currentScenario)(req, res, next));
    upstreamText = upstreamSource(repo);
  },
  get upstream() {
    return upstreamText;
  },
  gatewayEnv: work => ({
    MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON,
    MULTICC_RUST_PREBUILT_DIR: process.env.MULTICC_RUST_PREBUILT_DIR,
    MULTICC_DATA_DIR: work,
    STUB_WORLD: worldPath,
    STUB_EFFECTS: effectsPath,
  }),
  normalize,
  corpus,
  finalize({ work, views }) {
    const problems = [];
    const byName = new Map(views.map(entry => [entry.name, entry]));

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

    // Byte-identical is not enough: a stub that failed to resolve would let both
    // sides 500 with the same envelope. No case in this corpus is a generic 500.
    for (const view of views) {
      for (const side of ['node', 'rust']) {
        if (view[side].status === 500 && view[side].body.includes('"error":"internal_error"')) {
          problems.push(`${view.name}: ${side} hit the generic 500 (${view[side].body})`);
        }
      }
    }

    // ── credential-free projections ──────────────────────────────────────
    const { SECRETS } = require(path.join(repoPath, 'tests/helpers/account-routes-scripted-world'));
    for (const view of views) {
      for (const side of ['node', 'rust']) {
        for (const needle of SECRETS) {
          if (view[side].body.includes(needle)) {
            problems.push(`${view.name}: ${side} leaked ${needle} (${view[side].body})`);
          }
        }
      }
    }
    expect('claude list projects accounts in unified mode', 200, '"activeAccountId":"global"');
    expect('claude list projects legacy providers without secrets', 200, '"providerName":"Claude 官方 · Work"');
    expect('claude quota returns the usage payload', 200, '"five_hour"');
    expect('cli accounts list projects hints only', 200, '"keyHint":"…1234"');
    expect('zcode status projects desktop keys without the key', 200, '"desktopProviders":[{"id":"zai","hasKey":true}]');
    expect('kimi status reports native auth availability', 200, '"loginAvailable":true');

    // ── the three-step OAuth state machine ───────────────────────────────
    expect('claude login status reports pending with the authorize URL', 200, '"state":"pending"');
    expect('claude relogin reuses the pending flow', 200, '"reused":true');
    expect('claude relogin supersedes a pending flow', 200, '"reused":false');
    expect('claude login callback completes the state machine', 200, '"state":"complete"');
    expect('claude login callback records an exchange rejection', 200, '"state":"error"');
    expect('claude login callback reports a listener without paste support', 501, '"error":"当前登录方式不支持粘贴回调"');
    expect('codex login callback completes the state machine', 200, '"state":"complete"');
    expect('codex create reports a listener failure without losing the account', 201, '"loginError"');

    // ── error branches and status codes ──────────────────────────────────
    expect('claude create rejects a malformed egress binding', 400, 'egressBinding needs pluginId and profileId');
    expect('claude create rolls back when provider creation fails', 500, 'provider create failed');
    expect('claude activate rejects when unified accounts are off', 409, '统一官方账号未启用');
    expect('claude activate reports an unknown account', 404, '账号不存在');
    expect('claude activate needs the account to be logged in', 409, '请先完成该账号的登录');
    expect('claude delete refuses the built-in global account', 409, '不能删除');
    expect('claude quota maps an unreadable credential to 401', 401, 'credential_unreadable');
    expect('claude quota maps a missing token to 503', 503, 'no_credentials');
    expect('claude quota maps a revoked token to 401', 401, '账号凭证已失效');
    expect('claude quota maps an upstream failure to 502', 502, 'network down');
    expect('zcode manual key rejects a null body', 400, '"request_error"');
    expect('zcode sync refuses without a desktop key', 400, '"code":"no_desktop_key"');
    expect('zcode check reports missing configuration', 200, '"code":"configuration_required"');
    expect('cli accounts reject an unsupported lane', 404, '该 CLI 不支持 API Key 账户');
    expect('cli accounts create rejects an invalid key', 400, 'API Key 格式无效');
    expect('cli accounts create maps an unexpected failure to 500', 500, '账户保存失败');
    expect('cli accounts delete releases the sessions that picked it', 200, '"releasedSessions":1');
    expect('kimi check reports missing configuration', 200, '"loginAvailable":true');
    expect('claude oauth status reports a needs-login outcome', 200, '"needsLogin":true');
    expect('claude oauth status is banner-free when healthy', 200, '"loginCommand":null');
    expect('claude oauth login opens a login terminal', 200, '"sessionId":"claude-auth-login"');
    expect('codex oauth status reports the needs-login window', 200, '"loginCommand":"codex login"');
    expect('codex oauth status treats no-credentials as needs-login', 200, '"needsLoginSince":null');
    expect('commandcode login needs a directory', 409, '请先添加一个项目目录');

    // ── forwarded login routes answered by Node ─────────────────────────
    expect('forwarded zcode login needs the engine', 400, '"code":"engine_not_found"');
    expect('forwarded zcode login completes in the browser child', 200, '"code":"login_success"');
    expect('forwarded kimi login needs the CLI', 400, '"code":"cli_not_found"');
    expect('forwarded kimi login reports a spawn failure', 500, '"code":"spawn_error"');
    expect('forwarded kimi login completes in the browser child', 200, '"code":"login_success"');

    // ── OPTIONS: the automatic Allow union must match Express ───────────
    const allowExpect = {
      'OPTIONS claude accounts unions GET and POST': 'GET,HEAD,POST',
      'OPTIONS claude account shape is DELETE only': 'DELETE',
      'OPTIONS claude activate is POST only': 'POST',
      'OPTIONS claude login status is a read': 'GET,HEAD',
      'OPTIONS claude quota is a read': 'GET,HEAD',
      'OPTIONS codex accounts unions GET and POST': 'GET,HEAD,POST',
      'OPTIONS codex account shape is DELETE only': 'DELETE',
      'OPTIONS codex login status is a read': 'GET,HEAD',
      'OPTIONS zcode auth unions GET and PUT': 'GET,HEAD,PUT',
      'OPTIONS zcode sync is POST only': 'POST',
      'OPTIONS zcode check is a read': 'GET,HEAD',
      'OPTIONS cli accounts unions GET and POST': 'GET,HEAD,POST',
      'OPTIONS cli account shape unions PATCH and DELETE': 'PATCH,DELETE',
      'OPTIONS kimi auth unions GET and PUT': 'GET,HEAD,PUT',
      'OPTIONS kimi check is a read': 'GET,HEAD',
      'OPTIONS claude oauth status is a read': 'GET,HEAD',
      'OPTIONS claude oauth login is POST only': 'POST',
      'OPTIONS codex oauth status is a read': 'GET,HEAD',
      'OPTIONS codex oauth login is POST only': 'POST',
      'OPTIONS commandcode status is a read': 'GET,HEAD',
      'OPTIONS commandcode login is POST only': 'POST',
      'OPTIONS forwarded zcode login is POST only': 'POST',
      'OPTIONS forwarded kimi login is POST only': 'POST',
    };
    for (const [name, allow] of Object.entries(allowExpect)) {
      const view = byName.get(name);
      if (!view) { problems.push(`${name}: missing from the corpus`); continue; }
      for (const side of ['node', 'rust']) {
        if (view[side].headers.allow !== allow) {
          problems.push(`${name}: ${side} Allow ${JSON.stringify(view[side].headers.allow)}, expected ${JSON.stringify(allow)}`);
        }
      }
    }

    // ── side effects: identical sequence, not merely survivable ─────────
    const readEffects = file => {
      const map = new Map();
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return map; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch (_) { continue; }
        if (!entry || !entry.case) continue;
        if (!map.has(entry.case)) map.set(entry.case, []);
        map.get(entry.case).push(...entry.calls);
      }
      return map;
    };
    const rustEffects = readEffects(effectsPath);
    const mismatches = [];
    for (const [tag, calls] of nodeEffects) {
      const rust = rustEffects.get(tag) || [];
      if (JSON.stringify(calls) !== JSON.stringify(rust)) mismatches.push({ tag, node: calls, rust });
    }
    const requireEffect = (name, kinds) => {
      const tag = tagsByName.get(name);
      if (!tag) { problems.push(`${name}: missing from the corpus`); return; }
      for (const [side, table] of [['node', nodeEffects], ['rust', rustEffects]]) {
        const seen = (table.get(tag) || []).map(call => call.call);
        for (const kind of kinds) {
          if (!seen.includes(kind)) {
            problems.push(`${name}: ${side} side effects lack ${kind} (${JSON.stringify(seen)})`);
          }
        }
      }
    };
    requireEffect('claude create starts the browser flow and binds egress',
      ['createClaudeAccount', 'updateProvider', 'openLoginListener']);
    requireEffect('claude create builds a provider when unified mode is off',
      ['createClaudeAccount', 'createProvider', 'openLoginListener']);
    requireEffect('claude create rolls back when provider creation fails',
      ['createClaudeAccount', 'createProvider', 'deleteClaudeAccount']);
    requireEffect('claude login callback completes the state machine',
      ['submitCallback', 'egressFetchForAccount', 'writeClaudeCredential', 'log']);
    requireEffect('claude login callback records an exchange rejection',
      ['submitCallback', 'log']);
    requireEffect('claude relogin supersedes a pending flow', ['cancelListener', 'log']);
    requireEffect('claude delete removes the bound provider and releases the pick',
      ['deleteClaudeAccount', 'deleteProvider']);
    requireEffect('claude quota returns the usage payload', ['peekAccountToken', 'fetch', 'recordUsage']);
    requireEffect('codex create starts the browser flow', ['createCodexAccount', 'openLoginListener']);
    requireEffect('cli accounts create returns the stored account', ['cliStore.create']);
    requireEffect('cli accounts delete releases the sessions that picked it',
      ['persist.mutate', 'cliStore.remove']);
    requireEffect('zcode sync copies the desktop key', ['zcode.sync']);
    requireEffect('zcode manual key stores the configuration without echoing it', ['zcode.setApiKey']);
    requireEffect('kimi manual key stores the configuration without echoing it', ['kimi.setApiKey']);
    requireEffect('claude oauth status closes a landed login terminal',
      ['refresher.readCredentials', 'destroySessionCascade', 'persist.mutate', 'appendEvent']);
    requireEffect('claude oauth login opens a login terminal',
      ['disposeLoginTerminal', 'createSessionRecord', 'refresher.readCredentials']);
    requireEffect('codex oauth login opens a login terminal', ['disposeLoginTerminal', 'createSessionRecord']);
    requireEffect('commandcode login opens a login terminal', ['disposeLoginTerminal', 'createSessionRecord']);
    requireEffect('forwarded zcode login completes in the browser child', ['zcode.spawnLogin', 'zcode.getStatus']);
    requireEffect('forwarded kimi login completes in the browser child', ['kimi.spawnLogin', 'kimi.getStatus']);

    // The 503 (host unreachable) cannot be produced with a live stub; it is
    // pinned by the gateway integration test. Fail if that pin disappeared.
    try {
      const suite = fs.readFileSync(path.join(repoPath, 'native/gateway/tests/account_routes.rs'), 'utf8');
      if (!suite.includes('fn host_unreachable_is_a_503')) {
        problems.push('503 pin missing: host_unreachable_is_a_503');
      }
      if (!suite.includes('rust_backend_unavailable')) {
        problems.push('503 pin missing: rust_backend_unavailable');
      }
    } catch (error) {
      problems.push(`cannot read native/gateway/tests/account_routes.rs: ${error.message}`);
    }

    const details = path.join(work, 'account-details.json');
    fs.writeFileSync(details, JSON.stringify({ problems, mismatches }, null, 2));
    if (mismatches.length) {
      for (const item of mismatches) console.log(JSON.stringify(item));
    }
    if (problems.length) {
      for (const problem of problems) console.log(`[account-routes] ${problem}`);
      const problemFile = path.join(work, 'coverage-problems.json');
      fs.writeFileSync(problemFile, JSON.stringify(problems, null, 2));
      return { ok: false, details: problemFile };
    }
    if (mismatches.length) {
      console.log(`[account-routes] side effects differ in ${mismatches.length} case(s); details ${details}`);
      return { ok: false, details };
    }
    console.log(`[account-routes] side effects identical in ${nodeEffects.size} case(s)`);
    return { ok: true, details };
  },
});
