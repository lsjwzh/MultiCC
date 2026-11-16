//! Path matching for the orchestration and unattended cluster retired from
//! `src/routes/{aux-goal,aux-runs,orchestration}.js` and
//! `src/unattended/routes.js` -- 30 public routes:
//!
//! * `GET  /api/aux/{status,health,history}`, `POST /api/aux/{enqueue,cancel}`
//! * `GET|POST /api/aux/config`, `GET|POST /api/settings/goal`
//! * `POST /api/goal/precheck`
//! * `GET /api/sessions/:id/aux-runs`, `GET /api/sessions/:id/aux-runs/:runId`
//! * `GET|POST /api/sessions/:id/unattended`
//! * `POST|GET /api/sessions/:id/scheduled-messages`,
//!   `DELETE /api/sessions/:id/scheduled-messages/:messageId`
//! * `GET /api/sessions/:id/{tasks,dispatches,queue}`
//! * `POST /api/sessions/:id/{user-input/dismiss,queue/action}`
//! * `GET /api/v1/sessions/:id/waits`
//! * `POST /api/sessions/:id/wait`, `POST /api/wait/:wid/resolve`,
//!   `GET /api/sessions/:id/waits`, `DELETE /api/wait/:wid`
//! * `POST /api/sessions/:id/run-detached`, `GET /api/sessions/:id/detached`,
//!   `GET /api/detached/:taskId`
//!
//! The last seven were the registered out-of-scope wait injector and detached
//! set: they joined in a second batch, so both waits listings are now ours and
//! the pair that used to be easy to confuse is simply two routes. They are the
//! only ones here whose Node handler reads a request header other than
//! `Idempotency-Key`: the wait registration builds its `callbackUrl` from
//! `req.get('host')`, and the resolve callback accepts its token from
//! `x-wait-token`. Both names are therefore forwarded; see the front door's
//! `FORWARDED_HEADERS`.
//!
//! Matching rules are the same Express-compatible ones every cluster uses:
//! literal segments case-insensitively, a `:param` as one non-empty segment, one
//! optional trailing slash, the raw (undecoded) path, and the automatic
//! `OPTIONS` `Allow` union in registration order with `HEAD` right after each
//! `GET`. Nothing here touches the filesystem or a clock.

