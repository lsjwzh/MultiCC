'use strict';
const { createUnlockPassword, MAX_UNLOCK_PASSWORD_LENGTH } = require('./native/binding');
module.exports = { createUnlockPassword, SERVICE: 'com.multicc.agent.unlock', MAX_PASSWORD_LENGTH: MAX_UNLOCK_PASSWORD_LENGTH };
