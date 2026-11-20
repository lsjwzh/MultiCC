use std::net::IpAddr;
use std::path::Path;

use axum::{body::Body, http::Request};
use multicc_core::auth_runtime::{self, Request as AuthRequest, Response as AuthResponse};
use multicc_core::auth_security;
use multicc_core::http_gate::{self, NodeHeaders};
use multicc_core::network_policy::env_enabled;
use multicc_core::ws_admission::{self, Facts, ShareAccess};
use serde_json::Value;

use crate::app::App;
use crate::ws_chat::PATH;

pub struct ConnectionRequest {
    pub session: Option<String>,
    pub shell: Option<String>,
    pub archive: bool,
    peer: IpAddr,
    headers: NodeHeaders,
    query: Vec<(String, String)>,
}

impl ConnectionRequest {
    pub fn new(request: &Request<Body>, peer: IpAddr) -> Self {
        let query: Vec<_> =
            url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
                .into_owned()
                .collect();
        let get = |field| param(&query, field).map(ToOwned::to_owned);
        Self {
            session: get("session"),
            shell: get("shell").filter(|value| !value.is_empty()),
            archive: get("historyScope").as_deref() == Some("archive"),
            peer,
            headers: NodeHeaders::from_raw(
                request
                    .headers()
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.as_bytes())),
            ),
            query,
        }
    }

    pub async fn facts(&self, app: &App) -> Facts {
        let peer = self.peer.to_string();
        let get = |field| param(&self.query, field);
        let cookies = http_gate::parse_cookies(self.headers.get("cookie"));
        let cookie = cookies
            .get("multicc_auth")
            .filter(|value| !value.is_empty());
        let snapshot = if app.auth.has_local() {
            app.auth.snapshot().await.ok()
        } else {
            None
        };
        let secret = snapshot.as_ref().map_or("", |value| value.secret.as_str());
        let now = auth_runtime::now_ms();
        let mut facts = Facts {
            shutting_down: snapshot.as_ref().is_some_and(|value| value.shutting_down),
            peer_allowed: !app.lan_only || http_gate::is_private_network_address(&peer),
            path: PATH.into(),
            share_param: get("share").unwrap_or("").into(),
            session_param: self.session.clone(),
            addressed_session_id: self.session.clone(),
            local: http_gate::is_local_request(&peer, &self.headers),
            access_token: !secret.is_empty(),
            has_ticket_param: get("ticket").is_some(),
            allow_legacy_cookie: flag("MULTICC_ALLOW_LEGACY_WS_COOKIE"),
            allow_legacy_token: flag("MULTICC_ALLOW_LEGACY_WS_TOKEN"),
            auth_cookie: cookie.is_some(),
            cookie_valid: cookie
                .is_some_and(|value| auth_security::verify_cookie(secret, value, now as i64)),
            token_valid: auth_security::verify_access_token(secret, get("token")),
            machines_present: true,
            ip: Some(peer),
            ..Facts::default()
        };
        if ws_admission::needs_share_record(&facts) {
            let file = app.data_root.join("shares.json");
            let token = facts.share_param.clone();
            let cookie = cookies.get(&format!("multicc_share_{token}")).cloned();
            facts.share_access = tokio::task::spawn_blocking(move || {
                read_share(&file, &token, cookie.as_deref(), now)
            })
            .await
            .ok()
            .flatten();
        }
        if app.auth.has_local() && ws_admission::needs_ticket(&facts) {
            let request = AuthRequest::ConsumeTicket {
                ticket: get("ticket").unwrap_or("").into(),
                path: PATH.into(),
            };
            if let Ok(AuthResponse::Redeemed { metadata, .. }) = app.auth.request(request).await {
                facts.consumed_ticket = ws_admission::ticket_from(&metadata);
            }
            if let Some(id) = facts
                .consumed_ticket
                .as_ref()
                .map(|ticket| &ticket.machine_grant_id)
                .filter(|id| !id.is_empty())
            {
                let root = app.data_root.to_string_lossy().into_owned();
                let id = id.clone();
                facts.machine_active = tokio::task::spawn_blocking(move || {
                    multicc_core::machines::grant_active(&root, &id)
                })
                .await
                .unwrap_or(false);
            }
        }
        facts
    }
}

fn param<'a>(query: &'a [(String, String)], key: &str) -> Option<&'a str> {
    query
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
}

fn flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| env_enabled(&value))
}

fn read_share(file: &Path, token: &str, cookie: Option<&str>, now: f64) -> Option<ShareAccess> {
    let json = std::fs::read(file).ok()?;
    let document: Value = serde_json::from_slice(&json).ok()?;
    let record = document.get(token)?;
    let access = record["access"].as_str()?;
    if !matches!(access, "view" | "operate")
        || record["type"] == "messages"
        || record["expiresAt"]
            .as_f64()
            .is_some_and(|expiry| expiry != 0.0 && now > expiry)
    {
        return None;
    }
    let password = record["pwHash"]
        .as_str()
        .is_some_and(|hash| !hash.is_empty());
    if password || access == "operate" {
        let secret = record["secret"].as_str()?;
        if !password || !auth_security::verify_session_share_cookie(secret, token, cookie?) {
            return None;
        }
    }
    Some(ShareAccess {
        session_id: Some(record["sessionId"].as_str()?.to_owned()),
        access: access.to_owned(),
    })
}
