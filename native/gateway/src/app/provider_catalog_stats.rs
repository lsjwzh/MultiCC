//! Picker usage is attributed by provider at event time in the daily ledger.
use multicc_core::{provider_store, provider_usage};
use serde_json::{json, Value};
use std::path::Path;
pub(super) fn read(root: &Path, providers: &[Value]) -> Value {
    let Ok(Some(daily)) = provider_store::read(&root.join("token_daily.json")) else {
        return json!([]);
    };
    let windows = provider_usage::windows(&daily);
    let sessions = super::directory_list::records(&root.join("sessions.json")).unwrap_or_default();
    let mut out = Vec::new();
    for (id, w) in windows.as_object().into_iter().flatten() {
        let mut stat = w["all"].clone();
        let p = providers
            .iter()
            .find(|p| p["id"] == *id && p["builtinOfficial"] != true);
        stat["providerId"] = json!(id);
        stat["providerName"] = json!(if id == "_default_" {
            "默认登录"
        } else {
            p.and_then(|p| p["name"].as_str()).unwrap_or(id)
        });
        stat["appType"] = json!(p.map(|p| &p["appType"]));
        stat["sessionCount"] = json!(sessions
            .iter()
            .filter(|s| s["provider"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("_default_")
                == id)
            .count());
        stat["totalTokens"] = provider_usage::number(
            provider_usage::value(&stat, "inputTokens")
                + provider_usage::value(&stat, "outputTokens"),
        );
        for k in ["today", "week", "month"] {
            stat[k] = w[k].clone();
        }
        out.push(stat);
    }
    out.sort_by(|a, b| {
        provider_usage::value(b, "totalTokens").total_cmp(&provider_usage::value(a, "totalTokens"))
    });
    out.into()
}
