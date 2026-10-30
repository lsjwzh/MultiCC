'use strict';

// Resident plugins and notification channels (src/plugins/channel-host.js and
// its wiring in src/routes/plugins.js):
//   • a plugin whose manifest says engine.resident is started once as `<binary> serve`
//     and the panel's run commands go to that process instead of a fresh spawn;
//   • a crash is restarted with backoff, and a plugin that stays down is reported
//     once (plugin-down) through the host's alert hook, resolved when it is back;
//   • alerts the plugin raises reach the alert hook once per key until resolved;
//   • removing the plugin stops it for good; changing its binary restarts it;
//   • channel plugins list their targets; non-resident plugins are untouched.
// The fake plugin is a Node script; nothing here touches a real app.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createChannelHost } = require('../src/plugins/channel-host');
const { createPluginsRoutes } = require('../src/routes/plugins');

const SKIP = process.platform === 'win32' ? 'the fake plugin is a #! script' : false;

const FAKE = `#!${process.execPath}
'use strict';
const fs = require('fs');
const path = require('path');
const mode = process.argv[2];
const dataDir = process.env.MULTICC_PLUGIN_DATA_DIR || '';
if (mode !== 'serve') {
  let input = '';
  process.stdin.on('data', chunk => { input += chunk; }).on('end', () => {
    process.stdout.write(JSON.stringify({ ok: true, data: { oneShot: true, command: mode } }) + '\\n');
  });
  return;
}
if (dataDir && fs.existsSync(path.join(dataDir, 'crash-on-start'))) process.exit(3);
const out = message => process.stdout.write(JSON.stringify(message) + '\\n');
out({ event: 'hello', protocol: 1, version: process.env.FAKE_VERSION || '1.0.0' });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.type === 'targets') out({ id: message.id, ok: true, data: { targets: [{ id: 'tgt_me', name: '我', status: 'active' }] } });
    if (message.type !== 'run') continue;
    const input = message.input || {};
    if (message.command === 'ping') out({ id: message.id, ok: true, data: { pong: true, pid: process.pid, env: { id: process.env.MULTICC_PLUGIN_ID, base: process.env.MULTICC_BASE_URL || null, dataDir } } });
    if (message.command === 'fail') out({ id: message.id, ok: false, error: 'nope' });
    if (message.command === 'crash') process.exit(9);
    if (message.command === 'alert') { out({ event: 'alert', key: input.key, level: input.level, title: 'Problem ' + input.key, body: 'details', replay: input.replay === true }); out({ id: message.id, ok: true, data: {} }); }
    if (message.command === 'resolve') { out({ event: 'alert', key: input.key, resolved: true }); out({ id: message.id, ok: true, data: {} }); }
    // 'hang' never answers
  }
});
process.stdin.on('end', () => process.exit(0));
`;

function makePlugin(root, id, { resident = true, channel = { label: 'Fake' }, version = '1.0.0' } = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    schema: 1, id, name: `Plugin ${id}`, version,
    engine: { type: 'command', binary: 'bin/fake', ...(resident ? { resident: true } : {}) },
    ...(channel ? { channel } : {}),
    commands: ['ping', 'fail', 'crash', 'hang', 'alert', 'resolve'],
  }));
  fs.writeFileSync(path.join(dir, 'bin', 'fake'), FAKE, { mode: 0o755 });
  return dir;
}

const quiet = { info() {}, warn() {} };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, { timeout = 5000, step = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await sleep(step);
  }
}

