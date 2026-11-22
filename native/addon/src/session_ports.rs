//! N-API surface for `src/session/ports.js` port-shape validators.
#![cfg_attr(test, allow(dead_code))]

use crate::js_live::LiveValue as L;
use multicc_core::{js::JsValue as V, session_ports as core};
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    check_status, sys, Env, Result,
};
use napi_derive::napi;
use std::ffi::CString;

fn arity(function: L<'_>, length: f64) -> Result<L<'_>> {
    let value = function.from_value(&V::Number(length))?;
    let descriptor = sys::napi_property_descriptor {
        utf8name: c"length".as_ptr(),
        value: value.raw(),
        attributes: sys::PropertyAttributes::configurable,
        ..unsafe { std::mem::zeroed() }
    };
    check_status!(unsafe {
        sys::napi_define_properties(function.env(), function.raw(), 1, &descriptor)
    })?;
    Ok(function)
}

fn require_port<'a>(port: L<'a>, name: &str, methods: &[&str]) -> Result<L<'a>> {
    if !port.truthy()? || port.kind()? != sys::ValueType::napi_object {
        return Err(port.type_error(&core::port_required_error(name)));
    }
    for method in methods {
        let key = CString::new(*method).expect("static method name");
        if port.get(&key)?.kind()? != sys::ValueType::napi_function {
            return Err(port.type_error(&core::port_method_error(name, method)));
        }
    }
    Ok(port)
}

#[napi]
pub fn session_assert_session_records_port(env: Env, port: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(require_port(
        L::new(&env, port),
        core::RECORDS_PORT_NAME,
        &core::RECORDS_PORT_METHODS,
    )?
    .raw())
}

#[napi]
pub fn session_assert_session_runtime_port(env: Env, port: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(require_port(
        L::new(&env, port),
        core::RUNTIME_PORT_NAME,
        &core::RUNTIME_PORT_METHODS,
    )?
    .raw())
}

#[napi]
pub fn session_assert_workspace_facts_port(env: Env, port: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(require_port(
        L::new(&env, port),
        core::WORKSPACE_FACTS_PORT_NAME,
        &core::WORKSPACE_FACTS_PORT_METHODS,
    )?
    .raw())
}

#[napi]
pub fn session_assert_directory_records_port(
    env: Env,
    port: Unknown<'_>,
) -> Result<sys::napi_value> {
    Ok(require_port(
        L::new(&env, port),
        core::DIRECTORIES_PORT_NAME,
        &core::DIRECTORIES_PORT_METHODS,
    )?
    .raw())
}

#[napi]
pub fn session_assert_chat_history_port(env: Env, port: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(require_port(
        L::new(&env, port),
        core::CHAT_HISTORY_PORT_NAME,
        &core::CHAT_HISTORY_PORT_METHODS,
    )?
    .raw())
}

#[napi]
pub fn session_ports_api(env: Env) -> Result<sys::napi_value> {
    let anchor = L::new(&env, ().into_unknown(&env)?);
    let api = anchor.from_value(&V::Object(vec![]))?;

    let specs: [(&str, &std::ffi::CStr, &'static str, &'static [&'static str]); 5] = [
        (
            "assertSessionRecordsPort",
            c"assertSessionRecordsPort",
            core::RECORDS_PORT_NAME,
            &core::RECORDS_PORT_METHODS,
        ),
        (
            "assertSessionRuntimePort",
            c"assertSessionRuntimePort",
            core::RUNTIME_PORT_NAME,
            &core::RUNTIME_PORT_METHODS,
        ),
        (
            "assertWorkspaceFactsPort",
            c"assertWorkspaceFactsPort",
            core::WORKSPACE_FACTS_PORT_NAME,
            &core::WORKSPACE_FACTS_PORT_METHODS,
        ),
        (
            "assertDirectoryRecordsPort",
            c"assertDirectoryRecordsPort",
            core::DIRECTORIES_PORT_NAME,
            &core::DIRECTORIES_PORT_METHODS,
        ),
        (
            "assertChatHistoryPort",
            c"assertChatHistoryPort",
            core::CHAT_HISTORY_PORT_NAME,
            &core::CHAT_HISTORY_PORT_METHODS,
        ),
    ];

    for (fn_name, prop_name, port_name, methods) in specs {
        let func = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
            fn_name,
            move |ctx| {
                let absent = L::new(ctx.env, ().into_unknown(ctx.env)?);
                let port = if ctx.length() > 0 {
                    L::new(ctx.env, ctx.get::<Unknown<'_>>(0)?)
                } else {
                    absent
                };
                Ok(require_port(port, port_name, methods)?.raw())
            },
        )?;
        api.set(
            prop_name,
            arity(L::new(&env, func.into_unknown(&env)?), 1.0)?,
        )?;
    }
    Ok(api.raw())
}
