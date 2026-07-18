'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');

const TMUX_PREFIX = 'multicc-';
const TMUX_FIFO_DIR = path.join(os.tmpdir(), 'multicc-fifos');
const TMUX_TIMEOUT_MS = 5000;
const fifoDirReady = fsp.mkdir(TMUX_FIFO_DIR, { recursive: true, mode: 0o700 })
  .then(() => fsp.chmod(TMUX_FIFO_DIR, 0o700))
  .catch(() => {});

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: options.encoding || 'utf8',
      timeout: options.timeout || TMUX_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
      env: { ...process.env, ...(options.env || {}) },
    }, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error); }
      else resolve(String(stdout || ''));
    });
  });
}

function tmuxSessionName(id) { return `${TMUX_PREFIX}${id}`; }

async function tmuxListSessions() {
  try {
    return (await run('tmux', ['list-sessions', '-F', '#{session_name}'])).trim().split(/\r?\n/).filter(Boolean);
  } catch (_) { return []; }
}

async function tmuxHasSession(id) {
  try { await run('tmux', ['has-session', '-t', tmuxSessionName(id)]); return true; }
  catch (_) { return false; }
}

async function tmuxCreateSession(id, cwd, cols, rows, cmd, envExtra) {
  const args = ['new-session', '-d', '-s', tmuxSessionName(id)];
  if (envExtra && typeof envExtra === 'object') {
    for (const [key, value] of Object.entries(envExtra)) {
      if (value != null) args.push('-e', `${key}=${String(value)}`);
    }
  }
  args.push('-x', String(cols), '-y', String(rows), '-c', cwd, cmd);
  await run('tmux', args, { env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
}

async function tmuxResize(id, cols, rows) {
  try { await run('tmux', ['resize-window', '-t', tmuxSessionName(id), '-x', String(cols), '-y', String(rows)]); return true; }
  catch (_) { return false; }
}

async function applyMaxClientSize(session) {
  let maxCols = 0;
  let maxRows = 0;
  for (const client of session.clients) {
    if (client._desiredCols > maxCols) maxCols = client._desiredCols;
    if (client._desiredRows > maxRows) maxRows = client._desiredRows;
  }
  if (!maxCols || !maxRows) return false;
  if (maxCols === session.appliedCols && maxRows === session.appliedRows) return false;
  const resized = await tmuxResize(session.id, maxCols, maxRows);
  if (resized) {
    session.appliedCols = maxCols;
    session.appliedRows = maxRows;
  }
  return resized;
}

async function tmuxKillSession(id) {
  try { await run('tmux', ['kill-session', '-t', tmuxSessionName(id)]); return true; }
  catch (_) { return false; }
}

async function tmuxCapturePane(id) {
  try { return await run('tmux', ['capture-pane', '-t', tmuxSessionName(id), '-p', '-S', '-500']); }
  catch (_) { return ''; }
}

async function tmuxPaneTty(id) {
  return (await run('tmux', ['display-message', '-t', tmuxSessionName(id), '-p', '#{pane_tty}'])).trim();
}

async function tmuxPaneCwd(id) {
  try { return (await run('tmux', ['display-message', '-t', tmuxSessionName(id), '-p', '#{pane_current_path}'])).trim(); }
  catch (_) { return os.homedir(); }
}

async function tmuxWriteInput(id, data) {
  if (!data) return false;
  try { await run('tmux', ['send-keys', '-t', tmuxSessionName(id), '-l', '--', data]); return true; }
  catch (error) { console.error('[multicc] tmuxWriteInput error:', error.message); return false; }
}

function fifoPathForSession(id) { return path.join(TMUX_FIFO_DIR, `${id}.fifo`); }

function openFifo(fifoPath) {
  return new Promise((resolve, reject) => {
    fs.open(fifoPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK, (error, fd) => {
      if (error) reject(error);
      else resolve(fd);
    });
  });
}

async function startOutputCapture(id) {
  const fifoPath = fifoPathForSession(id);
  await fifoDirReady;
  await fsp.unlink(fifoPath).catch(() => {});
  await run('mkfifo', [fifoPath]);
  await fsp.chmod(fifoPath, 0o600);
  await run('tmux', ['pipe-pane', '-t', tmuxSessionName(id), `cat > '${fifoPath.replace(/'/g, `'\\''`)}'`]);
  const fd = await openFifo(fifoPath);
  const stream = new net.Socket({ fd, readable: true, writable: false });
  return { stream, fifoPath };
}

async function stopOutputCapture(session) {
  if (session.outputStream) {
    try { session.outputStream.destroy(); } catch (_) {}
    session.outputStream = null;
  }
  if (session.fifoPath) {
    try { await run('tmux', ['pipe-pane', '-t', tmuxSessionName(session.id)]); } catch (_) {}
    await fsp.unlink(session.fifoPath).catch(() => {});
    session.fifoPath = null;
  }
}

module.exports = {
  TMUX_PREFIX,
  tmuxSessionName,
  tmuxListSessions,
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
