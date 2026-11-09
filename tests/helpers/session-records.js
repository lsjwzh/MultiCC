'use strict';

// Test-only construction of the live session-record table. The owner is
// native (src/session/records.js); this helper only saves call sites from
// spelling out the boot-import shape.
const { createSessionRecords, appendClassifyHistory, resetTaskState } = require('../../src/session/records');

// `recordsOf([[id, record], ...])` — the same shape `new Map(entries)` took.
function recordsOf(entries = []) {
  return createSessionRecords(new Map(entries));
}

module.exports = { recordsOf, createSessionRecords, appendClassifyHistory, resetTaskState };
