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

// Focus is the one thing the user feels: a listing that reports the saved config
// instead of the live browser would hide a window sitting on their screen, and a
// stopped profile would look like it is about to open one. The note is there so
// callers keep away from those windows — not so they close or restart them.
test('listings name the profiles that really have a window on screen', async t => {
  isolate(t);
  // Live and headed: the only case that can steal focus.
  P.writeJson(P.configPath('window'), { name: 'window', headed: true });
  P.writeJson(P.statePath('window'), { chromePid: 456, headed: true, owned: true });
  // Live but headless: config says headed from an old login, the browser does not.
  P.writeJson(P.configPath('quiet'), { name: 'quiet', headed: true });
  P.writeJson(P.statePath('quiet'), { chromePid: 457, headed: false, owned: true });
  // Stopped: config says headed, the next start is still background.
  P.writeJson(P.configPath('stopped'), { name: 'stopped', headed: true });
  P.writeJson(P.statePath('stopped'), { chromePid: 458, headed: true, owned: true });
  // Attached to an external browser: a window exists, but it is not ours to
  // touch, so it must never appear in the note that names our own windows.
  P.writeJson(P.configPath('external'), {
    name: 'external', headed: true, attachOnly: true, cdpUrl: 'http://127.0.0.1:12345',
  });
  t.mock.method(CH, 'processAlive', pid => Number(pid) !== 458);

  const byName = Object.fromEntries(lifecycle.describeProfiles().map(profile => [profile.name, profile]));
  assert.equal(byName.window.mode, 'headed');
  assert.equal(byName.window.headed, true);
  assert.equal(byName.quiet.mode, 'headless');
  assert.equal(byName.quiet.headed, false);
  assert.equal(byName.stopped.headed, false, 'a stopped browser has no window');
  assert.equal(byName.stopped.mode, 'headless', 'a cold start is always headless');
  assert.equal(byName.external.mode, 'headed', 'an attached browser is headed');
  assert.equal(byName.external.headed, false, 'an attached browser is not our window');

  const listed = lifecycle.profiles();
  assert.match(listed.text, /quiet: headless/);
  assert.match(listed.text, /window: headed[\s\S]*\[window on screen\]/);
  assert.equal((listed.text.match(/\[window on screen\]/g) || []).length, 1,
    'only the live headed browser may be reported as a window');
  assert.match(listed.text, /headed windows \(1\): window/);
  assert.match(listed.text, /reuse them in place/);
  // Nothing in a listing may suggest handing a running browser back to the
  // background by restarting it: the window is not the problem, focus is.
  assert.doesNotMatch(listed.text, /--headless|mbrowser start NAME/);

  const report = await lifecycle.doctor({});
  assert.match(report.text, /window: headed[\s\S]*\[window on screen\]/);
  assert.match(report.text, /headed windows \(1\): window/);
  assert.equal(report.profiles.find(profile => profile.name === 'window').headed, true);
});

// The default has to be readable from the skill itself: an agent that only reads
// the contract must learn that focus is what is forbidden — not the window, and
// never "restart it headless to be quiet".
test('the skill states the background-first focus contract', async () => {
  const skill = fs.readFileSync(
    path.join(__dirname, '..', 'skills', 'multicc-browser', 'SKILL.md'), 'utf8');
  assert.match(skill, /焦点契约|focus contract/);
  assert.match(skill, /默认全程后台|background by default|background-first/i);
  assert.match(skill, /不激活、不置前/);
  assert.match(skill, /不改模式、不重启/);
  assert.match(skill, /必须由用户亲手完成[\s\S]{0,40}扫码/);
  // No handback ritual: nothing may send a running browser back to headless, and
  // the login flow must end in the same window rather than in a restart.
  assert.doesNotMatch(skill, /交回后台/);
  assert.doesNotMatch(skill, /start "?\$?\{?PROFILE\}?"? --headless/);
});

// The login flow is the one place that really opens a window, so it is where a
// "hand it back" habit would come from: it must end by staying put instead.
test('login keeps its headed window instead of handing the profile back', async t => {
  isolate(t);
  t.mock.method(client, 'ensureDaemon', async () => ({ pid: 123, version: 'test' }));
  t.mock.method(client, 'call', async (name, command) => {
    if (command === 'open') return { shortId: 't1' };
    if (command === 'set-mode') return { changed: true, headed: true };
    return {
      headed: true, chromePid: 456, userDataDir: P.profileDir(name), socket: P.socketPath(name),
    };
  });
  const result = await lifecycle.login({ name: 'work', url: 'https://site.example/login' });
  assert.match(result.text, /keep working in this same window/);
  assert.match(result.text, /do not restart or close this browser/);
  assert.doesNotMatch(result.text, /--headless|--mode|hand it back/);
});

// ------------------------------------------------------------- main profile

