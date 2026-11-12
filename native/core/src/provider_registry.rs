//! Provider route rules retired from `src/routes/providers.js`: egress
//! validation, probe candidate/result shaping, the `mcrelay1.` share code, the
//! delete/reassign decision trees, provider-defaults merging and the
//! `GET /api/providers` response shape.
//!
//! Every branch, status and public string here is the Node route's, in the
//! same order. The HTTP plumbing lives in `native/gateway/src/app/providers.rs`;
//! Node-only facts (store, session table, relay store) come back through that
//! module's host port.

use std::collections::HashSet;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Map, Value};

use crate::claude_models;
use crate::http_gate::encode_uri_component;
use crate::js::serde::{js_json_stringify, js_string, truthy, value_or_empty};
use crate::js::{js_trim, utf16_len};
use crate::public_safety::{public_error, public_text, safe_code};

pub const MAX_PROBE_CANDIDATES: usize = 20;
pub const MAX_PROBE_CANDIDATE_LENGTH: usize = 200;
pub const MAX_RELAY_MODELS: usize = 100;
pub const MAX_RELAY_MODEL_LENGTH: usize = 256;
pub const RELAY_CODE_PREFIX: &str = "mcrelay1.";
pub const RELAY_FALLBACK_ID: &str = "mcr1";

/// `isValidIp` from `src/providers/egress-ip.js`: a bare IPv4 address with
/// every octet in 0..255, or anything made only of hex digits and colons that
/// contains a colon (the module never demanded a valid IPv6 literal there).
pub fn is_valid_ip(value: &str) -> bool {
    let value = js_trim(value);
    if value.is_empty() {
        return false;
    }
    let bytes = value.as_bytes();
    let mut dots = 0;
    for byte in bytes {
        if *byte == b'.' {
            dots += 1;
        } else if !byte.is_ascii_digit() {
            dots = -1;
            break;
        }
    }
    if dots == 3 && bytes.len() >= 7 {
        // `/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/`
        let parts: Vec<&str> = value.split('.').collect();
        let shaped = parts.len() == 4
            && parts.iter().all(|part| {
                (1..=3).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit())
            });
        if shaped {
            return parts
                .iter()
                .all(|part| part.parse::<u32>().is_ok_and(|octet| octet <= 255));
        }
    }
    let colon = value.contains(':');
    let hex = value
        .bytes()
        .all(|byte| byte.is_ascii_hexdigit() || byte == b':');
    colon && hex
}

/// `parseEgressIpAllowlist`: absent leaves the stored value alone (`None`),
/// `null` clears it, and anything that is not an array of IP strings is a
/// rejected configuration.
pub fn parse_egress_ip_allowlist(
    body: Option<&Map<String, Value>>,
) -> Result<Option<Vec<String>>, String> {
    let value = body.and_then(|object| object.get("egressIpAllowlist"));
    let value = match value {
        None => return Ok(None),
        Some(Value::Null) => return Ok(Some(Vec::new())),
        Some(array @ Value::Array(_)) => array,
        Some(_) => {
            return Err("egressIpAllowlist must be an array of IP addresses".to_string());
        }
    };
    let items = value.as_array().expect("array");
    let mut list = Vec::with_capacity(items.len());
    for item in items {
        let text = js_string(item);
        let text = js_trim(&text);
        if !text.is_empty() {
            list.push(text.to_string());
        }
    }
    if let Some(invalid) = list.iter().find(|ip| !is_valid_ip(ip)) {
        return Err(format!(
            "egressIpAllowlist contains an invalid IP address: {invalid}"
        ));
    }
    Ok(Some(list))
}

/// `parseEgressBinding`: absent leaves the stored binding alone (`None`),
/// `null` clears it, and the JSON envelope is narrowed to the two ids (shape
/// validation itself happens in the provider store).
pub fn parse_egress_binding(body: Option<&Map<String, Value>>) -> Result<Option<Value>, String> {
    let value = body.and_then(|object| object.get("egressBinding"));
    match value {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(Value::Null)),
        Some(Value::Object(object)) => {
            let mut out = Map::new();
            if let Some(plugin_id) = object.get("pluginId") {
                out.insert("pluginId".into(), plugin_id.clone());
            }
            if let Some(profile_id) = object.get("profileId") {
                out.insert("profileId".into(), profile_id.clone());
            }
            Ok(Some(Value::Object(out)))
        }
        Some(_) => Err("egressBinding must be an object with pluginId and profileId".to_string()),
    }
}

/// Both parsers in their original order: the allowlist is evaluated first, so
/// an invalid IP wins over a malformed binding.
pub fn validate_egress(body: Option<&Map<String, Value>>) -> Result<(), String> {
    parse_egress_ip_allowlist(body)?;
    parse_egress_binding(body)?;
    Ok(())
}

/// `(value || '').trim()` from the create route: a truthy non-string has no
/// `.trim`, which the retired handler surfaced as a caught `TypeError`.
fn js_trim_property(value: Option<&Value>, expression: &str) -> Result<String, String> {
    let Some(value) = value.filter(|value| truthy(value)) else {
        return Ok(String::new());
    };
    let Value::String(text) = value else {
        return Err(format!("({expression} || \"\").trim is not a function"));
    };
    Ok(js_trim(text).to_string())
}

