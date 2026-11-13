'use strict';

// JavaScript callback/Proxy compatibility only. Rust owns database state and
// queries; this transaction-local draft records assignments from JS callers.
const {
  SCHEMA_VERSION, OrchestrationStoreCorruptError,
  _cloneJson: cloneJson, _deepFreeze: deepFreeze, _validateState: validateState,
} = require('./store');
const { types: { isProxy } } = require('node:util');

const COLLECTIONS = Object.freeze([
  'waits',
  'outbox',
  'operations',
  'tasks',
  'sessionSchedules',
]);
const RESERVED_TOP_LEVEL = new Set([
  'schemaVersion',
  'revision',
  'updatedAt',
  'nextOutboxSequence',
  ...COLLECTIONS,
]);

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function currentAtPath(root, path) {
  let value = root;
  for (const part of path) {
    if (!isObject(value)) return undefined;
    value = value[part];
  }
  return value;
}

function jsonEqual(a, b) {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

// Copy-on-write compatibility layer for the existing domain services. Reads
// traverse the frozen snapshot without cloning. The first write to a record
// clones only that record; finish() then reports exactly which rows changed.
function createDraft(base, native) {
  const recordChanges = Object.fromEntries(COLLECTIONS.map(name => [name, new Map()]));
  const extraChanges = new Map();
  const topChanges = new Map();
  const collectionProxies = new Map();
  const pathProxies = new Map();
  const extraPathProxies = new Map();
  const ownedProxies = new WeakSet();
  let active = true;

  function assertActive() {
    if (!active) throw new TypeError('orchestration draft is no longer active');
  }

  // A draft proxy may sit anywhere inside the value being assigned, not only at
  // its top level: `{ ...record.payload, message }` copies nested proxies (e.g.
  // payload.options) into a raw object, and committed state then holds proxies
  // that wrap further proxies — the next read recurses until the stack dies
  // ("Maximum call stack size exceeded"). Detect those descendants too.
  function holdsDraftProxy(value, seen = new WeakSet()) {
    if (!isObject(value)) return false;
    if (ownedProxies.has(value)) return true;
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).some(child => holdsDraftProxy(child, seen));
  }

  function assignedValue(value) {
    // Preserve ordinary raw-object aliasing inside one transaction: several
    // domain mutators insert a record and then continue editing that same raw
    // object. A draft proxy, however, must be materialised so no proxy becomes
    // part of committed state.
    return isObject(value) && holdsDraftProxy(value) ? cloneJson(value) : value;
  }

  function recordValue(collection, key) {
    assertActive();
    const entry = recordChanges[collection].get(key);
    if (entry) return entry.deleted ? undefined : entry.value;
    return base[collection][key];
  }

  function ensureRecordCopy(collection, key) {
    const existing = recordChanges[collection].get(key);
    if (existing && !existing.deleted) return existing.value;
    const current = existing?.deleted ? undefined : base[collection][key];
    if (!isObject(current)) throw new TypeError(`cannot mutate missing ${collection} record ${key}`);
    const value = native.materialize(collection, key);
    recordChanges[collection].set(key, { deleted: false, value });
    return value;
  }

  function pathProxy(collection, key, path = []) {
    const cacheKey = `${collection}\u0000${key}\u0000${path.map(String).join('\u0000')}`;
    if (pathProxies.has(cacheKey)) return pathProxies.get(cacheKey);
    const initial = currentAtPath(recordValue(collection, key), path);
    const target = Array.isArray(initial) ? new Array(initial.length) : {};
    const proxy = new Proxy(target, {
      get(_target, prop, receiver) {
        const current = currentAtPath(recordValue(collection, key), path);
        if (!isObject(current)) return undefined;
        const value = Reflect.get(current, prop, receiver);
        return isObject(value) ? pathProxy(collection, key, [...path, prop]) : value;
      },
      set(_target, prop, value) {
        assertActive();
        const copy = ensureRecordCopy(collection, key);
        const container = currentAtPath(copy, path);
        if (!isObject(container)) return false;
        const written = Reflect.set(container, prop, assignedValue(value));
        if (written && Array.isArray(target)) target.length = container.length;
        return written;
      },
      deleteProperty(_target, prop) {
        assertActive();
        const copy = ensureRecordCopy(collection, key);
        const container = currentAtPath(copy, path);
        return isObject(container) ? Reflect.deleteProperty(container, prop) : true;
      },
      has(_target, prop) {
        const current = currentAtPath(recordValue(collection, key), path);
        return isObject(current) && prop in current;
      },
      ownKeys() {
        const current = currentAtPath(recordValue(collection, key), path);
        return isObject(current) ? Reflect.ownKeys(current) : [];
      },
      getOwnPropertyDescriptor(_target, prop) {
        const current = currentAtPath(recordValue(collection, key), path);
        if (!isObject(current)) return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(current, prop);
        if (!descriptor) return undefined;
        if (Array.isArray(target) && prop === 'length') {
          target.length = current.length;
          return Object.getOwnPropertyDescriptor(target, 'length');
        }
        return { ...descriptor, configurable: true };
      },
      getPrototypeOf() {
        const current = currentAtPath(recordValue(collection, key), path);
        return isObject(current) ? Reflect.getPrototypeOf(current) : Object.prototype;
      },
    });
    ownedProxies.add(proxy);
    pathProxies.set(cacheKey, proxy);
    return proxy;
  }

  function collectionProxy(collection) {
    if (collectionProxies.has(collection)) return collectionProxies.get(collection);
    const proxy = new Proxy({}, {
      get(_target, prop) {
        if (typeof prop === 'symbol') return base[collection][prop];
        const value = recordValue(collection, String(prop));
        return isObject(value) ? pathProxy(collection, String(prop)) : value;
      },
      set(_target, prop, value) {
        assertActive();
        recordChanges[collection].set(String(prop), {
          deleted: false,
          value: assignedValue(value),
        });
        return true;
      },
      deleteProperty(_target, prop) {
        assertActive();
        recordChanges[collection].set(String(prop), { deleted: true });
        return true;
      },
      has(_target, prop) {
        return recordValue(collection, String(prop)) !== undefined;
      },
      ownKeys() {
        const keys = new Set(Object.keys(base[collection]));
        for (const [key, entry] of recordChanges[collection]) {
          if (entry.deleted) keys.delete(key); else keys.add(key);
        }
        return [...keys];
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (recordValue(collection, String(prop)) === undefined) return undefined;
        return { configurable: true, enumerable: true, writable: true, value: undefined };
      },
    });
    ownedProxies.add(proxy);
    collectionProxies.set(collection, proxy);
    return proxy;
  }

  function extraValue(key) {
    assertActive();
    const entry = extraChanges.get(key);
    if (entry) return entry.deleted ? undefined : entry.value;
    return base[key];
  }

  function ensureExtraCopy(key) {
    const entry = extraChanges.get(key);
    if (entry && !entry.deleted) return entry.value;
    const current = entry?.deleted ? undefined : base[key];
    if (!isObject(current)) throw new TypeError(`cannot mutate missing orchestration extra ${key}`);
    const value = native.materialize('extras', key);
    extraChanges.set(key, { deleted: false, value });
    return value;
  }

  function extraPathProxy(key, path = []) {
    const cacheKey = `${key}\u0000${path.map(String).join('\u0000')}`;
    if (extraPathProxies.has(cacheKey)) return extraPathProxies.get(cacheKey);
    const initial = currentAtPath(extraValue(key), path);
    const target = Array.isArray(initial) ? new Array(initial.length) : {};
    const proxy = new Proxy(target, {
      get(_target, prop, receiver) {
        const current = currentAtPath(extraValue(key), path);
        if (!isObject(current)) return undefined;
        const value = Reflect.get(current, prop, receiver);
        return isObject(value) ? extraPathProxy(key, [...path, prop]) : value;
      },
      set(_target, prop, value) {
        assertActive();
        const container = currentAtPath(ensureExtraCopy(key), path);
        if (!isObject(container)) return false;
        const written = Reflect.set(container, prop, assignedValue(value));
        if (written && Array.isArray(target)) target.length = container.length;
        return written;
      },
      deleteProperty(_target, prop) {
        assertActive();
        const container = currentAtPath(ensureExtraCopy(key), path);
        return isObject(container) ? Reflect.deleteProperty(container, prop) : true;
      },
      has(_target, prop) {
        const current = currentAtPath(extraValue(key), path);
        return isObject(current) && prop in current;
      },
      ownKeys() {
        const current = currentAtPath(extraValue(key), path);
        return isObject(current) ? Reflect.ownKeys(current) : [];
      },
      getOwnPropertyDescriptor(_target, prop) {
        const current = currentAtPath(extraValue(key), path);
        if (!isObject(current)) return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(current, prop);
        if (!descriptor) return undefined;
        if (Array.isArray(target) && prop === 'length') {
          target.length = current.length;
          return Object.getOwnPropertyDescriptor(target, 'length');
        }
        return { ...descriptor, configurable: true };
      },
      getPrototypeOf() {
        const current = currentAtPath(extraValue(key), path);
        return isObject(current) ? Reflect.getPrototypeOf(current) : Object.prototype;
      },
    });
    ownedProxies.add(proxy);
    extraPathProxies.set(cacheKey, proxy);
    return proxy;
  }

  function topValue(prop) {
    assertActive();
    if (topChanges.has(prop)) return topChanges.get(prop).deleted
      ? undefined : topChanges.get(prop).value;
    if (extraChanges.has(prop)) return extraChanges.get(prop).deleted
      ? undefined : extraChanges.get(prop).value;
    return base[prop];
  }

  const methods = {
    // The store preloads these keys from the same SQLite read snapshot. The
    // Rust claim kernel still owns filtering/decisions; this is only a proxy
    // materialization shortcut and keeps each collection proxy's identity.
    claimSelect(leased) {
      assertActive();
      if (!native.claimMetadata) return null;
      const keys = leased ? native.claimMetadata.leasedKeys : native.claimMetadata.keys;
      const result = [];
      for (let index = 0; index < keys.length; index++) result[result.length] = collectionProxy('outbox')[keys[index]];
      return result;
    },
    select(collection, options = {}) {
      assertActive();
      const overrides = [...recordChanges[collection]].map(([key, value]) => ({ key, ...value }));
      if (options.fields) return native.query('select', collection, options, overrides);
      return native.query('selectKeys', collection, options, overrides)
        .map(key => collectionProxy(collection)[key]);
    },
    count(collection, where = {}) {
      assertActive();
      const overrides = [...recordChanges[collection]].map(([key, value]) => ({ key, ...value }));
      return native.query('count', collection, { where }, overrides);
    },
  };
  const draft = new Proxy({}, {
    get(_target, prop) {
      assertActive();
      if (Object.hasOwn(methods, prop)) return methods[prop];
      if (COLLECTIONS.includes(prop)) return collectionProxy(prop);
      const value = topValue(prop);
      return !RESERVED_TOP_LEVEL.has(String(prop)) && isObject(value)
        ? extraPathProxy(String(prop))
        : value;
    },
    set(_target, prop, value) {
      assertActive();
      const key = String(prop);
      if (COLLECTIONS.includes(key)) throw new TypeError(`cannot replace orchestration collection ${key}`);
      const target = RESERVED_TOP_LEVEL.has(key) ? topChanges : extraChanges;
      target.set(key, { deleted: false, value: assignedValue(value) });
      return true;
    },
    deleteProperty(_target, prop) {
      assertActive();
      const key = String(prop);
      if (RESERVED_TOP_LEVEL.has(key)) throw new TypeError(`cannot delete orchestration field ${key}`);
      extraChanges.set(key, { deleted: true });
      return true;
    },
    has(_target, prop) {
      if (COLLECTIONS.includes(prop)) return true;
      return topValue(prop) !== undefined;
    },
    ownKeys() {
      const keys = new Set(Reflect.ownKeys(base));
      for (const [key, entry] of extraChanges) {
        if (entry.deleted) keys.delete(key); else keys.add(key);
      }
      return [...keys];
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (!(prop in draft)) return undefined;
      return { configurable: true, enumerable: true, writable: true, value: undefined };
    },
  });
  ownedProxies.add(draft);

  function containsOwnedProxy(value, seen = new WeakSet()) {
    if (!isObject(value)) return false;
    if (ownedProxies.has(value)) return true;
    if (seen.has(value)) return false;
    seen.add(value);
    return Object.values(value).some(child => containsOwnedProxy(child, seen));
  }

  // A synchronous native result must not run user accessors merely to decide
  // whether it refers to a draft. In particular, touching `then` here could
  // execute user code before the transaction commits. Allow that accessor in
  // the enveloped result; reject other accessor/proxy results because they
  // might hide a transaction-local draft that will be revoked after commit.
  function containsOwnedProxySafely(value, seen = new WeakSet()) {
    if (!isObject(value)) return false;
    if (ownedProxies.has(value)) return true;
    if (isProxy(value)) throw new TypeError('synchronous Rust command returned an opaque proxy');
    if (seen.has(value)) return false;
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable) continue;
      if (!Object.hasOwn(descriptor, 'value')) {
        if (key === 'then') continue;
        throw new TypeError('synchronous Rust command returned an accessor');
      }
      if (containsOwnedProxySafely(descriptor.value, seen)) return true;
    }
    return false;
  }

  function finish({ now }) {
    const next = { schemaVersion: base.schemaVersion, revision: base.revision,
      updatedAt: base.updatedAt, nextOutboxSequence: base.nextOutboxSequence };
    const persisted = {
      collections: Object.fromEntries(COLLECTIONS.map(name => [name, new Map()])),
      extras: new Map(),
    };
    let changed = false;

    for (const collection of COLLECTIONS) {
      for (const [key, entry] of recordChanges[collection]) {
        const before = native.materialize(collection, key);
        if (entry.deleted ? before === undefined : jsonEqual(before, entry.value)) continue;
        if (!entry.deleted) deepFreeze(entry.value);
        persisted.collections[collection].set(key, entry.deleted
          ? { deleted: true, before }
          : { deleted: false, before, value: entry.value });
        changed = true;
      }
    }

    for (const [key, entry] of extraChanges) {
      const before = native.materialize('extras', key);
      if (entry.deleted ? before === undefined : jsonEqual(before, entry.value)) continue;
      if (!entry.deleted) deepFreeze(entry.value);
      persisted.extras.set(key, entry.deleted
        ? { deleted: true, before }
        : { deleted: false, before, value: entry.value });
      changed = true;
    }

    const requestedSchema = topChanges.get('schemaVersion');
    if (requestedSchema && requestedSchema.value !== SCHEMA_VERSION) {
      throw new OrchestrationStoreCorruptError('mutation attempted to change orchestration schemaVersion');
    }
    const nextSequence = topChanges.has('nextOutboxSequence')
      ? topChanges.get('nextOutboxSequence').value
      : base.nextOutboxSequence;
    if (nextSequence !== base.nextOutboxSequence) changed = true;
    next.nextOutboxSequence = nextSequence;

    if (!changed) {
      active = false;
      return { changed: false, state: base, expectedRevision: base.revision, persisted };
    }
    next.schemaVersion = SCHEMA_VERSION;
    next.revision = base.revision + 1;
    next.updatedAt = Number(now());
    validateState({ ...next, ...Object.fromEntries(COLLECTIONS.map(name => [name, {}])) }, '<orchestration-sqlite-draft>');
    const committed = deepFreeze(next);
    active = false;
    return { changed: true, state: committed, expectedRevision: base.revision, persisted };
  }

  function revoke() {
    active = false;
    for (const changes of Object.values(recordChanges)) changes.clear();
    extraChanges.clear(); topChanges.clear(); collectionProxies.clear();
    pathProxies.clear(); extraPathProxies.clear();
  }
  return { draft, finish, containsOwnedProxy, containsOwnedProxySafely, revoke };
}

module.exports = { createDraft, COLLECTIONS };
