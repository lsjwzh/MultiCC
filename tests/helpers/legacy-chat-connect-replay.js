'use strict';
// Frozen transcription of the connect-time send order in
// src/chat/turn-engine.js (the chat_history / task-state seed / stream replay
// block). It is the differential oracle for
// multicc_core::chat_connect_replay; the control flow, including the nested
// guard and the re-read of cs.streamReplay after the inline clear, is kept
// statement for statement so a divergence shows up as a step order or a
// buffer-length difference rather than a rewrite.
function connectPlan({ replayMessages, cs, sessionTokenUsage, taskStateSeed }) {
  const steps = [];
  if (replayMessages.length > 0 || sessionTokenUsage) {
    steps.push({ type: 'chat_history' });
    const seed = taskStateSeed();
    if (seed) steps.push({ type: 'task_state_seed' });
    if (replayMessages.length > 0) {
      const lastMsg = replayMessages[replayMessages.length - 1];
      if (lastMsg.role === 'assistant' && cs.isStreaming && cs.streamReplay.length > 0) {
        cs.streamReplay = [];
        steps.push({ type: 'clear_buffer' });
      }
    }
  }
  if (cs.isStreaming && cs.streamReplay.length > 0) {
    steps.push({ type: 'replay_burst', frames: cs.streamReplay.length });
  }
  return steps;
}
module.exports = { connectPlan };
