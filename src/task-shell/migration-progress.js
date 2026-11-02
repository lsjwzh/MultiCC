'use strict';

// 任务仓储升级进度：把 Rust 写在库旁的进度文件（阶段/计数/字节数）折算成一个总百分比。
// 各阶段的权重按真实库实测耗时分配（备份 3–10s、逐行改写 26–48s、整理 5–10s）。
const STEPS = {
  backup: { from: 0, to: 15, step: 'backup' },
  scan: { from: 15, to: 20, step: 'migrate' },
  rewrite: { from: 20, to: 75, step: 'migrate' },
  compact: { from: 75, to: 85, step: 'migrate' },
  ledger: { from: 85, to: 90, step: 'migrate' },
  vacuum: { from: 90, to: 99, step: 'vacuum' },
};
// 整理阶段没有计数可报，按已用时间渐近逼近（永远不到 99%，完成由就绪信号宣告）。
const VACUUM_TIME_CONSTANT_MS = 8000;

function fraction(state, { statSize }) {
  if (state.phase === 'backup') {
    // 备份改名到位后半成品已不在：按 Rust 报的 1/1 算，不能掉回 0。
    if (Number(state.total) > 0) return Math.min(1, (Number(state.done) || 0) / Number(state.total));
    const total = Number(state.dbBytes) || 0;
    if (!total || !state.backupPartial) return 0;
    return Math.min(1, statSize(state.backupPartial) / total);
  }
  const total = Number(state.total) || 0;
  return total > 0 ? Math.min(1, (Number(state.done) || 0) / total) : 0;
}

function describeMigration(state, { now = Date.now(), statSize = () => 0, failure = null } = {}) {
  const startedAt = Number(state?.startedAt) || null;
  const base = { state: 'running', step: 'starting', percent: 0, startedAt,
    elapsedMs: startedAt ? Math.max(0, now - startedAt) : 0 };
  const failed = failure || (state?.phase === 'failed' ? { error: state.error } : null);
  if (failed) {
    const message = String(failed.error || failed.message || 'task_store_migration_failed');
    const code = message.split(':')[0].trim() || 'task_store_migration_failed';
    const out = { ...base, state: 'failed', step: 'failed', error: { code, message } };
    if (Number.isFinite(state?.needBytes)) out.error.needBytes = state.needBytes;
    if (Number.isFinite(state?.freeBytes)) out.error.freeBytes = state.freeBytes;
    if (failed.retrying) out.error.retrying = true;
    return out;
  }
  const weight = STEPS[state?.phase];
  if (!weight) return base;
  let f = fraction(state, { statSize });
  if (state.phase === 'vacuum') {
    const since = Math.max(0, now - (Number(state.updatedAt) || now));
    f = 1 - Math.exp(-since / VACUUM_TIME_CONSTANT_MS);
  }
  const percent = Math.floor(weight.from + (weight.to - weight.from) * f);
  return { ...base, step: weight.step, phase: state.phase, percent,
    ...(state.total ? { done: state.done, total: state.total } : {}) };
}

module.exports = { describeMigration, STEPS };
