'use strict';

// The mbrowser CLI is the only part of the executor that runs in the caller's
// process, so its contract is pinned here: argument parsing (including the
// flags that must NOT be swallowed), the state/profile path overrides, and the
// exit codes callers branch on. Nothing in this file starts a browser or a
// daemon.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MBROWSER = path.join(ROOT, 'skills', 'multicc-browser', 'bin', 'mbrowser');
const { parseArgs, camel, commandArgs, USAGE, PAGE_COMMANDS } = require(MBROWSER);
const P = require(path.join(ROOT, 'skills', 'multicc-browser', 'lib', 'paths'));

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mbrowser-cli-'));
process.on('exit', () => { try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch (_) { /* ignore */ } });

const CHILD_ENV = {
  ...process.env,
  MULTICC_DATA_DIR: path.join(TEMP, 'state'),
  MBROWSER_PROFILES_DIR: path.join(TEMP, 'profiles'),
  MBROWSER_PROFILE: '',
  MULTICC_SESSION_ID: '',
};

function run(args, env = {}) {
  return spawnSync(process.execPath, [MBROWSER, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...CHILD_ENV, ...env },
  });
}

test('long flags map to camelCase and booleans never eat the next argument', () => {
  assert.equal(camel('max-chars'), 'maxChars');
  assert.equal(camel('new-tab'), 'newTab');
  assert.equal(camel('cdp-url'), 'cdpUrl');
  const { flags, positional } = parseArgs([
    'open', 'https://a.test', '--new-tab', '-p', 'work', '--max-chars', '300', '--json',
  ]);
  assert.deepEqual(positional, ['open', 'https://a.test']);
  assert.deepEqual(flags, { newTab: true, profile: 'work', maxChars: '300', json: true });
  // A boolean immediately followed by another flag stays boolean.
  assert.deepEqual(parseArgs(['snapshot', '--interactive', '--json']).flags,
    { interactive: true, json: true });
  // `--flag=value` and the space form agree.
  assert.equal(parseArgs(['text', '--max-chars=50']).flags.maxChars, '50');
  assert.equal(parseArgs(['text', '--max-chars', '50']).flags.maxChars, '50');
  // Everything after `--` is positional, even when it looks like a flag.
  assert.deepEqual(parseArgs(['type', '--', '--weird', '-x']).positional, ['type', '--weird', '-x']);
});

test('--xy accepts one pair in every spelling and rejects half a point', () => {
  assert.deepEqual(parseArgs(['click', '--xy', '10', '20']).flags.xy, [10, 20]);
  assert.deepEqual(parseArgs(['click', '--xy', '10,20']).flags.xy, [10, 20]);
  assert.deepEqual(parseArgs(['click', '--xy=10,20']).flags.xy, [10, 20]);
  assert.deepEqual(parseArgs(['click', '--xy', '-3', '20']).flags.xy, [-3, 20]);
  assert.throws(() => parseArgs(['click', '--xy', '10']), error => error.code === 'usage');
  assert.throws(() => parseArgs(['click', '--xy', 'a', 'b']), error => error.code === 'usage');
});

test('an unknown or valueless flag is a usage error, never silently ignored', () => {
  // A typo'd `--headlesss` must not leave the browser running headed unnoticed.
  assert.throws(() => parseArgs(['start', '--headlesss', 'work']),
    error => error.code === 'usage' && /unknown flag --headlesss/.test(error.message));
  assert.throws(() => parseArgs(['open', '-z', 'https://a.test']), error => error.code === 'usage');
  assert.throws(() => parseArgs(['status', '-p']),
    error => error.code === 'usage' && /needs a profile name/.test(error.message));
  assert.throws(() => parseArgs(['snapshot', '--interactive=yes']), error => error.code === 'usage');
  assert.throws(() => parseArgs(['text', '--max-chars=']), error => error.code === 'usage');
});

test('positional arguments are shaped per command', () => {
  assert.deepEqual(commandArgs('type', ['e3', 'hello', 'world']), { ref: 'e3', text: 'hello world' });
  assert.deepEqual(commandArgs('type', ['e3']), { ref: 'e3', text: '' });
  assert.deepEqual(commandArgs('select', ['e1', 'two', 'words']), { ref: 'e1', value: 'two words' });
  assert.deepEqual(commandArgs('scroll', ['down', '800']), { direction: 'down', px: '800' });
  assert.deepEqual(commandArgs('scroll', ['800']), { direction: 'down', px: '800' });
  assert.deepEqual(commandArgs('scroll', []), { direction: 'down', px: undefined });
  assert.deepEqual(commandArgs('upload', ['e1', 'a.png', 'b.png']), { ref: 'e1', files: ['a.png', 'b.png'] });
  assert.deepEqual(commandArgs('eval', ['1', '+', '1']), { js: '1 + 1' });
  assert.deepEqual(commandArgs('dialog', ['dismiss', 'bye', 'now']), { decision: 'dismiss', text: 'bye now' });
  assert.deepEqual(commandArgs('dialog', ['accept']), { decision: 'accept', text: undefined });
  assert.deepEqual(commandArgs('open', ['https://a.test']), { url: 'https://a.test', newTab: false });
});

