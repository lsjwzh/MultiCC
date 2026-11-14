//! Voice REST routes retired from `src/routes/voice.js`:
//!
//! * `POST /api/voice/refine`
//! * `POST /api/voice/feedback`
//! * `POST /api/voice/confirm`
//! * `POST /api/voice/progress-summary`
//! * `GET|HEAD /api/voice/vocab`
//! * `GET|HEAD /api/voice/readiness`
//! * `GET|HEAD /api/voice/hotwords`
//! * `POST /api/voice/hotwords/reject`
//! * `DELETE /api/voice/vocab/:term`
//! * `GET|HEAD /api/settings/voice`
//! * `POST /api/settings/voice/asr-model`
//! * `POST /api/settings/voice`
//! * `GET|HEAD /api/voice/test-sse`
//!
//! `POST /api/voice/stt` stays in Node: it is a multer memory upload feeding the
//! in-process sherpa-onnx ASR and sits behind the upload admission gate.
//!
//! Path matching, methods, prompts, status codes, error rendering and the SSE
//! frame schedule live in [`multicc_core::voice_routes`]. Node keeps the
//! in-process voice service, the AuxQueue, the env file and the ASR model
//! installer behind one host port, `POST /api/__host/voice`
//! (`src/routes/voice-host.js`).
//!
//! The retired handlers that wrote state ran to completion on the event loop;
//! the write routes here await one host round trip, so
//! [`App::voice_routes`] serializes them. refine / confirm / progress-summary
//! only enqueue work and are not serialized.

use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{Method, Response};
use multicc_core::js::serde::truthy_opt;
use multicc_core::voice_routes as rules;
use serde_json::{json, Value};

use crate::app::express::{self, RequestCtx};
use crate::app::App;
use crate::host_port;

/// The host port the Node child serves (`src/routes/voice-host.js`).
const HOST_PATH: &str = "/api/__host/voice";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Refine,
    Feedback,
    Confirm,
    ProgressSummary,
    Vocab,
    Readiness,
    Hotwords,
    HotwordsReject,
    VocabDelete,
    SettingsGet,
    AsrModel,
    SettingsPost,
    TestSse,
    Options(&'static str),
}

/// Segment view of `/api/<rest>`, one optional trailing slash removed. Express
/// matches literal segments case-insensitively and a parameter as `[^/]+?`, so
/// an empty segment never matches.
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

