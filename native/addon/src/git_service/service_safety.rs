use super::{base_branch, lines, service_ops, GitContext, GitError};
use serde_json::{json, Value};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

mod carry;
mod transfer;

type Outcome = Result<Value, GitError>;

fn arg(args: &[Value], index: usize) -> &Value {
    args.get(index).unwrap_or(&Value::Null)
}

fn string(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn error_text(err: &GitError) -> &str {
    if err.stderr.is_empty() {
        err.message.trim()
    } else {
        err.stderr.trim()
    }
}

fn coded(message: impl Into<String>, code: &str) -> GitError {
    GitError::new(message).with("code", json!(code))
}

fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_owned())
}

fn exists(path: &str) -> bool {
    !path.is_empty() && Path::new(path).exists()
}

fn session_name<'a>(opts: &'a Value, worktree: &'a str, branch: &'a str) -> &'a str {
    if let Some(s) = opts["sessionId"].as_str().filter(|s| !s.is_empty()) {
        return s;
    }
    Path::new(if worktree.is_empty() {
        branch
    } else {
        worktree
    })
    .file_name()
    .and_then(|n| n.to_str())
    .unwrap_or("session")
}

fn iso_time(time: SystemTime) -> Option<String> {
    let millis = match time.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as f64,
        Err(e) => -(e.duration().as_millis() as f64),
    };
    multicc_core::js::date_to_iso_string(millis)
}

fn safe_relative(path: &str) -> bool {
    let name = path.replace('\\', "/");
    !name.is_empty()
        && !name.starts_with('/')
        && !Path::new(path).is_absolute()
        && !name.split('/').any(|part| part == "..")
}

fn reclaimable(relative: &str) -> bool {
    const DIRS: &[&str] = &[
        "node_modules",
        ".dart_tool",
        "build",
        ".gradle",
        "logs",
        ".journal",
        "app/node_modules",
        "app/.dart_tool",
        "app/build",
        "app/.gradle",
        "android/.gradle",
        "app/android/.gradle",
        "app/ios/Flutter/ephemeral",
    ];
    const FILES: &[&str] = &[
        "app/.flutter-plugins-dependencies",
        "app/android/local.properties",
        "app/ios/Flutter/Generated.xcconfig",
        "app/ios/Flutter/flutter_export_environment.sh",
        "app/android/app/src/main/java/io/flutter/plugins/GeneratedPluginRegistrant.java",
        "app/ios/Runner/GeneratedPluginRegistrant.h",
        "app/ios/Runner/GeneratedPluginRegistrant.m",
    ];
    let name = relative.replace('\\', "/");
    let name = name.strip_prefix("./").unwrap_or(&name);
    if !safe_relative(name) {
        return false;
    }
    if name == ".DS_Store"
        || name.ends_with("/.DS_Store")
        || FILES.contains(&name)
        || DIRS.iter().any(|d| {
            name == *d
                || name
                    .strip_prefix(d)
                    .is_some_and(|rest| rest.starts_with('/'))
        })
    {
        return true;
    }
    // The previous APK pattern also accepted mixed-case app/build components.
    let lower = name.to_ascii_lowercase();
    if let Some(file) = lower.strip_prefix("app/build/app/outputs/flutter-apk/") {
        if file.len() > 4 && !file.contains('/') && file.ends_with(".apk") {
            return true;
        }
    }
    let mut rest = lower.strip_prefix("app/").unwrap_or(&lower);
    while let Some((_, tail)) = rest
        .strip_prefix("build/")
        .and_then(|p| p.split_once('/'))
        .filter(|(part, _)| !part.is_empty())
    {
        rest = tail;
    }
    !rest.contains('/') && rest.starts_with("multicc") && rest.ends_with(".apk")
}

fn manifest(root: &str, relative: &str) -> Value {
    let target = Path::new(root).join(relative.trim_end_matches('/'));
    let Ok(meta) = fs::symlink_metadata(&target) else {
        return json!({"path":relative,"bytes":0,"mtime":null});
    };
    let mtime = meta.modified().ok().and_then(iso_time);
    if !meta.is_dir() {
        return json!({"path":relative,"bytes":meta.len(),"mtime":mtime});
    }
    let mut stack = vec![target];
    let (mut bytes, mut files, mut truncated) = (0u64, 0usize, false);
    'scan: while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if files >= 2000 {
                truncated = true;
                break 'scan;
            }
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                stack.push(entry.path());
            } else {
                files += 1;
                bytes += fs::symlink_metadata(entry.path()).map_or(0, |s| s.len());
            }
        }
    }
    json!({"path":relative,"bytes":bytes,"mtime":mtime,"files":files,"truncated":truncated})
}

