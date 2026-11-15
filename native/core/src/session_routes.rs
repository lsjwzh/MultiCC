//! Path matching for the session-management route cluster retired from
//! `src/routes/session-memory.js`, `session-bundle.js`, `session-lifecycle.js`,
//! `session-create.js`, `session-meta.js` and `session-profile.js`:
//!
//! * `GET|HEAD|PUT|DELETE /api/sessions/:id/memory`
//! * `POST                 /api/sessions/:id/memory/action`
//! * `GET|HEAD             /api/sessions/:id/bundle`
//! * `POST                 /api/sessions/import`
//! * `DELETE               /api/sessions/:id`
//! * `POST                 /api/sessions/:id/relocate`
//! * `POST                 /api/sessions/:id/restart`
//! * `POST                 /api/sessions/:id/restart-spawn`
//! * `POST                 /api/sessions/:id/vendor-login-terminal`
//! * `PUT                  /api/directories/:id/role-workers/:presetId`
//! * `POST                 /api/directories/:id/sessions`
//! * `POST                 /api/sessions/:id/notes`
//! * `GET|HEAD             /api/sessions/:id/liveness`
//! * `GET|HEAD             /api/sessions/:id/notes`
//! * `PATCH                /api/sessions/:id`
//! * `POST                 /api/sessions/:id/fork`
//!
//! Two routes are deliberately *not* claimed: `GET /api/sessions/:id/bundle.zip`
//! and `POST /api/sessions/import-zip`. They are a binary transport (a zip
//! stream built in memory and a raw 160 MB body) whose bytes carry timestamps
//! and random encryption salts, so the JSON host port cannot carry them and the
//! differential cannot compare them; they keep running in Node. See
//! docs/rust-migration/route-inventory.md.
//!
//! Everything a route needs to match exactly like Express — literal segments
//! case-insensitively, parameters as `[^/]+?`, one optional trailing slash, the
//! automatic `OPTIONS` `Allow` union — lives here. Nothing here reads a clock or
//! touches the filesystem, so it is unit-testable in isolation.
//!
//! Claim order against the neighbouring clusters is load-bearing:
//!
//! * `GET|HEAD /api/sessions/:id` and its `OPTIONS` stay with `session_admin`.
//!   This cluster claims only `PATCH`/`DELETE` on that exact shape.
//! * `/api/sessions/:id/{reclassify,mark-task-done,mark-goal-achieved}` stay
//!   with `session_admin`; `merge-status`/`diff`/`merge`/`sync`/`rebase` and the
//!   trigger routes stay with `session_git` / `event_routes`. This matcher only
//!   answers its own literals and returns `None` for everything else so the
//!   request keeps falling through to its owner.
//! * `GET|HEAD|POST /api/directories/:id/sessions` is shared: `session_admin`
//!   answers the GET and the `GET,HEAD,POST` `OPTIONS`; this cluster claims the
//!   POST (session creation).
//! * `PUT /api/directories/:id/role-workers/:presetId` is a four-segment literal
//!   no other cluster claims; it must not shadow the `GET|HEAD|POST
//!   /api/directories/:id/sessions` or the directory-cluster
//!   `PATCH|DELETE /api/directories/:id` matches.

/// One claimed route. `Options` carries the exact `Allow` value Express would
/// have computed for the path (registration order, `HEAD` after each `GET`) and
/// the `:id` segment index when the path sits under the
/// `publicSessionAccessGuard` `app.use('/api/sessions/:id', …)` mount.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    MemoryGet,
    MemoryPut,
    MemoryDelete,
    MemoryActionPost,
    BundleExportGet,
    ImportPost,
    SessionDelete,
    RelocatePost,
    RestartPost,
    RestartSpawnPost,
    VendorLoginPost,
    RoleWorkersPut,
    DirectorySessionCreatePost,
    NoteCreatePost,
    LivenessGet,
    NotesListGet,
    SessionPatch,
    ForkPost,
    Options {
        allow: &'static str,
        guard_segment: Option<usize>,
    },
}

