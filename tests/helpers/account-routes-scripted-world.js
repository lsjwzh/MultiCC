'use strict';

// Scripted dependency world for the account/login retirement differential
// (docs/rust-migration/differential/account-routes.js).
//
// The eight retired route modules and the surviving host port
// (src/routes/account-routes-host.js) both bottom out in the same runtime
// facts: the official-account store, the provider registry, the credential
// store (Keychain / ~/.codex/auth.json / account files), the PKCE login state
// machine and its loopback listener, the managed browser, the CLI key-account
// store, the session journal and the OAuth status refreshers.
//
// This module turns one plain JSON scenario into the eight dependency bags the
// retired modules were composed with, so the frozen oracle and the front door's
// Node child read one world. Everything here is deterministic and in-memory:
// no keychain, no home directory, no network, no subprocess and no real clock.
// Every semantic call a handler makes is appended to `effects.calls` so the
// differential compares the side-effect sequence, not just the bytes.
//
// A fresh world is built per corpus case (one composition per case on both
// sides), so the module-level login state machine starts empty every time and
// multi-request flows are seeded inside the case with setup requests.

const EventEmitter = require('node:events');

const CLAUDE_ACCOUNT = 'a1b2c3d4e5f60789';
const CODEX_ACCOUNT = 'b1c2d3e4f5061728';

