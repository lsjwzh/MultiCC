//! Path matching for the host-and-system-operations cluster retired from
//! `src/routes/{server-restart-route,update-route,developer-tools,macos-privacy,
//! ops-terminal,host-write,host-power,skill-sync,doctor,env-doctor}.js`:
//!
//! * `POST                 /api/restart`, `/api/desktop-shutdown`
//! * `GET|HEAD             /api/update/status`
//! * `POST                 /api/update`
//! * `GET|HEAD             /api/system/developer-tools`
//! * `POST                 /api/system/developer-tools/install`
//! * `GET|HEAD             /api/system/developer-tools/install-git`
//! * `POST                 /api/system/developer-tools/install-git`
//! * `GET|HEAD             /api/system/disk-access`
//! * `POST                 /api/system/disk-access/open`
//! * `GET|HEAD             /api/system/agent-permissions`
//! * `POST                 /api/system/agent-permissions/open`
//! * `POST                 /api/system/agent-permissions/restart`
//! * `GET|HEAD             /api/system/agent-install`
//! * `POST                 /api/system/agent-install/replace`
//! * `GET|HEAD             /api/system/ops-env`
//! * `GET|HEAD|POST        /api/system/ops-run`
//! * `POST                 /api/system/ops-run/stop`
//! * `POST                 /api/settings/notify`, `/api/settings/tunnel`
//! * `POST                 /api/tunnel/restart/:provider`
//! * `POST                 /api/tunnel/sakurafrp/public-url`
//! * `POST                 /api/tunnel/funnel`
//! * `POST                 /api/settings/access-token`
//! * `POST                 /api/settings/power`
//! * `POST                 /api/settings/power/auto-unlock`
//! * `POST|DELETE          /api/settings/power/unlock-password`
//! * `POST                 /api/settings/power/unlock-password/authorize`
//! * `POST                 /api/settings/task-attribution`
//! * `GET|HEAD             /api/skill-sync/status`
//! * `POST                 /api/skill-sync/run`
//! * `POST                 /api/system/env-doctor`
//! * `GET|HEAD             /api/system/env-doctor/:runId`
//! * `POST                 /api/system/env-doctor/:runId/cancel`
//! * `POST                 /api/sessions/:id/doctor`
//! * `GET|HEAD             /api/sessions/:id/doctor`
//! * `GET|HEAD             /api/doctor/runs/:runId`
//! * `POST                 /api/doctor/runs/:runId/cancel`
//!
//! Matching rules are the same Express-compatible ones every cluster uses:
//! literal segments case-insensitively, a `:param` as `[^/]+?`, one optional
//! trailing slash, the raw (undecoded) path, and the automatic `OPTIONS`
//! `Allow` union in registration order with `HEAD` right after each `GET`.
//!
//! Two `Allow` values are **shared** with another cluster and are therefore
//! answered by the front door's union mechanism, not here
//! (`super::OPTIONS_SOURCES`): five `/api/settings/*` and `/api/tunnel/funnel`
//! paths also have the host-read `GET`, and `/api/settings/task-attribution`
//! also has the task-surface `GET`. [`allow_for`] returns only the methods this
//! cluster registers, which the union merges in registration order.
//!
//! Nothing here touches the filesystem or a clock. The one path parameter that
//! ultimately names an external thing, `:provider`, is an opaque token the
//! retired handler validated against a fixed whitelist; a decoded `/`, `..` or
//! `%2e%2e` therefore never becomes a path segment — it stays inside the
//! single segment the matcher captured.

