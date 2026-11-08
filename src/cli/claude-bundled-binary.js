'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 内置引擎自带的 Claude Code 二进制: SDK 按「每个平台一个 optionalDependency」
// 发布(@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude), 那份可执行文件
// 就是 chat 车道实际跑的引擎 —— 它的 `--version` 才是「MultiCC 现在能给的版本」。
// 解析不到(依赖被裁剪 / 平台包没装)就当未知, 绝不抛。
//
// The `@anthropic-ai/claude-agent-sdk` package itself is no longer executed: the
// lane speaks its stdio protocol natively. The dependency stays in package.json
// because it is the source of this per-platform binary.
function bundledClaudeCodeBinary() {
  const override = process.env.MULTICC_CLAUDE_BIN;
  if (override && fs.existsSync(override)) return override;
  const platform = process.platform;
  const arch = process.arch;
  const names = [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`];
  if (platform === 'linux') names.push(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}-musl`);
  for (const name of names) {
    try {
      const dir = path.dirname(require.resolve(`${name}/package.json`));
      const binary = path.join(dir, platform === 'win32' ? 'claude.exe' : 'claude');
      if (fs.existsSync(binary)) return binary;
    } catch (_) { /* 试下一个布局 */ }
  }
  return null;
}

module.exports = { bundledClaudeCodeBinary };