fn is(segment: &str, literal: &str) -> bool {
    segment.eq_ignore_ascii_case(literal)
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let parts = segments(path)?;
    match parts.as_slice() {
        [settings, voice] if is(settings, "settings") && is(voice, "voice") => {
            match method.as_str() {
                "GET" | "HEAD" => Some(Route::SettingsGet),
                "POST" => Some(Route::SettingsPost),
                "OPTIONS" => Some(Route::Options(rules::SETTINGS_VOICE_ALLOW)),
                _ => None,
            }
        }
        [settings, voice, asr_model]
            if is(settings, "settings") && is(voice, "voice") && is(asr_model, "asr-model") =>
        {
            match method.as_str() {
                "POST" => Some(Route::AsrModel),
                "OPTIONS" => Some(Route::Options(rules::ASR_MODEL_ALLOW)),
                _ => None,
            }
        }
        [voice, name] if is(voice, "voice") => match name.to_ascii_lowercase().as_str() {
            "refine" => match method.as_str() {
                "POST" => Some(Route::Refine),
                "OPTIONS" => Some(Route::Options(rules::REFINE_ALLOW)),
                _ => None,
            },
            "feedback" => match method.as_str() {
                "POST" => Some(Route::Feedback),
                "OPTIONS" => Some(Route::Options(rules::FEEDBACK_ALLOW)),
                _ => None,
            },
            "confirm" => match method.as_str() {
                "POST" => Some(Route::Confirm),
                "OPTIONS" => Some(Route::Options(rules::CONFIRM_ALLOW)),
                _ => None,
            },
            "progress-summary" => match method.as_str() {
                "POST" => Some(Route::ProgressSummary),
                "OPTIONS" => Some(Route::Options(rules::PROGRESS_ALLOW)),
                _ => None,
            },
            "vocab" => match method.as_str() {
                "GET" | "HEAD" => Some(Route::Vocab),
                "OPTIONS" => Some(Route::Options(rules::VOCAB_ALLOW)),
                _ => None,
            },
            "readiness" => match method.as_str() {
                "GET" | "HEAD" => Some(Route::Readiness),
                "OPTIONS" => Some(Route::Options(rules::READINESS_ALLOW)),
                _ => None,
            },
            "hotwords" => match method.as_str() {
                "GET" | "HEAD" => Some(Route::Hotwords),
                "OPTIONS" => Some(Route::Options(rules::HOTWORDS_ALLOW)),
                _ => None,
            },
            "test-sse" => match method.as_str() {
                "GET" | "HEAD" => Some(Route::TestSse),
                "OPTIONS" => Some(Route::Options(rules::TEST_SSE_ALLOW)),
                _ => None,
            },
            // `/api/voice/stt` and anything else on this path stays in Node.
            _ => None,
        },
        [voice, hotwords, reject]
            if is(voice, "voice") && is(hotwords, "hotwords") && is(reject, "reject") =>
        {
            match method.as_str() {
                "POST" => Some(Route::HotwordsReject),
                "OPTIONS" => Some(Route::Options(rules::HOTWORDS_REJECT_ALLOW)),
                _ => None,
            }
        }
        [voice, vocab, _term] if is(voice, "voice") && is(vocab, "vocab") => {
            match method.as_str() {
                "DELETE" => Some(Route::VocabDelete),
                "OPTIONS" => Some(Route::Options(rules::VOCAB_DELETE_ALLOW)),
                _ => None,
            }
        }
        _ => None,
    }
}

/// The raw (still percent-encoded) `:term` of a claimed delete path.
fn raw_term(path: &str) -> Option<&str> {
    let parts = segments(path)?;
    match parts.as_slice() {
        [voice, vocab, term] if is(voice, "voice") && is(vocab, "vocab") => Some(term),
        _ => None,
    }
}

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(ctx, 503, &rules::unavailable_body(), &[])
}

/// `next(error)`: `safeErrorHandler`'s opaque body at the thrown status.
fn send_thrown(ctx: &RequestCtx, error: &rules::JsError) -> Response<Body> {
    express::error(ctx, error.status_code(), error.message())
}

/// A host answer that is either `{ok:true,...}` or a Node throw.
enum Answer {
    Value(Value),
    Thrown(rules::JsError),
    Unavailable,
}

fn classify(answer: Value) -> Answer {
    match answer.get("ok") {
        Some(Value::Bool(true)) => Answer::Value(answer),
        Some(Value::Bool(false)) => match answer.get("error").and_then(rules::host_error) {
            Some(error) => Answer::Thrown(error),
            None => Answer::Unavailable,
        },
        _ => Answer::Unavailable,
    }
}

async fn call(host: u16, payload: &Value) -> Answer {
    match host_port::call(host, HOST_PATH, payload).await {
        Ok(answer) => classify(answer),
        Err(_) => Answer::Unavailable,
    }
}

/// `auxEnqueue` keeps the retired `{ ok:false, cancelled, message }` failure
/// shape, so its answer must not go through the throw classification.
async fn aux_call(host: u16, payload: &Value) -> Option<Value> {
    host_port::call(host, HOST_PATH, payload).await.ok()
}

/// A field of a parsed JSON body (`req.body.x`).
fn field<'a>(body: &'a Value, name: &str) -> Option<&'a Value> {
    body.as_object().and_then(|object| object.get(name))
}

/// `Math.random()` from the OS CSPRNG, [0, 1).
fn random_unit() -> f64 {
    let mut bytes = [0u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return 0.0;
    }
    ((u64::from_le_bytes(bytes) >> 11) as f64) / ((1u64 << 53) as f64)
}

