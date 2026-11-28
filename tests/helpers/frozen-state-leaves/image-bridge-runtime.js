// Frozen at 92f9dbae; module paths point back into the host under test.
'use strict';

const os = require('node:os');
const path = require('node:path');
const { officialAccountIdFromProvider } = require('../frozen-bc29761b/official-accounts');
// Capture the assembled ports without launching an image worker.
const createOfficialImageBridge = ports => ports;

function createOfficialImageBridgeRuntime({ paths, resolveSessionCwd, providers, officialAccounts, registerArtifact, codexCommand } = {}) {
  return createOfficialImageBridge({
    artifactsDir: paths.artifactsDir,
    resolveSessionCwd,
    getProvider: (appType, id) => providers.getProvider(appType, id),
    resolveAuthFile: provider => {
      const accountId = officialAccountIdFromProvider(provider);
      return accountId ? officialAccounts.codexAuthFile(accountId) : path.join(os.homedir(), '.codex', 'auth.json');
    },
    // This is intentionally independent of the current chat CLI: a Claude
    // chat can ask the host-owned MCP to use a directly logged-in Codex CLI.
    fallbackAuthFiles: () => [
      path.join(os.homedir(), '.codex', 'auth.json'),
      ...officialAccounts.listCodexAccounts()
        .filter(account => account.loggedIn && !account.expired)
        .map(account => officialAccounts.codexAuthFile(account.id)),
    ],
    registerArtifact,
    codexCommand,
  });
}

module.exports = { createOfficialImageBridgeRuntime };
