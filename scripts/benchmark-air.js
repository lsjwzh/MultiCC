// Exercise the public gateway and its real host/index against an isolated board and store.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const count = 1600;

async function host() {
  const express = require('express');
  const fromSource = require('node:module').createRequire(path.join(process.env.AIR_BENCH_ROOT || path.resolve(__dirname, '..'), 'server.js'));
  const binding = fromSource('./src/native/binding');
  const { createTaskShellStore } = fromSource('./src/task-shell/store');
  const { createTaskActions } = fromSource('./src/task-shell/task-actions');
  const app = express();
  app.locals.auth = binding.authSecurity.createAuthSecurity({ secret: process.env.ACCESS_TOKEN });
  binding.gatewayChild.connectAuthControl(app.locals.auth);
  app.use(express.json());
  const records = new Map();
  const tasks = {};
  const workspaces = [];
  const store = createTaskShellStore(':memory:');
  store.transaction(() => {
    for (let i = 0; i < count; ++i) {
      const id = 'tsk_' + i, sid = 's' + i;
      records.set(sid, { id: sid, kind: 'chat', cli: 'codex', dirId: 'repo', taskBoundTaskId: id, worktreePath: '/fixtures/worktree/' + i });
      tasks[id] = { id, dirId: 'repo', taskFirst: true, sessionId: sid, ownerShellId: sid, chatSessionId: sid, title: 'Task ' + i,
        updatedAt: i + 1, status: i % 3 ? 'active' : 'done', refs: [{ sessionId: sid, dirId: 'repo', ts: i + 1 }] };
      store.set('task', id, tasks[id]);
      store.set('task-first:indexed', id, { taskId: id, sessionId: sid, version: 1 });
      store.set('shell', sid, { id: sid, standalone: true, sourceSessionId: sid });
      workspaces.push({ id: 'w' + i, dirId: 'repo', ownerId: sid, residency: 'planned' });
    }
  });
  const board = binding.taskBoardStore.openBoardStore({ raw: { schemaVersion: 2, revision: 1, tasks,
    modules: {}, taskGroups: {}, deletedTaskIds: [] } }).board;
  const actions = createTaskActions({ store, getRecord: id => records.get(id), getTask: id => board.tasks[id], ports: {}, shell: sid => store.get('shell', sid), open: sid => store.get('shell', sid) });
  const migration = fromSource('./src/task-shell/task-first').createTaskFirstMigration({
    store, ports: { getDirectory: () => ({ id: 'repo' }),
      deletedAmong: ids => binding.taskDomainHost.taskDomainAsync({ op: 'deletedAmong', board, ids }) },
  });
  const phases = [];
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const air = binding.airRoutesHost.createAirRuntime({
    getBoard: () => board, records, directories: new Map([['repo', { id: 'repo', name: 'Repo' }]]),
    admission: { snapshot: () => ({ workspaces, leases: [], budgets: {} }), capacityReason: () => null },
    clis: ['codex'], registerSync() {}, shell: { ...actions, listTasks: () => store.cachedList('task'), migrateTaskSessions: () => migration.migrate([...records.values()]) },
    phaseDiagnostics: { logMs: 0, gapMs: 0, bootGapMs: 0 }, logger: { warn(event, data) {
      if (event === 'air_snapshot_slow') phases.push(data);
      else console.error(event, data);
    } },
  });
  const hostReads = [];
  app.use('/api/__host/air', (req, res, next) => {
    const op = req.body?.op;
    if (op === 'sync' || op === 'snapshot') {
      const started = performance.now();
      res.once('finish', () => hostReads.push({ op, ms: performance.now() - started }));
    }
    next();
  });
  air.mount(app);
  app.get('/bench/ready', (_, res) => res.sendStatus(200));
  app.post('/bench/change', async (req, res) => {
    board.tasks.tsk_0.updatedAt++;
    air.liveSync.invalidate(['tsk_0']);
    await air.liveSync.flush();
    res.json({ ok: true });
  });
  app.get('/bench/sample', (_, res) => {
    res.json({ loopMax: histogram.max / 1e6, phases: phases.splice(0), hostReads: hostReads.splice(0) });
    histogram.reset();
  });
  const port = Number(process.env.MULTICC_GATEWAY_INTERNAL_PORT || process.env.PORT);
  binding.gatewayChild.listenBehindGateway(require('node:http').createServer(app), { port, onListening() {
    const control = app.listen(0, '127.0.0.1', () => fs.writeFileSync('host-port', String(control.address().port)));
  } });
}
module.exports = { host };

