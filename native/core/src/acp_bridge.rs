//! ACP bridge data rules. Transport and session orchestration remain in the
//! existing bridge until the native event loop has passed differential tests.
//! These functions operate on JSON-compatible data, not arbitrary live JS.
use crate::js::{self, JsValue as V};

/// Gateway subcommands used by the adapter when selecting a process to launch.
pub const BRIDGE_COMMAND: &str = "acp-bridge";
pub const MODEL_ERROR_COMMAND: &str = "acp-model-error";

const ROUTER_ENV_KEYS: [&str; 6] = [
    "MULTICC_SESSION_ID",
    "MULTICC_BASE_URL",
    "MULTICC_TURN_ID",
    "MULTICC_ORIGIN_DISPATCH_ID",
    "MULTICC_ROUTER_CAPABILITY",
    "MULTICC_IMAGE_BRIDGE",
];

fn get(value: &V, key: &str) -> V {
    value.get(key).cloned().unwrap_or(V::Undefined)
}
fn text(value: &str) -> V {
    V::string(value)
}
fn obj(entries: Vec<(&str, V)>) -> V {
    V::object(entries)
}
fn set(fields: &mut Vec<(&'static str, V)>, key: &'static str, value: V) {
    if let Some((_, existing)) = fields.iter_mut().find(|(name, _)| *name == key) {
        *existing = value;
    } else {
        fields.push((key, value));
    }
}

/// Match the bridge's argv parser for operating-system string arguments.
pub fn parse_args(args: &[String]) -> Result<V, &'static str> {
    let mut fields = vec![
        ("agentArgs", V::Array(vec![])),
        ("resident", V::Bool(false)),
        ("label", text("ACP")),
    ];
    let mut agent_args = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let flag = args[i].as_str();
        if flag == "--" {
            set(&mut fields, "prompt", text(&args[i + 1..].join(" ")));
            break;
        }
        if flag == "--resident" {
            set(&mut fields, "resident", V::Bool(true));
        } else if flag == "--router-mcp" {
            i += 1;
            let command = args.get(i).map_or(V::Undefined, |v| text(v));
            i += 1;
            let script = args.get(i).map_or(V::Undefined, |v| text(v));
            set(
                &mut fields,
                "routerMcp",
                obj(vec![("command", command), ("script", script)]),
            );
        } else if let Some(key) = match flag {
            "--agent-bin" => Some("agentBin"),
            "--agent-arg" => Some("agentArgs"),
            "--label" => Some("label"),
            "--native-usage" => Some("nativeUsage"),
            "--session-id" => Some("sessionId"),
            "--model" => Some("model"),
            "--mode" => Some("mode"),
            "--effort" => Some("effort"),
            _ => None,
        } {
            i += 1;
            let value = args.get(i).map_or(V::Undefined, |v| text(v));
            if key == "agentArgs" {
                agent_args.push(value);
            } else {
                set(&mut fields, key, value);
            }
        }
        i += 1;
    }
    set(&mut fields, "agentArgs", V::Array(agent_args));
    let output = obj(fields);
    if !js::truthy(&get(&output, "agentBin")) {
        return Err("missing --agent-bin");
    }
    if !js::truthy(&get(&output, "resident")) && !js::truthy(&get(&output, "prompt")) {
        return Err("missing prompt");
    }
    Ok(output)
}

/// Environment entries are explicitly passed to the router server in fixed order.
pub fn router_servers(router: &V, env: &V) -> V {
    let command = get(router, "command");
    let script = get(router, "script");
    if !js::truthy(&command) || !js::truthy(&script) {
        return V::Array(vec![]);
    }
    let entries = ROUTER_ENV_KEYS
        .iter()
        .filter_map(|key| {
            let value = get(env, key);
            js::truthy(&value).then(|| {
                obj(vec![
                    ("name", text(key)),
                    ("value", V::String(js::js_to_string(&value))),
                ])
            })
        })
        .collect();
    V::Array(vec![obj(vec![
        ("name", text("multicc_router")),
        ("command", command),
        ("args", V::Array(vec![script])),
        ("env", V::Array(entries)),
    ])])
}

/// Return the chosen original permission option, including unknown option fields.
pub fn pick_permission(options: &V) -> V {
    let V::Array(list) = options else {
        return V::Null;
    };
    let find = |kind: &str| list.iter().find(|item| get(item, "kind") == text(kind));
    let option = find("allow_always")
        .or_else(|| find("allow_once"))
        .or_else(|| {
            list.iter().find(|item| {
                let kind = get(item, "kind");
                let value = if js::truthy(&kind) { kind } else { text("") };
                js::js_to_string(&value)
                    .to_string_lossy()
                    .starts_with("allow")
            })
        })
        .or_else(|| list.first().filter(|v| js::truthy(v)));
    option.cloned().unwrap_or(V::Null)
}

