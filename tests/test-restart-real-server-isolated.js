'use strict';
// Full production route against a disposable server and data directory.
// The currently running MultiCC is never queried or signalled.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { processTable, isGatewayRoot, sameProcess } = require('../src/server-processes');
const isolatedHostEnv = require('./helpers/isolated-host-env');

const privateIp = Object.values(os.networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal
  && (/^10\./.test(item.address) || /^192\.168\./.test(item.address) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(item.address)))?.address;
for (const [label, bindHost] of [['loopback', '127.0.0.1'], ['localhost', 'localhost'], ['local-interface', privateIp]]) test(`production restart route verifies readiness on ${label}`, { timeout: 90000, skip: !bindHost }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-real-restart-')));
  const repo = path.resolve(__dirname, '..');
  const host = path.join(root, 'host'), data = path.join(root, 'data'), home = path.join(root, 'home');
  for (const dir of [host, data, home]) fs.mkdirSync(dir);
  fs.copyFileSync(path.join(repo, 'server.js'), path.join(host, 'server.js'));
  for (const name of ['src', 'plugins', 'public', 'skills']) fs.symlinkSync(path.join(repo, name), path.join(host, name), 'junction');
  // Use the real source launcher with an isolated prebuilt resolver, so the
  // restart exercises the launcher's lifeline without compiling in the test.
  const scripts = path.join(host, 'scripts'); fs.mkdirSync(scripts);
  for (const name of fs.readdirSync(path.join(repo, 'scripts'))) {
    if (name === 'ensure-source-rust.js' || name === 'start-gateway.js') continue;
    const source = path.join(repo, 'scripts', name);
    if (fs.statSync(source).isDirectory()) fs.symlinkSync(source, path.join(scripts, name), 'junction');
    else fs.copyFileSync(source, path.join(scripts, name));
  }
  fs.copyFileSync(path.join(repo, 'scripts/start-gateway.js'), path.join(scripts, 'start-gateway.js'));
  fs.writeFileSync(path.join(scripts, 'ensure-source-rust.js'),
    'exports.ensureSourceRust=()=>process.env.MULTICC_RUST_ADDON;exports.addonForSourceChild=()=>process.env.MULTICC_RUST_ADDON;');
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(host, 'package.json'));
  fs.symlinkSync(path.dirname(path.dirname(require.resolve('express/package.json'))), path.join(host, 'node_modules'), 'junction');
  const addon = process.env.MULTICC_RUST_ADDON || path.join(process.env.MULTICC_RUST_PREBUILT_DIR || path.join(repo, 'native/prebuilt'), `${process.platform}-${process.arch}`, 'multicc_core.node');
  const native = path.join(root, 'native'); fs.mkdirSync(native);
  fs.copyFileSync(addon, path.join(native, 'multicc_core.node'));
  const target = process.env.CARGO_TARGET_DIR || path.join(repo, 'native/target');
  const profile = process.env.MULTICC_RESTART_TEST_PROFILE || 'debug';
  assert.ok(['debug', 'release'].includes(profile), 'unsupported Rust test profile');
  for (const name of ['multicc-gateway', 'restart-supervisor']) {
    const file = process.platform === 'win32' ? `${name}.exe` : name;
    fs.copyFileSync(path.join(target, profile, file), path.join(native, file));
    if (process.platform !== 'win32') fs.chmodSync(path.join(native, file), 0o755);
  }
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://${bindHost}:${port}`;
  const missing = path.join(root, 'missing');
  const commands = Object.fromEntries(['CLAUDE_CMD','OPENCODE_CMD','ZCODE_CMD','QODER_CMD','KIMI_CMD','CODEBUDDY_CMD','DSH_CMD','CODEX_CMD'].map(name => [name, missing]));
  let output = '', supervisorPid = null, generation = null, replacementPid = null;
  const gateway = spawn(path.join(native, process.platform === 'win32' ? 'multicc-gateway.exe' : 'multicc-gateway'),
    ['serve', '--cwd', host, '--node', process.execPath, 'server.js'], { cwd: host, env: { ...isolatedHostEnv(), ...commands,
      HOME: home, USERPROFILE: home, NODE_ENV: 'test', PORT: String(port), HOST: bindHost, ACCESS_TOKEN: 'isolated-only', MULTICC_ALLOW_REMOTE: '1',
      MULTICC_RUST_ADDON: path.join(native, 'multicc_core.node'), MULTICC_DATA_DIR: data,
      MULTICC_MEMORY_ROOT: path.join(data, 'memories'), MULTICC_ENV_FILE: path.join(root, 'test.env'),
      MULTICC_RESTART_TEST_TIMEOUT_MS: '20000', MULTICC_AGENT_AUTO_INSTALL: '0',
      MULTICC_CHROME_BIN: missing, CLAUDE_OAUTH_AUTO_REFRESH: '0', CODEX_OAUTH_AUTO_REFRESH: '0', ASR_LOCAL: 'off',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
  gateway.stdout.on('data', chunk => { output += chunk; });
  gateway.stderr.on('data', chunk => { output += chunk; });
  const oldExit = new Promise(resolve => gateway.once('exit', resolve));
  async function ready() {
    try { return await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1500) }); } catch (_) { return null; }
  }
  try {
    let initial;
    for (let i = 0; i < 300; i++) {
      initial = await ready();
      if (initial?.ok) break;
      if (gateway.exitCode !== null) throw new Error(`isolated gateway exited: ${output.slice(-3000)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(initial?.ok, `isolated server not ready: ${output.slice(-3000)}`);
    assert.equal(Number(initial.headers.get('x-multicc-gateway-pid')), gateway.pid);
    const response = await fetch(`${origin}/api/restart`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-access-token': 'isolated-only' }, body: JSON.stringify({ expectedPid: gateway.pid }), signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 202, await response.clone().text());
    const scheduled = await response.json();
    supervisorPid = scheduled.supervisorPid; generation = scheduled.restartId;
    assert.ok(supervisorPid > 1 && generation);
    let replacement;
    for (let i = 0; i < 350; i++) {
      replacement = await ready();
      if (replacement?.headers.get('x-multicc-restart-generation') === generation) {
        replacementPid = Number(replacement.headers.get('x-multicc-gateway-pid'));
        if (replacement.ok) break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(replacement?.ok && replacementPid > 1 && replacementPid !== gateway.pid,
      `replacement not ready; restart log: ${fs.existsSync(path.join(data, 'logs/restart-supervisor.log')) ? fs.readFileSync(path.join(data, 'logs/restart-supervisor.log'), 'utf8').slice(-3000) : output.slice(-3000)}`);
    assert.equal((await replacement.json()).status, 'ready');
    assert.equal(Number(fs.readFileSync(path.join(host, '.multicc.pid'), 'utf8')), replacementPid);
    await oldExit;
  } finally {
    // The worker is bounded to 20 seconds in this disposable test. Let it
    // finish before enumerating only gateways whose cwd is this unique root.
    const marker = path.join(data, '.restart-generation');
    const deadline = Date.now() + 25000;
    while (fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    const config = { rootDir: host };
    for (const record of processTable().filter(item => isGatewayRoot(item, config))) {
      if (sameProcess(record, processTable().find(item => item.pid === record.pid))) {
        try { process.kill(record.pid, 'SIGINT'); } catch (_) {}
      }
    }
    if (gateway.exitCode === null && gateway.signalCode === null) { gateway.kill('SIGINT'); await oldExit; }
    const belongsToFixture = item => isGatewayRoot(item, config) || item.command.includes(path.join(host, 'scripts', 'start-gateway.js'));
    for (let i = 0; i < 100 && processTable().some(belongsToFixture); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(processTable().some(belongsToFixture), false, 'isolated gateway and launcher must exit');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
