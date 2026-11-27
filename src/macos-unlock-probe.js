'use strict';
const { createUnlockProbe } = require('./native/binding');
module.exports = { createUnlockProbe, PROBE_SECONDS: 8, PROBE_TIMEOUT_MS: 10000 };