test('the usage text lists one command per line and covers the real surface', () => {
  for (const spec of [
    '  open URL [--new-tab]',
    '  snapshot [--interactive] [--max-chars N]',
    '  click REF | --xy X Y [--double] [--right]',
    '  type REF TEXT [--clear] [--submit]',
    '  press KEY',
    '  select REF VALUE',
    '  hover REF',
    '  scroll [up|down|left|right] [PX] [--ref REF]',
    '  upload REF FILE...',
    '  screenshot [OUT] [--full] [--ref REF]',
    '  text [--ref REF] [--max-chars N]',
    '  eval JS',
    '  wait [--text T] [--selector CSS] [--load] [--idle] [--ms N] [--timeout S]',
    '  back | forward | reload',
    '  tabs | tab TARGET | close [TARGET]',
    '  dialog accept|dismiss [TEXT]',
    '  ping',
    '  attach NAME --cdp-url http://127.0.0.1:PORT',
    '  stop [NAME|--all] [--keep-chrome]',
  ]) {
    assert.ok(USAGE.split('\n').some(line => line === spec || line.startsWith(`${spec}  `)),
      `usage is missing the line ${JSON.stringify(spec)}`);
  }
  // Two commands used to be squeezed onto one line, which hid both the trailing
  // flags and the description; the pairs below must never come back.
  for (const [first, second] of [['hover REF', 'scroll ['], ['upload REF', 'screenshot ['], ['eval JS', 'text ['], ['reload', 'tabs |']]) {
    for (const line of USAGE.split('\n')) {
      assert.equal(line.includes(first) && line.includes(second), false, `columns merged: ${line}`);
    }
  }
});

test('page commands and lifecycle commands stay disjoint', () => {
  for (const command of ['open', 'snapshot', 'click', 'type', 'press', 'select', 'hover', 'scroll',
    'upload', 'screenshot', 'text', 'eval', 'wait', 'back', 'forward', 'reload', 'tabs', 'tab',
    'close', 'dialog']) {
    assert.ok(PAGE_COMMANDS.includes(command), `${command} must be a page command`);
  }
  for (const command of ['doctor', 'profiles', 'start', 'login', 'attach', 'status', 'stop', 'ping']) {
    assert.equal(PAGE_COMMANDS.includes(command), false, `${command} must not be a page command`);
  }
});

