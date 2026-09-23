'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildOverview, mountWorkspaceRoutes } = require('../src/routes/workspaces');

function fixture() {
  const records = new Map([
    ['s1', { id: 's1', kind: 'chat', dirId: 'd1', workspaceState: 'awake' }],
    ['s2', { id: 's2', kind: 'chat', dirId: 'd1', workspaceState: 'hibernated' }],
    ['s3', { id: 's3', kind: 'chat', dirId: 'd1', workspaceState: 'awake', title: '任务甲',
      hibernateRemovedIgnored: { at: '2026-09-23T01:00:00.000Z', entries: [{ path: '.env', bytes: 42, mtime: '2026-09-22T00:00:00.000Z' }] } }],
    ['s4', { id: 's4', kind: 'chat', dirId: 'd2', workspaceState: 'planned' }],
    ['aux1', { id: 'aux1', kind: 'aux', dirId: 'd1' }], // not a chat session: never counted
  ]);
  const directories = new Map([
    ['d1', { id: 'd1', path: '/repo/a' }],
    ['d2', { id: 'd2', path: '/repo/b' }],
  ]);
  const orphanReport = Object.freeze({ at: '2026-09-23T02:00:00.000Z', deleteOrphans: false, total: 1, removed: 0, orphans: [{ path: '/x' }] });
  return {
    records, directories,
    swept: [],
    hibernation: {
      status: () => ({ stopped: false, scheduled: true, sweeping: false, awakeLimit: 16, idleMs: 21600000 }),
      sweep: async () => ({ ok: true, considered: 3, hibernated: 1, budget: { considered: 1, hibernated: 1 } }),
    },
    scanner: { report: () => orphanReport, scan: async () => orphanReport },
  };
}

function deps(f) {
  return { records: f.records, directories: f.directories, getHibernation: () => f.hibernation, getOrphanScanner: () => f.scanner };
}

function fakeRes() {
  return { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; } };
}

test('overview aggregates per-directory states, audit and orphan report', () => {
  const f = fixture();
  const data = buildOverview(deps(f));
  assert.deepEqual(data.totals, { awake: 2, hibernated: 1 });
  const d1 = data.directories.find(d => d.id === 'd1');
  assert.deepEqual([d1.awake, d1.hibernated, d1.total], [2, 1, 3]);
  const d2 = data.directories.find(d => d.id === 'd2');
  assert.equal(d2.planned, 1);
  assert.equal(data.status.awakeLimit, 16);
  assert.equal(data.removedIgnoredAudit.length, 1);
  assert.equal(data.removedIgnoredAudit[0].entries[0].path, '.env');
  assert.equal(data.orphans.total, 1);
});

test('routes mount and sweep handler runs the runtime sweep', async () => {
  const f = fixture();
  const routes = new Map();
  const app = {
    get: (p, h) => routes.set(`GET ${p}`, h),
    post: (p, h) => routes.set(`POST ${p}`, h),
  };
  mountWorkspaceRoutes(app, deps(f));
  const res = fakeRes();
  await routes.get('POST /api/workspaces/sweep')({ query: {} }, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sweep.considered, 3);
  assert.equal(res.body.orphans, null);
  const res2 = fakeRes();
  await routes.get('POST /api/workspaces/sweep')({ query: { orphans: '1' } }, res2);
  assert.equal(res2.body.orphans.total, 1);
  const res3 = fakeRes();
  routes.get('GET /api/workspaces/overview')({}, res3);
  assert.equal(res3.body.totals.awake, 2);
});

test('sweep returns 503 before the hibernation runtime is wired', async () => {
  const f = fixture();
  const routes = new Map();
  mountWorkspaceRoutes({ get: (p, h) => routes.set(p, h), post: (p, h) => routes.set(p, h) },
    { ...deps(f), getHibernation: () => null });
  const res = fakeRes();
  await routes.get('/api/workspaces/sweep')({ query: {} }, res);
  assert.equal(res.statusCode, 503);
});
