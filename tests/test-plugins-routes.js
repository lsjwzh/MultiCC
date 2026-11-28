'use strict';

// 插件通道（src/routes/plugins.js）的行为契约：
//   • 只有带合法 plugin.json 的目录才算插件（plugins/bridges 这类内部目录天然不收）
//   • command 必须在 manifest.commands 白名单里
//   • spawn 不走 shell、stdin 喂 JSON、stdout 收一行 JSON（{ok,data} / {ok,error}）
//   • 插件 UI 静态树、`GET /api/channels` 与 /api/channels/recheck 已由 Rust 前门独占；
//     Node 只剩回环宿主端口 POST /api/__host/plugins（findPlugin / channelStillActive /
//     channelsStatus，见 plugins-host.js）
//   • git 只跟踪 plugins/ 的内置项：复制进来的插件默认被 .gitignore 忽略
// 桩插件用 node 脚本充当二进制 —— 真正的 Rust 插件（chrome-proxy-launcher）
// 由自己的 cargo test 与端到端验证覆盖，CI 无需 Rust 工具链也能跑这套契约。

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createPluginsRoutes, readManifest, resolveBinary } = require('../src/native/binding').pluginsRoutes;
const { mountPluginsHostRoute, HOST_PATH } = require('../src/routes/plugins-host');

function makeStubPluginsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-plugins-test-'));
  const stub = path.join(dir, 'stub-demo');
  fs.mkdirSync(path.join(stub, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(stub, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(stub, 'plugin.json'), JSON.stringify({
    schema: 1,
    id: 'stub-demo',
    name: 'Stub Demo',
    version: '0.1.0',
    description: 'test stub',
    icon: '🧪',
    engine: { type: 'command', binary: 'bin/stub-demo', binaryPlatformDir: 'bin' },
    commands: ['echo', 'fail'],
    ui: 'ui/index.html',
  }));
  const bin = path.join(stub, 'bin', process.platform === 'win32' ? 'stub-demo.cmd' : 'stub-demo');
  fs.writeFileSync(bin, [
    '#!/usr/bin/env node',
    "'use strict';",
    "const chunks = [];",
    "process.stdin.on('data', c => chunks.push(c));",
    "process.stdin.on('end', () => {",
    "  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');",
    "  const command = process.argv[2];",
    `  if (command === 'echo') { console.log(JSON.stringify({ ok: true, data: { echoed: input } })); process.exit(0); }`,
    `  if (command === 'fail') { console.log(JSON.stringify({ ok: false, error: 'stub boom' })); process.exit(1); }`,
    "  console.log(JSON.stringify({ ok: false, error: 'unknown ' + command })); process.exit(1);",
    '});',
  ].join('\n'));
  fs.chmodSync(bin, 0o755);
  fs.writeFileSync(path.join(stub, 'ui', 'index.html'), '<!DOCTYPE html><title>stub</title>');
  // 无 manifest 的目录（模拟 plugins/bridges 内部模块）：不是插件。
  fs.mkdirSync(path.join(dir, 'bridges'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bridges', 'core.js'), "'use strict';");
  // manifest 里 id 与目录名不一致：拒绝。
  const mismatch = path.join(dir, 'mismatch');
  fs.mkdirSync(mismatch, { recursive: true });
  fs.writeFileSync(path.join(mismatch, 'plugin.json'), JSON.stringify({
    id: 'other-id', engine: { type: 'command', binary: 'bin/x' }, commands: ['a'],
  }));
  // binary 缺失：清单里出现，但 engine.available=false、run 503。
  const noBinary = path.join(dir, 'no-binary');
  fs.mkdirSync(noBinary, { recursive: true });
  fs.writeFileSync(path.join(noBinary, 'plugin.json'), JSON.stringify({
    id: 'no-binary', engine: { type: 'command', binary: 'bin/missing' }, commands: ['a'],
  }));
  return dir;
}

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
  };
}

function makeResponse() {
  const response = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    send(body) { this.body = body; return this; },
  };
  return response;
}

function fixture() {
  const pluginsDir = makeStubPluginsDir();
  const logger = { warn() {}, info() {} };
  const locality = { local: true };
  const runtime = createPluginsRoutes({
    pluginsDir, platform: process.platform, arch: process.arch, logger,
    isLocalRequest: () => locality.local,
  });
  const app = fakeApp();
  runtime.mount(app);
  return { runtime, app, pluginsDir, locality };
}

