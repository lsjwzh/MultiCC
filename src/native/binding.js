'use strict';

// CommonJS binding for the Node compatibility host. The loader stays available
// before a platform addon can be opened (including bootstrap and diagnostics).

const path = require('node:path');
let turnProgress;
function getTurnProgress() {
  const addon = getNative();
  return turnProgress ??= addon.turnProgressApi(addon);
}
let writerGroup;
function getWriterGroup() { return writerGroup ??= getNative().writerGroupApi(); }
let vendorLogin;
function getVendorLogin() { return vendorLogin ??= getNative().vendorLoginApi(); }
let monitorControl;
function getMonitorControl() { return monitorControl ??= getNative().monitorControlApi(require('node:crypto').randomUUID); }
let processCloser;
// V8 supplies the public async function and adopts the native result or exception.
function wrapProcessWait(waitForExit) {
  return async function wait(name, stop, options = undefined) { return waitForExit(name, stop, options); };
}
function getProcessCloser() { return processCloser ??= getNative().processCloserApi(wrapProcessWait); }
let autoProviderPricing;
function getAutoProviderPricing() { return autoProviderPricing ??= getNative().autoProviderPricingApi(); }
let autoProviderPolicy;
function getAutoProviderPolicy() { return autoProviderPolicy ??= getNative().autoProviderPolicyApi(getNative()); }
let retryPolicy;
function getRetryPolicy() { return retryPolicy ??= getNative().retryPolicyApi(module.exports.apiErrorPolicy.policyPorts); }
// The host adopts append's original thenable and preserves V8 coercion/exception identity.
function createErrorPersister({ appendChatMessage, now = Date.now, windowMs = 10000, logger = console }) {
  return getNative().chatErrorPersister({
    recent: new Map(), append: appendChatMessage, now: () => now(),
    expired: (at, previous) => at - previous > windowMs,
    message: payload => String(payload.error ?? ''), key: (sid, text) => `${sid}\n${text}`,
    id: (key, at) => `err-${require('node:crypto').createHash('sha1').update(`${key}\n${at}`).digest('hex').slice(0, 16)}`,
    observe(record, failed) {
      if (record && typeof record.then === 'function') {
        record.then(saved => { if (saved === false) failed(new Error('append rejected')); }, failed);
      } else if (record === false) failed(new Error('append rejected'));
    },
    warn(sessionId, error) {
      const message = error && error.message ? error.message : String(error);
      try { logger?.warn?.('chat_error_persist_failed', { sessionId, message }); } catch (_) {}
    },
  });
}
function createTaskFactsRepository(store) {
  const api = getNative().taskFactRepository({
    store, equal: require('node:util').isDeepStrictEqual, increment: n => n + 1,
  });
  function recordEvaluation(id, { expectedVersion, evaluation, eventId }) {
    return api.evaluate(id, expectedVersion, evaluation, eventId);
  }
  return Object.freeze({ appendFact: api.appendFact, createProposal: api.createProposal, recordEvaluation,
    pendingEvents: api.pendingEvents, acknowledge: api.acknowledge, getProposal: api.getProposal, getFact: api.getFact });
}

// Host functions retain Node's injectable clocks, filesystem and process APIs.
const MIB = 1024 * 1024;
const DEFAULT_RUNTIME_HOME_TTL_DAYS = 14;
const MAX_UNLOCK_PASSWORD_LENGTH = 2048;
const UPLOAD_LIMITS = Object.freeze({
  fileSize: 25 * MIB,
  files: 1,
  fields: 0,
  // Busboy emits partsLimit when the counter reaches the configured value;
  // use 2 so exactly one multipart part succeeds and a second is rejected.
  parts: 2,
  fieldNameSize: 64,
  headerPairs: 100,
  maxActive: 4,
  tempFiles: 200,
  tempBytes: 512 * MIB,
});

class UploadPolicyError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'UploadPolicyError';
    this.code = code;
    this.status = status;
  }
}

const uploadPorts = { ErrorType: UploadPolicyError, assign: assignHostProperty };
function createAdmissionGate(maxActive) {
  return getNative().voiceUploadWrapper(uploadPorts, active => active >= maxActive);
}
function createUploadSuite({ multerImpl = require('multer'), fileSize = UPLOAD_LIMITS.fileSize, maxActive = UPLOAD_LIMITS.maxActive } = {}) {
  return getNative().voiceUploadSuite(uploadPorts, multerImpl, fileSize, active => active >= maxActive);
}
function createRuntimeHomesJanitor({ homesRoot, fsImpl = require('node:fs'), now = Date.now,
  ttlDays = DEFAULT_RUNTIME_HOME_TTL_DAYS, log = console.log } = {}) {
  const root = String(homesRoot || path.join(require('node:os').homedir(), '.multicc'));
  return getNative().runtimeHomeSweeper({
    path, now: () => now(), log: message => log(message), join: path.join,
    stat: p => fsImpl.lstatSync(p), list: p => fsImpl.readdirSync(p),
    remove: p => fsImpl.rmSync(p, { recursive: true, force: true }),
    newer: (a, b) => a > b, recent: (a, b) => a >= b,
  }, root, ttlDays);
}
function startRuntimeHomesJanitor({ homesRoot, ttlDays, trackTimer, log }) {
  const sweep = createRuntimeHomesJanitor({ homesRoot, ttlDays, log });
  sweep();
  trackTimer(setInterval(sweep, 6 * 3600 * 1000));
  return sweep;
}

function createUnlockPassword({ platform = process.platform, execFileFn = require('node:child_process').execFile,
  account = process.env.USER || require('node:os').userInfo().username || 'root',
  agentAppPath = process.env.MULTICC_AGENT_APP || '/Applications/MultiCC Agent.app' } = {}) {
  const isAvailable = () => platform === 'darwin';
  async function execute(operation, password) {
    if (!isAvailable() && operation !== 'set') return operation === 'find' ? false : undefined;
    const native = getNative();
    const args = native.unlockKeychainPlan(operation, isAvailable(), account, agentAppPath, password,
      typeof password === 'string' ? password.length : 0);
    if (!args) return operation === 'find' ? false : undefined;
    const result = await new Promise(resolve => execFileFn('/usr/bin/security', args, { timeout: 8000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code, stdout: String(stdout || ''), stderr: String(stderr || '') });
    }));
    const error = native.unlockKeychainError(operation, result.ok, result.code === 44);
    if (error) throw new Error(error);
    if (operation === 'find') return result.ok;
  }
  return { isAvailable, hasPassword: () => execute('find'), setPassword: password => execute('set', password),
    clearPassword: () => execute('clear') };
}

function createUnlockProbe({ platform = process.platform, execFileFn = require('node:child_process').execFile,
  agentBin = process.env.MULTICC_AGENT_BIN || path.join(require('node:os').homedir(), '.multicc', 'bin', 'multicc-agent') } = {}) {
  const isAvailable = () => platform === 'darwin';
  const unavailable = () => ({ state: 'unavailable', detail: 'not-macos' });
  function invoke(method, ui, receive) {
    const { args, timeout } = getNative().unlockProbeCommand(method, ui);
    return new Promise(resolve => execFileFn(agentBin, args, { timeout }, (error, stdout) => resolve(receive(error, stdout))));
  }
  async function desktopPermissions() {
    if (!isAvailable()) return unavailable();
    return invoke('status', false, (error, stdout) => {
      let data;
      try { data = JSON.parse(String(stdout)); } catch {}
      return getNative().unlockDesktopReply(data, error);
    });
  }
  async function probe({ allowUI = false } = {}) {
    if (!isAvailable()) return unavailable();
    const desktop = await desktopPermissions();
    if (desktop.state !== 'authorized') return desktop;
    const reply = await invoke('probe', allowUI, (error, stdout) => ({ error, stdout: String(stdout || '') }));
    let data = null;
    try { data = JSON.parse(reply.stdout.trim()); } catch {}
    return getNative().unlockProbeReply(data, reply.error);
  }
  async function runtimeReady() {
    if (!isAvailable()) return false;
    return invoke('ping', false, (error, stdout) => {
      try { return !error && JSON.parse(String(stdout)).powerProtocol === 1; } catch { return false; }
    });
  }
  return { isAvailable, probe, runtimeReady, desktopPermissions };
}

function createWorktreeOrphanScanner(deps = {}) {
  const {
    records, directories, repoActor, logger = console, now = Date.now, deleteOrphans = false,
    setTimeoutFn = setTimeout, setIntervalFn = setInterval, startupDelayMs = 45000,
    intervalMs = 86400000, listTaskWorktreePaths = () => [],
  } = deps;
  const native = getNative();
  function canon(value) {
    try { return require('node:fs').realpathSync(value); } catch { return path.normalize(value); }
  }

  async function scanDirectory(dir, claimed) {
    const root = path.join(canon(dir.path), '.multicc-worktrees');
    return repoActor.run(dir.path, 'worktree-orphan-scan', async ({ execGit }) => {
      const out = await execGit(dir.path, ['worktree', 'list', '--porcelain']);
      const rows = [];
      for (const entry of native.parseOrphanWorktrees(String(out || ''))) {
        if (!native.orphanCandidates(entry, root + path.sep, claimed, canon)) continue;
        const ahead = Number(await execGit(entry.path, ['rev-list', '--count', `${dir.baseBranch || 'main'}..HEAD`]).catch(() => '0')) || 0;
        const dirty = !!(await execGit(entry.path, ['status', '--porcelain']).catch(() => ''));
        rows.push({ dirId: dir.id, path: entry.path, branch: entry.branch, ahead, dirty, removed: false });
      }
      return rows;
    });
  }

  async function collect(claimed, finish) {
    const orphans = [];
    for (const dir of directories.values()) {
      if (!dir?.path) continue;
      try { orphans.push(...await scanDirectory(dir, claimed)); }
      catch (error) { logger.warn?.('worktree_orphan_scan_failed', { dirId: dir.id, code: error?.code || 'scan_failed' }); }
    }
    if (deleteOrphans) {
      for (const orphan of orphans) {
        if (!native.orphanRemovable(orphan.dirty, orphan.ahead)) continue;
        const dir = directories.get(orphan.dirId);
        if (!dir) continue;
        try {
          await repoActor.run(dir.path, 'worktree-orphan-remove', async ({ execGit }) => {
            await execGit(dir.path, ['worktree', 'remove', orphan.path]);
            await execGit(dir.path, ['worktree', 'prune']).catch(() => '');
          });
          orphan.removed = true;
        } catch (error) { orphan.removeError = error?.code || 'remove_failed'; }
      }
    }
    return finish(orphans);
  }
  return native.worktreeOrphanScanner({
    records, directories, repoActor, deleteOrphans, listTaskWorktreePaths, canon, collect,
    setTimeoutFn, setIntervalFn, startupDelayMs, intervalMs, clear: timer => clearTimeout(timer),
    stamp: () => new Date(now()).toISOString(), warn: (...args) => logger.warn?.(...args),
    tick: scan => () => { scan().catch(() => {}); },
  });
}

function createFcmTransport({ credentialsFile = process.env.MULTICC_FCM_CREDENTIALS,
  fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 10000 } = {}) {
  const disabledSend = async function send(token, data) { return { ok: false, code: 'not_configured' }; };
  let native, credentials;
  try {
    credentials = JSON.parse(require('node:fs').readFileSync(credentialsFile, 'utf8'));
    native = getNative();
  } catch { return { projectId: '', send: disabledSend }; }
  async function post(url, headers, body) {
    const response = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    return { response, body: await response.json() };
  }
  return native.fcmTransport({
    read: () => credentials,
    now: () => now(), fresh: expires => expires > now() + 60000, add: (a, b) => a + b,
    async refresh(credentials, cache) {
      const iat = Math.floor(now() / 1000);
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(native.fcmTokenClaims(credentials.client_email, iat))}`;
      const signature = require('node:crypto').createSign('RSA-SHA256').update(input).sign(credentials.private_key, 'base64url');
      const { response, body } = await post('https://oauth2.googleapis.com/token', { 'Content-Type': 'application/x-www-form-urlencoded' },
        new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${signature}` }).toString());
      return cache.remember(response, body);
    },
    // The first reader awaits inside finally. Followers directly adopt the
    // shared Promise, preserving the order in which their sends resume.
    tokenReader: (acquire, release) => async function accessToken() {
      const token = acquire();
      if (!token.started) return token.value;
      try { return await token.value; } finally { release(); }
    },
    disabled: () => disabledSend,
    sender: (url, accessToken, invalidate) => async function send(token, data) {
      try {
        const bearer = await accessToken();
        const { response, body } = await post(url, { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          JSON.stringify(native.fcmMessage(token, data)));
        return native.fcmDelivery(response, body, invalidate);
      } catch { return { ok: false, code: 'unavailable' }; }
    },
  });
}

