'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hasRemoteCrate, remoteBinaryName, verify } = require('./build-rust-kernels');

// Electron 和 standalone 共用。只复制目标架构，禁止宿主二进制冒充交叉构建产物。
// 远控进程和原生模块同目录，所以这里必须一起搬：少一个就是「🖥 屏幕」在用户
// 机器上悄悄消失，而不是在打包时报错。
function stageRustKernels({ repoRoot, out, npmEnv = {}, logger = console }) {
  const platform = npmEnv.npm_config_platform || process.platform;
  const arch = npmEnv.npm_config_arch || process.arch;
  const root = process.env.MULTICC_RUST_PREBUILT_DIR || path.join(repoRoot, 'native/prebuilt');
  const relative = path.join(`${platform}-${arch}`, 'multicc_core.node');
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) {
    throw new Error(`打包缺少 Rust 模块：${platform}-${arch}`);
  }
  verify(source, platform, arch);
  const dest = path.join(out, 'native/prebuilt', relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);

  const binary = remoteBinaryName(platform);
  const remoteSource = path.join(root, `${platform}-${arch}`, binary);
  let stagedRemote = null;
  if (!fs.existsSync(remoteSource)) {
    // native/remote 落地前，仓库里的产物本来就只有模块；这不是打包缺件。
    if (hasRemoteCrate(repoRoot)) throw new Error(`打包缺少远控二进制：${platform}-${arch}`);
    logger.log('[Rust] native/remote 尚未加入 cargo workspace，跳过远控二进制');
  } else {
    verify(remoteSource, platform, arch);
    stagedRemote = path.join(out, 'native/prebuilt', `${platform}-${arch}`, binary);
    fs.copyFileSync(remoteSource, stagedRemote);
    // 权限位决定解包/签名链路上还能不能执行：Windows 不认这一位，其余平台必须显式给。
    if (platform !== 'win32') fs.chmodSync(stagedRemote, 0o755);
  }
  logger.log(`[Rust] 已打包 ${platform}-${arch}${stagedRemote ? '（模块 + 远控二进制）' : ''}`);
  return dest;
}
module.exports = { stageRustKernels };
