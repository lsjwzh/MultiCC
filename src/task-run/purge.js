'use strict';

function assertTaskPurgeable(db, taskId) {
  const runs = db.prepare('SELECT run_id, execution_status FROM task_runs WHERE task_id = ?').all(taskId);
  for (const run of runs) {
    const lease = db.prepare('SELECT state FROM task_run_slot_leases WHERE run_id = ?').get(run.run_id);
    if (!['succeeded', 'failed', 'cancelled'].includes(run.execution_status) || (lease && lease.state !== 'released')) {
      throw Object.assign(new Error('task_busy'), { code: 'task_busy' });
    }
  }
  return runs;
}

function purgeTask(db, taskId) {
  return db.transaction(() => {
    const runs = assertTaskPurgeable(db, taskId);
    for (const run of runs) {
      for (const table of ['task_run_slot_leases', 'task_run_recovery_quarantine', 'task_run_cleanup_manifests',
        'task_run_messages', 'task_run_artifacts', 'task_run_answer_receipts', 'task_run_usage_events', 'task_run_usage_dimensions']) {
        db.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(run.run_id);
      }
    }
    return db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(taskId).changes;
  }).immediate();
}

module.exports = { purgeTask, assertTaskPurgeable };