const net = require('node:net');
const G = require('../skills/multicc-browser/lib/gateway');
const M = require('../skills/multicc-browser/lib/main-chrome');
const seed = require('../skills/multicc-browser/lib/seed');

test('gateway refusals keep their code and say what to do; tokens never reach text', () => {
  const refused = G.refusalFromClose(JSON.stringify({
    ok: false, error: 'chrome_cooldown', detail: 'Chrome refused recently', retryAfterMs: 30000,
  }));
  assert.equal(refused.code, 'chrome_cooldown');
  assert.match(refused.message, /retry after 30s/);
  assert.match(refused.message, /do not loop/);
  assert.equal(G.refusalFromClose(JSON.stringify({ ok: false, error: 'cdp-upstream-closed', detail: 'gone' })).code,
    'cdp_upstream_closed', 'codes stay parseable as [a-z0-9_]+ for the CLI');
  assert.equal(G.refusalFromClose('normal closure'), null);
  assert.equal(G.redact('ws://127.0.0.1:1/cdp/abc123?lane=x'), 'ws://127.0.0.1:1/cdp/<token>?lane=x');
  assert.equal(G.endpointUrl('ws://127.0.0.1:1/cdp/t', { lane: 'mbrowser-main', ttlSeconds: 600 }),
    'ws://127.0.0.1:1/cdp/t?activePort=default&lane=mbrowser-main&ttl=600');
});

