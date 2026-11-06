//! 纯计算内核。字符串规范化、UTF-16 高亮和本地化排序留在 JS 契约边界。
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const WEIGHTS: [f64; 4] = [6.0, 2.0, 3.0, 4.0];
const FIELDS: [&str; 4] = ["title", "module", "areas", "body"];
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub task_id: String,
    pub fields: [String; 4],
    pub dir_id: Option<String>,
    pub status: String,
}
struct IndexedDocument {
    source: Document,
    terms: HashMap<String, [f64; 4]>,
    lengths: [Option<f64>; 4],
}
pub struct SearchIndex {
    docs: Vec<IndexedDocument>,
    idf: HashMap<String, f64>,
    average: [f64; 4],
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    terms: Vec<(String, f64)>,
    strong: Vec<String>,
    phrase: String,
    #[serde(default)]
    dir_id: Option<String>,
    #[serde(default)]
    dir_ids: Option<HashSet<String>>,
    #[serde(default)]
    statuses: Option<HashSet<String>>,
    #[serde(default)]
    task_ids: Option<HashSet<String>>,
    #[serde(default)]
    exclude_task_ids: Option<HashSet<String>>,
    #[serde(default)]
    min_score: f64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Hit {
    task_id: String,
    score: f64,
    matched_terms: Vec<String>,
    matched_fields: Vec<&'static str>,
}
fn cjk(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0x3040..=0x30ff | 0xac00..=0xd7af)
}
fn latin(c: u8) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit()
}
fn latin_tail(c: u8) -> bool {
    latin(c) || matches!(c, b'+' | b'.' | b'_' | b'-')
}
fn add(terms: &mut HashMap<String, f64>, term: &str, weight: f64) {
    if terms.len() >= 8000 && !terms.contains_key(term) {
        return;
    }
    let count = terms.entry(term.to_owned()).or_default();
    *count = (*count + weight).min(32.0);
}
fn tokenize(text: &str) -> HashMap<String, f64> {
    let mut terms = HashMap::new();
    let bytes = text.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if !latin(bytes[at]) {
            at += 1;
            continue;
        }
        let start = at;
        at += 1;
        while at < bytes.len() && latin_tail(bytes[at]) {
            at += 1;
        }
        if at - start >= 2 {
            add(&mut terms, &text[start..at], 1.0);
        }
    }
    let mut run = Vec::new();
    let flush = |run: &mut Vec<char>, terms: &mut HashMap<String, f64>| {
        for pair in run.windows(2) {
            add(terms, &pair.iter().collect::<String>(), 1.0);
        }
        for c in run.iter() {
            add(terms, &c.to_string(), 0.5);
        }
        run.clear();
    };
    for ch in text.chars() {
        if cjk(ch) {
            run.push(ch);
        } else if !run.is_empty() {
            flush(&mut run, &mut terms);
        }
    }
    flush(&mut run, &mut terms);
    terms
}
impl SearchIndex {
    pub fn build(json: &str) -> Result<Self, String> {
        // Oversized/truncated emoji leave lone surrogate escapes that JS
        // JSON.parse accepted; sanitize them instead of failing the index.
        let documents: Vec<Document> =
            crate::json_lenient::from_str(json).map_err(|_| "invalid_search_documents")?;
        let mut docs = Vec::new();
        let mut frequencies: HashMap<String, usize> = HashMap::new();
        let mut sums = [0.0; 4];
        let mut counts = [0usize; 4];
        for source in documents {
            let mut terms: HashMap<String, [f64; 4]> = HashMap::new();
            let mut lengths = [None; 4];
            for (i, text) in source.fields.iter().enumerate() {
                if text.is_empty() {
                    continue;
                }
                let field_terms = tokenize(text);
                let mut length = 0.0;
                for (term, tf) in field_terms {
                    terms.entry(term).or_insert([0.0; 4])[i] = tf;
                    length += tf;
                }
                lengths[i] = Some(length);
            }
            if terms.is_empty() {
                continue;
            }
            for term in terms.keys() {
                *frequencies.entry(term.clone()).or_default() += 1;
            }
            for (i, length) in lengths.iter().enumerate() {
                if let Some(n) = length {
                    sums[i] += n;
                    counts[i] += 1;
                }
            }
            docs.push(IndexedDocument {
                source,
                terms,
                lengths,
            });
        }
        let n = docs.len() as f64;
        let idf = frequencies
            .into_iter()
            .map(|(term, f)| (term, (1.0 + (n - f as f64 + 0.5) / (f as f64 + 0.5)).ln()))
            .collect();
        let average = std::array::from_fn(|i| {
            if counts[i] == 0 {
                1.0
            } else {
                (sums[i] / counts[i] as f64).max(1.0)
            }
        });
        Ok(Self { docs, idf, average })
    }
    pub fn search(&self, json: &str) -> Result<String, String> {
        let query: Query =
            crate::json_lenient::from_str(json).map_err(|_| "invalid_search_query")?;
        let mut hits = Vec::new();
        for doc in &self.docs {
            let source = &doc.source;
            if query
                .dir_id
                .as_ref()
                .is_some_and(|id| source.dir_id.as_ref() != Some(id))
                || query
                    .dir_ids
                    .as_ref()
                    .is_some_and(|ids| source.dir_id.as_ref().is_none_or(|id| !ids.contains(id)))
                || query
                    .statuses
                    .as_ref()
                    .is_some_and(|s| !s.contains(&source.status))
                || query
                    .task_ids
                    .as_ref()
                    .is_some_and(|s| !s.contains(&source.task_id))
                || query
                    .exclude_task_ids
                    .as_ref()
                    .is_some_and(|s| s.contains(&source.task_id))
            {
                continue;
            }
            let mut score = 0.0;
            let mut strong_hits = 0;
            let mut matched_terms = Vec::new();
            let mut matched_fields = Vec::new();
            for (term, weight) in &query.terms {
                let Some(tf) = doc.terms.get(term) else {
                    continue;
                };
                let mut term_score = 0.0;
                for i in 0..4 {
                    if tf[i] == 0.0 {
                        continue;
                    }
                    let length = doc.lengths[i].unwrap_or(self.average[i]);
                    let part = WEIGHTS[i]
                        * self.idf[term]
                        * ((tf[i] * (1.4 + 1.0))
                            / (tf[i] + 1.4 * (1.0 - 0.6 + 0.6 * (length / self.average[i]))));
                    if part > 0.0 && !matched_fields.contains(&FIELDS[i]) {
                        matched_fields.push(FIELDS[i]);
                    }
                    term_score += part;
                }
                if term_score <= 0.0 {
                    continue;
                }
                score += term_score * weight;
                matched_terms.push(term.clone());
                if *weight >= 1.0 {
                    strong_hits += 1;
                }
            }
            if (!query.strong.is_empty() && strong_hits == 0) || score <= 0.0 {
                continue;
            }
            if query.phrase.encode_utf16().count() >= 2 {
                let mut bonus: f64 = 0.0;
                for (i, text) in source.fields.iter().enumerate() {
                    if text.contains(&query.phrase) {
                        bonus = bonus.max(WEIGHTS[i]);
                    }
                }
                score += bonus;
            }
            if score < query.min_score {
                continue;
            }
            hits.push(Hit {
                task_id: source.task_id.clone(),
                score: (score * 1000.0).round() / 1000.0,
                matched_terms,
                matched_fields,
            });
        }
        serde_json::to_string(&hits).map_err(|_| "search_result_encode".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documents_with_lone_surrogates_still_index() {
        let docs = r#"[{"taskId":"t1","fields":["bad \ud800 air","","",""],"dirId":null,"status":"active"}]"#;
        let index = SearchIndex::build(docs).unwrap();
        let result = index
            .search(r#"{"terms":[["air",1.0]],"strong":[],"phrase":""}"#)
            .unwrap();
        let hits: Vec<serde_json::Value> = serde_json::from_str(&result).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["taskId"], "t1");
    }

    #[test]
    fn queries_with_lone_surrogates_are_sanitized() {
        let docs = r#"[{"taskId":"t1","fields":["air","","",""],"dirId":null,"status":"active"}]"#;
        let index = SearchIndex::build(docs).unwrap();
        let result = index
            .search(r#"{"terms":[["air",1.0]],"strong":[],"phrase":"\ud800"}"#)
            .unwrap();
        let hits: Vec<serde_json::Value> = serde_json::from_str(&result).unwrap();
        assert_eq!(hits.len(), 1);
    }
}
