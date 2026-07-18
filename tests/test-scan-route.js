'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createScanHistoryHandler, mountScanRoutes } = require('../src/routes/scan');

function invoke(query = {}) {
  const scanHistory = { seq: 9, passes: [{ id: 3 }, { id: 2 }, { id: 1 }] };
  let body;
  createScanHistoryHandler({ scanHistory, maxPasses: 2 })({ query }, {
    json(value) { body = value; },
  });
  return body;
}

test('scan history response preserves the legacy DTO and default limit', () => {
  assert.deepEqual(invoke(), {
    seq: 9,
    kept: 3,
    passes: [{ id: 3 }, { id: 2 }],
  });
});

test('scan history limit is parsed and capped without exposing the ring object', () => {
  const body = invoke({ limit: '1' });
  assert.deepEqual(body.passes, [{ id: 3 }]);
  assert.notEqual(body.passes, undefined);
  assert.equal(invoke({ limit: '999' }).passes.length, 2);
});

test('scan route mount owns only the existing GET endpoint', () => {
  const registrations = [];
  mountScanRoutes({ get(path, handler) { registrations.push({ path, handler }); } }, {
    scanHistory: { seq: 0, passes: [] },
    maxPasses: 20,
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].path, '/api/scan/history');
  assert.equal(typeof registrations[0].handler, 'function');
});
