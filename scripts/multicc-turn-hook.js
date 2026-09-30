#!/usr/bin/env node
'use strict';

// Lifecycle hook shim for terminal-mode Claude/Codex (status plan v4 §2).
//
// The CLI runs this once per hook event with the event JSON on stdin. It must
// never slow the CLI down or change its behaviour, so it: projects the event to
// the few fields the turn ledger needs (redacting before anything touches disk),
// writes one 0600 file into the session's spool directory atomically, prints
// nothing and always exits 0. The server ingests and deletes spool files; no
// network and no credentials are involved.
//
// A copy of this file is installed at a fixed path (~/.multicc/bin) because
// Codex trusts hooks by the hash of their command string — the command must not
// move when the checkout does. Everything that varies arrives through env.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_STDIN = 1024 * 1024;
const MAX_SPOOL_FILES = 2000;

function redact(text) {
  return String(text || '')
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(bearer|token|api[_-]?key|secret|password|passwd)\b\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '[redacted]');
}

// First meaningful line of the prompt, never the whole thing. Injected wrapper
// lines (multicc system notes, XML-ish context blocks) are skipped.
function promptHead(prompt) {
  const lines = String(prompt || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const line = lines.find(l => !/^(<[^>]+>|【[^】]*】|\[multicc)/i.test(l)) || '';
  const clean = redact(line).replace(/\s+/g, ' ');
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}

function str(v, max = 256) {
  return typeof v === 'string' && v ? v.slice(0, max) : null;
}

function project(raw, env) {
  const event = str(raw.hook_event_name, 64);
  if (!event) return null;
  const out = {
    v: 1,
    eventId: crypto.randomUUID(),
    ts: Date.now(),
    sessionId: env.MULTICC_TURN_HOOK_SESSION,
    epoch: Number(env.MULTICC_TURN_HOOK_EPOCH) || 0,
    cli: str(env.MULTICC_TURN_HOOK_CLI, 32),
    event,
    cliSessionId: str(raw.session_id, 128),
    // Codex carries turn_id; Claude carries prompt_id. Both identify one turn.
    turnId: str(raw.turn_id, 128) || str(raw.prompt_id, 128),
    transcriptPath: str(raw.transcript_path, 1024),
    cliPid: process.ppid,
  };
  if (raw.source != null) out.source = str(raw.source, 32);
  if (raw.reason != null) out.reason = str(raw.reason, 64);
  if (typeof raw.stop_hook_active === 'boolean') out.stopHookActive = raw.stop_hook_active;
  if (Array.isArray(raw.background_tasks)) out.backgroundTasks = raw.background_tasks.length;
  if (raw.notification_type != null) out.notificationType = str(raw.notification_type, 64);
  if (raw.tool_name != null) out.toolName = str(raw.tool_name, 128);
  if (raw.error != null) out.error = redact(str(String(raw.error), 200));
  if (event === 'UserPromptSubmit') out.promptHead = promptHead(raw.prompt);
  return out;
}

function writeSpool(dir, record) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let count = 0;
  try { count = fs.readdirSync(dir).length; } catch (_) {}
  if (count >= MAX_SPOOL_FILES) return false;  // server is gone; never fill the disk
  const name = `${String(record.ts).padStart(15, '0')}-${record.eventId}.json`;
  const tmp = path.join(dir, `.${name}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(record));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, path.join(dir, name));
  return true;
}

function main(env = process.env) {
  const spool = env.MULTICC_TURN_HOOK_SPOOL;
  const sessionId = env.MULTICC_TURN_HOOK_SESSION;
  if (!spool || !sessionId || !/^[A-Za-z0-9_.-]{1,128}$/.test(sessionId)) return;
  let input;
  try { input = fs.readFileSync(0); } catch (_) { return; }
  if (input.length > MAX_STDIN) return;
  let raw;
  try { raw = JSON.parse(input); } catch (_) { return; }
  const record = raw && typeof raw === 'object' ? project(raw, env) : null;
  if (!record) return;
  try { writeSpool(path.join(spool, sessionId), record); } catch (_) {}
}

if (require.main === module) {
  try { main(); } catch (_) {}
  process.exitCode = 0;
}

module.exports = { project, promptHead, redact, writeSpool };
