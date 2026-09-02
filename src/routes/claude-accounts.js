'use strict';

// Claude official-account management routes (multi-account OAuth).
//
// Unlike codex (whose CLI performs the login), Claude accounts log in through
// MULTICC's own PKCE flow (src/claude-official-oauth.js, a Node port of
// CLIProxyAPI's claude auth): POST returns an authorize URL, the user opens it
// in a browser, Anthropic redirects to the loopback listener on :54545, and the
// server exchanges the code and writes the account credential file. The cpr
// proxy never sees the login — it only reads the resulting credential through
// the injected readOfficialCredential (refresh-on-read, see
// claude-account-credentials.js).
//
//   GET    /api/claude/accounts                    list accounts (+ providerId)
//   POST   /api/claude/accounts                    {label} → account + provider + {oauthUrl}
//   GET    /api/claude/accounts/:id/login-status   pending | complete | error | idle
//   POST   /api/claude/accounts/:id/relogin        restart the browser flow
//   DELETE /api/claude/accounts/:id                remove credential file + provider
//   GET    /api/claude/accounts/:id/quota          per-account subscription usage

const {
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUsage,
  waitForCallback,
} = require('../claude-official-oauth');
const { officialAccountIdFromProvider } = require('../official-accounts');

function sanitizeLabel(value) {
  return String(value == null ? '' : value).replace(/[ -]/g, '').trim().slice(0, 64);
}

function assertDeps(deps) {
  for (const name of ['accounts', 'providers', 'credentials']) {
    if (!deps || deps[name] == null) throw new TypeError(`[claude-accounts] deps.${name} is required`);
  }
}

