'use strict';

const { connectAuthControl, applySourceAddonEnv } = require('./src/gateway-child');
applySourceAddonEnv(__dirname);

{
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16)) {
    console.error(`[multicc] Node.js >=22.16.0 is required (found ${process.versions.node}).`);
    process.exit(1);
  }
}

const _envPath = require('path').join(__dirname, '.env');
try {
  require('fs').readFileSync(_envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch (_) { /* .env not found, skip */ }
// Start every child from clean routing env; per-session providers re-apply theirs.
const { ANTHROPIC_ROUTING_KEYS } = require('./src/providers/core');
for (const k of ANTHROPIC_ROUTING_KEYS) {
  if (process.env[k]) { console.log(`[multicc] stripping inherited ${k} so claude uses the OAuth subscription`); delete process.env[k]; }
}
// Also strip parent Claude SDK markers: SIMPLE mode removes Agent/Task tools.
for (const k of [
  'CLAUDE_CODE_SIMPLE',
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID',]) {
  if (process.env[k]) { console.log(`[multicc] stripping leaked ${k} so spawned claude keeps the full tool set`); delete process.env[k]; }
}
require('./src/task-shell/migration-gate').runAtBoot();
require('./src/network/global-proxy').installGlobalProxy();
const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const { spawn, execFile } = require('child_process');
const { createUploadSuite } = require('./src/upload-middleware');
const chokidar = require('chokidar');
const cron = require('node-cron');
const upload = createUploadSuite();
const wechatBridge = require('./plugins/bridges/wechat-ilink');
const feishuBridge = require('./plugins/bridges/feishu-bridge');
const telegramBridge = require('./plugins/bridges/telegram-bridge');
const discordBridge = require('./plugins/bridges/discord-bridge');
const slackBridge = require('./plugins/bridges/slack-bridge');
const voiceAsr = require('./plugins/voice/voice-asr');
const ttsService = require('./src/voice/tts-service');
const cronTasks = require('./plugins/cron/cron-tasks');
const webpush = require('web-push');
const macosPower = require('./plugins/utils/macos-power');
const batteryGuardRuntime = require('./src/battery-guard').createBatteryGuardRuntime({ macosPower, logger: console }).start(); // 掉电保护，详见 src/battery-guard.js 头注
const gitPush = require('./plugins/utils/git-push');
const { runGit: gitRunQueued, queueDepth: gitQueueDepth } = require('./src/git/queue');

const crypto = require('crypto');
const bus = require('./src/bus');
const state = require('./src/state/container');
const artifacts = require('./src/artifacts'), docsRegistry = require('./src/docs-registry'), secretsVault = require('./src/secrets-vault'), pluginsRoutes = require('./src/routes/plugins');
const providers = require('./src/providers/core');
providers.enableUnifiedOfficialProviders(); const codexCatalog = require('./src/codex/model-catalog').startDefaultRuntime();
const { executeAuxHttp } = require('./src/aux-http');
const { createRoleTokenTracker } = require('./src/role-token-tracker');
const {
  createCodexUsageHost,
  projectHistoryUsage,
  summarizeHistoryUsage,
} = require('./src/codex/usage');
const { createProviderRouterRuntime } = require('./src/providers/router-runtime');
const { getNative, findProviderReferences, messageComposer, bootstrapState,
  synchronizeCodexProfileRoute, installAuxHealthProvider, fanOutAuxVerdictStaleness, getNetworkPolicy, createSessionPersistence } = require('./src/native/runtime');
const { createCliAdapters } = require('./src/cli-adapters');

const { createSessionPolicy, createReportedModelRuntime, pollCodexSessionId } = require('./src/cli/session-policy');
const { isResidentSession, displayNameOf, isAlias, nameOf: canonicalCli, watchEffortCatalog } = require('./src/cli/cli-capability');
const { cliHandoffSummary, createCliSwitchRuntime } = require('./src/cli/switch-runtime');
const { renderPrompt } = messageComposer;
const {
  applyCuratedMemoryAction,
  atomicWrite: atomicWriteMemoryFile,
  readMemoryFolder: readFolderMemory,
  scanMemoryContent,
} = require('./src/memory-store');
const {
  SUPPORTED_CHAT_CLIS,
  ensureCliStates,
  rememberActiveCliState,
  activateCliState,
  stateSummary: cliStateSummary,
  clearAllNativeCliStates,
  buildHandoffCheckpoint,
  renderHandoffPrompt,
} = require('./src/cli-switch');
const CLIENT_CHAT_CLIS = Object.freeze(SUPPORTED_CHAT_CLIS.filter(cli => !isAlias(cli)));
// MULTICC_DATA_DIR owns state; stores use atomic writes.
const { createPaths } = require('./src/paths');
const stateStore = require('./src/state/store');
const { createSessionRecords, createTaskStateStore } = require('./src/session/records');
const { createStateOwner } = require('./src/state/owner');
const { createChatSessions, createChatReplayRuntime } = require('./src/chat/sessions');
const { createDirectoryTable } = require('./src/directory/records');
const mountPublicSessionAccessGuard = (app, options) =>
  require('./src/native/runtime').getNative().sessionPublicAccessApi().mountPublicSessionAccessGuard(app, options);
const { initializeSessionWorktrees, resolveSessionCwd } = require('./src/session/hibernation');
const { createOrchestrationRuntime } = require('./src/orchestration/runtime');
const { createRouterToolHost } = require('./src/router-tool-host'); const { createSecretTools } = require('./src/secret-tools'); const { createOfficialImageBridgeRuntime } = require('./src/codex/image-bridge-runtime');
const { createHostLifecycle } = require('./src/host-lifecycle');
const { createLanDiscoveryRuntime } = require('./src/lan-discovery');
const gatewayChild = require('./src/gateway-child'); gatewayChild.watchGatewayLifeline(); // behind the Rust front door: exit when it is gone
const { requestIdMiddleware, safeErrorHandler, asyncHandler } = require('./src/http-errors');
const { createMemoModule } = require('./src/memo');
const { createReleaseHistoryHost } = require('./src/routes/release-history-host');
const { createApkDistribution } = require('./src/apk-distribution');
const { mountSystemHostRoute, mountProviderRelayHostRoute, mountHostReadHostRoute, mountScanHistoryHostRoute, mountTurnLedgerHostRoute, mountAgentResourcesHostRoute, mountTokenUsageHostRoute } = require('./src/routes/host-read-host');
const { mountPushHostRoute } = require('./src/routes/push-host');
const { createVoiceHost } = require('./src/voice/host');
const { mountAuxGoalRoutes } = require('./src/routes/aux-goal');
const { createTaskBoardRuntime } = require('./src/routes/task-board'); const { createTaskSearchRoutes } = require('./src/routes/task-search'); const { getSharedSearchRuntime } = require('./src/search/runtime');
const { createCommanderMigrationState } = require('./src/commander-migration');
const { mountFileTransferHostRoute } = require('./src/routes/file-transfer-host');
const { createSkillSyncRuntime } = require('./src/skill-sync');
const skillConverter = require('./src/skill-converter');
const { createProviderRoutes } = require('./src/routes/providers'); const { createProviderRelayShareStore } = require('./src/providers/relay-share-store');
const { mountModelCatalogsHostRoute } = require('./src/routes/model-catalogs-host');
const { createOfficialAccountStore, sanitizeLoginEnv, DEFAULT_ROOT: OFFICIAL_ACCOUNTS_ROOT } = require('./src/official-accounts'); const { mountCodexAccountRoutes } = require('./src/routes/codex-accounts'); const { createCodexAccountRefreshSupervisor } = require('./src/codex/accounts-refresh'); const { mountClaudeAccountRoutes } = require('./src/routes/claude-accounts'); const { createClaudeAccountCredentialService } = require('./src/claude-auth/account-credentials'); // multi-account official credentials (see src/official-accounts.js)
const { mountQuotaHostRoute } = require('./src/routes/quota-host');
const { mountProviderBalanceRoutes } = require('./src/routes/provider-balance-host');
const { createProviderRelayModelCatalogRuntime } = require('./src/providers/relay-model-catalog');
const { createMemoryBrowserRoutes } = require('./src/routes/memory-browser');
const { createDocsMemoryHost } = require('./src/routes/docs-memory-host');
const { mountSessionMemoryRoutes } = require('./src/routes/session-memory');
const { createAgentResourcesRuntime } = require('./src/routes/agent-resources');
const { mountSecretsVaultHostRoute } = require('./src/routes/secrets-vault-host');
const { mountSessionCreateRoutes } = require('./src/routes/session-create');
const { createSessionRoutesHost, createSessionMetaRuntime } = require('./src/routes/session-routes-host');
const { createShareMachinesHost } = require('./src/routes/share-machines-host');
const { createAccountRoutesHost, mountCliKeyAccountRoutes, mountCommandcodeAuthRoutes, readCommandcodeLogin, mountCodexOAuthRoutes } = require('./src/routes/account-routes-host');
const { createClaudeOAuthSurface } = require('./src/routes/claude-oauth');
const { mountZcodeAuthRoutes, mountZcodeAuthLoginRoute } = require('./src/routes/zcode-auth'); const { mountKimiAuthRoutes, mountKimiAuthLoginRoute } = require('./src/routes/kimi-auth');
const { createOrchestrationRoutes } = require('./src/routes/orchestration');
const { createChatTurnEngine } = require('./src/chat/turn-engine'); const { primaryProviderCandidate, validateProviderSelection } = require('./src/providers/auto-provider-config');
const { createTuiChatMirrorRuntime, isEnabled: tuiChatMirrorEnabled, validateExperimentalSession } = require('./src/experiments/tui-chat-mirror-runtime');
const { createSessionGitRuntime } = require('./src/routes/session-git');
const { createSessionProfileRoutes } = require('./src/routes/session-profile');
const { createSessionBundleRoutes } = require('./src/routes/session-bundle');
const { createSessionLifecycleRuntime } = require('./src/routes/session-lifecycle');
const { createServerRestartRoute } = require('./src/routes/server-restart-route');
const { createUpdateRoute } = require('./src/routes/update-route');
const { createAuthRuntime } = require('./src/routes/auth');
const { createNotesStore } = require('./src/notes-store');
const {
  listInstalledSkills,
  listClaudeHistory,
  removeClaudeHistorySession,
} = require('./src/skills');
const { createFolderMemoryService } = require('./src/memory/folder-service');
const {
  createMemoryRuntime,
  getMemoryEntries,
  normalizeManualMemory,
} = require('./src/memory/runtime');
const createTaskHistoryRetention = deps => require('./src/native/runtime').getNative().createTaskHistoryRetention(deps);
const taskHistoryRefusal = error => require('./src/native/runtime').getNative().taskHistoryRefusal(error);
const { createChatHistoryRuntime, buildReplayMessages } = require('./src/routes/chat-history');
const { createTokenUsageRoutes } = require('./src/routes/token-usage');
const { createFleetSharing } = require('./src/fleet-sharing');
const { createSessionAdminRuntime } = require('./src/routes/session-admin');
const { createSessionTriggers } = require('./src/triggers');
const {
  createClaudeOAuthRefresher,
  DEFAULT_CHECK_INTERVAL_MS: CLAUDE_OAUTH_CHECK_INTERVAL_MS,
} = require('./src/claude-auth/oauth-refresh');
const {
  createCodexOAuthRefresher,
  DEFAULT_CHECK_INTERVAL_MS: CODEX_OAUTH_CHECK_INTERVAL_MS,
} = require('./src/codex/oauth-refresh');
const { parseClassifyResult, buildClassifySystemPrompt, classifyDisplay, phaseLabel } = require('./src/classify/vocab');
const { taskShortCode, initTaskShortCodeRegistry, readStoredPinIds } = require('./src/native/task-domain');
const { recordAdapterUserInput } = require('./src/chat/host-coordinator');
const { createProductionQuestionHost, createProductionWorkHost } = require('./src/session-work/host');
const { createHostPrompts, buildPlanProgressPrompt, markPlanContextReset } = require('./src/native/runtime').getHostPrompts();
const { createDispatchTargeting } = require('./src/dispatch/targeting');
const { createGatewayHost } = require('./src/dispatch/gateway-host');
const { createDispatchProgressSubscription } = require('./src/dispatch/progress');
const { createClassifyStateMachine } = require('./src/classify/state-machine');
const { createAuxRunLog } = require('./src/classify/aux-run-log');
const { createLivenessRuntime } = require('./src/liveness/runtime');
const { createProcessProbe } = require('./src/liveness/process-probe');
const { createRolloutPathResolver } = require('./src/liveness/rollout-path');
const { createProcessingWatchdog, PROCESS_WATCHDOG_INTERVAL_MS } = require('./src/chat/process-watchdog');
const { createStalledTurnRecovery, STALLED_RECOVERY_INTERVAL_MS } = require('./src/chat/stalled-turn-recovery');
const { createProviderLogWatchdog } = require('./src/chat/provider-log-watchdog');
const { createLogHousekeeping, LOG_HOUSEKEEPING_INTERVAL_MS } = require('./src/log-housekeeping');
const { createPushRuntime } = require('./src/push/runtime');
const { createWorkspaceRuntime } = require('./src/workspace/runtime');
const { TurnProgressHeartbeat, createTurnProgress } = require('./src/chat/turn-progress');
const { createBackgroundTaskRuntime } = require('./src/chat/background-task-runtime');
const { sharedTurnEventJournal } = require('./src/chat/turn-event-journal');
const { createTaskContextHost } = require('./src/task-context-host');
const { createUnattendedRuntime } = require('./src/unattended/runtime');
const {
  normalizeTurnRequest,
  planTurnAdmission,
  createDurableMessageProof,
  createProviderRouteProof,
  evaluateSpawnGuard,
  createTurnRuntimeStore, createProviderAttemptRuntime, createProviderRevision, scopeHostProviderEvent,
  createTurnLifecycle,
  createRunnerOwnership,
  createChatHostRuntime,
  assignKillReason,
  recordResultEvent,
  recordPartialCheckpoint,
  hasMatchingPartialCheckpoint,
  planTurnFinalization,
  createTurnFinalizationExecutor,
  createApiErrorPolicyRuntime,
  createApiErrorHost,
  retryNotice,
  sanitizeMessage: sanitizeApiErrorMessage,
  claudeErrorEnvelope,
} = require('./src/chat');
const {
  createErrorDto,
  createWsEnvelope,
  requestContext,
  toWaitDto,
  withApiMeta,
} = require('./src/native/runtime').getApiContract();
const {
  createAuthSecurity,
  normalizeRedirect,
  escapeHtmlAttribute,
} = require('./src/auth-security');
const { envEnabled, resolveNetworkPolicy, selectListenPort } = getNetworkPolicy();
const { isLocalRequest, isPrivateRequestPeer } = require('./src/request-locality');
const { createObservability, installConsoleRedaction } = require('./src/observability');
const { mountWsConnectionRouter } = require('./src/ws/connection-router');
const { mountServerCoreHostRoute } = require('./src/routes/server-core-host');
const { secureRuntimeData, atomicWriteJson, atomicWriteText, ensurePrivateDir } = require('./src/runtime-security');
const { createHostEnv } = require('./src/host-env');
// Windows keeps its startup PATH: widen it from install dirs + registry now.
const windowsEnv = require('./src/windows-env'); windowsEnv.prepare();
const MULTICC_PATHS = createPaths({ dataDir: process.env.MULTICC_DATA_DIR });
const providerRelayShares = createProviderRelayShareStore({ file: MULTICC_PATHS.providerRelaySharesFile }); initTaskShortCodeRegistry({ file: MULTICC_PATHS.taskShortCodesFile });
const MEMORY_STORE_ROOT = process.env.MULTICC_MEMORY_ROOT || path.join(__dirname, 'memories');
const chatHistoryRepository = getNative().chatHistoryFileRepositoryCreate({ root: MULTICC_PATHS.chatHistoryDir, reportFailure: stateStore.reportFailure });
const turnEventJournal = sharedTurnEventJournal(MULTICC_PATHS); const turnLedgerRuntime = require('./src/turn-ledger/runtime').createTurnLedgerRuntime({ dataDir: MULTICC_PATHS.root, codexCmd: () => cliCommands.codex }).start(); // 终端轮次账本：hook→spool→TurnLedger，影子模式只观测不接管状态
const auxRunLog = createAuxRunLog({ dir: MULTICC_PATHS.auxRunsDir, log: (event, detail) => console.warn(`[multicc/aux-run-log] ${event}`, detail) });
// One native owner holds the live chat-session, persisted-session and directory
// tables and the turn runtime store; created before anything reads them.
const stateOwner = createStateOwner();
const chatSessions = createChatSessions(stateOwner); const { wsHost, chatReplay } = createChatReplayRuntime(chatSessions);
// One Rust owner for the turn-progress state machines (heartbeat, timing, model
// timeline, delivery probes), wired below into the engine and its hosts.
const turnProgress = createTurnProgress();
chatSessions.setForgetHook(turnProgress.forgetSession);
let chatHistoryRuntime = null;
let chatHistoryService = null;
// This runtime deliberately owns preparation only. The established streaming
// and per-process runners keep their existing lifecycle after spawn is accepted.
const chatTurnPreparationRuntime = createTurnRuntimeStore({ owner: stateOwner });
let orchestrationRuntime = null; let sessionWorkHost = null; let sessionHibernationRuntime = null; let workspaceAdmission = null; let worktreeOrphanScanner = null;
const observability = createObservability({ service: 'multicc' });
const { logger, metrics } = observability; const messageSearchRuntime = () => getSharedSearchRuntime({ dataDir: MULTICC_PATHS.root, logger }); // 消息全文索引（src/search/runtime.js）：进程内单例、按数据目录记忆化，首个 message-search 请求或启动时那次 .start() 才真正建库开扫
const apiErrorPolicy = createApiErrorPolicyRuntime({ logger, metrics });
const routerToolHost = createRouterToolHost({
  express, isLocalRequest, logger,
  activeTurnForSession: id => chatSessions.get(id)?._activeTurn,
});
const turnProgressHeartbeat = new TurnProgressHeartbeat({
  owner: turnProgress.owner,
  logWarn: (message, error) => logger.warn(message, {
    error: error && error.message ? error.message : String(error),
  }),
  onHeartbeat(event) {
    const active = chatSessions.get(event.sessionId);
    if (!active || !active.isStreaming || active._activeTurn?.turnId !== event.turnId) {
      turnProgressHeartbeat.stop(event.sessionId, event.turnId);
      return;
    }
    metrics.inc('multicc_chat_progress_heartbeats_total');
    metrics.set('multicc_chat_silent_turn_seconds', Math.round(event.silentMs / 1000));
    logger.info('chat_progress_heartbeat', event);
    // Wire key is `heartbeatPhase`: `phase` was shared by three unrelated enums
    // (heartbeat / auto_route / route_event). Internally it is still `phase`.
    const { phase: heartbeatPhase, ...heartbeatRest } = event;
    chatBroadcast(event.sessionId, { ...heartbeatRest, type: 'progress_heartbeat', heartbeatPhase });
  },
});
function recordProviderRouterShadowComparison(report) {
  metrics.inc('multicc_provider_router_shadow_comparisons_total');
  if (!report || report.error) metrics.inc('multicc_provider_router_shadow_errors_total');
  if (report && !report.equal && !report.error) metrics.inc('multicc_provider_router_shadow_differences_total');
  const differences = Array.isArray(report && report.differences)
    ? report.differences.map(item => String(item && item.path || '')).filter(Boolean)
    : [];
  const fields = {
    operation: String(report && report.operation || 'unknown'),
    equal: !!(report && report.equal),
    differenceCount: differences.length,
    differencePaths: differences.slice(0, 100),
    binding: report && report.binding ? {
      sessionId: report.binding.sessionId,
      cli: report.binding.cli,
      providerId: report.binding.providerId,
      roleKind: report.binding.roleKind,
      agentRole: report.binding.agentRole,
      routeName: report.binding.routeName,
    } : null,
    error: report && report.error ? {
      code: report.error.code || null,
      message: 'CPR shadow evaluation failed',
    } : null,
  };
  if (report && report.equal) logger.info('provider_router_shadow_comparison', fields);
  else logger.warn(report && report.error ? 'provider_router_shadow_error' : 'provider_router_shadow_difference', fields);
}
const providerRouterRuntime = createProviderRouterRuntime({
  env: process.env,
  providers,
  keyAccounts: require('./src/cli-key-accounts').sharedCliKeyAccountStore(), // per-session Command Code/OpenCode API-key accounts, layered onto every child env
  dataRoot: MULTICC_PATHS.root,
  codexHomesDir: providers.CODEX_HOMES_DIR,
  onShadowDiff: recordProviderRouterShadowComparison,
  logger,
});
const agentResources = createAgentResourcesRuntime({
  fs,
  presetsFile: path.join(__dirname, 'public', 'agent-presets.json'),
  providers,
  providerRouter: providerRouterRuntime,
  listInstalledSkills,
  listClaudeHistory,
  removeClaudeHistorySession,
  reportError: (error, fields) => logger.error('agent_resources_failure', {
    ...fields,
    error: error && error.message,
  }),
});
const agentCommanderPrompt = agentResources.agentCommanderPrompt;
const agentCommanderPreset = agentResources.agentCommanderPreset;
logger.info('provider_router_runtime', {
  mode: providerRouterRuntime.mode,
  portApiVersion: providerRouterRuntime.apiVersion,
  routerApiVersion: providerRouterRuntime.routerApiVersion,
  capabilities: providerRouterRuntime.routerCapabilities || {},
});
installConsoleRedaction(console);
secureRuntimeData(MULTICC_PATHS);
const { airNotices } = require('./src/workspace/air-index-port');
airNotices.installStateStoreReporter(stateStore, { metrics, logger });
const networkPolicy = resolveNetworkPolicy(process.env);
const app = express();
app.locals.observability = observability;


// ── Access token authentication (cookie-based login) ──
// Rust owns the live token and shutdown state. Host persistence applies
// updates only after the .env write succeeds.
let fleetSharingRuntime = null;
const authSecurity = createAuthSecurity({ secret: networkPolicy.accessToken });
connectAuthControl(authSecurity);
const machines = require('./src/machines').createMachineRuntime({ root: MULTICC_PATHS.root, authSecurity, getWss: () => wss });
const ALLOW_LEGACY_TOKEN_QUERY = envEnabled(process.env.MULTICC_ALLOW_LEGACY_TOKEN_QUERY);
const ALLOW_LEGACY_WS_TOKEN = envEnabled(process.env.MULTICC_ALLOW_LEGACY_WS_TOKEN);
const ALLOW_LEGACY_WS_COOKIE = envEnabled(process.env.MULTICC_ALLOW_LEGACY_WS_COOKIE);

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  }
  return cookies;
}

app.use(requestIdMiddleware, require('./src/http/json-compression').jsonCompression);
routerToolHost.mount(app);
// Auth gates shutdown, login and scoped grants.
// It stays mounted before every API/relay route so mutable credentials apply
// Downstream routes cannot bypass authentication.
// authSecurity.accessToken() and shutdown state are read lazily on each request.
const authRuntime = createAuthRuntime({
  express,
  authSecurity,
  isLocalRequest, isRequestPeerAllowed: req => !networkPolicy.lanOnly || isPrivateRequestPeer(req),
  parseCookies,
  normalizeRedirect,
  escapeHtmlAttribute,
  metrics,
  logger,
  createErrorDto,
  getAccessToken: () => authSecurity.accessToken(),
  getShuttingDown: () => authSecurity.shuttingDown(),
  authorizeScopedRequest: req => machines.authorize(req) || fleetSharingRuntime?.authorizeRequest({ token: req.headers['x-multicc-fleet-token'], grant: req.headers['x-multicc-fleet-grant'], method: req.method, pathname: req.originalUrl }) === true, authorizeProviderRelayRequestAsync: input => providerRelayShares.authorize(input),
  allowLegacyTokenQuery: ALLOW_LEGACY_TOKEN_QUERY,
});
authRuntime.mountRoutes(app);
// 借道模型与配额公开入口由 Rust 前门接管；Node 装配授权、目录与额度宿主事实。
const providerRelayModelCatalogRuntime = createProviderRelayModelCatalogRuntime({
  providers,
  codexModelsRuntime: codexCatalog,
  logger,
});

let serviceReady = false;
const commanderMigrationState = createCommanderMigrationState();
let PORT = networkPolicy.port;
const BIND_HOST = networkPolicy.host;
const server = http.createServer(app);
const lanDiscovery = createLanDiscoveryRuntime({ readState: () => ({ host: BIND_HOST, port: PORT, allowRemote: networkPolicy.allowRemote, accessToken: authSecurity.accessToken(), listening: server.listening, shuttingDown: authSecurity.shuttingDown() }), logger });
const wss = new WebSocket.Server({ noServer: true }); // upgrades dispatched by voice-host wireUpgrade (voice WS -> proxy, chat WS -> wss)
const isWindows = process.platform === 'win32';

const CLAUDE_ARGS = process.env.CLAUDE_ARGS ? process.env.CLAUDE_ARGS.split(' ') : [];
const CLAUDE_CHAT_DISALLOWED_TOOLS = (process.env.CLAUDE_CHAT_DISALLOWED_TOOLS ?? 'AskUserQuestion')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Rust supplies the Codex constraints and the web-chat hint.
const {
  codexEnvConstraint: CODEX_ENV_CONSTRAINT,
  codexStayAlivePrompt: CODEX_STAY_ALIVE_PROMPT,
  multiccImgHint: MULTICC_IMG_HINT,
  userInputReminder: USER_INPUT_REMINDER,
} = createHostPrompts(process.env, { assistRoot: MULTICC_PATHS.assistDir });
// Always-on: route claude-official (OAuth-subscription) sessions THROUGH the
// proxy by replaying the macOS Keychain OAuth token, enabling subagent routing
// on official sessions (⚠️ replays subscription OAuth outside the official
// client — ToS + shared-Keychain considerations). No longer user-toggleable.
const CLAUDE_OFFICIAL_VIA_PROXY = true;
// Keep CPR's official Claude branch in sync with the host default.
process.env.CLAUDE_OFFICIAL_VIA_PROXY = '1';

// Model/provider display and effort policy is independent from process runners.
// It reads user defaults on demand so /model and CLI config changes are visible
// without restarting the host.
const sessionPolicy = createSessionPolicy({
  fs,
  env: process.env,
  homeDir: os.homedir,
  providers,
  providerRouter: providerRouterRuntime,
  // Session-record model picks feed the default rule (lazy: the map exists below).
  records: () => persistedSessions,
});
const {
  effectiveSessionModel,
  serializeSubagent,
  providerDefaultModel,
  sessionProviderName,
  sessionProviderBaseUrl,
  normalizeEffort,
  validEffortForCli,
  cliEffortLevel,
  codexReasoningLevel,
  codexReasoningConfigArg,
  codexModelConfigArg,
  codexDefaultReasoningLevel,
  effectiveSessionEffort,
  effortLabel,
  normalizeCliAgent,
  isCodexResponseCompletedDisconnect,
  isCodexTransportDisconnect,
  codexStreamDisconnectContinuePrompt,
  isGlm52Session,
  CODEX_STREAM_DISCONNECT_CONTINUE_MAX,
} = sessionPolicy;
const CODEX_ARGS = process.env.CODEX_ARGS ? process.env.CODEX_ARGS.split(' ') : [];

// ── CLI provider abstraction ──
// Each provider knows how to (1) build the interactive terminal command line for tmux,
// (2) build chat-mode spawn args, (3) parse one line of streamed JSON output.
// Chat-mode parse output schema: { kind: 'text'|'tool'|'tool_result'|'result'|'system'|'thread', ... }

// Debug helper: dump the full `claude -p` argv (long prompt / system-prompt
// values truncated) every time we invoke the CLI, so model-routing / provider
// issues (e.g. a relay 10404 on a wrong model id) can be traced in pm2 logs.
// Grep `[multicc/chat] claude -p`.
function debugLogClaudeInvoke(session, args) {
  try {
    const sid = (session && (session.id || session.cliSessionId)) || '-';
    const provider = (session && session.provider) || '';
    const redacted = (args || []).map((a, i) => {
      if (typeof a !== 'string') return a;
      const prev = args[i - 1];
      // Truncate the system-prompt value and any over-long literal (the prompt).
      if ((prev === '--append-system-prompt' || a.length > 160)) {
        return a.length > 160 ? a.slice(0, 160) + `…(+${a.length - 160} chars)` : a;
      }
      return a;
    });
    console.log(`[multicc/chat] claude -p invoke [${sid}] provider=${provider || '<default>'} argv: ${redacted.join(' ')}`);
  } catch (_) {}
}

const { vendorLoginTerminalCmd, cliForLoginFlow } = require('./src/cli-adapters/vendor-login'); const { commands: cliCommands, registry: cliAdapterRegistry } = createCliAdapters({
  isWindows,
  claudeArgs: CLAUDE_ARGS,
  claudeChatDisallowedTools: CLAUDE_CHAT_DISALLOWED_TOOLS,
  codexArgs: CODEX_ARGS,
  codexEnvConstraint: CODEX_ENV_CONSTRAINT,
  codexStayAlivePrompt: CODEX_STAY_ALIVE_PROMPT,
  multiccImgHint: MULTICC_IMG_HINT,
  userInputReminder: USER_INPUT_REMINDER,
  resolveSessionWireModel: providerRouterRuntime.resolveSessionWireModel,
  cliEffortLevel,
  normalizeEffort,
  codexReasoningConfigArg,
  codexModelConfigArg,
  codexReasoningLevel,
  debugLogClaudeInvoke,
  isCodexResponseCompletedDisconnect,
  isCodexTransportDisconnect,
});
const CLAUDE_CMD = cliCommands.claude;

function cliCommandAvailable(command) {
  return require('./src/cli-adapters/commands').isCommandAvailable(command, { isWindows });
}

// Re-resolve when the environment moved: a just-installed CLI must show up.
const commandsForAvailability = require('./src/cli-adapters/commands').createCommandResolver({ isWindows, seed: cliCommands });
const { bundledClaudeCodeBinary } = require('./src/cli/claude-bundled-binary');

// `claude` chat runs the bundled Agent SDK binary (or a Remote CLI relay), not PATH `claude`.
function claudeLaneAvailable() { try { return bundledClaudeCodeBinary() != null || providers.hasCliRelayProvider('claude'); } catch (_) { return false; } }

function cliAvailabilitySummary() {
  const commands = commandsForAvailability();
  const out = {};
  for (const cli of CLIENT_CHAT_CLIS) {
    out[cli] = { available: cli === 'claude' ? claudeLaneAvailable() : cliCommandAvailable(commands[cli]) };
  }
  return out;
}

function providerFor(session) {
  return cliAdapterRegistry.get(session?.cli);
}

// ── tmux helpers (extracted to src/tmux.js) ──
// Pure primitives, destructured so existing call sites are unchanged. The
// stateful recoverTmuxSessions() (below) stays — it rebuilds core session state.
const {
  TMUX_PREFIX, tmuxSessionName, tmuxListSessions, tmuxHasSession, tmuxCreateSession, tmuxResize,
  applyMaxClientSize, tmuxKillSession, tmuxCaptureSnapshot, tmuxPaneTty, tmuxPaneActivity,
  tmuxWriteInput, startOutputCapture, stopOutputCapture,
} = require('./src/tmux');

// Recover existing tmux sessions on startup (survives server restart)
async function recoverTmuxSessions() {
  try {
    const names = await tmuxListSessions();
    for (const name of names) {
      if (!name || !name.startsWith(TMUX_PREFIX)) continue;
      const id = name.slice(TMUX_PREFIX.length);
      if (sessions.has(id)) continue;
      // Only recover sessions we know about (post-migration). Orphan tmux sessions
      // are left alone — user can kill them via `tmux kill-session` if unwanted.
      const persisted = persistedSessions.get(id);
      if (!persisted || persisted.kind !== 'terminal') continue;
      // Sessions whose directory is invalid ($HOME / duplicate path) are not recovered.
      if (invalidSessions.has(id)) {
        console.warn(`[multicc] skipping recovery of ${id}: ${invalidSessions.get(id)}`);
        continue;
      }
      console.log(`[multicc] Recovering tmux session: ${id} (${persisted.cli})`);
      try {
        await createSession(id);
      } catch (err) {
        console.error(`[multicc] Failed to recover session ${id}:`, err.message);
      }
    }
  } catch (_) {
    // tmux server not running — nothing to recover
  }
}

// ── git worktree helpers ──
// Every session runs in an isolated git worktree under <dir>/.multicc-worktrees/<sessionId>
// on its own branch `multicc/<sessionId>`. Work is collected back via an explicit merge.
// Git + worktree ops extracted to src/git.js. Pure functions, destructured so
// existing call sites are unchanged. The stateful bits stay here in server.js.
const {
  WORKTREE_SUBDIR, gitRun, gitIsRepo, gitHasCommit, gitBaseBranch, gitEnsureExcluded,
  gitWorktreeAdd, gitWorktreeDetach, gitWorktreeValidate, gitWorktreeRollbackCreate, gitWorktreeRemove, gitRelocateWorktree, gitWorktreeMergeState, gitMergeBack,
  gitSyncFromBase, gitRebaseResolve, gitWorktreeSnapshot, gitExportSessionBundle,
  gitImportSessionBundle, defaultRepoActor,
} = require('./src/git/service');
const { slotOwnsWorktree } = require('./src/task-worktree');

// RepoActor operations are retained in a bounded in-memory history. Destructive
// endpoint responses include operationId; callers can inspect progress and the
// observed queue depth here without polling child processes themselves.

const gitReadyDirs = new Set();          // dir.id once its repo is verified/initialised
const invalidSessions = new Map();       // sessionId → reason; recovery is skipped for these

// Directory suitability + path helpers extracted to src/directories.js, destructured
// so existing call sites are unchanged; ensureDirGitReady() stays below in server.js.
const {
  isHomeOrAbove, realPathOf, dirSuitability, friendlyDirReason, dirReasonFix, directoryWriteDenied, describeDirFailure,
} = require('./src/directories');

// Make sure a directory is a usable git repo; refuses $HOME and missing paths.
// The write probe comes first: on a TCC-protected path macOS denies the
// directory itself, and finding that out here names the problem without ever
// spawning git — whose own failure ("unable to get current working directory")
// tells the user nothing and repeats on every registration.
async function ensureDirGitReady(dir) {
  if (gitReadyDirs.has(dir.id)) return { ok: true };
  if (isHomeOrAbove(dir.path)) return { ok: false, reason: 'home-or-above' };
  if (!fs.existsSync(dir.path)) return { ok: false, reason: 'path-missing' };
  if (directoryWriteDenied(dir.path)) return { ok: false, reason: 'permission-denied: ' + dir.path };
  try {
    // Reject pathological dirs BEFORE any mutating git command. This check also
    // uses the asynchronous repository actor for existing repositories.
    const fit = await dirSuitability(dir.path);
    if (!fit.ok) return { ok: false, reason: 'unsuitable: ' + fit.reason };
    if (!await gitIsRepo(dir.path)) {
      console.log(`[multicc] git init: ${dir.path}`);
      await gitRun(dir.path, ['init']);
    }
    await gitEnsureExcluded(dir.path);
    if (!await gitHasCommit(dir.path)) {
      try { await gitRun(dir.path, ['add', '-A']); } catch (_) {}
      await gitRun(dir.path, ['commit', '--allow-empty', '-m', 'chore: initialize repository']);
    }
    dir.baseBranch = await gitBaseBranch(dir.path);
    dir.gitInitialized = true;
    gitReadyDirs.add(dir.id);
    return { ok: true };
  } catch (e) {
    // Reachable when the probe passed but git was denied anyway (the denial can
    // sit on a parent path git has to resolve). Same user-facing conclusion, so
    // it travels as the same reason code.
    if (e && e.code === 'GIT_PERMISSION_DENIED') return { ok: false, reason: 'permission-denied: ' + (e.path || dir.path) };
    return { ok: false, reason: 'git-error: ' + e.message };
  }
}

// ── Directory + session persistence ──
// Schema: directories.json / sessions.json; old flat schemas auto-migrate on first load.
// Paths flow through MULTICC_PATHS (MULTICC_DATA_DIR relocates them).
const SESSIONS_FILE = MULTICC_PATHS.sessionsFile;
const DIRECTORIES_FILE = MULTICC_PATHS.directoriesFile;

// One native owner holds the live session table, the live directory table and
// the cross-file state journal. Boot replay and the legacy migration both use
// it, so directories.json and sessions.json have exactly one writer.
stateOwner.configure({
  stringify: JSON.stringify,
  root: MULTICC_PATHS.root,
  directoriesFile: DIRECTORIES_FILE,
  sessionsFile: SESSIONS_FILE,
  journalDir: MULTICC_PATHS.journalDir,
  now: Date.now,
});

// State bootstrap owns the session store, journal replay, fail-closed recovery
// and the one-time legacy paired-session migration. Directories are loaded
// straight into the native table; the boot session Map is read once and dropped.
const stateBootstrap = bootstrapState({
  fs,
  stateOwner,
  paths: MULTICC_PATHS,
  chatHistoryRepository,
  randomUUID: crypto.randomUUID,
  logger: console,
});
const _state = stateBootstrap.state;
// Boot import adapters: the native owner decoded sessions.json and already
// holds the directory table. Neither source Map remains
// a second live table.
const persistedSessions = createSessionRecords(_state.persistedSessions, stateOwner);
// The native load-time normalizer may have renamed `_streamSessionId` to
// `cliSessionId` on a live record (M4); the boot save below persists it.
if (persistedSessions.loadMigrated) _state.needsSave = true;
const directories = createDirectoryTable(stateOwner);
mountPublicSessionAccessGuard(app, { records: persistedSessions, logger, v1NotFound: (req, res) => v1Error(req, res, 404, 'session not found', 'session_not_found') });

// 供应商余量共享缓存：写入成功后向使用该线路的会话同步展示快照。
const { providerQuotaHistory, providerLimitCache, limitRecorder, quotaBarCache, quotaGuard } = require('./src/quota/provider-runtime').createProviderQuotaRuntime({ paths: MULTICC_PATHS, persistedSessions, providers, broadcast: (id, data) => chatBroadcast(id, data), logger });
// The native owner writes sessions.json itself (same envelope, `.bak1..3`
// rotation, file+directory fsync). It honours the same isolated-test failure
// marker inside a temporary MULTICC_DATA_DIR, under NODE_ENV=test only.
const sessionPersistence = createSessionPersistence({
  records: persistedSessions,
  file: SESSIONS_FILE,
  kind: 'sessions',
  root: MULTICC_PATHS.root,
  retryDelayMs: Math.max(50, Number(process.env.MULTICC_SESSION_PERSISTENCE_RETRY_MS) || 500),
  maxRetries: 3,
  onFailure: airNotices.sessionPersistenceOnFailure({ metrics, logger }),
  onState: ({ dirty, retryAttempt, retryScheduled }) => {
    metrics.set('multicc_session_persistence_dirty', dirty ? 1 : 0);
    metrics.set('multicc_session_persistence_retry_attempt', retryAttempt);
    metrics.set('multicc_session_persistence_retry_scheduled', retryScheduled ? 1 : 0);
  },
});

function savePersistedSessionsBestEffort(source) {
  return sessionPersistence.bestEffort(source);
}

// Runtime-reported model discovery is intentionally composed after the
// persisted session map and its best-effort writer exist. The policy module is
// pure with respect to host state; this adapter owns the two side effects that
// update the active CLI snapshot and persist the discovered model.
const reportedModelRuntime = createReportedModelRuntime({
  fs,
  homeDir: os.homedir,
  records: persistedSessions,
  effectiveSessionModel,
  rememberActiveCliState,
  saveBestEffort: savePersistedSessionsBestEffort,
  log: message => console.log(message),
});
const noteReportedModel = reportedModelRuntime.note;
const backfillReportedModels = reportedModelRuntime.backfill;

// Schema vNext: preserve one native session/settings snapshot per CLI. Legacy
// records keep their active top-level fields for backward compatibility; the
// map is hydrated from those fields once and then maintained on every switch.
for (const session of persistedSessions.values()) {
  if (require('./src/providers/official-catalog').normalizeOfficialSessionReferences(session, providers.normalizeOfficialProviderId)) _state.needsSave = true;
  if (ensureCliStates(session)) _state.needsSave = true;
}

// The Rust directory module shares the boot-loaded table with the session owner.
const { createDirectoryModule } = require('./src/routes/directory-host');

// Directories own tasks; registering one never seeds a role execution/worktree.
async function seedCommanderSession(dir) {
  commanderMigrationState.setDirectory(dir.id, { status: 'ready', action: 'task-first' });
  return { ok: true, skipped: true };
}

// Session and directory disposal share this history-protected teardown.
async function destroySessionCascade(s, d, opts = {}) {
  if ([...persistedSessions.values()].some(r => r.workspaceOwnerSessionId === s.id) || s.retiredWorktrees?.length) return { ok: false, blocked: true, code: 'shell_workspace_referenced', reasons: ['shell_workspace_referenced'] };
  try { chatHistoryService?.assertCanDeleteSession(s.id); }
  catch (error) { return taskHistoryRefusal(error); }
  const active = sessions.get(s.id), chat = chatSessions.get(s.id);
  let removal = null;
  // Remove the worktree before tearing down runtime/persistence. A default
  // dirty/unmerged refusal therefore leaves the session completely intact.
  // M3: a slot stamped onto a task worktree never owns it — deletion must keep
  // the task's worktree alive for the task's own one-click cleanup.
  if (s.worktreePath && s.branch && slotOwnsWorktree(s)) {
    try {
      removal = await gitWorktreeRemove(d.path, s.worktreePath, s.branch, {
        sessionId: s.id, baseBranch: d.baseBranch, force: !!opts.force,
        activeCheck: null,
      });
    } catch (error) {
      const reason = error.code === 'SESSION_ACTIVE' ? 'active'
        : (error.code === 'SESSION_LEASED' ? 'leased' : null);
      if (!reason) throw error;
      return { ok: false, blocked: true, reasons: [reason], operationId: error.operationId,
        queueDepth: error.queueDepth, error: error.message };
    }
    if (!removal.ok) return removal;
  }
  if (active) {
    if (active.exitCheckTimer) clearInterval(active.exitCheckTimer);
    if (active.captureTimer) { clearInterval(active.captureTimer); active.captureTimer = null; }
    cleanupPushMonitor(s.id);
    await stopOutputCapture(active);
    await tmuxKillSession(s.id);
    for (const client of active.clients || []) try { client.terminate(); } catch (_) {}
    sessions.delete(s.id);
  }
  if (chat) {
    assignKillReason(chat._activeRunner, 'session_delete'); if (chat._activeRunner?.providerAttempt) providerAttemptRuntime.finishAttempt(chat._activeRunner.providerAttempt, { outcome: 'failed', errorCategory: 'cancelled', reasonCode: 'session_delete' }); backgroundTaskRuntime.reapSessionShadows(s.id, { reason: 'session_delete' });
    if (chat.claudeProc) try { chat.claudeProc.kill('SIGTERM'); } catch (_) {}
    chatStream.close(s.id);
    chatReplay.drop(s.id);
    chatSessions.delete(s.id);
  }
  backgroundTaskRuntime.stopSession(s.id);
  waitInjector.cancelForSession(s.id);
  if (orchestrationRuntime) await orchestrationRuntime.cancelForSession(s.id);
  share.removeForSession(s.id);
  // 删除走历史 FIFO：入队只标记“正在删除”，不取消任何已接受的写入；删除
  // 排在在飞步骤之后、未开始写入之前。队首执行成功才落墓碑并取消后面的
  // job；被拒则撤销标记，排队的写入照常执行。上面的预判已在入队前把多数
  // 拒绝挡掉，这里的重复判定只处理入队后状态变化。
  try { await chatHistoryRuntime.removeSession(s.id); }
  catch (error) {
    chatHistoryService.invalidate(s.id);
    logger.warn('chat_history_delete_failed', { sessionId: s.id, error: error.message });
  }
  teardownTriggers(s.id);
  purgeNotesForSession(s.id);
  if (opts.removeRecord !== false) persistedSessions.delete(s.id);
  invalidSessions.delete(s.id);
  workspaceStatus.delete(s.id);
  return {
    ok: true,
    operationId: removal?.operationId || null,
    queueDepth: removal?.queueDepth || 0,
    backup: removal?.backup || null,
  };
}

// Notes/events store (src/notes-store.js): event ring + append-only per-dir
// logs and the shared inter-agent notes pool. Owns its mutable `notes` array
// (never exported by reference) and hydrates it here at boot, exactly where the
// inline loadNotes() ran before extraction. Created before every consumer —
// seedCommanderSession/destroySessionCascade/directoryModule all take
// appendEvent/purgeNotesForSession by value. The events route itself is served
// by the Rust front door; src/routes/docs-memory-host.js only answers its
// `notes-events` host lookup against the directory map composed below.
const notesStore = createNotesStore({
  eventsDir: MULTICC_PATHS.eventsDir,
  notesFile: MULTICC_PATHS.notesFile,
  persistedSessions,
  directories,
  atomicWriteJson,
  ensurePrivateDir,
  getWorkspaceBroadcast: () => workspaceBroadcast,
  // The recent-event ring lives in the native workspace socket owner; this
  // store keeps only the lazy JSONL read and the append.
  getWorkspaceEvents: () => workspaceRuntime.events,
});
const {
  loadNotes,
  saveNotes,
  recentEvents,
  appendEvent,
  pendingNotesFor,
  purgeNotesForSession,
} = notesStore;
loadNotes();

const directoryModule = createDirectoryModule({
  repository: { file: DIRECTORIES_FILE, map: directories, owner: stateOwner, uiLayoutFile: MULTICC_PATHS.uiLayoutFile },
  git: {
    baseBranch: gitBaseBranch,
    pushState: (p, b, o) => gitPush.directoryPushState(p, b, o),
    push: (p, b) => gitPush.pushDirectory(p, b),
    invalidatePushCache: (p, b) => gitPush.invalidate(p, b),
    statusPorcelain: (p) => gitRunQueued(p, ['status', '--porcelain'], { raw: true }),
    stageAll: (p) => gitRunQueued(p, ['add', '-A']),
    commit: (p, m) => gitRunQueued(p, ['commit', '-m', m]),
    ensureReady: ensureDirGitReady,
    unmarkReady: (id) => { gitReadyDirs.delete(id); },
  },
  sessions: {
    listByDir: (dirId) => persistedSessions.listByDir(dirId),
    seedCommander: dir => { folderMemory.ensureShared(dir.id); return seedCommanderSession(dir); },
    destroyCascade: destroySessionCascade,
  },
  events: { append: appendEvent },
  fsPort: {
    homedir: () => os.homedir(),
    exists: (p) => fs.existsSync(p),
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } },
    mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); }, sampleRoot: () => MULTICC_PATHS.sampleWorkspacesDir,
    readDirents: (p) => fs.readdirSync(p, { withFileTypes: true })
      .map(e => ({ name: e.name, isDirectory: e.isDirectory(), isSymbolicLink: e.isSymbolicLink() })),
    writeFileExclusive: (p, content) => { try { fs.writeFileSync(p, content, { flag: 'wx' }); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } },
  },
  helpers: { resolveCwd, isHomeOrAbove, realPathOf, friendlyDirReason, dirReasonFix },
  // The native owner snapshots both live tables and writes the journal + both
  // files itself; boot replay finishes a torn delete rather than leaving the
  // two files inconsistent (dir deleted + its sessions still pointing at
  // nothing, or vice versa).
  tx: {
    commitCrossFileWrite: spec => stateOwner.commitCrossFileWrite(spec),
  },
});
function saveDirectories() { directoryModule.repo.save(); }
if (_state.needsSave) {
  saveDirectories();
  sessionPersistence.mutate('startup.schema-migration', () => {});
  console.log(`[multicc] Migration complete: ${directories.size} directories, ${persistedSessions.size} sessions`);
}

