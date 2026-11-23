//! `/api/agy/accounts*` — Antigravity multi-account switching.
//!
//! agy keeps its whole login in `$HOME/.gemini` and honours `HOME`, so an
//! account is just another HOME directory. The storage rules live in
//! [`multicc_core::agy_accounts`]; this cluster owns the routes, and the one
//! helper the spawn sites share, [`home_override`], which `agy_catalog` and
//! `agy_quota` apply to the `agy` child's environment.
//!
//! Every mutation drops the catalog and quota caches: both are keyed on the
//! signed-in account, and a stale 10-minute catalog would otherwise keep
//! showing the previous account after a switch.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::http::{Method, Response};
use serde_json::{json, Value};

use crate::app::express::{self, RequestCtx};
use multicc_core::agy_accounts as store;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    ListGet,
    CreatePost,
    CreateRemotePost,
    ImportPost,
    DeactivatePost,
    ActivatePost,
    LoginTerminal,
    RemoteLoginStartPost,
    RemoteLoginCallbackPost,
    RemoteLoginStatusGet,
    TestRemotePost,
    UpdateRemotePatch,
    Delete,
    MutagenStatusGet,
    MutagenInstallPost,
    Options,
}

struct Layer {
    segs: &'static [&'static str],
    method: &'static str,
    kind: Route,
}

