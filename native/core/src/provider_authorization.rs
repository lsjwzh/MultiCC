//! Verify the existing CPR capability format without forwarding the capability
//! to an upstream. Issuance remains interoperable with the CLI's CPR SDK.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("").trim()
}
fn valid(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}
fn normalize(v: &Value) -> Option<Value> {
    let cli = text(v, "cli").to_ascii_lowercase();
    let provider = text(v, "providerId");
    let session = text(v, "sessionId");
    if !valid(&cli) || !valid(provider) || !valid(session) {
        return None;
    }
    let raw = ["routeName", "agentRole", "role"]
        .iter()
        .map(|k| text(v, k))
        .find(|s| !s.is_empty())
        .unwrap_or("main")
        .to_ascii_lowercase();
    let (kind, agent, name) = match raw.as_str() {
        "main" => ("main", "", "main"),
        "aux" => ("aux", "", "aux"),
        "sub" => ("sub", "default", "default"),
        s if !s.is_empty()
            && s.len() <= 64
            && s.as_bytes()[0].is_ascii_lowercase()
            && s.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"_-".contains(&c)) =>
        {
            (
                "sub",
                if ["default", "worker", "explorer"].contains(&s) {
                    s
                } else {
                    "custom"
                },
                s,
            )
        }
        _ => return None,
    };
    let kind = if text(v, "roleKind").is_empty() {
        kind.to_owned()
    } else {
        text(v, "roleKind").to_ascii_lowercase()
    };
    if !["main", "sub", "aux"].contains(&kind.as_str()) {
        return None;
    }
    let agent = if kind != "sub" {
        String::new()
    } else if text(v, "agentRole").is_empty() {
        agent.to_owned()
    } else {
        text(v, "agentRole").to_ascii_lowercase()
    };
    let name = if kind != "sub" {
        kind.clone()
    } else if text(v, "routeName").is_empty() {
        name.to_owned()
    } else {
        text(v, "routeName").to_ascii_lowercase()
    };
    if (kind == "sub" && !valid(&agent)) || !valid(&name) {
        return None;
    }
    Some(
        json!({"cli":cli,"providerId":provider,"sessionId":session,"roleKind":kind,"agentRole":agent,"routeName":name}),
    )
}
fn token(headers: &Value) -> &str {
    let auth = text(headers, "authorization");
    let auth = if auth.is_empty() {
        text(headers, "Authorization")
    } else {
        auth
    };
    if let Some((scheme, value)) = auth.split_once(char::is_whitespace) {
        if scheme.eq_ignore_ascii_case("bearer") && !value.trim().is_empty() {
            return value.trim();
        }
    }
    let key = text(headers, "x-api-key");
    if key.is_empty() {
        text(headers, "X-Api-Key")
    } else {
        key
    }
}
pub fn authorize(input: &Value) -> Result<Value, String> {
    let route = &input["route"];
    let required =
        input["requireManaged"] == true || text(route, "sessionId").starts_with("direct-");
    let Some(route) = normalize(route) else {
        return Ok(if required {
            json!({"ok":false,"managed":false,"reason":"invalid-route"})
        } else {
            json!({"ok":true,"managed":false,"reason":"legacy-unmanaged-route"})
        });
    };
    let document = crate::provider_store::read(Path::new(text(input, "file")))?
        .unwrap_or_else(|| json!({"version":1,"credentials":[]}));
    if document["version"] != 1 || !document["credentials"].is_array() {
        return Err("HOP_CREDENTIAL_INVALID_SCHEMA".into());
    }
    let fields = [
        "cli",
        "providerId",
        "sessionId",
        "roleKind",
        "agentRole",
        "routeName",
    ];
    let key = fields
        .iter()
        .map(|k| text(&route, k))
        .collect::<Vec<_>>()
        .join("|");
    let mut matches: Vec<_> = document["credentials"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["routeKey"] == key)
        .collect();
    matches.sort_by(|a, b| {
        b["issuedAt"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&a["issuedAt"].as_f64().unwrap_or(0.0))
    });
    let revoked = |r: &&Value| {
        !r["revokedAt"].is_null()
            && r["revokedAt"] != 0
            && r["revokedAt"] != false
            && r["revokedAt"] != ""
    };
    let Some(active) = matches
        .iter()
        .find(|r| !revoked(r))
        .or_else(|| matches.first())
    else {
        return Ok(
            json!({"ok":!required,"managed":false,"reason":if required {"unmanaged-route"} else {"legacy-unmanaged-route"}}),
        );
    };
    let token = token(&input["headers"]);
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    let expected = text(active, "tokenHash");
    let equal = expected.len() == hash.len()
        && expected
            .bytes()
            .zip(hash.bytes())
            .fold(0u8, |n, (a, b)| n | (a ^ b))
            == 0;
    let reason = if revoked(active) {
        "revoked"
    } else if active["expiresAt"].as_f64().unwrap_or(0.0) <= input["now"].as_f64().unwrap_or(0.0) {
        "expired"
    } else if token.is_empty() {
        "missing"
    } else if equal {
        "valid"
    } else {
        "mismatch"
    };
    Ok(json!({"ok":reason == "valid","managed":true,"reason":reason,"credentialId":active["id"]}))
}
