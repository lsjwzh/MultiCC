'use strict';

const path = require('node:path');
let sessionNotices;
function getSessionNotices() { return sessionNotices ??= getNative().sessionNoticesApi(getNative()); }
let networkPolicy;
function getNetworkPolicy() {
  // V8 owns async-function Promise adoption; Rust owns selection and probes.
  return networkPolicy ??= getNative().networkPolicyApi(getNative(), process,
    invoke => async function selectListenPort(policy, finder = undefined) { return invoke(policy, finder); });
}
let sessionDto;
function getSessionDto() {
  return sessionDto ??= getNative().sessionDtoApi(getNative(), value => require('../providers/auto-provider-config').providerSelectionDto(value));
}
let apiContract;
function getApiContract() {
  return apiContract ??= getNative().apiContractApi(getNative(), value => getSessionDto().assertDtoSafe(value));
}
let publicSafety;
function getPublicSafety() { return publicSafety ??= getNative().publicSafetyApi(getNative()); }
let loadedPath = null;
let loaded = null;
let loadError = null;
let deliveryOwner = null;
let deliveryAddon = null;
let cliRegistryOwner = null;
let cliRegistryAddon = null;
let sessionDeliveryAddon = null;
let sessionDeliveryApi = null;
// The bootstrap owns this per-host callback; Rust reads it at each projection.
let auxHealthProvider = null;
function installAuxHealthProvider(fn) { auxHealthProvider = typeof fn === 'function' ? fn : null; }
function auxVerdictStaleness() { return getNative().auxVerdictStaleness(auxHealthProvider); }
// Measure with V8: toJSON, property access and the live replay array belong
// to this host. Only a page that Rust chooses to clip crosses as JSON.
function messageBytes(message) {
  try { return Buffer.byteLength(JSON.stringify(message)); } catch { return 0; }
}
function fitHistoryFrame(messages, hasMore, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const sizes = list.map(messageBytes);
  const max = options && options.maxBytes !== undefined ? options.maxBytes : undefined;
  return getNative().chatFitHistoryFrame(list, sizes, !!hasMore, max, options);
}
const historyFrame = {
  get DEFAULT_MAX_BYTES() { return getNative().CHAT_HISTORY_MAX_BYTES; },
  get DEFAULT_TOOL_STRING_CHARS() { return getNative().CHAT_HISTORY_TOOL_STRING_CHARS; },
  messageBytes, fitHistoryFrame,
};
function taskStateFrame(task, seedOnly) {
  return getNative().chatTaskStateFrame(task, seedOnly, require('./task-domain').taskShortCode, auxVerdictStaleness);
}
const taskStateSeed = task => taskStateFrame(task, true);
const taskStatePayload = task => taskStateFrame(task, false);
function fanOutAuxVerdictStaleness({ sessions, getTaskState, chatBroadcast, workspaceBroadcast }) {
  return getNative().fanOutAuxVerdictStaleness(auxHealthProvider, sessions, getTaskState, chatBroadcast, workspaceBroadcast);
}

let hostPrompts;
function getHostPrompts() {
  if (hostPrompts) return hostPrompts;
  const native = getNative(), plan = new native.RustPlanPromptState();
  const lines = Object.freeze(JSON.parse(native.sessionQuestionRequest('prompt', 'null')));
  function buildCodexUserInputConstraint(enabled = true) { return native.hostCodexConstraint(!!enabled); }
  function buildSubagentProviderHint(subagent) { return native.hostSubagentHint(subagent); }
  function buildHumanAssistPrompt(root) { return native.hostHumanAssist(root); }
  function markPlanContextReset(name) { plan.mark(name); }
  function buildPlanProgressPrompt(_persisted, name, opts) { return plan.progress(name, opts); }
  function createHostPrompts(env = process.env, { assistRoot } = {}) {
    return native.hostPromptBundle(env, assistRoot, lines);
  }
  hostPrompts = { USER_INPUT_SIGNAL_PROMPT: lines, buildCodexUserInputConstraint, buildSubagentProviderHint,
    buildHumanAssistPrompt, markPlanContextReset, buildPlanProgressPrompt, createHostPrompts };
  return hostPrompts;
}

