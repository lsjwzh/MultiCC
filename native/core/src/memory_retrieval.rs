//! Memory retrieval ranking, header-only rule pinning, scope selection,
//! query-hit capping, and 1-hop wikilink expansion.
//!
//! File IO and secret/safety scanning remain in the thin JS bridge
//! (`src/memory/retrieval.js`); all ranking and prefix-budget policy lives here
//! in Rust so shared knowledge bases do not flood cold-start prompts with
//! unrelated `scope_default` entries or false-positive mid-body `【必须】` tags.
use crate::js::{self, JsValue as V};
use crate::selection::{min_relevance, relevance};

pub const MAX_QUERY_HITS: usize = 8;
const MAX_WIKILINK_SEEDS: usize = 8;
const MAX_WIKILINKS_PER_SEED: usize = 8;
const MAX_WIKILINK_NEIGHBORS: usize = 4;

fn field_string(value: &V, key: &str) -> String {
    match value.get(key) {
        Some(V::String(s)) => s.to_string_lossy(),
        _ => String::new(),
    }
}

fn owned_str(value: Option<&V>) -> String {
    match value {
        None | Some(V::Null) | Some(V::Undefined) => String::new(),
        Some(other) => js::js_to_string(other).to_string_lossy(),
    }
}

/// Only explicit rule/preference/feedback header tags at the START of a curated
/// memory entry pin it across sessions. Mid-paragraph emphasis like `【必须...】`
/// inside a `[gotcha]` or `[verified]` note must not pin that note into every
/// cold start, and auto-distilled session history (`_auto.md`) joins on query
/// match rather than auto-pinning at priority 900 and starving task memory.
pub fn is_pinned_rule(scope: &str, file_name: &str, excerpt: &str) -> bool {
    if scope == "skill" || file_name.eq_ignore_ascii_case("_auto.md") {
        return false;
    }
    let mut rest = excerpt.trim_start();
    if let Some(after_dash) = rest.strip_prefix('-') {
        let trimmed = after_dash.trim_start_matches([' ', '\t']);
        if trimmed.len() < after_dash.len() {
            rest = trimmed;
        }
    }
    let mut matched = false;
    loop {
        if let Some(after_open) = rest.strip_prefix('[') {
            let Some(close) = after_open.find(']') else {
                break;
            };
            let tag = &after_open[..close];
            if tag.contains('\n') || tag.chars().count() > 40 {
                break;
            }
            let lower = tag.trim().to_ascii_lowercase();
            if matches!(lower.as_str(), "规则" | "rule" | "preference" | "feedback") {
                matched = true;
            }
            rest = after_open[close + 1..].trim_start_matches([' ', '\t']);
            continue;
        }
        if let Some(after_open) = rest.strip_prefix('【') {
            let Some(close) = after_open.find('】') else {
                break;
            };
            let tag = &after_open[..close];
            if tag.contains('\n') || tag.chars().count() > 40 {
                break;
            }
            if tag.contains("强制") || tag.contains("必须") {
                matched = true;
            }
            rest = after_open[close + '】'.len_utf8()..].trim_start_matches([' ', '\t']);
            continue;
        }
        break;
    }
    matched
}

/// Only narrow session/task-local scopes (`own`, `task`) auto-select unmatched
/// index files (`MEMORY.md`/`AGENTS.md`/`CLAUDE.md`) as `scope_default`.
/// Project-wide (`shared`), `machine`, `cli`, and `skill` knowledge bases join
/// on pinned rules, query hits, or 1-hop wikilinks instead of dumping unrelated
/// entries into every cold start.
pub fn is_scope_default_indexed(scope: &str, file_name: &str) -> bool {
    matches!(scope, "own" | "task")
        && matches!(
            file_name.to_ascii_lowercase().as_str(),
            "memory.md" | "agents.md" | "claude.md"
        )
}

fn extract_wikilinks(excerpt: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut rest = excerpt;
    while let Some(open) = rest.find("[[") {
        let after = &rest[open + 2..];
        let Some(close) = after.find("]]") else {
            break;
        };
        let inner = &after[..close];
        if !inner.contains('[') && !inner.contains(']') {
            let target = inner.split('|').next().unwrap_or("").trim();
            if !target.is_empty() {
                links.push(target.to_string());
            }
        }
        rest = &after[close + 2..];
    }
    links
}

