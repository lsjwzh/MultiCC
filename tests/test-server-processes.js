'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { processTable, isServer, isGatewayRoot, sameProcess, descendants, protectedAncestors, stopServers } = require('../src/server-processes');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check, { timeoutMs = 8000, diagnostics = () => '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await sleep(100); }
  throw new Error(`fixture timeout: ${diagnostics()}`);
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
  skip: !['darwin', 'linux'].includes(process.platform), timeout: 60000,
}, async t => {
  const { writeRestartScript } = require('../src/server-restart');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-manual-restart-')));
  fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(__dirname, '..', 'multicc'), path.join(root, 'multicc'));
  fs.chmodSync(path.join(root, 'multicc'), 0o700);
  fs.copyFileSync(path.join(__dirname, '..', 'src', 'server-processes.js'), path.join(root, 'src', 'server-processes.js'));
  fs.writeFileSync(path.join(root, 'scripts', 'check-runtime-deps.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(root, 'scripts', 'ensure-source-rust.js'), 'process.exit(0);');
  // 只管理临时服务器：禁止调用宿主的 launchd/pm2，也不探测宿主的 3000 端口。
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  for (const name of ['launchctl', 'pm2']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  }
  fs.writeFileSync(path.join(root, 'server.js'), `require('fs').appendFileSync('starts', process.pid+'\\n');
    process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000);`);
  // ./multicc only starts through the front door. This stand-in turns into the
  // `node server.js` it was asked to run (argv: serve --cwd <root> --node <node> server.js).
  fs.mkdirSync(path.join(root, 'runtime'));
  fs.writeFileSync(path.join(root, 'runtime', 'multicc-gateway'), '#!/bin/sh\ncd "$3" && exec "$5" "$6"\n', { mode: 0o700 });
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
    stdio: ['ignore', 'pipe', 'inherit', output],
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PORT: '0',
      MULTICC_RUST_ADDON: path.join(root, 'runtime', 'multicc_core.node') } });
  fs.closeSync(output);
  let stdout = ''; launcher.stdout.on('data', chunk => { stdout += chunk; });
  await new Promise(resolve => launcher.once('exit', resolve));
  assert.equal(launcher.exitCode, 0);
  helperPids = stdout.trim().split('\n').map(Number); assert.equal(helperPids.length, 2);
  assert.ok(helperPids.every(pid => pid > 1));
  // 真实脚本包含固定延迟、进程扫描和互斥锁处理；8 秒不足以覆盖繁忙主机。
  const restartWait = { timeoutMs: 30000, diagnostics: () => fs.readFileSync(logPath, 'utf8') };
  await wait(() => fs.existsSync(path.join(root, '.multicc.pid')), restartWait);
  replacementPid = Number(fs.readFileSync(path.join(root, '.multicc.pid'), 'utf8'));
  assert.notEqual(replacementPid, original.pid);
  await wait(() => !fs.existsSync(path.join(root, 'logs', 'restart.lock')), restartWait);
  await wait(() => !processTable().some(p => helperPids.includes(p.pid) && !/defunct/.test(p.command)), restartWait);
  helperPids = [];
  assert.equal(processTable().filter(p => isServer(p, config)).length, 1);
  assert.match(fs.readFileSync(logPath, 'utf8'), /MultiCC started/);
  assert.equal(fs.readFileSync(path.join(root, 'starts'), 'utf8').trim().split('\n').length, 2);
});

test('the Rust front door is the root; its node child is not', () => {
  const config = { rootDir: '/srv/a b', entry: '/srv/a b/server.js', execPath: '/opt/node/bin/node' };
  const record = (pid, ppid, command) => ({ pid, ppid, born: 'old', command });
  const gateway = record(400, 1, '/opt/multicc/multicc-gateway serve --cwd /srv/a b --node /opt/node/bin/node server.js');
  const gatewayChild = record(401, 400, '/opt/node/bin/node server.js');
  const direct = record(402, 1, '/opt/node/bin/node server.js');
  const otherGatewayChild = record(403, 900, '/opt/node/bin/node server.js');
  const table = [gateway, gatewayChild, direct, otherGatewayChild];
  const cwd = pid => ({ 400: '/srv/a b', 401: '/srv/a b', 402: '/srv/a b', 403: '/srv/a b' }[pid] || null);

  assert.equal(isGatewayRoot(gateway, config, cwd), true);
  assert.equal(isServer(gateway, config, cwd, table), true);
  // A node server started by that front door is a guarded child, not a root.
  assert.equal(isServer(gatewayChild, config, cwd, table), false);
  // A direct node launch is still a root, even in a mixed deployment.
  assert.equal(isServer(direct, config, cwd, table), true);
  assert.equal(isServer(otherGatewayChild, config, cwd, table), true);
  assert.deepEqual(table.filter(p => isServer(p, config, cwd, table)).map(p => p.pid), [400, 402, 403]);
});