/// The caught-error body these handlers wrote by hand:
/// `res.status(500).json({ error: errMsg })`.
fn caught_error(ctx: &RequestCtx, message: &str) -> Response<Body> {
    express::json(ctx, 500, &json!({ "error": message }), &[])
}

// ── refine ─────────────────────────────────────────────────────────────────

async fn refine(ctx: &RequestCtx, body: &Value, host: u16) -> Response<Body> {
    let started = super::now_ms();
    let req_id = rules::req_id("vr_", started, random_unit());
    let raw = match rules::trim_body_field(body, "raw") {
        Ok(raw) => raw,
        Err(error) => return send_thrown(ctx, &error),
    };
    // `if (!raw) return res.json({ ok:true, text:'', ms:0 })` — no host call.
    if raw.is_empty() {
        return express::json(ctx, 200, &json!({ "ok": true, "text": "", "ms": 0 }), &[]);
    }

    let examples = match call(host, &json!({ "op": "examples" })).await {
        Answer::Value(answer) => match answer.get("examples").and_then(Value::as_array) {
            Some(examples) => examples.clone(),
            None => return unavailable(ctx),
        },
        Answer::Thrown(error) => return send_thrown(ctx, &error),
        Answer::Unavailable => return unavailable(ctx),
    };
    let prompt = match rules::refine_prompt(&raw, &examples) {
        Ok(prompt) => prompt,
        Err(error) => return send_thrown(ctx, &error),
    };

    let t0 = super::now_ms();
    let payload = rules::aux_enqueue_payload("voice_refine", &prompt, &req_id);
    let answer = match aux_call(host, &payload).await {
        Some(answer) => answer,
        None => return unavailable(ctx),
    };
    let ms = super::now_ms() - t0;
    match rules::aux_outcome(&answer) {
        rules::AuxOutcome::Success(text) => {
            express::json(ctx, 200, &rules::refine_success(text.as_ref(), ms), &[])
        }
        rules::AuxOutcome::Failure(message) => {
            express::json(ctx, 200, &rules::refine_failure(&message, ms), &[])
        }
        rules::AuxOutcome::Invalid => unavailable(ctx),
    }
}

// ── feedback ───────────────────────────────────────────────────────────────

async fn feedback(app: &Arc<App>, ctx: &RequestCtx, body: &Value, host: u16) -> Response<Body> {
    let _serialized = app.voice_routes.lock().await;
    if rules::feedback_applies(body) {
        match call(host, &rules::feedback_payload(body)).await {
            Answer::Value(_) => {}
            Answer::Thrown(error) => return send_thrown(ctx, &error),
            Answer::Unavailable => return unavailable(ctx),
        }
    }
    express::json(ctx, 200, &json!({ "ok": true }), &[])
}

// ── confirm ────────────────────────────────────────────────────────────────

async fn confirm(ctx: &RequestCtx, body: &Value, host: u16) -> Response<Body> {
    let started = super::now_ms();
    let req_id = rules::req_id("s2s_c_", started, random_unit());
    let raw = match rules::trim_body_field(body, "text") {
        Ok(raw) => raw,
        Err(error) => return send_thrown(ctx, &error),
    };
    let previous = field(body, "previousBreakdown");
    let user_feedback = field(body, "userFeedback");
    if raw.is_empty() && !truthy_opt(user_feedback) {
        return express::json(
            ctx,
            400,
            &json!({ "error": "缺少 text 或 userFeedback" }),
            &[],
        );
    }

    let prompt = rules::confirm_prompt(&raw, previous, user_feedback);
    let t0 = super::now_ms();
    let payload = rules::aux_enqueue_payload("voice_confirm", &prompt, &req_id);
    let answer = match aux_call(host, &payload).await {
        Some(answer) => answer,
        None => return unavailable(ctx),
    };
    let ms = super::now_ms() - t0;
    match rules::aux_outcome(&answer) {
        rules::AuxOutcome::Success(text) => {
            // The greedy parse ran inside the retired try, so its TypeError
            // came out as the caught `{ error }` body.
            let parsed = match rules::confirm_result(text.as_ref()) {
                Ok(parsed) => parsed,
                Err(error) => return caught_error(ctx, error.message()),
            };
            express::json(ctx, 200, &rules::confirm_response(parsed, ms), &[])
        }
        rules::AuxOutcome::Failure(message) => caught_error(ctx, &message),
        rules::AuxOutcome::Invalid => unavailable(ctx),
    }
}