test('state, profile and socket paths honour the documented overrides', () => {
  const previous = { data: process.env.MULTICC_DATA_DIR, profiles: process.env.MBROWSER_PROFILES_DIR };
  // A deliberately short state root: this case asserts the socket stays with the
  // rest of the runtime state, so the path must fit in sun_path on its own.
  const data = path.join('/tmp', `mb-cli-${process.pid}`);
  const profiles = path.join(TEMP, 'paths-profiles');
  process.env.MULTICC_DATA_DIR = data;
  process.env.MBROWSER_PROFILES_DIR = profiles;
  try {
    assert.equal(P.stateDir(), path.join(data, 'browser'));
    assert.equal(P.runDir(), path.join(data, 'browser', 'run'));
    assert.equal(P.profileConfigDir(), path.join(data, 'browser', 'profiles'));
    assert.equal(P.statePath('work'), path.join(data, 'browser', 'run', 'work.json'));
    assert.equal(P.profileDir('work'), path.join(profiles, 'work'));
    assert.equal(P.defaultProfileRoot(), profiles);
    const socket = path.join(data, 'browser', 'run', 'work.sock');
    assert.ok(Buffer.byteLength(socket) <= P.SOCKET_PATH_MAX);
    assert.equal(P.socketPath('work'), socket);

    // A deep state dir would blow the 104-byte sun_path limit, so the socket has
    // to move to a short tmpdir path instead of failing to bind.
    process.env.MULTICC_DATA_DIR = path.join(TEMP, 'd'.repeat(120));
    const deep = P.socketPath('work');
    assert.equal(path.dirname(deep), P.shortSocketDir());
    assert.ok(Buffer.byteLength(deep) <= P.SOCKET_PATH_MAX, `${deep} is too long for a unix socket`);
    assert.match(path.basename(deep), /^[0-9a-f]{16}\.sock$/);
    assert.equal(P.socketPath('work'), deep, 'the hashed socket path is stable');
    assert.notEqual(P.socketPath('other'), deep, 'each profile gets its own socket');
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    if (previous.data === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previous.data;
    if (previous.profiles === undefined) delete process.env.MBROWSER_PROFILES_DIR;
    else process.env.MBROWSER_PROFILES_DIR = previous.profiles;
  }
});

test('profile names are validated, and state files are private and atomic', () => {
  for (const name of ['a', 'work', 'work-1', 'A_b-9', 'x'.repeat(64)]) assert.equal(P.requireName(name), name);
  for (const name of ['', ' ', '../evil', 'a/b', '-lead', '.dot', 'x'.repeat(65), 'a b', null, 7]) {
    assert.throws(() => P.requireName(name), error => error.code === 'usage', `${name} must be rejected`);
  }
  const previous = process.env.MULTICC_DATA_DIR;
  process.env.MULTICC_DATA_DIR = path.join(TEMP, 'store-state');
  try {
    P.ensureStateDirs();
    const file = P.statePath('work');
    P.writeJson(file, { hello: 'world' });
    assert.deepEqual(P.readJson(file, null), { hello: 'world' });
    // eslint-disable-next-line no-bitwise
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(path.dirname(file)).some(entry => entry.includes('.tmp-')), false,
      'no half-written temporary file is left behind');
    assert.deepEqual(P.readJson(path.join(TEMP, 'missing.json'), { fallback: true }), { fallback: true });
    assert.equal(P.removeFile(file), true);
    assert.equal(P.removeFile(file), false);
  } finally {
    if (previous === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previous;
  }
});

test('--help and --version succeed; usage failures exit 2', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: mbrowser <command>/);
  assert.equal(run(['help']).status, 0);

  const version = run(['--version']);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^mbrowser [0-9a-f]{12} \(node v\d+/);
  assert.equal(version.stdout.trim().includes('\n'), false);

  const noArgs = run([]);
  assert.equal(noArgs.status, 2);
  assert.match(noArgs.stdout, /^usage: mbrowser/);

  const unknown = run(['bogus']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command "bogus"/);
  assert.match(unknown.stderr, /usage: mbrowser/);

  const unknownFlag = run(['open', '--headlesss', 'https://a.test']);
  assert.equal(unknownFlag.status, 2);
  assert.match(unknownFlag.stderr, /unknown flag --headlesss/);

  const badName = run(['status', '../evil']);
  assert.equal(badName.status, 2);
  assert.match(badName.stderr, /invalid profile name/);
});

test('lifecycle commands that need no daemon report instead of failing', () => {
  const status = run(['status', 'ghost']);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /profile ghost: daemon down/);

  const stop = run(['stop', 'ghost']);
  assert.equal(stop.status, 0);
  assert.match(stop.stdout, /profile ghost: already stopped/);

  const missing = run(['start', 'ghost']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not_created/);
  assert.match(missing.stderr, /--create/);
  assert.equal(fs.existsSync(path.join(CHILD_ENV.MULTICC_DATA_DIR, 'browser', 'profiles', 'ghost.json')), false,
    'a refused start writes no profile config');

  const unattached = run(['attach', 'ghost']);
  assert.equal(unattached.status, 2);
  assert.match(unattached.stderr, /attach needs --cdp-url/);

  const remote = run(['attach', 'ghost', '--cdp-url', 'http://10.1.2.3:9222']);
  assert.equal(remote.status, 2);
  assert.match(remote.stderr, /loopback/);
  assert.equal(fs.existsSync(path.join(CHILD_ENV.MULTICC_DATA_DIR, 'browser', 'profiles', 'ghost.json')), false,
    'a rejected attach writes no profile config');
});

