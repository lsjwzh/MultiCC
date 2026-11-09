//! Native source workflows. Only host-context reads and the outer transport
//! are adapters; verification, budget consumption and projection exchange values.
use super::{access::Gate, get, put, text, Error, Result, Store};
use crate::auth_runtime::{AuthRuntime, Metadata, Response};

#[cfg(test)]
#[path = "source_ticket_tests.rs"]
mod ticket_tests;
use crate::{
    auth_control as wire,
    js::{self, JsValue as V},
};
use std::sync::{Arc, Mutex};

pub fn scope_forbidden() -> Error {
    Error::new("FLEET_SCOPE_FORBIDDEN", "工作区授权无效", 403)
        .meta(V::object(vec![("scope", "session".into())]))
}

/// Scope, live membership and single-use ticket insertion remain one native
/// workflow. Only the authoritative host membership read crosses the VM.
pub async fn issue_ticket<C, CFut>(
    store: &Store,
    auth: Option<&Mutex<AuthRuntime>>,
    revision: u64,
    mut input: V,
    context: &C,
) -> Result<V>
where
    C: Fn(String) -> CFut,
    CFut: std::future::Future<Output = Option<String>>,
{
    let auth = auth.ok_or_else(|| {
        Error::new("WS_TICKET_UNAVAILABLE", "WebSocket 凭证服务不可用", 501).meta(V::object(vec![
            ("category", "runtime".into()),
            ("action", "restart".into()),
            ("scope", "host".into()),
        ]))
    })?;
    put(&mut input, "webSocket", true.into());
    let plan = store.query("authorizePlan", &input, clock(None))?;
    if plan == V::Bool(false) {
        return Err(scope_forbidden());
    }
    if !matches!(plan, V::Bool(_)) {
        let request = js::json::json_encode_wire(&V::object(vec![
            ("id", get(&plan, "workspaceId").clone()),
            ("membersOnly", true.into()),
        ]))
        .ok_or_else(internal)?;
        let raw = tokio::time::timeout(wire::TIMEOUT, context(request))
            .await
            .ok()
            .flatten()
            .ok_or_else(internal)?;
        let snapshot = js::json_parse(&raw).map_err(|_| internal())?;
        // The host callback has already read the complete live member set.
        // Projection/authorization happen here, never in a cached grant table.
        put(&mut input, "members", get(&snapshot, "members").clone());
    }
    store.with_websocket_authority(&input, clock(None), || {
        let (key, value) = if super::truth(get(&input, "sessionId")) {
            ("fleetSessionId", get(&input, "sessionId"))
        } else {
            ("fleetDirectoryId", get(&input, "directoryId"))
        };
        let metadata = Metadata::Native(V::object(vec![(key, value.clone())]));
        let result = auth.lock().map_err(|_| internal())?.issue_ticket(
            revision,
            &text(get(&input, "pathname")),
            metadata,
        );
        match result {
            Response::Ticket {
                ticket,
                path,
                expires_at,
            } => Ok(V::object(vec![
                ("ticket", V::string(&ticket)),
                ("expiresAt", expires_at.into()),
                ("path", V::string(&path)),
            ])),
            Response::Stale => Err(Error::new(
                "WORKSPACE_AUTH_CHANGED",
                "authentication state changed or unavailable",
                503,
            )
            .meta(V::object(vec![
                ("category", "runtime".into()),
                ("action", "retry".into()),
                ("scope", "host".into()),
                ("retryable", true.into()),
            ]))),
            _ => Err(internal()),
        }
    })
}

pub fn clock(fixed: Option<f64>) -> f64 {
    fixed.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0)
    })
}
fn internal() -> Error {
    Error::new("WORKSPACE_SHARING_INTERNAL", "工作区分享操作失败", 500)
}

pub async fn read_state<C, CFut>(
    store: &Store,
    mut input: V,
    context: &C,
    fixed: Option<f64>,
) -> Result<V>
where
    C: Fn(String) -> CFut,
    CFut: std::future::Future<Output = Option<String>>,
{
    let id = store.query("payloadPlan", &input, clock(fixed))?;
    let request = js::json_stringify(&V::object(vec![("id", id)])).ok_or_else(internal)?;
    let raw = tokio::time::timeout(wire::TIMEOUT, context(request))
        .await
        .ok()
        .flatten()
        .ok_or_else(internal)?;
    let snapshot = js::json_parse(&raw).map_err(|_| internal())?;
    put(&mut input, "directory", get(&snapshot, "directory").clone());
    put(&mut input, "members", get(&snapshot, "members").clone());
    // Context awaits may race revoke/expiry. Read the current authority again.
    store.query("payload", &input, clock(fixed))
}

pub async fn import<C, CFut, D, DFut>(
    store: Arc<Store>,
    input: V,
    directory: &D,
    context: &C,
    fixed: Option<f64>,
) -> Result<V>
where
    C: Fn(String) -> CFut,
    CFut: std::future::Future<Output = Option<String>>,
    D: Fn(String) -> DFut,
    DFut: std::future::Future<Output = Option<bool>>,
{
    let owner = Arc::clone(&store);
    let proof = tokio::task::spawn_blocking(move || owner.verify_password(&input, clock(fixed)))
        .await
        .map_err(|_| internal())??;
    let exists = tokio::time::timeout(wire::TIMEOUT, directory(text(proof.workspace_id())))
        .await
        .ok()
        .flatten()
        .ok_or_else(internal)?;
    let owner = Arc::clone(&store);
    let authorized =
        tokio::task::spawn_blocking(move || owner.consume_access(proof, exists, clock(fixed)))
            .await
            .map_err(|_| internal())??;
    // Preserve the existing order: commit the access, then read fresh members.
    // A later context error does not roll back a successfully persisted access.
    read_state(&store, authorized, context, fixed).await
}

pub async fn admitted_import<C, CFut, D, DFut>(
    gate: &Arc<Gate>,
    store: Arc<Store>,
    input: V,
    directory: &D,
    context: &C,
) -> Result<V>
where
    C: Fn(String) -> CFut,
    CFut: std::future::Future<Output = Option<String>>,
    D: Fn(String) -> DFut,
    DFut: std::future::Future<Output = Option<bool>>,
{
    let reservation = gate.reserve()?;
    reservation.ready().await?;
    reservation.admit(&input, clock(None))?;
    let result = import(store, input, directory, context, None).await;
    reservation.finish(
        result.is_ok(),
        result.as_ref().err().map(|e| e.code.as_str()).unwrap_or(""),
        clock(None),
    )?;
    result
}
