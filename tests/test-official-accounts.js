'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createOfficialAccountStore,
  officialAccountIdFromProvider,
  assertAccountId,
  sanitizeLoginEnv,
  codexAccountAuthFilePath,
} = require('../src/official-accounts');
const { createCodexOfficialRelayHandler } = require('../src/codex-official-relay');
const { createCodexAccountRefreshSupervisor } = require('../src/codex-accounts-refresh');
const poller = require('../src/usage-limit-poller');
const { mountCodexQuotaRoutes } = require('../src/routes/codex-quota');

// Swap global fetch with a scripted stub for the duration of one call.
async function withFetch(handler, fn) {
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts, calls.length);
  };
  try { return await fn(calls); } finally { global.fetch = orig; }
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-accounts-test-'));
}

function jwt(payload) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

function writeCodexAuth(dir, { email = 'a@example.com', exp = Math.floor(Date.now() / 1000) + 3600 } = {}) {
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    tokens: {
      access_token: jwt({ exp }),
      id_token: jwt({ email }),
      account_id: 'acct-ext-1',
    },
  }), { mode: 0o600 });
}

// ── account store ────────────────────────────────────────────────────────────

test('codex account create/list/delete round-trips with email + expiry', () => {
  const store = createOfficialAccountStore({ root: tmpRoot() });
  const created = store.createCodexAccount({ label: '工作号' });
  assert.match(created.id, /^[a-f0-9]{16}$/);
  assert.equal(store.listCodexAccounts().length, 1);
  assert.equal(store.listCodexAccounts()[0].loggedIn, false);

  writeCodexAuth(store.codexDir(created.id));
  const listed = store.listCodexAccounts()[0];
  assert.equal(listed.loggedIn, true);
  assert.equal(listed.email, 'a@example.com');
  assert.equal(listed.expired, false);
  assert.equal(listed.label, '工作号');

  const cred = store.readCodexCredential(created.id);
  assert.equal(cred.ok, true);
  assert.equal(cred.accountId, 'acct-ext-1');

  store.deleteCodexAccount(created.id);
  assert.equal(store.listCodexAccounts().length, 0);
});

test('expired codex account credential reads as expired/unusable', () => {
  const store = createOfficialAccountStore({ root: tmpRoot() });
  const created = store.createCodexAccount({ label: '' });
  writeCodexAuth(store.codexDir(created.id), { exp: Math.floor(Date.now() / 1000) - 60 });
  const listed = store.listCodexAccounts()[0];
  assert.equal(listed.expired, true);
  assert.equal(store.readCodexCredential(created.id).ok, false);
  assert.equal(store.readCodexCredential(created.id).reason, 'access_token_expired');
});

test('claude account files round-trip CPA-shaped fields', () => {
  const store = createOfficialAccountStore({ root: tmpRoot() });
  const created = store.createClaudeAccount({ label: '个人号' });
  store.writeClaudeCredential(created.id, {
    access_token: 'sk-ant-oat-x',
    refresh_token: 'sk-ant-ort-x',
    email: 'me@example.com',
    organization_name: 'My Org',
    expired: new Date(Date.now() + 3600e3).toISOString(),
  });
  const listed = store.listClaudeAccounts()[0];
  assert.equal(listed.loggedIn, true);
  assert.equal(listed.email, 'me@example.com');
  assert.equal(listed.organizationName, 'My Org');
  assert.equal(listed.hasRefreshToken, true);
  // writeClaudeCredential merges instead of clobbering (label survives a refresh)
  assert.equal(store.readClaudeCredential(created.id).label, '个人号');
  store.deleteClaudeAccount(created.id);
  assert.equal(store.listClaudeAccounts().length, 0);
});

test('account ids are strict and paths cannot escape the store root', () => {
  assert.throws(() => assertAccountId('../../etc'), /invalid official account id/);
  assert.throws(() => assertAccountId('not-hex'), /invalid official account id/);
  assert.throws(() => codexAccountAuthFilePath('../x'), /invalid official account id/);
  const p = codexAccountAuthFilePath('a'.repeat(16), tmpRoot());
  assert.ok(p.endsWith(path.join('codex', 'a'.repeat(16), 'auth.json')));
});

test('officialAccountIdFromProvider reads the marker from object or JSON string', () => {
  const id = 'b'.repeat(16);
  assert.equal(officialAccountIdFromProvider({ settingsConfig: { officialAccount: { id } } }), id);
  assert.equal(officialAccountIdFromProvider({ settingsConfig: JSON.stringify({ officialAccount: { id } }) }), id);
  assert.equal(officialAccountIdFromProvider({ settingsConfig: { auth: {} } }), null);
  assert.equal(officialAccountIdFromProvider({ settingsConfig: { officialAccount: { id: 'evil/../../x' } } }), null);
  assert.equal(officialAccountIdFromProvider(null), null);
});

