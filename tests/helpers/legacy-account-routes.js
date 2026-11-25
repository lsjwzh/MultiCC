'use strict';

// FROZEN ORACLE — the account/login cluster as it was mounted before the
// migration, assembled exactly the way HEAD:server.js assembled it:
//
//   mountCliKeyAccountRoutes(host, { store, sessionPersistence })
//   mountCommandcodeAuthRoutes(host, { directories, createSessionRecord,
//                                       disposeLoginTerminal, getStatus })
//   mountCodexOAuthRoutes(host, { getStatus, directories, createSessionRecord,
//                                 disposeLoginTerminal })
//   mountCodexAccountRoutes(host, { accounts, providers, ..., refresherStatus })
//   mountClaudeAccountRoutes(host, { accounts, providers, credentials, ... })
//   createClaudeOAuthSurface(host, { refresher, directories, persistedSessions,
//                                    destroySessionCascade, sessionPersistence,
//                                    appendEvent, disposeLoginTerminal })
//   mountZcodeAuthRoutes(host) / mountKimiAuthRoutes(host)
//
// The route modules under legacy-account-routes/ are `git show HEAD:src/routes/`
// snapshots with only their relative require paths rewritten — see the header of
// each file. The migration differential
// (docs/rust-migration/differential/account-routes.js) mounts this composition
// over the scripted world (tests/helpers/account-routes-scripted-world.js) and
// compares status, body, headers and the side-effect call sequence with the Rust
// front door, whose host port runs the live modules over the same world.
//
// The live half below is the composition server.js has after the migration: the
// eight modules register on the host capture app behind
// `POST /api/__host/account-routes`, and the two blocking login POSTs stay
// publicly served by Node as login-only mounts.

const path = require('path');

const claudeAccounts = require('./legacy-account-routes/claude-accounts');
const codexAccounts = require('./legacy-account-routes/codex-accounts');
const zcodeAuth = require('./legacy-account-routes/zcode-auth');
const cliKeyAccounts = require('./legacy-account-routes/cli-key-accounts');
const kimiAuth = require('./legacy-account-routes/kimi-auth');
const claudeOAuth = require('./legacy-account-routes/claude-oauth');
const codexOAuth = require('./legacy-account-routes/codex-oauth');
const commandcodeAuth = require('./legacy-account-routes/commandcode-auth');

/** The retired composition: all 34 routes mounted on one public app. */
function mountAccountRoutesLegacy(app, bag) {
  const deps = bag.deps;
  cliKeyAccounts.mountCliKeyAccountRoutes(app, deps.cliKey);
  commandcodeAuth.mountCommandcodeAuthRoutes(app, deps.commandcode);
  codexOAuth.mountCodexOAuthRoutes(app, deps.codexOAuth);
  codexAccounts.mountCodexAccountRoutes(app, deps.codex);
  claudeAccounts.mountClaudeAccountRoutes(app, deps.claude);
  claudeOAuth.createClaudeOAuthSurface(deps.claudeOAuthSurface).mountRoutes(app);
  zcodeAuth.mountZcodeAuthRoutes(app, deps.zcode);
  kimiAuth.mountKimiAuthRoutes(app, deps.kimi);
}

/**
 * The surviving composition: the eight live modules register on the capture app
 * behind `POST /api/__host/account-routes`, and the two blocking login POSTs
 * stay publicly served by Node (`expressApp` is the stub child's real Express
 * app the front door forwards unclaimed paths to).
 */
function mountLiveComposition(expressApp, bag, options = {}) {
  const repo = path.resolve(__dirname, '..', '..');
  const accounts = require(path.join(repo, 'src/routes/account-routes-host'));
  const live = {
    claudeAccounts: require(path.join(repo, 'src/routes/claude-accounts')),
    codexAccounts: require(path.join(repo, 'src/routes/codex-accounts')),
    zcodeAuth: require(path.join(repo, 'src/routes/zcode-auth')),
    cliKeyAccounts: accounts,
    kimiAuth: require(path.join(repo, 'src/routes/kimi-auth')),
    claudeOAuth: require(path.join(repo, 'src/routes/claude-oauth')),
    codexOAuth: accounts,
    commandcodeAuth: accounts,
  };
  const deps = bag.deps;
  const host = accounts.createAccountRoutesHost();
  live.cliKeyAccounts.mountCliKeyAccountRoutes(host.app, deps.cliKey);
  live.commandcodeAuth.mountCommandcodeAuthRoutes(host.app, deps.commandcode);
  live.codexOAuth.mountCodexOAuthRoutes(host.app, deps.codexOAuth);
  live.codexAccounts.mountCodexAccountRoutes(host.app, deps.codex);
  live.claudeAccounts.mountClaudeAccountRoutes(host.app, deps.claude);
  live.claudeOAuth.createClaudeOAuthSurface(deps.claudeOAuthSurface).mountRoutes(host.app);
  live.zcodeAuth.mountZcodeAuthRoutes(host.app, deps.zcode);
  live.kimiAuth.mountKimiAuthRoutes(host.app, deps.kimi);
  host.mountRoute(expressApp, options);
  // The two blocking login flows remain public Node routes (login-only mounts).
  live.zcodeAuth.mountZcodeAuthLoginRoute(expressApp, deps.zcode);
  live.kimiAuth.mountKimiAuthLoginRoute(expressApp, deps.kimi);
  return { host };
}

module.exports = { mountAccountRoutesLegacy, mountLiveComposition };