fn normalize_posix_join(base_dir: &str, rel: &str) -> String {
    let combined = if base_dir.is_empty() || base_dir == "." {
        rel.to_string()
    } else if rel.starts_with('/') {
        rel.to_string()
    } else {
        format!("{base_dir}/{rel}")
    };
    let leading_slash = combined.starts_with('/');
    let mut stack: Vec<&str> = Vec::new();
    for seg in combined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if let Some(last) = stack.last() {
                    if *last != ".." {
                        stack.pop();
                    } else if !leading_slash {
                        stack.push("..");
                    }
                } else if !leading_slash {
                    stack.push("..");
                }
            }
            other => stack.push(other),
        }
    }
    let joined = stack.join("/");
    if leading_slash {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

fn posix_dirname(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) => "/",
        Some(pos) => &path[..pos],
        None => ".",
    }
}

fn strip_md_suffix(link: &str) -> &str {
    if link.len() >= 3 && link[link.len() - 3..].eq_ignore_ascii_case(".md") {
        &link[..link.len() - 3]
    } else {
        link
    }
}

fn set_field(obj: &mut Vec<(crate::js::JsString, V)>, key: &str, value: V) {
    let key_js = crate::js::JsString::from_rust_str(key);
    if let Some((_, existing)) = obj.iter_mut().find(|(k, _)| *k == key_js) {
        *existing = value;
    } else {
        obj.push((key_js, value));
    }
}

fn get_priority(item: &V) -> f64 {
    match item.get("priority") {
        Some(V::Number(n)) => *n,
        _ => 0.0,
    }
}

fn get_bool(item: &V, key: &str) -> bool {
    matches!(item.get(key), Some(V::Bool(true)))
}

