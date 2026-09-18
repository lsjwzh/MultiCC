'use strict';

const { hash } = require('./context');

const fail = (code, message = code, status = 409) => Object.assign(new Error(message), { code, status });
const KINDS = Object.freeze(['related', 'group']);

// 关联编辑（P4）：显式的、可审计的关系边。
//
// 图上的边有两种来源：系统推导的（父子、分离来源、复制来源、合并别名）和
// 用户明确建立的。后者必须单独存，因为「相关」不是「归属」——把两个任务连
// 起来只是让它们在图上和检索里能找到彼此，不改变轮次归属，也不授予上下文
// 读取权（上下文读取仍要求同项目权限与明确 grant）。
function createTaskRelations({ store, taskTitle, onChanged, now = () => Date.now() }) {
  const idOf = (shellId, from, to, kind) => `rel_${hash([shellId, from, to, kind]).slice(0, 32)}`;
  const opKey = (shellId, clientMsgId) => `rop_${hash([shellId, clientMsgId]).slice(0, 32)}`;

  function publicRelation(record) {
    if (!record) return null;
    return { id: record.id, shellId: record.shellId, kind: record.kind, fromTaskId: record.fromTaskId,
      toTaskId: record.toTaskId, fromTitle: taskTitle?.(record.fromTaskId) || null,
      toTitle: taskTitle?.(record.toTaskId) || null, createdAt: record.createdAt, createdBy: record.createdBy || null };
  }

  function list(shellId) {
    return store.list('relation').filter(record => record.shellId === shellId)
      .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0)).map(publicRelation);
  }

  function taskOf(id, label) {
    const value = typeof id === 'string' ? id.trim() : '';
    if (!value || value.length > 200) throw fail('invalid_input', `${label} is required`, 400);
    const task = store.get('task', value);
    if (!task) throw fail('task_not_found', `${label} not found`, 404);
    return task;
  }

  function create(shellId, { kind = 'related', fromTaskId, toTaskId, clientMsgId } = {}) {
    if (typeof clientMsgId !== 'string' || !/^[\w.:-]{1,160}$/.test(clientMsgId)) throw fail('invalid_input', 'invalid clientMsgId', 400);
    const shell = store.get('shell', String(shellId || ''));
    if (!shell) throw fail('task_shell_not_found', 'Task shell not found', 404);
    const normalizedKind = String(kind || 'related');
    if (!KINDS.includes(normalizedKind)) throw fail('invalid_input', `kind must be one of ${KINDS.join(', ')}`, 400);
    const from = taskOf(fromTaskId, 'fromTaskId'), to = taskOf(toTaskId, 'toTaskId');
    if (from.id === to.id) throw fail('invalid_input', 'A task cannot be related to itself', 400);
    if (from.dirId !== to.dirId || from.dirId !== shell.dirId) throw fail('project_mismatch', 'Relations must stay inside one project', 403);
    // 幂等键与关系本身分开：同一个请求重放得到同一条边，而同一对任务的
    // 「相关」与「同组」是两条独立的边。
    const operationId = opKey(shellId, clientMsgId);
    const existing = store.get('relation-op', operationId);
    const id = idOf(shellId, from.id, to.id, normalizedKind);
    if (existing?.fingerprint && existing.fingerprint !== id) throw fail('idempotency_conflict', 'This operation id was used for a different relation', 409);
    const current = store.get('relation', id);
    if (current) return { ok: true, relation: publicRelation(current), created: false };
    const record = { id, shellId, kind: normalizedKind, fromTaskId: from.id, toTaskId: to.id,
      createdBy: clientMsgId, createdAt: now() };
    return store.transaction(() => {
      store.set('relation', id, record);
      store.set('relation-op', operationId, { id: operationId, shellId, clientMsgId, relationId: id,
        status: 'applied', fingerprint: id, createdAt: now() });
      try { onChanged?.(shellId); } catch (_) {}
      return { ok: true, relation: publicRelation(record), created: true };
    });
  }

  function remove(shellId, { relationId, clientMsgId } = {}) {
    if (typeof clientMsgId !== 'string' || !/^[\w.:-]{1,160}$/.test(clientMsgId)) throw fail('invalid_input', 'invalid clientMsgId', 400);
    const record = store.get('relation', String(relationId || ''));
    if (!record || record.shellId !== shellId) throw fail('relation_not_found', 'Relation not found', 404);
    return store.transaction(() => {
      store.remove('relation', record.id);
      store.set('relation-op', opKey(shellId, clientMsgId), { id: opKey(shellId, clientMsgId), shellId, clientMsgId,
        relationId: record.id, status: 'removed', fingerprint: record.id, createdAt: now() });
      try { onChanged?.(shellId); } catch (_) {}
      return { ok: true, relation: publicRelation(record), removed: true };
    });
  }

  return { list, create, remove, KINDS };
}

module.exports = { createTaskRelations, RELATION_KINDS: KINDS };
