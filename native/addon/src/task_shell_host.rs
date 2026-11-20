//! Compatibility port dispatch. Promises are awaited by the Node transport.
use crate::js_live::LiveValue as L;
use multicc_core::js::JsValue as V;
use napi::{bindgen_prelude::Unknown, sys, Env, Result};
use napi_derive::napi;
use std::ffi::CStr;

fn method<'a>(receiver: L<'a>, name: &CStr, args: &[L<'a>]) -> Result<L<'a>> {
    receiver.get(name)?.call(receiver, args)
}
fn port<'a>(deps: L<'a>, name: &CStr) -> Result<L<'a>> {
    let function = deps.get(name)?;
    if function.kind()? != sys::ValueType::napi_function {
        return Err(deps.type_error(&format!(
            "[task-shell-host] dependency missing: {}",
            name.to_string_lossy()
        )));
    }
    Ok(function)
}
fn runtime(deps: L<'_>) -> Result<L<'_>> {
    port(deps, c"getRuntime")?.call_plain(&[])
}
fn owner<'a>(deps: L<'a>, name: &CStr) -> Result<L<'a>> {
    port(deps, name)?.call_plain(&[])
}
fn fields<'a>(body: L<'a>, names: &[&CStr], booleans: &[&CStr]) -> Result<L<'a>> {
    let out = body.from_value(&V::Object(vec![]))?;
    for name in names {
        out.set(name, body.get(name)?)?;
    }
    for name in booleans {
        out.set(name, body.from_value(&V::Bool(body.get(name)?.is_true()?))?)?;
    }
    Ok(out)
}

