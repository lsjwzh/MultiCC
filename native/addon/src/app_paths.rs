//! State-file locations are relative to the configured instance. On an ordinary
//! installation, private user data and replaceable runtimes live under ~/.multicc.
//! Platform path and filesystem operations use the synchronous Node host contract.
use crate::host_methods::{default_object, function};
use crate::path_safety::{home_or_above, real_path};
use crate::route_response::*;
use multicc_core::js::JsString;
use napi_derive::napi;

fn mkdir<'a>(ports: L<'a>, dir: L<'a>) -> Result<L<'a>> {
    let options = fields(ports, &[("recursive", flag(ports, true)?)])?;
    call(ports.get(c"fs")?, c"mkdirSync", &[dir, options])
}
fn failure<'a>(ports: L<'a>, pieces: &[L<'a>]) -> Result<L<'a>> {
    let msg = call(text(ports, "")?, c"concat", pieces)?;
    Err(ports
        .global()?
        .get(c"Error")?
        .construct(&[msg])?
        .throw_error())
}
pub(crate) fn resolve<'a>(ports: L<'a>, override_dir: L<'a>) -> Result<L<'a>> {
    let pkg = ports.get(c"pkgRoot")?;
    let value = if override_dir.truthy()? {
        override_dir
    } else {
        fallback(
            ports
                .get(c"process")?
                .get(c"env")?
                .get(c"MULTICC_DATA_DIR")?,
            V::from(""),
        )?
    };
    let trim = value.get(c"trim")?;
    if trim.kind()? != sys::ValueType::napi_function {
        return Err(value.type_error(
            "(override || process.env.MULTICC_DATA_DIR || \"\").trim is not a function",
        ));
    }
    let raw = trim.call(value, &[])?;
    if !raw.truthy()? {
        return Ok(pkg);
    }
    let path = ports.get(c"path")?;
    let dir = if call(path, c"isAbsolute", &[raw])?.truthy()? {
        raw
    } else {
        call(path, c"resolve", &[pkg, raw])?
    };
    if let Err(error) = mkdir(ports, dir) {
        let cause = ports.exception_value()?.ok_or(error)?;
        return failure(
            ports,
            &[
                text(ports, "[multicc/paths] cannot create MULTICC_DATA_DIR ")?,
                dir,
                text(ports, ": ")?,
                cause.get(c"message")?,
            ],
        );
    }
    Ok(dir)
}

fn join<'a>(ports: L<'a>, base: L<'a>, parts: &[&str]) -> Result<L<'a>> {
    let mut args = Vec::with_capacity(parts.len() + 1);
    args.push(base);
    for part in parts {
        args.push(text(ports, part)?);
    }
    call(ports.get(c"path")?, c"join", &args)
}
fn user_base<'a>(ports: L<'a>, root: L<'a>) -> Result<L<'a>> {
    if !root.equals(ports.get(c"pkgRoot")?)? {
        return Ok(root);
    }
    join(
        ports,
        call(ports.get(c"os")?, c"homedir", &[])?,
        &[".multicc"],
    )
}
fn login_workspace<'a>(ports: L<'a>, root: L<'a>, id: L<'a>) -> Result<L<'a>> {
    // The original JS regexp replaces one UTF-16 code unit at a time.
    let units = string(fallback(id, V::from("login"))?)?
        .coerce_string()?
        .into_units()
        .into_iter()
        .map(|u| match u {
            45 | 46 | 48..=57 | 65..=90 | 95 | 97..=122 => u,
            _ => 45,
        })
        .collect();
    let base = join(ports, user_base(ports, root)?, &["login-workspaces"])?;
    let dir = call(
        ports.get(c"path")?,
        c"join",
        &[
            base,
            ports.from_value(&V::String(JsString::from_units(units)))?,
        ],
    )?;
    ports.catch(|| mkdir(ports, dir))?;
    Ok(dir)
}

