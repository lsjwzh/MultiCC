//! 兼容宿主使用的回合进度接口。四套状态机保存在同一个 RustTurnProgress 中，
//! 回调、可替换的时钟和定时器保存在 V8 可回收的对象上。
use crate::{host_methods::method, js_iteration::read, route_response::*};
use multicc_core::turn_progress::{heartbeat::DEFAULT_INTERVAL_MS, timeline::MERGE_GAP_MS};
use napi_derive::napi;
use std::ffi::CStr;

mod heartbeat;
const DEFAULT_MAX_IDENTITIES: f64 = 64.0;

fn undefined(s: L<'_>) -> Result<L<'_>> {
    s.from_value(&V::Undefined)
}
fn options(s: L<'_>) -> Result<L<'_>> {
    if s.undefined()? {
        fields(s, &[])
    } else {
        Ok(s)
    }
}
fn number_option<'a>(obj: L<'a>, key: &CStr, fallback: f64) -> Result<L<'a>> {
    if read(obj, key)?.nullish()? {
        num(obj, fallback)
    } else {
        num(obj, read(obj, key)?.explicit_number()?)
    }
}
fn new_owner<'a>(root: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let interval = number_option(opts, c"intervalMs", DEFAULT_INTERVAL_MS)?;
    let max = number_option(opts, c"maxIdentities", DEFAULT_MAX_IDENTITIES)?;
    root.get(c"ctor")?.construct(&[interval, max])
}
fn func(value: L<'_>) -> Result<bool> {
    Ok(value.kind()? == sys::ValueType::napi_function)
}
fn now(s: L<'_>) -> Result<L<'_>> {
    call(s.global()?.get(c"Date")?, c"now", &[])
}

fn bound<'a>(
    state: L<'a>,
    name: &'static str,
    length: usize,
    count: usize,
    run: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<L<'a>> {
    let env = Env::from_raw(state.env());
    let f = method(&env, state, name, length, count, run)?;
    Ok(L::from_raw(state.env(), f.raw()))
}
fn add<'a>(
    object: L<'a>,
    state: L<'a>,
    name: &'static str,
    length: usize,
    count: usize,
    run: impl for<'b> Fn(L<'b>, &mut [L<'b>]) -> Result<L<'b>> + 'static,
) -> Result<()> {
    object.define_key(text(state, name)?, bound(state, name, length, count, run)?)
}
fn timeline<'a>(root: L<'a>, owner: L<'a>) -> Result<L<'a>> {
    let state = fields(root, &[("owner", owner), ("root", root)])?;
    let out = fields(root, &[])?;
    for (name, op, n) in [
        ("startTurn", c"timelineStart", 3),
        ("observeClaude", c"timelineObserveClaude", 4),
        ("observeAdapter", c"timelineObserveAdapter", 4),
        ("currentStage", c"timelineCurrentStage", 3),
        ("snapshot", c"timelineSnapshot", 3),
        ("field", c"timelineSnapshot", 3),
        ("forget", c"timelineForget", 1),
    ] {
        add(out, state, name, n, n, move |s, a| {
            if n > 1 && a[n - 1].undefined()? {
                a[n - 1] = now(s)?;
            }
            let mut owner = s.get(c"owner")?;
            if !owner.truthy()? {
                let root = s.get(c"root")?;
                owner = root.get(c"shared")?;
                if !owner.truthy()? {
                    owner = new_owner(root, fields(s, &[])?)?;
                    root.set(c"shared", owner)?;
                }
            }
            let result = call(owner, op, a)?;
            if name == "field" {
                if result.truthy()? {
                    fields(s, &[("timeline", result)])
                } else {
                    fields(s, &[])
                }
            } else {
                Ok(result)
            }
        })?;
    }
    out.freeze()
}
fn registry_owner(s: L<'_>) -> Result<L<'_>> {
    let mut owner = s.get(c"owner")?;
    if !owner.truthy()? {
        owner = new_owner(s.get(c"root")?, s.get(c"options")?)?;
        s.set(c"owner", owner)?;
    }
    Ok(owner)
}
fn clock<'a>(opts: L<'a>) -> Result<L<'a>> {
    if func(read(opts, c"now")?)? {
        let now = read(opts, c"now")?;
        bound(now, "now", 0, 0, |callback, _| callback.call_plain(&[]))
    } else {
        bound(opts, "now", 0, 0, |s, _| now(s))
    }
}
fn probe<'a>(root: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let max = number_option(opts, c"maxIdentities", DEFAULT_MAX_IDENTITIES)?;
    let clock = clock(opts)?;
    let state = fields(
        root,
        &[
            ("root", root),
            ("options", fields(root, &[("maxIdentities", max)])?),
            ("owner", read(opts, c"owner")?),
            ("ports", fields(root, &[("now", clock)])?),
        ],
    )?;
    let out = fields(root, &[])?;
    add(out, state, "record", 3, 4, |s, a| {
        let facts = options(a[3])?;
        call(
            registry_owner(s)?,
            c"probeRecord",
            &[a[0], a[1], a[2], facts, s.get(c"ports")?],
        )
    })?;
    add(out, state, "lookup", 2, 2, |s, a| {
        call(registry_owner(s)?, c"probeLookup", a)
    })?;
    out.freeze()
}
fn log_timing<'a>(s: L<'a>, plan: L<'a>, abort: bool) -> Result<L<'a>> {
    let out = fields(s, &[])?;
    let summary = fields(s, &[])?;
    for k in [c"sessionId", c"turnId", c"cli"] {
        summary.set(k, read(plan, k)?)?;
    }
    for k in [c"t0", c"t1", c"t2", c"t3"] {
        let v = read(plan, k)?;
        let v = if k != c"t0" && v.kind()? == sys::ValueType::napi_null {
            v
        } else {
            let time = if k == c"t0" { v } else { read(plan, k)? };
            let date = s.global()?.get(c"Date")?.construct(&[time])?;
            call(date, c"toISOString", &[])?
        };
        summary.set(k, v)?;
    }
    let ms = fields(s, &[])?;
    for k in [c"spawn", c"send", c"firstByte", c"total"] {
        ms.set(k, read(read(plan, c"ms")?, k)?)?;
    }
    summary.set(c"ms", ms)?;
    let (tag, summary) = if abort {
        out.set(c"reason", read(plan, c"reason")?)?;
        out.spread_from(summary)?;
        ("[turn-timing-abort] ", out)
    } else {
        ("[turn-timing] ", summary)
    };
    let json = call(s.global()?.get(c"JSON")?, c"stringify", &[summary])?;
    let mut line = multicc_core::js::JsString::from(tag);
    line.push(&json.coerce_string()?);
    let line = s.from_value(&V::String(line))?;
    let emit = s.get(c"emit")?;
    if func(emit)? {
        emit.call_plain(&[line])
    } else {
        s.catch(|| call(s.global()?.get(c"console")?, c"log", &[line]))?;
        undefined(s)
    }
}
fn timing<'a>(root: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let clock = clock(opts)?;
    let emit = if func(read(opts, c"emit")?)? {
        read(opts, c"emit")?
    } else {
        undefined(root)?
    };
    let state = fields(
        root,
        &[
            ("root", root),
            ("options", fields(root, &[])?),
            ("emit", emit),
            ("owner", read(opts, c"owner")?),
        ],
    )?;
    let ports = fields(root, &[("now", clock)])?;
    add(ports, state, "emitTiming", 1, 1, |s, a| {
        log_timing(s, a[0], false)
    })?;
    add(ports, state, "emitAbort", 1, 1, |s, a| {
        log_timing(s, a[0], true)
    })?;
    state.set(c"ports", ports)?;
    let out = fields(root, &[])?;
    add(out, state, "begin", 3, 3, |s, a| {
        let opts = options(a[2])?;
        if opts.nullish()? {
            return Err(s.type_error("Cannot read properties of null (reading 't0')"));
        }
        let value = |key: &CStr| -> Result<_> {
            let v = read(opts, key)?;
            if v.undefined()? {
                null(s)
            } else {
                Ok(v)
            }
        };
        let opts = fields(s, &[("t0", value(c"t0")?), ("cli", value(c"cli")?)])?;
        call(
            registry_owner(s)?,
            c"timingBegin",
            &[a[0], a[1], opts, s.get(c"ports")?],
        )
    })?;
    for (name, op, n) in [
        ("get", c"timingGet", 2),
        ("markSpawned", c"timingMark", 3),
        ("markSent", c"timingMark", 3),
        ("markFirstByte", c"timingMarkFirstByte", 3),
        ("abort", c"timingAbort", 3),
        ("drop", c"timingDrop", 2),
        ("field", c"timingField", 2),
    ] {
        add(out, state, name, n, n, move |s, a| {
            let owner = registry_owner(s)?;
            if op == c"timingMark" {
                let key = if name == "markSpawned" { "t1" } else { "t2" };
                call(
                    owner,
                    op,
                    &[a[0], a[1], text(s, key)?, a[2], s.get(c"ports")?],
                )
            } else if n == 3 {
                call(owner, op, &[a[0], a[1], a[2], s.get(c"ports")?])
            } else {
                let result = call(owner, op, a)?;
                if name == "drop" {
                    undefined(s)
                } else {
                    Ok(result)
                }
            }
        })?;
    }
    out.freeze()
}

