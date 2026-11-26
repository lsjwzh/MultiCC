//! Trusted public errors for the memo and host-power routes. Domain brands,
//! V8 errors and causes stay live across the boundary, including getter throws.
use crate::route_response::{fields, flag, num, text, Env, Result, Unknown, L, V};
use napi::sys;
use napi_derive::napi;

const DOMAIN_DEFINITIONS: &[(&str, u16, &str, &str)] = &[
    ("bad_request", 400, "invalid_request", "request_error"),
    (
        "payload_too_large",
        413,
        "payload_too_large",
        "payload_too_large",
    ),
    ("not_found", 404, "not_found", "not_found"),
    ("conflict", 409, "conflict", "conflict"),
    ("rate_limited", 429, "rate_limited", "rate_limited"),
    ("internal", 500, "internal_error", "internal_error"),
];

#[napi]
pub fn domain_error_kinds(env: Env, anchor: Unknown<'_>) -> Result<sys::napi_value> {
    let anchor = L::new(&env, anchor);
    let kinds = fields(anchor, &[])?;
    for &(kind, ..) in DOMAIN_DEFINITIONS {
        kinds.define_key(
            text(anchor, &kind.to_ascii_uppercase())?,
            text(anchor, kind)?,
        )?;
    }
    Ok(kinds.freeze()?.raw())
}

#[napi]
pub fn domain_error_message(
    env: Env,
    message: Unknown<'_>,
    infrastructure: bool,
) -> Result<sys::napi_value> {
    let message = L::new(&env, message);
    if message.kind()? == sys::ValueType::napi_string {
        return Ok(message.raw());
    }
    let fallback = if infrastructure {
        "infrastructure operation failed"
    } else {
        "domain operation failed"
    };
    Ok(text(message, fallback)?.raw())
}

fn set_error_context<'a>(error: L<'a>, compatibility: L<'a>, cause: L<'a>) -> Result<()> {
    error.assign(c"compatibility", compatibility)?;
    if !cause.undefined()? {
        error.assign(c"cause", cause)?;
    }
    Ok(())
}

#[napi]
pub fn domain_error_initialize(
    env: Env,
    error: Unknown<'_>,
    kind: Unknown<'_>,
    code: Unknown<'_>,
    public_message: Unknown<'_>,
    compatibility: Unknown<'_>,
    cause: Unknown<'_>,
) -> Result<()> {
    let error = L::new(&env, error);
    error.assign(c"name", text(error, "DomainError")?)?;
    let kind = L::new(&env, kind);
    let kind = if kind.truthy()? {
        kind
    } else {
        text(error, "unknown")?
    };
    let kind = error.global()?.get(c"String")?.call_plain(&[kind])?;
    error.assign(c"kind", kind)?;
    error.assign(c"code", L::new(&env, code))?;
    let public_message = L::new(&env, public_message);
    let public_message = if public_message.undefined()? {
        error.get(c"message")?
    } else {
        public_message
    };
    error.assign(c"publicMessage", public_message)?;
    set_error_context(error, L::new(&env, compatibility), L::new(&env, cause))
}

#[napi]
pub fn infrastructure_error_initialize(
    env: Env,
    error: Unknown<'_>,
    code: Unknown<'_>,
    compatibility: Unknown<'_>,
    cause: Unknown<'_>,
) -> Result<()> {
    let error = L::new(&env, error);
    error.assign(c"name", text(error, "InfrastructureError")?)?;
    error.assign(c"code", L::new(&env, code))?;
    set_error_context(error, L::new(&env, compatibility), L::new(&env, cause))
}

#[napi]
pub fn http_error_trusted_status(env: Env, status: Unknown<'_>) -> Result<u32> {
    let n = L::new(&env, status).number_value()?.unwrap_or(500.0);
    Ok(if n.fract() == 0.0 && (400.0..=599.0).contains(&n) {
        n as u32
    } else {
        500
    })
}

