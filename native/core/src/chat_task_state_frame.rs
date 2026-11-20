//! The connect-time `task_state` frame: whether to seed the aux classify bar
//! at all, and the one wire contract every `task_state` producer shares.
//!
//! Two producers send this frame -- the connect seed and the live broadcast of
//! the task-state store -- and a page that reopens must see exactly what a
//! live page sees. They once drifted: the seed omitted `apiError`, so the
//! API-error bar existed only while the failing turn was on screen and
//! vanished on reload even though the envelope was persisted. The payload
//! therefore has one owner, here.
//!
//! Three inputs are facts rather than derivations, because the retired code
//! read them from outside the task record:
//!
//! * `taskShortCode(taskId)` reads, and can mint into, the persisted code
//!   registry, so the already-resolved code is passed in.
//! * `auxVerdictStaleness()` reads live Aux health. Its two fields were spread
//!   LAST in the retired object literal, so a task record carrying its own
//!   `auxUnhealthy` could not win over the live reading -- reproduced here by
//!   writing them from the facts unconditionally.
//! * The goal-state vocabulary is `classify_vocab`'s, shared rather than
//!   re-spelled.
//!
//! Two details decide the contract:
//!
//! * The seed gate counts a persisted API error as a judgement worth showing.
//!   An unattributed session whose last turn failed must still seed, or the
//!   reopened page loses the API-error bar. Phase `idle` is not a judgement;
//!   any other phase is.
//! * `cancelReason` is gated on `cancelledAt`, not on itself, so a reason with
//!   no timestamp cannot outlive its cancellation.
use crate::js::{
    coerce::truthy_opt as truthy,
    json::{json_parse, json_stringify},
    JsString, JsValue,
};

/// The live readings the frame carries but does not derive.
#[derive(Clone, Debug, Default)]
pub struct Facts {
    /// `taskShortCode(task.taskId)`: the display handle, empty until Aux has
    /// attributed a task.
    pub task_short_code: String,
    pub aux_unhealthy: bool,
    /// `health.sinceAt || null`, passed through as the host produced it. In
    /// production that is `Date.now()` -- a NUMBER -- and the retired payload
    /// echoed it untouched, so this is a value, not a string: narrowing it to
    /// text would silently turn every unhealthy reading into `null`.
    pub aux_unhealthy_since: Option<JsValue>,
}

fn property<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(entries) => entries
            .iter()
            .find(|(key, _)| key.to_string_lossy() == name)
            .map(|(_, child)| child),
        _ => None,
    }
}

/// `a || b`: the left operand when truthy, otherwise the right.
fn or_else(value: Option<&JsValue>, fallback: JsValue) -> JsValue {
    if truthy(value) {
        value.cloned().unwrap_or(fallback)
    } else {
        fallback
    }
}

/// `!task || !(task.goal || (task.phase && task.phase !== 'idle') || task.apiError)`
/// -- inverted, so this answers "is there a judgement worth showing".
pub fn seeds(task: Option<&JsValue>) -> bool {
    let Some(task) = task else { return false };
    if !truthy(Some(task)) {
        return false;
    }
    let phase = property(task, "phase");
    let phase_is_a_judgement = truthy(phase)
        && phase
            .and_then(|value| match value {
                JsValue::String(text) => Some(text.to_string_lossy()),
                _ => None,
            })
            .is_none_or(|text| text != "idle");
    truthy(property(task, "goal")) || phase_is_a_judgement || truthy(property(task, "apiError"))
}

/// `taskStatePayload`: the frame every producer sends.
pub fn payload(task: Option<&JsValue>, facts: &Facts) -> JsValue {
    let empty = JsValue::Object(Vec::new());
    // `const next = task || {}`.
    let next = match task {
        Some(value) if truthy(Some(value)) => value,
        _ => &empty,
    };
    let goal_state = property(next, "goalState");
    let cancelled_at = property(next, "cancelledAt");
    let entries = vec![
        (
            JsString::from_rust_str("type"),
            JsValue::String(JsString::from_rust_str("task_state")),
        ),
        (
            JsString::from_rust_str("goal"),
            or_else(
                property(next, "goal"),
                JsValue::String(JsString::from_rust_str("")),
            ),
        ),
        (
            JsString::from_rust_str("taskShortCode"),
            JsValue::String(JsString::from_rust_str(&facts.task_short_code)),
        ),
        (
            JsString::from_rust_str("phase"),
            or_else(
                property(next, "phase"),
                JsValue::String(JsString::from_rust_str("idle")),
            ),
        ),
        (
            JsString::from_rust_str("classifyState"),
            or_else(property(next, "classifyState"), JsValue::Null),
        ),
        (
            JsString::from_rust_str("goalState"),
            // The vocabulary gate is an identity test, not truthiness: an
            // unknown sub-state is dropped rather than echoed to the page.
            if goal_state
                .and_then(|value| match value {
                    JsValue::String(text) => Some(text.to_string_lossy()),
                    _ => None,
                })
                .is_some_and(|text| crate::classify_vocab::is_goal_state(&text))
            {
                goal_state.cloned().unwrap_or(JsValue::Null)
            } else {
                JsValue::Null
            },
        ),
        (
            JsString::from_rust_str("apiError"),
            or_else(property(next, "apiError"), JsValue::Null),
        ),
        (
            JsString::from_rust_str("cancelledAt"),
            or_else(cancelled_at, JsValue::Null),
        ),
        (
            JsString::from_rust_str("cancelReason"),
            if truthy(cancelled_at) {
                or_else(property(next, "cancelReason"), JsValue::Null)
            } else {
                JsValue::Null
            },
        ),
        // Spread last in the retired literal: the live reading always wins.
        (
            JsString::from_rust_str("auxUnhealthy"),
            JsValue::Bool(facts.aux_unhealthy),
        ),
        (
            JsString::from_rust_str("auxUnhealthySince"),
            match (facts.aux_unhealthy, facts.aux_unhealthy_since.as_ref()) {
                (true, Some(since)) => since.clone(),
                _ => JsValue::Null,
            },
        ),
    ];
    JsValue::Object(entries)
}

