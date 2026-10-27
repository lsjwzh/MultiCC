'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { verify } = require('./build-rust-kernels');
const { binaryFileName, compiledPlugins, platformDir } = require('./build-plugin-binaries');

// Electron 和 standalone 共用（desktop-bundle-server.js 复制完 plugins/ 之后调用）。
// 每个需要编译的内置插件只留目标平台那一个 bin/<platform>-<arch>/：别的平台
// 的二进制在这台机器上没用，本机编译缓存 target/ 更不能进包。
//
// 发版（MULTICC_REQUIRE_RUST_BUNDLE=1）缺目标平台二进制直接失败——否则用户装完
// 只会在插件面板看到「插件二进制缺失」。本地打包/测试只告警，不拦。
function stagePluginBinaries({ repoRoot, out, npmEnv = {}, require: required = process.env.MULTICC_REQUIRE_RUST_BUNDLE === '1',
  logger = console }) {
  const platform = npmEnv.npm_config_platform || process.platform;
  const arch = npmEnv.npm_config_arch || process.arch;
  const staged = [];
  for (const plugin of compiledPlugins(repoRoot)) {
    const relative = path.relative(repoRoot, plugin.dir);
    const stagedPlugin = { ...plugin, dir: path.join(out, relative) };
    fs.rmSync(path.join(stagedPlugin.dir, 'target'), { recursive: true, force: true });

    const name = binaryFileName(plugin.manifest.engine.binary, platform);
    const binary = path.join(platformDir(stagedPlugin, platform, arch), name);
    if (!fs.existsSync(binary)) {
      const message = `打包缺少插件 ${plugin.id} 的 ${platform}-${arch} 二进制（先执行 node scripts/build-plugin-binaries.js --platform ${platform} --arch ${arch}）`;
      if (required) throw new Error(message);
      logger.log(`[plugins] 警告：${message}`);
      continue;
    }
    verify(binary, platform, arch);
    if (platform !== 'win32') fs.chmodSync(binary, 0o755);

    const binRoot = path.dirname(platformDir(stagedPlugin, platform, arch));
    for (const entry of fs.readdirSync(binRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== `${platform}-${arch}`) {
        fs.rmSync(path.join(binRoot, entry.name), { recursive: true, force: true });
      }
    }
    staged.push(binary);
    logger.log(`[plugins] 已打包 ${plugin.id} ${platform}-${arch}`);
  }
  return staged;
}

module.exports = { stagePluginBinaries };
