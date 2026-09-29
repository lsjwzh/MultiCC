'use strict';

// Fine-grained task-first workflows can legitimately create hundreds of tasks
// in one directory. Keep every task-shell creation path on the same limit.
const MAX_TASKS_PER_DIRECTORY = 1024;

function directoryTaskCount(store, dirId) {
  return store.list('task').filter(task => task.dirId === dirId).length;
}

function directoryAtCapacity(store, dirId) {
  return directoryTaskCount(store, dirId) >= MAX_TASKS_PER_DIRECTORY;
}

module.exports = { MAX_TASKS_PER_DIRECTORY, directoryTaskCount, directoryAtCapacity };
