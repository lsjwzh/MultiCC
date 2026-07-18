'use strict';

// Durable, single-file state for orchestration waits and their delivery
// outbox.  Keeping both collections in one snapshot is deliberate: resolving
// a wait and admitting the matching outbox item can commit with one atomic
// rename, so a process crash cannot leave only one side visible.

const nodeFs = require('fs');
const nodePath = require('path');

const SCHEMA_VERSION = 1;
let tempCounter = 0;

class OrchestrationStoreCorruptError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'OrchestrationStoreCorruptError';
    this.code = 'ORCHESTRATION_STORE_CORRUPT';
    Object.assign(this, meta);
  }
}

function initialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    updatedAt: 0,
    nextOutboxSequence: 1,
    waits: {},
    outbox: {},
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateState(value, file) {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) {
    throw new OrchestrationStoreCorruptError(
      `unsupported orchestration state in ${file}`,
      { file },
    );
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new OrchestrationStoreCorruptError(
      `invalid orchestration revision in ${file}`,
      { file },
    );
  }
  if (!Number.isSafeInteger(value.nextOutboxSequence)
      || value.nextOutboxSequence < 1
      || !isRecord(value.waits)
      || !isRecord(value.outbox)) {
    throw new OrchestrationStoreCorruptError(
      `invalid orchestration collections in ${file}`,
      { file },
    );
  }
  return value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function tryFsync(fsImpl, fd) {
  try {
    fsImpl.fsyncSync(fd);
  } catch (error) {
    if (!error || !['ENOTSUP', 'EINVAL', 'EBADF'].includes(error.code)) throw error;
  }
}

function fsyncDirectory(fsImpl, dir) {
  let fd;
  try {
    const constants = fsImpl.constants || nodeFs.constants;
    fd = fsImpl.openSync(dir, constants.O_RDONLY);
    tryFsync(fsImpl, fd);
  } catch (error) {
    if (!error || !['EISDIR', 'EPERM', 'EINVAL', 'EBADF'].includes(error.code)) {
      throw error;
    }
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch (_) { /* best effort */ }
    }
  }
}

function writeAtomic({ fsImpl, pathImpl, file, state, now, hooks }) {
  const dir = pathImpl.dirname(file);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const suffix = `${process.pid}.${now()}.${++tempCounter}`;
  const temp = `${file}.tmp.${suffix}`;
  const text = `${JSON.stringify(state, null, 2)}\n`;
  let fd;
  let renamed = false;

  try {
    fd = fsImpl.openSync(temp, 'wx', 0o600);
    fsImpl.writeFileSync(fd, text, { encoding: 'utf8' });
    tryFsync(fsImpl, fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsImpl.chmodSync(temp, 0o600);

    if (typeof hooks.beforeRename === 'function') {
      hooks.beforeRename({ file, temp, state: cloneJson(state) });
    }

    fsImpl.renameSync(temp, file);
    renamed = true;
    fsImpl.chmodSync(file, 0o600);
    fsyncDirectory(fsImpl, dir);

    if (typeof hooks.afterRename === 'function') {
      hooks.afterRename({ file, state: cloneJson(state) });
    }
  } catch (error) {
    if (!renamed) {
      try { fsImpl.unlinkSync(temp); } catch (_) { /* absent or injected crash */ }
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch (_) { /* best effort */ }
    }
  }
}

function loadState({ fsImpl, file }) {
  if (!fsImpl.existsSync(file)) return initialState();

  let raw;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    throw new OrchestrationStoreCorruptError(
      `cannot read orchestration state ${file}: ${error.message}`,
      { file, cause: error },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new OrchestrationStoreCorruptError(
      `invalid JSON in orchestration state ${file}: ${error.message}`,
      { file, cause: error },
    );
  }

  const state = validateState(parsed, file);
  // A copied or restored file may have inherited broader permissions. Enforce
  // the private contract on every successful open as well as every write.
  fsImpl.chmodSync(file, 0o600);
  return state;
}

function createOrchestrationStore({
  file,
  fsImpl = nodeFs,
  pathImpl = nodePath,
  now = Date.now,
  hooks = {},
} = {}) {
  if (!file || typeof file !== 'string') {
    throw new TypeError('[orchestration-store] create requires an injected { file }');
  }
  if (!fsImpl || typeof fsImpl.readFileSync !== 'function') {
    throw new TypeError('[orchestration-store] fsImpl must implement the Node fs contract');
  }
  if (typeof now !== 'function') {
    throw new TypeError('[orchestration-store] now must be a function');
  }

  let state = deepFreeze(loadState({ fsImpl, file }));
  let tail = Promise.resolve();

  function enqueue(operation) {
    const result = tail.then(operation, operation);
    // A failed mutation must not poison later work. Keep a swallowed tail for
    // serialization while returning the original rejecting promise to caller.
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function mutate(mutator) {
    if (typeof mutator !== 'function') {
      throw new TypeError('[orchestration-store] mutate requires a function');
    }

    return enqueue(async () => {
      const before = JSON.stringify(state);
      const draft = cloneJson(state);
      const result = await mutator(draft);
      validateState(draft, file);

      // Idempotent business operations may run through the mutation queue but
      // leave the draft unchanged. Avoid an unnecessary revision and fsync.
      if (JSON.stringify(draft) === before) return result;

      draft.revision = state.revision + 1;
      draft.updatedAt = Number(now());
      validateState(draft, file);

      try {
        writeAtomic({ fsImpl, pathImpl, file, state: draft, now, hooks });
        state = deepFreeze(draft);
      } catch (error) {
        // beforeRename means the old snapshot remains; afterRename means the
        // new one landed but the caller did not observe success. Reloading
        // handles both windows and keeps this process coherent for a retry.
        state = deepFreeze(loadState({ fsImpl, file }));
        throw error;
      }
      return result;
    });
  }

  function read(selector) {
    if (selector !== undefined && typeof selector !== 'function') {
      throw new TypeError('[orchestration-store] read selector must be a function');
    }
    return enqueue(() => {
      const snapshot = cloneJson(state);
      return selector ? selector(snapshot) : snapshot;
    });
  }

  return Object.freeze({
    file,
    mutate,
    read,
    snapshot: () => read(),
    flush: () => tail,
  });
}

module.exports = {
  SCHEMA_VERSION,
  OrchestrationStoreCorruptError,
  createOrchestrationStore,
  _initialState: initialState,
};
