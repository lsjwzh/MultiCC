//! Structured logging, metrics and route scrubbing over live V8 values.
use crate::host_api::*;
use crate::host_methods::{arg, env as host_env, variadic_method};
use multicc_core::js::JsString;
use multicc_core::provider_scrub::{collision_safe_key, route_redact, ScrubValue};
use multicc_core::redaction;
use napi::bindgen_prelude::ToNapiValue;
use napi_derive::napi;

pub(crate) fn maybe_route(v: L<'_>) -> Result<bool> {
    let mut stack = vec![v];
    let mut seen = None;
    while let Some(item) = stack.pop() {
        if let Some(s) = item.string()? {
            if redaction::has_route_anchor(&s) {
                return Ok(true);
            }
        } else if item.number_value()?.is_some_and(f64::is_nan) {
            return Ok(true);
        } else if object(item)? {
            let set = match seen {
                Some(set) => set,
                None => {
                    let set = v.global()?.get(c"WeakSet")?.construct(&[])?;
                    seen = Some(set);
                    set
                }
            };
            if call(set, c"has", &[item])?.truthy()? {
                return Ok(true);
            }
            call(set, c"add", &[item])?;
            let keys = call(v.global()?.get(c"Object")?, c"keys", &[item])?;
            for i in 0..keys.get(c"length")?.number()? as u32 {
                let key = keys.element(i)?;
                stack.extend([key, item.get_key(key)?]);
            }
        }
    }
    Ok(false)
}

fn leave<'a>(ancestors: L<'a>, value: L<'a>) -> Result<()> {
    let count = call(ancestors, c"get", &[value])?.number()?;
    if count == 1. {
        call(ancestors, c"delete", &[value])?;
    } else {
        call(ancestors, c"set", &[value, num(value, count - 1.)?])?;
    }
    Ok(())
}

struct ObjectFrame<'a> {
    source: L<'a>,
    output: L<'a>,
    entries: std::vec::IntoIter<(JsString, L<'a>)>,
}

// Walk ordinary objects iteratively. Arrays retain their host map/species and
// holes. A getter may return its own receiver on one read and a leaf on
// the next. Revisit it as JS would, with a bound for a persistent cycle.
fn scrub<'a>(value: L<'a>, key: &JsString, ancestors: L<'a>) -> Result<L<'a>> {
    let leaf = |v: L<'a>, key: &JsString| -> Result<Option<L<'a>>> {
        if redaction::has_text_keyword(key) && redaction::is_secret_key(key) {
            return Ok(Some(text(v, "[REDACTED]")?));
        }
        if let Some(s) = v.string()? {
            if !redaction::has_route_anchor(&s) && !redaction::has_text_keyword(&s) {
                return Ok(Some(v));
            }
            let result = redaction::redact_text(&s);
            return Ok(Some(if result == s {
                v
            } else {
                v.from_value(&V::String(result))?
            }));
        }
        if !object(v)? {
            return Ok(Some(v));
        }
        let visits = call(ancestors, c"get", &[v])?.number_value()?.unwrap_or(0.);
        if visits >= 1024. {
            return Err(v
                .global()?
                .get(c"RangeError")?
                .construct(&[text(v, "Maximum call stack size exceeded")?])?
                .throw_error());
        }
        call(ancestors, c"set", &[v, num(v, visits + 1.)?])?;
        if v.is_array()? {
            let callback = function(ancestors, "redactItem", 1, 1, |seen, a| {
                scrub(a[0], &JsString::new(), seen)
            })?;
            let result = call(v, c"map", &[callback])?;
            leave(ancestors, v)?;
            return Ok(Some(result));
        }
        Ok(None)
    };
    if let Some(result) = leaf(value, key)? {
        return Ok(result);
    }
    let frame = |v: L<'a>| -> Result<ObjectFrame<'a>> {
        let output = fields(v, &[])?;
        let pairs = call(v.global()?.get(c"Object")?, c"entries", &[v])?;
        let count = pairs.get(c"length")?.number()? as u32;
        let mut entries = Vec::with_capacity(count as usize);
        for i in 0..count {
            let pair = pairs.element(i)?;
            entries.push((pair.element(0)?.coerce_string()?, pair.element(1)?));
        }
        Ok(ObjectFrame {
            source: v,
            output,
            entries: entries.into_iter(),
        })
    };
    let first = frame(value)?;
    let result = first.output;
    let mut frames = vec![first];
    while let Some(top) = frames.last_mut() {
        let Some((key, item)) = top.entries.next() else {
            leave(ancestors, top.source)?;
            frames.pop();
            continue;
        };
        let safe_key = collision_safe_key(top.output, &redaction::redact_route_capability(&key))?;
        if let Some(clean) = leaf(item, &key)? {
            top.output.define_value(&safe_key, clean)?;
        } else {
            let nested = frame(item)?;
            top.output.define_value(&safe_key, nested.output)?;
            frames.push(nested);
        }
    }
    Ok(result)
}

