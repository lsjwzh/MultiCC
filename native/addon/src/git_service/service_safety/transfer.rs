use super::*;

fn options(value: &Value) -> Value {
    if value.is_object() {
        value.clone()
    } else {
        json!({})
    }
}

fn first_value<'a>(values: &[&'a Value]) -> Option<&'a Value> {
    values.iter().copied().find(|v| !v.is_null())
}

fn refused(value: Value, default: &str) -> GitError {
    GitError::new(value["error"].as_str().unwrap_or(default)).with("result", value)
}

fn summary(carried: &Value, applied: &Value) -> Value {
    if !carry::has_content(carried) {
        return Value::Null;
    }
    let paths: Vec<_> = carried["untracked"]
        .as_array()
        .into_iter()
        .flatten()
        .take(20)
        .collect();
    json!({"patchBytes":applied["patchBytes"].as_u64().unwrap_or(0),"files":applied["appliedFiles"].as_array().map_or(0,Vec::len),"paths":paths})
}

fn rollback_branch(created: &Value) -> Value {
    if created["branchExisted"] == false {
        created["branch"].clone()
    } else {
        Value::Null
    }
}

async fn relocate_rollback(
    ctx: &mut GitContext,
    dir: &Value,
    session: &Value,
    created: &Value,
) -> Value {
    let sid = format!("{}-relocate-rollback", string(&session["id"]));
    let mut opts = json!({"sessionId":sid,"baseBranch":dir["baseBranch"],"activeCheck":null,"onProgress":null});
    let mut result = Value::Null;
    for force in [false, true] {
        if force {
            opts["force"] = json!(true);
        }
        result = ctx
            .operation(
                "gitWorktreeRemove",
                vec![
                    dir["path"].clone(),
                    created["worktreePath"].clone(),
                    rollback_branch(created),
                    opts.clone(),
                ],
            )
            .await
            .unwrap_or_else(|err| json!({"ok":false,"error":error_text(&err)}));
        if result["ok"] == true {
            break;
        }
    }
    result
}

pub(super) async fn relocate(
    ctx: &mut GitContext,
    old: &Value,
    target: &Value,
    session: &Value,
    opts: &Value,
) -> Outcome {
    if old.is_null() || target.is_null() || session.is_null() {
        return Ok(json!({"ok":false,"error":"oldDir, targetDir and session are required"}));
    }
    let carry = opts["carry"] == true;
    let state = ctx
        .operation("gitWorktreeMergeState", vec![old.clone(), session.clone()])
        .await?;
    let mut reasons = Vec::new();
    if opts["active"] == true {
        reasons.push("active")
    }
    if state["dirty"] == true && !carry {
        reasons.push("dirty")
    }
    if state["ahead"].as_u64().unwrap_or(0) > 0 {
        reasons.push("unmerged")
    }
    if !reasons.is_empty() && opts["force"] != true {
        return Ok(
            json!({"ok":false,"blocked":true,"reasons":reasons,"mergeState":state,"error":format!("relocate refused: {}",reasons.join(", "))}),
        );
    }
    let mut carried = Value::Null;
    if carry && state["dirty"] == true && exists(string(&session["worktreePath"])) {
        let facts = ctx
            .operation(
                "gitCarryCollect",
                vec![old["path"].clone(), session["worktreePath"].clone()],
            )
            .await?;
        carried = facts["carried"].clone();
    }

    let mut created = Value::Null;
    let mut create_options = options(opts);
    create_options["__trackCreatedResources"] = json!(true);
    let transaction: Outcome = async {
        created = ctx
            .operation(
                "gitWorktreeAdd",
                vec![
                    target["path"].clone(),
                    session["id"].clone(),
                    target["baseBranch"].clone(),
                    create_options,
                ],
            )
            .await?;
        let mut applied = Value::Null;
        if carry::has_content(&carried) {
            applied = ctx
                .operation(
                    "gitCarryApply",
                    vec![
                        target["path"].clone(),
                        created["worktreePath"].clone(),
                        carried.clone(),
                    ],
                )
                .await?;
        }
        let mut public_created = created.clone();
        if let Some(record) = public_created.as_object_mut() {
            record.remove("branchExisted");
        }
        ctx.before_remove(&public_created).await?;
        let mut remove_opts = options(opts);
        remove_opts["sessionId"] = session["id"].clone();
        remove_opts["baseBranch"] = old["baseBranch"].clone();
        if carry {
            remove_opts["force"] = json!(true);
            remove_opts["skipBackup"] = json!(state["ahead"] == 0);
        }
        let removed = ctx
            .operation(
                "gitWorktreeRemove",
                vec![
                    old["path"].clone(),
                    session["worktreePath"].clone(),
                    session["branch"].clone(),
                    remove_opts,
                ],
            )
            .await?;
        if removed["ok"] != true {
            return Err(refused(removed, "source removal refused"));
        }
        let depth = created["queueDepth"]
            .as_u64()
            .unwrap_or(0)
            .max(removed["queueDepth"].as_u64().unwrap_or(0));
        Ok(json!({
            "ok": true, "worktreePath": created["worktreePath"], "branch": created["branch"],
            "carried": summary(&carried, &applied), "createdOperationId": created["operationId"],
            "operationId": removed["operationId"], "queueDepth": depth, "backup": removed["backup"],
        }))
    }
    .await;
    let err = match transaction {
        Ok(v) => return Ok(v),
        Err(err) => err,
    };
    // Recovery may delete only a checkout created by this attempt.
    let rollback = if created["existing"] != false {
        Value::Null
    } else {
        relocate_rollback(ctx, target, session, &created).await
    };
    let result = &err.details["result"];
    let mut out = options(result);
    let reason = match err.details["code"].as_str() {
        Some("SESSION_ACTIVE") => Some("active"),
        Some("SESSION_LEASED") => Some("leased"),
        _ => None,
    };
    out["ok"] = json!(false);
    out["blocked"] = json!(result["blocked"] == true || reason.is_some());
    for key in ["code", "operationId", "queueDepth"] {
        if let Some(v) = first_value(&[&result[key], &err.details[key]]) {
            out[key] = v.clone();
        }
    }
    if result["reasons"].is_null() {
        if let Some(reason) = reason {
            out["reasons"] = json!([reason]);
        }
    }
    out["rolledBack"] = json!(!created.is_null() && rollback["ok"] == true);
    if !rollback.is_null() && rollback["ok"] != true {
        out["rollbackError"] = json!(rollback["error"]
            .as_str()
            .unwrap_or("target rollback failed"));
    }
    out["error"] = json!(result["error"].as_str().unwrap_or_else(|| error_text(&err)));
    Ok(out)
}

