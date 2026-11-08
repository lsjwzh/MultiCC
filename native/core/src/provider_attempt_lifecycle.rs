//! Authoritative replay fence for one provider attempt.
use crate::js::{JsString, JsValue};
use crate::quota_guard::prop;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

/// Main producers are shared records: host callbacks can reenter after a
/// lookup, remove a record and still update the captured record afterwards.
/// Keeping an Rc preserves that ordering without storing a second JS ledger.
pub struct MainProducer<T> {
    pub attempt: Option<T>,
    pub token: JsValue,
    pub count: f64,
    pub ambiguous: bool,
    pub last_request_at: f64,
}

pub type SharedMainProducer<T> = Rc<RefCell<MainProducer<T>>>;

/// Current attempt per session. Values may be host handles while the runner
/// still lives in Node; replacing a handle never mutates an earlier record.
pub struct CurrentAttempts<T> {
    values: HashMap<JsString, T>,
    admitting: HashSet<JsString>,
}

impl<T> Default for CurrentAttempts<T> {
    fn default() -> Self {
        Self {
            values: HashMap::new(),
            admitting: HashSet::new(),
        }
    }
}

impl<T> CurrentAttempts<T> {
    pub fn get(&self, key: &JsString) -> Option<&T> {
        self.values.get(key)
    }
    pub fn set(&mut self, key: JsString, value: T) {
        self.values.insert(key, value);
    }
    pub fn begin_admission(&mut self, key: JsString) -> bool {
        self.admitting.insert(key)
    }
    pub fn end_admission(&mut self, key: &JsString) {
        self.admitting.remove(key);
    }
}

pub struct MainProducers<T> {
    active: HashMap<JsString, SharedMainProducer<T>>,
    ended: HashMap<JsString, SharedMainProducer<T>>,
}

impl<T> Default for MainProducers<T> {
    fn default() -> Self {
        Self {
            active: HashMap::new(),
            ended: HashMap::new(),
        }
    }
}

impl<T> MainProducers<T> {
    pub fn active(&self, key: &JsString) -> Option<SharedMainProducer<T>> {
        self.active.get(key).cloned()
    }
    pub fn insert_active(&mut self, key: JsString, value: MainProducer<T>) {
        self.active.insert(key, Rc::new(RefCell::new(value)));
    }
    pub fn delete_active(&mut self, key: &JsString) -> bool {
        self.active.remove(key).is_some()
    }
    pub fn ended(&self, key: &JsString) -> Option<SharedMainProducer<T>> {
        self.ended.get(key).cloned()
    }
    pub fn insert_ended(&mut self, key: JsString, value: MainProducer<T>) {
        self.ended.insert(key, Rc::new(RefCell::new(value)));
    }
    pub fn delete_ended(&mut self, key: &JsString) -> bool {
        self.ended.remove(key).is_some()
    }
    pub fn has_ended(&self, key: &JsString) -> bool {
        self.ended.contains_key(key)
    }
}

#[derive(Default)]
struct NonMainProducer {
    count: f64,
    ambiguous: bool,
}

/// Live background/subagent producers and their bounded end-before-usage
/// receipts. These receipts prove only request attribution, not delivery.
#[derive(Default)]
pub struct NonMainProducers {
    active: HashMap<JsString, NonMainProducer>,
    ended: HashSet<JsString>,
    ended_order: VecDeque<JsString>,
}

impl NonMainProducers {
    fn remove_ended(&mut self, key: &JsString) -> bool {
        if !self.ended.remove(key) {
            return false;
        }
        self.ended_order.retain(|item| item != key);
        true
    }

    pub fn start(&mut self, key: JsString) {
        self.remove_ended(&key);
        if let Some(producer) = self.active.get_mut(&key) {
            producer.count += 1.0;
            producer.ambiguous = true;
        } else {
            self.active.insert(
                key,
                NonMainProducer {
                    count: 1.0,
                    ambiguous: false,
                },
            );
        }
    }

    pub fn has_active(&self, key: &JsString) -> bool {
        self.active.contains_key(key)
    }

    pub fn end(&mut self, key: &JsString) -> bool {
        let Some(producer) = self.active.get_mut(key) else {
            return false;
        };
        producer.count = (producer.count - 1.0).max(0.0);
        if producer.count == 0.0 {
            let ambiguous = producer.ambiguous;
            self.active.remove(key);
            if !ambiguous && self.ended.insert(key.clone()) {
                self.ended_order.push_back(key.clone());
                if self.ended.len() > 2048 {
                    if let Some(oldest) = self.ended_order.pop_front() {
                        self.ended.remove(&oldest);
                    }
                }
            }
        }
        true
    }

    pub fn bind_usage(&mut self, key: &JsString) -> bool {
        if self
            .active
            .get(key)
            .is_some_and(|p| p.count == 1.0 && !p.ambiguous)
        {
            return true;
        }
        self.remove_ended(key)
    }
}

#[derive(Default)]
pub struct AttemptGenerations {
    values: HashMap<JsString, f64>,
}

