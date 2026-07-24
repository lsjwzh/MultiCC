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
const { routeLegacyCommanderMarkers } = require('./src/dispatch/legacy-commander-route');
const { createShutdownCoordinator } = require('./src/shutdown');
const { requestIdMiddleware, safeErrorHandler, asyncHandler } = require('./src/http-errors');
const { scheduleDetachedRestart } = require('./src/server-restart');
const { createMemoModule } = require('./src/memo');
const { mountScanRoutes } = require('./src/routes/scan');
const { mountSystemRoutes } = require('./src/routes/system');
const { mountHostReadRoutes } = require('./src/routes/host-read');
const { mountHostWriteRoutes } = require('./src/routes/host-write');
const { mountVoiceRoutes } = require('./src/routes/voice');
const { mountAuxGoalRoutes } = require('./src/routes/aux-goal');
const { createTaskBoardRuntime } = require('./src/routes/task-board');
const { createCommanderMigrationState } = require('./src/commander-migration');
const { createCommanderMigrationHost, createCommanderRoutingHost } = require('./src/commander-host-runtime');
const { mountFileTransferRoutes } = require('./src/routes/file-transfer');
const { mountSkillSyncRoutes } = require('./src/routes/skill-sync');
const { createSkillSyncRuntime } = require('./src/skill-sync');
const skillConverter = require('./src/skill-converter');
const { createProviderRoutes } = require('./src/routes/providers');
const { mountMemoryBrowserRoutes } = require('./src/routes/memory-browser');
const { mountSessionMemoryRoutes } = require('./src/routes/session-memory');
const { createAgentResourcesRoutes } = require('./src/routes/agent-resources');
const { createRoleWorkerService } = require('./src/session/role-worker');
const { mountSessionCreateRoutes } = require('./src/routes/session-create');
const { createOrchestrationRoutes } = require('./src/routes/orchestration');
const { createSessionGitRuntime } = require('./src/routes/session-git');
const { createAuthRuntime } = require('./src/routes/auth');
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
  parseClassifyResult,
  buildClassifySystemPrompt,
  classifyDisplay,
  phaseLabel,
} = require('./src/classify/vocab');
const { USER_INPUT_SIGNAL_PROMPT, buildCodexUserInputConstraint,
  createUserInputSignalHost } = require('./src/classify/user-input-host');
const {
  DISPATCH_RE,
  DISPATCH_CONFIRM_RE,
  DISPATCH_CANCEL_RE,
  parseDispatchMarker,
  parseAllDispatchMarkers,
  parseAllRouteMarkers,
  ROUTE_RE_G,
  isDispatchPlaceholderTarget,
} = require('./src/dispatch/markers');
const { createDispatchTargeting } = require('./src/dispatch/targeting');
const { createLivenessRuntime } = require('./src/liveness/runtime');
const { createProcessProbe } = require('./src/liveness/process-probe');
const { createPushRuntime } = require('./src/push-runtime');
const { createWorkspaceRuntime } = require('./src/workspace/runtime');
const { createChatHistoryFileRepository } = require('./src/session');
const { TurnProgressHeartbeat } = require('./src/chat/progress-heartbeat');
const { createBackgroundTaskRuntime } = require('./src/chat/background-task-runtime');
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
} = require('./src/chat');
const {
  createErrorDto,
  createWsEnvelope,
  requestContext,
  toDispatchResultDto,
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
const { installWsBackpressure } = require('./src/ws-backpressure');
const { createHealthHandlers } = require('./src/health');
const { secureRuntimeData, atomicWriteJson, atomicWriteText, ensurePrivateDir } = require('./src/runtime-security');
const MULTICC_PATHS = createPaths({ dataDir: process.env.MULTICC_DATA_DIR });
const MEMORY_STORE_ROOT = process.env.MULTICC_MEMORY_ROOT || path.join(__dirname, 'memories');
const chatHistoryRepository = createChatHistoryFileRepository({ dataDir: MULTICC_PATHS.root });
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
    multicc_ready: serviceReady && !_shuttingDown && commanderMigrationState.snapshot().ready ? 1 : 0,
  }));
});

let PORT = networkPolicy.port;
const BIND_HOST = networkPolicy.host;
const server = http.createServer(app);

const wss = new WebSocket.Server({ server });
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
  '【等待外部结果，别空等】当你需要「等某个后台任务/部署/接口/第三方返回后再继续」时，不要只在回复里说“我等一下”然后停下——那样这一轮就结束了、不会自动继续。请改用 multicc 的等待接口登记，到点 multicc 会自动把结果作为下一条消息发回给你、你就能接着做：',
  '  ① 轮询（你能用命令/URL 查状态时）：',
  `     curl -s $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/wait -H 'Content-Type: application/json' \\`,
  `       -d '{"mode":"poll","pollCmd":"<查询状态的shell命令>","untilContains":"<出现即视为完成的关键字>","intervalSec":15,"maxChecks":40}'`,
  '     （也可用 "pollUrl" 代替 pollCmd，用 "untilRegex" 代替 untilContains。命令在你的工作目录下执行。）',
  '  ② 回调（由外部系统在完成时主动通知）：',
  `     curl -s $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/wait -H 'Content-Type: application/json' -d '{"mode":"callback"}'`,
  '     返回里的 callbackUrl 交给外部系统，让它在完成时 POST 结果到该 URL（body 放 {"data":"..."}）。',
  '  登记成功后，正常结束本轮即可——条件满足/回调到达时 multicc 会自动续接，无需用户手动催。',
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
  '  ⑤ 对于确实需要跨轮存活的长时间任务（>5 分钟），仍优先用 multicc 的 run-detached 接口或 `<<dispatch>>` 派给独立 session。',
  '',
  '【Monitor 监控必须用 persistent: true】在 multicc chat 会话里调用 Monitor 工具时，persistent 参数必须设为 true，不要用默认的 false。',
  'chat 会话是常驻 streaming 进程、没有单轮超时，Monitor 若用 persistent:false 会被 timeout_ms（默认5分钟/最长1小时）提前杀掉，导致长时间的日志跟踪/事件监听中途断掉。用 persistent:true 让它一直跟到目标出现或会话结束。',
  '注意：persistent:true 的 Monitor 不会自动超时结束，任务达成或不再需要时，务必用 TaskStop 主动停掉它，避免空跑占资源。',
  '',
  '【长任务边做边报进度】（multicc 统一体验约定）当某件事要跑较久（构建/打包/部署/批处理/长等待）时，默认采用「边等边报」：用上面的 run-detached 或轮询保活机制保证任务不丢，运行期间每隔约 25–30 秒主动向用户冒一句简短进度（在做什么、已约 Ns、最新一行关键输出），任务完成后再给最终结果。',
  '不要一启动就长时间静默、让对话框看起来像卡住；也不要只说「我等一下」就停下不续接。这是面向所有 multicc 用户的统一约定，请默认遵循。',
  '',
  '【跨会话协作时的 worktree 同步纪律】每个 chat 会话在自己独立的 git worktree + 分支（multicc/<sessionId>）里干活，基分支通常是 main。多个会话并行改代码时，worktree 之间不会自动一致，必须按下面纪律同步，否则会基于过时代码工作、产生冲突或覆盖别人的改动：',
  '  · 派活方（把任务用 <<dispatch>> 或留言交给兄弟会话前）：先由派活方直接调用目标会话的 sync 接口；成功后在任务指令里说明 sync 已完成及结果，不要要求目标会话启动后再重复 sync。任务仍须要求目标完成后 commit、调用自己的 merge 接口，并报告文件、合并与冲突情况。',
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

const directoryModule = createDirectoryModule({
  repository: { file: DIRECTORIES_FILE, map: _state.directories, store: directoriesStore },
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

function buildGatewayPrompt(userText) {
  const sessionsForPrompt = [...persistedSessions.values()]
    .filter(s => s.type !== 'aux' && s.type !== 'gateway')
    .slice(0, 30)
    .map(s => {
      const activeChat = chatSessions.get(s.id);
      return {
        id: s.id,
        label: s.label || '',
        cli: s.cli || 'claude',
        kind: s.kind || 'terminal',
        cwd: cwdForSession(s),
        active: !!activeChat && (activeChat.clients.size > 0 || activeChat.isStreaming),
      };
    });
  const context = JSON.stringify(sessionsForPrompt);
  return [
    '[MultiCC Gateway system prompt]',
    '你是 MultiCC 的微信 Gateway 会话。所有微信消息都统一进入这个会话。',
    '你负责基于用户消息和可用 session 上下文判断如何回应：可以直接回答、追问澄清，或把任务分发给某个具体 session。',
    '当你判断需要某个 session 来处理任务时，在回复的最后单独输出一行分发标记：',
    '<<dispatch target="真实 session id">要交给该 session 执行的完整、自包含指令</dispatch>>',
    '其中 target 必须逐字使用上面可见 sessions 列表里的某个 id；不要使用 ...、SID、SESSION_ID、<目标会话id> 等占位符。dispatch 内的指令要完整到该 session 无需追问即可执行。',
    '分发不会立即生效——系统会先向用户复述并等待用户回复「确认」后才真正投递，所以你可以在标记前用自然语言说明你打算交给谁、做什么。',
    '只有真的需要某个 session 干活时才输出该标记；纯聊天、答疑、澄清类回复不要输出标记。每条回复最多一个 dispatch 标记。',
    '当用户问 Gateway/Router/会话管理相关问题时，直接以 Gateway 身份回答，不要输出标记。',
    `当前可见 sessions: ${context}`,
    '[Gateway system prompt end]',
    '',
    userText,
  ].join('\n');
}

// ── Gateway dispatch (auto-dispatch v1) ──
// The gateway LLM can emit a <<dispatch target="ID">...</dispatch>> marker; we
// hold it as a pending request, ask the WeChat user to confirm, and only then
// drive the target session via runChatTurn. The target's result is pushed back.
const GATEWAY_ID = '__gateway__';
const DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;   // pending confirmation expires after 10 min
let pendingDispatch = null;                    // { id, targetId, message, createdAt }
const dispatchRuns = new Map();                // hot cache; durable source of truth is orchestrationRuntime
const TERMINAL_DISPATCH_STATUS = new Set(['completed', 'failed', 'interrupted', 'cancelled']);


// Push a server-originated assistant message into the gateway chat. Web clients
// render it; the WeChat bridge (a gateway WS client) forwards it on `result`.
function pushToGateway(text, { persist = true } = {}) {
  if (!text) return;
  if (persist) appendChatMessage(GATEWAY_ID, { role: 'assistant', content: text, ts: Date.now() });
  chatBroadcast(GATEWAY_ID, { type: 'assistant', message: { content: [{ type: 'text', text }] } });
  chatBroadcast(GATEWAY_ID, { type: 'result', total_cost_usd: null });
}

// A dispatch target must be a real, non-system session.
function validateDispatchTarget(targetId, fromSessionId = null, allowCommander = false) {
  const hint = fromSessionId ? `；${dispatchTargetHintFor(fromSessionId)}` : '';
  if (isDispatchPlaceholderTarget(targetId)) {
    return { ok: false, error: `「${targetId}」是占位符，不是真实 session id；请从可用目标 sessions 中选择一个真实 id${hint}` };
  }
  const rec = persistedSessions.get(targetId);
  if (!rec) return { ok: false, error: `目标 session「${targetId}」不存在${hint}` };
  if (rec.type === 'aux' || rec.type === 'gateway') return { ok: false, error: `不能把任务分发给系统会话「${targetId}」` };
  if (rec.type === 'commander' && !allowCommander) return { ok: false, error: `不能把任务分发给指挥官会话「${targetId}」；只有任务面板自动路由可进入指挥队列` };
  return { ok: true, rec };
}

// Remove the raw marker from the most recent persisted gateway assistant message.
function stripMarkerFromGatewayHistory() {
  const hist = loadChatHistory(GATEWAY_ID);
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string' && DISPATCH_RE.test(m.content)) {
      m.content = m.content.replace(DISPATCH_RE, '').replace(/\n{3,}/g, '\n\n').trim();
      try { chatHistoryService.replace(GATEWAY_ID, hist, { reason: 'strip-dispatch-marker' }); }
      catch (error) {
        logger.warn('chat_history_marker_strip_failed', { sessionId: GATEWAY_ID, error: error.message });
      }
    }
    return;   // only inspect the latest assistant message
  }
}

function stripRouteMarkerFromHistory(sessionId) {
  const hist = loadChatHistory(sessionId);
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string' && ROUTE_RE_G.test(m.content)) {
      ROUTE_RE_G.lastIndex = 0;
      m.content = m.content.replace(ROUTE_RE_G, '').replace(/\n{3,}/g, '\n\n').trim();
      try { chatHistoryService.replace(sessionId, hist, { reason: 'strip-route-marker' }); }
      catch (error) {
        logger.warn('chat_history_route_marker_strip_failed', { sessionId, error: error.message });
      }
    }
    ROUTE_RE_G.lastIndex = 0;
    return;   // only inspect the latest assistant message
  }
}

// Called when a gateway turn completes: detect a dispatch marker, stage it as a
// pending request, and ask the user to confirm. Does NOT deliver yet.
function handleGatewayTurnComplete(finalText) {
  const parsed = parseDispatchMarker(finalText);
  if (!parsed) return;
  stripMarkerFromGatewayHistory();
  const v = validateDispatchTarget(parsed.target);
  if (!v.ok) { pushToGateway(`⚠️ 无法分发：${v.error}`); return; }
  pendingDispatch = { id: crypto.randomUUID(), targetId: parsed.target, message: parsed.message, createdAt: Date.now() };
  const label = (v.rec.label && v.rec.label !== parsed.target) ? `${parsed.target}（${v.rec.label}）` : parsed.target;
  const summary = parsed.message.length > 80 ? parsed.message.slice(0, 80) + '…' : parsed.message;
  pushToGateway(`📨 准备把任务投给 ${label}：\n「${summary}」\n回复「确认」执行，回复「取消」放弃。`);
}
// Gateway domain owns this handler; chat emits after a gateway session's own turn.
bus.on('chat:gateway-turn-complete', handleGatewayTurnComplete);

// Intercept gateway inbound messages for confirm/cancel of a pending dispatch.
// Returns true if the message was consumed (caller should NOT run the LLM).
function handleGatewayControl(rawText) {
  if (!pendingDispatch) return false;
  if (Date.now() - pendingDispatch.createdAt > DISPATCH_TIMEOUT_MS) {
    pendingDispatch = null;            // expired → fall through to the LLM
    return false;
  }
  const text = (rawText || '').trim();
  if (DISPATCH_CONFIRM_RE.test(text)) {
    const pd = pendingDispatch; pendingDispatch = null;
    appendChatMessage(GATEWAY_ID, { role: 'user', content: rawText, ts: Date.now() });
    dispatchToSession(pd.targetId, pd.message, { idempotencyKey: `gateway:${pd.id}` })
      .then(r => pushToGateway(r.ok ? `✅ 已投递给 ${pd.targetId}，完成后会把结果发回这里。` : `⚠️ 投递失败：${r.error}`))
      .catch(e => pushToGateway(`⚠️ 投递异常：${e.message}`));
    return true;
  }
  if (DISPATCH_CANCEL_RE.test(text)) {
    pendingDispatch = null;
    appendChatMessage(GATEWAY_ID, { role: 'user', content: rawText, ts: Date.now() });
    pushToGateway('已取消分发。');
    return true;
  }
  return false;   // anything else → let the LLM handle (user may revise/add)
}

// Deliver a confirmed dispatch; terminal targets receive an ephemeral chat.
async function dispatchToSession(targetId, message, opts = {}) {
  let v = validateDispatchTarget(targetId, opts.replyTo || null, opts.allowCommander === true && opts.queueIfBusy === true && opts.requireIdle === false);
  // Create matching *-ultra-NN workers on demand from the dispatcher's config.
  if (!v.ok) {
    const m = targetId.match(/-ultra-(\d{2})$/);
    if (m && opts.replyTo) {
      const dispatcher = persistedSessions.get(opts.replyTo);
      if (dispatcher && normalizeEffort(dispatcher?.effort) === 'ultracode') {
        const dir = directories.get(dispatcher.dirId);
        if (dir) {
          const created = await createSessionRecord({
            dir, cli: dispatcher.cli || 'claude', kind: 'chat',
            label: `⚡ Ultra Worker ${String(parseInt(m[1], 10))}`,
            id: targetId, ephemeral: true,
            model: dispatcher.model || null,
            provider: dispatcher.provider || '',
            effort: 'xhigh',
            rolePrompt: '你是 MultiCC Ultracode worker。只执行派给你的自包含子任务；先同步 worktree，完成后验证、提交并尽量合并回基分支，最后用精简结构汇报改动、验证结果和风险。',
            persistence: 'bestEffort', persistenceSource: 'runtime.dispatch-worker-create',
          });
          if (created.ok) v = validateDispatchTarget(targetId, opts.replyTo || null, opts.allowCommander === true && opts.queueIfBusy === true && opts.requireIdle === false);
        }
      }
    }
  }
  if (!v.ok) return { ok: false, error: v.error };
  const rec = v.rec;

  let chatId;
  if (rec.kind === 'chat') {
    chatId = targetId;
  } else {
    // terminal-only target → create/reuse an ephemeral chat in the same directory.
    const created = await createSessionRecord({
      dir: directories.get(rec.dirId),
      cli: rec.cli || 'claude',
      kind: 'chat',
      label: `${rec.label || targetId} (gw)`,
      id: `${targetId}-gw-chat`,
      ephemeral: true,
      persistence: 'bestEffort', persistenceSource: 'runtime.gateway-chat-create',
    });
    if (!created.ok) return { ok: false, error: `创建临时 chat 失败：${created.error}` };
    chatId = created.id;
  }

  if (opts.requireIdle && taskBoardSessionBusy(chatId)) {
    return { ok: false, error: 'target_busy', code: 'target_busy', chatId };
  }
  const ownerSessionId = opts.ownerSessionId || opts.replyTo || GATEWAY_ID;
  const admitted = await orchestrationRuntime.admitDispatch({
    ownerSessionId,
    resultSessionId: ownerSessionId,
    idempotencyKey: opts.idempotencyKey || null,
    spec: {
      targetId,
      targetLabel: rec.label || '',
      chatId,
      message,
      replyTo: opts.replyTo || null,
      gateway: !opts.replyTo && !opts.oneWay,
      oneWay: !!opts.oneWay,
      ...taskContextHost.dispatchSpec(opts),
    },
  });
  const dispatchId = admitted.id;
  dispatchRuns.set(dispatchId, {
    targetId,
    chatSessionId: chatId,
    replyTo: opts.replyTo || null,
    createdAt: admitted.createdAt,
  });
  // Keep the dispatcher's card waiting while its worker runs.
  if (opts.replyTo && !opts.oneWay && !TERMINAL_DISPATCH_STATUS.has(admitted.status)) {
    addPendingDispatch(opts.replyTo, dispatchId, targetId);
  }
  return {
    ok: true,
    chatId,
    operationId: dispatchId,
    status: admitted.status,
    duplicate: !!admitted.idempotent,
  };
}

// ── Dispatch ↔ currentTask bridge (step 2, idle fix) ──────────────────────────
// When a dispatcher sends work out to a worker and waits for回流, we track the
// pending dispatch on the dispatcher's currentTask so setSessionStatus can keep
// the dispatcher at 'waiting' instead of 'idle'. Best-effort: if the dispatcher
// has no currentTask (e.g. a gateway), these are no-ops.
function addPendingDispatch(dispatcherId, dispatchId, targetId) {
  if (!dispatcherId) return;
  const cs = chatSessions.get(dispatcherId);
  if (!cs || !cs.currentTask) return;
  cs.currentTask.pendingDispatches = cs.currentTask.pendingDispatches || [];
  if (cs.currentTask.pendingDispatches.some(entry => entry.dispatchId === dispatchId)) return;
  cs.currentTask.pendingDispatches.push({ dispatchId, targetId, sentAt: Date.now() });
  // Phase: still working, but now blocked on workers. Surface as waiting.
  if (cs.currentTask.phase !== 'done') cs.currentTask.phase = 'awaiting_workers';
  // Nudge the dispatcher's status to waiting right away (its own turn may have
  // just ended → it would otherwise flicker to idle before the next status tick).
  setSessionStatus(dispatcherId, { status: 'waiting' });
}
function removePendingDispatch(dispatcherId, dispatchId) {
  if (!dispatcherId) return 0;
  const cs = chatSessions.get(dispatcherId);
  if (!cs || !cs.currentTask || !cs.currentTask.pendingDispatches) return 0;
  const before = cs.currentTask.pendingDispatches.length;
  cs.currentTask.pendingDispatches = cs.currentTask.pendingDispatches
    .filter(p => p.dispatchId !== dispatchId);
  const remaining = cs.currentTask.pendingDispatches.length;
  // All workers回流 → phase moves on (next turn will re-classify). Don't touch
  // status here; the incoming回流 turn will drive status naturally.
  if (remaining === 0 && cs.currentTask.phase === 'awaiting_workers') {
    cs.currentTask.phase = 'implementing';
  }
  return before - remaining;
}

// A dispatched turn finished → route its final text back to whoever dispatched
// it: a normal session (the commander) gets it injected as a new turn so it can
// aggregate; a gateway/WeChat dispatch falls back to pushToGateway.
async function finalizeDispatch(dispatchId, sessionName, finalText) {
  const run = dispatchRuns.get(dispatchId);
  dispatchRuns.delete(dispatchId);
  const operation = await orchestrationRuntime.operations.get(dispatchId);
  const targetId = operation?.spec?.targetId || (run ? run.targetId : sessionName);
  const replyTo = operation?.spec?.replyTo || (run && run.replyTo);
  // A worker finished → drop it from the dispatcher's pending list (so the
  // dispatcher's status can leave 'waiting' once all workers回流).
  if (replyTo) removePendingDispatch(replyTo, dispatchId);
  if (operation && TERMINAL_DISPATCH_STATUS.has(operation.status)) return;
  const completed = await orchestrationRuntime.completeDispatch(dispatchId, {
    status: 'completed',
    sessionName,
    text: (finalText || '').trim() || '（本次运行没有产生文本输出）',
  });
  // Compatibility fallback for a dispatch that began before this deployment
  // and therefore has no durable operation record.
  if (!completed.ok && completed.code === 'not_found') {
    const text = (finalText || '').trim() || '（本次运行没有产生文本输出）';
    if (replyTo && persistedSessions.get(replyTo)) {
      waitInjector.safeInject(replyTo, `【${targetId} 回复】\n${text}`);
    } else {
      pushToGateway(`【${targetId} 回复】\n${text}`);
    }
  }
}
// Gateway domain owns this handler; chat emits when a dispatched turn finishes.
bus.on('chat:dispatch-complete', (dispatchId, sessionName, finalText) => {
  finalizeDispatch(dispatchId, sessionName, finalText)
    .catch(error => console.error(`[multicc/dispatch] finalize ${dispatchId} failed: ${error.message}`));
});

// Cross-session dispatch is driven only by structured evidence: a parsed
// <<dispatch>> marker here, or the dispatch HTTP API. Assistant prose is never
// interpreted as routing intent.
function maybeDispatchFromChatTurn(dispatcherId, finalText) {
  const dispatchMarkers = parseAllDispatchMarkers(finalText);
  const routeMarkers = parseAllRouteMarkers(finalText);
  if (!dispatchMarkers.length && !routeMarkers.length) return;
  const from = persistedSessions.get(dispatcherId);
  if (!from) return;
  const deliveries = [];
  const history = loadChatHistory(dispatcherId);
  const sourceMessage = [...history].reverse().find(entry => entry && entry.role === 'assistant');
  const sourceUserMessage = [...history].reverse().find(entry => entry && entry.role === 'user');
  const sourceUserText = String(sourceUserMessage?.content || '');
  const sourceKey = sourceMessage?.id || crypto.createHash('sha256').update(String(finalText || '')).digest('hex').slice(0, 24);

  // <<dispatch>> markers: two-way (worker results flow back to dispatcher)
  for (const [markerIndex, mk] of dispatchMarkers.entries()) {
    if (mk.target === dispatcherId) continue;
    const v = validateDispatchTarget(mk.target, dispatcherId);
    if (!v.ok) { waitInjector.injectSystemMsg(dispatcherId, `⚠️ 无法分发给 ${mk.target}：${v.error}`); continue; }
    if (v.rec.dirId !== from.dirId && from.type !== 'commander') { waitInjector.injectSystemMsg(dispatcherId, `⚠️ 只能分发给同目录会话，已跳过 ${mk.target}`); continue; }
    appendEvent(from.dirId, 'dispatch', `→ ${v.rec.label || mk.target}`, dispatcherId);
    deliveries.push(dispatchToSession(mk.target, mk.message, {
      replyTo: dispatcherId,
      oneWay: false,
      idempotencyKey: `marker:${dispatcherId}:${sourceKey}:${markerIndex}`,
    })
      .then(r => { if (!r.ok) waitInjector.injectSystemMsg(dispatcherId, `⚠️ 分发给 ${mk.target} 失败：${r.error}`); })
      .catch(e => waitInjector.injectSystemMsg(dispatcherId, `⚠️ 分发 ${mk.target} 异常：${e.message}`)));
  }

  deliveries.push(...routeLegacyCommanderMarkers({
    markers: routeMarkers, dispatcherId, from, sourceUserText, sourceKey,
    records: persistedSessions, crypto, isPlaceholder: isDispatchPlaceholderTarget,
    validateTarget: target => validateDispatchTarget(target, dispatcherId),
    appendEvent, dispatch: dispatchToSession,
    inject: text => waitInjector.injectSystemMsg(dispatcherId, text),
  }));

  // Strip <<route>> markers from displayed history (like Gateway strips <<dispatch>>)
  if (routeMarkers.length) stripRouteMarkerFromHistory(dispatcherId);

  return Promise.all(deliveries);
}

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
    await tmuxCreateSession(id, cwd, 80, 24, provider.buildTerminalCmd(launchSession || {}), termEnv);
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
function livenessRolloutPath(rec) {
  try {
    if (!rec || rec.cli !== 'codex' || !rec.cliSessionId) return null;
    const home = rec.provider
      ? path.join(providers.CODEX_HOMES_DIR, rec.provider)
      : path.join(os.homedir(), '.codex');
    const dir = path.join(home, 'sessions');
    if (!fs.existsSync(dir)) return null;
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile() && e.name.includes(rec.cliSessionId) && e.name.endsWith('.jsonl')) return p;
      }
    }
  } catch (_) {}
  return null;
}
const livenessRuntime = createLivenessRuntime({
  records: persistedSessions,
  chatSessions,
  chatStreamStatus: id => { try { return chatStream.status(id); } catch (_) { return null; } },
  probeSession: async (sessionId, sig) => {
    const rec = persistedSessions.get(sessionId);
    const pid = sig && Number.isInteger(sig.pid) ? sig.pid : null;
    return livenessProcessProbe.probe(pid, livenessRolloutPath(rec));
  },
});

