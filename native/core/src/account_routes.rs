//! Path matching for the account / credential route cluster retired from
//! `src/routes/claude-accounts.js`, `codex-accounts.js`, `zcode-auth.js`,
//! `cli-key-accounts.js`, `kimi-auth.js`, `claude-oauth.js`, `codex-oauth.js`
//! and `commandcode-auth.js`:
//!
//! * `GET|HEAD|POST        /api/claude/accounts`
//! * `POST                 /api/claude/accounts/:id/activate`
//! * `GET|HEAD             /api/claude/accounts/:id/login-status`
//! * `POST                 /api/claude/accounts/:id/login-callback`
//! * `POST                 /api/claude/accounts/:id/relogin`
//! * `DELETE               /api/claude/accounts/:id`
//! * `GET|HEAD             /api/claude/accounts/:id/quota`
//! * `GET|HEAD|POST        /api/codex/accounts`
//! * `POST                 /api/codex/accounts/:id/activate`
//! * `GET|HEAD             /api/codex/accounts/:id/login-status`
//! * `POST                 /api/codex/accounts/:id/login-callback`
//! * `POST                 /api/codex/accounts/:id/relogin`
//! * `DELETE               /api/codex/accounts/:id`
//! * `GET|HEAD|PUT         /api/zcode/auth`
//! * `POST                 /api/zcode/auth/sync`
//! * `GET|HEAD             /api/zcode/auth/check`
//! * `GET|HEAD             /api/cli-accounts/:cli`
//! * `POST                 /api/cli-accounts/:cli`
//! * `PATCH|DELETE         /api/cli-accounts/:cli/:id`
//! * `GET|HEAD|PUT         /api/kimi/auth`
//! * `GET|HEAD             /api/kimi/auth/check`
//! * `GET|HEAD             /api/claude/oauth/status`
//! * `POST                 /api/claude/oauth/login`
//! * `GET|HEAD             /api/codex/oauth/status`
//! * `POST                 /api/codex/oauth/login`
//! * `GET|HEAD             /api/commandcode/auth/status`
//! * `POST                 /api/commandcode/auth/login`
//!
//! Two routes deliberately keep running in Node and are **not** claimed:
//! `POST /api/zcode/auth/login` and `POST /api/kimi/auth/login`. Both block for
//! up to five minutes waiting for a child process (the OAuth login terminal /
//! the managed browser surface) to report back, then answer from the captured
//! child output. A host-port round trip has a 60 s ceiling, so they cannot ride
//! the JSON port without changing the observable timeout; serving them from the
//! front door would also make a 5-minute request occupy a connection the real
//! child has to keep open. They stay whole (public route + handler) in Node,
//! re-mounted publicly as a login-only subset, so the front door claims neither
//! the request nor its automatic `OPTIONS`: everything about those paths is
//! forwarded.
//!
//! Everything a route needs to match exactly like Express — literal segments
//! case-insensitively, parameters as `[^/]+?`, one optional trailing slash, and
//! the automatic `OPTIONS` `Allow` union in registration order with `HEAD`
//! after each `GET` — lives here. Nothing reads a clock or the filesystem, so
//! it is unit-testable in isolation.
//!
//! Claim order against the neighbouring clusters is load-bearing and is why
//! this matcher answers only its own literals and returns `None` for everything
//! else:
//!
//! * `GET|HEAD /api/claude/models` stays with `model_catalogs`; this cluster
//!   only matches `accounts` as the second segment.
//! * `GET|HEAD /api/codex/models` and `POST /api/codex/models/sync` likewise.
//! * Any `/api/...` path with the same segment count but a different literal
//!   (e.g. `/api/providers/:id/quota`) is not matched here.
//!
//! Within this cluster every pattern of the same segment count differs only in
//! a *literal* tail (`activate`, `login-status`, `login-callback`, `relogin`,
//! `quota`, `sync`, `check`), or in method (`GET|POST` list vs `DELETE :id`),
//! so first-match order cannot change which handler Express picked. That is
//! asserted by the `claim()` unit tests.

