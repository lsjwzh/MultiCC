//! A display-only projection with store-owned envelope recovery.
use crate::host_api::*;
use multicc_core::{js::JsString, quota_routes::BAR_KINDS};
use napi_derive::napi;
fn clean(v: L<'_>, limit: usize) -> Result<L<'_>> {
    let s = if v.nullish()? {
        JsString::new()
    } else {
        string(v)?.coerce_string()?
    };
    let cleaned = JsString::from_units(
        s.as_units()
            .iter()
            .map(|&u| if u < 32 || u == 127 { 32 } else { u })
            .collect(),
    )
    .trim();
    v.from_value(&V::String(JsString::from_units(
        cleaned.as_units().iter().copied().take(limit).collect(),
    )))
}
fn positive_stamp(v: L<'_>) -> Result<f64> {
    let n = v.explicit_number()?;
    Ok(if n.is_finite() && n >= 0. {
        n.trunc()
    } else {
        0.
    })
}
fn selector<'a>(kind: L<'a>, s: L<'a>) -> Result<L<'a>> {
    let kind = call(clean(kind, 40)?, c"toLowerCase", &[])?;
    if kind.is_string("claude")? {
        let session = clean(s.optional(c"session")?, 180)?;
        if session.truthy()? {
            return call(text(kind, "claude:session:")?, c"concat", &[session]);
        }
        return text(kind, "claude:global");
    }
    let ark = kind.is_string("ark")?;
    if !ark && !kind.is_string("kimi")? {
        return Ok(kind);
    }
    let base = s.optional(c"baseUrl")?;
    let url = if base.kind()? == sys::ValueType::napi_string && base.truthy()? {
        kind.catch(|| kind.global()?.get(c"URL")?.construct(&[base]))?
            .unwrap_or(null(kind)?)
    } else {
        null(kind)?
    };
    let mut part = if ark {
        text(kind, "")?
    } else {
        call(clean(s.optional(c"host")?, 120)?, c"toLowerCase", &[])?
    };
    if !part.truthy()? && url.truthy()? {
        let path = if ark {
            fold_string(call(url.get(c"pathname")?, c"toLowerCase", &[])?)?
        } else {
            String::new()
        };
        part = if path.contains("/coding") {
            text(kind, "coding-plan")?
        } else if path.contains("/plan") {
            text(kind, "agent-plan")?
        } else {
            call(url.get(c"hostname")?, c"toLowerCase", &[])?
        };
    }
    if !part.truthy()? && ark {
        part = clean(s.optional(c"host")?, 120)?;
    }
    call(
        kind,
        c"concat",
        &[text(kind, ":")?, fallback(part, "default".into())?],
    )
}
fn normalize(b: L<'_>) -> Result<L<'_>> {
    if !object(b)? || b.is_array()? {
        return null(b);
    }
    let action = b.get(c"action")?;
    let out = fields(
        b,
        &[
            ("text", clean(b.get(c"text")?, 500)?),
            ("color", clean(b.get(c"color")?, 40)?),
            ("title", clean(b.get(c"title")?, 1200)?),
            (
                "action",
                if action.nullish()? {
                    null(b)?
                } else {
                    clean(action, 80)?
                },
            ),
        ],
    )?;
    let states = b.get(c"states")?;
    let states = if object(states)? && !states.is_array()? {
        let json = b.global()?.get(c"JSON")?;
        call(json, c"parse", &[call(json, c"stringify", &[states])?])?
    } else {
        undef(b)?
    };
    out.set(c"states", states)?;
    Ok(out)
}
fn entry<'a>(entries: L<'a>, key: L<'a>) -> Result<L<'a>> {
    let row = entries.get_key(key)?;
    if !row.truthy()? {
        return null(entries);
    }
    let out = spread(row)?;
    out.set(c"bar", normalize(row.get(c"bar")?)?)?;
    Ok(out)
}
fn keys(v: L<'_>) -> Result<L<'_>> {
    call(v.global()?.get(c"Object")?, c"keys", &[v])
}
fn prune(rows: L<'_>) -> Result<()> {
    let all = keys(rows)?;
    if all.get(c"length")?.number()? <= 80. {
        return Ok(());
    }
    let mut sorted = vec![];
    all.for_each(|k| {
        sorted.push((positive_stamp(rows.get_key(k)?.optional(c"updatedAt")?)?, k));
        Ok(())
    })?;
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
    for (_, key) in &sorted[..sorted.len() - 80] {
        call(
            rows.global()?.get(c"Reflect")?,
            c"deleteProperty",
            &[rows, *key],
        )?;
    }
    Ok(())
}
fn record<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let key = selector(a[0], a[3])?;
    let bar = normalize(a[2])?;
    if !key.truthy()? || !bar.truthy()? {
        return null(p);
    }
    let at = now(p)?;
    let result = a[1];
    let status = fallback(clean(result.optional(c"status")?, 80)?, "ok".into())?;
    let state = p.get(c"state")?;
    let rows = state.get(c"entries")?;
    let prev = rows.get_key(key)?;
    let ok = status.is_string("ok")?;
    let row = if ok || !prev.optional(c"bar")?.truthy()? {
        let fetched = positive_stamp(result.optional(c"fetchedAt")?)?;
        fields(
            p,
            &[
                ("key", key),
                ("kind", clean(a[0], 40)?),
                ("status", status),
                ("bar", bar),
                (
                    "fetchedAt",
                    if fetched == 0. { at } else { num(p, fetched)? },
                ),
            ],
        )?
    } else {
        spread(prev)?
    };
    row.set(c"updatedAt", at)?;
    let err = if ok {
        null(p)?
    } else {
        let e = result.optional(c"error")?;
        let e = if e.truthy()? {
            e
        } else {
            result.optional(c"reason")?
        };
        clean(if e.truthy()? { e } else { status }, 200)?
    };
    row.set(c"lastError", err)?;
    row.set(c"lastErrorAt", if ok { null(p)? } else { at })?;
    rows.define_key(key, row)?;
    state.set(c"updatedAt", at)?;
    prune(rows)?;
    call(p, c"save", &[state])?;
    spread(rows.get_key(key)?)
}
#[napi]
pub fn quota_bar_cache_api(env: Env, anchor: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, anchor);
    Ok(methods(
        p,
        &[
            ("selectorKey", 2, |_, a| selector(a[0], a[1])),
            ("normalizeBar", 1, |_, a| normalize(a[0])),
        ],
    )?
    .raw())
}
fn load_state(p: L<'_>) -> Result<L<'_>> {
    let loaded = call(p, c"load", &[])?;
    let data = if loaded.optional(c"present")?.truthy()? {
        loaded.get(c"data")?
    } else {
        null(p)?
    };
    let entries = data.optional(c"entries")?;
    fields(
        p,
        &[
            (
                "entries",
                if object(entries)? {
                    entries
                } else {
                    fields(p, &[])?
                },
            ),
            (
                "updatedAt",
                num(p, positive_stamp(data.optional(c"updatedAt")?)?)?,
            ),
        ],
    )
}
#[napi]
pub fn quota_bar_cache_store(env: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&env, ports);
    let state = match load_state(p) {
        Ok(state) => state,
        Err(error) => {
            let cause = p
                .exception_value()?
                .unwrap_or(error_value(p, &error.reason)?);
            call(p, c"loadFailed", &[cause])?;
            fields(
                p,
                &[("entries", fields(p, &[])?), ("updatedAt", num(p, 0.)?)],
            )?
        }
    };
    p.set(c"state", state)?;
    let api = methods(
        p,
        &[
            ("record", 4, record),
            ("selectorKey", 2, |_, a| selector(a[0], a[1])),
            ("get", 2, |p, a| {
                entry(p.get(c"state")?.get(c"entries")?, selector(a[0], a[1])?)
            }),
            ("snapshot", 0, |p, _| {
                let state = p.get(c"state")?;
                let rows = state.get(c"entries")?;
                let out = fields(p, &[])?;
                keys(rows)?.for_each(|k| out.define_key(k, entry(rows, k)?))?;
                fields(
                    p,
                    &[("entries", out), ("updatedAt", state.get(c"updatedAt")?)],
                )
            }),
            ("snapshotFor", 1, |p, a| {
                let state = p.get(c"state")?;
                let rows = state.get(c"entries")?;
                let bars = fields(p, &[])?;
                for name in BAR_KINDS {
                    let k = text(p, name)?;
                    bars.define_key(k, entry(rows, selector(k, a[0])?)?)?;
                }
                fields(
                    p,
                    &[
                        ("status", text(p, "ok")?),
                        ("bars", bars),
                        ("updatedAt", state.get(c"updatedAt")?),
                    ],
                )
            }),
        ],
    )?;
    api.set(c"file", p.get(c"file")?)?;
    Ok(api.freeze()?.raw())
}
