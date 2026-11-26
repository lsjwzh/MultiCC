'use strict';

const { getNative } = require('../../native/binding');
module.exports = getNative().taskBoardCoreApi({
  planning: require('../planning'),
  normalize: require('../normalize'),
  bridge: require('../native-bridge'),
  routing: require('../routing'),
});
