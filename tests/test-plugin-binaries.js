'use strict';
// 内置插件平台二进制：scripts/build-plugin-binaries.js（编译 + 第三方内核）与
// scripts/stage-plugin-binaries.js（打包只留目标平台）。离线：不调 cargo、不联网。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const build = require('../scripts/build-plugin-binaries');
const { stagePluginBinaries } = require('../scripts/stage-plugin-binaries');
const { SUPPORTED_ARCHES, SUPPORTED_PLATFORMS } = require('../scripts/standalone-bundle');

// 64 字节就够 native-arch 认出格式与架构。
function fakeElf(machine) {
  const buffer = Buffer.alloc(64);
  buffer.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  buffer.writeUInt16LE(machine, 18);
  return buffer;
}
const ELF_X64 = fakeElf(0x3e);
const ELF_ARM64 = fakeElf(0xb7);

function fixtureRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-plugin-bins-'));
  const dir = path.join(repo, 'plugins', 'demo');
  fs.mkdirSync(path.join(dir, 'bin', 'darwin-arm64'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin', 'linux-x64'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'target', 'release'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "demo"\n');
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id: 'demo', commands: ['a'], engine: { type: 'command', binary: 'bin/demo', binaryPlatformDir: 'bin' },
  }));
  fs.writeFileSync(path.join(dir, 'bin', 'darwin-arm64', 'demo'), 'mach-o');
  fs.writeFileSync(path.join(dir, 'bin', 'linux-x64', 'demo'), ELF_X64);
  fs.writeFileSync(path.join(dir, 'target', 'release', 'demo'), 'cache');
  // 不带 Cargo.toml 的插件（如 bridges）不归编译脚本管。
  fs.mkdirSync(path.join(repo, 'plugins', 'scripted'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'plugins', 'scripted', 'plugin.json'), JSON.stringify({
    id: 'scripted', commands: ['a'], engine: { type: 'command', binary: 'run.sh', binaryPlatformDir: 'bin' },
  }));
  return repo;
}

function copyPlugins(repo) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-plugin-stage-'));
  fs.cpSync(path.join(repo, 'plugins'), path.join(out, 'plugins'), { recursive: true });
  return out;
}

test('Linux 一律 musl 静态链接，交叉到 Linux 走 zigbuild', () => {
  assert.equal(build.targetFor('linux', 'x64'), 'x86_64-unknown-linux-musl');
  assert.equal(build.targetFor('linux', 'arm64'), 'aarch64-unknown-linux-musl');
  assert.throws(() => build.targetFor('freebsd', 'x64'), /不支持/);
  assert.deepEqual(build.cargoCommand({ target: 'x86_64-unknown-linux-musl', host: 'x86_64-unknown-linux-gnu' }), ['zigbuild']);
  assert.deepEqual(build.cargoCommand({ target: 'x86_64-unknown-linux-musl', host: 'x86_64-unknown-linux-musl' }), ['build']);
  assert.deepEqual(build.cargoCommand({ target: 'x86_64-apple-darwin', host: 'aarch64-apple-darwin' }), ['build']);
  assert.equal(build.binaryFileName('bin/demo', 'win32'), 'demo.exe');
  assert.equal(build.binaryFileName('bin/demo', 'linux'), 'demo');
});

