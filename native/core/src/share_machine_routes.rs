//! Path matching for the sharing / machines / workspaces route cluster retired
//! from `src/machines.js`, `src/routes/share.js` and `src/routes/workspaces.js`:
//!
//! * `GET|HEAD             /api/machines`
//! * `GET|HEAD             /api/machines/self`
//! * `GET|HEAD             /api/machines/grants`
//! * `POST                 /api/machines/pair`
//! * `DELETE               /api/machines/connection`
//! * `DELETE               /api/machines/grants/:grantId`
//! * `POST                 /api/machines`
//! * `PATCH|DELETE         /api/machines/:machineId`
//! * `POST                 /api/machines/:machineId/ws-ticket`
//! * `POST                 /api/sessions/:id/share`
//! * `GET|HEAD             /api/sessions/:id/shares`
//! * `DELETE               /api/sessions/:id/share/:token`
//! * `POST                 /api/sessions/:id/share-messages`
//! * `GET|HEAD             /share/:token`
//! * `POST                 /api/share/:token/auth`
//! * `GET|HEAD             /api/share/:token/{entry,history,session}`
//! * `GET|HEAD             /api/workspaces/overview`
//! * `POST                 /api/workspaces/sweep`
//!
//! Everything that is pure decision-making lives here: literal segments matched
//! case-insensitively, parameters as `[^/]+?`, one optional trailing slash, and
//! the automatic `OPTIONS` `Allow` union in registration order with `HEAD`
//! right after each `GET`. Nothing reads a clock or the filesystem.
//!
//! Two path families are special and are handled explicitly:
//!
//! * `/share/:token` is the only claimed path **outside** `/api/`. It is also
//!   one of the share surface's token-authority routes: no access token or
//!   cookie is required, the token itself (plus its password cookie) is the
//!   whole authority. Node's `httpEntry` public-path regex exempts it from the
//!   auth gate for every method, and the front door reuses that same predicate
//!   (`multicc_core::http_entry::public_path`) rather than a second rule.
//! * `/api/machines/:machineId/proxy` is deliberately **not** claimed: the raw
//!   multipart/binary (and SSE) proxy stays whole in Node, so every method —
//!   including its automatic-`OPTIONS` replacement, the `app.use` layer that
//!   answered any method on that path — is forwarded untouched.
//!
//! The `Allow` values are not guesses: they were measured against the running
//! Express stack and the same-segment collisions are reproduced here because
//! Express unions the methods of *every* matching layer:
//!
//! * `/api/machines/self` → `GET,HEAD,PATCH,DELETE` (`:machineId` also matches)
//! * `/api/machines/grants` → `GET,HEAD,PATCH,DELETE` (same)
//! * `/api/machines/pair` → `POST,PATCH,DELETE` (same)
//! * `/api/machines/connection` → `DELETE,PATCH` (same)
//! * `/api/machines/grants/ws-ticket` → `DELETE,POST`
//!
//! `claim()` still picks the *handler* Express would have picked: first match in
//! registration order, so `PATCH /api/machines/self` is a rename of the machine
//! literally named `self`, and `DELETE /api/machines/grants` a removal of the
//! machine named `grants`, exactly as before.

/// One claimed route. `Options` is Express's automatic responder for a path
/// this cluster registers; `allow` is the whole-path `Allow` value and
/// `guard_segment` names the `:id` segment the
/// `publicSessionAccessGuard` `app.use` layer observes before it (the four
/// `/api/sessions/:id/…` share routes only).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    MachinesList,
    MachinesSelf,
    MachinesGrants,
    MachinesPair,
    MachinesConnectionDelete,
    MachinesGrantRevoke,
    MachinesAdd,
    MachinesRename,
    MachinesDelete,
    MachinesWsTicket,
    SessionShareCreate,
    SessionSharesList,
    SessionShareRevoke,
    SessionMessageShare,
    SharePage,
    ShareAuth,
    ShareEntry,
    ShareHistory,
    ShareSession,
    WorkspacesOverview,
    WorkspacesSweep,
    Options {
        allow: &'static str,
        guard_segment: Option<usize>,
    },
}

