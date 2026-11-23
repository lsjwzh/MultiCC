use multicc_core::task_run_context;
use napi::bindgen_prelude::{JsValue as _, Unknown};
use napi::{sys, Env, Result};
use napi_derive::napi;

// Pure transform: board record + turn refs in, context wall out. The value is
// read without JSON, so lone surrogates, undefined, NaN and Buffers survive.
#[napi]
pub fn build_task_run_context(env: Env, input: Unknown<'_>) -> Result<sys::napi_value> {
    let raw = env.raw();
    let value = unsafe { crate::js_bridge::read_value(raw, input.raw(), 0, &mut Vec::new()) }?;
    let result = task_run_context::build_value(&value).map_err(napi::Error::from_reason)?;
    unsafe { crate::js_bridge::write_value(raw, &result) }
}

// 公开任务板入口只取内核会用的字段，日期字符串沿用当前 V8 的 Date.parse。
use crate::{
    js_live::LiveValue as L,
    task_board_host::{Host, Properties},
};
use multicc_core::js::JsValue as J;
use napi::bindgen_prelude::ToNapiValue;
use std::ffi::CStr;

fn project<'a>(value: L<'a>, keys: &[&CStr]) -> Result<L<'a>> {
    if value.nullish()? || value.kind()? != sys::ValueType::napi_object {
        return Ok(value);
    }
    let out = value.from_value(&J::Object(vec![]))?;
    for key in keys {
        if !value.get(key)?.undefined()? {
            out.set(key, value.get(key)?)?;
        }
    }
    Ok(out)
}

fn project_message(msg: L<'_>) -> Result<L<'_>> {
    let value = project(
        msg,
        &[
            c"text",
            c"content",
            c"body",
            c"role",
            c"ts",
            c"timestamp",
            c"createdAt",
            c"id",
            c"messageId",
        ],
    )?;
    if value.equals(msg)? {
        return Ok(value);
    }
    for key in [c"ts", c"timestamp", c"createdAt"] {
        let stamp = value.get(key)?;
        if stamp.nullish()? {
            continue;
        }
        if stamp.kind()? == sys::ValueType::napi_string
            && stamp.invoke(c"trim", &[])?.truthy()?
            && !stamp.number()?.is_finite()
        {
            let parsed = stamp.global()?.get(c"Date")?.invoke(c"parse", &[stamp])?;
            if parsed.number()?.is_finite() {
                value.set(key, parsed)?;
            }
        }
        break;
    }
    Ok(value)
}

pub(crate) fn board_context<'a>(env: &'a Env, options: L<'a>) -> Result<L<'a>> {
    let host = Host(options);
    let options = if options.undefined()? {
        host.object(&[])?
    } else {
        options
    };
    if options.nullish()? {
        return Err(options.type_error("Cannot destructure property 'task' of null"));
    }
    let command = host.object(&[])?;
    for key in [
        c"task",
        c"messages",
        c"artifacts",
        c"currentText",
        c"maxChars",
        c"version",
        c"includeCurrent",
    ] {
        let value = options.get(key)?;
        if !value.undefined()? {
            command.set(key, value)?;
        }
    }
    let task = command.get(c"task")?;
    if !task.undefined()? {
        command.set(
            c"task",
            project(
                task,
                &[
                    c"id",
                    c"taskId",
                    c"title",
                    c"name",
                    c"status",
                    c"summary",
                    c"description",
                    c"areas",
                ],
            )?,
        )?;
    }
    let messages = command.get(c"messages")?;
    if messages.is_array()? {
        let cb = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
            "projectTaskMessage",
            |ctx| Ok(project_message(L::new(ctx.env, ctx.get(0)?))?.raw()),
        )?;
        command.set(
            c"messages",
            messages.invoke(c"map", &[L::new(env, cb.into_unknown(env)?)])?,
        )?;
    }
    let raw =
        unsafe { crate::js_bridge::read_value(env.raw(), command.raw(), 0, &mut Vec::new()) }?;
    let result = task_run_context::build_value(&raw).map_err(napi::Error::from_reason)?;
    let result = host.value(result)?;
    if let Some(reason) = result.optional(c"$error")?.string()? {
        return Err(result.type_error(&reason.to_string_lossy()));
    }
    Ok(result)
}

#[napi]
pub fn task_board_run_context(env: Env, options: Unknown<'_>) -> Result<sys::napi_value> {
    Ok(board_context(&env, L::new(&env, options))?.raw())
}
