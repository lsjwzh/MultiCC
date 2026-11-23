//! The cc-switch-shaped `settingsConfig` a provider record stores, retired from
//! `src/providers/core.js`: model-list parsing, the Codex responses-compat hop,
//! the per-tier alias env map, the bounded Zhipu fable fill, and the
//! `apiFormat` normalization/validation pair.
//!
//! Everything here is a pure value transform. The two live facts the retired
//! code read from its process -- the loopback port (`process.env.PORT || 3000`)
//! and the caller-supplied provider id -- are parameters, so the front door
//! never has to guess what the Node process would have seen.

use serde_json::{json, Map, Value};

use crate::js::js_trim;
use crate::js::serde::js_string;

pub const API_FORMAT_ANTHROPIC: &str = "anthropic";
pub const API_FORMAT_OPENAI_RESPONSES: &str = "openai_responses";

/// Providers that expose `/responses` but need a local compatibility hop for
/// Codex streaming. XFYun MaaS Coding returns a Responses-shaped stream, but
/// long Codex turns can close before Codex observes `response.completed`; the
/// proxy keeps the wire stable and injects only the missing terminal event.
const RESPONSES_COMPAT_PROXY_MAP: &[(&str, &str)] = &[(
    "maas-coding-api.cn-huabei-1.xf-yun.com",
    "https://maas-coding-api.cn-huabei-1.xf-yun.com/v1/responses",
)];

/// Tier -> env key for the per-tier model-mapping UI. Lets a user point Claude
/// Code's internal opus/sonnet/haiku/fable resolution at specific wire models
/// for a relay, instead of only the single `ANTHROPIC_MODEL`.
///
/// The order is the retired `Object.entries(ALIAS_TIER_KEYS)` order, which is
/// the insertion order of the object literal -- it decides the key order of the
/// produced `env`, so it is part of the stored bytes.
pub const ALIAS_TIER_KEYS: &[(&str, &str)] = &[
    ("opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"),
    ("sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"),
    ("haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
    ("fable", "ANTHROPIC_DEFAULT_FABLE_MODEL"),
];

/// Official Zhipu (GLM) claude providers: bounded fable-tier alias fill. The
/// fable tier maps to GLM-5.3 (wire id `glm-5.3`); a Zhipu provider with an
/// unmapped fable tier would leave Claude Code resolving `fable` to a `claude-*`
/// wire name that open.bigmodel.cn / api.z.ai reject.
const ZHIPU_FABLE_MODEL: &str = "glm-5.3";
const ZHIPU_FABLE_NAME: &str = "GLM5.3";

/// `uniqueModels`: `String(x || '').trim()`, dropping empties and duplicates
/// while keeping first-seen order.
pub fn unique_models(values: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in values {
        let text = if truthy_value(raw) {
            js_trim(&js_string(raw)).to_string()
        } else {
            // `x || ''` -- a falsy member becomes the empty string, which the
            // filter below drops. `String(0)` would have been "0".
            String::new()
        };
        if !text.is_empty() && !out.iter().any(|seen| seen == &text) {
            out.push(text);
        }
    }
    out
}

fn truthy_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|n| n != 0.0 && !n.is_nan()) == Some(true),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `parseModelList`: an array is taken as-is, anything else is `String(x || '')`
/// split on newlines and commas. The primary model always leads.
pub fn parse_model_list(models: Option<&Value>, primary: Option<&Value>) -> Vec<String> {
    let mut values: Vec<Value> = Vec::new();
    values.push(primary.cloned().unwrap_or(Value::Null));
    match models {
        Some(Value::Array(items)) => values.extend(items.iter().cloned()),
        other => {
            let text = match other {
                Some(value) if truthy_value(value) => js_string(value),
                _ => String::new(),
            };
            values.extend(
                text.split(['\n', ','])
                    .map(|part| Value::String(part.to_string())),
            );
        }
    }
    unique_models(&values)
}

/// `detectResponsesCompatTarget`: the local hop for a base URL whose host is in
/// the compat map. A URL the `URL` constructor rejects has no host and so no
/// hop.
pub fn detect_responses_compat_target(base_url: Option<&str>) -> Option<&'static str> {
    let base_url = base_url?;
    if base_url.is_empty() {
        return None;
    }
    let host = url_host(base_url)?;
    RESPONSES_COMPAT_PROXY_MAP
        .iter()
        .find(|(candidate, _)| *candidate == host)
        .map(|(_, target)| *target)
}

