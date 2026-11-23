//! Task short codes and message attribution are display projections over live
//! records. Lookup and registry callbacks belong to the calling task store.
use crate::{
    js_live::LiveValue,
    task_board_host::{js_string, Host, Properties},
};
use multicc_core::js::JsValue;
use napi::{
    bindgen_prelude::{ToNapiValue, Unknown},
    sys::{self, ValueType},
    Env, Result,
};
use napi_derive::napi;

fn short_code<'a>(
    code_for: LiveValue<'a>,
    task_id: LiveValue<'a>,
) -> Result<Option<LiveValue<'a>>> {
    if code_for.kind()? != ValueType::napi_function || !task_id.truthy()? {
        return Ok(None);
    }
    let value = code_for
        .call_plain(&[task_id])?
        .or(|| Host(task_id).value(""))?;
    let code = js_string(value)?
        .invoke(c"trim", &[])?
        .invoke(c"toUpperCase", &[])?;
    let units = code.coerce_string()?;
    let valid = units.len() == 4
        && units.as_units().iter().all(|&unit| {
            u8::try_from(unit).is_ok_and(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
        });
    Ok(valid.then_some(code))
}

#[napi]
pub fn task_display_fields(
    env: Env,
    task: Unknown<'_>,
    code_for: Unknown<'_>,
) -> Result<sys::napi_value> {
    let task = LiveValue::new(&env, task);
    let fields = Host(task).object(&[])?;
    if let Some(code) = short_code(LiveValue::new(&env, code_for), task.optional(c"id")?)? {
        fields.set(c"taskShortCode", code)?;
    }
    Ok(fields.raw())
}

#[napi]
pub fn task_display_task(
    env: Env,
    task: Unknown<'_>,
    code_for: Unknown<'_>,
) -> Result<sys::napi_value> {
    let task = LiveValue::new(&env, task);
    if task.kind()? != ValueType::napi_object {
        return Ok(task.raw());
    }
    let Some(code) = short_code(LiveValue::new(&env, code_for), task.get(c"id")?)? else {
        return Ok(task.raw());
    };
    let display = Host(task).object(&[])?;
    display.spread_from(task)?;
    display.set(c"taskShortCode", code)?;
    Ok(display.raw())
}

fn project_message<'a>(
    message: LiveValue<'a>,
    fallback: LiveValue<'a>,
    get_task: LiveValue<'a>,
    code_for: LiveValue<'a>,
) -> Result<LiveValue<'a>> {
    if message.kind()? != ValueType::napi_object {
        return Ok(message);
    }
    let id = message.get(c"taskId")?.or(|| fallback.optional(c"id"))?;
    let host = Host(message);
    let found = if get_task.undefined()? {
        host.null()?
    } else if get_task.kind()? == ValueType::napi_function {
        get_task.call_plain(&[id])?
    } else {
        return Err(get_task.type_error("getTask is not a function"));
    };
    let source = found.or(|| {
        if id.equals(fallback.optional(c"id")?)? {
            Ok(fallback)
        } else {
            host.null()
        }
    })?;
    let Some(code) = short_code(code_for, id)? else {
        return Ok(message);
    };
    let display = host.object(&[])?;
    display.spread_from(message)?;
    display.set(c"taskId", id)?;
    let name = message
        .get(c"taskName")?
        .or(|| source.optional(c"title"))?
        .or(|| Ok(id))?;
    display.set(c"taskName", name)?;
    display.set(c"taskShortCode", code)?;
    Ok(display)
}

#[napi]
pub fn task_display_messages(
    env: Env,
    messages: Unknown<'_>,
    fallback: Unknown<'_>,
    options: Unknown<'_>,
) -> Result<sys::napi_value> {
    let messages = LiveValue::new(&env, messages);
    let options = LiveValue::new(&env, options);
    if options.kind()? == ValueType::napi_null {
        return Err(options.type_error("Cannot read properties of null (reading 'getTask')"));
    }
    let get_task = options.optional(c"getTask")?;
    let code_for = options.optional(c"codeFor")?;
    if code_for.kind()? != ValueType::napi_function {
        return Ok(messages.raw());
    }
    let rows = if messages.is_array()? {
        messages
    } else {
        messages.from_value(&JsValue::Array(vec![]))?
    };
    // Let Array.map preserve holes, species and changes to the array during lookup.
    // Bind live inputs in JS so a custom map can retain and invoke the mapper later.
    let project = env.create_function_from_closure::<Unknown<'_>, sys::napi_value, _>(
        "attributeTaskMessage",
        |ctx| {
            let arg = |index| Ok::<_, napi::Error>(LiveValue::new(ctx.env, ctx.get(index)?));
            let fallback = arg(0)?;
            if ctx.length() <= 3 {
                return Ok(fallback.from_value(&JsValue::Undefined)?.raw());
            }
            Ok(project_message(arg(3)?, fallback, arg(1)?, arg(2)?)?.raw())
        },
    )?;
    let bound = LiveValue::new(&env, project.into_unknown(&env)?).invoke(
        c"bind",
        &[
            messages.from_value(&JsValue::Undefined)?,
            LiveValue::new(&env, fallback),
            get_task,
            code_for,
        ],
    )?;
    Ok(rows.invoke(c"map", &[bound])?.raw())
}
