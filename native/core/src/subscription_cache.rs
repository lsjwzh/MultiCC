//! Durable, credential-free billing observations. Quota writes use a separate
//! table, so a fresh usage sample cannot erase a cancellation or renewal date.
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use std::time::Duration;

fn snapshot(value: &Value) -> Option<Value> {
    let date = |key: &str| {
        value[key]
            .as_f64()
            .filter(|n| (946684800000.0..4102444800000.0).contains(n))
    };
    let next = date("nextBillingAt");
    let end = date("currentPeriodEnd");
    let renew = value["autoRenew"].as_bool();
    if next.is_none() && end.is_none() && renew != Some(false) {
        return None;
    }
    Some(
        json!({"nextBillingAt":if renew == Some(false) {None} else {next},
        "currentPeriodEnd":end,"autoRenew":renew,"observedAt":date("observedAt"),
        "source":match value["source"].as_str() {Some("login")=>"login",Some("usage")=>"usage",Some("profile")=>"profile",_=>"account"}}),
    )
}

pub fn for_provider(provider: &Value, entries: &Value) -> Value {
    let saved = &provider["subscription"];
    if provider["isOfficial"] != true && provider["builtinOfficial"] != true {
        return saved.clone();
    }
    let vendor = provider["appType"].as_str().unwrap_or("");
    let account = provider["officialAccountId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("global");
    let live = &entries[format!("{vendor}:{account}")]["subscription"];
    if live.is_object()
        && (!saved.is_object()
            || live["observedAt"].as_f64().unwrap_or(0.0)
                >= saved["observedAt"].as_f64().unwrap_or(0.0))
    {
        live.clone()
    } else {
        saved.clone()
    }
}

pub fn project(input: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(input).map_err(|_| "invalid subscription projection")?;
    let mut providers = v["providers"].as_array().cloned().unwrap_or_default();
    for p in &mut providers {
        let subscription = for_provider(p, &v["subscriptions"]);
        if subscription.is_object() {
            p["subscription"] = subscription;
        }
    }
    Ok(Value::Array(providers).to_string())
}

pub fn access(file: &str, input: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(input).map_err(|_| "invalid subscription cache input")?;
    let db = Connection::open(file).map_err(|_| "subscription cache unavailable")?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|_| "subscription cache unavailable")?;
    // This is the host's existing private provider-limit database (0600).
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS provider_subscriptions (
        vendor TEXT NOT NULL, account_id TEXT NOT NULL, subscription_json TEXT,
        observed_at REAL NOT NULL DEFAULT 0, last_attempt_at REAL NOT NULL,
        PRIMARY KEY(vendor, account_id)) WITHOUT ROWID;",
    )
    .map_err(|_| "subscription schema unavailable")?;
    if v["operation"] == "record" {
        let vendor = v["vendor"].as_str().unwrap_or("");
        let account = v["accountId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("global");
        if !["claude", "codex"].contains(&vendor)
            || !(account == "global"
                || account.len() == 16
                    && account
                        .bytes()
                        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
        {
            return Err("invalid subscription identity".into());
        }
        let at = v["attemptAt"]
            .as_f64()
            .filter(|n| n.is_finite() && *n > 0.0)
            .ok_or("invalid subscription clock")?;
        let sub = if v["result"]["status"] == "ok" {
            snapshot(&v["result"]["subscription"])
        } else {
            None
        };
        let observed = sub
            .as_ref()
            .and_then(|s| s["observedAt"].as_f64())
            .unwrap_or(0.0);
        db.execute("INSERT INTO provider_subscriptions(vendor,account_id,subscription_json,observed_at,last_attempt_at)
            VALUES (?1,?2,?3,?4,?5) ON CONFLICT(vendor,account_id) DO UPDATE SET
            subscription_json=CASE WHEN excluded.subscription_json IS NOT NULL AND excluded.observed_at >= observed_at THEN excluded.subscription_json ELSE subscription_json END,
            observed_at=MAX(observed_at,excluded.observed_at),last_attempt_at=MAX(last_attempt_at,excluded.last_attempt_at)",
            params![vendor,account,sub.map(|s| s.to_string()),observed,at]).map_err(|_| "subscription write failed")?;
    } else if v["operation"] != "read" {
        return Err("invalid subscription operation".into());
    }
    let mut stmt = db.prepare("SELECT vendor,account_id,subscription_json,last_attempt_at FROM provider_subscriptions").map_err(|_| "subscription read failed")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, f64>(3)?,
            ))
        })
        .map_err(|_| "subscription read failed")?;
    let mut entries = Map::new();
    for row in rows {
        let (vendor, account, sub, at) = row.map_err(|_| "subscription read failed")?;
        let sub = sub
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|s| snapshot(&s));
        entries.insert(
            format!("{vendor}:{account}"),
            json!({"subscription":sub,"lastAttemptAt":at}),
        );
    }
    Ok(Value::Object(entries).to_string())
}
