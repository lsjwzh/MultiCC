'use strict';
const { getNative, assignHostProperty } = require('../../src/native/binding');
module.exports = {
  stageConfiguration: (session, draft, options) => getNative().sessionPendingStageConfiguration(session, draft, options, assignHostProperty),
};
