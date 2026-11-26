'use strict';

// V8 host ports for the native session-work coordinator.
const { getNative } = require('../native/binding');
const native = getNative();
module.exports = {
  ...native.sessionWorkSchedulerApi(),
  ...native.sessionWorkHostApi({
    crypto: require('node:crypto'),
    zcodeAuth: require('../cli-adapters/zcode-auth'),
    kimiAuth: require('../cli-adapters/kimi-auth'),
    createQuestionOwner: require('../orchestration/native-store-host').createQuestionOwner,
  }),
};
