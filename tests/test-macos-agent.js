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
