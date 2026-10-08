'use strict';

const { isOfficialCodexOAuthProvider } = require('../codex/official-relay');

const TYPES = ['claude', 'codex'];
const officialId = type => `${type}-official`;
function configOf(record) {
  try { return typeof record.settingsConfig === 'string' ? JSON.parse(record.settingsConfig) : record.settingsConfig || {}; }
  catch (_) { return {}; }
}
function isOfficial(record) {
  if (!record || !TYPES.includes(record.appType)) return false;
  if (record.appType === 'codex') return isOfficialCodexOAuthProvider(record);
  const cfg = configOf(record), env = cfg.env || {};
  return !env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY;
}

// Keep legacy records on disk for historical references. Every logged-in
// official account is its own provider (`<type>-official-<accountId>`, named
// after the account) so Auto pools can fail over between accounts and quota is
// tracked per account. `<type>-official` stays as a stable alias for "the
// default official account": it resolves to the selected account (or the first
// logged-in one), and only when no account is logged in does it fall back to the
// CLI's own login — that is also the only time it is listed, as the
// "select to log in" entry.
const ACCOUNT_ID_RE = /^[a-f0-9]{16}$/;
const accountProviderId = (type, accountId) => `${officialId(type)}-${accountId}`;
function accountIdOfProviderId(type, id) {
  const prefix = `${officialId(type)}-`;
  if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
  const accountId = id.slice(prefix.length);
  return ACCOUNT_ID_RE.test(accountId) ? accountId : null;
}
function isOfficialProviderId(type, id) {
  return id === officialId(type) || !!accountIdOfProviderId(type, id);
}
function markerOf(record) {
  const marker = configOf(record).officialAccount;
  const id = marker && typeof marker === 'object' ? String(marker.id || '') : '';
  return ACCOUNT_ID_RE.test(id) ? id : null;
}