const initWorktrees = () => initializeSessionWorktrees({ records: persistedSessions, directories, invalidSessions,
  realPathOf, isHomeOrAbove, ensureDirGitReady, addWorktree: gitWorktreeAdd, existsSync: fs.existsSync,
  tmuxHasSession, tmuxKillSession, saveDirectories, saveSessions: savePersistedSessionsBestEffort,
  auxSessionId: AUX_SESSION_ID, log: console });
function cwdForSession(session) {
  const cwd = resolveSessionCwd(session, { directories, dataRoot: MULTICC_PATHS.root, existsSync: fs.existsSync, homeDir: os.homedir, moduleDir: __dirname });
  if (session?.type === 'gateway') try { fs.mkdirSync(cwd, { recursive: true }); } catch (_) {}
  return cwd;
}

// Dispatch targeting: sibling list and Commander prompt over live registry,
// chat state, effort and the canonical busy predicate.
//
const {
  dispatchTargetHintFor,
  buildDispatchContextPrompt,
} = createDispatchTargeting({ records: persistedSessions, chatSessions, normalizeEffort, isTargetBusy: dispatchTargetBusy, pendingUserInput, boundTaskTitleFor: id => taskBoardRuntime?.getBoard()?.tasks?.[id]?.title || '' });

// Gateway/dispatch orchestration (src/dispatch/gateway-host.js): the gateway
// system prompt, confirm/cancel control, dispatch admission and the turn-end
// marker sweep live behind createGatewayHost. Composed here — right where the
// inline block sat — so relative boot order vs every consumer is unchanged;
// late-bound host pieces (orchestrationRuntime/taskContextHost/createSessionRecord)
// resolve per call through getters, and the gateway-turn / dispatch-complete bus
// subscriptions stay exactly one instance.
const gatewayHost = createGatewayHost({
  persistedSessions, chatSessions, directories, logger,
  getChatHistoryService: () => chatHistoryService,
  appendEvent, normalizeEffort, dispatchTargetHintFor, cwdForSession,
  getSetSessionStatus: () => setSessionStatus, isTargetBusy: dispatchTargetBusy,
  getSessionDelivery: () => sessionDelivery,
  getOrchestrationRuntime: () => orchestrationRuntime,
  getTaskContextHost: () => taskContextHost,
  getCreateSessionRecord: () => createSessionRecord,
  appendChatMessage: (...args) => appendChatMessage(...args),
  chatBroadcast: (...args) => chatBroadcast(...args),
});
const {
  GATEWAY_ID,
  buildGatewayPrompt,
  pushToGateway,
  handleGatewayControl,
  recordRouterAdmission,
  dispatchToSession, cancelDispatchRun,
} = gatewayHost;