const { createProxyBroadcasters } = require('./src/chat/proxy-broadcast');
providerRouterRuntime.mountProtocolProxies(app, {
  protocols: ['claude'],
  onUsageObserved: recordUsageObserved,
  onActivity: e => livenessRuntime.recordProxyActivity(e),
  // Token-level delta + Claude 5h rate-limit sidecars: see src/chat/proxy-broadcast.js.
  ...createProxyBroadcasters(chatBroadcast),
});
app.use(express.json({ limit: '50mb' }));

// Codex Responses↔Chat 协议转换代理（国产服务商 DeepSeek/GLM/Qwen/MiniMax）。
// 必须在 express.json() 之后挂载，以便 req.body 已解析。详见 docs/codex-proxy-contract.md。
providerRouterRuntime.mountProtocolProxies(app, {
  protocols: ['codex'],
  getPort: () => PORT,
  onUsageObserved: recordUsageObserved,
  onActivity: e => livenessRuntime.recordProxyActivity(e),
  ...createProxyBroadcasters(chatBroadcast),
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
app.use(createMemoModule({
  directories: { get: id => directories.get(id) },
  sessions: { get: id => persistedSessions.get(id) },
  runtime: {
    getChatSession: id => chatSessions.get(id),
    runTurn: (id, text, options) => admitChatWork(id, text, options),
  },
}).router);

// Create + persist an isolated session record (its own git worktree + branch).
// Shared creation boundary; an explicit id creates or reuses a named session.
async function createSessionRecord({ dir, cli, kind, label = null, id = null, ephemeral = false, model = null, provider = undefined, effort = null, agent = null, rolePrompt = null, rolePresetId = null, type = null, elasticWorker = false, persistence = 'bestEffort', persistenceSource = 'runtime.create-session' }) {
  if (!dir) return { ok: false, error: 'directory not found' };
  if (!SUPPORTED_CHAT_CLIS.includes(cli)) return { ok: false, error: `cli must be ${SUPPORTED_CHAT_CLIS.join(', ')}` };
  if (!['terminal', 'chat'].includes(kind)) return { ok: false, error: 'kind must be terminal or chat' };
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
    autoDispatch: false,   // default: do NOT inject dispatch context prompt unless user opts in
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
  if (type === 'worker' && elasticWorker) session.elasticWorker = true;
  if (ephemeral) session.ephemeral = true;
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
  effectiveSessionModel,
  effectiveSessionEffort,
  serializeSubagent,
});
const cliSwitchGitSnapshot = cliSwitchRuntime.cliSwitchGitSnapshot;
const consumePendingCliHandoff = cliSwitchRuntime.consumePendingCliHandoff;
cliSwitchRuntime.mountRoutes(app, asyncHandler);

// PATCH a session — supports display-name edits via label.
app.patch('/api/sessions/:id', (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (s.type === 'aux' || s.type === 'gateway') {
    return res.status(400).json({ error: 'system session cannot be renamed' });
  }
  if (req.body.cli !== undefined) {
    return res.status(400).json({
      error: 'cli cannot be changed with PATCH; use POST /api/sessions/:id/switch-cli',
    });
  }
  const mutation = sessionPersistence.begin('http.patch-session');
  const rejectMutation = (status, body) => {
    mutation.rollback();
    return res.status(status).json(body);
  };
  try {
  if (req.body.label !== undefined) {
    const label = (req.body.label || '').toString().trim();
    if (label.length > 80) return rejectMutation(400, { error: 'label too long (max 80)' });
    s.label = label || null;
    appendEvent(s.dirId, 'session_renamed', s.label || s.id, s.id);
  }
  if (req.body.model !== undefined) {
    const model = (req.body.model || '').toString().trim();
    // Allow `/` and `:` for OpenRouter-style ids and provider:model forms.
    if (model && !/^[A-Za-z0-9._:\/\[\]-]{1,100}$/.test(model)) {
      return rejectMutation(400, { error: 'invalid model' });
    }
    s.model = model || null;
    // Non-Claude chat sessions spawn per turn. Claude chat keeps a warm
    // process, so close it now or the UI would report the new model while the
    // next turn still runs on the old one. Terminal sessions still need a
    // manual restart to relaunch their CLI with it.
    if ((s.cli || 'claude') === 'claude' && s.kind === 'chat') chatStream.close(s.id);
    appendEvent(s.dirId, 'session_model_changed', `${s.label || s.id} → ${s.model || '默认'}`, s.id);
  }
  if (req.body.effort !== undefined) {
    const effort = normalizeEffort(req.body.effort);
    if (effort === undefined) return rejectMutation(400, { error: 'invalid effort' });
    if (!validEffortForCli(s.cli || 'claude', effort)) return rejectMutation(400, { error: 'invalid reasoning level' });
    s.effort = effort || null;
    if ((s.cli || 'claude') === 'claude') chatStream.close(s.id);
    appendEvent(s.dirId, 'session_effort_changed', `${s.label || s.id} → ${effectiveSessionEffort(s) || effortLabel(s.effort)}`, s.id);
  }
  if (req.body.agent !== undefined) {
    const agent = normalizeCliAgent(s.cli || 'claude', req.body.agent);
    if (agent === undefined) return rejectMutation(400, { error: 'agent is only supported by Claude/OpenCode and must be a valid agent name' });
    s.agent = agent;
    if ((s.cli || 'claude') === 'claude' && s.kind === 'chat') chatStream.close(s.id);
    appendEvent(s.dirId, 'session_agent_changed', `${s.label || s.id} → ${s.agent || '默认 agent'}`, s.id);
  }
  if (req.body.rolePrompt !== undefined) {
    const rp = (req.body.rolePrompt == null ? '' : String(req.body.rolePrompt));
    if (rp.length > 40000) return rejectMutation(400, { error: 'rolePrompt too long (max 40000)' });
    // null clears the session override → it falls back to the directory default.
    s.rolePrompt = rp.trim() || null;
    if ((s.cli || 'claude') === 'claude' && s.kind === 'chat') chatStream.close(s.id);
    appendEvent(s.dirId, 'session_role_changed', s.rolePrompt ? (s.label || s.id) : `${s.label || s.id}（清除，继承目录）`, s.id);
  }
  if (req.body.memory !== undefined) {
    // Session memory: structured entries (array of {type,text,ts}).
    // Accept both new array format and legacy string (auto-converted).
    const normalized = normalizeManualMemory(req.body.memory);
    if (normalized.error) return rejectMutation(400, { error: normalized.error });
    const { entries } = normalized;
    s.memory = entries;
    appendEvent(s.dirId, 'memory_updated', s.memory ? '手动编辑会话记忆' : '清空会话记忆', s.id);
    workspaceBroadcast(s.dirId, { type: 'memory', sessionId: s.id, memory: s.memory || [] });
  }
  // streaming (流式常驻) is no longer user-configurable: claude chat always runs
  // in persistent-streaming mode. Any legacy `streaming` field in the PATCH body
  // is ignored — the routing guard in runChatTurn keys on cli only.
  if (req.body.autoContinue !== undefined) {
    // autoContinue is no longer user-configurable (the streaming picker dropped
    // this toggle). Accept the field for back-compat with older clients but pin
    // it true. The old auto-drive paths are
    // retired; classify's D/W guards are the safety rails now.
    s.autoContinue = true;
  }
  if (req.body.autoCommit !== undefined) {
    // Auto-commit and merge worktree back to base branch after task completion.
    s.autoCommit = !!req.body.autoCommit;
    appendEvent(s.dirId, 'session_autocommit_changed', `${s.label || s.id} → ${s.autoCommit ? '自动提交合并' : '关闭'}`, s.id);
  }
  if (req.body.autoDispatch !== undefined) {
    // Per-session toggle: inject dispatch context prompt only when explicitly enabled.
    s.autoDispatch = !!req.body.autoDispatch;
    appendEvent(s.dirId, 'session_autodispatch_changed', `${s.label || s.id} → ${s.autoDispatch ? '允许派发' : '禁止派发'}`, s.id);
  }
  if (req.body.provider !== undefined) {
    // Per-session cc-switch provider. '' / null clears the override → default login.
    const v = validProviderId(s.cli || 'claude', (req.body.provider || '').toString().trim());
    if (!v.ok) return rejectMutation(400, { error: 'invalid provider' });
    const prevProvider = s.provider;
    s.provider = v.value;
    // Codex keeps each provider's threads under its own CODEX_HOME
    // (sessions/YYYY/MM/DD/rollout-<ts>-<cliSessionId>.jsonl). Switching provider
    // repoints the next spawn at a different home, so `codex exec resume <id>`
    // would no longer find this session's rollout and silently start a fresh
    // thread. Carry the rollout over to the new home so resume keeps working.
    if (s.cli === 'codex' && s.cliSessionId && prevProvider !== v.value) {
      try {
        const codexHomeFor = (pid) => pid
          ? path.join(providers.CODEX_HOMES_DIR, pid)
          : path.join(os.homedir(), '.codex');
        const srcSessions = path.join(codexHomeFor(prevProvider), 'sessions');
        let srcFile = null;
        if (fs.existsSync(srcSessions)) {
          const walk = (d) => {
            if (srcFile) return;
            let entries;
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
              if (srcFile) return;
              if (e.isDirectory()) walk(path.join(d, e.name));
              else if (e.isFile() && e.name.endsWith(`-${s.cliSessionId}.jsonl`)) srcFile = path.join(d, e.name);
            }
          };
          walk(srcSessions);
        }
        if (srcFile) {
          const dstFile = path.join(codexHomeFor(v.value), 'sessions', path.relative(srcSessions, srcFile));
          if (!fs.existsSync(dstFile)) {
            fs.mkdirSync(path.dirname(dstFile), { recursive: true });
            fs.copyFileSync(srcFile, dstFile);
            console.log(`[multicc/provider] migrated codex rollout ${s.cliSessionId}: ${prevProvider || '默认'} -> ${v.value || '默认'}`);
          }
        }
      } catch (e) {
        console.warn(`[multicc/provider] codex rollout migration failed for ${s.id}:`, e.message);
      }
    }
    // When switching provider the old session.model may hold a model that
    // only works with the previous backend (e.g. claude-opus-4-8 set while
    // on Anthropic Official, then switching to DeepSeek/GLM which don't
    // ship that model). Replace it with the new provider's primary model
    // (or the user's /model default when switching back to the default login)
    // so the card always shows a concrete, correct model name instead of a
    // stale "默认" placeholder. The user can still re-set via /model afterwards.
    const appType = providers.appTypeForCli(s.cli || 'claude');
    if (appType && req.body.model === undefined) {
      s.model = providerDefaultModel(appType, v.value) || null;
    } else if (appType && !providers.modelValidForProvider(appType, v.value, s.model)) {
      // The same PATCH carried a model (the AI-config dialog always submits
      // provider+model together), but the new provider doesn't serve it — a
      // stale value from the previous provider. Replace it with the new
      // provider's primary model instead of letting every subsequent spawn
      // 400/10404 against a model the provider never had.
      const stale = s.model;
      s.model = providerDefaultModel(appType, v.value) || null;
      appendEvent(s.dirId, 'session_model_changed',
        `${s.label || s.id} → ${s.model || '默认'}（${stale} 与新 Provider 不兼容，已自动替换）`, s.id);
    }
    // Chat sessions pick it up on the next per-turn spawn; a warm streaming
    // process must be torn down so it relaunches with the new env.
    if ((s.cli || 'claude') === 'claude') chatStream.close(s.id);
    const pname = appType && v.value ? (providerRouterRuntime.getProviderSummary(appType, v.value)?.name || v.value) : (appType ? '默认登录' : '厂商客户端设置');
    appendEvent(s.dirId, 'session_provider_changed', `${s.label || s.id} → ${pname}`, s.id);
    // Push current classify state to chat so the classify bar updates immediately
    // (otherwise the chat page shows stale / blank until the next classify run).
    try {
      const ts = getTaskState(s);
      if (ts && (ts.goal || ts.classifyState)) {
        chatBroadcast(s.id, { type: 'task_state', goal: ts.goal || '', phase: ts.phase || 'idle', classifyState: ts.classifyState || null });
      }
    } catch (_) {}
  }
  if (req.body.subagent !== undefined) {
    // Per-session subagent provider+model. Claude encodes the route in its model;
    // Codex materializes native default/worker/explorer agent config layers that
    // select a second model_provider. null / '' / {} clears the override.
    const sa = req.body.subagent;
    const cli = s.cli || 'claude';
    const clearing = sa === null || sa === '' || (typeof sa === 'object' && Object.keys(sa).length === 0);
    if (!clearing && cli !== 'claude' && cli !== 'codex') {
      return rejectMutation(400, { error: 'subagent routing is only supported by Claude and Codex' });
    }
    if (clearing) {
      s.subagent = null;
    } else if (typeof sa === 'object') {
      const subApp = (s.cli === 'codex') ? 'codex' : 'claude';
      const v = validProviderId(subApp, (sa.providerId || '').toString().trim());
      if (!v.ok) return rejectMutation(400, { error: 'invalid subagent provider' });
      const model = (sa.model || '').toString().trim();
      if (!model) return rejectMutation(400, { error: 'subagent model required' });
      if (s.cli === 'codex') {
        if (!s.provider) return rejectMutation(400, { error: 'Codex subagent routing requires a selected main provider' });
        if (!providers.codexProviderProxyable(v.value)) {
          return rejectMutation(400, { error: 'Codex subagent provider has no callable HTTP endpoint' });
        }
      }
      s.subagent = { providerId: v.value, model };
    } else {
      return rejectMutation(400, { error: 'invalid subagent' });
    }
    // A warm streaming process must relaunch to pick up CLAUDE_CODE_SUBAGENT_MODEL.
    if ((s.cli || 'claude') === 'claude') chatStream.close(s.id);
    const subApp2 = (s.cli === 'codex') ? 'codex' : 'claude';
    const saName = s.subagent
      ? `${providerRouterRuntime.getProviderSummary(subApp2, s.subagent.providerId)?.name || s.subagent.providerId} / ${s.subagent.model}`
      : '默认(随主)';
    appendEvent(s.dirId, 'session_subagent_changed', `${s.label || s.id} 子任务 → ${saName}`, s.id);
  }
  rememberActiveCliState(s);
  mutation.commit();
  res.json({
    ...s,
    // The full checkpoint can contain recent visible conversation text. Keep
    // it server-side and expose only lifecycle metadata in ordinary responses.
    cliStates: cliStateSummary(s),
    cliAvailability: cliAvailabilitySummary(),
    pendingCliHandoff: cliHandoffSummary(s),
    subagent: serializeSubagent(s.subagent),
    effectiveModel: effectiveSessionModel(s),
    effectiveEffort: effectiveSessionEffort(s),
  });
  } catch (error) {
    mutation.rollback();
    throw error;
  }
});

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

// Delete a single message from this session's persisted chat history.
// Display-history only: the CLI's own transcript/context is not rewritten,
// so the model may still "remember" the content in an ongoing conversation.
// ── Session fork (Happier-parity: branch a session at any message) ──
// Creates a NEW live session that inherits the source's provider/model/effort/
// rolePrompt and replays the transcript up to (and including) the chosen message
// as its starting context — like Happier's forkedTranscriptSnapshot + replaySeed.
// The 50-message rolling window means old messages may already be distilled into
// memory; we therefore also copy the source session's private memory folder so the
// forked session isn't blind to pre-window context. A `forkedFrom` meta record is
// stamped as the first message of the new history.
app.post('/api/sessions/:id/fork', asyncHandler(async (req, res) => {
  const src = persistedSessions.get(req.params.id);
  if (!src) return res.status(404).json({ error: 'session not found' });
  if (src.type === 'aux' || src.type === 'gateway') {
    return res.status(400).json({ error: 'system session cannot be forked' });
  }
  const b = req.body || {};
  const label = (b.label || '').toString().trim() || null;
  const includeMemory = b.includeMemory !== false; // default true
  const atMessageId = b.atMessageId ? String(b.atMessageId) : null;

  // Slice source history up to (and including) the chosen message id.
  // If atMessageId is null/omitted, fork from the latest message.
  const history = loadChatHistory(src.id);
  let sliced;
  if (!atMessageId) {
    sliced = history.map(m => ({ ...m }));
  } else {
    const idx = history.findIndex(m => m && m.id === atMessageId);
    if (idx < 0) return res.status(400).json({ error: 'atMessageId not found in history' });
    sliced = history.slice(0, idx + 1).map(m => ({ ...m }));
  }

  // Create the forked session record, inheriting the source's CLI/provider/model/
  // effort/native-agent/rolePrompt so it continues from the same backend.
  const dir = directories.get(src.dirId);
  const r = await createSessionRecord({
    dir, cli: src.cli, kind: 'chat', label: label || `${src.label || src.id} · fork`,
    provider: src.provider == null ? undefined : src.provider,
    model: src.model, effort: src.effort, agent: src.agent, rolePrompt: src.rolePrompt,
    persistence: 'required', persistenceSource: 'http.fork-session-create',
  });
  if (!r.ok) return res.status(400).json({ error: r.error });
  const newSid = r.id;

  // Seed the new session's chat history with the sliced transcript. The forkedFrom
  // meta message goes first so the agent and UI can see this is a fork.
  const forkMeta = {
    id: newChatMsgId(),
    role: 'system',
    content: `Forked from session \`${src.id}\` (label: ${src.label || '—'}) at message \`${atMessageId || 'latest'}\`. ` +
             `This session continues from that point; prior context above is the replayed transcript, ` +
             `and the source session's distilled memory has been copied into this session's memory folder.`,
    ts: Date.now(),
    forkedFrom: { sessionId: src.id, atMessageId: atMessageId || null, atTs: sliced.length ? sliced[sliced.length - 1].ts : null },
  };
  const newHistory = [forkMeta, ...sliced];
  chatHistoryService.replace(newSid, newHistory, { reason: 'fork' });

  // A fork has a fresh vendor-native session, so copying display history alone
  // is not context continuation. Seed the same one-shot checkpoint mechanism
  // used by cross-CLI switches; it is consumed only after the fork produces a
  // successful result.
  const forkGitSnapshot = await cliSwitchGitSnapshot(r.session);
  const forkCheckpoint = buildHandoffCheckpoint({
    session: src,
    fromCli: src.cli,
    toCli: r.session.cli,
    history: sliced,
    git: forkGitSnapshot,
  });
  sessionPersistence.mutate('http.fork-session-finalize', () => {
    if (src.subagent && src.subagent.providerId && src.subagent.model) {
      r.session.subagent = { providerId: src.subagent.providerId, model: src.subagent.model };
    }
    r.session.pendingCliHandoff = {
      id: `fork_${crypto.randomBytes(8).toString('hex')}`,
      fromCli: src.cli,
      toCli: r.session.cli,
      createdAt: forkCheckpoint.createdAt,
      status: 'pending',
      reusedTarget: false,
      checkpoint: forkCheckpoint,
    };
    rememberActiveCliState(r.session);
  });

  // Copy the source session's private memory folder (CLAUDE.md/AGENTS.md + any
  // notes) so pre-window distilled context survives into the fork. Best-effort.
  if (includeMemory) {
    try {
      const srcMemDir = folderMemory.sessionDir(src);
      const dstMemDir = folderMemory.sessionDir(r.session);
      if (fs.existsSync(srcMemDir)) {
        fs.mkdirSync(dstMemDir, { recursive: true });
        fs.cpSync(srcMemDir, dstMemDir, { recursive: true });
      }
    } catch (e) {
      console.error(`[multicc/fork] memory copy failed ${src.id}→${newSid}:`, e.message);
    }
  }

  appendEvent(src.dirId, 'session_forked', `${src.label || src.id} → ${newSid}`, newSid);
  res.json({
    ok: true,
    sessionId: newSid,
    session: {
      ...r.session,
      cliStates: cliStateSummary(r.session),
      pendingCliHandoff: cliHandoffSummary(r.session),
    },
             forkedFrom: forkMeta.forkedFrom, replayedMessages: sliced.length });
}));

// ── Cross-machine handoff (Happier-parity: move a live session to another machine) ──
// Export an encrypted bundle carrying: session metadata, chat history, the
// session's private memory files, the provider state (env, and for codex the
// auth.json/config.toml files), and a `git bundle` of the session's worktree
// branch. The bundle is AES-256-GCM encrypted with a passphrase-derived key
// (PBKDF2), so it is safe to move over email/syncthing/cloud. The import side
// (POST /api/sessions/import) rebuilds the session on another machine.
//
// Limitation: the target machine must already have (or create) a directory
// backed by the same git repo, so `git fetch` from the bundle can land the
// branch and `git worktree add` can check it out. multicc is single-machine by
// design; this is the file-shuffle equivalent of Happier's direct_peer handoff.
function bundleEncrypt(passphrase, plaintextBuf) {
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(passphrase, salt, 200000, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { salt: salt.toString('base64'), iv: iv.toString('base64'),
           ct: ct.toString('base64'), tag: tag.toString('base64') };
}

function bundleDecrypt(passphrase, enc) {
  const salt = Buffer.from(enc.salt, 'base64');
  const key = crypto.pbkdf2Sync(passphrase, salt, 200000, 32, 'sha256');
  const iv = Buffer.from(enc.iv, 'base64');
  const tag = Buffer.from(enc.tag, 'base64');
  const ct = Buffer.from(enc.ct, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

app.get('/api/sessions/:id/bundle', asyncHandler(async (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (s.type === 'aux' || s.type === 'gateway') {
    return res.status(400).json({ error: 'system session cannot be bundled' });
  }
  const passphrase = req.query.passphrase;
  if (!passphrase || passphrase.length < 6) {
    return res.status(400).json({ error: 'passphrase required (≥6 chars) — use ?passphrase=...' });
  }
  try {
    // 1) Messages + memory files.
    const messages = loadChatHistory(s.id);
    const memoryFiles = {};
    try {
      const memDir = folderMemory.sessionDir(s);
      if (fs.existsSync(memDir)) {
        for (const entry of fs.readdirSync(memDir, { withFileTypes: true })) {
          if (entry.isFile()) {
            const rel = entry.name;
            const abs = path.join(memDir, entry.name);
            memoryFiles[rel] = fs.readFileSync(abs, 'utf8');
          }
        }
      }
    } catch (e) { /* best-effort */ }

    // 2) Provider state: env (claude ANTHROPIC_*, codex CODEX_HOME pointer)
    //    plus, for codex, the auth.json/config.toml file contents so the
    //    target machine can reconstruct the codex home.
    const provEnv = providerRouterRuntime.resolveSpawnEnv(s);
    const providerState = {
      providerId: s.provider, providerName: provEnv.providerName,
      env: provEnv.env || {}, codexFiles: {},
    };
    if (s.cli === 'codex' && s.provider) {
      try {
        const home = path.join(providers.CODEX_HOMES_DIR, s.provider);
        if (fs.existsSync(home)) {
          for (const fn of ['auth.json', 'config.toml']) {
            const fp = path.join(home, fn);
            if (fs.existsSync(fp)) {
              providerState.codexFiles[fn] = fs.readFileSync(fp, 'utf8');
            }
          }
        }
      } catch (e) { /* best-effort */ }
    }

    // 3) git bundle of the session's worktree branch — but ONLY the commits
    //    unique to this session (baseBranch..branch). Bundling the full branch
    //    history would pull in the entire main lineage (100MB+ for a mature
    //    repo) and OOM the process when base64'd into the JSON payload. If the
    //    session has no unique commits (already merged back), there is nothing
    //    to carry — the target machine's main already has the work.
    let gitBundleB64 = null;
    let gitBundleNote = null;
    const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;  // 100MB hard cap
    try {
      if (s.worktreePath && s.branch && fs.existsSync(s.worktreePath)) {
        const dir = directories.get(s.dirId);
        if (!dir) {
          gitBundleNote = 'directory metadata missing — bundle has no git payload';
        } else {
          const tmp = path.join(os.tmpdir(), `multicc-bundle-${s.id}-${Date.now()}.bundle`);
          const result = await gitExportSessionBundle(dir, s, tmp, MAX_BUNDLE_BYTES);
          if (result.unique === 0) {
            gitBundleNote = `no unique commits vs ${result.baseBranch} (already merged) — target's main has the work; no git payload needed`;
          } else if (result.tooLarge) {
            gitBundleNote = `git bundle too large (${(result.size/1024/1024).toFixed(1)}MB > ${MAX_BUNDLE_BYTES/1024/1024}MB cap) — skipped; merge excess back to base first`;
          } else if (result.bundlePath) {
            try {
              gitBundleB64 = (await fs.promises.readFile(result.bundlePath)).toString('base64');
              gitBundleNote = `${result.unique} unique commits, ${(result.size/1024).toFixed(0)}KB bundle`;
            } finally {
              await fs.promises.rm(result.bundlePath, { force: true });
            }
          }
        }
      } else {
        gitBundleNote = 'no worktree/branch on disk — bundle has no git payload';
      }
    } catch (e) {
      gitBundleNote = 'git bundle failed: ' + e.message;
    }

    // 4) Assemble + encrypt.
    const payload = {
      v: 1, exportedAt: new Date().toISOString(),
      sessionMeta: {
        id: s.id, cli: s.cli, kind: s.kind, label: s.label,
        model: s.model, effort: s.effort, agent: s.agent || null, rolePrompt: s.rolePrompt || null,
        branch: s.branch, worktreePath: s.worktreePath, dirId: s.dirId,
        // dirId/branch/worktreePath are hints; target rebuilds its own paths.
      },
      messages, memoryFiles, providerState, gitBundleB64, gitBundleNote,
    };
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const enc = bundleEncrypt(String(passphrase), plaintext);
    appendEvent(s.dirId, 'session_bundled', `${s.label || s.id} → export`, s.id);
    res.json({
      ok: true, ...enc,
      meta: { v: 1, sessionId: s.id, label: s.label, messages: messages.length,
              hasGitBundle: !!gitBundleB64, hasMemory: Object.keys(memoryFiles).length,
              note: gitBundleNote },
    });
  } catch (e) {
    res.status(500).json({ error: 'bundle failed: ' + e.message });
  }
}));

// Import an encrypted bundle produced by GET /api/sessions/:id/bundle and
// rebuild the session on THIS machine. The target directory (dirId) must be a
// git repo (we recreate the worktree from the bundle's git payload). Provider
// credentials are NOT auto-injected: pass targetProviderId to attach the new
// session to an already-configured provider on this machine, or omit to use the
// default login. The bundle's provider env/codex files are kept in the session's
// memory folder as `.handoff-provider.json` for reference/manual setup.
app.post('/api/sessions/import', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { salt, iv, ct, tag } = b;
  const passphrase = b.passphrase;
  const dirId = b.dirId;
  const targetProviderId = b.targetProviderId || undefined;
  const labelOverride = (b.label || '').toString().trim() || null;
  if (!salt || !iv || !ct || !tag) return res.status(400).json({ error: 'missing bundle fields (salt/iv/ct/tag)' });
  if (!passphrase) return res.status(400).json({ error: 'passphrase required' });
  const dir = directories.get(dirId);
  if (!dir) return res.status(404).json({ error: 'target directory not found' });

  let payload;
  try {
    const plaintext = bundleDecrypt(String(passphrase), { salt, iv, ct, tag });
    payload = JSON.parse(plaintext.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'decrypt failed (wrong passphrase or corrupt bundle): ' + e.message });
  }
  if (!payload || payload.v !== 1 || !payload.sessionMeta) {
    return res.status(400).json({ error: 'unsupported bundle version' });
  }
  const meta = payload.sessionMeta;

  // Create the session record — this also creates a fresh empty worktree from
  // the dir's base branch. We then overlay the bundle's git content onto it.
  const r = await createSessionRecord({
    dir, cli: meta.cli, kind: 'chat',
    label: labelOverride || (meta.label ? `${meta.label} · imported` : null),
    provider: targetProviderId === undefined ? undefined : (targetProviderId || ''),
    model: meta.model, effort: meta.effort, agent: meta.agent, rolePrompt: meta.rolePrompt,
    persistence: 'required', persistenceSource: 'http.bundle-import-create',
  });
  if (!r.ok) return res.status(400).json({ error: r.error });
  const newSid = r.id;
  const newSession = r.session;

  try {
    // 1) Restore chat history.
    if (Array.isArray(payload.messages)) {
      chatHistoryService.replace(newSid, payload.messages, { reason: 'bundle-import' });
    }

    // 2) Restore memory files.
    if (payload.memoryFiles && typeof payload.memoryFiles === 'object') {
      const memDir = folderMemory.sessionDir(newSession);
      fs.mkdirSync(memDir, { recursive: true });
      for (const [rel, content] of Object.entries(payload.memoryFiles)) {
        const safe = String(rel).replace(/[^A-Za-z0-9._-]/g, '_');
        if (!safe || safe === '.' || safe === '..') continue;
        fs.writeFileSync(path.join(memDir, safe), content, 'utf8');
      }
      // Stash the source provider state for reference (creds the user must wire
      // up on this machine — never auto-injected into the provider pool).
      try {
        fs.writeFileSync(path.join(memDir, '.handoff-provider.json'),
          JSON.stringify({ sourceProviderId: meta.providerId || null,
                           sourceProviderName: payload.providerState?.providerName || null,
                           env: payload.providerState?.env || {},
                           codexFiles: payload.providerState?.codexFiles || {} }, null, 2),
          'utf8');
      } catch (_) {}
    }

    // 3) Replay the bundle's unique commits onto the freshly-created worktree.
    //    The Git adapter holds one RepoActor lease for fetch + replay, aborts
    //    conflicts, and always deletes its temporary ref. Linear histories use
    //    cherry-pick; histories containing merges preserve their topology.
    let gitRestored = false, gitNote = null;
    if (payload.gitBundleB64 && newSession.worktreePath && newSession.branch) {
      const tmpBundle = path.join(os.tmpdir(), `multicc-import-${newSid}-${Date.now()}.bundle`);
      try {
        await fs.promises.writeFile(tmpBundle, Buffer.from(payload.gitBundleB64, 'base64'));
        const srcBranch = meta.branch || `multicc/${meta.id}`;
        const result = await gitImportSessionBundle(dir, newSession, tmpBundle, srcBranch);
        gitRestored = !!result.restored;
        if (!result.ok) gitNote = 'git restore failed: ' + (result.error || 'unknown error');
        else if (!result.restored) gitNote = result.note || 'bundle contained no new commits';
      } catch (e) {
        gitNote = 'git restore failed: ' + e.message;
      } finally {
        await fs.promises.rm(tmpBundle, { force: true }).catch(() => {});
      }
    } else {
      gitNote = payload.gitBundleNote || 'no git payload in bundle';
    }

    appendEvent(dir.id, 'session_imported', `${newSid} ← bundle`, newSid);
    res.json({ ok: true, sessionId: newSid, session: newSession,
               restored: { messages: Array.isArray(payload.messages) ? payload.messages.length : 0,
                           memoryFiles: payload.memoryFiles ? Object.keys(payload.memoryFiles).length : 0,
                           gitRestored, gitNote } });
  } catch (e) {
    res.status(500).json({ error: 'import failed (session record created): ' + e.message, sessionId: newSid });
  }
}));

