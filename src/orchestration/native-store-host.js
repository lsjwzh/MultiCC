'use strict';

// Compatibility callbacks and proxies only. SQLite ownership, path queries,
// filtering, persistence, retention and streaming export live in Rust.
const { getNative } = require('../native/runtime');
const { invokeNativeCommand, commandEnvelope } = require('./native-command');
const { types: { isProxy, isNativeError } } = require('node:util');
const { Buffer: NodeBuffer } = require('node:buffer');
const nativeCrypto = require('node:crypto');
const nativeCreateHash = Object.getOwnPropertyDescriptor(nativeCrypto, 'createHash')?.value;
const nativeBufferFrom = Object.getOwnPropertyDescriptor(NodeBuffer, 'from')?.value;
const nativeBufferToString = Object.getOwnPropertyDescriptor(NodeBuffer.prototype, 'toString')?.value;
const nativeDateNow = Date.now;
const nativeCanonical = {
  keys: Object.keys, descriptors: Object.getOwnPropertyDescriptors,
  descriptor: Object.getOwnPropertyDescriptor, prototype: Object.getPrototypeOf,
  hasOwn: Object.hasOwn, finite: Number.isFinite,
  isArray: Array.isArray, map: Array.prototype.map, sort: Array.prototype.sort,
  join: Array.prototype.join, stringify: JSON.stringify, parse: JSON.parse,
  set: Set, setHas: Set.prototype.has, setAdd: Set.prototype.add, setDelete: Set.prototype.delete,
  wellFormed: String.prototype.toWellFormed, isWellFormed: String.prototype.isWellFormed, string: String,
  replace: String.prototype.replace, slice: String.prototype.slice,
  regexpReplace: RegExp.prototype[Symbol.replace],
  arraySpecies: Object.getOwnPropertyDescriptor(Array, Symbol.species),
};

// The asynchronous SQLite command is used only when reading the input cannot
// run user code or change canonicalization semantics midway. Otherwise Rust's
// live command runs inside the existing draft transaction.
function standardCanonicalEnvironment() {
  const entries = [
    [Object, 'keys', nativeCanonical.keys], [Object, 'getOwnPropertyDescriptors', nativeCanonical.descriptors],
    [Object, 'getOwnPropertyDescriptor', nativeCanonical.descriptor], [Object, 'getPrototypeOf', nativeCanonical.prototype],
    [Object, 'hasOwn', nativeCanonical.hasOwn], [Number, 'isFinite', nativeCanonical.finite],
    [Array, 'isArray', nativeCanonical.isArray], [Array.prototype, 'map', nativeCanonical.map],
    [Array.prototype, 'sort', nativeCanonical.sort], [Array.prototype, 'join', nativeCanonical.join],
    [JSON, 'stringify', nativeCanonical.stringify], [JSON, 'parse', nativeCanonical.parse],
    [Set.prototype, 'has', nativeCanonical.setHas], [Set.prototype, 'add', nativeCanonical.setAdd],
    [Set.prototype, 'delete', nativeCanonical.setDelete], [String.prototype, 'toWellFormed', nativeCanonical.wellFormed],
    [String.prototype, 'isWellFormed', nativeCanonical.isWellFormed],
    [String.prototype, 'replace', nativeCanonical.replace], [String.prototype, 'slice', nativeCanonical.slice],
    [RegExp.prototype, Symbol.replace, nativeCanonical.regexpReplace],
    [Array.prototype, 'constructor', Array],
  ];
  if (Set !== nativeCanonical.set || String !== nativeCanonical.string) return false;
  const species = nativeCanonical.descriptor(Array, Symbol.species);
  if (species?.get !== nativeCanonical.arraySpecies?.get || species?.set !== nativeCanonical.arraySpecies?.set ||
      !species?.get || !Function.prototype.toString.call(species.get).includes('[native code]')) return false;
  for (let index = 0; index < entries.length; index++) {
    const object = entries[index][0]; const name = entries[index][1]; const expected = entries[index][2];
    if (nativeCanonical.descriptor(object, name)?.value !== expected || isProxy(expected) ||
        !Function.prototype.toString.call(expected).includes('[native code]')) return false;
  }
  const fields = ['chatId', 'targetId', 'message', 'taskId', 'taskStart', 'taskSource', 'taskText',
    'taskShellReceiptId', 'clientMsgId', 'receivedAt', 'toJSON', 'kind', 'ownerSessionId', 'idempotencyKeyHash',
    'requestHash', 'id', 'requestOutboxId', 'spec', 'sessionId', 'payloadHash'];
  for (let index = 0; index < fields.length; index++) {
    if (nativeCanonical.descriptor(Object.prototype, fields[index])) return false;
  }
  if (nativeCanonical.descriptor(Array.prototype, 'toJSON')) return false;
  return true;
}
function isPlainCanonicalData(root) {
  let nodes = 0;
  function visit(value, seen, depth) {
    if (++nodes > 1000000 || depth > 64) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return nativeCanonical.finite(value);
    if (typeof value !== 'object' || isProxy(value)) return false;
    for (let node = seen; node; node = node.parent) if (node.value === value) return false;
    const array = nativeCanonical.isArray(value);
    const prototype = nativeCanonical.prototype(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = nativeCanonical.descriptors(value);
    if (nativeCanonical.hasOwn(descriptors, 'toJSON')) return false;
    if (array && nativeCanonical.hasOwn(descriptors, 'map')) return false;
    const next = { value, parent: seen };
    if (array) {
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !nativeCanonical.hasOwn(descriptor, 'value') || !visit(descriptor.value, next, depth + 1)) return false;
      }
    } else {
      const keys = nativeCanonical.keys(descriptors);
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        const descriptor = descriptors[key];
        if (descriptor.enumerable && (!nativeCanonical.hasOwn(descriptor, 'value') || !visit(descriptor.value, next, depth + 1))) return false;
      }
    }
    return true;
  }
  return visit(root, null, 0);
}

