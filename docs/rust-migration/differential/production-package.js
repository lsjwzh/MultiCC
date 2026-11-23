'use strict';

// Run from a checkout. npm computes the real package file list, including
// forced inclusions and ignore rules. Cargo metadata checks the available bins.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const cwd = path.resolve(__dirname, '../../..');
const read = file => JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8'));
const pkg = read('package.json');
const lock = read('package-lock.json');
const command = (bin, args) => execFileSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const pack = process.env.npm_execpath
  ? command(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--json'])
  : command(process.platform === 'win32' ? 'cmd.exe' : 'npm',
      process.platform === 'win32' ? ['/d', '/c', 'npm pack --dry-run --json'] : ['pack', '--dry-run', '--json']);
const [archive] = JSON.parse(pack);
const files = archive.files.map(f => f.path);
const hostFiles = files.filter(name => /^(?:server\.js$|src\/|node_modules\/|runtime\/|scripts\/start-gateway\.js$)/.test(name));
assert.deepEqual(hostFiles, []);
const webAsset = /^(?:public|plugins\/[^/]+\/(?:ui|public))\//;
assert.deepEqual(files.filter(name => /\.(?:[cm]?js|node)$/.test(name) && !webAsset.test(name)), []);
assert.deepEqual(files.filter(name => /(?:^|\/)(?:node(?:\.exe)?|npm(?:\.cmd)?)$/.test(name)), []);
for (const document of ['docs/gateway.md', 'docs/rust-migration/production-entry-2026-11-24.md',
  'docs/rust-migration/remaining-node-checklist.md', 'docs/rust-migration/node-module-dependencies.md']) {
  assert.ok(files.includes(document), 'missing deployment document ' + document);
}
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
  assert.equal(Object.keys(pkg[field] || {}).length, 0, 'package.json ' + field);
  assert.equal(Object.keys(lock.packages[''][field] || {}).length, 0, 'package-lock.json ' + field);
}
const prodPackages = Object.entries(lock.packages).filter(([key, spec]) => key && !spec.dev);
assert.equal(prodPackages.length, 0, 'production lockfile graph');
assert.equal(pkg.scripts.start, 'native/target/release/multicc-gateway serve --cwd . --no-node');
assert.equal(pkg.scripts['start:gateway'], pkg.scripts.start);
const required = ['multicc-gateway', 'multicc-writer', 'restart-supervisor', 'multicc-remote', 'multicc-cdpd'];
const metadata = JSON.parse(command('cargo', ['metadata', '--no-deps', '--locked', '--format-version', '1',
  '--manifest-path', 'native/Cargo.toml']));
const defaultMembers = metadata.workspace_default_members;
const addon = metadata.packages.find(pkg => pkg.name === 'multicc-addon');
assert.ok(addon && !defaultMembers.includes(addon.id), 'default Cargo build includes the compatibility addon');
const producers = metadata.packages.filter(pkg => pkg.targets.some(t => t.kind.includes('bin') && required.includes(t.name)));
for (const pkg of producers) assert.ok(defaultMembers.includes(pkg.id), pkg.name + ' missing from default Cargo build');
const tree = command('cargo', ['tree', '--locked', '--manifest-path', 'native/Cargo.toml', '--edges', 'normal',
  '--prefix', 'none', ...metadata.packages.filter(pkg => defaultMembers.includes(pkg.id)).flatMap(pkg => ['-p', pkg.name])]);
const nativeNodeDependencies = tree.split('\n').filter(line => /^(?:napi|nodejs|libnode|node-bindgen|neon)(?:-|\s)/.test(line));
assert.deepEqual(nativeNodeDependencies, [], 'production Rust dependencies');
for (const name of required) {
  const target = metadata.packages.flatMap(p => p.targets).find(t => t.kind.includes('bin') && t.name === name);
  assert.ok(target && files.includes(path.relative(cwd, target.src_path).split(path.sep).join('/')), name);
  assert.ok(pkg.scripts['build:production'].split(' --bin ').slice(1).includes(name), name + ' build selection');
}
console.log(JSON.stringify({ files: files.length, hostFiles: hostFiles.length, productionNodePackages: prodPackages.length, nativeNodeDependencies: nativeNodeDependencies.length, binaries: required }));
