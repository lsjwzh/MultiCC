//! Boot a shared page from the session share store, including links issued by Node.
use super::express::{self, RequestCtx};
use axum::{body::Body, http::Response};
use multicc_core::{
    auth_security, http_gate,
    js::{
        self,
        serde::{js_string, truthy},
    },
    provider_store,
    share_machine_routes::Route,
    state_file, workspace_sharing,
};
use serde_json::{json, Value};
use std::{fs, io, path::Path};

fn read(file: &Path, token: &str, now: f64) -> io::Result<Option<Value>> {
    fn table(file: &Path) -> io::Result<Value> {
        match fs::read(file) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(json!({})),
            Err(e) => Err(e),
        }
    }
    let expired = |record: &Value| {
        record["expiresAt"]
            .as_f64()
            .is_some_and(|at| at != 0. && now > at)
    };
    let mut shares = table(file)?;
    let Some(record) = shares.get_mut(token) else {
        return Ok(None);
    };
    if !expired(record) {
        return Ok(Some(record.take()));
    }
    if let Ok(_guard) = provider_store::lock(file) {
        let mut latest = table(file)?;
        if latest.get(token).is_some_and(expired) {
            if let Some(map) = latest.as_object_mut() {
                map.remove(token);
            }
            let _ = state_file::write_json_atomic(file, &latest);
        }
    }
    Ok(None)
}

fn failure(status: u16, message: &str) -> Value {
    json!({"status":status,"body":{"error":message}})
}

fn entry(root: &Path, route: Route, token: &str, cookie: &str, body: &Value) -> Result<Value, ()> {
    let now = multicc_core::state_tx::now_millis();
    let Some(record) = read(&root.join("shares.json"), token, now).map_err(|_| ())? else {
        return Ok(failure(404, "share not found or expired"));
    };
    let access = record["access"].as_str().ok_or(())?;
    let protected = truthy(&record["pwHash"]);
    if record["token"] != token
        || !matches!(access, "view" | "operate")
        || (access == "operate" && !protected)
    {
        return Err(());
    }
    if route == Route::ShareAuth {
        if protected {
            let password = body
                .get("password")
                .filter(|v| !v.is_null())
                .map(js_string)
                .unwrap_or_default();
            let valid = !password.is_empty()
                && password.len() <= 4096
                && workspace_sharing::hash(&password, record["salt"].as_str().ok_or(())?)
                    .is_ok_and(|hash| {
                        auth_security::timing_safe_equal_text(
                            &hash,
                            record["pwHash"].as_str().unwrap_or(""),
                        )
                    });
            if !valid {
                return Ok(failure(403, "密码错误"));
            }
        }
        let secret = record["secret"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(())?;
        if !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(());
        }
        let value = auth_security::session_share_cookie(secret, token);
        let header = format!(
            "multicc_share_{token}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800"
        );
        return Ok(
            json!({"status":200,"headers":[["Set-Cookie",header]],"body":{"ok":true,"access":access}}),
        );
    }
    if protected
        && !auth_security::verify_session_share_cookie(
            record["secret"].as_str().unwrap_or(""),
            token,
            cookie,
        )
    {
        return Ok(json!({"status":401,"body":{"needPassword":true}}));
    }
    let label = record.get("label").filter(|v| truthy(v));
    let result = if record["type"] == "messages" {
        json!({"access":"view","type":"messages","label":label.cloned().unwrap_or_else(||json!("消息分享")),
            "messages":record.get("messages").filter(|v| truthy(v)).cloned().unwrap_or_else(||json!([]))})
    } else {
        let id = record["sessionId"].as_str().ok_or(())?;
        let rows = crate::ws_chat_native::session_records(root).map_err(|_| ())?;
        let Some(session) = crate::ws_chat_native::find_session_record(&rows, id) else {
            return Ok(failure(404, "session no longer exists"));
        };
        let session = js::to_serde(session);
        json!({"access":access,"type":"session","sessionId":id,
            "label":label.or_else(||session.get("label").filter(|v|truthy(v))).cloned().unwrap_or_else(||json!(id)),
            "cli":session.get("cli").filter(|v|truthy(v)).cloned().unwrap_or_else(||json!("claude"))})
    };
    Ok(json!({"status":200,"body":result}))
}

pub async fn handle(
    root: &Path,
    ctx: &RequestCtx,
    route: Route,
    token: String,
    body: Value,
) -> Response<Body> {
    let cookies = http_gate::parse_cookies(ctx.headers.get("cookie"));
    let cookie = cookies
        .get(&format!("multicc_share_{token}"))
        .cloned()
        .unwrap_or_default();
    let root = root.to_owned();
    match tokio::task::spawn_blocking(move || entry(&root, route, &token, &cookie, &body)).await {
        Ok(Ok(reply)) => super::share_machine_routes::relay(ctx, reply),
        _ => {
            let error = if route == Route::ShareAuth {
                "share authentication failed"
            } else {
                "shared entry read failed"
            };
            express::json(ctx, 500, &json!({"error":error}), &[])
        }
    }
}
