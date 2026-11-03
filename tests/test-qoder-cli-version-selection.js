'use strict';

// resolveQoder() must use the newest runnable qoderclicn across every known
// install location, not the first hit in path order. The cases below drive
// real temporary shell scripts so the synchronous `--version` probe actually
// executes; fsImpl is narrowed to the temp fixtures so a developer machine's
// own Qoder install cannot influence the result.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveCliCommands } = require('../src/cli-adapters/commands');

const POSIX = process.platform !== 'win32';

function silentLogger() {
  return { log() {}, warn() {} };
}

function writeBin(file, { version, counter } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = ['#!/bin/sh'];
  if (counter) lines.push(`printf x >> '${counter}'`);
  lines.push(`echo '${version}'`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o755 });
}

// Only the listed paths exist. Unlisted paths (this machine's real Qoder
// installs, homebrew, PATH entries) throw ENOENT.
function onlyExistingFs(allowed) {
  const known = new Set(allowed);
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  return {
    statSync(file) {
      if (!known.has(file)) throw missing();
      return fs.statSync(file);
    },
    accessSync(file, mode) {
      if (!known.has(file)) throw missing();
      return fs.accessSync(file, mode);
    },
    readdirSync() {
      throw missing();
    },
  };
}

function resolveQoderWith(homeDir, { env = { PATH: '' }, fsImpl } = {}) {
  return resolveCliCommands({
    isWindows: false,
    env,
    fsImpl,
    homeDir,
    logger: silentLogger(),
  }).qoder;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-qoder-version-'));
try {
  if (POSIX) {
    // 1. Newest version wins over path order: ~/.qoder/bin comes before
    // ~/.qodersec/bin in the candidate list, but the latter is newer.
    const newerHome = path.join(root, 'newer-home');
    const olderBin = path.join(newerHome, '.qoder', 'bin', 'qoderclicn');
    const newerBin = path.join(newerHome, '.qodersec', 'bin', 'qoderclicn');
    writeBin(olderBin, { version: '1.0.2' });
    writeBin(newerBin, { version: '1.0.45' });
    assert.strictEqual(
      resolveQoderWith(newerHome, { fsImpl: onlyExistingFs([olderBin, newerBin]) }),
      newerBin,
      'the newest runnable qoderclicn wins regardless of path order',
    );

    // 2. When no candidate reports a semver, fall back to path order.
    const garbageHome = path.join(root, 'garbage-home');
    const firstGarbage = path.join(garbageHome, '.local', 'bin', 'qoderclicn');
    const secondGarbage = path.join(garbageHome, '.qodersec', 'bin', 'qoderclicn');
    writeBin(firstGarbage, { version: 'no semver here' });
    writeBin(secondGarbage, { version: 'also nothing' });
    assert.strictEqual(
      resolveQoderWith(garbageHome, { fsImpl: onlyExistingFs([firstGarbage, secondGarbage]) }),
      firstGarbage,
      'unparsable versions fall back to the first runnable in path order',
    );

    // 3. Explicit overrides win verbatim and skip version comparison.
    const overrideHome = path.join(root, 'override-home');
    const overrideNewer = path.join(overrideHome, '.qodersec', 'bin', 'qoderclicn');
    writeBin(overrideNewer, { version: '9.9.9' });
    assert.strictEqual(
      resolveQoderWith(overrideHome, {
        env: { PATH: '', QODER_CMD: '/pinned/qoderclicn' },
        fsImpl: onlyExistingFs([overrideNewer]),
      }),
      '/pinned/qoderclicn',
      'QODER_CMD wins verbatim even when a newer install exists',
    );
    assert.strictEqual(
      resolveQoderWith(overrideHome, {
        env: { PATH: '', QODERCN_CMD: '/pinned/qoderclicn-cn' },
        fsImpl: onlyExistingFs([overrideNewer]),
      }),
      '/pinned/qoderclicn-cn',
      'QODERCN_CMD wins verbatim even when a newer install exists',
    );

    // 4. A directory at a candidate path is not runnable and is skipped.
    const dirHome = path.join(root, 'dir-home');
    const emptyDirBin = path.join(dirHome, '.qoder-cn', 'bin', 'qoderclicn');
    fs.mkdirSync(emptyDirBin, { recursive: true });
    const desktopBin = path.join(dirHome, '.qodersec', 'bin', 'qoderclicn');
    writeBin(desktopBin, { version: '1.0.45' });
    assert.strictEqual(
      resolveQoderWith(dirHome, { fsImpl: onlyExistingFs([emptyDirBin, desktopBin]) }),
      desktopBin,
      'an empty directory named qoderclicn is skipped',
    );

    // 5. The version probe is memoized per candidate set: resolving twice must
    // spawn the candidate only once.
    const memoHome = path.join(root, 'memo-home');
    const memoBin = path.join(memoHome, '.qodersec', 'bin', 'qoderclicn');
    const counter = path.join(root, 'memo-probe-count.txt');
    writeBin(memoBin, { version: '1.0.45', counter });
    const memoFs = onlyExistingFs([memoBin]);
    assert.strictEqual(resolveQoderWith(memoHome, { fsImpl: memoFs }), memoBin);
    assert.strictEqual(resolveQoderWith(memoHome, { fsImpl: memoFs }), memoBin);
    assert.strictEqual(fs.readFileSync(counter, 'utf8'), 'x',
      'the version probe runs once per candidate set per process');
  } else {
    console.log('Skipping POSIX shell-script fixtures on Windows');
  }

  console.log('Qoder CLI version selection tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
