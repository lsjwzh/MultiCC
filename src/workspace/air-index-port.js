'use strict';
const { randomUUID } = require('node:crypto');
const nativeRuntime = require('../native/runtime');
const { createTaskReadModel } = require('../native/task-read-model');

// Transport only: the Rust owner retains all cards, caches and replay history.
// cursor/ready mirror accepted native replies; they contain no task state.
function createRustAirReadIndex({ model, historyLimit, maxDeltaBytes } = {}) {
  if (!model) {
    const addon = nativeRuntime.getNative();
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
function createAirIndex(options = {}) {
  return createRustAirReadIndex(options);
}

// Evaluate JS accessors and String conversions in their original order. Slice
// in V8 so a huge private message never crosses the native boundary.
function issueFields(cause) {
  return [String(cause.code || ''), String(cause.message || '').slice(0, 1024)];
}
function describeAirIssue(error) {
  try { return nativeRuntime.getNative().airDescribeIssue(error, issueFields); }
  catch { return { code: 'rust_backend_unavailable', message: '无法加载当前版本的 Rust 诊断接口，请检查模块版本并重启 MultiCC。' }; }
}

function storageNoticeWithPublisher(publish) {
  let recent = null, lifetime;
  function remember(notice, ttl) { recent = notice; lifetime = ttl; }
  return {
    record(error) {
      let addon;
      try { addon = nativeRuntime.getNative(); } catch { return false; }
      if (!addon.airRecordStorageNotice) return false;
      return addon.airRecordStorageNotice(error, issueFields, remember, publish);
    },
    // Callers retain and can mutate the actual DTO, including its timestamp.
    current() { return recent && Date.now() - recent.at < lifetime ? recent : null; },
  };
}
function createAirStorageNotice() { return storageNoticeWithPublisher(); }

let publishStatus;
const notice = storageNoticeWithPublisher(() => publishStatus?.());
const airNotices = {
  report(error) { notice.record(error); },
  storageNotice: notice.current,
  bindPublisher(publish) { publishStatus = publish; },
  // stateStore 的失败挂钩：上报告警 + 计数 + 日志，一次装好。
  installStateStoreReporter(stateStore, { metrics, logger }) {
    stateStore.setFailureReporter((error, meta) => {
      notice.record(error);
      metrics.inc('multicc_persistence_failures_total');
      logger.error('persistence_failure', { ...meta, error: error && error.message });
    });
  },
  // sessionPersistence 的 onFailure 同款形状。
  sessionPersistenceOnFailure({ metrics, logger }) {
    return ({ error, mode, source, attempt, dirty }) => {
      notice.record(error);
      metrics.inc('multicc_session_persistence_failures_total');
      logger.error('session_persistence_failure', {
        mode, source, attempt, dirty, error: error && error.message,
      });
    };
  },
};

module.exports = { createAirIndex, createRustAirReadIndex, describeAirIssue, createAirStorageNotice, airNotices };
