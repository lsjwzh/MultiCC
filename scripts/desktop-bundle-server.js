#!/usr/bin/env node
'use strict';

// Stage a self-contained copy of the MultiCC server for the desktop build
// (electron-builder extraResources). The staged tree is what the packaged app
// runs via ELECTRON_RUN_AS_NODE, so it must contain everything the server
// touches at runtime and nothing that belongs to development:
//
//   in:  server.js  src/  public/ (minus the 62MB APK + its metadata)  plugins/
//        scripts/multicc-router-mcp.js
//        package.json transformed — sherpa-onnx-node moves from dependencies
//        to optionalDependencies so a platform without its prebuilt binary
//        still installs (the server degrades to cloud ASR; see src/asr-local.js)
//   out: <out>/node_modules via `npm install --omit=dev` (not npm ci — the
//        dependency transform intentionally desyncs the lock)
//
// Run with --no-install to stage without network access (tests do this).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OPTIONAL_AT_RUNTIME = ['sherpa-onnx-node'];
const PUBLIC_EXCLUDE = [/^multicc\.apk(\..*)?$/];

function parseArgs(argv) {
  const args = { out: null, repoRoot: null, install: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--repo-root') args.repoRoot = argv[++i];
    else if (argv[i] === '--install') args.install = true;
    else if (argv[i] === '--no-install') args.install = false;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else { console.error(`unknown argument: ${argv[i]}`); process.exit(2); }
  }
  return args;
}

function copyTree(src, dest, { filter } = {}) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (srcPath) => {
      const base = path.basename(srcPath);
      if (filter && filter.some(re => re.test(base))) return false;
      return true;
    },
  });
}

function transformPackageJson(pkg) {
  const dependencies = { ...(pkg.dependencies || {}) };
  const optionalDependencies = { ...(pkg.optionalDependencies || {}) };
  for (const name of OPTIONAL_AT_RUNTIME) {
    if (dependencies[name]) {
      optionalDependencies[name] = dependencies[name];
      delete dependencies[name];
    }
  }
  return {
    name: pkg.name,
    version: pkg.version,
    private: true,
    description: pkg.description,
    engines: pkg.engines,
    dependencies,
    optionalDependencies,
    // The desktop shell owns process lifecycle; the manager script is not
    // used inside the packaged app (restart/update are gated server-side).
    scripts: { start: 'node server.js' },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: desktop-bundle-server.js [--out <dir>] [--repo-root <dir>] [--no-install]');
    process.exit(0);
  }
  const repoRoot = path.resolve(args.repoRoot || path.join(__dirname, '..'));
  const out = path.resolve(args.out || path.join(repoRoot, 'desktop', '.staging', 'app-server'));

  console.log(`[desktop-bundle-server] staging ${repoRoot} -> ${out}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  // 1) source trees the server reads at runtime. plugins/ is not optional:
  //   server.js requires ./plugins/bridges/* at boot (caught by the local
  //   real-server smoke, not by the sentinel list alone).
  for (const entry of ['server.js', 'src', 'public', 'plugins', 'skills']) {
    const src = path.join(repoRoot, entry);
    if (!fs.existsSync(src)) throw new Error(`missing ${src} — run from the repo root`);
    if (entry === 'public') copyTree(src, path.join(out, 'public'), { filter: PUBLIC_EXCLUDE });
    else copyTree(src, path.join(out, entry));
  }
  // 2) the single script src/ spawns out of the repo tree (router MCP child)
  fs.mkdirSync(path.join(out, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'multicc-router-mcp.js'),
    path.join(out, 'scripts', 'multicc-router-mcp.js'));
  // 3) transformed manifest, then production deps
  fs.writeFileSync(path.join(out, 'package.json'),
    `${JSON.stringify(transformPackageJson(rootPkg), null, 2)}\n`);

  if (args.install) {
    console.log('[desktop-bundle-server] installing production dependencies…');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const res = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: out, stdio: 'inherit',
    });
    if (res.status !== 0) throw new Error(`npm install failed with status ${res.status}`);
  } else {
    console.log('[desktop-bundle-server] --no-install: skipping dependency install');
  }

  // 4) sanity gate — a silent missing file here becomes "app won't start" there
  for (const must of ['server.js', 'src/paths.js', 'public/manage.html', 'public/chat.html',
    'scripts/multicc-router-mcp.js', 'plugins/bridges/wechat-ilink.js',
    'skills/multicc-artifact/references/registration-rule.md',
    ...(args.install ? [path.join('node_modules', 'express')] : [])]) {
    if (!fs.existsSync(path.join(out, must))) throw new Error(`staged copy is missing ${must}`);
  }
  const staged = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
  for (const name of OPTIONAL_AT_RUNTIME) {
    if (staged.dependencies[name]) throw new Error(`${name} must be optional in the staged manifest`);
  }
  const versionMatch = staged.version === rootPkg.version;
  console.log(`[desktop-bundle-server] done (version ${staged.version}${versionMatch ? '' : ` — MISMATCH vs root ${rootPkg.version}`}, install=${args.install})`);
  if (!versionMatch) process.exit(1);
}

try { main(); } catch (error) {
  console.error(`[desktop-bundle-server] ${error.message}`);
  process.exit(1);
}
