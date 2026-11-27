'use strict';

// 迁移期宿主桥接：provider store、凭据/刷新器、额度缓存与通知。
// 公开路由、厂商 HTTP、查询编排、去重和失败回退由 Rust 前门执行。
const { sanitizePublicText } = require('../native/binding').getPublicSafety();
const { isLocalRequest } = require('../native/binding').requestLocality;
const { outboundFetch } = require('../network/outbound');
const { providerLimitSnapshot, getNative } = require('../native/binding');
const HOST_PATH = '/api/__host/provider-balance';
const mounts = new WeakMap();

async function credentials(target) {
  if (target.strategy === 'codex-oauth-usage') {
    return require('../native/binding').readCodexAuth(target.authFile);
  }
  if (target.strategy !== 'claude-oauth-usage') return null;
  if (target.officialAccountId) {
    const service = require('../claude-auth/account-credentials').createClaudeAccountCredentialService({
      accounts: require('../official-accounts').createOfficialAccountStore(),
    });
    const read = await service.peekAccountToken(target.officialAccountId);
    if (!read?.token) throw new Error(`Claude quota credential unavailable: ${read?.reason || 'missing'}`);
    return { accessToken: read.token };
  }
  const read = await require('../native/binding').claudeCliUsage.readCliCredentials();
  if (!read?.ok || !read.accessToken || (read.expiresAt != null && read.expiresAt <= Date.now())) {
    throw new Error('Claude quota CLI credential unavailable or expired');
  }
  return { accessToken: read.accessToken };
}

function mountProviderBalanceHost(app, options) {
  const mounted = mounts.get(app);
  if (mounted) { Object.assign(mounted, options); return; }
  const deps = { ...options };
  mounts.set(app, deps);
  const text = value => typeof value === 'string' ? value : '';
  async function handle(body) {
    const appType = text(body.appType), id = text(body.id);
    if (body.op === 'list') return { ok: true, providers: deps.listProviders().map(p => ({ appType: p.appType, id: p.id, name: p.name || '' })) };
    if (body.op === 'credentials') return { ok: true, auth: await credentials(body.target || {}) };
    if (body.op === 'refreshCodexAuth') return { ok: true, refreshed: await require('../usage-limit-poller').runCodexAuthRefresh({ authFile: body.target?.authFile || null }) };
    if (body.op === 'record') {
      const entry = await deps.onResult?.(appType, id, body.result);
      return { ok: true, snapshot: providerLimitSnapshot(entry, body.now) };
    }
    const provider = deps.getProvider(appType, id);
    if (!provider) return { ok: true, found: false };
    if (body.op === 'cached') {
      const entry = await deps.lookupCached?.(provider.appType, id) || null;
      return { ok: true, found: true, entry, snapshot: providerLimitSnapshot(entry, body.now) };
    }
    if (body.op === 'virtualMember') {
      const virtual = require('../native/binding').virtualProvider;
      const asyncCache = deps.lookupCached && deps.asyncLimitCache === true;
      await (asyncCache ? virtual.refreshAsync(provider) : virtual.refresh(provider));
      try {
        const member = asyncCache ? await virtual.resolveAsync(provider) : virtual.resolve(provider);
        return { ok: true, member: { appType: member.appType, id: member.id } };
      } catch (error) {
        if (error.code !== 'VIRTUAL_NO_AVAILABLE_MEMBER') throw error;
        return { ok: true, member: null };
      }
    }
    if (body.op === 'facts') {
      return { ok: true, found: true, provider: { appType: provider.appType, id: provider.id, virtual: !!provider.virtual,
        egressBinding: provider.egressBinding || null, egressIpAllowlist: provider.egressIpAllowlist || [] },
        target: provider.virtual ? null : deps.getProviderLimitTarget(appType, id),
        egress: require('../native/binding').egressIpPolicy.checkEgressIpAllowed(provider) };
    }
    return null;
  }
  app.post(HOST_PATH, (req, res) => {
    if (!(deps.isLocal || isLocalRequest)(req)) return res.status(404).json({ error: 'not found' });
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    return Promise.resolve(handle(body)).then(value => value === null
      ? res.status(400).json({ error: 'unknown host operation' }) : res.json(value),
    error => res.json({ ok: false, detail: sanitizePublicText(error?.message, 'provider balance host failed') }));
  });
}

function createProviderBalanceRuntime(options = {}) {
  const request = async path => {
    const url = getNative().providerBalanceUrl(options, path);
    const response = await outboundFetch(url, { signal: AbortSignal.timeout(60000) });
    return response.json();
  };
  const path = (type, id, cached) => getNative().providerBalancePath(type, id, cached);
  const refreshOne = (type, id) => request(path(type, id, false)).catch(() => null);
  return Object.freeze({
    queryOne: refreshOne, refreshOne,
    queryAll: () => request('/api/providers/balances'),
    readCached: (type, id) => request(path(type, id, true)),
  });
}

function mountProviderBalanceRoutes(app, options = {}) {
  mountProviderBalanceHost(app, options);
  return options.runtime || createProviderBalanceRuntime(options);
}

module.exports = {
  HOST_PATH, mountProviderBalanceHost, createProviderBalanceRuntime,
  mountProviderBalanceRoutes, mountProviderRelayQuotaRoutes: mountProviderBalanceRoutes,
};
