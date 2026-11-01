'use strict';
const { getNative, nativeCode } = require('../native/runtime');

// 迁移桥接：Rust 拥有连接、SQL、索引、JSON 缓存及其版本。这里仅维持同步调用
// 契约和原有只读 JS 对象的身份；镜像的更换完全由原生返回的 token 决定。
function createTaskShellStore(file) {
  const addon = getNative('task_store', 'rust');
  if (addon.taskStoreProtocolVersion?.() !== 1 || typeof addon.RustTaskStore !== 'function') {
    throw new Error('任务仓储 Rust 接口不可用，请构建当前原生模块后手动重启');
  }
  const native = new addon.RustTaskStore(file);
  const run = command => {
    try { return JSON.parse(native.run(JSON.stringify(command))); }
    catch (error) { throw nativeCode(error); }
  };
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
    get: (kind, id) => run({ op: 'get', kind, id }),
    list: kind => run({ op: 'list', kind }),
    entries: kind => run({ op: 'entries', kind }),
    deletionEntries: kind => run({ op: 'deletionEntries', kind }),
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
