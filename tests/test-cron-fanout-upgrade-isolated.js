'use strict';
// Real host booted twice over legacy data written by a release <= 2.0.2: the
// first boot must archive the cron fan-out residue exactly once (leaving every
// fixed Air task alone), and the second boot must be a no-op.
//
// Only the composition is under test here — detection, version gating and
// idempotency have unit coverage in tests/test-cron-fanout-migration.js.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createPaths, assertTestDir } = require('../src/paths');
const { writeJsonAtomic } = require('../src/state/store');
const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cron-fanout-upgrade-')));
const data = path.join(root, 'data'), home = path.join(root, 'home'), project = path.join(root, 'project');
for (const dir of [data, home, project]) fs.mkdirSync(dir);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(project, 'init', '-b', 'main'); fs.writeFileSync(path.join(project, 'README.md'), 'cron upgrade project');
git(project, 'add', '.'); git(project, '-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-m', 'initial');
const paths = createPaths({ dataDir: data });
const PROMPT = '检查 Mafit 全链路健康，以 curl -s http://127.0.0.1:8770/api/health 的 ok / mafit_service 为准；健康项跳过，不无谓重启。';
const RULE = { id: 'cron_health', name: 'Mafit 全链路健康检查', dirId: 'd1', cli: 'claude',
  cron: '0 9 * * *', prompt: PROMPT, enabled: true, createdAt: '2026-09-01T00:00:00.000Z',
  taskId: 'tsk_fixed', taskSessionId: 'task-tsk_fixed', taskBindingVersion: 1 };
// Same shapes the old classifier wrote, plus the two tasks that must survive:
// the rule's fixed Air task and an ordinary conversation-bound task.
const residueTask = (id, extra = {}) => ({ id, title: PROMPT.slice(0, 40), status: 'active',
  origin: 'session', recordType: 'observed', refs: [], areas: [], createdAt: 1788502632320,
  updatedAt: 1788502651476, moduleId: 'mod-1',
  moduleAssignment: { running: false, attempts: 0, lastAttemptAt: 0, lastError: 'missing_context' }, ...extra });
const board = {
  schemaVersion: 2, revision: 7, modules: {}, taskGroups: {}, deletedTaskIds: [],
  tasks: {
    tsk_fixed: { id: 'tsk_fixed', title: 'Mafit 全链路健康检查', status: 'active', origin: 'session',
      recordType: 'observed', refs: [{ sessionId: 'task-tsk_fixed', dirId: 'd1' }], chatSessionId: 'task-tsk_fixed',
      ownerShellId: 'sh_fixed', areas: [], createdAt: 1788000000000, updatedAt: 1788000000000 },
    tsk_real: { id: 'tsk_real', title: '调整健康检查阈值', status: 'active', origin: 'session',
      recordType: 'observed', areas: [], createdAt: 1788500000000, updatedAt: 1788500000000,
      refs: [{ sessionId: 'marketing-claude-chat-1', dirId: 'd1', excerpt: '把阈值调到 3 次' }],
      chatSessionId: 'marketing-claude-chat-1' },
    tsk_residue_a: residueTask('tsk_residue_a'),
    tsk_residue_b: residueTask('tsk_residue_b', { title: 'Mafit 全链路健康检查' }),
    tsk_residue_archived: residueTask('tsk_residue_archived', { status: 'archived', archivedFromStatus: 'active' }),
  },
};
fs.writeFileSync(path.join(data, '.multicc_upgrade'), '2.0.2\n');
writeJsonAtomic(paths.directoriesFile, [{ id: 'd1', name: 'Cron project', path: project, baseBranch: 'main' }], { kind: 'directories', schemaVersion: 1 });
// The cron store and the task board are plain JSON owned by their runtimes —
// only sessions/directories use the state envelope.
fs.writeFileSync(paths.taskBoardFile, JSON.stringify(board, null, 2));
fs.writeFileSync(paths.scheduledTasksFile, JSON.stringify([RULE], null, 2));
const preload = path.join(root, 'home.cjs');
fs.writeFileSync(preload, 'require("node:os").homedir=()=>' + JSON.stringify(home) + ';');
const report = path.join(path.resolve(__dirname, '..'), 'logs', 'cron-fanout-cleanup.log');
// A report left by another instance would make this test lie about "once".
try { fs.unlinkSync(report); } catch (_) { /* absent */ }