pub(crate) fn create<'a>(ports: L<'a>, override_dir: L<'a>) -> Result<L<'a>> {
    let root = resolve(ports, override_dir)?;
    let out = fields(ports, &[("root", root)])?;
    for (key, parts) in ROOT_SETTINGS {
        out.set_key(text(ports, key)?, join(ports, root, parts)?)?;
    }
    out.set(c"pkgRoot", ports.get(c"pkgRoot")?)?;
    out.set(
        c"cliEffortCatalogFile",
        join(
            ports,
            user_base(ports, root)?,
            &["catalogs", "cli-efforts.json"],
        )?,
    )?;
    for (key, parts) in INSTANCE_DIRS {
        out.set_key(text(ports, key)?, join(ports, root, parts)?)?;
    }
    for (key, parts) in USER_DIRS {
        out.set_key(
            text(ports, key)?,
            join(ports, user_base(ports, root)?, parts)?,
        )?;
    }
    let frame = fields(ports, &[("ports", ports), ("root", root)])?;
    out.set(
        c"loginWorkspacePath",
        function(frame, "loginWorkspacePath", 1, 1, |f, a| {
            login_workspace(f.get(c"ports")?, f.get(c"root")?, a[0])
        })?,
    )?;
    for (key, parts) in STATE_FILES {
        out.set_key(text(ports, key)?, join(ports, root, parts)?)?;
    }
    Ok(out)
}
fn assert_test_dir<'a>(ports: L<'a>, dir: L<'a>) -> Result<L<'a>> {
    if dir.kind()? != sys::ValueType::napi_string || !dir.truthy()? {
        return failure(
            ports,
            &[text(
                ports,
                "[multicc/paths] assertTestDir: dir must be a non-empty string",
            )?],
        );
    }
    let fs = ports.get(c"fs")?;
    let path = ports.get(c"path")?;
    let os = ports.get(c"os")?;
    let abs = call(path, c"resolve", &[dir])?;
    let rp = real_path(abs, fs, path)?;
    if home_or_above(rp, fs, path, os)? {
        return failure(
            ports,
            &[
                text(ports, "[multicc/paths] refusing to use ")?,
                rp,
                text(ports, " as test data dir (is $HOME or above)")?,
            ],
        );
    }
    if rp.equals(real_path(ports.get(c"pkgRoot")?, fs, path)?)? {
        return failure(
            ports,
            &[
                text(ports, "[multicc/paths] refusing to use the package root (")?,
                rp,
                text(ports, ") as a test data dir")?,
            ],
        );
    }
    let tmp = real_path(call(os, c"tmpdir", &[])?, fs, path)?;
    if !rp.equals(tmp)? {
        let prefix = call(tmp, c"concat", &[path.get(c"sep")?])?;
        if !call(rp, c"startsWith", &[prefix])?.truthy()? {
            return failure(
                ports,
                &[
                    text(ports, "[multicc/paths] refusing test data dir ")?,
                    rp,
                    text(ports, ": not under os.tmpdir() (")?,
                    tmp,
                    text(ports, "); use fs.mkdtemp")?,
                ],
            );
        }
    }
    Ok(abs)
}
#[napi]
pub fn app_paths_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let s = L::new(&env, ports);
    Ok(fields(
        s,
        &[
            (
                "createPaths",
                function(s, "createPaths", 0, 1, |s, a| {
                    create(s, default_object(a[0])?.get(c"dataDir")?)
                })?,
            ),
            (
                "resolveDataDir",
                function(s, "resolveDataDir", 1, 1, |s, a| resolve(s, a[0]))?,
            ),
            (
                "assertTestDir",
                function(s, "assertTestDir", 1, 1, |s, a| assert_test_dir(s, a[0]))?,
            ),
        ],
    )?
    .raw())
}

const ROOT_SETTINGS: &[(&str, &[&str])] = &[
    ("serviceRoutesFile", &["service-routes.json"]),
    ("fcmDevicesFile", &["fcm-devices.json"]),
    ("barkDevicesFile", &["bark-devices.json"]),
    ("channelSubscriptionsFile", &["channel-subscriptions.json"]),
];

