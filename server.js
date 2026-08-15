'use strict';

// Load .env file (lightweight, no dependencies)
const _envPath = require('path').join(__dirname, '.env');
try {
  require('fs').readFileSync(_envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch (_) { /* .env not found, skip */ }

// Start every child from clean routing env; per-session providers re-apply theirs.
const { ANTHROPIC_ROUTING_KEYS } = require('./src/providers');
for (const k of ANTHROPIC_ROUTING_KEYS) {
  if (process.env[k]) { console.log(`[multicc] stripping inherited ${k} so claude uses the OAuth subscription`); delete process.env[k]; }
}

// Also strip parent Claude SDK markers: SIMPLE mode removes Agent/Task tools.
for (const k of [
  'CLAUDE_CODE_SIMPLE',
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID',
]) {
  if (process.env[k]) { console.log(`[multicc] stripping leaked ${k} so spawned claude keeps the full tool set`); delete process.env[k]; }
}

const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const { spawn, execFile } = require('child_process');
const { createUploadSuite, persistChatUpload, sendUploadError } = require('./src/upload-middleware');
const chokidar = require('chokidar');
const cron = require('node-cron');
const upload = createUploadSuite();
const wechatBridge = require('./plugins/bridges/wechat-ilink');
const feishuBridge = require('./plugins/bridges/feishu-bridge');
const telegramBridge = require('./plugins/bridges/telegram-bridge');
const discordBridge = require('./plugins/bridges/discord-bridge');
const slackBridge = require('./plugins/bridges/slack-bridge');
const voiceAsr = require('./plugins/voice/voice-asr');
const ttsService = require('./src/tts-service');
const cronTasks = require('./plugins/cron/cron-tasks');
const webpush = require('web-push');
const macosPower = require('./plugins/utils/macos-power');
const gitPush = require('./plugins/utils/git-push');
const { runGit: gitRunQueued, queueDepth: gitQueueDepth } = require('./src/git-queue');

const crypto = require('crypto');
const bus = require('./src/bus');
const services = require('./src/services');
const state = require('./src/state');
const artifacts = require('./src/artifacts');
const providers = require('./src/providers');
const { executeAuxHttp } = require('./src/aux-http');
const tokenGlobal = require('./src/token-global');
const { createRoleTokenTracker } = require('./src/role-token-tracker');
const {
  createCodexUsageHost,
  projectHistoryUsage,
  summarizeHistoryUsage,
} = require('./src/codex-usage');
const { createProviderRouterRuntime } = require('./src/provider-router-runtime');
const { findProviderReferences } = require('./src/provider-references');
const { createCliAdapters } = require('./src/cli-adapters');
const { createCodexSessionFinder } = require('./src/cli-adapters/codex-session-file');
const { createSessionPolicy, createReportedModelRuntime } = require('./src/cli/session-policy');
const { cliHandoffSummary, createCliSwitchRuntime } = require('./src/cli/switch-runtime');
const { composeMessage, renderPrompt } = require('./src/message-composer');
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
// MULTICC_DATA_DIR centralizes state; stores provide atomic recovery-safe writes.
const { createPaths } = require('./src/paths');
const stateStore = require('./src/state-store');
const stateTx = require('./src/state-tx');
const { bootstrapState } = require('./src/bootstrap/state');
const { createSessionPersistence } = require('./src/session-persistence');
const { createOrchestrationRuntime } = require('./src/orchestration-runtime');
const { createRouterToolHost } = require('./src/router-tool-host');
const { createHostLifecycle } = require('./src/host-lifecycle');
const { createLanDiscoveryRuntime } = require('./src/lan-discovery');
const { requestIdMiddleware, safeErrorHandler, asyncHandler } = require('./src/http-errors');
const { createMemoModule } = require('./src/memo');
const { mountScanRoutes } = require('./src/routes/scan');
const { mountSystemRoutes } = require('./src/routes/system');
const { mountHostReadRoutes } = require('./src/routes/host-read');
const { mountHostWriteRoutes } = require('./src/routes/host-write');
const { createVoiceHost } = require('./src/voice-host');
const { mountAuxGoalRoutes } = require('./src/routes/aux-goal');
const { createTaskBoardRuntime } = require('./src/routes/task-board');
const { createCommanderMigrationState } = require('./src/commander-migration');
const { createCommanderMigrationHost, createCommanderRoutingHost } = require('./src/commander-host-runtime');
const { mountFileTransferRoutes } = require('./src/routes/file-transfer');
const { mountSkillSyncRoutes } = require('./src/routes/skill-sync');
const { createSkillSyncRuntime } = require('./src/skill-sync');
const skillConverter = require('./src/skill-converter');
const { createProviderRoutes } = require('./src/routes/providers');
const { mountOpenCodeModelRoutes } = require('./src/routes/opencode-models');
const { mountOpenCodeQuotaRoutes } = require('./src/routes/opencode-quota');
const { mountQoderModelRoutes } = require('./src/routes/qoder-models');
const { mountQoderQuotaRoutes } = require('./src/routes/qoder-quota');
const { mountCodexQuotaRoutes } = require('./src/routes/codex-quota');
const { mountArkQuotaRoutes } = require('./src/routes/ark-quota');
const { mountZhipuQuotaRoutes } = require('./src/routes/zhipu-quota');
const { mountKimiQuotaRoutes } = require('./src/routes/kimi-quota');
const { mountClaudeUsageQuotaRoutes } = require('./src/routes/claude-usage-quota');
const { mountAliyunQuotaRoutes } = require('./src/routes/aliyun-quota');
const { mountProviderBalanceRoutes } = require('./src/routes/provider-balance');
const { mountMemoryBrowserRoutes } = require('./src/routes/memory-browser');
const { mountSessionMemoryRoutes } = require('./src/routes/session-memory');
const { createAgentResourcesRoutes } = require('./src/routes/agent-resources');
const { createRoleWorkerService } = require('./src/session/role-worker');
const { mountSessionCreateRoutes } = require('./src/routes/session-create');
const { mountCodexOAuthRoutes } = require('./src/routes/codex-oauth'); const { createClaudeOAuthSurface } = require('./src/routes/claude-oauth');
const { mountZcodeAuthRoutes } = require('./src/routes/zcode-auth'); const { mountKimiAuthRoutes } = require('./src/routes/kimi-auth');
const { createOrchestrationRoutes } = require('./src/routes/orchestration');
const { createChatTurnEngine } = require('./src/chat/turn-engine');
const { createTuiChatMirrorRuntime, isEnabled: tuiChatMirrorEnabled, validateExperimentalSession } = require('./src/experiments/tui-chat-mirror-runtime');
const { createSessionGitRuntime } = require('./src/routes/session-git');
const { createSessionProfileRoutes } = require('./src/routes/session-profile');
const { createSessionBundleRoutes } = require('./src/routes/session-bundle');
const { createSessionLifecycleRuntime } = require('./src/routes/session-lifecycle');
const { createSessionMetaRuntime } = require('./src/routes/session-meta');
const { createServerRestartRoute } = require('./src/routes/server-restart-route');
const { createUpdateRoute } = require('./src/routes/update-route');
const { createAuthRuntime } = require('./src/routes/auth');
const { createStaticAssetsRoutes } = require('./src/routes/static-assets');
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
const { createChatHistoryRuntime, buildReplayMessages } = require('./src/routes/chat-history');
const { createTokenUsageRoutes } = require('./src/routes/token-usage');
const { mountShareRoutes } = require('./src/routes/share');
const { createSessionAdminRuntime } = require('./src/routes/session-admin');
const { createSessionTriggers } = require('./src/triggers');
const {
  createClaudeOAuthRefresher,
  DEFAULT_CHECK_INTERVAL_MS: CLAUDE_OAUTH_CHECK_INTERVAL_MS,
} = require('./src/claude-oauth-refresh');
const {
  createCodexOAuthRefresher,
  DEFAULT_CHECK_INTERVAL_MS: CODEX_OAUTH_CHECK_INTERVAL_MS,
} = require('./src/codex-oauth-refresh');
const { parseClassifyResult, buildClassifySystemPrompt, classifyDisplay, phaseLabel } = require('./src/classify/vocab');
const { USER_INPUT_SIGNAL_PROMPT, buildCodexUserInputConstraint, recordAdapterUserInput, createUserInputSignalHost } = require('./src/classify/user-input-host');
const { createDispatchTargeting } = require('./src/dispatch/targeting');
const { createGatewayHost } = require('./src/dispatch/gateway-host');
const { createSafeProgressReducer, createDispatchProgressSubscription } = require('./src/dispatch/progress');
const { createClassifyStateMachine } = require('./src/classify/state-machine');
const { createAuxRunLog, createAuxRunRoutes } = require('./src/routes/aux-runs');
const { createLivenessRuntime } = require('./src/liveness/runtime');
const { createProcessProbe } = require('./src/liveness/process-probe');
const { createRolloutPathResolver } = require('./src/liveness/rollout-path');
const { createProcessingWatchdog, PROCESS_WATCHDOG_INTERVAL_MS } = require('./src/chat/process-watchdog');
const { createStalledTurnRecovery, STALLED_RECOVERY_INTERVAL_MS } = require('./src/chat/stalled-turn-recovery');
const { createProviderLogWatchdog } = require('./src/chat/provider-log-watchdog');
const { createLogHousekeeping, LOG_HOUSEKEEPING_INTERVAL_MS } = require('./src/log-housekeeping');
const { createPushRuntime } = require('./src/push-runtime');
const { createWorkspaceRuntime } = require('./src/workspace/runtime');
const { createChatHistoryFileRepository } = require('./src/session');
const { TurnProgressHeartbeat } = require('./src/chat/progress-heartbeat');
const { createBackgroundTaskRuntime } = require('./src/chat/background-task-runtime');
const { sharedTurnEventJournal } = require('./src/chat/turn-event-journal');
const { createTaskContextHost } = require('./src/task-context-host');
const { createSessionWorkHost } = require('./src/session-work-host');
const {
  TurnRequestError,
  normalizeTurnRequest,
  planTurnAdmission,
  createDurableMessageProof,
  createProviderRouteProof,
  evaluateSpawnGuard,
  createTurnRuntimeStore,
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
  toProviderDto,
  toWaitDto,
  withApiMeta,
} = require('./src/api-contract');
const {
  createAuthSecurity,
  normalizeRedirect,
  escapeHtmlAttribute,
} = require('./src/auth-security');
const { envEnabled, resolveNetworkPolicy, selectListenPort } = require('./src/network-policy');
const { isLocalRequest } = require('./src/request-locality');
const { createObservability, installConsoleRedaction } = require('./src/observability');
const { mountWsConnectionRouter } = require('./src/ws/connection-router');
const { createHealthHandlers } = require('./src/health');
const { secureRuntimeData, atomicWriteJson, atomicWriteText, ensurePrivateDir } = require('./src/runtime-security');
const { createHostEnv } = require('./src/host-env');
const MULTICC_PATHS = createPaths({ dataDir: process.env.MULTICC_DATA_DIR });
const MEMORY_STORE_ROOT = process.env.MULTICC_MEMORY_ROOT || path.join(__dirname, 'memories');
const chatHistoryRepository = createChatHistoryFileRepository({ dataDir: MULTICC_PATHS.root });
const turnEventJournal = sharedTurnEventJournal(MULTICC_PATHS);
const auxRunLog = createAuxRunLog({ dir: MULTICC_PATHS.auxRunsDir, log: (event, detail) => console.warn(`[multicc/aux-run-log] ${event}`, detail) });
const chatSessions = new Map();
let chatHistoryRuntime = null;
let chatHistoryService = null;
// This runtime deliberately owns preparation only. The established streaming
// and per-process runners keep their existing lifecycle after spawn is accepted.
const chatTurnPreparationRuntime = createTurnRuntimeStore();
let orchestrationRuntime = null;
let sessionWorkHost = null;
const observability = createObservability({ service: 'multicc' });
const { logger, metrics } = observability;
const apiErrorPolicy = createApiErrorPolicyRuntime({ logger, metrics });
const routerToolHost = createRouterToolHost({
  express, isLocalRequest, logger,
  activeTurnForSession: id => chatSessions.get(id)?._activeTurn,
});
const turnProgressHeartbeat = new TurnProgressHeartbeat({
  onHeartbeat(event) {
    const active = chatSessions.get(event.sessionId);
    if (!active || !active.isStreaming || active._activeTurn?.turnId !== event.turnId) {
      turnProgressHeartbeat.stop(event.sessionId, event.turnId);
      return;
    }
    metrics.inc('multicc_chat_progress_heartbeats_total');
    metrics.set('multicc_chat_silent_turn_seconds', Math.round(event.silentMs / 1000));
    logger.info('chat_progress_heartbeat', event);
    chatBroadcast(event.sessionId, { type: 'progress_heartbeat', ...event });
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
  dataRoot: MULTICC_PATHS.root,
  codexHomesDir: providers.CODEX_HOMES_DIR,
  onShadowDiff: recordProviderRouterShadowComparison,
  logger,
});
const agentResources = createAgentResourcesRoutes({
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
stateStore.setFailureReporter((error, meta) => {
  metrics.inc('multicc_persistence_failures_total');
  logger.error('persistence_failure', { ...meta, error: error && error.message });
});
const networkPolicy = resolveNetworkPolicy(process.env);
const app = express();
app.locals.observability = observability;
let _shuttingDown = false;

// ── Access token authentication (cookie-based login) ──
// `let` (not const): editable at runtime via /api/settings/access-token from
// localhost, hot-reloaded without restart (persisted to .env).
let ACCESS_TOKEN = networkPolicy.accessToken;
const authSecurity = createAuthSecurity({ getSecret: () => ACCESS_TOKEN });
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

app.use(requestIdMiddleware);
routerToolHost.mount(app);
// Auth surface (src/routes/auth.js): the /api shutdown gate, login routes and
// gate middleware, plus cookie/ws-ticket exchange. Always registered (no-op
// while ACCESS_TOKEN is empty, see isAuthenticated) so a token set later via the
// localhost UI takes effect immediately without a restart. ACCESS_TOKEN and the
// shutdown flag are read through getters so runtime changes apply on the next
// request. Mounted here to preserve ordering: gate runs before every API route.
const authRuntime = createAuthRuntime({
  express,
  authSecurity,
  isLocalRequest,
  parseCookies,
  normalizeRedirect,
  escapeHtmlAttribute,
  metrics,
  logger,
  createErrorDto,
  getAccessToken: () => ACCESS_TOKEN,
  getShuttingDown: () => _shuttingDown,
  allowLegacyTokenQuery: ALLOW_LEGACY_TOKEN_QUERY,
});
authRuntime.mountRoutes(app);

let serviceReady = false;
const commanderMigrationState = createCommanderMigrationState();
const healthHandlers = createHealthHandlers({
  isReady: () => serviceReady && !_shuttingDown && commanderMigrationState.snapshot().ready,
  readinessDetails: () => ({ commanderMigration: commanderMigrationState.snapshot() }),
});
app.get('/healthz', healthHandlers.healthz);
app.get('/readyz', healthHandlers.readyz);
app.get('/metrics', (req, res) => {
  let activeTurns = 0;
  for (const [name, cs] of chatSessions) {
    if (cs && (cs.claudeProc || cs.isStreaming || (chatStream.status(name) && chatStream.status(name).busy))) activeTurns++;
  }
  const waitStats = waitInjector.stats();
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(metrics.render({
    ...observability.eventLoopMetrics(),
    multicc_active_turns: activeTurns,
    multicc_ws_clients: wss.clients.size,
    multicc_git_queue_depth: gitQueueDepth(),
    multicc_active_waits: waitStats.waits + (orchestrationRuntime ? orchestrationRuntime.pendingCount() : 0),
    ...(orchestrationRuntime?.store.metrics?.() || {}),
    multicc_ready: serviceReady && !_shuttingDown && commanderMigrationState.snapshot().ready ? 1 : 0,
  }));
});
let PORT = networkPolicy.port;
const BIND_HOST = networkPolicy.host;
const server = http.createServer(app);
const lanDiscovery = createLanDiscoveryRuntime({ readState: () => ({ host: BIND_HOST, port: PORT, allowRemote: networkPolicy.allowRemote, accessToken: ACCESS_TOKEN, listening: server.listening, shuttingDown: _shuttingDown }), logger });
const wss = new WebSocket.Server({ noServer: true }); // upgrades dispatched by voice-host wireUpgrade (voice WS -> proxy, chat WS -> wss)
const isWindows = process.platform === 'win32';

const CLAUDE_ARGS = process.env.CLAUDE_ARGS ? process.env.CLAUDE_ARGS.split(' ') : [];
const CLAUDE_CHAT_DISALLOWED_TOOLS = (process.env.CLAUDE_CHAT_DISALLOWED_TOOLS ?? 'AskUserQuestion')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Codex exec cannot use its built-in ask tool; steer it to MultiCC's MCP signal.
const CODEX_NO_ASK_TOOL_HINT = process.env.CODEX_NO_ASK_TOOL_HINT ?? '1';
const CODEX_ENV_CONSTRAINT = buildCodexUserInputConstraint(CODEX_NO_ASK_TOOL_HINT !== '0');
// Keep codex exec alive until ALL background tasks complete.
// Codex exec exits when the model emits end_turn. Without explicit instruction,
// the model often ends the turn early while Monitor / run_in_background tasks
// are still running. This hint tells it to stay in the loop and poll until done.
// Default-on; set CODEX_STAY_ALIVE_HINT=0 to disable.
const CODEX_STAY_ALIVE_HINT = process.env.CODEX_STAY_ALIVE_HINT ?? '1';
const CODEX_STAY_ALIVE_PROMPT = CODEX_STAY_ALIVE_HINT === '0' ? '' : [
  '',
  '[进程保活规则 — 你必须遵守]',
  '- 当你启动了 Monitor（后台监控）、run_in_background 的 Bash 命令、或任何异步后台任务时，**不要立即结束你的回合（end_turn）**。',
  '- 你必须一直轮询等待，直到所有后台任务都完成并产出最终结果。',
  '- 轮询方式：每隔几秒用 Bash 检查任务状态（如 cat /tmp/xxx.done 2>/dev/null、ps aux | grep xxx 等），直到确认完成。',
  '- 只有在**所有子任务都已完成，你已经汇总了最终结果并回复给用户之后**，才能结束回合。',
  '- 如果你不确定子任务是否还在跑，宁可多等一轮也不要提前退出。',
  '[进程保活规则结束]',
].join('\n');
// Default-on toggle for the per-session/per-role cli-provider-router Claude proxy.
// `let`: hot-reloadable at runtime via POST /api/settings/proxy (persists to .env).
// Set CLAUDE_PROXY_ENABLED=0 in .env to bypass and route claude directly to the provider.
let CLAUDE_PROXY_ENABLED = String(process.env.CLAUDE_PROXY_ENABLED ?? '1') !== '0';
// Default-OFF, opt-in: route claude-official (OAuth-subscription) sessions THROUGH
// the proxy by replaying the macOS Keychain OAuth token. OFF: official sessions
// bypass the proxy and connect direct to api.anthropic.com (subagent routing
// unavailable for them). ON: enables subagent routing on official sessions
// (⚠️ replays subscription OAuth outside the official client — ToS + shared-Keychain
// considerations; hot-reloadable via POST /api/settings/official-oauth, persisted).
let CLAUDE_OFFICIAL_VIA_PROXY = String(process.env.CLAUDE_OFFICIAL_VIA_PROXY ?? '1') === '1';

// Model/provider display and effort policy is independent from process runners.
// It reads user defaults on demand so /model and CLI config changes are visible
// without restarting the host.
const sessionPolicy = createSessionPolicy({
  fs,
  env: process.env,
  homeDir: os.homedir,
  providers,
  providerRouter: providerRouterRuntime,
});
const {
  claudeDefaultModel,
  effectiveSessionModel,
  serializeSubagent,
  providerDefaultModel,
  sessionProviderName,
  sessionProviderBaseUrl,
  normalizeEffort,
  validEffortForCli,
  cliEffortLevel,
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
const CODEX_SESSIONS_DIR = sessionPolicy.codexSessionsDir;

// ── CLI provider abstraction ──
// Each provider knows how to (1) build the interactive terminal command line for tmux,
// (2) build chat-mode spawn args, (3) parse one line of streamed JSON output.
// Chat-mode parse output schema: { kind: 'text'|'tool'|'tool_result'|'result'|'system'|'thread', ... }
// Injected into chat-mode system prompt so the agent knows it can SHOW images to
// the user: the web chat renders Markdown and rewrites local-path <img> through
// /api/download, so an absolute-path image link just works.
const MULTICC_IMG_HINT = [
  '你正在 multicc 的网页聊天框里与用户对话，你的回复会被渲染为 Markdown。',
  '当你需要给用户「展示图片」（截图、生成的图表、参考图等本地图片文件）时，',
  '直接用 Markdown 图片语法并写该文件的【绝对路径】即可，例如：',
  '![说明](/绝对/路径/到/图片.png)',
  '前端会自动把本地路径图片内联显示给用户（可点击放大），无需上传或转 base64。',
  '仅在图片文件确实存在时这样写，不要编造路径。',
  '',
  ...USER_INPUT_SIGNAL_PROMPT,
  '',
  '【定时任务】当用户要你「定时/每天/每隔一段时间」自动做某事时，可登记一个 multicc 定时任务（到点会自动新建一个 chat 会话执行你写的 prompt）。在本机用 curl 调用：',
  `  curl -s http://127.0.0.1:${process.env.PORT || 3000}/api/cron -H 'Content-Type: application/json' \\`,
  `    -d '{"name":"任务名","dirPath":"<当前工作目录的绝对路径>","cron":"0 9 * * *","prompt":"到点要执行的完整指令"}'`,
  'cron 为标准 5 段（分 时 日 月 周，本地时区），如 "0 9 * * *" 表示每天 9:00。dirPath 用你当前的工作目录即可。登记后告诉用户可在 /manage 的「定时任务」里查看与管理。仅在用户明确要求定时/周期执行时才登记。',
  '',
  '【等待外部结果，别空等】需要等部署、接口或第三方返回时，若工具列表中有 `wait_for_external_result`，优先用它登记持久等待；结果到达后 multicc 会自动续接当前会话。',
  '  ① callback：传 `mode="callback"`、`reason`，可选 `timeout_seconds`。回调 capability URL 只在首次登记时返回，只交给外部结果生产方。',
  '  ② delay：传 `mode="delay"`、`reason`、`delay_seconds`。延迟跨服务重启保留；可用 `get_external_wait` 查询、`cancel_external_wait` 取消。',
  '  ③ 只有必须由宿主机执行命令或查询 URL 时，才使用受控 HTTP poll 接口：',
  `     curl -s $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/wait -H 'Content-Type: application/json' \\`,
  `       -d '{"mode":"poll","pollCmd":"<查询状态的shell命令>","untilContains":"<出现即视为完成的关键字>","intervalSec":15,"maxChecks":40}'`,
  '     （也可用 "pollUrl" 代替 pollCmd，用 "untilRegex" 代替 untilContains。命令在你的工作目录下执行。）',
  '  MCP 等待工具故意不接受 sessionId、shell 命令、轮询 URL 或任意注入消息；不要拿它绕过会话所有权。登记成功后可正常结束本轮，无需用户手动催。',
  '',
  '【子 Agent/Task/Workflow 轮询保活规则】在 `-p` 模式下，主进程退出时所有子进程（Agent/Task/Workflow/Bash 后台任务）都会被一起回收。',
  '因此：',
  '  ① 当你启动任何预期耗时超过约 10 秒的子 Agent（`run_in_background: true`）或 Task/Workflow 后，不要直接回复 done 然后结束本回合。',
  '  ② 首选用 TaskOutput 阻塞轮询保活：对启动子任务时拿到的 task_id，反复调用 `TaskOutput(task_id, block=true, timeout=120000)`--',
  '     · 120s 内子任务完成 -> 直接拿到结果，汇总后续接输出；',
  '     · 120s 仍未完成 -> 工具超时返回当前部分输出，向用户报一句简短进度（"子任务还在跑，已约 Ns，最新：…"），再调一次继续 block，直到完成。',
  '     此法是 harness 原生能力，不需要子任务配合、不依赖标记文件，首选。',
  '  ③ fallback（子任务不在本进程 harness 内、拿不到 task_id，如 run-detached / 跨 session 任务）：启动时要求子任务把完成信号写入约定标记文件 `echo "DONE" > /tmp/multicc_task_<任务名>.done`，主进程每隔 5-10s 用 Bash 检查（`cat /tmp/multicc_task_<任务名>.done 2>/dev/null`）直到出现，每次检查报一句进度。',
  '  ④ 拿到最终结果后，汇总并正常结束本轮。',
  '  ⑤ 对于确实需要跨轮存活的长时间任务（>5 分钟），仍优先用 multicc 的 run-detached 接口或 MCP `dispatch_master` / `route_task` 派给独立 session。',
  '',
  '【Monitor 监控必须用 persistent: true】在 multicc chat 会话里调用 Monitor 工具时，persistent 参数必须设为 true，不要用默认的 false。',
  'chat 会话是常驻 streaming 进程、没有单轮超时，Monitor 若用 persistent:false 会被 timeout_ms（默认5分钟/最长1小时）提前杀掉，导致长时间的日志跟踪/事件监听中途断掉。用 persistent:true 让它一直跟到目标出现或会话结束。',
  '注意：persistent:true 的 Monitor 不会自动超时结束，任务达成或不再需要时，务必用 TaskStop 主动停掉它，避免空跑占资源。',
  '',
  '【长任务边做边报进度】（multicc 统一体验约定）当某件事要跑较久（构建/打包/部署/批处理/长等待）时，默认采用「边等边报」：用上面的 run-detached 或轮询保活机制保证任务不丢，运行期间每隔约 25–30 秒主动向用户冒一句简短进度（在做什么、已约 Ns、最新一行关键输出），任务完成后再给最终结果。',
  '不要一启动就长时间静默、让对话框看起来像卡住；也不要只说「我等一下」就停下不续接。这是面向所有 multicc 用户的统一约定，请默认遵循。',
  '',
  '【跨会话协作时的 worktree 同步纪律】每个 chat 会话在自己独立的 git worktree + 分支（multicc/<sessionId>）里干活，基分支通常是 main。多个会话并行改代码时，worktree 之间不会自动一致，必须按下面纪律同步，否则会基于过时代码工作、产生冲突或覆盖别人的改动：',
  '  · 派活方（通过 MCP 把任务交给兄弟会话前）：先由派活方直接调用目标会话的 sync 接口；成功后在任务指令里说明 sync 已完成及结果，不要要求目标会话启动后再重复 sync。任务仍须要求目标完成后 commit、调用自己的 merge 接口，并报告文件、合并与冲突情况。',
  '  · 被派方（你收到一个自包含任务时）：若派活方已明确报告 sync HTTP 200，只读确认 worktree clean 且 HEAD 与基分支一致后直接开工；否则先尝试 sync。干完 commit + merge 回基分支，并如实报告。',
  '  · self-active 例外：当前会话在处理用户消息时本来就是 running；调用“当前会话自己的 sync”可能仅因这一轮正在执行而返回 HTTP 409 busy。只有当唯一阻塞原因是 busy/running、目标正是 $MULTICC_SESSION_ID 时，才把它视为 self-active 而非代码冲突：立即只读检查 `git status --short` 与 `git rev-list --left-right --count HEAD...main`。工作区 clean 且结果为 `0 0` 才可继续；dirty、conflict、分支落后/分叉、存在其他阻塞原因时必须停止报告，禁止 force。',
  '  · 收回成果后（派活方拿到对方「已合并」的回复时）：确认 merge 的自动 sibling sync 结果，并只读确认本会话 HEAD 与基分支一致；只有未同步时才调用自己的 sync。若遇纯 self-active，按上一条规则判定，不要把“正在回答本轮消息”误报成 worktree 冲突。',
  '  · multicc 会在任一会话 merge 回基分支后，自动把同目录其它会话的 worktree 同步到新基分支（冲突的会跳过并提示）；但「你自己这个会话」和「正在进行中的对话」仍以你主动 sync 为准，涉及共享文件的关键节点请主动同步一次再动手。',
'',
`【代码搜索：grep/rg 在本会话失效】在 multicc chat 会话（你当前所在的 worktree）里，用 Bash 跑 grep/rg 搜当前 worktree 之外的代码（主仓库根、其它 worktree、任何本 worktree 外的路径）时，命令会被沙箱拦截、返回纯空 stdout——不是「0 匹配」，是连 grep -c 的计数字都没有、stderr 也被吞掉，极易误判为「没找到」。而 wc、cat、Read 工具读同一个文件完全正常。判断方法：wc -l <file> 有输出但 grep -c require <file> 为空，就是中招了。`,
`搜代码请改用：① Read 工具（专用工具，绕过沙箱）按 offset/limit 读特定段落；② node fs 搜索——在 Bash 里（加 dangerouslyDisableSandbox）用 require("fs").readFileSync 把文件读成字符串、split 成行、用正则测试每行、命中就打印「行号: 片段」（比 grep 稍啰嗦，但唯一可靠）。`,
`★这对子任务尤其关键：派 subagent / Workflow / Task 时，必须在指令里明确写「禁止 grep，只用 Read 或 node fs」——子 agent 不读你的记忆，遇到 grep 全空会不断换关键词无限重试、直接 stall（一直跑却不收尾，只能 TaskStop 收场）。`,
'',
'【改代码的落点：在自己 worktree 改，再 merge 回 main】每个 chat 会话独占一个 worktree（分支 multicc/<sessionId>），main 是只读基分支。改任何代码（server.js / src/* / app/* 等）都只在自己当前 worktree 里改并 commit，**不要直接编辑主 worktree（main 工作目录）的文件**——那会产生漂浮的未提交改动：绕过 commit/merge 的可追溯性，还会因 main 工作区脏阻断后续 merge（git 遇工作区有未提交改动且 merge 涉及同名文件时会拒绝、报 local changes would be overwritten）。正确流程：① 在自己 worktree 用 Edit/Write 改文件；② git add + commit 到 multicc/<sessionId>；③ 调 merge 合回 main：curl -s -X POST $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/merge（需 dangerouslyDisableSandbox），成功后会自动 sync 兄弟 worktree；④ 若发现自己之前误改了主 worktree，先 git -C <主worktree> checkout -- <误改文件> 撤销漂浮改动让 main 干净，再调 merge，否则 merge 会被脏工作区拒绝。与上面【跨会话协作 worktree 同步纪律】互补：那条讲多会话间同步，这条讲单会话改代码该落在哪。',
].join('\n');

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

const { commands: cliCommands, registry: cliAdapterRegistry } = createCliAdapters({
  isWindows,
  claudeArgs: CLAUDE_ARGS,
  claudeChatDisallowedTools: CLAUDE_CHAT_DISALLOWED_TOOLS,
  codexArgs: CODEX_ARGS,
  codexEnvConstraint: CODEX_ENV_CONSTRAINT,
  codexStayAlivePrompt: CODEX_STAY_ALIVE_PROMPT,
  multiccImgHint: MULTICC_IMG_HINT,
  userInputReminder: USER_INPUT_SIGNAL_PROMPT.join('\n'),
  resolveSessionWireModel: providerRouterRuntime.resolveSessionWireModel,
  claudeDefaultModel,
  cliEffortLevel,
  normalizeEffort,
  codexReasoningConfigArg,
  codexModelConfigArg,
  debugLogClaudeInvoke,
  isCodexResponseCompletedDisconnect,
  isCodexTransportDisconnect,
});
const CLAUDE_CMD = cliCommands.claude;

function cliCommandAvailable(command) {
  const candidate = String(command || '').trim();
  if (!candidate) return false;
  const suffixes = isWindows
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const locations = (path.isAbsolute(candidate) || candidate.includes(path.sep))
    ? ['']
    : String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of locations) {
    for (const suffix of suffixes) {
      const file = dir ? path.join(dir, candidate + suffix) : candidate + suffix;
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return true;
      } catch (_) {}
    }
  }
  return false;
}

function cliAvailabilitySummary() {
  const out = {};
  for (const cli of SUPPORTED_CHAT_CLIS) {
    out[cli] = { available: cliCommandAvailable(cliCommands[cli]) };
  }
  return out;
}

function providerFor(session) {
  return cliAdapterRegistry.get(session?.cli);
}

// ── Codex session-id capture: scans ~/.codex/sessions for a JSONL with matching cwd whose
// session_meta.timestamp is newer than `sinceMs`. Returns the session id or null. ──
// codex session-file lookup (extracted to src/cli-adapters/codex-session-file.js).
// Pure fs read; CODEX_SESSIONS_DIR is the default root when a call omits one.
const { findCodexSessionId } = createCodexSessionFinder({
  fs, path, defaultSessionsDir: CODEX_SESSIONS_DIR,
});

// ── tmux helpers (extracted to src/tmux.js) ──
// Pure primitives, destructured so existing call sites are unchanged. The
// stateful recoverTmuxSessions() (below) stays — it rebuilds core session state.
const {
  TMUX_PREFIX, tmuxSessionName, tmuxListSessions, tmuxHasSession, tmuxCreateSession, tmuxResize,
  applyMaxClientSize, tmuxKillSession, tmuxCapturePane, tmuxPaneTty,
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
  gitWorktreeAdd, gitWorktreeRollbackCreate, gitWorktreeRemove, gitRelocateWorktree, gitWorktreeMergeState, gitMergeBack,
  gitSyncFromBase, gitRebaseResolve, gitWorktreeSnapshot, gitExportSessionBundle,
  gitImportSessionBundle, defaultRepoActor,
} = require('./src/git');

// RepoActor operations are retained in a bounded in-memory history. Destructive
// endpoint responses include operationId; callers can inspect progress and the
// observed queue depth here without polling child processes themselves.
app.get('/api/repo-operations/:operationId', (req, res) => {
  const operation = defaultRepoActor.status(req.params.operationId);
  if (!operation) return res.status(404).json({ error: 'operation not found' });
  res.json(operation);
});

const gitReadyDirs = new Set();          // dir.id once its repo is verified/initialised
const invalidSessions = new Map();       // sessionId → reason; recovery is skipped for these

// Directory suitability + path helpers extracted to src/directories.js.
// Destructured so existing call sites are unchanged. ensureDirGitReady() and
// the loadDirectories/saveDirectories persistence stay below in server.js.
const {
  isHomeOrAbove, realPathOf, dirSuitability, friendlyDirReason,
} = require('./src/directories');

// Make sure a directory is a usable git repo; refuses $HOME and missing paths.
async function ensureDirGitReady(dir) {
  if (gitReadyDirs.has(dir.id)) return { ok: true };
  if (isHomeOrAbove(dir.path)) return { ok: false, reason: 'home-or-above' };
  if (!fs.existsSync(dir.path)) return { ok: false, reason: 'path-missing' };
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
      await gitRun(dir.path, ['-c', 'user.email=multicc@local', '-c', 'user.name=multicc',
        'commit', '--allow-empty', '-m', 'multicc: initial commit']);
    }
    dir.baseBranch = await gitBaseBranch(dir.path);
    dir.gitInitialized = true;
    gitReadyDirs.add(dir.id);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'git-error: ' + e.message };
  }
}

// ── Directory + session persistence ──
// Schema:
//   directories.json: [{ id, name, path, createdAt, baseBranch?, gitInitialized? }]
//   sessions.json:    [{ id, dirId, cli, kind, cliSessionId, label?, createdAt, worktreePath?, branch? }]  (+ __aux__)
//
// On first load, we auto-migrate the old flat { id, cwd, claudeSessionId, chatClaudeSessionId } schema
// into directories.json + split each paired session into a terminal + optional chat record.
// Paths flow through MULTICC_PATHS so MULTICC_DATA_DIR can relocate the whole
// state directory in tests / alternate deployments without a code change.
const SESSIONS_FILE = MULTICC_PATHS.sessionsFile;
const DIRECTORIES_FILE = MULTICC_PATHS.directoriesFile;

// State bootstrap owns store construction, crash-journal replay, fail-closed
// recovery and the one-time legacy paired-session migration. The returned Maps
// remain the shared host references consumed by the bounded contexts below.
const stateBootstrap = bootstrapState({
  fs,
  stateStore,
  stateTx,
  paths: MULTICC_PATHS,
  chatHistoryRepository,
  randomUUID: crypto.randomUUID,
  logger: console,
});
const sessionsStore = stateBootstrap.sessionsStore;
const directoriesStore = stateBootstrap.directoriesStore;
const _state = stateBootstrap.state;
const persistedSessions = _state.persistedSessions;

// Host-injected store port. Production delegates directly to StateStore's
// atomic tmp+fsync+rename write. Isolated integration tests may place a marker
// inside their temporary MULTICC_DATA_DIR to inject EIO deterministically.
const sessionStorePort = {
  save(data) {
    const marker = process.env.MULTICC_TEST_SESSION_PERSISTENCE_FAIL_FILE;
    if (process.env.NODE_ENV === 'test' && marker) {
      const root = path.resolve(MULTICC_PATHS.root);
      const resolved = path.resolve(marker);
      if ((resolved === root || resolved.startsWith(root + path.sep)) && fs.existsSync(resolved)) {
        const error = new Error('injected sessions.json persistence failure');
        error.code = 'EIO';
        throw error;
      }
    }
    return sessionsStore.save(data);
  },
};
const sessionPersistence = createSessionPersistence({
  records: persistedSessions,
  store: sessionStorePort,
  retryDelayMs: Math.max(50, Number(process.env.MULTICC_SESSION_PERSISTENCE_RETRY_MS) || 500),
  maxRetries: 3,
  onFailure: ({ error, mode, source, attempt, dirty }) => {
    metrics.inc('multicc_session_persistence_failures_total');
    logger.error('session_persistence_failure', {
      mode, source, attempt, dirty, error: error && error.message,
    });
  },
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
  if (ensureCliStates(session)) _state.needsSave = true;
}

// ── Directory domain (src/directory: controller / service / repository) ──
// Composition root: bind the domain's ports to this file's runtime state. The
// repository wraps the boot-loaded Map, so `directories` below keeps the same
// shared reference handed to src/state.js — legacy call sites stay valid while
// they are migrated over. saveDirectories() remains as a delegate for them.
const { createDirectoryModule } = require('./src/directory');

let commanderMigrationRunner = null;

// Registration and upgrades share normal session creation.
async function seedCommanderSession(dir) {
  if (!commanderMigrationRunner) return { ok: false, error: 'commander migration unavailable' };
  const result = await commanderMigrationRunner.migrateDirectory(dir);
  if (result.status === 'ready' && result.sessionId) {
    appendEvent(dir.id, 'session_role_changed', `Agent Commander（${result.action}）`, result.sessionId);
    return { ok: true, ...result };
  }
  console.warn(`[multicc] seed commander session failed for dir ${dir.id}: ${result.code}`);
  return { ok: false, error: result.code, ...result };
}

// Tear down one session record + all its runtime state (tmux, chat proc, wait
// registrations, shares, worktree, triggers, notes, status board entry).
// Directory deletion cascades through here for every owned session.
async function destroySessionCascade(s, d, opts = {}) {
  const active = sessions.get(s.id);
  const chat = chatSessions.get(s.id);
  let removal = null;
  // Remove the worktree before tearing down runtime/persistence. A default
  // dirty/unmerged refusal therefore leaves the session completely intact.
  if (s.worktreePath && s.branch) {
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
    if (active.captureTimer) clearInterval(active.captureTimer);
    cleanupPushMonitor(s.id);
    await stopOutputCapture(active);
    await tmuxKillSession(s.id);
    for (const client of active.clients || []) try { client.terminate(); } catch (_) {}
    sessions.delete(s.id);
  }
  if (chat) {
    assignKillReason(chat._activeRunner, 'session_delete');
    if (chat.claudeProc) try { chat.claudeProc.kill('SIGTERM'); } catch (_) {}
    chatStream.close(s.id);
    for (const client of chat.clients || []) try { client.terminate(); } catch (_) {}
    chatSessions.delete(s.id);
  }
  backgroundTaskRuntime.stopSession(s.id);
  waitInjector.cancelForSession(s.id);
  if (orchestrationRuntime) await orchestrationRuntime.cancelForSession(s.id);
  share.removeForSession(s.id);
  try { chatHistoryService.deleteSession(s.id); }
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
// appendEvent/purgeNotesForSession by value — and before `directories` exists,
// so the route mount happens after the directory module is composed.
const notesStore = createNotesStore({
  eventsDir: MULTICC_PATHS.eventsDir,
  notesFile: MULTICC_PATHS.notesFile,
  persistedSessions,
  directories: _state.directories,
  atomicWriteJson,
  ensurePrivateDir,
  getWorkspaceBroadcast: () => workspaceBroadcast,
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
  repository: { file: DIRECTORIES_FILE, map: _state.directories, store: directoriesStore, uiLayoutFile: MULTICC_PATHS.uiLayoutFile },
  git: {
    baseBranch: gitBaseBranch,
    pushState: (p, b, o) => gitPush.directoryPushState(p, b, o),
    push: (p, b) => gitPush.pushDirectory(p, b),
    invalidatePushCache: (p, b) => gitPush.invalidate(p, b),
    statusPorcelain: (p) => gitRunQueued(p, ['status', '--porcelain']),
    stageAll: (p) => gitRunQueued(p, ['add', '-A']),
    commit: (p, m) => gitRunQueued(p, [
      '-c', 'user.email=multicc@local',
      '-c', 'user.name=multicc',
      'commit', '-m', m,
    ]),
    ensureReady: ensureDirGitReady,
    unmarkReady: (id) => { gitReadyDirs.delete(id); },
  },
  sessions: {
    listByDir: (dirId) => [...persistedSessions.values()].filter(s => s.dirId === dirId),
    seedCommander: seedCommanderSession,
    destroyCascade: destroySessionCascade,
    persistRecords: () => sessionPersistence.mutate('http.directory-delete-fallback', () => {}),
    // Cross-file transaction needs the sessions payload at the moment of
    // journal-write, so it's captured alongside the directories payload.
    snapshotRecords: () => [...persistedSessions.values()],
  },
  events: { append: appendEvent },
  fsPort: {
    homedir: () => os.homedir(),
    exists: (p) => fs.existsSync(p),
    isDirectory: (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } },
    mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); },
    readDirents: (p) => fs.readdirSync(p, { withFileTypes: true })
      .map(e => ({ name: e.name, isDirectory: e.isDirectory(), isSymbolicLink: e.isSymbolicLink() })),
  },
  helpers: { resolveCwd, isHomeOrAbove, realPathOf, friendlyDirReason },
  // Cross-file transaction wiring: directory deletion writes directories.json
  // AND sessions.json under a single journal entry, so a crash between the
  // two writes is finished by replayJournals() on next boot rather than
  // leaving the two files inconsistent (dir deleted + its sessions still
  // pointing at nothing, or vice versa).
  tx: {
    directoriesFile: DIRECTORIES_FILE,
    sessionsFile: SESSIONS_FILE,
    commitCrossFileWrite: (spec) => stateTx.commitCrossFileWrite({
      journalDir: MULTICC_PATHS.journalDir,
      ...spec,
    }),
  },
});
const directories = directoryModule.repo.map();
function saveDirectories() { directoryModule.repo.save(); }
// Directory event log route (GET /api/directories/:id/events) — mounted where
// the inline handler lived, now that `directories` exists and app routing is up.
notesStore.mountRoutes(app);
if (_state.needsSave) {
  saveDirectories();
  sessionPersistence.mutate('startup.schema-migration', () => {});
  console.log(`[multicc] Migration complete: ${directories.size} directories, ${persistedSessions.size} sessions`);
}

