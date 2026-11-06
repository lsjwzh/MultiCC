'use strict';
const { getNative } = require('../native/runtime');
function credential(input) {
  return JSON.parse(getNative().providerCredential(JSON.stringify(input)));
}
async function readCli(input) {
  return JSON.parse(await getNative().readProviderCliCredential(JSON.stringify(input)));
}
module.exports = { credential, readCli };
