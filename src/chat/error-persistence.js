'use strict';

const { createErrorPersister, getNative } = require('../native/binding');
function isRecoverableReconnect(text) {
  return getNative().chatRecoverableReconnect(String(text || '').trim());
}
module.exports = { createErrorPersister, isRecoverableReconnect };
