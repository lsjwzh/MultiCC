//! Synchronous provider DTO policy. Borrow the input so each getter is invoked
//! only when validation reaches it. Set membership and errors use the public
//! objects of the calling module.
use crate::js_live::LiveValue;
use multicc_core::js::{JsString, JsValue};
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

const VIEW: [(&CStr, &CStr); 8] = [
    (c"sessionId", c"id"),
    (c"cli", c"cli"),
    (c"providerId", c"provider"),
    (c"model", c"model"),
    (c"roleKind", c"roleKind"),
    (c"agentRole", c"agentRole"),
    (c"routeName", c"routeName"),
    (c"accountId", c"accountId"),
];

struct Rules<'a> {
    host: LiveValue<'a>,
}

impl<'a> Rules<'a> {
    fn reject<T>(&self, message: JsString, code: &str) -> Result<T> {
        let error = self.host.get(c"ProviderBindingError")?.construct(&[
            self.host.from_value(&JsValue::String(message))?,
            self.host.from_value(&JsValue::string(code))?,
        ])?;
        Err(error.throw_error())
    }

    fn invalid<T>(&self, message: &str) -> Result<T> {
        self.reject(JsString::from_rust_str(message), "INVALID_PROVIDER_BINDING")
    }

    fn validate_keys(&self, input: LiveValue<'a>) -> Result<()> {
        if input.kind()? != sys::ValueType::napi_object || input.is_array()? {
            return self.invalid("ProviderBinding input must be an object");
        }
        let object = input.global()?.get(c"Object")?;
        let keys = object.get(c"keys")?.call(object, &[input])?;
        let mut extra = Vec::new();
        for index in 0..keys.get(c"length")?.number()? as u32 {
            let key = keys.element(index)?.coerce_string()?;
            if !VIEW.iter().any(|(field, _)| key == field.to_str().unwrap()) {
                extra.push(key);
            }
        }
        if !extra.is_empty() {
            extra.sort();
            let mut message = JsString::from_rust_str("ProviderBinding rejects session fields: ");
            message.push(&JsString::join(&extra, &JsString::from_rust_str(", ")));
            return self.reject(message, "PROVIDER_BINDING_TOO_BROAD");
        }
        Ok(())
    }

    fn field(
        &self,
        value: LiveValue<'a>,
        label: &str,
        max: usize,
        required: bool,
    ) -> Result<LiveValue<'a>> {
        let text = value.clean_text()?;
        let units = text.coerce_string()?;
        if units.is_empty() {
            if required {
                return self.invalid(&format!("{label} is required"));
            }
            return value.from_value(&JsValue::Null);
        }
        if units.len() > max || units.as_units().iter().any(|u| *u < 32 || *u == 127) {
            return self.invalid(&format!("{label} is invalid"));
        }
        Ok(text)
    }

    fn allows(&self, set: &CStr, value: LiveValue<'a>) -> Result<bool> {
        let set = self.host.get(set)?;
        set.get(c"has")?.call(set, &[value])?.truthy()
    }
}

fn lower(value: LiveValue<'_>) -> Result<LiveValue<'_>> {
    value.get(c"toLowerCase")?.call(value, &[])
}

fn route_name_valid(route: &JsString) -> bool {
    let units = route.as_units();
    matches!(units.first(), Some(97..=122))
        && units.len() <= 64
        && units
            .iter()
            .all(|unit| matches!(unit, 97..=122 | 48..=57 | 45 | 95))
}

#[napi]
pub fn normalize_provider_binding(
    env: Env,
    input: Unknown<'_>,
    host: Unknown<'_>,
) -> Result<sys::napi_value> {
    let input = LiveValue::new(&env, input);
    let rules = Rules {
        host: LiveValue::new(&env, host),
    };
    rules.validate_keys(input)?;
    let session = rules.field(input.get(c"sessionId")?, "sessionId", 256, true)?;
    let cli = lower(rules.field(input.get(c"cli")?, "cli", 32, true)?)?;
    if !rules.allows(c"SUPPORTED_CLIS", cli)? {
        let mut message = JsString::from_rust_str("unsupported cli: ");
        message.push(&cli.coerce_string()?);
        return rules.reject(message, "INVALID_PROVIDER_BINDING");
    }
    let provider = rules.field(input.get(c"providerId")?, "providerId", 256, false)?;
    let model = rules.field(input.get(c"model")?, "model", 256, false)?;
    let account = rules.field(input.get(c"accountId")?, "accountId", 64, false)?;
    let mut role = input.get(c"roleKind")?;
    if !role.truthy()? {
        role = input.from_value(&JsValue::string("main"))?;
    }
    let role = lower(rules.field(role, "roleKind", 16, true)?)?;
    if !rules.allows(c"ROLE_KINDS", role)? {
        return rules.invalid("roleKind must be main, sub, or aux");
    }
    let mut agent = rules.field(input.get(c"agentRole")?, "agentRole", 32, false)?;
    let mut route = rules.field(input.get(c"routeName")?, "routeName", 64, false)?;
    if role.is_string("sub")? {
        if agent.nullish()? {
            agent = input.from_value(&JsValue::string("default"))?;
        }
        agent = lower(agent)?;
        if !rules.allows(c"AGENT_ROLES", agent)? {
            return rules.invalid("sub agentRole must be default, worker, explorer, or custom");
        }
        route = lower(if route.nullish()? { agent } else { route })?;
        if !route_name_valid(&route.coerce_string()?) {
            return rules.invalid("routeName must be a valid agent route");
        }
    } else {
        if !agent.nullish()? {
            return rules.invalid("agentRole is only valid for sub bindings");
        }
        if !route.nullish()? && !lower(route)?.equals(role)? {
            let mut message = role.coerce_string()?;
            message.push_str(" routeName must be ");
            message.push(&role.coerce_string()?);
            return rules.reject(message, "INVALID_PROVIDER_BINDING");
        }
        route = role;
    }
    let binding = input.from_value(&JsValue::Object(Vec::new()))?;
    for ((key, _), value) in VIEW
        .iter()
        .zip([session, cli, provider, model, role, agent, route, account])
    {
        binding.set(key, value)?;
    }
    Ok(binding.raw())
}

#[napi]
pub fn legacy_provider_binding_view(env: Env, binding: Unknown<'_>) -> Result<sys::napi_value> {
    let binding = LiveValue::new(&env, binding);
    let view = binding.from_value(&JsValue::Object(Vec::new()))?;
    for (source, target) in VIEW {
        view.set(target, binding.get(source)?)?;
    }
    Ok(view.raw())
}