// ── Session management ──
// { id, tmuxName, ttyPath, outputStream, fifoPath, clients: Set<ws>, createdAt, lastActivity, cwd, exitCheckTimer }
const sessions = new Map();

// Publish the three core Maps to the shared state registry (same references).
// Extracted modules read these via require('./src/state/container') — no bespoke injection.
Object.assign(state, { sessions, directories, persistedSessions });

function generateId() {
  let id = '';
  while (id.length < 8) id += Math.random().toString(36).slice(2);
  return id.slice(0, 8);
}

function sessionIdPrefixForDirectory(dir) {
  const raw = (dir?.name || path.basename(dir?.path || '') || 'dir').toString();
  const safe = raw
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return safe || 'dir';
}

function allocateSessionId(dir, cli, kind) {
  const prefix = sessionIdPrefixForDirectory(dir);
  const cliPart = SUPPORTED_CHAT_CLIS.includes(cli) ? cli : 'claude';
  const kindPart = kind === 'chat' ? 'chat' : 'term';
  const stem = `${prefix}-${cliPart}-${kindPart}`;
  let maxSeq = 0;
  for (const s of persistedSessions.values()) {
    if (s.dirId !== dir.id) continue;
    const m = String(s.id || '').match(new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`));
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]) || 0);
  }
  for (let seq = maxSeq + 1; seq < maxSeq + 1000; seq++) {
    const id = `${stem}-${String(seq).padStart(2, '0')}`;
    if (!persistedSessions.has(id)) return id;
  }
  // Extremely unlikely fallback: keep the readable prefix and add a short entropy tail.
  let id;
  do {
    id = `${stem}-${generateId()}`;
  } while (persistedSessions.has(id));
  return id;
}

function resolveCwd(current, arg) {
  if (!arg || arg === '~') return os.homedir();
  if (arg.startsWith('~/') || arg.startsWith('~\\')) return path.join(os.homedir(), arg.slice(2));
  return path.resolve(current, arg);
}

async function createSession(id) {
  // REST creates sessions.
  const persisted = persistedSessions.get(id);
  if (!persisted) {
    throw new Error(`Session ${id} has no persisted record. Create it via /api/directories/:id/sessions first.`);
  }
  if (persisted.type === 'aux' || persisted.type === 'gateway') {
    throw new Error(`Session ${id} is a system session, not a terminal`);
  }
  if (persisted.kind && persisted.kind !== 'terminal') {
    throw new Error(`Session ${id} is kind=${persisted.kind}, not a terminal`);
  }
  if (invalidSessions.has(id)) {
    throw new Error(`Session ${id} is invalid: ${invalidSessions.get(id)}`);
  }

  let cwd = cwdForSession(persisted);
  if (!cwd || !fs.existsSync(cwd)) {
    if (cwd) console.warn(`[multicc] cwd "${cwd}" not found, falling back to home dir`);
    cwd = os.homedir();
  }

  const provider = providerFor(persisted);
  // tmux uses the session capability, not a raw id.
  const routeSession = terminalProxyRoutes.sessionSegment(persisted);
  const provEnv = providerRouterRuntime.resolveSpawnEnv(persisted);
  const termEnv = { ...provEnv.env, ...(persisted.loginEnv || {}) }; secretsVault.applyEnvOverlay(termEnv, { source: 'terminal', sessionId: persisted.id }); // loginEnv: allowlisted login-terminal pins (sanitizeLoginEnv), e.g. CODEX_HOME=<account dir>; 保险箱条目按名注入 env（set-if-absent，见 src/secrets-vault.js）
  // 登录走官方浏览器授权，忽略继承的 API Key。
  if (persisted.loginFlow === 'commandcode-login') termEnv.COMMAND_CODE_API_KEY = '';
  if (persisted.cli === 'claude') {
    for (const k of providers.CLAUDE_ROUTING_KEYS) {
      if (!(k in termEnv)) termEnv[k] = '';
    }
    providers.applyClaudeProxyEnv(termEnv, { // 交互式 tmux claude 也走 per-session/per-role 代理
      providerId: persisted.provider, sessionId: routeSession,
      subagent: persisted.subagent, port: PORT,
      officialOAuth: CLAUDE_OFFICIAL_VIA_PROXY,
    });
  } else if (persisted.cli === 'codex') {
    providers.applyCodexProxyConfig(termEnv, {
      providerId: persisted.provider, sessionId: routeSession,
      subagent: persisted.subagent, port: PORT,
    });
  }

  // Claude: pre-allocate a stable UUID so chat-mode `--resume` works. Codex: capture
  // cliSessionId by scanning ~/.codex/sessions after the process boots.
  if (provider.name === 'claude' && !persisted.cliSessionId) {
    persisted.cliSessionId = crypto.randomUUID();
    savePersistedSessionsBestEffort('runtime.terminal-session-id');
  }

  // Create tmux session if it doesn't already exist (it may survive server restarts)
  let isRecovery = false;
  const launchTime = Date.now();
  if (!await tmuxHasSession(id)) {
    console.log(`[multicc] Creating tmux session: ${tmuxSessionName(id)} in ${cwd} (${provider.name} session: ${persisted.cliSessionId || '<pending>'})`);
    const launchSession = provEnv.qualifiedModel ? { ...persisted, model: provEnv.qualifiedModel } : persisted;
    // Login flows run the CLI's own interactive login command, not the TUI.
    const loginCmd = persisted.loginFlow === 'codex-login' ? `${cliCommands.codex} login`
      : persisted.loginFlow === 'claude-auth-login' ? `${cliCommands.claude} auth login` : vendorLoginTerminalCmd(persisted.loginFlow, cliCommands);
    const terminalCmd = loginCmd || provider.buildTerminalCmd(turnLedgerRuntime.prepareTerminal(launchSession || {}, termEnv));
    await tmuxCreateSession(id, cwd, 80, 24, terminalCmd, termEnv);
  } else {
    console.log(`[multicc] Attaching to existing tmux session: ${tmuxSessionName(id)}`);
    isRecovery = true;
  }

  // Get the tty device path for direct input writes
  const ttyPath = await tmuxPaneTty(id);

  // Start output capture via pipe-pane → FIFO
  const { stream, fifoPath } = await startOutputCapture(id);

  const session = {
    id,
    cli: provider.name,
    cliSessionId: persisted.cliSessionId || null,
    dirId: persisted.dirId,
    tmuxName: tmuxSessionName(id),
    ttyPath,
    outputStream: stream,
    fifoPath,
    clients: new Set(),
    primaryClient: null,
    // Tmux pane size = max(cols) × max(rows) across all attached clients.
    // Each ws stores its desired cols/rows on itself (ws._desiredCols/Rows).
    // appliedCols/Rows = the size we last actually pushed to tmux, used to skip no-op resizes.
    appliedCols: 0,
    appliedRows: 0,
    createdAt: persisted ? new Date(persisted.createdAt) : new Date(),
    lastActivity: (isRecovery && await tmuxPaneActivity(id)) || new Date(),
    // Provider this process was actually spawned with; undefined when we only re-attached
    // (then the persisted record is the best we know). /api/air route_dead reads it.
    spawnedProvider: isRecovery ? undefined : (persisted?.provider || null),
    cwd,
    exitCheckTimer: null,
  };

  if (provider.needsAsyncSessionIdCapture && !persisted.cliSessionId && !isRecovery) {
    const root = provEnv.codexHome && path.join(provEnv.codexHome, 'sessions');
    const timer = pollCodexSessionId(
      () => sessionPolicy.findCodexSessionId(cwd, launchTime - 2000, root),
      () => session.captureTimer === timer && sessions.get(id) === session
        && persistedSessions.get(id) === persisted && !persisted.cliSessionId,
      (captured, error) => {
        session.captureTimer = null;
        if (!captured) {
          console.warn(`[multicc] Failed to capture codex session id for ${id}: ${error?.message || 'no match after 30s'}`);
          return;
        }
        persisted.cliSessionId = session.cliSessionId = captured;
        savePersistedSessionsBestEffort('timer.codex-session-id-capture');
        console.log(`[multicc] Captured codex session id for ${id}: ${captured}`);
      });
    session.captureTimer = timer;
  }

  // Output stream → broadcast to all WebSocket clients
  const utf8Decoder = new StringDecoder('utf8');
  stream.on('data', (data) => {
    const str = utf8Decoder.write(data);
    if (!str) return; // partial UTF-8 character buffered, wait for more bytes
    session.lastActivity = new Date();
    broadcastTo(session.clients, { type: 'output', data: str });
    // Server-side push notification detection
    pushOnOutput(id, str);
    // Coarse status for the workspace board: output → running, 2s of silence → idle.
    if (workspaceStatus.get(id)?.status !== 'running') {
      setSessionStatus(id, { status: 'running' });
    }
    if (session._statusIdleTimer) clearTimeout(session._statusIdleTimer);
    session._statusIdleTimer = setTimeout(() => {
      setSessionStatus(id, { status: 'idle' });
    }, 2000);
  });

  // Detect session exit or stream failure
  const onStreamEnd = (err) => {
    if (sessions.get(id) !== session) return;
    setTimeout(async () => {
      if (sessions.get(id) !== session) return;
      if (!await tmuxHasSession(id)) {
        console.log(`[multicc] Session ${id} exited (tmux session gone)`);
        cleanupPushMonitor(id);
        if (session.captureTimer) { clearInterval(session.captureTimer); session.captureTimer = null; }
        const cliLabel = displayNameOf(session.cli || 'claude'); // 旧 terminal 会话没有 cli 字段
        const exitMsg = `\r\n\x1b[33m[${cliLabel} process exited]\x1b[0m\r\n`;
        broadcastTo(session.clients, { type: 'exit', data: exitMsg });
        await stopOutputCapture(session);
        sessions.delete(id);
        // Login terminals are one-shot: the flow ends with its process, so the
        // record must not survive — otherwise the next login click re-attaches
        // the saved terminal and only replays the previous run.
        if (persisted && persisted.loginFlow) {
          persistedSessions.delete(id);
          savePersistedSessionsBestEffort('runtime.login-terminal-exit');
          workspaceBroadcast(persisted.dirId, { type: 'session_deleted', sessionId: id });
        }
      } else {
        // Tmux session still alive but stream died — restart output capture
        console.log(`[multicc] Stream died for ${id}, restarting output capture...`);
        await stopOutputCapture(session);
        try {
          const { stream: newStream, fifoPath: newFifo } = await startOutputCapture(id);
          session.outputStream = newStream;
          session.fifoPath = newFifo;
          const newDecoder = new StringDecoder('utf8');
          newStream.on('data', (data) => {
            const str = newDecoder.write(data);
            if (!str) return;
            session.lastActivity = new Date();
            broadcastTo(session.clients, { type: 'output', data: str });
            pushOnOutput(id, str);
          });
          newStream.on('end', onStreamEnd);
          newStream.on('error', onStreamEnd);
        } catch (e) {
          console.error(`[multicc] Failed to restart output capture for ${id}:`, e.message);
        }
      }
    }, 500);
  };
  stream.on('end', onStreamEnd);
  stream.on('error', onStreamEnd);

  // Periodic check: tmux session may exit without FIFO closing cleanly
  session.exitCheckTimer = setInterval(async () => {
    if (sessions.get(id) !== session) {
      clearInterval(session.exitCheckTimer);
      return;
    }
    if (!await tmuxHasSession(id)) {
      clearInterval(session.exitCheckTimer);
      onStreamEnd();
    }
  }, 3000);

  sessions.set(id, session);
  return session;
}

// ── REST API ──
// The raw-body provider proxy is the source of per-role/upstream usage truth.
const roleTokenTracker = createRoleTokenTracker({ filePath: MULTICC_PATHS.tokenByRoleFile });
const tokenUsageRuntime = createTokenUsageRoutes({
  fs,
  atomicWriteJson,
  tokenUsageFile: MULTICC_PATHS.tokenUsageFile,
  tokenDailyFile: MULTICC_PATHS.tokenDailyFile,
  roleTokenTracker,
  persistedSessions,
  chatHistoryRepository,
  readProviderWindows: () => providers.readDailyWindows(),
  getProviderSummary: (cli, providerId) => providerRouterRuntime.getProviderSummary(cli, providerId),
  getEffectiveSessionModel: effectiveSessionModel,
  broadcast: chatBroadcast,
  logger,
});
const {
  accumulateTokenUsage,
  broadcastProviderTokenStats,
  broadcastRoleTokenStats,
  getTokenUsage,
  providerTokenWindows,
  reconcileCodexRoleUsage,
  recordRoleTokenUsage,
  recordUsageObserved,
  resetRoleTokenUsage,
  seedTokenUsageFromHistory,
} = tokenUsageRuntime;

// Session liveness: fuse cli-provider-router onActivity events, the host's own
// streaming flags / turn heartbeat, and an on-demand process probe so the UI can
// tell "working" (producing / waiting on the model) from "idle" and "stalled".
// chatStreamStatus is a lazy closure — chatStream is required further below.
const livenessProcessProbe = createProcessProbe({
  execFile,
  statMtimeMs: p => { try { return fs.statSync(p).mtimeMs; } catch (_) { return null; } },
});
// Best-effort resolve a codex session's rollout file (for the growth signal).
// The walk is memoized inside the resolver — see src/liveness/rollout-path.js.
const livenessRolloutResolver = createRolloutPathResolver({
  fs,
  path,
  sessionsDirFor: rec => path.join(
    rec.provider
      ? providers.codexSessionHome(rec.id)
      : path.join(os.homedir(), '.codex'),
    'sessions',
  ),
});
const livenessRolloutPath = rec => livenessRolloutResolver.resolve(rec);
const livenessRuntime = createLivenessRuntime({
  records: persistedSessions,
  chatSessions,
  chatStreamStatus: id => { try { return chatStream.status(id); } catch (_) { return null; } },
  turnHeartbeatStatus: id => turnProgressHeartbeat.status(id),
  timelineCurrentStage: turnProgress.timeline.currentStage,
  thresholds: process.env.MULTICC_STALL_SILENT_MS ? { stallSilentMs: Number(process.env.MULTICC_STALL_SILENT_MS) } : {},
  probeSession: async (sessionId, sig) => livenessProcessProbe.probe(
    sig && Number.isInteger(sig.pid) ? sig.pid : null, livenessRolloutPath(persistedSessions.get(sessionId))),
});
const providerAttemptRuntime = createProviderAttemptRuntime({ emit: chatBroadcast, audit: (id, event) => turnEventJournal.note(id, event), resolveProviderRevision: attempt => createProviderRevision({ cli: attempt.cli, providerId: attempt.providerId, protocol: attempt.protocol, model: attempt.model, summary: attempt.providerId === '_default_' ? null : providerRouterRuntime.getProviderSummary(undefined, attempt.providerId) }), resolveTerminalRoute: sessionId => terminalProxyRoutes.lookup(sessionId), quotaGuard });
const terminalNative = getNative(), terminalRoutePort = terminalNative.providerTerminalValidate({ persistedSessions, persist: savePersistedSessionsBestEffort, encode: providerAttemptRuntime.encodeProxyRoute }), terminalProxyRoutes = Object.freeze({ sessionSegment: s => terminalNative.providerTerminalSessionSegment(s, terminalRoutePort), lookup: id => terminalNative.providerTerminalLookup(id, terminalRoutePort) });
function handleProxyUsage(event) {
  const tagged = providerAttemptRuntime.attributeProxyUsage(event);
  if (tagged.routeAttribution === 'exact' || tagged.producerBound === true
      || String(event.roleKind || event.role || 'main').toLowerCase() !== 'main') {
    recordUsageObserved(tagged);
  }
}
const { recoverModelTimeout } = require('./src/providers/proxy-stall-watch');
function handleProxyOutcome(event) {
  const outcome = providerAttemptRuntime.observeProxyOutcome(event);
  recoverModelTimeout({ event, outcome, chatSessions, chatStream });
  if (outcome.accepted && outcome.failure?.httpStatus === 429) {
    Promise.resolve(limitRecorder.recordProviderFailure({
      sessionId: event.sessionId,
      providerId: outcome.failure.providerId,
      category: 'rate_limit',
      httpStatus: 429, rejection: outcome.failure.rejection,
    })).catch(() => {});
  }
}
const { createProxyBroadcasters } = require('./src/chat/proxy-broadcast');
// 每条线路的「专用出口」：CPR 拨上游前按线路问出口（「Chrome 隔离出口启动器」插件里的身份），
// Claude 与 Codex 两条协议代理共用同一个解析器；装着的 CPR 不认这个钩子时，绑了出口的线路
// 在读令牌处失败，绝不悄悄从本机 IP 直连。
const claudeEgress = require('./src/claude-auth/egress-agent');
const claudeEgressSupported = providerRouterRuntime.routerSupports('upstreamAgent');
if (!claudeEgressSupported) logger.error('claude_egress_router_outdated', { need: 'cli-provider-router >= 0.5.2 (CAPABILITIES.upstreamAgent)' });
const claudeEgressResolver = claudeEgress.createClaudeEgressAgentResolver({ logger });
providerRouterRuntime.mountProtocolProxies(app, {
  protocols: ['claude'], authorizeProxyRequest: providerAttemptRuntime.authorizeProxyRequest, authorizeProxyRequestAsync: providerAttemptRuntime.authorizeProxyRequestAsync, claudeProxy: { readOfficialCredential: claudeEgress.guardCredentialReader(arg => claudeAccountCredentials.readOfficialCredential(arg), { supported: claudeEgressSupported }), recoverOfficialCredential: (arg, token) => claudeAccountCredentials.recoverOfficialCredential(arg, token), resolveUpstreamAgent: claudeEgressResolver.resolveUpstreamAgent },
  onUsageObserved: handleProxyUsage,
  onProxyOutcome: handleProxyOutcome,
  onRejected: event => logger.warn('provider_proxy_route_rejected', event),
  onActivity: event => { const bound = providerAttemptRuntime.onProxyActivity(event); if (bound) livenessRuntime.recordProxyActivity({ ...event, sessionId: bound.sessionId }); },
  ...createProxyBroadcasters(chatBroadcast, { resolveCli: name => (persistedSessions.get(name) || {}).cli, recordLimit: limitRecorder.recordSession, attemptRuntime: providerAttemptRuntime, audit: (id, event) => turnEventJournal.note(id, event) }),
});
machines.mountProxy(app, express); app.use(express.json({ limit: '50mb' }));
// Codex 协议代理端点：官方 relay 与 responses-compat（XFYun 流稳定化）。
// Responses↔Chat 转换桥已退役——主流国产服务商均已原生支持 /responses。
// 必须在 express.json() 之后挂载，以便 req.body 已解析。详见 docs/codex-proxy-contract.md。
const codexProxyMounts = providerRouterRuntime.mountProtocolProxies(app, {
  protocols: ['codex'],
  // 同一条线路级出口：Codex 上游拨号也要能从插件身份出去（键线路同样有 IP 被污染的风险）。
  codexProxy: { resolveUpstreamAgent: claudeEgressResolver.resolveUpstreamAgent },
  getPort: () => PORT, authorizeProxyRequest: providerAttemptRuntime.authorizeProxyRequest, authorizeProxyRequestAsync: providerAttemptRuntime.authorizeProxyRequestAsync, codexOfficialRelay: { resolveAccountAuthFile: id => officialAccounts.codexAuthFile(id) }, // per-account credentials
  onTransportRotate: event => { metrics.inc('multicc_provider_dispatcher_rotations_total'); logger.warn('provider_dispatcher_rotated', event); },
  onUsageObserved: handleProxyUsage,
  onProxyOutcome: handleProxyOutcome,
  onRejected: event => logger.warn('provider_proxy_route_rejected', event),
  onActivity: event => { const bound = providerAttemptRuntime.onProxyActivity(event); if (bound) livenessRuntime.recordProxyActivity({ ...event, sessionId: bound.sessionId }); },
  ...createProxyBroadcasters(chatBroadcast, { resolveCli: name => (persistedSessions.get(name) || {}).cli, recordLimit: limitRecorder.recordSession, attemptRuntime: providerAttemptRuntime, audit: (id, event) => turnEventJournal.note(id, event) }),
});
// Session query, dashboard, workspace and classify-admin routes share one
// bounded composition. Dependencies that initialize later (Aux, workspace facts,
// classifier helpers) are resolved lazily by closures and never snapshotted here.
const sessionGitRuntime = createSessionGitRuntime({
  records: persistedSessions, directories,
  terminalSessions: sessions, chatSessions,
  gitWorktreeMergeState, gitBaseBranch,
  gitRunQueued, gitMergeBack: (dir, session, opts) => gitMergeBack(dir, session, { ...opts, evidence: workspaceAdmission?.mergeHooks(session.id) }),
  gitSyncFromBase, gitRebaseResolve,
  appendEvent, workspaceBroadcast: (...args) => workspaceBroadcast(...args),
  // Ephemeral result notice for the turn-end auto-commit; chatBroadcast is a
  // hoisted function declaration, safe to reference before its definition line.
  chatBroadcast: (...args) => chatBroadcast(...args),
  // M3 task-surface resolvers — lazy arrows: taskBoardRuntime is declared
  // later; the ports only fire at request time, after composition completes.
  resolveTaskWorktree: id => taskBoardRuntime?.taskWorktree?.info(id) || null,
  cleanupTaskWorktree: (id, o) => taskBoardRuntime?.taskWorktree?.cleanupWorktree(id, o),
  existsSync: fs.existsSync, now: Date.now, random: Math.random, asyncHandler, logger: console,
  readFile: fs.promises.readFile,
});
const mergeStateCached = sessionGitRuntime.mergeStateCached;
const classifyStateMachine = createClassifyStateMachine({
  persistedSessions,
  chatSessions,
  getSessionSummaries: () => sessionSummaries,
  logger,
  getAuxQueue: () => auxQueue,
  getSessionWorkHost: () => sessionWorkHost,
  getLivenessRuntime: () => livenessRuntime,
  getTaskContextHost: () => taskContextHost,
  getTaskBoardRuntime: () => taskBoardRuntime, getMessageSearch: () => messageSearchRuntime(),
  getUserInputSignalHost: () => userInputSignalHost,
  getApiErrorHost: () => apiErrorHost,
  getWaitInjector: () => waitInjector, getUnattendedHost: () => unattendedHost,
  setTaskState,
  getTaskState,
  // Direct classify-history writer routes through the record owner (late-bound:
  // the task-state store is composed below, calls only happen at runtime).
  appendClassifyHistory: (...args) => taskStates.appendClassifyHistory(...args),
  setSessionSummary: (...args) => setSessionSummary(...args),
  setSessionStatus: (...args) => setSessionStatus(...args),
  chatBroadcast: (...args) => chatBroadcast(...args),
  workspaceBroadcast: (...args) => workspaceBroadcast(...args),
  terminalBroadcast: (...args) => terminalBroadcast(...args),
  triggerPush: (...args) => triggerPush(...args),
  evaluateTurnApiError: (...args) => evaluateTurnApiError(...args),
  turnHasSideEffects: (...args) => turnHasSideEffects(...args),
  retryNotice: (...args) => retryNotice(...args),
  loadChatHistory: (...args) => loadChatHistory(...args),
  viewChatHistory: (...args) => viewChatHistory(...args),
  appendChatMessage: (...args) => appendChatMessage(...args),
  annotateChatTurn: async (...args) => (chatHistoryRuntime ? await chatHistoryRuntime.annotateTurn(...args) : []),
  getAuxRunLog: () => auxRunLog,
  // 目录建议（「更适合另一个目录」）的清单来源；只读快照，token 截断在 task-attribution。
  getDirectories: () => [...directories.values()],
  hasBackgroundPending: sessionName => backgroundTaskRuntime.hasProcessBackgroundTasks(sessionName),
  // P4 蒸馏：folderMemory 在下方才创建，这里闭包惰性取——写入只发生在 turn
  // 结束后，届时早已初始化完成。
  writeTaskMemoryCandidate: (sessionName, taskId, candidate) => taskMemoryDistiller.record({
    dirId: persistedSessions.get(sessionName)?.dirId, taskId, text: candidate, tag: 'aux',
  }),
});
const {
  dispatchStateAction,
  isInjectedOrJunkGoal,
  isSystemInjectedMsg,
  isGoalResolved,
  applyClassifyResult,
  scanAndReclassify,
  cancelClassify,
  buildClassifyConversation,
  runClassifyNow,
  classifyTurnEnd,
  newCurrentTask,
  ensureCurrentTask,
  emitRunningNotify,
  emitTurnOutcome,
  scanHistory,
  SCAN_INTERVAL_MS,
  SCAN_MAX_QUEUE,
  SCAN_RETHROTTLE_MS,
  STUCK_STREAM_MS,
  SCAN_HISTORY_MAX_PASSES,
  SCAN_HISTORY_MAX_DECISIONS,
} = classifyStateMachine;

const sessionAdmin = createSessionAdminRuntime({
  records: persistedSessions,
  terminalSessions: sessions,
  chatSessions,
  directories,
  cwdForSession,
  chatLastActivity,
  effectiveSessionModel,
  effectiveSessionEffort,
  serializeSubagent,
  mergeStateCached,
  cliStateSummary,
  cliHandoffSummary,
  cliAvailabilitySummary,
  sessionProviderBaseUrl,
  getInvalidSession: id => invalidSessions.get(id),
  resolveStateTarget: id => taskShellHost.stateTarget(id),
  getWorkspaceStatus: id => workspaceStatus.get(id),
  getSessionSummary: id => sessionSummaries.get(id),
  getTaskState, setTaskState, getUnattended: () => unattendedHost,
  pendingNotesFor,
  getAuxRuntime: () => ({ id: AUX_SESSION_ID, queue: auxQueue }),
  loadChatHistory,
  viewChatHistory,
  isInjectedOrJunkGoal,
  buildClassifySystemPrompt,
  buildClassifyConversation,
  parseClassifyResult,
  dispatchStateAction,
  runClassifyNow,
  createErrorDto,
  requestContext,
  withApiMeta,
});
// 编排与无人值守 23 条公开路由已由 Rust 前门独占（native/gateway/src/app/orchestration_routes.rs）；
// 四个退休模块只挂在这个捕获应用上，宿主端口在 createOrchestrationRoutes 之后统一暴露。
const { createAuxRunRoutes, createOrchestrationHost } = require('./src/routes/orchestration-host');
const orchestrationHost = createOrchestrationHost({ express });
sessionAdmin.mountRoutes(app, { unattendedApp: orchestrationHost.app });
const workspaceSnapshot = sessionAdmin.workspaceSnapshot;

// Workspace and fleet-wide Meta state share one runtime so every event is
// fanned out exactly once. The function dependencies are host declarations and
// resolve lazily; hydration itself only reads the already-loaded records.
const workspaceRuntime = createWorkspaceRuntime({
  records: persistedSessions,
  directories,
  chatSessions,
  workspaceSnapshot,
  resolveStateTarget: id => taskShellHost.stateTarget(id), stateSources: id => taskShellHost.stateSources(id),
  sessionView: id => sessionAdmin.sessionView(id),
  recentEvents: dirId => recentEvents(dirId),
  mergeState: (directory, session) => mergeStateCached(directory, session),
  setTaskState,
  saveBestEffort: savePersistedSessionsBestEffort,
  metrics,
  logger,
  clock: Date.now,
});
const workspaceStatus = workspaceRuntime.status;
const workspaceClients = workspaceRuntime.clients;
const sessionSummaries = workspaceRuntime.summaries;
const workspaceBroadcast = workspaceRuntime.broadcast;
const setSessionSummary = workspaceRuntime.setSummary;
const setSessionStatus = workspaceRuntime.setStatus;

function v1Error(req, res, status, message, code) {
  return res.status(status).json(createErrorDto({ ...requestContext(req, res), message, code }));
}

// Agent presets, installed skills and Claude history share one read/cleanup boundary.
mountAgentResourcesHostRoute(app, { runtime: agentResources });

// ── Directory REST API (Rust front door) ──
// GET /api/fs/list · GET|POST /api/directories · PUT /api/directories/order ·
// PATCH|DELETE /api/directories/:id · POST :id/push · GET :id/uncommitted ·
// POST :id/commit and the three /api/ui-layout routes are answered by the Rust
// front door; this internal port only exposes the live table, git, fs and
// session effects it asks about (src/routes/directory-host.js).
directoryModule.host.mount(app);

// Memo is a bounded host/controller. It owns validation and file I/O; errors
// flow through src/http's branded mapping before the terminal safe handler.
// Memos live under the memory store, never inside the user's project — a
// multicc-owned file in the project tree left every worktree dirty and blocked
// merges. migrateLegacy() moves memos written by older builds.
const memoModule = createMemoModule({
  directories: { get: id => directories.get(id), list: () => [...directories.values()] },
  sessions: { get: id => persistedSessions.get(id) },
  runtime: {
    getChatSession: id => chatSessions.get(id),
    runTurn: (id, text, options) => chatTurnEngine.admitChatWork(id, text, options),
  },
  memoRoot: MEMORY_STORE_ROOT,
  log: message => console.log(message),
});
memoModule.migrateLegacy().done.catch(error => console.log(`[memo] migration failed: ${error.message}`));

// Create + persist an isolated session record (its own git worktree + branch).
// Shared creation boundary; an explicit id creates or reuses a named session.
function createSessionRecord(input) {
  const created = getNative().sessionCreateRecordFactory({
    sharedWorkspace: require('./src/task-shell/workspace').sharedWorkspace,
    SUPPORTED_CHAT_CLIS, isResidentSession, validateExperimentalSession, tuiChatMirrorEnabled, normalizeEffort, validEffortForCli, codexDefaultReasoningLevel, normalizeCliAgent, validateProviderSelection, providers, primaryProviderCandidate, providerDefaults, validProviderId, allocateSessionId, persistedSessions, ensureDirGitReady, friendlyDirReason, WORKTREE_SUBDIR, gitWorktreeAdd, gitWorktreeRollbackCreate, sanitizeLoginEnv, ensureCliStates, sessionPersistence, savePersistedSessionsBestEffort, appendEvent, cliForLoginFlow, loginWorkspacePath: MULTICC_PATHS.loginWorkspacePath
  }, path)(input && typeof input === 'object' && input.cli != null ? { ...input, cli: canonicalCli(input.cli) } : input);
  // 会话创建/复用是清墓碑的唯一时机；固定 id 的辅助会话重建时让历史队列重新接受写入。
  const registered = value => {
    if (value && value.ok && value.id && chatHistoryRuntime) chatHistoryRuntime.registerSession(value.id);
    return value;
  };
  return created && typeof created.then === 'function' ? created.then(registered) : registered(created);
}

// Login terminals are one-shot (native/addon/src/session_login_terminal.rs): each click
// disposes the previous tmux pane, and the exit path drops the record.
const disposeLoginTerminal = getNative().sessionLoginTerminalDisposer({
  persistedSessions, tmuxKillSession, destroySessionCascade,
  saveSessions: savePersistedSessionsBestEffort,
});

// 会话管理 16 条公开路由由 Rust 前门独占（native/gateway/src/app/session_routes.rs）；
// 六个退休模块在捕获应用上注册，Node 只经 `POST /api/__host/session-routes` 暴露它们的运行时事实。
const sessionRoutesHost = createSessionRoutesHost();
const accountRoutesHost = createAccountRoutesHost();

mountSessionCreateRoutes(sessionRoutesHost.app, {
  directories, createSessionRecord, asyncHandler, sessions: persistedSessions, disposeLoginTerminal,
  createTask: input => taskShellHost.createTask(input), getRecord: id => persistedSessions.get(id),
});

// Cross-CLI switching: one native state per CLI + a visible, bounded handoff
// checkpoint. Provider lookups/chat stream resolve lazily (built below).
const cliSwitchRuntime = createCliSwitchRuntime({ clearReplay: chatReplay.clear,
  records: persistedSessions,
  sessionPersistence,
  supportedClis: SUPPORTED_CHAT_CLIS,
  chatSessions,
  getProviderDefaults: () => providerDefaults, validProviderId: (...a) => validProviderId(...a), getProviders: () => providers,
  codexDefaultReasoningLevel,
  getHistory: loadChatHistory,
  buildHandoffCheckpoint,
  activateCliState,
  rememberActiveCliState,
  ensureCliStates,
  cliStateSummary,
  gitWorktreeSnapshot,
  cwdForSession,
  getChatStream: () => chatStream, hasLiveBackgroundTasks: id => backgroundTaskRuntime?.hasProcessBackgroundTasks(id) === true, getPreparation: id => chatTurnPreparationRuntime.snapshot(id),
  cancelClassify, planAutoCliSwitch: args => chatTurnEngine.autoProviderRuntime.planTurnAsync(args),
  pendingAutoCliSwitch: (id, cli) => chatTurnEngine.autoProviderRuntime.pendingCliSwitch(id, cli),
  clearAutoProviderSession: id => chatTurnEngine.autoProviderRuntime.clearSession(id),
  assignKillReason, finishProviderAttempt: (attempt, facts) => providerAttemptRuntime.finishAttempt(attempt, facts),
  appendMessage: appendChatMessage,
  appendEvent,
  chatBroadcast,
  workspaceBroadcast,
  saveBestEffort: savePersistedSessionsBestEffort,
  cliAvailabilitySummary,
  sessionProviderName,
  sessionProviderBaseUrl,
  effectiveSessionModel,
  effectiveSessionEffort,
  serializeSubagent,
});
const cliSwitchGitSnapshot = cliSwitchRuntime.cliSwitchGitSnapshot;
const consumePendingCliHandoff = cliSwitchRuntime.consumePendingCliHandoff;
cliSwitchRuntime.mountRoutes(app, asyncHandler);
// 启动后探一次 + 每 24h 一次 CLI 待更新状态(unref, 不阻止退出)。
cliSwitchRuntime.startUpdateWatch();

// PATCH + fork profile routes: label/model/effort/agent/rolePrompt/memory/provider/
// subagent edits, and Happier-parity transcript fork. Handler logic lives in
// src/routes/session-profile.js; only host wiring stays here.
const { applySessionPatch, previewSessionPatch } = createSessionProfileRoutes({
  persistedSessions,
  directories,
  sessionPersistence,
  sessionPolicy,
  providers,
  synchronizeCodexProfileRoute,
  withConfigurationPreparation: cliSwitchRuntime.withConfigurationPreparation,
  providerRouterRuntime,
  // chatStream / providerRoutes are composed further down this file; resolve
  // them lazily or mounting would hit the const TDZ before boot finishes.
  getChatStream: () => chatStream, getChatState: id => chatSessions.get(id), hasLiveBackgroundTasks: id => backgroundTaskRuntime?.hasProcessBackgroundTasks(id) === true, getPreparation: id => chatTurnPreparationRuntime.snapshot(id),
  validProviderId: (...args) => validProviderId(...args),
  asyncHandler,
  appendEvent,
  workspaceBroadcast,
  chatBroadcast,
  getTaskState,
  rememberActiveCliState,
  buildHandoffCheckpoint,
  cliStateSummary,
  cliAvailabilitySummary,
  cliHandoffSummary,
  createSessionRecord,
  loadChatHistory,
  newChatMsgId,
  mergeHistory: (id, messages, options) => chatHistoryRuntime.mergeHistory(id, messages, options),
  getFolderMemory: () => folderMemory,
  getCliSwitchGitSnapshot: () => cliSwitchGitSnapshot,
}).mountRoutes(sessionRoutesHost.app);

// Folder memory owns filesystem layout, seed files and the frozen prompt snapshot.
// Session routes consume that service plus the existing curated-memory primitives.
const folderMemory = createFolderMemoryService({
  fs,
  path,
  memoryStoreRoot: MEMORY_STORE_ROOT,
  directories,
  readMemoryFolder: readFolderMemory,
  getMemoryEntries,
});
// P4 任务级记忆蒸馏：归因 aux 的 memory_candidate 与交付回执都经它写入
// tasks/<taskId>/MEMORY.md 的「自动蒸馏」小节（去重→替换、容量上限，只碰小节）。
const taskMemoryDistiller = require('./src/memory/task-distill').createTaskMemoryDistiller({
  fs,
  path,
  taskDir: (dirId, taskId) => folderMemory.taskDir(dirId, taskId),
  listFiles: dir => folderMemory.listFiles(dir),
  logger,
});
mountSessionMemoryRoutes(sessionRoutesHost.app, {
  fs,
  path,
  records: persistedSessions,
  folderMemory,
  getMemoryEntries,
  scanMemoryContent,
  atomicWriteMemoryFile,
  applyCuratedMemoryAction,
  appendEvent,
  workspaceBroadcast,
  directoriesKeys: () => directories.keys(),
});

// Memory graph/tree and generic file editing share one filesystem boundary.
// Session-level curated memory routes above retain their separate semantics.
// This object is the filesystem half of the docs/memory host port below.
const memoryBrowser = createMemoryBrowserRoutes({
  fs,
  path,
  memoryStoreRoot: MEMORY_STORE_ROOT,
  directories,
  persistedSessions,
  workspaceBroadcast,
  atomicWriteText,
  now: Date.now,
});

// ── Cross-machine handoff: encrypted bundle v2 (memory scopes + skills + context deps
// + git); lives in src/routes/session-bundle.js, host wiring here. Provider state
// deliberately does not travel — the target machine picks its own provider. ──
const sessionBundleRuntime = createSessionBundleRoutes({
  persistedSessions,
  directories,
  asyncHandler,
  appendEvent,
  createSessionRecord,
  loadChatHistory,
  replaceHistory: (id, messages, options) => chatHistoryRuntime.replaceHistory(id, messages, options),
  mergeHistory: (id, messages, options) => chatHistoryRuntime.mergeHistory(id, messages, options),
  getFolderMemory: () => folderMemory,
  listInstalledSkills,
  getSkillSyncRuntime: () => skillSyncRuntime,
});
// JSON export/import rides the host port; the two binary transports
// (`bundle.zip`, `import-zip`) stay publicly served by Node (front door does
// not claim them: a zip's bytes carry timestamps and a raw 160 MB body is not
// JSON), so the module is mounted on the real app as well.
sessionBundleRuntime.mountRoutes(sessionRoutesHost.app);
// Only the binary pair goes on the real app. Mounting all four here would
// republish the two migrated JSON transports as a silent Node fallback whose
// behaviour could drift from the front door's.
sessionBundleRuntime.mountBinaryRoutes(app);

sessionGitRuntime.mountRoutes(app);

// ── Single-session lifecycle: delete / relocate / restart ──
// Handler logic lives in src/routes/session-lifecycle.js; only host wiring
// stays here. The whole-server POST /api/restart below deliberately remains
// inline — its detached-scheduler debounce is host process state.
const sessionLifecycleRuntime = createSessionLifecycleRuntime({ replay: chatReplay,
  sessions, chatSessions, persistedSessions, directories, invalidSessions,
  sessionPersistence,
  getChatStream: () => chatStream, hasLiveBackgroundTasks: id => backgroundTaskRuntime?.hasProcessBackgroundTasks(id) === true, reapBackgroundTasks: (id, reason) => backgroundTaskRuntime?.reapSessionShadows(id, { reason }) || 0,
  // sessionWorkHost is composed further down this file; forward lazily past the TDZ.
  getSessionWorkHost: () => sessionWorkHost,
  asyncHandler,
  destroySessionCascade,
  tmuxKillSession,
  appendEvent,
  ensureDirGitReady,
  gitRelocateWorktree,
  gitWorktreeAdd,
  fs,
  broadcastTo,
  stopOutputCapture,
  assignKillReason, finishProviderAttempt: (attempt, facts) => providerAttemptRuntime.finishAttempt(attempt, facts),
  createSession,
  cwdForSession,
  // pushRuntime is composed further down this file; forward lazily past the TDZ.
  cleanupPushMonitor: (id) => cleanupPushMonitor(id),
  getSessionGitRuntime: () => sessionGitRuntime,
}).mountRoutes(sessionRoutesHost.app); // chainable since the fix: mountRoutes returns the runtime

// ── Restart the whole multicc server (graceful) ──
// Handler + detached-scheduler debounce live in src/routes/server-restart-route.js;
// only host wiring stays here. rootDir must be THIS file's __dirname (the package
// root the manager script lives in), not the route module's directory. authSecurity.shuttingDown()
// is forwarded lazily so the route reads the host's live shutdown flag at request time.
const serverRestartRoute = createServerRestartRoute({
  chatSessions,
  spawn,
  rootDir: __dirname,
  dataDir: MULTICC_PATHS.root, getPort: () => PORT, getHost: () => BIND_HOST,
  getShuttingDown: () => authSecurity.shuttingDown(), desktopExit: reason => gracefulShutdown(reason),
});

// ── One-click update (runs `./multicc update`, which restarts us at the end) ──
// Run state lives in logs/update.log, not in memory: the process that starts the
// update is not the one that reports its outcome. See src/routes/update-route.js.
const updateRoute = createUpdateRoute({
  chatSessions,
  spawn,
  rootDir: __dirname,
  getShuttingDown: () => authSecurity.shuttingDown(),
  getPort: () => PORT,
  fs,
  path,
  https,
  gitRun,
});

// ── Per-session metadata: inter-agent notes + liveness ──
// Handler logic lives in the native session meta routes; only host wiring stays
// here. `notes` lives inside src/notes-store.js and is never exposed by
// reference — the module receives getNotes()/saveNotes()/pendingNotesFor().
createSessionMetaRuntime({
  persistedSessions,
  asyncHandler,
  appendEvent,
  workspaceBroadcast,
  saveNotes,
  pendingNotesFor,
  getNotes: () => notesStore.getNotes(),
  getLivenessRuntime: () => livenessRuntime,
}).mountRoutes(sessionRoutesHost.app);

// The single loopback host port the six retired modules' facts are reached
// through. Mounted after all six have registered, so the op table resolves.
sessionRoutesHost.mountRoute(app); accountRoutesHost.mountRoute(app);

// Host port for the file browser: the Rust front door owns /api/files and
// /api/upload; Node is asked only for the session table and the directory
// listing order.
mountFileTransferHostRoute(app, {
  fs,
  path,
  os,
  getActiveSession: id => sessions.get(id),
  getPersistedSession: id => persistedSessions.get(id),
});

// ── Host .env management + Web Push (PWA notifications) ──
// .env read/write helpers and VAPID key provisioning extracted to src/host-env.js.
// The startup order below is preserved verbatim: DEFAULT_CLI migration, voice
// route wiring, then VAPID key provisioning + setVapidDetails.
const hostEnv = createHostEnv({ webpush });
const { readEnvFile, writeEnvFile, ensureVapidKeys } = hostEnv;

// DEFAULT_CLI belonged to the removed Aux CLI fallback. Migrate persisted
// installations as well as the in-memory environment to the protocol config.
if (readEnvFile().DEFAULT_CLI !== undefined) writeEnvFile({ DEFAULT_CLI: null });
delete process.env.DEFAULT_CLI;

// Voice settings and per-Fleet Qwen sidecars share one host-owned lifecycle.
const voiceHost = createVoiceHost({
  app, server, wss, records: persistedSessions, directories, sessionPersistence,
  runtimeRoot: MULTICC_PATHS.voiceRuntimesDir,
  getBaseUrl: () => `http://127.0.0.1:${PORT}`,
  uploadVoice: upload.voice, voiceAsr, ttsService, readEnvFile, writeEnvFile,
  getAuxQueue: () => auxQueue,
  reportFailure: (stage, category) => reportHostControlFailure('voice_settings', stage, category),
  log: logger, autoDownloadAsrModels: true,
});
const qwenAudioSupervisor = voiceHost.supervisor;
const vapidKeys = ensureVapidKeys();
webpush.setVapidDetails('mailto:multicc@localhost', vapidKeys.pubKey, vapidKeys.privKey);

// Notification delivery layer (subscriptions, senders, channel config) extracted
// to src/push/service.js. VAPID init above stays here; web-push is a shared singleton so
// push.js sends through the instance configured by setVapidDetails() above.
const push = require('./src/push/service');
const tunnel = require('./src/tunnel');
function reportHostControlFailure(component, stage, category) {
  metrics.inc('multicc_host_control_failures_total');
  if (category === 'compensation_failed') metrics.inc('multicc_host_control_compensation_failures_total');
  logger.error('host_control_failure', {
    component,
    stage: String(stage || 'unknown').slice(0, 80),
    category: String(category || 'operation_failed').slice(0, 80),
  });
}
tunnel.setFailureReporter((stage, category) => {
  reportHostControlFailure('tunnel', stage, category);
});
const chatStream = require('./src/chat/chat-stream');
const waitInjector = require('./src/wait/injector');
const sessionDelivery = require('./src/native/runtime').getSessionDeliveryApi().createSessionDelivery({
  admit: (session, text, opts) => chatTurnEngine.admitChatWork(session, text, opts),
  log: message => console.log('[multicc/delivery]', message),
});
const authHealth = require('./src/claude-auth/refresh-health').createRefreshHealthStore({ root: OFFICIAL_ACCOUNTS_ROOT, logger }); const claudeOAuthRefresh = createClaudeOAuthRefresher({ logger, health: authHealth, healthKey: 'claude-cli' });
const codexOAuthRefresh = createCodexOAuthRefresher({ logger }); const officialAccounts = createOfficialAccountStore({ onCredentialWritten: id => limitRecorder.releaseProviderFailure({ providerId: require('./src/providers/official-catalog').accountProviderId('claude', id) }) }); const cliLogin = require('./src/official-accounts-cli-login').createCliLoginDetector({ accounts: officialAccounts }); const codexAccountRefresh = createCodexAccountRefreshSupervisor({ accounts: officialAccounts, logger }); const claudeAccountRefresh = require('./src/claude-auth/accounts-refresh').createClaudeAccountRefreshSupervisor({ accounts: officialAccounts, logger, health: authHealth }); const claudeAccountCredentials = createClaudeAccountCredentialService({ accounts: officialAccounts, logger, exclusive: claudeAccountRefresh.exclusive, onNeedsRefresh: id => claudeAccountRefresh.checkAccount(id, 'read-miss') }); cliLogin.start(); claudeAccountRefresh.start(); // each own-token account is refreshed by the claude CLI under its own CLAUDE_CONFIG_DIR // the CLI's own login is only detected (panel reminder), never copied: a copy would share its single-use refresh token // multi-account: per-account credentials (the shared refreshers only watch ~/.codex + the Keychain)
const apiErrorHost = createApiErrorHost({ replay: chatReplay,
  policy: apiErrorPolicy, logger, persistedSessions, setTaskState, chatBroadcast,
  setSessionStatus, isShuttingDown: () => authSecurity.shuttingDown(),
  clearIncrementalSave: sessionId => chatHistoryRuntime?.clearIncrementalSave(sessionId),
  isCurrentTurnRunner: (...args) => isCurrentTurnRunner(...args),
  recordProviderFailure: limitRecorder.recordProviderFailure, proxyFailureForAttempt: providerAttemptRuntime.proxyFailure, // revoked OAuth → park; 429 → proxy rejection
});
const {
  recordApiError, recordApiSuccess, evaluateTurnApiError, meaningfulTurnOutput,
  turnHasSideEffects, clearSessionApiErrorState, scheduleOwnedRetry,
} = apiErrorHost;
const { createDetached } = require('./src/detached');
const detached = createDetached({ baseDir: MULTICC_PATHS.detachedDir });
const apkDistribution = createApkDistribution({ fs, path, https, rootDir: __dirname }); const iosOta = require('./src/ios-ota').createIosOta({ fs, path, rootDir: __dirname });
const share = require('./src/share');
// The Rust front door owns the 21 share / machines / workspaces routes. Its
// Node child keeps the runtime facts — the machine registry (already
// native/core/machines), the share store and password cookies, the workspace
// scan/sweep runtime — behind one loopback host
// port (`src/routes/share-machines-host.js`). The three retired modules are
// mounted on that capture app, in their original order; none of them stays on
// the public app. Only the raw/SSE machine proxy is still a public route
// (`machines.mountProxy`).
const shareMachinesHost = createShareMachinesHost({
  express,
  machines,
  share: { share, persistedSessions, loadChatHistory, viewChatHistory, parseCookies, logger,
    // Read-only paging for a recipient scrolling up; the chat history runtime is
    // assembled later in this file, so it is read at request time.
    paginateChatHistory: (...args) => chatHistoryRuntime.paginate(...args),
  },
  workspaces: {
    records: persistedSessions, directories,
    getHibernation: () => sessionHibernationRuntime, getOrphanScanner: () => worktreeOrphanScanner,
  },
});
shareMachinesHost.mountRoute(app);
fleetSharingRuntime = createFleetSharing({ sharesFile: MULTICC_PATHS.fleetSharesFile,
  getDirectory: id => directories.get(id),
  listSessions: id => persistedSessions.listByDir(id).filter(session => session.type !== 'aux'),
  authSecurity,
});

mountSystemHostRoute(app, {
  fs,
  path,
  rootDir: __dirname,
  networkInterfaces: () => os.networkInterfaces(),
  getPort: () => PORT, getBindHost: () => BIND_HOST,
  authRequired: () => authSecurity.accessToken(),
  gitRun,
});

// Host port for the read-only host plane: the Rust front door owns those routes.
// Node is asked only for runtime facts it cannot see.
mountHostReadHostRoute(app, {
  getVapidPublicKey: () => vapidKeys.pubKey,
  push,
  tunnel,
  getAccessToken: () => authSecurity.accessToken(),
  isLocalRequest,
  macosPower, batteryGuard: batteryGuardRuntime,
});

// Mutable host settings use the matching narrow boundary. Durable .env/config
// writes commit before hot runtime state is changed, so write failures reach
// the terminal safe error handler instead of returning a runtime-only success.
const hostWriteDeps = {
  readEnvFile,
  writeEnvFile,
  push,
  tunnel,
  getAccessToken: () => authSecurity.accessToken(),
  setAccessToken: (token) => {
    process.env.ACCESS_TOKEN = token;
    authSecurity.setAccessToken(token);
    void lanDiscovery.reconcile();
  },
  getAllowRemote: () => networkPolicy.allowRemote,
  isLocalRequest,
  macosPower, batteryGuard: batteryGuardRuntime,
  taskAttributionMode: { get: () => taskShellHost.attributionSettings().getMode(), set: mode => taskShellHost.attributionSettings().setMode(mode) },
  log: message => console.log(message),
  reportFailure: (stage, category) => reportHostControlFailure('host_write', stage, category),
};

// WS fan-out remains host-owned because terminal, chat, workspace and Aux all use it.
function sendWs(client, payload, context) {
  client.send(JSON.stringify(createWsEnvelope(payload, context)));
}

function broadcastTo(clients, payload) {
  const json = JSON.stringify(createWsEnvelope(payload));
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(json); } catch (_) {}
    }
  }
}

