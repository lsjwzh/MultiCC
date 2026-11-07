//! The `.env` reader from `server.js` (the block that loads it before anything
//! else), reproduced exactly and shared with the Rust front door.
//!
//! Per line: `^\s*([^#=]+?)\s*=\s*(.*?)\s*$` (`\s` and `.` as JavaScript
//! spells them, lines split on `\n` only), and an existing environment value
//! wins only when it is truthy — an existing empty string is overwritten.

use regex::Regex;
use serde_json::{Map, Value};
use std::sync::OnceLock;

/// JS `\s`: WhiteSpace + LineTerminator, including U+FEFF and excluding U+0085.
const JS_SPACE: &str = r"[\t\n\u{b}\u{c}\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
/// JS `.`: everything but a line terminator.
const JS_DOT: &str = r"[^\n\r\u{2028}\u{2029}]";

fn line_regex() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        let pattern =
            format!("^{JS_SPACE}*([^#=]+?){JS_SPACE}*={JS_SPACE}*({JS_DOT}*?){JS_SPACE}*$");
        Regex::new(&pattern).expect("the .env line pattern is valid")
    })
}

/// One line as `server.js` reads it: `(key, value)` after surrounding JS
/// whitespace is trimmed. `None` for comments, blank lines and any line that
/// does not match.
pub fn parse_line(line: &str) -> Option<(&str, &str)> {
    let captures = line_regex().captures(line)?;
    Some((captures.get(1)?.as_str(), captures.get(2)?.as_str()))
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// Apply `text` to an env map, mirroring `if (m && !process.env[m[1]])`.
/// Later duplicate lines only win when the earlier value was falsy.
pub fn apply(text: &str, env: &mut Map<String, Value>) {
    for line in text.split('\n') {
        if let Some((key, value)) = parse_line(line) {
            if !js_truthy(env.get(key)) {
                env.insert(key.to_string(), Value::String(value.to_string()));
            }
        }
    }
}

/// Apply `text` to this process's environment and return the pairs that were
/// set, in order. `std::env` cannot hold a NUL, so such entries are skipped
/// (Node's `process.env` refuses them too).
pub fn apply_to_process_env(text: &str) -> Vec<(String, String)> {
    let mut applied = Vec::new();
    for line in text.split('\n') {
        let Some((key, value)) = parse_line(line) else {
            continue;
        };
        if key.contains('\0') || value.contains('\0') {
            continue;
        }
        let existing = std::env::var(key).ok();
        if existing.as_deref().is_none_or(str::is_empty) {
            std::env::set_var(key, value);
            applied.push((key.to_string(), value.to_string()));
        }
    }
    applied
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parsed(text: &str, existing: Value) -> Value {
        let Value::Object(mut env) = existing else {
            panic!("existing env must be an object");
        };
        apply(text, &mut env);
        Value::Object(env)
    }

    #[test]
    fn comments_blanks_and_missing_equals_are_ignored() {
        let text = "# comment\n\nFOO=bar\n  # indented comment\nNOEQUALS\n=value\n";
        assert_eq!(
            parsed(text, json!({ "FOO": "kept" })),
            json!({ "FOO": "kept" })
        );
    }

    #[test]
    fn whitespace_quotes_and_hashes_follow_the_js_regex() {
        let text = "  A  =  1  \nB=\"quoted\"\nC=value # not a comment\r\nD='x'\n";
        assert_eq!(
            parsed(text, json!({})),
            json!({ "A": "1", "B": "\"quoted\"", "C": "value # not a comment", "D": "'x'" })
        );
    }

    #[test]
    fn existing_truthy_values_win_but_empty_ones_do_not() {
        let text = "A=fromfile\nB=fromfile\nC=first\nC=second\n";
        assert_eq!(
            parsed(text, json!({ "A": "fromenv", "B": "", "C": "" })),
            json!({ "A": "fromenv", "B": "fromfile", "C": "first" })
        );
    }

    #[test]
    fn js_whitespace_is_trimmed_including_a_bom() {
        let text = "\u{feff}A\u{feff}=\u{a0}v\u{3000}\n";
        assert_eq!(parsed(text, json!({})), json!({ "A": "v" }));
    }

    #[test]
    fn a_js_line_terminator_inside_the_value_stops_the_match() {
        // JS `.` cannot cross U+2028, so the whole line is ignored.
        assert_eq!(parsed("A=x\u{2028}y\n", json!({})), json!({}));
        // A CRLF file is fine: the CR is whitespace.
        assert_eq!(
            parsed("A=x\r\nB=y\r\n", json!({})),
            json!({ "A": "x", "B": "y" })
        );
    }

    #[test]
    fn process_env_matches_the_same_rules() {
        let key = format!("MULTICC_DOTENV_TEST_{}", std::process::id());
        std::env::remove_var(&key);
        let text = format!("{key}=one\n{key}=two\n");
        let applied = apply_to_process_env(&text);
        // The first line sets a truthy value, so the duplicate is ignored.
        assert_eq!(applied, vec![(key.clone(), "one".to_string())]);
        assert_eq!(std::env::var(&key).unwrap(), "one");
        std::env::remove_var(&key);
    }
}
