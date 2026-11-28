//! Live cache tickets, retained card objects and asynchronous board reads.
use crate::host_api::*;
use napi_derive::napi;
use std::ffi::CStr;

fn request<'a>(s: L<'a>, op: &str, args: &[(&str, L<'a>)]) -> Result<L<'a>> {
    let c = fields(s, &[("op", text(s, op)?)])?;
    for (k, v) in args {
        c.define_key(text(s, k)?, *v)?
    }
    Ok(c)
}
fn sync<'a>(s: L<'a>, c: L<'a>) -> Result<L<'a>> {
    json_call(
        s,
        c"parse",
        call(s.get(c"native")?, c"run", &[json_call(s, c"stringify", c)?])?,
    )
}
enum QueueInput<'a> {
    Serialized(L<'a>),
    Command(L<'a>),
}
fn queued_call<'a>(
    s: L<'a>,
    method: &'static CStr,
    input: QueueInput<'a>,
    extra: &[L<'a>],
) -> Result<L<'a>> {
    let native = s.get(c"native")?;
    if !callable(native.get(method)?)? {
        return Err(error_value(s, "卡片快照 Rust 接口不可用，请构建当前原生模块")?.throw_error());
    }
    let args = array(s)?;
    let (value, serialize_at_start) = match input {
        QueueInput::Serialized(value) => (value, false),
        QueueInput::Command(command) => (command, true),
    };
    args.set_element(0, value)?;
    for (i, v) in extra.iter().enumerate() {
        args.set_element(i as u32 + 1, *v)?
    }
    let frame = fields(s, &[("native", native), ("args", args)])?;
    let start = function(frame, "", 0, 0, move |f, _| {
        let native = f.get(c"native")?;
        let method = native.get(method)?;
        let args = f.get(c"args")?;
        if serialize_at_start {
            args.set_element(0, json_call(f, c"stringify", args.element(0)?)?)?;
        }
        call(
            f.global()?.get(c"Reflect")?,
            c"apply",
            &[method, native, args],
        )
    })?;
    then(
        s.get(c"ports")?.get(c"runNative")?.call_plain(&[start])?,
        s,
        |p, a| json_call(p, c"parse", a[0]),
    )
}
fn enqueue<'a>(s: L<'a>, f: L<'a>, run: Action) -> Result<L<'a>> {
    let result = then(s.get(c"tail")?, f, run)?;
    let ignore = function(s, "", 0, 0, |s, _| undef(s))?;
    s.set(c"tail", call(result, c"then", &[ignore, ignore])?)?;
    // Keep the next queued read ahead of continuations awaiting this request.
    call(result, c"finally", &[ignore])
}
fn report<'a>(s: L<'a>, logs: L<'a>) -> Result<()> {
    if logs.nullish()? {
        return Ok(());
    }
    logs.for_each(|row| {
        let event = row.get(c"event")?;
        let data = spread(row)?;
        data.delete(c"event")?;
        s.catch(|| {
            let logger = s.get(c"logger")?;
            if logger.nullish()? {
                return undef(s);
            }
            let f = if event.is_string("air_card_cache_mismatch")? {
                logger.get(c"warn")?
            } else {
                let mut method = logger.get(c"info")?;
                for key in [c"log", c"warn"] {
                    if method.truthy()? {
                        break;
                    }
                    method = logger.get(key)?;
                }
                method
            };
            if f.nullish()? {
                return undef(s);
            }
            f.call(logger, &[event, data])
        })?;
        Ok(())
    })
}
fn prepare<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        let command = a[0];
        let held = s.get(c"prepared")?;
        let store = s
            .get(c"ports")?
            .get(c"boardStoreOf")?
            .call_plain(&[command.get(c"board")?])?;
        let token = fallback(held.optional(c"token")?, V::Number(0.))?;
        let result = if store.truthy()? && callable(s.get(c"native")?.get(c"prepareBoardAsync")?)? {
            call(store, c"flush", &[])?;
            let c = spread(command)?;
            c.delete(c"board")?;
            queued_call(
                s,
                c"prepareBoardAsync",
                QueueInput::Serialized(json_call(s, c"stringify", c)?),
                &[token, store.get(c"native")?],
            )?
        } else {
            queued_call(
                s,
                c"prepareAsync",
                QueueInput::Serialized(json_call(s, c"stringify", command)?),
                &[token],
            )?
        };
        then(result, fields(s, &[("s", s), ("held", held)])?, |f, a| {
            let v = a[0].get(c"prepared")?;
            let v = if v.truthy()? {
                v
            } else {
                f.get(c"held")?.get(c"value")?
            };
            f.get(c"s")?.set(
                c"prepared",
                fields(f, &[("token", a[0].get(c"token")?), ("value", v)])?,
            )?;
            Ok(v)
        })
    })
}
fn snapshot<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let f = fields(s, &[("s", s), ("command", a[0]), ("build", a[1])])?;
    enqueue(s, f, |f, _| {
        let s = f.get(c"s")?;
        let planned = queued_call(
            s,
            c"snapshotPlanAsync",
            QueueInput::Command(f.get(c"command")?),
            &[],
        )?;
        then(planned, f, |f, a| {
            let s = f.get(c"s")?;
            let ticket = a[0].get(c"ticket")?;
            f.set(c"ticket", ticket)?;
            let r = async_result(f, || {
                let b = f.get(c"build")?;
                let needed = a[0].get(c"needed")?;
                let bases = if callable(b)? {
                    b.call_plain(&[if needed.truthy()? { needed } else { array(f)? }])?
                } else {
                    array(f)?
                };
                then(bases, f, |f, v| {
                    let s = f.get(c"s")?;
                    let c = f.get(c"command")?;
                    let facts = pick(c, &[c"now", c"facts", c"merges", c"capacityReasons"])?;
                    facts.set(
                        c"knownRenderToken",
                        with_default(
                            c.get(c"knownRenderToken")?,
                            s.get(c"rendered")?.optional(c"token")?,
                        )?,
                    )?;
                    facts.set(c"ticket", f.get(c"ticket")?)?;
                    facts.set(c"bases", v[0])?;
                    let result =
                        queued_call(s, c"snapshotFinishAsync", QueueInput::Command(facts), &[])?;
                    then(result, s, |s, a| {
                        let reply = a[0];
                        report(s, reply.get(c"logs")?)?;
                        let token = reply.get(c"renderToken")?;
                        let mut cards = reply.get(c"cards")?;
                        if cards.nullish()? {
                            let held = s.get(c"rendered")?;
                            if !held.truthy()? || !token.equals(held.get(c"token")?)? {
                                return Err(error_value(
                                    s,
                                    "卡片快照未回传正文，但 renderToken 与宿主持有的不一致",
                                )?
                                .throw_error());
                            }
                            cards = held.get(c"cards")?;
                        }
                        s.set(
                            c"rendered",
                            fields(s, &[("token", token), ("cards", cards)])?,
                        )?;
                        let out = spread(reply)?;
                        out.set(c"cards", cards)?;
                        Ok(out)
                    })
                })
            })?;
            recover(r, f, |f, a| {
                let why = a[0];
                let abort = async_result(f, || {
                    queued_call(
                        f.get(c"s")?,
                        c"snapshotAbortAsync",
                        QueueInput::Command(pick(f, &[c"ticket"])?),
                        &[],
                    )
                })?;
                let fail = function(why, "", 0, 0, |e, _| Err(e.throw_error()))?;
                call(abort, c"then", &[fail, fail])
            })
        })
    })
}
fn plan(f: L<'_>) -> Result<L<'_>> {
    let s = f.get(c"s")?;
    let opts = f.get(c"opts")?;
    let items = array(s)?;
    let rows = f.get(c"items")?;
    for i in 0..rows.get(c"length")?.number()? as u32 {
        let row = rows.element(i)?;
        let key = string(call(opts, c"keyOf", &[row])?)?;
        let sig = opts.get(c"signatureOf")?;
        let mut sig = if sig.nullish()? {
            null(s)?
        } else {
            sig.call(opts, &[row])?
        };
        if sig.nullish()? {
            sig = null(s)?
        }
        items.set_element(i, fields(s, &[("key", key), ("signature", sig)])?)?;
    }
    sync(
        s,
        request(
            s,
            "plan",
            &[
                ("globalSignature", f.get(c"sig")?),
                ("now", now(s)?),
                ("prune", opts.get(c"prune")?),
                ("items", items),
            ],
        )?,
    )
}
fn finish<'a>(s: L<'a>, reply: L<'a>) -> Result<L<'a>> {
    let mirror = s.get(c"mirrors")?;
    reply.get(c"entries")?.for_each(|row| {
        call(mirror, c"set", &[row.get(c"token")?, row.get(c"entry")?])?;
        Ok(())
    })?;
    let entries = array(s)?;
    reply.get(c"tokens")?.for_each(|k| {
        call(entries, c"push", &[call(mirror, c"get", &[k])?])?;
        Ok(())
    })?;
    let retained = s
        .global()?
        .get(c"Set")?
        .construct(&[reply.get(c"retained")?])?;
    call(mirror, c"keys", &[])?.for_each(|k| {
        if !call(retained, c"has", &[k])?.truthy()? {
            call(mirror, c"delete", &[k])?;
        }
        Ok(())
    })?;
    report(s, reply.get(c"logs")?)?;
    fields(
        s,
        &[
            ("entries", entries),
            ("hits", reply.get(c"hits")?),
            ("builds", reply.get(c"builds")?),
            (
                "render",
                pick(reply, &[c"keys", c"tokens", c"nativeRenderable"])?,
            ),
        ],
    )
}
fn frame<'a>(s: L<'a>, a: &[L<'a>]) -> Result<L<'a>> {
    fields(
        s,
        &[
            ("s", s),
            ("sig", a[0]),
            ("items", a[1]),
            ("opts", a[2]),
            ("built", array(s)?),
        ],
    )
}
fn build_one<'a>(f: L<'a>, idx: L<'a>) -> Result<(bool, L<'a>)> {
    let opts = f.get(c"opts")?;
    let item = f.get(c"items")?.get_key(idx)?;
    let base = opts.get(c"nativeBaseOf")?;
    if base.truthy()? {
        Ok((true, base.call(opts, &[item])?))
    } else {
        Ok((false, call(opts, c"build", &[item])?))
    }
}
fn append<'a>(f: L<'a>, base: bool, value: L<'a>) -> Result<()> {
    let row = fields(
        f,
        &[
            (if base { "base" } else { "entry" }, value),
            ("random", f.get(c"s")?.get(c"random")?.call_plain(&[])?),
        ],
    )?;
    call(f.get(c"built")?, c"push", &[row])?;
    Ok(())
}
fn complete_command(f: L<'_>) -> Result<L<'_>> {
    request(
        f,
        "complete",
        &[
            ("ticket", f.get(c"plan")?.get(c"ticket")?),
            ("built", f.get(c"built")?),
            ("now", now(f.get(c"s")?)?),
        ],
    )
}
fn abort(f: L<'_>) -> Result<()> {
    sync(
        f.get(c"s")?,
        request(f, "abort", &[("ticket", f.get(c"plan")?.get(c"ticket")?)])?,
    )?;
    Ok(())
}
fn resolve_sync<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let f = frame(s, a)?;
    let planned = plan(f)?;
    f.set(c"plan", planned)?;
    let result = (|| {
        planned.get(c"needed")?.for_each(|idx| {
            let (base, item) = build_one(f, idx)?;
            append(f, base, item)
        })?;
        finish(s, sync(s, complete_command(f)?)?)
    })();
    match result {
        Ok(v) => Ok(v),
        Err(e) => {
            let exception = s.exception_value()?;
            abort(f)?;
            Err(exception.map(|x| x.throw_error()).unwrap_or(e))
        }
    }
}
fn async_step(f: L<'_>) -> Result<L<'_>> {
    let needed = f.get(c"plan")?.get(c"needed")?;
    let n = needed.get(c"length")?.number()? as u32;
    let mut i = f.get(c"i")?.number()? as u32;
    while i < n {
        let (base, v) = build_one(f, needed.element(i)?)?;
        i += 1;
        f.set(c"i", num(f, i as f64)?)?;
        if !base {
            return then(v, f, |f, a| {
                append(f, false, a[0])?;
                after_item(f)
            });
        }
        append(f, true, v)?;
        if i % 24 == 0 {
            return yielded(f);
        }
    }
    let s = f.get(c"s")?;
    then(
        queued_call(
            s,
            c"runAsync",
            QueueInput::Serialized(json_call(s, c"stringify", complete_command(f)?)?),
            &[],
        )?,
        s,
        |s, a| finish(s, a[0]),
    )
}
fn after_item(f: L<'_>) -> Result<L<'_>> {
    if f.get(c"i")?.number()? as u32 % 24 == 0 {
        yielded(f)
    } else {
        async_step(f)
    }
}
fn yielded(f: L<'_>) -> Result<L<'_>> {
    let promise = f
        .global()?
        .get(c"Promise")?
        .construct(&[function(f, "", 2, 2, |f, a| {
            f.global()?.get(c"setImmediate")?.call_plain(&[a[0]])
        })?])?;
    then(promise, f, |f, _| async_step(f))
}
fn resolve_async<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let f = frame(s, a)?;
    enqueue(s, f, |f, _| {
        f.set(c"plan", plan(f)?)?;
        f.set(c"i", num(f, 0.)?)?;
        recover(async_result(f, || async_step(f))?, f, |f, a| {
            abort(f)?;
            Err(a[0].throw_error())
        })
    })
}
fn overlay<'a>(s: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(s, || {
        let held = s.get(c"rendered")?;
        let r = a[0];
        let render = r.get(c"render")?;
        let c = request(s, "overlay", &[])?;
        c.spread_from(render)?;
        c.spread_from(a[1])?;
        c.set(
            c"knownRenderToken",
            fallback(held.optional(c"token")?, V::Number(0.))?,
        )?;
        c.set(
            c"entries",
            if render.get(c"nativeRenderable")?.truthy()? {
                undef(s)?
            } else {
                r.get(c"entries")?
            },
        )?;
        let f = fields(
            s,
            &[("s", s), ("held", held), ("command", c), ("result", r)],
        )?;
        let first = async_result(f, || {
            queued_call(s, c"runAsync", QueueInput::Command(c), &[])
        })?;
        let result = recover(first, f, |f, a| {
            if !fold_string(a[0].get(c"message")?)?.contains("card_cache_version_changed") {
                return Err(a[0].throw_error());
            }
            let c = f.get(c"command")?;
            c.set(c"nativeRenderable", flag(c, false)?)?;
            c.set(c"entries", f.get(c"result")?.get(c"entries")?)?;
            queued_call(f.get(c"s")?, c"runAsync", QueueInput::Command(c), &[])
        })?;
        then(result, f, |f, a| {
            let reply = a[0];
            let cards = reply.get(c"cards")?;
            let cards = if cards.truthy()? {
                cards
            } else {
                f.get(c"held")?.get(c"cards")?
            };
            f.get(c"s")?.set(
                c"rendered",
                fields(f, &[("token", reply.get(c"token")?), ("cards", cards)])?,
            )?;
            Ok(cards)
        })
    })
}
fn create<'a>(ports: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let o = default_object(a[0])?;
    let ctor = ports.get(c"Owner")?;
    if !callable(ctor)? {
        return Err(
            error_value(ports, "卡片缓存 Rust 接口不可用，请构建当前原生模块")?.throw_error(),
        );
    }
    let s = fields(
        o,
        &[
            ("ports", ports),
            ("native", ctor.construct(&[])?),
            ("mirrors", o.global()?.get(c"Map")?.construct(&[])?),
            ("tail", resolved(undef(o)?)?),
            ("logger", o.get(c"logger")?),
            (
                "now",
                with_default(o.get(c"clock")?, o.global()?.get(c"Date")?.get(c"now")?)?,
            ),
            (
                "random",
                with_default(o.get(c"random")?, o.global()?.get(c"Math")?.get(c"random")?)?,
            ),
        ],
    )?;
    let c = request(
        s,
        "open",
        &[
            ("mode", with_default(o.get(c"mode")?, text(s, "shadow")?)?),
            (
                "verifyMs",
                with_default(o.get(c"verifyMs")?, num(s, 60000.)?)?,
            ),
            (
                "verifyBudget",
                with_default(o.get(c"verifyBudget")?, num(s, 8.)?)?,
            ),
            (
                "reportMs",
                with_default(o.get(c"reportMs")?, num(s, 600000.)?)?,
            ),
            ("now", now(s)?),
        ],
    )?;
    let opened = sync(s, c)?;
    let api = methods(
        s,
        &[
            ("resolve", 3, resolve_sync),
            ("resolveAsync", 3, resolve_async),
            ("snapshotAsync", 2, snapshot),
            ("overlayAsync", 2, overlay),
            ("prepareAsync", 1, prepare),
        ],
    )?;
    api.set(c"mode", opened.get(c"mode")?)?;
    api.set(
        c"stats",
        function(s, "stats", 0, 0, |s, _| sync(s, request(s, "stats", &[])?))?,
    )?;
    Ok(api)
}
#[napi]
pub fn air_card_cache_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = defaulted_methods(p, &[("createAirCardCache", 0, 1, create)])?;
    let modes = p.global()?.get(c"Set")?.construct(&[])?;
    for m in ["off", "shadow", "on"] {
        call(modes, c"add", &[text(p, m)?])?;
    }
    api.set(c"AIR_CARD_CACHE_MODES", modes)?;
    Ok(api.raw())
}
