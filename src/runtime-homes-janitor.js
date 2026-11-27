'use strict';
const { createRuntimeHomesJanitor, startRuntimeHomesJanitor, DEFAULT_RUNTIME_HOME_TTL_DAYS } = require('./native/binding');
const HOME_DIR_NAMES = Object.freeze(['codex-session-homes', 'codex-homes', 'codex-attempt-homes', 'zcode-homes']);
module.exports = { createRuntimeHomesJanitor, startRuntimeHomesJanitor, DEFAULT_TTL_DAYS: DEFAULT_RUNTIME_HOME_TTL_DAYS, HOME_DIR_NAMES };
