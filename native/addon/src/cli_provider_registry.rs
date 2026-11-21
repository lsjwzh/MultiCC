//! Registry decisions stay native; host Maps retain opaque adapter/key identity.
//! Per-registry state is traced by the host closure, including adapter cycles.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as V;
use napi::bindgen_prelude::{ToNapiValue, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;

fn method<'a>(target: L<'a>, key: &std::ffi::CStr, args: &[L<'a>]) -> Result<L<'a>> {
    target.get(key)?.call(target, args)
}
fn error(anchor: L<'_>, message: L<'_>) -> Result<napi::Error> {
    Ok(anchor
        .global()?
        .get(c"Error")?
        .construct(&[message])?
        .throw_error())
}
fn missing_method(adapter: L<'_>, name: &str) -> Result<napi::Error> {
    let mut message = multicc_core::js::JsString::from_rust_str("CLI adapter ");
    message.push(&adapter.get(c"name")?.coerce_string()?);
    message.push(&multicc_core::js::JsString::from_rust_str(&format!(
        " is missing {name}()"
    )));
    error(adapter, adapter.from_value(&V::String(message))?)
}

#[napi]
pub struct RustCliProviderRegistryFactory {}

#[napi]
impl RustCliProviderRegistryFactory {
    #[napi(constructor)]
    pub fn new(_env: Env) -> Result<Self> {
        Ok(Self {})
    }

    #[napi]
    pub fn create(
        &self,
        env: Env,
        adapters: Unknown<'_>,
        fallback_name: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let adapters = L::new(&env, adapters);
        let fallback_name = L::new(&env, fallback_name);
        let table = adapters.global()?.get(c"Map")?.construct(&[])?;
        adapters.for_each(|adapter| {
            if !adapter.truthy()? || !adapter.get(c"name")?.truthy()? {
                return Ok(());
            }
            if adapter.get(c"buildInvocation")?.kind()? != sys::ValueType::napi_function {
                return Err(missing_method(adapter, "buildInvocation")?);
            }
            if adapter.get(c"decodeEvent")?.kind()? != sys::ValueType::napi_function {
                return Err(missing_method(adapter, "decodeEvent")?);
            }
            method(table, c"set", &[adapter.get(c"name")?, adapter])?;
            Ok(())
        })?;
        let fallback = method(table, c"get", &[fallback_name])?;
        if !fallback.truthy()? {
            let mut message =
                multicc_core::js::JsString::from_rust_str("missing fallback CLI adapter: ");
            message.push(&fallback_name.coerce_string()?);
            return Err(error(adapters, adapters.from_value(&V::String(message))?)?);
        }
        let object = adapters.global()?.get(c"Object")?;
        let from_entries = object.get(c"fromEntries")?;
        let entries = method(table, c"entries", &[])?;
        let providers = from_entries.call(object, &[entries])?;
        let state = adapters.from_value(&V::Object(vec![]))?;
        for (key, value) in [
            (c"table", table),
            (c"fallback", fallback),
            (c"providers", providers),
        ] {
            state.set(key, value)?;
        }
        Ok(state.raw())
    }

    #[napi]
    pub fn resolve(
        &self,
        env: Env,
        state: Unknown<'_>,
        cli: Unknown<'_>,
    ) -> Result<sys::napi_value> {
        let state = L::new(&env, state);
        let cli = L::new(&env, cli);
        let adapter = method(state.get(c"table")?, c"get", &[cli])?;
        Ok(if adapter.truthy()? {
            adapter
        } else {
            state.get(c"fallback")?
        }
        .raw())
    }
}