/// One claimed route. `Options` is Express's automatic responder for a path
/// this cluster registers; `allow` is this cluster's share of the whole-path
/// `Allow`, and `guard_segment` names the `:id` segment the
/// `publicSessionAccessGuard` `app.use` layer observes before it (the two
/// `/api/sessions/:id/doctor` routes only).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Restart,
    DesktopShutdown,
    UpdateStatus,
    Update,
    DeveloperToolsStatus,
    DeveloperToolsInstall,
    DeveloperToolsInstallGitStatus,
    DeveloperToolsInstallGit,
    DiskAccess,
    DiskAccessOpen,
    AgentPermissions,
    AgentPermissionsOpen,
    AgentPermissionsRestart,
    AgentInstall,
    AgentInstallReplace,
    OpsEnv,
    OpsRunStatus,
    OpsRunStart,
    OpsRunStop,
    SettingsNotify,
    SettingsTunnel,
    TunnelRestart,
    TunnelSakurafrpPublicUrl,
    TunnelFunnel,
    SettingsAccessToken,
    SettingsPower,
    SettingsPowerAutoUnlock,
    SettingsPowerUnlockPasswordSet,
    SettingsPowerUnlockPasswordClear,
    SettingsPowerUnlockPasswordAuthorize,
    SettingsTaskAttribution,
    SkillSyncStatus,
    SkillSyncRun,
    EnvDoctorStart,
    EnvDoctorRun,
    EnvDoctorCancel,
    SessionDoctorStart,
    SessionDoctorList,
    DoctorRun,
    DoctorCancel,
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
            Route::Restart => "restart",
            Route::DesktopShutdown => "desktop-shutdown",
            Route::UpdateStatus => "update-status",
            Route::Update => "update",
            Route::DeveloperToolsStatus => "developer-tools-status",
            Route::DeveloperToolsInstall => "developer-tools-install",
            Route::DeveloperToolsInstallGitStatus => "developer-tools-install-git-status",
            Route::DeveloperToolsInstallGit => "developer-tools-install-git",
            Route::DiskAccess => "disk-access",
            Route::DiskAccessOpen => "disk-access-open",
            Route::AgentPermissions => "agent-permissions",
            Route::AgentPermissionsOpen => "agent-permissions-open",
            Route::AgentPermissionsRestart => "agent-permissions-restart",
            Route::AgentInstall => "agent-install",
            Route::AgentInstallReplace => "agent-install-replace",
            Route::OpsEnv => "ops-env",
            Route::OpsRunStatus => "ops-run-status",
            Route::OpsRunStart => "ops-run-start",
            Route::OpsRunStop => "ops-run-stop",
            Route::SettingsNotify => "settings-notify",
            Route::SettingsTunnel => "settings-tunnel",
            Route::TunnelRestart => "tunnel-restart",
            Route::TunnelSakurafrpPublicUrl => "tunnel-sakurafrp-public-url",
            Route::TunnelFunnel => "tunnel-funnel",
            Route::SettingsAccessToken => "settings-access-token",
            Route::SettingsPower => "settings-power",
            Route::SettingsPowerAutoUnlock => "settings-power-auto-unlock",
            Route::SettingsPowerUnlockPasswordSet => "settings-power-unlock-password-set",
            Route::SettingsPowerUnlockPasswordClear => "settings-power-unlock-password-clear",
            Route::SettingsPowerUnlockPasswordAuthorize => {
                "settings-power-unlock-password-authorize"
            }
            Route::SettingsTaskAttribution => "settings-task-attribution",
            Route::SkillSyncStatus => "skill-sync-status",
            Route::SkillSyncRun => "skill-sync-run",
            Route::EnvDoctorStart => "env-doctor-start",
            Route::EnvDoctorRun => "env-doctor-run",
            Route::EnvDoctorCancel => "env-doctor-cancel",
            Route::SessionDoctorStart => "session-doctor-start",
            Route::SessionDoctorList => "session-doctor-list",
            Route::DoctorRun => "doctor-run",
            Route::DoctorCancel => "doctor-cancel",
            Route::Options { .. } => return None,
        })
    }

    /// Whether the retired handler mutates process or host state. Every
    /// `POST`/`DELETE` in this cluster eventually starts a process, writes the
    /// environment file, changes a macOS setting or mutates the in-memory job
    /// tables; they are serialized behind the cluster write lock so the
    /// single-threaded Node semantics survive. The `GET`s are pure reads
    /// (status polling, permission snapshots, run records).
    pub fn is_write(self) -> bool {
        matches!(
            self,
            Route::Restart
                | Route::DesktopShutdown
                | Route::Update
                | Route::DeveloperToolsInstall
                | Route::DeveloperToolsInstallGit
                | Route::DiskAccessOpen
                | Route::AgentPermissionsOpen
                | Route::AgentPermissionsRestart
                | Route::AgentInstallReplace
                | Route::OpsRunStart
                | Route::OpsRunStop
                | Route::SettingsNotify
                | Route::SettingsTunnel
                | Route::TunnelRestart
                | Route::TunnelSakurafrpPublicUrl
                | Route::TunnelFunnel
                | Route::SettingsAccessToken
                | Route::SettingsPower
                | Route::SettingsPowerAutoUnlock
                | Route::SettingsPowerUnlockPasswordSet
                | Route::SettingsPowerUnlockPasswordClear
                | Route::SettingsPowerUnlockPasswordAuthorize
                | Route::SettingsTaskAttribution
                | Route::SkillSyncRun
                | Route::EnvDoctorStart
                | Route::EnvDoctorCancel
                | Route::SessionDoctorStart
                | Route::DoctorCancel
        )
    }

    /// Every route in this cluster was mounted **after** the global
    /// `express.json({limit:'50mb'})`, so one parser is the whole story.
    pub fn body_parser(self) -> BodyParser {
        BodyParser::Global
    }

    /// The path parameters this route carries, as `(name, segment index)`
    /// relative to [`segments`] (i.e. after the `/api/` prefix). The front door
    /// percent-decodes each one before handing it to the host port — Express
    /// decoded `req.params` the same way.
    pub fn params(self) -> &'static [(&'static str, usize)] {
        match self {
            Route::TunnelRestart => &[("provider", 2)],
            Route::EnvDoctorRun | Route::EnvDoctorCancel => &[("runId", 2)],
            Route::SessionDoctorStart | Route::SessionDoctorList => &[("id", 1)],
            Route::DoctorRun | Route::DoctorCancel => &[("runId", 2)],
            _ => &[],
        }
    }
}

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

