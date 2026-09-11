'use strict';
// Production host with temporary state, repositories and fake Codex. No live CLI.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createPaths, assertTestDir } = require('../src/paths');
const { writeJsonAtomic, readJson } = require('../src/state/store');
const root = assertTestDir(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-pending-config-isolated-')));
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
const release = path.join(root, 'release');
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('fs'),p=require('path');const args=process.argv.slice(2);if(!['exec','run'].includes(args[0]))process.exit(0);
const count=fs.existsSync(${JSON.stringify(invocations)})?fs.readFileSync(${JSON.stringify(invocations)},'utf8').trim().split('\\n').length+1:1;
const id='fake-'+process.env.MULTICC_SESSION_ID, dir=p.join(process.env.CODEX_HOME||p.join(require('os').homedir(),'.codex'),'sessions');
if(args[0]==='exec'){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(p.join(dir,'rollout-'+id+'.jsonl'),JSON.stringify({type:'session_meta',payload:{id,cwd:process.cwd()}})+'\\n');}
fs.appendFileSync(${JSON.stringify(invocations)},JSON.stringify({args,cli:args[0],pid:process.pid,sid:process.env.MULTICC_SESSION_ID})+'\\n');
const emit=x=>console.log(JSON.stringify(x));emit(args[0]==='exec'?{type:'thread.started',thread_id:id}:{type:'step_start',sessionID:'open-native'});
const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}+count))return;clearInterval(timer);
const text='FINAL_RESULT_'+count;
if(args[0]==='exec'){emit({type:'item.completed',item:{type:'agent_message',text}});emit({type:'turn.completed',usage:{input_tokens:5,output_tokens:3}});}
else{emit({type:'text',part:{text}});emit({type:'step_finish',part:{reason:'stop',tokens:{}}});}
},25);
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
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer isolated-only' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
      NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', ACCESS_TOKEN: 'isolated-only',
      NODE_OPTIONS: '--require ' + preload, MULTICC_DATA_DIR: data, MULTICC_MEMORY_ROOT: path.join(data, 'memories'), CODEX_CMD: fake, OPENCODE_CMD: fake,
      MULTICC_CODEX_ROLLOUT_ARCHIVE_TTL_DAYS: '0', MULTICC_ORCHESTRATION_WORKER_INTERVAL_MS: '100' }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', b => { logs = (logs + b).slice(-30000); }); server.stderr.on('data', b => { logs = (logs + b).slice(-30000); });
    await wait(async () => { try { return (await fetch(base + '/readyz')).ok; } catch (_) { return false; } }, 'readiness');
    await api('/api/air');
    const task = await api('/api/air/tasks', { dirId: 'd1', title: 'Deferred configuration', cli: 'codex', model: 'old-model', clientMsgId: 'task-config' });
    const sessionUrl = `/api/sessions/${task.sessionId}`;
    const send = (text, clientMsgId) => api(`/api/task-shell-tasks/${task.taskId}/messages`, { text, clientMsgId, intent: 'work' });
    const idle = () => wait(async () => !(await api('/api/air/tasks/' + task.taskId)).execution.busy, 'turn completion');
    await send('FIRST', 'm1');
    await wait(() => rows().length === 1, 'first execution');
    const pid = rows()[0].pid;
    const edited = await api(sessionUrl, { provider: '', model: 'next-model', effort: 'high' }, 200, 'PATCH');
    assert.equal(edited.deferred, true);
    const info = await api(sessionUrl);
    assert.equal(info.model, 'old-model'); assert.equal(info.pendingConfiguration.profile.model, 'next-model');
    assert.equal(persisted().find(s => s.id === task.sessionId).pendingConfiguration.profile.model, 'next-model');
    process.kill(pid, 0);
    await send('SECOND', 'm2');
    assert.equal(rows().length, 1, 'queued message does not interrupt current process');
    fs.writeFileSync(release+'1', 'done');
    await wait(() => rows().length === 2, 'queued second execution');
    assert.match(JSON.stringify(rows()[1].args), /next-model/);
    assert.equal((await api(sessionUrl)).pendingConfiguration, null);
    const switched = await api(sessionUrl+'/switch-cli', { cli: 'opencode', force: true });
    assert.equal(switched.deferred, true); assert.equal(switched.cli, 'codex');
    await api(sessionUrl, { provider: '', model: 'opencodego/new-model', effort: 'high' }, 200, 'PATCH');
    assert.equal((await api(sessionUrl)).pendingConfiguration.cli, 'opencode');
    process.kill(rows()[1].pid, 0);
    fs.writeFileSync(release+'2', 'done'); await idle();
    await send('THIRD', 'm3');
    await wait(() => rows().length === 3, 'new CLI execution');
    assert.equal(rows()[2].cli, 'run');
    assert.match(JSON.stringify(rows()[2].args), /opencodego\/new-model/);
    assert.match(JSON.stringify(rows()[2].args), /FINAL_RESULT_2/);
    assert.equal((await api(sessionUrl)).cli, 'opencode');
    fs.writeFileSync(release+'3', 'done'); await idle();
    assert.equal(rows().length, 3);
    console.log('PASS deferred configuration: durable save, untouched active process, queued next model, deferred CLI, final-output handoff, third turn');
  } catch (error) { console.error(error); console.error(logs); process.exitCode = 1; }
  finally {
    if (server && server.exitCode === null) { const exited = new Promise(r => server.once('exit', r)); server.kill('SIGTERM'); const timer = setTimeout(() => server.kill('SIGKILL'), 10000); await exited; clearTimeout(timer); }
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
