'use strict';

// Compatibility callbacks and proxies only. SQLite ownership, path queries,
// filtering, persistence, retention and streaming export live in Rust.
const { getNative } = require('../native/runtime');
const RETENTION_ENV = [
  'MULTICC_ORCHESTRATION_RETENTION_ENABLED',
  'MULTICC_ORCHESTRATION_RETENTION_TASK_DAYS',
  'MULTICC_ORCHESTRATION_RETENTION_OUTBOX_DAYS',
  'MULTICC_ORCHESTRATION_RETENTION_BATCH_SIZE',
  'MULTICC_ORCHESTRATION_RETENTION_MAX_RECORDS',
  'MULTICC_ORCHESTRATION_RETENTION_INTERVAL_MS',
];

function createNativeStore({ file, legacyFile = null, now = Date.now,
  hooks = {}, retention = {} } = {}, deps) {
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
    return error;
  }
  let handle;
  try {
    const native = getNative();
    if (native.orchestrationStoreProtocol?.() !== 2) {
      throw new OrchestrationSqliteError('编排原生模块版本不匹配，请重新构建 Rust 模块', { file });
    }
    handle = new native.RustOrchestrationStore(file, legacyFile, Number(now()), {
      env: Object.fromEntries(RETENTION_ENV.map(name => [name, process.env[name]])), policy: retention,
    });
  } catch (error) { throw normalize(error); }
  function request(op, input = {}) {
    try {
      const result = handle.request(op, input);
      // Decode only the requested record/field at the JSON storage boundary.
      if (result && typeof result === 'object') {
        if (Object.hasOwn(result, 'valueJson')) result.value = JSON.parse(result.valueJson);
        if (Object.hasOwn(result, 'keysJson')) return JSON.parse(result.keysJson);
        if (Object.hasOwn(result, 'rowsJson')) return result.rowsJson.map(raw => JSON.parse(raw));
      }
      return result;
    } catch (error) { throw normalize(error); }
  }
  async function requestAsync(op, input = {}) {
    try { return await handle.requestAsync(op, input); }
    catch (error) { throw normalize(error); }
    finally { cachedMetrics = request('metrics'); }
  }
  const initial = request('info');
  let cachedMetrics = request('metrics');
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

  function view(header) {
    let active = true;
    const paths = new Map();
    const collections = new Map();
    const assertActive = () => { if (!active) throw new TypeError('orchestration snapshot is no longer active'); };
    const inspect = (collection, key, path = []) => {
      assertActive();
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
  async function exportSnapshot(target) {
    ensureOpen();
    if (!target || typeof target !== 'string') throw new TypeError('[orchestration-sqlite-store] exportLegacy requires a target file');
    const result = await requestAsync('export', { file: target });
    knownRevision = result.revision;
    return result;
  }
  return Object.freeze({
    backend: 'sqlite', file, legacyFile, migration: Object.freeze({ ...initial.migration }),
    read, mutate, mutateIf, snapshot: () => read(),
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
