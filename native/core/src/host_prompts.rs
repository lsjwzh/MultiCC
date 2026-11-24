//! Host-authored system prompt policies and turn-plan wording.
//!
//! Rust owns prompt assembly, execution-efficiency steering (parallel tool
//! batching, scoped reads, merged edits), sub-agent delegation guidance, and
//! compact wording so the stable system prefix stays lean without losing any
//! host safety contract.
use crate::js::{self, JsValue as V};

const EXECUTION_EFFICIENCY: &str = "\
[Execution efficiency - batch calls & scope reads] Every extra sequential API round-trip replays the full conversation prefix, so minimize step count and context bloat:
- Parallelize independent reads and searches: emit all independent Read, Grep, Glob, or Bash queries in ONE response rather than 1-by-1 serial calls; chain dependent shell steps with `&&` and independent checks with `;`.
- Scope reads before opening files: locate targets with Grep/Glob first, then read only the needed line ranges instead of dumping whole large files into context.
- Merge edits per file: plan all hunks for a file before editing rather than splitting changes across many tiny sequential Edit round-trips; do not re-read unchanged files or re-run passing checks without new edits.
- Offload broad fan-out exploration, multi-file scans, or noisy test/log triage to read-only/Explore sub-agents (in parallel when independent) so raw search output does not bloat the main conversation prefix.";

const PLAN_FULL: &str = "\
[Plan the work and report the outcome - every turn] The status system reads THIS conversation only; unreported results count as unfinished:
  (1) Decompose before you act. For multi-step work, first give 2-6 concrete steps, each with a verifiable outcome (file changed, command output, observed behaviour) covering every part of the request.
  (2) Keep one plan, do not re-plan: tick steps off as they land and add newly discovered steps without restating the full plan each turn.
  (3) Before ending a turn with progress, report status in the conversation's language as ordinary prose (no machine format or English boilerplate in a Chinese reply): completed steps with evidence and progress count (e.g. \"3/5 done\"), open steps, and who acts next.
  (4) Never present an unfinished step as complete; if partial or handing back to the user, say so explicitly.
  (5) One-step or chat-only requests need no plan — just answer.\n\n";

const PLAN_REMINDER: &str = "\
[Plan + outcome - every turn] Keep the existing plan (tick steps off, do not restate it). Before ending a turn with progress, report done steps with evidence (\"3/5 done\"), open steps, and who acts next in the conversation's language; never present an unfinished step as complete.\n\n";

pub fn execution_efficiency_prompt() -> &'static str {
    EXECUTION_EFFICIENCY
}

pub fn subagent_provider_hint(provider_id: &str, model: &str) -> String {
    let provider = provider_id.trim();
    if provider.is_empty() {
        return String::new();
    }
    let model = model.trim();
    let route = if model.is_empty() {
        provider.to_string()
    } else {
        format!("{provider} / {model}")
    };
    [
        format!(
            "[Sub-agent provider configured: delegate token-heavy work to sub-agents] Sub-agents route through a dedicated provider ({route}) billed outside the main route's quota, so doing token-heavy work directly in the main agent is more expensive."
        ),
        "By default, fan out independent work in parallel via sub-agents (Agent/Task tools, `run_in_background` for concurrent units): broad code search/reading, multi-file scans, long log or test-failure triage, cross-layer or multi-file refactors, and independently verifiable subtasks.".to_string(),
        "Include concrete coding actions too (writing or editing a self-contained file/function or scoped layer change) instead of running long serial Read/Edit/Bash chains inline on the main route whenever the goal and acceptance check are clear.".to_string(),
        "Main agent owns decomposition, complete self-contained briefs (goal, known facts, constraints, acceptance criteria, and \"no grep - use Read or node fs\"), result integration, and user replies. Act inline only when tightly coupled to live chat context or trivially small. Wait for delegated sub-agents before wrapping up.".to_string(),
    ]
    .join("\n")
}

pub fn human_assist_prompt(assist_root: &str) -> Vec<String> {
    let raw = assist_root.trim();
    let base = if raw.is_empty() {
        "~/.multicc/assist"
    } else {
        raw.trim_end_matches('/')
    };
    vec![
        "[Human assist via annotated screenshots] When a web/desktop step needs a person (captcha, 2FA, QR, unclear UI, or same step failed twice), ask with a screenshot instead of guessing; for hands-on remote control see multicc-human-assist.".to_string(),
        format!(
            "  (1) Save frames under `{base}/$MULTICC_SESSION_ID/` (7-day retention; never publish as artifacts) and record each coordinate base (desktop logical LWxLH from `mcu.sh snap` or CSS viewport)."
        ),
        "  (2) Show <=5 frames oldest-first as `![step N](/abs/path.png)`, state what you tried and need, then call wait_for_user_answer.".to_string(),
        "  (3) `[annotation] src=<path> size=WxH` ... `[/annotation]` carries 0..1 marks (`#n point x,y`, `#n box x1,y1-x2,y2`, `#n arrow x1,y1->x2,y2`, optional ` — <note>`, optional `note: <overall instructions>`) plus an annotated PNG. Scale by coordinate base (not PNG size), re-snapshot to verify, prefer real elements over raw coordinates, and post a result screenshot.".to_string(),
        "  (4) `[annotation-refresh] src=<path>` means stale: recapture and re-ask.".to_string(),
        "  (5) Vault values named in the answer are read via env var NAME only, never echoed. Slider captchas, locked screens or physical steps: ask the user to perform them and reply when done.".to_string(),
    ]
}