impl Route {
    /// The host-port operation the front door asks Node for. `Options` never
    /// reaches the host except through the guard probe.
    pub fn op(self) -> Option<&'static str> {
        Some(match self {
            Route::MemoryGet => "memory-get",
            Route::MemoryPut => "memory-put",
            Route::MemoryDelete => "memory-delete",
            Route::MemoryActionPost => "memory-action",
            Route::BundleExportGet => "bundle-export",
            Route::ImportPost => "bundle-import",
            Route::SessionDelete => "session-delete",
            Route::RelocatePost => "session-relocate",
            Route::RestartPost => "session-restart",
            Route::RestartSpawnPost => "session-restart-spawn",
            Route::VendorLoginPost => "vendor-login-terminal",
            Route::RoleWorkersPut => "role-workers-put",
            Route::DirectorySessionCreatePost => "directory-create-session",
            Route::NoteCreatePost => "note-create",
            Route::LivenessGet => "liveness",
            Route::NotesListGet => "notes-list",
            Route::SessionPatch => "session-patch",
            Route::ForkPost => "session-fork",
            Route::Options { .. } => return None,
        })
    }

    /// Whether the retired handler was awaited by `asyncHandler` and mutates
    /// process state; those are serialized behind the cluster's write lock.
    pub fn is_write(self) -> bool {
        matches!(
            self,
            Route::MemoryPut
                | Route::MemoryDelete
                | Route::MemoryActionPost
                | Route::ImportPost
                | Route::SessionDelete
                | Route::RelocatePost
                | Route::RestartPost
                | Route::RestartSpawnPost
                | Route::VendorLoginPost
                | Route::RoleWorkersPut
                | Route::DirectorySessionCreatePost
                | Route::NoteCreatePost
                | Route::SessionPatch
                | Route::ForkPost
        )
    }
}

/// Segment view of `/api/<rest>`, one optional trailing slash removed. Express
/// matches literal segments case-insensitively and parameters as `[^/]+?`.
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

/// Express matches literal path segments case-insensitively.
fn lit(part: &str, name: &str) -> bool {
    part.eq_ignore_ascii_case(name)
}

fn get_like(method: &str) -> bool {
    matches!(method, "GET" | "HEAD")
}

/// This cluster's share of Express's automatic `OPTIONS` `Allow` for `path`:
/// the methods these six modules register there, in their mount order
/// (`session-create`, `session-profile`, `session-memory`, `session-bundle`,
/// `session-lifecycle`, `session-meta`), plus the `publicSessionAccessGuard`
/// `:id` segment when the path sits under that `app.use` mount.
///
/// The front door folds this share together with the other clusters that claim
/// the same path (`native/gateway/src/app/mod.rs` `OPTIONS_SOURCES`); it is not
/// the whole-app answer on its own. Two shapes need the other clusters:
///
/// * `/api/sessions/:id` also matches session-admin's `GET|HEAD` and, for the
///   `import` / `import-zip` literals, this cluster's own `POST`.
/// * `/api/directories/:id/sessions` also matches session-admin's `GET|HEAD`.
///
/// `import-zip` is the one path where the `POST` stays in Node: the front door
/// forwards the request, but the automatic `OPTIONS` union still carries the
/// method because the retired Node app registered it (see `claim`).
pub fn options_share(path: &str) -> Option<(&'static str, Option<usize>)> {
    let parts = segments(path)?;
    let sessions = lit(parts[0], "sessions");
    let directories = lit(parts[0], "directories");
    match parts.len() {
        // Registration order: profile's `PATCH /api/sessions/:id` matches the
        // literal too, then bundle's `POST` (import / import-zip), then
        // lifecycle's `DELETE /api/sessions/:id`.
        2 if sessions && lit(parts[1], "import") => Some(("PATCH,POST,DELETE", Some(1))),
        2 if sessions && lit(parts[1], "import-zip") => Some(("PATCH,POST,DELETE", Some(1))),
        2 if sessions => Some(("PATCH,DELETE", Some(1))),
        3 if sessions => match parts[2].to_ascii_lowercase().as_str() {
            "memory" => Some(("GET,HEAD,PUT,DELETE", Some(1))),
            "bundle" => Some(("GET,HEAD", Some(1))),
            // The zip transport keeps running in Node, so its OPTIONS row is
            // Node's automatic answer (GET,HEAD from the mounted bundle route).
            "bundle.zip" => None,
            "relocate" | "restart" | "restart-spawn" | "vendor-login-terminal" | "fork" => {
                Some(("POST", Some(1)))
            }
            // session-meta registers POST then GET on `/notes`.
            "notes" => Some(("POST,GET,HEAD", Some(1))),
            "liveness" => Some(("GET,HEAD", Some(1))),
            _ => None,
        },
        4 if sessions && lit(parts[2], "memory") && lit(parts[3], "action") => {
            Some(("POST", Some(1)))
        }
        4 if directories && lit(parts[2], "role-workers") => Some(("PUT", None)),
        3 if directories && lit(parts[2], "sessions") => Some(("POST", None)),
        _ => None,
    }
}

