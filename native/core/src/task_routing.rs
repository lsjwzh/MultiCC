//! Task routing policy — the attribution mode ladder and the R2 attribution
//! eligibility gate, migrated verbatim from `src/task-routing/attribution-mode.js`
//! and `src/task-routing/eligibility.js`.
//!
//! Attribution mode: the classify verdict says what a turn *looks* like; the
//! mode says what the host may do about it (off / shadow / suggest / auto).
//!
//! Eligibility: a decision over trusted, correlated host observations — never a
//! filesystem lease or permission to mutate attribution. The apply transaction
//! must repeat the version checks while holding its guard.
//!
//! JS strict-equality semantics are kept exactly: a missing field is
//! `undefined` (distinct from `null`), `=== true/false/0` accept only that
//! exact JSON value, `text()` is a non-empty string, `version()` is a
//! non-negative safe integer, and blockers dedupe in first-seen order.
use serde_json::{json, Value};

pub const MODES: [&str; 4] = ["off", "shadow", "suggest", "auto"];
pub const DEFAULT_MODE: &str = "suggest";

// ── JS value helpers ────────────────────────────────────────────────────────

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `container?.key` — absent for non-objects and missing keys.
fn get<'a>(container: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    container
        .and_then(Value::as_object)
        .and_then(|object| object.get(key))
}

fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `typeof v === 'string' && v.length > 0`
fn text(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(s)) if !s.is_empty())
}

/// `Number.isSafeInteger(v) && v >= 0`
fn version(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(|f| {
        f.is_finite() && f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0 && f >= 0.0
    })
}

/// `text(left) && left === right`
fn same(left: Option<&Value>, right: Option<&Value>) -> bool {
    text(left) && left == right
}

fn is_true(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true)))
}

fn is_false(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(false)))
}

/// `v === 0` (JSON has no NaN; -0 serializes as 0).
fn is_zero(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Number(n)) if n.as_f64() == Some(0.0))
}

fn is_str(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

/// `===` between two numbers already known to be safe integers.
fn same_number(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left.and_then(Value::as_f64), right) {
        (Some(l), Some(Value::Number(r))) => r.as_f64() == Some(l),
        _ => false,
    }
}

// ── Attribution mode ladder ─────────────────────────────────────────────────

/// `normalizeAttributionMode` without the fallback: the matched mode, or None
/// (the JS bridge applies its caller-supplied fallback so its identity is kept).
pub fn normalize_mode(value: Option<&str>) -> Option<&'static str> {
    let mode = value
        .map(|v| v.trim_matches(is_js_whitespace).to_lowercase())
        .unwrap_or_default();
    MODES.iter().copied().find(|candidate| *candidate == mode)
}

