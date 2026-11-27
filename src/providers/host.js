'use strict';

// Connect the Node CLI router, live account catalogs and child processes to the Rust provider service.

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const cliProviderRouter = require('cli-provider-router');
const { createPaths } = require('../native/binding').appPaths;
const { settingsOverrideFor } = require('../native/binding').claudeSettingsOverride;
const { createOpencodeModelLimitResolver } = require('../native/binding').openCodeModelLimits;
const { createCodexAttemptHome } = require('../codex/attempt-home');
const { createCodexSessionHomeRuntime } = require('../codex/session-home');
const { isOfficialCodexOAuthProvider } = require('../codex/official-relay');
// Resident lanes hold their route across turns, so they own the codex home that
// bakes it (see the module). It reaches back here for the physical
// materialization, which is why it is required from this side.
const {
  prepareResidentChildEnv, releaseResidentRoute,
} = require('../codex/resident-route');
const { codexAccountAuthFilePath } = require('../official-accounts');
const { getNative, nativeCode, codexProviderHome, createNativeProviderStore } = require('../native/binding');
const {
  assertProxyConfigApplied: assertCodexProxyConfigApplied,
  proxyConfigRequired: evaluateCodexProxyConfigRequired,
} = codexProviderHome;
const assertClaudeProxyEnvApplied = (...args) => getNative().assertClaudeProxyEnvApplied(...args);
const claudeProxyEnvRequired = (...args) => getNative().claudeProxyEnvRequired(...args);

const sqliteRuntime = getNative().ccSwitchDatabaseApi({ existsSync: fs.existsSync });

// Model limits for generated OpenCode custom providers (models.dev cache).
// The synchronous spawn plan reads the catalog lazily per model.
const opencodeModelLimits = createOpencodeModelLimitResolver();

const CC_DB_DEFAULT = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
function resolveCcDb() {
  if (fs.existsSync(CC_DB_DEFAULT)) return CC_DB_DEFAULT;
  // Windows Git Bash legacy fallback — cc-switch does the same (see its config.rs)
  if (process.platform === 'win32' && process.env.HOME) {
    const legacy = path.join(process.env.HOME, '.cc-switch', 'cc-switch.db');
    if (fs.existsSync(legacy)) return legacy;
  }
  return CC_DB_DEFAULT; // return default path even if absent (caller checks)
}
// multicc's own store, in the project root (one level up from src/).
const RUNTIME_PATHS = createPaths({ dataDir: process.env.MULTICC_DATA_DIR });
const STORE_FILE = RUNTIME_PATHS.providersFile;
let officialCatalog = null;
function enableUnifiedOfficialProviders() {
  if (officialCatalog) return;
  const selectionFile = path.join(RUNTIME_PATHS.root, 'official-provider-selection.json');
  if (!fs.existsSync(selectionFile)) {
    const defaultsOwner = require('./defaults-port').getProviderDefaultsOwner(RUNTIME_PATHS.providerDefaultsFile);
    defaultsOwner.assertReadable();
    const defaults = defaultsOwner.snapshot();
    const records = loadStore();
    const selection = getNative().providerInitialSelection(records, defaults);
    require('../native/binding').providerCredentials.credential({ operation: 'writeJson', file: selectionFile, data: selection });
  }
  officialCatalog = require('./official-catalog').createOfficialCatalog({
    readRecords: loadStore,
    readSelection() {
      return require('../native/binding').providerCredentials.credential({ operation: 'readStateJson', file: selectionFile }) || {};
    },
    writeSelection: selection => require('../native/binding').providerCredentials.credential({ operation: 'writeJson', file: selectionFile, data: selection }),
    ...(() => {
      const store = require('../official-accounts').createOfficialAccountStore();
      return {
        listAccounts: type => (type === 'codex' ? store.listCodexAccounts() : store.listClaudeAccounts()),
        deleteAccount: (type, id) => (type === 'codex' ? store.deleteCodexAccount(id) : store.deleteClaudeAccount(id)),
      };
    })(),
  });
}
// Built-in official identities: the vendor alias and every per-account id.
function isOfficialProviderId(appType, id) {
  return !!officialCatalog && require('./official-catalog').isOfficialProviderId(appType, id);
}
function normalizeOfficialProviderId(type, id) { return officialCatalog ? officialCatalog.normalize(type, id) : id; }
function getOfficialAccountSelection(type) { return officialCatalog ? officialCatalog.active(type) : null; }
function selectOfficialAccount(type, id) {
  if (!officialCatalog) throw new Error('unified official providers not enabled');
  return summarize(officialCatalog.select(type, id));
}
// Per-provider CODEX_HOME dirs materialized on demand so codex sessions can
// point at different auth/config without clobbering the global ~/.codex.
const CODEX_HOMES_DIR = path.join(os.homedir(), '.multicc', 'codex-homes');
const CODEX_ATTEMPT_HOMES_DIR = path.join(os.homedir(), '.multicc', 'codex-attempt-homes');
const CODEX_SESSION_HOMES_DIR = path.join(os.homedir(), '.multicc', 'codex-session-homes');
const codexSessionHomeRuntime = createCodexSessionHomeRuntime({
  sessionHomesDir: CODEX_SESSION_HOMES_DIR,
  codexHomesDir: CODEX_HOMES_DIR,
});
const {
  codexSessionHome, prepareCodexSessionHome, synchronizeCodexSessionRoute,
} = codexSessionHomeRuntime;
const ZCODE_HOMES_DIR = path.join(os.homedir(), '.multicc', 'zcode-homes');
// Per-provider KIMI_CODE_HOME dirs so Kimi Code sessions bound to a MultiCC
// provider never touch (or leak into) the user's native ~/.kimi-code login.
const KIMI_HOMES_DIR = path.join(os.homedir(), '.multicc', 'kimi-homes');
// Same isolation for Grok Build: provider-bound sessions get a private
// GROK_HOME (default ~/.grok holds the user's own login) carrying a generated
// config.toml that points one [model.*] entry at the provider.
const GROK_HOMES_DIR = path.join(os.homedir(), '.multicc', 'grok-homes');