// Startup: ensure every session has an isolated worktree. Legacy sessions (created
// before worktree isolation) get one built here. Sessions whose directory is invalid
// ($HOME, or a duplicate physical path) are marked invalid and skipped at recovery.
async function initWorktrees() {
  // Detect directories that point at the same physical path — keep the earliest as
  // canonical, mark sessions under the rest invalid.
  const seenPaths = new Map();   // realpath → canonical dir id
  const dupDirIds = new Set();
  const sortedDirs = [...directories.values()]
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  for (const d of sortedDirs) {
    const rp = realPathOf(d.path);
    if (seenPaths.has(rp)) dupDirIds.add(d.id);
    else seenPaths.set(rp, d.id);
  }

  let built = 0;
  for (const s of persistedSessions.values()) {
    if (s.type === 'aux' || s.id === AUX_SESSION_ID) continue;
    if (s.type === 'gateway') continue;
    const dir = directories.get(s.dirId);
    if (!dir) { invalidSessions.set(s.id, 'no directory'); continue; }
    if (dupDirIds.has(dir.id)) { invalidSessions.set(s.id, 'duplicate directory path'); continue; }
    if (isHomeOrAbove(dir.path)) { invalidSessions.set(s.id, 'directory is $HOME or above'); continue; }
    if (s.worktreePath && fs.existsSync(s.worktreePath)) continue;  // already isolated

    const ready = await ensureDirGitReady(dir);
    if (!ready.ok) { invalidSessions.set(s.id, 'git not ready: ' + ready.reason); continue; }
    try {
      const { worktreePath, branch } = await gitWorktreeAdd(dir.path, s.id, dir.baseBranch);
      s.worktreePath = worktreePath;
      s.branch = branch;
      built++;
      // Legacy terminal session still running in the old (non-worktree) tmux pane:
      // kill it so recovery recreates the session inside its worktree.
      if (s.kind === 'terminal' && await tmuxHasSession(s.id)) {
        console.log(`[multicc] migrating terminal ${s.id} into worktree — discarding old tmux pane`);
        await tmuxKillSession(s.id);
      }
    } catch (e) {
      invalidSessions.set(s.id, 'worktree create failed: ' + e.message);
      console.error(`[multicc] worktree creation failed for session ${s.id}: ${e.message}`);
    }
  }
  if (built > 0 || invalidSessions.size > 0) {
    saveDirectories();
    savePersistedSessionsBestEffort('startup.worktree-migration');
  }
  console.log(`[multicc] worktrees: ${built} built, ${invalidSessions.size} session(s) invalid`);
  for (const [id, reason] of invalidSessions) {
    console.warn(`[multicc]   invalid session ${id}: ${reason}`);
  }
}

