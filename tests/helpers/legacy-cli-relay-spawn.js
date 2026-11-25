'use strict';

// CLI 级借道（Claude Code / Codex 远端大脑 + 本地手脚）的薄启动胶水。
// 全部 WebSocket 传输、权限隔离、Host-Exec 与 multicc_router 桥接均由 Rust
// (`multicc-gateway claude-remote-bridge` / `codex-remote-bridge`) 实现。

const crypto = require('crypto');

function resolveCliRelayTarget(providers, cliName, providerId) {
  if (!providerId || !providers || typeof providers.resolveCliRelayTarget !== 'function') return null;
  if (cliName === 'claude' || cliName === 'claude-exp') {
    return providers.resolveCliRelayTarget('claude', providerId);
  }
  if (cliName === 'codex' || cliName === 'codex-exp') {
    return providers.resolveCliRelayTarget('codex', providerId);
  }
  return null;
}

function applyCliRelaySpawn({
  target,
  childEnv,
  cwd,
  persisted,
  prepared,
  gatewayBin,
  rememberActiveCliState,
  savePersistedSessionsBestEffort,
}) {
  const { invocation: physicalInvocation, invocationEnvelope } = prepared;
  const so = invocationEnvelope?.spawnOpts || {};
  const model = so.rawModel || so.effectiveModel || '';
  const effort = so.rawEffort || '';
  const isFirstTurn = invocationEnvelope?.historyHandle?.isFirstTurn === true;

  if (target.appType === 'claude') {
    const hadSid = !!persisted.cliSessionId;
    if (!hadSid) {
      persisted.cliSessionId = crypto.randomUUID();
      rememberActiveCliState(persisted);
      savePersistedSessionsBestEffort('runtime.cli-relay-session-id');
    }
    childEnv.MULTICC_CLAUDE_CLI_RELAY_JSON = JSON.stringify(target);
    const args = ['claude-remote-bridge', '--local-cwd', cwd, '--session-id', persisted.cliSessionId];
    if (hadSid && !isFirstTurn) args.push('--resume');
    if (model) args.push('--model', String(model));
    if (effort) args.push('--effort', String(effort));
    const sysAppend = physicalInvocation.sdkOptions?.systemPromptAppend;
    if (sysAppend) args.push('--system-prompt-append', String(sysAppend));
    args.push('--', String(physicalInvocation.payload || ''));
    return { spawnCmd: gatewayBin, finalSpawnArgs: args };
  }

  childEnv.MULTICC_CODEX_CLI_RELAY_JSON = JSON.stringify(target);
  const args = ['codex-remote-bridge', '--local-cwd', cwd];
  if (persisted.cliSessionId && !isFirstTurn) {
    args.push('--thread-id', String(persisted.cliSessionId));
  }
  if (model) args.push('--model', String(model));
  if (effort) args.push('--effort', String(effort));
  args.push('--', String(physicalInvocation.payload || ''));
  return { spawnCmd: gatewayBin, finalSpawnArgs: args };
}

module.exports = { resolveCliRelayTarget, applyCliRelaySpawn };
