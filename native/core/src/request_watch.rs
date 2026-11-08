//! Ownership of one admitted model request's watchdog lifecycle.
#[derive(Default)]
pub struct RequestWatch {
    armed: bool,
    finished: bool,
    progressed: bool,
    idle_ms: f64,
    connect_ms: f64,
    deadline_at: Option<f64>,
    fresh_deadline_at: Option<f64>,
}

impl RequestWatch {
    pub fn accepts(&self, budget: f64, total: f64) -> bool {
        let valid_idle = budget.is_finite()
            && budget.fract() == 0.0
            && budget.abs() <= 9_007_199_254_740_991.0
            && budget > 0.0;
        !self.armed && !self.finished && (valid_idle || total > 0.0)
    }

    pub fn arm(&mut self, budget: f64, total: f64, connect: f64, requested: f64, now: f64) -> bool {
        if !self.accepts(budget, total) {
            return false;
        }
        let valid_idle = budget.is_finite()
            && budget.fract() == 0.0
            && budget.abs() <= 9_007_199_254_740_991.0
            && budget > 0.0;
        self.armed = true;
        self.connect_ms = if connect == 0.0 || connect.is_nan() {
            0.0
        } else {
            connect
        };
        self.idle_ms = if valid_idle { budget } else { 0.0 };
        if total > 0.0 {
            let fresh = now + total;
            self.fresh_deadline_at = Some(fresh);
            self.deadline_at = Some(if requested == 0.0 || requested.is_nan() {
                fresh
            } else {
                requested
            });
        }
        true
    }
    pub fn progress(&mut self) -> bool {
        if self.finished {
            return false;
        }
        self.progressed = true;
        true
    }
    pub fn finish(&mut self) -> bool {
        if self.finished {
            return false;
        }
        self.finished = true;
        true
    }
    pub fn isolate_retry_budget(&mut self) -> bool {
        if self.finished {
            return false;
        }
        let Some(fresh) = self.fresh_deadline_at else {
            return false;
        };
        if fresh == 0.0 || fresh.is_nan() || self.deadline_at == Some(fresh) {
            return false;
        }
        self.deadline_at = Some(fresh);
        true
    }
    pub fn armed(&self) -> bool {
        self.armed
    }
    pub fn finished(&self) -> bool {
        self.finished
    }
    pub fn progressed(&self) -> bool {
        self.progressed
    }
    pub fn idle_ms(&self) -> f64 {
        self.idle_ms
    }
    pub fn connect_ms(&self) -> f64 {
        self.connect_ms
    }
    pub fn deadline_at(&self) -> Option<f64> {
        self.deadline_at
    }
}

#[cfg(test)]
mod tests {
    use super::RequestWatch;

    #[test]
    fn admitted_request_keeps_its_deadline_and_rejects_late_events() {
        let mut watch = RequestWatch::default();
        assert!(watch.arm(20.0, 100.0, 30.0, 50.0, 10.0));
        assert!(!watch.arm(20.0, 100.0, 30.0, 50.0, 10.0));
        assert_eq!(watch.deadline_at(), Some(50.0));
        assert!(watch.progress());
        assert!(watch.progressed());
        assert!(watch.isolate_retry_budget());
        assert_eq!(watch.deadline_at(), Some(110.0));
        assert!(!watch.isolate_retry_budget());
        assert!(watch.finish());
        assert!(!watch.progress());
        assert!(!watch.finish());
        assert!(!watch.isolate_retry_budget());
    }

    #[test]
    fn invalid_idle_budget_never_arms_without_an_absolute_deadline() {
        let mut watch = RequestWatch::default();
        assert!(!watch.arm(1.5, 0.0, 0.0, 0.0, 0.0));
        assert!(!watch.arm(f64::INFINITY, 0.0, 0.0, 0.0, 0.0));
        assert!(watch.arm(0.0, 100.0, 0.0, f64::NAN, 10.0));
        assert_eq!(watch.idle_ms(), 0.0);
        assert_eq!(watch.deadline_at(), Some(110.0));
    }
}
