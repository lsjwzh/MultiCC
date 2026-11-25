'use strict';
// Composition for the session doctor and its environment sibling: wires the
// Aux HTTP target and the host's session/history accessors into the services
// used by the Rust gateway through the host operations port.
const os = require('os');
const path = require('path');
const { createDoctorService } = require('../../../src/doctor/service');
const { createEnvironmentDoctor } = require('../../../src/doctor/environment');
const { probeEnv, execShell } = require('../../../src/routes/ops-terminal');

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

module.exports = { createDoctorHost };
