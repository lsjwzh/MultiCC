'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start, token } = require('./production-entry');

async function sample(root, gateway, addon, reference, month) {
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const output = 'prefix😀' + '文'.repeat(1999);
  const tasks = [
    { id: 'full /历史', name: '历史', kind: 'script', enabled: false, runCount: 36,
      runs: Array.from({ length: 36 }, (_, at) => ({ at, output, exitCode: 0 })) },
    { id: 'dense', name: '逐分', kind: 'script', enabled: true, cron: '* * * ' + month.number + ' *' },
    { id: 'subscription', name: '订阅', kind: 'script', enabled: false, createdBy: 'subscriptions',
      cron: '30 9 12 ' + month.number + ' *' },
    { id: 'retired', name: '到期', kind: 'script', enabled: false, createdBy: 'subscriptions', cron: '0 0 31 2 *' },
  ];
  fs.writeFileSync(path.join(data, 'scheduled_tasks.json'), JSON.stringify(tasks));
  const server = await start(root, gateway, addon, reference);
  const results = {};
  try {
    for (const [method, route, status] of [
      ['GET', '/api/cron/calendar?month=' + month.key, 200],
      ['GET', '/api/cron/calendar', 400], ['GET', '/api/cron/calendar?month=2026-00', 400],
      ['GET', '/api/cron/calendar?month=1999-01', 400], ['GET', '/api/cron/calendar?month=2&month=3', 400],
      ['OPTIONS', '/api/cron/calendar', 200],
      ['GET', '/api/CRON/' + encodeURIComponent(tasks[0].id) + '/RUNS/', 200],
      ['GET', '/api/cron/dense/runs', 200], ['GET', '/api/cron/unknown/runs', 404],
      ['HEAD', '/api/cron/dense/runs', 200], ['OPTIONS', '/api/cron/dense/runs', 200],
    ]) {
      const res = await fetch(server.origin + route, { method, signal: AbortSignal.timeout(10000),
        headers: { 'accept-encoding': 'identity', 'x-access-token': token, 'x-request-id': 'cron-test', 'x-correlation-id': 'cron-test' } });
      const key = method + ' ' + route;
      assert.equal(res.status, status, key);
      const raw = await res.text();
      if (key.endsWith('month=' + month.key)) {
        const body = JSON.parse(raw);
        assert.ok(Math.abs(Date.now() - Date.parse(body.generatedAt)) < 30000);
        delete body.generatedAt;
        assert.deepEqual(body.dense, ['dense']);
        const points = Object.values(body.days).flat();
        assert.equal(points.filter(p => p.dense && p.id === 'dense').length, 200);
        assert.equal(points.filter(p => p.id === 'subscription').length, 1);
        assert.equal(points.filter(p => p.id === 'retired').length, 0);
        results[key] = body;
      } else {
        if (route.endsWith('/RUNS/')) {
          const { runs } = JSON.parse(raw);
          assert.equal(runs.length, 20);
          assert.deepEqual([runs[0].at, runs.at(-1).at], [35, 16]);
          assert.equal(runs[0].output.length, 2000);
          assert.equal(runs[0].output.charCodeAt(0), 0xde00);
        }
        results[key] = [raw, res.headers.get('etag'), res.headers.get('allow'), res.headers.get('content-length')];
      }
    }
    return results;
  } finally { await server.stop(); }
}

(async () => {
  const [gateway, addon] = process.argv.slice(2).map(p => path.resolve(p));
  assert.ok(gateway && addon, 'expected gateway and reference addon');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-calendar-'));
  try {
    const today = new Date();
    const future = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const number = future.getMonth() + 1;
    const month = { key: future.getFullYear() + '-' + String(number).padStart(2, '0'), number };
    const baseline = await sample(path.join(tmp, 'reference'), gateway, addon, true, month);
    const actual = await sample(path.join(tmp, 'rust'), gateway, addon, false, month);
    for (const check of Object.keys(baseline)) assert.deepEqual(actual[check], baseline[check], check);
    console.log(JSON.stringify({ equal: Object.keys(actual).length }));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
