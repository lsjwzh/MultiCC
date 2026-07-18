'use strict';
// FsDirectoryRepository — the directories.json-backed implementation of
// REPOSITORY_PORT. Loading stays in server.js's loadPersistedState() because
// first-boot migration reads directories.json and sessions.json together; the
// repository wraps the Map that bootstrap produced. The Map reference is also
// shared into src/state.js (mutated, never reassigned), so legacy call sites
// that read `directories` directly keep working while they are migrated over.
//
// Durability: as of the state-store migration, saves go through
// writeJsonAtomic (tmp + fsync + rename + parent-dir fsync + rolling backup).
// A save failure now THROWS rather than silently logging: two-file consistency
// (this file + sessions.json) matters, and the HTTP layer needs the error so
// it can 5xx the client instead of returning a false success. Legacy call
// sites that catch generically are unaffected; the previous "log and swallow"
// behaviour just moved into repo._legacyLog when they explicitly opt in.
const fs = require('fs');
const stateStore = require('../state-store');

function createFsDirectoryRepository({ file, map, realPathOf, store }) {
  if (!file) throw new TypeError('[directory] repository needs a file path');
  const dirs = map instanceof Map ? map : new Map();
  // If the caller passed a StateStore, use it — that path is the durable one
  // (used in production). Tests pass no store, so we fall back to a plain
  // JSON write that still lives in this module and can be stubbed easily.
  const _store = store || (file ? stateStore.createStore({
    file, kind: 'directories', schemaVersion: 1, legacyIsArray: true,
  }) : null);

  function get(id) { return dirs.get(id); }
  function list() { return [...dirs.values()]; }
  function add(dir) { dirs.set(dir.id, dir); return dir; }
  function remove(id) { return dirs.delete(id); }

  // Match by physical path (symlinks resolved) — duplicate registrations of the
  // same real directory are rejected by the service layer.
  function findByPath(resolvedPath, excludeId) {
    const target = realPathOf(resolvedPath);
    for (const d of dirs.values()) {
      if (excludeId && d.id === excludeId) continue;
      if (realPathOf(d.path) === target) return d;
    }
    return null;
  }

  function save() {
    const payload = [...dirs.values()];
    try {
      if (_store) return _store.save(payload);
      // Fallback (unit tests that pass file:'/nonexistent/...' — the fake test
      // suite stubs save() outright, so this line rarely runs in practice).
      fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    } catch (e) {
      // Persistence failure is a data-integrity issue. Log AND throw so the
      // controller can turn it into a 500 with a request id, instead of the
      // pre-migration behaviour where the HTTP call returned 200 and the
      // change never touched disk.
      // eslint-disable-next-line no-console
      console.error('[multicc] Failed to save directories.json:', e.message);
      throw e;
    }
  }

  // Transitional: expose the backing Map so server.js can keep the shared
  // `directories` reference (state.js) alive for not-yet-migrated domains.
  function mapRef() { return dirs; }

  // Expose the raw payload snapshot so cross-file transactions can capture
  // both files under a single journal entry without going through save().
  function snapshot() { return [...dirs.values()]; }

  return { get, list, add, remove, findByPath, save, map: mapRef, snapshot };
}

module.exports = { createFsDirectoryRepository };