sessionGitRuntime.mountRoutes(app);

app.delete('/api/sessions/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const session = sessions.get(id);
  const chat = chatSessions.get(id);
  const persisted = persistedSessions.get(id);
  if (!session && !chat && !persisted) {
    return res.status(404).json({ error: 'Session not found' });
  }
  const force = req.query.force === '1' || req.body?.force === true;
  // Commander is the fleet's dispatcher — it can only be removed by deleting its
  // whole directory (which cascades through destroySessionCascade), never on its
  // own. Guard here on the single-session route only, unconditional of force.
  if (persisted?.type === 'commander') {
    return res.status(400).json({ error: 'commander 会话不可单独删除，只能随其所属 fleet 一起删除' });
  }
  if (persisted) {
    const dir = directories.get(persisted.dirId);
    if (!dir) return res.status(404).json({ error: 'directory not found' });
    const result = await destroySessionCascade(persisted, dir, { force, removeRecord: false });
    if (!result.ok) return res.status(409).json(result);
    sessionPersistence.mutate('http.delete-session', records => records.delete(id));
    appendEvent(persisted.dirId, 'session_deleted', persisted.label || persisted.id, null);
    return res.json({ ...result, forced: force });
  } else {
    if (session) { await tmuxKillSession(id); for (const client of session.clients || []) try { client.terminate(); } catch (_) {} }
    if (chat) { if (chat.claudeProc) try { chat.claudeProc.kill('SIGTERM'); } catch (_) {} chatStream.close(id); for (const client of chat.clients || []) try { client.terminate(); } catch (_) {} }
    sessions.delete(id);
    chatSessions.delete(id);
  }
  res.json({ ok: true, forced: force });
}));

// Relocate: moves a session to a different directory. Caller passes the target dirId.
// (Old "change cwd" semantics are gone — cwd lives on the directory now.)
app.post('/api/sessions/:id/relocate', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const targetDirId = (req.body.dirId || '').trim();
  if (!targetDirId) return res.status(400).json({ error: 'dirId required (cwd is now owned by the directory)' });
  const targetDir = directories.get(targetDirId);
  if (!targetDir) return res.status(404).json({ error: 'target directory not found' });
  const persisted = persistedSessions.get(id);
  if (!persisted) return res.status(404).json({ error: 'session not found' });
  if (persisted.dirId === targetDirId) return res.json({ ok: true, unchanged: true, cwd: targetDir.path });
  if (!fs.existsSync(targetDir.path)) return res.status(400).json({ error: `directory path missing on disk: ${targetDir.path}` });
  const force = req.query.force === '1' || req.body.force === true;
  const activeTerminal = sessions.get(id);
  const activeChat = chatSessions.get(id);
  const active = !!activeTerminal || !!(activeChat && (activeChat.claudeProc || activeChat.isStreaming || activeChat.clients?.size));
  if (active && !force) {
    return res.status(409).json({ ok: false, blocked: true, reasons: ['active'], error: 'active session cannot be relocated' });
  }

  // The session's worktree belongs to the OLD directory's repo — relocate means
  // a fresh worktree in the target directory.
  const oldDir = directories.get(persisted.dirId);
  const readyTarget = await ensureDirGitReady(targetDir);
  if (!readyTarget.ok) {
    return res.status(400).json({ error: `目标目录 git 未就绪: ${readyTarget.reason}` });
  }

  const oldSession = sessions.get(id);
  const relocated = await gitRelocateWorktree(oldDir, targetDir, persisted, {
    force, active,
    activeCheck: force ? null : () => sessionGitRuntime.isWorktreeActive(id),
    beforeRemove: async () => {
      if (oldSession) {
        broadcastTo(oldSession.clients, { type: 'relocate', cwd: targetDir.path });
        await stopOutputCapture(oldSession);
        await tmuxKillSession(oldSession.id);
        sessions.delete(id);
      }
      if (activeChat && force) {
        assignKillReason(activeChat._activeRunner, 'relocate');
        if (activeChat.claudeProc) try { activeChat.claudeProc.kill('SIGTERM'); } catch (_) {}
        chatStream.close(id);
        chatSessions.delete(id);
      }
    },
  });
  if (!relocated.ok) return res.status(relocated.blocked ? 409 : 500).json(relocated);

  sessionPersistence.mutate('http.relocate-session', () => {
    persisted.worktreePath = relocated.worktreePath;
    persisted.branch = relocated.branch;
    persisted.dirId = targetDirId;
    // Clear cliSessionId so the new instance starts fresh in the new directory.
    persisted.cliSessionId = null;
  });
  invalidSessions.delete(id);

  if (persisted.kind === 'terminal') {
    try {
      await createSession(id);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  res.json({ ok: true, cwd: targetDir.path, forced: force,
    operationId: relocated.operationId,
    queueDepth: relocated.queueDepth,
    backup: relocated.backup || null });
}));

// ── Restart session (kill tmux + respawn CLI in same directory, fresh conversation) ──
app.post('/api/sessions/:id/restart', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const oldSession = sessions.get(id);
  const persisted = persistedSessions.get(id);
  if (!oldSession && !persisted) return res.status(404).json({ error: 'Session not found' });
  if (persisted && persisted.kind && persisted.kind !== 'terminal') {
    return res.status(400).json({ error: 'restart only applies to terminal sessions' });
  }

  const cwd = cwdForSession(persisted);
  const oldClients = oldSession ? [...oldSession.clients] : [];

  sessions.delete(id);
  if (oldSession) {
    await stopOutputCapture(oldSession);
    if (oldSession.exitCheckTimer) clearInterval(oldSession.exitCheckTimer);
    if (oldSession.captureTimer) clearInterval(oldSession.captureTimer);
    cleanupPushMonitor(id);
    oldSession.clients.clear();
  }
  await tmuxKillSession(id);

  // Clear cliSessionId so a brand-new conversation starts (claude allocates a fresh UUID,
  // codex generates a fresh thread on first turn). The worktree is kept across restarts;
  // only recreate it if it has gone missing.
  if (persisted) {
    let nextWorktreePath = persisted.worktreePath;
    let nextBranch = persisted.branch;
    const dir = directories.get(persisted.dirId);
    if (dir && (!persisted.worktreePath || !fs.existsSync(persisted.worktreePath))) {
      const ready = await ensureDirGitReady(dir);
      if (ready.ok) {
        try {
          const { worktreePath, branch } = await gitWorktreeAdd(dir.path, id, dir.baseBranch);
          nextWorktreePath = worktreePath;
          nextBranch = branch;
        } catch (e) {
          console.warn(`[multicc] restart: worktree recreate failed for ${id}: ${e.message}`);
        }
      }
    }
    sessionPersistence.mutate('http.restart-session', () => {
      persisted.cliSessionId = null;
      persisted.worktreePath = nextWorktreePath;
      persisted.branch = nextBranch;
    });
  }

  try {
    await createSession(id);
    console.log(`[multicc] Session ${id} restarted in ${cwd}`);
    broadcastTo(oldClients, { type: 'restart' });
    res.json({ ok: true, cwd });
  } catch (err) {
    console.error('[multicc] Restart failed:', err);
    res.status(500).json({ error: err.message });
  }
}));

// ── Restart the whole multicc server (graceful) ──
// A detached child re-launches us after we exit. Auth-gated (deliberately NOT
// in the bypass allowlist at the top of this file), so shared view/operate
// viewers cannot reach it. The child runs `/bin/bash ./multicc restart`, whose do_stop
// sends SIGINT → gracefulShutdown (drains in-flight turns + flushes partial
// chats) before do_start brings up a fresh instance. Calling bash explicitly
// keeps source/archive installs working when the manager script lacks +x.
// Debounce flag distinct from _shuttingDown: gracefulShutdown short-circuits on
// _shuttingDown, so reusing it here would abort the very shutdown we want. Once
// a restart is scheduled we never reset it — the process is about to be replaced.
let _restartScheduled = false;
let _restartScheduledAt = 0;
const RESTART_FLAG_TTL_MS = 30000;
app.post('/api/restart', (req, res) => {
  // Safety net: detached `/bin/bash ./multicc restart` should replace us within ~2s. If
  // we're still alive after RESTART_FLAG_TTL_MS the replacement failed (stale
  // pidfile / multiple node server.js survivors — do_stop missed the live PID),
  // so reset the flag instead of 409-ing "already in progress" forever.
  if (_restartScheduled && Date.now() - _restartScheduledAt > RESTART_FLAG_TTL_MS) {
    console.log('[multicc] /api/restart: previous restart did not replace this process after ' +
      Math.round((Date.now() - _restartScheduledAt) / 1000) + 's — resetting flag to allow retry');
    _restartScheduled = false;
  }
  if (_shuttingDown || _restartScheduled) return res.status(409).json({ error: 'restart already in progress' });
  _restartScheduled = true;
  _restartScheduledAt = Date.now();
  // Count sessions with a genuinely in-flight streaming turn (not a stale one)
  // so the client can warn the user those turns will be interrupted — their
  // partial output is flushed to disk by gracefulShutdown before exit.
  let activeStreaming = 0;
  for (const cs of chatSessions.values()) {
    if (cs && cs.isStreaming && (Date.now() - (cs.lastStreamAt || 0)) < 600000) activeStreaming++;
  }
  // Start the detached sleeper before acknowledging the request. The manager
  // and bash preflight plus synchronous spawn must succeed; its two-second
  // delay still gives this response time to flush before it signals us.
  const scheduledAt = _restartScheduledAt;
  try {
    scheduleDetachedRestart({
      spawn,
      rootDir: __dirname,
      env: process.env,
      log: console,
      onFailure: (error) => {
        // An old detached attempt must never clear a newer attempt's debounce.
        // If shutdown already began there is no live API process to retry.
        if (!_shuttingDown && _restartScheduledAt === scheduledAt) {
          _restartScheduled = false;
          _restartScheduledAt = 0;
          console.error('[multicc] /api/restart: scheduling state reset after child failure',
            error && error.code);
        }
      },
    });
  } catch (error) {
    if (_restartScheduledAt === scheduledAt) {
      _restartScheduled = false;
      _restartScheduledAt = 0;
    }
    console.error('[multicc] /api/restart: could not schedule restart', error && error.message);
    const code = error && /^RESTART_[A-Z_]+$/.test(error.code || '')
      ? error.code
      : 'RESTART_SCHEDULE_FAILED';
    return res.status(503).json({
      error: 'restart could not be scheduled',
      code,
      requestId: req.id,
    });
  }

  return res.status(202).json({ ok: true, status: 'scheduled', activeStreaming });
});

// ── Inter-agent notes ──
app.post('/api/sessions/:id/notes', (req, res) => {
  const from = persistedSessions.get(req.params.id);
  if (!from) return res.status(404).json({ error: 'session not found' });
  const toId = (req.body.toSessionId || '').trim();
  const body = (req.body.body || '').trim();
  if (!toId || !body) return res.status(400).json({ error: 'toSessionId 和 body 必填' });
  const to = persistedSessions.get(toId);
  if (!to) return res.status(404).json({ error: 'target session not found' });
  if (to.dirId !== from.dirId) return res.status(400).json({ error: '只能给同一目录下的会话留言' });

  const note = {
    id: crypto.randomUUID(), dirId: from.dirId,
    fromSessionId: from.id, fromLabel: from.label || from.id,
    toSessionId: to.id, body: body.slice(0, 4000),
    ts: Date.now(), delivered: false, deliveredAt: null,
  };
  notes.push(note);
  saveNotes();
  appendEvent(from.dirId, 'note', `→ ${to.label || to.id}`, from.id);
  workspaceBroadcast(from.dirId, { type: 'note_pending', sessionId: to.id, count: pendingNotesFor(to.id).length });
  res.json(note);
});

// Session liveness: working (producing / awaiting model) vs idle vs stalled.
// ?probe=0 skips the process-level lsof/rollout check for a cheap event-only read.
app.get('/api/sessions/:id/liveness', asyncHandler(async (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const wantProbe = req.query.probe !== '0';
  const v = await livenessRuntime.assess(req.params.id, { probe: wantProbe });
  res.json(v);
}));

// Inbox + outbox for a session.
app.get('/api/sessions/:id/notes', (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  res.json(notes.filter(n => n.toSessionId === s.id || n.fromSessionId === s.id));
});

// Curl-friendly dispatch: same semantics as the <<dispatch>> reply marker, but
// callable mid-turn. Every other multicc capability (wait/run-detached/notes)
// is reachable via curl, so models — third-party ones especially — habitually
// reach for curl; without this door they "dispatch" into run-detached and the
// ultra workers never hear about it. Result flows back automatically as a
// 【target 回复】message via finalizeDispatch.
async function executeDispatchContract(fromId, body, options = {}) {
  const from = persistedSessions.get(fromId);
  if (!from) return { status: 404, error: 'session not found', code: 'session_not_found' };
  const target = String((body && body.target) || '').trim();
  const message = String((body && body.message) || '').trim();
  if (!target || !message) return { status: 400, error: 'target 和 message 必填', code: 'invalid_dispatch' };
  if (target === from.id) return { status: 400, error: '不能把任务分发给自己', code: 'self_dispatch' };
  const validation = validateDispatchTarget(target, from.id);
  if (!validation.ok) return { status: 400, error: validation.error, code: 'invalid_target' };
  if (validation.rec.dirId !== from.dirId) return { status: 400, error: '只能分发给同目录会话', code: 'cross_directory' };
  appendEvent(from.dirId, 'dispatch', `→ ${validation.rec.label || target}`, from.id);
  try {
    const result = await dispatchToSession(target, message, {
      replyTo: from.id,
      idempotencyKey: options.idempotencyKey || null,
    });
    if (!result.ok) return { status: 409, error: result.error, code: 'dispatch_rejected' };
    return {
      status: 200,
      value: {
        ...toDispatchResultDto({
        ok: true,
        target,
        chatId: result.chatId,
        note: '任务已投递；完成后结果会以【回复】消息自动回流到本会话',
        }),
        operationId: result.operationId,
        status: result.status,
      },
    };
  } catch (error) {
    logger.error('dispatch_failed', { fromId, target, error: error && error.message });
    if (error && error.statusCode === 409) {
      return { status: 409, error: error.message, code: 'dispatch_conflict' };
    }
    return { status: 500, error: 'internal_error', code: 'internal_error' };
  }
}

function sendDispatchContract(req, res, result) {
  const context = requestContext(req, res);
  if (result.status === 200) {
    const dto = withApiMeta(result.value, context);
    // /api/v1 remains byte/schema compatible. The unversioned endpoint gains
    // durable-operation metadata without changing the published v1 schema.
    if (req.path.startsWith('/api/v1/')) {
      delete dto.operationId;
      delete dto.status;
    }
    return res.json(dto);
  }
  return res.status(result.status).json(createErrorDto({
    ...context,
    message: result.error,
    code: result.code,
  }));
}

function dispatchContractHandler(req, res) {
  executeDispatchContract(req.params.id, req.body, {
    idempotencyKey: req.get('Idempotency-Key') || null,
  })
    .then(result => sendDispatchContract(req, res, result))
    .catch(error => {
      logger.error('dispatch_contract_failed', { sessionId: req.params.id, error: error && error.message });
      sendDispatchContract(req, res, { status: 500, error: 'internal_error', code: 'internal_error' });
    });
}

app.post('/api/sessions/:id/dispatch', dispatchContractHandler);
app.post('/api/v1/sessions/:id/dispatch', dispatchContractHandler);

// Directory event log.
app.get('/api/directories/:id/events', (req, res) => {
  const d = directories.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'directory not found' });
  res.json({ events: recentEvents(d.id) });
});

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

// ── Voice settings API ──
const ENV_PATH = path.join(__dirname, '.env');

function readEnvFile() {
  const vars = {};
  try {
    fs.readFileSync(ENV_PATH, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (m) vars[m[1]] = m[2];
    });
  } catch (_) {}
  return vars;
}

