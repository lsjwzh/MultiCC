'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { orchestrationJsonPorts } = require('../native/binding');

class OrchestrationStoreCorruptError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'OrchestrationStoreCorruptError';
    this.code = 'ORCHESTRATION_STORE_CORRUPT';
    Object.assign(this, meta);
  }
}

// The V8 facade preserves the original async/ordinary function types. The
// native runtime holds the underlying store directly for internal operations.
function publicStore(store) {
  async function mutate(mutator) { return store.mutate(mutator); }
  async function mutateIf(predicate, mutator, skippedResult) { return store.mutateIf(predicate, mutator, skippedResult); }
  function runNativeCommandSync(name, ...args) { return store.runNativeCommandSync(name, ...args); }
  function read(selector) { return store.read(selector); }
  return Object.freeze({ backend: store.backend, file: store.file, mutate, mutateIf,
    runNativeCommandSync, read, snapshot: () => store.snapshot(), flush: () => store.flush() });
}

// CommonJS imports, including the SQLite host, can inspect the schema and
// error class before the native backend has loaded.
const ports = orchestrationJsonPorts(createOrchestrationStore, { fs, path, publicStore, CorruptError: OrchestrationStoreCorruptError });
let api;
function nativeApi() { return api ??= ports.getNative().orchestrationJsonApi(ports); }
function createOrchestrationStore(options = {}) { return publicStore(nativeApi().createOrchestrationStore(options)); }
function cloneJson(value) { return nativeApi()._cloneJson(value); }
function deepFreeze(value) { return nativeApi()._deepFreeze(value); }
function initialState() { return nativeApi()._initialState(); }
function loadState(options) { return nativeApi()._loadState(options); }
function validateState(input, file) { return nativeApi()._validateState(input, file); }
function writeAtomic(options) { return nativeApi()._writeAtomic(options); }
module.exports = { SCHEMA_VERSION: 3, OrchestrationStoreCorruptError, createOrchestrationStore,
  _cloneJson: cloneJson, _deepFreeze: deepFreeze, _initialState: initialState, _loadState: loadState,
  _validateState: validateState, _writeAtomic: writeAtomic };