function createArkQuotaHost() {
  const fs = require('node:fs');
  const exec = require('node:child_process').execFile;
  const owner = getNative().arkCliOwner({ env: process.env, find(name) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const file = path.join(dir, name);
      try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
    }
    return null;
  } });
  const run = plan => new Promise(resolve => exec(plan.cmd, plan.args, plan.options,
    (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' })));
  return {
    resolveArkcliBin: owner.resolveArkcliBin,
    async fetchArkUsage(nowMs = Date.now()) {
      const plan = owner.usagePlan();
      const result = await (plan ? run(plan) : Promise.resolve({ err: { code: 'ENOENT' }, stdout: '', stderr: '' }));
      return owner.result(result, nowMs);
    },
    async installArkcli() {
      const plan = owner.installation();
      return plan.cmd ? owner.installed(await run(plan)) : plan;
    },
    parseArkcliJsonStream: stream => getNative().arkcliJson(String(stream || '')),
  };
}
let arkCli;
function getArkQuotaHost() { return arkCli ??= createArkQuotaHost(); }

function findSakuraLauncher({ platform = process.platform, home = require('node:os').homedir(),
  exists = require('node:fs').existsSync } = {}) {
  if (platform !== 'darwin') return null;
  return getNative().sakuraFindApp(['/Applications/SakuraLauncher.app', path.join(home, 'Applications/SakuraLauncher.app')], path.join, exists);
}
async function restartSakuraLauncher(app, { run, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const native = getNative();
  const binaries = native.sakuraLauncherPaths().map(name => path.join(app, name));
  const state = new native.SakuraRestart();
  for (;;) {
    const command = state.command(app, binaries);
    let outcome;
    if (command.delay) await wait(command.delay);
    else outcome = await run(command.cmd, command.args);
    const ok = !!command.delay || !!outcome.ok;
    const terminal = state.advance(ok, !ok && command.checkMissing && outcome.code === 1);
    if (terminal) { if (terminal.ok) return terminal.message; throw new Error(terminal.message); }
  }
}
function diagnoseSakurafrp({ home = require('node:os').homedir(), logDir = path.join(home, 'Library', 'Containers',
  'com.natfrp.launcher', 'Data', 'Library', 'Application Support', 'natfrp-service', 'Logs'),
  readdirSync = require('node:fs').readdirSync, readFileSync = require('node:fs').readFileSync, now = Date.now } = {}) {
  return getNative().sakuraLogResult(logDir, { list: readdirSync, read: readFileSync, join: path.join, now });
}

let sessionNotices;
function getSessionNotices() { return sessionNotices ??= getNative().sessionNoticesApi(getNative()); }
let networkPolicy;
function getNetworkPolicy() { return networkPolicy ??= getNative().networkPolicyApi(getNative(), process); }
let sessionDto;
function getSessionDto() {
  return sessionDto ??= getNative().sessionDtoApi(getNative(), value => module.exports.autoProviderConfig.providerSelectionRequest(value));
}
let apiContract;
function getApiContract() {
  return apiContract ??= getNative().apiContractApi(getNative());
}
let publicSafety;
function getPublicSafety() { return publicSafety ??= getNative().publicSafetyApi(getNative()); }
let loadedPath = null;
let loaded = null;
let loadError = null;
let deliveryOwner = null;
let deliveryAddon = null;
let sessionDeliveryAddon = null;
let sessionDeliveryApi = null;
let taskFrames;
function getTaskFrames() { return taskFrames ??= getNative().taskFramesApi(module.exports.taskDomainHost.taskCodeRegistryState); }
const installAuxHealthProvider = fn => getTaskFrames().installAuxHealthProvider(fn);
const auxVerdictStaleness = () => getTaskFrames().auxVerdictStaleness();
const fanOutAuxVerdictStaleness = ports => getTaskFrames().fanOutAuxVerdictStaleness(ports);
const taskStateSeed = task => getTaskFrames().taskStateSeed(task);
const taskStatePayload = task => getTaskFrames().taskStatePayload(task);

let hostPrompts;
function getHostPrompts() { return hostPrompts ??= getNative().hostPromptsApi(process); }

let taskRelations;
function getTaskRelations() { return taskRelations ??= getNative().taskRelationsApi(); }

let notificationWords;
function getPushNotificationCopy() { return notificationWords ??= getNative().pushNotificationApi(); }

let quotaBarView;
function getQuotaBarView() { return quotaBarView ||= getNative().quotaBarViewApi(); }
// Use the JS arithmetic operator for timestamps supplied by host extensions.
const elapsedTime = (now, since) => now - since;
function providerLimitSnapshot(entry, now = Date.now()) {
  const { STALE_MS_DEFAULT } = module.exports.providerLimitCache;
  return getNative().providerLimitSnapshot(entry, now, STALE_MS_DEFAULT, elapsedTime);
}
function connectProviderLimitSync(options) {
  return getNative().subscribeProviderLimits(options, module.exports.providerLimitCache.STALE_MS_DEFAULT, elapsedTime);
}

let eventPolicy;
function getEventPolicy() { return eventPolicy ??= getNative().eventPolicyApi(require('node:os')); }

let counters;
// Compatibility value for Node modules that must load before the addon; the
// native delivery API is the policy owner and preflight verifies this marker.
const SESSION_DELIVERY_SYSTEM_PREFIX = '🔇';

// V8 strict property assignment port: preserves Proxy/setter and TypeError
// semantics while native session configuration owns all policy and ordering.
function assignHostProperty(target, key, value) { target[key] = value; }
// The provider detach port consumes a callback; keep that callback as a thin
// host adapter until the provider host and its callback move into Rust.
function pendingDesiredSession(session) { return getNative().sessionPendingDesiredSession(session, assignHostProperty); }


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
  if (!turnLedgerContracts.has(addon)) turnLedgerContracts.set(addon, addon.turnLedgerApi());
  return turnLedgerContracts.get(addon);
}

// Empty searches finish before addon loading. V8 map preserves holes, species,
// and getter timing while Rust projects candidates and selects original hits.
function rerankSearchHits(hits, { limit = 20, perRefQuota = 3, dedupeContentHash = true } = {}) {
  if (!Array.isArray(hits) || !hits.length) return [];
  const wanted = Math.max(0, Math.min(hits.length, Math.floor(Number(limit)) || 0));
  if (!wanted) return [];
  const native = getNative();
  return native.searchRankLive(hits, wanted, perRefQuota, dedupeContentHash);
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
function getMonitorAdmission() { return monitorAdmission ??= getNative().monitorAdmissionApi(getNative()); }
const resolveOpenCodeModelLimit = (catalog, id) => getNative().openCodeModelLimit(catalog, id);
// Capture the host intrinsics before extensions are loaded.
const catalogIntrinsics = { parse: JSON.parse, values: Object.values,
  iterator: Array.prototype[Symbol.iterator], min: Math.min };
function createOpencodeModelLimitResolver(deps = {}) {
  const defaultPath = () => path.join(process.env.HOME || require('node:os').homedir(), '.cache', 'opencode', 'models.json');
  return getNative().createOpencodeLimitResolver(deps, require('node:fs'), defaultPath, catalogIntrinsics);
}
let fallbackModelLimit;
const openCodeModelLimits = {
  createOpencodeModelLimitResolver, resolveOpenCodeModelLimit,
  get FALLBACK_LIMIT() { return fallbackModelLimit ??= getNative().openCodeFallbackLimit(); },
};

let nativeOpenCodeCatalog;
function getNativeOpenCodeCatalog() { return nativeOpenCodeCatalog ??= getNative().openCodeCatalogApi(getNative()); }
const voiceSpeech = {
  stripTruncatedLegacyMarker: raw => getNative().voiceSpeechValue(raw, undefined, false),
  sanitizeVoiceSpeech: (raw, options = undefined) => getNative().voiceSpeechValue(raw, options, true),
};
let migrationProgress;
function getTaskStoreMigrationProgress() { return migrationProgress ??= getNative().taskStoreProgressApi(); }

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
function record(feature) {
  counters ??= new (getNative().RustNativeCounters)();
  counters.record(feature);
}
// A status request also works before the loader has tried opening a .node file.
function status() {
  return { loaded: !!loaded, loadError, search: counters?.search ?? 0, usage: counters?.usage ?? 0 };
}
// napi 把结构化错误码塞在 message 里，code 统一是 GenericFailure；还原成真实码。
function nativeCode(error) {
  if (error?.code !== 'GenericFailure') return error;
  return getNative().normalizeNativeError(error);
}

// Preserve the synchronous spawn-port contracts while Rust owns file writes
// and credential selection. Only key names cross the env cleanup boundary.
const codexProviderHome = {
  materialize(home, settings, authOnly = false) {
    const globalAuth = path.join(require('node:os').homedir(), '.codex', 'auth.json');
    return getNative().codexMaterializeValue(home, globalAuth, settings, authOnly);
  },
  materializeOfficial: (home, id, config) => getNative().codexProviderOfficialHome(home, id, config),
  sanitizeOfficial: (home, proxyPath) => getNative().codexProviderSanitizeHome(home, proxyPath),
  stripOfficialEnv: env => getNative().codexStripOfficialEnv(env),
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
  getNative().opencodeProcessError(cli, raw, stderr);
function resolveCliRelayTarget(providers, cliName, providerId) {
  return getNative().resolveCliRelayTarget(providers, cliName, providerId);
}
const applyCliRelaySpawn = input => getNative().applyPreparedCliRelay(input, assignHostProperty);

const processSpawnArgs = (invocation, settings = null) => getNative().processSpawnArgs(invocation, settings);
const isZcodeSessionId = value => getNative().isZcodeSessionId(value);
const repairZcodeSessionState = session => getNative().repairZcodeSessionState(session);
const resolveModelRequestPolicy = (session = {}, env = process.env) => getNative().resolveModelRequestPolicy(session, env);
const createModelStreamProgress = () => getNative().createModelStreamProgress();
const createModelDefaultResolver = options => getNative().createModelDefaultResolver(options);
function claudeQuota(op, input) {
  try { return getNative().claudeQuotaValue(op, input); }
  catch { return undefined; }
}
function subscriptionFromBody(body, options = undefined) {
  return getNative().accountSubscriptionValue(body, options);
}
function codexAuthSubscription(auth) {
  return credential({ operation: 'codexSubscription', auth });
}
function credential(input) { return getNative().providerCredentialValue(input); }
async function readCli(input) { return getNative().readProviderCliValue(input); }
const providerCredentials = { credential, readCli };
function readCodexAuth(file) {
  return providerCredentials.credential({ operation: 'codexAuth',
    file: file || path.join(require('node:os').homedir(), '.codex', 'auth.json') });
}
function requestCodexUsage(auth, { fetch = module.exports.outbound.outboundFetch, signal } = {}) {
  return getNative().requestCodexUsage(auth, fetch, signal);
}
const taskShellCapacity = {
  get MAX_TASKS_PER_DIRECTORY() { return getNative().taskDirectoryCapacityLimit(); },
  directoryTaskCount: (store, dirId) => getNative().taskDirectoryCapacity(store, dirId, false),
  directoryAtCapacity: (store, dirId) => getNative().taskDirectoryCapacity(store, dirId, true),
};
function createCliProviderRegistry(adapters, fallbackName = 'claude') {
  return getNative().createCliProviderRegistry(adapters, fallbackName);
}
const zcodeEngine = {
  get DEFAULT_ZCODE_ENGINE() { return getNative().zcodeDefaultEngine(); },
  zcodeEngineCandidates: (options = {}) => getNative().zcodeEngineCandidates(options, path),
  zcodeBuiltinProviderConfig: engine => getNative().zcodeBuiltinProviderConfig(engine, path),
  zcodeEngineEnv: (engine, env = process.env) => getNative().zcodeEngineEnv(engine, env, path),
};

// 原生任务共用 libuv 工作池。只限制并行数，避免搜索突发占满文件 I/O 线程；排满时
// 等待而不拒绝：Air 刷新与任务板落盘也走这条队列，拒绝就是一次失败的刷新或保存。
let nativeQueue;
function runNative(operation) {
  const run = nativeQueue ??= getNative().createNativeQueue();
  return run(operation);
}
function decodeRecoveryEvents(raw) { return getNative().decodeSchedulerRecoveryEvents(raw); }
// The task runtime uses its V8 locale and comparator for stable candidate
// order. Pass the selected values to Rust with their JS exception identity.
let selectionApi;
function getContextSelection() {
  return selectionApi ??= getNative().contextSelectionApi((right, left) => right - left);
}


// Artifact reference recognition is Rust-only. Each member resolves the addon
// lazily, so a module that merely loads this facade (src/artifacts.js in a bare
// child process) needs no native module until it recognizes an id.
const artifactReference = {
  isArtifactId: value => getNative().artifactReferenceIsArtifactId(value),
  normalizeRelativePath: value => getNative().artifactReferenceNormalizeRelativePath(value),
  extractArtifactReferences: content => getNative().artifactReferenceExtract(content),
};
// Compatibility closures keep the existing CLI/SDK callbacks alive. Rust owns
// preparation and all routing decisions; no Provider policy is reimplemented here.
const providerInvocation = {
  createProviderInvocationFactory(options = {}) {
    return getNative().createProviderInvocationFactory(options, {
      ProviderAttemptError: module.exports.providerAttemptRuntime.ProviderAttemptError,
      assertProviderBinding: module.exports.providerBinding.assertProviderBinding,
      TurnRequestError: module.exports.turnRequestHost.TurnRequestError,
    });
  },
  protocolFor: (cli, summary) => getNative().providerInvocationProtocol(cli, summary),
  providerRetryRouteOptions: attempt => getNative().providerRetryRouteOptions(attempt),
};
function createAutoProviderHandoff(options) { return getNative().createAutoProviderHandoff(options); }
function createClaudeAdapter(deps = {}) {
  return getNative().createClaudeAdapter(deps, path.join(__dirname, '../cli-adapters/claude-agent-sdk-bridge.mjs'),
    process.execPath, {
      displayName: module.exports.cliCapability.displayNameOf('claude'),
      homedir: require('node:os').homedir,
    });
}
const codexAdapter = {
  createCodexAdapter(deps) {
    return getNative().createCodexAdapter(deps, {
      extractUpstreamError: module.exports.upstreamError.extractUpstreamError,
      displayName: module.exports.cliCapability.displayNameOf('codex'),
    });
  },
  normalizeCodexUsage: value => getNative().codexAdapterCall('usage', value, undefined),
  mcpResultText: value => getNative().codexAdapterCall('mcp-text', value, undefined),
  isCodexInternalNoise: value => getNative().codexAdapterCall('noise', value, undefined),
  routerMcpConfigArgs: (node, script) => getNative().codexAdapterCall('router', [node, script], undefined),
};
const codexAppAdapter = {
  createCodexExpAdapter(deps = {}) {
    return getNative().createCodexExpAdapter(deps, gatewayPath(), process.execPath, {
      displayName: module.exports.cliCapability.displayNameOf('codex-exp'),
    });
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
  createCodexBackgroundEvents(options = {}) { return getNative().createCodexBackgroundEvents(options); },
};
// Session persistence adapter (former src/session/persistence.js). The native
// record owner stays the single writer; the host only supplies the facade's
// owner lookup, which the factory calls after its own Map check.
function jsonClone(value) {
  return getNative().sessionPersistenceJsonClone(value);
}
// `arguments[0]` keeps the legacy zero-length signature and the `= {}` default.
function createSessionPersistence() {
  return getNative().sessionPersistenceCreate(module.exports.sessionRecordsHost.sessionRecordsOwner, arguments[0]);
}
function quickCommitMessage(porcelain) {
  let addon;
  try { addon = getNative(); } catch {}
  if (typeof addon?.quickCommitMessageValue !== 'function') {
    throw new Error('提交说明生成模块不可用，请构建当前版本的 Rust 模块后重试');
  }
  return addon.quickCommitMessageValue(porcelain);
}

function createFsDirectoryRepository({ file, map, realPathOf, owner }) {
  return getNative().directoryRepository({ file, map, realPathOf, owner });
}
function createNativeProviderStore(file) {
  return getNative().providerRepository(file);
}

let turnEventReplay;
function getTurnEventReplay() { return turnEventReplay ||= getNative().turnEventReplayApi(); }

const createCandidateStore = store => getNative().candidateStore(store);

async function syncWorktreeOnWake(dirPath, worktree, baseBranch) {
  try {
    const addon = getNative();
    if (!addon.wakeSyncResult) return { ok: false, code: 'wake_sync_unavailable' };
    return addon.wakeSyncResult(dirPath, worktree, baseBranch);
  } catch { return { ok: false, code: 'wake_sync_failed' }; }
}
async function prepareCliSwitchRoute(input) {
  return getNative().switchRouteResult(input, require('node:os').homedir, false);
}
async function synchronizeCodexProfileRoute(route) {
  return getNative().switchRouteResult(route, require('node:os').homedir, true);
}

let turnState;
function getTurnState() { return turnState ??= getNative().turnStateApi(); }

let transcriptPruning;
function getTranscriptPruning() {
  const native = getNative();
  return transcriptPruning ||= native.transcriptPruningApi(require('node:os'));
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
  const override = module.exports.getNative === getNative ? undefined : native;
  return native.orchestrationCommandSync(override, name, draft, args, snapshot, promiseThen);
}
function commandEnvelope(value) { return getNative().commandEnvelope(value); }
const jsonStorePorts = new WeakMap();
function orchestrationJsonPorts(factory, ports) {
  if (ports) jsonStorePorts.set(factory, { ...ports, binding: module.exports, getNative, promiseThen });
  return jsonStorePorts.get(factory);
}

module.exports = { DEFAULT_RUNTIME_HOME_TTL_DAYS, MAX_UNLOCK_PASSWORD_LENGTH, createWorktreeOrphanScanner, createFcmTransport, createArkQuotaHost, getArkQuotaHost, findSakuraLauncher, restartSakuraLauncher, diagnoseSakurafrp, createUploadSuite, createAdmissionGate, UploadPolicyError, UPLOAD_LIMITS, createRuntimeHomesJanitor, startRuntimeHomesJanitor, createUnlockPassword, createUnlockProbe, createTaskFactsRepository, createErrorPersister, getTurnProgress, getWriterGroup, getVendorLogin, getMonitorControl, getProcessCloser, getAutoProviderPricing, getAutoProviderPolicy, getRetryPolicy, getSessionNotices, getNetworkPolicy, getSessionDto, getApiContract, getPublicSafety, getTranscriptPruning, planClaudeExpiredRefresh, invokeNativeCommand, commandEnvelope, orchestrationJsonPorts, getTurnEventReplay, createCandidateStore, syncWorktreeOnWake, prepareCliSwitchRoute, synchronizeCodexProfileRoute,
  getTurnState, quickCommitMessage, createFsDirectoryRepository, createNativeProviderStore, getHostPrompts, getTaskRelations, openCodeModelLimits, getMonitorAdmission, getNativeOpenCodeCatalog, voiceSpeech, getTaskStoreMigrationProgress, getEventPolicy, getQuotaBarView, providerLimitSnapshot, connectProviderLimitSync, getPushNotificationCopy, getTurnLedgerContract, rerankSearchHits, searchTokenizer, addonPath, gatewayPath, getNative, getSessionDeliveryApi, SESSION_DELIVERY_SYSTEM_PREFIX, assignHostProperty, pendingDesiredSession, findProviderReferences, record, status, runNative, nativeCode, deliveryClassForItem,
  installAuxHealthProvider, auxVerdictStaleness, fanOutAuxVerdictStaleness, taskStateSeed, taskStatePayload,
  artifactReference, getContextSelection, decodeRecoveryEvents, providerInvocation, createAutoProviderHandoff,
  createClaudeAdapter, codexAdapter, codexAppAdapter, codexBackground, codexProviderHome,
  claudeSettingsOverride, opencodeProcessError, processSpawnArgs, resolveCliRelayTarget, applyCliRelaySpawn, isZcodeSessionId, repairZcodeSessionState,
  pathSafety, stateBootstrap, bootstrapState, messageComposer, resolveModelRequestPolicy, createModelStreamProgress, zcodeEngine, createCliProviderRegistry, taskShellCapacity, providerCredentials, readCodexAuth, requestCodexUsage, createModelDefaultResolver, claudeQuota, subscriptionFromBody, codexAuthSubscription, createSessionPersistence, jsonClone };
// The stable PersistenceError class is created natively once per environment.
Object.defineProperty(module.exports, 'PersistenceError', {
  enumerable: true,
  get: () => getNative().sessionPersistenceErrorClass(),
});

for (const [key, factory] of [['postTurnRouter', 'postTurnApi'], ['finalizationPlan', 'finalizationApi'], ['taskShellContext', 'taskShellContextApi']]) {
  let api;
  Object.defineProperty(module.exports, key, {
    enumerable: true, get() { const addon = getNative(); return api ??= addon[factory](addon); },
  });
}

let frameMethods;
Object.defineProperty(module.exports, 'historyFrame', {
  enumerable: true,
  get() { const addon = getNative(); return frameMethods ??= addon.historyFrameApi(addon); },
});
let managedMethods;
Object.defineProperty(module.exports, 'managedContext', {
  enumerable: true,
  get() {
    const addon = getNative();
    return managedMethods ??= { prepareManagedContext: addon.managedContextOpen,
      contextSent: addon.managedContextSent, contextCompleted: addon.managedContextCompleted };
  },
});

let adapterCompletion;
Object.defineProperty(module.exports, 'adapterCompletion', {
  enumerable: true,
  get: () => adapterCompletion ??= getNative().adapterCompletionApi(assignHostProperty),
});

async function deliveryView({ sessionId, taskId, candidate, separation, admission, cwd }) {
  const native = getNative();
  const { evidence, value } = native.beginDeliveryView(sessionId, taskId, candidate, separation, admission, cwd);
  if (!evidence) return value;
  let baseline = null;
  try { baseline = await value; } catch {}
  return native.projectDeliveryView(taskId, candidate, separation, evidence.run, evidence.integration, evidence.barrier, evidence.application, baseline);
}

module.exports.deliveryView = deliveryView;

// CommonJS exposes stable, per-isolate Rust APIs. Deferring construction also
// keeps the loader usable by standalone tooling before it needs an addon.
const legacyHostApis = new Map();
function exposeHostApi(key, create) {
  let api, legacyModule;
  function load() {
    if (api !== undefined) return api;
    try { api = create(); }
    catch (err) {
      if (err.message !== 'rust_backend_unavailable') throw err;
      api = require('./bootstrap-apis').bootstrapApi(key, create, err);
    }
    return api;
  }
  legacyHostApis.set(key, current => {
    // Explicit require.cache eviction creates a fresh realm-local owner (for
    // example an isolated tunnel with a different data directory).
    if (legacyModule && legacyModule !== current) api = undefined;
    legacyModule = current;
    return load();
  });
  Object.defineProperty(module.exports, key, {
    enumerable: true,
    get: load,
  });
}

module.exports.loadLegacyHostApi = (key, current) => legacyHostApis.get(key)(current);

// Built-in channel policy/state is native. Only SDK loading, live Node handles
// and timer/fetch/filesystem ports remain here; no fallback channel implementation.
exposeHostApi('imChannelHost', () => {
  const ports = options => ({
    express: require('express'), fs: require('node:fs'), path: require('node:path'),
    os: require('node:os'), crypto: require('node:crypto'),
    legacyDir: require('node:path').resolve(__dirname, '../../plugins/bridges'),
    bridgeConfig: module.exports.bridgeConfig, bridgeGateway: module.exports.bridgeGateway,
    fetch: (...args) => globalThis.fetch(...args), AbortController, AbortSignal,
    now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    setInterval, clearInterval,
    loadLark: () => require('@larksuiteoapi/node-sdk'),
    createLarkHttpInstance: (...args) => require('../network/sdk-bridges').createLarkHttpInstance(...args),
    outboundAgent: module.exports.outbound.outboundAgent,
    ...options,
  });
  return {
    createWechatBridge: (options = {}) => getNative().wechatBridgeApi(ports(options)),
    createFeishuBridge: (options = {}) => getNative().feishuBridgeApi(ports(options)),
  };
});
exposeHostApi('wechatBridge', () => module.exports.imChannelHost.createWechatBridge());
exposeHostApi('feishuBridge', () => module.exports.imChannelHost.createFeishuBridge());

// Node owns the event-loop histogram and JavaScript's overloaded + operator.
exposeHostApi('observability', () => {
  const native = getNative();
  return native.observabilityApi({
    monitor: require('node:perf_hooks').monitorEventLoopDelay,
    date: () => new Date(), add: (a, b) => a + b,
  });
});

exposeHostApi('jevClient', () => getNative().jevClientApi(module.exports.outbound.outboundFetch));

exposeHostApi('providerAttemptRuntime', () => {
  class ProviderAttemptError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'ProviderAttemptError';
      this.code = code || 'PROVIDER_ATTEMPT_INVALID';
    }
  }
  return getNative().providerAttemptRuntimeApi(ProviderAttemptError);
});

exposeHostApi('autoProviderConfig', () => getNative().providerSelectionHost());

exposeHostApi('turnRequestHost', () => {
  class TurnRequestError extends TypeError {
    constructor(code, message) { super(message); this.name = 'TurnRequestError'; this.code = code; }
  }
  return getNative().turnRequestHost({ TurnRequestError, assertProviderBinding: module.exports.providerBinding.assertProviderBinding });
});

exposeHostApi('upstreamError', () => getNative().upstreamDiagnosticsApi(async (body, signal, timeout, limit) => {
  const reader = body.getReader();
  const chunks = [];
  let length = 0, interrupted = false, stop;
  const stopped = new Promise(resolve => {
    stop = () => { interrupted = true; resolve({ done: true }); };
  });
  const timer = setTimeout(stop, timeout);
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  try {
    while (length < limit && !interrupted) {
      const { value, done } = await Promise.race([reader.read(), stopped]);
      if (done) break;
      const chunk = Buffer.from(value).subarray(0, limit - length);
      chunks.push(chunk);
      length += chunk.length;
    }
  } catch {
    // The received prefix can still contain the upstream diagnostic.
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    Promise.resolve(reader.cancel()).catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}));

exposeHostApi('outbound', () => {
  const { Agent, ProxyAgent: FetchProxyAgent, Dispatcher, Request, fetch } = require('undici');
  const { ProxyAgent } = require('proxy-agent');
  const { createProxyPolicy } = module.exports.proxyPolicy;
  class RoutingDispatcher extends Dispatcher {
    constructor(policy) {
      super();
      this.policy = policy;
      this.direct = new Agent();
      this.proxies = new Map();
      this.closed = false;
    }
    dispatch(options, handler) {
      return getNative().outboundDispatch(this, options, handler, FetchProxyAgent);
    }
    async close() {
      this.closed = true;
      await Promise.all([this.direct, ...this.proxies.values()].map(agent => agent.close()));
    }
    async destroy(error) {
      this.closed = true;
      await Promise.all([this.direct, ...this.proxies.values()].map(agent => agent.destroy(error)));
    }
  }
  async function abortable(promise, signal) {
    if (!signal) return promise;
    signal.throwIfAborted();
    let onAbort;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', onAbort); }
  }
  function createOutbound(options = {}) {
    const policy = options.policy || createProxyPolicy(options);
    const dispatcher = new RoutingDispatcher(policy);
    const agent = new ProxyAgent({ getProxyForUrl: url => policy.proxyForUrl(url) });
    const ports = { fetch: options.fetch || fetch, policy, dispatcher, abortable };
    async function outboundFetch(url, init = {}) {
      try {
        // Node's built-in Request and npm undici's Request have distinct
        // constructors. Preserve the live body and AbortSignal on conversion.
        if (url && typeof url.url === 'string' && !(url instanceof Request)) {
          if (url.bodyUsed) throw new TypeError('请求正文已经被读取');
          url = new Request(url.url, url);
        }
        const signal = init.signal ?? url?.signal;
        signal?.throwIfAborted();
        const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
        return getNative().outboundRequest(ports, url, init, signal, target.hostname.toLowerCase());
      } catch (error) {
        if (error && typeof error === 'object') error.multiccProxyMode = 'proxy-discovery';
        throw error;
      }
    }
    async function getChildProxyEnv(base = process.env) {
      const config = await policy.configuration();
      return getNative().outboundChildEnv(base, config);
    }
    async function close() {
      agent.destroy(); agent.httpAgent.destroy(); agent.httpsAgent.destroy();
      await dispatcher.close();
    }
    outboundFetch.close = close;
    return { outboundFetch, outboundAgent: agent, outboundDispatcher: dispatcher, getChildProxyEnv, policy, close };
  }
  const api = { ...createOutbound(), createOutbound, RoutingDispatcher };
  Object.defineProperty(api, 'official', { configurable: true, get() {
    const { createOutbound, outboundFetch } = api;
    const { parseMacSystemProxy } = module.exports.proxyPolicy;
    const value = {
      parseMacProxy(text) {
        const { httpProxy, httpsProxy } = parseMacSystemProxy(text);
        return { httpProxy, httpsProxy };
      },
      createOfficialFetch: options => createOutbound(options).outboundFetch,
      officialFetch: outboundFetch,
    };
    return Object.defineProperty(api, 'official', { value, writable: true }).official;
  } });
  return api;
});

exposeHostApi('cliAdapters', () => {
  const { displayNameOf, supportsEffort, effortOf } = module.exports.cliCapability;
  const { createCompletionTracker, createStepCompletionTracker, createProtocolCompletionTracker } = module.exports.cliCompletion;
  const { createResultCompletionTracker, isMainResult, resultCompletion } = module.exports.cliResultCompletion;
  const { classifyProviderError, errorFields } = module.exports.providerError;
  const { resolveCliCommands, createCommandResolver } = module.exports.cliCommands;
  return getNative().cliAdaptersApi({
    getNative, process, gatewayPath, createCliProviderRegistry, createClaudeAdapter,
    createCodexAdapter: codexAdapter.createCodexAdapter, createCodexExpAdapter: codexAppAdapter.createCodexExpAdapter,
    createDshAdapter: module.exports.dshAdapter.createDshAdapter,
    resolveCliCommands, createCommandResolver,
    claudeLikeMcpArgs: module.exports.routerMcp.claudeLikeMcpArgs,
    validateOpenCodeModel: module.exports.openCodeModels.validateOpenCodeModel,
    extractUpstreamError: module.exports.upstreamError.extractUpstreamError,
    messageComposer, renderPrompt: messageComposer.renderPrompt,
    displayNameOf, supportsEffort, effortOf, classifyProviderError, errorFields, isZcodeSessionId,
    createCompletionTracker, createStepCompletionTracker, createProtocolCompletionTracker,
    createResultCompletionTracker, isMainResult, resultCompletion,
    routerScript: path.join(__dirname, '../../scripts/multicc-router-mcp.js'),
    zcodeBridgePath: path.join(__dirname, '../cli-adapters/zcode-bridge.cjs'),
    zcodeTerminalPath: path.join(__dirname, '../cli-adapters/zcode-terminal.cjs'),
    piExtensionPath: path.join(__dirname, '../cli-adapters/pi-router-extension.mjs'),
    appendTerminalArg: (cmd, flag, value) => cmd + ` ${flag} ${value}`,
  });
});

exposeHostApi('artifactRetention', () => {
  const rows = entries => JSON.stringify(entries.map(({ url, permanent, relatedArtifactIds }) => ({
    url: typeof url === 'string' ? url : null, permanent: !!permanent,
    relatedArtifactIds: Array.isArray(relatedArtifactIds) ? relatedArtifactIds.filter(id => typeof id === 'string') : [],
  })));
  return {
    artifactIdFromUrl: url => typeof url === 'string' ? getNative().artifactIdFromRegistryUrl(url) ?? null : null,
    permanentArtifactIds: (entries, roots) => new Set(getNative().retainedArtifactIds(rows(entries), roots)),
    permanentArtifactIdsAsync: (entries, roots) => getNative().retainedArtifactIdsAsync(rows(entries), roots),
  };
});

exposeHostApi('claudeSdkConfig', () => {
  const fs = require('node:fs');
  const settings = cfg => cfg.settingsFile ? JSON.parse(fs.readFileSync(cfg.settingsFile, 'utf8')) : {};
  return {
    fingerprint(cfg) {
      return getNative().claudeSdkFingerprint(cfg, module.exports.claudeSdkRoute.managedRoute(cfg.env), settings(cfg));
    },
    laneOptions(cfg, started, relayEnv) {
      const parsed = settings(cfg);
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'multicc-sdk-'));
      const dispose = () => fs.rmSync(dir, { recursive: true, force: true });
      try {
        fs.chmodSync(dir, 0o700);
        return getNative().claudeSdkLaneOptions(cfg, !!started, relayEnv, parsed, { path: path.join(dir, 'settings.json'), dispose });
      } catch (error) { dispose(); throw error; }
    },
  };
});

exposeHostApi('workspaceResidency', () => ({
  createWorkspaceResidency({ status, pending, closeAndWait }) {
    const native = getNative();
    const ports = {
      entries: new Map(), status: name => status(name), pending: name => pending(name), closeAndWait,
      setActivity(entry, callback) { entry.onActivity = callback; }, setParked(entry) { entry.parked = true; },
      busy: () => Object.assign(new Error('workspace_busy'), { code: 'workspace_busy', backpressure: true }),
      location(value) {
        if (!value) return null;
        try { return require('node:fs').realpathSync(value); } catch { return path.resolve(value); }
      },
    };
    return native.workspaceResidencyApi(ports, native.workspaceResidency(ports));
  },
}));

exposeHostApi('egressIpPolicy', () => getNative().egressIpPolicyApi(module.exports.egressIpMonitor));

exposeHostApi('proxyPolicy', () => {
  const run = require('node:util').promisify(require('node:child_process').execFile);
  const ports = { get native() { return getNative(); }, valid(value) {
    try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
  } };
  function parseMacSystemProxy(text) { return JSON.parse(getNative().outboundSystemProxy(String(text))); }
  async function readMacSystemProxy() {
    const { stdout } = await run('/usr/sbin/scutil', ['--proxy'], { timeout: 2000, maxBuffer: 32768 });
    return parseMacSystemProxy(stdout);
  }
  const hasProxyEnv = env => getNative().outboundProxyEnv(env);
  const mergeLoopbackNoProxy = env => getNative().outboundMergeEnv(env);
  return {
    createProxyPolicy(options = {}) {
      const config = { env: options.env || process.env, platform: options.platform || process.platform,
        readSystem: options.readSystemProxy || readMacSystemProxy, now: options.now || Date.now, options };
      let instance;
      const policy = () => instance ??= getNative().outboundPolicyInstance(ports, config);
      return { async configuration() { return policy().configuration(); }, async proxyForUrl(url) { return policy().proxyForUrl(url); },
        invalidate() { instance?.invalidate(); } };
    },
    parseMacSystemProxy, readMacSystemProxy, hasProxyEnv, mergeLoopbackNoProxy,
    ensureLoopbackNoProxyEnv: env => env && typeof env === 'object' && hasProxyEnv(env) ? mergeLoopbackNoProxy(env) : env,
    resolveProxyConfig: (env, system) => getNative().outboundResolve(env, system, hasProxyEnv(env), ports.valid),
    cidrToRange: entry => getNative().outboundCidr(String(entry)) ?? null,
    bypassProxy: (url, entries) => getNative().outboundBypassUrl(ports, url, entries),
    isLoopback: host => getNative().outboundLoopback(host.toLowerCase()),
  };
});

exposeHostApi('modelConnectWatch', () => {
  const scope = new (require('node:async_hooks').AsyncLocalStorage)();
  const { channel } = require('node:diagnostics_channel');
  let owner;
  const timers = () => owner ??= getNative().modelConnectTimers({ schedule: getNative().scheduleRequestTimer });
  channel('undici:request:create').subscribe(({ request }) => { if (scope.getStore()) timers().begin(request, scope.getStore()); });
  // HTTP/2 skips sendHeaders. Both transports publish bodySent or headers.
  for (const name of ['undici:client:sendHeaders', 'undici:request:bodySent', 'undici:request:headers', 'undici:request:error']) {
    channel(name).subscribe(({ request }) => owner?.end(request));
  }
  channel('http.client.request.start').subscribe(({ request }) => {
    if (!scope.getStore()?.stall?.isArmed()) return;
    const end = () => timers().end(request);
    function watchSocket(socket) {
      if (!socket.connecting) return;
      timers().begin(request, scope.getStore());
      const connected = socket.encrypted ? 'secureConnect' : 'connect';
      const done = () => {
        end();
        for (const event of [connected, 'error', 'close']) socket.removeListener(event, done);
      };
      for (const event of [connected, 'error', 'close']) socket.once(event, done);
    }
    if (request.socket) watchSocket(request.socket);
    else request.once('socket', watchSocket);
    request.once('error', end);
    request.once('close', end);
  });
  return { withModelConnectWatch: (context, fn) => scope.run(context, fn) };
});

let cliEnvironment;
function getCliEnvironment() {
  return cliEnvironment ??= getNative().cliEnvironmentApi({
    fs: require('node:fs'),
    path,
    homedir: require('node:os').homedir,
    childProcess: require('node:child_process'),
    pluginsDir: path.resolve(__dirname, '../..', 'plugins'),
    hasCliRelayProvider(cli) { return module.exports.providersHost.hasCliRelayProvider(cli); },
  });
}

exposeHostApi('dshAdapter', () => getNative().dshAdapterApi({
  fs: require('node:fs'), path, homedir: require('node:os').homedir,
  runnerSrcDir: path.join(__dirname, '../..', 'vendor', 'dsh-runner'),
}));
exposeHostApi('usageLimitPoller', () => getNative().usageLimitPollerHost({
  crypto: require('node:crypto'),
  State: getNative().RustUsageLimitPoller,
  outboundFetch: module.exports.outbound.outboundFetch,
  readCodexAuth, requestCodexUsage,
  publicTransportError: module.exports.upstreamError.publicTransportError,
  providers: module.exports.providersHost,
  checkEgressIpAllowed: module.exports.egressIpPolicy.checkEgressIpAllowed,
}));
exposeHostApi('claudeSdkRoute', () => getNative().claudeSdkRouteApi({
  http: require('node:http'), crypto: require('node:crypto'),
  closeMethod: closeRelay => async function close() { await closeRelay(this); },
}));
exposeHostApi('orchestrationDraft', () => getNative().orchestrationDraftApi({
  ...module.exports.orchestrationJson, isProxy: require('node:util').types.isProxy,
}));
exposeHostApi('claudeOfficialOAuth', () => {
  const native = getNative();
  class ClaudeOAuthError extends Error {
    constructor(message, options) {
      super(message);
      native.initializeClaudeOauthError(this, options);
    }
    get retryable() { return native.claudeOauthRetryable(this); }
  }
  return native.claudeOfficialOauthHost({
    crypto: require('node:crypto'), http: require('node:http'),
    ClaudeOAuthError, subscriptionFromBody,
  });
});
exposeHostApi('egressIpMonitor', () => getNative().egressIpMonitorApi(require('node:https')));
exposeHostApi('gatewayChatBridge', () => {
  const native = getNative();
  const { EventEmitter } = require('node:events');
  class FrameError extends Error {}
  class BridgeSocket extends EventEmitter {
    constructor(bridge, conn, info) {
      super();
      native.initializeGatewayBridgeSocket(this, bridge, conn, info);
    }
  }
  return native.gatewayChatBridgeHost({
    FrameError, BridgeSocket, net: require('node:net'), crypto: require('node:crypto'),
  });
});
exposeHostApi('orchestrationNativeStore', () => getNative().orchestrationNativeStoreApi({
  get native() { return module.exports.getNative(); },
  addonPath, promiseThen, AsyncLocalStorage: require('node:async_hooks').AsyncLocalStorage,
  isProxy: require('node:util').types.isProxy, isNativeError: require('node:util').types.isNativeError,
  Buffer: require('node:buffer').Buffer, crypto: require('node:crypto'),
  getOutboxConflictError: () => module.exports.outboxRuntime.OutboxConflictError,
  commandOverride: () => module.exports.getNative === getNative ? undefined : module.exports.getNative(),
}));
exposeHostApi('outboxRuntime', () => {
  class OutboxConflictError extends Error {
    constructor(id) {
      super(`outbox item ${id} already exists with different content`);
      this.name = 'OutboxConflictError';
      this.code = 'OUTBOX_PAYLOAD_CONFLICT';
      this.statusCode = 409;
      this.outboxId = id;
    }
  }
  return getNative().outboxRuntimeApi(require('node:crypto'), OutboxConflictError);
});
exposeHostApi('routerMcp', () => getNative().routerMcpApi({ path, homedir: require('node:os').homedir }));
exposeHostApi('cliCommands', () => getCliEnvironment().cliCommands);
exposeHostApi('windowsEnv', () => getCliEnvironment().windowsEnv);
exposeHostApi('agyAccounts', () => getCliEnvironment().agyAccounts);

exposeHostApi('codexAttemptHome', () => getNative().codexAttemptHomeApi({ path }));
exposeHostApi('codexSessionHome', () => getNative().codexSessionHomeApi({ path, os: require('node:os') }));
exposeHostApi('officialAccounts', () => getNative().officialAccountsApi({ path, os: require('node:os') }));

exposeHostApi('codexResidentRoute', () => getNative().residentProviderRoutesApi({
  exists: file => require('node:fs').existsSync(file),
  providers: () => module.exports.providersHost,
}));

exposeHostApi('codexOfficialRelay', () => getNative().codexOfficialRelayApi({
  authFile: path.join(require('node:os').homedir(), '.codex', 'auth.json'),
  officialFetch: () => module.exports.outbound.official.officialFetch,
  uuid: require('node:crypto').randomUUID,
  history: module.exports.modelHistoryConverter,
  errors: module.exports.upstreamError,
  async pump(reader, isOpen, write) {
    while (isOpen()) {
      const { done, value } = await reader.read();
      if (done) break;
      write(value);
    }
  },
}));

exposeHostApi('providersHost', () => getNative().providersHostApi({
  sdk: require('cli-provider-router'), environment: process.env, homedir: require('node:os').homedir, home: require('node:os').homedir(),
  paths: module.exports.appPaths.createPaths({ dataDir: process.env.MULTICC_DATA_DIR }),
  defaults: module.exports.providerDefaults, official: module.exports.officialCatalog,
  accounts: module.exports.officialAccounts, settings: module.exports.claudeSettingsOverride,
  modelLimits: module.exports.openCodeModelLimits.createOpencodeModelLimitResolver(),
  sessionHomeApi: module.exports.codexSessionHome, attemptHome: module.exports.codexAttemptHome.createCodexAttemptHome,
  resident: module.exports.codexResidentRoute, relay: module.exports.codexOfficialRelay,
  codexHome: module.exports.codexProviderHome, exists: require('node:fs').existsSync,
  nativeCode, uuid: require('node:crypto').randomUUID,
  defaultModels: () => module.exports.codexModelCatalog.defaultRuntime,
  runProbeChild: (command, args, env) => new Promise(resolve => {
    const child = require('node:child_process').spawn(command, args, { env, windowsHide: true });
    let output = '';
    const capture = chunk => { if (output.length < 2048) output += chunk.toString(); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 25000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => { clearTimeout(timer); resolve(output); });
  }),
}));

exposeHostApi('codexProxyTrace', () => getNative().codexProxyTraceApi());

exposeHostApi('proxyOutcome', () => {
  function proxyRequestKind(protocol, req) {
    return getNative().proxyClassifyRequest(protocol === 'claude', String(req?.method || '').toUpperCase(), String(req?.url || req?.originalUrl || ''));
  }
  return { proxyRequestKind, normalizeProxyOutcome: value => getNative().proxyNormalizeOutcome(value),
    observeProxyRequest(protocol, req, res, onTerminal = () => {}, beforeDisconnect = () => false) {
      const native = getNative();
      return native.observeProxyResponse({ id: require('node:crypto').randomUUID(), kind: proxyRequestKind(protocol, req),
        state: new native.ProxyObservationState(), onTerminal, beforeDisconnect }, req, res);
    },
  };
});

exposeHostApi('claudeQuotaBridge', () => ({
  createClaudeQuotaBridge(app, options) {
    const extract = headers => claudeQuota('extract', { headers });
    if (typeof options.onRateLimit !== 'function' || extract({}) === undefined) return { app, options };
    const hooks = getNative().claudeQuotaHeaderHooks({ extract, options });
    const contexts = new (require('node:async_hooks').AsyncLocalStorage)();
    return {
      app: { use(path, handler) {
        return app.use(path, (req, res, next) => {
          const state = { context: null, fallback: null };
          const original = res.writeHead;
          res.writeHead = function (status, ...args) {
            res.writeHead = original;
            try { hooks.writeHead(state, res, status, args); } catch { /* An observer cannot interrupt forwarding. */ }
            return original.call(this, status, ...args);
          };
          return contexts.run(state, () => handler(req, res, next));
        });
      } },
      options: { ...options, onActivity: event => hooks.activity(contexts.getStore(), event),
        onRateLimit: event => hooks.rateLimit(contexts.getStore(), event) },
    };
  },
}));

function createAccountSubscriptionCache(native = getNative(), run = runNative) {
  return getNative().accountCacheHost({
    async access(file, input) { return JSON.parse(await run(() => native.accountSubscriptionCache(file, JSON.stringify(input)))); },
    project: (providers, subscriptions) => JSON.parse(native.projectAccountSubscriptions(JSON.stringify({ providers, subscriptions }))),
  });
}
exposeHostApi('accountSubscriptionCache', () => createAccountSubscriptionCache());
module.exports.createAccountSubscriptionCache = createAccountSubscriptionCache;

exposeHostApi('claudeUsageQueue', () => {
  const native = getNative();
  const defaultNow = () => Date.now();
  const ports = { entries: new Map(), inflight: new Map(), defaultNow, now: defaultNow };
  ports.store = native.claudeUsageCache({
    entries: ports.entries, inflight: ports.inflight, now: () => ports.now(),
    before: (at, other) => at < other, fresh: entry => ports.now() - entry.at < 60000,
    get configured() { return typeof ports.fetchUsage === 'function'; },
    resolved: value => Promise.resolve(value), account: name => name.slice('claude:'.length),
    async fetch(name, accountId) {
      const fetchUsage = ports.fetchUsage;
      let result;
      try { result = await (accountId ? fetchUsage({ accountId }) : fetchUsage()); }
      catch (err) { result = { status: 'unavailable', error: String(err?.message || err) }; }
      return ports.store.finish(name, result);
    },
  });
  return native.claudeUsageQueueApi(ports);
});

// These values must be captured before the source child selects its addon.
// Consume the six control variables as soon as the gateway adapter is loaded.
exposeHostApi('gatewayChild', () => {
  const net = require('node:net');
  const GATEWAY_PROTOCOL = 15;
  const MAX_HEADER_BYTES = 107, HEADER_TIMEOUT_MS = 5000;
  function isGatewayChild(env = process.env, ppid = process.ppid) {
    return String(env?.MULTICC_GATEWAY_CHILD || '').trim() === '1'
      && String(env?.MULTICC_GATEWAY_PID || '').trim() === String(ppid);
  }
  function capture(channel) {
    const prefix = 'MULTICC_GATEWAY_' + channel;
    const bootstrap = isGatewayChild() ? { port: Number(process.env[prefix + '_PORT']),
      capability: process.env[prefix + '_CAPABILITY'] || '' } : null;
    delete process.env[prefix + '_PORT'];
    delete process.env[prefix + '_CAPABILITY'];
    return bootstrap;
  }
  const auth = capture('AUTH'), source = capture('SOURCE'), chat = capture('CHAT');
  function applySourceAddonEnv(root, env = process.env) {
    if (isGatewayChild(env) && env.MULTICC_SOURCE_ROOT === root && env.MULTICC_DESKTOP !== '1') {
      env.MULTICC_RUST_ADDON = require(path.join(root, 'scripts', 'ensure-source-rust')).addonForSourceChild(root);
    }
    delete env.MULTICC_SOURCE_ROOT;
  }
  function connectAuthControl(owner) {
    if (!auth) return;
    owner.connectGateway(auth.port, auth.capability);
    auth.capability = '';
  }
  function connectWorkspaceControl(owner, directoryReader, contextReader, authSecurity) {
    if (!source) return;
    const args = [source.port, source.capability, directoryReader, contextReader];
    if (authSecurity) authSecurity.connectWorkspaceGateway(owner, ...args);
    else owner.connectGateway(...args);
    source.capability = '';
  }
  function startChatBridge({ wss, logger = console, bootstrap = chat,
    connect = module.exports.gatewayChatBridge.connectChatBridge } = {}) {
    return getNative().startGatewayChatBridge({ wss, logger, bootstrap, connect });
  }
  function raiseSigint(platform = process.platform) {
    if (platform === 'win32') process.emit('SIGINT', 'SIGINT');
    else process.kill(process.pid, 'SIGINT');
  }
  function watchGatewayLifeline({ env = process.env, stdin = process.stdin, logger = console,
    signal = () => raiseSigint(), hasHandler = () => process.listenerCount('SIGINT') > 0, retryMs = 1000 } = {}) {
    if (!isGatewayChild(env) || !stdin || stdin.isTTY) return false;
    const lost = getNative().gatewayLifeline({ logger, signal, hasHandler, retryMs });
    for (const name of ['end', 'close', 'error']) stdin.on(name, lost);
    stdin.resume();
    return true;
  }
  function listenBehindGateway(httpServer, { port, logger = console, headerTimeoutMs = HEADER_TIMEOUT_MS, onListening } = {}) {
    const host = '127.0.0.1';
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      logger.error('gateway_child_internal_port_invalid', { port });
      process.exit(1);
    }
    const sockets = new Set(), awaiting = new Set();
    let closing = false;
    const Reader = getNative().GatewayProxyReader;
    const listener = net.createServer({ pauseOnConnect: true }, socket => {
      const reader = new Reader();
      sockets.add(socket);
      awaiting.add(socket);
      const timer = setTimeout(() => socket.destroy(), headerTimeoutMs);
      timer.unref();
      socket.once('close', () => { clearTimeout(timer); sockets.delete(socket); awaiting.delete(socket); });
      socket.on('error', () => {});
      function onData(chunk) {
        const result = reader.feed(chunk, null);
        if (result === null) return;
        socket.removeListener('data', onData);
        clearTimeout(timer);
        if (!result) return socket.destroy();
        socket.pause();
        if (chunk.length > result.offset) socket.unshift(chunk.subarray(result.offset));
        for (const [name, value] of Object.entries(result.peer)) {
          Object.defineProperty(socket, name, { value, enumerable: true, configurable: true, writable: false });
        }
        awaiting.delete(socket);
        httpServer.emit('connection', socket);
        socket.resume();
      }
      socket.on('data', onData);
      socket.resume();
    });
    Object.defineProperty(httpServer, 'listening', { enumerable: true, configurable: true, get: () => listener.listening && !closing });
    httpServer.address = () => listener.address();
    httpServer.close = function close(callback) {
      const done = typeof callback === 'function' ? callback : () => {};
      if (closing) return void process.nextTick(done, Object.assign(new Error('Server is not running'), { code: 'ERR_SERVER_NOT_RUNNING' }));
      closing = true;
      for (const socket of awaiting) socket.destroy();
      if (!listener.listening) return void process.nextTick(done);
      listener.close(() => done());
      httpServer.closeIdleConnections?.();
    };
    listener.once('error', error => {
      logger.error('gateway_child_listen_failed', { host, port, error: error.message, code: error.code });
      process.exit(error.code === 'EADDRINUSE' ? 75 : 1);
    });
    listener.listen(port, host, () => {
      httpServer.emit('listening');
      logger.info('gateway_child_listening', { host, port, protocol: GATEWAY_PROTOCOL });
      if (typeof onListening === 'function') onListening();
    });
    return { listener, get port() { const address = listener.address(); return address && address.port; },
      close(callback) { httpServer.close(callback); }, connectionCount: () => sockets.size };
  }
  return { GATEWAY_PROTOCOL, applySourceAddonEnv, connectAuthControl, connectWorkspaceControl, startChatBridge,
    MAX_HEADER_BYTES, HEADER_TIMEOUT_MS, isGatewayChild,
    internalPort: (env = process.env) => getNative().gatewayInternalPort(String(env?.MULTICC_GATEWAY_INTERNAL_PORT || '').trim()) ?? null,
    parseProxyHeader: line => getNative().gatewayProxyPeer(line.toString('latin1')),
    listenBehindGateway, watchGatewayLifeline, raiseSigint };
});

exposeHostApi('migrationGate', () => {
  function startPage({ file, port, host, behindGateway = false }) {
    const signal = new SharedArrayBuffer(4), flag = new Int32Array(signal);
    let worker;
    try {
      const { Worker } = require('node:worker_threads');
      worker = new Worker(path.join(__dirname, '../task-shell/migration-page-worker.js'), {
        workerData: { signal, port, host: ['127.0.0.1', '::1', 'localhost'].includes(host) ? host : '127.0.0.1',
          behindGateway, progressFile: file + '.migration.json' },
      });
    } catch { return null; }
    worker.on('error', () => {});
    Atomics.wait(flag, 0, 0, 3000);
    if (Atomics.load(flag, 0) !== 1) { worker.terminate(); return null; }
    return { fail(failure) { worker.postMessage({ type: 'failure', failure }); }, stop() {
      worker.postMessage({ type: 'stop' }); Atomics.wait(flag, 0, 1, 3000); worker.unref();
    } };
  }
  function runTaskStoreMigrationGate({ file, port, host, addon, logger = console, openPage = startPage, sleep }) {
    const native = getNative();
    return native.taskMigrationGate({ file, port, host, addon, logger, openPage, sleep }, addon === native);
  }
  function runAtBoot(env = process.env) {
    const file = module.exports.appPaths.createPaths({ dataDir: env.MULTICC_DATA_DIR }).taskShellDbFile;
    return runTaskStoreMigrationGate({ file, addon: getNative(), openPage() {
      try {
        const { port, host } = getNetworkPolicy().resolveNetworkPolicy(env);
        const gateway = module.exports.gatewayChild;
        if (!gateway.isGatewayChild(env)) return startPage({ file, port, host });
        const internal = gateway.internalPort(env);
        return internal ? startPage({ file, port: internal, host: '127.0.0.1', behindGateway: true }) : null;
      } catch { return null; }
    } });
  }
  return { runTaskStoreMigrationGate, startPage, runAtBoot };
});

exposeHostApi('providerDefaults', () => getNative().providerDefaultsApi({ path, Owner: getNative().RustProviderDefaultsStore }));

let providerBindingPorts;
function getProviderBindingPorts() {
  if (providerBindingPorts) return providerBindingPorts;
  class ProviderBindingError extends Error {
    constructor(message, code = 'INVALID_PROVIDER_BINDING') { super(message); this.name = 'ProviderBindingError'; this.code = code; }
  }
  const SUPPORTED_CLIS = new Set(['claude', 'claude-exp', 'codex', 'codex-exp', 'opencode', 'zcode', 'qoder', 'kimi', 'codebuddy', 'dsh', 'gemini', 'grok', 'agy', 'commandcode', 'pi']);
  const ROLE_KINDS = new Set(['main', 'sub', 'aux']), AGENT_ROLES = new Set(['default', 'worker', 'explorer', 'custom']);
  return providerBindingPorts = { SUPPORTED_CLIS, ROLE_KINDS, AGENT_ROLES, ProviderBindingError, brand: Symbol('MultiCC.ProviderBinding') };
}
exposeHostApi('httpErrors', () => {
  const native = getNative();
  const { safeCode, sanitizeCompatibility, sanitizePublicText } = getPublicSafety();
  const domain = Symbol('MultiCC.DomainError');
  const infrastructure = Symbol('MultiCC.InfrastructureError');
  const http = Symbol('MultiCC.HttpError');
  function isDomainError(value) { return !!(value && value[domain] === true); }
  function isInfrastructureError(value) { return !!(value && value[infrastructure] === true); }
  function isHttpError(value) { return !!(value && value[http] === true); }
  class DomainError extends Error {
    constructor(kind, message, { code, publicMessage, compatibility, cause } = {}) {
      super(native.domainErrorMessage(message, false));
      native.domainErrorInitialize(this, kind, code, publicMessage, compatibility, cause);
      Object.defineProperty(this, domain, { value: true });
    }
  }
  class InfrastructureError extends Error {
    constructor(message, { code, compatibility, cause } = {}) {
      super(native.domainErrorMessage(message, true));
      native.infrastructureErrorInitialize(this, code, compatibility, cause);
      Object.defineProperty(this, infrastructure, { value: true });
    }
  }
  class HttpError extends Error {
    constructor({ status, code, message, compatibility, cause } = {}) {
      const normalized = native.httpErrorTrustedStatus(status);
      super(native.httpErrorMessage(normalized, message, sanitizePublicText));
      native.httpErrorInitialize(this, normalized, code, compatibility, cause, ports);
      Object.defineProperty(this, http, { value: true });
      Object.freeze(this);
    }
  }
  const ports = { HttpError, isHttpError, isDomainError, isInfrastructureError,
    safeCode, sanitizeCompatibility, sanitizePublicText };
  let kinds, definitions;
  function domainErrorMap() { return definitions ??= native.httpErrorDefinitions(ports); }
  const middleware = native.httpErrorsMiddleware({
    process, API_VERSION: getApiContract().API_VERSION,
    elapsedMs: start => Number(process.hrtime.bigint() - start) / 1e6,
  });
  return {
    HttpError, isHttpError,
    trustedStatus(value) { return native.httpErrorTrustedStatus(value); },
    mapError(error) { return native.httpErrorMap(error, ports, domainErrorMap()); },
    DomainError, InfrastructureError, isDomainError, isInfrastructureError,
    get DOMAIN_KINDS() { return kinds ??= native.domainErrorKinds(ports); },
    get DOMAIN_ERROR_MAP() { return domainErrorMap(); },
    ...middleware,
    makeRequestId() { return native.httpEntryMakeRequestId(); },
    cleanIncomingId(value) { return native.httpEntryCleanId(value); },
  };
});

exposeHostApi('airIndexPort', () => {
  const addon = getNative();
  return addon.airIndexHostApi({ getAddon: () => module.exports.getNative(),
    describe: addon.airDescribeIssue, record: addon.airRecordStorageNotice,
    uuid: require('node:crypto').randomUUID, createModel: module.exports.taskReadModel.createTaskReadModel });
});
exposeHostApi('airSyncRuntime', () => getNative().airSyncHostApi({
  createIndex: module.exports.airIndexPort.createAirIndex, describe: module.exports.airIndexPort.describeAirIssue,
}));

function addonWithMethod(name) {
  const addon = getNative();
  if (typeof addon[name] !== 'function') throw new Error('rust_backend_unavailable');
  return addon;
}
exposeHostApi('macosAgentProvision', () => addonWithMethod('macosAgentProvisionApi').macosAgentProvisionApi({
  fs: require('node:fs'), path, os: require('node:os'), spawn: require('node:child_process').spawn,
  platform: process.platform, env: process.env, logger: console,
}));

exposeHostApi('claudeEgress', () => getNative().claudeEgressHost({
  process, pluginsDir: path.resolve(__dirname, '../..', 'plugins'),
  pluginsFactory: () => module.exports.pluginsRoutes.createPluginsRoutes,
  proxyClass: () => require('proxy-agent').ProxyAgent,
}));
exposeHostApi('channelHost', () => getNative().channelHostApi({
  process, path, spawn: require('node:child_process').spawn,
}));
exposeHostApi('channelRegistry', () => getNative().channelRegistryApi({}));

exposeHostApi('pluginCatalog', () => getNative().pluginCatalogApi({
  process, crypto: require('node:crypto'), os: require('node:os'), path: require('node:path'),
  execFile: require('node:child_process').execFile, rootDir: path.resolve(__dirname, '../..'),
  version: require('../../package.json').version,
  agent: rootDir => module.exports.macosAgentProvision.sharedMacosAgentProvisioner({ rootDir }).inspect(),
}));
exposeHostApi('pluginInstaller', () => {
  class PluginInstallError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  return getNative().pluginInstallerApi({ process, PluginInstallError, crypto: require('node:crypto') });
});
exposeHostApi('pluginsRoutes', () => getNative().pluginsRoutesApi({
  process, catalog: module.exports.pluginCatalog, installer: module.exports.pluginInstaller,
  channel: module.exports.channelHost, registry: module.exports.channelRegistry,
  local: module.exports.requestLocality.isLocalRequest,
  fetch: (...args) => module.exports.outbound.outboundFetch(...args),
  spawn: require('node:child_process').spawn, path: require('node:path'),
}));

exposeHostApi('taskReadModel', () => {
  const addon = addonWithMethod('taskReadModelHostApi');
  return addon.taskReadModelHostApi({ addon, Owner: addon.RustTaskReadModel, runNative });
});

exposeHostApi('taskWorktree', () => getNative().taskWorktreeApi({ crypto: require('node:crypto'), existsSync: require('node:fs').existsSync }));

exposeHostApi('airCardCache', () => getNative().airCardCacheApi({ Owner: getNative().RustAirCardCache, runNative, boardStoreOf: module.exports.taskDomainHost.boardStoreOf }));

exposeHostApi('taskBoardStore', () => getNative().taskBoardStoreApi({ Owner: getNative().RustTaskBoard, domain: module.exports.taskDomainHost, wireDate: module.exports.taskPlanning.wireDate, compare: (a, b) => a.localeCompare(b), runNative, nativeCode }));

exposeHostApi('zcodeAuth', () => getNative().zcodeAuthHost({
  process, path, fs: require('node:fs'), homedir: require('node:os').homedir,
  spawn: require('node:child_process').spawn, reportFailure: module.exports.stateStore.reportFailure,
}));

exposeHostApi('kimiAuth', () => getNative().kimiAuthHost({
  process, path, homedir: require('node:os').homedir,
  spawn: require('node:child_process').spawn, findExecutableOnPath: module.exports.cliCommands.findExecutableOnPath,
}));

// Adapt the Node process callback to the outcome consumed by the native refresh ladder.
exposeHostApi('claudeOAuthRefresh', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { execFile } = require('node:child_process');
  return getNative().claudeOauthRefreshHost({
    process, tmpdir: os.tmpdir, defaultFile: () => path.join(os.homedir(), '.claude', '.credentials.json'),
    defaultRead: file => fs.promises.readFile(file, 'utf8'),
    buildChildEnv: module.exports.providersHost.buildChildEnv,
    defaultRun(file, args, { timeoutMs, cwd, env }) {
      return new Promise(resolve => {
        execFile(file, args, { cwd, env, timeout: timeoutMs, killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
          resolve({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
            stdout: String(stdout || ''), stderr: String(stderr || ''),
            timedOut: !!error?.killed, error: error?.message ?? null });
        });
      });
    },
  });
});

