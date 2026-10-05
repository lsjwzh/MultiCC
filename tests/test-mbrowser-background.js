'use strict';

// No real browser or daemon: exercise mode selection and attachment with fake
// lifecycle/CDP boundaries, using isolated profile state only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../skills/multicc-browser/lib/paths');
const CH = require('../skills/multicc-browser/lib/chrome');
const client = require('../skills/multicc-browser/lib/client');
const lifecycle = require('../skills/multicc-browser/lib/lifecycle');
const { Daemon } = require('../skills/multicc-browser/lib/daemon');

function isolate(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbrowser-background-'));
  const previous = { MULTICC_DATA_DIR: process.env.MULTICC_DATA_DIR, MBROWSER_PROFILES_DIR: process.env.MBROWSER_PROFILES_DIR };
  process.env.MULTICC_DATA_DIR = path.join(root, 'state');
  process.env.MBROWSER_PROFILES_DIR = path.join(root, 'profiles');
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  P.writeJson(P.configPath('work'), { name: 'work', headed: true });
}

for (const liveHeaded of [true, false]) {
  test(`ordinary start reuses a live ${liveHeaded ? 'headed' : 'headless'} browser without a mode change`, async t => {
    isolate(t);
    t.mock.method(client, 'ensureDaemon', async (name, options) => {
      assert.equal(Object.hasOwn(options.daemonOptions, 'headed'), false);
      return { pid: 123, headed: liveHeaded };
    });
    t.mock.method(client, 'call', async (name, command) => {
      assert.equal(command, 'status', 'ordinary start must not issue set-mode');
      return { headed: liveHeaded, chromePid: 456, userDataDir: P.profileDir(name) };
    });
    const result = await lifecycle.start({ name: 'work' });
    assert.equal(result.restarted, null);
    assert.match(result.text, new RegExp(`Chrome ${liveHeaded ? 'headed' : 'headless'}`));
  });
}

for (const headed of [true, false]) {
  test(`explicit ${headed ? 'headed' : 'headless'} mode remains a requested transition`, async t => {
    isolate(t);
    t.mock.method(client, 'ensureDaemon', async (name, options) => {
      assert.equal(options.daemonOptions.headed, headed);
      return { pid: 123, headed: !headed };
    });
    const commands = [];
    t.mock.method(client, 'call', async (name, command, args) => {
      commands.push(command);
      if (command === 'set-mode') {
        assert.equal(args.headed, headed);
        return { changed: true, headed };
      }
      return { headed };
    });
    const result = await lifecycle.start({ name: 'work', headed, headless: !headed });
    assert.deepEqual(commands, ['set-mode', 'status']);
    assert.match(result.text, new RegExp(`Chrome ${headed ? 'headed' : 'headless'} \\(restarted\\)`));
  });
}

test('conflicting mode flags fail before changing profile config or starting a daemon', async t => {
  isolate(t);
  const before = fs.readFileSync(P.configPath('work'), 'utf8');
  await assert.rejects(lifecycle.start({ name: 'work', headed: true, headless: true }), { code: 'usage' });
  assert.equal(fs.readFileSync(P.configPath('work'), 'utf8'), before);
});

test('cold implicit startup ignores a previous login mode and preserves the existing user-data-dir', async t => {
  isolate(t);
  const existingDir = path.join(P.defaultProfileRoot(), 'imported');
  P.writeJson(P.configPath('work'), { headed: true, userDataDir: existingDir });
  const daemon = new Daemon('work');
  t.mock.method(CH, 'readsDevToolsActivePort', () => null);
  t.mock.method(daemon, 'launchChrome', async () => {
    assert.equal(daemon.headed, false);
    assert.equal(daemon.userDataDir, existingDir);
  });
  await daemon.ensureChrome();
  assert.equal(daemon.launchChrome.mock.callCount(), 1);
  assert.equal(new Daemon('work', { headed: true }).headed, true);
});

for (const liveHeaded of [true, false]) {
  test(`daemon replacement restores live ${liveHeaded ? 'headed' : 'headless'} mode from runtime state`, async t => {
    isolate(t);
    P.writeJson(P.statePath('work'), { chromePid: 456, headed: liveHeaded, owned: true });
    const daemon = new Daemon('work', { headed: !liveHeaded });
    t.mock.method(CH, 'readsDevToolsActivePort', () => ({ port: 12345, wsPath: '/browser/fake' }));
    t.mock.method(CH, 'processAlive', () => true);
    t.mock.method(CH, 'isOurChrome', () => true);
    t.mock.method(daemon, 'connectBrowser', async () => {});
    t.mock.method(daemon, 'launchChrome', async () => assert.fail('live browser must be reused'));
    await daemon.ensureChrome();
    assert.equal(daemon.headed, liveHeaded);
    assert.equal(daemon.chromePid, 456);
  });
}

test('a page command after a headed browser exits restarts it in the background', async t => {
  isolate(t);
  const daemon = new Daemon('work', { headed: true });
  daemon.phase = 'chrome-down';
  t.mock.method(daemon, 'relaunch', async () => {
    assert.equal(daemon.headed, false);
    return true;
  });
  t.mock.method(daemon, 'restoreOwners', async () => {});
  await daemon.ensureReady();
  assert.equal(daemon.phase, 'ready');
});

test('attach-only profiles retain external mode and never relaunch a lost browser', async t => {
  isolate(t);
  P.writeJson(P.configPath('work'), { headed: true, attachOnly: true, cdpUrl: 'http://127.0.0.1:12345' });
  const daemon = new Daemon('work');
  t.mock.method(daemon, 'attachExternal', async () => {});
  t.mock.method(daemon, 'launchChrome', async () => assert.fail('external browser must never be launched'));
  await daemon.ensureChrome();
  assert.equal(daemon.attachExternal.mock.callCount(), 1);
  assert.equal(daemon.headed, true);
  await assert.rejects(daemon.ensureReady(), { code: 'chrome_down' });
  assert.equal(daemon.headed, true);
});

for (const savedHeaded of [true, false, undefined]) {
  test(`profile lock reuse recovers its mode (${String(savedHeaded)}) without spawning`, async t => {
    isolate(t);
    P.writeJson(P.statePath('work'), { chromePid: 456, ...(savedHeaded === undefined ? {} : { headed: savedHeaded }) });
    const daemon = new Daemon('work');
    t.mock.method(CH, 'singletonLockHolder', () => 456);
    t.mock.method(CH, 'readsDevToolsActivePort', () => ({ port: 12345, wsPath: '/browser/fake' }));
    t.mock.method(daemon, 'connectBrowser', async () => {});
    t.mock.method(CH, 'spawnChrome', () => assert.fail('locked live profile must not launch another browser'));
    await daemon.launchChrome();
    assert.equal(daemon.headed, savedHeaded === undefined ? true : savedHeaded);
    assert.equal(daemon.owned, false);
    assert.equal(daemon.chromePid, 456);
  });
}

test('page commands keep a live headed browser and its connection unchanged', async t => {
  isolate(t);
  const daemon = new Daemon('work', { headed: true });
  const connection = { closed: false };
  daemon.cdp = connection;
  daemon.phase = 'ready';
  t.mock.method(daemon, 'relaunch', async () => assert.fail('live browser must not restart'));
  await daemon.ensureReady();
  assert.equal(daemon.headed, true);
  assert.equal(daemon.cdp, connection);
});
