//! Mac power controls used by the compatibility server and the battery guard.
use crate::{
    host_methods::{arg, async_result, default_object, env, function},
    power_daemon::{set_default_intent, system_word, DEFAULT_INTENT},
    route_response::*,
};
use multicc_core::macos_power as policy;
use napi::bindgen_prelude::{JsValue as _, ToNapiValue};
use napi_derive::napi;
use std::{ffi::CStr, path::Path, time::Duration};

const PMSET: &str = "/usr/bin/pmset";
const OSASCRIPT: &str = "/usr/bin/osascript";

fn as_string(value: L<'_>) -> Result<String> {
    Ok(string(value)?.coerce_string()?.to_string_lossy())
}

fn context<'a>(ports: L<'a>, options: L<'a>) -> Result<L<'a>> {
    fields(
        ports,
        &[("ports", ports), ("options", default_object(options)?)],
    )
}
fn option<'a>(ctx: L<'a>, key: &CStr) -> Result<L<'a>> {
    ctx.get(c"options")?.get(key)
}
fn platform(ctx: L<'_>) -> Result<L<'_>> {
    let platform = option(ctx, c"platform")?;
    if platform.truthy()? {
        Ok(platform)
    } else {
        ctx.get(c"ports")?.get(c"platform")
    }
}
type Continuation = for<'a> fn(L<'a>, L<'a>) -> Result<L<'a>>;
fn then<'a>(pending: L<'a>, ctx: L<'a>, next: Continuation) -> Result<L<'a>> {
    let handler = function(ctx, "", 1, 1, move |ctx, args| next(ctx, args[0]))?;
    call(pending, c"then", &[handler])
}

fn conflict<T>(ctx: L<'_>, code: &str, message: &str) -> Result<T> {
    let constructor = ctx.get(c"ports")?.get(c"DomainError")?;
    let details = fields(ctx, &[("code", text(ctx, code)?)])?;
    Err(constructor
        .construct(&[text(ctx, "conflict")?, text(ctx, message)?, details])?
        .throw_error())
}

fn pending(ctx: L<'_>) -> Result<L<'_>> {
    conflict(
        ctx,
        "power_application_pending",
        "设置已保存，但系统尚未生效，请稍后刷新状态。",
    )
}

fn elevated_command(ctx: L<'_>, enabled: L<'_>) -> Result<String> {
    let ports = ctx.get(c"ports")?;
    let user = option(ctx, c"user")?;
    let user = if user.undefined()? {
        call(ports, c"username", &[])?
    } else {
        user
    };
    let installer = option(ctx, c"powerdInstaller")?;
    let installer = if installer.undefined()? {
        ports.get(c"installer")?
    } else {
        installer
    };
    if !call(ports.get(c"fs")?, c"existsSync", &[installer])?.truthy()? {
        return conflict(
            ctx,
            "power_component_missing",
            "电源组件缺失，请更新 MultiCC 后重试。",
        );
    }
    Ok(policy::install_command(
        enabled.truthy()?,
        &as_string(installer)?,
        &as_string(user)?,
    ))
}

// Command paths, arguments, deadlines and fallback order belong to Rust.
// Explicitly supplied execFile ports retain their Node callback/error semantics.
fn execute<'a>(
    ctx: L<'a>,
    file: &'static str,
    args: &[&str],
    timeout_ms: u64,
    encoding: bool,
) -> Result<L<'a>> {
    let injected = option(ctx, c"execFile")?;
    if injected.truthy()? {
        let argv = ctx.from_value(&V::Array(args.iter().map(|v| V::from(*v)).collect()))?;
        let options = fields(ctx, &[("timeout", num(ctx, timeout_ms as f64)?)])?;
        if encoding {
            options.set(c"encoding", text(ctx, "utf8")?)?;
        }
        return call(
            ctx.get(c"ports")?,
            c"executeInjected",
            &[injected, text(ctx, file)?, argv, options],
        );
    }
    let argv: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let environment = env(ctx);
    let promise = environment.spawn_future_with_callback(
        async move { Ok(policy::run_command(file, &argv, timeout_ms).await) },
        |env, outcome| {
            let anchor = L::new(env, ().into_unknown(env)?);
            match outcome {
                Ok(stdout) => Ok(text(anchor, &stdout)?.raw()),
                Err(err) => {
                    let error = anchor
                        .global()?
                        .get(c"Error")?
                        .construct(&[text(anchor, &err.message)?])?;
                    error.set(c"stderr", text(anchor, &err.stderr)?)?;
                    error.set(c"code", anchor.from_value(&err.code)?)?;
                    error.set(c"cmd", text(anchor, &err.command)?)?;
                    // napi's async bridge rejects with the original JavaScript error.
                    Err(napi::Error::from(arg(error)?))
                }
            }
        },
    )?;
    Ok(L::from_raw(ctx.env(), promise.raw()))
}

