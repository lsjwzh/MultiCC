//! Stateful authentication adapter. The Rust store owns ticket lifetime and
//! single-use consumption; retained JS values only supply host callbacks and
//! opaque metadata. The JS receiver retains a tracing anchor; Rust holds only
//! a weak handle to it, so callback/metadata cycles can be collected by V8.
//! No RefCell borrow is held while calling JavaScript.
use crate::js_live::LiveValue as V;
use multicc_core::{
    auth_security as core,
    js::{JsString, JsValue},
};
use napi::{bindgen_prelude::Unknown, check_status, sys, Env, Result};
use napi_derive::napi;
use std::{
    cell::{Cell, RefCell},
    ptr,
};

struct Held {
    env: sys::napi_env,
    reference: sys::napi_ref,
}
impl Held {
    fn new(value: V<'_>) -> Result<Self> {
        let mut reference = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_create_reference(value.env(), value.raw(), 0, &mut reference)
        })?;
        Ok(Self {
            env: value.env(),
            reference,
        })
    }
    fn get<'a>(&self, env: &'a Env) -> Result<V<'a>> {
        let mut value = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_get_reference_value(env.raw(), self.reference, &mut value)
        })?;
        if value.is_null() {
            return Err(napi::Error::from_reason("auth host references released"));
        }
        Ok(V::from_raw(env.raw(), value))
    }
}
impl Drop for Held {
    fn drop(&mut self) {
        unsafe {
            sys::napi_delete_reference(self.env, self.reference);
        }
    }
}

fn string(value: V<'_>) -> Result<Option<String>> {
    Ok(value.string()?.map(|v| v.to_string_lossy()))
}
fn text<'a>(v: V<'a>, s: &str) -> Result<V<'a>> {
    v.from_value(&JsValue::string(s))
}
fn object(v: V<'_>) -> Result<V<'_>> {
    v.from_value(&JsValue::Object(Vec::new()))
}
fn setting(port: V<'_>, key: &std::ffi::CStr, default: f64) -> Result<f64> {
    let value = port.get(key)?;
    if value.undefined()? {
        return Ok(default);
    }
    value
        .number_value()?
        .filter(|n| n.is_finite())
        .ok_or_else(|| port.type_error("auth TTL and capacity options must be finite numbers"))
}

#[napi]
pub struct RustAuthSecurity {
    owner: Held,
    next_slot: Cell<u64>,
    cookie_ttl: f64,
    ticket_ttl: f64,
    max_tickets: usize,
    tickets: RefCell<core::WsTickets<u64>>,
}

impl RustAuthSecurity {
    fn take_metadata<'a>(&self, env: &'a Env, slot: u64) -> Result<V<'a>> {
        let slots = self.owner.get(env)?.get(c"slots")?;
        let key = text(slots, &slot.to_string())?;
        let value = slots.get_key(key)?;
        let mut deleted = false;
        check_status!(unsafe {
            sys::napi_delete_property(env.raw(), slots.raw(), key.raw(), &mut deleted)
        })?;
        Ok(value)
    }
    fn secret(&self, env: &Env) -> Result<String> {
        let port = self.owner.get(env)?.get(c"port")?;
        Ok(string(port.get(c"getSecret")?.call_plain(&[])?)?.unwrap_or_default())
    }
    fn now(&self, env: &Env) -> Result<f64> {
        let port = self.owner.get(env)?.get(c"port")?;
        let clock = port.get(c"now")?;
        if !clock.undefined()? {
            return clock.call_plain(&[])?.number();
        }
        // Preserve the host clock seam (including tests that stub Date.now).
        let date = port.global()?.get(c"Date")?;
        date.get(c"now")?.call(date, &[])?.number()
    }
    fn random(&self, env: &Env, size: usize) -> Result<String> {
        let port = self.owner.get(env)?.get(c"port")?;
        let random = port.get(c"randomBytes")?;
        if !random.undefined()? {
            let bytes = random.call_plain(&[port.from_value(&JsValue::Number(size as f64))?])?;
            let encoded = bytes
                .get(c"toString")?
                .call(bytes, &[text(port, "base64url")?])?;
            return string(encoded)?
                .ok_or_else(|| port.type_error("randomBytes must return bytes"));
        }
        core::random_base64url(size).map_err(napi::Error::from_reason)
    }
}

