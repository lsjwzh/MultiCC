'use strict';

// Rust owns catalogue queries and frozen snapshots. The JS host keeps the
// fs watcher so callers can release their own watchFile listener.
const fs = require('node:fs');
const path = require('node:path');
const { getNative } = require('../native/binding');
const native = getNative();
const catalog = native.cliCatalogViews();

async function watchEffortCatalog(file) {
  const reload = () => native.cliReloadEffortCatalog(file)
    .then(catalog.refreshEfforts)
    .catch(err => console.warn('[multicc] 强度目录缓存不可用：', err.message));
  fs.watchFile(file, { persistent: false, interval: 1000 }, reload);
  await reload();
  return () => fs.unwatchFile(file, reload);
}

// 从本模块解析平台包，兼容 npm 提升安装和包的 exports 规则。
function bundledClaudeCodeBinary() {
  return native.cliBundledClaudeBinary(process.env.MULTICC_CLAUDE_BIN, process.platform,
    process.arch, require.resolve, path, fs.existsSync);
}

module.exports = {
  bundledClaudeCodeBinary,
  ...catalog.api,
  get EFFORTS() { return catalog.efforts(); },
  watchEffortCatalog,
  knownEffort: level => native.cliKnownEffort(level),
  supportsEffort: (cli, model, level) => native.cliSupportsEffort(cli, model || '', level),
};
