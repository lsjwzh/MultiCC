'use strict';

// Terminal turn-ledger runtime (status plan v4, step 2 — SHADOW MODE).
//
// Wires hook injection into terminal launches, ingests the hook spool into the
// TurnLedger and exposes read-only diagnostics. It deliberately does not feed
// classify, push or task boards yet: the ledger runs beside the existing
// pipeline until its verdicts have been compared against real sessions.
//
// The diagnostics routes themselves now belong to the Rust front door
// (native/gateway/src/app/turn_ledger.rs); this runtime only answers its host
// port through `launch`, `record` and `trust`.
//
// Delivery is file-only. The hook writes one 0600 file per event under
// <dataDir>/turn-hooks/spool/<sessionId>/; this runtime ingests in name order
// (timestamp-prefixed), dedupes by eventId inside the ledger and deletes the
// file. Events written while the server is down are replayed on start.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeEnvelope } = require('./contract');
const { createTurnLedger } = require('./ledger');
const { createTurnEndEvidence } = require('./evidence');
const { createHookInstaller } = require('./hook-install');

const HOOKED_CLIS = new Set(['claude', 'codex']);
const SID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function createTurnLedgerRuntime(deps = {}) {
  const {
    dataDir,
    logger = console,
    installer = createHookInstaller({ codexCmd: deps.codexCmd || 'codex' }),
    nodePath = process.execPath,
    sweepIntervalMs = 2000,
    ledgerOptions = {},
  } = deps;
  if (!dataDir) throw new TypeError('[turn-ledger] dataDir is required');

  const root = path.join(dataDir, 'turn-hooks');
  const spoolDir = path.join(root, 'spool');
  const settingsDir = path.join(root, 'settings');
  const stateFile = path.join(root, 'sessions.json');

  const ledger = createTurnLedger({
    confirmTurnEnd: createTurnEndEvidence({ fs }),
    onTransition: t => logger.log?.(`[turn-ledger/shadow] ${t.sessionId} ${t.from || '-'}→${t.to} (${t.evidence}${t.reason ? `/${t.reason}` : ''}) ${t.transitionId}`),
    logger,
    ...ledgerOptions,
  });

  // sessionId -> { epoch, cli, codexHome, cwd, launchedAt }
  let launches = {};
  try { launches = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch (_) {}

  function saveLaunches() {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(launches), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  }

  // Called only for a fresh tmux launch (not on attach/recovery, which keeps
  // the running CLI and its epoch). Never throws: hooks are an observer, a
  // failure here must not block opening a terminal.
  function prepareTerminal(session, termEnv) {
    const sid = session && session.id;
    if (!sid || !SID_RE.test(sid) || !HOOKED_CLIS.has(session.cli) || !termEnv) return session;
    try {
      installer.install();
      const prev = launches[sid];
      const epoch = (prev?.epoch || 0) + 1;
      const codexHome = termEnv.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
      launches[sid] = {
        epoch, cli: session.cli, launchedAt: Date.now(),
        cwd: session.worktreePath || session.cwd || null,
        ...(session.cli === 'codex' ? { codexHome } : {}),
      };
      saveLaunches();
      fs.mkdirSync(path.join(spoolDir, sid), { recursive: true, mode: 0o700 });
      Object.assign(termEnv, {
        MULTICC_TURN_HOOK_SPOOL: spoolDir,
        MULTICC_TURN_HOOK_SESSION: sid,
        MULTICC_TURN_HOOK_EPOCH: String(epoch),
        MULTICC_TURN_HOOK_CLI: session.cli,
        MULTICC_TURN_HOOK_NODE: nodePath,
      });
      if (session.cli === 'claude') {
        fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
        const file = path.join(settingsDir, `${sid}.json`);
        const extra = String(session.effort || '').trim().toLowerCase() === 'ultracode' ? { ultracode: true } : {};
        fs.writeFileSync(file, JSON.stringify(installer.claudeSettings(extra)), { mode: 0o600 });
        return { ...session, turnHookSettingsArg: shellQuote(file) };
      }
      return { ...session, turnHookConfigArgs: installer.codexConfigArgs() };
    } catch (e) {
      logger.warn?.(`[turn-ledger] hook setup skipped for ${sid}: ${e.message}`);
      return session;
    }
  }

  function ingestFile(sid, name) {
    const file = path.join(spoolDir, sid, name);
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
    const env = normalizeEnvelope(raw);
    if (env && env.sessionId === sid) ledger.apply(env);
    else logger.warn?.(`[turn-ledger] dropped malformed spool record ${sid}/${name}`);
    try { fs.unlinkSync(file); } catch (_) {}
  }

  let sweeping = false;
  function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      let sids = [];
      try { sids = fs.readdirSync(spoolDir); } catch (_) { return; }
      for (const sid of sids) {
        if (!SID_RE.test(sid)) continue;
        let names = [];
        try { names = fs.readdirSync(path.join(spoolDir, sid)); } catch (_) { continue; }
        for (const name of names.filter(n => n.endsWith('.json') && !n.startsWith('.')).sort()) {
          ingestFile(sid, name);
        }
      }
      ledger.tick();
    } finally { sweeping = false; }
  }

  let watcher = null;
  let interval = null;
  let debounce = null;
  function start() {
    try { fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 }); } catch (_) {}
    sweep();
    try {
      watcher = fs.watch(spoolDir, { recursive: true }, () => {
        if (debounce) return;
        debounce = setTimeout(() => { debounce = null; sweep(); }, 25);
        debounce.unref?.();
      });
      watcher.on('error', () => {});
      watcher.unref?.();
    } catch (_) { watcher = null; }  // interval sweep below still delivers
    interval = setInterval(sweep, sweepIntervalMs);
    interval.unref?.();
    return api;
  }

  function stop() {
    try { watcher?.close(); } catch (_) {}
    clearInterval(interval);
    clearTimeout(debounce);
  }

  // Raw material for the host port (src/routes/turn-ledger-host.js). The Rust
  // front door owns the diagnostics routes, including the `SID_RE` gate, the
  // 409 for a session that is not a launched Codex terminal and the snapshot
  // DTO; these three accessors are all it can ask Node for.
  function launch(sid) {
    return launches[sid] || null;
  }

  function record(sid) {
    return ledger.record(sid);
  }

  // `write: false` reads the current trust state; `true` is an explicit user
  // action (a UI button) that writes hook trust into that terminal's CODEX_HOME
  // through Codex's own config API.
  function trust({ write, codexHome, cwd }) {
    const target = { codexHome, cwd };
    return write ? installer.codexGrantTrust(target) : installer.codexTrustStatus(target);
  }

  const api = {
    prepareTerminal, sweep, start, stop, launch, record, trust,
    snapshot: sid => ledger.snapshot(sid),
    ownership: sid => ledger.ownership(sid),
    ledger,
  };
  return api;
}

module.exports = { createTurnLedgerRuntime, shellQuote };
