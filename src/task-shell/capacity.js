'use strict';
const { taskDomain } = require('../native/task-domain');
const MAX_TASKS_PER_DIRECTORY = 1024;
function directoryTaskCount(store, dirId) {
  return store.rule ? store.rule({ action: 'directoryCount', dirId })
    : taskDomain({ op: 'capacity', tasks: store.list('task'), dirId }).count;
}
function directoryAtCapacity(store, dirId) { return store.rule ? store.rule({ action: 'directoryCapacity', dirId }) : taskDomain({ op: 'capacity', tasks: store.list('task'), dirId }).atCapacity; }
module.exports = { MAX_TASKS_PER_DIRECTORY, directoryTaskCount, directoryAtCapacity };
