//! Third-party relay balance (`panel-auto`). Most relays run one of a few
//! open-source panels, so instead of per-site adapters we probe the panel
//! balance APIs with the provider's own key and remember which one answered:
//!
//! - `newapi-token`: new-api `GET /api/usage/token` (token quota, plus the
//!   account balance when the token may query it)
//! - `sub2api`: sub2api `GET /v1/usage`
//! - `newapi-billing`: one-api/new-api OpenAI-style billing endpoints
//! - `general`: generic `GET /user/balance`
//!
//! Response headers are never used (relays strip rate-limit headers).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use multicc_core::js::serde::js_to_number;
use reqwest::{Method, Url};
use serde_json::{json, Value};

use super::provider_balance_adapters::{bearer, read_json};
use super::App;

const STEP_TIMEOUT_MS: u64 = 4000;
const DETECTED_TTL_MS: i64 = 24 * 3600 * 1000;
const MISS_TTL_MS: i64 = 3600 * 1000;
const MAX_FAILURES: u8 = 3;
const DEFAULT_QUOTA_PER_UNIT: f64 = 500_000.0;
/// one-api/new-api report an unlimited token as a 1e8 USD hard limit.
const UNLIMITED_USD: f64 = 99_000_000.0;
const MODES: [&str; 4] = ["newapi-token", "sub2api", "newapi-billing", "general"];

#[derive(Clone, Copy)]
struct Probe {
    mode: Option<&'static str>,
    at: i64,
    failures: u8,
}

fn probes() -> &'static Mutex<HashMap<String, Probe>> {
    static PROBES: OnceLock<Mutex<HashMap<String, Probe>>> = OnceLock::new();
    PROBES.get_or_init(Default::default)
}

/// What one panel API said about this relay.
#[derive(Debug, PartialEq)]
enum Outcome {
    Balance(Value),
    /// The panel API exists but exposes no balance for this key.
    NoBalance(String),
    /// Not this panel (404, HTML, foreign JSON shape, auth refused, ...).
    Miss(String),
}

