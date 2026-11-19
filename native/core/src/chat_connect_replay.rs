//! What a reconnecting `/ws/chat` client is sent, in order.
//!
//! This is the decision half of the connect path in `src/chat/turn-engine.js`
//! (the `chat_history` / task-state seed / stream replay block). It is a
//! prerequisite for moving the `/ws/chat` upgrade termination to the Rust
//! front door: the front door can only own the socket once the "what does a
//! reconnecting client receive" rule stops living in the Node turn engine.
//!
//! The kernel is pure. It takes the facts the engine already has at connect
//! time and returns the ordered sends plus the one state mutation the old
//! code performed inline (clearing `streamReplay`). The caller owns the
//! sockets, the history read and the envelope encoding.
//!
//! Two rules here are load-bearing and easy to get wrong:
//!
//! * The in-progress assistant message may already be inside the history page
//!   that was just appended. Replaying the buffered stream events on top of it
//!   produces a second bubble on the client, so the buffer is dropped instead
//!   — and it is dropped by *clearing the session's buffer*, not merely by
//!   skipping the send, because the old code assigned `cs.streamReplay = []`.
//! * The replay burst must bypass the queue's message-count cap
//!   (`sendImmediate`). A burst of up to 500 frames through the normal path
//!   trips `queue_overflow` -> 1013 -> the client reconnects -> re-floods.
//!   The byte cap and the congestion timer still apply.

/// The facts the connect path reads before deciding what to send.
#[derive(Clone, Copy, Debug)]
pub struct Facts {
    /// `replayMessages.length`.
    pub replay_messages: usize,
    /// `replayMessages[last].role === 'assistant'`.
    ///
    /// Invariant: this can only be true when `replay_messages > 0`, because
    /// in the JavaScript it is read off `replayMessages[length - 1]` inside
    /// the `replayMessages.length > 0` guard. The kernel still spells that
    /// conjunct out below to keep the control flow identical to the frozen
    /// implementation, but a mutation that removes it is NOT observable
    /// through this type -- the corpus cannot express the illegal
    /// combination, so the mutation suite does not claim to cover it.
    pub last_message_is_assistant: bool,
    /// `cs.isStreaming`.
    pub is_streaming: bool,
    /// `cs.streamReplay.length`.
    pub buffered_events: usize,
    /// Whether a token-usage summary exists for this session.
    pub has_token_usage: bool,
    /// Whether `taskStateSeed(...)` produced a frame.
    pub has_task_state_seed: bool,
}

/// One thing the connect path does, in the order the JavaScript did it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// `sendWs(ws, { type: 'chat_history', ... })`.
    ChatHistory,
    /// The aux classify bar seed. Its construction can throw in the host; a
    /// throw was swallowed and did not stop the later steps.
    TaskStateSeed,
    /// `cs.streamReplay = []` — the session buffer is emptied, which also
    /// means no burst follows.
    ClearBuffer,
    /// One `sendImmediate` per buffered event, in buffer order.
    ReplayBurst { frames: usize },
}

/// The ordered plan for one connect.
pub fn plan(facts: &Facts) -> Vec<Step> {
    let mut steps = Vec::new();
    // `if (replayMessages.length > 0 || sessionTokenUsage)` — a session with
    // no replayable messages but a usage summary still gets the frame.
    if facts.replay_messages > 0 || facts.has_token_usage {
        steps.push(Step::ChatHistory);
        if facts.has_task_state_seed {
            steps.push(Step::TaskStateSeed);
        }
        // Only reachable with at least one message: the guard is nested.
        if facts.replay_messages > 0
            && facts.last_message_is_assistant
            && facts.is_streaming
            && facts.buffered_events > 0
        {
            steps.push(Step::ClearBuffer);
        }
    }
    // Re-read after the possible clear, exactly like the JavaScript, which
    // tested `cs.streamReplay.length` again on the next statement.
    let buffered = if steps.contains(&Step::ClearBuffer) {
        0
    } else {
        facts.buffered_events
    };
    if facts.is_streaming && buffered > 0 {
        steps.push(Step::ReplayBurst { frames: buffered });
    }
    steps
}

