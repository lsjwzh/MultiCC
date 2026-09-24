'use strict';
// Production host with temporary state, repositories and fake Codex. No live CLI.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createPaths, assertTestDir } = require('../src/paths');
const { writeJsonAtomic, readJson } = require('../src/state/store');
const accessToken = process.argv.includes('--no-token') ? '' : 'isolated-only';
const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-task-first-isolated-')));
const data = path.join(root, 'data'), home = path.join(root, 'home'), project = path.join(root, 'project');
for (const dir of [data, home, project]) fs.mkdirSync(dir);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(project, 'init', '-b', 'main'); fs.writeFileSync(path.join(project, 'README.md'), 'isolated task project');
git(project, 'add', '.'); git(project, '-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-m', 'initial');
const worktree = path.join(project, '.multicc-worktrees', 'legacy'); git(project, 'worktree', 'add', '-b', 'multicc/legacy', worktree);
fs.writeFileSync(path.join(worktree, 'dirty.txt'), 'KEEP UNMERGED');
const paths = createPaths({ dataDir: data });
writeJsonAtomic(paths.directoriesFile, [{ id: 'd1', name: 'Task test', path: project, baseBranch: 'main' }], { kind: 'directories', schemaVersion: 1 });
writeJsonAtomic(paths.sessionsFile, [{ id: 'legacy', dirId: 'd1', kind: 'chat', cli: 'codex', label: 'Legacy design',
  rolePrompt: 'LEGACY_ROLE', worktreePath: worktree, branch: 'multicc/legacy', autoCommit: false }], { kind: 'sessions', schemaVersion: 1 });
