'use strict';
// 任务仓储升级闸门（src/task-shell/migration-gate.js）：迁移期间工作线程替正式服务占住
// 端口、报告进度；完成后让出端口；空间不足自动重试；其他失败停住而不是崩溃重启。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { describeMigration } = require('../src/task-shell/migration-progress');
const { runTaskStoreMigrationGate } = require('../src/task-shell/migration-gate');

test('进度：各阶段折算成单调递增的总百分比，失败带上空间数字', () => {
  const at = 1_000_000;
  const states = [
    { phase: 'backup', dbBytes: 100, backupPartial: '/p' }, { phase: 'scan' },
    { phase: 'rewrite', done: 10, total: 100 }, { phase: 'rewrite', done: 90, total: 100 },
    { phase: 'compact', done: 1, total: 2 }, { phase: 'ledger', done: 0, total: 1 }, { phase: 'vacuum', updatedAt: at },
  ].map(s => describeMigration({ startedAt: at - 5000, ...s }, { now: at + 4000, statSize: () => 60 }));
  const percents = states.map(s => s.percent);
  assert.deepEqual(percents, [...percents].sort((a, b) => a - b));
  assert.equal(states[0].percent, 9, '备份按半成品大小算');
  assert.equal(describeMigration({ phase: 'backup', done: 1, total: 1, dbBytes: 100, backupPartial: '/gone' }).percent, 15,
    '备份改名后半成品已不在，按 1/1 算而不是掉回 0');
  assert.ok(states.at(-1).percent < 99 && states.at(-1).percent >= 90, '整理阶段不会报到完成');
  assert.equal(states[0].elapsedMs, 9000);
  const failed = describeMigration({ phase: 'failed', error: 'task_store_migration_needs_space: need 9 bytes free, have 1', needBytes: 9, freeBytes: 1 });
  assert.deepEqual(failed.error, { code: 'task_store_migration_needs_space', message: 'task_store_migration_needs_space: need 9 bytes free, have 1', needBytes: 9, freeBytes: 1 });
  assert.equal(describeMigration(null).step, 'starting');
});

test('闸门：不需要迁移时零开销；空间不足自动重试直到成功，进度页先报原因再清掉', t => {
  const quiet = { info() {}, error() {} };
  let opened = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'shell.sqlite');
  fs.writeFileSync(`${file}.migration.json`, '{"phase":"vacuum"}');
  const idle = runTaskStoreMigrationGate({ file, port: 1, host: '127.0.0.1', logger: quiet,
    addon: { taskStoreMigrationPending: () => false }, openPage: () => { opened += 1; } });
  assert.deepEqual(idle, { migrated: false });
  assert.equal(opened, 0);
  assert.equal(fs.existsSync(`${file}.migration.json`), false, '已是新版本时清掉上次留下的进度文件');
  const events = [];
  let calls = 0;
  const result = runTaskStoreMigrationGate({ file: '/x', port: 1, host: '127.0.0.1', logger: quiet,
    sleep: ms => events.push(['sleep', ms]),
    openPage: () => ({ fail: f => events.push(['fail', f && f.retrying]), stop: () => events.push(['stop']) }),
    addon: { taskStoreMigrationPending: () => true,
      migrateTaskStore: () => { if (++calls < 3) throw new Error('task_store_migration_needs_space: need 9 bytes free, have 1'); return '{"from":1,"to":2}'; } } });
  assert.deepEqual(result, { migrated: true, report: { from: 1, to: 2 } });
  assert.deepEqual(events, [['fail', true], ['sleep', 30000], ['fail', null], ['fail', true], ['sleep', 30000], ['fail', null], ['stop']]);
});

function freePort() {
  return new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
// 子进程里跑闸门：假原生模块的迁移同步阻塞主线程 1.5 秒、期间写进度文件。
function runChild(t, port, file, mode) {
  const script = `
    const fs = require('fs');
    const { runTaskStoreMigrationGate } = require(${JSON.stringify(path.resolve(__dirname, '../src/task-shell/migration-gate'))});
    const block = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const write = s => fs.writeFileSync(${JSON.stringify(file)} + '.migration.json', JSON.stringify({ startedAt: Date.now(), ...s }));
    runTaskStoreMigrationGate({ file: ${JSON.stringify(file)}, port: ${port}, host: '0.0.0.0', logger: { info() {}, error() {} },
      addon: { taskStoreMigrationPending: () => true, migrateTaskStore: () => {
        write({ phase: 'rewrite', done: 50, total: 100 });
        block(1500);
        if (${JSON.stringify(mode)} === 'fail') { write({ phase: 'failed', error: 'boom: broken' }); throw new Error('boom: broken'); }
        return '{}';
      } } });
    require('http').createServer((q, r) => r.end('real')).listen(${port}, '127.0.0.1', () => console.log('listening'));`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  return child;
}
async function poll(url, accept = 'application/json') {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url, { headers: { accept } }); return { status: r.status, text: await r.text() }; }
    catch { await new Promise(r => setTimeout(r, 30)); }
  }
  throw new Error('never answered');
}

test('闸门：迁移期间端口回 503 + 进度（接口 JSON、浏览器进度页），完成后让出端口给正式服务', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const child = runChild(t, port, path.join(dir, 'shell.sqlite'), 'ok');
  let out = '';
  child.stdout.on('data', d => { out += d; });
  const ready = await poll(`http://127.0.0.1:${port}/readyz`);
  assert.equal(ready.status, 503);
  const body = JSON.parse(ready.text);
  assert.equal(body.phase, 'data-migration');
  assert.equal(body.migration.state, 'running');
  assert.equal(body.migration.percent, 47);
  const html = await poll(`http://127.0.0.1:${port}/`, 'text/html');
  assert.equal(html.status, 503);
  assert.match(html.text, /正在升级任务数据/);
  assert.match(html.text, /fetch\('\/readyz'/, '页面轮询就绪状态，连不上时继续等而不是停在错误页');
  await new Promise(resolve => child.stdout.on('data', () => out.includes('listening') && resolve()));
  assert.equal((await poll(`http://127.0.0.1:${port}/readyz`)).text, 'real', '正式服务拿到了同一个端口');
});

test('闸门：迁移失败不崩溃重启，端口报告原因；SIGTERM 照常结束进程', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const child = runChild(t, port, path.join(dir, 'shell.sqlite'), 'fail');
  let failed;
  for (let i = 0; i < 100 && !failed; i++) {
    const body = JSON.parse((await poll(`http://127.0.0.1:${port}/readyz`)).text);
    if (body.migration.state === 'failed') failed = body.migration;
    else await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(failed.error.code, 'boom');
  assert.equal(child.exitCode, null, '停在失败页，不退出');
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve(signal)));
  child.kill('SIGTERM');
  assert.equal(await exited, 'SIGTERM');
});
