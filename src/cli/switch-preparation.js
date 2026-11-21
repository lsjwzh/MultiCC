'use strict';

// Native adapter only. History lookup, missing/ambiguous decisions and checked
// copies run on the Rust worker; there is no Node implementation or fallback.
const os = require('node:os');
const { getNative, nativeCode } = require('../native/runtime');

async function prepareCliSwitchRoute(input) {
  return JSON.parse(await getNative().prepareCliSwitchRoute(JSON.stringify({
    homeDir: os.homedir(), ...input,
  })));
}

async function synchronizeCodexProfileRoute(route) {
  try {
    return await prepareCliSwitchRoute({ ...route, cli: 'codex', synchronizeProfile: true });
  } catch (error) {
    throw nativeCode(error);
  }
}

module.exports = { prepareCliSwitchRoute, synchronizeCodexProfileRoute };