test('front-door identity requires serve mode and this checkout', () => {
  const config = { rootDir: '/srv/a b', entry: '/srv/a b/server.js', execPath: '/opt/node/bin/node' };
  const record = command => ({ pid: 500, ppid: 1, born: 'old', command });
  const cwd = () => '/srv/a b';
  assert.equal(isGatewayRoot(record('"/opt/multicc/multicc-gateway" serve --cwd "/srv/a b" --node /opt/node server.js'), config, cwd), true);
  // Native binaries on macOS render argv NUL-separated as \012 and append env.
  assert.equal(isGatewayRoot(record('/opt/multicc/multicc-gateway serve\\012--cwd /srv/a b --node /opt/node server.js PATH=/usr/bin'), config, () => null), true);
  // Wrong working directory is only accepted through an explicit --cwd.
  assert.equal(isGatewayRoot(record('/opt/multicc/multicc-gateway serve --cwd /srv/other --node /opt/node server.js'), config, () => '/srv/other'), false);
  assert.equal(isGatewayRoot(record('/opt/multicc/multicc-gateway serve --cwd /srv/other --node /opt/node server.js'), config, () => null), false);
  // Node itself, non-serve gateway invocations and eval launches are never roots.
  assert.equal(isGatewayRoot(record('/opt/node/bin/node server.js'), config, cwd), false);
  assert.equal(isGatewayRoot(record('/opt/multicc/multicc-gateway --version'), config, cwd), false);
  assert.equal(isGatewayRoot(record('/opt/multicc/multicc-gateway stop'), config, cwd), false);
});

