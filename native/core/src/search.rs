//! Shared BM25 index for the addon and the standalone gateway.
mod board;
use crate::search_tokens::weighted_terms as tokenize;
pub use board::search_board;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const WEIGHTS: [f64; 4] = [6.0, 2.0, 3.0, 4.0];
const FIELDS: [&str; 4] = ["title", "module", "areas", "body"];
/// Per-field BM25 shared with the synchronous API over caller-owned index views.
pub fn field_score(weight: f64, idf: f64, tf: f64, length: f64, average: f64) -> f64 {
    weight * idf * ((tf * (1.4 + 1.0)) / (tf + 1.4 * (1.0 - 0.6 + 0.6 * (length / average))))
}

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
    terms: IndexMap<String, [f64; 4]>,
    input_index: usize,
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
impl SearchIndex {
    pub fn build(json: &str) -> Result<Self, String> {
        // Oversized/truncated emoji leave lone surrogate escapes that JS
        // JSON.parse accepted; sanitize them instead of failing the index.
        let documents: Vec<Document> =
            crate::json_lenient::from_str(json).map_err(|_| "invalid_search_documents")?;
        Ok(Self::from_documents(documents))
    }
    /// The live board's JS Map permits repeated IDs. Its last indexed row wins,
    /// while document frequency still counts every token-bearing input row.
    pub fn build_board_snapshot(json: &str) -> Result<Self, String> {
        let documents =
            crate::json_lenient::from_str(json).map_err(|_| "invalid_search_documents")?;
        Ok(Self::index_documents(documents, true))
    }

    fn from_documents(documents: Vec<Document>) -> Self {
        Self::index_documents(documents, false)
    }

    fn index_documents(documents: Vec<Document>, replace_duplicates: bool) -> Self {
        let mut docs = Vec::new();
        let mut frequencies: HashMap<String, usize> = HashMap::new();
        let mut sums = [0.0; 4];
        let mut counts = [0usize; 4];
        let mut positions = HashMap::new();
        for (input_index, source) in documents.into_iter().enumerate() {
            let mut terms: IndexMap<String, [f64; 4]> = IndexMap::new();
            let mut lengths = [None; 4];
            for (i, text) in source.fields.iter().enumerate() {
                if text.is_empty() {
                    continue;
                }
                let field_terms = tokenize(text);
                let mut length = 0.0;
                for (term, tf) in field_terms {
                    terms.entry(term.to_owned()).or_insert([0.0; 4])[i] = tf;
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
            let position = if replace_duplicates {
                *positions
                    .entry(source.task_id.clone())
                    .or_insert(docs.len())
            } else {
                docs.len()
            };
            let doc = IndexedDocument {
                source,
                input_index,
                terms,
                lengths,
            };
            if position == docs.len() {
                docs.push(doc);
            } else {
                docs[position] = doc;
            }
        }
        for doc in &docs {
            for (i, length) in doc.lengths.iter().enumerate() {
                if let Some(n) = length {
                    sums[i] += n;
                    counts[i] += 1;
                }
            }
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
        Self { docs, idf, average }
    }
    /// Expose the same read-only inspection data as the synchronous board index.
    /// Only synchronous API clients need the per-field lengths and term lists.
    pub fn board_view(&self) -> serde_json::Value {
        use serde_json::{json, Map, Value};
        let named = |values: [Option<f64>; 4]| -> Map<String, Value> {
            FIELDS
                .iter()
                .zip(values)
                .filter_map(|(key, n)| n.map(|v| (key.to_string(), json!(v))))
                .collect()
        };
        let rows: Vec<_> = self
            .docs
            .iter()
            .map(|doc| {
                let terms: Vec<_> = doc
                    .terms
                    .iter()
                    .map(|(term, tf)| json!([term, named(tf.map(|n| (n > 0.0).then_some(n)))]))
                    .collect();
                json!([doc.input_index, named(doc.lengths), terms])
            })
            .collect();
        json!({"rows": rows, "average": named(self.average.map(Some))})
    }

    pub fn term_idf(&self, term: &str) -> f64 {
        self.idf
            .get(term)
            .copied()
            .unwrap_or_else(|| (1.0 + (self.docs.len() as f64 + 0.5) / 0.5).ln())
    }

    pub fn search(&self, json: &str) -> Result<String, String> {
        let query: Query =
            crate::json_lenient::from_str(json).map_err(|_| "invalid_search_query")?;
        serde_json::to_string(&self.rank(&query)).map_err(|_| "search_result_encode".into())
    }
    fn rank(&self, query: &Query) -> Vec<Hit> {
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
                    let part =
                        field_score(WEIGHTS[i], self.idf[term], tf[i], length, self.average[i]);
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
        hits
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn board_search_caps_equal_length_terms_in_tokenizer_order() {
        let all = "aa bb cc dd ee ff gg hh ii jj kk ll mm";
        let board = serde_json::json!({"tasks": {
            "t1": {"id":"t1", "title":all}, "t2": {"id":"t2", "title":"mm"}
        }});
        let hits = search_board(&board, &serde_json::json!({"query":all})).unwrap();
        let hits = hits.as_array().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["taskId"], "t1");
        assert_eq!(
            hits[0]["matchedTerms"],
            serde_json::json!(all.split_whitespace().take(12).collect::<Vec<_>>())
        );
    }

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