/// The `host` (authority minus userinfo, port included) of an absolute URL, or
/// `None` when `new URL(value)` would have thrown. Mirrors the WHATWG parse far
/// enough for the membership test above: a relative or scheme-less value throws
/// there and is rejected here.
fn url_host(value: &str) -> Option<String> {
    let (scheme, rest) = value.split_once(':')?;
    if scheme.is_empty()
        || !scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    let rest = rest.strip_prefix("//")?;
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .expect("split always yields one part");
    let host = match authority.rsplit_once('@') {
        Some((_, host)) => host,
        None => authority,
    };
    if host.is_empty() {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

/// The bounded Zhipu fable mapping, as the read path needs it.
pub fn zhipu_fable_alias() -> Value {
    json!({ "model": ZHIPU_FABLE_MODEL, "name": ZHIPU_FABLE_NAME })
}

/// `applyAliasMapToEnv`: writes each tier's wire model (and optional display
/// name) into `env`, or deletes both keys when the tier has no model. A plain
/// string entry is the model itself; an object entry carries `{ model, name }`.
pub fn apply_alias_map_to_env(env: &mut Map<String, Value>, alias_map: Option<&Value>) {
    // `if (!aliasMap || typeof aliasMap !== 'object') return;` -- so `null`,
    // `undefined`, `''`, `0` and any primitive leave the env untouched, while an
    // *array* passes the guard: it is a truthy object, every `aliasMap[tier]`
    // reads as undefined, and the loop therefore deletes all four tiers.
    let alias_map = match alias_map {
        Some(Value::Object(map)) => Some(map),
        Some(Value::Array(_)) => None,
        _ => return,
    };
    for (tier, key) in ALIAS_TIER_KEYS {
        let entry = alias_map.and_then(|map| map.get(*tier));
        let (model, name) = match entry {
            Some(Value::Object(fields)) => (
                fields.get("model").cloned().unwrap_or(Value::Null),
                fields.get("name").cloned().unwrap_or(Value::Null),
            ),
            Some(value) => (value.clone(), Value::Null),
            None => (Value::Null, Value::Null),
        };
        let model = if truthy_value(&model) {
            js_string(&model)
        } else {
            String::new()
        };
        let name = if truthy_value(&name) {
            js_string(&name)
        } else {
            String::new()
        };
        let name_key = format!("{key}_NAME");
        if !js_trim(&model).is_empty() {
            env.insert(
                (*key).to_string(),
                Value::String(js_trim(&model).to_string()),
            );
            if !js_trim(&name).is_empty() {
                env.insert(name_key, Value::String(js_trim(&name).to_string()));
            } else {
                env.shift_remove(&name_key);
            }
        } else {
            env.shift_remove(*key);
            env.shift_remove(&name_key);
        }
    }
}

/// Whether a base URL belongs to Zhipu. Matches the retired string surgery
/// exactly: only `http://` / `https://` are stripped, the authority is taken up
/// to the first `/`, and the comparison is case-insensitive. A port or userinfo
/// therefore keeps it off the list, as before.
pub fn is_zhipu_base_url(base_url: Option<&Value>) -> bool {
    let text = match base_url {
        Some(value) if truthy_value(value) => js_string(value),
        _ => String::new(),
    };
    let rest = text
        .strip_prefix("https://")
        .or_else(|| text.strip_prefix("http://"))
        .unwrap_or(&text);
    let host = rest
        .split('/')
        .next()
        .expect("split always yields one part")
        .to_lowercase();
    host == "open.bigmodel.cn"
        || host == "api.z.ai"
        || host.ends_with(".bigmodel.cn")
        || host.ends_with(".z.ai")
}

/// `ensureZhipuFableAlias`: the strictly additive fable fill. Returns whether it
/// applied. Never overwrites a non-empty custom value, another tier, or a
/// non-Zhipu provider.
pub fn ensure_zhipu_fable_alias(env: &mut Map<String, Value>) -> bool {
    if !is_zhipu_base_url(env.get("ANTHROPIC_BASE_URL")) {
        return false;
    }
    let current = match env.get("ANTHROPIC_DEFAULT_FABLE_MODEL") {
        Some(value) if truthy_value(value) => js_string(value),
        _ => String::new(),
    };
    if !js_trim(&current).is_empty() {
        return false;
    }
    env.insert(
        "ANTHROPIC_DEFAULT_FABLE_MODEL".to_string(),
        Value::String(ZHIPU_FABLE_MODEL.to_string()),
    );
    env.insert(
        "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME".to_string(),
        Value::String(ZHIPU_FABLE_NAME.to_string()),
    );
    true
}

/// The format a pool pins, or `None` for an unknown `appType`.
pub fn api_format_for_app_type(app_type: Option<&str>) -> Option<&'static str> {
    match app_type {
        Some("claude") => Some(API_FORMAT_ANTHROPIC),
        Some("codex") => Some(API_FORMAT_OPENAI_RESPONSES),
        _ => None,
    }
}

/// The spelling an explicit `apiFormat` asks for. Legacy spellings that mean
/// Anthropic Messages are folded; everything else (including `openai_chat`) is
/// OpenAI Responses.
fn asked_api_format(value: Option<&Value>) -> &'static str {
    let raw = match value {
        Some(value) if truthy_value(value) => js_string(value),
        _ => String::new(),
    };
    let raw = js_trim(&raw).to_lowercase();
    let raw = collapse_space_and_dash(&raw);
    if raw == "anthropic" || raw == "messages" || raw == "anthropic_messages" {
        API_FORMAT_ANTHROPIC
    } else {
        API_FORMAT_OPENAI_RESPONSES
    }
}

