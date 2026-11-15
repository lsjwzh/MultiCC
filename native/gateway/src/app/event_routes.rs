//! The events & triggers route cluster retired from `src/events/routes.js`,
//! the five trigger routes of `src/triggers/index.js` and the two
//! `/api/annotation-live` routes of `src/annotation-live.js`:
//!
//! * `GET|HEAD /api/events/catalog`
//! * `GET|HEAD /api/events/recent`
//! * `GET|HEAD /api/event-triggers`
//! * `GET|HEAD /api/event-rules`
//! * `POST     /api/event-rules`
//! * `PUT      /api/event-rules/:id`
//! * `DELETE   /api/event-rules/:id`
//! * `POST     /api/events/test`
//! * `GET|HEAD /api/sessions/:id/triggers`
//! * `POST     /api/sessions/:id/triggers`
//! * `PUT      /api/sessions/:id/triggers/:tid`
//! * `DELETE   /api/sessions/:id/triggers/:tid`
//! * `POST     /api/sessions/:id/triggers/:tid/test`
//! * `GET|HEAD /api/annotation-live`
//! * `POST     /api/annotation-live`
//!
//! Path matching, parameter decoding, query/body reads, the Express OPTIONS
//! answer, the `publicSessionAccessGuard` layer in front of every
//! `/api/sessions/:id/…` path, and the validation/DTO decision trees live here
//! and in `multicc_core::event_routes`. Node keeps the process-local facts
//! behind one host port, `POST /api/__host/events`
//! (`src/routes/events-host.js`): the event hub and rule engine, session
//! records and their persistence, `fireTrigger`, `reconcileSession`,
//! `appendEvent`, the cron parser, the plugin channel registry and the
//! annotation-live config file / regex matching / webhook relay.
//!
//! The trigger routes sat under the same `app.use('/api/sessions/:id', guard)`
//! mount session-admin migrated, so they must answer an internal execution slot
//! with the very same 404 (`{error:'session not found'}`) before any business
//! logic and before OPTIONS. The guard helpers are reused verbatim from
//! [`super::session_admin`].
//!
//! Every write handler awaits host round trips that mutate the rule store or a
//! session record; [`App::event_write`] serializes them the way the single Node
//! event-loop thread did.

