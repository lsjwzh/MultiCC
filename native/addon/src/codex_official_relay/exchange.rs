//! One credential selection and at most one schema repair per request. The
//! injected Web Stream reader is drained and cancelled on its owning runtime.
use super::*;
fn closed(s: L<'_>) -> Result<bool> {
    s.get(c"closed")?.truthy()
}
fn end_error(s: L<'_>, code: &str) -> Result<()> {
    observation::terminal(s, null(s)?, Some(text(s, code)?))
}
fn with_history<'a>(s: L<'a>, v: L<'a>) -> Result<L<'a>> {
    let prev = s.get(c"previous")?;
    if prev.truthy()? {
        v.set(c"previousError", prev)?;
        v.set(c"historyRepairs", s.get(c"repairs")?)?;
    }
    Ok(v)
}
fn public<'a>(s: L<'a>, v: L<'a>) -> Result<L<'a>> {
    call(
        api(s, c"errors")?,
        c"publicUpstreamError",
        &[v, s.get(c"errorOptions")?],
    )
}
fn transport<'a>(s: L<'a>, v: L<'a>, message: &str) -> Result<L<'a>> {
    let opts = crate::js_live::spread(s.get(c"errorOptions")?)?;
    opts.set(c"fallback", text(s, message)?)?;
    call(api(s, c"errors")?, c"publicTransportError", &[v, opts])
}
pub(super) fn begin<'a>(s: L<'a>, cred: L<'a>) -> Result<L<'a>> {
    let id = s.get(c"providerId")?;
    let o = s.get(c"options")?;
    let res = s.get(c"res")?;
    if !cred.truthy()? || !cred.get(c"ok")?.truthy()? {
        let account = crate::codex_homes::official_account_id(s.get(c"provider")?)?.truthy()?;
        let reason = fallback(cred.optional(c"reason")?, "credential_unavailable".into())?;
        diag(
            o,
            "codex_official_credential_unavailable",
            fields(
                s,
                &[
                    ("providerId", id),
                    (
                        "credentialSource",
                        text(
                            s,
                            if account {
                                "official-account"
                            } else {
                                "global"
                            },
                        )?,
                    ),
                    ("reason", reason),
                ],
            )?,
        )?;
        end_error(s, "OAUTH_CREDENTIAL_UNAVAILABLE")?;
        let message = if account {
            "Codex 官方账号凭证不可用，请在供应商的“重新登录”终端完成授权；该账号使用独立登录，不读取本机默认登录。"
        } else {
            "Codex 本机官方登录凭证不可用，请完成默认 Codex 登录。仅 login status 显示已登录不足以确认 auth.json 含有有效凭证。"
        };
        return json(
            res,
            num(s, 503.)?,
            fields(
                s,
                &[
                    ("error", text(s, message)?),
                    ("code", text(s, "CODEX_OFFICIAL_OAUTH_UNAVAILABLE")?),
                    ("reason", reason),
                ],
            )?,
        );
    }
    let secrets = arr(s)?;
    call(
        secrets,
        c"push",
        &[cred.get(c"accessToken")?, cred.get(c"accountId")?],
    )?;
    s.set(c"credential", cred)?;
    s.set(c"errorOptions", fields(s, &[("secrets", secrets)])?)?;
    let ac = s.global()?.get(c"AbortController")?.construct(&[])?;
    s.set(c"controller", ac)?;
    let close = function(s, "close", 0, 0, |s, _| {
        if !s.get(c"res")?.get(c"writableEnded")?.truthy()? {
            s.set(c"closed", flag(s, true)?)?;
            call(s.get(c"controller")?, c"abort", &[])?;
            end_error(s, "CLIENT_ABORTED")?;
        }
        und(s)
    })?;
    let req = s.get(c"req")?;
    if func(req.get(c"once")?)? {
        call(req, c"once", &[text(s, "aborted")?, close])?;
    }
    if func(res.get(c"once")?)? {
        call(res, c"once", &[text(s, "close")?, close])?;
    }
    let body = crate::js_live::spread(s.get(c"input")?)?;
    body.set(c"store", flag(s, false)?)?;
    body.set(c"stream", s.get(c"streaming")?)?;
    s.set(c"body", body)?;
    let task = async_result(s, || dial(s, false))?;
    let ok = function(s, "afterDial", 0, 0, |s, _| {
        if closed(s)? {
            return und(s);
        }
        let up = s.get(c"upstream")?;
        if up.get(c"ok")?.truthy()? && up.get(c"body")?.truthy()? {
            success(s)
        } else {
            rejected(s)
        }
    })?;
    let fail = function(s, "connectFailed", 1, 1, |s, a| {
        if closed(s)? {
            return und(s);
        }
        let detail = transport(s, a[0], "Codex Official OAuth upstream is unreachable")?;
        diag(
            s.get(c"options")?,
            "codex_official_upstream_connect_failed",
            fields(
                s,
                &[
                    ("providerId", s.get(c"providerId")?),
                    ("error", detail),
                    (
                        "networkMode",
                        fallback(a[0].get(c"multiccProxyMode")?, V::Null)?,
                    ),
                ],
            )?,
        )?;
        end_error(s, "UPSTREAM_CONNECT_FAILED")?;
        json(
            s.get(c"res")?,
            num(s, 502.)?,
            with_history(
                s,
                fields(
                    s,
                    &[
                        ("error", detail),
                        (
                            "code",
                            text(s, "CODEX_OFFICIAL_OAUTH_UPSTREAM_UNREACHABLE")?,
                        ),
                    ],
                )?,
            )?,
        )
    })?;
    call(task, c"then", &[ok, fail])
}
fn dial(s: L<'_>, retry: bool) -> Result<L<'_>> {
    if closed(s)? {
        return und(s);
    }
    let h = s.get(c"handler")?;
    let opts = fields(
        s,
        &[
            ("method", text(s, "POST")?),
            ("headers", headers::request(s)?),
            (
                "body",
                call(s.global()?.get(c"JSON")?, c"stringify", &[s.get(c"body")?])?,
            ),
            ("signal", s.get(c"controller")?.get(c"signal")?),
        ],
    )?;
    let task = async_result(s, || plain(h, c"fetch", &[h.get(c"upstream")?, opts]))?;
    call(
        task,
        c"then",
        &[function(s, "upstreamResponse", 1, 1, move |s, a| {
            let up = a[0];
            s.set(c"upstream", up)?;
            if up.get(c"ok")?.truthy()? && up.get(c"body")?.truthy()? {
                return und(s);
            }
            let opts = fields(s, &[("signal", s.get(c"controller")?.get(c"signal")?)])?;
            let read = async_result(s, || {
                call(api(s, c"errors")?, c"readUpstreamError", &[up, opts])
            })?;
            call(
                read,
                c"then",
                &[function(s, "diagnosed", 1, 1, move |s, a| {
                    diagnosed(s, a[0], retry)
                })?],
            )
        })?],
    )
}
fn diagnosed<'a>(s: L<'a>, problem: L<'a>, retry: bool) -> Result<L<'a>> {
    if closed(s)? {
        return und(s);
    }
    let up = s.get(c"upstream")?;
    let data = crate::js_live::spread(problem)?;
    let id = headers::value(up, "x-request-id")?;
    if id.truthy()? {
        data.set(c"requestId", headers::value(up, "x-request-id")?)?;
    }
    let safe = public(s, data)?;
    s.set(c"upstreamError", safe)?;
    let status = up.get(c"status")?;
    let missing = status.is_number(404.)?;
    let structured = problem.truthy()?
        && (problem.get(c"type")?.truthy()?
            || problem.get(c"code")?.truthy()?
            || problem.get(c"param")?.truthy()?);
    let repair = if !retry && (status.is_number(400.)? || (missing && structured)) {
        call(
            api(s, c"history")?,
            c"repairRejectedResponsesHistory",
            &[s.get(c"body")?, problem],
        )?
    } else {
        null(s)?
    };
    if !repair.truthy()? {
        let skip = if retry {
            "attempt_limit"
        } else if missing && !structured {
            "unstructured_404"
        } else if missing || status.is_number(400.)? {
            "converter_declined"
        } else {
            "status_not_repairable"
        };
        s.set(c"repairSkip", text(s, skip)?)?;
        return und(s);
    }
    let changes = repair.get(c"changes")?;
    s.set(c"previous", safe)?;
    s.set(c"repairs", changes)?;
    s.set(c"body", repair.get(c"body")?)?;
    diag(
        s.get(c"options")?,
        "model_history_repaired_after_rejection",
        fields(
            s,
            &[
                ("providerId", s.get(c"providerId")?),
                ("status", status),
                ("error", safe),
                ("changes", changes),
            ],
        )?,
    )?;
    dial(s, true)
}
fn rejected(s: L<'_>) -> Result<L<'_>> {
    let up = s.get(c"upstream")?;
    let raw_status = up.get(c"status")?;
    let ok = up.get(c"ok")?.truthy()?;
    let status = if ok {
        num(s, 502.)?
    } else {
        fallback(raw_status, V::Number(502.))?
    };
    s.set(c"statusCode", status)?;
    let err = if ok {
        fields(
            s,
            &[(
                "message",
                text(
                    s,
                    &format!(
                        "Upstream returned HTTP {} without a response body",
                        word(raw_status)?
                    ),
                )?,
            )],
        )?
    } else {
        s.get(c"upstreamError")?
    };
    let upstream_status = fallback(raw_status, V::Null)?;
    diag(
        s.get(c"options")?,
        "codex_official_upstream_rejected",
        fields(
            s,
            &[
                ("providerId", s.get(c"providerId")?),
                ("status", status),
                ("error", err),
                ("upstreamStatus", upstream_status),
                ("repairSkipped", fallback(s.get(c"repairSkip")?, V::Null)?),
            ],
        )?,
    )?;
    end_error(s, "UPSTREAM_HTTP_ERROR")?;
    let res = s.get(c"res")?;
    for name in ["x-request-id", "retry-after"] {
        let v = headers::value(up, name)?;
        if v.truthy()? {
            let safe = public(s, fields(s, &[("message", v)])?)?;
            call(res, c"setHeader", &[text(s, name)?, safe.get(c"message")?])?;
        }
    }
    json(
        res,
        status,
        with_history(
            s,
            fields(
                s,
                &[
                    ("error", err),
                    ("code", text(s, "CODEX_OFFICIAL_OAUTH_UPSTREAM_REJECTED")?),
                    ("upstreamStatus", upstream_status),
                ],
            )?,
        )?,
    )
}
fn success(s: L<'_>) -> Result<L<'_>> {
    let up = s.get(c"upstream")?;
    s.set(c"statusCode", up.get(c"status")?)?;
    headers::response(s)?;
    let content = word(s_or(headers::value(up, "content-type")?, "")?)?;
    observation::init(
        s,
        content.to_ascii_lowercase().contains("text/event-stream"),
    )?;
    let reader = call(up.get(c"body")?, c"getReader", &[])?;
    s.set(c"reader", reader)?;
    let is_open = function(s, "isOpen", 0, 0, |s, _| flag(s, !closed(s)?))?;
    let chunk = function(s, "writeChunk", 1, 1, |s, a| {
        observation::chunk(s, a[0])?;
        und(s)
    })?;
    let task = async_result(s, || api(s, c"pump")?.call_plain(&[reader, is_open, chunk]))?;
    let ok = function(s, "complete", 0, 0, |s, _| {
        if !closed(s)? {
            observation::finish(s)?;
        }
        und(s)
    })?;
    let failed = function(s, "streamFailed", 1, 1, |s, a| {
        if !closed(s)? {
            let res = s.get(c"res")?;
            if s.get(c"streaming")?.truthy()? && !res.get(c"writableEnded")?.truthy()? {
                s.catch(|| {
                    let detail = transport(s, a[0], "Codex Official OAuth stream failed")?;
                    let event = fields(
                        s,
                        &[
                            ("type", text(s, "response.failed")?),
                            (
                                "response",
                                fields(s, &[("status", text(s, "failed")?), ("error", detail)])?,
                            ),
                        ],
                    )?;
                    let body = call(s.global()?.get(c"JSON")?, c"stringify", &[event])?;
                    call(
                        res,
                        c"write",
                        &[text(
                            s,
                            &format!("event: response.failed\ndata: {}\n\n", word(body)?),
                        )?],
                    )
                })?;
            }
            end_error(s, "UPSTREAM_STREAM_FAILED")?;
        }
        und(s)
    })?;
    let settled = call(call(task, c"then", &[ok])?, c"catch", &[failed])?;
    let finish = function(s, "closeReader", 0, 0, |s, _| {
        let cancelled = async_result(s, || call(s.get(c"reader")?, c"cancel", &[]))?;
        let end = function(s, "finishResponse", 0, 0, |s, _| {
            let res = s.get(c"res")?;
            if !res.get(c"writableEnded")?.truthy()? {
                call(res, c"end", &[])?;
            }
            und(s)
        })?;
        call(cancelled, c"then", &[end, end])
    })?;
    call(settled, c"finally", &[finish])
}
