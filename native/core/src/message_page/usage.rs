use crate::usage_observed::{token_count_number, token_count_text};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct Baselines(HashMap<String, [f64; 5]>);

impl Baselines {
    pub fn project(
        &mut self,
        epoch: &str,
        usage: &Value,
        cumulative: &Value,
        per_turn: bool,
    ) -> Option<[f64; 5]> {
        let explicit = cumulative.is_object();
        if !explicit
            && (per_turn
                || usage.get("cached_input_tokens").is_none()
                    && usage.get("reasoning_output_tokens").is_none())
        {
            return None;
        }
        let v = if explicit { cumulative } else { usage };
        let count = |field: &str| {
            v[field]
                .as_f64()
                .and_then(token_count_number)
                .or_else(|| v[field].as_str().and_then(token_count_text))
                .unwrap_or_default()
        };
        let separate = !v["cache_read_input_tokens"].is_null();
        let cached = count(if separate {
            "cache_read_input_tokens"
        } else {
            "cached_input_tokens"
        });
        let input = count("input_tokens");
        let current = [
            if separate {
                input
            } else {
                (input - cached).max(0.)
            },
            cached,
            count("cache_creation_input_tokens"),
            count("output_tokens"),
            count("reasoning_output_tokens"),
        ];
        let previous = self.0.insert(epoch.into(), current);
        if explicit {
            return None;
        }
        Some(match previous {
            Some(prev) if (0..4).all(|i| current[i] >= prev[i]) => {
                std::array::from_fn(|i| (current[i] - prev[i]).max(0.))
            }
            _ => current,
        })
    }
}
pub fn apply(row: &mut Value, delta: Option<[f64; 5]>) {
    if let Some(obj) = row.as_object_mut() {
        obj.remove("usageEpoch");
        obj.remove("usageCumulative");
    }
    if let Some([fresh, cached, write, output, reasoning]) = delta {
        let usage = &mut row["usage"];
        for (key, v) in [
            ("input_tokens", fresh),
            ("cached_input_tokens", cached),
            ("cache_read_input_tokens", cached),
            ("cache_creation_input_tokens", write),
            ("output_tokens", output),
            ("reasoning_output_tokens", reasoning),
            ("total_tokens", fresh + cached + output),
        ] {
            usage[key] = json!(v);
        }
    }
}