fn lid_result(ctx: L<'_>, available: bool, enabled: bool) -> Result<L<'_>> {
    fields(
        ctx,
        &[
            ("available", flag(ctx, available)?),
            ("enabled", flag(ctx, enabled)?),
        ],
    )
}
fn read_lid(ctx: L<'_>) -> Result<L<'_>> {
    then(
        execute(ctx, PMSET, &["-g"], 5000, true)?,
        ctx,
        |ctx, stdout| lid_result(ctx, true, policy::sleep_disabled(&as_string(stdout)?)),
    )
}
fn read_settings<'a>(ctx: L<'a>, observed: L<'a>) -> Result<L<'a>> {
    let daemon = option(ctx, c"powerd")?;
    let enabled = if daemon.truthy()? {
        call(daemon, c"readIntent", &[])?.is_string("on")?
    } else {
        system_word(Path::new(DEFAULT_INTENT)) == "on"
    };
    let out = lid_result(ctx, true, enabled)?;
    out.set(c"systemSleepDisabled", observed.get(c"enabled")?)?;
    Ok(out)
}

fn poll_lid<'a>(ctx: L<'a>, _: L<'a>) -> Result<L<'a>> {
    then(read_lid(ctx)?, ctx, |ctx, status| {
        if status.get(c"enabled")?.equals(ctx.get(c"enabled")?)? {
            return Ok(status);
        }
        let now = call(ctx.global()?.get(c"Date")?, c"now", &[])?.number()?;
        if now >= ctx.get(c"deadline")?.number()? {
            return pending(ctx);
        }
        let delay = option(ctx, c"powerdPollMs")?;
        let ms = if delay.nullish()? {
            250.
        } else {
            delay.number()?
        };
        let ms = if (1.0..=i32::MAX as f64).contains(&ms) {
            ms as u64
        } else {
            1
        };
        let environment = env(ctx);
        let timer = environment.spawn_future(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            Ok(())
        })?;
        let timer = L::from_raw(ctx.env(), timer.raw());
        then(timer, ctx, poll_lid)
    })
}
fn after_elevation<'a>(ctx: L<'a>, _: L<'a>) -> Result<L<'a>> {
    then(read_lid(ctx)?, ctx, |ctx, status| {
        if status.get(c"enabled")?.equals(ctx.get(c"enabled")?)? {
            Ok(status)
        } else {
            pending(ctx)
        }
    })
}
fn set_lid<'a>(ctx: L<'a>, enabled: L<'a>) -> Result<L<'a>> {
    let platform = platform(ctx)?;
    if !platform.is_string("darwin")? {
        return Err(napi::Error::from_reason(
            "This setting is only available on macOS",
        ));
    }
    ctx.set(c"enabled", enabled)?;
    let powerd = option(ctx, c"powerd")?;
    let installed = if powerd.truthy()? {
        call(powerd, c"setIntent", &[enabled])?.truthy()?
    } else {
        set_default_intent(platform, ctx.get(c"ports")?.get(c"fs")?, enabled)?
    };
    if installed {
        if !enabled.truthy()? {
            return then(read_lid(ctx)?, ctx, |ctx, observed| {
                let out = lid_result(ctx, true, false)?;
                out.set(c"systemSleepDisabled", observed.get(c"enabled")?)?;
                Ok(out)
            });
        }
        let wait = option(ctx, c"powerdWaitMs")?;
        let now = call(ctx.global()?.get(c"Date")?, c"now", &[])?.number()?;
        ctx.set(
            c"deadline",
            num(
                ctx,
                now + if wait.nullish()? {
                    18000.
                } else {
                    wait.number()?
                },
            )?,
        )?;
        return poll_lid(ctx, enabled);
    }
    let elevate = option(ctx, c"elevate")?;
    let elevated = if elevate.truthy()? {
        async_result(ctx, || elevate.call_plain(&[enabled, ctx.get(c"options")?]))?
    } else {
        let script = policy::authorization_script(&elevated_command(ctx, enabled)?);
        let result = execute(ctx, OSASCRIPT, &["-e", &script], 120000, true)?;
        let failed = function(ctx, "", 1, 1, |ctx, a| {
            let err = a[0];
            let detail = format!(
                "{} {}",
                as_string(err.get(c"message")?)?,
                as_string(err.get(c"stderr")?)?
            );
            if detail.to_ascii_lowercase().contains("user canceled") || detail.contains("(-128)") {
                conflict(
                    ctx,
                    "power_authorization_cancelled",
                    "已取消授权，设置未完成。",
                )
            } else {
                conflict(
                    ctx,
                    "power_authorization_failed",
                    "未能完成系统授权，请在这台 Mac 上重试。",
                )
            }
        })?;
        call(result, c"catch", &[failed])?
    };
    then(elevated, ctx, after_elevation)
}

fn battery<'a>(ctx: L<'a>, output: &str, available: Option<bool>) -> Result<L<'a>> {
    let (source, percent) = policy::battery(output);
    let out = fields(ctx, &[])?;
    if let Some(value) = available {
        out.set(c"available", flag(ctx, value)?)?;
    }
    out.set(
        c"source",
        match source {
            Some(value) => text(ctx, value)?,
            None => null(ctx)?,
        },
    )?;
    out.set(
        c"percent",
        match percent {
            Some(value) => num(ctx, value)?,
            None => null(ctx)?,
        },
    )?;
    Ok(out)
}

