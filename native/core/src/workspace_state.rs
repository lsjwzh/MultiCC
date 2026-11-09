//! Workspace status/summary ownership and session run transitions. Host payloads
//! are generic while records still live in Node; native consumers pass values
//! directly. No JSON or persistence writer is introduced by this view owner.
use crate::js::{JsString, JsValue as V};
use std::collections::HashMap;

pub const RUNNING_STATUSES: [&str; 3] = ["thinking", "editing", "running"];
pub const SESSION_STATUSES: [&str; 9] = [
    "thinking",
    "editing",
    "running",
    "idle",
    "waiting",
    "background",
    "succeeded",
    "completed",
    "error",
];
pub fn supported(value: &JsString) -> bool {
    SESSION_STATUSES.iter().any(|s| value == *s)
}
pub fn running(value: &JsString) -> bool {
    RUNNING_STATUSES.iter().any(|s| value == *s)
}
fn number_truthy(v: Option<f64>) -> bool {
    v.is_some_and(|n| n != 0.0 && !n.is_nan())
}

#[derive(Clone, Debug, PartialEq)]
pub struct RunState {
    pub status: Option<JsString>,
    pub last_activity: f64,
    pub run_started_at: Option<f64>,
    pub run_ended_at: Option<f64>,
}
impl Default for RunState {
    fn default() -> Self {
        Self {
            status: Some("idle".into()),
            last_activity: 0.0,
            run_started_at: None,
            run_ended_at: None,
        }
    }
}
impl RunState {
    /// Previously stored objects pass through Number(null) on the next call.
    /// A missing pure-function previous argument instead uses Default directly.
    pub fn normalized(&self) -> Self {
        let finite = |v: Option<f64>| {
            let n = v.unwrap_or(0.0);
            n.is_finite().then_some(n)
        };
        Self {
            status: Some(
                self.status
                    .as_ref()
                    .filter(|s| supported(s))
                    .cloned()
                    .unwrap_or_else(|| "idle".into()),
            ),
            last_activity: if self.last_activity.is_nan() {
                0.0
            } else {
                self.last_activity.max(0.0)
            },
            run_started_at: finite(self.run_started_at),
            run_ended_at: finite(self.run_ended_at),
        }
    }
    pub fn value(&self) -> V {
        V::object(vec![
            (
                "status",
                self.status.clone().map(V::String).unwrap_or(V::Undefined),
            ),
            ("lastActivity", V::Number(self.last_activity)),
            (
                "runStartedAt",
                self.run_started_at.map(V::Number).unwrap_or(V::Null),
            ),
            (
                "runEndedAt",
                self.run_ended_at.map(V::Number).unwrap_or(V::Null),
            ),
        ])
    }
}
pub struct Transition {
    pub state: RunState,
    pub changed: bool,
    pub entered_running: bool,
    pub left_running: bool,
}
pub fn transition(
    previous: &RunState,
    requested: JsString,
    now: f64,
    pending: bool,
) -> Result<Transition, &'static str> {
    if !supported(&requested) {
        return Err("unsupported status");
    }
    if !now.is_finite() || now < 0.0 {
        return Err("[session] transition time must be finite");
    }
    let was_running =
        number_truthy(previous.run_started_at) && !number_truthy(previous.run_ended_at);
    let requested_running = running(&requested);
    let mut state = previous.clone();
    state.last_activity = now;
    if requested_running && !was_running {
        state.run_started_at = Some(now);
        state.run_ended_at = None;
    } else if !requested_running && was_running {
        state.run_ended_at = Some(now);
    }
    let status = if pending
        && !requested_running
        && !["waiting", "background", "error"]
            .iter()
            .any(|s| requested == *s)
    {
        "background".into()
    } else {
        requested
    };
    let changed = previous.status.as_ref() != Some(&status);
    state.status = Some(status);
    Ok(Transition {
        state,
        changed,
        entered_running: !was_running && requested_running,
        left_running: was_running && !requested_running,
    })
}

