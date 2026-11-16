//! "Is this chat session's runtime busy?" — the single rule, plus the active
//! turn counter that the board/Air snapshot reads.
//!
//! This is the only implementation. `src/session/runtime-busy.js` is a thin
//! port over the addon (`sessionChatStateBusy` / `sessionProcAlive`); every
//! server call site asks that port and no Node copy of the four-axis test
//! survives. The rule was extracted from the pre-migration
//! `isChatStateBusy(cs)` / `processAlive(proc)` in that file; the
//! pre-migration for-loop that counted active turns lived in `server.js`.
//!
//! A turn leaves up to four traces on a chat state, and subsystems historically
//! each read a different subset — so the same session got different answers at
//! different call sites:
//!
//! - `isStreaming` — admission sets it when it accepts a turn (all lanes); a
//!   structured finalize or `stopRunner()` clears it.
//! - `claudeProc` — the legacy per-turn child process handle; lives until the
//!   process is reaped.
//! - `_cancelledProc` — a signalled child not reaped yet. `stopRunner()`
//!   detaches `claudeProc` at signal time, so "not really dead yet" is only
//!   visible here.
//! - `_activeRunner` — the turn's ownership record. It outlives `isStreaming`:
//!   `stopRunner()` clears `isStreaming` first and releases the runner only once
//!   the child really stopped (see the teardown path in
//!   `chat/finalize-host.js`). Reading only `isStreaming` calls the session idle
//!   during that window.
//!
//! Missing one axis is a different answer: session-git's `isWorktreeActive()`
//! once gave two answers for the same session — reading `_activeRunner` when it
//! looked at a group member, not reading it when asked by id.
//!
//! Deliberately NOT here (callers stack these themselves; they answer a
//! different question):
//!
//! - `chatStream.status(id).busy` / `.queued` — the resident stream pump;
//! - background-task liveness / session WS client count (`clients.size` is "is
//!   anyone watching", not "is anything running");
//! - classify semantics.
//!
//! Narrower call sites that ask a different question keep their own test:
//! `session-work/host.js`'s `runnerStopped()` (a cancelled resident turn holds
//! `_activeRunner` until cancel completes — widening hangs the stop wait), the
//! host-lifecycle shutdown drain, `liveness/runtime.js`'s `processHandleAlive()`
//! (also requires `killed !== true`), `session-work/host.js`'s
//! `answerUserInput`, the classify P branch, `chat/stalled-turn-recovery.js`'s
//! `inFlight`, trigger deferral, and the `chat/background-task-runtime.js`
//! `isStreaming` reads.

/// One child-process handle, as observed by the host. Node writes
/// `exitCode`/`signalCode` only after the child is reaped; there is no
/// `kill(pid, 0)` probe on purpose (pid reuse would look like a fake "still
/// alive" that can never clear).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcObservation {
    /// `proc` itself is present.
    pub present: bool,
    /// `proc.exitCode !== null && proc.exitCode !== undefined` — `0` counts.
    pub exit_code_set: bool,
    /// `proc.signalCode` is truthy (an empty string does not count).
    pub signal_code_set: bool,
}

/// `processAlive(proc)`:
/// `!present → false`; `exitCode` set → false; `signalCode` truthy → false;
/// otherwise true.
pub fn process_alive(obs: &ProcObservation) -> bool {
    if !obs.present {
        return false;
    }
    if obs.exit_code_set {
        return false;
    }
    if obs.signal_code_set {
        return false;
    }
    true
}

/// The four traces a turn leaves on a chat state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChatBusyAxes {
    /// `cs.isStreaming === true` — strict true, not merely truthy.
    pub streaming: bool,
    pub claude_proc: ProcObservation,
    pub cancelled_proc: ProcObservation,
    /// `!!cs._activeRunner`.
    pub active_runner: bool,
}

