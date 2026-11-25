'use strict';
// Directory-domain composition root. server.js supplies the runtime adapters
// (git/session/event/fs implementations bound to its live state); this factory
// wires the native-backed repository, the ui-layout state store and the Node
// host port the Rust front door asks about them.
//
// `tx` is the native cross-file transaction binding (the shared state owner).
// Directory deletion updates directories.json + sessions.json under one journal
// entry in Rust; the host port never builds the payload pair itself.
const path = require('path');

const { createFsDirectoryRepository } = require('../native/runtime');
const { createUiLayoutStore } = require('./ui-layout');
const { createDirectoryHost } = require('../routes/directory-host');

function createDirectoryModule({ repository, git, sessions, events, fsPort, helpers, tx, logger }) {
  const repo = createFsDirectoryRepository({ ...repository, realPathOf: helpers.realPathOf });
  // The user's drag-and-drop arrangement of the grid and of each fleet's
  // session list. Server-side on purpose: it used to live in localStorage /
  // SharedPreferences, so every new browser or phone started from scratch.
  // Defaults to sitting next to directories.json when the caller doesn't say.
  const uiLayout = createUiLayoutStore({
    file: repository.uiLayoutFile || path.join(path.dirname(repository.file), 'ui-layout.json'),
    logger,
    listDirIds: () => repo.map().keys(),
    listSessionIds: dirId => (sessions && typeof sessions.listByDir === 'function'
      ? sessions.listByDir(dirId) : []).map(s => s.id),
  });
  const host = createDirectoryHost({ repo, git, sessions, events, fsPort, helpers, tx, uiLayout, logger });
  return { repo, host };
}

module.exports = { createDirectoryModule };
