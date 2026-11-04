//! OpenCode context failures are permanent for the current native history.
//! Inspect only error fields, never echoed prompts or arbitrary tool output.
use serde_json::{json, Value};

fn collect(value: &Value, depth: usize, messages: &mut Vec<String>, codes: &mut Vec<String>) {
    if depth > 4 {
        return;
    }
    let Some(object) = value.as_object() else {
        return;
    };
    for key in ["code", "name", "errorName"] {
        if let Some(text) = object.get(key).and_then(Value::as_str) {
            codes.push(text.to_ascii_lowercase());
        }
    }
    if let Some(text) = object.get("message").and_then(Value::as_str) {
        messages.push(text.to_ascii_lowercase());
    }
    for key in ["error", "data"] {
        if let Some(nested) = object.get(key) {
            collect(nested, depth + 1, messages, codes);
        }
    }
}

pub fn diagnose(value: &Value) -> Option<Value> {
    let (mut messages, mut codes) = (Vec::new(), Vec::new());
    collect(value, 0, &mut messages, &mut codes);
    let compaction = codes.iter().any(|c| c == "opencode_compaction_overflow")
        || messages
            .iter()
            .any(|m| m.contains("conversation history too large to compact"));
    let overflow = compaction
        || codes.iter().any(|c| {
            matches!(
                c.as_str(),
                "contextoverflowerror" | "context_length_exceeded" | "context_window_exceeded"
            )
        })
        || messages.iter().any(|m| {
            [
                "exceeds model context limit",
                "exceeds the model context limit",
                "context length exceeded",
                "context window exceeded",
                "prompt is too long",
                "prompt too long",
                "input is too long",
                "maximum context length exceeded",
            ]
            .iter()
            .any(|pattern| m.contains(pattern))
        })
        || messages.iter().any(|m| {
            m.contains("maximum context length is")
                && m.contains("however")
                && m.contains("input tokens")
        });
    if !overflow {
        return None;
    }
    Some(json!({
        "category": "context_token_limit",
        "code": if compaction { "opencode_compaction_overflow" } else { "context_length_exceeded" },
        "message": if compaction {
            "OpenCode 会话历史超过模型上下文上限，自动压缩也无法完成。"
        } else {
            "OpenCode 请求超过模型上下文上限。"
        },
        "userAction": "请使用聊天菜单中的“压缩上下文”新开原生上下文（保留完整聊天历史），再继续任务；若仍超限，请缩短本次输入或选择上下文容量更大的模型。"
    }))
}

pub fn describe(input: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
    Ok(diagnose(&value).unwrap_or(Value::Null).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diagnosis(value: Value) -> Value {
        serde_json::from_str(&describe(&value.to_string()).unwrap()).unwrap()
    }

    #[test]
    fn compaction_rpc_and_inspect_stderr_report_the_actual_cause() {
        for message in [
            "Internal error: Conversation history too large to compact - exceeds model context limit".to_string(),
            format!("prompt: [[Object ...]], error: {{ code: -32603, message: \"Conversation history too large to compact - exceeds model context limit\" }}{}", "\nstack frame".repeat(60)),
        ] {
            let result = diagnosis(json!({"code": -32603, "message": message}));
            assert_eq!(result["category"], "context_token_limit");
            assert_eq!(result["code"], "opencode_compaction_overflow");
            assert!(!result["message"].as_str().unwrap().contains("Object"));
        }
    }

    #[test]
    fn structured_error_name_survives_a_generic_rpc_message() {
        let result = diagnosis(json!({"message":"Internal error", "data":{
            "service":"session", "errorName":"ContextOverflowError"
        }}));
        assert_eq!(result["code"], "context_length_exceeded");
        assert!(result["userAction"]
            .as_str()
            .unwrap()
            .contains("保留完整聊天历史"));
    }

    #[test]
    fn unrelated_errors_and_echoed_prompts_are_not_context_failures() {
        for value in [
            json!({"code":-32603,"message":"Internal error: database unavailable"}),
            json!({"message":"HTTP 401 Unauthorized"}),
            json!({"message":"max_tokens output limit reached"}),
            json!({"message":"model context limit is 200000"}),
            json!({"prompt":{"message":"Conversation history too large to compact"}}),
            json!({"data":{"details":{"message":"prompt too long"}}}),
        ] {
            assert_eq!(diagnosis(value), Value::Null);
        }
    }
}