const APP_TYPES = ['claude', 'codex'];
const API_FORMATS = Object.freeze({
  ANTHROPIC: 'anthropic',
  OPENAI_RESPONSES: 'openai_responses',
});

// The pool's pinned format, else the requested spelling. The third `cfg`
// argument of the retired signature was never read; callers still pass it.
function normalizeApiFormat(value, appType) {
  return getNative().providerNormalizeApiFormat({ apiFormat: value, appType });
}

function compatibleClisForFormat(apiFormat) {
  return getNative().providerCompatibleClis(apiFormat, true);
}

function providerSupportsCli(provider, cli) {
  if (!provider || !cli) return false;
  // 虚拟线路的池标签由原生规则直接作答；provider 行先摊平成 summary 事实。
  const summary = provider.settingsConfig && !provider.virtual ? summarize(provider) : provider;
  return !!getNative().providerSupportsCli(summary, cli);
}

function appTypeForCli(cli) {
  return getNative().providerAppTypeForCli(cli);
}

function appTypesForCli(cli) {
  return getNative().providerAppTypesForCli(cli);
}

const WIRE_DEFAULT_MODEL = process.env.CLAUDE_WIRE_DEFAULT_MODEL || 'claude-sonnet-4-5';

// ── multicc store (providers.json) ───────────────────────────────────────────

let nativeProviderStore;
function providerRepository() { return nativeProviderStore ||= createNativeProviderStore(STORE_FILE); }
function loadStore() { return providerRepository().read(); }
const registry = getNative().providerRegistryService({
  get store() { return providerRepository(); },
  get catalog() { return officialCatalog; },
  accountModels: (record, runtime) => (runtime || require('../codex/model-catalog').defaultRuntime)
    .peekProvider(record).models.map(item => item.model),
  uuid: () => crypto.randomUUID(), getPort: () => process.env.PORT || '3000',
  relayForced: () => process.env.MULTICC_CLI_RELAY_FORCE === '1',
  ccPath: resolveCcDb, get vendorRoots() { return vendorRoots; }, modelLimits: opencodeModelLimits,
  codexHomes: CODEX_HOMES_DIR, codexGlobal: path.join(os.homedir(), '.codex'), logModels,
  sdk: cliProviderRouter, leases: new WeakMap(), attemptsDir: CODEX_ATTEMPT_HOMES_DIR,
  prepareHome: prepareCodexSessionHome, attemptHome: createCodexAttemptHome,
  get routeView() { return routingProviderView; },
  get providerLookup() { return getProvider; },
});
const { applyCodexProxyConfig, releaseCodexProxyConfig, applyCodexLeaseEnv, applyClaudeProxyEnv, routingProviderView,
  listProviders, getProvider, summarize, hasCliRelayProvider, createProvider, updateProvider,
  deleteProvider, migrateLegacyProviderProtocols, importFromCcSwitch, updateProviderRelayModelCatalog } = registry;

