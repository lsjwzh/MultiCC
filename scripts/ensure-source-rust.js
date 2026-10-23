#!/usr/bin/env node
'use strict';

// Called only by the source-checkout manager, before its runtime checks.
// stdout is the selected addon path; build progress belongs on stderr.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sourcePaths, sourceFingerprint, probeAddon, builtFromSource } = require('./rust-source-cache');

function ensureSourceRust({ repoRoot = path.resolve(__dirname, '..'), env = process.env,
  probe = probeAddon, paths = sourcePaths, builtFrom = builtFromSource, run = spawnSync,
  log = console.error } = {}) {
  if (env.MULTICC_SQLITE_BACKEND === 'node' && String(env.MULTICC_CPR_BACKEND || 'node').trim().toLowerCase() !== 'rust') return null;
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
  if (current && probe(resolved)) return resolved;
  if (probe(file)) return file;
  if (configured) {
    log(ownCache || current ? '指定的 Rust 模块不可用，将为当前源码重新构建。'
      : '指定的 Rust 模块不是由当前源码构建的（可能缺少新加的原生接口），将为当前源码重新构建。');
  }
  log('未找到当前源码可用的 Rust 模块，正在自动编译（首次编译可能需要几分钟）…');
  const result = run(process.execPath, [path.join(repoRoot, 'scripts/build-rust-kernels.js'),
    '--out', cache.prebuiltDir, '--target-dir', cache.targetDir], {
    cwd: repoRoot, env: { ...env, MULTICC_RUST_ADDON: '' }, stdio: ['ignore', 2, 2],
  });
  if (result.error || result.status !== 0) {
    // Without a working toolchain a still-loadable external override is better
    // than refusing to start, as before; say plainly what that costs.
    if (configured && !ownCache && !current && probe(resolved)) {
      log('无法为当前源码编译 Rust 模块，暂时沿用指定的模块；它不是当前源码构建的，新加的原生功能可能不可用。');
      return resolved;
    }
    throw new Error('Rust 自动编译失败，服务尚未启动。源码开发需要可用的 Rust/Cargo 和平台链接工具；安装后重试 ./multicc start。');
  }
  if (sourceFingerprint(repoRoot, env) !== cache.fingerprint) {
    fs.rmSync(file, { force: true });
    throw new Error('编译期间 Rust 源码发生变化，请重新执行 ./multicc start。');
  }
  if (!probe(file)) throw new Error('Rust 产物未通过运行校验，服务尚未启动；请检查工具链及目标架构。');
  log('Rust 模块已就绪，后续启动将自动复用。');
  return file;
}

if (require.main === module) {
  try { const file = ensureSourceRust(); if (file) process.stdout.write(file + '\n'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { ensureSourceRust };
