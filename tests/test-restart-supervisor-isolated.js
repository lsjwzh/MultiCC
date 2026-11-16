'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const binary = process.env.MULTICC_RESTART_TEST_BIN || path.join(
  process.env.CARGO_TARGET_DIR || path.resolve(__dirname, '../native/target'), 'debug',
  process.platform === 'win32' ? 'restart-supervisor.exe' : 'restart-supervisor');

function exited(child) { return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))); }
function listening(server, host = '127.0.0.1') { return new Promise(resolve => server.listen(0, host, () => resolve(server.address().port))); }
function close(server) { return new Promise(resolve => server.close(resolve)); }
async function runCase(kind) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-restart-e2e-'));
  const old = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const oldExit = exited(old);
  let server, worker, workerExit, newPid;
  try {
    server = kind === 'occupied' ? http.createServer((req, res) => res.end('unrelated')) : net.createServer();
    const port = await listening(server);
    if (kind !== 'occupied') { await close(server); server = null; }
    const gateway = process.execPath;
    const fixture = path.join(dir, 'serve');
    fs.writeFileSync(fixture, `const http=require('http'),fs=require('fs');fs.writeFileSync(process.env.PID_FILE,String(process.pid));http.createServer((req,res)=>{res.setHeader('X-Multicc-Restart-Generation',process.env.MULTICC_RESTART_GENERATION);res.end(JSON.stringify({status:'ready'}));}).listen(Number(process.env.PORT),'127.0.0.1');`);
    const config = { mode: kind === 'success' ? 'background' : ['source', 'desktop', 'standalone'].includes(kind) ? kind : 'standalone', old_pid: old.pid, port,
      generation: 'test-generation', generation_file: path.join(dir, 'generation'), lock_file: path.join(dir, 'lock'),
      cwd: dir, gateway, node: process.execPath, log_path: path.join(dir, 'restart.log'),
      old_timeout_ms: kind === 'old' ? 200 : 3000, ready_timeout_ms: kind === 'timeout' ? 400 : 3000 };
    worker = spawn(binary, [], { env: { ...process.env, MULTICC_RESTART_CONFIG: JSON.stringify(config),
      PORT: String(port), FIXTURE_NODE: process.execPath, FIXTURE_SCRIPT: fixture, PID_FILE: path.join(dir, 'pid') }, stdio: ['ignore', 'pipe', 'pipe'] });
    workerExit = exited(worker);
    let stderr = '';
    worker.stderr.on('data', chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      worker.stdout.once('data', chunk => String(chunk).includes('READY') ? resolve() : reject(new Error('missing handshake')));
      worker.once('error', reject);
      workerExit.then(({ code }) => reject(new Error(`early exit ${code}: ${stderr}`)));
    });
    if (kind !== 'old') { old.kill(); await oldExit; }
    if (['source', 'desktop', 'standalone'].includes(kind)) {
      server = http.createServer((req, res) => { res.setHeader('X-Multicc-Restart-Generation', config.generation); res.end('{"status":"ready"}'); });
      await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    }
    const result = await workerExit;
    if (fs.existsSync(path.join(dir, 'pid'))) newPid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
    if (kind === 'success' || ['source', 'desktop', 'standalone'].includes(kind)) {
      assert.equal(result.code, 0, stderr);
      if (kind !== 'success') assert.equal(newPid, undefined, 'external supervisor owns the new process');
    }
    else {
      assert.notEqual(result.code, 0, stderr);
      assert.match(stderr, kind === 'old' ? /old instance did not exit/ : kind === 'timeout' ? /did not become ready/ : /port occupied/);
    }
    if (kind === 'old') assert.equal(old.exitCode, null, 'old process was not killed');
    if (kind === 'occupied') assert.equal(server.listening, true, 'foreign service remains running');
    assert.equal(fs.existsSync(config.generation_file), false, 'generation marker is cleaned up');
  } finally {
    if (worker && worker.exitCode === null) { worker.kill(); await workerExit; }
    if (old.exitCode === null && old.signalCode === null) { old.kill(); await oldExit; }
    if (newPid) { try { process.kill(newPid, 'SIGTERM'); } catch (_) {} }
    if (server && server.listening) await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const kind of ['success', 'source', 'desktop', 'standalone', 'old', 'timeout', 'occupied']) {
  test(`restart supervisor: ${kind}`, () => runCase(kind));
}

