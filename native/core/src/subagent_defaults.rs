//! 子任务（子 agent）默认线路：每个 CLI 家族（claude / codex）至多一条
//! `{ providerId, model }` 默认，外加「一键同步到该家族的所有会话」的计划。
//!
//! 纯 JSON 进、JSON 出：这里只做判断，不碰磁盘和会话存储。宿主（Node 迁移桥）
//! 提供会话表与 provider 能力事实，并把通过的结论落到 provider-defaults.json 与
//! 逐会话的 PATCH 上。等 Rust 接管会话存储和 provider 默认值后，这一层就是最终实现。
use serde_json::{json, Map, Value};

const MAX_PROVIDER_ID: usize = 256;
const MAX_MODEL: usize = 100;
const MAX_SESSION_NAME: usize = 120;
const FAMILIES: [&str; 2] = ["claude", "codex"];

fn family_for_cli(cli: &str) -> Option<&'static str> {
    match cli {
        "claude" | "claude-exp" => Some("claude"),
        "codex" | "codex-exp" => Some("codex"),
        _ => None,
    }
}

fn trimmed(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn char_len(text: &str) -> usize {
    text.chars().count()
}

// Same charset/length as the session model validator (`^[A-Za-z0-9._:/\[\]-]{1,100}$`).
fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && char_len(model) <= MAX_MODEL
        && model.chars().all(|ch| {
            ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '/' | '[' | ']' | '-')
        })
}

// A stored entry is kept only when it is a complete route; anything malformed
// collapses to "no default" instead of leaking a half route into the picker.
fn route_from(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let provider = trimmed(object.get("providerId"))?;
    if char_len(&provider) > MAX_PROVIDER_ID {
        return None;
    }
    let model = trimmed(object.get("model"))?;
    if !valid_model(&model) {
        return None;
    }
    Some(json!({ "providerId": provider, "model": model }))
}

fn normalized_defaults(stored: Option<&Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for family in FAMILIES {
        let route = stored
            .and_then(|value| value.get(family))
            .filter(|value| !value.is_null())
            .and_then(route_from)
            .unwrap_or(Value::Null);
        out.insert(family.to_owned(), route);
    }
    out
}