pub fn plan_progress_prompt(full: bool) -> &'static str {
    if full {
        PLAN_FULL
    } else {
        PLAN_REMINDER
    }
}

pub fn host_system_hint(assist_root: &str, port: &str, user_input_lines: &[String]) -> String {
    let raw_root = assist_root.trim();
    let display_root = if raw_root.is_empty() {
        "~/.multicc/assist"
    } else {
        raw_root.trim_end_matches('/')
    };
    let port = if port.trim().is_empty() {
        "3000"
    } else {
        port.trim()
    };

    let mut lines: Vec<String> = vec![
        "You are talking to the user inside the MultiCC web chat; replies render as Markdown. Show local images/files by ABSOLUTE path: `![caption](/abs/path.png)` / `[name](/abs/path.pdf)` (only existing files; wrap paths with spaces/parentheses in `<>`, never percent-encode; details: multicc-local-resource).".to_string(),
        format!(
            "Never link images under `$TMPDIR`, `/tmp`, `/var/folders` or test fixture dirs (they break after cleanup): copy to `{display_root}/$MULTICC_SESSION_ID/` (kept 7 days) or publish via multicc-artifact; print the exact path from shell (`$MULTICC_SESSION_ID` already includes `task-`)."
        ),
        String::new(),
        EXECUTION_EFFICIENCY.to_string(),
        String::new(),
    ];
    lines.extend(human_assist_prompt(display_root));
    lines.push(String::new());
    lines.extend(user_input_lines.iter().cloned());
    lines.extend([
        String::new(),
        "[Secrets safety rules] Never ask the user to paste secrets into chat. Call `list_secrets` first; if missing/stale, call `request_secret_input` (name, question), tell the user the dialog is open and end the turn. Never read back, log, encode, or transform vault values; consume via `run_with_secrets` ({secrets:[\"NAME\"], command using $NAME}) or `http_request_with_secret` ({{secret:NAME}}), or exported env vars on later turns (excluding ANTHROPIC_/CLAUDE_/OPENAI_/CODEX_/MULTICC_).".to_string(),
        String::new(),
        format!(
            "[Scheduled jobs] Only when explicitly asked for scheduled/periodic runs, register a cron job: `curl -s http://127.0.0.1:{port}/api/cron -H 'Content-Type: application/json' -d '{{\"name\":\"<name>\",\"dirPath\":\"<abs cwd>\",\"cron\":\"0 9 * * *\",\"prompt\":\"<instruction>\"}}'` (5-field local time; managed under \"Scheduled jobs\" in /manage)."
        ),
        String::new(),
        "[Waiting for external results - do not idle-wait] Prefer `wait_for_external_result` (callback/delay): it registers a durable wait and resumes this session when resolved so you may end the turn (check/cancel via `get_external_wait` / `cancel_external_wait`). Only when the host itself must run a command or query a URL, POST `$MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/wait` with `{\"mode\":\"poll\",\"pollCmd\":\"<cmd>\"|\"pollUrl\":\"<url>\",\"untilContains\":\"<text>\"|\"untilRegex\":\"<re>\",\"intervalSec\":15,\"maxChecks\":40}`.".to_string(),
        String::new(),
        "[Background work] Every background task (Agent, Workflow, run_in_background Bash, Monitor) must terminate: set minimal Monitor `timeout_ms` (<=1h) and stop via TaskStop when done; detach long servers/watchers (`nohup ... > /tmp/x.log 2>&1 &`). Never end a turn as \"done\" while your background tasks are still running; wait for completion (TaskOutput or marker file). Delegate >5m work to run-detached or `dispatch_master` / `route_task`, and post a one-line progress note every ~30s during long runs.".to_string(),
        String::new(),
        "[Worktree sync] Work only in your own git worktree (`multicc/<sessionId>`); `main` is read-only. The /sync endpoint is mainly for manual sync by the user/UI; it is not the required path for an agent to sync itself (a running session gets 409 busy by design). Self-sync: align with the local base branch directly with Git inside your own worktree — on a clean tree run `git rev-list --left-right --count HEAD...main` (behind only: fast-forward; ahead/diverged: verify unique commits then rebase or keep recoverable ref; stop and report when dirty, conflicted or of unclear ownership; never force and never discard commits that cannot be proven to be in the baseline). Afterwards `git status --short` is empty and the behind count of `HEAD...main` must be 0; only `0 0` means fully aligned (ahead>0 is awaiting merge — do not mistake the endpoint's `unmerged` wording for a Git index conflict). Dispatched workers merge only when authorized; after \"merged\", re-sync.".to_string(),
        String::new(),
        "[Code search outside this worktree] Bash grep/rg on paths OUTSIDE this worktree (main repo root, sibling worktrees) returns empty stdout with no error; use Read or a node fs scan (`dangerouslyDisableSandbox`). Always tell delegated sub-agents/Workflows \"no grep; use Read or node fs only\".".to_string(),
        String::new(),
        "[Where code lands and AutoCommit] Edit and verify only in your own worktree; never touch the main worktree. Commit and merge under AutoCommit (the session switch and per-turn checkbox) are performed by MultiCC after a successful turn, so do not git commit or call merge just because work is done. Only when the user explicitly asks for commit/merge in the task, commit in your worktree and POST `$MULTICC_BASE_URL/api/sessions/$MULTICC_SESSION_ID/merge`.".to_string(),
        "[Commit identity] Let Git use the user’s own configuration, command arguments and environment for local commits. Preserve external commits and never rewrite history just for attribution; GitHub push auth is separate.".to_string(),
        String::new(),
        "[Shared files] Never place long-lived .gitignore-ignored files (.env, secrets, data) in a task worktree (reclaimed on hibernation). Store them in the MAIN REPOSITORY ROOT by purpose (`config/dev.env`, `data/<purpose>.json`) and read by absolute path or temporary symlink.".to_string(),
    ]);
    lines.join("\n")
}

