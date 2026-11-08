//! Exact-secret redaction at the host boundary (see
//! `multicc_core::exact_secret`). Arguments are coerced as the JS did:
//! `Array.isArray(values) ? values : [values]`, then `String(value || '')`
//! for each element (a dense read: callers pass plain arrays).
use crate::api_error_text::{string_or_empty, text};
use crate::js_live::LiveValue;
use multicc_core::{
    exact_secret::{self, Secrets, StreamRedactor},
    js::{JsString, JsValue},
};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::{cell::RefCell, rc::Rc};

/// `Array.isArray(value)`: N-API's check first (a plain array), then the
/// ECMAScript one, which also sees through a Proxy.
fn is_array(value: LiveValue<'_>) -> Result<bool> {
    let mut plain = false;
    napi::check_status!(unsafe { sys::napi_is_array(value.env(), value.raw(), &mut plain) })?;
    Ok(plain || value.is_array()?)
}

/// Each coerced string with the element it came from when that element was
/// already a string (so an unchanged result can reuse it).
fn elements<'a>(value: LiveValue<'a>) -> Result<Vec<(JsString, Option<LiveValue<'a>>)>> {
    let read = |item: LiveValue<'a>| -> Result<(JsString, Option<LiveValue<'a>>)> {
        match item.string()? {
            Some(text) => Ok((text, Some(item))),
            None => Ok((string_or_empty(item)?, None)),
        }
    };
    if !is_array(value)? {
        return Ok(vec![read(value)?]);
    }
    let length = value.get(c"length")?.number()? as u32;
    (0..length)
        .map(|index| read(value.element(index)?))
        .collect()
}

pub(crate) fn strings(value: LiveValue<'_>) -> Result<Vec<JsString>> {
    Ok(elements(value)?.into_iter().map(|(text, _)| text).collect())
}

thread_local! {
    /// The last secret list and its compiled searches: one attempt redacts
    /// many structures with the same capability pair, and the SIMD searchers
    /// cost more to build than a typical structure takes to scan.
    static LAST_SECRETS: RefCell<Option<(Vec<JsString>, Rc<Secrets>)>> = const { RefCell::new(None) };
}

pub(crate) fn cached_secrets(values: Vec<JsString>) -> Rc<Secrets> {
    LAST_SECRETS.with(|cell| {
        let mut last = cell.borrow_mut();
        if let Some((key, secrets)) = last.as_ref() {
            if *key == values {
                return Rc::clone(secrets);
            }
        }
        let secrets = Rc::new(exact_secret::normalize_secrets(values.clone()));
        *last = Some((values, Rc::clone(&secrets)));
        secrets
    })
}

#[napi]
pub fn redaction_exact_fragments(
    env: Env,
    values: Unknown<'_>,
    secrets: Unknown<'_>,
) -> Result<sys::napi_value> {
    let values = LiveValue::new(&env, values);
    let items = elements(values)?;
    let secrets = cached_secrets(strings(LiveValue::new(&env, secrets))?);
    let parts: Vec<JsString> = items.iter().map(|(text, _)| text.clone()).collect();
    let out = exact_secret::redact_fragments(parts, &secrets);
    // A fresh array, as `parts.map(...)` returned; unchanged strings are the
    // caller's own values rather than new copies.
    let array = values.from_value(&JsValue::Array(Vec::new()))?;
    for (index, (redacted, (original, handle))) in out.into_iter().zip(items).enumerate() {
        let item = match handle {
            Some(handle) if redacted == original => handle,
            _ => text(values, redacted)?,
        };
        napi::check_status!(unsafe {
            sys::napi_set_element(env.raw(), array.raw(), index as u32, item.raw())
        })?;
    }
    Ok(array.raw())
}

/// One stream's transducer state; the JS wrapper exposes push / setSecrets /
/// flush / discard / pendingLength.
#[napi]
pub struct RustExactSecretStreamRedactor {
    inner: StreamRedactor,
}

#[napi]
impl RustExactSecretStreamRedactor {
    #[napi(constructor)]
    pub fn new(env: Env, secrets: Unknown<'_>) -> Result<Self> {
        Ok(Self {
            inner: StreamRedactor::new(strings(LiveValue::new(&env, secrets))?),
        })
    }

    #[napi]
    pub fn push(&mut self, env: Env, chunk: Unknown<'_>) -> Result<sys::napi_value> {
        let chunk = LiveValue::new(&env, chunk);
        let input = string_or_empty(chunk)?;
        let output = self.inner.push(&input);
        // Unchanged text keeps the caller's string instead of a new copy.
        if output == input && chunk.kind()? == sys::ValueType::napi_string {
            return Ok(chunk.raw());
        }
        Ok(text(chunk, output)?.raw())
    }

    #[napi]
    pub fn set_secrets(&mut self, env: Env, secrets: Unknown<'_>) -> Result<()> {
        self.inner
            .set_secrets(strings(LiveValue::new(&env, secrets))?);
        Ok(())
    }

    #[napi]
    pub fn flush(&mut self, env: Env) -> Result<sys::napi_value> {
        let output = JsValue::String(self.inner.flush());
        unsafe { crate::js_bridge::write_value(env.raw(), &output) }
    }

    #[napi]
    pub fn discard(&mut self) {
        self.inner.discard();
    }

    #[napi]
    pub fn pending_length(&self) -> u32 {
        self.inner.pending_len() as u32
    }
}
