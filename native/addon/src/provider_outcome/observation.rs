//! One HTTP request, before the event reaches the provider attempt coordinator.
use super::{frozen, null, number, text};
use crate::js_live::LiveValue;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::cell::Cell;

#[napi]
pub fn proxy_classify_request(claude: bool, method: String, url: String) -> &'static str {
    let path = url.split('?').next().unwrap_or("").trim_end_matches('/');
    match method.as_str() {
        "HEAD" => "probe",
        "POST" if path.ends_with(if claude { "/v1/messages" } else { "/responses" }) => "inference",
        _ => "auxiliary",
    }
}

fn status(n: f64) -> bool {
    (400.0..=599.0).contains(&n) && n.fract() == 0.0
}

fn normalize(value: LiveValue<'_>) -> Result<LiveValue<'_>> {
    let invalid = || value.type_error("invalid proxy outcome");
    if !value.truthy()?
        || !value.get(c"version")?.is_number(1.0)?
        || value.get(c"requestId")?.kind()? != sys::ValueType::napi_string
    {
        return Err(invalid());
    }
    let id = value.get(c"requestId")?.coerce_string()?;
    if !(1..=80).contains(&id.as_units().len())
        || !id
            .as_units()
            .iter()
            .all(|&u| matches!(u, 45 | 48..=57 | 65..=90 | 95 | 97..=122))
    {
        return Err(invalid());
    }
    let kind = value.get(c"requestKind")?;
    if !(kind.is_string("inference")? || kind.is_string("probe")? || kind.is_string("auxiliary")?) {
        return Err(invalid());
    }
    let end = value.get(c"termination")?;
    if !(end.is_string("completed")?
        || end.is_string("downstream_disconnect")?
        || end.is_string("upstream_http_error")?
        || end.is_string("upstream_failure")?)
    {
        return Err(invalid());
    }
    let http = if value.get(c"httpStatus")?.nullish()? {
        null(value)?
    } else {
        value.get(c"httpStatus")?
    };
    let present = http.kind()? != sys::ValueType::napi_null;
    if (present && !http.number_value()?.is_some_and(status))
        || value
            .get(c"termination")?
            .is_string("upstream_http_error")?
            != present
    {
        return Err(value.type_error("invalid proxy outcome HTTP status"));
    }
    frozen(
        value,
        vec![
            (c"version", number(value, 1.0)?),
            (c"requestId", value.get(c"requestId")?),
            (c"requestKind", value.get(c"requestKind")?),
            (c"termination", value.get(c"termination")?),
            (c"httpStatus", http),
        ],
    )
}

#[napi]
pub fn proxy_normalize_outcome(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(normalize(LiveValue::new(&env, value))?.raw())
}

#[napi]
pub struct ProxyObservationState {
    closed: Cell<bool>,
    settled: Cell<bool>,
}

#[napi]
impl ProxyObservationState {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            closed: Cell::new(false),
            settled: Cell::new(false),
        }
    }
    #[napi]
    pub fn disconnect(&self) {
        self.closed.set(true);
    }
    #[napi]
    pub fn claim_terminal(&self) -> bool {
        !self.settled.replace(true)
    }
    #[napi]
    pub fn outcome(
        &self,
        env: Env,
        id: Unknown<'_>,
        kind: Unknown<'_>,
        code: f64,
        event: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let event = LiveValue::new(&env, event);
        let (termination, http) = if status(code) {
            ("upstream_http_error", number(event, code)?)
        } else {
            let state = event
                .global()?
                .get(c"String")?
                .call_plain(&[event.get(c"status")?])?;
            let error = state
                .get(c"toLowerCase")?
                .call(state, &[])?
                .is_string("error")?;
            (
                if !error {
                    "completed"
                } else if self.closed.get() {
                    "downstream_disconnect"
                } else {
                    "upstream_failure"
                },
                null(event)?,
            )
        };
        let value = super::object(
            event,
            vec![
                (c"version", number(event, 1.0)?),
                (c"requestId", LiveValue::new(&env, id)),
                (c"requestKind", LiveValue::new(&env, kind)),
                (c"termination", text(event, termination)?),
                (c"httpStatus", http),
            ],
        )?;
        Ok(normalize(value)?.raw())
    }
}
