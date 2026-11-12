'use strict';
const { getNative, nativeCode } = require('../native/runtime');

// 迁移桥接：Rust 拥有连接、SQL、索引、JSON 缓存及其版本。这里仅维持同步调用
// 契约和原有只读 JS 对象的身份；镜像的更换完全由原生返回的 token 决定。
function createTaskShellStore(file) {
  const addon = getNative();
  if (addon.taskStoreProtocolVersion?.() !== 1 || typeof addon.RustTaskStore !== 'function') {
    throw new Error('任务仓储 Rust 接口不可用，请构建当前原生模块后手动重启');
  }
  const native = new addon.RustTaskStore(file);
  const run = command => {
    try { return JSON.parse(native.run(JSON.stringify(command))); }
    catch (error) { throw nativeCode(error); }
  };
  // 打开时做过 v1→v2 迁移就报一次结果（只有计数、耗时与备份路径，不含用户数据）。
  const migration = run({ op: 'migration' });
  if (migration?.stats?.rows) console.info('[multicc] 任务仓储已升级到 v2', migration);
  function rule(command) {
    try { return run({ ...command, op: 'rule' }); }
    catch (error) {
      if (!error.message.startsWith('TASK_RULE:')) throw error;
      const { code, message, status } = JSON.parse(error.message.slice(10));
      throw Object.assign(new Error(message), { code, status });
    }
  }
  const mirrors = new Map();
  function cached(shape, kind) {
    const key = `${shape}:${kind}`, held = mirrors.get(key);
    const reply = run({ op: 'cached', shape, kind, token: held?.token });
    if (reply.rows) mirrors.set(key, { token: reply.token, rows: reply.rows });
    return mirrors.get(key);
  }
  return {
    backend: 'rust',
    rule,
    // Migration bridge: persist the stopped turn and its writer barrier in
    // one native transaction. The admission host still owns liveness checks.
    finalizeStoppedDelivery: input => run({ ...input, op: 'finalizeStoppedDelivery' }),
    finalizeDelivery: input => run({ ...input, op: 'finalizeDelivery' }),
    writerFenceActivity: input => run({ ...input, op: 'writerFenceActivity' }),
    writerFenceSnapshot: input => run({ ...input, op: 'writerFenceSnapshot' }),
    writerFenceRelease: input => run({ ...input, op: 'writerFenceRelease' }),
    writerLeaseAcquire: input => run({ ...input, op: 'writerLeaseAcquire' }),
    writerLeaseRelease: input => run({ ...input, op: 'writerLeaseRelease' }),
    writerLeaseAnnotatePid: input => run({ ...input, op: 'writerLeaseAnnotatePid' }),
    writerLeaseList: workspaceId => run({ op: 'writerLeaseList', workspaceId }),
    writerLeaseAssertEmpty: workspaceId => run({ op: 'writerLeaseAssertEmpty', workspaceId }),
    get: (kind, id) => run({ op: 'get', kind, id }),
    list: kind => run({ op: 'list', kind }),
    entries: kind => run({ op: 'entries', kind }),
    // 删除这些任务的关联行（按引用列索引），见 runtime.purgeTasks。
    purgeTaskRefs: (kinds, ids) => run({ op: 'purgeTaskRefs', kinds, ids }),
    // 上下文记录：提交后压缩并整理窗口；读取引用来源面板的数据。
    contextCommitted: (taskId, receiptId) => run({ op: 'contextCommitted', taskId, id: receiptId }),
    contextTrace: (receiptId, includeMessages = false) => run({ op: 'contextTrace', id: receiptId, includeMessages }),
    cachedList: kind => cached('rows', kind).rows.slice(),
    cachedEntries: kind => cached('entries', kind).rows.slice(),
    cachedById(kind) {
      const mirror = cached('rows', kind);
      mirror.byId ||= new Map(mirror.rows.filter(value => value && typeof value.id === 'string').map(value => [value.id, value]));
      return mirror.byId;
    },
    epoch: kinds => run({ op: 'epoch', kinds }),
    taskBySession: id => run({ op: 'taskBySession', id }),
    linkByTask: id => run({ op: 'linkByTask', id }),
    receiptsForShell: (id, limit = 100) => run({ op: 'receiptsForShell', id, limit }),
    set(kind, id, value) { run({ op: 'set', kind, id, body: JSON.stringify(value) }); return value; },
    remove: (kind, id) => run({ op: 'remove', kind, id }),
    transaction(callback) {
      const frame = run({ op: 'begin' });
      try {
        const result = callback();
        if (result && typeof result.then === 'function') throw new TypeError('任务仓储事务回调必须同步');
        run({ op: 'commit', frame }); return result;
      } catch (error) {
        try { run({ op: 'rollback', frame }); } catch (rollbackError) { error.rollbackError = rollbackError; }
        mirrors.clear(); throw error;
      }
    },
    close() { run({ op: 'close' }); mirrors.clear(); },
  };
}
module.exports = { createTaskShellStore };