function hostHandler(app) {
  const handler = app.routes.get(`POST ${HOST_PATH}`);
  assert.equal(typeof handler, 'function', 'the plugins host port must be mounted');
  return handler;
}

function callHost(handler, body) {
  const response = makeResponse();
  handler({ body }, response);
  return response;
}

// 独立挂一份宿主端口：findManifest / stillActive / usage / channelHost 都可注入，
// 用来锁定 op 契约本身。
function hostOnly({
  findManifest = () => null,
  channelRegistry = { stillActive: () => true, usage: () => [] },
  usage,
  channelHost,
} = {}) {
  const app = fakeApp();
  const locality = { local: true };
  mountPluginsHostRoute(app, {
    findManifest, channelRegistry, usage, channelHost, isLocal: () => locality.local,
  });
  return { app, handler: hostHandler(app), locality };
}

test('listPlugins collects only manifest-bearing plugin dirs', () => {
  const { runtime } = fixture();
  const ids = runtime.listPlugins().map(entry => entry.id).sort();
  assert.deepEqual(ids, ['no-binary', 'stub-demo']);
});

test('listPlugins exposes engine availability and command whitelist', () => {
  const { runtime } = fixture();
  const stub = runtime.listPlugins().find(entry => entry.id === 'stub-demo');
  assert.equal(stub.engine.available, true);
  assert.deepEqual(stub.commands, ['echo', 'fail']);
  assert.equal(stub.ui, 'ui/index.html');
});

test('run rejects unknown plugin and off-whitelist command', async () => {
  const { runtime } = fixture();
  const missing = await runtime.runPluginCommand('no-such-plugin', 'echo', {});
  assert.equal(missing.status, 404);
  const offWhitelist = await runtime.runPluginCommand('stub-demo', 'shell', { cmd: 'rm -rf /' });
  assert.equal(offWhitelist.status, 400);
  assert.match(offWhitelist.payload.error, /白名单/);
});

