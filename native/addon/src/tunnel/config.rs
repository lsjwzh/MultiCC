//! Desired tunnel configuration and the publication boundary. The injected
//! writer commits before a new monitor generation can observe the update.
use crate::js_live::spread;
use crate::route_response::*;
use std::ffi::CStr;

const PROVIDERS: [&CStr; 5] = [c"phddns", c"tailscale", c"natapp", c"cpolar", c"sakurafrp"];
const LIMITS: [(&CStr, f64, f64, f64); 4] = [
    (c"intervalSec", 10., 2_147_483., 30.),
    (c"failThreshold", 1., 100., 2.),
    (c"restartCooldownSec", 0., 86_400., 120.),
    (c"maxRestartsPerHour", 1., 100., 5.),
];

pub(super) fn now(s: L<'_>) -> Result<f64> {
    call(s.global()?.get(c"Date")?, c"now", &[])?.number()
}
fn bounded(v: L<'_>, min: f64, max: f64) -> Result<Option<f64>> {
    Ok(v.number_value()?
        .filter(|x| x.fract() == 0. && *x >= min && *x <= max))
}
pub(super) fn valid_port(v: L<'_>) -> Result<bool> {
    Ok(bounded(v, 1., 65_535.)?.is_some())
}
pub(super) fn port(v: L<'_>) -> Result<f64> {
    Ok(bounded(v, 1., 65_535.)?.unwrap_or(3000.))
}
pub(super) fn failure_threshold(v: L<'_>) -> Result<f64> {
    Ok(bounded(v, 1., 100.)?.unwrap_or(2.))
}
fn object(v: L<'_>) -> Result<L<'_>> {
    if v.kind()? == sys::ValueType::napi_object && !v.nullish()? && !v.is_array()? {
        Ok(v)
    } else {
        fields(v, &[])
    }
}
fn own(obj: L<'_>, key: &CStr) -> Result<bool> {
    call(
        obj.global()?.get(c"Object")?,
        c"hasOwn",
        &[obj, text(obj, key.to_str().unwrap())?],
    )?
    .is_true()
}
fn boolean<'a>(obj: L<'a>, key: &CStr, invalid: bool) -> Result<L<'a>> {
    if own(obj, key)? {
        let v = obj.get(key)?;
        if v.kind()? == sys::ValueType::napi_boolean {
            return Ok(v);
        }
        return flag(obj, invalid);
    }
    flag(obj, false)
}
fn url(obj: L<'_>) -> Result<L<'_>> {
    if own(obj, c"url")? {
        let value = obj.get(c"url")?;
        if let Some(source) = value.string()? {
            if source.as_units().len() <= 2048 {
                let value = value.clean_text()?;
                if value.truthy()? {
                    if let Some(parsed) =
                        obj.catch(|| obj.global()?.get(c"URL")?.construct(&[value]))?
                    {
                        let protocol = parsed.get(c"protocol")?;
                        if (protocol.is_string("http:")? || protocol.is_string("https:")?)
                            && parsed.get(c"hostname")?.truthy()?
                        {
                            return Ok(value);
                        }
                    }
                }
            }
        }
    }
    text(obj, "")
}
fn safe_text<'a>(obj: L<'a>, key: &CStr, default: &str) -> Result<L<'a>> {
    if own(obj, key)? {
        let v = obj.get(key)?;
        if let Some(s) = v.string()? {
            if s.as_units().len() <= 4096 && !s.as_units().iter().any(|c| matches!(c, 0 | 10 | 13))
            {
                let clean = v.clean_text()?;
                if clean.truthy()? || default.is_empty() {
                    return Ok(clean);
                }
            }
        }
    }
    text(obj, default)
}
fn normalize(input: L<'_>) -> Result<L<'_>> {
    let source = object(input)?;
    let out = fields(source, &[])?;
    for name in PROVIDERS {
        let src = object(source.get(name)?)?;
        let p = fields(
            src,
            &[
                ("enabled", boolean(src, c"enabled", false)?),
                ("monitorOnly", boolean(src, c"monitorOnly", true)?),
                ("url", url(src)?),
            ],
        )?;
        if name == c"tailscale" {
            p.set(c"funnel", boolean(src, c"funnel", false)?)?;
            p.set(c"funnelPort", num(src, port(src.get(c"funnelPort")?)?)?)?;
        }
        let cmd = match name.to_bytes() {
            b"natapp" => Some("natapp -authtoken={authtoken}"),
            b"cpolar" => Some("cpolar http {port}"),
            b"sakurafrp" => Some("frpc -f {authtoken}"),
            _ => None,
        };
        if let Some(cmd) = cmd {
            p.set(c"authtoken", safe_text(src, c"authtoken", "")?)?;
            p.set(c"port", num(src, port(src.get(c"port")?)?)?)?;
            p.set(c"startCmd", safe_text(src, c"startCmd", cmd)?)?;
        }
        out.set(name, p)?;
    }
    for (key, min, max, default) in LIMITS {
        out.set(
            key,
            num(
                source,
                bounded(source.get(key)?, min, max)?.unwrap_or(default),
            )?,
        )?;
    }
    Ok(out)
}
fn new_state(s: L<'_>) -> Result<L<'_>> {
    let z = num(s, 0.)?;
    let nil = null(s)?;
    let empty = text(s, "")?;
    let array = || s.from_value(&V::Array(vec![]));
    fields(
        s,
        &[
            ("lastCheckAt", z),
            ("lastHttpCode", nil),
            ("healthy", nil),
            ("consecutiveFails", z),
            ("restartTimes", array()?),
            ("lastRestartAt", z),
            ("repairableFailStreak", z),
            ("attemptTimes", array()?),
            ("lastAttemptAt", z),
            ("probeMode", text(s, "url")?),
            ("probeVerdict", text(s, "unknown")?),
            ("probeError", empty),
            ("publicUrl", empty),
            ("originHttpCode", nil),
            ("resolvedAddressCount", z),
            ("edgeSuccessCount", z),
            ("lastAction", empty),
            ("checking", flag(s, false)?),
        ],
    )
}
pub(super) fn initialize(s: L<'_>) -> Result<()> {
    let states = fields(s, &[])?;
    for name in PROVIDERS {
        states.set(name, new_state(s)?)?;
    }
    s.set(c"states", states)?;
    s.set(c"config", normalize(fields(s, &[])?)?)?;
    s.set(c"reporter", null(s)?)?;
    s.set(
        c"consistency",
        fields(
            s,
            &[
                ("degraded", flag(s, false)?),
                ("dirty", flag(s, false)?),
                ("reason", text(s, "")?),
                ("lastFailureAt", num(s, 0.)?),
            ],
        )?,
    )
}
pub(super) fn reset_evidence(state: L<'_>) -> Result<()> {
    state.set(c"consecutiveFails", num(state, 0.)?)?;
    state.set(c"repairableFailStreak", num(state, 0.)?)
}
pub(super) fn prune(state: L<'_>, now: f64) -> Result<()> {
    for (key, window) in [
        (c"restartTimes".as_ref(), 3_600_000.),
        (c"attemptTimes", 86_400_000.),
    ] {
        let history = state.get(key)?;
        let mut retained = std::collections::VecDeque::with_capacity(100);
        history.for_each(|v| {
            if v.number_value()?
                .is_some_and(|t| t.is_finite() && now - t < window)
            {
                if retained.len() == 100 {
                    retained.pop_front();
                }
                retained.push_back(v);
            }
            Ok(())
        })?;
        let result = state.from_value(&V::Array(vec![]))?;
        for (i, v) in retained.into_iter().enumerate() {
            result.set_element(i as u32, v)?;
        }
        state.set(key, result)?;
    }
    Ok(())
}
pub(super) fn replace_snapshot(s: L<'_>, name: &str) -> Result<()> {
    let states = s.get(c"states")?;
    let key = text(s, name)?;
    let previous = states.get_key(key)?;
    let next = new_state(s)?;
    if previous.truthy()? {
        for key in [c"restartTimes".as_ref(), c"attemptTimes"] {
            let value = previous.get(key)?;
            if value.is_array()? {
                next.set(key, value)?;
            }
        }
        for key in [c"lastRestartAt".as_ref(), c"lastAttemptAt"] {
            let v = previous.get(key)?;
            if v.number_value()?.is_some_and(f64::is_finite) {
                next.set(key, v)?;
            }
        }
        prune(next, now(s)?)?;
    }
    states.set_key(key, next)
}
pub(super) fn set_reporter<'a>(s: L<'a>, f: L<'a>) -> Result<()> {
    s.set(
        c"reporter",
        if f.kind()? == sys::ValueType::napi_function {
            f
        } else {
            null(s)?
        },
    )
}
pub(super) fn consistency_failure(s: L<'_>, stage: &str) -> Result<()> {
    let c = s.get(c"consistency")?;
    let reason = match stage {
        "funnel_compensation" | "config_persistence_rollback" => stage,
        _ => "config_runtime_rollback",
    };
    c.set(c"degraded", flag(s, true)?)?;
    c.set(c"dirty", flag(s, true)?)?;
    c.set(c"reason", text(s, reason)?)?;
    c.set(c"lastFailureAt", num(s, now(s)?)?)?;
    let f = s.get(c"reporter")?;
    if !f.nullish()? {
        s.catch(|| f.call_plain(&[text(s, reason)?, text(s, "compensation_failed")?]))?;
    }
    Ok(())
}
pub(super) fn load(s: L<'_>) -> Result<L<'_>> {
    let fs = s.get(c"fs")?;
    let file = s.get(c"configFile")?;
    let loaded = s.catch(|| -> Result<()> {
        if call(fs, c"existsSync", &[file])?.truthy()? {
            let source = call(fs, c"readFileSync", &[file, text(s, "utf8")?])?;
            let raw = call(s.global()?.get(c"JSON")?, c"parse", &[source])?;
            s.set(c"config", normalize(raw)?)?;
        }
        Ok(())
    })?;
    if loaded.is_none() {
        s.set(c"config", normalize(fields(s, &[])?)?)?;
        call(
            s.global()?.get(c"console")?,
            c"error",
            &[text(
                s,
                "[multicc/tunnel] Tunnel config is unreadable; providers disabled",
            )?],
        )?;
    }
    s.get(c"config")
}
pub(super) fn save<'a>(s: L<'a>, next: L<'a>) -> Result<()> {
    s.get(c"atomicWriteJson")?
        .call_plain(&[s.get(c"configFile")?, next])?;
    Ok(())
}
fn persist<'a>(s: L<'a>, f: L<'a>, cfg: L<'a>) -> Result<()> {
    if f.undefined()? {
        save(s, cfg)
    } else {
        f.call_plain(&[cfg])?;
        Ok(())
    }
}
fn publish<'a>(s: L<'a>, f: L<'a>) -> Result<()> {
    if f.undefined()? {
        super::start_loop(s)
    } else {
        f.call_plain(&[])?;
        Ok(())
    }
}
// Preserve the first thrown JS value while attempting both compensating actions.
// A later rollback failure is attached to the original error for the HTTP route.
fn exception<'a>(s: L<'a>, e: napi::Error) -> Result<L<'a>> {
    match s.exception_value()? {
        Some(v) => Ok(v),
        None => s.global()?.get(c"Error")?.construct(&[text(s, &e.reason)?]),
    }
}
pub(super) fn apply<'a>(s: L<'a>, update: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let opts = crate::host_methods::default_object(opts)?;
    let writer = opts.get(c"persist")?;
    let refresh = opts.get(c"publish")?;
    let previous = s.get(c"config")?;
    let mut enabled = [false; 5];
    for (i, name) in PROVIDERS.iter().enumerate() {
        enabled[i] = previous.get(name)?.get(c"enabled")?.truthy()?;
    }
    let next = spread(previous)?;
    next.spread_from(update)?;
    for name in PROVIDERS {
        let p = spread(previous.get(name)?)?;
        p.spread_from(update.get(name)?)?;
        next.set(name, p)?;
    }
    let mut changed = false;
    if update.get(c"tailscale")?.truthy()? {
        let a = previous.get(c"tailscale")?;
        let b = next.get(c"tailscale")?;
        for key in [c"enabled".as_ref(), c"url", c"funnel", c"funnelPort"] {
            if !a.get(key)?.equals(b.get(key)?)? {
                changed = true;
                break;
            }
        }
    }
    persist(s, writer, next)?;
    s.set(c"config", next)?;
    if let Err(error) = publish(s, refresh) {
        let error = exception(s, error)?;
        let mut failure = null(s)?;
        if let Err(e) = persist(s, writer, previous) {
            failure = exception(s, e)?;
            consistency_failure(s, "config_persistence_rollback")?;
        }
        s.set(c"config", previous)?;
        if let Err(e) = publish(s, refresh) {
            let cause = exception(s, e)?;
            if !failure.truthy()? {
                failure = cause;
            }
            consistency_failure(s, "config_runtime_rollback")?;
        }
        if failure.truthy()? && !error.nullish()? {
            // The original CommonJS module assigns in sloppy mode; an error
            // object can be frozen or a primitive without masking its reason.
            if matches!(
                error.kind()?,
                sys::ValueType::napi_object | sys::ValueType::napi_function
            ) {
                call(
                    s.global()?.get(c"Reflect")?,
                    c"set",
                    &[error, text(s, "rollbackError")?, failure],
                )?;
            }
        }
        return Err(error.throw_error());
    }
    let current = s.get(c"config")?;
    let states = s.get(c"states")?;
    for (i, name) in PROVIDERS.iter().enumerate() {
        if *name == c"tailscale" && changed {
            replace_snapshot(s, "tailscale")?;
        } else if current.get(name)?.get(c"enabled")?.truthy()? && !enabled[i] {
            states.set(name, new_state(s)?)?;
        }
    }
    if update.get(c"tailscale")?.truthy()? {
        reset_evidence(states.get(c"tailscale")?)?;
        let probe = s.get(c"probe")?;
        if probe.truthy()? {
            call(probe, c"clearCache", &[])?;
        }
    }
    s.get(c"config")
}
pub(super) fn status(s: L<'_>) -> Result<L<'_>> {
    let states = s.get(c"states")?;
    for name in PROVIDERS {
        prune(states.get(name)?, now(s)?)?;
    }
    let available = super::availability(s)?;
    let providers = fields(s, &[])?;
    for name in PROVIDERS {
        let st = spread(states.get(name)?)?;
        if name == c"tailscale" {
            st.set(c"repairGuard", super::ledger::status(s, now(s)?)?)?;
        }
        providers.set(name, st)?;
    }
    fields(
        s,
        &[
            ("config", s.get(c"config")?),
            ("availability", available),
            ("monitorRunning", flag(s, s.get(c"timer")?.truthy()?)?),
            ("providers", providers),
            ("consistency", spread(s.get(c"consistency")?)?),
        ],
    )
}
