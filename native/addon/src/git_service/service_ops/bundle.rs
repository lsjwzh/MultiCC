use super::*;

fn unlink(path: &str) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        v => v,
    }
}

pub(super) async fn export(
    ctx: &mut GitContext,
    dir: &Value,
    session: &Value,
    tmp: &Value,
    max: Option<&Value>,
) -> Outcome {
    let repo = required(&dir["path"], "dir.path")?;
    let branch = required(&session["branch"], "session.branch")?;
    let tmp = required(tmp, "tmpPath")?;
    let max = max
        .and_then(|v| match v {
            Value::Null => Some(0.),
            Value::Bool(b) => Some(if *b { 1. } else { 0. }),
            Value::String(s) if s.trim().is_empty() => Some(0.),
            Value::String(s) => s.trim().parse().ok(),
            v => v.as_f64(),
        })
        .filter(|n| n.is_finite() && *n >= 0.);
    let base = base(ctx, dir).await;
    let unique = ctx
        .git(repo, &["rev-list", "--count", &format!("{base}..{branch}")])
        .await?
        .parse::<u64>()
        .unwrap_or_default();
    if unique == 0 {
        let _ = unlink(tmp);
        return Ok(
            json!({"ok":true,"bundlePath":null,"baseBranch":base,"branch":branch,"unique":0,"size":0,"note":"no unique commits"}),
        );
    }
    ctx.progress(
        "bundle-create",
        json!({"branch":branch,"baseBranch":base,"unique":unique}),
    )
    .await?;
    if let Some(parent) = Path::new(tmp).parent() {
        fs::create_dir_all(parent)?;
    }
    unlink(tmp)?;
    let result=async{
        ctx.git(repo,&["bundle","create",tmp,branch,&format!("^{base}")]).await?;
        let size=fs::metadata(tmp)?.len();
        if let Some(limit)=max.filter(|n| size as f64>*n){
            unlink(tmp)?;
            return Ok(json!({"ok":false,"tooLarge":true,"bundlePath":null,"baseBranch":base,"branch":branch,"unique":unique,"size":size,"maxBytes":limit,"note":"bundle exceeds size limit"}));
        }
        Ok(json!({"ok":true,"bundlePath":tmp,"baseBranch":base,"branch":branch,"unique":unique,"size":size,"note":null}))
    }.await;
    if result.is_err() {
        let _ = unlink(tmp);
    }
    result
}

pub(super) async fn import(
    ctx: &mut GitContext,
    dir: &Value,
    session: &Value,
    tmp: &Value,
    source: &Value,
) -> Outcome {
    let repo = required(&dir["path"], "dir.path")?;
    let wt = required(&session["worktreePath"], "session.worktreePath")?;
    let tmp = required(tmp, "tmpBundle")?;
    let source = required(source, "sourceBranch")?;
    let orig = ctx.git(wt, &["rev-parse", "HEAD"]).await?;
    if !ctx.git(wt, &["status", "--porcelain"]).await?.is_empty() {
        return Ok(
            json!({"ok":false,"blocked":true,"reasons":["dirty"],"restored":false,"error":"bundle import requires a clean target worktree"}),
        );
    }
    let safe_id = ctx
        .id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._/-".contains(c) {
                c
            } else {
                '-'
            }
        })
        .collect::<String>();
    let incoming = format!("refs/multicc/import/{safe_id}");
    let source = if source.starts_with("refs/") {
        source.to_owned()
    } else {
        format!("refs/heads/{source}")
    };
    let mut count = 0;
    let mut started = None;
    let result:Outcome=async{
        ctx.progress("bundle-fetch",json!({"sourceRef":source,"incomingRef":incoming})).await?;
        ctx.git(repo,&["fetch","--no-tags",tmp,&format!("+{source}:{incoming}")]).await?;
        let base=ctx.git(wt,&["merge-base","HEAD",&incoming]).await?;
        let range=format!("{base}..{incoming}");
        let commits=lines(&ctx.git(wt,&["rev-list","--reverse",&range]).await?);
        count=commits.len();
        if count==0 {return Ok(json!({"ok":true,"restored":false,"commits":0,"mergeBase":base,"originalHead":orig,"note":"bundle has no commits to import"}));}
        let merges=lines(&ctx.git(wt,&["rev-list","--min-parents=2",&range]).await?);
        let strategy=if merges.is_empty(){"cherry-pick"}else{"merge"};
        if merges.is_empty(){
            ctx.progress(strategy,json!({"commits":count})).await?;
            started=Some(strategy);
            let args=std::iter::once(strategy).chain(commits.iter().map(String::as_str)).collect::<Vec<_>>();
            ctx.git(wt,&args).await?;
        }else{
            ctx.progress(strategy,json!({"commits":count,"mergeCommits":merges.len()})).await?;
            started=Some(strategy);
            ctx.git(wt,&["merge","--no-ff","-m","chore(workspace): restore imported session history",&incoming]).await?;
        }
        started=None;
        let head=ctx.git(wt,&["rev-parse","HEAD"]).await?;
        Ok(json!({"ok":true,"restored":true,"commits":count,"strategy":strategy,"mergeBase":base,"originalHead":orig,"head":head}))
    }.await;
    let result = match result {
        Ok(v) => v,
        Err(e) => {
            let abort_error = if let Some(cmd) = started {
                ctx.git(wt, &[cmd, "--abort"])
                    .await
                    .err()
                    .map(|e| error_text(&e).to_owned())
            } else {
                None
            };
            let head = ctx
                .git(wt, &["rev-parse", "HEAD"])
                .await
                .unwrap_or_default();
            let status = ctx
                .git(wt, &["status", "--porcelain"])
                .await
                .unwrap_or_default();
            let message = error_text(&e);
            json!({"ok":false,"restored":false,"commits":count,"originalHead":orig,"head":head,"clean":status.is_empty(),"aborted":started.is_some()&&abort_error.as_deref().unwrap_or_default().is_empty(),"abortError":abort_error,"error":if message.is_empty(){"bundle import failed"}else{message}})
        }
    };
    let _ = ctx.git(repo, &["update-ref", "-d", &incoming]).await;
    Ok(result)
}
