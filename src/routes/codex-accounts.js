'use strict';

// Codex official-account management routes (multi-account OAuth).
//
// One official provider uses a globally selected account. Legacy provider records
// remain readable for compatibility; adding an account only creates credentials.
//
// Login is multicc's own PKCE flow (src/codex-auth/official-oauth.js), the same
// shape the Claude accounts use: POST returns an authorize URL, the browser
// redirects to a one-shot loopback listener (127.0.0.1:1455/1457 — the ports
// registered for the public Codex client), multicc exchanges the code and
// writes the account's own auth.json. When the browser cannot reach this
// machine's loopback, the final address (or `code#state`) can be pasted back
// via /login-callback instead of waiting forever — that escape hatch is the
// reason this no longer delegates to an interactive `codex login` terminal.
//
//   GET    /api/codex/accounts                    list accounts (+ bound providerId)
//   POST   /api/codex/accounts                    {label} → account + {oauthUrl}
//   GET    /api/codex/accounts/:id/login-status   pending | complete | error | idle
//   POST   /api/codex/accounts/:id/relogin        restart the browser flow
//   POST   /api/codex/accounts/:id/login-callback finish from a pasted address/code
//   DELETE /api/codex/accounts/:id                remove an inactive credential dir

const { outboundFetch } = require('../network/outbound');
const { officialAccountIdFromProvider } = require('../official-accounts');
const { accountProviderId } = require('../providers/official-catalog');
const { createAccountEgressFetch, parseEgressBinding } = require('../network/egress-fetch');
const {
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  exchangeCode,
  openCallback,
} = require('../codex-auth/official-oauth');

function sanitizeLabel(value) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
}

function assertDeps(deps) {
  for (const name of ['accounts', 'providers']) {
    if (!deps || deps[name] == null) throw new TypeError(`[codex-accounts] deps.${name} is required`);
  }
}

