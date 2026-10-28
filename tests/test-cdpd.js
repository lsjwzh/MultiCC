'use strict';

// src/cdpd.js without the real binary: where the gateway lives (must match
// native/cdpd/src/paths.rs), whether it is ALIVE (a socket file left by a killed
// process is not), and how an old gateway is replaced without throwing away an
// approved Chrome connection. The binary itself is exercised by
// tests/test-cdpd-gateway.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  PROTOCOL_VERSION, cdpdPaths, request, protocolOf, daemonEnv, createCdpdProvisioner, sanitizeUser,
} = require('../src/cdpd');

const quiet = { log() {}, warn() {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cdpd-'));
}

// A stand-in daemon that answers the control ops the provisioner uses.
function fakeDaemon(sockPath, { protocol = PROTOCOL_VERSION, version = '0.2.0', busy = false, stoppable = true } = {}) {
  const calls = [];
  const server = net.createServer((connection) => {
    let buffer = '';
    connection.on('data', (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const body = JSON.parse(buffer.slice(0, nl));
      calls.push(body);
      if (body.op === 'ping') {
        const pong = protocol === 1 ? { ok: true, pong: true, version: 1 } : { ok: true, pong: true, protocol, version, busy, pid: 4242 };
        connection.end(`${JSON.stringify(pong)}\n`);
      } else if (body.op === 'shutdown' && stoppable && (!busy || body.force)) {
        connection.end('{"ok":true}\n');
        server.close();
      } else {
        connection.end('{"ok":false,"error":"busy"}\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(sockPath, () => resolve({ server, calls })));
}

function fakeBinary(dir, version = '0.2.0') {
  const file = path.join(dir, 'multicc-cdpd');
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return { file, readVersion: () => ({ protocol: PROTOCOL_VERSION, version }) };
}

test('paths follow the same rules as native/cdpd/src/paths.rs', () => {
  assert.deepEqual(cdpdPaths({ HOME: '/home/u' }, { platform: 'linux' }), {
    dir: '/home/u/.multicc/cdpd',
    socket: '/home/u/.multicc/cdpd/cdp.sock',
    lock: '/home/u/.multicc/cdpd/cdpd.lock',
    log: '/home/u/.multicc/cdpd/cdpd.log',
    endpoint: '/home/u/.multicc/cdpd/endpoint.json',
  });
  // Deliberately NOT XDG_RUNTIME_DIR: launchd/systemd and a terminal disagree on it.
  assert.equal(cdpdPaths({ HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1' }, { platform: 'linux' }).socket,
    '/home/u/.multicc/cdpd/cdp.sock');
  assert.equal(cdpdPaths({ HOME: '/h', MULTICC_CDP_DIR: '/x' }, { platform: 'darwin' }).socket, '/x/cdp.sock');
  assert.equal(cdpdPaths({ HOME: '/h', MULTICC_CDP_SOCK: '/s.sock' }, { platform: 'darwin' }).socket, '/s.sock');
  const win = cdpdPaths({ USERPROFILE: 'C:\\Users\\Zhang San', USERNAME: 'Zhang San' }, { platform: 'win32' });
  assert.equal(win.socket, '\\\\.\\pipe\\multicc-cdpd-Zhang_San', 'per-user pipe: the pipe namespace is machine-wide');
  assert.equal(win.dir, 'C:\\Users\\Zhang San\\.multicc\\cdpd');
  assert.equal(sanitizeUser(''), 'default');
});

test('the long-lived daemon does not inherit the server\'s secrets', () => {
  const env = daemonEnv({ HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'sk', MULTICC_CDP_DIR: '/d', MULTICC_ACCESS_TOKEN: 't' });
  assert.deepEqual(env, { HOME: '/h', PATH: '/bin', MULTICC_CDP_DIR: '/d' });
});

test('protocol detection understands the old ping shape', () => {
  assert.equal(protocolOf({ ok: true, pong: true, version: 1 }), 1);
  assert.equal(protocolOf({ ok: true, protocol: 2, version: '0.2.0' }), 2);
  assert.equal(protocolOf(null), 0);
});

test('a socket file left by a killed daemon is not a running daemon', async () => {
  const dir = tempDir();
  const sockPath = path.join(dir, 'cdp.sock');
  const child = spawn(process.execPath, ['-e',
    `require('net').createServer(() => {}).listen(${JSON.stringify(sockPath)}, () => process.stdout.write('up'))`],
  { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(fs.existsSync(sockPath), true, 'the file outlives the process');
  assert.equal(await request({ op: 'ping' }, { env: { MULTICC_CDP_SOCK: sockPath } }), null);

  const binary = fakeBinary(dir);
  let spawned = 0;
  const servers = [];
  const provisioner = createCdpdProvisioner({
    env: { MULTICC_CDP_DIR: dir, MULTICC_CDP_BIN: binary.file },
    readVersion: binary.readVersion,
    logger: quiet,
    spawnFn: (file, args, options) => {
      spawned += 1;
      assert.deepEqual(args, ['serve']);
      assert.equal(options.cwd, dir, 'the daemon does not pin the server\'s cwd');
      assert.equal(options.detached, true);
      fs.rmSync(sockPath, { force: true });
      fakeDaemon(sockPath).then(({ server }) => servers.push(server));
      return { on() {}, unref() {} };
    },
  });
  const result = await provisioner.ensure();
  for (const server of servers) server.close();
  assert.equal(spawned, 1);
  assert.equal(result.action, 'started');
});

test('concurrent ensure calls start one daemon', async () => {
  const dir = tempDir();
  const sockPath = path.join(dir, 'cdp.sock');
  const binary = fakeBinary(dir);
  let spawned = 0;
  const servers = [];
  const provisioner = createCdpdProvisioner({
    env: { MULTICC_CDP_DIR: dir, MULTICC_CDP_BIN: binary.file },
    readVersion: binary.readVersion,
    logger: quiet,
    spawnFn: () => {
      spawned += 1;
      setTimeout(() => fakeDaemon(sockPath).then(({ server }) => servers.push(server)), 150);
      return { on() {}, unref() {} };
    },
  });
  const results = await Promise.all([provisioner.ensure(), provisioner.ensure(), provisioner.ensure()]);
  for (const server of servers) server.close();
  assert.equal(spawned, 1);
  assert.deepEqual(results.map((r) => r.action), ['started', 'started', 'started']);
});

test('an idle older gateway is replaced, a busy one is kept until it is idle', async () => {
  const dir = tempDir();
  const sockPath = path.join(dir, 'cdp.sock');
  const binary = fakeBinary(dir, '0.3.0');
  const env = { MULTICC_CDP_DIR: dir, MULTICC_CDP_BIN: binary.file };

  const busy = await fakeDaemon(sockPath, { version: '0.2.0', busy: true });
  const keep = createCdpdProvisioner({ env, readVersion: binary.readVersion, logger: quiet, spawnFn: () => assert.fail('must not spawn') });
  const kept = await keep.ensure();
  busy.server.close();
  assert.equal(kept.action, 'already-running');
  assert.equal(kept.pendingUpgrade, '0.3.0', 'restarting now would cost the user another approval');
  assert.ok(!busy.calls.some((c) => c.op === 'shutdown'));

  fs.rmSync(sockPath, { force: true });
  const idle = await fakeDaemon(sockPath, { version: '0.2.0', busy: false });
  const servers = [];
  const upgrade = createCdpdProvisioner({
    env, readVersion: binary.readVersion, logger: quiet,
    spawnFn: () => { fakeDaemon(sockPath, { version: '0.3.0' }).then(({ server }) => servers.push(server)); return { on() {}, unref() {} }; },
  });
  const replaced = await upgrade.ensure();
  for (const server of servers) server.close();
  assert.deepEqual(idle.calls.find((c) => c.op === 'shutdown'), { op: 'shutdown', force: false });
  assert.equal(replaced.action, 'started');
});

test('an incompatible gateway is forced out; one that cannot be stopped means direct connections', async () => {
  const dir = tempDir();
  const sockPath = path.join(dir, 'cdp.sock');
  const binary = fakeBinary(dir);
  const env = { MULTICC_CDP_DIR: dir, MULTICC_CDP_BIN: binary.file };

  const old = await fakeDaemon(sockPath, { protocol: 1, stoppable: false });
  const provisioner = createCdpdProvisioner({ env, readVersion: binary.readVersion, logger: quiet, spawnFn: () => assert.fail('must not spawn over it') });
  assert.deepEqual(await provisioner.ensure(), { action: 'skip', reason: 'incompatible-running', protocol: 1 });
  old.server.close();

  fs.rmSync(sockPath, { force: true });
  const stoppable = await fakeDaemon(sockPath, { protocol: 3 });
  const servers = [];
  const replace = createCdpdProvisioner({
    env, readVersion: binary.readVersion, logger: quiet,
    spawnFn: () => { fakeDaemon(sockPath).then(({ server }) => servers.push(server)); return { on() {}, unref() {} }; },
  });
  const result = await replace.ensure();
  for (const server of servers) server.close();
  assert.deepEqual(stoppable.calls.find((c) => c.op === 'shutdown'), { op: 'shutdown', force: true });
  assert.equal(result.action, 'started');
});

test('a missing binary is a clean skip, and autostart can be turned off', async () => {
  const dir = tempDir();
  const missing = path.join(dir, 'nope');
  const provisioner = createCdpdProvisioner({
    env: { MULTICC_CDP_DIR: dir, MULTICC_CDP_BIN: missing },
    spawnFn: () => assert.fail('must not spawn'),
    logger: quiet,
  });
  assert.deepEqual(await provisioner.ensure(), { action: 'skip', reason: 'binary-missing', binary: missing });
  for (const env of [{ MULTICC_CDP_AUTOSTART: '0' }, { MULTICC_CDP_GATEWAY: '0' }]) {
    const off = createCdpdProvisioner({ env: { MULTICC_CDP_DIR: dir, ...env }, spawnFn: () => assert.fail('must not spawn'), logger: quiet });
    assert.deepEqual(await off.ensure(), { action: 'skip', reason: 'disabled' });
  }
});

test('an old gateway that will not stop gets no hello, so Chrome sees one connection', async () => {
  const WebSocket = require('ws');
  const { openCdpSocket } = require('../src/cdp-relay');
  const dir = tempDir();
  const sockPath = path.join(dir, 'cdp.sock');
  const old = await fakeDaemon(sockPath, { protocol: 1, stoppable: false });
  const server = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  let connections = 0;
  server.on('connection', () => { connections += 1; });
  const binary = fakeBinary(dir);
  const env = { MULTICC_CDP_DIR: dir, MULTICC_CDP_BIN: binary.file };
  const provisioner = createCdpdProvisioner({ env, readVersion: binary.readVersion, logger: quiet, spawnFn: () => assert.fail('must not spawn') });
  try {
    const socket = openCdpSocket(`ws://127.0.0.1:${server.address().port}/devtools/browser/x`, { env, provisioner });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    assert.equal(socket.transport, 'direct');
    assert.ok(!old.calls.some((c) => c.op === 'cdp'), 'the old gateway would have opened its own connection to Chrome');
    assert.equal(connections, 1);
    socket.close();
  } finally {
    old.server.close();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the protocol number agrees across the server, the build script and the daemon', () => {
  const { CDPD_PROTOCOL } = require('../scripts/build-rust-kernels');
  const lib = fs.readFileSync(path.join(__dirname, '..', 'native', 'cdpd', 'src', 'lib.rs'), 'utf8');
  const daemon = Number(/pub const PROTOCOL_VERSION: u32 = (\d+);/.exec(lib)[1]);
  assert.equal(CDPD_PROTOCOL, PROTOCOL_VERSION);
  assert.equal(daemon, PROTOCOL_VERSION);
});
