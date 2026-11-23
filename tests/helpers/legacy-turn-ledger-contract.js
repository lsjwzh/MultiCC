'use strict';

// Turn-ledger contract (status plan v4 §0). One shape for every lifecycle fact
// that reaches the ledger, whatever produced it (hook spool today; MCP plan
// tools and pane titles later), plus the vocabulary the ledger speaks.

const HOOK_EVENTS = new Set([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'Interrupt', 'SessionEnd',
]);

// running  — a turn is in flight (prompt submitted, no confirmed end yet)
// yielding — the CLI is alive but control is back with the user
// ended    — the CLI instance exited
// "Process alive" is a session fact, never proof of a running turn: a CLI
// waiting on a permission prompt is alive and yielding, and must project W.
const OWNERSHIP = Object.freeze({ RUNNING: 'running', YIELDING: 'yielding', ENDED: 'ended' });

// Sub-reasons of E. Only api-error is an API failure; a user interrupt shows
// as "interrupted", is not pushed and is not counted against the provider.
const E_REASONS = Object.freeze([
  'api-error', 'interrupted', 'unknown-interruption', 'result-not-durable', 'handoff-resume-failed',
]);
const SILENT_E_REASONS = new Set(['interrupted']);

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function clampStr(v, max) {
  return typeof v === 'string' && v ? v.slice(0, max) : null;
}

// Validate a raw spool record. Anything malformed is dropped (null) rather than
// repaired: a guessed field is worse than a missing event.
function normalizeEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return null;
  if (!ID_RE.test(String(raw.sessionId || '')) || !ID_RE.test(String(raw.eventId || ''))) return null;
  if (!HOOK_EVENTS.has(raw.event)) return null;
  const ts = Number(raw.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const env = {
    eventId: raw.eventId,
    sessionId: raw.sessionId,
    epoch: Number.isInteger(raw.epoch) && raw.epoch >= 0 ? raw.epoch : 0,
    cli: clampStr(raw.cli, 32),
    event: raw.event,
    ts,
    cliSessionId: clampStr(raw.cliSessionId, 128),
    turnId: clampStr(raw.turnId, 128),
    transcriptPath: clampStr(raw.transcriptPath, 1024),
    cliPid: Number.isInteger(raw.cliPid) && raw.cliPid > 1 ? raw.cliPid : null,
  };
  for (const k of ['source', 'reason', 'notificationType', 'toolName', 'error']) {
    const v = clampStr(raw[k], 200);
    if (v) env[k] = v;
  }
  if (typeof raw.stopHookActive === 'boolean') env.stopHookActive = raw.stopHookActive;
  if (Number.isInteger(raw.backgroundTasks) && raw.backgroundTasks >= 0) env.backgroundTasks = raw.backgroundTasks;
  const head = clampStr(raw.promptHead, 120);
  if (head) env.promptHead = head;
  return env;
}

// One id per state *transition*, not per turn: W→P→W inside one turn yields two
// distinct W transitions, so outbox dedupe can never swallow the second one.
function transitionId({ sessionId, epoch, turnId, seq, state }) {
  return `${sessionId}:${epoch}:${turnId || '-'}:${seq}:${state}`;
}

// Map ledger ownership onto the liveness shape resolveTurnState consumes.
function projectLiveness(ownership) {
  if (ownership === OWNERSHIP.RUNNING) return { state: 'active', reason: 'turn_ledger_running' };
  if (ownership === OWNERSHIP.YIELDING) return { state: 'inactive', reason: 'turn_ledger_yielding' };
  if (ownership === OWNERSHIP.ENDED) return { state: 'inactive', reason: 'turn_ledger_ended' };
  return { state: 'unknown', reason: 'turn_ledger_no_evidence' };
}

module.exports = {
  HOOK_EVENTS, OWNERSHIP, E_REASONS, SILENT_E_REASONS,
  normalizeEnvelope, transitionId, projectLiveness,
};
