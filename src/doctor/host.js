'use strict';
// Composition for the session doctor and its environment sibling: wires the
// Aux HTTP target and the host's session/history accessors into the services
// and (for the legacy direct mount) registers their routes.
//
// Both route groups are now owned by the Rust front door
// (`native/gateway/src/app/host_ops_routes.rs`): `src/routes/host-ops-host.js`
// mounts them on its capture app. `createDoctorHost` builds the two service
// instances; `mountDoctor` is kept for callers that still mount the Express
// routes directly (the unit tests).
const os = require('os');
const path = require('path');
const { createDoctorService } = require('./service');
const { createEnvironmentDoctor } = require('./environment');
const { mountDoctorRoutes } = require('../routes/doctor');
const { mountEnvDoctorRoutes } = require('../routes/env-doctor');
const { probeEnv, execShell } = require('../routes/ops-terminal');

function createDoctorHost({ persistedSessions, loadChatHistory, cwdForSession, auxQueue, getAuxConfig, rootDir, dataDir }) {
  const resolveTarget = () => {
    const target = auxQueue.resolveHttpTarget();
    return { target, model: getAuxConfig().model || target.model || (target.modelOptions || [])[0] || '' };
  };
  const envDoctor = createEnvironmentDoctor({
    resolveTarget,
    probe: () => probeEnv(execShell, process.platform),
  });
  const doctor = createDoctorService({
    getSession: id => persistedSessions.get(id),
    loadHistory: loadChatHistory,
    cwdOf: cwdForSession,
    resolveTarget,
    repoRoot: rootDir,
    dataDir,
    logDirs: [path.join(rootDir, 'logs'), path.join(os.homedir(), '.pm2', 'logs')],
    serverPid: process.pid,
  });
  return { doctor, envDoctor };
}

function mountDoctor(app, deps) {
  const { doctor, envDoctor } = createDoctorHost(deps);
  mountEnvDoctorRoutes(app, { doctor: envDoctor });
  mountDoctorRoutes(app, { doctor });
  return doctor;
}

module.exports = { createDoctorHost, mountDoctor };
