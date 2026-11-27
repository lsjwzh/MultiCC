'use strict';

const { getNative, assignHostProperty } = require('../native/binding');
function installNativeQueue(ws, host, id, ports, registry) {
  return getNative().installWsQueue(ws, host, id, ports, registry, assignHostProperty);
}
module.exports = { installNativeQueue };