fn redact<'a>(value: L<'a>, key: L<'a>) -> Result<L<'a>> {
    let key = if key.undefined()? {
        JsString::new()
    } else {
        key.coerce_string()?
    };
    if !object(value)? || (redaction::has_text_keyword(&key) && redaction::is_secret_key(&key)) {
        return scrub(value, &key, value);
    }
    scrub(
        value,
        &key,
        value.global()?.get(c"WeakMap")?.construct(&[])?,
    )
}

fn logger<'a>(p: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let opts = default_object(opts)?;
    let owner = fields(
        p,
        &[
            (
                "sink",
                with_default(opts.get(c"sink")?, p.global()?.get(c"console")?)?,
            ),
            (
                "service",
                with_default(opts.get(c"service")?, text(p, "multicc")?)?,
            ),
            ("now", with_default(opts.get(c"now")?, p.get(c"date")?)?),
        ],
    )?;
    let api = fields(p, &[])?;
    for (level, channel) in [("info", c"log"), ("warn", c"warn"), ("error", c"error")] {
        let method = function(owner, level, 2, 2, move |o, a| {
            let record = fields(
                o,
                &[
                    ("ts", call(now(o)?, c"toISOString", &[])?),
                    ("level", text(o, level)?),
                    ("service", o.get(c"service")?),
                    ("event", string(fallback(a[0], "log".into())?)?),
                ],
            )?;
            if a[1].truthy()? {
                record.spread_from(a[1])?;
            }
            let line = json_call(o, c"stringify", redact(record, undef(o)?)?)?;
            let sink = o.get(c"sink")?;
            let write = sink.get(channel)?;
            o.catch(|| {
                let write = if write.truthy()? {
                    write
                } else {
                    sink.get(c"log")?
                };
                write.call(sink, &[line])
            })?;
            undef(o)
        })?;
        api.define_key(text(p, level)?, method)?;
    }
    Ok(api)
}

fn metric_name(name: L<'_>) -> Result<()> {
    let key = name.coerce_string()?;
    let s = key.as_units();
    let initial = |u: u16| u < 128 && ((u as u8).is_ascii_alphabetic() || matches!(u, 58 | 95));
    if s.first().copied().is_some_and(initial)
        && s.iter().all(|&u| initial(u) || (48..=57).contains(&u))
    {
        return Ok(());
    }
    let mut msg = JsString::from_rust_str("invalid metric name: ");
    msg.push(&name.coerce_string()?);
    Err(crate::js_iteration::type_error(name.env(), msg.as_units()))
}

fn set_metric<'a>(map: L<'a>, name: L<'a>, value: L<'a>) -> Result<()> {
    metric_name(name)?;
    if value.explicit_number()?.is_finite() {
        call(map, c"set", &[name, num(map, value.explicit_number()?)?])?;
    }
    Ok(())
}