function terminalBroadcast(sessionId, payload) {
  const session = sessions.get(sessionId);
  if (!session) return;
  broadcastTo(session.clients, payload);
}

// ── AuxQueue + Goal precheck ────────────────────────────────────────────────
// Queue, provider/model configuration and goal-quality routes share one
// lifecycle. The host supplies ports; this subsystem owns its mutable config.
const {
  AUX_SESSION_ID,
  AUX_HISTORY_MAX,
  auxQueue,
  getAuxConfig, clearAuxProvider,
} = mountAuxGoalRoutes(orchestrationHost.app, {
  fs,
  crypto,
  rootDir: __dirname,
  auxConfigFile: MULTICC_PATHS.auxConfigFile,
  goalConfigFile: MULTICC_PATHS.goalConfigFile,
  atomicWriteJson,
  persistedSessions,
  savePersistedSessionsBestEffort,
  isShuttingDown: () => authSecurity.shuttingDown(),
  recordApiError,
  recordApiSuccess,
  appendChatMessage,
  loadChatHistory,
  viewChatHistory,
  providers,
  getPort: () => PORT,
  getClaudeOfficialViaProxy: () => CLAUDE_OFFICIAL_VIA_PROXY,
  executeAuxHttp, providerLimitCache, getCliAvailability: () => cliAvailabilitySummary(), codexModelsRuntime: codexCatalog,
  broadcast: broadcastTo,
  // Refresh displayed verdicts immediately, even when no new task_state arrives.
  onHealthChange: () => fanOutAuxVerdictStaleness({
    sessions: persistedSessions, getTaskState, chatBroadcast, workspaceBroadcast,
  }),
});
installAuxHealthProvider(() => auxQueue.getStatus().health);
// Memory runtime owns normalization, Aux distillation, periodic review and the
// pending-distill gate. History is resolved lazily because its runtime is
// composed later in this file.
const memoryRuntime = createMemoryRuntime({
  records: persistedSessions,
  auxQueue,
  loadHistory: sessionId => chatHistoryRuntime.load(sessionId),
  writeAutoFile: folderMemory.writeAutoFile,
  saveBestEffort: savePersistedSessionsBestEffort,
  scanContent: scanMemoryContent,
  appendEvent,
  workspaceBroadcast: (dirId, payload) => workspaceBroadcast(dirId, payload), // late-bound Meta wrapper
  reviewInterval: process.env.MULTICC_MEMORY_REVIEW_INTERVAL,
  // Aux transport failures (distill/review) join the centralized API error
  // taxonomy instead of only a console warn. Late-bound is unnecessary: the
  // host is composed above the memory runtime.
  recordApiError,
  logger: console,
});
const {
  distillHistoryIntoMemory,
  getPendingDistill: getPendingMemoryDistill,
  maybeSchedulePeriodicMemoryReview,
  trackPendingDistill: _trackPendingMemoryDistill,
} = memoryRuntime;
// Same gate as dispatchTargetBusy, decomposed into reason codes so the outbox
// skip log and the insert-queued response can say WHY a delivery was vetoed;
// every check fails closed, but a probe that cannot identify the workspace
// names its own code — "occupied" would hide a wedge with no release path.
function dispatchTargetBusyReasons(sid, item = null) {
  const reasons = [];
  try { if (workspaceAdmission?.occupied(sid)) reasons.push('workspace_occupied'); }
  catch (err) { reasons.push(err?.code || 'workspace_occupied_check_failed'); }
  try { if (sessionWorkHost?.isRunActive(sid)) reasons.push('run_active'); }
  catch (_) { reasons.push('run_active_check_failed'); }
  try { if (defaultRepoActor.isLeased(sid)) reasons.push('repo_lease'); }
  catch (_) { reasons.push('repo_lease_check_failed'); }
  try { if (taskShellHost.isWorkspaceBusy(sid)) reasons.push('task_shell_workspace_busy'); }
  catch (_) { reasons.push('task_shell_busy_check_failed'); }
  // Occupancy outliving its delivery is annotated, never reclaimed: `reasons`
  // is already non-empty here, so a diagnostic can never create a busy verdict.
  if (reasons.length) {
    try { const stuck = workspaceAdmission?.stuckHint(sid); if (stuck) reasons.push(stuck); }
    catch (_) { /* diagnostics never change the decision */ }
  }
  return reasons;
}
function dispatchTargetBusy(sid, item = null) {
  return dispatchTargetBusyReasons(sid, item).length > 0;
}
const taskBoardRuntime = createTaskBoardRuntime({
  ...require('./src/task-board/lifecycle-host').createTaskLifecycleHost({ records: persistedSessions, getBoard: () => taskBoardRuntime.getBoard(), getShell: () => taskShellHost, getHistory: id => loadChatHistory(id), getState: id => chatSessions.get(id), getRunState: id => sessionWorkHost.getRunState(id), isSessionBusy: sid => dispatchTargetBusy(sid), dropHistoryMessages: (id, ids, options) => chatHistoryRuntime.dropMessages(id, ids, options), canDeleteHistory: id => chatHistoryRuntime.deletionVerdict(id), deleteHistory: id => chatHistoryRuntime.removeSession(id), destroySession: destroySessionCascade, directories, persist: () => savePersistedSessionsBestEffort('task-delete'), mutate: (source, fn) => sessionPersistence.mutate(source, fn),
    // Late-bound: taskStates is composed below; deletion only runs at runtime.
    resetTaskState: id => taskStates.resetTaskState(id), workspaceBroadcast, chatBroadcast, getHibernation: () => sessionHibernationRuntime }),
  file: MULTICC_PATHS.taskBoardFile,
  getPinnedTaskIds: () => readStoredPinIds(MULTICC_PATHS.airPinsFile),
  listShellTasks: () => taskShellHost.listTasks(),
  isSessionBusy: sid => dispatchTargetBusy(sid),
  auxQueue, records: persistedSessions, createSessionRecord, releaseTaskBoundSession: sessionLifecycleRuntime.releaseTaskBoundSession,
  loadHistory: sessionId => viewChatHistory(sessionId),
  dispatchToSession,
  sendSessionMessage: (...args) => taskContextHost.deliverSessionMessage(...args),
  workspaceBroadcast: (dirId, payload) => workspaceBroadcast(dirId, payload),
  atomicWriteJson,
  isSystemInjected: msg => isSystemInjectedMsg(msg),
  resolveSessionQueue: (...args) => sessionWorkHost.resolveTask(...args),
  getCommanderMigrationStatus: dirId => commanderMigrationState.statusFor(dirId),
  getSessionRunState: sid => sessionWorkHost?.getRunState(sid) || 'idle', isTaskShellSession: id => taskShellHost.owns(id), taskShellTaskAccess: task => taskShellHost.taskAccess(task), taskShellTaskEntry: id => taskShellHost.taskEntry(id),
  taskShortCode,
  // M3 per-task worktree service ports (taskWorktree on the runtime).
  directories, gitWorktreeAdd, gitWorktreeRemove, gitRelocateWorktree, gitMergeBack: (dir, session, opts) => gitMergeBack(dir, session, { ...opts, evidence: workspaceAdmission?.mergeHooks(session.id) }), existsSync: fs.existsSync,
  // Air 任务「移动」：会话工作区搬迁走 session-lifecycle 的同一实现（含 carry）；
  // taskShellHost 在本 runtime 之后组合，惰性解析绕过 TDZ。
  relocateSessionWorkspace: (id, dirId, opts) => sessionLifecycleRuntime.relocateSessionWorkspace(id, dirId, opts),
  relocateShellTask: (taskId, dirId, opts) => taskShellHost.relocateTask(taskId, dirId, opts),
  logger: console,
});
const taskSearchRuntime = createTaskSearchRoutes({ getBoard: () => taskBoardRuntime.getBoard(), messages: messageSearchRuntime, logger }); messageSearchRuntime().start();
const taskContextHost = createTaskContextHost({
  getState: sessionId => chatSessions.get(sessionId), emitSession: chatReplay.broadcast,
  append: (id, m) => chatHistoryRuntime.appendMessage(id, m),
  getTaskBoard: () => taskBoardRuntime, getTaskShells: () => taskShellHost, classifyDisplay,
  containsDelivery: (sessionId, id) => chatHistoryService.containsDelivery(sessionId, id),
  randomUUID: () => crypto.randomUUID(), getRecord: sessionId => persistedSessions.get(sessionId),
  runTurn: (sessionId, text, options) => chatTurnEngine.admitChatWork(sessionId, text, options),
  // Late-bound: the unattended supervisor is composed after this host.
  armUnattended: (id, spec, text) => unattendedHost?.armFromRequest(id, spec, { defaultGoal: text }), noteUnattendedUserMessage: id => unattendedHost?.noteUserMessage(id),
});
// P3 图谱上下文构建：宿主把 board / shell store / 任务级记忆接成 ports，
// runtime 在任务首轮投递与 refill 时按图谱邻接注入（失败降级为空串）。
const taskGraphContextOf = require('./src/task-shell/task-graph-context').createTaskGraphContextService({
  getBoard: () => taskBoardRuntime.getBoard(),
  taskGraphData: () => taskShellHost.taskGraphData(),
  getSnapshot: id => taskShellHost.getSnapshot(id),
  readTaskMemory: (dirId, taskId) => {
    const dir = folderMemory.taskDir(dirId, taskId);
    if (!dir) return '';
    return (folderMemory.listFiles(dir).find(file => file.name === 'MEMORY.md') || {}).content || '';
  },
});
const taskShellHost = require('./src/task-shell/host').createTaskShellHost({
  defaultTaskRuntime: () => ({ cli: SUPPORTED_CHAT_CLIS.find(cli => !cli.endsWith('-exp') && cliAvailabilitySummary()[cli]?.available) || 'claude' }), taskShortCode,
  taskGraphContext: taskGraphContextOf,
  onStateTargetChanged: id => workspaceRuntime.publishSessionView(id), onSeparationChanged: id => chatBroadcast(id, { type: 'task_separation_updated' }),
  onAttributionChanged: (id, detail) => chatBroadcast(id, {
    ...(detail && typeof detail === 'object' ? detail : {}), type: 'task_attribution_updated' }),
  file: MULTICC_PATHS.taskShellDbFile, records: persistedSessions, directories, createSessionRecord,
  loadHistory: viewChatHistory, getTaskBoard: () => taskBoardRuntime, appendHistory: (id, m) => chatHistoryRuntime.appendMessage(id, m), hideHistory: (...args) => chatHistoryRuntime.hideMessages(...args),
  displayHistory: (id, hidden) => chatHistoryRuntime.projectedMessages(id, hidden), getChatState: id => chatSessions.get(id),
  subscribeChat: listener => { bus.on('chat:stream-progress', listener); return () => bus.off('chat:stream-progress', listener); },
  getWorkHost: () => sessionWorkHost, getScheduler: () => orchestrationRuntime?.sessionScheduler,
  recentEvents, pendingUserInput, pendingUserInputAsync: id => userInputSignalHost.pendingAsync(id),
  deliver: (...args) => taskContextHost.deliverSessionMessage(...args), dispatch: (...args) => dispatchToSession(...args),
  persistRecords: (source, fn) => sessionPersistence.mutate(source, fn), closeExecution: id => chatStream.closeAndWait(id), resetChatState: id => chatSessions.delete(id),
  hasBackground: id => backgroundTaskRuntime.hasProcessBackgroundTasks(id), ensureWorkspaceAwake: id => sessionHibernationRuntime.ensureAwake(id),
  getWorkspaceAdmission: () => workspaceAdmission,
});
taskShellHost.mountRoutes(app);
// 任务图谱：taskboard JSON + task-shell SQLite 聚合为 { nodes, edges }（只读）。
const taskGraphRoutes = require('./src/routes/task-graph').createTaskGraphRoutes({
  getBoard: () => taskBoardRuntime.getBoard(),
  taskGraphData: () => taskShellHost.taskGraphData(),
  getRecord: id => persistedSessions.get(id),
  directories,
  now: () => Date.now(),
});
// 任务面 16 条公开路由已由 Rust 前门独占（native/gateway/src/app/task_routes.rs）；
// 这里只把 Node 独有的存储、锁与索引暴露成回环宿主端口。
require('./src/routes/task-routes-host').mountTaskRoutesHostRoute(app, {
  ports: taskBoardRuntime.routePorts, search: taskSearchRuntime,
  taskGoal: sessionAdmin.taskGoalPorts, taskGraph: taskGraphRoutes,
  attributionMode: () => taskShellHost.attributionSettings().getMode(),
});
const skillSyncRuntime = createSkillSyncRuntime({
  fs,
  path,
  os,
  crypto,
  chokidar,
  skillConverter,
  persistedSessions,
  cwdForSession,
  startDetached: request => orchestrationRuntime.startDetached(request),
  rootDir: __dirname,
  claudeCommand: CLAUDE_CMD,
  auxSessionId: AUX_SESSION_ID,
  logger: console,
});
// /api/skill-sync/* 已由 Rust 前门独占；运行时在这里交给 host-ops 宿主端口。

