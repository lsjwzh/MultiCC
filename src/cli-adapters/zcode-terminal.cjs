#!/usr/bin/env node
'use strict';

// Interactive ZCode launcher used by terminal sessions. ZCode has no --model
// flag, and engine 0.15.2's parser actually rejects --settings (advertised in
// --help but unimplemented — every subcommand/position fails with
// "Unknown option", verified 2026-07-25), so a temporary override config is
// impossible. The launcher therefore only CHECKS consistency: when the
// session model matches the vendor config it launches the TUI against the
// default config unchanged; on mismatch it fails loudly instead of silently
// running the wrong model.

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

if (model) {
  try {
    const source = process.env.ZCODE_SETTINGS
      || path.join(process.env.ZCODE_DATA_BASE_DIR || os.homedir(), '.zcode', 'cli', 'config.json');
    const config = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (config && typeof config === 'object' && !Array.isArray(config)
        && config.model && config.model !== model) {
      process.stderr.write(`ZCode 0.15.2 不支持 model 覆盖（--settings 未实现）：会话模型是 ${model}，但 ${source} 里是 ${config.model}。请把该文件的 model 改成 ${model}，或把会话模型切回 ${config.model}。\n`);
      process.exit(1);
    }
  } catch (_) {
    // 配置读不到/解析不了 → 交给引擎自己报原生错误，不阻断。
  }
}

const engineIsScript = /\.c?js$/i.test(engine);
const command = engineIsScript ? process.execPath : engine;
const args = engineIsScript ? [engine, 'tui'] : ['tui'];
if (resume) args.push('--resume', resume);

const child = spawn(command, args, { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
child.once('error', error => {
  process.stderr.write(`ZCode 启动失败：${error.message}\n`);
  process.exit(1);
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code == null ? 1 : code);
});