function writeEnvFile(updates) {
  let lines = [];
  try { lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n'); } catch (_) {}
  const written = new Set();
  lines = lines.map(line => {
    const m = line.match(/^\s*([^#=]+?)\s*=/);
    if (m && updates.hasOwnProperty(m[1])) {
      written.add(m[1]);
      if (updates[m[1]] == null) return '';
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  }).filter(l => l.trim() !== '');
  for (const [k, v] of Object.entries(updates)) {
    if (!written.has(k) && v != null) lines.push(`${k}=${v}`);
  }
  let parentMode = 0o755;
  try { parentMode = fs.statSync(path.dirname(ENV_PATH)).mode & 0o777; } catch (_) {}
  atomicWriteText(ENV_PATH, lines.join('\n') + '\n', { dirMode: parentMode });
}

// DEFAULT_CLI belonged to the removed Aux CLI fallback. Migrate persisted
// installations as well as the in-memory environment to the protocol config.
if (readEnvFile().DEFAULT_CLI !== undefined) writeEnvFile({ DEFAULT_CLI: null });
delete process.env.DEFAULT_CLI;

// Voice REST/settings endpoints are isolated from the host composition. The Aux
// queue is resolved lazily because it is initialized later during startup.
mountVoiceRoutes(app, {
  uploadVoice: upload.voice,
  voice: require('./src/voice'),
  asrLocal: require('./src/asr-local'),
  voiceAsr,
  ttsService,
  readEnvFile,
  writeEnvFile,
  getAuxQueue: () => auxQueue,
  reportFailure: (stage, category) => reportHostControlFailure('voice_settings', stage, category),
});

// ── Web Push (PWA notifications) ──
// VAPID key management: auto-generate and persist in .env
function ensureVapidKeys() {
  let pubKey = process.env.VAPID_PUBLIC_KEY;
  let privKey = process.env.VAPID_PRIVATE_KEY;
  if (pubKey && privKey) return { pubKey, privKey };

  console.log('[multicc/push] Generating VAPID keys...');
  const keys = webpush.generateVAPIDKeys();
  pubKey = keys.publicKey;
  privKey = keys.privateKey;

  // Persist to .env
  const updates = { VAPID_PUBLIC_KEY: pubKey, VAPID_PRIVATE_KEY: privKey };
  writeEnvFile(updates);
  process.env.VAPID_PUBLIC_KEY = pubKey;
  process.env.VAPID_PRIVATE_KEY = privKey;
  console.log('[multicc/push] VAPID keys generated and saved to .env');
  return { pubKey, privKey };
}

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
let apiErrorAuxQueue = null;
const apiErrorHost = createApiErrorHost({
  policy: apiErrorPolicy, logger, persistedSessions, getTaskState, setTaskState,
  chatBroadcast, workspaceBroadcast, waitInjector,
  getAuxQueue: () => apiErrorAuxQueue,
  setSessionStatus, isShuttingDown: () => _shuttingDown,
  clearIncrementalSave: sessionId => chatHistoryRuntime?.clearIncrementalSave(sessionId),
  isCurrentTurnRunner: (...args) => isCurrentTurnRunner(...args),
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
  logger: console,
});
const {
  distillHistoryIntoMemory,
  getPendingDistill: getPendingMemoryDistill,
  maybeSchedulePeriodicMemoryReview,
  trackPendingDistill: _trackPendingMemoryDistill,
} = memoryRuntime;

function taskBoardSessionBusy(sid) {
  const prep = chatTurnPreparationRuntime.snapshot(sid);
  return prep.phase !== 'idle' || !!chatSessions.get(sid)?.isStreaming || orchestrationChatBusy(sid) || !!defaultRepoActor.isLeased(sid);
}
const commanderRouter = createCommanderRoutingHost({
  records: persistedSessions, directories, isBusy: taskBoardSessionBusy,
  sessionPersistence, createSessionRecord, dispatchToSession,
  maxElasticWorkers: process.env.MULTICC_COMMANDER_MAX_ELASTIC_WORKERS, logger,
});
const taskBoardRuntime = createTaskBoardRuntime({
  file: MULTICC_PATHS.taskBoardFile,
  auxQueue,
  records: persistedSessions,
  loadHistory: sessionId => loadChatHistory(sessionId),
  dispatchToSession,
  routeCommanderTask: commanderRouter.route, sendSessionMessage: (...args) => taskContextHost.deliverSessionMessage(...args),
  workspaceBroadcast: (dirId, payload) => workspaceBroadcast(dirId, payload),
  atomicWriteJson,
  isSystemInjected: msg => isSystemInjectedMsg(msg),
  isSessionBusy: taskBoardSessionBusy,
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
  runTurn: (sessionId, text, options) => admitChatWork(sessionId, text, options),
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

// Token APIs remain between the two Provider route phases so the established
// route ordering stays byte-compatible while accounting lives in one runtime.
tokenUsageRuntime.mountRoutes(app);

providerRoutes.mountManagementRoutes(app);

// Root → manage page (unless ?id= is specified, which means a terminal session)
app.get('/', (req, res, next) => {
  if (req.query.id === '__aux__') {
    const params = new URLSearchParams();
    params.set('focus', 'aux');
    res.redirect(`/manage.html?${params.toString()}`);
    return;
  }
  if (req.query.id || req.query.newid || req.query.cwd) return next(); // terminal session
  res.redirect('/manage');
});

// Temp artifacts produced by the multicc-artifact skill (served from
// ~/.multicc/artifacts). Mounted before the public static handler so /artifacts
// is claimed first; auth is bypassed via the capability <id> (see middleware).
artifacts.mount(app);

// Cache-busting for embedded WebViews: rewrite local <script src="x.js"> /
// <link href="x.css"> in served HTML to "x.js?v=<mtime>", and send the HTML
// itself with no-store. Many embedded WebViews ignore Cache-Control on static
// assets and keep a stale copy; they still re-fetch when the asset URL changes,
// so appending the file's mtime as a query makes every frontend edit show up on
// the next page load without users having to clear cache manually.
const _publicDir = path.join(__dirname, 'public');
function _serveVersionedHtml(absPath, res) {
  fs.readFile(absPath, 'utf8', (err, html) => {
    if (err) { res.status(500).end(); return; }
    const out = html.replace(
      /((?:src|href)\s*=\s*["'])(?!https?:)(?!\/\/)([^"'?#]+\.)(js|css)(["'])/gi,
      (m, pre, name, ext, q) => {
        try {
          const mt = Math.floor(fs.statSync(path.join(_publicDir, name + ext)).mtimeMs);
          return `${pre}${name}${ext}?v=${mt}${q}`;
        } catch (_) { return m; }
      });
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.type('text/html').send(out);
  });
}
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  let rel;
  try { rel = decodeURIComponent(req.path).replace(/^\/+/, ''); } catch (_) { return next(); }
  const cands = !rel || rel === '/' ? ['index.html']
    : rel.endsWith('.html') ? [rel]
    : [rel + '.html'];
  for (const c of cands) {
    const fp = path.resolve(_publicDir, c);
    if ((fp === _publicDir || fp.startsWith(_publicDir + path.sep))
        && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      return _serveVersionedHtml(fp, res);
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.apk')) {
      res.set('Content-Type', 'application/vnd.android.package-archive');
      res.set('Content-Disposition', 'attachment; filename="multicc.apk"');
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
    }
  },
}));

// ── Chat mode: message history ──
// Soft cap for full-history retention. chat_history is display-only (never fed
// to the CLI - the CLI uses its own transcript via --resume), so we keep the
// full conversation for pagination/scroll-back and only distill-into-memory at
// this large backstop to bound disk/memory in pathological sessions.
const CHAT_HISTORY_SOFT_CAP = 10000;
// How many messages the initial WS `chat_history` push sends (the newest page).
// Older messages are fetched on demand via GET /history?before=<id>&limit=N as
// the user scrolls up.
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
  chatStream,
  trackPendingMemoryDistill: _trackPendingMemoryDistill,
  projectMessages: (_sessionId, messages) => projectHistoryUsage(messages),
  logger,
});
chatHistoryService = chatHistoryRuntime.service;
chatHistoryRuntime.mountRoutes(app);

// Compatibility wrappers keep earlier host composition (Aux, dispatch and
// session queries) independent of the runtime's later construction point.
function loadChatHistory(sessionId) { return chatHistoryRuntime.load(sessionId); }
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
  emitGatewayComplete: (text) => bus.emit('chat:gateway-turn-complete', text),
  inspectDispatchMarkers: maybeDispatchFromChatTurn,
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
  taskContextHost.broadcast(sessionName, payload);
}

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

// Map classifier states to their runtime actions; D/W are scan-terminal states.

function recordTaskBoardGoal(sessionName, goal, phase, cs, classifyState = 'P') {
  taskContextHost.recordGoal(sessionName, goal, phase, cs, classifyState);
}

function dispatchStateAction(result, ctx) {
  const { state, goal, phase, background, error } = result;
  const { sessionName, sessionId, cs, isTerminal } = ctx;

  // ── Classify history (persisted, last 7 days) ────────────────────────
  const now = Date.now();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const entry = { at: now, goal: goal || '', phase: phase || '', state,
    error: !!error, evidence: result.evidence || undefined };
  const persisted = persistedSessions.get(sessionName);
  if (persisted) {
    const ts = persisted.taskState || {};
    const hist = (Array.isArray(ts.classifyHistory) ? ts.classifyHistory : [])
      .filter(e => e.at > now - SEVEN_DAYS_MS);
    hist.push(entry);
    ts.classifyHistory = hist;
    persisted.taskState = ts;
  }

  // ── Common: persist goal + phase ────────────────────────────────────
  if (cs && cs.currentTask) {
    cs.currentTask.goal = (goal && goal !== '—') ? goal : '';
    if (phase) cs.currentTask.phase = phase;
  }
  const finalGoal = (cs && cs.currentTask) ? cs.currentTask.goal : goal;
  const finalPhase = (cs && cs.currentTask) ? cs.currentTask.phase : phase;
  // Persist BOTH goal and phase (was goal-only, leaving phase stale).
  if (sessionName) setTaskState(sessionName, finalPhase ? { goal: finalGoal || '', phase: finalPhase } : { goal: finalGoal || '' });
  if (sessionId && finalGoal) setSessionSummary(sessionId, finalGoal);

  recordTaskBoardGoal(sessionName, finalGoal, finalPhase, cs, state);

  // Mid-stream reclassify only observes goal/phase. Turn-end owns state and
  // side effects; persisting a provisional classifyState poisons scan guards.
  if (cs && cs.isStreaming && state !== 'running') {
    console.log(`[multicc/scan] ${sessionName} reclassify in-flight (isStreaming): state=${state}, 纯观察跳过（等 turn 结束重判）`);
    return;
  }

  // ── Dispatch per state ──────────────────────────────────────────────
  if (state === 'running') {
    // P — still processing. Two sub-cases:
    if (cs && cs.isStreaming) {
      // (1) Genuinely mid-turn (a turn IS in flight) — just refresh labels.
      const ph = phaseLabel(phase);
      const label = finalGoal ? `处理中：${finalGoal}${ph ? ' · ' + ph : ''}` : `处理中${ph ? '：' + ph : '…'}`;
      emitRunningNotify(sessionName, label);
      return;
    }
    // (2) P but no turn in flight. The runner boundary owns the sole bounded
    // unknown-error retry. Classify only reflects the exhausted/waiting state;
    // it must not open a second resume loop.
    logger.info('api_error_classifier_interrupted_observed', {
      sessionId: sessionName,
      provider: persisted?.cli || 'unknown',
      policyAction: cs?._lastApiErrorDecision?.action || 'fail_fast',
    });
    // Fall through to the waiting broadcast.
  }

  sessionWorkHost.classifyTransition(sessionName, cs?._currentTaskId || null, result);
  if (state === 'completed') {
    // D — task genuinely finished. This is the ONLY terminal state.
    const msg = finalGoal ? `任务完成：${finalGoal}` : '任务完成';
    if (isTerminal) {
      triggerPush(sessionId, 'completed', msg);
      terminalBroadcast(sessionId, { type: 'notify', state: 'completed', classifyState: 'D', message: msg });
    } else {
      triggerPush(sessionId, 'completed', `[Chat] ${msg}`);
      chatBroadcast(sessionName, { type: 'notify', state: 'completed', classifyState: 'D', message: msg });
    }
    const dirId = persistedSessions.get(sessionName)?.dirId;
    if (dirId) workspaceBroadcast(dirId, { type: 'notify', sessionId, state: 'completed', classifyState: 'D', message: msg });
    setSessionStatus(sessionName, { status: 'completed' });
    // D is the ONLY terminal state and triggers no follow-up action to persist it
    // later — so it must flush to disk NOW. Otherwise a crash before the next
    // save:true op loses the D; restart hydrates a stale non-D letter and scan
    // (L7407 only skips D/W) re-judges it → possible false wake. save:true (default).
    setTaskState(sessionName, { classifyState: 'D', endedAt: Date.now() });
    waitInjector.resetAuto(sessionName);
    // Clear the resume-interrupted counter so any future P-misclassify restarts from
    // count=1 rather than compounding on this concluded task. (Note: this clears the
    // counter only — it can't cancel an already-scheduled inject setTimeout; that
    // window is tiny and separate.)
    waitInjector.resetInterrupted(sessionName);
    return;
  }

  if (state === 'continue') {
    // C stays C without auto-injection. Fault recovery remains E/P-only.
    setTaskState(sessionName, { classifyState: 'C', endedAt: Date.now() });
    if (cs && cs.isStreaming) {
      const ph = phaseLabel(phase);
      const label = finalGoal ? `处理中：${finalGoal}${ph ? ' · ' + ph : ''}` : `处理中${ph ? '：' + ph : '…'}`;
      emitRunningNotify(sessionName, label);
      return;
    }
    // No user-input signal: keep the task card running, but leave the CLI idle.
    setSessionStatus(sessionName, { status: 'idle', currentFile: null });
    return;
  }

  // ── W / B / E (plus exhausted P recovery) → waiting (user-facing) ───────

  // E is now display/classification only. The runner boundary already called
  // the centralized API policy, which either scheduled one bounded safe retry
  // or failed fast. Classify must never create a second retry channel.
  if (error) {
    if (!cs?._lastApiErrorDecision) {
      evaluateTurnApiError({
        sessionName,
        cs,
        persisted,
        turn: cs?._activeTurn,
        runner: cs?._activeRunner,
        raw: {
          source: 'classifier_legacy',
          provider: persisted?.cli || 'unknown',
          code: 'classifier_api_error',
          message: 'classifier reported an API error without structured provider evidence',
        },
        attempt: cs?._apiRetryAttempt || 0,
        phase: 'stream',
        partialOutput: true,
        sideEffects: turnHasSideEffects(cs),
      });
    }
    logger.info('api_error_classifier_observed', {
      sessionId: sessionName,
      provider: persisted?.cli || 'unknown',
      policyAction: cs?._lastApiErrorDecision?.action || 'fail_fast',
    });
  }

  // Common waiting-state broadcast — driven by classifyState letter.
  const cls = error ? 'E' : background ? 'B' : 'W';
  const disp = classifyDisplay(cls);
  const pushType = disp.pushType || 'waiting';  // C/P have null pushType → default 'waiting'
  const policyMessage = error && cs?._lastApiErrorDecision
    ? retryNotice(cs._lastApiErrorDecision) : '';
  const waitMsg = error ? (policyMessage || 'API 异常，未自动重试')
    : finalGoal ? `等待：${finalGoal}` : '等待交互';
  if (isTerminal) {
    triggerPush(sessionId, pushType, waitMsg);
    terminalBroadcast(sessionId, { type: 'notify', state: pushType, classifyState: cls, message: waitMsg });
  } else {
    triggerPush(sessionId, pushType, `[Chat] ${waitMsg}`);
    chatBroadcast(sessionName, { type: 'notify', state: pushType, classifyState: cls, message: waitMsg });
  }
  const dirId2 = persistedSessions.get(sessionName)?.dirId;
  if (dirId2) workspaceBroadcast(dirId2, { type: 'notify', sessionId, state: pushType, classifyState: cls, message: waitMsg });
  setSessionStatus(sessionName, { status: 'waiting' });
  // Persist the accurate letter for observability. scan re-judges C/B/E/P and
  // skips D/W; C never reaches this branch merely because auto-inject is off.
  setTaskState(sessionName, { classifyState: cls, endedAt: Date.now() });
  // Reset auto-continue guard on a plain W (user is in charge now). B/E/C keep their own flow.
  if (state === 'waiting' && !background && !error) {
    waitInjector.resetAuto(sessionName);
  }
}

// ── Task state persistence (step ①) ───────────────────────────────────────────
// persisted.taskState is the durable closed-loop task snapshot: it survives
// restarts so the reconcile (②) can
// decide what was running, whether it stalled, and whether to nudge. Falls back
// to {} for legacy sessions that predate this field.
//
// Shape:
//   { goal, phase, startedAt, endedAt, lastSummary, lastSummaryAt,
//     lastTurnEndedAt, classifyState, pendingDispatches, classifyHistory,
//     pendingUserInput, userInputSignalVersion, apiError }
//   classifyState ∈ D | C | W | B | E | P | null  (D=done; B=terminal only; null=never classified)
//   classifyHistory: [{ at: ms, goal, phase, state, error }] — last 7 days
const TASK_STATE_DEFAULTS = {
  goal: '', phase: 'idle', startedAt: null, endedAt: null,
  lastSummary: '', lastSummaryAt: null, lastTurnEndedAt: null,
  classifyState: null, pendingDispatches: [],
  classifyHistory: [],
  pendingUserInput: null, userInputSignalVersion: 0, userInputSignalTurnId: null,
  apiError: null,
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
  const next = { ...cur, ...patch };
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
  { getSession: id => chatSessions.get(id),
    getState: id => getTaskState(persistedSessions.get(id)),
    setState: setTaskState, log: message => console.log(message) });
sessionWorkHost = createSessionWorkHost({
  runtime: () => orchestrationRuntime,
  getRecord: id => persistedSessions.get(id),
  getChatSession: id => chatSessions.get(id),
  getTaskState,
  pendingUserInput: id => userInputSignalHost.pending(id),
  recordUserInput: signal => userInputSignalHost.record(signal),
  broadcast: chatBroadcast,
  setTaskState,
  onTaskBoardQueueEvent: event => taskBoardRuntime.onQueueEvent(event),
  classifyDisplay,
  cancelClassify,
  chatStream,
  assignKillReason,
  appendMessage: appendChatMessage,
  log: logger,
});

const AUX_HEALTH_PROBE_INTERVAL_MS = 5 * 60 * 1000;  // ④: probe aux recovery while unhealthy

// ── Periodic scan (replaces the old startup-only reconcile) ────────────────
// Every minute, sweep sessions whose classifyState is not D or W (i.e. still
// C/B/E/P or never classified). D=terminal (done), W=waiting on user — both are
// scan-skipped. Dedup against the queue, throttle recently-judged
// sessions, and bail if the queue is backed up. On restart the first tick picks
// up everything that isn't definitively done — no special boot logic needed.
const SCAN_INTERVAL_MS = 60 * 1000;
const SCAN_MAX_QUEUE = 20;        // skip the whole sweep if the queue is already this long
const SCAN_RETHROTTLE_MS = 2 * 60 * 1000;  // skip a session judged < 2min ago
// Watchdog: a turn whose isStreaming never reset (process hung/crashed) would skip
// scan forever. Force-reset if no live stream event for this long. Generous so a
// slow-but-alive turn (a long tool/subagent that still emits events) is never killed.
const STUCK_STREAM_MS = 10 * 60 * 1000;    // 10 min of total stream silence = stuck

// Bounded in-memory ring of recent scanAndReclassify passes, for debugging
// "when did a scan run, what did it see, and which sessions did it enqueue vs
// skip (and why)". Queryable via GET /api/scan/history. Never persisted — no fs
// write on the 60s scan hot path; cleared on restart. Follows the networkHealth
// in-memory diagnostic-state pattern (not chat_history/__aux__.json, which uses
// synchronous fs writes and renders as chat bubbles).
const SCAN_HISTORY_MAX_PASSES = 100;       // ~100 min of passes at 60s cadence
const SCAN_HISTORY_MAX_DECISIONS = 400;    // per-pass cap on per-session records
const scanHistory = {
  seq: 0,
  passes: [],
  push(record) {
    record.pass = ++this.seq;
    if (record.decisions && record.decisions.length > SCAN_HISTORY_MAX_DECISIONS) {
      record.decisions = record.decisions.slice(0, SCAN_HISTORY_MAX_DECISIONS);
      record.decisionsTruncated = true;
    }
    this.passes.unshift(record);
    if (this.passes.length > SCAN_HISTORY_MAX_PASSES) this.passes.pop();
  },
};

// A goal is junk if it's empty (classify never ran or failed) or is really a
// system-injected message / raw tool payload rather than a user-authored goal.
function isInjectedOrJunkGoal(goal) {
  const g = String(goal || '').trim();
  if (!g) return true;  // empty goal is junk — classify never ran or failed
  return g.startsWith(waitInjector.SYS_PREFIX) || g.startsWith('<') || g.startsWith('"<');
}

// Whether a user message is system-injected (autoContinue / apiRetry / bgCheck).
function isSystemInjectedMsg(msg) {
  return String(msg || '').trim().startsWith(waitInjector.SYS_PREFIX);
}

// Whether classify has produced a real goal for this session. False for the
// ensureCurrentTask placeholder ('新任务'), empty, or injected/junk goals -
// i.e. classify hasn't named the task yet. scan uses this to decide whether a
// streaming session still needs an in-progress classify (to extract the goal).
function isGoalResolved(goal) {
  const g = String(goal || '').trim();
  if (!g || g === '新任务') return false;
  return !isInjectedOrJunkGoal(g);
}

// Shared turn-end/scan classify handler. Mid-stream only goal/phase is trusted;
// once the turn ends dispatchStateAction owns the definitive state verdict.
function applyClassifyResult(cs, sessionName, sessionId, res, { cwd, source } = {}) {
  res = userInputSignalHost.apply(sessionName, res);
  if (cs && cs.isStreaming) {
    if (cs.currentTask) {
      cs.currentTask.goal = (res.goal && res.goal !== '-') ? res.goal : '';
      if (res.phase) cs.currentTask.phase = res.phase;
    }
    // Persist BOTH goal and phase - persisting goal alone left phase stuck at
    // the ensureCurrentTask placeholder ('planning'), so the card showed
    // "新任务 规划中" even after classify judged the real goal/phase.
    setTaskState(sessionName, { goal: cs.currentTask?.goal || '', phase: cs.currentTask?.phase || 'planning' });
    const ph = phaseLabel(cs.currentTask?.phase);
    const goal = cs.currentTask?.goal || '';
    // Create/merge immediately; turn-end enriches the ref with assistant id.
    recordTaskBoardGoal(sessionName, goal, cs.currentTask?.phase, cs);
    const label = goal ? `处理中：${goal}${ph ? ' · ' + ph : ''}` : `处理中${ph ? '：' + ph : '…'}`;
    emitRunningNotify(sessionName, label);
    console.log(`[${source}] Classify in-progress for ${sessionName}: goal="${goal}" phase=${cs.currentTask?.phase || '?'}`);
    return;
  }
  // Turn over - dispatch state action.
  dispatchStateAction(res, { sessionName, sessionId, cs, isTerminal: false, cwd });
  console.log(`[${source}] Classify RESULT for ${sessionName}: state=${res.state} goal="${res.goal}" phase=${res.phase || '?'}${res.error ? ' (API error)' : ''}${res.evidence ? ` evidence=${res.evidence}` : ''}`);
}

function scanAndReclassify() {
  if (auxQueue.isUnhealthy()) return;
  // Debug observability: record this pass (time, queue state, and every
  // per-session enqueue/skip decision + reason) into the scanHistory ring.
  const passRecord = {
    ts: Date.now(),
    queueLen: auxQueue.queue.length,
    maxQueue: SCAN_MAX_QUEUE,
    fullSkip: false,
    considered: 0,
    enqueued: 0,
    decisions: [],
  };
  const note = (sid, cls, decision, reason) => passRecord.decisions.push(
    reason ? { sid, classifyState: cls ?? null, decision, reason }
           : { sid, classifyState: cls ?? null, decision });
  if (auxQueue.queue.length >= SCAN_MAX_QUEUE) {
    passRecord.fullSkip = true;
    scanHistory.push(passRecord);
    console.log(`[multicc/scan] queue backed up (${auxQueue.queue.length}) - skip this round`);
    return;
  }
  const now = Date.now();
  // Collect candidates first, then sort newest-first before enqueueing so
  // active sessions get judged before stale ones.
  const candidates = [];
  for (const [sid, p] of persistedSessions) {
    if (!p || p.type === 'aux' || p.type === 'gateway' || p.kind !== 'chat') continue;
    const ts = getTaskState(p);

    // Skip states that only change on NEW USER INPUT — re-judging the same
    // history just re-derives the same verdict (waste, and can't self-correct):
    //   D = done (terminal)      W = waiting on user
    // A real user message flips classifyState to 'P' (ensureCurrentTask) and
    // re-enters the turn flow, so W naturally leaves without scan's help.
    // Only C/B/E/P/null need re-judging — those advance on SYSTEM-side events
    // (auto-continue, background done, API recovered, interrupted resume).
    if (ts.classifyState === 'D' || ts.classifyState === 'W') {
      note(sid, ts.classifyState, 'skipped-DW-guard', ts.classifyState === 'D' ? 'done (terminal)' : 'waiting on user');
      continue;
    }

    // Skip sessions parked by the degrade防线 (held for API recovery). Re-judging a
    // held session every 60s is pure waste — its history hasn't changed (no new turn
    // ran while held), so the verdict can't self-correct. Worse, a fresh classify
    // nudge here would re-hit the chokepoint and overwrite the stashed pendingText
    // with boilerplate, losing any real dispatch/bg payload held for replay on
    // recovery. resumeHeldSessions owns these; leave them alone.
    if (apiErrorHost.isHeld(sid)) {
      note(sid, ts.classifyState, 'skipped-held', 'held by degrade防线 (API recovery)');
      continue;
    }

    // Streaming state waits for turn-end. Scan only resolves an unnamed goal;
    // the silence watchdog resets a genuinely stuck stream for normal recovery.
    const liveCs = chatSessions.get(sid);
    if (liveCs && liveCs.isStreaming) {
      // Math.max avoids inheriting a prior turn's stale lastStreamAt.
      const lastStream = Math.max(liveCs.lastStreamAt || 0, liveCs.turnStartedAt || 0);
      if (lastStream && (now - lastStream) > STUCK_STREAM_MS) {
        note(sid, ts.classifyState, 'stuck-reset', `${((now - lastStream) / 1000).toFixed(0)}s stream silence → force-reset isStreaming`);
        console.log(`[multicc/scan] ${sid} stuck-isStreaming: ${((now - lastStream) / 1000).toFixed(0)}s 无流事件 → 强制复位 isStreaming，本轮按 !isStreaming 重判`);
        liveCs.isStreaming = false;
        // fall through to reclassify now via the normal (non-streaming) path below
      } else if (isGoalResolved(ts.goal)) {
        note(sid, ts.classifyState, 'skipped-streaming', 'isStreaming + goal already resolved');
        continue;
      }
      // Unresolved goal falls through to the in-progress classify path.
    }

    // throttle: don't re-judge a session judged in the last SCAN_RETHROTTLE_MS,
    // BUT only within the same task. lastAt comes from classifyHistory (the prior
    // verdict), which may belong to the PREVIOUS task; a brand-new task writes a
    // later ts.startedAt via ensureCurrentTask. So gate the throttle on
    // lastAt >= startedAt: same-task redundant re-judge → still throttled (anti-flush);
    // cross-task boundary (lastAt < startedAt) → fall through, classify immediately so
    // the goal card refreshes from "新任务" to the real name within seconds instead of
    // waiting up to SCAN_RETHROTTLE_MS. startedAt null/0 (legacy) → lastAt >= 0 always
    // true → degrades to the old wall-clock behaviour, zero regression.
    const hist = Array.isArray(ts.classifyHistory) ? ts.classifyHistory : [];
    const lastAt = hist.length ? hist[hist.length - 1].at : 0;
    if (lastAt && (now - lastAt) < SCAN_RETHROTTLE_MS && lastAt >= (ts.startedAt || 0)) {
      note(sid, ts.classifyState, 'skipped-throttle', `judged ${((now - lastAt) / 1000).toFixed(0)}s ago (< ${SCAN_RETHROTTLE_MS / 1000}s)`);
      continue;
    }

    // dedup: already queued or in-flight
    if (auxQueue.hasPendingFor(sid)) {
      note(sid, ts.classifyState, 'skipped-dedup', 'already queued or in-flight');
      continue;
    }

    // Pull last assistant reply from chat history to classify against
    let reply = '';
    try {
      const history = loadChatHistory(sid);
      for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i];
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length >= 20) {
          reply = m.content; break;
        }
      }
    } catch (_) {}
    if (reply.length < 20) {
      note(sid, ts.classifyState, 'skipped-no-reply', 'no assistant reply ≥ 20 chars');
      continue;
    }

    // last activity time - used to order newest-first
    const ref = ts.lastTurnEndedAt || ts.lastSummaryAt
      || (p.lastActivity ? new Date(p.lastActivity).getTime() : 0) || lastAt || 0;
    const cleanPrior = isInjectedOrJunkGoal(ts.goal) ? '' : (ts.goal || '');
    candidates.push({ sid, cleanPrior, reply, ref, classifyState: ts.classifyState });
  }
  // Newest first: most recently active sessions are judged before stale ones.
  candidates.sort((a, b) => (b.ref || 0) - (a.ref || 0));
  passRecord.considered = candidates.length;

  let enqueued = 0;
  for (const c of candidates) {
    if (auxQueue.queue.length >= SCAN_MAX_QUEUE) {
      note(c.sid, c.classifyState, 'skipped-queue-full', `SCAN_MAX_QUEUE (${SCAN_MAX_QUEUE}) reached mid-loop`);
      continue;
    }
    const { sid, cleanPrior, reply } = c;
    auxQueue.enqueue({
      type: 'intent_classify',
      systemPrompt: buildClassifySystemPrompt(cleanPrior),
      prompt: buildClassifyConversation(sid, reply),
      meta: { sid, startup: true }
    }).then(result => {
      if (result.cancelled) return;
      const res = parseClassifyResult(result.text);
      const cs = chatSessions.get(sid);
      const sessionId = persistedSessions.get(sid)?.id || sid;
      applyClassifyResult(cs, sid, sessionId, res, { source: 'multicc/scan' });
    }).catch(e => {
      if (e && e.cancelled) return;
      console.warn(`[multicc/scan] classify ${sid} failed: ${e.message}`);
    });
    note(sid, c.classifyState, 'enqueued');
    enqueued++;
  }
  passRecord.enqueued = enqueued;
  scanHistory.push(passRecord);
  if (enqueued) console.log(`[multicc/scan] enqueued ${enqueued} session(s) for re-judge (newest first)`);
}

// GET /api/scan/history — debug: recent periodic-scan passes, newest first, each
// with its per-session enqueue/skip decisions + reasons. In-memory ring only.
//   ?limit=N   (default 20, capped at SCAN_HISTORY_MAX_PASSES)
mountScanRoutes(app, { scanHistory, maxPasses: SCAN_HISTORY_MAX_PASSES });

// ── Event log + passive inter-agent notes ──
// Each directory has an append-only event log (events/<dirId>.jsonl) and a shared
// pool of notes. A note left for another agent is delivered passively — prepended
// to that agent's next chat turn.
const EVENTS_DIR = MULTICC_PATHS.eventsDir;
try { ensurePrivateDir(EVENTS_DIR); } catch (_) {}
const NOTES_FILE = MULTICC_PATHS.notesFile;
const eventRing = new Map();   // dirId → event[] (last 200, lazy-loaded)
let notes = [];                // [{ id, dirId, fromSessionId, fromLabel, toSessionId, body, ts, delivered, deliveredAt }]