fn non_empty_str(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `planAttributionAction({ mode, relation, targetTaskId, currentTaskId })`.
/// A verdict only wants a change when it declares a new task or names a
/// different existing one; auto still needs an address to apply.
pub fn plan_attribution_action(input: &Value) -> Value {
    let input = Some(input);
    let resolved =
        normalize_mode(get(input, "mode").and_then(Value::as_str)).unwrap_or(DEFAULT_MODE);
    let target = non_empty_str(get(input, "targetTaskId"));
    let current = non_empty_str(get(input, "currentTaskId"));
    let wants_change =
        is_str(get(input, "relation"), "new") || (target.is_some() && target != current);
    let plan = |action: &str, reason: &str, target: Option<&str>| json!({ "mode": resolved, "action": action, "reason": reason, "targetTaskId": target });
    if !wants_change {
        return plan("none", "no_change", None);
    }
    match resolved {
        "off" => plan("none", "mode_off", None),
        "shadow" => plan("record", "shadow", target),
        "suggest" => plan("suggest", "suggest", target),
        // Auto without an identity to promote stays a suggestion instead of
        // minting an unnamed task.
        _ if target.is_none() => plan("suggest", "target_unknown", None),
        _ => plan("apply", "auto", target),
    }
}

// ── R2 attribution eligibility ──────────────────────────────────────────────

/// `evaluateAttribution({ proposal, run, context, source, guard, integration,
/// baseline, noCode })`. A non-object input reads as `{}`.
pub fn evaluate_attribution(input: &Value) -> Value {
    let facts = Some(input);
    let proposal = get(facts, "proposal");
    let run = get(facts, "run");
    let context = get(facts, "context");
    let source = get(facts, "source");
    let guard = get(facts, "guard");
    let integration = get(facts, "integration");
    let baseline = get(facts, "baseline");
    let no_code = get(facts, "noCode");

    let mut blockers: Vec<&'static str> = Vec::new();
    let mut stale = false;
    let result = |state: &str, blockers: &[&'static str]| {
        let mut unique: Vec<&str> = Vec::new();
        for blocker in blockers {
            if !unique.contains(blocker) {
                unique.push(blocker);
            }
        }
        json!({ "state": state, "eligible": state == "ready", "blockers": unique, "requiresAtomicRecheck": true })
    };

    if !truthy(proposal) || !truthy(run) || !truthy(context) {
        blockers.push("facts_missing");
        return result("pending", &blockers);
    }
    let proposal_state = get(proposal, "state");
    if !(is_str(proposal_state, "pending") || is_str(proposal_state, "ready")) {
        blockers.push("proposal_not_pending");
        let state = proposal_state
            .and_then(Value::as_str)
            .filter(|terminal| matches!(*terminal, "applied" | "rejected" | "stale"))
            .unwrap_or("pending");
        return result(state, &blockers);
    }

    let p = |key| get(proposal, key);
    let r = |key| get(run, key);
    let c = |key| get(context, key);
    let mut require = |condition: bool, reason: &'static str| {
        if !condition {
            blockers.push(reason);
        }
    };

    require(
        text(p("id")) && text(p("sourceTaskId")),
        "proposal_identity_missing",
    );
    require(
        same(p("runId"), r("id"))
            && same(p("attemptId"), r("attemptId"))
            && same(p("sourceTaskId"), r("taskId")),
        "run_identity_mismatch",
    );
    require(
        text(p("targetTaskId")) != text(p("provisionalTargetId")),
        "target_identity_invalid",
    );
    require(
        !text(p("targetTaskId")) || p("targetTaskId") != p("sourceTaskId"),
        "target_is_source",
    );
    require(
        same(p("directoryId"), c("sourceDirectoryId"))
            && same(p("directoryId"), c("targetDirectoryId")),
        "directory_mismatch",
    );
    require(
        is_true(c("authorized")) && is_true(c("targetValid")),
        "target_unavailable",
    );
    require(
        is_true(r("finalized")) && is_true(r("evidencePersisted")),
        "run_not_finalized",
    );
    require(
        is_str(r("outcome"), "succeeded")
            && is_str(r("attemptOutcome"), "succeeded")
            && is_false(r("pendingInput"))
            && is_false(r("superseded")),
        "run_not_succeeded",
    );

    for (key, expected_key) in [
        ("cursorVersion", "expectedCursorVersion"),
        ("inputSequence", "expectedInputSequence"),
    ] {
        let expected = p(expected_key);
        if !version(expected) || !version(c(key)) {
            blockers.push("view_version_missing");
        } else if !same_number(expected, c(key)) {
            stale = true;
            blockers.push("view_changed");
        }
    }
    if !same(c("currentTaskId"), p("sourceTaskId")) || !same(c("latestRunId"), r("id")) {
        stale = true;
        blockers.push("source_advanced");
    }

    let mut require = |condition: bool, reason: &'static str| {
        if !condition {
            blockers.push(reason);
        }
    };
    if is_str(get(no_code, "kind"), "isolated-discussion") {
        let n = |key| get(no_code, key);
        require(
            is_true(n("verified"))
                && same(n("runId"), r("id"))
                && same(n("attemptId"), r("attemptId"))
                && matches!(r("workspaceId"), Some(Value::Null))
                && is_false(n("repositoryAccess"))
                && is_false(n("workspaceDependencies"))
                && is_false(n("untransferredArtifacts")),
            "no_code_exemption_unverified",
        );
    } else {
        let s = |key| get(source, key);
        let g = |key| get(guard, key);
        let i = |key| get(integration, key);
        let b = |key| get(baseline, key);
        require(
            text(r("workspaceId"))
                && text(r("repoId"))
                && text(r("baseRef"))
                && same(p("expectedCodeRevision"), r("endCodeRevision")),
            "code_identity_mismatch",
        );
        require(
            truthy(source)
                && same(s("workspaceId"), r("workspaceId"))
                && same(s("repoId"), r("repoId")),
            "source_identity_mismatch",
        );
        require(is_false(s("dirty")), "source_dirty_or_unknown");
        require(is_zero(s("unmergedCommits")), "source_unmerged_or_unknown");
        require(is_zero(s("untransferredFiles")), "source_files_unaccounted");
        require(
            is_false(s("gitOperation")) && is_true(s("supported")),
            "source_state_unsupported",
        );
        require(
            is_true(g("held"))
                && is_true(g("writersStopped"))
                && same(g("workspaceId"), r("workspaceId"))
                && text(g("token"))
                && version(s("version"))
                && same_number(s("version"), g("workspaceVersion")),
            "source_guard_unverified",
        );
        require(
            is_str(i("outcome"), "integrated")
                && is_true(i("verified"))
                && is_false(i("revoked"))
                && text(i("id"))
                && text(i("sourceHead"))
                && text(i("integrationHead"))
                && same(i("runId"), r("id"))
                && same(i("attemptId"), r("attemptId"))
                && same(i("workspaceId"), r("workspaceId"))
                && same(i("repoId"), r("repoId"))
                && same(i("coveredCodeRevision"), r("endCodeRevision"))
                && same(i("baseRef"), r("baseRef")),
            "integration_unverified",
        );
        require(
            is_true(b("verified"))
                && is_true(b("containsIntegration"))
                && is_true(b("effectValid"))
                && same(b("receiptId"), i("id"))
                && same(b("repoId"), r("repoId"))
                && same(b("baseRef"), r("baseRef"))
                && text(b("head")),
            "baseline_unverified",
        );
    }

    let state = if stale {
        "stale"
    } else if blockers.is_empty() {
        "ready"
    } else {
        "pending"
    };
    result(state, &blockers)
}