test('sanitizeLoginEnv: allowlisted CODEX_HOME only, absolute, login terminals only', () => {
  assert.deepEqual(sanitizeLoginEnv(null, 'codex-login'), { ok: true, env: null });
  assert.deepEqual(sanitizeLoginEnv({}, 'codex-login'), { ok: true, env: null });
  assert.deepEqual(sanitizeLoginEnv({ CODEX_HOME: '/tmp/acct-home' }, 'codex-login'), { ok: true, env: { CODEX_HOME: '/tmp/acct-home' } });

  // requires a loginFlow — never pinnable on an ordinary session
  assert.equal(sanitizeLoginEnv({ CODEX_HOME: '/tmp/x' }, null).ok, false);
  // unknown keys are dropped, not passed through
  assert.deepEqual(sanitizeLoginEnv({ CODEX_HOME: '/tmp/x', ANTHROPIC_API_KEY: 'sk-leak' }, 'codex-login'), { ok: true, env: { CODEX_HOME: '/tmp/x' } });
  // relative paths / control chars rejected
  assert.equal(sanitizeLoginEnv({ CODEX_HOME: 'relative/dir' }, 'codex-login').ok, false);
  assert.equal(sanitizeLoginEnv({ CODEX_HOME: '/tmp/x\nINJECT=1' }, 'codex-login').ok, false);
  assert.equal(sanitizeLoginEnv({ CODEX_HOME: `/tmp/${'x'.repeat(600)}` }, 'codex-login').ok, false);
  assert.equal(sanitizeLoginEnv(['/tmp/x'], 'codex-login').ok, false);
});

// ── relay account-aware credential resolution ────────────────────────────────

function accountProvider(accountId) {
  return {
    id: 'official-acct',
    appType: 'codex',
    name: 'OpenAI Official Account',
    settingsConfig: {
      auth: { auth_mode: 'chatgpt' },
      config: '',
      officialAccount: { id: accountId },
    },
  };
}

function request() {
  const req = new EventEmitter();
  req.params = { providerId: 'official-acct', sessionId: 's1', role: 'main' };
  req.headers = {};
  req.body = { model: 'gpt-5.6', stream: true };
  return req;
}

function response() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.chunks = [];
  res.writableEnded = false;
  res.status = code => { res.statusCode = code; return res; };
  res.json = value => { res.jsonBody = value; res.writableEnded = true; return res; };
  res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = value; };
  res.write = value => { res.chunks.push(Buffer.from(value)); return true; };
  res.end = value => {
    if (value != null) res.chunks.push(Buffer.from(value));
    res.writableEnded = true;
  };
  res.flushHeaders = () => {};
  return res;
}

function sseFetch(captured) {
  return async (url, init) => {
    captured.url = url;
    captured.headers = init.headers;
    const encoder = new TextEncoder();
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/event-stream']]),
      body: {
        getReader: () => ({
          read: async () => ({ done: true }),
          cancel: async () => {},
        }),
        cancel: async () => {},
      },
      json: async () => ({}),
      text: async () => '',
    };
  };
}

test('relay resolves the marked account auth.json and never the shared login', async () => {
  const store = createOfficialAccountStore({ root: tmpRoot() });
  const account = store.createCodexAccount({ label: 'a' });
  writeCodexAuth(store.codexDir(account.id));

  const provider = accountProvider(account.id);
  const captured = {};
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => provider,
    fetch: sseFetch(captured),
    resolveAccountAuthFile: id => store.codexAuthFile(id),
  });
  const res = response();
  await handler(request(), res, () => { throw new Error('must not fall through'); });

  assert.equal(res.statusCode, 200);
  assert.equal(captured.headers['ChatGPT-Account-Id'], 'acct-ext-1');
  assert.match(String(captured.headers.Authorization), /^Bearer ey/);
});

test('marked provider without resolvable account file fails loud, no shared-login borrow', async () => {
  const store = createOfficialAccountStore({ root: tmpRoot() });
  const account = store.createCodexAccount({ label: 'a' }); // no auth.json written

  const provider = accountProvider(account.id);
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => provider,
    fetch: async () => { throw new Error('must not reach upstream'); },
    resolveAccountAuthFile: id => store.codexAuthFile(id),
    // NOTE: no fallback — a missing resolver must not silently use ~/.codex
  });
  const res = response();
  await handler(request(), res, () => { throw new Error('must not fall through'); });
  assert.equal(res.statusCode, 503);
  assert.equal(res.jsonBody.reason, 'credential_unreadable');

  const handlerNoResolver = createCodexOfficialRelayHandler({
    getProvider: () => provider,
    fetch: async () => { throw new Error('must not reach upstream'); },
  });
  const res2 = response();
  await handlerNoResolver(request(), res2, () => { throw new Error('must not fall through'); });
  assert.equal(res2.statusCode, 503);
  assert.equal(res2.jsonBody.reason, 'account_credential_unresolved');
});

test('unmarked official provider still reads the shared default auth file', async () => {
  const provider = {
    id: 'official', appType: 'codex', name: 'OpenAI Official',
    settingsConfig: { auth: { auth_mode: 'chatgpt' }, config: '' },
  };
  let seenAuthFile = null;
  const handler = createCodexOfficialRelayHandler({
    getProvider: () => provider,
    fetch: async () => { throw new Error('must not reach upstream'); },
    readCredential: async (context) => {
      seenAuthFile = context && context.provider ? context.provider.id : null;
      return { ok: false, reason: 'stop-here' };
    },
  });
  const res = response();
  const req = request();
  req.params.providerId = 'official';
  await handler(req, res, () => { throw new Error('must not fall through'); });
  assert.equal(res.statusCode, 503);
  assert.equal(seenAuthFile, 'official');
});

