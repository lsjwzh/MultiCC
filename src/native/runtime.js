'use strict';

const path = require('node:path');
let loadedPath = null;
let loaded = null;
let loadError = null;
let deliveryOwner = null;
let deliveryAddon = null;
const counts = { search: 0, usage: 0 };

function addonPath() {
  return process.env.MULTICC_RUST_ADDON || path.join(process.env.MULTICC_RUST_PREBUILT_DIR || path.resolve(__dirname, '../../native/prebuilt'),
    `${process.platform}-${process.arch}`, 'multicc_core.node');
}
// The native module is the only implementation: there is no Node lane and no
// per-feature off/auto switch. A missing or stale addon is a hard failure that
// callers surface (HTTP 503, scan error), never a silent degradation.
function getNative() {
  const file = addonPath();
  if (file !== loadedPath) {
    loadedPath = file;
    loaded = null;
    loadError = null;
    try {
      loaded = require(file);
      if (loaded.protocolVersion?.() !== 1 || typeof loaded.buildSearchIndex !== 'function'
          || typeof loaded.computeUsage !== 'function' || typeof loaded.cprClaudeQuota !== 'function') {
        throw new Error('rust_protocol_mismatch');
      }
    } catch (error) { loaded = null; loadError = error.code || 'rust_load_failed'; }
  }
  if (!loaded) throw new Error('rust_backend_unavailable');
  return loaded;
}
// Shared instance preserves the original lookup identity for inherited accessors.
function deliveryClassForItem(item) {
  const addon = getNative();
  if (deliveryAddon !== addon) {
    deliveryOwner = new addon.RustDeliveryClassifier(null);
    deliveryAddon = addon;
  }
  return deliveryOwner.classify(item);
}
function record(feature) { if (feature in counts) counts[feature] += 1; }
function status() { return { loaded: !!loaded, loadError, ...counts }; }
// napi 把结构化错误码塞在 message 里，code 统一是 GenericFailure；还原成真实码。
function nativeCode(error) {
  if (error?.code === 'GenericFailure') {
    const code = /^([A-Za-z][A-Za-z0-9_]*)(?::|$)/.exec(String(error.message || ''))?.[1];
    if (code) error.code = code;
  }
  return error;
}

// 原生任务共用 libuv 工作池。只限制并行数，避免搜索突发占满文件 I/O 线程；排满时
// 等待而不拒绝：Air 刷新与任务板落盘也走这条队列，拒绝就是一次失败的刷新或保存。
let active = 0;
const waiting = [];
function runNative(operation) {
  return new Promise((resolve, reject) => {
    const start = () => {
      active += 1;
      Promise.resolve().then(operation).then(resolve, reject).finally(() => {
        active -= 1;
        waiting.shift()?.();
      });
    };
    if (active < 2) start(); else waiting.push(start);
  });
}
// 版本化 HTML 重写：规则只有 Rust 一份（multicc_core::static_assets_routes），
// 分享页在宿主端口上渲染时经这里调用。读文件失败回 null = 退休实现的 500。
function staticVersionedHtml(file, publicDir) {
  return getNative().staticVersionedHtml(file, publicDir) ?? null;
}
function decodeRecoveryEvents(raw) { return getNative().decodeSchedulerRecoveryEvents(raw); }
const reference = (op, value) => JSON.parse(getNative().taskShellReference(op, JSON.stringify(value)));
const taskShellContext = {
  hash: value => reference('hash', value),
  estimateTokens: value => reference('estimate', String(value ?? '')),
  renderSnapshots: snapshots => reference('render', snapshots),
  renderLazyContextPrompt: taskId => reference('lazy-prompt', taskId),
  verifySnapshot: (snapshot, id) => reference('verify', { snapshot, id }),
  snapshotHistory: (taskId, history, { activeTurnId = null, maxBytes = 12000 } = {}) =>
    reference('snapshot', { taskId, history, activeTurnId, maxBytes }),
};
// Compatibility closures keep the existing CLI/SDK callbacks alive. Rust owns
// preparation and all routing decisions; no Provider policy is reimplemented here.
const providerInvocation = {
  createProviderInvocationFactory(options = {}) {
    const native = getNative();
    const ports = Object.assign(native.providerInvocationValidate(options), {
      revision: require('../chat/provider-attempt-runtime').createProviderRevision,
      policy: require('../chat/model-request-policy').resolveModelRequestPolicy,
      proof: require('../chat/turn-request').createProviderRouteProof,
      nativeOpenCodeId: require('../providers/native-opencode').nativeOpenCodeId,
      nativeVendorOf: require('../providers/native-vendor').nativeVendorOf,
    });
    return Object.freeze({ prepare: (input = {}) => native.providerInvocationPrepare(input, ports) });
  },
  protocolFor: (cli, summary) => getNative().providerInvocationProtocol(cli, summary),
  providerRetryRouteOptions: attempt => getNative().providerRetryRouteOptions(attempt),
};
module.exports = { addonPath, getNative, record, status, runNative, nativeCode, deliveryClassForItem,
  staticVersionedHtml, decodeRecoveryEvents, taskShellContext, providerInvocation };
