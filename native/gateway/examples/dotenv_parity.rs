//! Parity harness input for `.env` reading (see /tmp/parity-dotenv.js during
//! development): one JSON request per line, one JSON answer per line.
//!
//!   {"text": "<.env file>", "existing": {"KEY": "value"}}
//!   -> {"env": {...}}   // the merged environment, insertion ordered

use std::io::{self, BufRead};

fn main() {
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: serde_json::Value = serde_json::from_str(&line).expect("request must be JSON");
        let text = request
            .get("text")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let mut env = request
            .get("existing")
            .and_then(|value| value.as_object())
            .cloned()
            .unwrap_or_default();
        multicc_core::dotenv::apply(text, &mut env);
        println!("{}", serde_json::json!({ "env": env }));
    }
}
