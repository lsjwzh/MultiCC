//! Live adapter for injected SDK transports and older router backends. The
//! default Rust CPR transport has its own guarded route in router-port.
mod exchange;
mod headers;
mod observation;
use crate::{
    host_methods::{arg, async_result, default_object, env, function, raw},
    route_response::*,
};
use napi_derive::napi;
use std::ffi::CStr;

fn und(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Undefined)
}
fn word(v: L<'_>) -> Result<String> {
    Ok(v.coerce_string()?.to_string_lossy())
}
fn s_or<'env>(v: L<'env>, default: &str) -> Result<L<'env>> {
    string(fallback(v, default.into())?)
}
fn now(p: L<'_>) -> Result<L<'_>> {
    call(p.global()?.get(c"Date")?, c"now", &[])
}
fn arr(p: L<'_>) -> Result<L<'_>> {
    p.from_value(&V::Array(vec![]))
}
fn func(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_function)
}
fn obj(v: L<'_>) -> Result<bool> {
    Ok(v.kind()? == sys::ValueType::napi_object && !v.is_array()?)
}
fn plain<'a>(p: L<'a>, k: &CStr, a: &[L<'a>]) -> Result<L<'a>> {
    p.get(k)?.call_plain(a)
}
fn parse(v: L<'_>) -> Result<L<'_>> {
    if obj(v)? {
        return Ok(v);
    }
    let parsed = v.catch(|| call(v.global()?.get(c"JSON")?, c"parse", &[s_or(v, "{}")?]))?;
    match parsed {
        Some(o) if obj(o)? => Ok(o),
        _ => fields(v, &[]),
    }
}
pub(crate) fn official(row: L<'_>) -> Result<bool> {
    if !row.truthy()? || !row.get(c"appType")?.is_string("codex")? {
        return Ok(false);
    }
    let cfg = parse(row.get(c"settingsConfig")?)?;
    let auth = parse(cfg.get(c"auth")?)?;
    if auth.get(c"OPENAI_API_KEY")?.truthy()? || cfg.get(c"proxyTarget")?.truthy()? {
        return Ok(false);
    }
    let config = s_or(cfg.get(c"config")?, "")?;
    let re = row
        .global()?
        .get(c"RegExp")?
        .construct(&[text(row, r"(?:^|\n)\s*base_url\s*=")?, text(row, "i")?])?;
    if call(re, c"test", &[config])?.truthy()? {
        return Ok(false);
    }
    let mode = call(s_or(auth.get(c"auth_mode")?, "")?, c"toLowerCase", &[])?;
    if mode.truthy()? {
        return mode.is_string("chatgpt");
    }
    Ok(row.get(c"source")?.is_string("ccswitch")?
        && row.get(c"id")?.is_string("codex-official")?
        && !call(config, c"trim", &[])?.truthy()?
        && !cfg.get(c"officialAccount")?.truthy()?)
}
fn credential<'a>(p: L<'a>, o: L<'a>) -> Result<L<'a>> {
    let o = default_object(o)?;
    let file = o.get(c"authFile")?;
    let file = if file.truthy()? {
        file
    } else {
        p.get(c"authFile")?
    };
    let at = if func(o.get(c"now")?)? {
        call(o, c"now", &[])?
    } else {
        now(p)?
    };
    let input = fields(
        p,
        &[
            ("operation", text(p, "codexCredential")?),
            ("file", file),
            ("now", at),
        ],
    )?;
    if o.get(c"readFileSync")?.truthy()? {
        let Some(v) = p.catch(|| parse(call(o, c"readFileSync", &[file, text(p, "utf8")?])?))?
        else {
            return fields(
                p,
                &[
                    ("ok", flag(p, false)?),
                    ("reason", text(p, "credential_unreadable")?),
                ],
            );
        };
        input.set(c"auth", v)?;
    }
    Ok(raw(
        p,
        crate::provider_host_values::provider_credential_value(env(p), arg(input)?)?,
    ))
}
fn api<'a>(s: L<'a>, k: &CStr) -> Result<L<'a>> {
    s.get(c"handler")?.get(c"ports")?.get(k)
}
fn diag<'a>(options: L<'a>, event: &str, facts: L<'a>) -> Result<()> {
    options.catch(|| {
        let logger = options.get(c"logger")?;
        let warn = logger.optional(c"warn")?;
        if func(warn)? {
            warn.call(logger, &[text(options, event)?, facts])?;
        }
        Ok(())
    })?;
    Ok(())
}
fn json<'a>(res: L<'a>, status: L<'a>, body: L<'a>) -> Result<L<'a>> {
    if func(res.get(c"status")?)? && func(res.get(c"json")?)? {
        return call(call(res, c"status", &[status])?, c"json", &[body]);
    }
    res.assign(c"statusCode", status)?;
    if func(res.get(c"setHeader")?)? {
        call(
            res,
            c"setHeader",
            &[
                text(res, "content-type")?,
                text(res, "application/json; charset=utf-8")?,
            ],
        )?;
    }
    if func(res.get(c"end")?)? {
        call(
            res,
            c"end",
            &[call(res.global()?.get(c"JSON")?, c"stringify", &[body])?],
        )?;
    }
    und(res)
}
fn role<'a>(p: L<'a>, v: L<'a>) -> Result<Option<(L<'a>, L<'a>, L<'a>)>> {
    let raw = call(call(s_or(v, "main")?, c"trim", &[])?, c"toLowerCase", &[])?;
    let s = word(raw)?;
    if s == "main" {
        return Ok(Some((text(p, "main")?, null(p)?, raw)));
    }
    if s == "sub" {
        let d = text(p, "default")?;
        return Ok(Some((text(p, "sub")?, d, d)));
    }
    let bytes = s.as_bytes();
    if s == "aux"
        || s.len() > 64
        || !bytes.first().is_some_and(|b| b.is_ascii_lowercase())
        || !bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
    {
        return Ok(None);
    }
    Ok(Some((
        text(p, "sub")?,
        if matches!(s.as_str(), "default" | "worker" | "explorer") {
            raw
        } else {
            text(p, "custom")?
        },
        raw,
    )))
}
fn read_credential<'a>(h: L<'a>, provider: L<'a>, id: L<'a>) -> Result<L<'a>> {
    if func(h.get(c"readCredential")?)? {
        return plain(
            h,
            c"readCredential",
            &[fields(h, &[("provider", provider), ("providerId", id)])?],
        );
    }
    let opts = h.get(c"options")?;
    let p = h.get(c"ports")?;
    let account = crate::codex_homes::official_account_id(provider)?;
    if !account.truthy()? {
        return credential(p, opts);
    }
    let resolve = opts.get(c"resolveAccountAuthFile")?;
    let file = if func(resolve)? {
        call(opts, c"resolveAccountAuthFile", &[account])?
    } else {
        null(p)?
    };
    if !file.truthy()? {
        return fields(
            p,
            &[
                ("ok", flag(p, false)?),
                ("reason", text(p, "account_credential_unresolved")?),
            ],
        );
    }
    let params = crate::js_live::spread(opts)?;
    params.set(c"authFile", file)?;
    credential(p, params)
}
fn invoke<'a>(h: L<'a>, req: L<'a>, res: L<'a>, next: L<'a>) -> Result<L<'a>> {
    let p = h.get(c"ports")?;
    let o = h.get(c"options")?;
    let id = s_or(req.get(c"params")?.optional(c"providerId")?, "")?;
    let provider = plain(h, c"getProvider", &[text(p, "codex")?, id])?;
    let official = official(provider)?;
    if official {
        crate::proxy_trace::mark_stage(res, text(p, "official-relay")?)?;
    }
    if !official && o.get(c"genericHistoryNormalization")?.is_false()? {
        return next.call_plain(&[]);
    }
    let history = p.get(c"history")?;
    let input = req.get(c"body")?;
    let prepared = if official {
        call(
            history,
            c"normalizeResponsesHistory",
            &[
                input,
                fields(p, &[("omitReasoningContent", flag(p, true)?)])?,
            ],
        )?
    } else {
        call(history, c"normalizeResponsesHistory", &[input])?
    };
    if prepared.get(c"changes")?.get(c"length")?.truthy()? {
        diag(
            o,
            "model_history_preprocessed",
            fields(
                p,
                &[("providerId", id), ("changes", prepared.get(c"changes")?)],
            )?,
        )?;
    }
    if !official {
        req.assign(c"body", prepared.get(c"body")?)?;
        return next.call_plain(&[]);
    }
    let Some((kind, agent, name)) = role(p, req.get(c"params")?.optional(c"role")?)? else {
        return json(
            res,
            num(p, 400.)?,
            fields(p, &[("error", text(p, "invalid Codex agent route")?)])?,
        );
    };
    let input = prepared.get(c"body")?;
    let input = if obj(input)? { input } else { fields(p, &[])? };
    let pname = provider.get(c"name")?;
    let s = fields(
        p,
        &[
            ("handler", h),
            ("options", o),
            ("provider", provider),
            ("providerId", id),
            ("providerName", if pname.truthy()? { pname } else { id }),
            ("req", req),
            ("res", res),
            ("input", input),
            (
                "sessionId",
                s_or(req.get(c"params")?.optional(c"sessionId")?, "")?,
            ),
            ("roleKind", kind),
            ("agentRole", agent),
            ("routeName", name),
            ("model", s_or(input.get(c"model")?, "")?),
            ("streaming", flag(p, !input.get(c"stream")?.is_false()?)?),
            ("startedAt", now(p)?),
            ("statusCode", null(p)?),
        ],
    )?;
    for k in [c"onActivity", c"onUsage", c"onUsageEvent", c"onDelta"] {
        s.set(k, o.get(k)?)?;
    }
    observation::activity(s, "request", None)?;
    let task = async_result(p, || read_credential(h, provider, id))?;
    call(
        task,
        c"then",
        &[function(s, "credentialReady", 1, 1, |s, a| {
            exchange::begin(s, a[0])
        })?],
    )
}
fn create<'a>(p: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let o = default_object(options)?;
    let lookup = o.get(c"getProvider")?;
    let f = o.get(c"fetch")?;
    let fetch = if f.truthy()? {
        f
    } else {
        plain(p, c"officialFetch", &[])?
    };
    let read = o.get(c"readCredential")?;
    let upstream = o.get(c"upstreamUrl")?;
    let upstream = if upstream.truthy()? {
        upstream
    } else {
        p.get(c"upstreamUrl")?
    };
    if !func(lookup)? {
        return Err(p.type_error("getProvider required"));
    }
    if !func(fetch)? {
        return Err(p.type_error("fetch required"));
    }
    let state = fields(
        p,
        &[
            ("options", o),
            ("ports", p),
            ("getProvider", lookup),
            ("readCredential", read),
            ("fetch", fetch),
            ("upstream", upstream),
        ],
    )?;
    function(state, "codexOfficialRelay", 3, 3, |h, a| {
        async_result(h, || invoke(h, a[0], a[1], a[2]))
    })
}
#[napi]
pub fn codex_official_relay_api(e: Env, ports: Unknown<'_>) -> Result<sys::napi_value> {
    let p = L::new(&e, ports);
    p.set(
        c"upstreamUrl",
        text(p, "https://chatgpt.com/backend-api/codex/responses")?,
    )?;
    p.set(c"mounted", p.global()?.get(c"WeakSet")?.construct(&[])?)?;
    Ok(fields(
        p,
        &[
            ("DEFAULT_AUTH_FILE", p.get(c"authFile")?),
            ("DEFAULT_UPSTREAM_URL", p.get(c"upstreamUrl")?),
            (
                "createCodexOfficialRelayHandler",
                function(p, "createCodexOfficialRelayHandler", 0, 1, |p, a| {
                    create(p, a[0])
                })?,
            ),
            (
                "isOfficialCodexOAuthProvider",
                function(p, "isOfficialCodexOAuthProvider", 1, 1, |p, a| {
                    flag(p, official(a[0])?)
                })?,
            ),
            (
                "mountCodexOfficialRelay",
                function(p, "mountCodexOfficialRelay", 1, 2, |p, a| {
                    let app = a[0];
                    let o = default_object(a[1])?;
                    let set = p.get(c"mounted")?;
                    if !app.truthy()?
                        || !func(app.get(c"post")?)?
                        || call(set, c"has", &[app])?.truthy()?
                    {
                        return flag(p, false);
                    }
                    call(set, c"add", &[app])?;
                    let custom = o.get(c"codexProxyPath")?;
                    let path = word(s_or(
                        if custom.truthy()? {
                            custom
                        } else {
                            o.get(c"mountPath")?
                        },
                        "/codex-proxy",
                    )?)?;
                    let base = format!("/{}", path.trim_matches('/'));
                    let handler = create(p, o)?;
                    for suffix in [
                        "/:providerId/:sessionId/:role/responses",
                        "/:providerId/responses",
                    ] {
                        call(
                            app,
                            c"post",
                            &[text(p, &format!("{base}{suffix}"))?, handler],
                        )?;
                    }
                    flag(p, true)
                })?,
            ),
            (
                "readCodexOfficialCredential",
                function(p, "readCodexOfficialCredential", 0, 1, |p, a| {
                    credential(p, a[0])
                })?,
            ),
        ],
    )?
    .raw())
}