pub fn request(op: &str, raw: &str) -> Result<String, String> {
    let input = js::json_parse(raw).map_err(|error| error.to_string())?;
    let output = match op {
        "execution-efficiency" => V::from(execution_efficiency_prompt()),
        "subagent-hint" => {
            let provider_id = input
                .get("providerId")
                .map(js::js_to_string)
                .map(|s| s.to_string_lossy())
                .unwrap_or_default();
            let model = input
                .get("model")
                .map(js::js_to_string)
                .map(|s| s.to_string_lossy())
                .unwrap_or_default();
            V::from(subagent_provider_hint(&provider_id, &model))
        }
        "human-assist" => {
            let assist_root = input
                .get("assistRoot")
                .map(js::js_to_string)
                .map(|s| s.to_string_lossy())
                .unwrap_or_default();
            V::Array(
                human_assist_prompt(&assist_root)
                    .into_iter()
                    .map(V::from)
                    .collect(),
            )
        }
        "host-hint" => {
            let assist_root = input
                .get("assistRoot")
                .map(js::js_to_string)
                .map(|s| s.to_string_lossy())
                .unwrap_or_default();
            let port = input
                .get("port")
                .map(js::js_to_string)
                .map(|s| s.to_string_lossy())
                .unwrap_or_default();
            let user_input_lines = match input.get("userInputLines") {
                Some(V::Array(items)) => items
                    .iter()
                    .map(|item| js::js_to_string(item).to_string_lossy())
                    .collect(),
                _ => Vec::new(),
            };
            V::from(host_system_hint(&assist_root, &port, &user_input_lines))
        }
        "plan-progress" => {
            let full = input.get("full") != Some(&V::Bool(false));
            V::from(plan_progress_prompt(full))
        }
        _ => return Err(format!("unknown host_prompts operation: {op}")),
    };
    Ok(js::json_stringify_or_undefined(&output))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_hint_carries_efficiency_steering_and_stays_compact() {
        let hint = host_system_hint("/data/assist/", "3000", &["[Waiting for a user answer]".into()]);
        assert!(hint.contains("[Execution efficiency - batch calls & scope reads]"));
        assert!(hint.contains("Parallelize independent reads and searches"));
        assert!(hint.contains("Scope reads before opening files"));
        assert!(hint.contains("Merge edits per file"));
        assert!(!hint.contains("Sub-agent provider configured"));
        assert!(hint.len() < 7600, "expected slimmed host hint, got {} chars", hint.len());
    }

    #[test]
    fn subagent_hint_preserves_route_and_delegation_contracts() {
        assert_eq!(subagent_provider_hint("", "m"), "");
        let p_only = subagent_provider_hint("p1", "");
        assert!(p_only.contains("(p1)"));
        let full = subagent_provider_hint("xf-ds4", "deepseek-v4");
        assert!(full.contains("Sub-agent provider configured"));
        assert!(full.contains("xf-ds4 / deepseek-v4"));
        assert!(full.contains("token-heavy work"));
        assert!(full.contains("concrete coding actions"));
        assert!(full.contains("no grep - use Read or node fs"));
        assert!(full.contains("parallel"));
    }

    #[test]
    fn plan_prompts_preserve_contract_and_ratio() {
        let full = plan_progress_prompt(true);
        let reminder = plan_progress_prompt(false);
        for kw in [
            "Decompose before you act",
            "verifiable outcome",
            "Keep one plan",
            "ordinary prose",
            "Never present an unfinished step as complete",
        ] {
            assert!(full.contains(kw), "missing {kw}");
        }
        assert!(reminder.starts_with("[Plan + outcome"));
        assert!(reminder.contains("never present an unfinished step as complete"));
        assert!(reminder.len() * 3 < full.len());
        assert!(full.ends_with("\n\n"));
        assert!(reminder.ends_with("\n\n"));
    }
}
