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
// strip the full routing-key set here so every child inherits a clean env. This
// MUST stay in sync with CLAUDE_ROUTING_KEYS in src/providers.js — in particular
// the ANTHROPIC_*_MODEL aliases, whose omission previously redirected the aux
// helper's `--model haiku` to a leaked DeepSeek model and broke every aux task.
for (const k of [
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]) {
  if (process.env[k]) { console.log(`[multicc] stripping inherited ${k} so claude uses the OAuth subscription`); delete process.env[k]; }
}

const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { StringDecoder } = require('string_decoder');
const { execSync, execFileSync, spawn } = require('child_process');
const multer = require('multer');
const chokidar = require('chokidar');
const cron = require('node-cron');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const wechatBridge = require('./wechat-ilink');
const feishuBridge = require('./feishu-bridge');
const telegramBridge = require('./telegram-bridge');
const discordBridge = require('./discord-bridge');
const slackBridge = require('./slack-bridge');
const voiceAsr = require('./voice-asr');
const ttsService = require('./src/tts-service');
const cronTasks = require('./cron-tasks');
const webpush = require('web-push');
const macosPower = require('./macos-power');
const gitPush = require('./git-push');
const { runGit: gitRunQueued, makeTtlCache } = require('./src/git-queue');

const crypto = require('crypto');
const bus = require('./src/bus');
const services = require('./src/services');
const state = require('./src/state');
const artifacts = require('./src/artifacts');
const providers = require('./src/providers');
const tokenGlobal = require('./src/token-global');
const { mountCodexProxy } = require('./src/codex-proxy');
const app = express();

// ── Access token authentication (cookie-based login) ──
// `let` (not const): editable at runtime via /api/settings/access-token from
// localhost, hot-reloaded without restart (persisted to .env).
let ACCESS_TOKEN = process.env.ACCESS_TOKEN;

// Signed cookie: no server-side storage needed, survives restarts
function signToken(data) {
  return crypto.createHmac('sha256', ACCESS_TOKEN).update(data).digest('hex');
}

function generateAuthCookie() {
  const payload = Date.now().toString(36);
  return payload + '.' + signToken(payload);
}

function verifyAuthCookie(cookie) {
  if (!cookie || !cookie.includes('.')) return false;
  const [payload, sig] = cookie.split('.');
  return sig === signToken(payload);
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
  // Reverse proxy (Tailscale, ngrok, etc.) connects from localhost but serves external users
  const host = (req.headers.host || '').split(':')[0];
  return host.endsWith('.ts.net') || host.endsWith('.ngrok.io') || host.endsWith('.ngrok-free.app');
}

// True only for requests physically originating from this machine (not a
// reverse proxy forwarding external traffic). Used both for the localhost
// auth bypass and to gate editing the access token.
function isLocalRequest(req) {
  const ip = req.ip || req.connection.remoteAddress;
  return (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') && !isExternalProxy(req);
}

function isAuthenticated(req) {
  if (!ACCESS_TOKEN) return true;
  // Localhost allowed — unless it's a reverse proxy forwarding external traffic
  if (isLocalRequest(req)) return true;
  // Cookie auth (HMAC-signed, survives server restart)
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.multicc_auth && verifyAuthCookie(cookies.multicc_auth)) return true;
  // Query param / header (backwards compat for API / WebSocket)
  const token = req.query.token || req.headers['x-access-token'];
  if (token === ACCESS_TOKEN) return true;
  return false;
}

// Always register login routes + auth middleware (no-op while ACCESS_TOKEN is
// empty, see isAuthenticated). This lets a token set later via the localhost UI
// take effect immediately, without restarting the server.
{
  // Login page & handler
  app.get('/login', (req, res) => {
    const error = req.query.error ? '<p style="color:#f85149;margin-bottom:16px;">密码错误</p>' : '';
    const redirect = req.query.redirect || '/';
    res.type('html').send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MultiCC — Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',system-ui,sans-serif;
    display:flex;align-items:center;justify-content:center;height:100vh}
  .box{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;
    width:340px;text-align:center}
  .box h1{font-size:20px;margin-bottom:8px;color:#f0f6fc}
  .box .logo{font-size:24px;font-weight:700;color:#f78166;margin-bottom:24px}
  .box .logo span{color:#79c0ff}
  input[type=password]{width:100%;padding:10px 14px;border-radius:6px;border:1px solid #30363d;
    background:#0d1117;color:#c9d1d9;font-size:14px;margin-bottom:16px;outline:none}
  input[type=password]:focus{border-color:#58a6ff}
  button{width:100%;padding:10px;border-radius:6px;border:none;background:#238636;
    color:#fff;font-size:14px;font-weight:600;cursor:pointer}
  button:hover{background:#2ea043}
</style></head><body>
<div class="box">
  <div class="logo">Web<span>CC</span></div>
  ${error}
  <form method="POST" action="/login">
    <input type="hidden" name="redirect" value="${redirect.replace(/"/g, '&quot;')}">
    <input type="password" name="password" placeholder="输入访问密码" autofocus>
    <button type="submit">登录</button>
  </form>
</div></body></html>`);
  });

  app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    const redirect = req.body.redirect || '/';
    if (req.body.password === ACCESS_TOKEN) {
      const authCookie = generateAuthCookie();
      res.setHeader('Set-Cookie',
        `multicc_auth=${authCookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
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
    if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|json)$/i.test(req.path)) return next();
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
    if (isAuthenticated(req)) return next();
    // Redirect HTML requests to login, reject API calls with 403
    if (req.headers.accept?.includes('text/html') || (!req.path.startsWith('/api/') && req.method === 'GET')) {
      res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
    } else {
      res.status(403).json({ error: 'Forbidden: not authenticated' });
    }
  });
}

let PORT = parseInt(process.env.PORT || '3000', 10);
const server = http.createServer(app);

// Auto-select next available port if the requested one is in use.
async function findAvailablePort(startPort) {
  const net = require('net');
  const maxTries = 100;
  for (let i = 0; i < maxTries; i++) {
    const port = startPort + i;
    const result = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.once('close', () => resolve(true));
        server.close();
      });
      server.listen(port, '127.0.0.1');
    });
    if (result) {
      if (port !== startPort) {
        console.log(`[multicc] Port ${startPort} in use, auto-switching to ${port}`);
        // Write back the new port to .env so future starts use it.
        const envPath = require('path').join(__dirname, '.env');
        try {
          const fs = require('fs');
          if (fs.existsSync(envPath)) {
            let content = fs.readFileSync(envPath, 'utf8');
            content = content.replace(/^PORT=.*/m, `PORT=${port}`);
            fs.writeFileSync(envPath, content);
          }
        } catch (_) {}
      }
      return port;
    }
  }
  throw new Error(`No available port between ${startPort} and ${startPort + maxTries}`);
}

// Auto-select next available port if the requested one is in use.
async function findAvailablePort(startPort) {
  const net = require('net');
  const maxTries = 100;
  for (let i = 0; i < maxTries; i++) {
    const port = startPort + i;
    const result = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.once('close', () => resolve(true));
        server.close();
      });
      server.listen(port, '127.0.0.1');
    });
    if (result) {
      if (port !== startPort) {
        console.log(`[multicc] Port ${startPort} in use, auto-switching to ${port}`);
        // Write back the new port to .env so future starts use it.
        const envPath = require('path').join(__dirname, '.env');
        try {
          const fs = require('fs');
          if (fs.existsSync(envPath)) {
            let content = fs.readFileSync(envPath, 'utf8');
            content = content.replace(/^PORT=.*/m, `PORT=${port}`);
            fs.writeFileSync(envPath, content);
          }
        } catch (_) {}
      }
      return port;
    }
  }
  throw new Error(`No available port between ${startPort} and ${startPort + maxTries}`);
}

// Auto-select next available port if the requested one is in use.
async function findAvailablePort(startPort) {
  const net = require('net');
  const maxTries = 100;
  for (let i = 0; i < maxTries; i++) {
    const port = startPort + i;
    const result = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.once('close', () => resolve(true));
        server.close();
      });
      server.listen(port, '127.0.0.1');
    });
    if (result) {
      if (port !== startPort) {
        console.log(`[multicc] Port ${startPort} in use, auto-switching to ${port}`);
        // Write back the new port to .env so future starts use it.
        const envPath = require('path').join(__dirname, '.env');
        try {
          const fs = require('fs');
          if (fs.existsSync(envPath)) {
            let content = fs.readFileSync(envPath, 'utf8');
            content = content.replace(/^PORT=.*/m, `PORT=${port}`);
            fs.writeFileSync(envPath, content);
          }
        } catch (_) {}
      }
      return port;
    }
  }
  throw new Error(`No available port between ${startPort} and ${startPort + maxTries}`);
}

// Auto-select next available port if the requested one is in use.
async function findAvailablePort(startPort) {
  const net = require('net');
  const maxTries = 100;
  for (let i = 0; i < maxTries; i++) {
    const port = startPort + i;
    const result = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.once('close', () => resolve(true));
        server.close();
      });
      server.listen(port, '127.0.0.1');
    });
    if (result) {
      if (port !== startPort) {
        console.log(`[multicc] Port ${startPort} in use, auto-switching to ${port}`);
        // Write back the new port to .env so future starts use it.
        const envPath = require('path').join(__dirname, '.env');
        try {
          const fs = require('fs');
          if (fs.existsSync(envPath)) {
            let content = fs.readFileSync(envPath, 'utf8');
            content = content.replace(/^PORT=.*/m, `PORT=${port}`);
            fs.writeFileSync(envPath, content);
          }
        } catch (_) {}
      }
      return port;
    }
  }
  throw new Error(`No available port between ${startPort} and ${startPort + maxTries}`);
}

// Auto-select next available port if the requested one is in use.
async function findAvailablePort(startPort) {
  const net = require('net');
  const maxTries = 100;
  for (let i = 0; i < maxTries; i++) {
    const port = startPort + i;
    const result = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.once('close', () => resolve(true));
        server.close();
      });
      server.listen(port, '127.0.0.1');
    });
    if (result) {
      if (port !== startPort) {
        console.log(`[multicc] Port ${startPort} in use, auto-switching to ${port}`);
        // Write back the new port to .env so future starts use it.
        const envPath = require('path').join(__dirname, '.env');
        try {
          const fs = require('fs');
          if (fs.existsSync(envPath)) {
            let content = fs.readFileSync(envPath, 'utf8');
            content = content.replace(/^PORT=.*/m, `PORT=${port}`);
            fs.writeFileSync(envPath, content);
          }
        } catch (_) {}
      }
      return port;
    }
  }
  throw new Error(`No available port between ${startPort} and ${startPort + maxTries}`);
}

const wss = new WebSocket.Server({ server });
const isWindows = process.platform === 'win32';

// Resolve the full path of the claude executable at startup
function resolveClaude() {
  if (process.env.CLAUDE_CMD) {
    console.log(`[multicc] CLAUDE_CMD override: ${process.env.CLAUDE_CMD}`);
    return process.env.CLAUDE_CMD;
  }

  const extraPaths = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.local', 'share', 'claude', 'bin'),
    path.join(os.homedir(), '.npm-global', 'bin'),
    path.join(os.homedir(), '.npm', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
  ];
  const sep = isWindows ? ';' : ':';
  const augmentedPath = [...new Set([...extraPaths, ...(process.env.PATH || '').split(sep)])].join(sep);
  process.env.PATH = augmentedPath;

  if (!isWindows) {
    // Try login shell first — it sources ~/.zshrc / ~/.bashrc and sees the real PATH
    const shells = ['/bin/zsh', '/bin/bash'];
    for (const sh of shells) {
      if (!fs.existsSync(sh)) continue;
      try {
        const result = execSync(`${sh} -l -c 'which claude 2>/dev/null'`, {
          encoding: 'utf8',
          timeout: 5000,
        });
        const found = result.trim().split(/\r?\n/)[0].trim();
        if (found && fs.existsSync(found)) {
          console.log(`[multicc] Found claude via ${sh}: ${found}`);
          return found;
        }
      } catch (_) {}
    }
  }

  // Try which/where with augmented PATH
  try {
    const result = execSync(isWindows ? 'where claude' : 'which claude', {
      encoding: 'utf8',
      env: { ...process.env, PATH: augmentedPath },
      timeout: 5000,
    });
    const lines = result.trim().split(/\r?\n/);
    const exe = isWindows ? lines.find(l => l.endsWith('.exe')) || lines[0] : lines[0];
    const found = exe.trim();
    if (found) {
      console.log(`[multicc] Found claude via which: ${found}`);
      return found;
    }
  } catch (_) {}

  // Direct file existence check
  for (const dir of extraPaths) {
    const candidate = path.join(dir, isWindows ? 'claude.exe' : 'claude');
    if (fs.existsSync(candidate)) {
      console.log(`[multicc] Found claude via direct check: ${candidate}`);
      return candidate;
    }
  }

  console.warn('[multicc] WARNING: Could not locate claude binary, falling back to "claude"');
  return isWindows ? 'claude.exe' : 'claude';
}

const CLAUDE_CMD = resolveClaude();
const CLAUDE_ARGS = process.env.CLAUDE_ARGS ? process.env.CLAUDE_ARGS.split(' ') : [];
const CLAUDE_CHAT_DISALLOWED_TOOLS = (process.env.CLAUDE_CHAT_DISALLOWED_TOOLS ?? 'AskUserQuestion')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
console.log(`[multicc] Using claude: ${CLAUDE_CMD}`);

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