// ── progress-summary ───────────────────────────────────────────────────────

async fn progress_summary(ctx: &RequestCtx, body: &Value, host: u16) -> Response<Body> {
    let started = super::now_ms();
    let req_id = rules::req_id("s2s_p_", started, random_unit());
    let Some(events) = field(body, "events").and_then(Value::as_array) else {
        return express::json(ctx, 200, &rules::progress_empty(), &[]);
    };
    if events.is_empty() {
        return express::json(ctx, 200, &rules::progress_empty(), &[]);
    }
    // Built before the retired try: a non-sliceable field was a `next(error)`.
    let events_str = match rules::progress_events_str(events) {
        Ok(rendered) => rendered,
        Err(error) => return send_thrown(ctx, &error),
    };
    let prompt = rules::progress_prompt(&events_str, field(body, "taskDescription"));

    let t0 = super::now_ms();
    let payload = rules::aux_enqueue_payload("progress_summary", &prompt, &req_id);
    let answer = match aux_call(host, &payload).await {
        Some(answer) => answer,
        None => return unavailable(ctx),
    };
    let ms = super::now_ms() - t0;
    match rules::aux_outcome(&answer) {
        rules::AuxOutcome::Success(text) => match rules::progress_success(text.as_ref(), ms) {
            Ok(value) => express::json(ctx, 200, &value, &[]),
            Err(error) => caught_error(ctx, error.message()),
        },
        rules::AuxOutcome::Failure(message) => caught_error(ctx, &message),
        rules::AuxOutcome::Invalid => unavailable(ctx),
    }
}

// ── vocab ──────────────────────────────────────────────────────────────────

async fn vocab(ctx: &RequestCtx, host: u16) -> Response<Body> {
    match call(host, &json!({ "op": "vocabGet" })).await {
        Answer::Value(answer) => match rules::vocab_body(&answer) {
            Some(value) => express::json(ctx, 200, &value, &[]),
            None => unavailable(ctx),
        },
        Answer::Thrown(error) => send_thrown(ctx, &error),
        Answer::Unavailable => unavailable(ctx),
    }
}

async fn vocab_delete(app: &Arc<App>, ctx: &RequestCtx, host: u16) -> Response<Body> {
    let _serialized = app.voice_routes.lock().await;
    // `:term` went through decodeURIComponent; a malformed escape made Express
    // answer 400 before the handler ran.
    let Some(raw) = raw_term(&ctx.path) else {
        return express::error(ctx, 400, "Failed to decode param");
    };
    let decoded = match super::download::decode_uri_component(raw) {
        Some(decoded) => decoded,
        None => return express::error(ctx, 400, "Failed to decode param"),
    };
    let target = rules::vocab_delete_target(&decoded);
    let payload = json!({ "op": "vocabDelete", "target": target });
    match call(host, &payload).await {
        Answer::Value(answer) => match rules::vocab_delete_body(&answer) {
            Some(value) => express::json(ctx, 200, &value, &[]),
            None => unavailable(ctx),
        },
        Answer::Thrown(error) => send_thrown(ctx, &error),
        Answer::Unavailable => unavailable(ctx),
    }
}

// ── readiness ──────────────────────────────────────────────────────────────

async fn readiness(ctx: &RequestCtx, host: u16) -> Response<Body> {
    match call(host, &json!({ "op": "readinessFacts" })).await {
        Answer::Value(answer) => match rules::readiness_body(&answer) {
            Some(value) => express::json(ctx, 200, &value, &[]),
            None => unavailable(ctx),
        },
        Answer::Thrown(error) => send_thrown(ctx, &error),
        Answer::Unavailable => unavailable(ctx),
    }
}

