'use strict';

// Login terminals (`codex login`, `claude auth login`, vendor `/login` TUIs)
// are one-shot helpers, never saved workspaces. Two things go wrong when a
// finished one is kept:
//   * the process may exit right after the browser step (command-code login
//     prints "already logged in" and quits), so the saved pane only replays the
//     previous run instead of a fresh login prompt;
//   * a vendor TUI can outlive the browser step, so reusing its tmux pane
//     reattaches to the old terminal rather than starting a new one.
// Every login request therefore disposes the flow's previous terminals before
// creating a new one, and the terminal-exit path drops the record entirely.
function createLoginTerminalDisposer(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('[login-terminal] dependencies are required');
  const { persistedSessions, tmuxKillSession } = deps;
  if (!persistedSessions || typeof persistedSessions.values !== 'function'
    || typeof persistedSessions.delete !== 'function') {
    throw new TypeError('[login-terminal] persistedSessions map is required');
  }
  if (typeof tmuxKillSession !== 'function') throw new TypeError('[login-terminal] tmuxKillSession is required');
  const destroySessionCascade = typeof deps.destroySessionCascade === 'function' ? deps.destroySessionCascade : null;
  const saveSessions = typeof deps.saveSessions === 'function' ? deps.saveSessions : null;

  return async function disposeLoginTerminals(loginFlow) {
    const flow = String(loginFlow || '').trim();
    if (!flow) return 0;
    let disposed = 0;
    for (const record of [...persistedSessions.values()]) {
      if (!record || record.loginFlow !== flow) continue;
      if (destroySessionCascade) {
        try { await destroySessionCascade(record, { id: record.dirId }, { force: true }); } catch (_) {}
      }
      // The cascade only kills a tmux session it still has an in-memory handle
      // for. A login terminal recovered after a restart can own a bare tmux
      // pane, and re-creating the same id would attach to that old pane.
      try { await tmuxKillSession(record.id); } catch (_) {}
      persistedSessions.delete(record.id);
      disposed += 1;
    }
    if (disposed && saveSessions) saveSessions('runtime.login-terminal-reset');
    return disposed;
  };
}

module.exports = { createLoginTerminalDisposer };