// Helper: resolve a session's cwd. Isolated sessions run inside their git worktree;
// fall back to the directory path if the worktree is somehow missing.
function cwdForSession(session) {
  if (!session) return os.homedir();
  if (session.type === 'aux') return session.cwd || __dirname;
  if (session.type === 'gateway') {
    const p = session.cwd || path.join(os.homedir(), '.multicc', 'gateway');
    try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
    return p;
  }
  if (session.worktreePath && fs.existsSync(session.worktreePath)) return session.worktreePath;
  const dir = directories.get(session.dirId);
  if (dir && dir.path) return dir.path;
  return session.cwd || os.homedir();
}

// Dispatch targeting (src/dispatch/targeting.js): sibling-session listing and
// the cross-session dispatch context prompt. Bound here so the pure module
// reads the live session registry / chat map / effort normalizer as deps.
const {
  dispatchableSessionsFor,
  dispatchTargetHintFor,
  buildDispatchContextPrompt,
} = createDispatchTargeting({ records: persistedSessions, chatSessions, normalizeEffort });

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
  loadChatHistory: (...args) => loadChatHistory(...args),
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
// { id, tmuxName, ttyPath, outputStream, fifoPath, buffer: string[], clients: Set<ws>, createdAt, lastActivity, cwd, exitCheckTimer }
const sessions = new Map();

