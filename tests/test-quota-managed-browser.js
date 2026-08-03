'use strict';

// src/quota-managed-browser.js without a real Chrome: the binary path and the
// spawn function are injectable, and for the attach paths a tiny in-process
// HTTP + WebSocket server stands in for a debug-enabled browser.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { WebSocketServer } = require('ws');

const {
  createManagedQuotaBrowser,
  findChromeBinary,
} = require('../src/quota-managed-browser');

function tmpProfile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quota-browser-test-'));
}

// A fake proc: records kill() calls and emits 'exit' when asked.
function fakeProc(pid = 4242) {
  const handlers = { exit: [] };
  return {
    pid,
    exitCode: null,
    killed: [],
    on(event, fn) { if (handlers[event]) handlers[event].push(fn); },
    kill(sig) { this.killed.push(sig); },
    emitExit(code = 0) { this.exitCode = code; for (const fn of handlers.exit) fn(code); },
  };
}

function recorderSpawn(procs = []) {
  return (bin, args) => {
    const proc = fakeProc(4000 + procs.length);
    procs.push({ bin, args, proc });
    return proc;
  };
}

// Stand-in for a debug-enabled Chrome: /json/version plus a CDP WebSocket that
// answers every command with an empty result (and a product for getVersion).
async function startFakeChrome() {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      const port = server.address().port;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        ws.send(JSON.stringify({ id: msg.id, result: { product: 'FakeChrome/1', cookies: [] } }));
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    close: () => new Promise((resolve) => { wss.close(); server.close(resolve); }),
    writeActivePortFile(profileDir) {
      fs.writeFileSync(path.join(profileDir, 'DevToolsActivePort'), `${port}\n/devtools/browser/fake\n`);
    },
  };
}

test('findChromeBinary honours MULTICC_CHROME_BIN and reports null when absent', () => {
  const missing = path.join(os.tmpdir(), 'no-such-chrome-' + Date.now());
  assert.equal(findChromeBinary('darwin', { MULTICC_CHROME_BIN: missing }), null);
  // An override pointing at a real executable wins over the platform list.
  const bin = findChromeBinary('darwin', { MULTICC_CHROME_BIN: process.execPath });
  assert.equal(bin, process.execPath);
});

test('attachManaged rejects chrome_unavailable when no binary exists', async () => {
  const managed = createManagedQuotaBrowser({ profileDir: tmpProfile(), binary: null });
  await assert.rejects(managed.attachManaged(), (err) => err.code === 'chrome_unavailable');
});

test('attachManaged connects to an already-running browser on the managed profile without spawning', async () => {
  const fake = await startFakeChrome();
  const profileDir = tmpProfile();
  fake.writeActivePortFile(profileDir);
  const spawned = [];
  const managed = createManagedQuotaBrowser({
    profileDir,
    binary: '/fake/chrome',
    spawnChrome: recorderSpawn(spawned),
  });
  try {
    const browser = await managed.attachManaged();
    const version = await browser.send('Browser.getVersion');
    assert.equal(version.product, 'FakeChrome/1');
    browser.close();
    assert.equal(spawned.length, 0, 'a live browser on the profile means no launch');
    assert.deepEqual(managed.status().running, false, 'we did not spawn it, we do not own it');
  } finally {
    await fake.close();
  }
});

test('attachManaged launches headless once when nothing is running, then reuses it', async () => {
  const fake = await startFakeChrome();
  const profileDir = tmpProfile();
  const spawned = [];
  const managed = createManagedQuotaBrowser({
    profileDir,
    binary: '/fake/chrome',
    spawnChrome: (bin, args) => {
      const proc = fakeProc(4001);
      spawned.push({ bin, args, proc });
      // Chrome writes its port file shortly after starting; emulate that.
      setTimeout(() => fake.writeActivePortFile(profileDir), 30);
      return proc;
    },
    startupTimeoutMs: 4000,
  });
  try {
    const browser = await managed.attachManaged();
    browser.close();
    assert.equal(spawned.length, 1);
    assert.ok(spawned[0].args.includes('--headless=new'));
    assert.ok(spawned[0].args.includes('--remote-debugging-port=0'));
    assert.ok(spawned[0].args.some((a) => a === `--user-data-dir=${profileDir}`));
    assert.equal(spawned[0].args[spawned[0].args.length - 1], 'about:blank');

    const status = managed.status();
    assert.equal(status.running, true);
    assert.equal(status.mode, 'headless');

    // Second attach: no second spawn.
    const again = await managed.attachManaged();
    again.close();
    assert.equal(spawned.length, 1);
  } finally {
    managed.stopManaged();
    await fake.close();
  }
});