function createOfficialCatalog({ readRecords, readSelection, writeSelection, listAccounts = () => [], deleteAccount = null }) {
  function accountsOf(type) {
    try {
      const list = listAccounts(type);
      return Array.isArray(list) ? list.filter(a => a && ACCOUNT_ID_RE.test(String(a.id || ''))) : [];
    } catch (_) { return []; }
  }
  function active(type) {
    const selected = readSelection()[type];
    if (selected == null || selected === 'global') return 'global';
    if (typeof selected !== 'string' || !ACCOUNT_ID_RE.test(selected)) throw new Error('invalid saved official account selection');
    return selected;
  }
  // The account the alias stands for: the saved selection while it is still
  // logged in, else the first logged-in account, else the CLI login ('global').
  function defaultAccount(type) {
    const selected = active(type);
    const loggedIn = accountsOf(type).filter(a => a.loggedIn);
    if (selected !== 'global' && loggedIn.some(a => a.id === selected)) return selected;
    return loggedIn.length ? loggedIn[0].id : selected;
  }
  // The synthetic object is rebuilt from scratch on every read (login/account
  // state can't be cached), but a handful of advanced settings — e.g. the
  // egress-IP allowlist — are user-editable and must survive that rebuild.
  // They live in an override record in the SAME store, keyed by the official id
  // and shared by every account of the vendor.
  function overrideOf(type) {
    return readRecords().find(p => p.id === officialId(type) && p.appType === type) || null;
  }
  function accountName(account, accountId) {
    const label = account && String(account.label || '').trim();
    const email = account && String(account.email || '').trim();
    return label || email || accountId.slice(0, 6);
  }
  function provider(type, id = officialId(type), accountId = 'global') {
    const override = overrideOf(type);
    const account = accountId === 'global' ? null : accountsOf(type).find(a => a.id === accountId) || null;
    const cliName = type === 'codex' ? 'Codex' : 'Claude';
    const terminal = id === officialId(type);
    const needsLogin = !terminal && !(account && account.loggedIn);
    const result = {
      id, appType: type,
      name: terminal ? `同 ${cliName} 终端` : `${cliName} 账号 · ${accountName(account, accountId)}`,
      source: 'builtin', apiFormat: type === 'codex' ? 'openai_responses' : 'anthropic',
      builtinOfficial: true, activeAccountId: accountId, needsLogin,
      accountEmail: account && account.email ? String(account.email) : null,
      settingsConfig: {
        ...(type === 'codex' ? { auth: { auth_mode: 'chatgpt' }, config: '' } : { env: {} }),
        ...(accountId === 'global' ? {} : { officialAccount: { id: accountId } }),
      },
    };
    if (override && Array.isArray(override.egressIpAllowlist) && override.egressIpAllowlist.length) {
      result.egressIpAllowlist = override.egressIpAllowlist;
    }
    return result;
  }
  // What a reference should be persisted as. The bare alias stays the alias —
  // it follows whichever account is the default, so a session that never
  // picked an account keeps following the account switch. A per-account id
  // whose account was deleted, and a legacy per-account record without a live
  // account, fall back to that alias, so deleting an account self-heals every
  // session that pointed at it.
  function normalize(type, id) {
    if (!TYPES.includes(type)) return id || null;
    if (!id || id === '_default_' || id === officialId(type)) return officialId(type);
    const accountId = accountIdOfProviderId(type, id);
    if (accountId) return accountsOf(type).some(a => a.id === accountId) ? id : officialId(type);
    const old = readRecords().find(p => p.id === id && p.appType === type);
    if (!isOfficial(old)) return id;
    const marker = markerOf(old);
    return marker && accountsOf(type).some(a => a.id === marker) ? accountProviderId(type, marker) : officialId(type);
  }
  function listOfficial(type) {
    const loggedIn = accountsOf(type).filter(a => a.loggedIn);
    const fallback = defaultAccount(type);
    return [
      provider(type),
      ...loggedIn.map(a => ({ ...provider(type, accountProviderId(type, a.id), a.id), isDefaultOfficial: a.id === fallback })),
    ];
  }
  return {
    active, provider, normalize, defaultAccount, isOfficialId: isOfficialProviderId,
    list(type) {
      return [...TYPES.flatMap(t => listOfficial(t)), ...readRecords().filter(p => !isOfficial(p)
        && !TYPES.some(t => p.id === officialId(t)))].filter(p => !type || p.appType === type);
    },
    get(type, id) {
      const vendor = TYPES.find(t => (!type || type === t) && id === officialId(t));
      if (vendor) return provider(vendor, officialId(vendor), 'global');
      const accountVendor = TYPES.find(t => (!type || type === t) && accountIdOfProviderId(t, id));
      if (accountVendor) {
        const accountId = accountIdOfProviderId(accountVendor, id);
        return accountsOf(accountVendor).some(a => a.id === accountId) ? provider(accountVendor, id, accountId) : null;
      }
      const old = readRecords().find(p => p.id === id && (!type || p.appType === type));
      if (!isOfficial(old)) return old || null;
      const marker = markerOf(old);
      return marker && accountsOf(old.appType).some(a => a.id === marker)
        ? provider(old.appType, id, marker)
        : provider(old.appType, id);
    },
    select(type, accountId) {
      if (!TYPES.includes(type) || (accountId !== 'global' && !ACCOUNT_ID_RE.test(accountId))) {
        throw new Error('invalid official account selection');
      }
      writeSelection({ ...readSelection(), [type]: accountId });
      return accountId === 'global'
        ? provider(type, officialId(type), 'global')
        : provider(type, accountProviderId(type, accountId), accountId);
    },
    delete(type, id) {
      if (!TYPES.includes(type) || id === officialId(type)) return false;
      const accountId = accountIdOfProviderId(type, id);
      if (!accountId || typeof deleteAccount !== 'function') return false;
      if (!accountsOf(type).some(account => account.id === accountId)) return false;
      if (active(type) === accountId) writeSelection({ ...readSelection(), [type]: 'global' });
      deleteAccount(type, accountId);
      return true;
    },
  };
}

function normalizeOfficialSessionReferences(session, normalize) {
  if (!session || session.loginFlow) return false;
  const before = JSON.stringify(session);
  function route(value, cli) {
    if (!value || !TYPES.includes(cli)) return;
    value.provider = normalize(cli, value.provider);
    if (value.subagent?.providerId) value.subagent.providerId = normalize(cli, value.subagent.providerId);
    const candidates = value.providerSelection?.candidates;
    if (Array.isArray(candidates)) {
      const seen = new Map();
      for (const candidate of candidates) {
        candidate.providerId = normalize(cli, candidate.providerId);
        const key = `${candidate.providerId}:${candidate.model || ''}`;
        const existing = seen.get(key);
        if (existing) existing.enabled = existing.enabled || candidate.enabled;
        else seen.set(key, candidate);
      }
      value.providerSelection.candidates = [...seen.values()];
      const enabled = value.providerSelection.candidates.filter(c => c.enabled !== false);
      if (seen.size < candidates.length && enabled.length === 1) {
        value.provider = enabled[0].providerId;
        value.model = enabled[0].model || null;
        value.providerSelection = null;
      }
    }
  }
  route(session, session.cli);
  for (const cli of TYPES) route(session.cliStates?.[cli], cli);
  return before !== JSON.stringify(session);
}

module.exports = {
  createOfficialCatalog, normalizeOfficialSessionReferences, officialId, isOfficial,
  accountProviderId, accountIdOfProviderId, isOfficialProviderId,
};