#[derive(Clone)]
pub struct Status<T> {
    pub run: RunState,
    pub current_file: T,
    pub hydrated: bool,
}
#[derive(Clone)]
pub struct Summary<T> {
    pub summary: T,
    pub ts: T,
}
pub struct Store<T> {
    statuses: HashMap<JsString, Status<T>>,
    summaries: HashMap<JsString, Summary<T>>,
}
impl<T> Default for Store<T> {
    fn default() -> Self {
        Self {
            statuses: HashMap::new(),
            summaries: HashMap::new(),
        }
    }
}
impl<T> Store<T> {
    pub fn status(&self, id: &JsString) -> Option<&Status<T>> {
        self.statuses.get(id)
    }
    pub fn summary(&self, id: &JsString) -> Option<&Summary<T>> {
        self.summaries.get(id)
    }
    pub fn set_status(&mut self, id: JsString, value: Status<T>) {
        self.statuses.insert(id, value);
    }
    pub fn set_summary(&mut self, id: JsString, value: Summary<T>) {
        self.summaries.insert(id, value);
    }
    pub fn delete_status(&mut self, id: &JsString) -> bool {
        self.statuses.remove(id).is_some()
    }
    pub fn delete_summary(&mut self, id: &JsString) -> bool {
        self.summaries.remove(id).is_some()
    }
    pub fn status_len(&self) -> usize {
        self.statuses.len()
    }
    pub fn summary_len(&self) -> usize {
        self.summaries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn running_segments_and_pending_background() {
        let started = transition(&RunState::default(), "thinking".into(), 100.0, false).unwrap();
        assert!(started.entered_running);
        let editing =
            transition(&started.state.normalized(), "editing".into(), 120.0, true).unwrap();
        assert_eq!(editing.state.run_started_at, Some(100.0));
        assert!(!editing.entered_running);
        let ended =
            transition(&editing.state.normalized(), "succeeded".into(), 150.0, true).unwrap();
        assert_eq!(ended.state.status, Some("background".into()));
        assert_eq!(ended.state.run_ended_at, Some(150.0));
        assert!(ended.left_running);
        for name in ["waiting", "error", "background"] {
            assert_eq!(
                transition(&editing.state, name.into(), 150.0, true)
                    .unwrap()
                    .state
                    .status,
                Some(name.into())
            );
        }
    }
    #[test]
    fn zero_clock_and_null_normalization_keep_legacy_boundaries() {
        let initial = RunState::default();
        assert_eq!(initial.normalized().run_started_at, Some(0.0));
        let zero = transition(&initial.normalized(), "running".into(), 0.0, false).unwrap();
        let restarted = transition(&zero.state.normalized(), "running".into(), 2.0, false).unwrap();
        assert_eq!(restarted.state.run_started_at, Some(2.0));
        for now in [f64::NAN, f64::INFINITY, -1.0] {
            assert!(transition(&initial, "idle".into(), now, false).is_err());
        }
        assert!(transition(&initial, "unknown".into(), 1.0, false).is_err());
    }
    #[test]
    fn stores_are_independent_and_keep_captured_values_after_replacement() {
        let mut a = Store::default();
        let b: Store<V> = Store::default();
        let id = JsString::from_units(vec![0xd800, 0x4e2d]);
        a.set_summary(
            id.clone(),
            Summary {
                summary: V::string("first"),
                ts: V::Number(1.0),
            },
        );
        let captured = a.summary(&id).unwrap().clone();
        a.set_summary(
            id.clone(),
            Summary {
                summary: V::string("second"),
                ts: V::Number(2.0),
            },
        );
        assert_eq!(captured.summary, V::string("first"));
        assert_eq!(b.summary_len(), 0);
        assert!(a.delete_summary(&id));
        assert!(!a.delete_summary(&id));
    }
}
