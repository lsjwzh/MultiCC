'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');
const planning = require('../src/task-board/planning');
const { createTaskRunStore } = require('../src/task-run/store');
const { mkRuntime } = require('./helpers/task-board-runtime');
const migration = require('../plugins/cron/fanout-migration');

const PROMPT = '检查 Mafit 全链路健康，以 curl -s http://127.0.0.1:8770/api/health 的 ok / mafit_service 为准；健康项跳过，不无谓重启。';

function rule(overrides = {}) {
  return { id: 'cron_health', name: 'Mafit 全链路健康检查', dirId: 'dir-1', prompt: PROMPT,
    enabled: true, taskId: 'tsk_fixed', ...overrides };
}
// The shape the old classifier wrote for every firing: title = the prompt cut to
// the 40-char board title limit, no conversation binding of its own.
function residue(overrides = {}) {
  return { id: 'tsk_residue', title: PROMPT.slice(0, 40), status: 'active', origin: 'session',
    recordType: 'observed', refs: [], moduleId: 'mod-1',
    moduleAssignment: { running: false, attempts: 0, lastAttemptAt: 0, lastError: 'missing_context' }, ...overrides };
}
function fixedTask(overrides = {}) {
  return { id: 'tsk_fixed', title: 'Mafit 全链路健康检查', status: 'active', origin: 'session',
    recordType: 'observed', refs: [{ sessionId: 'mafit-claude-chat-29' }], chatSessionId: 'mafit-claude-chat-29',
    ownerShellId: 'sh_1', moduleId: 'mod-1', ...overrides };
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cron-fanout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('version evidence: only data from releases <= 2.0.2 is affected, unknown stays null', () => {
  assert.equal(migration.mayContainResidue('2.0.2'), true);
  assert.equal(migration.mayContainResidue('v2.0.1'), true);
  assert.equal(migration.mayContainResidue('1.9.9'), true);
  assert.equal(migration.mayContainResidue('2.0.3'), false);
  assert.equal(migration.mayContainResidue('2.1.0'), false);
  assert.equal(migration.mayContainResidue(null), null);
  assert.equal(migration.mayContainResidue('dev'), null);
});

test('upgrade marker is read from the checkout and falls back to the installer channel file', t => {
  const root = tempRoot(t);
  assert.deepEqual(migration.readUpgradeEvidence(root), { fromVersion: null, source: 'unknown' });
  fs.writeFileSync(path.join(root, '.multicc_channel'),
    '# channel: stable\n# installed: 2.0.2\n');
  assert.deepEqual(migration.readUpgradeEvidence(root), { fromVersion: '2.0.2', source: '.multicc_channel' });
  fs.writeFileSync(path.join(root, '.multicc_upgrade'), '2.0.0\n');
  assert.deepEqual(migration.readUpgradeEvidence(root), { fromVersion: '2.0.0', source: '.multicc_upgrade' });
  // An install with a custom data root keeps its own copy next to its state.
  const data = path.join(root, 'state'); fs.mkdirSync(data);
  assert.deepEqual(migration.readUpgradeEvidence(root, data),
    { fromVersion: '2.0.0', source: '.multicc_upgrade' });
  fs.writeFileSync(path.join(data, '.multicc_upgrade'), '2.0.1\n');
  assert.deepEqual(migration.readUpgradeEvidence(path.join(root, 'missing-checkout'), data),
    { fromVersion: '2.0.1', source: '.multicc_upgrade' });
});

test('residue detection keeps cron fan-out copies and never a real task', () => {
  const rules = [rule(), rule({ id: 'cron_other', name: '别的任务', taskId: 'tsk_other', prompt: '执行别的任务：先读 README' })];
  const tasks = [
    residue({ id: 'tsk_residue_a' }),
    residue({ id: 'tsk_residue_by_name', title: 'Mafit 全链路健康检查' }),
    fixedTask({ id: 'tsk_fixed' }),                                                   // bound to a rule
    fixedTask({ id: 'tsk_other', title: '别的任务', chatSessionId: null, refs: [] }), // another rule's bound task
    residue({ id: 'tsk_chat', chatSessionId: 'marketing-claude-chat-1' }),            // bound to a conversation
    residue({ id: 'tsk_shell', ownerShellId: 'sh_2' }),                               // owned by a live shell
    residue({ id: 'tsk_routed', routing: { mode: 'commander' } }),                    // dispatched, not attributed
    residue({ id: 'tsk_done', origin: 'board', recordType: 'planned' }),
    residue({ id: 'tsk_archived', status: 'archived' }),
    residue({ id: 'tsk_short', title: '检查 Mafit' }),                                // too short to be evidence
    residue({ id: 'tsk_unrelated', title: '升级 Node 依赖' }),
  ];
  const { archive, overflow } = migration.collectResidue(tasks, rules);
  assert.equal(overflow, false);
  assert.deepEqual(archive.map(entry => entry.taskId).sort(), ['tsk_residue_a', 'tsk_residue_by_name']);
  assert.deepEqual(archive.map(entry => entry.matched).sort(), ['name', 'prompt']);
  assert.equal(archive[0].ruleId, 'cron_health');
});

test('residue detection refuses to act on an implausibly large candidate set', () => {
  const rules = [rule()];
  const limit = migration.MAX_CANDIDATES;
  const tasks = Array.from({ length: limit + 1 }, (_, i) => residue({ id: `tsk_${i}` }));
  assert.equal(migration.collectResidue(tasks.slice(0, limit), rules).overflow, false);
  assert.equal(migration.collectResidue(tasks, rules).overflow, true);
});

test('one pass archives the residue, reports it and never runs twice', async t => {
  const root = tempRoot(t);
  const report = path.join(root, 'logs', 'cron-fanout-cleanup.log');
  const marker = path.join(root, 'cron_fanout_migration.json');
  const board = [residue({ id: 'tsk_a' }), residue({ id: 'tsk_b' }), fixedTask({ id: 'tsk_fixed' })];
  const calls = [];
  const archiveTasks = async ids => {
    calls.push(ids);
    for (const id of ids) board.find(task => task.id === id).status = 'archived';
    return { ok: true, archived: ids, skipped: [] };
  };
  const first = await migration.run({ dataDir: root, pkgRoot: root, fromVersion: '2.0.2',
    tasks: board, rules: [rule()], archiveTasks, reportFile: report, markerFile: marker, logger: { log() {}, error() {} } });
  assert.equal(first.status, 'archived');
  assert.equal(first.archivedCount, 2);
  assert.equal(first.ruleCount, 1);
  assert.deepEqual(calls, [['tsk_a', 'tsk_b']]);
  assert.match(fs.readFileSync(report, 'utf8'), /archived 2 stale scheduled-task copy\/copies/);
  const applied = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(applied.applied, true);
  assert.equal(applied.fromVersion, '2.0.2');
  assert.equal(applied.archivedCount, 2);

  const second = await migration.run({ dataDir: root, pkgRoot: root, fromVersion: '2.0.2',
    tasks: board, rules: [rule()], archiveTasks, reportFile: report, markerFile: marker, logger: { log() {}, error() {} } });
  assert.equal(second.status, 'already_applied');
  assert.equal(calls.length, 1);
  assert.match(fs.readFileSync(report, 'utf8'), /already applied .*nothing to do/,
    'a later boot reports that there is nothing to do instead of re-archiving');
});

test('an install that never saw an affected release is marked and skipped', async t => {
  const root = tempRoot(t);
  let calls = 0;
  const summary = await migration.run({ dataDir: root, pkgRoot: root, fromVersion: '2.0.3',
    tasks: [residue({ id: 'tsk_a' })], rules: [rule()],
    archiveTasks: async ids => { calls++; return { ok: true, archived: ids, skipped: [] }; },
    logger: { log() {}, error() {} } });
  assert.equal(summary.status, 'version_not_affected');
  assert.equal(calls, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'cron_fanout_migration.json'), 'utf8')).applied, true);
  assert.equal(fs.existsSync(path.join(root, 'logs', 'cron-fanout-cleanup.log')), false,
    'an unaffected install reports nothing — the update path never waits for it');
});