// ── Codex CLI binary resolution (mirrors claude lookup) ──
function resolveCodex() {
  if (process.env.CODEX_CMD) return process.env.CODEX_CMD;
  const candidates = [
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
    path.join(os.homedir(), '.local', 'bin', 'codex'),
    path.join(os.homedir(), '.cargo', 'bin', 'codex'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  if (!isWindows) {
    for (const sh of ['/bin/zsh', '/bin/bash']) {
      if (!fs.existsSync(sh)) continue;
      try {
        const r = execSync(`${sh} -l -c 'which codex 2>/dev/null'`, { encoding: 'utf8', timeout: 5000 }).trim().split(/\r?\n/)[0].trim();
        if (r && fs.existsSync(r)) return r;
      } catch (_) {}
    }
  }
  try {
    const r = execSync(isWindows ? 'where codex' : 'which codex', { encoding: 'utf8', timeout: 5000 }).trim().split(/\r?\n/)[0].trim();
    if (r) return r;
  } catch (_) {}
  return isWindows ? 'codex.exe' : 'codex';
}
const CODEX_CMD = resolveCodex();
const CODEX_ARGS = process.env.CODEX_ARGS ? process.env.CODEX_ARGS.split(' ') : [];
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
console.log(`[multicc] Using codex: ${CODEX_CMD}`);

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
  '【后台长任务，丢了别管 ——【硬性规则，优先级高于任何角色设定】】在 multicc 的 chat 会话里，凡是「跑完/等到再继续」的等待型后台操作，一律禁止用以下方式：① 裸 `&`/nohup；② Claude Code 自带 Bash 工具的 `run_in_background:true`（这是最常见的违规！包括用它去轮询/守候一个或多个文件、状态、子会话结果）；③ Monitor / BashOutput 轮询；④ `tail -f | grep` 等待标记。原因：chat 会话里这些后台进程和监听器会在本轮结束/上下文重置时被环境连同任务一起回收，进程被静默杀掉（OOM、退出码 137，不写日志）后你的等待永远不会被唤醒——表现就是「消息到此断掉、不会自动恢复，直到用户来催」（你正在看的这条提示就是因为有人这么做了）。正确做法：改用 multicc 的 run-detached 接口（由 multicc 服务以 setsid 启动，独立于本轮甚至服务重启，跑完自动把「退出码+输出尾巴」作为下一条消息发回给你续接）；或在命令本身够快时前台同步跑（给足 timeout 一次拿结果）。',
  `     curl -s $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/run-detached -H 'Content-Type: application/json' \\`,
  `       -d '{"command":"<要后台跑的完整shell命令>","label":"<简短任务名>"}'`,
  '     可选字段：cwd（默认你的工作目录）、intervalSec（轮询间隔秒，默认 10）、maxChecks（最多检查次数，默认 360≈1 小时）。返回里有 taskId 与 logPath；用 GET $MULTICC_BASE_URL/api/detached/<taskId> 可随时查实时状态与日志尾巴。',
  '  登记后正常结束本轮即可，任务完成时 multicc 会自动续接。若需中途向用户报进度，配合下面「边做边报」用 GET /api/detached/<taskId> tail 日志即可，不要前台死等。',
  '  ⚠️ 典型违规场景（这些都必须用 run-detached，不能用 Bash run_in_background）：等构建/打包/部署/长测试跑完；轮询某文件出现某关键字；**等多个子会话/兄弟会话把结果写进各自文件后再汇总**（比如 dispatch 出去几个会话后守着它们的 chat_history json）；等第三方接口/部署状态变化。判断标准很简单：只要这一步是「我先发起、然后要等它在未来某刻完成、完成后我才继续」，就用 run-detached 或前台同步跑，绝不用 run_in_background 守。run-detached 同样支持轮询（intervalSec/maxChecks）和自定义 pollCmd，能覆盖上面所有场景，且跨轮不丢、自动续接。',
  '  🚫【绝对禁令，无例外】不要给 Bash 工具传 `run_in_background: true`。在 chat 会话里这个参数起的后台进程会被回收，等于白跑。需要后台 → run-detached；需要尽快拿结果 → 前台同步跑（给足 timeout）。这条不是建议而是禁令：multicc 会在每一轮结束后检查你是否用了 `run_in_background`，一旦发现就会自动给你发一条纠正消息把你拉回正轨——所以与其被纠正，不如一开始就别用。唯一可接受的「后台」是 multicc 的 run-detached 接口，没有第二种。',

  '',
  '【长任务边做边报进度】（multicc 统一体验约定）当某件事要跑较久（构建/打包/部署/批处理/长等待）时，默认采用「边等边报」：优先用上面的 run-detached 把它放后台（这样不会被回收），运行期间每隔约 25–30 秒主动向用户冒一句简短进度（在做什么、已约 Ns、最新一行关键输出），任务完成后再给最终结果。进度做法：用一个会在约 25 秒后自行退出的后台计时命令把自己周期性唤醒，每次被唤醒就 tail 一下任务输出（或 GET /api/detached/<taskId>）、报一句进度，直到任务完成为止。',
  '不要一启动就长时间静默、让对话框看起来像卡住；也不要只说「我等一下」就停下不续接。这是面向所有 multicc 用户的统一约定，请默认遵循。',
  '',
  '【跨会话协作时的 worktree 同步纪律】每个 chat 会话在自己独立的 git worktree + 分支（multicc/<sessionId>）里干活，基分支通常是 main。多个会话并行改代码时，worktree 之间不会自动一致，必须按下面纪律同步，否则会基于过时代码工作、产生冲突或覆盖别人的改动：',
  '  · 派活方（把任务用 <<dispatch>> 或留言交给兄弟会话前）：在交给对方的指令里，明确要求对方「① 动手前先把自己的 worktree 同步到最新基分支：curl -s -X POST $MULTICC_BASE_URL/api/sessions/<目标会话id>/sync ；② 干完后 commit 全部改动，并合并回基分支：curl -s -X POST $MULTICC_BASE_URL/api/sessions/<目标会话id>/merge ；③ 回复里报告改了哪些文件、是否已合并、有无冲突」。',
  '  · 被派方（你收到一个自包含任务时）：先 sync 再干活，干完 commit + merge 回基分支，并在回复里如实说明改动文件与合并结果；若 sync 或 merge 返回冲突（HTTP 409），不要硬来，把冲突文件清单报回派活方让其裁决。',
  '  · 收回成果后（派活方拿到对方「已合并」的回复时）：自己也 sync 一下把对方的成果拉进本会话 worktree（curl -s -X POST $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/sync），再继续后续工作，避免你手上还是旧代码。',
  '  · multicc 会在任一会话 merge 回基分支后，自动把同目录其它会话的 worktree 同步到新基分支（冲突的会跳过并提示）；但「你自己这个会话」和「正在进行中的对话」仍以你主动 sync 为准，涉及共享文件的关键节点请主动同步一次再动手。',
].join('\n');

const cliProviders = {
  claude: {
    name: 'claude',
    cmd: CLAUDE_CMD,
    // Interactive terminal: `claude --session-id <uuid>`
    buildTerminalCmd(session) {
      let cmd = `${CLAUDE_CMD}${CLAUDE_ARGS.length ? ' ' + CLAUDE_ARGS.join(' ') : ''}`;
      if (session.model) cmd += ` --model ${session.model}`;
      if (session.cliSessionId) cmd += ` --session-id ${session.cliSessionId}`;
      return cmd;
    },
    // Chat-mode spawn args: `-p --output-format stream-json [--resume id | --session-id id] <prompt>`
    buildChatSpawnArgs(session, prompt, opts) {
      // Image hint is always present; the resolved role prompt (session > dir)
      // is appended after it so the user's custom role rides every turn (--resume
      // keeps the system prompt out, so we re-send it each turn on purpose).
      const sysPrompt = opts.rolePrompt
        ? `${MULTICC_IMG_HINT}\n\n${opts.rolePrompt}`
        : MULTICC_IMG_HINT;
      const args = [
        '-p', '--output-format', 'stream-json', '--verbose',
        '--include-partial-messages', '--dangerously-skip-permissions',
        '--append-system-prompt', sysPrompt,
      ];
      // Per-session model wins; otherwise follow the user's current /model default
      // (passed explicitly because `--resume` would keep the session's original model).
      // When a provider override routes to a non-Anthropic base URL, skip the global
      // default so the provider's own ANTHROPIC_MODEL env decides the model.
      const model = session.model || (opts.skipDefaultModel ? null : claudeDefaultModel());
      if (model) args.push('--model', model);
      if (CLAUDE_CHAT_DISALLOWED_TOOLS.length) {
        args.push('--disallowedTools', CLAUDE_CHAT_DISALLOWED_TOOLS.join(','));
      }
      // Goal mode round limit: cap the autonomous agent-turn loop for this spawn.
      if (opts.maxTurns > 0) args.push('--max-turns', String(opts.maxTurns));
      if (opts.isFirstTurn) args.push('--session-id', session.cliSessionId);
      else args.push('--resume', session.cliSessionId);
      args.push(prompt);
      return args;
    },
    // Whether this provider needs the session id captured asynchronously after first launch
    needsAsyncSessionIdCapture: false,
  },
  codex: {
    name: 'codex',
    cmd: CODEX_CMD,
    // Interactive terminal: `codex` first time, `codex resume <id>` if id captured.
    // Add `--dangerously-bypass-approvals-and-sandbox` to skip prompts (we run trusted local code).
    buildTerminalCmd(session) {
      const baseArgs = CODEX_ARGS.length ? ' ' + CODEX_ARGS.join(' ') : '';
      if (session.cliSessionId) return `${CODEX_CMD}${baseArgs} resume ${session.cliSessionId}`;
      return `${CODEX_CMD}${baseArgs}`;
    },
    // Chat-mode spawn args: `exec --json [--skip-git-repo-check] [--dangerously-bypass-approvals-and-sandbox] [resume <id>] <prompt>`
    buildChatSpawnArgs(session, prompt, opts) {
      const args = [];
      // Codex `exec` has no system-prompt flag, so the role prompt is prepended
      // into the prompt text — only on the first turn, since `exec resume` keeps
      // the earlier context (re-sending every turn would just waste tokens).
      let p = prompt;
      if (opts.isFirstTurn && opts.rolePrompt) {
        p = `[角色设定]\n${opts.rolePrompt}\n[角色设定结束]\n\n${prompt}`;
      }
      if (opts.isFirstTurn) {
        args.push('exec', '--json', '--skip-git-repo-check',
          '--dangerously-bypass-approvals-and-sandbox', p);
      } else {
        args.push('exec', 'resume', session.cliSessionId, '--json',
          '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', p);
      }
      return args;
    },
    needsAsyncSessionIdCapture: true,  // capture from ~/.codex/sessions filename
  },
};

function providerFor(session) {
  return cliProviders[session?.cli] || cliProviders.claude;
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
  TMUX_PREFIX, tmuxSessionName, tmuxHasSession, tmuxCreateSession, tmuxResize,
  applyMaxClientSize, tmuxKillSession, tmuxCapturePane, tmuxPaneTty, tmuxPaneCwd,
  tmuxWriteInput, fifoPathForSession, startOutputCapture, stopOutputCapture,
} = require('./src/tmux');

// Recover existing tmux sessions on startup (survives server restart)
function recoverTmuxSessions() {
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf8' });
    for (const name of output.trim().split('\n')) {
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
        createSession(id);
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
  gitWorktreeAdd, gitWorktreeRemove, gitWorktreeCommitAll, gitWorktreeMergeState, gitMergeBack,
  gitSyncFromBase, gitRebaseResolve,
} = require('./src/git');

// gitWorktreeMergeState fires ~4 synchronous git subprocesses per session. It is
// read once per session on every /api/sessions poll, so on a busy server (dozens
// of sessions × many open clients) it forks git nonstop and blocks the event
// loop. Wrap it in a short TTL memo (with per-entry jitter so a batch populated
// in one poll doesn't all expire on the same later tick). Mutating endpoints
// (merge/sync/commit) call mergeStateFresh() to recompute and refresh the cache
// so the UI never shows a stale indicator after an actual git change. WS
// broadcasts already push fresh state to active viewers, so the bounded staleness
// only ever affects passive REST polling.
const _mergeStateCache = makeTtlCache(4000, 3000);
function mergeStateKey(session) { return session && session.id ? session.id : null; }
function mergeStateCached(dir, session) {
  const key = mergeStateKey(session);
  if (!key) return gitWorktreeMergeState(dir, session);
  return _mergeStateCache.get(key, () => gitWorktreeMergeState(dir, session));
}
function mergeStateFresh(dir, session) {
  const value = gitWorktreeMergeState(dir, session);
  const key = mergeStateKey(session);
  if (key) _mergeStateCache.set(key, value);
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
function ensureDirGitReady(dir) {
  if (gitReadyDirs.has(dir.id)) return { ok: true };
  if (isHomeOrAbove(dir.path)) return { ok: false, reason: 'home-or-above' };
  if (!fs.existsSync(dir.path)) return { ok: false, reason: 'path-missing' };
  // Reject pathological dirs BEFORE any git command. `git add -A` / `git worktree
  // add` on a huge working tree (e.g. ~/Downloads, 57GB) freeze the event loop.
  // Runs unconditionally — even a stray .git left by a prior failed attempt must
  // not bypass this. Measures working-tree content, excluding .git/worktrees.
  const fit = dirSuitability(dir.path);
  if (!fit.ok) return { ok: false, reason: 'unsuitable: ' + fit.reason };
  try {
    if (!gitIsRepo(dir.path)) {
      console.log(`[multicc] git init: ${dir.path}`);
      gitRun(dir.path, ['init']);
    }
    gitEnsureExcluded(dir.path);
    if (!gitHasCommit(dir.path)) {
      try { gitRun(dir.path, ['add', '-A']); } catch (_) {}
      gitRun(dir.path, ['-c', 'user.email=multicc@local', '-c', 'user.name=multicc',
        'commit', '--allow-empty', '-m', 'multicc: initial commit']);
    }
    dir.baseBranch = gitBaseBranch(dir.path);
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
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const DIRECTORIES_FILE = path.join(__dirname, 'directories.json');

function loadDirectories() {
  try {
    if (fs.existsSync(DIRECTORIES_FILE)) {
      const data = JSON.parse(fs.readFileSync(DIRECTORIES_FILE, 'utf8'));
      const map = new Map();
      for (const d of data) map.set(d.id, d);
      return map;
    }
  } catch (e) {
    console.error('[multicc] Failed to load directories.json:', e.message);
  }
  return new Map();
}

function saveDirectories() {
  try {
    fs.writeFileSync(DIRECTORIES_FILE, JSON.stringify([...directories.values()], null, 2));
  } catch (e) {
    console.error('[multicc] Failed to save directories.json:', e.message);
  }
}

function isNewSchema(arr) {
  return arr.some(s => s.dirId !== undefined || s.kind !== undefined);
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
  try {
    if (fs.existsSync(SESSIONS_FILE)) rawSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch (e) {
    console.error('[multicc] Failed to load sessions.json:', e.message);
  }

  const dirMap = loadDirectories();

  if (rawSessions.length > 0 && !isNewSchema(rawSessions)) {
    console.log('[multicc] Migrating sessions.json to directory-based schema...');
    const { newDirs, newSessions, chatHistoryRenames } = migrateOldSchema(rawSessions);
    // Rename chat_history files (old paired id → new chat session id)
    const CHAT_DIR = path.join(__dirname, 'chat_history');
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
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[multicc] Failed to save sessions.json:', e.message);
  }
}

const _state = loadPersistedState();
const directories = _state.directories;
const persistedSessions = _state.persistedSessions;
if (_state.needsSave) {
  saveDirectories();
  savePersistedSessions();
  console.log(`[multicc] Migration complete: ${directories.size} directories, ${persistedSessions.size} sessions`);
}

// Startup: ensure every session has an isolated worktree. Legacy sessions (created
// before worktree isolation) get one built here. Sessions whose directory is invalid
// ($HOME, or a duplicate physical path) are marked invalid and skipped at recovery.
function initWorktrees() {
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

    const ready = ensureDirGitReady(dir);
    if (!ready.ok) { invalidSessions.set(s.id, 'git not ready: ' + ready.reason); continue; }
    try {
      const { worktreePath, branch } = gitWorktreeAdd(dir.path, s.id, dir.baseBranch);
      s.worktreePath = worktreePath;
      s.branch = branch;
      built++;
      // Legacy terminal session still running in the old (non-worktree) tmux pane:
      // kill it so recovery recreates the session inside its worktree.
      if (s.kind === 'terminal' && tmuxHasSession(s.id)) {
        console.log(`[multicc] migrating terminal ${s.id} into worktree — discarding old tmux pane`);
        tmuxKillSession(s.id);
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
    '<<dispatch target="SESSION_ID">要交给该 session 执行的完整、自包含指令</dispatch>>',
    '其中 SESSION_ID 必须是上面可见 sessions 列表里的 id；dispatch 内的指令要完整到该 session 无需追问即可执行。',
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
const DISPATCH_RE = /<<dispatch\s+target="([^"]+)"\s*>([\s\S]*?)<\/dispatch>>/;
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

// Push a server-originated assistant message into the gateway chat. Web clients
// render it; the WeChat bridge (a gateway WS client) forwards it on `result`.
function pushToGateway(text, { persist = true } = {}) {
  if (!text) return;
  if (persist) appendChatMessage(GATEWAY_ID, { role: 'assistant', content: text, ts: Date.now() });
  chatBroadcast(GATEWAY_ID, { type: 'assistant', message: { content: [{ type: 'text', text }] } });
  chatBroadcast(GATEWAY_ID, { type: 'result', total_cost_usd: null });
}

// A dispatch target must be a real, non-system session.
function validateDispatchTarget(targetId) {
  const rec = persistedSessions.get(targetId);
  if (!rec) return { ok: false, error: `目标 session「${targetId}」不存在` };
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
  const v = validateDispatchTarget(targetId);
  if (!v.ok) return { ok: false, error: v.error };
  const rec = v.rec;

  let chatId;
  if (rec.kind === 'chat') {
    chatId = targetId;
  } else {
    // terminal-only target → create/reuse an ephemeral chat in the same directory.
    const created = createSessionRecord({
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
  const ok = services.call('chat.runTurn', chatId, message, { originDispatchId: dispatchId });
  if (ok === false) { dispatchRuns.delete(dispatchId); return { ok: false, error: `启动 ${targetId} 回合失败` }; }
  return { ok: true, chatId };
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
const DISPATCH_RE_G = /<<dispatch\s+target="([^"]+)"\s*>([\s\S]*?)<\/dispatch>>/g;
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
function maybeDispatchFromChatTurn(dispatcherId, finalText) {
  const markers = parseAllDispatchMarkers(finalText);
  if (!markers.length) return;
  const from = persistedSessions.get(dispatcherId);
  if (!from) return;
  for (const mk of markers) {
    if (mk.target === dispatcherId) continue;                       // no self-dispatch
    const v = validateDispatchTarget(mk.target);
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
  const cliPart = cli === 'codex' ? 'codex' : 'claude';
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

function createSession(id) {
  // Look up the persisted record (must exist — sessions are pre-created via REST now)
  const persisted = persistedSessions.get(id);
  if (!persisted) {
    throw new Error(`Session ${id} has no persisted record. Create it via /api/directories/:id/sessions first.`);
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
  if (!tmuxHasSession(id)) {
    console.log(`[multicc] Creating tmux session: ${tmuxSessionName(id)} in ${cwd} (${provider.name} session: ${persisted.cliSessionId || '<pending>'})`);
    tmuxCreateSession(id, cwd, 80, 24, provider.buildTerminalCmd(persisted || {}), termEnv);
  } else {
    console.log(`[multicc] Attaching to existing tmux session: ${tmuxSessionName(id)}`);
    isRecovery = true;
  }

  // Get the tty device path for direct input writes
  const ttyPath = tmuxPaneTty(id);

  // Start output capture via pipe-pane → FIFO
  const { stream, fifoPath } = startOutputCapture(id);

  // Pre-fill buffer with current terminal content for recovered sessions
  const initialBuffer = [];
  if (isRecovery) {
    const captured = tmuxCapturePane(id);
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
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'output', data: str }));
      }
    }
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
    setTimeout(() => {
      if (sessions.get(id) !== session) return;
      if (!tmuxHasSession(id)) {
        console.log(`[multicc] Session ${id} exited (tmux session gone)`);
        cleanupPushMonitor(id);
        if (session.captureTimer) { clearInterval(session.captureTimer); session.captureTimer = null; }
        const cliLabel = session.cli === 'codex' ? 'Codex' : 'Claude Code';
        const exitMsg = `\r\n\x1b[33m[${cliLabel} process exited]\x1b[0m\r\n`;
        for (const client of session.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'exit', data: exitMsg }));
          }
        }
        stopOutputCapture(session);
        sessions.delete(id);
      } else {
        // Tmux session still alive but stream died — restart output capture
        console.log(`[multicc] Stream died for ${id}, restarting output capture...`);
        stopOutputCapture(session);
        try {
          const { stream: newStream, fifoPath: newFifo } = startOutputCapture(id);
          session.outputStream = newStream;
          session.fifoPath = newFifo;
          const newDecoder = new StringDecoder('utf8');
          newStream.on('data', (data) => {
            const str = newDecoder.write(data);
            if (!str) return;
            session.buffer.push(str);
            if (session.buffer.length > 500) session.buffer.shift();
            session.lastActivity = new Date();
            for (const client of session.clients) {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'output', data: str }));
              }
            }
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
  session.exitCheckTimer = setInterval(() => {
    if (sessions.get(id) !== session) {
      clearInterval(session.exitCheckTimer);
      return;
    }
    if (!tmuxHasSession(id)) {
      clearInterval(session.exitCheckTimer);
      onStreamEnd();
    }
  }, 3000);

  sessions.set(id, session);
  return session;
}

// ── REST API ──
app.use(express.json());

// Codex Responses↔Chat 协议转换代理（国产服务商 DeepSeek/GLM/Qwen/MiniMax）。
// 必须在 express.json() 之后挂载，以便 req.body 已解析。详见 docs/codex-proxy-contract.md。
mountCodexProxy(app, { getProvider: providers.getProvider, getPort: () => PORT });

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
        rolePrompt: p.rolePrompt || null,
        provider: p.provider || null,  // cc-switch provider id; null = default login
        autoCommit: !!p.autoCommit,
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
function agentCommanderPrompt() {
  const data = loadAgentPresets();
  const p = data && (data.presets || []).find(x => x.id === AGENT_COMMANDER_PRESET_ID);
  return (p && p.prompt) ? p.prompt : null;
}

app.get('/api/agent-presets', (req, res) => {
  const data = loadAgentPresets();
  if (!data) return res.status(500).json({ error: 'agent presets unavailable' });
  // Strip the prompt field from the list to keep the payload small.
  const presets = (data.presets || []).map(({ prompt, ...meta }) => meta);
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
  res.json(preset);
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

// ── Directory REST API ──
// Browse / autocomplete filesystem directories for the "new directory" picker.
// No root restriction (local dev tool, localhost + optional ACCESS_TOKEN). Given
// ?path=, returns that directory's subdirectories; if path is a partial (parent
// exists but the full path doesn't), returns the parent's subdirectories whose
// name prefix-matches the trailing segment — shell-style tab completion.
app.get('/api/fs/list', (req, res) => {
  try {
    let raw = (req.query.path || '').toString().trim();
    if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
      raw = path.join(os.homedir(), raw.slice(1));
    }
    let baseDir, prefix = '';
    const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
    if (!raw) {
      baseDir = os.homedir();
    } else if (isDir(raw)) {
      baseDir = raw;
    } else {
      baseDir = path.dirname(raw);
      prefix = path.basename(raw).toLowerCase();
      if (!isDir(baseDir)) {
        return res.json({ base: baseDir, parent: null, entries: [] });
      }
    }
    let dirents;
    try { dirents = fs.readdirSync(baseDir, { withFileTypes: true }); }
    catch (e) { return res.status(400).json({ error: `无法读取目录：${e.message}` }); }
    const entries = dirents
      .filter(d => {
        let dir = d.isDirectory();
        if (!dir && d.isSymbolicLink()) dir = isDir(path.join(baseDir, d.name));
        if (!dir) return false;
        if (d.name.startsWith('.') && !prefix.startsWith('.')) return false;
        if (prefix && !d.name.toLowerCase().startsWith(prefix)) return false;
        return true;
      })
      .map(d => ({ name: d.name, path: path.join(baseDir, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 200);
    const root = path.parse(baseDir).root;
    res.json({ base: baseDir, parent: baseDir === root ? null : path.dirname(baseDir), entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/directories', async (req, res) => {
  // Annotate each directory with counts per (cli, kind). pushState is cached +
  // serialized in git-push.js, so this Promise.all never forks more than one git
  // at a time and most polls resolve from cache without spawning git at all.
  const list = await Promise.all([...directories.values()].map(async d => {
    const counts = { claude_terminal: 0, claude_chat: 0, codex_terminal: 0, codex_chat: 0 };
    for (const s of persistedSessions.values()) {
      if (s.dirId !== d.id) continue;
      const k = `${s.cli || 'claude'}_${s.kind || 'terminal'}`;
      if (counts[k] !== undefined) counts[k]++;
    }
    let pushState;
    try {
      pushState = await gitPush.directoryPushState(d.path, d.baseBranch || gitBaseBranch(d.path));
    } catch (error) {
      pushState = { available: false, hasRemote: false, ahead: 0, behind: 0, reason: error.message };
    }
    return { ...d, counts, pushState };
  }));
  res.json(list);
});

app.post('/api/directories/:id/push', async (req, res) => {
  const d = directories.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'directory not found' });
  try {
    const result = await gitPush.pushDirectory(d.path, d.baseBranch || gitBaseBranch(d.path));
    appendEvent(d.id, 'pushed', result.pushed
      ? `${result.before.ahead} 个提交 → ${result.before.remote}/${result.before.remoteBranch}`
      : '无待推送提交');
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/directories', (req, res) => {
  const name = (req.body.name || '').trim();
  const rawPath = (req.body.path || '').trim();
  const wantCreate = req.body.create === true || req.body.create === 'true';
  if (!name || !rawPath) return res.status(400).json({ error: 'name and path required' });
  const resolvedPath = resolveCwd(os.homedir(), rawPath);
  if (isHomeOrAbove(resolvedPath)) {
    return res.status(400).json({ error: '不允许选择 $HOME 或更高层目录' });
  }
  if (!fs.existsSync(resolvedPath)) {
    if (!wantCreate) {
      return res.status(400).json({ error: `path does not exist: ${resolvedPath}` });
    }
    try { fs.mkdirSync(resolvedPath, { recursive: true }); }
    catch (e) { return res.status(400).json({ error: `无法创建目录: ${e.message}` }); }
  } else if (!fs.statSync(resolvedPath).isDirectory()) {
    return res.status(400).json({ error: `路径不是目录: ${resolvedPath}` });
  }
  const dup = findDirByPath(resolvedPath);
  if (dup) {
    return res.status(400).json({ error: `该路径已被目录 "${dup.name}" 登记，不允许重复` });
  }
  const id = crypto.randomUUID();
  const dir = { id, name, path: resolvedPath, createdAt: new Date().toISOString() };
  directories.set(id, dir);
  // Force the directory to be a usable git repo (worktree isolation depends on it).
  const ready = ensureDirGitReady(dir);
  if (!ready.ok) {
    directories.delete(id);
    return res.status(400).json({ error: friendlyDirReason(ready.reason) });
  }
  saveDirectories();
  // Seed every newly-created directory with a default Agent Commander chat
  // session, so a fleet conductor is ready out of the box. Runs only here at
  // creation → existing directories are untouched. Best-effort: any failure is
  // logged but never blocks directory creation.
  try {
    const commander = agentCommanderPrompt();
    if (commander) {
      const r = createSessionRecord({ dir, cli: 'claude', kind: 'chat', label: '🫡 Agent Commander' });
      if (r.ok) {
        r.session.rolePrompt = commander;
        savePersistedSessions();
        appendEvent(dir.id, 'session_role_changed', `${r.session.label || r.session.id}（默认指挥官）`, r.session.id);
      } else {
        console.warn(`[multicc] seed commander session failed for dir ${dir.id}: ${r.error}`);
      }
    } else {
      console.warn('[multicc] Agent Commander preset not found; skipping seed session for new dir');
    }
  } catch (e) {
    console.warn(`[multicc] seed commander session error for dir ${dir.id}: ${e.message}`);
  }
  res.json(dir);
});

app.patch('/api/directories/:id', (req, res) => {
  const d = directories.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'directory not found' });
  if (req.body.name) d.name = String(req.body.name).trim();
  if (req.body.path) {
    const resolved = resolveCwd(os.homedir(), String(req.body.path).trim());
    if (!fs.existsSync(resolved)) return res.status(400).json({ error: `path does not exist: ${resolved}` });
    if (isHomeOrAbove(resolved)) {
      return res.status(400).json({ error: '不允许选择 $HOME 或更高层目录' });
    }
    const dup = findDirByPath(resolved, d.id);
    if (dup) return res.status(400).json({ error: `该路径已被目录 "${dup.name}" 登记，不允许重复` });
    if (realPathOf(resolved) !== realPathOf(d.path)) {
      d.path = resolved;
      // Path changed → re-verify git readiness for the new location.
      gitReadyDirs.delete(d.id);
      const ready = ensureDirGitReady(d);
      if (!ready.ok) return res.status(400).json({ error: `无法将目录初始化为 git 仓库: ${ready.reason}` });
    }
  }
  if (req.body.rolePrompt !== undefined) {
    const rp = (req.body.rolePrompt == null ? '' : String(req.body.rolePrompt));
    if (rp.length > 40000) return res.status(400).json({ error: 'rolePrompt too long (max 40000)' });
    // Directory-level default role; sessions without their own role inherit it.
    d.rolePrompt = rp.trim() || null;
  }
  saveDirectories();
  res.json(d);
});

app.delete('/api/directories/:id', (req, res) => {
  const d = directories.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'directory not found' });
  // Refuse to delete a non-empty directory unless ?force=1 is passed
  const owned = [...persistedSessions.values()].filter(s => s.dirId === d.id);
  if (owned.length > 0 && req.query.force !== '1') {
    return res.status(400).json({ error: `directory has ${owned.length} session(s); pass ?force=1 to delete them too`, sessions: owned.map(s => s.id) });
  }
  // Kill + remove all sessions under this dir
  for (const s of owned) {
    const active = sessions.get(s.id);
    if (active) { tmuxKillSession(s.id); sessions.delete(s.id); }
    const chat = chatSessions.get(s.id);
    if (chat) {
      if (chat.claudeProc) try { chat.claudeProc.kill('SIGTERM'); } catch (_) {}
      chatStream.close(s.id);
      chatSessions.delete(s.id);
    }
    waitInjector.cancelForSession(s.id);
    share.removeForSession(s.id);
    if (s.worktreePath && s.branch) gitWorktreeRemove(d.path, s.worktreePath, s.branch);
    teardownTriggers(s.id);
    purgeNotesForSession(s.id);
    persistedSessions.delete(s.id);
    invalidSessions.delete(s.id);
    workspaceStatus.delete(s.id);
  }
  directories.delete(d.id);
  saveDirectories();
  savePersistedSessions();
  res.json({ ok: true, removedSessions: owned.length });
});

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
        model: s.model || null, rolePrompt: s.rolePrompt || null,
        provider: s.provider || null,  // cc-switch provider id; null = default login
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
function createSessionRecord({ dir, cli, kind, label = null, id = null, ephemeral = false, model = null, provider = undefined }) {
  if (!dir) return { ok: false, error: 'directory not found' };
  if (!['claude', 'codex'].includes(cli)) return { ok: false, error: 'cli must be claude or codex' };
  if (!['terminal', 'chat'].includes(kind)) return { ok: false, error: 'kind must be terminal or chat' };
  // Model is claude-only and interpolated into a tmux shell command — keep the charset
  // tight, but allow `/` and `:` so OpenRouter-style ids (openrouter/owl-alpha,
  // anthropic/claude-sonnet-4.6) and provider:model forms pass; neither is a shell metachar.
  if (model && (cli !== 'claude' || !/^[A-Za-z0-9._:\/\[\]-]{1,100}$/.test(model))) {
    return { ok: false, error: 'invalid model' };
  }
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
  const ready = ensureDirGitReady(dir);
  if (!ready.ok) return { ok: false, error: friendlyDirReason(ready.reason) };
  let worktreePath, branch;
  try {
    ({ worktreePath, branch } = gitWorktreeAdd(dir.path, sid, dir.baseBranch));
  } catch (e) {
    return { ok: false, error: 'worktree 创建失败: ' + e.message };
  }

  const session = {
    id: sid,
    dirId: dir.id,
    cli, kind,
    cliSessionId: null,   // claude gets one allocated on spawn; codex captures from first event
    label,
    model: model || null, // claude-only; null = follow the user's /model default
    provider: providerId,  // cc-switch provider id; null = default login/subscription
    createdAt: new Date().toISOString(),
    worktreePath,
    branch,
  };
  if (ephemeral) session.ephemeral = true;
  persistedSessions.set(sid, session);
  savePersistedSessions();
  appendEvent(dir.id, 'session_created', `${cli} ${kind}${ephemeral ? ' (gw)' : ''}`, sid);
  return { ok: true, id: sid, session };
}

app.post('/api/directories/:id/sessions', (req, res) => {
  const d = directories.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'directory not found' });
  const cli = (req.body.cli || '').trim();
  const kind = (req.body.kind || '').trim();
  const label = (req.body.label || '').trim() || null;
  const model = (req.body.model || '').trim() || null;
  // provider: omit → inherit global default; '' → explicit no-override; id → that provider.
  const provider = req.body.provider === undefined ? undefined : ((req.body.provider || '').trim() || '');
  const rolePrompt = (req.body.rolePrompt || '').trim() || null;
  const r = createSessionRecord({ dir: d, cli, kind, label, model, provider });
  if (!r.ok) return res.status(400).json({ error: r.error });
  // Apply rolePrompt after session is created
  if (rolePrompt) {
    r.session.rolePrompt = rolePrompt;
    savePersistedSessions();
  }
  res.json(r.session);
});

// PATCH a session — supports display-name edits via label.
app.patch('/api/sessions/:id', (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (s.type === 'aux' || s.type === 'gateway') {
    return res.status(400).json({ error: 'system session cannot be renamed' });
  }
  if (req.body.label !== undefined) {
    const label = (req.body.label || '').toString().trim();
    if (label.length > 80) return res.status(400).json({ error: 'label too long (max 80)' });
    s.label = label || null;
    appendEvent(s.dirId, 'session_renamed', s.label || s.id, s.id);
  }
  if (req.body.model !== undefined) {
    const model = (req.body.model || '').toString().trim();
    if (s.cli !== 'claude') return res.status(400).json({ error: 'model is claude-only' });
    // Allow `/` and `:` for OpenRouter-style ids (openrouter/owl-alpha) and provider:model forms.
    if (model && !/^[A-Za-z0-9._:\/\[\]-]{1,100}$/.test(model)) {
      return res.status(400).json({ error: 'invalid model' });
    }
    s.model = model || null;
    // Chat sessions pick this up on the next turn (fresh spawn per turn);
    // terminal sessions need a session restart to relaunch claude with it.
    appendEvent(s.dirId, 'session_model_changed', `${s.label || s.id} → ${s.model || '默认'}`, s.id);
  }
  if (req.body.rolePrompt !== undefined) {
    const rp = (req.body.rolePrompt == null ? '' : String(req.body.rolePrompt));
    if (rp.length > 40000) return res.status(400).json({ error: 'rolePrompt too long (max 40000)' });
    // null clears the session override → it falls back to the directory default.
    s.rolePrompt = rp.trim() || null;
    appendEvent(s.dirId, 'session_role_changed', s.rolePrompt ? (s.label || s.id) : `${s.label || s.id}（清除，继承目录）`, s.id);
  }
  if (req.body.memory !== undefined) {
    // Session memory: distilled key problems/solutions. User can view/edit/clear.
    const mem = (req.body.memory == null ? '' : String(req.body.memory));
    if (mem.length > SESSION_MEMORY_MAX) return res.status(400).json({ error: `memory too long (max ${SESSION_MEMORY_MAX})` });
    s.memory = mem.trim() || null;
    appendEvent(s.dirId, 'memory_updated', s.memory ? '手动编辑会话记忆' : '清空会话记忆', s.id);
    workspaceBroadcast(s.dirId, { type: 'memory', sessionId: s.id, memory: s.memory || '' });
  }
  if (req.body.streaming !== undefined) {
    // Experimental: keep a persistent streaming claude process across turns.
    if ((s.cli || 'claude') !== 'claude') return res.status(400).json({ error: 'streaming is claude-only' });
    s.streaming = !!req.body.streaming;
    if (!s.streaming) chatStream.close(s.id); // tear down any warm process
    appendEvent(s.dirId, 'session_streaming_changed', `${s.label || s.id} → ${s.streaming ? '流式常驻' : '逐轮'}`, s.id);
  }
  if (req.body.autoContinue !== undefined) {
    // D fallback: auto-nudge the session to continue when a turn ends only
    // "waiting on a background task" (guarded; see wait-injector).
    s.autoContinue = !!req.body.autoContinue;
    if (!s.autoContinue) waitInjector.resetAuto(s.id);
    appendEvent(s.dirId, 'session_autocontinue_changed', `${s.label || s.id} → ${s.autoContinue ? '自动接力' : '关闭'}`, s.id);
  }
  if (req.body.autoCommit !== undefined) {
    // Auto-commit and merge worktree back to base branch after task completion.
    s.autoCommit = !!req.body.autoCommit;
    appendEvent(s.dirId, 'session_autocommit_changed', `${s.label || s.id} → ${s.autoCommit ? '自动提交合并' : '关闭'}`, s.id);
  }
  if (req.body.provider !== undefined) {
    // Per-session cc-switch provider. '' / null clears the override → default login.
    const v = validProviderId(s.cli || 'claude', (req.body.provider || '').toString().trim());
    if (!v.ok) return res.status(400).json({ error: 'invalid provider' });
    s.provider = v.value;
    // When switching provider the old session.model may hold a model that
    // only works with the previous backend (e.g. claude-opus-4-8 set while
    // on Anthropic Official, then switching to DeepSeek/GLM which don't
    // ship that model). Clear it so the provider's own ANTHROPIC_MODEL /
    // ANTHROPIC_DEFAULT_*_MODEL env takes effect and the user can re-set
    // via /model afterwards if they need something specific.
    if (s.model) s.model = null;
    // Chat sessions pick it up on the next per-turn spawn; a warm streaming
    // process must be torn down so it relaunches with the new env.
    if (s.streaming) chatStream.close(s.id);
    const pname = v.value ? (providers.getProviderSummary(s.cli === 'codex' ? 'codex' : 'claude', v.value)?.name || v.value) : '默认登录';
    appendEvent(s.dirId, 'session_provider_changed', `${s.label || s.id} → ${pname}`, s.id);
  }
  savePersistedSessions();
  res.json(s);
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
app.get('/api/sessions/:id/history', (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  res.json({ messages: loadChatHistory(req.params.id) });
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
  // The session's own role override (null = inherits the directory default).
  const rolePrompt = persisted?.rolePrompt || null;
  const memory = persisted?.memory || null;  // distilled session memory
  const streaming = !!persisted?.streaming;
  const autoContinue = !!persisted?.autoContinue;
  const autoCommit = !!persisted?.autoCommit;
  const provider = persisted?.provider || null;  // cc-switch provider id; null = default login
  const activeChat = persisted?.kind === 'chat' ? chatSessions.get(id) : null;
  const lastActivity = persisted?.kind === 'chat' ? chatLastActivity(id, activeChat) : null;
  if (active) {
    res.json({ id: active.id, cwd: active.cwd, createdAt: active.createdAt, lastActivity: active.lastActivity, clients: active.clients.size, active: true, mergeState, cli, model, rolePrompt, memory, provider, streaming, autoContinue, autoCommit });
  } else if (persisted?.kind === 'chat') {
    res.json({ id: persisted.id, cwd: cwdForSession(persisted), createdAt: persisted.createdAt, lastActivity, clients: activeChat ? activeChat.clients.size : 0, active: !!(activeChat && (activeChat.clients.size > 0 || activeChat.isStreaming)), mergeState, cli, model, rolePrompt, memory, provider, streaming, autoContinue, autoCommit });
  } else {
    res.json({ id: persisted.id, cwd: persisted.cwd, createdAt: persisted.createdAt, lastActivity: null, clients: 0, active: false, mergeState, cli, model, rolePrompt, memory, provider, streaming, autoContinue, autoCommit });
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
  const baseBranch = dir.baseBranch || gitBaseBranch(dir.path);
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

app.delete('/api/sessions/:id', (req, res) => {
  const id = req.params.id;
  const session = sessions.get(id);
  const chat = chatSessions.get(id);
  if (!session && !chat && !persistedSessions.has(id)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (session) {
    tmuxKillSession(session.id);
    if (session.exitCheckTimer) clearInterval(session.exitCheckTimer);
    if (session.captureTimer) clearInterval(session.captureTimer);
    sessions.delete(id);
  }
  if (chat) {
    if (chat.claudeProc) try { chat.claudeProc.kill('SIGTERM'); } catch (_) {}
    chatStream.close(id);
    if (chat.pendingClassifyTimer) clearTimeout(chat.pendingClassifyTimer);
    chatSessions.delete(id);
  }
  waitInjector.cancelForSession(id);
  share.removeForSession(id);
  // Remove the session's git worktree + branch.
  const persisted = persistedSessions.get(id);
  if (persisted && persisted.worktreePath && persisted.branch) {
    const dir = directories.get(persisted.dirId);
    if (dir) gitWorktreeRemove(dir.path, persisted.worktreePath, persisted.branch);
  }
  if (persisted) appendEvent(persisted.dirId, 'session_deleted', persisted.label || persisted.id, null);
  teardownTriggers(id);
  purgeNotesForSession(id);
  persistedSessions.delete(id);
  invalidSessions.delete(id);
  workspaceStatus.delete(id);
  savePersistedSessions();
  res.json({ ok: true });
});

// Relocate: moves a session to a different directory. Caller passes the target dirId.
// (Old "change cwd" semantics are gone — cwd lives on the directory now.)
app.post('/api/sessions/:id/relocate', (req, res) => {
  const id = req.params.id;
  const targetDirId = (req.body.dirId || '').trim();
  if (!targetDirId) return res.status(400).json({ error: 'dirId required (cwd is now owned by the directory)' });
  const targetDir = directories.get(targetDirId);
  if (!targetDir) return res.status(404).json({ error: 'target directory not found' });
  const persisted = persistedSessions.get(id);
  if (!persisted) return res.status(404).json({ error: 'session not found' });
  if (!fs.existsSync(targetDir.path)) return res.status(400).json({ error: `directory path missing on disk: ${targetDir.path}` });

  // The session's worktree belongs to the OLD directory's repo — relocate means
  // a fresh worktree in the target directory.
  const oldDir = directories.get(persisted.dirId);
  const readyTarget = ensureDirGitReady(targetDir);
  if (!readyTarget.ok) {
    return res.status(400).json({ error: `目标目录 git 未就绪: ${readyTarget.reason}` });
  }

  const oldSession = sessions.get(id);
  if (oldSession) {
    for (const client of oldSession.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'relocate', cwd: targetDir.path }));
      }
    }
    sessions.delete(id);
    tmuxKillSession(oldSession.id);
  }

  if (oldDir && persisted.worktreePath && persisted.branch) {
    gitWorktreeRemove(oldDir.path, persisted.worktreePath, persisted.branch);
  }
  try {
    const { worktreePath, branch } = gitWorktreeAdd(targetDir.path, id, targetDir.baseBranch);
    persisted.worktreePath = worktreePath;
    persisted.branch = branch;
  } catch (e) {
    return res.status(500).json({ error: 'worktree 创建失败: ' + e.message });
  }

  persisted.dirId = targetDirId;
  // Clear cliSessionId so the new instance starts fresh in the new directory
  persisted.cliSessionId = null;
  invalidSessions.delete(id);
  savePersistedSessions();

  if (persisted.kind === 'terminal') {
    try {
      createSession(id);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  res.json({ ok: true, cwd: targetDir.path });
});

// ── Restart session (kill tmux + respawn CLI in same directory, fresh conversation) ──
app.post('/api/sessions/:id/restart', (req, res) => {
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
    stopOutputCapture(oldSession);
    if (oldSession.exitCheckTimer) clearInterval(oldSession.exitCheckTimer);
    if (oldSession.captureTimer) clearInterval(oldSession.captureTimer);
    cleanupPushMonitor(id);
    oldSession.clients.clear();
  }
  tmuxKillSession(id);

  // Clear cliSessionId so a brand-new conversation starts (claude allocates a fresh UUID,
  // codex generates a fresh thread on first turn). The worktree is kept across restarts;
  // only recreate it if it has gone missing.
  if (persisted) {
    persisted.cliSessionId = null;
    const dir = directories.get(persisted.dirId);
    if (dir && (!persisted.worktreePath || !fs.existsSync(persisted.worktreePath))) {
      const ready = ensureDirGitReady(dir);
      if (ready.ok) {
        try {
          const { worktreePath, branch } = gitWorktreeAdd(dir.path, id, dir.baseBranch);
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
    createSession(id);
    console.log(`[multicc] Session ${id} restarted in ${cwd}`);
    for (const client of oldClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'restart' }));
      }
    }
    res.json({ ok: true, cwd });
  } catch (err) {
    console.error('[multicc] Restart failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Merge a session's worktree branch back into the directory's base branch ──
app.post('/api/sessions/:id/merge', (req, res) => {
  const id = req.params.id;
  const persisted = persistedSessions.get(id);
  if (!persisted) return res.status(404).json({ error: 'session not found' });
  if (!persisted.worktreePath || !persisted.branch) {
    return res.status(400).json({ error: '该会话没有 worktree，无需合并' });
  }
  const dir = directories.get(persisted.dirId);
  if (!dir) return res.status(404).json({ error: 'directory not found' });

  const result = gitMergeBack(dir, persisted);
  if (!result.ok) {
    // conflict → 409 with file list; other failures → 400
    return res.status(result.conflicts?.length ? 409 : 400).json(result);
  }
  console.log(`[multicc] merge ${persisted.branch} → ${dir.baseBranch}: ` +
    (result.merged ? `${result.commits} commit(s)` : 'nothing to merge'));
  appendEvent(dir.id, 'merged',
    result.merged ? `${result.commits} 个提交 → ${dir.baseBranch}` : '无新提交', id);
  workspaceBroadcast(dir.id, { type: 'merge_status', sessionId: id, mergeState: mergeStateFresh(dir, persisted) });

  // When this merge actually advanced the base branch, every OTHER worktree in
  // the same directory is now behind base. Auto-sync them so siblings don't have
  // to be manually caught up one by one (the #1 friction in multi-session work).
  // Best-effort & non-blocking: each sync is independent; conflicts are skipped
  // and surfaced via the workspace event log rather than failing this response.
  if (result.merged) {
    const synced = autoSyncSiblingWorktrees(dir, id);
    if (synced.length) result.siblingsSynced = synced;
  }
  res.json(result);
});

// Pull the (just-advanced) base branch into every sibling worktree in `dir`
// except `exceptId`. Returns a summary array; broadcasts per-session merge state
// and a directory event. Conflicts are reported, not merged.
function autoSyncSiblingWorktrees(dir, exceptId) {
  const out = [];
  for (const s of persistedSessions.values()) {
    if (s.id === exceptId) continue;
    if (s.dirId !== dir.id) continue;
    if (!s.worktreePath || !s.branch) continue;
    try {
      // Automatic sync: abort on conflict so an unattended sibling session is
      // never left parked mid-rebase. The conflict still surfaces via merge
      // state (conflict badge) so the user can sync manually and resolve it.
      const r = gitSyncFromBase(dir, s, { abortOnConflict: true });
      if (r.ok && r.merged) {
        out.push({ id: s.id, commits: r.commits });
        appendEvent(dir.id, 'synced', `自动同步 ${r.commits} 个提交（${dir.baseBranch} 合并后）`, s.id);
        workspaceBroadcast(dir.id, { type: 'merge_status', sessionId: s.id, mergeState: mergeStateFresh(dir, s) });
      } else if (!r.ok && r.conflicts?.length) {
        out.push({ id: s.id, conflict: true, files: r.conflicts });
        appendEvent(dir.id, 'sync_conflict', `自动同步遇冲突，需手动处理：${r.conflicts.slice(0, 5).join(', ')}`, s.id);
        workspaceBroadcast(dir.id, { type: 'merge_status', sessionId: s.id, mergeState: mergeStateFresh(dir, s) });
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
app.post('/api/sessions/:id/sync', (req, res) => {
  const id = req.params.id;
  const persisted = persistedSessions.get(id);
  if (!persisted) return res.status(404).json({ error: 'session not found' });
  if (!persisted.worktreePath || !persisted.branch) {
    return res.status(400).json({ error: '该会话没有 worktree，无需同步' });
  }
  const dir = directories.get(persisted.dirId);
  if (!dir) return res.status(404).json({ error: 'directory not found' });

  const result = gitSyncFromBase(dir, persisted);
  if (!result.ok) {
    // A conflict leaves the worktree parked mid-rebase; broadcast the merge
    // state so the conflict badge shows up persistently on the card + chat,
    // not just as a one-shot toast on this response.
    if (result.conflicts?.length) {
      appendEvent(dir.id, 'sync_conflict',
        `同步 rebase 冲突，需手动解决：${result.conflicts.slice(0, 5).join(', ')}`, id);
      workspaceBroadcast(dir.id, { type: 'merge_status', sessionId: id, mergeState: mergeStateFresh(dir, persisted) });
    }
    return res.status(result.conflicts?.length ? 409 : 400).json(result);
  }
  console.log(`[multicc] sync ${dir.baseBranch} → ${persisted.branch}: ` +
    (result.merged ? `${result.commits} commit(s)` : 'already up to date'));
  appendEvent(dir.id, 'synced',
    result.merged ? `从 ${result.baseBranch} 同步 ${result.commits} 个提交` : '已是最新', id);
  workspaceBroadcast(dir.id, { type: 'merge_status', sessionId: id, mergeState: mergeStateFresh(dir, persisted) });
  res.json(result);
});

// Resolve a parked rebase (created by a conflicting sync): continue after the
// user staged their fixes in the worktree, or abort to roll back. Body: { action }.
app.post('/api/sessions/:id/rebase', (req, res) => {
  const id = req.params.id;
  const persisted = persistedSessions.get(id);
  if (!persisted) return res.status(404).json({ error: 'session not found' });
  if (!persisted.worktreePath || !persisted.branch) {
    return res.status(400).json({ error: '该会话没有 worktree' });
  }
  const dir = directories.get(persisted.dirId);
  if (!dir) return res.status(404).json({ error: 'directory not found' });

  const action = (req.body && req.body.action) === 'abort' ? 'abort' : 'continue';
  const result = gitRebaseResolve(dir, persisted, action);
  // Always re-broadcast: success clears the badge, partial-continue updates the
  // remaining conflict list, abort returns the worktree to a clean state.
  workspaceBroadcast(dir.id, { type: 'merge_status', sessionId: id, mergeState: mergeStateFresh(dir, persisted) });
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

// ── File upload for chat mode ──
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const ext = path.extname(req.file.originalname).replace(/[^a-z0-9.]/gi, '').slice(0, 12) || 'bin';
  const safeName = `multicc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext.startsWith('.') ? ext : '.' + ext}`;
  const tmpPath = path.join(os.tmpdir(), safeName);
  fs.writeFileSync(tmpPath, req.file.buffer);
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

  const apiKey = voice.cfg.WHISPER_API_KEY || voice.cfg.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'WHISPER_API_KEY 或 OPENROUTER_API_KEY 未设置' });
  }

  console.log(`[multicc/stt][${reqId}] File: ${req.file.originalname}, size: ${req.file.size}, mime: ${req.file.mimetype}`);
  console.log(`[multicc/stt][${reqId}] Forwarding to ${voice.cfg.WHISPER_BASE_URL}/audio/transcriptions (model: ${voice.cfg.WHISPER_MODEL})`);

  const t0 = Date.now();
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
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[multicc/stt][${reqId}] Whisper API error ${response.status}: ${errText.slice(0, 300)}`);
      return res.status(502).json({ error: `Whisper API ${response.status}: ${errText.slice(0, 200)}` });
    }

    const result = await response.json();
    const durationMs = Date.now() - t0;
    console.log(`[multicc/stt][${reqId}] Success in ${durationMs}ms, text length: ${(result.text || '').length}`);
    res.json({ text: result.text || '', duration_ms: durationMs });
  } catch (err) {
    const durationMs = Date.now() - t0;
    console.error(`[multicc/stt][${reqId}] Error after ${durationMs}ms:`, err.message);
    res.status(500).json({ error: err.message });
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
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  }).filter(l => l.trim() !== '');
  for (const [k, v] of Object.entries(updates)) {
    if (!written.has(k)) lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n');
}

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
      provider: env.ASR_PROVIDER || process.env.ASR_PROVIDER || 'openai',
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
  res.json({ ip, port: PORT, proto: 'http', url, token: ACCESS_TOKEN || '' });
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
  writeEnvFile({ ACCESS_TOKEN: token });
  process.env.ACCESS_TOKEN = token;
  ACCESS_TOKEN = token; // hot-reload: signToken/isAuthenticated read this live
  console.log(`[multicc/auth] ACCESS_TOKEN ${token ? 'updated' : 'cleared'} via localhost UI`);
  res.json({ ok: true, hasToken: !!token });
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

// Push a server-originated message to a terminal session's live WS clients.
function terminalBroadcast(sessionId, payload) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const json = JSON.stringify(payload);
  for (const client of session.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(json); } catch (_) {}
    }
  }
}

// Output went idle on a terminal session — the terminal equivalent of an SSE
// pause. Let the aux-AI judge done-vs-waiting from the output tail (single
// source of truth, same as chat), then fan the verdict out to every surface:
// push channels, the terminal's own WS clients, and the workspace board.
function classifyTerminalIdle(sessionId, tail) {
  const mon = pushMonitors.get(sessionId);
  if (mon) {
    if (mon.classifyPending) return; // one classification already in flight
    mon.classifyPending = true;
  }
  auxQueue.enqueue({
    type: 'intent_classify',
    prompt: `你是一个意图分析器。下面是一个命令行 AI 编码助手(Claude Code / Codex)终端会话的最近输出。请严格输出两行：
第1行：仅一个字母，表示当前状态——
  C = 任务已完成或回到空闲提示符，不需要用户操作
  W = 正在等待用户回复、确认或选择（如 y/n、Allow/Deny、编号选项、问题待答）
第2行：用不超过 20 个汉字概括整体任务是什么（如”memo图片更换””登录页样式修复””数据库迁移”），无法概括就留空。如果终端输出显示多步操作，请概括整体任务而非当前步骤。

终端输出（尾部）：
${tail}`,
    meta: { sessionId },
  }).then(result => {
    if (mon) mon.classifyPending = false;
    if (result.cancelled) return;
    const { state, summary } = parseClassifyResult(result.text);
    const doneMsg = summary ? `任务完成：${summary}` : '任务完成';
    const msg = state === 'waiting' ? '等待交互' : doneMsg;
    triggerPush(sessionId, state, msg);
    terminalBroadcast(sessionId, { type: 'notify', state, message: msg });
    const dirId = persistedSessions.get(sessionId)?.dirId;
    if (dirId) workspaceBroadcast(dirId, { type: 'notify', sessionId, state, message: msg });
    setSessionSummary(sessionId, summary);
    console.log(`[multicc/aux] Terminal classify for ${sessionId}: ${state}${summary ? ` · ${summary}` : ''}`);
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
  if (!mon) return;
  mon.state = 'idle';
  mon.chars = 0;
  mon.recentText = '';
  if (mon.idleTimer) {
    clearTimeout(mon.idleTimer);
    mon.idleTimer = null;
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

  const payload = {
    title: type === 'waiting' ? `MultiCC #${sessionId}: 等待操作`
      : type === 'error' ? `MultiCC #${sessionId}: 出现异常`
      : `MultiCC #${sessionId}: 完成`,
    body: `${message}\n${shortCwd}`,
    sessionId,
    type,
    tag: `multicc-${sessionId}`,
    url: `/manage`,
  };

  push.globalStats.lastPushTime = now;
  push.globalStats.lastPushType = type;
  push.globalStats.lastPushSessionId = sessionId;

  // Send to all channels in parallel
  push.sendPushToAll(payload);
  push.sendBarkNotification(payload.title, `${message} ${shortCwd}`, payload.url);
  push.sendWebhookNotification(payload);

  console.log(`[multicc/push] Sent ${type} notification for session ${sessionId}`);
}

// ── AuxQueue: stateless claude -p AI service (intent classification, etc.) ──
const AUX_SESSION_ID = '__aux__';
const AUX_TIMEOUT_MS = 30000;
const AUX_HISTORY_MAX = 200;

// Aux model config (persisted in aux-config.json). The aux helper runs short,
// stateless single-turn tasks (intent classify, summary, voice refine) — Haiku
// on the OAuth subscription is the cheap default, but it's configurable so the
// user can point it at any claude provider (e.g. a self-hosted/relay model) and
// model. providerId=null → default OAuth login; model=null → 'haiku'.
const AUX_CONFIG_FILE = path.join(__dirname, 'aux-config.json');
let auxConfig = { providerId: null, model: null };
function loadAuxConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(AUX_CONFIG_FILE, 'utf8'));
    auxConfig = { providerId: c.providerId || null, model: (c.model && String(c.model).trim()) || null };
  } catch (_) { /* no config yet → defaults */ }
}
function saveAuxConfig() {
  try { fs.writeFileSync(AUX_CONFIG_FILE, JSON.stringify(auxConfig, null, 2)); } catch (_) {}
}

const auxQueue = {
  queue: [],          // [{ id, type, prompt, meta, cancelled, resolve, reject, ts }]
  currentTask: null,
  processing: false,
  totalProcessed: 0,
  lastTaskTime: null,
  clients: new Set(), // WebSocket clients watching aux events
  history: [],        // loaded from chat_history/__aux__.json
  _warmProc: null,    // pre-spawned claude process waiting for stdin input
  _warmReady: false,  // true once the warm process has started successfully

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
    console.log('[multicc/aux] AuxQueue initialized (cold-spawn per task)');
  },

  // NOTE: process pre-warming was removed. It spawned `claude -p` with stdin held
  // open, intending to feed the prompt later — but the CLI aborts with
  //   "no stdin data received in 3s, proceeding without it" → exit 1
  // if stdin stays empty for 3s, which it always did (tasks arrive seconds after
  // prewarm). That silently killed EVERY aux task → no completion/waiting push
  // notifications. We now cold-spawn per task with the prompt as a CLI argument
  // (no stdin dependency, no race). Kept as a no-op so existing call sites are
  // safe; if low latency is ever needed, use `--input-format stream-json` (a
  // genuinely persistent process) rather than an idle one-shot `-p`.
  prespawn() { /* intentionally a no-op — see note above */ },

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
      });
      appendChatMessage(AUX_SESSION_ID, {
        role: 'assistant', content: resultText, ts: Date.now(),
        taskId: task.id, durationMs, cancelled: task.cancelled,
      });

      if (task.cancelled) {
        task.reject({ cancelled: true });
        this.broadcast({ type: 'aux_event', status: 'done', task: { id: task.id, type: task.type }, result: resultText, durationMs, cancelled: true });
      } else {
        task.resolve({ text: resultText, cancelled: false });
        this.broadcast({ type: 'aux_event', status: 'done', task: { id: task.id, type: task.type }, result: resultText, durationMs, cancelled: false });
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errMsg = err?.message || String(err);
      appendChatMessage(AUX_SESSION_ID, {
        role: 'user', content: task.prompt, ts: task.ts,
        taskType: task.type, taskId: task.id, meta: task.meta,
      });
      appendChatMessage(AUX_SESSION_ID, {
        role: 'assistant', content: `[ERROR] ${errMsg}`, ts: Date.now(),
        taskId: task.id, durationMs, error: true,
      });
      task.reject(err);
      this.broadcast({ type: 'aux_event', status: 'error', task: { id: task.id, type: task.type }, error: errMsg, durationMs });
      console.error(`[multicc/aux] Task ${task.id} failed:`, errMsg);
    }

    this.currentTask = null;
    this.processing = false;
    this.drain(); // process next
  },

  execute(task) {
    return new Promise((resolve, reject) => {
      // Cold-spawn per task: prompt passed as a CLI argument, stdin ignored
      // (/dev/null → immediate EOF). No prewarm, no stdin race. Single-turn,
      // stateless tasks (intent classify, voice refine) — Haiku on the OAuth
      // subscription is the cheap default (~30× cheaper than Opus), but the
      // provider+model are configurable (aux-config.json / settings UI).
      //
      // buildChildEnv strips every inherited ANTHROPIC_* routing key first, then
      // re-applies only the chosen provider's env — so a leaked global override
      // (e.g. ANTHROPIC_DEFAULT_HAIKU_MODEL=DeepSeek-V4-pro from a cc-switch)
      // can't silently redirect the `haiku` alias and break every aux task.
      const auxSession = { cli: 'claude', provider: auxConfig.providerId || null };
      const built = providers.buildChildEnv(process.env, auxSession, { TERM: 'dumb', NO_COLOR: '1' });
      // Model precedence: explicit aux config wins; else if the provider routes
      // elsewhere (custom base_url) let its own ANTHROPIC_MODEL decide (omit
      // --model); else fall back to haiku on the default login.
      const model = auxConfig.model || (built.skipDefaultModel ? null : 'haiku');
      const args = ['-p', '--output-format', 'stream-json', '--max-turns', '1', '--verbose'];
      if (model) args.splice(1, 0, '--model', model);
      args.push(task.prompt);
      const proc = spawn(CLAUDE_CMD, args, {
        cwd: __dirname,
        env: built.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let assistantText = '';
      let lineBuf = '';
      let stderrBuf = '';

      const timeout = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch (_) {}
        reject(new Error('timeout'));
      }, AUX_TIMEOUT_MS);

      proc.stdout.on('data', (chunk) => {
        lineBuf += chunk.toString();
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === 'assistant' && evt.message?.content) {
              for (const block of evt.message.content) {
                if (block.type === 'text') assistantText += block.text;
              }
            }
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              assistantText += evt.delta.text;
            }
          } catch (_) {}
        }
      });

      proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        // Immediately pre-spawn next warm process
        this.prespawn();

        // Process remaining buffer
        if (lineBuf.trim()) {
          try {
            const evt = JSON.parse(lineBuf);
            if (evt.type === 'assistant' && evt.message?.content) {
              for (const block of evt.message.content) {
                if (block.type === 'text') assistantText += block.text;
              }
            }
          } catch (_) {}
        }
        if (assistantText) {
          resolve(assistantText);
        } else if (code !== 0) {
          reject(new Error(`claude exited ${code}: ${stderrBuf.slice(0, 300)}`));
        } else {
          resolve('');
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.prespawn(); // try to recover warm pool
        reject(err);
      });
    });
  },

  broadcast(payload) {
    const json = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(json); } catch (_) {}
      }
    }
  },

  getStatus() {
    return {
      processing: this.processing,
      queueDepth: this.queue.length,
      currentTask: this.currentTask ? { id: this.currentTask.id, type: this.currentTask.type } : null,
      totalProcessed: this.totalProcessed,
      lastTaskTime: this.lastTaskTime,
      warmReady: this._warmReady,
    };
  },
};