test('without a running gateway or its binary the main profile fails with a usable message', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbrowser-gw-'));
  try {
    const env = { HOME: root, PATH: '', MULTICC_CDP_DIR: path.join(root, 'cdpd'), MULTICC_CDP_BIN: path.join(root, 'nope') };
    await assert.rejects(G.baseEndpoint({ env }), error => error.code === 'gateway_unavailable'
      && /MULTICC_CDP_BIN/.test(error.message));
    await assert.rejects(G.baseEndpoint({ env: { ...env, MULTICC_CDP_GATEWAY: '0' } }),
      error => error.code === 'gateway_disabled');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function listening() {
  const server = net.createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('a main Chrome that is not running is started in the background, then used', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbrowser-main-'));
  const server = await listening();
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let launches = 0;
  const result = await M.ensureMain({
    dir,
    timeoutMs: 5000,
    launch: () => {
      launches += 1;
      // What a plain launch of a Chrome with the inspect switch on produces.
      fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${server.address().port}\n/devtools/browser/x\n`);
      return 'Google Chrome';
    },
  });
  assert.equal(launches, 1);
  assert.equal(result.launched, true);
  assert.equal(result.debuggable, true);
  // Already debuggable: no second launch.
  assert.equal((await M.ensureMain({ dir, launch: () => { throw new Error('must not launch'); } })).launched, false);
});

test('a stale DevToolsActivePort is not mistaken for a debuggable Chrome, and a dud launch is named', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbrowser-main-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = await listening();
  const deadPort = server.address().port;
  await new Promise(resolve => server.close(resolve));
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${deadPort}\n/devtools/browser/x\n`);
  const state = await M.inspect({ dir });
  assert.equal(state.debuggable, false);
  await assert.rejects(M.ensureMain({ dir, timeoutMs: 600, launch: () => 'Google Chrome' }),
    error => error.code === 'main_launch_failed');
  await assert.rejects(M.ensureMain({ dir, allowLaunch: false }), error => error.code === 'main_not_running');
});

test('launching the main Chrome on macOS never brings it to the front', () => {
  const calls = [];
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'Google Chrome-')) ;
  const bundle = `${app}.app`;
  fs.renameSync(app, bundle);
  try {
    M.launchMain({
      env: { MBROWSER_MAIN_CHROME: bundle },
      platform: 'darwin',
      spawnImpl: (cmd, args) => { calls.push([cmd, ...args]); return { on() {}, unref() {} }; },
    });
  } finally {
    fs.rmSync(bundle, { recursive: true, force: true });
  }
  assert.deepEqual(calls, [['open', '-g', '-a', bundle]]);
});

test('cookies from the main Chrome become settable cookies, and one bad cookie cannot sink the rest', async () => {
  const session = { name: 's', value: '1', domain: '.a.test', path: '/', expires: -1, session: true, secure: true, httpOnly: true, sameSite: 'Lax', size: 2 };
  const persistent = { name: 'p', value: '2', domain: 'b.test', path: '/x', expires: 1900000000, session: false, secure: false, httpOnly: false, priority: 'High' };
  assert.deepEqual(seed.toCookieParam(session),
    { name: 's', value: '1', domain: '.a.test', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
  assert.equal(seed.toCookieParam(persistent).expires, 1900000000);
  assert.equal('size' in seed.toCookieParam(session), false, 'read-only fields are dropped');

  const bad = { name: 'bad', value: 'x', domain: 'c.test', path: '/' };
  const calls = [];
  const send = async (method, params) => {
    calls.push(params.cookies.length);
    if (params.cookies.some(cookie => cookie.name === 'bad')) throw new Error('Invalid cookie fields');
    return {};
  };
  const result = await seed.importCookies(send, [session, bad, persistent]);
  assert.deepEqual(result, { imported: 2, failed: 1, total: 3 });
  assert.deepEqual(calls, [3, 1, 1, 1]);
});

test('a new dedicated profile starts with the main Chrome\'s login unless the user asked for blank', async t => {
  isolate(t);
  const cookies = [{ name: 'sid', value: 'v', domain: 'site.test', path: '/' }];
  const exports = [];
  t.mock.method(seed, 'exportMainCookies', async () => { exports.push(1); return cookies; });
  const commands = [];
  t.mock.method(client, 'ensureDaemon', async () => ({ pid: 1, version: 'test', headed: false }));
  t.mock.method(client, 'call', async (name, command, args) => {
    commands.push(command);
    if (command === 'import-cookies') {
      assert.deepEqual(args.cookies, cookies);
      return { imported: 1, failed: 0, total: 1 };
    }
    return { headed: false, chromePid: 9, userDataDir: P.profileDir(name), socket: P.socketPath(name) };
  });
  const seeded = await lifecycle.start({ name: 'shop', create: true });
  assert.equal(exports.length, 1);
  assert.deepEqual(commands, ['import-cookies', 'status']);
  assert.match(seeded.text, /imported 1 cookies from the everyday Chrome/);
  assert.equal(lifecycle.profileConfig('shop').seed.status, 'done');

  const blank = await lifecycle.start({ name: 'clean', create: true, blank: true });
  assert.equal(exports.length, 1, '--blank never reads the main Chrome');
  assert.deepEqual(lifecycle.profileConfig('clean').seed, { from: 'blank' });
  assert.match(blank.text, /created blank/);

  // An existing profile keeps its own login.
  await lifecycle.start({ name: 'work' });
  assert.equal(exports.length, 1);
});

test('when the main Chrome cannot be read, no half-made profile is left behind', async t => {
  isolate(t);
  t.mock.method(seed, 'exportMainCookies', async () => {
    throw new P.MbError('main_not_debuggable', 'remote debugging is off');
  });
  t.mock.method(client, 'ensureDaemon', async () => { throw new Error('must not start a browser'); });
  await assert.rejects(lifecycle.start({ name: 'shop', create: true }), error => error.code === 'main_not_debuggable');
  assert.equal(lifecycle.profileConfig('shop'), null);
  assert.equal(fs.existsSync(P.profileDir('shop')), false);
});

test('the main daemon never changes mode, restarts or reopens the everyday Chrome', async t => {
  isolate(t);
  process.env.MBROWSER_MAIN_USER_DATA_DIR = path.join(process.env.MBROWSER_PROFILES_DIR, '..', 'main-chrome');
  t.after(() => { delete process.env.MBROWSER_MAIN_USER_DATA_DIR; });
  const daemon = new Daemon('main');
  assert.equal(daemon.kind, 'main');
  assert.equal(daemon.userDataDir, process.env.MBROWSER_MAIN_USER_DATA_DIR);
  await assert.rejects(daemon.setMode({ headed: false }), error => error.code === 'main_chrome');
  t.mock.method(daemon, 'relaunch', async () => { throw new Error('must not relaunch'); });
  daemon.phase = 'ready';
  await daemon.onChromeLost('user quit Chrome');
  assert.equal(daemon.phase, 'chrome-down');
  assert.equal(daemon.relaunch.mock.callCount(), 0);
  assert.equal(lifecycle.profileExists('main'), true);
  await assert.rejects(lifecycle.start({ name: 'main', headless: true }), error => error.code === 'usage');
});

test('an older Agent gateway is reported clearly and the isolation browser never connects directly', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbrowser-old-gateway-'));
  const socketPath = path.join(root, 'cdp.sock');
  const operations = [];
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    let body = '';
    socket.on('data', chunk => {
      body += chunk;
      if (!body.includes('\n')) return;
      const request = JSON.parse(body.split('\n')[0]);
      operations.push(request.op);
      socket.end(JSON.stringify(request.op === 'endpoint'
        ? { ok: true, url: 'ws://127.0.0.1:1/cdp/private-token' }
        : { ok: true, protocol: 2, version: '0.2.0' }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(G.browserEndpoint({ wsUrl: 'pipe:///tmp/identity.sock', env: { MULTICC_CDP_SOCK: socketPath } }),
    error => error.code === 'gateway_upgrade_required' && !error.message.includes('private-token')
      && /do not fall back/.test(error.message));
  assert.deepEqual(operations, ['endpoint', 'ping']);
});