pub fn normalize_usage(usage: &V) -> V {
    if !matches!(usage, V::Object(_) | V::Array(_)) {
        return V::Null;
    }
    let n = |name| {
        let value = get(usage, name);
        V::Number(js::js_to_number(if js::truthy(&value) {
            &value
        } else {
            &V::Number(0.0)
        }))
    };
    let mut result = vec![
        ("input_tokens", n("inputTokens")),
        ("output_tokens", n("outputTokens")),
        ("cache_read_input_tokens", n("cachedReadTokens")),
        ("cache_creation_input_tokens", n("cachedWriteTokens")),
    ];
    if !get(usage, "thoughtTokens").is_nullish() {
        result.push(("reasoning_output_tokens", n("thoughtTokens")));
    }
    obj(result)
}

/// Encode one JSON-RPC message with the same field order as the Node writer.
pub fn rpc_frame(message: &V) -> V {
    let mut result = vec![(js::JsString::from("jsonrpc"), text("2.0"))];
    if let V::Object(fields) = message {
        for (key, value) in fields {
            if key == "jsonrpc" {
                result[0].1 = value.clone();
            } else {
                result.push((key.clone(), value.clone()));
            }
        }
    }
    V::Object(result)
}

/// Produce the same error frame when an OpenCode model is unavailable, without
/// starting a JavaScript process solely to print the failure.
pub fn blocked_model_event(model: &str, suggestion: &str, legacy: bool) -> V {
    let mut message = format!("模型 {model} 已不在可用列表中（可能已下架或改名）。");
    if !suggestion.is_empty() {
        message.push_str(&format!("建议改用 {suggestion}。"));
    }
    if legacy {
        obj(vec![
            ("type", text("error")),
            (
                "error",
                obj(vec![(
                    "data",
                    obj(vec![
                        ("message", text(&message)),
                        ("code", text("invalid_request_model")),
                        ("category", text("invalid_request_model")),
                        ("statusCode", V::Number(404.0)),
                    ]),
                )]),
            ),
        ])
    } else {
        obj(vec![
            ("method", text("multicc/error")),
            (
                "params",
                obj(vec![
                    ("message", text(&message)),
                    ("code", text("invalid_request_model")),
                    ("category", text("invalid_request_model")),
                ]),
            ),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn argv_defaults_and_required_fields() {
        assert_eq!(parse_args(&[]), Err("missing --agent-bin"));
        assert_eq!(
            parse_args(&["--agent-bin".into(), "agy".into()]),
            Err("missing prompt")
        );
        let args = [
            "--agent-bin",
            "agy",
            "--agent-arg",
            "acp",
            "--",
            "hello",
            "world",
        ]
        .map(str::to_string);
        let parsed = parse_args(&args).unwrap();
        assert_eq!(get(&parsed, "agentArgs"), V::Array(vec![text("acp")]));
        assert_eq!(get(&parsed, "prompt"), text("hello world"));
    }
    #[test]
    fn permission_priority_and_fallback() {
        let options = V::Array(vec![
            obj(vec![("kind", text("allow_once"))]),
            obj(vec![("kind", text("allow_always"))]),
        ]);
        assert_eq!(
            get(&pick_permission(&options), "kind"),
            text("allow_always")
        );
        assert_eq!(pick_permission(&V::Array(vec![])), V::Null);
    }
    #[test]
    fn env_filters_and_preserves_order() {
        let env = obj(vec![
            ("MULTICC_TURN_ID", text("2")),
            ("MULTICC_SESSION_ID", text("1")),
            ("OTHER", text("secret")),
        ]);
        let servers = router_servers(
            &obj(vec![("command", text("node")), ("script", text("x"))]),
            &env,
        );
        let V::Array(items) = servers else { panic!() };
        let V::Array(entries) = get(&items[0], "env") else {
            panic!()
        };
        assert_eq!(get(&entries[0], "name"), text("MULTICC_SESSION_ID"));
        assert_eq!(entries.len(), 2);
    }
    #[test]
    fn usage_number_coercion_and_missing_thought() {
        let output = normalize_usage(&obj(vec![
            ("inputTokens", text("7")),
            ("thoughtTokens", V::Null),
        ]));
        assert_eq!(get(&output, "input_tokens"), V::Number(7.0));
        assert_eq!(get(&output, "reasoning_output_tokens"), V::Undefined);
    }
}
