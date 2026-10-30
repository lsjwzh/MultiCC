'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hasRemoteCrate, hasCdpdCrate, remoteBinaryName, cdpdBinaryName, verify } = require('./build-rust-kernels');

// 和原生模块同目录的可执行件。服务端只在模块旁边找它们（远控见
// docs/remote-screen-process.md §1，网关见 src/cdpd.js binaryPath），所以打包必须
// 一起搬：少一个就是「🖥 屏幕」或浏览器网关在用户机器上悄悄消失，而不是在打包时
// 报错。v2.12.0 的安装包就是这样只带了远控、漏了 multicc-cdpd。
const COMPANIONS = [
  { label: '远控二进制', crate: 'native/remote', inWorkspace: hasRemoteCrate, binaryName: remoteBinaryName,
    missing: '打包缺少远控二进制' },
  { label: 'CDP 网关', crate: 'native/cdpd', inWorkspace: hasCdpdCrate, binaryName: cdpdBinaryName,
    missing: '打包缺少 CDP 网关 multicc-cdpd' },
];

// Electron 和 standalone 共用。只复制目标架构，禁止宿主二进制冒充交叉构建产物。
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

  const staged = [];
  for (const companion of COMPANIONS) {
    const binary = companion.binaryName(platform);
    const companionSource = path.join(root, `${platform}-${arch}`, binary);
    if (!fs.existsSync(companionSource)) {
      // crate 落地前，仓库里的产物本来就没有它；这不是打包缺件。
      if (companion.inWorkspace(repoRoot)) throw new Error(`${companion.missing}：${platform}-${arch}`);
      logger.log(`[Rust] ${companion.crate} 尚未加入 cargo workspace，跳过${companion.label}`);
      continue;
    }
    verify(companionSource, platform, arch);
    const target = path.join(path.dirname(dest), binary);
    fs.copyFileSync(companionSource, target);
    // 权限位决定解包/签名链路上还能不能执行：Windows 不认这一位，其余平台必须显式给。
    if (platform !== 'win32') fs.chmodSync(target, 0o755);
    staged.push(companion.label);
  }
  logger.log(`[Rust] 已打包 ${platform}-${arch}${staged.length ? `（${['模块', ...staged].join(' + ')}）` : ''}`);
  return dest;
}
module.exports = { stageRustKernels };