// Publish the three core Maps to the shared state registry (same references).
// Extracted modules read these via require('./src/state') — no bespoke injection.
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
  // Look up the persisted record (must exist — sessions are pre-created via REST now)
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
  // Per-session provider override is injected into tmux; Codex capture below
  // also uses the selected CODEX_HOME.
  const provEnv = providerRouterRuntime.resolveSpawnEnv(persisted);
  const termEnv = { ...provEnv.env };
  if (persisted.cli === 'claude') {
    for (const k of providers.CLAUDE_ROUTING_KEYS) {
      if (!(k in termEnv)) termEnv[k] = '';
    }
    // Route interactive tmux claude through the per-session/per-role proxy too.
    providers.applyClaudeProxyEnv(termEnv, {
      providerId: persisted.provider, sessionId: id,
      subagent: persisted.subagent, port: PORT, enabled: CLAUDE_PROXY_ENABLED,
      officialOAuth: CLAUDE_OFFICIAL_VIA_PROXY,
    });
  } else if (persisted.cli === 'codex') {
    providers.applyCodexProxyConfig(termEnv, {
      providerId: persisted.provider, sessionId: id,
      subagent: persisted.subagent, port: PORT,
    });
  }

  // For Claude: pre-allocate a stable session UUID so chat-mode `--resume` works.
  // For Codex: leave cliSessionId null on first launch and capture it asynchronously
  // by scanning ~/.codex/sessions after the process boots.
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
      : persisted.loginFlow === 'claude-auth-login' ? `${cliCommands.claude} auth login` : null;
    const terminalCmd = loginCmd || provider.buildTerminalCmd(launchSession || {});
    await tmuxCreateSession(id, cwd, 80, 24, terminalCmd, termEnv);
  } else {
    console.log(`[multicc] Attaching to existing tmux session: ${tmuxSessionName(id)}`);
    isRecovery = true;
  }

  // Get the tty device path for direct input writes
  const ttyPath = await tmuxPaneTty(id);

  // Start output capture via pipe-pane → FIFO
  const { stream, fifoPath } = await startOutputCapture(id);

  // Pre-fill buffer with current terminal content for recovered sessions
  const initialBuffer = [];
  if (isRecovery) {
    const captured = await tmuxCapturePane(id);
    if (captured) initialBuffer.push(captured);
  }

  const session = {
    id,
    cli: provider.name,
    cliSessionId: persisted.cliSessionId || null,
    dirId: persisted.dirId,
    tmuxName: tmuxSessionName(id),
    ttyPath,
    outputStream: stream,
    fifoPath,
    buffer: initialBuffer,
    clients: new Set(),
    primaryClient: null,
    // Tmux pane size = max(cols) × max(rows) across all attached clients.
    // Each ws stores its desired cols/rows on itself (ws._desiredCols/Rows).
    // appliedCols/Rows = the size we last actually pushed to tmux, used to skip no-op resizes.
    appliedCols: 0,
    appliedRows: 0,
    createdAt: persisted ? new Date(persisted.createdAt) : new Date(),
    lastActivity: new Date(),
    cwd,
    exitCheckTimer: null,
  };

  // Schedule async session-id capture for codex (file-watch on ~/.codex/sessions).
  // Polls every 1s for up to 30s. Persists the captured id so subsequent reattach can use `codex resume`.
  if (provider.needsAsyncSessionIdCapture && !persisted.cliSessionId && !isRecovery) {
    let attempts = 0;
    const captureTimer = setInterval(() => {
      attempts++;
      const codexSessionsDir = provEnv.codexHome ? path.join(provEnv.codexHome, 'sessions') : null;
      const captured = findCodexSessionId(cwd, launchTime - 2000, codexSessionsDir);
      if (captured) {
        clearInterval(captureTimer);
        persisted.cliSessionId = captured;
        session.cliSessionId = captured;
        savePersistedSessionsBestEffort('timer.codex-session-id-capture');
        console.log(`[multicc] Captured codex session id for ${id}: ${captured}`);
      } else if (attempts >= 30) {
        clearInterval(captureTimer);
        console.warn(`[multicc] Failed to capture codex session id for ${id} after 30s`);
      }
    }, 1000);
    session.captureTimer = captureTimer;
  }

  // Output stream → broadcast to all WebSocket clients
  const utf8Decoder = new StringDecoder('utf8');
  stream.on('data', (data) => {
    const str = utf8Decoder.write(data);
    if (!str) return; // partial UTF-8 character buffered, wait for more bytes
    session.buffer.push(str);
    if (session.buffer.length > 500) session.buffer.shift();
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
        const cliLabel = session.cli === 'qoder' ? 'Qoder CN' : session.cli === 'codex' ? 'Codex' : 'Claude Code';
        const exitMsg = `\r\n\x1b[33m[${cliLabel} process exited]\x1b[0m\r\n`;
        broadcastTo(session.clients, { type: 'exit', data: exitMsg });
        await stopOutputCapture(session);
        sessions.delete(id);
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
            session.buffer.push(str);
            if (session.buffer.length > 500) session.buffer.shift();
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
  getGlobalUsage: options => tokenGlobal.getGlobalUsage(options),
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
      ? path.join(providers.CODEX_HOMES_DIR, rec.provider)
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
  thresholds: process.env.MULTICC_STALL_SILENT_MS ? { stallSilentMs: Number(process.env.MULTICC_STALL_SILENT_MS) } : {},
  probeSession: async (sessionId, sig) => livenessProcessProbe.probe(
    sig && Number.isInteger(sig.pid) ? sig.pid : null, livenessRolloutPath(persistedSessions.get(sessionId))),
});

