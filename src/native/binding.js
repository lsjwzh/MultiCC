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
function getRetryPolicy() { return retryPolicy ??= getNative().retryPolicyApi(require('../chat/api-error-policy').policyPorts); }
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
  return sessionDto ??= getNative().sessionDtoApi(getNative(), value => require('../providers/auto-provider-config').providerSelectionRequest(value));
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
function getTaskFrames() { return taskFrames ??= getNative().taskFramesApi(require('./task-domain').taskCodeRegistryState); }
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
  const { STALE_MS_DEFAULT } = require('../quota/provider-limit-cache-native-host');
  return getNative().providerLimitSnapshot(entry, now, STALE_MS_DEFAULT, elapsedTime);
}
function connectProviderLimitSync(options) {
  return getNative().subscribeProviderLimits(options, require('../quota/provider-limit-cache-native-host').STALE_MS_DEFAULT, elapsedTime);
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
function requestCodexUsage(auth, { fetch = require('../network/outbound').outboundFetch, signal } = {}) {
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
      ProviderAttemptError: require('../chat/provider-attempt-runtime').ProviderAttemptError,
      assertProviderBinding: require('../providers/binding').assertProviderBinding,
      TurnRequestError: require('../chat/turn-request').TurnRequestError,
    });
  },
  protocolFor: (cli, summary) => getNative().providerInvocationProtocol(cli, summary),
  providerRetryRouteOptions: attempt => getNative().providerRetryRouteOptions(attempt),
};
function createAutoProviderHandoff(options) { return getNative().createAutoProviderHandoff(options); }
function createClaudeAdapter(deps = {}) {
  return getNative().createClaudeAdapter(deps, path.join(__dirname, '../cli-adapters/claude-agent-sdk-bridge.mjs'),
    process.execPath, {
      displayName: require('../cli/cli-capability').displayNameOf('claude'),
      homedir: require('node:os').homedir,
    });
}
const codexAdapter = {
  createCodexAdapter(deps) {
    return getNative().createCodexAdapter(deps, {
      extractUpstreamError: require('../upstream-error').extractUpstreamError,
      displayName: require('../cli/cli-capability').displayNameOf('codex'),
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
      displayName: require('../cli/cli-capability').displayNameOf('codex-exp'),
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
