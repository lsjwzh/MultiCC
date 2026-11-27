'use strict';
const { getNative, findSakuraLauncher, restartSakuraLauncher, diagnoseSakurafrp } = require('./native/binding');
function processPattern(binary) {
  if (typeof binary === 'string') return getNative().sakuraProcessPattern(binary);
  return '^' + binary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([[:space:]]|$)';
}
module.exports = { findSakuraLauncher, restartSakuraLauncher, processPattern, diagnoseSakurafrp };
