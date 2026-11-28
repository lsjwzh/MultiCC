//! Synchronous host APIs for existing provider/session consumers.
mod accounts;
use crate::{host_methods::function, route_response::*};
pub(crate) use accounts::marker as official_account_id;
use multicc_core::{
    codex_homes::{self as homes, attempt, session},
    js,
};
use napi_derive::napi;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    cmp::Ordering,
    ffi::CStr,
    path::{Path, PathBuf},
    rc::Rc,
};
fn method<'a>(
    o: L<'a>,
    api: L<'a>,
    key: &'static str,
    length: usize,
    n: usize,
    f: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<()> {
    api.set_key(text(o, key)?, function(o, key, length, n, f)?)
}
fn printed(v: L<'_>) -> Result<String> {
    Ok(string(v)?.string()?.unwrap_or_default().to_string_lossy())
}
fn opt(v: L<'_>) -> Result<String> {
    if v.nullish()? {
        Ok(String::new())
    } else {
        printed(v)
    }
}
fn undefined(v: L<'_>) -> Result<L<'_>> {
    v.from_value(&V::Undefined)
}
fn js_obj<'a>(v: L<'a>, j: &Value) -> Result<L<'a>> {
    v.from_value(&js::from_serde(j))
}
fn make_error<'a>(v: L<'a>, e: &homes::Error) -> Result<L<'a>> {
    let error = v
        .global()?
        .get(c"Error")?
        .construct(&[text(v, &e.message)?])?;
    if !e.code.is_empty() {
        error.set(c"code", text(v, &e.code)?)?
    }
    if !e.sources.is_empty() {
        error.set(c"sources", js_obj(v, &json!(e.sources))?)?
    }
    if let Some(cause) = &e.cause {
        error.set(c"cause", make_error(v, cause)?)?
    }
    Ok(error)
}
fn lift<T>(v: L<'_>, result: homes::Result<T>) -> Result<T> {
    match result {
        Ok(value) => Ok(value),
        Err(e) => Err(make_error(v, &e)?.throw_error()),
    }
}
fn resolve<'a>(o: L<'a>, parts: &[L<'a>]) -> Result<PathBuf> {
    Ok(PathBuf::from(printed(call(
        o.get(c"path")?,
        c"resolve",
        parts,
    )?)?))
}
fn identity(v: L<'_>, label: &str, code: &str) -> Result<String> {
    let input = opt(v)?;
    let s = js::js_trim(&input);
    if s.is_empty() || js::utf16_len(s) > 512 || s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        return lift(
            v,
            Err(homes::Error::new(code, format!("{label} is required"))),
        );
    }
    Ok(s.to_owned())
}
fn attempt_api(p: L<'_>) -> Result<L<'_>> {
    let api = fields(p, &[("ATTEMPT_OWNER_FILE", text(p, attempt::OWNER)?)])?;
    const CODE: &str = "CODEX_ATTEMPT_HOME_IDENTITY_INVALID";
    method(p, api, "cleanupCodexAttemptHomes", 1, 1, |p, a| {
        let s = identity(a[0], "attempt homes directory", CODE)?;
        let dir = resolve(p, &[text(p, &s)?])?;
        js_obj(p, &lift(p, attempt::cleanup(&dir))?)?.freeze()
    })?;
    method(p, api, "createCodexAttemptHome", 1, 2, |p, a| {
        let s = identity(a[0], "source CODEX_HOME", CODE)?;
        let source = resolve(p, &[text(p, &s)?])?;
        let options = crate::host_methods::default_object(a[1])?;
        let session = identity(options.get(c"sessionId")?, "attempt proxy session", CODE)?;
        let provider = identity(options.get(c"providerId")?, "providerId", CODE)?;
        let r = identity(options.get(c"homesDir")?, "attempt homes directory", CODE)?;
        let root = resolve(p, &[text(p, &r)?])?;
        let dir = options.get(c"sessionsDir")?;
        let sessions = if dir.truthy()? {
            let s = identity(dir, "shared Codex sessions directory", CODE)?;
            resolve(p, &[text(p, &s)?])?
        } else {
            source.join("sessions")
        };
        let lease = lift(
            p,
            attempt::create(
                &root,
                &source,
                &session,
                &provider,
                sessions,
                !options.get(c"configRequired")?.is_false()?,
                !options.get(c"copyAuth")?.is_false()?,
            ),
        )?;
        let object = js_obj(
            p,
            &json!({"home":lease.home,"sourceHome":lease.source,"sessionsDir":lease.sessions}),
        )?;
        let lease = RefCell::new(lease);
        method(p, object, "release", 0, 0, move |p, _| {
            flag(p, lift(p, lease.borrow_mut().release())?)
        })?;
        object.freeze()
    })?;
    Ok(api)
}
fn make_roots(p: L<'_>, opts: L<'_>) -> Result<session::Roots> {
    let root = |key: &CStr, parts: &[&str]| -> Result<PathBuf> {
        let val = opts.get(key)?;
        if val.truthy()? {
            return resolve(p, &[val]);
        }
        let mut vals = vec![call(p.get(c"os")?, c"homedir", &[])?];
        for s in parts {
            vals.push(text(p, s)?)
        }
        resolve(p, &vals)
    };
    Ok(session::Roots {
        sessions: root(c"sessionHomesDir", &[".multicc", "codex-session-homes"])?,
        providers: root(c"codexHomesDir", &[".multicc", "codex-homes"])?,
        global: root(c"globalCodexHome", &[".codex"])?,
    })
}
fn session_api(p: L<'_>) -> Result<L<'_>> {
    let api = fields(
        p,
        &[("MAX_SCAN_ENTRIES", num(p, homes::MAX_ENTRIES as f64)?)],
    )?;
    method(p, api, "createCodexSessionHomeRuntime", 0, 1, |p, a| {
        let roots = Rc::new(make_roots(p, crate::host_methods::default_object(a[0])?)?);
        let runtime = fields(
            p,
            &[(
                "sessionHomesDir",
                text(p, &roots.sessions.to_string_lossy())?,
            )],
        )?;
        const CODE: &str = "CODEX_SESSION_IDENTITY_INVALID";
        let paths = roots.clone();
        method(p, runtime, "codexSessionHome", 1, 1, move |p, a| {
            let id = identity(a[0], "logical Codex session id", CODE)?;
            text(p, &paths.home(&id).to_string_lossy())
        })?;
        for (name, sync) in [
            ("prepareCodexSessionHome", false),
            ("synchronizeCodexSessionRoute", true),
        ] {
            let roots = roots.clone();
            method(p, runtime, name, 0, 1, move |p, a| {
                let input = crate::host_methods::default_object(a[0])?;
                let id = identity(
                    input.get(c"logicalSessionId")?,
                    "logical Codex session id",
                    CODE,
                )?;
                let n = input.get(c"nativeSessionId")?;
                let v = opt(n)?;
                let v = js::js_trim(&v);
                let native = if !sync && v.is_empty() {
                    String::new()
                } else {
                    identity(text(p, v)?, "native Codex session id", CODE)?
                };
                let mut err = None;
                let mut compare = |a: &str, b: &str| {
                    if err.is_some() {
                        return None;
                    }
                    let val = (|| call(text(p, a)?, c"localeCompare", &[text(p, b)?])?.number())();
                    match val {
                        Ok(n) => Some(n.partial_cmp(&0.).unwrap_or(Ordering::Equal)),
                        Err(e) => {
                            err = Some(e);
                            None
                        }
                    }
                };
                let result = if sync {
                    let managed = |key: &CStr| -> Result<bool> {
                        Ok(
                            !js::js_trim(&printed(fallback(input.get(key)?, "".into())?)?)
                                .is_empty(),
                        )
                    };
                    roots.sync(
                        &id,
                        &native,
                        managed(c"fromProviderId")?,
                        managed(c"toProviderId")?,
                        &mut compare,
                    )
                } else {
                    roots.prepare(
                        &id,
                        &native,
                        input.get(c"allowMissingNativeSession")?.is_true()?,
                        &mut compare,
                    )
                };
                if let Some(err) = err {
                    return Err(err);
                }
                js_obj(p, &lift(p, result)?)?.freeze()
            })?;
        }
        runtime.freeze()
    })?;
    Ok(api)
}
#[napi]
pub fn codex_attempt_home_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(attempt_api(L::new(&env, ports))?.raw())
}
#[napi]
pub fn codex_session_home_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(session_api(L::new(&env, ports))?.raw())
}
#[napi]
pub fn official_accounts_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(accounts::api(L::new(&env, ports))?.raw())
}