impl Route {
    /// The host-port operation the front door asks Node for. `Options` never
    /// reaches the host.
    pub fn op(self) -> Option<&'static str> {
        Some(match self {
            Route::MachinesList => "machines-list",
            Route::MachinesSelf => "machines-self",
            Route::MachinesGrants => "machines-grants",
            Route::MachinesPair => "machines-pair",
            Route::MachinesConnectionDelete => "machines-connection-delete",
            Route::MachinesGrantRevoke => "machines-grant-revoke",
            Route::MachinesAdd => "machines-add",
            Route::MachinesRename => "machines-rename",
            Route::MachinesDelete => "machines-remove",
            Route::MachinesWsTicket => "machines-ws-ticket",
            Route::SessionShareCreate => "session-share-create",
            Route::SessionSharesList => "session-shares-list",
            Route::SessionShareRevoke => "session-share-revoke",
            Route::SessionMessageShare => "session-share-messages",
            Route::ShareAuth => "share-auth",
            Route::ShareEntry => "share-entry",
            Route::ShareHistory => "share-history",
            Route::ShareSession => "share-session",
            Route::WorkspacesOverview => "workspaces-overview",
            Route::WorkspacesSweep => "workspaces-sweep",
            Route::SharePage | Route::Options { .. } => return None,
        })
    }

    /// Whether the retired handler mutates process state (the machine registry
    /// and its grants, a share record, the workspace hibernation store, or the
    /// WS-ticket table). Those are serialized behind the cluster write lock so
    /// the single-threaded Node semantics survive.
    pub fn is_write(self) -> bool {
        matches!(
            self,
            Route::MachinesPair
                | Route::MachinesConnectionDelete
                | Route::MachinesGrantRevoke
                | Route::MachinesAdd
                | Route::MachinesRename
                | Route::MachinesDelete
                | Route::MachinesWsTicket
                | Route::SessionShareCreate
                | Route::SessionShareRevoke
                | Route::SessionMessageShare
                | Route::WorkspacesSweep
        )
    }

    /// Whether the retired mount ran `express.json({limit:'16kb'})` on this
    /// route. The machines cluster was mounted *before* the global
    /// `express.json({limit:'50mb'})`, so its own parser is the only one those
    /// paths saw — and two of them (`DELETE /api/machines/connection`,
    /// `DELETE /api/machines/grants/:grantId`) registered no parser at all.
    pub fn body_parser(self) -> BodyParser {
        match self {
            Route::MachinesConnectionDelete | Route::MachinesGrantRevoke => BodyParser::None,
            Route::MachinesList
            | Route::MachinesSelf
            | Route::MachinesGrants
            | Route::MachinesPair
            | Route::MachinesAdd
            | Route::MachinesRename
            | Route::MachinesDelete
            | Route::MachinesWsTicket => BodyParser::Json16k,
            _ => BodyParser::Global,
        }
    }

    /// The path parameters this route carries, as `(name, segment index)`
    /// relative to [`segments`] (i.e. after the `/api/` prefix). The front door
    /// percent-decodes each one before handing it to the host port — Express
    /// decoded `req.params` the same way.
    pub fn params(self) -> &'static [(&'static str, usize)] {
        match self {
            Route::MachinesGrantRevoke => &[("grantId", 2)],
            Route::MachinesRename | Route::MachinesDelete | Route::MachinesWsTicket => {
                // `/api/machines/:machineId` — the id is the second segment.
                &[("machineId", 1)]
            }
            Route::SessionShareCreate | Route::SessionSharesList | Route::SessionMessageShare => {
                &[("id", 1)]
            }
            Route::SessionShareRevoke => &[("id", 1), ("token", 3)],
            Route::ShareAuth | Route::ShareEntry | Route::ShareHistory | Route::ShareSession => {
                &[("token", 1)]
            }
            _ => &[],
        }
    }
}

/// What the retired route did with a request body before its handler ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyParser {
    /// No JSON parser: the handler never read `req.body`.
    None,
    /// The cluster's own `express.json({limit:'16kb'})`.
    Json16k,
    /// The global `express.json({limit:'50mb'})`.
    Global,
}

struct Layer {
    segs: &'static [&'static str],
    method: &'static str,
    kind: Route,
}