/// One claimed route. `Options` is Express's automatic responder for a path
/// this cluster registers; its `Allow` value comes from [`allow_for`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    ClaudeAccountsGet,
    ClaudeAccountsPost,
    ClaudeAccountActivate,
    ClaudeAccountLoginStatus,
    ClaudeAccountLoginCallback,
    ClaudeAccountRelogin,
    ClaudeAccountDelete,
    ClaudeAccountQuota,
    CodexAccountsGet,
    CodexAccountsPost,
    CodexAccountActivate,
    CodexAccountLoginStatus,
    CodexAccountLoginCallback,
    CodexAccountRelogin,
    CodexAccountDelete,
    ZcodeAuthGet,
    ZcodeAuthSync,
    ZcodeAuthPut,
    ZcodeAuthCheck,
    CliAccountsGet,
    CliAccountsPost,
    CliAccountPatch,
    CliAccountDelete,
    KimiAuthGet,
    KimiAuthCheck,
    KimiAuthPut,
    ClaudeOauthStatus,
    ClaudeOauthLogin,
    CodexOauthStatus,
    CodexOauthLogin,
    CommandcodeAuthStatus,
    CommandcodeAuthLogin,
    /// Express's automatic `OPTIONS` for a path this cluster owns.
    Options,
}

impl Route {
    /// The host-port operation the front door asks Node for. `Options` never
    /// reaches the host.
    pub fn op(self) -> Option<&'static str> {
        Some(match self {
            Route::ClaudeAccountsGet => "claude-accounts-list",
            Route::ClaudeAccountsPost => "claude-accounts-create",
            Route::ClaudeAccountActivate => "claude-account-activate",
            Route::ClaudeAccountLoginStatus => "claude-account-login-status",
            Route::ClaudeAccountLoginCallback => "claude-account-login-callback",
            Route::ClaudeAccountRelogin => "claude-account-relogin",
            Route::ClaudeAccountDelete => "claude-account-delete",
            Route::ClaudeAccountQuota => "claude-account-quota",
            Route::CodexAccountsGet => "codex-accounts-list",
            Route::CodexAccountsPost => "codex-accounts-create",
            Route::CodexAccountActivate => "codex-account-activate",
            Route::CodexAccountLoginStatus => "codex-account-login-status",
            Route::CodexAccountLoginCallback => "codex-account-login-callback",
            Route::CodexAccountRelogin => "codex-account-relogin",
            Route::CodexAccountDelete => "codex-account-delete",
            Route::ZcodeAuthGet => "zcode-auth-status",
            Route::ZcodeAuthSync => "zcode-auth-sync",
            Route::ZcodeAuthPut => "zcode-auth-put",
            Route::ZcodeAuthCheck => "zcode-auth-check",
            Route::CliAccountsGet => "cli-accounts-list",
            Route::CliAccountsPost => "cli-accounts-create",
            Route::CliAccountPatch => "cli-account-patch",
            Route::CliAccountDelete => "cli-account-delete",
            Route::KimiAuthGet => "kimi-auth-status",
            Route::KimiAuthCheck => "kimi-auth-check",
            Route::KimiAuthPut => "kimi-auth-put",
            Route::ClaudeOauthStatus => "claude-oauth-status",
            Route::ClaudeOauthLogin => "claude-oauth-login",
            Route::CodexOauthStatus => "codex-oauth-status",
            Route::CodexOauthLogin => "codex-oauth-login",
            Route::CommandcodeAuthStatus => "commandcode-auth-status",
            Route::CommandcodeAuthLogin => "commandcode-auth-login",
            Route::Options => return None,
        })
    }

    /// Whether the retired handler mutates process state (a keychain write, an
    /// account record, a login-terminal session). Those are serialized behind
    /// the cluster write lock so the single-threaded Node semantics survive.
    pub fn is_write(self) -> bool {
        matches!(
            self,
            Route::ClaudeAccountsPost
                | Route::ClaudeAccountActivate
                | Route::ClaudeAccountLoginCallback
                | Route::ClaudeAccountRelogin
                | Route::ClaudeAccountDelete
                | Route::CodexAccountsPost
                | Route::CodexAccountActivate
                | Route::CodexAccountLoginCallback
                | Route::CodexAccountRelogin
                | Route::CodexAccountDelete
                | Route::ZcodeAuthSync
                | Route::ZcodeAuthPut
                | Route::CliAccountsPost
                | Route::CliAccountPatch
                | Route::CliAccountDelete
                | Route::KimiAuthPut
                | Route::ClaudeOauthLogin
                | Route::CodexOauthLogin
                | Route::CommandcodeAuthLogin
        )
    }

    /// The path parameters this route carries, as `(name, segment index)`
    /// relative to [`segments`] (i.e. after the `/api/` prefix). The front door
    /// percent-decodes each one before handing it to the host port — Express
    /// decoded `req.params` the same way.
    pub fn params(self) -> &'static [(&'static str, usize)] {
        match self {
            Route::CliAccountsGet | Route::CliAccountsPost => &[("cli", 1)],
            Route::CliAccountPatch | Route::CliAccountDelete => &[("cli", 1), ("id", 2)],
            Route::ClaudeAccountActivate
            | Route::ClaudeAccountLoginStatus
            | Route::ClaudeAccountLoginCallback
            | Route::ClaudeAccountRelogin
            | Route::ClaudeAccountDelete
            | Route::ClaudeAccountQuota
            | Route::CodexAccountActivate
            | Route::CodexAccountLoginStatus
            | Route::CodexAccountLoginCallback
            | Route::CodexAccountRelogin
            | Route::CodexAccountDelete => &[("id", 2)],
            _ => &[],
        }
    }
}