/// One claimed route. `Options` is Express's automatic responder for a path
/// this cluster registers; `guard_segment` names the `:id` segment the
/// `publicSessionAccessGuard` `app.use` layer observes in front of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    AuxStatus,
    AuxHealth,
    AuxHistory,
    AuxEnqueue,
    AuxCancel,
    AuxConfigGet,
    AuxConfigPost,
    SettingsGoalGet,
    SettingsGoalPost,
    GoalPrecheck,
    SessionAuxRuns,
    SessionAuxRun,
    UnattendedGet,
    UnattendedPost,
    ScheduledMessagePost,
    ScheduledMessagesGet,
    ScheduledMessageDelete,
    SessionTasks,
    SessionDispatches,
    UserInputDismiss,
    SessionQueue,
    SessionQueueAction,
    V1SessionWaits,
    SessionWaitPost,
    WaitResolve,
    SessionWaits,
    WaitCancel,
    RunDetached,
    SessionDetached,
    DetachedTask,
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
            Route::AuxStatus => "aux-status",
            Route::AuxHealth => "aux-health",
            Route::AuxHistory => "aux-history",
            Route::AuxEnqueue => "aux-enqueue",
            Route::AuxCancel => "aux-cancel",
            Route::AuxConfigGet => "aux-config-get",
            Route::AuxConfigPost => "aux-config-post",
            Route::SettingsGoalGet => "settings-goal-get",
            Route::SettingsGoalPost => "settings-goal-post",
            Route::GoalPrecheck => "goal-precheck",
            Route::SessionAuxRuns => "session-aux-runs",
            Route::SessionAuxRun => "session-aux-run",
            Route::UnattendedGet => "unattended-get",
            Route::UnattendedPost => "unattended-post",
            Route::ScheduledMessagePost => "scheduled-message-post",
            Route::ScheduledMessagesGet => "scheduled-messages-get",
            Route::ScheduledMessageDelete => "scheduled-message-delete",
            Route::SessionTasks => "session-tasks",
            Route::SessionDispatches => "session-dispatches",
            Route::UserInputDismiss => "user-input-dismiss",
            Route::SessionQueue => "session-queue",
            Route::SessionQueueAction => "session-queue-action",
            Route::V1SessionWaits => "v1-session-waits",
            Route::SessionWaitPost => "session-wait-post",
            Route::WaitResolve => "wait-resolve",
            Route::SessionWaits => "session-waits",
            Route::WaitCancel => "wait-cancel",
            Route::RunDetached => "run-detached",
            Route::SessionDetached => "session-detached",
            Route::DetachedTask => "detached-task",
            Route::Options { .. } => return None,
        })
    }

    /// Whether the retired handler mutates host state: every `POST`/`DELETE`.
    pub fn is_write(self) -> bool {
        matches!(
            self,
            Route::AuxEnqueue
                | Route::AuxCancel
                | Route::AuxConfigPost
                | Route::SettingsGoalPost
                | Route::GoalPrecheck
                | Route::UnattendedPost
                | Route::ScheduledMessagePost
                | Route::ScheduledMessageDelete
                | Route::UserInputDismiss
                | Route::SessionQueueAction
                | Route::SessionWaitPost
                | Route::WaitResolve
                | Route::WaitCancel
                | Route::RunDetached
        )
    }

    /// Whether the write is serialized behind the cluster write lock. The two
    /// routes that wait for an Aux model call (`enqueue`, `goal/precheck`) hold
    /// the connection for up to minutes, and `aux/cancel` exists to interrupt
    /// exactly such a wait: serializing them would let a queued enqueue starve
    /// its own cancel. Wait and detached handlers also remain concurrent, as
    /// they were on the public Node router before this migration.
    pub fn serializes(self) -> bool {
        self.is_write()
            && !matches!(
                self,
                Route::AuxEnqueue
                    | Route::AuxCancel
                    | Route::GoalPrecheck
                    | Route::SessionWaitPost
                    | Route::WaitResolve
                    | Route::WaitCancel
                    | Route::RunDetached
            )
    }

    /// A route whose Node handler legitimately waits for an Aux model call; the
    /// front door gives it a long host-port budget instead of the ordinary 60 s.
    pub fn long_poll(self) -> bool {
        matches!(self, Route::AuxEnqueue | Route::GoalPrecheck)
    }

    /// Every route in this cluster sits after the global `express.json`.
    pub fn body_parser(self) -> BodyParser {
        BodyParser::Global
    }

    /// The path parameters as `(name, segment index)` relative to [`segments`]
    /// (the segments after `/api/`). The front door percent-decodes each one
    /// before handing it to the host port -- Express decoded `req.params` too.
    pub fn params(self) -> &'static [(&'static str, usize)] {
        match self {
            Route::SessionAuxRuns
            | Route::UnattendedGet
            | Route::UnattendedPost
            | Route::ScheduledMessagePost
            | Route::ScheduledMessagesGet
            | Route::SessionTasks
            | Route::SessionDispatches
            | Route::UserInputDismiss
            | Route::SessionQueue
            | Route::SessionQueueAction => &[("id", 1)],
            Route::SessionWaitPost
            | Route::SessionWaits
            | Route::RunDetached
            | Route::SessionDetached => &[("id", 1)],
            Route::SessionAuxRun => &[("id", 1), ("runId", 3)],
            Route::ScheduledMessageDelete => &[("id", 1), ("messageId", 3)],
            Route::V1SessionWaits => &[("id", 2)],
            Route::WaitResolve | Route::WaitCancel => &[("wid", 1)],
            Route::DetachedTask => &[("taskId", 1)],
            _ => &[],
        }
    }

    /// Whether this route is under the `/api/v1/` envelope (the guard's 404 and
    /// the handler's errors use the v1 error DTO).
    pub fn v1(self) -> bool {
        matches!(self, Route::V1SessionWaits)
    }
}

