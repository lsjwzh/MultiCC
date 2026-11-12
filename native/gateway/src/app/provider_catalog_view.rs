//! 从宿主的无凭据快照组装公开目录。宿主只保留运行时读取与刷新回调。

use multicc_core::js::serde::truthy;
use multicc_core::{provider_registry, subscription_cache, virtual_provider};
use serde_json::{json, Map, Value};

fn rows(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn key(provider: &Value) -> String {
    format!(
        "{}:{}",
        provider["appType"].as_str().unwrap_or(""),
        provider["id"].as_str().unwrap_or("")
    )
}

/// 宿主 provider summary 已携带经过凭据门禁的 compatibleClis。
/// 虚拟线路的 summary 也用相同字段限制为其自身 CLI 的两条线路。
fn supports_cli(provider: &Value, cli: &str) -> bool {
    cli.is_empty()
        || rows(&provider["compatibleClis"])
            .iter()
            .any(|value| value.as_str() == Some(cli))
}

fn limit(facts: &Value, provider_key: &str) -> Value {
    let entry = &facts["limits"][provider_key];
    if !entry.is_object() {
        return Value::Null;
    }
    let stale = entry["fetchedAt"].as_f64().is_some_and(|at| {
        facts["nowMs"].as_f64().unwrap_or(0.0) - at
            > facts["limitCacheStaleMs"].as_f64().unwrap_or(0.0)
    });
    let mut out = Map::new();
    for name in ["kind", "status", "summary", "summaryText"] {
        if let Some(value) = entry.get(name) {
            out.insert(name.to_string(), value.clone());
        }
    }
    out.insert("bar".into(), facts["limitBars"][provider_key].clone());
    for name in ["fetchedAt", "updatedAt", "lastError", "lastErrorAt"] {
        if let Some(value) = entry.get(name) {
            out.insert(name.to_string(), value.clone());
        }
    }
    out.insert("stale".into(), Value::Bool(stale));
    Value::Object(out)
}

pub(super) fn project(facts: &Value, cli: &str) -> Value {
    let mut projected = facts.clone();
    let providers = rows(&facts["providers"])
        .iter()
        .filter(|provider| supports_cli(provider, cli))
        .map(|provider| {
            let mut provider = provider.clone();
            let subscription = subscription_cache::for_provider(&provider, &facts["subscriptions"]);
            if subscription.is_object() {
                provider["subscription"] = subscription;
            }
            let provider_key = key(&provider);
            if facts["limits"].is_object() {
                provider["limit"] = limit(facts, &provider_key);
            }
            if provider.get("virtual").is_some_and(truthy) {
                let input = &facts["virtualInputs"][&provider_key];
                provider["virtualStatus"] = input
                    .is_object()
                    .then(|| virtual_provider::select(&input.to_string()).ok())
                    .flatten()
                    .and_then(|result| serde_json::from_str::<Value>(&result).ok())
                    .unwrap_or_else(
                        || json!({"availableCount": 0, "error": "请更新 Rust 模块并手动重启服务"}),
                    );
            }
            provider
        })
        .collect::<Vec<_>>();
    projected["providers"] = Value::Array(providers);
    provider_registry::catalog_body(&projected)
}

pub(super) fn refresh_ids(catalog: &Value) -> Vec<Value> {
    rows(&catalog["providers"])
        .iter()
        .filter(|provider| provider["appType"] == "codex" && truthy(&provider["isOfficial"]))
        .filter_map(|provider| provider.get("id").cloned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filtering_projection_and_refresh_use_the_same_selected_catalog() {
        let facts = json!({
            "providers": [
                {"id":"a","appType":"claude","compatibleClis":["claude"]},
                {"id":"b","appType":"codex","compatibleClis":["codex"],"isOfficial":true},
                {"id":"c","appType":"codex","compatibleClis":["codex"],"isOfficial":true,"officialAccountId":"other"}
            ],
            "subscriptions": {"codex:global":{"subscription":{"autoRenew":false,"observedAt":100}}},
            "limits": {"codex:b":{"kind":"window","summary":{"usedPercentage":20},"fetchedAt":100,"barText":"private storage field","lastAttemptAt":123}},
            "limitBars": {"codex:b":{"text":"80%"}},
            "limitCacheStaleMs":50,
            "nowMs":200
        });
        let catalog = project(&facts, "codex");
        assert_eq!(catalog["providers"].as_array().unwrap().len(), 2);
        assert_eq!(catalog["providers"][0]["id"], "b");
        assert_eq!(catalog["providers"][0]["subscription"]["autoRenew"], false);
        assert!(catalog["providers"][1].get("subscription").is_none());
        assert_eq!(catalog["providers"][0]["limit"]["stale"], true);
        assert_eq!(catalog["providers"][0]["limit"]["bar"]["text"], "80%");
        assert!(catalog["providers"][0]["limit"].get("barText").is_none());
        assert!(catalog["providers"][0]["limit"]
            .get("lastAttemptAt")
            .is_none());
        assert_eq!(refresh_ids(&catalog), vec![json!("b"), json!("c")]);
        assert!(refresh_ids(&project(&facts, "claude")).is_empty());
    }

    #[test]
    fn virtual_status_uses_the_shared_selector_and_retains_the_failure_shape() {
        let mut facts = json!({
            "providers":[{"id":"pool","appType":"claude","virtual":{"members":[{"id":"a"}]},"compatibleClis":["claude"]}],
            "virtualInputs":{"claude:pool":{
                "providerId":"pool","appType":"claude","virtual":{"members":[{"id":"a"}]},
                "providers":[{"id":"a","appType":"claude","name":"A"}],"now":1000
            }}
        });
        let catalog = project(&facts, "claude");
        assert_eq!(catalog["providers"][0]["virtualStatus"]["selectedId"], "a");
        assert_eq!(
            catalog["providers"][0]["virtualStatus"]["availableCount"],
            1
        );
        facts["virtualInputs"]["claude:pool"] = Value::Null;
        assert_eq!(
            project(&facts, "claude")["providers"][0]["virtualStatus"],
            json!({"availableCount":0,"error":"请更新 Rust 模块并手动重启服务"})
        );
    }
}