// ── hotwords ───────────────────────────────────────────────────────────────

async fn hotwords(ctx: &RequestCtx, host: u16) -> Response<Body> {
    match call(host, &json!({ "op": "hotwords" })).await {
        Answer::Value(answer) => match rules::hotwords_body(&answer) {
            Some(value) => express::json(ctx, 200, &value, &[]),
            None => unavailable(ctx),
        },
        Answer::Thrown(error) => send_thrown(ctx, &error),
        Answer::Unavailable => unavailable(ctx),
    }
}

async fn hotwords_reject(
    app: &Arc<App>,
    ctx: &RequestCtx,
    body: &Value,
    host: u16,
) -> Response<Body> {
    let _serialized = app.voice_routes.lock().await;
    let answer = match call(host, &rules::hotwords_reject_payload(body)).await {
        Answer::Value(answer) => answer,
        Answer::Thrown(error) => return send_thrown(ctx, &error),
        Answer::Unavailable => return unavailable(ctx),
    };
    match rules::hotwords_reject_result(&answer) {
        Some((present, accepted)) if present && accepted => {
            express::json(ctx, 200, &json!({ "ok": true }), &[])
        }
        Some(_) => express::json(ctx, 400, &rules::hotwords_reject_denied(), &[]),
        None => unavailable(ctx),
    }
}

// ── settings ───────────────────────────────────────────────────────────────

async fn settings_get(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let payload = rules::settings_facts_payload();
    match call(host, &payload).await {
        Answer::Value(answer) => match rules::settings_dto(&answer) {
            Some(value) => express::json(ctx, 200, &value, &[]),
            None => unavailable(ctx),
        },
        Answer::Thrown(error) => send_thrown(ctx, &error),
        Answer::Unavailable => unavailable(ctx),
    }
}

async fn asr_model(app: &Arc<App>, ctx: &RequestCtx, body: &Value, host: u16) -> Response<Body> {
    let _serialized = app.voice_routes.lock().await;
    let action = rules::asr_action(body);
    if action == "cancel" {
        return match call(host, &json!({ "op": "asrModelCancel" })).await {
            Answer::Value(answer) => match rules::asr_cancel_body(&answer) {
                Some(value) => express::json(ctx, 200, &value, &[]),
                None => unavailable(ctx),
            },
            Answer::Thrown(error) => send_thrown(ctx, &error),
            Answer::Unavailable => unavailable(ctx),
        };
    }
    if action != "download" {
        return express::json(
            ctx,
            400,
            &json!({ "error": format!("未知操作: {action}") }),
            &[],
        );
    }
    match call(host, &json!({ "op": "asrModelStart" })).await {
        Answer::Value(answer) => match rules::asr_status_body(&answer) {
            Some(value) => express::json(ctx, 200, &value, &[]),
            None => unavailable(ctx),
        },
        Answer::Thrown(error) => send_thrown(ctx, &error),
        Answer::Unavailable => unavailable(ctx),
    }
}

async fn settings_post(
    app: &Arc<App>,
    ctx: &RequestCtx,
    body: &Value,
    host: u16,
) -> Response<Body> {
    let _serialized = app.voice_routes.lock().await;
    // Every validation error aborted before the host transaction began.
    let updates = match rules::settings_updates(body) {
        Ok(updates) => updates,
        Err(error) => return send_thrown(ctx, &error),
    };
    match call(host, &rules::settings_apply_payload(updates)).await {
        Answer::Value(_) => express::json(ctx, 200, &json!({ "ok": true }), &[]),
        Answer::Thrown(error) => send_thrown(ctx, &error),
        Answer::Unavailable => unavailable(ctx),
    }
}

// ── test-sse ───────────────────────────────────────────────────────────────