// ── Per-session providers (backed by cc-switch) ──────────────────────────────
const providerRoutes = createProviderRoutes({
  fs,
  providerDefaultsFile: MULTICC_PATHS.providerDefaultsFile,
  atomicWriteJson,
  providers,
  providerRouterRuntime,
  findProviderReferences,
  persistedSessions, providerRelayShares,
  getAuxConfig, clearAuxProvider, applySessionPatch, previewSessionPatch,
  claudeCmd: CLAUDE_CMD,
  getPort: () => PORT,
  getClaudeOfficialViaProxy: () => CLAUDE_OFFICIAL_VIA_PROXY,
  logger: console,
  relayModelCatalogRuntime: providerRelayModelCatalogRuntime, codexAccountModelCatalogRuntime: codexCatalog,
  providerLimitCache,
  limitRecorder,
  limitCacheStaleMs: Number(process.env.MULTICC_LIMIT_CACHE_STALE_MS) || undefined,
});
const { providerDefaults, validProviderId } = providerRoutes;
// The provider CRUD/probe/reassign/relay routes (providers.rs) and model
// catalogs (/api/{opencode,qoder,grok,commandcode,codebuddy}/models,
// /api/providers/:id/models, /api/codex/models[/sync], model_catalogs.rs) are
// served by the Rust front door; Node keeps only the CLI spawns and caches.
mountModelCatalogsHostRoute(app);
mountProviderRelayHostRoute(app, { authRuntime, modelCatalogRuntime: providerRelayModelCatalogRuntime });
mountCliKeyAccountRoutes(accountRoutesHost.app, { store: require('./src/cli-key-accounts').sharedCliKeyAccountStore(), sessionPersistence });
mountCommandcodeAuthRoutes(accountRoutesHost.app, {
  directories, createSessionRecord, disposeLoginTerminal,
  getStatus: () => {
    const env = { ...process.env };
    secretsVault.applyEnvOverlay(env, { source: 'commandcode_login' });
    return readCommandcodeLogin({ env });
  },
});
// GET /api/claude/models is served by the Rust front door (native/gateway, docs/gateway.md §9); ids are extracted from the local claude CLI bundle.

