'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { processTable, isServer, sameProcess, descendants, protectedAncestors, stopServers } = require('../src/server-processes');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check) {
  for (let i = 0; i < 80; i++) { if (await check()) return; await sleep(100); }
  throw new Error('fixture timeout');
}

test('process identity handles relative launch and rejects unrelated commands and PID reuse', () => {
  const config = { rootDir: '/srv/a b', entry: '/srv/a b/server.js', execPath: process.execPath };
  const record = command => ({ pid: 123, ppid: 1, born: 'old', command });
  assert.equal(isServer(record(`${process.execPath} server.js`), config, () => config.rootDir), true);
  assert.equal(isServer(record(`${process.execPath} server.js`), config, () => '/srv/other'), false);
  assert.equal(isServer(record(`${process.execPath} /srv/a b/server.js`), config), true);
  assert.equal(isServer(record(`${process.execPath} unrelated.js /srv/a b/server.js`), config), false);
  assert.equal(isServer(record(`${process.execPath} --eval /srv/a b/server.js`), config), false);
  assert.equal(isServer(record(`/bin/sh -c node /srv/a b/server.js`), config), false);
  assert.equal(sameProcess(record('old'), { ...record('old'), born: 'new' }), false);
});

test('stop protects the detached restart launcher chain, but includes ordinary descendants', () => {
  const root = { pid: 800, ppid: 1 };
  const table = [root, { pid: 801, ppid: 800 }, { pid: 802, ppid: 801 },
    { pid: 803, ppid: 800 }, { pid: process.pid, ppid: 802 }];
  const excluded = protectedAncestors(table, [root]);
  assert.deepEqual([...descendants(table, [root], excluded).keys()], [800, 803]);
});

test('real cleanup reaps relative/absolute duplicate servers and children, ignores stale PID file', {
  skip: !['darwin', 'linux'].includes(process.platform), timeout: 15000,
}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-process-cleanup-')));
  const other = path.join(root, 'other'); fs.mkdirSync(other);
  const entry = path.join(root, 'server.js');
  fs.writeFileSync(entry, `const fs=require('fs');const cp=require('child_process');
    process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});
    const child=cp.spawn(process.execPath,['-e',"process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
    fs.writeFileSync('ready-'+process.pid, String(child.pid));setInterval(()=>{},1000);`);
  fs.copyFileSync(entry, path.join(other, 'server.js'));
  const children = [], descendantsToReap = [];
  t.after(async () => {
    for (const pid of [...children.map(p => p.pid), ...descendantsToReap]) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await new Promise(r => child.once('exit', r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const [cwd, arg] of [[root, 'server.js'], [root, entry], [other, 'server.js']]) {
    const child = spawn(process.execPath, [arg], { cwd, stdio: 'ignore' }); children.push(child);
    await wait(() => fs.existsSync(path.join(cwd, 'ready-' + child.pid)));
    descendantsToReap.push(Number(fs.readFileSync(path.join(cwd, 'ready-' + child.pid), 'utf8')));
  }
  fs.writeFileSync(path.join(root, '.multicc.pid'), String(children[2].pid));
  const config = { rootDir: root, entry, execPath: process.execPath };
  assert.equal(processTable().filter(p => isServer(p, config)).length, 2);
  await stopServers(config, { graceMs: 400, log() {} });
  const after = processTable();
  assert.equal(after.filter(p => isServer(p, config)).length, 0);
  assert.equal(after.some(p => p.pid === children[2].pid), true, 'unrelated same-named server survives');
  assert.equal(after.some(p => p.pid === descendantsToReap[2]), true);
  assert.equal(after.some(p => p.pid === descendantsToReap[0] && !/defunct/.test(p.command)), false);
  assert.equal(after.some(p => p.pid === descendantsToReap[1] && !/defunct/.test(p.command)), false);
});

test('generated script survives its launcher exit and completes the real multicc restart command', {
  skip: !['darwin', 'linux'].includes(process.platform), timeout: 20000,
}, async t => {
  const { writeRestartScript } = require('../src/server-restart');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-manual-restart-')));
  fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(__dirname, '..', 'multicc'), path.join(root, 'multicc'));
  fs.chmodSync(path.join(root, 'multicc'), 0o700);
  fs.copyFileSync(path.join(__dirname, '..', 'src', 'server-processes.js'), path.join(root, 'src', 'server-processes.js'));
  fs.writeFileSync(path.join(root, 'scripts', 'check-runtime-deps.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(root, 'server.js'), `require('fs').appendFileSync('starts', process.pid+'\\n');
    process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000);`);
  const original = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore' });
  let replacementPid, launcher, helperPids = [];
  const config = { rootDir: root, entry: path.join(root, 'server.js'), execPath: process.execPath };
  t.after(async () => {
    for (const p of processTable().filter(p => isServer(p, config))) { try { process.kill(p.pid, 'SIGKILL'); } catch (_) {} }
    for (const helperPid of helperPids) { try { process.kill(helperPid, 'SIGKILL'); } catch (_) {} }
    if (original.exitCode === null && original.signalCode === null) await new Promise(r => original.once('exit', r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await wait(() => fs.existsSync(path.join(root, 'starts')));
  const { scriptPath, logPath } = writeRestartScript(root);
  const staleLock = path.join(root, 'logs', 'restart.lock');
  fs.mkdirSync(staleLock);
  fs.writeFileSync(path.join(staleLock, 'pid'), String(process.pid));
  fs.writeFileSync(path.join(staleLock, 'owner.json'), JSON.stringify({ pid: process.pid, born: 'old PID incarnation', command: 'old manager' }));
  const output = fs.openSync(logPath, 'a');
  const launcherSource = `const cp=require('child_process');for(let i=0;i<2;i++){const c=cp.spawn('/bin/sh',[process.argv[1]],{detached:true,stdio:['ignore',3,3],env:{...process.env,MULTICC_NODE:process.execPath}});console.log(c.pid);c.unref();}`;
  launcher = spawn(process.execPath, ['-e', launcherSource, scriptPath], { cwd: root,
    stdio: ['ignore', 'pipe', 'inherit', output] });
  fs.closeSync(output);
  let stdout = ''; launcher.stdout.on('data', chunk => { stdout += chunk; });
  await new Promise(resolve => launcher.once('exit', resolve));
  assert.equal(launcher.exitCode, 0);
  helperPids = stdout.trim().split('\n').map(Number); assert.equal(helperPids.length, 2);
  assert.ok(helperPids.every(pid => pid > 1));
  await wait(() => fs.existsSync(path.join(root, '.multicc.pid')));
  replacementPid = Number(fs.readFileSync(path.join(root, '.multicc.pid'), 'utf8'));
  assert.notEqual(replacementPid, original.pid);
  await wait(() => !fs.existsSync(path.join(root, 'logs', 'restart.lock')));
  await wait(() => !processTable().some(p => helperPids.includes(p.pid) && !/defunct/.test(p.command)));
  helperPids = [];
  assert.equal(processTable().filter(p => isServer(p, config)).length, 1);
  assert.match(fs.readFileSync(logPath, 'utf8'), /MultiCC started/);
  assert.equal(fs.readFileSync(path.join(root, 'starts'), 'utf8').trim().split('\n').length, 2);
});
