'use strict';

// Native adapter only. History lookup, missing/ambiguous decisions and checked
// copies run on the Rust worker; there is no Node implementation or fallback.
const os = require('node:os');
const { getNative } = require('../native/runtime');

async function prepareCliSwitchRoute(input) {
  return JSON.parse(await getNative().prepareCliSwitchRoute(JSON.stringify({
    homeDir: os.homedir(), ...input,
  })));
}

module.exports = { prepareCliSwitchRoute };
