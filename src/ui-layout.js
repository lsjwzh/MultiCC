'use strict';

// UI layout — the manual, drag-and-drop order the user chose for the directory
// grid and for the session list inside each fleet.
//
// Why this lives on the server at all: the order used to sit in the browser's
// localStorage (`multicc_dir_order`) and in the app's SharedPreferences
// (`directory_order`). That made it a property of the *device*, so a second
// browser, a phone, or a cleared cache each got their own arrangement and the
// user had to drag everything into place again. The arrangement is a property
// of the user's workspace, so it belongs next to the workspace.
//
// This module is the pure core: normalize what a client sends, prune what no
// longer exists, and hand back a plain document. Persistence and HTTP live in
// src/routes/ui-layout.js; the *application* of the order (manual first, then
// creation order for anything never dragged) lives in the two clients —
// public/ui-layout-store.js and app/lib/utils/session_status_helpers.dart —
// which must agree with each other, and have tests that say so.
//
// The document is deliberately a hint, never an authority: a list of ids in the
// order the user put them. Ids that mean nothing are dropped, ids that are
// missing fall back to creation order. Losing this file costs the user their
// arrangement and nothing else, which is why it is not journalled alongside
// sessions.json/directories.json.

const SCHEMA_VERSION = 1;

// Bounds. A fleet with 2000 sessions is already pathological; the cap exists so
// a malformed or hostile PUT cannot grow the file without limit. Ids are the
// same shape as everywhere else (uuid / `multicc-claude-chat-06`).
const MAX_IDS = 2000;
const MAX_ID_LENGTH = 200;
const MAX_DIRS = 500;

function emptyLayout() {
  return { dirOrder: [], sessionOrder: {}, updatedAt: null };
}

// One id list → deduplicated array of plausible ids, capped.
// `known` (a Set, optional) drops ids that no longer exist: a deleted session
// must not keep a slot in the order forever, or the file grows monotonically
// for the lifetime of the install.
function normalizeOrder(value, known) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || id.length > MAX_ID_LENGTH) continue;
    if (seen.has(id)) continue;
    if (known && !known.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

// Whole-document normalization, used both when loading from disk and when
// serving. Unknown top-level keys are dropped rather than preserved — this
// document has no extension points, and echoing back arbitrary client JSON is
// how a store like this turns into an accidental key/value service.
function normalizeLayout(raw, { knownDirIds, sessionIdsByDir } = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const layout = emptyLayout();
  layout.dirOrder = normalizeOrder(src.dirOrder, knownDirIds);

  const bySrcDir = src.sessionOrder && typeof src.sessionOrder === 'object' && !Array.isArray(src.sessionOrder)
    ? src.sessionOrder
    : {};
  let dirs = 0;
  for (const [dirId, order] of Object.entries(bySrcDir)) {
    if (dirs >= MAX_DIRS) break;
    if (typeof dirId !== 'string' || !dirId || dirId.length > MAX_ID_LENGTH) continue;
    if (knownDirIds && !knownDirIds.has(dirId)) continue;
    const known = sessionIdsByDir ? sessionIdsByDir.get(dirId) : null;
    // A directory whose sessions are all gone leaves no entry rather than an
    // empty array, so an untouched fleet and a fleet dragged back to default
    // are the same document.
    const list = normalizeOrder(order, known);
    if (!list.length) continue;
    layout.sessionOrder[dirId] = list;
    dirs += 1;
  }

  const stamp = typeof src.updatedAt === 'string' && src.updatedAt.trim() ? src.updatedAt.trim() : null;
  layout.updatedAt = stamp && stamp.length <= 40 ? stamp : null;
  return layout;
}

module.exports = {
  SCHEMA_VERSION,
  MAX_IDS,
  MAX_ID_LENGTH,
  MAX_DIRS,
  emptyLayout,
  normalizeOrder,
  normalizeLayout,
};