async fn active_operation(ctx: &mut GitContext, wt: &str) -> Option<&'static str> {
    for (marker, kind) in [
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry_pick"),
        ("REVERT_HEAD", "revert"),
        ("BISECT_START", "bisect"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
    ] {
        if let Ok(path) = ctx.git(wt, &["rev-parse", "--git-path", marker]).await {
            if Path::new(wt).join(path).exists() {
                return Some(kind);
            }
        }
    }
    None
}

async fn ignored(ctx: &mut GitContext, wt: &str) -> Vec<String> {
    ctx.git(
        wt,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
            "--directory",
        ],
    )
    .await
    .unwrap_or_default()
    .split('\0')
    .filter(|s| !s.is_empty())
    .map(str::to_owned)
    .collect()
}

async fn detach(ctx: &mut GitContext, repo: &str, wt: &str, branch: &str) -> Outcome {
    let valid = service_ops::validation(ctx, repo, wt, branch).await?;
    if valid["ok"] != true {
        return Err(coded(
            "session worktree validation failed",
            string(&valid["code"]),
        ));
    }
    if let Some(kind) = active_operation(ctx, wt).await {
        return Err(coded(
            "worktree has an active Git operation",
            "HIBERNATE_GIT_OPERATION_ACTIVE",
        )
        .with("operation", json!(kind)));
    }
    let ignored = ignored(ctx, wt).await;
    for name in &ignored {
        if !safe_relative(name)
            || !Path::new(name)
                .components()
                .any(|c| matches!(c, std::path::Component::Normal(_)))
        {
            return Err(coded(
                "ignored cache path escaped worktree",
                "HIBERNATE_CACHE_PATH_INVALID",
            ));
        }
    }
    let unknown: Vec<_> = ignored.iter().filter(|s| !reclaimable(s)).collect();
    let mut removed: Vec<_> = unknown.iter().take(64).map(|s| manifest(wt, s)).collect();
    if unknown.len() > 64 {
        removed.push(json!({"path":format!("…and {} more",unknown.len()-64),"bytes":0,"mtime":null,"truncated":true}));
    }
    ctx.progress("snapshot", Value::Null).await?;
    let committed =
        service_ops::commit_all(ctx, wt, "chore(workspace): save changes before hibernation")
            .await?;
    let snapshot = ctx.git(wt, &["rev-parse", "HEAD"]).await?;
    for name in &ignored {
        let path = Path::new(wt).join(name.trim_end_matches('/'));
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_dir() => fs::remove_dir_all(path)?,
            Ok(_) => fs::remove_file(path)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    if !ctx.git(wt, &["status", "--porcelain"]).await?.is_empty() {
        return Err(coded(
            "worktree remained dirty after snapshot",
            "HIBERNATE_SNAPSHOT_DIRTY",
        ));
    }
    ctx.progress("detach", Value::Null).await?;
    ctx.git(repo, &["worktree", "remove", wt]).await?;
    let _ = ctx.git(repo, &["worktree", "prune"]).await;
    if exists(wt) {
        return Err(coded(
            "worktree checkout still exists after detach",
            "HIBERNATE_PATH_REMAINS",
        ));
    }
    ctx.git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}^{{commit}}"),
        ],
    )
    .await?;
    Ok(
        json!({"ok":true,"detached":true,"committed":committed,"snapshot":snapshot,"removedUnknownIgnored":removed}),
    )
}

async fn rollback_create(ctx: &mut GitContext, repo: &str, wt: &str, branch: &str) -> Outcome {
    let mut errors = Vec::new();
    ctx.progress("remove", Value::Null).await?;
    if exists(wt) {
        if let Err(e) = ctx.git(repo, &["worktree", "remove", "--force", wt]).await {
            errors.push(error_text(&e).to_owned());
        }
    }
    if !branch.is_empty()
        && ctx
            .git(repo, &["rev-parse", "--verify", branch])
            .await
            .is_ok()
    {
        if let Err(e) = ctx.git(repo, &["branch", "-D", branch]).await {
            errors.push(error_text(&e).to_owned());
        }
    }
    let _ = ctx.git(repo, &["worktree", "prune"]).await;
    if exists(wt) {
        errors.push("worktree still exists".into());
    }
    if !branch.is_empty()
        && ctx
            .git(repo, &["rev-parse", "--verify", branch])
            .await
            .is_ok()
    {
        errors.push("branch still exists".into());
    }
    if !errors.is_empty() {
        return Err(coded(
            format!(
                "session creation rollback incomplete: {}",
                errors.join("; ")
            ),
            "SESSION_CREATE_ROLLBACK_FAILED",
        ));
    }
    Ok(json!({"ok":true,"removed":true}))
}

