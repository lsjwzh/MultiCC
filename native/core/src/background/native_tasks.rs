//! Codex native sub-task records.
//!
//! Native sub-tasks only contribute display and liveness: the CLI delivers their
//! result to the main agent itself, so the owner never injects a wake-up for
//! them. A record is keyed by `String(event.task_id)` per session and keeps
//! `at` frozen across heartbeats.
use crate::background::state::{js_max, OrderedMap};
use crate::js::{string::JsString, JsValue};

#[derive(Clone, Debug, PartialEq)]
pub struct NativeTask {
    pub description: JsString,
    pub live: bool,
    pub tool: bool,
    pub at: f64,
}

#[derive(Clone, Debug)]
pub enum NativeOutcome {
    /// A terminal record was already seen (or progress arrived after it).
    Unchanged,
    Applied {
        changed: bool,
        frame_type: &'static str,
        status: JsString,
        task: NativeTask,
    },
}

#[derive(Clone, Debug)]
pub struct NativeStore {
    sessions: OrderedMap<OrderedMap<NativeTask>>,
}

impl Default for NativeStore {
    fn default() -> Self {
        Self {
            sessions: OrderedMap::new(),
        }
    }
}

fn records<'a>(
    sessions: &'a mut OrderedMap<OrderedMap<NativeTask>>,
    session: &JsString,
) -> &'a mut OrderedMap<NativeTask> {
    if !sessions.contains_key(session) {
        sessions.set(session.clone(), OrderedMap::new());
    }
    sessions
        .get_mut(session)
        .expect("session map inserted above")
}

