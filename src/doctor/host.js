'use strict';
// Composition for the session doctor and its environment sibling: wires the
// Aux HTTP target and the host's session/history accessors into the services
// and mounts their routes.
const os = require('os');
const path = require('path');
const { createDoctorService } = require('./service');
const { createEnvironmentDoctor } = require('./environment');
const { mountDoctorRoutes } = require('../routes/doctor');
const { mountEnvDoctorRoutes } = require('../routes/env-doctor');
const { probeEnv, execShell } = require('../routes/ops-terminal');

function mountDoctor(app, { persistedSessions, loadChatHistory, cwdForSession, auxQueue, getAuxConfig, rootDir, dataDir }) {
  const resolveTarget = () => {
    const target = auxQueue.resolveHttpTarget();
    return { target, model: getAuxConfig().model || target.model || (target.modelOptions || [])[0] || '' };
  };
  mountEnvDoctorRoutes(app, {
    doctor: createEnvironmentDoctor({ resolveTarget, probe: () => probeEnv(execShell, process.platform) }),
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
  mountDoctorRoutes(app, { doctor });
  return doctor;
}

module.exports = { mountDoctor };