// ── Entry points ────────────────────────────────────────────────────────────

/// Op dispatch for the addon; JSON parsing is lenient at the JS boundary.
pub fn request(op: &str, input: &str) -> Result<String, String> {
    let value: Value = crate::json_lenient::from_str(input)
        .map_err(|e| format!("task_routing_invalid_input: {e}"))?;
    let out = match op {
        "normalizeAttributionMode" => {
            match normalize_mode(get(Some(&value), "value").and_then(Value::as_str)) {
                Some(mode) => json!(mode),
                None => Value::Null,
            }
        }
        "planAttributionAction" => plan_attribution_action(&value),
        "evaluateAttribution" => evaluate_attribution(&value),
        _ => return Err(format!("task_routing_unknown_op: {op}")),
    };
    Ok(out.to_string())
}

/// Constant tables; the JS bridge snapshots and freezes this at load.
pub fn catalog() -> Result<String, String> {
    Ok(json!({ "attributionModes": MODES, "defaultAttributionMode": DEFAULT_MODE }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fact mutation and the blocker it must produce.
    type Mutation = (fn(&mut Value), &'static str);

    fn facts() -> Value {
        json!({
            "proposal": { "id":"p1", "state":"pending", "runId":"r1", "attemptId":"a1", "sourceTaskId":"A",
                "targetTaskId":"B", "directoryId":"d1", "expectedCursorVersion":2, "expectedInputSequence":3,
                "expectedCodeRevision":"code1" },
            "run": { "id":"r1", "attemptId":"a1", "taskId":"A", "outcome":"succeeded", "attemptOutcome":"succeeded",
                "finalized":true, "evidencePersisted":true, "pendingInput":false, "superseded":false,
                "workspaceId":"w1", "repoId":"repo1", "baseRef":"main", "endCodeRevision":"code1" },
            "context": { "sourceDirectoryId":"d1", "targetDirectoryId":"d1", "authorized":true, "targetValid":true,
                "cursorVersion":2, "inputSequence":3, "currentTaskId":"A", "latestRunId":"r1" },
            "source": { "workspaceId":"w1", "repoId":"repo1", "version":4, "dirty":false, "unmergedCommits":0,
                "untransferredFiles":0, "gitOperation":false, "supported":true },
            "guard": { "held":true, "writersStopped":true, "workspaceId":"w1", "workspaceVersion":4, "token":"guard1" },
            "integration": { "id":"i1", "outcome":"integrated", "verified":true, "revoked":false, "runId":"r1",
                "attemptId":"a1", "workspaceId":"w1", "repoId":"repo1", "coveredCodeRevision":"code1",
                "sourceHead":"head1", "integrationHead":"merge1", "baseRef":"main" },
            "baseline": { "receiptId":"i1", "repoId":"repo1", "baseRef":"main", "verified":true, "head":"merge1",
                "containsIntegration":true, "effectValid":true }
        })
    }

    fn eval(input: &Value) -> Value {
        evaluate_attribution(input)
    }

    #[test]
    fn mode_normalization() {
        assert_eq!(normalize_mode(Some("AUTO")), Some("auto"));
        assert_eq!(normalize_mode(Some(" shadow ")), Some("shadow"));
        assert_eq!(normalize_mode(Some("\u{feff}off\u{3000}")), Some("off"));
        // NEL is not JS whitespace: it must not be trimmed.
        assert_eq!(normalize_mode(Some("\u{0085}auto")), None);
        assert_eq!(normalize_mode(Some("always")), None);
        assert_eq!(normalize_mode(None), None);
    }

    #[test]
    fn plan_ladder() {
        for mode in MODES {
            assert_eq!(
                plan_attribution_action(
                    &json!({ "mode": mode, "relation": "same", "targetTaskId": "tsk_a", "currentTaskId": "tsk_a" })
                ),
                json!({ "mode": mode, "action": "none", "reason": "no_change", "targetTaskId": null })
            );
        }
        let change = |mode: &str| json!({ "mode": mode, "relation": "new", "targetTaskId": "tsk_b", "currentTaskId": "tsk_a" });
        assert_eq!(
            plan_attribution_action(&change("off"))["reason"],
            "mode_off"
        );
        assert_eq!(
            plan_attribution_action(&change("shadow"))["action"],
            "record"
        );
        assert_eq!(
            plan_attribution_action(&change("suggest"))["targetTaskId"],
            "tsk_b"
        );
        assert_eq!(
            plan_attribution_action(&change("auto")),
            json!({ "mode": "auto", "action": "apply", "reason": "auto", "targetTaskId": "tsk_b" })
        );
        assert_eq!(
            plan_attribution_action(
                &json!({ "mode": "auto", "relation": "new", "targetTaskId": null, "currentTaskId": "tsk_a" })
            ),
            json!({ "mode": "auto", "action": "suggest", "reason": "target_unknown", "targetTaskId": null })
        );
        // Empty target is no address; unknown mode falls back to suggest.
        assert_eq!(
            plan_attribution_action(
                &json!({ "mode": "bogus", "relation": "new", "targetTaskId": "" })
            )["mode"],
            "suggest"
        );
        assert_eq!(plan_attribution_action(&json!({}))["reason"], "no_change");
    }

    #[test]
    fn eligibility_ready_and_rejections() {
        assert_eq!(
            eval(&facts()),
            json!({ "state": "ready", "eligible": true, "blockers": [], "requiresAtomicRecheck": true })
        );
        let cases: Vec<Mutation> = vec![
            (
                |x| {
                    x.as_object_mut().unwrap().remove("integration");
                },
                "integration_unverified",
            ),
            (
                |x| {
                    x["run"]["outcome"] = json!("completed");
                },
                "run_not_succeeded",
            ),
            (
                |x| {
                    x["run"]["pendingInput"] = json!(true);
                },
                "run_not_succeeded",
            ),
            (
                |x| {
                    x["source"].as_object_mut().unwrap().remove("dirty");
                },
                "source_dirty_or_unknown",
            ),
            (
                |x| {
                    x["source"]["dirty"] = json!("false");
                },
                "source_dirty_or_unknown",
            ),
            (
                |x| {
                    x["source"]["unmergedCommits"] = json!(1);
                },
                "source_unmerged_or_unknown",
            ),
            (
                |x| {
                    x["source"]["version"] = json!(5);
                },
                "source_guard_unverified",
            ),
            (
                |x| {
                    x["baseline"]["receiptId"] = json!("other");
                },
                "baseline_unverified",
            ),
            (
                |x| {
                    x["context"]
                        .as_object_mut()
                        .unwrap()
                        .remove("cursorVersion");
                },
                "view_version_missing",
            ),
            (
                |x| {
                    x["proposal"]["provisionalTargetId"] = json!("new1");
                },
                "target_identity_invalid",
            ),
            (
                |x| {
                    x["proposal"]["targetTaskId"] = json!("A");
                },
                "target_is_source",
            ),
        ];
        for (mutate, reason) in cases {
            let mut input = facts();
            mutate(&mut input);
            let out = eval(&input);
            assert_eq!(out["state"], "pending", "{reason}");
            assert_eq!(out["eligible"], false);
            assert!(
                out["blockers"].as_array().unwrap().contains(&json!(reason)),
                "{reason}: {out}"
            );
        }
    }

    #[test]
    fn eligibility_stale_missing_and_terminal() {
        for key in ["inputSequence", "cursorVersion"] {
            let mut input = facts();
            input["context"][key] = json!(input["context"][key].as_i64().unwrap() + 1);
            assert_eq!(eval(&input)["state"], "stale");
        }
        let mut input = facts();
        input["context"]["latestRunId"] = json!("r2");
        assert_eq!(eval(&input)["state"], "stale");
        // Equal versions encoded as floats still compare equal (JS numbers).
        let mut input = facts();
        input["context"]["cursorVersion"] = json!(2.0);
        assert_eq!(eval(&input)["state"], "ready");

        for input in [
            json!({}),
            Value::Null,
            json!({ "proposal": { "state": "pending" }, "run": {}, "context": {} }),
        ] {
            assert_eq!(eval(&input)["eligible"], false);
        }
        assert_eq!(eval(&json!({}))["blockers"], json!(["facts_missing"]));
        for state in ["applied", "rejected", "stale"] {
            let mut input = facts();
            input["proposal"]["state"] = json!(state);
            assert_eq!(eval(&input)["state"], state);
        }
        let mut input = facts();
        input["proposal"]["state"] = json!("weird");
        assert_eq!(eval(&input)["state"], "pending");
        // Duplicate blockers collapse in first-seen order.
        let mut input = facts();
        input["context"]
            .as_object_mut()
            .unwrap()
            .remove("cursorVersion");
        input["context"]
            .as_object_mut()
            .unwrap()
            .remove("inputSequence");
        assert_eq!(eval(&input)["blockers"], json!(["view_version_missing"]));
    }

    #[test]
    fn no_code_requires_strict_null_workspace() {
        let mut input = facts();
        input["run"]["workspaceId"] = Value::Null;
        input["noCode"] = json!({ "kind":"isolated-discussion", "verified":true, "runId":"r1", "attemptId":"a1",
            "repositoryAccess":false, "workspaceDependencies":false, "untransferredArtifacts":false });
        for key in ["source", "guard", "integration", "baseline"] {
            input.as_object_mut().unwrap().remove(key);
        }
        assert_eq!(eval(&input)["state"], "ready");
        // A missing workspaceId is undefined, not null: the exemption fails.
        input["run"].as_object_mut().unwrap().remove("workspaceId");
        assert!(eval(&input)["blockers"]
            .as_array()
            .unwrap()
            .contains(&json!("no_code_exemption_unverified")));
        // A real workspace run cannot claim the exemption.
        let mut input = facts();
        input["noCode"] = json!({ "kind":"isolated-discussion", "verified":true, "runId":"r1", "attemptId":"a1",
            "repositoryAccess":false, "workspaceDependencies":false, "untransferredArtifacts":false });
        assert_eq!(eval(&input)["eligible"], false);
    }

    #[test]
    fn request_dispatch_and_catalog() {
        assert_eq!(
            request("normalizeAttributionMode", r#"{"value":" Auto "}"#).unwrap(),
            r#""auto""#
        );
        assert_eq!(
            request("normalizeAttributionMode", r#"{"value":null}"#).unwrap(),
            "null"
        );
        assert_eq!(request("normalizeAttributionMode", "{}").unwrap(), "null");
        let raw =
            r#"{"mode":"auto","relation":"new","targetTaskId":"\ud834b","currentTaskId":"a"}"#;
        let out: Value =
            serde_json::from_str(&request("planAttributionAction", raw).unwrap()).unwrap();
        assert_eq!(out["targetTaskId"], "\u{fffd}b");
        assert!(request("nope", "{}").is_err());
        let catalog: Value = serde_json::from_str(&catalog().unwrap()).unwrap();
        assert_eq!(
            catalog["attributionModes"],
            json!(["off", "shadow", "suggest", "auto"])
        );
        assert_eq!(catalog["defaultAttributionMode"], "suggest");
    }
}