test('an unknown version still scans, and a clean board is a no-op', async t => {
  const root = tempRoot(t);
  let calls = 0;
  const summary = await migration.run({ dataDir: root, pkgRoot: root, fromVersion: null,
    tasks: [fixedTask({ id: 'tsk_fixed' })], rules: [rule()],
    archiveTasks: async ids => { calls++; return { ok: true, archived: ids, skipped: [] }; },
    logger: { log() {}, error() {} } });
  assert.equal(summary.status, 'no_residue');
  assert.equal(summary.versionEvidence, 'injected');
  assert.equal(calls, 0);
  assert.match(fs.readFileSync(path.join(root, 'logs', 'cron-fanout-cleanup.log'), 'utf8'),
    /archived 0 stale scheduled-task copy\/copies/);
});

test('a task that cannot be archived is reported and never retried forever', async t => {
  const root = tempRoot(t);
  const report = path.join(root, 'logs', 'cron-fanout-cleanup.log');
  const summary = await migration.run({ dataDir: root, pkgRoot: root, fromVersion: '2.0.2',
    tasks: [residue({ id: 'tsk_a' }), residue({ id: 'tsk_b' })], rules: [rule()],
    archiveTasks: async () => ({ ok: true, archived: ['tsk_a'], skipped: [{ taskId: 'tsk_b', error: 'task_busy_or_missing' }] }),
    reportFile: report, logger: { log() {}, error() {} } });
  assert.equal(summary.status, 'archived');
  assert.deepEqual(summary.archived, ['tsk_a']);
  assert.deepEqual(summary.failures, [{ taskId: 'tsk_b', error: 'task_busy_or_missing' }]);
  assert.match(fs.readFileSync(report, 'utf8'), /1 skipped/);
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'cron_fanout_migration.json'), 'utf8'));
  assert.equal(marker.applied, true);
  assert.deepEqual(marker.failures, [{ taskId: 'tsk_b', error: 'task_busy_or_missing' }]);
});