#[napi]
pub fn http_error_message(
    env: Env,
    status: u32,
    message: Unknown<'_>,
    sanitize: Unknown<'_>,
) -> Result<sys::napi_value> {
    let message = L::new(&env, message);
    let public = if status >= 500 {
        text(message, "internal_error")?
    } else {
        L::new(&env, sanitize).call_plain(&[message, text(message, "request_error")?])?
    };
    Ok(public.raw())
}

#[napi]
pub fn http_error_initialize(
    env: Env,
    error: Unknown<'_>,
    status: u32,
    code: Unknown<'_>,
    compatibility: Unknown<'_>,
    cause: Unknown<'_>,
    ports: Unknown<'_>,
) -> Result<()> {
    let error = L::new(&env, error);
    let ports = L::new(&env, ports);
    error.assign(c"name", text(error, "HttpError")?)?;
    error.assign(c"status", num(error, status.into())?)?;
    let code = if status >= 500 {
        text(error, "internal_error")?
    } else {
        ports
            .get(c"safeCode")?
            .call_plain(&[L::new(&env, code), text(error, "request_error")?])?
    };
    error.assign(c"code", code)?;
    error.assign(c"safe", flag(error, status < 500)?)?;
    let compatibility = ports
        .get(c"sanitizeCompatibility")?
        .call_plain(&[L::new(&env, compatibility)])?;
    set_error_context(error, compatibility, L::new(&env, cause))
}

#[napi]
pub fn http_error_definitions(env: Env, anchor: Unknown<'_>) -> Result<sys::napi_value> {
    let anchor = L::new(&env, anchor);
    let map = fields(anchor, &[])?;
    for &(kind, status, code, message) in DOMAIN_DEFINITIONS {
        let definition = fields(
            anchor,
            &[
                ("status", num(anchor, status.into())?),
                ("code", text(anchor, code)?),
                ("error", text(anchor, message)?),
            ],
        )?;
        map.define_key(text(anchor, kind)?, definition.freeze()?)?;
    }
    Ok(map.freeze()?.raw())
}

fn internal<'a>(cause: L<'a>, compatibility: L<'a>) -> Result<L<'a>> {
    let internal = text(cause, "internal_error")?;
    fields(
        cause,
        &[
            ("status", num(cause, 500.0)?),
            ("code", internal),
            ("message", internal),
            ("compatibility", compatibility),
            ("cause", cause),
        ],
    )
}

#[napi]
pub fn http_error_map(
    env: Env,
    error: Unknown<'_>,
    ports: Unknown<'_>,
    definitions: Unknown<'_>,
) -> Result<sys::napi_value> {
    let error = L::new(&env, error);
    let ports = L::new(&env, ports);
    if ports.get(c"isHttpError")?.call_plain(&[error])?.is_true()? {
        return Ok(error.raw());
    }
    let options = if ports
        .get(c"isInfrastructureError")?
        .call_plain(&[error])?
        .is_true()?
    {
        internal(error, error.get(c"compatibility")?)?
    } else if !ports
        .get(c"isDomainError")?
        .call_plain(&[error])?
        .is_true()?
    {
        internal(error, error.from_value(&V::Undefined)?)?
    } else {
        let definition = L::new(&env, definitions).get_key(error.get(c"kind")?)?;
        if !definition.truthy()? || definition.get(c"status")?.number()? >= 500.0 {
            internal(error, error.get(c"compatibility")?)?
        } else {
            fields(
                error,
                &[
                    ("status", definition.get(c"status")?),
                    (
                        "code",
                        ports
                            .get(c"safeCode")?
                            .call_plain(&[error.get(c"code")?, definition.get(c"code")?])?,
                    ),
                    (
                        "message",
                        ports.get(c"sanitizePublicText")?.call_plain(&[
                            error.get(c"publicMessage")?,
                            definition.get(c"error")?,
                        ])?,
                    ),
                    ("compatibility", error.get(c"compatibility")?),
                    ("cause", error),
                ],
            )?
        }
    };
    Ok(ports.get(c"HttpError")?.construct(&[options])?.raw())
}
