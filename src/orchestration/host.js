'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const { getNative, orchestrationJsonPorts } = require('../native/binding');
const { createOrchestrationStore } = require('./json-store-host');
const { createOrchestrationSqliteStore } = require('./sqlite-store');
const { createOutbox } = require('../outbox');
const { createWaitService } = require('../wait/service');
const { createOperationService, TERMINAL_OPERATION_STATES, TERMINAL_TASK_STATES } = require('../operation-service');

// The compatibility host supplies live service factories. Each native runtime
// creates its own async context for reentrant delivery, including across I/O.
function asyncMethod(native) {
  const method = async (...args) => native(...args);
  Object.defineProperties(method, { name: { value: native.name }, length: { value: native.length } });
  return method;
}

const ports = {
  asyncMethod,
  crypto, process, AsyncLocalStorage, createOrchestrationStore, createOrchestrationSqliteStore,
  createOutbox, createWaitService, createOperationService,
  TERMINAL_OPERATION_STATES, TERMINAL_TASK_STATES, jsonStorePorts: orchestrationJsonPorts(createOrchestrationStore),
};
let api;
function runtimeApi() { return api ??= getNative().orchestrationRuntimeApi(ports); }

module.exports = {
  createOrchestrationRuntime: (options = {}) => runtimeApi().createOrchestrationRuntime(options),
  publicWait: wait => runtimeApi().publicWait(wait),
  get DEFAULTS() { return runtimeApi().DEFAULTS; },
};
