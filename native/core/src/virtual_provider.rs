//! Virtual providers contain identities only. Credentials stay in the host's
//! existing store; this module owns validation, eligibility and failover policy.
use serde_json::{json, Value};

fn rows(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn number(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}

pub fn validate(input: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(input).map_err(|_| "Invalid virtual provider")?;
    let kind = text(&v["appType"]);
    if !["claude", "codex"].contains(&kind) {
        return Err("请选择 Claude 或 Codex CLI".into());
    }
    let config = &v["virtual"];
    let members = rows(&config["members"]);
    if members.is_empty() || members.len() > 32 {
        return Err("虚拟线路需要 1–32 个成员".into());
    }
    let strategy = config["strategy"].as_str().unwrap_or("expiry");
    if !["expiry", "ordered"].contains(&strategy) {
        return Err("无效的切换策略".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut normalized = Vec::new();
    let mut models: Option<Vec<String>> = None;
    for member in members {
        let id = text(&member["id"]);
        if id.is_empty() || id == text(&v["id"]) || !seen.insert(id) {
            return Err("成员重复或引用自身".into());
        }
        let p = rows(&v["providers"])
            .iter()
            .find(|p| text(&p["id"]) == id)
            .ok_or("成员不存在，请刷新线路列表")?;
        if text(&p["appType"]) != kind || p["virtual"].is_object() {
            return Err("只能组合相同 CLI 的普通线路，不能嵌套虚拟线路".into());
        }
        let expiry = &member["expiresAt"];
        if !expiry.is_null()
            && number(expiry).is_none_or(|n| !(946684800000.0..4102444800000.0).contains(&n))
        {
            return Err("到期日期无效".into());
        }
        normalized.push(json!({"id":id,"expiresAt":expiry}));
        let available: Vec<String> = rows(&p["modelOptions"])
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        // Unknown dynamic catalogs impose no constraint. Known catalogs must
        // overlap so a shared model remains callable after switching.
        if !available.is_empty() {
            models = Some(match models {
                None => available,
                Some(old) => old.into_iter().filter(|m| available.contains(m)).collect(),
            });
        }
    }
    if models.as_ref().is_some_and(Vec::is_empty) {
        return Err("成员没有共同模型，请选择模型兼容的线路".into());
    }
    Ok(json!({"virtual":{"members":normalized,"strategy":strategy},"models":models.unwrap_or_default()}).to_string())
}

fn expired_at(member: &Value, provider: &Value) -> Option<f64> {
    let billing = (provider["subscription"]["autoRenew"] == false)
        .then(|| number(&provider["subscription"]["currentPeriodEnd"]))
        .flatten();
    match (number(&member["expiresAt"]), billing) {
        (Some(manual), Some(cancelled)) => Some(manual.min(cancelled)),
        (manual, cancelled) => manual.or(cancelled),
    }
}

fn blocked(summary: &Value, model: &str, now: f64) -> Option<&'static str> {
    if text(&summary["kind"]) == "window"
        && (number(&summary["usedPercentage"]).is_some_and(|n| n >= 100.0)
            || text(&summary["status"]) == "rejected")
        && number(&summary["resetsAtMs"]).is_none_or(|n| n > now)
    {
        return Some("exhausted");
    }
    if text(&summary["kind"]) == "availability"
        && text(&summary["status"]) == "rejected"
        && number(&summary["blockedUntilMs"]).is_some_and(|n| n > now)
        && (text(&summary["scope"]) != "model" || text(&summary["model"]) == model)
    {
        return Some("cooldown");
    }
    for window in rows(&summary["windows"]) {
        if number(&window["usedPercent"]).is_some_and(|n| n >= 100.0)
            && number(&window["resetMs"]).is_none_or(|n| n > now)
        {
            return Some("exhausted");
        }
    }
    if text(&summary["kind"]) == "balance"
        && (summary["available"] == false
            || number(&summary["total"])
                .or_else(|| number(&summary["available"]))
                .is_some_and(|n| n <= 0.0))
    {
        return Some("exhausted");
    }
    None
}

pub fn select(input: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(input).map_err(|_| "Invalid virtual routing input")?;
    let now = number(&v["now"]).ok_or("Missing routing clock")?;
    let kind = text(&v["appType"]);
    let model = text(&v["model"]);
    let mut candidates = Vec::new();
    let mut members = Vec::new();
    let mut refresh = Vec::new();
    let mut subscription_refresh = Vec::new();
    for (order, member) in rows(&v["virtual"]["members"]).iter().enumerate() {
        let id = text(&member["id"]);
        let p = rows(&v["providers"])
            .iter()
            .find(|p| text(&p["id"]) == id)
            .unwrap_or(&Value::Null);
        let limit = &v["limits"][format!("{kind}:{id}")];
        let mut observed = p.clone();
        if observed.is_object() {
            observed["subscription"] =
                crate::subscription_cache::for_provider(p, &v["subscriptions"]);
        }
        let expiry = expired_at(member, &observed);
        let models = rows(&p["modelOptions"]);
        if (p["isOfficial"] == true || p["builtinOfficial"] == true)
            && p["virtualGateAllowed"] != false
            && p["needsLogin"] != true
        {
            let account = p["officialAccountId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("global");
            if number(&v["subscriptions"][format!("{kind}:{account}")]["lastAttemptAt"])
                .is_none_or(|at| now - at >= 300000.0)
            {
                subscription_refresh.push(id);
            }
        }
        if !p.is_null()
            && number(&limit["lastAttemptAt"])
                .or_else(|| number(&limit["fetchedAt"]))
                .is_none_or(|n| now - n >= 300000.0)
        {
            refresh.push(id);
        }
        let reason = if p.is_null() || text(&p["appType"]) != kind || p["virtual"].is_object() {
            Some("missing")
        } else if p["virtualGateAllowed"] == false {
            Some("guard")
        } else if p["needsLogin"] == true {
            Some("login")
        } else if rows(&v["excluded"]).iter().any(|x| text(x) == id) {
            Some("attempted")
        } else if expiry.is_some_and(|n| n <= now) {
            Some("expired")
        } else if !model.is_empty()
            && !models.is_empty()
            && !models.iter().any(|m| text(m) == model)
            && !(kind == "claude" && ["haiku", "sonnet", "opus", "fable"].contains(&model))
        {
            Some("model")
        } else {
            blocked(&limit["summary"], model, now)
        };
        if reason.is_none() {
            candidates.push((id, expiry.unwrap_or(f64::MAX), order));
        }
        members.push(
            json!({"id":id,"name":p["name"],"expiresAt":expiry,"subscription":observed["subscription"],
            "available":reason.is_none(),"reason":reason,"limit":limit}),
        );
    }
    if text(&v["virtual"]["strategy"]) != "ordered" {
        candidates.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.2.cmp(&b.2)));
    }
    Ok(json!({"selectedId":candidates.first().map(|x|x.0),"members":members,"availableCount":candidates.len(),"refreshIds":refresh,"subscriptionRefreshIds":subscription_refresh}).to_string())
}

/// Only explicit pre-stream rejection is replayable. Never retry ambiguous
/// network failures, 5xx responses or a stream that already produced output.
pub fn failure(input: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(input).map_err(|_| "Invalid virtual outcome")?;
    let status = v["status"].as_u64().unwrap_or(0);
    let retry = [401, 402, 403, 429].contains(&status) && v["headersSent"] != true;
    let now = number(&v["now"]).unwrap_or(0.0);
    let previous = &v["previous"];
    let window_reset = rows(&previous["windows"])
        .iter()
        .filter(|w| number(&w["usedPercent"]).is_some_and(|n| n >= 100.0))
        .filter_map(|w| number(&w["resetMs"]))
        .filter(|n| *n > now)
        .max_by(f64::total_cmp);
    let reset = number(&v["resetMs"])
        .filter(|n| *n > now)
        .or(window_reset)
        .or_else(|| number(&previous["resetsAtMs"]).filter(|n| *n > now))
        .unwrap_or(now + 300000.0)
        .min(now + 8.0 * 86400000.0);
    Ok(json!({"retry":retry,"record":retry.then(||json!({"kind":"availability","status":"ok",
        "summary":{"kind":"availability","status":"rejected","blockedUntilMs":reset,"httpStatus":status},
        "summaryText":"暂不可用，已切换候选线路","fetchedAt":now}))}).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        json!({"now":1900000000000_f64,"appType":"codex","virtual":{"strategy":"expiry","members":[{"id":"a"},{"id":"b","expiresAt":1900000100000_f64}]},"providers":[{"id":"a","appType":"codex","modelOptions":["m"]},{"id":"b","appType":"codex","modelOptions":["m"]}],"limits":{}})
    }
    fn chosen(v: &Value) -> Value {
        serde_json::from_str(&select(&v.to_string()).unwrap()).unwrap()
    }
    #[test]
    fn expires_first_then_skips_empty_and_recovers_after_reset() {
        let mut v = fixture();
        assert_eq!(chosen(&v)["selectedId"], "b");
        v["limits"]["codex:b"] = json!({"summary":{"kind":"windows","windows":[{"usedPercent":100,"resetMs":1900000010000_f64}]}});
        assert_eq!(chosen(&v)["selectedId"], "a");
        v["now"] = json!(1900000020000_f64);
        assert_eq!(chosen(&v)["selectedId"], "b");
        v["now"] = json!(1900000200000_f64);
        assert_eq!(chosen(&v)["selectedId"], "a");
    }
    #[test]
    fn balance_cache_uses_amount_and_availability_without_guessing_unknown() {
        let mut v = fixture();
        for summary in [
            json!({"kind":"balance","available":true,"total":0}),
            json!({"kind":"balance","available":false,"total":20}),
            json!({"kind":"balance","available":0}),
        ] {
            v["limits"]["codex:b"] = json!({"summary":summary});
            assert_eq!(chosen(&v)["selectedId"], "a");
        }
        for summary in [
            json!({"kind":"balance","available":true,"total":20}),
            json!({"kind":"balance","available":true,"total":null}),
            json!({"kind":"balance","available":20}),
        ] {
            v["limits"]["codex:b"] = json!({"summary":summary});
            assert_eq!(chosen(&v)["selectedId"], "b");
        }
    }
    #[test]
    fn rejects_cross_cli_nested_duplicate_and_disjoint_models() {
        let mut v = fixture();
        assert!(validate(&v.to_string()).is_ok());
        v["providers"][1]["appType"] = json!("claude");
        assert!(validate(&v.to_string()).is_err());
        v = fixture();
        v["providers"][1]["virtual"] = json!({});
        assert!(validate(&v.to_string()).is_err());
        v = fixture();
        v["virtual"]["members"][1]["id"] = json!("a");
        assert!(validate(&v.to_string()).is_err());
        v = fixture();
        v["providers"][1]["modelOptions"] = json!(["other"]);
        assert!(validate(&v.to_string()).is_err());
    }
    #[test]
    fn renewal_is_not_expiry_and_unknown_is_not_zero() {
        let mut v = fixture();
        v["virtual"]["strategy"] = json!("ordered");
        v["providers"][0]["subscription"] =
            json!({"autoRenew":true,"currentPeriodEnd":1800000000000_f64});
        assert_eq!(chosen(&v)["selectedId"], "a");
        v["providers"][0]["subscription"]["autoRenew"] = json!(false);
        assert_eq!(chosen(&v)["selectedId"], "b");
        v["virtual"]["members"][0]["expiresAt"] = json!(2000000000000_f64);
        assert_eq!(
            chosen(&v)["selectedId"],
            "b",
            "manual date cannot extend a cancelled subscription"
        );
        v["excluded"] = json!(["b"]);
        assert!(chosen(&v)["selectedId"].is_null());
    }
    #[test]
    fn safe_failover_only() {
        for status in [200, 400, 401, 402, 403, 429, 500, 502] {
            let v: Value = serde_json::from_str(
                &failure(&json!({"status":status,"now":1900000000000_f64}).to_string()).unwrap(),
            )
            .unwrap();
            assert_eq!(v["retry"], json!([401, 402, 403, 429].contains(&status)));
            let streamed: Value = serde_json::from_str(
                &failure(&json!({"status":status,"headersSent":true}).to_string()).unwrap(),
            )
            .unwrap();
            assert_eq!(streamed["retry"], false);
        }
    }
}
