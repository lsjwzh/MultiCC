//! N-API bindings for cross-machine dispatch RPCs, persistent SSE receipt
//! streaming, and slave-to-gateway live event notifications.
//! Peer `mcg_...` credentials never leave Rust.

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};

use napi::threadsafe_function::ThreadsafeFunction;
use napi::Result;
use napi_derive::napi;
use serde_json::Value;
use tokio::sync::watch;

static NEXT_WATCH_ID: AtomicU64 = AtomicU64::new(1);

fn watches() -> &'static Mutex<HashMap<u64, watch::Sender<bool>>> {
    static MAP: OnceLock<Mutex<HashMap<u64, watch::Sender<bool>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

#[napi]
pub fn authorize_machine_grant(
    root: String,
    credential: String,
    method: String,
    path: String,
) -> Option<String> {
    multicc_core::machines::authorize_grant(&root, &credential, &method, &path)
        .and_then(|g| serde_json::to_string(&g).ok())
}

#[napi]
pub async fn cross_machine_request_json(
    root: String,
    machine_id: String,
    method: String,
    path: String,
    body_json: Option<String>,
) -> Result<String> {
    let parsed_body: Option<Value> = body_json
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(multicc_core::json_lenient::from_str)
        .transpose()
        .unwrap_or(None);
    let value = multicc_core::cross_machine_dispatch::request_peer_json(
        &root,
        &machine_id,
        &method,
        &path,
        parsed_body.as_ref(),
    )
    .await;
    Ok(value.to_string())
}

#[napi]
pub fn cross_machine_watch_start(
    root: String,
    machine_id: String,
    callback: ThreadsafeFunction<String, bool>,
) -> Result<u32> {
    let id = NEXT_WATCH_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = watch::channel(false);
    if let Ok(mut guard) = watches().lock() {
        guard.insert(id, tx);
    }
    let callback = Arc::new(callback);
    napi::bindgen_prelude::spawn(async move {
        multicc_core::cross_machine_dispatch::stream_peer_receipts(
            root,
            machine_id,
            rx,
            move |event_json| {
                let cb = Arc::clone(&callback);
                async move { cb.call_async(Ok(event_json)).await.unwrap_or(false) }
            },
        )
        .await;
        if let Ok(mut guard) = watches().lock() {
            guard.remove(&id);
        }
    });
    Ok(id as u32)
}

#[napi]
pub fn cross_machine_watch_stop(watch_id: u32) -> bool {
    let key = u64::from(watch_id);
    if let Ok(mut guard) = watches().lock() {
        if let Some(tx) = guard.remove(&key) {
            let _ = tx.send(true);
            return true;
        }
    }
    false
}

#[napi]
pub async fn cross_machine_notify_gateway(
    port: u32,
    capability: String,
    event_json: String,
) -> Result<bool> {
    let Ok(port_u16) = u16::try_from(port) else {
        return Ok(false);
    };
    let event: Value = multicc_core::json_lenient::from_str(&event_json).unwrap_or(Value::Null);
    Ok(
        multicc_core::cross_machine_dispatch::notify_gateway_event(port_u16, &capability, &event)
            .await,
    )
}