#[napi]
impl RustAuthSecurity {
    #[napi(constructor)]
    pub fn new(env: Env, options: Unknown<'_>, owner: Unknown<'_>) -> Result<Self> {
        let mut options = V::new(&env, options);
        if options.undefined()? {
            options = object(options)?;
        }
        let port = object(options)?;
        // Snapshot option properties once, in the original destructuring order.
        for key in [c"getSecret", c"now", c"randomBytes"] {
            port.set(key, options.get(key)?)?;
        }
        let cookie_ttl = setting(options, c"cookieTtlMs", core::COOKIE_TTL_MS as f64)?;
        let ticket_ttl = setting(options, c"ticketTtlMs", core::TICKET_TTL_MS as f64)?;
        let max = setting(options, c"maxTickets", core::MAX_TICKETS as f64)?;
        if port.get(c"getSecret")?.kind()? != sys::ValueType::napi_function {
            return Err(port.type_error("createAuthSecurity requires getSecret()"));
        }
        if max <= 0.0 || max.fract() != 0.0 || max > u32::MAX as f64 {
            return Err(
                port.type_error("maxTickets must be a positive integer no greater than 4294967295")
            );
        }
        let owner = V::new(&env, owner);
        owner.set(c"port", port)?;
        owner.set(c"slots", object(port)?)?;
        Ok(Self {
            owner: Held::new(owner)?,
            next_slot: Cell::new(0),
            cookie_ttl,
            ticket_ttl,
            max_tickets: max as usize,
            tickets: RefCell::new(core::WsTickets::default()),
        })
    }

    #[napi]
    pub fn create_cookie(&self, env: Env) -> Result<String> {
        let now = self.now(&env)?;
        let nonce = self.random(&env, 8)?;
        let body = core::cookie_body(now, self.cookie_ttl, &nonce);
        Ok(format!("{body}.{}", core::sign(&self.secret(&env)?, &body)))
    }

    #[napi]
    pub fn verify_cookie(&self, env: Env, cookie: Unknown<'_>) -> Result<bool> {
        if self.secret(&env)?.is_empty() {
            return Ok(false);
        }
        let Some(cookie) = V::new(&env, cookie).string()? else {
            return Ok(false);
        };
        if !core::valid_cookie_shape(&cookie) {
            return Ok(false);
        }
        let Some(claims) = core::verified_claims_js(&self.secret(&env)?, &cookie) else {
            return Ok(false);
        };
        Ok(core::valid_claims(
            &claims,
            self.now(&env)?,
            self.cookie_ttl,
        ))
    }

    #[napi]
    pub fn verify_access_token(&self, env: Env, candidate: Unknown<'_>) -> Result<bool> {
        let key = self.secret(&env)?;
        Ok(core::verify_access_token(
            &key,
            string(V::new(&env, candidate))?.as_deref(),
        ))
    }

    #[napi]
    pub fn prune_tickets(&self, env: Env) -> Result<()> {
        let now = self.now(&env)?;
        let removed = self.tickets.borrow_mut().prune(now, self.max_tickets);
        for slot in removed {
            self.take_metadata(&env, slot)?;
        }
        Ok(())
    }

