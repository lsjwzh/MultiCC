//! One stable loopback endpoint per SDK lane. Rust owns binding, authentication,
//! request lifetime and drain policy. Real Node HTTP streams retain backpressure.
use crate::{host_api::*, js_iteration::read};
use multicc_core::js::JsString;
use napi_derive::napi;

fn route(env: L<'_>) -> Result<L<'_>> {
    Ok(env
        .catch(|| {
            let url = env
                .global()?
                .get(c"URL")?
                .construct(&[read(env, c"ANTHROPIC_BASE_URL")?])?;
            if !url.get(c"protocol")?.is_string("http:")?
                || !url.get(c"hostname")?.is_string("127.0.0.1")?
            {
                return null(env);
            }
            for key in [c"username", c"password", c"search", c"hash"] {
                if url.get(key)?.truthy()? {
                    return null(env);
                }
            }
            let path = fold_string(url.get(c"pathname")?)?;
            let path = path.strip_suffix('/').unwrap_or(&path);
            let mut parts = path.split('/');
            if parts.next() != Some("")
                || parts.next() != Some("claude-proxy")
                || parts.next().is_none_or(str::is_empty)
                || parts.next().is_none_or(str::is_empty)
                || parts.next().is_some()
            {
                return null(env);
            }
            url.assign(c"pathname", text(env, path)?)?;
            let token = fallback(read(env, c"ANTHROPIC_AUTH_TOKEN")?, "".into())?;
            let (provider, _) = path.rsplit_once('/').expect("matched provider and session");
            let identity = call(url.get(c"origin")?, c"concat", &[text(env, provider)?])?;
            fields(
                env,
                &[("url", url), ("token", token), ("identity", identity)],
            )
        })?
        .unwrap_or(null(env)?))
}
fn headers(headers: L<'_>) -> Result<L<'_>> {
    let copy = spread(headers)?;
    let connection = string(fallback(copy.get(c"connection")?, "".into())?)?.coerce_string()?;
    let reflect = copy.global()?.get(c"Reflect")?;
    for piece in connection.as_units().split(|u| *u == 44) {
        let key = JsString::from_units(piece.to_vec()).trim().to_lowercase();
        call(
            reflect,
            c"deleteProperty",
            &[copy, copy.from_value(&V::String(key))?],
        )?;
    }
    for key in [
        c"connection",
        c"keep-alive",
        c"proxy-authenticate",
        c"proxy-authorization",
        c"te",
        c"trailer",
        c"transfer-encoding",
        c"upgrade",
        c"host",
    ] {
        copy.delete(key)?;
    }
    Ok(copy)
}
fn reply<'a>(res: L<'a>, status: u16, hello: bool) -> Result<L<'a>> {
    let status = num(res, status.into())?;
    if hello {
        call(
            res,
            c"writeHead",
            &[
                status,
                fields(res, &[("content-type", text(res, "application/json")?)])?,
            ],
        )?;
        call(res, c"end", &[text(res, "{}")?])
    } else {
        call(res, c"writeHead", &[status])?;
        call(res, c"end", &[])
    }
}
fn warn<'a>(state: L<'a>, method: L<'a>, url: L<'a>) -> Result<()> {
    let mut line = method.coerce_string()?;
    line.push_str(" ");
    line.push(&url.coerce_string()?);
    let input = state.from_value(&V::String(line.clone()))?;
    let logger = state.get(c"logger")?;
    let reported = state.get(c"reported")?;
    if !logger.optional(c"warn")?.truthy()?
        || call(reported, c"has", &[input])?.truthy()?
        || reported.get(c"size")?.number()? >= 32.
    {
        return Ok(());
    }
    call(reported, c"add", &[input])?;
    call(
        logger,
        c"warn",
        &[
            text(state, "[sdk-relay] forwarding non-Messages request:")?,
            state.from_value(&V::String(line.truncate_units(200)))?,
        ],
    )?;
    Ok(())
}
fn busy<'a>(p: L<'a>, message: &str) -> Result<L<'a>> {
    let error = error_value(p, message)?;
    error.set(c"code", text(p, "SDK_ROUTE_BUSY")?)?;
    Ok(error)
}
fn destroy<'a>(target: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    call(target, c"destroy", &[])
}
fn forward_response<'a>(res: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let response = a[0];
    call(
        res,
        c"writeHead",
        &[
            read(response, c"statusCode")?,
            headers(read(response, c"headers")?)?,
        ],
    )?;
    call(
        response,
        c"on",
        &[text(res, "error")?, function(res, "", 0, 0, destroy)?],
    )?;
    call(response, c"pipe", &[res])
}
fn finished<'a>(entry: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let state = entry.get(c"state")?;
    call(entry.get(c"upstream")?, c"destroy", &[])?;
    let active = state.get(c"active")?;
    call(active, c"delete", &[entry])?;
    if !active.get(c"size")?.truthy()? {
        let ready = call(
            state.global()?.get(c"Array")?,
            c"from",
            &[state.get(c"waiters")?],
        )?;
        ready.for_each(|done| {
            done.call_plain(&[])?;
            Ok(())
        })?;
    }
    undef(entry)
}
fn handle<'a>(state: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    let req = a[0];
    let res = a[1];
    let host = state.get(c"host")?;
    let given = string(fallback(
        read(read(req, c"headers")?, c"authorization")?,
        "".into(),
    )?)?;
    let bytes = call(state.global()?.get(c"Buffer")?, c"from", &[given])?;
    let expected = state.get(c"expected")?;
    if !bytes.get(c"length")?.equals(expected.get(c"length")?)?
        || !call(host.get(c"crypto")?, c"timingSafeEqual", &[bytes, expected])?.truthy()?
    {
        return reply(res, 401, false);
    }
    let raw_url = read(req, c"url")?;
    let uri = fold_string(raw_url)?;
    if uri == "/api/hello" || uri == "/api/hello/" {
        return reply(res, 200, true);
    }
    let path = uri.split('?').next().unwrap_or("");
    if !path.starts_with('/') || path.starts_with("//") || path.split('/').any(|part| part == "..")
    {
        return reply(res, 400, false);
    }
    let target = state.get(c"target")?;
    if state.get(c"closed")?.truthy()? || !target.truthy()? {
        return reply(res, 503, false);
    }
    let url = target.get(c"url")?;
    let base = fold_string(url.get(c"pathname")?)?;
    let origin = fold_string(url.get(c"origin")?)?;
    let upstream_url = text(state, &format!("{origin}{base}{uri}"))?;
    // http.request parses the combined URL. Check that actual parsed path
    // before passing the bound authorization to the local provider endpoint.
    let parsed = state.global()?.get(c"URL")?.construct(&[upstream_url])?;
    if !fold_string(parsed.get(c"pathname")?)?.starts_with(&format!("{base}/"))
        || !parsed.get(c"origin")?.is_string(&origin)?
    {
        return reply(res, 400, false);
    }
    let messages =
        matches!(path, "/v1/messages" | "/v1/messages/count_tokens") && !uri.contains('#');
    if !messages {
        warn(state, read(req, c"method")?, raw_url)?
    }
    let outbound = headers(read(req, c"headers")?)?;
    outbound.delete(c"x-api-key")?;
    outbound.set(
        c"authorization",
        call(text(state, "Bearer ")?, c"concat", &[target.get(c"token")?])?,
    )?;
    let options = fields(
        state,
        &[("method", read(req, c"method")?), ("headers", outbound)],
    )?;
    let upstream = call(
        host.get(c"http")?,
        c"request",
        &[
            upstream_url,
            options,
            function(res, "", 1, 1, forward_response)?,
        ],
    )?;
    let entry = fields(
        state,
        &[("state", state), ("upstream", upstream), ("res", res)],
    )?;
    call(state.get(c"active")?, c"add", &[entry])?;
    call(
        res,
        c"once",
        &[
            text(state, "close")?,
            function(entry, "finish", 0, 0, finished)?,
        ],
    )?;
    for event in ["aborted", "error"] {
        call(
            req,
            c"once",
            &[text(state, event)?, function(res, "", 0, 0, destroy)?],
        )?;
    }
    let on_error = function(res, "", 0, 0, |res, _| {
        if !res.get(c"headersSent")?.truthy()? {
            call(res, c"writeHead", &[num(res, 502.)?])?;
        }
        call(res, c"end", &[])
    })?;
    call(upstream, c"once", &[text(state, "error")?, on_error])?;
    call(req, c"pipe", &[upstream])
}
fn bind<'a>(state: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if state.get(c"closed")?.truthy()? || state.get(c"active")?.get(c"size")?.truthy()? {
        return Err(busy(state, "SDK route is not idle")?.throw_error());
    }
    let next = route(default_object(a[0])?)?;
    if !next.truthy()? || !next.get(c"token")?.truthy()? {
        return Err(error_value(state, "Invalid managed SDK route")?.throw_error());
    }
    state.set(c"target", next)?;
    undef(state)
}
fn abort<'a>(state: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    state.get(c"active")?.for_each(|entry| {
        call(entry.get(c"upstream")?, c"destroy", &[])?;
        call(entry.get(c"res")?, c"destroy", &[])?;
        Ok(())
    })?;
    undef(state)
}
fn drain<'a>(state: L<'a>, a: &mut [L<'a>]) -> Result<L<'a>> {
    if !state.get(c"active")?.get(c"size")?.truthy()? {
        return resolved(undef(state)?);
    }
    let timeout = with_default(a[0], num(state, 5000.)?)?;
    let waiter = fields(
        state,
        &[("waiters", state.get(c"waiters")?), ("timeout", timeout)],
    )?;
    let executor = function(waiter, "", 2, 2, |w, a| {
        w.set(c"resolve", a[0])?;
        w.set(c"reject", a[1])?;
        let finish = function(w, "finish", 0, 0, |w, _| {
            w.global()?
                .get(c"clearTimeout")?
                .call_plain(&[w.get(c"timer")?])?;
            call(w.get(c"waiters")?, c"delete", &[w.get(c"finish")?])?;
            w.get(c"resolve")?.call_plain(&[])
        })?;
        w.set(c"finish", finish)?;
        let expired = function(w, "", 0, 0, |w, _| {
            call(w.get(c"waiters")?, c"delete", &[w.get(c"finish")?])?;
            w.get(c"reject")?
                .call_plain(&[busy(w, "SDK route still has active requests")?])
        })?;
        let timer = w
            .global()?
            .get(c"setTimeout")?
            .call_plain(&[expired, w.get(c"timeout")?])?;
        w.set(c"timer", timer)?;
        call(w.get(c"waiters")?, c"add", &[finish])
    })?;
    state.global()?.get(c"Promise")?.construct(&[executor])
}
fn close<'a>(state: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(state, || {
        if state.get(c"closed")?.truthy()? {
            return undef(state);
        }
        state.set(c"closed", flag(state, true)?)?;
        state.set(c"target", null(state)?)?;
        call(args[0], c"abort", &[])?;
        let executor = function(state, "", 1, 1, |s, a| {
            call(s.get(c"server")?, c"close", &[a[0]])
        })?;
        state.global()?.get(c"Promise")?.construct(&[executor])
    })
}
fn ready<'a>(state: L<'a>, _: &mut [L<'a>]) -> Result<L<'a>> {
    let server = state.get(c"server")?;
    call(server, c"unref", &[])?;
    let port = read(call(server, c"address", &[])?, c"port")?;
    let base = call(text(state, "http://127.0.0.1:")?, c"concat", &[port])?;
    let env = fields(
        state,
        &[
            ("ANTHROPIC_BASE_URL", base),
            ("ANTHROPIC_AUTH_TOKEN", state.get(c"token")?),
            ("ANTHROPIC_API_KEY", text(state, "")?),
        ],
    )?;
    let wrapper = state.get(c"host")?.get(c"closeMethod")?;
    fields(
        state,
        &[
            ("env", env),
            ("bind", function(state, "bind", 1, 1, bind)?),
            ("drain", function(state, "drain", 0, 1, drain)?),
            ("abort", function(state, "abort", 0, 0, abort)?),
            (
                "close",
                wrapper.call_plain(&[function(state, "close", 1, 1, close)?])?,
            ),
        ],
    )
}
fn create<'a>(host: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    async_result(host, || {
        let opts = default_object(args[0])?;
        let logger = read(opts, c"logger")?;
        let logger = if logger.undefined()? {
            host.global()?.get(c"console")?
        } else {
            logger
        };
        let token = call(
            call(host.get(c"crypto")?, c"randomBytes", &[num(host, 32.)?])?,
            c"toString",
            &[text(host, "hex")?],
        )?;
        let expected = call(
            host.global()?.get(c"Buffer")?,
            c"from",
            &[call(text(host, "Bearer ")?, c"concat", &[token])?],
        )?;
        let set = host.global()?.get(c"Set")?;
        let state = fields(
            host,
            &[
                ("host", host),
                ("logger", logger),
                ("token", token),
                ("expected", expected),
                ("target", null(host)?),
                ("closed", flag(host, false)?),
                ("active", set.construct(&[])?),
                ("waiters", set.construct(&[])?),
                ("reported", set.construct(&[])?),
            ],
        )?;
        let server = call(
            host.get(c"http")?,
            c"createServer",
            &[function(state, "", 2, 2, handle)?],
        )?;
        state.set(c"server", server)?;
        let executor = function(state, "", 2, 2, |s, a| {
            let server = s.get(c"server")?;
            call(server, c"once", &[text(s, "error")?, a[1]])?;
            call(
                server,
                c"listen",
                &[num(s, 0.)?, text(s, "127.0.0.1")?, a[0]],
            )
        })?;
        let listening = host.global()?.get(c"Promise")?.construct(&[executor])?;
        then(listening, state, ready)
    })
}
#[napi]
pub fn claude_sdk_route_api(env: Env, host: Unknown<'_>) -> Result<sys::napi_value> {
    let host = L::new(&env, host);
    Ok(defaulted_methods(
        host,
        &[
            ("managedRoute", 0, 1, |_, a| route(default_object(a[0])?)),
            ("createRouteRelay", 0, 1, create),
        ],
    )?
    .raw())
}
