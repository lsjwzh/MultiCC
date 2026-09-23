'use strict';

// Workspace overview/sweep API backing the /manage「工作区」panel: per-directory
// awake/hibernated counts, the LRU budget state, the hibernate deletion audit
// trail and the latest orphan-worktree reconciliation report.

const AUDIT_LIMIT = 20;

function stateOf(record) {
  return record?.workspaceState || 'awake';
}

function buildOverview(deps) {
  const runtime = deps.getHibernation();
  const perDir = new Map();
  for (const dir of deps.directories.values()) {
    perDir.set(dir.id, { id: dir.id, path: dir.path, awake: 0, hibernated: 0, transitioning: 0, planned: 0, total: 0 });
  }
  let awake = 0; let hibernated = 0;
  for (const record of deps.records.values()) {
    if (record?.kind !== 'chat' || !record?.dirId) continue;
    const bucket = perDir.get(record.dirId);
    if (!bucket) continue;
    const state = stateOf(record);
    bucket.total += 1;
    if (state === 'awake') { bucket.awake += 1; awake += 1; }
    else if (state === 'hibernated') { bucket.hibernated += 1; hibernated += 1; }
    else if (state === 'planned') bucket.planned += 1;
    else bucket.transitioning += 1;
  }
  const audit = [];
  for (const record of deps.records.values()) {
    const removed = record?.hibernateRemovedIgnored;
    if (!removed?.at || !Array.isArray(removed.entries)) continue;
    audit.push({ sessionId: record.id, title: record.title || null, at: removed.at, entries: removed.entries });
  }
  audit.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return {
    status: runtime ? runtime.status() : null,
    totals: { awake, hibernated },
    directories: [...perDir.values()].filter(d => d.total > 0),
    removedIgnoredAudit: audit.slice(0, AUDIT_LIMIT),
    orphans: deps.getOrphanScanner()?.report() || null,
  };
}

function createOverviewHandler(deps) {
  return function overviewHandler(req, res) {
    try { res.json(buildOverview(deps)); }
    catch (error) { res.status(500).json({ error: error?.message || 'overview failed' }); }
  };
}

function createSweepHandler(deps) {
  return async function sweepHandler(req, res) {
    const runtime = deps.getHibernation();
    if (!runtime) return res.status(503).json({ error: 'hibernation runtime not ready' });
    try {
      const result = await runtime.sweep();
      let orphans = null;
      if (req.query?.orphans === '1') orphans = await deps.getOrphanScanner()?.scan() || null;
      res.json({ ok: true, sweep: result, orphans });
    } catch (error) {
      res.status(500).json({ ok: false, error: error?.message || 'sweep failed' });
    }
  };
}

function mountWorkspaceRoutes(app, deps) {
  if (!app || typeof app.get !== 'function') throw new TypeError('Express app is required');
  for (const name of ['getHibernation', 'getOrphanScanner']) {
    if (typeof deps?.[name] !== 'function') throw new TypeError(`workspace route dependency missing: ${name}`);
  }
  if (!(deps.records instanceof Map) || !(deps.directories instanceof Map)) {
    throw new TypeError('workspace routes require record and directory maps');
  }
  app.get('/api/workspaces/overview', createOverviewHandler(deps));
  app.post('/api/workspaces/sweep', createSweepHandler(deps));
}

module.exports = { buildOverview, mountWorkspaceRoutes };