    #[napi]
    pub fn issue_ws_ticket(
        &self,
        env: Env,
        pathname: Unknown<'_>,
        metadata: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let pathname = V::new(&env, pathname);
        let scope = string(pathname)?
            .and_then(|s| core::normalize_ws_path(&s))
            .ok_or_else(|| pathname.type_error("invalid WebSocket ticket path"))?;
        self.prune_tickets(env)?;
        let ticket = self.random(&env, 24)?;
        let expires = self.now(&env)? + self.ticket_ttl;
        let copied = object(pathname)?;
        copied.spread_from(V::new(&env, metadata))?;
        let slot = self.next_slot.get();
        self.next_slot.set(slot.wrapping_add(1));
        self.owner
            .get(&env)?
            .get(c"slots")?
            .define_key(text(pathname, &slot.to_string())?, copied)?;
        let replaced = self
            .tickets
            .borrow_mut()
            .insert(&ticket, scope.clone(), expires, slot);
        if let Some(slot) = replaced {
            self.take_metadata(&env, slot)?;
        }
        Ok(pathname
            .from_value(&JsValue::object(vec![
                ("ticket", ticket.into()),
                ("expiresAt", JsValue::Number(expires)),
                ("path", scope.into()),
            ]))?
            .raw())
    }

    #[napi]
    pub fn consume_ws_ticket(
        &self,
        env: Env,
        ticket: Unknown<'_>,
        pathname: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let ticket = V::new(&env, ticket);
        let null = ticket.from_value(&JsValue::Null)?;
        let Some(value) = string(ticket)?.filter(|s| !s.is_empty()) else {
            return Ok(null.raw());
        };
        let Some(scope) = string(V::new(&env, pathname))?.and_then(|s| core::normalize_ws_path(&s))
        else {
            return Ok(null.raw());
        };
        let record = self.tickets.borrow_mut().take(&value);
        let Some(record) = record else {
            return Ok(null.raw());
        };
        let metadata = self.take_metadata(&env, record.metadata)?;
        // Removed before clock and scope checks, including a wrong-scope attempt.
        if record.expires_at <= self.now(&env)? || record.path != scope {
            return Ok(null.raw());
        }
        let out = object(ticket)?;
        out.spread_from(metadata)?;
        out.set(c"path", text(ticket, &record.path)?)?;
        out.set(
            c"expiresAt",
            ticket.from_value(&JsValue::Number(record.expires_at))?,
        )?;
        Ok(out.raw())
    }

    #[napi]
    pub fn ticket_count(&self) -> u32 {
        self.tickets.borrow().len() as u32
    }
}

#[napi]
pub fn auth_timing_safe_equal_text(
    env: Env,
    left: Unknown<'_>,
    right: Unknown<'_>,
) -> Result<bool> {
    Ok(
        match (string(V::new(&env, left))?, string(V::new(&env, right))?) {
            (Some(a), Some(b)) => core::timing_safe_equal_text(&a, &b),
            _ => false,
        },
    )
}
#[napi]
pub fn auth_normalize_redirect(
    env: Env,
    value: Unknown<'_>,
    fallback: Unknown<'_>,
) -> Result<sys::napi_value> {
    let value = V::new(&env, value);
    let fallback = V::new(&env, fallback);
    Ok(
        if let Some(path) = string(value)?.and_then(|s| core::normalize_redirect(&s)) {
            text(value, &path)?
        } else if fallback.undefined()? {
            text(value, "/")?
        } else {
            fallback
        }
        .raw(),
    )
}
#[napi]
pub fn auth_normalize_ws_path(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let value = V::new(&env, value);
    Ok(
        match string(value)?.and_then(|s| core::normalize_ws_path(&s)) {
            Some(path) => text(value, &path)?,
            None => value.from_value(&JsValue::Null)?,
        }
        .raw(),
    )
}
#[napi]
pub fn auth_escape_html_attribute(env: Env, value: Unknown<'_>) -> Result<sys::napi_value> {
    let value = V::new(&env, value);
    let source = value
        .global()?
        .get(c"String")?
        .call_plain(&[value])?
        .coerce_string()?;
    let mut out = JsString::new();
    for &unit in source.as_units() {
        match unit {
            38 => out.push_str("&amp;"),
            60 => out.push_str("&lt;"),
            62 => out.push_str("&gt;"),
            34 => out.push_str("&quot;"),
            39 => out.push_str("&#39;"),
            _ => out.push(&JsString::from_units(vec![unit])),
        }
    }
    Ok(value.from_value(&JsValue::String(out))?.raw())
}