// Values that must never appear in a public response. They are planted in the
// world (tokens, key material, request headers) and the differential scans every
// body for them.
const SECRETS = Object.freeze([
  'ACCESS-CANARY',
  'REFRESH-CANARY',
  'sk-cli-CANARY',
  'Cookie: multicc_session=canary',
  'cpk_runtime_canary',
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// The JWTs codex's token endpoint returns are data, never advice; this one is a
// fixed, unsigned payload carrying exactly the claims the handler lifts out.
const CODEX_ID_TOKEN = [
  Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
  Buffer.from(JSON.stringify({
    email: 'work@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' },
  })).toString('base64url'),
  'sig',
].join('.');

const DEFAULT_CLAUDE_TOKENS = {
  access_token: 'sk-ant-oat01-ACCESS-CANARY',
  refresh_token: 'sk-ant-ort01-REFRESH-CANARY',
  expires_in: 3600,
  account: { email_address: 'work@example.com', uuid: 'acct-uuid-1' },
  organization: { uuid: 'org-uuid-1', name: 'Example Org' },
};

const DEFAULT_CODEX_TOKENS = {
  access_token: 'ACCESS-CANARY',
  refresh_token: 'REFRESH-CANARY',
  id_token: CODEX_ID_TOKEN,
};

const DEFAULT_USAGE = {
  five_hour: { utilization: 21, resets_at: '2026-01-01T00:00:00.000Z' },
  seven_day: { utilization: 44, resets_at: '2026-01-02T00:00:00.000Z' },
};

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function buildDeps(initialScenario = {}) {
  const state = { scenario: initialScenario, effects: { calls: [] } };
  const scenario = () => state.scenario || {};
  const answer = key => {
    const table = scenario().answers || {};
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
  };
  const push = call => state.effects.calls.push(call);

  // ── mutable world maps ───────────────────────────────────────────────────
  const claudeAccounts = [];
  const codexAccounts = [];
  const providers = { claude: [], codex: [] };
  const selection = { claude: null, codex: null };
  const cliAccounts = { commandcode: [], opencode: [] };
  const sessionRecords = new Map();
  const persistedSessions = new Map();
  const directories = new Map();

  // ── network stubs ────────────────────────────────────────────────────────
  // The only two endpoints the handlers reach are the OAuth token endpoint and
  // the Claude usage control plane; the URL picks the scripted reply.
  async function stubFetch(url) {
    const text = String(url);
    const usage = String(url).includes('usage');
    push({ call: 'fetch', url: text, kind: usage ? 'usage' : 'token' });
    const spec = scenario() || {};
    if (usage) {
      const scripted = spec.usage || {};
      if (scripted.throw) throw new Error(scripted.throw);
      const status = scripted.status || 200;
      const body = scripted.body === undefined
        ? JSON.stringify(DEFAULT_USAGE)
        : (typeof scripted.body === 'string' ? scripted.body : JSON.stringify(scripted.body));
      return response(status, body);
    }
    const scripted = spec.tokens || {};
    if (scripted.throw) throw new Error(scripted.throw);
    const status = scripted.status || 200;
    const payload = scripted.body !== undefined
      ? scripted.body
      : (text.includes('openai') || text.includes('auth.openai') ? DEFAULT_CODEX_TOKENS : DEFAULT_CLAUDE_TOKENS);
    return response(status, typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  async function egressFetchForAccount(accountId) {
    push({ call: 'egressFetchForAccount', accountId });
    const spec = scenario().egress || {};
    if (spec.throw) throw new Error(spec.throw);
    return spec.useFetch ? stubFetch : null;
  }

  // ── PKCE loopback listener ──────────────────────────────────────────────
  // `pending`  the browser never comes back: the flow stays pending forever
  // `resolve`  a pasted callback resolves the promise and completes the exchange
  // `reject`   a pasted callback rejects the promise (state becomes error)
  // `nosubmit` the listener cannot accept a pasted address (501 branch)
  // `throw`    binding the listener fails (only codex catches this)
  function makeListener() {
    const spec = scenario().loginListener;
    const mode = typeof spec === 'string' ? spec : (spec && spec.mode) || 'pending';
    push({ call: 'openLoginListener', mode });
    if (mode === 'throw') throw new Error('codex 回调端口都被占用（1455: EADDRINUSE）');
    let resolveOnce;
    let rejectOnce;
    const promise = new Promise((resolve, reject) => { resolveOnce = resolve; rejectOnce = reject; });
    promise.catch(() => {});
    const listener = {
      promise,
      redirectUri: 'http://127.0.0.1:1455/callback',
      cancel() { push({ call: 'cancelListener' }); },
    };
    if (mode !== 'nosubmit') {
      listener.submit = (raw, options = {}) => {
        push({ call: 'submitCallback', raw: String(raw), expectedState: options.expectedState ? '<state>' : null });
        if (mode === 'reject') rejectOnce(new Error('authorization failed: scripted'));
        else resolveOnce({ code: 'scripted-code', state: null });
      };
    }
    return listener;
  }

  // ── child processes (zcode / kimi login) ────────────────────────────────
  function makeChild(spec = {}, { stderr = false } = {}) {
    const child = new EventEmitter();
    child.kill = (signal) => push({ call: 'child.kill', signal: String(signal || '') });
    if (stderr) {
      child.stderr = new EventEmitter();
      child.stderr.pause = () => push({ call: 'stderr.pause' });
      for (const chunk of spec.stderr || []) {
        process.nextTick(() => child.stderr.emit('data', String(chunk)));
      }
    }
    const mode = spec.mode || 'close';
    if (mode === 'error') process.nextTick(() => child.emit('error', new Error('spawn error')));
    else if (mode === 'close') process.nextTick(() => child.emit('close', spec.code === undefined ? 0 : spec.code));
    return child;
  }

  // ── official-account store ──────────────────────────────────────────────
  const accounts = {
    listClaudeAccounts() {
      push({ call: 'listClaudeAccounts' });
      return claudeAccounts.map(clone);
    },
    createClaudeAccount(input) {
      push({ call: 'createClaudeAccount', label: input && input.label });
      const scripted = answer('createClaudeAccount') || {};
      if (scripted.throw) throw new Error(scripted.throw);
      const id = scripted.id || scenario().newAccountId || CLAUDE_ACCOUNT;
      const account = Object.assign({ id, label: input && input.label, loggedIn: true }, clone(scripted.account) || {});
      const at = claudeAccounts.findIndex(item => item.id === id);
      if (at >= 0) claudeAccounts[at] = account; else claudeAccounts.push(account);
      return clone(account);
    },
    deleteClaudeAccount(id) {
      push({ call: 'deleteClaudeAccount', id });
      const at = claudeAccounts.findIndex(item => item.id === id);
      if (at >= 0) claudeAccounts.splice(at, 1);
    },
    writeClaudeCredential(id, data) {
      push({
        call: 'writeClaudeCredential',
        id,
        source: data && data.source,
        email: data && data.email,
        hasAccessToken: !!(data && data.access_token),
        hasRefreshToken: !!(data && data.refresh_token),
      });
    },
    listCodexAccounts() {
      push({ call: 'listCodexAccounts' });
      return codexAccounts.map(clone);
    },
    createCodexAccount(input) {
      push({ call: 'createCodexAccount', label: input && input.label });
      const scripted = answer('createCodexAccount') || {};
      if (scripted.throw) throw new Error(scripted.throw);
      const id = scripted.id || scenario().newCodexAccountId || CODEX_ACCOUNT;
      const account = Object.assign({ id, label: input && input.label, loggedIn: true }, clone(scripted.account) || {});
      const at = codexAccounts.findIndex(item => item.id === id);
      if (at >= 0) codexAccounts[at] = account; else codexAccounts.push(account);
      return clone(account);
    },
    deleteCodexAccount(id) {
      push({ call: 'deleteCodexAccount', id });
      const at = codexAccounts.findIndex(item => item.id === id);
      if (at >= 0) codexAccounts.splice(at, 1);
    },
    writeCodexCredential(id, auth) {
      push({ call: 'writeCodexCredential', id, authMode: auth && auth.auth_mode, hasTokens: !!(auth && auth.tokens) });
    },
  };

  // ── provider registry ───────────────────────────────────────────────────
  const providersApi = {
    listProviders(type) {
      push({ call: 'listProviders', type });
      return (providers[type] || []).map(clone);
    },
    getProvider(type, id) {
      push({ call: 'getProvider', type, id });
      const found = (providers[type] || []).find(item => item.id === id);
      return found ? clone(found) : null;
    },
    createProvider(input) {
      push({ call: 'createProvider', appType: input.appType, name: input.name });
      const scripted = answer('createProvider') || {};
      if (scripted.throw) throw new Error(scripted.throw);
      const accountId = input.settingsConfig
        && input.settingsConfig.officialAccount
        && input.settingsConfig.officialAccount.id;
      const id = scripted.id || `${input.appType}-official-${accountId}`;
      (providers[input.appType] = providers[input.appType] || []).push({
        id,
        appType: input.appType,
        name: input.name,
        settingsConfig: clone(input.settingsConfig) || {},
      });
      return { id };
    },
    updateProvider(type, id, patch) {
      push({ call: 'updateProvider', type, id, hasEgressBinding: !!(patch && patch.egressBinding) });
      const found = (providers[type] || []).find(item => item.id === id);
      if (!found) return null;
      if (patch && patch.egressBinding) found.egressBinding = clone(patch.egressBinding);
      return clone(found);
    },
    deleteProvider(type, id) {
      push({ call: 'deleteProvider', type, id });
      const at = (providers[type] || []).findIndex(item => item.id === id);
      if (at >= 0) providers[type].splice(at, 1);
    },
    getOfficialAccountSelection(type) {
      return selection[type] == null ? null : selection[type];
    },
    selectOfficialAccount(type, id) {
      push({ call: 'selectOfficialAccount', type, id });
      const scripted = answer('selectOfficialAccount') || {};
      if (scripted.throw) throw new Error(scripted.throw);
      selection[type] = id;
      return clone(scripted.provider) || { id: `${type}-official`, name: `${type} 官方` };
    },
  };

  // ── credentials ─────────────────────────────────────────────────────────
  const credentialsApi = {
    status(id) {
      push({ call: 'credentials.status', id });
      return clone((scenario().credentials || {})[id]) || { valid: false };
    },
    async peekAccountToken(id) {
      push({ call: 'peekAccountToken', id });
      const spec = (scenario().accountTokens || {})[id] || { reason: 'no_credentials' };
      return { token: spec.token === undefined ? null : spec.token, reason: spec.reason };
    },
  };

  // ── CLI key-account store ───────────────────────────────────────────────
  const cliStore = {
    list(cli) {
      push({ call: 'cliStore.list', cli });
      return (cliAccounts[cli] || []).map(clone);
    },
    has(cli, id) {
      push({ call: 'cliStore.has', cli, id });
      return (cliAccounts[cli] || []).some(item => item.id === id);
    },
    create(cli, input) {
      push({ call: 'cliStore.create', cli, label: input.label, apiKeyLength: String(input.apiKey || '').length });
      const scripted = answer('cliStoreCreate') || {};
      if (scripted.throw) {
        const error = new Error(scripted.throw);
        error.code = scripted.code;
        throw error;
      }
      const account = clone(scripted.account) || { id: 'c1c2c3c4d5e6f708', label: input.label, keyHint: '…1234' };
      (cliAccounts[cli] = cliAccounts[cli] || []).push(clone(account));
      return clone(account);
    },
    update(cli, id, input) {
      push({ call: 'cliStore.update', cli, id, hasLabel: input.label !== undefined, hasApiKey: input.apiKey !== undefined });
      const scripted = answer('cliStoreUpdate') || {};
      if (scripted.throw) {
        const error = new Error(scripted.throw);
        error.code = scripted.code;
        throw error;
      }
      const found = (cliAccounts[cli] || []).find(item => item.id === id);
      if (!found) return null;
      found.label = input.label === undefined ? found.label : input.label;
      return clone(found);
    },
    remove(cli, id) {
      push({ call: 'cliStore.remove', cli, id });
      const at = (cliAccounts[cli] || []).findIndex(item => item.id === id);
      if (at >= 0) cliAccounts[cli].splice(at, 1);
    },
  };

  const sessionPersistence = {
    mutate(label, fn) {
      push({ call: 'persist.mutate', label });
      return typeof fn === 'function' ? fn(sessionRecords) : undefined;
    },
  };

  // ── session/journal side of the interactive login terminals ─────────────
  async function createSessionRecord(input) {
    push({
      call: 'createSessionRecord',
      dirId: input.dir && input.dir.id,
      cli: input.cli,
      kind: input.kind,
      id: input.id || null,
      loginFlow: input.loginFlow || null,
      persistenceSource: input.persistenceSource || null,
    });
    const scripted = scenario().sessionCreate || {};
    if (scripted.throw) throw new Error(scripted.throw);
    if (scripted.ok === false) return { ok: false, error: scripted.error || 'session create failed' };
    return { ok: true, id: input.id || scripted.id || 'session-1', reused: scripted.reused === true };
  }

  async function disposeLoginTerminal(flow) {
    push({ call: 'disposeLoginTerminal', flow: flow === undefined ? null : flow });
    return 0;
  }

  async function destroySessionCascade(persisted, dir, options) {
    push({ call: 'destroySessionCascade', id: persisted.id, dirId: dir.id, force: !!(options && options.force) });
    return clone(scenario().destroySession) || { ok: true };
  }

  function appendEvent(dirId, type, text, sessionId) {
    push({ call: 'appendEvent', dirId: dirId === undefined ? null : dirId, type, text: text || null, sessionId: sessionId || null });
  }

  const refresher = {
    status() {
      return clone(scenario().claudeOAuthStatus) || {};
    },
    async readCredentials() {
      push({ call: 'refresher.readCredentials' });
      return clone(scenario().claudeCredentials) || { ok: false };
    },
  };

  const logger = {
    info(event, data) { push({ call: 'log', level: 'info', event, keys: data ? Object.keys(data).sort() : [] }); },
    warn(event, data) { push({ call: 'log', level: 'warn', event, keys: data ? Object.keys(data).sort() : [] }); },
    error(event, data) { push({ call: 'log', level: 'error', event, keys: data ? Object.keys(data).sort() : [] }); },
  };

  const cliLogin = {
    status(cli) {
      push({ call: 'cliLogin.status', cli });
      const value = (scenario().cliLogin || {})[cli];
      return value === undefined ? null : clone(value);
    },
  };

  function refresherStatus(id) {
    push({ call: 'refresherStatus', id });
    return clone((scenario().refresherStatus || {})[id]) || null;
  }

  async function recordUsage(providerId, usage) {
    push({ call: 'recordUsage', providerId, keys: usage ? Object.keys(usage).sort() : [] });
  }

  const modelCatalogRuntime = {
    refreshAccount(id, options) {
      push({ call: 'refreshAccount', id, force: !!(options && options.force) });
      return Promise.resolve();
    },
  };

  // ── zcode / kimi native auth ────────────────────────────────────────────
  const zcodeAuth = {
    getZcodeAuthStatus() {
      push({ call: 'zcode.getStatus' });
      const spec = scenario().zcode || {};
      if (spec.statusThrow) throw new Error('zcode status boom');
      return clone(spec.status) || {};
    },
    detectDesktopApiKeys() {
      push({ call: 'zcode.detectDesktopKeys' });
      return clone((scenario().zcode || {}).desktopKeys) || {};
    },
    isZcodeLoginAvailable() {
      const spec = scenario().zcode || {};
      return spec.loginAvailable !== false;
    },
    syncDesktopKeyToCli() {
      push({ call: 'zcode.sync' });
      const spec = scenario().zcode || {};
      if (spec.syncThrow) throw new Error('zcode sync boom');
      return clone(spec.sync) || { synced: false, reason: 'no_desktop_key' };
    },
    setZcodeApiKey(providerId, apiKey, options = {}) {
      push({
        call: 'zcode.setApiKey',
        providerId,
        baseURL: options.baseURL === undefined ? null : options.baseURL,
        apiKeyLength: String(apiKey || '').length,
      });
      const spec = scenario().zcode || {};
      if (spec.setThrow) throw new Error('zcode set boom');
      return clone(spec.set) || { configured: true };
    },
    ensureZcodeAuth() {
      push({ call: 'zcode.ensure' });
      const spec = scenario().zcode || {};
      if (spec.ensureThrow) throw new Error('zcode ensure boom');
      return clone(spec.ensure) || { ok: true, provider: 'z.ai', source: 'cli_config' };
    },
    spawnZcodeLogin() {
      push({ call: 'zcode.spawnLogin' });
      return makeChild((scenario().zcode || {}).login || { mode: 'close', code: 0 });
    },
  };

  const kimiAuth = {
    getKimiAuthStatus() {
      push({ call: 'kimi.getStatus' });
      const spec = scenario().kimi || {};
      if (spec.statusThrow) throw new Error('kimi status boom');
      return clone(spec.status) || {};
    },
    isKimiLoginAvailable() {
      const spec = scenario().kimi || {};
      return spec.loginAvailable !== false;
    },
    spawnKimiLogin() {
      push({ call: 'kimi.spawnLogin' });
      const spec = scenario().kimi || {};
      if (spec.spawnThrow) throw new Error('kimi spawn boom');
      return makeChild(spec.login || { mode: 'close', code: 0 }, { stderr: true });
    },
    parseKimiLoginVerificationUrl() {
      return null;
    },
    setKimiApiKey(apiKey, options = {}) {
      push({
        call: 'kimi.setApiKey',
        baseURL: options.baseURL === undefined ? null : options.baseURL,
        apiKeyLength: String(apiKey || '').length,
      });
      const spec = scenario().kimi || {};
      if (spec.setThrow) throw new Error('kimi set boom');
      return clone(spec.set) || { configured: true };
    },
    ensureKimiAuth() {
      push({ call: 'kimi.ensure' });
      const spec = scenario().kimi || {};
      if (spec.ensureThrow) throw new Error('kimi ensure boom');
      return clone(spec.ensure) || { ok: true, source: 'credentials' };
    },
  };

  const browser = {
    openVisibleLogin(url) {
      push({ call: 'browser.openVisibleLogin', url: String(url) });
      return Promise.resolve();
    },
  };

  // ── apply ──────────────────────────────────────────────────────────────
  function apply(next) {
    state.scenario = next || {};
    const world = scenario();

    claudeAccounts.length = 0;
    for (const account of world.claudeAccounts || []) claudeAccounts.push(clone(account));
    codexAccounts.length = 0;
    for (const account of world.codexAccounts || []) codexAccounts.push(clone(account));

    providers.claude = clone((world.providers || {}).claude) || [];
    providers.codex = clone((world.providers || {}).codex) || [];

    selection.claude = world.selection && world.selection.claude !== undefined ? world.selection.claude : null;
    selection.codex = world.selection && world.selection.codex !== undefined ? world.selection.codex : null;

    cliAccounts.commandcode = clone((world.cliAccounts || {}).commandcode) || [];
    cliAccounts.opencode = clone((world.cliAccounts || {}).opencode) || [];

    sessionRecords.clear();
    for (const record of world.sessionRecords || []) sessionRecords.set(record.id, clone(record));

    persistedSessions.clear();
    for (const entry of world.persistedSessions || []) {
      const record = typeof entry === 'string'
        ? { id: entry, dirId: 'd1', label: 'Claude 登录' }
        : entry;
      persistedSessions.set(record.id, clone(record));
    }

    directories.clear();
    for (const dir of world.directories || []) directories.set(dir.id, clone(dir));

    state.effects.calls.length = 0;
  }

  apply(initialScenario);

  return {
    deps: {
      claude: {
        accounts,
        providers: providersApi,
        credentials: credentialsApi,
        logger,
        cliLogin,
        fetch: stubFetch,
        waitForCallback: makeListener,
        egressFetchForAccount,
        recordUsage,
        modelCatalogRuntime,
      },
      codex: {
        accounts,
        providers: providersApi,
        logger,
        cliLogin,
        fetch: stubFetch,
        waitForCallback: makeListener,
        egressFetchForAccount,
        refresherStatus,
        modelCatalogRuntime,
      },
      cliKey: { store: cliStore, sessionPersistence },
      commandcode: {
        directories,
        createSessionRecord,
        disposeLoginTerminal,
        getStatus: () => clone(scenario().commandcode) || { credentialSaved: false, userName: '', environmentKey: false },
      },
      codexOAuth: {
        getStatus: () => clone(scenario().codexOAuthStatus) || {},
        directories,
        createSessionRecord,
        disposeLoginTerminal,
      },
      claudeOAuthSurface: {
        refresher,
        directories,
        createSessionRecord,
        persistedSessions,
        destroySessionCascade,
        sessionPersistence,
        appendEvent,
        disposeLoginTerminal,
      },
      zcode: { zcodeAuth },
      kimi: {
        kimiAuth,
        getBrowser: () => browser,
        loginWaitMs: 50,
        urlCaptureMs: 10,
      },
    },
    apply,
    effects: state.effects,
    world: scenario,
    state,
  };
}

module.exports = { buildDeps, SECRETS, CLAUDE_ACCOUNT, CODEX_ACCOUNT };