// REST API for aux
app.get('/api/aux/status', (req, res) => {
  res.json(auxQueue.getStatus());
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

// Aux model config: which claude provider + model the aux helper uses.
// GET also returns the list of claude providers so the UI can render a picker.
app.get('/api/aux/config', (req, res) => {
  res.json({
    providerId: auxConfig.providerId,
    model: auxConfig.model,
    providers: providers.listProviders('claude').map(p => ({ id: p.id, name: p.name })),
  });
});
app.post('/api/aux/config', (req, res) => {
  const { providerId, model } = req.body || {};
  if (providerId && !providers.getProvider('claude', String(providerId))) {
    return res.status(400).json({ ok: false, error: '未知的 claude provider' });
  }
  auxConfig.providerId = providerId ? String(providerId) : null;
  auxConfig.model = (model && String(model).trim()) || null;
  saveAuxConfig();
  console.log(`[multicc/aux] config updated: provider=${auxConfig.providerId || 'default'} model=${auxConfig.model || 'haiku'}`);
  res.json({ ok: true, providerId: auxConfig.providerId, model: auxConfig.model });
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
const GOAL_ROUNDS_DEFAULT = 200;   // fallback round cap when a send omits it
const GOAL_BUDGET_DEFAULT = 0;     // fallback budget (0 = unlimited)
const GOAL_ROUNDS_MAX = 200;       // sanity ceiling for --max-turns
const GOAL_BUDGET_MAX = 5000000;   // sanity ceiling for the advisory token budget
const GOAL_CONFIG_FILE = path.join(__dirname, 'goal-config.json');

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
  try { fs.writeFileSync(GOAL_CONFIG_FILE, JSON.stringify(goalConfig, null, 2)); }
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
const PROVIDER_DEFAULTS_FILE = path.join(__dirname, 'provider-defaults.json');
let providerDefaults = { claude: null, codex: null };
try {
  const d = JSON.parse(fs.readFileSync(PROVIDER_DEFAULTS_FILE, 'utf8'));
  providerDefaults = { claude: d.claude || null, codex: d.codex || null };
} catch (_) { /* none yet */ }
function saveProviderDefaults() {
  try { fs.writeFileSync(PROVIDER_DEFAULTS_FILE, JSON.stringify(providerDefaults, null, 2)); }
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
  res.json({
    available: true,
    ccSwitchAvailable: providers.ccSwitchAvailable(),
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

// Import / sync providers from cc-switch into multicc's own store (idempotent).
app.post('/api/providers/import', (req, res) => {
  try {
    const r = providers.importFromCcSwitch();
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/providers', (req, res) => {
  try {
    const r = providers.createProvider({
      appType: (req.body.appType || '').trim(),
      name: req.body.name,
      baseUrl: (req.body.baseUrl || '').trim(),
      authToken: (req.body.authToken || '').trim(),
      model: (req.body.model || '').trim(),
      settingsConfig: req.body.settingsConfig,
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
      settingsConfig: req.body.settingsConfig,
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
const CHAT_HISTORY_DIR = path.join(__dirname, 'chat_history');
try { fs.mkdirSync(CHAT_HISTORY_DIR, { recursive: true }); } catch (_) {}
const MAX_CHAT_MESSAGES = 50;  // keep last N messages per session

// ── Per-session token usage accumulator ──
// chat_history has a rolling window (50 messages), so older usage data gets
// trimmed. This file stores the CUMULATIVE total per session and never shrinks.
const TOKEN_USAGE_FILE = path.join(__dirname, 'token_usage.json');
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
  try { fs.writeFileSync(TOKEN_USAGE_FILE, JSON.stringify(data, null, 2)); } catch (e) {
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
const TOKEN_DAILY_FILE = path.join(__dirname, 'token_daily.json');

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

  try { fs.writeFileSync(TOKEN_DAILY_FILE, JSON.stringify(daily, null, 2)); } catch (e) {
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
    try { fs.writeFileSync(TOKEN_USAGE_FILE, JSON.stringify(accum, null, 2)); } catch (_) {}
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
    fs.writeFileSync(chatHistoryPath(sessionName), JSON.stringify(history, null, 2));
  } catch (e) {
    console.error(`[multicc/chat] Failed to save history for ${sessionName}:`, e.message);
  }
}

// Messages dropped by the rolling-window trim accumulate here per session; once
// a batch builds up we distill them into memory before they're gone for good.
const _droppedForMemory = new Map();  // sessionName → [msg, …]
const MEMORY_DISTILL_BATCH = 10;

function appendChatMessage(sessionName, msg) {
  const history = loadChatHistory(sessionName);
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
  const limit = sessionName === AUX_SESSION_ID ? AUX_HISTORY_MAX : MAX_CHAT_MESSAGES;
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
}

// ── Chat sessions: session-level state for multi-client broadcast ──
// Keyed by sessionName, holds { claudeProc, lineBuf, clients, chatTurnCount,
//   chatClaudeSessionId, cwd, currentAssistantText, currentToolCalls, currentCost,
//   streamEvents }
const chatSessions = new Map();

function chatBroadcast(sessionName, payload) {
  const cs = chatSessions.get(sessionName);
  if (!cs) return;
  const json = JSON.stringify(payload);
  for (const client of cs.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(json); } catch (_) {}
    }
  }
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
// Hydrate from persisted summaries so the dashboard shows each session's last
// known "上下文特点" immediately after a restart (was lost when memory-only).
for (const [sid, p] of persistedSessions) {
  if (p && p.summary) sessionSummaries.set(sid, { summary: p.summary, ts: p.summaryTs || Date.now() });
}

// Parse an aux-AI intent_classify reply: line 1 = state letter (C/W),
// line 2 = optional short task summary. Tolerant of blank/extra lines.
function parseClassifyResult(text) {
  const lines = String(text || '').trim().split('\n').map(l => l.trim()).filter(Boolean);
  const first = (lines[0] || '').toUpperCase();
  // B = waiting on a background task/external data (no user action needed) — the
  // auto-continue (D) trigger. For notify purposes B still counts as 'waiting'
  // so a session with auto-continue OFF still surfaces to the user.
  const background = first.startsWith('B');
  const state = (first.startsWith('W') || background) ? 'waiting' : 'completed';
  let summary = lines.slice(1).join(' ').trim();
  // Strip a leading bullet/label the model sometimes adds, and cap length.
  summary = summary.replace(/^(第?2?行[:：]?|摘要[:：]?|总结[:：]?|[-*·]\s*)/, '').trim();
  if (summary.length > 40) summary = summary.slice(0, 40);
  return { state, summary, background };
}

// Store an aux-AI task summary for a session and push it to the workspace board.
function setSessionSummary(sessionId, summary) {
  if (!summary) return;
  const persisted = persistedSessions.get(sessionId);
  if (!persisted || persisted.type === 'aux' || persisted.type === 'gateway') return;
  const ts = Date.now();
  sessionSummaries.set(sessionId, { summary, ts });
  // Persist so the dir's per-session "上下文特点" survives a server restart
  // (the in-memory Map alone used to lose it). Throttled-ish: only write when
  // the text actually changed.
  if (persisted.summary !== summary) {
    persisted.summary = summary;
    savePersistedSessions();
  }
  workspaceBroadcast(persisted.dirId, { type: 'summary', sessionId, summary, ts });
}

const SESSION_MEMORY_MAX = 8000;  // hard cap on a session's persisted memory text

// Distill a chunk of about-to-be-discarded chat history into the session's
// long-lived memory. We deliberately keep ONLY key problems and how they were
// solved (decisions, fixes, gotchas, user preferences, unfinished threads) — not
// ordinary task narration. Runs on the aux AI, merges incrementally with the
// existing memory (de-dupes + compresses when near the cap), and is best-effort:
// any failure leaves history-clearing unaffected. Fire-and-forget (no await).
function distillHistoryIntoMemory(sessionId, messages) {
  const persisted = persistedSessions.get(sessionId);
  if (!persisted || persisted.type === 'aux' || persisted.type === 'gateway') return;
  const text = (messages || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content.trim().slice(0, 2000)}`)
    .join('\n');
  if (text.length < 40) return;  // nothing worth distilling
  const prior = (persisted.memory || '').trim();
  const prompt =
`你是会话记忆提炼器。下面是一段即将被清理/丢弃的对话。请只提炼出「值得长期记住的关键问题，以及解决该问题的方式/手段/结论」——例如：踩过的坑与正确做法、确认过的技术决策、用户明确表达的偏好/约束、尚未完成需后续跟进的事项。\n忽略普通的任务过程、寒暄、可重新获得的中间步骤。每条一行，动词或名词开头，精炼。若这段对话没有任何值得长期记住的，只输出一个减号 "-"。\n\n${prior ? `【已有的会话记忆（请与新内容合并去重，不要丢失旧的有效条目；若总量过长则压缩同类项）】\n${prior}\n\n` : ''}【待提炼的对话】\n${text.slice(0, 12000)}\n\n请直接输出合并后的会话记忆（多行要点），不要解释、不要加标题。`;
  auxQueue.enqueue({ type: 'memory_distill', prompt, meta: { sessionId } })
    .then(result => {
      let out = (result && result.text || '').trim();
      if (!out || out === '-' || out === '—') return;
      // Strip an accidental code fence / leading label the model may add.
      out = out.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
      if (out.length > SESSION_MEMORY_MAX) out = out.slice(0, SESSION_MEMORY_MAX);
      const p = persistedSessions.get(sessionId);
      if (!p) return;
      p.memory = out;
      savePersistedSessions();
      appendEvent(p.dirId, 'memory_updated', `已提炼会话记忆（${out.length} 字）`, sessionId);
      workspaceBroadcast(p.dirId, { type: 'memory', sessionId, memory: out });
      console.log(`[multicc/memory] distilled ${sessionId}: memory now ${out.length} chars`);
    })
    .catch(e => console.warn(`[multicc/memory] distill ${sessionId} failed: ${e.message}`));
}

function workspaceBroadcast(dirId, payload) {
  const set = workspaceClients.get(dirId);
  if (!set) return;
  const json = JSON.stringify(payload);
  for (const wsc of set) {
    if (wsc.readyState === WebSocket.OPEN) { try { wsc.send(json); } catch (_) {} }
  }
}

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
  const next = {
    status: nextStatus,
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
    out.push({
      id: s.id, label: s.label || null, cli: s.cli || 'claude', kind: s.kind || 'terminal',
      branch: s.branch || null, invalid: invalidSessions.get(s.id) || null,
      status: st.status, currentFile: st.currentFile, lastActivity: st.lastActivity,
      runStartedAt: st.runStartedAt || null, runEndedAt: st.runEndedAt || null,
      clients: s.kind === 'chat' ? (chat?.clients.size || 0) : (active?.clients.size || 0),
      pendingNotes: pendingNotesFor(s.id).length,
      mergeState: mergeStateCached(directories.get(s.dirId), s),
      summary: sum?.summary || null, summaryTs: sum?.ts || null,
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

// ── Event log + passive inter-agent notes ──
// Each directory has an append-only event log (events/<dirId>.jsonl) and a shared
// pool of notes. A note left for another agent is delivered passively — prepended
// to that agent's next chat turn.
const EVENTS_DIR = path.join(__dirname, 'events');
try { fs.mkdirSync(EVENTS_DIR, { recursive: true }); } catch (_) {}
const NOTES_FILE = path.join(__dirname, 'notes.json');
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
  try { fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2)); }
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
  try { fs.appendFileSync(path.join(EVENTS_DIR, `${dirId}.jsonl`), JSON.stringify(evt) + '\n'); }
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

// ── Chat intent classification: 30s delayed trigger ──
const CLASSIFY_DELAY_MS = 30000;
const PROGRESS_SUMMARY_INTERVAL_MS = 45000; // during-stream progress summary cadence

function cancelPendingClassify(cs) {
  if (cs.pendingClassifyTimer) {
    clearTimeout(cs.pendingClassifyTimer);
    cs.pendingClassifyTimer = null;
  }
  if (cs.pendingClassifyTaskId) {
    auxQueue.cancel(cs.pendingClassifyTaskId);
    cs.pendingClassifyTaskId = null;
  }
}

function scheduleIntentClassify(cs, sessionName) {
  cancelPendingClassify(cs); // clear any previous pending
  cancelProgressSummary(cs); // task is done — stop the in-progress summary cycle

  const text = cs.currentAssistantText;
  if (!text || text.length < 20) return;

  const tail = text.slice(-1500);
  const sessionId = persistedSessions.get(sessionName)?.id || sessionName;

  cs.pendingClassifyTimer = setTimeout(() => {
    cs.pendingClassifyTimer = null;
    const taskId = crypto.randomUUID();
    cs.pendingClassifyTaskId = taskId;

    // Gather recent user messages to help the AI understand the overall task
    const recentUserMsgs = getRecentUserMessages(sessionName, 3);
    const userContext = recentUserMsgs.length > 0
      ? `\n最近几轮用户消息（用于理解整体任务）：\n${recentUserMsgs.map((m, i) => `${i + 1}. ${briefTaskDescription(m)}`).join('\n')}`
      : '';

    auxQueue.enqueue({
      id: taskId,
      type: 'intent_classify',
      prompt: `你是一个意图分析器。判断以下 AI 助手回复的结尾状态。请严格输出两行：
第1行：仅一个字母——
  C = 任务已完成，不需要任何后续动作
  W = 正在等待用户回复、确认或决策（需要用户操作）
  B = 正在等待某个后台任务/外部数据/第三方返回后才能继续，且无需用户操作（例如”等部署完成””等接口返回””稍后再查”）
第2行：用不超过 20 个汉字概括整体任务是什么（基于最近用户请求和AI回复综合判断，如”memo图片更换””登录页样式修复””数据库迁移脚本”）。这一行必须给出，不得为空、不要只回字母、不要写”无”或”无法概括”。如果多轮对话围绕同一个任务，请保持任务名一致。${userContext}

回复内容：
${tail}`,
      meta: { sessionName, sessionId },
    }).then(result => {
      cs.pendingClassifyTaskId = null;
      if (result.cancelled) return;
      const { state, summary, background } = parseClassifyResult(result.text);
      // D (auto-continue): the turn only paused for a background task/external
      // data and the session opted in → keep it moving silently (no user notify),
      // unless an explicit A/B wait already covers this session.
      const persistedRec = persistedSessions.get(sessionName);
      if (background && persistedRec?.autoContinue && !waitInjector.hasWait(sessionName)) {
        setSessionSummary(sessionId, summary);
        console.log(`[multicc/aux] Intent classify for ${sessionName}: background → auto-continue`);
        waitInjector.autoContinue(sessionName, { cwd: cs.cwd });
        return;
      }
      waitInjector.resetAuto(sessionName); // done / waiting-on-user → reset D's counter
      const doneMsg = summary ? `任务完成：${summary}` : '任务完成';
      const msg = state === 'waiting' ? '等待交互' : doneMsg;
      // This aux-AI verdict is the single source of truth for "is the turn done
      // or waiting?". Fan it out to every channel from here so nothing re-judges:
      //   1. web push / Bark / webhook (PWA + external)
      triggerPush(sessionId, state, `[Chat] ${msg}`);
      //   2. the session's live chat clients (native app / web) — they raise
      //      their local notification from THIS verdict instead of guessing on
      //      `result`, so app and server never disagree or double-fire.
      chatBroadcast(sessionName, { type: 'notify', state, message: msg });
      //   3. the directory's workspace board — lets the dashboard notify even
      //      for sessions the user never opened (which have no chat socket).
      //      The app de-dups this against the chat notify above by session id.
      const dirId = persistedSessions.get(sessionName)?.dirId;
      if (dirId) {
        workspaceBroadcast(dirId, { type: 'notify', sessionId, state, message: msg });
      }
      setSessionSummary(sessionId, summary);
      // Reflect on the status board — but only if no new turn has started since.
      // state is 'waiting' | 'completed'; keep 'completed' so the card rests at
      // 「已完成」 rather than reverting to 「空闲」.
      if (!cs.isStreaming) {
        setSessionStatus(sessionName, { status });
      }
      console.log(`[multicc/aux] Intent classify for ${sessionName}: ${state}${summary ? ` · ${summary}` : ''}`);
    }).catch(() => {
      cs.pendingClassifyTaskId = null;
    });
  }, CLASSIFY_DELAY_MS);
}

// ── Task start + in-progress summary ─────────────────────────────────────
// The intent_classify path only fires AFTER a turn completes. Users also want
// to know "what task is running" and "what's the current status" WHILE the
// agent is still working. This does exactly that:
//   • Task start: immediately stamp the stable task name derived from the user
//     message so the dashboard / chat shows "处理中：memo图片更换" the instant
//     the turn begins — no AI call, zero latency.
//   • In-progress: every PROGRESS_SUMMARY_INTERVAL_MS while still streaming,
//     ask the aux AI to summarize the assistant's current sub-action into ≤15
//     chars, then combine with the stable task name as "处理中：xxx — 子动作"
//     and fan it out via setSessionSummary + a `running` notify event
//     so both the workspace board and chat clients can display it.

function briefTaskDescription(text) {
  let brief = (text || '').trim().replace(/\s+/g, ' ');
  // Strip common goal-mode wrapper if present
  brief = brief.replace(/^【[^】]*】\s*/, '');
  if (brief.length > 40) brief = brief.slice(0, 40) + '…';
  return brief || '新任务';
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
    const taskName = cs?.currentTaskName || '';
    if (taskName) {
      message = `任务完成：${taskName}`;
    } else {
      const sm = sessionSummaries.get(sessionId);
      const raw = sm?.summary || '';
      // Strip any status label prefix plus optional " — subAction" suffix
      const clean = raw.replace(/^(正在处理：|处理中：|任务完成：)/, '').replace(/\s*—\s*.+$/, '').trim();
      if (clean) message = `任务完成：${clean}`;
    }
  }

  setSessionStatus(sessionName, { status, currentFile: null });
  setSessionSummary(sessionId, message);
  if (alert) {
    triggerPush(sessionId, notifyState, `[Chat] ${message}`);
    chatBroadcast(sessionName, { type: 'notify', state: notifyState, message });
    if (persisted.dirId) {
      workspaceBroadcast(persisted.dirId, { type: 'notify', sessionId, state: notifyState, message });
    }
  }
}

function startProgressSummary(cs, sessionName) {
  cancelProgressSummary(cs);
  cs.progressSummaryTimer = setTimeout(() => {
    cs.progressSummaryTimer = null;
    if (!cs.isStreaming) return;

    const text = cs.currentAssistantText;
    // Not enough output yet — wait another cycle.
    if (!text || text.length < 50) {
      cs.progressSummaryTimer = setTimeout(() => startProgressSummary(cs, sessionName), PROGRESS_SUMMARY_INTERVAL_MS);
      return;
    }

    const tail = text.slice(-1500);
    const taskName = cs.currentTaskName || '未知任务';
    auxQueue.enqueue({
      type: 'progress_summary',
      prompt: `当前整体任务：「${taskName}」

用不超过15个汉字概括AI助手当前正在执行的具体操作步骤（动词开头，如"修改CSS样式"、"运行单元测试"、"编写API接口"、"排查报错原因"）。只描述当前步骤，不要重复整体任务名。只输出概括内容，不要解释、不要前缀。

回复内容：
${tail}`,
      meta: { sessionName },
    }).then(result => {
      if (result.cancelled) return;
      if (!cs.isStreaming) return; // turn finished while we were asking
      const subAction = (result.text || '').trim().replace(/^["'"']|["'"']$/g, '').slice(0, 30);
      if (subAction && subAction !== '-' && subAction !== '—') {
        const taskName = cs.currentTaskName || '新任务';
        const label = `处理中：${taskName} — ${subAction}`;
        emitRunningNotify(sessionName, label);
        console.log(`[multicc/aux] Progress summary for ${sessionName}: ${label}`);
      }
      // Reschedule for the next cycle
      if (cs.isStreaming) {
        cs.progressSummaryTimer = setTimeout(() => startProgressSummary(cs, sessionName), PROGRESS_SUMMARY_INTERVAL_MS);
      }
    }).catch(() => {
      // Reschedule even on failure
      if (cs.isStreaming) {
        cs.progressSummaryTimer = setTimeout(() => startProgressSummary(cs, sessionName), PROGRESS_SUMMARY_INTERVAL_MS);
      }
    });
  }, PROGRESS_SUMMARY_INTERVAL_MS);
}

function cancelProgressSummary(cs) {
  if (cs.progressSummaryTimer) {
    clearTimeout(cs.progressSummaryTimer);
    cs.progressSummaryTimer = null;
  }
}

// Run one chat turn end-to-end: build prompt → spawn the CLI → stream events to
// clients → persist the assistant message. Extracted from the WS handler so the
// dispatch path can drive a session with no connected client. opts.isFirstTurn
// forces first-turn spawn semantics; opts.originDispatchId, when set, pushes the
// final assistant text back to WeChat once the turn completes (auto-回流).
// Resolve the effective custom role prompt for a session: an explicit
// session-level role wins; otherwise inherit the owning directory's default.
// Returns null when neither is set (sessions keep the bare image hint only).
function resolveRolePrompt(persisted) {
  if (!persisted) return null;
  // Base persona: explicit session role wins, else the directory default.
  let base = persisted.rolePrompt;
  if (!base) {
    const dir = persisted.dirId ? directories.get(persisted.dirId) : null;
    base = (dir && dir.rolePrompt) || null;
  }
  // Session memory (distilled from cleared/trimmed history — key problems and how
  // they were solved). Lives alongside, not inside, the role prompt; appended so
  // every turn carries it without the user re-explaining past decisions.
  const mem = (persisted.memory || '').trim();
  if (!mem) return base;
  const memBlock = `[会话记忆：以下是本会话过往积累的关键问题与解决方式，供你延续上下文，不要重复已解决的事]\n${mem}\n[会话记忆结束]`;
  return base ? `${base}\n\n${memBlock}` : memBlock;
}

// Signature of a transport/API failure that ends a turn with a truncated answer
// instead of a real completion (e.g. the CLI's "API Error: Connection closed
// mid-response. The response above may be incomplete."). Anchored to the tail
// because a genuine mid-response cutoff puts the error as the very last thing —
// this avoids matching a turn that merely *quotes* such a string mid-answer.
const API_ERROR_RE = /API Error:[^\n]{0,200}(Connection closed|mid-response|response above may be incomplete|terminated|Overloaded|Internal server error|Request was aborted|ECONNRESET|socket hang up)/i;

// Turn-boundary hook for guard F (see wait-injector). If the just-finished turn
// died on an API/transport error, schedule a capped "继续" retry; otherwise the
// turn completed cleanly, so reset the consecutive-error counter. Called from
// BOTH end-of-turn paths (per-turn proc close + streaming finalize). The
// `sawApiError` flag captures result-event errors that never reach the text.
function handleApiErrorBoundary(sessionName, finalText, sawApiError) {
  const hit = sawApiError || API_ERROR_RE.test((finalText || '').slice(-300));
  if (!hit) { waitInjector.resetApi(sessionName); return; }
  if (waitInjector.hasWait(sessionName)) return; // an explicit wait already covers it
  console.log(`[multicc/chat] [${sessionName}] turn ended on API/transport error → scheduling retry nudge`);
  waitInjector.apiRetry(sessionName);
}

// Apply one claude-shaped stream-json event to chat session state, then forward
// it to clients. Shared by the per-turn spawn path (handleLine) and the
// persistent streaming path (runChatTurnStreaming) so the two never drift.
// The `result` event is the turn boundary: it saves the assistant message,
// returns the session to idle, and fires post-turn hooks.
function applyClaudeChatEvent(cs, sessionName, evt, forward) {
  if (evt.type === 'assistant' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'text') {
        cs.currentAssistantText += block.text;
        setSessionStatus(sessionName, { status: 'thinking', currentFile: null });
      }
      if (block.type === 'tool_use') {
        cs.currentToolCalls.push({ name: block.name, input: block.input, id: block.id });
        const editTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
        if (editTools.includes(block.name)) {
          setSessionStatus(sessionName, { status: 'editing', currentFile: block.input?.file_path || null });
        } else if (block.name === 'Bash') {
          setSessionStatus(sessionName, { status: 'running', currentFile: null });
          // Anti-pattern guard (E): a chat-mode Bash launched with
          // run_in_background:true will be reaped when the turn/context resets,
          // so any "I'll wait for it" silently dies. Flag the turn; the result
          // boundary below schedules a corrective nudge.
          if (block.input && block.input.run_in_background === true) {
            cs._sawBgRun = true;
          }
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
    // Flag transport/API failures so the turn-boundary hook (guard F) can resume:
    // claude reports them as is_error + a non-"success" subtype on the result event.
    if (evt.is_error === true || (evt.subtype && evt.subtype !== 'success' && /error|abort|timeout/i.test(evt.subtype))) {
      cs._sawApiError = true;
    }
    if (cs.currentAssistantText || cs.currentToolCalls.length) {
      const usage = evt.usage || {};
      appendChatMessage(sessionName, {
        role: 'assistant', content: cs.currentAssistantText,
        tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
        cost: cs.currentCost, usage: Object.keys(usage).length ? usage : undefined, ts: Date.now(),
      });
      accumulateTokenUsage(sessionName, usage);
      broadcastProviderTokenStats(sessionName);
      cs.chatTurnCount++;
      cs._resultSaved = true;
    }
    // Include durationMs + num_turns in the result broadcast so clients
    // (web + app) can display per-message task timing without client-side
    // clock guesswork. durationMs is the wall-clock time from turnStartedAt
    // (user submit) to this result — "模型接到消息到输出完成的耗时".
    const _resultDurationMs = cs.turnStartedAt ? Date.now() - cs.turnStartedAt : undefined;
    forward({ type: 'result', total_cost_usd: evt.total_cost_usd, usage, durationMs: _resultDurationMs, num_turns: cs.chatTurnCount });
    // A clean result rests at 'completed' (turn finished); an errored result
    // (flagged just above) falls back to 'idle'. The close/finalize handler has
    // the final say and corrects this if the process then dies abnormally.
    setSessionStatus(sessionName, { status: cs._sawApiError ? 'idle' : 'completed', currentFile: null });
    scheduleIntentClassify(cs, sessionName);
    // Anti-pattern guard (E): if this turn launched a run_in_background Bash and
    // didn't register an explicit wait, the background process won't survive the
    // context reset. Nudge the session onto the supported path (run-detached /
    // immediate BashOutput). Guarded + capped inside the injector; reset by a
    // real user message. Chat-only: this code path is the chat event applier.
    if (cs._sawBgRun) {
      cs._sawBgRun = false;
      const persistedRec = persistedSessions.get(sessionName);
      if (!waitInjector.hasWait(sessionName)) {
        console.log(`[multicc/chat] [${sessionName}] used run_in_background → scheduling bgCheck nudge`);
        waitInjector.bgCheck(sessionName, { cwd: cs.cwd });
      }
    }
    // Decoupled via the bus so chat doesn't depend on the triggers domain.
    bus.emit('chat:turn-complete', sessionName, cs);
  }
  // Drop claude's `system init` — server already sent its own
  if (evt.type === 'system' && evt.subtype === 'init') return;
  forward(evt);
}

function runChatTurn(sessionName, text, opts = {}) {
  const { isFirstTurn: forceFirstTurn, originDispatchId, originTrigger, originContinue, goalLimits } = opts;
  const persisted = persistedSessions.get(sessionName);
  if (!persisted) {
    console.warn(`[multicc/chat] runChatTurn: no persisted record for ${sessionName}`);
    return false;
  }
  // A real (non-auto-continue) message means the user/trigger is driving again →
  // reset the D auto-continue guard so a future background-wait gets fresh budget.
  if (!originContinue) { waitInjector.resetAuto(sessionName); waitInjector.resetBg(sessionName); waitInjector.resetApi(sessionName); }
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
      pendingClassifyTimer: null,
      pendingClassifyTaskId: null,
      progressSummaryTimer: null,
    };
    chatSessions.set(sessionName, cs);
  }

  cancelPendingClassify(cs);
  cancelProgressSummary(cs);
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
  } else if (persisted.streaming && (persisted.cli || 'claude') === 'claude' && chatStream.status(sessionName)?.busy) {
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

  // Save user message to history
  appendChatMessage(sessionName, {
    role: 'user', content: text, ts: Date.now(),
  });

  // Reset accumulators
  cs.currentAssistantText = '';
  cs.currentUserText = text;          // store user message for summary context
  cs.currentTaskName = briefTaskDescription(text); // stable task name across turn
  cs.currentToolCalls = [];
  cs.currentCost = null;
  cs.isStreaming = true;
  cs.turnStartedAt = Date.now();  // for per-reply interaction latency (durationMs)
  cs.streamReplay = [];
  cs._resultSaved = false;

  // Task start: immediately stamp a brief description so the dashboard / chat
  // shows "what's running" the instant the turn begins — no AI call, zero
  // latency. The in-progress aux-AI summary will refine it ~45s later.
  cancelProgressSummary(cs);
  emitRunningNotify(sessionName, `处理中：${cs.currentTaskName}`);
  startProgressSummary(cs, sessionName);
  // Marks this turn as initiated by an auto-trigger, so post-turn triggers
  // don't recurse on their own output (see firePostTurnTriggers).
  cs._originTrigger = !!originTrigger;
  cs.originDispatchId = originDispatchId || null;
  setSessionStatus(sessionName, { status: 'thinking', currentFile: null });

  const provider = cliProviders[cs.cli] || cliProviders.claude;
  // For claude: first turn → --session-id <uuid>, subsequent → --resume <uuid>.
  // For codex:  first turn → exec --json, subsequent → exec resume <id> --json.
  const isFirstTurn = (typeof forceFirstTurn === 'boolean') ? forceFirstTurn : (cs.chatTurnCount === 0 || !persisted.cliSessionId);

  // Passive inter-agent notes: prepend any pending notes addressed to this
  // session onto the prompt, then mark them delivered.
  let promptText = text;
  const pendingNotes = pendingNotesFor(sessionName).slice(0, 10);
  if (pendingNotes.length) {
    let block = '[multicc 跨 agent 留言 — 来自同目录下的其他 agent]\n';
    for (const n of pendingNotes) block += `- 来自「${n.fromLabel}」：${n.body}\n`;
    block += '[留言结束]\n\n';
    if (block.length > 4000) block = block.slice(0, 4000) + '\n…(截断)\n\n';
    promptText = block + text;
    const now = Date.now();
    for (const n of pendingNotes) { n.delivered = true; n.deliveredAt = now; }
    saveNotes();
    appendEvent(persisted.dirId, 'note_delivered', `${pendingNotes.length} 条留言已送达`, sessionName);
    workspaceBroadcast(persisted.dirId, {
      type: 'note_pending', sessionId: sessionName, count: pendingNotesFor(sessionName).length,
    });
    chatBroadcast(sessionName, {
      type: 'system', subtype: 'agent_notes',
      notes: pendingNotes.map(n => ({ from: n.fromLabel, body: n.body })),
    });
  }
  if (persisted.type === 'gateway') {
    promptText = buildGatewayPrompt(promptText);
  }

  // Goal mode: prepend the configured limit constraints (round/budget) so the
  // autonomous agent is bounded. maxTurns additionally becomes a hard CLI cap.
  const goalMaxTurns = goalLimits ? (goalLimits.maxRounds || 0) : 0;
  if (goalLimits) {
    const note = buildGoalLimitNote(goalLimits);
    if (note) promptText = note + promptText;
  }

  const rolePrompt = resolveRolePrompt(persisted);

  // ── Streaming path (flag-gated, claude only) ──
  // Persistent process kept warm across turns so a turn that ends in a
  // "waiting for external data" state leaves a live, in-context process ready
  // to continue (fed by the next message / the waiting-injector) instead of a
  // dead one needing a cold --resume. Default sessions use the per-turn spawn
  // path below, unchanged.
  if (persisted.streaming && cs.cli === 'claude') {
    return runChatTurnStreaming(sessionName, cs, persisted, promptText, rolePrompt);
  }

  // Per-session provider (cc-switch): env injected into THIS child only, so
  // sibling sessions routing to other providers stay fully independent.
  const provEnv = providers.resolveSpawnEnv(persisted);
  const args = provider.buildChatSpawnArgs(persisted, promptText, { isFirstTurn, rolePrompt, maxTurns: goalMaxTurns, skipDefaultModel: provEnv.skipDefaultModel });
  console.log(`[multicc/chat] Spawning ${cs.cli} (turn ${cs.chatTurnCount}, first=${isFirstTurn}${provEnv.providerName ? `, provider=${provEnv.providerName}` : ''}): ${provider.cmd} ${args.join(' ').slice(0, 200)}...`);

  // Sanitize empty thinking blocks from the Claude CLI JSONL session file.
  // Third-party providers (GLM, DeepSeek, etc.) may return thinking blocks
  // with only whitespace content. When switching back to Claude official API,
  // the API rejects these with HTTP 400 "each thinking block must contain
  // non-whitespace thinking". Clean them proactively before each spawn.
  const sanitizeCliSessionJSONL = () => {
    if (!cs.cliSessionId || !cs.cwd) return;
    try {
      const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
      if (!fs.existsSync(claudeProjects)) return;
      // Walk all project subdirectories looking for the session JSONL.
      let cleaned = 0;
      const dirs = fs.readdirSync(claudeProjects, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const jl = path.join(claudeProjects, d.name, `${cs.cliSessionId}.jsonl`);
        if (!fs.existsSync(jl)) continue;
        let content = fs.readFileSync(jl, 'utf8');
        const lines = content.split('\n');
        const out = [];
        for (const line of lines) {
          if (!line.trim()) { out.push(line); continue; }
          try {
            const j = JSON.parse(line);
            if (j.message && Array.isArray(j.message.content)) {
              const before = j.message.content.length;
              j.message.content = j.message.content.filter(b => {
                if (b.type === 'thinking' && (!b.thinking || !/\S/.test(b.thinking))) {
                  cleaned++; return false;
                }
                return true;
              });
            }
            out.push(JSON.stringify(j));
          } catch (_) { out.push(line); }
        }
        if (cleaned > 0) {
          fs.writeFileSync(jl, out.join('\n'));
          // Also clean multicc's own chat_history cache so it stays fresh.
          chatHistories.delete(sessionName);
          console.log(`[multicc/chat] [${sessionName}] sanitized ${cleaned} empty thinking block(s) from session JSONL`);
        }
        break; // Found the session, stop searching
      }
    } catch (_) {}
  };

  const spawnChat = (spawnArgs, isRetry) => {
    sanitizeCliSessionJSONL();  // Clean before every claude exec resume
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
    const proc = spawn(provider.cmd, spawnArgs, {
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

      if (cs.cli === 'codex') {
        // ── Codex → claude-shaped events ──
        if (evt.type === 'thread.started') {
          if (evt.thread_id && !persisted.cliSessionId) {
            persisted.cliSessionId = evt.thread_id;
            savePersistedSessions();
            console.log(`[multicc/chat] [${sessionName}] captured codex thread_id=${evt.thread_id}`);
          }
          return;  // don't forward
        }
        if (evt.type === 'turn.started') return;  // noise, drop
        if (evt.type === 'item.started') {
          const it = evt.item || {};
          if (it.type === 'command_execution') {
            // Emit an assistant event with a tool_use block so a tool card appears
            const mapped = {
              type: 'assistant',
              message: { content: [{ type: 'tool_use', name: 'Bash', id: it.id, input: { command: it.command } }] },
            };
            forward(mapped);
            cs.currentToolCalls.push({ name: 'Bash', input: { command: it.command }, id: it.id });
            setSessionStatus(sessionName, { status: 'running', currentFile: null });
          }
          return;
        }
        if (evt.type === 'item.completed') {
          const it = evt.item || {};
          if (it.type === 'command_execution') {
            // Emit a tool_result event to fill in the existing tool card
            const resultText = it.aggregated_output || '';
            const mapped = {
              type: 'user',
              message: { content: [{ type: 'tool_result', tool_use_id: it.id, content: resultText, is_error: (it.exit_code && it.exit_code !== 0) || false }] },
            };
            forward(mapped);
            const tc = cs.currentToolCalls.find(t => t.id === it.id);
            if (tc) {
              tc.result = resultText.length > 1000 ? resultText.slice(0, 1000) + '...' : resultText;
              tc.is_error = (it.exit_code && it.exit_code !== 0) || false;
            }
            return;
          }
          if (it.type === 'agent_message') {
            const text = it.text || '';
            cs.currentAssistantText += (cs.currentAssistantText ? '\n\n' : '') + text;
            forward({ type: 'assistant', message: { content: [{ type: 'text', text: text + '\n\n' }] } });
            setSessionStatus(sessionName, { status: 'thinking', currentFile: null });
            return;
          }
          if (it.type === 'reasoning') {
            // Emit as a collapsible thinking-style tool card so users can see but it
            // doesn't pollute the main assistant text stream.
            forward({
              type: 'assistant',
              message: { content: [{ type: 'tool_use', name: 'Thinking', id: it.id, input: { text: it.text || '' } }] },
            });
            cs.currentToolCalls.push({ name: 'Thinking', input: { text: it.text || '' }, id: it.id, result: it.text || '' });
            return;
          }
          return;
        }
        if (evt.type === 'turn.completed') {
          cs.currentCost = null;  // codex doesn't report dollar cost
          const usage = evt.usage || {};
          if (cs.currentAssistantText || cs.currentToolCalls.length) {
            appendChatMessage(sessionName, {
              role: 'assistant', content: cs.currentAssistantText,
              tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
              cost: null, usage, ts: Date.now(),
            });
            accumulateTokenUsage(sessionName, usage);
            broadcastProviderTokenStats(sessionName);
            cs.chatTurnCount++;
            cs._resultSaved = true;
          }
          forward({ type: 'result', total_cost_usd: null, usage, durationMs: cs.turnStartedAt ? Date.now() - cs.turnStartedAt : undefined, num_turns: cs.chatTurnCount });
          // turn.completed only fires on a clean codex turn (errors emit
          // 'error'/'turn.failed'), so this rests at 'completed'.
          setSessionStatus(sessionName, { status: 'completed', currentFile: null });
          scheduleIntentClassify(cs, sessionName);
          return;
        }
        // ── Codex error / turn failure ──
        // codex emits {type:'error'} / {type:'turn.failed'} when the provider
        // rejects the request (bad/expired token, wrong base_url, etc). Without
        // handling them the message is dropped: the turn yields no text, the
        // close handler wastes a retry on the same broken provider, and the user
        // only ever sees a garbled stderr tail. Surface codex's own clean error
        // and flag the turn so the pointless retry is skipped.
        if (evt.type === 'error' || evt.type === 'turn.failed') {
          const emsg = (evt.message || (evt.error && evt.error.message) || '未知错误').toString();
          cs._codexError = emsg;
          forward({ type: 'error', error: `Codex 出错：${emsg}` });
          return;
        }
        return;  // unknown event type: drop
      }

      // ── Claude: shared with the streaming path ──
      applyClaudeChatEvent(cs, sessionName, evt, forward);
    };

    const forward = (evt) => {
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
      const durMs = Date.now() - spawnTs;
      const killReason = cs._killReason || null;
      cs._killReason = null;
      const diag = {
        session: sessionName, cli: cs.cli, pid: proc.pid, code, signal, durMs, killReason,
        resultSaved: !!cs._resultSaved,
        gotText: (cs.currentAssistantText || '').length,
        toolCalls: cs.currentToolCalls.length,
        liveClients: cs.clients.size,
        isRetry: !!isRetry,
        stderrTail: stderrBuf.slice(-300).trim(),
      };
      let kind = 'normal';
      if (signal) kind = killReason ? `killed(${killReason})` : `signaled(${signal})`;
      else if (code !== 0) kind = 'nonzero_exit';
      else if (!cs._resultSaved && !cs.currentAssistantText) kind = 'empty_exit';
      console.log(`[multicc/chat] [${sessionName}] close kind=${kind} ${JSON.stringify(diag)}`);

      if (cs.lineBuf.trim()) {
        try { handleLine(cs.lineBuf); } catch (_) {}
      }
      cs.lineBuf = '';
      cs.isStreaming = false;
      cs.streamReplay = [];

      // If spawn yielded no assistant text and it's not a user-initiated kill, retry
      // once with a fresh session id (covers resume-failed / session-id conflict cases).
      // A reported codex error (cs._codexError) is a real provider failure, not a
      // resume glitch — retrying would just hit the same wall, so skip it.
      if (!isRetry && !cs.currentAssistantText && !killReason && !cs._codexError) {
        const stderrTail = stderrBuf.slice(-300).trim();
        const reason = stderrTail.includes('already in use') ? 'session-id conflict'
          : stderrTail.includes('No conversation found') || stderrTail.includes('session not found') ? 'resume target missing'
          : `exit ${code}${signal ? '/' + signal : ''}`;
        console.warn(`[multicc/chat] [${sessionName}] ${cs.cli} yielded no output (${reason}), retrying fresh. stderr: ${stderrTail.slice(0, 200)}`);
        // Reset session id so the retry starts a brand-new conversation
        if (cs.cli === 'claude') persisted.cliSessionId = crypto.randomUUID();
        else persisted.cliSessionId = null;  // codex will allocate on first turn
        savePersistedSessions();
        cs.chatTurnCount = 0;
        cs.isStreaming = true;
        cs.streamReplay = [];
        const fallbackArgs = provider.buildChatSpawnArgs(persisted, promptText, { isFirstTurn: true, rolePrompt });
        chatBroadcast(sessionName, {
          type: 'system', subtype: 'warning',
          message: `${cs.cli} 启动失败（${reason}），已用新会话重试`,
        });
        cs.claudeProc = spawnChat(fallbackArgs, true);
        return;
      }

      if (isRetry && !cs.currentAssistantText) {
        const stderrTail = stderrBuf.slice(-300).trim();
        chatBroadcast(sessionName, {
          type: 'error',
          error: stderrTail ? `${cs.cli} 无响应：${stderrTail}` : `${cs.cli} 无响应（exit ${code}${signal ? '/' + signal : ''}）`,
        });
      }

      cs.claudeProc = null;

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
      cs._resultSaved = false;
      const hadCodexError = !!cs._codexError; cs._codexError = null;
      // Guard F: resume (capped) if this turn died on an API/transport error,
      // else reset the consecutive-error counter. Skip user-initiated kills.
      const sawApi = cs._sawApiError; cs._sawApiError = false;
      if (!killReason) handleApiErrorBoundary(sessionName, finalText, sawApi);

      // Resting status (status board + notify fan-out):
      //   • user-initiated stop  → idle (no alert)
      //   • API error / non-zero / signaled exit / codex provider error → error
      //     ('出现异常', alerts; cancel the pending classify so its later verdict
      //      can't overwrite the error state)
      //   • clean exit with output (kind 'normal') → completed ('任务完成')
      //   • empty / unclassified exit → idle
      if (killReason) {
        setSessionStatus(sessionName, { status: 'idle', currentFile: null });
      } else if (sawApi || hadCodexError || kind === 'nonzero_exit' || kind === 'signaled') {
        cancelPendingClassify(cs);
        emitTurnOutcome(sessionName, { status: 'error', notifyState: 'error', message: '出现异常', alert: true });
      } else if (kind === 'normal') {
        emitTurnOutcome(sessionName, { status: 'completed', notifyState: 'completed', message: '任务完成', alert: false });
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
  inject: (session, text) => runChatTurn(session, text, { originContinue: true }),
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
    // 10s interval × 360 checks ≈ 1h ceiling before the poll gives up; tune via body.
    const intervalSec = Math.max(3, Number(b.intervalSec) || 10);
    const maxChecks = Math.max(1, Number(b.maxChecks) || 360);
    const label = (b.label || command.replace(/\s+/g, ' ').slice(0, 60)).trim();
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
function runChatTurnStreaming(sessionName, cs, persisted, promptText, rolePrompt) {
  const sysPrompt = rolePrompt ? `${MULTICC_IMG_HINT}\n\n${rolePrompt}` : MULTICC_IMG_HINT;
  // Per-session provider env. buildChildEnv strips inherited ANTHROPIC_* routing
  // vars before applying the provider env, so the provider choice is always
  // authoritative — see providers.CLAUDE_ROUTING_KEYS. The full computed env is
  // passed through; chat-stream uses it verbatim (no second process.env merge).
  const { env: childEnv, skipDefaultModel } = providers.buildChildEnv(process.env, persisted, {
    TERM: 'dumb', NO_COLOR: '1',
    MULTICC_SESSION_ID: sessionName,
    MULTICC_DIR_ID: persisted.dirId || '',
    MULTICC_BASE_URL: `http://127.0.0.1:${PORT}`,
  });
  const model = persisted.model || (skipDefaultModel ? null : claudeDefaultModel());
  const extraArgs = CLAUDE_CHAT_DISALLOWED_TOOLS.length
    ? ['--disallowedTools', CLAUDE_CHAT_DISALLOWED_TOOLS.join(',')] : [];

  chatStream.ensure(sessionName, {
    cmd: cliProviders.claude.cmd,
    cwd: cs.cwd,
    sessionId: persisted.cliSessionId,
    model, sysPrompt, extraArgs,
    env: childEnv,
  });

  // An in-flight turn (if any) was already interrupted at the top of
  // runChatTurn. Claim this turn's sequence number so a late finalize from a
  // superseded turn can't clobber us.
  const mySeq = cs._streamTurnSeq = (cs._streamTurnSeq || 0) + 1;

  const forward = (evt) => {
    cs.streamReplay.push(evt);
    if (cs.streamReplay.length > 500) cs.streamReplay.shift();
    chatBroadcast(sessionName, evt);
  };

  console.log(`[multicc/chat] [${sessionName}] (streaming) send turn=${cs.chatTurnCount} model=${model} status=${JSON.stringify(chatStream.status(sessionName))}`);
  chatStream.send(sessionName, promptText, (evt) => {
    if (evt.type === 'system' && evt.subtype === 'init') return; // server already sent its own init
    applyClaudeChatEvent(cs, sessionName, evt, forward);
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
  cancelProgressSummary(cs);
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
  // Guard F: a streaming turn that dropped mid-response (connection closed) lands
  // here via the stream .catch with partial text + the API-error tail. Resume
  // (capped) or reset the consecutive-error counter. A user-initiated interrupt
  // bumps _streamTurnSeq, so this only runs for turns that ended on their own.
  const sawApi = cs._sawApiError; cs._sawApiError = false;
  handleApiErrorBoundary(sessionName, finalText, sawApi);
  // Resting status: API/transport error → error ('出现异常', alerts); a clean
  // result → completed ('任务完成'); an aborted/partial turn → idle.
  if (sawApi) {
    cancelPendingClassify(cs);
    emitTurnOutcome(sessionName, { status: 'error', notifyState: 'error', message: '出现异常', alert: true });
  } else if (completedOk) {
    emitTurnOutcome(sessionName, { status: 'completed', notifyState: 'completed', message: '任务完成', alert: false });
  } else {
    setSessionStatus(sessionName, { status: 'idle', currentFile: null });
  }
  chatBroadcast(sessionName, { type: 'stream_end' });

  // Gateway/dispatch回流 — same hooks the per-turn close handler fires.
  try {
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
      pendingClassifyTimer: null,
      pendingClassifyTaskId: null,
      progressSummaryTimer: null,
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
    providerId: provId,
    providerName: provName,
    providerTokenWindows: provWindows,
  }));

  // Replay saved history + in-progress assistant response (if any)
  const history = loadChatHistory(sessionName);
  const replayMessages = [...history];
  // Append unsaved in-progress response so reconnecting clients see current state
  if (cs.currentAssistantText || cs.currentToolCalls.length) {
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
    ws.send(JSON.stringify({ type: 'chat_history', messages: replayMessages, tokenUsage: sessionTokenUsage }));
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
        cancelPendingClassify(cs);
        return;
      }

      if (msg.type === 'cancel') {
        cancelPendingClassify(cs);
        cancelProgressSummary(cs);
        if (persisted.streaming && cs.cli === 'claude' && chatStream.isAlive(sessionName)) {
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
        if (keep > 0 && h && h.length > keep) {
          // Keep the last N messages (typically user/assistant pairs), distill the rest.
          const removed = h.splice(0, h.length - keep);
          if (removed.length) distillHistoryIntoMemory(sessionName, removed);
        } else {
          // Distill the soon-to-be-discarded conversation into long-lived session
          // memory BEFORE wiping it (key problems + how they were solved).
          if (h && h.length) distillHistoryIntoMemory(sessionName, h.slice());
          if (h) h.length = 0;
        }
        saveChatHistory(sessionName);
        // Reset the CLI session so next turn starts fresh:
        //   claude: allocate a new UUID (will be used as --session-id)
        //   codex:  clear so next exec allocates a fresh thread (will be captured from thread.started)
        const pExisting = persistedSessions.get(sessionName);
        if (pExisting) {
          pExisting.cliSessionId = (cs.cli === 'claude') ? crypto.randomUUID() : null;
          savePersistedSessions();
        }
        cs.chatTurnCount = 0;
        console.log(`[multicc/chat] Cleared history and reset ${cs.cli} session for ${sessionName}`);
        return;
      }

      if (msg.type === 'user_message' && msg.text) {
        // Gateway: a bare 确认/取消 resolves a pending dispatch without running the LLM.
        if (persisted.type === 'gateway' && handleGatewayControl(msg.text)) return;
        // Goal mode: client flags the message; server applies the configured
        // round/budget limits (per-send override merged over the global config).
        const turnOpts = msg.goal ? { goalLimits: resolveGoalLimits(msg.goalLimits) } : {};
        runChatTurn(sessionName, msg.text, turnOpts);
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
wss.on('connection', (ws, req) => {
  const urlObj = new URL(req.url, 'http://localhost');

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

  // Auth check for WebSocket (cookie, token param, or localhost) — bypassed when
  // a valid share scope is present.
  if (ACCESS_TOKEN && !sharePerm) {
    const ip = req.socket.remoteAddress;
    const isLocal = (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') && !isExternalProxy(req);
    const cookies = parseCookies(req.headers.cookie);
    const hasCookie = cookies.multicc_auth && verifyAuthCookie(cookies.multicc_auth);
    const hasToken = urlObj.searchParams.get('token') === ACCESS_TOKEN;
    if (!isLocal && !hasCookie && !hasToken) {
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

  // Route to aux queue monitor (read-only WebSocket for __aux__ session)
  if (urlObj.pathname === '/ws/aux') {
    auxQueue.clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // Send current status + recent history on connect
    ws.send(JSON.stringify({ type: 'aux_init', status: auxQueue.getStatus() }));
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
      session = createSession(sessionId);
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
        fs.writeFileSync(tmpPath, Buffer.from(data, 'base64'));
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
initWorktrees();
recoverTmuxSessions();

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

function _readSkillVer(dir) {
  try { return fs.readFileSync(path.join(dir, '.skill-version'), 'utf8').trim(); } catch (_) { return null; }
}

function _isSkillDir(dir) {
  try { return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'SKILL.md')); } catch (_) { return false; }
}

// (1) Copy bundled multicc skills (./skills/) into each provider's skill dir.
// Re-copies when .skill-version differs or is missing.
function installBundledSkills() {
  const srcRoot = path.join(__dirname, 'skills');
  let names;
  try { names = fs.readdirSync(srcRoot); } catch (_) { return; }
  for (const name of names) {
    try {
      const src = path.join(srcRoot, name);
      if (!_isSkillDir(src)) continue;
      for (const prov of SKILL_PROVIDERS) {
        const dest = path.join(prov.dir, name);
        if (fs.existsSync(dest) && _readSkillVer(dest) === _readSkillVer(src)) continue;
        fs.mkdirSync(prov.dir, { recursive: true });
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(src, dest, { recursive: true });
        try { for (const f of fs.readdirSync(path.join(dest, 'bin'))) fs.chmodSync(path.join(dest, 'bin', f), 0o755); } catch (_) {}
        console.log(`[multicc/skills] installed bundled → ~/.${prov.name}/skills/${name}`);
      }
    } catch (e) {
      console.warn(`[multicc/skills] install bundled ${name} failed: ${e.message}`);
    }
  }
}

// (2) Symlink ~/.agents/skills/* into each provider's skill dir, using the
// skill-converter to produce provider-appropriate versions when needed (e.g.
// stripped Codex frontmatter, Hermes metadata). Mechanical conversion runs
// inline; AI-assisted deep conversion is queued for background processing.
function syncSharedSkills() {
  let linkCount = 0;
  let skipCount = 0;
  let convCount = 0;

  let agentNames;
  try { agentNames = fs.readdirSync(AGENTS_SKILLS_DIR); } catch (_) { return { linkCount: 0, skipCount: 0, convCount: 0 }; }

  for (const prov of SKILL_PROVIDERS) {
    fs.mkdirSync(prov.dir, { recursive: true });
    const protectedSet = new Set(prov.protectedSubdirs || []);

    for (const name of agentNames) {
      if (protectedSet.has(name)) continue;

      const src = path.join(AGENTS_SKILLS_DIR, name);
      if (!_isSkillDir(src)) continue;

      // ── Run converter for this skill → target provider ──
      if (prov.name !== 'claude') {
        const convResult = skillConv.ensureSkillConverted(name);
        if (convResult.mechanical.length > 0) convCount++;
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

      // Real directory exists (user's own version)? Don't overwrite.
      if (fs.existsSync(dest) && !fs.lstatSync(dest).isSymbolicLink()) {
        continue;
      }

      // Remove broken/wrong symlink and create correct one.
      try { fs.unlinkSync(dest); } catch (_) {}
      try {
        fs.symlinkSync(linkSrc, dest);
        linkCount++;
      } catch (e) {
        console.warn(`[multicc/skills] symlink ${prov.name} ← ${name}: ${e.message}`);
        skipCount++;
      }
    }
  }
  if (linkCount > 0 || skipCount > 0 || convCount > 0) {
    console.log(`[multicc/skills] shared sync: ${linkCount} linked, ${skipCount} skipped, ${convCount} converted`);
  }
  return { linkCount, skipCount, convCount };
}

// ── AI-assisted skill conversion callback ──
// When mechanical conversion is done, the converter queues deeper AI rewrites.
// We spawn a one-shot background session to do the actual rewriting via Claude.
skillConv.onAiConvertNeeded((batch) => {
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
      `"$CLAUDE_CMD" -p "$(cat /tmp/multicc-skillconv-${skillName}.txt)" --allowedTools "Bash,Read,Write,Edit" --output-format text --max-turns 3 2>&1`,
    ].join(' && ');

    const curlCmd = `curl -s ${process.env.MULTICC_BASE_URL || 'http://127.0.0.1:' + (process.env.PORT || 3000)}/api/sessions/${process.env.MULTICC_SESSION_ID || 'multicc-claude-chat-02'}/run-detached -H 'Content-Type: application/json' -d '${JSON.stringify({ command: cmd, label: `skillconv-${skillName}→${provider}` })}'`;

    console.log(`[multicc/skills] queued AI conversion: ${skillName} → ${provider}`);
    try { require('child_process').execSync(curlCmd, { timeout: 5000 }); } catch (_) {}
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
// restart. On SIGTERM/SIGINT we flush each session's partial assistant text
// first (appendChatMessage is synchronous), then exit.
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
function gracefulShutdown(sig) {
  if (_shuttingDown) return;
  // Ignore SIGTERM (kill) to prevent accidental shutdowns. Use SIGINT (Ctrl+C) to exit.
  if (sig === 'SIGTERM') {
    console.log('[multicc] SIGTERM ignored. Use ./multicc stop to stop.');
    return;
  }
  _shuttingDown = true;
  // Exit cleanly, flushing anything still unsaved as a safety net (covers turns
  // that didn't reach `result` in time, or new turns started during drain).
  const finish = (why) => {
    let n = 0;
    try { n = flushInFlightChats(); } catch (e) { console.error(`[multicc] shutdown flush error: ${e.message}`); }
    console.log(`[multicc] ${sig} → ${why}; flushed ${n} partial message(s), exiting`);
    process.exit(0);
  };
  // Snapshot turns that are mid-flight right now and let them finish so their
  // FULL assistant message is persisted normally (not a half-written partial).
  // A turn is in flight while its child process is still alive (proc 'close'
  // nulls cs.claudeProc after the result is saved).
  const draining = new Set();
  for (const [name, cs] of chatSessions) {
    if (cs && cs.claudeProc) draining.add(name);
  }
  if (draining.size === 0) return finish('no in-flight turns');
  console.log(`[multicc] ${sig} → draining ${draining.size} in-flight turn(s) before exit (grace ${SHUTDOWN_GRACE_MS}ms)`);
  const t0 = Date.now();
  const timer = setInterval(() => {
    for (const name of [...draining]) {
      const cs = chatSessions.get(name);
      if (!cs || !cs.claudeProc) draining.delete(name);   // that turn finished + saved
    }
    if (draining.size === 0) { clearInterval(timer); finish('all turns drained'); }
    else if (Date.now() - t0 > SHUTDOWN_GRACE_MS) { clearInterval(timer); finish('grace timeout'); }
  }, 300);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

(async () => {
  try {
    PORT = await findAvailablePort(PORT);
  } catch (err) {
    console.error(`[multicc] ${err.message}`);
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log(`\n  MultiCC is running at http://localhost:${PORT}\n`);
    console.log(`  Manage sessions at http://localhost:${PORT}/manage\n`);
    console.log(`  Use Tailscale / ngrok for HTTPS access from external devices.\n`);
    seedTokenUsageFromHistory();
    installBundledSkills();                         // bundled multicc skills → all providers
    skillConv.importAllProviderSkills();            // reverse-import: Codex/Hermes → agents
    syncSharedSkills();                             // forward sync: agents → all providers
    watchSharedSkills();                            // real-time chokidar watch on ~/.agents/skills
    setInterval(() => {
      skillConv.importAllProviderSkills();          // periodic reverse import
      syncSharedSkills();                           // periodic forward sync
    }, 5 * 60 * 1000).unref();
    reconcileAllTriggers();
    artifacts.cleanup();
    setInterval(() => artifacts.cleanup(), 6 * 3600 * 1000).unref();
  });
})();