impl AttemptGenerations {
    pub fn next(&mut self, session: JsString) -> f64 {
        let value = self.values.entry(session).or_insert(0.0);
        *value += 1.0;
        *value
    }
}

pub struct AttemptIdentity {
    epoch: JsValue,
    attempt: JsValue,
    turn: JsValue,
    generation: f64,
}

impl AttemptIdentity {
    pub fn new(value: &JsValue) -> Self {
        Self {
            epoch: prop(value, "runtimeEpoch").clone(),
            attempt: prop(value, "routeAttemptId").clone(),
            turn: prop(value, "turnId").clone(),
            generation: match prop(value, "routeGeneration") {
                JsValue::Number(number) => *number,
                _ => f64::NAN,
            },
        }
    }
    pub fn matches_epoch(&self, value: &JsValue) -> bool {
        self.epoch == *value
    }
    pub fn matches_attempt(&self, value: &JsValue) -> bool {
        self.attempt == *value
    }
    pub fn matches_generation(&self, value: f64) -> bool {
        self.generation == value
    }
    pub fn matches_turn(&self, value: &JsValue) -> bool {
        self.turn == *value
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Fence {
    None,
    VisibleOutput,
    ToolIntent,
    SideEffect,
}

impl Fence {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Self::None),
            "visible_output" => Some(Self::VisibleOutput),
            "tool_intent" => Some(Self::ToolIntent),
            "side_effect" => Some(Self::SideEffect),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::VisibleOutput => "visible_output",
            Self::ToolIntent => "tool_intent",
            Self::SideEffect => "side_effect",
        }
    }
}

pub struct AttemptFence {
    pub level: Fence,
    pub visible: bool,
    pub tool: bool,
    pub side_effect: bool,
}

impl AttemptFence {
    pub fn new(level: Fence, visible: bool, tool: bool, side_effect: bool) -> Self {
        Self {
            level,
            visible,
            tool,
            side_effect,
        }
    }
    pub fn advance(&mut self, next: Fence) -> bool {
        let advanced = next > self.level;
        if advanced {
            self.level = next;
        }
        if next >= Fence::VisibleOutput {
            self.visible = true;
        }
        if next >= Fence::ToolIntent {
            self.tool = true;
        }
        if next >= Fence::SideEffect {
            self.side_effect = true;
        }
        advanced
    }
    /// Only the host can prove an error envelope. Never reopen after tools or
    /// side effects, even if a later message appears to be an error.
    pub fn reconcile_host_error(&mut self) -> bool {
        if self.tool || self.side_effect {
            return false;
        }
        self.level = Fence::None;
        self.visible = false;
        true
    }
}

/// Per-attempt request budget. A completed request clears the carried deadline
/// and failure count, while an already-stalled route stays retired.
pub struct AttemptBudget {
    pub deadline: Option<f64>,
    pub failures: f64,
    pub stalled: bool,
}

impl AttemptBudget {
    pub fn new(deadline: Option<f64>, failures: f64) -> Self {
        Self {
            deadline,
            failures,
            stalled: false,
        }
    }

    pub fn completed(&mut self) {
        self.deadline = None;
        self.failures = 0.0;
    }

    pub fn observe_failure(
        &mut self,
        deadline: f64,
        upstream_failure: bool,
        http_status: u32,
    ) -> bool {
        let budgeted = deadline.is_finite()
            && deadline > 0.0
            && (upstream_failure || http_status >= 500 || http_status == 408 || http_status == 429);
        if budgeted {
            self.deadline = Some(deadline);
            self.failures += 1.0;
        }
        budgeted
    }

    pub fn stall_retry_exhausted(&self, code: &str) -> bool {
        is_stall(code) && self.failures > 1.0
    }

    pub fn deadline_reached(&self, now: f64) -> bool {
        self.deadline.is_some_and(|deadline| now >= deadline)
    }

    pub fn retire_if_stalled(&mut self, code: &str, exhausted: bool) -> bool {
        let retire = is_stall(code) || exhausted;
        if retire {
            self.stalled = true;
        }
        retire
    }
}

fn is_stall(code: &str) -> bool {
    [
        "response_stalled_before_response",
        "stream_idle_timeout",
        "model_request_deadline",
        "model_connect_timeout",
    ]
    .iter()
    .any(|candidate| code.eq_ignore_ascii_case(candidate))
}

pub struct AttemptStatus {
    pub outcome: String,
    pub error_category: Option<String>,
    pub finished_at: Option<f64>,
}

impl Default for AttemptStatus {
    fn default() -> Self {
        Self {
            outcome: "running".into(),
            error_category: None,
            finished_at: None,
        }
    }
}

impl AttemptStatus {
    pub fn running(&self) -> bool {
        self.outcome == "running"
    }
    pub fn set_outcome(&mut self, outcome: String) {
        self.outcome = outcome;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AttemptBudget, AttemptFence, AttemptGenerations, AttemptIdentity, AttemptStatus,
        CurrentAttempts, Fence, MainProducer, MainProducers,
    };
    use crate::js::{JsString, JsValue};
    use crate::quota_guard::prop;

