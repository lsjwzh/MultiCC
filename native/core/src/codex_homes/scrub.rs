use super::*;
use crate::js::{self, JsString, JsValue};
use regex::Regex;
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    sync::LazyLock,
};

pub(super) const REDACT: &str = "[REDACTED_PROVIDER_ROUTE]";
pub(super) static CAP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"pr1\.[A-Za-z0-9_-]{1,344}\.[A-Za-z0-9_-]{1,344}").unwrap());
pub(super) fn capability(s: &str) -> &str {
    let s = js::js_trim(s);
    if CAP
        .find(s)
        .is_some_and(|m| m.start() == 0 && m.end() == s.len())
    {
        s
    } else {
        ""
    }
}
fn secrets(values: &[String]) -> Vec<String> {
    static TOKEN: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^proxy-route[-_][A-Za-z0-9_-]{8,256}$").unwrap());
    let mut names = HashSet::new();
    for v in values {
        let s = capability(v);
        let Some(encoded) = s.split('.').nth(2) else {
            continue;
        };
        names.insert(s.to_owned());
        names.insert(encoded.to_owned());
        if let Ok(token) = String::from_utf8(js::node_base64_decode(&encoded.into())) {
            if TOKEN.is_match(&token) {
                names.insert(token);
            }
        }
    }
    let mut names: Vec<_> = names.into_iter().collect();
    names.sort_by_key(|s| std::cmp::Reverse(s.len()));
    names
}
struct Token {
    start: usize,
    end: usize,
    value: JsString,
    key: bool,
    ranges: Vec<(usize, usize)>,
}
fn tokens(text: &str) -> Vec<Token> {
    let mut tokens = vec![];
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'"' {
            i += 1;
            continue;
        }
        let start = i;
        i += 1;
        while i < bytes.len() {
            match bytes[i] {
                b'\\' => {
                    i = (i + 2).min(bytes.len());
                }
                b'"' => {
                    i += 1;
                    if let Ok(JsValue::String(value)) = js::json_parse(&text[start..i]) {
                        tokens.push(Token {
                            start,
                            end: i,
                            value,
                            key: text[i..]
                                .trim_start_matches(js::is_js_whitespace_char)
                                .starts_with(':'),
                            ranges: vec![],
                        })
                    }
                    break;
                }
                _ => i += 1,
            }
        }
    }
    tokens
}
fn mark(tokens: &mut [Token], key: Option<bool>, secrets: &[String]) {
    let mut combined = vec![];
    let mut positions = vec![];
    for (i, t) in tokens
        .iter()
        .enumerate()
        .filter(|(_, t)| key.is_none_or(|k| t.key == k))
    {
        let start = combined.len();
        combined.extend_from_slice(t.value.as_units());
        positions.push((i, start, combined.len()))
    }
    for secret in secrets {
        let needle: Vec<u16> = secret.encode_utf16().collect();
        let finder = js::UnitFinder::new(&needle);
        let mut cursor = 0;
        while let Some(at) = finder.find(&combined, cursor) {
            let end = at + needle.len();
            let first = positions.partition_point(|(_, _, stop)| *stop <= at);
            for &(i, start, stop) in positions[first..]
                .iter()
                .take_while(|(_, start, _)| *start < end)
            {
                tokens[i]
                    .ranges
                    .push((at.saturating_sub(start), end.min(stop) - start));
            }
            cursor = at + 1
        }
    }
}
fn redact(input: &[u8], secrets: &[String]) -> Option<Vec<u8>> {
    let mut bytes = std::borrow::Cow::Borrowed(input);
    for s in secrets {
        let matches = memchr::memmem::find_iter(&bytes, s.as_bytes());
        let mut out = Vec::new();
        let mut prev = 0;
        for at in matches {
            out.extend_from_slice(&bytes[prev..at]);
            out.extend_from_slice(REDACT.as_bytes());
            prev = at + s.len()
        }
        if prev > 0 {
            out.extend_from_slice(&bytes[prev..]);
            bytes = std::borrow::Cow::Owned(out)
        }
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut tokens = tokens(&text);
    for group in [Some(false), Some(true), None] {
        mark(&mut tokens, group, secrets)
    }
    let mut out = String::new();
    let mut cursor = 0;
    for mut token in tokens.into_iter().filter(|t| !t.ranges.is_empty()) {
        token.ranges.sort_unstable();
        let mut value = JsString::new();
        let mut pos = 0;
        for (start, end) in token.ranges {
            if end > pos {
                value.push(&token.value.slice_units(pos, start.max(pos)));
                value.push_str(REDACT);
                pos = end
            }
        }
        value.push(&token.value.slice_units(pos, token.value.len()));
        out.push_str(&text[cursor..token.start]);
        out.push_str(&js::json_quote(&value));
        cursor = token.end;
    }
    if cursor > 0 {
        out.push_str(&text[cursor..]);
        Some(out.into_bytes())
    } else {
        drop(text);
        match bytes {
            std::borrow::Cow::Owned(bytes) => Some(bytes),
            _ => None,
        }
    }
}
pub(super) type Baseline = HashMap<PathBuf, Version>;
pub(super) fn snapshot(root: &Path) -> Result<Baseline> {
    let mut baseline = HashMap::new();
    for f in scan(root, ".jsonl", &mut 0, true)? {
        if let Some(v) = history_file::File::at(root, &f, false)?.version()? {
            baseline.insert(f, v);
        }
    }
    Ok(baseline)
}
fn changed() -> Error {
    Error::new(
        "CODEX_ATTEMPT_ROLLOUT_CHANGED",
        "Codex rollout changed during capability scrub",
    )
}
pub(super) fn changed_rollouts(
    root: &Path,
    caps: &[String],
    baseline: Option<&Baseline>,
    created: f64,
) -> Result<usize> {
    let secrets = secrets(caps);
    if secrets.is_empty() {
        return Ok(0);
    }
    let mut count = 0;
    for path in scan(root, ".jsonl", &mut 0, true)? {
        let file = history_file::File::at(root, &path, false)?;
        let Some(version) = file.version()? else {
            continue;
        };
        if baseline.map_or_else(
            || time_ms(version.mtime) < created.max(0.) - 1000.,
            |b| b.get(&path).is_some_and(|v| v.same_baseline(&version)),
        ) {
            continue;
        }
        let mut bytes = Vec::new();
        file.open()?.read_to_end(&mut bytes)?;
        let Some(output) = redact(&bytes, &secrets) else {
            continue;
        };
        let check = || {
            if file.version().ok().flatten().as_ref() == Some(&version) {
                Ok(())
            } else {
                Err(changed())
            }
        };
        check()?;
        file.publish(
            true,
            |temporary| {
                use std::io::Write;
                temporary.write_all(&output)?;
                Ok(())
            },
            check,
        )?;
        count += 1;
    }
    Ok(count)
}