/// `.replace(/[\s-]+/g, '_')`: each run of whitespace or `-` becomes one `_`.
/// JavaScript's `\s` includes the Unicode space separators and the BOM, not just
/// ASCII whitespace.
fn collapse_space_and_dash(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for ch in text.chars() {
        if is_js_space(ch) || ch == '-' {
            if !in_run {
                out.push('_');
                in_run = true;
            }
        } else {
            out.push(ch);
            in_run = false;
        }
    }
    out
}

fn is_js_space(ch: char) -> bool {
    matches!(
        ch,
        ' ' | '\t' | '\n' | '\r' | '\u{000b}' | '\u{000c}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `normalizeApiFormat`: the pool's pinned format wins; only an unknown pool
/// falls through to reading the requested spelling.
pub fn normalize_api_format(value: Option<&Value>, app_type: Option<&str>) -> &'static str {
    if let Some(fixed) = api_format_for_app_type(app_type) {
        return fixed;
    }
    asked_api_format(value)
}

/// `assertApiFormatMatchesAppType`: an explicit format that contradicts the pool
/// is a form bug (CLI=Codex + protocol=Anthropic), rejected rather than stored
/// as a row no lane can run. `undefined`, `null` and `''` mean "not specified".
pub fn assert_api_format_matches_app_type(
    api_format: Option<&Value>,
    app_type: Option<&str>,
) -> Result<(), String> {
    match api_format {
        None | Some(Value::Null) => return Ok(()),
        Some(Value::String(text)) if text.is_empty() => return Ok(()),
        _ => {}
    }
    let asked = asked_api_format(api_format);
    let Some(fixed) = api_format_for_app_type(app_type) else {
        return Ok(());
    };
    if asked == fixed {
        return Ok(());
    }
    Err(if app_type == Some("codex") {
        "Codex 线路只能用 OpenAI Responses 协议；Anthropic 协议的上游请建成 Claude 线路".to_string()
    } else {
        "Claude 线路只能用 Anthropic Messages 协议；OpenAI 协议的上游请建成 Codex 线路".to_string()
    })
}

/// The simple fields a `settingsConfig` is built from.
#[derive(Default)]
pub struct SettingsInput<'a> {
    pub base_url: Option<&'a Value>,
    pub auth_token: Option<&'a Value>,
    pub model: Option<&'a Value>,
    pub models: Option<&'a Value>,
    pub provider_id: Option<&'a Value>,
    pub alias_map: Option<&'a Value>,
    /// `process.env.PORT || 3000` as the Node process saw it.
    pub port: String,
}

fn model_catalog(models: &[String]) -> Value {
    json!({ "models": models.iter().map(|model| json!({ "model": model })).collect::<Vec<_>>() })
}

