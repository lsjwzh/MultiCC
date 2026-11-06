//! Computer identities, revocable pair grants, private persistence and transport.
//! The host only adapts HTTP/WebSocket objects; no credential enters a child env.
mod network;
mod store;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::time::Duration;
use store::{Grant, Locked, Peer};

#[derive(Debug)]
pub struct Error {
    status: u16,
    code: &'static str,
    message: &'static str,
}
fn fail(status: u16, code: &'static str, message: &'static str) -> Error {
    Error {
        status,
        code,
        message,
    }
}
fn text<'a>(input: &'a Value, key: &str) -> &'a str {
    input[key].as_str().unwrap_or("")
}
fn result(data: Value) -> Value {
    json!({ "status": 200, "data": data })
}
fn self_dto(registry: &store::Registry) -> Value {
    json!({ "id": registry.id, "name": registry.name, "local": true, "protocol": 1 })
}
fn peer_dto(peer: &Peer) -> Value {
    json!({ "id": peer.id, "name": peer.name, "origin": peer.origin, "local": false, "addedAt": peer.added_at })
}
fn grant_dto(grant: &Grant) -> Value {
    json!({ "id": grant.id, "name": grant.name, "ownerId": grant.owner_id, "createdAt": grant.created_at })
}

pub fn authorize(root: &str, credential: &str, method: &str, path: &str) -> Option<String> {
    if !credential.starts_with("mcg_")
        || credential.len() != 52
        || !network::api_path(path)
        || !matches!(method, "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD")
        || (path.split('?').next() == Some("/api/machines/connection") && method != "DELETE")
    {
        return None;
    }
    let locked = Locked::open(root).ok()?;
    let digest = store::digest(credential);
    locked
        .registry
        .grants
        .iter()
        .find(|g| store::constant_eq(&g.digest, &digest))
        .map(|g| g.id.clone())
}

pub fn grant_active(root: &str, id: &str) -> bool {
    Locked::open(root).is_ok_and(|locked| locked.registry.grants.iter().any(|g| g.id == id))
}

fn local(root: &str, operation: &str, input: &Value) -> Result<Value, Error> {
    let mut locked = Locked::open(root)?;
    match operation {
        "self" => {
            locked.save()?;
            Ok(result(self_dto(&locked.registry)))
        }
        "list" => {
            locked.save()?;
            Ok(result(
                json!({ "self": self_dto(&locked.registry), "machines": locked.registry.peers.iter().map(peer_dto).collect::<Vec<_>>() }),
            ))
        }
        "rename" => {
            let name = store::name(text(input, "name"))?;
            if text(input, "id") == locked.registry.id || text(input, "id") == "self" {
                locked.registry.name = name;
            } else {
                locked
                    .registry
                    .peers
                    .iter_mut()
                    .find(|p| p.id == text(input, "id"))
                    .ok_or_else(|| fail(404, "machine_not_found", "电脑连接不存在"))?
                    .name = name;
            }
            locked.save()?;
            Ok(result(json!({ "ok": true })))
        }
        "remove" => {
            locked.registry.peers.retain(|p| p.id != text(input, "id"));
            locked.save()?;
            Ok(result(json!({ "ok": true })))
        }
        "grants" => Ok(result(
            json!({ "grants": locked.registry.grants.iter().map(grant_dto).collect::<Vec<_>>() }),
        )),
        "revoke" => {
            locked.registry.grants.retain(|g| g.id != text(input, "id"));
            locked.save()?;
            Ok(result(json!({ "ok": true })))
        }
        "pair" => {
            let owner = text(input, "ownerId");
            if !store::valid_id(owner) || owner == locked.registry.id {
                return Err(fail(
                    400,
                    "machine_pair_invalid",
                    "不能把当前电脑重复添加为远程电脑",
                ));
            }
            let name = store::name(text(input, "name"))?;
            if locked.registry.grants.len() >= 64
                && !locked.registry.grants.iter().any(|g| g.owner_id == owner)
            {
                return Err(fail(
                    409,
                    "machine_grant_limit",
                    "电脑授权已达到上限，请先撤销不再使用的授权",
                ));
            }
            let secret = store::random("mcg_")?;
            let grant = Grant {
                id: store::random("grant_")?,
                owner_id: owner.into(),
                name,
                digest: store::digest(&secret),
                created_at: store::now(),
            };
            // Re-pairing rotates only this owner's credential.
            locked.registry.grants.retain(|g| g.owner_id != owner);
            locked.registry.grants.push(grant.clone());
            locked.save()?;
            Ok(result(
                json!({ "machine": self_dto(&locked.registry), "grant": secret, "grantId": grant.id }),
            ))
        }
        _ => Err(fail(400, "machine_operation_invalid", "不支持此电脑操作")),
    }
}

