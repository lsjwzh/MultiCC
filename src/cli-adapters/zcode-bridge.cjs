#!/usr/bin/env node
'use strict';
/*
 * zcode-bridge — MultiCC 树内协议桥接（专用 zcode adapter 的执行体）。
 *
 * 为什么需要它：官方 ZCode 引擎（Electron 桌面 app 内的 zcode.cjs）是真正的
 * headless CLI，但它的协议与 multicc 流式框架不兼容：
 *   - multicc 框架（server.js 行读取循环）按 `\n` 切、每行 JSON.parse，
 *     失败的行直接丢弃 → 只能消费【单行 JSONL】。
 *   - zcode.cjs `--json` 输出的是【多行 pretty-print JSON】整体对象，且子命令
 *     是 `--prompt <text> --json`，不是 multicc opencode-like 的
 *     `run --format json --auto`。
 * 本 bridge 做且仅做协议翻译：取末尾 argv 作为 prompt（multicc 把 payload 作为
 * 末尾位置参数传入，见 server.js 的 `[...args, payload]`），调用 zcode.cjs 引擎，
 * 把整体 JSON 摊平为单行 JSONL 事件流（opencode raw 事件 shape），让 multicc
 * 既有 decodeEvent 直接消费。不改动核心流式框架，零风险。
 *
 * 仅在用户显式发起的会话中被 spawn；不主动上传代码、不产生额外付费调用。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_ZCODE_ENGINE } = require('./zcode-engine');

// 引擎路径：优先 ZCODE_ENGINE env（可移植、可追溯），回退到本机 .app 内的默认位置。
const ZCODE_ENGINE = process.env.ZCODE_ENGINE || DEFAULT_ZCODE_ENGINE;

// ── 1. 解析 multicc 传入的参数：--session <id> 用于续轮，末尾位置参数 = prompt ─
// multicc 以 `node bridge [--session sid] <prompt>` 形式 spawn（payload 是末尾 argv）。
const argv = process.argv.slice(2);
let cliSessionId = null;
let model = null;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--session' && i + 1 < argv.length) {
    cliSessionId = argv[++i];
  } else if (argv[i] === '--model' && i + 1 < argv.length) {
    model = argv[++i];
  } else {
    positional.push(argv[i]);
  }
}
// 末尾位置参数即 prompt（multicc 追加 payload 为最后一个 arg）
const prompt = positional.length ? positional[positional.length - 1] : '';

// ── 2. 无 prompt：退化为引擎 --version 透传（无副作用启动检查，供 multicc 自检）──
if (!prompt) {
  if (!fs.existsSync(ZCODE_ENGINE)) {
    process.stderr.write(`zcode-bridge: 引擎不存在 (${ZCODE_ENGINE})；请用 ZCODE_ENGINE 指向 zcode.cjs\n`);
    process.exit(1);
  }
  const r = spawnSync('node', [ZCODE_ENGINE, '--version'], { encoding: 'utf8' });
  process.stdout.write((r.stdout || '') + (r.stderr || ''));
  process.exit(r.status || 0);
}

if (!fs.existsSync(ZCODE_ENGINE)) {
  process.stdout.write(JSON.stringify({
    sessionID: 'zcode-no-engine', type: 'error',
    error: { message: `zcode-bridge: 引擎不存在 (${ZCODE_ENGINE})；请用 ZCODE_ENGINE 指向 zcode.cjs` },
  }) + '\n');
  process.exit(0);
}

// ── 3. 模型一致性检查（不做临时覆盖）──────────────────────────────────────
// 引擎 0.15.2 的 parser 实际拒绝 --settings（help 广告了但未实现：所有子命令、
// 所有位置、等号形式全部 "Unknown option"，2026-07-25 实测），临时注入覆盖配置
// 这条路在引擎侧根本不存在。因此改为：
//   - 会话 model 与厂商默认配置一致 → 不传任何覆盖，引擎自动读默认配置
//     （"不传就用默认配置"）；
//   - 不一致 → 明确报错。静默用厂商默认 model 跑会让 multicc 的 per-session
//     model 形同虚设，比失败更糟；
//   - 厂商配置读不到 → 直接放行，让引擎报它自己的原生错误（如 Model config
//     is missing），不在此处二次包装。
if (model) {
  try {
    const source = process.env.ZCODE_SETTINGS
      || path.join(os.homedir(), '.zcode', 'cli', 'config.json');
    const config = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (config && typeof config === 'object' && !Array.isArray(config)
        && config.model && config.model !== model) {
      process.stdout.write(JSON.stringify({
        sessionID: 'zcode-settings', type: 'error',
        error: { message: `ZCode 0.15.2 不支持 model 覆盖（--settings 未实现）：会话模型是 ${model}，但 ${source} 里是 ${config.model}。请把该文件的 model 改成 ${model}，或在 multicc 把会话模型切回 ${config.model}。` },
      }) + '\n');
      process.exit(0);
    }
  } catch (_) {
    // 配置读不到/解析不了 → 交给引擎自己报错，不阻断。
  }
}

// ── 4. 调用 zcode.cjs 引擎（整体 JSON 输出）────────────────────────────────
const zargs = [ZCODE_ENGINE, '--json', '--prompt', prompt];
if (cliSessionId && /^sess_/.test(cliSessionId)) zargs.push('--resume', cliSessionId);
const res = spawnSync('node', zargs, { encoding: 'utf8', env: process.env, maxBuffer: 1e8 });

if (res.status !== 0) {
  const msg = ((res.stdout || '') + (res.stderr || '')).split('\n').slice(0, 3).join(' ').slice(0, 300);
  process.stdout.write(JSON.stringify({
    sessionID: 'zcode-err', type: 'error', error: { message: msg || ('zcode.cjs 退出码 ' + res.status) },
  }) + '\n');
  process.exit(0);
}

// ── 5. 整体 JSON → opencode raw 事件 JSONL（decodeEvent 直接消费）─────────────
let parsed = null;
try {
  parsed = JSON.parse(res.stdout);
} catch (e) {
  process.stdout.write(JSON.stringify({
    sessionID: 'zcode-parse', type: 'error', error: { message: '无法解析 zcode.cjs 输出' },
  }) + '\n');
  process.exit(0);
}

const sid = parsed.sessionId || ('zcode-' + Date.now());
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

emit({ sessionID: sid, type: 'step_start' });
if (parsed.response) {
  emit({ sessionID: sid, type: 'text', part: { text: parsed.response } });
}
const u = parsed.usage || {};
emit({
  sessionID: sid,
  type: 'step_finish',
  part: {
    reason: 'stop',
    tokens: {
      input: u.inputTokens || 0,
      output: u.outputTokens || 0,
      cache: { read: u.cacheReadTokens || 0, write: u.cacheWriteTokens || 0 },
    },
  },
});
