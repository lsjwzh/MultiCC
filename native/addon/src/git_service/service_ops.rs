use super::{base_branch, lines, GitContext, GitError};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

mod bundle;
mod merge;

const SUBDIR: &str = multicc_core::docs_memory_routes::WORKTREE_SUBDIR;
type Outcome = Result<Value, GitError>;

fn string(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}
fn arg(args: &[Value], index: usize) -> &Value {
    args.get(index).unwrap_or(&Value::Null)
}
fn required<'a>(value: &'a Value, label: &str) -> Result<&'a str, GitError> {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| GitError::new(format!("{label} is required")))
}
fn enabled(opts: &Value, key: &str) -> bool {
    match &opts[key] {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().unwrap_or_default() != 0.,
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn error_text(error: &GitError) -> &str {
    if error.stderr.is_empty() {
        error.message.trim()
    } else {
        error.stderr.trim()
    }
}
async fn base(ctx: &mut GitContext, dir: &Value) -> String {
    if let Some(b) = dir["baseBranch"].as_str().filter(|s| !s.is_empty()) {
        b.to_owned()
    } else {
        base_branch(ctx, string(&dir["path"])).await
    }
}
pub(super) async fn ensure_excluded(ctx: &mut GitContext, repo: &str) -> Result<(), GitError> {
    let git_dir = ctx.git(repo, &["rev-parse", "--git-dir"]).await?;
    let exclude = Path::new(repo).join(git_dir).join("info").join("exclude");
    let bytes = fs::read(&exclude).unwrap_or_default();
    let entry = format!("{SUBDIR}/");
    if !String::from_utf8_lossy(&bytes)
        .lines()
        .any(|s| s.trim() == entry)
    {
        fs::create_dir_all(exclude.parent().unwrap())?;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(exclude)?;
        let newline = if !bytes.is_empty() && !bytes.ends_with(b"\n") {
            "\n"
        } else {
            ""
        };
        writeln!(file, "{newline}{entry}")?;
    }
    Ok(())
}
pub(super) async fn commit_all(
    ctx: &mut GitContext,
    wt: &str,
    message: &str,
) -> Result<bool, GitError> {
    ctx.git(wt, &["add", "-A"]).await?;
    if ctx.git(wt, &["diff", "--cached", "--quiet"]).await.is_ok() {
        return Ok(false);
    }
    ctx.git(wt, &["commit", "-m", message]).await?;
    Ok(true)
}

fn canonical(path: &str) -> PathBuf {
    fs::canonicalize(path)
        .or_else(|_| std::path::absolute(path))
        .unwrap_or_else(|_| path.into())
}
pub(super) async fn validation(
    ctx: &mut GitContext,
    repo: &str,
    wt: &str,
    branch: &str,
) -> Outcome {
    let expected = canonical(wt);
    let reference = format!("refs/heads/{branch}");
    let exists = Path::new(wt).exists();
    let listing = ctx
        .git(repo, &["worktree", "list", "--porcelain"])
        .await
        .unwrap_or_default();
    let listing = listing.replace("\r\n", "\n");
    let registered = listing.split("\n\n").find(|block| {
        block
            .lines()
            .filter_map(|line| line.strip_prefix("worktree "))
            .any(|path| canonical(path) == expected)
    });
    let branch_exists = ctx
        .git(
            repo,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{reference}^{{commit}}"),
            ],
        )
        .await
        .is_ok();
    let code = if registered.is_some_and(|block| {
        !block
            .lines()
            .any(|line| line.strip_prefix("branch ") == Some(reference.as_str()))
    }) {
        Some("WORKTREE_BRANCH_MISMATCH")
    } else if !branch_exists {
        Some("WORKTREE_BRANCH_MISSING")
    } else if registered.is_none() {
        Some("WORKTREE_NOT_REGISTERED")
    } else if !exists {
        Some("WORKTREE_PATH_MISSING")
    } else {
        None
    };
    Ok(json!({"ok":code.is_none(),"code":code,"pathExists":exists,"branchExists":branch_exists}))
}
pub(super) async fn add(
    ctx: &mut GitContext,
    repo: &str,
    session: &str,
    base: &str,
    opts: &Value,
) -> Outcome {
    if enabled(opts, "planned") {
        let (repo, session, base) = (repo.to_owned(), session.to_owned(), base.to_owned());
        return tokio::task::spawn_blocking(move || {
            crate::worktree_sync::planned_result(&repo, &session, &base)
        })
        .await
        .map_err(|e| GitError::new(e.to_string()))?
        .map_err(GitError::new);
    }
    let workdir = Path::new(repo).join(SUBDIR);
    let path = workdir.join(session);
    let wt = path.to_string_lossy();
    let branch = format!("multicc/{session}");
    ctx.progress("prepare", Value::Null).await?;
    ensure_excluded(ctx, repo).await?;
    fs::create_dir_all(&workdir)?;
    let _ = ctx.git(repo, &["worktree", "prune"]).await;
    let branch_exists = ctx
        .git(repo, &["rev-parse", "--verify", &branch])
        .await
        .is_ok();
    let require = enabled(opts, "requireExistingBranch");
    if require && !branch_exists {
        return Err(GitError::coded(
            "WORKTREE_BRANCH_MISSING",
            "session branch is missing",
        ));
    }
    let existing = path.is_dir();
    if existing && require {
        let result = validation(ctx, repo, &wt, &branch).await?;
        if result["ok"] != true {
            return Err(GitError::coded(
                string(&result["code"]),
                "existing worktree does not match the session branch",
            ));
        }
    }
    if !existing {
        ctx.progress("create", json!({"worktreePath":wt,"branch":branch}))
            .await?;
        if branch_exists {
            ctx.git(repo, &["worktree", "add", &wt, &branch]).await?;
        } else {
            ctx.git(repo, &["worktree", "add", &wt, "-b", &branch, base])
                .await?;
        }
    }
    let mut result = json!({"ok":true,"worktreePath":wt,"branch":branch,"existing":existing});
    if enabled(opts, "__trackCreatedResources") {
        result["branchExisted"] = json!(branch_exists);
    }
    if enabled(opts, "syncFromBase") {
        let (repo, wt, base) = (PathBuf::from(repo), path, base.to_owned());
        let sync = tokio::task::spawn_blocking(move || {
            multicc_core::worktree_sync::synchronize(
                &repo,
                &wt,
                &branch,
                (!base.is_empty()).then_some(base.as_str()),
            )
        })
        .await;
        result["sync"] = sync
            .ok()
            .and_then(Result::ok)
            .and_then(|v| serde_json::to_value(v).ok())
            .unwrap_or_else(|| json!({"ok":false,"code":"wake_sync_failed"}));
    }
    Ok(result)
}
pub(super) use merge::merge_state;

pub(super) async fn dispatch(name: &str, args: &[Value], ctx: &mut GitContext) -> Outcome {
    let (a, b, c, d) = (arg(args, 0), arg(args, 1), arg(args, 2), arg(args, 3));
    match name {
        "gitExportSessionBundle" => bundle::export(ctx, a, b, c, args.get(3)).await,
        "gitImportSessionBundle" => bundle::import(ctx, a, b, c, d).await,
        "gitEnsureExcluded" => {
            ensure_excluded(ctx, string(a)).await?;
            Ok(json!({"ok":true}))
        }
        "gitWorktreeCommitAll" => {
            ctx.progress("commit", Value::Null).await?;
            Ok(json!({"ok":true,"committed":commit_all(ctx,string(a),string(b)).await?}))
        }
        "gitWorktreeAdd" => add(ctx, string(a), string(b), string(c), d).await,
        "gitWorktreeValidate" => validation(ctx, string(a), string(b), string(c)).await,
        "gitWorktreeMergeState" => Ok(json!({"ok":true,"state":merge_state(ctx,a,b).await?})),
        "gitMergeBack" => merge::merge_back(ctx, a, b).await,
        "gitSyncFromBase" => merge::sync(ctx, a, b, c).await,
        "gitRebaseResolve" => merge::resolve(ctx, a, b, string(c)).await,
        "checkMergedJsSyntax" => Ok(Value::Array(
            merge::syntax(ctx, string(a), string(b), string(c)).await,
        )),
        _ => Err(GitError::new(format!(
            "unknown git service operation: {name}"
        ))),
    }
}
