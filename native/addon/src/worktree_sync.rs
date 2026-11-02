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
