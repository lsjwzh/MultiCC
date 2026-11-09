'use strict';

// The one native owner behind both live state tables and the cross-file
// journal (native/addon/src/session_records.rs). It is created once at boot,
// before the state bootstrap, so journal replay, directories.json and
// sessions.json share one writer and one host-value anchor.
//
// This module is the composition point: the session facade
// (src/session/records.js) and the directory facade (src/directory/records.js)
// both receive this object rather than reaching for each other.

const { getNative } = require('../native/runtime');
const { loadDirectories } = require('../directory/records');

function createStateOwner() {
  const native = getNative();
  if (typeof native.RustSessionRecords !== 'function') {
    throw new Error('rust_session_records_unavailable');
  }
  const anchor = Object.create(null);
  const owner = new native.RustSessionRecords(anchor);
  const shared = { native: owner, anchor };
  let directoriesFile = null;
  return {
    native: owner,
    anchor,
    configure(options) {
      if (options && typeof options.directoriesFile === 'string') {
        directoriesFile = options.directoriesFile;
      }
      owner.configure(options);
      return this;
    },
    commitCrossFileWrite(spec) {
      return owner.commitCrossFileWrite(spec);
    },
    replayJournals() {
      return owner.replayJournals();
    },
    /// Raw native metadata, except a damaged file is raised as the same
    /// `CorruptedStateError` StateStore threw at boot.
    loadDirectories() {
      return loadDirectories(shared, directoriesFile);
    },
    /** Boot import: the migration Map's `[id, record]` pairs are read once. */
    initDirectories(entries) {
      return owner.initDirectories(entries);
    },
    saveDirectories() {
      return owner.saveDirectories();
    },
  };
}

module.exports = { createStateOwner };
