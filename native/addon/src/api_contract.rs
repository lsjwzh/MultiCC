//! API projections over borrowed V8 values. Rust owns validation and assembly;
//! V8 supplies property reads, ECMAScript string/array primitives and Date.
use crate::{host_methods::method, js_iteration::read, js_live::invoke, route_response::*};
use napi_derive::napi;
use std::ffi::CStr;

fn default_object(value: L<'_>) -> Result<L<'_>> {
    if value.undefined()? {
        fields(value, &[])
    } else {
        Ok(value)
    }
}
fn default_text<'a>(value: L<'a>, default: &str) -> Result<L<'a>> {
    if value.undefined()? {
        text(value, default)
    } else {
        Ok(value)
    }
}
fn valid(state: L<'_>, value: L<'_>, pattern: &CStr) -> Result<bool> {
    Ok(value.kind()? == sys::ValueType::napi_string
        && call(state.get(pattern)?, c"test", &[value])?.truthy()?)
}
fn safe_id<'a>(state: L<'a>, value: L<'a>, fallback: L<'a>) -> Result<L<'a>> {
    if valid(state, value, c"idPattern")? {
        Ok(value)
    } else {
        Ok(fallback)
    }
}
fn context_id<'a>(req: L<'a>, res: L<'a>, key: &CStr, req_key: &CStr) -> Result<L<'a>> {
    let local = if !res.truthy()? {
        res
    } else {
        let locals = read(res, c"locals")?;
        if !locals.truthy()? {
            locals
        } else {
            read(read(res, c"locals")?, key)?
        }
    };
    if local.truthy()? {
        Ok(local)
    } else if req.truthy()? {
        read(req, req_key)
    } else {
        Ok(req)
    }
}
fn with_meta<'a>(state: L<'a>, payload: L<'a>, context: L<'a>) -> Result<L<'a>> {
    let id = safe_id(state, read(context, c"requestId")?, text(state, "unknown")?)?;
    let out = fields(state, &[])?;
    if payload.truthy()? && payload.kind()? == sys::ValueType::napi_object {
        out.spread_from(payload)?;
    } else {
        out.define_key(text(state, "data")?, payload)?;
    }
    for (key, value) in [
        ("apiVersion", text(state, "v1")?),
        ("requestId", id),
        (
            "correlationId",
            safe_id(state, read(context, c"correlationId")?, id)?,
        ),
    ] {
        out.define_key(text(state, key)?, value)?;
    }
    Ok(out)
}
fn sanitize<'a>(state: L<'a>, value: L<'a>, fallback: L<'a>) -> Result<L<'a>> {
    let mut value =
        if value.kind()? == sys::ValueType::napi_string && call(value, c"trim", &[])?.truthy()? {
            call(value, c"trim", &[])?
        } else {
            fallback
        };
    let patterns = state.get(c"patterns")?;
    let regexp = state.global()?.get(c"RegExp")?;
    let replacements = [
        "Bearer [redacted]",
        "[redacted]",
        "fleet_share_[redacted]",
        "$1=[redacted]",
        "$1[redacted]",
        "[path]",
        "[path]",
    ];
    for (i, replacement) in replacements.iter().enumerate() {
        value = invoke(
            value,
            read(value, c"replace")?,
            &[
                regexp.construct(&[patterns.element(i as u32)?])?,
                text(state, replacement)?,
            ],
            &format!("message{}.replace", ".replace(...)".repeat(i)),
        )?;
    }
    invoke(
        value,
        read(value, c"slice")?,
        &[num(state, 0.0)?, num(state, 240.0)?],
        "message.slice",
    )
}
fn error_dto<'a>(state: L<'a>, source: L<'a>) -> Result<L<'a>> {
    if source.nullish()? {
        return Err(source.type_error("Cannot destructure property 'message' of '(intermediate value)(intermediate value)(intermediate value)' as it is null."));
    }
    // Destructuring eagerly reads every input field before any projection.
    let keys = [
        c"message",
        c"code",
        c"requestId",
        c"correlationId",
        c"upstreamRequestId",
        c"category",
        c"detail",
        c"retryable",
        c"action",
        c"scope",
        c"cause",
        c"httpStatus",
        c"occurredAt",
    ];
    let values = keys
        .iter()
        .map(|key| read(source, key))
        .collect::<Result<Vec<_>>>()?;
    let [message, code, request, correlation, upstream, category, detail, retryable, action, scope, cause, status, occurred] =
        values.as_slice()
    else {
        unreachable!()
    };
    let error = sanitize(state, *message, text(state, "request_error")?)?;
    let out = fields(
        state,
        &[
            ("ok", flag(state, false)?),
            ("error", error),
            (
                "code",
                if valid(state, *code, c"codePattern")? {
                    *code
                } else {
                    text(state, "request_error")?
                },
            ),
        ],
    )?;
    // The four optional validations precede the detail/retryable projections.
    let codes = [*category, *action, *scope, *cause].map(|v| valid(state, v, c"optionalPattern"));
    let [category_ok, action_ok, scope_ok, cause_ok] = codes;
    let (category_ok, action_ok, scope_ok, cause_ok) =
        (category_ok?, action_ok?, scope_ok?, cause_ok?);
    if category_ok {
        out.assign(c"category", *category)?;
    }
    if detail.kind()? == sys::ValueType::napi_string && call(*detail, c"trim", &[])?.truthy()? {
        out.assign(c"detail", sanitize(state, *detail, error)?)?;
    }
    if retryable.kind()? == sys::ValueType::napi_boolean {
        out.assign(c"retryable", *retryable)?;
    }
    for (key, value, ok) in [
        (c"action", *action, action_ok),
        (c"scope", *scope, scope_ok),
        (c"cause", *cause, cause_ok),
    ] {
        if ok {
            out.assign(key, value)?;
        }
    }
    if valid(state, *upstream, c"idPattern")? {
        out.assign(c"upstreamRequestId", *upstream)?;
    }
    if call(state.global()?.get(c"Number")?, c"isInteger", &[*status])?.truthy()?
        && status.number()? >= 400.0
        && status.number()? <= 599.0
    {
        out.assign(c"httpStatus", *status)?;
    }
    if occurred.kind()? == sys::ValueType::napi_string {
        let date = state.global()?.get(c"Date")?;
        if call(
            state.global()?.get(c"Number")?,
            c"isFinite",
            &[call(date, c"parse", &[*occurred])?],
        )?
        .truthy()?
        {
            out.assign(
                c"occurredAt",
                call(date.construct(&[*occurred])?, c"toISOString", &[])?,
            )?;
        }
    }
    with_meta(
        state,
        out,
        fields(
            state,
            &[("requestId", *request), ("correlationId", *correlation)],
        )?,
    )
}
fn slice(value: L<'_>, limit: f64) -> Result<L<'_>> {
    call(value, c"slice", &[num(value, 0.0)?, num(value, limit)?])
}
fn string_field<'a>(source: L<'a>, key: &CStr, limit: f64) -> Result<L<'a>> {
    if read(source, key)?.kind()? == sys::ValueType::napi_string {
        slice(read(source, key)?, limit)
    } else {
        null(source)
    }
}
fn checked<'a>(state: L<'a>, dto: L<'a>, required: Option<(&CStr, &str)>) -> Result<L<'a>> {
    if let Some((second, message)) = required {
        if !dto.get(c"id")?.truthy()? || !dto.get(second)?.truthy()? {
            return Err(state.type_error(message));
        }
    }
    crate::session_dto::assert_safe(state, dto, text(state, "$")?)
}
fn provider<'a>(state: L<'a>, source: L<'a>) -> Result<L<'a>> {
    let codex = read(source, c"appType")?.equals(text(state, "codex")?)?;
    let protocol = text(
        state,
        if codex {
            "openai_responses"
        } else {
            "anthropic"
        },
    )?;
    let out = fields(
        state,
        &[
            ("id", string(fallback(read(source, c"id")?, "".into())?)?),
            (
                "appType",
                text(state, if codex { "codex" } else { "claude" })?,
            ),
            ("protocol", protocol),
            ("apiFormat", protocol),
        ],
    )?;
    let wire = read(source, c"wireApi")?;
    let wire =
        if wire.equals(text(state, "messages")?)? || wire.equals(text(state, "responses")?)? {
            read(source, c"wireApi")?
        } else {
            null(state)?
        };
    out.assign(c"wireApi", wire)?;
    out.assign(
        c"name",
        slice(string(fallback(read(source, c"name")?, "".into())?)?, 160.0)?,
    )?;
    out.assign(
        c"source",
        text(
            state,
            if read(source, c"source")?.equals(text(state, "ccswitch")?)? {
                "ccswitch"
            } else {
                "local"
            },
        )?,
    )?;
    let model = if read(source, c"model")?.kind()? == sys::ValueType::napi_string
        && read(source, c"model")?.truthy()?
    {
        slice(read(source, c"model")?, 160.0)?
    } else {
        null(state)?
    };
    out.assign(c"model", model)?;
    let options = if read(source, c"modelOptions")?.is_array()? {
        let filtered = call(
            read(source, c"modelOptions")?,
            c"filter",
            &[state.get(c"isString")?],
        )?;
        let mapped = call(filtered, c"map", &[state.get(c"truncateModel")?])?;
        let set = state.global()?.get(c"Set")?.construct(&[mapped])?;
        let array = state.from_value(&V::Array(vec![]))?;
        let mut i = 0;
        set.for_each(|v| {
            array.define_key(text(state, &i.to_string())?, v)?;
            i += 1;
            Ok(())
        })?;
        slice(array, 100.0)?
    } else {
        state.from_value(&V::Array(vec![]))?
    };
    out.assign(c"modelOptions", options)?;
    out.assign(
        c"aliasOnly",
        flag(state, read(source, c"aliasOnly")?.truthy()?)?,
    )?;
    let clis = if read(source, c"compatibleClis")?.is_array()? {
        call(
            read(source, c"compatibleClis")?,
            c"filter",
            &[state.get(c"compatibleCli")?],
        )?
    } else {
        state.from_value(&V::Array(vec![]))?
    };
    out.assign(c"compatibleClis", clis)?;
    out.assign(
        c"hasCredentials",
        flag(state, read(source, c"hasToken")?.truthy()?)?,
    )?;
    out.assign(
        c"isOfficial",
        flag(state, read(source, c"isOfficial")?.truthy()?)?,
    )?;
    checked(
        state,
        out,
        Some((c"name", "provider DTO requires id and name")),
    )
}
fn number<'a>(source: L<'a>, key: &CStr) -> Result<L<'a>> {
    source
        .global()?
        .get(c"Number")?
        .call_plain(&[read(source, key)?])
}
fn wait<'a>(state: L<'a>, source: L<'a>) -> Result<L<'a>> {
    let out = fields(
        state,
        &[("id", string(fallback(read(source, c"id")?, "".into())?)?)],
    )?;
    let session = read(source, c"sessionId")?;
    let session = if session.truthy()? {
        session
    } else {
        read(source, c"session")?
    };
    out.assign(c"sessionId", string(fallback(session, "".into())?)?)?;
    let mode = read(source, c"mode")?;
    out.assign(
        c"mode",
        if mode.equals(text(state, "callback")?)? || mode.equals(text(state, "delay")?)? {
            read(source, c"mode")?
        } else {
            text(state, "poll")?
        },
    )?;
    let math = state.global()?.get(c"Math")?;
    for (key, min, floor) in [
        (c"checks", 0.0, true),
        (c"maxChecks", 1.0, true),
        (c"intervalSec", 1.0, false),
    ] {
        let value = if key != c"checks" && read(source, key)?.nullish()? {
            null(state)?
        } else {
            let converted = fallback(number(source, key)?, V::Number(min))?;
            let converted = if floor {
                call(math, c"floor", &[converted])?
            } else {
                converted
            };
            call(math, c"max", &[num(state, min)?, converted])?
        };
        out.assign(key, value)?;
    }
    let created = if call(
        state.global()?.get(c"Number")?,
        c"isFinite",
        &[number(source, c"createdAt")?],
    )?
    .truthy()?
    {
        call(
            state
                .global()?
                .get(c"Date")?
                .construct(&[number(source, c"createdAt")?])?,
            c"toISOString",
            &[],
        )?
    } else {
        null(state)?
    };
    out.assign(c"createdAt", created)?;
    checked(
        state,
        out,
        Some((c"sessionId", "wait DTO requires id and sessionId")),
    )
}

