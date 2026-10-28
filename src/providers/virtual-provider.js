'use strict';

// Migration bridge only: the host owns the existing provider/quota stores and
// Express callbacks. Rust owns configuration validation, selection and retry
// policy. Remove this bridge when those store ports move to Rust CPR.
const { getNative } = require('../native/runtime');
const subscriptions = require('../quota/account-subscription-cache');
let cache = null;
let guard = null, refreshOne = null, recordDto = null;
function configure(options = {}) { cache = options.cache || null; guard = options.guard || null; recordDto = options.recordDto || null; }
function setRefresher(fn) { refreshOne = fn; return fn; }
function call(method, input) {
  const native = getNative('virtual_provider');
  if (typeof native?.[method] !== 'function') throw Object.assign(new Error('虚拟线路需要更新 Rust 原生模块并手动重启服务'),
    { statusCode: 503, safeCprMessage: '虚拟线路需要更新 Rust 原生模块并手动重启服务' });
  return JSON.parse(native[method](JSON.stringify(input)));
}
function validate(input) { return call('validateVirtualProvider', input); }
function status(provider, providers, { model, excluded = [] } = {}) {
  return call('selectVirtualProvider', { appType: provider.appType, virtual: provider.virtual,
    providers: providers.map(p => ({ ...p, virtualGateAllowed:
      require('./egress-ip-policy').checkEgressIpAllowed(p).allowed && !guard?.check({ appType: p.appType, providerId: p.id }).blocked })),
    limits: cache?.snapshot().entries || {}, subscriptions: subscriptions.snapshot(), model, excluded, now: Date.now() });
}
async function refresh(provider) {
  await subscriptions.ready();
  const providers = require('./core').listProviders();
  const plan = status(provider, providers);
  const work = [...plan.refreshIds.map(id => () => refreshOne?.(provider.appType, id)),
    ...plan.subscriptionRefreshIds.map(id => () => subscriptions.refresh(providers.find(p => p.id === id)))];
  for (let i = 0; i < work.length; i += 4) {
    await Promise.allSettled(work.slice(i, i + 4).map(run => run()));
  }
}
function resolve(provider, options) {
  const core = require('./core');
  const decision = status(provider, core.listProviders().filter(p => !p.virtual), options);
  if (!decision.selectedId) throw Object.assign(new Error('虚拟线路暂无可用成员，请检查余量、到期日期和模型'),
    { code: 'VIRTUAL_NO_AVAILABLE_MEMBER', statusCode: 503, safeCprMessage: '虚拟线路暂无可用成员，请检查余量、到期日期和模型' });
  return core.routingProviderView(provider.appType, decision.selectedId);
}
function outcome(provider, statusCode, headersSent, resetMs) {
  const result = call('virtualProviderFailure', { status: statusCode, headersSent, resetMs,
    previous: cache?.get(provider.appType, provider.id)?.summary, now: Date.now() });
  if (result.record) cache?.record(provider.appType, provider.id, result.record);
  return result.retry;
}
function observe(provider, dto) { recordDto?.(provider.appType, provider.id, dto); }
module.exports = { configure, setRefresher, refresh, validate, status, resolve, outcome, observe };
