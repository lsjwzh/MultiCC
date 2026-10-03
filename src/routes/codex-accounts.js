'use strict';

// Codex official-account management routes (multi-account OAuth).
//
// One official provider uses a globally selected account. Legacy provider records
// remain readable for compatibility; adding an account only creates credentials.
//
// Login is a whitelisted loginFlow terminal: `codex login` runs with
// CODEX_HOME=<account dir> (loginEnv), so the browser OAuth flow writes the
// account's own auth.json and never touches the shared ~/.codex login.
//
//   GET    /api/codex/accounts            list accounts (+ bound providerId)
//   POST   /api/codex/accounts            {label} → create + open login terminal
//   POST   /api/codex/accounts/:id/relogin  reopen the login terminal
//   DELETE /api/codex/accounts/:id        remove an inactive credential dir

const { officialAccountIdFromProvider } = require('../official-accounts');
const { accountProviderId } = require('../providers/official-catalog');

function sanitizeLabel(value) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
}

function assertDeps(deps) {
  for (const name of ['accounts', 'providers', 'directories', 'createSessionRecord']) {
    if (!deps || deps[name] == null) throw new TypeError(`[codex-accounts] deps.${name} is required`);
  }
}

function mountCodexAccountRoutes(app, deps) {
  if (!app || typeof app.get !== 'function') throw new TypeError('[codex-accounts] Express-compatible app is required');
  assertDeps(deps);
  const { accounts, providers, directories, createSessionRecord } = deps;
  const persistedSessionExists = typeof deps.persistedSessionExists === 'function'
    ? deps.persistedSessionExists : () => false;
  const refresherStatus = typeof deps.refresherStatus === 'function'
    ? deps.refresherStatus : () => null;

  function providerForAccount(accountId) {
    for (const summary of providers.listProviders('codex')) {
      const record = providers.getProvider('codex', summary.id);
      if (officialAccountIdFromProvider(record) === accountId) return record;
    }
    return null;
  }

  const unified = typeof providers.getOfficialAccountSelection === 'function' && providers.getOfficialAccountSelection('codex') !== null;
  const activeId = () => unified ? providers.getOfficialAccountSelection('codex') : null;

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
    };
  }

  function loginSessionId(accountId) {
    return `codex-acct-login-${accountId}`;
  }

  async function openLoginTerminal(account, label) {
    const sessionId = loginSessionId(account.id);
    if (persistedSessionExists(sessionId)) return { ok: true, sessionId, reused: true };
    const dirList = typeof directories.values === 'function' ? [...directories.values()] : [];
    const dir = dirList.find(d => d && d.path) || dirList[0];
    if (!dir) return { ok: false, error: 'no directory available' };
    const result = await createSessionRecord({
      dir,
      cli: 'codex',
      kind: 'terminal',
      id: sessionId,
      label: `Codex 登录 · ${label || account.id}`,
      provider: null, // not a turn provider — loginEnv pins the account home
      loginFlow: 'codex-login',
      loginEnv: { CODEX_HOME: accounts.codexDir(account.id) },
      persistence: 'required',
      persistenceSource: 'runtime.codex-account-login',
    });
    if (!result || !result.ok) return { ok: false, error: (result && result.error) || 'session create failed' };
    return { ok: true, sessionId: result.id, reused: !!result.reused };
  }

  app.get('/api/codex/accounts', (req, res) => {
    res.json({ ok: true, activeAccountId: activeId(), accounts: [...(unified ? [{ id: 'global', label: '本机 CLI 登录账号', global: true, active: activeId() === 'global' }] : []), ...accounts.listCodexAccounts().map(accountDto)] });
  });

  app.post('/api/codex/accounts', async (req, res) => {
    const label = sanitizeLabel(req.body && req.body.label);
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
    } catch (error) {
      accounts.deleteCodexAccount(account.id);
      return res.status(500).json({ ok: false, error: `provider create failed: ${error.message}` });
    }
    const login = await openLoginTerminal(account, label);
    res.status(login.ok ? 201 : 502).json({
      ok: login.ok,
      accountId: account.id,
      providerId,
      loginSessionId: login.sessionId || null,
      reused: login.reused === true,
      ...(login.ok ? {} : { error: login.error || 'login session create failed' }),
    });
  });

  app.post('/api/codex/accounts/:id/relogin', async (req, res) => {
    const accountId = String(req.params.id || '');
    const account = accounts.listCodexAccounts().find(a => a.id === accountId);
    if (!account) return res.status(404).json({ ok: false, error: 'account not found' });
    const login = await openLoginTerminal(account, account.label);
    res.status(login.ok ? 200 : 502).json({
      ok: login.ok,
      accountId,
      loginSessionId: login.sessionId || null,
      reused: login.reused === true,
      ...(login.ok ? {} : { error: login.error || 'login session create failed' }),
    });
  });

  app.delete('/api/codex/accounts/:id', (req, res) => {
    const accountId = String(req.params.id || '');
    if (unified && (accountId === 'global' || activeId() === accountId)) return res.status(409).json({ ok: false, error: '请先切换到其他账号再删除；本机登录入口不可删除' });
    const provider = unified ? null : providerForAccount(accountId);
    accounts.deleteCodexAccount(accountId);
    if (provider) providers.deleteProvider('codex', provider.id);
    res.json({ ok: true, deletedProviderId: provider ? provider.id : null });
  });
}

module.exports = { mountCodexAccountRoutes };
