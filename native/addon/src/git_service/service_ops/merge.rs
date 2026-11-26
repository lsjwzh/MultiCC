use super::super::service_safety::{backup, rebase_conflicts, safety};
use super::*;
use std::{process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

pub(crate) async fn merge_state(ctx: &mut GitContext, dir: &Value, session: &Value) -> Outcome {
    let (repo, wt, branch) = (
        string(&dir["path"]),
        string(&session["worktreePath"]),
        string(&session["branch"]),
    );
    if dir.is_null() || session.is_null() {
        return Ok(json!({"mergeReady":false,"dirty":false,"ahead":0,"reason":"no-worktree"}));
    }
    if wt.is_empty() || branch.is_empty() {
        return Ok(
            json!({"mergeReady":false,"dirty":false,"ahead":0,"behind":0,"reason":"no-worktree"}),
        );
    }
    let base = base(ctx, dir).await;
    if !Path::new(wt).exists() {
        let reason = if session["workspaceState"] == "hibernated" {
            "hibernated"
        } else {
            "no-worktree"
        };
        return Ok(
            json!({"mergeReady":false,"dirty":false,"ahead":0,"behind":0,"reason":reason,"worktreeMissing":true,"baseBranch":base,"branch":branch}),
        );
    }
    let conflicts = rebase_conflicts(ctx, wt).await;
    if !conflicts.is_null() {
        return Ok(
            json!({"mergeReady":false,"dirty":true,"ahead":0,"behind":0,"baseBranch":base,"branch":branch,"baseCheckedOut":true,"conflict":true,"conflictFiles":conflicts}),
        );
    }
    let safety = safety(ctx, repo, wt, branch, &base).await;
    let behind = ctx
        .git(
            repo,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("{base}...{branch}"),
            ],
        )
        .await
        .ok()
        .and_then(|s| s.split_whitespace().next()?.parse::<usize>().ok())
        .unwrap_or_default();
    let checked = base_branch(ctx, repo).await == base;
    let ahead = safety["ahead"].as_u64().unwrap_or_default();
    let dirty = safety["dirty"] == true;
    let content = ahead > 0
        && ctx
            .git(repo, &["diff", "--quiet", &format!("{base}...{branch}")])
            .await
            .is_err();
    Ok(
        json!({"mergeReady":(dirty||content)&&checked,"dirty":dirty,"ahead":ahead,"behind":behind,"baseBranch":base,"branch":branch,"baseCheckedOut":checked,"conflict":false}),
    )
}

// Only Node itself can apply its module/extension-specific parser to the
// candidate files. Keep the invocation on the worker with the existing limits.
async fn check_file(node: &str, file: &Path) -> Option<String> {
    let mut child = tokio::process::Command::new(node)
        .arg("--check")
        .arg(file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .ok();
    let Some(ref mut proc) = child else {
        return Some("parse failed".to_owned());
    };
    let mut stderr = proc.stderr.take()?;
    let mut bytes = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(120), async {
        (&mut stderr)
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > 1024 * 1024 {
            proc.kill().await?;
        }
        proc.wait().await
    })
    .await;
    if matches!(result,Ok(Ok(s)) if s.success()) {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes);
    let message = text
        .lines()
        .map(str::trim)
        .find(|s| s.contains("SyntaxError") || s.contains("Error:"))
        .unwrap_or("parse failed");
    Some(message.to_owned())
}
pub(super) async fn syntax(ctx: &mut GitContext, wt: &str, from: &str, to: &str) -> Vec<Value> {
    let changed = ctx
        .git(wt, &["diff", "--name-only", "--diff-filter=ACMR", from, to])
        .await
        .unwrap_or_default();
    let mut errors = Vec::new();
    for file in lines(&changed) {
        if !matches!(
            Path::new(&file).extension().and_then(|x| x.to_str()),
            Some("js" | "cjs" | "mjs")
        ) || file.contains("node_modules/")
            || file.contains(&format!("{SUBDIR}/"))
        {
            continue;
        }
        let path = Path::new(wt).join(&file);
        if path.exists() {
            if let Some(error) = check_file(&ctx.node_exec_path, &path).await {
                errors.push(json!({"file":file,"error":error}));
            }
        }
    }
    errors
}

async fn published(ctx: &mut GitContext, id: &str, result: &mut Value) {
    let evidence = ctx.evidence("published", json!(id)).await.unwrap_or_else(
        |_| json!({"operationId":id,"state":"unverified","reason":"publication_evidence_pending"}),
    );
    if !evidence.is_null() && evidence != false {
        result["deliveryEvidence"] = evidence;
    }
}