/// The query keys any retired handler in this cluster read. The front door
/// forwards each present key as its qs value (string, array or object) so the
/// handler's own `String(x)`, `parseInt(x)`, `!== 'false'` and `=== undefined`
/// checks see exactly what Express's `req.query` gave them.
pub const QUERY_KEYS: &[&str] = &[
    "messageId",
    "taskId",
    "limit",
    "relation",
    "activeOnly",
    "recentTerminalLimit",
    "taskIds",
    // `POST /api/wait/:wid/resolve` reads `req.query.token` first, before the
    // `x-wait-token` header and the body's own `token`.
    "token",
];

/// What the retired route did with a request body before its handler ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyParser {
    /// The global `express.json({limit:'50mb'})`.
    Global,
}

struct Layer {
    segs: &'static [&'static str],
    method: &'static str,
    kind: Route,
}

const fn layer(segs: &'static [&'static str], method: &'static str, kind: Route) -> Layer {
    Layer { segs, method, kind }
}

/// Registration order of the retired mounts in `server.js`: unattended (with
/// the session-admin mount), the Aux and goal routes, the Aux run log, then the
/// orchestration routes. Order fixes the `Allow` union of the paths this
/// cluster registers more than one method on.
static LAYERS: &[Layer] = &[
    layer(
        &["sessions", ":id", "unattended"],
        "GET",
        Route::UnattendedGet,
    ),
    layer(
        &["sessions", ":id", "unattended"],
        "POST",
        Route::UnattendedPost,
    ),
    layer(&["aux", "status"], "GET", Route::AuxStatus),
    layer(&["aux", "health"], "GET", Route::AuxHealth),
    layer(&["aux", "history"], "GET", Route::AuxHistory),
    layer(&["aux", "enqueue"], "POST", Route::AuxEnqueue),
    layer(&["aux", "cancel"], "POST", Route::AuxCancel),
    layer(&["aux", "config"], "GET", Route::AuxConfigGet),
    layer(&["aux", "config"], "POST", Route::AuxConfigPost),
    layer(&["settings", "goal"], "GET", Route::SettingsGoalGet),
    layer(&["settings", "goal"], "POST", Route::SettingsGoalPost),
    layer(&["goal", "precheck"], "POST", Route::GoalPrecheck),
    layer(
        &["sessions", ":id", "aux-runs"],
        "GET",
        Route::SessionAuxRuns,
    ),
    layer(
        &["sessions", ":id", "aux-runs", ":runId"],
        "GET",
        Route::SessionAuxRun,
    ),
    layer(
        &["sessions", ":id", "scheduled-messages"],
        "POST",
        Route::ScheduledMessagePost,
    ),
    layer(
        &["sessions", ":id", "scheduled-messages"],
        "GET",
        Route::ScheduledMessagesGet,
    ),
    layer(
        &["sessions", ":id", "scheduled-messages", ":messageId"],
        "DELETE",
        Route::ScheduledMessageDelete,
    ),
    layer(&["sessions", ":id", "wait"], "POST", Route::SessionWaitPost),
    layer(&["wait", ":wid", "resolve"], "POST", Route::WaitResolve),
    layer(&["sessions", ":id", "waits"], "GET", Route::SessionWaits),
    layer(
        &["v1", "sessions", ":id", "waits"],
        "GET",
        Route::V1SessionWaits,
    ),
    layer(&["wait", ":wid"], "DELETE", Route::WaitCancel),
    layer(
        &["sessions", ":id", "run-detached"],
        "POST",
        Route::RunDetached,
    ),
    layer(
        &["sessions", ":id", "detached"],
        "GET",
        Route::SessionDetached,
    ),
    layer(&["sessions", ":id", "tasks"], "GET", Route::SessionTasks),
    layer(
        &["sessions", ":id", "dispatches"],
        "GET",
        Route::SessionDispatches,
    ),
    layer(
        &["sessions", ":id", "user-input", "dismiss"],
        "POST",
        Route::UserInputDismiss,
    ),
    layer(&["sessions", ":id", "queue"], "GET", Route::SessionQueue),
    layer(
        &["sessions", ":id", "queue", "action"],
        "POST",
        Route::SessionQueueAction,
    ),
    layer(&["detached", ":taskId"], "GET", Route::DetachedTask),
];