const { createProxyBroadcasters } = require('./src/chat/proxy-broadcast');
providerRouterRuntime.mountProtocolProxies(app, {
  protocols: ['claude'],
  onUsageObserved: recordUsageObserved,
  onActivity: e => livenessRuntime.recordProxyActivity(e),
  // Token-level delta + Claude 5h rate-limit sidecars: see src/chat/proxy-broadcast.js.
  ...createProxyBroadcasters(chatBroadcast, { resolveCli: name => (persistedSessions.get(name) || {}).cli }),
});
app.use(express.json({ limit: '50mb' }));

// Codex Responses↔Chat 协议转换代理（国产服务商 DeepSeek/GLM/Qwen/MiniMax）。
// 必须在 express.json() 之后挂载，以便 req.body 已解析。详见 docs/codex-proxy-contract.md。
providerRouterRuntime.mountProtocolProxies(app, {
  protocols: ['codex'],
  getPort: () => PORT,
  onUsageObserved: recordUsageObserved,
  onActivity: e => livenessRuntime.recordProxyActivity(e),
  ...createProxyBroadcasters(chatBroadcast, { resolveCli: name => (persistedSessions.get(name) || {}).cli }),
});

// Session query, dashboard, workspace and classify-admin routes share one
// bounded composition. Dependencies that initialize later (Aux, workspace facts,
// classifier helpers) are resolved lazily by closures and never snapshotted here.
const sessionGitRuntime = createSessionGitRuntime({
  records: persistedSessions,
  directories,
  terminalSessions: sessions,
  chatSessions,
  gitWorktreeMergeState,
  gitBaseBranch,
  gitRunQueued,
  gitMergeBack,
  gitSyncFromBase,
  gitRebaseResolve,
  appendEvent,
  workspaceBroadcast: (...args) => workspaceBroadcast(...args),
  existsSync: fs.existsSync,
  now: Date.now,
  random: Math.random,
  logger: console,
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
  getTaskBoardRuntime: () => taskBoardRuntime,
  getUserInputSignalHost: () => userInputSignalHost,
  getApiErrorHost: () => apiErrorHost,
  getWaitInjector: () => waitInjector,
  setTaskState,
  getTaskState,
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
  annotateChatTurn: (...args) => chatHistoryRuntime?.annotateTurn(...args) || [],
  getAuxRunLog: () => auxRunLog,
});
const {
  recordTaskBoardGoal,
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
  getWorkspaceStatus: id => workspaceStatus.get(id),
  getSessionSummary: id => sessionSummaries.get(id),
  getTaskState,
  pendingNotesFor,
  getAuxRuntime: () => ({ id: AUX_SESSION_ID, queue: auxQueue }),
  loadChatHistory,
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
sessionAdmin.mountRoutes(app);
const workspaceSnapshot = sessionAdmin.workspaceSnapshot;

// Workspace and fleet-wide Meta state share one runtime so every event is
// fanned out exactly once. The function dependencies are host declarations and
// resolve lazily; hydration itself only reads the already-loaded records.
const workspaceRuntime = createWorkspaceRuntime({
  records: persistedSessions,
  directories,
  chatSessions,
  workspaceSnapshot,
  recentEvents: dirId => recentEvents(dirId),
  mergeState: (directory, session) => mergeStateCached(directory, session),
  send: (client, payload) => sendWs(client, payload),
  broadcastClients: (clients, payload) => broadcastTo(clients, payload),
  setTaskState,
  saveBestEffort: savePersistedSessionsBestEffort,
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

app.get('/api/v1/providers', (req, res) => {
  const appType = String(req.query.appType || '').trim();
  const list = providers
    .listProviders(appType === 'claude' || appType === 'codex' ? appType : undefined)
    .map(toProviderDto);
  res.json(withApiMeta({ providers: list, count: list.length }, requestContext(req, res)));
});

// Agent presets, installed skills and Claude history share one read/cleanup boundary.
agentResources.mountRoutes(app);

// ── Directory REST API (src/directory: controller / service / repository) ──
// Routes: GET /api/fs/list · GET|POST /api/directories · PATCH|DELETE
// /api/directories/:id · POST :id/push · GET :id/uncommitted · POST :id/commit.
// Handlers live in src/directory/controller.js, business rules in service.js,
// persistence in repository.js — composed next to the persistence bootstrap.
app.use(directoryModule.router);

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
app.use(memoModule.router);
memoModule.migrateLegacy().done.catch(error => console.log(`[memo] migration failed: ${error.message}`));

// Create + persist an isolated session record (its own git worktree + branch).
// Shared creation boundary; an explicit id creates or reuses a named session.
async function createSessionRecord({ dir, cli, kind, label = null, id = null, ephemeral = false, model = null, provider = undefined, effort = null, agent = null, rolePrompt = null, rolePresetId = null, type = null, elasticWorker = false, experimentalMode = null, loginFlow = null, persistence = 'bestEffort', persistenceSource = 'runtime.create-session' }) {
  if (!dir) return { ok: false, error: 'directory not found' };
  if (!SUPPORTED_CHAT_CLIS.includes(cli)) return { ok: false, error: `cli must be ${SUPPORTED_CHAT_CLIS.join(', ')}` };
  if (!['terminal', 'chat'].includes(kind)) return { ok: false, error: 'kind must be terminal or chat' };
  const loginFlowCli = { 'codex-login': 'codex', 'claude-auth-login': 'claude' }[loginFlow] || null;
  if (loginFlow && (loginFlowCli !== cli || kind !== 'terminal')) return { ok: false, error: 'loginFlow only supports whitelisted interactive login terminal sessions' };
  const experiment = validateExperimentalSession({ enabled: tuiChatMirrorEnabled(), cli, kind, experimentalMode });
  if (!experiment.ok) return experiment;
  // Model can be set for both Claude and Codex sessions. Claude terminal mode
  // interpolates it into a shell command, so keep the charset tight; Codex uses
  // the same id shape in config.toml.
  if (model && !/^[A-Za-z0-9._:\/\[\]-]{1,100}$/.test(model)) {
    return { ok: false, error: 'invalid model' };
  }
  const effortLevel = normalizeEffort(effort);
  if (effortLevel === undefined) return { ok: false, error: 'invalid effort' };
  if (!validEffortForCli(cli, effortLevel)) return { ok: false, error: 'invalid reasoning level' };
  const sessionEffort = effortLevel || (cli === 'codex' ? codexDefaultReasoningLevel() : null);
  const sessionAgent = normalizeCliAgent(cli, agent);
  if (sessionAgent === undefined) return { ok: false, error: 'invalid agent' };
  const rp = rolePrompt == null ? null : String(rolePrompt).trim();
  if (rp && rp.length > 40000) return { ok: false, error: 'rolePrompt too long (max 40000)' };
  // Provider override (cc-switch). An explicit value is validated; when omitted
  // the session inherits the global default for this CLI. null = use the default
  // login / OAuth subscription.
  let providerId;
  if (provider === undefined) {
    providerId = providerDefaults[cli] || null;
  } else {
    const v = validProviderId(cli, provider);
    if (!v.ok) return { ok: false, error: 'invalid provider' };
    providerId = v.value;
  }
  const sid = id || allocateSessionId(dir, cli, kind);
  if (persistedSessions.has(sid)) return { ok: true, id: sid, session: persistedSessions.get(sid), reused: true };

  // Every session is isolated — make sure the directory is a git repo, then give the
  // session its own worktree + branch.
  const ready = await ensureDirGitReady(dir);
  if (!ready.ok) return { ok: false, error: friendlyDirReason(ready.reason) };
  let worktreePath = path.join(dir.path, WORKTREE_SUBDIR, sid);
  let branch = `multicc/${sid}`;
  const rollbackOptions = { sessionId: sid, baseBranch: dir.baseBranch };
  try {
    ({ worktreePath, branch } = await gitWorktreeAdd(dir.path, sid, dir.baseBranch));
  } catch (e) {
    await gitWorktreeRollbackCreate(dir.path, worktreePath, branch, rollbackOptions);
    return { ok: false, error: 'worktree 创建失败: ' + e.message };
  }

  const session = {
    id: sid,
    dirId: dir.id,
    cli, kind,
    cliSessionId: null,   // claude gets one allocated on spawn; codex captures from first event
    label,
    model: model || null, // null = follow default/provider model
    effort: sessionEffort || null, // null = follow Claude Code/provider default
    agent: sessionAgent || null, // Claude/OpenCode/Qoder native --agent; unsupported CLIs keep null
    provider: providerId,  // cc-switch provider id; null = default login/subscription
    autoCommit: true,      // default: auto-commit & merge after task completion
    // streaming (流式常驻) is now claude's default mode: keep the claude process
    // alive across turns for faster, context-preserving continuation. Non-claude
    // CLIs ignore this field. Only claude chat sessions default on.
    streaming: cli === 'claude' && kind === 'chat',
    // autoContinue is no longer a user-facing toggle (the picker keeps only the
    // streaming option). The field stays true for back-compat only; the old
    // auto-drive mechanisms are retired.
    autoContinue: true,
    createdAt: new Date().toISOString(),
    worktreePath,
    branch,
  };
  if (rp) session.rolePrompt = rp;
  if (rolePresetId) session.rolePresetId = String(rolePresetId).trim();
  if (type) session.type = type;   // commander (and future roles) — round-trips via bootstrap/state + session-persistence
  if (loginFlow) session.loginFlow = loginFlow; // whitelisted interactive login terminal (codex-login)
  if (type === 'worker' && elasticWorker) session.elasticWorker = true;
  if (ephemeral) session.ephemeral = true; if (experiment.mode) session.experimentalMode = experiment.mode;
  if (kind === 'chat') ensureCliStates(session);
  try {
    if (persistence === 'required') {
      sessionPersistence.mutate(persistenceSource, records => records.set(sid, session));
    } else {
      persistedSessions.set(sid, session);
      savePersistedSessionsBestEffort(persistenceSource);
    }
  } catch (error) {
    // The record never committed. Remove the just-created worktree so a failed
    // HTTP create cannot leave either a session ghost or an unowned worktree.
    await gitWorktreeRollbackCreate(dir.path, worktreePath, branch, rollbackOptions);
    throw error;
  }
  appendEvent(dir.id, 'session_created', `${cli} ${kind}${ephemeral ? ' (gw)' : ''}`, sid);
  return { ok: true, id: sid, session };
}

const roleWorkerService = createRoleWorkerService({
  records: persistedSessions,
  mutate: (source, mutation) => sessionPersistence.mutate(source, mutation),
  createSession: createSessionRecord,
});
mountSessionCreateRoutes(app, {
  directories, createSessionRecord, asyncHandler,
  ensureRoleWorker: input => roleWorkerService.ensure(input),
  getAgentPreset: id => agentResources.agentPreset(id),
});

// Cross-CLI switching keeps one native state per CLI and emits a visible,
// bounded handoff checkpoint. Provider defaults and the warm chat stream are
// resolved lazily because their host runtimes are composed later in this file.
const cliSwitchRuntime = createCliSwitchRuntime({
  records: persistedSessions,
  sessionPersistence,
  supportedClis: SUPPORTED_CHAT_CLIS,
  chatSessions,
  getProviderDefaults: () => providerDefaults,
  codexDefaultReasoningLevel,
  getHistory: loadChatHistory,
  buildHandoffCheckpoint,
  activateCliState,
  rememberActiveCliState,
  ensureCliStates,
  cliStateSummary,
  gitWorktreeSnapshot,
  cwdForSession,
  getChatStream: () => chatStream,
  cancelClassify,
  assignKillReason,
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

// PATCH + fork profile routes: label/model/effort/agent/rolePrompt/memory/provider/
// subagent edits, and Happier-parity transcript fork. Handler logic lives in
// src/routes/session-profile.js; only host wiring stays here.
createSessionProfileRoutes({
  persistedSessions,
  directories,
  sessionPersistence,
  sessionPolicy,
  providers,
  providerRouterRuntime,
  // chatStream / providerRoutes are composed further down this file; resolve
  // them lazily or mounting would hit the const TDZ before boot finishes.
  getChatStream: () => chatStream,
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
  getChatHistoryService: () => chatHistoryService,
  getFolderMemory: () => folderMemory,
  getCliSwitchGitSnapshot: () => cliSwitchGitSnapshot,
}).mountRoutes(app);

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
mountSessionMemoryRoutes(app, {
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
});

// Memory graph/tree and generic file editing share one filesystem boundary.
// Session-level curated memory routes above retain their separate semantics.
mountMemoryBrowserRoutes(app, {
  fs,
  path,
  memoryStoreRoot: MEMORY_STORE_ROOT,
  directories,
  persistedSessions,
  workspaceBroadcast,
  atomicWriteText,
  now: Date.now,
});

// ── Cross-machine handoff (Happier-parity: move a live session to another machine) ──
// Export/import of the encrypted session bundle (metadata + chat history + memory
// files + provider state + git bundle of the worktree branch) lives in
// src/routes/session-bundle.js; only host wiring stays here.
createSessionBundleRoutes({
  persistedSessions,
  directories,
  providers,
  providerRouterRuntime,
  asyncHandler,
  appendEvent,
  createSessionRecord,
  loadChatHistory,
  getChatHistoryService: () => chatHistoryService,
  getFolderMemory: () => folderMemory,
}).mountRoutes(app);

sessionGitRuntime.mountRoutes(app);

// ── Single-session lifecycle: delete / relocate / restart ──
// Handler logic lives in src/routes/session-lifecycle.js; only host wiring
// stays here. The whole-server POST /api/restart below deliberately remains
// inline — its detached-scheduler debounce is host process state.
createSessionLifecycleRuntime({
  sessions, chatSessions, persistedSessions, directories, invalidSessions,
  sessionPersistence,
  getChatStream: () => chatStream,
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
  assignKillReason,
  createSession,
  cwdForSession,
  // pushRuntime is composed further down this file; forward lazily past the TDZ.
  cleanupPushMonitor: (id) => cleanupPushMonitor(id),
  getSessionGitRuntime: () => sessionGitRuntime,
}).mountRoutes(app);

// ── Restart the whole multicc server (graceful) ──
// Handler + detached-scheduler debounce live in src/routes/server-restart-route.js;
// only host wiring stays here. rootDir must be THIS file's __dirname (the package
// root the manager script lives in), not the route module's directory. _shuttingDown
// is forwarded lazily so the route reads the host's live shutdown flag at request time.
createServerRestartRoute({
  chatSessions,
  spawn,
  rootDir: __dirname,
  getShuttingDown: () => _shuttingDown,
}).mountRoutes(app);

// ── One-click update (runs `./multicc update`, which restarts us at the end) ──
// Run state lives in logs/update.log, not in memory: the process that starts the
// update is not the one that reports its outcome. See src/routes/update-route.js.
createUpdateRoute({
  chatSessions,
  spawn,
  rootDir: __dirname,
  getShuttingDown: () => _shuttingDown,
}).mountRoutes(app);

// ── Per-session metadata: inter-agent notes + liveness ──
// Handler logic lives in src/routes/session-meta.js; only host wiring stays
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
}).mountRoutes(app);

// ── File browser, download and upload lifecycle ──
mountFileTransferRoutes(app, {
  fs,
  path,
  os,
  upload,
  persistChatUpload,
  sendUploadError,
  getActiveSession: id => sessions.get(id),
  getPersistedSession: id => persistedSessions.get(id),
  log: message => console.log(message),
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
  log: logger,
});
const qwenAudioSupervisor = voiceHost.supervisor;
const vapidKeys = ensureVapidKeys();
webpush.setVapidDetails('mailto:multicc@localhost', vapidKeys.pubKey, vapidKeys.privKey);

// Notification delivery layer (subscriptions, senders, channel config) extracted
// to src/push.js. VAPID init above stays here; web-push is a shared singleton so
// push.js sends through the instance configured by setVapidDetails() above.
const push = require('./src/push');
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
const chatStream = require('./src/chat-stream');
const waitInjector = require('./src/wait-injector');
const sessionDelivery = require('./src/session-delivery').createSessionDelivery({
  admit: (session, text, opts) => chatTurnEngine.admitChatWork(session, text, opts),
  log: message => console.log('[multicc/delivery]', message),
});
let apiErrorAuxQueue = null;
const claudeOAuthRefresh = createClaudeOAuthRefresher({ logger });
const codexOAuthRefresh = createCodexOAuthRefresher({ logger });
const apiErrorHost = createApiErrorHost({
  policy: apiErrorPolicy, logger, persistedSessions, getTaskState, setTaskState,
  chatBroadcast, workspaceBroadcast, sessionDelivery,
  getAuxQueue: () => apiErrorAuxQueue,
  setSessionStatus, isShuttingDown: () => _shuttingDown,
  clearIncrementalSave: sessionId => chatHistoryRuntime?.clearIncrementalSave(sessionId),
  isCurrentTurnRunner: (...args) => isCurrentTurnRunner(...args),
  onApiError: decision =>
    claudeOAuthRefresh.onApiError(decision) || codexOAuthRefresh.onApiError(decision),
});
const {
  recordApiError, recordApiSuccess, evaluateTurnApiError, meaningfulTurnOutput,
  turnHasSideEffects, clearSessionApiErrorState, scheduleOwnedRetry,
  isNetworkUnhealthy, holdSession, auxHealthProbe, stopNetworkProbe,
} = apiErrorHost;
const bgCoalesce = require('./src/bg-completion-coalescer');
const { createDetached } = require('./src/detached');
const detached = createDetached({ baseDir: MULTICC_PATHS.detachedDir });
const share = require('./src/share');
mountShareRoutes(app, {
  share,
  persistedSessions,
  loadChatHistory,
  parseCookies,
  sharePageFile: path.join(__dirname, 'public', 'share.html'),
  logger,
});

// Read-only host/install metadata lives behind a narrow route boundary. PORT is
// read lazily because development mode may select a fallback port at startup.
mountSystemRoutes(app, {
  fs,
  path,
  https,
  rootDir: __dirname,
  networkInterfaces: () => os.networkInterfaces(),
  getPort: () => PORT,
  authRequired: () => ACCESS_TOKEN,
  gitRun,
});

// Read-only host control-plane endpoints share one narrow boundary. Mutable
// counterparts remain below until their persistence/auth semantics are split.
mountHostReadRoutes(app, {
  getVapidPublicKey: () => vapidKeys.pubKey,
  push,
  tunnel,
  getAccessToken: () => ACCESS_TOKEN,
  isLocalRequest,
  getProxyEnabled: () => CLAUDE_PROXY_ENABLED,
  getOfficialOAuthEnabled: () => CLAUDE_OFFICIAL_VIA_PROXY,
  macosPower,
});

// Mutable host settings use the matching narrow boundary. Durable .env/config
// writes commit before hot runtime state is changed, so write failures reach
// the terminal safe error handler instead of returning a runtime-only success.
mountHostWriteRoutes(app, {
  readEnvFile,
  writeEnvFile,
  push,
  tunnel,
  getAccessToken: () => ACCESS_TOKEN,
  setAccessToken: (token) => {
    process.env.ACCESS_TOKEN = token;
    ACCESS_TOKEN = token;
    void lanDiscovery.reconcile();
  },
  getAllowRemote: () => networkPolicy.allowRemote,
  isLocalRequest,
  getProxyEnabled: () => CLAUDE_PROXY_ENABLED,
  setProxyEnabled: (enabled) => {
    CLAUDE_PROXY_ENABLED = enabled;
    process.env.CLAUDE_PROXY_ENABLED = enabled ? '1' : '0';
  },
  getOfficialOAuthEnabled: () => CLAUDE_OFFICIAL_VIA_PROXY,
  setOfficialOAuthEnabled: (enabled) => {
    CLAUDE_OFFICIAL_VIA_PROXY = enabled;
    process.env.CLAUDE_OFFICIAL_VIA_PROXY = enabled ? '1' : '0';
  },
  macosPower,
  log: message => console.log(message),
  reportFailure: (stage, category) => reportHostControlFailure('host_write', stage, category),
});

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
  getAuxConfig,
  resolveGoalLimits,
  buildGoalLimitNote,
} = mountAuxGoalRoutes(app, {
  fs,
  crypto,
  rootDir: __dirname,
  auxConfigFile: MULTICC_PATHS.auxConfigFile,
  goalConfigFile: MULTICC_PATHS.goalConfigFile,
  atomicWriteJson,
  persistedSessions,
  savePersistedSessionsBestEffort,
  isShuttingDown: () => _shuttingDown,
  recordApiError,
  recordApiSuccess,
  appendChatMessage,
  loadChatHistory,
  providers,
  getPort: () => PORT,
  getClaudeOfficialViaProxy: () => CLAUDE_OFFICIAL_VIA_PROXY,
  executeAuxHttp,
  broadcast: broadcastTo,
});
apiErrorAuxQueue = auxQueue;

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

// Dispatch admission reads classify (sessionWorkHost.isRunActive), never
// liveness: no prep phase, no isStreaming, no orchestrationChatBusy. Those are
// strict subsets of classifyState 'P', which is written synchronously at turn
// start and only clears on the Aux verdict — earlier in, later out, so the
// classify answer is at least as conservative as the liveness one was.
//
// The repo lease is NOT liveness and stays: gitMergeBack commits and ff-merges
// the session's own worktree, which is the same path the CLI runs in, and
// classify cannot see a git lock. Dropping it would let a dispatch land in a
// worktree git is concurrently rewriting.
function dispatchTargetBusy(sid) {
  return !!sessionWorkHost?.isRunActive(sid) || !!defaultRepoActor.isLeased(sid);
}
const commanderRouter = createCommanderRoutingHost({
  records: persistedSessions, directories, isBusy: dispatchTargetBusy,
  sessionPersistence, createSessionRecord, dispatchToSession,
  maxElasticWorkers: process.env.MULTICC_COMMANDER_MAX_ELASTIC_WORKERS, logger,
});
const taskBoardRuntime = createTaskBoardRuntime({
  file: MULTICC_PATHS.taskBoardFile,
  auxQueue,
  records: persistedSessions,
  // Read-only view, not the cloning load(): the board resolves each task's
  // canonical body by scanning its sessions' transcripts, so GET /api/task-board
  // cloned every referenced transcript once per task. That was the single most
  // expensive thing the server did — see the port note in routes/task-board.js.
  loadHistory: sessionId => viewChatHistory(sessionId),
  dispatchToSession,
  routeCommanderTask: commanderRouter.route, sendSessionMessage: (...args) => taskContextHost.deliverSessionMessage(...args),
  workspaceBroadcast: (dirId, payload) => workspaceBroadcast(dirId, payload),
  atomicWriteJson,
  isSystemInjected: msg => isSystemInjectedMsg(msg),
  resolveSessionQueue: (...args) => sessionWorkHost.resolveTask(...args),
  getCommanderMigrationStatus: dirId => commanderMigrationState.statusFor(dirId),
  getSessionRunState: sid => sessionWorkHost?.getRunState(sid) || 'idle',
  resolveGoalLimits,
  buildGoalLimitNote,
  logger: console,
});
taskBoardRuntime.mountRoutes(app);
const taskContextHost = createTaskContextHost({
  getState: sessionId => chatSessions.get(sessionId), emitClients: broadcastTo,
  append: (sessionId, message) => chatHistoryRuntime.appendMessage(sessionId, message),
  getTaskBoard: () => taskBoardRuntime, classifyDisplay,
  containsDelivery: (sessionId, id) => chatHistoryService.containsDelivery(sessionId, id),
  randomUUID: () => crypto.randomUUID(), getRecord: sessionId => persistedSessions.get(sessionId),
  runTurn: (sessionId, text, options) => chatTurnEngine.admitChatWork(sessionId, text, options),
});

// Skill-sync owns converter/link state, its watcher and its periodic timer.
// The host supplies only the process/session ports needed by detached AI conversion.
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
mountSkillSyncRoutes(app, skillSyncRuntime);

// ── Per-session providers (backed by cc-switch) ──────────────────────────────
const providerRoutes = createProviderRoutes({
  fs,
  providerDefaultsFile: MULTICC_PATHS.providerDefaultsFile,
  atomicWriteJson,
  providers,
  providerRouterRuntime,
  findProviderReferences,
  persistedSessions,
  getAuxConfig,
  claudeCmd: CLAUDE_CMD,
  getPort: () => PORT,
  getClaudeOfficialViaProxy: () => CLAUDE_OFFICIAL_VIA_PROXY,
  http,
  https,
  logger: console,
});
const { providerDefaults, validProviderId } = providerRoutes;
commanderMigrationRunner = createCommanderMigrationHost({
  state: commanderMigrationState, directories, records: persistedSessions,
  commanderPrompt: agentCommanderPrompt, commanderPreset: agentCommanderPreset,
  fs, isHomeOrAbove, realPathOf, invalidSessions,
  supportedClis: SUPPORTED_CHAT_CLIS, cliAvailabilitySummary, providerDefaults, providers,
  sessionPersistence, createSessionRecord, logger,
});
providerRoutes.mountCatalogRoutes(app);

// GET /api/opencode/models — list models the local opencode CLI exposes
// (provider/model strings, cached for 1 day). Used by the chat picker when an
// opencode session has no multicc-managed provider's model list to render.
mountOpenCodeModelRoutes(app);

// GET /api/qoder/models — the Qoder CN catalog entitled to the logged-in
// account (`qoderclicn --list-models`, cached for 1 day). Lets each qoder
// session pick its own model instead of sharing ~/.qoder-cn/settings.json.
mountQoderModelRoutes(app);

// GET /api/opencode/quota — drive whatever Chrome the user already has open
// (src/chrome-cdp.js) to scrape the OpenCode Zen console's Go subscription
// usage (5h rolling / weekly / monthly). SSR'd hydration data, no REST API
// exists. Surfaces chrome_unavailable / needs_login / unavailable states so
// the chat rate-limit bar can prompt instead of degrading silently.
mountOpenCodeQuotaRoutes(app); mountQoderQuotaRoutes(app); mountCodexQuotaRoutes(app);
mountArkQuotaRoutes(app); mountZhipuQuotaRoutes(app); mountKimiQuotaRoutes(app); mountClaudeUsageQuotaRoutes(app); mountAliyunQuotaRoutes(app); require('./src/routes/quota-bars').mountQuotaBarRoutes(app);
mountCodexOAuthRoutes(app, { getStatus: () => codexOAuthRefresh.status(), directories, createSessionRecord, persistedSessionExists: id => persistedSessions.has(id) });
const claudeOAuthSurface = createClaudeOAuthSurface({ refresher: claudeOAuthRefresh, directories, createSessionRecord, persistedSessions, destroySessionCascade, sessionPersistence, appendEvent }); claudeOAuthSurface.mountRoutes(app); // see src/routes/claude-oauth.js header
// Token APIs remain between the two Provider route phases so the established
// route ordering stays byte-compatible while accounting lives in one runtime.
tokenUsageRuntime.mountRoutes(app);

providerRoutes.mountManagementRoutes(app);

// GET /api/providers/:appType/:id/balance + GET /api/providers/balances —
// explicit per-provider and all-at-once quota/balance queries for the manage
// page, reusing the usage-limit poller's vendor adapters.
mountProviderBalanceRoutes(app, providers);

// ZCode auth management (L1-L4: desktop key sync, manual key, OAuth login,
// pre-turn auth check). Mounted after provider routes for logical grouping.
mountZcodeAuthRoutes(app); mountKimiAuthRoutes(app);

// Temp artifacts produced by the multicc-artifact skill (served from
// ~/.multicc/artifacts). Mounted before the public static handler so /artifacts
// is claimed first; auth is bypassed via the capability <id> (see middleware).
artifacts.mount(app);

// Static assets (src/routes/static-assets.js): the `/` root redirect, the
// versioned-HTML middleware (cache-busting `?v=<mtime>` rewrite for embedded
// WebViews) and the express.static mount for public/ (with .apk download
// headers). Mounted at exactly the point where these handlers used to live so
// middleware ordering — and therefore behaviour — is unchanged.
createStaticAssetsRoutes({
  express,
  fs,
  path,
  publicDir: path.join(__dirname, 'public'),
}).mountRoutes(app);

// ── Chat mode: message history ──
// Display history is paginated and independent from native CLI transcripts.
const CHAT_HISTORY_SOFT_CAP = 10000;
const CHAT_HISTORY_PAGE = 5;

// Chat history runtime owns persistence composition, pagination routes,
// incremental checkpoints, history clear and committed-message side effects.
let _chatMsgIdSeq = 0;
function newChatMsgId() {
  return 'm' + Date.now().toString(36) + '-' + (_chatMsgIdSeq++).toString(36);
}
chatHistoryRuntime = createChatHistoryRuntime({
  history: chatHistoryRepository,
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
  saveBestEffort: savePersistedSessionsBestEffort,
  sessionPersistence,
  getSessionRunState: id => sessionWorkHost?.getRunState(id) || 'idle',
  getActiveBackgroundTasks: id => backgroundTaskRuntime?.listActiveBackgroundTasks(id) || [],
  chatStream, cwdForSession,
  trackPendingMemoryDistill: _trackPendingMemoryDistill,
  projectMessages: (_sessionId, messages) => projectHistoryUsage(messages),
  logger,
});
chatHistoryService = chatHistoryRuntime.service;
chatHistoryRuntime.mountRoutes(app);
createAuxRunRoutes({ records: persistedSessions, getLog: () => auxRunLog }).mountRoutes(app);

// Compatibility wrappers keep earlier host composition (Aux, dispatch and
// session queries) independent of the runtime's later construction point.
function loadChatHistory(sessionId) { return chatHistoryRuntime.load(sessionId); }
// Read-only twin of loadChatHistory for callers that only measure the
// transcript; skips the deep clone. Never hand its messages to a mutator.
function viewChatHistory(sessionId) { return chatHistoryRuntime.viewHistory(sessionId); }
function chatLastActivity(sessionId, activeChat) {
  return chatHistoryRuntime.lastActivity(sessionId, activeChat);
}
function scheduleIncrementalSave(sessionId, state) {
  return chatHistoryRuntime.scheduleIncrementalSave(sessionId, state);
}
function appendChatMessage(sessionId, message) {
  return taskContextHost.appendMessage(sessionId, message);
}

// The host coordinator owns result/usage/post-turn ordering. server.js supplies
// only concrete persistence and broadcast ports; it no longer reimplements the
// lifecycle state machine inline.
const {
  isCurrentTurnRunner,
  assistantCheckpointKey,
  persistFinalAssistantResult,
  recordDurableTurnUsage,
  runDurablePostTurn,
} = createChatHostRuntime({
  appendMessage: appendChatMessage,
  persistUsage: accumulateTokenUsage,
  afterUsageCommit: (sessionId) => {
    broadcastProviderTokenStats(sessionId);
    broadcastRoleTokenStats(sessionId);
  },
  getSessionState: (sessionId) => chatSessions.get(sessionId),
  consumeHandoff: consumePendingCliHandoff,
  emitTurnComplete: (sessionId, state, completion) => bus.emit('chat:turn-complete', sessionId, state, completion),
  emitDispatchComplete: (operationId, sessionId, text) => bus.emit('chat:dispatch-complete', operationId, sessionId, text),
  emitGatewayComplete: (...args) => bus.emit('chat:gateway-turn-complete', ...args),   // text, sessionId, turnId, requestId
  logSuppressed: (detail) => logger.info('chat_post_turn_suppressed', detail),
});
// Codex usage is cumulative upstream; this host converts it before any consumer sees it.
const codexUsageHost = createCodexUsageHost({
  loadHistory: loadChatHistory,
  reconcileRole: reconcileCodexRoleUsage,
  clearIncrementalSave: chatHistoryRuntime.clearIncrementalSave,
  persistFinalAssistantResult,
  recordDurableTurnUsage,
  recordResultEvent,
  setSessionStatus,
  logger,
});

function chatBroadcast(sessionName, payload) {
  // #110: journal every client-visible event (never blocks or throws)…
  turnEventJournal.note(sessionName, payload);
  // …then fan out. The sync dispatch bridge observes the same normalized
  // stream as Web/App, but only through an operation-lineage filter and a
  // redacting reducer.
  bus.emit('chat:stream-progress', sessionName, payload);
  taskContextHost.broadcast(sessionName, payload);
}

const subscribeDispatchProgress = createDispatchProgressSubscription({
  bus,
  cliOf: id => persistedSessions.get(id)?.cli || '',
  activeTurnOf: id => chatSessions.get(id)?._activeTurn,
  streamReplayOf: id => chatSessions.get(id)?.streamReplay,
});

// Usage-limit poller — the active-poll half of the limit subsystem. Claude 5h /
// ChatGPT-codex report limits in response headers (extracted passively by the
// proxy); GLM Coding Plan and DeepSeek expose quota only via a separate
// authenticated request, polled at each turn boundary. Wiring lives in
// src/chat/usage-limit-wiring so server.js stays thin. Best-effort throughout.
const usageLimitPoller = require('./src/chat/usage-limit-wiring').createUsageLimitWiring({
  persistedSessions, providers, chatBroadcast,
  createPoller: require('./src/usage-limit-poller').createUsageLimitPoller,
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
// SDKs are lazy-loaded inside each bridge, so MultiCC boots fine without them.
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
pushRuntime.mountRoutes(app);
const pushOnOutput = pushRuntime.onOutput;
const pushOnInput = pushRuntime.onInput;
const triggerPush = pushRuntime.notify;
const cleanupPushMonitor = pushRuntime.cleanup;

// ── Task state persistence (step ①) ───────────────────────────────────────────
// persisted.taskState is the durable closed-loop task snapshot: it survives
// restarts so the reconcile (②) can
// decide what was running, whether it stalled, and whether to nudge. Falls back
// to {} for legacy sessions that predate this field.
//
// Shape:
//   { goal, phase, startedAt, endedAt, lastSummary, lastSummaryAt,
//     lastTurnEndedAt, classifyState, pendingDispatches, classifyHistory,
//     pendingUserInput, userInputSignalVersion, apiError,
//     classifyUpdatedAt, cancelledAt, cancelReason }
//   classifyState ∈ D | C | W | B | E | P | null  (D=done; B=terminal only; null=never classified)
//   classifyHistory: [{ at: ms, goal, phase, state, error }] — last 7 days
const TASK_STATE_DEFAULTS = {
  goal: '', phase: 'idle', startedAt: null, endedAt: null,
  lastSummary: '', lastSummaryAt: null, lastTurnEndedAt: null,
  classifyState: null, pendingDispatches: [],
  classifyHistory: [],
  pendingUserInput: null, userInputSignalVersion: 0, userInputSignalTurnId: null,
  apiError: null,
  classifyUpdatedAt: null, cancelledAt: null, cancelReason: null,
};

function getTaskState(persisted) {
  if (!persisted) return { ...TASK_STATE_DEFAULTS };
  const ts = persisted.taskState || {};
  return { ...TASK_STATE_DEFAULTS, ...ts };
}

// Merge a patch into persisted.taskState and persist. Best-effort save: callers
// may pass {save:false} to batch updates. Always returns the new state.
function setTaskState(sessionId, patch, opts = {}) {
  const persisted = persistedSessions.get(sessionId);
  if (!persisted) return null;
  const cur = getTaskState(persisted);
  const classifyChanged = Object.prototype.hasOwnProperty.call(patch, 'classifyState')
    && patch.classifyState !== cur.classifyState;
  const next = {
    ...cur,
    ...patch,
    ...(classifyChanged && !Object.prototype.hasOwnProperty.call(patch, 'classifyUpdatedAt')
      ? { classifyUpdatedAt: Date.now() } : {}),
  };
  persisted.taskState = next;
  if (opts.save !== false) savePersistedSessionsBestEffort('runtime.task-state');
  // Push the aux classify result to the chat client so it can show what the
  // assistant currently thinks this session's goal/phase is. Cheap; only fires
  // when a chat WS is connected for this session.
  const classifyPayload = {
    type: 'task_state',
    goal: next.goal || '',
    phase: next.phase || 'idle',
    classifyState: next.classifyState || null,
    apiError: next.apiError || null,
  };
  try {
    chatBroadcast(sessionId, classifyPayload);
  } catch (_) {}
  // Also broadcast to workspace subscribers so fleet cards / Active sessions
  // reflect classify state changes in real time without a page refresh.
  if (persisted.dirId) {
    try {
      workspaceBroadcast(persisted.dirId, { ...classifyPayload, sessionId });
    } catch (_) {}
  }
  return next;
}
const userInputSignalHost = createUserInputSignalHost(
  { getSession: id => chatSessions.get(id), getState: id => getTaskState(persistedSessions.get(id)),
    setState: setTaskState, log: message => console.log(message),
    onResolved: (id, requestId, taskId, extra) => chatBroadcast(id, { type: 'user_input_resolved', requestId, taskId: taskId ?? null, ...(extra || {}) }) });
sessionWorkHost = createSessionWorkHost({
  runtime: () => orchestrationRuntime,
  getRecord: id => persistedSessions.get(id),
  getChatSession: id => chatSessions.get(id),
  getTaskState,
  pendingUserInput: id => userInputSignalHost.pending(id),
  recordUserInput: signal => userInputSignalHost.record(signal),
  resolveUserInput: (id, requestId) => userInputSignalHost.resolve(id, requestId),
  broadcast: chatBroadcast,
  setTaskState,
  onTaskBoardQueueEvent: event => taskBoardRuntime.onQueueEvent(event),
  onWorkspaceQueueStatus: (id, status) => workspaceRuntime.setQueueStatus(id, status),
  // Cancellation submits a structured result to classify instead of writing
  // state; classify is the only writer of session/task business state.
  dispatchStateAction,
  reconcileTaskProjection: (taskId, options) =>
    taskBoardRuntime.reconcileRunState(taskId, options),
  classifyDisplay,
  cancelClassify,
  // Stopping the runner also stops the judgement queued for it: drop this
  // session's queued + in-flight classify jobs so a cancelled turn is not still
  // paying for an Aux verdict that will be discarded on arrival.
  cancelSessionClassifyJobs: sessionId => auxQueue.cancelClassifyFor(sessionId),
  chatStream,
  assignKillReason,
  appendMessage: appendChatMessage,
  cancelPreparation(sessionId, reason) {
    const preparation = chatTurnPreparationRuntime.snapshot(sessionId);
    if (preparation.phase === 'preparing' && preparation.turnId) {
      chatTurnPreparationRuntime.abortPreparation(sessionId, preparation.turnId, reason);
    }
  },
  log: logger,
});

const AUX_HEALTH_PROBE_INTERVAL_MS = 5 * 60 * 1000;  // ④: probe aux recovery while unhealthy

// GET /api/scan/history — debug: recent periodic-scan passes, newest first, each
// with its per-session enqueue/skip decisions + reasons. In-memory ring only.
//   ?limit=N   (default 20, capped at SCAN_HISTORY_MAX_PASSES)
mountScanRoutes(app, { scanHistory, maxPasses: SCAN_HISTORY_MAX_PASSES });

// ── Unified classify — the single source of truth for task state ────────────
// goal/phase/D/C/W/E/P all come from ONE aux call per invocation. Call sites:
//   · turn-end:   immediately after a turn ends to finalise goal + D/C/W/E/P
//   · scan:       every 60s, re-judges any session not yet D/W (system-side
//                 events: API recovered, interrupted resume, goal resolution)
// No in-turn loop — while streaming the output is incomplete and a mid-turn
// verdict would be unreliable. On aux unhealthy: classify is suppressed; the
// last-known goal/phase is frozen and the dashboard banner warns the user.

// API recovery is decided at the owned runner boundary. Classify state E only
// reflects that decision; it cannot inject a second retry turn.

const backgroundTaskRuntime = createBackgroundTaskRuntime({
  broadcast: chatBroadcast,
  observeTask: observation => orchestrationRuntime.observeTask(observation),
  noteBgResultInjected: sessionName => waitInjector.noteBgResultInjected(sessionName),
  deliverSystem: (sessionName, text, origin) => sessionDelivery.deliverSystem(sessionName, text, origin),
  createCoalescer: bgCoalesce.createCoalescer,
  buildNudge: bgCoalesce.buildNudge,
  classifyCompletion: bgCoalesce.classifyBgCompletion,
  spawn,
  readFile: fs.readFileSync,
  realpath: fs.realpathSync,
  tmpdir: () => '/tmp',
  getuid: () => process.getuid(),
  setTimer: setTimeout,
  clearTimer: clearTimeout,
  now: Date.now,
  logger,
});

const tuiChatMirrorRuntime = createTuiChatMirrorRuntime({ enabled: tuiChatMirrorEnabled(), records: persistedSessions, cwdForSession, providerFor, send: sendWs, setSessionStatus, saveBestEffort: source => savePersistedSessionsBestEffort(source), logger });

// Chat turn engine: per-turn + persistent-streaming turn execution, the chat
// stream-json WebSocket handler and the orchestration wait-injector helpers.
// Late/reassigned host bindings are injected as getters; stable containers,
// hoisted functions and early consts by reference.
const chatTurnEngine = createChatTurnEngine({
  getBackgroundTaskRuntime: () => backgroundTaskRuntime,
  getSessionWorkHost: () => sessionWorkHost,
  getChatHistoryRuntime: () => chatHistoryRuntime,
  getChatHistoryService: () => chatHistoryService,
  getExperimentalTuiChatRuntime: () => tuiChatMirrorRuntime,
  isShuttingDown: () => _shuttingDown,
  getPort: () => PORT,
  getClaudeProxyEnabled: () => CLAUDE_PROXY_ENABLED,
  getClaudeOfficialViaProxy: () => CLAUDE_OFFICIAL_VIA_PROXY,
  persistedSessions,
  chatSessions,
  invalidSessions,
  logger,
  folderMemory,
  detached,
  routerToolHost,
  turnProgressHeartbeat,
  providerRouterRuntime,
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
  classifyTurnEnd,
  cancelClassify,
  emitRunningNotify,
  emitTurnOutcome,
  ensureCurrentTask,
  getTaskState,
  setTaskState,
  buildGatewayPrompt,
  buildDispatchContextPrompt,
  buildGoalLimitNote,
  appendChatMessage,
  loadChatHistory,
  viewChatHistory,
  scheduleIncrementalSave,
  chatBroadcast,
  sendWs,
  persistFinalAssistantResult,
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
  isNetworkUnhealthy,
  holdSession,
  getTokenUsage,
  resetRoleTokenUsage,
  providerTokenWindows,
  getPendingMemoryDistill,
  effectiveSessionModel,
  effectiveSessionEffort,
  codexStreamDisconnectContinuePrompt,
  CODEX_STREAM_DISCONNECT_CONTINUE_MAX,
  resolveGoalLimits,
  auxQueue,
  GATEWAY_ID,
  MULTICC_IMG_HINT,
  CHAT_HISTORY_PAGE,
});

// Chat domain owns runChatTurn: bus 'chat:run' (fire-and-forget), registry 'chat.runTurn' (return value).
bus.on('chat:run', (sessionName, text, opts) => {
  chatTurnEngine.admitChatWork(sessionName, text, opts).catch(error => {
    logger.error('chat_work_admission_failed', { sessionId: sessionName, error: error.message });
  });
});
services.provide('chat.runTurn', chatTurnEngine.admitChatWork);

orchestrationRuntime = createOrchestrationRuntime({
  file: MULTICC_PATHS.orchestrationFile, databaseFile: MULTICC_PATHS.orchestrationDbFile,
  runChatTurn: chatTurnEngine.runChatTurn,
  isBusy: dispatchTargetBusy,
  hasPersistedDelivery: chatTurnEngine.persistedOrchestrationDelivery,
  deliverOutbox: chatTurnEngine.deliverOrchestrationOutbox,
  probe: chatTurnEngine.probeExplicitWait,
  detachedAdapter: detached,
  recoverDispatchResult: chatTurnEngine.recoverDispatchOperation,
  replayRecoveredDispatchEffects: () => {},
  getSessionRecoveryState: id => sessionWorkHost.recoveryState(id),
  onSchedulerEvent: event => sessionWorkHost.onSchedulerEvent(event),
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
  cancelTurn: (id, options) => sessionWorkHost.cancelActiveTurn(id, options),
  logger,
});
// Companion to the dead-runner watchdog: consumes the liveness `stalled` verdict (display-only before) to end wedged turns.
const envNumber = (value, fallback) => (value ? Number(value) : fallback);
const stalledTurnRecovery = createStalledTurnRecovery({
  listRecords: () => persistedSessions.entries(), getTaskState, getChatSession: id => chatSessions.get(id),
  getStreamStatus: id => chatStream.status(id), assessLiveness: id => livenessRuntime.assess(id), getTurnStatus: id => turnProgressHeartbeat.status(id),
  stallSilentMs: envNumber(process.env.MULTICC_STALL_SILENT_MS, livenessRuntime.thresholds.stallSilentMs), startingGraceMs: envNumber(process.env.MULTICC_STALLED_STARTING_GRACE_MS),
  confirmations: envNumber(process.env.MULTICC_STALLED_CONFIRMATIONS), cooldownMs: envNumber(process.env.MULTICC_STALLED_COOLDOWN_MS),
  cancelTurn: (id, options) => sessionWorkHost.cancelActiveTurn(id, options), logger,
});
const providerLogWatchdog = createProviderLogWatchdog({ listRecords: () => persistedSessions.entries(), getChatSession: id => chatSessions.get(id),
  broadcast: (id, evt) => chatBroadcast(id, evt), cancelTurn: (id, options) => sessionWorkHost.cancelActiveTurn(id, options),
  intervalMs: envNumber(process.env.MULTICC_PROVIDER_LOG_INTERVAL_MS), minSilenceMs: envNumber(process.env.MULTICC_PROVIDER_LOG_MIN_SILENCE_MS), logger });
const logHousekeeping = createLogHousekeeping({ logsDir: path.join(__dirname, 'logs'), logger,
  retainDays: envNumber(process.env.MULTICC_LOG_RETAIN_DAYS), keepTailBytes: envNumber(process.env.MULTICC_LOG_KEEP_TAIL_BYTES) });
routerToolHost.configure({ records: persistedSessions, dispatchToSession, orchestrationRuntime, taskBoard: taskBoardRuntime,
  recordUserInput: signal => sessionWorkHost.recordInput(signal), cancelActiveTurn: (id, opts) => sessionWorkHost.cancelActiveTurn(id, opts),
  onDispatchCancelled: id => cancelDispatchRun(id), subscribeDispatchProgress, recordRouterAdmission });

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
createOrchestrationRoutes({
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
}).mountRoutes(app);

// WebSocket authentication, endpoint routing, terminal attachment and keep-alive
// live behind one transport boundary. Mutable auth/shutdown state stays lazy.
mountWsConnectionRouter(wss, {
  metrics,
  logger,
  share,
  parseCookies,
  isLocalRequest,
  authSecurity,
  voiceAsr,
  ttsService,
  workspaceRuntime,
  auxQueue,
  auxSessionId: AUX_SESSION_ID,
  loadChatHistory,
  sessions,
  persistedSessions,
  createSession,
  sendWs,
  resolveCwd,
  tmuxWriteInput,
  tmuxResize,
  applyMaxClientSize,
  pushOnInput,
  handleChatWs: (ws, req, urlObj) => chatTurnEngine.handleChatWs(ws, req, urlObj),
  getShuttingDown: () => _shuttingDown,
  getAccessToken: () => ACCESS_TOKEN,
  allowLegacyWsCookie: ALLOW_LEGACY_WS_COOKIE,
  allowLegacyWsToken: ALLOW_LEGACY_WS_TOKEN,
  fs,
  path,
  os,
});

// Initialize AuxQueue (loads history, registers __aux__ session)
auxQueue.init();

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
triggerRuntime.mountRoutes(app);
const teardownTriggers = triggerRuntime.teardownSession;

const startupRepoReady = Promise.resolve().then(providers.migrateLegacyProviderProtocols).then(initWorktrees)
  .catch(error => console.error('[multicc] async repo startup failed:', error.message))
  .then(() => commanderMigrationRunner.run())
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

// Scheduled tasks (定时任务): inject the session-creation + turn-running machinery.
// Complements the per-session triggers above — this one fires by creating a
// fresh chat session in a target directory (directory-level recurring tasks).
cronTasks.mount(app);
cronTasks.init({ directories, createSessionRecord, runChatTurn: chatTurnEngine.runChatTurn, sessionExists: (id) => persistedSessions.has(id) });
// In-process external-tunnel monitor (replaces phtunnel-monitor.sh watchdog).
tunnel.init();

// Graceful shutdown and service timers live in src/host-lifecycle.js; mutable host state stays lazy via accessors.
const { shutdownCoordinator, trackServiceTimer, gracefulShutdown } = createHostLifecycle({
  getShuttingDown: () => _shuttingDown,
  setShuttingDown: (v) => { _shuttingDown = v; },
  setServiceReady: (v) => { serviceReady = v; },
  getChatHistoryRuntime: () => chatHistoryRuntime,
  getOrchestrationRuntime: () => orchestrationRuntime,
  chatSessions,
  sessions,
  auxQueue,
  appendChatMessage,
  isCurrentTurnRunner,
  recordPartialCheckpoint,
  assistantCheckpointKey,
  savePersistedSessionsBestEffort,
  waitInjector,
  cronTasks,
  tunnel,
  stopNetworkProbe,
  skillSyncRuntime,
  triggerRuntime,
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
  assignKillReason,
  chatStream,
  cleanupPushMonitor,
  stopOutputCapture,
  routerToolHost,
  sessionPersistence,
  qwenAudioSupervisor,
});
// Terminal error handler: catches errors that reach next(err) or throw out of
// async handlers wrapped with asyncHandler(). Redacts stacks/stderr, returns a
// generic {error, requestId} so clients can't fingerprint the filesystem.
// Registered LAST so every route falls through here.
app.use(safeErrorHandler(logger));

(async () => {
  // Do not accept API/WS traffic until legacy worktrees are migrated and tmux
  // recovery has completed. The work itself is asynchronous, so this gates
  // readiness without blocking timers or other event-loop work.
  await startupRepoReady;
  await orchestrationRuntime.start();
  workspaceRuntime.hydrateQueueStatuses(await orchestrationRuntime.sessionScheduler.queueSummaries([...persistedSessions.keys()]));
  if (networkPolicy.development) {
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
  server.once('error', err => {
    logger.error('listen_failed', { host: BIND_HOST, port: PORT, error: err.message, code: err.code });
    process.exit(1);
  });
  server.listen(PORT, BIND_HOST, () => {
    logger.info('server_listening', { host: BIND_HOST, port: PORT, remote: !networkPolicy.allowRemote ? false : true, development: networkPolicy.development });
    void lanDiscovery.reconcile();
    console.log(`\n  MultiCC is running at http://${BIND_HOST.includes(':') ? `[${BIND_HOST}]` : BIND_HOST}:${PORT}\n`);
    console.log(`  Manage sessions at http://${BIND_HOST.includes(':') ? `[${BIND_HOST}]` : BIND_HOST}:${PORT}/manage\n`);
    console.log(`  Use Tailscale / ngrok for HTTPS access from external devices.\n`);
    seedTokenUsageFromHistory();
    backfillReportedModels();                       // recover runtime model for pre-upgrade sessions
    skillSyncRuntime.start();
    triggerRuntime.start();
    try { voiceHost.prepareBoot(); } catch (err) { logger.warn('voice_boot_prepare_failed', { error: err.message }); }
    qwenAudioSupervisor.reconcileAll().catch(err => logger.warn('voice_reconcile_failed', { error: err && err.message }));
    // Periodic scan re-judges non-terminal sessions; first tick delayed 6s so aux warms up.
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
    artifacts.cleanup();
    trackServiceTimer(setInterval(() => artifacts.cleanup(), 6 * 3600 * 1000));
    // ④: probe aux recovery every 5 min while unhealthy (no-op when healthy).
    trackServiceTimer(setInterval(() => auxHealthProbe(), AUX_HEALTH_PROBE_INTERVAL_MS));
    // Keep the official OAuth credential alive. The check is a credential read;
    // it only runs the CLI once the expiry is close, so the router never has to
    // report "run `claude` once to refresh the Keychain" to a user. Boot counts
    // as a check because a machine that was asleep wakes up with a stale token.
    claudeOAuthRefresh.check('boot').then(() => claudeOAuthSurface.afterRefresh('boot'));
    trackServiceTimer(setInterval(() => claudeOAuthRefresh.check().then(() => claudeOAuthSurface.afterRefresh('periodic')), CLAUDE_OAUTH_CHECK_INTERVAL_MS));
    // Same job for the shared default codex login (~/.codex/auth.json): keep
    // the one-hour access token fresh so concurrent provider-less codex turns
    // never race over the single-use refresh token.
    codexOAuthRefresh.check('boot');
    trackServiceTimer(setInterval(() => codexOAuthRefresh.check(), CODEX_OAUTH_CHECK_INTERVAL_MS));
    serviceReady = true;
  });
})();
