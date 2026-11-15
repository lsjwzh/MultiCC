'use strict';

// One scripted world, built twice: once for the frozen oracle inside the
// differential process and once inside the gateway's stub Node child. Both
// sides therefore read the same session records, the same chat transcript, the
// same workspace maps and the same hibernation/orphan answers; only the store
// roots differ (`node-data` / `gw-data`), exactly as they would in production.
//
// The machine registry, the share store and the versioned-HTML writer are the
// live modules: those are the Node facts the front door keeps. The three route
// layers are mounted from the frozen copies next to this file.

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '../../..');

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of String(header).split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key.trim()] = rest.join('=').trim();
  }
  return cookies;
}

/** A hibernation runtime stub; `{ throw: true }` makes sweep reject. */
function hibernationStub(script) {
  return {
    status: () => script.status || null,
    sweep: async () => {
      if (script.throw) throw new Error('hibernation sweep exploded');
      return script.sweep || {};
    },
  };
}

/** An orphan-worktree scanner stub. */
function orphanScannerStub(script) {
  return {
    report: () => script.report || null,
    scan: async () => {
      if (script.throw) throw new Error('orphan scan exploded');
      return script.scan || null;
    },
  };
}

/**
 * @param {object} options
 * @param {string} options.dataRoot   the side's data root (`MULTICC_DATA_DIR`)
 * @param {object} options.scenario   one case's scripted facts
 * @param {Function} options.express  the Express factory from the host
 * @param {object} options.authSecurity  the runtime the machine handlers verify against
 * @param {object} [options.machinesModule]  which machines module to use
 *        (`src/machines.js` for the live host, the frozen copy for the oracle)
 */
function buildWorld({ dataRoot, scenario, express, authSecurity, machinesModule, repo = REPO }) {
  const machines = (machinesModule || require(path.join(repo, 'src/machines')))
    .createMachineRuntime({ root: dataRoot, authSecurity, getWss: () => null });
  const shareStore = require(path.join(repo, 'src/share'));
  const { createStaticAssetsRoutes } = require(path.join(repo, 'src/routes/static-assets'));
  const { serveHtml } = createStaticAssetsRoutes({
    express, fs, path, publicDir: path.join(repo, 'public'),
  });
  const sessions = new Map((scenario.sessions || []).map(record => [record.id, record]));
  const history = scenario.history || [];
  const page = scenario.page || { messages: [], hasMore: false };
  return {
    machines,
    share: {
      share: shareStore,
      persistedSessions: { get: id => sessions.get(id) },
      loadChatHistory: () => history.map(message => ({ ...message })),
      viewChatHistory: () => history.map(message => ({ ...message })),
      paginateChatHistory: () => ({ ...page }),
      parseCookies,
      // Swallowed, like the real logger in a test process: a route failure
      // shows up as its status, never as noise on stdout.
      logger: { error() {} },
      chatPageFile: scenario.chatPageFile,
      serveHtml,
    },
    workspaces: {
      records: new Map(Object.entries(scenario.records || {})),
      directories: new Map(Object.entries(scenario.directories || {})),
      getHibernation: () => (scenario.hibernation ? hibernationStub(scenario.hibernation) : null),
      getOrphanScanner: () => (scenario.orphan ? orphanScannerStub(scenario.orphan) : null),
    },
  };
}

module.exports = { buildWorld, parseCookies, REPO };