/// What the session's `streamReplay` holds once the plan has run.
pub fn buffer_after(facts: &Facts, steps: &[Step]) -> usize {
    if steps.contains(&Step::ClearBuffer) {
        0
    } else {
        facts.buffered_events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Overridden by a mutation runner so a mutated copy still reads the
    /// frozen corpus.
    const GOLDEN: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/rust-migration/differential/chat-connect-replay-golden.json"
    );

    /// Every reachable combination of the connect facts, compared against the
    /// frozen Node implementation (tests/helpers/legacy-chat-connect-replay.js)
    /// through the corpus its generator wrote. A step-order or buffer-length
    /// divergence fails here with the exact case.
    #[test]
    fn the_connect_plan_matches_the_frozen_node_implementation() {
        let text = std::fs::read_to_string(GOLDEN).expect("connect replay corpus");
        let corpus: serde_json::Value = serde_json::from_str(&text).expect("corpus json");
        let cases = corpus["cases"].as_array().expect("cases array");
        assert_eq!(cases.len(), 144, "the corpus must stay exhaustive");
        for (index, case) in cases.iter().enumerate() {
            let f = &case["facts"];
            let facts = Facts {
                replay_messages: f["replayMessages"].as_u64().unwrap() as usize,
                last_message_is_assistant: f["lastMessageIsAssistant"].as_bool().unwrap(),
                is_streaming: f["isStreaming"].as_bool().unwrap(),
                buffered_events: f["bufferedEvents"].as_u64().unwrap() as usize,
                has_token_usage: f["hasTokenUsage"].as_bool().unwrap(),
                has_task_state_seed: f["hasTaskStateSeed"].as_bool().unwrap(),
            };
            let steps = plan(&facts);
            let actual: Vec<serde_json::Value> = steps
                .iter()
                .map(|step| match step {
                    Step::ChatHistory => serde_json::json!({"type": "chat_history"}),
                    Step::TaskStateSeed => serde_json::json!({"type": "task_state_seed"}),
                    Step::ClearBuffer => serde_json::json!({"type": "clear_buffer"}),
                    Step::ReplayBurst { frames } => {
                        serde_json::json!({"type": "replay_burst", "frames": frames})
                    }
                })
                .collect();
            assert_eq!(
                serde_json::Value::Array(actual),
                case["steps"],
                "case {index}: step stream diverged for {f}"
            );
            assert_eq!(
                buffer_after(&facts, &steps) as u64,
                case["bufferAfter"].as_u64().unwrap(),
                "case {index}: the session buffer diverged for {f}"
            );
        }
    }

    fn facts() -> Facts {
        Facts {
            replay_messages: 0,
            last_message_is_assistant: false,
            is_streaming: false,
            buffered_events: 0,
            has_token_usage: false,
            has_task_state_seed: false,
        }
    }

    #[test]
    fn a_quiet_session_with_nothing_to_replay_sends_nothing() {
        assert_eq!(plan(&facts()), vec![]);
    }

    #[test]
    fn token_usage_alone_still_sends_the_history_frame() {
        let f = Facts {
            has_token_usage: true,
            ..facts()
        };
        assert_eq!(plan(&f), vec![Step::ChatHistory]);
    }

    #[test]
    fn an_in_progress_assistant_in_the_page_drops_the_buffer_instead_of_replaying() {
        let f = Facts {
            replay_messages: 3,
            last_message_is_assistant: true,
            is_streaming: true,
            buffered_events: 12,
            ..facts()
        };
        // No burst: the buffer is cleared, which is also what the session sees.
        assert_eq!(plan(&f), vec![Step::ChatHistory, Step::ClearBuffer]);
    }

    #[test]
    fn a_streaming_turn_not_yet_in_the_page_replays_every_buffered_frame() {
        let f = Facts {
            replay_messages: 3,
            last_message_is_assistant: false,
            is_streaming: true,
            buffered_events: 12,
            ..facts()
        };
        assert_eq!(
            plan(&f),
            vec![Step::ChatHistory, Step::ReplayBurst { frames: 12 }]
        );
    }

    #[test]
    fn a_buffer_left_by_a_finished_turn_is_never_replayed() {
        // `cs.isStreaming` is the only gate on the burst; a stale buffer from
        // a turn that already ended stays put.
        let f = Facts {
            replay_messages: 2,
            last_message_is_assistant: true,
            is_streaming: false,
            buffered_events: 7,
            ..facts()
        };
        assert_eq!(plan(&f), vec![Step::ChatHistory]);
    }

    #[test]
    fn the_task_state_seed_sits_between_the_history_and_the_burst() {
        let f = Facts {
            replay_messages: 1,
            last_message_is_assistant: false,
            is_streaming: true,
            buffered_events: 2,
            has_task_state_seed: true,
            ..facts()
        };
        assert_eq!(
            plan(&f),
            vec![
                Step::ChatHistory,
                Step::TaskStateSeed,
                Step::ReplayBurst { frames: 2 }
            ]
        );
    }

    #[test]
    fn a_burst_with_no_history_frame_is_possible() {
        // No messages and no usage: the history block is skipped entirely, but
        // a live stream still catches the client up.
        let f = Facts {
            is_streaming: true,
            buffered_events: 4,
            ..facts()
        };
        assert_eq!(plan(&f), vec![Step::ReplayBurst { frames: 4 }]);
    }
}