let taskRelations;
function getTaskRelations() {
  if (taskRelations) return taskRelations;
  const native = getNative(), kinds = Object.freeze(native.taskRelationKinds());
  function createTaskRelations({ store, taskTitle, onChanged, now = Date.now }) {
    const ports = { store, taskTitle, onChanged, now };
    const project = row => native.taskRelationPublicTitle(row, taskTitle);
    return {
      list: shell => native.taskRelationList(store, shell, project),
      create: (shell, input = {}) => native.taskRelationChange(ports, shell, input, false),
      remove: (shell, input = {}) => native.taskRelationChange(ports, shell, input, true),
      KINDS: kinds,
    };
  }
  taskRelations = { createTaskRelations, RELATION_KINDS: kinds };
  return taskRelations;
}

let notificationWords;
function getPushNotificationCopy() {
  if (notificationWords) return notificationWords;
  const native = getNative();
  const tables = native.pushNotificationTables();
  notificationWords = {
    COPY: tables.COPY, KEY_OF: tables.KEY_OF,
    copyKeyFor: spec => native.pushNotificationKey(spec, tables.KEY_OF),
    notificationCopy: (spec, locale, goalState) => native.pushNotificationCopy(spec, locale, goalState, tables),
  };
  return notificationWords;
}

let quotaBarView;
function getQuotaBarView() { return quotaBarView ||= getNative().quotaBarViewApi(); }
// Use the JS arithmetic operator for timestamps supplied by host extensions.
const elapsedTime = (now, since) => now - since;
function providerLimitSnapshot(entry, now = Date.now()) {
  const { STALE_MS_DEFAULT } = require('../quota/provider-limit-cache-native-host');
  return getNative().providerLimitSnapshot(entry, now, STALE_MS_DEFAULT, elapsedTime);
}
function connectProviderLimitSync({ cache, persistedSessions, providers, broadcast }) {
  const native = getNative();
  const { STALE_MS_DEFAULT } = require('../quota/provider-limit-cache-native-host');
  return cache.subscribe(entry => native.broadcastProviderLimit(entry, Date.now(), STALE_MS_DEFAULT,
    elapsedTime, persistedSessions, providers, broadcast, native.providerLimitCandidateMatches));
}

let eventPolicy;
function getEventPolicy() {
  if (eventPolicy) return eventPolicy;
  const native = getNative();
  const tables = JSON.parse(native.eventsCatalog());
  const os = require('node:os');
  const call = (op, a, b, port) => native.eventHostRequest(op, a, b, port);
  eventPolicy = {
    catalog: {
      TASK_EVENTS: Object.freeze(tables.taskEvents), TURN_EVENTS: Object.freeze(tables.turnEvents),
      EVENT_TYPES: Object.freeze(tables.eventTypes), ALIASES: Object.freeze(tables.aliases),
      isKnownPattern: pattern => call('isKnownPattern', pattern),
      matchesPattern: (pattern, type) => call('matchesPattern', pattern, type),
      matchesAny: (patterns, type) => call('matchesAny', patterns, type, native.eventPatternString),
    },
    rules: {
      ACTION_KINDS: Object.freeze(tables.actionKinds), MIN_INJECT_COOLDOWN_MS: tables.minInjectCooldownMs,
      MAX_CHAIN_STEPS: tables.maxChainSteps,
      validateEventRule: (body = {}, { idFactory, nowIso, scope = 'global' } = {}) =>
        call('validateEventRule', body, { idFactory, nowIso, scope }),
      validateAction: raw => call('validateAction', raw),
      validateWebhookUrl: raw => call('validateWebhookUrl', raw),
      matchesFilter: (rule, event) => call('matchesFilter', rule, event),
      channelActions: rule => call('channelActions', rule),
      channelProblem: (rule, check) => call('channelProblem', rule, check),
    },
    envelope: {
      CONCLUSION_MAX: tables.conclusionMax, SUMMARY_MAX: tables.summaryMax,
      CONCLUSION_EVENTS: Object.freeze(new Set(tables.conclusionEvents)),
      redactText: text => call('redactText', text, undefined, os),
      clipText: (text, max) => call('clipText', text, max, os),
      summaryOf: state => call('summaryOf', state, tables.summaryMax, os),
      renderInjection: (event, instruction) => call('renderInjection', event, instruction),
    },
    transitions: {
      LETTER_EVENT: Object.freeze(tables.letterEvent), GOAL_EVENT: Object.freeze(tables.goalEvent),
      deriveTaskEvents: (prev, next) => call('deriveTaskEvents', prev, next),
      segmentKey: state => call('segmentKey', state),
      letterOf: state => call('letterOf', state), goalOf: state => call('goalOf', state),
    },
  };
  return eventPolicy;
}