test('发版矩阵里的每个平台都有构建目标和 meow 内核', () => {
  const plugin = build.compiledPlugins(ROOT).find(item => item.id === 'chrome-proxy-launcher');
  assert.ok(plugin, '仓库里应能找到需要编译的 chrome-proxy-launcher');
  const [meow] = build.readBundledAssets(plugin);
  assert.equal(meow.name, 'meow');
  for (const platform of SUPPORTED_PLATFORMS) {
    for (const arch of SUPPORTED_ARCHES) {
      if (platform === 'win32' && arch === 'arm64') continue;
      const key = `${platform}-${arch}`;
      assert.ok(build.TARGETS[key], `${key} 缺少 Rust 目标`);
      const spec = meow.targets[key];
      assert.ok(spec, `${key} 缺少 meow 下载项`);
      assert.match(spec.sha256, /^[0-9a-f]{64}$/);
      assert.match(spec.url, /^https:\/\/github\.com\/meow-rs\/meow-rs\/releases\/download\/v0\.26\.1\//);
      assert.equal(spec.output, platform === 'win32' ? 'meow.exe.gz' : 'meow.gz');
    }
  }
});

test('打包只留目标平台目录，删掉编译缓存', () => {
  const repo = fixtureRepo();
  const out = copyPlugins(repo);
  const logs = [];
  const staged = stagePluginBinaries({ repoRoot: repo, out, require: true,
    npmEnv: { npm_config_platform: 'linux', npm_config_arch: 'x64' }, logger: { log: line => logs.push(line) } });
  const bin = path.join(out, 'plugins', 'demo', 'bin');
  assert.deepEqual(staged, [path.join(bin, 'linux-x64', 'demo')]);
  assert.deepEqual(fs.readdirSync(bin), ['linux-x64']);
  assert.equal(fs.existsSync(path.join(out, 'plugins', 'demo', 'target')), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(staged[0]).mode & 0o777, 0o755);
  }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test('发版缺目标平台二进制直接失败，本地打包只告警且不删现有目录', () => {
  const repo = fixtureRepo();
  const out = copyPlugins(repo);
  const npmEnv = { npm_config_platform: 'linux', npm_config_arch: 'arm64' };
  assert.throws(() => stagePluginBinaries({ repoRoot: repo, out, npmEnv, require: true, logger: { log() {} } }),
    /打包缺少插件 demo 的 linux-arm64 二进制/);
  const logs = [];
  assert.deepEqual(stagePluginBinaries({ repoRoot: repo, out, npmEnv, require: false,
    logger: { log: line => logs.push(line) } }), []);
  assert.match(logs.join('\n'), /警告/);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test('架构不对的二进制不能冒充目标平台', () => {
  const repo = fixtureRepo();
  fs.writeFileSync(path.join(repo, 'plugins', 'demo', 'bin', 'linux-x64', 'demo'), ELF_ARM64);
  const out = copyPlugins(repo);
  assert.throws(() => stagePluginBinaries({ repoRoot: repo, out, require: true,
    npmEnv: { npm_config_platform: 'linux', npm_config_arch: 'x64' }, logger: { log() {} } }), /不匹配/);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test('第三方内核：sha256 校验、解出单文件、gzip 落到平台目录，内容相同不重写', async (t) => {
  if (spawnSync('tar', ['--version']).status !== 0) return t.skip('没有 tar');
  const repo = fixtureRepo();
  const plugin = build.compiledPlugins(repo)[0];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-plugin-asset-src-'));
  fs.mkdirSync(path.join(work, 'meow-v1-x86_64-unknown-linux-musl'));
  fs.writeFileSync(path.join(work, 'meow-v1-x86_64-unknown-linux-musl', 'meow'), ELF_X64);
  const archiveName = 'meow-v1-x86_64-unknown-linux-musl.tar.gz';
  const tarball = path.join(work, archiveName);
  assert.equal(spawnSync('tar', ['-czf', tarball, '-C', work, 'meow-v1-x86_64-unknown-linux-musl']).status, 0);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  // 预置下载缓存：测试不联网。
  const cacheDir = path.join(work, 'cache');
  fs.mkdirSync(path.join(cacheDir, digest), { recursive: true });
  fs.copyFileSync(tarball, path.join(cacheDir, digest, archiveName));
  const asset = { name: 'meow', version: '1', targets: { 'linux-x64': {
    url: `https://example.invalid/${archiveName}`, sha256: digest, member: 'meow', output: 'meow.gz' } } };
  const logger = { log() {} };

  const file = await build.stageBundledAsset(plugin, asset, { platform: 'linux', arch: 'x64', cacheDir, logger });
  assert.equal(file, path.join(repo, 'plugins', 'demo', 'bin', 'linux-x64', 'meow.gz'));
  assert.ok(zlib.gunzipSync(fs.readFileSync(file)).equals(ELF_X64));
  const before = fs.statSync(file).mtimeMs;
  await new Promise(resolve => setTimeout(resolve, 20));
  await build.stageBundledAsset(plugin, asset, { platform: 'linux', arch: 'x64', cacheDir, logger });
  assert.equal(fs.statSync(file).mtimeMs, before);

  assert.equal(await build.stageBundledAsset(plugin, asset, { platform: 'darwin', arch: 'x64', cacheDir, logger }), null);
  const bad = { ...asset, targets: { 'linux-x64': { ...asset.targets['linux-x64'], sha256: '0'.repeat(64) } } };
  const fetchArchive = async () => fs.readFileSync(tarball);
  await assert.rejects(build.stageBundledAsset(plugin, bad, { platform: 'linux', arch: 'x64', cacheDir, fetchArchive, logger }),
    /sha256 不匹配/);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

test('发版流水线每个平台都在打包前编译插件二进制', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/desktop-release.yml'), 'utf8');
  const calls = workflow.match(/scripts\/build-plugin-binaries\.js --platform/g) || [];
  assert.ok(calls.length >= 2, 'standalone 与桌面两条构建线都要调用 build-plugin-binaries.js');
  assert.match(workflow, /cargo-zigbuild/);
  assert.match(workflow, /校验插件二进制随包发布/);
});
