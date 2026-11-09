'use strict';

// Test-only construction of the live session-record table. The owner is
// native; this helper only saves call sites from spelling out the boot-import
// shape and the shared owner.
const {
  createSessionRecords: createSessionTable,
  appendClassifyHistory,
  resetTaskState,
} = require('../../src/session/records');
const { createStateOwner } = require('../../src/state/owner');

// A session-only world gets its own owner; production passes one owner for the
// session table, the directory table and the journal.
function createSessionRecords(source) {
  return createSessionTable(source, createStateOwner());
}

// `recordsOf([[id, record], ...])` — the same shape `new Map(entries)` took.
function recordsOf(entries = []) {
  return createSessionRecords(new Map(entries));
}

module.exports = { recordsOf, createSessionRecords, appendClassifyHistory, resetTaskState };
