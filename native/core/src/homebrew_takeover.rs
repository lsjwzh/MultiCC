//! Homebrew ownership and npm takeover policy. Path resolution is a host fact.
use crate::js::{js_to_string, truthy, JsString, JsValue};
use regex::Regex;
use std::sync::LazyLock;

static OWNER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"/(Cellar|Caskroom)/([^/]+)/").unwrap());
static SAFE_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9@._+-]+$").unwrap());
static RUNTIME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(node|nodejs|npm)(@[0-9.]+)?$").unwrap());

fn get<'a>(value: &'a JsValue, key: &str) -> &'a JsValue {
    value.get(key).unwrap_or(&JsValue::Undefined)
}

pub fn is_npm_global_install(command: &str) -> bool {
    let mut rest = command.trim_start_matches(crate::js::is_js_whitespace_char);
    for token in ["npm", "install", "-g"] {
        let Some(next) = rest.strip_prefix(token) else {
            return false;
        };
        if !next
            .chars()
            .next()
            .is_some_and(crate::js::is_js_whitespace_char)
        {
            return false;
        }
        rest = next.trim_start_matches(crate::js::is_js_whitespace_char);
    }
    true
}

/// None tells the host to return the original command without losing identity.
pub fn takeover_command(owner: &JsValue, command: &JsValue) -> Option<JsString> {
    if !truthy(owner)
        || !truthy(command)
        || !is_npm_global_install(&js_to_string(command).to_string_lossy())
    {
        return None;
    }
    let mut out = JsString::from_rust_str("brew uninstall --");
    out.push(&js_to_string(get(owner, "kind")));
    out.push_str(" ");
    out.push(&js_to_string(get(owner, "name")));
    out.push_str(" && ");
    out.push(&js_to_string(command));
    Some(out)
}

pub fn request(op: &str, input: &JsValue) -> JsValue {
    match op {
        "owner" => {
            let real = js_to_string(get(input, "real")).to_string_lossy();
            let Some(found) = OWNER.captures(&real) else {
                return JsValue::Null;
            };
            let name = &found[2];
            let basename = js_to_string(get(input, "basename")).to_string_lossy();
            if !SAFE_NAME.is_match(name) || RUNTIME.is_match(name) || RUNTIME.is_match(&basename) {
                return JsValue::Null;
            }
            JsValue::object(vec![
                (
                    "kind",
                    JsValue::string(if &found[1] == "Caskroom" {
                        "cask"
                    } else {
                        "formula"
                    }),
                ),
                ("name", JsValue::string(name)),
                ("path", get(input, "resolved").clone()),
            ])
        }
        "npmGlobal" => {
            let command = get(input, "command");
            JsValue::Bool(
                truthy(command) && is_npm_global_install(&js_to_string(command).to_string_lossy()),
            )
        }
        "takeover" => takeover_command(get(input, "owner"), get(input, "command"))
            .map(JsValue::String)
            .unwrap_or(JsValue::Null),
        _ => JsValue::Undefined,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::from_serde;
    use serde_json::json;

    #[test]
    fn rejects_runtime_names_and_shell_metacharacters() {
        for (name, bin) in [
            ("node@22", "cli"),
            ("npm", "cli"),
            ("cli", "node"),
            ("x;echo injected", "cli"),
        ] {
            let input = from_serde(
                &json!({"real": format!("/opt/homebrew/Cellar/{name}/1/bin/{bin}"), "basename": bin, "resolved": format!("/opt/homebrew/bin/{bin}")}),
            );
            assert_eq!(request("owner", &input), JsValue::Null);
        }
    }

    #[test]
    fn resolves_owner_without_replacing_launch_path() {
        let input = from_serde(
            &json!({"real":"/opt/homebrew/Caskroom/codex/1/bin/codex","basename":"codex","resolved":"/opt/homebrew/bin/codex"}),
        );
        assert_eq!(
            request("owner", &input),
            from_serde(&json!({"kind":"cask","name":"codex","path":"/opt/homebrew/bin/codex"}))
        );
    }

    #[test]
    fn npm_gate_uses_javascript_whitespace_and_exact_tokens() {
        assert!(is_npm_global_install("\u{feff}npm\tinstall\n-g cli"));
        for command in [
            "npm install -g",
            "npmx install -g cli",
            "npm install --global cli",
            "curl install",
            "\u{85}npm install -g cli",
        ] {
            assert!(!is_npm_global_install(command));
        }
    }

    #[test]
    fn takeover_preserves_utf16_command_tail() {
        let owner = from_serde(&json!({"kind":"formula","name":"cli"}));
        let mut command = JsString::from_rust_str("npm install -g cli ");
        command.push_unit(0xd800);
        let actual = takeover_command(&owner, &JsValue::String(command)).unwrap();
        assert_eq!(actual.as_units().last(), Some(&0xd800));
        assert!(takeover_command(&JsValue::Null, &JsValue::string("npm install -g cli")).is_none());
    }
}
