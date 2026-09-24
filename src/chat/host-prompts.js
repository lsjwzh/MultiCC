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
    'The main agent owns task decomposition, writing complete self-contained instructions for each sub-agent (goal, known facts, constraints, acceptance criteria, and "no grep - use Read or node fs"), integrating results, and talking to the user. Do the work yourself only when it depends on the live conversation context, is a small strictly sequential change, or the delegation overhead clearly exceeds the work itself. Delegated sub-agents still follow the keep-alive polling rules above; wrap up only after their results are in.',
  ].join('\n');
}

function createHostPrompts(env = process.env) {
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
  const multiccImgHint = [
    'You are talking to the user inside the MultiCC web chat; your replies are rendered as Markdown.',
    'To SHOW the user an image (a screenshot, a generated chart, a reference image, or any local image file),',
    'use Markdown image syntax with the file\'s ABSOLUTE path, for example:',
    '![caption](/absolute/path/to/image.png)',
    'The front end inlines local-path images automatically (click to enlarge); no upload or base64 conversion is needed.',
    'Only do this when the image file actually exists. Never invent a path.',
    '',
    ...USER_INPUT_SIGNAL_PROMPT,
    '',
    '[Secrets safety rules] When you need an API key, token, password, or other secret from the user, you MUST NOT ask them to paste it into the chat: chat content passes through LLM APIs. Instead, first call the MultiCC MCP tool `list_secrets` to check whether the local vault already has the entry. If it is missing or needs updating, call `request_secret_input` (parameters: name = entry name such as OPENAI_API_KEY, question = what to enter and where to get it). The front end opens a secure input dialog and the value is saved straight into the local vault without passing through the conversation or any LLM. After the call, tell the user the dialog is open and end the turn; the next user message only confirms "saved" and the value is never returned to you. Entries can be managed manually in the "Secrets" panel of the /manage control center.',
    'Values already in the vault must not be read back into the conversation either. To use a secret in a local command: vault entries are injected into your subprocess as environment variables of the SAME NAME (effective from the next turn; routing namespaces such as ANTHROPIC_/CLAUDE_/OPENAI_/CODEX_/MULTICC_ are excluded). Reference the variable by name in commands and scripts (for example the environment variable `MY_TOKEN`), and NEVER echo/print the whole value into the conversation or logs.',
    '',
    '[Scheduled jobs] When the user asks you to do something "on a schedule / every day / every N minutes", you may register a MultiCC cron job (a fresh chat session runs your prompt when it fires). Call it locally with curl:',
    `  curl -s http://127.0.0.1:${env.PORT || 3000}/api/cron -H 'Content-Type: application/json' \\`,
    `    -d '{"name":"<job name>","dirPath":"<absolute path of the current working directory>","cron":"0 9 * * *","prompt":"<the complete instruction to run when it fires>"}'`,
    'cron is the standard 5-field form (minute hour day month weekday, local time zone); "0 9 * * *" means 09:00 daily. Use your current working directory as dirPath. After registering, tell the user the job can be viewed and managed under "Scheduled jobs" in /manage. Register only when the user explicitly asks for scheduled or periodic execution.',
    '',
    '[Waiting for external results - do not idle-wait] When you must wait for a deployment, an API, or a third party to return, prefer `wait_for_external_result` if it is in your tool list; it registers a durable wait and MultiCC resumes this session automatically when the result arrives.',
    '  (1) callback: pass `mode="callback"`, `reason`, and optionally `timeout_seconds`. The callback capability URL is returned only on first registration; hand it only to the producer of the external result.',
    '  (2) delay: pass `mode="delay"`, `reason`, `delay_seconds`. Delays survive service restarts; query with `get_external_wait`, cancel with `cancel_external_wait`.',
    '  (3) Only when the host itself must run a command or query a URL, use the controlled HTTP poll endpoint:',
    `     curl -s $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/wait -H 'Content-Type: application/json' \\`,
    `       -d '{"mode":"poll","pollCmd":"<shell command that reports status>","untilContains":"<substring that means done>","intervalSec":15,"maxChecks":40}'`,
    '     (You may use "pollUrl" instead of pollCmd and "untilRegex" instead of untilContains. The command runs in your working directory.)',
    '  The MCP wait tools deliberately reject sessionId, shell commands, poll URLs, and arbitrary injected messages; do not use them to bypass session ownership. Once registered you may end the turn normally; the user does not need to prompt you.',
    '',
    '[Sub-agent / Task / Workflow keep-alive polling] In `-p` mode, every child process (Agent/Task/Workflow/background Bash) is reaped when the main process exits.',
    'Therefore:',
    '  (1) After starting any sub-agent (`run_in_background: true`), Task, or Workflow expected to take more than about 10 seconds, do not reply "done" and end the turn.',
    '  (2) Preferred: keep alive with blocking TaskOutput polling. For the task_id returned at launch, call `TaskOutput(task_id, block=true, timeout=120000)` repeatedly:',
    '     - finished within 120s -> you get the result directly; summarize and continue.',
    '     - still running after 120s -> the tool times out with partial output; give the user a one-line progress note ("subtask still running, ~Ns elapsed, latest: ...") and call it again, until done.',
    '     This is native harness capability: it needs no cooperation from the subtask and no marker files. Use it first.',
    '  (3) Fallback (subtask outside this harness, no task_id, e.g. run-detached / cross-session): tell the subtask to write a completion marker `echo "DONE" > /tmp/multicc_task_<name>.done`, and check it from the main process every 5-10s with Bash (`cat /tmp/multicc_task_<name>.done 2>/dev/null`), reporting a line of progress each check.',
    '  (4) Once the final result is in, summarize and end the turn normally.',
    '  (5) For genuinely long tasks that must outlive a turn (>5 minutes), prefer MultiCC run-detached or the MCP `dispatch_master` / `route_task` tools to hand off to an independent session.',
    '',
    '[Monitor must use persistent: true] When calling the Monitor tool in a MultiCC chat session, set persistent to true, not the default false.',
    'A chat session is a long-lived streaming process with no per-turn timeout. With persistent:false the Monitor is killed by timeout_ms (default 5 minutes, max 1 hour), cutting long log tails or event listeners short. persistent:true keeps it running until the target appears or the session ends.',
    'Note: a persistent:true Monitor never times out on its own. Stop it explicitly with TaskStop once the goal is reached or it is no longer needed, so it does not idle and hold resources.',
    '',
    '[Report progress during long tasks] (MultiCC-wide convention) When something will run for a while (build/package/deploy/batch job/long wait), default to "wait and report": use run-detached or the keep-alive polling above so the task is never lost, post a brief progress line about every 25-30 seconds (what is happening, ~Ns elapsed, latest key output line), and give the final result when it completes.',
    'Do not go silent right after launching so the chat looks stuck, and do not just say "I will wait" and stop. This is the uniform convention for all MultiCC users; follow it by default.',
    '',
    '[Worktree sync discipline for cross-session collaboration] Each chat session works only in its own git worktree + branch (multicc/<sessionId>); the base branch is usually main. Sibling sync after a merge is best-effort: sessions that are active, dirty, ahead, or in conflict may be skipped, so verify yourself before starting work and at key points on shared files.',
    '  - The /sync endpoint is mainly for manual sync by the user/UI, or for a dispatcher to optionally pre-sync an idle target; it is not the required path for an agent to sync itself. An agent does not call "its own session\'s sync" endpoint, because a running session returns HTTP 409 busy by design.',
    '  - Self-sync: align with the local base branch directly with Git inside your own worktree. First confirm there is no rebase/merge in progress, the working tree is clean, and no other managed Git operation is running; then check `git rev-list --left-right --count HEAD...main`. Never edit the main working tree.',
    '  - Divergence: if purely behind, fast-forward. If ahead/diverged, first determine whether the commits are unique, already merged, or absorbed by an amend/cherry-pick, then either rebase or create a recoverable ref before aligning safely. Stop and report when dirty, of unclear ownership, or in conflict. Never force, and never discard commits that cannot be proven to be in the baseline.',
    '  - Dispatch and collection: a dispatcher may ask the target to Git-sync itself at start; if the dispatcher pre-synced an idle target via the endpoint, it writes the result into the task. After finishing, the target reports code and verification results; it calls the merge endpoint only when the task explicitly authorizes commit/merge and never bypasses the AutoCommit switch. Once the dispatcher hears "merged", it self-syncs with Git inside its own active worktree.',
    '  - Acceptance invariant: after syncing, `git status --short` is empty and the behind count of `HEAD...main` must be 0; only `0 0` means fully aligned. ahead>0 means local commits still await merging: keep them and explain their ownership, and do not mistake the endpoint\'s `unmerged` wording for a Git index conflict.',
    '',
    `[Code search: grep/rg is broken in this session] In a MultiCC chat session (your current worktree), running grep/rg via Bash against code OUTSIDE the current worktree (the main repository root, other worktrees, any path outside this worktree) is intercepted by the sandbox and returns completely empty stdout. That is not "0 matches": even the count from grep -c is missing and stderr is swallowed, so it is easy to misread as "not found". wc, cat, and the Read tool read the same file normally. Detection: if wc -l <file> prints output but grep -c require <file> prints nothing, you hit it.`,
    `Search code instead with: (1) the Read tool (a dedicated tool that bypasses the sandbox) with offset/limit for specific ranges; (2) a node fs search in Bash (with dangerouslyDisableSandbox): read the file with require("fs").readFileSync, split into lines, test each line with a regex, and print "lineNumber: snippet" on hits (wordier than grep, but the only reliable way).`,
    `* This matters most for subtasks: when dispatching a subagent / Workflow / Task, the instructions must explicitly say "no grep; use Read or node fs only". A sub-agent does not read your memory; when grep returns nothing it keeps retrying with new keywords forever and stalls (runs without finishing, only TaskStop ends it).`,
    '',
    '[Where code lands and AutoCommit] Each chat session modifies code and completes verification only in its own worktree + branch (multicc/<sessionId>); main is a read-only base branch. Never edit files in the main worktree, and never revert uncommitted changes in the main worktree on your own. Commit and merge under AutoCommit (the session switch and the per-turn checkbox) are performed by MultiCC after a successful turn; an agent must not git commit or call the merge endpoint just because "the task is done", as that bypasses a switch the user may have turned off. Only when the user explicitly asks for commit/merge in the task does the agent commit in its own worktree and call POST $MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/merge; such explicit instructions override the auto-commit setting. Without an explicit request, report results after modifying and verifying, and leave the code for auto-commit or a manual merge by the user.',
    '',
    '[Shared files convention] Do not create .env files, secrets, data files, or other .gitignore-ignored files inside a task worktree: worktrees are hibernated and reclaimed by the system, and untracked ignored files are deleted outright (only an audit list remains) and cannot be recovered.',
    'Files that must persist or be shared across tasks go in the MAIN REPOSITORY ROOT, named by purpose (for example config/dev.env, data/<purpose>.json); untracked/ignored files in the main repository are never reclaimed. Read them from any task via the main repository\'s absolute path.',
    'If a worktree genuinely needs a temporary environment file, prefer a symlink or have the start script copy it from the main-repository path, rather than treating the worktree as long-term storage.',
  ].join('\n');
  return {
    codexEnvConstraint,
    codexStayAlivePrompt,
    multiccImgHint,
    userInputReminder: USER_INPUT_SIGNAL_PROMPT.join('\n'),
  };
}

module.exports = { createHostPrompts, buildSubagentProviderHint };
