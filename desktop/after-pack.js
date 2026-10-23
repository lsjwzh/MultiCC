'use strict';

// Run for local electron-builder builds too, before signing or installer
// creation. CI additionally checks the final Resources tree after packaging.
module.exports = context => {
  const { Arch } = require('builder-util');
  const { verifyDesktopResources } = require('../scripts/desktop-verify-resources');
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  if (context.packager.platform.nodeName === 'darwin') {
    const { prepareMacOSPluginBinaries } = require('../scripts/desktop-prepare-macos');
    prepareMacOSPluginBinaries(resourcesDir);
  }
  return verifyDesktopResources({
    resourcesDir,
    execute: context.packager.platform.nodeName === process.platform
      && Arch[context.arch] === process.arch,
  });
};
