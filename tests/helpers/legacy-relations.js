'use strict';
const KINDS = Object.freeze(['related', 'group']);
// Rust 仓储拥有关系验证、权限边界和幂等写事务；宿主补入当前标题并发布通知。
function createTaskRelations({ store, taskTitle, onChanged, now = Date.now }) {
  function publicTitle(relation) {
    return { ...relation, fromTitle: taskTitle?.(relation.fromTaskId) || null,
      toTitle: taskTitle?.(relation.toTaskId) || null };
  }
  function change(action, shellId, input = {}) {
    const result = store.rule({ action, shellId, input, now: now() });
    if (result.created || (result.removed && !result.replayed)) { try { onChanged?.(shellId); } catch (_) {} }
    return { ...result, relation: publicTitle(result.relation) };
  }
  return {
    list: shellId => store.rule({ action: 'relationList', shellId }).map(publicTitle),
    create: (shellId, input) => change('relationCreate', shellId, input),
    remove: (shellId, input) => change('relationRemove', shellId, input), KINDS,
  };
}
module.exports = { createTaskRelations, RELATION_KINDS: KINDS };