pub(super) async fn split(ctx: &mut GitContext, repo: &str, input: &Value) -> Outcome {
    let sid = string(&input["sessionId"]);
    let source = &input["source"];
    let target = &input["target"];
    let source_path = string(&source["worktreePath"]);
    let target_id = string(&target["sessionId"]);
    if repo.is_empty()
        || sid.is_empty()
        || source_path.is_empty()
        || string(&source["branch"]).is_empty()
        || target_id.is_empty()
    {
        return Ok(
            json!({"ok":false,"code":"split_identity_missing","error":"dirPath, sessionId, source worktree and target session are required"}),
        );
    }
    if !exists(source_path) {
        let default_path = Path::new(repo).join(".multicc-worktrees").join(target_id);
        let path = target["worktreePath"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map_or(default_path, PathBuf::from);
        let branch = target["branch"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("multicc/{target_id}"));
        return Ok(if path.exists() {
            json!({"ok":true,"already":true,"worktreePath":path,"branch":branch,"carried":null,"sourceRemoved":true,"sourceRetained":null})
        } else {
            json!({"ok":false,"code":"split_source_missing","error":"neither the source nor the target checkout exists"})
        });
    }
    let facts = match ctx
        .operation("gitSplitFacts", vec![json!(repo), json!(source_path)])
        .await
    {
        Ok(v) => v,
        Err(err) => {
            return Ok(
                json!({"ok":false,"code":"split_observation_failed","error":error_text(&err)}),
            )
        }
    };
    let head = &facts["head"];
    let carried = &facts["carried"];
    let mut created = Value::Null;
    let transaction: Outcome = async {
        let base = input["baseCommit"].as_str().filter(|s| !s.is_empty()).unwrap_or_else(|| string(head));
        created = ctx.operation("gitWorktreeAdd", vec![
            json!(repo), json!(target_id), json!(base),
            json!({"sessionId": target_id,"activeCheck":null,"onProgress":null,"__trackCreatedResources":true}),
        ]).await?;
        let mut applied = Value::Null;
        if carry::has_content(carried) {
            let args = vec![json!(repo), created["worktreePath"].clone(), carried.clone()];
            let already = created["existing"] == true
                && ctx.operation("gitCarryVerify", args.clone()).await.is_ok_and(|v| v["applied"] == true);
            if !already { applied = ctx.operation("gitCarryApply", args).await?; }
        }
        let unknown = facts["unknownIgnored"].as_array().map_or(0, Vec::len);
        let retained = if unknown > 0 {
            json!({"reason":"ignored_files","count":unknown})
        } else {
            let removed = ctx.operation("gitWorktreeRemove", vec![
                json!(repo), json!(source_path), Value::Null,
                json!({"sessionId":sid,"force":true,"skipBackup":true,"activeCheck":null,"onProgress":null}),
            ]).await?;
            if removed["ok"] != true { return Err(refused(removed,"source checkout removal refused")); }
            Value::Null
        };
        Ok(json!({
            "ok": true, "already": false, "worktreePath": created["worktreePath"], "branch": created["branch"],
            "baseCommit": head, "sourceRemoved": retained.is_null(), "sourceRetained": retained,
            "carried": summary(carried, &applied), "operationId": created["operationId"], "queueDepth": created["queueDepth"],
        }))
    }.await;
    let err = match transaction {
        Ok(v) => return Ok(v),
        Err(err) => err,
    };
    let gone = !exists(source_path);
    let rollback = if !gone
        && created["existing"] == false
        && exists(string(&created["worktreePath"]))
    {
        ctx.operation("gitWorktreeRollbackCreate",vec![json!(repo),created["worktreePath"].clone(),rollback_branch(&created),
            json!({"sessionId":format!("{sid}-split-rollback"),"activeCheck":null,"onProgress":null})]).await.unwrap_or_else(|e|json!({"ok":false,"error":error_text(&e)}))
    } else {
        Value::Null
    };
    let result = &err.details["result"];
    let code = result["code"]
        .as_str()
        .or_else(|| err.details["code"].as_str())
        .unwrap_or("split_off_failed");
    let mut out = json!({"ok":false,"code":code,"sourceRemoved":gone,"rolledBack":!gone && rollback["ok"]==true,
        "error":result["error"].as_str().unwrap_or_else(||error_text(&err))});
    if !result["reasons"].is_null() {
        out["reasons"] = result["reasons"].clone();
    }
    if !rollback.is_null() && rollback["ok"] != true {
        out["rollbackError"] = rollback["error"].clone();
    }
    Ok(out)
}
