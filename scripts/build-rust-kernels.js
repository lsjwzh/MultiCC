#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { nativeBinaryArch, nativeBinaryPlatform } = require('./native-arch');
const { sourcePaths, sourceFingerprint, probeAddon, provenancePath, writeProvenance } = require('./rust-source-cache');

function targetFor(platform, arch) {
  const targets = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu',
    'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc' };
  const target = targets[`${platform}-${arch}`];
  if (!target) throw new Error('不支持的 Rust 构建目标');
  return target;
}
function verify(file, platform, arch) {
  if (nativeBinaryArch(file) !== arch || nativeBinaryPlatform(file) !== platform) {
    throw new Error(`Rust 模块的平台或架构不匹配：需要 ${platform}-${arch}`);
  }
}
function build({ platform = process.platform, arch = process.arch,
  out = process.env.MULTICC_RUST_PREBUILT_DIR,
  targetDir = process.env.CARGO_TARGET_DIR } = {}) {
  const repo = path.resolve(__dirname, '..'), target = targetFor(platform, arch);
  const fingerprint = sourceFingerprint(repo, process.env);
  const defaults = !out || !targetDir ? sourcePaths(repo) : null;
  out ||= defaults.prebuiltDir;
  targetDir ||= defaults.targetDir;
  const result = spawnSync('cargo', ['build', '--locked', '--release', '--manifest-path',
    path.join(repo, 'native/Cargo.toml'), '--target', target], {
    stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: path.resolve(targetDir) },
  });
  if (result.status !== 0) throw new Error('Rust 构建失败；请检查 Rust 工具链、目标标准库和链接器');
  const library = platform === 'win32' ? 'multicc_addon.dll'
    : platform === 'darwin' ? 'libmulticc_addon.dylib' : 'libmulticc_addon.so';
  const source = path.resolve(targetDir, target, 'release', library);
  verify(source, platform, arch);
  const file = path.resolve(out, `${platform}-${arch}`, 'multicc_core.node');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp.node`;
  try {
    fs.copyFileSync(source, temporary);
    if (platform === process.platform && arch === process.arch && !probeAddon(temporary)) throw new Error('Rust 接口版本不匹配');
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  // Record the source this file was built from (see rust-source-cache.js). An edit
  // during the build leaves no record, so nothing can vouch for mixed output.
  if (sourceFingerprint(repo, process.env) === fingerprint) writeProvenance(file, fingerprint);
  else fs.rmSync(provenancePath(file), { force: true });
  console.log(`Rust 模块已构建：${file}`);
  return file;
}
if (require.main === module) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = { '--out': 'out', '--platform': 'platform', '--arch': 'arch', '--target-dir': 'targetDir' }[process.argv[i]];
      if (!key || !process.argv[i + 1]) throw new Error('参数：--out 目录 --platform 平台 --arch 架构 --target-dir 编译缓存目录');
      options[key] = process.argv[i + 1];
    }
    build(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { targetFor, verify, build };
