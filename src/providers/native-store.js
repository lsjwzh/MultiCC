'use strict';
// Synchronous compatibility port for the existing catalog API. Rust owns
// bounded I/O, format compatibility, locking, revisions and atomic persistence.
const { getNative } = require('../native/runtime');
function createNativeProviderStore(file) {
  const revisions = new WeakMap();
  function access(input) {
    try { return JSON.parse(getNative('provider_store', 'rust').providerStore(file, JSON.stringify(input))); }
    catch (error) { error.code = error.message; throw error; }
  }
  return {
    read() {
      const snapshot = access({ operation: 'read' });
      revisions.set(snapshot.records, snapshot.revision);
      return snapshot.records;
    },
    write(records, source = records) {
      const revision = revisions.get(source);
      const next = access({ operation: 'write', records, revision });
      revisions.set(records, next.revision);
    },
  };
}
module.exports = { createNativeProviderStore };
