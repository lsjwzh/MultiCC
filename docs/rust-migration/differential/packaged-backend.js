'use strict';

// Inspect an unpacked standalone bundle or Electron Resources directory.
// Read only release manifests and paths. There is no need to launch its backend.
const fs = require('node:fs');
const path = require('node:path');
const resources = path.resolve(process.argv[2] || '.');
const read = name => JSON.parse(fs.readFileSync(path.join(resources, name), 'utf8'));
const manifest = read('bundle-manifest.json');
const host = fs.existsSync(path.join(resources, 'app-server/package.json')) ? read('app-server/package.json') : {};
const files = [];
const links = [];
function walk(relative) {
  for (const entry of fs.readdirSync(path.join(resources, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) walk(child);
    else if (entry.isSymbolicLink()) links.push(child);
    else if (entry.isFile()) files.push(child);
  }
}
if (!fs.statSync(path.join(resources, 'app-server')).isDirectory()) throw Error('missing staged server');
for (const dir of ['app-server', 'launcher', 'runtime']) {
  if (fs.existsSync(path.join(resources, dir))) walk(dir);
}
files.sort();
links.sort();
const embedded = files.filter(p => /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(p))
  .map(file => { const { name, version } = read(file); return { file, name, version }; });
const js = files.filter(p => /\.[cm]?js$/.test(p) && !p.includes('/node_modules/'));
const browser = js.filter(p => /^app-server\/(?:public|plugins\/[^/]+\/(?:ui|public|extension))\//.test(p));
const pluginTests = js.filter(p => /^app-server\/plugins\/[^/]+\/tests\//.test(p));
const osascript = js.filter(p => p === 'app-server/plugins/chrome-proxy-launcher/src/dock_badge_macos.js');
const skillScripts = js.filter(p => p.startsWith('app-server/skills/'));
const otherScripts = new Set([...browser, ...skillScripts, ...pluginTests, ...osascript]);
const hostScripts = js.filter(p => !otherScripts.has(p));
const modules = hostScripts.filter(p => p.startsWith('app-server/src/'));
const hostPackages = embedded.filter(pkg => pkg.file.startsWith('app-server/'));
const runtimePackages = embedded.filter(pkg => pkg.file.startsWith('runtime/'));
const nativeAddons = files.filter(p => p.endsWith('.node'));
const node = manifest.platform === 'win32' ? 'runtime/node.exe' : 'runtime/bin/node';
const nodeShebangs = files.filter(p => {
  if (p.startsWith('runtime/') || p.includes('/node_modules/')) return false;
  const fd = fs.openSync(path.join(resources, p), 'r');
  try {
    const head = Buffer.alloc(128);
    const count = fs.readSync(fd, head, 0, head.length, 0);
    return /^#![^\r\n]*[ /]node(?:\s|$)/.test(head.toString('utf8', 0, count));
  } finally { fs.closeSync(fd); }
});
console.log(JSON.stringify({
  version: manifest.version, platform: manifest.platform, arch: manifest.arch,
  runtime: { file: files.includes(node) ? node : null, version: manifest.nodeVersion, source: manifest.nodeRuntime,
    commands: [...files, ...links].filter(p => /^runtime\/(?:bin\/[^/]+|[^/]+\.(?:exe|cmd))$/.test(p)).sort() },
  serverStart: host.scripts?.start || null,
  declared: { required: host.dependencies || {}, optional: host.optionalDependencies || {} },
  counts: { hostSource: modules.length, otherHostScripts: hostScripts.length - modules.length,
    browserScripts: browser.length, skillScripts: skillScripts.length, pluginTests: pluginTests.length, osascript: osascript.length,
    hostPackageLocations: hostPackages.length, runtimePackageLocations: runtimePackages.length,
    nativeAddons: nativeAddons.length },
  hostScripts, skillScripts, pluginTests, osascript, nodeShebangs, nativeAddons, hostPackages, runtimePackages,
}, null, 2));
