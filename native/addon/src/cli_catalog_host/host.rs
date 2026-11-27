//! Loopback-only interface between the Rust front door and live CLI/provider ports.
use super::*;
fn bad(p: L<'_>) -> Result<L<'_>> {
    fields(p, &[("error", flag(p, true)?)])
}
fn success(p: L<'_>) -> Result<L<'_>> {
    fields(p, &[("ok", flag(p, true)?)])
}
fn unavailable(s: L<'_>) -> Result<L<'_>> {
    fields(
        s,
        &[("ok", flag(s, false)?), ("error", s.get(c"unavailable")?)],
    )
}
fn settle<'a>(s: L<'a>, value: L<'a>) -> Result<L<'a>> {
    if !s.get(c"settled")?.truthy()? {
        s.set(c"settled", flag(s, true)?)?;
        s.get(c"resolve")?.call_plain(&[value])?;
    }
    undef(s)
}
fn cli<'a>(p: L<'a>, op: &str, refresh: L<'a>) -> Result<L<'a>> {
    let (answer, s) = promise(p)?;
    s.set(
        c"unavailable",
        text(s, &format!("{op} models unavailable"))?,
    )?;
    let start = (|| {
        let (catalog, name) = if op == "opencode" {
            (
                call(p, c"openCode", &[])?,
                String::from("listOpenCodeModels"),
            )
        } else {
            let spec = vendors::spec(op).expect("known operation");
            (vendors::catalog(p, text(p, op)?)?, spec.list.to_owned())
        };
        let cb = function(s, "", 3, 3, |s, a| {
            if s.get(c"settled")?.truthy()? {
                return undef(s);
            }
            let value = if a[0].truthy()? {
                unavailable(s)?
            } else {
                fields(
                    s,
                    &[
                        ("ok", flag(s, true)?),
                        ("models", if a[1].is_array()? { a[1] } else { array(s)? }),
                        ("source", string(truthy_or(a[2], text(s, "")?)?)?),
                    ],
                )?
            };
            settle(s, value)
        })?;
        catalog
            .get_key(text(s, &name)?)?
            .call(catalog, &[cb, fields(s, &[("refresh", refresh)])?])
    })();
    if let Err(err) = start {
        let _ = caught(s, err)?;
        settle(s, unavailable(s)?)?;
    }
    Ok(answer)
}
fn service<'a>(s: L<'a>, key: &CStr) -> Result<L<'a>> {
    let v = s.get(c"options")?.get(key)?;
    let runtime = if callable(v)? {
        call(s.get(c"options")?, key, &[])?
    } else {
        v
    };
    if runtime.truthy()? {
        Ok(runtime)
    } else {
        get_fn(s.get(c"owner")?, key)
    }
}
fn codex_state<'a>(s: L<'a>, id: L<'a>) -> Result<L<'a>> {
    let Some(provider) =
        s.catch(|| call(service(s, c"codexRuntime")?, c"resolveProvider", &[id]))?
    else {
        return bad(s);
    };
    if !provider.truthy()? {
        return fields(s, &[("found", flag(s, false)?)]);
    }
    let official = s
        .catch(|| call(s.get(c"owner")?, c"isOfficial", &[provider]))?
        .unwrap_or(flag(s, false)?);
    let state = fields(
        s,
        &[
            ("found", flag(s, true)?),
            ("id", provider.get(c"id")?),
            ("appType", provider.get(c"appType")?),
            ("official", official),
        ],
    )?;
    if official.truthy()? {
        state.set(
            c"peek",
            s.catch(|| call(service(s, c"codexRuntime")?, c"peekProvider", &[provider]))?
                .unwrap_or(null(s)?),
        )?;
        let refreshing =
            s.catch(|| call(service(s, c"codexRuntime")?, c"isRefreshing", &[provider]))?;
        state.set(
            c"refreshing",
            flag(
                s,
                match refreshing {
                    Some(v) => v.is_true()?,
                    None => false,
                },
            )?,
        )?;
    }
    Ok(state)
}
fn codex_refresh<'a>(s: L<'a>, b: L<'a>, id: L<'a>, refresh: L<'a>) -> Result<L<'a>> {
    let result = (|| {
        let pending = call(
            service(s, c"codexRuntime")?,
            c"refreshProvider",
            &[id, fields(s, &[("refresh", refresh)])?],
        )?;
        if b.get(c"wait")?.is_true()? {
            let done = then(pending, s, |s, _| success(s))?;
            return recover(done, s, |s, _| bad(s));
        }
        call(
            pending,
            c"catch",
            &[function(s, "", 0, 0, |s, _| undef(s))?],
        )?;
        success(s)
    })();
    match result {
        Ok(v) => Ok(v),
        Err(err) => {
            let _ = caught(s, err)?;
            bad(s)
        }
    }
}
fn handle<'a>(s: L<'a>, b: L<'a>) -> Result<L<'a>> {
    let op = b
        .optional(c"op")?
        .string()?
        .map(|v| v.to_string_lossy())
        .unwrap_or_default();
    if !matches!(
        op.as_str(),
        "provider"
            | "codex-state"
            | "codex-refresh"
            | "opencode"
            | "qoder"
            | "codebuddy"
            | "commandcode"
            | "grok"
    ) {
        return bad(s);
    }
    let refresh = flag(s, b.get(c"refresh")?.is_true()?)?;
    if op == "opencode" || vendors::spec(&op).is_some() {
        return cli(s.get(c"owner")?, &op, refresh);
    }
    let id = b.get(c"providerId")?;
    if op == "provider" {
        let result = call(
            service(s, c"providerRuntime")?,
            c"listProviderModels",
            &[id, fields(s, &[("refresh", refresh)])?],
        )?;
        return then(result, s, |_, a| pick(a[0], &[c"status", c"body"]));
    }
    let id = if id.string()?.is_some() {
        id
    } else {
        text(s, "codex-official")?
    };
    if op == "codex-state" {
        codex_state(s, id)
    } else {
        codex_refresh(s, b, id, refresh)
    }
}
fn create<'a>(p: L<'a>, opts: L<'a>) -> Result<L<'a>> {
    let s = fields(p, &[("owner", p), ("options", default_object(opts)?)])?;
    function(s, "handle", 1, 1, |s, a| {
        async_result(s, || handle(s, a[0]))
    })
}
fn mount<'a>(p: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if !callable(a[0].optional(c"post")?)? {
        return Err(p.type_error("[model-catalogs-host] Express-compatible app is required"));
    }
    let options = default_object(a[1])?;
    let local = truthy_or(options.get(c"isLocal")?, p.get(c"isLocal")?)?;
    let s = fields(p, &[("isLocal", local), ("handle", create(p, options)?)])?;
    let handler = function(s, "", 2, 2, |s, a| {
        let req = a[0];
        let res = a[1];
        if !s.get(c"isLocal")?.call_plain(&[req])?.truthy()? {
            return error(res, 404, "not found", false);
        }
        let body = req.get(c"body")?;
        let body = if object(body)? && !body.is_array()? {
            body
        } else {
            fields(s, &[])?
        };
        let value = call(s, c"handle", &[body])?;
        let ok = function(res, "", 1, 1, |r, a| send(r, None, a[0]))?;
        let fail = function(res, "", 0, 0, |r, _| {
            error(r, 500, "host operation failed", false)
        })?;
        call(resolved(value)?, c"then", &[ok, fail])?;
        undef(s)
    })?;
    call(a[0], c"post", &[text(p, kernel::HOST_PATH)?, handler])?;
    undef(p)
}
pub(super) fn api(p: L<'_>) -> Result<L<'_>> {
    p.set(c"catalogs", p.global()?.get(c"Map")?.construct(&[])?)?;
    let out = methods(
        p,
        &[("getVendorCatalog", 1, |p, a| vendors::catalog(p, a[0]))],
    )?;
    reg(out, p, "mountModelCatalogsHostRoute", 1, 2, mount)?;
    reg(out, p, "createModelCatalogsHost", 0, 1, |p, a| {
        create(p, a[0])
    })?;
    out.set(c"HOST_PATH", text(p, kernel::HOST_PATH)?)?;
    Ok(out)
}
