'use strict';

function createHibernationReclaimer({
  records,
  now,
  idleMs,
  batchSize,
  eligible,
  hibernate,
  publish,
  isStopped,
}) {
  let capacityTail = Promise.resolve();
  let capacityRuns = 0;

  function candidatesFor({ dirId = null, ignoreIdle = false, excludeSessionIds = [], idleMs: idleMsOverride = null, reportSkips = null } = {}) {
    const excluded = new Set(Array.isArray(excludeSessionIds) ? excludeSessionIds : [excludeSessionIds]);
    // 手动回收可以带一个更宽/更紧的闲置阈值；给不出有效数字就退回运行时的默认值。
    const threshold = idleMsOverride != null && Number.isFinite(Number(idleMsOverride))
      ? Number(idleMsOverride)
      : idleMs;
    const candidates = [];
    for (const record of records.values()) {
      if (dirId && record?.dirId !== dirId) continue;
      if (excluded.has(record?.id)) continue;
      const verdict = eligible(record, { nowMs: now(), idleMs: ignoreIdle ? 0 : threshold });
      if (verdict.eligible) candidates.push({ record, lastWorkMs: verdict.lastWorkMs });
      // 容量回收是紧急路径：它只想知道「谁最老、能不能腾出来」，为每条不合适的
      // 记录都发一个 skip 事件纯属噪声。手动/定时扫描才需要这些原因。
      else if ((reportSkips ?? !ignoreIdle) && record?.taskBoundTaskId && record.kind === 'chat') {
        // 走到这里说明这条记录**没被选中**（闲置不够、或正被占用），如实报出原因,
        // 面板才能回答「为什么只剩它没回收」。
        publish('sweep', 'skip', record.id, verdict.reasons[0] || 'ineligible');
      }
    }
    candidates.sort((left, right) => left.lastWorkMs - right.lastWorkMs
      || left.record.id.localeCompare(right.record.id));
    return candidates;
  }

  async function runCandidates(candidates, { limit = batchSize, ignoreIdle = false, idleMs: idleMsOverride = null } = {}) {
    let attempted = 0, hibernated = 0, failed = 0, skipped = 0;
    // Keep scanning past unsafe or broken old checkouts until the success
    // budget is filled; one bad candidate must not starve every younger one.
    for (const candidate of candidates) {
      if (hibernated >= limit) break;
      attempted += 1;
      let result;
      try {
        result = await hibernate(candidate.record.id, { eligibilityChecked: true, ignoreIdle, idleMs: idleMsOverride });
      } catch (_) {
        failed += 1;
        continue;
      }
      if (result.ok && result.hibernated) hibernated += 1;
      else if (result.skipped || result.already) skipped += 1;
      else failed += 1;
    }
    return { attempted, hibernated, failed, skipped };
  }

  function reclaimForCapacity({ dirId, excludeSessionIds = [], count = 1 } = {}) {
    if (!dirId) return Promise.resolve({ ok: false, code: 'directory_required', considered: 0, hibernated: 0 });
    const limit = Math.max(1, Math.min(64, Number(count) || 1));
    capacityRuns += 1;
    const run = capacityTail.catch(() => {}).then(async () => {
      if (isStopped()) return { ok: false, code: 'hibernation_stopped', considered: 0, hibernated: 0 };
      const candidates = candidatesFor({ dirId, ignoreIdle: true, excludeSessionIds });
      return { ok: true, considered: candidates.length,
        ...await runCandidates(candidates, { limit, ignoreIdle: true }) };
    }).finally(() => { capacityRuns -= 1; });
    capacityTail = run.catch(() => {});
    return run;
  }

  return Object.freeze({
    candidatesFor,
    pendingCapacity: () => capacityRuns,
    reclaimForCapacity,
    runCandidates,
    settleCapacity: () => capacityTail,
  });
}

module.exports = { createHibernationReclaimer };