/// Registration order of the retired mounts in `server.js`: `machines.mount`,
/// then `mountShareRoutes`, then `mountWorkspaceRoutes`. Order fixes the
/// `Allow` union (`DELETE,PATCH`, `DELETE,POST`, …) and the handler Express
/// picked for a same-segment collision.
static LAYERS: &[Layer] = &[
    Layer {
        segs: &["machines"],
        method: "GET",
        kind: Route::MachinesList,
    },
    Layer {
        segs: &["machines", "self"],
        method: "GET",
        kind: Route::MachinesSelf,
    },
    Layer {
        segs: &["machines", "grants"],
        method: "GET",
        kind: Route::MachinesGrants,
    },
    Layer {
        segs: &["machines", "pair"],
        method: "POST",
        kind: Route::MachinesPair,
    },
    Layer {
        segs: &["machines", "connection"],
        method: "DELETE",
        kind: Route::MachinesConnectionDelete,
    },
    Layer {
        segs: &["machines", "grants", ":grantId"],
        method: "DELETE",
        kind: Route::MachinesGrantRevoke,
    },
    Layer {
        segs: &["machines"],
        method: "POST",
        kind: Route::MachinesAdd,
    },
    Layer {
        segs: &["machines", ":machineId"],
        method: "PATCH",
        kind: Route::MachinesRename,
    },
    Layer {
        segs: &["machines", ":machineId"],
        method: "DELETE",
        kind: Route::MachinesDelete,
    },
    Layer {
        segs: &["machines", ":machineId", "ws-ticket"],
        method: "POST",
        kind: Route::MachinesWsTicket,
    },
    Layer {
        segs: &["sessions", ":id", "share"],
        method: "POST",
        kind: Route::SessionShareCreate,
    },
    Layer {
        segs: &["sessions", ":id", "shares"],
        method: "GET",
        kind: Route::SessionSharesList,
    },
    Layer {
        segs: &["sessions", ":id", "share", ":token"],
        method: "DELETE",
        kind: Route::SessionShareRevoke,
    },
    Layer {
        segs: &["sessions", ":id", "share-messages"],
        method: "POST",
        kind: Route::SessionMessageShare,
    },
    Layer {
        segs: &["share", ":token", "auth"],
        method: "POST",
        kind: Route::ShareAuth,
    },
    Layer {
        segs: &["share", ":token", "entry"],
        method: "GET",
        kind: Route::ShareEntry,
    },
    Layer {
        segs: &["share", ":token", "history"],
        method: "GET",
        kind: Route::ShareHistory,
    },
    Layer {
        segs: &["share", ":token", "session"],
        method: "GET",
        kind: Route::ShareSession,
    },
    Layer {
        segs: &["workspaces", "overview"],
        method: "GET",
        kind: Route::WorkspacesOverview,
    },
    Layer {
        segs: &["workspaces", "sweep"],
        method: "POST",
        kind: Route::WorkspacesSweep,
    },
];

/// `path` → its segments after `/api/`, or `None` when this cluster cannot own
/// the path. One optional trailing slash is removed, as Express tolerated; a
/// doubled or interior empty segment is not a match.
pub fn segments(path: &str) -> Option<Vec<&str>> {
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

/// `path` → the two segments of the public share page (`/share/:token`). Only
/// the exact `/share/` prefix counts; the literal is matched
/// case-insensitively like every other Express literal.
pub fn page_segments(path: &str) -> Option<Vec<&str>> {
    let rest = path.strip_prefix('/')?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    parts[0].eq_ignore_ascii_case("share").then_some(parts)
}

/// Route paths are matched case-insensitively by Express's default router; a
/// `:param` segment matches any non-empty segment.
fn layer_matches(layer: &Layer, parts: &[&str]) -> bool {
    layer.segs.len() == parts.len()
        && layer
            .segs
            .iter()
            .zip(parts)
            .all(|(name, part)| match name.strip_prefix(':') {
                Some(_) => !part.is_empty(),
                None => part.eq_ignore_ascii_case(name),
            })
}

/// The matcher. `GET` and `HEAD` share every read route (Express answers HEAD
/// from the GET handler); `OPTIONS` is the automatic responder for any path
/// this cluster registers.
pub fn claim(method: &str, path: &str) -> Option<Route> {
    if page_segments(path).is_some() {
        return match method.to_ascii_uppercase().as_str() {
            "GET" | "HEAD" => Some(Route::SharePage),
            "OPTIONS" => Some(Route::Options {
                allow: "GET,HEAD",
                guard_segment: None,
            }),
            _ => None,
        };
    }
    let parts = segments(path)?;
    if method.eq_ignore_ascii_case("OPTIONS") {
        let allow = allow_for(path)?;
        return Some(Route::Options {
            allow: intern(&allow),
            guard_segment: guard_index(&parts),
        });
    }
    let wanted = if method.eq_ignore_ascii_case("HEAD") {
        "GET"
    } else {
        method
    };
    LAYERS
        .iter()
        .find(|layer| layer.method.eq_ignore_ascii_case(wanted) && layer_matches(layer, &parts))
        .map(|layer| layer.kind)
}

/// The `:id` segment `publicSessionAccessGuard` observes before the four
/// `/api/sessions/:id/…` share routes (and before their `OPTIONS`).
pub fn guard_index(parts: &[&str]) -> Option<usize> {
    if parts.len() >= 2 && parts[0].eq_ignore_ascii_case("sessions") {
        Some(1)
    } else {
        None
    }
}

/// Every `Allow` string [`LAYERS`] can produce, so [`Route::Options`] can keep
/// a `&'static str` (the front door's route enum stays `Copy`). The exhaustive
/// test below walks the whole registration table.
const ALLOWS: &[&str] = &[
    "GET,HEAD",
    "POST",
    "DELETE",
    "PATCH,DELETE",
    "GET,HEAD,POST",
    "DELETE,PATCH",
    "POST,PATCH,DELETE",
    "GET,HEAD,PATCH,DELETE",
    "DELETE,POST",
];

fn intern(allow: &str) -> &'static str {
    ALLOWS
        .iter()
        .copied()
        .find(|candidate| *candidate == allow)
        .unwrap_or("")
}

