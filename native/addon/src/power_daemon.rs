//! The system daemon uses native files; injected filesystem ports retain their JS error identity.
use crate::{host_methods::function, route_response::*};
use napi_derive::napi;

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

fn path(p: L<'_>, key: &std::ffi::CStr) -> Result<PathBuf> {
    Ok(PathBuf::from(
        p.get(key)?.coerce_string()?.to_string_lossy(),
    ))
}

#[cfg(unix)]
fn accessible(path: &Path, mode: libc::c_int) -> bool {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    CString::new(path.as_os_str().as_bytes()).is_ok_and(|name| {
        // The CString lives across access(2) and includes the required trailing NUL.
        unsafe { libc::access(name.as_ptr(), mode) == 0 }
    })
}

#[cfg(unix)]
fn system_access(p: L<'_>) -> Result<bool> {
    Ok(accessible(&path(p, c"plistPath")?, libc::R_OK)
        && accessible(&path(p, c"intentPath")?, libc::W_OK))
}

#[cfg(not(unix))]
fn system_access(p: L<'_>) -> Result<bool> {
    // Node implements Windows access flags using the platform's file attributes.
    let fs = p.get(c"fs")?;
    let constants = fs.get(c"constants")?;
    Ok(p.catch(|| {
        call(
            fs,
            c"accessSync",
            &[p.get(c"plistPath")?, constants.get(c"R_OK")?],
        )?;
        call(
            fs,
            c"accessSync",
            &[p.get(c"intentPath")?, constants.get(c"W_OK")?],
        )
    })?
    .is_some())
}

fn installed(p: L<'_>, system: bool) -> Result<bool> {
    if system {
        return Ok(p.get(c"platform")?.is_string("darwin")? && system_access(p)?);
    }
    Ok(p.get(c"platform")?.is_string("darwin")?
        && p.catch(|| call(p, c"checkAccess", &[]))?.is_some())
}
pub(super) fn system_word(dest: &Path) -> &'static str {
    let bytes = fs::read(dest).unwrap_or_default();
    match multicc_core::js::js_trim(&String::from_utf8_lossy(&bytes)) {
        "on" => "on",
        "off" => "off",
        _ => "none",
    }
}

fn intent(p: L<'_>, system: bool) -> Result<L<'_>> {
    if system {
        return text(p, system_word(&path(p, c"intentPath")?));
    }
    if let Some(word) = p.catch(|| call(p, c"readWord", &[]))? {
        if word.is_string("on")? || word.is_string("off")? {
            return Ok(word);
        }
    }
    text(p, "none")
}
fn status_file(p: L<'_>, system: bool) -> Result<L<'_>> {
    if system {
        let Ok(bytes) = fs::read(path(p, c"statusPath")?) else {
            return null(p);
        };
        let value = text(p, &String::from_utf8_lossy(&bytes))?;
        return Ok(p
            .catch(|| call(p.global()?.get(c"JSON")?, c"parse", &[value]))?
            .unwrap_or(null(p)?));
    }
    Ok(p.catch(|| call(p, c"readJson", &[]))?.unwrap_or(null(p)?))
}
#[napi]
pub fn power_daemon(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    daemon_api(p, false)
}

fn set_intent(p: L<'_>, system: bool, enabled: L<'_>) -> Result<bool> {
    if !installed(p, system)? {
        return Ok(false);
    }
    let word = if enabled.truthy()? { "on\n" } else { "off\n" };
    if system {
        let dest = path(p, c"intentPath")?;
        let mut file = fs::File::create(&dest)
            .map_err(|e| crate::node_fs_error::throw(p, &e, "open", Some(&dest), None))?;
        file.write_all(word.as_bytes())
            .map_err(|e| crate::node_fs_error::throw(p, &e, "write", None, None))?;
    } else {
        call(p, c"write", &[text(p, word)?])?;
    }
    Ok(true)
}

fn daemon_api(p: L<'_>, system: bool) -> Result<sys::napi_value> {
    Ok(fields(
        p,
        &[
            (
                "installed",
                function(p, "installed", 0, 0, move |p, _| {
                    flag(p, installed(p, system)?)
                })?,
            ),
            (
                "setIntent",
                function(p, "setIntent", 1, 1, move |p, a| {
                    flag(p, set_intent(p, system, a[0])?)
                })?,
            ),
            (
                "status",
                function(p, "status", 0, 0, move |p, _| {
                    fields(
                        p,
                        &[
                            (
                                "applicable",
                                flag(p, p.get(c"platform")?.is_string("darwin")?)?,
                            ),
                            ("installed", flag(p, installed(p, system)?)?),
                            ("intent", intent(p, system)?),
                            ("daemon", status_file(p, system)?),
                        ],
                    )
                })?,
            ),
            (
                "readIntent",
                function(p, "readIntent", 0, 0, move |p, _| intent(p, system))?,
            ),
            (
                "readStatus",
                function(p, "readStatus", 0, 0, move |p, _| status_file(p, system))?,
            ),
            ("intentPath", p.get(c"intentPath")?),
            ("statusPath", p.get(c"statusPath")?),
        ],
    )?
    .raw())
}

fn path_or_default<'a>(
    env: &'a Env,
    p: L<'a>,
    supplied: Option<Unknown<'a>>,
    default: &str,
) -> Result<L<'a>> {
    match supplied {
        Some(value) => Ok(L::new(env, value)),
        None => text(p, default),
    }
}

