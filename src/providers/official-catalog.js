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

// Keep legacy records on disk for historical references. The current catalog
// exposes one identity per vendor; account selection is a separate atomic file.
function createOfficialCatalog({ readRecords, readSelection, writeSelection }) {
  function active(type) {
    const selected = readSelection()[type];
    if (selected == null || selected === 'global') return 'global';
    if (typeof selected !== 'string' || !/^[a-f0-9]{16}$/.test(selected)) throw new Error('invalid saved official account selection');
    return selected;
  }
  function provider(type, id = officialId(type)) {
    const accountId = active(type);
    return {
      id, appType: type, name: type === 'codex' ? 'Codex 官方' : 'Claude 官方',
      source: 'builtin', apiFormat: type === 'codex' ? 'openai_responses' : 'anthropic',
      builtinOfficial: true, activeAccountId: accountId,
      settingsConfig: {
        ...(type === 'codex' ? { auth: { auth_mode: 'chatgpt' }, config: '' } : { env: {} }),
        ...(accountId === 'global' ? {} : { officialAccount: { id: accountId } }),
      },
    };
  }
  function normalize(type, id) {
    if (!TYPES.includes(type)) return id || null;
    if (!id || id === '_default_' || id === officialId(type)) return officialId(type);
    const old = readRecords().find(p => p.id === id && p.appType === type);
    return isOfficial(old) ? officialId(type) : id;
  }
  return {
    active, provider, normalize,
    list(type) {
      return [...TYPES.map(t => provider(t)), ...readRecords().filter(p => !isOfficial(p)
        && !TYPES.some(t => p.id === officialId(t)))].filter(p => !type || p.appType === type);
    },
    get(type, id) {
      const vendor = TYPES.find(t => (!type || type === t) && id === officialId(t));
      if (vendor) return provider(vendor);
      const old = readRecords().find(p => p.id === id && (!type || p.appType === type));
      return isOfficial(old) ? provider(old.appType, id) : old || null;
    },
    select(type, accountId) {
      if (!TYPES.includes(type) || (accountId !== 'global' && !/^[a-f0-9]{16}$/.test(accountId))) {
        throw new Error('invalid official account selection');
      }
      writeSelection({ ...readSelection(), [type]: accountId });
      return provider(type);
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

module.exports = { createOfficialCatalog, normalizeOfficialSessionReferences, officialId, isOfficial };