/// Express's automatic OPTIONS `Allow` value for `path`: the union of the
/// methods registered on this exact path in registration order, each `GET`
/// followed by `HEAD`.
pub fn allow_for(path: &str) -> Option<String> {
    if page_segments(path).is_some() {
        return Some("GET,HEAD".to_string());
    }
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

/// This cluster's share of Express's automatic `OPTIONS` `Allow` for the
/// front-door union across clusters (`super::OPTIONS_SOURCES`).
pub fn options_share(path: &str) -> Option<String> {
    allow_for(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(method: &str, path: &str) -> Option<Route> {
        claim(method, path)
    }

    #[test]
    fn claims_every_route() {
        use Route::*;
        let cases = [
            ("GET", "/api/machines", MachinesList),
            ("HEAD", "/api/machines", MachinesList),
            ("GET", "/api/machines/self", MachinesSelf),
            ("GET", "/api/machines/grants", MachinesGrants),
            ("POST", "/api/machines/pair", MachinesPair),
            (
                "DELETE",
                "/api/machines/connection",
                MachinesConnectionDelete,
            ),
            ("DELETE", "/api/machines/grants/g1", MachinesGrantRevoke),
            ("POST", "/api/machines", MachinesAdd),
            ("PATCH", "/api/machines/m1", MachinesRename),
            ("DELETE", "/api/machines/m1", MachinesDelete),
            ("POST", "/api/machines/m1/ws-ticket", MachinesWsTicket),
            ("POST", "/api/sessions/s1/share", SessionShareCreate),
            ("GET", "/api/sessions/s1/shares", SessionSharesList),
            ("DELETE", "/api/sessions/s1/share/t1", SessionShareRevoke),
            (
                "POST",
                "/api/sessions/s1/share-messages",
                SessionMessageShare,
            ),
            ("GET", "/share/t1", SharePage),
            ("HEAD", "/share/t1", SharePage),
            ("POST", "/api/share/t1/auth", ShareAuth),
            ("GET", "/api/share/t1/entry", ShareEntry),
            ("GET", "/api/share/t1/history", ShareHistory),
            ("GET", "/api/share/t1/session", ShareSession),
            ("GET", "/api/workspaces/overview", WorkspacesOverview),
            ("POST", "/api/workspaces/sweep", WorkspacesSweep),
        ];
        for (method, path, expected) in cases {
            assert_eq!(route(method, path), Some(expected), "{method} {path}");
        }
    }

    #[test]
    fn ops_are_unique_and_options_has_none() {
        let mut seen = Vec::new();
        for layer in LAYERS {
            let op = layer.kind.op().expect("every layer has an op");
            assert!(!seen.contains(&op), "duplicate op {op}");
            seen.push(op);
        }
        assert_eq!(seen.len(), 20);
        assert_eq!(Route::SharePage.op(), None);
        assert_eq!(
            Route::Options {
                allow: "GET,HEAD",
                guard_segment: None
            }
            .op(),
            None
        );
    }

    #[test]
    fn head_follows_get_only_on_read_routes() {
        assert_eq!(route("HEAD", "/api/machines"), Some(Route::MachinesList));
        assert_eq!(route("HEAD", "/share/t1"), Some(Route::SharePage));
        assert_eq!(
            route("HEAD", "/api/share/t1/entry"),
            Some(Route::ShareEntry)
        );
        // No HEAD handler where Express registered none.
        assert_eq!(route("HEAD", "/api/machines/pair"), None);
        assert_eq!(route("HEAD", "/api/sessions/s1/share"), None);
        assert_eq!(route("HEAD", "/api/workspaces/sweep"), None);
    }

    #[test]
    fn the_proxy_route_is_not_claimed_for_any_method() {
        // The raw/SSE proxy stays whole in Node: its `app.use` layer answered
        // every method, including OPTIONS, so the front door forwards it.
        for method in ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"] {
            assert_eq!(route(method, "/api/machines/m1/proxy"), None, "{method}");
        }
        assert_eq!(allow_for("/api/machines/m1/proxy"), None);
    }

    #[test]
    fn unclaimed_paths_stay_with_their_owner() {
        for (method, path) in [
            ("GET", "/api/machines/m1/proxy"),
            ("GET", "/api/sessions/s1"),
            ("GET", "/api/sessions/s1/share/t1"),
            ("GET", "/api/share/t1"),
            ("GET", "/share"),
            ("GET", "/share/a/b"),
            ("GET", "/shares/t1"),
            ("GET", "/api/workspaces"),
            ("GET", "/api/workspaces/overview/extra"),
            ("POST", "/api/machines/m1/ws-ticket/extra"),
            ("GET", "/api/machines/grants/g1"),
        ] {
            assert_eq!(route(method, path), None, "{method} {path}");
        }
    }

    #[test]
    fn the_share_page_is_claims_only_its_two_segments() {
        assert_eq!(route("GET", "/share/t1"), Some(Route::SharePage));
        assert_eq!(route("GET", "/share/t1/"), Some(Route::SharePage));
        assert_eq!(route("GET", "/SHARE/T1"), Some(Route::SharePage));
        assert_eq!(route("GET", "/shared/t1"), None);
        assert_eq!(route("POST", "/share/t1"), None);
        assert_eq!(
            route("OPTIONS", "/share/t1"),
            Some(Route::Options {
                allow: "GET,HEAD",
                guard_segment: None
            })
        );
    }

    #[test]
    fn trailing_slash_is_tolerated_and_interior_empty_is_not() {
        assert_eq!(route("GET", "/api/machines/"), Some(Route::MachinesList));
        assert_eq!(
            route("GET", "/api/machines/self/"),
            Some(Route::MachinesSelf)
        );
        assert_eq!(route("GET", "/api/machines//"), None);
        assert_eq!(route("GET", "/api//machines"), None);
        assert_eq!(route("GET", "/api/machines//self"), None);
    }

    #[test]
    fn literals_are_case_insensitive_and_params_match_any_non_empty_segment() {
        assert_eq!(
            route("GET", "/API/machines"),
            None,
            "prefix is case-sensitive"
        );
        assert_eq!(route("GET", "/api/MACHINES"), Some(Route::MachinesList));
        assert_eq!(
            route("GET", "/api/Machines/SELF"),
            Some(Route::MachinesSelf)
        );
        assert_eq!(
            route("POST", "/api/sessions/S1/SHARE-MESSAGES"),
            Some(Route::SessionMessageShare)
        );
        assert_eq!(route("GET", "/share/a%20b"), Some(Route::SharePage));
        assert_eq!(
            route("GET", "/api/share/a%2Fb/entry"),
            Some(Route::ShareEntry)
        );
    }

    #[test]
    fn same_segment_collisions_disambiguate_by_literal_tail_and_method() {
        // `:machineId` also matches these literals, so both handlers exist and
        // Express picks by method; the measured Allow unions both.
        assert_eq!(
            route("PATCH", "/api/machines/self"),
            Some(Route::MachinesRename)
        );
        assert_eq!(
            route("DELETE", "/api/machines/grants"),
            Some(Route::MachinesDelete)
        );
        assert_eq!(
            route("DELETE", "/api/machines/pair"),
            Some(Route::MachinesDelete)
        );
        assert_eq!(
            route("PATCH", "/api/machines/pair"),
            Some(Route::MachinesRename)
        );
        // `ws-ticket` as the machine id: the literal tail route wins.
        assert_eq!(
            route("POST", "/api/machines/grants/ws-ticket"),
            Some(Route::MachinesWsTicket)
        );
        // `share` vs `shares` vs `share-messages` are distinct literals.
        assert_eq!(
            route("POST", "/api/sessions/s1/share"),
            Some(Route::SessionShareCreate)
        );
        assert_eq!(
            route("GET", "/api/sessions/s1/shares"),
            Some(Route::SessionSharesList)
        );
        assert_eq!(
            route("POST", "/api/sessions/s1/share-messages"),
            Some(Route::SessionMessageShare)
        );
        assert_eq!(
            route("DELETE", "/api/sessions/s1/share/t1"),
            Some(Route::SessionShareRevoke)
        );
    }

    #[test]
    fn allow_union_matches_the_measured_express_values() {
        // Measured against the real Express stack (all layers mounted).
        let measured = [
            ("/api/machines", "GET,HEAD,POST"),
            ("/api/machines/self", "GET,HEAD,PATCH,DELETE"),
            ("/api/machines/grants", "GET,HEAD,PATCH,DELETE"),
            ("/api/machines/pair", "POST,PATCH,DELETE"),
            ("/api/machines/connection", "DELETE,PATCH"),
            ("/api/machines/grants/g1", "DELETE"),
            ("/api/machines/m1", "PATCH,DELETE"),
            ("/api/machines/m1/ws-ticket", "POST"),
            ("/api/machines/grants/ws-ticket", "DELETE,POST"),
            ("/api/sessions/s1/share", "POST"),
            ("/api/sessions/s1/shares", "GET,HEAD"),
            ("/api/sessions/s1/share/t1", "DELETE"),
            ("/api/sessions/s1/share-messages", "POST"),
            ("/share/t1", "GET,HEAD"),
            ("/api/share/t1/auth", "POST"),
            ("/api/share/t1/entry", "GET,HEAD"),
            ("/api/share/t1/history", "GET,HEAD"),
            ("/api/share/t1/session", "GET,HEAD"),
            ("/api/workspaces/overview", "GET,HEAD"),
            ("/api/workspaces/sweep", "POST"),
        ];
        for (path, allow) in measured {
            assert_eq!(allow_for(path).as_deref(), Some(allow), "{path}");
        }
        assert_eq!(allow_for("/api/machines/m1/proxy"), None);
        assert_eq!(allow_for("/api/sessions/s1"), None);
    }

    #[test]
    fn options_is_claimed_for_every_registered_path() {
        for path in [
            "/api/machines",
            "/api/machines/self",
            "/api/machines/grants",
            "/api/machines/pair",
            "/api/machines/connection",
            "/api/machines/grants/g1",
            "/api/machines/m1",
            "/api/machines/m1/ws-ticket",
            "/api/sessions/s1/share",
            "/api/sessions/s1/shares",
            "/api/sessions/s1/share/t1",
            "/api/sessions/s1/share-messages",
            "/share/t1",
            "/api/share/t1/auth",
            "/api/share/t1/entry",
            "/api/share/t1/history",
            "/api/share/t1/session",
            "/api/workspaces/overview",
            "/api/workspaces/sweep",
        ] {
            match route("OPTIONS", path) {
                Some(Route::Options { allow, .. }) => {
                    assert_eq!(Some(allow), allow_for(path).as_deref(), "{path}")
                }
                other => panic!("{path}: {other:?}"),
            }
        }
    }

    #[test]
    fn the_guard_segment_is_the_share_id_only() {
        for path in [
            "/api/sessions/s1/share",
            "/api/sessions/s1/shares",
            "/api/sessions/s1/share/t1",
            "/api/sessions/s1/share-messages",
        ] {
            match route("OPTIONS", path) {
                Some(Route::Options { guard_segment, .. }) => {
                    assert_eq!(guard_segment, Some(1), "{path}")
                }
                other => panic!("{path}: {other:?}"),
            }
        }
        for path in ["/api/machines", "/api/share/t1/entry", "/share/t1"] {
            match route("OPTIONS", path) {
                Some(Route::Options { guard_segment, .. }) => {
                    assert_eq!(guard_segment, None, "{path}")
                }
                other => panic!("{path}: {other:?}"),
            }
        }
    }

    #[test]
    fn params_index_the_decoded_segments() {
        assert_eq!(Route::MachinesRename.params(), &[("machineId", 1)]);
        assert_eq!(Route::MachinesWsTicket.params(), &[("machineId", 1)]);
        assert_eq!(Route::MachinesGrantRevoke.params(), &[("grantId", 2)]);
        assert_eq!(
            Route::SessionShareRevoke.params(),
            &[("id", 1), ("token", 3)]
        );
        assert_eq!(Route::ShareHistory.params(), &[("token", 1)]);
        assert_eq!(Route::SharePage.params(), &[]);
        assert_eq!(Route::WorkspacesSweep.params(), &[]);
    }

    #[test]
    fn only_mutating_routes_are_writes() {
        for layer in LAYERS {
            let write = layer.kind.is_write();
            let expected = matches!(
                layer.kind,
                Route::MachinesPair
                    | Route::MachinesConnectionDelete
                    | Route::MachinesGrantRevoke
                    | Route::MachinesAdd
                    | Route::MachinesRename
                    | Route::MachinesDelete
                    | Route::MachinesWsTicket
                    | Route::SessionShareCreate
                    | Route::SessionShareRevoke
                    | Route::SessionMessageShare
                    | Route::WorkspacesSweep
            );
            assert_eq!(write, expected, "{:?}", layer.kind);
        }
        // Reads and token presentation never take the write lock.
        for route in [
            Route::MachinesList,
            Route::MachinesSelf,
            Route::MachinesGrants,
            Route::SessionSharesList,
            Route::SharePage,
            Route::ShareAuth,
            Route::ShareEntry,
            Route::ShareHistory,
            Route::ShareSession,
            Route::WorkspacesOverview,
        ] {
            assert!(!route.is_write(), "{route:?}");
        }
    }

    #[test]
    fn body_parsers_match_the_retired_mounts() {
        // The machines cluster parsed with its own 16kb parser, except the two
        // DELETEs that registered none; everything after the global parser.
        for route in [
            Route::MachinesList,
            Route::MachinesSelf,
            Route::MachinesGrants,
            Route::MachinesPair,
            Route::MachinesAdd,
            Route::MachinesRename,
            Route::MachinesDelete,
            Route::MachinesWsTicket,
        ] {
            assert_eq!(route.body_parser(), BodyParser::Json16k, "{route:?}");
        }
        assert_eq!(
            Route::MachinesConnectionDelete.body_parser(),
            BodyParser::None
        );
        assert_eq!(Route::MachinesGrantRevoke.body_parser(), BodyParser::None);
        for route in [
            Route::SessionShareCreate,
            Route::SessionSharesList,
            Route::SessionShareRevoke,
            Route::SessionMessageShare,
            Route::SharePage,
            Route::ShareAuth,
            Route::ShareEntry,
            Route::ShareHistory,
            Route::ShareSession,
            Route::WorkspacesOverview,
            Route::WorkspacesSweep,
        ] {
            assert_eq!(route.body_parser(), BodyParser::Global, "{route:?}");
        }
    }

    #[test]
    fn every_computed_allow_value_is_interned() {
        // The registration table is static, so the set of possible Allow
        // strings is finite; a method list that falls outside ALLOWS would
        // silently answer an empty Allow.
        for layer in LAYERS {
            let mut path = String::from("/api/");
            for (index, seg) in layer.segs.iter().enumerate() {
                if index > 0 {
                    path.push('/');
                }
                path.push_str(if seg.starts_with(':') { "x" } else { seg });
            }
            let allow = allow_for(&path).expect("registered path");
            assert_eq!(intern(&allow), allow, "{path} -> {allow}");
        }
        assert_eq!(intern("GET,HEAD"), "GET,HEAD");
        assert_eq!(intern("nope"), "");
    }

    #[test]
    fn root_redirect_and_other_share_like_paths_are_untouched() {
        for path in [
            "/",
            "/share",
            "/share/",
            "/sharex/t",
            "/api/shares/t1",
            "/api/share/t1",
        ] {
            assert_eq!(route("GET", path), None, "{path}");
        }
    }
}