/// The order matches the legacy predicate: streaming, `claudeProc`,
/// `_cancelledProc`, then `_activeRunner`.
pub fn chat_state_busy(axes: &ChatBusyAxes) -> bool {
    if axes.streaming {
        return true;
    }
    if process_alive(&axes.claude_proc) {
        return true;
    }
    if process_alive(&axes.cancelled_proc) {
        return true;
    }
    axes.active_runner
}

/// Active-turn counter. The caller walks the table in order, feeding each row:
/// when the chat state is busy the counter short-circuits and the stream probe
/// is not asked at all.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ActiveTurnTally {
    turns: u32,
}

impl ActiveTurnTally {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the caller must ask whether the stream pump is busy for this
    /// row — only when the chat state itself is not busy.
    pub fn needs_stream_probe(chat_busy: bool) -> bool {
        !chat_busy
    }

    /// Record one row's verdict (`chat_busy || stream busy === true`).
    pub fn observe(&mut self, busy: bool) {
        if busy {
            self.turns = self.turns.saturating_add(1);
        }
    }

    pub fn count(&self) -> u32 {
        self.turns
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dead() -> ProcObservation {
        ProcObservation {
            present: false,
            exit_code_set: false,
            signal_code_set: false,
        }
    }

    fn live() -> ProcObservation {
        ProcObservation {
            present: true,
            exit_code_set: false,
            signal_code_set: false,
        }
    }

    fn idle_axes() -> ChatBusyAxes {
        ChatBusyAxes {
            streaming: false,
            claude_proc: dead(),
            cancelled_proc: dead(),
            active_runner: false,
        }
    }

    #[test]
    fn absent_handle_is_not_alive() {
        assert!(!process_alive(&dead()));
    }

    #[test]
    fn zero_exit_code_counts_as_reaped() {
        // The legacy test was `exitCode !== null && exitCode !== undefined`, so
        // exitCode === 0 means the child exited.
        let obs = ProcObservation {
            present: true,
            exit_code_set: true,
            signal_code_set: false,
        };
        assert!(!process_alive(&obs));
    }

    #[test]
    fn null_exit_and_signal_is_alive() {
        assert!(process_alive(&live()));
    }

    #[test]
    fn non_empty_signal_code_is_reaped() {
        let obs = ProcObservation {
            present: true,
            exit_code_set: false,
            signal_code_set: true,
        };
        assert!(!process_alive(&obs));
    }

    #[test]
    fn each_axis_alone_is_busy() {
        assert!(chat_state_busy(&ChatBusyAxes {
            streaming: true,
            ..idle_axes()
        }));
        assert!(chat_state_busy(&ChatBusyAxes {
            claude_proc: live(),
            ..idle_axes()
        }));
        assert!(chat_state_busy(&ChatBusyAxes {
            cancelled_proc: live(),
            ..idle_axes()
        }));
        assert!(chat_state_busy(&ChatBusyAxes {
            active_runner: true,
            ..idle_axes()
        }));
    }

    #[test]
    fn no_axis_is_idle() {
        assert!(!chat_state_busy(&idle_axes()));
        // A reaped claudeProc and a signalled cancelledProc are both dead.
        assert!(!chat_state_busy(&ChatBusyAxes {
            streaming: false,
            claude_proc: ProcObservation {
                present: true,
                exit_code_set: true,
                signal_code_set: false,
            },
            cancelled_proc: ProcObservation {
                present: true,
                exit_code_set: false,
                signal_code_set: true,
            },
            active_runner: false,
        }));
    }

    #[test]
    fn tally_counts_and_short_circuits() {
        let mut tally = ActiveTurnTally::new();
        assert_eq!(tally.count(), 0);
        // Busy chat state: no stream probe, straight to a count.
        assert!(!ActiveTurnTally::needs_stream_probe(true));
        tally.observe(true);
        // Idle chat state: the caller must ask the stream.
        assert!(ActiveTurnTally::needs_stream_probe(false));
        tally.observe(false);
        tally.observe(true);
        assert_eq!(tally.count(), 2);
    }
}
