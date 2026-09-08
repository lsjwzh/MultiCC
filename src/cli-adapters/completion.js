'use strict';

const STATES = new Set(['completed', 'failed', 'cancelled', 'unknown']);

function completion(state, reason, source = 'protocol') {
  if (!STATES.has(state)) throw new TypeError('invalid CLI completion state');
  return Object.freeze({ version: 1, state, reason: typeof reason === 'string' ? reason.slice(0, 160) : 'unknown_reason', source });
}

function isCompleted(outcome) {
  return outcome?.version === 1 && outcome.state === 'completed' && outcome.settled === true;
}

// One tracker per runner, never per adapter/session. Native events describe
// protocol completion; process/stream settlement supplies the independent
// execution boundary. Neither output text nor a socket close proves success.
function createCompletionTracker({ observe, close, fallback = false } = {}) {
  let evidence = completion('unknown', 'missing_terminal_event');
  let ended = false;
  let failed = false;
  let hasOutput = false;
  let sawError = false;
  const tools = new Set();
  return Object.freeze({
    observe(raw, decoded = []) {
      if (ended) return evidence;
      if (!raw || typeof raw !== 'object') return evidence;
      for (const event of decoded) {
        if (!event) continue;
        if (event.type === 'assistant_text' && event.text) hasOutput = true;
        if (event.type === 'error') sawError = true;
        if (event.type === 'tool_start' || event.type === 'tool_update' && !event.completed) {
          tools.add(event.id);
        }
        if (event.type === 'tool_result' || event.type === 'tool_update' && event.completed) tools.delete(event.id);
      }
      const next = observe?.(raw, decoded);
      if (next && !failed) {
        evidence = next;
        failed = next.state === 'failed' || next.state === 'cancelled';
        if (next.state === 'completed') sawError = false;
      }
      return evidence;
    },
    finish(boundary = {}) {
      if (ended) return evidence;
      ended = true;
      if (boundary.killReason) evidence = completion('cancelled', boundary.killReason, 'host');
      else if (failed) { /* Preserve the explicit native failure/cancellation. */ }
      else if (boundary.rejected) evidence = completion('failed', 'stream_rejected', 'host');
      else if (boundary.signal) evidence = completion('failed', 'process_signaled', 'host');
      else if (boundary.kind === 'process' && boundary.code !== 0) {
        evidence = completion('failed', 'nonzero_exit', 'host');
      } else if (boundary.kind === 'stream' && boundary.resolved !== true) {
        evidence = completion('unknown', 'missing_stream_settlement', 'host');
      } else if (!['process', 'stream'].includes(boundary.kind)) {
        evidence = completion('unknown', 'missing_execution_boundary', 'host');
      } else if (!failed) {
        const facts = { hasOutput, sawError, pendingTools: tools.size };
        evidence = close?.(boundary, evidence, facts) || evidence;
        if (fallback && evidence.state === 'unknown' && boundary.kind === 'process'
            && boundary.code === 0 && hasOutput && !sawError && tools.size === 0) {
          evidence = completion('completed', 'clean_exit_with_output', 'exit_fallback');
        }
      }
      evidence = Object.freeze({ ...evidence, settled: true });
      return evidence;
    },
    snapshot() { return evidence; },
  });
}

function createAdapterCompletion(adapter) {
  return typeof adapter?.createCompletionTracker === 'function'
    ? adapter.createCompletionTracker() : createCompletionTracker({ fallback: true });
}

module.exports = { completion, isCompleted, createCompletionTracker, createAdapterCompletion };
