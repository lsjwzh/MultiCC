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
function listening(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
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