test('run pipes stdin JSON and parses one-line JSON stdout', async () => {
  const { runtime } = fixture();
  const result = await runtime.runPluginCommand('stub-demo', 'echo', { hello: '世界' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, { echoed: { hello: '世界' } });
});

test('run maps plugin failure to 400 with its error message', async () => {
  const { runtime } = fixture();
  const result = await runtime.runPluginCommand('stub-demo', 'fail', {});
  assert.equal(result.status, 400);
  assert.equal(result.payload.error, 'stub boom');
});

test('run reports missing binary as 503', async () => {
  const { runtime } = fixture();
  const result = await runtime.runPluginCommand('no-binary', 'a', {});
  assert.equal(result.status, 503);
  assert.match(result.payload.error, /二进制/);
});

test('resolveBinary finds the .exe cargo writes on Windows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-plugin-exe-'));
  const manifest = { engine: { type: 'command', binary: 'bin/tool', binaryPlatformDir: 'bin' } };
  fs.mkdirSync(path.join(dir, 'bin', 'win32-x64'), { recursive: true });
  const exe = path.join(dir, 'bin', 'win32-x64', 'tool.exe');
  fs.writeFileSync(exe, 'MZ');
  assert.equal(resolveBinary({ manifest, dir }, 'win32', 'x64'), exe);
  assert.equal(resolveBinary({ manifest, dir }, 'linux', 'x64'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('host findPlugin reports the plugin dir and declared ui entry', () => {
  const { app, pluginsDir } = fixture();
  const answer = callHost(hostHandler(app), { op: 'findPlugin', id: 'stub-demo' });
  assert.equal(answer.statusCode, 200);
  assert.deepEqual(answer.body, {
    ok: true, found: true, dir: path.join(pluginsDir, 'stub-demo'), ui: 'ui/index.html',
  });
});

test('host findPlugin reports misses and malformed ids as found:false', () => {
  const { app } = fixture();
  const handler = hostHandler(app);
  for (const id of ['no-such-plugin', 'bridges', '../bridges', '', 42, null, undefined]) {
    assert.deepEqual(callHost(handler, { op: 'findPlugin', id }).body, { ok: true, found: false }, String(id));
  }
});

test('host findPlugin defaults a missing ui and rejects a non-string truthy ui', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-plugins-ui-'));
  const write = (id, ui) => {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = { id, engine: { type: 'command', binary: 'bin/x' }, commands: ['a'] };
    if (ui !== undefined) manifest.ui = ui;
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  };
  write('default-ui');
  write('zero-ui', 0);
  write('empty-ui', '');
  write('numeric-ui', 42);
  write('object-ui', { entry: 'panel.html' });
  const handler = hostOnly({ findManifest: id => readManifest(root, id) }).handler;

  // `manifest.ui || 'ui/index.html'` 的假值语义：缺省、0、空串都走默认入口。
  for (const id of ['default-ui', 'zero-ui', 'empty-ui']) {
    assert.deepEqual(callHost(handler, { op: 'findPlugin', id }).body, {
      ok: true, found: true, dir: path.join(root, id), ui: 'ui/index.html',
    }, id);
  }
  // 非字符串真值在原处理器里会在 path.dirname 抛 TypeError（500）；这里显式化成 ok:false。
  for (const id of ['numeric-ui', 'object-ui']) {
    assert.deepEqual(callHost(handler, { op: 'findPlugin', id }).body, {
      ok: false, error: { message: 'invalid manifest ui' },
    }, id);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('host channelStillActive answers one boolean per item, same length and order', () => {
  const calls = [];
  const handler = hostOnly({
    channelRegistry: {
      stillActive(sessionId, category) { calls.push([sessionId, category]); return category === 'error'; },
      usage: () => [],
    },
  }).handler;
  const longId = 's'.repeat(200);
  const longCategory = 'c'.repeat(64);
  const answer = callHost(handler, {
    op: 'channelStillActive',
    items: [
      { sessionId: 's1', category: 'error' },
      { sessionId: 's2', category: 'done' },
      null,
      'not-an-object',
      [],
      { sessionId: longId, category: longCategory },
    ],
  });
  assert.deepEqual(answer.body, { ok: true, active: [true, false, false, false, false, false] });
  // 真正的非对象项不调用 stillActive，占位 false；数组在原处理器里算对象（字段缺省
  // 成空串）；字符串照原处理器截断（128 / 32）。
  assert.deepEqual(calls, [['s1', 'error'], ['s2', 'done'], ['', ''], ['s'.repeat(128), 'c'.repeat(32)]]);
});

test('host channelStillActive defends non-array input with an empty answer', () => {
  const handler = hostOnly().handler;
  for (const items of [undefined, null, 'nope', {}, 5]) {
    assert.deepEqual(callHost(handler, { op: 'channelStillActive', items }).body, { ok: true, active: [] }, String(items));
  }
  assert.deepEqual(callHost(handler, { op: 'channelStillActive', items: [] }).body, { ok: true, active: [] });
});

test('host channelsStatus passes status() and usage() through untouched', () => {
  // 原 GET /api/channels 的 inUse/subscriptions/uses 整形已归 Rust 前门；宿主端口
  // 只报事实：available、status() 原样、usage() 原样。键序、null 保留、undefined
  // 键经 JSON 省略都在这里钉死。
  const status = [
    {
      id: 'a', name: 'A', nameEn: undefined, channel: { label: 'A' }, ui: null,
      running: true, ready: true, pid: null, unsupported: undefined, alerts: [],
    },
    { id: 'b', name: 'B', channel: null, running: false },
  ];
  const usage = [
    { plugin: 'a', target: 't1', kind: 'push', source: 'sub-1' },
    { plugin: 'a', target: 't2', kind: 'hook', source: 'rule-1', owner: null },
  ];
  const handler = hostOnly({
    channelHost: { status: () => status },
    usage: () => usage,
  }).handler;
  const answer = callHost(handler, { op: 'channelsStatus' });
  assert.equal(answer.statusCode, 200);
  assert.deepEqual(answer.body, { ok: true, available: true, plugins: status, usage });
  // 没有任何整形字段。
  for (const key of ['inUse', 'subscriptions', 'uses']) {
    assert.equal(Object.hasOwn(answer.body.plugins[0], key), false, key);
  }
  // 线上的形状：undefined 键消失、null 留下、键序照旧。
  const wire = JSON.parse(JSON.stringify(answer.body));
  assert.deepEqual(Object.keys(wire), ['ok', 'available', 'plugins', 'usage']);
  assert.deepEqual(Object.keys(wire.plugins[0]), ['id', 'name', 'channel', 'ui', 'running', 'ready', 'pid', 'alerts']);
  assert.equal(wire.plugins[0].pid, null);
  assert.deepEqual(Object.keys(wire.plugins[1]), ['id', 'name', 'channel', 'running']);
  assert.deepEqual(wire.usage, usage);
});

test('host channelsStatus reads usage before status and stops if usage throws', () => {
  const calls = [];
  const handler = hostOnly({
    channelHost: { status() { calls.push('status'); return []; } },
    usage() { calls.push('usage'); return []; },
  }).handler;
  assert.equal(callHost(handler, { op: 'channelsStatus' }).body.ok, true);
  assert.deepEqual(calls, ['usage', 'status']);
  calls.length = 0;
  const failed = hostOnly({
    channelHost: { status() { calls.push('status'); return []; } },
    usage() { calls.push('usage'); throw new Error('usage boom'); },
  }).handler;
  assert.equal(callHost(failed, { op: 'channelsStatus' }).body.ok, false);
  assert.deepEqual(calls, ['usage']);
});

test('host channelsStatus falls back to channelRegistry.usage() and an absent channelHost means available:false', () => {
  const usage = [{ plugin: 'ghost', target: 't', kind: 'hook', source: 'r' }];
  // 复用已经注入的 channelRegistry.usage，不需要重复注入 usage。
  const fromRegistry = hostOnly({ channelRegistry: { stillActive: () => true, usage: () => usage } }).handler;
  assert.deepEqual(callHost(fromRegistry, { op: 'channelsStatus' }).body, {
    ok: true, available: false, plugins: [], usage,
  });
  // channelHost 缺失与显式 null 等价。
  assert.deepEqual(callHost(hostOnly().handler, { op: 'channelsStatus' }).body, {
    ok: true, available: false, plugins: [], usage: [],
  });
  assert.deepEqual(callHost(hostOnly({ channelHost: null }).handler, { op: 'channelsStatus' }).body, {
    ok: true, available: false, plugins: [], usage: [],
  });
});

test('host channelsStatus preserves channelRegistry as the usage receiver', () => {
  const registry = { stillActive: () => true, marker: 'registry', usage() {
    assert.equal(this.marker, 'registry');
    return [];
  } };
  assert.equal(callHost(hostOnly({ channelRegistry: registry }).handler, { op: 'channelsStatus' }).body.ok, true);
});

test('host channelsStatus turns a throwing status()/usage() into the ok:false shape at HTTP 200', () => {
  const cases = [
    ['status', { channelHost: { status() { throw new Error('status boom'); } } }],
    ['usage', { usage() { throw new Error('usage boom'); } }],
  ];
  for (const [label, deps] of cases) {
    const answer = callHost(hostOnly(deps).handler, { op: 'channelsStatus' });
    assert.equal(answer.statusCode, 200, label);
    assert.deepEqual(answer.body, { ok: false, error: { message: `${label} boom` } }, label);
  }
});

test('host port refuses anything but loopback and unknown ops', () => {
  const { handler, locality } = hostOnly();
  locality.local = false;
  const remote = callHost(handler, { op: 'findPlugin', id: 'stub-demo' });
  assert.equal(remote.statusCode, 404);
  assert.deepEqual(remote.body, { error: 'not found' });
  // 新 op 也过同一道回环闸门。
  const remoteStatus = callHost(handler, { op: 'channelsStatus' });
  assert.equal(remoteStatus.statusCode, 404);
  assert.deepEqual(remoteStatus.body, { error: 'not found' });
  locality.local = true;
  const unknown = callHost(handler, { op: 'serve-file', id: 'stub-demo' });
  assert.equal(unknown.statusCode, 400);
  assert.deepEqual(unknown.body, { error: 'unknown host operation' });
});

test('mounting registers the host port and retired public routes stay gone', () => {
  const { app } = fixture();
  // 公开 `/plugins/:id/*` 静态树、`GET /api/channels` 与 `/api/channels/recheck`
  // 由 Rust 前门独占；Node 只剩 8 条公开插件/渠道路由 + 1 条回环宿主端口。
  assert.deepEqual([...app.routes.keys()].sort(), [
    'GET /api/channels/targets',
    'GET /api/plugins',
    'GET /api/plugins/catalog',
    'POST /api/__host/plugins',
    'POST /api/plugins/:id/install',
    'POST /api/plugins/:id/rollback',
    'POST /api/plugins/:id/run',
    'POST /api/plugins/:id/uninstall',
    'POST /api/plugins/catalog/refresh',
  ]);
  assert.equal(app.routes.has('GET /plugins/:id/*'), false, 'the static tree moved to the front door');
  assert.equal(app.routes.has('GET /api/channels'), false, 'the channels status route moved to the front door');
});

test('host mount registers only the internal POST endpoint', () => {
  const { app } = hostOnly();
  assert.deepEqual([...app.routes.keys()], [`POST ${HOST_PATH}`]);
});

test('host mount validates its dependencies like the retired route did', () => {
  assert.throws(() => mountPluginsHostRoute(null, {}), /Express/);
  assert.throws(() => mountPluginsHostRoute(fakeApp(), {}), /findManifest/);
  assert.throws(
    () => mountPluginsHostRoute(fakeApp(), { findManifest: () => null }),
    /channelRegistry\.stillActive/,
  );
  assert.throws(
    () => mountPluginsHostRoute(fakeApp(), { findManifest: () => null, stillActive: () => true }),
    /channelRegistry\.usage/,
  );
  assert.throws(
    () => mountPluginsHostRoute(fakeApp(), { findManifest: () => null, stillActive: () => true, usage: () => [], channelHost: { status: 'nope' } }),
    /channelHost\.status/,
  );
  // stillActive 也可以直接作为函数给；channelHost 可以没有（这台机器不起常驻宿主）。
  assert.doesNotThrow(() => mountPluginsHostRoute(fakeApp(), { findManifest: () => null, stillActive: () => true, usage: () => [] }));
  assert.doesNotThrow(() => mountPluginsHostRoute(fakeApp(), {
    findManifest: () => null, stillActive: () => true, usage: () => [], channelHost: { status: () => [] },
  }));
});

test('run rejects malformed command and plugin ids', async () => {
  const { runtime } = fixture();
  const badId = await runtime.runPluginCommand('../bridges', 'echo', {});
  assert.equal(badId.status, 404);
  const badCommand = await runtime.runPluginCommand('stub-demo', 'ECHO;rm', {});
  assert.equal(badCommand.status, 400);
});

// 用户装的插件是本机数据，必须被忽略，否则主检出常年「有未提交文件」挡住会话
// 合并；反过来已跟踪的内置项一个都不能命中忽略规则 —— 否则往里新加的文件会被
// 自动提交静默漏掉（根目录的 bridges/ 运行时规则就曾顺带挡住 plugins/bridges/）。
test('git ignores user-installed plugins but none of the tracked built-ins', (t) => {
  const root = path.join(__dirname, '..');
  const git = (args, input) => spawnSync('git', args, { cwd: root, input, encoding: 'utf8' });
  const listed = git(['ls-files', '-z', 'plugins']);
  if (listed.status !== 0) return t.skip('not a git checkout');
  const tracked = listed.stdout.split('\0').filter(Boolean);
  assert.ok(tracked.includes('plugins/README.md'));
  // --no-index：只按忽略规则判定，不因为「已跟踪」而豁免。
  const ignored = (paths) => {
    const res = git(['check-ignore', '--no-index', '--stdin', '-z'], paths.join('\0'));
    assert.notEqual(res.status, 128, res.stderr);
    return res.stdout.split('\0').filter(Boolean);
  };

  const builtinDirs = [...new Set(tracked.filter(p => p.split('/').length > 2).map(p => p.split('/')[1]))];
  assert.deepEqual(ignored(tracked), []);
  assert.deepEqual(ignored(builtinDirs.map(dir => `plugins/${dir}/added-later.js`)), []);

  const userPlugin = ['plugins/user-installed-demo/plugin.json', 'plugins/user-installed-demo/bin/tool', 'plugins/stray.txt'];
  assert.deepEqual(ignored(userPlugin), userPlugin);
});