function mountCodexAccountRoutes(app, deps) {
  if (!app || typeof app.get !== 'function') throw new TypeError('[codex-accounts] Express-compatible app is required');
  assertDeps(deps);
  const { accounts, providers } = deps;
  const fetchImpl = deps.fetch || outboundFetch;
  const logger = deps.logger || { info() {}, warn() {}, error() {} };
  const listenerFactory = typeof deps.waitForCallback === 'function' ? deps.waitForCallback : openCallback;
  const refresherStatus = typeof deps.refresherStatus === 'function'
    ? deps.refresherStatus : () => null;
  // 登录换码同样按账号绑定的出口发出；没有绑定就沿用宿主统一网络策略。
  const egressFetchForAccount = typeof deps.egressFetchForAccount === 'function'
    ? deps.egressFetchForAccount
    : createAccountEgressFetch({
      providers,
      appType: 'codex',
      providerIdForAccount: (type, accountId) => accountProviderId(type, accountId),
      logger,
    });

  function providerForAccount(accountId) {
    for (const summary of providers.listProviders('codex')) {
      const record = providers.getProvider('codex', summary.id);
      if (officialAccountIdFromProvider(record) === accountId) return record;
    }
    return null;
  }

  const unified = typeof providers.getOfficialAccountSelection === 'function' && providers.getOfficialAccountSelection('codex') !== null;
  const activeId = () => unified ? providers.getOfficialAccountSelection('codex') : null;

  // ── browser login manager (one listener at a time) ────────────────────────

  let pending = null; // {accountId, state, codeVerifier, oauthUrl, listener}
  const loginStates = new Map(); // accountId -> {state, error, email}

  function loginStatus(accountId) {
    const status = loginStates.get(accountId) || { state: 'idle' };
    // A remote UI needs the authorize URL again after a reload.
    if (status.state === 'pending' && pending && pending.accountId === accountId) {
      return { ...status, oauthUrl: pending.oauthUrl };
    }
    return status;
  }

  async function beginLogin(account) {
    if (pending && pending.accountId === account.id) {
      return { ok: true, oauthUrl: pending.oauthUrl, reused: true };
    }
    if (pending) {
      logger.warn('codex_account_login_superseded', { previous: pending.accountId, next: account.id });
      loginStates.set(pending.accountId, { state: 'error', error: 'superseded by a newer login' });
      pending.listener.cancel();
      pending = null;
    }
    const pkce = generatePkce();
    const state = generateState();
    let listener;
    let oauthUrl;
    try {
      listener = await listenerFactory({});
      oauthUrl = buildAuthorizeUrl({
        state,
        codeChallenge: pkce.codeChallenge,
        redirectUri: listener.redirectUri,
      });
    } catch (error) {
      if (listener) listener.cancel();
      loginStates.set(account.id, { state: 'error', error: error.message });
      logger.warn('codex_account_login_listener_failed', { accountId: account.id, error: error.message });
      return { ok: false, error: error.message };
    }
    pending = { accountId: account.id, state, codeVerifier: pkce.codeVerifier, oauthUrl, listener };
    loginStates.set(account.id, { state: 'pending' });

    listener.promise
      .then(async ({ code, state: returnedState }) => {
        if (returnedState && returnedState !== state) {
          throw new Error('state mismatch (possible CSRF) — login discarded');
        }
        // 账号在创建时就可能已经选了出口：换码请求按它绑定出口发出。
        const exchangeFetch = await egressFetchForAccount(account.id) || fetchImpl;
        const credential = await exchangeCode(exchangeFetch, {
          code,
          codeVerifier: pkce.codeVerifier,
          redirectUri: listener.redirectUri,
        });
        // Its own ChatGPT login now — the account's own auth.json, never the
        // shared ~/.codex one.
        accounts.writeCodexCredential(account.id, credential.auth);
        loginStates.set(account.id, { state: 'complete', email: credential.email || '' });
        logger.info('codex_account_login_complete', { accountId: account.id, email: credential.email || '' });
        // 目录失败不改变已完成的登录状态，也不等待 CLI 启动。
        Promise.resolve().then(() => (deps.modelCatalogRuntime || require('../codex/model-catalog').defaultRuntime)
          .refreshAccount(account.id, { force: true })).catch(() => {
          logger.warn('codex_account_models_refresh_failed', { accountId: account.id });
        });
      })
      .catch((error) => {
        loginStates.set(account.id, { state: 'error', error: error.message });
        logger.warn('codex_account_login_failed', { accountId: account.id, error: error.message });
      })
      .finally(() => {
        if (pending && pending.accountId === account.id) pending = null;
      });

    return { ok: true, oauthUrl, reused: false };
  }

  app.post('/api/codex/accounts/:id/activate', (req, res) => {
    if (!unified) return res.status(409).json({ ok: false, error: '统一官方账号未启用' });
    const id = String(req.params.id || '');
    if (id !== 'global') {
      const account = accounts.listCodexAccounts().find(a => a.id === id);
      if (!account) return res.status(404).json({ ok: false, error: '账号不存在' });
      if (!account.loggedIn) return res.status(409).json({ ok: false, error: '请先完成该账号的登录' });
    }
    try {
      const provider = providers.selectOfficialAccount('codex', id);
      res.json({ ok: true, activeAccountId: id, provider });
    } catch (_) { res.status(500).json({ ok: false, error: '账号切换保存失败' }); }
  });

  function accountDto(account) {
    // Unified mode: every signed-in account is its own provider
    // (`codex-official-<accountId>`); a not-yet-signed-in account has no
    // provider record yet, but its id is stable so the picker can match it.
    const provider = unified ? providers.getProvider('codex', accountProviderId('codex', account.id)) : providerForAccount(account.id);
    return {
      ...account,
      active: activeId() === account.id,
      providerId: unified ? accountProviderId('codex', account.id) : provider ? provider.id : null,
      providerName: provider ? provider.name : null,
      refresh: refresherStatus(account.id),
      login: loginStatus(account.id),
    };
  }

  app.get('/api/codex/accounts', (req, res) => {
    res.json({ ok: true, activeAccountId: activeId(), cliLogin: deps.cliLogin ? deps.cliLogin.status('codex') : null, accounts: [...(unified ? [{ id: 'global', label: '本机 CLI 登录账号', global: true, active: activeId() === 'global' }] : []), ...accounts.listCodexAccounts().map(accountDto)] });
  });

  app.post('/api/codex/accounts', async (req, res) => {
    const label = sanitizeLabel(req.body && req.body.label);
    let egressBinding = null;
    try {
      egressBinding = parseEgressBinding(req.body);
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    const account = accounts.createCodexAccount({ label });
    let providerId = null;
    try {
      const created = unified ? { id: accountProviderId('codex', account.id) } : providers.createProvider({
        appType: 'codex',
        name: `Codex 官方 · ${label || account.id.slice(0, 6)}`,
        settingsConfig: {
          auth: { auth_mode: 'chatgpt' },
          config: '',
          officialAccount: { id: account.id },
        },
      });
      providerId = created.id;
      // 绑定在登录前落盘，换码与之后的所有请求都从这条出口出去。
      if (egressBinding) providers.updateProvider('codex', providerId, { egressBinding });
    } catch (error) {
      accounts.deleteCodexAccount(account.id);
      if (!unified && providerId) { try { providers.deleteProvider('codex', providerId); } catch (_) { /* best-effort rollback */ } }
      return res.status(500).json({ ok: false, error: `provider create failed: ${error.message}` });
    }
    const login = await beginLogin(account);
    res.status(201).json({
      ok: true,
      accountId: account.id,
      providerId,
      oauthUrl: login.ok ? login.oauthUrl : null,
      reused: login.reused === true,
      ...(login.ok ? {} : { loginError: login.error || 'login unavailable' }),
    });
  });

  app.get('/api/codex/accounts/:id/login-status', (req, res) => {
    const accountId = String(req.params.id || '');
    if (!accounts.listCodexAccounts().some(a => a.id === accountId)) {
      return res.status(404).json({ ok: false, error: 'account not found' });
    }
    res.json({ ok: true, accountId, ...loginStatus(accountId) });
  });

  // Browser sign-in from another machine: the redirect lands on the user's own
  // localhost, so they paste that final address (or `code#state`) back here.
  // The listener validates it as this login's own callback and finishes the
  // PKCE exchange; no token or verifier ever leaves this server.
  app.post('/api/codex/accounts/:id/login-callback', (req, res) => {
    const accountId = String(req.params.id || '');
    if (!accounts.listCodexAccounts().some(a => a.id === accountId)) {
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
    logger.info('codex_account_login_callback_pasted', { accountId });
    res.json({ ok: true, accountId, accepted: true });
  });

  app.post('/api/codex/accounts/:id/relogin', async (req, res) => {
    const accountId = String(req.params.id || '');
    const account = accounts.listCodexAccounts().find(a => a.id === accountId);
    if (!account) return res.status(404).json({ ok: false, error: 'account not found' });
    const login = await beginLogin(account);
    res.status(login.ok ? 200 : 502).json({
      ok: login.ok,
      accountId,
      oauthUrl: login.ok ? login.oauthUrl : null,
      reused: login.reused === true,
      ...(login.ok ? {} : { error: login.error || 'login unavailable' }),
    });
  });

  app.delete('/api/codex/accounts/:id', (req, res) => {
    const accountId = String(req.params.id || '');
    if (unified && accountId === 'global') return res.status(409).json({ ok: false, error: '“同 Codex 终端”为内置线路，不能删除' });
    if (unified && activeId() === accountId) providers.selectOfficialAccount('codex', 'global');
    if (pending && pending.accountId === accountId) {
      pending.listener.cancel();
      pending = null;
    }
    loginStates.delete(accountId);
    const provider = unified ? null : providerForAccount(accountId);
    accounts.deleteCodexAccount(accountId);
    if (provider) providers.deleteProvider('codex', provider.id);
    res.json({ ok: true, deletedProviderId: provider ? provider.id : null });
  });
}

module.exports = { mountCodexAccountRoutes };
