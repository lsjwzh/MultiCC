'use strict';

const { isTerminalGateway } = require('./terminal-target-policy');
const { sanitizePublicText } = require('../session-dto');
const { labelWithCode } = require('../classify/task-short-code');

const MAX_ROLE_SUMMARY_CHARS = 320;
const MAX_RECENT_TASKS = 4;
const MAX_RECENT_TASK_CHARS = 120;

function compactSafeText(value, maxChars) {
  const safe = sanitizePublicText(value, maxChars * 2);
  return safe ? safe.replace(/\s+/g, ' ').trim().slice(0, maxChars) : '';
}

function roleSummaryFor(record) {
  if (!record || typeof record !== 'object') return '';
  if (record.rolePrompt) {
    return compactSafeText(record.rolePrompt, MAX_ROLE_SUMMARY_CHARS);
  }
  if (typeof record.agent === 'string') {
    return compactSafeText(record.agent, MAX_ROLE_SUMMARY_CHARS);
  }
  if (record.agent && typeof record.agent === 'object') {
    const parts = ['role', 'description', 'name', 'label']
      .map(key => compactSafeText(record.agent[key], MAX_ROLE_SUMMARY_CHARS))
      .filter(Boolean);
    if (parts.length) return compactSafeText(parts.join(' · '), MAX_ROLE_SUMMARY_CHARS);
  }
  return compactSafeText(record.label, MAX_ROLE_SUMMARY_CHARS);
}

function recentTasksFor(record) {
  const state = record?.taskState && typeof record.taskState === 'object'
    ? record.taskState : {};
  const history = [];
  // The live projection is authoritative and must survive the four-row cap.
  // Putting it first also prevents a delayed history row from presenting a new
  // code with the title of the task that preceded it.
  if (state.goal) {
    history.push({
      goal: state.goal,
      taskId: state.taskId || null,
      phase: state.phase,
      state: state.classifyState,
      attribution: state.taskIdentityPending === true ? 'classifying' : null,
    });
  }
  if (Array.isArray(state.classifyHistory)) {
    history.push(...[...state.classifyHistory].reverse());
  }

  const seen = new Set();
  const recent = [];
  for (const entry of history) {
    if (!entry || typeof entry !== 'object') continue;
    const goal = compactSafeText(entry.goal, MAX_RECENT_TASK_CHARS);
    // Canonical identity owns deduplication: same-name tasks with different ids
    // remain distinct, while a renamed task appears once under its latest name.
    // Goal fallback is only for legacy rows that predate task ids.
    const taskId = String(entry.taskId || '').trim();
    const key = taskId
      ? `id:${taskId}`
      : `legacy:${goal.normalize('NFKC').toLowerCase().replace(/\s+/g, '')}`;
    if (!goal || seen.has(key)) continue;
    seen.add(key);
    const task = labelWithCode(entry.taskId, goal);
    const item = { task };
    const phase = compactSafeText(entry.phase, 40);
    const taskState = compactSafeText(entry.state, 24);
    if (phase) item.phase = phase;
    if (taskState) item.state = taskState;
    if (entry.attribution === 'classifying') item.attribution = 'classifying';
    recent.push(item);
    if (recent.length >= MAX_RECENT_TASKS) break;
  }
  return recent;
}

function routingStateFor(record) {
  const pendingInput = record?.taskState?.pendingUserInput;
  if (pendingInput && pendingInput.resolved !== true) return 'waiting_user';
  const state = String(record?.taskState?.classifyState || '').trim().toUpperCase();
  return {
    W: 'waiting_user',
    P: 'processing',
    C: 'processing',
    B: 'background',
    E: 'error',
    D: 'ready',
  }[state] || 'unknown';
}

// Dispatch targeting: which sibling sessions a given session may dispatch to,
// and the cross-session dispatch context prompt injected into a turn. Extracted
// verbatim from server.js; the host injects the session registry, the live chat
// session map, and normalizeEffort so targeting/prompt stay free of globals.

