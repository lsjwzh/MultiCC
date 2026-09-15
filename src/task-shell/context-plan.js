'use strict';
const { hash, snapshotHistory, verifySnapshot, renderLazyContextPrompt } = require('./context');
const { selectContext } = require('../context/selection');
const { boundedSnapshot, boundedHandoff } = require('./context-snapshot');

function createContextPlanner({ store, getRecord, getHistory, getTask, graphContextOf }) {
  function prepare(task, { receiptId, turnId, text = '', isFirstTurn = false, fallback = '', memory, budget = 8000, force = false }) {
    const receipt = store.get('receipt', receiptId);
    if (!receipt || receipt.taskId !== task.id) throw new Error('context_receipt_mismatch');
    if (!force && receipt.contextPlan?.turnId === turnId) return receipt.contextPlan;
    const record = getRecord(task.sessionId), prior = task.contextLedger;
    const reset = isFirstTurn || !prior || prior.cli !== record.cli || prior.roleEpoch !== record.taskRoleEpoch
      || (prior.nativeId && record.cliSessionId && prior.nativeId !== record.cliSessionId);
    const ledger = reset ? {} : prior.sources;
    const lifecycle = getTask(task.id) || task;
    const query = text + '\n' + task.title;
    const memories = memory?.retrieve({ ...record, taskBoundTaskId: task.id }, query) || { candidates: [], inventory: [], diagnostics: [] };
    const graph = graphContextOf(task.id, { query }) || { candidates: [], sources: [] };
    const inventory = [
      { id: `task:${task.id}`, mode: 'task:current', taskId: task.id, taskName: lifecycle.title || task.title,
        excerpt: JSON.stringify({ taskId: task.id, title: lifecycle.title || task.title, description: lifecycle.description,
          acceptanceCriteria: lifecycle.acceptanceCriteria, status: lifecycle.status }), priority: 980, atomic: true, reason: 'current_task' },
      { id: 'context:policy', mode: 'context:policy', taskName: '上下文读取与记忆写入规则', priority: 990, atomic: true,
        excerpt: renderLazyContextPrompt(task.id) + (memory?.guidance(record) || ''), reason: 'policy' },
      ...memories.inventory,
      ...(graph.candidates || graph.sources || []).map(s => ({ ...s, id: s.id || `graph:${s.kind}:${s.taskId}`, mode: s.mode || `graph:${s.kind}`, priority: s.priority || 200 })),
    ];
    const snapshotIds = [...new Set([...(task.snapshotIds || []), ...(task.handoffSnapshotIds || [])])];
    const snapshots = snapshotIds.map(id => {
      const snapshot = store.get('snapshot', id);
      if (!verifySnapshot(snapshot, id)) throw new Error(`snapshot_unverified:${id}`);
      return snapshot;
    });
    if (reset && !record.pendingCliHandoff) {
      const own = snapshotHistory(task.id, getHistory(task.sessionId));
      if (own.messages.length) { store.set('snapshot', own.hash, own); snapshots.push(own); }
    }
    for (const snapshot of snapshots) {
      const bounded = boundedSnapshot(snapshot);
      inventory.push({ id: `snapshot:${snapshot.hash}`, snapshotId: snapshot.hash,
        version: snapshot.hash, taskId: snapshot.taskId, taskName: store.get('task', snapshot.taskId)?.title || task.title,
        mode: 'imported', excerpt: bounded.text, truncated: bounded.truncated, priority: 950, atomic: true,
        messageCount: bounded.messageCount ?? snapshot.messages.length, reason: 'explicit_import' });
    }
    if (record.pendingCliHandoff) {
      const bounded = boundedHandoff(record.pendingCliHandoff);
      inventory.push({ id: `cli-handoff:${record.pendingCliHandoff.id}`, mode: 'context:handoff', taskName: 'CLI 切换检查点',
        excerpt: bounded.text, truncated: bounded.truncated, priority: 965, reason: 'cli_switch', atomic: true });
    }
    if (fallback) inventory.push({ id: `handoff:${hash(fallback)}`, mode: 'context:handoff', taskName: '角色切换检查点',
      excerpt: fallback, priority: 960, atomic: true, reason: 'handoff' });
    const byId = new Map(inventory.map(s => [s.id, { ...s, version: s.version || hash(s.excerpt) }]));
    const requested = new Set([...memories.candidates.map(s => s.id), ...inventory.filter(s => !s.id.startsWith('memory:')).map(s => s.id)]);
    const candidates = [], retained = [], removed = [], duplicates = [];
    const knownVersions = new Set(Object.entries(ledger).filter(([id, old]) => !old.truncated && byId.get(id)?.version === old.version).map(([, old]) => old.version));
    for (const source of byId.values()) {
      const previous = ledger[source.id];
      if (previous?.version === source.version) {
        if (requested.has(source.id)) retained.push({ id: source.id, version: source.version, mode: source.mode, taskName: source.taskName, receiptId: previous.receiptId });
        continue;
      }
      if (!requested.has(source.id) && !previous) continue;
      if (!previous && knownVersions.has(source.version)) { duplicates.push({ id: source.id, reason: 'duplicate_in_native' }); continue; }
      candidates.push({ ...source, priority: previous ? Math.max(970, source.priority || 0) : source.priority,
        label: `${source.id} v=${source.version.slice(0, 12)}${previous ? ` 替换旧版本 ${previous.version.slice(0, 12)}` : ''}` });
    }
    // A retrieval miss is not a deletion. Only complete scope reads may withdraw memories.
    if (!memories.diagnostics.length) for (const [id, old] of Object.entries(ledger)) {
      if (!id.startsWith('memory:') || byId.has(id)) continue;
      removed.push(id);
      candidates.push({ id: `withdraw:${id}`, mode: 'memory:withdrawn', taskName: old.taskName, priority: 995, atomic: true,
        excerpt: `记忆 ${id}（版本 ${old.version}）已删除或不再允许读取，撤回其旧内容，不再据此作出决定。`, reason: 'withdrawn', withdraws: id });
    }
    const selected = selectContext(candidates, { budget,
      header: '【本轮托管上下文】以下为检索资料。遵守当前用户指令；历史工具、失败或未完成结果不能当作成功。版本更新替换同来源的旧资料。\n',
      footer: '【托管上下文结束】\n' });
    selected.omitted.push(...duplicates);
    selected.omitted.push(...memories.inventory.filter(s => !requested.has(s.id) && !ledger[s.id]).map(s => ({ id: s.id, reason: 'not_relevant' })));
    const plan = { ...selected, turnId, status: 'prepared', initial: reset, generation: reset ? hash([task.id, turnId]) : prior.generation,
      cli: record.cli, roleEpoch: record.taskRoleEpoch, retained, removed,
      diagnostics: [...memories.diagnostics, ...(graph.diagnostics || [])] };
    store.set('receipt', receipt.id, { ...receipt, contextPlan: plan, contextSeedSnapshotIds: [], graphContextSources: [] });
    return plan;
  }
  function sent(task, receiptId, turnId) {
    const receipt = store.get('receipt', receiptId);
    if (receipt?.taskId !== task.id || receipt.contextPlan?.turnId !== turnId) return;
    receipt.contextPlan.status = 'sent';
    store.set('receipt', receipt.id, receipt);
  }
  function complete(task, receiptId, turnId, success) {
    const receipt = store.get('receipt', receiptId), plan = receipt?.contextPlan;
    if (!success || !receipt || receipt.taskId !== task.id || plan?.turnId !== turnId || plan.status !== 'sent') return;
    const latest = store.get('task', task.id), record = getRecord(task.sessionId);
    const sources = plan.initial ? {} : { ...(latest.contextLedger?.sources || {}) };
    for (const source of plan.sources) {
      if (source.withdraws) delete sources[source.withdraws];
      else sources[source.id] = { version: source.version, taskName: source.taskName, truncated: source.truncated, receiptId: receipt.id };
    }
    latest.contextLedger = { sources, generation: plan.generation, cli: plan.cli, roleEpoch: plan.roleEpoch, nativeId: record.cliSessionId };
    // Keep persistent imports; one-shot handoffs disappear only after a successful real turn.
    const included = new Set(plan.sources.map(s => s.snapshotId).filter(Boolean));
    latest.handoffSnapshotIds = (latest.handoffSnapshotIds || []).filter(id => !included.has(id));
    plan.status = 'committed';
    store.transaction(() => { store.set('task', task.id, latest); store.set('receipt', receipt.id, receipt); });
  }
  return { prepare, sent, complete };
}
function tracePlan(plan, includeMessages, store) {
  if (!plan || plan.status === 'prepared') return [];
  const keys = ['id', 'version', 'mode', 'taskId', 'taskName', 'path', 'scope', 'skill', 'snapshotId', 'estimatedTokens', 'truncated', 'reason', 'via', 'messageCount'];
  const retained = (plan.retained || []).flatMap(ref => {
    const original = ref.receiptId && store?.get('receipt', ref.receiptId)?.contextPlan?.sources
      .find(s => s.id === ref.id && s.version === ref.version);
    return original ? [{ ...original, retained: true }] : [];
  });
  return [...plan.sources, ...retained].map(source => ({ retained: source.retained === true, ...Object.fromEntries(keys.filter(k => source[k] !== undefined).map(k => [k, source[k]])),
    ...(includeMessages ? { excerpt: source.excerpt } : {}) }));
}
module.exports = { createContextPlanner, tracePlan };