/// `buildSettingsConfig`: the cc-switch-shaped config for one pool.
///
/// The Claude branch is an env map plus a model catalog. The Codex branch emits
/// a TOML `config` string -- codex CLI (>= 0.130) only supports
/// `wire_api = "responses"`, so the only remaining local hop is
/// responses-compat for the hosts in the compat map, and the stored `base_url`
/// then points at the loopback proxy instead of the upstream.
pub fn build_settings_config(app_type: Option<&str>, input: &SettingsInput<'_>) -> Value {
    let models = parse_model_list(input.models, input.model);
    let base_url_text = match input.base_url {
        Some(value) if truthy_value(value) => js_string(value),
        _ => String::new(),
    };
    let auth_token_text = match input.auth_token {
        Some(value) if truthy_value(value) => js_string(value),
        _ => String::new(),
    };
    let model_text = match input.model {
        Some(value) if truthy_value(value) => js_string(value),
        _ => String::new(),
    };
    let base_url_truthy = input.base_url.map(truthy_value) == Some(true);
    let auth_token_truthy = input.auth_token.map(truthy_value) == Some(true);
    let model_truthy = input.model.map(truthy_value) == Some(true);

    if app_type == Some("claude") {
        let mut env = Map::new();
        if base_url_truthy {
            env.insert(
                "ANTHROPIC_BASE_URL".to_string(),
                input.base_url.cloned().unwrap_or(Value::Null),
            );
        }
        if auth_token_truthy {
            env.insert(
                "ANTHROPIC_AUTH_TOKEN".to_string(),
                input.auth_token.cloned().unwrap_or(Value::Null),
            );
        }
        if model_truthy {
            env.insert(
                "ANTHROPIC_MODEL".to_string(),
                input.model.cloned().unwrap_or(Value::Null),
            );
        }
        apply_alias_map_to_env(&mut env, input.alias_map);
        ensure_zhipu_fable_alias(&mut env);
        return json!({ "env": Value::Object(env), "modelCatalog": model_catalog(&models) });
    }

    let provider_name = "custom";
    let compat = detect_responses_compat_target(if base_url_truthy {
        Some(base_url_text.as_str())
    } else {
        None
    });
    let provider_id_truthy = input.provider_id.map(truthy_value) == Some(true);
    // `proxySpec && providerId`: without an id there is no loopback path to
    // write, so the upstream URL is stored as-is even for a compat host.
    let proxy_base_url = if compat.is_some() && provider_id_truthy {
        let provider_id = js_string(input.provider_id.expect("checked truthy"));
        Some(format!(
            "http://127.0.0.1:{}/codex-proxy/{provider_id}",
            input.port
        ))
    } else if base_url_truthy {
        Some(base_url_text.clone())
    } else {
        None
    };

    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("model_provider = \"{provider_name}\""));
    if model_truthy {
        lines.push(format!("model = \"{model_text}\""));
    }
    // The empty separator line is `''` in the retired array and is dropped by
    // `.filter(Boolean)` -- the stored TOML has no blank line here.
    lines.push(format!("[model_providers.{provider_name}]"));
    lines.push(format!("name = \"{provider_name}\""));
    if let Some(url) = proxy_base_url.as_ref() {
        if !url.is_empty() {
            lines.push(format!("base_url = \"{url}\""));
        }
    }
    if auth_token_truthy {
        lines.push("env_key = \"OPENAI_API_KEY\"".to_string());
    }
    lines.push("wire_api = \"responses\"".to_string());

    let auth = if !base_url_truthy && !auth_token_truthy {
        json!({ "auth_mode": "chatgpt" })
    } else if auth_token_truthy {
        json!({ "OPENAI_API_KEY": input.auth_token.cloned().unwrap_or(Value::Null) })
    } else {
        json!({ "OPENAI_API_KEY": Value::Null })
    };
    let mut cfg = Map::new();
    cfg.insert("auth".to_string(), auth);
    cfg.insert("config".to_string(), Value::String(lines.join("\n") + "\n"));
    cfg.insert("modelCatalog".to_string(), model_catalog(&models));
    if let Some(target) = compat {
        cfg.insert(
            "proxyTarget".to_string(),
            json!({
                "baseUrl": target,
                "apiKey": if auth_token_truthy { auth_token_text.clone() } else { String::new() },
                "originalBaseUrl": if base_url_truthy { base_url_text.clone() } else { String::new() },
                "mode": "responses-compat",
            }),
        );
    }
    Value::Object(cfg)
}

