use multicc_core::worktree_sync;
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;
use std::path::Path;

pub struct WorktreeSync {
    repo: String,
    worktree: String,
    branch: String,
    base: Option<String>,
}

impl Task for WorktreeSync {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        let result = worktree_sync::synchronize(
            Path::new(&self.repo),
            Path::new(&self.worktree),
            &self.branch,
            self.base.as_deref(),
        )
        .map_err(napi::Error::from_reason)?;
        serde_json::to_string(&result).map_err(|_| napi::Error::from_reason("wake_sync_failed"))
    }

    fn resolve(&mut self, _: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

#[napi]
pub fn sync_worktree_on_wake(
    repo: String,
    worktree: String,
    branch: String,
    base: Option<String>,
) -> AsyncTask<WorktreeSync> {
    AsyncTask::new(WorktreeSync {
        repo,
        worktree,
        branch,
        base,
    })
}

pub struct PlannedWorktree {
    repo: String,
    session: String,
    source: String,
}

pub(crate) fn planned_result(
    repo: &str,
    session: &str,
    source: &str,
) -> std::result::Result<serde_json::Value, String> {
    if session.is_empty()
        || session.len() > 160
        || !session
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
        || matches!(session, "." | "..")
    {
        return Err("workspace_identity_conflict".into());
    }
    let repo = std::fs::canonicalize(repo).map_err(|e| e.to_string())?;
    let path = repo
        .join(multicc_core::docs_memory_routes::WORKTREE_SUBDIR)
        .join(session);
    let branch = format!("multicc/{}", session);
    let existing = path.try_exists().map_err(|e| e.to_string())?;
    let (head, common_dir) = worktree_sync::materialize_planned(&repo, &path, &branch, source)?;
    Ok(
        serde_json::json!({"ok":true,"worktreePath":path,"branch":branch,"existing":existing,
            "head":head,"commonDir":common_dir}),
    )
}

impl Task for PlannedWorktree {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        planned_result(&self.repo, &self.session, &self.source)
            .map(|v| v.to_string())
            .map_err(napi::Error::from_reason)
    }

    fn resolve(&mut self, _: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

#[napi]
pub fn materialize_planned_worktree(
    repo: String,
    session: String,
    source: String,
) -> AsyncTask<PlannedWorktree> {
    AsyncTask::new(PlannedWorktree {
        repo,
        session,
        source,
    })
}

/// Unpack the restored worktree before scheduling Git on the existing worker.
#[napi]
pub fn wake_sync_request(
    env: Env,
    repo: napi::bindgen_prelude::Unknown<'_>,
    worktree: napi::bindgen_prelude::Unknown<'_>,
    base: napi::bindgen_prelude::Unknown<'_>,
) -> Result<AsyncTask<WorktreeSync>> {
    use crate::{js_iteration::read, js_live::LiveValue as L};
    use napi::bindgen_prelude::FromNapiValue;
    let row = L::new(&env, worktree);
    let path = read(row, c"worktreePath")?;
    let branch = read(row, c"branch")?;
    let base = L::new(&env, base);
    let string = |v: L<'_>| unsafe { String::from_napi_value(env.raw(), v.raw()) };
    Ok(sync_worktree_on_wake(
        string(L::new(&env, repo))?,
        string(path)?,
        string(branch)?,
        if base.truthy()? {
            Some(string(base)?)
        } else {
            None
        },
    ))
}

/// Public host form of the same worker. Its result is a record even when
/// reading a legacy row or parsing the worker reply fails.
#[napi]
pub fn wake_sync_result(
    env: Env,
    repo: napi::bindgen_prelude::Unknown<'_>,
    worktree: napi::bindgen_prelude::Unknown<'_>,
    base: napi::bindgen_prelude::Unknown<'_>,
) -> Result<napi::sys::napi_value> {
    use crate::{host_methods::method, route_response::*};
    use napi::bindgen_prelude::ToNapiValue;
    let anchor = L::new(&env, ().into_unknown(&env)?);
    let failure = fields(
        anchor,
        &[
            ("ok", flag(anchor, false)?),
            ("code", text(anchor, "wake_sync_failed")?),
        ],
    )?;
    let result = anchor.catch(|| {
        let json = anchor.global()?.get(c"JSON")?;
        let job = wake_sync_request(env, repo, worktree, base)?;
        let promise = L::from_raw(env.raw(), unsafe {
            AsyncTask::to_napi_value(env.raw(), job)
        }?);
        let parsed = call(promise, c"then", &[json.get(c"parse")?])?;
        call(
            parsed,
            c"catch",
            &[method(&env, failure, "", 0, 0, |failure, _| Ok(failure))?],
        )
    })?;
    Ok(result.unwrap_or(failure).raw())
}
