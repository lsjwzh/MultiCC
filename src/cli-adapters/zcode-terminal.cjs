#!/usr/bin/env node
'use strict';

// Interactive ZCode launcher used by terminal sessions. ZCode has no --model
// flag, so the launcher mirrors the chat bridge's safe behavior: copy the
// vendor-owned config, override only `model`, pass it through --settings, then
// remove the private temporary copy when the TUI exits.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const argv = process.argv.slice(2);
let engine = 'zcode';
let model = null;
let resume = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--engine' && i + 1 < argv.length) engine = argv[++i];
  else if (argv[i] === '--model' && i + 1 < argv.length) model = argv[++i];
  else if (argv[i] === '--resume' && i + 1 < argv.length) resume = argv[++i];
}

let settingsDir = null;
let settingsFile = null;
function cleanup() {
  if (!settingsDir) return;
  try { fs.rmSync(settingsDir, { recursive: true, force: true }); } catch (_) {}
  settingsDir = null;
}

if (model) {
  try {
    const source = process.env.ZCODE_SETTINGS
      || path.join(os.homedir(), '.zcode', 'cli', 'config.json');
    const config = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('vendor settings must be a JSON object');
    }
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-zcode-terminal-'));
    settingsFile = path.join(settingsDir, 'config.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ ...config, model }), { mode: 0o600 });
  } catch (error) {
    process.stderr.write(`ZCode 模型配置失败：${error.message}\n`);
    cleanup();
    process.exit(1);
  }
}

const engineIsScript = /\.c?js$/i.test(engine);
const command = engineIsScript ? process.execPath : engine;
const args = engineIsScript ? [engine, 'tui'] : ['tui'];
if (settingsFile) args.push('--settings', settingsFile);
if (resume) args.push('--resume', resume);

const child = spawn(command, args, { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
child.once('error', error => {
  process.stderr.write(`ZCode 启动失败：${error.message}\n`);
  cleanup();
  process.exit(1);
});
child.once('exit', (code, signal) => {
  cleanup();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code == null ? 1 : code);
});
