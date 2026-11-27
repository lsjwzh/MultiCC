//! Memory frontmatter is a small line format, including a nested metadata.type.
//! Run the inline markdown expressions on JS code units for compatibility with
//! stored text containing partial surrogate pairs.
use crate::js::{
    regex::{from_unit_view, to_unit_view, SPACE},
    string::js_trim,
    JsString,
};
use regex::Regex;
use std::{collections::HashMap, sync::LazyLock};

static HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^\x{FEFF}?---\r?\n(.*?)\r?\n---\r?\n?").unwrap());
static FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^([{SPACE}]*)([A-Za-z_][A-Za-z_0-9-]*):[{SPACE}]*([^\r\n\x{{2028}}\x{{2029}}]*)$"
    ))
    .unwrap()
});
static HEADING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?:^|[\n\r\x{{2028}}\x{{2029}}])[{SPACE}]*#[{SPACE}]+([^\r\n\x{{2028}}\x{{2029}}]+?)[{SPACE}]*(?:$|[\n\r\x{{2028}}\x{{2029}}])")).unwrap()
});
static SLUG_SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new("[-_]+").unwrap());
static LABEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]").unwrap());
static PARA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n{2,}").unwrap());
static QUOTE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?m)^>[{SPACE}]?")).unwrap());
static MARK: LazyLock<Regex> = LazyLock::new(|| Regex::new("[`*_]").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"[{SPACE}]+")).unwrap());
static LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]").unwrap());

pub struct ParsedUnits {
    pub title: JsString,
    pub summary: JsString,
    pub kind: JsString,
    pub links: Vec<(JsString, u32)>,
    /// The old fallback calls .replace on the original slug if its derived
    /// title is empty. A non-string slug may therefore need a host method.
    pub fallback_slug: bool,
}
pub struct Parsed {
    pub title: String,
    pub summary: JsString,
    pub kind: String,
    pub links: Vec<(String, u32)>,
}
pub fn parse(text: &str, slug: &str) -> Parsed {
    let p = parse_units(&JsString::from(text), &JsString::from(slug));
    Parsed {
        title: p.title.to_string_lossy(),
        summary: p.summary,
        kind: p.kind.to_string_lossy(),
        links: p
            .links
            .into_iter()
            .filter_map(|(k, n)| {
                let k = k.to_string_lossy();
                (k != "__proto__").then_some((k, n))
            })
            .collect(),
    }
}
pub fn parse_units(raw: &JsString, slug: &JsString) -> ParsedUnits {
    let raw = to_unit_view(raw);
    let mut body = raw.as_str();
    let mut title = String::new();
    let mut summary = String::new();
    let mut explicit = "";
    let mut meta_type = "";
    if let Some(head) = HEADER.captures(body) {
        body = &body[head.get(0).unwrap().end()..];
        let mut in_meta = false;
        for line in head.get(1).unwrap().as_str().split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let Some(field) = FIELD.captures(line) else {
                continue;
            };
            let key = field.get(2).unwrap().as_str();
            let val = field.get(3).unwrap().as_str();
            let val = val.strip_prefix(['"', '\'']).unwrap_or(val);
            let val = js_trim(val.strip_suffix(['"', '\'']).unwrap_or(val));
            if key == "metadata" {
                in_meta = true;
                continue;
            }
            if in_meta && !field[1].is_empty() {
                if key == "type" {
                    meta_type = val
                }
            } else {
                in_meta = false;
                match key {
                    "title" => title = val.into(),
                    "description" => summary = val.into(),
                    "type" => explicit = val,
                    _ => {}
                }
            }
        }
    }
    if title.is_empty() {
        if let Some(h) = HEADING.captures(body) {
            title = js_trim(&h[1]).into()
        }
    }
    let mut fallback_slug = false;
    if title.is_empty() {
        let view = to_unit_view(slug);
        title = js_trim(&SLUG_SPACE.replace_all(&view, " ")).into();
        if title.is_empty() {
            title = view;
            fallback_slug = true
        }
    }
    let title = from_unit_view(&LABEL.replace_all(&title, "$1"));
    if summary.is_empty() {
        for p in PARA.split(body).map(js_trim) {
            if p.is_empty() || p.starts_with('#') {
                continue;
            }
            let quoted = QUOTE.replace_all(p, "");
            let label = LABEL.replace_all(&quoted, "$1");
            let flat = MARK.replace_all(&label, "");
            let flat = SPACES.replace_all(&flat, " ");
            let flat = js_trim(&flat);
            if !flat.is_empty() {
                summary = flat.into();
                break;
            }
        }
    }
    let mut summary = from_unit_view(&summary);
    if summary.len() > 240 {
        summary = summary.truncate_units(237);
        summary.push_str("…")
    }
    let mut index = HashMap::new();
    let mut links: Vec<(JsString, u32)> = vec![];
    for capture in LINK.captures_iter(body) {
        let target = js_trim(&capture[1]);
        let target = target
            .get(target.len().saturating_sub(3)..)
            .filter(|s| s.eq_ignore_ascii_case(".md"))
            .map_or(target, |_| &target[..target.len() - 3]);
        if target.is_empty() {
            continue;
        }
        let target = from_unit_view(target);
        let i = *index.entry(target.clone()).or_insert_with(|| {
            links.push((target, 0));
            links.len() - 1
        });
        links[i].1 += 1;
    }
    // Object.entries enumerates array-index property names first.
    links.sort_by_key(|(key, _)| {
        let k = key.to_string_lossy();
        k.parse::<u32>()
            .ok()
            .filter(|n| *n < u32::MAX && n.to_string() == k)
            .unwrap_or(u32::MAX)
    });
    ParsedUnits {
        title,
        summary,
        kind: from_unit_view(if meta_type.is_empty() {
            explicit
        } else {
            meta_type
        })
        .to_lowercase(),
        links,
        fallback_slug,
    }
}
pub fn node_kind(file: &str, explicit: &str) -> String {
    if !explicit.is_empty() {
        return explicit.into();
    }
    match file.to_ascii_lowercase().as_str() {
        "_auto.md" => "auto",
        "claude.md" | "agents.md" | "readme.md" | "memory.md" => "index",
        _ => "note",
    }
    .into()
}
