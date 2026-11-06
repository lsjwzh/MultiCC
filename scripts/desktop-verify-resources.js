#!/usr/bin/env node
'use strict';

// Check the installed Resources tree, after electron-builder has copied it.
// Its file filter skips a source's root node_modules even with **/*, so a
// staging check alone cannot prove the packaged server still has dependencies.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');
const { targetFor, verify: verifyRustBinary } = require('./build-rust-kernels');

function verifyServerDependencies(appServerDir) {
  const root = fs.realpathSync(appServerDir);
  const requireServer = createRequire(path.join(root, 'server.js'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return Object.keys(pkg.dependencies || {}).map(name => {
    let entry;
    try { entry = fs.realpathSync(requireServer.resolve(name)); }
    catch (error) { throw new Error(`packaged server dependency ${name} is missing: ${error.message}`); }
    const relative = path.relative(path.join(root, 'node_modules'), entry);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`packaged server dependency ${name} resolves outside its node_modules: ${entry}`);
    }
    return { name, entry };
  });
}

function verifyDesktopResources({ resourcesDir, execute = true, timeoutMs = 60_000 } = {}) {
  const resources = path.resolve(resourcesDir);
  for (const rel of ['app-server/server.js', 'app-server/package.json',
    'launcher/standalone-cli.js', 'launcher/standalone-launcher.js', 'bundle-manifest.json']) {
    if (!fs.existsSync(path.join(resources, rel))) throw new Error(`packaged Resources is missing ${rel}`);
  }
  const runtimeNode = ['runtime/bin/node', 'runtime/node.exe']
    .map(rel => path.join(resources, rel)).find(file => fs.existsSync(file));
  if (!runtimeNode) throw new Error('packaged Resources is missing the bundled Node runtime');
  const appServerDir = path.join(resources, 'app-server');
  const dependencies = verifyServerDependencies(appServerDir);
  // Cross-arch builds cannot load the addon, but must still prove the final
  // copied tree contains the binary for the manifest's target.
  const { platform, arch } = JSON.parse(fs.readFileSync(path.join(resources, 'bundle-manifest.json'), 'utf8'));
  targetFor(platform, arch);
  const rustFile = path.join(appServerDir, 'native/prebuilt', `${platform}-${arch}`, 'multicc_core.node');
  if (!fs.existsSync(rustFile)) throw new Error(`packaged Resources is missing Rust SQLite: ${platform}-${arch}`);
  verifyRustBinary(rustFile, platform, arch);
  if (execute) {
    // Resolve from the packaged server, not this script or the build checkout.
    // Loading CPR also checks its transitive imports; the packaged Rust SQLite
    // must open and execute a transaction. ESM-only dependencies are covered by
    // resolution rather than CommonJS require().
    const script = `const r = require('module').createRequire(${JSON.stringify(path.join(appServerDir, 'server.js'))});
      if (r('@iarna/toml').parse('value = 1').value !== 1) throw new Error('TOML parse failed');
      if (!/^1\\./.test(r('cli-provider-router').API_VERSION || '')) throw new Error('CPR API major 1 required');
      let cpr;
      try { cpr = r('./src/native/runtime').getNative(); } catch (_) { throw new Error('Rust SQLite / CPR module unavailable'); }
      if (cpr.cprProtocolVersion?.() !== 1 || typeof cpr.cprCreateExchange !== 'function') throw new Error('Rust CPR module required');
      const db = new (r('./src/sqlite/driver').databaseConstructor())(':memory:');
      if (db.backend !== 'rust') throw new Error('Rust SQLite required');
      db.exec('create table smoke(x); create virtual table f using fts5(x)');
      db.transaction(() => db.prepare('insert into smoke values (?)').run('rust'))();
      if (db.prepare('select x from smoke').get().x !== 'rust') throw new Error('SQLite smoke failed');
      db.close();`;
    const result = spawnSync(runtimeNode, ['--disable-warning=ExperimentalWarning', '-e', script],
      { cwd: appServerDir, encoding: 'utf8', timeout: timeoutMs,
        env: { ...process.env, MULTICC_RUST_ADDON: '', MULTICC_RUST_PREBUILT_DIR: '' } });
    if (result.error || result.status !== 0) {
      throw new Error(`packaged runtime dependency smoke failed: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`);
    }
  }
  return { dependencies, executed: execute };
}

function main(argv = process.argv.slice(2)) {
  let resourcesDir;
  let execute = true;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--resources') resourcesDir = argv[++i];
    else if (argv[i] === '--no-execute') execute = false;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!resourcesDir) throw new Error('usage: desktop-verify-resources.js --resources <dir> [--no-execute]');
  const result = verifyDesktopResources({ resourcesDir, execute });
  console.log(`[desktop-verify-resources] ${result.dependencies.length} packaged dependencies verified; runtime smoke ${result.executed ? 'passed' : 'skipped (cross-arch)'}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`[desktop-verify-resources] ${error.message}`); process.exitCode = 1; }
}

module.exports = { verifyServerDependencies, verifyDesktopResources, main };
