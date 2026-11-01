'use strict';
const { taskDomain, replace } = require('../native/task-domain');
const call = (action, args = {}) => taskDomain({ op: 'attention', action, ...args });
function mutate(action, task, args) {
  const out = call(action, { task, ...args });
  if (task) replace(task, out.task);
  return out.changed;
}
module.exports = {
  attentionKind: state => call('kind', { state }),
  noteRunState: (task, previous, next, at = Date.now()) => mutate('note', task, { previous, next, at }),
  markSeen: (task, at = Date.now()) => mutate('seen', task, { at }),
  pendingAttention: task => call('pending', { task }),
  normalizeAttention: (source, task) => { mutate('normalize', task, { source }); },
};