function getCcSwitchStatus() {
  return sqliteRuntime.getStatus(resolveCcDb());
}

function ccSwitchAvailable() { return getCcSwitchStatus().available; }

function parseConfig(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (_) { return {}; }
}

function resolveSessionWireModel(sessionModel, { providerModel = null, providerModels = [], skipDefaultModel = false, defaultModel = null } = {}) {
  return getNative().providerWireModel(sessionModel, {providerModel, providerModels, skipDefaultModel, defaultModel});
}

const CODEX_OFFICIAL_MODELS_FALLBACK = Object.freeze([]);
function readCodexOfficialModels(cachePath) {
  return registry.readOfficialModels(cachePath || path.join(os.homedir(), '.codex', 'models_cache.json'));
}

function modelValidForProvider(appType, providerId, model, summaryOverride) {
  if (!model) return true; // 默认 → provider/global default, always resolvable
  const summary = summaryOverride !== undefined ? summaryOverride : (providerId ? getProviderSummary(appType, providerId) : null);
  return getNative().providerValidModel(appType, String(model), summary);
}

function resolveAuxHttpTarget(protocol, providerId, { port, claudeOfficialViaProxy = false } = {}) {
  const record = getProvider(protocol === 'openai' ? 'codex' : 'claude', providerId);
  return getNative().providerAuxTarget(protocol || '', String(providerId || ''), record,
    record && summarize(record), String(port || ''), !!claudeOfficialViaProxy);
}

// Raw bearer credential of a stored provider, for the "copy original import
// info" action on a relay-imported line. Only the owner-facing route calls it;
// summaries keep exposing the masked token only.
function getRelayImportToken(appType, id) {
  const p = getProvider(appType, id);
  if (!p || (officialCatalog && p.builtinOfficial)) return '';
  return getNative().providerImportToken(appType || '', p, process.env.PORT || '3000');
}

function resolveCliRelayTarget(appType, id) {
  if ((appType !== 'claude' && appType !== 'codex') || !id) return null;
  const p = getProvider(appType, id);
  if (!p || p.virtual) return null;
  if (officialCatalog && p.builtinOfficial) return null;
  return getNative().providerCliRelay(appType, p, process.env.MULTICC_CLI_RELAY_FORCE === '1', process.env.PORT || '3000');
}

function getProviderSummary(appType, id) {
  const p = getProvider(appType, id);
  return p ? summarize(p) : null;
}

function getProviderLimitTarget(appType, id) {
  const target = getNative().providerBalanceTarget(getProvider(appType, id), String(id || ''));
  if (target?.strategy === 'codex-oauth-usage' && target.officialAccountId) {
    target.authFile = codexAccountAuthFilePath(target.officialAccountId);
  }
  return target;
}

// Compatibility wrapper used by the provider speed test.
function resolveCodexDirectHttp(providerId) {
  const target = resolveAuxHttpTarget('openai', providerId);
  return target.available
    ? { ...target, canDirect: true }
    : { ...target, canDirect: false };
}

function applyProviderRelayModelCatalog(provider, input = {}, nowMs = Date.now()) {
  return getNative().providerApplyRelayCatalog(provider, input, nowMs);
}

const ANTHROPIC_ROUTING_KEYS = getNative().providerAnthropicRoutingKeys();
const CLAUDE_ROUTING_KEYS = [...ANTHROPIC_ROUTING_KEYS, 'CLAUDE_CODE_SIMPLE'];

function materializeCodexAuth(home, cfg) {
  return codexProviderHome.materialize(home, cfg, true);
}

const vendorRoots = {zcode: ZCODE_HOMES_DIR, kimi: KIMI_HOMES_DIR, grok: GROK_HOMES_DIR};
function vendorHome(cli, session) {
  return getNative().providerVendorHome(vendorRoots[cli], cli, String(session?.id || session?.sessionId || ''));
}
const zcodeSessionHome = session => vendorHome('zcode', session);
const kimiSessionHome = session => vendorHome('kimi', session);
const grokSessionHome = session => vendorHome('grok', session);
function vendorRoute(cli, provider, session) {
  const identity = { id: String(session?.id || session?.sessionId || ''), model: session?.model };
  return getNative().providerVendorRoute(cli, provider, summarize(provider), identity, vendorRoots[cli] || '', opencodeModelLimits);
}
const buildKimiCodeRoute = (provider, session) => vendorRoute('kimi', provider, session);
const buildDshRoute = (provider, session) => vendorRoute('dsh', provider, session);
const buildGrokRoute = (provider, session) => vendorRoute('grok', provider, session);

