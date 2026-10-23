#!/usr/bin/env node
'use strict';
// Isolated comparison harness. Node business code here is a test oracle only;
// current production row caches/read index are reused as the optimized baseline.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { CompatDatabase: NodeDatabase } = require('../src/sqlite/node-driver');
const { fixtures, initialize, cachedNodeModel, reusingNodeModel, oracle, project } = require('../tests/helpers/task-read-model');
const { createTaskReadModel } = require('../src/native/task-read-model');
const tick = () => new Promise(resolve => setTimeout(resolve, 2));
const median = a => [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)];
const rounded = n => Math.round(n * 1000) / 1000;
function equivalent(actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  // Key order across the JSON boundary is irrelevant; errors must never dump
  // task titles, message bodies or other private source fields into logs.
  try { require('node:assert/strict').deepEqual(actual, expected); }
  catch { throw new Error('read_model_comparison_failed'); }
}
async function child(config) {
  const { backend, file, rounds, count, real } = config;
  // The writer uses the same SQLite driver as that worker's reader. Independently
  // linked SQLite engines in one process are not a sound concurrent-lock baseline.
  const Driver = require('../src/sqlite/driver').databaseConstructor();
  const db = new Driver(file), rows = db.prepare("SELECT body FROM shell_records WHERE kind='task' ORDER BY rowid").all();
  const tasks = rows.map(r => JSON.parse(r.body));
  const { metadata, overlays } = real ? { metadata: {}, overlays: {} } : fixtures(count);
  const options = { status: 'all', limit: 20 }, dayStart = 5002;
  let model, sqlite, initialized = false;
  async function open() {
    if (backend === 'rust') {
      model = createTaskReadModel(); sqlite = (await model.run({ op: 'open', file })).sqlite;
    } else { model = (backend === 'node-reuse' ? reusingNodeModel : cachedNodeModel)(file); sqlite = model.sqlite; }
    initialized = false;
  }
  async function refresh(name) {
    if (!initialized || !['rust', 'node-reuse'].includes(backend)) {
      if (backend === 'rust') await model.run({ op: 'refresh', metadata, overlays });
      else model.refresh({ metadata, overlays });
      initialized = true; return;
    }
    const input = name === 'metadataChange' ? { metadata } : name === 'overlayChange' && tasks.length
      ? { overlayChanges: { [tasks[0].id]: overlays[tasks[0].id] } } : {};
    if (backend === 'rust') await model.run({ op: 'sync', ...input }); else model.sync(input);
  }
  async function query() {
    if (backend === 'rust') {
      const { page: { revision, ...page }, counts } = await model.run({ op: 'view', options, dayStart });
      return { page, counts };
    }
    return { page: model.page(options), counts: model.stats(dayStart) };
  }
  async function verify() {
    const expected=oracle(tasks,metadata,overlays);
    equivalent(await query(),{page:expected.page(options),counts:expected.stats(dayStart)});
    const actual=backend==='rust'?(await model.run({op:'snapshot'})).tasks:model.snapshot();
    equivalent(actual,expected.snapshot().tasks);
  }
  const writer = db.prepare("UPDATE shell_records SET body=? WHERE kind='task' AND id=?");
  let serial = 0, previousTitle = tasks[0]?.title;
  function change() {
    if (!tasks.length) return;
    tasks[0] = { ...tasks[0], title: `${previousTitle} ${++serial}` };
    writer.run(JSON.stringify(tasks[0]), tasks[0].id);
  }
  await open(); await refresh();
  await verify();
  const cases = {};
  try {
    for (const name of ['coldRead', 'warmRefresh', 'reloadOne', 'metadataChange', 'overlayChange', 'cachedQuery']) {
      const elapsed = [], gaps = [], cpu = [];
      for (let round = -2; round < rounds; round++) {
        if (name === 'coldRead') { await model.close(); await open(); }
        else if (name === 'reloadOne') change();
        else if (name === 'metadataChange') metadata.taskPins = round % 2 ? [tasks[0]?.id].filter(Boolean) : [];
        else if (name === 'overlayChange' && tasks.length) overlays[tasks[0].id] = { runState: round % 2 ? 'running' : 'waiting' };
        let previous = performance.now(), maxGap = 0;
        const heartbeat = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; }, 1);
        await tick(); const startCpu = process.cpuUsage(), start = performance.now();
        if (name !== 'cachedQuery') await refresh(name);
        await query();
        const duration = performance.now() - start, used = process.cpuUsage(startCpu);
        await tick(); clearInterval(heartbeat);
        if (tasks.length) {
          const changedOptions = { status: 'all', ids: [tasks[0].id] };
          const changedPage = backend === 'rust' ? await model.run({ op: 'page', options: changedOptions }) : model.page(changedOptions);
          equivalent(changedPage.tasks, JSON.parse(JSON.stringify([project(tasks[0], overlays)])));
        }
        if (round >= 0) { elapsed.push(duration); gaps.push(maxGap); cpu.push((used.user + used.system) / 1000); }
      }
      await verify();
      cases[name] = { medianMs: rounded(median(elapsed)), p95Ms: rounded([...elapsed].sort((a, b) => a - b)[Math.ceil(rounds * 0.95) - 1]),
        heartbeatMedianMs: rounded(median(gaps)), cpuMedianMs: rounded(median(cpu)), samplesMs: elapsed.map(rounded) };
    }
    return { backend, count: tasks.length, sqlite,
    maxRssMiB: rounded(process.resourceUsage().maxRSS / 1024), cases };
  } finally { await model.close(); db.close(); }
}
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--child') { process.stdout.write(JSON.stringify(await child(JSON.parse(args[1])))); return; }
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--sizes', '--rounds', '--out', '--source'].includes(args[i]) || !args[i + 1]) throw new Error('expected --sizes N,N --rounds N --out FILE [--source READONLY_DB]');
    flags[args[i]] = args[i + 1];
  }
  const sizes = (flags['--sizes'] || '100,3000,10000').split(',').map(Number), rounds = Number(flags['--rounds'] || 11);
  if (!sizes.every(n => Number.isInteger(n) && n > 0 && n <= 10000) || !Number.isInteger(rounds) || rounds < 3 || rounds > 50) throw new Error('invalid benchmark size/rounds');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-read-model-benchmark-'));
  const report = { at: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model, rounds, bytesPerSyntheticContext: 8192, results: [] };
  try {
    const datasets = sizes.map(count => ({ count, real: false }));
    if (flags['--source']) {
      // A read-only source connection and one read transaction capture a stable,
      // task-only copy. No production DB is ever passed to the timed worker.
      const source = new NodeDatabase(path.resolve(flags['--source']), { readonly: true });
      try {
        source.exec('BEGIN');
        if(source.pragma('user_version',{simple:true})!==1)throw new Error('source_schema_unsupported');
        const rows = source.prepare("SELECT id,body FROM shell_records WHERE kind='task' ORDER BY rowid").all();
        source.exec('COMMIT');
        if (!rows.length) throw new Error('source_has_no_tasks');
        datasets.push({ count: rows.length, real: true, rows });
        report.sourceSnapshot = { count: rows.length, rawBytes: rows.reduce((n, r) => n + Buffer.byteLength(r.body), 0),
          scope: 'read-only capture; task-only isolated copies; no live Air contract or production latency claim' };
      } finally { source.close(); }
    }
    for (const dataset of datasets) {
      for (const backend of ['node-current', 'node-native', 'node-reuse', 'rust']) {
        const file = path.join(root, `${dataset.real ? 'snapshot' : dataset.count}-${backend}.sqlite`);
        const db = new NodeDatabase(file);
        if (dataset.real) {
          initialize(db, []);
          const put = db.prepare("INSERT INTO shell_records VALUES('task',?,?)");
          db.transaction(() => { for (const r of dataset.rows) put.run(r.id, r.body); })();
        } else initialize(db, fixtures(dataset.count).tasks);
        db.close();
        const config = { backend, file, rounds, count: dataset.count, real: dataset.real };
        const result = spawnSync(process.execPath, [__filename, '--child', JSON.stringify(config)], {
          encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, MULTICC_SQLITE_BACKEND: backend === 'node-native' ? 'node' : 'rust' },
        });
        if (result.status !== 0) throw new Error(`benchmark_worker_failed:${backend}:${result.stderr.slice(-1500)}`);
        report.results.push({ dataset: dataset.real ? 'source-snapshot' : 'synthetic', ...JSON.parse(result.stdout) });
        console.error(`verified ${dataset.real ? 'snapshot' : dataset.count} ${backend}`);
      }
    }
    if (flags['--out']) { fs.mkdirSync(path.dirname(path.resolve(flags['--out'])), { recursive: true });
      fs.writeFileSync(flags['--out'], JSON.stringify(report, null, 2) + '\n'); }
    else console.log(JSON.stringify(report, null, 2));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
