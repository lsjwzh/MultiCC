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

test('agent: installer build, client/server protocol and chrome watchdog', { skip: !hasSwift, timeout: 240000 }, async (t) => {
  const root = fs.mkdtempSync(path.join('/tmp', 'mcagent-'));
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    MULTICC_AGENT_APP: path.join(root, 'MultiCC Agent.app'),
    MULTICC_AGENT_PLIST: path.join(root, 'agent.plist'),
    MULTICC_AGENT_DIR: path.join(root, 'd'),
    MULTICC_AGENT_LINK: path.join(root, 'bin', 'multicc-agent'),
    MULTICC_AGENT_NO_LAUNCHCTL: '1',
  };
  const bin = path.join(env.MULTICC_AGENT_APP, 'Contents/MacOS/MultiCCAgent');

  execFileSync('/bin/sh', [INSTALLER, 'install'], { env });
  const firstBuild = fs.statSync(bin).mtimeMs;
  assert.equal(fs.statSync(env.MULTICC_AGENT_DIR).mode & 0o777, 0o700);
  assert.match(spawnSync('/usr/bin/codesign', ['-dv', env.MULTICC_AGENT_APP], { encoding: 'utf8' }).stderr, /Identifier=com\.multicc\.agent/);
  const out = execFileSync('/bin/sh', [INSTALLER, 'install'], { env, encoding: 'utf8' });
  assert.match(out, /up to date \(grants preserved\)/);
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