const SLEEP_METHODS: [(&str, &str, &[&str]); 3] = [
    ("pmset", PMSET, &["sleepnow"]),
    (
        "system-events",
        OSASCRIPT,
        &["-e", "tell application \"System Events\" to sleep"],
    ),
    (
        "finder",
        OSASCRIPT,
        &["-e", "tell application \"Finder\" to sleep"],
    ),
];
fn sleep_attempt(ctx: L<'_>, index: usize) -> Result<L<'_>> {
    let (method, file, args) = SLEEP_METHODS[index];
    let success = function(ctx, "", 1, 1, move |ctx, _| {
        fields(
            ctx,
            &[("ok", flag(ctx, true)?), ("method", text(ctx, method)?)],
        )
    })?;
    let failed = function(ctx, "", 1, 1, move |ctx, a| {
        let errors = ctx.get(c"errors")?;
        let msg = a[0].get(c"message")?;
        let detail = as_string(if msg.truthy()? { msg } else { a[0] })?;
        call(
            errors,
            c"push",
            &[text(ctx, &format!("{method}: {detail}"))?],
        )?;
        if index + 1 < SLEEP_METHODS.len() {
            sleep_attempt(ctx, index + 1)
        } else {
            fields(ctx, &[("ok", flag(ctx, false)?), ("errors", errors)])
        }
    })?;
    let result = async_result(ctx, || execute(ctx, file, args, 15000, false))?;
    call(result, c"then", &[success, failed])
}

pub(super) fn read_battery<'a>(p: L<'a>, options: L<'a>) -> Result<L<'a>> {
    async_result(p, || {
        let ctx = context(p, options)?;
        if !platform(ctx)?.is_string("darwin")? {
            return battery(ctx, "", Some(false));
        }
        then(
            execute(ctx, PMSET, &["-g", "batt"], 5000, true)?,
            ctx,
            |ctx, v| battery(ctx, &as_string(v)?, Some(true)),
        )
    })
}

pub(super) fn lid_prevention<'a>(p: L<'a>, options: L<'a>, settings: bool) -> Result<L<'a>> {
    async_result(p, || {
        let ctx = context(p, options)?;
        if !platform(ctx)?.is_string("darwin")? {
            return lid_result(ctx, false, false);
        }
        let observed = read_lid(ctx)?;
        if settings {
            then(observed, ctx, read_settings)
        } else {
            Ok(observed)
        }
    })
}

pub(super) fn sleep_now<'a>(p: L<'a>, options: L<'a>) -> Result<L<'a>> {
    async_result(p, || {
        let ctx = context(p, options)?;
        ctx.set(c"errors", ctx.from_value(&V::Array(vec![]))?)?;
        sleep_attempt(ctx, 0)
    })
}

#[napi]
pub fn macos_power_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = fields(p, &[])?;
    api.set(
        c"isAvailable",
        function(p, "isAvailable", 0, 1, |p, a| {
            let os = if a[0].undefined()? {
                p.get(c"platform")?
            } else {
                a[0]
            };
            flag(p, os.is_string("darwin")?)
        })?,
    )?;
    api.set(
        c"parseBatteryStatus",
        function(p, "parseBatteryStatus", 1, 1, |p, a| {
            battery(p, &as_string(a[0])?, None)
        })?,
    )?;
    api.set(
        c"parseLidSleepPrevention",
        function(p, "parseLidSleepPrevention", 1, 1, |p, a| {
            flag(p, policy::sleep_disabled(&as_string(a[0])?))
        })?,
    )?;
    api.set(
        c"elevatedCommand",
        function(p, "elevatedCommand", 1, 2, |p, a| {
            text(p, &elevated_command(context(p, a[1])?, a[0])?)
        })?,
    )?;
    api.set(
        c"readBattery",
        function(p, "readBattery", 0, 1, |p, a| read_battery(p, a[0]))?,
    )?;
    for (name, settings) in [
        ("getLidSleepPrevention", false),
        ("getLidModeSettings", true),
    ] {
        api.set_key(
            text(p, name)?,
            function(p, name, 0, 1, move |p, a| lid_prevention(p, a[0], settings))?,
        )?;
    }
    api.set(
        c"setLidSleepPrevention",
        function(p, "setLidSleepPrevention", 1, 2, |p, a| {
            async_result(p, || set_lid(context(p, a[1])?, a[0]))
        })?,
    )?;
    api.set(
        c"sleepNow",
        function(p, "sleepNow", 0, 1, |p, a| sleep_now(p, a[0]))?,
    )?;
    Ok(api.raw())
}