// ── refresh supervisor ───────────────────────────────────────────────────────

test('supervisor syncs refreshers with logged-in accounts and drops removed ones', async () => {
  const store = createOfficialAccountStore({ root: tmpRoot() });
  const made = [];
  const supervisor = createCodexAccountRefreshSupervisor({
    accounts: store,
    makeRefresher: (account) => {
      const r = { account, checks: 0, check: async () => { r.checks += 1; return { outcome: 'fresh' }; }, status: () => ({ refreshCount: r.checks }) };
      made.push(r);
      return r;
    },
  });

  const a = store.createCodexAccount({ label: 'a' });
  store.createCodexAccount({ label: 'b' }); // never logs in → no refresher
  supervisor.sync();
  assert.equal(made.length, 0); // nothing logged in yet

  writeCodexAuth(store.codexDir(a.id));
  await supervisor.checkAll('test');
  assert.equal(made.length, 1);
  assert.equal(made[0].checks, 1);
  assert.deepEqual(supervisor.status(a.id), { refreshCount: 1 });

  store.deleteCodexAccount(a.id);
  supervisor.sync();
  assert.equal(supervisor.status(a.id), null);
});

// ── poller target.authFile + quota route ?account ───────────────────────────

const USAGE_BODY = {
  plan_type: 'pro',
  rate_limit: {
    allowed: true, limit_reached: false,
    primary_window: null,
    secondary_window: { used_percent: 42, limit_window_seconds: 604800, reset_at: 1785287053 },
  },
};

test('poller reads the per-account authFile instead of the shared login', async () => {
  const store = createOfficialAccountStore({ root: tmpRoot() });
  const account = store.createCodexAccount({ label: 'acct' });
  writeCodexAuth(store.codexDir(account.id), { email: 'acct@example.com' });

  await withFetch(
    (url, opts) => {
      assert.match(String(opts.headers.Authorization), /^Bearer ey/, 'uses the account token, not ~/.codex');
      assert.equal(opts.headers['ChatGPT-Account-Id'], 'acct-ext-1');
      return { ok: true, status: 200, json: async () => USAGE_BODY };
    },
    async (calls) => {
      const dto = await poller.pollCodexUsage(
        { strategy: 'codex-oauth-usage', authFile: store.codexAuthFile(account.id) }, 0, 6000,
      );
      assert.equal(dto.provider, 'codex');
      assert.equal(dto.rateLimitType, 'weekly');
      assert.ok(Math.abs(dto.utilization - 0.42) < 1e-9);
      assert.equal(calls.length, 1);
    },
  );
});

function quotaHarness(deps) {
  const routes = {};
  const app = { get: (path, handler) => { routes[`GET ${path}`] = handler; } };
  mountCodexQuotaRoutes(app, deps);
  return {
    invoke: (query) => new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ statusCode: this.statusCode, body }); return this; },
      };
      try {
        routes['GET /api/codex/quota']({ query: query || {} }, res);
      } catch (error) { reject(error); }
    }),
  };
}

test('quota route: ?account resolves the account auth file; shared default unchanged', async () => {
  const store = createOfficialAccountStore({ root: tmpRoot() });
  const account = store.createCodexAccount({ label: 'acct' });
  writeCodexAuth(store.codexDir(account.id));

  const h = quotaHarness({ resolveAccountAuthFile: id => store.codexAuthFile(id) });
  await withFetch(
    (url, opts) => {
      assert.equal(opts.headers['ChatGPT-Account-Id'], 'acct-ext-1');
      return { ok: true, status: 200, json: async () => USAGE_BODY };
    },
    async () => {
      const res = await h.invoke({ account: account.id });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, 'ok');
      assert.equal(res.body.weekly.usedPercent, 42);
      assert.ok(res.body.bar, 'bar rendered once, server-side');
    },
  );
});

test('quota route: account param edge cases fail closed and offline', async () => {
  // resolver missing entirely → feature not enabled
  const noResolver = quotaHarness({});
  let res = await noResolver.invoke({ account: 'a'.repeat(16) });
  assert.equal(res.statusCode, 400);

  // unknown account → 404
  const store = createOfficialAccountStore({ root: tmpRoot() });
  const h = quotaHarness({
    resolveAccountAuthFile: id => (store.listCodexAccounts().some(a => a.id === id) ? store.codexAuthFile(id) : null),
  });
  res = await h.invoke({ account: 'f'.repeat(16) });
  assert.equal(res.statusCode, 404);

  // known account that never finished login → 401 with the account-specific message
  const account = store.createCodexAccount({ label: 'pending' });
  res = await h.invoke({ account: account.id });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.status, 'no_auth');
  assert.match(res.body.error, /尚未完成登录/);
});
