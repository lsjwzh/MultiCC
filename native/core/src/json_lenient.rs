//! 宽松 JSON 解码：旧 JS 截断 emoji 留下的孤立代理项转义（\ud800 等）在 serde
//! 面前是非法 JSON。这里在解析前单遍扫描字符串字面量，把孤立代理项改成等长的
//! �；合法代理对和字面反斜杠保持原样。
use std::borrow::Cow;

pub fn from_str<T: serde::de::DeserializeOwned>(s: &str) -> serde_json::Result<T> {
    serde_json::from_str(&sanitize(s))
}

pub fn from_slice<T: serde::de::DeserializeOwned>(b: &[u8]) -> serde_json::Result<T> {
    // 非法 UTF-8 按 Node 读文件的口径替换成 U+FFFD；合法输入零拷贝。
    let text = String::from_utf8_lossy(b);
    from_str(&text)
}

fn hex4(bytes: &[u8], at: usize) -> Option<u32> {
    let mut value = 0u32;
    for k in 0..4 {
        value = value * 16 + (*(bytes.get(at + k)?) as char).to_digit(16)?;
    }
    Some(value)
}

fn replace_at(out: &mut Option<String>, input: &str, copied: &mut usize, at: usize) {
    let target = out.get_or_insert_with(String::new);
    target.push_str(&input[*copied..at]);
    target.push_str("\\ufffd");
    *copied = at + 6;
}

// 只认字符串内部的转义；字面反斜杠（\\u...）不会被误判。
fn sanitize(input: &str) -> Cow<'_, str> {
    let bytes = input.as_bytes();
    let mut out: Option<String> = None;
    let mut copied = 0usize;
    let mut i = 0usize;
    let mut in_string = false;
    while i < bytes.len() {
        let c = bytes[i];
        if !in_string {
            if c == b'"' {
                in_string = true;
            }
            i += 1;
            continue;
        }
        if c == b'"' {
            in_string = false;
            i += 1;
            continue;
        }
        if c != b'\\' {
            i += 1;
            continue;
        }
        match bytes.get(i + 1) {
            Some(b'u') => (),
            // 普通转义（含 \" 与 \\）：跳过被转义字符，避免把它的引号当结束。
            Some(_) => {
                i += 2;
                continue;
            }
            None => {
                i += 1;
                continue;
            }
        }
        let Some(code) = hex4(bytes, i + 2) else {
            // 非法/截断的转义原样交给 serde 报错。
            i += 1;
            continue;
        };
        i = if (0xD800..=0xDBFF).contains(&code) {
            let low = if bytes.get(i + 6) == Some(&b'\\') && bytes.get(i + 7) == Some(&b'u') {
                hex4(bytes, i + 8).filter(|low| (0xDC00..=0xDFFF).contains(low))
            } else {
                None
            };
            match low {
                // 合法代理对原样保留。
                Some(_) => i + 12,
                None => {
                    replace_at(&mut out, input, &mut copied, i);
                    i + 6
                }
            }
        } else if (0xDC00..=0xDFFF).contains(&code) {
            replace_at(&mut out, input, &mut copied, i);
            i + 6
        } else {
            i + 6
        };
    }
    match out {
        Some(mut value) => {
            value.push_str(&input[copied..]);
            Cow::Owned(value)
        }
        None => Cow::Borrowed(input),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn decode(s: &str) -> Value {
        from_str(s).unwrap()
    }

    #[test]
    fn lone_high_surrogate_becomes_replacement() {
        assert_eq!(decode(r#""\ud800""#), json!("\u{fffd}"));
    }

    #[test]
    fn lone_low_surrogate_becomes_replacement() {
        assert_eq!(decode(r#""\udc00""#), json!("\u{fffd}"));
    }

    #[test]
    fn valid_pair_is_preserved() {
        assert_eq!(decode(r#""😀""#), json!("😀"));
    }

    #[test]
    fn high_surrogate_at_string_end() {
        assert_eq!(decode(r#""x\ud800""#), json!("x\u{fffd}"));
    }

    #[test]
    fn literal_backslash_is_untouched() {
        let input = r#""\\ud800""#;
        assert_eq!(decode(input), json!(r"\ud800"));
        assert!(matches!(sanitize(input), Cow::Borrowed(_)));
    }

    #[test]
    fn escaped_backslash_then_lone_surrogate_is_replaced() {
        let out = sanitize(r#""\\\ud800""#);
        assert_eq!(decode(r#""\\\ud800""#), json!("\\\u{fffd}"));
        assert_eq!(out.matches('\\').count(), 3);
        assert!(out.contains("ufffd"));
    }

    #[test]
    fn surrogate_in_key_is_replaced() {
        let value = decode(r#"{"\ud800":1}"#);
        assert_eq!(value, json!({"\u{fffd}": 1}));
    }

    #[test]
    fn clean_input_stays_borrowed() {
        assert!(matches!(sanitize(r#"{"a":"b"}"#), Cow::Borrowed(_)));
    }

    #[test]
    fn invalid_utf8_bytes_become_replacement_chars() {
        assert_eq!(from_slice::<Value>(b"\"\xff\"").unwrap(), json!("\u{fffd}"));
        assert!(from_slice::<Value>(b"{\"a\": 1\xff}").is_err());
    }

    #[test]
    fn truncated_escape_is_left_for_serde() {
        assert!(from_str::<Value>(r#""\u12""#).is_err());
    }

    #[test]
    fn utf8_text_outside_strings_is_copied() {
        assert_eq!(decode("{\"x\":\"好\\ud800\"}"), json!({"x":"好\u{fffd}"}));
    }
}