function setup(t, { overrides = {}, plugins = [['demo-channel', {}]] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-channel-host-'));
  const builtin = path.join(root, 'builtin');
  const user = path.join(root, 'home', 'plugins');
  fs.mkdirSync(builtin, { recursive: true });
  fs.mkdirSync(user, { recursive: true });
  for (const [id, options] of plugins) makePlugin(user, id, options);
  const alerts = [];
  const routes = createPluginsRoutes({
    pluginsDir: builtin, userPluginsDir: user, platform: process.platform, arch: process.arch, logger: quiet,
    resident: {
      baseUrl: () => 'http://127.0.0.1:4321',
      alert: alert => alerts.push(alert),
      overrides: { backoffMs: [50, 100], downAlertMs: 300, healthyAfterMs: 60_000, rescanMs: 60_000, stopGraceMs: 200, ...overrides },
    },
  });
  t.after(() => {
    routes.channelHost.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, user, routes, host: routes.channelHost, alerts };
}

const ready = (host, id = 'demo-channel') => until(() => host.status().find(item => item.id === id && item.ready));

test('a resident plugin is started once; run goes to the resident process with its data dir and the server address', { skip: SKIP }, async t => {
  const { routes, host, root } = setup(t);
  const first = await ready(host);
  assert.equal(first.running, true);
  assert.deepEqual(first.channel, { label: 'Fake', labelEn: null, platforms: null });
  const one = await routes.runPluginCommand('demo-channel', 'ping', {});
  const two = await routes.runPluginCommand('demo-channel', 'ping', {});
  assert.equal(one.status, 200);
  assert.equal(one.payload.pid, two.payload.pid, 'both calls reach the same process');
  assert.equal(one.payload.pid, first.pid);
  assert.deepEqual(one.payload.env, {
    id: 'demo-channel', base: 'http://127.0.0.1:4321', dataDir: path.join(root, 'home', 'plugins-data', 'demo-channel'),
  });
  const failed = await routes.runPluginCommand('demo-channel', 'fail', {});
  assert.deepEqual(failed, { status: 400, payload: { error: 'nope' } });
  const unlisted = await routes.runPluginCommand('demo-channel', 'rm-rf', {});
  assert.equal(unlisted.status, 400, 'the command whitelist still applies');
});

test('a command the plugin never answers times out without wedging the next one', { skip: SKIP }, async t => {
  const { routes, host } = setup(t, { overrides: { requestTimeoutMs: 200 } });
  await ready(host);
  const hung = await routes.runPluginCommand('demo-channel', 'hang', {});
  assert.equal(hung.status, 504);
  assert.equal((await routes.runPluginCommand('demo-channel', 'ping', {})).status, 200);
});

test('a crash is restarted with backoff; the call in flight fails cleanly', { skip: SKIP }, async t => {
  const { routes, host } = setup(t);
  const before = await ready(host);
  const crashed = await routes.runPluginCommand('demo-channel', 'crash', {});
  assert.equal(crashed.status, 503);
  const after = await until(() => {
    const item = host.status().find(entry => entry.id === 'demo-channel');
    return item.ready && item.pid !== before.pid && item;
  });
  assert.equal(after.restarts, 1);
  assert.equal(after.lastExit.code, 9);
  assert.equal((await routes.runPluginCommand('demo-channel', 'ping', {})).payload.pid, after.pid);
});

test('a plugin that stays down is reported once, and the report clears when it comes back', { skip: SKIP }, async t => {
  const { routes, host, alerts, user } = setup(t);
  await ready(host);
  const dataDir = path.join(user, '..', 'plugins-data', 'demo-channel');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'crash-on-start'), '');
  await routes.runPluginCommand('demo-channel', 'crash', {});
  await until(() => alerts.find(alert => alert.key === 'plugin-down'));
  await sleep(400);
  assert.equal(alerts.filter(alert => alert.key === 'plugin-down').length, 1, 'reported once while it keeps crashing');
  const down = host.status().find(entry => entry.id === 'demo-channel');
  assert.equal(down.ready, false);
  assert.ok(down.restarts >= 2);
  assert.equal(down.alerts[0].key, 'plugin-down');
  assert.equal(down.alerts[0].level, 'critical');
  fs.rmSync(path.join(dataDir, 'crash-on-start'));
  const back = await until(() => {
    const item = host.status().find(entry => entry.id === 'demo-channel');
    return item.ready && item;
  });
  assert.deepEqual(back.alerts, [], 'recovering resolves plugin-down');
});

