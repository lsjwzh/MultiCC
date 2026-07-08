// tmux session + terminal-output-capture primitives. Pure operations keyed by
// session id (or a passed-in session/cmd) — no global state. server.js imports
// by destructuring, so existing call sites are unchanged, and keeps the
// stateful recoverTmuxSessions() (it rebuilds core session state on startup).
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const TMUX_PREFIX = 'multicc-';
const TMUX_FIFO_DIR = path.join(os.tmpdir(), 'multicc-fifos');
try { fs.mkdirSync(TMUX_FIFO_DIR, { recursive: true }); } catch (_) {}

// Every call below runs tmux/mkfifo synchronously via execSync/execFileSync,
// which blocks the whole Node event loop for its full duration. tmux is a local
// op that should return in milliseconds, but a wedged tmux server (stuck pane,
// socket contention, a blocked client) would otherwise hang forever and freeze
// the entire multicc server — same failure mode as the unbounded git calls.
// This ceiling guarantees the loop always gets unblocked. Spread into every
// exec below (SIGKILL so the timeout actually kills a hung tmux child).
const TMUX_TIMEOUT_MS = 5000;
const TMUX_EXEC_OPTS = { timeout: TMUX_TIMEOUT_MS, killSignal: 'SIGKILL' };

function tmuxSessionName(id) { return `${TMUX_PREFIX}${id}`; }

function tmuxHasSession(id) {
  try {
    execSync(`tmux has-session -t ${tmuxSessionName(id)} 2>/dev/null`, TMUX_EXEC_OPTS);
    return true;
  } catch { return false; }
}

// `cmd` is the provider's terminal command, resolved by the caller (keeps this
// module free of the provider/core domain).
function tmuxCreateSession(id, cwd, cols, rows, cmd, envExtra) {
  const name = tmuxSessionName(id);
  // Per-session env (cc-switch provider override: ANTHROPIC_* / CODEX_HOME) is
  // injected via `-e` so it lands in the pane's process. tmux panes otherwise
  // inherit the tmux *server's* global env (captured when the server first
  // started), NOT the env of this new-session call — so the {env:...} below
  // can't carry it. Values are single-quoted (tokens/paths may contain spaces).
  let eArgs = '';
  if (envExtra && typeof envExtra === 'object') {
    for (const [k, v] of Object.entries(envExtra)) {
      if (v == null) continue;
      const safeV = String(v).replace(/'/g, `'\\''`);
      eArgs += ` -e ${k}='${safeV}'`;
    }
  }
  // set-option remain-on-exit off so the session disappears when CLI exits
  execSync(
    `tmux new-session -d -s "${name}"${eArgs} -x ${cols} -y ${rows} -c "${cwd}" "${cmd}"`,
    { ...TMUX_EXEC_OPTS, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } }
  );
}

function tmuxResize(id, cols, rows) {
  try {
    execSync(`tmux resize-window -t "${tmuxSessionName(id)}" -x ${cols} -y ${rows} 2>/dev/null`, TMUX_EXEC_OPTS);
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
  try { execSync(`tmux kill-session -t "${tmuxSessionName(id)}" 2>/dev/null`, TMUX_EXEC_OPTS); } catch (_) {}
}

function tmuxCapturePane(id) {
  try {
    return execSync(`tmux capture-pane -t "${tmuxSessionName(id)}" -p -S -500 2>/dev/null`, { ...TMUX_EXEC_OPTS, encoding: 'utf8' });
  } catch { return ''; }
}

function tmuxPaneTty(id) {
  return execSync(`tmux display-message -t "${tmuxSessionName(id)}" -p "#{pane_tty}"`, { ...TMUX_EXEC_OPTS, encoding: 'utf8' }).trim();
}

function tmuxPaneCwd(id) {
  try {
    return execSync(`tmux display-message -t "${tmuxSessionName(id)}" -p "#{pane_current_path}"`, { ...TMUX_EXEC_OPTS, encoding: 'utf8' }).trim();
  } catch { return os.homedir(); }
}

function tmuxWriteInput(id, data) {
  if (!data) return;
  try {
    execFileSync('tmux', ['send-keys', '-t', tmuxSessionName(id), '-l', '--', data], TMUX_EXEC_OPTS);
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
  execSync(`mkfifo "${fifoPath}"`, TMUX_EXEC_OPTS);

  // Tell tmux to pipe pane output into our FIFO (no -o: always replace existing pipe)
  execSync(`tmux pipe-pane -t "${tmuxSessionName(id)}" "cat > '${fifoPath}'"`, TMUX_EXEC_OPTS);

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
    try { execSync(`tmux pipe-pane -t "${tmuxSessionName(session.id)}" 2>/dev/null`, TMUX_EXEC_OPTS); } catch (_) {}
    try { fs.unlinkSync(session.fifoPath); } catch (_) {}
    session.fifoPath = null;
  }
}

module.exports = {
  TMUX_PREFIX,
  tmuxSessionName,
  tmuxHasSession,
  tmuxCreateSession,
  tmuxResize,
  applyMaxClientSize,
  tmuxKillSession,
  tmuxCapturePane,
  tmuxPaneTty,
  tmuxPaneCwd,
  tmuxWriteInput,
  fifoPathForSession,
  startOutputCapture,
  stopOutputCapture,
};