/// A Grok profile consists of one model table. Model IDs are TOML keys,
/// including when they contain dots, whitespace or quotes.
pub fn grok_model_config(model: &str, base_url: &str, api_backend: &str) -> String {
    use toml_edit::{value, DocumentMut, Item, Table};

    let mut entry = Table::new();
    entry["model"] = value(model);
    entry["base_url"] = value(base_url);
    entry["api_backend"] = value(api_backend);
    entry["env_key"] = value("MULTICC_GROK_API_KEY");

    let mut models = Table::new();
    models.set_implicit(true);
    models.insert(model, Item::Table(entry));
    let mut document = DocumentMut::new();
    document["model"] = Item::Table(models);
    document.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::serde::js_json_stringify;
    use serde_json::json;

    #[test]
    fn grok_models_round_trip_as_one_literal_table() {
        let base = "https://example.invalid/v1?q=\"x\"&s=路径";
        for model in ["grok-4", "grok.2", r#"引号 "和\路径"#] {
            let config = grok_model_config(model, base, "responses");
            let doc = config.parse::<toml_edit::DocumentMut>().unwrap();
            let models = doc["model"].as_table().unwrap();
            assert_eq!(models.len(), 1);
            let entry = models[model].as_table().unwrap();
            assert_eq!(entry.len(), 4);
            assert_eq!(entry["model"].as_str(), Some(model));
            assert_eq!(entry["base_url"].as_str(), Some(base));
            assert_eq!(entry["api_backend"].as_str(), Some("responses"));
            assert_eq!(entry["env_key"].as_str(), Some("MULTICC_GROK_API_KEY"));
        }
    }

    fn text(value: &str) -> Value {
        Value::String(value.to_string())
    }

    #[test]
    fn model_lists_keep_first_seen_order_and_drop_blanks_and_duplicates() {
        let models = json!(["b", " b ", "", "a", "b"]);
        assert_eq!(
            parse_model_list(Some(&models), Some(&text("a"))),
            vec!["a".to_string(), "b".to_string()]
        );
        // A non-array splits on newlines AND commas.
        let text_list = text("x,y\nz, x");
        assert_eq!(
            parse_model_list(Some(&text_list), None),
            vec!["x".to_string(), "y".to_string(), "z".to_string()]
        );
        // `String(x || '')`: a falsy non-array is the empty string, so only the
        // primary survives -- `0` does NOT become the model "0".
        assert_eq!(
            parse_model_list(Some(&json!(0)), Some(&text("a"))),
            vec!["a".to_string()]
        );
        // A falsy primary is dropped by the same `x || ''` chain.
        assert!(parse_model_list(None, Some(&json!(0))).is_empty());
        assert!(parse_model_list(None, None).is_empty());
    }

    #[test]
    fn the_compat_hop_only_matches_a_parseable_url_on_the_listed_host() {
        let listed = "https://maas-coding-api.cn-huabei-1.xf-yun.com/v1";
        assert_eq!(
            detect_responses_compat_target(Some(listed)),
            Some("https://maas-coding-api.cn-huabei-1.xf-yun.com/v1/responses")
        );
        // Host match is case-insensitive (the URL parser lowercases), but a
        // port makes it a different host.
        assert!(detect_responses_compat_target(Some(
            "https://MAAS-Coding-API.cn-huabei-1.xf-yun.com/v1"
        ))
        .is_some());
        assert!(detect_responses_compat_target(Some(
            "https://maas-coding-api.cn-huabei-1.xf-yun.com:443/v1"
        ))
        .is_none());
        // Userinfo is stripped before the comparison.
        assert!(detect_responses_compat_target(Some(
            "https://user:pw@maas-coding-api.cn-huabei-1.xf-yun.com/v1"
        ))
        .is_some());
        // `new URL(...)` throws on these, so there is no host and no hop.
        assert!(detect_responses_compat_target(Some("/v1/responses")).is_none());
        assert!(detect_responses_compat_target(Some("not a url")).is_none());
        assert!(detect_responses_compat_target(Some("")).is_none());
        assert!(detect_responses_compat_target(None).is_none());
        assert!(detect_responses_compat_target(Some("https://api.openai.com/v1")).is_none());
    }

    #[test]
    fn an_array_alias_map_passes_the_truthy_object_guard_and_clears_every_tier() {
        // Regression: an array is `typeof 'object'` and truthy in JavaScript, so
        // the retired loop ran and deleted all four tiers. Returning early here
        // would leave a stale mapping behind.
        let mut env = Map::new();
        env.insert("ANTHROPIC_MODEL".to_string(), text("keep-me"));
        env.insert("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(), text("stale"));
        env.insert(
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME".to_string(),
            text("Stale"),
        );
        apply_alias_map_to_env(&mut env, Some(&json!([])));
        assert_eq!(
            js_json_stringify(&Value::Object(env)),
            r#"{"ANTHROPIC_MODEL":"keep-me"}"#
        );

        // A primitive does not pass the guard: the stale mapping survives.
        let mut env = Map::new();
        env.insert("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(), text("stale"));
        apply_alias_map_to_env(&mut env, Some(&json!(42)));
        apply_alias_map_to_env(&mut env, Some(&Value::Null));
        apply_alias_map_to_env(&mut env, None);
        assert_eq!(
            js_json_stringify(&Value::Object(env)),
            r#"{"ANTHROPIC_DEFAULT_OPUS_MODEL":"stale"}"#
        );
    }

    #[test]
    fn alias_tiers_write_both_keys_or_delete_both() {
        let mut env = Map::new();
        env.insert("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(), text("stale"));
        env.insert("ANTHROPIC_DEFAULT_OPUS_MODEL_NAME".to_string(), text("Old"));
        apply_alias_map_to_env(
            &mut env,
            Some(&json!({
                "opus": null,
                "sonnet": { "model": " s-1 ", "name": " S One " },
                "haiku": "h-1",
                "fable": { "model": "f-1", "name": "   " },
            })),
        );
        // An emptied tier deletes the model AND the display name.
        assert!(!env.contains_key("ANTHROPIC_DEFAULT_OPUS_MODEL"));
        assert!(!env.contains_key("ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"));
        // Both halves are trimmed.
        assert_eq!(env["ANTHROPIC_DEFAULT_SONNET_MODEL"], text("s-1"));
        assert_eq!(env["ANTHROPIC_DEFAULT_SONNET_MODEL_NAME"], text("S One"));
        // A bare string entry is the model with no display name.
        assert_eq!(env["ANTHROPIC_DEFAULT_HAIKU_MODEL"], text("h-1"));
        assert!(!env.contains_key("ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME"));
        // A blank name leaves the model and drops only the name.
        assert_eq!(env["ANTHROPIC_DEFAULT_FABLE_MODEL"], text("f-1"));
        assert!(!env.contains_key("ANTHROPIC_DEFAULT_FABLE_MODEL_NAME"));
        // A non-object alias map is a no-op, not a clear.
        let mut kept = Map::new();
        kept.insert("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(), text("keep"));
        apply_alias_map_to_env(&mut kept, Some(&Value::Null));
        apply_alias_map_to_env(&mut kept, None);
        assert_eq!(kept["ANTHROPIC_DEFAULT_OPUS_MODEL"], text("keep"));
    }

    #[test]
    fn the_zhipu_fable_fill_is_additive_and_host_bounded() {
        let fill = |base: Option<&str>, existing: Option<&str>| {
            let mut env = Map::new();
            if let Some(base) = base {
                env.insert("ANTHROPIC_BASE_URL".to_string(), text(base));
            }
            if let Some(existing) = existing {
                env.insert("ANTHROPIC_DEFAULT_FABLE_MODEL".to_string(), text(existing));
            }
            let applied = ensure_zhipu_fable_alias(&mut env);
            (applied, env)
        };
        let (applied, env) = fill(Some("https://open.bigmodel.cn/api/anthropic"), None);
        assert!(applied);
        assert_eq!(env["ANTHROPIC_DEFAULT_FABLE_MODEL"], text("glm-5.3"));
        assert_eq!(env["ANTHROPIC_DEFAULT_FABLE_MODEL_NAME"], text("GLM5.3"));
        assert!(fill(Some("https://api.z.ai/api/anthropic"), None).0);
        assert!(fill(Some("https://sub.bigmodel.cn/x"), None).0);
        assert!(fill(Some("https://sub.z.ai/x"), None).0);
        // Case-insensitive host, scheme optional.
        assert!(fill(Some("API.Z.AI/x"), None).0);
        // Never overwrites a non-empty custom mapping.
        assert!(!fill(Some("https://api.z.ai/x"), Some("custom")).0);
        // A blank custom value is still unmapped, so the fill applies.
        assert!(fill(Some("https://api.z.ai/x"), Some("  ")).0);
        // Not Zhipu, and a port keeps it off the list (string surgery, not a
        // URL parse -- same as the retired rule).
        assert!(!fill(Some("https://api.anthropic.com"), None).0);
        assert!(!fill(Some("https://api.z.ai:443/x"), None).0);
        assert!(!fill(None, None).0);
    }

    #[test]
    fn api_format_normalization_pins_the_pool_and_folds_legacy_spellings() {
        assert_eq!(
            normalize_api_format(Some(&text("openai_chat")), Some("claude")),
            API_FORMAT_ANTHROPIC
        );
        assert_eq!(
            normalize_api_format(Some(&text("anthropic")), Some("codex")),
            API_FORMAT_OPENAI_RESPONSES
        );
        // Only an unknown pool reads the requested spelling.
        for spelling in ["anthropic", "messages", "anthropic_messages", "ANTHROPIC "] {
            assert_eq!(
                normalize_api_format(Some(&text(spelling)), None),
                API_FORMAT_ANTHROPIC,
                "{spelling}"
            );
        }
        // `[\s-]+` -> `_`, so a dashed or spaced spelling still folds.
        assert_eq!(
            normalize_api_format(Some(&text("anthropic-messages")), None),
            API_FORMAT_ANTHROPIC
        );
        assert_eq!(
            normalize_api_format(Some(&text("anthropic  messages")), None),
            API_FORMAT_ANTHROPIC
        );
        assert_eq!(
            normalize_api_format(Some(&text("openai_chat")), None),
            API_FORMAT_OPENAI_RESPONSES
        );
        assert_eq!(
            normalize_api_format(None, None),
            API_FORMAT_OPENAI_RESPONSES
        );
    }

    #[test]
    fn a_contradicting_api_format_is_rejected_per_pool() {
        // Unspecified in all three JavaScript spellings.
        assert!(assert_api_format_matches_app_type(None, Some("codex")).is_ok());
        assert!(assert_api_format_matches_app_type(Some(&Value::Null), Some("codex")).is_ok());
        assert!(assert_api_format_matches_app_type(Some(&text("")), Some("codex")).is_ok());
        // Agreeing and legacy-but-agreeing spellings pass.
        assert!(
            assert_api_format_matches_app_type(Some(&text("anthropic")), Some("claude")).is_ok()
        );
        assert!(
            assert_api_format_matches_app_type(Some(&text("openai_chat")), Some("codex")).is_ok()
        );
        assert!(
            assert_api_format_matches_app_type(Some(&text("messages")), Some("claude")).is_ok()
        );
        // Contradictions carry the pool's own message.
        assert_eq!(
            assert_api_format_matches_app_type(Some(&text("anthropic")), Some("codex")),
            Err(
                "Codex 线路只能用 OpenAI Responses 协议；Anthropic 协议的上游请建成 Claude 线路"
                    .to_string()
            )
        );
        assert_eq!(
            assert_api_format_matches_app_type(Some(&text("openai_responses")), Some("claude")),
            Err(
                "Claude 线路只能用 Anthropic Messages 协议；OpenAI 协议的上游请建成 Codex 线路"
                    .to_string()
            )
        );
        // An unknown pool pins nothing, so nothing contradicts it.
        assert!(assert_api_format_matches_app_type(Some(&text("anthropic")), None).is_ok());
    }

    #[test]
    fn the_claude_branch_stores_raw_values_in_insertion_order() {
        let base = text("https://api.z.ai/api/anthropic");
        let token = text("sk-1");
        let model = text("glm-4");
        let input = SettingsInput {
            base_url: Some(&base),
            auth_token: Some(&token),
            model: Some(&model),
            port: "3000".to_string(),
            ..Default::default()
        };
        let cfg = build_settings_config(Some("claude"), &input);
        // Key order is part of the stored bytes.
        assert_eq!(
            serde_json::to_string(&cfg).expect("json"),
            "{\"env\":{\"ANTHROPIC_BASE_URL\":\"https://api.z.ai/api/anthropic\",\
             \"ANTHROPIC_AUTH_TOKEN\":\"sk-1\",\"ANTHROPIC_MODEL\":\"glm-4\",\
             \"ANTHROPIC_DEFAULT_FABLE_MODEL\":\"glm-5.3\",\
             \"ANTHROPIC_DEFAULT_FABLE_MODEL_NAME\":\"GLM5.3\"},\
             \"modelCatalog\":{\"models\":[{\"model\":\"glm-4\"}]}}"
        );
        // Falsy fields are omitted entirely rather than stored as empties.
        let empty = build_settings_config(
            Some("claude"),
            &SettingsInput {
                port: "3000".to_string(),
                ..Default::default()
            },
        );
        assert_eq!(
            serde_json::to_string(&empty).expect("json"),
            "{\"env\":{},\"modelCatalog\":{\"models\":[]}}"
        );
    }

    #[test]
    fn the_codex_branch_emits_toml_without_the_dropped_blank_line() {
        let base = text("https://api.deepseek.com/v1");
        let token = text("sk-2");
        let model = text("deepseek-chat");
        let cfg = build_settings_config(
            Some("codex"),
            &SettingsInput {
                base_url: Some(&base),
                auth_token: Some(&token),
                model: Some(&model),
                port: "3000".to_string(),
                ..Default::default()
            },
        );
        assert_eq!(
            cfg["config"],
            text(concat!(
                "model_provider = \"custom\"\n",
                "model = \"deepseek-chat\"\n",
                "[model_providers.custom]\n",
                "name = \"custom\"\n",
                "base_url = \"https://api.deepseek.com/v1\"\n",
                "env_key = \"OPENAI_API_KEY\"\n",
                "wire_api = \"responses\"\n",
            ))
        );
        assert_eq!(cfg["auth"], json!({ "OPENAI_API_KEY": "sk-2" }));
        assert!(cfg.get("proxyTarget").is_none());
        // No base URL and no token at all = the ChatGPT OAuth mode.
        let oauth = build_settings_config(
            Some("codex"),
            &SettingsInput {
                port: "3000".to_string(),
                ..Default::default()
            },
        );
        assert_eq!(oauth["auth"], json!({ "auth_mode": "chatgpt" }));
        // A base URL without a token stores an explicit null key.
        let no_token = build_settings_config(
            Some("codex"),
            &SettingsInput {
                base_url: Some(&base),
                port: "3000".to_string(),
                ..Default::default()
            },
        );
        assert_eq!(no_token["auth"], json!({ "OPENAI_API_KEY": null }));
        assert!(!js_string(&no_token["config"]).contains("env_key"));
    }

    #[test]
    fn a_compat_host_rewrites_base_url_to_the_loopback_hop_only_with_an_id() {
        let base = text("https://maas-coding-api.cn-huabei-1.xf-yun.com/v1");
        let token = text("sk-3");
        let id = text("abc-1");
        let cfg = build_settings_config(
            Some("codex"),
            &SettingsInput {
                base_url: Some(&base),
                auth_token: Some(&token),
                provider_id: Some(&id),
                port: "8899".to_string(),
                ..Default::default()
            },
        );
        assert!(js_string(&cfg["config"])
            .contains("base_url = \"http://127.0.0.1:8899/codex-proxy/abc-1\""));
        assert_eq!(
            cfg["proxyTarget"],
            json!({
                "baseUrl": "https://maas-coding-api.cn-huabei-1.xf-yun.com/v1/responses",
                "apiKey": "sk-3",
                "originalBaseUrl": "https://maas-coding-api.cn-huabei-1.xf-yun.com/v1",
                "mode": "responses-compat",
            })
        );
        // Without an id there is no loopback path, so the upstream URL stays --
        // but the proxyTarget is still recorded.
        let no_id = build_settings_config(
            Some("codex"),
            &SettingsInput {
                base_url: Some(&base),
                auth_token: Some(&token),
                port: "8899".to_string(),
                ..Default::default()
            },
        );
        assert!(js_string(&no_id["config"])
            .contains("base_url = \"https://maas-coding-api.cn-huabei-1.xf-yun.com/v1\""));
        assert!(no_id.get("proxyTarget").is_some());
    }
}
