'use strict';

// Host-authored system-prompt add-ons injected into every chat turn. Kept out
// of the server composition root so the prompt policy lives next to the other
// message-composition policy and can be reviewed independently of wiring.

const { USER_INPUT_SIGNAL_PROMPT, buildCodexUserInputConstraint } = require('../classify/user-input-host');

// Codex exec cannot use its built-in ask tool; steer it to MultiCC's MCP signal.
// Keep codex exec alive until ALL background tasks complete.
// Codex exec exits when the model emits end_turn. Without explicit instruction,
// the model often ends the turn early while Monitor / run_in_background tasks
// are still running. This hint tells it to stay in the loop and poll until done.
// Both default-on; set CODEX_NO_ASK_TOOL_HINT=0 / CODEX_STAY_ALIVE_HINT=0 to
// disable.
// Chat sessions with a dedicated sub-agent provider bill sub-agent tokens to
// that route, not the main one. Tell the main agent to delegate token-heavy
// work there. Only injected when the session actually has one configured.
function buildSubagentProviderHint(subagent) {
  const providerId = subagent && typeof subagent === 'object' ? String(subagent.providerId || '').trim() : '';
  if (!providerId) return '';
  const model = String(subagent.model || '').trim();
  const route = model ? `${providerId} / ${model}` : providerId;
  return [
    `[Sub-agent provider configured: delegate token-heavy work to sub-agents] This session routes sub-agents through a dedicated provider (${route}). Tokens spent by sub-agents are billed to that route and do not consume the main route's quota, so doing token-heavy work directly in the main agent is the more expensive choice.`,
    'By default, hand the following to sub-agents (Agent/Task tools; run independent ones in parallel with run_in_background): broad code search and reading, bulk file scanning or comparison, analysis of long logs or large outputs, multi-file refactors and batch edits, independently verifiable subtasks, parallel research and material gathering, running tests and summarizing failures.',
    'Go beyond that default list: involve sub-agents liberally in any clear, well-scoped task — in particular concrete coding actions (writing or editing a specific function, file, or small self-contained change), not only reading and research. When a step has an unambiguous goal and a verifiable result, prefer handing it to a sub-agent over doing it inline.',
    'The main agent owns task decomposition, writing complete self-contained instructions for each sub-agent (goal, known facts, constraints, acceptance criteria, and "no grep - use Read or node fs"), integrating results, and talking to the user. Do the work yourself only when it depends on the live conversation context, is a small strictly sequential change, or the delegation overhead clearly exceeds the work itself. Delegated sub-agents still follow the keep-alive polling rules above; wrap up only after their results are in.',
  ].join('\n');
}

// Human assist: when a page/desktop step needs a person, the agent posts a
// screenshot, the user annotates it in the chat lightbox (web
// public/chat-annotate.js, App image_annotate_screen.dart) and answers with an
// [annotation] block. The block format is shared with those two editors and
// pinned by tests/test-chat-annotate.js; change all three together.
function buildHumanAssistPrompt(assistRoot) {
  const root = String(assistRoot || '~/.multicc/assist').replace(/\/+$/, '');
  return [
    '[Human assist via annotated screenshots] When a web or desktop step needs a person (captcha, 2FA code, QR scan, a UI you cannot identify, or the same step failed twice), ask with a screenshot instead of guessing. The user only annotates a still image; for hands-on remote control see the multicc-human-assist skill.',
    `  (1) Save screenshots under \`${root}/$MULTICC_SESSION_ID/\` (deleted after 7 days; never publish them as artifacts) and note each one's coordinate base: the desktop logical size (the LWxLH that mcu.sh snap prints) or the browser viewport in CSS pixels.`,
    '  (2) Show at most 5 frames of the stuck step, oldest first, as `![step N](/absolute/path.png)`, say what you tried and what you need, then call wait_for_user_answer.',
    '  (3) An answer with `[annotation] src=<path> size=WxH` ... `[/annotation]` carries marks normalized to 0..1: `#n point x,y`, `#n box x1,y1-x2,y2`, `#n arrow x1,y1->x2,y2`, each optionally followed by ` — <note>`, then an optional `note: <overall instructions>`; an annotated PNG is attached. Multiply by the recorded coordinate base (not the PNG size), re-snapshot and compare with src before acting, prefer the real element (role/label) over raw coordinates, and post a result screenshot.',
    '  (4) An answer starting with `[annotation-refresh] src=<path>` means that screenshot is stale: capture again and re-ask.',
    '  (5) A value the answer says is stored in the vault under NAME is read only from the env var NAME, never echoed. Slider captchas, a locked screen or anything needing the user\'s hands: ask the user to do that step and tell you when done.',
  ];
}

