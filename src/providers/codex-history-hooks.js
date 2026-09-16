'use strict';

// MultiCC's data-correction stage for cli-provider-router's local request hooks
// (CPR capability `requestHooks`). See docs/request-hooks.md in CPR and
// docs/codex-proxy-contract.md here.
//
// Why the correction belongs HERE and not before spawn: the proxy is the last
// component to see a Codex request before an upstream, and the only one that
// sees that upstream reject it. Every Codex route this host serves is
// store:false at the source, so an id-only reference a previous provider minted
// can never be resolved by the next one, and a history one upstream accepted
// (foreign item ids, encrypted reasoning blobs, dangling replay references) is
// exactly the body only the provider of the moment refuses. Both hooks therefore
// run at the dial point, on the request copy alone — the saved rollout
// transcript is never touched.
//
//   · onRequest           pre-dial normalization of the forwarded copy.
//   · onUpstreamRejected  the same repair the official OAuth relay performs for
//                         its own dial, now for every CPR-managed Codex route:
//                         one bounded repair + re-dial (CPR's hookRetryMax,
//                         default 1), always before anything is written to the
//                         client, so the client sees the repaired turn instead
//                         of the rejection.
//
// Returning undefined means "leave it alone": CPR then forwards the original
// bytes untouched, so a turn that needs no correction pays nothing for the hook
// being installed.

const {
  normalizeResponsesHistory,
  repairRejectedResponsesHistory,
} = require('../model-history-converter');

// The ChatGPT Codex backend answers an unresolvable store:false item reference
// with 404, not the 400 this family was originally pinned to — same
// "history could not be resolved" family, same single bounded repair. Every
// other status stays fail-fast: 401/429/500 must never replay a request.
const REPAIRABLE_STATUS = new Set([400, 404]);

function requestBody(context) {
  const body = context && context.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

// CPR hands the raw upstream error body over as text; repairRejectedResponsesHistory
// matches on the error object the official relay passes for its own dial
// (`message`, `param`, `code`), so unwrap the same shape out of the JSON.
function rejectionError(context) {
  const text = String((context && context.message) || '');
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const inner = parsed.error;
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) return { ...inner };
      return parsed;
    }
  } catch (_) { /* non-JSON error body: match on the text alone */ }
  return { message: text };
}

function createCodexHistoryHooks(options = {}) {
  const logger = options.logger && typeof options.logger.warn === 'function' ? options.logger : null;
  const report = (event, fields) => {
    try { if (logger) logger.warn(event, fields); } catch (_) { /* diagnostics never break a turn */ }
  };
  return Object.freeze({
    // The provider-agnostic pass, straight from the converter: rename ids the
    // Responses API would not accept, then drop the reference shapes that can
    // only resolve server-side (previous_response_id, item_reference husks,
    // foreign reasoning ids with no verifiable blob). No per-upstream option is
    // set here — the one that exists (official's reasoning-content rule) belongs
    // to the relay that dials that backend, and this hook serves every route but
    // that one.
    onRequest(context) {
      if (!context || context.protocol !== 'openai-responses') return undefined;
      const body = requestBody(context);
      if (!body) return undefined;
      const normalized = normalizeResponsesHistory(body);
      if (!normalized.changes.length) return undefined;
      report('model_history_preprocessed', {
        providerId: context.providerId,
        sessionId: context.sessionId,
        role: context.role,
        changes: normalized.changes,
      });
      return { body: normalized.body };
    },
    // One repair round, restricted to what the converter recognizes (optional
    // metadata, reasoning content, dangling references). `retry: true` is what
    // authorizes the re-dial; without a recognized repair the rejection reaches
    // the client verbatim, exactly as it did before this hook existed.
    onUpstreamRejected(context) {
      if (!context || context.protocol !== 'openai-responses') return undefined;
      if (!REPAIRABLE_STATUS.has(Number(context.status))) return undefined;
      const body = requestBody(context);
      if (!body) return undefined;
      const error = rejectionError(context);
      const repair = repairRejectedResponsesHistory(body, error);
      if (!repair || !repair.changes.length) return undefined;
      report('model_history_repaired_after_rejection', {
        providerId: context.providerId,
        sessionId: context.sessionId,
        role: context.role,
        status: context.status,
        error: {
          message: String(error.message || ''),
          ...(error.param ? { param: String(error.param) } : {}),
          ...(error.code ? { code: String(error.code) } : {}),
        },
        changes: repair.changes,
      });
      return { retry: true, body: repair.body };
    },
  });
}

module.exports = { createCodexHistoryHooks };
