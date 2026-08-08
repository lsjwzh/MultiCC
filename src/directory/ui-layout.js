'use strict';

// UI layout routes — durable storage for the user's drag-and-drop arrangement
// of the directory grid and of the session list inside each fleet.
//
//   GET  /api/ui-layout                        → the whole document
//   PUT  /api/ui-layout/dir-order              { order: [dirId, …] }
//   PUT  /api/ui-layout/session-order/:dirId   { order: [sessionId, …] }
//
// This lives in the directory domain because that is what the document is about:
// the grid is directories, and a "fleet" is one directory's sessions. It mounts
// onto the directory router (src/directory/index.js), so the composition root
// keeps a single directory-domain mount point.
//
// The two PUTs are deliberately separate rather than one PUT of the whole
// document: dragging a card in one fleet must not overwrite the arrangement a
// second browser just made in another. Whole-document writes would make the
// last tab to touch anything win everything.
//
// Pruning happens on both read and write (see src/ui-layout.js). Read-side
// pruning is what keeps a deleted fleet from lingering in the response without
// forcing a disk write on every GET.

const stateStore = require('../state-store');
const core = require('../ui-layout');

function createUiLayoutRuntime(rawDeps) {
  const deps = rawDeps || {};
  const { file } = deps;
  if (!file) throw new TypeError('[ui-layout] file path is required');
  if (typeof deps.listDirIds !== 'function') throw new TypeError('[ui-layout] listDirIds() is required');
  if (typeof deps.listSessionIds !== 'function') throw new TypeError('[ui-layout] listSessionIds() is required');
  const logger = deps.logger || console;
  const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString();
  const store = stateStore.createStore({
    file, kind: 'ui-layout', schemaVersion: core.SCHEMA_VERSION, legacyIsArray: false,
  });

  // In-memory authority for the process. Loaded once, lazily: a fresh install
  // has no file and must not pay a stat on every request.
  let layout = null;

  // Snapshot of what currently exists, rebuilt per request. Cheap (a few
  // hundred entries) and always right, which matters more here than caching —
  // a stale known-set would silently delete a just-created session's slot.
  function knownIds() {
    const knownDirIds = new Set(deps.listDirIds());
    const sessionIdsByDir = new Map();
    for (const dirId of knownDirIds) sessionIdsByDir.set(dirId, new Set(deps.listSessionIds(dirId)));
    return { knownDirIds, sessionIdsByDir };
  }

  function load() {
    if (layout) return layout;
    try {
      const r = store.loadOrRecover();
      layout = core.normalizeLayout(r.present ? r.data : null);
    } catch (e) {
      // A corrupt layout file costs the user their arrangement, nothing else.
      // Starting from empty is the right blast radius here — unlike
      // sessions.json, where state-store deliberately fails closed.
      logger.warn(`[multicc/ui-layout] unreadable layout file, starting empty: ${e.message}`);
      layout = core.emptyLayout();
    }
    return layout;
  }

  function persist() {
    layout.updatedAt = now();
    try { store.save(layout); }
    catch (e) { logger.warn(`[multicc/ui-layout] save failed: ${e.message}`); }
  }

  // What a client should see: stored order minus anything that no longer exists.
  function readLayout() {
    return core.normalizeLayout(load(), knownIds());
  }

  function setDirOrder(order) {
    const { knownDirIds } = knownIds();
    load().dirOrder = core.normalizeOrder(order, knownDirIds);
    persist();
    return readLayout();
  }

  function setSessionOrder(dirId, order) {
    const { knownDirIds, sessionIdsByDir } = knownIds();
    if (!knownDirIds.has(dirId)) return null;
    const next = core.normalizeOrder(order, sessionIdsByDir.get(dirId));
    const doc = load();
    if (next.length) doc.sessionOrder[dirId] = next;
    else delete doc.sessionOrder[dirId];
    persist();
    return readLayout();
  }

  // `target` is an express Router (production) or the app (tests) — both expose
  // the same get/put surface.
  function mountRoutes(target) {
    target.get('/api/ui-layout', (req, res) => {
      res.json({ ok: true, layout: readLayout() });
    });

    target.put('/api/ui-layout/dir-order', (req, res) => {
      const body = req.body || {};
      if (!Array.isArray(body.order)) {
        return res.status(400).json({ error: 'order must be an array of directory ids' });
      }
      res.json({ ok: true, layout: setDirOrder(body.order) });
    });

    target.put('/api/ui-layout/session-order/:dirId', (req, res) => {
      const body = req.body || {};
      if (!Array.isArray(body.order)) {
        return res.status(400).json({ error: 'order must be an array of session ids' });
      }
      const next = setSessionOrder(req.params.dirId, body.order);
      if (!next) return res.status(404).json({ error: 'directory not found' });
      res.json({ ok: true, layout: next });
    });
  }

  return { mountRoutes, readLayout, setDirOrder, setSessionOrder };
}

module.exports = { createUiLayoutRuntime };