fn peer(root: &str, id: &str) -> Result<Peer, Error> {
    let locked = Locked::open(root)?;
    locked
        .registry
        .peers
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| fail(404, "machine_not_found", "电脑连接不存在，请重新添加"))
}

async fn add(root: &str, input: &Value) -> Result<Value, Error> {
    let origin = network::origin(text(input, "origin"))?
        .origin()
        .ascii_serialization();
    let name = store::name(text(input, "name"))?;
    let (owner_id, owner_name) = {
        let locked = Locked::open(root)?;
        locked.save()?;
        (locked.registry.id.clone(), locked.registry.name.clone())
    };
    let token = text(input, "password");
    if token.is_empty() || token.len() > 4096 {
        return Err(fail(
            400,
            "machine_password_required",
            "请在连接窗口输入目标电脑的访问密码",
        ));
    }
    if !text(input, "expectedId").is_empty() {
        let response = network::request(
            &origin,
            "/api/machines/self",
            "GET",
            ("x-access-token", token),
            None,
            &json!({}),
        )
        .await?;
        if text(&network::response_json_pairing(&response)?, "id") != text(input, "expectedId") {
            return Err(fail(
                409,
                "machine_identity_changed",
                "此地址对应另一台电脑，请核对地址或将其单独添加",
            ));
        }
    }
    let response = network::request(
        &origin,
        "/api/machines/pair",
        "POST",
        ("x-access-token", token),
        Some(serde_json::to_vec(&json!({ "ownerId": owner_id, "name": owner_name })).unwrap()),
        &json!({ "headers": { "content-type": "application/json" } }),
    )
    .await?;
    let paired = network::response_json_pairing(&response)?;
    let id = text(&paired["machine"], "id");
    if !store::valid_id(id) || id == owner_id || !text(&paired, "grant").starts_with("mcg_") {
        return Err(fail(
            400,
            "machine_pair_invalid",
            "目标电脑的身份无效或与当前电脑相同",
        ));
    }
    let mut locked = Locked::open(root)?;
    if locked.registry.peers.len() >= 32 && !locked.registry.peers.iter().any(|p| p.id == id) {
        return Err(fail(
            409,
            "machine_limit",
            "最多连接三十二台电脑，请先移除不再使用的连接",
        ));
    }
    let added_at = locked
        .registry
        .peers
        .iter()
        .find(|p| p.id == id)
        .map(|p| p.added_at.clone())
        .unwrap_or_else(store::now);
    let next = Peer {
        id: id.into(),
        name,
        origin,
        grant: text(&paired, "grant").into(),
        grant_id: text(&paired, "grantId").into(),
        added_at,
    };
    locked.registry.peers.retain(|p| p.id != id);
    locked.registry.peers.push(next.clone());
    locked.save()?;
    Ok(result(peer_dto(&next)))
}

async fn proxy(root: &str, input: &Value) -> Result<Value, Error> {
    let peer = peer(root, text(input, "id"))?;
    let path = text(input, "path");
    if !network::api_path(path) {
        return Err(fail(
            403,
            "machine_path_denied",
            "此地址不能通过电脑连接访问",
        ));
    }
    let body = input["body"]
        .as_str()
        .map(|raw| {
            STANDARD
                .decode(raw)
                .map_err(|_| fail(400, "machine_body_invalid", "电脑请求内容无效"))
        })
        .transpose()?;
    network::request(
        &peer.origin,
        path,
        text(input, "method"),
        ("x-multicc-machine-grant", &peer.grant),
        body,
        input,
    )
    .await
}