/// `:id` matches any non-empty segment, like Express's default `:param`. The
/// literal layers must stay ahead of the parameterised one on any shared shape.
static LAYERS: &[Layer] = &[
    Layer {
        segs: &["agy", "accounts"],
        method: "GET",
        kind: Route::ListGet,
    },
    Layer {
        segs: &["agy", "accounts"],
        method: "POST",
        kind: Route::CreatePost,
    },
    Layer {
        segs: &["agy", "accounts", "remote"],
        method: "POST",
        kind: Route::CreateRemotePost,
    },
    Layer {
        segs: &["agy", "accounts", "import"],
        method: "POST",
        kind: Route::ImportPost,
    },
    Layer {
        segs: &["agy", "accounts", "deactivate"],
        method: "POST",
        kind: Route::DeactivatePost,
    },
    Layer {
        segs: &["agy", "accounts", ":id", "activate"],
        method: "POST",
        kind: Route::ActivatePost,
    },
    Layer {
        segs: &["agy", "accounts", ":id", "login-terminal"],
        method: "POST",
        kind: Route::LoginTerminal,
    },
    Layer {
        segs: &["agy", "accounts", ":id", "remote-login"],
        method: "POST",
        kind: Route::RemoteLoginStartPost,
    },
    Layer {
        segs: &["agy", "accounts", ":id", "remote-login-callback"],
        method: "POST",
        kind: Route::RemoteLoginCallbackPost,
    },
    Layer {
        segs: &["agy", "accounts", ":id", "remote-login-status"],
        method: "GET",
        kind: Route::RemoteLoginStatusGet,
    },
    Layer {
        segs: &["agy", "accounts", ":id", "test"],
        method: "POST",
        kind: Route::TestRemotePost,
    },
    Layer {
        segs: &["agy", "accounts", ":id"],
        method: "PATCH",
        kind: Route::UpdateRemotePatch,
    },
    Layer {
        segs: &["agy", "accounts", ":id"],
        method: "DELETE",
        kind: Route::Delete,
    },
    Layer {
        segs: &["agy", "mutagen", "status"],
        method: "GET",
        kind: Route::MutagenStatusGet,
    },
    Layer {
        segs: &["agy", "mutagen", "install"],
        method: "POST",
        kind: Route::MutagenInstallPost,
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

fn layer_matches(layer: &Layer, parts: &[&str]) -> bool {
    layer.segs.len() == parts.len()
        && layer.segs.iter().zip(parts).all(|(name, part)| {
            if *name == ":id" {
                !part.is_empty()
            } else {
                part.eq_ignore_ascii_case(name)
            }
        })
}

pub fn claim(method: &Method, path: &str) -> Option<Route> {
    let parts = segments(path)?;
    if method.as_str() == "OPTIONS" {
        return LAYERS
            .iter()
            .any(|layer| layer_matches(layer, &parts))
            .then_some(Route::Options);
    }
    let wanted = if method.as_str() == "HEAD" {
        "GET"
    } else {
        method.as_str()
    };
    LAYERS
        .iter()
        .find(|layer| layer.method == wanted && layer_matches(layer, &parts))
        .map(|layer| layer.kind)
}

/// Express's automatic `OPTIONS` answer: this cluster's own `Allow` share.
pub fn options_share(path: &str) -> Option<String> {
    let parts = segments(path)?;
    let mut methods: Vec<&'static str> = Vec::new();
    let mut matched = false;
    for layer in LAYERS {
        if !layer_matches(layer, &parts) {
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
    matched.then(|| methods.join(","))
}

/// The machine's home. Everything under `~/.multicc/official-accounts/agy` is
/// addressed relative to it, so a missing `HOME` cannot be served at all.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The `HOME` a spawned `agy` should inherit: the active account's home, or
/// `None` to leave the real home in place (the CLI's own login).
pub(super) fn home_override() -> Option<OsString> {
    store::active_home(&home_dir()?).map(PathBuf::into_os_string)
}

/// `/api/agy/accounts/:id` → `id`. Only called for the two routes whose shape
/// already ends in `:id`, so the literal siblings cannot reach it.
fn account_id_in(path: &str) -> Option<String> {
    let parts = segments(path)?;
    let named = |index: usize, name: &str| {
        parts
            .get(index)
            .is_some_and(|part| part.eq_ignore_ascii_case(name))
    };
    if named(0, "agy") && named(1, "accounts") {
        return parts.get(2).map(|id| (*id).to_owned());
    }
    None
}

fn account_id(ctx: &RequestCtx) -> Option<String> {
    account_id_in(&ctx.path)
}

async fn state_with_mutagen(home: &Path) -> Value {
    let mut accounts = store::list_accounts(home);
    for acct in &mut accounts {
        if acct.get("kind").and_then(Value::as_str) == Some(store::KIND_REMOTE) {
            if let Some(id) = acct.get("id").and_then(Value::as_str).map(str::to_owned) {
                let login = crate::agy_remote_login::login_status(&id).await;
                if let Some(obj) = acct.as_object_mut() {
                    obj.insert("login".to_string(), login);
                }
            }
        }
    }
    json!({
        "accounts": accounts,
        "active": store::active_id(home).map_or(Value::Null, |id| json!(id)),
        "local": store::local_status(home),
        "mutagen": crate::agy_remote_bridge::mutagen_status_for(Some(home)).await,
    })
}

/// Drop the account-keyed caches after any write, so the next catalog/quota
/// read reflects the new active account.
async fn invalidate_spawn_caches() {
    super::agy_catalog::invalidate().await;
    super::agy_quota::invalidate().await;
}

pub async fn handle(ctx: &RequestCtx, route: Route, body: &Value, host: u16) -> Response<Body> {
    let Some(home) = home_dir() else {
        return express::json(
            ctx,
            500,
            &json!({ "error": "无法定位 HOME，反重力账号不可用" }),
            &[],
        );
    };
    let label = || {
        body.get("label")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let failure =
        |status: u16, error: String| express::json(ctx, status, &json!({ "error": error }), &[]);
    match route {
        Route::ListGet => {
            crate::egress_runtime::publish_host_runtime_manifest(&home);
            express::json(
                ctx,
                200,
                &state_with_mutagen(&home).await,
                &[("Cache-Control", "no-store")],
            )
        }
        Route::MutagenStatusGet => express::json(
            ctx,
            200,
            &crate::agy_remote_bridge::mutagen_status_for(Some(&home)).await,
            &[("Cache-Control", "no-store")],
        ),
        Route::MutagenInstallPost => {
            match crate::agy_remote_bridge::install_managed_mutagen().await {
                Ok(mutagen) => {
                    let mut out = state_with_mutagen(&home).await;
                    if let Some(obj) = out.as_object_mut() {
                        obj.insert("mutagen".to_string(), mutagen);
                    }
                    express::json(ctx, 200, &out, &[("Cache-Control", "no-store")])
                }
                Err(error) => failure(500, error),
            }
        }
        Route::CreatePost => {
            crate::egress_runtime::publish_host_runtime_manifest(&home);
            let result = store::create_account_with_egress(
                &home,
                &label(),
                "created",
                body.get("egressBinding"),
            );
            match result {
                Ok(created) => {
                    invalidate_spawn_caches().await;
                    let mut out = state_with_mutagen(&home).await;
                    if let Some(obj) = out.as_object_mut() {
                        obj.insert("created".to_string(), created);
                    }
                    express::json(ctx, 200, &out, &[("Cache-Control", "no-store")])
                }
                Err(error) => failure(400, error),
            }
        }
        Route::CreateRemotePost => {
            // 标准 Host/Client 分离：远端引用账号绝不接受 Client 侧 egressBinding，
            // 出口 IP 严格由远端 Host（VPS 的 MultiCC）账号自身绑定与解析。
            let raw_remote = body.get("remote").unwrap_or(body);
            match store::create_remote_account(&home, &label(), raw_remote) {
                Ok(created) => {
                    invalidate_spawn_caches().await;
                    let mut out = state_with_mutagen(&home).await;
                    if let Some(obj) = out.as_object_mut() {
                        obj.insert("created".to_string(), created);
                    }
                    express::json(ctx, 200, &out, &[("Cache-Control", "no-store")])
                }
                Err(error) => failure(400, error),
            }
        }
        Route::UpdateRemotePatch => {
            let Some(id) = account_id(ctx) else {
                return failure(400, "invalid account id".to_owned());
            };
            let has_remote_fields = body.get("remote").is_some() || body.get("sshTarget").is_some();
            if has_remote_fields {
                let raw_remote = body.get("remote").unwrap_or(body);
                let next_label = body.get("label").and_then(Value::as_str);
                if let Err(error) = store::update_remote_account(&home, &id, next_label, raw_remote)
                {
                    return failure(400, error);
                }
            }
            if body.get("egressBinding").is_some() || !has_remote_fields {
                if let Err(error) =
                    store::update_account_egress(&home, &id, body.get("egressBinding"))
                {
                    return failure(400, error);
                }
            }
            invalidate_spawn_caches().await;
            express::json(
                ctx,
                200,
                &state_with_mutagen(&home).await,
                &[("Cache-Control", "no-store")],
            )
        }
        Route::TestRemotePost => {
            let Some(id) = account_id(ctx) else {
                return failure(400, "invalid account id".to_owned());
            };
            let Some((_, remote)) = store::get_remote_account(&home, &id) else {
                return failure(404, "未找到对应的远端 VPS 反重力账号".to_owned());
            };
            let result = crate::agy_remote_bridge::probe_remote_target(&remote).await;
            express::json(ctx, 200, &result, &[("Cache-Control", "no-store")])
        }
        Route::RemoteLoginStartPost => {
            let Some(id) = account_id(ctx) else {
                return failure(400, "invalid account id".to_owned());
            };
            match store::resolve_account(&home, Some(&id)) {
                Ok(Some(store::ResolvedAgyAccount::Local {
                    home: account_home,
                    egress_binding,
                })) => {
                    match crate::agy_remote_login::start_local_login(
                        &home,
                        &id,
                        &account_home,
                        egress_binding.as_ref(),
                    )
                    .await
                    {
                        Ok(payload) => {
                            express::json(ctx, 200, &payload, &[("Cache-Control", "no-store")])
                        }
                        Err(error) => failure(400, error),
                    }
                }
                Ok(Some(store::ResolvedAgyAccount::Remote { remote, .. })) => {
                    if remote.host_account_id.is_some() {
                        return failure(
                            400,
                            "该账号由远端 Host（VPS 的 MultiCC）管理，请在 Host 端完成登录与出口绑定"
                                .to_owned(),
                        );
                    }
                    match crate::agy_remote_login::start_login(&home, &id, &remote).await {
                        Ok(payload) => {
                            express::json(ctx, 200, &payload, &[("Cache-Control", "no-store")])
                        }
                        Err(error) => failure(400, error),
                    }
                }
                Ok(None) | Err(_) => failure(404, "未找到对应的反重力账号".to_owned()),
            }
        }
        Route::RemoteLoginCallbackPost => {
            let Some(id) = account_id(ctx) else {
                return failure(400, "invalid account id".to_owned());
            };
            let callback = body
                .get("callback")
                .and_then(Value::as_str)
                .or_else(|| body.get("code").and_then(Value::as_str))
                .unwrap_or("");
            match crate::agy_remote_login::submit_callback(&id, callback).await {
                Ok(payload) => express::json(ctx, 200, &payload, &[("Cache-Control", "no-store")]),
                Err(error) => failure(400, error),
            }
        }
        Route::RemoteLoginStatusGet => {
            let Some(id) = account_id(ctx) else {
                return failure(400, "invalid account id".to_owned());
            };
            let payload = crate::agy_remote_login::login_status(&id).await;
            express::json(ctx, 200, &payload, &[("Cache-Control", "no-store")])
        }
        Route::ImportPost => match store::import_account(&home, &label()) {
            Ok(_) => {
                invalidate_spawn_caches().await;
                express::json(
                    ctx,
                    200,
                    &state_with_mutagen(&home).await,
                    &[("Cache-Control", "no-store")],
                )
            }
            Err(error) => failure(400, error),
        },
        Route::ActivatePost => {
            let Some(id) = account_id(ctx) else {
                return failure(400, "invalid account id".to_owned());
            };
            match store::set_active(&home, Some(&id)) {
                Ok(()) => {
                    invalidate_spawn_caches().await;
                    express::json(
                        ctx,
                        200,
                        &state_with_mutagen(&home).await,
                        &[("Cache-Control", "no-store")],
                    )
                }
                Err(error) => failure(400, error),
            }
        }
        Route::DeactivatePost => match store::set_active(&home, None) {
            Ok(()) => {
                invalidate_spawn_caches().await;
                express::json(
                    ctx,
                    200,
                    &state_with_mutagen(&home).await,
                    &[("Cache-Control", "no-store")],
                )
            }
            Err(error) => failure(500, error),
        },
        // 登录是厂商自带的交互 TUI（没有 `agy login` 子命令），PTY 与
        // createSessionRecord 都在 Node；这里只做账号解析，然后把已校验的
        // 账号目录交给 host 端口，公开契约仍由前门独占。
        Route::LoginTerminal => {
            let Some(id) = account_id(ctx) else {
                return failure(400, "invalid account id".to_owned());
            };
            let Some(meta) = store::meta_file(&home, &id) else {
                return failure(400, "invalid account id".to_owned());
            };
            if !meta.is_file() {
                return failure(404, "unknown account".to_owned());
            }
            if store::get_remote_account(&home, &id).is_some() {
                return failure(
                    400,
                    "远端 VPS 账号无需本机登录终端，请直接在 VPS 上登录 agy".to_owned(),
                );
            }
            let Some(dir) = store::account_home(&home, &id) else {
                return failure(400, "invalid account id".to_owned());
            };
            if let Err(error) = std::fs::create_dir_all(&dir) {
                return failure(500, error.to_string());
            }
            let mut login_body = json!({ "home": dir.to_string_lossy() });
            if let Some(binding) = store::get_account_egress(&home, &id) {
                match crate::egress_runtime::resolve_egress_proxy_url(&binding).await {
                    Ok(proxy_url) => {
                        login_body["proxyUrl"] = json!(proxy_url);
                    }
                    Err(error) => return failure(400, error),
                }
            }
            let payload = json!({
                "op": "agy-login-terminal",
                "method": "POST",
                "id": id,
                "body": login_body,
            });
            match super::session_routes::call(ctx, host, payload).await {
                Ok(answer) => super::session_routes::relay(ctx, answer),
                Err(response) => response,
            }
        }
        Route::Delete => {
            let Some(id) = account_id(ctx) else {
                return failure(400, "invalid account id".to_owned());
            };
            match store::delete_account(&home, &id) {
                Ok(()) => {
                    invalidate_spawn_caches().await;
                    if host != 0 {
                        // Best-effort: release persisted session picks bound to this account so
                        // their next turn falls back cleanly instead of failing closed.
                        let payload = json!({
                            "op": "agy-release-account",
                            "method": "POST",
                            "id": id,
                            "body": {},
                        });
                        let _ = super::session_routes::call(ctx, host, payload).await;
                    }
                    express::json(
                        ctx,
                        200,
                        &state_with_mutagen(&home).await,
                        &[("Cache-Control", "no-store")],
                    )
                }
                Err(error) => failure(400, error),
            }
        }
        Route::Options => {
            // The front door answers OPTIONS through `options_allow`; reaching
            // here means the union had a single source, which this cluster
            // answers with its own share.
            let allow = options_share(&ctx.path).unwrap_or_default();
            express::send(
                ctx,
                200,
                "text/html; charset=utf-8",
                allow.clone().into_bytes(),
                &[("Allow", allow.as_str())],
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_the_account_shapes_and_nothing_else() {
        assert_eq!(
            claim(&Method::GET, "/api/agy/accounts"),
            Some(Route::ListGet)
        );
        assert_eq!(
            claim(&Method::HEAD, "/api/agy/accounts"),
            Some(Route::ListGet)
        );
        assert_eq!(
            claim(&Method::POST, "/api/agy/accounts"),
            Some(Route::CreatePost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/agy/accounts/import"),
            Some(Route::ImportPost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/agy/accounts/deactivate"),
            Some(Route::DeactivatePost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/agy/accounts/0123456789abcdef/activate"),
            Some(Route::ActivatePost)
        );
        assert_eq!(
            claim(
                &Method::POST,
                "/api/agy/accounts/0123456789abcdef/login-terminal"
            ),
            Some(Route::LoginTerminal)
        );
        assert_eq!(
            claim(
                &Method::GET,
                "/api/agy/accounts/0123456789abcdef/login-terminal"
            ),
            None
        );
        assert_eq!(
            claim(&Method::POST, "/api/agy/accounts/remote"),
            Some(Route::CreateRemotePost)
        );
        assert_eq!(
            claim(&Method::POST, "/api/agy/accounts/0123456789abcdef/test"),
            Some(Route::TestRemotePost)
        );
        assert_eq!(
            claim(
                &Method::POST,
                "/api/agy/accounts/0123456789abcdef/remote-login"
            ),
            Some(Route::RemoteLoginStartPost)
        );
        assert_eq!(
            claim(
                &Method::POST,
                "/api/agy/accounts/0123456789abcdef/remote-login-callback"
            ),
            Some(Route::RemoteLoginCallbackPost)
        );
        assert_eq!(
            claim(
                &Method::GET,
                "/api/agy/accounts/0123456789abcdef/remote-login-status"
            ),
            Some(Route::RemoteLoginStatusGet)
        );
        assert_eq!(
            claim(&Method::PATCH, "/api/agy/accounts/0123456789abcdef"),
            Some(Route::UpdateRemotePatch)
        );
        assert_eq!(
            claim(&Method::DELETE, "/api/agy/accounts/0123456789abcdef"),
            Some(Route::Delete)
        );
        assert_eq!(
            claim(&Method::GET, "/api/agy/mutagen/status"),
            Some(Route::MutagenStatusGet)
        );
        assert_eq!(
            claim(&Method::POST, "/api/agy/mutagen/install"),
            Some(Route::MutagenInstallPost)
        );
        // The quota and catalog clusters keep `/api/agy/quota` and
        // `/api/agy/models`; this cluster must not claim them.
        assert_eq!(claim(&Method::GET, "/api/agy/quota"), None);
        assert_eq!(claim(&Method::GET, "/api/agy/models"), None);
        // Shapes the retired Express router never registered.
        assert_eq!(
            claim(&Method::POST, "/api/agy/accounts/0123456789abcdef"),
            None
        );
        assert_eq!(claim(&Method::GET, "/api/agy/accounts/import"), None);
    }

    #[test]
    fn options_lists_each_path_methods() {
        assert_eq!(
            options_share("/api/agy/accounts").as_deref(),
            Some("GET,HEAD,POST")
        );
        // Express unions every layer whose shape matches, and `:id` matches
        // these literals too, so `PATCH,DELETE` are part of the answer.
        assert_eq!(
            options_share("/api/agy/accounts/import").as_deref(),
            Some("POST,PATCH,DELETE")
        );
        assert_eq!(
            options_share("/api/agy/accounts/remote").as_deref(),
            Some("POST,PATCH,DELETE")
        );
        assert_eq!(
            options_share("/api/agy/accounts/0123456789abcdef").as_deref(),
            Some("PATCH,DELETE")
        );
        assert_eq!(
            options_share("/api/agy/accounts/0123456789abcdef/login-terminal").as_deref(),
            Some("POST")
        );
        assert_eq!(
            options_share("/api/agy/accounts/0123456789abcdef/test").as_deref(),
            Some("POST")
        );
        assert_eq!(options_share("/api/agy/quota"), None);
    }

    #[test]
    fn account_id_reads_the_parameter_segment() {
        assert_eq!(
            account_id_in("/api/agy/accounts/0123456789abcdef/activate").as_deref(),
            Some("0123456789abcdef")
        );
        assert_eq!(
            account_id_in("/api/agy/accounts/0123456789abcdef").as_deref(),
            Some("0123456789abcdef")
        );
        assert_eq!(
            account_id_in("/api/agy/accounts/0123456789abcdef/login-terminal").as_deref(),
            Some("0123456789abcdef")
        );
        assert_eq!(account_id_in("/api/agy/accounts"), None);
        assert_eq!(account_id_in("/api/agy/quota"), None);
    }
}
