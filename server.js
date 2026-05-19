'use strict';

// Load .env file (lightweight, no dependencies)
const _envPath = require('path').join(__dirname, '.env');
try {
  require('fs').readFileSync(_envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch (_) { /* .env not found, skip */ }

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
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const wechatBridge = require('./wechat-ilink');
const webpush = require('web-push');

const crypto = require('crypto');
const app = express();

// ── Access token authentication (cookie-based login) ──
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

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

function isAuthenticated(req) {
  if (!ACCESS_TOKEN) return true;
  // Localhost allowed — unless it's a reverse proxy forwarding external traffic
  const ip = req.ip || req.connection.remoteAddress;
  if ((ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') && !isExternalProxy(req)) return true;
  // Cookie auth (HMAC-signed, survives server restart)
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.multicc_auth && verifyAuthCookie(cookies.multicc_auth)) return true;
  // Query param / header (backwards compat for API / WebSocket)
  const token = req.query.token || req.headers['x-access-token'];
  if (token === ACCESS_TOKEN) return true;
  return false;
}

if (ACCESS_TOKEN) {
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
    if (isAuthenticated(req)) return next();
    // Redirect HTML requests to login, reject API calls with 403
    if (req.headers.accept?.includes('text/html') || (!req.path.startsWith('/api/') && req.method === 'GET')) {
      res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
    } else {
      res.status(403).json({ error: 'Forbidden: not authenticated' });
    }
  });
}

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

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
const cliProviders = {
  claude: {
    name: 'claude',
    cmd: CLAUDE_CMD,
    // Interactive terminal: `claude --session-id <uuid>`
    buildTerminalCmd(session) {
      let cmd = `${CLAUDE_CMD}${CLAUDE_ARGS.length ? ' ' + CLAUDE_ARGS.join(' ') : ''}`;
      if (session.cliSessionId) cmd += ` --session-id ${session.cliSessionId}`;
      return cmd;
    },
    // Chat-mode spawn args: `-p --output-format stream-json [--resume id | --session-id id] <prompt>`
    buildChatSpawnArgs(session, prompt, opts) {
      const args = [
        '-p', '--output-format', 'stream-json', '--verbose',
        '--include-partial-messages', '--dangerously-skip-permissions',
      ];
      if (CLAUDE_CHAT_DISALLOWED_TOOLS.length) {
        args.push('--disallowedTools', CLAUDE_CHAT_DISALLOWED_TOOLS.join(','));
      }
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
      if (opts.isFirstTurn) {
        args.push('exec', '--json', '--skip-git-repo-check',
          '--dangerously-bypass-approvals-and-sandbox', prompt);
      } else {
        args.push('exec', 'resume', session.cliSessionId, '--json',
          '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', prompt);
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
function findCodexSessionId(cwd, sinceMs) {
  try {
    if (!fs.existsSync(CODEX_SESSIONS_DIR)) return null;
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
    walk(CODEX_SESSIONS_DIR);
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

// ── tmux helpers ──
const TMUX_PREFIX = 'multicc-';
const TMUX_FIFO_DIR = path.join(os.tmpdir(), 'multicc-fifos');
try { fs.mkdirSync(TMUX_FIFO_DIR, { recursive: true }); } catch (_) {}

function tmuxSessionName(id) { return `${TMUX_PREFIX}${id}`; }

function tmuxHasSession(id) {
  try {
    execSync(`tmux has-session -t ${tmuxSessionName(id)} 2>/dev/null`);
    return true;
  } catch { return false; }
}

function tmuxCreateSession(id, cwd, cols, rows, session) {
  const name = tmuxSessionName(id);
  const provider = providerFor(session);
  const cmd = provider.buildTerminalCmd(session || {});
  // set-option remain-on-exit off so the session disappears when CLI exits
  execSync(
    `tmux new-session -d -s "${name}" -x ${cols} -y ${rows} -c "${cwd}" "${cmd}"`,
    { env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } }
  );
}

function tmuxResize(id, cols, rows) {
  try {
    execSync(`tmux resize-window -t "${tmuxSessionName(id)}" -x ${cols} -y ${rows} 2>/dev/null`);
  } catch (_) {}
}

// Compute pane size as max(cols) × max(rows) across all attached clients,
// then push to tmux only if it actually changed. Skips clients that haven't
// reported a size yet. Returns true if a resize was applied.
function applyMaxClientSize(session) {
  let maxCols = 0;
  let maxRows = 0;
  for (const c of session.clients) {
    if (c._desiredCols && c._desiredCols > maxCols) maxCols = c._desiredCols;
    if (c._desiredRows && c._desiredRows > maxRows) maxRows = c._desiredRows;
  }
  if (!maxCols || !maxRows) return false;
  if (maxCols === session.appliedCols && maxRows === session.appliedRows) return false;
  tmuxResize(session.id, maxCols, maxRows);
  session.appliedCols = maxCols;
  session.appliedRows = maxRows;
  return true;
}

function tmuxKillSession(id) {
  try { execSync(`tmux kill-session -t "${tmuxSessionName(id)}" 2>/dev/null`); } catch (_) {}
}

function tmuxCapturePane(id) {
  try {
    return execSync(`tmux capture-pane -t "${tmuxSessionName(id)}" -p -S -500 2>/dev/null`, { encoding: 'utf8' });
  } catch { return ''; }
}

function tmuxPaneTty(id) {
  return execSync(`tmux display-message -t "${tmuxSessionName(id)}" -p "#{pane_tty}"`, { encoding: 'utf8' }).trim();
}

function tmuxPaneCwd(id) {
  try {
    return execSync(`tmux display-message -t "${tmuxSessionName(id)}" -p "#{pane_current_path}"`, { encoding: 'utf8' }).trim();
  } catch { return os.homedir(); }
}

function tmuxWriteInput(id, data) {
  if (!data) return;
  try {
    execFileSync('tmux', ['send-keys', '-t', tmuxSessionName(id), '-l', '--', data]);
  } catch (e) {
    console.error('[multicc] tmuxWriteInput error:', e.message);
  }
}

function fifoPathForSession(id) {
  return path.join(TMUX_FIFO_DIR, `${id}.fifo`);
}

function startOutputCapture(id) {
  const fifoPath = fifoPathForSession(id);
  // Clean up any stale FIFO
  try { fs.unlinkSync(fifoPath); } catch (_) {}
  execSync(`mkfifo "${fifoPath}"`);

  // Tell tmux to pipe pane output into our FIFO (no -o: always replace existing pipe)
  execSync(`tmux pipe-pane -t "${tmuxSessionName(id)}" "cat > '${fifoPath}'"`);

  // Open FIFO with O_RDWR | O_NONBLOCK, wrap in net.Socket:
  // - O_RDWR prevents spurious EOF (always has a potential writer)
  // - O_NONBLOCK is required for net.Socket's event-driven I/O (kqueue/epoll)
  // - net.Socket handles EAGAIN correctly (unlike fs.createReadStream which dies on EAGAIN)
  const fd = fs.openSync(fifoPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  const stream = new net.Socket({ fd, readable: true, writable: false });
  return { stream, fifoPath };
}

function stopOutputCapture(session) {
  if (session.outputStream) {
    try { session.outputStream.destroy(); } catch (_) {}
    session.outputStream = null;
  }
  if (session.fifoPath) {
    // Stop tmux pipe-pane
    try { execSync(`tmux pipe-pane -t "${tmuxSessionName(session.id)}" 2>/dev/null`); } catch (_) {}
    try { fs.unlinkSync(session.fifoPath); } catch (_) {}
    session.fifoPath = null;
  }
}

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
const WORKTREE_SUBDIR = '.multicc-worktrees';
const gitReadyDirs = new Set();          // dir.id once its repo is verified/initialised
const invalidSessions = new Map();       // sessionId → reason; recovery is skipped for these

function gitRun(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitIsRepo(dirPath) {
  try { return gitRun(dirPath, ['rev-parse', '--is-inside-work-tree']) === 'true'; }
  catch { return false; }
}

function gitHasCommit(dirPath) {
  try { gitRun(dirPath, ['rev-parse', 'HEAD']); return true; }
  catch { return false; }
}

function gitBaseBranch(dirPath) {
  try {
    const b = gitRun(dirPath, ['symbolic-ref', '--short', 'HEAD']);
    if (b) return b;
  } catch (_) {}
  try {
    const b = gitRun(dirPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (b && b !== 'HEAD') return b;
  } catch (_) {}
  return 'main';
}

// Add `.multicc-worktrees/` to .git/info/exclude (does not touch the user's tracked .gitignore).
function gitEnsureExcluded(dirPath) {
  try {
    const gitDir = gitRun(dirPath, ['rev-parse', '--git-dir']);
    const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(dirPath, gitDir);
    const excludeFile = path.join(absGitDir, 'info', 'exclude');
    let content = '';
    try { content = fs.readFileSync(excludeFile, 'utf8'); } catch (_) {}
    if (!content.split('\n').some(l => l.trim() === WORKTREE_SUBDIR + '/')) {
      fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
      fs.appendFileSync(excludeFile, (content && !content.endsWith('\n') ? '\n' : '') + WORKTREE_SUBDIR + '/\n');
    }
  } catch (e) {
    console.warn('[multicc] gitEnsureExcluded failed:', e.message);
  }
}

// True if the path is the home directory, an ancestor of it, or a filesystem root.
function isHomeOrAbove(p) {
  const real = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  const rp = real(p);
  const rh = real(os.homedir());
  if (rp === rh) return true;
  if (rh === rp || rh.startsWith(rp + path.sep)) return true;  // rp is an ancestor of home
  if (rp === path.parse(rp).root) return true;
  return false;
}

function realPathOf(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// Find an already-registered directory whose physical path matches `resolvedPath`.
function findDirByPath(resolvedPath, excludeId) {
  const target = realPathOf(resolvedPath);
  for (const d of directories.values()) {
    if (excludeId && d.id === excludeId) continue;
    if (realPathOf(d.path) === target) return d;
  }
  return null;
}

// Make sure a directory is a usable git repo; refuses $HOME and missing paths.
function ensureDirGitReady(dir) {
  if (gitReadyDirs.has(dir.id)) return { ok: true };
  if (isHomeOrAbove(dir.path)) return { ok: false, reason: 'home-or-above' };
  if (!fs.existsSync(dir.path)) return { ok: false, reason: 'path-missing' };
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

// Create (or re-attach) the worktree for a session. Returns { worktreePath, branch }.
function gitWorktreeAdd(dirPath, sessionId, baseBranch) {
  const wtPath = path.join(dirPath, WORKTREE_SUBDIR, sessionId);
  const branch = `multicc/${sessionId}`;
  fs.mkdirSync(path.join(dirPath, WORKTREE_SUBDIR), { recursive: true });
  try { gitRun(dirPath, ['worktree', 'prune']); } catch (_) {}
  if (fs.existsSync(wtPath)) return { worktreePath: wtPath, branch };  // already there
  let branchExists = false;
  try { gitRun(dirPath, ['rev-parse', '--verify', branch]); branchExists = true; } catch (_) {}
  if (branchExists) {
    gitRun(dirPath, ['worktree', 'add', wtPath, branch]);
  } else {
    gitRun(dirPath, ['worktree', 'add', wtPath, '-b', branch, baseBranch]);
  }
  return { worktreePath: wtPath, branch };
}

function gitWorktreeRemove(dirPath, worktreePath, branch) {
  try { gitRun(dirPath, ['worktree', 'remove', '--force', worktreePath]); }
  catch (e) { console.warn('[multicc] worktree remove failed:', e.message); }
  if (branch) { try { gitRun(dirPath, ['branch', '-D', branch]); } catch (_) {} }
  try { gitRun(dirPath, ['worktree', 'prune']); } catch (_) {}
}

// Stage + commit everything in a worktree. Returns true if a commit was actually made.
function gitWorktreeCommitAll(worktreePath, message) {
  gitRun(worktreePath, ['add', '-A']);
  try {
    gitRun(worktreePath, ['diff', '--cached', '--quiet']);
    return false;  // exit 0 → nothing staged
  } catch (_) { /* exit 1 → there are staged changes */ }
  gitRun(worktreePath, ['-c', 'user.email=multicc@local', '-c', 'user.name=multicc',
    'commit', '-m', message]);
  return true;
}

// Commit pending work in the worktree, then merge its branch into the base branch.
function gitMergeBack(dir, session) {
  const dirPath = dir.path;
  const branch = session.branch;
  const baseBranch = dir.baseBranch || gitBaseBranch(dirPath);
  const wtPath = session.worktreePath;
  if (!branch || !wtPath) return { ok: false, error: 'session has no worktree' };

  let committed = false;
  if (fs.existsSync(wtPath)) {
    try {
      committed = gitWorktreeCommitAll(wtPath,
        `multicc: session ${session.id} @ ${new Date().toISOString()}`);
    } catch (e) {
      return { ok: false, error: `commit failed: ${e.message}` };
    }
  }

  const curBranch = gitBaseBranch(dirPath);
  if (curBranch !== baseBranch) {
    return { ok: false, error:
      `base branch '${baseBranch}' is not checked out in the main directory (currently on '${curBranch}'); merge manually` };
  }

  let ahead = 0;
  try { ahead = parseInt(gitRun(dirPath, ['rev-list', '--count', `${baseBranch}..${branch}`]) || '0', 10); }
  catch (_) {}
  if (ahead === 0) return { ok: true, merged: false, committed, message: '没有新提交需要合并' };

  try {
    gitRun(dirPath, ['merge', '--no-ff', '-m', `multicc: merge ${branch}`, branch]);
    return { ok: true, merged: true, committed, commits: ahead };
  } catch (e) {
    let conflicts = [];
    try {
      conflicts = gitRun(dirPath, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    } catch (_) {}
    try { gitRun(dirPath, ['merge', '--abort']); } catch (_) {}
    return { ok: false, conflicts, error: '合并冲突 — 已 abort，基分支未改动' };
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
  if (session.worktreePath && fs.existsSync(session.worktreePath)) return session.worktreePath;
  const dir = directories.get(session.dirId);
  if (dir && dir.path) return dir.path;
  return session.cwd || os.homedir();
}

// ── Session management ──
// { id, tmuxName, ttyPath, outputStream, fifoPath, buffer: string[], clients: Set<ws>, createdAt, lastActivity, cwd, exitCheckTimer }
const sessions = new Map();

function generateId() {
  let id = '';
  while (id.length < 8) id += Math.random().toString(36).slice(2);
  return id.slice(0, 8);
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
    tmuxCreateSession(id, cwd, 80, 24, persisted);
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
      const captured = findCodexSessionId(cwd, launchTime - 2000);
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
    // Forward to WeChat bridge if active for this session
    wechatBridge.onSessionOutput(id, str);
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
            wechatBridge.onSessionOutput(id, str);
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

app.get('/api/sessions', (req, res) => {
  const list = [...persistedSessions.values()]
    .filter(p => p.type !== 'aux')
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
        cwd,
        createdAt: p.createdAt,
      };
      if (p.kind === 'chat' || active === undefined) {
        // Chat sessions don't live in `sessions` (terminal) map; derive active state from chatSessions
        const isChatActive = !!activeChat && (activeChat.clients.size > 0 || activeChat.isStreaming);
        return {
          ...base,
          lastActivity: activeChat?.lastActivity || null,
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

// ── Directory REST API ──
app.get('/api/directories', (req, res) => {
  // Annotate each directory with counts per (cli, kind)
  const list = [...directories.values()].map(d => {
    const counts = { claude_terminal: 0, claude_chat: 0, codex_terminal: 0, codex_chat: 0 };
    for (const s of persistedSessions.values()) {
      if (s.dirId !== d.id) continue;
      const k = `${s.cli || 'claude'}_${s.kind || 'terminal'}`;
      if (counts[k] !== undefined) counts[k]++;
    }
    return { ...d, counts };
  });
  res.json(list);
});

app.post('/api/directories', (req, res) => {
  const name = (req.body.name || '').trim();
  const rawPath = (req.body.path || '').trim();
  if (!name || !rawPath) return res.status(400).json({ error: 'name and path required' });
  const resolvedPath = resolveCwd(os.homedir(), rawPath);
  if (!fs.existsSync(resolvedPath)) {
    return res.status(400).json({ error: `path does not exist: ${resolvedPath}` });
  }
  if (isHomeOrAbove(resolvedPath)) {
    return res.status(400).json({ error: '不允许选择 $HOME 或更高层目录' });
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
    return res.status(400).json({ error: `无法将目录初始化为 git 仓库: ${ready.reason}` });
  }
  saveDirectories();
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
      chatSessions.delete(s.id);
    }
    if (s.worktreePath && s.branch) gitWorktreeRemove(d.path, s.worktreePath, s.branch);
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
        createdAt: s.createdAt,
        branch: s.branch || null,
        worktreePath: s.worktreePath || null,
        invalid: invalidSessions.get(s.id) || null,
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

app.post('/api/directories/:id/sessions', (req, res) => {
  const d = directories.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'directory not found' });
  const cli = (req.body.cli || '').trim();
  const kind = (req.body.kind || '').trim();
  const label = (req.body.label || '').trim() || null;
  if (!['claude', 'codex'].includes(cli)) return res.status(400).json({ error: 'cli must be claude or codex' });
  if (!['terminal', 'chat'].includes(kind)) return res.status(400).json({ error: 'kind must be terminal or chat' });

  // Generate a unique id. Use generateId() for short ids; append kind suffix for human readability.
  let id;
  let tries = 0;
  do {
    const base = generateId();
    id = kind === 'chat' ? `${base}-chat` : base;
    tries++;
    if (tries > 10) return res.status(500).json({ error: 'could not allocate unique session id' });
  } while (persistedSessions.has(id));

  // Every session is isolated — make sure the directory is a git repo, then give the
  // session its own worktree + branch.
  const ready = ensureDirGitReady(d);
  if (!ready.ok) {
    return res.status(400).json({ error: `目录无法用于隔离会话（git 未就绪: ${ready.reason}）` });
  }
  let worktreePath, branch;
  try {
    ({ worktreePath, branch } = gitWorktreeAdd(d.path, id, d.baseBranch));
  } catch (e) {
    return res.status(500).json({ error: 'worktree 创建失败: ' + e.message });
  }

  const session = {
    id,
    dirId: d.id,
    cli, kind,
    cliSessionId: null,   // claude gets one allocated on spawn; codex captures from first event
    label,
    createdAt: new Date().toISOString(),
    worktreePath,
    branch,
  };
  persistedSessions.set(id, session);
  savePersistedSessions();
  appendEvent(d.id, 'session_created', `${cli} ${kind}`, id);
  res.json(session);
});

// PATCH a session — currently supports label edits
app.patch('/api/sessions/:id', (req, res) => {
  const s = persistedSessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (req.body.label !== undefined) s.label = (req.body.label || '').trim() || null;
  savePersistedSessions();
  res.json(s);
});

app.get('/api/sessions/:id', (req, res) => {
  const id = req.params.id;
  const active = sessions.get(id);
  const persisted = persistedSessions.get(id);
  if (!active && !persisted) return res.status(404).json({ error: 'Session not found' });
  if (active) {
    res.json({ id: active.id, cwd: active.cwd, createdAt: active.createdAt, lastActivity: active.lastActivity, clients: active.clients.size, active: true });
  } else {
    res.json({ id: persisted.id, cwd: persisted.cwd, createdAt: persisted.createdAt, lastActivity: null, clients: 0, active: false });
  }
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
    if (chat.pendingClassifyTimer) clearTimeout(chat.pendingClassifyTimer);
    chatSessions.delete(id);
  }
  // Remove the session's git worktree + branch.
  const persisted = persistedSessions.get(id);
  if (persisted && persisted.worktreePath && persisted.branch) {
    const dir = directories.get(persisted.dirId);
    if (dir) gitWorktreeRemove(dir.path, persisted.worktreePath, persisted.branch);
  }
  if (persisted) appendEvent(persisted.dirId, 'session_deleted', persisted.label || persisted.id, null);
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
    return res.status(result.conflicts ? 409 : 400).json(result);
  }
  console.log(`[multicc] merge ${persisted.branch} → ${dir.baseBranch}: ` +
    (result.merged ? `${result.commits} commit(s)` : 'nothing to merge'));
  appendEvent(dir.id, 'merged',
    result.merged ? `${result.commits} 个提交 → ${dir.baseBranch}` : '无新提交', id);
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

// ── Voice Refine Worker (global, starts with server) ──
const VOICE_EXAMPLES_FILE = path.join(__dirname, 'voice_examples.json');
const WHISPER_VOCAB_FILE = path.join(__dirname, 'whisper_vocab.json');

function loadVoiceExamples() {
  try {
    if (fs.existsSync(VOICE_EXAMPLES_FILE)) {
      const data = JSON.parse(fs.readFileSync(VOICE_EXAMPLES_FILE, 'utf8'));
      return Array.isArray(data) ? data.slice(-5) : [];
    }
  } catch (_) {}
  return [];
}

function appendVoiceExample(entry) {
  let data = [];
  try {
    if (fs.existsSync(VOICE_EXAMPLES_FILE)) {
      data = JSON.parse(fs.readFileSync(VOICE_EXAMPLES_FILE, 'utf8'));
      if (!Array.isArray(data)) data = [];
    }
  } catch (_) {}
  data.push(entry);
  if (data.length > 50) data = data.slice(-50);
  try {
    fs.writeFileSync(VOICE_EXAMPLES_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[multicc] Failed to write voice_examples.json:', e.message);
  }
}

// ── Whisper vocabulary (user-corrected terms) ──
function loadWhisperVocab() {
  try {
    if (fs.existsSync(WHISPER_VOCAB_FILE)) {
      const data = JSON.parse(fs.readFileSync(WHISPER_VOCAB_FILE, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (_) {}
  return [];
}

function saveWhisperVocab(vocab) {
  try {
    fs.writeFileSync(WHISPER_VOCAB_FILE, JSON.stringify(vocab, null, 2));
  } catch (e) {
    console.error('[multicc] Failed to write whisper_vocab.json:', e.message);
  }
}

/**
 * Extract correction terms by diffing raw STT output against user's final edit.
 * Segments text into tokens, finds words the user replaced/added.
 * Returns an array of { wrong, correct } pairs.
 */
function extractCorrections(raw, userFinal) {
  if (!raw || !userFinal || raw === userFinal) return [];

  // Tokenize: split into Chinese chars / English words / mixed tokens
  const tokenize = s => s.match(/[a-zA-Z][a-zA-Z0-9_./-]*/g) || [];

  const rawTokens = new Set(tokenize(raw).map(t => t.toLowerCase()));
  const finalTokens = tokenize(userFinal);

  const corrections = [];
  for (const token of finalTokens) {
    // Token appears in userFinal but NOT in raw → user corrected something to this
    if (token.length > 1 && !rawTokens.has(token.toLowerCase())) {
      corrections.push(token);
    }
  }
  return corrections;
}

/**
 * Merge new correction terms into whisper_vocab.json (deduplicated).
 * Each entry: { term, count, lastSeen }
 */
function mergeWhisperVocab(newTerms) {
  if (!newTerms || newTerms.length === 0) return;
  const vocab = loadWhisperVocab();
  const termMap = new Map(vocab.map(v => [v.term.toLowerCase(), v]));

  for (const term of newTerms) {
    const key = term.toLowerCase();
    if (termMap.has(key)) {
      const existing = termMap.get(key);
      existing.count = (existing.count || 1) + 1;
      existing.lastSeen = new Date().toISOString();
      // Keep the casing from the latest correction
      existing.term = term;
    } else {
      termMap.set(key, { term, count: 1, lastSeen: new Date().toISOString() });
    }
  }

  // Sort by count desc, keep top 100
  const sorted = [...termMap.values()].sort((a, b) => b.count - a.count).slice(0, 100);
  saveWhisperVocab(sorted);
  console.log(`[multicc/stt] Whisper vocab updated: ${sorted.length} terms, added: ${newTerms.join(', ')}`);
}

// ── Backfill: seed whisper_vocab.json from existing voice_examples on first run ──
(function backfillWhisperVocab() {
  try {
    if (fs.existsSync(WHISPER_VOCAB_FILE)) return; // already initialized
    if (!fs.existsSync(VOICE_EXAMPLES_FILE)) return;
    const examples = JSON.parse(fs.readFileSync(VOICE_EXAMPLES_FILE, 'utf8'));
    if (!Array.isArray(examples)) return;
    const allTerms = [];
    for (const ex of examples) {
      const corrections = extractCorrections(ex.raw, ex.userFinal);
      allTerms.push(...corrections);
    }
    if (allTerms.length > 0) {
      mergeWhisperVocab(allTerms);
      console.log(`[multicc/stt] Backfilled whisper_vocab.json from ${examples.length} voice examples`);
    }
  } catch (e) {
    console.error('[multicc/stt] Backfill error:', e.message);
  }
})();

// ── OpenRouter API configuration for voice refinement ──
let OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
let OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';
let OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

// ── Whisper STT configuration ──
let WHISPER_API_KEY = process.env.WHISPER_API_KEY || '';
let WHISPER_BASE_URL = process.env.WHISPER_BASE_URL || 'https://openrouter.ai/api/v1';
let WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-large-v3-turbo';
let WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || 'zh';
let WHISPER_PROMPT = process.env.WHISPER_PROMPT || '';

/**
 * Build a prompt for Whisper STT to improve recognition of technical terms.
 * Sources (in order):
 *   1. WHISPER_PROMPT — user-configured static terms (from settings / .env)
 *   2. whisper_vocab.json — auto-accumulated from user corrections (feedback)
 * Whisper prompt limit is ~224 tokens, so we keep it concise.
 */
function buildWhisperPrompt() {
  const parts = [];

  // 1. User-configured static prompt (highest priority)
  if (WHISPER_PROMPT) parts.push(WHISPER_PROMPT.trim());

  // 2. Load accumulated vocabulary from user corrections
  try {
    const vocab = loadWhisperVocab();
    if (vocab.length > 0) {
      // Already sorted by count desc in mergeWhisperVocab; take top 40
      const terms = vocab.slice(0, 40).map(v => v.term);
      parts.push(terms.join(', '));
    }
  } catch (_) {}

  const prompt = parts.join('. ');
  // Whisper prompt is limited to ~224 tokens; truncate to ~500 chars as safety margin
  return prompt.length > 500 ? prompt.slice(0, 500) : prompt;
}

/**
 * Call OpenRouter API with streaming for voice refinement.
 * Replaces the old CLI spawn approach for much lower latency.
 * Supports concurrent requests (no sequential queue needed).
 */
async function callVoiceAPI(prompt, { reqId, onStart, onFirstToken, onChunk, onDone, onError }) {
  if (typeof onStart === 'function') onStart();

  if (!OPENROUTER_API_KEY) {
    onError('OPENROUTER_API_KEY 环境变量未设置');
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 60000);

  try {
    const apiStart = Date.now();
    console.log(`[multicc/voice][${reqId}] Sending request to OpenRouter (model: ${OPENROUTER_MODEL})`);
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter API ${response.status}: ${errText.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstTokenSent = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              if (!firstTokenSent) {
                firstTokenSent = true;
                if (typeof onFirstToken === 'function') onFirstToken(Date.now() - apiStart);
              }
              onChunk(content);
            }
          } catch (_) { /* skip non-JSON lines */ }
        }
      }
    } finally {
      reader.releaseLock();
    }

    clearTimeout(timeout);
    onDone();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      onChunk('[超时：AI处理超过60秒，已中止]');
      onDone();
    } else {
      onError(err.message);
    }
  }
}

console.log(`[multicc/voice] Voice API initialized (OpenRouter, model: ${OPENROUTER_MODEL})`);

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

  const apiKey = WHISPER_API_KEY || OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'WHISPER_API_KEY 或 OPENROUTER_API_KEY 未设置' });
  }

  console.log(`[multicc/stt][${reqId}] File: ${req.file.originalname}, size: ${req.file.size}, mime: ${req.file.mimetype}`);
  console.log(`[multicc/stt][${reqId}] Forwarding to ${WHISPER_BASE_URL}/audio/transcriptions (model: ${WHISPER_MODEL})`);

  const t0 = Date.now();
  try {
    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' });
    formData.append('file', blob, req.file.originalname || 'audio.webm');
    formData.append('model', WHISPER_MODEL);

    // Add language hint to skip auto-detection
    if (WHISPER_LANGUAGE) {
      formData.append('language', WHISPER_LANGUAGE);
    }

    // Add prompt to guide vocabulary and style recognition
    const whisperPrompt = buildWhisperPrompt();
    if (whisperPrompt) {
      formData.append('prompt', whisperPrompt);
      console.log(`[multicc/stt][${reqId}] Whisper prompt (${whisperPrompt.length} chars): ${whisperPrompt.slice(0, 120)}...`);
    }

    const response = await fetch(`${WHISPER_BASE_URL}/audio/transcriptions`, {
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
  writeEnvFile(updates);
  // Update in-memory env + module-level constants
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
  if (updates.OPENROUTER_API_KEY) OPENROUTER_API_KEY = updates.OPENROUTER_API_KEY;
  if (updates.OPENROUTER_MODEL) OPENROUTER_MODEL = updates.OPENROUTER_MODEL;
  if (updates.OPENROUTER_BASE_URL) OPENROUTER_BASE_URL = updates.OPENROUTER_BASE_URL;
  if (updates.WHISPER_API_KEY) WHISPER_API_KEY = updates.WHISPER_API_KEY;
  if (updates.WHISPER_MODEL) WHISPER_MODEL = updates.WHISPER_MODEL;
  if (updates.WHISPER_BASE_URL) WHISPER_BASE_URL = updates.WHISPER_BASE_URL;
  if (updates.WHISPER_LANGUAGE) WHISPER_LANGUAGE = updates.WHISPER_LANGUAGE;
  if (updates.WHISPER_PROMPT !== undefined) WHISPER_PROMPT = updates.WHISPER_PROMPT;
  console.log(`[multicc/voice] Settings updated: model=${OPENROUTER_MODEL}, baseUrl=${OPENROUTER_BASE_URL}, key=${OPENROUTER_API_KEY ? 'set' : 'empty'}`);
  console.log(`[multicc/stt] Settings updated: model=${WHISPER_MODEL}, baseUrl=${WHISPER_BASE_URL}, key=${WHISPER_API_KEY ? 'set' : 'empty'}`);
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
const PUSH_SUBS_FILE = path.join(__dirname, 'push_subscriptions.json');

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

// Push subscription store
let pushSubscriptions = new Map(); // endpoint -> PushSubscription JSON

// Push health tracking
const pushHealthStats = new Map(); // endpoint -> { successCount, failCount, lastSuccessTime, lastFailTime, lastFailReason, consecutiveFails }
const pushGlobalStats = { totalSent: 0, totalSuccess: 0, totalFail: 0, lastPushTime: 0, lastPushType: '', lastPushSessionId: '' };

function getPushHealthEntry(endpoint) {
  if (!pushHealthStats.has(endpoint)) {
    pushHealthStats.set(endpoint, { successCount: 0, failCount: 0, lastSuccessTime: 0, lastFailTime: 0, lastFailReason: '', consecutiveFails: 0 });
  }
  return pushHealthStats.get(endpoint);
}

// Bark / Webhook backup notification channels
let BARK_URL = process.env.BARK_URL || '';
let WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const barkHealth = { lastSendTime: 0, lastSuccess: true, lastError: '' };
const webhookHealth = { lastSendTime: 0, lastSuccess: true, lastError: '' };

function loadPushSubscriptions() {
  try {
    if (fs.existsSync(PUSH_SUBS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8'));
      pushSubscriptions = new Map(data.map(s => [s.endpoint, s]));
      console.log(`[multicc/push] Loaded ${pushSubscriptions.size} push subscription(s)`);
    }
  } catch (_) {}
}

function savePushSubscriptions() {
  try {
    fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify([...pushSubscriptions.values()], null, 2));
  } catch (e) {
    console.error('[multicc/push] Failed to save subscriptions:', e.message);
  }
}

loadPushSubscriptions();

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
  pushSubscriptions.set(sub.endpoint, sub);
  savePushSubscriptions();
  console.log(`[multicc/push] New subscription (${pushSubscriptions.size} total)`);
  res.json({ ok: true });
});

app.delete('/api/push/subscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint && pushSubscriptions.has(endpoint)) {
    pushSubscriptions.delete(endpoint);
    savePushSubscriptions();
  }
  res.json({ ok: true });
});

// Validate if a subscription is registered server-side
app.post('/api/push/validate', (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  res.json({ known: pushSubscriptions.has(endpoint) });
});

// Push health status
app.get('/api/push/health', (req, res) => {
  const subs = [];
  for (const [endpoint] of pushSubscriptions) {
    const h = pushHealthStats.get(endpoint) || { successCount: 0, failCount: 0, lastSuccessTime: 0, lastFailTime: 0, lastFailReason: '', consecutiveFails: 0 };
    subs.push({
      endpointShort: endpoint.length > 50 ? endpoint.slice(0, 35) + '...' + endpoint.slice(-12) : endpoint,
      ...h,
    });
  }
  res.json({
    subscriptions: subs,
    subscriptionCount: pushSubscriptions.size,
    global: pushGlobalStats,
    bark: { configured: !!BARK_URL, ...barkHealth },
    webhook: { configured: !!WEBHOOK_URL, ...webhookHealth },
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
  await sendPushToAll(payload);
  sendBarkNotification(payload.title, payload.body, payload.url);
  sendWebhookNotification(payload);
  res.json({ ok: true, subscribers: pushSubscriptions.size });
});

// Test Bark only
app.post('/api/push/test-bark', (req, res) => {
  if (!BARK_URL) return res.status(400).json({ error: 'Bark URL not configured' });
  sendBarkNotification('MultiCC Test', `Bark test at ${new Date().toLocaleTimeString()}`, '/manage');
  res.json({ ok: true });
});

// Test Webhook only
app.post('/api/push/test-webhook', (req, res) => {
  if (!WEBHOOK_URL) return res.status(400).json({ error: 'Webhook URL not configured' });
  sendWebhookNotification({ title: 'MultiCC Test', body: `Webhook test at ${new Date().toLocaleTimeString()}`, type: 'test' });
  res.json({ ok: true });
});

// Notification settings (Bark / Webhook)
app.get('/api/settings/notify', (req, res) => {
  res.json({
    barkUrl: BARK_URL ? BARK_URL.replace(/\/[^/]{8,}$/, '/****') : '',
    hasBark: !!BARK_URL,
    webhookUrl: WEBHOOK_URL || '',
    hasWebhook: !!WEBHOOK_URL,
  });
});

app.post('/api/settings/notify', (req, res) => {
  const { barkUrl, webhookUrl } = req.body || {};
  const updates = {};
  if (typeof barkUrl === 'string') { BARK_URL = barkUrl; updates.BARK_URL = barkUrl; }
  if (typeof webhookUrl === 'string') { WEBHOOK_URL = webhookUrl; updates.WEBHOOK_URL = webhookUrl; }
  if (Object.keys(updates).length > 0) writeEnvFile(updates);
  res.json({ ok: true });
});

// Send push notification to all subscribers (async, properly handles stale cleanup)
async function sendPushToAll(payload) {
  if (pushSubscriptions.size === 0) return;
  const payloadStr = JSON.stringify(payload);
  const entries = [...pushSubscriptions.entries()];
  const results = await Promise.allSettled(
    entries.map(([endpoint, sub]) =>
      webpush.sendNotification(sub, payloadStr).then(
        () => ({ endpoint, ok: true }),
        err => ({ endpoint, ok: false, statusCode: err.statusCode, message: err.message })
      )
    )
  );

  const stale = [];
  for (const r of results) {
    const v = r.status === 'fulfilled' ? r.value : { endpoint: '', ok: false, message: 'settled-rejected' };
    const h = getPushHealthEntry(v.endpoint);
    pushGlobalStats.totalSent++;
    if (v.ok) {
      h.successCount++;
      h.lastSuccessTime = Date.now();
      h.consecutiveFails = 0;
      pushGlobalStats.totalSuccess++;
    } else {
      h.failCount++;
      h.lastFailTime = Date.now();
      h.lastFailReason = v.message || `HTTP ${v.statusCode}`;
      h.consecutiveFails++;
      pushGlobalStats.totalFail++;
      if (v.statusCode === 404 || v.statusCode === 410) stale.push(v.endpoint);
      console.error(`[multicc/push] Send failed for ${v.endpoint.slice(0, 40)}... (${v.statusCode || v.message})`);
    }
  }

  if (stale.length > 0) {
    for (const ep of stale) {
      pushSubscriptions.delete(ep);
      pushHealthStats.delete(ep);
    }
    savePushSubscriptions();
    console.log(`[multicc/push] Cleaned ${stale.length} expired subscription(s)`);
  }
}

// Bark push notification (iOS backup)
function sendBarkNotification(title, body, url) {
  if (!BARK_URL) return;
  const barkUrl = `${BARK_URL.replace(/\/$/, '')}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?url=${encodeURIComponent(url || '')}&group=multicc`;
  barkHealth.lastSendTime = Date.now();
  const mod = barkUrl.startsWith('https') ? https : http;
  mod.get(barkUrl, res => {
    barkHealth.lastSuccess = res.statusCode >= 200 && res.statusCode < 300;
    if (!barkHealth.lastSuccess) barkHealth.lastError = `HTTP ${res.statusCode}`;
    else barkHealth.lastError = '';
    res.resume();
  }).on('error', err => {
    barkHealth.lastSuccess = false;
    barkHealth.lastError = err.message;
    console.error('[multicc/push] Bark send failed:', err.message);
  });
}

// Generic webhook notification
function sendWebhookNotification(payload) {
  if (!WEBHOOK_URL) return;
  webhookHealth.lastSendTime = Date.now();
  const data = JSON.stringify(payload);
  const parsed = new URL(WEBHOOK_URL);
  const mod = parsed.protocol === 'https:' ? https : http;
  const req = mod.request(parsed, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
    webhookHealth.lastSuccess = res.statusCode >= 200 && res.statusCode < 300;
    if (!webhookHealth.lastSuccess) webhookHealth.lastError = `HTTP ${res.statusCode}`;
    else webhookHealth.lastError = '';
    res.resume();
  });
  req.on('error', err => {
    webhookHealth.lastSuccess = false;
    webhookHealth.lastError = err.message;
    console.error('[multicc/push] Webhook send failed:', err.message);
  });
  req.end(data);
}

// ── Server-side notification detection (for push notifications) ──
const PUSH_ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z~]|\][^\x07]*(?:\x07|\x1b\\)|[()][AB012]|.)/g;
// "等待操作" — 需要用户做选择或确认（选 1/2/3、Y/n、Allow/Deny）
const PUSH_WAITING_PATTERNS = [
  /\[Y\/n\]/, /\[y\/N\]/, /\(y\/n\)/i, /\(yes\/no\)/i,
  /Yes\s*\/\s*No/i,
  /Allow\s*(once|always)/i, /Approve\??/i, /Deny/i,
  /Do you want to proceed/i, /Do you want to/i, /Press Enter/i,
  /^\s*[1-9]\.\s+\S/m, /^\s*[1-9]\)\s+\S/m,
];
const PUSH_IDLE_MS = 6000;
const PUSH_MIN_CHARS = 80;
const PUSH_COOLDOWN = 8000;

// Per-session server-side monitor state
const pushMonitors = new Map();

function pushStripAnsi(str) {
  return str.replace(PUSH_ANSI_RE, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function pushMatchesWaiting(text) {
  for (const pat of PUSH_WAITING_PATTERNS) {
    if (pat.test(text)) return true;
  }
  return false;
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

/**
 * Called from ptyProcess.onData to detect notification patterns server-side.
 * Triggers web push when a session completes or waits for user action.
 */
function pushOnOutput(sessionId, rawData) {
  if (pushSubscriptions.size === 0 && !BARK_URL && !WEBHOOK_URL) return; // no channels configured

  const mon = initPushMonitor(sessionId);
  const text = pushStripAnsi(rawData);
  const printable = text.replace(/\s+/g, '');

  mon.recentText += text;
  if (mon.recentText.length > 3000) mon.recentText = mon.recentText.slice(-2000);

  if (printable.length > 0) {
    mon.chars += printable.length;
    if (mon.state === 'idle') mon.state = 'active';
  }

  // Immediate pattern check
  if (mon.state === 'active' && pushMatchesWaiting(text)) {
    mon.state = 'waiting';
    triggerPush(sessionId, 'waiting', '等待操作');
  }

  // Idle timer
  if (mon.idleTimer) clearTimeout(mon.idleTimer);
  mon.idleTimer = setTimeout(() => {
    if (mon.state === 'active' && mon.chars >= PUSH_MIN_CHARS) {
      const tail = mon.recentText.slice(-2000);
      if (pushMatchesWaiting(tail)) {
        triggerPush(sessionId, 'waiting', '等待操作');
      } else {
        triggerPush(sessionId, 'completed', '任务已完成');
      }
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
  const mon = pushMonitors.get(sessionId);
  if (!mon) return;

  const now = Date.now();
  if (now - mon.lastPushTime < PUSH_COOLDOWN) return; // cooldown
  mon.lastPushTime = now;

  const session = sessions.get(sessionId);
  const cwd = session ? session.cwd : '';
  const shortCwd = cwd.length > 30 ? '...' + cwd.slice(-27) : cwd;

  const payload = {
    title: type === 'waiting' ? `MultiCC #${sessionId}: 等待操作` : `MultiCC #${sessionId}: 完成`,
    body: `${message}\n${shortCwd}`,
    sessionId,
    type,
    tag: `multicc-${sessionId}`,
    url: `/manage`,
  };

  pushGlobalStats.lastPushTime = now;
  pushGlobalStats.lastPushType = type;
  pushGlobalStats.lastPushSessionId = sessionId;

  // Send to all channels in parallel
  sendPushToAll(payload);
  sendBarkNotification(payload.title, `${message} ${shortCwd}`, payload.url);
  sendWebhookNotification(payload);

  console.log(`[multicc/push] Sent ${type} notification for session ${sessionId}`);
}

// ── AuxQueue: stateless claude -p AI service (intent classification, etc.) ──
const AUX_SESSION_ID = '__aux__';
const AUX_TIMEOUT_MS = 30000;
const AUX_HISTORY_MAX = 200;

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
    // Pre-warm a claude process so first task has no cold-start
    this.prespawn();
    console.log('[multicc/aux] AuxQueue initialized (with process pre-warming)');
  },

  /** Spawn a warm claude -p process that blocks on stdin, ready for instant use */
  prespawn() {
    if (this._warmProc) return; // already warming
    try {
      // AuxQueue runs single-turn, stateless tasks (intent classify, voice refine) —
      // Haiku is plenty and ~30× cheaper than the user's default Opus.
      const proc = spawn(CLAUDE_CMD, ['-p', '--model', 'haiku', '--output-format', 'stream-json', '--max-turns', '1', '--verbose'], {
        cwd: __dirname,
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],  // stdin open — process blocks waiting for input
      });
      proc.on('error', () => { this._warmProc = null; this._warmReady = false; });
      proc.on('exit', () => {
        // If it exits before we used it (crash during init), clear it
        if (this._warmProc === proc) { this._warmProc = null; this._warmReady = false; }
      });
      this._warmProc = proc;
      this._warmReady = true;
      console.log(`[multicc/aux] Pre-warmed claude process (pid ${proc.pid})`);
    } catch (err) {
      console.error('[multicc/aux] Failed to pre-warm:', err.message);
      this._warmProc = null;
      this._warmReady = false;
    }
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
      let proc;
      let usedWarm = false;

      // Try to use pre-warmed process (stdin still open, waiting for input)
      if (this._warmProc && this._warmReady) {
        proc = this._warmProc;
        usedWarm = true;
        this._warmProc = null;
        this._warmReady = false;
        console.log(`[multicc/aux] Using pre-warmed process (pid ${proc.pid})`);
        // Feed the prompt via stdin and close it to trigger processing
        proc.stdin.write(task.prompt);
        proc.stdin.end();
      } else {
        // Fallback: cold spawn with prompt as CLI argument
        console.log('[multicc/aux] No warm process available, cold spawning');
        proc = spawn(CLAUDE_CMD, ['-p', '--model', 'haiku', '--output-format', 'stream-json', '--max-turns', '1', '--verbose', task.prompt], {
          cwd: __dirname,
          env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }

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

// ── WeChat Bridge ──
wechatBridge.init(sessions, persistedSessions, tmuxWriteInput);
app.use('/api/wechat', wechatBridge.router);

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
    res.json({ exists: true, mtime: stat.mtime.toISOString(), size: stat.size });
  } catch {
    res.json({ exists: false });
  }
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
const CHAT_HISTORY_DIR = path.join(__dirname, 'chat_history');
try { fs.mkdirSync(CHAT_HISTORY_DIR, { recursive: true }); } catch (_) {}
const MAX_CHAT_MESSAGES = 50;  // keep last N messages per session

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
    chatHistories.set(sessionName, data);
    return data;
  } catch (_) {
    const arr = [];
    chatHistories.set(sessionName, arr);
    return arr;
  }
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

function appendChatMessage(sessionName, msg) {
  const history = loadChatHistory(sessionName);
  history.push(msg);
  const limit = sessionName === AUX_SESSION_ID ? AUX_HISTORY_MAX : MAX_CHAT_MESSAGES;
  while (history.length > limit) history.shift();
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

// ── Workspace status board ──
// Per-session live status (runtime only, never persisted). Broadcast to /ws/workspace
// subscribers grouped by directory so every agent in a directory can see the others.
// status ∈ idle | thinking | editing | running | waiting
const workspaceStatus = new Map();   // sessionId → { status, currentFile, lastActivity }
const workspaceClients = new Map();  // dirId → Set<ws>

function workspaceBroadcast(dirId, payload) {
  const set = workspaceClients.get(dirId);
  if (!set) return;
  const json = JSON.stringify(payload);
  for (const wsc of set) {
    if (wsc.readyState === WebSocket.OPEN) { try { wsc.send(json); } catch (_) {} }
  }
}

// Update a session's live status and push the delta to workspace subscribers.
function setSessionStatus(sessionId, patch) {
  const persisted = persistedSessions.get(sessionId);
  if (!persisted || persisted.type === 'aux') return;
  const prev = workspaceStatus.get(sessionId) || { status: 'idle', currentFile: null, lastActivity: 0 };
  const next = {
    status: patch.status !== undefined ? patch.status : prev.status,
    currentFile: patch.currentFile !== undefined ? patch.currentFile : prev.currentFile,
    lastActivity: Date.now(),
  };
  workspaceStatus.set(sessionId, next);
  // Only broadcast when the status or current file actually changed — callers may
  // fire this on every output chunk / text delta.
  if (next.status === prev.status && next.currentFile === prev.currentFile) return;
  workspaceBroadcast(persisted.dirId, {
    type: 'status', sessionId,
    status: next.status, currentFile: next.currentFile, lastActivity: next.lastActivity,
  });
}

function workspaceSnapshot(dirId) {
  const out = [];
  for (const s of persistedSessions.values()) {
    if (s.dirId !== dirId || s.type === 'aux') continue;
    const st = workspaceStatus.get(s.id) || { status: 'idle', currentFile: null, lastActivity: 0 };
    const active = sessions.get(s.id);
    const chat = chatSessions.get(s.id);
    out.push({
      id: s.id, label: s.label || null, cli: s.cli || 'claude', kind: s.kind || 'terminal',
      branch: s.branch || null, invalid: invalidSessions.get(s.id) || null,
      status: st.status, currentFile: st.currentFile, lastActivity: st.lastActivity,
      clients: s.kind === 'chat' ? (chat?.clients.size || 0) : (active?.clients.size || 0),
      pendingNotes: pendingNotesFor(s.id).length,
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

  const text = cs.currentAssistantText;
  if (!text || text.length < 20) return;

  const tail = text.slice(-1500);
  const sessionId = persistedSessions.get(sessionName)?.id || sessionName;

  cs.pendingClassifyTimer = setTimeout(() => {
    cs.pendingClassifyTimer = null;
    const taskId = crypto.randomUUID();
    cs.pendingClassifyTaskId = taskId;

    auxQueue.enqueue({
      id: taskId,
      type: 'intent_classify',
      prompt: `你是一个意图分类器。判断以下 AI 助手回复的结尾状态，只回复一个字母：
C — 任务已完成，不需要用户操作
W — 正在等待用户回复或决策

回复内容：
${tail}`,
      meta: { sessionName, sessionId },
    }).then(result => {
      cs.pendingClassifyTaskId = null;
      if (result.cancelled) return;
      const state = result.text.trim().toUpperCase().startsWith('W') ? 'waiting' : 'completed';
      const msg = state === 'waiting' ? '等待操作' : '任务已完成';
      triggerPush(sessionId, state, `[Chat] ${msg}`);
      // Reflect on the status board — but only if no new turn has started since.
      if (!cs.isStreaming) {
        setSessionStatus(sessionName, { status: state === 'waiting' ? 'waiting' : 'idle' });
      }
      console.log(`[multicc/aux] Intent classify for ${sessionName}: ${state}`);
    }).catch(() => {
      cs.pendingClassifyTaskId = null;
    });
  }, CLASSIFY_DELAY_MS);
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
    };
    chatSessions.set(sessionName, cs);
  }

  cs.clients.add(ws);

  ws.send(JSON.stringify({
    type: 'system', subtype: 'init',
    cwd: cs.cwd, session: sessionName, session_id: sessionName,
    cli: cs.cli,
    is_streaming: cs.isStreaming,
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
  if (replayMessages.length > 0) {
    ws.send(JSON.stringify({ type: 'chat_history', messages: replayMessages }));
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
      // Typing signal: user is composing → cancel pending intent classify
      if (msg.type === 'typing') {
        cancelPendingClassify(cs);
        return;
      }

      if (msg.type === 'cancel') {
        cancelPendingClassify(cs);
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
        if (h) h.length = 0;
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
        cancelPendingClassify(cs);
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
        }

        // Save user message to history
        appendChatMessage(sessionName, {
          role: 'user', content: msg.text, ts: Date.now(),
        });

        // Reset accumulators
        cs.currentAssistantText = '';
        cs.currentToolCalls = [];
        cs.currentCost = null;
        cs.isStreaming = true;
        cs.streamReplay = [];
        cs._resultSaved = false;
        setSessionStatus(sessionName, { status: 'thinking', currentFile: null });

        const provider = cliProviders[cs.cli] || cliProviders.claude;
        // For claude: first turn → --session-id <uuid>, subsequent → --resume <uuid>.
        // For codex:  first turn → exec --json, subsequent → exec resume <id> --json.
        const isFirstTurn = cs.chatTurnCount === 0 || !persisted.cliSessionId;

        // Passive inter-agent notes: prepend any pending notes addressed to this
        // session onto the prompt, then mark them delivered.
        let promptText = msg.text;
        const pendingNotes = pendingNotesFor(sessionName).slice(0, 10);
        if (pendingNotes.length) {
          let block = '[multicc 跨 agent 留言 — 来自同目录下的其他 agent]\n';
          for (const n of pendingNotes) block += `- 来自「${n.fromLabel}」：${n.body}\n`;
          block += '[留言结束]\n\n';
          if (block.length > 4000) block = block.slice(0, 4000) + '\n…(截断)\n\n';
          promptText = block + msg.text;
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

        const args = provider.buildChatSpawnArgs(persisted, promptText, { isFirstTurn });
        console.log(`[multicc/chat] Spawning ${cs.cli} (turn ${cs.chatTurnCount}, first=${isFirstTurn}): ${provider.cmd} ${args.join(' ').slice(0, 200)}...`);

        const spawnChat = (spawnArgs, isRetry) => {
          const proc = spawn(provider.cmd, spawnArgs, {
            cwd: cs.cwd,
            env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
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
                  cs.chatTurnCount++;
                  cs._resultSaved = true;
                }
                forward({ type: 'result', total_cost_usd: null, usage });
                setSessionStatus(sessionName, { status: 'idle', currentFile: null });
                scheduleIntentClassify(cs, sessionName);
                return;
              }
              return;  // unknown event type: drop
            }

            // ── Claude: unchanged path ──
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
              if (cs.currentAssistantText || cs.currentToolCalls.length) {
                appendChatMessage(sessionName, {
                  role: 'assistant', content: cs.currentAssistantText,
                  tools: cs.currentToolCalls.length ? cs.currentToolCalls : undefined,
                  cost: cs.currentCost, ts: Date.now(),
                });
                cs.chatTurnCount++;
                cs._resultSaved = true;
              }
              setSessionStatus(sessionName, { status: 'idle', currentFile: null });
              scheduleIntentClassify(cs, sessionName);
            }
            // Drop claude's `system init` — server already sent its own
            if (evt.type === 'system' && evt.subtype === 'init') return;
            forward(evt);
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
            if (!isRetry && !cs.currentAssistantText && !killReason) {
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
              const fallbackArgs = provider.buildChatSpawnArgs(persisted, promptText, { isFirstTurn: true });
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
            cs.currentAssistantText = '';
            cs.currentToolCalls = [];
            cs._resultSaved = false;

            setSessionStatus(sessionName, { status: 'idle', currentFile: null });
            chatBroadcast(sessionName, { type: 'stream_end' });
          });

          return proc;
        };

        cs.claudeProc = spawnChat(args, false);
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

  // Auth check for WebSocket (cookie, token param, or localhost)
  if (ACCESS_TOKEN) {
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
    return handleChatWs(ws, req, urlObj);
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

server.listen(PORT, () => {
  console.log(`\n  MultiCC is running at http://localhost:${PORT}\n`);
  console.log(`  Manage sessions at http://localhost:${PORT}/manage\n`);
  console.log(`  Use Tailscale / ngrok for HTTPS access from external devices.\n`);
});