fn progress<'a>(root: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let owner = new_owner(root, opts)?;
    let state = fields(root, &[("root", root), ("owner", owner)])?;
    let out = fields(root, &[("owner", owner)])?;
    for name in ["heartbeat", "timeline", "timing", "deliveryProbe"] {
        if name == "timeline" {
            out.set(c"timeline", timeline(root, owner)?)?;
            continue;
        }
        add(out, state, name, 1, 1, move |s, a| {
            let opts = fields(s, &[])?;
            opts.spread_from(a[0])?;
            opts.define_key(text(s, "owner")?, s.get(c"owner")?)?;
            let root = s.get(c"root")?;
            match name {
                "heartbeat" => root.get(c"heartbeat")?.construct(&[opts]),
                "timing" => timing(root, opts),
                _ => probe(root, opts),
            }
        })?;
    }
    add(out, state, "forgetSession", 1, 1, |s, a| {
        let owner = s.get(c"owner")?;
        call(owner, c"timelineForget", a)?;
        call(owner, c"probeForget", a)?;
        undefined(s)
    })?;
    Ok(out)
}

#[napi]
pub fn turn_progress_api(
    env: Env,
    addon: Unknown<'_>,
    make_class: Unknown<'_>,
) -> Result<sys::napi_value> {
    let addon = L::new(&env, addon);
    let root = fields(addon, &[("ctor", addon.get(c"RustTurnProgress")?)])?;
    let ctor = heartbeat::class(root, L::new(&env, make_class))?;
    root.set(c"heartbeat", ctor)?;
    let out = fields(
        root,
        &[
            ("DEFAULT_INTERVAL_MS", num(root, DEFAULT_INTERVAL_MS)?),
            ("MERGE_GAP_MS", num(root, MERGE_GAP_MS)?),
            ("TurnProgressHeartbeat", ctor),
        ],
    )?;
    add(out, root, "createTurnTimingRecorder", 0, 1, |s, a| {
        timing(s, options(a[0])?)
    })?;
    add(out, root, "createDeliveryProbeRegistry", 0, 1, |s, a| {
        probe(s, options(a[0])?)
    })?;
    add(out, root, "createTurnProgress", 0, 1, |s, a| {
        progress(s, options(a[0])?)
    })?;
    add(out, root, "createTurnTimelinePort", 0, 1, |s, a| {
        timeline(s, a[0])
    })?;
    add(
        out,
        root,
        "shouldReexecutePersistedDelivery",
        3,
        3,
        |s, a| flag(s, crate::turn_progress::reexecute(a[0], a[1], a[2])?),
    )?;
    add(out, root, "sanitizePhase", 1, 1, |s, a| {
        s.from_value(&crate::turn_progress::phase(a[0])?)
    })?;
    add(out, root, "sanitizeToolKind", 1, 1, |s, a| {
        s.from_value(&crate::turn_progress::tool_kind(a[0])?)
    })?;
    out.spread_from(timeline(root, null(root)?)?)?;
    Ok(out.raw())
}
