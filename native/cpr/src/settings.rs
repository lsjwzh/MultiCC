use serde_json::{json, Value};

fn backend(value: &Value) -> Option<String> {
    let value = value.as_str()?.trim().to_lowercase();
    ["node", "rust"].contains(&value.as_str()).then_some(value)
}

/// 宿主提供现有配置与运行时快照；这里只返回允许保存的单个配置项。
pub fn plan(input: &Value) -> Value {
    let current = backend(&input["currentBackend"]).unwrap_or_else(|| "rust".into());
    let available = input["rustAvailable"] == true;
    let save = input["action"] == "save";
    let configured = if save {
        let Some(requested) = backend(&input["requestedBackend"]) else {
            return json!({"status":400,"error":"CPR 版本只支持 node 或 rust"});
        };
        if requested == "rust" && !available {
            return json!({"status":503,"error":"Rust CPR 模块尚未就绪，请更新原生模块后重试"});
        }
        requested
    } else {
        backend(&input["configuredBackend"]).unwrap_or_else(|| "rust".into())
    };
    let mut result = json!({"status":200,"currentBackend":current,"configuredBackend":configured,
        "restartRequired":current != configured,"rustAvailable":available});
    if save {
        result["updates"] = json!({"MULTICC_CPR_BACKEND":configured});
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_pending_state_are_separate() {
        let view = plan(&json!({}));
        assert_eq!(view["currentBackend"], "rust");
        assert_eq!(view["configuredBackend"], "rust");
        assert_eq!(view["restartRequired"], false);
        let pending = plan(&json!({"currentBackend":"node","configuredBackend":"rust"}));
        assert_eq!(pending["restartRequired"], true);
        assert!(pending.get("updates").is_none());
        let upgrade = plan(&json!({"currentBackend":"node"}));
        assert_eq!(upgrade["configuredBackend"], "rust");
        assert_eq!(upgrade["restartRequired"], true);
        let pinned = plan(&json!({"currentBackend":"node","configuredBackend":"node"}));
        assert_eq!(pinned["configuredBackend"], "node");
        assert_eq!(pinned["restartRequired"], false);
    }

    #[test]
    fn save_is_narrow_and_does_not_claim_runtime_switched() {
        let view = plan(&json!({"action":"save","currentBackend":"node",
            "requestedBackend":" Rust ","rustAvailable":true,"SECRET":"never-return-this"}));
        assert_eq!(view["currentBackend"], "node");
        assert_eq!(view["restartRequired"], true);
        assert_eq!(view["updates"], json!({"MULTICC_CPR_BACKEND":"rust"}));
        assert!(!view.to_string().contains("never-return-this"));
    }

    #[test]
    fn unavailable_rust_rejects_enable_but_allows_rollback() {
        assert_eq!(
            plan(&json!({"action":"save","requestedBackend":"rust"}))["status"],
            503
        );
        let rollback =
            plan(&json!({"action":"save","currentBackend":"rust","requestedBackend":"node"}));
        assert_eq!(rollback["status"], 200);
        assert_eq!(rollback["restartRequired"], true);
        for invalid in [
            Value::Null,
            json!(true),
            json!({}),
            json!("auto"),
            json!("rust\nOTHER=1"),
        ] {
            assert_eq!(
                plan(&json!({"action":"save","requestedBackend":invalid}))["status"],
                400
            );
        }
    }
}