#[napi]
pub fn task_shell_host_call(
    env: Env,
    deps: Unknown<'_>,
    body: Unknown<'_>,
    phase: u32,
    entry: Unknown<'_>,
) -> Result<sys::napi_value> {
    let (deps, body, entry) = (L::new(&env, deps), L::new(&env, body), L::new(&env, entry));
    let op = body.get(c"op")?.coerce_string()?.to_string_lossy();
    let get = |name| body.get(name);
    let shell = get(c"shellId")?;
    let task = get(c"taskId")?;
    let message = op == "task-message";
    let value = match op.as_str() {
        "task-entry" => {
            let function = deps.get(c"taskEntry")?;
            let function = if function.truthy()? {
                function
            } else {
                runtime(deps)?.get(c"taskEntry")?
            };
            function.call_plain(&[task])?
        }
        "artifacts" => port(deps, c"artifacts")?.call_plain(&[task])?,
        "shell-artifacts-scope" => {
            let scope = method(runtime(deps)?, c"chatScope", &[shell])?;
            let id = scope.optional(c"taskId")?;
            let out = body.from_value(&V::Object(vec![]))?;
            out.set(
                c"taskId",
                if id.undefined()? {
                    body.from_value(&V::Null)?
                } else {
                    id
                },
            )?;
            out
        }
        "fork" => method(runtime(deps)?, c"forkTask", &[task, get(c"body")?])?,
        "task-message" => match phase {
            0 => {
                let preflight = deps.get(c"taskEntry")?;
                if preflight.truthy()? {
                    preflight.call_plain(&[task])?
                } else {
                    body.from_value(&V::Undefined)?
                }
            }
            1 => {
                method(runtime(deps)?, c"assertBoardWritable", &[task])?;
                method(runtime(deps)?, c"taskEntry", &[task])?
            }
            _ => {
                let options = fields(body, &[c"taskId"], &[])?;
                options.set(c"taskStart", body.from_value(&V::Bool(true))?)?;
                method(
                    runtime(deps)?,
                    c"sendExplicit",
                    &[entry.get(c"ownerShellId")?, get(c"body")?, options],
                )?
            }
        },
        "context" => method(
            runtime(deps)?,
            c"contextTrace",
            &[
                get(c"sessionId")?,
                get(c"traceId")?,
                fields(body, &[], &[c"includeMessages"])?,
            ],
        )?,
        "separation-latest" => method(
            runtime(deps)?.get(c"separation")?,
            c"latest",
            &[get(c"sessionId")?],
        )?,
        "separation-decide" => method(
            runtime(deps)?.get(c"separation")?,
            c"decide",
            &[get(c"sessionId")?, get(c"suggestionId")?, get(c"decision")?],
        )?,
        "open" => port(deps, c"open")?.call_plain(&[get(c"sessionId")?])?,
        "view" => method(runtime(deps)?, c"view", &[shell])?,
        "chat" => method(runtime(deps)?, c"chatScope", &[shell])?,
        "shell-history" => port(deps, c"history")?.call_plain(&[
            shell,
            fields(body, &[c"before", c"around", c"limit"], &[c"includeHidden"])?,
        ])?,
        "task-index" => port(deps, c"taskIndex")?
            .call_plain(&[shell, fields(body, &[], &[c"includeEmpty"])?])?,
        "task-operations-list" => method(owner(deps, c"taskOperations")?, c"list", &[shell])?,
        "task-operations-preview" | "task-operations-apply" => {
            let options = if op == "task-operations-preview" {
                fields(body, &[c"turns", c"range", c"target"], &[])?
            } else {
                fields(
                    body,
                    &[
                        c"clientMsgId",
                        c"previewToken",
                        c"expectedRevision",
                        c"turns",
                        c"range",
                        c"target",
                    ],
                    &[c"queue"],
                )?
            };
            options.set(c"scope", method(runtime(deps)?, c"chatScope", &[shell])?)?;
            method(
                owner(deps, c"taskOperations")?,
                if op == "task-operations-preview" {
                    c"preview"
                } else {
                    c"apply"
                },
                &[options],
            )?
        }
        "task-operations-get" => method(
            owner(deps, c"taskOperations")?,
            c"get",
            &[get(c"operationId")?],
        )?,
        "task-operations-cancel" | "task-operations-undo" => method(
            owner(deps, c"taskOperations")?,
            if op == "task-operations-cancel" {
                c"cancel"
            } else {
                c"undo"
            },
            &[fields(body, &[c"operationId", c"clientMsgId"], &[])?],
        )?,
        "attribution-list" => method(
            owner(deps, c"attributionDecisions")?,
            c"list",
            &[shell, fields(body, &[], &[c"includeHidden"])?],
        )?,
        "attribution-accept" => method(
            owner(deps, c"attributionDecisions")?,
            c"accept",
            &[
                shell,
                get(c"decisionId")?,
                fields(body, &[c"clientMsgId"], &[])?,
            ],
        )?,
        "attribution-dismiss" | "attribution-defer" | "attribution-undo" => {
            let name = match op.as_str() {
                "attribution-dismiss" => c"dismiss",
                "attribution-defer" => c"defer",
                _ => c"undo",
            };
            method(
                owner(deps, c"attributionDecisions")?,
                name,
                &[shell, get(c"decisionId")?],
            )?
        }
        "independent-request" => method(
            owner(deps, c"independent")?,
            c"request",
            &[shell, task, fields(body, &[c"clientMsgId"], &[])?],
        )?,
        "independent-list" => {
            let independent = owner(deps, c"independent")?;
            let list = method(independent, c"list", &[fields(body, &[c"shellId"], &[])?])?;
            let out = body.from_value(&V::Array(vec![]))?;
            let length = list.get(c"length")?.number()? as u32;
            for i in 0..length {
                out.set_element(i, method(independent, c"publicOp", &[list.element(i)?])?)?;
            }
            out
        }
        "independent-get" => {
            let independent = owner(deps, c"independent")?;
            method(
                independent,
                c"publicOp",
                &[method(independent, c"get", &[get(c"continuationId")?])?],
            )?
        }
        "independent-apply" | "independent-cancel" | "independent-retry" => {
            let name = match op.as_str() {
                "independent-apply" => c"apply",
                "independent-cancel" => c"cancel",
                _ => c"retry",
            };
            method(
                owner(deps, c"independent")?,
                name,
                &[get(c"continuationId")?],
            )?
        }
        "relations-list" => method(owner(deps, c"relations")?, c"list", &[shell])?,
        "relations-create" => method(
            owner(deps, c"relations")?,
            c"create",
            &[
                shell,
                fields(
                    body,
                    &[c"kind", c"fromTaskId", c"toTaskId", c"clientMsgId"],
                    &[],
                )?,
            ],
        )?,
        "relations-remove" => method(
            owner(deps, c"relations")?,
            c"remove",
            &[shell, fields(body, &[c"relationId", c"clientMsgId"], &[])?],
        )?,
        "remove-shell" => method(runtime(deps)?, c"remove", &[shell])?,
        "links" => method(runtime(deps)?, c"link", &[shell, task])?,
        "select-target" => method(
            runtime(deps)?,
            c"selectTarget",
            &[
                shell,
                fields(body, &[c"taskId", c"expectedCursorVersion"], &[])?,
            ],
        )?,
        "tasks-resolve" => method(
            runtime(deps)?,
            c"resolveTask",
            &[
                shell,
                fields(body, &[c"taskId", c"taskText", c"title"], &[])?,
            ],
        )?,
        "detail" => method(runtime(deps)?, c"detail", &[shell, task])?,
        "shell-message" => method(runtime(deps)?, c"send", &[shell, get(c"body")?])?,
        "receipt-retry" => method(runtime(deps)?, c"retry", &[shell, get(c"receiptId")?])?,
        _ => {
            return body
                .from_value(&V::object(vec![("known", V::Bool(false))]))
                .map(L::raw)
        }
    };
    let out = body.from_value(&V::object(vec![
        ("known", V::Bool(true)),
        ("taskMessage", V::Bool(message)),
    ]))?;
    out.set(c"value", value)?;
    Ok(out.raw())
}
