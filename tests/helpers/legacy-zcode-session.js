'use strict';

// Only the engine allocates native session IDs. Older bridge versions emitted
// diagnostic labels in sessionID; those labels must never become resume keys.
const LEGACY_ERROR_IDS = new Set(['zcode-settings', 'zcode-err', 'zcode-no-engine', 'zcode-parse']);
function isZcodeSessionId(value) {
  return typeof value === 'string' && /^sess_[A-Za-z0-9_-]+$/.test(value);
}
function isLegacyBridgeId(value) {
  return typeof value === 'string' && (LEGACY_ERROR_IDS.has(value) || /^zcode-\d+$/.test(value));
}

// Startup and CLI switching share this migration. Clear only proven bridge
// sentinels, keeping genuine/unknown vendor IDs and every other CLI untouched.
// No native transcript, displayed history, provider or worktree is modified.
function repairZcodeSessionState(session) {
  let changed = false;
  function clear(record, key) {
    if (record && isLegacyBridgeId(record[key])) { record[key] = null; changed = true; }
  }
  if (session.cli === 'zcode') {
    clear(session, 'cliSessionId'); clear(session, '_streamSessionId');
  }
  clear(session.cliStates?.zcode, 'cliSessionId');
  clear(session.cliStates?.zcode, 'streamSessionId');
  return changed;
}

module.exports = { isZcodeSessionId, repairZcodeSessionState };