test('detached supervisor survives its launcher and exits after verified readiness', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-restart-detached-'));
  const old = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const oldExit = exited(old);
  const reservation = net.createServer();
  const port = await listening(reservation);
  await close(reservation);
  const log = path.join(dir, 'restart.log');
  const marker = path.join(dir, 'generation');
  const config = { mode: 'standalone', old_pid: old.pid, port, generation: 'detached-generation',
    generation_file: marker, lock_file: path.join(dir, 'lock'), cwd: dir, gateway: process.execPath,
    node: process.execPath, log_path: log, old_timeout_ms: 5000, ready_timeout_ms: 5000 };
  const source = `const fs=require('fs'),cp=require('child_process');const fd=fs.openSync(process.argv[2],'a');const c=cp.spawn(process.argv[1],[],{detached:true,stdio:['ignore',fd,fd],env:process.env});console.log(c.pid);c.unref();`;
  const launcher = spawn(process.execPath, ['-e', source, binary, log], { env: { ...process.env, MULTICC_RESTART_CONFIG: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; launcher.stdout.on('data', chunk => { output += chunk; });
  const launcherExit = await exited(launcher);
  assert.equal(launcherExit.code, 0);
  const supervisorPid = Number(output.trim());
  assert.ok(supervisorPid > 1);
  let server;
  try {
    const end = Date.now() + 5000;
    while (!fs.existsSync(marker) && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    assert.ok(fs.existsSync(marker), 'supervisor acquired its lock after launcher exit');
    old.kill(); await oldExit;
    server = http.createServer((req, res) => { res.setHeader('X-Multicc-Restart-Generation', config.generation); res.end('{"status":"ready"}'); });
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    while (fs.existsSync(marker) && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    assert.equal(fs.existsSync(marker), false);
    assert.match(fs.readFileSync(log, 'utf8'), /restart complete: verified new instance is ready/);
  } finally {
    if (old.exitCode === null && old.signalCode === null) { old.kill(); await oldExit; }
    if (server && server.listening) await close(server);
    // A failed assertion must not leave the detached worker behind. Its own
    // bounded readiness deadline ends it without signalling a reused PID.
    const cleanupDeadline = Date.now() + 6500;
    while (fs.existsSync(marker) && Date.now() < cleanupDeadline) await new Promise(r => setTimeout(r, 50));
    assert.equal(fs.existsSync(marker), false, 'detached supervisor must finish before the test returns');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('foreground guard stops the launcher on EOF and can be disarmed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-restart-hold-'));
  const marker = path.join(dir, 'stopped');
  const launcher = path.join(dir, 'launcher.js');
  fs.writeFileSync(launcher, `require('fs').writeFileSync(process.env.TEST_HOLD_MARKER,JSON.stringify(process.argv.slice(2)));`);
  const config = { node: process.execPath, launcher, data: dir };
  try {
    for (const disarm of [true, false]) {
      const child = spawn(binary, ['--hold'], { env: { ...process.env, MULTICC_RESTART_HOLD: JSON.stringify(config), TEST_HOLD_MARKER: marker }, stdio: ['pipe', 'ignore', 'pipe'] });
      const done = exited(child);
      let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
      child.stdin.end(disarm ? 'D' : undefined);
      const result = await done;
      assert.equal(result.code, 0, stderr);
      assert.equal(fs.existsSync(marker), !disarm);
      if (!disarm) assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), ['--stop', '--data', dir]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const localInterface = Object.values(os.networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal
  && (/^10\./.test(item.address) || /^192\.168\./.test(item.address) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(item.address)))?.address;
for (const kind of ['same-port', 'new-port', 'localhost', 'localhost-new-port', 'wrong-instance', 'local-interface']) {
  test(`restart client: ${kind}`, { skip: kind === 'local-interface' && !localInterface }, async () => {
    const old = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const oldExit = exited(old);
    let current = false, postCount = 0, nextServer, reservation;
    const changingPort = kind === 'new-port' || kind === 'localhost-new-port';
    const generation = 'fixture-new-generation';
    const original = http.createServer((req, res) => {
      if (req.method === 'POST') {
        postCount++;
        let text = '';
        req.on('data', chunk => { text += chunk; });
        req.on('end', () => {
          const parsed = JSON.parse(text);
          assert.equal(parsed.expectedPid, old.pid);
          if (kind === 'local-interface') assert.equal(req.headers['x-access-token'], 'fixture-local-token');
          if (changingPort) assert.equal(parsed.port, target);
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ restartId: generation }));
          if (!changingPort) current = true;
          old.kill();
          oldExit.then(async () => {
            if (changingPort) {
              nextServer = http.createServer(ready);
              nextServer.listen(target, '127.0.0.1');
            }
          });
        });
      } else ready(req, res);
    });
    function ready(req, res) {
      if (current || (changingPort && req.socket.localPort === target)) res.setHeader('X-Multicc-Restart-Generation', generation);
      else res.setHeader('X-Multicc-Gateway-Pid', String(old.pid));
      res.setHeader('Content-Type', 'application/json');
      res.end('{"status":"ready"}');
    }
    const host = kind === 'local-interface' ? localInterface : '127.0.0.1';
    const port = await listening(original, host);
    let target = port;
    if (changingPort) { reservation = net.createServer(); target = await listening(reservation); await close(reservation); }
    const child = spawn(binary, ['--request'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const done = exited(child);
    const watchdog = setTimeout(() => child.kill(), 10000);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.resume();
    const originHost = kind.startsWith('localhost') ? 'localhost' : host;
    child.stdin.end(JSON.stringify({ origin: `http://${originHost}:${port}`, expected_pids: [kind === 'wrong-instance' ? old.pid + 1 : old.pid], port: changingPort ? target : null,
      token: kind === 'local-interface' ? 'fixture-local-token' : '' }));
    try {
      const result = await done;
      assert.equal(result.code, kind === 'wrong-instance' ? 1 : 0, stderr);
      assert.equal(postCount, kind === 'wrong-instance' ? 0 : 1);
      if (kind === 'wrong-instance') assert.match(stderr, /identity does not match/);
    } finally {
      clearTimeout(watchdog);
      if (old.exitCode === null && old.signalCode === null) { old.kill(); await oldExit; }
      if (reservation && reservation.listening) await close(reservation);
      if (nextServer && nextServer.listening) await close(nextServer);
      await close(original);
    }
  });
}

test('restart client refuses a nonlocal target without exposing its token', async () => {
  const child = spawn(binary, ['--request'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const done = exited(child);
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  child.stdin.end(JSON.stringify({ origin: 'http://8.8.8.8:3000', expected_pids: [123], token: 'fixture-secret-do-not-print' }));
  const result = await done;
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(output, /fixture-secret-do-not-print/);
  assert.match(output, /requires a local HTTP origin/);
});

for (const kind of ['source-cli', 'standalone-cli', 'standalone-cli-new-port', 'standalone-cli-foreground']) {
  test(`real ${kind} delegates to Rust and verifies the replacement`, { skip: kind === 'source-cli' && process.platform === 'win32' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-restart-cli-'));
    const old = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const oldExit = exited(old);
    let current = false, posts = 0, nextServer, target, owner, ownerExit;
    const gateway = http.createServer((req, res) => {
      if (req.method === 'POST') {
        posts++;
        let data = ''; req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
          const parsed = JSON.parse(data);
          assert.equal(parsed.expectedPid, old.pid);
          if (kind === 'standalone-cli-new-port') assert.equal(parsed.port, target);
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end('{"restartId":"replacement"}');
          current = true; old.kill();
          if (kind === 'standalone-cli-new-port') oldExit.then(() => {
            nextServer = http.createServer((request, response) => {
              response.setHeader('x-multicc-restart-generation', 'replacement');
              response.end('{"status":"ready"}');
            });
            nextServer.listen(target, '127.0.0.1');
          });
        });
      } else {
        res.setHeader('content-type', 'application/json');
        if (current) res.setHeader('x-multicc-restart-generation', 'replacement');
        else res.setHeader('x-multicc-gateway-pid', String(old.pid));
        res.end('{"status":"ready"}');
      }
    });
    const port = await listening(gateway);
    if (kind === 'standalone-cli-new-port') {
      const probePort = net.createServer(); target = await listening(probePort); await close(probePort);
    }
    const repo = path.resolve(__dirname, '..');
    let command, args, env;
    if (kind === 'source-cli') {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(root, 'native-bin'), { recursive: true });
      fs.copyFileSync(path.join(repo, 'multicc'), path.join(root, 'multicc'));
      fs.copyFileSync(path.join(repo, 'src/server-restart.js'), path.join(root, 'src/server-restart.js'));
      fs.writeFileSync(path.join(root, 'src/host-env.js'), 'exports.readEnvFile=()=>({});');
      fs.writeFileSync(path.join(root, 'src/server-processes.js'), 'if(process.argv[2]!=="list")process.exit(8);process.stdout.write(process.env.TEST_OLD_PID);');
      fs.writeFileSync(path.join(root, 'scripts/ensure-source-rust.js'), 'process.stdout.write(process.env.TEST_ADDON);');
      fs.writeFileSync(path.join(root, 'scripts/check-runtime-deps.js'), 'process.exit(0);');
      const addon = path.join(root, 'native-bin', 'multicc_core.node');
      fs.copyFileSync(binary, path.join(root, 'native-bin', 'restart-supervisor'));
      fs.chmodSync(path.join(root, 'native-bin', 'restart-supervisor'), 0o755);
      command = '/bin/bash'; args = [path.join(root, 'multicc'), 'restart'];
      env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', MULTICC_NODE: process.execPath, TEST_OLD_PID: String(old.pid), TEST_ADDON: addon };
    } else {
      const app = path.join(root, 'app-server');
      const native = path.join(app, 'native/prebuilt', `${process.platform}-${process.arch}`);
      const runtime = path.join(root, 'runtime', process.platform === 'win32' ? '' : 'bin');
      const home = path.join(root, 'home');
      for (const dir of [path.join(app, 'src'), native, runtime, path.join(root, 'launcher'), home]) fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(path.join(repo, 'src/server-restart.js'), path.join(app, 'src/server-restart.js'));
      fs.writeFileSync(path.join(app, 'server.js'), '');
      fs.writeFileSync(path.join(root, 'launcher/standalone-launcher.js'), kind === 'standalone-cli-foreground'
        ? "require('fs').writeFileSync(process.env.TEST_STOP_FILE, 'stopped');" : '');
      fs.writeFileSync(path.join(root, 'bundle-manifest.json'), JSON.stringify({ version: '0.0.0', platform: process.platform, arch: process.arch }));
      const binName = process.platform === 'win32' ? 'restart-supervisor.exe' : 'restart-supervisor';
      fs.copyFileSync(binary, path.join(native, binName));
      if (process.platform !== 'win32') fs.chmodSync(path.join(native, binName), 0o755);
      const runtimeNode = path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node');
      if (process.platform === 'win32') fs.copyFileSync(process.execPath, runtimeNode);
      else fs.symlinkSync(process.execPath, runtimeNode);
      fs.writeFileSync(path.join(home, 'desktop-runtime.json'), JSON.stringify({ pid: old.pid, origin: `http://127.0.0.1:${port}` }));
      if (kind === 'standalone-cli-foreground') {
        owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        ownerExit = exited(owner);
        fs.writeFileSync(path.join(home, 'standalone-launcher.pid'), String(owner.pid));
      }
      command = process.execPath; args = [path.join(repo, 'scripts/standalone-cli.js'), 'restart'];
      if (target) args.push('--port', String(target));
      if (kind === 'standalone-cli-foreground') args.push('--foreground');
      env = { ...process.env, MULTICC_STANDALONE_RESOURCES: root, MULTICC_STANDALONE_HOME: home, TEST_STOP_FILE: path.join(root, 'stopped') };
    }
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const done = exited(child);
    const timer = setTimeout(() => child.kill(), 15000);
    let stderr = '', stdout = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (kind === 'standalone-cli-foreground' && stdout.includes('running in the foreground')) child.kill('SIGTERM');
    });
    try {
      const result = await done;
      if (kind !== 'standalone-cli-foreground' || process.platform !== 'win32') assert.equal(result.code, 0, stderr);
      assert.equal(posts, 1);
      if (kind === 'standalone-cli-foreground') {
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(path.join(root, 'stopped')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
        assert.ok(fs.existsSync(path.join(root, 'stopped')), 'foreground exit stops the existing launcher');
      }
    } finally {
      clearTimeout(timer);
      if (old.exitCode === null && old.signalCode === null) { old.kill(); await oldExit; }
      if (nextServer && nextServer.listening) await close(nextServer);
      if (owner && owner.exitCode === null && owner.signalCode === null) { owner.kill(); await ownerExit; }
      await close(gateway);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
