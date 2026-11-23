//! Serve the last Git probe while refreshing the session card in the background.
use super::directory_list::git;
use multicc_core::{session_git::loading_merge_state, task_domain::text};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

struct Entry {
    requested: Instant,
    state: Value,
    pending: bool,
}
pub(crate) struct Cache {
    entries: Mutex<HashMap<String, Entry>>,
    permits: Semaphore,
}
impl Default for Cache {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            permits: Semaphore::new(2),
        }
    }
}
impl Cache {
    pub(crate) fn get(self: &Arc<Self>, session: &Value, dir: &Value) -> Value {
        let id = text(&session["id"]).to_owned();
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|_, v| v.pending || v.requested.elapsed() < Duration::from_secs(300));
        if let Some(e) = entries.get(&id) {
            if e.pending || e.requested.elapsed() < Duration::from_secs(30) {
                return e.state.clone();
            }
        }
        let state = entries
            .get(&id)
            .map(|e| e.state.clone())
            .unwrap_or_else(loading_merge_state);
        entries.insert(
            id.clone(),
            Entry {
                requested: Instant::now(),
                state: state.clone(),
                pending: true,
            },
        );
        let cache = self.clone();
        let dir = dir.clone();
        let session = session.clone();
        tokio::spawn(async move {
            let _permit = cache.permits.acquire().await;
            let next = probe(&dir, &session).await;
            cache.entries.lock().unwrap().insert(
                id,
                Entry {
                    requested: Instant::now(),
                    state: next,
                    pending: false,
                },
            );
        });
        state
    }
}
async fn probe(d: &Value, s: &Value) -> Value {
    let mut state =
        json!({"mergeReady":false,"dirty":false,"ahead":0,"behind":0,"reason":"no-worktree"});
    if d.is_null() {
        state.as_object_mut().unwrap().remove("behind");
        return state;
    }
    let repo = Path::new(text(&d["path"]));
    let branch = text(&s["branch"]);
    let tree = text(&s["worktreePath"]);
    if tree.is_empty() || branch.is_empty() {
        return state;
    }
    let tree = Path::new(tree);
    let current = git(repo, &["symbolic-ref", "--short", "HEAD"])
        .await
        .unwrap_or_else(|| "main".into());
    let base = d["baseBranch"]
        .as_str()
        .filter(|b| !b.is_empty())
        .unwrap_or(&current);
    state["baseBranch"] = json!(base);
    state["branch"] = json!(branch);
    if !tree.exists() {
        if s["workspaceState"] == "hibernated" {
            state["reason"] = "hibernated".into();
        }
        state["worktreeMissing"] = true.into();
        return state;
    }
    for rebase in ["rebase-merge", "rebase-apply"] {
        if let Some(path) = git(tree, &["rev-parse", "--git-path", rebase]).await {
            if tree.join(path).exists() {
                let files = git(tree, &["diff", "--name-only", "--diff-filter=U"])
                    .await
                    .unwrap_or_default();
                return json!({"mergeReady":false,"dirty":true,"ahead":0,"behind":0,"baseBranch":base,"branch":branch,"baseCheckedOut":true,"conflict":true,"conflictFiles":files.lines().collect::<Vec<_>>()});
            }
        }
    }
    let dirty = git(tree, &["status", "--porcelain"])
        .await
        .is_some_and(|s| !s.is_empty());
    let range = format!("refs/heads/{base}...refs/heads/{branch}");
    let counts = git(repo, &["rev-list", "--left-right", "--count", &range, "--"])
        .await
        .unwrap_or_default();
    let mut parts = counts
        .split_whitespace()
        .filter_map(|n| n.parse::<u64>().ok());
    let behind = parts.next().unwrap_or(0);
    let ahead = parts.next().unwrap_or(0);
    let content = ahead > 0
        && git(repo, &["diff", "--quiet", &range, "--"])
            .await
            .is_none();
    json!({"mergeReady":(dirty||content)&&current==base,"dirty":dirty,"ahead":ahead,"behind":behind,"baseBranch":base,"branch":branch,"baseCheckedOut":current==base,"conflict":false})
}
