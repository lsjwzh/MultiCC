'use strict';

const path = require('node:path');
let loadedPath = null;
let loaded = null;
let loadError = null;
let deliveryOwner = null;
let deliveryAddon = null;
const counts = { search: 0, usage: 0 };

function gatewayPath() {
  return path.join(path.dirname(addonPath()), process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
}
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

// Preserve the synchronous spawn-port contracts while Rust owns file writes
// and credential selection. Only key names cross the env cleanup boundary.
const codexProviderHome = {
  materialize(home, settings, authOnly = false) {
    const globalAuth = path.join(require('node:os').homedir(), '.codex', 'auth.json');
    const result = getNative().codexProviderMaterialize(home, globalAuth, JSON.stringify(settings ?? {}), authOnly);
    return authOnly ? result : JSON.parse(result);
  },
  materializeOfficial: (home, id, config) => getNative().codexProviderOfficialHome(home, id, config),
  sanitizeOfficial: (home, proxyPath) => getNative().codexProviderSanitizeHome(home, proxyPath),
  stripOfficialEnv(env) {
    for (const key of getNative().codexProviderOfficialEnvKeys(Object.keys(env))) delete env[key];
  },
  proxyConfigRequired: options => getNative().codexProxyConfigRequired(options),
  assertProxyConfigApplied: options => getNative().assertCodexProxyConfigApplied(options),
};

const settingsOverridesDir = path.join(require('node:os').homedir(), '.multicc', 'claude-settings-overrides');
const claudeSettingsOverride = {
  OVERRIDE_DIR: settingsOverridesDir,
  ROUTING_KEY_RE: /^(?:ANTHROPIC_|CLAUDE_CODE_)/,
  routingEnvOf: env => getNative().claudeRoutingEnv(env),
  settingsOverrideFor: (session, env, extra) =>
    getNative().claudeSettingsOverride(settingsOverridesDir, session, env, extra),
};

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
function createAutoProviderHandoff(options = {}) {
  const native = getNative(), ports = native.autoProviderHandoffPorts(options), inject = ports.inject;
  const owner = new native.RustAutoProviderHandoff();
  return Object.freeze({
    async schedule(input = {}) {
      const plan = owner.prepare(input, ports);
      if (plan.done) return plan.result;
      let admitted, fault, caught = false;
      try { admitted = await inject(...plan.args); }
      catch (error) { fault = error; caught = true; }
      return owner.finish(plan, admitted, fault, caught, ports);
    },
    clearSession: sessionId => owner.clearSession(sessionId),
  });
}
function createClaudeAdapter(deps = {}) {
  const native = getNative();
  const ports = Object.assign(native.claudeAdapterPorts(deps,
    path.join(__dirname, '../cli-adapters/claude-agent-sdk-bridge.mjs'), process.execPath), {
    renderPrompt: require('../message-composer').renderPrompt,
    isMainResult: require('../cli-adapters/result-completion').isMainResult,
    displayNameOf: require('../cli/cli-capability').displayNameOf,
  });
  return {
    name: 'claude',
    createCompletionTracker: require('../cli-adapters/result-completion').createResultCompletionTracker,
    cmd: ports.cmd,
    buildTerminalCmd: session => native.claudeAdapterTerminal(session, ports),
    buildInvocation: envelope => native.claudeAdapterInvocation(envelope, ports),
    decodeEvent: event => native.claudeAdapterDecode(event, ports),
    prepareSpawn: ({ sessionId }) => native.claudeAdapterPrepareSpawn(sessionId, require('node:os').homedir),
    needsAsyncSessionIdCapture: false,
  };
}
const codexAdapter = {
  createCodexAdapter(deps) {
    const native = getNative(), ports = Object.assign(native.codexAdapterPorts(deps), {
      renderPrompt: require('../message-composer').renderPrompt,
      extractUpstreamError: require('../upstream-error').extractUpstreamError,
      displayNameOf: require('../cli/cli-capability').displayNameOf,
    });
    return {
      name: 'codex',
      createCompletionTracker: () => require('../cli-adapters/completion').createProtocolCompletionTracker('codex'),
      cmd: ports.cmd,
      buildTerminalCmd: value => native.codexAdapterCall('terminal', value, ports),
      buildInvocation: value => native.codexAdapterCall('invocation', value, ports),
      decodeEvent: value => native.codexAdapterCall('decode', value, ports),
      needsAsyncSessionIdCapture: true,
    };
  },
  normalizeCodexUsage: value => getNative().codexAdapterCall('usage', value, undefined),
  mcpResultText: value => getNative().codexAdapterCall('mcp-text', value, undefined),
  isCodexInternalNoise: value => getNative().codexAdapterCall('noise', value, undefined),
  routerMcpConfigArgs: (node, script) => getNative().codexAdapterCall('router', [node, script], undefined),
};
const codexAppAdapter = {
  createCodexExpAdapter(deps = {}) {
    const native = getNative();
    const ports = Object.assign(native.codexAppAdapterPorts(deps,
      'codex-app-bridge', gatewayPath(), process.execPath), {
      renderPrompt: require('../message-composer').renderPrompt,
      displayNameOf: require('../cli/cli-capability').displayNameOf,
    });
    const owner = new native.RustCodexAppAdapter();
    return {
      name: 'codex-exp', cmd: ports.executable,
      createCompletionTracker: () => require('../cli-adapters/completion').createProtocolCompletionTracker('codex-exp'),
      buildTerminalCmd: () => native.codexAppAdapterValue('terminal', deps, undefined),
      buildInvocation: value => owner.invocation(value, ports),
      decodeEvent: value => owner.decode(value, ports),
      needsAsyncSessionIdCapture: true,
    };
  },
  appServerUsage: value => getNative().codexAppAdapterValue('usage', value, undefined),
  addUsage: (current = {}, next = {}) => getNative().codexAppAdapterValue('add', current, next),
  isReconnectProgress: value => getNative().codexAppAdapterValue('reconnect', value, undefined),
  requestUserInputEvent: value => getNative().codexAppAdapterValue('question', value, undefined),
};
const codexBackground = {
  safeText: (value, limit = 180) => getNative().codexBackgroundText('safe', value, limit),
  unwrapShellCommand: value => getNative().codexBackgroundText('command', value, 0),
  toolDetail: value => getNative().codexBackgroundText('detail', value, 0),
  createCodexBackgroundEvents({ emit, attach, mainThreadId = null, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, throttleMs = 1000 } = {}) {
    const owner = new (getNative().RustCodexBackground)(mainThreadId, throttleMs, !!attach);
    const timers = [];
    const call = (op, value, index = 0, failed = false) => {
      const plan = owner.call(op, value, index, now(), failed);
      for (const effect of plan.effects) {
        switch (effect.kind) {
          case 'emit': emit(effect.event); break;
          case 'cancel': clearTimer(timers[effect.id]); delete timers[effect.id]; break;
          case 'timer':
            timers[effect.id] = setTimer(() => { delete timers[effect.id]; call('timer', null, effect.id); }, effect.delay);
            timers[effect.id]?.unref?.(); break;
          case 'attach':
            Promise.resolve().then(() => attach(effect.id))
              .then(result => call('attached', result, effect.agent))
              .catch(() => call('attached', null, effect.agent, true)); break;
        }
      }
      return plan.result;
    };
    return { consume: event => call('consume', event), activeCount: () => call('count', null),
      setMainThread: id => call('main', id), dispose: () => call('dispose', null) };
  },
};
module.exports = { addonPath, gatewayPath, getNative, record, status, runNative, nativeCode, deliveryClassForItem,
  staticVersionedHtml, decodeRecoveryEvents, taskShellContext, providerInvocation, createAutoProviderHandoff,
  createClaudeAdapter, codexAdapter, codexAppAdapter, codexBackground, codexProviderHome,
  claudeSettingsOverride };
