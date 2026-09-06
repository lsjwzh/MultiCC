#!/usr/bin/env node
'use strict';

// Post-build release hygiene for desktop artifacts (see desktop/lib/release-artifacts.js
// for the conventions). Globs the installers electron-builder produced, validates
// their names against the stable multicc-desktop-<version>-<platform>-<arch>.<ext>
// scheme, writes digest-only .sha256 sidecars (same convention as
// public/multicc.apk.sha256), a consolidated SHA256SUMS.txt, and a SIGNING-STATUS.txt
// that states plainly whether the macOS build is signed — never implying a
// signature that a missing secret quietly skipped.

const fs = require('fs');
const path = require('path');
const { prepareReleaseAssets } = require('../desktop/lib/release-artifacts');

const INSTALLER_EXTS = ['.dmg', '.exe', '.AppImage', '.deb'];

function parseArgs(argv) {
  const args = { dir: null, platform: null, version: null, signingStatus: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--platform') args.platform = argv[++i];
    else if (argv[i] === '--version') args.version = argv[++i];
    else if (argv[i] === '--signing-status') args.signingStatus = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else { console.error(`unknown argument: ${argv[i]}`); process.exit(2); }
  }
  if (args.help) {
    console.log('usage: desktop-release-assets.js --dir <dist> --platform <macos|windows|linux> --version <x.y.z> --signing-status "<text>"');
    process.exit(0);
  }
  for (const key of ['dir', 'platform', 'version', 'signingStatus']) {
    if (!args[key]) { console.error(`--${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())} is required`); process.exit(2); }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(args.dir);
  const files = fs.readdirSync(dir)
    .filter(name => INSTALLER_EXTS.some(ext => name.endsWith(ext)))
    .filter(name => !name.endsWith('.blockmap'))
    .map(name => path.join(dir, name));
  if (!files.length) throw new Error(`no installer artifacts found in ${dir}`);

  const entries = prepareReleaseAssets({
    files,
    version: args.version,
    platform: args.platform,
    manifestDir: dir,
  });

  fs.writeFileSync(path.join(dir, 'SIGNING-STATUS.txt'),
    `platform: ${args.platform}\nversion: ${args.version}\nstatus: ${args.signingStatus}\n` +
    `Verify downloads against SHA256SUMS.txt (sha256sum -c SHA256SUMS.txt).\n`);

  for (const e of entries) console.log(`[desktop-release-assets] ${e.name}  ${e.digest}`);
  console.log(`[desktop-release-assets] signing status: ${args.signingStatus}`);
}

try { main(); } catch (error) {
  console.error(`[desktop-release-assets] ${error.message}`);
  process.exit(1);
}
