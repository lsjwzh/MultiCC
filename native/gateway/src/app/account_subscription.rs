//! `GET/HEAD/OPTIONS /api/{claude,codex}/subscription` (was
//! src/routes/account-subscription.js).
//!
//! The decisions live in `multicc_core::account_subscription` and the proxy
//! policy in `multicc_core::outbound_proxy`; this file owns the I/O the Node
//! route did inside the request: read `scutil --proxy` when the environment
//! names no proxy, build the plan, send it through the existing Rust HTTP
//! client (`multicc_cpr::provider_host`, the same one the napi adapter uses),
//! remember the observation in the shared SQLite cache, and collapse
//! concurrent requests for the same account into one upstream query.
//!
//! The cache is the cross-process contract: the Node reader
//! (src/quota/account-subscription-cache.js) projects the same rows for
//! `/api/providers`. Single-flight, by contrast, is process-local on both
//! sides — two tables that do not know about each other; see docs/gateway.md.
//!
//! The query runs in its own `tokio::spawn` task, not in the HTTP handler
//! future: Node's `pending` promise kept running when the client socket
//! closed, so a disconnect must not cancel the upstream query or its cache
//! write. Every requester subscribes to the leader's watch channel; dropping
//! a subscriber (the aborted handler) has no effect on the leader.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::Response;
use multicc_core::account_subscription as rules;
use multicc_core::outbound_proxy::{self, ProxyConfig, ProxyError, SystemProxy};
use serde_json::{json, Value};
use tokio::sync::{watch, Mutex as AsyncMutex};
use url::Url;

use super::express::{self, RequestCtx};
use super::App;

/// `src/paths.js` `providerLimitDbFile`; the Node recorder and the quota
/// routers already write this file, so the schema is shared, not new.
pub const FILE_NAME: &str = "provider-limit-cache.db";

/// `execFile('/usr/sbin/scutil', ['--proxy'], { timeout: 2000, maxBuffer: 32768 })`
/// lives in `crate::outbound::read_mac_system_proxy`.
/// `createProxyPolicy`'s default `refreshMs`.
const SYSTEM_REFRESH_MS: i64 = 30_000;

/// One in-flight query. Only the leader task holds the sender, so dropping it
/// (the panic path) closes the channel and wakes every waiter with `Err`; the
/// slot keeps a receiver to hand out, not a sender, so waiters can never keep
/// the channel alive while they wait for it to close.
struct Slot {
    key: String,
    rx: watch::Receiver<Option<Value>>,
}

/// Removes the slot when the leader ends — including unwinding on panic — and
/// only if the map still points at this exact slot (a newer leader may have
/// replaced it in the meantime).
struct SlotGuard {
    shared: Arc<Shared>,
    slot: Arc<Slot>,
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        self.shared.remove_slot(&self.slot);
    }
}

pub struct Shared {
    cache_file: PathBuf,
    /// Same lifetime as the Node module: one system-proxy slot per process.
    policy: Mutex<outbound_proxy::Cache>,
    /// The Node `pending` promise serialized concurrent discovery; one scutil
    /// read at a time, and everyone after it sees the fresh stamp.
    discovery: AsyncMutex<()>,
    /// `pending` Map: key = vendor + NUL + account id. Node keyed by id inside
    /// a per-vendor closure, which is the same key space.
    pending: Mutex<HashMap<String, Arc<Slot>>>,
}

