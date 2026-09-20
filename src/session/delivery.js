'use strict';

// Typed, host-owned delivery boundary for messages that continue an existing
// chat session. Callers bring an already-authorized continuation and this
// boundary maps it to the scheduler vocabulary.
//
// Keeping delivery separate from wait-injector prevents legacy in-memory wait
// timers from becoming the authority for dispatch feedback or background-task
// completion.

const SYSTEM_PREFIX = '🔇';
const DELIVERY_KINDS = new Set(['continuation']);

function requireFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`[session-delivery] ${name} port is required`);
  }
}

function createSessionDelivery(options = {}) {
  const admit = options.admit;
  const log = typeof options.log === 'function' ? options.log : () => {};
  requireFunction(admit, 'admit');

  function deliver(sessionId, text, options = {}) {
    const cleanSessionId = String(sessionId || '').trim();
    const cleanText = String(text || '');
    if (!cleanSessionId) throw new TypeError('[session-delivery] sessionId is required');
    if (!cleanText.trim()) throw new TypeError('[session-delivery] text is required');

    const kind = options.kind || 'continuation';
    if (!DELIVERY_KINDS.has(kind)) {
      throw new TypeError(`[session-delivery] unsupported kind: ${kind}`);
    }

    const {
      kind: _kind,
      system = false,
      ...metadata
    } = options;
    const message = system && !cleanText.startsWith(SYSTEM_PREFIX)
      ? `${SYSTEM_PREFIX}${cleanText}`
      : cleanText;
    const admission = {
      ...metadata,
      // A host delivery always continues the current native conversation. The
      // scheduler work kind remains independently typed below.
      originContinue: true,
    };
    delete admission.retry;

    try {
      return Promise.resolve(admit(cleanSessionId, message, admission))
        .then(result => {
          if (result === false || result?.ok === false) {
            log(`[session-delivery] ${kind} rejected for ${cleanSessionId}: ${result?.code || 'not_accepted'}`);
          }
          return result;
        })
        .catch(error => {
          log(`[session-delivery] ${kind} failed for ${cleanSessionId}: ${error.message}`);
          return { ok: false, code: 'delivery_failed' };
        });
    } catch (error) {
      log(`[session-delivery] ${kind} failed for ${cleanSessionId}: ${error.message}`);
      return Promise.resolve({ ok: false, code: 'delivery_failed' });
    }
  }

  function deliverContinuation(sessionId, text, options = {}) {
    return deliver(sessionId, text, { ...options, kind: 'continuation' });
  }

  function deliverSystem(sessionId, text, options = {}) {
    return deliver(sessionId, text, {
      ...options,
      kind: 'continuation',
      system: true,
    });
  }

  return {
    deliver,
    deliverContinuation,
    deliverSystem,
  };
}

module.exports = {
  SYSTEM_PREFIX,
  DELIVERY_KINDS,
  createSessionDelivery,
};
