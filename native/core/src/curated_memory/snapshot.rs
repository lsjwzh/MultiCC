use super::{read_utf8, scan, DELIMITER};
use crate::js::{self, JsString, JsValue as V};
use std::{cmp::Ordering, fs, path::Path};

pub fn priority(name: &str, primary: &[String]) -> i32 {
    let low = name.to_lowercase();
    if primary.iter().any(|n| n.to_lowercase() == low) {
        return 0;
    }
    match low.as_str() {
        "memory.md" | "user.md" | "_curated.md" => 0,
        "_auto.md" => 1,
        "readme.md" => 3,
        _ => 2,
    }
}
pub fn names(dir: &Path) -> std::io::Result<Vec<String>> {
    fs::read_dir(dir)?
        .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
        .filter(|s| {
            s.as_ref()
                .map_or(true, |s| s.to_lowercase().ends_with(".md"))
        })
        .collect()
}
struct Record {
    name: String,
    chunk: JsString,
    priority: i32,
    blocked: bool,
}
const MARKER: &str = "\n（本文件超出本轮注入预算，以上为节选）";
fn clipped(chunk: &JsString, cap: usize) -> JsString {
    let mut prefix = chunk.truncate_units(cap.saturating_sub(js::utf16_len(MARKER)));
    prefix.push_str(MARKER);
    prefix
}
fn notice(omitted: &[(String, bool)], cap: usize) -> JsString {
    let n = omitted.len();
    let prefix = format!("（另有 {n} 个记忆文件未完整注入：");
    let suffix = "；需要时按路径读取）";
    let mut names = String::new();
    for (name, partial) in omitted {
        let next = format!(
            "{names}{}{name}{}",
            if names.is_empty() { "" } else { "、" },
            if *partial { "（节选）" } else { "" }
        );
        if js::utf16_len(&prefix) + js::utf16_len(&next) + js::utf16_len(suffix) > cap {
            break;
        }
        names = next;
    }
    if names.is_empty() {
        return JsString::from_rust_str(&format!("（另有 {n} 个记忆文件未注入）"))
            .truncate_units(cap);
    }
    JsString::from_rust_str(&format!(
        "{prefix}{names}{}{suffix}",
        if names.split('、').count() < n {
            " 等"
        } else {
            ""
        }
    ))
}
pub fn build(
    dir: &Path,
    cap: usize,
    primary: &[String],
    markers: &[String],
    mut compare: impl FnMut(&str, &str) -> Ordering,
) -> V {
    let mut records = vec![];
    for name in names(dir).unwrap_or_default() {
        let Ok(raw) = read_utf8(&dir.join(&name)) else {
            continue;
        };
        let raw = js::js_trim(&raw);
        if raw.is_empty() {
            continue;
        }
        let threat = scan(raw);
        let blocked = threat.is_some();
        let body = if let Some(msg) = threat {
            format!("（该文件命中记忆安全规则，未自动注入：{msg}）")
        } else if name.eq_ignore_ascii_case("memory.md") && !markers.is_empty() {
            let mut entries: Vec<_> = raw.split(DELIMITER).collect();
            entries.sort_by_key(|e| {
                !markers.iter().any(|m| {
                    e.trim_start_matches(js::is_js_whitespace_char)
                        .starts_with(m)
                })
            });
            entries.join(DELIMITER)
        } else {
            raw.to_owned()
        };
        records.push(Record {
            chunk: format!("#### {name}\n{body}").as_str().into(),
            priority: priority(&name, primary),
            name,
            blocked,
        });
    }
    records.sort_by(|a, b| {
        a.priority
            .cmp(&b.priority)
            .then_with(|| compare(&a.name, &b.name))
    });
    let reserve = if records.iter().map(|r| r.chunk.len()).sum::<usize>() > cap {
        ((cap as f64 * 0.08) as usize).clamp(120, 360)
    } else {
        0
    };
    let budget = cap.saturating_sub(reserve);
    let mut chunks = vec![];
    let mut included = vec![];
    let mut omitted = vec![];
    let mut used = 0;
    let mut include = |item: &Record, part: JsString, partial: bool| {
        let mut fields = vec![
            ("name", item.name.as_str().into()),
            ("chars", (part.len() as f64).into()),
            ("partial", partial.into()),
        ];
        if !partial {
            fields.push(("blocked", item.blocked.into()))
        }
        included.push(V::object(fields));
        chunks.push(part);
    };
    for item in records.iter().filter(|_| cap > 0) {
        let sep = if used > 0 { 2 } else { 0 };
        let remain = budget.saturating_sub(used + sep);
        if item.chunk.len() <= remain {
            used += sep + item.chunk.len();
            include(item, item.chunk.clone(), false)
        } else {
            let partial = item.priority == 0 && remain >= 240;
            if partial {
                let part = clipped(&item.chunk, remain);
                used += sep + part.len();
                include(item, part, true)
            }
            omitted.push((item.name.clone(), partial));
        }
    }
    if used == 0 && !records.is_empty() && budget >= 240 {
        let part = clipped(&records[0].chunk, budget);
        used = part.len();
        include(&records[0], part, true);
        omitted[0].1 = true;
    }
    if !omitted.is_empty() {
        let note = notice(
            &omitted,
            cap.saturating_sub(used + if used > 0 { 2 } else { 0 }),
        );
        if !note.is_empty() {
            chunks.push(note)
        }
    }
    let text = JsString::join(&chunks, &"\n\n".into());
    V::object(vec![
        ("totalChars", (text.len() as f64).into()),
        ("text", V::String(text)),
        ("included", V::Array(included)),
        (
            "omitted",
            V::Array(
                omitted
                    .into_iter()
                    .map(|(name, part)| {
                        V::object(vec![("name", name.into()), ("partial", part.into())])
                    })
                    .collect(),
            ),
        ),
    ])
}
