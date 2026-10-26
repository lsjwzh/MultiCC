#!/usr/bin/env node
'use strict';

// Called only by the source-checkout manager, before its runtime checks.
// stdout is the selected addon path; build progress belongs on stderr.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sourcePaths, sourceFingerprint, probeAddon, builtFromSource } = require('./rust-source-cache');
const { executable, hasRemoteCrate, probeRemoteVersion, remoteBinaryName } = require('./build-rust-kernels');

// 「🖥 屏幕」的二进制和原生模块同目录才认（Node 端查找顺序见
// docs/remote-screen-process.md §1）。原型开发路径上它只是可选件：缺了就补编一次，
// 编不出来也照常启动服务——远控自己会以 remote-unavailable 降级。
function ensureRemoteBinary({ repoRoot, addon, env, cache, log, run,
  builtFrom = builtFromSource, remoteVersion = probeRemoteVersion }) {
  if (!hasRemoteCrate(repoRoot)) return null;
  const configured = env.MULTICC_REMOTE_BIN && path.resolve(env.MULTICC_REMOTE_BIN);
  if (configured) {
    // 显式指定时不同目录里再编一份只会让人以为生效了，所以只认这一处。
    if (fs.existsSync(configured)) return configured;
    log(`远控「🖥 屏幕」不可用：MULTICC_REMOTE_BIN 指向的 ${configured} 不存在。`
      + `修复：改正该环境变量，或删掉它让服务端使用原生模块同目录的 ${remoteBinaryName(process.platform)}。`);
    return null;
  }
  const binary = remoteBinaryName(process.platform);
  const target = path.join(path.dirname(addon), binary);
  // 指纹目录里的产物由目录名担保；外部指定目录要来源记录证明是当前源码编的。
  const relative = path.relative(cache.prebuiltDir, path.dirname(addon));
  const ownCache = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  const usable = () => fs.existsSync(target) && executable(target)
    && (ownCache || builtFrom(target, cache.fingerprint)) && remoteVersion(target).ok;
  if (usable()) return target;
  const stale = fs.existsSync(target);
  log(`未找到可用的远控二进制 ${target}${stale ? '（已存在的文件不是当前源码编的或无法运行）' : ''}，`
    + '正在只编译 multicc-remote（不影响服务启动）…');
  const result = run(process.execPath, [path.join(repoRoot, 'scripts/build-rust-kernels.js'),
    '--remote-only', '--out', path.dirname(addon), '--target-dir', cache.targetDir], {
    cwd: repoRoot, env: { ...env, MULTICC_RUST_ADDON: '', MULTICC_REQUIRE_RUST_BUNDLE: '' },
    stdio: ['ignore', 2, 2],
  });
  if ((!result.error && result.status === 0) && usable()) return target;
  const reason = result.error ? result.error.code || result.error.message
    : result.status !== 0 ? `编译失败（退出码 ${result.status}）` : '编译产物缺失';
  log(`远控「🖥 屏幕」不可用：缺少 ${target}（${reason}）。`
    + `服务照常启动；修复：安装可用的 Rust 工具链后重新执行 ./multicc start 自动编译，`
    + '或设置 MULTICC_REMOTE_BIN 指向已编译的 multicc-remote。');
  return null;
}

function ensureSourceRust({ repoRoot = path.resolve(__dirname, '..'), env = process.env,
  probe = probeAddon, paths = sourcePaths, builtFrom = builtFromSource, run = spawnSync,
  remoteVersion = probeRemoteVersion, log = console.error } = {}) {
  if (env.MULTICC_SQLITE_BACKEND === 'node' && String(env.MULTICC_CPR_BACKEND || 'rust').trim().toLowerCase() === 'node') return null;
  const cache = paths(repoRoot, env);
  const target = `${process.platform}-${process.arch}`;
  const file = path.join(cache.prebuiltDir, target, 'multicc_core.node');
  const configured = env.MULTICC_RUST_ADDON || (env.MULTICC_RUST_PREBUILT_DIR
    && path.join(env.MULTICC_RUST_PREBUILT_DIR, target, 'multicc_core.node'));
  // A restart inherits the running server's environment, so whatever addon an
  // earlier start selected comes back here as "configured". Source-owned caches
  // must match today's fingerprint (the path names it). An external override is
  // reused only when its provenance record proves it was built from this exact
  // source; otherwise every restart would keep an older addon and native APIs
  // added since would stay missing.
  const resolved = configured && path.resolve(configured);
  const relative = configured && path.relative(path.dirname(cache.prebuiltDir), resolved);
  const ownCache = configured && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  const current = configured && (ownCache ? resolved === file : builtFrom(resolved, cache.fingerprint));
  const ensureRemote = addon => {
    try { return ensureRemoteBinary({ repoRoot, addon, env, cache, log, run, builtFrom, remoteVersion }); }
    // 远控是可选件：任何意外都不许挡住服务启动。
    catch (error) { log(`远控「🖥 屏幕」不可用：${error.message}。服务照常启动。`); return null; }
  };
  if (current && probe(resolved)) {
    ensureRemote(resolved);
    return resolved;
  }
  if (probe(file)) {
    ensureRemote(file);
    return file;
  }
  if (configured) {
    log(ownCache || current ? '指定的 Rust 模块不可用，将为当前源码重新构建。'
      : '指定的 Rust 模块不是由当前源码构建的（可能缺少新加的原生接口），将为当前源码重新构建。');
  }
  log('未找到当前源码可用的 Rust 模块，正在自动编译（首次编译可能需要几分钟）…');
  const result = run(process.execPath, [path.join(repoRoot, 'scripts/build-rust-kernels.js'),
    '--out', cache.prebuiltDir, '--target-dir', cache.targetDir], {
    cwd: repoRoot, env: { ...env, MULTICC_RUST_ADDON: '', MULTICC_REQUIRE_RUST_BUNDLE: '' }, stdio: ['ignore', 2, 2],
  });
  if (result.error || result.status !== 0) {
    // Without a working toolchain a still-loadable external override is better
    // than refusing to start, as before; say plainly what that costs.
    if (configured && !ownCache && !current && probe(resolved)) {
      log('无法为当前源码编译 Rust 模块，暂时沿用指定的模块；它不是当前源码构建的，新加的原生功能可能不可用。');
      ensureRemote(resolved);
      return resolved;
    }
    throw new Error('Rust 自动编译失败，服务尚未启动。源码开发需要可用的 Rust/Cargo 和平台链接工具；安装后重试 ./multicc start。');
  }
  if (sourceFingerprint(repoRoot, env) !== cache.fingerprint) {
    fs.rmSync(file, { force: true });
    throw new Error('编译期间 Rust 源码发生变化，请重新执行 ./multicc start。');
  }
  if (!probe(file)) throw new Error('Rust 产物未通过运行校验，服务尚未启动；请检查工具链及目标架构。');
  ensureRemote(file);
  log('Rust 模块已就绪，后续启动将自动复用。');
  return file;
}

if (require.main === module) {
  try { const file = ensureSourceRust(); if (file) process.stdout.write(file + '\n'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { ensureRemoteBinary, ensureSourceRust };
