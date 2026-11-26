'use strict';
const { getNative } = require('../../src/native/binding');
function run(operation, fields) {
  const result = JSON.parse(getNative().acpBridgeKernel(JSON.stringify({ operation, ...fields })));
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
module.exports = {
  parseArgs: args => run('parseArgs', { args }),
  pickPermissionOption: options => run('pickPermissionOption', { options }),
  routerMcpServers: (router, env) => run('routerMcpServers', { router, env }),
};