function summary(samples) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return [0.5, 0.95, 1].map(q => Number(sorted[Math.ceil(sorted.length * q) - 1].toFixed(2)));
}
async function bench() {
  const gateway = path.resolve(process.argv[2]);
  assert.ok(path.isAbsolute(process.env.MULTICC_RUST_ADDON));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'air-snapshot-bench-'));
  const listener = require('node:net').createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  fs.writeFileSync(path.join(dir, 'server.js'), 'require(' + JSON.stringify(__filename) + ').host().catch(e => { console.error(e); process.exit(1) });');
  const child = require('node:child_process').spawn(gateway, ['serve', '--cwd', dir, '--node', process.execPath, 'server.js'], {
    env: { AIR_BENCH_ROOT: process.env.AIR_BENCH_ROOT, PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH, HOME: dir, PORT: String(port),
      MULTICC_DATA_DIR: dir, ACCESS_TOKEN: 'fixture-only', MULTICC_RUST_ADDON: process.env.MULTICC_RUST_ADDON },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const exited = once(child, 'exit');
  const read = async (base, route, method = 'GET') => {
    const r = await fetch(base + route, { method, headers: { Authorization: 'Bearer fixture-only' } });
    const body = await r.text();
    assert.equal(r.status, 200, body.slice(0, 200));
    return body;
  };
  try {
    const marker = path.join(dir, 'host-port');
    for (let i = 0; !fs.existsSync(marker); ++i) {
      assert.ok(i < 300 && child.exitCode === null, 'host startup failed');
      await delay(100);
    }
    const base = 'http://127.0.0.1:' + port;
    const ctl = 'http://127.0.0.1:' + fs.readFileSync(marker, 'utf8');
    for (let i = 0; ; ++i) {
      const r = await fetch(base + '/bench/ready', { headers: { Authorization: 'Bearer fixture-only' } });
      await r.arrayBuffer();
      if (r.status === 200) break;
      assert.ok(i < 100, 'gateway did not reach the host');
      await delay(50);
    }
    const sample = async () => JSON.parse(await read(ctl, '/bench/sample'));
    const startup = await sample();
    assert.ok(!startup.phases.some(p => p.cardCount), 'board built before cold request');
    const first = performance.now();
    assert.equal(JSON.parse(await read(base, '/api/air')).tasks.length, count);
    const cold = performance.now() - first;
    const initial = await sample();
    const result = { cards: count, coldMs: cold, startupLoopMax: startup.loopMax, coldLoopMax: initial.loopMax,
      coldPhases: initial.phases.find(p => p.cardCount), groups: {} };
    const groups = process.argv.slice(3);
    for (const op of groups.length ? groups : ['snapshot', 'sync', 'change']) {
      assert.ok(['snapshot', 'sync', 'change'].includes(op));
      const times = [];
      for (let i = 0; i < 32; i++) {
        const start = performance.now();
        if (op === 'change') await read(ctl, '/bench/change', 'POST');
        await read(base, op === 'sync' ? '/api/air/sync' : '/api/air');
        times.push(performance.now() - start);
      }
      await delay(5);
      const { loopMax, phases, hostReads } = await sample();
      const builds = phases.filter(p => p.cardCount !== undefined);
      const phasesMs = {};
      for (const k of Object.keys(builds[0] || {}).filter(k => k.endsWith('Ms'))) phasesMs[k] = summary(builds.map(p => p[k]))[0];
      const privateMs = hostReads.filter(row => row.op === (op === 'sync' ? 'sync' : 'snapshot')).map(row => row.ms);
      assert.equal(privateMs.length, times.length);
      const requestTotals = phases.filter(p => p.status === 200).map(p => p.totalMs);
      const signatures = builds.map(p => p.signatureBuilds).filter(Number.isFinite);
      result.groups[op] = { p50_p95_max: summary(times), loopMax, phasesMs,
        hostPortMs: summary(privateMs),
        outsideHostPortMs: summary(times.map((ms, i) => ms - privateMs[i])),
        hostReadMs: requestTotals.length ? summary(requestTotals) : undefined,
        signatureBuilds: signatures.length ? summary(signatures) : undefined };
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    child.kill('SIGTERM');
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
if (require.main === module) bench().catch(e => { console.error(e); process.exitCode = 1; });
