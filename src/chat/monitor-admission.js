'use strict';

// Native Monitor notifications start a new CLI query on their own. Intercept
// that query at the public UserPromptSubmit hook and let the host scheduler
// acquire a workspace lease before sending the notification back as a turn.
const BLOCK_REASON = 'MultiCC queued this Monitor notification for an admitted turn.';
const CALLBACK_ID = 'multicc_monitor_admission';
const decode = value => value.replace(/&(lt|gt|quot|apos|amp);/g,
  (_, key) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[key]);

function notifications(input) {
  const prompt = input?.prompt;
  if (input?.hook_event_name !== 'UserPromptSubmit' || typeof prompt !== 'string'
      || prompt.length > 128 * 1024 || !prompt.startsWith('<task-notification>')
      || !prompt.includes('</task-notification>')) return null;
  const blocks = [...prompt.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)];
  const events = blocks.map(([block], index) => {
    const field = tag => decode(block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] || '');
    const taskId = field('task-id');
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(taskId)) return null;
    return { type: 'system', subtype: 'monitor_prompt', task_id: taskId,
      event_id: input.prompt_id ? `${input.prompt_id}:${index}` : undefined,
      summary: field('summary').slice(0, 240), status: field('status'), output: field('event').slice(0, 8000) };
  });
  return events.length && events.every(Boolean) ? events : null;
}

function createMonitorAdmission(deliver, isOwnPrompt = () => false) {
  return async input => {
    if (['user', 'sdk'].includes(input?.source) || isOwnPrompt(input?.prompt)) return {};
    const events = notifications(input);
    if (!events) return {};
    // Only tasks that the host observed being created as a main-thread Monitor
    // may use this channel. Ordinary user text and subagent prompts pass through.
    // Native Claude may batch several notifications into one prompt. Probe the
    // whole batch before mutating anything; do not swallow an unowned task.
    for (const event of events) if (!(await deliver({ ...event, probe: true }))?.monitorOwned) return {};
    for (const event of events) await deliver(event);
    return { decision: 'block', reason: BLOCK_REASON,
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true } };
  };
}

function isMonitorHandoffResult(event) {
  return event?.type === 'result' && event.origin?.kind === 'task-notification'
    && event.num_turns === 0 && typeof event.result === 'string' && event.result.includes(BLOCK_REASON);
}

module.exports = { createMonitorAdmission, isMonitorHandoffResult, CALLBACK_ID };