test('plugin alerts reach the alert hook once per key until resolved', { skip: SKIP }, async t => {
  const { routes, host, alerts } = setup(t);
  await ready(host);
  await routes.runPluginCommand('demo-channel', 'alert', { key: 'agent-permissions', level: 'critical' });
  await routes.runPluginCommand('demo-channel', 'alert', { key: 'agent-permissions', level: 'critical' });
  await routes.runPluginCommand('demo-channel', 'alert', { key: 'bad key with spaces' });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].source, 'demo-channel');
  assert.equal(alerts[0].sourceName, 'Plugin demo-channel');
  assert.equal(alerts[0].level, 'critical');
  assert.equal(alerts[0].title, 'Problem agent-permissions');
  assert.equal(host.status()[0].alerts.length, 1, 'the page can show what is still wrong');
  await routes.runPluginCommand('demo-channel', 'resolve', { key: 'agent-permissions' });
  assert.equal(host.status()[0].alerts.length, 0);
  await routes.runPluginCommand('demo-channel', 'alert', { key: 'agent-permissions', level: 'warn' });
  assert.equal(alerts.length, 2, 'it may be raised again after it recovered');
  await routes.runPluginCommand('demo-channel', 'alert', { key: 'wechat-login', replay: true });
  assert.equal(alerts.length, 2, 'a replayed alert was pushed before the restart: shown, not pushed again');
  assert.deepEqual(host.status()[0].alerts.map(alert => alert.key), ['agent-permissions', 'wechat-login']);
});

test('channel targets are collected from running channel plugins only', { skip: SKIP }, async t => {
  const { host } = setup(t, { plugins: [['demo-channel', {}], ['quiet-helper', { channel: null }]] });
  await ready(host);
  await ready(host, 'quiet-helper');
  const channels = await host.targets();
  assert.deepEqual(channels, [{
    plugin: 'demo-channel', name: 'Plugin demo-channel', label: 'Fake', labelEn: null, ready: true,
    targets: [{ id: 'tgt_me', name: '我', status: 'active' }],
  }]);
});

test('removing the plugin stops it for good; replacing its binary restarts it', { skip: SKIP }, async t => {
  const { routes, host, user } = setup(t);
  const first = await ready(host);
  const binary = path.join(user, 'demo-channel', 'bin', 'fake');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(binary, later, later);
  host.reconcile();
  const replaced = await until(() => {
    const item = host.status().find(entry => entry.id === 'demo-channel');
    return item && item.ready && item.pid !== first.pid && item;
  });
  assert.equal(replaced.restarts, 0, 'a deliberate restart is not a crash');
  fs.rmSync(path.join(user, 'demo-channel'), { recursive: true, force: true });
  host.reconcile();
  assert.deepEqual(host.status(), []);
  await until(() => { try { process.kill(replaced.pid, 0); return false; } catch (_) { return true; } });
  assert.equal((await routes.runPluginCommand('demo-channel', 'ping', {})).status, 404);
});

test('a resident plugin that cannot run here is listed with the reason and never spawned', { skip: SKIP }, async t => {
  const { host, routes } = setup(t, { plugins: [['elsewhere', { channel: { label: 'X', platforms: ['plan9'] } }]] });
  host.reconcile();
  assert.deepEqual(host.status().map(item => [item.id, item.unsupported, item.running]), [['elsewhere', 'platform', false]]);
  const result = await routes.runPluginCommand('elsewhere', 'ping', {});
  assert.equal(result.status, 503);
});

test('non-resident plugins keep the one-shot spawn, and no host runs without the resident option', { skip: SKIP }, async t => {
  const { routes } = setup(t, { plugins: [['oneshot', { resident: false, channel: null }]] });
  const result = await routes.runPluginCommand('oneshot', 'ping', {});
  assert.deepEqual(result, { status: 200, payload: { oneShot: true, command: 'ping' } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-channel-none-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plain = createPluginsRoutes({ pluginsDir: root, platform: process.platform, arch: process.arch, logger: quiet });
  assert.equal(plain.channelHost, null);
});

test('the host requires its dependencies', () => {
  assert.throws(() => createChannelHost({}), /discover is required/);
});
