//! Decision policy for a short-lived restart supervisor.
//!
//! The process and transport adapters must supply verified observations. In
//! particular, a listening socket alone is never evidence of a new instance.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchMode {
    SourceForeground,
    Background,
    Standalone,
    Desktop,
}

impl LaunchMode {
    fn externally_supervised(self) -> bool {
        matches!(
            self,
            Self::SourceForeground | Self::Standalone | Self::Desktop
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    OldInstanceTimeout,
    PortOccupied,
    LaunchAttemptsExhausted,
    ReadinessTimeout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    WaitingForOldExit,
    Launch { attempt: u8 },
    WaitingForReady { attempt: u8 },
    Ready,
    Failed(Failure),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    OldExited,
    OldExitTimeout,
    LaunchStarted,
    LaunchFailed,
    /// The process that this attempt started has been verified to have exited.
    StartedProcessExited,
    /// The responding service is ready and has a verified new identity.
    VerifiedNewInstanceReady,
    /// The port belongs to a process that is not the intended new instance.
    PortOccupied,
    ReadinessTimeout,
}

#[derive(Debug)]
pub struct Supervisor {
    mode: LaunchMode,
    max_attempts: u8,
    state: State,
}

impl Supervisor {
    pub fn new(mode: LaunchMode, max_attempts: u8) -> Option<Self> {
        (max_attempts > 0).then_some(Self {
            mode,
            max_attempts,
            state: State::WaitingForOldExit,
        })
    }

    pub fn state(&self) -> State {
        self.state
    }

    /// Invalid or out-of-order observations are ignored; terminal states cannot
    /// be reopened by a late probe or a stale child exit notification.
    pub fn observe(&mut self, event: Event) -> State {
        use Event::*;
        use State::*;
        self.state = match (self.state, event) {
            (WaitingForOldExit, OldExited) if self.mode.externally_supervised() => {
                WaitingForReady { attempt: 0 }
            }
            (WaitingForOldExit, OldExited) => Launch { attempt: 1 },
            (WaitingForOldExit, OldExitTimeout) => Failed(Failure::OldInstanceTimeout),
            (Launch { attempt }, LaunchStarted) => WaitingForReady { attempt },
            (Launch { attempt }, LaunchFailed)
            | (WaitingForReady { attempt }, StartedProcessExited)
                if !self.mode.externally_supervised() && attempt < self.max_attempts =>
            {
                Launch {
                    attempt: attempt + 1,
                }
            }
            (Launch { .. }, LaunchFailed) | (WaitingForReady { .. }, StartedProcessExited)
                if !self.mode.externally_supervised() =>
            {
                Failed(Failure::LaunchAttemptsExhausted)
            }
            (WaitingForReady { .. }, VerifiedNewInstanceReady) => Ready,
            (WaitingForReady { .. } | Launch { .. }, PortOccupied) => Failed(Failure::PortOccupied),
            (WaitingForReady { .. }, ReadinessTimeout) => Failed(Failure::ReadinessTimeout),
            (state, _) => state,
        };
        self.state
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_waits_for_old_exit_and_verified_new_readiness() {
        let mut s = Supervisor::new(LaunchMode::Background, 2).unwrap();
        assert_eq!(
            s.observe(Event::VerifiedNewInstanceReady),
            State::WaitingForOldExit
        );
        assert_eq!(s.observe(Event::OldExited), State::Launch { attempt: 1 });
        assert_eq!(
            s.observe(Event::LaunchStarted),
            State::WaitingForReady { attempt: 1 }
        );
        assert_eq!(s.observe(Event::VerifiedNewInstanceReady), State::Ready);
        assert_eq!(s.observe(Event::PortOccupied), State::Ready);
    }

    #[test]
    fn retries_only_after_confirmed_exit_and_stops_at_limit() {
        let mut s = Supervisor::new(LaunchMode::Background, 2).unwrap();
        s.observe(Event::OldExited);
        s.observe(Event::LaunchStarted);
        assert_eq!(
            s.observe(Event::StartedProcessExited),
            State::Launch { attempt: 2 }
        );
        assert_eq!(
            s.observe(Event::LaunchFailed),
            State::Failed(Failure::LaunchAttemptsExhausted)
        );
    }

    #[test]
    fn timeout_with_unknown_process_state_does_not_launch_a_duplicate() {
        let mut s = Supervisor::new(LaunchMode::Background, 3).unwrap();
        s.observe(Event::OldExited);
        s.observe(Event::LaunchStarted);
        assert_eq!(
            s.observe(Event::ReadinessTimeout),
            State::Failed(Failure::ReadinessTimeout)
        );
        assert_eq!(
            s.observe(Event::StartedProcessExited),
            State::Failed(Failure::ReadinessTimeout)
        );
    }

    #[test]
    fn external_supervisors_are_never_competed_with() {
        for mode in [
            LaunchMode::SourceForeground,
            LaunchMode::Standalone,
            LaunchMode::Desktop,
        ] {
            let mut s = Supervisor::new(mode, 3).unwrap();
            assert_eq!(
                s.observe(Event::OldExited),
                State::WaitingForReady { attempt: 0 }
            );
            assert_eq!(
                s.observe(Event::StartedProcessExited),
                State::WaitingForReady { attempt: 0 }
            );
            assert_eq!(
                s.observe(Event::PortOccupied),
                State::Failed(Failure::PortOccupied)
            );
        }
    }

    #[test]
    fn old_process_timeout_never_launches_and_zero_attempts_are_invalid() {
        assert!(Supervisor::new(LaunchMode::Background, 0).is_none());
        let mut s = Supervisor::new(LaunchMode::Background, 1).unwrap();
        assert_eq!(
            s.observe(Event::OldExitTimeout),
            State::Failed(Failure::OldInstanceTimeout)
        );
        assert_eq!(
            s.observe(Event::OldExited),
            State::Failed(Failure::OldInstanceTimeout)
        );
    }
}
