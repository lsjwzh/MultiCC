#!/usr/bin/env node
'use strict';

// Read the target architecture and container format out of a compiled binary
// (Mach-O, ELF or PE) so a packaging step can prove it staged the binary it
// meant to: arch alone still lets a linux-x64 .so pass inside a darwin-x64
// bundle.
//
// Why this is a gate and not a nicety: a native module built for the build
// host still installs and still looks present. The x64 macOS desktop dmg was
// assembled on an Apple Silicon runner with arm64 better-sqlite3 inside, and
// only the first `new Database()` on an Intel Mac would have failed. Absence
// is easy to see; the wrong architecture is not.

const fs = require('fs');
const path = require('path');

const MACO_CPUS = { 7: 'ia32', 0x01000007: 'x64', 12: 'arm', 0x0100000c: 'arm64' };
const ELF_MACHINES = { 0x03: 'ia32', 0x28: 'arm', 0x3e: 'x64', 0xb7: 'arm64' };
const PE_MACHINES = { 0x014c: 'ia32', 0x01c0: 'arm', 0x01c4: 'arm', 0x8664: 'x64', 0xaa64: 'arm64' };

function machoArch(buffer) {
  if (buffer.length < 8) return null;
  const magic = buffer.readUInt32LE(0);
  // Universal binaries carry nfat_arch entries; callers that need per-slice
  // detail should thin the file first.
  if (magic === 0xbebafeca || magic === 0xcafebabe) return 'universal';
  if (magic !== 0xfeedfacf && magic !== 0xfeedface) return null;
  return MACO_CPUS[buffer.readUInt32LE(4)] || 'unknown';
}

function elfArch(buffer) {
  if (buffer.length < 20) return null;
  if (buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) return null;
  const littleEndian = buffer[5] === 1;
  const machine = littleEndian ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18);
  return ELF_MACHINES[machine] || 'unknown';
}

function peArch(buffer) {
  if (buffer.length < 0x40) return null;
  if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) return null; // 'MZ'
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length) return null;
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) return null; // 'PE\0\0'
  return PE_MACHINES[buffer.readUInt16LE(peOffset + 4)] || 'unknown';
}

function readHead(file, { readBytes = 4096 } = {}) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(readBytes);
    const bytes = fs.readSync(handle, buffer, 0, readBytes, 0);
    return buffer.subarray(0, bytes);
  } catch (_) {
    return null;
  } finally {
    if (handle !== undefined) { try { fs.closeSync(handle); } catch (_) {} }
  }
}

function nativeBinaryArch(file, { readBytes = 4096 } = {}) {
  const head = readHead(file, { readBytes });
  if (!head) return 'unreadable';
  return machoArch(head) || elfArch(head) || peArch(head) || 'unknown';
}

// Which OS can load this file: darwin | linux | win32 | null (not a compiled
// binary). The arch parsers already know the magic, so reuse them as detectors
// — 'unknown'/'universal' still mean "yes, that format".
function nativeBinaryPlatform(file, { readBytes = 4096 } = {}) {
  const head = readHead(file, { readBytes });
  if (!head) return 'unreadable';
  if (machoArch(head)) return 'darwin';
  if (elfArch(head)) return 'linux';
  if (peArch(head)) return 'win32';
  return null;
}

// Every compiled addon under a staged tree. Sources and downloaded prebuild
// archives are skipped: only what the loader can actually require() counts.
function collectNativeBinaries(root, { skipDirs = new Set(['src', 'deps', 'prebuilds']) } = {}) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(full);
      } else if (/\.(node|so|dylib|dll)$/i.test(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found.sort();
}

function verifyNativeArch({ root, arch, platform, allowNone = false, logger = console } = {}) {
  const binaries = collectNativeBinaries(root);
  const mismatches = [];
  const summary = [];
  for (const file of binaries) {
    const found = nativeBinaryArch(file);
    const relative = path.relative(root, file);
    const format = platform ? nativeBinaryPlatform(file) : null;
    summary.push(`${relative}: ${found}${format ? ` (${format})` : ''}`);
    if (found !== arch) mismatches.push({ file: path.relative(root, file), found });
    else if (platform && format !== platform) {
      mismatches.push({ file: relative, found: `${format || 'not-a-binary'} file` });
    }
  }
  for (const line of summary) logger.log(`[native-arch] ${line}`);
  if (!binaries.length && !allowNone) {
    throw new Error(`no native binaries under ${root} — the packaging step silently produced nothing`);
  }
  if (mismatches.length) {
    const detail = mismatches.map(m => `${m.file} (${m.found})`).join(', ');
    throw new Error(`expected ${platform ? `${platform}/` : ''}${arch} native binaries, found: ${detail}`);
  }
  logger.log(`[native-arch] OK — ${binaries.length} binary/binaries match ${arch}`);
  return { count: binaries.length, mismatches, summary };
}

function parseArgs(argv) {
  const args = { root: null, arch: null, platform: null, allowNone: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') args.root = argv[++i];
    else if (arg === '--expect-arch') args.arch = argv[++i];
    else if (arg === '--expect-platform') args.platform = argv[++i];
    else if (arg === '--allow-none') args.allowNone = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (!args.root) args.root = arg;
    else { console.error(`unknown argument: ${arg}`); process.exit(2); }
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.root || !args.arch) {
    console.log('usage: native-arch.js --root <dir> --expect-arch <x64|arm64> [--expect-platform darwin|linux|win32] [--allow-none]');
    return args.help ? 0 : 2;
  }
  if (!fs.existsSync(args.root)) {
    console.error(`[native-arch] ${args.root} does not exist`);
    return 1;
  }
  try {
    verifyNativeArch(args);
    return 0;
  } catch (error) {
    console.error(`[native-arch] ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  ELF_MACHINES,
  MACO_CPUS,
  PE_MACHINES,
  collectNativeBinaries,
  elfArch,
  machoArch,
  main,
  nativeBinaryArch,
  nativeBinaryPlatform,
  parseArgs,
  peArch,
  readHead,
  verifyNativeArch,
};
