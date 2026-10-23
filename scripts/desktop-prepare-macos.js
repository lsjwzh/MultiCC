'use strict';

// Apple inspects executables inside gzip resources, while the macOS signer
// only sees files on disk. Expand plugin Mach-O payloads before signing the
// copied app. The plugin already supports plain executables next to itself.
const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');

function isMachO(buffer) {
  return buffer.length >= 8 && [0xfeedface, 0xcefaedfe, 0xfeedfacf,
    0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]
    .includes(buffer.readUInt32BE(0));
}

function prepareMacOSPluginBinaries(resourcesDir) {
  const plugins = path.join(resourcesDir, 'app-server', 'plugins');
  const expanded = [];
  if (!fs.existsSync(plugins)) return expanded;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.gz')) {
        const binary = gunzipSync(fs.readFileSync(file), { maxOutputLength: 128 * 1024 * 1024 });
        if (!isMachO(binary)) continue;
        const target = file.slice(0, -3);
        if (fs.existsSync(target) && !fs.readFileSync(target).equals(binary)) {
          throw new Error(`compressed plugin executable conflicts with ${target}`);
        }
        fs.writeFileSync(target, binary);
        fs.chmodSync(target, 0o755);
        fs.unlinkSync(file);
        expanded.push(target);
      }
    }
  };
  for (const plugin of fs.readdirSync(plugins, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const bin = path.join(plugins, plugin.name, 'bin');
    if (fs.existsSync(bin) && fs.lstatSync(bin).isDirectory()) walk(bin);
  }
  return expanded;
}

module.exports = { prepareMacOSPluginBinaries };
