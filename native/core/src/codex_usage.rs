//! Billable Codex vectors. Reasoning is a subset of output, not an extra bucket.
use sha2::{Digest, Sha256};
#[derive(Clone, Copy, Default)]
pub struct Vector {
    pub fresh: f64,
    pub cached: f64,
    pub write: f64,
    pub output: f64,
    pub reasoning: f64,
}
impl Vector {
    pub fn delta(self, previous: Self) -> Option<Self> {
        if self.fresh < previous.fresh
            || self.cached < previous.cached
            || self.write < previous.write
            || self.output < previous.output
        {
            return None;
        }
        Some(Self {
            fresh: self.fresh - previous.fresh,
            cached: self.cached - previous.cached,
            write: self.write - previous.write,
            output: self.output - previous.output,
            reasoning: (self.reasoning - previous.reasoning).max(0.),
        })
    }
    pub fn total(self) -> f64 {
        self.fresh + self.cached + self.output
    }
}
pub fn epoch(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))[..24].into()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reasoning_regression_is_not_a_billable_regression() {
        let before = Vector {
            fresh: 10.,
            cached: 20.,
            output: 5.,
            reasoning: 4.,
            ..Vector::default()
        };
        let now = Vector {
            fresh: 11.,
            cached: 22.,
            output: 6.,
            reasoning: 1.,
            ..Vector::default()
        };
        let delta = now.delta(before).expect("monotonic billable counts");
        assert_eq!(delta.reasoning, 0.);
        assert_eq!(delta.total(), 4.);
        assert!(before.delta(now).is_none());
    }
    #[test]
    fn totals_do_not_saturate_each_safe_component() {
        let value = Vector {
            fresh: 9_007_199_254_740_991.,
            cached: 2.,
            ..Vector::default()
        };
        assert!(value.total() > 9_007_199_254_740_991.);
        assert_eq!(epoch(b"thread").len(), 24);
    }
}
