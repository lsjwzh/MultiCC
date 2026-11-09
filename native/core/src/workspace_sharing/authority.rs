//! Scope decisions use the currently published grant and live membership.
//! A membership request is a host port, never a cached authorization result.
use super::*;
use url::Url;

fn decode(s: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let mut input = s.bytes();
    while let Some(ch) = input.next() {
        if ch == b'%' {
            let a = (input.next()? as char).to_digit(16)?;
            let b = (input.next()? as char).to_digit(16)?;
            bytes.push((a * 16 + b) as u8);
        } else {
            bytes.push(ch);
        }
    }
    String::from_utf8(bytes).ok()
}
pub fn plan(record: &V, input: &V, ws: bool) -> V {
    let workspace = get(record, "fleetId");
    let path = get(input, "pathname");
    if ws {
        if path == &V::string("/ws/workspace") {
            return V::Bool(get(input, "directoryId") == workspace);
        }
        if path != &V::string("/ws/chat") && path != &V::string("/") {
            return false.into();
        }
        return membership(workspace, get(input, "sessionId"));
    }
    let method = if truth(get(input, "method")) {
        text(get(input, "method")).to_uppercase()
    } else {
        "GET".into()
    };
    let Ok(url) = Url::parse("http://multicc.local")
        .unwrap()
        .join(&or_text(path))
    else {
        return false.into();
    };
    let path = url.path();
    if method == "GET" && path == format!("/api/fleet-shares/{}/state", text(get(input, "token"))) {
        return true.into();
    }
    if method == "GET"
        && [
            "/api/git/log",
            "/api/git/commit-files",
            "/api/git/commit-diff",
        ]
        .contains(&path)
    {
        return V::Bool(
            url.query_pairs()
                .find(|(k, _)| k == "dirId")
                .map(|(_, v)| V::string(&v))
                .as_ref()
                == Some(workspace),
        );
    }
    for prefix in ["/api/directories/", "/api/sessions/"] {
        if let Some(tail) = path.strip_prefix(prefix) {
            let (id, remainder) = tail.split_once('/').unwrap_or((tail, ""));
            if id.is_empty() {
                break;
            }
            if prefix == "/api/sessions/" && remainder == "relocate" {
                return false.into();
            }
            let Some(id) = decode(id) else {
                return false.into();
            };
            return if prefix == "/api/directories/" {
                V::Bool(&V::string(&id) == workspace)
            } else {
                membership(workspace, &V::string(&id))
            };
        }
    }
    if method != "GET" {
        return false.into();
    }
    V::Bool(
        [
            "/api/providers",
            "/api/v1/providers",
            "/api/provider-defaults",
            "/api/agent-presets",
            "/api/claude/models",
            "/api/qoder/models",
            "/api/opencode/models",
        ]
        .contains(&path)
            || path
                .strip_prefix("/api/agent-presets/")
                .is_some_and(|p| !p.is_empty() && !p.contains('/')),
    )
}
fn membership(workspace: &V, session: &V) -> V {
    V::object(vec![
        ("workspaceId", workspace.clone()),
        ("sessionId", session.clone()),
    ])
}
pub fn resolve(plan: V, input: &V) -> V {
    if matches!(plan, V::Bool(_)) {
        return plan;
    }
    V::Bool(
        array(get(input, "members"))
            .iter()
            .any(|s| get(s, "id") == get(&plan, "sessionId")),
    )
}
