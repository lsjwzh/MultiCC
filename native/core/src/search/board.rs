//! Project persisted board records into the same four fields used by the addon.
use super::{Document, Query, SearchIndex};
use crate::{
    js::string::{is_js_whitespace_char, js_trim, utf16_len, JsString},
    search_tokens::board_query_terms,
    task_domain::{host::Facts, normalize, text, truth},
};
use icu_collator::{options::CollatorOptions, Collator};
use serde_json::{json, Value};
use std::collections::HashMap;
use unicode_normalization::UnicodeNormalization;

fn folded(text: &str) -> String {
    text.nfkc().collect::<String>().to_lowercase()
}

fn collapse(text: &str) -> String {
    text.split(is_js_whitespace_char)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

struct Display {
    fields: [String; 4],
    dir: Option<String>,
    status: String,
    updated: f64,
}

fn display(task: &Value, board: &Value) -> Display {
    let refs = task["refs"].as_array().map_or(&[][..], Vec::as_slice);
    let body = [
        text(&task["description"]),
        text(&task["acceptanceCriteria"]),
    ]
    .into_iter()
    .chain(refs.iter().map(|r| text(&r["excerpt"])))
    .map(js_trim)
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    let fields = [
        js_trim(text(&task["title"])).to_owned(),
        text(&board["modules"][text(&task["moduleId"])]["name"]).to_owned(),
        task["areas"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| js_trim(text(s)))
            .collect::<Vec<_>>()
            .join(" "),
        body,
    ];
    let dir = Some(js_trim(text(&task["dirId"])))
        .filter(|s| !s.is_empty())
        .or_else(|| {
            refs.iter()
                .find_map(|r| r["dirId"].as_str().filter(|s| !s.is_empty()))
        })
        .map(str::to_owned);
    let updated = task["updatedAt"]
        .as_f64()
        .filter(|n| *n != 0.0)
        .or_else(|| task["createdAt"].as_f64())
        .unwrap_or_default();
    Display {
        fields,
        dir,
        status: text(&task["status"]).to_owned(),
        updated,
    }
}

fn snippet(fields: &[String; 4], marks: &[String]) -> Value {
    let order = [&fields[3], &fields[2], &fields[0], &fields[1]];
    let mut window = None;
    for field in order {
        let normalized = folded(field);
        let mut best = None;
        let mut longest = 0;
        for term in marks {
            let len = utf16_len(term);
            if len > longest {
                if let Some(at) = normalized.find(term) {
                    longest = len;
                    best = Some(utf16_len(&normalized[..at]));
                }
            }
        }
        if let Some(at) = best {
            let raw = JsString::from_rust_str(field);
            window = Some(collapse(
                &raw.slice_units(at.saturating_sub(40), at + longest + 40)
                    .to_string_lossy(),
            ));
            break;
        }
    }
    let window = window.unwrap_or_else(|| {
        let fallback = order
            .into_iter()
            .find(|s| !s.is_empty())
            .map_or("", |s| s.as_str());
        JsString::from_rust_str(&collapse(fallback))
            .truncate_units(160)
            .to_string_lossy()
    });
    let normalized = folded(&window);
    let mut ranges = Vec::new();
    for term in marks {
        let len = utf16_len(term);
        for (byte, _) in normalized.match_indices(term) {
            let start = utf16_len(&normalized[..byte]);
            ranges.push((start, start + len));
        }
    }
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in ranges {
        if let Some(prev) = merged.last_mut().filter(|prev| start <= prev.1) {
            prev.1 = prev.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    json!({"text":window,"ranges":merged})
}

pub fn search_board(raw: &Value, options: &Value) -> Result<Value, &'static str> {
    let normalized = folded(text(&options["query"]));
    let terms = board_query_terms(&normalized);
    if terms.is_empty() {
        return Ok(json!([]));
    }
    let strong: Vec<String> = terms
        .iter()
        .filter(|(_, weight)| *weight >= 1.0)
        .map(|(s, _)| s.clone())
        .collect();
    let marks = if strong.is_empty() {
        terms.iter().map(|(s, _)| s.clone()).collect()
    } else {
        strong.clone()
    };
    let set = |key: &str| {
        options[key].as_array().map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
    };
    let query = Query {
        phrase: collapse(&normalized),
        terms,
        strong,
        statuses: set("statuses"),
        dir_ids: set("dirIds"),
        dir_id: options["dirId"].as_str().map(str::to_owned),
        task_ids: None,
        exclude_task_ids: None,
        min_score: options["minScore"].as_f64().unwrap_or_default().max(0.0),
    };
    let board = normalize::normalize(raw, Facts::default().host());
    let deleted = board["deletedTaskIds"]
        .as_array()
        .map_or(&[][..], Vec::as_slice);
    let mut displays = HashMap::new();
    let mut documents = Vec::new();
    for (id, task) in board["tasks"].as_object().into_iter().flatten() {
        if deleted.contains(&task["id"])
            || truth(&task["mergedInto"])
            || truth(&task["deleting"])
            || query
                .statuses
                .as_ref()
                .is_some_and(|s| !s.contains(text(&task["status"])))
        {
            continue;
        }
        let row = display(task, &board);
        documents.push(Document {
            task_id: id.clone(),
            dir_id: row.dir.clone(),
            status: row.status.clone(),
            fields: row.fields.each_ref().map(|s| folded(s)),
        });
        displays.insert(id, row);
    }
    let mut hits = SearchIndex::from_documents(documents).rank(&query);
    let collator = Collator::try_new(Default::default(), CollatorOptions::default())
        .map_err(|_| "task_search_unavailable")?;
    hits.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| {
                displays[&b.task_id]
                    .updated
                    .total_cmp(&displays[&a.task_id].updated)
            })
            .then_with(|| collator.compare(&a.task_id, &b.task_id))
    });
    let hits = hits.into_iter().take(options["limit"].as_u64().unwrap_or(20) as usize).map(|hit| {
        let row = &displays[&hit.task_id];
        json!({"taskId":hit.task_id,"score":hit.score,"matchedTerms":hit.matched_terms,"matchedFields":hit.matched_fields,
            "title":row.fields[0],"dirId":row.dir,"status":row.status,"updatedAt":row.updated,"snippet":snippet(&row.fields,&marks)})
    }).collect();
    Ok(Value::Array(hits))
}