test('multicc start always launches through the front door and never runs node directly', {
  skip: !['darwin', 'linux'].includes(process.platform), timeout: 60000,
}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-gateway-start-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'runtime'));
  fs.copyFileSync(path.join(__dirname, '..', 'multicc'), path.join(root, 'multicc'));
  fs.chmodSync(path.join(root, 'multicc'), 0o700);
  fs.copyFileSync(path.join(__dirname, '..', 'src', 'server-processes.js'), path.join(root, 'src', 'server-processes.js'));
  fs.writeFileSync(path.join(root, 'scripts', 'check-runtime-deps.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(root, 'scripts', 'ensure-source-rust.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(root, 'server.js'), `require('fs').appendFileSync('starts', process.pid+'\\n');
    process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);
  fs.writeFileSync(path.join(root, 'starts'), '');
  // A fake front door: argument capture, or an immediate exit.
  const gateway = path.join(root, 'runtime', 'multicc-gateway');
  fs.writeFileSync(gateway, `#!/bin/sh
printf '%s' "$*" > "$(dirname "$0")/args"
if [ -n "$FAKE_GATEWAY_FAIL" ]; then echo "fake gateway: address already in use" >&2; exit 1; fi
echo $$ > "$(dirname "$0")/pid"
trap 'exit 0' INT TERM
while :; do sleep 1; done
`, { mode: 0o700 });
  const config = { rootDir: root, entry: path.join(root, 'server.js'), execPath: process.execPath };
  const started = [];
  const run = async env => {
    const port = await new Promise(resolve => {
      const probe = require('net').createServer();
      probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
    });
    const child = spawn(path.join(root, 'multicc'), ['start'], {
      cwd: root,
      env: {
        PATH: process.env.PATH, HOME: root, LANG: 'C', PORT: String(port),
        MULTICC_NODE: process.execPath, MULTICC_RUST_ADDON: path.join(root, 'runtime', 'multicc_core.node'),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise(resolve => child.once('exit', resolve));
    const pidFile = path.join(root, '.multicc.pid');
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8').trim()) : null;
    if (pid) started.push(pid);
    return { code, stdout, stderr, pid };
  };
  const killAll = async () => {
    for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    started.length = 0;
    await wait(() => processTable().filter(p => isServer(p, config)).length === 0);
    for (const dir of ['args', 'pid']) { try { fs.rmSync(path.join(root, 'runtime', dir)); } catch (_) {} }
  };
  t.after(async () => {
    await killAll();
    try { fs.rmSync(path.join(root, 'logs'), { recursive: true, force: true }); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });

  // 1. Healthy front door: argv carries server.js, cwd is this checkout.
  const withGateway = await run({});
  assert.equal(withGateway.code, 0, withGateway.stderr);
  assert.match(withGateway.stdout, /started behind multicc-gateway/);
  assert.equal(withGateway.pid, Number(fs.readFileSync(path.join(root, 'runtime', 'pid'), 'utf8').trim()));
  const args = fs.readFileSync(path.join(root, 'runtime', 'args'), 'utf8');
  assert.match(args, new RegExp(`^serve --cwd ${root} --node \\S+ server\\.js$`));
  if (process.platform !== 'win32') {
    const listed = processTable().filter(p => isServer(p, config, undefined, processTable()));
    // A shell-script stand-in has /bin/sh as argv[0]; only the real Rust binary
    // is recognized (the status test below spawns a real binary to prove it).
    assert.equal(listed.length, 0);
  }
  await killAll();
  assert.equal(fs.readFileSync(path.join(root, 'starts'), 'utf8').trim(), '', 'front door path must not launch node directly');
  fs.writeFileSync(path.join(root, 'starts'), '');

  // 2. A front door that exits within a second is a failed start: no direct
  // node server.js, no stale PID file.
  const failed = await run({ FAKE_GATEWAY_FAIL: '1' });
  assert.equal(failed.code, 1, failed.stdout);
  assert.match(failed.stdout, /Failed to start/);
  assert.equal(failed.pid, null, 'a failed start must not leave a PID file');
  await killAll();

  // 3. A missing binary is refused before anything is spawned.
  const missing = await run({ MULTICC_RUST_ADDON: path.join(root, 'runtime', 'absent', 'multicc_core.node') });
  assert.equal(missing.code, 1, missing.stdout);
  assert.match(missing.stdout, /Rust front door not found/);
  assert.equal(missing.pid, null);
  await killAll();

  assert.equal(fs.readFileSync(path.join(root, 'starts'), 'utf8').trim(), '',
    'there is no direct node server.js path any more');
});

test('multicc status reports a process behind the front door', {
  skip: !['darwin', 'linux'].includes(process.platform), timeout: 30000,
}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-gateway-status-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'runtime'));
  fs.copyFileSync(path.join(__dirname, '..', 'multicc'), path.join(root, 'multicc'));
  fs.chmodSync(path.join(root, 'multicc'), 0o700);
  fs.copyFileSync(path.join(__dirname, '..', 'src', 'server-processes.js'), path.join(root, 'src', 'server-processes.js'));
  fs.writeFileSync(path.join(root, 'scripts', 'check-runtime-deps.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(root, 'scripts', 'ensure-source-rust.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(root, 'server.js'), 'setInterval(()=>{},1000);');
  // A real process whose argv is "<dir>/multicc-gateway serve --cwd <root>":
  // copy a tiny system utility so the command line starts with that path.
  const gateway = path.join(root, 'runtime', 'multicc-gateway');
  fs.copyFileSync('/usr/bin/yes', gateway);
  fs.chmodSync(gateway, 0o755);
  const child = spawn(gateway, ['serve', '--cwd', root, '--node', process.execPath, 'server.js'],
    { cwd: root, stdio: 'ignore' });
  t.after(async () => {
    try { child.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const config = { rootDir: root, entry: path.join(root, 'server.js'), execPath: process.execPath };
  await wait(() => processTable().some(p => isServer(p, config, undefined, processTable())), {
    diagnostics: () => JSON.stringify(processTable().filter(p => p.pid === child.pid)),
  });
  const result = spawn(path.join(root, 'multicc'), ['status'], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, LANG: 'C', MULTICC_NODE: process.execPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  result.stdout.on('data', chunk => { stdout += chunk; });
  await new Promise(resolve => result.once('exit', resolve));
  assert.match(stdout, new RegExp(`MultiCC is running behind multicc-gateway \\(PID ${child.pid}\\)`));
});