function loadNotes() {
  try {
    if (fs.existsSync(NOTES_FILE)) notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
  } catch (e) {
    console.error('[multicc] load notes.json failed:', e.message);
    notes = [];
  }
}
function saveNotes() {
  try { atomicWriteJson(NOTES_FILE, notes); }
  catch (e) { console.error('[multicc] save notes.json failed:', e.message); }
}
loadNotes();

// Lazy-load a directory's recent events from disk into the ring buffer.
function recentEvents(dirId) {
  if (eventRing.has(dirId)) return eventRing.get(dirId);
  const ring = [];
  try {
    const file = path.join(EVENTS_DIR, `${dirId}.jsonl`);
    if (fs.existsSync(file)) {
      for (const l of fs.readFileSync(file, 'utf8').trim().split('\n').slice(-200)) {
        try { ring.push(JSON.parse(l)); } catch (_) {}
      }
    }
  } catch (_) {}
  eventRing.set(dirId, ring);
  return ring;
}

// Append an event to a directory's log + ring buffer, and broadcast it live.
function appendEvent(dirId, type, detail, sessionId) {
  if (!dirId) return;
  const session = sessionId ? persistedSessions.get(sessionId) : null;
  const evt = {
    ts: Date.now(), type,
    sessionId: sessionId || null,
    sessionLabel: session ? (session.label || session.id) : (sessionId || null),
    detail: detail || null,
  };
  const ring = recentEvents(dirId);
  ring.push(evt);
  if (ring.length > 200) ring.shift();
  try { fs.appendFileSync(path.join(EVENTS_DIR, `${dirId}.jsonl`), JSON.stringify(evt) + '\n', { mode: 0o600 }); }
  catch (_) {}
  workspaceBroadcast(dirId, { type: 'event', event: evt });
}

function pendingNotesFor(sessionId) {
  return notes.filter(n => n.toSessionId === sessionId && !n.delivered);
}

// Drop all notes referencing a session (called when it is deleted).
function purgeNotesForSession(sessionId) {
  const before = notes.length;
  notes = notes.filter(n => n.toSessionId !== sessionId && n.fromSessionId !== sessionId);
  if (notes.length !== before) saveNotes();
}

// ── Unified classify — the single source of truth for task state ────────────
// goal/phase/D/C/W/E/P all come from ONE aux call per invocation. Call sites:
//   · turn-end:   immediately after a turn ends to finalise goal + D/C/W/E/P
//   · scan:       every 60s, re-judges any session not yet D/W (system-side
//                 events: API recovered, interrupted resume, goal resolution)
// No in-turn loop — while streaming the output is incomplete and a mid-turn
// verdict would be unreliable. On aux unhealthy: classify is suppressed; the
// last-known goal/phase is frozen and the dashboard banner warns the user.

function cancelClassify(cs) {
  if (cs._classifyTimer) { clearTimeout(cs._classifyTimer); cs._classifyTimer = null; }
  // Don't cancel an in-flight classify — let it finish so its result lands.
  // The .then() handler now always applies the latest result unconditionally.
}

// Build the CHAT classify prompt (system + conversation). Output is the same
// unified 3-line format parsed by parseClassifyResult above (shared with the
// terminal path).
// Line 1: goal — noun-phrase in the conversation's language (中文 ≤20 字 / EN ≤10 words)
// Line 2: phase ∈ 规划中|实现中|验证中|收尾中|已完成 (Chinese codes; EN synonyms tolerated)
// Line 3: D(done) | C(continue) | W(wait user) | E(api error) | P(processing)  (chat prompt does not emit B)
// Tolerant of blank lines, prefixes, and model cruft.
// Build the classify user prompt (conversation data only, no instructions).
// Returns the conversation block as a plain string of labelled turns.
function buildClassifyConversation(sessionName, reply) {
  const history = loadChatHistory(sessionName);
  const MAX_TURNS = 20;
  const MAX_PER_MSG = 400;
  const RECENT_NO_TRUNC = 5;  // keep the most recent N messages in full
  const parts = [];

  // Walk backwards, collect up to MAX_TURNS user+assistant messages.
  // Skip consecutive duplicates (chat_history may have _interim + final copies
  // of the same assistant message from incremental saves).
  let count = 0;
  let lastContent = '';
  for (let i = history.length - 1; i >= 0 && count < MAX_TURNS; i--) {
    const m = history[i];
    if (!m || !m.content) continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (isSystemInjectedMsg(m.content)) continue;
    // Don't truncate the most recent few messages - the model needs the full
    // latest reply to judge state. A truncated reply looks mid-sentence and
    // gets misjudged as P (still processing).
    const snippet = count < RECENT_NO_TRUNC
      ? String(m.content)
      : String(m.content).slice(0, MAX_PER_MSG);
    if (m.role === 'assistant' && snippet === lastContent) continue;
    lastContent = snippet;
    const label = m.role === 'user' ? '用户' : '助手';
    parts.unshift(`${label}：${snippet}`);
    count++;
  }

  // Live assistant output not yet in chat_history (the newest - keep full).
  if (reply) {
    const liveSnippet = String(reply);
    if (liveSnippet !== lastContent) {
      parts.push(`助手：${liveSnippet}`);
    }
  }

  return `对话记录：\n${parts.join('\n\n')}`;
}

function runClassifyNow(cs, sessionName) {
  const reply = cs.currentAssistantText || '';
  const userMsg = cs.currentUserText || '';
  // Need at least a user message (turn-start) or some AI reply (mid/end) to work with.
  if (userMsg.length < 1 && reply.length < 20) return;

  const sessionId = persistedSessions.get(sessionName)?.id || sessionName;
  const priorGoal = cs.currentTask?.goal || '';
  // Structured W remains available while Aux is degraded.
  if (auxQueue.isUnhealthy()) {
    const structured = userInputSignalHost.degradedResult(sessionName, cs.currentTask);
    if (structured) applyClassifyResult(cs, sessionName, sessionId, structured,
      { cwd: cs.cwd, source: 'multicc/structured' });
    else sessionWorkHost.classifyUnavailable(
      sessionName, cs._currentTaskId || null, 'classification_unavailable');
    return;
  }
  // Dedup: drop this session's older queued/in-flight classify before enqueuing
  // the fresh one — a session only needs its single latest judgement. Without
  // this, rapid turns pile up near-duplicate classifies that then supersede each
  // other's .then() and drop the real verdict (goal/state never persist).
  auxQueue.cancelClassifyFor(sessionName);
  const taskId = crypto.randomUUID();
  cs._classifyTaskId = taskId;

  auxQueue.enqueue({
    id: taskId,
    type: 'intent_classify',
    systemPrompt: buildClassifySystemPrompt(priorGoal),
    prompt: buildClassifyConversation(sessionName, reply),
    meta: { sessionName, sessionId },
  }).then(result => {
    if (cs._classifyTaskId !== taskId) return; // superseded by a newer classify
    cs._classifyTaskId = null;
    if (result.cancelled) return;
    const res = parseClassifyResult(result.text);
    applyClassifyResult(cs, sessionName, sessionId, res, { cwd: cs.cwd, source: 'multicc/aux' });
  }).catch((e) => {
    if (cs._classifyTaskId === taskId) cs._classifyTaskId = null;
    // A cancelled task (new turn started / user typing) rejects with {cancelled:true}
    // and no .message — that's normal churn, not a failure. Don't log it as FAILED.
    if (e && e.cancelled) return;
    console.log(`[multicc/aux] Classify FAILED for ${sessionName}: ${e.message}`);
    sessionWorkHost.classifyUnavailable(
      sessionName, cs._currentTaskId || null, 'classification_error');
  });
}

// Fire classify immediately after a turn ends — classify is the ONLY decider of
// C/W/E/P/D. No in-turn loop: while streaming the output is still changing so a
// mid-turn verdict would be judged against an incomplete reply. We judge once at
// turn end (definitive) and the periodic scan re-judges anything not yet D/W.
// runClassifyNow handles the empty-reply case itself (falls back to user msg).
function classifyTurnEnd(cs, sessionName) {
  cancelClassify(cs);
  sessionWorkHost.turnEnded(sessionName);
  runClassifyNow(cs, sessionName);
  taskBoardRuntime.onTurnEnd(cs, sessionName);
}
// to know "what task is running" and "what's the current status" WHILE the
// agent is still working. This does exactly that:
// ── Closed-loop task model ─────────────────────────────────────────────────
// The goal is produced solely by the classify loop (turn-start + every 60s).
// No rule-based fallback from the raw user message — that path used to turn
// greetings ("hi") and injected recovery text into bogus goals.
function newCurrentTask(goal) {
  return {
    goal: goal || '新任务',    // placeholder until the first classify fills it in
    startedAt: Date.now(),
    phase: 'planning',         // planning | implementing | verifying | wrapping | done
    steps: [],
    pendingDispatches: [],     // dispatched worker runs awaiting回流 (see dispatch hooks)
    turnSeq: 0,                // bumped each turn that belongs to this task
  };
}

// taskId is the authoritative boundary; legacy turns retain the 10-minute heuristic.
function ensureCurrentTask(cs, sessionName, userText, forceNew = false) {
  if (!cs) return;
  const now = Date.now();
  const prev = cs.currentTask;
  const canonicalContinuation = !!cs._currentTaskId && !forceNew && !!prev;
  if (taskContextHost.continues(cs, prev, forceNew, now)) {
    prev.turnSeq = (prev.turnSeq || 0) + 1;
    if (canonicalContinuation && prev.phase === 'done') prev.phase = 'planning';
    // Refresh persisted state: a continued turn means the closed-loop task
    // is still running (classify will refine shortly).
    setTaskState(sessionName, { classifyState: 'P' });
    return prev;
  }
  // Preserve only an unfinished classify-refined legacy goal.
  const carryGoal = (prev && prev.phase !== 'done' && prev.goal && prev.goal !== '新任务' && !isInjectedOrJunkGoal(prev.goal)) ? prev.goal : '';
  cs.currentTask = newCurrentTask(carryGoal);
  cs.currentTask.turnSeq = 1;
  // Persist the new task snapshot so a mid-task restart can reconcile it (②).
  setTaskState(sessionName, {
    goal: cs.currentTask.goal, phase: cs.currentTask.phase,
    startedAt: cs.currentTask.startedAt, endedAt: null,
    classifyState: 'P',
  });
  return cs.currentTask;
}

function emitRunningNotify(sessionName, message) {
  const persisted = persistedSessions.get(sessionName);
  if (!persisted) return;
  const sessionId = persisted.id || sessionName;
  setSessionSummary(sessionId, message);
  chatBroadcast(sessionName, { type: 'notify', state: 'running', message });
  const dirId = persisted.dirId;
  if (dirId) {
    workspaceBroadcast(dirId, { type: 'notify', sessionId, state: 'running', message });
  }
}

// Terminal outcome of a chat turn. Fired immediately at turn end so the card
// moves from the in-progress "处理中：xxx" to the completed label:
//   • status badge → completed / error  (status event)
//   • summary line → the outcome label   (summary event) — replaces 处理中：xxx
// Both are display-only (no user-facing alert). The lock-screen push / voice /
// app notification (the `notify` event) only fires when `alert` is set — true
// for errors; false for a plain completion, which the 30s intent_classify
// reports once (and which then refines this summary to the actual content).
function emitTurnOutcome(sessionName, { status, notifyState, message, alert }) {
  const persisted = persistedSessions.get(sessionName);
  if (!persisted) return;
  const sessionId = persisted.id || sessionName;
  if (userInputSignalHost.pending(sessionName)) { setTaskState(sessionName, { lastTurnEndedAt: Date.now(), endedAt: Date.now() }); return; }
  // Enrich bare "任务完成" with the stable task name so the
  // dashboard / chat shows "任务完成：memo图片更换" instead of a dry "任务完成".
  // Prefer the current turn's stored task name; fall back to the last
  // session summary (from a prior intent_classify).
  if (message === '任务完成') {
    const cs = chatSessions.get(sessionName);
    // Prefer the closed-loop task goal (noun-phrase, model-generated); fall
    // back to the legacy currentTaskName, then to the last session summary.
    const goal = cs?.currentTask?.goal || cs?.currentTaskName || '';
    // Mark the closed-loop task done so ensureCurrentTask starts a fresh task
    // next turn (rather than continuing a finished one).
    if (cs?.currentTask) cs.currentTask.phase = 'done';
    if (goal) {
      message = `任务完成：${goal}`;
    } else {
      const sm = sessionSummaries.get(sessionId);
      const raw = sm?.summary || '';
      // Strip any status label prefix plus optional " · subAction" / " — subAction" suffix
      const clean = raw.replace(/^(正在处理：|处理中：|任务完成：)/, '').replace(/\s*[·—]\s*.+$/, '').trim();
      if (clean) message = `任务完成：${clean}`;
    }
  }

  setSessionStatus(sessionName, { status, currentFile: null });
  // Record turn-end timestamp. classifyTurnEnd / classify loop owns the
  // C/W/B/P decision — we don't set classifyState here.
  {
    // Don't set classifyState here — classifyTurnEnd / classify loop owns the C/W/B/P decision.
    setTaskState(sessionName, { lastTurnEndedAt: Date.now(), endedAt: Date.now() }, { save: false });
  }
  setSessionSummary(sessionId, message);
  if (alert) {
    triggerPush(sessionId, notifyState, `[Chat] ${message}`);
    chatBroadcast(sessionName, { type: 'notify', state: notifyState, message });
    if (persisted.dirId) {
      workspaceBroadcast(persisted.dirId, { type: 'notify', sessionId, state: notifyState, message });
    }
  }
}

// API recovery is decided at the owned runner boundary. Classify state E only
// reflects that decision; it cannot inject a second retry turn.

// Apply one claude-shaped stream-json event to chat session state, then forward
// it to clients. Shared by the per-turn spawn path (handleLine) and the
// persistent streaming path (runChatTurnStreaming) so the two never drift.
// The `result` event is the turn boundary: it saves the assistant message,
// returns the session to idle, and fires post-turn hooks.
function applyClaudeChatEvent(cs, sessionName, evt, forward, turn, runner, providerName = 'claude') {
  if (!isCurrentTurnRunner(cs, turn, runner)) return;
  turnProgressHeartbeat.touchActivity(sessionName, turn.turnId);
  if (evt.type === 'assistant' && evt.message?.model) noteReportedModel(sessionName, evt.message.model);
  if (evt.type === 'assistant' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'text') {
        turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'thinking');
        cs.currentAssistantText += block.text;
        setSessionStatus(sessionName, { status: 'thinking', currentFile: null });
        // Incremental save: flush the in-progress assistant message to disk
        // every 5s so a crash/restart mid-turn doesn't lose the whole reply.
        scheduleIncrementalSave(sessionName, cs);
      }
      if (block.type === 'tool_use') {
        turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'tool', block.name);
        cs.currentToolCalls.push({ name: block.name, input: block.input, id: block.id });
        backgroundTaskRuntime.recordMainToolUseId(sessionName, block.id);
        if (block.name === 'TaskOutput') backgroundTaskRuntime.markTaskOutputAwaiting(sessionName, block.input);
        const editTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
        if (editTools.includes(block.name)) {
          setSessionStatus(sessionName, { status: 'editing', currentFile: block.input?.file_path || null });
        } else if (block.name === 'Bash') {
          setSessionStatus(sessionName, { status: 'running', currentFile: null });
        } else {
          setSessionStatus(sessionName, { status: 'thinking', currentFile: null });
        }
      }
    }
  }
  if (evt.type === 'user' && evt.message?.content) {
    for (const r of (Array.isArray(evt.message.content) ? evt.message.content : [evt.message.content])) {
      if (r.type === 'tool_result') {
        turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'thinking');
        const tc = cs.currentToolCalls.find(t => t.id === r.tool_use_id);
        if (tc) {
          tc.result = typeof r.content === 'string' ? r.content :
            Array.isArray(r.content) ? r.content.map(c => c.text || '').join('') :
            JSON.stringify(r.content);
          tc.is_error = r.is_error || false;
          if (tc.result && tc.result.length > 1000) tc.result = tc.result.slice(0, 1000) + '...';
        }
      }
    }
  }
  if (evt.type === 'result') {
    turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'finalizing');
    cs.currentCost = evt.total_cost_usd || null;
    const apiFailure = evt.is_error === true
      || (evt.subtype && evt.subtype !== 'success' && /error|abort|timeout/i.test(evt.subtype));
    if (apiFailure) {
      chatHistoryRuntime.clearIncrementalSave(sessionName);
      cs._sawApiError = true;
      runner.sawApiError = true;
      const detail = evt.error && typeof evt.error === 'object' ? evt.error : {};
      runner.apiErrorRaw = {
        source: providerName === 'qoder' ? 'qoder_result' : 'claude_result',
        provider: providerName,
        code: detail.code || evt.subtype || detail.type,
        httpStatus: detail.http_status || detail.status_code || detail.status
          || evt.http_status || evt.status_code || evt.status,
        headers: detail.headers || evt.headers,
        requestId: detail.request_id || evt.request_id,
        message: detail.message || evt.result || evt.subtype || 'api_error',
      };
    } else {
      recordApiSuccess(providerName, { retryAttempt: runner.apiRetryAttempt || 0 });
      clearSessionApiErrorState(sessionName, cs);
    }
    // Hoisted out of the if-block below: forward() at the end of this branch
    // also needs it. Block-scoping it inside the if made the forward line throw
    // ReferenceError (swallowed by handleLine's catch), so live clients never
    // received the result event — token/timing footers only appeared after a
    // reload replayed chat_history.
    const usage = evt.usage || {};
    runner.pendingUsage = usage;
    if (!apiFailure && (cs.currentAssistantText || cs.currentToolCalls.length)) {
      const resultDurable = persistFinalAssistantResult(sessionName, cs, turn, runner, {
        role: 'assistant', content: cs.currentAssistantText,
        tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
        cost: cs.currentCost, usage: Object.keys(usage).length ? usage : undefined, ts: Date.now(),
      }, { resultEvent: true });
      if (resultDurable) {
        recordDurableTurnUsage(sessionName, runner, usage);
        cs.chatTurnCount++;
        // Mark this turn as having a durable persisted result so the classify
        // P+no-turn-in-flight branch (server.js ~3610) does not mistake a
        // normally-completed turn for an unknown interruption and resume it —
        // which would re-run `claude --resume` and produce duplicate replies
        // with cumulative usage (the 1x/2x/3x symptom).
        cs._resultSaved = true;
      }
      // Cancel any pending incremental-save timer: the final message is now
      // persisted, so a timer firing 0-5s later would append a stale _interim
      // AFTER the final — a duplicate bubble on reconnect. Mirrors the cancel
      // in the child-process close handler.
      chatHistoryRuntime.clearIncrementalSave(sessionName);
    } else if (!apiFailure) {
      recordResultEvent(turn, runner, { current: true, persisted: false });
    } else {
      // An error result is a turn boundary, not a durable successful answer.
      // Close finalization may checkpoint meaningful partial output, while an
      // error-only envelope remains eligible for a safe bounded retry.
      recordResultEvent(turn, runner, { current: true, persisted: false });
    }
    // Include durationMs + num_turns in the result broadcast so clients
    // (web + app) can display per-message task timing without client-side
    // clock guesswork. durationMs is the wall-clock time from turnStartedAt
    // (user submit) to this result — "模型接到消息到输出完成的耗时".
    const _resultDurationMs = cs.turnStartedAt ? Date.now() - cs.turnStartedAt : undefined;
    forward({ type: 'result', total_cost_usd: evt.total_cost_usd, usage, durationMs: _resultDurationMs, num_turns: cs.chatTurnCount });
    // Final classification and all post-turn effects run from the owned
    // close/finalize boundary. The result event alone is not enough: history
    // persistence may have failed or a retry may still be planned.
    setSessionStatus(sessionName, { status: cs._resultSaved ? 'completed' : 'idle', currentFile: null });
  }
  // Drop claude's `system init` — server already sent its own (but keep the
  // runtime-reported model before discarding).
  if (evt.type === 'system' && evt.subtype === 'init') { noteReportedModel(sessionName, evt.model); return; }
  forward(evt);
}

// Apply adapter-neutral events to server-owned chat state. Wire-format parsing
// belongs to each CLI adapter; this function owns persistence, status and the
// Claude-shaped event contract consumed by existing clients.
function applyAdapterChatEvent(provider, cs, persisted, sessionName, rawEvent, forward, turn, runner) {
  if (!isCurrentTurnRunner(cs, turn, runner)) return;
  turnProgressHeartbeat.touchActivity(sessionName, turn.turnId);
  const decoded = provider.decodeEvent(rawEvent) || [];
  for (const evt of (Array.isArray(decoded) ? decoded : [decoded])) {
    if (!evt) continue;
    if (evt.type === 'claude_event') {
      applyClaudeChatEvent(cs, sessionName, evt.raw, forward, turn, runner, provider.name);
      continue;
    }
    if (evt.type === 'session_init') {
      if (evt.model) noteReportedModel(sessionName, evt.model);
      continue;
    }
    if (evt.type === 'session_started') {
      const handoff = persisted.pendingCliHandoff;
      const resumeMismatch = !!(
        evt.sessionId
        && persisted.cliSessionId
        && evt.sessionId !== persisted.cliSessionId
        && handoff
        && handoff.status === 'pending'
        && handoff.reusedTarget
        && handoff.toCli === persisted.cli
      );
      if (resumeMismatch) {
        cs._adapterError = 'cross-cli target returned a different native session id';
        runner.adapterError = cs._adapterError;
        assignKillReason(runner, 'cli_resume_mismatch');
        chatBroadcast(sessionName, {
          type: 'error',
          error: `目标 ${persisted.cli} 没有恢复预期的原生会话；未接受 CLI 返回的新会话。请重新切换并选择“重置目标 CLI 会话”。`,
        });
        if (cs.claudeProc) {
          try { cs.claudeProc.kill('SIGTERM'); } catch (_) {}
        }
        continue;
      }
      if (evt.sessionId && !persisted.cliSessionId) {
        persisted.cliSessionId = evt.sessionId;
        rememberActiveCliState(persisted);
        savePersistedSessionsBestEffort('runtime.chat-session-id-capture');
        console.log(`[multicc/chat] [${sessionName}] captured ${provider.name} session id=${evt.sessionId}`);
      }
      continue;
    }
    if (evt.type === 'status') {
      turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, evt.phase || evt.status);
      setSessionStatus(sessionName, { status: evt.status || 'thinking', currentFile: evt.currentFile || null });
      continue;
    }
    if (evt.type === 'activity') {
      turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, {
        phase: evt.phase || 'tool', safeToolKind: evt.toolKind,
      });
      setSessionStatus(sessionName, { status: 'running', currentFile: null });
      continue;
    }
    if (evt.type === 'assistant_text') {
      turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'thinking');
      if (!evt.text) continue;
      cs.currentAssistantText += (cs.currentAssistantText ? '\n\n' : '') + evt.text;
      forward({
        type: 'assistant',
        message: { content: [{ type: 'text', text: evt.text + (evt.forwardSuffix || '') }] },
      });
      setSessionStatus(sessionName, { status: 'thinking', currentFile: null });
      scheduleIncrementalSave(sessionName, cs);
      if (evt.log) console.warn(`[multicc/chat] [${sessionName}] ${provider.name} ${evt.log}`);
      continue;
    }
    if (evt.type === 'tool_start') {
      turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'tool', evt.name);
      const tool = { name: evt.name, input: evt.input || {}, id: evt.id };
      cs.currentToolCalls.push(tool);
      backgroundTaskRuntime.recordMainToolUseId(sessionName, evt.id);
      forward({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: evt.name, id: evt.id, input: evt.input || {} }] },
      });
      setSessionStatus(sessionName, { status: evt.status || 'running', currentFile: evt.currentFile || null });
      continue;
    }
    if (evt.type === 'tool_result') {
      turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'thinking');
      const text = evt.content || '';
      forward({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: evt.id, content: text, is_error: !!evt.isError }] },
      });
      const tool = cs.currentToolCalls.find(item => item.id === evt.id);
      if (tool) {
        tool.result = text.length > 1000 ? text.slice(0, 1000) + '...' : text;
        tool.is_error = !!evt.isError;
      }
      continue;
    }
    if (evt.type === 'tool_update') {
      turnProgressHeartbeat.updatePhase(sessionName, turn.turnId,
        evt.completed ? 'thinking' : 'tool', evt.name);
      const id = evt.id || `call_${cs.currentToolCalls.length}`;
      let tool = cs.currentToolCalls.find(item => item.id === id);
      if (!tool) {
        tool = { name: evt.name, input: evt.input || {}, id };
        cs.currentToolCalls.push(tool);
        backgroundTaskRuntime.recordMainToolUseId(sessionName, id);
        forward({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: evt.name, id, input: evt.input || {} }] },
        });
      }
      setSessionStatus(sessionName, { status: 'running', currentFile: evt.currentFile || null });
      if (evt.completed) {
        const text = evt.content || '';
        forward({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: !!evt.isError }] },
        });
        tool.result = text.length > 1000 ? text.slice(0, 1000) + '...' : text;
        tool.is_error = !!evt.isError;
      }
      continue;
    }
    if (evt.type === 'thinking') {
      turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'thinking');
      const tool = { name: 'Thinking', input: { text: evt.text || '' }, id: evt.id, result: evt.text || '' };
      cs.currentToolCalls.push(tool);
      backgroundTaskRuntime.recordMainToolUseId(sessionName, evt.id);
      forward({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Thinking', id: evt.id, input: tool.input }] },
      });
      // codex reasoning arrives complete (no partial stream), so pair it with a
      // tool_result immediately — otherwise the Thinking card is stuck showing
      // 「running...」forever because no result ever follows.
      forward({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: evt.id, content: evt.text || '', is_error: false }] },
      });
      continue;
    }
    if (evt.type === 'complete') {
      turnProgressHeartbeat.updatePhase(sessionName, turn.turnId, 'finalizing');
      recordApiSuccess(provider.name, { retryAttempt: runner.apiRetryAttempt || 0 });
      clearSessionApiErrorState(sessionName, cs);
      codexUsageHost.complete({ evt, cs, persisted, sessionName, turn, runner, forward });
      continue;
    }
    if (evt.type === 'error') {
      turnProgressHeartbeat.updatePhase(sessionName, turn.turnId,
        evt.kind === 'transport_disconnect' ? 'recovering' : 'finalizing');
      if (evt.kind === 'response_completed_disconnect') {
        const publicMessage = sanitizeApiErrorMessage(evt.message);
        cs._codexPendingStreamError = publicMessage;
        cs._codexPendingStreamErrorCount = (cs._codexPendingStreamErrorCount || 0) + 1;
        const hasOutput = !!(cs.currentAssistantText || cs.currentToolCalls.length || cs._resultSaved);
        if (hasOutput) cs._codexRecoveredDisconnect = true;
        logger.warn('chat_provider_response_completed_disconnect', {
          sessionId: sessionName,
          provider: provider.name,
          afterOutput: hasOutput,
          occurrence: cs._codexPendingStreamErrorCount,
        });
      } else if (evt.kind === 'transport_disconnect') {
        const publicMessage = sanitizeApiErrorMessage(evt.message);
        cs._codexTransportError = publicMessage;
        cs._sawApiError = true;
        runner.sawApiError = true;
        runner.apiErrorRaw = evt.error || {
          source: `${provider.name}_event`,
          provider: provider.name,
          code: 'connection_reset',
          message: evt.message,
        };
        logger.warn('chat_provider_transport_error', {
          sessionId: sessionName,
          provider: provider.name,
          phase: meaningfulTurnOutput(cs) || turnHasSideEffects(cs) ? 'stream' : 'before_first_token',
        });
      } else {
        const publicMessage = sanitizeApiErrorMessage(evt.message);
        cs._adapterError = publicMessage;
        runner.adapterError = publicMessage;
        runner.sawApiError = true;
        runner.apiErrorRaw = evt.error || {
          source: `${provider.name}_event`,
          provider: provider.name,
          code: 'provider_error',
          message: evt.message,
        };
        forward({ type: 'error', error: `${evt.label || provider.name} 出错：${publicMessage}` });
      }
    }
  }
}