/// One chunk of the fixed SSE test stream; the state is the frame index.
fn sse_stream() -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> {
    futures_util::stream::unfold(0usize, |index| async move {
        if index > rules::SSE_CHUNK_COUNT {
            return None;
        }
        // The retired `setInterval(..., 500)` wrote the first chunk after one
        // tick, and `[DONE]` + `end()` in the same tick as the third chunk.
        if index < rules::SSE_CHUNK_COUNT {
            tokio::time::sleep(Duration::from_millis(rules::SSE_INTERVAL_MS)).await;
        }
        let frame = rules::sse_frame(index);
        Some((Ok(Bytes::from(frame)), index + 1))
    })
}

/// `GET|HEAD /api/voice/test-sse`: four headers, then three timed chunks and
/// `[DONE]`. The retired handler wrote with `res.write`, so no ETag, no
/// freshness check and no `Content-Length`.
fn test_sse(ctx: &RequestCtx) -> Response<Body> {
    let mut builder = express::with_base_headers(Response::builder().status(200), ctx);
    builder = express::header(builder, "Content-Type", rules::TEST_SSE_CONTENT_TYPE);
    builder = express::header(builder, "Cache-Control", "no-cache");
    builder = express::header(builder, "Connection", "keep-alive");
    builder = express::header(builder, "X-Accel-Buffering", "no");
    express::log_request(ctx, 200);
    // HEAD runs the same handler in Express, but Node suppresses the body; the
    // response headers are identical and no timer needs to run here.
    let body = if express::is_head(ctx) {
        Body::from_stream(futures_util::stream::empty::<Result<Bytes, std::io::Error>>())
    } else {
        Body::from_stream(sse_stream())
    };
    builder.body(body).expect("static response parts")
}