exposeHostApi('codexOAuthRefresh', () => getNative().codexOauthRefreshHost({
  process, path, fs: require('node:fs'), os: require('node:os'),
  providerPorts: () => module.exports.providersHost, execFile: require('node:child_process').execFile,
}));

exposeHostApi('codexImageBridge', () => {
  class ImageBridgeError extends Error {
    constructor(code, message = 'image generation is unavailable') {
      super(message);
      this.name = 'ImageBridgeError';
      this.code = code;
    }
  }
  return getNative().codexImageBridgeHost({
    ImageBridgeError, process, path, fs: require('node:fs'), crypto: require('node:crypto'),
    spawn: require('node:child_process').spawn, tmpdir: require('node:os').tmpdir,
  });
});

exposeHostApi('airRoutesHost', () => getNative().airRoutesHostApi({
  domain: module.exports.taskDomainHost, boardCore: module.exports.taskBoardCore,
  cache: module.exports.airCardCache, abnormal: module.exports.classifyVocab.isAbnormalLetter,
  createSync: options => module.exports.airSyncRuntime.createAirSyncRuntime(options),
  deliveryView: module.exports.deliveryView, local: module.exports.requestLocality.isLocalRequest,
  path: require('node:path'), crypto: require('node:crypto'), process,
}));