/// `path` -> its segments after `/api/`, or `None` when this cluster cannot own
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

/// The `:id` segment `publicSessionAccessGuard` observes before a route (and
/// before its `OPTIONS`): `/api/sessions/:id/*` and `/api/v1/sessions/:id/*`.
pub fn guard_index(parts: &[&str]) -> Option<usize> {
    if parts.len() >= 2 && parts[0].eq_ignore_ascii_case("sessions") {
        Some(1)
    } else if parts.len() >= 3
        && parts[0].eq_ignore_ascii_case("v1")
        && parts[1].eq_ignore_ascii_case("sessions")
    {
        Some(2)
    } else {
        None
    }
}

/// Whether the path is under the `/api/v1/` envelope.
pub fn is_v1(parts: &[&str]) -> bool {
    parts
        .first()
        .is_some_and(|head| head.eq_ignore_ascii_case("v1"))
}

/// Every `Allow` string [`LAYERS`] can produce, so [`Route::Options`] can keep
/// a `&'static str` (the front door's route enum stays `Copy`).
const ALLOWS: &[&str] = &[
    "GET,HEAD",
    "POST",
    "DELETE",
    "GET,HEAD,POST",
    "POST,GET,HEAD",
];

fn intern(allow: &str) -> &'static str {
    ALLOWS
        .iter()
        .copied()
        .find(|candidate| *candidate == allow)
        .unwrap_or("")
}

