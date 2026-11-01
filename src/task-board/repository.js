'use strict';
const { taskDomain } = require('../native/task-domain');
const { nativeCode } = require('../native/runtime');
function createTaskBoardRepository(file) {
  function run(action, args = {}) {
    try { return taskDomain({ op: 'repository', file, action, ...args }); }
    catch (error) { throw nativeCode(error); }
  }
  return {
    // 常驻任务板据此直接由 Rust 落盘，不再整板经 JS 序列化。
    nativeFile: file,
    load: () => run('load'),
    save: (board, expectedRevision, options = {}) => run('save', {
      board, expectedRevision,
      ...(options.onConflict ? { onConflict: options.onConflict } : {}),
    }),
  };
}
module.exports = { createTaskBoardRepository };