const INSTANCE_DIRS: &[(&str, &[&str])] = &[
    ("sessionsFile", &["sessions.json"]),
    ("directoriesFile", &["directories.json"]),
    ("journalDir", &[".journal"]),
    ("chatHistoryDir", &["chat_history"]),
    ("auxRunsDir", &["aux_runs"]),
    ("eventsDir", &["events"]),
    ("bridgesDir", &["bridges"]),
    ("artifactsDir", &["artifacts"]),
];

const USER_DIRS: &[(&str, &[&str])] = &[
    ("detachedDir", &["detached"]),
    ("assistDir", &["assist"]),
    ("voiceRuntimesDir", &["runtimes", "voice"]),
    ("userPluginsDir", &["plugins"]),
    ("pluginCatalogDir", &["plugins-catalog"]),
    ("sampleWorkspacesDir", &["samples"]),
    ("defaultWorkspacePath", &["workspaces", "default"]),
];

const STATE_FILES: &[(&str, &[&str])] = &[
    ("notesFile", &["notes.json"]),
    ("tokenUsageFile", &["token_usage.json"]),
    ("tokenDailyFile", &["token_daily.json"]),
    ("tokenByRoleFile", &["token_by_role.json"]),
    ("providersFile", &["providers.json"]),
    ("sharesFile", &["shares.json"]),
    ("fleetSharesFile", &["fleet-shares.json"]),
    ("externalFleetsFile", &["external-fleets.json"]),
    ("machinesFile", &["machines.json"]),
    ("pushSubscriptionsFile", &["push_subscriptions.json"]),
    ("eventRulesFile", &["event_rules.json"]),
    (
        "pushNotificationReceiptsFile",
        &["push_notification_receipts.json"],
    ),
    ("tunnelConfigFile", &["tunnel-config.json"]),
    ("tunnelRepairLedgerFile", &["tunnel-repair-ledger.json"]),
    ("auxConfigFile", &["aux-config.json"]),
    ("goalConfigFile", &["goal-config.json"]),
    ("providerDefaultsFile", &["provider-defaults.json"]),
    ("providerRelaySharesFile", &["provider-relay-shares.json"]),
    ("providerLimitDbFile", &["provider-limit-cache.db"]),
    ("providerLimitCacheFile", &["provider-limit-cache.json"]),
    ("providerQuotaHistoryDbFile", &["provider-quota-history.db"]),
    ("quotaGuardFile", &["quota-guard.json"]),
    ("quotaBarCacheFile", &["quota-bar-cache.json"]),
    ("scheduledTasksFile", &["scheduled_tasks.json"]),
    ("cronFanoutMigrationFile", &["cron_fanout_migration.json"]),
    ("docsRegistryFile", &["docs_registry.json"]),
    ("secretsFile", &["secrets.json"]),
    ("secretAuditFile", &["logs", "secret-audit.jsonl"]),
    ("taskBoardFile", &["task_board.json"]),
    ("backgroundNudgeFile", &["background-nudges.json"]),
    ("taskShellDbFile", &["task-shells.sqlite"]),
    ("searchIndexDbFile", &["search-index.sqlite"]),
    ("taskShortCodesFile", &["task-short-codes.json"]),
    ("uiLayoutFile", &["ui-layout.json"]),
    ("airPinsFile", &["air-pins.json"]),
    ("airTodosFile", &["air-todos.json"]),
    ("airTodoIgnoresFile", &["air-todo-ignores.json"]),
    ("orchestrationDbFile", &["orchestration.sqlite"]),
    ("orchestrationFile", &["orchestration.json"]),
    ("voiceExamplesFile", &["voice_examples.json"]),
    ("whisperVocabFile", &["whisper_vocab.json"]),
    ("voiceHotwordsFile", &["voice_hotwords.json"]),
];