const counts = { search: 0, usage: 0 };
// Compatibility value for Node modules that must load before the addon; the
// native delivery API is the policy owner and preflight verifies this marker.
const SESSION_DELIVERY_SYSTEM_PREFIX = '🔇';

// V8 strict property assignment port: preserves Proxy/setter and TypeError
// semantics while native session configuration owns all policy and ordering.
function assignHostProperty(target, key, value) { target[key] = value; }
// The provider detach port consumes a callback; keep that callback as a thin
// host adapter until the provider host and its callback move into Rust.
function pendingDesiredSession(session) { return getNative().sessionPendingDesiredSession(session, assignHostProperty); }


function prepareManagedContext({ host, memory, sessionName, persisted, turn, opts, text, isFirstTurn }) {
  const native = getNative();
  const state = native.managedContextPrepare({ host, memory, sessionName, turn, opts, text, isFirstTurn }, assignHostProperty);
  if (!state) return null;
  return {
    seed: state.seed,
    rolePrompt: record => native.managedContextRole(memory, record),
    attempt(envelope, options) { return native.managedContextAttempt(state, envelope, options); },
  };
}
function contextSent(turn) { getNative().managedContextSent(turn); }
function contextCompleted(context, resolved) { getNative().managedContextCompleted(context, resolved); }
const managedContext = { prepareManagedContext, contextSent, contextCompleted };

// Native prompt policies retain live callback, getter and opaque value identity.
const messageComposer = {
  composeMessage: input => getNative().messageCompose(input, process.env, console),
  renderPrompt: envelope => getNative().messageRenderPrompt(envelope),
  validateEnvelope: envelope => getNative().messageValidateEnvelope(envelope, process.env, console),
  buildAutoCommitStatusPrompt: persisted => getNative().messageAutoCommitPrompt(persisted),
  normalizeVoiceInput: source => getNative().messageNormalizeVoice(source),
  buildVoiceInputPrompt: (voice, text) => getNative().messageVoicePrompt(voice, text),
};

// Keep the exported mutable hook set shared by the spool reader and its callers.
const turnLedgerContracts = new WeakMap();
function getTurnLedgerContract() {
  const addon = getNative();
  if (!turnLedgerContracts.has(addon)) {
    const catalog = JSON.parse(addon.turnLedgerVocabulary());
    const events = new Set(catalog.hookEvents);
    turnLedgerContracts.set(addon, {
      HOOK_EVENTS: events,
      OWNERSHIP: Object.freeze(catalog.ownership),
      E_REASONS: Object.freeze(catalog.errorReasons),
      SILENT_E_REASONS: new Set(catalog.silentErrorReasons),
      normalizeEnvelope: raw => addon.turnLedgerNormalize(raw, events),
      transitionId: ({ sessionId, epoch, turnId, seq, state }) =>
        addon.turnLedgerTransitionId(sessionId, epoch, turnId, seq, state),
      projectLiveness: ownership => addon.turnLedgerLiveness(ownership),
    });
  }
  return turnLedgerContracts.get(addon);
}

// Empty searches finish before addon loading. V8 map preserves holes, species,
// and getter timing while Rust projects candidates and selects original hits.
function rerankSearchHits(hits, { limit = 20, perRefQuota = 3, dedupeContentHash = true } = {}) {
  if (!Array.isArray(hits) || !hits.length) return [];
  const wanted = Math.max(0, Math.min(hits.length, Math.floor(Number(limit)) || 0));
  if (!wanted) return [];
  const native = getNative();
  const candidates = hits.map(hit => native.searchDiversityCandidate(hit));
  return native.searchDiversityPick(hits, candidates, wanted, perRefQuota, dedupeContentHash);
}

// 两个搜索入口在首次处理文本时加载同一原生分词器。
const searchTokenizer = {
  tokenize: text => getNative().searchTokenize(text),
  boardQueryTerms: text => getNative().searchBoardQueryTerms(text),
  normalizeText: text => getNative().searchNormalizeText(text),
  indexTokens: text => getNative().searchIndexTokens(text),
  matchGroups: text => getNative().searchMatchGroups(text),
  matchExpression: text => getNative().searchMatchExpression(text),
  get MAX_PHRASE_BIGRAMS() { return getNative().SEARCH_MAX_PHRASE_BIGRAMS; },
  get MAX_MATCH_TERMS() { return getNative().SEARCH_MAX_MATCH_TERMS; },
};

