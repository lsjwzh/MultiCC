'use strict';

const path = require('node:path');
const { getNative, findSakuraLauncher, restartSakuraLauncher, diagnoseSakurafrp } = require('../native/binding');
const { atomicWriteJson } = require('../runtime-security');
const { createTailscaleFunnelProbe } = require('../tailscale-funnel-health');
const { readLauncherToken, getUserInfo, discoverAccess } = require('../tunnel-sakurafrp-api');

module.exports = getNative().tunnelMonitorApi({
  pkgRoot: path.resolve(__dirname, '../..'), path, process,
  fs: require('node:fs'), os: require('node:os'),
  http: require('node:http'), https: require('node:https'),
  execFile: require('node:child_process').execFile,
  atomicWriteJson, createTailscaleFunnelProbe, findSakuraLauncher, restartSakuraLauncher,
  diagnoseSakurafrp, readLauncherToken, getUserInfo, discoverAccess,
});