    #[test]
    fn current_attempt_admission_is_exclusive_per_utf16_session_and_releasable() {
        let mut attempts = CurrentAttempts::<u32>::default();
        let first = JsString::from_units(vec![0xd800]);
        let second = JsString::from_units(vec![0xd801]);
        assert!(attempts.begin_admission(first.clone()));
        assert!(!attempts.begin_admission(first.clone()));
        assert!(attempts.begin_admission(second.clone()));
        attempts.end_admission(&first);
        assert!(attempts.begin_admission(first));
        assert!(!attempts.begin_admission(second));
    }

    #[test]
    fn captured_producer_survives_removal_without_mutating_replacement() {
        let mut registry = MainProducers::<u64>::default();
        let key = JsString::from_units(vec![0xd800]);
        let other = JsString::from_units(vec![0xd801]);
        let make = |count| MainProducer {
            attempt: Some(42),
            token: JsValue::string("token"),
            count,
            ambiguous: false,
            last_request_at: 10.0,
        };
        registry.insert_active(key.clone(), make(1.0));
        let captured = registry.active(&key).unwrap();
        assert!(registry.active(&other).is_none());
        assert!(registry.delete_active(&key));
        registry.insert_active(key.clone(), make(1.0));
        captured.borrow_mut().count += 1.0;
        assert_eq!(captured.borrow().count, 2.0);
        assert_eq!(registry.active(&key).unwrap().borrow().count, 1.0);
        registry.insert_ended(key.clone(), make(0.0));
        assert!(registry.has_ended(&key));
        assert!(registry.delete_ended(&key));
        assert!(!registry.has_ended(&key));
    }
    #[test]
    fn tool_and_side_effects_never_reopen_on_host_error() {
        let mut fence = AttemptFence::new(Fence::None, false, false, false);
        assert!(fence.advance(Fence::VisibleOutput));
        assert!(fence.reconcile_host_error());
        assert_eq!(fence.level, Fence::None);
        assert!(fence.advance(Fence::ToolIntent));
        assert!(!fence.reconcile_host_error());
        assert!(!fence.advance(Fence::VisibleOutput));
        assert_eq!(fence.level, Fence::ToolIntent);
        assert!(fence.advance(Fence::SideEffect));
        assert!(fence.visible && fence.tool && fence.side_effect);
        assert!(!fence.reconcile_host_error());
    }

    #[test]
    fn successful_request_clears_budget_but_never_reopens_a_stalled_route() {
        let mut budget = AttemptBudget::new(None, 0.0);
        assert!(budget.observe_failure(5000.0, true, 0));
        assert!(!budget.stall_retry_exhausted("stream_idle_timeout"));
        assert!(budget.observe_failure(5000.0, true, 0));
        assert!(budget.stall_retry_exhausted("STREAM_IDLE_TIMEOUT"));
        assert!(budget.retire_if_stalled("stream_idle_timeout", true));
        budget.completed();
        assert!(budget.stalled);
        assert_eq!(budget.deadline, None);
        assert_eq!(budget.failures, 0.0);
    }

    #[test]
    fn attempt_finalization_is_owned_once() {
        let mut status = AttemptStatus::default();
        assert!(status.running());
        status.set_outcome("failed".into());
        status.error_category = Some("network".into());
        status.finished_at = Some(100.0);
        assert!(!status.running());
        assert_eq!(status.outcome, "failed");
        assert_eq!(status.finished_at, Some(100.0));
    }

    #[test]
    fn identities_and_generations_keep_unpaired_utf16_distinct() {
        let first = JsString::from_units(vec![0xd800]);
        let second = JsString::from_units(vec![0xd801]);
        let mut generations = AttemptGenerations::default();
        assert_eq!(generations.next(first.clone()), 1.0);
        assert_eq!(generations.next(second), 1.0);
        assert_eq!(generations.next(first), 2.0);
        let value = JsValue::object(vec![
            ("runtimeEpoch", "epoch".into()),
            ("routeAttemptId", "attempt".into()),
            ("turnId", "turn".into()),
            ("routeGeneration", 2.0.into()),
        ]);
        let identity = AttemptIdentity::new(&value);
        assert!(identity.matches_epoch(prop(&value, "runtimeEpoch")));
        assert!(identity.matches_attempt(prop(&value, "routeAttemptId")));
        assert!(identity.matches_generation(2.0));
        assert!(identity.matches_turn(prop(&value, "turnId")));
        let stale = JsValue::object(vec![
            ("runtimeEpoch", "epoch".into()),
            ("routeAttemptId", "attempt".into()),
            ("turnId", "turn".into()),
            ("routeGeneration", 1.0.into()),
        ]);
        assert!(
            !identity.matches_generation(match prop(&stale, "routeGeneration") {
                JsValue::Number(value) => *value,
                _ => f64::NAN,
            })
        );
    }
}
