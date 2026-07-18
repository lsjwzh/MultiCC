'use strict';

// Load .env file (lightweight, no dependencies)
const _envPath = require('path').join(__dirname, '.env');
try {
  require('fs').readFileSync(_envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch (_) { /* .env not found, skip */ }

// Force all spawned `claude` children to use the local OAuth subscription login
// in ~/.claude rather than a third-party API relay. If any ANTHROPIC_* routing
// var is present in the inherited env (e.g. leaked in from the shell that ran
// `pm2 start` after a cc-switch to a DeepSeek/relay provider), the claude CLI
// bills against — or worse, routes the `haiku`/`opus`/`sonnet` aliases to — that
// provider's model instead of the subscription. We don't use them anywhere in
// this server (per-session providers re-apply their own via buildChildEnv), so
// strip the ANTHROPIC_* routing-key set here so every child inherits a clean
// env. The list is owned by src/providers.js (ANTHROPIC_ROUTING_KEYS) — import
// it rather than re-inline, so the two can't drift (CLAUDE_CODE_SIMPLE and the
// other CLAUDE_CODE_* markers are stripped separately below).
const { ANTHROPIC_ROUTING_KEYS } = require('./src/providers');
for (const k of ANTHROPIC_ROUTING_KEYS) {
  if (process.env[k]) { console.log(`[multicc] stripping inherited ${k} so claude uses the OAuth subscription`); delete process.env[k]; }
}

// Backstop: strip Claude Code "SDK / simple mode" markers that leak into this
// server's own env (they get baked into the pm2 daemon whenever `pm2 start` /
// `pm2 restart` is run from inside an interactive Claude Code session). The
// critical one is CLAUDE_CODE_SIMPLE=1: a spawned `claude` child that inherits
// it enters SDK/simple mode and its tool set collapses from ~28 tools down to
// just Read/Edit/Bash — no Agent, no Task*, no Workflow, no mcp__*, no Skill
// (empirically verified). buildChildEnv() already strips it for the chat spawn
// path, but other spawn paths (run-detached, gateway, detached sessions)
// inherit process.env directly and would leak it. Deleting here at startup
// means EVERY spawn path inherits a clean value. The sibling CLAUDE_CODE_* /
// CLAUDECODE markers are pure leakage here too — this server is not itself a
// claude-code child/sdk session — so they're stripped as well; CLAUDE_CODE_SIMPLE
// is the only one that affects the tool set, but the rest are cleaned up for
// hygiene so a spawned child never mistakes itself for a nested session.
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
const { execSync, execFileSync, spawn } = require('child_process');
const multer = require('multer');
const chokidar = require('chokidar');
const cron = require('node-cron');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
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
const { runGit: gitRunQueued, queueDepth: gitQueueDepth, makeTtlCache } = require('./src/git-queue');

const crypto = require('crypto');
const bus = require('./src/bus');
const services = require('./src/services');
const state = require('./src/state');
const artifacts = require('./src/artifacts');
const providers = require('./src/providers');
const { executeAuxHttp } = require('./src/aux-http');
const tokenGlobal = require('./src/token-global');
const { createRoleTokenTracker } = require('./src/role-token-tracker');
const { createCliAdapters } = require('./src/cli-adapters');
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
const { mountCodexProxy, mountClaudeProxy } = require('cli-provider-router');
// Data-directory + persistence infrastructure. MULTICC_DATA_DIR (defaults to
// __dirname) is the ONE knob to swap where state lives; every file path used to
// resolve state (sessions.json, directories.json, journal, chat history, …)
// now flows through `MULTICC_PATHS` so tests can point at a mkdtemp dir and
// the production install keeps behaving exactly as before. state-store gives
// atomic writes + rolling backups + fail-closed loads; state-tx replays the
// on-disk journal for cross-file mutations (directory delete → both
// directories.json and sessions.json) so a mid-write crash is recoverable.
const { createPaths } = require('./src/paths');
const stateStore = require('./src/state-store');
const stateTx = require('./src/state-tx');
const { createShutdownCoordinator } = require('./src/shutdown');
const { requestIdMiddleware, safeErrorHandler } = require('./src/http-errors');
const {
  createAuthSecurity,
  normalizeRedirect,
  escapeHtmlAttribute,
} = require('./src/auth-security');
const { envEnabled, resolveNetworkPolicy, selectListenPort } = require('./src/network-policy');
const { createObservability, installConsoleRedaction } = require('./src/observability');
const { installWsBackpressure } = require('./src/ws-backpressure');
const { createHealthHandlers } = require('./src/health');
const { secureRuntimeData, atomicWriteJson, atomicWriteText, ensurePrivateDir } = require('./src/runtime-security');
const MULTICC_PATHS = createPaths({ dataDir: process.env.MULTICC_DATA_DIR });
const observability = createObservability({ service: 'multicc' });
const { logger, metrics } = observability;
installConsoleRedaction(console);
secureRuntimeData(MULTICC_PATHS);
stateStore.setFailureReporter((error, meta) => {
  metrics.inc('multicc_persistence_failures_total');
  logger.error('persistence_failure', { ...meta, error: error && error.message });
});
const networkPolicy = resolveNetworkPolicy(process.env);
const app = express();
app.locals.observability = observability;

// ── Access token authentication (cookie-based login) ──
// `let` (not const): editable at runtime via /api/settings/access-token from
// localhost, hot-reloaded without restart (persisted to .env).
let ACCESS_TOKEN = networkPolicy.accessToken;
const authSecurity = createAuthSecurity({ getSecret: () => ACCESS_TOKEN });
const ALLOW_LEGACY_TOKEN_QUERY = envEnabled(process.env.MULTICC_ALLOW_LEGACY_TOKEN_QUERY);
const ALLOW_LEGACY_WS_TOKEN = envEnabled(process.env.MULTICC_ALLOW_LEGACY_WS_TOKEN);
const ALLOW_LEGACY_WS_COOKIE = envEnabled(process.env.MULTICC_ALLOW_LEGACY_WS_COOKIE);

function authCookieHeader(req, value = authSecurity.createCookie()) {
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return `multicc_auth=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`;
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  }
  return cookies;
}

function isExternalProxy(req) {
  // Reverse proxies connect from loopback but retain a public Host header. Treat
  // every non-loopback Host on a loopback socket as external, not just a small
  // suffix allowlist (custom PhDDNS/ngrok domains are common).
  const rawHost = String(req.headers.host || '').trim().toLowerCase();
  const host = rawHost.startsWith('[') ? rawHost.slice(1, rawHost.indexOf(']')) : rawHost.split(':')[0];
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  return !localHost || host.endsWith('.ts.net') || host.endsWith('.ngrok.io') || host.endsWith('.ngrok-free.app');
}

// True only for requests physically originating from this machine (not a
// reverse proxy forwarding external traffic). Used both for the localhost
// auth bypass and to gate editing the access token.
function isLocalRequest(req) {
  const ip = req.ip || req.connection.remoteAddress;
  return (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') && !isExternalProxy(req);
}

function isAuthenticated(req) {
  if (!ACCESS_TOKEN) return !isExternalProxy(req);
  // Localhost allowed — unless it's a reverse proxy forwarding external traffic
  if (isLocalRequest(req)) return true;
  // Cookie auth (HMAC-signed, survives server restart)
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.multicc_auth && authSecurity.verifyCookie(cookies.multicc_auth)) return true;
  if (authSecurity.verifyAccessToken(req.headers['x-access-token'])) return true;
  if (ALLOW_LEGACY_TOKEN_QUERY && authSecurity.verifyAccessToken(req.query.token)) {
    metrics.inc('multicc_auth_legacy_query_total');
    logger.warn('legacy_token_query', { requestId: req.id, path: req.path });
    return true;
  }
  return false;
}

// Always register login routes + auth middleware (no-op while ACCESS_TOKEN is
// empty, see isAuthenticated). This lets a token set later via the localhost UI
// take effect immediately, without restarting the server.
// requestId middleware runs first so every subsequent handler + error response
// can be correlated with a log line. It's cheap (8 hex chars) and always safe.
app.use(requestIdMiddleware);
{
  // Login page & handler
  app.get('/login', (req, res) => {
    const error = req.query.error ? '<p style="color:#f85149;margin-bottom:16px;">密码错误</p>' : '';
    const redirect = normalizeRedirect(req.query.redirect);
    res.type('html').send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>MultiCC — Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',system-ui,sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100vh;min-height:100dvh;
    padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
  .box{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;
    width:min(340px,100%);text-align:center}
  .box h1{font-size:20px;margin-bottom:8px;color:#f0f6fc}
  .box .logo{font-size:24px;font-weight:700;color:#f78166;margin-bottom:24px}
  .box .logo span{color:#79c0ff}
  input[type=password]{width:100%;padding:10px 14px;border-radius:6px;border:1px solid #30363d;
    background:#0d1117;color:#c9d1d9;font-size:16px;min-height:48px;margin-bottom:16px;outline:none}
  input[type=password]:focus{border-color:#58a6ff}
  button{width:100%;padding:10px;border-radius:6px;border:none;background:#238636;
    color:#fff;font-size:16px;font-weight:600;min-height:48px;cursor:pointer}
  button:hover{background:#2ea043}
  @media(max-width:380px){.box{padding:24px 20px}.box .logo{font-size:22px;margin-bottom:20px}}
</style></head><body>
<div class="box">
  <div class="logo">Multi<span>CC</span></div>
  ${error}
  <form method="POST" action="/login">
    <input type="hidden" name="redirect" value="${escapeHtmlAttribute(redirect)}">
    <input type="password" name="password" placeholder="输入访问密码" autofocus>
    <button type="submit">登录</button>
  </form>
</div></body></html>`);
  });

  app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    const redirect = normalizeRedirect(req.body.redirect);
    if (authSecurity.verifyAccessToken(req.body.password)) {
      res.setHeader('Set-Cookie', authCookieHeader(req));
      res.redirect(redirect);
    } else {
      res.redirect(`/login?error=1&redirect=${encodeURIComponent(redirect)}`);
    }
  });

  app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'multicc_auth=; Path=/; HttpOnly; Max-Age=0');
    res.redirect('/login');
  });

  // Auth middleware
  app.use((req, res, next) => {
    // Allow login page, static assets
    if (req.path === '/login' || req.path === '/logout') return next();
    if (req.path === '/healthz' || req.path === '/readyz') return next();
    if (!req.path.startsWith('/api/') && /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|json|apk)$/i.test(req.path)) return next();
    // Wait-callback endpoint is secured by its own per-wait token so external
    // (off-box) systems can deliver results without the ACCESS_TOKEN cookie.
    if (req.method === 'POST' && /^\/api\/wait\/[^/]+\/resolve$/.test(req.path)) return next();
    // Share recipient routes: the share page and its scoped API self-gate on the
    // share token (and per-share password), so they bypass ACCESS_TOKEN. NOTE:
    // admin share management lives under /api/sessions/* and stays gated.
    if (/^\/share\/[^/]+$/.test(req.path)) return next();
    if (/^\/api\/share\/[^/]+\/(auth|session)$/.test(req.path)) return next();
    // Temp artifacts (multicc-artifact skill): the random <id> in the path is an
    // unguessable capability token, so artifact links open without ACCESS_TOKEN —
    // same model as /share/:token above (keep regex in sync with src/artifacts.js).
    if (/^\/artifacts\/[A-Za-z0-9_-]+(?:\/|$)/.test(req.path)) return next();
    // Migration bridge for old bookmarked `?token=` document URLs. Only the
    // top-level HTML navigation is accepted; API and WebSocket query auth stay
    // disabled unless the explicit legacy flag above is set. auth-client.js
    // exchanges this for a cookie and immediately removes it from the address.
    if (req.method === 'GET' && !req.path.startsWith('/api/') && authSecurity.verifyAccessToken(req.query.token)) {
      metrics.inc('multicc_auth_bootstrap_query_total');
      logger.warn('bootstrap_token_query', { requestId: req.id, path: req.path });
      res.setHeader('Set-Cookie', authCookieHeader(req));
      return next();
    }
    if (isAuthenticated(req)) return next();
    // Redirect HTML requests to login, reject API calls with 403
    if (req.headers.accept?.includes('text/html') || (!req.path.startsWith('/api/') && req.method === 'GET')) {
      res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
    } else {
      res.status(403).json({ error: 'Forbidden: not authenticated' });
    }
  });
}

app.post('/api/auth/exchange', (req, res) => {
  if (!ACCESS_TOKEN || !authSecurity.verifyAccessToken(req.headers['x-access-token'])) {
    return res.status(403).json({ error: 'Forbidden: invalid access token' });
  }
  res.setHeader('Set-Cookie', authCookieHeader(req));
  res.status(204).end();
});

app.post('/api/auth/ws-ticket', express.json({ limit: '4kb' }), (req, res) => {
  try {
    const issued = authSecurity.issueWsTicket(req.body && req.body.path || '/', {
      correlationId: req.correlationId || req.id,
      requestId: req.id,
    });
    res.set('Cache-Control', 'no-store');
    res.json(issued);
  } catch (_) {
    res.status(400).json({ error: 'invalid WebSocket path' });
  }
});

let serviceReady = false;
const healthHandlers = createHealthHandlers({ isReady: () => serviceReady && !_shuttingDown });
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
    multicc_active_waits: waitStats.waits,
    multicc_ready: serviceReady && !_shuttingDown ? 1 : 0,
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

// Codex chat runs non-interactively (codex exec --json --dangerously-bypass-approvals-and-sandbox).
// In this mode the request_user_input tool is unavailable (Codex replies "is unavailable in Default mode"),
// and the model can loop calling it repeatedly, stalling the turn. Prepend a short constraint on the
// first turn so the model asks questions as plain assistant text instead. Toggle via env if needed.
const CODEX_NO_ASK_TOOL_HINT = process.env.CODEX_NO_ASK_TOOL_HINT ?? '1';
const CODEX_ENV_CONSTRAINT = CODEX_NO_ASK_TOOL_HINT === '0' ? '' : [
  '[MultiCC 环境约束]',
  '- 当前是非交互执行环境，request_user_input / AskUserQuestion 等向用户提问的工具不可用。',
  '- 需要向用户提问或请求确认时，直接把问题作为普通文本回复发出，不要调用任何提问类工具。',
  '[MultiCC 环境约束结束]',
].join('\n');
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
let CLAUDE_OFFICIAL_VIA_PROXY = String(process.env.CLAUDE_OFFICIAL_VIA_PROXY ?? '0') === '1';

// Read the user's default model from ~/.claude/settings.json on every spawn so
// chat-mode sessions (which `--resume` and would otherwise keep their original
// model forever) follow the current /model choice without a server restart.
function claudeDefaultModel() {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    return typeof settings.model === 'string' && settings.model ? settings.model : null;
  } catch (_) {
    return null;
  }
}

// Resolve the model that will actually be used when spawning this session.
//   session.model (explicit per-session override) wins;
//   otherwise a named provider's primary model (ANTHROPIC_MODEL / codex model);
//   otherwise, for Claude on the default login, the user's /model setting.
// Returns null when unknown (e.g. codex default login, or a Claude provider
// whose env decides the model without declaring ANTHROPIC_MODEL).
function effectiveSessionModel(session) {
  if (!session) return null;
  const appType = (session.cli === 'codex') ? 'codex' : 'claude';
  if (session.model) {
    // Alias-mapped relay: a Claude tier key (opus/sonnet/haiku/fable) stands for
    // a real wire model on this provider (e.g. opus → glm-5.2). Resolve it here so
    // every display (REST, init, cards) shows the real model id instead of the
    // tier alias, without needing the client to have the provider list loaded.
    const providerId = session.provider;
    if (providerId) {
      try {
        const am = providers.getProviderSummary(appType, providerId)?.aliasMap;
        const entry = am && am[session.model];
        if (entry && entry.model) return entry.model;
      } catch (_) { /* fall through */ }
    }
    return session.model;
  }
  const providerId = session.provider;
  if (providerId) {
    try {
      const p = providers.getProviderSummary(appType, providerId);
      if (p && p.model) return p.model;
      // Claude provider with custom base URL but no explicit ANTHROPIC_MODEL:
      // the provider's own env decides at spawn time; we have no concrete value
      // until the CLI reports one at runtime (reportedModel).
      if (appType === 'claude' && p && p.baseUrl) return session.reportedModel || null;
    } catch (_) { /* fall through */ }
  }
  // Default login (no provider override).
  if (appType === 'claude') return claudeDefaultModel() || session.reportedModel || null;
  return session.reportedModel || null;
}

// Resolve a subagent {providerId, model} to the REAL wire model id the proxy
// forwards upstream: a Claude tier (opus/sonnet/haiku/fable) maps to the
// sub-provider's aliasMap target (e.g. opus → glm-5.2), mirroring
// effectiveSessionModel + the claude-proxy tier resolution. Falls back to the
// raw model (Claude-official ids are already real). null when unset.
function effectiveSubagentModel(sa) {
  if (!sa || !sa.providerId || !sa.model) return null;
  try {
    const am = providers.getProviderSummary('claude', sa.providerId)?.aliasMap;
    const entry = am && am[sa.model];
    if (entry && entry.model) return entry.model;
  } catch (_) { /* fall through */ }
  return sa.model;
}

// Serialize a session's subagent override for the frontend: the raw
// {providerId, model} the picker stored PLUS `effectiveModel`, the real wire id
// that actually hits the server (for the pill/chip). null = 随主 (follow main).
function serializeSubagent(sa) {
  if (!sa || !sa.providerId || !sa.model) return null;
  return { providerId: sa.providerId, model: sa.model, effectiveModel: effectiveSubagentModel(sa) };
}

// Remember the model the CLI actually reported at runtime (stream-json system
// init `model` / assistant `message.model`). This is the only source of truth
// for relay providers (custom base URL, no explicit ANTHROPIC_MODEL) where the
// model is decided server-side by the relay.
function noteReportedModel(sessionName, model) {
  if (!model || typeof model !== 'string' || model.includes('<synthetic>')) return;
  const p = persistedSessions.get(sessionName);
  if (!p || p.reportedModel === model) return;
  p.reportedModel = model;
  rememberActiveCliState(p);
  savePersistedSessions();
}

// One-time startup backfill: sessions created before reportedModel existed can
// recover it from the CLI's own transcript (~/.claude/projects/*/<cliSessionId>.jsonl)
// so cards show a model right away instead of waiting for the next turn.
function backfillReportedModels() {
  const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(claudeProjects, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch (_) { return; }
  let updated = 0;
  for (const p of persistedSessions.values()) {
    if (p.reportedModel || (p.cli && p.cli !== 'claude') || !p.cliSessionId) continue;
    if (effectiveSessionModel(p)) continue; // already resolvable statically
    for (const d of dirs) {
      const jl = path.join(claudeProjects, d.name, `${p.cliSessionId}.jsonl`);
      let tail;
      try {
        const fd = fs.openSync(jl, 'r');
        try {
          const size = fs.fstatSync(fd).size;
          const len = Math.min(256 * 1024, size);
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, size - len);
          tail = buf.toString('utf8');
        } finally { fs.closeSync(fd); }
      } catch (_) { continue; }
      // Last assistant message's model in the transcript wins.
      const lines = tail.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const j = JSON.parse(lines[i]);
          const m = j.type === 'assistant' && j.message && j.message.model;
          if (m && typeof m === 'string' && !m.includes('<synthetic>')) {
            p.reportedModel = m;
            updated++;
            break;
          }
        } catch (_) { /* truncated first line etc. */ }
      }
      break; // found the transcript file; don't scan other project dirs
    }
  }
  if (updated) {
    savePersistedSessions();
    console.log(`[multicc] Backfilled reportedModel for ${updated} session(s) from CLI transcripts`);
  }
}

// The concrete model to snapshot onto a session when switching provider, so
// the card always shows a real model name instead of "默认". Mirrors
// effectiveSessionModel but is meant to be *written back* to session.model.
function providerDefaultModel(appType, providerId) {
  if (!providerId) {
    // Switching back to the default login → snapshot the current /model setting.
    return appType === 'claude' ? claudeDefaultModel() : null;
  }
  try {
    const p = providers.getProviderSummary(appType, providerId);
    if (!p) return null;
    // Alias-only relays (e.g. iFlytek) declare only alias targets and reject them
    // as literal --model values — never stamp one onto a session. Use the safe
    // wire default instead so the next spawn doesn't 1211.
    if (p.aliasOnly) return providers.WIRE_DEFAULT_MODEL;
    return p.model || (p.modelOptions && p.modelOptions[0]) || null;
  } catch (_) { return null; }
}

const CODEX_ARGS = process.env.CODEX_ARGS ? process.env.CODEX_ARGS.split(' ') : [];
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

// Map a cli name to its provider pool (appType). codex has its own pool; every
// other cli (claude, opencode, zcode, …) shares the Anthropic-compatible 'claude'
// pool. opencode/zcode read ANTHROPIC_* env too when using an anthropic provider,
// so a chosen claude-pool provider routes correctly for them.
function appTypeForCli(cli) {
  return cli === 'codex' ? 'codex' : 'claude';
}

function sessionProviderName(session) {
  const providerId = session && session.provider;
  if (!providerId) return null;
  try {
    return providers.getProviderSummary(appTypeForCli(session.cli), providerId)?.name || providerId;
  } catch (_) {
    return providerId;
  }
}

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
const CODEX_REASONING_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const OPENCODE_VARIANTS = new Set(['minimal', 'low', 'medium', 'high', 'max']);
function normalizeEffort(v) {
  const s = (v == null ? '' : String(v)).trim().toLowerCase();
  if (!s) return null;
  return EFFORT_LEVELS.has(s) || CODEX_REASONING_LEVELS.has(s) || OPENCODE_VARIANTS.has(s) ? s : undefined;
}
function validEffortForCli(cli, effort) {
  if (!effort) return true;
  if (cli === 'codex') return CODEX_REASONING_LEVELS.has(effort);
  if (cli === 'opencode') return OPENCODE_VARIANTS.has(effort);
  if (cli === 'zcode') return false;
  return EFFORT_LEVELS.has(effort);
}
function cliEffortLevel(session) {
  const e = normalizeEffort(session?.effort);
  if (!e || !EFFORT_LEVELS.has(e)) return null;
  return e === 'ultracode' ? 'xhigh' : e;
}
function codexReasoningLevel(session) {
  const e = normalizeEffort(session?.effort);
  return e && CODEX_REASONING_LEVELS.has(e) ? e : null;
}
function codexReasoningConfigArg(session) {
  const level = codexReasoningLevel(session);
  return level ? `model_reasoning_effort="${level}"` : null;
}
function codexModelConfigArg(session) {
  const model = session && session.model ? String(session.model).trim() : '';
  return model ? `model="${model}"` : null;
}
function isCodexResponseCompletedDisconnect(message) {
  const s = String(message || '');
  return /stream disconnected before completion/i.test(s) && /response\.completed/i.test(s);
}
function isCodexTransportDisconnect(message) {
  const s = String(message || '');
  return /stream disconnected before completion/i.test(s) &&
    (/error sending request/i.test(s) || /\/backend-api\/codex\/responses/i.test(s));
}
function isCodexRecoverableReconnectError(message) {
  const s = String(message || '');
  return /^Reconnecting\.\.\.\s*\d+\/\d+\s*\(/i.test(s) && isCodexResponseCompletedDisconnect(s);
}
const CODEX_STREAM_DISCONNECT_CONTINUE_MAX = 2;
function codexStreamDisconnectContinuePrompt() {
  return [
    '上一轮因为传输连接中断提前停了，已有部分输出已经显示给用户。',
    '请不要重复已经完成或已经输出的内容，从中断处继续完成原任务。',
    '如果原任务其实已经全部完成，只用一句话确认完成；否则继续执行必要步骤，直到可以交付。',
  ].join('\n');
}
function isGlm52Session(session) {
  return String(session?.model || '').toLowerCase() === 'xopglm52';
}
function effortLabel(e) {
  return e || claudeDefaultEffort();
}
function claudeDefaultEffort() {
  for (const file of ['settings.local.json', 'settings.json']) {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', file), 'utf8'));
      const effort = normalizeEffort(settings.effort || settings.thinkingEffort);
      if (effort) return effort;
    } catch (_) { /* fall through */ }
  }
  return 'medium';
}
function effectiveSessionEffort(session) {
  if (!session) return null;
  const cli = session.cli || 'claude';
  if (cli === 'codex') return codexReasoningLevel(session) || codexDefaultReasoningLevel();
  if (cli === 'opencode') {
    const effort = normalizeEffort(session.effort);
    return effort && OPENCODE_VARIANTS.has(effort) ? effort : null;
  }
  if (cli === 'zcode') return null;
  const effort = normalizeEffort(session.effort);
  return effort && EFFORT_LEVELS.has(effort) ? effort : claudeDefaultEffort();
}

function normalizeCliAgent(cli, value) {
  const agent = value == null ? '' : String(value).trim();
  if (!agent) return null;
  if (!['claude', 'opencode'].includes(cli) || !/^[A-Za-z0-9._-]{1,80}$/.test(agent)) return undefined;
  return agent;
}
function codexDefaultReasoningLevel() {
  const homes = [process.env.CODEX_HOME, path.join(os.homedir(), '.codex')].filter(Boolean);
  for (const home of homes) {
    try {
      const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
      const m = toml.match(/^\s*model_reasoning_effort\s*=\s*["']?([A-Za-z0-9_-]+)["']?\s*$/m);
      const effort = normalizeEffort(m && m[1]);
      if (effort && CODEX_REASONING_LEVELS.has(effort)) return effort;
    } catch (_) { /* fall through */ }
  }
  return 'xhigh';
}

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
  '  · 派活方（把任务用 <<dispatch>> 或留言交给兄弟会话前）：在交给对方的指令里，明确要求对方「① 动手前先把自己的 worktree 同步到最新基分支：curl -s -X POST $MULTICC_BASE_URL/api/sessions/<目标会话id>/sync ；② 干完后 commit 全部改动，并合并回基分支：curl -s -X POST $MULTICC_BASE_URL/api/sessions/<目标会话id>/merge ；③ 回复里报告改了哪些文件、是否已合并、有无冲突」。',
  '  · 被派方（你收到一个自包含任务时）：先 sync 再干活，干完 commit + merge 回基分支，并在回复里如实说明改动文件与合并结果；若 sync 或 merge 返回冲突（HTTP 409），不要硬来，把冲突文件清单报回派活方让其裁决。',
  '  · 收回成果后（派活方拿到对方「已合并」的回复时）：自己也 sync 一下把对方的成果拉进本会话 worktree（curl -s -X POST $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/sync），再继续后续工作，避免你手上还是旧代码。',
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
  providers,
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
const CODEX_CMD = cliCommands.codex;
const cliProviders = cliAdapterRegistry.providers;

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
function findCodexSessionId(cwd, sinceMs, sessionsDir) {
  try {
    const rootDir = sessionsDir || CODEX_SESSIONS_DIR;
    if (!fs.existsSync(rootDir)) return null;
    const candidates = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && e.name.endsWith('.jsonl')) {
          try {
            const stat = fs.statSync(p);
            if (stat.mtimeMs >= sinceMs) candidates.push({ path: p, mtimeMs: stat.mtimeMs });
          } catch (_) {}
        }
      }
    };
    walk(rootDir);
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const c of candidates) {
      try {
        // Read first line only (session_meta is the first record)
        const fd = fs.openSync(c.path, 'r');
        const buf = Buffer.alloc(8192);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const firstLine = buf.slice(0, n).toString().split('\n')[0];
        if (!firstLine) continue;
        const meta = JSON.parse(firstLine);
        if (meta.type !== 'session_meta') continue;
        const metaCwd = meta.payload?.cwd;
        const metaId = meta.payload?.id;
        // cwd may differ on macOS due to /private prefix; compare resolved real paths
        if (!metaId) continue;
        const norm = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
        if (norm(metaCwd) === norm(cwd)) return metaId;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

// ── tmux helpers (extracted to src/tmux.js) ──
// Pure primitives, destructured so existing call sites are unchanged. The
// stateful recoverTmuxSessions() (below) stays — it rebuilds core session state.
const {
  TMUX_PREFIX, tmuxSessionName, tmuxListSessions, tmuxHasSession, tmuxCreateSession, tmuxResize,
  applyMaxClientSize, tmuxKillSession, tmuxCapturePane, tmuxPaneTty, tmuxPaneCwd,
  tmuxWriteInput, fifoPathForSession, startOutputCapture, stopOutputCapture,
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
  gitWorktreeAdd, gitWorktreeRemove, gitRelocateWorktree, gitWorktreeCommitAll, gitWorktreeMergeState, gitMergeBack,
  gitSyncFromBase, gitRebaseResolve, defaultRepoActor,
} = require('./src/git');

// RepoActor operations are retained in a bounded in-memory history. Destructive
// endpoint responses include operationId; callers can inspect progress and the
// observed queue depth here without polling child processes themselves.
app.get('/api/repo-operations/:operationId', (req, res) => {
  const operation = defaultRepoActor.status(req.params.operationId);
  if (!operation) return res.status(404).json({ error: 'operation not found' });
  res.json(operation);
});

// gitWorktreeMergeState fires several asynchronous git subprocesses per session.
// It is read once per session on every /api/sessions poll, so on a busy server
// we keep REST serialization synchronous by returning the latest cached state
// while RepoActor refreshes it in the background. Mutating endpoints
// (merge/sync/commit) call mergeStateFresh() to recompute and refresh the cache
// so the UI never shows a stale indicator after an actual git change. WS
// broadcasts already push fresh state to active viewers, so the bounded staleness
// only ever affects passive REST polling.
const _mergeStateCache = new Map();
const _mergeStatePending = new Map();
function mergeStateKey(session) { return session && session.id ? session.id : null; }
function mergeStateCached(dir, session) {
  const key = mergeStateKey(session);
  if (!key) return { mergeReady: false, dirty: false, ahead: 0, behind: 0, reason: 'loading' };
  const cached = _mergeStateCache.get(key);
  const now = Date.now();
  if ((!cached || cached.expiry <= now) && !_mergeStatePending.has(key)) {
    const pending = gitWorktreeMergeState(dir, session)
      .then(value => { _mergeStateCache.set(key, { value, expiry: Date.now() + 4000 + Math.floor(Math.random() * 3000) }); return value; })
      .catch(() => cached?.value || null)
      .finally(() => _mergeStatePending.delete(key));
    _mergeStatePending.set(key, pending);
  }
  return cached?.value || { mergeReady: false, dirty: false, ahead: 0, behind: 0, reason: 'loading' };
}
async function mergeStateFresh(dir, session) {
  const value = await gitWorktreeMergeState(dir, session);
  const key = mergeStateKey(session);
  if (key) _mergeStateCache.set(key, { value, expiry: Date.now() + 4000 });
  return value;
}

const gitReadyDirs = new Set();          // dir.id once its repo is verified/initialised
const invalidSessions = new Map();       // sessionId → reason; recovery is skipped for these

// Directory suitability + path helpers extracted to src/directories.js.
// Destructured so existing call sites are unchanged. ensureDirGitReady() and
// the loadDirectories/saveDirectories persistence stay below in server.js.
const {
  isHomeOrAbove, realPathOf, findDirByPath, dirUnsuitableReason,
  dirSuitabilityViaGit, dirSuitability, friendlyDirReason,
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

// Both files are persisted through state-store: atomic tmp+fsync+rename + dir
// fsync + rolling .bakN backups. A save FAILURE now throws so the HTTP layer
// can 5xx the client instead of returning success on a torn on-disk state.
const sessionsStore = stateStore.createStore({
  file: SESSIONS_FILE, kind: 'sessions', schemaVersion: 1, legacyIsArray: true,
});
const directoriesStore = stateStore.createStore({
  file: DIRECTORIES_FILE, kind: 'directories', schemaVersion: 1, legacyIsArray: true,
});

// Boot-time journal replay: if the previous process crashed between writing
// the state-tx journal and finishing the two file writes, finish the job here
// BEFORE anyone reads state. Journal entries carry the exact intended
// snapshots, so replay is idempotent.
{
  const { replayed, skipped } = stateTx.replayJournals(MULTICC_PATHS.journalDir, {
    log: (m) => console.log(m),
  });
  if (replayed || skipped) {
    console.log(`[multicc] state-tx journal: ${replayed} replayed, ${skipped} skipped`);
  }
}

function loadDirectories() {
  let r;
  try { r = directoriesStore.loadOrRecover(); }
  catch (e) {
    // Fail-closed: refuse to boot into a fresh empty state that would clobber
    // an unreadable directories.json on the next save(). Operators can move
    // the file aside manually after inspecting it.
    console.error(`[multicc] directories.json unreadable and no backup usable: ${e.message}`);
    throw e;
  }
  if (!r.present) return new Map();
  if (r.recovered) console.warn(`[multicc] directories.json recovered from backup ${r.recoveredFrom}`);
  const map = new Map();
  for (const d of r.data) map.set(d.id, d);
  return map;
}

// saveDirectories() moved into src/directory/repository.js; a delegate with the
// same name is defined next to the directory-domain composition root below.

function isNewSchema(arr) {
  return arr.some(s => s.dirId !== undefined || s.kind !== undefined);
}

function hasMigratableOldSessions(arr) {
  return arr.some(s => !(s.id === '__aux__' || s.type === 'aux') && s.dirId === undefined && s.kind === undefined);
}

// One-shot migration: old paired sessions → directories + split sessions.
function migrateOldSchema(oldList) {
  const newDirs = new Map();
  const newSessions = new Map();
  const chatHistoryRenames = [];

  for (const s of oldList) {
    if (s.id === '__aux__' || s.type === 'aux') {
      newSessions.set(s.id, s); // keep as-is
      continue;
    }
    const dirId = crypto.randomUUID();
    newDirs.set(dirId, {
      id: dirId,
      name: s.id,                 // use old human-readable id as directory label
      path: s.cwd,
      createdAt: s.createdAt,
    });
    // Terminal session reuses the old id so existing tmux sessions (multicc-<id>) get recovered.
    newSessions.set(s.id, {
      id: s.id,
      dirId,
      cli: 'claude',
      kind: 'terminal',
      cliSessionId: s.claudeSessionId || null,
      createdAt: s.createdAt,
    });
    // Chat session (if old record had chatClaudeSessionId) gets id + '-chat'.
    if (s.chatClaudeSessionId) {
      const chatId = s.id + '-chat';
      newSessions.set(chatId, {
        id: chatId,
        dirId,
        cli: 'claude',
        kind: 'chat',
        cliSessionId: s.chatClaudeSessionId,
        createdAt: s.createdAt,
      });
      // Chat history was keyed by the old paired id; rename the file so the new chat
      // session (id + '-chat') picks up its history.
      chatHistoryRenames.push({ from: s.id, to: chatId });
    }
  }

  return { newDirs, newSessions, chatHistoryRenames };
}

function loadPersistedState() {
  let rawSessions = [];
  let r;
  try { r = sessionsStore.loadOrRecover(); }
  catch (e) {
    // Fail-closed on both primary AND all backups corrupt. Refuse to boot
    // rather than overwrite the file with an empty array on the next save().
    console.error(`[multicc] sessions.json unreadable and no backup usable: ${e.message}`);
    throw e;
  }
  if (r.present) {
    if (r.recovered) console.warn(`[multicc] sessions.json recovered from backup ${r.recoveredFrom}`);
    rawSessions = r.data;
  }

  const dirMap = loadDirectories();

  if (rawSessions.length > 0 && !isNewSchema(rawSessions) && hasMigratableOldSessions(rawSessions)) {
    console.log('[multicc] Migrating sessions.json to directory-based schema...');
    const { newDirs, newSessions, chatHistoryRenames } = migrateOldSchema(rawSessions);
    // Rename chat_history files (old paired id → new chat session id)
    const CHAT_DIR = MULTICC_PATHS.chatHistoryDir;
    for (const { from, to } of chatHistoryRenames) {
      const src = path.join(CHAT_DIR, `${from}.json`);
      const dst = path.join(CHAT_DIR, `${to}.json`);
      try {
        if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst);
      } catch (e) {
        console.warn(`[multicc] chat_history rename failed ${from} → ${to}: ${e.message}`);
      }
    }
    // Back up old sessions.json just in case
    try { fs.copyFileSync(SESSIONS_FILE, SESSIONS_FILE + '.pre-directory.bak'); } catch (_) {}
    return { directories: newDirs, persistedSessions: newSessions, needsSave: true };
  }

  // Already new-schema (or empty)
  const sessionMap = new Map();
  for (const s of rawSessions) sessionMap.set(s.id, s);
  console.log(`[multicc] Loaded ${dirMap.size} directories, ${sessionMap.size} session(s)`);
  return { directories: dirMap, persistedSessions: sessionMap, needsSave: false };
}

function savePersistedSessions() {
  const data = [...persistedSessions.values()];
  try {
    sessionsStore.save(data);
  } catch (e) {
    // Base savePersistedSessions() is called from ~40 non-HTTP call sites that
    // don't wrap it (background timers, teardown callbacks) — throwing here
    // would crash the process on every hiccup. It's log-only; the HTTP-facing
    // cross-file mutation (directory delete → state-tx.commitCrossFileWrite)
    // DOES throw and turns save failures into a 500 with a torn-state journal
    // that replays on next boot. That is the strong-consistency path.
    console.error('[multicc] Failed to save sessions.json:', e.message);
  }
}

const _state = loadPersistedState();
const persistedSessions = _state.persistedSessions;

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

// Seed TWO default Agent Commander chat sessions for a newly-registered directory
// (session-domain logic, exposed to the directory domain via its session port):
// one under Claude, one under Codex — so every fleet has both CLI commanders.
async function seedCommanderSession(dir) {
  const commander = agentCommanderPrompt();
  if (!commander) {
    console.warn('[multicc] Agent Commander preset not found; skipping seed sessions for new dir');
    return;
  }
  for (const cli of ['claude', 'codex']) {
    const label = cli === 'codex' ? '🫡 Agent Commander (Codex)' : '🫡 Agent Commander';
    const r = await createSessionRecord({ dir, cli, kind: 'chat', label });
    if (r.ok) {
      r.session.rolePrompt = commander.prompt;
      savePersistedSessions();
      appendEvent(dir.id, 'session_role_changed', `${r.session.label || r.session.id}（默认指挥官）`, r.session.id);
    } else {
      console.warn(`[multicc] seed ${cli} commander session failed for dir ${dir.id}: ${r.error}`);
    }
  }
}

// Tear down one session record + all its runtime state (tmux, chat proc, wait
// registrations, shares, worktree, triggers, notes, status board entry).
// Directory deletion cascades through here for every owned session.
async function destroySessionCascade(s, d, opts = {}) {
  const active = sessions.get(s.id);
  const chat = chatSessions.get(s.id);
  const isActive = !!active || !!(chat && (chat.claudeProc || chat.isStreaming || chat.clients?.size));
  if (isActive && !opts.force) return { ok: false, blocked: true, reasons: ['active'], error: 'active session cannot be removed' };
  let removal = null;
  // Remove the worktree before tearing down runtime/persistence. A default
  // dirty/unmerged refusal therefore leaves the session completely intact.
  if (s.worktreePath && s.branch) {
    try {
      removal = await gitWorktreeRemove(d.path, s.worktreePath, s.branch, {
        sessionId: s.id, baseBranch: d.baseBranch, force: !!opts.force,
        activeCheck: opts.force ? null : () => sessionWorktreeActive(s.id),
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
    sessions.delete(s.id);
  }
  if (chat) {
    if (chat.claudeProc) try { chat.claudeProc.kill('SIGTERM'); } catch (_) {}
    chatStream.close(s.id);
    chatSessions.delete(s.id);
  }
  waitInjector.cancelForSession(s.id);
  bgCompletionCoalescer.cancel(s.id); // drop any completions buffered for this now-deleted session
  share.removeForSession(s.id);
  chatHistories.delete(s.id);
  try { fs.unlinkSync(chatHistoryPath(s.id)); } catch (_) {}
  teardownTriggers(s.id);
  purgeNotesForSession(s.id);
  persistedSessions.delete(s.id);
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
    commit: (p, m) => gitRunQueued(p, ['commit', '-m', m]),
    ensureReady: ensureDirGitReady,
    unmarkReady: (id) => { gitReadyDirs.delete(id); },
  },
  sessions: {
    listByDir: (dirId) => [...persistedSessions.values()].filter(s => s.dirId === dirId),
    seedCommander: seedCommanderSession,
    destroyCascade: destroySessionCascade,
    persistRecords: savePersistedSessions,
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
  savePersistedSessions();
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
    savePersistedSessions();
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

function dispatchableSessionsFor(sessionId) {
  const from = persistedSessions.get(sessionId);
  if (!from || !from.dirId) return [];
  return [...persistedSessions.values()]
    .filter(s => s.id !== sessionId)
    .filter(s => s.type !== 'aux' && s.type !== 'gateway')
    .filter(s => s.dirId === from.dirId)
    .slice(0, 30)
    .map(s => {
      const activeChat = chatSessions.get(s.id);
      return {
        id: s.id,
        label: s.label || '',
        cli: s.cli || 'claude',
        kind: s.kind || 'terminal',
        active: !!activeChat && (activeChat.clients.size > 0 || activeChat.isStreaming),
      };
    });
}

function buildDispatchContextPrompt(sessionId) {
  const targets = dispatchableSessionsFor(sessionId);
  if (!targets.length) return '';
  const current = persistedSessions.get(sessionId);
  if (!current?.autoDispatch) return '';
  const ultra = normalizeEffort(current?.effort) === 'ultracode';
  const intro = ultra
    ? [
        '[MultiCC Ultracode workflow]',
        '当前会话开启了 ultracode（effort=xhigh + dynamic workflow）。你拥有两套任务分发能力，应根据任务性质选择：',
        '',
        '【A. Claude 内置 Task/Agent/Workflow 工具 — 进程内并行】',
        '适用于轻量只读/纯分析任务（搜索文件、读代码、快速研究、数据提取）。',
        '特点：低延迟、共享上下文、自动汇总，无需占用 worker session。',
        '用法：直接用 TaskCreate 创建任务，用 Agent 派生子代理并行执行，或用 Workflow 编排多阶段分析。',
        '',
        '【B. <<dispatch>> 标记 — 跨 session 分发】',
        '适用于重量级改代码任务（需要独立 worktree、跨 provider、需要 git commit/merge）、',
        '需要不同 provider 执行的任务、需要持久化且可追溯的独立操作。',
        '保持每个 dispatch 指令完整自包含：目标、约束、要读/改/验证的范围、最终需要回报的内容。',
        '需要改代码时，要求 worker 先 sync，完成后 commit + merge，并报告结果。',
        '',
        '⚠️ 把任务交给 worker session 的唯一途径是下面的 dispatch 标记或 dispatch API。',
        'run-detached 只是后台 shell 命令、notes 只是留言，都不会让任何 worker 干活。',
        '',
        '两者不互斥：同一回合可以同时使用 Task/Agent/Workflow 做分析 + <<dispatch>> 派发改动。',
      ]
    : [
        '[MultiCC cross-session dispatch]',
        '你可以把自包含子任务分发给同目录的其它 session。只有确实需要其它 session 干活时才输出标记，普通回答不要输出。',
      ];
  return [
    ...intro,
    '格式：<<dispatch target="真实 session id">完整、自包含的任务说明</dispatch>>',
    'target 必须逐字使用下面列表中的某个 id；不要使用 ...、SID、SESSION_ID、<目标会话id> 等占位符。',
    '如果要并行执行多个子任务，可以在同一回复中输出多个 dispatch 标记；系统会把结果自动回流给你。',
    '等价方式（适合在回合中途派活）：POST $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/dispatch，JSON body 必须包含 target 和 message；target 仍然必须是下面列表里的真实 id，结果同样自动回流。',
    `可用目标 sessions: ${JSON.stringify(targets)}`,
    ultra ? '[MultiCC Ultracode workflow end]' : '[MultiCC cross-session dispatch end]',
    '',
  ].join('\n');
}

function ultracodeWorkerId(parentId, n) {
  const stem = String(parentId || 'session')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 44)
    .replace(/-+$/g, '') || 'session';
  return `${stem}-ultra-${String(n).padStart(2, '0')}`;
}

async function ensureUltracodeWorkers(parentId) {
  const parent = persistedSessions.get(parentId);
  if (!parent || !parent.dirId || parent.kind !== 'chat') return;
  if (normalizeEffort(parent.effort) !== 'ultracode') return;
  const dir = directories.get(parent.dirId);
  if (!dir) return;
  for (let i = 1; i <= 3; i++) {
    const id = ultracodeWorkerId(parentId, i);
    if (persistedSessions.has(id)) continue;
    const r = await createSessionRecord({
      dir,
      cli: parent.cli || 'claude',
      kind: 'chat',
      label: `⚡ Ultra Worker ${i}`,
      id,
      ephemeral: true,
      model: parent.model || null,
      provider: parent.provider || '',
      effort: 'xhigh',
      rolePrompt: '你是 MultiCC Ultracode worker。只执行派给你的自包含子任务；先同步 worktree，完成后验证、提交并尽量合并回基分支，最后用精简结构汇报改动、验证结果和风险。',
    });
    if (!r.ok) console.warn(`[multicc/ultracode] failed to create worker ${id}: ${r.error}`);
  }
}

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
const dispatchRuns = new Map();                // dispatchId → { targetId, chatSessionId, createdAt }
const DISPATCH_RE = /<<dispatch\s+target=["'“”]?([^"'“”>\s]+)["'“”]?\s*>([\s\S]*?)<\/dispatch>>?/;
const DISPATCH_CONFIRM_RE = /^(确认|确定|yes|y|ok)$/i;
const DISPATCH_CANCEL_RE = /^(取消|算了|no|n)$/i;

// Pull a single dispatch marker out of gateway reply text.
// Returns { target, message, cleanText } (marker removed) or null.
function parseDispatchMarker(text) {
  if (!text) return null;
  const m = text.match(DISPATCH_RE);
  if (!m) return null;
  const target = (m[1] || '').trim();
  const message = (m[2] || '').trim();
  if (!target || !message) return null;
  const cleanText = text.replace(DISPATCH_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { target, message, cleanText };
}

function isDispatchPlaceholderTarget(targetId) {
  const raw = String(targetId || '').trim();
  if (!raw) return true;
  const normalized = raw
    .replace(/[“”"'`]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (/^(\.{2,}|…+)$/.test(normalized)) return true;
  if (/^<[^>]+>$/.test(normalized)) return true;
  return new Set([
    'sid', 'session_id', 'session id', 'sessionid',
    'target', 'target_id', 'target id',
    'worker session id', 'worker-session-id',
    '真实 session id', '真实sessionid',
    '目标会话id', '目标 session id',
  ]).has(normalized);
}

function dispatchTargetHintFor(sessionId) {
  const targets = dispatchableSessionsFor(sessionId);
  if (!targets.length) return '当前同目录没有可分发的目标 session';
  return `可用目标 sessions: ${JSON.stringify(targets)}`;
}

// Push a server-originated assistant message into the gateway chat. Web clients
// render it; the WeChat bridge (a gateway WS client) forwards it on `result`.
function pushToGateway(text, { persist = true } = {}) {
  if (!text) return;
  if (persist) appendChatMessage(GATEWAY_ID, { role: 'assistant', content: text, ts: Date.now() });
  chatBroadcast(GATEWAY_ID, { type: 'assistant', message: { content: [{ type: 'text', text }] } });
  chatBroadcast(GATEWAY_ID, { type: 'result', total_cost_usd: null });
}

// A dispatch target must be a real, non-system session.
function validateDispatchTarget(targetId, fromSessionId = null) {
  const hint = fromSessionId ? `；${dispatchTargetHintFor(fromSessionId)}` : '';
  if (isDispatchPlaceholderTarget(targetId)) {
    return { ok: false, error: `「${targetId}」是占位符，不是真实 session id；请从可用目标 sessions 中选择一个真实 id${hint}` };
  }
  const rec = persistedSessions.get(targetId);
  if (!rec) return { ok: false, error: `目标 session「${targetId}」不存在${hint}` };
  if (rec.type === 'aux' || rec.type === 'gateway') return { ok: false, error: `不能把任务分发给系统会话「${targetId}」` };
  return { ok: true, rec };
}

// Remove the raw marker from the most recent persisted gateway assistant message.
function stripMarkerFromGatewayHistory() {
  const hist = chatHistories.get(GATEWAY_ID);
  if (!hist) return;
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string' && DISPATCH_RE.test(m.content)) {
      m.content = m.content.replace(DISPATCH_RE, '').replace(/\n{3,}/g, '\n\n').trim();
      saveChatHistory(GATEWAY_ID);
    }
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
    dispatchToSession(pd.targetId, pd.message)
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

// Deliver a confirmed dispatch to its target session, creating an ephemeral chat
// for terminal-only targets. Returns { ok, chatId } or { ok:false, error }.
async function dispatchToSession(targetId, message, opts = {}) {
  let v = validateDispatchTarget(targetId, opts.replyTo || null);
  // On-demand ultracode worker creation: if the target matches *-ultra-NN but
  // doesn't exist yet, auto-create it from the dispatcher's config. This replaces
  // the old eager ensureUltracodeWorkers() — workers are born only when the LLM
  // actually emits a <<dispatch>> marker naming them.
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
          });
          if (created.ok) v = validateDispatchTarget(targetId, opts.replyTo || null);
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
    });
    if (!created.ok) return { ok: false, error: `创建临时 chat 失败：${created.error}` };
    chatId = created.id;
  }

  // Busy guard: v1 refuses rather than queueing.
  const cs = chatSessions.get(chatId);
  if (cs && cs.claudeProc) return { ok: false, error: `${targetId} 正在忙，稍后再试` };

  const dispatchId = crypto.randomUUID();
  dispatchRuns.set(dispatchId, { targetId, chatSessionId: chatId, replyTo: opts.replyTo || null, createdAt: Date.now() });
  // Registry call (not a bus event): we need runChatTurn's boolean back to
  // detect an immediate launch failure. Avoids a static require of the chat domain.
  if (isNetworkUnhealthy()) {
    // ⑥A hold: API is down — queue this dispatch for recovery instead of
    // launching a turn that will immediately fail.
    holdSession(opts.replyTo || targetId, 'dispatch');
    return { ok: false, error: '上游 API 异常，任务已暂挂，恢复后自动接续' };
  }
  const ok = services.call('chat.runTurn', chatId, message, { originDispatchId: dispatchId });
  if (ok === false) { dispatchRuns.delete(dispatchId); return { ok: false, error: `启动 ${targetId} 回合失败` }; }
  // Track this pending dispatch on the dispatcher's currentTask so its card
  // shows "等待 worker 回报" (waiting) instead of falling to idle while the
  // worker runs. opts.replyTo is the dispatcher's session id.
  if (opts.replyTo) addPendingDispatch(opts.replyTo, dispatchId, targetId);
  return { ok: true, chatId };
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
function finalizeDispatch(dispatchId, sessionName, finalText) {
  const run = dispatchRuns.get(dispatchId);
  dispatchRuns.delete(dispatchId);
  const targetId = run ? run.targetId : sessionName;
  const text = (finalText || '').trim() || '（本次运行没有产生文本输出）';
  const targetRec = persistedSessions.get(targetId);
  const label = (targetRec && targetRec.label) ? `${targetId}（${targetRec.label}）` : targetId;
  const replyTo = run && run.replyTo;
  // A worker finished → drop it from the dispatcher's pending list (so the
  // dispatcher's status can leave 'waiting' once all workers回流).
  if (replyTo) removePendingDispatch(replyTo, dispatchId);
  if (replyTo && persistedSessions.get(replyTo)) {
    // Busy-safe: if several parallel dispatches finish at once they serialise
    // into the dispatcher one turn at a time instead of clobbering each other.
    waitInjector.safeInject(replyTo, `【${label} 回复】\n${text}`);
  } else {
    pushToGateway(`【${targetId} 回复】\n${text}`);
  }
}
// Gateway domain owns this handler; chat emits when a dispatched turn finishes.
bus.on('chat:dispatch-complete', finalizeDispatch);

// ── Generalised cross-session dispatch (any chat session, not just the gateway) ──
// A session emits one or more <<dispatch target="SID">self-contained task</dispatch>>
// markers in its reply. On turn completion we run each on its target sibling and
// route the result back to the dispatcher (see finalizeDispatch). This is the
// real primitive behind "the commander splits work onto provider-specific
// sibling sessions" — e.g. handing a chunk to a DeepSeek-backed session.
//
// Autonomous (no confirm step — the dispatcher is the user's own agent, unlike
// the remote-human WeChat gateway). Targets are restricted to non-system sessions
// in the SAME directory. A dispatched worker's own turn carries originDispatchId
// and is handled by the回流 branch above, so workers cannot re-dispatch (mirrors
// "a fork can't fork").
const DISPATCH_RE_G = /<<dispatch\s+target=["'“”]?([^"'“”>\s]+)["'“”]?\s*>([\s\S]*?)<\/dispatch>>?/g;
function parseAllDispatchMarkers(text) {
  if (!text) return [];
  const out = [];
  for (const m of text.matchAll(DISPATCH_RE_G)) {
    const target = (m[1] || '').trim();
    const message = (m[2] || '').trim();
    if (target && message) out.push({ target, message });
  }
  return out;
}
// Ultracode safety net. Observed failure mode (mafit chat-24): the model
// narrates "分发给3个 ultra worker" but hands the work to run-detached shell
// tasks instead of emitting markers — the workers silently receive nothing.
// If an ultracode turn declares dispatch intent yet neither emitted a marker
// nor called the dispatch API recently, inject one corrective hint (cooldown-
// limited so a stubborn model can't loop us).
const lastDispatchOutAt = new Map();   // dispatcherId → ts of last real dispatch (marker or API)
const lastUltraNudgeAt = new Map();    // dispatcherId → ts of last nudge
const ULTRA_NUDGE_COOLDOWN_MS = 15 * 60 * 1000;
const ULTRA_DISPATCH_INTENT_RE = /(分发|派发|派给|分派|指派|交给|dispatch)[^\n]{0,60}(ultra\s*worker|worker|子会话|兄弟会话)|(ultra\s*worker)[^\n]{0,60}(分发|派发|并行|执行)/i;
function maybeNudgeUltracodeDispatch(dispatcherId, finalText) {
  const rec = persistedSessions.get(dispatcherId);
  if (!rec || normalizeEffort(rec.effort) !== 'ultracode') return;
  if (!ULTRA_DISPATCH_INTENT_RE.test(finalText || '')) return;
  const now = Date.now();
  if (now - (lastDispatchOutAt.get(dispatcherId) || 0) < 10 * 60 * 1000) return;
  if (now - (lastUltraNudgeAt.get(dispatcherId) || 0) < ULTRA_NUDGE_COOLDOWN_MS) return;
  lastUltraNudgeAt.set(dispatcherId, now);
  const hint = dispatchTargetHintFor(dispatcherId);
  waitInjector.safeInject(dispatcherId,
    '⚠️ 你提到要把任务分发给 worker，但这轮既没有输出 <<dispatch>> 标记、也没有调用 dispatch API —— worker session 实际上什么都没收到（run-detached 只是后台 shell 命令，不等于派活）。' +
    '若要真正派活：target 必须逐字复制可用目标 sessions 里的真实 id，不要写 ...、worker session id 或 <目标会话id>。' +
    `${hint}。` +
    '可以在回复文本末尾输出 dispatch 标记，或 POST /api/sessions/$MULTICC_SESSION_ID/dispatch（JSON body 包含真实 target 和 message）。若你有意自己完成全部工作，忽略本提示继续即可。');
}
function maybeDispatchFromChatTurn(dispatcherId, finalText) {
  const markers = parseAllDispatchMarkers(finalText);
  if (!markers.length) { maybeNudgeUltracodeDispatch(dispatcherId, finalText); return; }
  const from = persistedSessions.get(dispatcherId);
  if (!from) return;
  lastDispatchOutAt.set(dispatcherId, Date.now());
  for (const mk of markers) {
    if (mk.target === dispatcherId) continue;                       // no self-dispatch
    const v = validateDispatchTarget(mk.target, dispatcherId);
    if (!v.ok) { waitInjector.safeInject(dispatcherId, `⚠️ 无法分发给 ${mk.target}：${v.error}`); continue; }
    if (v.rec.dirId !== from.dirId) { waitInjector.safeInject(dispatcherId, `⚠️ 只能分发给同目录会话，已跳过 ${mk.target}`); continue; }
    appendEvent(from.dirId, 'dispatch', `→ ${v.rec.label || mk.target}`, dispatcherId);
    dispatchToSession(mk.target, mk.message, { replyTo: dispatcherId })
      .then(r => { if (!r.ok) waitInjector.safeInject(dispatcherId, `⚠️ 分发给 ${mk.target} 失败：${r.error}`); })
      .catch(e => waitInjector.safeInject(dispatcherId, `⚠️ 分发 ${mk.target} 异常：${e.message}`));
  }
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
  const cliPart = ['claude', 'codex', 'opencode', 'zcode'].includes(cli) ? cli : 'claude';
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
  // Per-session provider override (cc-switch). Injected into the tmux pane (see
  // tmuxCreateSession) so terminal sessions honor their provider too — without
  // this they silently fell back to the default login. The codex session-id
  // capture below also uses this provider's CODEX_HOME.
  const provEnv = providers.resolveSpawnEnv(persisted);
  // tmux panes inherit the tmux *server's* global env (captured at its first
  // launch), which may carry ANTHROPIC_* routing vars leaked from the shell that
  // started multicc. For claude sessions, explicitly blank every routing key the
  // chosen provider does NOT set, so an inherited value can't override the
  // provider choice (same intent as buildChildEnv for chat). Real values from
  // the provider override these blanks since they're applied in the same map.
  const termEnv = { ...provEnv.env };
  if ((persisted.cli || 'claude') !== 'codex') {
    for (const k of providers.CLAUDE_ROUTING_KEYS) {
      if (!(k in termEnv)) termEnv[k] = '';
    }
    // Route interactive tmux claude through the per-session/per-role proxy too.
    providers.applyClaudeProxyEnv(termEnv, {
      providerId: persisted.provider, sessionId: id,
      subagent: persisted.subagent, port: PORT, enabled: CLAUDE_PROXY_ENABLED,
      officialOAuth: CLAUDE_OFFICIAL_VIA_PROXY,
    });
  } else {
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
    savePersistedSessions();
  }

  // Create tmux session if it doesn't already exist (it may survive server restarts)
  let isRecovery = false;
  const launchTime = Date.now();
  if (!await tmuxHasSession(id)) {
    console.log(`[multicc] Creating tmux session: ${tmuxSessionName(id)} in ${cwd} (${provider.name} session: ${persisted.cliSessionId || '<pending>'})`);
    await tmuxCreateSession(id, cwd, 80, 24, provider.buildTerminalCmd(persisted || {}), termEnv);
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
        savePersistedSessions();
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
        const cliLabel = session.cli === 'codex' ? 'Codex' : 'Claude Code';
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
// Claude Code per-session/per-role routing proxy from cli-provider-router. Mounted
// BEFORE express.json() on purpose: it streams the raw request body (no 100kb
// limit, no double-parse) and inspects the `model` field to route each
// /v1/messages request — main loop vs Task-tool subagent — to different providers.
//
// The proxy is the ONLY component that knows, per /v1/messages request, both
// (a) whether it's the main loop or a Task-tool subagent (role) and (b) the
// real upstream provider it was routed to. The CLI's own `result` event rolls
// main + all subagents into one aggregate usage block, so per-role / per-provider
// accounting is impossible from the transcript. We hook onUsage here to bill
// each request to its actual (role, provider, model) — independent of the
// session's main provider — and stash a per-turn runtime breakdown so the chat
// frontend can show "本轮 主 A / 辅 B" instead of a single merged number.
const TOKEN_BY_ROLE_FILE = MULTICC_PATHS.tokenByRoleFile;
// In-memory current-turn snapshots and the persistent per-day × role × provider
// ledger share one tested implementation. The proxy callback is the only source
// that knows both the real upstream and whether a request came from a subagent.
const roleTokenTracker = createRoleTokenTracker({ filePath: TOKEN_BY_ROLE_FILE });
function recordRoleTokenUsage(info) {
  if (!roleTokenTracker.accumulate(info)) return;
  // Push on every completed upstream response, not only on the parent turn's
  // result boundary. A background subagent can finish after that boundary; its
  // usage must still appear in the live 主/辅 split without waiting for another turn.
  broadcastRoleTokenStats(info.sessionId);
}
mountClaudeProxy(app, { getProvider: providers.getProvider, onUsage: recordRoleTokenUsage });
app.use(express.json({ limit: '50mb' }));

// Codex Responses↔Chat 协议转换代理（国产服务商 DeepSeek/GLM/Qwen/MiniMax）。
// 必须在 express.json() 之后挂载，以便 req.body 已解析。详见 docs/codex-proxy-contract.md。
mountCodexProxy(app, {
  getProvider: providers.getProvider,
  getPort: () => PORT,
  onUsage: recordRoleTokenUsage,
});

app.get('/api/sessions', (req, res) => {
  const list = [...persistedSessions.values()]
    .filter(p => p.type !== 'aux' && p.type !== 'gateway')
    .map(p => {
      const active = sessions.get(p.id);
      const activeChat = chatSessions.get(p.id);
      const cwd = cwdForSession(p);
      const base = {
        id: p.id,
        dirId: p.dirId || null,
        cli: p.cli || 'claude',
        kind: p.kind || 'terminal',
        cliSessionId: p.cliSessionId || null,
        label: p.label || null,
        model: p.model || null,
        effectiveModel: effectiveSessionModel(p),
        effort: p.effort || null,
        effectiveEffort: effectiveSessionEffort(p),
        agent: p.agent || null,
        rolePrompt: p.rolePrompt || null,
        provider: p.provider || null,  // cc-switch provider id; null = default login
        subagent: serializeSubagent(p.subagent),  // Task-tool subagent override; null = 随主
        autoCommit: !!p.autoCommit,
        autoDispatch: !!p.autoDispatch,
        cliStates: cliStateSummary(p),
        pendingCliHandoff: cliHandoffSummary(p),
        cwd,
        createdAt: p.createdAt,
        mergeState: p.dirId ? mergeStateCached(directories.get(p.dirId), p) : null,
      };
      if (p.kind === 'chat' || active === undefined) {
        // Chat sessions don't live in `sessions` (terminal) map; derive active state from chatSessions
        const isChatActive = !!activeChat && (activeChat.clients.size > 0 || activeChat.isStreaming);
        return {
          ...base,
          lastActivity: p.kind === 'chat' ? chatLastActivity(p.id, activeChat) : null,
          clients: activeChat ? activeChat.clients.size : 0,
          active: isChatActive,
        };
      }
      return {
        ...base,
        lastActivity: active.lastActivity,
        clients: active.clients.size,
        active: true,
      };
    });
  const auxP = persistedSessions.get(AUX_SESSION_ID);
  if (auxP) {
    list.unshift({
      id: AUX_SESSION_ID, cwd: auxP.cwd, createdAt: auxP.createdAt,
      lastActivity: auxQueue.lastTaskTime ? new Date(auxQueue.lastTaskTime) : null,
      clients: auxQueue.clients.size, active: auxQueue.processing,
      type: 'aux', label: auxP.label || 'AI Assistant',
      auxStatus: auxQueue.getStatus(),
    });
  }
  res.json(list);
});

// ── Dashboard API ──────────────────────────────────────────────────────
// GET /api/dashboard/sessions — summary of all persistedSessions with filtering
app.get('/api/dashboard/sessions', (req, res) => {
  const { kind, active: activeParam } = req.query;
  const filterActive = activeParam === undefined ? null : activeParam === 'true';

  const list = [...persistedSessions.values()]
    .filter(p => p.type !== 'aux' && p.type !== 'gateway')
    .filter(p => !kind || (p.kind || 'terminal') === kind)
    .map(p => {
      const activeChat = chatSessions.get(p.id);
      const termSession = sessions.get(p.id);
      let isActive;
      let lastActivity;
      if (p.kind === 'chat') {
        isActive = !!activeChat && (activeChat.clients.size > 0 || activeChat.isStreaming);
        lastActivity = chatLastActivity(p.id, activeChat);
      } else {
        // terminal sessions are active when present in `sessions` map
        isActive = !!termSession;
        lastActivity = termSession ? termSession.lastActivity : null;
      }
      const ts = getTaskState(p);
      return {
        id: p.id,
        label: p.label || null,
        cli: p.cli || 'claude',
        kind: p.kind || 'terminal',
        active: isActive,
        createdAt: p.createdAt || null,
        lastActivity,
        classifyState: ts.classifyState || null,
        goal: ts.goal || '',
        phase: ts.phase || 'idle',
      };
    })
    .filter(s => filterActive === null || s.active === filterActive);

  res.json({ sessions: list, count: list.length });
});

// GET /api/dashboard/stats — aggregate statistics
app.get('/api/dashboard/stats', (req, res) => {
  const all = [...persistedSessions.values()]
    .filter(p => p.type !== 'aux' && p.type !== 'gateway');

  let activeCount = 0;
  const byCli = {};
  const byKind = {};

  for (const p of all) {
    const cli = p.cli || 'claude';
    const k = p.kind || 'terminal';
    byCli[cli] = (byCli[cli] || 0) + 1;
    byKind[k] = (byKind[k] || 0) + 1;

    const activeChat = chatSessions.get(p.id);
    const termSession = sessions.get(p.id);
    let isActive;
    if (p.kind === 'chat') {
      isActive = !!activeChat && (activeChat.clients.size > 0 || activeChat.isStreaming);
    } else {
      isActive = !!termSession;
    }
    if (isActive) activeCount++;
  }

  res.json({
    total: all.length,
    active: activeCount,
    byCli,
    byKind,
  });
});

// POST /api/sessions/:id/reclassify — manually re-judge one session's task state
// via classify. Enqueues an intent_classify task; state updates arrive over WS.
app.post('/api/sessions/:id/reclassify', (req, res) => {
  const p = persistedSessions.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'session not found' });
  if (p.type === 'aux' || p.type === 'gateway') return res.status(400).json({ error: 'not a chat session' });
  if (auxQueue.isUnhealthy()) return res.status(503).json({ error: 'aux 服务不可用，无法重判' });
  // Pull last assistant reply and enqueue directly — same as scanAndReclassify
  const sid = req.params.id;
  const ts = getTaskState(p);
  // D/W guard — mirror scanAndReclassify (L7407). D(done, terminal) and W(waiting
  // on user) only change on new user input; re-judging the same history re-derives
  // the same verdict at best, or misjudges D→C and wakes a finished task at worst.
  // ?force=true lets an operator override to correct a genuine misclassification.
  if ((ts.classifyState === 'D' || ts.classifyState === 'W') && String(req.query.force).toLowerCase() !== 'true') {
    return res.json({ ok: true, skipped: true, classifyState: ts.classifyState,
      note: `会话状态为 ${ts.classifyState}，跳过重判（需用户发新消息触发，或 ?force=true 强制）` });
  }
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
  if (reply.length < 20) return res.status(400).json({ error: 'no assistant reply to classify against' });
  const cleanPrior = isInjectedOrJunkGoal(ts.goal) ? '' : (ts.goal || '');
  auxQueue.enqueue({
    type: 'intent_classify',
    systemPrompt: buildClassifySystemPrompt(cleanPrior),
    prompt: buildClassifyConversation(sid, reply),
    meta: { sid, manual: true }
  }).then(result => {
    if (result.cancelled) return;
    const res = parseClassifyResult(result.text);
    const cs = chatSessions.get(sid);
    const sessionId = persistedSessions.get(sid)?.id || sid;
    dispatchStateAction(res, { sessionName: sid, sessionId, cs, isTerminal: false });
  }).catch(e => { if (e && e.cancelled) return; });
  res.json({ ok: true, note: 'reclassify enqueued; 状态更新会通过 WS 异步到达' });
});

// POST /api/reclassify-all — re-judge sessions in bulk. Body { onlyJunk?: bool }.
// Default onlyJunk=true → only sessions whose goal is injected/junk text. Set
// onlyJunk=false to re-judge every non-aux session.
app.post('/api/reclassify-all', (req, res) => {
  if (auxQueue.isUnhealthy()) return res.status(503).json({ error: 'aux 服务不可用，无法重判' });
  const onlyJunk = req.body?.onlyJunk !== false;
  const ids = [];
  for (const [sid, p] of persistedSessions) {
    if (!p || p.type === 'aux' || p.type === 'gateway') continue;
    const ts = getTaskState(p);
    // D/W guard — mirror scanAndReclassify (L7407); skip terminal/waiting BEFORE
    // the junk filter so D/W are never re-judged regardless of goal text.
    if (ts.classifyState === 'D' || ts.classifyState === 'W') continue;
    if (onlyJunk && !isInjectedOrJunkGoal(ts.goal)) continue;
    // Enqueue directly — same as scanAndReclassify
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
    if (reply.length < 20) continue;
    const cleanPrior = isInjectedOrJunkGoal(ts.goal) ? '' : (ts.goal || '');
    auxQueue.enqueue({
      type: 'intent_classify',
      systemPrompt: buildClassifySystemPrompt(cleanPrior),
      prompt: buildClassifyConversation(sid, reply),
      meta: { sid, manual: true }
    }).then(result => {
      if (result.cancelled) return;
      const res = parseClassifyResult(result.text);
      const cs = chatSessions.get(sid);
      const sessionId = persistedSessions.get(sid)?.id || sid;
      dispatchStateAction(res, { sessionName: sid, sessionId, cs, isTerminal: false });
    }).catch(e => { if (e && e.cancelled) return; });
    ids.push(sid);
  }
  res.json({ ok: true, count: ids.length, ids, onlyJunk });
});

// ── Agent resources (extracted to src/skills.js) ──
// Reads core state (directories, persistedSessions) from the shared state registry.
const {
  listInstalledSkills, listClaudeHistory, removeClaudeHistorySession,
} = require('./src/skills');

app.get('/api/agent-resources/skills', (req, res) => {
  const skills = listInstalledSkills();
  res.json({
    skills,
    counts: {
      claude: skills.filter(s => s.provider === 'claude').length,
      codex: skills.filter(s => s.provider === 'codex').length,
    },
  });
});

// ── Skill sync: status + manual trigger (drives the 技能同步 manage panel) ──
// GET returns the latest sync run snapshot; POST forces a full sync cycle.
// Both are gated by the same global auth middleware as the routes above.
app.get('/api/skill-sync/status', (req, res) => {
  res.json(_lastSkillSyncResult || {
    ts: 0, status: 'never-synced', providers: null,
    linkCount: 0, skipCount: 0, convCount: 0, reverseImportCount: 0, bundledInstallCount: 0,
    sharedSkillCount: 0, sharedSkillNames: [],
    aiQueue: { queueLength: 0, items: [], timerActive: false }, error: null,
  });
});

app.post('/api/skill-sync/run', (req, res) => {
  if (_skillSyncRunning) return res.status(409).json({ ok: false, error: 'sync already running' });
  _skillSyncRunning = true;
  try {
    const bundled = installBundledSkills();          // bundled multicc skills → agents
    const rev = skillConv.importAllProviderSkills(); // reverse-import providers → agents
    syncSharedSkills();                              // forward sync → all providers (records providers)
    _recordSkillSyncResult({ bundledInstallCount: bundled, reverseImportCount: (rev || []).length, error: null });
    res.json({ ok: true, result: _lastSkillSyncResult });
  } catch (e) {
    try { _recordSkillSyncResult({ error: e.message }); } catch (_) {}
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    _skillSyncRunning = false;
  }
});

// ── Agent presets (role prompt library, generated from agency-agents) ──
// Lazily read public/agent-presets.json once and cache in memory.
let _agentPresetsCache = null;
let _agentPresetsErr = null;
function loadAgentPresets() {
  if (_agentPresetsCache || _agentPresetsErr) return _agentPresetsCache;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'public', 'agent-presets.json'), 'utf8');
    _agentPresetsCache = JSON.parse(raw);
  } catch (e) {
    _agentPresetsErr = e;
    _agentPresetsCache = null;
  }
  return _agentPresetsCache;
}

// Prompt of the bundled "Agent Commander" preset — used to seed a default
// commander session in every newly-created directory. Returns null if missing.
const AGENT_COMMANDER_PRESET_ID = 'specialized__agent-commander';
function resolveAgentPresetProviderId(preset) {
  const cli = preset && preset.defaultCli === 'claude' ? 'claude' : 'codex';
  const key = String((preset && preset.defaultProviderKey) || '').toLowerCase();
  const model = String((preset && preset.defaultModel) || '').trim();
  const list = providers.listProviders(cli);
  if (key === 'openai-codex') {
    const byName = list.find(p => /openai|codex\s*官方|官方/i.test(p.name || ''));
    if (byName) return byName.id;
    const byModel = list.find(p => (p.modelOptions || []).includes('gpt-5.5') || (p.modelOptions || []).some(m => /^gpt-/i.test(m)));
    return byModel ? byModel.id : null;
  }
  if (key === 'xf-maas-coding') {
    const byModel = list.find(p => model && (p.modelOptions || []).includes(model));
    if (byModel) return byModel.id;
    const byName = list.find(p => /讯飞|xf|maas/i.test(p.name || ''));
    return byName ? byName.id : null;
  }
  return null;
}

function enrichAgentPresetDefaults(preset) {
  if (!preset || typeof preset !== 'object') return preset;
  const defaultProviderId = resolveAgentPresetProviderId(preset);
  const cli = preset.defaultCli === 'claude' ? 'claude' : 'codex';
  const defaultProviderName = defaultProviderId
    ? (providers.getProviderSummary(cli, defaultProviderId)?.name || defaultProviderId)
    : null;
  return { ...preset, defaultProviderId, defaultProviderName };
}

function agentCommanderPreset() {
  const data = loadAgentPresets();
  const p = data && (data.presets || []).find(x => x.id === AGENT_COMMANDER_PRESET_ID);
  return p || null;
}
function agentCommanderPrompt() {
  const p = agentCommanderPreset();
  return (p && p.prompt) ? p.prompt : null;
}

app.get('/api/agent-presets', (req, res) => {
  const data = loadAgentPresets();
  if (!data) return res.status(500).json({ error: 'agent presets unavailable' });
  // Strip the prompt field from the list to keep the payload small.
  const presets = (data.presets || []).map(p => {
    const { prompt, ...meta } = enrichAgentPresetDefaults(p);
    return meta;
  });
  res.json({
    source: data.source,
    version: data.version,
    generatedAt: data.generatedAt,
    categories: data.categories || [],
    featured: data.featured || [],
    presets,
  });
});

app.get('/api/agent-presets/:id', (req, res) => {
  const data = loadAgentPresets();
  if (!data) return res.status(500).json({ error: 'agent presets unavailable' });
  const preset = (data.presets || []).find(p => p.id === req.params.id);
  if (!preset) return res.status(404).json({ error: 'not found' });
  res.json(enrichAgentPresetDefaults(preset));
});

app.get('/api/agent-resources/claude-sessions', (req, res) => {
  const sessions = listClaudeHistory();
  res.json({
    sessions,
    count: sessions.length,
    totalSize: sessions.reduce((sum, s) => sum + s.size, 0),
    protectedCount: sessions.filter(s => s.linked).length,
  });
});

app.delete('/api/agent-resources/claude-sessions/:project/:id', (req, res) => {
  try {
    const result = removeClaudeHistorySession(req.params.project, req.params.id);
    if (!result.ok) return res.status(result.error.includes('protected') ? 409 : 404).json({ error: result.error });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/agent-resources/claude-sessions', (req, res) => {
  const olderThanDays = Number(req.query.olderThanDays);
  if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
    return res.status(400).json({ error: 'olderThanDays must be at least 1' });
  }
  const cutoff = Date.now() - olderThanDays * 86400 * 1000;
  let deleted = 0;
  let freed = 0;
  for (const session of listClaudeHistory()) {
    if (session.linked || new Date(session.updatedAt).getTime() >= cutoff) continue;
    try {
      const result = removeClaudeHistorySession(session.project, session.id);
      if (result.ok) { deleted++; freed += result.freed; }
    } catch (_) {}
  }
  res.json({ ok: true, deleted, freed });
});

// ── Directory REST API (src/directory: controller / service / repository) ──
// Routes: GET /api/fs/list · GET|POST /api/directories · PATCH|DELETE
// /api/directories/:id · POST :id/push · GET :id/uncommitted · POST :id/commit.
// Handlers live in src/directory/controller.js, business rules in service.js,
// persistence in repository.js — composed next to the persistence bootstrap.
app.use(directoryModule.router);

// ── Memo: per-directory <dir.path>/multicc.memo.md (markdown, user-owned) ──
const MEMO_FILENAME = 'multicc.memo.md';
const MEMO_MAX_BYTES = 5 * 1024 * 1024;   // 5 MiB sanity cap
function memoPathFor(dir) { return path.join(dir.path, MEMO_FILENAME); }

app.get('/api/directories/:id/memo', (req, res) => {
  const d = directories.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'directory not found' });
  const p = memoPathFor(d);
  let text = '', mtime = 0, exists = false;
  try {
    text = fs.readFileSync(p, 'utf8');
    mtime = fs.statSync(p).mtimeMs;
    exists = true;
  } catch (e) {
    if (e.code !== 'ENOENT') return res.status(500).json({ error: e.message });
  }
  res.json({ path: p, text, mtime, exists });
});

app.put('/api/directories/:id/memo', (req, res) => {
  const d = directories.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'directory not found' });
  if (typeof req.body.text !== 'string') return res.status(400).json({ error: 'text must be a string' });
  const text = req.body.text;
  if (Buffer.byteLength(text, 'utf8') > MEMO_MAX_BYTES) {
    return res.status(413).json({ error: 'memo too large (>5MB)' });
  }
  if (!fs.existsSync(d.path)) return res.status(400).json({ error: 'directory path missing' });
  const p = memoPathFor(d);
  try {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, p);
    res.json({ path: p, mtime: fs.statSync(p).mtimeMs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/directories/:id/memo/send', (req, res) => {
  const d = directories.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'directory not found' });
  const text = String(req.body.text || '').trim();
  const sessionId = String(req.body.sessionId || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const target = persistedSessions.get(sessionId);
  if (!target) return res.status(404).json({ error: 'session not found' });
  if (target.dirId !== d.id) return res.status(400).json({ error: 'session is not in this directory' });
  if (target.kind !== 'chat') return res.status(400).json({ error: '只能发送到 chat 类型的会话' });
  const cs = chatSessions.get(sessionId);
  if (cs && cs.claudeProc) return res.status(409).json({ error: '目标会话正在跑回合，稍后再试' });
  const ok = runChatTurn(sessionId, text, {});
  if (ok === false) return res.status(500).json({ error: '启动会话回合失败' });
  res.json({ ok: true, sentTo: sessionId });
});

app.get('/api/directories/:id/sessions', (req, res) => {
  const d = directories.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'directory not found' });
  const owned = [...persistedSessions.values()]
    .filter(s => s.dirId === d.id)
    .map(s => {
      const active = sessions.get(s.id);
      const activeChat = chatSessions.get(s.id);
      return {
        id: s.id, dirId: s.dirId, cli: s.cli, kind: s.kind,
        cliSessionId: s.cliSessionId || null, label: s.label || null,
        model: s.model || null, effort: s.effort || null, effectiveEffort: effectiveSessionEffort(s), agent: s.agent || null, rolePrompt: s.rolePrompt || null,
        provider: s.provider || null,  // cc-switch provider id; null = default login
        subagent: serializeSubagent(s.subagent),  // Task-tool subagent override; null = 随主
        cliStates: cliStateSummary(s), pendingCliHandoff: cliHandoffSummary(s),
        createdAt: s.createdAt,
        branch: s.branch || null,
        worktreePath: s.worktreePath || null,
        invalid: invalidSessions.get(s.id) || null,
        mergeState: mergeStateCached(d, s),
        lastActivity: s.kind === 'chat' ? chatLastActivity(s.id, activeChat) : active?.lastActivity || null,
        active: s.kind === 'terminal' ? !!active : !!(activeChat && (activeChat.clients.size > 0 || activeChat.isStreaming)),
        clients: s.kind === 'terminal' ? (active?.clients.size || 0) : (activeChat?.clients.size || 0),
      };
    });
  res.json({ directory: d, sessions: owned });
});

// Live status board snapshot for a directory (same shape as the /ws/workspace snapshot).
app.get('/api/directories/:id/workspace', (req, res) => {
  const d = directories.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'directory not found' });
  res.json({ directory: d, sessions: workspaceSnapshot(d.id) });
});

// Create + persist an isolated session record (its own git worktree + branch).
// Shared by the REST endpoint and the gateway dispatch path. Pass an explicit `id`
// to create/reuse a named session (e.g. ephemeral gateway chats). Returns
// { ok:true, id, session, reused? } or { ok:false, error }.
async function createSessionRecord({ dir, cli, kind, label = null, id = null, ephemeral = false, model = null, provider = undefined, effort = null, agent = null, rolePrompt = null }) {
  if (!dir) return { ok: false, error: 'directory not found' };
  if (!['claude', 'codex', 'opencode', 'zcode'].includes(cli)) return { ok: false, error: 'cli must be claude, codex, opencode or zcode' };
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
  let worktreePath, branch;
  try {
    ({ worktreePath, branch } = await gitWorktreeAdd(dir.path, sid, dir.baseBranch));
  } catch (e) {
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
    agent: sessionAgent || null, // Claude/OpenCode native --agent; unsupported CLIs keep null
    provider: providerId,  // cc-switch provider id; null = default login/subscription
    autoCommit: true,      // default: auto-commit & merge after task completion
    autoDispatch: false,   // default: do NOT inject dispatch context prompt unless user opts in
    // streaming (流式常驻) is now claude's default mode: keep the claude process
    // alive across turns for faster, context-preserving continuation. Non-claude
    // CLIs ignore this field. Only claude chat sessions default on.
    streaming: cli === 'claude' && kind === 'chat',
    // autoContinue is no longer a user-facing toggle (the picker keeps only the
    // streaming option). The field stays true for back-compat only; the old
    // auto-drive mechanisms (tryAutoContinue / B idle-timer) are retired.
    autoContinue: true,
    createdAt: new Date().toISOString(),
    worktreePath,
    branch,
  };
  if (rp) session.rolePrompt = rp;
  if (ephemeral) session.ephemeral = true;
  if (kind === 'chat') ensureCliStates(session);
  persistedSessions.set(sid, session);
  savePersistedSessions();
  appendEvent(dir.id, 'session_created', `${cli} ${kind}${ephemeral ? ' (gw)' : ''}`, sid);
  return { ok: true, id: sid, session };
}

app.post('/api/directories/:id/sessions', async (req, res) => {
  const d = directories.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'directory not found' });
  const cli = (req.body.cli || '').trim();
  const kind = (req.body.kind || '').trim();
  const label = (req.body.label || '').trim() || null;
  const model = (req.body.model || '').trim() || null;
  const effort = req.body.effort === undefined ? null : req.body.effort;
  const agent = req.body.agent === undefined ? null : req.body.agent;
  // provider: omit → inherit global default; '' → explicit no-override; id → that provider.
  const provider = req.body.provider === undefined ? undefined : ((req.body.provider || '').trim() || '');
  const rolePrompt = (req.body.rolePrompt || '').trim() || null;
  const r = await createSessionRecord({ dir: d, cli, kind, label, model, provider, effort, agent, rolePrompt });
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(r.session);
});

function cliSwitchDefaults(cli) {
  // Match normal session creation exactly. OpenCode/ZCode share a provider
  // pool with Claude, but must not silently inherit Claude's global default:
  // the provider/model may be unsupported by their native CLI.
  const provider = providerDefaults[cli] || null;
  return {
    provider,
    // A provider/model that is valid for Claude may not be accepted by
    // OpenCode/ZCode even though they share the Anthropic-compatible pool.
    // Let a newly activated CLI choose its own default model.
    model: null,
    effort: cli === 'codex' ? codexDefaultReasoningLevel() : null,
    subagent: null,
    agent: null,
  };
}

function cliHandoffSummary(session) {
  const handoff = session && session.pendingCliHandoff;
  return handoff ? {
    id: handoff.id,
    fromCli: handoff.fromCli,
    toCli: handoff.toCli,
    status: handoff.status,
    reason: handoff.reason || null,
    createdAt: handoff.createdAt,
    reusedTarget: !!handoff.reusedTarget,
  } : null;
}

function cliSwitchGitSnapshot(session) {
  const cwd = cwdForSession(session);
  const snapshot = { branch: session.branch || null, head: null, changes: [] };
  try {
    snapshot.head = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim() || null;
  } catch (_) {}
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--short'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    snapshot.changes = out.split('\n').map(line => line.trimEnd()).filter(Boolean).slice(0, 100);
  } catch (_) {}
  return snapshot;
}

function cliSwitchBusyState(sessionId) {
  const cs = chatSessions.get(sessionId);
  const stream = chatStream.status(sessionId);
  const busy = !!(
    (cs && (cs.isStreaming || cs.claudeProc))
    || (stream && (stream.busy || stream.queued > 0))
  );
  return { busy, cs, stream };
}

function resetChatRuntimeForCli(cs, session) {
  if (!cs) return;
  if (cs.claudeProc) {
    try { cs.claudeProc.kill('SIGTERM'); } catch (_) {}
    cs.claudeProc = null;
  }
  cancelClassify(cs);
  cs.cli = session.cli;
  cs.chatTurnCount = (session.cliSessionId || session._streamSessionId) ? 1 : 0;
  cs.lineBuf = '';
  cs.currentAssistantText = '';
  cs.currentToolCalls = [];
  cs.currentCost = null;
  cs.isStreaming = false;
  cs.streamReplay = [];
  cs._adapterError = null;
  cs._killReason = null;
  cs._resultSaved = false;
}

function performCliSwitch(session, targetCli, options = {}) {
  const fromCli = session.cli || 'claude';
  const now = Date.now();
  const history = loadChatHistory(session.id);
  const checkpoint = buildHandoffCheckpoint({
    session,
    fromCli,
    toCli: targetCli,
    history,
    git: cliSwitchGitSnapshot(session),
    now,
  });

  // Snapshot the source state before terminating its process. activateCliState
  // then restores the target's independent native id and settings, if present.
  const result = activateCliState(session, targetCli, {
    fresh: options.fresh === true,
    defaults: cliSwitchDefaults(targetCli),
    now,
  });
  const handoff = {
    id: `handoff_${crypto.randomBytes(8).toString('hex')}`,
    fromCli,
    toCli: targetCli,
    createdAt: checkpoint.createdAt,
    status: 'pending',
    reusedTarget: result.reused,
    checkpoint,
  };
  session.pendingCliHandoff = handoff;

  // chatStream owns Claude's warm process; killing cs.claudeProc alone does not
  // touch it. Always close the adapter state before reusing this logical id.
  chatStream.close(session.id);
  const cs = chatSessions.get(session.id);
  resetChatRuntimeForCli(cs, session);
  rememberActiveCliState(session, now);

  appendChatMessage(session.id, {
    role: 'system',
    content: `CLI switched from ${fromCli} to ${targetCli}. A structured handoff checkpoint will be delivered with the next message.`,
    ts: now,
    cliSwitch: { handoffId: handoff.id, fromCli, toCli: targetCli, reusedTarget: result.reused },
  });
  appendEvent(session.dirId, 'session_cli_changed', `${session.label || session.id}: ${fromCli} → ${targetCli}`, session.id);
  savePersistedSessions();
  chatBroadcast(session.id, {
    type: 'cli_switched',
    cli: targetCli,
    fromCli,
    handoffId: handoff.id,
    reusedTarget: result.reused,
    fresh: options.fresh === true,
    provider: session.provider || null,
    providerName: sessionProviderName(session),
    model: session.model || null,
    effectiveModel: effectiveSessionModel(session),
    effort: session.effort || null,
    effectiveEffort: effectiveSessionEffort(session),
    subagent: serializeSubagent(session.subagent),
  });
  if (session.dirId) workspaceBroadcast(session.dirId, { type: 'session_cli_changed', sessionId: session.id, cli: targetCli });
  return { result, handoff };
}

function consumePendingCliHandoff(sessionName) {
  const session = persistedSessions.get(sessionName);
  const handoff = session && session.pendingCliHandoff;
  if (!handoff || handoff.status !== 'pending') return false;
  session.lastCliHandoff = {
    id: handoff.id,
    fromCli: handoff.fromCli,
    toCli: handoff.toCli,
    createdAt: handoff.createdAt,
    consumedAt: new Date().toISOString(),
  };
  delete session.pendingCliHandoff;
  rememberActiveCliState(session);
  savePersistedSessions();
  chatBroadcast(sessionName, {
    type: 'system', subtype: 'cli_handoff_applied',
    message: handoff.reason === 'history_clear_keep'
      ? `✓ 保留的最近消息已由 ${handoff.toCli} 作为新上下文接收`
      : `✓ ${handoff.fromCli} → ${handoff.toCli} 的上下文交接已由目标 CLI 接收`,
  });
  return true;
}

app.post('/api/sessions/:id/switch-cli', (req, res) => {
  const session = persistedSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  if (session.type === 'aux' || session.type === 'gateway') {
    return res.status(400).json({ error: 'system session must be switched by its bridge controller' });
  }
  if (session.kind !== 'chat') return res.status(400).json({ error: 'only chat sessions can switch CLI' });
  const targetCli = String(req.body && req.body.cli || '').trim().toLowerCase();
  if (!SUPPORTED_CHAT_CLIS.includes(targetCli)) {
    return res.status(400).json({ error: `cli must be one of: ${SUPPORTED_CHAT_CLIS.join(', ')}` });
  }
  const fresh = !!(req.body && req.body.fresh);
  if ((session.cli || 'claude') === targetCli && !fresh) {
    ensureCliStates(session);
    return res.json({
      ok: true, changed: false, cli: targetCli,
      cliStates: cliStateSummary(session),
      cliAvailability: cliAvailabilitySummary(),
      pendingCliHandoff: cliHandoffSummary(session),
    });
  }
  const availability = cliAvailabilitySummary();
  if (!availability[targetCli]?.available) {
    return res.status(400).json({ error: `${targetCli} CLI is not installed or not executable` });
  }
  const activity = cliSwitchBusyState(session.id);
  if (activity.busy) {
    return res.status(409).json({
      error: 'session is running; wait for the current turn to finish or cancel it before switching CLI',
      stream: activity.stream || null,
    });
  }
  try {
    const switched = performCliSwitch(session, targetCli, { fresh });
    res.json({
      ok: true,
      changed: true,
      cli: session.cli,
      fromCli: switched.result.fromCli,
      handoffId: switched.handoff.id,
      reusedTarget: switched.result.reused,
      fresh,
      cliStates: cliStateSummary(session),
      cliAvailability: availability,
      effectiveModel: effectiveSessionModel(session),
      effectiveEffort: effectiveSessionEffort(session),
      provider: session.provider || null,
      providerName: sessionProviderName(session),
      model: session.model || null,
      effort: session.effort || null,
      agent: session.agent || null,
      subagent: serializeSubagent(session.subagent),
    });
  } catch (error) {
    console.error(`[multicc/cli-switch] ${session.id} → ${targetCli}:`, error);
    res.status(500).json({ error: `CLI switch failed: ${error.message}` });
  }
});

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
  if (req.body.label !== undefined) {
    const label = (req.body.label || '').toString().trim();
    if (label.length > 80) return res.status(400).json({ error: 'label too long (max 80)' });
    s.label = label || null;
    appendEvent(s.dirId, 'session_renamed', s.label || s.id, s.id);
  }
  if (req.body.model !== undefined) {
    const model = (req.body.model || '').toString().trim();
    // Allow `/` and `:` for OpenRouter-style ids and provider:model forms.
    if (model && !/^[A-Za-z0-9._:\/\[\]-]{1,100}$/.test(model)) {
      return res.status(400).json({ error: 'invalid model' });
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
    if (effort === undefined) return res.status(400).json({ error: 'invalid effort' });
    if (!validEffortForCli(s.cli || 'claude', effort)) return res.status(400).json({ error: 'invalid reasoning level' });
    s.effort = effort || null;
    if ((s.cli || 'claude') === 'claude') chatStream.close(s.id);
    appendEvent(s.dirId, 'session_effort_changed', `${s.label || s.id} → ${effectiveSessionEffort(s) || effortLabel(s.effort)}`, s.id);
  }
  if (req.body.agent !== undefined) {
    const agent = normalizeCliAgent(s.cli || 'claude', req.body.agent);
    if (agent === undefined) return res.status(400).json({ error: 'agent is only supported by Claude/OpenCode and must be a valid agent name' });
    s.agent = agent;
    if ((s.cli || 'claude') === 'claude' && s.kind === 'chat') chatStream.close(s.id);
    appendEvent(s.dirId, 'session_agent_changed', `${s.label || s.id} → ${s.agent || '默认 agent'}`, s.id);
  }
  if (req.body.rolePrompt !== undefined) {
    const rp = (req.body.rolePrompt == null ? '' : String(req.body.rolePrompt));
    if (rp.length > 40000) return res.status(400).json({ error: 'rolePrompt too long (max 40000)' });
    // null clears the session override → it falls back to the directory default.
    s.rolePrompt = rp.trim() || null;
    if ((s.cli || 'claude') === 'claude' && s.kind === 'chat') chatStream.close(s.id);
    appendEvent(s.dirId, 'session_role_changed', s.rolePrompt ? (s.label || s.id) : `${s.label || s.id}（清除，继承目录）`, s.id);
  }
  if (req.body.memory !== undefined) {
    // Session memory: structured entries (array of {type,text,ts}).
    // Accept both new array format and legacy string (auto-converted).
    let memVal = req.body.memory;
    let entries;
    if (memVal == null) {
      entries = null;  // clear
    } else if (Array.isArray(memVal)) {
      entries = memVal.filter(e => e && typeof e.text === 'string' && e.text.trim())
        .map(e => ({ type: MEMORY_TYPES.includes(e.type) ? e.type : 'fact', text: e.text.trim(), ts: e.ts || Date.now() }));
      const total = entries.reduce((s, e) => s + e.text.length, 0);
      if (total > SESSION_MEMORY_MAX) return res.status(400).json({ error: `memory too long (max ${SESSION_MEMORY_MAX} chars)` });
    } else if (typeof memVal === 'string' && memVal.trim()) {
      // Legacy string format — auto-convert to a single fact entry.
      if (memVal.length > SESSION_MEMORY_MAX) return res.status(400).json({ error: `memory too long (max ${SESSION_MEMORY_MAX})` });
      entries = [{ type: 'fact', text: memVal.trim(), ts: 0 }];
    } else {
      entries = null;  // empty/null → clear
    }
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
    // it true. The old auto-drive paths (tryAutoContinue / B idle-timer) are
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
    if (!v.ok) return res.status(400).json({ error: 'invalid provider' });
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
    const appType = (s.cli === 'codex') ? 'codex' : 'claude';
    if (req.body.model === undefined) {
      s.model = providerDefaultModel(appType, v.value) || null;
    } else if (!providers.modelValidForProvider(appType, v.value, s.model)) {
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
    const pname = v.value ? (providers.getProviderSummary(s.cli === 'codex' ? 'codex' : 'claude', v.value)?.name || v.value) : '默认登录';
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
      return res.status(400).json({ error: 'subagent routing is only supported by Claude and Codex' });
    }
    if (clearing) {
      s.subagent = null;
    } else if (typeof sa === 'object') {
      const subApp = (s.cli === 'codex') ? 'codex' : 'claude';
      const v = validProviderId(subApp, (sa.providerId || '').toString().trim());
      if (!v.ok) return res.status(400).json({ error: 'invalid subagent provider' });
      const model = (sa.model || '').toString().trim();
      if (!model) return res.status(400).json({ error: 'subagent model required' });
      if (s.cli === 'codex') {
        if (!s.provider) return res.status(400).json({ error: 'Codex subagent routing requires a selected main provider' });
        if (!providers.codexProviderProxyable(v.value)) {
          return res.status(400).json({ error: 'Codex subagent provider has no callable HTTP endpoint' });
        }
      }
      s.subagent = { providerId: v.value, model };
    } else {
      return res.status(400).json({ error: 'invalid subagent' });
    }
    // A warm streaming process must relaunch to pick up CLAUDE_CODE_SUBAGENT_MODEL.
    if ((s.cli || 'claude') === 'claude') chatStream.close(s.id);
    const subApp2 = (s.cli === 'codex') ? 'codex' : 'claude';
    const saName = s.subagent
      ? `${providers.getProviderSummary(subApp2, s.subagent.providerId)?.name || s.subagent.providerId} / ${s.subagent.model}`
      : '默认(随主)';
    appendEvent(s.dirId, 'session_subagent_changed', `${s.label || s.id} 子任务 → ${saName}`, s.id);
  }
  rememberActiveCliState(s);
  savePersistedSessions();
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
});

// ── Folder-based session memory: the human window into the same memory the ──
// agent receives when a native CLI session starts. Two scopes: own (private)
// and shared (all sessions in the directory). Each scope is a folder of .md.
app.get('/api/sessions/:id/memory', (req, res) => {
  const persisted = persistedSessions.get(req.params.id);
  if (!persisted) return res.status(404).json({ error: 'session not found' });
  ensureMemoryDirs(persisted);
  const own = sessionMemoryDir(persisted);
  const shared = sharedMemoryDir(persisted.dirId);
  res.json({
    own:    { dir: own,    primary: primaryMemFileName(persisted.cli), files: listMemoryFiles(own) },
    shared: { dir: shared, files: listMemoryFiles(shared) },
    // Legacy auto-distilled JSON entries, surfaced so the UI can offer a
    // one-click "promote into a .md" until the distiller writes files directly.
    legacy: getMemoryEntries(persisted),
  });
});

// Create or overwrite one memory file: { scope:'own'|'shared', name, content }.
app.put('/api/sessions/:id/memory', (req, res) => {
  const persisted = persistedSessions.get(req.params.id);
  if (!persisted) return res.status(404).json({ error: 'session not found' });
  const { scope, name, content } = req.body || {};
  const sc = scope === 'shared' ? 'shared' : 'own';
  const fn = safeMemFileName(name);
  if (!fn) return res.status(400).json({ error: 'invalid file name (must be a plain *.md name)' });
  const body = String(content == null ? '' : content);
  if (body.length > 40000) return res.status(400).json({ error: 'content too long (max 40000)' });
  const threat = scanMemoryContent(body);
  if (threat) return res.status(400).json({ error: `memory write blocked: ${threat}` });
  ensureMemoryDirs(persisted);
  const dir = memScopeDir(persisted, sc);
  try {
    atomicWriteMemoryFile(path.join(dir, fn), body);
  } catch (e) { return res.status(500).json({ error: 'write failed: ' + e.message }); }
  if (persisted.dirId) workspaceBroadcast(persisted.dirId, { type: 'memory', sessionId: persisted.id, scope: sc });
  res.json({ ok: true, files: listMemoryFiles(dir) });
});

// Delete one memory file: { scope:'own'|'shared', name }.
app.delete('/api/sessions/:id/memory', (req, res) => {
  const persisted = persistedSessions.get(req.params.id);
  if (!persisted) return res.status(404).json({ error: 'session not found' });
  const { scope, name } = req.body || {};
  const sc = scope === 'shared' ? 'shared' : 'own';
  const fn = safeMemFileName(name);
  if (!fn) return res.status(400).json({ error: 'invalid file name' });
  const dir = memScopeDir(persisted, sc);
  try { fs.unlinkSync(path.join(dir, fn)); }
  catch (e) { if (e.code !== 'ENOENT') return res.status(500).json({ error: 'delete failed: ' + e.message }); }
  if (persisted.dirId) workspaceBroadcast(persisted.dirId, { type: 'memory', sessionId: persisted.id, scope: sc });
  res.json({ ok: true, files: listMemoryFiles(dir) });
});

// Curated-memory mutation path used by agents and humans who want Hermes-like
// add/replace/remove semantics without rewriting a whole file. Writes a bounded
// MEMORY.md in the selected scope with duplicate prevention, injection scanning
// and atomic replace. The live CLI session keeps its frozen prompt snapshot;
// the response contains the new live entries so the writer can use them now.
app.post('/api/sessions/:id/memory/action', (req, res) => {
  const persisted = persistedSessions.get(req.params.id);
  if (!persisted) return res.status(404).json({ error: 'session not found' });
  if (persisted.type === 'aux' || persisted.type === 'gateway') {
    return res.status(400).json({ error: 'system sessions do not have curated memory' });
  }
  ensureMemoryDirs(persisted);
  const scope = req.body?.scope === 'shared' ? 'shared' : 'own';
  const result = applyCuratedMemoryAction({
    dir: memScopeDir(persisted, scope),
    action: String(req.body?.action || '').trim().toLowerCase(),
    content: req.body?.content,
    oldText: req.body?.oldText,
    charLimit: scope === 'shared' ? SHARED_CURATED_MEM_CAP : SESSION_CURATED_MEM_CAP,
  });
  if (!result.ok) return res.status(400).json(result);
  appendEvent(
    persisted.dirId,
    'memory_updated',
    `${scope === 'shared' ? '公共' : '私有'}记忆：${result.message}`,
    persisted.id,
  );
  workspaceBroadcast(persisted.dirId, { type: 'memory', sessionId: persisted.id, scope });
  res.json(result);
});

// ── Memory graph ──────────────────────────────────────────────────────────
// Build a directed graph of the memory system for visualization. Every .md
// file under memories/<dirId>/{_shared, sessions/*} becomes a node
// {id, title, summary, type, scope, …}; every [[wikilink]] in a file body
// becomes a directed edge {source, target, type:'reference', strength:count}.
// Dangling [[links]] (no matching file yet) surface as `missing` placeholder
// nodes so the "link liberally" convention is visible rather than dropped.
//
//   GET /api/memory/graph            → aggregate across all projects
//   GET /api/memory/graph?dirId=<id> → scope to one project (dir)
const MEM_GRAPH_MAX_NODES = 600; // safety cap so a huge store still renders <3s

// Estimate the token count of a memory file. No tokenizer dependency is bundled,
// so this is a deliberately-labelled ESTIMATE (UI always prefixes it with "~估"):
// CJK codepoints run ~1.5 tokens/char across GPT/Claude tokenizers, while Latin
// text averages ~4 chars/token. Good enough as a size gauge, never exact.
function estimateMemTokens(str) {
  const s = String(str == null ? '' : str);
  if (!s.length) return 0;
  const cjk = (s.match(/[㐀-䶿一-鿿豈-﫿぀-ゟ゠-ヿ가-힯]/g) || []).length;
  const other = s.length - cjk;
  return Math.max(1, Math.round(cjk * 1.5 + other / 4));
}

// Parse one memory .md into a node descriptor. Handles both the YAML-frontmatter
// convention (name/description/metadata.type) and the plain "# H1 + body" files
// that live in the store today. Never throws.
function parseMemoryMarkdown(raw, slug) {
  let body = String(raw == null ? '' : raw);
  const fm = {}; // flat frontmatter: title, description, name, type
  // ── YAML frontmatter (best-effort, no yaml dep) ──
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (m) {
    const yaml = m[1];
    body = body.slice(m[0].length);
    let inMeta = false;
    for (const line of yaml.split(/\r?\n/)) {
      const kv = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const indent = kv[1].length, key = kv[2], val = kv[3].replace(/^["']|["']$/g, '').trim();
      if (key === 'metadata') { inMeta = true; continue; }
      if (inMeta && indent > 0) { if (key === 'type') fm.metaType = val; continue; }
      inMeta = false;
      if (key === 'name') fm.name = val;
      else if (key === 'title') fm.title = val;
      else if (key === 'description') fm.description = val;
      else if (key === 'type') fm.type = val;
    }
    // 约定里 type 落在 metadata.type 下：让它确定性优先，避免与顶层 type 的先后顺序有关。
    if (fm.metaType) fm.type = fm.metaType;
  }
  // ── Title: frontmatter → first H1 → humanized slug ──
  let title = fm.title || '';
  if (!title) {
    const h1 = /^\s*#\s+(.+?)\s*$/m.exec(body);
    if (h1) title = h1[1].trim();
  }
  if (!title) title = String(slug || '').replace(/[-_]+/g, ' ').trim() || slug;
  title = title.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1'); // strip wikilinks from title
  // ── Summary: frontmatter description → first meaningful paragraph ──
  let summary = fm.description || '';
  if (!summary) {
    for (let ln of body.split(/\r?\n{2,}/)) {
      ln = ln.trim();
      if (!ln) continue;
      if (/^#/.test(ln)) continue;                 // skip headings
      const cleaned = ln
        .replace(/^>\s?/gm, '')                     // blockquote markers
        .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1') // wikilinks → text
        .replace(/`{1,3}/g, '')                     // code fences/ticks
        .replace(/[*_]{1,3}/g, '')                  // emphasis
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned) { summary = cleaned; break; }
    }
  }
  if (summary.length > 240) summary = summary.slice(0, 237) + '…';
  // ── Outgoing wikilink targets → { slug: count } ──
  const links = {};
  const re = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  let lm;
  while ((lm = re.exec(body))) {
    let t = lm[1].trim().replace(/\.md$/i, '');
    if (!t) continue;
    links[t] = (links[t] || 0) + 1;
  }
  return { title, summary, type: (fm.type || '').toLowerCase(), links };
}

// Classify a file into a node "kind" for colouring, from filename + frontmatter.
function memNodeKind(fileName, fmType) {
  if (fmType) return fmType; // user | feedback | project | reference …
  const base = String(fileName).toLowerCase();
  if (base === '_auto.md') return 'auto';
  if (['claude.md', 'agents.md', 'readme.md', 'memory.md'].includes(base)) return 'index';
  return 'note';
}

function buildMemoryGraph(dirIdFilter) {
  const nodes = [];
  const byId = new Map();     // id → node
  const slugIndex = new Map(); // dirId → Map(slug → [nodeId,…])
  const pending = [];         // { fromId, dirId, slug, count } resolved after scan
  let truncated = false;

  const addNode = (n) => { nodes.push(n); byId.set(n.id, n); return n; };
  const indexSlug = (dirId, slug, id) => {
    if (!slugIndex.has(dirId)) slugIndex.set(dirId, new Map());
    const m = slugIndex.get(dirId);
    if (!m.has(slug)) m.set(slug, []);
    m.get(slug).push(id);
  };

  let projectIds = [];
  try {
    projectIds = fs.readdirSync(MEMORY_STORE_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch (_) { projectIds = []; }
  if (dirIdFilter && dirIdFilter !== 'all') projectIds = projectIds.filter(id => id === dirIdFilter);

  const projects = [];

  const scanFolder = (absDir, meta) => {
    // meta: { dirId, scope:'shared'|'session', sessionId }
    let files;
    try { files = fs.readdirSync(absDir).filter(f => f.toLowerCase().endsWith('.md')); }
    catch (_) { return 0; }
    let count = 0;
    for (const file of files) {
      if (nodes.length >= MEM_GRAPH_MAX_NODES) { truncated = true; break; }
      let raw = '', size = 0;
      try { raw = fs.readFileSync(path.join(absDir, file), 'utf8'); size = Buffer.byteLength(raw); }
      catch (_) { continue; }
      const slug = file.replace(/\.md$/i, '');
      const parsed = parseMemoryMarkdown(raw, slug);
      const id = `${meta.dirId}::${meta.scope}${meta.sessionId ? ':' + meta.sessionId : ''}::${slug}`;
      const absFile = path.join(absDir, file);
      addNode({
        id, slug, file,
        title: parsed.title,
        summary: parsed.summary || '（无摘要）',
        type: memNodeKind(file, parsed.type),
        scope: meta.scope,
        sessionId: meta.sessionId || null,
        dirId: meta.dirId,
        size,
        // Storage location + token gauge, so the UI can show where a node lives
        // and open it in the file editor. `rel` is the store-root-relative key the
        // /api/memory/file endpoints resolve (always forward-slash separated).
        path: absFile,
        rel: path.relative(MEMORY_STORE_ROOT, absFile).split(path.sep).join('/'),
        tokens: estimateMemTokens(raw),
        missing: false,
      });
      indexSlug(meta.dirId, slug, id);
      for (const [target, c] of Object.entries(parsed.links)) {
        pending.push({ fromId: id, dirId: meta.dirId, slug: target, count: c });
      }
      count++;
    }
    return count;
  };

  for (const dirId of projectIds) {
    const before = nodes.length;
    const projRoot = path.join(MEMORY_STORE_ROOT, dirId);
    // shared
    scanFolder(path.join(projRoot, '_shared'), { dirId, scope: 'shared' });
    // per-session
    const sessRoot = path.join(projRoot, 'sessions');
    let sessDirs = [];
    try { sessDirs = fs.readdirSync(sessRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
    catch (_) {}
    for (const sid of sessDirs) {
      scanFolder(path.join(sessRoot, sid), { dirId, scope: 'session', sessionId: sid });
    }
    const dir = directories.get(dirId);
    const cnt = nodes.filter(n => n.dirId === dirId).length;
    if (cnt > 0 || (dir && dir.name)) {
      projects.push({ dirId, name: (dir && dir.name) || dirId.slice(0, 8), count: cnt });
    }
    void before;
  }

  // ── Resolve wikilink edges ──
  // A [[slug]] in a file resolves within the SAME project (dirId), preferring:
  // same-session node → shared node → any node in the project → else a dangling
  // placeholder node so the intent is still drawn.
  const edgeMap = new Map(); // `${source} ${target}` → strength
  const missingByKey = new Map(); // `${dirId}::${slug}` → placeholder node id
  const resolveTarget = (fromNode, dirId, slug) => {
    const idx = slugIndex.get(dirId);
    const candidates = idx && idx.get(slug);
    if (candidates && candidates.length) {
      // prefer a candidate in the same session, then shared, then first
      const from = byId.get(fromNode);
      if (from && from.sessionId) {
        const same = candidates.find(cid => byId.get(cid) && byId.get(cid).sessionId === from.sessionId);
        if (same) return same;
      }
      const shared = candidates.find(cid => byId.get(cid) && byId.get(cid).scope === 'shared');
      if (shared) return shared;
      return candidates[0];
    }
    return null;
  };
  for (const p of pending) {
    const from = byId.get(p.fromId);
    if (!from) continue;
    let targetId = resolveTarget(p.fromId, p.dirId, p.slug);
    if (!targetId) {
      const key = `${p.dirId}::${p.slug}`;
      if (missingByKey.has(key)) {
        targetId = missingByKey.get(key);
      } else if (nodes.length < MEM_GRAPH_MAX_NODES) {
        targetId = `${p.dirId}::missing::${p.slug}`;
        addNode({
          id: targetId, slug: p.slug, file: p.slug + '.md',
          title: String(p.slug).replace(/[-_]+/g, ' '),
          summary: '（尚未创建的记忆 · 被引用但文件不存在）',
          type: 'missing', scope: 'missing', sessionId: null,
          dirId: p.dirId, size: 0, path: null, rel: null, tokens: 0, missing: true,
        });
        missingByKey.set(key, targetId);
      } else { truncated = true; continue; }
    }
    if (targetId === p.fromId) continue; // no self-loops
    const k = `${p.fromId} ${targetId}`;
    edgeMap.set(k, (edgeMap.get(k) || 0) + p.count);
  }

  const edges = [];
  for (const [k, strength] of edgeMap) {
    const [source, target] = k.split(' ');
    edges.push({ source, target, type: 'reference', strength });
  }

  // degree (for node sizing on the client)
  const degree = new Map();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  for (const n of nodes) n.degree = degree.get(n.id) || 0;

  projects.sort((a, b) => b.count - a.count);
  return { nodes, edges, projects, truncated };
}

app.get('/api/memory/graph', (req, res) => {
  const t0 = Date.now();
  const dirId = req.query.dirId ? String(req.query.dirId) : 'all';
  let data;
  try {
    data = buildMemoryGraph(dirId);
  } catch (e) {
    return res.status(500).json({ error: 'graph build failed: ' + e.message });
  }
  res.json({
    nodes: data.nodes,
    edges: data.edges,
    meta: {
      dirId,
      projects: data.projects,
      nodeCount: data.nodes.length,
      edgeCount: data.edges.length,
      truncated: data.truncated,
      maxNodes: MEM_GRAPH_MAX_NODES,
      durationMs: Date.now() - t0,
    },
  });
});

// ── Memory TREE + generic file editor ──────────────────────────────────────
// A hierarchical view of the same on-disk store the graph reads, grouped by
//   项目(project=<dirId>) → 公共(_shared) + 会话(sessions/<id>)
// Each file carries its absolute path, a store-relative `rel` key, byte size,
// an estimated token count, its parsed title and mtime — so the UI can show
// where memory lives, total token weight, and open any file in an editor.
const MEM_TREE_MAX_FILES = 2000; // safety cap so a huge store still renders fast

// Resolve a store-relative `rel` to a safe absolute *.md path, or null. Rejects
// path traversal (.. / empty / backslash segments), anything outside the store
// root, and (for existing files) symlinks that escape the root via realpath.
function resolveMemoryFilePath(rel) {
  if (!rel || typeof rel !== 'string') return null;
  if (!/\.md$/i.test(rel)) return null;
  const segments = rel.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..' || seg.includes('\\') || seg.includes('\0')) return null;
  }
  const root = path.resolve(MEMORY_STORE_ROOT);
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  try {
    if (fs.existsSync(resolved)) {
      const real = fs.realpathSync(resolved);
      const realRoot = fs.realpathSync(root);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    }
  } catch (_) { return null; }
  return resolved;
}

// Build one tree file entry. `relDir` is the store-relative folder (forward
// slashes). Never throws — returns null on read/stat failure so one bad file
// doesn't sink the whole scan.
function memTreeFileEntry(absDir, relDir, name) {
  try {
    const abs = path.join(absDir, name);
    const raw = fs.readFileSync(abs, 'utf8');
    let mtime = null;
    try { mtime = fs.statSync(abs).mtime.toISOString(); } catch (_) {}
    const parsed = parseMemoryMarkdown(raw, name.replace(/\.md$/i, ''));
    return {
      name,
      rel: `${relDir}/${name}`,
      path: abs,
      size: Buffer.byteLength(raw),
      tokens: estimateMemTokens(raw),
      title: parsed.title || name.replace(/\.md$/i, ''),
      mtime,
    };
  } catch (_) { return null; }
}

// List the *.md files of one folder as tree entries, honoring the global cap.
// `counter` is a shared { n } so the cap spans the whole tree, not per-folder.
function listMemTreeFiles(absDir, relDir, counter) {
  let names;
  try { names = fs.readdirSync(absDir).filter(f => f.toLowerCase().endsWith('.md')).sort(); }
  catch (_) { return { files: [], tokens: 0 }; }
  const files = [];
  let tokens = 0;
  for (const name of names) {
    if (counter.n >= MEM_TREE_MAX_FILES) { counter.truncated = true; break; }
    const e = memTreeFileEntry(absDir, relDir, name);
    if (!e) continue;
    files.push(e); tokens += e.tokens; counter.n++;
  }
  return { files, tokens };
}

function buildMemoryTree() {
  const root = MEMORY_STORE_ROOT;
  let projectIds = [];
  try {
    projectIds = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch (_) { projectIds = []; }

  const counter = { n: 0, truncated: false };
  const projects = [];
  let sessionCount = 0;

  for (const dirId of projectIds) {
    const projRoot = path.join(root, dirId);
    const dir = directories.get(dirId);

    // 公共记忆 (_shared)
    const sharedRes = listMemTreeFiles(path.join(projRoot, '_shared'), `${dirId}/_shared`, counter);
    const shared = {
      dir: path.join(projRoot, '_shared'),
      rel: `${dirId}/_shared`,
      tokens: sharedRes.tokens,
      files: sharedRes.files,
    };

    // 会话记忆 (sessions/<id>)
    const sessions = [];
    let sessDirs = [];
    try {
      sessDirs = fs.readdirSync(path.join(projRoot, 'sessions'), { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name).sort();
    } catch (_) {}
    for (const sid of sessDirs) {
      const sRes = listMemTreeFiles(path.join(projRoot, 'sessions', sid), `${dirId}/sessions/${sid}`, counter);
      const persisted = persistedSessions.get(sid);
      sessions.push({
        sessionId: sid,
        label: (persisted && persisted.label) ? persisted.label : sid,
        cli: (persisted && persisted.cli) || null,
        live: !!persisted,
        dir: path.join(projRoot, 'sessions', sid),
        rel: `${dirId}/sessions/${sid}`,
        tokens: sRes.tokens,
        files: sRes.files,
      });
    }
    sessionCount += sessions.length;

    const projTokens = shared.tokens + sessions.reduce((a, s) => a + s.tokens, 0);
    const fileCount = shared.files.length + sessions.reduce((a, s) => a + s.files.length, 0);
    // Skip fully-empty projects (no files anywhere) to keep the tree tidy.
    if (fileCount === 0) continue;
    projects.push({
      dirId,
      name: (dir && dir.name) || dirId.slice(0, 8),
      dirPath: (dir && dir.path) || null,
      tokens: projTokens,
      fileCount,
      shared,
      sessions,
    });
  }

  projects.sort((a, b) => b.tokens - a.tokens);
  const totals = projects.reduce((a, p) => {
    a.tokens += p.tokens; a.files += p.fileCount; return a;
  }, { tokens: 0, files: 0 });

  return {
    root,
    projects,
    meta: {
      projectCount: projects.length,
      sessionCount,
      fileCount: totals.files,
      tokenTotal: totals.tokens,
      truncated: counter.truncated,
      maxFiles: MEM_TREE_MAX_FILES,
    },
  };
}

app.get('/api/memory/tree', (req, res) => {
  const t0 = Date.now();
  let data;
  try { data = buildMemoryTree(); }
  catch (e) { return res.status(500).json({ error: 'tree build failed: ' + e.message }); }
  data.meta.durationMs = Date.now() - t0;
  res.json(data);
});

// Read one memory file by store-relative `rel`.
app.get('/api/memory/file', (req, res) => {
  const rel = req.query.rel ? String(req.query.rel) : '';
  const abs = resolveMemoryFilePath(rel);
  if (!abs) return res.status(400).json({ error: 'invalid rel (must be a *.md under the memory store)' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file not found' });
  try {
    const content = fs.readFileSync(abs, 'utf8');
    let mtime = null;
    try { mtime = fs.statSync(abs).mtime.toISOString(); } catch (_) {}
    res.json({
      rel, path: abs, name: path.basename(abs), content,
      size: Buffer.byteLength(content), tokens: estimateMemTokens(content), mtime,
    });
  } catch (e) { res.status(500).json({ error: 'read failed: ' + e.message }); }
});

// Create/overwrite one memory file: { rel, content }. Parent dir must exist
// (we never conjure new project/session folders from a raw path).
app.put('/api/memory/file', (req, res) => {
  const { rel, content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content (string) required' });
  if (content.length > 200000) return res.status(413).json({ error: 'content too long (max 200000 chars)' });
  const abs = resolveMemoryFilePath(rel);
  if (!abs) return res.status(400).json({ error: 'invalid rel (must be a *.md under the memory store)' });
  if (!fs.existsSync(path.dirname(abs))) return res.status(400).json({ error: 'parent folder does not exist' });
  try {
    fs.writeFileSync(abs, content);
    let mtime = null;
    try { mtime = fs.statSync(abs).mtime.toISOString(); } catch (_) {}
    const dirId = String(rel).split('/')[0];
    if (dirId) try { workspaceBroadcast(dirId, { type: 'memory', rel, scope: rel.includes('/_shared/') ? 'shared' : 'own' }); } catch (_) {}
    res.json({ ok: true, rel, path: abs, size: Buffer.byteLength(content), tokens: estimateMemTokens(content), mtime });
  } catch (e) { res.status(500).json({ error: 'write failed: ' + e.message }); }
});

// Delete one memory file by store-relative `rel`.
app.delete('/api/memory/file', (req, res) => {
  const rel = (req.body && req.body.rel) || req.query.rel;
  const abs = resolveMemoryFilePath(rel);
  if (!abs) return res.status(400).json({ error: 'invalid rel (must be a *.md under the memory store)' });
  try { fs.unlinkSync(abs); }
  catch (e) { if (e.code !== 'ENOENT') return res.status(500).json({ error: 'delete failed: ' + e.message }); }
  const dirId = String(rel).split('/')[0];
  if (dirId) try { workspaceBroadcast(dirId, { type: 'memory', rel, scope: String(rel).includes('/_shared/') ? 'shared' : 'own' }); } catch (_) {}
  res.json({ ok: true });
});

// Delete a single message from this session's persisted chat history.
// Display-history only: the CLI's own transcript/context is not rewritten,
// so the model may still "remember" the content in an ongoing conversation.
// Debug: test classify on the last assistant message
app.post('/api/debug/classify/:id', (req, res) => {
  const sessionName = req.params.id;
  if (!persistedSessions.get(sessionName)) return res.status(404).json({ error: 'session not found' });
  const history = loadChatHistory(sessionName);
  if (!history.length) return res.status(400).json({ error: 'no history' });
  let lastText = '';
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string') { lastText = m.content; break; }
    if (Array.isArray(m.content)) { lastText = m.content.filter(b => b.type === 'text').map(b => b.text).join(' '); break; }
  }
  if (!lastText || lastText.length < 20) return res.status(400).json({ error: 'no valid assistant text', len: lastText.length });
  const tail = lastText.slice(-1500);
  const cs = chatSessions.get(sessionName);
  if (!cs) return res.status(400).json({ error: 'session not active' });
  // D/W guard — mirror scanAndReclassify (L7407). Debug endpoint keeps a ?force=true
  // escape hatch so an operator can still observe classify output on a D/W session.
  const _dbgTs = getTaskState(persistedSessions.get(sessionName));
  if ((_dbgTs.classifyState === 'D' || _dbgTs.classifyState === 'W') && String(req.query.force).toLowerCase() !== 'true') {
    return res.status(409).json({ error: `session is ${_dbgTs.classifyState}; use ?force=true to override`, classifyState: _dbgTs.classifyState });
  }
  cs.currentAssistantText = lastText;
  // runClassifyNow is fire-and-forget: it enqueues an aux task and resolves the
  // result asynchronously (logging the RESULT), so there's no callback to await.
  // The ⑦ gate makes it a silent no-op when aux is unhealthy — surface that here
  // so a debug caller isn't left wondering why no RESULT shows up in the logs.
  const auxUnhealthy = auxQueue.isUnhealthy();
  runClassifyNow(cs, sessionName);
  res.json({
    ok: true,
    sessionName,
    triggered: !auxUnhealthy,
    tailPreview: tail.slice(-300).replace(/\n/g, ' '),
    note: auxUnhealthy
      ? 'aux unhealthy — classify suppressed (⑦ gate), no RESULT will be logged'
      : 'classify enqueued — check server logs for classify RESULT',
  });
});

// ── Collect classify test cases ──
// Iterates all chat sessions with chat_history, extracts the last assistant
// message + current taskState, and returns structured test cases for review.
app.get('/api/debug/classify-test-cases', (req, res) => {
  const cases = [];
  for (const [sid, p] of persistedSessions) {
    if (!p || p.type === 'aux' || p.type === 'gateway' || p.kind !== 'chat') continue;
    const history = loadChatHistory(sid);
    if (!history || !history.length) continue;
    let lastText = '';
    let lastTs = null;
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m.role !== 'assistant') continue;
      if (typeof m.content === 'string') { lastText = m.content; lastTs = m.ts; break; }
      if (Array.isArray(m.content)) {
        lastText = m.content.filter(b => b.type === 'text').map(b => b.text).join(' ');
        lastTs = m.ts;
        break;
      }
    }
    if (!lastText || lastText.length < 40) continue;
    const tail = lastText.slice(-1500);
    const ts = p.taskState || {};
    cases.push({
      sessionId: sid,
      label: p.label || '',
      classifyState: ts.classifyState || null,
      goal: ts.goal || '',
      summary: p.summary || '',
      lastAssistantTail300: tail.slice(-300),
      lastAssistantFullTail: tail,
      lastActivity: p.lastActivity || null,
      lastTs: lastTs ? new Date(lastTs).toISOString() : null,
    });
  }
  // Sort by most recent first
  cases.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
  res.json({ count: cases.length, cases });
});

app.delete('/api/sessions/:id/messages/:msgId', (req, res) => {
  const sessionName = req.params.id;
  if (!persistedSessions.get(sessionName)) return res.status(404).json({ error: 'session not found' });
  const history = loadChatHistory(sessionName);
  const idx = history.findIndex(m => m && m.id === req.params.msgId);
  if (idx === -1) return res.status(404).json({ error: 'message not found' });
  history.splice(idx, 1);
  saveChatHistory(sessionName);
  // All connected clients (including the initiator) drop the bubble on this event.
  chatBroadcast(sessionName, { type: 'chat_msg_deleted', id: req.params.msgId });
  res.json({ ok: true });
});

// ── Session sharing (admin: create/list/revoke; ACCESS_TOKEN-gated) ──
// The link is built from the request host so a share created via the public
// (tunnel) URL is reachable externally; created on localhost it'll be a local link.
app.post('/api/sessions/:id/share', (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (s.type === 'aux') return res.status(400).json({ error: 'cannot share system session' });
  const b = req.body || {};
  try {
    const rec = share.create(s.id, {
      access: b.access, password: b.password,
      expiresAt: b.expiresAt, label: b.label || s.label || s.id,
    });
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, ...rec, url: `${base}/share/${rec.token}` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/sessions/:id/shares', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ shares: share.listForSession(req.params.id).map(r => ({ ...r, url: `${base}/share/${r.token}` })) });
});

app.delete('/api/sessions/:id/share/:token', (req, res) => {
  const r = share.get(req.params.token);
  if (r && r.sessionId !== req.params.id) return res.status(400).json({ error: 'token does not belong to this session' });
  res.json({ ok: share.remove(req.params.token) });
});

// Chat history (admin) — used by the "share selected messages" picker.
// Paginate chat_history for scroll-back. Returns the newest `limit` messages
// (when `before` is omitted) or the `limit` messages older than the entry with
// id `before`. `hasMore` tells the client there's even older history to fetch.
// Used by both the HTTP /history route and the initial WS chat_history push.
function paginateChatHistory(history, { before, limit } = {}) {
  const lim = Math.max(1, Math.min(100, parseInt(limit, 10) || CHAT_HISTORY_PAGE));
  let end = history.length;
  if (before) {
    const idx = history.findIndex(m => m && m.id === before);
    if (idx === -1) {
      // `before` not found (deleted/unknown): return empty page, hasMore=false
      // so the client stops paginating instead of looping.
      return { messages: [], hasMore: false };
    }
    end = idx;
  }
  const start = Math.max(0, end - lim);
  const messages = history.slice(start, end);
  return { messages, hasMore: start > 0 };
}

app.get('/api/sessions/:id/history', (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const history = loadChatHistory(req.params.id);
  const page = paginateChatHistory(history, {
    before: req.query.before && String(req.query.before),
    limit: req.query.limit && String(req.query.limit),
  });
  res.json(page);
});

// Create a read-only snapshot share of selected messages (by index into history).
app.post('/api/sessions/:id/share-messages', (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const b = req.body || {};
  const history = loadChatHistory(req.params.id);
  const indices = Array.isArray(b.indices) ? b.indices : [];
  const picked = indices
    .map(i => history[i])
    .filter(Boolean);
  if (!picked.length) return res.status(400).json({ error: 'no valid messages selected' });
  try {
    const rec = share.createMessageShare(s.id, picked, {
      password: b.password, expiresAt: b.expiresAt, label: b.label || s.label || s.id,
    });
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, ...rec, url: `${base}/share/${rec.token}` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Session fork (Happier-parity: branch a session at any message) ──
// Creates a NEW live session that inherits the source's provider/model/effort/
// rolePrompt and replays the transcript up to (and including) the chosen message
// as its starting context — like Happier's forkedTranscriptSnapshot + replaySeed.
// The 50-message rolling window means old messages may already be distilled into
// memory; we therefore also copy the source session's private memory folder so the
// forked session isn't blind to pre-window context. A `forkedFrom` meta record is
// stamped as the first message of the new history.
app.post('/api/sessions/:id/fork', async (req, res) => {
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
  });
  if (!r.ok) return res.status(400).json({ error: r.error });
  const newSid = r.id;
  if (src.subagent && src.subagent.providerId && src.subagent.model) {
    r.session.subagent = { providerId: src.subagent.providerId, model: src.subagent.model };
    rememberActiveCliState(r.session);
  }

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
  chatHistories.set(newSid, newHistory);
  saveChatHistory(newSid);

  // A fork has a fresh vendor-native session, so copying display history alone
  // is not context continuation. Seed the same one-shot checkpoint mechanism
  // used by cross-CLI switches; it is consumed only after the fork produces a
  // successful result.
  const forkCheckpoint = buildHandoffCheckpoint({
    session: src,
    fromCli: src.cli,
    toCli: r.session.cli,
    history: sliced,
    git: cliSwitchGitSnapshot(r.session),
  });
  r.session.pendingCliHandoff = {
    id: `fork_${crypto.randomBytes(8).toString('hex')}`,
    fromCli: src.cli,
    toCli: r.session.cli,
    createdAt: forkCheckpoint.createdAt,
    status: 'pending',
    reusedTarget: false,
    checkpoint: forkCheckpoint,
  };
  savePersistedSessions();

  // Copy the source session's private memory folder (CLAUDE.md/AGENTS.md + any
  // notes) so pre-window distilled context survives into the fork. Best-effort.
  if (includeMemory) {
    try {
      const srcMemDir = sessionMemoryDir(src);
      const dstMemDir = sessionMemoryDir(r.session);
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
});

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

app.get('/api/sessions/:id/bundle', (req, res) => {
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
      const memDir = sessionMemoryDir(s);
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
    const provEnv = providers.resolveSpawnEnv(s);
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
        const base = dir && dir.baseBranch ? dir.baseBranch : 'main';
        // Count unique commits on the session branch vs base. Zero → skip.
        let unique = 0;
        try {
          const out = execFileSync('git', ['-C', s.worktreePath, 'rev-list',
                                            '--count', `${base}..${s.branch}`],
                                   { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          unique = parseInt(out, 10) || 0;
        } catch (_) { /* base may not be resolvable yet — fall back to full branch */ }
        if (unique === 0) {
          gitBundleNote = `no unique commits vs ${base} (already merged) — target's main has the work; no git payload needed`;
        } else {
          const tmp = path.join(os.tmpdir(), `multicc-bundle-${s.id}-${Date.now()}.bundle`);
          // Range refspec `base..branch` packs only the session's own commits.
          execFileSync('git', ['-C', s.worktreePath, 'bundle', 'create', tmp,
                               `${base}..${s.branch}`], { encoding: 'buffer', stdio: ['ignore', 'ignore', 'pipe'] });
          const stat = fs.statSync(tmp);
          if (stat.size > MAX_BUNDLE_BYTES) {
            fs.unlinkSync(tmp);
            gitBundleNote = `git bundle too large (${(stat.size/1024/1024).toFixed(1)}MB > ${MAX_BUNDLE_BYTES/1024/1024}MB cap) — skipped; merge excess back to base first`;
          } else {
            gitBundleB64 = fs.readFileSync(tmp).toString('base64');
            gitBundleNote = `${unique} unique commits, ${(stat.size/1024).toFixed(0)}KB bundle`;
            fs.unlinkSync(tmp);
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
});

// Import an encrypted bundle produced by GET /api/sessions/:id/bundle and
// rebuild the session on THIS machine. The target directory (dirId) must be a
// git repo (we recreate the worktree from the bundle's git payload). Provider
// credentials are NOT auto-injected: pass targetProviderId to attach the new
// session to an already-configured provider on this machine, or omit to use the
// default login. The bundle's provider env/codex files are kept in the session's
// memory folder as `.handoff-provider.json` for reference/manual setup.
app.post('/api/sessions/import', async (req, res) => {
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
  });
  if (!r.ok) return res.status(400).json({ error: r.error });
  const newSid = r.id;
  const newSession = r.session;

  try {
    // 1) Restore chat history.
    if (Array.isArray(payload.messages)) {
      chatHistories.set(newSid, payload.messages);
      saveChatHistory(newSid);
    }

    // 2) Restore memory files.
    if (payload.memoryFiles && typeof payload.memoryFiles === 'object') {
      const memDir = sessionMemoryDir(newSession);
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

    // 3) Overlay the bundle's git content onto the freshly-created worktree.
    //    Fetch the bundle's branch into a temp ref, then reset the worktree's
    //    HEAD to it so the working tree matches the source session.
    let gitRestored = false, gitNote = null;
    if (payload.gitBundleB64 && newSession.worktreePath && newSession.branch) {
      const tmpBundle = path.join(os.tmpdir(), `multicc-import-${newSid}-${Date.now()}.bundle`);
      try {
        fs.writeFileSync(tmpBundle, Buffer.from(payload.gitBundleB64, 'base64'));
        const srcBranch = meta.branch || `multicc/${meta.id}`;
        const incomingRef = `refs/heads/multicc-import-${newSid}`;
        // Fetch the source branch from the bundle into a temp ref on the main repo.
        execFileSync('git', ['-C', dir.path, 'fetch', '--no-tags', '-f', tmpBundle,
                             `+${srcBranch}:${incomingRef}`],
                     { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
        // Reset the worktree's branch onto the incoming commit so its working
        // tree and history mirror the source session. Use -C worktreePath so git
        // resolves the branch the worktree is on.
        execFileSync('git', ['-C', newSession.worktreePath, 'reset', '--hard', incomingRef],
                     { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
        // Drop the temp ref from the main repo (the worktree branch holds the history now).
        try { execFileSync('git', ['-C', dir.path, 'update-ref', '-d', incomingRef],
                           { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }); } catch (_) {}
        gitRestored = true;
      } catch (e) {
        gitNote = 'git restore failed: ' + e.message;
      } finally {
        try { fs.unlinkSync(tmpBundle); } catch (_) {}
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
});

// ── Share recipient endpoints (NO ACCESS_TOKEN; gated by the share token only) ──
// The page; the inline JS reads the token from the URL and self-gates.
app.get('/share/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// Submit the share password → mint the per-share auth cookie.
app.post('/api/share/:token/auth', (req, res) => {
  const token = req.params.token;
  const r = share.get(token);
  if (!r) return res.status(404).json({ error: 'share not found or expired' });
  if (!share.verifyPassword(token, (req.body || {}).password)) {
    return res.status(403).json({ error: '密码错误' });
  }
  res.setHeader('Set-Cookie',
    `${share.cookieName(token)}=${share.authCookieValue(r)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86400}`);
  res.json({ ok: true, access: r.access });
});

// Scoped read of the shared session: meta + history. 401 if a password is needed.
app.get('/api/share/:token/session', (req, res) => {
  const token = req.params.token;
  const r = share.get(token);
  if (!r) return res.status(404).json({ error: 'share not found or expired' });
  const a = share.access(token, { cookies: parseCookies(req.headers.cookie) });
  if (!a) return res.status(401).json({ needPassword: true });
  // Message snapshot share: static, read-only, independent of the live session.
  if (r.type === 'messages') {
    return res.json({ access: 'view', type: 'messages', label: r.label || '消息分享', messages: r.messages || [] });
  }
  const persisted = persistedSessions.get(r.sessionId);
  if (!persisted) return res.status(404).json({ error: 'session no longer exists' });
  res.json({
    access: a.access,
    type: 'session',
    sessionId: r.sessionId,
    label: persisted.label || r.sessionId,
    cli: persisted.cli || 'claude',
    messages: loadChatHistory(r.sessionId),
  });
});

// ── Per-session auto-triggers ──
// Written by the bundled multicc-trigger skill (via localhost) or the manage UI;
// read by the trigger runtime (file-watch / cron / post-turn).
app.get('/api/sessions/:id/triggers', (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  res.json({ triggers: s.triggers || [] });
});

app.post('/api/sessions/:id/triggers', (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const v = validateTrigger(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  if (!Array.isArray(s.triggers)) s.triggers = [];
  s.triggers.push(v.trigger);
  savePersistedSessions();
  reconcileTriggers(s.id);
  appendEvent(s.dirId, 'trigger_added', triggerLabel(v.trigger), s.id);
  res.json(v.trigger);
});

app.put('/api/sessions/:id/triggers/:tid', (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s || !Array.isArray(s.triggers)) return res.status(404).json({ error: 'not found' });
  const idx = s.triggers.findIndex((t) => t.id === req.params.tid);
  if (idx < 0) return res.status(404).json({ error: 'trigger not found' });
  const v = validateTrigger({ ...s.triggers[idx], ...req.body, id: req.params.tid });
  if (v.error) return res.status(400).json({ error: v.error });
  v.trigger.lastFiredAt = s.triggers[idx].lastFiredAt; // preserve across edits
  s.triggers[idx] = v.trigger;
  savePersistedSessions();
  reconcileTriggers(s.id);
  res.json(v.trigger);
});

app.delete('/api/sessions/:id/triggers/:tid', (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s || !Array.isArray(s.triggers)) return res.status(404).json({ error: 'not found' });
  const before = s.triggers.length;
  s.triggers = s.triggers.filter((t) => t.id !== req.params.tid);
  if (s.triggers.length === before) return res.status(404).json({ error: 'trigger not found' });
  savePersistedSessions();
  reconcileTriggers(s.id);
  res.json({ ok: true });
});

// Fire a trigger immediately, bypassing cooldown + enabled (for manual testing).
app.post('/api/sessions/:id/triggers/:tid/test', (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s || !Array.isArray(s.triggers)) return res.status(404).json({ error: 'not found' });
  const t = s.triggers.find((x) => x.id === req.params.tid);
  if (!t) return res.status(404).json({ error: 'trigger not found' });
  fireTrigger(s.id, { ...t, enabled: true, cooldownMs: 0 }, 'manual-test');
  res.json({ ok: true });
});

app.get('/api/sessions/:id', (req, res) => {
  const id = req.params.id;
  const active = sessions.get(id);
  const persisted = persistedSessions.get(id);
  if (!active && !persisted) return res.status(404).json({ error: 'Session not found' });
  const dir = persisted?.dirId ? directories.get(persisted.dirId) : null;
  const mergeState = persisted ? mergeStateCached(dir, persisted) : null;
  const cli = persisted?.cli || 'claude';
  const model = persisted?.model || null;
  const effectiveModel = effectiveSessionModel(persisted);
  const effort = persisted?.effort || null;
  const effectiveEffort = effectiveSessionEffort(persisted);
  const agent = persisted?.agent || null;
  const cliAvailability = cliAvailabilitySummary();
  // The session's own role override (null = inherits the directory default).
  const rolePrompt = persisted?.rolePrompt || null;
  const memory = persisted?.memory || null;  // distilled session memory
  // streaming (流式常驻) is claude chat's only mode now — reported for back-compat
  // with older clients but no longer toggleable. Reflect the effective behavior
  // (always on for claude chat) rather than any stale persisted flag.
  const isClaudeChat = persisted?.cli !== 'codex' && persisted?.cli !== 'opencode' && persisted?.cli !== 'zcode'
    && persisted?.kind !== 'terminal';
  const streaming = isClaudeChat;
  // autoContinue is no longer user-facing; always true (classify gates the actual
  // injection). Legacy sessions that predate the pinned field default to true too.
  // tryAutoContinue is retired (0 call sites) — this field is vestigial.
  const autoContinue = persisted?.autoContinue !== false;
  const autoCommit = !!persisted?.autoCommit;
  const autoDispatch = !!persisted?.autoDispatch;
  const provider = persisted?.provider || null;  // cc-switch provider id; null = default login
  const subagent = serializeSubagent(persisted?.subagent);  // Task-tool subagent override; null = 随主
  const cliStates = cliStateSummary(persisted);
  const pendingCliHandoff = cliHandoffSummary(persisted);
  const activeChat = persisted?.kind === 'chat' ? chatSessions.get(id) : null;
  const lastActivity = persisted?.kind === 'chat' ? chatLastActivity(id, activeChat) : null;
  if (active) {
    res.json({ id: active.id, cwd: active.cwd, createdAt: active.createdAt, lastActivity: active.lastActivity, clients: active.clients.size, active: true, mergeState, cli, model, effectiveModel, effort, effectiveEffort, agent, rolePrompt, memory, provider, subagent, cliStates, cliAvailability, pendingCliHandoff, streaming, autoContinue, autoCommit, autoDispatch });
  } else if (persisted?.kind === 'chat') {
    res.json({ id: persisted.id, cwd: cwdForSession(persisted), createdAt: persisted.createdAt, lastActivity, clients: activeChat ? activeChat.clients.size : 0, active: !!(activeChat && (activeChat.clients.size > 0 || activeChat.isStreaming)), mergeState, cli, model, effectiveModel, effort, effectiveEffort, agent, rolePrompt, memory, provider, subagent, cliStates, cliAvailability, pendingCliHandoff, streaming, autoContinue, autoCommit, autoDispatch });
  } else {
    res.json({ id: persisted.id, cwd: persisted.cwd, createdAt: persisted.createdAt, lastActivity: null, clients: 0, active: false, mergeState, cli, model, effectiveModel, effort, effectiveEffort, agent, rolePrompt, memory, provider, subagent, cliStates, cliAvailability, pendingCliHandoff, streaming, autoContinue, autoCommit, autoDispatch });
  }
});

app.get('/api/sessions/:id/merge-status', (req, res) => {
  const persisted = persistedSessions.get(req.params.id);
  if (!persisted) return res.status(404).json({ error: 'session not found' });
  const dir = directories.get(persisted.dirId);
  if (!dir) return res.status(404).json({ error: 'directory not found' });
  res.json(mergeStateCached(dir, persisted));
});

app.get('/api/sessions/:id/diff', async (req, res) => {
  const persisted = persistedSessions.get(req.params.id);
  if (!persisted) return res.status(404).json({ error: 'session not found' });
  const dir = directories.get(persisted.dirId);
  if (!dir) return res.status(404).json({ error: 'directory not found' });
  if (!persisted.worktreePath || !fs.existsSync(persisted.worktreePath)) {
    return res.status(400).json({ error: 'worktree missing' });
  }
  const baseBranch = dir.baseBranch || await gitBaseBranch(dir.path);
  const wt = persisted.worktreePath;
  const MAX_DIFF = 1024 * 1024;   // 1 MiB cap; keep UI snappy
  let diff = '', stat = '', truncated = false, error = null;
  // Async + serialized via the git queue: a big/slow diff no longer blocks the
  // event loop, and never runs concurrently with other git work.
  try {
    diff = await gitRunQueued(wt, ['diff', '--no-color', baseBranch], { maxBuffer: MAX_DIFF + 16 * 1024 });
    if (diff.length > MAX_DIFF) { diff = diff.slice(0, MAX_DIFF); truncated = true; }
  } catch (e) {
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      truncated = true;
      diff = '(diff exceeds 1MB cap — too large to display in browser)';
    } else {
      error = e.stderr ? String(e.stderr).slice(0, 400) : e.message;
    }
  }
  try {
    stat = await gitRunQueued(wt, ['diff', '--stat', '--no-color', baseBranch], { maxBuffer: 256 * 1024 });
  } catch (_) { /* stat is best-effort */ }
  res.json({
    baseBranch,
    branch: persisted.branch,
    stat,
    diff,
    truncated,
    mergeState: mergeStateCached(dir, persisted),
    error,
  });
});

// ── Git tree viewer ──
// Returns a simplified git log for a directory or session, suitable for
// rendering a commit-tree in the fleet panel. Supports ?limit= (default 30)
// and ?all (include all branches).
app.get('/api/git/log', async (req, res) => {
  const dirId = req.query.dirId;
  const sessionId = req.query.sessionId;
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const allBranches = req.query.all === '1';

  let repoPath;
  if (sessionId) {
    const persisted = persistedSessions.get(sessionId);
    if (!persisted || !persisted.worktreePath) return res.status(404).json({ error: 'session or worktree not found' });
    repoPath = persisted.worktreePath;
  } else if (dirId) {
    const dir = directories.get(dirId);
    if (!dir) return res.status(404).json({ error: 'directory not found' });
    repoPath = dir.path;
  } else {
    return res.status(400).json({ error: 'dirId or sessionId required' });
  }
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: 'repo path missing' });

  const args = ['log', `-${limit}`, '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%D', '--no-color'];
  if (allBranches) args.push('--all');
  try {
    const raw = await gitRunQueued(repoPath, args, { maxBuffer: 512 * 1024 });
    const lines = raw.trim().split('\n').filter(Boolean);
    const commits = lines.map(line => {
      const [hash, short, author, date, subject, refs] = line.split('\x00');
      return { hash, short, author, date, subject, refs: refs ? refs.replace(/^,\s*/, '').trim() : '' };
    });
    res.json({ commits, repoPath });
  } catch (e) {
    res.status(500).json({ error: e.stderr ? String(e.stderr).slice(0, 400) : e.message });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  const id = req.params.id;
  const session = sessions.get(id);
  const chat = chatSessions.get(id);
  const persisted = persistedSessions.get(id);
  if (!session && !chat && !persisted) {
    return res.status(404).json({ error: 'Session not found' });
  }
  const force = req.query.force === '1' || req.body?.force === true;
  if (persisted) {
    const dir = directories.get(persisted.dirId);
    if (!dir) return res.status(404).json({ error: 'directory not found' });
    const result = await destroySessionCascade(persisted, dir, { force });
    if (!result.ok) return res.status(409).json(result);
    appendEvent(persisted.dirId, 'session_deleted', persisted.label || persisted.id, null);
    savePersistedSessions();
    return res.json({ ...result, forced: force });
  } else if (!force) {
    return res.status(409).json({ ok: false, blocked: true, reasons: ['active'], error: 'active session cannot be removed without force=1' });
  } else {
    if (session) await tmuxKillSession(id);
    sessions.delete(id);
    chatSessions.delete(id);
  }
  savePersistedSessions();
  res.json({ ok: true, forced: force });
});

// Relocate: moves a session to a different directory. Caller passes the target dirId.
// (Old "change cwd" semantics are gone — cwd lives on the directory now.)
app.post('/api/sessions/:id/relocate', async (req, res) => {
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
    activeCheck: force ? null : () => sessionWorktreeActive(id),
    beforeRemove: async () => {
      if (oldSession) {
        broadcastTo(oldSession.clients, { type: 'relocate', cwd: targetDir.path });
        await stopOutputCapture(oldSession);
        await tmuxKillSession(oldSession.id);
        sessions.delete(id);
      }
      if (activeChat && force) {
        if (activeChat.claudeProc) try { activeChat.claudeProc.kill('SIGTERM'); } catch (_) {}
        chatStream.close(id);
        chatSessions.delete(id);
      }
    },
  });
  if (!relocated.ok) return res.status(relocated.blocked ? 409 : 500).json(relocated);

  persisted.worktreePath = relocated.worktreePath;
  persisted.branch = relocated.branch;

  persisted.dirId = targetDirId;
  // Clear cliSessionId so the new instance starts fresh in the new directory
  persisted.cliSessionId = null;
  invalidSessions.delete(id);
  savePersistedSessions();

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
});

// ── Restart session (kill tmux + respawn CLI in same directory, fresh conversation) ──
app.post('/api/sessions/:id/restart', async (req, res) => {
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
    persisted.cliSessionId = null;
    const dir = directories.get(persisted.dirId);
    if (dir && (!persisted.worktreePath || !fs.existsSync(persisted.worktreePath))) {
      const ready = await ensureDirGitReady(dir);
      if (ready.ok) {
        try {
          const { worktreePath, branch } = await gitWorktreeAdd(dir.path, id, dir.baseBranch);
          persisted.worktreePath = worktreePath;
          persisted.branch = branch;
        } catch (e) {
          console.warn(`[multicc] restart: worktree recreate failed for ${id}: ${e.message}`);
        }
      }
    }
    savePersistedSessions();
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
});

// ── Restart the whole multicc server (graceful) ──
// A detached child re-launches us after we exit. Auth-gated (deliberately NOT
// in the bypass allowlist at the top of this file), so shared view/operate
// viewers cannot reach it. The child runs `./multicc restart`, whose do_stop
// sends SIGINT → gracefulShutdown (drains in-flight turns + flushes partial
// chats) before do_start brings up a fresh instance.
// Debounce flag distinct from _shuttingDown: gracefulShutdown short-circuits on
// _shuttingDown, so reusing it here would abort the very shutdown we want. Once
// a restart is scheduled we never reset it — the process is about to be replaced.
let _restartScheduled = false;
app.post('/api/restart', (req, res) => {
  if (_shuttingDown || _restartScheduled) return res.status(409).json({ error: 'restart already in progress' });
  _restartScheduled = true;
  // Count sessions with a genuinely in-flight streaming turn (not a stale one)
  // so the client can warn the user those turns will be interrupted — their
  // partial output is flushed to disk by gracefulShutdown before exit.
  let activeStreaming = 0;
  for (const cs of chatSessions.values()) {
    if (cs && cs.isStreaming && (Date.now() - (cs.lastStreamAt || 0)) < 600000) activeStreaming++;
  }
  // Respond BEFORE the process dies so the HTTP response actually flushes.
  res.json({ ok: true, activeStreaming });
  // detached + unref so the child survives our exit; stdio ignored so it
  // doesn't keep our event loop alive. The 2s sleep only lets THIS response
  // flush — the actual graceful stop (kill -INT → drain + flush) and port
  // release happen inside the child's `./multicc restart` do_stop.
  setImmediate(() => {
    try {
      const child = spawn('/bin/sh', ['-c', 'sleep 2 && ./multicc restart'], {
        cwd: __dirname, detached: true, stdio: 'ignore', env: process.env,
      });
      child.unref();
      console.log('[multicc] /api/restart: detached graceful restart scheduled');
    } catch (e) {
      console.error('[multicc] /api/restart: spawn failed', e && e.message);
    }
  });
});

// ── Merge a session's worktree branch back into the directory's base branch ──
app.post('/api/sessions/:id/merge', async (req, res) => {
  const id = req.params.id;
  const persisted = persistedSessions.get(id);
  if (!persisted) return res.status(404).json({ error: 'session not found' });
  if (!persisted.worktreePath || !persisted.branch) {
    return res.status(400).json({ error: '该会话没有 worktree，无需合并' });
  }
  const dir = directories.get(persisted.dirId);
  if (!dir) return res.status(404).json({ error: 'directory not found' });

  const result = await gitMergeBack(dir, persisted);
  if (!result.ok) {
    // conflict → 409 with file list; other failures → 400
    return res.status(result.conflicts?.length ? 409 : 400).json(result);
  }
  console.log(`[multicc] merge ${persisted.branch} → ${dir.baseBranch}: ` +
    (result.merged ? `${result.commits} commit(s)` : 'nothing to merge'));
  appendEvent(dir.id, 'merged',
    result.merged ? `${result.commits} 个提交 → ${dir.baseBranch}` : '无新提交', id);
  workspaceBroadcast(dir.id, { type: 'merge_status', sessionId: id, mergeState: await mergeStateFresh(dir, persisted) });

  // When this merge actually advanced the base branch, every OTHER worktree in
  // the same directory is now behind base. Auto-sync them so siblings don't have
  // to be manually caught up one by one (the #1 friction in multi-session work).
  // Best-effort & non-blocking: each sync is independent; conflicts are skipped
  // and surfaced via the workspace event log rather than failing this response.
  if (result.merged) {
    const synced = await autoSyncSiblingWorktrees(dir, id);
    if (synced.length) result.siblingsSynced = synced;
  }
  res.json(result);
});

// Pull the (just-advanced) base branch into every sibling worktree in `dir`
// except `exceptId`. Returns a summary array; broadcasts per-session merge state
// and a directory event. Conflicts are reported, not merged.
function sessionWorktreeActive(id) {
  if (sessions.has(id)) return true;
  const chat = chatSessions.get(id);
  return !!(chat && (chat.claudeProc || chat.isStreaming || chat.clients?.size));
}

async function autoSyncSiblingWorktrees(dir, exceptId) {
  const out = [];
  for (const s of persistedSessions.values()) {
    if (s.id === exceptId) continue;
    if (s.dirId !== dir.id) continue;
    if (!s.worktreePath || !s.branch) continue;
    try {
      if (sessionWorktreeActive(s.id)) {
        out.push({ id: s.id, skipped: true, reason: 'active' });
        appendEvent(dir.id, 'sync_skipped', '自动同步已跳过：会话仍 active', s.id);
        continue;
      }
      const state = await gitWorktreeMergeState(dir, s);
      if (state.dirty) {
        out.push({ id: s.id, skipped: true, reason: 'dirty' });
        appendEvent(dir.id, 'sync_skipped', '自动同步已跳过：worktree 有未提交改动', s.id);
        workspaceBroadcast(dir.id, { type: 'merge_status', sessionId: s.id, mergeState: state });
        continue;
      }
      if (state.ahead > 0) {
        out.push({ id: s.id, skipped: true, reason: 'unmerged' });
        appendEvent(dir.id, 'sync_skipped', '自动同步已跳过：worktree 有尚未合回主分支的提交', s.id);
        workspaceBroadcast(dir.id, { type: 'merge_status', sessionId: s.id, mergeState: state });
        continue;
      }
      // Automatic sync: abort on conflict so an unattended sibling session is
      // never left parked mid-rebase. The conflict still surfaces via merge
      // state (conflict badge) so the user can sync manually and resolve it.
      const r = await gitSyncFromBase(dir, s, { abortOnConflict: true,
        activeCheck: () => sessionWorktreeActive(s.id) });
      if (r.ok && r.merged) {
        out.push({ id: s.id, commits: r.commits });
        appendEvent(dir.id, 'synced', `自动同步 ${r.commits} 个提交（${dir.baseBranch} 合并后）`, s.id);
        workspaceBroadcast(dir.id, { type: 'merge_status', sessionId: s.id, mergeState: await mergeStateFresh(dir, s) });
      } else if (!r.ok && r.conflicts?.length) {
        out.push({ id: s.id, conflict: true, files: r.conflicts });
        appendEvent(dir.id, 'sync_conflict', `自动同步遇冲突，需手动处理：${r.conflicts.slice(0, 5).join(', ')}`, s.id);
        workspaceBroadcast(dir.id, { type: 'merge_status', sessionId: s.id, mergeState: await mergeStateFresh(dir, s) });
      }
    } catch (e) {
      console.warn(`[multicc] auto-sync sibling ${s.id} failed: ${e.message}`);
    }
  }
  if (out.length) {
    console.log(`[multicc] auto-synced ${out.length} sibling worktree(s) after merge into ${dir.baseBranch}`);
  }
  return out;
}

// Sync: pull the base branch INTO this session's worktree (catch a stale
// worktree up to main). Inverse direction of /merge.
app.post('/api/sessions/:id/sync', async (req, res) => {
  const id = req.params.id;
  const persisted = persistedSessions.get(id);
  if (!persisted) return res.status(404).json({ error: 'session not found' });
  if (!persisted.worktreePath || !persisted.branch) {
    return res.status(400).json({ error: '该会话没有 worktree，无需同步' });
  }
  const dir = directories.get(persisted.dirId);
  if (!dir) return res.status(404).json({ error: 'directory not found' });

  const force = req.query.force === '1' || req.body?.force === true;
  const result = await gitSyncFromBase(dir, persisted, {
    force,
    activeCheck: force ? null : () => sessionWorktreeActive(id),
  }).catch(error => ({ ok: false, blocked: true, reasons: [error.code === 'SESSION_ACTIVE' ? 'active' : 'leased'],
    operationId: error.operationId, queueDepth: error.queueDepth, error: error.message }));
  if (!result.ok) {
    // A conflict leaves the worktree parked mid-rebase; broadcast the merge
    // state so the conflict badge shows up persistently on the card + chat,
    // not just as a one-shot toast on this response.
    if (result.conflicts?.length) {
      appendEvent(dir.id, 'sync_conflict',
        `同步 rebase 冲突，需手动解决：${result.conflicts.slice(0, 5).join(', ')}`, id);
      workspaceBroadcast(dir.id, { type: 'merge_status', sessionId: id, mergeState: await mergeStateFresh(dir, persisted) });
    }
    return res.status(result.conflicts?.length ? 409 : 400).json(result);
  }
  console.log(`[multicc] sync ${dir.baseBranch} → ${persisted.branch}: ` +
    (result.merged ? `${result.commits} commit(s)` : 'already up to date'));
  appendEvent(dir.id, 'synced',
    result.merged ? `从 ${result.baseBranch} 同步 ${result.commits} 个提交` : '已是最新', id);
  workspaceBroadcast(dir.id, { type: 'merge_status', sessionId: id, mergeState: await mergeStateFresh(dir, persisted) });
  res.json(result);
});

// Resolve a parked rebase (created by a conflicting sync): continue after the
// user staged their fixes in the worktree, or abort to roll back. Body: { action }.
app.post('/api/sessions/:id/rebase', async (req, res) => {
  const id = req.params.id;
  const persisted = persistedSessions.get(id);
  if (!persisted) return res.status(404).json({ error: 'session not found' });
  if (!persisted.worktreePath || !persisted.branch) {
    return res.status(400).json({ error: '该会话没有 worktree' });
  }
  const dir = directories.get(persisted.dirId);
  if (!dir) return res.status(404).json({ error: 'directory not found' });

  const action = (req.body && req.body.action) === 'abort' ? 'abort' : 'continue';
  const force = req.query.force === '1' || req.body?.force === true;
  const result = await gitRebaseResolve(dir, persisted, action, {
    activeCheck: force ? null : () => sessionWorktreeActive(id),
  }).catch(error => ({ ok: false, blocked: true, reasons: [error.code === 'SESSION_ACTIVE' ? 'active' : 'leased'],
    operationId: error.operationId, queueDepth: error.queueDepth, error: error.message }));
  // Always re-broadcast: success clears the badge, partial-continue updates the
  // remaining conflict list, abort returns the worktree to a clean state.
  workspaceBroadcast(dir.id, { type: 'merge_status', sessionId: id, mergeState: await mergeStateFresh(dir, persisted) });
  if (!result.ok) {
    return res.status(result.conflicts?.length ? 409 : 400).json(result);
  }
  appendEvent(dir.id, 'synced',
    result.aborted ? 'rebase 已放弃，worktree 回到同步前状态'
      : (result.done ? 'rebase 冲突已解决并完成同步' : 'rebase 已继续'), id);
  res.json(result);
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
app.post('/api/sessions/:id/dispatch', (req, res) => {
  const from = persistedSessions.get(req.params.id);
  if (!from) return res.status(404).json({ error: 'session not found' });
  const target = String((req.body && req.body.target) || '').trim();
  const message = String((req.body && req.body.message) || '').trim();
  if (!target || !message) return res.status(400).json({ error: 'target 和 message 必填' });
  if (target === from.id) return res.status(400).json({ error: '不能把任务分发给自己' });
  const v = validateDispatchTarget(target, from.id);
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (v.rec.dirId !== from.dirId) return res.status(400).json({ error: '只能分发给同目录会话' });
  appendEvent(from.dirId, 'dispatch', `→ ${v.rec.label || target}`, from.id);
  lastDispatchOutAt.set(from.id, Date.now());
  dispatchToSession(target, message, { replyTo: from.id })
    .then(r => r.ok
      ? res.json({ ok: true, target, chatId: r.chatId, note: '任务已投递；完成后结果会以【回复】消息自动回流到本会话' })
      : res.status(409).json({ ok: false, error: r.error }))
    .catch(e => res.status(500).json({ ok: false, error: e.message }));
});

// Directory event log.
app.get('/api/directories/:id/events', (req, res) => {
  const d = directories.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'directory not found' });
  res.json({ events: recentEvents(d.id) });
});

// ── File Browser API ──
app.get('/api/files', (req, res) => {
  let dirPath = (req.query.path || '').trim();
  const sessionId = (req.query.session || '').trim();

  if (!dirPath && sessionId) {
    const active = sessions.get(sessionId);
    const persisted = persistedSessions.get(sessionId);
    dirPath = active?.cwd || persisted?.cwd || os.homedir();
  } else if (!dirPath) {
    dirPath = os.homedir();
  }

  if (dirPath === '~') dirPath = os.homedir();
  else if (dirPath.startsWith('~/') || dirPath.startsWith('~\\')) {
    dirPath = path.join(os.homedir(), dirPath.slice(2));
  }
  dirPath = path.resolve(dirPath);

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const files = entries
      .map(e => {
        const fullPath = path.join(dirPath, e.name);
        const isDir = e.isDirectory();
        let size = null;
        if (!isDir) {
          try { size = fs.statSync(fullPath).size; } catch (_) {}
        }
        return { name: e.name, isDir, path: fullPath, size };
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    const parent = dirPath !== path.parse(dirPath).root ? path.dirname(dirPath) : null;
    res.json({ path: dirPath, parent, files });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/download', (req, res) => {
  const filePath = (req.query.path || '').trim();
  const inline = req.query.inline === '1';
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const resolved = path.resolve(filePath);
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return res.status(400).json({ error: '不能下载目录' });
    if (inline) {
      res.sendFile(resolved);
    } else {
      res.download(resolved);
    }
  } catch (e) {
    res.status(404).json({ error: '文件不存在' });
  }
});


// ── Voice domain (extracted to src/voice.js) ──
// Functions are safe to destructure (never reassigned); config is read through
// `voice.cfg.X` so hot-reload via the settings route stays visible — see src/voice.js.
const voice = require('./src/voice');
const {
  loadVoiceExamples, appendVoiceExample, loadWhisperVocab, saveWhisperVocab,
  extractCorrections, mergeWhisperVocab, buildWhisperPrompt, callVoiceAPI,
} = voice;
// Local ASR (SenseVoice via sherpa-onnx) — used by /api/voice/stt when the
// model is present; falls back to the cloud Whisper path otherwise.
const asrLocal = require('./src/asr-local');

// ── File upload for chat mode ──
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const ext = path.extname(req.file.originalname).replace(/[^a-z0-9.]/gi, '').slice(0, 12) || 'bin';
  const safeName = `multicc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext.startsWith('.') ? ext : '.' + ext}`;
  const tmpPath = path.join(os.tmpdir(), safeName);
  fs.writeFileSync(tmpPath, req.file.buffer, { mode: 0o600 });
  console.log(`[multicc] Uploaded: ${tmpPath} (${req.file.originalname})`);
  res.json({ path: tmpPath, name: req.file.originalname });
});

// ── Temp upload stats & cleanup ──
app.get('/api/uploads/stats', (req, res) => {
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('multicc_'));
    let totalSize = 0;
    const items = [];
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(tmpDir, f));
        if (!st.isFile()) continue;
        totalSize += st.size;
        items.push({ name: f, size: st.size, mtime: st.mtime });
      } catch (_) { /* skip */ }
    }
    res.json({ count: items.length, totalSize, dir: tmpDir, files: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/uploads/cleanup', (req, res) => {
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('multicc_'));
    let deleted = 0, freed = 0;
    for (const f of files) {
      try {
        const fp = path.join(tmpDir, f);
        const st = fs.statSync(fp);
        if (!st.isFile()) continue;
        fs.unlinkSync(fp);
        deleted++;
        freed += st.size;
      } catch (_) { /* skip */ }
    }
    console.log(`[multicc] Cleanup: deleted ${deleted} temp files, freed ${(freed / 1024 / 1024).toFixed(2)} MB`);
    res.json({ deleted, freed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/voice/refine', async (req, res) => {
  const reqId = `vr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const raw = (req.body.raw || '').trim();
  console.log(`[multicc/voice][${reqId}] POST /api/voice/refine received, raw length: ${raw.length}, raw: ${JSON.stringify(raw.slice(0, 100))}`);

  if (!raw) {
    return res.json({ ok: true, text: '', ms: 0 });
  }

  const examples = loadVoiceExamples();
  let examplesStr = '';
  if (examples.length > 0) {
    examplesStr = '\n\n历史优化案例（供参考）：\n' + examples.map((ex, i) =>
      `[案例${i + 1}] 原始：${ex.raw}\n优化后：${ex.userFinal}`
    ).join('\n');
  }

  const prompt = `你是程序员语音输入助手。原始语音识别文字可能口语化、夹杂中英文。
任务：
1. 保留所有英文技术词汇/命令/API名（React, useState, git commit等）
2. 将口语转为专业简洁的程序员描述
3. 整理成清晰可操作的需求
4. 忠实原意，不臆造功能${examplesStr}

原始语音：${raw}
直接输出优化后的文本，不要任何解释或前缀。`;

  console.log(`[multicc/voice][${reqId}] Routing to AuxQueue (prompt ${prompt.length} chars)`);
  const t0 = Date.now();

  try {
    const result = await auxQueue.enqueue({ type: 'voice_refine', prompt, meta: { reqId } });
    const ms = Date.now() - t0;
    console.log(`[multicc/voice][${reqId}] AuxQueue done in ${ms}ms, text length: ${(result.text || '').length}`);
    res.json({ ok: true, text: result.text || '', ms });
  } catch (err) {
    const ms = Date.now() - t0;
    const errMsg = err?.cancelled ? 'cancelled' : (err?.message || String(err));
    console.error(`[multicc/voice][${reqId}] AuxQueue error after ${ms}ms:`, errMsg);
    res.json({ ok: false, text: `[错误: ${errMsg}]`, ms });
  }
});

app.post('/api/voice/feedback', (req, res) => {
  const { raw, refined, userFinal } = req.body;
  if (raw && refined !== undefined && userFinal !== undefined && userFinal !== refined) {
    appendVoiceExample({ raw, refined, userFinal, ts: new Date().toISOString() });

    // Extract user corrections and merge into Whisper vocabulary
    // Compare against raw (STT output) — these are the words Whisper got wrong
    const corrections = extractCorrections(raw, userFinal);
    if (corrections.length > 0) {
      mergeWhisperVocab(corrections);
    }
  }
  res.json({ ok: true });
});

// ── S2S: 需求确认 (requirement confirmation) ──
// Takes raw user speech text, returns a structured breakdown for the user to
// confirm item-by-item before the task is dispatched to the coding agent.
app.post('/api/voice/confirm', async (req, res) => {
  const reqId = `s2s_c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const { text, previousBreakdown, userFeedback } = req.body;
  const raw = (text || '').trim();
  console.log(`[multicc/s2s][${reqId}] POST /api/voice/confirm, raw: ${JSON.stringify(raw.slice(0, 120))}`);

  if (!raw && !userFeedback) {
    return res.status(400).json({ error: '缺少 text 或 userFeedback' });
  }

  const ctxParts = [];
  if (previousBreakdown) {
    ctxParts.push(`之前你给出的理解（JSON）：\n${JSON.stringify(previousBreakdown, null, 2)}`);
  }
  if (userFeedback) {
    ctxParts.push(`用户对此的语音反馈：${userFeedback}`);
  }
  const ctx = ctxParts.length ? '\n\n' + ctxParts.join('\n\n') : '';

  const prompt = `你是语音交互的需求确认助手。用户通过连续语音描述了一个编程/技术任务。你的职责是把用户的口语描述整理成清晰、可逐项确认的需求条目，以便在执行前与用户对齐。

${ctx ? ctx + '\n\n' : ''}用户本次的语音输入：${raw || '（无新增，仅根据反馈调整）'}

请输出严格的 JSON（只输出 JSON，不要 markdown 代码块，不要任何解释）：
{
  "summary": "一句话总结你理解的整体需求（用'我理解你要做的是：...'的口吻）",
  "items": ["需求条目1", "需求条目2", "..."],
  "questions": ["如果有需要进一步确认的疑问写在这里，没有则空数组"],
  "allConfirmed": false
}

规则：
- allConfirmed 只有在用户的反馈明确表示"全部正确/确认/没问题/对了/可以了"等时才设为 true，其余情况一律 false
- items 每条用简洁的短句，适合语音逐条念出
- 如果是首次确认（没有 previousBreakdown），根据原始语音拆解；如果有 previousBreakdown + userFeedback，根据反馈更新条目
- questions 只在有真正需要澄清的疑问时才填，通常为空数组`;

  const t0 = Date.now();
  try {
    const result = await auxQueue.enqueue({ type: 'voice_confirm', prompt, meta: { reqId } });
    const ms = Date.now() - t0;
    // Try to parse JSON from the result text (aux AI may wrap in markdown code block)
    let parsed;
    const rawText = result.text || '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch (_) {}
    }
    if (!parsed) {
      // Fallback: treat the whole text as summary
      parsed = { summary: rawText.trim(), items: [], questions: [], allConfirmed: false };
    }
    console.log(`[multicc/s2s][${reqId}] Confirm done in ${ms}ms, items: ${parsed.items?.length || 0}, allConfirmed: ${parsed.allConfirmed}`);
    res.json({ ok: true, ...parsed, ms });
  } catch (err) {
    const ms = Date.now() - t0;
    const errMsg = err?.cancelled ? 'cancelled' : (err?.message || String(err));
    console.error(`[multicc/s2s][${reqId}] Confirm error after ${ms}ms:`, errMsg);
    res.status(500).json({ error: errMsg });
  }
});

// ── S2S: 进展汇报 (progress summary) ──
// Takes recent chat events + task description, returns a brief spoken summary
// suitable for TTS playback to a waiting user.
app.post('/api/voice/progress-summary', async (req, res) => {
  const reqId = `s2s_p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const { events, taskDescription } = req.body;
  console.log(`[multicc/s2s][${reqId}] POST /api/voice/progress-summary, events: ${Array.isArray(events) ? events.length : 0}`);

  if (!Array.isArray(events) || events.length === 0) {
    return res.json({ ok: true, summary: '' });
  }

  const eventsStr = events.map((e, i) =>
    `${i + 1}. [${e.type || '?'}] ${(e.summary || e.text || JSON.stringify(e)).slice(0, 300)}`
  ).join('\n');

  const prompt = `你是语音交互的进展汇报助手。用户通过语音发起了一个任务，正在等待结果。请根据最近的任务进展事件，用口语化的中文给用户做一个简洁的进展汇报，适合语音播报。

任务描述：${taskDescription || '编程任务'}

最近的进展事件：
${eventsStr}

要求：
- 用 1-3 句话总结当前进展，口语化，自然
- 直接说内容，不要加"汇报："等前缀
- 如果看到错误或卡住，也如实说明
- 如果进展正常，简单说明已完成了什么、还在做什么
- 不超过 100 字`;

  const t0 = Date.now();
  try {
    const result = await auxQueue.enqueue({ type: 'progress_summary', prompt, meta: { reqId } });
    const ms = Date.now() - t0;
    const summary = (result.text || '').trim();
    console.log(`[multicc/s2s][${reqId}] Progress summary done in ${ms}ms, len: ${summary.length}`);
    res.json({ ok: true, summary, ms });
  } catch (err) {
    const ms = Date.now() - t0;
    const errMsg = err?.cancelled ? 'cancelled' : (err?.message || String(err));
    console.error(`[multicc/s2s][${reqId}] Progress summary error after ${ms}ms:`, errMsg);
    res.status(500).json({ error: errMsg });
  }
});

// ── Whisper vocabulary management ──
app.get('/api/voice/vocab', (req, res) => {
  res.json(loadWhisperVocab());
});

app.delete('/api/voice/vocab/:term', (req, res) => {
  const target = req.params.term.toLowerCase();
  const vocab = loadWhisperVocab().filter(v => v.term.toLowerCase() !== target);
  saveWhisperVocab(vocab);
  res.json({ ok: true, remaining: vocab.length });
});

// ── Whisper STT endpoint ──
app.post('/api/voice/stt', upload.single('file'), async (req, res) => {
  const reqId = `stt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  console.log(`[multicc/stt][${reqId}] POST /api/voice/stt received`);

  if (!req.file) {
    return res.status(400).json({ error: '未收到音频文件' });
  }

  console.log(`[multicc/stt][${reqId}] File: ${req.file.originalname}, size: ${req.file.size}, mime: ${req.file.mimetype}`);

  // ── Local ASR first (SenseVoice via sherpa-onnx, ~RTF 0.02 on Apple
  // Silicon). Any failure falls through to the cloud Whisper path so a broken
  // model install can't take voice input down.
  if (asrLocal.isAvailable()) {
    try {
      const r = await asrLocal.transcribeBuffer(req.file.buffer, req.file.mimetype);
      console.log(`[multicc/stt][${reqId}] Local ASR ok in ${r.ms}ms (decode ${r.decodeMs}ms + infer ${r.inferMs}ms, audio ${r.audioSec.toFixed(1)}s), text length: ${r.text.length}`);
      return res.json({ text: r.text, duration_ms: r.ms, engine: 'local' });
    } catch (err) {
      console.error(`[multicc/stt][${reqId}] Local ASR failed, falling back to cloud:`, err.message);
    }
  }

  const apiKey = voice.cfg.WHISPER_API_KEY || voice.cfg.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: '本地 ASR 未就绪，且 WHISPER_API_KEY 或 OPENROUTER_API_KEY 未设置' });
  }

  console.log(`[multicc/stt][${reqId}] Forwarding to ${voice.cfg.WHISPER_BASE_URL}/audio/transcriptions (model: ${voice.cfg.WHISPER_MODEL})`);

  const t0 = Date.now();
  const abort = new AbortController();
  const fetchTimeout = setTimeout(() => abort.abort(), 30000);
  try {
    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' });
    formData.append('file', blob, req.file.originalname || 'audio.webm');
    formData.append('model', voice.cfg.WHISPER_MODEL);

    // Add language hint to skip auto-detection
    if (voice.cfg.WHISPER_LANGUAGE) {
      formData.append('language', voice.cfg.WHISPER_LANGUAGE);
    }

    // Add prompt to guide vocabulary and style recognition
    const whisperPrompt = buildWhisperPrompt();
    if (whisperPrompt) {
      formData.append('prompt', whisperPrompt);
      console.log(`[multicc/stt][${reqId}] Whisper prompt (${whisperPrompt.length} chars): ${whisperPrompt.slice(0, 120)}...`);
    }

    const response = await fetch(`${voice.cfg.WHISPER_BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
      signal: abort.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[multicc/stt][${reqId}] Whisper API error ${response.status}: ${errText.slice(0, 300)}`);
      return res.status(502).json({ error: `Whisper API ${response.status}: ${errText.slice(0, 200)}` });
    }

    const result = await response.json();
    const durationMs = Date.now() - t0;
    console.log(`[multicc/stt][${reqId}] Success in ${durationMs}ms, text length: ${(result.text || '').length}`);
    res.json({ text: result.text || '', duration_ms: durationMs, engine: 'cloud' });
  } catch (err) {
    const durationMs = Date.now() - t0;
    const msg = err.name === 'AbortError' ? '云端 Whisper 超时（30s）' : err.message;
    console.error(`[multicc/stt][${reqId}] Error after ${durationMs}ms:`, msg);
    res.status(500).json({ error: msg });
  } finally {
    clearTimeout(fetchTimeout);
  }
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

app.get('/api/settings/voice', (req, res) => {
  const env = readEnvFile();
  const key = env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || '';
  const wsKey = env.WHISPER_API_KEY || process.env.WHISPER_API_KEY || '';
  res.json({
    baseUrl: env.OPENROUTER_BASE_URL || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: key ? key.slice(0, 8) + '****' + key.slice(-4) : '',
    model: env.OPENROUTER_MODEL || process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001',
    hasKey: !!key,
    whisperBaseUrl: env.WHISPER_BASE_URL || process.env.WHISPER_BASE_URL || 'https://openrouter.ai/api/v1',
    whisperApiKey: wsKey ? wsKey.slice(0, 8) + '****' + wsKey.slice(-4) : '',
    whisperModel: env.WHISPER_MODEL || process.env.WHISPER_MODEL || 'whisper-large-v3-turbo',
    hasWhisperKey: !!wsKey,
    whisperLanguage: env.WHISPER_LANGUAGE || process.env.WHISPER_LANGUAGE || 'zh',
    whisperPrompt: env.WHISPER_PROMPT || process.env.WHISPER_PROMPT || '',
    // ── Streaming ASR (real-time dictation) ──
    asr: {
      provider: env.ASR_PROVIDER || process.env.ASR_PROVIDER || 'auto',
      status: voiceAsr.providerStatus(),
      openaiUrl: env.OPENAI_REALTIME_URL || process.env.OPENAI_REALTIME_URL || 'wss://api.openai.com/v1/realtime',
      openaiModel: env.OPENAI_REALTIME_MODEL || process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-transcribe',
      hasOpenaiKey: !!(env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_REALTIME_API_KEY),
      volcUrl: env.VOLC_ASR_URL || process.env.VOLC_ASR_URL || '',
      volcResourceId: env.VOLC_ASR_RESOURCE_ID || process.env.VOLC_ASR_RESOURCE_ID || 'volc.bigasr.sauc.duration',
      hasVolcAppId: !!(env.VOLC_ASR_APP_ID || process.env.VOLC_ASR_APP_ID),
      hasVolcToken: !!(env.VOLC_ASR_ACCESS_TOKEN || process.env.VOLC_ASR_ACCESS_TOKEN),
      funasrUrl: env.FUNASR_WS_URL || process.env.FUNASR_WS_URL || '',
      funasrMode: env.FUNASR_MODE || process.env.FUNASR_MODE || '2pass',
    },
    // ── Streaming TTS (real-time audio output) ──
    tts: {
      provider: env.TTS_PROVIDER || process.env.TTS_PROVIDER || 'edge',
      status: ttsService.providerStatus(),
      edgeVoice: env.EDGE_TTS_VOICE || process.env.EDGE_TTS_VOICE || 'zh-CN-XiaoxiaoNeural',
      openaiVoice: env.OPENAI_TTS_VOICE || process.env.OPENAI_TTS_VOICE || 'alloy',
      hasOpenaiKey: !!(env.OPENAI_TTS_API_KEY || process.env.OPENAI_TTS_API_KEY || process.env.OPENAI_API_KEY),
      volcanoVoice: env.VOLC_TTS_VOICE || process.env.VOLC_TTS_VOICE || 'zh_female_shuangkuaisisi_moon_bigtts',
      hasVolcanoAppId: !!(env.VOLC_TTS_APP_ID || process.env.VOLC_TTS_APP_ID),
      hasVolcanoToken: !!(env.VOLC_TTS_ACCESS_TOKEN || process.env.VOLC_TTS_ACCESS_TOKEN),
    },
  });
});

app.post('/api/settings/voice', (req, res) => {
  const { baseUrl, apiKey, model, whisperBaseUrl, whisperApiKey, whisperModel, whisperLanguage, whisperPrompt } = req.body;
  const updates = {};
  if (baseUrl !== undefined) updates.OPENROUTER_BASE_URL = baseUrl;
  if (apiKey !== undefined && !apiKey.includes('****')) updates.OPENROUTER_API_KEY = apiKey;
  if (model !== undefined) updates.OPENROUTER_MODEL = model;
  if (whisperBaseUrl !== undefined) updates.WHISPER_BASE_URL = whisperBaseUrl;
  if (whisperApiKey !== undefined && !whisperApiKey.includes('****')) updates.WHISPER_API_KEY = whisperApiKey;
  if (whisperModel !== undefined) updates.WHISPER_MODEL = whisperModel;
  if (whisperLanguage !== undefined) updates.WHISPER_LANGUAGE = whisperLanguage;
  if (whisperPrompt !== undefined) updates.WHISPER_PROMPT = whisperPrompt;
  // ── Streaming ASR config (skip masked **** values) ──
  const asr = req.body.asr || {};
  const setAsr = (k, v) => { if (v !== undefined && !(typeof v === 'string' && v.includes('****'))) updates[k] = v; };
  setAsr('ASR_PROVIDER', asr.provider);
  setAsr('OPENAI_REALTIME_API_KEY', asr.openaiApiKey);
  setAsr('OPENAI_REALTIME_URL', asr.openaiUrl);
  setAsr('OPENAI_REALTIME_MODEL', asr.openaiModel);
  setAsr('VOLC_ASR_APP_ID', asr.volcAppId);
  setAsr('VOLC_ASR_ACCESS_TOKEN', asr.volcAccessToken);
  setAsr('VOLC_ASR_RESOURCE_ID', asr.volcResourceId);
  setAsr('VOLC_ASR_URL', asr.volcUrl);
  setAsr('FUNASR_WS_URL', asr.funasrUrl);
  setAsr('FUNASR_MODE', asr.funasrMode);
  // ── Streaming TTS config (skip masked **** values) ──
  const tts = req.body.tts || {};
  const setTts = (k, v) => { if (v !== undefined && !(typeof v === 'string' && v.includes('****'))) updates[k] = v; };
  setTts('TTS_PROVIDER', tts.provider);
  setTts('EDGE_TTS_VOICE', tts.edgeVoice);
  setTts('OPENAI_TTS_API_KEY', tts.openaiApiKey);
  setTts('OPENAI_TTS_URL', tts.openaiUrl);
  setTts('OPENAI_TTS_MODEL', tts.openaiModel);
  setTts('OPENAI_TTS_VOICE', tts.openaiVoice);
  setTts('VOLC_TTS_APP_ID', tts.volcanoAppId);
  setTts('VOLC_TTS_ACCESS_TOKEN', tts.volcanoToken);
  setTts('VOLC_TTS_URL', tts.volcanoUrl);
  setTts('VOLC_TTS_VOICE', tts.volcanoVoice);
  writeEnvFile(updates);
  voiceAsr.applyConfig(updates);
  ttsService.applyConfig(updates);
  // Update in-memory env + module-level constants
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
  // Hot-reload the voice module's in-memory config (was: reassigning module-level lets).
  voice.applyEnvUpdates(updates);
  console.log(`[multicc/voice] Settings updated: model=${voice.cfg.OPENROUTER_MODEL}, baseUrl=${voice.cfg.OPENROUTER_BASE_URL}, key=${voice.cfg.OPENROUTER_API_KEY ? 'set' : 'empty'}`);
  console.log(`[multicc/stt] Settings updated: model=${voice.cfg.WHISPER_MODEL}, baseUrl=${voice.cfg.WHISPER_BASE_URL}, key=${voice.cfg.WHISPER_API_KEY ? 'set' : 'empty'}`);
  res.json({ ok: true });
});

// SSE test endpoint (for debugging voice streaming issues)
app.get('/api/voice/test-sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  if (res.socket) res.socket.setNoDelay(true);

  let i = 0;
  const iv = setInterval(() => {
    res.write(`data: ${JSON.stringify({ text: `SSE test chunk ${++i}` })}\n\n`);
    if (i >= 3) {
      clearInterval(iv);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }, 500);
  req.on('close', () => clearInterval(iv));
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
const chatStream = require('./src/chat-stream');
const waitInjector = require('./src/wait-injector');
const bgCoalesce = require('./src/bg-completion-coalescer');
const detached = require('./src/detached');
const share = require('./src/share');

// ── Server Info (LAN IP for QR code) ──
app.get('/api/server-info', (req, res) => {
  const nets = os.networkInterfaces();
  let ip = '127.0.0.1';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ip = net.address;
        break;
      }
    }
    if (ip !== '127.0.0.1') break;
  }
  const url = `http://${ip}:${PORT}`;
  res.json({ ip, port: PORT, proto: 'http', url, authRequired: !!ACCESS_TOKEN });
});

// Push API endpoints
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: vapidKeys.pubKey });
});

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  push.subscriptions.set(sub.endpoint, sub);
  push.saveSubscriptions();
  console.log(`[multicc/push] New subscription (${push.subscriptions.size} total)`);
  res.json({ ok: true });
});

app.delete('/api/push/subscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint && push.subscriptions.has(endpoint)) {
    push.subscriptions.delete(endpoint);
    push.saveSubscriptions();
  }
  res.json({ ok: true });
});

// Validate if a subscription is registered server-side
app.post('/api/push/validate', (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  res.json({ known: push.subscriptions.has(endpoint) });
});

// Push health status
app.get('/api/push/health', (req, res) => {
  const subs = [];
  for (const [endpoint] of push.subscriptions) {
    const h = push.healthStats.get(endpoint) || { successCount: 0, failCount: 0, lastSuccessTime: 0, lastFailTime: 0, lastFailReason: '', consecutiveFails: 0 };
    subs.push({
      endpointShort: endpoint.length > 50 ? endpoint.slice(0, 35) + '...' + endpoint.slice(-12) : endpoint,
      ...h,
    });
  }
  res.json({
    subscriptions: subs,
    subscriptionCount: push.subscriptions.size,
    global: push.globalStats,
    bark: { configured: !!push.cfg.BARK_URL, ...push.barkHealth },
    webhook: { configured: !!push.cfg.WEBHOOK_URL, ...push.webhookHealth },
  });
});

// Test push notification
app.post('/api/push/test', async (req, res) => {
  const payload = {
    title: 'MultiCC Test',
    body: `Push test at ${new Date().toLocaleTimeString()}`,
    type: 'test',
    tag: 'multicc-test',
    url: '/manage',
  };
  await push.sendPushToAll(payload);
  push.sendBarkNotification(payload.title, payload.body, payload.url);
  push.sendWebhookNotification(payload);
  res.json({ ok: true, subscribers: push.subscriptions.size });
});

// Test Bark only
app.post('/api/push/test-bark', (req, res) => {
  if (!push.cfg.BARK_URL) return res.status(400).json({ error: 'Bark URL not configured' });
  push.sendBarkNotification('MultiCC Test', `Bark test at ${new Date().toLocaleTimeString()}`, '/manage');
  res.json({ ok: true });
});

// Test Webhook only
app.post('/api/push/test-webhook', (req, res) => {
  if (!push.cfg.WEBHOOK_URL) return res.status(400).json({ error: 'Webhook URL not configured' });
  push.sendWebhookNotification({ title: 'MultiCC Test', body: `Webhook test at ${new Date().toLocaleTimeString()}`, type: 'test' });
  res.json({ ok: true });
});

// Notification settings (Bark / Webhook)
app.get('/api/settings/notify', (req, res) => {
  res.json({
    barkUrl: push.cfg.BARK_URL ? push.cfg.BARK_URL.replace(/\/[^/]{8,}$/, '/****') : '',
    hasBark: !!push.cfg.BARK_URL,
    webhookUrl: push.cfg.WEBHOOK_URL || '',
    hasWebhook: !!push.cfg.WEBHOOK_URL,
  });
});

app.post('/api/settings/notify', (req, res) => {
  const { barkUrl, webhookUrl } = req.body || {};
  const updates = {};
  if (typeof barkUrl === 'string') updates.BARK_URL = barkUrl;
  if (typeof webhookUrl === 'string') updates.WEBHOOK_URL = webhookUrl;
  if (Object.keys(updates).length > 0) { writeEnvFile(updates); push.applyEnvUpdates(updates); }
  res.json({ ok: true });
});

// ── External tunnel monitor (花生壳 / Tailscale) ──
app.get('/api/settings/tunnel', (req, res) => {
  res.json(tunnel.getStatus());
});

app.post('/api/settings/tunnel', (req, res) => {
  const b = req.body || {};
  const enabling = !!(b.phddns && b.phddns.enabled) || !!(b.tailscale && (b.tailscale.enabled || b.tailscale.funnel));
  if (enabling && !ACCESS_TOKEN) return res.status(400).json({ error: '开启外网访问前必须先设置 ACCESS_TOKEN' });
  const update = {};
  if (b.phddns && typeof b.phddns === 'object') {
    update.phddns = {};
    if (typeof b.phddns.enabled === 'boolean') update.phddns.enabled = b.phddns.enabled;
    if (typeof b.phddns.url === 'string') update.phddns.url = b.phddns.url.trim();
  }
  if (b.tailscale && typeof b.tailscale === 'object') {
    update.tailscale = {};
    if (typeof b.tailscale.enabled === 'boolean') update.tailscale.enabled = b.tailscale.enabled;
    if (typeof b.tailscale.url === 'string') update.tailscale.url = b.tailscale.url.trim();
    if (typeof b.tailscale.funnel === 'boolean') update.tailscale.funnel = b.tailscale.funnel;
    if (Number.isFinite(b.tailscale.funnelPort) && b.tailscale.funnelPort > 0) update.tailscale.funnelPort = Math.floor(b.tailscale.funnelPort);
  }
  for (const k of ['intervalSec', 'failThreshold', 'restartCooldownSec', 'maxRestartsPerHour']) {
    if (Number.isFinite(b[k]) && b[k] > 0) update[k] = Math.floor(b[k]);
  }
  const cfg = tunnel.applyConfig(update);
  res.json({ ok: true, config: cfg });
});

app.post('/api/tunnel/restart/:provider', async (req, res) => {
  try {
    const result = await tunnel.restartNow(req.params.provider);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Toggle Tailscale Funnel (public-internet exposure) for a port.
// Body: { on: bool, port?: number }
app.post('/api/tunnel/funnel', async (req, res) => {
  try {
    const on = !!(req.body && req.body.on);
    if (on && !ACCESS_TOKEN) return res.status(400).json({ error: '开启公网 Funnel 前必须先设置 ACCESS_TOKEN' });
    const port = req.body && Number(req.body.port);
    const result = await tunnel.setFunnel(on, port);
    const status = await tunnel.funnelStatus();
    res.status(result.ok ? 200 : 400).json({ ...result, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read-only Funnel status (CLI output).
app.get('/api/tunnel/funnel', async (req, res) => {
  try {
    res.json({ status: await tunnel.funnelStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read-only IPv6 reachability detection (host global IPv6 + tailscale netcheck).
// Lets the UI show whether remote clients can reach this host via a direct IPv6
// path instead of a DERP relay.
app.get('/api/tunnel/ipv6', async (req, res) => {
  try {
    res.json(await tunnel.ipv6Status());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Access token (external-access login password) ──
// Readable anywhere (masked); editable ONLY from localhost. Persisted to .env
// and hot-reloaded so changes apply without a server restart.
app.get('/api/settings/access-token', (req, res) => {
  const t = ACCESS_TOKEN || '';
  res.json({
    hasToken: !!t,
    masked: t ? (t.length > 4 ? '****' + t.slice(-4) : '****') : '',
    canEdit: isLocalRequest(req),
  });
});

app.post('/api/settings/access-token', (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ error: '访问密码仅可在本机 (localhost) 打开本页时修改' });
  }
  const raw = req.body && req.body.token;
  if (typeof raw !== 'string' || raw.includes('****')) {
    return res.status(400).json({ error: '无有效改动' });
  }
  const token = raw.trim();
  const tunnelConfig = tunnel.getStatus().config || {};
  const publicTunnelEnabled = !!(tunnelConfig.phddns && tunnelConfig.phddns.enabled)
    || !!(tunnelConfig.tailscale && (tunnelConfig.tailscale.enabled || tunnelConfig.tailscale.funnel));
  if (!token && (networkPolicy.allowRemote || publicTunnelEnabled)) {
    return res.status(400).json({ error: '当前已允许远程/公网访问，请先关闭外网入口再清空 ACCESS_TOKEN' });
  }
  writeEnvFile({ ACCESS_TOKEN: token });
  process.env.ACCESS_TOKEN = token;
  ACCESS_TOKEN = token; // hot-reload: authSecurity/isAuthenticated read this live
  console.log(`[multicc/auth] ACCESS_TOKEN ${token ? 'updated' : 'cleared'} via localhost UI`);
  res.json({ ok: true, hasToken: !!token });
});

// ── Claude Code per-session/per-role proxy global toggle (live, persisted) ──
app.get('/api/settings/proxy', (req, res) => {
  res.json({ enabled: CLAUDE_PROXY_ENABLED });
});
app.post('/api/settings/proxy', (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: '仅可在本机修改' });
  if (typeof (req.body && req.body.enabled) !== 'boolean') return res.status(400).json({ error: 'enabled 必须是布尔' });
  CLAUDE_PROXY_ENABLED = req.body.enabled;                                  // hot-reload: spawns read this live
  process.env.CLAUDE_PROXY_ENABLED = req.body.enabled ? '1' : '0';
  writeEnvFile({ CLAUDE_PROXY_ENABLED: req.body.enabled ? '1' : '0' });     // persists across restarts
  console.log(`[multicc/proxy] claude proxy ${req.body.enabled ? 'enabled' : 'disabled'} via UI`);
  res.json({ ok: true, enabled: CLAUDE_PROXY_ENABLED });
});

// ── Route claude-official (OAuth subscription) through the proxy — default OFF ──
// Opt-in only: enabling makes official sessions replay their Keychain OAuth token
// through the proxy so their subagents can route to cheap providers (⚠️ ToS risk).
app.get('/api/settings/official-oauth', (req, res) => {
  res.json({ enabled: CLAUDE_OFFICIAL_VIA_PROXY });
});
app.post('/api/settings/official-oauth', (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: '仅可在本机修改' });
  if (typeof (req.body && req.body.enabled) !== 'boolean') return res.status(400).json({ error: 'enabled 必须是布尔' });
  CLAUDE_OFFICIAL_VIA_PROXY = req.body.enabled;                                       // hot-reload: spawns + proxy read this live
  process.env.CLAUDE_OFFICIAL_VIA_PROXY = req.body.enabled ? '1' : '0';               // proxy handler reads process.env
  writeEnvFile({ CLAUDE_OFFICIAL_VIA_PROXY: req.body.enabled ? '1' : '0' });          // persists across restarts
  console.log(`[multicc/proxy] official-via-proxy (OAuth replay) ${req.body.enabled ? 'enabled' : 'disabled'} via UI`);
  res.json({ ok: true, enabled: CLAUDE_OFFICIAL_VIA_PROXY });
});

// macOS system power settings
app.get('/api/settings/power', (req, res) => {
  if (!macosPower.isAvailable()) {
    return res.json({ available: false, enabled: false });
  }
  try {
    res.json(macosPower.getLidSleepPrevention());
  } catch (error) {
    res.status(500).json({ available: true, error: error.message });
  }
});

app.post('/api/settings/power', async (req, res) => {
  if (!macosPower.isAvailable()) {
    return res.status(400).json({ error: 'This setting is only available on macOS' });
  }
  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }
  try {
    const status = await macosPower.setLidSleepPrevention(req.body.enabled);
    res.json({ ok: true, ...status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Server-side notification detection (for push notifications) ──
const PUSH_ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z~]|\][^\x07]*(?:\x07|\x1b\\)|[()][AB012]|.)/g;
const PUSH_IDLE_MS = 6000;
const PUSH_MIN_CHARS = 80;
const PUSH_COOLDOWN = 8000;

// Per-session server-side monitor state
const pushMonitors = new Map();

function pushStripAnsi(str) {
  return str.replace(PUSH_ANSI_RE, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function initPushMonitor(sessionId) {
  if (pushMonitors.has(sessionId)) return pushMonitors.get(sessionId);
  const mon = {
    state: 'idle',
    chars: 0,
    recentText: '',
    idleTimer: null,
    lastPushTime: 0,
  };
  pushMonitors.set(sessionId, mon);
  return mon;
}

function cleanupPushMonitor(sessionId) {
  const mon = pushMonitors.get(sessionId);
  if (mon) {
    if (mon.idleTimer) clearTimeout(mon.idleTimer);
    pushMonitors.delete(sessionId);
  }
}

// Is there anyone who could receive a terminal notification right now? Avoids
// spending aux-AI calls when nothing is watching: a push channel, the
// terminal's own WS clients, or the directory's workspace board.
function hasNotifyConsumer(sessionId) {
  if (push.subscriptions.size > 0 || push.cfg.BARK_URL || push.cfg.WEBHOOK_URL) return true;
  if ((sessions.get(sessionId)?.clients?.size || 0) > 0) return true;
  const dirId = persistedSessions.get(sessionId)?.dirId;
  if (dirId && (workspaceClients.get(dirId)?.size || 0) > 0) return true;
  return false;
}

// Stringify once and send to every OPEN client in an iterable. Swallows per-
// client send errors so one dead socket doesn't abort the loop. Shared by
// terminalBroadcast / chatBroadcast / workspaceBroadcast / the aux hub's
// broadcast() — previously this "iterate clients + JSON send" body was copy-
// pasted at ~9 sites.
function broadcastTo(clients, payload) {
  const json = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(json); } catch (_) {}
    }
  }
}

// Push a server-originated message to a terminal session's live WS clients.
function terminalBroadcast(sessionId, payload) {
  const session = sessions.get(sessionId);
  if (!session) return;
  broadcastTo(session.clients, payload);
}

// Output went idle on a terminal session — the terminal equivalent of an SSE
// pause. Let the aux-AI judge done-vs-waiting from the output tail (single
// source of truth, same as chat), then fan the verdict out to every surface:
// push channels, the terminal's own WS clients, and the workspace board.
function classifyTerminalIdle(sessionId, tail) {
  // D/W guard — terminal sessions aren't covered by scanAndReclassify (it filters
  // kind==='chat'), so this idle-triggered classify needs its own skip: a done or
  // waiting-on-user terminal shouldn't be re-judged just because a background
  // log/watch process emitted a stray line. Only new user input should move D/W.
  const _tp = persistedSessions.get(sessionId);
  if (_tp) {
    const _tts = getTaskState(_tp);
    if (_tts.classifyState === 'D' || _tts.classifyState === 'W') return;
  }
  const mon = pushMonitors.get(sessionId);
  if (mon) {
    if (mon.classifyPending) return; // one classification already in flight
    mon.classifyPending = true;
  }
  auxQueue.enqueue({
    type: 'intent_classify',
    prompt: `你是一个意图分析器。下面是一个命令行 AI 编码助手(Claude Code / Codex)终端会话的最近输出。请严格输出三行：
第1行：当前任务目标，用一个简短的名词性短语（中文≤20字，英文≤10词）。如果没有任务则输出「—」。
第2行：当前阶段，必须是以下五个词之一：规划中 / 实现中 / 验证中 / 收尾中 / 已完成
第3行：仅一个字母，表示当前状态——
  D = 任务已完成（终端回到空闲提示符、汇报结果后正常收尾，不需要用户操作、也不需要再继续）
  C = AI 应继续（任务还没做完，但可以直接接着跑，不需要用户操作；没有反问/等待迹象）
  W = 正在等待用户回复、确认或选择（如 y/n、Allow/Deny、编号选项、问题待答）
  B = 正在等待后台任务/子进程/外部数据返回后才能继续（如 Monitor 监控进度、nohup 后台跑、等部署/API）
  E = API 异常中断（输出末尾出现 “API Error”、503、”Connection closed”、”Overloaded”、”Internal server error”、”The system is busy” 等错误信息，说明 AI 并非正常完成而是被故障截断）

判断时看整体走向：终端回到提示符、汇报结果后没有反问 → D（完成）；任务没做完但能接着跑 → C；有明确反问/让用户选 → W。

只输出这三行。不要加序号、解释、引号、空行。

终端输出（尾部）：
${tail}`,
    meta: { sessionId },
  }).then(result => {
    if (mon) mon.classifyPending = false;
    if (result.cancelled) return;
    const res = parseClassifyResult(result.text);
    // Resolve sessionName for dispatch — terminal sessions use sessionId as the key.
    const sessionName = sessionId;
    const cs = chatSessions.get(sessionName);
    dispatchStateAction(res, { sessionName, sessionId: sessionId, cs, isTerminal: true });
    console.log(`[multicc/aux] Terminal classify for ${sessionId}: ${res.state}${res.goal ? ' · ' + res.goal : ''}${res.error ? ' (API error)' : ''}`);
  }).catch(() => { if (mon) mon.classifyPending = false; });
}

/**
 * Called from ptyProcess.onData. Tracks output and, once a terminal goes idle,
 * asks the aux-AI whether the task finished or is waiting for the user, then
 * notifies all surfaces. No regex judging here — the AI is the single judge.
 */
function pushOnOutput(sessionId, rawData) {
  if (!hasNotifyConsumer(sessionId)) return; // nobody to notify

  const mon = initPushMonitor(sessionId);
  const text = pushStripAnsi(rawData);
  const printable = text.replace(/\s+/g, '');

  mon.recentText += text;
  if (mon.recentText.length > 3000) mon.recentText = mon.recentText.slice(-2000);

  if (printable.length > 0) {
    // Bump bg idle timer — session is active, not idle.
    bumpBgActivity(sessionId);
    mon.chars += printable.length;
    if (mon.state === 'idle') mon.state = 'active';
  }

  // Judge only after output stops for PUSH_IDLE_MS (the "stream paused" signal).
  if (mon.idleTimer) clearTimeout(mon.idleTimer);
  mon.idleTimer = setTimeout(() => {
    if (mon.state === 'active' && mon.chars >= PUSH_MIN_CHARS) {
      classifyTerminalIdle(sessionId, mon.recentText.slice(-2000));
    }
    mon.state = 'idle';
    mon.chars = 0;
    mon.recentText = '';
  }, PUSH_IDLE_MS);
}

function pushOnInput(sessionId) {
  const mon = pushMonitors.get(sessionId);
  if (mon) {
    mon.state = 'idle';
    mon.chars = 0;
    mon.recentText = '';
    if (mon.idleTimer) {
      clearTimeout(mon.idleTimer);
      mon.idleTimer = null;
    }
  }
  // Terminal recovery for the D/W guard in classifyTerminalIdle: terminals have no
  // ensureCurrentTask, so without this a parked D/W terminal would never re-classify
  // (the guard skips it forever, board stuck on "done"). New user input = a new
  // processing phase → flip D/W back to P so the next idle-classify runs again.
  // MUST run even when mon is null: after a server restart pushMonitors (in-memory)
  // is empty, but a persisted D/W terminal still needs to recover on user input — so
  // this sits OUTSIDE the `if (mon)` block, not behind an early `if (!mon) return`.
  // Guarded to D/W only so ordinary keystrokes don't spam task_state broadcasts.
  const _tp = persistedSessions.get(sessionId);
  if (_tp) {
    const _ts = getTaskState(_tp);
    if (_ts.classifyState === 'D' || _ts.classifyState === 'W') {
      setTaskState(sessionId, { classifyState: 'P' });
    }
  }
}

function triggerPush(sessionId, type, message) {
  // A pushMonitor is created lazily by the TERMINAL output path (pushOnOutput),
  // so chat sessions never had one — and the old `if (!mon) return` here meant
  // every chat completion push was silently dropped (totalSent stayed 0). That
  // killed the ONLY lock-screen-capable channel for chat: notifications then
  // only worked while the app held a live WebSocket (screen on / foreground).
  // The monitor's only job in this function is the per-session cooldown stamp,
  // so create it on demand. Terminal callers already have one → no-op for them.
  const mon = initPushMonitor(sessionId);

  const now = Date.now();
  if (now - mon.lastPushTime < PUSH_COOLDOWN) return; // cooldown
  mon.lastPushTime = now;

  const session = sessions.get(sessionId);
  const cwd = session ? session.cwd : '';
  const shortCwd = cwd.length > 30 ? '...' + cwd.slice(-27) : cwd;

  const payloadForLocale = (locale) => ({
    title: locale === 'en'
      ? type === 'waiting' ? `MultiCC #${sessionId}: Action Required`
        : type === 'error' ? `MultiCC #${sessionId}: Error`
        : `MultiCC #${sessionId}: Completed`
      : type === 'waiting' ? `MultiCC #${sessionId}: 等待操作`
        : type === 'error' ? `MultiCC #${sessionId}: 出现异常`
        : `MultiCC #${sessionId}: 完成`,
    body: `${message}\n${shortCwd}`,
    sessionId,
    type,
    locale: locale === 'en' ? 'en' : 'zh',
    tag: `multicc-${sessionId}`,
    url: `/manage`,
  });
  const payload = payloadForLocale('zh');

  push.globalStats.lastPushTime = now;
  push.globalStats.lastPushType = type;
  push.globalStats.lastPushSessionId = sessionId;

  // Send to all channels in parallel
  push.sendPushToAll((subscription) => payloadForLocale(subscription.locale));
  push.sendBarkNotification(payload.title, `${message} ${shortCwd}`, payload.url);
  push.sendWebhookNotification(payload);

  console.log(`[multicc/push] Sent ${type} notification for session ${sessionId}`);
}

// ── AuxQueue: stateless direct-HTTP AI service (intent classification, etc.) ──
const AUX_SESSION_ID = '__aux__';
const AUX_TIMEOUT_MS = Math.max(10000, parseInt(process.env.AUX_TIMEOUT_MS || '90000', 10) || 90000);
const AUX_HISTORY_MAX = 200;

// Aux model config (persisted in aux-config.json). The aux helper runs short,
// stateless single-turn tasks (intent classify, summary, voice refine). It
// selects a wire protocol first, then one callable provider and model. Aux never
// spawns a CLI; providers without HTTP credentials are excluded from the picker.
const AUX_CONFIG_FILE = MULTICC_PATHS.auxConfigFile;
let auxConfig = { protocol: 'anthropic', providerId: null, model: null };
function normalizeAuxProtocol(v) {
  return String(v || '').toLowerCase() === 'openai' ? 'openai' : 'anthropic';
}
function loadAuxConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(AUX_CONFIG_FILE, 'utf8'));
    auxConfig = {
      // One-time compatibility read for pre-refactor config; save writes only
      // protocol/provider/model and permanently removes the old cli field.
      protocol: normalizeAuxProtocol(c.protocol || (c.cli === 'codex' ? 'openai' : 'anthropic')),
      providerId: c.providerId || null,
      model: (c.model && String(c.model).trim()) || null,
    };
    saveAuxConfig();
  } catch (_) { /* no config yet → defaults */ }
}
function saveAuxConfig() {
  try { atomicWriteJson(AUX_CONFIG_FILE, auxConfig); } catch (_) {}
}

const auxQueue = {
  queue: [],          // [{ id, type, prompt, meta, cancelled, resolve, reject, ts }]
  currentTask: null,
  processing: false,
  totalProcessed: 0,
  lastTaskTime: null,
  // ── Health monitoring (③) ──────────────────────────────────────────────
  // consecutiveFails counts failed (non-cancelled) tasks in a row. >=3 →
  // unhealthy; the summary/reconcile machinery degrades to rules (④)
  // and the dashboard shows a non-dismissible red banner. Any success clears it.
  health: { consecutiveFails: 0, unhealthy: false, lastFailAt: null, lastFailMsg: '', sinceAt: null },
  clients: new Set(), // WebSocket clients watching aux events
  history: [],        // loaded from chat_history/__aux__.json

  // Record a failed task. Cancelled tasks don't count (user-initiated).
  // Returns the updated health object.
  recordFail(msg) {
    const h = this.health;
    h.consecutiveFails = (h.consecutiveFails || 0) + 1;
    h.lastFailAt = Date.now();
    h.lastFailMsg = String(msg || '').slice(0, 200);
    if (h.consecutiveFails >= 3 && !h.unhealthy) {
      h.unhealthy = true;
      h.sinceAt = Date.now();
      console.error(`[multicc/aux] UNHEALTHY after ${h.consecutiveFails} consecutive failures: ${h.lastFailMsg}`);
      this.broadcastHealth();
    }
    recordApiError(msg);  // ⑥A: also feed network-level unhealthy
    return h;
  },
  // Record a successful task. Any success clears the unhealthy flag.
  recordSuccess() {
    const h = this.health;
    if (h.consecutiveFails || h.unhealthy) {
      h.consecutiveFails = 0;
      if (h.unhealthy) {
        h.unhealthy = false;
        h.sinceAt = null;
        console.log('[multicc/aux] recovered: healthy again');
        this.broadcastHealth();
      }
    }
    recordApiSuccess();  // ⑥A: aux success means the upstream API is reachable again
    // Recovery hook removed — scanAndReclassify covers all cases.
    return h;
  },
  isUnhealthy() { return !!(this.health && this.health.unhealthy); },
  broadcastHealth() {
    this.broadcast({ type: 'aux_health', health: { ...this.health } });
  },

  init() {
    this.history = loadChatHistory(AUX_SESSION_ID);
    loadAuxConfig();
    // Register __aux__ as a special persisted session
    if (!persistedSessions.has(AUX_SESSION_ID)) {
      persistedSessions.set(AUX_SESSION_ID, {
        id: AUX_SESSION_ID, cwd: __dirname, createdAt: new Date(), type: 'aux', label: 'AI Assistant',
      });
      savePersistedSessions();
    } else {
      const existing = persistedSessions.get(AUX_SESSION_ID);
      if (existing.type !== 'aux') { existing.type = 'aux'; existing.label = 'AI Assistant'; savePersistedSessions(); }
    }
    console.log('[multicc/aux] AuxQueue initialized (direct HTTP)');
  },

  enqueue(task) {
    return new Promise((resolve, reject) => {
      task.id = task.id || crypto.randomUUID();
      task.ts = Date.now();
      task.cancelled = false;
      task.resolve = resolve;
      task.reject = reject;
      this.queue.push(task);
      this.broadcast({ type: 'aux_event', status: 'queued', task: { id: task.id, type: task.type, meta: task.meta }, queueDepth: this.queue.length });
      console.log(`[multicc/aux] Enqueued ${task.type} (queue: ${this.queue.length})`);
      this.drain();
    });
  },

  cancel(taskId) {
    // In queue but not yet processing → remove
    const idx = this.queue.findIndex(t => t.id === taskId);
    if (idx !== -1) {
      const task = this.queue.splice(idx, 1)[0];
      task.reject({ cancelled: true });
      this.broadcast({ type: 'aux_event', status: 'cancelled', task: { id: taskId } });
      console.log(`[multicc/aux] Cancelled queued task ${taskId}`);
      return;
    }
    // Currently executing → mark cancelled (let it finish, discard result)
    if (this.currentTask?.id === taskId) {
      this.currentTask.cancelled = true;
      this.broadcast({ type: 'aux_event', status: 'cancelled', task: { id: taskId } });
      console.log(`[multicc/aux] Marked in-flight task ${taskId} as cancelled`);
    }
  },

  // Whether a task for this session is already queued or in-flight (dedup).
  hasPendingFor(sessionName) {
    if (!sessionName) return false;
    const match = (t) => {
      const m = (t && t.meta) || {};
      return m.sessionName === sessionName || m.sid === sessionName;
    };
    if (this.currentTask && match(this.currentTask)) return true;
    return this.queue.some(match);
  },

  // Cancel every still-QUEUED intent_classify for one session, so a fresh
  // classify supersedes stale queued ones instead of piling up. A session only
  // ever needs its single latest judgement.
  // NOTE: we do NOT cancel an in-flight classify — it already fired its upstream
  // HTTP request and will return within ~90s; cancelling it just marks the
  // result for discard while the worker stays busy (double waste: the request
  // ran + the new one re-runs). Let the in-flight one land instead.
  cancelClassifyFor(sessionKey) {
    if (!sessionKey) return;
    const isClassify = (t) => t && t.type === 'intent_classify' &&
      t.meta && (t.meta.sessionName === sessionKey || t.meta.sid === sessionKey);
    for (const t of [...this.queue]) if (isClassify(t)) this.cancel(t.id);
  },

  async drain() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const task = this.queue.shift();
    this.currentTask = task;
    this.broadcast({ type: 'aux_event', status: 'processing', task: { id: task.id, type: task.type, meta: task.meta } });

    const startTime = Date.now();
    try {
      const resultText = await this.execute(task);
      const durationMs = Date.now() - startTime;
      this.totalProcessed++;
      this.lastTaskTime = Date.now();

      // Save to history
      appendChatMessage(AUX_SESSION_ID, {
        role: 'user', content: task.prompt, ts: task.ts,
        taskType: task.type, taskId: task.id, meta: task.meta,
        protocol: auxConfig.protocol, wireApi: task._wireApi || null, transport: 'directHttp',
      });
      appendChatMessage(AUX_SESSION_ID, {
        role: 'assistant', content: resultText, ts: Date.now(),
        taskId: task.id, durationMs, cancelled: task.cancelled,
        protocol: auxConfig.protocol, wireApi: task._wireApi || null, transport: 'directHttp',
        enqueuedAt: task.ts, startedAt: startTime, queueMs: startTime - task.ts,
      });

      if (task.cancelled) {
        task.reject({ cancelled: true });
        this.broadcast({ type: 'aux_event', status: 'done', task: { id: task.id, type: task.type }, result: resultText, durationMs, cancelled: true });
      } else {
        this.recordSuccess();
        task.resolve({ text: resultText, cancelled: false });
        this.broadcast({ type: 'aux_event', status: 'done', task: { id: task.id, type: task.type }, result: resultText, durationMs, cancelled: false });
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errMsg = err?.message || String(err);
      this.recordFail(errMsg);
      appendChatMessage(AUX_SESSION_ID, {
        role: 'user', content: task.prompt, ts: task.ts,
        taskType: task.type, taskId: task.id, meta: task.meta,
        protocol: auxConfig.protocol, wireApi: task._wireApi || null, transport: 'directHttp',
      });
      appendChatMessage(AUX_SESSION_ID, {
        role: 'assistant', content: `[ERROR] ${errMsg}`, ts: Date.now(),
        taskId: task.id, durationMs, error: true,
        protocol: auxConfig.protocol, wireApi: task._wireApi || null, transport: 'directHttp',
        enqueuedAt: task.ts, startedAt: startTime, queueMs: startTime - task.ts,
      });
      task.reject(err);
      this.broadcast({ type: 'aux_event', status: 'error', task: { id: task.id, type: task.type }, error: errMsg, durationMs });
      console.error(`[multicc/aux] Task ${task.id} failed:`, errMsg);
    }

    this.currentTask = null;
    this.processing = false;
    this.drain(); // process next
  },

  // Resolve the configured protocol/provider to one direct HTTP target.
  resolveHttpTarget() {
    const target = providers.resolveAuxHttpTarget(auxConfig.protocol, auxConfig.providerId, {
      port: PORT,
      claudeOfficialViaProxy: CLAUDE_OFFICIAL_VIA_PROXY,
    });
    if (!target.available) {
      throw new Error(`Aux Provider 不可用：${target.reason || '缺少可调用的 HTTP 端点'}`);
    }
    return target;
  },

  execute(task) {
    let target;
    try {
      target = this.resolveHttpTarget();
    } catch (error) {
      return Promise.reject(error);
    }
    task._transport = 'directHttp';
    task._wireApi = target.wireApi;
    return this.executeHttp(task, target);
  },

  executeHttp(task, target) {
    const model = auxConfig.model || target.model || (target.modelOptions && target.modelOptions[0]) || '';
    return executeAuxHttp({
      target,
      model,
      prompt: task.prompt,
      systemPrompt: task.systemPrompt,
      timeoutMs: (task.meta && task.meta.timeout) || AUX_TIMEOUT_MS,
    });
  },

  broadcast(payload) {
    broadcastTo(this.clients, payload);
  },

  getStatus() {
    return {
      processing: this.processing,
      queueDepth: this.queue.length,
      currentTask: this.currentTask ? { id: this.currentTask.id, type: this.currentTask.type } : null,
      totalProcessed: this.totalProcessed,
      lastTaskTime: this.lastTaskTime,
      health: { ...this.health },
    };
  },
};

// REST API for aux
app.get('/api/aux/status', (req, res) => {
  res.json(auxQueue.getStatus());
});
app.get('/api/aux/health', (req, res) => {
  res.json({ health: { ...auxQueue.health } });
});

app.get('/api/aux/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, AUX_HISTORY_MAX);
  const history = loadChatHistory(AUX_SESSION_ID);
  res.json(history.slice(-limit));
});

app.post('/api/aux/enqueue', (req, res) => {
  const { type, prompt, meta } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  auxQueue.enqueue({ type: type || 'manual', prompt, meta: meta || {} })
    .then(result => res.json({ ok: true, result: result.text }))
    .catch(err => res.json({ ok: false, error: err?.message || 'cancelled' }));
});

function listAuxProviders(protocol) {
  const normalized = normalizeAuxProtocol(protocol);
  const appType = normalized === 'openai' ? 'codex' : 'claude';
  return providers.listProviders(appType).map((provider) => {
    const target = providers.resolveAuxHttpTarget(normalized, provider.id, {
      port: PORT,
      claudeOfficialViaProxy: CLAUDE_OFFICIAL_VIA_PROXY,
    });
    return {
      id: provider.id,
      name: provider.name,
      modelOptions: target.modelOptions || provider.modelOptions || [],
      wireApi: target.wireApi || provider.wireApi || null,
      available: !!target.available,
      unavailableReason: target.available ? null : target.reason,
    };
  }).filter(provider => provider.available);
}

// Aux model config: protocol -> callable provider -> model.
app.get('/api/aux/config', (req, res) => {
  const providersByProtocol = {
    anthropic: listAuxProviders('anthropic'),
    openai: listAuxProviders('openai'),
  };
  res.json({
    protocol: auxConfig.protocol,
    providerId: auxConfig.providerId,
    model: auxConfig.model,
    protocols: [
      { id: 'anthropic', name: 'Anthropic Messages' },
      { id: 'openai', name: 'OpenAI Responses / Chat Completions' },
    ],
    providersByProtocol,
  });
});
app.post('/api/aux/config', (req, res) => {
  const { providerId, model } = req.body || {};
  const rawProtocol = String((req.body || {}).protocol || '').toLowerCase();
  if (rawProtocol !== 'anthropic' && rawProtocol !== 'openai') {
    return res.status(400).json({ ok: false, error: 'protocol 必须是 anthropic 或 openai' });
  }
  const protocol = normalizeAuxProtocol(rawProtocol);
  if (!providerId) return res.status(400).json({ ok: false, error: '请选择 Provider' });
  const target = providers.resolveAuxHttpTarget(protocol, String(providerId), {
    port: PORT,
    claudeOfficialViaProxy: CLAUDE_OFFICIAL_VIA_PROXY,
  });
  if (!target.available) {
    return res.status(400).json({ ok: false, error: `Provider 不支持 ${protocol} HTTP 调用：${target.reason || '不可用'}` });
  }
  const resolvedModel = (model && String(model).trim())
    || target.model
    || (target.modelOptions && target.modelOptions[0])
    || null;
  if (!resolvedModel) return res.status(400).json({ ok: false, error: '请选择模型' });
  auxConfig.protocol = protocol;
  auxConfig.providerId = String(providerId);
  auxConfig.model = resolvedModel;
  saveAuxConfig();
  console.log(`[multicc/aux] config updated: protocol=${protocol} wire=${target.wireApi} provider=${auxConfig.providerId} model=${auxConfig.model}`);
  res.json({ ok: true, protocol, providerId: auxConfig.providerId, model: auxConfig.model, wireApi: target.wireApi });
});

// ── Goal-mode precheck ──
// Before a task is sent in "Goal 模式" (target-driven, run autonomously to
// completion, self-verify), the aux-AI judges whether it's well-formed enough.
// Which criteria ("限制") are checked is configurable per-dimension, plus a
// minimum pass score — globally in goal-config.json (settings panels) and
// per-send (the chat 🎯 dialog can override the dimensions for one check).
// Returns a verdict + a rewritten "goal-ready" version the user can accept/edit.
const GOAL_DIMENSIONS = {
  objective:  '目标明确：清楚要达成什么结果，而非含糊方向。',
  criteria:   '完成标准明确：有可判断「做完了」的验收标准或可观察的产出。',
  scope:      '范围清晰：边界明确，不至于无限发散。',
  executable: '可独立执行：代理无需再追问关键信息即可开工，或缺失信息能用合理默认补足。',
};
// Goal precheck config is global (a quality-gate preference). The execution
// limits (maxRounds / maxBudget), by contrast, are decided per-send in the goal
// dialog and are NOT persisted globally — see resolveGoalLimits.
const GOAL_CONFIG_DEFAULT = {
  dimensions: { objective: true, criteria: true, scope: true, executable: true },
  minScore: 60,
};
// Per-send execution limits. These are the hard client/server defaults used when
// a goal send omits a value; they are intentionally not stored in goal-config.json.
// maxRounds → caps the agent's autonomous turns (claude `--max-turns N`, hard
//   CLI-level limit). 0 = 不限制.
// maxBudget → advisory output-token budget injected into the goal prompt so the
//   agent self-stops near the cap (no hard CLI flag). 0 = 不限制.
const GOAL_ROUNDS_DEFAULT = 0;     // fallback round cap when a send omits it (0 = unlimited)
const GOAL_BUDGET_DEFAULT = 0;     // fallback budget (0 = unlimited)
const GOAL_ROUNDS_MAX = 200;       // sanity ceiling for --max-turns
const GOAL_BUDGET_MAX = 5000000;   // sanity ceiling for the advisory token budget
const GOAL_CONFIG_FILE = MULTICC_PATHS.goalConfigFile;

function clampInt(v, lo, hi, dflt) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = dflt;
  return Math.max(lo, Math.min(hi, n));
}

function normalizeGoalConfig(c) {
  c = c || {};
  const dims = {};
  for (const k of Object.keys(GOAL_DIMENSIONS)) {
    dims[k] = (c.dimensions && typeof c.dimensions[k] === 'boolean') ? c.dimensions[k] : GOAL_CONFIG_DEFAULT.dimensions[k];
  }
  const minScore = clampInt(c.minScore, 0, 100, GOAL_CONFIG_DEFAULT.minScore);
  return { dimensions: dims, minScore };
}

// Effective limits for one goal send: taken purely from the per-send override
// the client supplies in the goal dialog. There is no global limit config — a
// missing/blank value falls back to the hard default (rounds=40, budget=0).
function resolveGoalLimits(override) {
  const o = override && typeof override === 'object' ? override : {};
  const maxRounds = (o.maxRounds != null && o.maxRounds !== '')
    ? clampInt(o.maxRounds, 0, GOAL_ROUNDS_MAX, GOAL_ROUNDS_DEFAULT) : GOAL_ROUNDS_DEFAULT;
  const maxBudget = (o.maxBudget != null && o.maxBudget !== '')
    ? clampInt(o.maxBudget, 0, GOAL_BUDGET_MAX, GOAL_BUDGET_DEFAULT) : GOAL_BUDGET_DEFAULT;
  return { maxRounds, maxBudget };
}

// Server-side goal framing: appends the configured limits as explicit
// constraints so execution is bounded regardless of what the client embedded.
function buildGoalLimitNote(limits) {
  const parts = [];
  if (limits.maxRounds > 0) parts.push(`本次为 Goal 模式自主任务，自主执行的轮次（agent turns）上限为 ${limits.maxRounds} 轮，请在该轮次内完成；接近上限时先收敛、给出当前结论与未尽事项，不要无限发散。`);
  if (limits.maxBudget > 0) parts.push(`本次输出 token 预算上限约为 ${limits.maxBudget}，请在预算内完成；接近上限时停止并总结已完成的部分与剩余工作。`);
  return parts.length ? `[Goal 模式限制]\n${parts.join('\n')}\n[限制结束]\n\n` : '';
}

let goalConfig;
try { goalConfig = normalizeGoalConfig(JSON.parse(fs.readFileSync(GOAL_CONFIG_FILE, 'utf8'))); }
catch (_) { goalConfig = normalizeGoalConfig(null); }
function saveGoalConfig() {
  try { atomicWriteJson(GOAL_CONFIG_FILE, goalConfig); }
  catch (e) { console.warn('[multicc/goal] save config failed:', e.message); }
}

function buildGoalPrecheckPrompt(task, dims) {
  const keys = Object.keys(GOAL_DIMENSIONS).filter(k => dims[k]);
  // Never send an empty rubric — fall back to all dimensions if none enabled.
  const list = (keys.length ? keys : Object.keys(GOAL_DIMENSIONS))
    .map((k, i) => `${i + 1}. ${GOAL_DIMENSIONS[k]}`).join('\n');
  return `你是「任务质量审查助手」。下面是用户想交给一个自主 AI 编程代理、以「Goal 模式」（目标驱动、自主规划并执行到完成、最后自检验证）执行的任务。

请只依据以下启用的标准判断它是否满足要求：
${list}

只输出一个 JSON 对象，不要任何额外文字、不要 markdown 代码块，字段如下：
{
  "verdict": "ok" | "needs_work",
  "score": 0,
  "issues": ["不满足之处，没有则空数组"],
  "questions": ["仍需向用户澄清的问题，没有则空数组"],
  "criteria": ["建议的完成/验收标准"],
  "revised": "改写后可直接执行的 Goal-ready 任务描述，含目标与完成标准；若原任务已经很好可与原文基本一致"
}

score 为 0-100 的整数符合度评分，只针对上面启用的标准评分。所有文本字段用与用户任务相同的语言填写。

用户任务：
<<<
${task}
>>>`;
}

function parseGoalVerdict(text) {
  const raw = String(text || '');
  let obj = null;
  try { obj = JSON.parse(raw.trim()); } catch (_) {}
  if (!obj) {
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s !== -1 && e > s) { try { obj = JSON.parse(raw.slice(s, e + 1)); } catch (_) {} }
  }
  if (!obj || typeof obj !== 'object') {
    return { verdict: 'needs_work', score: 0, issues: ['辅助 AI 未能给出可解析的结果，请人工确认或直接发送'], questions: [], criteria: [], revised: '', raw };
  }
  const arr = (v) => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];
  const verdict = obj.verdict === 'ok' ? 'ok' : 'needs_work';
  let score = parseInt(obj.score, 10); if (!Number.isFinite(score)) score = verdict === 'ok' ? 80 : 40;
  score = Math.max(0, Math.min(100, score));
  return {
    verdict, score,
    issues: arr(obj.issues),
    questions: arr(obj.questions),
    criteria: arr(obj.criteria),
    revised: typeof obj.revised === 'string' ? obj.revised.trim() : '',
  };
}

// Goal precheck config (global defaults; the chat dialog may override dimensions
// per-send). dimensionLabels lets both UIs render the criteria without hardcoding.
app.get('/api/settings/goal', (req, res) => {
  res.json({ ...goalConfig, dimensionLabels: GOAL_DIMENSIONS });
});
app.post('/api/settings/goal', (req, res) => {
  goalConfig = normalizeGoalConfig(req.body || {});
  saveGoalConfig();
  res.json({ ok: true, ...goalConfig });
});

app.post('/api/goal/precheck', (req, res) => {
  const body = req.body || {};
  const task = (body.task || '').trim();
  if (!task) return res.status(400).json({ error: 'task required' });
  // Per-send dimensions override the global default when provided; minScore too.
  const dims = (body.dimensions && typeof body.dimensions === 'object')
    ? normalizeGoalConfig({ dimensions: body.dimensions }).dimensions
    : goalConfig.dimensions;
  let minScore = parseInt(body.minScore, 10);
  if (!Number.isFinite(minScore)) minScore = goalConfig.minScore;
  minScore = Math.max(0, Math.min(100, minScore));
  auxQueue.enqueue({ type: 'goal_check', prompt: buildGoalPrecheckPrompt(task, dims), meta: { taskLen: task.length } })
    .then(result => {
      const v = parseGoalVerdict(result.text);
      // Below-threshold scores are downgraded even if the AI said "ok".
      if (minScore > 0 && v.verdict === 'ok' && v.score < minScore) {
        v.verdict = 'needs_work';
        v.issues = [`符合度 ${v.score} 低于设定阈值 ${minScore}`, ...v.issues];
      }
      res.json({ ok: true, ...v, dimensions: dims, minScore });
    })
    .catch(err => res.json({ ok: false, error: err?.message || 'aux failed' }));
});

// ── Per-session providers (backed by cc-switch) ──────────────────────────────
// Global default provider per CLI; new sessions inherit it. Stored separately
// from cc-switch's own "current" selection so multicc stays independent.
const PROVIDER_DEFAULTS_FILE = MULTICC_PATHS.providerDefaultsFile;
let providerDefaults = { claude: null, codex: null };
try {
  const d = JSON.parse(fs.readFileSync(PROVIDER_DEFAULTS_FILE, 'utf8'));
  providerDefaults = { claude: d.claude || null, codex: d.codex || null };
} catch (_) { /* none yet */ }
function saveProviderDefaults() {
  try { atomicWriteJson(PROVIDER_DEFAULTS_FILE, providerDefaults); }
  catch (e) { console.error('[multicc] save provider-defaults failed:', e.message); }
}
// Validate a provider id exists for the given cli; '' / null clears the override.
function validProviderId(cli, id) {
  if (id == null || id === '') return { ok: true, value: null };
  const appType = cli === 'codex' ? 'codex' : 'claude';
  if (!providers.getProviderSummary(appType, String(id))) return { ok: false };
  return { ok: true, value: String(id) };
}

// List providers (optionally ?appType=claude|codex). Secrets are masked.
// multicc owns this store; cc-switch is only an import source.
app.get('/api/providers', (req, res) => {
  const appType = (req.query.appType || '').trim();
  const ccSwitchStatus = providers.getCcSwitchStatus();
  res.json({
    available: true,
    ccSwitchAvailable: ccSwitchStatus.available,
    ccSwitchStatus,
    providers: providers.listProviders(appType === 'claude' || appType === 'codex' ? appType : undefined),
    defaults: providerDefaults,
    stats: providers.getProviderUsageStats().stats,
  });
});

// Per-provider token usage stats aggregated from chat_history.
app.get('/api/providers/stats', (req, res) => {
  try {
    const stats = providers.getProviderUsageStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Version check — query GitHub Releases API for the latest stable tag and
// compare it with the locally installed version (package.json).  Called by the
// manage UI sidebar; also usable by the multicc update script.
app.get('/api/version-check', async (req, res) => {
  try {
    const pkg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'package.json'), 'utf8'));
    const current = pkg.version || '0.0.0';

    // Read the channel from .multicc_channel (written by install.sh).
    let channel = 'dev';
    try {
      const ch = require('fs').readFileSync(require('path').join(__dirname, '.multicc_channel'), 'utf8');
      const m = ch.match(/^# channel:\s*(\S+)/m);
      if (m) channel = m[1];
    } catch (_) { /* file may not exist (pre-channel installs) */ }

    let latest = null;
    let latestVersion = null;
    let apiError = false;

    // 1) Try the GitHub Releases API (15s timeout, no auth needed for public repos).
    try {
      const https = require('https');
      const apiResp = await new Promise((resolve, reject) => {
        const r = https.get(
          'https://api.github.com/repos/lsjwzh/MultiCC/releases/latest',
          { headers: { 'User-Agent': 'multicc-version-check/1.0', 'Accept': 'application/vnd.github+json' }, timeout: 15000 },
          (resp) => {
            let body = '';
            resp.on('data', d => body += d);
            resp.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
          }
        );
        r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
        r.on('error', reject);
      });
      latest = apiResp.tag_name || null;
      if (latest) latestVersion = latest.replace(/^v/, '');
    } catch (_) { apiError = true; }

    // 2) Fallback: use git ls-remote to get the latest semver tag.
    if (!latest) {
      try {
        const cp = require('child_process');
        const tags = cp.execSync("git ls-remote --tags https://github.com/lsjwzh/MultiCC.git 'refs/tags/v*'", { timeout: 15000, encoding: 'utf8' })
          .split('\n')
          .filter(Boolean)
          .map(l => l.match(/refs\/tags\/(v\d+\.\d+\.\d+)/))
          .filter(Boolean)
          .map(m => m[1]);
        if (tags.length) {
          // sort semver and pick the highest
          const sorted = cp.execSync('sort -V', { input: tags.join('\n'), encoding: 'utf8' }).trim().split('\n');
          latest = sorted[sorted.length - 1];
          latestVersion = latest.replace(/^v/, '');
        }
      } catch (_) { /* all paths failed */ }
    }

    const updateAvailable = latestVersion ? (compareSemver(current, latestVersion) < 0) : false;

    res.json({
      current,
      channel,
      latest: latest || null,
      latestVersion: latestVersion || null,
      updateAvailable,
      apiError
    });
  } catch (e) {
    res.json({ current: '0.0.0', channel: 'dev', latest: null, latestVersion: null, updateAvailable: false, apiError: true });
  }
});

// Simple semver comparator (returns <0 if a < b, 0 if equal, >0 if a > b).
function compareSemver(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

// Global Claude Code token usage, read from the claude CLI transcripts under
// ~/.claude/projects (ground truth, covers ALL usage — not just multicc turns).
// Independent of the per-provider stats above; grouped by model + day. Cached
// (~120s); pass ?refresh=1 to force a re-scan.
app.get('/api/token-usage/global', async (req, res) => {
  try {
    const data = await tokenGlobal.getGlobalUsage({ force: req.query.refresh === '1' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Per-role (main vs sub) + per-provider token breakdown. The CLI's `result`
// event merges main + all subagents into one usage block even when they ran on
// different providers, so this endpoint surfaces the proxy's per-request
// accounting (the only source that knows each request's real route).
//   ?session=<id>  → current-turn runtime breakdown (main/sub/byProviderSub)
//   (no arg)       → persistent per-day ledger from token_by_role.json
app.get('/api/token-usage/by-role', (req, res) => {
  try {
    if (req.query.session) {
      return res.json(roleTokenTracker.snapshot(req.query.session)
        || { main: null, sub: null, subByProvider: [] });
    }
    res.json(roleTokenTracker.readLedger());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Import / sync providers from cc-switch into multicc's own store (idempotent).
app.post('/api/providers/import', (req, res) => {
  try {
    const r = providers.importFromCcSwitch();
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({
      error: e.message,
      ...(e.code ? { code: e.code } : {}),
      ...(e.reason ? { reason: e.reason } : {}),
    });
  }
});

app.post('/api/providers', (req, res) => {
  try {
    const r = providers.createProvider({
      appType: (req.body.appType || '').trim(),
      name: req.body.name,
      baseUrl: (req.body.baseUrl || '').trim(),
      authToken: (req.body.authToken || '').trim(),
      model: (req.body.model || '').trim(),
      models: req.body.models,
      useChatResponsesProxy: req.body.useChatResponsesProxy,
      settingsConfig: req.body.settingsConfig,
      aliasMap: req.body.aliasMap,
    });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/providers/:appType/:id', (req, res) => {
  try {
    providers.updateProvider(req.params.appType, req.params.id, {
      name: req.body.name,
      baseUrl: req.body.baseUrl,
      authToken: req.body.authToken,
      model: req.body.model,
      models: req.body.models,
      useChatResponsesProxy: req.body.useChatResponsesProxy,
      settingsConfig: req.body.settingsConfig,
      aliasMap: req.body.aliasMap,
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/providers/:appType/:id', (req, res) => {
  try {
    const removed = providers.deleteProvider(req.params.appType, req.params.id);
    // Clear any default that pointed at the deleted provider.
    let changed = false;
    for (const cli of ['claude', 'codex']) {
      if (providerDefaults[cli] === req.params.id) { providerDefaults[cli] = null; changed = true; }
    }
    if (changed) saveProviderDefaults();
    res.json({ ok: removed });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Probe which model names a provider's relay accepts (read-only; max_tokens:1).
// Used to confirm the safe wire name for an alias-only relay. Body: { candidates?: string[] }.
app.post('/api/providers/:appType/:id/probe', async (req, res) => {
  try {
    const p = providers.getProvider(req.params.appType, req.params.id);
    if (!p) return res.status(404).json({ error: 'provider not found' });
    const cfg = typeof p.settingsConfig === 'string' ? JSON.parse(p.settingsConfig) : (p.settingsConfig || {});
    const env = (cfg && cfg.env) || {};
    const result = await providers.probeRelayModels(env, req.body && req.body.candidates, CLAUDE_CMD);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Speed-test: fire a minimal API call through the provider's real relay and
// measure round-trip latency.  Returns { ok, ms, status, model, error? }.
app.post('/api/providers/:appType/:id/speedtest', async (req, res) => {
  const t0 = Date.now();
  try {
    const p = providers.getProvider(req.params.appType, req.params.id);
    if (!p) return res.status(404).json({ ok: false, ms: Date.now() - t0, error: 'provider not found' });
    const cfg = typeof p.settingsConfig === 'string' ? JSON.parse(p.settingsConfig) : (p.settingsConfig || {});
    const env = (cfg && cfg.env) || {};
    const appType = req.params.appType;

    // ── Codex providers ──────────────────────────────────────────────
    if (appType === 'codex') {
      const cx = providers.resolveCodexDirectHttp(req.params.id);
      if (!cx.canDirect) {
        return res.json({ ok: false, ms: Date.now() - t0, error: cx.reason || 'OAuth 订阅型 provider 不支持测速' });
      }
      const model = (cx.modelOptions && cx.modelOptions[0]) || cx.model || 'gpt-4o-mini';
      const body = JSON.stringify(cx.wireApi === 'responses'
        ? { model, input: 'hi', max_output_tokens: 1 }
        : { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
      let urlObj;
      try { urlObj = new URL(cx.url); } catch (e) {
        return res.json({ ok: false, ms: Date.now() - t0, error: 'bad url: ' + cx.url });
      }
      const isHttps = urlObj.protocol === 'https:';
      const lib = isHttps ? require('https') : require('http');
      await new Promise((resolve, reject) => {
        const hReq = lib.request({
          hostname: urlObj.hostname,
          port: urlObj.port || (isHttps ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cx.apiKey}` },
        }, (hRes) => {
          let data = '';
          hRes.on('data', chunk => data += chunk);
          hRes.on('end', () => {
            const ms = Date.now() - t0;
            if (hRes.statusCode >= 200 && hRes.statusCode < 300) {
              res.json({ ok: true, ms, status: hRes.statusCode, model });
            } else {
              let err = `HTTP ${hRes.statusCode}`;
              try { const pe = JSON.parse(data); if (pe.error) err = (pe.error.message || JSON.stringify(pe.error)); } catch (_) {}
              res.json({ ok: false, ms, status: hRes.statusCode, model, error: err });
            }
            resolve();
          });
        });
        hReq.on('error', (e) => { res.json({ ok: false, ms: Date.now() - t0, error: e.message }); resolve(); });
        hReq.setTimeout(15000, () => { hReq.destroy(); res.json({ ok: false, ms: Date.now() - t0, error: 'timeout' }); });
        hReq.write(body);
        hReq.end();
      });
      return;
    }

    // ── Claude providers ─────────────────────────────────────────────
    const hasKey = !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
    const isOfficial = req.params.id === 'claude-official';
    const canDirect = (env.ANTHROPIC_BASE_URL && hasKey) || (isOfficial && CLAUDE_OFFICIAL_VIA_PROXY);

    if (!canDirect) {
      return res.json({ ok: false, ms: Date.now() - t0, error: isOfficial ? 'OAuth 订阅型 provider 不支持测速（开启 CLAUDE_OFFICIAL_VIA_PROXY 可测速）' : '缺少 API Key 或 Base URL' });
    }

    // Resolve a real wire model id to POST. The provider's own model wins
    // (canonical ANTHROPIC_MODEL, else its haiku-tier target — e.g. iFlytek's
    // xopdeepseekv4flash). OAuth-subscription providers (claude-official) declare
    // no model of their own, so fall back to WIRE_DEFAULT_MODEL — the same safe
    // wire name the spawn path stamps for alias-only providers. Never fall back
    // to a CLI-only alias like 'haiku': the raw /v1/messages endpoint bypasses the
    // CLI's alias resolution and rejects it with 404 model-not-found.
    const model = env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_HAIKU_MODEL || providers.WIRE_DEFAULT_MODEL;

    // OAuth subscription tokens (claude-official) require the Claude Code
    // identity assertion in the first system block. Without it, Anthropic
    // treats the bare request as token probing and returns 429 rate_limit
    // (anti-abuse). The CLI always sends this block; normal CLI requests
    // forwarded through the proxy carry it naturally, but speedtest generates
    // a synthetic body — so we inject it here. Mirrors ensureClaudeIdentity()
    // in claude-proxy.js.
    const isOfficialOAuth = isOfficial && !hasKey;
    const body = JSON.stringify({
      model,
      max_tokens: 1,
      ...(isOfficialOAuth ? { system: [{ type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' }] } : {}),
      messages: [{ role: 'user', content: 'hi' }],
    });

    await new Promise((resolve) => {
      const hReq = require('http').request({
        hostname: '127.0.0.1',
        port: PORT,
        path: `/claude-proxy/${req.params.id}/speedtest/v1/messages?beta=true`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `multicc-speedtest`,
          'anthropic-version': '2023-06-01',
          'x-api-key': 'multicc-speedtest',
          // OAuth token recognized only when x-app: cli signals official CLI
          // origin — without it, even a correct system block + Bearer token
          // still hits anti-abuse 429 (Anthropic sees a script, not a CLI).
          ...(isOfficialOAuth ? { 'x-app': 'cli' } : {}),
        },
      }, (hRes) => {
        let data = '';
        hRes.on('data', chunk => data += chunk);
        hRes.on('end', () => {
          const ms = Date.now() - t0;
          if (hRes.statusCode >= 200 && hRes.statusCode < 300) {
            res.json({ ok: true, ms, status: hRes.statusCode, model });
          } else {
            let err = `HTTP ${hRes.statusCode}`;
            try { const pe = JSON.parse(data); if (pe.error) err = (pe.error.message || JSON.stringify(pe.error)); } catch (_) {}
            res.json({ ok: false, ms, status: hRes.statusCode, model, error: err });
          }
          resolve();
        });
      });
      hReq.on('error', (e) => { res.json({ ok: false, ms: Date.now() - t0, error: e.message }); resolve(); });
      hReq.setTimeout(15000, () => { hReq.destroy(); res.json({ ok: false, ms: Date.now() - t0, error: 'timeout' }); });
      hReq.write(body);
      hReq.end();
    });
  } catch (e) {
    res.json({ ok: false, ms: Date.now() - t0, error: e.message });
  }
});

// Get / set the global default provider per CLI.
app.get('/api/provider-defaults', (req, res) => res.json(providerDefaults));
app.put('/api/provider-defaults', (req, res) => {
  for (const cli of ['claude', 'codex']) {
    if (req.body[cli] !== undefined) {
      const v = validProviderId(cli, req.body[cli]);
      if (!v.ok) return res.status(400).json({ error: `invalid ${cli} provider id` });
      providerDefaults[cli] = v.value;
    }
  }
  saveProviderDefaults();
  res.json({ ok: true, defaults: providerDefaults });
});

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

// APK info endpoint — returns file modification time
app.get('/api/apk-info', (req, res) => {
  const apkPath = path.join(__dirname, 'public', 'multicc.apk');
  try {
    const stat = fs.statSync(apkPath);
    const info = { exists: true, mtime: stat.mtime.toISOString(), size: stat.size };
    // Optional version sidecar written by scripts/publish-apk.sh — lets the
    // updater show the real version instead of a generic "new version".
    try {
      const meta = JSON.parse(fs.readFileSync(apkPath + '.json', 'utf8'));
      if (meta.versionName) info.versionName = meta.versionName;
      if (meta.versionCode) info.versionCode = meta.versionCode;
    } catch (_) {}
    res.json(info);
  } catch {
    res.json({ exists: false });
  }
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
const CHAT_HISTORY_DIR = MULTICC_PATHS.chatHistoryDir;
try { ensurePrivateDir(CHAT_HISTORY_DIR); } catch (_) {}
const MAX_CHAT_MESSAGES = 50;  // legacy rolling window (kept for reference)
// Soft cap for full-history retention. chat_history is display-only (never fed
// to the CLI - the CLI uses its own transcript via --resume), so we keep the
// full conversation for pagination/scroll-back and only distill-into-memory at
// this large backstop to bound disk/memory in pathological sessions.
const CHAT_HISTORY_SOFT_CAP = 10000;
// How many messages the initial WS `chat_history` push sends (the newest page).
// Older messages are fetched on demand via GET /history?before=<id>&limit=N as
// the user scrolls up.
const CHAT_HISTORY_PAGE = 30;

// ── Per-session token usage accumulator ──
// chat_history has a rolling window (50 messages), so older usage data gets
// trimmed. This file stores the CUMULATIVE total per session and never shrinks.
const TOKEN_USAGE_FILE = MULTICC_PATHS.tokenUsageFile;
// Real consumed input for a turn = fresh input + cache reads + cache writes.
// Anthropic's input_tokens EXCLUDES cache_read/cache_creation, but those are
// real billed/consumed context tokens — counting only input_tokens undercounts
// actual usage by a large factor on cache-heavy turns. Matches how the
// frontend computes "本轮" context size.
function consumedInput(u) {
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}
function accumulateTokenUsage(sessionName, usage) {
  if (!usage || (!usage.input_tokens && !usage.output_tokens && !usage.cache_read_input_tokens && !usage.cache_creation_input_tokens)) return;
  let data = {};
  try { data = JSON.parse(fs.readFileSync(TOKEN_USAGE_FILE, 'utf8')); } catch (_) {}
  if (typeof data !== 'object' || Array.isArray(data)) data = {};
  const cur = data[sessionName] || { inputTokens: 0, outputTokens: 0, turnCount: 0 };
  cur.inputTokens += consumedInput(usage);
  cur.outputTokens += usage.output_tokens || 0;
  cur.turnCount += 1;
  data[sessionName] = cur;
  try { atomicWriteJson(TOKEN_USAGE_FILE, data); } catch (e) {
    console.error(`[multicc] Failed to save token usage: ${e.message}`);
  }
  // ── Also write to per-day aggregation for time-window queries ──
  accumulateTokenDaily(sessionName, usage);
}
function getTokenUsage() {
  try { return JSON.parse(fs.readFileSync(TOKEN_USAGE_FILE, 'utf8')); } catch (_) { return {}; }
}

// ── Per-provider daily token aggregation ──
// token_daily.json: { "YYYY-MM-DD": { "<providerId>": { inputTokens, outputTokens, turnCount }, ... } }
// Enables "today / this week / this month" queries per provider.
const TOKEN_DAILY_FILE = MULTICC_PATHS.tokenDailyFile;

function accumulateTokenDaily(sessionName, usage) {
  const inp = consumedInput(usage);
  const out = usage.output_tokens || 0;
  if (inp + out === 0) return;

  // Resolve provider from persisted session.
  const persisted = persistedSessions.get(sessionName);
  const providerId = (persisted && persisted.provider) || '_default_';

  const today = new Date();
  const dateKey = today.getFullYear() + '-' +
    String(today.getMonth() + 1).padStart(2, '0') + '-' +
    String(today.getDate()).padStart(2, '0');

  let daily = {};
  try { daily = JSON.parse(fs.readFileSync(TOKEN_DAILY_FILE, 'utf8')); } catch (_) {}
  if (typeof daily !== 'object' || Array.isArray(daily)) daily = {};

  const dayEntry = daily[dateKey] || {};
  const prov = dayEntry[providerId] || { inputTokens: 0, outputTokens: 0, turnCount: 0 };
  prov.inputTokens += inp;
  prov.outputTokens += out;
  prov.turnCount += 1;
  dayEntry[providerId] = prov;
  daily[dateKey] = dayEntry;

  try { atomicWriteJson(TOKEN_DAILY_FILE, daily); } catch (e) {
    console.error(`[multicc] Failed to save daily token usage: ${e.message}`);
  }
}

// One-time migration: seed token_usage.json from existing chat_history/*.json
// so historical usage (mostly codex) isn't lost on first boot after upgrade.
function seedTokenUsageFromHistory() {
  let accum = {};
  try { accum = JSON.parse(fs.readFileSync(TOKEN_USAGE_FILE, 'utf8')); } catch (_) {}
  if (typeof accum !== 'object' || Array.isArray(accum)) accum = {};
  let seeded = 0;

  let files;
  try { files = fs.readdirSync(CHAT_HISTORY_DIR); } catch (_) { return; }
  for (const fname of files) {
    if (!fname.endsWith('.json')) continue;
    if (fname === '__aux__.json' || fname === '__gateway__.json') continue;
    const sessionId = fname.replace(/\.json$/, '');
    if (accum[sessionId]) continue;  // already tracked

    try {
      const msgs = JSON.parse(fs.readFileSync(path.join(CHAT_HISTORY_DIR, fname), 'utf8'));
      if (!Array.isArray(msgs)) continue;
      let inp = 0, out = 0, turns = 0;
      for (const m of msgs) {
        const u = m.usage;
        if (!u || (typeof u.input_tokens !== 'number' && typeof u.output_tokens !== 'number')) continue;
        inp += u.input_tokens || 0;
        out += u.output_tokens || 0;
        turns += 1;
      }
      if (turns > 0) {
        accum[sessionId] = { inputTokens: inp, outputTokens: out, turnCount: turns };
        seeded++;
      }
    } catch (_) {}
  }

  if (seeded > 0) {
    try { atomicWriteJson(TOKEN_USAGE_FILE, accum); } catch (_) {}
    console.log(`[multicc] Seeded token_usage.json from chat_history: ${seeded} session(s)`);
  }
}

// In-memory cache: sessionName → [ { role, content, ts, cost?, tools? } ]
const chatHistories = new Map();

function chatHistoryPath(sessionName) {
  const safe = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_') || '_default';
  return path.join(CHAT_HISTORY_DIR, `${safe}.json`);
}

function loadChatHistory(sessionName) {
  if (chatHistories.has(sessionName)) return chatHistories.get(sessionName);
  try {
    const data = JSON.parse(fs.readFileSync(chatHistoryPath(sessionName), 'utf8'));
    // Sanitize empty thinking blocks from models like GLM that return
    // thinking blocks with only whitespace; Claude API rejects these with
    // HTTP 400 "each thinking block must contain non-whitespace thinking".
    if (Array.isArray(data)) {
      let cleaned = 0;
      for (const msg of data) {
        if (!msg || !Array.isArray(msg.content)) continue;
        msg.content = msg.content.filter((block) => {
          if (block && block.type === 'thinking' && (!block.thinking || !/\S/.test(block.thinking))) { cleaned++; return false; }
          return true;
        });
      }
      if (cleaned > 0) console.log(`[multicc] sanitized ${cleaned} empty thinking block(s) from ${data.length} messages`);
      // Backfill ids on entries saved before per-message ids existed, so
      // every replayed message is deletable. Persisted on the next save.
      for (const msg of data) {
        if (msg && msg.role && !msg.id) msg.id = newChatMsgId();
      }
    }
    chatHistories.set(sessionName, data);
    return data;
  } catch (_) {
    const arr = [];
    chatHistories.set(sessionName, arr);
    return arr;
  }
}

function latestAssistantMessageAt(sessionName) {
  const history = loadChatHistory(sessionName);
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!msg || msg.role !== 'assistant') continue;
    const ts = Number(msg.ts);
    if (Number.isFinite(ts) && ts > 0) return new Date(ts);
  }
  return null;
}

function chatLastActivity(sessionName, activeChat) {
  const saved = latestAssistantMessageAt(sessionName);
  const live = activeChat?.lastActivity ? new Date(activeChat.lastActivity) : null;
  if (saved && live && Number.isFinite(live.getTime())) {
    return saved.getTime() >= live.getTime() ? saved : live;
  }
  return saved || (live && Number.isFinite(live.getTime()) ? live : null);
}

function saveChatHistory(sessionName) {
  const history = chatHistories.get(sessionName);
  if (!history) return;
  try {
    atomicWriteJson(chatHistoryPath(sessionName), history);
  } catch (e) {
    console.error(`[multicc/chat] Failed to save history for ${sessionName}:`, e.message);
  }
}

// Messages dropped by the rolling-window trim accumulate here per session; once
// a batch builds up we distill them into memory before they're gone for good.
const _droppedForMemory = new Map();  // sessionName → [msg, …]
const MEMORY_DISTILL_BATCH = 10;

// Stable per-message id so a single history entry can be addressed later
// (per-message delete). Monotonic-ish and collision-free within a process.
let _chatMsgIdSeq = 0;
function newChatMsgId() {
  return 'm' + Date.now().toString(36) + '-' + (_chatMsgIdSeq++).toString(36);
}

// Incremental save: flush the in-progress assistant message to chat_history
// while the turn is still running. Throttled to at most once per 5s per session
// so we don't hammer the disk. The final save in the close handler overwrites
// this interim version with the complete message.
const _incrSaveTimers = new Map(); // sessionName → setTimeout

function scheduleIncrementalSave(sessionName, cs) {
  if (_incrSaveTimers.has(sessionName)) return; // already scheduled
  _incrSaveTimers.set(sessionName, setTimeout(() => {
    _incrSaveTimers.delete(sessionName);
    if (!cs.currentAssistantText || cs.currentAssistantText.length < 20) return;
    const history = loadChatHistory(sessionName);
    // Replace the last in-progress entry or append a new one
    const last = history[history.length - 1];
    const interimMsg = {
      role: 'assistant', content: cs.currentAssistantText,
      tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
      ts: Date.now(), _interim: true,
    };
    if (last && last.role === 'assistant' && last._interim) {
      history[history.length - 1] = interimMsg;
    } else {
      if (!interimMsg.id) interimMsg.id = newChatMsgId();
      history.push(interimMsg);
    }
    saveChatHistory(sessionName);
  }, 5000));
}

function appendChatMessage(sessionName, msg) {
  const history = loadChatHistory(sessionName);
  if (!msg.id) msg.id = newChatMsgId();

  // A final assistant save (non-interim) supersedes any trailing interim
  // entries from the same turn - drop them so they don't pile up as
  // duplicate near-identical messages in the history.
  if (msg.role === 'assistant' && !msg._interim) {
    while (history.length > 0) {
      const last = history[history.length - 1];
      if (last && last.role === 'assistant' && last._interim) history.pop();
      else break;
    }
  }

  // Dedup: skip if the last message in history is an assistant with identical
  // content and tools (guards against double-saves from stream-replay races).
  if (msg.role === 'assistant' && history.length > 0) {
    const prev = history[history.length - 1];
    if (prev.role === 'assistant' &&
        prev.content === msg.content &&
        JSON.stringify(prev.tools || null) === JSON.stringify(msg.tools || null)) {
      // Update usage/timing on the existing message instead of pushing a duplicate.
      if (!prev.id) prev.id = newChatMsgId();
      if (msg.usage) prev.usage = msg.usage;
      if (msg.cost != null) prev.cost = msg.cost;
      if (msg.durationMs != null) prev.durationMs = msg.durationMs;
      if (msg.ts) prev.ts = msg.ts;
      saveChatHistory(sessionName);
      chatBroadcast(sessionName, { type: 'chat_msg_meta', id: prev.id, role: prev.role, ts: prev.ts });
      return;
    }
  }

  history.push(msg);
  if (msg && msg.role === 'assistant') {
    const ts = Number(msg.ts);
    const at = Number.isFinite(ts) && ts > 0 ? new Date(ts) : new Date();
    const cs = chatSessions.get(sessionName);
    if (cs) cs.lastActivity = at;
    // Interaction latency: time from this turn's start (user submit / LLM call)
    // to the reply being saved. Stamped centrally so every completion path
    // (claude/codex, normal/cancelled/error) records it without duplication.
    if (msg.durationMs == null && cs && cs.turnStartedAt) {
      msg.durationMs = Math.max(0, at.getTime() - cs.turnStartedAt);
    }
  }
  // Full-history retention: only trim at the large soft cap (display-only data,
  // not CLI context). Aux/gateway keep their own smaller rolling window.
  const limit = sessionName === AUX_SESSION_ID ? AUX_HISTORY_MAX : CHAT_HISTORY_SOFT_CAP;
  const isAux = sessionName === AUX_SESSION_ID;
  while (history.length > limit) {
    const dropped = history.shift();
    // Don't distill the aux/gateway internal logs — only real chat sessions.
    if (!isAux && dropped) {
      const buf = _droppedForMemory.get(sessionName) || [];
      buf.push(dropped);
      if (buf.length >= MEMORY_DISTILL_BATCH) {
        distillHistoryIntoMemory(sessionName, buf);
        _droppedForMemory.set(sessionName, []);
      } else {
        _droppedForMemory.set(sessionName, buf);
      }
    }
  }
  saveChatHistory(sessionName);
  // Tell live clients the id this message was saved under, so the bubble
  // already on screen becomes individually addressable (delete button).
  chatBroadcast(sessionName, { type: 'chat_msg_meta', id: msg.id, role: msg.role, ts: msg.ts });
  if (msg && msg.role === 'assistant' && !msg._interim && !msg.cancelled && !msg.partial && !msg.error) {
    // Keep the user-visible turn fast. The review counter is persisted and the
    // actual auxiliary review runs after the reply has already been saved.
    setImmediate(() => maybeSchedulePeriodicMemoryReview(sessionName));
  }
}

// ── Chat sessions: session-level state for multi-client broadcast ──
// Keyed by sessionName, holds { claudeProc, lineBuf, clients, chatTurnCount,
//   chatClaudeSessionId, cwd, currentAssistantText, currentToolCalls, currentCost,
//   streamEvents }
const chatSessions = new Map();

function chatBroadcast(sessionName, payload) {
  const cs = chatSessions.get(sessionName);
  if (!cs) return;
  broadcastTo(cs.clients, payload);
}

// Push updated provider time-window stats to the chat frontend after a turn.
function broadcastProviderTokenStats(sessionName) {
  const persisted = persistedSessions.get(sessionName);
  const provId = (persisted && persisted.provider) || null;
  const dailyWindows = providers.readDailyWindows();
  const provWindows = provId ? {
    today: (dailyWindows.today && dailyWindows.today[provId]) || null,
    week: (dailyWindows.week && dailyWindows.week[provId]) || null,
    month: (dailyWindows.month && dailyWindows.month[provId]) || null,
    all: (dailyWindows.all && dailyWindows.all[provId]) || null,
  } : null;
  // Same all-time fallback as the init path, so the bar still shows lifetime
  // totals when daily data is sparse.
  if (provId && provWindows && !provWindows.all) {
    const accum = getTokenUsage();
    let allIn = 0, allOut = 0, allTurns = 0;
    for (const [sid, entry] of Object.entries(accum)) {
      const sp = persistedSessions.get(sid);
      if ((sp && sp.provider === provId) || sid === sessionName) {
        allIn += entry.inputTokens || 0;
        allOut += entry.outputTokens || 0;
        allTurns += entry.turnCount || 0;
      }
    }
    if (allIn + allOut > 0) provWindows.all = { inputTokens: allIn, outputTokens: allOut, turnCount: allTurns };
  }
  chatBroadcast(sessionName, { type: 'provider_token_stats', windows: provWindows });
}

// Push the per-turn main/sub role breakdown to the chat frontend so "本轮" can
// render "主 A / 辅 B" instead of the CLI's single merged number. Sourced from
// the claude-proxy onUsage hook (roleTokenTracker), which sees each /v1/messages
// request's real route — independent of the session's main provider.
function broadcastRoleTokenStats(sessionName) {
  const payload = roleTokenTracker.snapshot(sessionName);
  if (!payload) return;
  chatBroadcast(sessionName, { type: 'role_token_stats', role: payload });
}

// Codex reports one aggregate turn usage for the parent plus every child thread.
// Proxy-backed requests are already exact per role. An official parent can stay
// direct, though, so fill only the positive remainder after subtracting all
// proxy-observed main/sub buckets. This also covers providers that omitted usage
// on one response without double-counting routes the proxy did observe.
function reconcileCodexRoleUsage(sessionName, usage) {
  const persisted = persistedSessions.get(sessionName);
  if (!persisted || persisted.cli !== 'codex' || !usage) return;
  const cached = Number(usage.cache_read_input_tokens || usage.cached_input_tokens || 0);
  const input = Number(usage.input_tokens || 0);
  const aggregate = {
    inputTokens: usage.cache_read_input_tokens == null ? Math.max(0, input - cached) : input,
    outputTokens: Number(usage.output_tokens || 0),
    cacheWrite: Number(usage.cache_creation_input_tokens || 0),
    cacheRead: cached,
  };
  const snapshot = roleTokenTracker.snapshot(sessionName) || {};
  const main = snapshot.main || {};
  const sub = snapshot.sub || {};
  const missing = {
    inputTokens: Math.max(0, aggregate.inputTokens - (main.inputTokens || 0) - (sub.inputTokens || 0)),
    outputTokens: Math.max(0, aggregate.outputTokens - (main.outputTokens || 0) - (sub.outputTokens || 0)),
    cacheWrite: Math.max(0, aggregate.cacheWrite - (main.cacheWrite || 0) - (sub.cacheWrite || 0)),
    cacheRead: Math.max(0, aggregate.cacheRead - (main.cacheRead || 0) - (sub.cacheRead || 0)),
  };
  if (missing.inputTokens + missing.outputTokens + missing.cacheWrite + missing.cacheRead === 0) return;
  const providerId = persisted.provider || '_default_';
  const summary = persisted.provider ? providers.getProviderSummary('codex', persisted.provider) : null;
  recordRoleTokenUsage({
    sessionId: sessionName,
    role: 'main',
    providerId,
    providerName: (summary && summary.name) || (persisted.provider ? providerId : 'Default login'),
    model: effectiveSessionModel(persisted) || '',
    usage: missing,
  });
}

// ── WeChat Bridge ──
// Must come after chatSessions/chatBroadcast are declared (TDZ would crash otherwise).
wechatBridge.init({
  persistedSessions,
  chatSessions,
  savePersistedSessions,
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
  savePersistedSessions,
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
  bridge.init({ persistedSessions, chatSessions, savePersistedSessions, chatBroadcast, port: PORT });
  app.use(mount, bridge.router);
}

// ── Workspace status board ──
// Per-session live status (runtime only, never persisted). Broadcast to /ws/workspace
// subscribers grouped by directory so every agent in a directory can see the others.
// status ∈ idle | thinking | editing | running | waiting
const workspaceStatus = new Map();   // sessionId → { status, currentFile, lastActivity }
const workspaceClients = new Map();  // dirId → Set<ws>
const sessionSummaries = new Map();  // sessionId → { summary, ts } — aux-AI "最近任务" one-liner
// Hydrate the dashboard from persisted state so a restart doesn't blank every
// card. Two runtime-only Maps are lost on restart and must be rebuilt from the
// durable taskState:
//   • sessionSummaries — the "最近任务" one-liner
//   • workspaceStatus  — the card's display status. Rebuilt from the persisted
//     classifyState (D/C/W/B/E/P) so the board shows the real state immediately,
//     NOT 'idle'. Without this, D/W sessions would stay idle forever (scan skips
//     both), and C/E/B/P would show idle until the first 60s scan re-judges (C
//     falls through to W at dispatch, so it effectively idles as waiting too).
  for (const [sid, p] of persistedSessions) {
    if (!p) continue;
    if (p.summary) sessionSummaries.set(sid, { summary: p.summary, ts: p.summaryTs || Date.now() });
    if (p.type === 'aux' || p.type === 'gateway') continue;
    const cls = p.taskState && p.taskState.classifyState;
    if (cls) {
      // D → completed (terminal). C/W/B/E/P are all "not done" → waiting; the
      // scan re-judges C/B/E/P within 60s, while D/W stay as the accurate value
      // (a fell-through C persists as W, so it too rests rather than re-judging).
      const status = cls === 'D' ? 'completed' : 'waiting';
      workspaceStatus.set(sid, { status, currentFile: null, lastActivity: 0, runStartedAt: null, runEndedAt: null });
    }
  }

// ── Unified classify result parser ─────────────────────────────────────────
// Both terminal (classifyTerminalIdle) and chat (runClassifyNow/reconcile) use
// the same 3-line format: goal / phase / state. This parser normalises both and
// returns a canonical { state, goal, phase, background, error } shape.
//
// State letters (line 3):
//   D = done          → state 'completed'  (task closed; notify user)
//   C = continue      → state 'continue'   (conversation reads as keep-going; dispatcher no longer auto-injects)
//   W = wait on user  → state 'waiting'
//   B = wait on bg    → state 'waiting' + background  (terminal only; chat prompt retired B)
//   E = API error     → state 'waiting' + error (truncated reply → retry)
//   P = processing    → state 'running'    (mid-turn only; refresh label)
//   unknown           → state 'waiting'    (safe default; never falsely 'completed')
function parseClassifyResult(text) {
  // DeepSeek thinking-block guard: strip everything before the marker.
  let clean = String(text || '');
  const thinkEnd = clean.indexOf('<｜end▁of▁thinking｜>');
  if (thinkEnd !== -1) clean = clean.slice(thinkEnd + '<｜end▁of▁thinking｜>'.length);
  clean = clean.replace(/<\/?think>/g, '').replace(/^[\s\n]*/, '');

  const lines = clean.trim().split('\n').map(l => l.trim()).filter(Boolean);

  // Goal (line 1). Cap at 60 chars; strip leading labels the model may emit.
  const goal = (lines[0] || '')
    .replace(/^(第1行[:：]|目标[:：]|goal[:：]?)\s*/i, '')
    .slice(0, 60);

  // Phase (line 2). Chinese codes preferred, English synonyms tolerated.
  const phaseRaw = (lines[1] || '')
    .replace(/^(第2行[:：]|阶段[:：]|phase[:：]?)\s*/i, '')
    .trim();
  // Normalize phase: the classify prompt outputs either Chinese or English;
  // normalise to the canonical English key used by PHASE_LABELS.
  const phase = PHASE_LABELS[phaseRaw]
    ? phaseRaw                                         // already an English key
    : Object.entries(PHASE_LABELS).find(([, v]) => v === phaseRaw)?.[0]  // Chinese → key
    || PHASE_LABELS[phaseRaw.toLowerCase()]            // case-insensitive
    || Object.entries(PHASE_LABELS).find(([, v]) => v === phaseRaw.toLowerCase())?.[0]
    || null;

  // State (line 3). Single letter: D/C/W/B/E/P.
  const stateRaw = (lines[2] || '')
    .toUpperCase()
    .replace(/^(第3行[:：]|状态[:：]|state[:：]?)\s*/i, '')
    .trim();
  const first = stateRaw.slice(0, 1);

  let state, background = false, error = false;
  if (first === 'P') state = 'running';
  else if (first === 'C') state = 'continue';
  else if (first === 'W') state = 'waiting';
  else if (first === 'B') { state = 'waiting'; background = true; }
  else if (first === 'E') { state = 'waiting'; error = true; }
  else if (first === 'D') state = 'completed';
  // Unknown/unparseable → safe default: wait for user. NEVER default to
  // 'completed' — an unparseable verdict must not falsely mark a task done.
  else state = 'waiting';

  // Garbage filter for goal — block model regurgitation of system prompts,
  // classify-template phrases, API errors, and other non-task noise.
  let goalOk = goal.length >= 2 && goal.length <= 80;
  if (goalOk) {
    const _g = goal.toLowerCase();
    const _garbage =
      /api\s*error|insufficient\s*balance|自动恢复|异常中断|claude exited|status[_= ]?5\d\d|\b40[0-9]\b|\b50[0-9]\b|(<.parameter>)/i.test(_g)
      || (/\berror\b/.test(_g) && goal.length < 12)
      || /^(第[123]行|当前.*任务.*目标|任务状态分析|对话主动权|闭环任务|判断当前)/.test(goal);
    if (_garbage) goalOk = false;
  }
  const finalGoal = goalOk ? goal : '';

  return { state, goal: finalGoal, phase, background, error };
}

// ── Unified classify display map ────────────────────────────────────────────
// Single source of truth for how each classify-state LETTER (D/C/W/B/E/P)
// renders across ALL channels: classify bar, push notification, voice/TTS,
// toast, card status. Every display path MUST read from here — no inline maps.
const CLASSIFY_DISPLAY = {
  D: {  // Done — task genuinely finished (terminal)
    label: '已完成',
    pushType: 'completed', pushTitle: '完成',
    voiceText: '任务已完成', ding: 'completed',
    cardStatus: 'completed', barTint: 'completed',
  },
  C: {  // Continue — AI is continuing (display only; dispatcher no longer auto-injects)
    label: '继续中',
    pushType: null, pushTitle: null,
    voiceText: null, ding: null,
    cardStatus: 'running', barTint: 'running',
  },
  W: {  // Wait on user
    label: '等待用户',
    pushType: 'waiting', pushTitle: '等待操作',
    voiceText: '等待你的操作', ding: 'waiting',
    cardStatus: 'waiting', barTint: 'waiting',
  },
  B: {  // Wait on background task (terminal only; chat prompt no longer emits B)
    label: '后台等待',
    pushType: 'waiting', pushTitle: '等待操作',
    voiceText: '等待后台任务', ding: 'waiting',
    cardStatus: 'waiting', barTint: 'waiting',
  },
  E: {  // API error — truncated reply
    label: 'API 异常',
    pushType: 'error', pushTitle: '出现异常',
    voiceText: 'API 异常中断，等待重试中', ding: 'error',
    cardStatus: 'waiting', barTint: 'error',
  },
  P: {  // Processing — mid-turn only
    label: '处理中',
    pushType: null, pushTitle: null,
    voiceText: null, ding: null,
    cardStatus: 'running', barTint: 'running',
  },
};

// Phase labels — centralized, used by both classify-in-progress path and
// dispatchStateAction. Formerly repeated inline at L7008 and L7902.
const PHASE_LABELS = {
  planning: '规划中', implementing: '实现中', verifying: '验证中',
  wrapping: '收尾中', done: '已完成',
};

// Helpers
function classifyDisplay(cls) { return CLASSIFY_DISPLAY[cls] || CLASSIFY_DISPLAY['W']; }
function phaseLabel(ph) { return PHASE_LABELS[ph] || ''; }

// ── Unified state-action dispatcher ────────────────────────────────────────
// Every classify result flows through here. The dispatcher maps state letters
// to plugin handlers — classify only judges, this layer executes.
//
//   D → complete   (set completed, notify user, classifyState='D' → scan skips)
//   C → continue   (no auto-continue; persist as C; if turn ended → fall through to W)
//   W → waitUser   (set waiting, broadcast; classifyState='W')
//   B → retired    (chat: no idle timer, no inject, falls through to waiting broadcast)
//   E → apiError   (retry inject; classifyState='E')
//   P → running    (mid-turn refresh label; or interrupted turn → resumeInterrupted)
//
// D and W are excluded from scan — D=terminal (done), W=waiting on user (only
// new user input flips it back to P). Other states (C/B/E/P/null) are re-judged.
//
// Context object carries everything the handlers need (varies by caller):
//   { sessionName, sessionId, cs?, mon?, isTerminal?, cwd?, opts? }

// Retry fires immediately - classify itself already runs ~60s apart, so a
// delay here would just stack on top of that. Retries are uncapped: as long
// as the aux service is up (so classify can judge E), we keep nudging. When
// aux goes down, classify stops running and the retry loop stops naturally.
const API_RETRY_DELAY_MS = 0;
// RETIRED: the B idle-timer is gone (chat B is retired; terminal B never used a
// timer). _bgIdleTimers is never populated, so BG_IDLE_TIMEOUT_MS is unread and
// clearBgIdleTimer / bumpBgActivity are permanent no-ops. Kept only so their call
// sites stay valid; safe to delete wholesale in a later cleanup.
const BG_IDLE_TIMEOUT_MS = 3 * 60 * 1000; // RETIRED (unread) — was the 3-min B idle window

// Per-session state for B handler — RETIRED, never populated (0 .set call sites).
const _bgIdleTimers = new Map();    // sessionName -> { timer, lastActivity }

function clearBgIdleTimer(sessionName) {   // RETIRED no-op (_bgIdleTimers always empty)
  const s = _bgIdleTimers.get(sessionName);
  if (s) { clearTimeout(s.timer); _bgIdleTimers.delete(sessionName); }
}

function bumpBgActivity(sessionName) {     // RETIRED no-op (_bgIdleTimers always empty)
  const s = _bgIdleTimers.get(sessionName);
  if (s) s.lastActivity = Date.now();
}

// Detect an assistant message that is pure API/transport error noise (empty,
// or short and made up of error keywords). Used to prune retry churn so the
// chat history isn't polluted with [nudge, error-reply, nudge, error-reply, …]
// pairs when the upstream API is flapping.
function isPureErrorMessage(text) {
  const t = String(text || '').trim();
  if (!t) return true;                       // empty reply = the turn produced nothing usable
  if (t.length > 200) return false;          // long reply has real content even if it ends in an error
  return /api\s*error|503|connection\s*(closed|reset|refused)|overloaded|internal\s*server\s*error|the system is busy|timeout|timed?\s*out|rate\s*limit|insufficient\s*balance|authorization\s*failed|exit\s*code|nonzero/i.test(t);
}

// Remove trailing [system-injected nudge, error assistant reply] pairs from the
// chat history. Stops at the first pair that isn't of this shape, so the real
// user message and the first error reply (whose trigger is the real user msg,
// NOT a nudge) are preserved. Called before injecting the next retry nudge.
function pruneErrorTurnPairs(sessionName) {
  const history = loadChatHistory(sessionName);
  if (!Array.isArray(history) || history.length < 2) return 0;
  let removed = 0;
  while (history.length >= 2) {
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    if (last && last.role === 'assistant' && isPureErrorMessage(last.content)
        && prev && prev.role === 'user' && isSystemInjectedMsg(prev.content)) {
      history.pop();
      history.pop();
      removed++;
    } else {
      break;
    }
  }
  if (removed > 0) {
    saveChatHistory(sessionName);
    console.log(`[multicc/classify] ${sessionName} pruned ${removed} error+nudge pair(s)`);
  }
  return removed;
}

// RETIRED — 0 call sites. C/B auto-continue was removed; E-retry and
// resumeInterrupted are the only auto-recovery paths now. Body kept intact (not
// deleted) so a later cleanup can remove it together with its waitInjector deps.
function tryAutoContinue(sessionName, cs, cwd, nudge) { // RETIRED
  const p = persistedSessions.get(sessionName);
  if (!p) return false;
  if (waitInjector.hasWait(sessionName)) return false;
  return waitInjector.autoContinue(sessionName, { cwd: cwd || (cs && cs.cwd), nudge });
}

function dispatchStateAction(result, ctx) {
  const { state, goal, phase, background, error } = result;
  const { sessionName, sessionId, cs, isTerminal } = ctx;

  // ── Classify history (persisted, last 7 days) ────────────────────────
  const now = Date.now();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const entry = { at: now, goal: goal || '', phase: phase || '', state, error: !!error };
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

  // ── In-flight guard: turn 还在跑(isStreaming)时的 reclassify（通常来自 scan）只作观察 ──
  // 判定基于不完整回复，可能误判；inject/autoContinue/push 会干扰当前 turn。纯观察：
  // 不改 classifyState、不触发副作用，直接返回。turn 结束 classifyTurnEnd(isStreaming=false)
  // 会用完整回复重新判定并执行动作。
  // 【关键】不要在这里写 classifyState：那既是"副作用"（本 guard 声称要避免的），又会污染
  // scan 的跳过逻辑（L7407 读 classifyState）——曾导致误判的 W/C 落入内存后被 scan 反复重判。
  // stuck-isStreaming（进程挂起但 isStreaming 没复位）由 scan 的看门狗兜底，不在此处理。
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
    // (2) P but no turn in flight — the CLI process / event stream already ended
    // while classify still reads the reply as incomplete. That's an unknown
    // interruption (network drop, crashed CLI, truncated stream), NOT real
    // "still processing". Recover it like a fault (E-class): resume regardless of
    // the autoContinue toggle, capped to avoid an infinite drop-loop.
    if (waitInjector.resumeInterrupted(sessionName)) {
      console.log(`[multicc/classify] ${sessionName} P + no turn in flight → 未知中断, resume`);
      return;
    }
    // resume capped / explicit wait pending -> fall through to the waiting broadcast.
  }

  if (state === 'completed') {
    // D — task genuinely finished. This is the ONLY terminal state.
    clearBgIdleTimer(sessionName);
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
    // C — the conversation reads as "keep going". We deliberately DO NOT auto-inject
    // a 继续 here anymore. Auto-recovery is reserved for FAULTS only: E (API error,
    // below) and 非正常中断 (interrupted turn — see finalizeStreamingTurn's
    // !_resultSaved recovery + the P/no-turn-in-flight resume above). A turn that
    // ended NORMALLY (fired its `result` event) is never auto-pushed, even if the
    // task isn't finished — a deliberate pause (assistant asked the user something)
    // must reach the user. The old uncapped C-autopush was the runaway-loop bug:
    // it re-injected "继续" every scan and fed on its own injected messages.
    setTaskState(sessionName, { classifyState: 'C', endedAt: Date.now() }, { save: false });
    // Mid-stream: a turn IS in flight and will carry the continuation itself — just
    // refresh the in-progress label, don't finalize.
    if (cs && cs.isStreaming) {
      const ph = phaseLabel(phase);
      const label = finalGoal ? `处理中：${finalGoal}${ph ? ' · ' + ph : ''}` : `处理中${ph ? '：' + ph : '…'}`;
      emitRunningNotify(sessionName, label);
      return;
    }
    // Turn ended: no auto-continue. Fall through to the waiting broadcast — the
    // session rests as W (user is in charge; scan skips W, so no re-judge churn).
  }

  // ── C(no auto-continue) / W / B / E all → waiting (user-facing) ─────────

  // E: API error -> inject retry nudge. Uncapped - keeps retrying as long
  // as aux (classify) is healthy. Before injecting, prune trailing
  // [nudge, error-reply] pairs so the history doesn't fill with retry churn.
  if (error) {
    clearBgIdleTimer(sessionName);
    pruneErrorTurnPairs(sessionName);
    const nudge = '刚才因 API 异常中断，回答可能不完整，请从中断处继续。';
    console.log(`[multicc/classify] ${sessionName} API error -> retry (uncapped)`);
    // injectSystemMsg (NOT safeInject): it prepends SYS_PREFIX, which is what
    // pruneErrorTurnPairs keys on to collapse retry churn — a bare safeInject
    // here left every [nudge, error] pair in the history (prune never matched).
    waitInjector.injectSystemMsg(sessionName, nudge, API_RETRY_DELAY_MS);
  }

  // B (background wait) is RETIRED. Background tasks now keep the main turn
  // streaming (isStreaming stays true while Monitor / run_in_background run), and a
  // genuinely async task resumes via the message mechanism (bg-completion injection
  // / wait-injector callback+poll) — a real event, not a timer guess. So classify no
  // longer emits B (removed from the prompt) and there is no B-autopush / 3-min idle
  // "继续" timer. If a stale B somehow arrives, it just falls through to the waiting
  // broadcast below — no injection.

  // Common waiting-state broadcast — driven by classifyState letter.
  // A 'continue' reaching here = C is deliberately NOT auto-driven anymore.
  // (The old uncapped C-autopush was a runaway loop; now all C ends up here,
  // no injection.) Persist it as W, not C. As W it's scan-skipped and the UI
  // correctly shows "waiting" — the session genuinely waits for the user.
  const cls = error ? 'E' : background ? 'B' : 'W';
  const disp = classifyDisplay(cls);
  const pushType = disp.pushType || 'waiting';  // C/P have null pushType → default 'waiting'
  const waitMsg = finalGoal ? `等待：${finalGoal}` : (error ? 'API 异常，等待重试…' : '等待交互');
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
  // Persist the accurate letter for observability (E/B, or W incl. a fell-through C).
  // scan re-judges C/B/E/P but skips D/W — a fell-through C is now W, so it rests.
  setTaskState(sessionName, { classifyState: cls, endedAt: Date.now() }, { save: false });
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
//     lastTurnEndedAt, classifyState, pendingDispatches, classifyHistory }
//   classifyState ∈ D | C | W | B | E | P | null  (D=done; B=terminal only; null=never classified)
//   classifyHistory: [{ at: ms, goal, phase, state, error }] — last 7 days
const TASK_STATE_DEFAULTS = {
  goal: '', phase: 'idle', startedAt: null, endedAt: null,
  lastSummary: '', lastSummaryAt: null, lastTurnEndedAt: null,
  classifyState: null, pendingDispatches: [],
  classifyHistory: [],
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
  if (opts.save !== false) savePersistedSessions();
  // Push the aux classify result to the chat client so it can show what the
  // assistant currently thinks this session's goal/phase is. Cheap; only fires
  // when a chat WS is connected for this session.
  const classifyPayload = {
    type: 'task_state',
    goal: next.goal || '',
    phase: next.phase || 'idle',
    classifyState: next.classifyState || null,
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

const AUX_HEALTH_PROBE_INTERVAL_MS = 5 * 60 * 1000;  // ④: probe aux recovery while unhealthy

// ④ Degraded-mode recovery probe: while aux is unhealthy, every 5 min run a
// trivial aux task. Any success → recordSuccess → unhealthy clears → normal
// summary/reconcile/resume resumes. Cheap (a 1-token reply) and self-limiting
// (only runs while unhealthy; no-op when healthy).
// ── Network health hold (⑥A) ────────────────────────────────────────────────
// When the upstream model API becomes unreliable (503, timeout, 402, etc.),
// starting new turns only wastes credits and corrupts task state. Instead we
// freeze all new-turn initiation (dispatch, auto-continue, wait-inject, nudge,
// reconcile-resume) and wait for the API to recover. Held sessions' turn
// context is preserved; on recovery each gets a gentle resume prompt so no
// task is lost — just delayed until the API is back.
//
// Scope: "upstream API" means the model API the CLI / aux talks to. Network
// errors from the CLI process (exit code 1 with stderr about API failures) and
// from the aux queue (recordFail) are unified here. This does NOT cover the
// server's own network outage (⑥B) — that's a separate, harder problem.

const NETWORK_UNHEALTHY_THRESHOLD = 3;         // consecutive API failures before hold
const NETWORK_PROBE_INTERVAL_MS = 30 * 1000;   // how often we test recovery
const NETWORK_RECOVERY_PROBE_TIMEOUT_MS = 15000;

const networkHealth = {
  unhealthy: false,
  sinceAt: null,
  consecutiveFails: 0,
  lastFailAt: null,
  lastFailMsg: '',
  heldSessions: new Map(),   // sessionId → { goal, heldAt, reason }
  probeTimer: null,
};

// Call this from any code path that sees an upstream-API-style failure.
// Aggregates across aux + main sessions; once >=THRESHOLD, triggers hold.
function recordApiError(msg) {
  const h = networkHealth;
  h.consecutiveFails = (h.consecutiveFails || 0) + 1;
  h.lastFailAt = Date.now();
  h.lastFailMsg = String(msg || '').slice(0, 200);
  if (h.consecutiveFails >= NETWORK_UNHEALTHY_THRESHOLD && !h.unhealthy) {
    h.unhealthy = true;
    h.sinceAt = Date.now();
    console.error(`[multicc/net] UNHEALTHY after ${h.consecutiveFails} consecutive API errors: ${h.lastFailMsg}`);
    // Broadcast to frontend so the dashboard can show a banner (reuse aux_health
    // channel or add a dedicated one — for now log + console).
    startNetworkProbe();
  }
}

// Clear the unhealthy flag. Called when a probe succeeds.
function recordApiSuccess() {
  const h = networkHealth;
  if (h.consecutiveFails || h.unhealthy) {
    h.consecutiveFails = 0;
    if (h.unhealthy) {
      h.unhealthy = false;
      const heldCount = h.heldSessions.size;
      console.log(`[multicc/net] recovered — resuming ${heldCount} held session(s)`);
      // 【顺序不变量·勿颠倒】unhealthy 必须先置 false（上一行）再 resume。恢复注入走
      // safeInject → runChatTurn({originContinue:true})，而 runChatTurn 入口的 degrade防线
      // chokepoint 会拦 `originContinue && isNetworkUnhealthy()`——若先把 resume 挪到清标记
      // 之前，恢复注入会被自己的防线拦下，held 会话永远接续不上（死锁）。
      resumeHeldSessions();
      stopNetworkProbe();
    }
  }
}

// Whether new turns should be blocked right now.
function isNetworkUnhealthy() { return networkHealth.unhealthy; }

// Hold a session: mark it as waiting for API recovery. Its in-progress turn
// (if any) can finish naturally; we just prevent NEW turns from starting.
// Callers should check isNetworkUnhealthy() BEFORE calling this — this is the
// "actually put it on hold" step.
// Decide what pendingText to stash for a held session. Real data (dispatch result
// / bg-completion via safeInject) has NO SYS_PREFIX; the classify E-retry nudge
// (injectSystemMsg) DOES. A later nudge must NOT overwrite already-stashed real data
// - the real payload is what resumeHeldSessions must replay. (A new real payload
// still wins over a prior nudge; nudges overwrite nudges.)
function mergeHeldPendingText(pendingText, prior) {
  const SP = waitInjector.SYS_PREFIX;
  const newIsNudge = typeof pendingText === 'string' && pendingText.startsWith(SP);
  const priorIsReal = prior && prior.pendingText != null && !String(prior.pendingText).startsWith(SP);
  if (newIsNudge && priorIsReal) return prior.pendingText;
  return pendingText != null ? pendingText : (prior ? prior.pendingText : null);
}
function holdSession(sessionId, reason, pendingText) {
  if (!networkHealth.unhealthy) return;
  const p = persistedSessions.get(sessionId);
  if (!p) return;
  const ts = getTaskState(p);
  const prior = networkHealth.heldSessions.get(sessionId);
  // Preserve the original heldAt across re-holds. pendingText = the suppressed
  // inject's text, stashed so resumeHeldSessions can replay real data (dispatch
  // result / bg-completion) that would otherwise be lost when the chokepoint drops
  // the turn. scan-skip-held keeps classify nudges from re-holding an already-held
  // session, so a later hold usually carries NEW real data — let it overwrite so
  // the most recent suppressed payload is what resume replays.
  networkHealth.heldSessions.set(sessionId, {
    goal: ts.goal || (typeof p.summary === 'string' ? p.summary.slice(0, 40) : ''),
    heldAt: prior ? prior.heldAt : Date.now(),
    reason: reason || (prior ? prior.reason : 'API 异常'),
    pendingText: mergeHeldPendingText(pendingText, prior),
  });
  // One-shot notification: only when freshly held, so a long outage with later
  // real-data re-holds doesn't spam "已暂挂" on every hold.
  if (!prior) {
    const dirId = p.dirId;
    const note = `上游 API 异常，任务「${ts.goal || '未命名'}」已暂挂，恢复后自动接续`;
    if (dirId) workspaceBroadcast(dirId, { type: 'notify', sessionId, state: 'waiting', message: note });
  }
}

// Resume all held sessions with a gentle prompt. Called when the API recovers.
async function resumeHeldSessions() {
  const held = new Map(networkHealth.heldSessions);
  networkHealth.heldSessions.clear();
  let i = 0;
  for (const [sid, info] of held) {
    // Leak guard: drop sessions deleted while held (heldSessions is never
    // .delete()'d on session removal — see DELETE /api/sessions/:id).
    if (!persistedSessions.has(sid)) { console.log(`[multicc/net] skip resumed session ${sid}: gone`); i++; continue; }
    // If a real payload (dispatch result / bg-completion) was suppressed while held,
    // replay THAT so the model gets the actual data it was blocked on — otherwise the
    // generic recovery nudge. Prefixed so the model knows the API recovered either way.
    const recoveryNote = `上游 API 已恢复。之前因 API 异常暂挂的任务「${info.goal || '未命名'}」现在可以继续了。`;
    const resumeMsg = info.pendingText
      ? `${recoveryNote}（含暂挂期间被暂存的真实数据，请据此继续）\n${info.pendingText}`
      : `${recoveryNote}请确认当前状态并继续执行。`;
    try { waitInjector.safeInject(sid, resumeMsg); } catch (_) {}
    console.log(`[multicc/net] resumed session ${sid}: ${info.goal}`);
    // Stagger: don't fire N concurrent turns at the freshly-recovered API
    // (thundering herd → 3 fails → re-hold → oscillation).
    if (++i < held.size) await new Promise(r => setTimeout(r, 2000));
  }
}

// Periodically probe upstream API health via a trivial aux request.
function startNetworkProbe() {
  stopNetworkProbe();
  const probe = () => {
    if (!networkHealth.unhealthy) return;
    // Dedup + backpressure: skip if a network_probe is already queued or in-flight.
    // (Without this, probes pile up at 1/30s while each one times out.)
    if (auxQueue.queue.some(t => t.type === 'network_probe') ||
        (auxQueue.currentTask && auxQueue.currentTask.type === 'network_probe')) return;
    auxQueue.enqueue({
      type: 'network_probe',
      prompt: '回复 ok',
      meta: { timeout: NETWORK_RECOVERY_PROBE_TIMEOUT_MS },
    }).then(r => {
      if (r && !r.cancelled && r.text && /ok/i.test(r.text)) {
        console.log('[multicc/net] probe OK — API recovered');
        recordApiSuccess();
      }
    }).catch(() => { /* still down — recordApiError already called in drain */ });
  };
  networkHealth.probeTimer = setInterval(probe, NETWORK_PROBE_INTERVAL_MS);
  probe(); // run one immediately
}
function stopNetworkProbe() {
  if (networkHealth.probeTimer) { clearInterval(networkHealth.probeTimer); networkHealth.probeTimer = null; }
}

function auxHealthProbe() {
  if (!auxQueue.isUnhealthy()) return;
  auxQueue.enqueue({
    type: 'health_probe',
    prompt: '回复一个字：ok',
    meta: { probe: true },
  }).then(result => {
    if (result && !result.cancelled) auxQueue.recordSuccess();
  }).catch(() => { /* recordFail already called inside drain */ });
}

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

// Shared classify-result handler. Routes by isStreaming: while a turn is still
// streaming, only refresh the in-progress goal/phase labels (a mid-stream state
// verdict is unreliable and would race the turn-end classify); once the turn is
// over, finalize via dispatchStateAction. Used by BOTH runClassifyNow (turn-end)
// and scanAndReclassify (periodic) so the two enqueue paths can't diverge in how
// they route a result. Previously only runClassifyNow had the isStreaming guard,
// so scan had to skip ALL streaming sessions - including unnamed ones whose goal
// it could safely have extracted - starving classify on long/hung turns.
function applyClassifyResult(cs, sessionName, sessionId, res, { cwd, source } = {}) {
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
    const label = goal ? `处理中：${goal}${ph ? ' · ' + ph : ''}` : `处理中${ph ? '：' + ph : '…'}`;
    emitRunningNotify(sessionName, label);
    console.log(`[${source}] Classify in-progress for ${sessionName}: goal="${goal}" phase=${cs.currentTask?.phase || '?'}`);
    return;
  }
  // Turn over - dispatch state action.
  dispatchStateAction(res, { sessionName, sessionId, cs, isTerminal: false, cwd });
  console.log(`[${source}] Classify RESULT for ${sessionName}: state=${res.state} goal="${res.goal}" phase=${res.phase || '?'}${res.error ? ' (API error)' : ''}`);
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
    if (networkHealth.heldSessions.has(sid)) {
      note(sid, ts.classifyState, 'skipped-held', 'held by degrade防线 (API recovery)');
      continue;
    }

    // A session with a turn in flight: classifyTurnEnd judges it at turn end,
    // and a mid-stream STATE verdict is unreliable + races the turn-end classify.
    // So a streaming session whose goal is ALREADY known has no useful work for
    // scan -> skip (turn-end owns the state verdict). BUT a streaming session
    // with an UNRESOLVED goal (新任务/empty) is the one streaming case scan MUST
    // handle: applyClassifyResult routes its result to the in-progress (goal-only)
    // path, extracting the goal from the user message + partial reply so the card
    // shows the real task name instead of "新任务" while the turn runs. Without
    // this, a long/hung turn (e.g. upstream API hang) left a new task unnamed until
    // turn-end or the E-state error path fired - classify was starved for the turn.
    // Exception: a genuinely stuck stream (process hung, isStreaming never reset)
    // would loop forever -> watchdog force-resets it after STUCK_STREAM_MS of
    // stream silence, letting the next tick recover it through the normal
    // !isStreaming path (P + no turn -> resumeInterrupted).
    const liveCs = chatSessions.get(sid);
    if (liveCs && liveCs.isStreaming) {
      // Math.max, NOT ||: lastStreamAt persists on cs across turns, so a fresh
      // turn (turnStartedAt just now) whose stream hasn't emitted yet would else
      // inherit the PRIOR turn's stale lastStreamAt and get force-killed on tick 1.
      const lastStream = Math.max(liveCs.lastStreamAt || 0, liveCs.turnStartedAt || 0);
      if (lastStream && (now - lastStream) > STUCK_STREAM_MS) {
        note(sid, ts.classifyState, 'stuck-reset', `${((now - lastStream) / 1000).toFixed(0)}s stream silence → force-reset isStreaming`);
        console.log(`[multicc/scan] ${sid} stuck-isStreaming: ${((now - lastStream) / 1000).toFixed(0)}s 无流事件 → 强制复位 isStreaming，本轮按 !isStreaming 重判`);
        liveCs.isStreaming = false;
        // fall through to reclassify now via the normal (non-streaming) path below
      } else if (isGoalResolved(ts.goal)) {
        // Streaming AND goal already known: scan has no useful work (state verdict
        // waits for turn-end; re-judging would only re-confirm the same goal).
        note(sid, ts.classifyState, 'skipped-streaming', 'isStreaming + goal already resolved');
        continue;
      }
      // else: streaming but goal UNRESOLVED (新任务/empty) -> fall through and
      // enqueue. The result routes through applyClassifyResult's in-progress
      // (goal-only) path, so the card shows the real task name instead of "新任务"
      // while the turn runs - closing the classify starvation on long/hung turns.
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
app.get('/api/scan/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, SCAN_HISTORY_MAX_PASSES);
  res.json({ seq: scanHistory.seq, kept: scanHistory.passes.length, passes: scanHistory.passes.slice(0, limit) });
});

// Store an aux-AI task summary for a session and push it to the workspace board.
function setSessionSummary(sessionId, summary) {
  if (!summary) return;
  const persisted = persistedSessions.get(sessionId);
  if (!persisted || persisted.type === 'aux' || persisted.type === 'gateway') return;
  const ts = Date.now();
  sessionSummaries.set(sessionId, { summary, ts });
  // Persist the one-liner (legacy field, still used by the dashboard tooltip)
  // and the full taskState snapshot for restart reconcile.
  const tsChanged = persisted.summary !== summary;
  if (tsChanged) persisted.summary = summary;
  if (tsChanged || persisted.taskState?.lastSummary !== summary) {
    setTaskState(sessionId, { lastSummary: summary, lastSummaryAt: ts }, { save: false });
    savePersistedSessions();
  }
  workspaceBroadcast(persisted.dirId, { type: 'summary', sessionId, summary, ts });
}

const SESSION_MEMORY_MAX = 8000;  // hard cap: total text length across all memory entries
const MEMORY_REVIEW_INTERVAL = Math.max(0, parseInt(process.env.MULTICC_MEMORY_REVIEW_INTERVAL || '10', 10) || 0);
const MEMORY_REVIEW_MAX_MESSAGES = 30;
const _memoryReviewInFlight = new Map();   // sessionId → Promise
const _memoryDistillPending = new Map();   // sessionId → Promise (Clear gate)

// Memory entry types
// decision=确认的技术决策, gotcha=踩过的坑/正确做法, preference=用户偏好/约束, todo=待跟进事项, fact=关键事实
const MEMORY_TYPES = ['decision', 'gotcha', 'preference', 'todo', 'fact'];

// Priority for eviction when total text exceeds SESSION_MEMORY_MAX.
// Lower index = evicted first (most ephemeral). todo goes first, preference survives longest.
const MEMORY_EVICTION_ORDER = ['todo', 'fact', 'gotcha', 'decision', 'preference'];

// Normalize persisted.memory into an entries array, regardless of whether it
// is stored in the new array format or the legacy string format. Returns []
// when there is no memory.
function getMemoryEntries(persisted) {
  const m = persisted?.memory;
  if (!m) return [];
  if (Array.isArray(m)) return m.filter(e => e && typeof e.text === 'string' && e.text.trim());
  if (typeof m === 'string' && m.trim()) return [{ type: 'fact', text: m.trim(), ts: 0 }];
  return [];
}

function _memoryEvictionRank(type) {
  const i = MEMORY_EVICTION_ORDER.indexOf(type);
  return i === -1 ? MEMORY_EVICTION_ORDER.length : i;  // unknown types evicted first
}

function _trimMemoryEntries(entries) {
  let totalLen = entries.reduce((s, e) => s + (e.text || '').length, 0);
  if (totalLen <= SESSION_MEMORY_MAX) return entries;
  // Sort for eviction: eviction-rank asc (todo first), then ts asc (oldest first within same rank).
  const sorted = [...entries].sort((a, b) => {
    const r = _memoryEvictionRank(a.type) - _memoryEvictionRank(b.type);
    if (r !== 0) return r;
    return (a.ts || 0) - (b.ts || 0);
  });
  let cut = 0;
  while (cut < sorted.length && totalLen > SESSION_MEMORY_MAX) {
    totalLen -= (sorted[cut].text || '').length;
    cut++;
  }
  return sorted.slice(cut);  // survivors (order not preserved — caller doesn't rely on it)
}

// Simple similarity for dedup: Jaccard on word sets, fallback to substring check for short strings.
function _memorySimilarity(a, b) {
  const ta = (a || '').trim().toLowerCase();
  const tb = (b || '').trim().toLowerCase();
  if (!ta || !tb) return 0;
  if (ta === tb) return 1;
  if (ta.length < 40 || tb.length < 40) {
    if (ta.includes(tb) || tb.includes(ta)) return 0.7;
    return 0;
  }
  const wa = new Set(ta.split(/[\s,，。；;:：、（）()\[\]]+/).filter(Boolean));
  const wb = new Set(tb.split(/[\s,，。；;:：、（）()\[\]]+/).filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);  // Jaccard
}

function _mergeMemoryEntries(prior, fresh) {
  // For each fresh entry, find a similar prior entry (similarity > 0.6);
  // replace the prior with the fresh (assumed more up-to-date); otherwise append.
  const out = [...prior];
  for (const f of fresh) {
    let replaced = false;
    for (let i = 0; i < out.length; i++) {
      if (_memorySimilarity(f.text, out[i].text) > 0.6) {
        out[i] = f;
        replaced = true;
        break;
      }
    }
    if (!replaced) out.push(f);
  }
  return out;
}

function _parseMemoryEntries(raw) {
  let clean = String(raw || '').trim();
  if (!clean || clean === '-' || clean === '—') return [];
  clean = clean.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  if (!clean || clean === '-' || clean === '—') return [];
  const fresh = [];
  for (const line of clean.split('\n')) {
    const text = line.trim();
    if (!text || text === '-' || text === '—') continue;
    const match = text.match(/^\[(\w+)\]\s*(.*)$/);
    let type = match ? match[1].toLowerCase() : 'fact';
    const entryText = (match ? match[2] : text).trim();
    if (!MEMORY_TYPES.includes(type)) type = 'fact';
    if (entryText && !scanMemoryContent(entryText)) {
      fresh.push({ type, text: entryText, ts: Date.now() });
    }
  }
  return fresh;
}

function _persistMergedMemory(sessionId, fresh, eventDetail) {
  if (!fresh.length) return { updated: false, entries: getMemoryEntries(persistedSessions.get(sessionId)) };
  const persisted = persistedSessions.get(sessionId);
  if (!persisted) return { updated: false, entries: [] };
  let merged = _mergeMemoryEntries(getMemoryEntries(persisted), fresh);
  merged = _trimMemoryEntries(merged);
  persisted.memory = merged;
  writeAutoMemoryFile(persisted, merged);
  savePersistedSessions();
  const totalLen = merged.reduce((sum, entry) => sum + (entry.text || '').length, 0);
  appendEvent(persisted.dirId, 'memory_updated', `${eventDetail}（${merged.length} 条，${totalLen} 字）`, sessionId);
  workspaceBroadcast(persisted.dirId, { type: 'memory', sessionId });
  return { updated: true, entries: merged, totalLen };
}

function _trackPendingMemoryDistill(sessionId, promise) {
  const tracked = Promise.resolve(promise)
    .catch(error => {
      console.warn(`[multicc/memory] pending distill ${sessionId} failed: ${error.message}`);
      return { updated: false, error: error.message };
    })
    .finally(() => {
      if (_memoryDistillPending.get(sessionId) === tracked) _memoryDistillPending.delete(sessionId);
    });
  _memoryDistillPending.set(sessionId, tracked);
  return tracked;
}

// Distill a chunk of about-to-be-discarded chat history into the session's
// long-lived memory. We deliberately keep ONLY key problems and how they were
// solved (decisions, fixes, gotchas, user preferences, unfinished threads) — not
// ordinary task narration. Runs on the aux AI, merges incrementally with the
// existing memory (de-dupes + compresses when near the cap), and is best-effort:
// any failure leaves history-clearing unaffected. Clear awaits this through a
// first-turn gate; rolling-window trimming intentionally runs it in background.
function distillHistoryIntoMemory(sessionId, messages) {
  const persisted = persistedSessions.get(sessionId);
  if (!persisted || persisted.type === 'aux' || persisted.type === 'gateway') return Promise.resolve({ updated: false });
  const text = (messages || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content.trim().slice(0, 2000)}`)
    .join('\n');
  if (text.length < 40) return Promise.resolve({ updated: false });  // nothing worth distilling
  const prior = getMemoryEntries(persisted);
  const prompt =
`你是会话记忆提炼器。下面是一段即将被清理/丢弃的对话。请只提炼出「值得长期记住的关键信息」，每条一行，格式为 \`[类型] 内容\`。

类型必须是以下 5 种之一：
- [decision] 确认过的技术决策或方案选择
- [gotcha] 踩过的坑、错误做法与对应的正确做法
- [preference] 用户明确表达的偏好或约束
- [todo] 尚未完成、需后续跟进的事项
- [fact] 关键的技术事实或项目状态

忽略普通的任务过程、寒暄、可重新获得的中间步骤。每条内容精炼（不超过 100 字），动词或名词开头。若这段对话没有任何值得长期记住的，只输出一个减号 "-"。

${prior.length ? `【已有的会话记忆条目（请与新内容合并去重：语义重复的条目只保留信息更完整的一条）】\n${prior.map(e => `[${e.type}] ${e.text}`).join('\n')}\n\n` : ''}【待提炼的对话】
${text.slice(0, 12000)}

请直接输出合并后的所有记忆条目（每行一条），不要解释、不要加标题。`;
  if (auxQueue.isUnhealthy()) return Promise.resolve({ updated: false, skipped: 'aux unhealthy' });
  return auxQueue.enqueue({ type: 'memory_distill', prompt, meta: { sessionId } })
    .then(result => {
      const committed = _persistMergedMemory(sessionId, _parseMemoryEntries(result && result.text), '已提炼会话记忆');
      if (committed.updated) {
        console.log(`[multicc/memory] distilled ${sessionId}: memory now ${committed.entries.length} entries / ${committed.totalLen} chars`);
      }
      return committed;
    })
    .catch(error => {
      console.warn(`[multicc/memory] distill ${sessionId} failed: ${error.message}`);
      return { updated: false, error: error.message };
    });
}

function _memoryReviewMessages(sessionId, persisted) {
  const history = loadChatHistory(sessionId);
  let start = 0;
  if (persisted.memoryReviewCursorId) {
    const cursor = history.findIndex(message => message && message.id === persisted.memoryReviewCursorId);
    if (cursor >= 0) start = cursor + 1;
  }
  return history.slice(start)
    .filter(message => message && (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string' && message.content.trim())
    .slice(-MEMORY_REVIEW_MAX_MESSAGES);
}

function reviewConversationIntoMemory(sessionId) {
  if (_memoryReviewInFlight.has(sessionId)) return _memoryReviewInFlight.get(sessionId);
  const persisted = persistedSessions.get(sessionId);
  if (!persisted || persisted.type === 'aux' || persisted.type === 'gateway') return Promise.resolve({ updated: false });
  if (auxQueue.isUnhealthy()) return Promise.resolve({ updated: false, skipped: 'aux unhealthy' });
  const messages = _memoryReviewMessages(sessionId, persisted);
  if (!messages.length) return Promise.resolve({ updated: false });
  const lastMessageId = messages[messages.length - 1].id || null;
  const transcript = messages.map(message =>
    `${message.role === 'user' ? '用户' : '助手'}: ${message.content.trim().slice(0, 1800)}`
  ).join('\n');
  const prompt =
`你是 MultiCC 的周期记忆复盘器。审查下面最近一段对话，只输出真正值得跨后续对话保留的稳定事实，每条一行，格式为 [类型] 内容。

允许类型：
- [preference] 用户明确且可复用的偏好、沟通方式、工作约束
- [gotcha] 反复可能踩到的环境或工具陷阱，以及正确做法
- [decision] 会长期影响后续工作的已确认方案或约定
- [fact] 稳定的项目/环境事实

不要保存任务进度、已完成工作日志、临时路径、一次性 TODO、普通过程或可轻易重新发现的知识。内容应是陈述性事实，不要写成命令。没有值得保存的内容时只输出 "-"。

【最近对话】
${transcript.slice(0, 12000)}

直接输出条目，不要标题或解释。`;

  const task = auxQueue.enqueue({ type: 'memory_review', prompt, meta: { sessionId } })
    .then(result => {
      const committed = _persistMergedMemory(sessionId, _parseMemoryEntries(result && result.text), '周期记忆复盘');
      const current = persistedSessions.get(sessionId);
      if (current && lastMessageId) {
        current.memoryReviewCursorId = lastMessageId;
        current.memoryReviewAt = Date.now();
        savePersistedSessions();
      }
      return committed;
    })
    .catch(error => {
      const current = persistedSessions.get(sessionId);
      if (current) {
        // Retry promptly on the next completed turn instead of waiting another
        // full interval after a transient auxiliary-provider failure.
        current.memoryReviewTurnCount = Math.max(0, MEMORY_REVIEW_INTERVAL - 1);
        savePersistedSessions();
      }
      console.warn(`[multicc/memory] periodic review ${sessionId} failed: ${error.message}`);
      return { updated: false, error: error.message };
    })
    .finally(() => _memoryReviewInFlight.delete(sessionId));
  _memoryReviewInFlight.set(sessionId, task);
  return task;
}

function maybeSchedulePeriodicMemoryReview(sessionId) {
  if (!MEMORY_REVIEW_INTERVAL) return;
  const persisted = persistedSessions.get(sessionId);
  if (!persisted || persisted.type === 'aux' || persisted.type === 'gateway'
      || (persisted.kind && persisted.kind !== 'chat')) return;
  persisted.memoryReviewTurnCount = Math.max(0, Number(persisted.memoryReviewTurnCount) || 0) + 1;
  if (persisted.memoryReviewTurnCount < MEMORY_REVIEW_INTERVAL) {
    savePersistedSessions();
    return;
  }
  if (auxQueue.isUnhealthy()) {
    // Preserve a near-due counter so a transient provider outage retries after
    // the next completed turn rather than silently postponing ten more turns.
    persisted.memoryReviewTurnCount = Math.max(0, MEMORY_REVIEW_INTERVAL - 1);
    savePersistedSessions();
    return;
  }
  persisted.memoryReviewTurnCount = 0;
  savePersistedSessions();
  reviewConversationIntoMemory(sessionId);
}

function workspaceBroadcast(dirId, payload) {
  const set = workspaceClients.get(dirId);
  if (!set) return;
  broadcastTo(set, payload);
}

// ── Global meta event bus (Happier-parity: a voice/meta assistant that monitors
//    ALL sessions needs a single subscription point spanning every directory).
//    Every workspace event is also fanned out here with the dirId stamped on, so
//    a /ws/meta subscriber sees the whole fleet's status/message traffic in one
//    stream. The voice assistant and any future cross-session UI subscribes here.
const metaClients = new Set();   // Set<ws>
function metaBroadcast(payload) {
  if (metaClients.size === 0) return;
  broadcastTo(metaClients, payload);
}
// Wrap workspaceBroadcast so meta subscribers see every workspace event too,
// without touching each individual call site. The dirId is preserved so a meta
// client can still scope by directory when it wants to.
const _origWorkspaceBroadcast = workspaceBroadcast;
workspaceBroadcast = function (dirId, payload) {
  _origWorkspaceBroadcast(dirId, payload);
  metaBroadcast({ ...payload, dirId });
};

// Statuses where the agent is actively working a turn (the run-time clock ticks).
// Everything else — completed / idle / error / waiting — is a resting state that
// freezes the clock.
function isRunningStatus(s) { return s === 'thinking' || s === 'editing' || s === 'running'; }

// Update a session's live status and push the delta to workspace subscribers.
function setSessionStatus(sessionId, patch) {
  const persisted = persistedSessions.get(sessionId);
  if (!persisted || persisted.type === 'aux') return;
  const prev = workspaceStatus.get(sessionId) || { status: 'idle', currentFile: null, lastActivity: 0, runStartedAt: null, runEndedAt: null };
  const now = Date.now();
  const nextStatus = patch.status !== undefined ? patch.status : prev.status;
  // Run-time tracking: stamp runStartedAt when a turn begins (resting → working),
  // freeze runEndedAt when it ends (working → resting). Mid-turn transitions
  // between working states (thinking↔editing↔running) keep the original start.
  let runStartedAt = prev.runStartedAt || null;
  let runEndedAt = prev.runEndedAt !== undefined ? prev.runEndedAt : null;
  const wasRunning = !!prev.runStartedAt && !prev.runEndedAt;
  if (isRunningStatus(nextStatus)) {
    if (!wasRunning) { runStartedAt = now; runEndedAt = null; }  // a new run segment begins
  } else if (wasRunning) {
    runEndedAt = now;  // the run just ended at a resting state — freeze the clock
  }
  // Dispatch idle fix: if this session has dispatched workers still awaiting
  // 回流 (pendingDispatches), don't let it rest at idle/completed — show
  // 'waiting' so the board reflects "等 worker 回报" instead of a misleading idle.
  let effectiveStatus = nextStatus;
  if (!isRunningStatus(nextStatus) && nextStatus !== 'waiting') {
    const cs = chatSessions.get(sessionId);
    const pending = cs?.currentTask?.pendingDispatches;
    if (pending && pending.length > 0) effectiveStatus = 'waiting';
  }
  const next = {
    status: effectiveStatus,
    currentFile: patch.currentFile !== undefined ? patch.currentFile : prev.currentFile,
    lastActivity: now,
    runStartedAt, runEndedAt,
  };
  workspaceStatus.set(sessionId, next);
  // Only broadcast when the status or current file actually changed — callers may
  // fire this on every output chunk / text delta.
  if (next.status === prev.status && next.currentFile === prev.currentFile) return;
  workspaceBroadcast(persisted.dirId, {
    type: 'status', sessionId,
    status: next.status, currentFile: next.currentFile, lastActivity: next.lastActivity,
    runStartedAt: next.runStartedAt, runEndedAt: next.runEndedAt,
    mergeState: mergeStateCached(directories.get(persisted.dirId), persisted),
  });
}

function workspaceSnapshot(dirId) {
  const out = [];
  for (const s of persistedSessions.values()) {
    if (s.dirId !== dirId || s.type === 'aux' || s.type === 'gateway') continue;
    const st = workspaceStatus.get(s.id) || { status: 'idle', currentFile: null, lastActivity: 0, runStartedAt: null, runEndedAt: null };
    const active = sessions.get(s.id);
    const chat = chatSessions.get(s.id);
    const sum = sessionSummaries.get(s.id) || null;
    const ts = getTaskState(s);
    out.push({
      id: s.id, label: s.label || null, cli: s.cli || 'claude', kind: s.kind || 'terminal',
      branch: s.branch || null, invalid: invalidSessions.get(s.id) || null,
      status: st.status, currentFile: st.currentFile, lastActivity: st.lastActivity,
      runStartedAt: st.runStartedAt || null, runEndedAt: st.runEndedAt || null,
      clients: s.kind === 'chat' ? (chat?.clients.size || 0) : (active?.clients.size || 0),
      pendingNotes: pendingNotesFor(s.id).length,
      mergeState: mergeStateCached(directories.get(s.dirId), s),
      summary: sum?.summary || null, summaryTs: sum?.ts || null,
      classifyState: ts.classifyState || null,
      goal: ts.goal || '', phase: ts.phase || 'idle',
    });
  }
  return out;
}

function handleWorkspaceWs(ws, req, urlObj) {
  const dirId = urlObj.searchParams.get('dirId') || '';
  if (!directories.has(dirId)) {
    ws.send(JSON.stringify({ type: 'error', error: 'unknown directory' }));
    ws.close();
    return;
  }
  let set = workspaceClients.get(dirId);
  if (!set) { set = new Set(); workspaceClients.set(dirId, set); }
  set.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({
    type: 'snapshot', dirId,
    sessions: workspaceSnapshot(dirId),
    events: recentEvents(dirId),
  }));
  ws.on('close', () => {
    set.delete(ws);
    if (set.size === 0) workspaceClients.delete(dirId);
  });
}

// Global meta bus handler: subscribes the ws to every workspace event across
// every directory, and sends an initial fleet-wide snapshot on connect.
function handleMetaWs(ws, req) {
  metaClients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // Fleet snapshot: every directory's sessions + recent events, so a freshly
  // connected meta/voice assistant sees the whole board immediately.
  const fleet = [];
  for (const [dirId, dir] of directories.entries()) {
    fleet.push({ dirId, dirLabel: dir.label || null,
                 sessions: workspaceSnapshot(dirId),
                 events: recentEvents(dirId) });
  }
  ws.send(JSON.stringify({ type: 'meta_snapshot', fleet }));
  ws.on('close', () => { metaClients.delete(ws); });
}

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
// Build the classify system prompt (instructions only, no data).
function buildClassifySystemPrompt(priorGoal) {
  return `你是任务状态分析器。你需要判断【当前】闭环任务的状态。请严格按以下步骤思考，最后只输出三行结果。

【背景】一个会话里可能先后讨论过多个不同任务（任务A做完后用户又提了任务B）。你只关心【最后一个任务】，不要被前面已结束的旧任务干扰。

【步骤1·分组】在脑内把对话记录按任务切分成若干段：每当用户提出一个全新的、与上文不同的需求时，就开启一个新段。连续围绕同一需求的几轮对话属于同一段。系统注入消息（🔇开头、"检测到任务""[自动恢复""继续："开头）不是新任务，归入当前段；而且它们是系统自动发出的、【不代表真人用户在催促或推动继续】——判定第3行 C/W 时必须忽略这些注入消息的"推进"含义，只依据真人用户的真实意图判断。

【步骤2·定位】找出最后一条消息所属的段，那就是"当前任务"。前面已结束的段全部忽略--哪怕它们判定结果是"已完成"，也不代表当前状态。

【步骤3·判定】只对"当前任务"这一段判定，输出三行：

第1行：当前任务的目标，用一个简短的名词性短语。
       语言跟随对话语言：中文用中文（≤20 汉字，如"memo图片更换""给目录卡片加 git 状态行"）；英文用英文（≤10 words, e.g. "Fix login page styling"）。
       严格忽略招呼、反问、确认、推进类消息（如"hi""你好""如何了""做到哪了""继续""好了吗" / "hi", "how is it going", "continue"）--这些不是任务目标。
       已有目标「${priorGoal || '无'}」，如仍围绕同一任务请保持一致。
       如果当前任务段没有任何具体任务（纯招呼/闲聊/系统消息），输出「-」。

第2行：当前任务的阶段，必须原样输出以下五个中文词之一（无论对话语言）：
       规划中 / 实现中 / 验证中 / 收尾中 / 已完成
       AI 在等用户回复时不应判为「已完成」；只有把当前任务所有要求都做完了才判「已完成」。
       最新用户消息如果提出了新的具体需求，即使 AI 还没开始做，也应判「规划中」而非「已完成」。

第3行：仅一个字母，判断【当前任务段】接下来该谁行动：
       D = 任务已完成（助手把当前任务的所有要求都做完了，正常收尾、没有反问、也不需要再继续；用户可以验收）
       C = AI 应继续（用户发来新需求、纠错、认可、确认、继续执行等推进类消息，任务还没做完，AI 应接着做；AI 不需要等用户做决定）
       W = 等用户（助手在反问、征求意见、让用户做选择；或用户表达了犹豫需要时间考虑）
       E = API 异常中断（助手回复末尾含 "API Error"、"503"、"Connection closed"、"Overloaded"、"Internal server error"、"The system is busy" 等故障信息，回答被截断而非正常完成）
       P = AI 还在处理中（回复为空、或明显话没说完，还没到判断的时候）

关键区分 D vs C：
  · 助手已把任务做完、正常收尾、没有后续动作 → D（完成）
  · 任务还没做完，且用户/对话在推动继续（新指令、纠错、"继续""再试试"、确认后要接着做）→ C（应继续）
  · 最新一条是用户的推进消息、AI 还没回应 → 这是 C（AI 该继续干），绝不是 D
判断时看当前任务段的整体走向，不是看最后一句有没有问号。回复为空/话没说完判 P。API故障截断判 E。

关键区分 C vs W（【W 优先于 C】）：
  · 只要助手在回复末尾向用户提出了"需要用户拿主意/做决定"的请求——二选一、"要不要我做X"、"先做哪个"、"请指定优先级/范围"、"要我现在就动手吗"、"等你确认后再做"——一律判 W，【即使当前任务整体还没做完】。"等用户决定"高于"任务没做完→C"。
  · 只有当对话在无歧义地推动继续、且助手并没有在等用户任何决定时，才判 C。
  · 拿不准是 C 还是 W 时，判 W（宁可等用户，也不要自作主张替用户继续）。

⚠️ 若对话明显还在进行中（最后是助手消息且话没说完、或助手正在执行操作），第3行直接判 P，不要硬猜。
⚠️ 只有真正做完当前任务才判 D；AI 在等用户回复、或任务还没收尾，都不能判 D。

只输出这三行结果。不要输出分组过程、不要加序号、解释、引号、空行。`;
}

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
  // ⑦ Gate: aux unhealthy → suppress, freeze last-known state
  if (auxQueue.isUnhealthy()) return;

  const reply = cs.currentAssistantText || '';
  const userMsg = cs.currentUserText || '';
  // Need at least a user message (turn-start) or some AI reply (mid/end) to work with.
  if (userMsg.length < 1 && reply.length < 20) return;

  const sessionId = persistedSessions.get(sessionName)?.id || sessionName;
  const priorGoal = cs.currentTask?.goal || '';
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
  });
}

// Fire classify immediately after a turn ends — classify is the ONLY decider of
// C/W/E/P/D. No in-turn loop: while streaming the output is still changing so a
// mid-turn verdict would be judged against an incomplete reply. We judge once at
// turn end (definitive) and the periodic scan re-judges anything not yet D/W.
// runClassifyNow handles the empty-reply case itself (falls back to user msg).
function classifyTurnEnd(cs, sessionName) {
  cancelClassify(cs);
  runClassifyNow(cs, sessionName);
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

// Ensure cs.currentTask exists for this turn. Continuation heuristic: prior task
// exists, started < 10 min ago, not done → bump turnSeq, keep the goal (the async
// to decide continuity). Otherwise start a fresh task object with a synchronous
// fallback goal that the in-progress classify loop will refine async.
function ensureCurrentTask(cs, sessionName, userText) {
  if (!cs) return;
  const now = Date.now();
  const prev = cs.currentTask;
  if (prev && prev.phase !== 'done' && prev.startedAt && (now - prev.startedAt) < 10 * 60 * 1000) {
    prev.turnSeq = (prev.turnSeq || 0) + 1;
    // Refresh persisted state: a continued turn means the closed-loop task
    // is still running (classify will refine shortly).
    setTaskState(sessionName, { classifyState: 'P' });
    return prev;
  }
  // No rule-based goal from userText — the classify loop (fired right after this
  // at turn start)提炼 the real goal, ignoring greetings / injected system text.
  // Carry a prior task's classify-refined goal forward so the "新任务" placeholder
  // doesn't overwrite a valid goal before classify runs - BUT only while that prior
  // task is still in flight (phase !== 'done'). If it already reached 'done', this
  // new user message starts a new task: inheriting the old already-resolved goal
  // makes scan see isStreaming + isGoalResolved(旧goal)=true -> skipped-streaming,
  // starving classify for the whole turn. Reset to '新任务' so scan falls through
  // and extracts the real goal mid-stream.
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

// Get recent user messages from chat history for task summary context.
// Returns up to `maxCount` most recent user messages (oldest first).
function getRecentUserMessages(sessionName, maxCount = 3) {
  try {
    const history = loadChatHistory(sessionName);
    const userMsgs = [];
    for (let i = history.length - 1; i >= 0 && userMsgs.length < maxCount; i--) {
      const msg = history[i];
      if (msg && msg.role === 'user' && msg.content) {
        userMsgs.unshift(msg.content);
      }
    }
    return userMsgs;
  } catch (_) { return []; }
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

// ── Folder-based session memory ────────────────────────────────────────────
// Each session gets its own on-disk memory folder, plus a shared folder scoped
// to the owning directory (the "mother folder"). Stored OUTSIDE user repos
// (under the multicc install dir) so nothing leaks into git worktrees/merges:
//   memories/<dirId>/_shared/            ← shared across all sessions in the dir
//   memories/<dirId>/sessions/<id>/      ← private to one session
// The session's own primary file is named per CLI to match native conventions
// (CLAUDE.md for claude, AGENTS.md for codex). Short facts use the controlled
// memory endpoint; longer notes may use normal file tools. own+shared are read
// when the native CLI context is created and remain a frozen prompt snapshot.
const MEMORY_STORE_ROOT = process.env.MULTICC_MEMORY_ROOT || path.join(__dirname, 'memories');
const SESSION_MEM_CAP = 5000;   // chars of own-folder memory injected per native session
const SHARED_MEM_CAP  = 4000;   // chars of shared-folder memory injected per native session
const SESSION_CURATED_MEM_CAP = 2200;
const SHARED_CURATED_MEM_CAP = 2200;

function sessionMemoryDir(persisted) {
  return path.join(MEMORY_STORE_ROOT, String(persisted.dirId), 'sessions', String(persisted.id));
}
function sharedMemoryDir(dirId) {
  return path.join(MEMORY_STORE_ROOT, String(dirId), '_shared');
}
function primaryMemFileName(cli) {
  return cli === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
}

// Create the folders on first use and seed a starter primary file (per CLI) and
// a shared readme so the convention is discoverable. Best-effort; never throws.
function ensureMemoryDirs(persisted) {
  const own = sessionMemoryDir(persisted);
  const shared = sharedMemoryDir(persisted.dirId);
  try {
    fs.mkdirSync(own, { recursive: true });
    fs.mkdirSync(shared, { recursive: true });
    const primary = path.join(own, primaryMemFileName(persisted.cli));
    if (!fs.existsSync(primary)) {
      fs.writeFileSync(primary,
`# 本会话私有记忆

> 「${persisted.label || persisted.id}」会话专属的长期记忆，只有本会话读得到。
> 把值得长期记住的东西写进本文件夹的 .md（决定 / 踩过的坑 / 进行中的任务 / 用户偏好）。
> 想让本项目所有会话都看到的，写到公共记忆文件夹（见注入提示里的路径）。

（暂无内容）
`);
    }
    const readme = path.join(shared, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme,
`# 公共记忆（本项目所有会话共享）

> 这里的内容会在本目录下原生 CLI 会话启动/重建时进入上下文快照。放跨会话复用的项目知识、约定、稳定事实。
> 一事一文件、精炼；临时/私有的东西请写进各自会话的私有记忆文件夹，不要放这里。
`);
    }
    // One-time migration: mirror any legacy distilled JSON entries into _auto.md
    // so existing sessions' memory surfaces in the folder (and stays injected).
    const auto = path.join(own, '_auto.md');
    if (!fs.existsSync(auto)) {
      const legacy = getMemoryEntries(persisted);
      if (legacy && legacy.length) writeAutoMemoryFile(persisted, legacy);
    }
  } catch (_) { /* best-effort */ }
  return { own, shared };
}

// Mirror the auto-distilled entries into the session's own folder as _auto.md —
// the single injected surface for auto memory. Empty entries remove the file.
function writeAutoMemoryFile(persisted, entries) {
  if (!persisted || !persisted.dirId || !persisted.id) return;
  try {
    const dir = sessionMemoryDir(persisted);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '_auto.md');
    if (!entries || !entries.length) { try { fs.unlinkSync(file); } catch (_) {} return; }
    const body = entries.map(e => `- [${e.type}] ${e.text}`).join('\n');
    fs.writeFileSync(file,
`# 自动提炼记忆（辅助 AI 从周期复盘或被清理的历史中提炼；本文件会被自动覆盖，想长期保留请另写 .md）

${body}
`);
  } catch (_) { /* best-effort */ }
}

// Build the folder-memory injection block (own + shared) for a session. Returns
// null for aux/gateway/system sessions or when identifiers are missing.
function buildFolderMemoryBlock(persisted) {
  if (!persisted || !persisted.dirId || !persisted.id) return null;
  if (persisted.type === 'aux' || persisted.type === 'gateway') return null;
  const { own, shared } = ensureMemoryDirs(persisted);
  const ownText = readFolderMemory(own, SESSION_MEM_CAP, {
    primaryNames: [primaryMemFileName(persisted.cli), 'AGENTS.md', 'CLAUDE.md', 'MEMORY.md'],
  });
  const sharedText = readFolderMemory(shared, SHARED_MEM_CAP, {
    primaryNames: ['MEMORY.md'],
  });
  return (
`[记忆库｜原生会话快照] 你有一个持久记忆文件夹（存在 multicc 数据区，不在本仓库、不进 git）。以下正文会在原生 CLI 会话启动/重建时形成快照；会话中写入会立即落盘并由工具结果确认，但不会改写已经运行中的系统提示词。
· 私有记忆（仅本会话可见）文件夹：${own}
· 公共记忆（本项目所有会话共享）文件夹：${shared}
· 保存短小、稳定的事实时，优先调用受控记忆接口（原子写入、去重、容量与安全检查）：
  curl -s "$MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/memory/action" -H 'Content-Type: application/json' -d '{"action":"add","scope":"own","content":"要记住的事实"}'
  action 可为 add / replace / remove；replace/remove 另传 oldText。跨会话项目事实用 scope=shared。较长的专题笔记仍可直接 Write/Edit 为独立 .md 文件。

【私有记忆】
${ownText || '（空）'}

【公共记忆】
${sharedText || '（空）'}
[记忆库结束]`
  );
}

// ── Folder-memory file ops (used by the memory editor UI) ──────────────────
// List every .md file in a memory folder as {name, content}. Missing dir → [].
function listMemoryFiles(dir) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md')).sort(); }
  catch (_) { return []; }
  return files.map(name => {
    let content = '';
    try { content = fs.readFileSync(path.join(dir, name), 'utf8'); } catch (_) {}
    return { name, content };
  });
}
// Validate a user-supplied memory filename: plain name, .md, no path traversal.
// Allows word chars, dash, dot, space and CJK. Returns the safe name or null.
function safeMemFileName(name) {
  const n = String(name || '').trim();
  if (!n || n.includes('/') || n.includes('\\') || n.includes('..')) return null;
  if (!/^[\w.\- 一-龥]+\.md$/i.test(n)) return null;
  return n;
}
// Resolve which folder a scope ('own' | 'shared') maps to for a session.
function memScopeDir(persisted, scope) {
  return scope === 'shared' ? sharedMemoryDir(persisted.dirId) : sessionMemoryDir(persisted);
}

// Resolve the effective custom role prompt for a session: an explicit
// session-level role wins; otherwise inherit the owning directory's default.
// The distilled JSON memory (keyword-matched) and the folder-based memory
// (own + shared) are appended to the native-session startup prompt. Returns null when
// nothing at all applies.
function resolveRolePrompt(persisted) {
  if (!persisted) return null;
  // Base persona: explicit session role wins, else the directory default.
  let base = persisted.rolePrompt;
  if (!base) {
    const dir = persisted.dirId ? directories.get(persisted.dirId) : null;
    base = (dir && dir.rolePrompt) || null;
  }

  const parts = [];
  if (base) parts.push(base);

  // Folder-based memory (own + shared) is the single injected surface. The
  // auto-distiller mirrors its output into the own folder as _auto.md, so the
  // old keyword-matched JSON block is gone — everything flows through the folder.
  const folderBlock = buildFolderMemoryBlock(persisted);
  if (folderBlock) parts.push(folderBlock);

  return parts.length ? parts.join('\n\n') : null;
}

// Return the most recent user message from a session's chat history (string
// content only). Used by resolveRolePrompt to keyword-match memory entries
// against what the user is asking about right now.
function getLatestUserMessage(sessionName) {
  const history = chatHistories.get(sessionName);
  if (!history || history.length === 0) return '';
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user' && typeof history[i].content === 'string') {
      return history[i].content;
    }
  }
  return '';
}

// Extract keywords from a user message for memory matching. English words are
// matched as tokens (>=3 chars); Chinese is sliced into 2-grams plus short
// whole-segment tokens. Common English stop-words are filtered out.
function extractKeywords(text) {
  if (!text) return [];
  const cleaned = text.replace(/[^一-龥a-zA-Z0-9_\s/-]/g, ' ').trim();
  const keywords = new Set();

  // English words (>=3 chars)
  const enWords = cleaned.match(/[a-zA-Z][a-zA-Z0-9_-]{2,}/g) || [];
  enWords.forEach(w => keywords.add(w));

  // Chinese 2-grams + short whole segments
  const cjk = cleaned.match(/[一-龥]+/g) || [];
  for (const seg of cjk) {
    for (let i = 0; i < seg.length - 1; i++) {
      keywords.add(seg.substring(i, i + 2));
    }
    if (seg.length <= 6) keywords.add(seg);
  }

  const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'this', 'that', 'with', 'have', 'from', 'they', 'them', 'what', 'were', 'been', 'will', 'would', 'could', 'should']);
  return [...keywords].filter(k => !stopWords.has(k.toLowerCase()) && k.length >= 2);
}

// Score memory entries against the current user message's keywords and return
// the most relevant ones, up to maxChars of formatted text. Entries with score
// 0 are skipped once at least one matched; if nothing matches at all, the most
// recent 3 entries are returned as a floor so the model always has some context.
function getRelevantMemoryEntries(query, entries, maxChars = 2000) {
  if (!entries || entries.length === 0) return [];

  const keywords = extractKeywords(query);

  const scored = entries.map(e => {
    const text = e.text.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) {
        score += kw.length;  // longer keywords weigh more
      }
    }
    // Type weight: todo and gotcha are more likely to affect current decisions
    const typeWeight = { todo: 1.5, gotcha: 1.3, decision: 1.0, fact: 0.8, preference: 1.2 };
    score *= (typeWeight[e.type] || 1.0);
    return { entry: e, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const result = [];
  let totalChars = 0;
  for (const { entry, score } of scored) {
    if (score === 0 && result.length > 0) break;  // skip unmatched once we have matches
    const lineLen = entry.text.length + 20;  // account for "[type] " formatting overhead
    if (totalChars + lineLen > maxChars) break;
    result.push(entry);
    totalChars += lineLen;
  }

  // Floor: if nothing matched, return the most recent 3 entries
  if (result.length === 0 && entries.length > 0) {
    return entries.slice(-3);
  }
  return result;
}

// Turn-boundary hook for guard F (REMOVED — classify prompt + dispatchStateAction
// now handle API errors via state E → retry inject). The two call sites still
// set/reset _sawApiError for classify to reference.

// Apply one claude-shaped stream-json event to chat session state, then forward
// it to clients. Shared by the per-turn spawn path (handleLine) and the
// persistent streaming path (runChatTurnStreaming) so the two never drift.
// The `result` event is the turn boundary: it saves the assistant message,
// returns the session to idle, and fires post-turn hooks.
function applyClaudeChatEvent(cs, sessionName, evt, forward) {
  if (evt.type === 'assistant' && evt.message?.model) noteReportedModel(sessionName, evt.message.model);
  if (evt.type === 'assistant' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'text') {
        cs.currentAssistantText += block.text;
        setSessionStatus(sessionName, { status: 'thinking', currentFile: null });
        // Incremental save: flush the in-progress assistant message to disk
        // every 5s so a crash/restart mid-turn doesn't lose the whole reply.
        scheduleIncrementalSave(sessionName, cs);
      }
      if (block.type === 'tool_use') {
        cs.currentToolCalls.push({ name: block.name, input: block.input, id: block.id });
        recordMainToolUseId(sessionName, block.id);
        if (block.name === 'TaskOutput') markTaskOutputAwaiting(block.input);
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
    cs.currentCost = evt.total_cost_usd || null;
    // Flag transport/API failures — classify prompt recognizes these and
    // judges state E (API error) → retry inject picks up naturally.
    if (evt.is_error === true || (evt.subtype && evt.subtype !== 'success' && /error|abort|timeout/i.test(evt.subtype))) {
      cs._sawApiError = true;
      recordApiError(evt.subtype || 'api_error');
    } else {
      recordApiSuccess();
    }
    // Hoisted out of the if-block below: forward() at the end of this branch
    // also needs it. Block-scoping it inside the if made the forward line throw
    // ReferenceError (swallowed by handleLine's catch), so live clients never
    // received the result event — token/timing footers only appeared after a
    // reload replayed chat_history.
    const usage = evt.usage || {};
    if (cs.currentAssistantText || cs.currentToolCalls.length) {
      appendChatMessage(sessionName, {
        role: 'assistant', content: cs.currentAssistantText,
        tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
        cost: cs.currentCost, usage: Object.keys(usage).length ? usage : undefined, ts: Date.now(),
      });
      accumulateTokenUsage(sessionName, usage);
      broadcastProviderTokenStats(sessionName);
      broadcastRoleTokenStats(sessionName);
      cs.chatTurnCount++;
      cs._resultSaved = true;
      // Cancel any pending incremental-save timer: the final message is now
      // persisted, so a timer firing 0-5s later would append a stale _interim
      // AFTER the final — a duplicate bubble on reconnect. Mirrors the cancel
      // in the child-process close handler.
      const incrTimer = _incrSaveTimers.get(sessionName);
      if (incrTimer) { clearTimeout(incrTimer); _incrSaveTimers.delete(sessionName); }
    }
    if (cs._resultSaved) consumePendingCliHandoff(sessionName);
    // Include durationMs + num_turns in the result broadcast so clients
    // (web + app) can display per-message task timing without client-side
    // clock guesswork. durationMs is the wall-clock time from turnStartedAt
    // (user submit) to this result — "模型接到消息到输出完成的耗时".
    const _resultDurationMs = cs.turnStartedAt ? Date.now() - cs.turnStartedAt : undefined;
    forward({ type: 'result', total_cost_usd: evt.total_cost_usd, usage, durationMs: _resultDurationMs, num_turns: cs.chatTurnCount });
    // Let classify decide the final status; default to 'completed' until then.
    setSessionStatus(sessionName, { status: 'completed', currentFile: null });
    classifyTurnEnd(cs, sessionName);
    // Anti-pattern guard (E): if this turn launched a run_in_background Bash and
    // Decoupled via the bus so chat doesn't depend on the triggers domain.
    bus.emit('chat:turn-complete', sessionName, cs);
  }
  // Drop claude's `system init` — server already sent its own (but keep the
  // runtime-reported model before discarding).
  if (evt.type === 'system' && evt.subtype === 'init') { noteReportedModel(sessionName, evt.model); return; }
  forward(evt);
}

// Apply adapter-neutral events to server-owned chat state. Wire-format parsing
// belongs to each CLI adapter; this function owns persistence, status and the
// Claude-shaped event contract consumed by existing clients.
function applyAdapterChatEvent(provider, cs, persisted, sessionName, rawEvent, forward) {
  const decoded = provider.decodeEvent(rawEvent) || [];
  for (const evt of (Array.isArray(decoded) ? decoded : [decoded])) {
    if (!evt) continue;
    if (evt.type === 'claude_event') {
      applyClaudeChatEvent(cs, sessionName, evt.raw, forward);
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
        cs._killReason = 'cli_resume_mismatch';
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
        savePersistedSessions();
        console.log(`[multicc/chat] [${sessionName}] captured ${provider.name} session id=${evt.sessionId}`);
      }
      continue;
    }
    if (evt.type === 'status') {
      setSessionStatus(sessionName, { status: evt.status || 'thinking', currentFile: evt.currentFile || null });
      continue;
    }
    if (evt.type === 'assistant_text') {
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
      const tool = { name: evt.name, input: evt.input || {}, id: evt.id };
      cs.currentToolCalls.push(tool);
      recordMainToolUseId(sessionName, evt.id);
      forward({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: evt.name, id: evt.id, input: evt.input || {} }] },
      });
      setSessionStatus(sessionName, { status: evt.status || 'running', currentFile: evt.currentFile || null });
      continue;
    }
    if (evt.type === 'tool_result') {
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
      const id = evt.id || `call_${cs.currentToolCalls.length}`;
      let tool = cs.currentToolCalls.find(item => item.id === id);
      if (!tool) {
        tool = { name: evt.name, input: evt.input || {}, id };
        cs.currentToolCalls.push(tool);
        recordMainToolUseId(sessionName, id);
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
      const tool = { name: 'Thinking', input: { text: evt.text || '' }, id: evt.id, result: evt.text || '' };
      cs.currentToolCalls.push(tool);
      recordMainToolUseId(sessionName, evt.id);
      forward({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Thinking', id: evt.id, input: tool.input }] },
      });
      continue;
    }
    if (evt.type === 'complete') {
      cs.currentCost = evt.cost == null ? null : evt.cost;
      const usage = evt.usage || {};
      reconcileCodexRoleUsage(sessionName, usage);
      if (cs.currentAssistantText || cs.currentToolCalls.length) {
        appendChatMessage(sessionName, {
          role: 'assistant', content: cs.currentAssistantText,
          tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
          cost: cs.currentCost, usage, ts: Date.now(),
        });
        accumulateTokenUsage(sessionName, usage);
        broadcastProviderTokenStats(sessionName);
        broadcastRoleTokenStats(sessionName);
        cs.chatTurnCount++;
        cs._resultSaved = true;
      }
      if (cs._resultSaved) consumePendingCliHandoff(sessionName);
      forward({
        type: 'result', total_cost_usd: cs.currentCost, usage,
        durationMs: cs.turnStartedAt ? Date.now() - cs.turnStartedAt : undefined,
        num_turns: cs.chatTurnCount,
      });
      setSessionStatus(sessionName, { status: 'completed', currentFile: null });
      classifyTurnEnd(cs, sessionName);
      continue;
    }
    if (evt.type === 'error') {
      if (evt.kind === 'response_completed_disconnect') {
        cs._codexPendingStreamError = evt.message;
        cs._codexPendingStreamErrorCount = (cs._codexPendingStreamErrorCount || 0) + 1;
        const hasOutput = !!(cs.currentAssistantText || cs.currentToolCalls.length || cs._resultSaved);
        if (hasOutput) cs._codexRecoveredDisconnect = true;
        console.warn(`[multicc/chat] [${sessionName}] pending ${provider.name} response.completed disconnect${hasOutput ? ' after output' : ''} #${cs._codexPendingStreamErrorCount}: ${evt.message}`);
      } else if (evt.kind === 'transport_disconnect') {
        cs._codexTransportError = evt.message;
        cs._sawApiError = true;
        recordApiError(evt.message);
        console.warn(`[multicc/chat] [${sessionName}] ${provider.name} transport disconnect: ${evt.message}`);
      } else {
        cs._adapterError = evt.message;
        forward({ type: 'error', error: `${evt.label || provider.name} 出错：${evt.message}` });
      }
    }
  }
}

// === Background task (Monitor / run_in_background) shadow tracking ===
//
// CC emits task_started/task_updated/task_notification/background_tasks_changed
// as type:"system" stream-json events. The per-turn onEvent is cleared at the
// turn's `result` (chat-stream finishTurn sets s.current=null), but a Monitor
// is a session-lifetime process: the model starts it, ends its turn, and the
// task keeps running - so its events arrive AFTER result and would be dropped.
// chat-stream forwards them via onBackgroundEvent (independent of s.current),
// which lands here.
//
// CC tee's a Monitor's stdout to a predictable file:
//   <realpath(/tmp)>/claude-<uid>/<encoded-cwd>/<sessionId>/tasks/<taskId>.output
// where encoded-cwd = realpath(cwd).replace(/[\/.]/g, "-") (slashes AND dots -> dash).
// We shadow-tail it to surface live progress to the UI. The authoritative
// output_file path arrives in the task_notification(completed) event; we use
// that for the final full read (handles any path-mismatch fallback).
function monitorOutputFilePath(sessionId, taskId, cwd) {
  try {
    const { realpathSync } = require('fs');
    const tmpReal = realpathSync('/tmp');
    const encoded = realpathSync(cwd || '.').replace(/[\/.]/g, '-');
    return `${tmpReal}/claude-${process.getuid()}/${encoded}/${sessionId}/tasks/${taskId}.output`;
  } catch { return null; }
}

function startMonitorShadow(sessionName, cs, taskId, outputFile, desc) {
  if (!cs._monitorShadows) cs._monitorShadows = new Map();
  if (cs._monitorShadows.has(taskId) || !outputFile) return;
  const { spawn } = require('child_process');
  // -F (capital) retries while the file doesn't exist yet and follows
  // rotation; task_started fires before CC creates the file, so -F is required.
  const tail = spawn('tail', ['-n', '+1', '-F', outputFile], { stdio: ['ignore', 'pipe', 'ignore'] });
  tail.stdout.on('data', (chunk) => {
    for (const ln of chunk.toString().split('\n')) {
      if (!ln) continue;
      chatBroadcast(sessionName, { type: 'monitor_progress', task_id: taskId, line: ln, description: desc });
    }
  });
  tail.on('error', () => {});
  cs._monitorShadows.set(taskId, { tail, outputFile });
}

function stopMonitorShadow(cs, taskId) {
  const sh = cs._monitorShadows && cs._monitorShadows.get(taskId);
  if (!sh) return;
  try { sh.tail.kill(); } catch {}
  cs._monitorShadows.delete(taskId);
}

// De-dup vs TaskOutput: when the main session actively pulls a bg task's result
// via TaskOutput(block=true), the task_notification(completed) event arriving
// moments later would otherwise double-inject a "后台任务完成" nudge on top of the
// result the session already pulled (esp. across an SDK-session switch, where the
// new session has no TaskOutput context and gets a cold "task finished" nudge for
// a task whose result the prior session already consumed). Track taskIds the main
// session is awaiting via block=true; suppress the nudge for those.
const _taskOutputAwaiting = new Map(); // taskId -> { at }
const TASKOUTPUT_AWAIT_TTL_MS = 5 * 60 * 1000;
// NOTE: only block=true pulls are marked. Marking block=false peeks too was tried
// (to close the same-task double-delivery when a peek already saw the completed
// output) but reverted: at tool_use time we can't tell whether the peek observed
// completion or only partial output, so a short-TTL peek mark would suppress the
// completion nudge of a task that finishes shortly after an EARLY peek — stalling
// an idle session. A correct fix must gate on the tool_result showing completion.
function markTaskOutputAwaiting(input) {
  try {
    if (!input || !input.block || !input.task_id) return; // only block=true pulls consume the result
    const tid = String(input.task_id);
    const now = Date.now();
    for (const [k, v] of _taskOutputAwaiting) if (now - v.at > TASKOUTPUT_AWAIT_TTL_MS) _taskOutputAwaiting.delete(k);
    _taskOutputAwaiting.set(tid, { at: now });
  } catch {}
}
function isTaskOutputAwaiting(taskId) {
  if (!taskId) return false;
  const v = _taskOutputAwaiting.get(String(taskId));
  if (!v) return false;
  if (Date.now() - v.at > TASKOUTPUT_AWAIT_TTL_MS) { _taskOutputAwaiting.delete(String(taskId)); return false; }
  return true;
}
function consumeTaskOutputAwaiting(taskId) { if (taskId) _taskOutputAwaiting.delete(String(taskId)); }
// De-dup vs sync Bash: a synchronous Bash tool_use (run_in_background !== true)
// returns its result to the main session via tool_result. CC may still emit
// task_started+task_notification for it; the notification would double-inject a
// "后台任务完成" nudge on top of the tool_result the session already got. task_started
// tags the task_id (via tool_use_id); task_notification suppresses. (Monitor /
// run_in_background:true Bash outlive the turn and still notify.)
const _syncBashTaskIds = new Map(); // taskId -> { at }
const SYNC_BASH_TAG_TTL_MS = 5 * 60 * 1000;
function tagSyncBashTask(taskId) {
  if (!taskId) return;
  const now = Date.now();
  for (const [k, v] of _syncBashTaskIds) if (now - v.at > SYNC_BASH_TAG_TTL_MS) _syncBashTaskIds.delete(k);
  _syncBashTaskIds.set(String(taskId), { at: now });
}
function isSyncBashTask(taskId) {
  if (!taskId) return false;
  const v = _syncBashTaskIds.get(String(taskId));
  if (!v) return false;
  if (Date.now() - v.at > SYNC_BASH_TAG_TTL_MS) { _syncBashTaskIds.delete(String(taskId)); return false; }
  return true;
}
function consumeSyncBashTask(taskId) { if (taskId) _syncBashTaskIds.delete(String(taskId)); }
// Sub-agent sidechain tasks: a sub-agent (Workflow internal / Task tool) runs
// Bash in its own sidechain; its tool_use_id is NOT in the main session's
// currentToolCalls list, so tu=undefined at task_started. These are NOT real
// background tasks from the user's perspective and must not fire a 后台任务 nudge.
// We tag them at task_started and suppress at task_notification — same scoping
// pattern as the sync-Bash helpers above.
const _subagentTaskIds = new Map(); // taskId -> { at }
const SUBAGENT_TAG_TTL_MS = 5 * 60 * 1000;
function tagSubagentTask(taskId) {
  if (!taskId) return;
  const now = Date.now();
  for (const [k, v] of _subagentTaskIds) if (now - v.at > SUBAGENT_TAG_TTL_MS) _subagentTaskIds.delete(k);
  _subagentTaskIds.set(String(taskId), { at: now });
}
function isSubagentTask(taskId) {
  if (!taskId) return false;
  const v = _subagentTaskIds.get(String(taskId));
  if (!v) return false;
  if (Date.now() - v.at > SUBAGENT_TAG_TTL_MS) { _subagentTaskIds.delete(String(taskId)); return false; }
  return true;
}
function consumeSubagentTask(taskId) { if (taskId) _subagentTaskIds.delete(String(taskId)); }
// Robust sidechain detection: a session-lifetime, append-only set of tool_use
// ids that the MAIN session has emitted. Populated from the main assistant
// stream (NOT cleared per turn), so it survives across turns. At
// task_notification: if evt.tool_use_id is present AND not in this set, the
// task is a sidechain (sub-agent) task and must be suppressed — regardless of
// whether the CLI delivered task_started for it.
const _mainToolUseIds = new Map(); // sessionName -> { set: Set, order: string[] }
const MAIN_TOOL_USE_CAP = 2000;
function recordMainToolUseId(sessionName, id) {
  if (!sessionName || !id) return;
  let rec = _mainToolUseIds.get(sessionName);
  if (!rec) { rec = { set: new Set(), order: [] }; _mainToolUseIds.set(sessionName, rec); }
  if (rec.set.has(id)) return; // already recorded
  rec.set.add(id);
  rec.order.push(id);
  while (rec.order.length > MAIN_TOOL_USE_CAP) {
    const old = rec.order.shift();
    rec.set.delete(old);
  }
}
function isMainToolUseId(sessionName, id) {
  if (!sessionName || !id) return false;
  const rec = _mainToolUseIds.get(sessionName);
  return rec ? rec.set.has(id) : false;
}
// C2: coalesce completion nudges per session. Several bg tasks finishing within a
// short window wake the session with ONE merged nudge instead of one turn each.
const bgCompletionCoalescer = bgCoalesce.createCoalescer({
  onFlush: (sessionName, items) => {
    console.log(`[multicc/bg] ${sessionName} flush ${items.length} completion(s) -> ${items.length > 1 ? 'merged' : 'single'} nudge`);
    // noteBgResultInjected was already called at add()-time (when the completion
    // was known) so the classify dedup window covers the coalescing gap; don't
    // re-open it here (that would suppress a user's own continuation for 60s if a
    // user message landed during the window). Just inject the (merged) result.
    //
    // Aggregate the origin ids of EVERY item in the window so the resulting user
    // message can be traced back to its task(s). A single completion yields a
    // precise one-tool_use_id link (the frontend can pin the notice to that tool
    // card); a merged flush carries the full set so history can still map the
    // message to all originating tasks even though it won't pin to one card.
    const bgTaskIds = items.map(it => it.taskId).filter(Boolean);
    const bgToolUseIds = items.map(it => it.toolUseId).filter(Boolean);
    // Guard on EITHER list: a completion may carry tool_use_id without a task_id
    // (some CLI event shapes), and tool_use_id is the primary join key to the
    // originating tool card — keying only on bgTaskIds.length would drop it
    // exactly when taskId is absent.
    const origin = (bgTaskIds.length || bgToolUseIds.length) ? { bgTaskIds, bgToolUseIds } : {};
    waitInjector.injectSystemMsg(sessionName, bgCoalesce.buildNudge(items), 0, origin);
  },
});
function handleBackgroundTaskEvent(sessionName, cs, evt) {
  const sub = evt.subtype;
  if (sub === 'task_started') {
    const taskId = evt.task_id;
    if (!taskId) return;
    const outputFile = monitorOutputFilePath(evt.session_id || '', taskId, cs.cwd);
    const tu = cs.currentToolCalls && cs.currentToolCalls.find(t => t.id === evt.tool_use_id);
    const cmd = (tu && tu.input && tu.input.command) || '';
    // A foreground (sync) Bash still emits task_started/task_notification — its
    // result returns via the normal tool_result path, so it is NOT a background
    // task and must not fire a 后台任务 notice. Tag it for nudge suppression AND
    // flag the broadcast so the frontend can skip it.
    const isSyncBash = !!(tu && tu.name === 'Bash' && !(tu.input && tu.input.run_in_background));
    if (isSyncBash) {
      tagSyncBashTask(taskId);
      console.log(`[multicc/bg] ${sessionName} task ${taskId} sync Bash (${cmd.slice(0, 60)}) -> will suppress completion nudge`);
    }
    // A sub-agent (Workflow internal / Task tool) Bash runs in a sidechain; its
    // tool_use_id is NOT in the main session's currentToolCalls, so tu=undefined.
    // A MAIN-session run_in_background Bash ALWAYS has its tool_use in
    // currentToolCalls (pushed synchronously before the task starts), so !tu is
    // false for those — they are never tagged here.
    const isSubagentTask = !!(evt.tool_use_id && !tu);
    if (isSubagentTask) {
      tagSubagentTask(taskId);
      console.log(`[multicc/bg] ${sessionName} task ${taskId} sub-agent task (tool_use=${evt.tool_use_id} absent from currentToolCalls) -> will suppress completion nudge`);
    }
    chatBroadcast(sessionName, { type: 'monitor_started', task_id: taskId, description: evt.description || '', command: cmd, background: !isSyncBash });
    startMonitorShadow(sessionName, cs, taskId, outputFile, evt.description || '');
  } else if (sub === 'task_notification') {
    const taskId = evt.task_id;
    console.log(`[multicc/bg-diag] ${sessionName} task_notification taskId=${taskId} toolUseId=${evt.tool_use_id || '-'} desc="${(evt.description || '').slice(0, 40)}"`);
    stopMonitorShadow(cs, taskId);
    // evt.output_file is CC's authoritative path; prefer it over our prediction.
    const outputFile = evt.output_file || (taskId && evt.session_id ? monitorOutputFilePath(evt.session_id, taskId, cs.cwd) : null);
    let output = '';
    if (outputFile) { try { output = require('fs').readFileSync(outputFile, 'utf8'); } catch {} }
    const snippet = output.length > 2000 ? output.slice(-2000) : output;
    // Resolve sync-Bash ONCE: it drives both the broadcast flag (foreground Bash
    // must NOT show a 后台任务 notice — its result returns via tool_result) and
    // the nudge-suppression branch below.
    const isSync = isSyncBashTask(taskId);
    chatBroadcast(sessionName, { type: 'monitor_done', task_id: taskId, status: evt.status, summary: evt.summary || '', output: snippet, background: !isSync });
    // v2: drive a continuation inject straight from the completion event. The
    // event is a deterministic fact carrying the real result, so hand it to the
    // model now rather than letting classify guess B/C and nudge with an empty
    // "继续" (which can misjudge-stall, or make the model re-run finished work).
    // De-duped vs classify via noteBgResultInjected: autoContinue (D) and bgCheck
    // (E) skip their empty nudges within BG_RESULT_DEDUP_MS so we don't
    // double-inject (result + empty nudge) on top of each other.
    if (cs) {
      // Robust sidechain suppression: the v1 tag (set at task_started) is a fast
      // path; the fallback uses the session-lifetime main-tool-use set and works
      // even when the CLI never emits task_started for sidechain tasks.
      const isSidechainByToolUse = !!(evt.tool_use_id && !isMainToolUseId(sessionName, evt.tool_use_id));
      // The suppress-vs-inject decision is a pure function (unit-tested in
      // test-bg-completion-coalescer.js). The predicates are pure reads; only the
      // consume* side effects mutate, and we run just the winning reason's — so
      // routing through classifyBgCompletion is behaviour-identical to the old
      // if-chain (same precedence, same log lines, same early return).
      const decision = bgCoalesce.classifyBgCompletion({
        awaitingTaskOutput: isTaskOutputAwaiting(taskId),
        sync: isSync,
        subagent: isSubagentTask(taskId),
        sidechainByToolUse: isSidechainByToolUse,
      });
      if (decision.action === 'suppress') {
        if (decision.reason === 'taskoutput') {
          console.log(`[multicc/bg] ${sessionName} task ${taskId} completed; main session pulling via TaskOutput -> suppress completion nudge (de-dup)`);
          consumeTaskOutputAwaiting(taskId);
        } else if (decision.reason === 'sync-bash') {
          console.log(`[multicc/bg] ${sessionName} task ${taskId} completed (sync Bash) -> suppress completion nudge (de-dup vs tool_result)`);
          consumeSyncBashTask(taskId);
        } else { // sidechain
          console.log(`[multicc/bg] ${sessionName} task ${taskId} sidechain (subagent=${isSubagentTask(taskId)} toolUseId=${evt.tool_use_id || '-'} not in main tool-use set) -> suppress`);
          consumeSubagentTask(taskId);
        }
        return;
      }
      const desc = evt.description || evt.summary || '后台任务';
      const status = evt.status || 'completed';
      // Carry the origin ids through the coalescer so the flushed nudge can be
      // linked back to the task that produced it (task_id) and — more usefully —
      // to the tool_use block that launched it (tool_use_id is the natural join
      // key to the assistant message's tools[].id and to the frontend's
      // currentToolCards index). buildNudge ignores these (its text stays
      // identical for back-compat with the regression script / string matchers);
      // they ride along as metadata for onFlush to stamp onto the user message.
      waitInjector.noteBgResultInjected(sessionName);
      bgCompletionCoalescer.add(sessionName, {
        desc, status, snippet,
        taskId: taskId || null,
        toolUseId: evt.tool_use_id || null,
      });
    }
  } else if (sub === 'background_tasks_changed') {
    chatBroadcast(sessionName, { type: 'background_tasks', tasks: evt.tasks || [] });
  }
}

function runChatTurn(sessionName, text, opts = {}) {
  const { isFirstTurn: forceFirstTurn, originDispatchId, originTrigger, originContinue, goalLimits, bgTaskIds, bgToolUseIds } = opts;
  const clientMsgId = typeof opts.clientMsgId === 'string' ? opts.clientMsgId.trim().slice(0, 128) : '';
  text = String(text || '').trim();
  if (!text) return false;
  const persisted = persistedSessions.get(sessionName);
  if (!persisted) {
    console.warn(`[multicc/chat] runChatTurn: no persisted record for ${sessionName}`);
    return false;
  }
  // ── Degrade防线 fail-loop 拦截（方案C）──────────────────────────────
  // 上游 API 不健康时，所有「系统自动注入」起的新 turn 只会立刻失败，反过来喂大
  // fail-loop（classify 判 E/P → 注入 → 失败 → recordApiError → 再 classify → 再注入…）。
  // originContinue 由 waitInjector._inject wrapper 统一设置（见 waitInjector.init 调用处），
  // 是「系统注入 vs 用户主动」的唯一可靠判别——SYS_PREFIX(🔇)文本前缀不可靠，因为
  // safeInject 不加前缀（resumeHeldSessions / resumeInterrupted 都走 safeInject）。拦在这一个
  // chokepoint = 覆盖全部注入源：classify 的 E-retry/P-resume
  // + wait-injector 内 callback/poll/resumeInterrupted/bgCheck + bg-completion
  // 结果回流 + dispatch 结果路由。用户主动消息（WS user_message / HTTP memo/send）不设
  // originContinue → 放行；dispatch 启动 worker 有自己的 gate（见 dispatchToSession 的
  // isNetworkUnhealthy 检查）。triggers / 全局 cron 直调 runChatTurn 不带 originContinue，
  // 不在本 chokepoint 覆盖内（属另一改动）。
  // 抑制时不注入、改为 holdSession，等 recordApiSuccess → resumeHeldSessions 恢复接续。
  // 【顺序不变量】recordApiSuccess 必须先把 networkHealth.unhealthy 置 false 再调
  // resumeHeldSessions——否则恢复注入会被本 gate 误拦、held 会话永远无法接续。
  if (originContinue && isNetworkUnhealthy()) {
    holdSession(sessionName, 'classify-inject', text);
    console.log(`[multicc/net] ${sessionName}: suppress system inject (originContinue) — network unhealthy, held for recovery`);
    return false;
  }
  // A real (non-auto-continue) message means the user/trigger is driving again →
  // reset the D auto-continue guard so a future background-wait gets fresh budget.
  if (!originContinue) { waitInjector.resetAuto(sessionName); waitInjector.resetBg(sessionName); waitInjector.resetInterrupted(sessionName); waitInjector.resetBgResult(sessionName); clearBgIdleTimer(sessionName); }
  // Ensure session-level state exists even when no WS client is connected.
  let cs = chatSessions.get(sessionName);
  if (!cs) {
    const csCli = persisted.cli || 'claude';
    if (csCli === 'claude' && !persisted.cliSessionId) {
      persisted.cliSessionId = crypto.randomUUID();
      savePersistedSessions();
    }
    const hist = loadChatHistory(sessionName);
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
    };
    chatSessions.set(sessionName, cs);
  }

  cancelClassify(cs);
  cancelClassify(cs);
  // Kill previous process if still running
  if (cs.claudeProc) {
    console.log(`[multicc/chat] [${sessionName}] New user_message while claude pid=${cs.claudeProc.pid} still running, killing previous turn`);
    cs._killReason = 'new_user_message';
    try { cs.claudeProc.kill('SIGTERM'); } catch (_) {}
    cs.claudeProc = null;
    cs.lineBuf = '';
    cs.isStreaming = false;
    cs.streamReplay = [];
    // Save partial assistant response before starting new turn
    if (cs.currentAssistantText || cs.currentToolCalls.length) {
      appendChatMessage(sessionName, {
        role: 'assistant', content: cs.currentAssistantText,
        tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
        ts: Date.now(), cancelled: true,
      });
      cs.chatTurnCount++;
    }
  } else if ((persisted.cli || 'claude') === 'claude' && chatStream.status(sessionName)?.busy) {
    // Streaming: no per-turn child proc, but a turn may be in flight on the
    // persistent process. Interrupt it (its finalize becomes a no-op via the
    // _streamTurnSeq bump) and preserve its partial output before resetting.
    console.log(`[multicc/chat] [${sessionName}] (streaming) new message while turn busy → interrupting previous`);
    cs._killReason = 'new_user_message';
    cs._streamTurnSeq = (cs._streamTurnSeq || 0) + 1; // supersede the in-flight turn's finalize
    chatStream.cancel(sessionName);
    cs.isStreaming = false;
    cs.streamReplay = [];
    if (cs.currentAssistantText || cs.currentToolCalls.length) {
      appendChatMessage(sessionName, {
        role: 'assistant', content: cs.currentAssistantText,
        tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
        ts: Date.now(), cancelled: true,
      });
      cs.chatTurnCount++;
    }
  }

  // Save user message to history. bgTaskIds/bgToolUseIds are present ONLY on
  // background-completion result injections — they let history (and the UI)
  // attribute this message back to the task(s) / tool_use block that originated
  // it. Omitted (undefined, not null) for ordinary user messages and every other
  // inject path, so old history and other callers are completely unaffected.
  appendChatMessage(sessionName, {
    role: 'user', content: text, ts: Date.now(),
    clientMsgId: clientMsgId || undefined,
    bgTaskIds: Array.isArray(bgTaskIds) && bgTaskIds.length ? bgTaskIds : undefined,
    bgToolUseIds: Array.isArray(bgToolUseIds) && bgToolUseIds.length ? bgToolUseIds : undefined,
  });

  // Reset accumulators
  cs.currentAssistantText = '';
  cs.currentUserText = text;          // store user message for summary context
  // Synchronous task goal fallback (zero-latency first frame); the in-progress
  // classify loop will refine it to a stable noun-phrase goal within 60s.
  ensureCurrentTask(cs, sessionName, text);
  cs.currentTaskName = cs.currentTask ? cs.currentTask.goal : '新任务'; // compat for legacy callers
  cs.currentToolCalls = [];
  cs.currentCost = null;
  cs.isStreaming = true;
  cs.turnStartedAt = Date.now();  // for per-reply interaction latency (durationMs)
  cs.lastStreamAt = cs.turnStartedAt;  // watchdog baseline: don't inherit prior turn's stale lastStreamAt
  cs.streamReplay = [];
  cs._resultSaved = false;
  // Reset the per-turn role breakdown (main vs sub) collected by the claude-proxy
  // onUsage hook. A new user turn starts a fresh "本轮" window, so stale subagent
  // totals from the previous turn must not bleed into the new one.
  roleTokenTracker.reset(sessionName);
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
  // Marks this turn as initiated by an auto-trigger, so post-turn triggers
  // don't recurse on their own output (see firePostTurnTriggers).
  cs._originTrigger = !!originTrigger;
  cs.originDispatchId = originDispatchId || null;
  setSessionStatus(sessionName, { status: 'thinking', currentFile: null });

  const provider = providerFor(cs);
  // For claude: first turn → --session-id <uuid>, subsequent → --resume <uuid>.
  // For codex:  first turn → exec --json, subsequent → exec resume <id> --json.
  const isFirstTurn = (typeof forceFirstTurn === 'boolean') ? forceFirstTurn : (cs.chatTurnCount === 0 || !persisted.cliSessionId);

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
        resolveRolePrompt, multiccImgHint: MULTICC_IMG_HINT,
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
    try { chatBroadcast(sessionName, { type: 'error', error: `消息组装失败：${e && e.message ? e.message : e}` }); } catch (_) {}
    setSessionStatus(sessionName, { status: 'idle', currentFile: null });
    cs.isStreaming = false;
    return false;
  }
  const promptText = renderPrompt(envelope);
  // Provider routing is resolved before every invocation so all runners consume
  // the same adapter-produced command contract.
  const provEnv = providers.resolveSpawnEnv(persisted);
  const invocationEnvelope = {
    ...envelope,
    spawnOpts: {
      ...envelope.spawnOpts,
      skipDefaultModel: provEnv.skipDefaultModel,
      providerModel: provEnv.providerModel,
      providerModels: provEnv.providerModels,
    },
  };
  const invocation = provider.buildInvocation(invocationEnvelope);

  // ── Streaming path (claude only — always on) ──
  // Persistent process kept warm across turns so a turn that ends in a
  // "waiting for external data" state leaves a live, in-context process ready
  // to continue (fed by the next message / the waiting-injector) instead of a
  // dead one needing a cold --resume. Streaming is now claude chat's only mode
  // (the per-turn toggle was removed); non-claude CLIs use the per-turn spawn
  // path below, unchanged.
  if (cs.cli === 'claude') {
    return runChatTurnStreaming(sessionName, cs, persisted, invocation, provider);
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

  const spawnChat = (spawnArgs, isRetry) => {
    // buildChildEnv strips inherited ANTHROPIC_* routing vars (which may have
    // leaked into the multicc server's own env) before applying the session's
    // provider env, so the per-session provider choice is always authoritative.
    const { env: childEnv } = providers.buildChildEnv(process.env, persisted, {
      TERM: 'dumb', NO_COLOR: '1',
      // Let the bundled multicc-trigger skill know who it is and where the
      // localhost API lives, so it can register/manage triggers for us.
      MULTICC_SESSION_ID: sessionName,
      MULTICC_DIR_ID: persisted.dirId || '',
      MULTICC_BASE_URL: `http://127.0.0.1:${PORT}`,
    });
    providers.applyClaudeProxyEnv(childEnv, {
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
    const proc = spawn(invocation.cmd, spawnArgs, {
      cwd: cs.cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cs.claudeProc = proc;

    const spawnTs = Date.now();
    console.log(`[multicc/chat] [${sessionName}] ${cs.cli} spawned pid=${proc.pid} turn=${cs.chatTurnCount} isRetry=${!!isRetry} clients=${cs.clients.size}`);
    let stderrBuf = '';
    const isActiveProc = () => cs.claudeProc === proc;

    // Normalize a single JSONL line into the claude-shaped event stream the frontend
    // already consumes. Returns an array of events to forward (may be empty), or null
    // to forward the original event as-is (claude path).
    const handleLine = (line) => {
      let evt;
      try { evt = JSON.parse(line); } catch { return; }

      applyAdapterChatEvent(provider, cs, persisted, sessionName, evt, forward);
    };

    const forward = (evt) => {
      cs.lastStreamAt = Date.now();  // watchdog: last live stream activity (stuck-isStreaming detection)
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
      console.error(`[multicc/chat] stderr: ${chunk.toString().slice(0, 200)}`);
    });

    proc.on('error', (err) => {
      if (!isActiveProc()) return;
      console.error(`[multicc/chat] [${sessionName}] pid=${proc.pid} spawn error: ${err.message}`);
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
      const killReason = cs._killReason || null;
      cs._killReason = null;
      const pendingStreamError = cs._codexPendingStreamError || '';
      const pendingTransportError = cs._codexTransportError || '';
      const pendingStreamErrorCount = cs._codexPendingStreamErrorCount || 0;
      const hasTurnOutput = !!(cs._resultSaved || cs.currentAssistantText || cs.currentToolCalls.length);
      if (pendingStreamError && !hasTurnOutput && !cs._adapterError) {
        cs._adapterError = pendingStreamError;
        chatBroadcast(sessionName, { type: 'error', error: `Codex 出错：${pendingStreamError}` });
      }
      const recoveredCodexDisconnect = (!!cs._codexRecoveredDisconnect || !!pendingStreamError) && hasTurnOutput;
      const diag = {
        session: sessionName, cli: cs.cli, pid: proc.pid, code, signal, durMs, killReason,
        resultSaved: !!cs._resultSaved,
        gotText: (cs.currentAssistantText || '').length,
        toolCalls: cs.currentToolCalls.length,
        liveClients: cs.clients.size,
        isRetry: !!isRetry,
        recoveredCodexDisconnect,
        pendingTransportError: pendingTransportError.slice(0, 200),
        pendingStreamErrorCount,
        stderrTail: stderrBuf.slice(-300).trim(),
      };
      let kind = 'normal';
      if (signal) kind = killReason ? `killed(${killReason})` : `signaled(${signal})`;
      else if (code !== 0 && !recoveredCodexDisconnect) kind = 'nonzero_exit';
      else if (!cs._resultSaved && !cs.currentAssistantText && !cs.currentToolCalls.length) kind = 'empty_exit';
      console.log(`[multicc/chat] [${sessionName}] close kind=${kind} ${JSON.stringify(diag)}`);
      if (
        cs.cli === 'codex' &&
        pendingStreamError &&
        hasTurnOutput &&
        !cs._resultSaved &&
        !killReason &&
        persisted.cliSessionId &&
        (cs._codexStreamContinuationCount || 0) < CODEX_STREAM_DISCONNECT_CONTINUE_MAX
      ) {
        cs._codexStreamContinuationCount = (cs._codexStreamContinuationCount || 0) + 1;
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
        cs.claudeProc = spawnChat(continueArgs, true);
        return;
      }
      cs.isStreaming = false;
      cs.streamReplay = [];

      // A cross-CLI switch that restored a previous target-native session must
      // fail closed if resume produces no output. Silently starting a fresh
      // thread would erase target-side context while making the UI look
      // continuous. The user can explicitly retry the switch with fresh:true;
      // the pending checkpoint is retained until a successful target result.
      const guardedHandoffResumeFailure = !!(
        !isRetry
        && persisted.pendingCliHandoff
        && persisted.pendingCliHandoff.status === 'pending'
        && persisted.pendingCliHandoff.reusedTarget
        && persisted.pendingCliHandoff.toCli === cs.cli
        && !cs.currentAssistantText
        && !cs.currentToolCalls.length
        && !killReason
        && !cs._adapterError
      );
      if (guardedHandoffResumeFailure) {
        cs._adapterError = 'cross-cli target resume failed';
        chatBroadcast(sessionName, {
          type: 'error',
          error: `目标 ${cs.cli} 原生会话恢复失败；未自动创建新会话。请重新切换并选择“重置目标 CLI 会话”。`,
        });
      }

      // If spawn yielded no assistant text and it's not a user-initiated kill, retry
      // once with a fresh session id (covers resume-failed / session-id conflict cases).
      // A reported adapter error is a real provider failure, not a
      // resume glitch — retrying would just hit the same wall, so skip it.
      if (!guardedHandoffResumeFailure && !isRetry && !cs.currentAssistantText && !cs.currentToolCalls.length && !killReason && !cs._adapterError) {
        const stderrTail = stderrBuf.slice(-300).trim();
        const reason = pendingTransportError ? 'codex transport disconnected'
          : stderrTail.includes('already in use') ? 'session-id conflict'
          : stderrTail.includes('No conversation found') || stderrTail.includes('session not found') ? 'resume target missing'
          : `exit ${code}${signal ? '/' + signal : ''}`;
        console.warn(`[multicc/chat] [${sessionName}] ${cs.cli} yielded no output (${reason}), retrying fresh. stderr: ${stderrTail.slice(0, 200)}`);
        // Reset session id so the retry starts a brand-new conversation
        if (cs.cli === 'claude') persisted.cliSessionId = crypto.randomUUID();
        else persisted.cliSessionId = null;  // codex will allocate on first turn
        rememberActiveCliState(persisted);
        savePersistedSessions();
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
        cs.claudeProc = spawnChat(fallbackArgs, true);
        return;
      }

      if (isRetry && !cs.currentAssistantText && !cs.currentToolCalls.length) {
        const stderrTail = stderrBuf.slice(-300).trim();
        chatBroadcast(sessionName, {
          type: 'error',
          error: pendingTransportError
            ? `Codex 出错：${pendingTransportError}`
            : stderrTail ? `${cs.cli} 无响应：${stderrTail}` : `${cs.cli} 无响应（exit ${code}${signal ? '/' + signal : ''}）`,
        });
      }

      cs.claudeProc = null;

      // Clear any pending incremental save timer — the full message is saved below.
      const incrTimer = _incrSaveTimers.get(sessionName);
      if (incrTimer) { clearTimeout(incrTimer); _incrSaveTimers.delete(sessionName); }

      let savedInClose = false;
      if (!cs._resultSaved && (cs.currentAssistantText || cs.currentToolCalls.length)) {
        appendChatMessage(sessionName, {
          role: 'assistant', content: cs.currentAssistantText,
          tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
          cost: cs.currentCost, ts: Date.now(),
        });
        cs.chatTurnCount++;
        savedInClose = true;
      }
      if (recoveredCodexDisconnect && (savedInClose || cs._resultSaved)) {
        chatBroadcast(sessionName, {
          type: 'result',
          total_cost_usd: null,
          usage: {},
          durationMs: cs.turnStartedAt ? Date.now() - cs.turnStartedAt : undefined,
          num_turns: cs.chatTurnCount,
        });
        // intent_classify will be triggered by classifyTurnEnd below
      }
      const finalText = cs.currentAssistantText;
      cs.currentAssistantText = '';
      cs.currentToolCalls = [];
      cs._resultSaved = false;
      const hadAdapterError = !!cs._adapterError && !recoveredCodexDisconnect; cs._adapterError = null;
      cs._codexRecoveredDisconnect = false;
      cs._codexPendingStreamError = '';
      cs._codexPendingStreamErrorCount = 0;
      cs._codexTransportError = '';
      cs._codexStreamContinuationCount = 0;
      // classify prompt + dispatchStateAction handles API errors via state E.
      // Capture the flag before resetting so the branch below can reference it.
      const sawApi = cs._sawApiError; cs._sawApiError = false;

      // Resting status — classifyTurnEnd is the single decider of D/C/W/E/P.
      if (killReason) {
        setSessionStatus(sessionName, { status: 'idle', currentFile: null });
      } else if (kind === 'normal' || sawApi || hadAdapterError || kind === 'nonzero_exit' || kind === 'signaled') {
        classifyTurnEnd(cs, sessionName);
        if (auxQueue.isUnhealthy()) {
          setSessionStatus(sessionName, { status: 'idle', currentFile: null });
        }
      } else {
        setSessionStatus(sessionName, { status: 'idle', currentFile: null });
      }
      chatBroadcast(sessionName, { type: 'stream_end' });

      // Auto-回流: turn was dispatched on the gateway's behalf → push result back.
      // Guarded: this runs inside a child-process 'close' handler, so an uncaught
      // throw here would crash the whole server (no global handler).
      try {
        if (cs.originDispatchId) {
          const did = cs.originDispatchId;
          cs.originDispatchId = null;
          // Decoupled via the bus so chat doesn't depend on the gateway domain.
          bus.emit('chat:dispatch-complete', did, sessionName, finalText);
        } else if (persisted.type === 'gateway') {
          // Gateway's own turn: detect a dispatch marker → stage pending confirmation.
          bus.emit('chat:gateway-turn-complete', finalText);
        } else if (persisted.type !== 'aux') {
          // Any other chat session: a <<dispatch>> marker fans work out to siblings.
          maybeDispatchFromChatTurn(sessionName, finalText);
        }
      } catch (e) {
        console.error('[multicc/dispatch] post-turn hook failed:', e.message);
      }
    });

    return proc;
  };

  cs.claudeProc = spawnChat(args, false);

  return true;
}
// Chat domain owns runChatTurn; other domains reach it without require()-ing chat:
//  • fire-and-forget (triggers): bus event 'chat:run'
//  • need the return value (gateway): registry service 'chat.runTurn'
bus.on('chat:run', (sessionName, text, opts) => runChatTurn(sessionName, text, opts));
services.provide('chat.runTurn', runChatTurn);

// ── Wait injector: continue a session when external data arrives (A/B/D) ──
waitInjector.init({
  // All continuations route through runChatTurn → streaming sessions get the
  // warm process (queued if busy), default sessions get a --resume turn.
  // opts (e.g. { bgTaskIds, bgToolUseIds } from the bg-completion coalescer) are
  // forwarded so an injected continuation can carry origin metadata onto the
  // saved user message. originContinue stays the default for every inject path.
  inject: (session, text, opts) => runChatTurn(session, text, { originContinue: true, ...(opts || {}) }),
  isBusy: (session) => {
    const cs = chatSessions.get(session);
    if (cs && cs.claudeProc) return true;
    const st = chatStream.status(session);
    return !!(st && st.busy);
  },
  exec: (cmd, cwd) => new Promise((resolve) => {
    require('child_process').exec(cmd, { cwd, timeout: 20000, maxBuffer: 1024 * 1024, env: process.env },
      (err, stdout, stderr) => resolve({ stdout: stdout || '', stderr: stderr || '', code: err ? (err.code || 1) : 0 }));
  }),
  log: (m) => console.log('[multicc/wait]', m),
});

// Register a wait — called by the model via localhost (MULTICC_BASE_URL) when it
// needs to pause for external data instead of ending the turn dead.
//   poll:     { mode:'poll', pollCmd|pollUrl, untilContains|untilRegex, intervalSec?, maxChecks?, injectPrefix? }
//   callback: { mode:'callback', injectPrefix?, timeoutSec? } → returns a callbackUrl
app.post('/api/sessions/:id/wait', (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const b = req.body || {};
  try {
    const reg = waitInjector.register({
      session: s.id, mode: b.mode, cwd: cwdForSession(s),
      pollCmd: b.pollCmd, pollUrl: b.pollUrl,
      untilContains: b.untilContains, untilRegex: b.untilRegex,
      intervalSec: b.intervalSec, maxChecks: b.maxChecks,
      injectPrefix: b.injectPrefix, timeoutSec: b.timeoutSec,
    });
    const callbackUrl = `${req.protocol}://${req.get('host')}/api/wait/${reg.id}/resolve?token=${reg.token}`;
    res.json({ ok: true, ...reg, callbackUrl });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Resolve a callback wait — the external system POSTs its result here. Secured
// by the per-wait token (exempt from ACCESS_TOKEN so off-box callers can reach it).
app.post('/api/wait/:wid/resolve', (req, res) => {
  const token = req.query.token || req.headers['x-wait-token'] || (req.body && req.body.token);
  const data = (req.body && req.body.data !== undefined) ? req.body.data : (req.body ?? '');
  const r = waitInjector.resolve(req.params.wid, token, data);
  res.status(r.ok ? 200 : 400).json(r);
});

app.get('/api/sessions/:id/waits', (req, res) => {
  res.json({ waits: waitInjector.listForSession(req.params.id), stats: waitInjector.stats() });
});

app.delete('/api/wait/:wid', (req, res) => {
  res.json(waitInjector.cancel(req.params.wid));
});

// ── Detached tasks ──
// Run a long-running command (build / batch / deploy) that must OUTLIVE the
// current chat turn. A bare `&`/nohup started from an agent's bash is a child of
// that transient shell and gets reaped when the turn ends — the job dies and the
// session never resumes (looks like a hang). This launches the command from the
// server with setsid (detached), so it survives the turn AND a server restart,
// then auto-registers a poll that injects the exit code + output tail back into
// the session on completion. Body: { command, cwd?, label?, intervalSec?,
// maxChecks?, injectPrefix? }.
app.post('/api/sessions/:id/run-detached', (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const b = req.body || {};
  const command = (b.command || b.cmd || '').toString();
  if (!command.trim()) return res.status(400).json({ error: 'command required' });
  try {
    const baseCwd = cwdForSession(s);
    const cwd = b.cwd ? resolveCwd(baseCwd, String(b.cwd)) : baseCwd;
    const job = detached.launch({ command, cwd, label: b.label });
    const label = (b.label || command.replace(/\s+/g, ' ').slice(0, 60)).trim();
    // Daemon mode: for long-running services (dev server, API, etc.) that never
    // exit on their own. The done-file model (poll until process exits) doesn't
    // apply — the poll would always time out and produce false "[轮询超时]"
    // injections. Instead, just launch the process and return; the caller can
    // check status via GET /api/detached/:taskId at any time.
    const isDaemon = b.daemon === true || b.daemon === 'true';
    if (isDaemon) {
      res.json({ ok: true, taskId: job.id, waitId: null, pid: job.pid, logPath: job.logPath, daemon: true });
      return;
    }
    // Normal mode: 10s interval × 360 checks ≈ 1h ceiling before the poll gives up; tune via body.
    const intervalSec = Math.max(3, Number(b.intervalSec) || 10);
    const maxChecks = Math.max(1, Number(b.maxChecks) || 360);
    const reg = waitInjector.register({
      session: s.id, mode: 'poll', cwd,
      pollCmd: job.pollCmd, untilContains: job.doneMarker,
      intervalSec, maxChecks,
      injectPrefix: b.injectPrefix || `[后台任务完成] ${label}`,
    });
    res.json({ ok: true, taskId: job.id, waitId: reg.id, pid: job.pid, logPath: job.logPath, intervalSec, maxChecks });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Inspect detached tasks (survives restart — read from disk).
app.get('/api/sessions/:id/detached', (req, res) => {
  res.json({ tasks: detached.list() });
});
app.get('/api/detached/:taskId', (req, res) => {
  const st = detached.status(req.params.taskId);
  if (!st) return res.status(404).json({ error: 'task not found' });
  res.json(st);
});

// ── Streaming chat turn (persistent process; see runChatTurn's streaming branch) ──
// Feeds the prompt into the session's long-lived `claude` process and forwards
// events through the SAME applyClaudeChatEvent() the per-turn path uses, so the
// UI sees identical events. The turn boundary is the `result` event (handled
// inside applyClaudeChatEvent); finalizeStreamingTurn() then does the
// process-independent cleanup (stream_end, gateway回流) WITHOUT killing the proc.
function runChatTurnStreaming(sessionName, cs, persisted, invocation, provider) {
  // Per-session provider env. buildChildEnv strips inherited ANTHROPIC_* routing
  // vars before applying the provider env, so the provider choice is always
  // authoritative — see providers.CLAUDE_ROUTING_KEYS. The full computed env is
  // passed through; chat-stream uses it verbatim (no second process.env merge).
  const { env: childEnv } = providers.buildChildEnv(process.env, persisted, {
    TERM: 'dumb', NO_COLOR: '1',
    MULTICC_SESSION_ID: sessionName,
    MULTICC_DIR_ID: persisted.dirId || '',
    MULTICC_BASE_URL: `http://127.0.0.1:${PORT}`,
  });
  // Route through the local claude-proxy (per-session + per-role). Only takes
  // effect for provider-backed sessions; default-login sessions bypass.
  providers.applyClaudeProxyEnv(childEnv, {
    providerId: persisted.provider, sessionId: sessionName,
    subagent: persisted.subagent, port: PORT, enabled: CLAUDE_PROXY_ENABLED,
    officialOAuth: CLAUDE_OFFICIAL_VIA_PROXY,
  });
  // Streaming uses a SEPARATE session UUID (stored on the persisted record as
  // _streamSessionId) so the persistent process never collides with the per-turn
  // spawn path which uses cliSessionId. Both paths share the same Claude project
  // directory (keyed on cwd), and the streaming process is the single source of
  // truth for streaming sessions — per-turn spawns are never used concurrently.
  const resumeExistingStream = !!persisted._streamSessionId;
  if (!persisted._streamSessionId) {
    persisted._streamSessionId = crypto.randomUUID();
    rememberActiveCliState(persisted);
    savePersistedSessions();
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
      savePersistedSessions();
    },
    beforeSpawn: ({ sessionId }) => {
      const cleaned = typeof provider.prepareSpawn === 'function'
        ? provider.prepareSpawn({ sessionId })
        : 0;
      if (cleaned > 0) {
        chatHistories.delete(sessionName);
        console.log(`[multicc/chat] [${sessionName}] sanitized ${cleaned} empty thinking block(s) from session JSONL`);
      }
    },
    env: childEnv,
    onBackgroundEvent: (evt) => handleBackgroundTaskEvent(sessionName, cs, evt),
  });

  // An in-flight turn (if any) was already interrupted at the top of
  // runChatTurn. Claim this turn's sequence number so a late finalize from a
  // superseded turn can't clobber us.
  const mySeq = cs._streamTurnSeq = (cs._streamTurnSeq || 0) + 1;

  const forward = (evt) => {
    cs.lastStreamAt = Date.now();  // watchdog: last live stream activity (stuck-isStreaming detection)
    cs.streamReplay.push(evt);
    if (cs.streamReplay.length > 500) cs.streamReplay.shift();
    chatBroadcast(sessionName, evt);
  };

  console.log(`[multicc/chat] [${sessionName}] (streaming) send turn=${cs.chatTurnCount} model=${persisted.model || 'default'} status=${JSON.stringify(chatStream.status(sessionName))}`);
  chatStream.send(sessionName, invocation.payload, (evt) => {
    applyAdapterChatEvent(provider, cs, persisted, sessionName, evt, forward);
  })
    .then(() => finalizeStreamingTurn(sessionName, cs, persisted, mySeq))
    .catch((err) => {
      console.warn(`[multicc/chat] [${sessionName}] (streaming) turn ended early: ${err.message}`);
      finalizeStreamingTurn(sessionName, cs, persisted, mySeq);
    });

  return true;
}

// Process-independent end-of-turn cleanup for the streaming path. Guarded by
// the turn sequence so a superseded (interrupted) turn's late completion can't
// clobber the turn that replaced it.
function finalizeStreamingTurn(sessionName, cs, persisted, seq) {
  if (seq !== undefined && cs._streamTurnSeq !== seq) return; // superseded by a newer turn
  cs.isStreaming = false;
  cancelClassify(cs);
  cs.streamReplay = [];
  // applyClaudeChatEvent already saved on the `result` event (cs._resultSaved);
  // this only fires for an interrupted/aborted turn that has partial output.
  if (!cs._resultSaved && (cs.currentAssistantText || cs.currentToolCalls.length)) {
    appendChatMessage(sessionName, {
      role: 'assistant', content: cs.currentAssistantText,
      tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
      cost: cs.currentCost, ts: Date.now(),
    });
    cs.chatTurnCount++;
  }
  const finalText = cs.currentAssistantText;
  cs.currentAssistantText = '';
  cs.currentToolCalls = [];
  // A clean turn fired the `result` event (set _resultSaved); an interrupted /
  // dropped turn lands here without it. Capture before the reset below.
  const completedOk = cs._resultSaved;
  cs._resultSaved = false;
  // Why the turn ended, captured before reset: user_cancel / new_user_message are
  // deliberate stops (never recovered); any other !completedOk end is a fault.
  const killReason = cs._killReason || null;
  cs._killReason = null;
  const userStopped = killReason === 'user_cancel' || killReason === 'new_user_message';
  const handoff = persisted.pendingCliHandoff;
  const guardedHandoffResumeFailure = !!(
    !completedOk
    && !userStopped
    && handoff
    && handoff.status === 'pending'
    && handoff.reusedTarget
    && handoff.toCli === persisted.cli
  );
  // classify prompt + dispatchStateAction handles API errors via state E → retry.
  const sawApi = cs._sawApiError; cs._sawApiError = false;
  // Let classify decide the final status. If sawApi, always defer to classify.
  // classify; otherwise emit the obvious outcome.
  if (guardedHandoffResumeFailure) {
    waitInjector.resetInterrupted(sessionName);
    setSessionStatus(sessionName, { status: 'idle', currentFile: null });
    chatBroadcast(sessionName, {
      type: 'error',
      error: '目标 Claude 原生会话恢复异常；未自动新建或重试。请重新切换并选择“重置目标 CLI 会话”。',
    });
  } else if (sawApi) {
    classifyTurnEnd(cs, sessionName);
  } else if (completedOk) {
    // Clean end: the turn fired its `result` event — whether the task is done or
    // the assistant paused to ask the user. Never auto-recovered. Clear the
    // interrupt-resume counter so a past fault doesn't leak into the next turn.
    waitInjector.resetInterrupted(sessionName);
    emitTurnOutcome(sessionName, { status: 'completed', notifyState: 'completed', message: '任务完成', alert: false });
  } else {
    // 非正常中断: the stream ended WITHOUT a `result` event and WITHOUT an API error
    // — the turn was cut (proc/stream died, connection dropped, truncated, watchdog
    // kill, restart mid-turn). Absence of the `result` event is the DETERMINISTIC
    // interrupt fingerprint — no LLM guess. Auto-recover it (the only non-fault case
    // we recover) unless the user stopped it themselves. resumeInterrupted is
    // hasWait-guarded + capped (MAX_RESUME_INTERRUPTED) against a drop-loop.
    if (!userStopped && waitInjector.resumeInterrupted(sessionName)) {
      console.log(`[multicc/chat] [${sessionName}] (streaming) 非正常中断 (no result event, kill=${killReason || 'none'}) → resume`);
    } else {
      setSessionStatus(sessionName, { status: 'idle', currentFile: null });
    }
  }
  chatBroadcast(sessionName, { type: 'stream_end' });

  // Gateway/dispatch回流 — same hooks the per-turn close handler fires.
  try {
    if (guardedHandoffResumeFailure) return;
    if (cs.originDispatchId) {
      const did = cs.originDispatchId;
      cs.originDispatchId = null;
      bus.emit('chat:dispatch-complete', did, sessionName, finalText);
    } else if (persisted.type === 'gateway') {
      bus.emit('chat:gateway-turn-complete', finalText);
    } else if (persisted.type !== 'aux') {
      maybeDispatchFromChatTurn(sessionName, finalText);
    }
  } catch (e) {
    console.error('[multicc/dispatch] post-turn hook failed:', e.message);
  }
}

// ── Chat mode: stream-json WebSocket ──
function handleChatWs(ws, req, urlObj) {
  const sessionName = urlObj.searchParams.get('session') || '_default';
  const persisted = persistedSessions.get(sessionName);
  if (!persisted) {
    ws.send(JSON.stringify({ type: 'error', error:
      `Chat session "${sessionName}" does not exist. Create it via the dashboard first.` }));
    ws.close();
    return;
  }
  if (persisted.kind && persisted.kind !== 'chat') {
    ws.send(JSON.stringify({ type: 'error', error:
      `Session "${sessionName}" is not a chat session (kind=${persisted.kind}).` }));
    ws.close();
    return;
  }
  if (invalidSessions.has(sessionName)) {
    ws.send(JSON.stringify({ type: 'error', error:
      `会话已失效（${invalidSessions.get(sessionName)}），请删除后重建。` }));
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
      savePersistedSessions();
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
    };
    chatSessions.set(sessionName, cs);
  }

  cs.clients.add(ws);

  // Resolve provider info for this session (for token-window display).
  // (`persisted` is already declared+validated at the top of handleChatWs.)
  const provId = (persisted && persisted.provider) || null;
  let provName = null;
  if (provId) {
    try { provName = providers.getProvider(undefined, provId)?.name || null; } catch (_) {}
  }
  // Time-window token stats for the session's provider.
  const dailyWindows = providers.readDailyWindows();
  const provWindows = provId ? {
    today: (dailyWindows.today && dailyWindows.today[provId]) || null,
    week: (dailyWindows.week && dailyWindows.week[provId]) || null,
    month: (dailyWindows.month && dailyWindows.month[provId]) || null,
    all: (dailyWindows.all && dailyWindows.all[provId]) || null,
  } : null;

  // Fallback: when no daily data exists yet for this provider, compute
  // all-time totals from token_usage.json so the context bar always shows
  // something immediately (instead of waiting for a new turn to populate
  // token_daily.json).
  if (provId && provWindows && !provWindows.all) {
    const accum = getTokenUsage();
    let allIn = 0, allOut = 0, allTurns = 0;
    for (const [sid, entry] of Object.entries(accum)) {
      const sp = persistedSessions.get(sid);
      if ((sp && sp.provider === provId) || sid === sessionName) {
        allIn += entry.inputTokens || 0;
        allOut += entry.outputTokens || 0;
        allTurns += entry.turnCount || 0;
      }
    }
    if (allIn + allOut > 0) {
      provWindows.all = { inputTokens: allIn, outputTokens: allOut, turnCount: allTurns };
    }
  }

  ws.send(JSON.stringify({
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
  }));

  // Replay saved history + in-progress assistant response (if any).
  // Send only the newest page over WS on connect; older messages are fetched
  // on demand via GET /history?before=<id> as the user scrolls up.
  const history = loadChatHistory(sessionName);
  // Only append an in-progress copy when the turn's output has NOT yet been
  // persisted. Between the `result` event (applyClaudeChatEvent saves it and
  // sets _resultSaved) and finalizeStreamingTurn (which clears
  // currentAssistantText), a reconnect would otherwise append a duplicate of
  // the already-saved assistant message — two identical bubbles. Guarding on
  // !_resultSaved closes that race (matches the "unsaved" intent below).
  const hasInProgress = !cs._resultSaved && !!(cs.currentAssistantText || cs.currentToolCalls.length);
  const page = paginateChatHistory(history, { limit: CHAT_HISTORY_PAGE });
  const replayMessages = [...page.messages];
  // Append unsaved in-progress response so reconnecting clients see current state
  if (hasInProgress) {
    replayMessages.push({
      role: 'assistant',
      content: cs.currentAssistantText,
      tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
      ts: Date.now(),
      streaming: cs.isStreaming || false,
    });
  }
  // Include authoritative cumulative token usage from the persistent
  // accumulator so the frontend doesn't need to reconstruct it from the
  // rolling chat_history window (which trims old messages).
  const tokenUsage = getTokenUsage();
  const sessionTokenUsage = tokenUsage[sessionName] || null;
  if (replayMessages.length > 0 || sessionTokenUsage) {
    ws.send(JSON.stringify({ type: 'chat_history', messages: replayMessages, tokenUsage: sessionTokenUsage, hasMore: page.hasMore }));
    // Seed the aux classify bar with the current task snapshot on connect, so
    // the goal/phase shows immediately (not only after the next classify).
    try {
      const ts0 = getTaskState(persistedSessions.get(sessionName));
      if (ts0 && (ts0.goal || (ts0.phase && ts0.phase !== 'idle'))) {
        ws.send(JSON.stringify({ type: 'task_state', goal: ts0.goal || '', phase: ts0.phase || 'idle', classifyState: ts0.classifyState || null }));
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

  // If a stream is in progress, replay buffered events so reconnected client catches up
  if (cs.isStreaming && cs.streamReplay.length > 0) {
    for (const evt of cs.streamReplay) {
      try { ws.send(JSON.stringify(evt)); } catch (_) {}
    }
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Heartbeat is always allowed.
      if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {}
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
        cancelClassify(cs);
        if (cs.cli === 'claude' && chatStream.isAlive(sessionName)) {
          console.log(`[multicc/chat] [${sessionName}] (streaming) cancel requested by user`);
          cs._killReason = 'user_cancel';
          // proc death → finalizeStreamingTurn fires (stream_end + idle). Don't
          // bump the seq here so that finalize is NOT superseded.
          chatStream.cancel(sessionName);
          cs.isStreaming = false;
          cs.streamReplay = [];
        }
        if (cs.claudeProc) {
          console.log(`[multicc/chat] [${sessionName}] Cancel requested by user, killing claude pid=${cs.claudeProc.pid}`);
          cs._killReason = 'user_cancel';
          try { cs.claudeProc.kill('SIGTERM'); } catch (_) {}
          cs.claudeProc = null;
          cs.lineBuf = '';
          cs.isStreaming = false;
          cs.streamReplay = [];
        }
        // Save partial response if any
        if (cs.currentAssistantText || cs.currentToolCalls.length) {
          appendChatMessage(sessionName, {
            role: 'assistant', content: cs.currentAssistantText,
            tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
            ts: Date.now(), cancelled: true,
          });
          cs.currentAssistantText = '';
          cs.currentToolCalls = [];
        }
        return;
      }

      if (msg.type === 'clear_history') {
        const h = chatHistories.get(sessionName);
        const keep = Math.max(0, parseInt(msg.keep || '0', 10) || 0);
        let retained = [];
        let memoryDistill = null;
        if (keep > 0 && h) {
          // Keep the last N messages (typically user/assistant pairs), distill the rest.
          // If history is shorter than N, retain all of it rather than falling
          // through to the clear-all branch.
          const removed = h.splice(0, Math.max(0, h.length - keep));
          if (removed.length) memoryDistill = distillHistoryIntoMemory(sessionName, removed);
          retained = h.slice();
        } else {
          // Distill the soon-to-be-discarded conversation into long-lived session
          // memory BEFORE wiping it (key problems + how they were solved).
          if (h && h.length) memoryDistill = distillHistoryIntoMemory(sessionName, h.slice());
          if (h) h.length = 0;
        }
        saveChatHistory(sessionName);
        // Reset every vendor-native session. Clearing only the active CLI lets
        // an old conversation reappear after switching away and back.
        const pExisting = persistedSessions.get(sessionName);
        if (pExisting) {
          chatStream.close(sessionName);
          delete pExisting.pendingCliHandoff;
          const cleared = clearAllNativeCliStates(pExisting);
          if (keep > 0 && retained.length) {
            const checkpoint = buildHandoffCheckpoint({
              session: pExisting,
              fromCli: cs.cli,
              toCli: cs.cli,
              history: retained,
              git: cliSwitchGitSnapshot(pExisting),
            });
            checkpoint.reason = 'history_clear_keep';
            pExisting.pendingCliHandoff = {
              id: `checkpoint_${crypto.randomBytes(8).toString('hex')}`,
              fromCli: cs.cli,
              toCli: cs.cli,
              createdAt: checkpoint.createdAt,
              status: 'pending',
              reason: 'history_clear_keep',
              reusedTarget: false,
              checkpoint,
            };
          }
          rememberActiveCliState(pExisting);
          savePersistedSessions();
          console.log(`[multicc/chat] Cleared history and reset ${cleared} native CLI session(s) for ${sessionName}`);
        }
        cs.chatTurnCount = 0;
        // Clear resets all native contexts. Gate the first following turn until
        // distillation has landed in _auto.md, otherwise that fresh context can
        // freeze the old memory snapshot for its entire lifetime.
        if (memoryDistill) _trackPendingMemoryDistill(sessionName, memoryDistill);
        return;
      }

      if (msg.type === 'user_message' && msg.text) {
        // Gateway: a bare 确认/取消 resolves a pending dispatch without running the LLM.
        if (persisted.type === 'gateway' && handleGatewayControl(msg.text)) return;
        // Goal mode: client flags the message; server applies the configured
        // round/budget limits (per-send override merged over the global config).
        const turnOpts = msg.goal ? { goalLimits: resolveGoalLimits(msg.goalLimits) } : {};
        if (typeof msg.clientMsgId === 'string' && msg.clientMsgId.trim()) {
          turnOpts.clientMsgId = msg.clientMsgId;
        }
        const pendingMemory = _memoryDistillPending.get(sessionName);
        if (pendingMemory) {
          const queuedText = msg.text;
          pendingMemory.finally(() => runChatTurn(sessionName, queuedText, turnOpts));
        } else {
          runChatTurn(sessionName, msg.text, turnOpts);
        }
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
    const isLocal = (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') && !isExternalProxy(req);
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
    return handleWorkspaceWs(ws, req, urlObj);
  }

  // Route to the global meta event bus (all directories, all sessions).
  // Subscribers receive every workspace event fleet-wide, plus an initial
  // snapshot of every session across every directory. The voice/meta assistant
  // subscribes here to hold the whole board.
  if (urlObj.pathname === '/ws/meta') {
    return handleMetaWs(ws, req);
  }

  // Route to aux queue monitor (read-only WebSocket for __aux__ session)
  if (urlObj.pathname === '/ws/aux') {
    auxQueue.clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // Send current status + recent history on connect
    ws.send(JSON.stringify({ type: 'aux_init', status: auxQueue.getStatus(), health: { ...auxQueue.health } }));
    const history = loadChatHistory(AUX_SESSION_ID);
    ws.send(JSON.stringify({ type: 'aux_history', messages: history.slice(-100) }));
    ws.on('close', () => { auxQueue.clients.delete(ws); });
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
      ws.send(JSON.stringify({ type: 'error', data:
        `Session ${sessionId} does not exist.\r\n` +
        `Create one in the dashboard first (Manage → pick a directory → + Terminal).\r\n` }));
      ws.close();
      return;
    }
    if (persisted.kind && persisted.kind !== 'terminal') {
      ws.send(JSON.stringify({ type: 'error', data:
        `Session ${sessionId} is a ${persisted.kind} session, not a terminal.\r\n` }));
      ws.close();
      return;
    }
    console.log(`[multicc] Spawning terminal session ${sessionId}`);
    try {
      session = await createSession(sessionId);
    } catch (err) {
      const cliLabel = (persisted.cli === 'codex') ? 'codex' : 'claude';
      const msg = `Failed to launch ${cliLabel}: ${err.message}\r\n` +
        `Make sure "${cliLabel}" is installed and available in PATH.\r\n` +
        `You can also set the ${cliLabel.toUpperCase()}_CMD environment variable.\r\n`;
      ws.send(JSON.stringify({ type: 'error', data: msg }));
      ws.close();
      return;
    }
  }

  session.clients.add(ws);

  // Keep-alive tracking (server pings periodically)
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Tell client its session ID
  ws.send(JSON.stringify({ type: 'session_id', id: sessionId, cli: session.cli || 'claude' }));

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
        ws.send(JSON.stringify({ type: 'file_saved', tempId, path: tmpPath, name }));
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

// Build worktrees for any session that lacks one, then recover tmux sessions.
// Both paths are asynchronous so startup never blocks the event loop on git/tmux.
const startupRepoReady = initWorktrees()
  .then(() => recoverTmuxSessions())
  .catch(error => console.error('[multicc] async repo/tmux startup failed:', error.message));

// Initialize AuxQueue (loads history, registers __aux__ session)
auxQueue.init();

// ───────────────────────────────────────────────────────────────────────────
// Auto-trigger runtime
//
// Triggers live on the session record (persisted.triggers). This is the "waking
// half": it watches files / cron / turn-end and, when a rule matches, starts a
// fresh chat turn via runChatTurn with originTrigger:true. All the "what to do"
// logic lives in the bundled multicc-trigger skill, not here — a fired trigger
// just injects a prompt that points the agent at that skill.
// ───────────────────────────────────────────────────────────────────────────

const DEFAULT_TRIGGER_PROMPT =
  '【multicc 自动触发】请使用 multicc-trigger skill 执行检查流程：查看当前 git 改动（git status/diff），' +
  '提醒我该提交或该补/跑测试的地方；简短汇报即可，不要擅自修改代码或提交。';

const triggerWatchers = new Map();   // sessionId -> chokidar watcher
const triggerCronTasks = new Map();  // sessionId -> [cron task]
const _deferredFire = new Map();     // `${sessionId}:${triggerId}` -> timeout

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function triggerLabel(t) {
  if (t.type === 'file-change') return `文件变更 ${(t.paths || []).join(',')}`;
  if (t.type === 'schedule') return `定时 ${t.cron}`;
  return '每轮结束';
}

// Validate + normalize a trigger from API input. Returns {trigger} or {error}.
function validateTrigger(body) {
  const type = String(body.type || '');
  if (!['post-turn', 'file-change', 'schedule'].includes(type)) return { error: 'invalid type' };
  const t = {
    id: body.id || crypto.randomUUID(),
    type,
    enabled: body.enabled !== false,
    prompt: body.prompt != null ? String(body.prompt).slice(0, 4000) : '',
    cooldownMs: clampInt(body.cooldownMs, 0, 86400000, type === 'post-turn' ? 30000 : 0),
    mode: 'inject',
    createdAt: body.createdAt || new Date().toISOString(),
  };
  if (type === 'file-change') {
    let paths = body.paths;
    if (typeof paths === 'string') paths = [paths];
    if (!Array.isArray(paths) || !paths.length) return { error: 'file-change requires paths[]' };
    t.paths = paths.map(String).slice(0, 20);
    t.debounceMs = clampInt(body.debounceMs, 500, 60000, 3000);
  }
  if (type === 'schedule') {
    if (!body.cron || !cron.validate(String(body.cron))) return { error: 'invalid cron expression' };
    t.cron = String(body.cron);
  }
  return { trigger: t };
}

// Tiny glob matcher (chokidar 5 dropped glob support, so we watch the worktree
// root and match changed relative paths ourselves). Supports ** * ?.
const _globCache = new Map();
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
function matchGlob(p, glob) {
  let r = _globCache.get(glob);
  if (!r) { r = globToRegex(glob); _globCache.set(glob, r); }
  return r.test(p);
}
function matchAnyGlob(p, globs) {
  return Array.isArray(globs) && globs.some((g) => matchGlob(p, g));
}

// Fire a trigger: cooldown + busy checks, then inject the prompt as a new turn.
function fireTrigger(sessionId, trigger, reason) {
  const persisted = persistedSessions.get(sessionId);
  if (!persisted || !trigger.enabled) return;
  const now = Date.now();
  const cd = trigger.cooldownMs || 0;
  if (cd > 0 && trigger.lastFiredAt && (now - trigger.lastFiredAt) < cd) return;
  // If the session is mid-turn, defer rather than clobber the running turn.
  const cs = chatSessions.get(sessionId);
  if (cs && cs.isStreaming) {
    const key = sessionId + ':' + trigger.id;
    if (!_deferredFire.has(key)) {
      _deferredFire.set(key, setTimeout(() => {
        _deferredFire.delete(key);
        fireTrigger(sessionId, trigger, reason);
      }, 6000));
    }
    return;
  }
  // Persist lastFiredAt on the live record (test triggers may be ephemeral copies).
  const live = (persisted.triggers || []).find((x) => x.id === trigger.id);
  if (live) { live.lastFiredAt = now; savePersistedSessions(); }
  const prompt = (trigger.prompt && trigger.prompt.trim()) || DEFAULT_TRIGGER_PROMPT;
  appendEvent(persisted.dirId, 'trigger_fired', `${triggerLabel(trigger)} · ${reason}`, sessionId);
  chatBroadcast(sessionId, { type: 'system', subtype: 'trigger_fired', trigger: triggerLabel(trigger), reason });
  // Decoupled via the bus so triggers doesn't depend on the chat domain.
  bus.emit('chat:run', sessionId, prompt, { originTrigger: true });
}

// Called after every chat turn's `result`. Fires post-turn triggers, but never
// on a turn that an auto-trigger itself started (cs._originTrigger) — no loop.
function firePostTurnTriggers(sessionId, cs) {
  if (cs && cs._originTrigger) return;
  const persisted = persistedSessions.get(sessionId);
  if (!persisted || !Array.isArray(persisted.triggers)) return;
  for (const t of persisted.triggers) {
    if (t.enabled && t.type === 'post-turn') fireTrigger(sessionId, t, 'post-turn');
  }
}
// Triggers domain owns this handler; chat emits 'chat:turn-complete' after every turn.
bus.on('chat:turn-complete', firePostTurnTriggers);

function buildFileWatchers(sessionId, persisted) {
  const triggers = (persisted.triggers || []).filter((t) => t.enabled && t.type === 'file-change');
  if (!triggers.length) return;
  const root = persisted.worktreePath || cwdForSession(persisted);
  if (!root || !fs.existsSync(root)) return;
  let watcher;
  try {
    watcher = chokidar.watch(root, {
      ignoreInitial: true,
      persistent: true,
      depth: 20,
      ignored: (p) => /(^|[\/\\])(\.git|node_modules|\.multicc-worktrees|\.DS_Store)([\/\\]|$)/.test(p),
    });
  } catch (e) {
    console.warn(`[multicc/trigger] watch failed for ${sessionId}: ${e.message}`);
    return;
  }
  const debouncers = new Map();
  const onChange = (full) => {
    const rel = path.relative(root, full).split(path.sep).join('/');
    for (const t of triggers) {
      if (!matchAnyGlob(rel, t.paths)) continue;
      const key = t.id;
      if (debouncers.has(key)) clearTimeout(debouncers.get(key));
      debouncers.set(key, setTimeout(() => {
        debouncers.delete(key);
        fireTrigger(sessionId, t, `file:${rel}`);
      }, t.debounceMs || 3000));
    }
  };
  watcher.on('add', onChange).on('change', onChange).on('unlink', onChange);
  watcher.on('error', () => {});
  triggerWatchers.set(sessionId, watcher);
}

function buildCronTasks(sessionId, persisted) {
  const triggers = (persisted.triggers || []).filter((t) => t.enabled && t.type === 'schedule' && t.cron);
  const tasks = [];
  for (const t of triggers) {
    if (!cron.validate(t.cron)) continue;
    try {
      tasks.push(cron.schedule(t.cron, () => fireTrigger(sessionId, t, 'schedule')));
    } catch (e) {
      console.warn(`[multicc/trigger] cron failed (${t.cron}) for ${sessionId}: ${e.message}`);
    }
  }
  if (tasks.length) triggerCronTasks.set(sessionId, tasks);
}

function teardownTriggers(sessionId) {
  const w = triggerWatchers.get(sessionId);
  if (w) { try { w.close(); } catch (_) {} triggerWatchers.delete(sessionId); }
  const tasks = triggerCronTasks.get(sessionId);
  if (tasks) { for (const t of tasks) { try { t.stop(); } catch (_) {} } triggerCronTasks.delete(sessionId); }
}

// Rebuild watchers + cron for one session (call after its triggers change).
function reconcileTriggers(sessionId) {
  teardownTriggers(sessionId);
  const p = persistedSessions.get(sessionId);
  if (!p) return;
  buildFileWatchers(sessionId, p);
  buildCronTasks(sessionId, p);
}

function reconcileAllTriggers() {
  let n = 0;
  for (const [id, p] of persistedSessions) {
    if (Array.isArray(p.triggers) && p.triggers.length) { reconcileTriggers(id); n++; }
  }
  if (n) console.log(`[multicc/trigger] armed triggers for ${n} session(s)`);
}

// ── Skill sync: keep Claude, Codex & Hermes skills consistent ──
// Three-tier: (1) bundled multicc skills from ./skills copied to all providers;
// (2) shared skills from ~/.agents/skills symlinked to all providers;
// (3) skill-converter transforms canonical skills for each provider's format.
// Runs on startup + every 5 min + on chokidar changes to ~/.agents/skills.

const skillConv = require('./src/skill-converter');

const SKILL_PROVIDERS = [
  { name: 'claude',  dir: path.join(os.homedir(), '.claude', 'skills'),  protectedSubdirs: [] },
  { name: 'codex',   dir: path.join(os.homedir(), '.codex', 'skills'),   protectedSubdirs: ['.system'] },
  { name: 'hermes',  dir: path.join(os.homedir(), '.hermes', 'skills'),  protectedSubdirs: [] },
];
const AGENTS_SKILLS_DIR = skillConv.AGENTS_ROOT;

// ── Skill-sync status (surfaced by /api/skill-sync/status + the 技能同步 panel) ──
// syncSharedSkills throws away its per-run counts after logging; capture the
// latest run here so the manage UI can show live state. _skillSyncRunning guards
// a manual /run against a concurrent timer/chokidar sync.
let _lastSkillSyncResult = null;
let _skillSyncRunning = false;

function _listSharedSkillNames() {
  try {
    return fs.readdirSync(AGENTS_SKILLS_DIR)
      .filter(n => !n.startsWith('.') && _isSkillDir(path.join(AGENTS_SKILLS_DIR, n)))
      .sort();
  } catch (_) { return []; }
}

// Merge a partial run summary into _lastSkillSyncResult, refreshing the
// derived fields (shared skill list, AI-convert queue snapshot) each time.
function _recordSkillSyncResult(partial) {
  const prev = _lastSkillSyncResult || {};
  const p = partial || {};
  const sharedSkillNames = _listSharedSkillNames();
  let aiQueue = { queueLength: 0, items: [], timerActive: false };
  try { if (typeof skillConv.getAiQueueStatus === 'function') aiQueue = skillConv.getAiQueueStatus(); } catch (_) {}
  _lastSkillSyncResult = {
    ts: Date.now(),
    providers: p.providers || prev.providers || null,
    linkCount: p.linkCount != null ? p.linkCount : (prev.linkCount || 0),
    skipCount: p.skipCount != null ? p.skipCount : (prev.skipCount || 0),
    convCount: p.convCount != null ? p.convCount : (prev.convCount || 0),
    reverseImportCount: p.reverseImportCount != null ? p.reverseImportCount : (prev.reverseImportCount || 0),
    bundledInstallCount: p.bundledInstallCount != null ? p.bundledInstallCount : (prev.bundledInstallCount || 0),
    sharedSkillCount: sharedSkillNames.length,
    sharedSkillNames,
    aiQueue,
    error: p.error !== undefined ? p.error : (prev.error || null),
  };
  return _lastSkillSyncResult;
}

function _readSkillVer(dir) {
  try { return fs.readFileSync(path.join(dir, '.skill-version'), 'utf8').trim(); } catch (_) { return null; }
}

function _isSkillDir(dir) {
  try { return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'SKILL.md')); } catch (_) { return false; }
}

// (1) Import bundled multicc skills (./skills/) into ~/.agents/skills - the
// single authority source. Providers load from agents via syncSharedSkills.
// Re-imports when .skill-version differs or is missing.
function installBundledSkills() {
  const srcRoot = path.join(__dirname, 'skills');
  let names;
  try { names = fs.readdirSync(srcRoot); } catch (_) { return 0; }
  let installed = 0;
  for (const name of names) {
    try {
      const src = path.join(srcRoot, name);
      if (!_isSkillDir(src)) continue;
      // Import into agents (authority). agents' stale reverse-import copy has
      // no .skill-version -> overwritten on first run; later runs skip on match.
      const dest = path.join(AGENTS_SKILLS_DIR, name);
      if (fs.existsSync(dest) && _readSkillVer(dest) === _readSkillVer(src)) continue;
      fs.mkdirSync(AGENTS_SKILLS_DIR, { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
      try { for (const f of fs.readdirSync(path.join(dest, 'bin'))) fs.chmodSync(path.join(dest, 'bin', f), 0o755); } catch (_) {}
      installed++;
      console.log(`[multicc/skills] imported bundled -> ~/.agents/skills/${name}`);
    } catch (e) {
      console.warn(`[multicc/skills] install bundled ${name} failed: ${e.message}`);
    }
  }
  return installed;
}

// (2) Symlink ~/.agents/skills/* into each provider's skill dir, using the
// skill-converter to produce provider-appropriate versions when needed (e.g.
// stripped Codex frontmatter, Hermes metadata). Mechanical conversion runs
// inline; AI-assisted deep conversion is queued for background processing.
function syncSharedSkills() {
  // Per-provider tallies so the status UI can show a claude/codex/hermes
  // breakdown, not just an aggregate. providers[name] = {linked,skipped,converted}.
  const providers = {};
  for (const prov of SKILL_PROVIDERS) providers[prov.name] = { linked: 0, skipped: 0, converted: 0 };

  let agentNames;
  try { agentNames = fs.readdirSync(AGENTS_SKILLS_DIR); }
  catch (_) { return _recordSkillSyncResult({ linkCount: 0, skipCount: 0, convCount: 0, providers }); }

  for (const prov of SKILL_PROVIDERS) {
    const pc = providers[prov.name];
    fs.mkdirSync(prov.dir, { recursive: true });
    const protectedSet = new Set(prov.protectedSubdirs || []);

    for (const name of agentNames) {
      if (protectedSet.has(name)) continue;

      const src = path.join(AGENTS_SKILLS_DIR, name);
      if (!_isSkillDir(src)) continue;

      // ── Run converter for this skill → target provider ──
      if (prov.name !== 'claude') {
        const convResult = skillConv.ensureSkillConverted(name);
        if (convResult.mechanical.length > 0) pc.converted++;
      }

      // ── Determine link target ──
      // Claude: use canonical source directly
      // Codex/Hermes: prefer converted cache, fall back to source
      const linkSrc = skillConv.getLinkTarget(name, prov.name);
      if (!linkSrc) continue;

      const dest = path.join(prov.dir, name);

      // Already a correct symlink? Resolve to compare.
      try {
        const lstat = fs.lstatSync(dest);
        if (lstat.isSymbolicLink()) {
          try { if (fs.realpathSync(dest) === fs.realpathSync(linkSrc)) continue; } catch (_) {}
        }
      } catch (_) {}

      // Real directory exists. With .skill-version = stale bundled copy (from
      // installBundledSkills' old behavior) -> replace with symlink to agents.
      // Without .skill-version = user's own version -> leave it alone.
      if (fs.existsSync(dest) && !fs.lstatSync(dest).isSymbolicLink()) {
        if (_readSkillVer(dest) === null) continue;
        try { fs.rmSync(dest, { recursive: true, force: true }); }
        catch (e) { pc.skipped++; continue; }
      }

      // Remove broken/wrong symlink and create correct one.
      try { fs.unlinkSync(dest); } catch (_) {}
      try {
        fs.symlinkSync(linkSrc, dest);
        pc.linked++;
      } catch (e) {
        console.warn(`[multicc/skills] symlink ${prov.name} ← ${name}: ${e.message}`);
        pc.skipped++;
      }
    }
  }
  let linkCount = 0, skipCount = 0, convCount = 0;
  for (const k of Object.keys(providers)) {
    linkCount += providers[k].linked; skipCount += providers[k].skipped; convCount += providers[k].converted;
  }
  if (linkCount > 0 || skipCount > 0 || convCount > 0) {
    console.log(`[multicc/skills] shared sync: ${linkCount} linked, ${skipCount} skipped, ${convCount} converted`);
  }
  return _recordSkillSyncResult({ linkCount, skipCount, convCount, providers });
}

// ── AI-assisted skill conversion callback ──
// When mechanical conversion is done, the converter queues deeper AI rewrites.
// We spawn a one-shot background session to do the actual rewriting via Claude.
skillConv.onAiConvertNeeded((batch) => {
  // The detached conversion job needs a live session to host it (run-detached
  // 404s on an unknown session id). Pick any non-aux claude session; the job
  // writes to absolute paths so the host session's cwd is irrelevant.
  const host = [...persistedSessions.values()].find(
    s => s.id !== AUX_SESSION_ID && (s.cli || 'claude') !== 'codex'
  );
  if (!host) {
    console.warn(`[multicc/skills] AI skill conversion skipped (${batch.length} skill(s)): no claude session to host the detached job`);
    return;
  }
  for (const { skillName, provider } of batch) {
    const spec = skillConv.buildAiConvertPrompt(skillName, provider);
    if (!spec) continue;

    // Spawn as a detached task — multicc monitors it and injects results
    // back into the current session when done.
    const cmd = [
      `mkdir -p "${spec.outputDir}"`,
      // Write the prompt as a temp file so the agent can read it
      `cat > /tmp/multicc-skillconv-${skillName}.txt << 'CONVEOF'`,
      spec.prompt,
      `CONVEOF`,
      // Let the agent do the conversion via claude
      `"${CLAUDE_CMD}" -p "$(cat /tmp/multicc-skillconv-${skillName}.txt)" --allowedTools "Bash,Read,Write,Edit" --output-format text --max-turns 3 2>&1`,
    ].join(' && ');

    const curlCmd = `curl -s ${process.env.MULTICC_BASE_URL || 'http://127.0.0.1:' + (process.env.PORT || 3000)}/api/sessions/${host.id}/run-detached -H 'Content-Type: application/json' -d '${JSON.stringify({ command: cmd, label: `skillconv-${skillName}→${provider}` })}'`;

    console.log(`[multicc/skills] queued AI conversion: ${skillName} → ${provider}`);
    try { require('child_process').execSync(curlCmd, { timeout: 5000 }); } catch (e) { console.warn(`[multicc/skills] AI conversion submit failed (${skillName}->${provider}): ${e.message}`); }
  }
});

let _skillsSyncWatcher = null;
function watchSharedSkills() {
  if (_skillsSyncWatcher) return;
  try {
    if (!fs.existsSync(AGENTS_SKILLS_DIR)) return;
    _skillsSyncWatcher = chokidar.watch(AGENTS_SKILLS_DIR, {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
    });
    _skillsSyncWatcher.on('addDir', () => syncSharedSkills());
    _skillsSyncWatcher.on('unlinkDir', () => syncSharedSkills());
    console.log(`[multicc/skills] watching ~/.agents/skills for changes`);
  } catch (e) {
    // non-fatal — periodic polling is the fallback
  }
}

// Scheduled tasks (定时任务): inject the session-creation + turn-running machinery.
// Complements the per-session triggers above — this one fires by creating a
// fresh chat session in a target directory (directory-level recurring tasks).
cronTasks.mount(app);
cronTasks.init({ directories, createSessionRecord, runChatTurn, sessionExists: (id) => persistedSessions.has(id) });
// In-process external-tunnel monitor (replaces phtunnel-monitor.sh watchdog).
tunnel.init();

// ── Graceful shutdown: persist in-flight chat turns before exiting ──
// Chat assistant messages are only written to disk when a turn COMPLETES (the
// `result` event, or the child process closing). A plain SIGTERM — e.g. a
// service restart — would otherwise drop whatever the agent had already
// streamed in an unfinished turn, so that text vanishes from history after the
// restart.
//
// The ShutdownCoordinator (src/shutdown.js) drives the whole sequence:
//   1. flip readiness → false (health probe / restart endpoints can steer away),
//   2. checkpoint — flushInFlightChats(): persist every session's partial
//      assistant text synchronously so even a hard kill in the next few ms
//      loses nothing,
//   3. drain — let in-flight turns run to their natural `result` event, up to
//      SHUTDOWN_GRACE_MS,
//   4. close — HTTP → WS → watchers → timers → child procs (registered below
//      as the various subsystems come up).
// PM2's kill_timeout in ecosystem.config.js is set greater than the grace so
// PM2 doesn't cut off partial-checkpoint mid-flight.
let _shuttingDown = false;
function flushInFlightChats() {
  let n = 0;
  for (const [name, cs] of chatSessions) {
    if (!cs || cs._resultSaved) continue;
    const hasText = !!(cs.currentAssistantText && cs.currentAssistantText.length);
    const hasTools = !!(cs.currentToolCalls && cs.currentToolCalls.length);
    if (!hasText && !hasTools) continue;
    try {
      appendChatMessage(name, {
        role: 'assistant',
        content: cs.currentAssistantText || '',
        tools: hasTools ? cs.currentToolCalls : undefined,
        cost: cs.currentCost,
        ts: Date.now(),
        partial: true,   // saved mid-turn on shutdown; may be incomplete
      });
      cs._resultSaved = true;
      n++;
    } catch (_) {}
  }
  return n;
}
const SHUTDOWN_GRACE_MS = 60000;   // max time to let in-flight turns finish
const shutdownCoordinator = createShutdownCoordinator({ logger: console });

// Bridge legacy _shuttingDown flag callers still consult (e.g. the restart
// endpoint) to the coordinator's readiness bit. They stay wire-compatible.
Object.defineProperty(global, '_shuttingDownCoordinated', {
  get: () => shutdownCoordinator.isShuttingDown(),
});

// Checkpoint FIRST: partial-in-memory-only state → disk, synchronously.
shutdownCoordinator.onCheckpoint(() => {
  try { flushInFlightChats(); }
  catch (e) { console.error(`[multicc] shutdown flush error: ${e.message}`); }
});

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
  if (draining.size === 0) return;
  console.log(`[multicc] shutdown → draining ${draining.size} in-flight turn(s) (grace ${graceMs}ms)`);
  const t0 = Date.now();
  await new Promise(resolve => {
    const timer = setInterval(() => {
      for (const name of [...draining]) {
        const cs = chatSessions.get(name);
        if (!cs || (!cs.claudeProc && !isStreamingBusy(name, cs))) draining.delete(name);
      }
      if (draining.size === 0) { clearInterval(timer); resolve(); }
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

function gracefulShutdown(sig) {
  if (_shuttingDown) return;
  // Ignore SIGTERM by default to prevent accidental shutdowns from arbitrary
  // `kill` invocations. `./multicc stop` sends SIGINT explicitly, and the
  // coordinator handles both signals uniformly when SIGTERM is not swallowed.
  if (sig === 'SIGTERM') {
    console.log('[multicc] SIGTERM ignored. Use ./multicc stop to stop.');
    return;
  }
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
    const _bundled = installBundledSkills();        // bundled multicc skills → all providers
    const _rev = skillConv.importAllProviderSkills(); // reverse-import: Codex/Hermes → agents
    syncSharedSkills();                             // forward sync: agents → all providers (records providers)
    _recordSkillSyncResult({ bundledInstallCount: _bundled, reverseImportCount: (_rev || []).length });
    watchSharedSkills();                            // real-time chokidar watch on ~/.agents/skills
    setInterval(() => {
      const rev = skillConv.importAllProviderSkills(); // periodic reverse import
      syncSharedSkills();                           // periodic forward sync (records providers)
      _recordSkillSyncResult({ reverseImportCount: (rev || []).length });
    }, 5 * 60 * 1000).unref();
    reconcileAllTriggers();
    // Periodic scan: re-judge non-terminal/junk sessions every minute. First
    // tick delayed 6s so aux warms up and WS clients reconnect. Replaces the
    // old one-shot startup reconcile - restart just means the first tick runs.
    setTimeout(() => scanAndReclassify(), 6000);
    setInterval(() => scanAndReclassify(), SCAN_INTERVAL_MS).unref();
    artifacts.cleanup();
    setInterval(() => artifacts.cleanup(), 6 * 3600 * 1000).unref();
    // ④: probe aux recovery every 5 min while unhealthy (no-op when healthy).
    setInterval(() => auxHealthProbe(), AUX_HEALTH_PROBE_INTERVAL_MS).unref();
    serviceReady = true;
  });
})();
