'use strict';

// ── Detached task launcher: run long jobs that outlive the chat turn ──
//
// Problem: when a chat-spawned agent runs a long command with a bare `&` /
// nohup, that process is a child of the agent's transient shell. When the turn
// ends, the shell (and its children) get reaped — the build dies mid-flight,
// never writes a completion marker, and the session is never resumed. It looks
// like "it just hung".
//
// Fix: launch the command from the SERVER process with `detached: true` (setsid
// → new session leader). The job is then owned by neither the agent's shell nor
// the server's lifetime — it survives the turn ending AND a server restart.
// Output streams to a log file; a shell wrapper writes a `done` file with the
// real exit code when the command finishes. That `done` file is the completion
// signal the existing poll-wait machinery keys off of (see wait-injector.js),
// so on completion the exit code + output tail are injected back into the
// session and the agent continues automatically.
//
// This module only LAUNCHES and exposes the poll command; it deliberately does
// NOT own a process pool or supervisor — the durable state lives on disk under
// ~/.multicc/detached/<id>/, which is what makes restart-recovery free.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const BASE_DIR = path.join(os.homedir(), '.multicc', 'detached');
const DONE_MARKER = '__MULTICC_DETACHED_DONE__';

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} }
function genId() { return 'd_' + crypto.randomBytes(5).toString('hex'); }

// POSIX single-quote a string for safe interpolation into a /bin/sh command.
function shq(s) { return `'` + String(s).replace(/'/g, `'"'"'`) + `'`; }

function jobDir(id) { return path.join(BASE_DIR, id); }
function jobPaths(id) {
  const dir = jobDir(id);
  return { dir, logPath: path.join(dir, 'output.log'), donePath: path.join(dir, 'done'), metaPath: path.join(dir, 'meta.json') };
}

// The poll command the wait-injector runs on its interval. Emits nothing until
// the done-file exists; once it does, prints the done marker (so the wait
// matches) followed by a tail of the captured output.
function buildPollCmd(logPath, donePath) {
  return `if [ -f ${shq(donePath)} ]; then cat ${shq(donePath)}; echo '----- output tail -----'; tail -c 3000 ${shq(logPath)} 2>/dev/null; fi`;
}

// Launch `command` detached. Returns { id, dir, logPath, donePath, pollCmd,
// doneMarker, pid }. `cwd` defaults to the user's home dir.
function launch({ command, cwd, label } = {}) {
  const cmd = (command == null ? '' : String(command)).trim();
  if (!cmd) throw new Error('command required');

  const id = genId();
  const { dir, logPath, donePath, metaPath } = jobPaths(id);
  ensureDir(dir);
  const workdir = cwd || os.homedir();

  try {
    fs.writeFileSync(metaPath, JSON.stringify(
      { id, label: label || null, command: cmd, cwd: workdir, startedAt: Date.now() }, null, 2));
  } catch (_) {}

  // Run the command, capture its real exit code, then write the done-file. The
  // command's stdout/stderr are routed to the log via stdio below; the printf
  // is explicitly redirected to the done-file so it doesn't pollute the log.
  // The command runs in a SUBSHELL `( … )` so a stray `exit N` inside it only
  // exits the subshell — the wrapper still records the code and writes the
  // done-file (without the subshell, `exit` would kill the whole script and the
  // job would never report completion).
  const wrapper =
    `(\n${cmd}\n)\n` +
    `__mc_code=$?\n` +
    `printf '%s exit=%s\\n' ${shq(DONE_MARKER)} "$__mc_code" > ${shq(donePath)}\n`;

  const fd = fs.openSync(logPath, 'a');
  let child;
  try {
    child = spawn('/bin/sh', ['-c', wrapper], {
      cwd: workdir,
      detached: true,          // setsid: new session, survives parent death
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
  child.unref();               // don't keep the server event loop alive for it

  return { id, dir, logPath, donePath, metaPath, pollCmd: buildPollCmd(logPath, donePath), doneMarker: DONE_MARKER, pid: child.pid };
}

// Read a job's current state from disk (survives restart).
function status(id) {
  const { logPath, donePath, metaPath } = jobPaths(id);
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
  if (!meta) return null;
  let done = null, exitCode = null;
  try {
    const d = fs.readFileSync(donePath, 'utf8');
    done = d.includes(DONE_MARKER);
    const m = d.match(/exit=(-?\d+)/);
    if (m) exitCode = Number(m[1]);
  } catch (_) { done = false; }
  let logTail = '';
  try { const s = fs.readFileSync(logPath, 'utf8'); logTail = s.slice(-3000); } catch (_) {}
  return { id, label: meta.label, command: meta.command, cwd: meta.cwd, startedAt: meta.startedAt, running: !done, done: !!done, exitCode, logPath, logTail };
}

// List jobs newest-first.
function list(limit = 50) {
  let ids = [];
  try { ids = fs.readdirSync(BASE_DIR).filter(n => n.startsWith('d_')); } catch (_) { return []; }
  return ids.map(status).filter(Boolean)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, limit)
    .map(({ logTail, ...rest }) => rest); // omit tail in list view
}

module.exports = { launch, status, list, buildPollCmd, BASE_DIR, DONE_MARKER };