#[napi]
pub fn api_contract_api(env: Env, anchor: Unknown<'_>) -> Result<sys::napi_value> {
    let anchor = L::new(&env, anchor);
    let state = fields(anchor, &[])?;
    crate::session_dto::install_safety(&env, state)?;
    let regexp = anchor.global()?.get(c"RegExp")?;
    for (key, pattern) in [
        (c"idPattern", "^[A-Za-z0-9._:-]{1,128}$"),
        (c"codePattern", "^[a-z0-9_.-]{1,96}$"),
        (c"optionalPattern", "^[a-z0-9_.-]{1,64}$"),
    ] {
        state.set(
            key,
            regexp.construct(&[text(state, pattern)?, text(state, "i")?])?,
        )?;
    }
    let patterns = state.from_value(&V::Array(vec![]))?;
    for (i, (pattern, flags)) in [
        (r"\bBearer\s+[A-Za-z0-9._~+\/-]+=*", "gi"),
        (r"\b(?:sk|gh[pousr])[-_][A-Za-z0-9_-]{12,}\b", "g"),
        (r"\bfleet_share_[A-Za-z0-9_-]{24,96}\b", "g"),
        (r"\b(token|secret|password|passwd|authorization|api[_ -]?key|credential)\s*[:=]\s*([^\s,;]+)", "gi"),
        (r"([?&](?:token|access_token|auth_token|api_key|apikey|authorization)=)[^&#\s]*", "gi"),
        (r"[A-Za-z]:\\(?:[^\\\s]+\\){1,}[^\s]*", "g"),
        (r"(?:/[A-Za-z0-9._-]+){2,}", "g"),
    ].iter().enumerate() { patterns.set_element(i as u32, regexp.construct(&[text(state, pattern)?, text(state, flags)?])?)?; }
    state.set(c"patterns", patterns)?;
    state.set(
        c"isString",
        method(&env, state, "", 1, 1, |s, a| {
            flag(s, a[0].kind()? == sys::ValueType::napi_string)
        })?,
    )?;
    state.set(
        c"truncateModel",
        method(&env, state, "", 1, 1, |_, a| slice(a[0], 160.0))?,
    )?;
    state.set(
        c"compatibleCli",
        method(&env, state, "", 1, 1, |s, a| {
            let ok = a[0].string()?.is_some_and(|v| {
                [
                    "claude",
                    "claude-exp",
                    "codex",
                    "codex-exp",
                    "opencode",
                    "zcode",
                    "kimi",
                    "dsh",
                    "grok",
                ]
                .iter()
                .any(|cli| v == *cli)
            });
            flag(s, ok)
        })?,
    )?;
    let out = fields(state, &[("API_VERSION", text(state, "v1")?)])?;
    for (name, length, count, run) in [
        (
            "safeId",
            1,
            2,
            (|s, a: &mut [L<'_>]| safe_id(s, a[0], default_text(a[1], "unknown")?))
                as for<'a> fn(L<'a>, &mut [L<'a>]) -> Result<L<'a>>,
        ),
        ("requestContext", 2, 2, |s, a| {
            let id = safe_id(
                s,
                context_id(a[0], a[1], c"requestId", c"id")?,
                text(s, "unknown")?,
            )?;
            let corr = safe_id(
                s,
                context_id(a[0], a[1], c"correlationId", c"correlationId")?,
                id,
            )?;
            fields(s, &[("requestId", id), ("correlationId", corr)])
        }),
        ("withApiMeta", 1, 2, |s, a| {
            with_meta(s, a[0], default_object(a[1])?)
        }),
        ("sanitizeErrorMessage", 1, 2, |s, a| {
            sanitize(s, a[0], default_text(a[1], "request_error")?)
        }),
        ("createErrorDto", 0, 1, |s, a| {
            error_dto(s, default_object(a[0])?)
        }),
        ("toProviderDto", 0, 1, |s, a| {
            provider(s, default_object(a[0])?)
        }),
        ("toWaitDto", 0, 1, |s, a| wait(s, default_object(a[0])?)),
        ("toDispatchResultDto", 0, 1, |s, a| {
            checked(
                s,
                fields(
                    s,
                    &[
                        (
                            "ok",
                            flag(
                                s,
                                read(default_object(a[0])?, c"ok")?.equals(flag(s, true)?)?,
                            )?,
                        ),
                        (
                            "target",
                            string_field(default_object(a[0])?, c"target", 160.0)?,
                        ),
                        (
                            "chatId",
                            string_field(default_object(a[0])?, c"chatId", 160.0)?,
                        ),
                        ("note", string_field(default_object(a[0])?, c"note", 240.0)?),
                    ],
                )?,
                None,
            )
        }),
        ("createWsEnvelope", 0, 2, |s, a| {
            let payload = default_object(a[0])?;
            let context = default_object(a[1])?;
            if !payload.truthy()?
                || payload.kind()? != sys::ValueType::napi_object
                || read(payload, c"type")?.kind()? != sys::ValueType::napi_string
            {
                return Err(s.type_error("WebSocket envelope requires a string type"));
            }
            let out = fields(s, &[])?;
            out.spread_from(payload)?;
            out.define_key(text(s, "apiVersion")?, text(s, "v1")?)?;
            if read(context, c"requestId")?.truthy()? {
                out.assign(
                    c"requestId",
                    safe_id(s, read(context, c"requestId")?, text(s, "unknown")?)?,
                )?;
            }
            if read(context, c"correlationId")?.truthy()? {
                out.assign(
                    c"correlationId",
                    safe_id(
                        s,
                        read(context, c"correlationId")?,
                        fallback(out.get(c"requestId")?, "unknown".into())?,
                    )?,
                )?;
            }
            Ok(out)
        }),
    ] {
        out.set_key(
            text(state, name)?,
            method(&env, state, name, length, count, run)?,
        )?;
    }
    // Keep the CommonJS export key order, too.
    let exports = fields(state, &[])?;
    for name in [
        "API_VERSION",
        "createErrorDto",
        "createWsEnvelope",
        "requestContext",
        "safeId",
        "sanitizeErrorMessage",
        "toDispatchResultDto",
        "toProviderDto",
        "toWaitDto",
        "withApiMeta",
    ] {
        let key = text(state, name)?;
        exports.define_key(key, out.get_key(key)?)?;
    }
    Ok(exports.raw())
}