// Plan + progress reporting, injected as a PER-TURN layer into every chat turn
// (message-composer, kind 'turn-plan'). It is deliberately absent from aux
// sessions (internal classification/attribution jobs) and gateway sessions
// (whose model is a router with machine-parsed output) — see the layer's gate
// in message-composer.
//
// Modelled on hierarchical-planning agents (eko-style generate → execute): split
// the request into subtasks before acting, then report per-subtask achievement.
// The transcript is the only evidence the status system has, so the reporting
// half is what makes 「达成目标」 judgeable instead of a claim. Mirrors the
// classify prompt's own criteria (src/classify/vocab.js): 已完成 == goal
// achieved, never "the turn wrapped up".
//
// COST: the block is ~1.7K characters and the user prompt is replayed on every
// turn, so re-sending it every turn is a fixed per-turn growth of the context.
// Only the first turn of a native session needs the whole policy — and so does
// the first turn after the host pruned the transcript, because the block that
// used to sit earlier in the conversation is gone (see markPlanContextReset).
// Every other turn gets the one-line reminder, which restates exactly what the
// classifier reads back: what landed, with evidence, and what did not.
const PLAN_REMINDER = '[Plan + outcome - every turn] Keep the plan already in this conversation (tick steps off, do not restate it). Before ending a turn in which the work moved, say in the conversation\'s language which steps landed and with what evidence ("3/5 done"), what is still open, and who acts next — the status badge reads only what you write here, so never present an unfinished step as complete.\n\n';

// Sessions whose next turn must carry the full block again because the view the
// model had lost it. Session-scoped and in-memory on purpose: a server restart
// loses the marker, which costs one extra full block and nothing else.
const planResetPending = new Set();

function markPlanContextReset(sessionName) {
  const name = String(sessionName || '').trim();
  if (name) planResetPending.add(name);
}