impl Shared {
    pub fn new(data_root: &Path) -> Self {
        Self {
            cache_file: data_root.join(FILE_NAME),
            policy: Mutex::new(outbound_proxy::Cache {
                slot: outbound_proxy::SystemSlot::default(),
                refresh_ms: SYSTEM_REFRESH_MS,
            }),
            discovery: AsyncMutex::new(()),
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// `read(id)`: one query per vendor+id at a time, the observation recorded
    /// before anyone receives the answer (Node awaited `cache.record` inside
    /// the shared promise — and kept doing it after a client disconnected).
    pub async fn run(self: &Arc<Self>, vendor: &'static str, id: &str, home: &Path) -> Value {
        let key = format!("{vendor}\u{0}{id}");
        let shared = Arc::clone(self);
        let account = id.to_string();
        let home = home.to_path_buf();
        self.run_with(key, move || async move {
            shared.query_and_record(vendor, &account, &home).await
        })
        .await
    }

    /// The single-flight machinery, with the query injected so cancellation
    /// and panic cleanup are unit-testable without an upstream.
    pub(crate) async fn run_with<Q, Fut>(self: &Arc<Self>, key: String, query: Q) -> Value
    where
        Q: FnOnce() -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Value> + Send + 'static,
    {
        let (slot, leader_tx) = {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            match pending.get(&key) {
                Some(slot) => (Arc::clone(slot), None),
                None => {
                    let (tx, rx) = watch::channel(None);
                    let slot = Arc::new(Slot {
                        key: key.clone(),
                        rx,
                    });
                    pending.insert(key, Arc::clone(&slot));
                    (slot, Some(tx))
                }
            }
        };
        if let Some(tx) = leader_tx {
            let shared = Arc::clone(self);
            let task_slot = Arc::clone(&slot);
            tokio::spawn(async move {
                let _guard = SlotGuard {
                    shared,
                    slot: task_slot,
                };
                let value = query().await;
                // `send_replace` stores the value even when every receiver is
                // gone (the client disconnected), so a request that attaches
                // before the guard removes the slot still sees this answer.
                tx.send_replace(Some(value));
            });
        }
        let mut rx = slot.rx.clone();
        loop {
            let current = { rx.borrow().clone() };
            if let Some(value) = current {
                return value;
            }
            match rx.changed().await {
                Ok(()) => continue,
                // The leader panicked (or the runtime is shutting down): the
                // sender is gone without a value. Node's catch mapped a
                // rejected promise to `unavailable`; do the same, do not hang.
                Err(_) => return json!({"status":"unavailable"}),
            }
        }
    }

    fn remove_slot(&self, slot: &Arc<Slot>) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if pending
            .get(&slot.key)
            .is_some_and(|current| Arc::ptr_eq(current, slot))
        {
            pending.remove(&slot.key);
        }
    }

    async fn query_and_record(&self, vendor: &'static str, id: &str, home: &Path) -> Value {
        // Node read this before starting the query; the cache keeps it as
        // last_attempt_at and only lets a newer observation replace a row.
        let attempt_at = super::now_ms() as f64;
        let result = self
            .query(vendor, id, home)
            .await
            // The Node catch: `error.status === 401 ? no_auth : unavailable`.
            // Nothing the plan/credential/proxy path throws carries a status,
            // so every rejection is `unavailable`.
            .unwrap_or_else(|_| json!({"status":"unavailable"}));
        let document = json!({
            "operation": "record",
            "vendor": vendor,
            "accountId": id,
            "result": result,
            "attemptAt": attempt_at,
        });
        let file = self.cache_file.clone();
        let text = document.to_string();
        // `await cache.record(...).catch(() => {})`: an unwritable database
        // must never change the answer.
        let _ = tokio::task::spawn_blocking(move || {
            multicc_core::subscription_cache::access(&file.to_string_lossy(), &text)
        })
        .await;
        result
    }

    async fn query(
        &self,
        vendor: &'static str,
        id: &str,
        home: &Path,
    ) -> Result<Value, ProxyError> {
        let now = super::now_ms();
        let plan = if vendor == "codex" {
            let file = rules::codex_auth_file(home, id);
            tokio::task::spawn_blocking(move || rules::plan("codex", &file, ""))
                .await
                .map_err(|_| ProxyError("credential read failed"))?
                .map_err(|_| ProxyError("subscription plan failed"))?
        } else if !id.is_empty() {
            let home = home.to_path_buf();
            let account = id.to_string();
            let token =
                tokio::task::spawn_blocking(move || rules::peek_claude_token(&home, &account, now))
                    .await
                    .map_err(|_| ProxyError("credential read failed"))?;
            rules::plan("claude", Path::new(""), token.as_deref().unwrap_or(""))
                .map_err(|_| ProxyError("subscription plan failed"))?
        } else {
            // The CLI's own login. On macOS this reads the Keychain item
            // "Claude Code-credentials" through the absolute /usr/bin/security
            // (native/cpr/src/provider_host.rs), exactly like the Node route.
            // Tests never take this branch: they cover the rule with an
            // injected credential document instead.
            let document = json!({
                "platform": platform_name(),
                "file": rules::cli_credentials_file(home).to_string_lossy(),
                "service": "Claude Code-credentials",
            });
            let read = multicc_cpr::provider_host::read_cli(&document.to_string())
                .await
                .map_err(|_| ProxyError("credential read failed"))?;
            let token = rules::global_claude_token(&read, now);
            rules::plan("claude", Path::new(""), token.as_deref().unwrap_or(""))
                .map_err(|_| ProxyError("subscription plan failed"))?
        };
        if let Some(result) = plan.get("result") {
            return Ok(result.clone());
        }
        let url = Url::parse(plan["url"].as_str().unwrap_or(""))
            .map_err(|_| ProxyError("subscription URL invalid"))?;
        let proxy = self.proxy_for(&url).await?;
        let mut plan = plan;
        plan["proxyUrl"] = if proxy.is_empty() {
            Value::Null
        } else {
            Value::String(proxy)
        };
        Ok(multicc_cpr::provider_host::subscription_query(plan).await)
    }

    /// `policy.proxyForUrl`: loopback before discovery, then the cached
    /// configuration; an empty string means a direct connection.
    async fn proxy_for(&self, url: &Url) -> Result<String, ProxyError> {
        if outbound_proxy::is_loopback(url.host_str().unwrap_or("")) {
            return Ok(String::new());
        }
        let config = self.configuration().await?;
        Ok(outbound_proxy::proxy_of(&config, url))
    }

    async fn configuration(&self) -> Result<ProxyConfig, ProxyError> {
        let env = outbound_proxy::env_from_process();
        let platform = platform_name();
        let due = platform == "darwin"
            && !outbound_proxy::has_proxy_env(&env)
            && self
                .policy
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .slot
                .due(super::now_ms(), SYSTEM_REFRESH_MS);
        if due {
            // Node shared one in-flight `pending` read; re-check after taking
            // the turn, because the previous holder may have just refreshed.
            let _guard = self.discovery.lock().await;
            let due = self
                .policy
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .slot
                .due(super::now_ms(), SYSTEM_REFRESH_MS);
            if due {
                let read = read_mac_system_proxy().await;
                // The stamp is taken after the read, like the JavaScript.
                self.policy
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .accept(super::now_ms(), read)?;
            }
        }
        let policy = self.policy.lock().unwrap_or_else(|e| e.into_inner());
        outbound_proxy::resolve_proxy_config(&env, policy.slot.value.as_ref())
    }
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    }
}