exposeHostApi('usageObserved', () => {
  class UsageObservedError extends Error {
    constructor(message, code = 'INVALID_USAGE_OBSERVED') {
      super(message);
      this.name = 'UsageObservedError';
      this.code = code;
    }
  }
  return getNative().usageObservedApi({ binding: getProviderBindingPorts(), UsageObservedError });
});
exposeHostApi('providerBinding', () => {
  const ports = getProviderBindingPorts();
  const { SUPPORTED_CLIS, ROLE_KINDS, AGENT_ROLES, ProviderBindingError } = ports;
  let api;
  const methods = () => api ??= getNative().providerBindingMethods(ports);
  return { AGENT_ROLES, ROLE_KINDS, SUPPORTED_CLIS, ProviderBindingError,
    assertProviderBinding: value => methods().assertProviderBinding(value),
    createProviderBinding: value => methods().createProviderBinding(value),
    isProviderBinding: value => methods().isProviderBinding(value),
    toLegacyProviderView: value => methods().toLegacyProviderView(value),
  };
});
exposeHostApi('providerError', () => {
  function errorFields(raw, depth = 0, budget = { nodes: 24, chars: 65536 }) {
    return getNative().providerErrorFields(raw, depth, budget);
  }
  function classifyProviderError(raw, { provider, source } = {}) {
    if (provider !== 'opencode') return null;
    try { return JSON.parse(getNative().classifyProviderError(JSON.stringify({ provider, source, error: errorFields(raw) }))); }
    catch { return null; }
  }
  return { errorFields, classifyProviderError };
});

