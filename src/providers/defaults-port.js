'use strict';

// All callers share the same native owner. The proxy holds no defaults data;
// it only preserves the existing object-shaped read interface during migration.
const path = require('node:path');
const { getNative } = require('../native/runtime');
const owners = new Map();

function getProviderDefaultsOwner(file) {
  const key = path.resolve(file);
  if (!owners.has(key)) owners.set(key, new (getNative().RustProviderDefaultsStore)(key));
  return owners.get(key);
}

function providerDefaultsView(owner) {
  return new Proxy({}, {
    get(target, key, receiver) {
      if (typeof key !== 'string') return Reflect.get(target, key, receiver);
      const snapshot = owner.snapshot();
      return Object.prototype.hasOwnProperty.call(snapshot, key) ? owner.get(key) : Reflect.get(target, key, receiver);
    },
    set(target, key, value, receiver) {
      if (typeof key !== 'string') return Reflect.set(target, key, value, receiver);
      owner.set(key, value);
      return true;
    },
    deleteProperty(target, key) {
      if (typeof key !== 'string') return Reflect.deleteProperty(target, key);
      owner.delete(key);
      return true;
    },
    ownKeys(target) { return [...Reflect.ownKeys(owner.snapshot()), ...Reflect.ownKeys(target)]; },
    getOwnPropertyDescriptor(target, key) {
      if (typeof key !== 'string') return Reflect.getOwnPropertyDescriptor(target, key);
      const snapshot = owner.snapshot();
      return Object.prototype.hasOwnProperty.call(snapshot, key)
        ? { value: snapshot[key], writable: true, enumerable: true, configurable: true }
        : Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
}

module.exports = { getProviderDefaultsOwner, providerDefaultsView };