/// The matcher. Method is the raw request method; `GET` and `HEAD` share every
/// read route (Express answers HEAD from the GET handler), and `OPTIONS` is the
/// automatic responder.
pub fn claim(method: &str, path: &str) -> Option<Route> {
    let parts = segments(path)?;
    let sessions = lit(parts[0], "sessions");
    let directories = lit(parts[0], "directories");
    if method == "OPTIONS" {
        return options_share(path).map(|(allow, guard_segment)| Route::Options {
            allow,
            guard_segment,
        });
    }
    match parts.len() {
        // `/api/sessions/import` is also matched by the guard mount
        // (`:id` = "import"); it is not a session id but the guard lookup is
        // harmless (no such record, so never an internal slot).
        2 if sessions && lit(parts[1], "import") => {
            if method == "POST" {
                Some(Route::ImportPost)
            } else {
                None
            }
        }
        // `POST /api/sessions/import-zip` stays in Node (raw zip body): not
        // claimed, so every method forwards. Its `OPTIONS` row is still this
        // cluster's share of the whole-app union (`options_share`).
        2 if sessions && lit(parts[1], "import-zip") => None,
        // `/api/sessions/:id` — only PATCH/DELETE. GET/HEAD and the shared
        // OPTIONS union belong to session-admin, whose `Allow` already includes
        // them (`GET,HEAD,PATCH,DELETE`).
        2 if sessions => match method {
            "PATCH" => Some(Route::SessionPatch),
            "DELETE" => Some(Route::SessionDelete),
            _ => None,
        },
        3 if sessions => match parts[2].to_ascii_lowercase().as_str() {
            "memory" => match method {
                "PUT" => Some(Route::MemoryPut),
                "DELETE" => Some(Route::MemoryDelete),
                _ if get_like(method) => Some(Route::MemoryGet),
                _ => None,
            },
            "bundle" => {
                if get_like(method) {
                    Some(Route::BundleExportGet)
                } else {
                    None
                }
            }
            // `bundle.zip` stays in Node (binary zip): not claimed.
            "bundle.zip" => None,
            "relocate" => {
                if method == "POST" {
                    Some(Route::RelocatePost)
                } else {
                    None
                }
            }
            "restart" => {
                if method == "POST" {
                    Some(Route::RestartPost)
                } else {
                    None
                }
            }
            "restart-spawn" => {
                if method == "POST" {
                    Some(Route::RestartSpawnPost)
                } else {
                    None
                }
            }
            "vendor-login-terminal" => {
                if method == "POST" {
                    Some(Route::VendorLoginPost)
                } else {
                    None
                }
            }
            // session-meta registers POST then GET on `/notes`, so the union is
            // `POST,GET,HEAD` in registration order.
            "notes" => {
                if method == "POST" {
                    Some(Route::NoteCreatePost)
                } else if get_like(method) {
                    Some(Route::NotesListGet)
                } else {
                    None
                }
            }
            "liveness" => {
                if get_like(method) {
                    Some(Route::LivenessGet)
                } else {
                    None
                }
            }
            "fork" => {
                if method == "POST" {
                    Some(Route::ForkPost)
                } else {
                    None
                }
            }
            _ => None,
        },
        // `/api/sessions/:id/memory/action` — must be matched before the bare
        // `/memory` shape can never swallow it (they differ in length anyway;
        // the explicit arm documents the intent).
        4 if sessions && lit(parts[2], "memory") && lit(parts[3], "action") => {
            if method == "POST" {
                Some(Route::MemoryActionPost)
            } else {
                None
            }
        }
        // `PUT /api/directories/:id/role-workers/:presetId` — four segments, no
        // other cluster claims it. Not under the sessions guard.
        4 if directories && lit(parts[2], "role-workers") => {
            if method == "PUT" {
                Some(Route::RoleWorkersPut)
            } else {
                None
            }
        }
        // `POST /api/directories/:id/sessions` — the GET and the shared OPTIONS
        // (`GET,HEAD,POST`) belong to session-admin.
        3 if directories && lit(parts[2], "sessions") => {
            if method == "POST" {
                Some(Route::DirectorySessionCreatePost)
            } else {
                None
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(method: &str, path: &str) -> Option<Route> {
        claim(method, path)
    }

    #[test]
    fn claims_every_retired_route() {
        for (method, path, expected) in [
            ("GET", "/api/sessions/s1/memory", Route::MemoryGet),
            ("HEAD", "/api/sessions/s1/memory", Route::MemoryGet),
            ("PUT", "/api/sessions/s1/memory", Route::MemoryPut),
            ("DELETE", "/api/sessions/s1/memory", Route::MemoryDelete),
            (
                "POST",
                "/api/sessions/s1/memory/action",
                Route::MemoryActionPost,
            ),
            ("GET", "/api/sessions/s1/bundle", Route::BundleExportGet),
            ("POST", "/api/sessions/import", Route::ImportPost),
            ("DELETE", "/api/sessions/s1", Route::SessionDelete),
            ("POST", "/api/sessions/s1/relocate", Route::RelocatePost),
            ("POST", "/api/sessions/s1/restart", Route::RestartPost),
            (
                "POST",
                "/api/sessions/s1/restart-spawn",
                Route::RestartSpawnPost,
            ),
            (
                "POST",
                "/api/sessions/s1/vendor-login-terminal",
                Route::VendorLoginPost,
            ),
            (
                "PUT",
                "/api/directories/d1/role-workers/p1",
                Route::RoleWorkersPut,
            ),
            (
                "POST",
                "/api/directories/d1/sessions",
                Route::DirectorySessionCreatePost,
            ),
            ("POST", "/api/sessions/s1/notes", Route::NoteCreatePost),
            ("GET", "/api/sessions/s1/liveness", Route::LivenessGet),
            ("GET", "/api/sessions/s1/notes", Route::NotesListGet),
            ("PATCH", "/api/sessions/s1", Route::SessionPatch),
            ("POST", "/api/sessions/s1/fork", Route::ForkPost),
        ] {
            assert_eq!(route(method, path), Some(expected), "{method} {path}");
        }
    }

    #[test]
    fn literal_segments_are_case_insensitive_and_trailing_slash_is_optional() {
        // The `/api/` prefix itself is case-sensitive (Node's auth gate and
        // gzip check test it exactly); only the segments after it are not.
        assert_eq!(
            route("GET", "/api/Sessions/S1/Memory"),
            Some(Route::MemoryGet)
        );
        assert_eq!(route("GET", "/API/Sessions/S1/Memory"), None);
        assert_eq!(
            route("POST", "/api/sessions/s1/RELocate/"),
            Some(Route::RelocatePost)
        );
        assert_eq!(
            route("PATCH", "/api/sessions/s1/"),
            Some(Route::SessionPatch)
        );
    }

    #[test]
    fn leaves_the_neighbouring_clusters_alone() {
        // session-admin: GET/HEAD on the shared /api/sessions/:id shape. This
        // cluster's OPTIONS share (PATCH/DELETE) is merged by the front door's
        // `OPTIONS_SOURCES`, not answered here on its own.
        assert_eq!(route("GET", "/api/sessions/s1"), None);
        assert_eq!(route("HEAD", "/api/sessions/s1"), None);
        assert_eq!(
            route("OPTIONS", "/api/sessions/s1"),
            Some(Route::Options {
                allow: "PATCH,DELETE",
                guard_segment: Some(1)
            })
        );
        // session-admin: the classify POSTs.
        for tail in ["reclassify", "mark-task-done", "mark-goal-achieved"] {
            assert_eq!(route("POST", &format!("/api/sessions/s1/{tail}")), None);
        }
        // session-git: merge-status / diff / merge / sync / rebase.
        for (method, tail) in [
            ("GET", "merge-status"),
            ("GET", "diff"),
            ("POST", "merge"),
            ("POST", "sync"),
            ("POST", "rebase"),
        ] {
            assert_eq!(route(method, &format!("/api/sessions/s1/{tail}")), None);
        }
        // events: the trigger routes.
        assert_eq!(route("GET", "/api/sessions/s1/triggers"), None);
        assert_eq!(route("POST", "/api/sessions/s1/triggers/t1"), None);
        // cli-switch (still Node-owned): must not be captured.
        assert_eq!(route("POST", "/api/sessions/s1/switch-cli"), None);
        // directory cluster: GET on /api/directories/:id and its 3-segment batch
        // literals; only the POST creation route is ours.
        assert_eq!(route("PATCH", "/api/directories/d1"), None);
        assert_eq!(route("GET", "/api/directories/d1/sessions"), None);
        assert_eq!(
            route("OPTIONS", "/api/directories/d1/sessions"),
            Some(Route::Options {
                allow: "POST",
                guard_segment: None
            })
        );
        assert_eq!(route("GET", "/api/directories/d1/workspace"), None);
        assert_eq!(route("POST", "/api/directories/d1/push"), None);
    }

    #[test]
    fn the_two_binary_bundle_routes_stay_in_node() {
        for method in ["GET", "HEAD", "POST", "OPTIONS"] {
            assert_eq!(route(method, "/api/sessions/s1/bundle.zip"), None);
        }
        // The zip `POST` stays in Node; only its automatic-OPTIONS row is this
        // cluster's share (the front door folds in session-admin's GET/HEAD).
        assert_eq!(route("POST", "/api/sessions/import-zip"), None);
        assert_eq!(route("GET", "/api/sessions/import-zip"), None);
        assert_eq!(
            route("OPTIONS", "/api/sessions/import-zip"),
            Some(Route::Options {
                allow: "PATCH,POST,DELETE",
                guard_segment: Some(1)
            })
        );
    }

    #[test]
    fn unregistered_methods_and_unknown_tails_fall_through() {
        assert_eq!(route("POST", "/api/sessions/s1/memory"), None);
        assert_eq!(route("PATCH", "/api/sessions/s1/bundle"), None);
        assert_eq!(route("DELETE", "/api/sessions/s1/relocate"), None);
        assert_eq!(route("GET", "/api/sessions/s1/nope"), None);
        assert_eq!(route("POST", "/api/sessions/s1/memory/nope"), None);
        assert_eq!(route("GET", "/api/sessions"), None);
        assert_eq!(route("GET", "/api/"), None);
        assert_eq!(route("GET", "/api////"), None);
        assert_eq!(route("GET", "/random"), None);
    }

    #[test]
    fn automatic_options_unions_match_express() {
        for (path, allow, guard) in [
            ("/api/sessions/s1/memory", "GET,HEAD,PUT,DELETE", Some(1)),
            ("/api/sessions/s1/memory/action", "POST", Some(1)),
            ("/api/sessions/s1/bundle", "GET,HEAD", Some(1)),
            ("/api/sessions/import", "PATCH,POST,DELETE", Some(1)),
            ("/api/sessions/import-zip", "PATCH,POST,DELETE", Some(1)),
            ("/api/sessions/s1/relocate", "POST", Some(1)),
            ("/api/sessions/s1/restart", "POST", Some(1)),
            ("/api/sessions/s1/restart-spawn", "POST", Some(1)),
            ("/api/sessions/s1/vendor-login-terminal", "POST", Some(1)),
            ("/api/sessions/s1/notes", "POST,GET,HEAD", Some(1)),
            ("/api/sessions/s1/liveness", "GET,HEAD", Some(1)),
            ("/api/sessions/s1/fork", "POST", Some(1)),
            ("/api/directories/d1/role-workers/p1", "PUT", None),
        ] {
            assert_eq!(
                route("OPTIONS", path),
                Some(Route::Options {
                    allow,
                    guard_segment: guard
                }),
                "OPTIONS {path}"
            );
        }
    }

    #[test]
    fn the_memory_bare_path_never_swallows_action() {
        // `/action` is a 4-segment path; the bare `/memory` arm is 3 segments,
        // so an action request can only match the explicit action arm.
        assert_eq!(
            route("POST", "/api/sessions/s1/memory/action"),
            Some(Route::MemoryActionPost)
        );
        assert_eq!(route("GET", "/api/sessions/s1/memory/action"), None);
    }

    #[test]
    fn the_shared_directories_sessions_path_does_not_shadow_role_workers() {
        // Same four-vs-three segment distinction: the PUT on role-workers must
        // claim while the sessions POST keeps falling through to this cluster
        // and the GET/OPTIONS to session-admin.
        assert_eq!(
            route("PUT", "/api/directories/d1/role-workers/p1"),
            Some(Route::RoleWorkersPut)
        );
        assert_eq!(
            route("POST", "/api/directories/d1/sessions"),
            Some(Route::DirectorySessionCreatePost)
        );
        assert_eq!(route("GET", "/api/directories/d1/sessions"), None);
        assert_eq!(
            route("OPTIONS", "/api/directories/d1/sessions"),
            Some(Route::Options {
                allow: "POST",
                guard_segment: None
            })
        );
        // A four-segment sessions path is not a creation route.
        assert_eq!(route("POST", "/api/directories/d1/sessions/x"), None);
    }

    #[test]
    fn the_op_table_covers_every_route_and_classifies_writes() {
        let routes = [
            Route::MemoryGet,
            Route::MemoryPut,
            Route::MemoryDelete,
            Route::MemoryActionPost,
            Route::BundleExportGet,
            Route::ImportPost,
            Route::SessionDelete,
            Route::RelocatePost,
            Route::RestartPost,
            Route::RestartSpawnPost,
            Route::VendorLoginPost,
            Route::RoleWorkersPut,
            Route::DirectorySessionCreatePost,
            Route::NoteCreatePost,
            Route::LivenessGet,
            Route::NotesListGet,
            Route::SessionPatch,
            Route::ForkPost,
        ];
        for route in routes {
            assert!(route.op().is_some(), "{route:?} has no host op");
        }
        assert_eq!(
            Route::Options {
                allow: "x",
                guard_segment: None
            }
            .op(),
            None
        );
        for read in [
            Route::MemoryGet,
            Route::BundleExportGet,
            Route::LivenessGet,
            Route::NotesListGet,
        ] {
            assert!(!read.is_write(), "{read:?}");
        }
        for write in [
            Route::MemoryPut,
            Route::MemoryDelete,
            Route::MemoryActionPost,
            Route::ImportPost,
            Route::SessionDelete,
            Route::RelocatePost,
            Route::RestartPost,
            Route::RestartSpawnPost,
            Route::VendorLoginPost,
            Route::RoleWorkersPut,
            Route::DirectorySessionCreatePost,
            Route::NoteCreatePost,
            Route::SessionPatch,
            Route::ForkPost,
        ] {
            assert!(write.is_write(), "{write:?}");
        }
    }
}