test('concurrent attachManaged calls share one launch', async () => {
  const fake = await startFakeChrome();
  const profileDir = tmpProfile();
  const spawned = [];
  const managed = createManagedQuotaBrowser({
    profileDir,
    binary: '/fake/chrome',
    spawnChrome: (bin, args) => {
      const proc = fakeProc(4002);
      spawned.push({ bin, args, proc });
      setTimeout(() => fake.writeActivePortFile(profileDir), 40);
      return proc;
    },
    startupTimeoutMs: 4000,
  });
  try {
    const [a, b] = await Promise.all([managed.attachManaged(), managed.attachManaged()]);
    a.close();
    b.close();
    assert.equal(spawned.length, 1, 'two concurrent callers must not race two launches');
  } finally {
    managed.stopManaged();
    await fake.close();
  }
});

test('a launch that never becomes reachable gives up with chrome_unavailable', async () => {
  const profileDir = tmpProfile();
  const spawned = [];
  const managed = createManagedQuotaBrowser({
    profileDir,
    binary: '/fake/chrome',
    spawnChrome: recorderSpawn(spawned),
    startupTimeoutMs: 300,
  });
  await assert.rejects(managed.attachManaged(), (err) => err.code === 'chrome_unavailable');
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].proc.killed.length > 0, 'a wedged launch is killed before giving up');
});

test('a Chrome that exits immediately reports the exit instead of polling forever', async () => {
  const profileDir = tmpProfile();
  const spawned = [];
  const managed = createManagedQuotaBrowser({
    profileDir,
    binary: '/fake/chrome',
    spawnChrome: (bin, args) => {
      const proc = fakeProc(4003);
      spawned.push({ bin, args, proc });
      setTimeout(() => proc.emitExit(1), 10);
      return proc;
    },
    startupTimeoutMs: 4000,
  });
  await assert.rejects(managed.attachManaged(), /exited early/);
});

test('openVisibleLogin stops the headless instance and spawns a window at the URL', async () => {
  const fake = await startFakeChrome();
  const profileDir = tmpProfile();
  const spawned = [];
  const managed = createManagedQuotaBrowser({
    profileDir,
    binary: '/fake/chrome',
    spawnChrome: (bin, args) => {
      const proc = fakeProc(4100 + spawned.length);
      spawned.push({ bin, args, proc });
      if (args.includes('--headless=new')) setTimeout(() => fake.writeActivePortFile(profileDir), 20);
      return proc;
    },
    startupTimeoutMs: 4000,
  });
  try {
    const headless = await managed.attachManaged();
    headless.close();
    assert.equal(spawned.length, 1);

    const result = await managed.openVisibleLogin('https://www.kimi.com/membership/subscription');
    assert.equal(result.ok, true);
    assert.equal(spawned.length, 2);
    const visible = spawned[1];
    assert.ok(!visible.args.includes('--headless=new'), 'the login window must be visible');
    assert.equal(visible.args[visible.args.length - 1], 'https://www.kimi.com/membership/subscription');
    assert.ok(spawned[0].proc.killed.length > 0, 'the headless instance is stopped first (profile lock)');
    assert.equal(managed.status().mode, 'visible');

    // A second request while the window is open reuses it.
    const again = await managed.openVisibleLogin('https://ignored');
    assert.equal(again.reused, true);
    assert.equal(spawned.length, 2);
  } finally {
    managed.stopManaged();
    await fake.close();
  }
});

test('openVisibleLogin rejects without a binary', async () => {
  const managed = createManagedQuotaBrowser({ profileDir: tmpProfile(), binary: null });
  await assert.rejects(managed.openVisibleLogin('https://x'), (err) => err.code === 'chrome_unavailable');
});

test('stopManaged kills only what it spawned and reports it', async () => {
  const profileDir = tmpProfile();
  const managed = createManagedQuotaBrowser({
    profileDir,
    binary: '/fake/chrome',
    spawnChrome: recorderSpawn([]),
  });
  assert.equal(managed.stopManaged(), false, 'nothing running, nothing to stop');
});
