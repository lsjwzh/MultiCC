'use strict';

// These HTTP commands can create tasks or execution sessions. MCP calls the
// canonical service directly under its narrower, session-bound capability.
// Locality, Origin and caller-supplied identity headers are not user credentials.
function requiresTaskCreationAccess(req) {
  if (String(req.method).toUpperCase() !== 'POST') return false;
  return [
    /^\/api\/air\/tasks\/?$/i,
    /^\/api\/directories(?:\/[^/]+\/sessions)?\/?$/i,
    /^\/api\/onboarding\/sample-workspace\/?$/i,
    /^\/api\/(?:codex|claude)\/oauth\/login\/?$/i,
    /^\/api\/codex\/accounts(?:\/[^/]+\/relogin)?\/?$/i,
    /^\/api\/sessions\/(?:import|import-zip)\/?$/i,
    /^\/api\/sessions\/[^/]+\/(?:fork|vendor-login-terminal)\/?$/i,
    /^\/api\/task-board\/(?:tasks|send|backfill)\/?$/i,
    /^\/api\/task-board\/tasks\/[^/]+\/(?:send|chat-session)\/?$/i,
    /^\/api\/task-shell-tasks\/[^/]+\/(?:fork|messages)\/?$/i,
    /^\/api\/task-shells\/?$/i,
    /^\/api\/task-shells\/[^/]+\/(?:messages|tasks\/resolve|task-operations|tasks\/[^/]+\/independent-continue)\/?$/i,
    /^\/api\/task-shells\/[^/]+\/attribution-decisions\/[^/]+\/accept\/?$/i,
    /^\/api\/task-shells\/[^/]+\/receipts\/[^/]+\/retry\/?$/i,
    /^\/api\/sessions\/[^/]+\/task-separation\/[^/]+\/?$/i,
  ].some(pattern => pattern.test(req.path));
}

module.exports = { requiresTaskCreationAccess };