pub(super) async fn rebase_conflicts(ctx: &mut GitContext, wt: &str) -> Value {
    if exists(wt) {
        for marker in ["rebase-merge", "rebase-apply"] {
            let Ok(path) = ctx.git(wt, &["rev-parse", "--git-path", marker]).await else {
                break;
            };
            if Path::new(wt).join(path).exists() {
                return json!(lines(
                    &ctx.git(wt, &["diff", "--name-only", "--diff-filter=U"])
                        .await
                        .unwrap_or_default()
                ));
            }
        }
    }
    Value::Null
}

pub(super) async fn safety(
    ctx: &mut GitContext,
    repo: &str,
    wt: &str,
    branch: &str,
    base: &str,
) -> Value {
    let dirty = exists(wt)
        && !ctx
            .git(wt, &["status", "--porcelain"])
            .await
            .unwrap_or_default()
            .is_empty();
    let ahead = if branch.is_empty() {
        0
    } else {
        ctx.git(repo, &["rev-list", "--count", &format!("{base}..{branch}")])
            .await
            .unwrap_or_default()
            .parse::<u64>()
            .unwrap_or(0)
    };
    json!({"dirty":dirty,"ahead":ahead,"unmerged":ahead,"baseBranch":base})
}

fn safe_id(value: &str, default: &str) -> String {
    let value = if value.is_empty() { default } else { value };
    value
        .encode_utf16()
        .map(|c| match u8::try_from(c) {
            Ok(b) if b.is_ascii_alphanumeric() || b"._-".contains(&b) => char::from(b),
            _ => '-',
        })
        .collect()
}

pub(super) async fn backup(
    ctx: &mut GitContext,
    repo: &str,
    wt: &str,
    branch: &str,
    session: &str,
    id: &str,
) -> Outcome {
    // The public operation id can be supplied by a caller; it must name one directory.
    if id.is_empty() || !safe_relative(id) || id.contains(['/', '\\']) || id == "." {
        return Err(GitError::new("invalid backup operation id"));
    }
    let stamp = iso_time(SystemTime::now())
        .unwrap_or_default()
        .replace([':', '.'], "-");
    let refname = format!(
        "refs/multicc/backups/{}/{}-{}",
        safe_id(session, "session"),
        stamp,
        safe_id(id, "operation")
    );
    let source = if branch.is_empty() && !wt.is_empty() {
        "HEAD"
    } else {
        branch
    };
    if !source.is_empty() {
        ctx.git(repo, &["update-ref", &refname, source]).await?;
    }
    let common = ctx.git(repo, &["rev-parse", "--git-common-dir"]).await?;
    let directory = absolute(&Path::new(repo).join(common))
        .join("multicc-backups")
        .join(id);
    fs::create_dir_all(&directory)?;
    let mut bundle = None;
    let mut patch = None;
    if !source.is_empty() {
        let file = directory.join("repository.bundle");
        ctx.git(
            repo,
            &["bundle", "create", &file.to_string_lossy(), &refname],
        )
        .await?;
        bundle = Some(file);
    }
    if exists(wt) {
        let diff = ctx
            .git_opts(wt, &["diff", "--binary", "HEAD"], json!({"raw":true}))
            .await?;
        if !diff.is_empty() {
            let file = directory.join("dirty.patch");
            fs::write(&file, diff)?;
            patch = Some(file);
        }
        let list = ctx
            .git_opts(
                wt,
                &["ls-files", "--others", "--exclude-standard", "-z"],
                json!({"raw":true}),
            )
            .await?;
        if !list.is_empty() {
            let files: Vec<_> = list.split_terminator('\0').collect();
            fs::write(
                directory.join("untracked-files.txt"),
                format!("{}\n", files.join("\n")),
            )?;
            for file in files {
                if !safe_relative(file) {
                    return Err(GitError::new("invalid untracked backup path"));
                }
                carry::copy_entry(
                    &Path::new(wt).join(file),
                    &directory.join("untracked").join(file),
                )?;
            }
        }
    }
    Ok(json!({"ref":refname,"bundle":bundle,"patch":patch,"backupDir":directory}))
}