const RETENTION_ENV = [
  'MULTICC_ORCHESTRATION_RETENTION_ENABLED',
  'MULTICC_ORCHESTRATION_RETENTION_TASK_DAYS',
  'MULTICC_ORCHESTRATION_RETENTION_OUTBOX_DAYS',
  'MULTICC_ORCHESTRATION_RETENTION_BATCH_SIZE',
  'MULTICC_ORCHESTRATION_RETENTION_MAX_RECORDS',
  'MULTICC_ORCHESTRATION_RETENTION_INTERVAL_MS',
];

function createNativeStore({ file, legacyFile = null, now = Date.now,
  hooks = {}, retention = {}, experimentalOwnerBinary = null } = {}, deps) {
  const { createDraft, cloneJson, deepFreeze, OrchestrationStoreCorruptError,
    OrchestrationSqliteError, OrchestrationSqliteConflictError, COLLECTIONS } = deps;
  if (!file || typeof file !== 'string') throw new TypeError('[orchestration-sqlite-store] create requires an injected { file }');
  if (typeof now !== 'function') throw new TypeError('[orchestration-sqlite-store] now must be a function');
  function normalize(error) {
    const message = String(error?.message || error);
    const conflict = message.match(/^ORCHESTRATION_SQLITE_CONFLICT:(\d+):(\d+)$/);
    if (conflict) return new OrchestrationSqliteConflictError(file, Number(conflict[1]), Number(conflict[2]));
    if (message.startsWith('ORCHESTRATION_STORE_CORRUPT:')) return new OrchestrationStoreCorruptError(message.slice('ORCHESTRATION_STORE_CORRUPT:'.length), { file, cause: error });
    if (message.startsWith('ORCHESTRATION_SQLITE_ERROR:')) return new OrchestrationSqliteError(message.slice('ORCHESTRATION_SQLITE_ERROR:'.length), { file, cause: error });
    if (message.startsWith('ORCHESTRATION_TASK_ACTIVITY_INPUT:')) return Object.assign(
      new Error(message.slice('ORCHESTRATION_TASK_ACTIVITY_INPUT:'.length)), { statusCode: 400 });
    if (message === 'OUTBOX_BACKOFF_INVALID') return new TypeError('[outbox] backoff must return a non-negative finite number');
    return error;
  }
  let handle;
  try {
    const native = getNative();
    if (native.orchestrationStoreProtocol?.() !== 10) {
      throw new OrchestrationSqliteError('编排原生模块版本不匹配，请重新构建 Rust 模块', { file });
    }
    const options = { env: Object.fromEntries(RETENTION_ENV.map(name => [name, process.env[name]])), policy: retention };
    // Explicit opt-in for isolated integration tests; production does not select
    // this path until its process lifecycle and packaging have been verified.
    handle = experimentalOwnerBinary
      ? new native.RustIsolatedOrchestrationStore(file, legacyFile, Number(now()), options, experimentalOwnerBinary)
      : new native.RustOrchestrationStore(file, legacyFile, Number(now()), options);
  } catch (error) { throw normalize(error); }
  function request(op, input = {}) {
    try {
      const result = handle.request(op, input);
      // Decode only the requested record/field at the JSON storage boundary.
      if (result && typeof result === 'object') {
        if (Object.hasOwn(result, 'valueJson')) result.value = JSON.parse(result.valueJson);
        if (Object.hasOwn(result, 'keysJson')) return JSON.parse(result.keysJson);
        if (op === 'claimMetadata') {
          const rows = [];
          for (let index = 0; index < result.rowsJson.length; index++) rows[index] = JSON.parse(result.rowsJson[index]);
          return { keys: result.keys, leasedKeys: result.leasedKeys, rows };
        }
        if (Object.hasOwn(result, 'rowsJson')) return result.rowsJson.map(raw => JSON.parse(raw));
      }
      return result;
    } catch (error) { throw normalize(error); }
  }
  async function requestAsync(op, input = {}) {
    try { return await handle.requestAsync(op, input); }
    catch (error) { throw normalize(error); }
    finally {
      // The experimental owner exits after acknowledging close; the existing
      // in-process store still supports querying its metrics after close.
      if (op !== 'close' || !experimentalOwnerBinary) refreshMetrics();
    }
  }
  async function requestAdmissionAsync(op, input, spec) {
    try {
      const result = await handle.requestAdmissionAsync(op, input, spec);
      if (result.resultBuffer) result.resultJson = nativeBufferToString.call(result.resultBuffer, 'utf8');
      return result;
    }
    catch (error) { throw normalize(error); }
    finally { refreshMetrics(); }
  }
  const initial = request('info');
  let cachedMetrics = request('metrics');
  function refreshMetrics() {
    try { cachedMetrics = request('metrics'); }
    catch (error) {
      // Metrics are best-effort for the isolated experiment. In particular,
      // their failure must not turn an acknowledged commit into a retry.
      if (!experimentalOwnerBinary) throw error;
    }
  }
  let knownRevision = initial.state.revision;
  let closed = false;
  let tail = Promise.resolve();
  function ensureOpen() { if (closed) throw new OrchestrationSqliteError(`orchestration database is closed: ${file}`, { file }); }
  function enqueue(operation) {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }
  function query(op, collection, options = {}, overrides = []) {
    if (!COLLECTIONS.includes(collection)) throw new TypeError(`unknown orchestration collection ${collection}`);
    return request(op, { collection, options, overrides });
  }

  function view(header, claimMetadata = null) {
    let active = true;
    const paths = new Map();
    const collections = new Map();
    const claimRows = Object.create(null);
    if (claimMetadata) {
      for (let index = 0; index < claimMetadata.keys.length; index++) {
        const row = claimMetadata.rows[index];
        // Scalar and malformed records retain the original database path.
        if (row && typeof row === 'object' && nativeCanonical.keys(row).length) claimRows[claimMetadata.keys[index]] = row;
      }
    }
    const assertActive = () => { if (!active) throw new TypeError('orchestration snapshot is no longer active'); };
    const inspect = (collection, key, path = []) => {
      assertActive();
      const row = collection === 'outbox' && nativeCanonical.hasOwn(claimRows, key) ? claimRows[key] : null;
      if (row && path.length === 0) return { kind: 'object' };
      const field = path[0];
      if (row && path.length === 1 && (field === 'id' || field === 'sessionId' || field === 'state' ||
          field === 'sequence' || field === 'availableAt' || field === 'leasedUntil' || field === 'attempts')) {
        if (!nativeCanonical.hasOwn(row, path[0])) return { kind: 'missing' };
        const value = row[path[0]];
        if (Array.isArray(value)) return { kind: 'array', length: value.length };
        if (value !== null && typeof value === 'object') return { kind: 'object' };
        return { kind: 'value', value };
      }
      return request('inspect', { collection, key, path });
    };
    function materialize(collection, key) {
      assertActive();
      const result = request('materialize', { collection, key });
      return result.found ? result.value : undefined;
    }
    function valueAt(collection, key, path = [], info = inspect(collection, key, path)) {
      if (info.kind === 'missing') return undefined;
      if (info.kind === 'value') return info.value;
      const cacheKey = JSON.stringify([collection, key, path]);
      if (paths.has(cacheKey)) return paths.get(cacheKey);
      const array = info.kind === 'array';
      const target = array ? new Array(info.length) : {};
      const part = prop => array && typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)
        ? Number(prop) : prop;
      const proxy = new Proxy(target, {
        get(_target, prop, receiver) {
          assertActive();
          if (array && prop === 'length') return info.length;
          if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
          const child = inspect(collection, key, [...path, part(prop)]);
          return child.kind === 'missing' ? Reflect.get(target, prop, receiver)
            : valueAt(collection, key, [...path, part(prop)], child);
        },
        set() { assertActive(); throw new TypeError('orchestration read snapshot is immutable'); },
        deleteProperty() { assertActive(); throw new TypeError('orchestration read snapshot is immutable'); },
        defineProperty() { assertActive(); throw new TypeError('orchestration read snapshot is immutable'); },
        has(_target, prop) {
          assertActive();
          return prop in target || (typeof prop === 'string'
            && inspect(collection, key, [...path, part(prop)]).kind !== 'missing');
        },
        ownKeys() {
          assertActive();
          const keys = request('keys', { collection, key, path });
          return array ? [...keys, 'length'] : keys;
        },
        getOwnPropertyDescriptor(_target, prop) {
          assertActive();
          if (array && prop === 'length') return Object.getOwnPropertyDescriptor(target, 'length');
          if (typeof prop !== 'string' || inspect(collection, key, [...path, part(prop)]).kind === 'missing') return undefined;
          return { configurable: true, enumerable: true, writable: false,
            value: valueAt(collection, key, [...path, part(prop)]) };
        },
      });
      paths.set(cacheKey, proxy);
      return proxy;
    }
    function collectionView(collection) {
      if (collections.has(collection)) return collections.get(collection);
      const proxy = new Proxy({}, {
        get(target, prop, receiver) {
          assertActive();
          if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
          const info = inspect(collection, prop);
          return info.kind === 'missing' ? Reflect.get(target, prop, receiver) : valueAt(collection, prop, [], info);
        },
        has(_target, prop) { assertActive(); return typeof prop === 'string' && inspect(collection, prop).kind !== 'missing'; },
        ownKeys() { assertActive(); return request('keys', { collection }); },
        getOwnPropertyDescriptor(_target, prop) {
          assertActive();
          if (typeof prop !== 'string' || inspect(collection, prop).kind === 'missing') return undefined;
          return { configurable: true, enumerable: true, writable: false, value: valueAt(collection, prop) };
        },
        set() { assertActive(); throw new TypeError('orchestration read snapshot is immutable'); },
        deleteProperty() { assertActive(); throw new TypeError('orchestration read snapshot is immutable'); },
        defineProperty() { assertActive(); throw new TypeError('orchestration read snapshot is immutable'); },
      });
      collections.set(collection, proxy);
      return proxy;
    }
    const methods = {
      select(collection, options = {}) { assertActive(); return query('select', collection, options); },
      count(collection, where = {}) { assertActive(); return query('count', collection, { where }); },
      claimSelect(leased) {
        assertActive();
        if (!claimMetadata || !leased) return null;
        const result = [];
        for (let index = 0; index < claimMetadata.leasedKeys.length; index++) {
          const key = claimMetadata.leasedKeys[index];
          result[result.length] = (nativeCanonical.hasOwn(claimRows, key) ? claimRows[key] : null)
            || materialize('outbox', key);
        }
        return result;
      },
    };
    const root = new Proxy({}, {
      get(target, prop, receiver) {
        assertActive();
        if (Object.hasOwn(methods, prop)) return methods[prop];
        if (Object.hasOwn(header, prop)) return header[prop];
        if (COLLECTIONS.includes(prop)) return collectionView(prop);
        if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
        const info = inspect('extras', prop);
        return info.kind === 'missing' ? Reflect.get(target, prop, receiver) : valueAt('extras', prop, [], info);
      },
      has(_target, prop) { assertActive(); return Object.hasOwn(header, prop) || COLLECTIONS.includes(prop)
        || (typeof prop === 'string' && inspect('extras', prop).kind !== 'missing'); },
      ownKeys() { assertActive(); return [...new Set([...Object.keys(header), ...COLLECTIONS, ...request('keys', { collection: 'extras' })])]; },
      getOwnPropertyDescriptor(_target, prop) {
        assertActive();
        if (!(prop in root)) return undefined;
        return { configurable: true, enumerable: true, writable: false, value: root[prop] };
      },
      set() { assertActive(); throw new TypeError('orchestration read snapshot is immutable'); },
      deleteProperty() { assertActive(); throw new TypeError('orchestration read snapshot is immutable'); },
      defineProperty() { assertActive(); throw new TypeError('orchestration read snapshot is immutable'); },
    });
    return { root, materialize, revoke() { active = false; paths.clear(); collections.clear(); } };
  }

  async function readOperation(selector) {
    ensureOpen();
    const header = request('begin');
    const snapshot = view(header);
    try {
      // Materialise before closing the transaction; leaked views are revoked.
      const result = cloneJson(await selector(snapshot.root));
      knownRevision = header.revision;
      return result;
    } finally { snapshot.revoke(); request('end'); cachedMetrics = request('metrics'); }
  }
  async function applyMutation(mutator, predicate, skippedResult) {
    ensureOpen();
    const expectedRevision = knownRevision;
    const header = request('begin');
    const snapshot = view(header);
    let cow;
    try {
      if (predicate && !predicate(snapshot.root)) {
        return deepFreeze(cloneJson(typeof skippedResult === 'function' ? skippedResult() : skippedResult));
      }
      cow = createDraft(snapshot.root, { materialize: snapshot.materialize, query });
      const rawResult = await mutator(cow.draft);
      const usesDraft = cow.containsOwnedProxy(rawResult);
      const result = usesDraft ? cloneJson(rawResult) : rawResult;
      const change = cow.finish({ now });
      if (!change.changed) { request('noop'); return usesDraft ? deepFreeze(result) : result; }
      change.expectedRevision = expectedRevision;
      const changes = [];
      for (const collection of COLLECTIONS) {
        for (const [key, entry] of change.persisted.collections[collection]) {
          changes.push({ collection, key, deleted: entry.deleted, value: entry.value });
        }
      }
      for (const [key, entry] of change.persisted.extras) changes.push({ collection: 'extras', key, deleted: entry.deleted, value: entry.value });
      request('prepare', { expectedRevision, state: change.state, changes });
      if (typeof hooks.beforeCommit === 'function') hooks.beforeCommit({ file, change });
      const committed = request('commit');
      knownRevision = committed.state.revision;
      if (committed.redacted && typeof hooks.afterRedactionCheckpoint === 'function') hooks.afterRedactionCheckpoint({ file, change });
      if (typeof hooks.afterCommit === 'function') hooks.afterCommit({ file, change });
      return usesDraft ? deepFreeze(result) : result;
    } catch (error) {
      request('end');
      knownRevision = request('info').state.revision;
      throw error;
    } finally { cow?.revoke(); snapshot.revoke(); request('end'); cachedMetrics = request('metrics'); }
  }
  function read(selector) {
    if (selector !== undefined && typeof selector !== 'function') throw new TypeError('[orchestration-sqlite-store] read selector must be a function');
    return enqueue(() => readOperation(selector || (state => state)));
  }
  function mutate(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('[orchestration-sqlite-store] mutate requires a function');
    return enqueue(() => applyMutation(mutator));
  }
  function mutateIf(predicate, mutator, skippedResult) {
    if (typeof predicate !== 'function' || typeof mutator !== 'function') throw new TypeError('[orchestration-sqlite-store] mutateIf requires predicate and mutator functions');
    return enqueue(() => applyMutation(mutator, predicate, skippedResult));
  }
  // Only allowlisted synchronous Rust commands enter this transaction. Neither
  // the command result nor a user-controlled `then` is assimilated by the queue
  // Promise until after the transaction has committed and the caller unwraps it.
  function runNativeCommandSync(name, ...args) {
    return enqueue(() => {
      ensureOpen();
      const expectedRevision = knownRevision;
      const header = request('begin');
      let snapshot;
      let cow;
      try {
        // One revision-bound Rust projection replaces repeated per-field
        // SQLite lookups during the synchronous claim callback. Keep the
        // original draft proxy identities for selector and scheduler ports.
        let claimMetadata = null;
        if (name === 'outboxClaim') {
          try { claimMetadata = request('claimMetadata'); }
          catch (_) { /* Cache is optional; authoritative reads retain old error timing. */ }
        }
        snapshot = view(header, claimMetadata);
        cow = createDraft(snapshot.root, { materialize: snapshot.materialize, query, claimMetadata });
        const rawResult = invokeNativeCommand(name, cow.draft, args, snapshot.root);
        const usesDraft = cow.containsOwnedProxySafely(rawResult);
        const result = usesDraft ? cloneJson(rawResult) : rawResult;
        const change = cow.finish({ now });
        if (!change.changed) {
          request('noop');
          return commandEnvelope(usesDraft ? deepFreeze(result) : result);
        }
        change.expectedRevision = expectedRevision;
        const changes = [];
        for (const collection of COLLECTIONS) {
          for (const [key, entry] of change.persisted.collections[collection]) {
            changes.push({ collection, key, deleted: entry.deleted, value: entry.value });
          }
        }
        for (const [key, entry] of change.persisted.extras) changes.push({ collection: 'extras', key, deleted: entry.deleted, value: entry.value });
        request('prepare', { expectedRevision, state: change.state, changes });
        if (typeof hooks.beforeCommit === 'function') hooks.beforeCommit({ file, change });
        const committed = request('commit');
        knownRevision = committed.state.revision;
        if (committed.redacted && typeof hooks.afterRedactionCheckpoint === 'function') hooks.afterRedactionCheckpoint({ file, change });
        if (typeof hooks.afterCommit === 'function') hooks.afterCommit({ file, change });
        return commandEnvelope(usesDraft ? deepFreeze(result) : result);
      } catch (error) {
        request('end');
        knownRevision = request('info').state.revision;
        throw error;
      } finally { cow?.revoke(); snapshot?.revoke(); request('end'); cachedMetrics = request('metrics'); }
    });
  }
  function cancelWait(id, clock, legacyMutation) {
    return enqueue(() => {
      ensureOpen();
      if (typeof id === 'symbol' || (id !== null && (typeof id === 'object' || typeof id === 'function'))) {
        return applyMutation(legacyMutation);
      }
      const key = String(id);
      if (key in Object.prototype) return applyMutation(legacyMutation);
      const expectedRevision = knownRevision;
      request('begin');
      try {
        const checked = request('waitCancelCheck', { id: key });
        if (!checked.pending) {
          if (checked.result.code === 'not_pending') {
            checked.result.status = checked.statusJson == null ? undefined : JSON.parse(checked.statusJson);
          }
          request('noop');
          return checked.result;
        }
        const result = request('waitCancelCommit', {
          id: key, expectedRevision, at: Number(clock()), updatedAt: Number(now()),
        });
        knownRevision = request('info').state.revision;
        return result;
      } catch (error) {
        request('end');
        knownRevision = request('info').state.revision;
        throw error;
      } finally { request('end'); cachedMetrics = request('metrics'); }
    });
  }
  function markRunningOperation(id, patch, clock, legacyMutation) {
    // Host-only compatibility for non-plain objects, accessors and values
    // whose conversion can execute user code. Normal production inputs are
    // plain scalar fields and the Rust command owns their state transition.
    return enqueue(() => {
      ensureOpen();
      if (typeof id === 'symbol' || (id !== null && (typeof id === 'object' || typeof id === 'function'))
          || !patch || typeof patch !== 'object' || isProxy(patch) || Array.isArray(patch)
          || ![Object.prototype, null].includes(Object.getPrototypeOf(patch))) return applyMutation(legacyMutation);
      const key = String(id);
      if (key in Object.prototype) return applyMutation(legacyMutation);
      const fields = Object.getOwnPropertyDescriptors(patch);
      for (const name of ['pid', 'externalId']) {
        if ((!fields[name] && name in patch) || (fields[name] && !Object.hasOwn(fields[name], 'value'))) return applyMutation(legacyMutation);
        const value = fields[name]?.value;
        if (value != null && !['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return applyMutation(legacyMutation);
      }
      const expectedRevision = knownRevision;
      request('begin');
      try {
        const pid = fields.pid?.value;
        const numericPid = pid == null ? null : Number(pid);
        const externalId = fields.externalId?.value;
        const input = { id: key, pidFinite: numericPid != null && Number.isFinite(numericPid),
          pid: numericPid, externalJson: externalId ? JSON.stringify(String(externalId)) : null };
        const planned = request('operationRunningPlan', input);
        if (!planned.pending) { request('noop'); return JSON.parse(planned.resultJson); }
        const result = request('operationRunningCommit', {
          ...input, expectedRevision, at: Number(clock()), updatedAt: Number(now()),
        });
        knownRevision = request('info').state.revision;
        return JSON.parse(result.resultJson);
      } catch (error) {
        request('end'); knownRevision = request('info').state.revision; throw error;
      } finally { request('end'); cachedMetrics = request('metrics'); }
    });
  }
  function executeOutbox(policy, legacyMutation) {
    return enqueue(async () => {
      ensureOpen();
      const reasonIsError = policy.action !== 'recover' && policy.action !== 'ack'
        && policy.reason != null && !isProxy(policy.reason) && isNativeError(policy.reason)
        && policy.reason instanceof Error;
      if (policy.customBackoff || policy.now !== Date.now
          || !Number.isFinite(policy.baseBackoffMs) || policy.baseBackoffMs < 0
          || !Number.isFinite(policy.maxBackoffMs) || policy.maxBackoffMs < 0
          || policy.baseBackoffMs > 1e15 || policy.maxBackoffMs > 1e15
          || (policy.action !== 'recover' && (policy.customCrypto || typeof policy.id !== 'string'
            || policy.id in Object.prototype || typeof policy.token !== 'string'
            || (policy.action !== 'ack' && typeof policy.reason !== 'string' && !reasonIsError)
            || (policy.action === 'fail' && typeof policy.retryable !== 'boolean')
            || (policy.action === 'defer' && policy.delayMs > 1e15)))) return applyMutation(legacyMutation);
      const expectedRevision = knownRevision;
      request('begin');
      try {
        const input = { at: Number(policy.now()), maxAttempts: policy.maxAttempts,
          baseBackoffMs: policy.baseBackoffMs, maxBackoffMs: policy.maxBackoffMs,
          action: policy.action, id: policy.id, tokenJson: JSON.stringify(policy.token),
          reasonJson: reasonIsError ? undefined : JSON.stringify(policy.reason),
          reasonDeferred: reasonIsError, retryable: policy.retryable, delayMs: policy.delayMs };
        let plan = await requestAsync('outboxRecoverPlan', input);
        if (plan.needsReason) {
          input.reasonJson = JSON.stringify({ value: policy.formatReason() });
          input.reasonDeferred = false;
          input.reasonFormatted = true;
          plan = await requestAsync('outboxRecoverPlan', input);
        }
        if (!plan.changed) { request('noop'); return JSON.parse(plan.resultJson); }
        const result = await requestAsync('outboxRecoverCommit', {
          ...input, expectedRevision, updatedAt: Number(now()),
        });
        knownRevision = request('info').state.revision;
        return JSON.parse(result.resultJson);
      } catch (error) {
        request('end'); knownRevision = request('info').state.revision; throw error;
      } finally { request('end'); cachedMetrics = request('metrics'); }
    });
  }
  function executeOperationAdmit(policy, legacyMutation) {
    return enqueue(async () => {
      ensureOpen();
      const simpleId = typeof policy.id === 'string' || typeof policy.id === 'boolean' || typeof policy.id === 'symbol' ||
        policy.id === null || (typeof policy.id === 'number' && nativeCanonical.finite(policy.id));
      const idKey = simpleId ? nativeCanonical.string(policy.id) : '';
      const simpleValue = value => value === null || typeof value === 'boolean' || typeof value === 'symbol' ||
        (typeof value === 'number' && nativeCanonical.finite(value)) ||
        (typeof value === 'string' && value.isWellFormed());
      if (policy.now !== nativeDateNow || now !== nativeDateNow || policy.now !== Date.now || isProxy(policy.now) ||
          !Function.prototype.toString.call(policy.now).includes('[native code]') || policy.customCrypto ||
          !standardCanonicalEnvironment() || nativeCanonical.descriptor(nativeCrypto, 'createHash')?.value !== nativeCreateHash ||
          nativeCanonical.descriptor(NodeBuffer, 'from')?.value !== nativeBufferFrom ||
          nativeCanonical.descriptor(NodeBuffer.prototype, 'toString')?.value !== nativeBufferToString ||
          (policy.idempotencyKey != null && (typeof policy.idempotencyKey === 'object' || typeof policy.idempotencyKey === 'function')) ||
          !isPlainCanonicalData(policy.spec) ||
          !simpleId || (policy.kind === 'detached' && typeof policy.id !== 'string') ||
          !idKey.isWellFormed() || !policy.ownerSessionId || !simpleValue(policy.ownerSessionId) ||
          !simpleValue(policy.resultSessionId))
        return { legacy: true, value: await applyMutation(legacyMutation) };
      const expectedRevision = knownRevision;
      const header = request('begin');
      const prototypeKey = typeof policy.id !== 'symbol' && idKey in Object.prototype;
      const snapshot = prototypeKey ? view(header) : null;
      try {
        // Pure data contains no callbacks. V8 handles the transport only;
        // Rust performs normalization and hashing on the worker thread.
        const specJson = nativeCanonical.stringify(policy.spec);
        const specBytes = nativeBufferFrom.call(NodeBuffer, specJson, 'utf8');
        // Node's UTF-8 hash input replaces isolated surrogates with U+FFFD.
        const idempotencyKey = policy.idempotencyKey ? String(policy.idempotencyKey).toWellFormed() : null;
        const input = { ...policy, id: idKey, idSymbol: typeof policy.id === 'symbol',
          idValueJson: JSON.stringify(policy.id) ?? 'null',
          ownerSymbol: typeof policy.ownerSessionId === 'symbol', resultSymbol: typeof policy.resultSessionId === 'symbol',
          ownerValueJson: JSON.stringify(policy.ownerSessionId) ?? 'null', resultValueJson: JSON.stringify(policy.resultSessionId) ?? 'null',
          ownerSessionId: undefined, resultSessionId: undefined, idempotencyKey, prototypeKey, now: undefined,
          spec: undefined, expectedRevision };
        let result = prototypeKey ? request('operationAdmitPlan', { ...input, specJson })
          : await requestAdmissionAsync('operationAdmitPlan', input, specBytes);
        if (result.needsPrototype) {
          input.prototypeKnown = true;
          input.prototypeTruthy = !!snapshot.root.operations[idKey];
          result = request('operationAdmitPlan', { ...input, specJson });
        }
        if (result.pending) result = await requestAdmissionAsync('operationAdmit', input, specBytes);
        if (result.legacy) {
          request('end');
          return { legacy: true, value: await applyMutation(legacyMutation) };
        }
        if (!result.unchanged) knownRevision = request('info').state.revision;
        return result;
      } catch (error) {
        request('end'); knownRevision = request('info').state.revision; throw error;
      } finally { snapshot?.revoke(); request('end'); cachedMetrics = request('metrics'); }
    });
  }
  function settleScheduleInput(id, requestId, clock, legacyMutation) {
    return enqueue(async () => {
      ensureOpen();
      if (typeof id !== 'string' || typeof requestId !== 'string' || id in Object.prototype) {
        return applyMutation(legacyMutation);
      }
      const expectedRevision = knownRevision;
      const input = { id, requestJson: JSON.stringify(requestId) };
      request('begin');
      try {
        const plan = request('scheduleSettlePlan', input);
        if (plan.legacy) {
          request('end');
          return await applyMutation(legacyMutation);
        }
        if (!plan.pending) { request('noop'); return plan.result; }
        const result = request('scheduleSettleCommit', {
          ...input, expectedRevision, at: Number(clock()),
          scheduleUpdatedAt: Number(clock()), updatedAt: Number(now()),
        });
        knownRevision = request('info').state.revision;
        return result;
      } catch (error) {
        request('end'); knownRevision = request('info').state.revision; throw error;
      } finally { request('end'); cachedMetrics = request('metrics'); }
    });
  }
  async function exportSnapshot(target) {
    ensureOpen();
    if (!target || typeof target !== 'string') throw new TypeError('[orchestration-sqlite-store] exportLegacy requires a target file');
    const result = await requestAsync('export', { file: target });
    knownRevision = result.revision;
    return result;
  }
  return Object.freeze({
    backend: 'sqlite', file, legacyFile, migration: Object.freeze({ ...initial.migration }),
    read, mutate, mutateIf, runNativeCommandSync, snapshot: () => read(),
    ...(Object.keys(hooks).length ? {} : { cancelWait, markRunningOperation, executeOutbox, executeOperationAdmit, settleScheduleInput }),
    select: (collection, options = {}) => read(state => state.select(collection, options)),
    count: (collection, where = {}) => read(state => state.count(collection, where)),
    taskActivity: input => enqueue(async () => {
      ensureOpen();
      const result = await requestAsync('taskActivity', input);
      return result.rowsJson.map(raw => JSON.parse(raw));
    }),
    flush: () => enqueue(() => { ensureOpen(); return requestAsync('checkpoint'); }),
    exportLegacy: (target = legacyFile) => enqueue(() => exportSnapshot(target)),
    pruneRetained: ({ now: clock = now() } = {}) => enqueue(async () => {
      ensureOpen();
      const report = await requestAsync('retention', { now: clock, apply: true });
      // Maintenance is another SQLite writer; refresh only when it changed rows.
      if (report.deletedTasks || report.deletedOutbox) knownRevision = report.revision;
      return report;
    }),
    retentionReport: ({ now: clock = now() } = {}) => enqueue(() => {
      ensureOpen(); return requestAsync('retention', { now: clock, apply: false });
    }),
    close: ({ exportRollback = true } = {}) => enqueue(async () => {
      if (closed) return;
      let failure;
      try { if (legacyFile && exportRollback) await exportSnapshot(legacyFile); }
      catch (error) { failure = error; }
      try { await requestAsync('close'); } finally { closed = true; }
      if (failure) throw failure;
    }),
    // Never wait on the mutex held by asynchronous maintenance or export.
    metrics: () => ({ ...cachedMetrics }),
  });
}

module.exports = { createNativeStore };