// Startup decisions remain native; these forward existing synchronous host ports.
const stateBootstrap = {
  isNewSchema: records => getNative().stateIsNewSchema(records),
  hasMigratableOldSessions: records => getNative().stateHasMigratableOldSessions(records),
  migrateOldSchema: (records, options) => getNative().stateMigrateOldSchema(records, options, require('node:crypto')),
  bootstrapState: options => getNative().stateBootstrap(options, require('node:fs'), require('node:crypto')),
};
const bootstrapState = stateBootstrap.bootstrapState;

// Native ancestry policy over the existing synchronous platform ports.
const pathSafety = {
  realPathOf: value => getNative().pathSafetyRealPath(value, require('node:fs'), path),
  isHomeOrAbove: value => getNative().pathSafetyHomeOrAbove(value, require('node:fs'), path, require('node:os')),
};

function findProviderReferences(input = {}) {
  return getNative().providerFindReferences(input);
}

function gatewayPath() {
  return path.join(path.dirname(addonPath()), process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
}
let monitorAdmission;
function getMonitorAdmission() {
  if (monitorAdmission) return monitorAdmission;
  const addon = getNative();
  const hasFrame = (prompt, open, close) => prompt.startsWith(open) && prompt.includes(close);
  const copy = event => ({ ...event });
  const includesReason = (event, reason) => event.result.includes(reason);
  monitorAdmission = {
    CALLBACK_ID: addon.MONITOR_CALLBACK_ID,
    isMonitorHandoffResult: event => addon.monitorHandoffResult(event, includesReason),
    createMonitorAdmission(deliver, isOwnPrompt = () => false) {
      const owns = prompt => isOwnPrompt(prompt);
      return async input => {
        const events = addon.monitorAdmissionEvents(input, owns, hasFrame);
        if (!events) return {};
        let reply;
        for (let index = 0; ; index++) {
          const step = addon.monitorDeliveryStep(events, index, reply, copy);
          if (Object.hasOwn(step, 'outcome')) return step.outcome;
          reply = await deliver(step.event);
        }
      };
    },
  };
  return monitorAdmission;
}
const resolveOpenCodeModelLimit = (catalog, id) => getNative().openCodeModelLimit(catalog, id);
const catalogJsonParse = JSON.parse;
const catalogValues = Object.values;
const catalogIterator = Array.prototype[Symbol.iterator];
const catalogMin = Math.min;
const jsonPrototypes = [Object.prototype, Array.prototype, String.prototype, Number.prototype, Boolean.prototype];
// Private JSON has no accessors of its own. Inherited fields and customized
// enumeration or arithmetic still need the live V8 path on every lookup.
function plainCatalogFields(id) {
  return Object.values === catalogValues && Array.prototype[Symbol.iterator] === catalogIterator &&
    Math.min === catalogMin && !(id in Object.prototype) && !(id in Array.prototype) &&
    jsonPrototypes.every(p => !('models' in p || 'limit' in p || 'context' in p || 'output' in p));
}
function createOpencodeModelLimitResolver(deps = {}) {
  const fs = deps.fsImpl || require('node:fs');
  const cachePath = deps.cachePath ? () => deps.cachePath :
    () => path.join(process.env.HOME || require('node:os').homedir(), '.cache', 'opencode', 'models.json');
  const state = { snapshot: undefined, mtime: -1 };
  function read(file) {
    try {
      const parse = JSON.parse;
      const catalog = parse.call(JSON, fs.readFileSync(file, 'utf8'));
      return { catalog, memo: parse === catalogJsonParse ? new Map() : null };
    } catch { return undefined; }
  }
  return Object.freeze({
    resolve(id) {
      const file = cachePath();
      let stat;
      try { stat = fs.statSync(file); } catch { return resolveOpenCodeModelLimit(null, id); }
      return { ...getNative().openCodeCachedModelLimit(state, stat.mtimeMs, file, read, id, plainCatalogFields) };
    },
    resolveLimit(id) {
      const { context, output } = this.resolve(id);
      return Object.freeze({ context, output });
    },
    resetCache() { state.snapshot = undefined; state.mtime = -1; },
  });
}
let fallbackModelLimit;
const openCodeModelLimits = {
  createOpencodeModelLimitResolver, resolveOpenCodeModelLimit,
  get FALLBACK_LIMIT() {
    if (!fallbackModelLimit) {
      const { context, output } = resolveOpenCodeModelLimit(null, '');
      fallbackModelLimit = Object.freeze({ context, output });
    }
    return fallbackModelLimit;
  },
};

let nativeOpenCodeCatalog;
function getNativeOpenCodeCatalog() {
  if (nativeOpenCodeCatalog) return nativeOpenCodeCatalog;
  const addon = getNative();
  const { prefix, pattern, names } = addon.openCodeCatalogSpec();
  // V8 owns species-aware map/filter, iterable spread and the default hint of +.
  const ports = {
    mapModels: models => (Array.isArray(models) ? models : [])
      .map(model => String(model ?? '').trim()).filter(Boolean),
    spread: values => [...values],
    add: (left, right) => left + right,
  };
  nativeOpenCodeCatalog = {
    NATIVE_OPENCODE_ID: new RegExp(pattern, 'i'),
    NATIVE_OPENCODE_PREFIX: prefix,
    nativeOpenCodeId: value => addon.openCodeCatalogId(String(value ?? '')),
    nativeOpenCodeName: id => addon.openCodeCatalogName(id, names),
    syntheticNativeOpenCodeProvider: (id, modelOptions = []) => addon.openCodeCatalogEntry(id, modelOptions, names, ports),
  };
  return nativeOpenCodeCatalog;
}
const voiceSpeech = {
  stripTruncatedLegacyMarker: raw => getNative().voiceSpeechText(String(raw || ''), undefined),
  sanitizeVoiceSpeech(raw, { privateValues = [] } = {}) {
    const text = String(raw || '');
    const values = [];
    for (const value of privateValues) values.push(String(value || ''));
    return getNative().voiceSpeechText(text, values);
  },
};
let migrationProgress;
function getTaskStoreMigrationProgress() {
  if (migrationProgress) return migrationProgress;
  const addon = getNative();
  const steps = addon.taskStoreProgressSteps();
  return migrationProgress = { STEPS: steps, describeMigration(state, { now = Date.now(), statSize = () => 0, failure = null } = {}) {
    return addon.describeTaskStoreMigration(state, now, statSize, failure, steps);
  } };
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
// Preserve the CommonJS module's single live kind Set for all host callers.
function getSessionDeliveryApi() {
  const addon = getNative();
  if (sessionDeliveryAddon !== addon) {
    sessionDeliveryApi = addon.sessionDeliveryApi();
    sessionDeliveryAddon = addon;
  }
  return sessionDeliveryApi;
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
const opencodeProcessError = (cli, raw, stderr) =>
  getNative().opencodeProcessError(cli, raw, stderr, require('../provider-error').classifyProviderError);
function resolveCliRelayTarget(providers, cliName, providerId) {
  return getNative().resolveCliRelayTarget(providers, cliName, providerId);
}
function applyCliRelaySpawn({ target, childEnv, cwd, persisted, prepared, gatewayBin,
  rememberActiveCliState, savePersistedSessionsBestEffort }) {
  const { invocation, invocationEnvelope } = prepared;
  return getNative().applyCliRelaySpawn({ target, childEnv, cwd, persisted, invocation, invocationEnvelope,
    gatewayBin, rememberActiveCliState, savePersistedSessionsBestEffort, assignHostProperty });
}

const processSpawnArgs = (invocation, settings = null) => getNative().processSpawnArgs(invocation, settings);
const isZcodeSessionId = value => getNative().isZcodeSessionId(value);
const repairZcodeSessionState = session => getNative().repairZcodeSessionState(session);
const resolveModelRequestPolicy = (session = {}, env = process.env) => getNative().resolveModelRequestPolicy(session, env);
const createModelStreamProgress = () => getNative().createModelStreamProgress();
function createModelDefaultResolver({ history, now, historyTtlMs }) {
  const owner = new (getNative().RustModelDefaults)(historyTtlMs);
  return request => owner.resolve(request, history, now);
}
function claudeQuota(op, input) {
  try {
    return JSON.parse(getNative().cprClaudeQuota(JSON.stringify({ ...input, op })));
  } catch (_) { return undefined; } // Quota observations must never break a stream.
}
function subscriptionFromBody(body, { source = 'account', observedAt = Date.now() } = {}) {
  return JSON.parse(getNative().parseAccountSubscription(JSON.stringify({ body, source, observedAt })));
}

function codexAuthSubscription(auth) {
  return require('../native/runtime').providerCredentials.credential({ operation: 'codexSubscription', auth });
}
function credential(input) {
  return JSON.parse(getNative().providerCredential(JSON.stringify(input)));
}
async function readCli(input) {
  return JSON.parse(await getNative().readProviderCliCredential(JSON.stringify(input)));
}
const providerCredentials = { credential, readCli };
function readCodexAuth(file) {
  return providerCredentials.credential({ operation: 'codexAuth',
    file: file || path.join(require('node:os').homedir(), '.codex', 'auth.json') });
}
function requestCodexUsage(auth, { fetch = require('../network/outbound').outboundFetch, signal } = {}) {
  return getNative().requestCodexUsage(auth, fetch, signal);
}
const taskShellCapacity = {
  get MAX_TASKS_PER_DIRECTORY() { return getNative().taskDirectoryCapacityLimit(); },
  directoryTaskCount: (store, dirId) => getNative().taskDirectoryCapacity(store, dirId, false, require('./task-domain').taskDomain),
  directoryAtCapacity: (store, dirId) => getNative().taskDirectoryCapacity(store, dirId, true, require('./task-domain').taskDomain),
};
function createCliProviderRegistry(adapters, fallbackName = 'claude') {
  const addon = getNative();
  if (cliRegistryAddon !== addon) {
    cliRegistryOwner = new addon.RustCliProviderRegistryFactory();
    cliRegistryAddon = addon;
  }
  const owner = cliRegistryOwner;
  const state = owner.create(adapters, fallbackName);
  return { providers: state.providers, get(cli) { return owner.resolve(state, cli); } };
}
const zcodeEngine = {
  get DEFAULT_ZCODE_ENGINE() { return getNative().zcodeDefaultEngine(); },
  zcodeEngineCandidates: (options = {}) => getNative().zcodeEngineCandidates(options, path),
  zcodeBuiltinProviderConfig: engine => getNative().zcodeBuiltinProviderConfig(engine, path),
  zcodeEngineEnv: (engine, env = process.env) => getNative().zcodeEngineEnv(engine, env, path),
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
function decodeRecoveryEvents(raw) { return getNative().decodeSchedulerRecoveryEvents(raw); }
const reference = (op, value) => JSON.parse(getNative().taskShellReference(op, JSON.stringify(value)));
// The task runtime uses its V8 locale and comparator for stable candidate
// order. Pass the selected values to Rust with their JS exception identity.
let selectionApi;
function getContextSelection() {
  if (selectionApi) return selectionApi;
  const native = getNative();
  const typePrefix = 'context_selection_type_error: ';
  function invoke(op, ...args) {
    try { return native.contextSelectionValue(op, ...args); }
    catch (error) {
      if (typeof error?.message === 'string' && error.message.startsWith(typePrefix)) {
        throw new TypeError(error.message.slice(typePrefix.length));
      }
      throw error;
    }
  }
  selectionApi = {
    terms: value => invoke('terms', value),
    relevance: (query, text) => invoke('relevance', query, text),
    minRelevance: query => invoke('minRelevance', query),
    clipTokens: (text, budget) => invoke('clipTokens', text, budget),
    selectContext(candidates, options = {}) {
      const { budget, header, footer } = options;
      const ordered = [...candidates].sort((left, right) => (right.priority || 0) - (left.priority || 0)
        || String(left.id).localeCompare(String(right.id)));
      return invoke('selectContext', ordered, budget, header, footer);
    },
  };
  return selectionApi;
}
function settleAdapterCompletion(runner, boundary, logger) {
  return getNative().cliSettleAdapterCompletion(runner, boundary, logger, assignHostProperty);
}
function finalizeCompletionStream(promise, { runner, finalize, onRejected, onFinalizeError, logger }) {
  const native = getNative();
  const ports = { runner, finalize, onRejected, onFinalizeError, logger, assignHostProperty };
  return promise.then(
    () => native.cliSettleCompletionStream(ports, false, undefined),
    error => native.cliSettleCompletionStream(ports, true, error),
  ).catch(error => native.cliFailCompletionStream(ports, error));
}
function canPersistAdapterCompletion(outcome, proxyFailure, errorEnvelope) {
  return getNative().cliCanPersistCompletion(outcome, proxyFailure, errorEnvelope);
}
function isProxyFailureCompatibleWithCompletion(proxyFailure, outcome) {
  return getNative().cliProxyFailureCompatible(proxyFailure, outcome);
}
const adapterCompletion = { settleAdapterCompletion, canPersistAdapterCompletion,
  finalizeCompletionStream, isProxyFailureCompatibleWithCompletion };

function routePostTurn(input = {}) { return getNative().chatRoutePostTurn(input); }
function createDeliveryProof(input = {}) { return getNative().chatCreateDeliveryProof(input); }
function acknowledgeDeliveredEffect(effect, proof) { return getNative().chatAcknowledgeDeliveredEffect(effect, proof); }
const postTurnRouter = { routePostTurn, createDeliveryProof, acknowledgeDeliveredEffect };

const finalizationPlan = {
  classifyProcessExit: (input = {}) => getNative().chatClassifyProcessExit(input),
  normalizeHandoff: (input = {}) => getNative().chatFrozenFinalization('handoff', input),
  isGuardedHandoffFailure: (facts, handoff) => getNative().chatIsGuardedHandoffFailure(facts, handoff),
  replaySafeHandoffProviderError: input => getNative().chatReplaySafeHandoffProviderError(input),
  planTurnFinalization: (input = {}, deps = {}) => getNative().chatFrozenFinalization('plan', input, deps),
  planRetryBlockedFinalization: (plan, overrides = {}) => getNative().chatFrozenFinalization('retryBlocked', plan, overrides),
  resolveTurnFinalization: (plan, outcome = {}) => getNative().chatFrozenFinalization('resolve', plan, outcome),
};
// Artifact reference recognition is Rust-only. Each member resolves the addon
// lazily, so a module that merely loads this facade (src/artifacts.js in a bare
// child process) needs no native module until it recognizes an id.
const artifactReference = {
  isArtifactId: value => getNative().artifactReferenceIsArtifactId(value),
  normalizeRelativePath: value => getNative().artifactReferenceNormalizeRelativePath(value),
  extractArtifactReferences: content => getNative().artifactReferenceExtract(content),
};
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
      policy: resolveModelRequestPolicy,
      proof: require('../chat/turn-request').createProviderRouteProof,
      nativeOpenCodeId: getNativeOpenCodeCatalog().nativeOpenCodeId,
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
    renderPrompt: messageComposer.renderPrompt,
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
      renderPrompt: messageComposer.renderPrompt,
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
      renderPrompt: messageComposer.renderPrompt,
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
// Session persistence adapter (former src/session/persistence.js). The native
// record owner stays the single writer; the host only supplies the facade's
// owner lookup, which the factory calls after its own Map check.
function jsonClone(value) {
  return getNative().sessionPersistenceJsonClone(value);
}
// `arguments[0]` keeps the legacy zero-length signature and the `= {}` default.
function createSessionPersistence() {
  return getNative().sessionPersistenceCreate(require('../session/records').sessionRecordsOwner, arguments[0]);
}
function quickCommitMessage(porcelain) {
  let addon;
  try { addon = getNative(); } catch {}
  if (typeof addon?.quickCommitMessageValue !== 'function') {
    throw new Error('提交说明生成模块不可用，请构建当前版本的 Rust 模块后重试');
  }
  return addon.quickCommitMessageValue(porcelain);
}

function saveDirectoryOwner(owner) {
  try { owner.saveDirectories(); }
  catch (error) {
    console.error('[multicc] Failed to save directories.json:', error.message);
    throw error;
  }
}
function createFsDirectoryRepository({ file, map, realPathOf, owner }) {
  return getNative().directoryRepository({ file, map, realPathOf, owner }, saveDirectoryOwner);
}
function providerStoreAccess(file, request) {
  try { return JSON.parse(getNative().providerStore(file, JSON.stringify(request))); }
  catch (error) { error.code = error.message; throw error; }
}
function createNativeProviderStore(file) {
  return getNative().providerRepository(file, providerStoreAccess);
}

let turnEventReplay;
function getTurnEventReplay() { return turnEventReplay ||= getNative().turnEventReplayApi(); }

// Let V8 apply the original addition operator and conversion hints to host IDs.
const candidateKeyInput = (receiptId, attribution) => receiptId + '\0' + attribution.turnId;
function createCandidateStore(store) {
  const native = getNative();
  return {
    propose(sessionId, receiptId, attribution) {
      return native.taskCandidatePropose(store, sessionId, receiptId, attribution, candidateKeyInput);
    },
    latest(taskId) { return native.taskCandidateLatest(store, taskId); },
  };
}

async function syncWorktreeOnWake(dirPath, worktree, baseBranch) {
  try {
    const native = getNative();
    if (typeof native.wakeSyncRequest !== 'function') return { ok: false, code: 'wake_sync_unavailable' };
    return JSON.parse(await native.wakeSyncRequest(dirPath, worktree, baseBranch));
  } catch { return { ok: false, code: 'wake_sync_failed' }; }
}
async function prepareCliSwitchRoute(input) {
  return JSON.parse(await getNative().prepareHostSwitchRoute(input, require('node:os').homedir()));
}
async function synchronizeCodexProfileRoute(route) {
  try { return await prepareCliSwitchRoute({ ...route, cli: 'codex' }); }
  catch (error) {
    const cause = nativeCode(error);
    let native;
    try { native = getNative(); } catch { throw cause; }
    throw native.codexProfileRouteFailure(cause);
  }
}

let turnState;
function getTurnState() {
  if (turnState) return turnState;
  const native = getNative();
  turnState = {
    ABNORMAL_BOUNDARIES: new Set(JSON.parse(native.turnStateCatalog()).abnormalBoundaries),
    resolveTurnState(input = {}) { return native.resolveTurnStateValue(input); },
  };
  return turnState;
}

let transcriptPruning;
function getTranscriptPruning() {
  const native = getNative();
  return transcriptPruning ||= native.transcriptPruningApi(native, () => require('node:os').homedir());
}

let warnedExpiredRefresh = false;
function planClaudeExpiredRefresh(input, logger) {
  try { return getNative().claudeRefreshDecision(JSON.stringify(input)); }
  catch {
    if (!warnedExpiredRefresh) {
      warnedExpiredRefresh = true;
      logger?.warn?.('claude_expired_refresh_policy_unavailable', {
        action: 'build the current Rust addon; Claude CLI probes stay disabled until it is available',
      });
    }
    return null;
  }
}

const promiseThen = Promise.prototype.then;
function invokeNativeCommand(name, draft, args, snapshot = draft) {
  const native = module.exports.getNative();
  const result = native.orchestrationCommand(native, name, draft, args, snapshot);
  if (require('node:util').types.isPromise(result)) {
    Reflect.apply(promiseThen, result, [undefined, () => {}]);
    throw new TypeError('synchronous Rust orchestration command returned a promise');
  }
  return result;
}
function commandEnvelope(value) {
  return Object.defineProperty(Object.create(null), 'value', { value, enumerable: true });
}

module.exports = { getSessionNotices, getNetworkPolicy, getSessionDto, getApiContract, getPublicSafety, getTranscriptPruning, planClaudeExpiredRefresh, invokeNativeCommand, commandEnvelope, getTurnEventReplay, createCandidateStore, syncWorktreeOnWake, prepareCliSwitchRoute, synchronizeCodexProfileRoute,
  getTurnState, quickCommitMessage, createFsDirectoryRepository, createNativeProviderStore, getHostPrompts, getTaskRelations, openCodeModelLimits, getMonitorAdmission, getNativeOpenCodeCatalog, voiceSpeech, getTaskStoreMigrationProgress, getEventPolicy, getQuotaBarView, providerLimitSnapshot, connectProviderLimitSync, getPushNotificationCopy, getTurnLedgerContract, rerankSearchHits, searchTokenizer, addonPath, gatewayPath, getNative, getSessionDeliveryApi, SESSION_DELIVERY_SYSTEM_PREFIX, assignHostProperty, pendingDesiredSession, findProviderReferences, record, status, runNative, nativeCode, deliveryClassForItem,
  historyFrame, installAuxHealthProvider, auxVerdictStaleness, fanOutAuxVerdictStaleness, taskStateSeed, taskStatePayload,
  adapterCompletion, postTurnRouter, finalizationPlan, artifactReference, getContextSelection, decodeRecoveryEvents, taskShellContext, providerInvocation, createAutoProviderHandoff,
  createClaudeAdapter, codexAdapter, codexAppAdapter, codexBackground, codexProviderHome,
  claudeSettingsOverride, opencodeProcessError, processSpawnArgs, resolveCliRelayTarget, applyCliRelaySpawn, isZcodeSessionId, repairZcodeSessionState,
  pathSafety, stateBootstrap, bootstrapState, messageComposer, managedContext, resolveModelRequestPolicy, createModelStreamProgress, zcodeEngine, createCliProviderRegistry, taskShellCapacity, providerCredentials, readCodexAuth, requestCodexUsage, createModelDefaultResolver, claudeQuota, subscriptionFromBody, codexAuthSubscription, createSessionPersistence, jsonClone };
// The stable PersistenceError class is created natively once per environment.
Object.defineProperty(module.exports, 'PersistenceError', {
  enumerable: true,
  get: () => getNative().sessionPersistenceErrorClass(),
});