// The 22 pricing / vendor-quota / quota-bar routes are served by the Rust front
// door (native/gateway/src/app/quota_routes.rs, docs/gateway.md §8). What stays
// in Node is the process-local half — the models.dev price table, the managed
// Chrome profile that scrapes each vendor console, the codex auth files, the
// arkcli subprocess, the quota-bar cache, the Claude usage queue and the
// provider-limit recorders — all reachable only through this one host port.
mountQuotaHostRoute(app, {
  quotaBarCache,
  recordVendor: limitRecorder.recordVendor,
  recordClaude: limitRecorder.recordClaude,
  resolveAccountAuthFile: id => officialAccounts.codexAuthFile(id),
});
// `?account=` quota reads and the subscription panel resolve the same auth
// files through the account-subscription reader; the retired codex mount
// registered it, so it is registered explicitly here.
require('./src/quota/account-subscription-reader').registerAccountSubscriptionReader('codex', { resolveAccountAuthFile: id => officialAccounts.codexAuthFile(id) });
mountCodexOAuthRoutes(accountRoutesHost.app, { getStatus: () => codexOAuthRefresh.status(), directories, createSessionRecord, disposeLoginTerminal }); mountCodexAccountRoutes(accountRoutesHost.app, { accounts: officialAccounts, providers, directories, createSessionRecord, persistedSessionExists: id => persistedSessions.has(id), refresherStatus: id => codexAccountRefresh.status(id), cliLogin }); mountClaudeAccountRoutes(accountRoutesHost.app, { accounts: officialAccounts, providers, credentials: claudeAccountCredentials, logger, cliLogin, recordUsage: (providerId, usage) => limitRecorder.recordOfficialWindows('claude', providerId, { windows: require('./src/quota/official-account-usage').claudeUsageWindows(usage) }) }); require('./src/quota/official-account-usage').createOfficialAccountUsageSweeper({ accounts: officialAccounts, recorder: limitRecorder, logger }).start(); // multi-account management under /api/{codex,claude}/accounts — see src/routes/{codex,claude}-accounts.js
const claudeOAuthSurface = createClaudeOAuthSurface({ refresher: claudeOAuthRefresh, directories, createSessionRecord, persistedSessions, destroySessionCascade, sessionPersistence, appendEvent, disposeLoginTerminal }); claudeOAuthSurface.mountRoutes(accountRoutesHost.app); // see src/routes/claude-oauth.js header
// The token-usage host port stays between the two Provider route phases: the
// public token APIs are served by the Rust front door, accounting still lives here.
mountTokenUsageHostRoute(app, { tracker: roleTokenTracker, logFailure: (event, error) => logger.error(event, { code: error && error.code }) });

providerRoutes.mountManagementRoutes(app);

// GET /api/providers/:appType/:id/balance + GET /api/providers/balances —
// per-provider and all-at-once quota/balance queries for the manage page, reusing
// the usage-limit poller's adapters. Outcomes mirror into the provider-limit cache
// (onResult); lookupCached reads it back so a transient failure answers last-known-
// good cached+stale — never for a 借道 lender (relay routes pass no lookupCached).
require('./src/quota/quota-self-heal').wireQuotaSelfHeal({ app, providers, limitRecorder, providerLimitCache, quotaGuard, codexOAuthRefresh, codexAccountRefresh, officialAccounts, mountProviderBalanceRoutes, getPort: () => PORT }); // shared quota refresh port + stale-gate re-read + codex 401 self-heal

// ZCode / Kimi auth management (desktop key sync, manual key, pre-turn auth
// check) rides the account host port; only their blocking login POSTs stay
// public in Node, forwarded by the front door.
mountZcodeAuthRoutes(accountRoutesHost.app); mountKimiAuthRoutes(accountRoutesHost.app);
mountZcodeAuthLoginRoute(app); mountKimiAuthLoginRoute(app);

// Temp artifacts are served by the Rust front door's dual-root static mount
// (docs/gateway.md §62); the capability <id> bypass lives in
// http_entry::public_path. Only the startup cleanup below reads this module.

// Display state is independent from canonical messages and native CLI transcripts.
const CHAT_HISTORY_SOFT_CAP = 10000;
const CHAT_HISTORY_PAGE = 5;

// Chat history owns persistence, display visibility, pagination and checkpoints.
let _chatMsgIdSeq = 0;
function newChatMsgId() {
  return 'm' + Date.now().toString(36) + '-' + (_chatMsgIdSeq++).toString(36);
}
chatHistoryRuntime = createChatHistoryRuntime({
  history: chatHistoryRepository,
  ...createTaskHistoryRetention({ getBoard: () => taskBoardRuntime.getBoard(), getRecord: id => persistedSessions.get(id), loadHistory: id => chatHistoryRepository.readStrict(id, { allowEmpty: true }) }),
  persistedSessions,
  chatSessions,
  idFactory: newChatMsgId,
  chatBroadcast,
  distillHistoryIntoMemory,
  maybeSchedulePeriodicMemoryReview,
  auxSessionId: AUX_SESSION_ID,
  maxMessages: CHAT_HISTORY_SOFT_CAP,
  historyPageSize: CHAT_HISTORY_PAGE,
  retentionPolicy: sessionId => sessionId === AUX_SESSION_ID
    ? AUX_HISTORY_MAX
    : CHAT_HISTORY_SOFT_CAP,
  cliSwitchGitSnapshot,
  clearAllNativeCliStates,
  buildHandoffCheckpoint,
  rememberActiveCliState,
  sessionPersistence,
  getSessionRunState: id => sessionWorkHost?.getRunState(id) || 'idle',
  getActiveBackgroundTasks: id => backgroundTaskRuntime?.listActiveBackgroundTasks(id) || [],
  chatStream, cwdForSession,
  projectMessages: (sessionId, messages) => projectHistoryUsage(messages, {
    perTurn: persistedSessions.get(sessionId)?.cli === 'codex-exp',
  }), taskShortCode, logger,
});
chatHistoryService = chatHistoryRuntime.service;
createReleaseHistoryHost({ chatHistory: chatHistoryRuntime, apkDistribution, iosOta }).mountRoute(app);
createAuxRunRoutes({ records: persistedSessions, getLog: () => auxRunLog }).mountRoutes(orchestrationHost.app); mountTurnLedgerHostRoute(app, { launch: id => turnLedgerRuntime.launch(id), record: id => turnLedgerRuntime.record(id), trust: input => turnLedgerRuntime.trust(input) }); const { doctor, envDoctor } = require('./src/doctor/service').createDoctorHost({ persistedSessions, loadChatHistory, cwdForSession, auxQueue, getAuxConfig, rootDir: __dirname, dataDir: MULTICC_PATHS.root });
// 宿主与系统操作 40 条公开路由已由 Rust 前门独占（native/gateway/src/app/host_ops_routes.rs）；
// 这里只把 Node 独有的进程/主机副作用暴露成回环宿主端口。
require('./src/routes/host-ops-host').createHostOpsHost({
  express,
  serverRestart: serverRestartRoute,
  update: updateRoute,
  hostWrite: hostWriteDeps,
  skillSync: skillSyncRuntime,
  envDoctor,
  doctor,
}).mountRoute(app);

function loadChatHistory(sessionId) { return chatHistoryRuntime.load(sessionId); }
// Read-only history view.
function viewChatHistory(sessionId) { return chatHistoryRuntime.viewHistory(sessionId); }
function chatLastActivity(sessionId, activeChat) {
  return chatHistoryRuntime.lastActivity(sessionId, activeChat);
}
function scheduleIncrementalSave(sessionId, state) {
  return chatHistoryRuntime.scheduleIncrementalSave(sessionId, state);
}
function appendChatMessage(id,m){return taskContextHost.appendMessage(id,m)}

// The host coordinator owns result/usage/post-turn ordering.
const {
  isCurrentTurnRunner,
  assistantCheckpointKey,
  persistFinalAssistantResult,
  modelAttributionField,
  recordDurableTurnUsage,
  runDurablePostTurn,
} = createChatHostRuntime({
  appendMessage: appendChatMessage,
  timelineField: turnProgress.timeline.field,
  persistUsage: accumulateTokenUsage,
  afterUsageCommit: (sessionId, attribution) => {
    broadcastProviderTokenStats(sessionId, attribution);
    broadcastRoleTokenStats(sessionId);
  },
  getSessionState: (sessionId) => chatSessions.get(sessionId), roleUsageSnapshot: id => roleTokenTracker.snapshot(id),
  consumeHandoff: consumePendingCliHandoff,
  emitTurnComplete: (sessionId, state, completion) => bus.emit('chat:turn-complete', sessionId, state, completion),
  emitDispatchComplete: (operationId, sessionId, text) => bus.emit('chat:dispatch-complete', operationId, sessionId, text),
  emitGatewayComplete: (...args) => bus.emit('chat:gateway-turn-complete', ...args),   // text, sessionId, turnId, requestId
  logSuppressed: (detail) => logger.info('chat_post_turn_suppressed', detail),
});
// Codex usage is cumulative upstream; this host converts it before any consumer sees it.
const codexUsageHost = createCodexUsageHost({
  // The only history read here walks backwards to the newest usage block; the
  // uncopied view is enough and avoids cloning the whole transcript per turn.
  loadHistory: viewChatHistory,
  reconcileRole: reconcileCodexRoleUsage,
  clearIncrementalSave: chatHistoryRuntime.clearIncrementalSave,
  persistFinalAssistantResult,
  modelAttributionField,
  recordDurableTurnUsage,
  recordResultEvent,
  setSessionStatus,
  timelineField: turnProgress.timeline.field,
  logger,
});

const chatErrors = require('./src/chat/error-persistence').createErrorPersister({ appendChatMessage: appendChatMessage }); // errors reach history, not only the live line
function chatBroadcast(sessionName, payload) {
  payload = chatErrors.annotate(sessionName, scopeHostProviderEvent(payload));
  // #110: journal every client-visible event (never blocks or throws), then fan out.
  turnEventJournal.note(sessionName, payload);
  // The sync dispatch bridge sees the same stream via an operation-lineage filter + redacting reducer.
  bus.emit('chat:stream-progress', sessionName, payload);
  taskContextHost.broadcast(sessionName, payload);
}

const subscribeDispatchProgress = createDispatchProgressSubscription({
  bus,
  cliOf: id => persistedSessions.get(id)?.cli || '',
  activeTurnOf: id => chatSessions.get(id)?._activeTurn,
  streamReplayOf: chatReplay.events,
});

// Usage-limit poller — a turn's own provider only; Claude readings are manual-refresh (see src/chat/usage-limit-wiring.js).
const usageLimitPoller = require('./src/chat/usage-limit-wiring').createUsageLimitWiring({
  persistedSessions, providers, chatBroadcast,
  createPoller: require('./src/usage-limit-poller').createUsageLimitPoller,
  recordLimit: limitRecorder.recordSession,
});

// ── WeChat Bridge ──
// Must come after chatSessions/chatBroadcast are declared (TDZ would crash otherwise).
wechatBridge.init({
  persistedSessions,
  chatSessions,
  savePersistedSessions: () => savePersistedSessionsBestEffort('bridge.wechat-session-state'),
  chatBroadcast,
  port: PORT,
});
app.use('/api/wechat', wechatBridge.router);

// ── Feishu Bridge ──
// Same gateway-process architecture as WeChat, but speaks the Feishu open
// platform via @larksuiteoapi/node-sdk WebSocket long connection.
feishuBridge.init({
  persistedSessions,
  chatSessions,
  savePersistedSessions: () => savePersistedSessionsBestEffort('bridge.feishu-session-state'),
  chatBroadcast,
  port: PORT,
});
app.use('/api/feishu', feishuBridge.router);