fn metrics(p: L<'_>) -> Result<L<'_>> {
    let map = p.global()?.get(c"Map")?.construct(&[])?;
    let owner = fields(p, &[("values", map), ("add", p.get(c"add")?)])?;
    defaulted_methods(
        owner,
        &[
            ("inc", 1, 2, |o, a| {
                metric_name(a[0])?;
                let map = o.get(c"values")?;
                let v = fallback(call(map, c"get", &[a[0]])?, V::Number(0.))?;
                let amount = with_default(a[1], num(o, 1.)?)?;
                call(
                    map,
                    c"set",
                    &[a[0], o.get(c"add")?.call_plain(&[v, amount])?],
                )?;
                undef(o)
            }),
            ("set", 2, 2, |o, a| {
                set_metric(o.get(c"values")?, a[0], a[1])?;
                undef(o)
            }),
            ("get", 1, 1, |o, a| {
                fallback(call(o.get(c"values")?, c"get", &[a[0]])?, V::Number(0.))
            }),
            ("render", 0, 1, |o, a| {
                let merged = o.global()?.get(c"Map")?.construct(&[o.get(c"values")?])?;
                call(
                    o.global()?.get(c"Object")?,
                    c"entries",
                    &[default_object(a[0])?],
                )?
                .for_each(|pair| set_metric(merged, pair.element(0)?, pair.element(1)?))?;
                let rows = call(o.global()?.get(c"Array")?, c"from", &[merged])?;
                let cmp = function(o, "compareNames", 2, 2, |_, a| {
                    call(a[0].element(0)?, c"localeCompare", &[a[1].element(0)?])
                })?;
                call(rows, c"sort", &[cmp])?;
                let mut output = JsString::new();
                rows.for_each(|pair| {
                    output.push(&pair.element(0)?.coerce_string()?);
                    output.push_str(" ");
                    output.push(&pair.element(1)?.coerce_string()?);
                    output.push_str("\n");
                    Ok(())
                })?;
                if output.is_empty() {
                    output.push_str("\n");
                }
                o.from_value(&V::String(output))
            }),
        ],
    )
}

fn install(p: L<'_>, target: L<'_>) -> Result<()> {
    if !target.truthy()? || target.get(c"__multiccRedacted")?.truthy()? {
        return Ok(());
    }
    for key in [c"log", c"info", c"warn", c"error", c"debug"] {
        if !callable(target.get(key)?)? {
            continue;
        }
        let original = call(target.get(key)?, c"bind", &[target])?;
        let env = host_env(p);
        let wrapped = variadic_method(&env, original, "redactedConsole", 0, |f, args| {
            for arg in args.iter_mut() {
                *arg = redact(*arg, undef(f)?)?;
            }
            f.call_plain(args)
        })?;
        target.assign(key, wrapped)?;
    }
    call(
        p.global()?.get(c"Object")?,
        c"defineProperty",
        &[
            target,
            text(p, "__multiccRedacted")?,
            fields(
                p,
                &[("value", flag(p, true)?), ("configurable", flag(p, false)?)],
            )?,
        ],
    )?;
    Ok(())
}

#[napi]
pub fn observability_api(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let api = defaulted_methods(
        p,
        &[
            ("createObservability", 0, 1, |p, a| {
                let logger = logger(p, a[0])?;
                let metrics = metrics(p)?;
                let lag = p
                    .get(c"monitor")?
                    .call_plain(&[fields(p, &[("resolution", num(p, 20.)?)])?])?;
                call(lag, c"enable", &[])?;
                fields(
                    p,
                    &[
                        ("logger", logger),
                        ("metrics", metrics),
                        (
                            "eventLoopMetrics",
                            function(lag, "eventLoopMetrics", 0, 0, |lag, _| {
                                let seconds = |key| -> Result<L<'_>> {
                                    let n = lag.get(key)?.number_value()?;
                                    num(
                                        lag,
                                        if n.is_some_and(f64::is_finite) {
                                            lag.get(key)?.number()? / 1e9
                                        } else {
                                            0.
                                        },
                                    )
                                };
                                fields(
                                    lag,
                                    &[
                                        ("multicc_event_loop_lag_mean_seconds", seconds(c"mean")?),
                                        ("multicc_event_loop_lag_max_seconds", seconds(c"max")?),
                                    ],
                                )
                            })?,
                        ),
                        (
                            "close",
                            function(lag, "close", 0, 0, |lag, _| {
                                call(lag, c"disable", &[])?;
                                undef(lag)
                            })?,
                        ),
                    ],
                )
            }),
            ("createLogger", 0, 1, |p, a| logger(p, a[0])),
            ("createMetrics", 0, 0, |p, _| metrics(p)),
            ("createExactSecretStreamRedactor", 0, 1, |p, a| {
                let secrets = with_default(a[0], array(p)?)?;
                let stream = crate::exact_secret::RustExactSecretStreamRedactor::new(
                    host_env(p),
                    arg(secrets)?,
                )?;
                // Transfer the new transducer to its V8 owner. Detached methods
                // keep that same native instance alive through their bound receiver.
                let owner = L::from_raw(p.env(), unsafe {
                    crate::exact_secret::RustExactSecretStreamRedactor::to_napi_value(
                        p.env(),
                        stream,
                    )?
                });
                let out = fields(p, &[])?;
                for k in [
                    c"push",
                    c"setSecrets",
                    c"flush",
                    c"discard",
                    c"pendingLength",
                ] {
                    out.set(k, call(owner.get(k)?, c"bind", &[owner])?)?;
                }
                out.freeze()
            }),
            ("redactExactSecretFragments", 1, 2, |p, a| {
                let env = host_env(p);
                let result = crate::exact_secret::redaction_exact_fragments(
                    env,
                    arg(a[0])?,
                    arg(with_default(a[1], array(p)?)?)?,
                )?;
                Ok(L::from_raw(p.env(), result))
            }),
            ("redact", 1, 2, |_, a| redact(a[0], a[1])),
            ("redactProviderRouteCapability", 1, 1, |_, a| {
                if a[0].kind()? == sys::ValueType::napi_string || maybe_route(a[0])? {
                    route_redact(a[0], &mut Vec::new(), 0)
                } else {
                    Ok(a[0])
                }
            }),
            ("maybeRouteCapability", 1, 1, |p, a| {
                flag(p, maybe_route(a[0])?)
            }),
            ("installConsoleRedaction", 0, 1, |p, a| {
                let target = with_default(a[0], p.global()?.get(c"console")?)?;
                install(p, target)?;
                Ok(target)
            }),
        ],
    )?;
    Ok(api.raw())
}