let server, base, logs = '';
const boardNow = () => JSON.parse(fs.readFileSync(paths.taskBoardFile, 'utf8'));
const markerFile = paths.cronFanoutMigrationFile;
async function wait(fn, label) {
  for (let i = 0; i < 400; i++) {
    if (server.exitCode !== null) throw new Error('server exited early: ' + logs.slice(-2000));
    const value = await fn(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(label + ' (last board revision: ' + boardNow()?.revision + ')');
}
async function boot(port) {
  const missing = path.join(root, 'missing'), commands = {};
  for (const name of ['CLAUDE_CMD', 'OPENCODE_CMD', 'ZCODE_CMD', 'ZCODE_ENGINE', 'QODER_CMD', 'QODERCN_CMD',
    'KIMI_CMD', 'CODEBUDDY_CMD', 'WORKBUDDY_CMD', 'DSH_CMD', 'CODEX_CMD']) commands[name] = missing;
  server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, ...commands,
    NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', ACCESS_TOKEN: 'isolated-only',
    NODE_OPTIONS: '--require ' + preload, MULTICC_DATA_DIR: data, MULTICC_MEMORY_ROOT: path.join(data, 'memories'),
    MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '100' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => { logs = (logs + b).slice(-30000); });
  server.stderr.on('data', b => { logs = (logs + b).slice(-30000); });
  await wait(async () => { try { return (await fetch(base + '/readyz')).ok; } catch (_) { return false; } }, 'readiness');
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM');
  const timer = setTimeout(() => server.kill('SIGKILL'), 10000);
  await exited; clearTimeout(timer);
}
(async () => {
  try {
    const net = require('node:net'), listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    base = `http://127.0.0.1:${port}`;

    await boot(port);
    const summary = await wait(() => { try { return JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch (_) { return null; } },
      'the cleanup marker was never written');
    assert.equal(summary.applied, true);
    assert.equal(summary.migration, 'cron-fanout-cleanup');
    assert.equal(summary.fromVersion, '2.0.2');
    assert.equal(summary.status, 'archived');
    assert.deepEqual((summary.archived || []).sort(), ['tsk_residue_a', 'tsk_residue_b']);

    const after = boardNow().tasks;
    assert.equal(after.tsk_residue_a.status, 'archived');
    assert.equal(after.tsk_residue_a.archivedFromStatus, 'active');
    assert.equal(after.tsk_residue_b.status, 'archived');
    assert.equal(after.tsk_fixed.status, 'active', 'the rule keeps its fixed Air task');
    assert.equal(after.tsk_real.status, 'active', 'a conversation-bound task is untouched');
    assert.equal(after.tsk_residue_archived.status, 'archived');
    assert.match(fs.readFileSync(report, 'utf8'), /archived 2 stale scheduled-task copy\/copies from 1 rule\(s\)/);

    const appliedAt = summary.appliedAt;
    await stop();
    logs = '';
    await boot(port);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(JSON.parse(fs.readFileSync(markerFile, 'utf8')).appliedAt, appliedAt,
      'the second boot must not run the pass again');
    assert.equal(boardNow().tasks.tsk_residue_a.status, 'archived');
    assert.equal(boardNow().tasks.tsk_fixed.status, 'active');
    assert.match(fs.readFileSync(report, 'utf8'), /already applied .*nothing to do/,
      'the second boot reports nothing to do rather than appending another pass');
    console.log('PASS cron fan-out upgrade: residue archived once on the first boot over 2.0.2 data, fixed/real tasks untouched, second boot a no-op');
  } catch (error) { console.error(error); console.error(logs); process.exitCode = 1; }
  finally {
    await stop();
    try { fs.unlinkSync(report); } catch (_) { /* absent */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
