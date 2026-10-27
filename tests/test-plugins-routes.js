'use strict';

// 插件通道（src/routes/plugins.js）的行为契约：
//   • 只有带合法 plugin.json 的目录才算插件（plugins/bridges 这类内部目录天然不收）
//   • command 必须在 manifest.commands 白名单里
//   • spawn 不走 shell、stdin 喂 JSON、stdout 收一行 JSON（{ok,data} / {ok,error}）
//   • 静态树只放行 manifest.ui 所在子树，防目录穿越
//   • git 只跟踪 plugins/ 的内置项：复制进来的插件默认被 .gitignore 忽略
// 桩插件用 node 脚本充当二进制 —— 真正的 Rust 插件（chrome-proxy-launcher）
// 由自己的 cargo test 与端到端验证覆盖，CI 无需 Rust 工具链也能跑这套契约。

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createPluginsRoutes, resolveBinary } = require('../src/routes/plugins');

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
  const runtime = createPluginsRoutes({ pluginsDir, platform: process.platform, arch: process.arch, logger });
  const app = fakeApp();
  runtime.mount(app);
  return { runtime, app, pluginsDir };
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

test('static route serves only the declared ui subtree', async () => {
  const { runtime } = fixture();
  const serve = (urlPath, params) => {
    const response = makeResponse();
    const request = {
      params: params || { id: 'stub-demo', 0: urlPath.replace(/^\/plugins\/stub-demo\//, '') },
    };
    runtime.servePluginFile(request, response);
    return response;
  };
  const page = serve('/plugins/stub-demo/ui/index.html');
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(String(page.body), /stub/);

  const manifest = serve('/plugins/stub-demo/plugin.json');
  assert.equal(manifest.statusCode, 403); // ui/ 子树之外：源码与 manifest 不出网

  const traversal = serve('/plugins/stub-demo/ui/../../plugin.json');
  assert.ok([400, 403].includes(traversal.statusCode), 'traversal must not be served');
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