// ── Telegram / Discord / Slack Bridges ──
// Same gateway-process architecture as WeChat/Feishu; each speaks its platform
// over a NAT-friendly long connection (Telegram long-polling, Discord Gateway
// WS, Slack Socket Mode) and drives its own __<platform>_gateway__ chat session.
for (const [mount, bridge] of [
  ['/api/telegram', telegramBridge],
  ['/api/discord', discordBridge],
  ['/api/slack', slackBridge],
]) {
  bridge.init({
    persistedSessions,
    chatSessions,
    savePersistedSessions: () => savePersistedSessionsBestEffort(`bridge.${mount.slice(5)}-session-state`),
    chatBroadcast,
    port: PORT,
  });
  app.use(mount, bridge.router);
}

// Push subscription routes and terminal notification state share one lifecycle.
// Aux is resolved lazily because its queue is initialized during startup below.
const pushRuntime = createPushRuntime({
  push,
  sessions,
  persistedSessions,
  workspaceClients,
  getAuxQueue: () => auxQueue,
  getTaskState,
  setTaskState,
  parseClassifyResult,
  dispatchStateAction,
  chatSessions,
  timers: { setTimeout, clearTimeout },
  now: Date.now,
  logger: console,
});
// Push routes are owned by the Rust front door.
// The host supplies device stores and sends.
mountPushHostRoute(app, { push, logger: console });
const pushOnOutput = pushRuntime.onOutput;
const pushOnInput = pushRuntime.onInput;
const triggerPush = pushRuntime.notify;
const cleanupPushMonitor = pushRuntime.cleanup;

// ── Task state persistence (step ①): src/session/records.js ─────────
// Hoisted wrappers share the task-state store.
const taskStates = createTaskStateStore({
  persistedSessions, chatBroadcast, workspaceBroadcast, bus,
});
function getTaskState(persisted) { return taskStates.getTaskState(persisted); }
function setTaskState(sessionId, patch, opts) { return taskStates.setTaskState(sessionId, patch, opts); } function pendingUserInput(id) { return userInputSignalHost.pending(id); }
const productionQuestion = createProductionQuestionHost(
  { getStore: () => orchestrationRuntime?.store, getSession: id => chatSessions.get(id), getRecord: id => persistedSessions.get(id), getState: id => getTaskState(persistedSessions.get(id)),
    setState: setTaskState, log: message => console.log(message),
    onResolved: (id, requestId, taskId, extra) => chatBroadcast(id, { type: 'user_input_resolved', requestId, taskId: taskId ?? null, ...(extra || {}) }) });
const userInputSignalHost = productionQuestion.host;

// ── Unattended mode supervisor (docs/unattended-mode.md; decisions in Rust) ──
const unattendedHost = createUnattendedRuntime({ persistedSessions, saveSessions: savePersistedSessionsBestEffort,
  loadHistory: loadChatHistory, setTaskState, userInputSignalHost, getAuxQueue: () => auxQueue, taskContextHost,
  waitInjector, deliverInjection: (id, text, options) => sessionDelivery.deliverSystem(id, text, { ...options, unattendedSystem: true }),
  withdrawQueued: (id, entryId) => (orchestrationRuntime
    ? orchestrationRuntime.sessionScheduler.cancelQueued(id, entryId, { actor: 'unattended', reason: 'paused' })
    : { ok: false, code: 'scheduler_unavailable' }),
  triggerPush, chatBroadcast, logger, appendMessage: appendChatMessage, isRunActive: id => sessionWorkHost?.isRunActive(id) === true, hasQueuedDeliveries: id => (sessionWorkHost ? sessionWorkHost.hasQueuedDeliveries(id) : false),
  // Auto-pool unblock hint; chatTurnEngine is read after initialization.
  getRetryNotBefore: async id => {
    const session = persistedSessions.get(id);
    if (!session) return null;
    try { return await chatTurnEngine.autoProviderRuntime.retryNotBeforeAsync(session); } catch (_) { return null; }
  },
  getTaskState: id => getTaskState(persistedSessions.get(id)), getSchedulerStatus: id => (orchestrationRuntime ? orchestrationRuntime.sessionScheduler.status(id) : null), listSessionIds: () => [...persistedSessions.keys()] });
sessionWorkHost = createProductionWorkHost({ replay: chatReplay,
  runtime: () => orchestrationRuntime,
  getRecord: id => persistedSessions.get(id),
  getChatSession: id => chatSessions.get(id),
  getTaskState,
  getTurnLiveness: id => livenessRuntime.ownership(id),
  broadcast: chatBroadcast,
  setTaskState,
  onTaskBoardQueueEvent: event => taskBoardRuntime.onQueueEvent(event),
  onWorkspaceQueueStatus: (id, status) => workspaceRuntime.setQueueStatus(id, status),
  // Cancellation submits a structured result to classify instead of writing
  // state; classify is the only writer of session/task business state.
  dispatchStateAction,
  reconcileTaskProjection: (taskId, options) => taskBoardRuntime.reconcileRunState(taskId, options),
  classifyDisplay,
  cancelClassify,
  // Stopping the runner also stops the judgement queued for it: drop this
  // session's queued + in-flight classify jobs so a cancelled turn is not still
  // paying for an Aux verdict that will be discarded on arrival.
  cancelSessionClassifyJobs: sessionId => auxQueue.cancelClassifyFor(sessionId),
  chatStream,
  assignKillReason,
  finishProviderAttempt: (attempt, facts) => providerAttemptRuntime.finishAttempt(attempt, facts),
  releaseProviderProducers: (sessionId, reason) => providerAttemptRuntime.forceReleaseProducers(sessionId, reason),
  stopBackgroundForInsert: sessionId => backgroundTaskRuntime.stopForInsert(sessionId), appendMessage: appendChatMessage,
  onTerminalWork: (sessionId, completion) => {
    workspaceAdmission?.settled(sessionId, completion);
    Promise.resolve(sessionHibernationRuntime?.touchTerminal(sessionId, completion)).catch(error => {
      logger.warn('session_hibernation_terminal_touch_failed', {
        sessionId,
        code: /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(String(error?.code || ''))
          ? error.code : 'persistence_failed',
      });
    });
  },
  cancelPreparation(sessionId, reason) {
    const preparation = chatTurnPreparationRuntime.snapshot(sessionId);
    if (preparation.phase === 'preparing' && preparation.turnId) {
      chatTurnPreparationRuntime.abortPreparation(sessionId, preparation.turnId, reason);
    }
  },
  log: logger,
}, userInputSignalHost);

// Rust reads the scan ring via this host.
mountScanHistoryHostRoute(app, { scanHistory, maxPasses: SCAN_HISTORY_MAX_PASSES });
// Rust answers /healthz, /readyz, /metrics and /api/repo-operations; it reads
// the process uptime/readiness flags, the merged metric table and the repo-actor
// status through this host port. orchestrationRuntime is assigned later, so it
// stays behind a getter.
mountServerCoreHostRoute(app, {
  metrics,
  eventLoopMetrics: () => observability.eventLoopMetrics(),
  chatSessions,
  isStreamBusy: name => chatStream.status(name)?.busy,
  wss,
  gitQueueDepth,
  waitInjector,
  getOrchestrationRuntime: () => orchestrationRuntime,
  isReady: () => serviceReady && !authSecurity.shuttingDown() && commanderMigrationState.snapshot().ready,
  readinessDetails: () => ({ commanderMigration: commanderMigrationState.snapshot() }),
  defaultRepoActor,
});

// ── Turn state + task attribution ───────────────────────────────────────────
// Structured finalization facts are the sole source of chat turn state. Aux is
// best-effort task naming/grouping at turn end, with a 60s unresolved-name scan;
// Aux health cannot hold or rewrite the P/D/W/B/E scheduler transition.

const backgroundTaskRuntime = createBackgroundTaskRuntime({
  broadcast: chatBroadcast,
  observeTask: observation => orchestrationRuntime.observeTask(observation),
  noteBgResultInjected: sessionName => waitInjector.noteBgResultInjected(sessionName),
  deliverSystem: (sessionName, text, origin) => sessionDelivery.deliverSystem(sessionName, text, origin),
  readFile: fs.readFileSync,
  realpath: fs.realpathSync,
  tmpdir: () => '/tmp',
  getuid: () => process.getuid(),
  setTimer: setTimeout,
  clearTimer: clearTimeout,
  now: Date.now,
  // SDK 0.3.289 控制通道（router 上无 this 依赖的箭头方法）；非 SDK 车道 null/false，runtime 回退。
  fetchTaskOutput: chatStream.getTaskOutput,
  stopTask: chatStream.stopTask,
  logger,
});

sessionHibernationRuntime = require('./src/session/hibernation-composition').createSessionHibernation({
  records: persistedSessions, directories, persistence: sessionPersistence, loadHistory: id => viewChatHistory(id),
  gitWorktreeValidate, gitWorktreeDetach, gitWorktreeAdd, gitWorktreeMergeState,
  invalidSessions, defaultRepoActor, chatSessions, chatStream,
  backgroundTaskRuntime, waitInjector, orchestrationRuntime, sessionWorkHost,
  getWorkspaceAdmission: () => workspaceAdmission, workspaceBroadcast, metrics, logger,
});
workspaceAdmission = require('./src/workspace/admission').createWorkspaceAdmission({
  file: MULTICC_PATHS.taskShellDbFile, records: persistedSessions, directories, persistence: sessionPersistence,
  ensureDir: ensureDirGitReady, addWorktree: gitWorktreeAdd, validate: gitWorktreeValidate, describeDirFailure,
  getState: id => chatSessions.get(id), hibernation: () => sessionHibernationRuntime,
  hasBackground: id => backgroundTaskRuntime.hasProcessBackgroundTasks(id), streamBusy: id => !!chatStream.status(id)?.busy,
  closePersistent: id => chatStream.closeAndWait(id),
  parkPersistent: (id, workspace) => chatStream.parkWorkspace(id, workspace),
  claimPersistent: (id, workspace, opts) => chatStream.claimWorkspace(id, workspace, opts),
  // Escalation inputs: stopping a pinned writer also means settling the host's
  // belief that its background work still runs — and only once it went quiet.
  reapBackground: (id, opts) => backgroundTaskRuntime.reapSessionShadows(id, opts),
  backgroundSilence: id => backgroundTaskRuntime.backgroundSilenceMs(id),
  updateCwd: (id, cwd) => { const state = chatSessions.get(id); if (state) state.cwd = cwd; },
  pendingInput: id => userInputSignalHost.pending(id), pendingInputAsync: id => userInputSignalHost.pendingAsync(id), loadHistory: id => viewChatHistory(id),
  budgets: { executionLimit: Number(process.env.MULTICC_WORKSPACE_RUN_LIMIT || 8), residentLimit: Number(process.env.MULTICC_WORKSPACE_RESIDENT_LIMIT || 128), restoreLimit: Number(process.env.MULTICC_WORKSPACE_RESTORE_LIMIT || 2), staleUncertainMs: Number(process.env.MULTICC_WORKSPACE_STALE_UNCERTAIN_MS || 300000), stuckBlockedMs: Number(process.env.MULTICC_WORKSPACE_STUCK_BLOCKED_MS || 1800000), stuckSilenceMs: Number(process.env.MULTICC_WORKSPACE_STUCK_SILENCE_MS || 600000) },
  log: (event, data) => logger.warn(event, data),
  // P4 交付蒸馏：merge 回执 published 后把交付记录写进任务级记忆。
  onIntegrationPublished: ({ sessionId, taskId, baseRef, operationId }) => {
    if (!sessionId || !taskId) return;
    taskMemoryDistiller.record({
      dirId: persistedSessions.get(sessionId)?.dirId, taskId,
      text: `交付记录：代码已合入 ${baseRef}（${String(operationId).slice(0, 24)}）`,
      tag: '交付',
    });
    // Auto-reclaim the task worktree once its delivery is merged (opt-out).
    // Best-effort: a running task or failed removal keeps the worktree for
    // the manual one-click action.
    if (process.env.MULTICC_TASK_WORKTREE_AUTOCLEANUP !== '0' && taskBoardRuntime?.taskWorktree?.cleanupWorktree) {
      require('./src/task-worktree').cleanupAfterPublication({ repoActor: defaultRepoActor, dirPath: directories.get(persistedSessions.get(sessionId)?.dirId)?.path, taskId, cleanup: taskBoardRuntime.taskWorktree.cleanupWorktree })
        .then(result => { if (result?.removed) logger.info('task_worktree_autocleanup', { taskId }); })
        .catch(error => logger.warn('task_worktree_autocleanup_failed', { taskId, code: error?.code || 'failed' }));
    }
  },
});

const airSync = require('./src/workspace/air-routes').mountAirRoutes(app, {
  storageNotice: airNotices.storageNotice,
  admission: workspaceAdmission, hibernation: () => sessionHibernationRuntime,
  logger, send: sendWs, subscribe: workspaceRuntime.subscribe, registerSync: workspaceRuntime.setAirSync,
  records: persistedSessions, pendingUserInput,
  // 运行时那张表（不是落盘的那张）：终端行要说准「进程还在不在、多久没动」，只有它
  // 知道。按引用传，所以每轮快照读到的都是当下的事实。
  sessions,
  directories,
  shell: taskShellHost,
  getBoard: () => taskBoardRuntime.getBoard(), markTaskSeen: id => taskBoardRuntime.markTaskSeen(id),
  clis: CLIENT_CHAT_CLIS,
  providerName: sessionProviderName,
  effectiveModel: effectiveSessionModel,
  effectiveEffort: effectiveSessionEffort, mergeStateCached,
  serializeSubagent, getSessionRunState: id => sessionWorkHost?.getRunState(id) || 'idle', cronSessionIds: () => cronTasks.sessionIds(),
});
airNotices.bindPublisher(() => airSync.publishStatus());

const tuiChatMirrorRuntime = createTuiChatMirrorRuntime({ enabled: tuiChatMirrorEnabled(), records: persistedSessions, cwdForSession, providerFor, send: sendWs, setSessionStatus, saveBestEffort: source => savePersistedSessionsBestEffort(source), logger });

// Chat turn engine: per-turn + persistent-streaming turn execution, the chat
// stream-json WebSocket handler and the orchestration wait-injector helpers.
// Late/reassigned host bindings are injected as getters; stable containers,
// hoisted functions and early consts by reference.
const chatTurnEngine = createChatTurnEngine({ replay: chatReplay,
  getBackgroundTaskRuntime: () => backgroundTaskRuntime,
  getSessionWorkHost: () => sessionWorkHost,
  getChatHistoryRuntime: () => chatHistoryRuntime,
  getChatHistoryService: () => chatHistoryService,
  getExperimentalTuiChatRuntime: () => tuiChatMirrorRuntime, applyPendingConfiguration: cliSwitchRuntime.applyPendingConfiguration,
  getSessionHibernation: () => sessionHibernationRuntime, getWorkspaceAdmission: () => workspaceAdmission,
  getSessionGitRuntime: () => sessionGitRuntime, isCliAvailable: cli => !!cliAvailabilitySummary()[cli]?.available,
  isShuttingDown: () => authSecurity.shuttingDown(),
  getPort: () => PORT,
  getClaudeOfficialViaProxy: () => CLAUDE_OFFICIAL_VIA_PROXY,
  persistedSessions,
  chatSessions,
  invalidSessions,
  logger,
  folderMemory,
  detached,
  routerToolHost,
  turnProgressHeartbeat,
  turnTiming: turnProgress.timing(),
  turnTimeline: turnProgress.timeline,
  deliveryProbeRegistry: turnProgress.deliveryProbe(),
  providerRouterRuntime, providerAttemptRuntime, providerLimitCache, quotaGuard,
  apiErrorHost,
  codexUsageHost,
  usageLimitPoller,
  taskContextHost,
  userInputSignalHost,
  chatTurnPreparationRuntime,
  workspaceBroadcast,
  setSessionStatus,
  noteReportedModel,
  spawn,
  cwdForSession,
  handleGatewayControl,
  pushToGateway,
  providerFor,
  cliAvailabilitySummary,
  savePersistedSessionsBestEffort,
  saveNotes,
  pendingNotesFor,
  appendEvent,
  classifyTurnEnd, runClassifyNow,
  cancelClassify,
  emitRunningNotify,
  emitTurnOutcome,
  ensureCurrentTask,
  getTaskState,
  setTaskState, getUnattendedState: id => unattendedHost.get(id), getUnattendedHost: () => unattendedHost,
  buildGatewayPrompt,
  buildDispatchContextPrompt,
  // Per-turn plan/progress layer (kind 'turn-plan'; aux/gateway excluded in the composer).
  // markPlanContextReset re-arms the full block after a transcript prune.
  buildPlanPrompt: buildPlanProgressPrompt,
  markPlanContextReset,
  appendChatMessage,
  loadChatHistory,
  viewChatHistory,
  scheduleIncrementalSave,
  chatBroadcast,
  sendWs,
  turnEventJournal,
  persistFinalAssistantResult,
  modelAttributionField,
  recordDurableTurnUsage,
  runDurablePostTurn,
  isCurrentTurnRunner,
  assistantCheckpointKey,
  recordAdapterUserInput,
  isGlm52Session,
  normalizeEffort,
  cliEffortLevel,
  recordApiSuccess,
  evaluateTurnApiError,
  meaningfulTurnOutput,
  turnHasSideEffects,
  clearSessionApiErrorState,
  scheduleOwnedRetry,
  getTokenUsage,
  resetRoleTokenUsage,
  providerTokenWindows,
  getPendingMemoryDistill,
  effectiveSessionModel,
  effectiveSessionEffort,
  codexStreamDisconnectContinuePrompt,
  CODEX_STREAM_DISCONNECT_CONTINUE_MAX,
  GATEWAY_ID,
  MULTICC_IMG_HINT,
  CHAT_HISTORY_PAGE,
});

// The chat domain owns admission through the chat:run bus listener.
bus.on('chat:run', (sessionName, text, opts) => {
  chatTurnEngine.admitChatWork(sessionName, text, opts).catch(error => {
    logger.error('chat_work_admission_failed', { sessionId: sessionName, error: error.message });
  });
});


// Rust decides eligibility; chat streams own writes.
// See src/chat/held-turn-injection.js.
const heldTurnInjection = require('./src/chat/held-turn-injection').createHeldTurnInjection({
  getRecord: id => persistedSessions.get(id),
  chatStream,
  isRunActive: id => sessionWorkHost.isRunActive(id),
  appendMessage: (id, message) => appendChatMessage(id, message),
  activeTurnId: id => chatSessions.get(id)?._activeTurn?.turnId || null,
  hasPersistedDelivery: (id, identity) => chatTurnEngine.persistedOrchestrationDelivery(id, identity),
  log: message => console.log('[multicc/held-turn]', message),
});

orchestrationRuntime = createOrchestrationRuntime({
  file: MULTICC_PATHS.orchestrationFile, databaseFile: MULTICC_PATHS.orchestrationDbFile,
  runChatTurn: chatTurnEngine.runChatTurn,
  isBusy: dispatchTargetBusy, busyReasons: dispatchTargetBusyReasons, noteBlockedDelivery: id => workspaceAdmission?.noteBlockedDelivery(id), deliveryGroup: id => taskShellHost.workspaceGroup(id),
  hasPersistedDelivery: chatTurnEngine.persistedOrchestrationDelivery,
  // A typed message goes INTO the held turn when the lane can take it; the
  // predicate is Rust (background-hold) and refusals are a no-op.
  tryInjectHeldTurn: heldTurnInjection.tryInject,
  heldTurnInjectable: heldTurnInjection.canInject,
  heldForBackground: id => { try { return chatStream.heldTurn(id)?.held === true; } catch (_) { return false; } },
  runnerDeliveryProbe: (sessionId, identity) => chatTurnEngine.runnerDeliveryHandoff(sessionId, identity),
  // Surface lost or stalled deliveries.
  deliverOutbox: chatTurnEngine.deliverOrchestrationOutbox, ...require('./src/chat/session-notices').createSessionNotices({ appendChatMessage: appendChatMessage, chatBroadcast }),
  probe: chatTurnEngine.probeExplicitWait,
  detachedAdapter: detached,
  recoverDispatchResult: chatTurnEngine.recoverDispatchOperation,
  replayRecoveredDispatchEffects: () => {},
  // Check task-bound workspace locks before claiming delivery.
  isDeliveryLocked: sid => !!persistedSessions.get(sid)?.taskBoundTaskId
    && !!sessionHibernationRuntime?.isLocked?.(taskShellHost.workspaceGroup(sid)),
  beforeDeliver: async descriptor => { await chatTurnEngine.prepareQueuedTurn(descriptor); return workspaceAdmission.beforeDeliver(descriptor); },
  getSessionRecoveryState: id => sessionWorkHost.recoveryState(id), getSessionRecoveryFacts: id => sessionWorkHost.recoveryFacts(id),
  getSessionRecoveryStateAsync: id => sessionWorkHost.recoveryStateAsync(id), ensureSessionWorkState: id => userInputSignalHost.pendingAsync(id), rustQuestionOwner: true,
  onSchedulerEvent: event => { sessionWorkHost.onSchedulerEvent(event); },
  workerIntervalMs: Math.max(100, Number(process.env.MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS) || 1000),
  log: message => console.log('[multicc/wait]', message),
});
const processingWatchdog = createProcessingWatchdog({
  listRecords: () => persistedSessions.entries(),
  getTaskState,
  getChatSession: id => chatSessions.get(id),
  getStreamStatus: id => chatStream.status(id),
  getPreparation: id => chatTurnPreparationRuntime.snapshot(id),
  getSchedulerStatus: id => orchestrationRuntime.sessionScheduler.status(id),
  isPidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
  },
  cancelTurn: (id, options) => sessionWorkHost.cancelActiveTurn(id, options), settleRecoveredQuestion: id => sessionWorkHost.settleRecoveredQuestion(id),
  logger,
});
// Companion to the dead-runner watchdog: observes the liveness `stalled` verdict.
// Silence is negative evidence, so destructive recovery is explicit opt-in only.
const envNumber = (value, fallback) => (value ? Number(value) : fallback);
const stalledTurnRecovery = createStalledTurnRecovery({
  listRecords: () => persistedSessions.entries(), getTaskState, getChatSession: id => chatSessions.get(id),
  getStreamStatus: id => chatStream.status(id), assessLiveness: id => livenessRuntime.assess(id), getTurnStatus: id => turnProgressHeartbeat.status(id),
  stallSilentMs: envNumber(process.env.MULTICC_STALL_SILENT_MS, livenessRuntime.thresholds.stallSilentMs), startingGraceMs: envNumber(process.env.MULTICC_STALLED_STARTING_GRACE_MS),
  confirmations: envNumber(process.env.MULTICC_STALLED_CONFIRMATIONS), cooldownMs: envNumber(process.env.MULTICC_STALLED_COOLDOWN_MS),
  autoCancel: process.env.MULTICC_STALLED_AUTO_CANCEL === '1',
  cancelTurn: (id, options) => sessionWorkHost.cancelActiveTurn(id, options), logger,
});
const providerLogWatchdog = createProviderLogWatchdog({ replay: chatReplay, listRecords: () => persistedSessions.entries(), getChatSession: id => chatSessions.get(id),
  broadcast: (id, evt) => chatBroadcast(id, evt), cancelTurn: (id, options) => sessionWorkHost.cancelActiveTurn(id, options),
  intervalMs: envNumber(process.env.MULTICC_PROVIDER_LOG_INTERVAL_MS), minSilenceMs: envNumber(process.env.MULTICC_PROVIDER_LOG_MIN_SILENCE_MS), logger,
  recordLimit: limitRecorder.recordSession });
