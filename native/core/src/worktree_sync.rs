//! Best-effort synchronization before a restored workspace is handed to a runner.
//! The caller holds the repository actor lease for the entire operation.

use crate::publication_identity;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub ok: bool,
    pub action: &'static str,
    pub code: Option<&'static str>,
    pub backup_ref: Option<String>,
}

fn outcome(
    action: &'static str,
    code: Option<&'static str>,
    backup_ref: Option<String>,
) -> SyncResult {
    SyncResult {
        ok: code.is_none(),
        action,
        code,
        backup_ref,
    }
}

// Git only touches local refs. Bound every subprocess and drain its pipes on
// worker threads so neither large output nor a stuck helper can pin admission.
fn git(cwd: &Path, args: &[&str], env: &BTreeMap<String, String>) -> Result<String, String> {
    let mut child = Command::new("git")
        .current_dir(cwd)
        .args(["-c", "core.hooksPath=", "-c", "commit.gpgSign=false"])
        .args(args)
        .envs(env)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "wake_sync_git_failed".to_owned())?;
    let mut stdout = child.stdout.take().ok_or("wake_sync_git_failed")?;
    let mut stderr = child.stderr.take().ok_or("wake_sync_git_failed")?;
    let out = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let err = thread::spawn(move || std::io::copy(&mut stderr, &mut std::io::sink()));
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if start.elapsed() < Duration::from_secs(120) => {
                thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("wake_sync_git_failed".to_owned());
            }
        }
    };
    let bytes = out
        .join()
        .map_err(|_| "wake_sync_git_failed")?
        .map_err(|_| "wake_sync_git_failed")?;
    let _ = err.join();
    if !status?.success() {
        return Err("wake_sync_git_failed".into());
    }
    String::from_utf8(bytes).map_err(|_| "wake_sync_git_failed".into())
}

fn read(cwd: &Path, args: &[&str]) -> Result<String, String> {
    git(cwd, args, &BTreeMap::new()).map(|text| text.trim().to_owned())
}

fn verify_synced(worktree: &Path, base_oid: &str) -> Result<(), String> {
    read(worktree, &["merge-base", "--is-ancestor", base_oid, "HEAD"])?;
    if !read(
        worktree,
        &["status", "--porcelain", "--ignore-submodules=none"],
    )?
    .is_empty()
    {
        return Err("wake_sync_incomplete".into());
    }
    Ok(())
}

pub fn synchronize(
    repo: &Path,
    worktree: &Path,
    branch: &str,
    base: Option<&str>,
) -> Result<SyncResult, String> {
    let skip = |code| Ok(outcome("skipped", Some(code), None));
    let top = read(worktree, &["rev-parse", "--show-toplevel"])?;
    if fs::canonicalize(top).ok() != fs::canonicalize(worktree).ok()
        || read(worktree, &["symbolic-ref", "--quiet", "HEAD"]).ok()
            != Some(format!("refs/heads/{branch}"))
    {
        return skip("wake_sync_branch_mismatch");
    }
    let common = |cwd: &Path| -> Result<_, String> {
        let path = read(cwd, &["rev-parse", "--git-common-dir"])?;
        fs::canonicalize(cwd.join(path)).map_err(|_| "wake_sync_git_failed".into())
    };
    if common(repo)? != common(worktree)? {
        return skip("wake_sync_branch_mismatch");
    }
    for marker in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "BISECT_START",
        "rebase-merge",
        "rebase-apply",
        "sequencer",
    ] {
        let path = read(worktree, &["rev-parse", "--git-path", marker])?;
        if worktree
            .join(path)
            .try_exists()
            .map_err(|_| "wake_sync_git_failed")?
        {
            return skip("wake_sync_git_operation_active");
        }
    }
    if !read(
        worktree,
        &[
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )?
    .is_empty()
    {
        return skip("wake_sync_dirty");
    }
    let base = match base.filter(|name| !name.is_empty()) {
        Some(name) => name.to_owned(),
        None => read(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .unwrap_or_else(|_| "main".into()),
    };
    let base_ref = format!("refs/heads/{base}");
    let base_oid = match read(
        worktree,
        &["rev-parse", "--verify", &format!("{base_ref}^{{commit}}")],
    ) {
        Ok(oid) => oid,
        Err(_) => return skip("wake_sync_base_missing"),
    };
    let head = read(worktree, &["rev-parse", "HEAD"])?;
    let counts = read(
        worktree,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("HEAD...{base_oid}"),
        ],
    )?;
    let counts: Vec<_> = counts.split_whitespace().collect();
    if counts.len() != 2 {
        return Err("wake_sync_git_failed".into());
    }
    if counts[1] == "0" {
        return Ok(outcome("current", None, None));
    }
    if counts[0] == "0" {
        git(
            worktree,
            &["merge", "--ff-only", &base_oid],
            &BTreeMap::new(),
        )?;
        verify_synced(worktree, &base_oid)?;
        return Ok(outcome("fast_forward", None, None));
    }
    // A disconnected history is not a safe automatic replay target.
    if read(worktree, &["merge-base", "HEAD", &base_oid]).is_err() {
        return skip("wake_sync_unrelated_history");
    }
    // Rebase creates commits: enforce the same language and identity policy as
    // manual publication before changing any ref. Never rewrite old messages.
    // The directory checkout is authoritative; a local commit may itself edit
    // commit-policy.json and must not choose a different replay identity.
    let policy = publication_identity::repository_policy(repo)?;
    let log = git(
        worktree,
        &[
            "log",
            publication_identity::LOG_FORMAT,
            &format!("{base_oid}..HEAD"),
        ],
        &BTreeMap::new(),
    )?;
    if publication_identity::validate_records(&log, policy.as_ref()).is_err() {
        return skip("wake_sync_publication_policy");
    }
    let env = publication_identity::command_environment(repo, &["rebase".into()])?;
    let backup = format!("refs/multicc/wake-backups/{branch}/{head}");
    read(worktree, &["update-ref", "--create-reflog", &backup, &head])?;
    let result = git(
        worktree,
        &[
            "-c",
            "rebase.autoStash=false",
            "-c",
            "rebase.updateRefs=false",
            "rebase",
            "--no-autostash",
            "--rebase-merges",
            &base_oid,
        ],
        &env,
    );
    if result.is_err() {
        let conflicted = !read(worktree, &["diff", "--name-only", "--diff-filter=U"])
            .unwrap_or_default()
            .is_empty();
        // This invocation began with no Git operation, so any rebase here is
        // ours. Abort restores the retained session tip and its snapshot bytes.
        let aborted = read(worktree, &["rebase", "--abort"]).is_ok();
        let restored = read(worktree, &["rev-parse", "HEAD"]).ok() == Some(head)
            && read(worktree, &["status", "--porcelain"]).is_ok_and(|s| s.is_empty())
            && (!conflicted || aborted);
        return Ok(outcome(
            "skipped",
            Some(if !restored {
                "wake_sync_recovery_required"
            } else if conflicted {
                "wake_sync_conflict"
            } else {
                "wake_sync_rebase_failed"
            }),
            Some(backup),
        ));
    }
    verify_synced(worktree, &base_oid)?;
    Ok(outcome("rebase", None, Some(backup)))
}
