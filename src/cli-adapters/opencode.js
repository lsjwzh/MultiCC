'use strict';

const { createAcpAdapter } = require('./acp');
const { createOpencodeLikeAdapter } = require('./opencode-like');
const { validateOpenCodeModel } = require('../routes/opencode-models');
const { classifyProviderError } = require('../provider-error');

// OpenCode runs over ACP (`opencode acp`) through acp-bridge.cjs: streamed
// text/thinking, live tool cards, an authoritative stopReason and in-place
// session/cancel. Session ids (ses_…) are the same ids `opencode run --session`
// uses, so conversations started on the old JSON lane resume unchanged.
// MULTICC_OPENCODE_LEGACY_JSON=1 restores the `run --format json` lane.
const { displayNameOf } = require('../cli/cli-capability');

const LABEL = displayNameOf('opencode');

// A model that is no longer in the live list is refused BEFORE the agent is
// spawned. Throwing here would be swallowed by the turn preparation path and
// retried every ~20s as a generic "preparation-exception"; instead we return a
// throwaway Node process that emits one adapter-native error line on stdout.
// That travels through the adapter's existing event channel: the chat renders
// it once as a user-visible error, and the structured `invalid_request_model`
// category keeps the API-error policy from retrying it.
function blockedModelInvocation(message, encode) {
  const line = JSON.stringify(encode(message));
  const script = `process.stdout.write(${JSON.stringify(`${line}\n`)});`;
  return { cmd: process.execPath, args: ['-e', script], payload: '' };
}

function modelUnavailableMessage(model, suggestion) {
  const intro = `模型 ${model} 已不在可用列表中（可能已下架或改名）。`;
  return suggestion ? `${intro}建议改用 ${suggestion}。` : intro;
}

const acpErrorLine = (message) => ({
  method: 'multicc/error',
  params: { message, code: 'invalid_request_model', category: 'invalid_request_model' },
});
const jsonErrorLine = (message) => ({
  type: 'error',
  error: { data: { message, code: 'invalid_request_model', category: 'invalid_request_model', statusCode: 404 } },
});

function withModelGuard(adapter, encode) {
  const build = adapter.buildInvocation.bind(adapter);
  return {
    ...adapter,
    decodeEvent(event) {
      return adapter.decodeEvent(event).map(decoded => {
        if (decoded.type !== 'error') return decoded;
        const failure = classifyProviderError(decoded.error, { provider: 'opencode', source: 'opencode_event' });
        const detail = failure?.presentation;
        // Display separately; retain the original RPC code and error evidence.
        return detail ? { ...decoded, message: `${detail.message}${detail.userAction}` } : decoded;
      });
    },
    buildInvocation(env) {
      const rawModel = env && env.spawnOpts ? env.spawnOpts.rawModel : null;
      const verdict = validateOpenCodeModel(rawModel);
      if (verdict && verdict.valid === false) {
        return blockedModelInvocation(
          modelUnavailableMessage(String(rawModel).trim(), verdict.suggestion), encode,
        );
      }
      return build(env);
    },
  };
}

function createOpencodeAdapter({
  cmd, userInputReminder = '', routerMcpNode = null, routerMcpScript = null,
  env = process.env,
}) {
  if (env.MULTICC_OPENCODE_LEGACY_JSON === '1') {
    return withModelGuard(createOpencodeLikeAdapter({
      name: 'opencode', label: LABEL, cmd, supportsAgentVariant: true,
      includeThinking: true, userInputReminder,
    }), jsonErrorLine);
  }
  return withModelGuard(createAcpAdapter({
    name: 'opencode', label: LABEL, cmd, agentArgs: ['acp'],
    nativeUsage: 'opencode',
    // OpenCode agents (build/plan) are ACP session modes.
    agentViaMode: true,
    routerMcpNode, routerMcpScript, userInputReminder,
    terminalCmd(session) {
      let command = cmd;
      if (session.model) command += ` --model ${session.model}`;
      if (session.effort) command += ` --variant ${session.effort}`;
      if (session.agent) command += ` --agent ${session.agent}`;
      if (session.cliSessionId) command += ` --session ${session.cliSessionId}`;
      return command;
    },
  }), acpErrorLine);
}

module.exports = { createOpencodeAdapter };