/// `taskStateSeed`: the payload, or nothing when the session has no judgement.
pub fn seed(task: Option<&JsValue>, facts: &Facts) -> Option<JsValue> {
    if !seeds(task) {
        return None;
    }
    Some(payload(task, facts))
}

// ── JSON bridge ────────────────────────────────────────────────────────────

fn facts_from(value: &JsValue) -> Facts {
    Facts {
        task_short_code: property(value, "taskShortCode")
            .and_then(|value| match value {
                JsValue::String(text) => Some(text.to_string_lossy()),
                _ => None,
            })
            .unwrap_or_default(),
        aux_unhealthy: truthy(property(value, "auxUnhealthy")),
        // `sinceAt || null` is applied by the caller that reads the health
        // provider; what arrives here is that result, passed through as is.
        aux_unhealthy_since: property(value, "auxUnhealthySince").cloned(),
    }
}

/// Whether the host needs to resolve the live facts and build the payload.
pub fn should_seed_json(input: &str) -> Result<bool, String> {
    let value =
        json_parse(input).map_err(|e| format!("chat_task_state_frame_invalid_input: {e:?}"))?;
    let task = property(&value, "task");
    Ok(seeds(task))
}

/// The payload on its own, for the live broadcast that does not gate on a
/// judgement existing.
pub fn payload_json(input: &str) -> Result<String, String> {
    let value =
        json_parse(input).map_err(|e| format!("chat_task_state_frame_invalid_input: {e:?}"))?;
    let facts = facts_from(property(&value, "facts").unwrap_or(&JsValue::Undefined));
    let frame = payload(property(&value, "task"), &facts);
    json_stringify(&frame).ok_or_else(|| "chat_task_state_frame_unencodable".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Overridden by a mutation runner so a mutated copy still reads the
    /// frozen corpus.
    const CORPUS: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/rust-migration/differential/chat-task-state-frame-corpus.json"
    );

    fn corpus() -> JsValue {
        let text = std::fs::read_to_string(CORPUS).expect("task state corpus");
        json_parse(&text).expect("corpus json")
    }

    fn cases(corpus: &JsValue) -> Vec<JsValue> {
        match property(corpus, "cases") {
            Some(JsValue::Array(items)) => items.clone(),
            _ => panic!("cases array"),
        }
    }

    fn label(case: &JsValue) -> String {
        format!(
            "{} / {}",
            property(case, "sweep")
                .and_then(json_stringify)
                .unwrap_or_default(),
            property(case, "name")
                .and_then(json_stringify)
                .unwrap_or_default(),
        )
    }

    /// Every case in the frozen corpus, compared against the frozen Node
    /// transcription through the corpus its generator wrote. The seed gate,
    /// every field fallback, the vocabulary gate, the cancellation pair and
    /// the live health override are all decided here.
    #[test]
    fn the_task_state_frame_matches_the_frozen_node_implementation() {
        let corpus = corpus();
        let cases = cases(&corpus);
        assert_eq!(cases.len(), 678, "the corpus must stay exhaustive");
        for case in &cases {
            let label = label(case);
            let input = property(case, "input").expect("input");
            let facts = facts_from(property(input, "facts").unwrap_or(&JsValue::Undefined));
            let task = property(input, "task");
            let expected = property(case, "expected").expect("expected");

            assert_eq!(
                JsValue::Bool(seeds(task)),
                *property(expected, "seeds").expect("seeds"),
                "seeds: {label}"
            );
            let actual_seed = seed(task, &facts).unwrap_or(JsValue::Null);
            assert_eq!(
                json_stringify(&actual_seed),
                property(expected, "seed").and_then(json_stringify),
                "seed: {label}"
            );
            assert_eq!(
                json_stringify(&payload(task, &facts)),
                property(expected, "payload").and_then(json_stringify),
                "payload: {label}"
            );
        }
    }

    /// The seed is the payload or nothing -- never a third shape. A producer
    /// that invented its own reduced frame is how the API-error bar was lost
    /// on reload.
    #[test]
    fn the_seed_is_exactly_the_payload_when_it_fires() {
        let corpus = corpus();
        for case in &cases(&corpus) {
            let input = property(case, "input").expect("input");
            let facts = facts_from(property(input, "facts").unwrap_or(&JsValue::Undefined));
            let task = property(input, "task");
            match seed(task, &facts) {
                Some(frame) => assert_eq!(
                    json_stringify(&frame),
                    json_stringify(&payload(task, &facts)),
                    "{}",
                    label(case)
                ),
                None => assert!(!seeds(task), "{}", label(case)),
            }
        }
    }

    /// The field set is fixed and ordered: a page reads these keys, and a live
    /// broadcast must agree with a reopened page key for key.
    #[test]
    fn every_frame_carries_the_same_keys_in_the_same_order() {
        const KEYS: [&str; 11] = [
            "type",
            "goal",
            "taskShortCode",
            "phase",
            "classifyState",
            "goalState",
            "apiError",
            "cancelledAt",
            "cancelReason",
            "auxUnhealthy",
            "auxUnhealthySince",
        ];
        let corpus = corpus();
        for case in &cases(&corpus) {
            let input = property(case, "input").expect("input");
            let facts = facts_from(property(input, "facts").unwrap_or(&JsValue::Undefined));
            let frame = payload(property(input, "task"), &facts);
            let JsValue::Object(entries) = &frame else {
                panic!("payload must be an object: {}", label(case));
            };
            let actual: Vec<String> = entries
                .iter()
                .map(|(key, _)| key.to_string_lossy())
                .collect();
            assert_eq!(actual, KEYS, "{}", label(case));
        }
    }

    /// A persisted API error must seed on its own. This is the regression the
    /// shared payload exists for: without it a reopened page loses the
    /// API-error bar the envelope was kept for.
    #[test]
    fn an_api_error_alone_is_a_judgement_worth_seeding() {
        let task = json_parse(r#"{"apiError":{"code":"upstream"}}"#).unwrap();
        assert!(seeds(Some(&task)));
        let frame = seed(Some(&task), &Facts::default()).expect("seeded");
        assert_eq!(
            json_stringify(&frame).unwrap(),
            r#"{"type":"task_state","goal":"","taskShortCode":"","phase":"idle","classifyState":null,"goalState":null,"apiError":{"code":"upstream"},"cancelledAt":null,"cancelReason":null,"auxUnhealthy":false,"auxUnhealthySince":null}"#
        );
        // An idle session with nothing else to say does not seed at all.
        let idle = json_parse(r#"{"phase":"idle"}"#).unwrap();
        assert!(!seeds(Some(&idle)));
        assert!(seed(Some(&idle), &Facts::default()).is_none());
    }

    /// `health.sinceAt` is `Date.now()` in production: a number. The first
    /// version of this kernel accepted only a string and so would have turned
    /// every real unhealthy reading into `null` once wired in. Driven through
    /// the production bridge with the numeric form the host actually produces.
    #[test]
    fn a_numeric_unhealthy_since_survives_the_bridge() {
        let frame = payload_json(
            r#"{"task":{"goal":"g"},"facts":{"taskShortCode":"AB12","auxUnhealthy":true,"auxUnhealthySince":1763600000000}}"#,
        )
        .unwrap();
        assert!(
            frame.contains(r#""auxUnhealthy":true,"auxUnhealthySince":1763600000000"#),
            "{frame}"
        );
        // Healthy means no since, whatever the reading carried.
        let healthy = payload_json(
            r#"{"task":{"goal":"g"},"facts":{"auxUnhealthy":false,"auxUnhealthySince":1763600000000}}"#,
        )
        .unwrap();
        assert!(
            healthy.contains(r#""auxUnhealthy":false,"auxUnhealthySince":null"#),
            "{healthy}"
        );
    }

    #[test]
    fn the_json_bridge_round_trips_a_seed_and_a_refusal() {
        let input = r#"{"task":{"goal":"g"},"facts":{"taskShortCode":"AB12"}}"#;
        assert!(should_seed_json(input).unwrap());
        assert_eq!(
            payload_json(input).unwrap(),
            r#"{"type":"task_state","goal":"g","taskShortCode":"AB12","phase":"idle","classifyState":null,"goalState":null,"apiError":null,"cancelledAt":null,"cancelReason":null,"auxUnhealthy":false,"auxUnhealthySince":null}"#
        );
        assert!(!should_seed_json(r#"{"task":{"phase":"idle"}}"#).unwrap());
        assert!(!should_seed_json("{}").unwrap());
        // The live broadcast does not gate on a judgement existing.
        assert!(payload_json("{}").unwrap().contains(r#""phase":"idle""#));
        assert!(should_seed_json("not json").is_err());
    }
}
