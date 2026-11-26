'use strict';

// FROZEN ORACLE — the session-management cluster as it was mounted before the
// migration, assembled exactly the way HEAD:server.js assembled it:
//
//   mountSessionCreateRoutes(app, deps.create)
//   createSessionProfileRoutes(deps.profile).mountRoutes(app)
//   mountSessionMemoryRoutes(app, deps.memory)
//   createSessionBundleRoutes(deps.bundle).mountRoutes(app)
//   createSessionLifecycleRuntime(deps.lifecycle).mountRoutes(app)
//   createSessionMetaRuntime(deps.meta).mountRoutes(app)
//
// The route modules under legacy-session-routes/ are `git show HEAD:src/routes/`
// snapshots (the parent of the migration commit) with only their relative
// require paths rewritten — see the header of each file. The migration
// differential (docs/rust-migration/differential/session-routes.js) mounts this
// over the same scripted world (tests/helpers/session-routes-scripted-world.js)
// the Rust front door calls through its host port, and compares status, body,
// headers and the side-effect call sequence.
//
// The live modules are still required underneath by the "current" composition
// below — the split itself is what is being compared, so the stub Node child
// mounts the surviving host port over the very same world.

const path = require('path');

const memory = require('./legacy-session-routes/session-memory');
const bundle = require('./legacy-session-routes/session-bundle');
const lifecycle = require('./legacy-session-routes/session-lifecycle');
const create = require('./legacy-session-routes/session-create');
const meta = require('./legacy-session-routes/session-meta');
const profile = require('./legacy-session-routes/session-profile');

/** The retired composition: all twenty routes mounted on one public app. */
function mountSessionRoutesLegacy(app, bag) {
  const deps = bag.deps;
  create.mountSessionCreateRoutes(app, deps.create);
  profile.createSessionProfileRoutes(deps.profile).mountRoutes(app);
  memory.mountSessionMemoryRoutes(app, deps.memory);
  bundle.createSessionBundleRoutes(deps.bundle).mountRoutes(app);
  lifecycle.createSessionLifecycleRuntime(deps.lifecycle).mountRoutes(app);
  meta.createSessionMetaRuntime(deps.meta).mountRoutes(app);
}

/**
 * The surviving composition: the six live modules register on the capture app
 * behind `POST /api/__host/session-routes`, and the two binary transports
 * (`bundle.zip`, `import-zip`) stay publicly served by Node. `expressApp` is the
 * stub child's real Express app the front door forwards unclaimed paths to.
 */
function mountLiveComposition(expressApp, bag, options = {}) {
  const repo = path.resolve(__dirname, '..', '..');
  const { createSessionRoutesHost, createSessionMetaRuntime } = require(path.join(repo, 'src/routes/session-routes-host'));
  const live = {
    create: require(path.join(repo, 'src/routes/session-create')),
    profile: require(path.join(repo, 'src/routes/session-profile')),
    memory: require(path.join(repo, 'src/routes/session-memory')),
    bundle: require(path.join(repo, 'src/routes/session-bundle')),
    lifecycle: require(path.join(repo, 'src/routes/session-lifecycle')),
  };
  const deps = bag.deps;
  const host = createSessionRoutesHost();
  live.create.mountSessionCreateRoutes(host.app, deps.create);
  live.profile.createSessionProfileRoutes(deps.profile).mountRoutes(host.app);
  live.memory.mountSessionMemoryRoutes(host.app, deps.memory);
  const bundleRuntime = live.bundle.createSessionBundleRoutes(deps.bundle);
  bundleRuntime.mountRoutes(host.app);
  live.lifecycle.createSessionLifecycleRuntime(deps.lifecycle).mountRoutes(host.app);
  createSessionMetaRuntime(deps.meta).mountRoutes(host.app);
  host.mountRoute(expressApp, options);
  // The zip transports remain public Node routes.
  bundleRuntime.mountRoutes(expressApp);
  return { host, bundleRuntime };
}

module.exports = { mountSessionRoutesLegacy, mountLiveComposition };