async fn websocket(root: &str, input: &Value) -> Result<Value, Error> {
    let peer = peer(root, text(input, "id"))?;
    let path = text(input, "path");
    if !network::ws_path(path) {
        return Err(fail(403, "machine_ws_denied", "不支持此实时连接地址"));
    }
    let mut url = network::origin(&peer.origin)?
        .join(path)
        .map_err(|_| fail(400, "machine_ws_invalid", "实时连接地址无效"))?;
    if url
        .query_pairs()
        .any(|(key, _)| matches!(key.as_ref(), "token" | "ticket" | "share"))
    {
        return Err(fail(400, "machine_ws_invalid", "实时连接参数无效"));
    }
    let response = network::request(
        &peer.origin,
        "/api/auth/ws-ticket",
        "POST",
        ("x-multicc-machine-grant", &peer.grant),
        Some(serde_json::to_vec(&json!({ "path": url.path() })).unwrap()),
        &json!({ "headers": { "content-type": "application/json" } }),
    )
    .await?;
    let issued = network::response_json(&response)?;
    let ticket = text(&issued, "ticket");
    if ticket.is_empty() || text(&issued, "path") != url.path() {
        return Err(fail(
            502,
            "machine_ws_invalid",
            "这台电脑没有签发有效的实时连接票据",
        ));
    }
    url.set_scheme(if peer.origin.starts_with("https:") {
        "wss"
    } else {
        "ws"
    })
    .map_err(|_| fail(400, "machine_ws_invalid", "实时连接地址无效"))?;
    url.query_pairs_mut().append_pair("ticket", ticket);
    // Resolve and validate now. The host's WebSocket adapter receives only this
    // one-use URL and pinned address, never the durable pairing credential.
    let addresses = network::addresses(&network::origin(&peer.origin)?).await?;
    Ok(result(
        json!({ "url": url.as_str(), "path": path.split('?').next().unwrap(),
        "addresses": addresses.iter().map(|address| json!({ "address": address.ip().to_string(), "family": if address.is_ipv4() { 4 } else { 6 } })).collect::<Vec<_>>() }),
    ))
}

async fn remove(root: &str, input: &Value) -> Result<Value, Error> {
    let peer = peer(root, text(input, "id"))?;
    let revoked = network::request(
        &peer.origin,
        "/api/machines/connection",
        "DELETE",
        ("x-multicc-machine-grant", &peer.grant),
        None,
        &json!({}),
    )
    .await
    .is_ok_and(|response| {
        response["status"]
            .as_u64()
            .is_some_and(|status| (200..300).contains(&status))
    });
    local(root, "remove", input)?;
    Ok(result(json!({ "ok": true, "remoteRevoked": revoked })))
}

pub async fn operate(root: &str, operation: &str, raw: &str) -> String {
    let input: Value = crate::json_lenient::from_str(raw).unwrap_or(Value::Null);
    let response = match operation {
        "add" => add(root, &input).await,
        "proxy" => proxy(root, &input).await,
        "websocket" => websocket(root, &input).await,
        "remove" => remove(root, &input).await,
        _ => local(root, operation, &input),
    };
    response.unwrap_or_else(|e| json!({ "status": e.status, "data": { "ok": false, "code": e.code, "error": e.message, "message": e.message } })).to_string()
}