/// `readMacSystemProxy`: shared with the front door's outbound client, so the
/// 2s deadline and 32KiB ceiling have one implementation.
async fn read_mac_system_proxy() -> Result<SystemProxy, ProxyError> {
    crate::outbound::read_mac_system_proxy().await
}

/// Answers the route. The id checks sit in front of the whole query, so a 400
/// or 404 never writes the cache and never carries `Cache-Control: no-store`
/// (Node set it only after both checks).
pub async fn get(app: &Arc<App>, vendor: &'static str, ctx: &RequestCtx) -> Response<Body> {
    let id = rules::account(&ctx.original_url);
    if !id.is_empty() && !rules::valid_account(&id) {
        return express::json(
            ctx,
            400,
            &json!({"status":"unavailable","error":"invalid account"}),
            &[],
        );
    }
    if vendor == "claude" && !id.is_empty() {
        // `listClaudeAccounts` is a directory scan; keep it off the async
        // worker like every other blocking read in this module.
        let home = app.home_dir.clone();
        let account = id.clone();
        let known =
            tokio::task::spawn_blocking(move || rules::claude_account_known(&home, &account))
                .await
                .unwrap_or(false);
        if !known {
            return express::json(ctx, 404, &json!({"status":"no_auth"}), &[]);
        }
    }
    let result = app
        .account_subscription
        .run(vendor, &id, &app.home_dir)
        .await;
    express::json(ctx, 200, &result, &[("Cache-Control", "no-store")])
}
