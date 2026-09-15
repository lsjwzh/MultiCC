'use strict';
const { hash, estimateTokens, renderSnapshots } = require('./context');
const { clipTokens } = require('../context/selection');

// Preserve parseable provenance and explicit truncation when an imported turn
// is larger than the automatic budget. Full history remains available by cursor.
function boundedSnapshot(snapshot, budget = 2000) {
  const original = renderSnapshots([snapshot]);
  if (estimateTokens(original) <= budget) return { text: original, truncated: false, messageCount: snapshot.messages.length };
  let rows = snapshot.messages.slice(-6), perMessage = 400;
  const request = snapshot.messages.findLast(m => m.role === 'user');
  if (request && !rows.some(m => m.role === 'user')) rows[0] = request;
  for (;;) {
    const messages = rows.map(message => {
      const { content, tools, evidenceExcerpt, ...meta } = message;
      const raw = evidenceExcerpt || JSON.stringify({ content, tools });
      const excerpt = clipTokens(raw, perMessage);
      return { ...meta, evidenceExcerpt: excerpt, truncated: true,
        totalChars: message.totalChars || raw.length,
        nextOffset: excerpt.endsWith('…') ? excerpt.length - 1 : excerpt.length };
    });
    const { hash: _hash, ...data } = snapshot;
    const bounded = { ...data, messages, omittedMessages: (snapshot.omittedMessages || 0) + snapshot.messages.length - rows.length, truncated: true };
    const text = renderSnapshots([{ ...bounded, hash: hash(bounded) }]);
    if (estimateTokens(text) <= budget) return { text, truncated: true, messageCount: rows.length };
    if (perMessage > 40) perMessage = Math.floor(perMessage / 2);
    else if (rows.length > 2) rows = rows.slice(-2);
    else return { text: original, truncated: true }; // Atomic selector will honestly omit an unrepresentable snapshot.
  }
}
module.exports = { boundedSnapshot };

function boundedHandoff(handoff, budget = 2200) {
  const { renderHandoffPrompt } = require('../cli-switch');
  const original = renderHandoffPrompt(handoff);
  if (estimateTokens(original) <= budget) return { text: original, truncated: false };
  const cp = handoff.checkpoint, task = {};
  for (const [key, value] of Object.entries(cp.task || {})) task[key] = typeof value === 'string' ? clipTokens(value, 120) : value;
  const rows = (cp.transcript || []).slice(-4);
  const request = (cp.transcript || []).findLast(m => m.role === 'user');
  if (request && rows.length && !rows.some(m => m.role === 'user')) rows[0] = request;
  let perMessage = 300;
  for (;;) {
    const transcript = rows.map(m => ({ ...m, text: clipTokens(String(m.text || ''), perMessage) }));
    const text = renderHandoffPrompt({ ...handoff, checkpoint: { ...cp, task, transcript,
      git: cp.git ? { commit: cp.git.commit, branch: cp.git.branch } : null } }) + '[检查点已节选；完整对话可通过 get_task_context 读取]\n';
    if (estimateTokens(text) <= budget || perMessage <= 20) return { text, truncated: true };
    perMessage = Math.floor(perMessage / 2);
  }
}
module.exports.boundedHandoff = boundedHandoff;