/// This cluster's share of Express's automatic OPTIONS `Allow` for `path`: the
/// union of the methods it registers on that exact path in registration order,
/// each `GET` followed by `HEAD`.
pub fn allow_for(path: &str) -> Option<String> {
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

/// This cluster's share of the front-door `OPTIONS` union across clusters
/// (`super::OPTIONS_SOURCES`).
pub fn options_share(path: &str) -> Option<String> {
    allow_for(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(method: &str, path: &str) -> Option<Route> {
        claim(method, path)
    }

    fn sample_path(layer: &Layer) -> String {
        let mut path = String::from("/api/");
        for (index, seg) in layer.segs.iter().enumerate() {
            if index > 0 {
                path.push('/');
            }
            path.push_str(if seg.starts_with(':') { "x" } else { seg });
        }
        path
    }

    #[test]
    fn claims_every_one_of_the_23_routes() {
        use Route::*;
        let cases = [
            ("GET", "/api/aux/status", AuxStatus),
            ("GET", "/api/aux/health", AuxHealth),
            ("GET", "/api/aux/history", AuxHistory),
            ("POST", "/api/aux/enqueue", AuxEnqueue),
            ("POST", "/api/aux/cancel", AuxCancel),
            ("GET", "/api/aux/config", AuxConfigGet),
            ("POST", "/api/aux/config", AuxConfigPost),
            ("GET", "/api/settings/goal", SettingsGoalGet),
            ("POST", "/api/settings/goal", SettingsGoalPost),
            ("POST", "/api/goal/precheck", GoalPrecheck),
            ("GET", "/api/sessions/s1/aux-runs", SessionAuxRuns),
            ("GET", "/api/sessions/s1/aux-runs/r1", SessionAuxRun),
            ("GET", "/api/sessions/s1/unattended", UnattendedGet),
            ("POST", "/api/sessions/s1/unattended", UnattendedPost),
            (
                "POST",
                "/api/sessions/s1/scheduled-messages",
                ScheduledMessagePost,
            ),
            (
                "GET",
                "/api/sessions/s1/scheduled-messages",
                ScheduledMessagesGet,
            ),
            (
                "DELETE",
                "/api/sessions/s1/scheduled-messages/m1",
                ScheduledMessageDelete,
            ),
            ("GET", "/api/sessions/s1/tasks", SessionTasks),
            ("GET", "/api/sessions/s1/dispatches", SessionDispatches),
            (
                "POST",
                "/api/sessions/s1/user-input/dismiss",
                UserInputDismiss,
            ),
            ("GET", "/api/sessions/s1/queue", SessionQueue),
            ("POST", "/api/sessions/s1/queue/action", SessionQueueAction),
            ("GET", "/api/v1/sessions/s1/waits", V1SessionWaits),
            ("POST", "/api/sessions/s1/wait", SessionWaitPost),
            ("POST", "/api/wait/w1/resolve", WaitResolve),
            ("GET", "/api/sessions/s1/waits", SessionWaits),
            ("DELETE", "/api/wait/w1", WaitCancel),
            ("POST", "/api/sessions/s1/run-detached", RunDetached),
            ("GET", "/api/sessions/s1/detached", SessionDetached),
            ("GET", "/api/detached/t1", DetachedTask),
        ];
        assert_eq!(cases.len(), 30);
        assert_eq!(LAYERS.len(), 30);
        for (method, path, expected) in cases {
            assert_eq!(route(method, path), Some(expected), "{method} {path}");
        }
        // HEAD is answered from the GET handler.
        assert_eq!(route("HEAD", "/api/aux/status"), Some(AuxStatus));
        assert_eq!(route("HEAD", "/api/aux/enqueue"), None);
    }

    #[test]
    fn both_waits_listings_are_ours_but_stay_two_distinct_routes() {
        // They were split across two batches and answer different DTOs (the v1
        // projection is enveloped, the unprefixed one merges the legacy
        // injector's rows), so the only thing that may ever merge them is this
        // test noticing that it cannot.
        assert_eq!(
            route("GET", "/api/v1/sessions/s1/waits"),
            Some(Route::V1SessionWaits)
        );
        assert_eq!(
            route("HEAD", "/api/v1/sessions/s1/waits"),
            Some(Route::V1SessionWaits)
        );
        assert_eq!(
            route("GET", "/api/sessions/s1/waits"),
            Some(Route::SessionWaits)
        );
        assert_eq!(
            route("HEAD", "/api/sessions/s1/waits"),
            Some(Route::SessionWaits)
        );
        assert_ne!(Route::SessionWaits.op(), Route::V1SessionWaits.op());
        // Only the v1 one is under the enveloped error DTO.
        assert!(Route::V1SessionWaits.v1());
        assert!(!Route::SessionWaits.v1());
        assert_eq!(
            allow_for("/api/sessions/s1/waits").as_deref(),
            Some("GET,HEAD")
        );
        // Other methods on either path are still not ours.
        assert_eq!(route("POST", "/api/v1/sessions/s1/waits"), None);
        assert_eq!(route("DELETE", "/api/v1/sessions/s1/waits"), None);
        assert_eq!(route("POST", "/api/sessions/s1/waits"), None);
    }

    #[test]
    fn the_wait_and_detached_set_is_claimed_with_its_own_params() {
        // `:wid` and `:taskId` are the only params in this cluster that are not
        // a session id, so a copy-paste of `("id", 1)` would silently hand the
        // host port an undefined parameter.
        assert_eq!(Route::SessionWaitPost.params(), &[("id", 1)]);
        assert_eq!(Route::SessionWaits.params(), &[("id", 1)]);
        assert_eq!(Route::RunDetached.params(), &[("id", 1)]);
        assert_eq!(Route::SessionDetached.params(), &[("id", 1)]);
        assert_eq!(Route::WaitResolve.params(), &[("wid", 1)]);
        assert_eq!(Route::WaitCancel.params(), &[("wid", 1)]);
        assert_eq!(Route::DetachedTask.params(), &[("taskId", 1)]);
        // These writes preserve the old handler concurrency and are not long polls.
        for route in [
            Route::SessionWaitPost,
            Route::WaitResolve,
            Route::WaitCancel,
            Route::RunDetached,
        ] {
            assert!(route.is_write(), "{route:?}");
            assert!(!route.serializes(), "{route:?}");
            assert!(!route.long_poll(), "{route:?}");
        }
        for route in [
            Route::SessionWaits,
            Route::SessionDetached,
            Route::DetachedTask,
        ] {
            assert!(!route.is_write(), "{route:?}");
        }
        // `/api/wait/...` and `/api/detached/...` are not session-scoped, so the
        // public session guard must not fire on them.
        for path in ["/api/wait/w1", "/api/wait/w1/resolve", "/api/detached/t1"] {
            assert_eq!(guard_index(&segments(path).unwrap()), None, "{path}");
        }
        for path in [
            "/api/sessions/s1/wait",
            "/api/sessions/s1/waits",
            "/api/sessions/s1/run-detached",
            "/api/sessions/s1/detached",
        ] {
            assert_eq!(guard_index(&segments(path).unwrap()), Some(1), "{path}");
        }
    }

    #[test]
    fn the_wait_and_detached_allow_headers_match_their_single_method() {
        for (path, allow) in [
            ("/api/sessions/s1/wait", "POST"),
            ("/api/wait/w1/resolve", "POST"),
            ("/api/sessions/s1/waits", "GET,HEAD"),
            ("/api/wait/w1", "DELETE"),
            ("/api/sessions/s1/run-detached", "POST"),
            ("/api/sessions/s1/detached", "GET,HEAD"),
            ("/api/detached/t1", "GET,HEAD"),
        ] {
            assert_eq!(allow_for(path).as_deref(), Some(allow), "{path}");
            assert_eq!(options_share(path).as_deref(), Some(allow), "{path}");
            assert_eq!(
                claim("OPTIONS", path),
                Some(Route::Options {
                    allow: intern(allow),
                    guard_segment: guard_index(&segments(path).unwrap()),
                }),
                "OPTIONS {path}"
            );
        }
        // `/api/wait/:wid` and `/api/wait/:wid/resolve` are different paths: the
        // longer one must not contribute `POST` to the shorter one's Allow.
        assert_eq!(allow_for("/api/wait/w1").as_deref(), Some("DELETE"));
    }

    #[test]
    fn other_methods_and_near_paths_are_not_claimed() {
        for (method, path) in [
            ("PUT", "/api/aux/config"),
            ("DELETE", "/api/aux/status"),
            ("GET", "/api/aux/enqueue"),
            ("GET", "/api/aux"),
            ("GET", "/api/aux/status/extra"),
            ("GET", "/api/goal/precheck"),
            ("GET", "/api/goal"),
            ("PATCH", "/api/sessions/s1/queue"),
            ("GET", "/api/sessions/s1/queue/action"),
            ("POST", "/api/sessions/s1/queue"),
            ("POST", "/api/sessions/s1/tasks"),
            ("GET", "/api/sessions/s1/user-input/dismiss"),
            ("GET", "/api/sessions/s1/aux-runs/r1/extra"),
            ("GET", "/api/sessions/s1/scheduled-messages/m1"),
            ("POST", "/api/sessions/s1/scheduled-messages/m1"),
            ("GET", "/api/sessions"),
            ("GET", "/api/sessions/s1"),
            ("GET", "/api/v1/sessions/s1"),
            ("GET", "/api/v1/sessions/s1/tasks"),
            ("GET", "/api/v1/aux/status"),
        ] {
            assert_eq!(route(method, path), None, "{method} {path}");
        }
    }

    #[test]
    fn trailing_slash_is_tolerated_but_empty_segments_are_not() {
        assert_eq!(
            route("GET", "/api/sessions/s1/queue/"),
            Some(Route::SessionQueue)
        );
        assert_eq!(route("GET", "/api/sessions//queue"), None);
        assert_eq!(route("GET", "/api/sessions/s1/queue//"), None);
        assert_eq!(route("GET", "/api//aux/status"), None);
        assert_eq!(route("GET", "/api/aux//status"), None);
    }

    #[test]
    fn literals_are_case_insensitive_and_the_prefix_is_not() {
        assert_eq!(route("GET", "/API/aux/status"), None);
        assert_eq!(route("GET", "/api/AUX/Status"), Some(Route::AuxStatus));
        assert_eq!(
            route("GET", "/api/V1/Sessions/s1/Waits"),
            Some(Route::V1SessionWaits)
        );
        assert_eq!(
            route("POST", "/api/sessions/S1/Queue/ACTION"),
            Some(Route::SessionQueueAction)
        );
        // A param is one raw segment: an encoded slash stays inside it.
        assert_eq!(
            route("GET", "/api/sessions/a%2Fb/queue"),
            Some(Route::SessionQueue)
        );
        assert_eq!(route("GET", "/api/sessions/a/b/queue"), None);
    }

    #[test]
    fn allow_union_matches_the_measured_express_values() {
        // Measured against the retired Express stack (the differential's
        // OPTIONS cases re-measure every one of these).
        let measured = [
            ("/api/aux/status", "GET,HEAD"),
            ("/api/aux/health", "GET,HEAD"),
            ("/api/aux/history", "GET,HEAD"),
            ("/api/aux/enqueue", "POST"),
            ("/api/aux/cancel", "POST"),
            ("/api/aux/config", "GET,HEAD,POST"),
            ("/api/settings/goal", "GET,HEAD,POST"),
            ("/api/goal/precheck", "POST"),
            ("/api/sessions/s1/aux-runs", "GET,HEAD"),
            ("/api/sessions/s1/aux-runs/r1", "GET,HEAD"),
            ("/api/sessions/s1/unattended", "GET,HEAD,POST"),
            ("/api/sessions/s1/scheduled-messages", "POST,GET,HEAD"),
            ("/api/sessions/s1/scheduled-messages/m1", "DELETE"),
            ("/api/sessions/s1/tasks", "GET,HEAD"),
            ("/api/sessions/s1/dispatches", "GET,HEAD"),
            ("/api/sessions/s1/user-input/dismiss", "POST"),
            ("/api/sessions/s1/queue", "GET,HEAD"),
            ("/api/sessions/s1/queue/action", "POST"),
            ("/api/v1/sessions/s1/waits", "GET,HEAD"),
        ];
        for (path, allow) in measured {
            assert_eq!(allow_for(path).as_deref(), Some(allow), "{path}");
            assert_eq!(options_share(path).as_deref(), Some(allow), "{path}");
        }
    }

    #[test]
    fn options_is_claimed_for_every_registered_path_with_its_guard() {
        for layer in LAYERS {
            let path = sample_path(layer);
            match route("OPTIONS", &path) {
                Some(Route::Options {
                    allow,
                    guard_segment,
                }) => {
                    assert_eq!(Some(allow), allow_for(&path).as_deref(), "{path}");
                    let parts = segments(&path).unwrap();
                    assert_eq!(guard_segment, guard_index(&parts), "{path}");
                    let expected = if layer.segs[0] == "v1" {
                        Some(2)
                    } else if layer.segs[0] == "sessions" {
                        Some(1)
                    } else {
                        None
                    };
                    assert_eq!(guard_segment, expected, "{path}");
                }
                other => panic!("{path}: {other:?}"),
            }
        }
    }

    #[test]
    fn every_computed_allow_value_is_interned() {
        for layer in LAYERS {
            let path = sample_path(layer);
            let allow = allow_for(&path).expect("registered path");
            assert_eq!(intern(&allow), allow, "{path} -> {allow}");
        }
        assert_eq!(intern("nope"), "");
    }

    #[test]
    fn guard_segment_follows_the_session_id_in_both_envelopes() {
        assert_eq!(guard_index(&["sessions", "s1", "queue"]), Some(1));
        assert_eq!(guard_index(&["v1", "sessions", "s1", "waits"]), Some(2));
        assert_eq!(guard_index(&["aux", "status"]), None);
        assert_eq!(guard_index(&["goal", "precheck"]), None);
        assert_eq!(guard_index(&["settings", "goal"]), None);
        assert!(is_v1(&["v1", "sessions", "s1", "waits"]));
        assert!(!is_v1(&["sessions", "s1", "queue"]));
        assert!(Route::V1SessionWaits.v1());
        assert!(!Route::SessionQueue.v1());
    }

    #[test]
    fn params_index_the_segments_after_the_api_prefix() {
        assert_eq!(Route::SessionQueue.params(), &[("id", 1)]);
        assert_eq!(Route::SessionAuxRun.params(), &[("id", 1), ("runId", 3)]);
        assert_eq!(
            Route::ScheduledMessageDelete.params(),
            &[("id", 1), ("messageId", 3)]
        );
        assert_eq!(Route::V1SessionWaits.params(), &[("id", 2)]);
        assert_eq!(Route::AuxStatus.params(), &[]);
        assert_eq!(Route::GoalPrecheck.params(), &[]);
        // Every declared param index points at a `:param` segment of its layer.
        for layer in LAYERS {
            for (name, index) in layer.kind.params() {
                assert_eq!(
                    layer.segs.get(*index).copied(),
                    Some(format!(":{name}").as_str()),
                    "{:?}",
                    layer.kind
                );
            }
            let declared = layer.kind.params().len();
            let actual = layer.segs.iter().filter(|seg| seg.starts_with(':')).count();
            assert_eq!(declared, actual, "{:?}", layer.kind);
        }
    }

    #[test]
    fn only_mutating_routes_are_writes_and_long_polls_do_not_serialize() {
        for layer in LAYERS {
            assert_eq!(
                layer.kind.is_write(),
                layer.method != "GET",
                "{:?}",
                layer.kind
            );
        }
        assert!(!Route::Options {
            allow: "POST",
            guard_segment: None
        }
        .is_write());
        // The Aux waiters and their canceller must stay concurrent.
        for kind in [Route::AuxEnqueue, Route::AuxCancel, Route::GoalPrecheck] {
            assert!(kind.is_write());
            assert!(!kind.serializes(), "{kind:?}");
        }
        for kind in [
            Route::AuxConfigPost,
            Route::SettingsGoalPost,
            Route::UnattendedPost,
            Route::ScheduledMessagePost,
            Route::ScheduledMessageDelete,
            Route::UserInputDismiss,
            Route::SessionQueueAction,
        ] {
            assert!(kind.serializes(), "{kind:?}");
        }
        assert!(Route::AuxEnqueue.long_poll());
        assert!(Route::GoalPrecheck.long_poll());
        assert!(!Route::AuxCancel.long_poll());
        assert!(!Route::SessionQueueAction.long_poll());
    }

    #[test]
    fn every_route_has_a_distinct_op_and_uses_the_global_parser() {
        let mut seen = std::collections::HashSet::new();
        for layer in LAYERS {
            assert_eq!(layer.kind.body_parser(), BodyParser::Global);
            assert!(seen.insert(layer.kind.op().unwrap()), "{:?}", layer.kind);
        }
        assert_eq!(seen.len(), 30);
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
    fn query_keys_cover_what_the_handlers_read() {
        for key in [
            "messageId",
            "taskId",
            "limit",
            "relation",
            "activeOnly",
            "recentTerminalLimit",
            "taskIds",
            // The resolve callback's first token source.
            "token",
        ] {
            assert!(QUERY_KEYS.contains(&key), "{key}");
        }
        assert_eq!(QUERY_KEYS.len(), 8);
    }

    #[test]
    fn unrelated_paths_are_untouched() {
        for path in [
            "/",
            "/api",
            "/api/",
            "/api/aux",
            "/api/goal",
            "/api/settings",
        ] {
            assert_eq!(route("GET", path), None, "{path}");
            assert_eq!(allow_for(path), None, "{path}");
        }
    }
}
