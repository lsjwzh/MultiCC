//! Task-memory markdown is indexed in UTF-16 code units. Only the auto section
//! is capped; hand-written text on either side is retained.
use crate::js::{contains_units, is_js_whitespace, JsString as S};
use std::collections::HashSet;

pub const SECTION: &str = "## 自动蒸馏";
pub fn similar(a: &S, b: &S) -> bool {
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if contains_units(a.as_units(), b.as_units()) || contains_units(b.as_units(), a.as_units()) {
        return true;
    }
    fn grams(s: &S) -> HashSet<[u16; 2]> {
        s.as_units().windows(2).map(|p| [p[0], p[1]]).collect()
    }
    let (left, right) = (grams(&a), grams(&b));
    let common = left.intersection(&right).count();
    common > 0 && common as f64 / (left.len() + right.len() - common) as f64 >= 0.6
}
pub fn clean(input: &S) -> Option<S> {
    let mut out = Vec::new();
    let mut space = false;
    for &u in input.as_units() {
        if is_js_whitespace(u) {
            space = true;
            continue;
        }
        if space
            && !out.is_empty()
            && !out
                .last()
                .is_some_and(|&c| "：，。；、）】》".encode_utf16().any(|x| x == c))
            && !"（【《".encode_utf16().any(|x| x == u)
        {
            out.push(32);
        }
        space = false;
        out.push(u);
    }
    let start = out
        .iter()
        .position(|u| ![32, 45, 183, 8226, 42].contains(u))
        .unwrap_or(out.len());
    let cleaned = &out[start..];
    if cleaned.len() < 8 {
        return None;
    }
    let mut text = S::from_units(cleaned[..cleaned.len().min(240)].to_vec());
    if cleaned.len() > 240 {
        text = text.truncate_units(239);
        text.push_str("…");
    }
    Some(text)
}
fn heading(line: &S) -> bool {
    let trimmed = line.trim();
    let u = trimmed.as_units();
    let n = u.iter().take_while(|&&x| x == 35).count();
    (1..=6).contains(&n)
        && u.get(n).is_some_and(|x| is_js_whitespace(*x))
        && trimmed != S::from(SECTION)
}
pub fn merge<E>(
    text: S,
    line: S,
    mut candidate: impl FnMut() -> Result<S, E>,
    start: impl FnOnce() -> Result<f64, E>,
) -> Result<(S, bool), E> {
    let sep = S::from("\n");
    let mut body = S::new();
    if text.is_empty() {
        body.push_str("\n\n# 任务记忆\n\n");
        body.push_str(SECTION);
        body.push_unit(10);
        body.push(&line);
        body.push_unit(10);
        return Ok((body, false));
    }
    let lines: Vec<S> = text
        .as_units()
        .split(|u| *u == 10)
        .map(|s| S::from_units(s.to_vec()))
        .collect();
    let marker = S::from(SECTION);
    let Some(pos) = lines.iter().position(|l| l.trim() == marker) else {
        let mut body = text;
        body.push_str("\n\n");
        body.push(&marker);
        body.push_unit(10);
        body.push(&line);
        body.push_unit(10);
        return Ok((body, false));
    };
    if pos > 0 {
        body.push(&S::join(&lines[..pos], &sep).trim_end());
        body.push_str("\n\n");
    }
    let rest = &lines[pos + 1..];
    let tail = rest.iter().position(heading).unwrap_or(rest.len());
    let mut auto = rest[..tail].to_vec();
    while auto.last().is_some_and(|s| s.trim().is_empty()) {
        auto.pop();
    }
    let mut replaced = false;
    for row in &mut auto {
        let s = row.trim();
        if s.as_units().starts_with(&[45, 32]) && similar(&candidate()?, &s.slice_units(2, s.len()))
        {
            *row = line.clone();
            replaced = true;
            break;
        }
    }
    if !replaced {
        auto.push(line);
    }
    let at = start()?.trunc();
    let first = if at < 0. {
        (auto.len() as f64 + at).max(0.) as usize
    } else {
        (at as usize).min(auto.len())
    };
    body.push(&marker);
    body.push_unit(10);
    body.push(&S::join(&auto[first..], &sep));
    if tail < rest.len() {
        body.push_unit(10);
        body.push(&S::join(&rest[tail..], &sep).trim_start());
    }
    body.push_unit(10);
    Ok((body, replaced))
}
