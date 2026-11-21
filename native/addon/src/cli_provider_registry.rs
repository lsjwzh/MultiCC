//! Registry decisions stay native; host Maps retain opaque adapter/key identity.
//! The factory roots only a frozen retired adapter with no captured host values.
//! Per-registry state is traced by the host closure, including adapter cycles.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as V;
use napi::bindgen_prelude::{ToNapiValue, Unknown};
use napi::{check_status, sys, Env, Result};
use napi_derive::napi;
use std::ptr;

const RETIRED_MESSAGE: &str =
    "Gemini CLI 已停用，请切换至 Antigravity（agy）；原会话历史不会自动迁移。";
const RETIRED_TERMINAL: &str = "printf '%s\\n' 'Gemini CLI retired; switch to Antigravity (agy).'";

fn text<'a>(anchor: L<'a>, value: &str) -> Result<L<'a>> {
    anchor.from_value(&V::from(value))
}
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
pub struct RustCliProviderRegistryFactory {
    env: sys::napi_env,
    retired: sys::napi_ref,
}
impl Drop for RustCliProviderRegistryFactory {
    fn drop(&mut self) {
        unsafe { sys::napi_delete_reference(self.env, self.retired) };
    }
}

#[napi]
impl RustCliProviderRegistryFactory {
    #[napi(constructor)]
    pub fn new(env: Env) -> Result<Self> {
        let anchor = L::new(&env, ().into_unknown(&env)?);
        let retired = anchor.from_value(&V::Object(vec![]))?;
        retired.set(c"name", text(anchor, "gemini")?)?;
        retired.set(c"cmd", text(anchor, "")?)?;
        let invoke = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
            "buildInvocation",
            |ctx| {
                let anchor = L::new(ctx.env, ().into_unknown(ctx.env)?);
                Err(error(anchor, text(anchor, RETIRED_MESSAGE)?)?)
            },
        )?;
        retired.set(c"buildInvocation", L::new(&env, invoke.into_unknown(&env)?))?;
        let terminal = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
            "buildTerminalCmd",
            |ctx| {
                let anchor = L::new(ctx.env, ().into_unknown(ctx.env)?);
                Ok(text(anchor, RETIRED_TERMINAL)?.raw())
            },
        )?;
        retired.set(
            c"buildTerminalCmd",
            L::new(&env, terminal.into_unknown(&env)?),
        )?;
        let decode = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
            "decodeEvent",
            |ctx| {
                Ok(L::new(ctx.env, ().into_unknown(ctx.env)?)
                    .from_value(&V::Array(vec![]))?
                    .raw())
            },
        )?;
        retired.set(c"decodeEvent", L::new(&env, decode.into_unknown(&env)?))?;
        retired.freeze()?;
        let mut reference = ptr::null_mut();
        check_status!(unsafe {
            sys::napi_create_reference(env.raw(), retired.raw(), 1, &mut reference)
        })?;
        Ok(Self {
            env: env.raw(),
            retired: reference,
        })
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
        let constructor = cli.global()?.get(c"String")?;
        let value = if cli.truthy()? { cli } else { text(cli, "")? };
        let name = constructor.call_plain(&[value])?;
        let name = method(method(name, c"trim", &[])?, c"toLowerCase", &[])?;
        if name.is_string("gemini")? {
            let mut retired = ptr::null_mut();
            check_status!(unsafe {
                sys::napi_get_reference_value(env.raw(), self.retired, &mut retired)
            })?;
            return Ok(retired);
        }
        let adapter = method(state.get(c"table")?, c"get", &[cli])?;
        Ok(if adapter.truthy()? {
            adapter
        } else {
            state.get(c"fallback")?
        }
        .raw())
    }
}