const backgroundTaskRuntime = createBackgroundTaskRuntime({
  broadcast: chatBroadcast,
  observeTask: observation => orchestrationRuntime.observeTask(observation),
  noteBgResultInjected: sessionName => waitInjector.noteBgResultInjected(sessionName),
  injectSystemMsg: (...args) => waitInjector.injectSystemMsg(...args),
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

async function admitChatWork(sessionName, text, opts = {}) {
  return sessionWorkHost?.admit(sessionName, text, opts)
    || { ok: false, code: 'scheduler_not_ready' };
}

function runChatTurn(sessionName, text, opts = {}) {
  const persisted = persistedSessions.get(sessionName);
  if (!persisted) {
    console.warn(`[multicc/chat] runChatTurn: no persisted record for ${sessionName}`);
    return false;
  }
  // Typed Commander user input is intercepted by the host router. Any fallback
  // Commander turn is deliberately barred from the legacy marker dispatcher.

  // Normalize once at the host boundary. Native CLI session ids and provider
  // credentials stay outside the pure request; only proof of native history is
  // admitted. Reuse the history read when a WS state has not been materialized.
  const existingCs = chatSessions.get(sessionName);
  let initialHistory = null;
  const turnCount = existingCs
    ? existingCs.chatTurnCount
    : (initialHistory = loadChatHistory(sessionName)).filter(message => message.role === 'assistant').length;
  const turnCli = (existingCs && existingCs.cli) || persisted.cli || 'claude';
  // Preserve the old host ordering without mutating a duplicate delivery: when
  // no WS state exists, Claude allocates its UUID during accepted preparation,
  // before deciding first-vs-resume. This future allocation is the only extra
  // native-history proof admitted here; Codex and existing chat states continue
  // to require an already persisted native session id.
  const willAllocateClaudeNativeSession = !existingCs && turnCli === 'claude' && !persisted.cliSessionId;
  const inheritedLineage = opts.originContinue === true
    && existingCs && existingCs._continuationLineage
    ? existingCs._continuationLineage.lineage
    : null;
  let turnRequest;
  try {
    turnRequest = normalizeTurnRequest({
      sessionId: sessionName,
      text,
      cli: turnCli,
      turnCount,
      hasNativeSession: !!persisted.cliSessionId || willAllocateClaudeNativeSession,
      forceFirstTurn: typeof opts.isFirstTurn === 'boolean' ? opts.isFirstTurn : undefined,
      requestId: opts.requestId,
      clientMsgId: opts.clientMsgId,
      deliveryId: opts.deliveryId,
      originDispatchId: opts.originDispatchId
        || (inheritedLineage && inheritedLineage.kind === 'dispatch' ? inheritedLineage.operationId : null),
      originTrigger: opts.originTrigger === true
        || !!(!opts.originDispatchId && inheritedLineage && inheritedLineage.kind === 'trigger'),
      originContinue: opts.originContinue,
      goalLimits: opts.goalLimits,
      bgTaskIds: opts.bgTaskIds,
      bgToolUseIds: opts.bgToolUseIds,
      ...taskContextHost.turnOptions(opts),
    });
  } catch (error) {
    const code = error instanceof TurnRequestError ? error.code : 'invalid_request';
    logger.warn('chat_turn_rejected_invalid_request', { sessionId: sessionName, code });
    return false;
  }

  text = turnRequest.text;
  const clientMsgId = turnRequest.identity.clientMsgId || '';
  const deliveryId = turnRequest.identity.deliveryId || '';
  const originDispatchId = turnRequest.origin.operationId;
  const originContinue = turnRequest.launch.reason === 'continue';
  const goalLimits = turnRequest.goalLimits;
  const bgTaskIds = turnRequest.background.taskIds;
  const bgToolUseIds = turnRequest.background.toolUseIds;
  const requestedTask = turnRequest.task;

  // Durable orchestration may replay an outbox claim after a crash in the
  // narrow window between history persistence and outbox acknowledgement.
  // Treat the persisted client/delivery id as the local idempotency key.  A
  // duplicate rewrites the cached history to disk (important after a previous
  // failed save) but never starts or interrupts another CLI turn.
  let duplicateSeen = false;
  let duplicatePersisted = false;
  if (clientMsgId || deliveryId) {
    if (clientMsgId && chatHistoryService.containsDelivery(sessionName, clientMsgId)) {
      duplicateSeen = true;
      duplicatePersisted = chatHistoryService.hasPersistedDelivery(sessionName, clientMsgId);
    } else if (deliveryId && chatHistoryService.containsDelivery(sessionName, deliveryId)) {
      duplicateSeen = true;
      duplicatePersisted = chatHistoryService.hasPersistedDelivery(sessionName, deliveryId);
    }
  }

  const streamBusy = turnRequest.cli === 'claude' && !!chatStream.status(sessionName)?.busy;
  const admission = planTurnAdmission(turnRequest, {
    duplicateSeen,
    duplicatePersisted,
    shuttingDown: _shuttingDown,
    sessionExists: true,
    networkUnhealthy: isNetworkUnhealthy(),
    runningTurn: !!(existingCs && existingCs.claudeProc) || streamBusy,
  });
  if (admission.decision === 'duplicate') return admission.accepted;
  if (admission.decision === 'reject') {
    if (admission.reason === 'shutdown') logger.warn('chat_turn_rejected_shutdown', { sessionId: sessionName });
    return false;
  }
  if (admission.decision === 'hold') {
    holdSession(sessionName, 'classify-inject', text);
    console.log(`[multicc/net] ${sessionName}: suppress system inject (originContinue) — network unhealthy, held for recovery`);
    return false;
  }

  const turnId = `turn_${crypto.randomBytes(12).toString('hex')}`;
  const turn = createTurnLifecycle(turnRequest, { turnId });
  const claimed = chatTurnPreparationRuntime.claim(sessionName, turnId, {
    cli: turnRequest.cli,
    transport: turnRequest.execution.transport,
  });
  if (!claimed.ok) {
    logger.warn('chat_turn_rejected_preparation_in_flight', { sessionId: sessionName, code: claimed.code });
    return false;
  }
  let preparationOpen = true;
  let preparationFailure = 'preparation-failed';
  let cs = existingCs;
  let runnerHandedOff = false;
  let preparationStateActivated = false;
  let messageDurable = false;

  try {
  // A real user/trigger turn resets auto-continue guards. Degraded automatic
  // continuations were already held at admission until recordApiSuccess resumes them.
  // A real (non-auto-continue) message means the user/trigger is driving again →
  // reset the D auto-continue guard so a future background-wait gets fresh budget.
  if (!originContinue) { waitInjector.resetAuto(sessionName); waitInjector.resetBg(sessionName); waitInjector.resetInterrupted(sessionName); waitInjector.resetBgResult(sessionName); }
  // Ensure session-level state exists even when no WS client is connected.
  if (!cs) {
    const csCli = persisted.cli || 'claude';
    if (csCli === 'claude' && !persisted.cliSessionId) {
      persisted.cliSessionId = crypto.randomUUID();
      savePersistedSessionsBestEffort('runtime.chat-session-id-allocate');
    }
    const hist = initialHistory || loadChatHistory(sessionName);
    cs = {
      clients: new Set(),
      claudeProc: null,
      lineBuf: '',
      cli: csCli,
      chatTurnCount: hist.filter(m => m.role === 'assistant').length,
      cwd: cwdForSession(persisted),
      currentAssistantText: '',
      currentToolCalls: [],
      currentCost: null,
      isStreaming: false,
      streamReplay: [],
      _classifyTimer: null,
      _classifyTaskId: null,
      _currentTaskId: taskContextHost.restore(hist),
    };
    chatSessions.set(sessionName, cs);
  }

  cancelClassify(cs);
  if (!originContinue) {
    apiErrorHost.cancelRetry(sessionName, cs);
    cs._apiRetryAttempt = 0;
    cs._lastApiErrorDecision = null;
    setTaskState(sessionName, { apiError: null }, { save: false });
  }
  const detachTaskContext = (!requestedTask.id && opts.schedulerWorkKind === 'task')
    || (!!originDispatchId && !requestedTask.id);
  const {
    taskId: nextTaskId, boundaryChanged: taskBoundaryChanged,
    detached: taskDetached,
  } = taskContextHost.beginTurn(cs, requestedTask, { detach: detachTaskContext });

  // Persist the canonical user event before any provider execution.
  const userMessageSaved = appendChatMessage(sessionName, {
    role: 'user', content: text, ts: Date.now(),
    clientMsgId: clientMsgId || undefined,
    deliveryId: deliveryId || undefined,
    originDispatchId: originDispatchId || undefined,
    ...taskContextHost.messageMetadata(requestedTask, nextTaskId, { detached: taskDetached }),
    bgTaskIds: Array.isArray(bgTaskIds) && bgTaskIds.length ? bgTaskIds : undefined,
    bgToolUseIds: Array.isArray(bgToolUseIds) && bgToolUseIds.length ? bgToolUseIds : undefined,
  });
  const durableMessageProof = createDurableMessageProof(turnRequest, { persisted: userMessageSaved });
  if (!userMessageSaved) {
    preparationFailure = 'message-not-durable';
    console.error(`[multicc/chat] [${sessionName}] refusing turn: user message was not persisted`);
    chatBroadcast(sessionName, { type: 'error', error: '消息未能持久化，已安全停止本轮；系统稍后会重试。' });
    setSessionStatus(sessionName, { status: 'idle', currentFile: null });
    return false;
  }
  messageDurable = true;
  if (opts.userInputRequestId) {
    const resolvedInput = userInputSignalHost.resolve(sessionName, opts.userInputRequestId);
    if (!resolvedInput.ok) {
      preparationFailure = resolvedInput.code || 'user-input-resolution-rejected';
      throw new Error(`pending user input resolution rejected: ${preparationFailure}`);
    }
  }
  const messageMarked = chatTurnPreparationRuntime.markMessageDurable(sessionName, turnId);
  if (!messageMarked.ok) {
    preparationFailure = messageMarked.code || 'message-proof-rejected';
    throw new Error(`turn message proof rejected: ${preparationFailure}`);
  }
  userInputSignalHost.beginTurn(sessionName, { originContinue, turnId });

  // Reset accumulators
  cs.currentAssistantText = '';
  cs.currentUserText = text;          // store user message for summary context
  // Synchronous task goal fallback (zero-latency first frame); the in-progress
  // classify loop will refine it to a stable noun-phrase goal within 60s.
  ensureCurrentTask(cs, sessionName, text, taskBoundaryChanged);
  cs.currentTaskName = cs.currentTask ? cs.currentTask.goal : '新任务'; // compat for legacy callers
  cs.currentToolCalls = [];
  cs.currentCost = null;
  cs.isStreaming = true;
  preparationStateActivated = true;
  cs.turnStartedAt = Date.now();  // for per-reply interaction latency (durationMs)
  cs.lastStreamAt = cs.turnStartedAt;  // watchdog baseline: don't inherit prior turn's stale lastStreamAt
  cs.streamReplay = [];
  cs._resultSaved = false;
  // Auto-prune the claude transcript before --resume so it never exceeds the
  // context window. cwd MUST be cwdForSession(persisted): the record has no .cwd
  // field, so persisted.cwd was undefined and this silently no-op'd. Best-effort —
  // a prune failure must never crash the turn.
  if (persisted.cli === 'claude') {
    try { require('./src/chat/transcript-prune').maybePrune(cwdForSession(persisted), persisted.cliSessionId); }
    catch (_) {}
  }
  cs._adapterError = null;
  cs._sawApiError = false;
  cs._activeTurn = turn;
  cs._activeRunner = null;
  cs._continuationLineage = { turnId: turn.turnId, lineage: turn.lineage };
  turnProgressHeartbeat.start(sessionName, turn.turnId, { phase: 'starting' });
  // Reset the per-turn role breakdown (main vs sub) collected by the claude-proxy
  // onUsage hook. A new user turn starts a fresh "本轮" window, so stale subagent
  // totals from the previous turn must not bleed into the new one.
  resetRoleTokenUsage(sessionName);
  cs._codexRecoveredDisconnect = false;
  cs._codexPendingStreamError = '';
  cs._codexPendingStreamErrorCount = 0;
  cs._codexTransportError = '';
  cs._codexStreamContinuationCount = 0;

  // Task start: show a neutral placeholder instantly. We do NOT classify here —
  // the turn's output hasn't been produced yet, so a mid-turn verdict would be
  // judged against an empty/partial reply. The real goal + C/W/E/P/D are decided
  // once at turn end (classifyTurnEnd); the periodic scan re-judges non-D/W.
  cancelClassify(cs);
  emitRunningNotify(sessionName, `处理中：${(cs.currentTask && cs.currentTask.goal) || '新任务'}`);
  // Trigger/dispatch lineage is owned by `turn`; no session-global origin flag
  // is written here, so a stale finalize cannot leak ancestry into a new turn.
  setSessionStatus(sessionName, { status: 'thinking', currentFile: null });

  const provider = providerFor(cs);
  // For claude: first turn → --session-id <uuid>, subsequent → --resume <uuid>.
  // For codex:  first turn → exec --json, subsequent → exec resume <id> --json.
  const isFirstTurn = turnRequest.execution.isFirstTurn;

  // Unified message assembly (src/message-composer.js — message-builder Phase 2).
  // composeMessage builds the prompt text (cross-agent notes → gateway/dispatch →
  // goal-limit → user text → ultracode suffix) AND fires the notes-delivered side
  // effects, byte-for-byte identical to the former inline assembly that lived here
  // (regression-gated by tests/test-message-composer-golden.js suite 1). The
  // notes side effects now live INSIDE composeMessage, so they are intentionally
  // NOT duplicated here. renderPrompt() also provides stable text for retry and
  // continuation turns; every process invocation is built by the adapter.
  let envelope;
  try {
    envelope = composeMessage({
      text, persisted, sessionName,
      opts: { isFirstTurn, goalLimits, mode: cs.cli === 'claude' ? 'streaming' : 'per-turn' },
      deps: {
        resolveRolePrompt: folderMemory.resolveRolePrompt, multiccImgHint: MULTICC_IMG_HINT,
        buildCliHandoffPrompt: (session) => renderHandoffPrompt(session && session.pendingCliHandoff),
        buildGatewayPrompt, buildDispatchContextPrompt, buildGoalLimitNote,
        pendingNotesFor, saveNotes, appendEvent, workspaceBroadcast, chatBroadcast,
        normalizeEffort, cliEffortLevel,
      },
    });
  } catch (e) {
    // composeMessage.validateEnvelope THROWS when NODE_ENV !== 'production', and
    // the multicc server is started via nohup/launchd without NODE_ENV set. Valid
    // turns never produce a violating envelope, so this catch is defense-in-depth:
    // a future envelope-construction bug degrades to a clean, visible per-turn abort
    // instead of an uncaught throw that could crash the process through the
    // synchronous trigger path (bus.emit('chat:run')).
    console.error(`[multicc/chat] [${sessionName}] composeMessage failed, aborting turn: ${e && e.message ? e.message : e}`);
    preparationFailure = 'message-compose-failed';
    try { chatBroadcast(sessionName, { type: 'error', error: `消息组装失败：${e && e.message ? e.message : e}` }); } catch (_) {}
    setSessionStatus(sessionName, { status: 'idle', currentFile: null });
    cs.isStreaming = false;
    return false;
  }
  const promptText = renderPrompt(envelope);
  // Provider routing is resolved before every invocation so all runners consume
  // the same adapter-produced command contract.
  const provEnv = providerRouterRuntime.resolveSpawnEnv(persisted);
  const invocationEnvelope = {
    ...envelope,
    spawnOpts: {
      ...envelope.spawnOpts,
      skipDefaultModel: provEnv.skipDefaultModel,
      providerModel: provEnv.providerModel,
      providerModels: provEnv.providerModels,
      rawModel: provEnv.qualifiedModel || envelope.spawnOpts.rawModel,
    },
  };
  const invocation = provider.buildInvocation(invocationEnvelope);
  const providerRouteProof = createProviderRouteProof(turnRequest, { resolved: true });
  const routeMarked = chatTurnPreparationRuntime.markProviderRouteResolved(sessionName, turnId, { resolved: true });
  if (!routeMarked.ok) {
    preparationFailure = routeMarked.code || 'provider-route-proof-rejected';
    throw new Error(`provider route proof rejected: ${preparationFailure}`);
  }
  const spawnGuard = evaluateSpawnGuard(turnRequest, {
    message: durableMessageProof,
    route: providerRouteProof,
    runtime: chatTurnPreparationRuntime.claimProof(sessionName, turnId),
  });
  if (!spawnGuard.ok) {
    preparationFailure = spawnGuard.code || 'spawn-proof-missing';
    throw new Error(`turn spawn refused: ${(spawnGuard.missing || []).join(', ')}`);
  }
  const started = chatTurnPreparationRuntime.start(sessionName, turnId);
  if (!started.ok) {
    preparationFailure = started.code || 'runtime-start-rejected';
    throw new Error(`turn runtime start rejected: ${preparationFailure}`);
  }

  // ── Streaming path (claude only — always on) ──
  // Persistent process kept warm across turns so a turn that ends in a
  // "waiting for external data" state leaves a live, in-context process ready
  // to continue (fed by the next message / the waiting-injector) instead of a
  // dead one needing a cold --resume. Streaming is now claude chat's only mode
  // (the per-turn toggle was removed); non-claude CLIs use the per-turn spawn
  // path below, unchanged.
  if (cs.cli === 'claude') {
    const accepted = runChatTurnStreaming(sessionName, cs, persisted, invocation, provider, turn);
    if (!accepted) {
      preparationFailure = 'stream-runner-rejected';
      return false;
    }
    runnerHandedOff = true;
    const released = chatTurnPreparationRuntime.settle(sessionName, turnId, {
      status: 'delegated', reason: 'claude-stream',
    });
    preparationOpen = false;
    if (!released.ok) {
      logger.error('chat_turn_preparation_release_failed_after_handoff', {
        sessionId: sessionName, turnId, runner: 'claude-stream', code: released.code,
      });
    }
    return true;
  }

  const args = [...invocation.args, invocation.payload];
  console.log(`[multicc/chat] Spawning ${cs.cli} (turn ${cs.chatTurnCount}, first=${isFirstTurn}${provEnv.providerName ? `, provider=${provEnv.providerName}` : ''}): ${invocation.cmd} ${args.join(' ').slice(0, 200)}...`);

  // Retry and transport-continuation turns reuse already-rendered text without
  // re-running composeMessage's note-delivery side effects.
  const buildBareInvocation = (bareText, firstTurn) => provider.buildInvocation({
    ...invocationEnvelope,
    contextLayers: [],
    userText: bareText,
    suffix: '',
    historyHandle: {
      ...invocationEnvelope.historyHandle,
      isFirstTurn: firstTurn,
      cliSessionId: persisted.cliSessionId,
    },
    spawnOpts: { ...invocationEnvelope.spawnOpts, ultracode: false },
  });

  const spawnChat = (spawnArgs, isRetry, apiRetryAttempt = 0) => {
    const { env: childEnv } = providerRouterRuntime.buildChildEnv(process.env, persisted, {
      TERM: 'dumb', NO_COLOR: '1',
      // Let the bundled multicc-trigger skill know who it is and where the
      // localhost API lives, so it can register/manage triggers for us.
      MULTICC_SESSION_ID: sessionName,
      MULTICC_DIR_ID: persisted.dirId || '',
      MULTICC_BASE_URL: `http://127.0.0.1:${PORT}`,
    });
    if (persisted.cli === 'claude') providers.applyClaudeProxyEnv(childEnv, {
        providerId: persisted.provider, sessionId: sessionName,
        subagent: persisted.subagent, port: PORT, enabled: CLAUDE_PROXY_ENABLED,
        officialOAuth: CLAUDE_OFFICIAL_VIA_PROXY,
      });
    if (persisted.cli === 'codex') {
      providers.applyCodexProxyConfig(childEnv, {
        providerId: persisted.provider, sessionId: sessionName,
        subagent: persisted.subagent, port: PORT,
      });
    }
    const proc = routerToolHost.spawnProcess({
      cli: persisted.cli, spawn, command: invocation.cmd,
      args: spawnArgs, cwd: cs.cwd, env: childEnv,
      sessionId: sessionName, turnId: turn.turnId, originDispatchId,
      userText: turn.userText,
      baseUrl: `http://127.0.0.1:${PORT}`,
    });
    const runner = createRunnerOwnership(turn, {
      runnerId: `proc_${proc.pid || 'pending'}_${crypto.randomBytes(6).toString('hex')}`,
      kind: 'process',
    });
    runner.apiRetryAttempt = Math.max(0, Number(apiRetryAttempt) || 0);
    cs._activeTurn = turn;
    cs._activeRunner = runner;
    cs.claudeProc = proc;

    const spawnTs = Date.now();
    console.log(`[multicc/chat] [${sessionName}] ${cs.cli} spawned pid=${proc.pid} turn=${cs.chatTurnCount} isRetry=${!!isRetry} clients=${cs.clients.size}`);
    let stderrBuf = '';
    const isActiveProc = () => cs.claudeProc === proc && isCurrentTurnRunner(cs, turn, runner);

    // Normalize a single JSONL line into the claude-shaped event stream the frontend
    // already consumes. Returns an array of events to forward (may be empty), or null
    // to forward the original event as-is (claude path).
    const handleLine = (line) => {
      let evt;
      try { evt = JSON.parse(line); } catch { return; }

      applyAdapterChatEvent(provider, cs, persisted, sessionName, evt, forward, turn, runner);
    };

    const forward = (evt) => {
      cs.lastStreamAt = Date.now();  // watchdog: last live stream activity (stuck-isStreaming detection)
      turnProgressHeartbeat.touchVisible(sessionName, turn.turnId);
      cs.streamReplay.push(evt);
      if (cs.streamReplay.length > 500) cs.streamReplay.shift();
      chatBroadcast(sessionName, evt);
    };

    proc.stdout.on('data', (chunk) => {
      if (!isActiveProc()) return;
      cs.lineBuf += chunk.toString();
      const lines = cs.lineBuf.split('\n');
      cs.lineBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { handleLine(line); } catch (_) {}
      }
    });

    proc.stderr.on('data', (chunk) => {
      if (!isActiveProc()) return;
      stderrBuf += chunk.toString();
      logger.warn('chat_provider_stderr', {
        sessionId: sessionName,
        provider: cs.cli,
        message: sanitizeApiErrorMessage(chunk.toString()),
      });
    });

    proc.on('error', (err) => {
      if (!isActiveProc()) return;
      runner.apiErrorRaw = {
        source: 'process_stderr',
        provider: cs.cli,
        code: err && err.code || 'spawn_failed',
        message: err && err.message,
      };
      logger.error('chat_provider_spawn_error', {
        sessionId: sessionName,
        provider: cs.cli,
        code: err && err.code || 'spawn_failed',
      });
    });

    proc.on('close', (code, signal) => {
      if (!isActiveProc()) {
        console.log(`[multicc/chat] [${sessionName}] stale proc pid=${proc.pid} closed after replacement (code=${code}, signal=${signal || ''})`);
        return;
      }
      if (cs.lineBuf.trim()) {
        try { handleLine(cs.lineBuf); } catch (_) {}
      }
      cs.lineBuf = '';
      const durMs = Date.now() - spawnTs;
      const killReason = runner.killReason || null;
      const pendingStreamError = cs._codexPendingStreamError || '';
      const pendingTransportError = cs._codexTransportError || '';
      const pendingStreamErrorCount = cs._codexPendingStreamErrorCount || 0;
      const hasTurnOutput = !!(cs._resultSaved || cs.currentAssistantText || cs.currentToolCalls.length);
      if (pendingStreamError && !hasTurnOutput && !cs._adapterError) {
        cs._adapterError = pendingStreamError;
        chatBroadcast(sessionName, { type: 'error', error: `Codex 出错：${pendingStreamError}` });
      }
      const recoveredCodexDisconnect = (!!cs._codexRecoveredDisconnect || !!pendingStreamError) && hasTurnOutput;
      const sanitizedStderrTail = sanitizeApiErrorMessage(stderrBuf.slice(-300).trim(), '');
      const diag = {
        session: sessionName, cli: cs.cli, pid: proc.pid, code, signal, durMs, killReason,
        resultSaved: !!turn.resultDurable,
        gotText: (cs.currentAssistantText || '').length,
        toolCalls: cs.currentToolCalls.length,
        liveClients: cs.clients.size,
        isRetry: !!isRetry,
        recoveredCodexDisconnect,
        pendingTransportError: pendingTransportError.slice(0, 200),
        pendingStreamErrorCount,
        stderrTail: sanitizedStderrTail,
      };
      let kind = 'normal';
      if (signal) kind = killReason ? `killed(${killReason})` : `signaled(${signal})`;
      else if (code !== 0 && !recoveredCodexDisconnect) kind = 'nonzero_exit';
      else if (!turn.resultDurable && !cs.currentAssistantText && !cs.currentToolCalls.length) kind = 'empty_exit';
      console.log(`[multicc/chat] [${sessionName}] close kind=${kind} ${JSON.stringify(diag)}`);
      const partialOutput = meaningfulTurnOutput(cs);
      const sideEffects = turnHasSideEffects(cs);
      const shouldClassifyApiError = !!(
        runner.apiErrorRaw
        || runner.sawApiError
        || runner.adapterError
        || pendingTransportError
        || killReason
        || code !== 0
        || (!turn.resultDurable && !hasTurnOutput)
      );
      const rawApiError = killReason ? {
        source: 'process_stderr',
        provider: cs.cli,
        code: killReason,
        message: 'turn cancelled',
      } : runner.apiErrorRaw || {
        source: 'process_stderr',
        provider: cs.cli,
        code: killReason || (code !== 0 ? `process_exit_${code}` : 'empty_exit'),
        message: pendingTransportError || sanitizedStderrTail || (killReason ? 'turn cancelled' : 'provider returned no result'),
      };
      const apiErrorDecision = shouldClassifyApiError
        ? evaluateTurnApiError({
          sessionName,
          cs,
          persisted,
          turn,
          runner,
          raw: rawApiError,
          attempt: runner.apiRetryAttempt || 0,
          phase: partialOutput || sideEffects ? 'stream' : 'before_first_token',
          partialOutput,
          sideEffects,
        })
        : null;
      const closeCheckpointKey = assistantCheckpointKey(cs);
      const finalizePlan = planTurnFinalization({
        current: true,
        runnerKind: 'process',
        cli: cs.cli,
        code,
        signal,
        killReason,
        apiError: !!apiErrorDecision || !!runner.sawApiError,
        apiErrorDecision,
        adapterError: !!runner.adapterError,
        retryBlockedByAdapterError: !!cs._adapterError,
        retryPlanned: !!runner.retryPlanned,
        resultEvent: !!runner.resultEvent,
        resultDurable: !!turn.resultDurable,
        hasOutput: hasTurnOutput,
        sameDurablePartial: hasMatchingPartialCheckpoint(runner, closeCheckpointKey),
        isRetry: !!isRetry,
        recoveredTransport: recoveredCodexDisconnect,
        pendingStreamError,
        nativeSession: !!persisted.cliSessionId,
        codexDisconnectAttempt: cs._codexStreamContinuationCount || 0,
        freshStartAttempt: isRetry ? 1 : 0,
        handoff: persisted.pendingCliHandoff,
        auxUnhealthy: auxQueue.isUnhealthy(),
      }, {
        retry: { limits: { codexDisconnect: CODEX_STREAM_DISCONNECT_CONTINUE_MAX } },
      });

      if (finalizePlan.action === 'continue-codex') {
        cs._codexStreamContinuationCount = finalizePlan.retry.attempt;
        cs._codexRecoveredDisconnect = false;
        cs._codexPendingStreamError = '';
        cs._codexPendingStreamErrorCount = 0;
        cs.isStreaming = true;
        cs.lastStreamAt = Date.now();  // watchdog: fresh baseline for the continuation spawn (turnStartedAt may be >10min old)
        const continuePrompt = codexStreamDisconnectContinuePrompt();
        const continueInvocation = buildBareInvocation(continuePrompt, false);
        const continueArgs = [...continueInvocation.args, continueInvocation.payload];
        const msg = isGlm52Session(persisted)
          ? `正在使用 GLM-5.2 最高档：检测到连接中断，正在自动续跑剩余任务（${cs._codexStreamContinuationCount}/${CODEX_STREAM_DISCONNECT_CONTINUE_MAX}）。`
          : `检测到 Codex 连接中断，正在自动续跑剩余任务（${cs._codexStreamContinuationCount}/${CODEX_STREAM_DISCONNECT_CONTINUE_MAX}）。`;
        chatBroadcast(sessionName, { type: 'system', subtype: 'warning', message: msg });
        setSessionStatus(sessionName, { status: 'running', currentFile: null });
        console.warn(`[multicc/chat] [${sessionName}] auto-continuing codex after response.completed disconnect #${cs._codexStreamContinuationCount}`);
        runner.retryPlanned = true;
        cs.claudeProc = spawnChat(continueArgs, true);
        return;
      }

      if (finalizePlan.action === 'retry-fresh') {
        const stderrTail = stderrBuf.slice(-300).trim();
        const reason = pendingTransportError ? 'codex transport disconnected'
          : stderrTail.includes('already in use') ? 'session-id conflict'
          : stderrTail.includes('No conversation found') || stderrTail.includes('session not found') ? 'resume target missing'
          : `exit ${code}${signal ? '/' + signal : ''}`;
        logger.warn('chat_empty_exit_fresh_retry', {
          sessionId: sessionName,
          provider: cs.cli,
          reason,
          stderr: sanitizeApiErrorMessage(stderrTail),
        });
        // Reset session id so the retry starts a brand-new conversation
        if (cs.cli === 'claude') persisted.cliSessionId = crypto.randomUUID();
        else persisted.cliSessionId = null;  // codex will allocate on first turn
        rememberActiveCliState(persisted);
        savePersistedSessionsBestEffort('runtime.chat-session-retry-reset');
        cs.chatTurnCount = 0;
        cs.isStreaming = true;
        cs.lastStreamAt = Date.now();  // watchdog: fresh baseline for the retry spawn (turnStartedAt may be >10min old)
        cs.streamReplay = [];
        cs._codexTransportError = '';
        const fallbackInvocation = buildBareInvocation(promptText, true);
        const fallbackArgs = [...fallbackInvocation.args, fallbackInvocation.payload];
        chatBroadcast(sessionName, {
          type: 'system', subtype: 'warning',
          message: `${cs.cli} 启动失败（${reason}），已用新会话重试`,
        });
        runner.retryPlanned = true;
        cs.claudeProc = spawnChat(fallbackArgs, true);
        return;
      }
      if (finalizePlan.action === 'retry-api') {
        cs.claudeProc = null;
        scheduleOwnedRetry({
          sessionName, cs, persisted, turn, runner,
          decision: finalizePlan.retry, provider: cs.cli,
          start: () => spawnChat(spawnArgs, true, finalizePlan.retry.attempt),
        });
        return;
      }
      turnProgressHeartbeat.stop(sessionName, turn.turnId);
      turnFinalizationExecutor.execute(finalizePlan, {
        runnerKind: 'process', sessionName, cs, persisted, turn, runner,
        code,
        signal,
        stderrTail: sanitizedStderrTail,
        pendingTransportError,
      });
    });

    return proc;
  };

  cs.claudeProc = spawnChat(args, false);
  if (!cs.claudeProc) {
    preparationFailure = 'process-runner-rejected';
    return false;
  }
  runnerHandedOff = true;
  const released = chatTurnPreparationRuntime.settle(sessionName, turnId, {
    status: 'delegated', reason: 'cli-process',
  });
  preparationOpen = false;
  if (!released.ok) {
    logger.error('chat_turn_preparation_release_failed_after_handoff', {
      sessionId: sessionName, turnId, runner: 'cli-process', code: released.code,
    });
  }
  return true;
  } catch (error) {
    if (preparationFailure === 'preparation-failed') preparationFailure = 'preparation-exception';
    if (runnerHandedOff) {
      logger.error('chat_turn_host_error_after_runner_handoff', {
        sessionId: sessionName, turnId, error: error && error.message,
      });
      preparationOpen = false;
      return true;
    }
    console.error(`[multicc/chat] [${sessionName}] turn preparation failed before runner handoff: ${error && error.message ? error.message : error}`);
    const publicError = messageDurable
      ? '消息已保存，但本轮准备失败，尚未启动新的 CLI 请求。'
      : '本轮准备失败，尚未启动新的 CLI 请求。';
    try { chatBroadcast(sessionName, { type: 'error', error: publicError }); } catch (_) {}
    if (cs && preparationStateActivated) cs.isStreaming = false;
    if (preparationStateActivated) {
      setSessionStatus(sessionName, { status: 'idle', currentFile: null });
    }
    return false;
  } finally {
    if (preparationOpen) {
      turnProgressHeartbeat.stop(sessionName, turnId);
      chatTurnPreparationRuntime.settle(sessionName, turnId, {
        status: 'failed', reason: preparationFailure,
      });
    }
  }
}
// Chat domain owns runChatTurn; other domains reach it without require()-ing chat:
//  • fire-and-forget (triggers): bus event 'chat:run'
//  • need the return value (gateway): registry service 'chat.runTurn'
bus.on('chat:run', (sessionName, text, opts) => {
  admitChatWork(sessionName, text, opts).catch(error => {
    logger.error('chat_work_admission_failed', {
      sessionId: sessionName,
      error: error.message,
    });
  });
});
services.provide('chat.runTurn', admitChatWork);

// ── Wait injector: continue a session when external data arrives (A/B/D) ──
function orchestrationChatBusy(session) {
  const cs = chatSessions.get(session);
  if (cs && cs.claudeProc) return true;
  const st = chatStream.status(session);
  return !!(st && st.busy);
}

function persistedOrchestrationDelivery(session, deliveryId) {
  if (!deliveryId) return false;
  try {
    return chatHistoryService.hasPersistedDelivery(session, deliveryId);
  } catch (_) {
    return false;
  }
}

function probeExplicitWait(metadata) {
  if (metadata.pollUrl) {
    return fetch(metadata.pollUrl).then(response => response.text());
  }
  return new Promise(resolve => {
    require('child_process').exec(
      metadata.pollCmd,
      { cwd: metadata.cwd, timeout: 20000, maxBuffer: 1024 * 1024, env: process.env },
      (err, stdout, stderr) => resolve(`${stdout || ''}${stderr || ''}`),
    );
  });
}

function recoverDispatchOperation(operation) {
  const history = loadChatHistory(operation.spec.chatId);
  const requestId = operation.requestOutboxId;
  const userIndex = history.findIndex(message => message && message.role === 'user' && (
    message.originDispatchId === operation.id
    || message.deliveryId === requestId
    || message.clientMsgId === requestId
  ));
  if (userIndex < 0) return null;
  for (let index = userIndex + 1; index < history.length; index++) {
    const message = history[index];
    if (!message || message.role !== 'assistant') continue;
    if (message._interim || message.partial || message.cancelled || message.error) {
      return { completed: false, lastOutput: String(message.content || '').slice(-4000) };
    }
    return { completed: true, text: String(message.content || '') };
  }
  return { completed: false, lastOutput: '' };
}

function deliverOrchestrationOutbox({ item, sessionId, text, opts }) {
  if (item.payload?.type === 'dispatch.request' && isNetworkUnhealthy()) return false;
  if (item.payload?.type === 'dispatch.result' && item.payload.gateway) {
    const saved = appendChatMessage(GATEWAY_ID, {
      role: 'assistant',
      content: text,
      ts: Date.now(),
      clientMsgId: opts.clientMsgId,
      deliveryId: opts.deliveryId,
    });
    if (saved) pushToGateway(text, { persist: false });
    return saved;
  }
  return runChatTurn(sessionId, text, opts);
}

orchestrationRuntime = createOrchestrationRuntime({
  file: MULTICC_PATHS.orchestrationFile,
  runChatTurn,
  isBusy: taskBoardSessionBusy,
  hasPersistedDelivery: persistedOrchestrationDelivery,
  deliverOutbox: deliverOrchestrationOutbox,
  probe: probeExplicitWait,
  detachedAdapter: detached,
  recoverDispatchResult: recoverDispatchOperation,
  replayRecoveredDispatchEffects: () => {},
  getSessionRecoveryState: id => sessionWorkHost.recoveryState(id),
  onSchedulerEvent: event => sessionWorkHost.onSchedulerEvent(event),
  workerIntervalMs: Math.max(100, Number(process.env.MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS) || 1000),
  log: message => console.log('[multicc/wait]', message),
});
routerToolHost.configure({ records: persistedSessions, dispatchToSession,
  orchestrationRuntime, taskBoard: taskBoardRuntime,
  recordUserInput: signal => sessionWorkHost.recordInput(signal) });

waitInjector.init({
  // Continuations preserve origin metadata; originContinue stays the default.
  inject: (session, text, opts) => admitChatWork(session, text, {
    originContinue: true,
    ...(opts || {}),
  }),
  isBusy: orchestrationChatBusy,
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
  cancelActiveTurn: sessionId => sessionWorkHost.cancelActiveTurn(sessionId),
}).mountRoutes(app);

// ── Streaming chat turn (persistent process; see runChatTurn's streaming branch) ──
// Feeds the prompt into the session's long-lived `claude` process and forwards
// events through the SAME applyClaudeChatEvent() the per-turn path uses, so the
// UI sees identical events. The turn boundary is the `result` event (handled
// inside applyClaudeChatEvent); finalizeStreamingTurn() then does the
// process-independent cleanup (stream_end, gateway回流) WITHOUT killing the proc.
function runChatTurnStreaming(sessionName, cs, persisted, invocation, provider, turn, apiRetryAttempt = 0) {
  // Per-session provider env. buildChildEnv strips inherited ANTHROPIC_* routing
  // vars before applying the provider env, so the provider choice is always
  // authoritative — see providers.CLAUDE_ROUTING_KEYS. The full computed env is
  // passed through; chat-stream uses it verbatim (no second process.env merge).
  const { env: childEnv } = providerRouterRuntime.buildChildEnv(process.env, persisted, {
    TERM: 'dumb', NO_COLOR: '1',
    MULTICC_SESSION_ID: sessionName,
    MULTICC_DIR_ID: persisted.dirId || '',
    MULTICC_BASE_URL: `http://127.0.0.1:${PORT}`,
  });
  providers.applyClaudeProxyEnv(childEnv, {
    providerId: persisted.provider, sessionId: sessionName,
    subagent: persisted.subagent, port: PORT, enabled: CLAUDE_PROXY_ENABLED,
    officialOAuth: CLAUDE_OFFICIAL_VIA_PROXY,
  });
  const resumeExistingStream = !!persisted._streamSessionId;
  if (!persisted._streamSessionId) {
    persisted._streamSessionId = crypto.randomUUID();
    rememberActiveCliState(persisted);
    savePersistedSessionsBestEffort('runtime.streaming-session-id-allocate');
  }
  chatStream.ensure(sessionName, {
    cmd: invocation.cmd,
    cwd: cs.cwd,
    sessionId: persisted._streamSessionId,
    resume: resumeExistingStream,
    baseArgs: invocation.args,
    onNewSessionId: (newId) => {
      persisted._streamSessionId = newId;
      rememberActiveCliState(persisted);
      savePersistedSessionsBestEffort('runtime.streaming-session-id-capture');
    },
    beforeSpawn: ({ sessionId }) => {
      routerToolHost.refreshPersistentProcess(cs, childEnv,
        { sessionId: sessionName, baseUrl: `http://127.0.0.1:${PORT}` });
      const cleaned = typeof provider.prepareSpawn === 'function'
        ? provider.prepareSpawn({ sessionId })
        : 0;
      if (cleaned > 0) {
        chatHistoryService.invalidate(sessionName);
        console.log(`[multicc/chat] [${sessionName}] sanitized ${cleaned} empty thinking block(s) from session JSONL`);
      }
    },
    env: childEnv,
    onDispose: () => routerToolHost.releasePersistentProcess(cs),
    onBackgroundEvent: (evt) => backgroundTaskRuntime.handleEvent(sessionName, cs, evt),
    isBackgroundActive: () => backgroundTaskRuntime.hasLiveBackgroundTasks(sessionName),
    onExit: () => {
      try {
        const reaped = backgroundTaskRuntime.reapSessionShadows(sessionName, { reason: 'stream_exit' });
        if (reaped > 0) console.log(`[multicc/chat] [${sessionName}] stream exited; reaped ${reaped} background task(s)`);
      } catch (error) {
        logger.warn('bg_reap_on_exit_failed', { sessionId: sessionName, error: error.message });
      }
    },
  });

  // An in-flight turn (if any) was already interrupted at the top of
  // runChatTurn. Claim this turn's sequence number so a late finalize from a
  // superseded turn can't clobber us.
  const mySeq = cs._streamTurnSeq = (cs._streamTurnSeq || 0) + 1;
  const runner = createRunnerOwnership(turn, {
    runnerId: `stream_${mySeq}_${crypto.randomBytes(6).toString('hex')}`,
    kind: 'stream', sequence: mySeq,
  });
  runner.apiRetryAttempt = Math.max(0, Number(apiRetryAttempt) || 0);
  cs._activeTurn = turn;
  cs._activeRunner = runner;

  const forward = (evt) => {
    cs.lastStreamAt = Date.now();  // watchdog: last live stream activity (stuck-isStreaming detection)
    turnProgressHeartbeat.touchVisible(sessionName, turn.turnId);
    cs.streamReplay.push(evt);
    if (cs.streamReplay.length > 500) cs.streamReplay.shift();
    chatBroadcast(sessionName, evt);
  };

  console.log(`[multicc/chat] [${sessionName}] (streaming) send turn=${cs.chatTurnCount} model=${persisted.model || 'default'} status=${JSON.stringify(chatStream.status(sessionName))}`);
  chatStream.send(sessionName, invocation.payload, (evt) => {
    if (!isCurrentTurnRunner(cs, turn, runner)) return;
    applyAdapterChatEvent(provider, cs, persisted, sessionName, evt, forward, turn, runner);
  })
    .then(() => finalizeStreamingTurn(sessionName, cs, persisted, mySeq, turn, runner, invocation, provider))
    .catch((err) => {
      if (!runner.killReason) {
        runner.sawApiError = true;
        runner.apiErrorRaw = {
          source: 'anthropic_event',
          provider: provider.name,
          code: err && err.code,
          message: err && err.message,
        };
      }
      logger.warn('chat_stream_ended_early', {
        sessionId: sessionName,
        provider: provider.name,
        code: err && err.code || null,
        killed: !!runner.killReason,
      });
      finalizeStreamingTurn(sessionName, cs, persisted, mySeq, turn, runner, invocation, provider);
    });

  return true;
}

// The pure planner describes both runner endings; this injected host adapter is
// the only place that maps those effects back to MultiCC runtime services.
const turnFinalizationExecutor = createTurnFinalizationExecutor({
  persistAssistant(context, append) {
    return persistFinalAssistantResult(context.sessionName, context.cs, context.turn, context.runner, {
      role: 'assistant',
      content: context.cs.currentAssistantText,
      tools: context.cs.currentToolCalls.length ? context.cs.currentToolCalls : undefined,
      cost: context.cs.currentCost,
      ts: Date.now(),
      ...(append.partial ? { partial: true } : {}),
    }, { final: append.final });
  },
  commitUsage(context) {
    recordDurableTurnUsage(context.sessionName, context.runner, context.runner.pendingUsage);
  },
  broadcast: chatBroadcast,
  cancelClassify,
  clearIncrementalSave: sessionName => chatHistoryRuntime.clearIncrementalSave(sessionName),
  setStatus(sessionName, status) {
    setSessionStatus(sessionName, { status, currentFile: null });
  },
  classifyTurnEnd,
  resetInterrupted: sessionName => waitInjector.resetInterrupted(sessionName),
  resumeInterrupted: sessionName => waitInjector.resumeInterrupted(sessionName),
  freezeInterrupted(sessionName, reason) {
    Promise.resolve(orchestrationRuntime?.sessionScheduler?.freeze(sessionName, reason))
      .catch(() => {});
  },
  emitTurnOutcome,
  runPostTurn(context, entry) {
    runDurablePostTurn(
      context.sessionName,
      context.cs,
      context.persisted,
      context.turn,
      context.runner,
      context.finalText || '',
      {
        interrupted: entry.interrupted,
        apiError: entry.apiError,
        retryPlanned: entry.retryPlanned,
        handoffResumeFailure: entry.handoffResumeFailure,
      },
    );
  },
  log(event, fields) {
    if (event === 'interrupted-resume') {
      console.log(`[multicc/chat] [${fields.sessionName}] (streaming) 非正常中断 (no result event, kill=none) → resume`);
    }
  },
  logError(event, fields) {
    if (event === 'post-turn-failed') console.error('[multicc/dispatch] post-turn hook failed:', fields.error.message);
  },
});

// Process-independent end-of-turn cleanup for the streaming path. Guarded by
// the turn sequence so a superseded (interrupted) turn's late completion can't
// clobber the turn that replaced it.
function finalizeStreamingTurn(sessionName, cs, persisted, seq, turn, runner, invocation, provider) {
  if (seq !== undefined && cs._streamTurnSeq !== seq) return; // superseded by a newer turn
  if (!isCurrentTurnRunner(cs, turn, runner)) return;
  const partialOutput = meaningfulTurnOutput(cs);
  const sideEffects = turnHasSideEffects(cs);
  const shouldClassifyApiError = !!(
    runner.apiErrorRaw
    || runner.sawApiError
    || runner.adapterError
    || runner.killReason
    || (!runner.resultEvent && !turn.resultDurable)
  );
  const rawApiError = runner.killReason
    ? {
      source: 'anthropic_event',
      provider: persisted.cli || 'claude',
      code: runner.killReason,
      message: 'turn cancelled',
    }
    : runner.apiErrorRaw || {
      source: 'host_interruption',
      provider: persisted.cli || 'claude',
      code: 'stream_ended_without_result',
      message: 'stream ended without a result event',
    };
  const apiErrorDecision = shouldClassifyApiError
    ? evaluateTurnApiError({
      sessionName,
      cs,
      persisted,
      turn,
      runner,
      raw: rawApiError,
      attempt: runner.apiRetryAttempt || 0,
      phase: partialOutput || sideEffects ? 'stream' : 'before_first_token',
      partialOutput,
      sideEffects,
    })
    : null;
  const finalizeCheckpointKey = assistantCheckpointKey(cs);
  const plan = planTurnFinalization({
    current: true,
    runnerKind: 'stream',
    cli: persisted.cli || 'claude',
    killReason: runner.killReason || null,
    apiError: !!apiErrorDecision || !!runner.sawApiError,
    apiErrorDecision,
    adapterError: !!runner.adapterError,
    retryPlanned: !!runner.retryPlanned,
    resultEvent: !!runner.resultEvent,
    resultDurable: !!turn.resultDurable,
    hasOutput: !!(cs.currentAssistantText || cs.currentToolCalls.length),
    sameDurablePartial: hasMatchingPartialCheckpoint(runner, finalizeCheckpointKey),
    handoff: persisted.pendingCliHandoff,
  });
  turnProgressHeartbeat.stop(sessionName, turn.turnId);
  if (plan.action === 'retry-api') {
    scheduleOwnedRetry({
      sessionName, cs, persisted, turn, runner,
      decision: plan.retry, provider: persisted.cli || 'claude',
      start: () => runChatTurnStreaming(
        sessionName, cs, persisted, invocation, provider, turn, plan.retry.attempt),
    });
    return;
  }
  turnFinalizationExecutor.execute(plan, {
    runnerKind: 'stream', sessionName, cs, persisted, turn, runner,
  });
}

// ── Chat mode: stream-json WebSocket ──
function handleChatWs(ws, req, urlObj) {
  const sessionName = urlObj.searchParams.get('session') || '_default';
  const persisted = persistedSessions.get(sessionName);
  if (!persisted) {
    sendWs(ws, { type: 'error', error:
      `Chat session "${sessionName}" does not exist. Create it via the dashboard first.` });
    ws.close();
    return;
  }
  if (persisted.kind && persisted.kind !== 'chat') {
    sendWs(ws, { type: 'error', error:
      `Session "${sessionName}" is not a chat session (kind=${persisted.kind}).` });
    ws.close();
    return;
  }
  if (invalidSessions.has(sessionName)) {
    sendWs(ws, { type: 'error', error:
      `会话已失效（${invalidSessions.get(sessionName)}），请删除后重建。` });
    ws.close();
    return;
  }
  const cli = persisted.cli || 'claude';
  const cwd = cwdForSession(persisted);

  // Get or create session-level state
  let cs = chatSessions.get(sessionName);
  if (!cs) {
    // For claude: pre-allocate the session UUID (needed for --session-id on first turn).
    // For codex: leave null; captured from `thread.started` event on first turn.
    if (cli === 'claude' && !persisted.cliSessionId) {
      persisted.cliSessionId = crypto.randomUUID();
      savePersistedSessionsBestEffort('websocket.chat-session-id-allocate');
    }

    const history = loadChatHistory(sessionName);
    cs = {
      clients: new Set(),
      claudeProc: null,   // (kept name for backwards compat in rest of handler; holds any cli child proc)
      lineBuf: '',
      cli,
      chatTurnCount: history.filter(m => m.role === 'assistant').length,
      cwd,
      currentAssistantText: '',
      currentToolCalls: [],
      currentCost: null,
      isStreaming: false,
      streamReplay: [],
      _classifyTimer: null,
      _classifyTaskId: null,
      _currentTaskId: taskContextHost.restore(history),
    };
    chatSessions.set(sessionName, cs);
  }

  cs.clients.add(ws);

  // Resolve Provider identity and the shared cumulative/daily window view from
  // the token runtime so initial WS state and post-turn broadcasts cannot drift.
  const { providerId: provId, windows: provWindows } = providerTokenWindows(sessionName);
  let provName = null;
  if (provId) {
    try { provName = providers.getProvider(undefined, provId)?.name || null; } catch (_) {}
  }

  sendWs(ws, {
    type: 'system', subtype: 'init',
    cwd: cs.cwd, session: sessionName, session_id: sessionName,
    cli: cs.cli,
    is_streaming: cs.isStreaming,
    model: persisted.model || null,
    effectiveModel: effectiveSessionModel(persisted),
    effort: persisted.effort || null,
    effectiveEffort: effectiveSessionEffort(persisted),
    agent: persisted.agent || null,
    providerId: provId,
    providerName: provName,
    providerTokenWindows: provWindows,
    cliStates: cliStateSummary(persisted),
    cliAvailability: cliAvailabilitySummary(),
    pendingCliHandoff: cliHandoffSummary(persisted),
  });

  // Replay saved history + in-progress assistant response (if any).
  // Send only the newest page over WS on connect; older messages are fetched
  // on demand via GET /history?before=<id> as the user scrolls up.
  // The replay helper also recognizes the crash-safety `_interim` record. It
  // promotes that stable-id entry to the one live streaming tail, rather than
  // sending both the persisted first batch and a cumulative id-less copy.
  const canonicalPage = chatHistoryRuntime.paginate(sessionName, { limit: CHAT_HISTORY_PAGE });
  const page = { messages: canonicalPage.messages, hasMore: canonicalPage.hasMore };
  const replayMessages = buildReplayMessages(page.messages, cs);
  // Include authoritative cumulative token usage from the persistent
  // accumulator so the frontend doesn't need to reconstruct it from the
  // rolling chat_history window (which trims old messages).
  const tokenUsage = getTokenUsage();
  // Existing Codex ledgers contain cumulative snapshots added once per turn.
  // Until an operator performs a controlled on-disk rebuild, derive the chat
  // header from non-mutating history projection so it agrees with the fixed
  // per-message footers immediately after upgrade.
  const sessionTokenUsage = persisted.cli === 'codex'
    ? summarizeHistoryUsage(loadChatHistory(sessionName))
    : tokenUsage[sessionName] || null;
  if (replayMessages.length > 0 || sessionTokenUsage) {
    sendWs(ws, { type: 'chat_history', messages: replayMessages, tokenUsage: sessionTokenUsage, hasMore: page.hasMore });
    // Seed the aux classify bar with the current task snapshot on connect, so
    // the goal/phase shows immediately (not only after the next classify).
    try {
      const ts0 = getTaskState(persistedSessions.get(sessionName));
      if (ts0 && (ts0.goal || (ts0.phase && ts0.phase !== 'idle'))) {
        sendWs(ws, { type: 'task_state', goal: ts0.goal || '', phase: ts0.phase || 'idle', classifyState: ts0.classifyState || null });
      }
    } catch (_) {}
    // If chat_history already includes the in-progress assistant message
    // (appended just above), skip the streamReplay so the client doesn't
    // receive duplicate events that would create a second bubble.
    if (replayMessages.length > 0) {
      const lastMsg = replayMessages[replayMessages.length - 1];
      if (lastMsg.role === 'assistant' && cs.isStreaming && cs.streamReplay.length > 0) {
        cs.streamReplay = [];
      }
    }
  }

  // If a stream is in progress, replay buffered events so reconnected client
  // catches up. This is a synchronous burst of up to streamReplay.length
  // (capped at 500) frames — it must bypass the backpressure MESSAGE-count cap
  // via sendImmediate(), or the burst trips queue_overflow → 1013 close → the
  // client reconnects → re-floods → infinite reconnect loop (the bug that hit
  // long streaming turns). sendImmediate still honours the byte cap + congestion
  // timer, so a genuinely slow client is still protected. Falls back to sendWs
  // if backpressure isn't installed (defensive; it always is here).
  if (cs.isStreaming && cs.streamReplay.length > 0) {
    const bp = ws._multiccBackpressure;
    for (const evt of cs.streamReplay) {
      try {
        if (bp && typeof bp.sendImmediate === 'function') {
          bp.sendImmediate(JSON.stringify(createWsEnvelope(evt)));
        } else {
          sendWs(ws, evt);
        }
      } catch (_) {}
    }
  }

  // On (re)connect, push the authoritative live background-task set so the
  // frontend can settle any danmaku spinner whose one-shot `monitor_done` was
  // lost during a disconnect (it never enters streamReplay).
  try {
    sendWs(ws, { type: 'background_tasks', tasks: backgroundTaskRuntime.listActiveBackgroundTasks(sessionName) });
  } catch (_) {}
  try {
    sessionWorkHost.replayState(sessionName, event => sendWs(ws, event));
  } catch (_) {}

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Heartbeat is always allowed.
      if (msg.type === 'ping') {
        try { sendWs(ws, { type: 'pong' }); } catch (_) {}
        return;
      }
      // ── Share-scope gate ──
      // view  = read-only: drop everything except ping.
      // operate = read-write: allow user_message/cancel/typing, but block
      //   admin/destructive ops (clear_history, etc.) — shares never get those.
      if (ws._sharePerm === 'view') return;
      if (ws._sharePerm === 'operate' && !['user_message', 'cancel', 'typing'].includes(msg.type)) return;

      // Typing signal: user is composing → cancel pending intent classify
      if (msg.type === 'typing') {
        cancelClassify(cs);
        return;
      }

      if (msg.type === 'cancel') {
        await sessionWorkHost.cancelActiveTurn(sessionName, { resolveQueue: true });
        return;
      }

      if (msg.type === 'clear_history') {
        await chatHistoryRuntime.clearHistory(sessionName, msg, cs);
        return;
      }

      if (msg.type === 'user_message' && msg.text) {
        // Gateway: a bare 确认/取消 resolves a pending dispatch without running the LLM.
        if (persisted.type === 'gateway' && handleGatewayControl(msg.text)) return;
        const turnOpts = msg.goal ? { goalLimits: resolveGoalLimits(msg.goalLimits) } : {};
        if (typeof msg.clientMsgId === 'string' && msg.clientMsgId.trim()) turnOpts.clientMsgId = msg.clientMsgId;
        if (typeof msg.userInputRequestId === 'string' && msg.userInputRequestId.trim()) {
          turnOpts.userInputRequestId = msg.userInputRequestId.trim();
        }
        const pendingMemory = getPendingMemoryDistill(sessionName);
        const deliver = () => taskContextHost.deliverSessionMessage(sessionName, msg.text, turnOpts);
        if (pendingMemory) pendingMemory.finally(deliver);
        else await deliver();
        return;
      }
    } catch (e) {
      console.error('[multicc/chat] Bad message:', e.message);
    }
  });

  ws.on('close', () => {
    cs.clients.delete(ws);
    // Do NOT kill claudeProc on disconnect — it may still be streaming to other clients
    // or the user may reconnect (lock screen, tab switch, etc.)
    // Process is only killed on explicit cancel or new user_message
  });
}

