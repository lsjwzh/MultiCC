'use strict';

// Only fixed Rust commands may use the synchronous transaction boundary.
// A null-prototype envelope prevents the queue Promise from assimilating a
// command result (or an inherited/mutable `then`) before the caller unwraps it.
const { getNative } = require('../native/runtime');
const { types: { isPromise } } = require('node:util');
const promiseThen = Promise.prototype.then;

function invokeNativeCommand(name, draft, args, snapshot = draft) {
  let exportName;
  switch (name) {
    case 'waitResolve': exportName = 'waitResolveLive'; break;
    case 'outboxClaim': exportName = 'outboxClaimLive'; break;
    case 'scheduleComplete': exportName = 'scheduleCompleteLive'; break;
    case 'scheduleAdmit': exportName = 'scheduleAdmitLive'; break;
    case 'scheduleRecover': exportName = 'scheduleRecoverLive'; break;
    default: throw new TypeError('unknown synchronous orchestration command');
  }
  const native = getNative();
  const command = native[exportName];
  if (typeof command !== 'function') throw new Error(`missing Rust orchestration command: ${exportName}`);
  const result = Reflect.apply(command, native,
    name === 'outboxClaim' ? [snapshot, draft, ...args] : [draft, ...args]);
  if (isPromise(result)) {
    // Observe a rejected native Promise without awaiting it. This is defensive:
    // the allowlisted N-API commands are required to return synchronously.
    Reflect.apply(promiseThen, result, [undefined, () => {}]);
    throw new TypeError('synchronous Rust orchestration command returned a promise');
  }
  return result;
}

function commandEnvelope(value) {
  const envelope = Object.create(null);
  Object.defineProperty(envelope, 'value', { value, enumerable: true });
  return envelope;
}
module.exports = { invokeNativeCommand, commandEnvelope };
