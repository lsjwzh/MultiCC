//! Execute the finalization plan across the real history durability boundary.
//! The host supplies I/O and live session handles; it does not choose ordering,
//! retry conversion or which terminal effects may cross a failed usage write.
use crate::chat_finalize::{plan_retry_blocked_finalization, resolve_turn_finalization};
use crate::js::{truthy, JsValue};
use crate::quota_guard::prop;

pub trait FinalizationHost {
    type Error;
    fn error(&self, message: &str) -> Self::Error;
    fn nonterminal_plan(&mut self, action: &JsValue) -> Result<(), Self::Error>;
    fn use_plan(&mut self, plan: &JsValue, replaced: bool) -> Result<(), Self::Error>;
    fn result_durable(&mut self) -> Result<JsValue, Self::Error>;
    fn terminal_blocked(&mut self) -> Result<bool, Self::Error>;
    fn resolved_plan(&mut self, resolved: &JsValue) -> Result<(), Self::Error>;
    fn apply_effect(&mut self, index: usize, effect: &JsValue) -> Result<(), Self::Error>;
    fn persist_assistant(&mut self) -> Result<bool, Self::Error>;
    fn record_result(&mut self, resolved: &JsValue) -> Result<(), Self::Error>;
}

fn is_string(value: &JsValue, expected: &str) -> bool {
    matches!(value, JsValue::String(text) if text.as_str_lossy() == expected)
}

/// A failed usage commit blocks every classification, including cancellation
/// and errors: those can otherwise release scheduler work just like success.
pub fn blocks_terminal_effect(effect: &JsValue, blocked: bool) -> bool {
    if !blocked {
        return false;
    }
    let kind = prop(effect, "type");
    [
        "complete-session-turn",
        "freeze-interrupted",
        "classify-turn-end",
    ]
    .iter()
    .any(|name| is_string(kind, name))
        || (is_string(kind, "emit-turn-outcome") && is_string(prop(effect, "status"), "succeeded"))
}

fn effects<H: FinalizationHost>(plan: &JsValue, host: &H) -> Result<Vec<JsValue>, H::Error> {
    match prop(plan, "effects") {
        JsValue::Array(effects) => Ok(effects.clone()),
        _ => Err(host.error("finalization effects must be an array")),
    }
}

fn apply_all<H: FinalizationHost>(
    entries: &[JsValue],
    offset: usize,
    host: &mut H,
) -> Result<(), H::Error> {
    for (index, entry) in entries.iter().enumerate() {
        if !blocks_terminal_effect(entry, host.terminal_blocked()?) {
            host.apply_effect(offset + index, entry)?;
        }
    }
    Ok(())
}

fn boundary<H: FinalizationHost>(entries: &[JsValue], host: &H) -> Result<usize, H::Error> {
    entries
        .iter()
        .position(|entry| is_string(prop(entry, "type"), "append-assistant-result"))
        .ok_or_else(|| host.error("finalization append boundary missing"))
}

pub struct FinalizationResult {
    pub resolved: JsValue,
    pub append_persisted: bool,
}

/// First half of a finalization. A plan that needs no history append runs to
/// completion here. A plan that does stops immediately before the append
/// boundary and returns the effective plan so the host can perform the durable
/// write asynchronously; the caller then hands the verdict back to [`complete`].
/// Splitting at the boundary is what lets the host await an fsync without
/// re-ordering the effects before it (clear-incremental-save and friends).
pub enum Prepared {
    Completed(FinalizationResult),
    Pending {
        plan: JsValue,
        /// The plan as the caller supplied it. Failure containment reports the
        /// original facts, matching the pre-split single call.
        source: JsValue,
        resolved: JsValue,
    },
}

fn effective_plan<H: FinalizationHost>(
    source: &JsValue,
    host: &mut H,
) -> Result<(JsValue, bool), H::Error> {
    if !matches!(source, JsValue::Object(_)) {
        return Err(host.error("finalization plan must be an object"));
    }
    let action = prop(source, "action");
    let replaced = !is_string(action, "finalize") && !is_string(action, "noop");
    let plan = if replaced {
        host.nonterminal_plan(action)?;
        plan_retry_blocked_finalization(
            source,
            &JsValue::object(vec![(
                "retryUnavailableReason",
                JsValue::string("executor_received_nonterminal_plan"),
            )]),
        )
    } else {
        source.clone()
    };
    host.use_plan(&plan, replaced)?;
    Ok((plan, replaced))
}

/// Run every effect up to (not including) the append boundary. Returns the
/// effective plan and the preliminary resolution the host already published.
pub fn prepare<H: FinalizationHost>(source: &JsValue, host: &mut H) -> Result<Prepared, H::Error> {
    let (plan, _) = effective_plan(source, host)?;
    let required = truthy(prop(prop(&plan, "append"), "required"));
    let preliminary = resolve_turn_finalization(
        &plan,
        &JsValue::object(vec![("resultDurable", host.result_durable()?)]),
    );
    host.resolved_plan(&preliminary)?;
    let entries = effects(&preliminary, host)?;
    if !required {
        apply_all(&entries, 0, host)?;
        host.record_result(&preliminary)?;
        return Ok(Prepared::Completed(FinalizationResult {
            resolved: preliminary,
            append_persisted: false,
        }));
    }
    let at = boundary(&entries, host)?;
    apply_all(&entries[..at], 0, host)?;
    Ok(Prepared::Pending {
        plan,
        source: source.clone(),
        resolved: preliminary,
    })
}