exposeHostApi('secretAudit', () => {
  const { AsyncLocalStorage } = require('node:async_hooks');
  const scope = new AsyncLocalStorage();
  const ports = { scope, auditFile: () => module.exports.appPaths.createPaths().secretAuditFile };
  return {
    call(operation, context, names, action) {
      let native;
      try { native = getNative(); } catch {
        throw Object.assign(new Error('Secret audit is unavailable; vault access cannot continue.'),
          { code: 'secret_audit_unavailable', statusCode: 503, secretToolError: true });
      }
      return native.auditedSecretCall(ports, operation, context, names, action);
    },
    withContext: (context, action) => scope.run({ ...scope.getStore(), ...context }, action),
  };
});

exposeHostApi('stateOwner', () => {
  const origins = new WeakMap();
  function createStateOwner() {
    const addon = getNative();
    if (typeof addon.RustSessionRecords !== 'function') throw new Error('rust_session_records_unavailable');
    const anchor = Object.create(null), native = new addon.RustSessionRecords(anchor);
    Object.defineProperty(native, Symbol('host-value-anchor'), { value: anchor });
    origins.set(native, addon);
    const api = addon.recordOwnerFacade({ native, anchor, error: module.exports.directoryRecords.corruptedStateError });
    const configure = api.configure;
    api.configure = function (options) { configure(options); return this; };
    return api;
  }
  return { createTurnRuntimeStore(options = {}) {
    const addon = getNative(); return addon.turnRuntimeStore(options, createStateOwner, origins, addon);
  }, createStateOwner };
});
exposeHostApi('wsHost', () => {
  function createWsHost() {
    const anchor = { stringifyWithFields: (value, fields) => JSON.stringify({ ...value, ...fields }) };
    const host = new (getNative().RustWsHost)(anchor);
    Object.defineProperty(host, Symbol('ws host anchor'), { value: anchor });
    return host;
  }
  return { createWsHost, createChatReplayHub: ({ host }) => getNative().replayHub(host),
    createChatReplayRuntime: sessions => getNative().chatReplayRuntime(createWsHost(), sessions) };
});

exposeHostApi('orchestrationJson', () => {
  class OrchestrationStoreCorruptError extends Error {
    constructor(message, meta = {}) {
      super(message);
      this.name = 'OrchestrationStoreCorruptError';
      this.code = 'ORCHESTRATION_STORE_CORRUPT';
      Object.assign(this, meta);
    }
  }
  // Preserve the AsyncFunction surface for mutating callers.
  const asyncMethods = store => ({
    async mutate(mutator) { return store.mutate(mutator); },
    async mutateIf(predicate, mutator, skippedResult) { return store.mutateIf(predicate, mutator, skippedResult); },
  });
  const publicStore = store => getNative().publicOrchestrationStore(store, asyncMethods);
  const ports = orchestrationJsonPorts(createOrchestrationStore, { fs: require('node:fs'), path, publicStore, CorruptError: OrchestrationStoreCorruptError });
  let api;
  const native = () => api ??= getNative().orchestrationJsonApi(ports);
  function createOrchestrationStore(options = {}) { return publicStore(native().createOrchestrationStore(options)); }
  return { SCHEMA_VERSION: 3, OrchestrationStoreCorruptError, createOrchestrationStore,
    _cloneJson: value => native()._cloneJson(value), _deepFreeze: value => native()._deepFreeze(value),
    _initialState: () => native()._initialState(), _loadState: options => native()._loadState(options),
    _validateState: (input, file) => native()._validateState(input, file), _writeAtomic: options => native()._writeAtomic(options),
  };
});