// ── WebSocket connections ──
wss.on('connection', async (ws, req) => {
  if (_shuttingDown) {
    ws.close(1012, 'server shutting down');
    return;
  }
  const urlObj = new URL(req.url, 'http://localhost');
  installWsBackpressure(ws, {
    onMetric: (name, value, op) => op === 'set' ? metrics.set(name, value) : metrics.inc(name, value),
    onLog: (event, fields) => logger.warn(event, { ...fields, correlationId: ws._correlationId }),
  });

  // Share-scoped chat WS: a valid share token for the requested session grants
  // access WITHOUT ACCESS_TOKEN, scoped to that one session at its access level.
  // ws._sharePerm ('view'|'operate') drives the read-only / read-write gate in
  // handleChatWs. (Re-validated inside handleChatWs as the authority.)
  let sharePerm = null;
  if (urlObj.pathname === '/ws/chat' && urlObj.searchParams.get('share')) {
    const a = share.access(urlObj.searchParams.get('share'), { cookies: parseCookies(req.headers.cookie) });
    if (a && a.sessionId === urlObj.searchParams.get('session')) sharePerm = a.access;
    if (!sharePerm) { ws.close(4003, 'Forbidden'); return; }
  }

  // External WebSockets exchange the normal HTTP auth for a one-use, path-bound
  // ticket. Local bridges remain ticket-free. Old cookie/query WS auth is an
  // explicit migration opt-in and is counted so operators can remove it.
  if (!sharePerm) {
    const ip = req.socket.remoteAddress;
    const isLocal = isLocalRequest(req);
    const cookies = parseCookies(req.headers.cookie);
    const ticket = ACCESS_TOKEN && authSecurity.consumeWsTicket(urlObj.searchParams.get('ticket'), urlObj.pathname);
    const legacyCookie = ACCESS_TOKEN && ALLOW_LEGACY_WS_COOKIE && cookies.multicc_auth && authSecurity.verifyCookie(cookies.multicc_auth);
    const legacyToken = ACCESS_TOKEN && ALLOW_LEGACY_WS_TOKEN && authSecurity.verifyAccessToken(urlObj.searchParams.get('token'));
    if (ticket) ws._correlationId = ticket.correlationId || ticket.requestId;
    if (legacyCookie || legacyToken) {
      metrics.inc('multicc_ws_legacy_auth_total');
      logger.warn('legacy_ws_auth', { path: urlObj.pathname, mode: legacyToken ? 'query' : 'cookie', ip });
    }
    if (!isLocal && (!ACCESS_TOKEN || (!ticket && !legacyCookie && !legacyToken))) {
      metrics.inc('multicc_ws_auth_denied_total');
      ws.close(4003, 'Forbidden');
      return;
    }
  }

  // Route to chat handler if path matches
  if (urlObj.pathname === '/ws/chat') {
    ws._sharePerm = sharePerm; // null for normal (full) clients
    return handleChatWs(ws, req, urlObj);
  }

  // Route to streaming voice (ASR) proxy
  if (urlObj.pathname === '/ws/voice') {
    return voiceAsr.handleVoiceWs(ws, req, urlObj);
  }

  // Route to streaming TTS proxy
  if (urlObj.pathname === '/ws/tts') {
    return ttsService.handleTtsWs(ws, req);
  }

  // Route to the per-directory workspace status board
  if (urlObj.pathname === '/ws/workspace') {
    return workspaceRuntime.attachWorkspace(ws, urlObj);
  }

  // Route to the global meta event bus (all directories, all sessions).
  // Subscribers receive every workspace event fleet-wide, plus an initial
  // snapshot of every session across every directory. The voice/meta assistant
  // subscribes here to hold the whole board.
  if (urlObj.pathname === '/ws/meta') {
    return workspaceRuntime.attachMeta(ws);
  }

  // Route to aux queue monitor (read-only WebSocket for __aux__ session)
  if (urlObj.pathname === '/ws/aux') {
    auxQueue.attachClient(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // Send current status + recent history on connect
    sendWs(ws, { type: 'aux_init', status: auxQueue.getStatus(), health: { ...auxQueue.health } });
    const history = loadChatHistory(AUX_SESSION_ID);
    sendWs(ws, { type: 'aux_history', messages: history.slice(-100) });
    return;
  }

  let sessionId = urlObj.searchParams.get('id') || '';
  let session;

  if (sessionId && sessions.has(sessionId)) {
    session = sessions.get(sessionId);
    console.log(`[multicc] Client attached to session ${sessionId} (${session.clients.size + 1} total)`);
  } else {
    const persisted = persistedSessions.get(sessionId);
    if (!persisted) {
      sendWs(ws, { type: 'error', data:
        `Session ${sessionId} does not exist.\r\n` +
        `Create one in the dashboard first (Manage → pick a directory → + Terminal).\r\n` });
      ws.close();
      return;
    }
    if (persisted.kind && persisted.kind !== 'terminal') {
      sendWs(ws, { type: 'error', data:
        `Session ${sessionId} is a ${persisted.kind} session, not a terminal.\r\n` });
      ws.close();
      return;
    }
    console.log(`[multicc] Spawning terminal session ${sessionId}`);
    try {
      session = await createSession(sessionId);
    } catch (err) {
      const cliLabel = persisted.cli || 'claude';
      const msg = `Failed to launch ${cliLabel}: ${err.message}\r\n` +
        `Make sure "${cliLabel === 'qoder' ? 'qoderclicn' : cliLabel}" is installed and available in PATH.\r\n` +
        `You can also set the ${cliLabel.toUpperCase()}_CMD environment variable.\r\n`;
      sendWs(ws, { type: 'error', data: msg });
      ws.close();
      return;
    }
  }

  session.clients.add(ws);

  // Keep-alive tracking (server pings periodically)
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Tell client its session ID
  sendWs(ws, { type: 'session_id', id: sessionId, cli: session.cli || 'claude' });

  // Don't replay buffered output — the toggle-resize trick below forces a full TUI
  // redraw at the client's actual dimensions, which is the only way to get correct layout.

  // WebSocket messages → PTY input / resize
  // Resize ownership: only the "primary" client (most recent input sender) controls resize.
  // This prevents multi-window resize wars (e.g. desktop + mobile).
  let inputBuf = '';
  let firstResize = true;
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input') {
        // Track cd commands to keep session.cwd up to date
        for (const ch of msg.data) {
          if (ch === '\r' || ch === '\n') {
            const line = inputBuf.trim();
            // Strip ANSI/VT escape sequences (e.g. bracketed-paste \x1b[200~…\x1b[201~)
            const cleanLine = line.replace(/\x1b(?:\[[0-9;?]*[A-Za-z~]|.)/g, '');
            const cdMatch = cleanLine.match(/^cd(?:\s+(.+))?$/);
            if (cdMatch) {
              const arg = (cdMatch[1] || '').trim().replace(/^["']|["']$/g, '');
              const newCwd = resolveCwd(session.cwd, arg);
              session.cwd = newCwd;
              // Note: directory path is NOT updated — cwd drift within a shell is local to the session.
              console.log(`[multicc] Session ${session.id} cwd → ${newCwd}`);
            }
            inputBuf = '';
          } else if (ch === '\x03' || ch === '\x15') {
            // Ctrl+C or Ctrl+U clears the line
            inputBuf = '';
          } else if (ch === '\x7f' || ch === '\b') {
            inputBuf = inputBuf.slice(0, -1);
          } else if (ch >= ' ') {
            inputBuf += ch;
          }
        }
        // Mark this client as primary (it's actively typing → it controls resize)
        session.primaryClient = ws;
        tmuxWriteInput(session.id, msg.data);
        session.lastActivity = new Date();
        // Reset push monitor on user input (Enter key)
        if (msg.data.includes('\r') || msg.data.includes('\n')) {
          pushOnInput(session.id);
        }
      } else if (msg.type === 'resize') {
        const cols = Math.max(1, msg.cols);
        const rows = Math.max(1, msg.rows);
        ws._desiredCols = cols;
        ws._desiredRows = rows;

        // Tmux pane = max across all attached clients. On a sole-client first
        // resize, send a +1 toggle to force the TUI to redraw at the right size.
        if (firstResize && session.clients.size <= 1) {
          firstResize = false;
          tmuxResize(session.id, cols + 1, rows);
          session.appliedCols = cols + 1;
          session.appliedRows = rows;
        }
        applyMaxClientSize(session);
      } else if (msg.type === 'upload') {
        const { tempId, name, mime, data } = msg;
        const origExt = (name && path.extname(name).replace(/^\./, '')) || '';
        const ext = origExt.replace(/[^a-z0-9]/gi, '').slice(0, 10)
          || (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8);
        const safeName = `multicc_${Date.now()}.${ext}`;
        const tmpPath = path.join(os.tmpdir(), safeName);
        fs.writeFileSync(tmpPath, Buffer.from(data, 'base64'), { mode: 0o600 });
        console.log(`[multicc] Saved upload: ${tmpPath}`);
        sendWs(ws, { type: 'file_saved', tempId, path: tmpPath, name });
      }
    } catch (e) {
      console.error('[multicc] Bad message:', e.message, e.stack);
    }
  });

  ws.on('close', () => {
    session.clients.delete(ws);
    if (session.primaryClient === ws) session.primaryClient = null;
    // The departing client may have been the widest/tallest — recompute and
    // shrink tmux if the remaining clients all want a smaller pane.
    applyMaxClientSize(session);
    console.log(`[multicc] Client left session ${sessionId} (${session.clients.size} remaining)`);
  });

  ws.on('error', (err) => {
    console.error('[multicc] WebSocket error:', err.message);
    session.clients.delete(ws);
    if (session.primaryClient === ws) session.primaryClient = null;
    applyMaxClientSize(session);
  });
});

