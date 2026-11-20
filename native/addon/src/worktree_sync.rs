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

impl Task for PlannedWorktree {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        if self.session.is_empty()
            || self.session.len() > 160
            || !self
                .session
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
            || matches!(self.session.as_str(), "." | "..")
        {
            return Err(napi::Error::from_reason("workspace_identity_conflict"));
        }
        let repo = std::fs::canonicalize(&self.repo)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let path = repo
            .join(multicc_core::docs_memory_routes::WORKTREE_SUBDIR)
            .join(&self.session);
        let branch = format!("multicc/{}", self.session);
        let existing = path
            .try_exists()
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let (head, common_dir) =
            worktree_sync::materialize_planned(&repo, &path, &branch, &self.source)
                .map_err(napi::Error::from_reason)?;
        Ok(
            serde_json::json!({"ok":true,"worktreePath":path,"branch":branch,"existing":existing,
            "head":head,"commonDir":common_dir})
            .to_string(),
        )
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
