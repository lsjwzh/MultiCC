'use strict';

// 选择层（src/remote-screen.js）的契约：默认 rust、显式 node 才加载回退实现、
// 非法值按 rust 处理并留一行警告，两套实现对调用方暴露同一组导出。
// 用子进程逐个验证，因为选择只在模块加载时发生一次（不可能在同一进程里换后端）。

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = `
  const path = require('node:path');
  const rs = require('./src/remote-screen');
  const loaded = Object.keys(require.cache)
    .filter(file => /remote-screen-(node|rust)\\.js$/.test(file))
    .map(file => path.basename(file)).sort();
  process.stdout.write(JSON.stringify({
    backend: rs.backend,
    keys: Object.keys(rs).sort(),
    loaded,
    types: Object.fromEntries(Object.entries(rs).map(([key, value]) => [key, typeof value])),
  }));
`;

function load(envValue) {
  const env = { ...process.env };
  delete env.MULTICC_REMOTE_SCREEN_BACKEND;
  if (envValue !== undefined) env.MULTICC_REMOTE_SCREEN_BACKEND = envValue;
  const result = spawnSync(process.execPath, ['-e', SCRIPT], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  return { ...JSON.parse(result.stdout), stderr: result.stderr };
}

function sameContract(left, right, label) {
  assert.deepEqual(left.keys, right.keys, `${label}: 两套实现的导出必须一致`);
  assert.equal(left.types.backend, 'string');
  for (const name of ['mount', 'attachRfb', 'attachH264', 'handleAnnotation', 'isOwnShot',
    'capabilities', '_state', '_unavailableCapabilities']) {
    assert.equal(left.types[name], 'function', `${label}: ${name} 应是函数`);
  }
  assert.equal(left.types.DIR, 'string', `${label}: DIR 应是截图目录`);
  assert.equal(left.types._deps, 'object', `${label}: _deps 应是对象`);
}

test('未配置时默认 rust，只加载 Rust 转发层', () => {
  const out = load(undefined);
  assert.equal(out.backend, 'rust');
  assert.deepEqual(out.loaded, ['remote-screen-rust.js']);
  assert.doesNotMatch(out.stderr, /后端配置无效/);
});

test('显式 node 时加载回退实现，绝不加载 Rust 层', () => {
  const out = load(' node ');
  assert.equal(out.backend, 'node');
  assert.deepEqual(out.loaded, ['remote-screen-node.js']);
});

test('非法值按 rust 处理并只警告一行（不让配置写错拖垮「🖥 屏幕」）', () => {
  const out = load('auto');
  assert.equal(out.backend, 'rust');
  assert.deepEqual(out.loaded, ['remote-screen-rust.js']);
  const warnings = out.stderr.split('\n').filter(line => line.includes('后端配置无效'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /MULTICC_REMOTE_SCREEN_BACKEND/);
});

test('两套实现对调用方暴露同一组导出', () => {
  const rust = load(undefined);
  const node = load('node');
  sameContract(rust, node, 'selection');
  assert.equal(rust.backend, 'rust');
  assert.equal(node.backend, 'node');
});
