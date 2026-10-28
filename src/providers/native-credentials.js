'use strict';
const { getNative } = require('../native/runtime');
function credential(input) {
  return JSON.parse(getNative('provider_credentials', 'rust').providerCredential(JSON.stringify(input)));
}
async function readCli(input) {
  return JSON.parse(await getNative('provider_credentials', 'rust').readProviderCliCredential(JSON.stringify(input)));
}
module.exports = { credential, readCli };
