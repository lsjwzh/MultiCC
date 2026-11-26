//! Execute Git workflows off the event loop. The repository actor owns queueing,
//! leases and command execution. Its live callbacks stay on their originating V8 thread.
use napi::{bindgen_prelude::Promise, threadsafe_function::ThreadsafeFunction};
use serde_json::{json, Value};
mod bridge;
mod service_ops;
mod service_safety;

pub(super) struct GitContext {
    pub id: String,
    pub node_exec_path: String,
    host: ThreadsafeFunction<String, Promise<String>, String, napi::Status, false>,
}

#[derive(Debug)]
pub(super) struct GitError {
    pub message: String,
    pub stderr: String,
    pub details: Value,
}
impl GitError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            stderr: String::new(),
            details: json!({}),
        }
    }
    fn coded(code: &str, message: &str) -> Self {
        Self::new(message).with("code", json!(code))
    }
    fn with(mut self, key: &str, value: Value) -> Self {
        self.details[key] = value;
        self
    }
    fn packet(&self) -> Value {
        let mut packet = self.details.clone();
        packet["message"] = json!(self.message);
        if !self.stderr.is_empty() {
            packet["stderr"] = json!(self.stderr);
        }
        packet
    }
}
impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}
impl From<std::io::Error> for GitError {
    fn from(e: std::io::Error) -> Self {
        Self::new(e.to_string()).with(
            "code",
            match e.kind() {
                std::io::ErrorKind::NotFound => json!("ENOENT"),
                std::io::ErrorKind::PermissionDenied => json!("EACCES"),
                std::io::ErrorKind::AlreadyExists => json!("EEXIST"),
                _ => Value::Null,
            },
        )
    }
}
impl From<napi::Error> for GitError {
    fn from(e: napi::Error) -> Self {
        Self::new(e.reason)
    }
}
impl GitContext {
    async fn request(&self, request: Value) -> Result<Value, GitError> {
        let response = self
            .host
            .call_async_catch(request.to_string())
            .await?
            .await?;
        let response: Value =
            serde_json::from_str(&response).map_err(|e| GitError::new(e.to_string()))?;
        if let Some(error) = response.get("error") {
            return Err(GitError {
                message: error["message"]
                    .as_str()
                    .unwrap_or("git operation failed")
                    .into(),
                stderr: error["stderr"].as_str().unwrap_or("").into(),
                details: error.clone(),
            });
        }
        Ok(response["value"].clone())
    }
    async fn git(&self, cwd: &str, args: &[&str]) -> Result<String, GitError> {
        self.git_opts(cwd, args, json!({})).await
    }
    async fn git_opts(&self, cwd: &str, args: &[&str], opts: Value) -> Result<String, GitError> {
        let value = self.request(json!(["git", cwd, args, opts])).await?;
        Ok(value.as_str().unwrap_or("").into())
    }
    async fn progress(&self, phase: &str, detail: Value) -> Result<(), GitError> {
        self.request(json!(["progress", phase, detail]))
            .await
            .map(|_| ())
    }
    async fn evidence(&self, phase: &str, payload: Value) -> Result<Value, GitError> {
        self.request(json!(["evidence", phase, payload])).await
    }
    async fn before_remove(&self, created: &Value) -> Result<(), GitError> {
        self.request(json!(["beforeRemove", created]))
            .await
            .map(|_| ())
    }
    async fn operation(&self, name: &str, args: Vec<Value>) -> Result<Value, GitError> {
        self.request(json!(["operation", name, args])).await
    }
}
fn lines(raw: &str) -> Vec<String> {
    raw.lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
async fn base_branch(ctx: &GitContext, dir: &str) -> String {
    if let Ok(s) = ctx.git(dir, &["symbolic-ref", "--short", "HEAD"]).await {
        if !s.is_empty() {
            return s;
        }
    }
    ctx.git(dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .ok()
        .filter(|s| !s.is_empty() && s != "HEAD")
        .unwrap_or_else(|| "main".into())
}
async fn dispatch(name: &str, args: &[Value], ctx: &mut GitContext) -> Result<Value, GitError> {
    let dir = args.first().and_then(Value::as_str).unwrap_or("");
    match name {
        "gitBaseBranch" => Ok(json!({"ok":true,"branch":base_branch(ctx,dir).await})),
        "gitWorktreeSnapshot" => {
            let branch = match args
                .get(1)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                Some(branch) => branch.to_owned(),
                None => base_branch(ctx, dir).await,
            };
            let head = ctx.git(dir, &["rev-parse", "HEAD"]).await?;
            let raw = ctx.git(dir, &["status", "--short"]).await?;
            let changes: Vec<_> = raw
                .lines()
                .map(str::trim_end)
                .filter(|s| !s.is_empty())
                .take(100)
                .collect();
            Ok(json!({"ok":true,"branch":branch,"head":head,"changes":changes}))
        }
        "gitWorktreeDetach"
        | "gitWorktreeRollbackCreate"
        | "gitWorktreeRemove"
        | "gitRelocateWorktree"
        | "gitWorktreeSplitOff"
        | "gitRebaseConflicts"
        | "gitCarryCollect"
        | "gitCarryApply"
        | "gitSplitFacts"
        | "gitCarryVerify" => service_safety::dispatch(name, args, ctx).await,
        _ => service_ops::dispatch(name, args, ctx).await,
    }
}