impl NativeStore {
    pub fn new() -> Self {
        Self::default()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn apply(
        &mut self,
        session: &JsString,
        id: &JsString,
        done: bool,
        started: bool,
        heartbeat: bool,
        status: Option<&JsValue>,
        tool: bool,
        description: JsString,
        now: f64,
    ) -> NativeOutcome {
        let tasks = records(&mut self.sessions, session);
        let previous = tasks.get(id).cloned();
        if done && previous.as_ref().is_some_and(|task| !task.live) {
            return NativeOutcome::Unchanged;
        }
        if !done && !started && previous.as_ref().is_some_and(|task| !task.live) {
            return NativeOutcome::Unchanged;
        }
        let status = if done {
            match status {
                Some(JsValue::String(value))
                    if value == "completed" || value == "failed" || value == "interrupted" =>
                {
                    value.clone()
                }
                _ => JsString::from_rust_str("interrupted"),
            }
        } else {
            JsString::from_rust_str("running")
        };
        let at = match &previous {
            Some(task) if heartbeat => task.at,
            _ => now,
        };
        let task = NativeTask {
            description,
            live: !done,
            tool,
            at,
        };
        let previous_live = previous.as_ref().is_some_and(|task| task.live);
        let changed = previous_live != task.live;
        let frame_type = if done {
            "monitor_done"
        } else if previous_live {
            "monitor_progress"
        } else {
            "monitor_started"
        };
        tasks.set(id.clone(), task.clone());
        NativeOutcome::Applied {
            changed,
            frame_type,
            status,
            task,
        }
    }

    /// Terminal records older than the newest live work are dropped once the
    /// session grows past 2000 records; live records are never evicted.
    pub fn evict(&mut self, session: &JsString) {
        let Some(tasks) = self.sessions.get_mut(session) else {
            return;
        };
        if tasks.len() <= 2000 {
            return;
        }
        for key in tasks.keys_vec() {
            let live = tasks.get(&key).is_some_and(|task| task.live);
            if !live {
                tasks.delete(&key);
            }
            if tasks.len() <= 1000 {
                break;
            }
        }
    }

    pub fn list(&self, session: &JsString) -> Vec<(JsString, JsString)> {
        self.sessions
            .get(session)
            .map(|tasks| {
                tasks
                    .iter()
                    .filter(|(_, task)| task.live)
                    .map(|(id, task)| (id.clone(), task.description.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// `has`: a live native *agent* task keeps the session alive.
    pub fn has(&self, session: &JsString) -> bool {
        self.sessions
            .get(session)
            .is_some_and(|tasks| tasks.values().any(|task| task.live && !task.tool))
    }

    /// `silence(name, at)`: longest silence among live agent tasks, `0` when
    /// there are none (`Math.max(0, ...[])`).
    pub fn silence(&self, session: &JsString, at: f64) -> f64 {
        self.sessions
            .get(session)
            .map(|tasks| {
                tasks
                    .values()
                    .filter(|task| task.live && !task.tool)
                    .map(|task| at - task.at)
                    .fold(0.0, js_max)
            })
            .unwrap_or(0.0)
    }

    pub fn reap_list(&self, session: &JsString) -> Vec<(JsString, JsString)> {
        self.list(session)
    }

    pub fn stop(&mut self, session: &JsString) {
        self.sessions.delete(session);
    }

    /// Stored `kind === 'tool'` for one record, used by the reap path to keep
    /// the original kind when it synthesises a terminal event.
    pub fn task_tool(&self, session: &JsString, id: &JsString) -> Option<bool> {
        self.sessions
            .get(session)
            .and_then(|tasks| tasks.get(id))
            .map(|task| task.tool)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> JsString {
        JsString::from_rust_str(value)
    }

    #[test]
    fn started_progress_done_sequence_and_dedup() {
        let mut store = NativeStore::new();
        let session = text("s");
        let id = text("codex_task_1");
        let started = store.apply(
            &session,
            &id,
            false,
            true,
            false,
            None,
            false,
            text("child"),
            100.0,
        );
        let NativeOutcome::Applied {
            changed,
            frame_type,
            status,
            ..
        } = started
        else {
            panic!("started");
        };
        assert!(changed);
        assert_eq!(frame_type, "monitor_started");
        assert_eq!(status, text("running"));
        let progress = store.apply(
            &session,
            &id,
            false,
            false,
            true,
            None,
            false,
            text("ignored"),
            200.0,
        );
        let NativeOutcome::Applied {
            changed,
            frame_type,
            task,
            ..
        } = progress
        else {
            panic!("progress");
        };
        assert!(!changed);
        assert_eq!(frame_type, "monitor_progress");
        assert_eq!(task.at, 100.0);
        assert_eq!(task.description, text("ignored"));
        let done = store.apply(
            &session,
            &id,
            true,
            false,
            false,
            Some(&JsValue::string("completed")),
            false,
            text("child"),
            300.0,
        );
        let NativeOutcome::Applied {
            changed, status, ..
        } = done
        else {
            panic!("done");
        };
        assert!(changed);
        assert_eq!(status, text("completed"));
        assert!(matches!(
            store.apply(
                &session,
                &id,
                true,
                false,
                false,
                Some(&JsValue::string("completed")),
                false,
                text("child"),
                400.0
            ),
            NativeOutcome::Unchanged
        ));
        assert!(!store.has(&session));
    }

    #[test]
    fn unknown_status_is_an_interruption_and_tool_tasks_do_not_keep_alive() {
        let mut store = NativeStore::new();
        let session = text("s");
        let id = text("t");
        store.apply(
            &session,
            &id,
            false,
            true,
            false,
            None,
            true,
            text("tool"),
            5.0,
        );
        assert!(!store.has(&session));
        assert_eq!(store.silence(&session, 10.0), 0.0);
        store.apply(
            &session,
            &id,
            false,
            true,
            false,
            None,
            false,
            text("agent"),
            5.0,
        );
        assert!(store.has(&session));
        assert_eq!(store.silence(&session, 10.0), 5.0);
        let outcome = store.apply(
            &session,
            &id,
            true,
            false,
            false,
            Some(&JsValue::string("weird")),
            false,
            text("agent"),
            9.0,
        );
        let NativeOutcome::Applied { status, .. } = outcome else {
            panic!("done");
        };
        assert_eq!(status, text("interrupted"));
    }

    #[test]
    fn list_keeps_insertion_order_and_only_live_tasks() {
        let mut store = NativeStore::new();
        let session = text("s");
        store.apply(
            &session,
            &text("a"),
            false,
            true,
            false,
            None,
            false,
            text("A"),
            0.0,
        );
        store.apply(
            &session,
            &text("b"),
            false,
            true,
            false,
            None,
            false,
            text("B"),
            0.0,
        );
        store.apply(
            &session,
            &text("a"),
            true,
            false,
            false,
            Some(&JsValue::string("completed")),
            false,
            text("A"),
            1.0,
        );
        assert_eq!(store.list(&session), vec![(text("b"), text("B"))]);
        store.stop(&session);
        assert!(store.list(&session).is_empty());
    }
}
