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

// 引擎路径：优先 ZCODE_ENGINE env（可移植、可追溯），回退到本机 .app 内的默认位置。
const DEFAULT_ENGINE = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const ZCODE_ENGINE = process.env.ZCODE_ENGINE || DEFAULT_ENGINE;

// ── 1. 解析 multicc 传入的参数：--session <id> 用于续轮，末尾位置参数 = prompt ─
// multicc 以 `node bridge [--session sid] <prompt>` 形式 spawn（payload 是末尾 argv）。
const argv = process.argv.slice(2);
let cliSessionId = null;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--session' && i + 1 < argv.length) {
    cliSessionId = argv[++i];
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

// ── 3. 解析 API key：env 优先（multicc spawn 时按 provider 注入），兜底 cc-switch.db ─
function resolveKey() {
  if (process.env.BIGMODEL_API_KEY) return process.env.BIGMODEL_API_KEY;
  // multicc providers.js 常把 anthropic-kind provider 的 token 注入为该变量
  if (process.env.ANTHROPIC_AUTH_TOKEN) return process.env.ANTHROPIC_AUTH_TOKEN;
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const cp = require('child_process');
    const db = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
    if (!fs.existsSync(db)) return '';
    // cc-switch.db 的 providers 表里 name 含 Zhipu/GLM 的条目即为 bigmodel
    const rows = cp.execSync(
      `sqlite3 ${JSON.stringify(db)} "SELECT settings_config FROM providers WHERE name LIKE '%Zhipu%' OR name LIKE '%GLM%' LIMIT 1;"`,
      { encoding: 'utf8', maxBuffer: 1e7 }
    );
    const j = JSON.parse(rows);
    for (const k of ['apiKey', 'api_key', 'authToken', 'token', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY']) {
      const v = j[k] || (j.settings && j.settings[k]) || (j.env && j.env[k]);
      if (typeof v === 'string' && v.length > 10) return v;
    }
  } catch (e) {}
  return '';
}

const key = resolveKey();
if (!key) {
  process.stdout.write(JSON.stringify({
    sessionID: 'zcode-nokey', type: 'error',
    error: { message: 'ZCode 桥接未找到 BIGMODEL_API_KEY：请在 multicc 为 zcode 会话配置 Zhipu GLM provider，或设置 BIGMODEL_API_KEY' },
  }) + '\n');
  process.exit(0);
}

// ── 4. 调用 zcode.cjs 引擎（整体 JSON 输出）────────────────────────────────
const zargs = [ZCODE_ENGINE, '--json', '--prompt', prompt];
if (cliSessionId && /^sess_/.test(cliSessionId)) zargs.push('--resume', cliSessionId);
const env = { ...process.env, BIGMODEL_API_KEY: key };
const res = spawnSync('node', zargs, { encoding: 'utf8', env, maxBuffer: 1e8 });

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
