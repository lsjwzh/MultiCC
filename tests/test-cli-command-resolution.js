'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  findExecutableOnPath,
  resolveCliCommands,
} = require('../src/cli-adapters/commands');

function makeExecutable(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

function silentLogger() {
  return { log() {}, warn() {} };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cli-commands-'));
try {
  const unixBin = path.join(root, 'unix-bin');
  const unixCommand = path.join(unixBin, 'demo-cli');
  makeExecutable(unixCommand);
  assert.strictEqual(findExecutableOnPath('demo-cli', {
    isWindows: false,
    env: { PATH: unixBin },
  }), unixCommand, 'POSIX PATH lookup returns an executable file');

  const nonExecutable = path.join(unixBin, 'not-runnable');
  fs.writeFileSync(nonExecutable, 'not executable', { mode: 0o644 });
  assert.strictEqual(findExecutableOnPath('not-runnable', {
    isWindows: false,
    env: { PATH: unixBin },
  }), null, 'POSIX PATH lookup rejects files without execute permission');

  const windowsBin = path.join(root, 'windows-bin');
  const windowsCommand = path.join(windowsBin, 'demo.CMD');
  makeExecutable(windowsCommand);
  assert.strictEqual(findExecutableOnPath('demo', {
    isWindows: true,
    env: { Path: windowsBin, PATHEXT: '.BAT;.CMD;.EXE' },
  }), windowsCommand, 'Windows lookup follows case-insensitive Path and PATHEXT order');
  assert.strictEqual(findExecutableOnPath('demo.CMD', {
    isWindows: true,
    env: { PATH: windowsBin, PATHEXT: '.EXE;.CMD' },
  }), windowsCommand, 'Windows lookup does not append PATHEXT twice');

  const overrideEnv = {
    PATH: '',
    CLAUDE_CMD: '/custom/claude --flag',
    CODEX_CMD: '/custom/codex',
    OPENCODE_CMD: '/custom/opencode',
    ZCODE_CMD: '/custom/zcode',
    QODER_CMD: '/custom/qoderclicn',
  };
  assert.deepStrictEqual(resolveCliCommands({
    isWindows: false,
    env: overrideEnv,
    homeDir: path.join(root, 'empty-home'),
    logger: silentLogger(),
  }), {
    claude: '/custom/claude --flag',
    codex: '/custom/codex',
    opencode: '/custom/opencode',
    zcode: '/custom/zcode',
    qoder: '/custom/qoderclicn',
  }, 'explicit command overrides are returned verbatim');

  const missingFs = {
    accessSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    statSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    readdirSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  };
  assert.deepStrictEqual(resolveCliCommands({
    isWindows: false,
    env: { PATH: '' },
    fsImpl: missingFs,
    homeDir: path.join(root, 'missing-home'),
    logger: silentLogger(),
  }), {
    claude: 'claude', codex: 'codex', opencode: 'opencode', zcode: 'zcode', qoder: 'qoderclicn',
  }, 'POSIX fallback names remain stable when no executable exists');
  assert.deepStrictEqual(resolveCliCommands({
    isWindows: true,
    env: { PATH: '', PATHEXT: '.EXE;.CMD' },
    fsImpl: missingFs,
    homeDir: path.join(root, 'missing-home'),
    logger: silentLogger(),
  }), {
    claude: 'claude.exe', codex: 'codex.exe', opencode: 'opencode.exe', zcode: 'zcode.exe', qoder: 'qoderclicn.exe',
  }, 'Windows fallback names remain stable when no executable exists');

  const source = fs.readFileSync(require.resolve('../src/cli-adapters/commands'), 'utf8');
  assert.ok(!/\b(?:execSync|execFileSync|spawnSync)\b/.test(source), 'command resolution uses no synchronous child process');

  console.log('CLI command resolution tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
