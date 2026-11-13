'use strict';

// Host ports for the existing quota recorder, egress plugins and refresh callbacks.
// Native storage and per-request Rust state own persistence, selection and retries.
const { getNative } = require('../native/runtime');
const subscriptions = require('../quota/account-subscription-cache');
let cache = null;
let guard = null, refreshOne = null, recordDto = null;
function configure(options = {}) { cache = options.cache || null; guard = options.guard || null; recordDto = options.recordDto || null; }
function setRefresher(fn) { refreshOne = fn; return fn; }
function call(method, input) {
  const native = getNative();
  return JSON.parse(native[method](JSON.stringify(input)));
}
function validate(input) { return call('validateVirtualProvider', input); }
function snapshot(provider, providers, { model, excluded = [] } = {}) {
  return { providerId: provider.id, appType: provider.appType, virtual: provider.virtual,
    providers: providers.map(p => ({ ...p, virtualGateAllowed:
      require('./egress-ip-policy').checkEgressIpAllowed(p).allowed && !guard?.check({ appType: p.appType, providerId: p.id }).blocked })),
    limits: cache?.snapshot().entries || {}, subscriptions: subscriptions.snapshot(), model, excluded, now: Date.now() };
}
// Prepare one committed view for all candidate decisions. This is separate
// from the synchronous legacy adapter until every caller can await it.
async function snapshotAsync(provider, providers, { model, excluded = [] } = {}) {
  if (guard && typeof guard.checkEntry !== 'function') throw new Error('quota guard cannot evaluate a committed snapshot');
  const limits = cache ? (await cache.snapshot()).entries : {};
  return { providerId: provider.id, appType: provider.appType, virtual: provider.virtual,
    providers: providers.map(p => ({ ...p, virtualGateAllowed:
      require('./egress-ip-policy').checkEgressIpAllowed(p).allowed
        && !guard?.checkEntry({ appType: p.appType, providerId: p.id }, limits[`${p.appType}:${p.id}`]).blocked })),
    limits, subscriptions: subscriptions.snapshot(), model, excluded, now: Date.now() };
}
function status(provider, providers, options) { return call('selectVirtualProvider', snapshot(provider, providers, options)); }
async function statusAsync(provider, providers, options) { return call('selectVirtualProvider', await snapshotAsync(provider, providers, options)); }
async function runRefreshWork(provider, providers, plan) {
  const work = [...plan.refreshIds.map(id => () => refreshOne?.(provider.appType, id)),
    ...plan.subscriptionRefreshIds.map(id => () => subscriptions.refresh(providers.find(p => p.id === id)))];
  for (let i = 0; i < work.length; i += 4) {
    await Promise.allSettled(work.slice(i, i + 4).map(run => run()));
  }
}
async function refresh(provider) {
  await subscriptions.ready();
  const providers = require('./core').listProviders();
  return runRefreshWork(provider, providers, status(provider, providers));
}
async function refreshAsync(provider) {
  await subscriptions.ready();
  const providers = require('./core').listProviders();
  return runRefreshWork(provider, providers, await statusAsync(provider, providers));
}
function resolveWithSnapshot(provider, options, input) {
  const core = require('./core');
  let decision;
  try { decision = options?.request ? JSON.parse(options.request.choose(JSON.stringify(input))) : call('selectVirtualProvider', input); }
  catch (error) { if (error.message !== 'VIRTUAL_NO_AVAILABLE_MEMBER') throw error; decision = {}; }
  if (!decision.selectedId) throw Object.assign(new Error('虚拟线路暂无可用成员，请检查余量、到期日期和模型'),
    { code: 'VIRTUAL_NO_AVAILABLE_MEMBER', statusCode: 503, safeCprMessage: '虚拟线路暂无可用成员，请检查余量、到期日期和模型' });
  return core.routingProviderView(provider.appType, decision.selectedId);
}
function resolve(provider, options) {
  const core = require('./core');
  return resolveWithSnapshot(provider, options, snapshot(provider, core.listProviders().filter(p => !p.virtual), options));
}
async function resolveAsync(provider, options) {
  const core = require('./core');
  const input = await snapshotAsync(provider, core.listProviders().filter(p => !p.virtual), options);
  return resolveWithSnapshot(provider, options, input);
}
function outcome(provider, statusCode, headersSent, resetMs, request) {
  const input = { providerId: provider.id, status: statusCode, headersSent, resetMs,
    previous: cache?.get(provider.appType, provider.id)?.summary, now: Date.now() };
  const result = request ? JSON.parse(request.outcome(JSON.stringify(input))) : call('virtualProviderFailure', input);
  if (result.record) cache?.record(provider.appType, provider.id, result.record);
  return result.retry;
}
async function outcomeAsync(provider, statusCode, headersSent, resetMs, request) {
  const at = Date.now();
  const input = { providerId: provider.id, status: statusCode, headersSent, resetMs, now: at };
  const result = request ? JSON.parse(request.outcome(JSON.stringify(input))) : call('virtualProviderFailure', input);
  if (result.retry && cache) {
    if (typeof cache.recordVirtualFailure !== 'function') throw new Error('atomic virtual quota update unavailable');
    await cache.recordVirtualFailure(provider.appType, provider.id, input, at);
  }
  return result.retry;
}
function observe(provider, dto) { return recordDto?.(provider.appType, provider.id, dto); }
module.exports = { snapshot, snapshotAsync, configure, setRefresher, refresh, refreshAsync, validate, status, statusAsync, resolve, resolveAsync, outcome, outcomeAsync, observe };