// Compute env overrides + flags to apply when spawning a child for `session`.
//   - env: object merged into the child's process env (only this child).
//   - skipDefaultModel: claude routes elsewhere → don't force the global --model.
function resolveSpawnEnv(session) {
  try { return registry.resolveSpawnEnv(session); }
  catch (error) { throw nativeCode(error); }
}

function buildChildEnv(base, session, extra = {}) {
  try { return registry.buildChildEnv(base, session, extra); }
  catch (error) { throw nativeCode(error); }
}

function logModels(id, plan) {
  const modelEnv = Object.fromEntries(Object.entries(plan.env)
    .filter(([key]) => /^ANTHROPIC_(BASE_URL|MODEL|DEFAULT_.*_MODEL|SMALL_FAST_MODEL)$/.test(key))
    .sort(([a], [b]) => a.localeCompare(b)));
  console.log(`[multicc/provider] claude env [${id}] provider=${plan.providerName} aliasOnly=${plan.aliasOnly} modelEnv=${JSON.stringify(modelEnv)}`);
}

function readDailyWindows() {
  return getNative().providerDailyWindows(RUNTIME_PATHS.root);
}
function getProviderUsageStats() {
  return getNative().providerUsageStats(RUNTIME_PATHS.root, loadStore().map(({id, name, appType}) => ({id, name, appType})));
}

// ── Relay probe + cc-switch source correction ────────────────────────────────

// Candidate wire names probed to discover what an alias-only relay accepts.
// All Anthropic-compatible relays accept claude-* names; this confirms which.
const PROBE_CANDIDATES = ['claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-4-5', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-sonnet-4.5'];

// Env vars that select a model — stripped from the probe child so the candidate
// `--model` is authoritative (otherwise an alias target would shadow it).
const PROBE_STRIP_KEYS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'];

function _probeCandidate(cliCmd, baseEnv, model) {
  return new Promise((resolve) => {
    // Same order as buildChildEnv: inherited routing keys first (a value this
    // server itself inherited from its own shell must not ride along), then the
    // provider's route env on top.
    const env = { ...process.env };
    for (const k of CLAUDE_ROUTING_KEYS) delete env[k];
    Object.assign(env, baseEnv);
    for (const k of PROBE_STRIP_KEYS) delete env[k];
    // ~/.claude/settings.json env would otherwise override baseEnv (Claude Code
    // ≥2.1) and probe the global provider instead of this relay.
    const settingsEnv = { ...baseEnv };
    for (const k of PROBE_STRIP_KEYS) delete settingsEnv[k];
    const settingsFile = settingsOverrideFor(`probe-${model}`, settingsEnv);
    const child = spawn(cliCmd, [
      '-p', '--model', model, '--max-turns', '1', '--dangerously-skip-permissions',
      ...(settingsFile ? ['--settings', settingsFile] : []),
      'hi',
    ], { env, windowsHide: true });
    let out = '';
    const sink = (c) => { if (out.length < 2048) out += c.toString(); };
    child.stdout.on('data', sink);
    child.stderr.on('data', sink);
    const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 25000);
    child.on('error', () => { clearTimeout(to); resolve({ model, ok: false, reason: 'spawn failed (is the claude CLI installed?)' }); });
    child.on('close', () => {
      clearTimeout(to);
      const rejected = /1211|模型不存在|model.*(not found|不存在)|model_not_found/i.test(out);
      resolve({ model, ok: !rejected, sample: out.slice(0, 95) });
    });
  });
}

// Probe which candidate model names a relay accepts. Spawns the claude CLI per
// candidate (sequential; ~N×turn). Returns { tested:[{model,ok,...}], accepted:[model,...] }.
async function probeRelayModels(baseEnv, candidates, cliCmd) {
  const cands = (candidates && candidates.length) ? candidates : PROBE_CANDIDATES;
  if (!baseEnv || !baseEnv.ANTHROPIC_BASE_URL) return { tested: [], accepted: [], error: 'no base url' };
  const cmd = cliCmd || 'claude';
  const tested = [];
  for (const m of cands) tested.push(await _probeCandidate(cmd, baseEnv, m));
  return { tested, accepted: tested.filter(o => o.ok).map(o => o.model) };
}