/// Registration order of the retired mounts in `server.js`: the restart and
/// update routes, then `mountSystemRoutes` (developer-tools, macos-privacy,
/// ops-terminal), then `mountHostWriteRoutes` (host-write and its nested
/// host-power), then `mountSkillSyncRoutes`, then `mountDoctor` (env-doctor
/// before doctor). Order fixes the `Allow` union of the four paths this
/// cluster registers more than one method on.
static LAYERS: &[Layer] = &[
    Layer {
        segs: &["restart"],
        method: "POST",
        kind: Route::Restart,
    },
    Layer {
        segs: &["desktop-shutdown"],
        method: "POST",
        kind: Route::DesktopShutdown,
    },
    Layer {
        segs: &["update", "status"],
        method: "GET",
        kind: Route::UpdateStatus,
    },
    Layer {
        segs: &["update"],
        method: "POST",
        kind: Route::Update,
    },
    Layer {
        segs: &["system", "developer-tools"],
        method: "GET",
        kind: Route::DeveloperToolsStatus,
    },
    Layer {
        segs: &["system", "developer-tools", "install"],
        method: "POST",
        kind: Route::DeveloperToolsInstall,
    },
    Layer {
        segs: &["system", "developer-tools", "install-git"],
        method: "GET",
        kind: Route::DeveloperToolsInstallGitStatus,
    },
    Layer {
        segs: &["system", "developer-tools", "install-git"],
        method: "POST",
        kind: Route::DeveloperToolsInstallGit,
    },
    Layer {
        segs: &["system", "disk-access"],
        method: "GET",
        kind: Route::DiskAccess,
    },
    Layer {
        segs: &["system", "disk-access", "open"],
        method: "POST",
        kind: Route::DiskAccessOpen,
    },
    Layer {
        segs: &["system", "agent-permissions"],
        method: "GET",
        kind: Route::AgentPermissions,
    },
    Layer {
        segs: &["system", "agent-permissions", "open"],
        method: "POST",
        kind: Route::AgentPermissionsOpen,
    },
    Layer {
        segs: &["system", "agent-permissions", "restart"],
        method: "POST",
        kind: Route::AgentPermissionsRestart,
    },
    Layer {
        segs: &["system", "agent-install"],
        method: "GET",
        kind: Route::AgentInstall,
    },
    Layer {
        segs: &["system", "agent-install", "replace"],
        method: "POST",
        kind: Route::AgentInstallReplace,
    },
    Layer {
        segs: &["system", "ops-env"],
        method: "GET",
        kind: Route::OpsEnv,
    },
    Layer {
        segs: &["system", "ops-run"],
        method: "GET",
        kind: Route::OpsRunStatus,
    },
    Layer {
        segs: &["system", "ops-run"],
        method: "POST",
        kind: Route::OpsRunStart,
    },
    Layer {
        segs: &["system", "ops-run", "stop"],
        method: "POST",
        kind: Route::OpsRunStop,
    },
    Layer {
        segs: &["settings", "notify"],
        method: "POST",
        kind: Route::SettingsNotify,
    },
    Layer {
        segs: &["settings", "tunnel"],
        method: "POST",
        kind: Route::SettingsTunnel,
    },
    Layer {
        segs: &["tunnel", "restart", ":provider"],
        method: "POST",
        kind: Route::TunnelRestart,
    },
    Layer {
        segs: &["tunnel", "sakurafrp", "public-url"],
        method: "POST",
        kind: Route::TunnelSakurafrpPublicUrl,
    },
    Layer {
        segs: &["tunnel", "funnel"],
        method: "POST",
        kind: Route::TunnelFunnel,
    },
    Layer {
        segs: &["settings", "access-token"],
        method: "POST",
        kind: Route::SettingsAccessToken,
    },
    Layer {
        segs: &["settings", "power"],
        method: "POST",
        kind: Route::SettingsPower,
    },
    Layer {
        segs: &["settings", "power", "auto-unlock"],
        method: "POST",
        kind: Route::SettingsPowerAutoUnlock,
    },
    Layer {
        segs: &["settings", "power", "unlock-password"],
        method: "POST",
        kind: Route::SettingsPowerUnlockPasswordSet,
    },
    Layer {
        segs: &["settings", "power", "unlock-password"],
        method: "DELETE",
        kind: Route::SettingsPowerUnlockPasswordClear,
    },
    Layer {
        segs: &["settings", "power", "unlock-password", "authorize"],
        method: "POST",
        kind: Route::SettingsPowerUnlockPasswordAuthorize,
    },
    Layer {
        segs: &["settings", "task-attribution"],
        method: "POST",
        kind: Route::SettingsTaskAttribution,
    },
    Layer {
        segs: &["skill-sync", "status"],
        method: "GET",
        kind: Route::SkillSyncStatus,
    },
    Layer {
        segs: &["skill-sync", "run"],
        method: "POST",
        kind: Route::SkillSyncRun,
    },
    Layer {
        segs: &["system", "env-doctor"],
        method: "POST",
        kind: Route::EnvDoctorStart,
    },
    Layer {
        segs: &["system", "env-doctor", ":runId"],
        method: "GET",
        kind: Route::EnvDoctorRun,
    },
    Layer {
        segs: &["system", "env-doctor", ":runId", "cancel"],
        method: "POST",
        kind: Route::EnvDoctorCancel,
    },
    Layer {
        segs: &["sessions", ":id", "doctor"],
        method: "POST",
        kind: Route::SessionDoctorStart,
    },
    Layer {
        segs: &["sessions", ":id", "doctor"],
        method: "GET",
        kind: Route::SessionDoctorList,
    },
    Layer {
        segs: &["doctor", "runs", ":runId"],
        method: "GET",
        kind: Route::DoctorRun,
    },
    Layer {
        segs: &["doctor", "runs", ":runId", "cancel"],
        method: "POST",
        kind: Route::DoctorCancel,
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

/// The `:id` segment `publicSessionAccessGuard` observes before the two
/// `/api/sessions/:id/doctor` routes (and before their `OPTIONS`).
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
    "POST,DELETE",
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
/// (`super::OPTIONS_SOURCES`). A shared path returns only this cluster's
/// methods; [`super::options_allow`] merges them in registration order.
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
            ("POST", "/api/restart", Restart),
            ("POST", "/api/desktop-shutdown", DesktopShutdown),
            ("GET", "/api/update/status", UpdateStatus),
            ("POST", "/api/update", Update),
            ("GET", "/api/system/developer-tools", DeveloperToolsStatus),
            (
                "POST",
                "/api/system/developer-tools/install",
                DeveloperToolsInstall,
            ),
            (
                "GET",
                "/api/system/developer-tools/install-git",
                DeveloperToolsInstallGitStatus,
            ),
            (
                "POST",
                "/api/system/developer-tools/install-git",
                DeveloperToolsInstallGit,
            ),
            ("GET", "/api/system/disk-access", DiskAccess),
            ("POST", "/api/system/disk-access/open", DiskAccessOpen),
            ("GET", "/api/system/agent-permissions", AgentPermissions),
            (
                "POST",
                "/api/system/agent-permissions/open",
                AgentPermissionsOpen,
            ),
            (
                "POST",
                "/api/system/agent-permissions/restart",
                AgentPermissionsRestart,
            ),
            ("GET", "/api/system/agent-install", AgentInstall),
            (
                "POST",
                "/api/system/agent-install/replace",
                AgentInstallReplace,
            ),
            ("GET", "/api/system/ops-env", OpsEnv),
            ("GET", "/api/system/ops-run", OpsRunStatus),
            ("POST", "/api/system/ops-run", OpsRunStart),
            ("POST", "/api/system/ops-run/stop", OpsRunStop),
            ("POST", "/api/settings/notify", SettingsNotify),
            ("POST", "/api/settings/tunnel", SettingsTunnel),
            ("POST", "/api/tunnel/restart/cloudflared", TunnelRestart),
            (
                "POST",
                "/api/tunnel/sakurafrp/public-url",
                TunnelSakurafrpPublicUrl,
            ),
            ("POST", "/api/tunnel/funnel", TunnelFunnel),
            ("POST", "/api/settings/access-token", SettingsAccessToken),
            ("POST", "/api/settings/power", SettingsPower),
            (
                "POST",
                "/api/settings/power/auto-unlock",
                SettingsPowerAutoUnlock,
            ),
            (
                "POST",
                "/api/settings/power/unlock-password",
                SettingsPowerUnlockPasswordSet,
            ),
            (
                "DELETE",
                "/api/settings/power/unlock-password",
                SettingsPowerUnlockPasswordClear,
            ),
            (
                "POST",
                "/api/settings/power/unlock-password/authorize",
                SettingsPowerUnlockPasswordAuthorize,
            ),
            (
                "POST",
                "/api/settings/task-attribution",
                SettingsTaskAttribution,
            ),
            ("GET", "/api/skill-sync/status", SkillSyncStatus),
            ("POST", "/api/skill-sync/run", SkillSyncRun),
            ("POST", "/api/system/env-doctor", EnvDoctorStart),
            ("GET", "/api/system/env-doctor/r1", EnvDoctorRun),
            ("POST", "/api/system/env-doctor/r1/cancel", EnvDoctorCancel),
            ("POST", "/api/sessions/s1/doctor", SessionDoctorStart),
            ("GET", "/api/sessions/s1/doctor", SessionDoctorList),
            ("GET", "/api/doctor/runs/r1", DoctorRun),
            ("POST", "/api/doctor/runs/r1/cancel", DoctorCancel),
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
        assert_eq!(seen.len(), 40);
        assert_eq!(
            Route::Options {
                allow: "POST",
                guard_segment: None
            }
            .op(),
            None
        );
    }

    #[test]
    fn head_follows_get_only_on_read_routes() {
        assert_eq!(
            route("HEAD", "/api/update/status"),
            Some(Route::UpdateStatus)
        );
        assert_eq!(
            route("HEAD", "/api/system/ops-run"),
            Some(Route::OpsRunStatus)
        );
        assert_eq!(
            route("HEAD", "/api/sessions/s1/doctor"),
            Some(Route::SessionDoctorList)
        );
        assert_eq!(route("HEAD", "/api/doctor/runs/r1"), Some(Route::DoctorRun));
        assert_eq!(
            route("HEAD", "/api/system/env-doctor/r1"),
            Some(Route::EnvDoctorRun)
        );
        // No HEAD handler where Express registered none.
        assert_eq!(route("HEAD", "/api/restart"), None);
        assert_eq!(route("HEAD", "/api/update"), None);
        assert_eq!(route("HEAD", "/api/settings/power/unlock-password"), None);
        assert_eq!(
            route("HEAD", "/api/sessions/s1/doctor"),
            Some(Route::SessionDoctorList)
        );
        assert_eq!(route("HEAD", "/api/doctor/runs/r1/cancel"), None);
    }

    #[test]
    fn unclaimed_paths_stay_with_their_owner() {
        for (method, path) in [
            ("GET", "/api/restart"),
            ("GET", "/api/update"),
            ("POST", "/api/update/status"),
            ("GET", "/api/restart/extra"),
            ("GET", "/api/system"),
            ("GET", "/api/system/ops-run/stop"),
            ("GET", "/api/system/env-doctor/r1/cancel"),
            ("DELETE", "/api/settings/power"),
            ("GET", "/api/settings/power/unlock-password/authorize"),
            ("GET", "/api/sessions/s1/doctor/extra"),
            ("GET", "/api/doctor/runs"),
            ("POST", "/api/skill-sync/status"),
            ("GET", "/settings/notify"),
            ("POST", "/api/system/disk-access"),
        ] {
            assert_eq!(route(method, path), None, "{method} {path}");
        }
    }

    #[test]
    fn trailing_slash_is_tolerated_and_interior_empty_is_not() {
        assert_eq!(route("POST", "/api/restart/"), Some(Route::Restart));
        assert_eq!(
            route("GET", "/api/update/status/"),
            Some(Route::UpdateStatus)
        );
        assert_eq!(route("POST", "/api/restart//"), None);
        assert_eq!(route("POST", "/api//restart"), None);
        assert_eq!(route("GET", "/api/system//ops-run"), None);
    }

    #[test]
    fn literals_are_case_insensitive_and_params_match_any_non_empty_segment() {
        assert_eq!(
            route("GET", "/API/update/status"),
            None,
            "prefix is case-sensitive"
        );
        assert_eq!(route("POST", "/api/Restart"), Some(Route::Restart));
        assert_eq!(
            route("GET", "/api/SYSTEM/Ops-Run"),
            Some(Route::OpsRunStatus)
        );
        assert_eq!(
            route("POST", "/api/tunnel/restart/NATAPP"),
            Some(Route::TunnelRestart)
        );
        assert_eq!(
            route("GET", "/api/sessions/a%2Fb/doctor"),
            Some(Route::SessionDoctorList)
        );
        assert_eq!(
            route("GET", "/api/doctor/runs/a%20b"),
            Some(Route::DoctorRun)
        );
    }

    #[test]
    fn the_provider_segment_stays_one_segment() {
        // `:provider` captures exactly one raw segment: a slash, an encoded
        // slash or a dot-dot never adds a segment, so it cannot walk out of
        // `/api/tunnel/restart/` and never reaches the filesystem.
        for raw in ["..", ".", "%2e%2e", "%2F", "..%2F..", "natapp"] {
            let path = format!("/api/tunnel/restart/{raw}");
            assert_eq!(route("POST", &path), Some(Route::TunnelRestart), "{path}");
        }
        assert_eq!(route("POST", "/api/tunnel/restart/a/b"), None);
        assert_eq!(route("POST", "/api/tunnel/restart/"), None);
    }

    #[test]
    fn allow_union_matches_the_measured_express_values() {
        // Measured against the retired Express stack for the paths this
        // cluster answers alone.
        let measured = [
            ("/api/restart", "POST"),
            ("/api/desktop-shutdown", "POST"),
            ("/api/update/status", "GET,HEAD"),
            ("/api/update", "POST"),
            ("/api/system/developer-tools", "GET,HEAD"),
            ("/api/system/developer-tools/install", "POST"),
            ("/api/system/developer-tools/install-git", "GET,HEAD,POST"),
            ("/api/system/disk-access", "GET,HEAD"),
            ("/api/system/disk-access/open", "POST"),
            ("/api/system/agent-permissions", "GET,HEAD"),
            ("/api/system/agent-permissions/open", "POST"),
            ("/api/system/agent-permissions/restart", "POST"),
            ("/api/system/agent-install", "GET,HEAD"),
            ("/api/system/agent-install/replace", "POST"),
            ("/api/system/ops-env", "GET,HEAD"),
            ("/api/system/ops-run", "GET,HEAD,POST"),
            ("/api/system/ops-run/stop", "POST"),
            ("/api/tunnel/restart/cloudflared", "POST"),
            ("/api/tunnel/sakurafrp/public-url", "POST"),
            ("/api/settings/power/auto-unlock", "POST"),
            ("/api/settings/power/unlock-password", "POST,DELETE"),
            ("/api/settings/power/unlock-password/authorize", "POST"),
            ("/api/skill-sync/status", "GET,HEAD"),
            ("/api/skill-sync/run", "POST"),
            ("/api/system/env-doctor", "POST"),
            ("/api/system/env-doctor/r1", "GET,HEAD"),
            ("/api/system/env-doctor/r1/cancel", "POST"),
            ("/api/sessions/s1/doctor", "POST,GET,HEAD"),
            ("/api/doctor/runs/r1", "GET,HEAD"),
            ("/api/doctor/runs/r1/cancel", "POST"),
        ];
        for (path, allow) in measured {
            assert_eq!(allow_for(path).as_deref(), Some(allow), "{path}");
        }
    }

    #[test]
    fn shared_paths_contribute_only_this_clusters_methods() {
        // The front door unions these with host-read's GET and the task
        // surface's GET in registration order.
        for path in [
            "/api/settings/notify",
            "/api/settings/tunnel",
            "/api/tunnel/funnel",
            "/api/settings/access-token",
            "/api/settings/power",
            "/api/settings/task-attribution",
        ] {
            assert_eq!(allow_for(path).as_deref(), Some("POST"), "{path}");
        }
        assert_eq!(allow_for("/api/system/ops-run/stop/extra"), None);
        assert_eq!(allow_for("/api/sessions/s1/doctor/extra"), None);
    }

    #[test]
    fn options_is_claimed_for_every_registered_path() {
        for layer in LAYERS {
            let mut path = String::from("/api/");
            for (index, seg) in layer.segs.iter().enumerate() {
                if index > 0 {
                    path.push('/');
                }
                path.push_str(if seg.starts_with(':') { "x" } else { seg });
            }
            match route("OPTIONS", &path) {
                Some(Route::Options { allow, .. }) => {
                    assert_eq!(Some(allow), allow_for(&path).as_deref(), "{path}");
                }
                other => panic!("{path}: {other:?}"),
            }
        }
    }

    #[test]
    fn the_guard_segment_is_the_session_id_only() {
        for path in ["/api/sessions/s1/doctor"] {
            match route("OPTIONS", path) {
                Some(Route::Options { guard_segment, .. }) => {
                    assert_eq!(guard_segment, Some(1), "{path}");
                }
                other => panic!("{path}: {other:?}"),
            }
        }
        for path in ["/api/system/env-doctor/r1", "/api/doctor/runs/r1"] {
            match route("OPTIONS", path) {
                Some(Route::Options { guard_segment, .. }) => {
                    assert_eq!(guard_segment, None, "{path}");
                }
                other => panic!("{path}: {other:?}"),
            }
        }
    }

    #[test]
    fn params_index_the_decoded_segments() {
        assert_eq!(Route::TunnelRestart.params(), &[("provider", 2)]);
        assert_eq!(Route::SessionDoctorStart.params(), &[("id", 1)]);
        assert_eq!(Route::SessionDoctorList.params(), &[("id", 1)]);
        assert_eq!(Route::DoctorRun.params(), &[("runId", 2)]);
        assert_eq!(Route::DoctorCancel.params(), &[("runId", 2)]);
        assert_eq!(Route::EnvDoctorRun.params(), &[("runId", 2)]);
        assert_eq!(Route::EnvDoctorCancel.params(), &[("runId", 2)]);
        assert_eq!(Route::Restart.params(), &[]);
    }

    #[test]
    fn only_mutating_routes_are_writes() {
        for layer in LAYERS {
            let expected = !matches!(
                layer.kind,
                Route::UpdateStatus
                    | Route::DeveloperToolsStatus
                    | Route::DeveloperToolsInstallGitStatus
                    | Route::DiskAccess
                    | Route::AgentPermissions
                    | Route::AgentInstall
                    | Route::OpsEnv
                    | Route::OpsRunStatus
                    | Route::SkillSyncStatus
                    | Route::EnvDoctorRun
                    | Route::SessionDoctorList
                    | Route::DoctorRun
            );
            assert_eq!(layer.kind.is_write(), expected, "{:?}", layer.kind);
        }
        assert!(!Route::Options {
            allow: "POST",
            guard_segment: None
        }
        .is_write());
    }

    #[test]
    fn every_route_uses_the_global_json_parser() {
        for layer in LAYERS {
            assert_eq!(
                layer.kind.body_parser(),
                BodyParser::Global,
                "{:?}",
                layer.kind
            );
        }
    }

    #[test]
    fn every_computed_allow_value_is_interned() {
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
    fn unrelated_paths_are_untouched() {
        for path in [
            "/",
            "/api",
            "/api/",
            "/api/settings",
            "/api/tunnel",
            "/api/doctor",
            "/api/skill-sync",
        ] {
            assert_eq!(route("GET", path), None, "{path}");
            assert_eq!(allow_for(path), None, "{path}");
        }
    }
}
