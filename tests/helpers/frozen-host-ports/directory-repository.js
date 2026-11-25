'use strict';
// FsDirectoryRepository — the directories.json-backed implementation of
// REPOSITORY_PORT. The table itself is the native state owner's directory
// registry (src/directory/records.js); this module only adapts that Map-shaped
// facade to the directory domain ports and turns a failed write into the same
// logged-and-rethrown error the controller maps to HTTP 500.
//
// Durability: `save()` asks the native owner to serialize the live table with
// the host engine and write it through the StateStore envelope (tmp + fsync +
// rename + parent-dir fsync + three rolling backups). The cross-file journal
// lives in the same owner (commitCrossFileWrite), so directory deletion and the
// session cascade are one transaction.
function createFsDirectoryRepository({ file, map, realPathOf, owner }) {
  if (!file) throw new TypeError('[directory] repository needs a file path');
  if (!(map instanceof Map)) throw new TypeError('[directory] repository needs the directory table');
  if (!owner || typeof owner.saveDirectories !== 'function') {
    throw new TypeError('[directory] repository needs the native state owner');
  }
  const dirs = map;

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
    try {
      owner.saveDirectories();
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

  // The shared `directories` reference (state.js and every bounded context)
  // reads and writes through the same native table.
  function mapRef() { return dirs; }

  return { get, list, add, remove, findByPath, save, map: mapRef };
}

module.exports = { createFsDirectoryRepository };
