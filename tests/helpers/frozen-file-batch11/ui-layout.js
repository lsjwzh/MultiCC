'use strict';

// UI layout store — the durable half of the drag-and-drop arrangement of the
// directory grid and of each fleet's session list.
//
// The public routes (`GET /api/ui-layout`, `PUT /api/ui-layout/dir-order`,
// `PUT /api/ui-layout/session-order/:dirId`) and every normalization/pruning
// rule now live in the Rust front door:
//   native/gateway/src/app/directory_routes.rs (routes, key order, 404/400)
//   native/core/src/directory_routes.rs         (normalizeOrder/normalizeLayout)
// What is left here is the process-local world those rules ask about: the
// `ui-layout.json` document through the standard state-store envelope, and the
// live directory/session id sets. `src/routes/directory-host.js` exposes both
// on the internal host port.
//
// The document is deliberately a hint, never an authority: a list of ids in the
// order the user put them. Ids that mean nothing are dropped, ids that are
// missing fall back to creation order. Losing this file costs the user their
// arrangement and nothing else, which is why it is not journalled alongside
// sessions.json/directories.json.

const stateStore = require('../frozen-batch10').frozen('state/store');

function createUiLayoutStore(rawDeps) {
  const deps = rawDeps || {};
  const { file } = deps;
  if (!file) throw new TypeError('[ui-layout] file path is required');
  if (typeof deps.listDirIds !== 'function') throw new TypeError('[ui-layout] listDirIds() is required');
  if (typeof deps.listSessionIds !== 'function') throw new TypeError('[ui-layout] listSessionIds() is required');
  const logger = deps.logger || console;
  const store = stateStore.createStore({
    file, kind: 'ui-layout', schemaVersion: 1, legacyIsArray: false,
  });

  // Loaded once, lazily: a fresh install has no file and must not pay a stat on
  // every request. An unreadable file costs the arrangement and nothing else,
  // so it starts empty (unlike sessions.json, where state-store fails closed).
  let cached = null;

  function load() {
    if (cached) return cached;
    try {
      const r = store.loadOrRecover();
      cached = { present: r.present === true, corrupt: false, data: r.present ? r.data : null };
    } catch (e) {
      logger.warn(`[multicc/ui-layout] unreadable layout file, starting empty: ${e.message}`);
      cached = { present: false, corrupt: true, data: null };
    }
    return cached;
  }

  // A failed save is a warn, never a failed request: the arrangement is a hint.
  function save(doc) {
    cached = { present: true, corrupt: false, data: doc };
    try { store.save(doc); }
    catch (e) { logger.warn(`[multicc/ui-layout] save failed: ${e.message}`); }
  }

  function known() {
    const dirIds = [...deps.listDirIds()];
    const sessionIds = {};
    for (const dirId of dirIds) sessionIds[dirId] = [...deps.listSessionIds(dirId)];
    return { dirIds, sessionIds };
  }

  return { load, save, known };
}

module.exports = { createUiLayoutStore };