/// Defaults are the same paths installed by the launch daemon. The optional
/// paths also support isolated callers without accessing the machine's service.
#[napi]
pub fn system_power_daemon(
    env: Env,
    platform: Unknown<'_>,
    fs: Unknown<'_>,
    intent_path: Option<Unknown<'_>>,
    status_path: Option<Unknown<'_>>,
    plist_path: Option<Unknown<'_>>,
) -> Result<sys::napi_value> {
    daemon_api(
        system_owner(&env, platform, fs, intent_path, status_path, plist_path)?,
        true,
    )
}

fn system_owner<'a>(
    env: &'a Env,
    platform: Unknown<'a>,
    fs: Unknown<'a>,
    intent_path: Option<Unknown<'a>>,
    status_path: Option<Unknown<'a>>,
    plist_path: Option<Unknown<'a>>,
) -> Result<L<'a>> {
    let p = L::new(env, platform);
    fields(
        p,
        &[
            ("platform", p),
            ("fs", L::new(env, fs)),
            (
                "intentPath",
                path_or_default(
                    env,
                    p,
                    intent_path,
                    "/Library/Application Support/multicc/power-intent",
                )?,
            ),
            (
                "statusPath",
                path_or_default(
                    env,
                    p,
                    status_path,
                    "/Library/Application Support/multicc/powerd-status.json",
                )?,
            ),
            (
                "plistPath",
                path_or_default(
                    env,
                    p,
                    plist_path,
                    "/Library/LaunchDaemons/com.multicc.powerd.plist",
                )?,
            ),
        ],
    )
}

pub(super) const DEFAULT_INTENT: &str = "/Library/Application Support/multicc/power-intent";

#[napi]
pub fn read_system_power_intent(_platform: Unknown<'_>, intent_path: Option<String>) -> String {
    // Reading intent has always been independent of the platform's installability.
    system_word(Path::new(intent_path.as_deref().unwrap_or(DEFAULT_INTENT))).into()
}

pub(super) fn set_default_intent(platform: L<'_>, fs: L<'_>, enabled: L<'_>) -> Result<bool> {
    use crate::host_methods::{arg, env};
    let env = env(platform);
    let owner = system_owner(&env, arg(platform)?, arg(fs)?, None, None, None)?;
    set_intent(owner, true, enabled)
}

#[napi]
pub fn set_system_power_intent(
    env: Env,
    platform: Unknown<'_>,
    fs: Unknown<'_>,
    enabled: Unknown<'_>,
    intent_path: Option<Unknown<'_>>,
    plist_path: Option<Unknown<'_>>,
) -> Result<bool> {
    let owner = system_owner(&env, platform, fs, intent_path, None, plist_path)?;
    set_intent(owner, true, L::new(&env, enabled))
}
