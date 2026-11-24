'use strict';

// Host-authored system-prompt add-ons injected into chat turns.
// Prompt wording, execution-efficiency steering (parallel tool batching,
// scoped reads, merged edits), sub-agent delegation policy, and turn-plan
// sizing live in Rust (`native/core/src/host_prompts.rs`); this module is the
// thin Node bridge plus session-scoped plan-reset marker.

const { getNative } = require('../native/runtime');

function hostPrompt(op, payload) {
  return JSON.parse(getNative().hostPromptsRequest(op, JSON.stringify(payload ?? null)));
}

const USER_INPUT_SIGNAL_PROMPT = Object.freeze(JSON.parse(getNative().sessionQuestionRequest('prompt', 'null')));
const codexUserInputConstraint = JSON.parse(getNative().sessionQuestionRequest('codexConstraint', 'true'));
function buildCodexUserInputConstraint(enabled = true) { return enabled ? codexUserInputConstraint : ''; }

function buildSubagentProviderHint(subagent) {
  const providerId = subagent && typeof subagent === 'object' ? String(subagent.providerId || '').trim() : '';
  if (!providerId) return '';
  const model = String(subagent.model || '').trim();
  return hostPrompt('subagent-hint', { providerId, model });
}

function buildHumanAssistPrompt(assistRoot) {
  return hostPrompt('human-assist', { assistRoot: assistRoot || '' });
}

// Sessions whose next turn must carry the full plan block again after the host
// pruned/rotated their transcript.
const planResetPending = new Set();

function markPlanContextReset(sessionName) {
  const name = String(sessionName || '').trim();
  if (name) planResetPending.add(name);
}

function buildPlanProgressPrompt(persisted, sessionName, opts) {
  const firstTurn = !opts || opts.isFirstTurn !== false;
  const resetPending = sessionName ? planResetPending.delete(String(sessionName)) : false;
  return hostPrompt('plan-progress', { full: firstTurn || resetPending });
}

function createHostPrompts(env = process.env, { assistRoot } = {}) {
  const codexNoAskToolHint = env.CODEX_NO_ASK_TOOL_HINT ?? '1';
  const codexEnvConstraint = buildCodexUserInputConstraint(codexNoAskToolHint !== '0');
  const stayAliveHint = env.CODEX_STAY_ALIVE_HINT ?? '1';
  const codexStayAlivePrompt = stayAliveHint === '0' ? '' : [
    '',
    '[Process keep-alive rules - mandatory]',
    '- When you have started a Monitor, a Bash command with run_in_background, or any other asynchronous background task, **do not end your turn (end_turn) immediately**.',
    '- Keep polling until every background task has finished and produced its final result.',
    '- Poll with Bash every few seconds (for example `cat /tmp/xxx.done 2>/dev/null`, `ps aux | grep xxx`) until completion is confirmed.',
    '- End the turn only after **all subtasks have completed and you have summarized the final result for the user**.',
    '- If you are unsure whether a subtask is still running, wait one more round rather than exiting early.',
    '[End of process keep-alive rules]',
  ].join('\n');
  const multiccImgHint = hostPrompt('host-hint', {
    assistRoot: assistRoot || '',
    port: String(env.PORT || 3000),
    userInputLines: USER_INPUT_SIGNAL_PROMPT,
  });
  return {
    codexEnvConstraint,
    codexStayAlivePrompt,
    multiccImgHint,
    userInputReminder: USER_INPUT_SIGNAL_PROMPT.join('\n'),
  };
}

module.exports = {
  USER_INPUT_SIGNAL_PROMPT,
  buildCodexUserInputConstraint,
  createHostPrompts,
  buildSubagentProviderHint,
  buildHumanAssistPrompt,
  buildPlanProgressPrompt,
  markPlanContextReset,
};
