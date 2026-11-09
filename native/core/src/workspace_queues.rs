//! The workspace queue projection has one owner. Physical execution timestamps
//! reject stale updates; the independent view clock also advances when a shell
//! selects an older or empty execution. No host objects or JSON live here.
use crate::{
    classify_vocab::CLASSIFY_STATES,
    js::{JsString, JsValue as V},
};
use std::collections::HashMap;

pub const QUEUE_STATES: [&str; 6] = [
    "idle",
    "starting",
    "running",
    "assessing",
    "frozen",
    "queued",
];

fn nonnegative_integer(value: f64) -> f64 {
    if value.is_nan() {
        0.0
    } else {
        value.floor().max(0.0)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Queue {
    pub session_id: JsString,
    pub depth: f64,
    pub state: JsString,
    pub classify_state: Option<JsString>,
    pub updated_at: f64,
}

impl Queue {
    /// Inputs have already undergone the language boundary's String/Number
    /// coercions, in property-read order. Policy and normalization stay here.
    pub fn new(
        session_id: JsString,
        state: JsString,
        classify: JsString,
        depth: f64,
        updated_at: f64,
    ) -> Self {
        let classify = classify.to_uppercase();
        Self {
            session_id,
            depth: nonnegative_integer(depth),
            state: if QUEUE_STATES.iter().any(|s| state == *s) {
                state
            } else {
                "idle".into()
            },
            classify_state: CLASSIFY_STATES
                .iter()
                .any(|s| classify == *s)
                .then_some(classify),
            updated_at: nonnegative_integer(updated_at),
        }
    }
    pub fn empty(session_id: JsString) -> Self {
        Self::new(session_id, "idle".into(), "".into(), 0.0, 0.0)
    }
    pub fn value(&self) -> V {
        V::object(vec![
            ("sessionId", V::String(self.session_id.clone())),
            ("depth", V::Number(self.depth)),
            ("state", V::String(self.state.clone())),
            (
                "classifyState",
                self.classify_state
                    .clone()
                    .map(V::String)
                    .unwrap_or(V::Null),
            ),
            ("updatedAt", V::Number(self.updated_at)),
        ])
    }
}

#[derive(Default)]
pub struct Store {
    queues: HashMap<JsString, Queue>,
    view_time: f64,
}

pub struct Update {
    pub queue: Queue,
    pub changed: bool,
}

impl Store {
    pub fn get(&self, id: &JsString) -> Option<&Queue> {
        self.queues.get(id)
    }
    pub fn len(&self) -> usize {
        self.queues.len()
    }
    pub fn is_empty(&self) -> bool {
        self.queues.is_empty()
    }
    pub fn update(&mut self, next: Queue) -> Update {
        let previous = self.queues.get(&next.session_id);
        if let Some(previous) = previous.filter(|p| p.updated_at > next.updated_at) {
            return Update {
                queue: previous.clone(),
                changed: false,
            };
        }
        let changed = previous.is_none_or(|p| {
            p.depth != next.depth
                || p.state != next.state
                || p.classify_state != next.classify_state
        });
        self.queues.insert(next.session_id.clone(), next.clone());
        Update {
            queue: next,
            changed,
        }
    }
    /// Capture before calling the clock port: a reentrant clock may itself
    /// project a view, just as the old expression evaluated its first operand.
    pub fn next_view_time(&self) -> f64 {
        self.view_time + 1.0
    }
    pub fn advance_view(&mut self, next_time: f64, now: f64, queue_time: f64) -> f64 {
        let queue_time = if queue_time.is_nan() { 0.0 } else { queue_time };
        self.view_time = if next_time.is_nan() || now.is_nan() {
            f64::NAN
        } else {
            next_time.max(now).max(queue_time)
        };
        self.view_time
    }
    pub fn project(session_id: JsString, mut queue: Queue, view_time: f64) -> Queue {
        queue.session_id = session_id;
        queue.updated_at = view_time;
        queue
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn queue(id: &str, depth: f64, ts: f64) -> Queue {
        Queue::new(id.into(), "running".into(), "p".into(), depth, ts)
    }
    #[test]
    fn updates_reject_older_but_accept_equal_timestamps() {
        let mut s = Store::default();
        assert!(s.update(queue("s", 2.0, 100.0)).changed);
        assert!(!s.update(queue("s", 9.0, 99.0)).changed);
        assert_eq!(s.get(&"s".into()).unwrap().depth, 2.0);
        assert!(!s.update(queue("s", 2.0, 101.0)).changed);
        assert_eq!(s.get(&"s".into()).unwrap().updated_at, 101.0);
        assert!(s.update(queue("s", 0.0, 101.0)).changed);
    }
    #[test]
    fn views_clear_old_execution_without_poisoning_physical_time() {
        let mut s = Store::default();
        let child = s.update(queue("child", 3.0, 5000.0)).queue;
        let at = s.advance_view(s.next_view_time(), 10.0, child.updated_at);
        let first = Store::project("shell".into(), child, at);
        let empty = Queue::empty("shell".into());
        let at = s.advance_view(s.next_view_time(), 11.0, empty.updated_at);
        let cleared = Store::project("shell".into(), empty, at);
        assert_eq!(cleared.depth, 0.0);
        assert!(cleared.updated_at > first.updated_at);
        assert!(s.update(queue("shell", 1.0, 50.0)).changed);
        assert_eq!(s.get(&"shell".into()).unwrap().updated_at, 50.0);
        assert_eq!(s.len(), 2);
    }
    #[test]
    fn normalization_and_unicode_keys_are_lossless() {
        let id = JsString::from_units(vec![0xd800, 0x4e2d]);
        let mut s = Store::default();
        let q = Queue::new(id.clone(), "unknown".into(), "c".into(), -1.0, f64::NAN);
        assert_eq!(q.state, "idle");
        assert_eq!(q.classify_state, None);
        assert_eq!(q.depth.to_bits(), 0.0f64.to_bits());
        s.update(q);
        assert!(s.get(&id).is_some());
        assert!(s.get(&"�中".into()).is_none());
        assert_eq!(queue("s", f64::INFINITY, 3.9).updated_at, 3.0);
        assert_eq!(queue("s", f64::INFINITY, 3.9).depth, f64::INFINITY);
    }
    #[test]
    fn view_clock_matches_nan_and_infinity_and_owners_are_isolated() {
        let mut a = Store::default();
        let b = Store::default();
        a.update(queue("s", 1.0, 1.0));
        assert!(b.is_empty());
        assert!(a.advance_view(1.0, f64::NAN, 0.0).is_nan());
        assert!(a.advance_view(a.next_view_time(), 2.0, 0.0).is_nan());
        let mut c = Store::default();
        assert_eq!(c.advance_view(1.0, 1.0, f64::INFINITY), f64::INFINITY);
    }
}
