//! `GET/HEAD /api/scan/history`, retired from `src/routes/scan.js`.
//!
//! The query rule — `parseInt(req.query.limit, 10) || 20` — is
//! `multicc_core::system_info::scan_history_limit`. The ring itself is Node's
//! in-memory classify state, so the host port applies the `maxPasses` cap and
//! the `slice(0, limit)` (whose negative-argument semantics stay in JS
//! verbatim) and answers `{ seq, kept, passes }`; this side reassembles and
//! validates that DTO. See `src/routes/scan-history-host.js`.

use axum::body::Body;
use axum::http::Response;
use multicc_core::http_gate::query_value;
use multicc_core::system_info;
use serde_json::{json, Value};

use crate::app::express::{self, RequestCtx};
use crate::host_port;

/// The host port the Node child serves (`src/routes/scan-history-host.js`).
const HOST_PATH: &str = "/api/__host/scan-history";

fn unavailable(ctx: &RequestCtx) -> Response<Body> {
    express::json(
        ctx,
        503,
        &json!({
            "error": "扫描历史接口尚未就绪，请更新原生模块",
            "code": "rust_backend_unavailable",
        }),
        &[],
    )
}

/// `GET /api/scan/history`.
pub async fn history(ctx: &RequestCtx, host: u16) -> Response<Body> {
    let limit = system_info::scan_history_limit(&query_value(&ctx.original_url, "limit"));
    let answer = host_port::call(
        host,
        HOST_PATH,
        &json!({ "op": "snapshot", "limit": limit }),
    )
    .await;
    match answer {
        // seq/kept are counts, passes the sliced ring; anything else is a
        // stale Node and gets the standard unavailable shape.
        Ok(value)
            if value.get("seq").is_some_and(Value::is_number)
                && value.get("kept").is_some_and(Value::is_number)
                && value.get("passes").is_some_and(Value::is_array) =>
        {
            express::json(
                ctx,
                200,
                &json!({
                    "seq": value["seq"],
                    "kept": value["kept"],
                    "passes": value["passes"],
                }),
                &[],
            )
        }
        Ok(_) => unavailable(ctx),
        Err(_) => unavailable(ctx),
    }
}
