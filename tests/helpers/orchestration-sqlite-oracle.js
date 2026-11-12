'use strict';

// Independent read-only test oracle. Never imported by production or tooling.
const crypto = require('node:crypto');
const {
  OrchestrationStoreCorruptError, _initialState: initialState, _validateState: validateState,
} = require('../../src/orchestration/store');
const DATABASE_SCHEMA_VERSIONS = new Set([1, 2]);
const COLLECTIONS = Object.freeze([
  'waits',
  'outbox',
  'operations',
  'tasks',
  'sessionSchedules',
]);
const TABLES = Object.freeze({
  waits: 'orchestration_waits',
  outbox: 'orchestration_outbox',
  operations: 'orchestration_operations',
  tasks: 'orchestration_tasks',
  sessionSchedules: 'orchestration_session_schedules',
});
function isObject(value) {
  return value !== null && typeof value === 'object';
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
  return result;
}

function stateDigest(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function readMeta(db, key) {
  const row = db.prepare('SELECT value_json FROM orchestration_meta WHERE key = ?').get(key);
  if (!row) return undefined;
  try { return JSON.parse(row.value_json); } catch (cause) {
    throw new OrchestrationStoreCorruptError(`invalid SQLite orchestration metadata: ${key}`, { cause });
  }
}

function parseRow(row, file, collection) {
  try { return JSON.parse(row.data_json); } catch (cause) {
    throw new OrchestrationStoreCorruptError(
      `invalid ${collection} row ${row.record_key} in ${file}`,
      { file, collection, key: row.record_key, cause },
    );
  }
}

function loadDatabaseState(db, file) {
  const databaseSchemaVersion = readMeta(db, 'databaseSchemaVersion');
  if (!DATABASE_SCHEMA_VERSIONS.has(databaseSchemaVersion)) {
    throw new OrchestrationStoreCorruptError(
      `unsupported orchestration SQLite schema in ${file}: ${databaseSchemaVersion}`,
      { file },
    );
  }
  const state = initialState();
  state.schemaVersion = readMeta(db, 'stateSchemaVersion');
  state.revision = readMeta(db, 'revision');
  state.updatedAt = readMeta(db, 'updatedAt');
  state.nextOutboxSequence = readMeta(db, 'nextOutboxSequence');

  for (const collection of COLLECTIONS) {
    const keyColumn = collection === 'sessionSchedules' ? 'session_id' : 'id';
    const hasBodies = databaseSchemaVersion === 2 && collection !== 'sessionSchedules';
    const query = !hasBodies
      ? `SELECT ${keyColumn} AS record_key, data_json FROM ${TABLES[collection]} ORDER BY ${keyColumn}`
      : `SELECT receipt.${keyColumn} AS record_key, receipt.body_ref,
          CASE WHEN receipt.body_ref=1 THEN body.data_json ELSE receipt.data_json END AS data_json
        FROM ${TABLES[collection]} AS receipt
        LEFT JOIN orchestration_record_bodies AS body
          ON body.collection=? AND body.record_key=receipt.${keyColumn}
        ORDER BY receipt.${keyColumn}`;
    const rows = hasBodies ? db.prepare(query).all(collection) : db.prepare(query).all();
    for (const row of rows) {
      if (row.body_ref === 1 && row.data_json == null) {
        throw new OrchestrationStoreCorruptError(
          `missing ${collection} body ${row.record_key} in ${file}`,
          { file, collection, key: row.record_key },
        );
      }
      state[collection][row.record_key] = parseRow(row, file, collection);
    }
  }
  for (const row of db.prepare(
    'SELECT key AS record_key, data_json FROM orchestration_extras ORDER BY key',
  ).all()) {
    state[row.record_key] = parseRow(row, file, 'extras');
  }
  return validateState(state, file);
}

module.exports = { _loadDatabaseState: loadDatabaseState, _stateDigest: stateDigest };
