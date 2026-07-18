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
const { createFsDirectoryRepository } = require('./repository');
const { createDirectoryService } = require('./service');
const { createDirectoryRouter } = require('./controller');

function createDirectoryModule({ repository, git, sessions, events, fsPort, helpers, tx }) {
  const repo = createFsDirectoryRepository({ ...repository, realPathOf: helpers.realPathOf });
  const service = createDirectoryService({ repo, git, sessions, events, fsPort, helpers, tx });
  const router = createDirectoryRouter(service);
  return { repo, service, router };
}

module.exports = { createDirectoryModule };