struct Layer {
    segs: &'static [&'static str],
    method: &'static str,
    kind: Route,
}

/// Registration order of the retired mounts in `server.js`: cli-key-accounts,
/// commandcode-auth, codex-oauth + codex-accounts, claude-accounts, claude-oauth,
/// zcode-auth, kimi-auth. Order matters only inside one path, where it fixes the
/// `Allow` order (`GET,HEAD,PUT`, `PATCH,DELETE`, …).
static LAYERS: &[Layer] = &[
    Layer {
        segs: &["cli-accounts", ":cli"],
        method: "GET",
        kind: Route::CliAccountsGet,
    },
    Layer {
        segs: &["cli-accounts", ":cli"],
        method: "POST",
        kind: Route::CliAccountsPost,
    },
    Layer {
        segs: &["cli-accounts", ":cli", ":id"],
        method: "PATCH",
        kind: Route::CliAccountPatch,
    },
    Layer {
        segs: &["cli-accounts", ":cli", ":id"],
        method: "DELETE",
        kind: Route::CliAccountDelete,
    },
    Layer {
        segs: &["commandcode", "auth", "status"],
        method: "GET",
        kind: Route::CommandcodeAuthStatus,
    },
    Layer {
        segs: &["commandcode", "auth", "login"],
        method: "POST",
        kind: Route::CommandcodeAuthLogin,
    },
    Layer {
        segs: &["codex", "oauth", "status"],
        method: "GET",
        kind: Route::CodexOauthStatus,
    },
    Layer {
        segs: &["codex", "oauth", "login"],
        method: "POST",
        kind: Route::CodexOauthLogin,
    },
    Layer {
        segs: &["codex", "accounts"],
        method: "GET",
        kind: Route::CodexAccountsGet,
    },
    Layer {
        segs: &["codex", "accounts"],
        method: "POST",
        kind: Route::CodexAccountsPost,
    },
    Layer {
        segs: &["codex", "accounts", ":id", "activate"],
        method: "POST",
        kind: Route::CodexAccountActivate,
    },
    Layer {
        segs: &["codex", "accounts", ":id", "login-status"],
        method: "GET",
        kind: Route::CodexAccountLoginStatus,
    },
    Layer {
        segs: &["codex", "accounts", ":id", "login-callback"],
        method: "POST",
        kind: Route::CodexAccountLoginCallback,
    },
    Layer {
        segs: &["codex", "accounts", ":id", "relogin"],
        method: "POST",
        kind: Route::CodexAccountRelogin,
    },
    Layer {
        segs: &["codex", "accounts", ":id"],
        method: "DELETE",
        kind: Route::CodexAccountDelete,
    },
    Layer {
        segs: &["claude", "accounts"],
        method: "GET",
        kind: Route::ClaudeAccountsGet,
    },
    Layer {
        segs: &["claude", "accounts"],
        method: "POST",
        kind: Route::ClaudeAccountsPost,
    },
    Layer {
        segs: &["claude", "accounts", ":id", "activate"],
        method: "POST",
        kind: Route::ClaudeAccountActivate,
    },
    Layer {
        segs: &["claude", "accounts", ":id", "login-status"],
        method: "GET",
        kind: Route::ClaudeAccountLoginStatus,
    },
    Layer {
        segs: &["claude", "accounts", ":id", "login-callback"],
        method: "POST",
        kind: Route::ClaudeAccountLoginCallback,
    },
    Layer {
        segs: &["claude", "accounts", ":id", "relogin"],
        method: "POST",
        kind: Route::ClaudeAccountRelogin,
    },
    Layer {
        segs: &["claude", "accounts", ":id"],
        method: "DELETE",
        kind: Route::ClaudeAccountDelete,
    },
    Layer {
        segs: &["claude", "accounts", ":id", "quota"],
        method: "GET",
        kind: Route::ClaudeAccountQuota,
    },
    Layer {
        segs: &["claude", "oauth", "status"],
        method: "GET",
        kind: Route::ClaudeOauthStatus,
    },
    Layer {
        segs: &["claude", "oauth", "login"],
        method: "POST",
        kind: Route::ClaudeOauthLogin,
    },
    Layer {
        segs: &["zcode", "auth"],
        method: "GET",
        kind: Route::ZcodeAuthGet,
    },
    Layer {
        segs: &["zcode", "auth"],
        method: "PUT",
        kind: Route::ZcodeAuthPut,
    },
    Layer {
        segs: &["zcode", "auth", "sync"],
        method: "POST",
        kind: Route::ZcodeAuthSync,
    },
    Layer {
        segs: &["zcode", "auth", "check"],
        method: "GET",
        kind: Route::ZcodeAuthCheck,
    },
    Layer {
        segs: &["kimi", "auth"],
        method: "GET",
        kind: Route::KimiAuthGet,
    },
    Layer {
        segs: &["kimi", "auth"],
        method: "PUT",
        kind: Route::KimiAuthPut,
    },
    Layer {
        segs: &["kimi", "auth", "check"],
        method: "GET",
        kind: Route::KimiAuthCheck,
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
/// from the GET handler); `OPTIONS` is the automatic responder for any path this
/// cluster registers.
pub fn claim(method: &str, path: &str) -> Option<Route> {
    let parts = segments(path)?;
    if method.eq_ignore_ascii_case("OPTIONS") {
        return LAYERS
            .iter()
            .any(|layer| layer_matches(layer, &parts))
            .then_some(Route::Options);
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

/// Express's automatic OPTIONS `Allow` value for `path`: the union of the
/// methods registered on this exact path in registration order, each `GET`
/// followed by `HEAD`.
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

/// This cluster's share of Express's automatic `OPTIONS` `Allow`, for the
/// front-door union across clusters (`super::OPTIONS_SOURCES`).
pub fn options_share(path: &str) -> Option<String> {
    allow_for(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims() -> Vec<(&'static str, &'static str, Route)> {
        use Route::*;
        vec![
            ("GET", "/api/claude/accounts", ClaudeAccountsGet),
            ("POST", "/api/claude/accounts", ClaudeAccountsPost),
            (
                "POST",
                "/api/claude/accounts/a1/activate",
                ClaudeAccountActivate,
            ),
            (
                "GET",
                "/api/claude/accounts/a1/login-status",
                ClaudeAccountLoginStatus,
            ),
            (
                "POST",
                "/api/claude/accounts/a1/login-callback",
                ClaudeAccountLoginCallback,
            ),
            (
                "POST",
                "/api/claude/accounts/a1/relogin",
                ClaudeAccountRelogin,
            ),
            ("DELETE", "/api/claude/accounts/a1", ClaudeAccountDelete),
            ("GET", "/api/claude/accounts/a1/quota", ClaudeAccountQuota),
            ("GET", "/api/codex/accounts", CodexAccountsGet),
            ("POST", "/api/codex/accounts", CodexAccountsPost),
            (
                "POST",
                "/api/codex/accounts/c1/activate",
                CodexAccountActivate,
            ),
            (
                "GET",
                "/api/codex/accounts/c1/login-status",
                CodexAccountLoginStatus,
            ),
            (
                "POST",
                "/api/codex/accounts/c1/login-callback",
                CodexAccountLoginCallback,
            ),
            (
                "POST",
                "/api/codex/accounts/c1/relogin",
                CodexAccountRelogin,
            ),
            ("DELETE", "/api/codex/accounts/c1", CodexAccountDelete),
            ("GET", "/api/zcode/auth", ZcodeAuthGet),
            ("PUT", "/api/zcode/auth", ZcodeAuthPut),
            ("POST", "/api/zcode/auth/sync", ZcodeAuthSync),
            ("GET", "/api/zcode/auth/check", ZcodeAuthCheck),
            ("GET", "/api/cli-accounts/claude", CliAccountsGet),
            ("POST", "/api/cli-accounts/claude", CliAccountsPost),
            ("PATCH", "/api/cli-accounts/claude/k1", CliAccountPatch),
            ("DELETE", "/api/cli-accounts/claude/k1", CliAccountDelete),
            ("GET", "/api/kimi/auth", KimiAuthGet),
            ("PUT", "/api/kimi/auth", KimiAuthPut),
            ("GET", "/api/kimi/auth/check", KimiAuthCheck),
            ("GET", "/api/claude/oauth/status", ClaudeOauthStatus),
            ("POST", "/api/claude/oauth/login", ClaudeOauthLogin),
            ("GET", "/api/codex/oauth/status", CodexOauthStatus),
            ("POST", "/api/codex/oauth/login", CodexOauthLogin),
            ("GET", "/api/commandcode/auth/status", CommandcodeAuthStatus),
            ("POST", "/api/commandcode/auth/login", CommandcodeAuthLogin),
        ]
    }

    #[test]
    fn claims_every_route() {
        let table = claims();
        assert_eq!(table.len(), 32, "the cluster retires 32 public routes");
        for (method, path, route) in table {
            assert_eq!(claim(method, path), Some(route), "{method} {path}");
        }
    }

    #[test]
    fn every_non_options_route_has_an_op_and_options_has_none() {
        for (_, _, route) in claims() {
            let op = route.op().unwrap_or_else(|| panic!("{route:?} has no op"));
            assert!(!op.is_empty());
        }
        assert_eq!(Route::Options.op(), None);
    }

    #[test]
    fn ops_are_unique() {
        let mut seen = std::collections::BTreeSet::new();
        for (_, _, route) in claims() {
            let op = route.op().unwrap();
            assert!(seen.insert(op), "duplicate op {op}");
        }
        assert_eq!(seen.len(), 32);
    }

    #[test]
    fn head_follows_get_only_on_read_routes() {
        assert_eq!(
            claim("HEAD", "/api/claude/accounts"),
            Some(Route::ClaudeAccountsGet)
        );
        assert_eq!(
            claim("HEAD", "/api/claude/accounts/a/quota"),
            Some(Route::ClaudeAccountQuota)
        );
        assert_eq!(claim("HEAD", "/api/zcode/auth"), Some(Route::ZcodeAuthGet));
        // No GET handler exists on the mutating paths.
        assert_eq!(claim("HEAD", "/api/claude/accounts/a1/activate"), None);
        assert_eq!(claim("HEAD", "/api/zcode/auth/sync"), None);
        assert_eq!(claim("HEAD", "/api/cli-accounts/claude/k1"), None);
    }

    #[test]
    fn unclaimed_paths_stay_with_their_owner() {
        // Neighbouring clusters on the same `/api/<vendor>/...` prefixes.
        assert_eq!(claim("GET", "/api/claude/models"), None);
        assert_eq!(claim("GET", "/api/codex/models"), None);
        assert_eq!(claim("POST", "/api/codex/models/sync"), None);
        assert_eq!(claim("GET", "/api/providers/p1/quota"), None);
        assert_eq!(claim("GET", "/api/sessions/s1"), None);
        // Same shape, different literal tail.
        assert_eq!(claim("POST", "/api/claude/accounts/a1/unknown"), None);
        assert_eq!(claim("GET", "/api/codex/auth"), None);
        // Wrong prefixes.
        assert_eq!(claim("GET", "/api/claude"), None);
        assert_eq!(claim("GET", "/v1/claude/accounts"), None);
    }

    #[test]
    fn the_two_forwarded_login_routes_are_not_claimed() {
        // `POST /api/zcode/auth/login` and `POST /api/kimi/auth/login` stay in
        // Node: they block up to five minutes on a child process.
        assert_eq!(claim("POST", "/api/zcode/auth/login"), None);
        assert_eq!(claim("POST", "/api/kimi/auth/login"), None);
        // The whole path is forwarded, its automatic OPTIONS included: Node's
        // login-only public mount answers `Allow: POST`.
        assert_eq!(allow_for("/api/zcode/auth/login"), None);
        assert_eq!(allow_for("/api/kimi/auth/login"), None);
        assert_eq!(claim("OPTIONS", "/api/zcode/auth/login"), None);
        assert_eq!(claim("OPTIONS", "/api/kimi/auth/login"), None);
    }

    #[test]
    fn trailing_slash_is_tolerated_and_interior_empty_is_not() {
        assert_eq!(
            claim("GET", "/api/claude/accounts/"),
            Some(Route::ClaudeAccountsGet)
        );
        assert_eq!(
            claim("GET", "/api/claude/accounts/a1/quota/"),
            Some(Route::ClaudeAccountQuota)
        );
        assert_eq!(claim("GET", "/api/claude//accounts"), None);
        assert_eq!(claim("GET", "/api/claude/accounts//a1/quota"), None);
    }

    #[test]
    fn literals_are_case_insensitive_and_params_match_any_non_empty_segment() {
        assert_eq!(
            claim("GET", "/API/CLAUDE/accounts"),
            None,
            "/api/ prefix is exact"
        );
        assert_eq!(
            claim("GET", "/api/Claude/Accounts"),
            Some(Route::ClaudeAccountsGet)
        );
        assert_eq!(
            claim("GET", "/api/claude/accounts/weird%20id/quota"),
            Some(Route::ClaudeAccountQuota)
        );
    }

    #[test]
    fn allow_union_matches_express_registration_order() {
        let table = [
            ("/api/claude/accounts", "GET,HEAD,POST"),
            ("/api/claude/accounts/a1", "DELETE"),
            ("/api/claude/accounts/a1/activate", "POST"),
            ("/api/claude/accounts/a1/login-status", "GET,HEAD"),
            ("/api/claude/accounts/a1/login-callback", "POST"),
            ("/api/claude/accounts/a1/relogin", "POST"),
            ("/api/claude/accounts/a1/quota", "GET,HEAD"),
            ("/api/codex/accounts", "GET,HEAD,POST"),
            ("/api/codex/accounts/c1", "DELETE"),
            ("/api/codex/accounts/c1/activate", "POST"),
            ("/api/codex/accounts/c1/login-status", "GET,HEAD"),
            ("/api/codex/accounts/c1/login-callback", "POST"),
            ("/api/codex/accounts/c1/relogin", "POST"),
            ("/api/zcode/auth", "GET,HEAD,PUT"),
            ("/api/zcode/auth/sync", "POST"),
            ("/api/zcode/auth/check", "GET,HEAD"),
            ("/api/cli-accounts/claude", "GET,HEAD,POST"),
            ("/api/cli-accounts/claude/k1", "PATCH,DELETE"),
            ("/api/kimi/auth", "GET,HEAD,PUT"),
            ("/api/kimi/auth/check", "GET,HEAD"),
            ("/api/claude/oauth/status", "GET,HEAD"),
            ("/api/claude/oauth/login", "POST"),
            ("/api/codex/oauth/status", "GET,HEAD"),
            ("/api/codex/oauth/login", "POST"),
            ("/api/commandcode/auth/status", "GET,HEAD"),
            ("/api/commandcode/auth/login", "POST"),
        ];
        for (path, allow) in table {
            assert_eq!(allow_for(path).as_deref(), Some(allow), "{path}");
            assert_eq!(options_share(path), allow_for(path), "{path}");
        }
        assert_eq!(allow_for("/api/claude/models"), None);
        // Forwarded wholesale (login-only subset kept in Node).
        assert_eq!(allow_for("/api/zcode/auth/login"), None);
        assert_eq!(allow_for("/api/kimi/auth/login"), None);
    }

    #[test]
    fn same_segment_collisions_disambiguate_by_literal_tail_and_method() {
        use Route::*;
        // Four-segment `/api/claude/accounts/:id/<tail>` shapes.
        for (tail, route) in [
            ("activate", ClaudeAccountActivate),
            ("login-status", ClaudeAccountLoginStatus),
            ("login-callback", ClaudeAccountLoginCallback),
            ("relogin", ClaudeAccountRelogin),
            ("quota", ClaudeAccountQuota),
        ] {
            let method = match route {
                ClaudeAccountLoginStatus => "GET",
                ClaudeAccountActivate | ClaudeAccountLoginCallback | ClaudeAccountRelogin => "POST",
                ClaudeAccountQuota => "GET",
                _ => unreachable!(),
            };
            assert_eq!(
                claim(method, &format!("/api/claude/accounts/:id/{tail}")),
                Some(route),
                "{tail}"
            );
        }
        // Three-segment `/api/claude/accounts/:id` answers DELETE only; the
        // literal `accounts` list paths are a segment shorter.
        assert_eq!(
            claim("DELETE", "/api/claude/accounts/x"),
            Some(ClaudeAccountDelete)
        );
        assert_eq!(claim("GET", "/api/claude/accounts/x"), None);
        assert_eq!(claim("POST", "/api/claude/accounts/x"), None);
        // `/api/codex/accounts/:id` collides with nothing in `codex/oauth`.
        assert_eq!(
            claim("DELETE", "/api/codex/accounts/x"),
            Some(CodexAccountDelete)
        );
        assert_eq!(
            claim("GET", "/api/codex/oauth/status"),
            Some(CodexOauthStatus)
        );
        // `/api/zcode/auth` GET|PUT vs `/api/zcode/auth/check` GET.
        assert_eq!(claim("PUT", "/api/zcode/auth"), Some(ZcodeAuthPut));
        assert_eq!(claim("GET", "/api/zcode/auth/check"), Some(ZcodeAuthCheck));
        // `/api/cli-accounts/:cli` vs `:cli/:id`.
        assert_eq!(
            claim("POST", "/api/cli-accounts/claude"),
            Some(CliAccountsPost)
        );
        assert_eq!(
            claim("PATCH", "/api/cli-accounts/claude/k1"),
            Some(CliAccountPatch)
        );
    }

    #[test]
    fn params_index_the_decoded_segments() {
        assert_eq!(Route::ClaudeAccountQuota.params(), &[("id", 2)]);
        assert_eq!(Route::CodexAccountDelete.params(), &[("id", 2)]);
        assert_eq!(Route::CliAccountsGet.params(), &[("cli", 1)]);
        assert_eq!(Route::CliAccountDelete.params(), &[("cli", 1), ("id", 2)]);
        assert_eq!(Route::ZcodeAuthGet.params(), &[]);
        assert_eq!(Route::ClaudeAccountsGet.params(), &[]);
        assert_eq!(Route::CommandcodeAuthLogin.params(), &[]);

        let parts = segments("/api/claude/accounts/a1/quota").unwrap();
        let (name, index) = Route::ClaudeAccountQuota.params()[0];
        assert_eq!(name, "id");
        assert_eq!(parts[index], "a1");
    }

    #[test]
    fn only_mutating_methods_are_writes() {
        for (method, path, route) in claims() {
            let expected = !matches!(method, "GET" | "HEAD");
            assert_eq!(route.is_write(), expected, "{method} {path}");
        }
        // A read that does network I/O (the quota probe) must not take the
        // write lock.
        assert!(!Route::ClaudeAccountQuota.is_write());
        // The two OAuth status reads close a stale login session as a side
        // effect inside Node; they are still reads from the front door's point
        // of view and must not serialize behind the write lock.
        assert!(!Route::ClaudeOauthStatus.is_write());
        assert!(!Route::CodexOauthStatus.is_write());
    }

    #[test]
    fn options_is_claimed_for_every_registered_path() {
        for (_, path, _) in claims() {
            assert_eq!(claim("OPTIONS", path), Some(Route::Options), "{path}");
        }
        assert_eq!(claim("OPTIONS", "/api/claude/models"), None);
    }

    #[test]
    fn credential_identifiers_are_the_only_path_parameters() {
        // The front door only ever forwards opaque identifiers (`id`, `cli`)
        // taken from the URL — never a body field, header or query value. This
        // is the front-door half of the "credentials never appear in a public
        // response" guarantee: secrets stay inside the Node handlers, which
        // project the store to credential-free DTOs before answering.
        for (_, _, route) in claims() {
            for (name, _) in route.params() {
                assert!(
                    matches!(*name, "id" | "cli"),
                    "{route:?} forwards unexpected path parameter {name}"
                );
            }
        }
    }
}
