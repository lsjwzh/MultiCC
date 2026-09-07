'use strict';

const REQUIRED_DEPS = [
  'file', 'auxQueue', 'records', 'loadHistory', 'dispatchToSession',
  'sendSessionMessage', 'workspaceBroadcast', 'atomicWriteJson', 'isSystemInjected',
  'getSessionRunState',
];

function assertTaskBoardDeps(deps) {
  if (!deps || typeof deps !== 'object') throw new Error('[taskboard] deps object required');
  for (const name of REQUIRED_DEPS) {
    if (deps[name] === undefined || deps[name] === null) {
      throw new Error(`[taskboard] missing dep: ${name}`);
    }
  }
}

function createRelatedTaskLinker({ board, groupRelatedTasks, save, notify, now = Date.now }) {
  return (taskId, relatedTaskId) => {
    const before = JSON.parse(JSON.stringify(board.taskGroups || {}));
    const result = groupRelatedTasks(board, taskId, relatedTaskId, now());
    if (!result.ok || !result.changed) return result;
    if (!save()) {
      board.taskGroups = before;
      return { ok: false, error: 'persistence_failed' };
    }
    notify(null, result.taskIds, 'grouped');
    return { ...result, revision: board.revision };
  };
}

module.exports = { assertTaskBoardDeps, createRelatedTaskLinker };