fn same_route(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn session_route(value: Option<&Value>) -> Option<Value> {
    value.filter(|value| !value.is_null()).and_then(route_from)
}

fn has_text(value: Option<&Value>) -> bool {
    trimmed(value).is_some()
}

// label || name || id was resolved by the caller; here a name may carry the
// control characters a terminal label can pick up, so clean before display.
fn clean_session_name(value: Option<&Value>) -> String {
    let raw = value.and_then(Value::as_str).unwrap_or("");
    let mut out = String::new();
    let mut pending_space = false;
    for ch in raw.chars() {
        if ch.is_control() || ch.is_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space && !out.is_empty() {
            out.push(' ');
        }
        pending_space = false;
        out.push(ch);
    }
    let truncated: String = out.chars().take(MAX_SESSION_NAME).collect();
    truncated.trim_end().to_owned()
}

struct PlanError {
    code: &'static str,
    error: &'static str,
}

fn invalid_subagent(error: &'static str) -> PlanError {
    PlanError { code: "invalid_subagent", error }
}

impl PlanError {
    fn json(self) -> String {
        json!({ "status": 400, "error": self.error, "code": self.code }).to_string()
    }
}

// null / "" / {} mean "follow the main line"; anything else must name both
// ends of a concrete route.
fn parse_target(value: Option<&Value>) -> Result<Option<Value>, PlanError> {
    let Some(value) = value else { return Ok(None) };
    if value.is_null() {
        return Ok(None);
    }
    if let Some(text) = value.as_str() {
        return if text.trim().is_empty() {
            Ok(None)
        } else {
            Err(invalid_subagent("invalid subagent"))
        };
    }
    let Some(object) = value.as_object() else {
        return Err(invalid_subagent("invalid subagent"));
    };
    if object.is_empty() {
        return Ok(None);
    }
    let provider = trimmed(object.get("providerId")).unwrap_or_default();
    if provider.is_empty() || char_len(&provider) > MAX_PROVIDER_ID {
        return Err(PlanError {
            code: "invalid_provider",
            error: "invalid subagent provider",
        });
    }
    let model = trimmed(object.get("model")).unwrap_or_default();
    if !valid_model(&model) {
        return Err(invalid_subagent("subagent model required"));
    }
    Ok(Some(json!({ "providerId": provider, "model": model })))
}

fn flag(input: &Value, key: &str) -> bool {
    input.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// Normalize a stored `subagent` value (any shape) into `{claude, codex}` with
/// both keys always present. Malformed entries become null.
pub fn normalize(input: &str) -> Result<String, String> {
    let parsed: Value =
        serde_json::from_str(input).map_err(|error| format!("invalid subagent defaults input: {error}"))?;
    let stored = parsed.get("stored");
    Ok(Value::Object(normalized_defaults(stored)).to_string())
}

/// Plan one family's sync: validate the target, pick the eligible sessions,
/// and say which stay unchanged or are skipped. The caller applies the plan.
pub fn plan_sync(input: &str) -> Result<String, String> {
    let parsed: Value =
        serde_json::from_str(input).map_err(|error| format!("invalid subagent sync input: {error}"))?;
    let cli = parsed.get("cli").and_then(Value::as_str).unwrap_or("").trim();
    let Some(family) = family_for_cli(cli) else {
        return Ok(json!({
            "status": 400,
            "error": "subagent defaults are only supported by Claude and Codex",
            "code": "unsupported_cli",
        })
        .to_string());
    };
    let target = match parse_target(parsed.get("subagent")) {
        Ok(target) => target,
        Err(error) => return Ok(error.json()),
    };
    if target.is_some() {
        if !flag(&parsed, "providerValid") {
            return Ok(PlanError {
                code: "invalid_provider",
                error: "subagent provider is not available for this CLI",
            }
            .json());
        }
        // The run-config UI hides the official Codex entry for sub-task routes:
        // it materializes a second model_provider, and the official relay is not
        // a plain HTTP endpoint the second provider could point at.
        if family == "codex" && (!flag(&parsed, "providerProxyable") || flag(&parsed, "providerOfficial")) {
            return Ok(PlanError {
                code: "provider_not_proxyable",
                error: "Codex subagent provider has no callable HTTP endpoint",
            }
            .json());
        }
    }

    let mut defaults = normalized_defaults(parsed.get("defaults"));
    defaults.insert(family.to_owned(), target.clone().unwrap_or(Value::Null));

    let sessions = parsed
        .get("sessions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut targets = Vec::new();
    let mut unchanged = Vec::new();
    let mut skipped = Vec::new();
    for session in sessions {
        let id = session.get("id").and_then(Value::as_str).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let session_cli = session.get("cli").and_then(Value::as_str).unwrap_or("");
        if family_for_cli(session_cli) != Some(family) {
            continue;
        }
        if session.get("kind").and_then(Value::as_str) != Some("chat") {
            continue;
        }
        if matches!(
            session.get("type").and_then(Value::as_str),
            Some("aux") | Some("gateway")
        ) {
            continue;
        }
        if session.get("ephemeral").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if has_text(session.get("loginFlow")) {
            continue;
        }
        let cleaned = clean_session_name(session.get("name"));
        let name = if cleaned.is_empty() { id.to_owned() } else { cleaned };
        let entry = json!({
            "sessionId": id,
            "sessionName": name,
            "cli": session_cli,
            "pending": session.get("pending").and_then(Value::as_bool).unwrap_or(false),
        });
        let desired = session_route(session.get("subagent"));
        if same_route(desired.as_ref(), target.as_ref()) {
            unchanged.push(entry);
            continue;
        }
        if family == "codex" && target.is_some() && !has_text(session.get("provider")) {
            let mut skipped_entry = entry;
            skipped_entry["reason"] = json!("codex_requires_main_provider");
            skipped.push(skipped_entry);
            continue;
        }
        targets.push(entry);
    }

    Ok(json!({
        "status": 200,
        "family": family,
        "subagent": target.unwrap_or(Value::Null),
        "defaults": Value::Object(defaults),
        "targets": targets,
        "unchanged": unchanged,
        "skipped": skipped,
    })
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(value: Value) -> Value {
        serde_json::from_str(&plan_sync(&value.to_string()).unwrap()).unwrap()
    }

    fn session(id: &str, cli: &str) -> Value {
        json!({ "id": id, "name": id, "cli": cli, "kind": "chat", "provider": "main" })
    }

    #[test]
    fn normalize_collapses_malformed_entries_to_null() {
        let out: Value = serde_json::from_str(
            &normalize(
                &json!({ "stored": {
                    "claude": { "providerId": " p1 ", "model": "claude-sonnet-4-5" },
                    "codex": { "providerId": "p2", "model": "bad model!" },
                } })
                .to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            out,
            json!({
                "claude": { "providerId": "p1", "model": "claude-sonnet-4-5" },
                "codex": null,
            })
        );
    }

    #[test]
    fn normalize_accepts_missing_and_hostile_shapes() {
        for stored in [json!(null), json!("oops"), json!([1, 2]), json!({ "claude": 7 })] {
            let out: Value =
                serde_json::from_str(&normalize(&json!({ "stored": stored }).to_string()).unwrap()).unwrap();
            assert_eq!(out, json!({ "claude": null, "codex": null }));
        }
        let missing: Value = serde_json::from_str(&normalize("{}").unwrap()).unwrap();
        assert_eq!(missing, json!({ "claude": null, "codex": null }));
    }

    #[test]
    fn unsupported_cli_and_invalid_targets_are_400() {
        assert_eq!(plan(json!({ "cli": "opencode" }))["code"], "unsupported_cli");
        assert_eq!(
            plan(json!({ "cli": "claude", "subagent": { "providerId": "p", "model": "bad model" } }))["code"],
            "invalid_subagent"
        );
        assert_eq!(
            plan(json!({ "cli": "claude", "subagent": { "providerId": "", "model": "m" } }))["code"],
            "invalid_provider"
        );
        assert_eq!(
            plan(json!({ "cli": "claude", "subagent": { "providerId": "p", "model": "m" },
                "providerValid": false }))["code"],
            "invalid_provider"
        );
        assert_eq!(
            plan(json!({ "cli": "codex", "subagent": { "providerId": "p", "model": "m" },
                "providerValid": true, "providerProxyable": false }))["code"],
            "provider_not_proxyable"
        );
        assert_eq!(
            plan(json!({ "cli": "codex", "subagent": { "providerId": "p", "model": "m" },
                "providerValid": true, "providerProxyable": true, "providerOfficial": true }))["code"],
            "provider_not_proxyable"
        );
        assert_eq!(
            plan(json!({ "cli": "claude", "subagent": "nope", "providerValid": true }))["code"],
            "invalid_subagent"
        );
    }

    #[test]
    fn family_aliases_and_eligibility() {
        let out = plan(json!({
            "cli": "claude-exp",
            "subagent": { "providerId": "p", "model": "m" },
            "providerValid": true,
            "defaults": { "claude": null, "codex": { "providerId": "x", "model": "y" } },
            "sessions": [
                session("keep", "claude"),
                session("exp", "claude-exp"),
                json!({ "id": "codex", "cli": "codex", "kind": "chat" }),
                json!({ "id": "aux", "cli": "claude", "kind": "chat", "type": "aux" }),
                json!({ "id": "gw", "cli": "claude", "kind": "chat", "type": "gateway" }),
                json!({ "id": "term", "cli": "claude", "kind": "terminal" }),
                json!({ "id": "eph", "cli": "claude", "kind": "chat", "ephemeral": true }),
                json!({ "id": "login", "cli": "claude", "kind": "chat", "loginFlow": "claude-auth-login" }),
            ],
        }));
        assert_eq!(out["status"], 200);
        assert_eq!(out["family"], "claude");
        let ids: Vec<_> = out["targets"].as_array().unwrap().iter().map(|s| s["sessionId"].clone()).collect();
        assert_eq!(ids, vec![json!("keep"), json!("exp")]);
        assert_eq!(out["unchanged"].as_array().unwrap().len(), 0);
        assert_eq!(out["defaults"]["claude"], json!({ "providerId": "p", "model": "m" }));
        assert_eq!(out["defaults"]["codex"], json!({ "providerId": "x", "model": "y" }));
    }

    #[test]
    fn unchanged_and_codex_without_main_provider() {
        let out = plan(json!({
            "cli": "codex",
            "subagent": { "providerId": "p", "model": "m" },
            "providerValid": true,
            "providerProxyable": true,
            "providerOfficial": false,
            "sessions": [
                json!({ "id": "same", "cli": "codex", "kind": "chat", "provider": "main",
                    "subagent": { "providerId": "p", "model": "m" } }),
                json!({ "id": "same-exp", "cli": "codex-exp", "kind": "chat", "provider": "main",
                    "subagent": { "providerId": "p", "model": "m" }, "pending": true }),
                json!({ "id": "no-main", "cli": "codex", "kind": "chat", "provider": null }),
                json!({ "id": "move", "cli": "codex", "kind": "chat", "provider": "main",
                    "subagent": { "providerId": "old", "model": "old" } }),
            ],
        }));
        let unchanged: Vec<_> = out["unchanged"].as_array().unwrap().iter()
            .map(|s| s["sessionId"].clone()).collect();
        assert_eq!(unchanged, vec![json!("same"), json!("same-exp")]);
        assert_eq!(out["unchanged"][1]["pending"], true);
        let skipped: Vec<_> = out["skipped"].as_array().unwrap().iter()
            .map(|s| (s["sessionId"].clone(), s["reason"].clone())).collect();
        assert_eq!(skipped, vec![(json!("no-main"), json!("codex_requires_main_provider"))]);
        let targets: Vec<_> = out["targets"].as_array().unwrap().iter()
            .map(|s| s["sessionId"].clone()).collect();
        assert_eq!(targets, vec![json!("move")]);
    }

    #[test]
    fn clearing_targets_clears_default_and_matches_null_sessions() {
        let out = plan(json!({
            "cli": "claude",
            "subagent": {},
            "defaults": { "claude": { "providerId": "p", "model": "m" }, "codex": null },
            "sessions": [
                json!({ "id": "clear", "cli": "claude", "kind": "chat", "provider": "main",
                    "subagent": { "providerId": "p", "model": "m" } }),
                json!({ "id": "already", "cli": "claude", "kind": "chat", "provider": "main" }),
            ],
        }));
        assert_eq!(out["subagent"], Value::Null);
        assert_eq!(out["defaults"]["claude"], Value::Null);
        let targets: Vec<_> = out["targets"].as_array().unwrap().iter()
            .map(|s| s["sessionId"].clone()).collect();
        assert_eq!(targets, vec![json!("clear")]);
        assert_eq!(out["unchanged"][0]["sessionId"], json!("already"));
    }

    #[test]
    fn session_names_are_sanitized_and_bounded() {
        let long = format!("{}\u{0001}\n  name", "x".repeat(300));
        let out = plan(json!({
            "cli": "claude",
            "subagent": { "providerId": "p", "model": "m" },
            "providerValid": true,
            "sessions": [{ "id": "a", "name": long, "cli": "claude", "kind": "chat" }],
        }));
        let name = out["targets"][0]["sessionName"].as_str().unwrap();
        assert_eq!(name.chars().count(), 120);
        assert!(!name.contains('\u{0001}'));
        assert!(!name.contains('\n'));
    }
}