test('a page command never mints a profile just because -p was mistyped', () => {
  const stateFile = path.join(CHILD_ENV.MULTICC_DATA_DIR, 'browser', 'profiles', 'ghost2.json');
  const profileDir = path.join(CHILD_ENV.MBROWSER_PROFILES_DIR, 'ghost2');

  const evalRun = run(['eval', '1+1', '-p', 'ghost2']);
  assert.equal(evalRun.status, 1, evalRun.stdout);
  assert.match(evalRun.stderr, /not_created/);
  assert.match(evalRun.stderr, /--create/);
  assert.equal(fs.existsSync(stateFile), false, 'no profile config is written');
  assert.equal(fs.existsSync(profileDir), false, 'no user-data-dir is created');
  assert.equal(evalRun.stdout.includes('tab'), false, 'no daemon ever answered');

  // `ping` starts a daemon too, so it is held to the same rule.
  const pingRun = run(['ping', '-p', 'ghost2']);
  assert.equal(pingRun.status, 1);
  assert.match(pingRun.stderr, /does not exist/);
  assert.equal(fs.existsSync(profileDir), false);

  // A value flag with nothing to consume is a usage error, not `true`.
  const bareRef = run(['click', '--ref', '-p', 'ghost2']);
  assert.equal(bareRef.status, 2);
  assert.match(bareRef.stderr, /flag --ref needs a value/);
  assert.equal(parseArgs(['--ref', 'e1', '-p', 'work']).flags.ref, 'e1');
  assert.throws(() => parseArgs(['--ref', '-p', 'work']),
    error => error.code === 'usage' && /flag --ref needs a value/.test(error.message),
    'a following -p is a flag, not the ref');

  const bareOut = run(['screenshot', '--out', '--json']);
  assert.equal(bareOut.status, 2);
  assert.match(bareOut.stderr, /flag --out needs a value/);

  const bareText = run(['wait', '--text']);
  assert.equal(bareText.status, 2);
  assert.match(bareText.stderr, /flag --text needs a value/);

  // `--` still hands dashes to the positional arguments untouched.
  assert.equal(parseArgs(['type', 'e1', '--', '--weird text']).positional.join('|'),
    'type|e1|--weird text');
});

test('a daemon running older code is retired with keepChrome, not left in place', async () => {
  const net = require('node:net');
  const client = require(path.join(ROOT, 'skills', 'multicc-browser', 'lib', 'client'));
  const previous = { data: process.env.MULTICC_DATA_DIR, profiles: process.env.MBROWSER_PROFILES_DIR };
  process.env.MULTICC_DATA_DIR = CHILD_ENV.MULTICC_DATA_DIR;
  process.env.MBROWSER_PROFILES_DIR = CHILD_ENV.MBROWSER_PROFILES_DIR;
  const name = 'stale';
  const socketPath = P.socketPath(name);
  const seen = [];
  let version = 'old-version';
  // Stands in for the resident daemon: answers pings with `version`, and on
  // shutdown drops its socket and comes back as the replacement.
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const request = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        seen.push(request);
        const reply = request.cmd === 'shutdown'
          ? { id: request.id, ok: true, result: { stopping: true, keepChrome: true } }
          : { id: request.id, ok: true, result: { pong: true, version, pid: process.pid } };
        socket.end(`${JSON.stringify(reply)}\n`);
        if (request.cmd === 'shutdown') {
          version = 'new-version';
          server.close(() => {
            try { fs.unlinkSync(socketPath); } catch (_) { /* ignore */ }
            server.listen(socketPath);
          });
        }
      }
    });
  });
  try {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    await new Promise(resolve => { server.listen(socketPath, resolve); });
    const spawned = [];
    const spawn = (childName, options) => { spawned.push({ name: childName, options }); return process.pid; };

    const ping = await client.ensureDaemon(name, { version: 'new-version', spawn });
    assert.equal(spawned.length, 1, 'the stale daemon is replaced');
    const shutdown = seen.find(request => request.cmd === 'shutdown');
    assert.equal(shutdown.args.keepChrome, true, 'chrome is kept so the replacement re-attaches to the same browser');
    assert.equal(ping.version, 'new-version');
    assert.equal(ping.pong, true);

    const again = await client.ensureDaemon(name, { version: 'new-version', spawn });
    assert.equal(again.version, 'new-version');
    assert.equal(spawned.length, 1, 'a daemon already on this version is reused as is');
  } finally {
    await new Promise(resolve => { server.close(resolve); });
    try { fs.unlinkSync(socketPath); } catch (_) { /* ignore */ }
    if (previous.data === undefined) delete process.env.MULTICC_DATA_DIR;
    else process.env.MULTICC_DATA_DIR = previous.data;
    if (previous.profiles === undefined) delete process.env.MBROWSER_PROFILES_DIR;
    else process.env.MBROWSER_PROFILES_DIR = previous.profiles;
  }
});

test('--json emits a single machine-readable document', () => {
  const profiles = run(['profiles', '--json']);
  assert.equal(profiles.status, 0);
  const parsed = JSON.parse(profiles.stdout);
  assert.deepEqual(parsed.profiles, []);
  assert.equal(typeof parsed.text, 'string');

  const doctor = run(['doctor', '--json']);
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.os.platform, process.platform);
  assert.equal(typeof report.version, 'string');
  assert.ok(Array.isArray(report.candidates));
  assert.equal(report.profiles.length, 0);

  const text = run(['doctor']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`state: ${CHILD_ENV.MULTICC_DATA_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(text.stdout, new RegExp(`profiles-root: ${CHILD_ENV.MBROWSER_PROFILES_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});
