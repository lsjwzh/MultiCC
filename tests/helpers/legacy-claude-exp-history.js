'use strict';

const os = require('node:os');
const path = require('node:path');
const { probeTranscript } = require('../../src/chat/missing-resume-recovery');

// A UUID reserved before the first SDK turn is not evidence of a conversation.
// Older hosts allocated it on WebSocket connect, then counted the source CLI's
// display history as target history after a restart. Repair only a pending NEW
// target handoff: missing history for a reused/established target must still fail
// closed at the CLI, rather than silently discarding its context.
function hasNativeHistory(record, options = {}) {
  const id = record.cliSessionId;
  if (!id) return false;
  const handoff = record.pendingCliHandoff;
  if (record.cli !== 'claude-exp' || handoff?.status !== 'pending'
      || handoff.toCli !== 'claude-exp' || handoff.reusedTarget !== false) return true;
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) return true;
  const configDir = options.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  // The project-directory walk (the SDK canonicalizes symlinks, hashes long
  // paths and supports custom project names) lives in the Rust probe. Only a
  // proven absence permits first-turn creation: I/O and permission errors read
  // as history.
  return probeTranscript({ sessionId: id, configDir }).evidence !== 'proven_absent';
}

module.exports = { hasNativeHistory };