fn origin(base_url: &str) -> Option<String> {
    let url = Url::parse(base_url.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

fn num(value: &Value) -> Option<f64> {
    if value.is_null() || value.as_str().is_some_and(|s| s.trim().is_empty()) {
        return None;
    }
    let n = js_to_number(value);
    n.is_finite().then_some(n)
}

fn money(n: f64) -> f64 {
    (n * 10_000.0).round() / 10_000.0
}

fn dto(
    source: &str,
    scope: &str,
    remaining: f64,
    limit: Option<f64>,
    used: Option<f64>,
    currency: Value,
) -> Value {
    json!({"kind":"balance","source":source,"scope":scope,"available":remaining > 0.0,
        "total":money(remaining),"limit":limit.map(money),"used":used.map(money),"currency":currency})
}

fn newapi_token(body: &Value, per_unit: f64) -> Outcome {
    let data = &body["data"];
    if data["object"] != "token_usage" {
        return Outcome::Miss("not a new-api token usage response".into());
    }
    let user = &data["user_quota"];
    if let Some(left) = num(&user["total_available"]).or_else(|| num(&user["quota"])) {
        let used = num(&user["total_used"]).or_else(|| num(&user["used_quota"]));
        let limit = used.map(|used| (left + used) / per_unit);
        return Outcome::Balance(dto(
            "newapi-token",
            "account",
            left / per_unit,
            limit,
            used.map(|n| n / per_unit),
            json!("USD"),
        ));
    }
    if data["unlimited_quota"] == true {
        return Outcome::NoBalance(
            "relay token has no quota limit and the panel does not let it read the account balance"
                .into(),
        );
    }
    let Some(left) = num(&data["total_available"]) else {
        return Outcome::NoBalance("new-api token usage has no total_available".into());
    };
    Outcome::Balance(dto(
        "newapi-token",
        "token",
        left / per_unit,
        num(&data["total_granted"]).map(|n| n / per_unit),
        num(&data["total_used"]).map(|n| n / per_unit),
        json!("USD"),
    ))
}

fn sub2api(body: &Value) -> Outcome {
    let quota = &body["quota"];
    let currency = quota["unit"]
        .as_str()
        .or(body["unit"].as_str())
        .map_or(Value::Null, |s| json!(s));
    if let Some(left) = num(&quota["remaining"]) {
        return Outcome::Balance(dto(
            "sub2api",
            "token",
            left,
            num(&quota["limit"]),
            num(&quota["used"]),
            currency,
        ));
    }
    let left = num(&body["remaining"]).or_else(|| num(&body["balance"]));
    match (left, body["mode"].as_str()) {
        (Some(left), _) => Outcome::Balance(dto("sub2api", "account", left, None, None, currency)),
        (None, Some(_)) => Outcome::NoBalance("sub2api usage has no remaining quota".into()),
        (None, None) => Outcome::Miss("not a sub2api usage response".into()),
    }
}

fn billing(subscription: &Value, usage: Option<&Value>) -> Outcome {
    if subscription["object"] != "billing_subscription" {
        return Outcome::Miss("not an OpenAI-style billing subscription".into());
    }
    let Some(hard) = num(&subscription["hard_limit_usd"]) else {
        return Outcome::NoBalance("billing subscription has no hard_limit_usd".into());
    };
    if hard >= UNLIMITED_USD {
        return Outcome::NoBalance(
            "relay token is unlimited; billing API reports no balance".into(),
        );
    }
    // total_usage is in US cents and always cumulative on these panels.
    let used = usage
        .and_then(|usage| num(&usage["total_usage"]))
        .map(|cents| cents / 100.0);
    let Some(used) = used else {
        return Outcome::NoBalance("billing usage unavailable".into());
    };
    Outcome::Balance(dto(
        "newapi-billing",
        "token",
        hard - used,
        Some(hard),
        Some(used),
        json!("USD"),
    ))
}

fn general(body: &Value) -> Outcome {
    if let Some(info) = body["balance_infos"]
        .as_array()
        .and_then(|infos| infos.first())
    {
        if let Some(left) = num(&info["total_balance"]) {
            return Outcome::Balance(dto(
                "general",
                "account",
                left,
                None,
                None,
                info["currency"].clone(),
            ));
        }
    }
    for scope in [body, &body["data"]] {
        for key in ["balance", "total_balance", "available_balance", "remaining"] {
            if let Some(left) = num(&scope[key]) {
                let currency = scope["currency"].as_str().map_or(Value::Null, |s| json!(s));
                return Outcome::Balance(dto("general", "account", left, None, None, currency));
            }
        }
    }
    Outcome::Miss("no balance field in /user/balance".into())
}

async fn get(app: &App, url: String, key: &str) -> Result<Value, String> {
    read_json(app, &url, Method::GET, bearer(key), STEP_TIMEOUT_MS)
        .await
        .map_err(|error| error.detail)
}

async fn quota_per_unit(app: &App, origin: &str) -> f64 {
    let status = read_json(
        app,
        &format!("{origin}/api/status"),
        Method::GET,
        Vec::new(),
        STEP_TIMEOUT_MS,
    )
    .await;
    status
        .ok()
        .and_then(|body| num(&body["data"]["quota_per_unit"]))
        .filter(|n| *n > 0.0)
        .unwrap_or(DEFAULT_QUOTA_PER_UNIT)
}

async fn try_mode(app: &App, mode: &str, origin: &str, key: &str) -> Outcome {
    let miss = Outcome::Miss;
    match mode {
        "newapi-token" => match get(app, format!("{origin}/api/usage/token"), key).await {
            Ok(body) if body["data"]["object"] == "token_usage" => {
                newapi_token(&body, quota_per_unit(app, origin).await)
            }
            Ok(body) => newapi_token(&body, DEFAULT_QUOTA_PER_UNIT),
            Err(detail) => miss(detail),
        },
        "sub2api" => get(app, format!("{origin}/v1/usage"), key)
            .await
            .map_or_else(miss, |b| sub2api(&b)),
        "newapi-billing" => match get(
            app,
            format!("{origin}/v1/dashboard/billing/subscription"),
            key,
        )
        .await
        {
            Ok(subscription) => {
                let usage = get(app, format!("{origin}/v1/dashboard/billing/usage"), key)
                    .await
                    .ok();
                billing(&subscription, usage.as_ref())
            }
            Err(detail) => miss(detail),
        },
        "general" => get(app, format!("{origin}/user/balance"), key)
            .await
            .map_or_else(miss, |b| general(&b)),
        _ => miss("unknown panel mode".into()),
    }
}

fn remember(origin: &str, probe: Option<Probe>) {
    let mut map = probes().lock().unwrap_or_else(|e| e.into_inner());
    match probe {
        Some(probe) => map.insert(origin.to_string(), probe),
        None => map.remove(origin),
    };
}

fn finish(outcome: Outcome) -> Result<Option<Value>, String> {
    match outcome {
        Outcome::Balance(dto) => Ok(Some(dto)),
        Outcome::NoBalance(detail) | Outcome::Miss(detail) => Err(detail),
    }
}

pub async fn poll(app: &App, target: &Value, now_ms: i64) -> Result<Option<Value>, String> {
    let key = target["apiKey"].as_str().unwrap_or("").trim();
    let Some(origin) = origin(target["baseUrl"].as_str().unwrap_or("")) else {
        return Ok(None);
    };
    if key.is_empty() {
        return Ok(None);
    }
    let cached = probes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&origin)
        .copied();
    if let Some(probe) = cached {
        match probe.mode {
            None if now_ms - probe.at < MISS_TTL_MS => {
                return Err("no relay-panel balance API detected for this relay".into());
            }
            Some(mode) if now_ms - probe.at < DETECTED_TTL_MS => {
                let outcome = try_mode(app, mode, &origin, key).await;
                let failures = if matches!(outcome, Outcome::Miss(_)) {
                    probe.failures + 1
                } else {
                    0
                };
                remember(
                    &origin,
                    (failures < MAX_FAILURES).then_some(Probe { failures, ..probe }),
                );
                return finish(outcome);
            }
            _ => {}
        }
    }
    let mut misses = Vec::new();
    for mode in MODES {
        match try_mode(app, mode, &origin, key).await {
            Outcome::Miss(detail) => misses.push(format!("{mode}: {detail}")),
            outcome => {
                remember(
                    &origin,
                    Some(Probe {
                        mode: Some(mode),
                        at: now_ms,
                        failures: 0,
                    }),
                );
                return finish(outcome);
            }
        }
    }
    remember(
        &origin,
        Some(Probe {
            mode: None,
            at: now_ms,
            failures: 0,
        }),
    );
    let detail = format!(
        "no relay-panel balance API detected ({})",
        misses.join("; ")
    );
    Err(detail.chars().take(280).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn balance(outcome: Outcome) -> Value {
        match outcome {
            Outcome::Balance(dto) => dto,
            other => panic!("expected balance, got {other:?}"),
        }
    }

    #[test]
    fn origin_drops_path_and_keeps_port() {
        assert_eq!(
            origin("https://newapi.eronmind.com/v1/").as_deref(),
            Some("https://newapi.eronmind.com")
        );
        assert_eq!(
            origin("http://1.2.3.4:3000/api").as_deref(),
            Some("http://1.2.3.4:3000")
        );
        assert_eq!(origin("ftp://x"), None);
    }

    #[test]
    fn newapi_unlimited_token_without_account_access_has_no_balance() {
        // Captured from newapi.eronmind.com (2026-11-12).
        let body = json!({"code":true,"data":{"expires_at":0,"name":"fable","object":"token_usage",
            "total_available":-810,"total_granted":1969,"total_used":2779,"unlimited_quota":true},"message":"ok"});
        assert!(matches!(
            newapi_token(&body, 500_000.0),
            Outcome::NoBalance(_)
        ));
    }

    #[test]
    fn newapi_prefers_account_quota_then_token_quota() {
        let body = json!({"data":{"object":"token_usage","unlimited_quota":true,
            "user_quota":{"total_available":5_000_000,"total_used":1_000_000}}});
        let dto = balance(newapi_token(&body, 500_000.0));
        assert_eq!(
            (
                dto["scope"].as_str(),
                dto["total"].as_f64(),
                dto["limit"].as_f64()
            ),
            (Some("account"), Some(10.0), Some(12.0))
        );
        let body = json!({"data":{"object":"token_usage","unlimited_quota":false,
            "total_available":250_000,"total_granted":500_000,"total_used":250_000}});
        let dto = balance(newapi_token(&body, 500_000.0));
        assert_eq!(
            (
                dto["scope"].as_str(),
                dto["total"].as_f64(),
                dto["available"].as_bool()
            ),
            (Some("token"), Some(0.5), Some(true))
        );
        let body = json!({"data":{"object":"token_usage","total_available":-5}});
        assert_eq!(balance(newapi_token(&body, 500_000.0))["available"], false);
        assert!(matches!(
            newapi_token(&json!({"error":"x"}), 500_000.0),
            Outcome::Miss(_)
        ));
    }

    #[test]
    fn billing_rejects_unlimited_sentinel_and_converts_cents() {
        let unlimited = json!({"object":"billing_subscription","hard_limit_usd":100000000});
        assert!(matches!(
            billing(&unlimited, Some(&json!({"total_usage":55.58}))),
            Outcome::NoBalance(_)
        ));
        let limited = json!({"object":"billing_subscription","hard_limit_usd":20});
        let dto = balance(billing(&limited, Some(&json!({"total_usage":550}))));
        assert_eq!(dto["total"], 14.5);
        assert!(matches!(
            billing(&json!({"object":"list"}), None),
            Outcome::Miss(_)
        ));
    }

    #[test]
    fn sub2api_reads_quota_or_balance() {
        let dto = balance(sub2api(
            &json!({"mode":"quota_limited","quota":{"limit":50,"used":20,"remaining":30,"unit":"USD"}}),
        ));
        assert_eq!(
            (dto["total"].as_f64(), dto["currency"].as_str()),
            (Some(30.0), Some("USD"))
        );
        let dto = balance(sub2api(&json!({"mode":"unrestricted","balance":"8.25"})));
        assert_eq!(dto["total"], 8.25);
        assert!(matches!(
            sub2api(&json!({"mode":"unrestricted"})),
            Outcome::NoBalance(_)
        ));
        assert!(matches!(
            sub2api(&json!({"error":{"message":"Invalid URL"}})),
            Outcome::Miss(_)
        ));
    }

    #[test]
    fn general_reads_deepseek_shape_and_flat_fields() {
        let dto = balance(general(
            &json!({"balance_infos":[{"currency":"CNY","total_balance":"3.5"}]}),
        ));
        assert_eq!(
            (dto["total"].as_f64(), dto["currency"].as_str()),
            (Some(3.5), Some("CNY"))
        );
        assert_eq!(
            balance(general(&json!({"data":{"balance":7}})))["total"],
            7.0
        );
        assert!(matches!(general(&json!({"ok":true})), Outcome::Miss(_)));
    }
}
