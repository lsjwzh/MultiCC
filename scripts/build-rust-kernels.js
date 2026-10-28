#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { nativeBinaryArch, nativeBinaryPlatform } = require('./native-arch');
const { sourcePaths, sourceFingerprint, probeAddon, provenancePath, writeProvenance } = require('./rust-source-cache');

// 远控进程和原生模块同属一个 cargo workspace，但单独编译：远控编不出来只让
// 「🖥 屏幕」不可用，不能连累服务启动。workspace 里还没有 remote 时，两条
// 产物规则都必须当它不存在。
const REMOTE_CRATE = 'multicc-remote';
// CDP 网关（三平台同一份实现）。编不出来只让「一次审批」退化成直连，不影响启动。
const CDPD_CRATE = 'multicc-cdpd';

function targetFor(platform, arch) {
  const targets = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu',
    'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc' };
  const target = targets[`${platform}-${arch}`];
  if (!target) throw new Error('不支持的 Rust 构建目标');
  return target;
}

function remoteBinaryName(platform) {
  return platform === 'win32' ? 'multicc-remote.exe' : 'multicc-remote';
}

// 远控二进制只认原生模块同目录那一个（Node 端查找顺序见
// docs/remote-screen-process.md §1），所以路径一律由模块路径推导。
function remoteBinaryPath(addonPath, platform = process.platform) {
  return path.join(path.dirname(addonPath), remoteBinaryName(platform));
}

function workspaceMembers(repoRoot) {
  try {
    const body = fs.readFileSync(path.join(repoRoot, 'native/Cargo.toml'), 'utf8');
    const members = body.match(/^\s*members\s*=\s*\[([^\]]*)\]/m);
    return members ? [...members[1].matchAll(/"([^"]+)"/g)].map(match => match[1]) : [];
  } catch (_) {
    return [];
  }
}

function hasRemoteCrate(repoRoot) {
  return workspaceMembers(repoRoot).includes('remote');
}

function hasCdpdCrate(repoRoot) {
  return workspaceMembers(repoRoot).includes('cdpd');
}

function cdpdBinaryName(platform) {
  return platform === 'win32' ? 'multicc-cdpd.exe' : 'multicc-cdpd';
}

// --version 打印一行 `multicc-cdpd <协议版本> <crate 版本>`。服务端只和同协议的网关
// 说话，编出一个对不上的二进制等于没编。三处必须一致（tests/test-cdpd.js 校验）：
// 这里、src/cdpd.js 的 PROTOCOL_VERSION、native/cdpd/src/lib.rs 的 PROTOCOL_VERSION。
// 不 require src/cdpd.js：构建脚本不依赖服务端模块（源码启动测试会只拷 scripts/）。
const CDPD_PROTOCOL = 2;
const CDPD_VERSION_PREFIX = `${CDPD_CRATE} ${CDPD_PROTOCOL} `;

