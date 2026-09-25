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
    KIMI_CMD: '/custom/kimi',
    CODEBUDDY_CMD: '/custom/codebuddy',
    DSH_CMD: '/custom/dsh',
    GEMINI_CMD: '/custom/gemini',
    GROK_CMD: '/custom/grok',
  };
  assert.deepStrictEqual(resolveCliCommands({
    isWindows: false,
    env: overrideEnv,
    homeDir: path.join(root, 'empty-home'),
    logger: silentLogger(),
  }), {
    claude: '/custom/claude --flag',
    'claude-exp': process.execPath,
    codex: '/custom/codex',
    'codex-exp': '/custom/codex',
    opencode: '/custom/opencode',
    zcode: '/custom/zcode',
    qoder: '/custom/qoderclicn',
    kimi: '/custom/kimi',
    codebuddy: '/custom/codebuddy',
    dsh: '/custom/dsh',
    gemini: '/custom/gemini',
    grok: '/custom/grok',
  }, 'explicit command overrides are returned verbatim');

  const engineOverride = path.join(root, 'custom-zcode.cjs');
  assert.strictEqual(resolveCliCommands({
    isWindows: false,
    env: { PATH: '', ZCODE_ENGINE: engineOverride, ZCODE_CMD: '/stale/zcode' },
    homeDir: path.join(root, 'empty-home'),
    logger: silentLogger(),
  }).zcode, engineOverride, 'ZCODE_ENGINE takes priority over a stale command override');

  const desktopEngine = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
  const desktopOnlyFs = {
    accessSync(file) {
      if (file !== desktopEngine) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    statSync(file) {
      if (file !== desktopEngine) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isFile: () => true };
    },
    readdirSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  };
  assert.strictEqual(resolveCliCommands({
    isWindows: false,
    env: { PATH: '' },
    fsImpl: desktopOnlyFs,
    homeDir: path.join(root, 'empty-home'),
    logger: silentLogger(),
  }).zcode, desktopEngine, 'desktop-only ZCode installs resolve their bundled engine');

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
    claude: 'claude', 'claude-exp': process.execPath, codex: 'codex', 'codex-exp': 'codex', opencode: 'opencode', zcode: 'zcode', qoder: 'qoderclicn', kimi: 'kimi', codebuddy: 'codebuddy', dsh: 'dsh', gemini: 'gemini', grok: 'grok',
  }, 'POSIX fallback names remain stable when no executable exists');
  assert.deepStrictEqual(resolveCliCommands({
    isWindows: true,
    env: { PATH: '', PATHEXT: '.EXE;.CMD' },
    fsImpl: missingFs,
    homeDir: path.join(root, 'missing-home'),
    logger: silentLogger(),
  }), {
    claude: 'claude.exe', 'claude-exp': process.execPath, codex: 'codex.exe', 'codex-exp': 'codex.exe', opencode: 'opencode.exe', zcode: 'zcode.exe', qoder: 'qoderclicn.exe', kimi: 'kimi.exe', codebuddy: 'codebuddy.exe', dsh: 'dsh.exe', gemini: 'gemini.cmd', grok: 'grok.cmd',
  }, 'Windows fallback names remain stable when no executable exists');

  // resolveCodex 的候选顺序是策略而不是随手排的: 官方 curl 安装脚本(BIN_DIR 默认
  // $HOME/.local/bin)与 standalone 包推荐的 `npm install -g --prefix "$HOME/.local"`
  // 都落在这里, 安装脚本自己也是把 ~/.local/bin prepend 进用户 PATH —— 两边顺序一致,
  // 才不会「multicc 跑新的、用户敲 codex 是旧的」。反过来让 /opt/homebrew/bin 抢先,
  // 新装的 codex 会被 npm 旧副本永久遮蔽, 升级报成功、派生的却还是旧的。
  const fakeHome = path.join(root, 'fake-home');
  const localCodex = path.join(fakeHome, '.local', 'bin', 'codex');
  const brewCodex = '/opt/homebrew/bin/codex';
  // /opt/homebrew 下没法真建文件(需要 root, 而且本机真的有一份), 所以按本文件既有
  // 做法注入 fsImpl —— 只承认列出来的这几个路径存在且可执行。
  const onlyExisting = (...files) => ({
    accessSync(file) {
      if (!files.includes(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    statSync(file) {
      if (!files.includes(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isFile: () => true };
    },
    readdirSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  const resolveCodexWith = fsImpl => resolveCliCommands({
    isWindows: false,
    env: { PATH: '' },
    fsImpl,
    homeDir: fakeHome,
    logger: silentLogger(),
  }).codex;

  assert.strictEqual(resolveCodexWith(onlyExisting(localCodex, brewCodex)), localCodex,
    'codex prefers ~/.local/bin (the official installer location) over the homebrew npm copy');
  assert.strictEqual(resolveCodexWith(onlyExisting(brewCodex)), brewCodex,
    'a machine that only has the homebrew copy resolves exactly as before');

  const source = fs.readFileSync(require.resolve('../src/cli-adapters/commands'), 'utf8');
  assert.ok(!/\b(?:execSync|execFileSync|spawnSync)\b/.test(source), 'command resolution uses no synchronous child process');

  console.log('CLI command resolution tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