test('a missing archive port leaves the migration unapplied so the next boot retries', async t => {
  const root = tempRoot(t);
  const summary = await migration.run({ dataDir: root, pkgRoot: root, fromVersion: '2.0.2',
    tasks: [residue({ id: 'tsk_a' })], rules: [rule()], logger: { log() {}, error() {} } });
  assert.equal(summary.ok, true);
  assert.equal(summary.status, 'archive_unavailable');
  assert.equal(fs.existsSync(path.join(root, 'cron_fanout_migration.json')), false,
    'no applied marker: the next start retries');
  assert.match(fs.readFileSync(path.join(root, 'logs', 'cron-fanout-cleanup.log'), 'utf8'),
    /archive port unavailable/);
});

test('the cron runtime runs the cleanup once after boot and archives through the board', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cron-fanout-wire-'));
  const previous = process.env.MULTICC_DATA_DIR;
  process.env.MULTICC_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const tasks = { tsk_fixed: fixedTask({ id: 'tsk_fixed' }), tsk_residue: residue({ id: 'tsk_residue' }) };
  fs.writeFileSync(path.join(root, 'scheduled_tasks.json'), JSON.stringify([rule()]));
  const modulePath = require.resolve('../plugins/cron/cron-tasks');
  delete require.cache[modulePath];
  const cron = require(modulePath);
  const archived = [];
  cron.init({
    directories: new Map([['dir-1', { id: 'dir-1', name: '项目一', path: root }]]),
    clis: ['claude'],
    ready: Promise.resolve(),
    fromVersion: '2.0.2',
    getTask: async id => ({ ok: true, task: { id, title: id }, sessionId: `task-${id}`, readOnly: false }),
    createTask: async () => ({ ok: true, taskId: 'tsk_created', sessionId: 'task-tsk_created' }),
    sendTaskMessage: async () => ({ ok: true, receiptId: 'r1', decision: 'continue' }),
    taskBoard: () => ({
      getBoard: () => ({ tasks }),
      archiveTasks: async ids => {
        archived.push(...ids);
        for (const id of ids) tasks[id].status = 'archived';
        return { ok: true, archived: ids, skipped: [] };
      },
    }),
  });
  t.after(() => cron.stop());

  const summary = await cron._runFanoutCleanup();
  assert.equal(summary.status, 'archived');
  assert.deepEqual(archived, ['tsk_residue']);
  assert.equal(tasks.tsk_fixed.status, 'active');
  assert.equal(tasks.tsk_residue.status, 'archived');
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'cron_fanout_migration.json'), 'utf8'));
  assert.equal(marker.archivedCount, 1);
  assert.equal(await cron._runFanoutCleanup(), summary, 'the pass is memoized per process');
});

test('the board batch-archive port writes once, skips open runs and never deletes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cron-fanout-board-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'board.json');
  const boardTask = (id, extra = {}) => ({ id, title: id, status: 'active', origin: 'session',
    recordType: 'observed', refs: [], createdAt: 1, updatedAt: 1, ...extra });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: planning.TASK_BOARD_SCHEMA_VERSION, revision: 1, modules: {}, taskGroups: {},
    deletedTaskIds: [],
    tasks: {
      'tsk-idle': boardTask('tsk-idle'),
      'tsk-done': boardTask('tsk-done', { status: 'done' }),
      'tsk-running': boardTask('tsk-running'),
    },
  }));
  const taskRuns = createTaskRunStore({ file: path.join(dir, 'runs.sqlite'), Database });
  t.after(() => taskRuns.close());
  const { runtime } = mkRuntime({ file, taskRuns });
  taskRuns.beginRun({ runId: 'run-open', taskId: 'tsk-running', attemptId: 'attempt-1', startedAt: 1, metadata: {} });

  const result = await runtime.archiveTasks(['tsk-idle', 'tsk-done', 'tsk-running', 'tsk-missing']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.archived.sort(), ['tsk-done', 'tsk-idle']);
  assert.deepEqual(result.skipped.map(entry => entry.taskId).sort(), ['tsk-missing', 'tsk-running']);
  assert.deepEqual(runtime.getBoard().deletedTaskIds || [], [], 'archiving is never a delete');
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8')).tasks;
  assert.equal(persisted['tsk-idle'].status, 'archived');
  assert.equal(persisted['tsk-idle'].archivedFromStatus, 'active');
  assert.equal(persisted['tsk-done'].archivedFromStatus, 'done');
  assert.equal(persisted['tsk-running'].status, 'active', 'a task with an open run stays on the board');
  assert.deepEqual(await runtime.archiveTasks(['tsk-idle']),
    { ok: true, archived: [], skipped: [{ taskId: 'tsk-idle', error: 'task_busy_or_missing' }] });
});