function createDispatchTargeting({ records, chatSessions, normalizeEffort, isTargetBusy, boundTaskTitleFor } = {}) {
  if (!records || typeof records.get !== 'function' || typeof records.values !== 'function') {
    throw new TypeError('[dispatch-targeting] records must be a map-like session registry');
  }
  if (!chatSessions || typeof chatSessions.get !== 'function') {
    throw new TypeError('[dispatch-targeting] chatSessions must be map-like');
  }
  if (typeof normalizeEffort !== 'function') {
    throw new TypeError('[dispatch-targeting] normalizeEffort must be a function');
  }
  if (typeof isTargetBusy !== 'function') {
    throw new TypeError('[dispatch-targeting] isTargetBusy must be a function');
  }
  // Optional: resolve a task-bound session's task title by task id. Hosts that
  // cannot supply it leave the dep out — candidates then carry only the id.
  if (boundTaskTitleFor != null && typeof boundTaskTitleFor !== 'function') {
    throw new TypeError('[dispatch-targeting] boundTaskTitleFor must be a function');
  }

function dispatchableSessionsFor(sessionId) {
  const from = records.get(sessionId);
  if (!from || !from.dirId) return [];
  const includeRoutingProfile = from.type === 'commander';
  return [...records.values()]
    .filter(s => s.id !== sessionId)
    // Never dispatch to a system/commander session: aux/gateway are internal,
    // commander only dispatches out (it is never a worker).
    .filter(s => s.type !== 'aux' && s.type !== 'gateway' && s.type !== 'commander')
    // TaskRun slots are a bounded internal execution pool. They are selected by
    // the TaskRun scheduler with lease lineage, never by an LLM/user target id.
    .filter(s => s.taskExecutionSlot !== true)
    .filter(s => s.dirId === from.dirId)
    // A terminal gateway is an execution detail, not a second worker choice.
    // The Commander selects the stable terminal id only after explicit user
    // targeting; dispatchToSession then reuses this gateway automatically.
    .filter(s => !isTerminalGateway(records, s))
    .slice(0, 30)
    .map(s => {
      const activeChat = chatSessions.get(s.id);
      const busy = !!isTargetBusy(s.id);
      const target = {
        id: s.id,
        label: s.label || '',
        cli: s.cli || 'claude',
        kind: s.kind || 'terminal',
        // Commander routing must not see contradictory active/load signals.
        // Ordinary hints retain their historical browser-presence field.
        active: includeRoutingProfile
          ? busy
          : !!activeChat && (activeChat.clients.size > 0 || activeChat.isStreaming),
      };
      // A task-bound session (hidden task-board worker, label「任务 · …」) is
      // only a valid target for follow-ups of ITS bound task — see the routing
      // rule in buildDispatchContextPrompt. Present on the candidate so the
      // dispatcher can tell bound from ordinary workers apart.
      const taskBoundTaskId = typeof s.taskBoundTaskId === 'string' && s.taskBoundTaskId
        ? s.taskBoundTaskId
        : '';
      if (taskBoundTaskId) {
        target.taskBoundTaskId = taskBoundTaskId;
        if (boundTaskTitleFor) {
          const boundTaskTitle = compactSafeText(boundTaskTitleFor(taskBoundTaskId), 120);
          if (boundTaskTitle) target.boundTaskTitle = boundTaskTitle;
        }
      }
      if (includeRoutingProfile) {
        target.role = roleSummaryFor(s);
        target.recentTasks = recentTasksFor(s);
        // Use the same host-owned work/lease predicate as admission. Browser
        // clients and a stale streaming flag are presence signals, not load.
        target.load = busy ? 'running' : 'available';
        // Host-owned workflow state is separate from physical process load.
        // Expose only the bounded enum; never leak the pending question/options.
        target.routingState = routingStateFor(s);
      }
      return target;
    });
}

function buildDispatchContextPrompt(sessionId) {
  const targets = dispatchableSessionsFor(sessionId);
  if (!targets.length) return '';
  const current = records.get(sessionId);
  const isCommander = current?.type === 'commander';
  // Only the commander gets the dispatch context prompt (target list + routing
  // instructions). Ordinary sessions dispatch via MCP router tools directly.
  if (!isCommander) return '';
  const ultra = normalizeEffort(current?.effort) === 'ultracode';
  const intro = [
    '[MultiCC Commander routing]',
    'You are the Commander of this workspace. By default, first decide whether a self-contained task should be dispatched one-way with route_task to one of the same-workspace Workers listed below.',
    'This is not a strict route-only mode: lightweight analysis, checks, planning, explanations, or anything the user explicitly asks you to handle yourself may be done in the current session; if you choose to do it yourself, briefly say why you did not dispatch.',
    'Tasks involving code changes, long-running execution, verification/commit/merge, cross-provider work, parallel work across modules, or a separate worktree should be dispatched with route_task.',
    'A candidate with taskBoundTaskId is a task-bound session (a hidden worker dedicated to a task board card): choose it only when the new task is a follow-up of its bound task; unrelated tasks always go to sessions without that field. If the user explicitly names a task-bound session, choose it (rule (1) takes precedence) but state in the dispatch message that it is a task-bound session.',
    ...(ultra ? [
      'This session has Ultracode capability, usable for lightweight analysis, verification, and small self-executed work; cross-session dispatch still uses only the MCP tools route_task / dispatch_master.',
    ] : []),
  ];
  return [
    ...intro,
    'Tool format: route_task({"target_session_id":"multicc-claude-chat-05","message":"complete, self-contained task description"}) (replace the example id with an id copied verbatim from the "available target sessions" list below).',
    'For an independent new task use new_task:{title,cli?,model?,provider?,effort?} instead of target_session_id; the MCP creates the task and its execution session together and then dispatches. Specifying target_session_id means adding to that session\'s existing task. Never pre-create tasks or sessions through management APIs via curl/Bash/Python, and never invent task numbers yourself.',
    'target must be the id field of an object in the list below, copied verbatim (e.g. multicc-claude-chat-05); never use placeholders such as xxx, ..., SID, SESSION_ID, worker-1, or the dispatch is guaranteed to fail.',
    'Always prefer reusing an existing matching session from the list; do not create a new session because a session is currently active, because the task name mentions some CLI/terminal, or to find a "better fit". Report a missing target only when no existing worker can genuinely do the job.',
    'Candidate fields include role (stable responsibility summary), recentTasks (most recent first), load (process load), and routingState (workflow state). These are bounded facts supplied by the server; list order carries no priority, and you must not guess responsibilities from the id, CLI name, or recent activity time.',
    'Selection rules: (1) a valid chat session explicitly named by the user must be chosen as-is, never redirected; (2) otherwise, first look for a session related to the same task or module and prefer it when its load="available" and routingState is ready/unknown; (3) if the related session has load="running" or cannot take work immediately, prefer another load="available", routingState=ready/unknown session whose role/recentTasks qualify it; (4) only when every qualified session is busy or unavailable do you place the task in the FIFO of the best-matching session.',
    'role describes long-term responsibility and outranks a single incidental task; recentTasks indicate experience and context continuity, and a single task never becomes a session\'s permanent role.',
    'routingState="waiting_user", "background", or "error" never counts as immediately available; processing can only be a transitional state pending judgement when the canonical load is available at the same time, and ready/unknown is still preferred. Unless the user explicitly named the target or no other qualified idle session exists, prefer redirecting.',
    'When redirecting to another session, message must be complete and self-contained: state the goal, known facts, constraints, relevant files/branches/operation_id, acceptance criteria, and how to deliver; pass only the redacted context needed for the task, never a full conversation or secrets.',
    'Admission after selecting a target still uses a durable FIFO and never interrupts the current turn; do not broadcast the same task to multiple sessions.',
    'Choose kind="chat" by default. The words "terminal/CLI" appearing in the task body do not mean the user specified a terminal session; only when the user\'s own words name a terminal\'s full id or full label may you choose that terminal id and set allow_terminal=true.',
    'Do not output <<route>> or <<dispatch>> markers, and do not call the old HTTP dispatch endpoint; cross-session dispatch happens only through the MCP tools, and only a queued/operation_id receipt counts as a valid dispatch.',
    'To dispatch several independent subtasks in parallel, call route_task several times; dispatch is one-way and worker results do not flow back to you.',
    'The receipt\'s queue_state/queue_position tell you whether the task entered the target FIFO or already started. Before re-dispatching you must cancel first: dispatch_cancel({"operation_id":"op_..."}) (still in the FIFO: removed silently and the worker never sees it; already running: add cancel_running=true), then dispatch to the new target. Re-dispatching without cancelling runs both copies.',
    'A dispatch_master timeout, terminated stream, dropped connection, or tool-level router_error only means "this receipt is incomplete"; it never means the target task stopped. Never infer task termination from session.active/streaming, recentTasks, git state, or "no output for a while".',
    'On any incomplete receipt, call dispatch_status first: query precisely with a known operation_id, or by target_session_id to list this session\'s non-terminal dispatches. While the original operation is non-terminal you may only keep waiting or dispatch_cancel first; re-dispatch only after the server confirms terminal/cancelled.',
    'The session endpoint for human audit is GET /api/sessions/:id/dispatches; it combines the durable operation with the target FIFO. active/streaming in GET /api/sessions/:id are only process/client presence signals, not task completion state.',
      'When you need a receipt, use dispatch_master instead and set mode explicitly: sync keeps the tool call open, keeps showing the reasoning/thinking the Slave emits explicitly plus safe progress, and returns the final result in place; async returns as soon as it is registered and later wakes this session automatically with a new message.',
      'After an async dispatch never poll or inspect the target session yourself; only continue with independent work, then end the turn naturally.',
    `Available target sessions: ${JSON.stringify(targets)}`,
    '[MultiCC Commander routing end]',
    '',
  ].join('\n');
}

function dispatchTargetHintFor(sessionId) {
  const targets = dispatchableSessionsFor(sessionId);
  if (!targets.length) return 'No dispatchable target session in the current directory';
  return `Available target sessions: ${JSON.stringify(targets)}`;
}

  return { dispatchableSessionsFor, dispatchTargetHintFor, buildDispatchContextPrompt };
}

// The voice router's status snapshot (gateway-host.js) reuses the same bounded
// per-session digest the Commander routing preamble carries, so a spoken
// "各会话执行情况" is answered from identical ground truth.
module.exports = { createDispatchTargeting, roleSummaryFor, recentTasksFor, routingStateFor };