function probeCdpdVersion(file, { run = spawnSync } = {}) {
  const result = run(file, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  const output = `${result.stdout || ''}`.trim();
  const ok = !result.error && result.status === 0 && output.startsWith(CDPD_VERSION_PREFIX);
  return { ok, output, status: result.status, error: result.error };
}

function verify(file, platform, arch) {
  if (nativeBinaryArch(file) !== arch || nativeBinaryPlatform(file) !== platform) {
    throw new Error(`Rust 模块的平台或架构不匹配：需要 ${platform}-${arch}`);
  }
}

function executable(file) {
  try {
    if (process.platform === 'win32') return fs.statSync(file).isFile();
    return (fs.statSync(file).mode & 0o111) === 0o111;
  } catch (_) {
    return false;
  }
}

// --version 打印一行 `multicc-remote 1 <crate 版本>`；`1` 是协议版本
// （docs/remote-screen-process.md §1）。Node 端靠这一行确认二进制能跑。
function probeRemoteVersion(file, { run = spawnSync } = {}) {
  const result = run(file, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  const output = `${result.stdout || ''}`.trim();
  const ok = !result.error && result.status === 0 && output.startsWith(`${REMOTE_CRATE} 1 `);
  return { ok, output, status: result.status, error: result.error };
}

function copyStaged(source, file, { executable: wantsExecutable, suffix = '.tmp' }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 原生模块的临时文件必须留着 .node 后缀：probe 用 require() 加载它，
  // 未知后缀会被当成 JS 解析，而不是 dlopen。
  const temporary = `${file}.${process.pid}${suffix}`;
  try {
    fs.copyFileSync(source, temporary);
    // copyFileSync 不保留权限位：可执行文件在打包/解包链路上必须自己 chmod，
    // 否则会重演 gradlew 100644 → exit 126 的老坑。
    if (wantsExecutable && process.platform !== 'win32') fs.chmodSync(temporary, 0o755);
    return temporary;
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function build({ platform = process.platform, arch = process.arch,
  out = process.env.MULTICC_RUST_PREBUILT_DIR,
  targetDir = process.env.CARGO_TARGET_DIR,
  requireRemote = process.env.MULTICC_REQUIRE_RUST_BUNDLE === '1',
  remoteOnly = false, cdpdOnly = false, repoRoot, run = spawnSync, probe = probeAddon, logger = console } = {}) {
  const repo = path.resolve(repoRoot || path.resolve(__dirname, '..'));
  const target = targetFor(platform, arch);
  const fingerprint = sourceFingerprint(repo, process.env);
  const defaults = !out || !targetDir ? sourcePaths(repo) : null;
  out ||= defaults.prebuiltDir;
  targetDir ||= defaults.targetDir;
  const manifest = path.join(repo, 'native/Cargo.toml');
  const cargoEnv = { ...process.env, CARGO_TARGET_DIR: path.resolve(targetDir) };
  const cargo = crate => {
    const result = run('cargo', ['build', '--locked', '--release', '--manifest-path',
      manifest, '--target', target, '-p', crate], { stdio: 'inherit', env: cargoEnv });
    if (result.error || result.status !== 0) {
      throw new Error(`Rust 构建失败（${crate}）；请检查 Rust 工具链、目标标准库和链接器`);
    }
  };
  const produced = [];

  if (!remoteOnly && !cdpdOnly) {
    cargo('multicc-addon');
    const library = platform === 'win32' ? 'multicc_addon.dll'
      : platform === 'darwin' ? 'libmulticc_addon.dylib' : 'libmulticc_addon.so';
    const source = path.resolve(targetDir, target, 'release', library);
    verify(source, platform, arch);
    const file = path.resolve(out, `${platform}-${arch}`, 'multicc_core.node');
    const temporary = copyStaged(source, file, { executable: false, suffix: '.tmp.node' });
    try {
      if (platform === process.platform && arch === process.arch && !probe(temporary)) throw new Error('Rust 接口版本不匹配');
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    produced.push({ kind: '模块', file });
    logger.log(`Rust 模块已构建：${file}`);
  }

  let remote = null;
  let remoteError = null;
  if (cdpdOnly || !hasRemoteCrate(repo)) {
    // 迁移进行中的正常状态：源码里还没有远控进程，什么都不缺。
    if (!cdpdOnly) logger.log('native/remote 尚未加入 cargo workspace，跳过远控二进制 multicc-remote。');
  } else {
    const source = path.resolve(targetDir, target, 'release', remoteBinaryName(platform));
    const file = path.resolve(out, `${platform}-${arch}`, remoteBinaryName(platform));
    try {
      cargo(REMOTE_CRATE);
      verify(source, platform, arch);
      const temporary = copyStaged(source, file, { executable: true });
      try {
        if (platform === process.platform && arch === process.arch) {
          const probed = probeRemoteVersion(temporary, { run });
          if (!probed.ok) {
            throw new Error(`--version 校验失败（期望以 "${REMOTE_CRATE} 1 " 开头，实际输出：${probed.output || `退出码 ${probed.status}`}）`);
          }
        }
        fs.renameSync(temporary, file);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      produced.push({ kind: '远控二进制', file });
      remote = file;
      logger.log(`远控二进制已构建：${file}`);
    } catch (error) {
      remoteError = error;
      if (requireRemote) throw new Error(`远控二进制构建失败：${error.message}`);
      logger.error(`警告：远控二进制 ${REMOTE_CRATE} 未构建，「🖥 屏幕」本次不可用：${error.message}`);
      logger.error('修复：安装可用的 Rust 工具链后重新执行 ./multicc start，或设置 MULTICC_REMOTE_BIN 指向已编译的 multicc-remote。');
    }
  }

  let cdpd = null;
  let cdpdError = null;
  if (!hasCdpdCrate(repo)) {
    logger.log('native/cdpd 尚未加入 cargo workspace，跳过 CDP 网关 multicc-cdpd。');
  } else {
    const name = platform === 'win32' ? 'multicc-cdpd.exe' : 'multicc-cdpd';
    const source = path.resolve(targetDir, target, 'release', name);
    const file = path.resolve(out, `${platform}-${arch}`, name);
    try {
      cargo(CDPD_CRATE);
      verify(source, platform, arch);
      const temporary = copyStaged(source, file, { executable: true });
      try {
        if (platform === process.platform && arch === process.arch) {
          const result = run(temporary, ['--version'], { encoding: 'utf8', timeout: 15_000 });
          const output = `${result.stdout || ''}`.trim();
          if (result.status !== 0 || !output.startsWith(CDPD_VERSION_PREFIX)) {
            throw new Error(`--version 校验失败（期望以 "${CDPD_VERSION_PREFIX}" 开头，实际输出：${output || `退出码 ${result.status}`}）`);
          }
        }
        fs.renameSync(temporary, file);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      produced.push({ kind: 'CDP 网关', file });
      cdpd = file;
      logger.log(`CDP 网关已构建：${file}`);
    } catch (error) {
      // 网关编不出来只是退回「每条连接一次授权」，不能连累服务启动。
      cdpdError = error;
      logger.error(`警告：CDP 网关 ${CDPD_CRATE} 未构建，浏览器授权会退化成每次连接一次：${error.message}`);
    }
  }

  // Record the source these files were built from (see rust-source-cache.js). An
  // edit during the build leaves no record, so nothing can vouch for mixed output.
  // 两个产物一起记账：任何一个没有来源记录，都当成不是当前源码编的。
  const stable = sourceFingerprint(repo, process.env) === fingerprint;
  for (const { file } of produced) {
    if (stable) writeProvenance(file, fingerprint);
    else fs.rmSync(provenancePath(file), { force: true });
  }
  const addon = produced.find(item => item.kind === '模块');
  return { addon: addon ? addon.file : null, remote, remoteError, cdpd, cdpdError };
}

function parseArgs(argv, env = process.env) {
  const options = { requireRemote: env.MULTICC_REQUIRE_RUST_BUNDLE === '1' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--remote-only') { options.remoteOnly = true; continue; }
    if (flag === '--cdpd-only') { options.cdpdOnly = true; continue; }
    if (flag === '--require-remote') { options.requireRemote = true; continue; }
    const key = { '--out': 'out', '--platform': 'platform', '--arch': 'arch', '--target-dir': 'targetDir' }[flag];
    if (!key || !argv[i + 1]) {
      throw new Error('参数：--out 目录 --platform 平台 --arch 架构 --target-dir 编译缓存目录 [--remote-only] [--cdpd-only] [--require-remote]');
    }
    options[key] = argv[++i];
  }
  return options;
}

if (require.main === module) {
  try {
    build(parseArgs(process.argv.slice(2)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = {
  REMOTE_CRATE, CDPD_CRATE, CDPD_PROTOCOL, build, executable, hasRemoteCrate, hasCdpdCrate, parseArgs, probeRemoteVersion,
  probeCdpdVersion, cdpdBinaryName, remoteBinaryName,
  remoteBinaryPath, targetFor, verify, workspaceMembers,
};