function buildPlanProgressPrompt(persisted, sessionName, opts) {
  // No turn state at all (direct calls, hosts that never pass opts) keeps the
  // full block: that is the pre-existing behaviour and cannot under-instruct.
  const firstTurn = !opts || opts.isFirstTurn !== false;
  const resetPending = sessionName ? planResetPending.delete(String(sessionName)) : false;
  if (!firstTurn && !resetPending) return PLAN_REMINDER;
  return [
    '[Plan the work and report the outcome - every turn] The status system (the succeeded/waiting badge, the summary line, the task board, the notifications) reads THIS conversation and nothing else. Anything you do not say here is invisible to it, and a claim with no visible result behind it counts as unfinished. So:',
    '  (1) Decompose before you act. For any request that takes more than one step, first give a short plan: 2-6 concrete steps, each with a verifiable outcome (a file changed, a command and what it printed, a behaviour you observed) rather than an activity ("analyse", "look into", "optimise"). Cover EVERY part of what was asked, including parallel asks buried in one sentence — a step missing from the plan is a step nobody will do.',
    '  (2) Keep one plan, do not re-plan. Reuse the plan already in this conversation: tick steps off as they land, add steps the work turns up, and do not restate the whole plan every turn.',
    '  (3) Before you end a turn in which the work moved, say where things stand — in the language of the conversation, as ordinary prose (no machine format, no markup, no English boilerplate inside a Chinese conversation). Name the steps that are done together with their evidence and how many of the plan\'s steps that is ("3/5 done: ..."), the steps still open, and who acts next: the user (a decision or a confirmation) or you (waiting on a job or a check).',
    '  (4) Never present an unfinished step as complete. "Done" means every step has a verifiable result; if you did part of it and stopped, or you are handing it back to the user, say exactly that. An unfinished item reported as done is the one error the status system cannot undo.',
    '  (5) A one-step or chat-only request needs no plan — just answer.',
    // Each context layer carries its own trailing separator (renderPrompt joins
    // with none), which is what keeps the block glued to the rest of the prompt.
  ].join('\n') + '\n\n';
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
  // Injected into chat-mode system prompt so the agent knows it can SHOW images to
  // the user: the web chat renders Markdown and rewrites local-path <img> through
  // /api/download, so an absolute-path image link just works.
  // The link is resolved every time the message is opened, so an image under
  // $TMPDIR or a test fixture directory turns into "cannot load image" once
  // that directory is cleaned; durable copies go to the swept assist root.
  const displayRoot = String(assistRoot || '~/.multicc/assist').replace(/\/+$/, '');
  const multiccImgHint = [
    'You are talking to the user inside the MultiCC web chat; replies render as Markdown. To SHOW a local image, link its ABSOLUTE path: ![caption](/absolute/path/to/image.png) — only for files that exist; wrap paths with spaces or parentheses in angle brackets, never percent-encode. Local file links work the same: [name](/abs/path/report.pdf). Details: multicc-local-resource skill.',
    `The chat stores only the path and loads it again whenever the message is opened, so never link an image that lives in $TMPDIR, /tmp, /var/folders or a test/fixture output directory: copy it first to \`${displayRoot}/$MULTICC_SESSION_ID/\` (kept 7 days) and link the copy, or publish it with the multicc-artifact skill when it must outlive that.`,
    '',
    ...buildHumanAssistPrompt(assistRoot),
    '',
    ...USER_INPUT_SIGNAL_PROMPT,
    '',
    '[Secrets safety rules] Never ask the user to paste an API key, token, password or other secret into the chat: chat content passes through LLM APIs. Call `list_secrets` first; if the entry is missing or stale, call `request_secret_input` (name, question), tell the user the dialog is open and end the turn — the value goes straight to the local vault and is never returned to you. Never read a vault value back into the conversation or logs. To use one, prefer `run_with_secrets` ({secrets:["NAME"], command that references $NAME}; output is scrubbed to [REDACTED:NAME]) or `http_request_with_secret` ({{secret:NAME}} placeholders); entries are also exported to later turns as env vars of the same name (except the ANTHROPIC_/CLAUDE_/OPENAI_/CODEX_/MULTICC_ namespaces). Do not try to print, encode or transform a secret.',
    '',
    `[Scheduled jobs] Only when the user explicitly asks for scheduled or periodic execution, register a MultiCC cron job (a fresh chat session runs the prompt when it fires): curl -s http://127.0.0.1:${env.PORT || 3000}/api/cron -H 'Content-Type: application/json' -d '{"name":"<job name>","dirPath":"<absolute current working directory>","cron":"0 9 * * *","prompt":"<complete instruction to run>"}' (5-field cron, local time). Then tell the user it is managed under "Scheduled jobs" in /manage.`,
    '',
    '[Waiting for external results - do not idle-wait] To wait on a deployment, an API or a third party, prefer `wait_for_external_result` (callback or delay mode): it registers a durable wait and MultiCC resumes this session when it resolves, so you may end the turn; check or cancel it with `get_external_wait` / `cancel_external_wait`. Only when the host itself must run a command or query a URL, POST $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/wait with {"mode":"poll","pollCmd":"<status command>" (or "pollUrl"),"untilContains":"<done text>" (or "untilRegex"),"intervalSec":15,"maxChecks":40}.',
    '',
    '[Background work] Every background task you start (Agent, Workflow, run_in_background Bash, Monitor) must end on its own: give Monitor the shortest timeout_ms you need (max 1 hour, never persistent) and stop it with TaskStop once done; use run_in_background only for commands that finish by themselves, and start servers or watchers detached (`nohup … > /tmp/x.log 2>&1 &`). Do not end the turn as "done" while a sub-agent or task you started is still running: wait for its result (blocking TaskOutput where available, or a completion marker such as /tmp/multicc_task_<name>.done for detached work). Hand work that must outlive the turn (>5 minutes) to run-detached or `dispatch_master` / `route_task`. While something long runs, post a one-line progress note about every 30 seconds (what, ~elapsed, latest key output) instead of going silent.',
    '',
    '[Worktree sync] Each chat session works only in its own git worktree + branch (multicc/<sessionId>); main is the read-only base. Sibling sync after a merge is best-effort, so check yourself before starting and at key points. The /sync endpoint is mainly for manual sync by the user/UI; it is not the required path for an agent to sync itself (a running session gets 409 busy by design). Self-sync: align with the local base branch directly with Git inside your own worktree — with no rebase/merge in progress and a clean tree, run `git rev-list --left-right --count HEAD...main`. Purely behind: fast-forward. Ahead or diverged: work out whether the commits are unique or already absorbed, then rebase or keep a recoverable ref; stop and report when dirty, conflicted or of unclear ownership. Never force, and never discard commits that cannot be proven to be in the baseline. Afterwards `git status --short` is empty and the behind count of `HEAD...main` must be 0; only `0 0` means fully aligned (ahead>0 is local work awaiting merge, not a conflict — do not mistake the endpoint\'s `unmerged` wording for a Git index conflict). A dispatched worker merges only when its task explicitly authorizes it; after hearing "merged", re-sync your own worktree.',
    '',
    '[Code search outside this worktree] In a MultiCC chat session, grep/rg via Bash against paths OUTSIDE the current worktree (the main repository root, other worktrees) returns empty stdout with no count and no error — that is not "0 matches" (detect: wc -l prints but grep -c prints nothing). Search those paths with the Read tool or a node fs line scan (Bash with dangerouslyDisableSandbox). When delegating to a sub-agent, Workflow or Task, tell it explicitly "no grep; use Read or node fs only", or it retries forever.',
    '',
    '[Where code lands and AutoCommit] Edit and verify only in your own worktree; never edit or revert anything in the main worktree. Commit and merge under AutoCommit (the session switch and the per-turn checkbox) are performed by MultiCC after a successful turn, so do not git commit or call the merge endpoint just because the task is done. Only when the user explicitly asks for commit/merge in the task, commit in your worktree and POST $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/merge. Otherwise report the result and leave the code for auto-commit or a manual merge.',
    '[Commit and release language] All new Git commit messages (subject and body, including automatic, merge, snapshot and backup commits) and release notes (title, headings and body) must be written in English. Use a specific English change description; never copy non-English task titles or chat summaries into them. Keep user-facing conversation, progress and delivery reports in the language requested by the user; this English-only rule applies to commit messages and release notes.',
    '[Commit identity] When the repository has commit-policy.json, use its name and email for both Git Author and Committer on every new commit, including manual Agent commits, merge commits and snapshots. Do not use provider, bot or inherited environment identities. Never rewrite historical commits merely to change attribution. GitHub push authentication is separate from commit attribution.',
    '',
    '[Shared files] Never put .env files, secrets, data files or other .gitignore-ignored files in a task worktree: worktrees are hibernated and reclaimed, and untracked ignored files are deleted for good. Files that must persist or be shared go in the MAIN REPOSITORY ROOT, named by purpose (e.g. config/dev.env, data/<purpose>.json), and are read by absolute path; for a temporary need, symlink or copy from there.',
  ].join('\n');
  return {
    codexEnvConstraint,
    codexStayAlivePrompt,
    multiccImgHint,
    userInputReminder: USER_INPUT_SIGNAL_PROMPT.join('\n'),
  };
}

module.exports = {
  createHostPrompts,
  buildSubagentProviderHint,
  buildHumanAssistPrompt,
  buildPlanProgressPrompt,
  markPlanContextReset,
};
