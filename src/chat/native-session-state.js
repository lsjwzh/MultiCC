'use strict';

// Accept a native session id only from the process that owns that native
// history. A fresh physical attempt always allocates a new thread, so an Auto
// fallback must replace an id emitted by the failed attempt. A resume attempt
// may only confirm the already-persisted id; accepting a different one would
// silently switch the logical chat onto unrelated native history.
function captureNativeSessionId(record, sessionId, options = {}) {
  const previous = String(record && record.cliSessionId || '').trim() || null;
  const incoming = String(sessionId || '').trim() || null;
  const mayReplace = options.fresh === true;
  if (previous && incoming && previous !== incoming && !mayReplace) {
    return Object.freeze({
      changed: false, previous, current: previous, mismatch: true, incoming,
    });
  }
  if (!record || !incoming) {
    return Object.freeze({ changed: false, previous, current: previous });
  }
  if (previous === incoming) {
    return Object.freeze({ changed: false, previous, current: previous });
  }
  record.cliSessionId = incoming;
  return Object.freeze({ changed: true, previous, current: incoming });
}

module.exports = { captureNativeSessionId };