function mountClaudeAccountRoutes(app, deps) {
  if (!app || typeof app.get !== 'function') throw new TypeError('[claude-accounts] Express-compatible app is required');
  assertDeps(deps);
  const { accounts, providers, credentials } = deps;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const logger = deps.logger || { info() {}, warn() {}, error() {} };
  const listenerFactory = typeof deps.waitForCallback === 'function' ? deps.waitForCallback : waitForCallback;

  function providerForAccount(accountId) {
    for (const summary of providers.listProviders('claude')) {
      const record = providers.getProvider('claude', summary.id);
      if (officialAccountIdFromProvider(record) === accountId) return record;
    }
    return null;
  }

  function accountDto(account) {
    const provider = providerForAccount(account.id);
    return {
      ...account,
      providerId: provider ? provider.id : null,
      providerName: provider ? provider.name : null,
      credential: credentials.status(account.id),
      login: loginStatus(account.id),
    };
  }

  // ── browser login manager (single loopback port → one login in flight) ────

  let pending = null; // {accountId, state, codeVerifier, oauthUrl, listener}
  const loginStates = new Map(); // accountId -> {state, error, email}

  function loginStatus(accountId) {
    return loginStates.get(accountId) || { state: 'idle' };
  }

  function beginLogin(account) {
    if (pending && pending.accountId === account.id) {
      return { ok: true, oauthUrl: pending.oauthUrl, reused: true };
    }
    if (pending) {
      // The redirect_uri port is fixed — only one flow can listen. Cancel the
      // stale one explicitly so its status doesn't hang at 'pending'.
      logger.warn('claude_account_login_superseded', { previous: pending.accountId, next: account.id });
      loginStates.set(pending.accountId, { state: 'error', error: 'superseded by a newer login' });
      pending.listener.cancel();
      pending = null;
    }
    const pkce = generatePkce();
    const state = generateState();
    const oauthUrl = buildAuthorizeUrl({ state, codeChallenge: pkce.codeChallenge });
    const listener = listenerFactory({});
    pending = { accountId: account.id, state, codeVerifier: pkce.codeVerifier, oauthUrl, listener };
    loginStates.set(account.id, { state: 'pending' });

    listener.promise
      .then(async ({ code, state: returnedState }) => {
        if (returnedState && returnedState !== state) {
          throw new Error('state mismatch (possible CSRF) — login discarded');
        }
        const tokenData = await exchangeCode(fetchImpl, { code, state, codeVerifier: pkce.codeVerifier });
        accounts.writeClaudeCredential(account.id, tokenData);
        loginStates.set(account.id, { state: 'complete', email: tokenData.email || '' });
        logger.info('claude_account_login_complete', { accountId: account.id, email: tokenData.email || '' });
      })
      .catch((error) => {
        loginStates.set(account.id, { state: 'error', error: error.message });
        logger.warn('claude_account_login_failed', { accountId: account.id, error: error.message });
      })
      .finally(() => {
        if (pending && pending.accountId === account.id) pending = null;
      });

    return { ok: true, oauthUrl, reused: false };
  }

  app.get('/api/claude/accounts', (req, res) => {
    res.json({ ok: true, accounts: accounts.listClaudeAccounts().map(accountDto) });
  });

  app.post('/api/claude/accounts', async (req, res) => {
    const label = sanitizeLabel(req.body && req.body.label);
    const account = accounts.createClaudeAccount({ label });
    let providerId = null;
    try {
      const created = providers.createProvider({
        appType: 'claude',
        name: `Claude 官方 · ${label || account.id.slice(0, 6)}`,
        // No baseUrl/token: the cpr official branch resolves the credential
        // from the marker via the injected readOfficialCredential.
        settingsConfig: { env: {}, officialAccount: { id: account.id } },
      });
      providerId = created.id;
    } catch (error) {
      accounts.deleteClaudeAccount(account.id);
      return res.status(500).json({ ok: false, error: `provider create failed: ${error.message}` });
    }
    const login = beginLogin(account);
    res.status(201).json({ ok: true, accountId: account.id, providerId, oauthUrl: login.oauthUrl, reused: login.reused });
  });

  app.get('/api/claude/accounts/:id/login-status', (req, res) => {
    const accountId = String(req.params.id || '');
    if (!accounts.listClaudeAccounts().some(a => a.id === accountId)) {
      return res.status(404).json({ ok: false, error: 'account not found' });
    }
    res.json({ ok: true, accountId, ...loginStatus(accountId) });
  });

  app.post('/api/claude/accounts/:id/relogin', (req, res) => {
    const accountId = String(req.params.id || '');
    const account = accounts.listClaudeAccounts().find(a => a.id === accountId);
    if (!account) return res.status(404).json({ ok: false, error: 'account not found' });
    const login = beginLogin(account);
    res.json({ ok: true, accountId, oauthUrl: login.oauthUrl, reused: login.reused });
  });

  app.delete('/api/claude/accounts/:id', (req, res) => {
    const accountId = String(req.params.id || '');
    if (pending && pending.accountId === accountId) {
      pending.listener.cancel();
      pending = null;
    }
    loginStates.delete(accountId);
    const provider = providerForAccount(accountId);
    accounts.deleteClaudeAccount(accountId);
    if (provider) providers.deleteProvider('claude', provider.id);
    res.json({ ok: true, deletedProviderId: provider ? provider.id : null });
  });

  // Per-account subscription usage via the OAuth control plane — no browser
  // scraping involved (that stays the shared-login fallback in claude-usage-quota).
  app.get('/api/claude/accounts/:id/quota', async (req, res) => {
    const accountId = String(req.params.id || '');
    if (!accounts.listClaudeAccounts().some(a => a.id === accountId)) {
      return res.status(404).json({ status: 'no_auth', error: '账号不存在' });
    }
    const cred = await credentials.readAccountToken(accountId);
    if (!cred.token) {
      const status = cred.reason === 'credential_unreadable' || cred.reason === 'access_token_missing' ? 401 : 503;
      return res.status(status).json({ status: 'no_auth', error: `账号凭证不可用：${cred.reason}` });
    }
    try {
      const usage = await fetchUsage(fetchImpl, cred.token);
      res.json({ status: 'ok', fetchedAt: Date.now(), usage });
    } catch (error) {
      res.status(502).json({ status: 'unavailable', error: error.message });
    }
  });
}

module.exports = { mountClaudeAccountRoutes };