const logHousekeeping = createLogHousekeeping({ logsDir: path.join(__dirname, 'logs'), logger,
  retainDays: envNumber(process.env.MULTICC_LOG_RETAIN_DAYS), keepTailBytes: envNumber(process.env.MULTICC_LOG_KEEP_TAIL_BYTES) });
routerToolHost.configure({ records: persistedSessions, dispatchToSession, createTask: input => taskShellHost.createTask(input), orchestrationRuntime, taskBoard: taskBoardRuntime,
  recordUserInput: signal => sessionWorkHost.recordInputAsync(signal), listSecrets: () => secretsVault.list(), secretTools: createSecretTools({ vault: secretsVault, resolveSessionCwd: id => { const rec = persistedSessions.get(id); return rec ? cwdForSession(rec) : null; } }),
  cancelActiveTurn: (id, opts) => sessionWorkHost.cancelActiveTurn(id, opts), onDispatchCancelled: id => cancelDispatchRun(id), subscribeDispatchProgress, recordRouterAdmission, imageBridge: createOfficialImageBridgeRuntime({ paths: MULTICC_PATHS, resolveSessionCwd: cwdForSession, providers, officialAccounts, registerArtifact: docsRegistry.register, codexCommand: cliCommands.codex }), getTaskContext: (context, query) => taskShellHost.refillContext(context.sessionId, { ...query, receiptId: context.requestId }) });

waitInjector.init({
  inject: (session, text, opts) => sessionDelivery.deliverContinuation(session, text, opts),
  isBusy: chatTurnEngine.orchestrationChatBusy,
  hasExplicitWait: session => orchestrationRuntime.hasPending(session),
  exec: (cmd, cwd) => new Promise((resolve) => {
    require('child_process').exec(cmd, { cwd, timeout: 20000, maxBuffer: 1024 * 1024, env: process.env },
      (err, stdout, stderr) => resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? (err.code || 1) : 0 }));
  }),
  log: (m) => console.log('[multicc/wait]', m),
});

// Durable wait/callback, detached operation and observed-task HTTP surfaces share
// one controller boundary over the already-composed orchestration runtime.
const orchestrationRoutes = createOrchestrationRoutes({
  records: persistedSessions,
  runtime: orchestrationRuntime,
  waitInjector,
  detached,
  cwdForSession,
  resolveCwd,
  toWaitDto,
  withApiMeta,
  requestContext,
  v1Error,
  // Options carry the cancel intent's source/operationId through to classify;
  // dropping them here is what made repeat clicks look like distinct cancels.
  cancelActiveTurn: (sessionId, options) => sessionWorkHost.cancelActiveTurn(sessionId, options),
  dismissUserInput: (id, requestId) => sessionWorkHost.dismissUserInput(id, requestId),
  busyReasons: dispatchTargetBusyReasons,
  // "Cancel did not take" gets one more move: stop the writer holding it.
  unstickBlocked: (id, opts) => workspaceAdmission?.escalate(id, opts),
});
orchestrationRoutes.mountHostRoutes(orchestrationHost.app);
orchestrationHost.mountRoute(app);

// WebSocket authentication, endpoint routing, terminal attachment and keep-alive
// live behind one transport boundary. Mutable auth/shutdown state stays lazy.
mountWsConnectionRouter(wss, { machines, wsHost,
  metrics,
  logger,
  share,
  parseCookies,
  isLocalRequest,
  isRequestPeerAllowed: req => !networkPolicy.lanOnly || isPrivateRequestPeer(req),
  authSecurity,
  voiceAsr,
  ttsService,
  workspaceRuntime,
  auxQueue,
  auxSessionId: AUX_SESSION_ID,
  loadChatHistory,
  viewChatHistory,
  sessions,
  persistedSessions,
  createSession,
  sendWs,
  resolveCwd,
  tmuxWriteInput,
  tmuxResize,
  tmuxCaptureSnapshot,
  applyMaxClientSize,
  pushOnInput,
  handleChatWs: (ws, req, urlObj) => chatTurnEngine.handleChatWs(ws, req, urlObj),
  getShuttingDown: () => authSecurity.shuttingDown(),
  getAccessToken: () => authSecurity.accessToken(),
  allowLegacyWsCookie: ALLOW_LEGACY_WS_COOKIE,
  allowLegacyWsToken: ALLOW_LEGACY_WS_TOKEN,
  fs,
  path,
  os,
});

// Initialize AuxQueue (loads history, registers __aux__ session)
auxQueue.init();
// __aux__ 是固定 id；若同一进程内它曾被删除并重建，清掉历史队列的墓碑。
if (chatHistoryRuntime) chatHistoryRuntime.registerSession('__aux__');

// Session trigger bounded context: owns CRUD, watcher/cron lifecycle and
// post-turn dispatch. It is created before async repository recovery so every
// earlier host callback can safely call teardownSession without a TDZ window.
const triggerRuntime = createSessionTriggers({
  crypto,
  cron,
  chokidar,
  fs,
  path,
  bus,
  persistedSessions,
  chatSessions,
  sessionPersistence,
  saveBestEffort: savePersistedSessionsBestEffort,
  cwdForSession,
  appendEvent,
  chatBroadcast,
  timers: { setTimeout, clearTimeout },
  now: Date.now,
  logger,
});
const eventsHost = require('./src/events/host').createEventsHost({ bus, persistedSessions, chatSessions, saveBestEffort: savePersistedSessionsBestEffort, rulesFile: MULTICC_PATHS.eventRulesFile, secretsVault, latestAssistantConclusion: (...a) => chatHistoryRuntime.latestAssistantConclusion(...a), createChatTask: i => taskShellHost.createTask(i), admit: (id, text, opts) => chatTurnEngine.admitChatWork(id, text, opts), notify: (...a) => pushRuntime.notify(...a), logger });
// 事件/触发器/标注的公开路由由 Rust 前门独占；宿主端口只暴露进程内事实。
require('./src/routes/events-host').createEventsRuntime({
  hub: eventsHost.hub,
  engine: eventsHost.engine,
  persistedSessions,
  sessionPersistence,
  appendEvent,
  triggerRuntime,
  cron,
  logger,
}).mount(app);
const teardownTriggers = triggerRuntime.teardownSession;

const ensureFirstRunDirectory = async () => {
  if (!_state.needsDefaultDirectory || directories.size > 0) return;
  const result = await directoryModule.host.registerDefaultDirectory({
    name: '我的工作区',
    path: MULTICC_PATHS.defaultWorkspacePath,
  });
  if (!result.ok) {
    logger.warn('default_directory_create_failed', { reason: result.message });
    return;
  }
  logger.info('default_directory_created', { id: result.data.id, path: result.data.path });
};
const startupRepoReady = Promise.resolve().then(providers.migrateLegacyProviderProtocols).then(() => sessionHibernationRuntime.reconcileStartup()).then(ensureFirstRunDirectory).then(initWorktrees)
  .catch(error => console.error('[multicc] async repo startup failed:', error.message))
  .then(async () => {
    commanderMigrationState.setPhase('complete');
    for (const dir of directories.values()) await seedCommanderSession(dir);
    const migration = await taskShellHost.migrateTaskSessions();
    if (!migration.ok) logger.warn('task_first_migration_pending', { errors: migration.errors });
  })
  .catch(error => {
    commanderMigrationState.setPhase('complete');
    for (const dir of directories.values()) {
      commanderMigrationState.setDirectory(dir.id, {
        status: 'failed', code: 'commander_migration_startup_failed',
      });
    }
    logger.error('commander_migration_startup_failed', { error: error && error.message });
  })
  .then(() => recoverTmuxSessions())
  .catch(error => console.error('[multicc] async tmux recovery failed:', error.message));

// Scheduled tasks (定时任务): every rule owns one fixed Air task and enters it through the
// task-shell receipt protocol, complementing the lower-level per-session triggers.
cronTasks.mount(app); createDocsMemoryHost({ docs: docsRegistry, memory: memoryBrowser, memo: memoModule.controller, notes: notesStore, directories, resolveTaskTitle: id => taskShellHost.artifactTaskTitle(id), resolveTaskId: id => taskShellHost.artifactTaskId(id), resolveDir: id => directories.get(persistedSessions.get(id)?.dirId)?.path || null }).mount(app); mountSecretsVaultHostRoute(app, { vault: secretsVault }); pluginsRoutes.createPluginsRoutes({ pluginsDir: path.join(__dirname, 'plugins'), paths: MULTICC_PATHS, autoRefresh: true, platform: process.platform, arch: process.arch, logger, resident: { port: () => PORT, alert: pushRuntime.notifyHost } }).mount(app); // docs-registry/secrets-vault=管理表/保险箱；plugins=内置+已装插件、插件列表、常驻插件。同行守 3000 行
cronTasks.init({
  directories,
  clis: CLIENT_CHAT_CLIS,
  ready: startupRepoReady,
  createTask: input => taskShellHost.createTask(input),
  getTask: id => taskShellHost.taskEntry(id),
  sendTaskMessage: (id, text, options) => taskShellHost.sendTaskMessage(id, text, options),
  resolveTaskId: sessionId => taskShellHost.artifactTaskId(sessionId),
  taskSummary: id => taskShellHost.taskSummary(id),
  notifyBroken: info => pushRuntime.notify(info?.sessionId || info?.taskId || 'cron', 'error', info?.message), taskBoard: () => taskBoardRuntime,
});
// In-process external-tunnel monitor (replaces phtunnel-monitor.sh watchdog).
tunnel.init();

// Graceful shutdown and service timers live in src/host-lifecycle.js; mutable host state stays lazy via accessors.
const { shutdownCoordinator, trackServiceTimer, gracefulShutdown } = createHostLifecycle({ replay: chatReplay,
  isResidentSession,
  getShuttingDown: () => authSecurity.shuttingDown(),
  setShuttingDown: v => authSecurity.setShuttingDown(v),
  setServiceReady: (v) => { serviceReady = v; },
  getChatHistoryRuntime: () => chatHistoryRuntime,
  getOrchestrationRuntime: () => orchestrationRuntime,
  chatSessions,
  sessions,
  auxQueue,
  appendChatMessage: appendChatMessage,
  isCurrentTurnRunner,
  recordPartialCheckpoint,
  assistantCheckpointKey,
  savePersistedSessionsBestEffort,
  waitInjector,
  cronTasks,
  tunnel,
  skillSyncRuntime,
  triggerRuntime, eventsHost,
  pushRuntime,
  lanDiscovery,
  wechatBridge,
  feishuBridge,
  telegramBridge,
  discordBridge,
  slackBridge,
  wss,
  server,
  turnProgressHeartbeat,
  backgroundTaskRuntime,
  cancelClassify,
  assignKillReason, finishProviderAttempt: (attempt, facts) => providerAttemptRuntime.finishAttempt(attempt, facts),
  chatStream,
  cleanupPushMonitor,
  stopOutputCapture,
  routerToolHost,
  sessionPersistence,
  qwenAudioSupervisor,
  sessionHibernationRuntime,
});
shutdownCoordinator.onClose(async () => { await workspaceRuntime.close(); taskShellHost.close(); workspaceAdmission.close(); }); shutdownCoordinator.onClose(() => codexProxyMounts.codex?.close?.()); shutdownCoordinator.onClose(async () => { await providerLimitCache.close(); providerQuotaHistory.close(); }); shutdownCoordinator.onClose(() => unattendedHost.shutdown());
// Terminal error handler: redacts next(err)/asyncHandler failures so clients cannot
// fingerprint the filesystem. Registered LAST so everything falls here.
app.use(safeErrorHandler(logger));

(async () => {
  shutdownCoordinator.onClose(await watchEffortCatalog(MULTICC_PATHS.cliEffortCatalogFile));
  await providerLimitCache.ready();
  await startupRepoReady;
  for (const id of persistedSessions.keys()) await userInputSignalHost.pendingAsync(id);
  workspaceAdmission.initialize();
  await orchestrationRuntime.start();
  // Replay restart-settled turns once (watchdog/startup recovery may have written E+cancelledAt
  // before the supervisor was ready), so a live session is never left input-locked.
  const reconciled = await unattendedHost.reconcileStartup().catch(error => {
    logger.warn('unattended_startup_reconcile_failed', { error: error?.message || String(error || '') });
    return null;
  });
  if (reconciled?.failedIds?.length) {
    logger.warn('unattended_startup_reconcile_partial', {
      failed: reconciled.failedIds.length, sessionIds: reconciled.failedIds,
    });
  }
  workspaceRuntime.hydrateQueueStatuses(await orchestrationRuntime.sessionScheduler.queueSummaries([...persistedSessions.keys()]));
  const gatewayChildMode = gatewayChild.isGatewayChild(process.env);
  if (!gatewayChildMode && networkPolicy.development) {
    try {
      const requestedPort = PORT;
      PORT = await selectListenPort(networkPolicy);
      if (PORT !== requestedPort) {
        logger.warn('development_port_fallback', { requestedPort, selectedPort: PORT, host: BIND_HOST });
      }
    } catch (err) {
      logger.error('listen_failed', { host: BIND_HOST, port: PORT, error: err.message });
      process.exit(1);
    }
  }
  // Behavior lives in src/gateway-child.js; this is only the wiring. Hidden
  // behind the front door we must not bind the public port: the Rust gateway
  // owns it and forwards one PROXY v1 line per connection to the loopback port.
  if (!gatewayChildMode) {
    server.once('error', err => {
      logger.error('listen_failed', { host: BIND_HOST, port: PORT, error: err.message, code: err.code });
      process.exit(1);
    });
    server.listen(PORT, BIND_HOST, onListening);
  } else {
    gatewayChild.listenBehindGateway(server, { port: gatewayChild.internalPort(process.env), logger, onListening });
  }
  function onListening() {
    logger.info('server_listening', { host: BIND_HOST, port: PORT, remote: !networkPolicy.allowRemote ? false : true, development: networkPolicy.development });
    void lanDiscovery.reconcile();
    console.log(`\n  MultiCC is running at http://${BIND_HOST.includes(':') ? `[${BIND_HOST}]` : BIND_HOST}:${PORT}\n`);
    console.log(`  Manage sessions at http://${BIND_HOST.includes(':') ? `[${BIND_HOST}]` : BIND_HOST}:${PORT}/manage\n`);
    console.log(`  Use Tailscale / ngrok for HTTPS access from external devices.\n`);
    seedTokenUsageFromHistory();
    backfillReportedModels();                       // recover runtime model for pre-upgrade sessions
    skillSyncRuntime.start();
    triggerRuntime.start(); eventsHost.start();
    sessionHibernationRuntime.start();
    worktreeOrphanScanner = require('./src/workspace/orphan-scan').createWorktreeOrphanScanner({
      records: persistedSessions, directories, repoActor: defaultRepoActor, logger,
      deleteOrphans: process.env.MULTICC_WORKTREE_ORPHAN_DELETE === '1',
      listTaskWorktreePaths: () => Object.values(taskBoardRuntime?.getBoard?.()?.tasks || {}).map(task => task?.worktreePath),
    });
    worktreeOrphanScanner.start();
    try { voiceHost.prepareBoot(); } catch (err) { logger.warn('voice_boot_prepare_failed', { error: err.message }); }
    qwenAudioSupervisor.reconcileAll().catch(err => logger.warn('voice_reconcile_failed', { error: err && err.message }));
    // Resident children are a machine-wide process budget, not a per-directory one.
    const residentPool = require('./src/chat/resident-pool').createResidentPoolComposition({ chatStream, backgroundTaskRuntime, sessionWorkHost, logger, getWorkspaceAdmission: () => workspaceAdmission }); trackServiceTimer(setInterval(() => residentPool.sweep(), residentPool.policy().sweepMs));
    trackServiceTimer(setTimeout(() => scanAndReclassify(), 6000));
    trackServiceTimer(setInterval(() => scanAndReclassify(), SCAN_INTERVAL_MS));
    trackServiceTimer(setInterval(() => processingWatchdog.sweep()
      .catch(error => logger.warn('processing_watchdog_sweep_failed', { error: error.message })), PROCESS_WATCHDOG_INTERVAL_MS));
    trackServiceTimer(setInterval(() => stalledTurnRecovery.sweep()
      .catch(error => logger.warn('stalled_turn_recovery_sweep_failed', { error: error.message })), envNumber(process.env.MULTICC_STALLED_INTERVAL_MS, STALLED_RECOVERY_INTERVAL_MS)));
    trackServiceTimer(setInterval(() => providerLogWatchdog.sweep()
      .catch(error => logger.warn('provider_log_watchdog_sweep_failed', { error: error.message })), providerLogWatchdog.PROVIDER_LOG_WATCHDOG_INTERVAL_MS));
    logHousekeeping.runOnce().catch(err => logger.warn('log_housekeeping_failed', { error: err.message }));
    trackServiceTimer(setInterval(() => logHousekeeping.runOnce().catch(err => logger.warn('log_housekeeping_failed', { error: err.message })), LOG_HOUSEKEEPING_INTERVAL_MS));
const cleanupArtifacts = () => { try { return artifacts.cleanup(undefined, docsRegistry.listPermanentArtifactIds()); } catch (error) { logger.warn('artifact_cleanup_pin_read_failed'); return 0; } }; cleanupArtifacts();
    trackServiceTimer(setInterval(cleanupArtifacts, 6 * 3600 * 1000));
    if (!gatewayChildMode) {
      const retention = new (getNative().AssistSnapshotRetention)(MULTICC_PATHS.assistDir);
      shutdownCoordinator.onClose(() => retention.stop());
    }
    const runtimeHomesJanitor = require('./src/runtime-homes-janitor');
    runtimeHomesJanitor.startRuntimeHomesJanitor({ ttlDays: envNumber(process.env.MULTICC_RUNTIME_HOME_TTL_DAYS, runtimeHomesJanitor.DEFAULT_TTL_DAYS), trackTimer: trackServiceTimer, log: (message) => logger.info('runtime_home_cleanup', { message }) });
    // Keep the official OAuth credential alive. The check is a credential read;
    // it only runs the CLI once the expiry is close, so the router never has to
    // report "run `claude` once to refresh the Keychain" to a user. Boot counts
    // as a check because a machine that was asleep wakes up with a stale token.
    claudeOAuthRefresh.check('boot').then(() => claudeOAuthSurface.afterRefresh('boot'));
    trackServiceTimer(setInterval(() => claudeOAuthRefresh.check().then(() => claudeOAuthSurface.afterRefresh('periodic')), CLAUDE_OAUTH_CHECK_INTERVAL_MS));
    // Same job for the shared default codex login (~/.codex/auth.json): keep
    // the one-hour access token fresh so concurrent provider-less codex turns
    // never race over the single-use refresh token.
    codexOAuthRefresh.check('boot'); codexAccountRefresh.checkAll('boot').catch(err => logger.warn('codex_account_refresh_failed', { error: err.message })); // official-account codex credentials: same cadence, one refresher per logged-in account
    trackServiceTimer(setInterval(() => codexOAuthRefresh.check(), CODEX_OAUTH_CHECK_INTERVAL_MS)); trackServiceTimer(setInterval(() => codexAccountRefresh.checkAll().catch(err => logger.warn('codex_account_refresh_failed', { error: err.message })), CODEX_OAUTH_CHECK_INTERVAL_MS)); // official-account codex credentials: same cadence, one refresher per logged-in account
    serviceReady = true;
  }
})();
