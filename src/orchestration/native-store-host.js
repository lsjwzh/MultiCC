'use strict';

// Compatibility callbacks and proxies only. SQLite ownership, path queries,
// filtering, persistence, retention and streaming export live in Rust.
const path = require('node:path');
const { addonPath, getNative } = require('../native/runtime');
const { invokeNativeCommand, commandEnvelope } = require('./native-command');
const { OutboxConflictError } = require('../outbox');
const { types: { isProxy, isNativeError } } = require('node:util');
const { AsyncLocalStorage } = require('node:async_hooks');
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
  hooks = {}, retention = {}, ownerBinary = null } = {}, deps) {
  const { createDraft, cloneJson, deepFreeze, OrchestrationStoreCorruptError,
    OrchestrationSqliteError, OrchestrationSqliteConflictError, COLLECTIONS } = deps;
  if (!file || typeof file !== 'string') throw new TypeError('[orchestration-sqlite-store] create requires an injected { file }');
  if (typeof now !== 'function') throw new TypeError('[orchestration-sqlite-store] now must be a function');
  function normalize(error) {
    const message = String(error?.message || error);
    if (message.startsWith('OUTBOX_PAYLOAD_CONFLICT:')) {
      return new OutboxConflictError(message.slice('OUTBOX_PAYLOAD_CONFLICT:'.length));
    }
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
    if (native.orchestrationStoreProtocol?.() !== 11) {
      throw new OrchestrationSqliteError('编排原生模块版本不匹配，请重新构建 Rust 模块', { file });
    }
    const options = { env: Object.fromEntries(RETENTION_ENV.map(name => [name, process.env[name]])), policy: retention };
    // The companion is staged beside the addon for source, desktop and
    // standalone installs. Never search PATH or fall back to an in-process
    // SQLite connection: a foreign SQLite library can invalidate its WAL locks.
    const binary = ownerBinary || path.join(path.dirname(addonPath()),
      process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway');
    handle = new native.RustIsolatedOrchestrationStore(file, legacyFile, Number(now()), options, binary);
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
      // The owner exits after acknowledging the last close. Preserve the last
      // metrics snapshot instead of querying a closed transport.
      if (op !== 'close') refreshMetrics();
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
    catch (_) { /* A metrics failure must never turn an acknowledged commit into a retry. */ }
  }
  let knownRevision = initial.state.revision;
  let closed = false;
  let tail = Promise.resolve();
  let queuedOperations = 0;
  let detachedDraftActive = false;
  const draftContext = new AsyncLocalStorage();
  const unavailable = message => Object.assign(new Error(message), { code: 'SESSION_WORK_OWNER_UNAVAILABLE' });
  function ensureOpen() { if (closed) throw new OrchestrationSqliteError(`orchestration database is closed: ${file}`, { file }); }
  function enqueue(operation) {
    queuedOperations++;
    const run = () => draftContext.run(undefined, operation);
    const result = tail.then(run, run);
    tail = result.then(() => { queuedOperations--; }, () => { queuedOperations--; });
    return result;
  }
  function decodeQuestionResponse(response) {
    if (!response.snapshot) return response;
    const decode = ({ pendingQuestionJson, activeTurnJson, categoryJson, ...rest }) => ({
      ...rest, pendingQuestion: JSON.parse(pendingQuestionJson),
      activeTurn: JSON.parse(activeTurnJson), category: JSON.parse(categoryJson),
    });
    return { ...response, snapshot: decode(response.snapshot),
      ...(response.targetSnapshot ? { targetSnapshot: decode(response.targetSnapshot) } : {}),
      ...(typeof response.questionJson === 'string' ? { question: JSON.parse(response.questionJson) } : {}),
      notification: JSON.parse(response.notificationJson) };
  }
  function query(op, collection, options = {}, overrides = []) {
    if (!COLLECTIONS.includes(collection)) throw new TypeError(`unknown orchestration collection ${collection}`);
    return request(op, { collection, options, overrides });
  }
  function view(header, claimMetadata = null, trackedToken = null) {
    let active = true;
    let detached = false;
    let trackHeader = true;
    const snapshotRequest = (op, input = {}) => detached
      ? request('readTrackedDraft', { token: trackedToken, operation: op, input })
      : request(op, input);
    const snapshotQuery = (op, collection, options = {}, overrides = []) => {
      if (!COLLECTIONS.includes(collection)) throw new TypeError(`unknown orchestration collection ${collection}`);
      return snapshotRequest(op, { collection, options, overrides });
    };
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
      return snapshotRequest('inspect', { collection, key, path });
    };
    function materialize(collection, key) {
      assertActive();
      const result = snapshotRequest('materialize', { collection, key });
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
          const keys = snapshotRequest('keys', { collection, key, path });
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
        ownKeys() { assertActive(); return snapshotRequest('keys', { collection }); },
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
      select(collection, options = {}) { assertActive(); return snapshotQuery('select', collection, options); },
      count(collection, where = {}) { assertActive(); return snapshotQuery('count', collection, { where }); },
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
        if (Object.hasOwn(header, prop)) {
          if (trackedToken && trackHeader) request('draftTrackHeader', { token: trackedToken, field: prop });
          return header[prop];
        }
        if (COLLECTIONS.includes(prop)) return collectionView(prop);
        if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
        const info = inspect('extras', prop);
        return info.kind === 'missing' ? Reflect.get(target, prop, receiver) : valueAt('extras', prop, [], info);
      },
      has(_target, prop) { assertActive(); return Object.hasOwn(header, prop) || COLLECTIONS.includes(prop)
        || (typeof prop === 'string' && inspect('extras', prop).kind !== 'missing'); },
      ownKeys() { assertActive(); return [...new Set([...Object.keys(header), ...COLLECTIONS, ...snapshotRequest('keys', { collection: 'extras' })])]; },
      getOwnPropertyDescriptor(_target, prop) {
        assertActive();
        if (!(prop in root)) return undefined;
        return { configurable: true, enumerable: true, writable: false, value: root[prop] };
      },
      set() { assertActive(); throw new TypeError('orchestration read snapshot is immutable'); },
      deleteProperty() { assertActive(); throw new TypeError('orchestration read snapshot is immutable'); },
      defineProperty() { assertActive(); throw new TypeError('orchestration read snapshot is immutable'); },
    });
    return { root, materialize, query: snapshotQuery,
      detach() { if (!trackedToken) throw new TypeError('snapshot is not tracked');
        request('detachDraftSnapshot', { token: trackedToken }); detached = true; },
      withoutHeaderTracking(callback) { trackHeader = false; try { return callback(); } finally { trackHeader = true; } },
      revoke() { active = false; paths.clear(); collections.clear(); } };
  }

  async function readOperation(selector) {
    ensureOpen();
    const started = request('beginTrackedDraft', { readOnly: true });
    const snapshot = view(started.state, null, started.token);
    const context = { token: started.token, detached: false, tracked: true };
    try {
      const pending = draftContext.run(context, () => selector(snapshot.root));
      snapshot.detach();
      context.detached = true;
      detachedDraftActive = true;
      // Materialise from the original row snapshot; leaked views are revoked.
      const value = await pending;
      detachedDraftActive = false;
      const result = draftContext.run(context, () => cloneJson(value));
      knownRevision = Math.max(knownRevision, started.state.revision);
      return result;
    } finally {
      detachedDraftActive = false;
      snapshot.revoke();
      try { request('discardTrackedDraft', { token: started.token }); } catch (_) { /* A failed read can consume it. */ }
      cachedMetrics = request('metrics');
    }
  }
  // Every callback starts as a tracked draft: a non-async function can also
  // return a promise. The owner releases its read transaction before await.
  async function applyDetachedMutation(mutator, predicate, skippedResult) {
    ensureOpen();
    const expectedRevision = knownRevision;
    const started = request('beginTrackedDraft');
    const snapshot = view(started.state, null, started.token);
    const context = { token: started.token, detached: false, tracked: true };
    let cow;
    try {
      if (predicate && !draftContext.run(context, () => predicate(snapshot.root))) {
        return deepFreeze(cloneJson(typeof skippedResult === 'function'
          ? draftContext.run(context, skippedResult) : skippedResult));
      }
      cow = createDraft(snapshot.root, { materialize: snapshot.materialize, query: snapshot.query });
      const pending = draftContext.run(context, () => mutator(cow.draft));
      snapshot.detach();
      context.detached = true;
      detachedDraftActive = true;
      const rawResult = await pending;
      detachedDraftActive = false;
      const { usesDraft, result } = draftContext.run(context, () => {
        const usesDraft = cow.containsOwnedProxy(rawResult);
        return { usesDraft, result: usesDraft ? cloneJson(rawResult) : rawResult };
      });
      const change = draftContext.run(context, () => snapshot.withoutHeaderTracking(() => cow.finish({ now })));
      if (!change.changed) return usesDraft ? deepFreeze(result) : result;
      if (expectedRevision !== started.state.revision) {
        throw new OrchestrationSqliteConflictError(file, expectedRevision, started.state.revision);
      }
      change.expectedRevision = expectedRevision;
      const changes = [];
      for (const collection of COLLECTIONS) {
        for (const [key, entry] of change.persisted.collections[collection]) {
          changes.push({ collection, key, deleted: entry.deleted, value: entry.value });
        }
      }
      for (const [key, entry] of change.persisted.extras) changes.push({ collection: 'extras', key, deleted: entry.deleted, value: entry.value });
      const hasHooks = Object.keys(hooks).length > 0;
      let committed = request('commitTrackedDraft', { token: started.token, headerReadsTracked: true,
        expectedRevision: started.state.revision, state: change.state, changes, prepareOnly: hasHooks });
      if (hasHooks) {
        if (typeof hooks.beforeCommit === 'function') hooks.beforeCommit({ file, change });
        committed = request('commit');
      }
      knownRevision = committed.state.revision;
      if (committed.redacted && typeof hooks.afterRedactionCheckpoint === 'function') hooks.afterRedactionCheckpoint({ file, change });
      if (typeof hooks.afterCommit === 'function') hooks.afterCommit({ file, change });
      return usesDraft ? deepFreeze(result) : result;
    } catch (error) {
      try { request('end'); } catch (_) { /* Preserve the original failure. */ }
      try { knownRevision = request('info').state.revision; }
      catch (_) { /* Preserve the original error if the owner is unavailable. */ }
      throw error;
    } finally {
      detachedDraftActive = false;
      cow?.revoke(); snapshot.revoke();
      try { request('discardTrackedDraft', { token: started.token }); } catch (_) { /* Commit or conflict consumed it. */ }
      cachedMetrics = request('metrics');
    }
  }
  function read(selector) {
    if (selector !== undefined && typeof selector !== 'function') throw new TypeError('[orchestration-sqlite-store] read selector must be a function');
    return enqueue(() => readOperation(selector || (state => state)));
  }
  function mutate(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('[orchestration-sqlite-store] mutate requires a function');
    return enqueue(() => applyDetachedMutation(mutator));
  }
  function mutateIf(predicate, mutator, skippedResult) {
    if (typeof predicate !== 'function' || typeof mutator !== 'function') throw new TypeError('[orchestration-sqlite-store] mutateIf requires predicate and mutator functions');
    return enqueue(() => applyDetachedMutation(mutator, predicate, skippedResult));
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
        const rawResult = draftContext.run({ tracked: false, detached: false },
          () => invokeNativeCommand(name, cow.draft, args, snapshot.root));
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
        return applyDetachedMutation(legacyMutation);
      }
      const key = String(id);
      if (key in Object.prototype) return applyDetachedMutation(legacyMutation);
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
          || ![Object.prototype, null].includes(Object.getPrototypeOf(patch))) return applyDetachedMutation(legacyMutation);
      const key = String(id);
      if (key in Object.prototype) return applyDetachedMutation(legacyMutation);
      const fields = Object.getOwnPropertyDescriptors(patch);
      for (const name of ['pid', 'externalId']) {
        if ((!fields[name] && name in patch) || (fields[name] && !Object.hasOwn(fields[name], 'value'))) return applyDetachedMutation(legacyMutation);
        const value = fields[name]?.value;
        if (value != null && !['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return applyDetachedMutation(legacyMutation);
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
            || (policy.action === 'defer' && policy.delayMs > 1e15)))) return applyDetachedMutation(legacyMutation);
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
        return { legacy: true, value: await applyDetachedMutation(legacyMutation) };
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
          return { legacy: true, value: await applyDetachedMutation(legacyMutation) };
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
        return applyDetachedMutation(legacyMutation);
      }
      const expectedRevision = knownRevision;
      const input = { id, requestJson: JSON.stringify(requestId) };
      request('begin');
      try {
        const plan = request('scheduleSettlePlan', input);
        if (plan.legacy) {
          request('end');
          return await applyDetachedMutation(legacyMutation);
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
    mutateSync(command, input) {
      if (command !== 'scheduleReorder') throw new TypeError('unknown synchronous domain command');
      return enqueue(async () => {
        ensureOpen();
        try {
          // Match the old guard order while observing the index before the
          // asynchronous Rust queue scan can yield to another microtask.
          const guard = request('scheduleReorderCheck', {
            sessionId: input.sessionId, entryId: input.entryId,
          });
          const ensuredAt = guard.ok || guard.scheduleObserved ? Number(input.now()) : null;
          if (!guard.ok) {
            if (!guard.scheduleMissing) return { ok: false, code: guard.code };
            const initialState = input.initialState;
            const initial = initialState === undefined ? {} : { initialStateJson: JSON.stringify(initialState) };
            const result = await getNative().scheduleReorder(handle, {
              sessionId: input.sessionId, entryId: input.entryId,
              ensuredAt, at: ensuredAt, expectedRevision: knownRevision, ...initial,
            });
            if (result?.state?.revision != null) knownRevision = result.state.revision;
            return typeof result?.resultJson === 'string' ? JSON.parse(result.resultJson) : result;
          }
          const index = Number(input.toIndex);
          const at = Number(input.now());
          const initialState = input.initialState;
          const initial = initialState === undefined ? {} : { initialStateJson: JSON.stringify(initialState) };
          const captured = { sessionId: input.sessionId, entryId: input.entryId,
            toIndex: Number.isFinite(index) ? index : null, direction: input.direction,
            actorJson: JSON.stringify(String(input.actor || 'user')), at, ensuredAt, ...initial };
          const result = await getNative().scheduleReorder(handle, { ...captured, expectedRevision: knownRevision });
          if (result?.state?.revision != null) knownRevision = result.state.revision;
          return typeof result?.resultJson === 'string' ? JSON.parse(result.resultJson) : result;
        } catch (error) { throw normalize(error); }
      });
    },
    executeScheduleAdmit(input, admittedAt) {
      let requestJson;
      try { requestJson = JSON.stringify(input); }
      catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        ensureOpen();
        try {
          const result = await getNative().scheduleAdmit(handle, {
            requestJson, expectedRevision: knownRevision,
            now: admittedAt === undefined ? Number(now()) : admittedAt,
          });
          if (result?.state?.revision != null) knownRevision = result.state.revision;
          return typeof result?.resultJson === 'string'
            ? { ...JSON.parse(result.resultJson), snapshot: result.snapshot }
            : result;
        } catch (error) { throw normalize(error); }
      });
    },
    // Experimental synchronous transport for the same Rust admission
    // transaction. It is not used by production while an async draft can
    // still hold the owner connection across an await.
    executeScheduleAdmitSync(input, admittedAt) {
      ensureOpen();
      if (draftContext.getStore()) throw new Error('session work admission is not allowed inside a draft callback');
      if (queuedOperations !== 0 && !(detachedDraftActive && queuedOperations === 1)) {
        throw new Error('session work owner has pending operations');
      }
      const result = request('scheduleAdmit', {
        requestJson: JSON.stringify(input), expectedRevision: knownRevision,
        now: admittedAt === undefined ? Number(now()) : admittedAt,
      });
      if (result?.state?.revision != null) knownRevision = result.state.revision;
      return typeof result?.resultJson === 'string'
        ? { ...JSON.parse(result.resultJson), snapshot: result.snapshot }
        : result;
    },
    // Transport for the frozen completion protocol. Observation happens in
    // this queue turn; Rust revalidates the same owner snapshot before writing.
    executeScheduleComplete({ sessionId, expectedTaskId = null, reason = 'successful',
      classifyState = 'D', awaitingRequestId = null, initialState, clock }) {
      return enqueue(async () => {
        ensureOpen();
        const expectedRevision = knownRevision;
        try {
          const expectedTaskIdJson = JSON.stringify(expectedTaskId);
          const initial = initialState === undefined ? {} : { initialStateJson: JSON.stringify(initialState) };
          const token = request('scheduleCompleteTokenExperimental', { sessionId, expectedTaskIdJson, ...initial });
          if (!token.guard.ok) return token.guard;
          const at = Number(clock());
          // The frozen mutator yields once before sampling the store clock.
          await Promise.resolve();
          const result = await requestAsync('scheduleCompleteExperimental', {
            sessionId, expectedRevision, expectedVersion: token.snapshot.version,
            expectedDataVersion: token.dataVersion, at, updatedAt: Number(now()),
            expectedTaskIdJson, reasonJson: JSON.stringify(reason), ...initial,
            classifyStateJson: JSON.stringify(classifyState),
            awaitingRequestIdJson: JSON.stringify(awaitingRequestId),
          });
          if (result?.state?.revision != null) knownRevision = result.state.revision;
          return typeof result?.resultJson === 'string' ? JSON.parse(result.resultJson) : result;
        } catch (error) {
          let actualRevision = knownRevision;
          try { actualRevision = request('info').state.revision; knownRevision = actualRevision; }
          catch (_) { /* Preserve the original failure if the owner has exited. */ }
          if (String(error?.message || error) === 'schedule completion database version conflict') {
            throw new OrchestrationSqliteConflictError(file, expectedRevision, actualRevision);
          }
          throw normalize(error);
        }
      });
    },
    // The Rust owner makes and commits the question lifecycle decision.
    sessionWorkQuestion(input, backfill, prepare) {
      let requestJson;
      try { requestJson = JSON.stringify(input); }
      catch (error) { return Promise.reject(error); }
      if (backfill !== undefined && typeof backfill !== 'function') {
        return Promise.reject(new TypeError('session work backfill must be a function'));
      }
      if (prepare !== undefined && typeof prepare !== 'function') {
        return Promise.reject(new TypeError('session work preparation must be a function'));
      }
      return enqueue(async () => {
        ensureOpen();
        const captured = JSON.parse(requestJson);
        for (let attempt = 0; attempt < 3; attempt++) {
          // A missing-row response crosses an async boundary before the trusted
          // backfill is read. Refresh host facts on each retry so the first
          // commit cannot overwrite that backfill with an older observation.
          if (prepare) Object.assign(captured, prepare(captured.sessionId));
          try {
            return decodeQuestionResponse(await requestAsync('sessionWorkQuestionExperimental', {
              requestJson: JSON.stringify(captured),
            }));
          } catch (error) {
            if (error?.code !== 'ORCHESTRATION_SQLITE_ERROR' || !backfill) throw error;
            if (error.message === 'question transition requires a trusted initial snapshot'
                && !Object.hasOwn(captured, 'initialState')) {
              captured.initialState = backfill(captured.sessionId);
              continue;
            }
            if (error.message === 'question move requires a trusted target snapshot'
                && !Object.hasOwn(captured, 'targetInitialState')) {
              captured.targetInitialState = backfill(captured.targetSessionId);
              continue;
            }
            throw error;
          }
        }
        throw new Error('session_work_question_initialization_failed');
      });
    },
    // Fail closed instead of overtaking an earlier queued operation. This port
    // is experimental until callers can guarantee that ordering in production.
    sessionWorkQuestionSync(input) {
      ensureOpen();
      if (draftContext.getStore()) throw unavailable('session work question writes are not allowed inside a draft callback');
      if (queuedOperations !== 0 && !(detachedDraftActive && queuedOperations === 1)) {
        throw unavailable('session work owner has pending operations');
      }
      return decodeQuestionResponse(request('sessionWorkQuestionExperimental', { requestJson: JSON.stringify(input) }));
    },
    // An in-flight draft can hold an older SQLite read snapshot. Do not expose
    // it as current or overtake queued writes while this port is experimental.
    sessionWorkStateSync(sessionId, initialState) {
      ensureOpen();
      const context = draftContext.getStore();
      if (context && initialState !== undefined) {
        throw unavailable('session work initialization is not allowed inside a draft callback');
      }
      if (!context && queuedOperations !== 0 && !(detachedDraftActive && queuedOperations === 1)) {
        throw unavailable('session work owner has pending operations');
      }
      const initial = initialState === undefined ? {} : { initial: {
        pendingQuestionJson: JSON.stringify(initialState.pendingQuestion),
        activeTurnJson: JSON.stringify(initialState.activeTurn),
        categoryJson: JSON.stringify(initialState.category),
      } };
      const input = {
        action: initialState === undefined ? 'read' : 'readOrInitialize', encoding: 'json', sessionId, ...initial,
      };
      const response = context?.tracked && context.detached
        ? request('readTrackedDraft', { token: context.token, operation: 'sessionWorkState', input })
        : request('sessionWorkState', input);
      const { pendingQuestionJson, activeTurnJson, categoryJson, ...rest } = response;
      return { ...rest, pendingQuestion: JSON.parse(pendingQuestionJson),
        activeTurn: JSON.parse(activeTurnJson), category: JSON.parse(categoryJson) };
    },
    sessionWorkStateReadOrInitialize(sessionId, backfill) {
      if (typeof sessionId !== 'string' || typeof backfill !== 'function') {
        return Promise.reject(new TypeError('session work read requires a session id and backfill'));
      }
      return enqueue(async () => {
        ensureOpen();
        let response = await requestAsync('sessionWorkState', { action: 'read', encoding: 'json', sessionId });
        if (!response.exists) {
          const initial = backfill(sessionId);
          response = await requestAsync('sessionWorkState', { action: 'readOrInitialize', encoding: 'json', sessionId,
            initial: { pendingQuestionJson: JSON.stringify(initial.pendingQuestion),
              activeTurnJson: JSON.stringify(initial.activeTurn), categoryJson: JSON.stringify(initial.category) } });
        }
        const { pendingQuestionJson, activeTurnJson, categoryJson, ...rest } = response;
        return { ...rest, pendingQuestion: JSON.parse(pendingQuestionJson),
          activeTurn: JSON.parse(activeTurnJson), category: JSON.parse(categoryJson) };
      });
    },
    // Transport only: the owner validates, versions and commits this state.
    // Serialize with existing commands so an unrelated draft cannot be active.
    sessionWorkState(input) {
      let captured;
      try { captured = JSON.parse(JSON.stringify(input)); }
      catch (error) { return Promise.reject(error); }
      const encode = ({ pendingQuestion, activeTurn, category, ...rest }) => ({
        ...rest, pendingQuestionJson: JSON.stringify(pendingQuestion),
        activeTurnJson: JSON.stringify(activeTurn), categoryJson: JSON.stringify(category),
      });
      const decode = ({ pendingQuestionJson, activeTurnJson, categoryJson, ...rest }) => ({
        ...rest, pendingQuestion: JSON.parse(pendingQuestionJson),
        activeTurn: JSON.parse(activeTurnJson), category: JSON.parse(categoryJson),
      });
      try {
        captured.encoding = 'json';
        if (captured.action === 'readOrInitialize') captured.initial = encode(captured.initial);
        if (captured.action === 'readOrInitializeBatch') {
          captured.entries = captured.entries.map(({ sessionId, initial, ...rest }) => ({
            ...rest, sessionId, initial: encode(initial),
          }));
        }
        if (captured.action === 'write') captured.updates = captured.updates.map(encode);
        if (captured.action === 'patch') {
          if (Object.hasOwn(captured, 'initial')) captured.initial = encode(captured.initial);
          const patch = captured.patch;
          for (const name of ['pendingQuestion', 'activeTurn', 'category']) {
            if (!Object.hasOwn(patch, name)) continue;
            patch[`${name}Json`] = JSON.stringify(patch[name]);
            delete patch[name];
          }
        }
      } catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        ensureOpen();
        const result = captured.action === 'readOrInitializeBatch'
          ? await requestAsync('sessionWorkState', captured)
          : request('sessionWorkState', captured);
        return ['write', 'readOrInitializeBatch'].includes(captured.action)
          ? { snapshots: result.snapshots.map(decode) } : decode(result);
      });
    },
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
