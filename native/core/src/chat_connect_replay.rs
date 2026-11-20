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

/// Whether the task-state seed is consulted at all.
///
/// Callers must ask this before resolving one: the seed's short code is minted
/// into a persisted registry on first use, and the retired code only reached
/// that call inside the history-frame branch. Resolving it unconditionally
/// would mint a code for a connect that never sent the frame.
pub fn needs_task_state_seed(facts: &Facts) -> bool {
    facts.replay_messages > 0 || facts.has_token_usage
}

/// The ordered plan for one connect.
pub fn plan(facts: &Facts) -> Vec<Step> {
    let mut steps = Vec::new();
    // `if (replayMessages.length > 0 || sessionTokenUsage)` — a session with
    // no replayable messages but a usage summary still gets the frame. Shared
    // with `needs_task_state_seed` so a caller's "should I resolve the seed"
    // question cannot drift from the branch that consumes it.
    if needs_task_state_seed(facts) {
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

// ── JSON bridge ────────────────────────────────────────────────────────────
//
// Added when the kernel was finally wired into the Node connect path. Until
// then it had a corpus test and no caller at all, so the turn engine still ran
// the inline sequence this kernel was written to replace.

/// `{ replayMessages, lastMessageIsAssistant, isStreaming, bufferedEvents,
/// hasTokenUsage, hasTaskStateSeed }` in, the ordered steps out. Without an
/// explicit seed result, the step asks the host to resolve it after history.
pub fn plan_json(input: &str) -> Result<String, String> {
    let value: serde_json::Value = crate::json_lenient::from_str(input)
        .map_err(|e| format!("chat_connect_replay_invalid_input: {e}"))?;
    let facts = Facts {
        replay_messages: count(&value["replayMessages"]),
        last_message_is_assistant: value["lastMessageIsAssistant"].as_bool().unwrap_or(false),
        is_streaming: value["isStreaming"].as_bool().unwrap_or(false),
        buffered_events: count(&value["bufferedEvents"]),
        has_token_usage: value["hasTokenUsage"].as_bool().unwrap_or(false),
        has_task_state_seed: value["hasTaskStateSeed"].as_bool().unwrap_or(true),
    };
    let plan = plan(&facts);
    let steps: Vec<serde_json::Value> = plan.iter().map(step_json).collect();
    Ok(serde_json::json!({
        "steps": steps,
        "bufferAfter": buffer_after(&facts, &plan),
        "needsTaskStateSeed": needs_task_state_seed(&facts),
    })
    .to_string())
}

/// A count the caller measured. A negative or non-numeric value is 0, which is
/// what `length` could never be anyway.
fn count(value: &serde_json::Value) -> usize {
    value
        .as_f64()
        .filter(|number| number.is_finite() && *number > 0.0)
        .map_or(0, |number| number as usize)
}

fn step_json(step: &Step) -> serde_json::Value {
    match step {
        Step::ChatHistory => serde_json::json!({ "op": "chatHistory" }),
        Step::TaskStateSeed => serde_json::json!({ "op": "taskStateSeed" }),
        Step::ClearBuffer => serde_json::json!({ "op": "clearBuffer" }),
        Step::ReplayBurst { frames } => {
            serde_json::json!({ "op": "replayBurst", "frames": frames })
        }
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
    /// The predicate callers use to decide whether to resolve the (minting)
    /// seed must agree with the branch that actually emits it, over the whole
    /// frozen corpus. If it ever says no while the plan emits a seed, a
    /// connect loses its classify bar; if it says yes while the plan cannot,
    /// a short code is minted for a frame nobody received.
    #[test]
    fn needs_task_state_seed_matches_the_branch_that_emits_it() {
        let text = std::fs::read_to_string(GOLDEN).expect("connect replay corpus");
        let corpus: serde_json::Value = serde_json::from_str(&text).expect("corpus json");
        for case in corpus["cases"].as_array().expect("cases array") {
            let f = &case["facts"];
            let mut facts = Facts {
                replay_messages: f["replayMessages"].as_u64().unwrap() as usize,
                last_message_is_assistant: f["lastMessageIsAssistant"].as_bool().unwrap(),
                is_streaming: f["isStreaming"].as_bool().unwrap(),
                buffered_events: f["bufferedEvents"].as_u64().unwrap() as usize,
                has_token_usage: f["hasTokenUsage"].as_bool().unwrap(),
                has_task_state_seed: f["hasTaskStateSeed"].as_bool().unwrap(),
            };
            // With a seed available, the plan emits one exactly when the
            // predicate allows it to be resolved.
            facts.has_task_state_seed = true;
            assert_eq!(
                plan(&facts).contains(&Step::TaskStateSeed),
                needs_task_state_seed(&facts),
                "{case}"
            );
            // Without one, the predicate's answer must not change: it is about
            // whether the seed is consulted, not whether it exists.
            let available = needs_task_state_seed(&facts);
            facts.has_task_state_seed = false;
            assert_eq!(needs_task_state_seed(&facts), available, "{case}");
            assert!(!plan(&facts).contains(&Step::TaskStateSeed), "{case}");
        }
    }

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

    /// The turn engine never calls `plan()`: it sends the JSON facts through
    /// `plan_json` and acts on the steps that
    /// come back. This drives the same frozen corpus through exactly that
    /// bridge, so a key misread, a step renamed on the wire or a `bufferAfter`
    /// that stopped agreeing with the plan is caught where production would
    /// hit it, not only in the pure kernel.
    #[test]
    fn the_production_bridge_matches_the_frozen_node_implementation() {
        let text = std::fs::read_to_string(GOLDEN).expect("connect replay corpus");
        let corpus: serde_json::Value = serde_json::from_str(&text).expect("corpus json");
        let cases = corpus["cases"].as_array().expect("cases array");
        assert_eq!(cases.len(), 144, "the corpus must stay exhaustive");
        for (index, case) in cases.iter().enumerate() {
            let facts = &case["facts"];
            let wire: serde_json::Value =
                serde_json::from_str(&plan_json(&facts.to_string()).expect("plan bridge"))
                    .expect("plan json");
            // The wire names steps `chatHistory`; the corpus snake_cases them.
            let steps: Vec<serde_json::Value> = wire["steps"]
                .as_array()
                .expect("steps")
                .iter()
                .map(|step| match step["op"].as_str().expect("op") {
                    "chatHistory" => serde_json::json!({"type": "chat_history"}),
                    "taskStateSeed" => serde_json::json!({"type": "task_state_seed"}),
                    "clearBuffer" => serde_json::json!({"type": "clear_buffer"}),
                    "replayBurst" => {
                        serde_json::json!({"type": "replay_burst", "frames": step["frames"]})
                    }
                    other => panic!("case {index}: unknown op {other}"),
                })
                .collect();
            assert_eq!(
                serde_json::Value::Array(steps),
                case["steps"],
                "case {index}: bridge steps diverged for {facts}"
            );
            assert_eq!(
                wire["bufferAfter"], case["bufferAfter"],
                "case {index}: bridge bufferAfter diverged for {facts}"
            );
            // The seed is resolved (and a short code minted) only when the
            // bridge says so; it must agree with the frame the plan emits.
            let history_sent = case["steps"]
                .as_array()
                .unwrap()
                .iter()
                .any(|step| step["type"] == "chat_history");
            assert_eq!(
                wire["needsTaskStateSeed"], history_sent,
                "case {index}: the seed must be consulted exactly when a history frame is sent: {facts}"
            );
            let mut pending_seed = facts.clone();
            pending_seed
                .as_object_mut()
                .unwrap()
                .remove("hasTaskStateSeed");
            let pending: serde_json::Value =
                serde_json::from_str(&plan_json(&pending_seed.to_string()).unwrap()).unwrap();
            let ops = pending["steps"].as_array().unwrap();
            if history_sent {
                assert_eq!(ops[0]["op"], "chatHistory");
                assert_eq!(ops[1]["op"], "taskStateSeed");
            } else {
                assert!(ops.iter().all(|step| step["op"] != "taskStateSeed"));
            }
        }
        assert!(plan_json("not json").is_err());
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
