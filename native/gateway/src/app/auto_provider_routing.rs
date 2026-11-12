//! `POST /api/auto-provider/routing/test`, retired from
//! `src/routes/auto-provider-routing-test.js`.
//!
//! One real Jev call on the fixed `t1`/`t2` ladder, so the Auto Provider editor
//! can prove a pasted key works. The rules (target validation, the questions,
//! the escalation policy, the response codes) live in
//! `multicc_core::provider_misc`; the vault entry is read through the existing
//! secrets-vault host port with `source: 'routing_test'`, so the audit trail
//! names the feature rather than a generic HTTP read.
//!
//! Node's `outboundFetch` routes through the system proxy policy; the front
//! door's shared client ([`crate::outbound`]) makes the same decision, so a
//! machine that reaches the internet only through Clash (or a macOS system
//! proxy) reports the real routing verdict instead of a false network failure.
//! Loopback and `NO_PROXY` targets stay direct. `MULTICC_ROUTING_TEST_URL`
//! retargets the call (and may be plain HTTP), which is how the integration
//! and differential tests script the gateway answer.

use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::provider_misc;
use serde_json::{json, Value};
use url::Url;

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;
use crate::outbound::{Outbound, Request};

const VAULT_PATH: &str = "/api/__host/secrets-vault";
const VAULT_SOURCE: &str = "routing_test";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    TestPost,
    TestOptions,
}

fn segments(path: &str) -> Option<Vec<&str>> {
    let rest = path.strip_prefix("/api/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.is_empty() {
        return None;
    }
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    Some(parts)
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let parts = segments(path)?;
    if parts.len() != 3
        || !parts[0].eq_ignore_ascii_case("auto-provider")
        || !parts[1].eq_ignore_ascii_case("routing")
        || !parts[2].eq_ignore_ascii_case("test")
    {
        return None;
    }
    match method.as_str() {
        "POST" => Some(Route::TestPost),
        "OPTIONS" => Some(Route::TestOptions),
        _ => None,
    }
}

fn now_ms(started: Instant) -> i64 {
    i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX)
}

/// `{ ok:false, code:'routing_test_failed' }` for any unexpected failure.
pub fn failed(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        500,
        &json!({ "ok": false, "code": "routing_test_failed" }),
        &[],
    )
}

enum FetchError {
    Timeout,
    Network,
}

/// `fetch(endpoint, {method:'POST', ...})` + `response.text()` through the
/// shared outbound client, so redirects and proxy selection match the runtime.
async fn fetch_jev(
    outbound: &Outbound,
    endpoint: &str,
    key: &str,
    body: &Value,
    timeout: Duration,
) -> Result<(u16, bool, String), FetchError> {
    let url = std::env::var("MULTICC_ROUTING_TEST_URL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| endpoint.to_string());
    let url = Url::parse(&url).map_err(|_| FetchError::Network)?;
    let payload = serde_json::to_vec(body).map_err(|_| FetchError::Network)?;
    let mut request = Request::get(url, timeout);
    request.method = Method::POST;
    request.headers = vec![
        ("Authorization".to_string(), format!("Bearer {key}")),
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Accept".to_string(), "application/json".to_string()),
    ];
    request.body = Some(payload);
    // Node's fetch follows redirects (and re-evaluates the exit per hop).
    request.follow_redirects = true;
    let reply = outbound.send(request).await.map_err(|error| {
        if error.is_timeout() {
            FetchError::Timeout
        } else {
            FetchError::Network
        }
    })?;
    Ok((
        reply.status,
        (200..300).contains(&reply.status),
        reply.text(),
    ))
}

async fn vault_key(host_port_num: u16, name: &str) -> Option<String> {
    let answer = host_port::call(
        host_port_num,
        VAULT_PATH,
        &json!({ "op": "reveal", "name": name, "source": VAULT_SOURCE }),
    )
    .await
    .ok()?;
    if answer.get("ok") != Some(&Value::Bool(true)) {
        return None;
    }
    let value = answer.get("value")?.as_str()?;
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub async fn handle(
    app: &App,
    route: Route,
    ctx: &RequestCtx,
    body: &Value,
    host_port_num: u16,
) -> Response<Body> {
    if route == Route::TestOptions {
        return super::options(ctx, "POST");
    }
    let started = Instant::now();
    let plan = match provider_misc::routing_plan(body) {
        Ok(plan) => plan,
        Err(dto) => return express::json(ctx, 400, &dto, &[]),
    };
    let verdict = match vault_key(host_port_num, &plan.api_key_name).await {
        Some(key) => {
            let payload = provider_misc::routing_request_body(&plan.text, &plan.model);
            let result = fetch_jev(
                &app.outbound,
                &plan.endpoint,
                &key,
                &payload,
                Duration::from_millis(provider_misc::TEST_TIMEOUT_MS),
            )
            .await;
            match result {
                Ok((status, ok, raw)) => provider_misc::routing_verdict(status, ok, &raw),
                Err(FetchError::Timeout) => json!({ "ok": false, "code": "jev_timeout" }),
                Err(FetchError::Network) => json!({ "ok": false, "code": "jev_network" }),
            }
        }
        // `resolveApiKey` returns null for a missing entry or a vault failure;
        // classify() then reports jev_key_missing.
        None => json!({ "ok": false, "code": "jev_key_missing" }),
    };
    let (status, body) = provider_misc::routing_response(&verdict, now_ms(started));
    express::json(ctx, status, &body, &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_the_retired_literal_route() {
        assert_eq!(
            claim(&Method::POST, "/api/auto-provider/routing/test"),
            Some(Route::TestPost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/Auto-Provider/Routing/Test/"),
            Some(Route::TestPost)
        );
        assert_eq!(
            claim(&Method::OPTIONS, "/api/auto-provider/routing/test"),
            Some(Route::TestOptions)
        );
        assert_eq!(claim(&Method::GET, "/api/auto-provider/routing/test"), None);
        assert_eq!(claim(&Method::POST, "/api/auto-provider/routing"), None);
        assert_eq!(
            claim(&Method::POST, "/api/auto-provider/routing/test/extra"),
            None
        );
    }
}