async fn resolves(ctx: &mut GitContext, repo: &str, reference: &str) -> bool {
    ctx.git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{reference}^{{commit}}"),
        ],
    )
    .await
    .is_ok_and(|v| !v.is_empty())
}

async fn remove(ctx: &mut GitContext, repo: &str, wt: &str, branch: &str, opts: &Value) -> Outcome {
    let base = match opts["baseBranch"].as_str().filter(|s| !s.is_empty()) {
        Some(s) => s.to_owned(),
        None => base_branch(ctx, repo).await,
    };
    let facts = safety(ctx, repo, wt, branch, &base).await;
    let mut reasons = Vec::new();
    if facts["dirty"] == true {
        reasons.push("dirty")
    }
    if facts["unmerged"].as_u64().unwrap_or(0) > 0 {
        reasons.push("unmerged")
    }
    let force = opts["force"] == true;
    if !reasons.is_empty() && !force {
        return Ok(
            json!({"ok":false,"blocked":true,"reasons":reasons,"safety":facts,"error":format!("worktree removal refused: {}",reasons.join(", "))}),
        );
    }
    let mut saved = Value::Null;
    if force && opts["skipBackup"] != true {
        ctx.progress("backup", Value::Null).await?;
        let source = if branch.is_empty() && exists(wt) {
            "HEAD"
        } else {
            branch
        };
        if !source.is_empty() && resolves(ctx, repo, source).await {
            let id = ctx.id.clone();
            saved = backup(ctx, repo, wt, branch, session_name(opts, wt, branch), &id).await?;
        }
    }
    ctx.progress("remove", Value::Null).await?;
    if exists(wt) {
        let mut argv = vec!["worktree", "remove"];
        if force {
            argv.extend(["--force", "--force"])
        }
        argv.push(wt);
        if let Err(err) = ctx.git(repo, &argv).await {
            let marker = format!("worktree {}", absolute(Path::new(wt)).display());
            if ctx
                .git(repo, &["worktree", "list", "--porcelain"])
                .await
                .unwrap_or_default()
                .lines()
                .any(|l| l == marker)
            {
                return Err(err);
            }
        }
    }
    if !branch.is_empty() && resolves(ctx, repo, &format!("refs/heads/{branch}")).await {
        if let Err(err) = ctx
            .git(repo, &["branch", if force { "-D" } else { "-d" }, branch])
            .await
        {
            if force {
                return Err(err);
            }
            return Ok(
                json!({"ok":false,"blocked":true,"reasons":["unmerged"],"backup":saved,"error":error_text(&err)}),
            );
        }
    }
    let _ = ctx.git(repo, &["worktree", "prune"]).await;
    Ok(json!({"ok":true,"removed":true,"backup":saved,"safety":facts}))
}

pub async fn dispatch(name: &str, args: &[Value], ctx: &mut GitContext) -> Outcome {
    let repo = string(arg(args, 0));
    let wt = string(arg(args, 1));
    let branch = string(arg(args, 2));
    let opts = arg(args, 3);
    match name {
        "gitWorktreeDetach" => detach(ctx, repo, wt, branch).await,
        "gitWorktreeRemove" => remove(ctx, repo, wt, branch, opts).await,
        "gitWorktreeRollbackCreate" => rollback_create(ctx, repo, wt, branch).await,
        "gitRebaseConflicts" => Ok(json!({"ok":true,"conflicts":rebase_conflicts(ctx,repo).await})),
        "gitRelocateWorktree" => {
            transfer::relocate(ctx, arg(args, 0), arg(args, 1), arg(args, 2), opts).await
        }
        "gitWorktreeSplitOff" => transfer::split(ctx, repo, arg(args, 1)).await,
        "gitCarryCollect" | "gitSplitFacts" => {
            carry::collect(ctx, wt, name == "gitSplitFacts").await
        }
        "gitCarryApply" => carry::apply(ctx, wt, arg(args, 2)).await,
        "gitCarryVerify" => {
            Ok(json!({"ok":true,"applied":carry::already_in(ctx,wt,arg(args,2)).await?}))
        }
        _ => Err(GitError::new(format!(
            "unknown Git safety operation {name}"
        ))),
    }
}
