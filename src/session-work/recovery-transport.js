'use strict';

// JSON omits undefined properties, while the legacy queue projection exposes
// them to in-process event listeners. Restore the fixed transport shape only;
// Rust remains responsible for the queue projection and all state decisions.
function decodeRecoveryEvents(resultJson) {
  const events = JSON.parse(resultJson);
  for (const event of events) {
    for (const item of event.queuedItems || []) {
      for (const key of ['entryId', 'sequence', 'state', 'admittedAt']) {
        if (!Object.hasOwn(item, key)) item[key] = undefined;
      }
    }
  }
  return events;
}
module.exports = { decodeRecoveryEvents };
