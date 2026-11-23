//! In-process operation history, with live reads during a Git probe and a
//! bounded history of completed operations. Cancellation is a terminal state.
use multicc_core::auth_runtime::now_ms;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
    sync::{Arc, Mutex},
};

#[derive(Default, Clone)]
pub(crate) struct Gauge(Arc<AtomicUsize>);
pub(crate) struct Counted(Gauge);
impl Gauge {
    pub(crate) fn enter(&self) -> Counted {
        self.0.fetch_add(1, Ordering::Relaxed);
        Counted(self.clone())
    }
    pub(crate) fn value(&self) -> usize {
        self.0.load(Ordering::Relaxed)
    }
}
impl Drop for Counted {
    fn drop(&mut self) {
        self.0 .0.fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Default)]
pub(super) struct Operations {
    rows: Mutex<VecDeque<Value>>,
    pub(super) depth: Gauge,
}

pub(super) struct Running<'a> {
    history: &'a Operations,
    id: String,
    done: bool,
}

impl Operations {
    pub(super) fn start(&self, path: &Path) -> Option<Running<'_>> {
        let id = multicc_core::random_id::prefixed_id("push-state").ok()?;
        let now = now_ms();
        let depth = self.depth.value();
        let record = json!({"operationId":id,"kind":"push-state","repoKey":path,"sessionId":null,
            "status":"running","queueDepth":depth,"createdAt":now,"startedAt":now,"finishedAt":null,
            "progress":[{"phase":"started","detail":null,"ts":now,"queueDepth":depth}]});
        let mut rows = self.rows.lock().unwrap_or_else(|e| e.into_inner());
        rows.push_back(record);
        while rows.len() > 500 {
            let Some(i) = rows.iter().position(|v| !v["finishedAt"].is_null()) else {
                break;
            };
            rows.remove(i);
        }
        Some(Running {
            history: self,
            id,
            done: false,
        })
    }
    pub(super) fn status(&self, id: &str) -> Option<Value> {
        self.rows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|v| v["operationId"] == id)
            .cloned()
    }
}
impl Running<'_> {
    pub(super) fn finish(mut self) {
        self.done = true;
    }
}
impl Drop for Running<'_> {
    fn drop(&mut self) {
        let mut rows = self.history.rows.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(row) = rows.iter_mut().find(|v| v["operationId"] == self.id) {
            let now = now_ms();
            row["finishedAt"] = json!(now);
            row["status"] = json!(if self.done { "completed" } else { "failed" });
            if let Some(progress) = row["progress"].as_array_mut() {
                progress.push(json!({"phase":if self.done {"completed"} else {"failed"}, "detail":null, "ts":now,"queueDepth":self.history.depth.value()}));
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queries_live_and_finished_operations_and_balances_cancelled_work() {
        let ops = Operations::default();
        let count = ops.depth.enter();
        let running = ops.start(Path::new("/repo")).unwrap();
        let id = running.id.clone();
        assert_eq!(ops.status(&id).unwrap()["status"], "running");
        running.finish();
        drop(count);
        assert_eq!(ops.status(&id).unwrap()["status"], "completed");
        let cancelled = ops.start(Path::new("/repo")).unwrap();
        let id = cancelled.id.clone();
        drop(cancelled);
        assert_eq!(ops.status(&id).unwrap()["status"], "failed");
        assert_eq!(ops.depth.value(), 0);
        assert!(ops.status("unknown").is_none());
    }
}
