//! Conservative, bounded selection for the historical scheduled-task fan-out.
//! This module never archives tasks itself: the live task-board owner remains
//! the only authority allowed to change lifecycle state.
use crate::js::{self, JsString, JsValue as V};
use std::path::Path;
pub const MIGRATION_ID: &str = "cron-fanout-cleanup";
pub const MAX_CANDIDATES: usize = 5000;
pub fn prop<'a>(v: &'a V, k: &str) -> &'a V {
    v.get(k).unwrap_or(&V::Undefined)
}
pub fn collapse(v: &V) -> JsString {
    let input = if matches!(v, V::Null | V::Undefined) {
        JsString::new()
    } else {
        js::js_to_string(v)
    };
    let mut out = Vec::new();
    let mut space = false;
    for &u in input.as_units() {
        if js::is_js_whitespace(u) {
            space = !out.is_empty();
        } else {
            if space {
                out.push(32);
                space = false;
            }
            out.push(u);
        }
    }
    JsString::from_units(out)
}
pub fn parse_version(v: &V) -> Option<[f64; 3]> {
    let source = if matches!(v, V::Null | V::Undefined) {
        String::new()
    } else {
        js::js_to_string(v).to_string_lossy()
    };
    let re =
        regex::Regex::new(r"([0-9]+)\.([0-9]+)\.([0-9]+)").expect("constant version expression");
    let c = re.captures(&source)?;
    Some([1, 2, 3].map(|i| c[i].parse::<f64>().unwrap_or(f64::INFINITY)))
}
pub fn compare(left: [f64; 3], right: [f64; 3]) -> i32 {
    for i in 0..3 {
        if left[i] != right[i] {
            return if left[i] < right[i] { -1 } else { 1 };
        }
    }
    0
}
pub fn affected(v: &V) -> Option<bool> {
    parse_version(v).map(|v| compare(v, [2., 0., 2.]) <= 0)
}
pub fn title_match(title: &JsString, rule: &V) -> Option<&'static str> {
    let name = collapse(prop(rule, "name"));
    if name.len() >= 12 && title == &name {
        return Some("name");
    }
    let prompt = collapse(prop(rule, "prompt"));
    (title.len() >= 12
        && prompt.len() > title.len()
        && prompt.as_units().starts_with(title.as_units()))
    .then_some("prompt")
}
pub fn collect(tasks: &V, rules: &V) -> Result<V, String> {
    let V::Array(tasks) = tasks else {
        return Err("tasks is not iterable".into());
    };
    let V::Array(rules) = rules else {
        return Err("rules.map is not a function".into());
    };
    let bound = rules
        .iter()
        .map(|r| prop(r, "taskId"))
        .filter(|v| js::truthy(v))
        .collect::<Vec<_>>();
    let mut archive = Vec::new();
    for task in tasks {
        if !js::truthy(task) || !js::truthy(prop(task, "id")) {
            continue;
        }
        if prop(task, "status") == &V::from("archived") || js::truthy(prop(task, "deleting")) {
            continue;
        }
        if bound.iter().any(|v| *v == prop(task, "id")) {
            continue;
        }
        if prop(task, "origin") != &V::from("session")
            || prop(task, "recordType") != &V::from("observed")
        {
            continue;
        }
        if ["ownerShellId", "chatSessionId", "routing"]
            .iter()
            .any(|k| js::truthy(prop(task, k)))
        {
            continue;
        }
        let title = collapse(prop(task, "title"));
        if let Some((rule, matched)) = rules
            .iter()
            .find_map(|r| title_match(&title, r).map(|m| (r, m)))
        {
            archive.push(V::object(vec![
                ("taskId", prop(task, "id").clone()),
                ("ruleId", prop(rule, "id").clone()),
                (
                    "ruleName",
                    if js::truthy(prop(rule, "name")) {
                        prop(rule, "name").clone()
                    } else {
                        V::from("")
                    },
                ),
                ("title", V::String(title)),
                ("matched", V::from(matched)),
            ]));
            if archive.len() > MAX_CANDIDATES {
                return Ok(V::object(vec![
                    ("archive", V::Array(archive)),
                    ("overflow", V::Bool(true)),
                ]));
            }
        }
    }
    Ok(V::object(vec![
        ("archive", V::Array(archive)),
        ("overflow", V::Bool(false)),
    ]))
}
pub fn evidence(pkg: &Path, data: Option<&Path>) -> V {
    let mut roots = vec![pkg];
    if let Some(data) = data.filter(|p| *p != pkg) {
        roots.push(data)
    }
    let extract = |text: String| parse_version(&V::from(text));
    let output = |v: [f64; 3], source: &str| {
        V::object(vec![
            (
                "fromVersion",
                V::from(
                    v.iter()
                        .map(|n| js::format_f64(*n))
                        .collect::<Vec<_>>()
                        .join("."),
                ),
            ),
            ("source", V::from(source)),
        ])
    };
    for root in &roots {
        for name in [".multicc_upgrade", "logs/.multicc_upgrade"] {
            if let Some(v) = read_text(&root.join(name)).ok().and_then(&extract) {
                return output(v, ".multicc_upgrade");
            }
        }
    }
    let re =
        regex::Regex::new(r"(?m)^#\s*installed:\s*(\S+)").expect("constant installer expression");
    for root in roots {
        if let Ok(text) = read_text(&root.join(".multicc_channel")) {
            if let Some(v) = re.captures(&text).and_then(|c| extract(c[1].to_owned())) {
                return output(v, ".multicc_channel");
            }
        }
    }
    V::object(vec![
        ("fromVersion", V::Null),
        ("source", V::from("unknown")),
    ])
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_and_conservative_titles() {
        assert_eq!(affected(&V::Null), None);
        assert_eq!(affected(&V::from("v2.0.2-next")), Some(true));
        assert_eq!(affected(&V::from("2.0.3")), Some(false));
        let rule = V::object(vec![("prompt", V::from("abcdefghijklmnop"))]);
        assert_eq!(
            title_match(&JsString::from("abcdefghijkl"), &rule),
            Some("prompt")
        );
        assert_eq!(title_match(&JsString::from("abcdefgh"), &rule), None);
    }
}

fn read_text(path: &Path) -> std::io::Result<String> {
    std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned())
}