pub fn select_entries(input: &V) -> V {
    let query_val = input.get("query").cloned().unwrap_or(V::from(""));
    let threshold = min_relevance(&query_val);
    let raw_entries = match input.get("entries") {
        Some(V::Array(items)) => items,
        _ => &[][..],
    };

    let mut inventory: Vec<V> = Vec::with_capacity(raw_entries.len());
    let mut entry_links: Vec<Vec<String>> = Vec::with_capacity(raw_entries.len());

    for raw in raw_entries {
        let scope = owned_str(raw.get("scope"));
        let skill = owned_str(raw.get("skill"));
        let name = owned_str(raw.get("name"));
        let path = owned_str(raw.get("path"));
        let excerpt = owned_str(raw.get("excerpt"));
        let haystack = V::from(format!("{skill} {name} {excerpt}"));
        let score = relevance(&query_val, &haystack) as f64;
        let matched_score = if score >= threshold { score } else { 0.0 };
        let pinned = is_pinned_rule(&scope, &name, &excerpt);
        let indexed = is_scope_default_indexed(&scope, &name);
        let base_priority = if pinned {
            900.0
        } else if scope == "task" {
            400.0
        } else {
            100.0
        };
        let priority = if pinned {
            900.0
        } else {
            base_priority + matched_score.min(30.0) * 12.0
        };
        let reason = if pinned {
            "rule"
        } else if matched_score > 0.0 {
            "query"
        } else if scope == "task" {
            "current_task"
        } else {
            "scope_default"
        };
        let selected = pinned || matched_score > 0.0 || indexed || scope == "task";
        let links = extract_wikilinks(&excerpt);

        let mut fields = match raw {
            V::Object(pairs) => pairs.clone(),
            _ => Vec::new(),
        };
        set_field(&mut fields, "dedupeText", V::from(excerpt.as_str()));
        set_field(&mut fields, "priority", V::Number(priority));
        set_field(&mut fields, "reason", V::from(reason));
        set_field(&mut fields, "selected", V::Bool(selected));
        set_field(&mut fields, "indexed", V::Bool(indexed));
        set_field(
            &mut fields,
            "links",
            V::Array(links.iter().map(|l| V::from(l.as_str())).collect()),
        );
        // Keep path normalized as supplied by caller.
        set_field(&mut fields, "path", V::from(path.as_str()));
        inventory.push(V::Object(fields));
        entry_links.push(links);
    }

    // Cap query hits to avoid vague overlap flooding the managed context.
    let mut query_indices: Vec<usize> = inventory
        .iter()
        .enumerate()
        .filter(|(_, item)| field_string(item, "reason") == "query")
        .map(|(idx, _)| idx)
        .collect();
    query_indices.sort_by(|&a, &b| {
        get_priority(&inventory[b])
            .partial_cmp(&get_priority(&inventory[a]))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for &idx in query_indices.iter().skip(MAX_QUERY_HITS) {
        let scope = owned_str(inventory[idx].get("scope"));
        let indexed = get_bool(&inventory[idx], "indexed");
        let new_reason = if scope == "task" {
            "current_task"
        } else {
            "scope_default"
        };
        let new_selected = indexed || scope == "task";
        if let V::Object(ref mut fields) = inventory[idx] {
            set_field(fields, "reason", V::from(new_reason));
            set_field(fields, "selected", V::Bool(new_selected));
        }
    }

    // 1-hop wikilink expansion only within authorized scope inventory.
    let mut seed_indices: Vec<usize> = inventory
        .iter()
        .enumerate()
        .filter(|(_, item)| get_bool(item, "selected") && field_string(item, "reason") == "query")
        .map(|(idx, _)| idx)
        .collect();
    seed_indices.sort_by(|&a, &b| {
        get_priority(&inventory[b])
            .partial_cmp(&get_priority(&inventory[a]))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    seed_indices.truncate(MAX_WIKILINK_SEEDS);

    let seed_specs: Vec<(String, String, Vec<String>)> = seed_indices
        .into_iter()
        .map(|idx| {
            let id = owned_str(inventory[idx].get("id"));
            let path = owned_str(inventory[idx].get("path"));
            let links = entry_links[idx]
                .iter()
                .take(MAX_WIKILINKS_PER_SEED)
                .cloned()
                .collect();
            (id, path, links)
        })
        .collect();

    for (seed_id, seed_path, links) in seed_specs {
        let dir = posix_dirname(&seed_path);
        for link in links {
            let target = normalize_posix_join(dir, &format!("{}.md", strip_md_suffix(&link)));
            let mut matched = 0usize;
            for item in inventory.iter_mut() {
                if owned_str(item.get("path")) != target {
                    continue;
                }
                if matched >= MAX_WIKILINK_NEIGHBORS {
                    break;
                }
                matched += 1;
                if !get_bool(item, "selected") {
                    if let V::Object(ref mut fields) = item {
                        set_field(fields, "selected", V::Bool(true));
                        set_field(fields, "reason", V::from("wikilink"));
                        set_field(fields, "via", V::from(seed_id.as_str()));
                        set_field(fields, "priority", V::Number(150.0));
                    }
                }
            }
        }
    }

    let candidates: Vec<V> = inventory
        .iter()
        .filter(|item| get_bool(item, "selected"))
        .cloned()
        .collect();

    V::object(vec![
        ("inventory", V::Array(inventory)),
        ("candidates", V::Array(candidates)),
    ])
}

pub fn select_entries_json(raw: &str) -> Result<String, String> {
    let input = js::json_parse(raw).map_err(|error| error.to_string())?;
    Ok(js::json_stringify_or_undefined(&select_entries(&input)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::serde::from_serde;
    use serde_json::json;

    #[test]
    fn pinned_rule_matches_header_tags_only_and_ignores_mid_body_emphasis() {
        assert!(is_pinned_rule(
            "shared",
            "MEMORY.md",
            "[规则][后端语言] 默认必须使用 Rust"
        ));
        assert!(is_pinned_rule(
            "shared",
            "MEMORY.md",
            "[feedback][gotcha][最重要] 服务重启只能手动触发"
        ));
        assert!(is_pinned_rule(
            "shared",
            "MEMORY.md",
            "- [preference] concise output"
        ));
        assert!(is_pinned_rule(
            "shared",
            "MEMORY.md",
            "【强制规则】禁止直接推送"
        ));
        assert!(!is_pinned_rule(
            "skill",
            "MEMORY.md",
            "[规则] 技能内规则不自动钉选"
        ));
        assert!(!is_pinned_rule(
            "own",
            "_auto.md",
            "- [preference] 自动提炼历史不应占满 priority 900 预算"
        ));
        // Mid-paragraph 【必须】 inside a [gotcha] or [verified] entry must NOT pin it.
        assert!(!is_pinned_rule(
            "shared",
            "MEMORY.md",
            "[gotcha][Flutter 单测] 桩 WsTicketClient 的响应【必须回带请求的 path】"
        ));
        assert!(!is_pinned_rule(
            "shared",
            "MEMORY.md",
            "[verified 2026-08-14] wait_for_user_answer 测试里每个 WS 【必须立刻】挂监听"
        ));
    }

    #[test]
    fn shared_memory_md_does_not_auto_dump_unmatched_entries_while_own_and_task_do() {
        assert!(!is_scope_default_indexed("shared", "MEMORY.md"));
        assert!(!is_scope_default_indexed("machine", "MEMORY.md"));
        assert!(!is_scope_default_indexed("cli", "MEMORY.md"));
        assert!(is_scope_default_indexed("own", "CLAUDE.md"));
        assert!(is_scope_default_indexed("own", "AGENTS.md"));
        assert!(is_scope_default_indexed("task", "MEMORY.md"));
    }

    #[test]
    fn select_entries_keeps_rules_and_matches_drops_unrelated_shared_and_caps_hits() {
        let mut entries = vec![
            json!({
                "id": "memory:d1/_shared/MEMORY.md#0", "version": "v0", "scope": "shared",
                "name": "MEMORY.md", "path": "d1/_shared/MEMORY.md",
                "excerpt": "[规则][后端语言] 默认用 Rust"
            }),
            json!({
                "id": "memory:d1/_shared/MEMORY.md#1", "version": "v1", "scope": "shared",
                "name": "MEMORY.md", "path": "d1/_shared/MEMORY.md",
                "excerpt": "[gotcha][Flutter 单测] 响应【必须回带 path】"
            }),
            json!({
                "id": "memory:d1/_shared/MEMORY.md#2", "version": "v2", "scope": "shared",
                "name": "MEMORY.md", "path": "d1/_shared/MEMORY.md",
                "excerpt": "园艺经验：番茄要搭架。"
            }),
            json!({
                "id": "memory:d1/_shared/cache.md#0", "version": "v3", "scope": "shared",
                "name": "cache.md", "path": "d1/_shared/cache.md",
                "excerpt": "数据库索引见 [[latency]]。"
            }),
            json!({
                "id": "memory:d1/_shared/latency.md#0", "version": "v4", "scope": "shared",
                "name": "latency.md", "path": "d1/_shared/latency.md",
                "excerpt": "p99 = 40ms"
            }),
        ];
        for i in 0..12 {
            entries.push(json!({
                "id": format!("memory:d1/_shared/n{i}.md#0"), "version": format!("vn{i}"),
                "scope": "shared", "name": format!("n{i}.md"), "path": format!("d1/_shared/n{i}.md"),
                "excerpt": format!("数据库 第 {i} 条")
            }));
        }
        let out = select_entries(&from_serde(
            &json!({ "query": "数据库", "entries": entries }),
        ));
        let Some(V::Array(candidates)) = out.get("candidates") else {
            panic!("candidates");
        };
        let ids: Vec<String> = candidates.iter().map(|c| field_string(c, "id")).collect();
        assert!(ids.iter().any(|id| id == "memory:d1/_shared/MEMORY.md#0"));
        assert!(!ids.iter().any(|id| id == "memory:d1/_shared/MEMORY.md#1"));
        assert!(!ids.iter().any(|id| id == "memory:d1/_shared/MEMORY.md#2"));
        assert!(ids.iter().any(|id| id == "memory:d1/_shared/latency.md#0"));
        let query_hits = candidates
            .iter()
            .filter(|c| field_string(c, "reason") == "query")
            .count();
        assert_eq!(query_hits, MAX_QUERY_HITS);
    }
}