pub(super) async fn merge_back(ctx: &mut GitContext, dir: &Value, session: &Value) -> Outcome {
    let (repo, wt, branch) = (
        string(&dir["path"]),
        string(&session["worktreePath"]),
        string(&session["branch"]),
    );
    if dir.is_null() || wt.is_empty() || branch.is_empty() || !Path::new(wt).exists() {
        return Ok(json!({"ok":false,"code":"worktree_missing","error":"session has no worktree"}));
    }
    let base = base(ctx, dir).await;
    if base_branch(ctx, repo).await != base {
        return Ok(
            json!({"ok":false,"blocked":true,"reasons":["base-not-checked-out"],"error":format!("base branch '{base}' is not checked out")}),
        );
    }
    let status = ctx
        .git_opts(repo, &["status", "--porcelain"], json!({"raw":true}))
        .await?;
    if !status.trim().is_empty() {
        let dirty: Vec<_> = status
            .lines()
            .filter_map(|s| s.get(3..))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        return Ok(
            json!({"ok":false,"blocked":true,"reasons":["base-dirty"],"dirtyFiles":dirty,"error":"base worktree is dirty"}),
        );
    }
    ctx.progress("commit-session", Value::Null).await?;
    let status = ctx
        .git_opts(wt, &["status", "--porcelain"], json!({"raw":true}))
        .await?;
    let message = multicc_core::publication::quick_commit_message(&status);
    let committed = commit_all(ctx, wt, &message).await?;
    let ahead = ctx
        .git(repo, &["rev-list", "--count", &format!("{base}..{branch}")])
        .await?
        .parse::<u64>()
        .unwrap_or_default();
    let base_head = ctx.git(repo, &["rev-parse", &base]).await?;
    let source_head = ctx.git(wt, &["rev-parse", "HEAD"]).await?;
    let id = ctx.id.clone();
    let payload = |head: &str| json!({"operationId":id,"dirPath":repo,"worktreePath":wt,"branch":branch,"baseRef":base,"baseHead":base_head,"sourceHead":source_head,"integrationHead":head});
    if ahead == 0 {
        ctx.evidence("prepared", payload(&base_head)).await?;
        let mut result =
            json!({"ok":true,"merged":false,"committed":committed,"message":"没有新提交需要合并"});
        published(ctx, &id, &mut result).await;
        return Ok(result);
    }
    let temp_ref = format!("refs/multicc/integration/{id}");
    let integration = std::env::temp_dir().join(format!("multicc-integration-{id}"));
    let path = integration.to_string_lossy();
    let mut added = false;
    let result:Outcome=async{
        ctx.progress("integration-prepare",Value::Null).await?;
        ctx.git(repo,&["update-ref",&temp_ref,&base_head]).await?;
        ctx.git(repo,&["worktree","add","--detach",&path,&temp_ref]).await?;
        added=true;
        ctx.progress("integration-merge",Value::Null).await?;
        let subject=ctx.git(wt,&["log","-1","--format=%s"]).await?;
        ctx.git(&path,&["merge","--no-ff","-m",&format!("chore(merge): {subject}"),&source_head]).await?;
        let head=ctx.git(&path,&["rev-parse","HEAD"]).await?;
        ctx.progress("validate",Value::Null).await?;
        let errors=syntax(ctx,&path,&base_head,&head).await;
        if !errors.is_empty(){
            return Ok(json!({"ok":false,"syntaxErrors":errors,"integrationRef":temp_ref,"error":format!("合并被拒绝：{} 个文件语法错误；用户主工作区未改动",errors.len())}));
        }
        ctx.progress("publish",Value::Null).await?;
        ctx.evidence("prepared",payload(&head)).await?;
        ctx.git(repo,&["merge","--ff-only",&head]).await?;
        let mut result=json!({"ok":true,"merged":true,"committed":committed,"commits":ahead,"integrationRef":temp_ref});
        published(ctx,&id,&mut result).await;
        result["syncedBack"]=json!(ctx.git(wt,&["merge","--ff-only",&base]).await.is_ok());
        Ok(result)
    }.await;
    let result = match result {
        Ok(v) => v,
        Err(e) => {
            let mut conflicts = Vec::new();
            let mut diff = String::new();
            if added {
                conflicts = lines(
                    &ctx.git(&path, &["diff", "--name-only", "--diff-filter=U"])
                        .await
                        .unwrap_or_default(),
                );
                if !conflicts.is_empty() {
                    diff = ctx
                        .git_opts(
                            &path,
                            &["diff", "--no-color", "--diff-filter=U"],
                            json!({"maxBuffer":1024*1024}),
                        )
                        .await
                        .unwrap_or_default();
                }
            }
            let message = if !conflicts.is_empty() {
                "合并冲突仅发生在 integration worktree；用户主工作区未改动"
            } else if error_text(&e).is_empty() {
                "merge failed"
            } else {
                error_text(&e)
            };
            json!({"ok":false,"conflicts":conflicts,"conflictDiff":diff,"error":message})
        }
    };
    if added
        && ctx
            .git(repo, &["worktree", "remove", "--force", &path])
            .await
            .is_err()
    {
        match fs::remove_dir_all(&integration) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    }
    let _ = ctx.git(repo, &["update-ref", "-d", &temp_ref]).await;
    Ok(result)
}