exposeHostApi('orchestrationSqlite', () => {
  class OrchestrationSqliteError extends Error {
    constructor(message, meta = {}) {
      super(message);
      this.name = 'OrchestrationSqliteError';
      this.code = 'ORCHESTRATION_SQLITE_ERROR';
      Object.assign(this, meta);
    }
  }

  class OrchestrationSqliteConflictError extends OrchestrationSqliteError {
    constructor(file, expectedRevision, actualRevision) {
      super(
        `orchestration SQLite revision changed concurrently in ${file} (expected ${expectedRevision}, found ${actualRevision})`,
        { file, expectedRevision, actualRevision },
      );
      this.name = 'OrchestrationSqliteConflictError';
      this.code = 'ORCHESTRATION_SQLITE_CONFLICT';
      this.retryable = true;
    }
  }
  function createOrchestrationSqliteStore(options = {}) {
    const { OrchestrationStoreCorruptError, _cloneJson: cloneJson, _deepFreeze: deepFreeze } = module.exports.orchestrationJson;
    const { createDraft, COLLECTIONS } = module.exports.orchestrationDraft;
    return getNative().createSqliteHostStore(options, { createDraft, COLLECTIONS, cloneJson, deepFreeze, OrchestrationStoreCorruptError,
      OrchestrationSqliteError, OrchestrationSqliteConflictError, createNativeStore: module.exports.orchestrationNativeStore.createNativeStore });
  }
  return { DATABASE_SCHEMA_VERSION: 2, OrchestrationSqliteConflictError, OrchestrationSqliteError, createOrchestrationSqliteStore };
});

exposeHostApi('taskDomainHost', () => getNative().liveTaskDomainHost({
  environment: process.env,
  // Let V8 project caller-owned properties and raise its own destructuring errors.
  planAttributionAction({ mode, relation, targetTaskId, currentTaskId } = {}) {
    return getNative().planHostAttributionAction(mode, relation, targetTaskId, currentTaskId);
  },
  createStore: options => module.exports.stateStore.createStore(options),
  defaultFile: key => module.exports.appPaths.createPaths()[key],
  readText: file => require('node:fs').readFileSync(file, 'utf8'),
  async runQueuedDomain(input) {
    try { return JSON.parse(await runNative(() => getNative().taskDomainAsync(input))); }
    catch (error) { throw nativeCode(error); }
  },
}));

exposeHostApi('stateStore', () => {
  class CorruptedStateError extends Error {
    constructor(message, meta) {
      super(message);
      this.name = 'CorruptedStateError';
      Object.assign(this, meta || {});
    }
  }
  const fs = require('node:fs');
  return getNative().stateStoreHost({ fs, path, CorruptedStateError });
});

exposeHostApi('runtimeSecurity', () => {
  const fs = require('node:fs');
  const store = module.exports.stateStore;
  function write(file, body, options = {}) {
    const opts = { mode: 0o600, dirMode: 0o700, ...options };
    // StateStore supports live beforeRename hooks and Node-specific fs argument
    // validation. Ordinary string writes use Rust's durable replacement.
    if (typeof file !== 'string' || typeof body !== 'string' || typeof opts.beforeRename === 'function'
      || opts.enforceDirMode || !Number.isInteger(opts.mode) || !Number.isInteger(opts.dirMode)) {
      return store.writeTextAtomic(file, body, opts);
    }
    getNative().runtimeAtomicText(file, body, opts.mode, opts.dirMode, store.reportFailure);
  }
  return {
    ensurePrivateDir(dir) {
      if (typeof dir === 'string') return getNative().runtimePrivatePath(dir, true);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    },
    secureFile(file) {
      if (typeof file === 'string') return getNative().runtimePrivatePath(file, false);
      try { fs.chmodSync(file, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    secureRuntimeData: paths => getNative().secureRuntimePaths(paths),
    atomicWriteJson: (file, value, options) => write(file, JSON.stringify(value, null, 2), options),
    atomicWriteText: (file, value, options) => write(file, String(value), options),
  };
});

exposeHostApi('hostEnv', () => getNative().hostEnvApi({
  environment: process.env, reportFailure: module.exports.stateStore.reportFailure,
  envPath: () => process.env.MULTICC_ENV_FILE ? path.resolve(process.env.MULTICC_ENV_FILE) : path.resolve(__dirname, '../..', '.env'),
}));

exposeHostApi('refreshHealth', () => ({
  KEY_PATTERN: /^[a-z0-9_-]{1,64}$/i,
  createRefreshHealthStore: options => getNative().refreshHealthStore(options, { path, reportFailure: module.exports.stateStore.reportFailure }),
}));

exposeHostApi('taskDistill', () => {
  const fs = require('node:fs');
  return {
    AUTO_SECTION: '## 自动蒸馏', DEFAULT_MAX_AUTO_LINES: 24,
    cleanMemoryCandidate: value => getNative().cleanTaskMemory(String(value ?? '')),
    similar: (a, b) => getNative().similarTaskMemory(String(a || '').trim(), String(b || '').trim()),
    mergeAutoSection: (content, candidate, { maxAutoLines = 24 } = {}) =>
      getNative().mergeTaskMemory(String(content || '').trim(), `- ${candidate}`, () => String(candidate || ''), () => +(-maxAutoLines)),
    createTaskMemoryDistiller(deps) {
      const max = Number.isInteger(deps.maxAutoLines) && deps.maxAutoLines > 0 ? deps.maxAutoLines : 24;
      return { record: getNative().taskMemoryRecorder({ deps, max, path: deps.path || path,
        fs: deps.fs && deps.fs !== fs ? deps.fs : undefined, logger: deps.logger || console }) };
    },
  };
});

// The control task holds a weak JS callback. Keep the runtime and its owner
// visible to V8 so metadata may refer to the facade without rooting a cycle.
function authTicketReader(anchor) {
  const weak = new WeakRef(anchor);
  return (_error, slot) => {
    const slots = weak.deref()?.slots;
    if (!slots || !Object.hasOwn(slots, slot)) return null;
    const value = slots[slot];
    delete slots[slot];
    return getNative().authTicketProjection(value);
  };
}
exposeHostApi('authSecurity', () => ({
  COOKIE_VERSION: 1, DEFAULT_COOKIE_TTL_MS: 30 * 86400000, DEFAULT_TICKET_TTL_MS: 30000,
  createAuthSecurity(options) {
    const anchor = {};
    const runtime = new (getNative().RustAuthSecurity)(options, anchor);
    Object.defineProperty(runtime, Symbol('auth host references'), { value: anchor });
    return {
      accessToken: runtime.accessToken.bind(runtime), setAccessToken: runtime.setAccessToken.bind(runtime),
      shuttingDown: runtime.shuttingDown.bind(runtime), setShuttingDown: runtime.setShuttingDown.bind(runtime),
      connectGateway: (port, capability) => runtime.connectGateway(port, capability, authTicketReader(anchor)),
      connectWorkspaceGateway: (owner, ...args) => owner.connectGateway(...args, runtime),
      createCookie: runtime.createCookie.bind(runtime), verifyCookie: runtime.verifyCookie.bind(runtime),
      verifyAccessToken: runtime.verifyAccessToken.bind(runtime), issueWsTicket: (p, metadata) => runtime.issueWsTicket(p, metadata),
      consumeWsTicket: (ticket, p) => runtime.consumeWsTicket(ticket, p), pruneTickets: runtime.pruneTickets.bind(runtime),
      ticketCount: runtime.ticketCount.bind(runtime),
    };
  },
  timingSafeEqualText: (a,b) => getNative().authTimingSafeEqualText(a,b),
  normalizeRedirect: (v, fallback) => getNative().authNormalizeRedirect(v, fallback),
  normalizeWsPath: v => getNative().authNormalizeWsPath(v),
  escapeHtmlAttribute: v => getNative().authEscapeHtmlAttribute(v),
}));

exposeHostApi('globalProxy', () => {
  const network = module.exports.outbound;
  const http = require('node:http'), https = require('node:https');
  return getNative().globalProxyApi({ ...module.exports.proxyPolicy,
    outbound: options => Object.keys(options).length ? network.createOutbound(options) : network,
    log: message => console.log(`[multicc] ${message}`),
    agents: () => ({ fetch: globalThis.fetch, http: http.globalAgent, https: https.globalAgent }),
    installAgents(shared) {
      globalThis.fetch = shared.outboundFetch;
      http.globalAgent = https.globalAgent = shared.outboundAgent;
    },
    restoreAgents(shared, previous) {
      if (globalThis.fetch === shared.outboundFetch) globalThis.fetch = previous.fetch;
      if (http.globalAgent === shared.outboundAgent) http.globalAgent = previous.http;
      if (https.globalAgent === shared.outboundAgent) https.globalAgent = previous.https;
    },
  });
});

exposeHostApi('jsonCompression', () => {
  const zlib = require('node:zlib');
  function createJsonCompression({ minBytes = 1024, level = zlib.constants.Z_DEFAULT_COMPRESSION } = {}) {
    return getNative().jsonCompressionMiddleware({
      get: (res, key) => res.getHeader(key), set: (res, key, value) => res.setHeader(key, value),
      below200: value => value < 200,
      largeEnough: (chunk, enc) => (Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), enc || 'utf8')) >= minBytes,
      buffer: (chunk, enc) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), enc || 'utf8'),
      gzip: (body, done) => zlib.gzip(body, { level }, done),
    });
  }
  return { DEFAULT_MIN_BYTES: 1024, createJsonCompression, jsonCompression: createJsonCompression() };
});

function defaultCodexAuth() { return path.join(require('node:os').homedir(), '.codex', 'auth.json'); }
// The addon owns quota policy and per-instance state. These ports keep injected
// JavaScript stores, transports, and timers in the isolate that supplied them.
exposeHostApi('usageLimitWiring', () => ({
  createUsageLimitWiring: ({ persistedSessions, providers, chatBroadcast, createPoller, recordLimit }) => getNative().usageLimitWiring({
    persistedSessions, providers, chatBroadcast, createPoller, recordLimit,
    now: () => Date.now(), queue: module.exports.claudeUsageQueue,
    live: module.exports.claudeBarState, view: getQuotaBarView() }),
}));
exposeHostApi('claudeBarState', () => getNative().claudeBarState({
  now: () => Date.now(), queue: module.exports.claudeUsageQueue,
  merge: input => claudeQuota('merge', input), claudeBar: getQuotaBarView().claudeBar,
}));
exposeHostApi('quotaBarCache', () => ({
  ...getNative().quotaBarCacheApi({}),
  createQuotaBarCache({ file, now = Date.now, storeFactory = module.exports.stateStore.createStore, logger = console } = {}) {
    if (!file || typeof file !== 'string') throw new TypeError('[quota-bar-cache] requires { file }');
    const store = storeFactory({ file, kind: 'quota-bar-cache', schemaVersion: 1, legacyIsArray: false });
    return getNative().quotaBarCacheStore({ file, now,
      load: () => store.loadOrRecover(),
      loadFailed: error => logger?.warn?.('[multicc/quota-bar-cache] load failed:', error.message),
      save(state) { try { store.save(state); } catch (error) { logger?.warn?.('[multicc/quota-bar-cache] save failed:', error.message); } },
    });
  },
}));
exposeHostApi('limitRecorder', () => {
  const native = getNative();
  return { ...native.limitCacheRecorderRequestValue('constants', {}),
    isRevokedCategory: category => native.limitCacheRecorderRequestValue('isRevokedCategory', { category }),
    createLimitRecorder: ({ cache, persistedSessions, providers, now = Date.now } = {}) =>
      native.limitRecorderHost({ cache, persistedSessions, providers, now }),
  };
});
exposeHostApi('providerLimitCache', () => {
  function createNativeProviderLimitCache({ file, legacyJsonFile = null, now = Date.now, onRecord = null, logger = console } = {}) {
    return getNative().providerCacheHost({ file, legacyJsonFile, now, onRecord, logger, Owner: getNative().RustProviderLimitStore,
      submit: (handle, op, input) => runNative(() => handle.requestAsync(op, input)),
    });
  }
  return { createNativeProviderLimitCache, createProviderLimitCache: createNativeProviderLimitCache,
    STALE_MS_DEFAULT: 600000, DATABASE_SCHEMA_VERSION: 1 };
});
exposeHostApi('quotaHistory', () => {
  const DEFAULT_RETENTION_MS = 14 * 86400000;
  function createProviderQuotaHistory({ file, native, retentionMs = DEFAULT_RETENTION_MS, logger = console } = {}) {
    return getNative().quotaHistoryHost({ file, retentionMs, logger, now: () => Date.now(), native: native || getNative(),
      submit: (handle, data) => runNative(() => handle.record(JSON.stringify(data))),
    });
  }
  return { DEFAULT_RETENTION_MS, createProviderQuotaHistory };
});
exposeHostApi('quotaGuard', () => {
  const native = getNative(), request = native.quotaGuardRequestValue;
  const DEFAULTS = Object.freeze(request('defaults', null));
  return { DEFAULTS, envConfig: (env = process.env) => request('envConfig', env),
    normalizeConfig: raw => Object.freeze(request('normalizeConfig', raw)),
    liveWindows: entry => request('liveWindows', entry), readingAgeOf: value => request('readingAgeOf', value),
    windowKind: value => request('windowKind', value), thresholdFor: (kind, config) => request('thresholdFor', { kind, config }),
    guardVerdict: (entry, { config = DEFAULTS, now = Date.now() } = {}) => Object.freeze(request('guardVerdict', { entry, config, now })),
    createQuotaGuard: ({ cache, configFile, env = process.env, now = Date.now, logger, onStale } = {}) =>
      native.quotaGuardHost({ Owner: native.RustQuotaGuard, request, cache, configFile, env, now, logger, onStale }),
  };
});
exposeHostApi('claudeCliUsage', () => getNative().cliUsageHost({
  credentials: providerCredentials, platform: process.platform,
  file: path.join(require('node:os').homedir(), '.claude', '.credentials.json'),
  readFile: file => require('node:fs/promises').readFile(file, 'utf8'), now: () => Date.now(),
  outboundFetch: module.exports.outbound.outboundFetch, fetchUsage: module.exports.claudeOfficialOAuth.fetchUsage,
}));
exposeHostApi('officialUsage', () => ({
  claudeUsageWindows: usage => getNative().officialUsageWindows(usage, false),
  codexDtoWindows: dto => getNative().officialUsageWindows(dto, true),
  createOfficialAccountUsageSweeper: ({ accounts, recorder, logger = console, now = Date.now, intervalMs = 600000,
    pollCodex = module.exports.usageLimitPoller.pollCodexUsage } = {}) => getNative().officialUsageSweeper({
    accounts, recorder, logger, now, intervalMs, pollCodex, authFile: dir => path.join(dir, 'auth.json'),
    accountProviderId: module.exports.officialCatalog.accountProviderId,
  }),
}));
exposeHostApi('virtualProvider', () => getNative().virtualProviderHost({
  now: () => Date.now(), subscriptions: module.exports.accountSubscriptionCache,
  egress: provider => module.exports.egressIpPolicy.checkEgressIpAllowed(provider),
  listProviders: () => module.exports.providersHost.listProviders(),
  routingView: (appType, id) => module.exports.providersHost.routingProviderView(appType, id),
}));

exposeHostApi('providerQuota', () => ({
  createProviderQuotaRuntime: options => getNative().providerQuotaRuntime(options, {
    history: module.exports.quotaHistory.createProviderQuotaHistory,
    limitCache: module.exports.providerLimitCache.createNativeProviderLimitCache,
    recorder: module.exports.limitRecorder.createLimitRecorder,
    connect: module.exports.connectProviderLimitSync, barCache: module.exports.quotaBarCache.createQuotaBarCache,
    guard: module.exports.quotaGuard.createQuotaGuard,
    subscriptions: opts => module.exports.accountSubscriptionCache.configure(opts),
    virtualProvider: opts => module.exports.virtualProvider.configure(opts),
  }),
}));
exposeHostApi('quotaSelfHeal', () => getNative().quotaSelfHealApi({
  defaultCodexAuth,
  setCodexAuthRefresher: fn => module.exports.usageLimitPoller.setCodexAuthRefresher(fn),
  setVirtualRefresher: fn => module.exports.virtualProvider.setRefresher(fn),
}));

exposeHostApi('accountReader', () => {
  const native = getNative();
  const { policy } = module.exports.outbound;
  // HTTP policy and parsing belong to the native query. AbortSignal and the
  // injected fetch/Response pair must be created in the caller's JS realm.
  async function query(input, { fetch } = {}) {
    const { mode, result, plan, request, timeout } = JSON.parse(await native.accountSubscriptionStart(JSON.stringify(input), !!fetch));
    if (mode === 'done') return result;
    if (mode === 'proxy') {
      plan.proxyUrl = await policy.proxyForUrl(plan.url) || null;
      return JSON.parse(await native.queryAccountSubscription(JSON.stringify(plan)));
    }
    let status = 0, body = null;
    try {
      const response = await fetch(plan.url, { ...request, signal: AbortSignal.timeout(timeout) });
      status = response.status;
      if (response.ok) body = await response.json();
    } catch { status = 0; }
    return JSON.parse(native.accountSubscriptionResult(JSON.stringify({ plan, status, body, now: Date.now() })));
  }
  return native.accountReaderApi({ defaultCodexAuth, query, cache: module.exports.accountSubscriptionCache,
    readCliCredentials: () => module.exports.claudeCliUsage.readCliCredentials() });
});