/// Second half: the host has awaited the durable append and reports whether the
/// exact message became durable. Sample the live turn only now — neither the
/// plan nor a cached pre-write value proves it.
pub fn complete<H: FinalizationHost>(
    plan: &JsValue,
    host: &mut H,
    persisted: bool,
) -> Result<FinalizationResult, H::Error> {
    let resolved = resolve_turn_finalization(
        plan,
        &JsValue::object(vec![
            ("appendPersisted", JsValue::Bool(persisted)),
            ("resultDurable", host.result_durable()?),
        ]),
    );
    host.resolved_plan(&resolved)?;
    let entries = effects(&resolved, host)?;
    let at = boundary(&entries, host)?;
    apply_all(&entries[at + 1..], at + 1, host)?;
    host.record_result(&resolved)?;
    Ok(FinalizationResult {
        resolved,
        append_persisted: persisted,
    })
}

/// Synchronous convenience used by the core tests and by the legacy single-call
/// path where the host can answer the append verdict immediately. Production
/// uses [`prepare`] / [`complete`] across two NAPI calls.
pub fn execute<H: FinalizationHost>(
    source: &JsValue,
    host: &mut H,
) -> Result<FinalizationResult, H::Error> {
    match prepare(source, host)? {
        Prepared::Completed(result) => Ok(result),
        Prepared::Pending { plan, .. } => {
            let persisted = host.persist_assistant()?;
            complete(&plan, host, persisted)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_finalize::plan_turn_finalization;

    #[derive(Default)]
    struct Host {
        calls: Vec<String>,
        durable: bool,
        fail_append: bool,
        fail_usage: bool,
        blocked: bool,
        throw_append: bool,
    }
    impl FinalizationHost for Host {
        type Error = String;
        fn error(&self, message: &str) -> String {
            message.into()
        }
        fn nonterminal_plan(&mut self, _: &JsValue) -> Result<(), String> {
            self.calls.push("retry-blocked".into());
            Ok(())
        }
        fn use_plan(&mut self, _: &JsValue, _: bool) -> Result<(), String> {
            Ok(())
        }
        fn result_durable(&mut self) -> Result<JsValue, String> {
            Ok(JsValue::Bool(self.durable))
        }
        fn terminal_blocked(&mut self) -> Result<bool, String> {
            Ok(self.blocked)
        }
        fn resolved_plan(&mut self, _: &JsValue) -> Result<(), String> {
            Ok(())
        }
        fn apply_effect(&mut self, _: usize, effect: &JsValue) -> Result<(), String> {
            let name = match prop(effect, "type") {
                JsValue::String(name) => name.to_string_lossy(),
                _ => unreachable!(),
            };
            if name == "commit-usage" && self.durable && self.fail_usage {
                self.blocked = true;
            }
            self.calls.push(name);
            Ok(())
        }
        fn persist_assistant(&mut self) -> Result<bool, String> {
            self.calls.push("persist".into());
            if self.throw_append {
                return Err("disk unavailable".into());
            }
            self.durable = !self.fail_append;
            Ok(self.durable)
        }
        fn record_result(&mut self, _: &JsValue) -> Result<(), String> {
            self.calls.push("record".into());
            Ok(())
        }
    }
    fn plan(durable: bool) -> JsValue {
        plan_turn_finalization(
            &JsValue::object(vec![
                ("current", JsValue::Bool(true)),
                ("runnerKind", JsValue::string("process")),
                ("cli", JsValue::string("codex")),
                ("hasOutput", JsValue::Bool(true)),
                ("resultEvent", JsValue::Bool(true)),
                ("resultDurable", JsValue::Bool(durable)),
                (
                    "completion",
                    JsValue::object(vec![
                        ("version", JsValue::Number(1.0)),
                        ("state", JsValue::string("completed")),
                        ("settled", JsValue::Bool(true)),
                    ]),
                ),
            ]),
            &JsValue::object(Vec::<(&str, JsValue)>::new()),
            0.0,
        )
    }
    #[test]
    fn history_commit_precedes_usage_and_scheduler_completion() {
        let mut host = Host::default();
        let result = execute(&plan(false), &mut host).unwrap();
        assert!(result.append_persisted);
        let at = |name| host.calls.iter().position(|call| call == name).unwrap();
        assert!(at("clear-incremental-save") < at("persist"));
        assert!(at("persist") < at("commit-usage"));
        assert!(at("commit-usage") < at("complete-session-turn"));
        assert!(at("stream-end") < at("run-post-turn"));
        assert_eq!(host.calls.last().unwrap(), "record");
    }
    #[test]
    fn failed_history_never_completes_and_throw_stops_execution() {
        let mut host = Host {
            fail_append: true,
            ..Host::default()
        };
        assert!(!execute(&plan(false), &mut host).unwrap().append_persisted);
        assert!(!host.calls.contains(&"complete-session-turn".into()));
        let mut host = Host {
            throw_append: true,
            ..Host::default()
        };
        assert_eq!(
            execute(&plan(false), &mut host).err().unwrap(),
            "disk unavailable"
        );
        assert_eq!(host.calls.last().unwrap(), "persist");
    }
    #[test]
    fn usage_barrier_applies_to_both_append_and_already_durable_paths() {
        for durable in [false, true] {
            let mut host = Host {
                durable,
                fail_usage: true,
                ..Host::default()
            };
            execute(&plan(durable), &mut host).unwrap();
            assert!(host.blocked);
            assert_eq!(host.calls.contains(&"persist".into()), !durable);
            for effect in [
                "complete-session-turn",
                "classify-turn-end",
                "emit-turn-outcome",
            ] {
                assert!(!host.calls.contains(&effect.into()), "{effect}");
            }
            assert!(host.calls.contains(&"run-post-turn".into()));
        }
    }
}