async fn unmerged(ctx: &mut GitContext, wt: &str) -> Vec<String> {
    lines(
        &ctx.git(wt, &["diff", "--name-only", "--diff-filter=U"])
            .await
            .unwrap_or_default(),
    )
}
pub(super) async fn sync(
    ctx: &mut GitContext,
    dir: &Value,
    session: &Value,
    opts: &Value,
) -> Outcome {
    let (repo, wt, branch) = (
        string(&dir["path"]),
        string(&session["worktreePath"]),
        string(&session["branch"]),
    );
    if dir.is_null() || wt.is_empty() || branch.is_empty() {
        return Ok(json!({"ok":false,"error":"session has no worktree"}));
    }
    if !Path::new(wt).exists() {
        return Ok(json!({"ok":false,"code":"worktree_missing","error":"session has no worktree"}));
    }
    let base = base(ctx, dir).await;
    let conflicts = rebase_conflicts(ctx, wt).await;
    if !conflicts.is_null() {
        return Ok(
            json!({"ok":false,"conflicts":conflicts,"rebaseInProgress":true,"error":"worktree 仍处于 rebase 冲突中"}),
        );
    }
    let safety = safety(ctx, repo, wt, branch, &base).await;
    let mut reasons = Vec::new();
    if safety["dirty"] == true {
        reasons.push("dirty");
    }
    if safety["unmerged"].as_u64().unwrap_or_default() > 0 {
        reasons.push("unmerged");
    }
    if !reasons.is_empty() && !enabled(opts, "force") {
        return Ok(
            json!({"ok":false,"skipped":true,"blocked":true,"reasons":reasons,"safety":safety,"error":format!("sync/rebase refused: {}",reasons.join(", "))}),
        );
    }
    let mut backup_result = Value::Null;
    let mut committed = false;
    if !reasons.is_empty() {
        let id = ctx.id.clone();
        backup_result = backup(ctx, repo, wt, branch, string(&session["id"]), &id).await?;
        if safety["dirty"] == true {
            committed =
                commit_all(ctx, wt, "chore(workspace): save changes before forced sync").await?;
        }
    }
    let behind = ctx
        .git(repo, &["rev-list", "--count", &format!("{branch}..{base}")])
        .await?
        .parse::<u64>()
        .unwrap_or_default();
    if behind == 0 {
        return Ok(
            json!({"ok":true,"merged":false,"committed":committed,"backup":backup_result,"message":"已是最新，无需同步"}),
        );
    }
    ctx.progress("rebase", Value::Null).await?;
    match ctx.git(wt, &["rebase", &base]).await {
        Ok(_) => Ok(
            json!({"ok":true,"merged":true,"committed":committed,"commits":behind,"baseBranch":base,"backup":backup_result}),
        ),
        Err(e) => {
            let conflicts = unmerged(ctx, wt).await;
            let parked = !conflicts.is_empty() && !enabled(opts, "abortOnConflict");
            if !parked {
                let _ = ctx.git(wt, &["rebase", "--abort"]).await;
            }
            let message = if parked {
                format!("与 {base} 存在冲突，rebase 已暂停")
            } else if !conflicts.is_empty() {
                format!("与 {base} 存在冲突，已 abort")
            } else {
                error_text(&e).to_owned()
            };
            Ok(
                json!({"ok":false,"conflicts":conflicts,"rebaseInProgress":parked,"committed":committed,"backup":backup_result,"error":message}),
            )
        }
    }
}
pub(super) async fn resolve(
    ctx: &mut GitContext,
    dir: &Value,
    session: &Value,
    action: &str,
) -> Outcome {
    let wt = string(&session["worktreePath"]);
    if dir.is_null() || wt.is_empty() {
        return Ok(json!({"ok":false,"error":"session has no worktree"}));
    }
    if !Path::new(wt).exists() {
        return Ok(json!({"ok":false,"code":"worktree_missing","error":"session has no worktree"}));
    }
    if rebase_conflicts(ctx, wt).await.is_null() {
        return Ok(json!({"ok":false,"error":"当前没有进行中的 rebase"}));
    }
    if action == "abort" {
        ctx.git(wt, &["rebase", "--abort"]).await?;
        return Ok(json!({"ok":true,"aborted":true}));
    }
    ctx.git(wt, &["add", "-A"]).await?;
    let conflicts = unmerged(ctx, wt).await;
    if !conflicts.is_empty() {
        return Ok(
            json!({"ok":false,"conflicts":conflicts,"rebaseInProgress":true,"error":"仍有冲突文件"}),
        );
    }
    if let Err(e) = ctx
        .git_opts(
            wt,
            &["rebase", "--continue"],
            json!({"env":{"GIT_EDITOR":"true"}}),
        )
        .await
    {
        return Ok(
            json!({"ok":false,"conflicts":unmerged(ctx,wt).await,"rebaseInProgress":true,"error":error_text(&e)}),
        );
    }
    Ok(json!({"ok":true,"continued":true,"done":rebase_conflicts(ctx,wt).await.is_null()}))
}
