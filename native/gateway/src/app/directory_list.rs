//! The standalone directory card reads both StateStore tables and local Git refs.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};

use multicc_core::{
    directory_routes::annotate_dir,
    durable_state,
    js::{self, JsValue},
};
use serde_json::{json, Value};
use tokio::sync::Mutex;

#[derive(Default)]
pub(super) struct PushStates {
    pub(super) operations: super::repo_operations::Operations,
    entries: Mutex<HashMap<(PathBuf, String), (Instant, Value)>>,
}

impl PushStates {
    async fn get(&self, path: &Path, branch: &str) -> Value {
        // Serialize Git probes across parallel directory-card polls. No network
        // fetch is needed: the ahead/behind numbers use the local remote refs.
        let _queued = self.operations.depth.enter();
        let mut entries = self.entries.lock().await;
        let key = (path.to_owned(), branch.to_owned());
        entries.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(10));
        if let Some((_, state)) = entries.get(&key) {
            return state.clone();
        }
        let operation = self.operations.start(path);
        let state = push_state(path, branch).await;
        if let Some(operation) = operation {
            operation.finish();
        }
        entries.insert(key, (Instant::now(), state.clone()));
        state
    }
}

pub(crate) async fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    let child = tokio::process::Command::new("git")
        .current_dir(cwd)
        .args(["--no-optional-locks", "-c", "core.fsmonitor=false"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    let out = tokio::time::timeout(Duration::from_secs(120), child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

async fn count(path: &Path, range: &str) -> u64 {
    git(path, &["rev-list", "--count", range, "--"])
        .await
        .and_then(|n| n.parse().ok())
        .unwrap_or_default()
}

async fn push_state(path: &Path, requested: &str) -> Value {
    if git(path, &["rev-parse", "--is-inside-work-tree"])
        .await
        .as_deref()
        != Some("true")
    {
        return json!({"available":false,"hasRemote":false,"ahead":0,"behind":0,"dirty":0,"reason":"not-a-git-repository"});
    }
    let dirty = git(path, &["status", "--porcelain"])
        .await
        .unwrap_or_default()
        .lines()
        .count();
    let branch = if requested.is_empty() {
        git(path, &["symbolic-ref", "--short", "HEAD"])
            .await
            .unwrap_or_else(|| "main".into())
    } else {
        requested.to_owned()
    };
    let local_ref = format!("refs/heads/{branch}");
    if git(path, &["show-ref", "--verify", "--quiet", &local_ref])
        .await
        .is_none()
    {
        return json!({"available":false,"hasRemote":false,"ahead":0,"behind":0,"dirty":dirty,"reason":"no-branch"});
    }
    let remotes = git(path, &["remote"]).await.unwrap_or_default();
    let Some(first) = remotes.lines().next() else {
        return json!({"available":true,"hasRemote":false,"branch":branch,"ahead":0,"behind":0,"dirty":dirty,"reason":"no-remote"});
    };
    let upstream = git(
        path,
        &["for-each-ref", "--format=%(upstream:short)", &local_ref],
    )
    .await
    .unwrap_or_default();
    let (remote, remote_branch) = upstream.split_once('/').unwrap_or_else(|| {
        (
            if remotes.lines().any(|r| r == "origin") {
                "origin"
            } else {
                first
            },
            branch.as_str(),
        )
    });
    let remote_ref = format!("{remote}/{remote_branch}");
    let exists = git(
        path,
        &["rev-parse", "--verify", "--end-of-options", &remote_ref],
    )
    .await
    .is_some();
    let (ahead, behind) = if exists {
        (
            count(path, &format!("{remote_ref}..{local_ref}")).await,
            count(path, &format!("{local_ref}..{remote_ref}")).await,
        )
    } else {
        (count(path, &local_ref).await, 0)
    };
    json!({"available":true,"hasRemote":true,"branch":branch,"remote":remote,"remoteBranch":remote_branch,
        "upstream":(!upstream.is_empty()).then_some(&upstream),"upstreamConfigured":!upstream.is_empty(),
        "remoteBranchExists":exists,"ahead":ahead,"behind":behind,"dirty":dirty})
}

pub(crate) fn records(path: &Path) -> Result<Vec<Value>, String> {
    let rows = match durable_state::load_or_recover(path)? {
        Some(JsValue::Array(rows)) => rows,
        None => return Ok(vec![]),
        _ => return Err("invalid record table".into()),
    };
    // Restore the same insertion-ordered Map as the host, including replacement
    // of duplicate IDs present in older state files.
    let mut indexed = HashMap::new();
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let id = js::js_to_string(row.get("id").unwrap_or(&JsValue::Undefined));
        let pos = *indexed.entry(id).or_insert(out.len());
        let value = js::to_serde(&row);
        if pos == out.len() {
            out.push(value);
        } else {
            out[pos] = value;
        }
    }
    Ok(out)
}

pub async fn list(app: &Arc<super::App>) -> Result<Value, String> {
    let root = app.data_root.clone();
    let (dirs, sessions) = tokio::task::spawn_blocking(move || {
        Ok::<_, String>((
            records(&root.join("directories.json"))?,
            records(&root.join("sessions.json"))?,
        ))
    })
    .await
    .map_err(|_| "directory read interrupted")??;
    let mut by_dir: HashMap<String, Vec<Value>> = HashMap::new();
    for session in sessions {
        if let Some(dir) = session["dirId"].as_str() {
            by_dir.entry(dir.to_owned()).or_default().push(session);
        }
    }
    let mut result = Vec::with_capacity(dirs.len());
    for dir in dirs {
        let path = Path::new(dir["path"].as_str().unwrap_or_default());
        let state = app
            .git_push_states
            .get(path, dir["baseBranch"].as_str().unwrap_or_default())
            .await;
        let sessions = dir["id"]
            .as_str()
            .and_then(|id| by_dir.get(id))
            .map_or(&[][..], Vec::as_slice);
        result.push(annotate_dir(&dir, sessions, state));
    }
    Ok(Value::Array(result))
}