pub async fn handle(
    app: &Arc<App>,
    route: Route,
    ctx: &RequestCtx,
    body: &Value,
    host: u16,
) -> Response<Body> {
    if let Route::Options(allow) = route {
        return super::options(ctx, allow);
    }
    match route {
        Route::Refine => refine(ctx, body, host).await,
        Route::Feedback => feedback(app, ctx, body, host).await,
        Route::Confirm => confirm(ctx, body, host).await,
        Route::ProgressSummary => progress_summary(ctx, body, host).await,
        Route::Vocab => vocab(ctx, host).await,
        Route::Readiness => readiness(ctx, host).await,
        Route::Hotwords => hotwords(ctx, host).await,
        Route::HotwordsReject => hotwords_reject(app, ctx, body, host).await,
        Route::VocabDelete => vocab_delete(app, ctx, host).await,
        Route::SettingsGet => settings_get(ctx, host).await,
        Route::AsrModel => asr_model(app, ctx, body, host).await,
        Route::SettingsPost => settings_post(app, ctx, body, host).await,
        Route::TestSse => test_sse(ctx),
        Route::Options(_) => unreachable!("answered above"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_follow_express_matching() {
        for (method, path, route) in [
            (&Method::POST, "/api/voice/refine", Route::Refine),
            (&Method::POST, "/api/voice/feedback", Route::Feedback),
            (&Method::POST, "/api/voice/confirm", Route::Confirm),
            (
                &Method::POST,
                "/api/voice/progress-summary",
                Route::ProgressSummary,
            ),
            (&Method::GET, "/api/voice/vocab", Route::Vocab),
            (&Method::HEAD, "/api/Voice/Vocab/", Route::Vocab),
            (&Method::GET, "/api/voice/readiness", Route::Readiness),
            (&Method::GET, "/api/voice/hotwords", Route::Hotwords),
            (
                &Method::POST,
                "/api/voice/hotwords/reject",
                Route::HotwordsReject,
            ),
            (
                &Method::DELETE,
                "/api/voice/vocab/A%20B",
                Route::VocabDelete,
            ),
            (&Method::GET, "/api/settings/voice", Route::SettingsGet),
            (&Method::HEAD, "/api/Settings/Voice/", Route::SettingsGet),
            (&Method::POST, "/api/settings/voice", Route::SettingsPost),
            (
                &Method::POST,
                "/api/settings/voice/asr-model",
                Route::AsrModel,
            ),
            (&Method::GET, "/api/voice/test-sse", Route::TestSse),
            (
                &Method::OPTIONS,
                "/api/voice/refine",
                Route::Options(rules::REFINE_ALLOW),
            ),
            (
                &Method::OPTIONS,
                "/api/voice/feedback",
                Route::Options(rules::FEEDBACK_ALLOW),
            ),
            (
                &Method::OPTIONS,
                "/api/voice/confirm",
                Route::Options(rules::CONFIRM_ALLOW),
            ),
            (
                &Method::OPTIONS,
                "/api/voice/progress-summary",
                Route::Options(rules::PROGRESS_ALLOW),
            ),
            (
                &Method::OPTIONS,
                "/api/voice/vocab",
                Route::Options(rules::VOCAB_ALLOW),
            ),
            (
                &Method::OPTIONS,
                "/api/voice/readiness",
                Route::Options(rules::READINESS_ALLOW),
            ),
            (
                &Method::OPTIONS,
                "/api/voice/hotwords",
                Route::Options(rules::HOTWORDS_ALLOW),
            ),
            (
                &Method::OPTIONS,
                "/api/voice/hotwords/reject",
                Route::Options(rules::HOTWORDS_REJECT_ALLOW),
            ),
            (
                &Method::OPTIONS,
                "/api/voice/vocab/x",
                Route::Options(rules::VOCAB_DELETE_ALLOW),
            ),
            (
                &Method::OPTIONS,
                "/api/settings/voice",
                Route::Options(rules::SETTINGS_VOICE_ALLOW),
            ),
            (
                &Method::OPTIONS,
                "/api/settings/voice/asr-model",
                Route::Options(rules::ASR_MODEL_ALLOW),
            ),
            (
                &Method::OPTIONS,
                "/api/voice/test-sse",
                Route::Options(rules::TEST_SSE_ALLOW),
            ),
        ] {
            assert_eq!(claim(method, path), Some(route), "{method} {path}");
        }

        // `/api/voice/stt` stays in Node, as do other methods, other paths,
        // empty segments and a differently-cased prefix.
        for (method, path) in [
            (&Method::POST, "/api/voice/stt"),
            (&Method::GET, "/api/voice/refine"),
            (&Method::PUT, "/api/voice/confirm"),
            (&Method::GET, "/api/voice/progress-summary"),
            (&Method::POST, "/api/voice/vocab"),
            (&Method::DELETE, "/api/voice/vocab"),
            (&Method::POST, "/api/voice/readiness"),
            (&Method::DELETE, "/api/voice/hotwords"),
            (&Method::GET, "/api/voice/hotwords/reject"),
            (&Method::POST, "/api/voice/vocab/x"),
            (&Method::GET, "/api/voice/vocab/x"),
            (&Method::DELETE, "/api/settings/voice"),
            (&Method::GET, "/api/settings/voice/asr-model"),
            (&Method::POST, "/api/voice/test-sse"),
            (&Method::GET, "/api/voice"),
            (&Method::GET, "/api/voice/"),
            (&Method::GET, "/api/voice//"),
            (&Method::GET, "/api/voice/refine/x"),
            (&Method::POST, "/api/voice/stt/x"),
            (&Method::GET, "/API/voice/vocab"),
            (&Method::GET, "/api/voices/vocab"),
        ] {
            assert_eq!(claim(method, path), None, "{method} {path}");
        }

        assert_eq!(raw_term("/api/voice/vocab/My%20Term"), Some("My%20Term"));
        assert_eq!(raw_term("/api/voice/vocab"), None);
        assert_eq!(raw_term("/api/settings/voice/x"), None);
    }

    #[test]
    fn frame_schedule_is_three_ticks_then_done() {
        assert_eq!(rules::SSE_CHUNK_COUNT, 3);
        assert_eq!(
            rules::sse_frame(0),
            "data: {\"text\":\"SSE test chunk 1\"}\n\n"
        );
        assert_eq!(rules::sse_frame(3), "data: [DONE]\n\n");
    }
}