exposeHostApi('artifacts', () => getNative().artifactCleanupApi({
  artifactsDir: module.exports.appPaths.createPaths({ dataDir: process.env.MULTICC_DATA_DIR }).artifactsDir,
  environment: process.env, path, fs: require('node:fs'), home: require('node:os').homedir(),
}));

exposeHostApi('roleTokenTracker', () => {
  const native = getNative();
  const { validateUsageObserved } = module.exports.usageObserved;
  // Legacy token buckets and Date-like inputs use V8's additive coercion.
  const add = (a, b) => a + b;
  const ports = { add, path, fs: require('node:fs'), now: () => new Date(),
    reportFailure: module.exports.stateStore.reportFailure,
    onError: err => console.error(`[multicc] role token tracker: ${err.message}`) };
  return {
    emptyBucket: native.emptyRoleTokenBucket, hasUsage: native.roleBucketHasUsage,
    addUsage: (bucket, usage) => native.accumulateRoleBucket(bucket, usage, add),
    localDayKey: date => native.roleLocalDay(date, add),
    usageObservedToRoleTokenInfo: value => native.roleObservedInfo(validateUsageObserved(value)),
    createRoleTokenTracker(options) {
      const api = native.createRoleTokenRuntime(options, ports);
      const ingest = api.accumulateObserved;
      api.accumulateObserved = value => ingest(validateUsageObserved(value));
      return api;
    },
  };
});

exposeHostApi('officialImageBridgeRuntime', () => {
  const { createOfficialImageBridge } = module.exports.codexImageBridge;
  const host = { home: require('node:os').homedir, path,
    officialId: module.exports.officialAccounts.officialAccountIdFromProvider };
  return { createOfficialImageBridgeRuntime: options =>
    createOfficialImageBridge(getNative().officialImageBridgePorts(options, host)) };
});

exposeHostApi('macosPower', () => getNative().macosPowerApi({
  platform: process.platform, fs: require('node:fs'), DomainError: module.exports.httpErrors.DomainError,
  installer: path.resolve(__dirname, '../../scripts/install-powerd.sh'),
  username: () => require('node:os').userInfo().username,
  executeInjected: (run, file, args, options) => new Promise((resolve, reject) => {
    run(file, args, options, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error); }
      else resolve(stdout);
    });
  }),
}));

exposeHostApi('appPaths', () => getNative().appPathsPublicApi({
  fs: require('node:fs'), os: require('node:os'), path, process, pkgRoot: path.resolve(__dirname, '../..'),
}, pathSafety));

// V8 owns the Map prototype and the iterators returned to JavaScript. The
// native record owner keeps all membership, insertion order and live values.
function recordMapPrototype(prefix, ownerOf) {
  const method = name => prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name;
  const size = method('size'), get = method('get'), set = method('set');
  const has = method('has'), remove = method('delete'), clear = method('clear');
  const snapshot = prefix ? method('entries') : 'entriesSnapshot';
  const entries = map => ownerOf(map)[snapshot]();
  return class extends Map {
    get size() { return ownerOf(this)[size](); }
    get(key) { return ownerOf(this)[get](key); }
    set(key, value) { ownerOf(this)[set](key, value); return this; }
    has(key) { return ownerOf(this)[has](key); }
    delete(key) { return ownerOf(this)[remove](key); }
    clear() { ownerOf(this)[clear](); }
    keys() { return entries(this).map(pair => pair[0])[Symbol.iterator](); }
    values() { return entries(this).map(pair => pair[1])[Symbol.iterator](); }
    entries() { return entries(this)[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    forEach(callback, thisArg) {
      for (const [key, value] of entries(this)) callback.call(thisArg, value, key, this);
    }
  };
}

exposeHostApi('memoryRuntime', () => getNative().sessionMemoryRuntimeApi({}));
exposeHostApi('memoryBrowser', () => getNative().memoryBrowserApi({}));

exposeHostApi('docsRegistry', () => getNative().docsRegistryApi({
  STORE: module.exports.appPaths.createPaths({ dataDir: process.env.MULTICC_DATA_DIR }).docsRegistryFile,
  servedRoots: () => module.exports.artifacts.servedRoots(),
  reportFailure: module.exports.stateStore.reportFailure,
}));

exposeHostApi('workspaceNotes', () => getNative().workspaceNotesApi());

exposeHostApi('docsMemoryHost', () => getNative().docsMemoryHostApi({
  docs: () => module.exports.docsRegistry,
  isLocalRequest: module.exports.requestLocality.isLocalRequest,
  mapError: module.exports.httpErrors.mapError,
}));

let folderMemoryApis;
function getFolderMemoryApis() {
  const fs = require('node:fs');
  return folderMemoryApis ??= getNative().folderMemoryApis({
    fs, path, rename: fs.renameSync, skills: path.resolve(__dirname, '../../skills'),
  });
}
for (const key of ['curatedMemoryStore', 'builtinMemoryRules', 'memoryRetrievalHost', 'folderMemoryService']) {
  exposeHostApi(key, () => getFolderMemoryApis()[key]);
}

exposeHostApi('sessionMemoryRoutes', () => {
  const native = getNative();
  return {
    assertDependencies(deps) { return native.assertSessionMemoryDependencies(deps); },
    mountSessionMemoryRoutes(app, deps) { return native.mountSessionMemoryRoutes(app, deps); },
  };
});

exposeHostApi('sessionRecordsHost', () => {
  const slots = new WeakMap();
  const sessionRecordsOwner = records => slots.get(records)?.native || null;
  class SessionRecordMap extends recordMapPrototype('', sessionRecordsOwner) {
    constructor(shared) { super(); slots.set(this, shared); }
    listByDir(dirId) { return sessionRecordsOwner(this).listByDir(dirId); }
  }
  return getNative().sessionTableHost({ SessionRecordMap, ownerOf: sessionRecordsOwner,
    payload: module.exports.taskStatePayload, emit: bus => (event, ...args) => bus.emit(event, ...args) });
});

exposeHostApi('chatSessions', () => {
  const slots = new WeakMap();
  const chatSessionsOwner = map => slots.get(map)?.native ?? null;
  class ChatSessionMap extends recordMapPrototype('chat', map => {
    const owner = chatSessionsOwner(map);
    if (!owner) throw new TypeError('chat session owner is required');
    return owner;
  }) {
    constructor(shared) {
      super();
      slots.set(this, getNative().newChatTableSlot(shared));
    }
    delete(key) {
      return getNative().chatTableAfterDelete(slots.get(this), key, super.delete(key));
    }
    clear() {
      const keys = [...super.keys()];
      super.clear();
      getNative().chatTableAfterClear(slots.get(this), keys);
    }
    setForgetHook(fn) { getNative().chatTableHook(slots.get(this), fn, false); return this; }
    onForget(fn) { getNative().chatTableHook(slots.get(this), fn, true); return this; }
  }
  return { ChatSessionMap, createChatSessions: shared => new ChatSessionMap(shared), chatSessionsOwner,
    get createChatReplayRuntime() { return module.exports.wsHost.createChatReplayRuntime; } };
});

exposeHostApi('directoryRecords', () => {
  const slots = new WeakMap();
  const directoryOwner = map => slots.get(map)?.native || null;
  class DirectoryMap extends recordMapPrototype('directory', map => {
    const owner = directoryOwner(map);
    if (!owner) throw new TypeError('directory table owner is required');
    return owner;
  }) {
    constructor(shared) { super(); slots.set(this, shared); }
  }
  function createDirectoryTable(shared) {
    if (typeof shared?.native?.directoryEntries !== 'function') {
      throw new TypeError('directory table requires the native state owner');
    }
    return new DirectoryMap(shared);
  }
  function corruptedStateError(file, result) {
    return getNative().stateRecordError(module.exports.stateStore.CorruptedStateError, file, result);
  }
  function loadDirectories(shared, file) {
    if (!shared?.native) throw new TypeError('state owner is required');
    const result = shared.native.loadDirectories();
    if (result.errorKind) throw corruptedStateError(file, result);
    return result;
  }
  return { DirectoryMap, createDirectoryTable, directoryOwner, corruptedStateError, loadDirectories };
});

exposeHostApi('relayShares', () => getNative().relayShareApi(globalThis));

exposeHostApi('requestLocality', () => getNative().requestLocalityApi(getNative()));

// V8 owns the injected comparison operators and the public async Promise.
exposeHostApi('processProbe', () => {
  const native = getNative();
  const { DEFAULT_ROLLOUT_WINDOW_MS, DEFAULT_OUTBOUND_TTL_MS } = native;
  function api({ outboundHttps, rolloutGrew }) {
    async function probe(pid, rolloutPath) {
      const [hasOutboundConnection, rolloutGrowing] = await Promise.all([
        outboundHttps(pid).catch(() => false),
        Promise.resolve().then(() => rolloutGrew(rolloutPath)).catch(() => false),
      ]);
      return { hasOutboundConnection, rolloutGrowing, pid: pid || null };
    }
    return { probe, outboundHttps, rolloutGrew };
  }
  function createProcessProbe({ execFile, statMtimeMs, now = Date.now,
    rolloutWindowMs = DEFAULT_ROLLOUT_WINDOW_MS, outboundTtlMs = DEFAULT_OUTBOUND_TTL_MS } = {}) {
    return api(native.processProbeRuntime({ execFile, statMtimeMs, now: () => now(),
      fresh: (at, prev) => at - prev <= outboundTtlMs, expired: (at, prev) => at - prev > outboundTtlMs,
      recent: mtime => now() - mtime <= rolloutWindowMs, advanced: (mtime, prev) => mtime > prev,
    }, false));
  }
  return { createProcessProbe, createSystemProcessProbe: () => api(native.processProbeRuntime({}, true)),
    DEFAULT_ROLLOUT_WINDOW_MS, DEFAULT_OUTBOUND_TTL_MS };
});

exposeHostApi('cliResultCompletion', () => getNative().cliResultApi(getNative()));

exposeHostApi('cliCompletion', () => getNative().cliCompletionApi(getNative()));

// V8's relational operators preserve coercion of legacy threshold values.
exposeHostApi('batteryGuard', () => getNative().batteryGuardApi({
  platform: process.platform, ge: (a, b) => a >= b, le: (a, b) => a <= b, gt: (a, b) => a > b,
}));

exposeHostApi('codexAccountsRefresh', () => {
  const { createCodexOAuthRefresher, stripOpenAiEnv } = module.exports.codexOAuthRefresh;
  return getNative().codexAccountRefreshApi({
    process, createCodexOAuthRefresher, stripOpenAiEnv, quietLogger: { info() {}, warn() {}, error() {} },
  });
});

exposeHostApi('dispatchProgress', () => getNative().dispatchProgressApi({}));

exposeHostApi('cliCapability', () => {
  const native = getNative();
  const catalog = native.cliCatalogViews();
  const fs = require('node:fs');
  const resolve = require('node:module').createRequire(path.resolve(__dirname, '../cli/package.json')).resolve;
  function bundledClaudeCodeBinary() {
    return native.cliBundledClaudeBinary(process.env.MULTICC_CLAUDE_BIN, process.platform,
      process.arch, resolve, path, fs.existsSync);
  }
  async function watchEffortCatalog(file) {
    const reload = () => native.cliReloadEffortCatalog(file).then(catalog.refreshEfforts)
      .catch(err => console.warn('[multicc] 强度目录缓存不可用：', err.message));
    fs.watchFile(file, { persistent: false, interval: 1000 }, reload);
    await reload();
    return () => fs.unwatchFile(file, reload);
  }
  return native.cliCatalogQueries(native, {
    bundledClaudeCodeBinary, ...catalog.api, get EFFORTS() { return catalog.efforts(); }, watchEffortCatalog,
  });
});

exposeHostApi('portableGit', () => getNative().portableGitApi({
  fs: require('node:fs'), os: require('node:os'), process, path, pkgRoot: path.resolve(__dirname, '../..'),
  setPath(env, value) { env.PATH = value; },
}));

exposeHostApi('repoActor', () => {
  module.exports.portableGit.addToPath();
  return getNative().repoActorApi({
    process, path, fs: require('node:fs'), randomBytes: require('node:crypto').randomBytes,
    execFile: require('node:util').promisify(require('node:child_process').execFile),
    makeClass: initialize => class RepoActor {
      constructor(options = {}) { initialize(this, options); }
    },
  });
});

exposeHostApi('missingResumeRecovery', () => {
  class MissingResumeRecoveryError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'MissingResumeRecoveryError';
      this.code = code;
    }
  }
  return getNative().missingResumeRecoveryApi(MissingResumeRecoveryError);
});

exposeHostApi('gitQueue', () => getNative().defaultGitQueue(module.exports.repoActor.defaultRepoActor));

exposeHostApi('gitService', () => getNative().gitServiceApi(module.exports.repoActor.defaultRepoActor, process.execPath,
  callback => require('node:async_hooks').AsyncResource.bind(callback, 'MultiCCGitOperation')));

// The resident board is identified by the host's WeakMap. Keep V8 date,
// collation, and Array species behavior when preparing native commands.
let boardDomainFacades;
function getBoardDomainFacades() {
  if (boardDomainFacades) return boardDomainFacades;
  const { taskDomain, boardStoreOf, replace } = module.exports.taskDomainHost;
  boardDomainFacades = getNative().taskBoardDomainFacades({
    taskDomain, boardStoreOf, replace,
    turnRunStates: module.exports.classifyVocab.TURN_RUN_STATES,
    compareIds: (a, b) => a.localeCompare(b),
    uuid: () => require('node:crypto').randomUUID().replace(/-/g, ''),
    mapTasks: (rows, board) => rows.map(task => board.tasks[task.id]),
    moduleEntry: (board, task) => ({ [task.moduleId]: board.modules?.[task.moduleId] }),
    wireDate(value) {
      if (value == null || value === '') return null;
      const date = value instanceof Date ? value : typeof value === 'number' ? new Date(value) : new Date(String(value));
      return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    },
  });
  return boardDomainFacades;
}
exposeHostApi('taskPlanning', () => getBoardDomainFacades().planning);
exposeHostApi('taskNormalize', () => getBoardDomainFacades().normalize);
exposeHostApi('taskBoardBridge', () => getBoardDomainFacades().bridge);

exposeHostApi('taskLifecycle', () => getNative().boardLifecycleApi({
  boardRule: module.exports.taskBoardBridge.boardRule, historyRefusal: getNative().taskHistoryRefusal,
}));
exposeHostApi('taskRelocate', () => getNative().boardRelocateApi({
  plan: getNative().taskRelocatePlan, commit: getNative().taskRelocateCommit, assign: assignHostProperty,
}));
exposeHostApi('taskRetention', () => getNative().boardRetentionApi({
  domain: module.exports.taskDomainHost.taskDomain, isOpen: module.exports.classifyVocab.isOpenRunState,
  limit: module.exports.taskShellCapacity.MAX_TASKS_PER_DIRECTORY,
}));

let taskSearchApi;
function getTaskSearchApi() {
  return taskSearchApi ??= getNative().taskSearchApi({ addon: getNative(), tokenizer: searchTokenizer, runNative, record });
}
// Importing routes or creating an injected host can precede loading the platform addon.
module.exports.taskSearch = {
  tokenize: searchTokenizer.tokenize,
  normalizeText: searchTokenizer.normalizeText,
  get FIELD_WEIGHTS() { return getTaskSearchApi().FIELD_WEIGHTS; },
  analyzeQuery(query) { return getTaskSearchApi().analyzeQuery(query); },
  buildSnippet(doc, query) { return getTaskSearchApi().buildSnippet(doc, query); },
  buildTaskSearchIndex(board, options = {}) { return getTaskSearchApi().buildTaskSearchIndex(board, options); },
  searchBoard(board, query, options = {}) { return getTaskSearchApi().searchBoard(board, query, options); },
  searchTaskIndex(index, query, options = {}) { return getTaskSearchApi().searchTaskIndex(index, query, options); },
  taskSearchFields(board, task) { return getTaskSearchApi().taskSearchFields(board, task); },
  async buildIndex(board, options = {}) { return getTaskSearchApi().buildIndex(board, options); },
  async searchIndex(index, query, options = {}) { return getTaskSearchApi().searchIndex(index, query, options); },
  createTaskSearchBackend() {
    let backend;
    return async function searchTasks(board, query, options = {}) {
      return (backend ??= getTaskSearchApi().createTaskSearchBackend())(board, query, options);
    };
  },
};