#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Response};
use multicc_core::event_routes::{
    annotation_get_body, annotation_payload, annotation_relay_body, carry_stamps, catalog_body,
    error_body, event_emit_input, event_test_body, event_type, forced_trigger, has_channel_actions,
    identity_of, merge_rule, recent_body, recent_limit, single_key, too_many_global,
    validate_event_rule, validate_trigger, Identity, RuleError, TriggerPlan,
};
use multicc_core::http_gate::query_value;
use multicc_core::js::serde::truthy;
use serde_json::{json, Map, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::session_admin::{guard_facts, guarded_404, Guarded};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/events-host.js`).
const HOST_PATH: &str = "/api/__host/events";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    CatalogGet,
    RecentGet,
    TriggersListGet,
    RulesGet,
    RulesPost,
    RulePut,
    RuleDelete,
    EventsTestPost,
    SessionTriggersGet,
    SessionTriggersPost,
    SessionTriggerPut,
    SessionTriggerDelete,
    SessionTriggerTestPost,
    AnnotationLiveGet,
    AnnotationLivePost,
    /// Express's automatic OPTIONS: the union of the methods registered on the
    /// exact path, with `HEAD` after each `GET`, in registration order.
    Options {
        allow: &'static str,
        guard_segment: Option<usize>,
    },
}

#[derive(Clone, Copy)]
enum Seg {
    Lit(&'static str),
    Param,
}
use Seg::{Lit, Param};

struct Layer {
    segs: &'static [Seg],
    method: &'static str,
    kind: Route,
}

/// Registration order of the retired mounts. `triggerRuntime.mountRoutes(app)`
/// ran before `createEventsHost` and `annotationLive.mount(app)`; the paths do
/// not overlap, so only OPTIONS relies on it.
static LAYERS: &[Layer] = &[
    Layer {
        segs: &[Lit("sessions"), Param, Lit("triggers")],
        method: "GET",
        kind: Route::SessionTriggersGet,
    },
    Layer {
        segs: &[Lit("sessions"), Param, Lit("triggers")],
        method: "POST",
        kind: Route::SessionTriggersPost,
    },
    Layer {
        segs: &[Lit("sessions"), Param, Lit("triggers"), Param],
        method: "PUT",
        kind: Route::SessionTriggerPut,
    },
    Layer {
        segs: &[Lit("sessions"), Param, Lit("triggers"), Param],
        method: "DELETE",
        kind: Route::SessionTriggerDelete,
    },
    Layer {
        segs: &[Lit("sessions"), Param, Lit("triggers"), Param, Lit("test")],
        method: "POST",
        kind: Route::SessionTriggerTestPost,
    },
    Layer {
        segs: &[Lit("events"), Lit("catalog")],
        method: "GET",
        kind: Route::CatalogGet,
    },
    Layer {
        segs: &[Lit("events"), Lit("recent")],
        method: "GET",
        kind: Route::RecentGet,
    },
    Layer {
        segs: &[Lit("event-triggers")],
        method: "GET",
        kind: Route::TriggersListGet,
    },
    Layer {
        segs: &[Lit("event-rules")],
        method: "GET",
        kind: Route::RulesGet,
    },
    Layer {
        segs: &[Lit("event-rules")],
        method: "POST",
        kind: Route::RulesPost,
    },
    Layer {
        segs: &[Lit("event-rules"), Param],
        method: "PUT",
        kind: Route::RulePut,
    },
    Layer {
        segs: &[Lit("event-rules"), Param],
        method: "DELETE",
        kind: Route::RuleDelete,
    },
    Layer {
        segs: &[Lit("events"), Lit("test")],
        method: "POST",
        kind: Route::EventsTestPost,
    },
    Layer {
        segs: &[Lit("annotation-live")],
        method: "GET",
        kind: Route::AnnotationLiveGet,
    },
    Layer {
        segs: &[Lit("annotation-live")],
        method: "POST",
        kind: Route::AnnotationLivePost,
    },
];

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

fn layer_matches(segs: &[Seg], parts: &[&str]) -> bool {
    segs.len() == parts.len()
        && segs.iter().zip(parts).all(|(seg, part)| match seg {
            Seg::Lit(name) => part.eq_ignore_ascii_case(name),
            Seg::Param => !part.is_empty(),
        })
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let parts = segments(path)?;
    if method.as_str() == "OPTIONS" {
        let allow = allow_for(&parts)?;
        let guard_segment = if lit(&parts, 0, "sessions") && parts.len() >= 3 {
            Some(1)
        } else {
            None
        };
        return Some(Route::Options {
            allow,
            guard_segment,
        });
    }
    let wanted = if method.as_str() == "HEAD" {
        "GET"
    } else {
        method.as_str()
    };
    LAYERS
        .iter()
        .find(|layer| layer.method == wanted && layer_matches(layer.segs, &parts))
        .map(|layer| layer.kind)
}

/// Express's automatic OPTIONS body and `Allow` header for this path.
/// This cluster's own share of Express's automatic `OPTIONS` `Allow` for the
/// front-door union across clusters (`super::OPTIONS_SOURCES`).
pub fn options_share(path: &str) -> Option<String> {
    let parts = segments(path)?;
    allow_for(&parts).map(str::to_string)
}

fn allow_for(parts: &[&str]) -> Option<&'static str> {
    let mut methods: Vec<&'static str> = Vec::new();
    let mut matched = false;
    for layer in LAYERS {
        if !layer_matches(layer.segs, parts) {
            continue;
        }
        matched = true;
        if !methods.contains(&layer.method) {
            methods.push(layer.method);
        }
        if layer.method == "GET" && !methods.contains(&"HEAD") {
            methods.push("HEAD");
        }
    }
    if !matched {
        return None;
    }
    // The registered unions are static; spelling them out keeps the header a
    // plain &'static str for `super::options`.
    let methods = methods.join(",");
    Some(match methods.as_str() {
        "GET,HEAD" => "GET,HEAD",
        "GET,HEAD,POST" => "GET,HEAD,POST",
        "PUT,DELETE" => "PUT,DELETE",
        "POST" => "POST",
        _ => "GET,HEAD",
    })
}

fn lit(parts: &[&str], index: usize, name: &str) -> bool {
    parts
        .get(index)
        .is_some_and(|part| part.eq_ignore_ascii_case(name))
}

fn part<'a>(parts: &[&'a str], index: usize) -> &'a str {
    parts.get(index).copied().unwrap_or("")
}

fn decoded(ctx: &RequestCtx, raw: &str) -> Result<String, Response<Body>> {
    super::download::decode_uri_component(raw)
        .ok_or_else(|| express::error(ctx, 400, "Failed to decode param"))
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "事件与触发器接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

fn payload(op: &str, fields: Vec<(&str, Value)>) -> Value {
    let mut object = Map::new();
    object.insert("op".into(), Value::String(op.to_string()));
    for (key, value) in fields {
        object.insert(key.to_string(), value);
    }
    Value::Object(object)
}

/// One host round trip. The Node side answers `{ok:true,value}` for every op in
/// this cluster (refusals are values such as `{found:false}`); a transport or
/// non-200 failure is the documented 503, and an op that threw inside Node is
/// the same 500 `safeErrorHandler` used to build (Q: quota_routes::call_value).
async fn call(ctx: &RequestCtx, host: u16, payload: Value) -> Result<Value, Response<Body>> {
    let op = payload
        .get("op")
        .and_then(Value::as_str)
        .unwrap_or("host")
        .to_string();
    let answer = host_port::call(host, HOST_PATH, &payload)
        .await
        .map_err(|_| unavailable(ctx))?;
    if answer.get("ok") == Some(&Value::Bool(true)) {
        return Ok(answer.get("value").cloned().unwrap_or(Value::Null));
    }
    Err(express::error(
        ctx,
        500,
        &format!("events host operation failed: {op}"),
    ))
}

/// The `publicSessionAccessGuard` layer: an internal execution slot is answered
/// exactly like a missing session, before any business logic. `None` is a
/// missing session, `Some(record)` carries the persisted record the retired
/// handlers read from the same map.
async fn guarded(
    ctx: &RequestCtx,
    host: u16,
    parts: &[&str],
) -> Result<Option<Guarded>, Response<Body>> {
    let found = guard_facts(host, part(parts, 1), ctx.method.as_str())
        .await
        .map_err(|_| unavailable(ctx))?;
    if found.internal {
        // The claim regex only ever starts with `sessions`, so the v1 branch of
        // `guarded_404` is unreachable here; `/api/v1/…` stays on the Node
        // side, where the same `app.use` mount is still registered.
        return Err(guarded_404(ctx, false));
    }
    Ok(if found.record.is_null() {
        None
    } else {
        Some(found)
    })
}

/// `req.body || {}`: the parsed body is already an object/array, so only a
/// missing (or JSON null) body falls back.
fn request_value(body: &Value) -> Value {
    match body {
        Value::Object(_) | Value::Array(_) => body.clone(),
        _ => Value::Object(Map::new()),
    }
}

/// `req.query[name]` as the JSON value Express would expose.
fn q_json(ctx: &RequestCtx, name: &str) -> Option<Value> {
    multicc_core::quota_routes::query_json(&query_value(&ctx.original_url, name))
}

fn triggers_of(record: &Value) -> Option<&Vec<Value>> {
    record.get("triggers").and_then(Value::as_array)
}

fn find_trigger(record: &Value, tid: &str) -> Option<Value> {
    let needle = Value::String(tid.to_string());
    triggers_of(record)?
        .iter()
        .find(|trigger| trigger.get("id") == Some(&needle))
        .cloned()
}

fn ok(ctx: &RequestCtx, value: Value) -> Response<Body> {
    express::json(ctx, 200, &value, &[])
}

fn not_found(ctx: &RequestCtx, message: &str) -> Response<Body> {
    express::json(ctx, 404, &error_body(message), &[])
}

fn bad_request(ctx: &RequestCtx, message: &str) -> Response<Body> {
    express::json(ctx, 400, &error_body(message), &[])
}

fn threw(ctx: &RequestCtx, detail: &str) -> Response<Body> {
    express::error(ctx, 500, detail)
}

/// A validated trigger still owes the host-only `cron.validate` check.
async fn resolve_plan(
    ctx: &RequestCtx,
    host: u16,
    plan: TriggerPlan,
) -> Result<Value, Response<Body>> {
    match plan {
        TriggerPlan::Ready(trigger) => Ok(trigger),
        TriggerPlan::NeedsCron(trigger, expression) => {
            let answer = call(
                ctx,
                host,
                payload("cron-validate", vec![("expression", json!(expression))]),
            )
            .await?;
            if answer.get("valid") == Some(&Value::Bool(true)) {
                Ok(trigger)
            } else {
                Err(bad_request(ctx, "invalid cron expression"))
            }
        }
        TriggerPlan::Invalid(message) => Err(bad_request(ctx, &message)),
        TriggerPlan::Thrown(detail) => Err(threw(ctx, &detail)),
    }
}

/// `channelProblem(rule, check)` for the rules that carry a channel action.
async fn channel_refusal(
    ctx: &RequestCtx,
    host: u16,
    rule: &Value,
) -> Result<Option<Response<Body>>, Response<Body>> {
    if !has_channel_actions(rule) {
        return Ok(None);
    }
    let answer = call(
        ctx,
        host,
        payload("check-channels", vec![("rule", rule.clone())]),
    )
    .await?;
    match answer.get("problem") {
        Some(Value::String(problem)) if !problem.is_empty() => Ok(Some(bad_request(ctx, problem))),
        _ => Ok(None),
    }
}

/// The id/timestamp pair the retired handlers only pulled for a valid rule.
async fn identity(ctx: &RequestCtx, host: u16) -> Result<Identity, Response<Body>> {
    let answer = call(ctx, host, payload("identity", vec![])).await?;
    Ok(identity_of(&answer))
}

pub async fn handle(
    app: &Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    body: &Value,
    host: u16,
) -> Response<Body> {
    let write = matches!(
        route,
        Route::RulesPost
            | Route::RulePut
            | Route::RuleDelete
            | Route::EventsTestPost
            | Route::SessionTriggersPost
            | Route::SessionTriggerPut
            | Route::SessionTriggerDelete
            | Route::SessionTriggerTestPost
    );
    let _serialized = if write {
        Some(app.event_write.lock().await)
    } else {
        None
    };
    answer(ctx, route, body, host).await
}

async fn answer(ctx: &RequestCtx, route: Route, body: &Value, host: u16) -> Response<Body> {
    let parts = segments(&ctx.path).unwrap_or_default();
    match route {
        Route::Options {
            allow,
            guard_segment,
        } => match guard_segment {
            None => super::options(ctx, allow),
            Some(index) => {
                let found = match guard_facts(host, part(&parts, index), ctx.method.as_str()).await
                {
                    Ok(found) => found,
                    Err(_) => return unavailable(ctx),
                };
                if found.internal {
                    guarded_404(ctx, false)
                } else {
                    super::options(ctx, allow)
                }
            }
        },
        Route::CatalogGet => ok(ctx, catalog_body()),
        Route::RecentGet => {
            let limit = recent_limit(q_json(ctx, "limit").as_ref());
            match call(ctx, host, payload("recent", vec![("limit", json!(limit))])).await {
                Ok(value) => ok(ctx, recent_body(&value)),
                Err(response) => response,
            }
        }
        Route::TriggersListGet => match call(ctx, host, payload("list-all", vec![])).await {
            Ok(value) => ok(ctx, single_key("items", value)),
            Err(response) => response,
        },
        Route::RulesGet => match call(ctx, host, payload("rules-list", vec![])).await {
            Ok(value) => ok(ctx, single_key("rules", value)),
            Err(response) => response,
        },
        Route::RulesPost => rules_post(ctx, body, host).await,
        Route::RulePut => rule_put(ctx, body, host, part(&parts, 1)).await,
        Route::RuleDelete => rule_delete(ctx, host, part(&parts, 1)).await,
        Route::EventsTestPost => events_test(ctx, body, host).await,
        Route::SessionTriggersGet => session_triggers_get(ctx, host, &parts).await,
        Route::SessionTriggersPost => session_triggers_post(ctx, body, host, &parts).await,
        Route::SessionTriggerPut => session_trigger_put(ctx, body, host, &parts).await,
        Route::SessionTriggerDelete => session_trigger_delete(ctx, host, &parts).await,
        Route::SessionTriggerTestPost => session_trigger_test(ctx, host, &parts).await,
        Route::AnnotationLiveGet => {
            match call(ctx, host, payload("annotation-get", vec![])).await {
                Ok(value) => ok(ctx, annotation_get_body(&value)),
                Err(response) => response,
            }
        }
        Route::AnnotationLivePost => {
            let request = request_value(body);
            let normalized = annotation_payload(&request);
            match call(
                ctx,
                host,
                payload("annotation-relay", vec![("payload", normalized)]),
            )
            .await
            {
                Ok(value) => ok(ctx, annotation_relay_body(&value)),
                Err(response) => response,
            }
        }
    }
}

async fn rules_post(ctx: &RequestCtx, body: &Value, host: u16) -> Response<Body> {
    let state = match call(ctx, host, payload("rules-state", vec![])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let count = state.get("count").and_then(Value::as_i64).unwrap_or(0);
    if too_many_global(count) {
        return bad_request(ctx, "too many global rules");
    }
    // The host generates id/createdAt eagerly with the count; both are pure and
    // the retired handler only consumed them for a rule that passed.
    let identity = identity_of(&state);
    let request = request_value(body);
    let rule = match validate_event_rule(
        &request,
        "global",
        Some(&Value::String(identity.id)),
        Some(&Value::String(identity.created_at)),
    ) {
        Ok(rule) => rule,
        Err(RuleError::Invalid(message)) => return bad_request(ctx, &message),
        Err(RuleError::Thrown(detail)) => return threw(ctx, &detail),
    };
    if let Some(refusal) = match channel_refusal(ctx, host, &rule).await {
        Ok(refusal) => refusal,
        Err(response) => return response,
    } {
        return refusal;
    }
    if let Err(response) = call(
        ctx,
        host,
        payload("rules-add", vec![("rule", rule.clone())]),
    )
    .await
    {
        return response;
    }
    ok(ctx, rule)
}

async fn rule_put(ctx: &RequestCtx, body: &Value, host: u16, raw_id: &str) -> Response<Body> {
    let id = match decoded(ctx, raw_id) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let found = match call(ctx, host, payload("rules-get", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if found.get("found") != Some(&Value::Bool(true)) {
        return not_found(ctx, "not found");
    }
    let old = found.get("rule").cloned().unwrap_or(Value::Null);
    let request = request_value(body);
    let merged = merge_rule(&old, &request, &id);
    let rule = match validate_event_rule(
        &merged,
        "global",
        Some(&Value::String(id.clone())),
        old.get("createdAt"),
    ) {
        Ok(rule) => rule,
        Err(RuleError::Invalid(message)) => return bad_request(ctx, &message),
        Err(RuleError::Thrown(detail)) => return threw(ctx, &detail),
    };
    if let Some(refusal) = match channel_refusal(ctx, host, &rule).await {
        Ok(refusal) => refusal,
        Err(response) => return response,
    } {
        return refusal;
    }
    let rule = carry_stamps(rule, &old);
    let replaced = match call(
        ctx,
        host,
        payload(
            "rules-replace",
            vec![("id", json!(id)), ("rule", rule.clone())],
        ),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    if replaced.get("found") != Some(&Value::Bool(true)) {
        return not_found(ctx, "not found");
    }
    ok(ctx, rule)
}

async fn rule_delete(ctx: &RequestCtx, host: u16, raw_id: &str) -> Response<Body> {
    let id = match decoded(ctx, raw_id) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let removed = match call(ctx, host, payload("rules-remove", vec![("id", json!(id))])).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if removed.get("removed") != Some(&Value::Bool(true)) {
        return not_found(ctx, "not found");
    }
    ok(ctx, json!({ "ok": true }))
}

async fn events_test(ctx: &RequestCtx, body: &Value, host: u16) -> Response<Body> {
    let request = request_value(body);
    let Some(kind) = event_type(&request) else {
        return bad_request(ctx, "unknown event type");
    };
    let input = event_emit_input(&request);
    let answer = match call(
        ctx,
        host,
        payload("emit", vec![("event", input), ("type", json!(kind))]),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    ok(ctx, event_test_body(answer.get("eventId")))
}

async fn session_triggers_get(ctx: &RequestCtx, host: u16, parts: &[&str]) -> Response<Body> {
    let record = match guarded(ctx, host, parts).await {
        Ok(Some(record)) => record.record,
        Ok(None) => return not_found(ctx, "session not found"),
        Err(response) => return response,
    };
    let triggers = match record.get("triggers") {
        Some(value) if truthy(value) => value.clone(),
        _ => Value::Array(Vec::new()),
    };
    ok(ctx, single_key("triggers", triggers))
}

async fn session_triggers_post(
    ctx: &RequestCtx,
    body: &Value,
    host: u16,
    parts: &[&str],
) -> Response<Body> {
    let record = match guarded(ctx, host, parts).await {
        Ok(Some(record)) => record.record,
        Ok(None) => return not_found(ctx, "session not found"),
        Err(response) => return response,
    };
    let session_id = record.get("id").cloned().unwrap_or(Value::Null);
    let identity = match identity(ctx, host).await {
        Ok(identity) => identity,
        Err(response) => return response,
    };
    let request = request_value(body);
    let trigger = match resolve_plan(ctx, host, validate_trigger(&request, &identity)).await {
        Ok(trigger) => trigger,
        Err(response) => return response,
    };
    if value_or_empty(&trigger, "type") == "event" {
        if let Some(refusal) = match channel_refusal(ctx, host, &trigger).await {
            Ok(refusal) => refusal,
            Err(response) => return response,
        } {
            return refusal;
        }
    }
    let label = multicc_core::event_routes::trigger_label(&trigger);
    match call(
        ctx,
        host,
        payload(
            "trigger-add",
            vec![
                ("id", session_id),
                ("trigger", trigger.clone()),
                ("label", json!(label)),
            ],
        ),
    )
    .await
    {
        Ok(answer) => {
            if answer.get("missing") == Some(&Value::Bool(true)) {
                return not_found(ctx, "session not found");
            }
            ok(ctx, trigger)
        }
        Err(response) => response,
    }
}

async fn session_trigger_put(
    ctx: &RequestCtx,
    body: &Value,
    host: u16,
    parts: &[&str],
) -> Response<Body> {
    let record = match guarded(ctx, host, parts).await {
        Ok(Some(record)) => record.record,
        Ok(None) => return not_found(ctx, "not found"),
        Err(response) => return response,
    };
    if triggers_of(&record).is_none() {
        return not_found(ctx, "not found");
    }
    let tid = match decoded(ctx, part(parts, 3)) {
        Ok(tid) => tid,
        Err(response) => return response,
    };
    let Some(old) = find_trigger(&record, &tid) else {
        return not_found(ctx, "trigger not found");
    };
    let identity = match identity(ctx, host).await {
        Ok(identity) => identity,
        Err(response) => return response,
    };
    let request = request_value(body);
    let merged = merge_rule(&old, &request, &tid);
    let trigger = match resolve_plan(ctx, host, validate_trigger(&merged, &identity)).await {
        Ok(trigger) => trigger,
        Err(response) => return response,
    };
    if value_or_empty(&trigger, "type") == "event" {
        if let Some(refusal) = match channel_refusal(ctx, host, &trigger).await {
            Ok(refusal) => refusal,
            Err(response) => return response,
        } {
            return refusal;
        }
    }
    let trigger = carry_stamps(trigger, &old);
    let session_id = record.get("id").cloned().unwrap_or(Value::Null);
    let answer = match call(
        ctx,
        host,
        payload(
            "trigger-replace",
            vec![
                ("id", session_id),
                ("tid", json!(tid)),
                ("trigger", trigger.clone()),
            ],
        ),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(message) = answer.get("error").and_then(Value::as_str) {
        return not_found(ctx, message);
    }
    ok(ctx, trigger)
}

async fn session_trigger_delete(ctx: &RequestCtx, host: u16, parts: &[&str]) -> Response<Body> {
    let record = match guarded(ctx, host, parts).await {
        Ok(Some(record)) => record.record,
        Ok(None) => return not_found(ctx, "not found"),
        Err(response) => return response,
    };
    if triggers_of(&record).is_none() {
        return not_found(ctx, "not found");
    }
    let tid = match decoded(ctx, part(parts, 3)) {
        Ok(tid) => tid,
        Err(response) => return response,
    };
    let session_id = record.get("id").cloned().unwrap_or(Value::Null);
    let answer = match call(
        ctx,
        host,
        payload(
            "trigger-delete",
            vec![("id", session_id), ("tid", json!(tid))],
        ),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Some(message) = answer.get("error").and_then(Value::as_str) {
        return not_found(ctx, message);
    }
    ok(ctx, json!({ "ok": true }))
}

async fn session_trigger_test(ctx: &RequestCtx, host: u16, parts: &[&str]) -> Response<Body> {
    let record = match guarded(ctx, host, parts).await {
        Ok(Some(record)) => record.record,
        Ok(None) => return not_found(ctx, "not found"),
        Err(response) => return response,
    };
    if triggers_of(&record).is_none() {
        return not_found(ctx, "not found");
    }
    let tid = match decoded(ctx, part(parts, 3)) {
        Ok(tid) => tid,
        Err(response) => return response,
    };
    let Some(trigger) = find_trigger(&record, &tid) else {
        return not_found(ctx, "trigger not found");
    };
    if trigger.get("type") == Some(&json!("event")) {
        return bad_request(ctx, "use POST /api/events/test for event rules");
    }
    let session_id = record.get("id").cloned().unwrap_or(Value::Null);
    if let Err(response) = call(
        ctx,
        host,
        payload(
            "trigger-test",
            vec![("id", session_id), ("trigger", forced_trigger(&trigger))],
        ),
    )
    .await
    {
        return response;
    }
    ok(ctx, json!({ "ok": true }))
}

fn value_or_empty(source: &Value, key: &str) -> String {
    multicc_core::js::serde::value_or_empty(source.get(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPTIONS: Method = Method::OPTIONS;

    fn get() -> Method {
        Method::GET
    }

    fn post() -> Method {
        Method::POST
    }

    fn put() -> Method {
        Method::PUT
    }

    fn delete() -> Method {
        Method::DELETE
    }

    fn head() -> Method {
        Method::HEAD
    }

    #[test]
    fn claim_matches_every_retired_path_and_method() {
        assert_eq!(
            claim(&get(), "/api/events/catalog"),
            Some(Route::CatalogGet)
        );
        assert_eq!(
            claim(&head(), "/api/events/catalog"),
            Some(Route::CatalogGet)
        );
        assert_eq!(claim(&get(), "/api/events/recent"), Some(Route::RecentGet));
        assert_eq!(
            claim(&get(), "/api/event-triggers"),
            Some(Route::TriggersListGet)
        );
        assert_eq!(claim(&get(), "/api/event-rules"), Some(Route::RulesGet));
        assert_eq!(claim(&post(), "/api/event-rules"), Some(Route::RulesPost));
        assert_eq!(claim(&put(), "/api/event-rules/r1"), Some(Route::RulePut));
        assert_eq!(
            claim(&delete(), "/api/event-rules/r1"),
            Some(Route::RuleDelete)
        );
        assert_eq!(
            claim(&post(), "/api/events/test"),
            Some(Route::EventsTestPost)
        );
        assert_eq!(
            claim(&get(), "/api/sessions/s1/triggers"),
            Some(Route::SessionTriggersGet)
        );
        assert_eq!(
            claim(&post(), "/api/sessions/s1/triggers"),
            Some(Route::SessionTriggersPost)
        );
        assert_eq!(
            claim(&put(), "/api/sessions/s1/triggers/t1"),
            Some(Route::SessionTriggerPut)
        );
        assert_eq!(
            claim(&delete(), "/api/sessions/s1/triggers/t1"),
            Some(Route::SessionTriggerDelete)
        );
        assert_eq!(
            claim(&post(), "/api/sessions/s1/triggers/t1/test"),
            Some(Route::SessionTriggerTestPost)
        );
        assert_eq!(
            claim(&get(), "/api/annotation-live"),
            Some(Route::AnnotationLiveGet)
        );
        assert_eq!(
            claim(&post(), "/api/annotation-live"),
            Some(Route::AnnotationLivePost)
        );
        // The `/api/` prefix is case-sensitive (project-wide claim convention);
        // later literals are not, and one trailing slash is tolerated.
        assert_eq!(claim(&get(), "/API/Events/Catalog/"), None);
        assert_eq!(
            claim(&get(), "/api/Events/Catalog/"),
            Some(Route::CatalogGet)
        );
        assert_eq!(
            claim(&get(), "/api/sessions/s1/triggers/"),
            Some(Route::SessionTriggersGet)
        );
        // Nothing else is claimed.
        assert_eq!(claim(&get(), "/api/events"), None);
        assert_eq!(claim(&post(), "/api/event-rules/r1"), None);
        assert_eq!(claim(&get(), "/api/sessions/s1/triggers/t1"), None);
        assert_eq!(claim(&post(), "/api/v1/sessions/s1/triggers"), None);
    }

    #[test]
    fn options_allow_headers_match_express_registration_order() {
        let allow = |path: &str| match claim(&OPTIONS, path) {
            Some(Route::Options {
                allow,
                guard_segment,
            }) => (allow, guard_segment),
            other => panic!("unexpected {other:?} for {path}"),
        };
        assert_eq!(allow("/api/events/catalog"), ("GET,HEAD", None));
        assert_eq!(allow("/api/events/recent"), ("GET,HEAD", None));
        assert_eq!(allow("/api/event-triggers"), ("GET,HEAD", None));
        assert_eq!(allow("/api/event-rules"), ("GET,HEAD,POST", None));
        assert_eq!(allow("/api/event-rules/r1"), ("PUT,DELETE", None));
        assert_eq!(allow("/api/events/test"), ("POST", None));
        assert_eq!(allow("/api/annotation-live"), ("GET,HEAD,POST", None));
        assert_eq!(
            allow("/api/sessions/s1/triggers"),
            ("GET,HEAD,POST", Some(1))
        );
        assert_eq!(
            allow("/api/sessions/s1/triggers/t1"),
            ("PUT,DELETE", Some(1))
        );
        assert_eq!(
            allow("/api/sessions/s1/triggers/t1/test"),
            ("POST", Some(1))
        );
        assert_eq!(claim(&OPTIONS, "/api/events"), None);
    }
}