/// The exact object `POST /api/providers` handed to `createProvider`.
pub fn create_payload(input: Option<&Map<String, Value>>) -> Result<Map<String, Value>, String> {
    let empty = Map::new();
    let input = input.unwrap_or(&empty);
    // Both parsers run before the object literal is evaluated.
    let allowlist = parse_egress_ip_allowlist(Some(input))?;
    let binding = parse_egress_binding(Some(input))?;
    let app_type = js_trim_property(input.get("appType"), "req.body.appType")?;
    let name = input.get("name").cloned();
    let base_url = js_trim_property(input.get("baseUrl"), "req.body.baseUrl")?;
    let auth_token = js_trim_property(input.get("authToken"), "req.body.authToken")?;
    let model = js_trim_property(input.get("model"), "req.body.model")?;
    let mut out = Map::new();
    out.insert("appType".into(), Value::String(app_type));
    if let Some(name) = name {
        out.insert("name".into(), name);
    }
    out.insert("baseUrl".into(), Value::String(base_url));
    out.insert("authToken".into(), Value::String(auth_token));
    out.insert("model".into(), Value::String(model));
    for key in [
        "models",
        "apiFormat",
        "settingsConfig",
        "virtual",
        "aliasMap",
    ] {
        if let Some(value) = input.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    if let Some(list) = allowlist {
        out.insert(
            "egressIpAllowlist".into(),
            Value::Array(list.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(binding) = binding {
        out.insert("egressBinding".into(), binding);
    }
    Ok(out)
}

/// The exact patch object `PATCH /api/providers/:appType/:id` handed to
/// `updateProvider`: raw members (no trimming) and the same spreads.
pub fn update_payload(input: Option<&Map<String, Value>>) -> Result<Map<String, Value>, String> {
    let empty = Map::new();
    let input = input.unwrap_or(&empty);
    let allowlist = parse_egress_ip_allowlist(Some(input))?;
    let binding = parse_egress_binding(Some(input))?;
    let mut out = Map::new();
    for key in ["name", "baseUrl", "authToken", "model", "models"] {
        if let Some(value) = input.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    for key in ["apiFormat", "settingsConfig", "virtual", "aliasMap"] {
        if let Some(value) = input.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    if let Some(list) = allowlist {
        out.insert(
            "egressIpAllowlist".into(),
            Value::Array(list.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(binding) = binding {
        out.insert("egressBinding".into(), binding);
    }
    Ok(out)
}

/// `normalizeProbeCandidates`. `Ok(None)` is JavaScript `undefined` (the body
/// carried no candidates at all).
pub fn normalize_probe_candidates(
    value: Option<&Value>,
) -> Result<Option<Vec<String>>, (u16, &'static str)> {
    let value = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(array @ Value::Array(_)) => array,
        Some(_) => return Err((400, "probe candidates must be an array")),
    };
    let items = value.as_array().expect("array");
    if items.len() > MAX_PROBE_CANDIDATES {
        return Err((413, "too many probe candidates"));
    }
    let mut candidates: Vec<String> = Vec::new();
    for item in items {
        let Value::String(text) = item else {
            return Err((400, "invalid probe candidate"));
        };
        let candidate = js_trim(text);
        if candidate.is_empty() || utf16_len(candidate) > MAX_PROBE_CANDIDATE_LENGTH {
            return Err((400, "invalid probe candidate"));
        }
        if !candidates.iter().any(|seen| seen == candidate) {
            candidates.push(candidate.to_string());
        }
    }
    Ok(Some(candidates))
}

/// `sanitizeProbeResult`: a shallow copy whose `error`/`reason`/`sample`
/// strings are pushed through `sanitizePublicText`.
pub fn sanitize_probe_result(result: &Value) -> Value {
    let Value::Object(object) = result else {
        return result.clone();
    };
    let mut out = Map::new();
    for (key, value) in object {
        let value = match key.as_str() {
            "error" => Value::String(public_text(Some(value), "provider probe failed")),
            "tested" => match value {
                Value::Array(entries) => {
                    let mut tested = Vec::with_capacity(entries.len());
                    for entry in entries {
                        let Value::Object(entry) = entry else {
                            tested.push(entry.clone());
                            continue;
                        };
                        let mut item = Map::new();
                        for (field, field_value) in entry {
                            let field_value = match field.as_str() {
                                "error" | "reason" => Value::String(public_text(
                                    Some(field_value),
                                    "provider probe failed",
                                )),
                                "sample" => Value::String(public_text(
                                    Some(field_value),
                                    "provider probe output hidden",
                                )),
                                _ => field_value.clone(),
                            };
                            item.insert(field.clone(), field_value);
                        }
                        tested.push(Value::Object(item));
                    }
                    Value::Array(tested)
                }
                other => other.clone(),
            },
            _ => value.clone(),
        };
        out.insert(key.clone(), value);
    }
    Value::Object(out)
}

/// `importErrorDto`: the 400 body of `POST /api/providers/import`.
pub fn import_error_dto(
    message: Option<&str>,
    code: Option<&Value>,
    reason: Option<&Value>,
) -> Value {
    let mut out = Map::new();
    out.insert(
        "error".into(),
        Value::String(public_error(message, "provider import failed")),
    );
    if let Some(code) = code.filter(|value| truthy(value)) {
        out.insert(
            "code".into(),
            Value::String(safe_code(&js_string(code), "PROVIDER_IMPORT_FAILED")),
        );
    }
    if let Some(reason) = reason.filter(|value| truthy(value)) {
        out.insert(
            "reason".into(),
            Value::String(public_text(Some(reason), "provider import failed")),
        );
    }
    Value::Object(out)
}

/// `relayModelsOf`: the summary's model metadata, deduped and capped.
pub fn relay_models_of(summary: Option<&Value>) -> Vec<String> {
    let mut models: Vec<String> = Vec::new();
    let mut consider = |value: Option<&Value>| {
        let text = value_or_empty(value);
        let text = js_trim(&text);
        if text.is_empty() || utf16_len(text) > MAX_RELAY_MODEL_LENGTH {
            return;
        }
        if !models.iter().any(|seen| seen == text) {
            models.push(text.to_string());
        }
    };
    let object = summary.and_then(Value::as_object);
    if let Some(object) = object {
        consider(object.get("model"));
        if let Some(Value::Array(options)) = object.get("modelOptions") {
            for option in options {
                consider(Some(option));
            }
        }
    }
    if models.is_empty()
        && object.is_some_and(|object| {
            object.get("isOfficial") == Some(&Value::Bool(true))
                && object.get("appType") == Some(&Value::String("claude".to_string()))
        })
    {
        return claude_models::fallback_ids()
            .into_iter()
            .take(MAX_RELAY_MODELS)
            .map(str::to_string)
            .collect();
    }
    models.truncate(MAX_RELAY_MODELS);
    models
}

/// `encodeRelayShareCode`: `mcrelay1.` + base64url of the v2 JSON payload.
pub fn encode_relay_share_code(
    name: &str,
    app_type: &str,
    base_url: &str,
    models: &[String],
    relay_share_id: &str,
    auth_token: &str,
) -> String {
    let mut payload = Map::new();
    payload.insert("v".into(), json!(2));
    payload.insert("kind".into(), json!("multicc-relay"));
    payload.insert("name".into(), json!(name));
    payload.insert("appType".into(), json!(app_type));
    payload.insert("baseUrl".into(), json!(base_url));
    if let Some(first) = models.first().filter(|first| !first.is_empty()) {
        payload.insert("model".into(), json!(first));
        payload.insert("models".into(), json!(models));
    }
    payload.insert("relayShareId".into(), json!(relay_share_id));
    payload.insert("authToken".into(), json!(auth_token));
    let text = js_json_stringify(&Value::Object(payload));
    format!("{RELAY_CODE_PREFIX}{}", URL_SAFE_NO_PAD.encode(text))
}

/// `parseCredential` (`mcr1.<id>.<secret>`).
pub fn parse_credential(token: Option<&Value>) -> Option<(String, String)> {
    let token = token?;
    crate::relay_shares::parse_credential(&crate::js::from_serde(token))
}

/// `relayRouteFromBaseUrl`: `{ appType, providerId, url }` for a proxy path.
pub fn relay_route_from_base_url(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    let route = crate::relay_shares::relay_route(&crate::js::from_serde(value))?;
    Some(crate::js::to_serde(&route))
}

/// The lender's public URLs for a new share.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayShareUrls {
    pub base: String,
    pub relay_base_url: String,
}

/// `new URL(...)` + origin + the per-app relay path. `None` is the route's 400.
pub fn relay_share_urls(
    app_type: &str,
    provider_id: &str,
    public_base_url: Option<&Value>,
) -> Option<RelayShareUrls> {
    let raw = value_or_empty(public_base_url);
    let parsed = url::Url::parse(js_trim(&raw)).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let base = parsed.origin().ascii_serialization();
    let encoded = encode_uri_component(provider_id);
    let relay_base_url = if app_type == "codex" {
        format!("{base}/codex-proxy/{encoded}")
    } else {
        format!("{base}/claude-proxy/{encoded}/remote")
    };
    Some(RelayShareUrls {
        base,
        relay_base_url,
    })
}

/// The `DELETE /api/providers/:appType/:id` decision tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeletePlan {
    /// 409 `PROVIDER_IN_USE`.
    InUse,
    /// References exist and the caller may force: detach, then delete.
    Detach,
    /// Nothing references the provider.
    Delete,
}

pub fn plan_delete(reference_count: usize, force: bool, forceable: bool) -> DeletePlan {
    if reference_count == 0 {
        DeletePlan::Delete
    } else if force && forceable {
        DeletePlan::Detach
    } else {
        DeletePlan::InUse
    }
}

/// 409 body when the provider is still referenced.
pub fn provider_in_use_response(references: &Value, forceable: bool) -> Value {
    let mut out = Map::new();
    out.insert("error".into(), json!("provider is still referenced"));
    out.insert("code".into(), json!("PROVIDER_IN_USE"));
    out.insert("references".into(), references.clone());
    out.insert("forceable".into(), Value::Bool(forceable));
    Value::Object(out)
}

/// 409 body when some reference could not be detached.
pub fn detach_failed_response(failed: &Value, detached: &Value) -> Value {
    let mut out = Map::new();
    out.insert(
        "error".into(),
        json!("provider references could not all be detached"),
    );
    out.insert("code".into(), json!("PROVIDER_DETACH_FAILED"));
    out.insert("references".into(), failed.clone());
    out.insert("detached".into(), detached.clone());
    out.insert("forceable".into(), Value::Bool(false));
    Value::Object(out)
}

/// 200 body of a successful delete.
pub fn delete_response(ok: bool, forced: bool, detached: &Value) -> Value {
    let mut out = Map::new();
    out.insert("ok".into(), Value::Bool(ok));
    if forced {
        out.insert("forced".into(), Value::Bool(true));
        out.insert("detached".into(), detached.clone());
    }
    Value::Object(out)
}

/// `String(req.params.appType || '').trim()` must be one of the two pools.
pub fn is_valid_app_type(app_type: &str) -> bool {
    app_type == "claude" || app_type == "codex"
}

/// `rawTarget == null || rawTarget === '' ? null : String(rawTarget).trim()`.
/// `Some("")` is possible (`" "` trims to empty) and is falsy downstream.
pub fn reassign_target_id(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(other) => Some(js_trim(&js_string(other)).to_string()),
    }
}

/// `body.dryRun === true || body.dryRun === '1' || body.dryRun === 'true'`.
pub fn reassign_dry_run(body: Option<&Map<String, Value>>) -> bool {
    match body.and_then(|object| object.get("dryRun")) {
        Some(Value::Bool(true)) => true,
        Some(Value::String(text)) => text == "1" || text == "true",
        _ => false,
    }
}

/// The two validation steps that happen before any provider lookup, in order:
/// the target must differ from the source, and a non-dry run needs a target.
pub fn reassign_precheck(
    provider_id: &str,
    target: Option<&str>,
    dry_run: bool,
) -> Result<(), (u16, &'static str)> {
    if target == Some(provider_id) {
        return Err((400, "target provider must differ from the source"));
    }
    if target.is_none_or(str::is_empty) && !dry_run {
        return Err((400, "targetProviderId is required"));
    }
    Ok(())
}

/// The provider-defaults keys a PUT body touches, in the route's order.
pub fn defaults_updates(body: Option<&Map<String, Value>>) -> Vec<(String, Value)> {
    let mut updates = Vec::new();
    for cli in ["claude", "codex"] {
        if let Some(value) = body.and_then(|object| object.get(cli)) {
            updates.push((cli.to_string(), value.clone()));
        }
    }
    updates
}

/// 400 body of an invalid provider-defaults value.
pub fn invalid_defaults_error(cli: &str) -> Value {
    json!({ "error": format!("invalid {cli} provider id") })
}

/// The merge the PUT route performs on the live defaults object.
pub fn merge_defaults(updates: &[(String, Value)]) -> Map<String, Value> {
    let mut out = Map::new();
    for (cli, value) in updates {
        out.insert(cli.clone(), value.clone());
    }
    out
}

/// `GET /api/providers`: Express object order with `available` first and the
/// derived `ccSwitchAvailable`. Members the host omitted stay omitted, like
/// `JSON.stringify` dropping `undefined`.
pub fn catalog_body(facts: &Value) -> Value {
    let object = facts.as_object();
    let mut out = Map::new();
    out.insert("available".into(), Value::Bool(true));
    let status = object.and_then(|object| object.get("ccSwitchStatus"));
    if let Some(Value::Object(status)) = status {
        if let Some(available) = status.get("available") {
            out.insert("ccSwitchAvailable".into(), available.clone());
        }
    }
    for (key, source) in [
        ("ccSwitchStatus", status),
        (
            "providers",
            object.and_then(|object| object.get("providers")),
        ),
        ("defaults", object.and_then(|object| object.get("defaults"))),
        ("stats", object.and_then(|object| object.get("stats"))),
        (
            "limitCacheStaleMs",
            object.and_then(|object| object.get("limitCacheStaleMs")),
        ),
    ] {
        if let Some(value) = source {
            out.insert(key.into(), value.clone());
        }
    }
    Value::Object(out)
}

/// `Set` membership helper used by tests and callers reading a model list.
pub fn unique_models(models: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    models
        .iter()
        .filter(|model| seen.insert((*model).clone()))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::serde::js_json_stringify;

    fn body(value: Value) -> Map<String, Value> {
        value.as_object().expect("object").clone()
    }

    #[test]
    fn ip_detection_matches_the_node_vectors() {
        for good in [
            "1.2.3.4",
            "0.0.0.0",
            "255.255.255.255",
            " 10.0.0.1 ",
            "::1",
            "2001:db8::1",
            "fe80::",
            ":",
            "1:2:3:4:5:6:7:8:9",
            "01.02.03.004",
        ] {
            assert!(is_valid_ip(good), "{good}");
        }
        for bad in [
            "",
            " ",
            "1.2.3",
            "1.2.3.4.5",
            "256.0.0.1",
            "1.2.3.999",
            "1.2.3.-1",
            "1.2.3.4/24",
            "localhost",
            "::1%en0",
            "2001:db8::1g",
            "1.2.3.4:80",
        ] {
            assert!(!is_valid_ip(bad), "{bad}");
        }
        // A four-part dotted value with non-digits is not the dotted shape and
        // has no colon, so it is rejected.
        assert!(!is_valid_ip("a.b.c.d"));
    }

    #[test]
    fn egress_allowlist_keeps_the_three_cases_apart() {
        assert_eq!(parse_egress_ip_allowlist(None), Ok(None));
        assert_eq!(
            parse_egress_ip_allowlist(Some(&Map::new())),
            Ok(None),
            "absent is not the same as null"
        );
        assert_eq!(
            parse_egress_ip_allowlist(Some(&body(json!({ "egressIpAllowlist": null })))),
            Ok(Some(Vec::new()))
        );
        assert_eq!(
            parse_egress_ip_allowlist(Some(&body(
                json!({ "egressIpAllowlist": [" 1.2.3.4 ", "", null, 5] })
            ))),
            Err("egressIpAllowlist contains an invalid IP address: null".into()),
            "String(v).trim() then filter(Boolean), then the first invalid IP wins"
        );
        assert_eq!(
            parse_egress_ip_allowlist(Some(&body(
                json!({ "egressIpAllowlist": [" 1.2.3.4 ", "", " 2001:db8::1 "] })
            ))),
            Ok(Some(vec!["1.2.3.4".into(), "2001:db8::1".into()]))
        );
        assert_eq!(
            parse_egress_ip_allowlist(Some(&body(json!({ "egressIpAllowlist": "1.2.3.4" })))),
            Err("egressIpAllowlist must be an array of IP addresses".into())
        );
        assert_eq!(
            parse_egress_ip_allowlist(Some(&body(
                json!({ "egressIpAllowlist": ["1.2.3.4", "nope"] })
            ))),
            Err("egressIpAllowlist contains an invalid IP address: nope".into())
        );
    }

    #[test]
    fn egress_binding_narrows_to_the_two_ids() {
        assert_eq!(parse_egress_binding(None), Ok(None));
        assert_eq!(
            parse_egress_binding(Some(&body(json!({ "egressBinding": null })))),
            Ok(Some(Value::Null))
        );
        assert_eq!(
            parse_egress_binding(Some(&body(json!({
                "egressBinding": { "profileId": "p", "pluginId": "x", "extra": 1 }
            })))),
            Ok(Some(json!({ "pluginId": "x", "profileId": "p" })))
        );
        assert_eq!(
            parse_egress_binding(Some(&body(json!({ "egressBinding": ["x"] })))),
            Err("egressBinding must be an object with pluginId and profileId".into())
        );
        assert_eq!(
            parse_egress_binding(Some(&body(json!({ "egressBinding": 3 })))),
            Err("egressBinding must be an object with pluginId and profileId".into())
        );
        // Missing members are `undefined` and stay absent from the envelope.
        assert_eq!(
            parse_egress_binding(Some(&body(json!({ "egressBinding": {} })))),
            Ok(Some(json!({})))
        );
        assert_eq!(
            validate_egress(Some(&body(json!({
                "egressIpAllowlist": "bad",
                "egressBinding": 1
            })))),
            Err("egressIpAllowlist must be an array of IP addresses".into())
        );
    }

    #[test]
    fn create_payload_trims_and_omits_the_same_keys() {
        let payload = create_payload(Some(&body(json!({
            "appType": " claude ",
            "name": "  kept raw ",
            "baseUrl": " http://x ",
            "authToken": " tok ",
            "model": " m ",
            "models": ["a"],
            "apiFormat": null,
            "settingsConfig": { "env": {} },
            "virtual": false,
            "aliasMap": {},
            "egressIpAllowlist": ["1.2.3.4"],
            "egressBinding": { "pluginId": "p", "profileId": "q" },
            "unknown": "dropped"
        }))))
        .unwrap();
        assert_eq!(
            js_json_stringify(&Value::Object(payload)),
            r#"{"appType":"claude","name":"  kept raw ","baseUrl":"http://x","authToken":"tok","model":"m","models":["a"],"apiFormat":null,"settingsConfig":{"env":{}},"virtual":false,"aliasMap":{},"egressIpAllowlist":["1.2.3.4"],"egressBinding":{"pluginId":"p","profileId":"q"}}"#
        );
        let minimal = create_payload(None).unwrap();
        assert_eq!(
            js_json_stringify(&Value::Object(minimal)),
            r#"{"appType":"","baseUrl":"","authToken":"","model":""}"#
        );
        assert!(create_payload(Some(&body(json!({
            "egressIpAllowlist": ["bad"]
        }))))
        .is_err());
        // egress parsing runs before the object literal, so its error wins
        // even when a later trim would also throw.
        assert_eq!(
            create_payload(Some(&body(json!({
                "appType": 7,
                "egressIpAllowlist": "bad"
            })))),
            Err("egressIpAllowlist must be an array of IP addresses".into())
        );
        // A truthy non-string has no `.trim`; the caught TypeError text is
        // what the 400 body carries.
        assert_eq!(
            create_payload(Some(&body(json!({ "appType": ["claude"] })))),
            Err(r#"(req.body.appType || "").trim is not a function"#.into())
        );
        assert_eq!(
            create_payload(Some(&body(json!({ "baseUrl": {} })))),
            Err(r#"(req.body.baseUrl || "").trim is not a function"#.into())
        );
        // Falsy non-strings take the `|| ''` branch.
        let falsy = create_payload(Some(&body(json!({
            "appType": 0,
            "baseUrl": false,
            "authToken": null,
            "model": ""
        }))))
        .unwrap();
        assert_eq!(
            js_json_stringify(&Value::Object(falsy)),
            r#"{"appType":"","baseUrl":"","authToken":"","model":""}"#
        );
    }

    #[test]
    fn update_payload_keeps_raw_members_and_the_same_spreads() {
        let payload = update_payload(Some(&body(json!({
            "appType": "ignored",
            "name": " kept ",
            "baseUrl": " http://x ",
            "authToken": " tok ",
            "model": " m ",
            "models": ["a"],
            "apiFormat": null,
            "settingsConfig": { "env": {} },
            "virtual": false,
            "aliasMap": {},
            "egressIpAllowlist": null,
            "egressBinding": { "pluginId": "p" },
            "unknown": "dropped"
        }))))
        .unwrap();
        assert_eq!(
            js_json_stringify(&Value::Object(payload)),
            r#"{"name":" kept ","baseUrl":" http://x ","authToken":" tok ","model":" m ","models":["a"],"apiFormat":null,"settingsConfig":{"env":{}},"virtual":false,"aliasMap":{},"egressIpAllowlist":[],"egressBinding":{"pluginId":"p"}}"#
        );
        assert_eq!(
            js_json_stringify(&Value::Object(update_payload(None).unwrap())),
            "{}"
        );
        assert_eq!(
            update_payload(Some(&body(json!({ "egressBinding": "bad" })))),
            Err("egressBinding must be an object with pluginId and profileId".into())
        );
    }

    #[test]
    fn probe_candidates_follow_the_route_limits() {
        assert_eq!(normalize_probe_candidates(None), Ok(None));
        assert_eq!(normalize_probe_candidates(Some(&Value::Null)), Ok(None));
        assert_eq!(
            normalize_probe_candidates(Some(&json!("x"))),
            Err((400, "probe candidates must be an array"))
        );
        let many: Vec<Value> = (0..21).map(|i| json!(format!("m{i}"))).collect();
        assert_eq!(
            normalize_probe_candidates(Some(&Value::Array(many))),
            Err((413, "too many probe candidates"))
        );
        assert_eq!(
            normalize_probe_candidates(Some(&json!([" a ", "a", "b"]))),
            Ok(Some(vec!["a".into(), "b".into()]))
        );
        assert_eq!(
            normalize_probe_candidates(Some(&json!([1]))),
            Err((400, "invalid probe candidate"))
        );
        assert_eq!(
            normalize_probe_candidates(Some(&json!(["   "]))),
            Err((400, "invalid probe candidate"))
        );
        assert_eq!(
            normalize_probe_candidates(Some(&json!(["x".repeat(200)]))),
            Ok(Some(vec!["x".repeat(200)]))
        );
        assert_eq!(
            normalize_probe_candidates(Some(&json!(["x".repeat(201)]))),
            Err((400, "invalid probe candidate"))
        );
    }

    #[test]
    fn probe_results_are_shallow_copies_with_sanitized_strings() {
        let result = json!({
            "error": "token: abc",
            "tested": [
                { "error": "upstream down", "reason": "bad", "sample": "/etc/passwd", "model": "m" },
                "line",
                null
            ],
            "accepted": ["m"],
            "other": 1
        });
        assert_eq!(
            sanitize_probe_result(&result),
            json!({
                "error": "provider probe failed",
                "tested": [
                    {
                        "error": "provider probe failed",
                        "reason": "bad",
                        "sample": "provider probe output hidden",
                        "model": "m"
                    },
                    "line",
                    null
                ],
                "accepted": ["m"],
                "other": 1
            })
        );
        assert_eq!(sanitize_probe_result(&json!(["x"])), json!(["x"]));
        assert_eq!(sanitize_probe_result(&Value::Null), Value::Null);
    }

    #[test]
    fn import_error_dto_matches_the_route_body() {
        assert_eq!(
            import_error_dto(None, None, None),
            json!({ "error": "provider import failed" })
        );
        assert_eq!(
            import_error_dto(Some("bad cc"), Some(&json!("NOT_JSON")), Some(&json!("x"))),
            json!({ "error": "bad cc", "code": "NOT_JSON", "reason": "x" })
        );
        assert_eq!(
            import_error_dto(
                Some("upstream broke"),
                Some(&json!("bad code!")),
                Some(&json!(false))
            ),
            json!({ "error": "provider import failed", "code": "PROVIDER_IMPORT_FAILED" })
        );
        assert_eq!(
            import_error_dto(Some("bad cc"), Some(&json!("")), Some(&json!("/a/b"))),
            json!({ "error": "bad cc", "reason": "provider import failed" })
        );
    }

    #[test]
    fn relay_models_dedupes_trims_and_falls_back() {
        assert_eq!(relay_models_of(None), Vec::<String>::new());
        assert_eq!(
            relay_models_of(Some(&json!({
                "model": " a ",
                "modelOptions": ["a", "b", "", "  ", 3, "c".repeat(257)]
            }))),
            vec!["a".to_string(), "b".to_string(), "3".to_string()]
        );
        assert_eq!(
            relay_models_of(Some(&json!({
                "isOfficial": true,
                "appType": "claude",
                "model": "  "
            }))),
            claude_models::fallback_ids()
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            relay_models_of(Some(&json!({
                "isOfficial": "true",
                "appType": "claude"
            }))),
            Vec::<String>::new(),
            "isOfficial compares strictly with true"
        );
        let many: Vec<Value> = (0..150).map(|i| json!(format!("m{i}"))).collect();
        assert_eq!(
            relay_models_of(Some(&json!({ "modelOptions": many }))).len(),
            100
        );
        assert_eq!(
            unique_models(&["a".into(), "a".into(), "b".into()]).len(),
            2
        );
    }

    #[test]
    fn relay_share_code_round_trips_the_v2_payload() {
        let models = vec!["m1".to_string(), "m2".to_string()];
        let code = encode_relay_share_code(
            "Name · 远程共享",
            "claude",
            "https://host/claude-proxy/p%2F1/remote",
            &models,
            "share-1",
            "secret-token",
        );
        assert!(code.starts_with(RELAY_CODE_PREFIX));
        let encoded = &code[RELAY_CODE_PREFIX.len()..];
        let decoded = URL_SAFE_NO_PAD.decode(encoded).unwrap();
        assert_eq!(
            String::from_utf8(decoded).unwrap(),
            r#"{"v":2,"kind":"multicc-relay","name":"Name · 远程共享","appType":"claude","baseUrl":"https://host/claude-proxy/p%2F1/remote","model":"m1","models":["m1","m2"],"relayShareId":"share-1","authToken":"secret-token"}"#
        );
        let empty = encode_relay_share_code("n", "codex", "https://h", &[], "s", "t");
        let text = String::from_utf8(
            URL_SAFE_NO_PAD
                .decode(&empty[RELAY_CODE_PREFIX.len()..])
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            text,
            r#"{"v":2,"kind":"multicc-relay","name":"n","appType":"codex","baseUrl":"https://h","relayShareId":"s","authToken":"t"}"#
        );
        // JSON escaping is JSON.stringify's, not serde's pretty form.
        let escaped = encode_relay_share_code("a\"b\\c\n", "claude", "https://h", &[], "s", "t");
        let text = String::from_utf8(
            URL_SAFE_NO_PAD
                .decode(&escaped[RELAY_CODE_PREFIX.len()..])
                .unwrap(),
        )
        .unwrap();
        assert!(text.contains(r#""name":"a\"b\\c\n""#));
    }

    #[test]
    fn credentials_and_relay_routes_reuse_the_relay_kernel() {
        assert_eq!(
            parse_credential(Some(&json!("mcr1.0123456789abcdef.secret12"))),
            Some(("0123456789abcdef".to_string(), "secret12".to_string()))
        );
        assert_eq!(parse_credential(Some(&json!("nope"))), None);
        assert_eq!(parse_credential(None), None);
        assert_eq!(
            relay_route_from_base_url(Some(&json!(
                "https://lender.example/claude-proxy/0123456789abcdef/remote"
            ))),
            Some(json!({
                "appType": "claude",
                "providerId": "0123456789abcdef",
                "url": "https://lender.example/claude-proxy/0123456789abcdef/remote"
            }))
        );
        assert_eq!(
            relay_route_from_base_url(Some(&json!("http://127.0.0.1/claude-proxy/x/remote"))),
            None
        );
    }

    #[test]
    fn share_urls_use_the_origin_and_encode_the_provider() {
        assert_eq!(
            relay_share_urls(
                "claude",
                "p 1",
                Some(&json!(" https://PUBLIC.example:8443/ignored/path?q=1 "))
            ),
            Some(RelayShareUrls {
                base: "https://public.example:8443".into(),
                relay_base_url: "https://public.example:8443/claude-proxy/p%201/remote".into(),
            })
        );
        assert_eq!(
            relay_share_urls("codex", "p/1", Some(&json!("http://h:80"))),
            Some(RelayShareUrls {
                base: "http://h".into(),
                relay_base_url: "http://h/codex-proxy/p%2F1".into(),
            })
        );
        assert_eq!(
            relay_share_urls("claude", "p", Some(&json!("ftp://h"))),
            None
        );
        assert_eq!(
            relay_share_urls("claude", "p", Some(&json!("not a url"))),
            None
        );
        assert_eq!(relay_share_urls("claude", "p", Some(&json!(42))), None);
        assert_eq!(relay_share_urls("claude", "p", None), None);
    }

    #[test]
    fn delete_plan_and_bodies() {
        assert_eq!(plan_delete(0, false, false), DeletePlan::Delete);
        assert_eq!(plan_delete(2, false, true), DeletePlan::InUse);
        assert_eq!(plan_delete(2, true, false), DeletePlan::InUse);
        assert_eq!(plan_delete(2, true, true), DeletePlan::Detach);

        assert_eq!(
            js_json_stringify(&provider_in_use_response(
                &json!([{ "kind": "session" }]),
                true
            )),
            r#"{"error":"provider is still referenced","code":"PROVIDER_IN_USE","references":[{"kind":"session"}],"forceable":true}"#
        );
        assert_eq!(
            js_json_stringify(&detach_failed_response(&json!(["a"]), &json!(["b"]))),
            r#"{"error":"provider references could not all be detached","code":"PROVIDER_DETACH_FAILED","references":["a"],"detached":["b"],"forceable":false}"#
        );
        assert_eq!(
            js_json_stringify(&delete_response(true, true, &json!(["a"]))),
            r#"{"ok":true,"forced":true,"detached":["a"]}"#
        );
        assert_eq!(
            js_json_stringify(&delete_response(false, false, &json!([]))),
            r#"{"ok":false}"#
        );
    }

    #[test]
    fn reassign_validation_order() {
        assert!(is_valid_app_type("claude"));
        assert!(is_valid_app_type("codex"));
        assert!(!is_valid_app_type("Claude"));
        assert!(!is_valid_app_type("opencode"));

        assert_eq!(reassign_target_id(None), None);
        assert_eq!(reassign_target_id(Some(&Value::Null)), None);
        assert_eq!(reassign_target_id(Some(&json!(""))), None);
        assert_eq!(reassign_target_id(Some(&json!(" p "))), Some("p".into()));
        assert_eq!(reassign_target_id(Some(&json!(" "))), Some("".into()));
        assert_eq!(
            reassign_target_id(Some(&json!(["a", "b"]))),
            Some("a,b".into())
        );
        assert_eq!(reassign_target_id(Some(&json!(0))), Some("0".into()));
        assert_eq!(
            reassign_target_id(Some(&json!({}))),
            Some("[object Object]".into())
        );

        assert!(reassign_dry_run(Some(&body(json!({ "dryRun": true })))));
        assert!(reassign_dry_run(Some(&body(json!({ "dryRun": "1" })))));
        assert!(reassign_dry_run(Some(&body(json!({ "dryRun": "true" })))));
        assert!(!reassign_dry_run(Some(&body(json!({ "dryRun": "TRUE" })))));
        assert!(!reassign_dry_run(None));

        assert_eq!(
            reassign_precheck("p", Some("p"), true),
            Err((400, "target provider must differ from the source"))
        );
        assert_eq!(
            reassign_precheck("p", Some(""), false),
            Err((400, "targetProviderId is required"))
        );
        assert_eq!(
            reassign_precheck("p", None, false),
            Err((400, "targetProviderId is required"))
        );
        assert_eq!(reassign_precheck("p", None, true), Ok(()));
        assert_eq!(reassign_precheck("p", Some("q"), false), Ok(()));
        // An empty target is falsy and is not required on a dry run either.
        assert_eq!(reassign_precheck("p", Some(""), true), Ok(()));
    }

    #[test]
    fn defaults_updates_and_merge_keep_the_two_keys_in_order() {
        assert!(defaults_updates(None).is_empty());
        let updates = defaults_updates(Some(&body(json!({
            "codex": "c",
            "other": 1,
            "claude": null
        }))));
        assert_eq!(
            updates,
            vec![
                ("claude".to_string(), Value::Null),
                ("codex".to_string(), json!("c")),
            ]
        );
        assert_eq!(
            js_json_stringify(&Value::Object(merge_defaults(&updates))),
            r#"{"claude":null,"codex":"c"}"#
        );
        assert_eq!(
            invalid_defaults_error("codex"),
            json!({ "error": "invalid codex provider id" })
        );
    }

    #[test]
    fn catalog_body_orders_the_members_and_derives_cc_switch() {
        let facts = json!({
            "ok": true,
            "ccSwitchStatus": { "available": false, "path": "/x" },
            "providers": [{ "id": "p" }],
            "stats": { "total": { "turnCount": 1 } },
            "defaults": { "claude": null, "codex": null },
            "limitCacheStaleMs": 60000
        });
        assert_eq!(
            js_json_stringify(&catalog_body(&facts)),
            r#"{"available":true,"ccSwitchAvailable":false,"ccSwitchStatus":{"available":false,"path":"/x"},"providers":[{"id":"p"}],"defaults":{"claude":null,"codex":null},"stats":{"total":{"turnCount":1}},"limitCacheStaleMs":60000}"#
        );
        // A host answer with no cache still carries `limitCacheStaleMs: null`.
        assert_eq!(
            js_json_stringify(&catalog_body(&json!({
                "ccSwitchStatus": { "available": true },
                "providers": [],
                "defaults": {},
                "stats": {},
                "limitCacheStaleMs": null
            }))),
            r#"{"available":true,"ccSwitchAvailable":true,"ccSwitchStatus":{"available":true},"providers":[],"defaults":{},"stats":{},"limitCacheStaleMs":null}"#
        );
        // Unknown members are dropped; an absent status drops its derived key.
        assert_eq!(
            js_json_stringify(&catalog_body(&json!({ "extra": 1 }))),
            r#"{"available":true}"#
        );
    }
}