exposeHostApi('taskPlanningRoutes', () => getNative().taskPlanningRoutesApi({
  planning: module.exports.taskPlanning, cloneBoard: module.exports.taskDomainHost.cloneBoard,
}));
exposeHostApi('taskBoardRuntime', () => {
  const native = getNative();
  const { taskAttention, createTaskBoardRepository } = module.exports.taskDomainHost;
  const host = {
    core: module.exports.taskBoardCore, planning: module.exports.taskPlanning,
    recentTaskIds: module.exports.taskBoardBridge.recentTaskIds, attention: taskAttention, createTaskBoardRepository,
    crypto: require('node:crypto'), existsSync: require('node:fs').existsSync,
    isVoiceRouterRecord: module.exports.voiceRouter.isVoiceRouterRecord,
    runStateForFreezeReason: module.exports.sessionWork.runStateForFreezeReason,
    runStateForLetter: module.exports.classifyVocab.runStateForClassify,
    openBoardStore: module.exports.taskBoardStore.openBoardStore,
    createTaskWorktreeService: module.exports.taskWorktree.createTaskWorktreeService,
    createTaskRetention: module.exports.taskRetention.createTaskRetention,
    createTaskPlanningRuntime: module.exports.taskPlanningRoutes.createTaskPlanningRuntime,
    createBoardTaskLifecycle: module.exports.taskLifecycle.createBoardTaskLifecycle,
    createTaskRelocate: module.exports.taskRelocate.createTaskRelocate,
    Classification: native.TaskBoardClassification,
  };
  return { assertTaskBoardDeps: native.taskBoardAssertDeps,
    createTaskBoardRuntime: deps => native.taskBoardRuntimeCreate(deps, host) };
});

exposeHostApi('taskBoardCore', () => getNative().taskBoardCoreApi({
  planning: module.exports.taskPlanning,
  normalize: module.exports.taskNormalize,
  bridge: module.exports.taskBoardBridge,
  routing: module.exports.taskBoardRouting,
}));

exposeHostApi('sessionWork', () => getNative().sessionWorkApi(getNative(), () => ({
  crypto: require('node:crypto'), zcodeAuth: module.exports.zcodeAuth,
  kimiAuth: module.exports.kimiAuth,
  createQuestionOwner: module.exports.orchestrationNativeStore.createQuestionOwner,
})));

exposeHostApi('codexHistoryHooks', () => getNative().codexHistoryHooksApi(undefined));

exposeHostApi('modelHistoryConverter', () => getNative().modelHistoryApi(undefined,
  ({ omitReasoningContent = false } = {}) => omitReasoningContent));

exposeHostApi('stateContainer', () => getNative().sharedStateContainer());

exposeHostApi('eventBus', () => getNative().sharedEventBus(require('node:events').EventEmitter));

exposeHostApi('airRoutes', () => getNative().airMountApi(module.exports.airRoutesHost.createAirRuntime));

exposeHostApi('chatHistoryService', () => getNative().chatHistoryServiceApi(getNative()));

exposeHostApi('claudeModels', () => getNative().claudeModelListApi({
  root: () => module.exports.appPaths.createPaths().root,
}));
exposeHostApi('officialCatalog', () => getNative().officialProviderCatalogApi({
  officialCodex: provider => module.exports.codexOfficialRelay.isOfficialCodexOAuthProvider(provider),
}));
exposeHostApi('codexModelCatalog', () => getNative().codexAccountCatalogApi({
  getNative, runNative, providers: () => module.exports.providersHost,
  createAccounts: () => module.exports.officialAccounts.createOfficialAccountStore(),
  accountId: provider => module.exports.officialAccounts.officialAccountIdFromProvider(provider),
  officialCodex: provider => module.exports.codexOfficialRelay.isOfficialCodexOAuthProvider(provider),
  globalHome: () => path.join(require('node:os').homedir(), '.codex'), env: () => process.env,
  stripEnv: env => module.exports.codexOAuthRefresh.stripOpenAiEnv(env),
  childProxyEnv: env => module.exports.outbound.getChildProxyEnv(env),
  createEgress: () => module.exports.claudeEgress.createClaudeEgressAgentResolver(),
  commands: options => module.exports.cliCommands.resolveCliCommands(options),
}));

exposeHostApi('providerModels', () => getNative().providerModelsApi({
  providers: () => module.exports.providersHost,
}));
exposeHostApi('providerRouterAdapter', () => getNative().providerRouterAdapterApi({
  pathJoin: require('node:path').join,
}));
exposeHostApi('nativeVendor', () => getNative().nativeVendorApi({
  displayNameOf: module.exports.cliCapability.displayNameOf,
  getVendorCatalog: cli => module.exports.modelCatalogsHost.getVendorCatalog(cli),
  peekAgyModels: () => module.exports.agyModels.peekAgyModels(),
}));

exposeHostApi('openCodeModels', () => getNative().openCodeModelsApi({
  homedir: require('node:os').homedir, execFile: require('node:child_process').execFile,
}));
exposeHostApi('agyModels', () => getNative().agyModelsApi({
  accountEnv: () => module.exports.agyAccounts.accountEnv(), read: getNative().agyCliCatalogRead,
}));
exposeHostApi('modelCatalogsHost', () => getNative().modelCatalogsHostApi({
  openCode: () => module.exports.openCodeModels, VendorCatalog: getNative().RustVendorModelCatalog,
  execFile: require('node:child_process').execFile,
  resolveCliCommands: () => module.exports.cliCommands.resolveCliCommands(),
  providerRuntime: () => module.exports.providerModels.getSharedProviderModelsRuntime(),
  codexRuntime: () => module.exports.codexModelCatalog.defaultRuntime,
  isOfficial: provider => module.exports.codexOfficialRelay.isOfficialCodexOAuthProvider(provider),
  isLocal: module.exports.requestLocality.isLocalRequest,
}));

exposeHostApi('relayModelCatalog', () => getNative().relayModelCatalogApi({
  outboundFetch: module.exports.outbound.outboundFetch,
  officialAccountId: provider => module.exports.officialAccounts.officialAccountIdFromProvider(provider),
}));

exposeHostApi('voiceCorrector', () => {
  const native = getNative();
  return native.voiceCorrectorApi({
    windows: native.HotwordWindows, loadPinyin: () => require('pinyin-pro').pinyin,
  });
});
exposeHostApi('voiceMiner', () => {
  const native = getNative();
  return native.voiceMinerApi({ corrector: module.exports.voiceCorrector, list: native.voiceHotwordList });
});
exposeHostApi('voiceLearner', () => {
  const native = getNative();
  return native.voiceLearnerApi({
    miner: module.exports.voiceMiner, scan: native.voiceWordsScan, fs: require('node:fs'),
    atomicWriteJson: module.exports.runtimeSecurity.atomicWriteJson, basename: require('node:path').basename,
  });
});
exposeHostApi('voiceConfig', () => getNative().voiceConfigApi({
  env: process.env, fs: require('node:fs'), atomicWriteJson: module.exports.runtimeSecurity.atomicWriteJson,
  paths: module.exports.appPaths.createPaths({ dataDir: process.env.MULTICC_DATA_DIR }),
  learner: module.exports.voiceLearner, corrector: module.exports.voiceCorrector,
}));

exposeHostApi('voiceLaunchRegistry', () => getNative().voiceLaunchRegistryApi({
  isVoiceRouterRecord: module.exports.voiceRouter.isVoiceRouterRecord,
}));
exposeHostApi('voiceGatewayDomain', () => getNative().voiceGatewayDomainApi({
  resolveDirectoryCommander: module.exports.taskBoardCore.resolveDirectoryCommander,
}));
exposeHostApi('voiceGatewayHost', () => getNative().voiceGatewayHostApi({
  domain: module.exports.voiceGatewayDomain,
  isLocalRequest: module.exports.requestLocality.isLocalRequest,
  acpAgentPath: path.join(__dirname, '..', 'voice', 'multicc-acp-agent.mjs'),
}));
exposeHostApi('voiceRuntimeHost', () => getNative().voiceRuntimeHostApi({
  isLocalRequest: module.exports.requestLocality.isLocalRequest,
}));
exposeHostApi('asrModelInstaller', () => {
  const { Transform, Readable } = require('node:stream');
  const { pipeline } = require('node:stream/promises');
  return getNative().asrModelInstallerApi({
    async writeBody(body, part, append, onChunk, controller, idleTimeout) {
      const guard = setTimeout(() => controller.abort(), idleTimeout);
      guard.unref?.();
      try {
        const source = Readable.fromWeb(body);
        const counter = new Transform({
          transform(chunk, _encoding, next) {
            try { onChunk(chunk.length); guard.refresh(); }
            catch (err) { next(err); return; }
            next(null, chunk);
          },
        });
        const output = require('node:fs').createWriteStream(part, { flags: append ? 'a' : 'w' });
        await pipeline(source, counter, output, { signal: controller.signal });
      } finally { clearTimeout(guard); }
    },
  });
});
exposeHostApi('voiceSettingsHost', () => getNative().voiceSettingsHostApi({
  isLocalRequest: module.exports.requestLocality.isLocalRequest,
}));
exposeHostApi('voiceRouter', () => getNative().voiceRouterApi(getNative(),
  ({ records, mutate, runtimeRoot, cli, now } = {}) => ({ records, mutate, runtimeRoot, cli, now }),
  (records, mutate, root, cli, now = () => new Date().toISOString()) => {
  const cwd = path.join(String(root || process.cwd()), 'voice-router');
  return { mutate, cwd, cli, now: () => now(), lookup: id => records.get(id),
    draftGet: (draft, id) => draft.get(id), draftSet: (draft, id, record) => draft.set(id, record),
    mkdir: () => require('node:fs').mkdirSync(cwd, { recursive: true }) };
}));

exposeHostApi('rolloutPath', () => getNative().rolloutPathApi(getNative(), (deps = {}) => {
  const { fs, path, sessionsDirFor, now = Date.now, missTtlMs } = deps;
  return { fs, path, sessionsDirFor, now, missTtlMs };
}, (fs, paths, sessionsDirFor, now, ttl) => ({
  now, sessionsDirFor, entries: dir => fs.readdirSync(dir, { withFileTypes: true }),
  exists: name => fs.existsSync(name), join: (dir, entry) => paths.join(dir, entry.name),
  key: (dir, record) => `${dir}::${record.cliSessionId}`, fresh: at => now() - at <= ttl,
})));

function tunnelHostPorts() {
  return {
    path, process, fs: require('node:fs'), os: require('node:os'), crypto: require('node:crypto'),
    http: require('node:http'), https: require('node:https'),
  };
}
exposeHostApi('tailscaleFunnelHealth', () => getNative().tailscaleFunnelHealthApi(tunnelHostPorts()));
exposeHostApi('sakuraFrp', () => getNative().sakuraFrpApi(tunnelHostPorts()));
exposeHostApi('tunnelMonitor', () => {
  const { atomicWriteJson } = module.exports.runtimeSecurity;
  return getNative().tunnelMonitorApi({
    ...tunnelHostPorts(), pkgRoot: path.resolve(__dirname, '../..'),
    execFile: require('node:child_process').execFile, atomicWriteJson,
    findSakuraLauncher, restartSakuraLauncher, diagnoseSakurafrp,
  });
});

let orchestrationServicePorts;
exposeHostApi('orchestrationServices', () => {
  class OperationConflictError extends Error {
    constructor(message, operationId) {
      super(message);
      this.name = 'OperationConflictError';
      this.code = 'OPERATION_CONFLICT';
      this.statusCode = 409;
      this.operationId = operationId || null;
    }
  }
  orchestrationServicePorts = {
    crypto: require('node:crypto'), OperationConflictError, outboxConflict: module.exports.outboxRuntime.OutboxConflictError,
    overrideAddon: () => module.exports.getNative === getNative ? undefined : module.exports.getNative(),
  };
  return getNative().orchestrationServicesApi(orchestrationServicePorts);
});

exposeHostApi('orchestrationHost', () => {
  const { createOrchestrationStore } = module.exports.orchestrationJson;
  const { createOrchestrationSqliteStore } = module.exports.orchestrationSqlite;
  const { createOutbox } = module.exports.outboxRuntime;
  const { TERMINAL_OPERATION_STATES, TERMINAL_TASK_STATES } = module.exports.orchestrationServices;
  const api = getNative().orchestrationRuntimeApi({
    crypto: require('node:crypto'), process, AsyncLocalStorage: require('node:async_hooks').AsyncLocalStorage,
    createOrchestrationStore, createOrchestrationSqliteStore, createOutbox, servicePorts: orchestrationServicePorts,
    TERMINAL_OPERATION_STATES, TERMINAL_TASK_STATES,
    jsonStorePorts: orchestrationJsonPorts(createOrchestrationStore),
    asyncMethod(native) {
      const method = async (...args) => native(...args);
      Object.defineProperties(method, { name: { value: native.name }, length: { value: native.length } });
      return method;
    },
  });
  return { createOrchestrationRuntime: api.createOrchestrationRuntime, publicWait: api.publicWait,
    get DEFAULTS() { return api.DEFAULTS; } };
});

exposeHostApi('turnLifecycle', () => getNative().chatLifecycleApi(getNative()));
exposeHostApi('chatHostCoordinator', () => getNative().chatCoordinatorApi({
  lifecycle: module.exports.turnLifecycle, router: module.exports.postTurnRouter,
}));
exposeHostApi('chatHostRuntime', () => getNative().chatRuntimeApi({
  coordinator: module.exports.chatHostCoordinator, redact: module.exports.observability.redactProviderRouteCapability,
  protocol: module.exports.cliCapability.protocolFamilyOf, turnProgress: getTurnProgress,
}));
exposeHostApi('chatApi', () => getNative().chatHostExports([
  () => module.exports.turnRequestHost, getRetryPolicy, () => module.exports.apiErrorPolicy,
  () => getNative().apiErrorHostApi({
    vendorLoginForCli: getVendorLogin().vendorLoginForCli,
    systemProxyHijackHint: module.exports.globalProxy.systemProxyHijackHint,
  }), () => module.exports.postTurnRouter,
  () => ({ createTurnRuntimeStore: module.exports.stateOwner.createTurnRuntimeStore }),
  () => module.exports.turnLifecycle, () => module.exports.providerAttemptRuntime,
  () => providerInvocation, () => module.exports.chatHostCoordinator, () => module.exports.chatHostRuntime,
  () => module.exports.finalizationPlan, () => require('../chat/finalize-host'),
]));

exposeHostApi('taskBoardRouting', () => getNative().taskBoardRoutingApi({
  taskDomain: module.exports.taskDomainHost.taskDomain, taskDirId: module.exports.taskNormalize.taskDirId,
  entries: values => [...values || []],
  affinity: task => new Set((task.refs || []).map(ref => ref.sessionId).filter(Boolean)),
  rankInputs(records, { dirId = null, contextTerms = new Map(), affinitySessionIds = new Set(), options = {} } = {}, check) {
    const entries = [...records || []], availability = {}, activities = {};
    for (const [id, record] of entries) {
      if (typeof options.isAvailable === 'function') availability[id] = check(record, id, options);
      const value = record && (record.lastActivity || record.createdAt);
      const ms = typeof value === 'number' ? value : Date.parse(value || '');
      activities[id] = Number.isFinite(ms) ? ms : 0;
    }
    return { records: entries, dirId, contextTerms: [...contextTerms], affinitySessionIds: [...affinitySessionIds], availability, activities };
  },
}));

let policyBinding;
exposeHostApi('classifyVocab', () => {
  const { apiErrorSignaturesQuoted } = module.exports.apiErrorPolicy;
  return getNative().classifyVocabApi(apiErrorSignaturesQuoted, policyBinding.policy);
});

exposeHostApi('apiErrorPolicy', () => {
  const { extractUpstreamError } = module.exports.upstreamError;
  const { errorFields } = module.exports.providerError;
  policyBinding = { process, addonPath: process.env.MULTICC_RUST_ADDON, prebuiltDir: process.env.MULTICC_RUST_PREBUILT_DIR };
  return getNative().apiErrorPolicyApi(getNative, extractUpstreamError, errorFields, policyBinding);
});

// Preserve the public object's identity on Rust cache hits and the frozen
// fallback shared by the old CommonJS entry. Rust owns probe scheduling.
const hostBatteryUnavailable = Object.freeze({ available: false });
function createHostBatteryReader() {
  let reader, generation, reading;
  return async function readBattery() {
    reader ??= new (getNative().HostBatteryReader)();
    const sample = await reader.read();
    if (sample.generation !== generation) {
      generation = sample.generation;
      reading = sample.reading ?? hostBatteryUnavailable;
    }
    return reading;
  };
}
module.exports.createHostBatteryReader = createHostBatteryReader;
module.exports.hostBatteryUnavailable = hostBatteryUnavailable;
