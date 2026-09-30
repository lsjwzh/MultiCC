'use strict';

// Hook wiring for terminal-mode Claude/Codex (status plan v4 §2).
//
// Codex trusts a non-managed hook by the sha256 of its *config* (command,
// timeout, async, matcher…), keyed like "/<session-flags>/config.toml:stop:0:0"
// for hooks injected with `-c`. Measured on 0.156.1:
// - an untrusted hook is skipped silently — no warning, no event;
// - trust passed back in through `-c hooks.state…` is ignored (flags cannot
//   trust themselves), trust persisted in $CODEX_HOME/config.toml is honoured;
// - `codex app-server` exposes `hooks/list` (key, currentHash, trustStatus) and
//   `config/batchWrite`, the same pair the TUI's /hooks screen uses.
// So the command string is fixed forever (a wrapper at a stable path), and
// trust is granted through Codex's own API after the user asks for it — the
// hash is never computed or guessed here. `--dangerously-bypass-hook-trust`
// is deliberately unused: it would also run every other hook the user has.

const os = require('os');
const path = require('path');

const WRAPPER_NAME = 'multicc-turn-hook';
const SCRIPT_NAME = 'multicc-turn-hook.js';
const SCRIPT_SOURCE = path.join(__dirname, '..', '..', 'scripts', SCRIPT_NAME);
const HOOK_TIMEOUT_SEC = 10;

const WRAPPER_SOURCE = [
  '#!/bin/sh',
  '# multicc terminal turn hook — installed by multicc; see scripts/multicc-turn-hook.js',
  '[ -n "$MULTICC_TURN_HOOK_SPOOL" ] || exit 0',
  'exec "${MULTICC_TURN_HOOK_NODE:-node}" "$(dirname "$0")/multicc-turn-hook.js" 2>/dev/null || exit 0',
  '',
].join('\n');

const CLAUDE_EVENTS = [
  ['SessionStart'], ['UserPromptSubmit'],
  ['PreToolUse', 'AskUserQuestion|ExitPlanMode'],
  ['PostToolUse'],
  ['Notification', 'permission_prompt|elicitation_dialog'],
  ['Stop'], ['StopFailure'], ['SessionEnd'],
];
const CODEX_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse',
  'Stop', 'Interrupt', 'SessionEnd',
];

function defaultBinDir() {
  return path.join(os.homedir(), '.multicc', 'bin');
}

function createHookInstaller(deps = {}) {
  const {
    fs = require('fs'),
    binDir = defaultBinDir(),
    spawn = require('child_process').spawn,
    codexCmd = 'codex',  // string or () => string (resolved lazily)
    rpcTimeoutMs = 15000,
  } = deps;
  const wrapperPath = path.join(binDir, WRAPPER_NAME);

  function writeIfChanged(file, content, mode) {
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch (_) {}
    if (current !== content) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, content, { mode });
      fs.renameSync(tmp, file);
    }
    fs.chmodSync(file, mode);
  }

  // Idempotent; cheap enough to run on every terminal launch so an upgrade
  // refreshes the script while the trusted command string stays identical.
  function install() {
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    writeIfChanged(path.join(binDir, SCRIPT_NAME), fs.readFileSync(SCRIPT_SOURCE, 'utf8'), 0o755);
    writeIfChanged(wrapperPath, WRAPPER_SOURCE, 0o755);
    return wrapperPath;
  }

  function claudeSettings(extra = {}) {
    const hooks = {};
    for (const [event, matcher] of CLAUDE_EVENTS) {
      const group = { hooks: [{ type: 'command', command: wrapperPath, timeout: HOOK_TIMEOUT_SEC }] };
      if (matcher) group.matcher = matcher;
      hooks[event] = [group];
    }
    return { ...extra, hooks };
  }

  function codexConfigArgs() {
    const cmd = JSON.stringify(wrapperPath);  // TOML basic string == JSON string here
    return CODEX_EVENTS.map(event =>
      `hooks.${event}=[{hooks=[{type="command",command=${cmd},timeout=${HOOK_TIMEOUT_SEC}}]}]`);
  }

  // Minimal JSON-RPC client for one short-lived `codex app-server`.
  function withAppServer({ codexHome, cwd }, fn) {
    return new Promise((resolve, reject) => {
      const args = ['app-server'];
      for (const arg of codexConfigArgs()) args.push('-c', arg);
      const child = spawn(typeof codexCmd === 'function' ? codexCmd() : codexCmd, args, {
        cwd: cwd || os.homedir(),
        env: { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let nextId = 1;
      const pending = new Map();
      let buf = '';
      let done = false;
      const finish = (err, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { child.kill(); } catch (_) {}
        if (err) reject(err); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('codex app-server timed out')), rpcTimeoutMs);
      const request = (method, params) => new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { res, rej });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      child.on('error', e => finish(e));
      child.on('exit', () => finish(new Error('codex app-server exited')));
      child.stdout.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let msg;
          try { msg = JSON.parse(line); } catch (_) { continue; }
          const p = msg && pending.get(msg.id);
          if (!p) continue;
          pending.delete(msg.id);
          if (msg.error) p.rej(new Error(msg.error.message || 'codex rpc error'));
          else p.res(msg.result);
        }
      });
      request('initialize', { clientInfo: { name: 'multicc-turn-hooks', version: '1' } })
        .then(() => {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          return fn(request);
        })
        .then(v => finish(null, v), e => finish(e));
    });
  }

  function ours(list, cwd) {
    const entry = (list?.data || []).find(d => !cwd || d.cwd === cwd) || list?.data?.[0];
    return (entry?.hooks || []).filter(h => h.source === 'sessionFlags' && h.command === wrapperPath);
  }

  function summarize(hooks) {
    const trusted = hooks.filter(h => h.trustStatus === 'trusted').length;
    return {
      total: hooks.length, trusted,
      state: !hooks.length ? 'missing' : trusted === hooks.length ? 'trusted' : trusted ? 'partial' : 'untrusted',
      hooks: hooks.map(h => ({ key: h.key, event: h.eventName, trustStatus: h.trustStatus })),
    };
  }

  async function codexTrustStatus({ codexHome, cwd }) {
    const list = await withAppServer({ codexHome, cwd }, rpc => rpc('hooks/list', { cwds: [cwd || os.homedir()] }));
    return summarize(ours(list, cwd));
  }

  // Only ever call on an explicit user action: this writes hook trust into the
  // user's (or the account's) CODEX_HOME config through Codex's own API.
  async function codexGrantTrust({ codexHome, cwd }) {
    return withAppServer({ codexHome, cwd }, async rpc => {
      const hooks = ours(await rpc('hooks/list', { cwds: [cwd || os.homedir()] }), cwd);
      const value = {};
      for (const h of hooks) {
        if (h.trustStatus !== 'trusted' && h.key && h.currentHash) value[h.key] = { trusted_hash: h.currentHash };
      }
      if (Object.keys(value).length) {
        await rpc('config/batchWrite', { edits: [{ keyPath: 'hooks.state', value, mergeStrategy: 'upsert' }] });
      }
      return summarize(ours(await rpc('hooks/list', { cwds: [cwd || os.homedir()] }), cwd));
    });
  }

  return { install, wrapperPath, claudeSettings, codexConfigArgs, codexTrustStatus, codexGrantTrust };
}

module.exports = { createHookInstaller, WRAPPER_SOURCE, CLAUDE_EVENTS, CODEX_EVENTS, defaultBinDir };
