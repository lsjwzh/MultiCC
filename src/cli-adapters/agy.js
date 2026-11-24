'use strict';

// Antigravity (`agy`) `--output-format stream-json` 适配器的薄 Node 桥接层。
// 命令构造、每步实时用量累加与每轮事件状态机均由 Rust (`multicc_core::agy_stream`)
// 负责；本文件仅对接现有 adapter 合约、宿主 prompt 渲染与交互终端命令。
const { createProtocolCompletionTracker } = require('./completion');
const { getNative, messageComposer } = require('../native/runtime');
const { displayNameOf, supportsEffort } = require('../cli/cli-capability');

const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;

function createAgyAdapter({ cmd }) {
  let decoderAddon = null;
  let decoder = null;
  const nativeDecoder = () => {
    const addon = getNative();
    if (decoderAddon !== addon) {
      decoder = new addon.RustAgyStreamDecoder();
      decoderAddon = addon;
    }
    return decoder;
  };

  return {
    name: 'agy',
    label: displayNameOf('agy'),
    cmd,
    needsAsyncSessionIdCapture: false,
    createCompletionTracker() {
      return createProtocolCompletionTracker('agy');
    },
    buildTerminalCmd(session = {}) {
      let command = quote(cmd);
      if (session.model) command += ` --model ${quote(session.model)}`;
      if (session.effort && supportsEffort('agy', session.model, session.effort)) command += ` --effort ${quote(session.effort)}`;
      if (session.cliSessionId) command += ` --conversation ${quote(session.cliSessionId)}`;
      return command;
    },
    buildInvocation(env) {
      const so = env.spawnOpts || {};
      const handle = env.historyHandle || {};
      return getNative().agyBuildInvocation({
        cmd,
        model: so.rawModel ? String(so.rawModel) : undefined,
        effectiveModel: so.effectiveModel || undefined,
        effort: so.rawEffort ? String(so.rawEffort) : undefined,
        conversationId: handle.cliSessionId ? String(handle.cliSessionId) : undefined,
        isFirstTurn: !!handle.isFirstTurn,
        rolePrompt: env.rolePrompt ? String(env.rolePrompt) : undefined,
        prompt: messageComposer.renderPrompt(env),
      });
    },
    decodeEvent(event) {
      if (!event || typeof event !== 'object') return [];
      const raw = nativeDecoder().decode(JSON.stringify(event));
      return raw ? JSON.parse(raw) : [];
    },
  };
}

module.exports = { createAgyAdapter };
