'use strict';
// FROZEN ORACLE — git show HEAD:src/routes/cli-key-accounts.js (the parent of the
// account/login migration commit). Only relative require paths were rewritten
// to point at the live tree; the handler logic is unchanged. Mounted by
// tests/helpers/legacy-account-routes.js over the scripted world in
// tests/helpers/account-routes-scripted-world.js.

// API-key account management for key-account lanes (Command Code, OpenCode).
// Storage, spawn injection and session picks live in src/cli-key-accounts.js;
// these routes only add, rename/re-key, list and delete. No response ever
// carries a key — only a `keyHint` tail to tell accounts apart.
//
//   GET    /api/cli-accounts/:cli            list accounts
//   POST   /api/cli-accounts/:cli            {label, apiKey} → 201 {account}
//   PATCH  /api/cli-accounts/:cli/:id        {label?, apiKey?} → {account}
//   DELETE /api/cli-accounts/:cli/:id        remove; sessions that picked it
//                                            fall back to the CLI's own login

const { isKeyAccountCli, releaseCliAccountReferences } = require('../../../src/cli-key-accounts');

function mountCliKeyAccountRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function') throw new TypeError('[cli-key-accounts] Express-compatible app is required');
  const { store, sessionPersistence } = deps;
  if (!store || typeof store.list !== 'function') throw new TypeError('[cli-key-accounts] deps.store is required');
  if (!sessionPersistence || typeof sessionPersistence.mutate !== 'function') {
    throw new TypeError('[cli-key-accounts] deps.sessionPersistence (with mutate) is required');
  }

  function lane(req, res) {
    const cli = String(req.params.cli || '');
    if (isKeyAccountCli(cli)) return cli;
    res.status(404).json({ ok: false, error: '该 CLI 不支持 API Key 账户' });
    return null;
  }

  function rejectInput(res, error) {
    if (error && /^CLI_KEY_ACCOUNT_/.test(String(error.code || ''))) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    return res.status(500).json({ ok: false, error: '账户保存失败' });
  }

  app.get('/api/cli-accounts/:cli', (req, res) => {
    const cli = lane(req, res);
    if (!cli) return;
    res.json({ ok: true, cli, accounts: store.list(cli) });
  });

  app.post('/api/cli-accounts/:cli', (req, res) => {
    const cli = lane(req, res);
    if (!cli) return;
    const body = req.body || {};
    try {
      res.status(201).json({ ok: true, account: store.create(cli, { label: body.label, apiKey: body.apiKey }) });
    } catch (error) { rejectInput(res, error); }
  });

  app.patch('/api/cli-accounts/:cli/:id', (req, res) => {
    const cli = lane(req, res);
    if (!cli) return;
    const body = req.body || {};
    try {
      const account = store.update(cli, req.params.id, { label: body.label, apiKey: body.apiKey });
      if (!account) return res.status(404).json({ ok: false, error: '账户不存在' });
      res.json({ ok: true, account });
    } catch (error) { rejectInput(res, error); }
  });

  app.delete('/api/cli-accounts/:cli/:id', (req, res) => {
    const cli = lane(req, res);
    if (!cli) return;
    const id = String(req.params.id || '');
    if (!store.has(cli, id)) return res.status(404).json({ ok: false, error: '账户不存在' });
    try {
      // Release the picks first: a crash between the two steps then leaves an
      // unused account behind, never a session pointing at a missing one.
      const releasedSessions = sessionPersistence.mutate('http.cli-account-delete',
        records => releaseCliAccountReferences(records, cli, id));
      store.remove(cli, id);
      res.json({ ok: true, releasedSessions });
    } catch (_) {
      res.status(500).json({ ok: false, error: '账户删除失败' });
    }
  });
}

module.exports = { mountCliKeyAccountRoutes };
