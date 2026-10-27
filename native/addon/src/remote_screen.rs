use napi::Result;
use napi_derive::napi;
use serde_json::{json, Value};

fn backend(value: &Value) -> Option<String> {
    let value = value.as_str()?.trim().to_lowercase();
    ["node", "rust"].contains(&value.as_str()).then_some(value)
}

/// 宿主提供现有配置与运行时快照；这里只返回允许保存的单个配置项。
/// 与 CPR 版本的区别：默认 rust，但配置非法时设置入口报 400 而不是悄悄改值；
/// 想切到不可用的一边回 409（两边都可能缺：Rust 二进制没编出来 / werift 没装）。
pub fn plan(input: &Value) -> Value {
    let current = backend(&input["currentBackend"]).unwrap_or_else(|| "rust".into());
    let rust_available = input["rustAvailable"] == true;
    let node_available = input["nodeAvailable"] == true;
    let save = input["action"] == "save";
    let configured = if save {
        let Some(requested) = backend(&input["requestedBackend"]) else {
            return json!({"status":400,"error":"远程屏幕后端只支持 node 或 rust"});
        };
        if requested == "rust" && !rust_available {
            return json!({"status":409,"error":"Rust 远控进程尚未构建或不可用，请先构建 multicc-remote"});
        }
        if requested == "node" && !node_available {
            return json!({"status":409,"error":"Node 回退版不可用（缺少 werift 依赖），请先安装依赖"});
        }
        requested
    } else {
        backend(&input["configuredBackend"]).unwrap_or_else(|| "rust".into())
    };
    let mut result = json!({"status":200,"currentBackend":current,"configuredBackend":configured,
        "restartRequired":current != configured,"rustAvailable":rust_available,
        "nodeAvailable":node_available});
    if save {
        result["updates"] = json!({"MULTICC_REMOTE_SCREEN_BACKEND":configured});
    }
    result
}

#[napi]
pub fn remote_screen_backend_settings(input: String) -> Result<String> {
    let input = serde_json::from_str(&input)
        .map_err(|_| napi::Error::from_reason("远程屏幕设置输入无效"))?;
    Ok(plan(&input).to_string())
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
        assert_eq!(view["rustAvailable"], false);
        assert_eq!(view["nodeAvailable"], false);
        let pending = plan(&json!({"currentBackend":"rust","configuredBackend":"node",
            "rustAvailable":true,"nodeAvailable":true}));
        assert_eq!(pending["restartRequired"], true);
        assert!(pending.get("updates").is_none());
        let missing = plan(&json!({"currentBackend":"node"}));
        assert_eq!(missing["configuredBackend"], "rust");
        assert_eq!(missing["restartRequired"], true);
        let pinned = plan(&json!({"currentBackend":"node","configuredBackend":"node"}));
        assert_eq!(pinned["configuredBackend"], "node");
        assert_eq!(pinned["restartRequired"], false);
    }

    #[test]
    fn save_is_narrow_and_does_not_claim_runtime_switched() {
        let view = plan(&json!({"action":"save","currentBackend":"rust",
            "requestedBackend":" Node ","rustAvailable":true,"nodeAvailable":true,
            "SECRET":"never-return-this"}));
        assert_eq!(view["currentBackend"], "rust");
        assert_eq!(view["configuredBackend"], "node");
        assert_eq!(view["restartRequired"], true);
        assert_eq!(
            view["updates"],
            json!({"MULTICC_REMOTE_SCREEN_BACKEND":"node"})
        );
        assert!(!view.to_string().contains("never-return-this"));
    }

    #[test]
    fn unavailable_side_rejects_switch_but_allows_the_other() {
        let rust = json!({"action":"save","requestedBackend":"rust","rustAvailable":false,"nodeAvailable":true});
        assert_eq!(plan(&rust)["status"], 409);
        let node = json!({"action":"save","requestedBackend":"node","rustAvailable":true,"nodeAvailable":false});
        assert_eq!(plan(&node)["status"], 409);
        let rollback = json!({"action":"save","requestedBackend":"node","rustAvailable":false,"nodeAvailable":true});
        assert_eq!(plan(&rollback)["status"], 200);
        let restore = json!({"action":"save","requestedBackend":"rust","rustAvailable":true,"nodeAvailable":false});
        assert_eq!(plan(&restore)["status"], 200);
        for invalid in [
            Value::Null,
            json!(true),
            json!({}),
            json!("auto"),
            json!("rust\nOTHER=1"),
        ] {
            let view = plan(&json!({"action":"save","requestedBackend":invalid,
                "rustAvailable":true,"nodeAvailable":true}));
            assert_eq!(view["status"], 400);
            assert!(view.get("updates").is_none());
        }
    }
}
