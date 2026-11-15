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

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> V {
        V::object(vec![
            ("fleetId", V::string("shared-workspace")),
            ("accessGrant", V::string("grant")),
        ])
    }

    fn request(method: &str, pathname: &str) -> V {
        V::object(vec![
            ("token", V::string("fleet_share_token")),
            ("method", V::string(method)),
            ("pathname", V::string(pathname)),
        ])
    }

    fn allowed(method: &str, pathname: &str) -> bool {
        plan(&record(), &request(method, pathname), false) == V::Bool(true)
    }

    #[test]
    fn directory_paths_are_scoped_to_the_shared_workspace() {
        assert!(allowed("GET", "/api/directories/shared-workspace/sessions"));
        assert!(allowed(
            "HEAD",
            "/api/directories/shared-workspace/workspace"
        ));
        // The decoded parameter is what the scope compares.
        assert!(allowed(
            "GET",
            "/api/directories/shared%2Dworkspace/sessions"
        ));
        // Another workspace is a denial, never a broader match.
        assert!(!allowed("GET", "/api/directories/other-workspace/sessions"));
        // A write under the shared workspace is still a write.
        assert!(allowed(
            "POST",
            "/api/directories/shared-workspace/sessions"
        ));
    }

    #[test]
    fn session_paths_ask_for_live_membership() {
        let planned = plan(&record(), &request("GET", "/api/sessions/s-1"), false);
        assert_eq!(
            planned,
            V::object(vec![
                ("workspaceId", V::string("shared-workspace")),
                ("sessionId", V::string("s-1")),
            ])
        );
        let mut with_members = request("GET", "/api/sessions/s-1");
        put(
            &mut with_members,
            "members",
            V::Array(vec![V::object(vec![("id", V::string("s-1"))])]),
        );
        assert_eq!(resolve(planned, &with_members), V::Bool(true));
        let mut other = request("GET", "/api/sessions/s-2");
        put(
            &mut other,
            "members",
            V::Array(vec![V::object(vec![("id", V::string("s-1"))])]),
        );
        // A different session plans a different id, so the same live member
        // list still refuses it.
        assert_eq!(
            resolve(plan(&record(), &other, false), &other),
            V::Bool(false)
        );
        // Relocation would move a session out of the shared workspace.
        assert!(!allowed("POST", "/api/sessions/s-1/relocate"));
    }

    #[test]
    fn git_reads_require_the_dir_id_query() {
        assert!(allowed(
            "GET",
            "/api/git/log?dirId=shared-workspace&limit=10"
        ));
        assert!(!allowed("GET", "/api/git/log?dirId=other-workspace"));
        assert!(!allowed("GET", "/api/git/commit-files"));
        assert!(!allowed(
            "POST",
            "/api/git/commit-files?dirId=shared-workspace"
        ));
    }

    #[test]
    fn state_reads_are_scoped_to_the_token_in_the_path() {
        assert!(allowed("GET", "/api/fleet-shares/fleet_share_token/state"));
        assert!(!allowed("GET", "/api/fleet-shares/fleet_share_other/state"));
        assert!(!allowed(
            "POST",
            "/api/fleet-shares/fleet_share_token/state"
        ));
    }

    #[test]
    fn only_the_global_read_set_is_shared() {
        for path in [
            "/api/providers",
            "/api/v1/providers",
            "/api/provider-defaults",
            "/api/agent-presets",
            "/api/agent-presets/preset-1",
            "/api/claude/models",
            "/api/qoder/models",
            "/api/opencode/models",
        ] {
            assert!(allowed("GET", path), "{path}");
        }
        assert!(!allowed("GET", "/api/agent-presets/preset-1/foo"));
        assert!(!allowed("GET", "/api/providers/secret"));
        assert!(!allowed("POST", "/api/providers"));
        assert!(!allowed("GET", "/api/server-info"));
        assert!(!allowed("GET", "/api/machines"));
    }

    #[test]
    fn workspace_sockets_are_scoped_unless_the_session_is_a_member() {
        let web_socket = |pathname: &str, extra: Option<(&str, &str)>| {
            let mut input = request(pathname, pathname);
            put(&mut input, "webSocket", V::Bool(true));
            if let Some((key, value)) = extra {
                put(&mut input, key, V::string(value));
            }
            plan(&record(), &input, true)
        };
        assert_eq!(
            web_socket("/ws/workspace", Some(("directoryId", "shared-workspace"))),
            V::Bool(true)
        );
        assert_eq!(
            web_socket("/ws/workspace", Some(("directoryId", "other-workspace"))),
            V::Bool(false)
        );
        assert_eq!(
            web_socket("/ws/chat", Some(("sessionId", "s-1"))),
            V::object(vec![
                ("workspaceId", V::string("shared-workspace")),
                ("sessionId", V::string("s-1")),
            ])
        );
        assert_eq!(web_socket("/ws/meta", None), V::Bool(false));
    }
}
