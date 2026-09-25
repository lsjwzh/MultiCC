'use strict';

// com.multicc.agent: build through the real installer (temp paths, launchctl
// off), then run `serve` and drive it with the client. Clicks and captures are
// not exercised — they depend on grants and would move the real pointer — but
// every refusal path and the Chrome watchdog are. macOS with Swift only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const INSTALLER = path.join(__dirname, '..', 'scripts', 'install-agent.sh');
const hasSwift = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc']).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tiered platform support: macOS 11 is the floor and its newest toolchain is
// Swift 5.5, so code OUTSIDE a `#if compiler(>=5.6+)` gate must stay 5.5
// syntax (the local compiler cannot catch that — hence this scan). Code inside
// such a gate is compiled only by newer toolchains and may use anything.
// Newer APIs are caught by the build itself (deployment target 11.0).
test('agent + scroll sources: ungated code stays Swift 5.5 compatible (macOS 11 floor)', () => {
  const sources = [
    path.join(__dirname, '..', 'scripts', 'macos-agent', 'MultiCCAgent.swift'),
    path.join(__dirname, '..', 'skills', 'multicc-computer-use', 'scripts', 'scroll.swift'),
  ];
  const rules = [
    // if let x { / guard let x else / , let x { — Swift 5.7 shorthand bindings
    [/\b(?:if|guard|while)\b[^=\n]*?\b(?:let|var) [A-Za-z_]\w*\s*(?:,|\{|else\b)/, 'optional binding shorthand (5.7)'],
    [/(?:=|return)\s*(?:if|switch)\s/, 'if/switch expression (5.9)'],
    [/#unavailable|\bany [A-Z]\w*[\s,)>\]]|\bconsume\b|\bborrowing\b|\bconsuming\b/, 'Swift 5.6+ keyword'],
    [/#\/|\bRegex</, 'regex literal (5.7)'],
  ];
  for (const file of sources) {
    const gate = [];   // one entry per open #if: true when it requires a compiler newer than 5.5
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const directive = line.trim();
      if (/^#if\b/.test(directive)) {
        const m = directive.match(/compiler\(>=\s*(\d+)\.(\d+)/);
        gate.push(!!m && (Number(m[1]) > 5 || (Number(m[1]) === 5 && Number(m[2]) > 5)));
        return;
      }
      if (/^#endif\b/.test(directive)) { gate.pop(); return; }
      if (gate.some(Boolean)) return;
      const code = line.replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
      for (const [re, what] of rules) {
        assert.ok(!re.test(code), `${path.basename(file)}:${i + 1} uses ${what}: ${line.trim()}`);
      }
    });
  }
});

test('agent: installer build, client/server protocol and chrome watchdog', { skip: !hasSwift, timeout: 240000 }, async (t) => {
  const root = fs.mkdtempSync(path.join('/tmp', 'mcagent-'));
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    MULTICC_AGENT_APP: path.join(root, 'MultiCC Agent.app'),
    MULTICC_AGENT_PLIST: path.join(root, 'agent.plist'),
    MULTICC_AGENT_DIR: path.join(root, 'd'),
    MULTICC_AGENT_LINK: path.join(root, 'bin', 'multicc-agent'),
    MULTICC_AGENT_NO_LAUNCHCTL: '1',
    // Ad-hoc: a test must not reach into the developer's keychain.
    MULTICC_AGENT_SIGN_IDENTITY: '-',
  };
  const bin = path.join(env.MULTICC_AGENT_APP, 'Contents/MacOS/MultiCCAgent');

  execFileSync('/bin/sh', [INSTALLER, 'install'], { env });
  const firstBuild = fs.statSync(bin).mtimeMs;
  assert.match(execFileSync('/usr/bin/vtool', ['-show-build', bin], { encoding: 'utf8' }), /minos 11\.0/);
  assert.equal(fs.statSync(env.MULTICC_AGENT_DIR).mode & 0o777, 0o700);
  assert.match(spawnSync('/usr/bin/codesign', ['-dv', env.MULTICC_AGENT_APP], { encoding: 'utf8' }).stderr, /Identifier=com\.multicc\.agent/);
  const out = execFileSync('/bin/sh', [INSTALLER, 'install'], { env, encoding: 'utf8' });
  assert.match(out, /binary up to date/);
  assert.match(out, /requirement cdhash/);
  assert.equal(fs.statSync(bin).mtimeMs, firstBuild, 'reinstall must not rebuild (would revoke grants)');
  const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', env.MULTICC_AGENT_PLIST], { encoding: 'utf8' }));
  assert.deepEqual(plist.LimitLoadToSessionType, ['Aqua']);
  assert.equal(plist.AbandonProcessGroup, true);

  // Watchdog against a port nothing listens on, with a launch script that
  // only leaves a marker, starting paused.
  const marker = path.join(root, 'launched');
  const launch = path.join(root, 'launch.sh');
  fs.writeFileSync(launch, `#!/bin/bash\necho x >> '${marker}'\n`);
  fs.writeFileSync(path.join(env.MULTICC_AGENT_DIR, 'config.json'),
    JSON.stringify({ chrome: { enabled: true, port: 9, launch } }));
  const pause = path.join(env.MULTICC_AGENT_DIR, 'chrome.pause');
  fs.writeFileSync(pause, '');

  const server = spawn(bin, ['serve'], { env: { ...env, MULTICC_AGENT_CHROME_INTERVAL: '0.2' }, stdio: 'ignore' });
  t.after(() => server.kill());
  const call = (...args) => {
    const r = spawnSync(bin, args, { env, encoding: 'utf8' });
    return { code: r.status, body: JSON.parse(r.stdout.trim().split('\n').pop()) };
  };
  for (let i = 0; i < 50 && !fs.existsSync(path.join(env.MULTICC_AGENT_DIR, 'agent.sock')); i++) await sleep(100);
  assert.equal(fs.statSync(path.join(env.MULTICC_AGENT_DIR, 'agent.sock')).mode & 0o777, 0o600);

  assert.equal(call('ping').body.ok, true);
  assert.deepEqual(call('call', '{"op":"rm"}'), { code: 1, body: { ok: false, error: 'unknown op: rm' } });
  assert.equal(call('snap', '/tmp/../etc/x.png').body.ok, false);
  assert.equal(call('snap', 'rel.png').body.ok, false);
  assert.equal(call('call', '{"op":"type","text":""}').body.ok, false);

  // Chords parse against the ported Peekaboo key table without posting anything.
  assert.deepEqual(call('call', '{"op":"press","keys":"cmd+shift+g","dryRun":true}').body,
    { ok: true, keyCode: 5, flags: 0x120000, key: 'g' });
  assert.equal(call('call', '{"op":"press","keys":"cmd+,","dryRun":true}').body.key, 'comma');
  assert.match(call('call', '{"op":"press","keys":"cmd+foo","dryRun":true}').body.error, /unknown key: foo/);
  assert.match(call('call', '{"op":"press","keys":"a+b","dryRun":true}').body.error, /more than one/);
  // Element ops without a snapshot are refused before anything is sent.
  for (const args of [['click-el', 'elem_1'], ['set', 'elem_1', 'x'], ['click-text', 'Save']]) {
    const r = call(...args);
    assert.equal(r.code, 1);
    assert.equal(r.body.outcome, 'refused');
    assert.equal(r.body.dispatched, 'none');
  }
  // Background cmd+q would silently quit an app the user cannot see.
  const bg = call('call', '{"op":"press","keys":"cmd+q","pid":1}').body;
  assert.equal(bg.reason, 'dangerous-background-hotkey');
  assert.equal(call('resume').body.ok, true);
  const status = call('status').body;
  assert.equal(status.version, '2');
  assert.equal(typeof status.screenLocked, 'boolean');
  // Platform tiers: the legacy capture backend is always available as the
  // last resort; newer ones are listed first when this OS/build has them.
  assert.equal(status.platform.captureBackends.at(-1), 'screencapture');
  assert.match(status.platform.os, /^\d+\.\d+\.\d+$/);
  assert.equal(status.platform.settingsApp,
    Number(status.platform.os.split('.')[0]) >= 13 ? 'System Settings' : 'System Preferences');
  assert.match(call('call', '{"op":"snap","path":"/tmp/x.png","backend":"nope"}').body.error,
    /not available|screen-recording-not-granted/);
  assert.equal(status.control.halted, false);

  await sleep(1200);
  assert.ok(!fs.existsSync(marker), 'paused watchdog never launches');
  let chrome = call('status').body.chrome;
  assert.equal(chrome.paused, true);
  assert.ok(chrome.misses >= 2);

  fs.rmSync(pause);
  for (let i = 0; i < 30 && !fs.existsSync(marker); i++) await sleep(100);
  await sleep(800);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'x\n', 'launched exactly once (90s back-off)');
  chrome = call('status').body.chrome;
  assert.equal(chrome.launches, 1);
  assert.match(chrome.lastLaunchResult, /^exit 0/);

  server.kill();
  await sleep(200);
  assert.equal(call('ping').code, 3, 'client reports agent-not-running');

  execFileSync('/bin/sh', [INSTALLER, 'uninstall'], { env });
  assert.ok(!fs.existsSync(env.MULTICC_AGENT_APP) && !fs.existsSync(env.MULTICC_AGENT_PLIST));
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Auto-provisioning: installing/updating MultiCC installs/updates the agent ──
const { createMacosAgentProvisioner } = require('../src/macos-agent-provision');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { MACOS_AGENT_FILES } = require('../scripts/desktop-bundle-server');

function provisionFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-prov-'));
  const root = path.join(tmp, 'root');
  fs.mkdirSync(path.join(root, 'scripts', 'macos-agent'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'install-agent.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(root, 'scripts', 'macos-agent', 'MultiCCAgent.swift'), '// v1\n');
  const env = {
    MULTICC_AGENT_APP: path.join(tmp, 'MultiCC Agent.app'),
    MULTICC_AGENT_PLIST: path.join(tmp, 'agent.plist'),
    MULTICC_AGENT_DIR: path.join(tmp, 'agent'),
  };
  const installed = (source) => {
    const res = path.join(env.MULTICC_AGENT_APP, 'Contents', 'Resources');
    fs.mkdirSync(path.join(env.MULTICC_AGENT_APP, 'Contents', 'MacOS'), { recursive: true });
    fs.mkdirSync(res, { recursive: true });
    fs.writeFileSync(path.join(env.MULTICC_AGENT_APP, 'Contents', 'MacOS', 'MultiCCAgent'), '');
    fs.writeFileSync(path.join(res, 'source.sha256'), `${crypto.createHash('sha256').update(source).digest('hex')}\n`);
    fs.writeFileSync(env.MULTICC_AGENT_PLIST, '');
  };
  const calls = [];
  const exits = { install: 0, 'request-permissions': 0 };
  const spawnFake = (file, args) => {
    const sub = args[args.length - 1];
    calls.push([path.basename(file), sub]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => { child.stdout.emit('data', `ran ${sub}\n`); child.emit('close', exits[sub]); });
    return child;
  };
  const logs = [];
  const make = (over = {}) => createMacosAgentProvisioner({
    rootDir: root, home: tmp, platform: 'darwin', env, spawn: spawnFake,
    logger: { log: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) }, ...over,
  });
  return { tmp, root, env, installed, calls, exits, logs, make };
}

test('agent provisioning: decides install / update / skip from what is on disk', () => {
  const f = provisionFixture();
  assert.deepEqual(f.make({ platform: 'linux' }).plan(), { action: 'skip', reason: 'not-macos' });
  assert.equal(f.make({ env: { ...f.env, MULTICC_AGENT_AUTO_INSTALL: '0' } }).plan().reason, 'disabled-by-env');
  assert.equal(f.make({ rootDir: path.join(f.tmp, 'nowhere') }).plan().reason, 'installer-not-shipped');
  assert.deepEqual(f.make().plan(), { action: 'install', reason: 'not-installed' });
  f.installed('// v1\n');
  assert.deepEqual(f.make().plan(), { action: 'skip', reason: 'up-to-date' });
  fs.writeFileSync(path.join(f.root, 'scripts', 'macos-agent', 'MultiCCAgent.swift'), '// v2\n');
  assert.deepEqual(f.make().plan(), { action: 'update', reason: 'source-changed' });
  f.installed('// v2\n');
  fs.rmSync(f.env.MULTICC_AGENT_PLIST);
  assert.deepEqual(f.make().plan(), { action: 'update', reason: 'launch-agent-missing' });
  fs.mkdirSync(f.env.MULTICC_AGENT_DIR, { recursive: true });
  fs.writeFileSync(path.join(f.env.MULTICC_AGENT_DIR, 'auto-install-disabled'), '');
  assert.equal(f.make().plan().reason, 'uninstalled-by-user');
  fs.rmSync(f.tmp, { recursive: true, force: true });
});

test('agent provisioning: runs the installer in the background, asks for grants only on first install, never throws', async () => {
  const f = provisionFixture();
  const p = f.make();
  const [a, b] = [p.ensure(), p.ensure()];
  assert.equal(a, b, 'single-flight');
  const first = await a;
  assert.equal(first.ok, true);
  assert.deepEqual(f.calls, [['sh', 'install'], ['MultiCCAgent', 'request-permissions']]);

  f.calls.length = 0;
  f.installed('// v1\n');
  fs.writeFileSync(path.join(f.root, 'scripts', 'macos-agent', 'MultiCCAgent.swift'), '// v2\n');
  const update = await f.make().ensure();
  assert.equal(update.action, 'update');
  assert.deepEqual(f.calls, [['sh', 'install']], 'an update keeps the existing grants: no prompts');

  f.calls.length = 0;
  f.exits.install = 3;
  const failed = await f.make().ensure();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /ran install/);
  assert.ok(f.logs.some((l) => l.startsWith('WARN') && l.includes('exit 3')));

  const exploding = f.make({ spawn: () => { throw new Error('spawn EACCES'); } });
  assert.equal((await exploding.ensure()).ok, false);
  fs.rmSync(f.tmp, { recursive: true, force: true });
});

test('agent provisioning: packages ship the installer, and the installer prefers a matching prebuilt binary', { skip: process.platform !== 'darwin', timeout: 60000 }, () => {
  for (const file of MACOS_AGENT_FILES) assert.ok(fs.existsSync(path.join(__dirname, '..', file)), file);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-prebuilt-'));
  const prebuilt = path.join(tmp, 'prebuilt');
  fs.mkdirSync(prebuilt);
  // Any Mach-O stands in for the agent; only the copy path is under test.
  fs.copyFileSync('/usr/bin/true', path.join(prebuilt, 'MultiCCAgent'));
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'macos-agent', 'MultiCCAgent.swift'));
  fs.writeFileSync(path.join(prebuilt, 'source.sha256'), `${crypto.createHash('sha256').update(source).digest('hex')}\n`);
  const env = {
    ...process.env,
    MULTICC_AGENT_PREBUILT: prebuilt,
    MULTICC_AGENT_APP: path.join(tmp, 'MultiCC Agent.app'),
    MULTICC_AGENT_PLIST: path.join(tmp, 'agent.plist'),
    MULTICC_AGENT_DIR: path.join(tmp, 'agent'),
    MULTICC_AGENT_LINK: path.join(tmp, 'bin', 'multicc-agent'),
    MULTICC_AGENT_NO_LAUNCHCTL: '1',
    MULTICC_AGENT_SIGN_IDENTITY: '-',
  };
  const out = execFileSync('/bin/sh', [INSTALLER, 'install'], { env, encoding: 'utf8' });
  assert.match(out, /using prebuilt binary/);
  assert.equal(fs.readFileSync(path.join(env.MULTICC_AGENT_APP, 'Contents', 'Resources', 'source.sha256'), 'utf8').trim(),
    fs.readFileSync(path.join(prebuilt, 'source.sha256'), 'utf8').trim());

  // uninstall stops auto-install until the next manual install
  execFileSync('/bin/sh', [INSTALLER, 'uninstall'], { env });
  assert.ok(fs.existsSync(path.join(env.MULTICC_AGENT_DIR, 'auto-install-disabled')));
  execFileSync('/bin/sh', [INSTALLER, 'install'], { env });
  assert.ok(!fs.existsSync(path.join(env.MULTICC_AGENT_DIR, 'auto-install-disabled')));
  fs.rmSync(tmp, { recursive: true, force: true });
});
