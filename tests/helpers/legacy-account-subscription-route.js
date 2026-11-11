'use strict';
// Frozen oracle for the migration of GET /api/{claude,codex}/subscription into
// the Rust front door. The route body below is a byte-for-byte copy of
// src/routes/account-subscription.js as it stood before the move (including
// its pending Map and cache.register call), with only the module paths
// adapted. It stays in tests/ so the differential run and future readers keep
// a runnable Node reference after the production file is deleted
// (docs/gateway.md §9).
//
// It is NOT production code: nothing in src/ or server.js may require it.

const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..');

function mountAccountSubscriptionRoute(app, vendor, deps = {}) {
  const pending = new Map();
  const cache = require(path.join(ROOT, 'src/quota/account-subscription-cache'));
  async function read(id) {
    if (vendor === 'claude' && id && !deps.accounts.listClaudeAccounts().some(a => a.id === id)) {
      return { status: 'no_auth' };
    }
    if (!pending.has(id)) {
      const attemptAt = Date.now();
      const query = async () => {
        if (vendor === 'codex') {
          const authFile = id ? deps.resolveAccountAuthFile?.(id) : path.join(os.homedir(), '.codex', 'auth.json');
          if (!authFile) return { status: 'no_auth' };
          return require(path.join(ROOT, 'src/providers/native-subscription')).query({ vendor, authFile }, { fetch: deps.fetch });
        }
        let token;
        if (id) token = (await deps.credentials.peekAccountToken(id))?.token;
        else {
          const read = await (deps.readCliCredentials || require(path.join(ROOT, 'src/quota/claude-cli-oauth')).readCliCredentials)();
          if (read?.ok && (read.expiresAt == null || read.expiresAt > Date.now())) token = read.accessToken;
        }
        return require(path.join(ROOT, 'src/providers/native-subscription')).query({ vendor, token }, { fetch: deps.fetch });
      };
      pending.set(id, query().catch(error => ({ status: error?.status === 401 ? 'no_auth' : 'unavailable' }))
        .then(async result => { await cache.record(vendor, id, result, attemptAt).catch(() => {}); return result; })
        .finally(() => pending.delete(id)));
    }
    return pending.get(id);
  }
  cache.register(vendor, read);
  app.get(`/api/${vendor}/subscription`, async (req, res) => {
    const id = String(req.query?.account || '').trim();
    if (id && !/^[a-f0-9]{16}$/.test(id)) return res.status(400).json({ status: 'unavailable', error: 'invalid account' });
    if (vendor === 'claude' && id && !deps.accounts.listClaudeAccounts().some(a => a.id === id)) {
      return res.status(404).json({ status: 'no_auth' });
    }
    res.set?.('Cache-Control', 'no-store');
    res.json(await read(id));
  });
}
module.exports = { mountAccountSubscriptionRoute };
