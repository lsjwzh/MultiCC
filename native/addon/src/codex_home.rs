//! 同步 home API 的 N-API 适配；所有磁盘、租约与迁移规则在 core。
use crate::{
    host_methods::{default_object, function},
    route_response::*,
};
use multicc_core::{
    codex_attempt_home as attempt, codex_home_fs as io, codex_session_home as session,
};
use napi_derive::napi;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub(crate) fn failure<'a>(a: L<'a>, e: io::Failure) -> Result<L<'a>> {
    let out = if let Some(raw) = &e.io {
        crate::node_fs_error::build(a, raw, e.syscall, e.path.as_deref(), None)?
    } else {
        a.global()?
            .get(c"Error")?
            .construct(&[text(a, &e.message)?])?
    };
    if e.io.is_none() {
        out.set(c"code", text(a, &e.code)?)?;
    }
    if let Some(cause) = e.cause {
        out.set(c"cause", failure(a, *cause)?)?;
    }
    if let Some(sources) = e.sources {
        out.set(c"sources", value(a, &serde_json::json!(sources))?)?;
    }
    Ok(out)
}
pub(crate) fn checked<T>(a: L<'_>, result: io::Result<T>) -> Result<T> {
    result.map_err(|e| failure(a, e).map(|e| e.throw_error()).unwrap_or_else(|e| e))
}
pub(crate) fn value<'a>(a: L<'a>, value: &serde_json::Value) -> Result<L<'a>> {
    a.from_value(&multicc_core::js::from_serde(value))
}
pub(crate) fn json(a: L<'_>) -> Result<serde_json::Value> {
    let wire = call(a.global()?.get(c"JSON")?, c"stringify", &[a])?;
    if wire.undefined()? {
        return Ok(serde_json::Value::Null);
    }
    let wire = wire.coerce_string()?.to_string_lossy();
    multicc_core::json_lenient::from_str(&wire).map_err(|e| napi::Error::from_reason(e.to_string()))
}
pub(crate) fn required(a: L<'_>, label: &str, code: &str) -> Result<String> {
    let a = a.clean_text()?;
    let s = a.coerce_string()?;
    if s.is_empty() || s.len() > 512 || s.as_units().iter().any(|c| *c <= 31 || *c == 127) {
        return Err(
            failure(a, io::Failure::new(code, format!("{label} is required")))?.throw_error(),
        );
    }
    Ok(s.to_string_lossy())
}
pub(crate) fn string_or_empty(a: L<'_>) -> Result<String> {
    Ok(string(fallback(a, "".into())?)?
        .coerce_string()?
        .to_string_lossy())
}
pub(crate) fn resolve(a: L<'_>, raw: &str) -> Result<PathBuf> {
    checked(a, io::absolute(Path::new(raw)))
}
fn attempt_create<'a>(a: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let source = resolve(
        a,
        &required(
            args[0],
            "source CODEX_HOME",
            "CODEX_ATTEMPT_HOME_IDENTITY_INVALID",
        )?,
    )?;
    let options = default_object(args[1])?;
    let id = required(
        options.get(c"sessionId")?,
        "attempt proxy session",
        "CODEX_ATTEMPT_HOME_IDENTITY_INVALID",
    )?;
    let provider = required(
        options.get(c"providerId")?,
        "providerId",
        "CODEX_ATTEMPT_HOME_IDENTITY_INVALID",
    )?;
    let homes = resolve(
        a,
        &required(
            options.get(c"homesDir")?,
            "attempt homes directory",
            "CODEX_ATTEMPT_HOME_IDENTITY_INVALID",
        )?,
    )?;
    let raw = options.get(c"sessionsDir")?;
    let sessions = if raw.truthy()? {
        Some(resolve(
            a,
            &required(
                raw,
                "shared Codex sessions directory",
                "CODEX_ATTEMPT_HOME_IDENTITY_INVALID",
            )?,
        )?)
    } else {
        None
    };
    let lease = checked(
        a,
        attempt::create(attempt::Create {
            source,
            homes,
            sessions,
            session: id,
            provider,
            config_required: !options.get(c"configRequired")?.is_false()?,
            copy_auth: !options.get(c"copyAuth")?.is_false()?,
        }),
    )?;
    let out = fields(
        a,
        &[
            ("home", text(a, &lease.home.to_string_lossy())?),
            ("sourceHome", text(a, &lease.source.to_string_lossy())?),
            ("sessionsDir", text(a, &lease.sessions.to_string_lossy())?),
        ],
    )?;
    let lease = Arc::new(Mutex::new(lease));
    out.set(
        c"release",
        function(a, "release", 0, 0, move |a, _| {
            let mut lease = lease
                .lock()
                .map_err(|_| napi::Error::from_reason("CODEX_ATTEMPT_HOME_STATE_FAILED"))?;
            let result = lease.release();
            drop(lease);
            flag(a, checked(a, result)?)
        })?,
    )?;
    out.freeze()
}
#[napi]
pub fn codex_attempt_home_api(env: Env) -> Result<sys::napi_value> {
    let a = L::new(&env, env.get_global()?.into_unknown(&env)?);
    let out = fields(a, &[("ATTEMPT_OWNER_FILE", text(a, attempt::OWNER_FILE)?)])?;
    out.set(
        c"createCodexAttemptHome",
        function(a, "createCodexAttemptHome", 1, 2, attempt_create)?,
    )?;
    out.set(
        c"cleanupCodexAttemptHomes",
        function(a, "cleanupCodexAttemptHomes", 1, 1, |a, args| {
            let root = resolve(
                a,
                &required(
                    args[0],
                    "attempt homes directory",
                    "CODEX_ATTEMPT_HOME_IDENTITY_INVALID",
                )?,
            )?;
            value(a, &checked(a, attempt::cleanup(&root))?)?.freeze()
        })?,
    )?;
    Ok(out.raw())
}
fn runtime<'a>(defaults: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let options = default_object(options)?;
    let mut paths = vec![];
    for (key, suffix) in [
        (c"sessionHomesDir", ".multicc/codex-session-homes"),
        (c"codexHomesDir", ".multicc/codex-homes"),
        (c"globalCodexHome", ".codex"),
    ] {
        let raw = options.get(key)?;
        let raw = if raw.truthy()? {
            raw
        } else {
            let home = defaults.get(c"homedir")?.call_plain(&[])?;
            let home = home.coerce_string()?.to_string_lossy();
            text(defaults, &Path::new(&home).join(suffix).to_string_lossy())?
        };
        if raw.kind()? != sys::ValueType::napi_string {
            return Err(raw.type_error("The path argument must be of type string"));
        }
        paths.push(resolve(raw, &raw.coerce_string()?.to_string_lossy())?);
    }
    let runtime = session::Runtime {
        session_homes: paths[0].clone(),
        provider_homes: paths[1].clone(),
        global_home: paths[2].clone(),
    };
    let out = fields(
        defaults,
        &[(
            "sessionHomesDir",
            text(defaults, &runtime.session_homes.to_string_lossy())?,
        )],
    )?;
    let r = runtime.clone();
    out.set(
        c"codexSessionHome",
        function(defaults, "codexSessionHome", 1, 1, move |a, args| {
            let id = required(
                args[0],
                "logical Codex session id",
                "CODEX_SESSION_IDENTITY_INVALID",
            )?;
            text(a, &checked(a, r.home(&id))?.to_string_lossy())
        })?,
    )?;
    let r = runtime.clone();
    out.set(
        c"prepareCodexSessionHome",
        function(defaults, "prepareCodexSessionHome", 0, 1, move |a, args| {
            let input = default_object(args[0])?;
            let logical = required(
                input.get(c"logicalSessionId")?,
                "logical Codex session id",
                "CODEX_SESSION_IDENTITY_INVALID",
            )?;
            let native = input.get(c"nativeSessionId")?.clean_text()?;
            let native = if native.truthy()? {
                required(
                    native,
                    "native Codex session id",
                    "CODEX_SESSION_IDENTITY_INVALID",
                )?
            } else {
                String::new()
            };
            value(
                a,
                &checked(
                    a,
                    r.prepare(
                        &logical,
                        &native,
                        input.get(c"allowMissingNativeSession")?.is_true()?,
                    ),
                )?,
            )?
            .freeze()
        })?,
    )?;
    out.set(
        c"synchronizeCodexSessionRoute",
        function(
            defaults,
            "synchronizeCodexSessionRoute",
            0,
            1,
            move |a, args| {
                let input = default_object(args[0])?;
                let logical = required(
                    input.get(c"logicalSessionId")?,
                    "logical Codex session id",
                    "CODEX_SESSION_IDENTITY_INVALID",
                )?;
                let native = required(
                    input.get(c"nativeSessionId")?,
                    "native Codex session id",
                    "CODEX_SESSION_IDENTITY_INVALID",
                )?;
                let from = string_or_empty(input.get(c"fromProviderId")?)?;
                let to = string_or_empty(input.get(c"toProviderId")?)?;
                value(
                    a,
                    &checked(
                        a,
                        runtime.synchronize(
                            &logical,
                            &native,
                            !multicc_core::js::js_trim(&from).is_empty(),
                            !multicc_core::js::js_trim(&to).is_empty(),
                        ),
                    )?,
                )?
                .freeze()
            },
        )?,
    )?;
    out.freeze()
}
#[napi]
pub fn codex_session_home_api(env: Env, homedir: Unknown<'_>) -> Result<sys::napi_value> {
    let homedir = L::new(&env, homedir);
    let a = fields(homedir, &[("homedir", homedir)])?;
    let out = fields(a, &[("MAX_SCAN_ENTRIES", num(a, 100000.)?)])?;
    out.set(
        c"createCodexSessionHomeRuntime",
        function(a, "createCodexSessionHomeRuntime", 0, 1, |a, args| {
            runtime(a, args[0])
        })?,
    )?;
    Ok(out.raw())
}