/// Incremental SSE transport. Each chunk waits for the consumer's acknowledgement
/// so an offline or slow viewer cannot accumulate an unbounded native queue.
pub async fn events<F, Fut>(root: &str, raw: &str, emit: F) -> String
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let response = async {
        let input: Value = crate::json_lenient::from_str(raw).unwrap_or(Value::Null);
        let peer = peer(root, text(&input, "id"))?;
        let path = text(&input, "path");
        if !network::api_path(path) { return Err(fail(403, "machine_path_denied", "此地址不能通过电脑连接访问")); }
        let origin = network::origin(&peer.origin)?;
        let url = origin.join(path).map_err(|_| fail(400, "machine_path_invalid", "电脑请求地址无效"))?;
        let mut response = network::stream_client(&origin).await?.get(url)
            .header("x-multicc-machine-grant", &peer.grant).header("accept", "text/event-stream")
            .send().await.map_err(|e| network::transport_error(&e, "暂时连接不上这台电脑"))?;
        if response.status().is_redirection() { return Err(fail(502, "machine_redirect_rejected", "请使用电脑的最终访问地址")); }
        let headers = json!({ "status": response.status().as_u16(), "headers": {
            "content-type": response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream")
        }});
        if !emit(headers.to_string()).await { return Ok(()); }
        let mut total = 0;
        loop {
            // A quiet stream is not a failed stream: bridges heartbeat every few
            // seconds, so 5 minutes of silence ends the view instead of hanging.
            let chunk = match tokio::time::timeout(Duration::from_secs(300), response.chunk()).await {
                Ok(Ok(Some(chunk))) => chunk,
                Ok(Ok(None)) | Err(_) => break,
                Ok(Err(_)) => return Err(fail(502, "machine_response_incomplete", "电脑实时连接中断")),
            };
            total += chunk.len();
            if total > 48 * 1024 * 1024 || !emit(json!({"body": STANDARD.encode(&chunk)}).to_string()).await { break; }
        }
        Ok::<(), Error>(())
    }.await;
    match response {
        Ok(()) => "{}".into(),
        Err(e) => json!({ "status": e.status, "data": { "code": e.code, "error": e.message } })
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct CertificateFailure;
    impl std::fmt::Display for CertificateFailure {
        fn fmt(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("invalid peer certificate: UnknownIssuer")
        }
    }
    impl std::error::Error for CertificateFailure {}
    #[derive(Debug)]
    struct TransportFailure(CertificateFailure);
    impl std::fmt::Display for TransportFailure {
        fn fmt(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("error sending request")
        }
    }
    impl std::error::Error for TransportFailure {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&self.0)
        }
    }

    #[test]
    fn classifies_certificate_failures_and_pairing_passwords() {
        assert!(network::has_certificate_error(&TransportFailure(
            CertificateFailure
        )));
        assert!(!network::has_certificate_error(&std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "connection refused"
        )));
        let wrong_password = network::response_json_pairing(&json!({ "status": 403 })).unwrap_err();
        assert_eq!(
            (wrong_password.status, wrong_password.code),
            (403, "machine_password_invalid")
        );
        let expired_grant = network::response_json(&json!({ "status": 401 })).unwrap_err();
        assert_eq!(
            (expired_grant.status, expired_grant.code),
            (403, "machine_authorization_required")
        );
        assert!(network::response_json_pairing(
            &json!({ "status": 200, "body": STANDARD.encode("{}") })
        )
        .is_ok());
    }

    #[test]
    fn scopes_reject_recursive_admin_and_ambiguous_paths() {
        for path in [
            "/api/machines/pair",
            "/api/machines/x/proxy/api/air",
            "/api/../auth/exchange",
            "/api/%2e%2e/air",
            "//evil/api/air",
            "/api/air#fragment",
        ] {
            assert!(!network::api_path(path));
        }
        for path in [
            "/api/air",
            "/api/providers",
            "/api/settings",
            "/api/machines/self",
            "/api/air/tasks?query=%E4%B8%AD",
        ] {
            assert!(network::api_path(path));
        }
        assert!(network::ws_path("/ws/chat?session=same-id"));
        assert!(!network::ws_path("/ws/machines/other"));
    }
    #[test]
    fn rejects_credential_urls_and_paths_in_origins() {
        for raw in [
            "file:///tmp/state",
            "https://user:secret@example.org",
            "https://example.org/path",
            "https://example.org/?token=value",
        ] {
            assert!(network::origin(raw).is_err());
        }
        assert!(network::origin("http://127.0.0.1:3000").is_ok());
        assert!(network::origin("https://example.org").is_ok());
    }
    #[test]
    fn identity_grants_rotation_and_revocation_survive_reload() {
        let root = std::env::temp_dir().join(store::random("multicc-machines-test-").unwrap());
        std::fs::create_dir(&root).unwrap();
        let root_str = root.to_str().unwrap();
        let first = local(root_str, "self", &json!({})).unwrap();
        assert_eq!(first, local(root_str, "self", &json!({})).unwrap());
        let paired = local(
            root_str,
            "pair",
            &json!({ "ownerId": "machine_owner", "name": "工作电脑" }),
        )
        .unwrap();
        let secret = text(&paired["data"], "grant");
        assert!(authorize(root_str, secret, "GET", "/api/air").is_some());
        assert!(authorize(root_str, secret, "POST", "/api/machines/pair").is_none());
        assert!(!std::fs::read_to_string(root.join("machines.json"))
            .unwrap()
            .contains(secret));
        local(
            root_str,
            "pair",
            &json!({ "ownerId": "machine_owner", "name": "工作电脑" }),
        )
        .unwrap();
        assert!(authorize(root_str, secret, "GET", "/api/air").is_none());
        let id = local(root_str, "grants", &json!({})).unwrap()["data"]["grants"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(grant_active(root_str, &id));
        local(root_str, "revoke", &json!({ "id": id })).unwrap();
        assert!(!grant_active(root_str, &id));
        std::fs::remove_dir_all(root).unwrap();
    }
}
