'use strict';
const { randomUUID } = require('node:crypto');
const nativeRuntime = require('../native/runtime');
const { createTaskReadModel } = require('../native/task-read-model');

// Transport only: the Rust owner retains all cards, caches and replay history.
// cursor/ready mirror accepted native replies; they contain no task state.
function createRustAirReadIndex({ model, historyLimit, maxDeltaBytes } = {}) {
  if (!model) {
    const addon = nativeRuntime.getNative('read_model', 'rust');
    if (addon.taskReadModelProtocolVersion?.() !== 1) throw Error('air_read_protocol_unavailable');
    model = createTaskReadModel({ addon });
  }
  let current = `${randomUUID()}:0`, ready = false, closed = false;
  const opened = model.run({ op: 'air', command: { op: 'open', epoch: current.split(':')[0], historyLimit, maxDeltaBytes } });
  opened.catch(() => {});
  function run(command) {
    if (closed) return Promise.reject(Object.assign(new Error('首页摘要已关闭'), { status: 503, code: 'air_closed' }));
    // Admit immediately: the lower FIFO detaches caller data before any await.
    const reply = model.run({ op: 'air', command });
    return Promise.all([opened, reply]).then(([, result]) => result);
  }
  function accept(reply) {
    if (reply?.cursor) current = reply.cursor;
    if (reply?.ready || reply?.type === 'air_reset' || reply?.type === 'air_delta') ready = true;
    return reply;
  }
  return {
    backend: 'rust', isReady: () => ready && !closed, cursor: () => current,
    apply: (snapshot, options = {}) => run({ op: 'apply', snapshot, ...options }).then(accept),
    publish: (snapshot, options = {}, dayStarts = []) => run({ op: 'publish', snapshot, ...options, dayStarts }).then(accept),
    sync: (since, dayStart = 0) => run({ op: 'sync', since: String(since || ''), dayStart }),
    changes: since => run({ op: 'changes', since: String(since || '') }),
    stats: dayStart => run({ op: 'stats', dayStart }),
    page: (options = {}) => run({ op: 'page', options }),
    bootstrap: (options = {}) => run({ op: 'bootstrap', ...options }),
    snapshot: () => run({ op: 'snapshot' }), serialized: () => run({ op: 'serialized' }),
    close() { closed = true; ready = false; return model.close(); },
  };
}
function createAirIndex({ backend = process.env.MULTICC_AIR_READ_BACKEND || 'rust', ...options } = {}) {
  if (backend === 'rust') return createRustAirReadIndex(options);
  if (backend === 'node') {
    const index = require('./air-read-index').createAirReadIndex(options);
    return Object.assign(index, { backend: 'node' });
  }
  throw new Error('invalid_air_read_backend');
}
module.exports = { createAirIndex, createRustAirReadIndex };
