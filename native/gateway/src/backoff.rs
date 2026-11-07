//! Supervision backoff, exactly as `docs/gateway.md` §7 states it: crashes go
//! 0.5s → 1 → 2 → 4 → 8 → 16 → 30s, a 60-second healthy run clears the ladder,
//! and exit code 75 (internal-port collision) asks for a 0.2s retry without
//! touching the ladder.

use std::time::Duration;

pub const CRASH_DELAYS_MS: [u64; 7] = [500, 1000, 2000, 4000, 8000, 16000, 30000];
pub const EXIT_75_DELAY_MS: u64 = 200;
pub const HEALTHY_AFTER: Duration = Duration::from_secs(60);

pub struct RestartPolicy {
    index: usize,
    scale: f64,
}

impl RestartPolicy {
    /// `scale` is the test hook (`MULTICC_GATEWAY_BACKOFF_SCALE`); a broken
    /// value falls back to 1 so a typo cannot turn restarts into a busy loop.
    pub fn new(scale: f64) -> Self {
        let scale = if scale.is_finite() && scale >= 0.0 {
            scale.min(1000.0)
        } else {
            1.0
        };
        Self { index: 0, scale }
    }

    /// How long to wait before the next spawn.
    pub fn next_delay(&mut self, exit_code: Option<i32>, ran_for: Duration) -> Duration {
        if exit_code == Some(75) {
            return scaled(EXIT_75_DELAY_MS, self.scale);
        }
        if ran_for >= HEALTHY_AFTER {
            self.index = 0;
        }
        let delay = CRASH_DELAYS_MS[self.index.min(CRASH_DELAYS_MS.len() - 1)];
        self.index = (self.index + 1).min(CRASH_DELAYS_MS.len() - 1);
        scaled(delay, self.scale)
    }
}

fn scaled(milliseconds: u64, scale: f64) -> Duration {
    Duration::from_secs_f64(milliseconds as f64 * scale / 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crashes_climb_the_ladder_and_stop_at_thirty_seconds() {
        let mut policy = RestartPolicy::new(1.0);
        let delays: Vec<u64> = (0..10)
            .map(|_| policy.next_delay(Some(1), Duration::ZERO).as_millis() as u64)
            .collect();
        assert_eq!(
            delays,
            vec![500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]
        );
    }

    #[test]
    fn a_healthy_run_clears_the_ladder() {
        let mut policy = RestartPolicy::new(1.0);
        assert_eq!(policy.next_delay(Some(1), Duration::ZERO).as_millis(), 500);
        assert_eq!(policy.next_delay(Some(1), Duration::ZERO).as_millis(), 1000);
        assert_eq!(
            policy
                .next_delay(Some(1), Duration::from_secs(61))
                .as_millis(),
            500
        );
    }

    #[test]
    fn exit_75_uses_a_fast_retry_and_leaves_the_ladder_alone() {
        let mut policy = RestartPolicy::new(0.1);
        assert_eq!(policy.next_delay(Some(75), Duration::ZERO).as_millis(), 20);
        assert_eq!(policy.next_delay(Some(75), Duration::ZERO).as_millis(), 20);
        assert_eq!(policy.next_delay(Some(1), Duration::ZERO).as_millis(), 50);
    }
}
