use super::{
    express::{self, RequestCtx},
    App,
};
use axum::{body::Body, http::Response};
use base64::Engine;
use multicc_core::{
    air_routes::conditional_matches,
    http_gate::{query_value, QueryValue},
    message_page::{self, Query, Scope},
};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};

pub async fn serve(
    app: &App,
    ctx: &RequestCtx,
    detail: Value,
    scope: Scope,
    per_turn: bool,
) -> Response<Body> {
    let param = |key| match query_value(&ctx.original_url, key) {
        QueryValue::Text(s) if !s.is_empty() => Some(s),
        _ => None,
    };
    let air = detail["task"].is_object();
    let limit = param("limit")
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| *n != 0)
        .unwrap_or(if air { 50 } else { 5 })
        .clamp(1, 100) as usize;
    let q = Query {
        before: param("before"),
        around: param("around"),
        message_id: param("messageId"),
        archive: param("historyScope").as_deref() == Some("archive"),
        per_turn,
        limit,
    };
    let root = app.data_root.clone();
    let result =
        tokio::task::spawn_blocking(move || message_page::read(&root, scope, detail, q)).await;
    match result.map_err(|e| e.to_string()).and_then(|r| r) {
        Ok((_, message_page::Body::Record(record))) => stream_record(ctx, record, air),
        Ok((status, message_page::Body::Json(body))) if air && status == 200 => {
            let hash = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha1::digest(&body));
            let tag = format!("W/\"{hash}\"");
            let status = if conditional_matches(ctx.headers.get("if-none-match"), &tag) {
                304
            } else {
                200
            };
            express::send_with_etag(
                ctx,
                status,
                "application/json; charset=utf-8",
                body,
                &[],
                &tag,
            )
        }
        Ok((status, message_page::Body::Json(body))) => {
            express::send(ctx, status, "application/json; charset=utf-8", body, &[])
        }
        Err(error) => {
            eprintln!("[message-page] read failed: {error:?}");
            express::json(ctx, 500, &json!({"error":"chat history load failed"}), &[])
        }
    }
}

fn stream_record(ctx: &RequestCtx, record: message_page::FullRecord, air: bool) -> Response<Body> {
    use axum::body::Bytes;
    use futures_util::{stream, StreamExt};
    use tokio::io::AsyncReadExt;

    if express::fresh(&ctx.headers, &record.etag)
        || (air && conditional_matches(ctx.headers.get("if-none-match"), &record.etag))
    {
        return express::send_with_etag(ctx, 304, "application/json", vec![], &[], &record.etag);
    }
    let length = record.prefix.len() + record.length + 1;
    let response = express::with_base_headers(Response::builder().status(200), ctx)
        .header("content-type", "application/json; charset=utf-8")
        .header("content-length", length)
        .header("etag", record.etag);
    express::log_request(ctx, 200);
    if express::is_head(ctx) {
        return response.body(Body::empty()).unwrap();
    }
    let file = tokio::fs::File::from_std(record.file);
    let parts = stream::try_unfold(
        (file, record.digests.into_iter(), record.length),
        |(mut file, mut digests, remaining)| async move {
            let Some(hash) = digests.next() else {
                return Ok(None);
            };
            let mut buf = vec![0; remaining.min(message_page::CHUNK)];
            file.read_exact(&mut buf).await?;
            if !message_page::FullRecord::matches(&buf, &hash) {
                return Err(std::io::Error::other("transcript changed during expansion"));
            }
            let remaining = remaining - buf.len();
            Ok(Some((Bytes::from(buf), (file, digests, remaining))))
        },
    );
    let body = stream::once(async move { Ok(Bytes::from(record.prefix)) })
        .chain(parts)
        .chain(stream::once(async { Ok(Bytes::from_static(b"}")) }));
    response.body(Body::from_stream(body)).unwrap()
}