function claudeProbeRouteEnv(claudeProviderId, port) {
  const provider = (() => {
    if (!claudeProviderId) return null;
    try { return getProvider('claude', claudeProviderId); } catch (_) { return null; }
  })();
  // Probeable = the entry names an upstream: its own base URL, or its own token
  // (implied upstream, see claudeRoutingProviderView). A credential-less official
  // entry is not probeable here — its upstream is a login the hop replays, which
  // is not something to spend a spawned child on.
  const hasToken = provider && getNative().providerClaudeRoutingFacts(provider).hasToken;
  if (!provider || (!summarize(provider).baseUrl && !hasToken)) return null;
  const env = { ...((parseConfig(provider.settingsConfig).env) || {}) };
  // Throws (CLAUDE_PROXY_ENV_REQUIRED) if the route cannot be materialized —
  // never fall back to the vendor env.
  applyClaudeProxyEnv(env, { providerId: claudeProviderId, sessionId: 'probe', port });
  return env;
}

function codexProviderProxyable(providerOrId) {
  const provider = typeof providerOrId === 'string' ? getProvider('codex', providerOrId) : providerOrId;
  // Official OAuth has a host-owned relay even though its stored config has no
  // HTTP endpoint. Use the same capability as applyCodexProxyConfig below.
  return isOfficialCodexOAuthProvider(provider)
    || cliProviderRouter.codexProviderProxyable(provider, { getProvider });
}

function codexProxyConfigRequired(options = {}) {
  const providerId = String(options.providerId || '').trim();
  return evaluateCodexProxyConfigRequired({
    providerId,
    subagentProviderId: options.subagent && options.subagent.providerId,
  });
}

const materializeCodexRoutingHome = cliProviderRouter.materializeCodexRoutingHome;

module.exports = {
  enableUnifiedOfficialProviders, normalizeOfficialProviderId, isOfficialProviderId, getOfficialAccountSelection, selectOfficialAccount,
  ccSwitchAvailable,
  getCcSwitchStatus,
  appTypeForCli,
  appTypesForCli,
  providerSupportsCli,
  normalizeApiFormat,
  compatibleClisForFormat,
  API_FORMATS,
  APP_TYPES,
  listProviders,
  getProvider,
  routingProviderView,
  getProviderSummary,
  getProviderLimitTarget,
  resolveAuxHttpTarget,
  resolveCodexDirectHttp,
  createProvider,
  updateProvider,
  applyProviderRelayModelCatalog,
  updateProviderRelayModelCatalog,
  deleteProvider,
  importFromCcSwitch,
  migrateLegacyProviderProtocols,
  resolveSpawnEnv,
  buildChildEnv,
  materializeCodexAuth,
  applyClaudeProxyEnv,
  assertClaudeProxyEnvApplied,
  claudeProxyEnvRequired,
  applyCodexProxyConfig,
  applyCodexLeaseEnv,
  assertCodexProxyConfigApplied,
  codexProxyConfigRequired,
  releaseCodexProxyConfig,
  prepareResidentChildEnv,
  releaseResidentRoute,
  materializeCodexRoutingHome,
  codexProviderProxyable,
  isOfficialCodexOAuthProvider,
  codexSessionHome,
  prepareCodexSessionHome,
  synchronizeCodexSessionRoute,
  resolveSessionWireModel,
  modelValidForProvider,
  readCodexOfficialModels,
  CODEX_OFFICIAL_MODELS_FALLBACK,
  summarize,
  getRelayImportToken,
  resolveCliRelayTarget,
  hasCliRelayProvider,
  getProviderUsageStats,
  readDailyWindows,
  CLAUDE_ROUTING_KEYS,
  ANTHROPIC_ROUTING_KEYS,
  CODEX_HOMES_DIR,
  CODEX_ATTEMPT_HOMES_DIR,
  CODEX_SESSION_HOMES_DIR,
  ZCODE_HOMES_DIR,
  KIMI_HOMES_DIR,
  GROK_HOMES_DIR,
  zcodeSessionHome,
  kimiSessionHome,
  grokSessionHome,
  buildKimiCodeRoute,
  buildDshRoute,
  buildGrokRoute,
  WIRE_DEFAULT_MODEL,
  probeRelayModels,
  claudeProbeRouteEnv,
  ...require('../native/binding').claudeSettingsOverride,
};
