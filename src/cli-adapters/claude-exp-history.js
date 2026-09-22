'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  const projects = path.join(configDir, 'projects');
  const io = options.fs || fs;
  try {
    // The SDK canonicalizes symlinks, hashes long paths, and supports custom
    // project names. Search by UUID instead of duplicating that private layout.
    for (const entry of io.readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try { io.statSync(path.join(projects, entry.name, `${id}.jsonl`)); return true; }
      catch (error) { if (error.code !== 'ENOENT') return true; }
    }
    return false;
  } catch (error) {
    // Only proven absence permits first-turn creation; I/O/permission errors
    // must not turn a resume into a new conversation.
    return error.code !== 'ENOENT';
  }
}

module.exports = { hasNativeHistory };
