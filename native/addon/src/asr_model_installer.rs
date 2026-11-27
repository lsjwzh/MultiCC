//! Preserve live host probes, the shared in-flight Promise and AbortSignal while
//! Rust owns transfer sequencing, cache files and model installation state.
use crate::{
    host_api::*,
    host_methods::{env, raw},
};
use multicc_core::asr_model_installer::{self as model, Progress, ARTIFACTS};
use napi::bindgen_prelude::{External, FromNapiRef, ToNapiValue};
use napi_derive::napi;
use std::{cell::RefCell, ffi::CStr};
mod transfer;

fn or<'a>(a: L<'a>, b: L<'a>) -> Result<L<'a>> {
    Ok(if a.truthy()? { a } else { b })
}
fn progress<T>(p: L<'_>, action: impl FnOnce(&mut Progress) -> T) -> Result<T> {
    let value = p.get(c"progress")?;
    // Private bound owner; the external never escapes to callers. Do not enter
    // JS under this borrow: injected clocks, probes and logs can re-enter.
    let cell = unsafe { External::<RefCell<Progress>>::from_napi_ref(p.env(), value.raw())? };
    Ok(action(&mut cell.borrow_mut()))
}
fn local(p: L<'_>) -> Result<L<'_>> {
    p.get(c"local")
}
fn root(p: L<'_>) -> Result<L<'_>> {
    let local = local(p)?;
    let cb = local.get(c"modelRoot")?;
    if callable(cb)? {
        cb.call(local, &[])
    } else {
        text(p, "")
    }
}
fn ready(p: L<'_>) -> Result<L<'_>> {
    call(local(p)?, c"modelFilesExist", &[])
}
fn addon(p: L<'_>) -> Result<L<'_>> {
    let local = local(p)?;
    let cb = local.get(c"addonAvailable")?;
    if callable(cb)? {
        cb.call(local, &[])
    } else {
        flag(p, true)
    }
}
fn off(v: L<'_>) -> Result<bool> {
    Ok(v.is_false()? || v.is_string("off")? || v.is_string("0")? || v.is_string("false")?)
}
fn process_env(p: L<'_>) -> Result<L<'_>> {
    p.global()?.get(c"process")?.get(c"env")
}
fn disabled(p: L<'_>) -> Result<bool> {
    let cfg = local(p)?.get(c"cfg")?;
    let src = if cfg.truthy()? { cfg } else { process_env(p)? };
    off(src.get(c"ASR_LOCAL")?)
}
fn auto(p: L<'_>) -> Result<bool> {
    Ok(p.get(c"armed")?.truthy()?
        && !off(process_env(p)?.get(c"ASR_LOCAL_AUTO_DOWNLOAD")?)?
        && !disabled(p)?)
}
fn status(p: L<'_>) -> Result<L<'_>> {
    let files = ready(p)?;
    let supported = addon(p)?;
    let file_ok = files.truthy()?;
    let addon_ok = supported.truthy()?;
    let phase = progress(p, |v| v.phase)?;
    let phase = match phase {
        "downloading" | "failed" => phase,
        _ if disabled(p)? => "disabled",
        _ if !addon_ok => "unsupported",
        _ if file_ok => "ready",
        _ => "missing",
    };
    let dir = root(p)?;
    let (started, finished, done, total, rate, current, error) = progress(p, |v| {
        (
            v.started,
            v.finished,
            v.done,
            v.total,
            v.rate,
            v.current,
            v.error.clone(),
        )
    })?;
    let pct = if total > 0 {
        ((done as f64 / total as f64) * 1000.).round().min(1000.) / 10.
    } else {
        0.
    };
    let eta = if rate > 0. && done < total {
        ((total - done) as f64 / rate).ceil()
    } else {
        0.
    };
    fields(
        p,
        &[
            ("state", text(p, phase)?),
            ("ready", if file_ok { supported } else { files }),
            ("filesReady", files),
            ("addonReady", supported),
            ("modelDir", dir),
            ("totalBytes", num(p, total as f64)?),
            ("doneBytes", num(p, done as f64)?),
            ("percent", num(p, pct)?),
            ("bytesPerSec", num(p, rate.round())?),
            ("etaSec", num(p, eta)?),
            (
                "currentFile",
                match current {
                    Some(i) => text(p, ARTIFACTS[i].id)?,
                    None => null(p)?,
                },
            ),
            (
                "error",
                match error {
                    Some(s) => text(p, &s)?,
                    None => null(p)?,
                },
            ),
            ("startedAt", num(p, started)?),
            ("finishedAt", num(p, finished)?),
            ("autoDownload", flag(p, auto(p)?)?),
        ],
    )
}
fn log(p: L<'_>, key: &CStr, message: &str) -> Result<()> {
    let logger = p.get(c"log")?;
    let cb = logger.optional(key)?;
    if !cb.nullish()? {
        cb.call(
            logger,
            &[text(p, &format!("[multicc/asr-install] {message}"))?],
        )?;
    }
    Ok(())
}
fn aborted(p: L<'_>) -> Result<bool> {
    Ok(p.get(c"controller")?
        .optional(c"signal")?
        .optional(c"aborted")?
        .truthy()?)
}
fn check_cancelled(p: L<'_>) -> Result<()> {
    if aborted(p)? {
        return Err(napi::Error::from_reason("下载已取消"));
    }
    Ok(())
}
fn failed<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let message = if aborted(p)? {
        "下载已取消".into()
    } else {
        fold_string(or(args[0].optional(c"message")?, args[0])?)?
    };
    progress(p, |v| v.fail(message.clone()))?;
    p.catch(|| log(p, c"error", &format!("failed: {message}")))?;
    undef(p)
}
fn run<'a>(p: L<'a>, reason: L<'a>) -> Result<L<'a>> {
    let dir = root(p)?;
    if !dir.truthy()? {
        progress(p, |v| v.fail("model directory is not configured".into()))?;
        return undef(p);
    }
    if ready(p)?.truthy()? {
        progress(p, |v| {
            v.phase = "ready";
            v.error = None;
        })?;
        return undef(p);
    }
    let at = now(p)?.number()?;
    progress(p, |v| v.begin(at))?;
    p.set(
        c"controller",
        p.global()?.get(c"AbortController")?.construct(&[])?,
    )?;
    p.set(c"root", dir)?;
    p.set(c"reason", with_default(reason, text(p, "manual")?)?)?;
    let job = transfer::lock(p, fold_string(dir)?, at)?;
    then(job, p, |p, a| {
        let lock = a[0];
        if !lock.nullish()? {
            p.set(c"lock", lock)?;
        }
        check_cancelled(p)?;
        if lock.nullish()? {
            return undef(p);
        }
        if ready(p)?.truthy()? {
            progress(p, |v| v.phase = "ready")?;
            return undef(p);
        }
        log(
            p,
            c"log",
            &format!(
                "downloading {:.0}MB to {} ({})",
                model::total_bytes() as f64 / 1048576.,
                fold_string(p.get(c"root")?)?,
                fold_string(p.get(c"reason")?)?
            ),
        )?;
        transfer::all(p)
    })
}
fn start<'a>(p: L<'a>, reason: L<'a>) -> Result<L<'a>> {
    let existing = p.get(c"inflight")?;
    if existing.truthy()? {
        return Ok(existing);
    }
    // Publish before any probe or clock can reenter start().
    let mut deferred = std::ptr::null_mut();
    let mut handle = std::ptr::null_mut();
    napi::check_status!(unsafe { sys::napi_create_promise(p.env(), &mut deferred, &mut handle) })?;
    let promise = raw(p, handle);
    p.set(c"inflight", promise)?;
    let job = async_result(p, || run(p, reason))?;
    let settled = recover(job, p, failed)?;
    let unlocked = call(
        settled,
        c"finally",
        &[function(p, "release", 0, 0, |p, _| {
            p.set(c"controller", null(p)?)?;
            progress(p, |v| v.current = None)?;
            transfer::release(p)
        })?],
    )?;
    let result = then(unlocked, p, |p, _| status(p))?;
    let result = call(
        result,
        c"finally",
        &[function(p, "clear", 0, 0, |p, _| {
            p.set(c"inflight", null(p)?)?;
            undef(p)
        })?],
    )?;
    napi::check_status!(unsafe { sys::napi_resolve_deferred(p.env(), deferred, result.raw()) })?;
    Ok(promise)
}
fn create<'a>(ports: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    let d = default_object(args[0])?;
    let local = d.get(c"asrLocal")?;
    if !callable(local.optional(c"modelFilesExist")?)? {
        return Err(d.type_error("asr model installer requires the local ASR service"));
    }
    let global = d.global()?;
    let timeout = d.get(c"idleTimeoutMs")?.explicit_number()?;
    let value = unsafe {
        External::to_napi_value(d.env(), External::new(RefCell::new(Progress::default())))?
    };
    let artifacts = ports.get(c"artifacts")?;
    let p = fields(
        d,
        &[
            ("local", local),
            ("ports", ports),
            ("log", or(d.get(c"log")?, global.get(c"console")?)?),
            (
                "now",
                or(d.get(c"now")?, global.get(c"Date")?.get(c"now")?)?,
            ),
            ("fetch", or(d.get(c"fetchImpl")?, global.get(c"fetch")?)?),
            ("armed", flag(d, d.get(c"autoDownload")?.is_true()?)?),
            (
                "timeout",
                num(
                    d,
                    if timeout == 0. || timeout.is_nan() {
                        60_000.
                    } else {
                        timeout
                    },
                )?,
            ),
            ("progress", raw(d, value)),
        ],
    )?;
    let api = fields(
        p,
        &[
            ("status", function(p, "status", 0, 0, |p, _| status(p))?),
            ("start", function(p, "start", 0, 1, |p, a| start(p, a[0]))?),
            (
                "cancel",
                function(p, "cancel", 0, 0, |p, _| {
                    let c = p.get(c"controller")?;
                    if !c.truthy()? {
                        return flag(p, false);
                    }
                    p.catch(|| call(c, c"abort", &[]))?;
                    flag(p, true)
                })?,
            ),
            (
                "maybeAutoDownload",
                function(p, "maybeAutoDownload", 0, 0, |p, _| {
                    if !auto(p)? || ready(p)?.truthy()? || !addon(p)?.truthy()? {
                        return null(p);
                    }
                    start(p, text(p, "boot")?)
                })?,
            ),
            (
                "autoDownloadEnabled",
                function(p, "autoDownloadEnabled", 0, 0, |p, _| flag(p, auto(p)?))?,
            ),
        ],
    )?;
    api.set(c"ARTIFACTS", artifacts)?;
    api.set(c"TOTAL_BYTES", num(p, model::total_bytes() as f64)?)?;
    api.freeze()
}

#[napi]
pub fn asr_model_installer_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let a = array(p)?;
    for (i, artifact) in ARTIFACTS.iter().enumerate() {
        let sources = array(p)?;
        for (j, url) in artifact.sources().iter().enumerate() {
            sources.set_element(j as u32, text(p, url)?)?;
        }
        a.set_element(
            i as u32,
            fields(
                p,
                &[
                    ("id", text(p, artifact.id)?),
                    ("rel", text(p, &artifact.relative())?),
                    ("bytes", num(p, artifact.bytes as f64)?),
                    ("sources", sources),
                ],
            )?
            .freeze()?,
        )?;
    }
    p.set(c"artifacts", a.freeze()?)?;
    let api = fields(
        p,
        &[(
            "createAsrModelInstaller",
            function(p, "createAsrModelInstaller", 0, 1, create)?,
        )],
    )?;
    api.set(c"ARTIFACTS", a)?;
    api.set(c"TOTAL_BYTES", num(p, model::total_bytes() as f64)?)?;
    api.set(c"SV_DIR", text(p, model::SV_DIR)?)?;
    Ok(api.raw())
}
