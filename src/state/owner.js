'use strict';

// The one native owner behind both live state tables and the cross-file
// journal (native/addon/src/session_records.rs). It is created once at boot,
// before the state bootstrap, so journal replay, directories.json and
// sessions.json share one writer and one host-value anchor.
//
// This module is the composition point: the session facade
// (src/session/records.js) and the directory Map adapter (src/native/binding.js)
// both receive this object rather than reaching for each other.

const { getNative } = require('../native/binding');
const { corruptedStateError, loadDirectories } = require('../native/binding').directoryRecords;

const nativeOrigins = new WeakMap();

function createStateOwner() {
  const native = getNative();
  if (typeof native.RustSessionRecords !== 'function') {
    throw new Error('rust_session_records_unavailable');
  }
  const anchor = Object.create(null);
  const owner = new native.RustSessionRecords(anchor);
  // N-API keeps a weak anchor so host/native cycles remain collectible. Facades
  // may retain only the native instance; give V8 the missing instance -> anchor
  // edge instead of adding a permanent strong reference on the Rust side.
  Object.defineProperty(owner, Symbol('host-value-anchor'), { value: anchor });
  nativeOrigins.set(owner, native);
  const shared = { native: owner, anchor };
  let directoriesFile = null;
  let sessionsFile = null;
  return {
    native: owner,
    anchor,
    configure(options) {
      if (options && typeof options.directoriesFile === 'string') {
        directoriesFile = options.directoriesFile;
      }
      if (options && typeof options.sessionsFile === 'string') {
        sessionsFile = options.sessionsFile;
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
    loadSessions() {
      const result = owner.loadSessions();
      if (result.errorKind) throw corruptedStateError(sessionsFile, result);
      return result;
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

function createTurnRuntimeStore(options = {}) {
  const addon = getNative();
  return addon.turnRuntimeStore(options, createStateOwner, nativeOrigins, addon);
}

module.exports = { createTurnRuntimeStore, createStateOwner };
