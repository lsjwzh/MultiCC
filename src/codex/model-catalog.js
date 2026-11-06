'use strict';

// Node 仅适配账号目录、现有代理插件与原生接口。模型发现、24 小时缓存、
// CLI 版本失效和持久化均由 Rust 执行；这里不读取全局模型文件作为账号兜底。
const os = require('node:os');
const path = require('node:path');
const { createOfficialAccountStore, officialAccountIdFromProvider } = require('../official-accounts');
const { isOfficialCodexOAuthProvider } = require('./official-relay');
const native = require('../native/runtime');

function unavailable(code = 'native_unavailable') {
  return { models: [], fetchedAt: 0, cliVersion: '', stale: true,
    diagnostic: { code, message: '模型目录暂不可用，请稍后重试' }, source: 'unavailable' };
}

function createCodexAccountModelCatalogRuntime(options = {}) {
  const accounts = options.accounts || createOfficialAccountStore();
  const globalHome = options.globalHome || path.join(os.homedir(), '.codex');
  const invalidating = new Map(); // 重登录到强制刷新完成期间禁止展示旧身份快照。
  const pending = new Map(); // 仅跟踪原生调用生命周期，供前端判断后台加载状态。
  const getNative = options.getNative || native.getNative;
  const runNative = options.runNative || native.runNative;
  const providers = () => options.providers || require('../providers/core');
  let egress;

  function resolveProvider(value = 'codex-official') {
    if (value && typeof value === 'object') return value;
    return providers().getProvider('codex', String(value || 'codex-official'));
  }
  function accountOf(provider) {
    const id = officialAccountIdFromProvider(provider);
    if (id) return id;
    if (provider && provider.activeAccountId && provider.activeAccountId !== 'global') {
      accounts.codexDir(provider.activeAccountId); // validate before resolving a path
      return provider.activeAccountId;
    }
    return 'global';
  }
  function homeOf(id) { return id === 'global' ? globalHome : accounts.codexDir(id); }
  function peekProvider(value) {
    try {
      const provider = resolveProvider(value);
      if (!isOfficialCodexOAuthProvider(provider)) return unavailable('not_official');
      const home = homeOf(accountOf(provider));
      if (invalidating.has(home)) return { ...unavailable('refreshing'), source: 'loading' };
      const addon = getNative();
      return JSON.parse(addon.codexModelsPeek(home));
    } catch (_) { return unavailable(); }
  }
  function isRefreshing(value) {
    try { return pending.has(homeOf(accountOf(resolveProvider(value)))); } catch (_) { return false; }
  }
  async function childEnv(home, provider) {
    const base = typeof options.env === 'function' ? options.env() : options.env || process.env;
    const { stripOpenAiEnv } = require('./oauth-refresh');
    const getChildProxyEnv = options.getChildProxyEnv || require('../network/outbound').getChildProxyEnv;
    const env = stripOpenAiEnv(await getChildProxyEnv(stripOpenAiEnv(base)));
    delete env.CODEX_API_KEY;
    env.CODEX_HOME = home;
    if (provider?.egressBinding) {
      const resolve = options.resolveProxyUrl || (binding => {
        egress ||= require('../claude-auth/egress-agent').createClaudeEgressAgentResolver();
        return egress.resolveProxyUrl(binding);
      });
      const proxy = await resolve(provider.egressBinding);
      if (!proxy) throw new Error('egress_unavailable');
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
        env[key] = proxy; env[key.toLowerCase()] = proxy;
      }
      env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1';
    }
    return env;
  }
  function refreshProvider(value, refreshOptions = {}) {
    let provider, home;
    try {
      provider = resolveProvider(value);
      if (!isOfficialCodexOAuthProvider(provider)) return Promise.resolve(unavailable('not_official'));
      home = homeOf(accountOf(provider));
    } catch (_) { return Promise.resolve(unavailable('account_unavailable')); }
    const explicitForce = refreshOptions.force === true;
    const ticket = refreshOptions._ticket || (explicitForce ? Symbol('login-refresh') : invalidating.get(home));
    if (explicitForce && !refreshOptions._ticket) invalidating.set(home, ticket);
    const force = explicitForce || invalidating.has(home);
    const active = pending.get(home);
    if (active) {
      // 登录写入新凭据后必须执行强制刷新，不能吞掉之前启动的普通目录读取。
      if (explicitForce) {
        return active.promise.then(() => refreshProvider(provider, { ...refreshOptions, force: true, _ticket: ticket }));
      }
      return active.promise;
    }
    let nativeCompleted = false;
    const promise = Promise.resolve().then(async () => {
      const addon = getNative();
      const env = await childEnv(home, provider);
      const cliBin = options.cliBin || require('../cli-adapters/commands').resolveCliCommands({
        env, logger: { log() {}, warn() {} },
      }).codex;
      const result = JSON.parse(await runNative(() => addon.codexModelsRefresh(JSON.stringify({
        home, cliBin, env, force,
      }))));
      nativeCompleted = true;
      return result;
    }).catch(() => ({ ...peekProvider(provider), stale: true,
      diagnostic: { code: 'refresh_unavailable', message: '模型刷新失败，保留上次目录' },
    })).finally(() => {
      pending.delete(home);
      if (force && nativeCompleted && invalidating.get(home) === ticket) invalidating.delete(home);
    });
    pending.set(home, { promise, force });
    return promise;
  }
  async function loadProvider(value) {
    try {
      const provider = resolveProvider(value);
      if (!isOfficialCodexOAuthProvider(provider)) return unavailable('not_official');
      const home = homeOf(accountOf(provider));
      if (invalidating.has(home)) return peekProvider(provider);
      const addon = getNative();
      await runNative(() => addon.codexModelsLoad(home));
      return peekProvider(provider);
    } catch (_) { return unavailable(); }
  }
  async function hydrate() {
    // 启动时只恢复已有持久化目录，逐个调度避免占满原生队列，不启动 CLI。
    const records = providers().listProviders('codex');
    for (const record of records) await loadProvider(record.id);
  }
  function refreshAccount(id, refreshOptions = {}) {
    // 登录成功时账号可能尚未出现在摘要中；现有记录仍用于解析账号专属出口。
    let provider;
    try {
      provider = providers().listProviders('codex')
        .map(summary => providers().getProvider('codex', summary.id))
        .find(record => record && accountOf(record) === id && isOfficialCodexOAuthProvider(record));
    } catch (_) { return Promise.resolve(unavailable('account_unavailable')); }
    provider ||= { appType: 'codex', activeAccountId: id,
      settingsConfig: { auth: { auth_mode: 'chatgpt' }, config: '',
        ...(id === 'global' ? {} : { officialAccount: { id } }) } };
    return refreshProvider(provider, refreshOptions);
  }
  return Object.freeze({ resolveProvider, peekProvider, refreshProvider, refreshAccount, isRefreshing, loadProvider, hydrate });
}

const defaultRuntime = createCodexAccountModelCatalogRuntime();
function startDefaultRuntime() {
  Promise.resolve().then(() => defaultRuntime.hydrate()).catch(() => {});
  return defaultRuntime;
}
module.exports = { createCodexAccountModelCatalogRuntime, defaultRuntime, startDefaultRuntime };
