'use strict';

const { outboundFetch } = require('../network/outbound');

// Claude official-account management routes (multi-account OAuth).
//
// Unlike codex (whose CLI performs the login), Claude accounts log in through
// MULTICC's own PKCE flow (src/claude-auth/official-oauth.js, a Node port of
// CLIProxyAPI's claude auth): POST returns an authorize URL, the user opens it
// in a browser, Anthropic redirects to the loopback listener on :54545, and the
// server exchanges the code and writes the account credential file. The cpr
// proxy never sees the login — it only reads the resulting credential through
// the injected readOfficialCredential (see claude-account-credentials.js: a
// lapsed token is delegated to the CLI, never renewed here).
//
//   GET    /api/claude/accounts                    list accounts (+ providerId)
//   POST   /api/claude/accounts                    {label} → account + {oauthUrl}
//   GET    /api/claude/accounts/:id/login-status   pending | complete | error | idle
//   POST   /api/claude/accounts/:id/relogin        restart the browser flow
//   POST   /api/claude/accounts/:id/login-callback finish from a pasted address/code
//   DELETE /api/claude/accounts/:id                remove an inactive credential file
//   GET    /api/claude/accounts/:id/quota          per-account subscription usage

const {
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUsage,
  waitForCallback,
} = require('../claude-auth/official-oauth');
const { officialAccountIdFromProvider } = require('../official-accounts');
const { accountProviderId } = require('../providers/official-catalog');
const { createAccountEgressFetch, parseEgressBinding } = require('../network/egress-fetch');

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
  require('../quota/account-subscription-reader').registerAccountSubscriptionReader('claude', deps);
  const { accounts, providers, credentials } = deps;
  const fetchImpl = deps.fetch || outboundFetch;
  const logger = deps.logger || { info() {}, warn() {}, error() {} };
  const listenerFactory = typeof deps.waitForCallback === 'function' ? deps.waitForCallback : waitForCallback;
  // 登录换码也要走账号自己的出口：否则账号是在本机默认 IP 上“注册”的，绑定
  // 出口只能从第一次请求开始生效。没有绑定时返回 null，退回宿主统一网络策略。
  const egressFetchForAccount = typeof deps.egressFetchForAccount === 'function'
    ? deps.egressFetchForAccount
    : createAccountEgressFetch({
      providers,
      appType: 'claude',
      providerIdForAccount: (type, accountId) => accountProviderId(type, accountId),
      logger,
    });

  function providerForAccount(accountId) {
    for (const summary of providers.listProviders('claude')) {
      const record = providers.getProvider('claude', summary.id);
      if (officialAccountIdFromProvider(record) === accountId) return record;
    }
    return null;
  }

  const unified = typeof providers.getOfficialAccountSelection === 'function' && providers.getOfficialAccountSelection('claude') !== null;
  const activeId = () => unified ? providers.getOfficialAccountSelection('claude') : null;

  app.post('/api/claude/accounts/:id/activate', (req, res) => {
    if (!unified) return res.status(409).json({ ok: false, error: '统一官方账号未启用' });
    const id = String(req.params.id || '');
    if (id !== 'global') {
      const account = accounts.listClaudeAccounts().find(a => a.id === id);
      if (!account) return res.status(404).json({ ok: false, error: '账号不存在' });
      if (!account.loggedIn) return res.status(409).json({ ok: false, error: '请先完成该账号的登录' });
    }
    try {
      const provider = providers.selectOfficialAccount('claude', id);
      res.json({ ok: true, activeAccountId: id, provider });
    } catch (_) { res.status(500).json({ ok: false, error: '账号切换保存失败' }); }
  });

  function accountDto(account) {
    // Unified mode: every signed-in account is its own provider
    // (`claude-official-<accountId>`); a not-yet-signed-in account has no
    // provider record yet, but its id is stable so the picker can match it.
    const provider = unified ? providers.getProvider('claude', accountProviderId('claude', account.id)) : providerForAccount(account.id);
    return {
      ...account,
      active: activeId() === account.id,
      providerId: unified ? accountProviderId('claude', account.id) : provider ? provider.id : null,
      providerName: provider ? provider.name : null,
      credential: credentials.status(account.id),
      login: loginStatus(account.id),
    };
  }

  // ── browser login manager (single loopback port → one login in flight) ────

  let pending = null; // {accountId, state, codeVerifier, oauthUrl, listener}
  const loginStates = new Map(); // accountId -> {state, error, email}

  function loginStatus(accountId) {
    const status = loginStates.get(accountId) || { state: 'idle' };
    // When the browser cannot reach this machine's loopback listener (a remote
    // server), the UI still needs the authorize URL to reopen it after a reload.
    if (status.state === 'pending' && pending && pending.accountId === accountId) {
      return { ...status, oauthUrl: pending.oauthUrl };
    }
    return status;
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
        // 账号在创建时就可能已经选了出口：换码请求按它绑定出口发出。
        const exchangeFetch = await egressFetchForAccount(account.id) || fetchImpl;
        const tokenData = await exchangeCode(exchangeFetch, { code, state, codeVerifier: pkce.codeVerifier });
        // Its own token family now: no longer a copy of the CLI's login.
        accounts.writeClaudeCredential(account.id, { ...tokenData, source: 'login', importedRefreshHash: undefined });
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
    res.json({ ok: true, activeAccountId: activeId(), cliLogin: deps.cliLogin ? deps.cliLogin.status('claude') : null, accounts: [...(unified ? [{ id: 'global', label: '本机 CLI 登录账号', global: true, active: activeId() === 'global' }] : []), ...accounts.listClaudeAccounts().map(accountDto)] });
  });

  app.post('/api/claude/accounts', async (req, res) => {
    const label = sanitizeLabel(req.body && req.body.label);
    let egressBinding = null;
    try {
      egressBinding = parseEgressBinding(req.body);
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    const account = accounts.createClaudeAccount({ label });
    let providerId = null;
    try {
      const created = unified ? { id: accountProviderId('claude', account.id) } : providers.createProvider({
        appType: 'claude',
        name: `Claude 官方 · ${label || account.id.slice(0, 6)}`,
        // No baseUrl/token: the cpr official branch resolves the credential
        // from the marker via the injected readOfficialCredential.
        settingsConfig: { env: {}, officialAccount: { id: account.id } },
      });
      providerId = created.id;
      // 绑定在登录前落盘，换码与之后的所有请求都从这条出口出去。
      if (egressBinding) providers.updateProvider('claude', providerId, { egressBinding });
    } catch (error) {
      accounts.deleteClaudeAccount(account.id);
      if (!unified && providerId) { try { providers.deleteProvider('claude', providerId); } catch (_) { /* best-effort rollback */ } }
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

  // Browser sign-in from another machine: the redirect lands on the user's own
  // localhost, so they paste that final address (or `code#state`) back here.
  // The listener validates it as this login's own loopback callback and finishes
  // the PKCE exchange; no token or verifier ever leaves this server.
  app.post('/api/claude/accounts/:id/login-callback', (req, res) => {
    const accountId = String(req.params.id || '');
    if (!accounts.listClaudeAccounts().some(a => a.id === accountId)) {
      return res.status(404).json({ ok: false, error: 'account not found' });
    }
    if (loginStatus(accountId).state === 'complete') {
      return res.json({ ok: true, accountId, state: 'complete', accepted: false });
    }
    if (!pending || pending.accountId !== accountId) {
      return res.status(409).json({ ok: false, error: '没有等待中的登录，请先点「重新登录」' });
    }
    if (typeof pending.listener.submit !== 'function') {
      return res.status(501).json({ ok: false, error: '当前登录方式不支持粘贴回调' });
    }
    const raw = req.body && (req.body.callback != null ? req.body.callback : (req.body.url != null ? req.body.url : req.body.code));
    if (typeof raw !== 'string' || !raw.trim()) {
      return res.status(400).json({ ok: false, error: '请粘贴浏览器地址栏里的完整链接，或授权码 code#state' });
    }
    try {
      pending.listener.submit(raw, { expectedState: pending.state });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    logger.info('claude_account_login_callback_pasted', { accountId });
    res.json({ ok: true, accountId, accepted: true });
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
    if (unified && accountId === 'global') return res.status(409).json({ ok: false, error: '“同 Claude 终端”为内置线路，不能删除' });
    if (unified && activeId() === accountId) providers.selectOfficialAccount('claude', 'global');
    if (pending && pending.accountId === accountId) {
      pending.listener.cancel();
      pending = null;
    }
    loginStates.delete(accountId);
    const provider = unified ? null : providerForAccount(accountId);
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
    // Peek only: asking for a number must not rotate the account's credential.
    const cred = await credentials.peekAccountToken(accountId);
    if (!cred.token) {
      const status = cred.reason === 'credential_unreadable' || cred.reason === 'access_token_missing' ? 401 : 503;
      return res.status(status).json({ status: 'no_auth', error: `账号凭证不可用：${cred.reason}` });
    }
    try {
      const usage = await fetchUsage(fetchImpl, cred.token);
      // Feed Auto's per-account steering too (see quota/official-account-usage).
      if (typeof deps.recordUsage === 'function') {
        try { await deps.recordUsage(accountProviderId('claude', accountId), usage); } catch (_) {}
      }
      res.json({ status: 'ok', fetchedAt: Date.now(), usage });
    } catch (error) {
      // 401 = the token was revoked/expired beyond refresh — say no_auth so the
      // UI can point at relogin instead of a generic upstream failure.
      if (error && error.status === 401) {
        return res.status(401).json({ status: 'no_auth', error: `账号凭证已失效，请重新登录：${error.message}` });
      }
      res.status(502).json({ status: 'unavailable', error: error.message });
    }
  });
}

module.exports = { mountClaudeAccountRoutes };