// WebSocket keep-alive: ping clients every 30s, terminate unresponsive ones
const wsPingInterval = setInterval(() => {
  wss.clients.forEach(client => {
    if (client.isAlive === false) return client.terminate();
    client.isAlive = false;
    client.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(wsPingInterval));

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
cronTasks.init({ directories, createSessionRecord, runChatTurn, sessionExists: (id) => persistedSessions.has(id) });
// In-process external-tunnel monitor (replaces phtunnel-monitor.sh watchdog).
tunnel.init();

// Graceful shutdown checkpoints partial turns, drains, then closes dependencies.
function flushInFlightChats() {
  // Prevent a delayed interim write from landing after the shutdown partial
  // checkpoint and recreating a trailing duplicate message.
  if (chatHistoryRuntime) chatHistoryRuntime.clearAllIncrementalSaves();
  let n = 0;
  for (const [name, cs] of chatSessions) {
    if (!cs || cs._resultSaved) continue;
    const hasText = !!(cs.currentAssistantText && cs.currentAssistantText.length);
    const hasTools = !!(cs.currentToolCalls && cs.currentToolCalls.length);
    if (!hasText && !hasTools) continue;
    try {
      const saved = appendChatMessage(name, {
        role: 'assistant',
        content: cs.currentAssistantText || '',
        tools: hasTools ? cs.currentToolCalls : undefined,
        cost: cs.currentCost,
        ts: Date.now(),
        partial: true,   // saved mid-turn on shutdown; may be incomplete
      });
      if (saved) {
        const turn = cs._activeTurn;
        const runner = cs._activeRunner;
        if (turn && runner && isCurrentTurnRunner(cs, turn, runner)) {
          recordPartialCheckpoint(turn, runner, {
            current: true, persisted: true, checkpointKey: assistantCheckpointKey(cs),
          });
        }
        cs._resultSaved = true;
        n++;
      }
    } catch (_) {}
  }
  return n;
}
const SHUTDOWN_GRACE_MS = 60000;   // max time to let in-flight turns finish
const shutdownCoordinator = createShutdownCoordinator({ logger: console });
const serviceTimers = new Set();

function trackServiceTimer(timer) {
  if (!timer) return timer;
  serviceTimers.add(timer);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function clearServiceTimers() {
  for (const timer of serviceTimers) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  serviceTimers.clear();
}

async function quiesceRuntimeSources() {
  serviceReady = false;
  try { waitInjector.stop(); } catch (_) {}
  try { cronTasks.stop(); } catch (_) {}
  try { tunnel.stop(); } catch (_) {}
  try { stopNetworkProbe(); } catch (_) {}
  try { await skillSyncRuntime.stop(); } catch (_) {}
  try { await triggerRuntime.stop(); } catch (_) {}
  try { pushRuntime.stop(); } catch (_) {}
  try { if (chatHistoryRuntime) chatHistoryRuntime.stop(); } catch (_) {}
  clearServiceTimers();
}

async function stopBridgeRuntime() {
  const bridges = [wechatBridge, feishuBridge, telegramBridge, discordBridge, slackBridge];
  await Promise.allSettled(bridges.map(bridge => {
    if (!bridge || typeof bridge.stopBridge !== 'function') return undefined;
    return bridge.stopBridge();
  }));
}

function closeWebSocketRuntime() {
  return new Promise(resolve => {
    try {
      for (const client of wss.clients) {
        try { client.close(1012, 'server restarting'); } catch (_) {}
        try { client.terminate(); } catch (_) {}
      }
      wss.close(() => resolve());
      const fallback = setTimeout(resolve, 1000);
      if (fallback.unref) fallback.unref();
    } catch (_) { resolve(); }
  });
}

async function closeSessionRuntime() {
  turnProgressHeartbeat.stopAll();
  backgroundTaskRuntime.stopAll();
  for (const [name, cs] of chatSessions) {
    try { cancelClassify(cs); } catch (_) {}
    if (cs) assignKillReason(cs._activeRunner, 'shutdown');
    try { chatStream.close(name); } catch (_) {}
    if (cs && cs.claudeProc) {
      try { cs.claudeProc.kill('SIGTERM'); } catch (_) {}
      cs.claudeProc = null;
    }
    if (cs && cs.clients) cs.clients.clear();
  }

  const captures = [];
  for (const [id, session] of sessions) {
    sessions.delete(id); // prevents onStreamEnd from re-opening the FIFO
    if (session.captureTimer) clearInterval(session.captureTimer);
    if (session.exitCheckTimer) clearInterval(session.exitCheckTimer);
    if (session._statusIdleTimer) clearTimeout(session._statusIdleTimer);
    try { cleanupPushMonitor(id); } catch (_) {}
    captures.push(Promise.resolve(stopOutputCapture(session)).catch(() => {}));
  }
  await Promise.allSettled(captures);
}

function stopAuxQueue() {
  const error = Object.assign(new Error('server is shutting down'), { code: 'SERVER_SHUTTING_DOWN' });
  for (const task of auxQueue.queue.splice(0)) {
    task.cancelled = true;
    try { task.reject(error); } catch (_) {}
  }
  if (auxQueue.currentTask) auxQueue.currentTask.cancelled = true;
}

// Bridge legacy _shuttingDown flag callers still consult (e.g. the restart
// endpoint) to the coordinator's readiness bit. They stay wire-compatible.
Object.defineProperty(global, '_shuttingDownCoordinated', {
  get: () => shutdownCoordinator.isShuttingDown(),
});

// Checkpoint FIRST: partial-in-memory-only state → disk, synchronously.
shutdownCoordinator.onCheckpoint(() => {
  try { flushInFlightChats(); }
  catch (e) { console.error(`[multicc] shutdown flush error: ${e.message}`); }
  // Teardown is explicitly best-effort: make one final attempt to flush any
  // dirty runtime session snapshot, but never turn a transient EIO into an
  // uncaught shutdown failure.
  savePersistedSessionsBestEffort('teardown.checkpoint');
});
// Stop every source of NEW work before drain. Existing turns are left alive and
// may still complete naturally during the grace window.
shutdownCoordinator.onCheckpoint(() => quiesceRuntimeSources());

// Drain: give live turns time to reach their natural `result` event so their
// FULL assistant message is persisted (not a half-written partial). Two kinds
// of in-flight turn:
//   • legacy per-turn child proc — alive until proc 'close' nulls cs.claudeProc
//     after the result is saved.
//   • streaming turn — NO per-turn child; it runs on the persistent chatStream
//     process and its liveness is chatStream.status(name).busy (not cs.claudeProc).
shutdownCoordinator.onDrain(async ({ graceMs }) => {
  const isStreamingBusy = (name, cs) => cs && cs.cli === 'claude' && !!chatStream.status(name)?.busy;
  const draining = new Set();
  for (const [name, cs] of chatSessions) {
    if (cs && (cs.claudeProc || isStreamingBusy(name, cs))) draining.add(name);
  }
  const auxBusy = () => !!(auxQueue.processing || auxQueue.queue.length);
  if (draining.size === 0 && !auxBusy()) return;
  console.log(`[multicc] shutdown → draining ${draining.size} chat turn(s)${auxBusy() ? ' + aux queue' : ''} (grace ${graceMs}ms)`);
  const t0 = Date.now();
  await new Promise(resolve => {
    const timer = setInterval(() => {
      for (const name of [...draining]) {
        const cs = chatSessions.get(name);
        if (!cs || (!cs.claudeProc && !isStreamingBusy(name, cs))) draining.delete(name);
      }
      if (draining.size === 0 && !auxBusy()) { clearInterval(timer); resolve(); }
      else if (Date.now() - t0 > graceMs) { clearInterval(timer); resolve(); }
    }, 300);
  });
  // Second checkpoint pass: any turns that hadn't reached `result` by grace get
  // their partial saved so restart still shows what the agent had streamed.
  try {
    const n = flushInFlightChats();
    if (n) console.log(`[multicc] shutdown flushed ${n} partial message(s) after drain`);
  } catch (e) { console.error(`[multicc] post-drain flush error: ${e.message}`); }
});

// Closers: HTTP server first (stop accepting new turns) → chokidar watchers
// (below where they are created, they call shutdownCoordinator.onClose(fn)).
// Wired here for the HTTP server itself.
shutdownCoordinator.onClose(() => new Promise(resolve => {
  try {
    if (server && server.listening) {
      server.close(() => resolve());
      // If close() doesn't finish in 2s (long-poll clients hanging on), don't
      // block PM2's kill_timeout — hard-close remaining sockets.
      setTimeout(() => { try { server.closeAllConnections?.(); } catch (_) {} resolve(); }, 2000).unref();
    } else {
      resolve();
    }
  } catch (_) { resolve(); }
}));

shutdownCoordinator.onClose(() => stopBridgeRuntime());
shutdownCoordinator.onClose(() => closeWebSocketRuntime());
shutdownCoordinator.onClose(async () => {
  stopAuxQueue();
  await closeSessionRuntime();
});

shutdownCoordinator.onClose(() => {
  routerToolHost.clear();
  return orchestrationRuntime ? orchestrationRuntime.stop() : undefined;
});
shutdownCoordinator.onClose(() => sessionPersistence.stop());

function gracefulShutdown(sig) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  shutdownCoordinator.shutdown({ reason: sig, graceMs: SHUTDOWN_GRACE_MS, exitCode: 0 })
    .catch(e => { console.error(`[multicc] shutdown driver error: ${e && e.message}`); process.exit(1); });
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

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
    console.log(`\n  MultiCC is running at http://${BIND_HOST.includes(':') ? `[${BIND_HOST}]` : BIND_HOST}:${PORT}\n`);
    console.log(`  Manage sessions at http://${BIND_HOST.includes(':') ? `[${BIND_HOST}]` : BIND_HOST}:${PORT}/manage\n`);
    console.log(`  Use Tailscale / ngrok for HTTPS access from external devices.\n`);
    seedTokenUsageFromHistory();
    backfillReportedModels();                       // recover runtime model for pre-upgrade sessions
    skillSyncRuntime.start();
    triggerRuntime.start();
    // Periodic scan: re-judge non-terminal/junk sessions every minute. First
    // tick delayed 6s so aux warms up and WS clients reconnect. Replaces the
    // old one-shot startup reconcile - restart just means the first tick runs.
    trackServiceTimer(setTimeout(() => scanAndReclassify(), 6000));
    trackServiceTimer(setInterval(() => scanAndReclassify(), SCAN_INTERVAL_MS));
    artifacts.cleanup();
    trackServiceTimer(setInterval(() => artifacts.cleanup(), 6 * 3600 * 1000));
    // ④: probe aux recovery every 5 min while unhealthy (no-op when healthy).
    trackServiceTimer(setInterval(() => auxHealthProbe(), AUX_HEALTH_PROBE_INTERVAL_MS));
    serviceReady = true;
  });
})();