const fake = path.join(root, 'codex'), invocations = path.join(root, 'runs.jsonl'), preload = path.join(root, 'home.cjs');
fs.writeFileSync(preload, 'require("node:os").homedir=()=>'+JSON.stringify(home)+';');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('fs'),p=require('path');const args=process.argv.slice(2);if(args[0]!=='exec')process.exit(0);
const id='fake-'+process.env.MULTICC_SESSION_ID, dir=p.join(process.env.CODEX_HOME||p.join(require('os').homedir(),'.codex'),'sessions');
fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(p.join(dir,'rollout-'+id+'.jsonl'),JSON.stringify({type:'session_meta',payload:{id,cwd:process.cwd()}})+'\\n');
fs.appendFileSync(${JSON.stringify(invocations)},JSON.stringify({sid:process.env.MULTICC_SESSION_ID,cwd:process.cwd(),prompt:args.at(-1)})+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:id}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'TASK_FIRST_DONE'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5,output_tokens:3}}));
`, { mode: 0o755 });
const rows = () => fs.existsSync(invocations) ? fs.readFileSync(invocations, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const persisted = () => readJson(paths.sessionsFile, { legacyIsArray: true }).data;
let server, base, logs = '';
async function wait(fn, label) {
  for (let i = 0; i < 300; i++) { if (server.exitCode !== null) throw new Error('server exited'); const r = await fn(); if (r) return r; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(label);
}
async function api(route, body, status = 200, method) {
  const response = await fetch(base + route, { method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); assert.equal(response.status, status, route + ': ' + text); return JSON.parse(text);
}
(async () => {
  try {
    const net = require('node:net'), listener = net.createServer();
    await new Promise(r => listener.listen(0, '127.0.0.1', r)); const port = listener.address().port;
    await new Promise(r => listener.close(r)); base = `http://127.0.0.1:${port}`;
    const missing = path.join(root, 'missing'), commands = {};
    for (const name of ['CLAUDE_CMD','OPENCODE_CMD','ZCODE_CMD','ZCODE_ENGINE','QODER_CMD','QODERCN_CMD','KIMI_CMD','CODEBUDDY_CMD','WORKBUDDY_CMD','DSH_CMD']) commands[name] = missing;
    server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, ...commands,
      NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', ACCESS_TOKEN: accessToken,
      NODE_OPTIONS: '--require ' + preload, MULTICC_DATA_DIR: data, MULTICC_MEMORY_ROOT: path.join(data, 'memories'), CODEX_CMD: fake,
      MULTICC_CODEX_ROLLOUT_ARCHIVE_TTL_DAYS: '0', MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '100' }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', b => { logs = (logs + b).slice(-30000); }); server.stderr.on('data', b => { logs = (logs + b).slice(-30000); });
    await wait(async () => { try { return (await fetch(base + '/readyz')).ok; } catch (_) { return false; } }, 'readiness');
    assert.equal((await api('/api/settings/access-token')).hasToken, !!accessToken);
    const air = await api('/api/air'); assert.equal(air.migration.ok, true); assert.equal(air.sessions.length, 0);
    const old = air.tasks.find(t => t.sessionId === 'legacy'); assert.ok(old); assert.equal(old.readOnly, false);
    assert.equal(fs.readFileSync(path.join(worktree, 'dirty.txt'), 'utf8'), 'KEEP UNMERGED');
    assert.equal(persisted().find(s => s.id === 'legacy').worktreePath, worktree);
    const resolved = await api('/api/air/resolve?session=legacy'); assert.equal(resolved.taskId, old.id);
    assert.equal((await api('/api/sessions')).some(s => s.id === 'legacy'), false);
    const d = await api('/api/directories', { name: 'Empty directory', path: path.join(root, 'new-project'), create: true });
    assert.equal(persisted().filter(s => s.dirId === d.id).length, 0, 'no commander or role sessions');
    await api(`/api/directories/${d.id}/role-workers/agent-commander`, {}, 410, 'PUT');
    const planned = await api('/api/task-board/tasks', { dirId: 'd1', title: 'Planned board item' });
    const plannedId = planned.task?.id || planned.id; assert.ok(plannedId);
    const plannedEntry = await api('/api/air/tasks/' + plannedId);
    assert.equal(plannedEntry.configuration.cli, 'codex', 'planned task selects an available runtime');
    assert.equal(plannedEntry.resource.residency, 'planned');
    const input = { dirId: 'd1', title: 'Independent task', cli: 'codex', clientMsgId: 'new-task' };
    const task = await api('/api/air/tasks', input); assert.deepEqual(await api('/api/air/tasks', input), task);
    let record = persisted().find(s => s.id === task.sessionId); assert.equal(record.workspaceState, 'planned');
    assert.equal(record.taskBoundTaskId, task.taskId, 'REST creation binds the canonical task identity');
    assert.equal(fs.existsSync(record.worktreePath), false); assert.equal(rows().length, 0);
    const config = await api('/api/air/tasks/' + task.taskId);
    const beforeCount = persisted().length;
    await api(`/api/air/tasks/${task.taskId}/roles`, { bindings: [{ name: 'Reviewer', prompt: 'DYNAMIC_ROLE_ONE' }], expectedVersion: config.roleBindings.version, clientMsgId: 'role1' });
    assert.equal(persisted().length, beforeCount); assert.equal(fs.existsSync(record.worktreePath), false);
    await api(`/api/task-shell-tasks/${task.taskId}/messages`, { text: 'Review the project', clientMsgId: 'm1', intent: 'work' });
    await wait(() => rows().find(r => r.sid === task.sessionId), 'first execution');
    await wait(async () => !(await api('/api/air/tasks/' + task.taskId)).execution.busy, 'first completion');
    record = persisted().find(s => s.id === task.sessionId);
    assert.equal(fs.realpathSync(rows()[0].cwd), fs.realpathSync(record.worktreePath)); assert.notEqual(record.worktreePath, worktree);
    assert.match(rows()[0].prompt, /DYNAMIC_ROLE_ONE/);
    const next = await api('/api/air/tasks/' + task.taskId);
    await api(`/api/air/tasks/${task.taskId}/roles`, { bindings: [{ name: 'Builder', prompt: 'DYNAMIC_ROLE_TWO' }], expectedVersion: next.roleBindings.version, clientMsgId: 'role2' });
    await api(`/api/task-shell-tasks/${task.taskId}/messages`, { text: 'Continue', clientMsgId: 'm2', intent: 'work' });
    await wait(() => rows().length === 2, 'second execution');
    await wait(async () => !(await api('/api/air/tasks/' + task.taskId)).execution.busy, 'second completion');
    assert.match(rows()[1].prompt, /DYNAMIC_ROLE_TWO/); assert.doesNotMatch(rows()[1].prompt, /DYNAMIC_ROLE_ONE/);
    assert.equal(rows()[1].cwd, rows()[0].cwd); assert.equal(persisted().length, beforeCount);
    assert.equal(fs.readFileSync(path.join(worktree, 'dirty.txt'), 'utf8'), 'KEEP UNMERGED');
    console.log(`PASS task-only host (local without credentials, configured token=${!!accessToken}): canonical REST creation, idempotency, first execution, continuation and retained workspace`);
  } catch (error) { console.error(error); console.error(logs); process.exitCode = 1; }
  finally {
    if (server && server.exitCode === null) { const exited = new Promise(r => server.once('exit', r)); server.kill('SIGTERM'); const timer = setTimeout(() => server.kill('SIGKILL'), 10000); await exited; clearTimeout(timer); }
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
