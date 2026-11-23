'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { gatewayBinary } = require('../../desktop/lib/desktop-env');

module.exports = function stageDesktopKernels(root, appServer) {
  const source = gatewayBinary({ serverDir: root });
  const target = gatewayBinary({ serverDir: appServer, env: {} });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
  const addon = process.env.MULTICC_RUST_ADDON || path.join(path.dirname(source), 'multicc_core.node');
  fs.copyFileSync(addon, path.join(path.dirname(target), 'multicc_core.node'), fs.constants.COPYFILE_FICLONE);
};
