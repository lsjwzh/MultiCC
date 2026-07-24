'use strict';

// 专用 ZCode adapter —— 直接驱动官方 ZCode 桌面版内的 headless 引擎 zcode.cjs。
//
// zcode.cjs 的协议（`--prompt <text> --json`，输出多行整体 JSON）与 multicc 流式
// 框架（按行 JSONL）不兼容，故 buildInvocation 不直接调引擎，而是 spawn 树内
// bridge（zcode-bridge.cjs）：bridge 调引擎并把整体 JSON 摊成单行 JSONL 事件流，
// decodeEvent 再按 opencode raw 事件 shape 解码。这样不动核心流式框架。
//
// prompt 由 multicc 作为末尾位置参数传给 bridge（见 server.js `[...args, payload]`）。
// 续轮通过 `--session <sess_...>` 传给 bridge，bridge 转成引擎的 `--resume`。

const path = require('path');
const { renderPrompt } = require('../message-composer');

const BRIDGE = path.join(__dirname, 'zcode-bridge.cjs');
const LABEL = 'ZCode';

function createZcodeAdapter({ cmd } = {}) {
  return {
    name: 'zcode',
    cmd,
    // 终端/交互模式：打开引擎的 TUI（需 ZCODE_ENGINE 指向 zcode.cjs）。
    buildTerminalCmd(session) {
      const engine = process.env.ZCODE_ENGINE || cmd || 'zcode';
      let command = `${engine} tui`;
      if (session && session.cliSessionId) command += ` --resume ${session.cliSessionId}`;
      return command;
    },
    buildInvocation(env) {
      const isFirstTurn = env.historyHandle.isFirstTurn;
      const args = [];
      if (!isFirstTurn && env.historyHandle.cliSessionId) {
        args.push('--session', env.historyHandle.cliSessionId);
      }
      const prompt = renderPrompt(env);
      const payload = isFirstTurn && env.rolePrompt
        ? `[角色设定]\n${env.rolePrompt}\n[角色设定结束]\n\n${prompt}`
        : prompt;
      // cmd = bridge（带 shebang 的可执行 .cjs）；multicc 会把 payload 追加为末尾 argv。
      return { cmd: BRIDGE, args, payload };
    },
    // bridge 输出 opencode raw 事件 shape，按 opencode-like 同款逻辑解码。
    decodeEvent(event) {
      if (!event || typeof event !== 'object') return [];
      const decoded = [];
      if (event.sessionID) decoded.push({ type: 'session_started', sessionId: event.sessionID });
      const part = event.part || {};
      if (event.type === 'step_start') {
        decoded.push({ type: 'status', status: 'thinking' });
      } else if (event.type === 'text' && part.text) {
        decoded.push({ type: 'assistant_text', text: part.text });
      } else if (event.type === 'tool_use' || event.type === 'tool_call') {
        const state = part.state || {};
        decoded.push({
          type: 'tool_update',
          id: part.callID || part.id,
          name: part.tool || part.name || 'tool',
          input: state.input != null ? state.input : (part.args || {}),
          currentFile: state.title || null,
          completed: state.status === 'completed' || state.output !== undefined,
          content: typeof state.output === 'string'
            ? state.output
            : (state.output == null ? '' : JSON.stringify(state.output)),
          isError: state.status === 'error',
        });
      } else if (event.type === 'step_finish') {
        if (!part.reason || part.reason === 'stop') {
          const tokens = part.tokens || {};
          decoded.push({
            type: 'complete',
            cost: part.cost != null ? part.cost : null,
            usage: {
              input_tokens: tokens.input || 0,
              output_tokens: tokens.output || 0,
              cache_read_input_tokens: (tokens.cache && tokens.cache.read) || 0,
              cache_creation_input_tokens: (tokens.cache && tokens.cache.write) || 0,
            },
          });
        }
      } else if (event.type === 'error') {
        const error = event.error || part.error;
        const message = (error && error.data && error.data.message)
          || (error && error.message)
          || (typeof error === 'string' ? error : '')
          || `${LABEL} 出错`;
        decoded.push({ type: 'error', label: LABEL, message, kind: 'provider' });
      }
      return decoded;
    },
    needsAsyncSessionIdCapture: false,
  };
}

module.exports = { createZcodeAdapter };
