'use strict';
// Directory-domain composition root. server.js supplies the port adapters
// (git/session/event/fs implementations bound to its runtime state); this
// factory wires repository → service → controller and hands back all three so
// the caller can mount the router and keep legacy access to the repo Map.
//
// `tx` is the cross-file transaction binding (paths + commit function) so
// directory deletion updates directories.json + sessions.json under one
// journal entry. Omitting `tx` falls back to the pre-transaction save order —
// unit tests use that path so they don't need a real filesystem.
const path = require('path');

const { createFsDirectoryRepository } = require('./repository');
const { createDirectoryService } = require('./service');
const { createDirectoryRouter } = require('./controller');
const { createUiLayoutRuntime } = require('./ui-layout');

function createDirectoryModule({ repository, git, sessions, events, fsPort, helpers, tx }) {
  const repo = createFsDirectoryRepository({ ...repository, realPathOf: helpers.realPathOf });
  const service = createDirectoryService({ repo, git, sessions, events, fsPort, helpers, tx });
  const router = createDirectoryRouter(service);
  // The user's drag-and-drop arrangement of the grid and of each fleet's session
  // list. Server-side on purpose: it used to live in localStorage /
  // SharedPreferences, so every new browser or phone started from scratch.
  // Defaults to sitting next to directories.json when the caller doesn't say.
  const uiLayout = createUiLayoutRuntime({
    file: repository.uiLayoutFile || path.join(path.dirname(repository.file), 'ui-layout.json'),
    listDirIds: () => repo.map().keys(),
    listSessionIds: dirId => (sessions && typeof sessions.listByDir === 'function'
      ? sessions.listByDir(dirId) : []).map(s => s.id),
  });
  uiLayout.mountRoutes(router);
  return { repo, service, router, uiLayout };
}

module.exports = { createDirectoryModule };
